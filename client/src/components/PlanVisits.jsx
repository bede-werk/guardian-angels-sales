import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import PlacePicker from './ui/PlacePicker';
import AddressAutocomplete from './ui/AddressAutocomplete';
import Calendar from './ui/Calendar';
import EmptyState from './ui/EmptyState';
import PlaceDetail from './PlaceDetail';

// The per-day budget picker shows hours + minutes as two selects, but the
// wire/schema shape is still a single decimal `hoursPerDay` (see
// scheduleDraft.js's `budgetMinutes = hoursPerDay * 60`) — HOUR_OPTIONS
// starts at 1, never 0, so hours+minutes can never both be zero and trip
// the server's `hoursPerDay > 0` validation.
const HOUR_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const MINUTE_OPTIONS = [0, 15, 30, 45];
const DEFAULT_HOURS_PER_DAY = 4;

// Decimal hoursPerDay -> whole { hours, minutes } for the two selects above.
// 15-minute increments are exactly representable in binary floating point
// (0.25/0.5/0.75), so there's no rounding drift round-tripping through this.
function splitHoursPerDay(hoursPerDay) {
  const totalMinutes = Math.round(hoursPerDay * 60);
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
const MAX_PLAN_DATES = 10; // mirrors scheduleDraft.js's MAX_PLAN_DATES
const MAX_DAYS_AHEAD = 7; // mirrors scheduleDraft.js's MAX_DAYS_AHEAD

// 'YYYY-MM-DD' in the browser's local timezone.
function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The earliest selectable calendar date. Today itself IS selectable (a rep
// sitting down in the morning can still plan today's own route);
// scheduleDraft.js's validateDays enforces the same "today or later" floor
// server-side.
function todayISO() {
  return isoDate(new Date());
}

// The latest selectable calendar date — a proposal generated too far out
// goes stale before the rep actually gets there (a commitment that becomes
// due, or a higher-priority place, won't retroactively reshuffle an
// already-proposed day). Counts only weekdays (Mon-Fri) toward
// MAX_DAYS_AHEAD, so a weekend inside the window doesn't shrink the actual
// planning horizon — mirrors scheduleDraft.js's validateDays/maxPlanDateUTC,
// which enforces the exact same bound server-side.
function maxPlanDateISO() {
  const d = new Date();
  let remaining = MAX_DAYS_AHEAD;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return isoDate(d);
}

// Visits are only ever planned Mon-Fri — mirrors scheduleDraft.js's
// validateDays, which rejects a weekend date server-side too.
function isWeekendISO(iso) {
  const dow = new Date(`${iso}T00:00:00`).getDay();
  return dow === 0 || dow === 6;
}

// Same {date, hoursPerDay} selection, order-independent — used to tell
// whether `selectedDays` has actually diverged from what the active draft
// was last generated with (see needsRegenerate below), not just whether
// there's technically something selected.
function daysEqual(a, b) {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => (x.date < y.date ? -1 : 1));
  const sortedB = [...b].sort((x, y) => (x.date < y.date ? -1 : 1));
  return sortedA.every((d, i) => d.date === sortedB[i].date && d.hoursPerDay === sortedB[i].hoursPerDay);
}

// Turns a minute count into "1h 45m" / "45m" / "2h".
function formatMinutes(minutes) {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

// A day's card is worth showing while it either still has open (uncommitted)
// stops, or never got any stops committed at all (the "nothing planned for
// this day yet, add one" case right after generating). Once a day has been
// fully accepted — no stops left, but it did produce committed visits — its
// card is a redundant empty shell (see PlanVisits' render below) and drops
// out. Shared between the render and load()'s "is this whole draft spent?"
// check so they can't drift apart.
function openDays(draft) {
  return draft ? draft.days.filter((day) => day.stops.length > 0 || day.committed.length === 0) : [];
}

// One day's card: stop list with reorder (drag + arrow fallback), remove,
// visit-type change, and ad-hoc add. Every mutation calls its endpoint and
// replaces this day's slice from the response (loadDraftDayView's return) —
// the server always recalculates running totals/overBudget fresh, so the
// live time math and over-budget flagging just fall out of that, per the
// interaction model: edits recalculate in place, nothing is ever auto-
// dropped or auto-reshuffled beyond what the user themselves just did.
function DraftDay({ day, draftId, onDayUpdated, onError, reload, onDayCommitted, onDayDiscarded, userId }) {
  const [busy, setBusy] = useState(false); // a reorder/add/remove request is in flight for this day
  const [pendingPlaceId, setPendingPlaceId] = useState(null); // one stop's own request (visit-type change)
  const [addingOpen, setAddingOpen] = useState(false);
  const [viewingPlaceId, setViewingPlaceId] = useState(null); // stop whose full PlaceDetail is open, if any

  // Two-part gate for the Re-optimize button below, both set by anything
  // that changes which stops are in the day or their order (add/remove/
  // reorder) — NOT by a visit-type change, since that only changes a
  // stop's duration, never which order is fastest to drive:
  //  - everEdited: whether this day has been touched at all since it was
  //    generated (already real-OSRM-optimized at that point). Once true,
  //    stays true — controls whether the button appears at all.
  //  - needsReoptimize: whether it's been touched since the LAST optimize
  //    (generation, or a prior Re-optimize click). Toggles back to false
  //    right after a successful Re-optimize — controls whether the
  //    (still-visible) button is enabled or disabled.
  // Deliberately session-only, client-side state rather than a persisted
  // field: there's nothing to keep in sync, it just needs a safe default
  // (hidden/"already optimal") on every fresh load, same "no manual field
  // that needs upkeep" spirit as the rest of this app's computed-not-stored
  // data.
  const [everEdited, setEverEdited] = useState(false);
  const [needsReoptimize, setNeedsReoptimize] = useState(false);
  function markEdited() {
    setEverEdited(true);
    setNeedsReoptimize(true);
  }

  // Suggestions: nearby eligible places not already in this draft, offered
  // when the day still has budget to spare. Fetched on demand rather than
  // eagerly for every day, since it's a real API call per day.
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [addingSuggestionId, setAddingSuggestionId] = useState(null);
  const canSuggest = !day.overBudget && day.remainingMinutes > 0;

  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const dragIndexRef = useRef(null);

  const budgetMinutes = day.totalMinutes + day.remainingMinutes;
  const usedPct = budgetMinutes > 0 ? Math.min(100, Math.round((day.totalMinutes / budgetMinutes) * 100)) : 0;

  // Optimistically shows the new order right away (stale running totals until
  // the server responds, since those depend on real drive time between
  // stops). Rolls back via a full reload if the server rejects it.
  function persistReorder(nextStops) {
    onError(null);
    onDayUpdated({ ...day, stops: nextStops });
    markEdited();
    setBusy(true);
    api.scheduleDrafts.reorderDay(draftId, day.date, nextStops.map((s) => s.place_id))
      .then(onDayUpdated)
      .catch((e) => { onError(e.message); reload(); })
      .finally(() => setBusy(false));
  }

  function move(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= day.stops.length) return;
    const next = [...day.stops];
    [next[index], next[target]] = [next[target], next[index]];
    persistReorder(next);
  }

  function onDrop(targetIndex) {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === targetIndex) return;
    const next = [...day.stops];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    persistReorder(next);
  }

  async function removeStop(stop) {
    onError(null);
    setPendingPlaceId(stop.place_id);
    try {
      onDayUpdated(await api.scheduleDrafts.removeStop(draftId, day.date, stop.place_id));
      markEdited();
    } catch (e) {
      onError(e.message);
    } finally {
      setPendingPlaceId(null);
    }
  }

  async function changeVisitType(stop, visitType) {
    onError(null);
    setPendingPlaceId(stop.place_id);
    try {
      onDayUpdated(await api.scheduleDrafts.setVisitType(draftId, day.date, stop.place_id, visitType));
    } catch (e) {
      onError(e.message);
    } finally {
      setPendingPlaceId(null);
    }
  }

  async function addStop(place) {
    onError(null);
    setBusy(true);
    try {
      onDayUpdated(await api.scheduleDrafts.addStop(draftId, day.date, place.id));
      setAddingOpen(false);
      markEdited();
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleSuggestions() {
    if (suggestionsOpen) { setSuggestionsOpen(false); return; }
    onError(null);
    setSuggestionsOpen(true);
    setSuggestLoading(true);
    try {
      setSuggestions(await api.scheduleDrafts.getSuggestions(draftId, day.date));
    } catch (e) {
      onError(e.message);
    } finally {
      setSuggestLoading(false);
    }
  }

  // Adding a suggested place reuses the same addStop endpoint an ad-hoc
  // add uses — a suggestion is just a pre-filtered candidate, not a
  // different kind of add. Pulled out of the local list on success so the
  // panel doesn't offer the same place twice without a re-fetch.
  async function addSuggestion(s) {
    onError(null);
    setAddingSuggestionId(s.place_id);
    try {
      onDayUpdated(await api.scheduleDrafts.addStop(draftId, day.date, s.place_id));
      setSuggestions((prev) => prev.filter((x) => x.place_id !== s.place_id));
      markEdited();
    } catch (e) {
      onError(e.message);
    } finally {
      setAddingSuggestionId(null);
    }
  }

  async function commitThisDay() {
    if (day.stops.length === 0) return;
    if (!window.confirm(`Accept the proposal for ${formatDate(day.date)}? This turns ${day.stops.length} visit${day.stops.length === 1 ? '' : 's'} into real scheduled visits.`)) return;
    onError(null);
    setBusy(true);
    try {
      onDayCommitted(day.date, await api.scheduleDrafts.commitDay(draftId, day.date));
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Discards just THIS day's still-open proposal, as if the date had never
  // been picked at all — every other day (and anything already accepted for
  // this day) is untouched, unlike the page-level "Discard all proposals"
  // button. Unlike every other mutation here, the response isn't a day view
  // (the day itself no longer exists once its date drops out of the draft —
  // see scheduleDraft.js's discardDay) so this goes through onDayDiscarded,
  // not onDayUpdated: the parent removes the whole card and de-selects the
  // date on the calendar, rather than patching this day's slice in place.
  async function discardThisDay() {
    if (day.stops.length === 0) return;
    if (!window.confirm(`Discard the proposal for ${formatDate(day.date)}? ${day.stops.length} still-open visit${day.stops.length === 1 ? '' : 's'} will be removed — this can't be undone.`)) return;
    onError(null);
    setBusy(true);
    try {
      onDayDiscarded(day.date, await api.scheduleDrafts.discardDay(draftId, day.date));
    } catch (e) {
      onError(e.message);
      setBusy(false);
    }
  }

  // Re-sequences this day's stops via a real routing call — the only action
  // in this screen that's allowed to resequence (every other edit
  // deliberately preserves whatever order the stops are already in). The
  // button (see render below) only appears once this day's been edited at
  // all, and is only enabled while needsReoptimize is true — there's
  // nothing to gain from re-clicking this until the stop list or order has
  // changed again since the last time it ran.
  async function reoptimize() {
    onError(null);
    setBusy(true);
    try {
      onDayUpdated(await api.scheduleDrafts.reoptimizeDay(draftId, day.date));
      setNeedsReoptimize(false);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{formatDate(day.date)}{day.zone ? ` · ${day.zone}` : ''}</h2>
        <div className="row" style={{ flex: 'unset', alignItems: 'center', gap: 8 }}>
          {day.committed.length > 0 && <span className="badge committed" style={{ flex: 'none', minWidth: 0 }}>✓ {day.committed.length} planned</span>}
          {day.overBudget && <span className="badge attention" style={{ flex: 'none', minWidth: 0 }}>Over budget</span>}
          {everEdited && day.stops.length >= 2 && (
            <Button
              size="small"
              variant="secondary"
              onClick={reoptimize}
              disabled={busy || !needsReoptimize}
              title={needsReoptimize ? "Re-sequence this day's stops for the shortest real drive route" : 'Already optimized — edit the day to re-enable'}
            >
              Re-optimize route
            </Button>
          )}
          <Button
            size="small"
            variant="danger"
            onClick={discardThisDay}
            disabled={busy || day.stops.length === 0}
            title="Remove this day's still-open proposal (anything already accepted for this day is untouched)"
            style={{ flex: 'none', minWidth: 0 }}
          >
            Discard proposal
          </Button>
          <Button size="small" onClick={commitThisDay} disabled={busy || day.stops.length === 0} title="Turn this day's proposed visits into real scheduled visits" style={{ flex: 'none', minWidth: 0 }}>
            Accept proposal
          </Button>
        </div>
      </div>
      <div className="card-body">
        <div style={{ marginBottom: 14 }}>
          <div className="progress-total" title="Estimated — based on typical drive times and default visit lengths, not a guarantee of how the day will actually go.">
            ~{formatMinutes(day.totalMinutes)} <span className="muted" style={{ fontWeight: 400 }}>of {formatMinutes(budgetMinutes)}</span>
            {day.overBudget && <span style={{ color: 'var(--mauve)' }}> · {formatMinutes(-day.remainingMinutes)} over</span>}
          </div>
          <div className="progress-bar">
            <div className="fill" style={{ width: `${usedPct}%` }} />
          </div>
          <div className="progress-label">
            {day.stops.length} stop{day.stops.length === 1 ? '' : 's'}
            {!day.overBudget && day.remainingMinutes > 0 ? ` · ${formatMinutes(day.remainingMinutes)} free` : ''}
          </div>
        </div>

        {day.committed.length > 0 && (
          <div style={{ marginBottom: day.stops.length > 0 ? 16 : 0 }}>
            <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 4 }}>
              Planned
            </div>
            <ul className="list">
              {day.committed.map((v) => (
                <li key={v.visit_id} className="stop">
                  <div className="main">
                    <div className="name">{v.place_name}</div>
                    <div className="meta">
                      {v.address ? `${v.address}, ` : ''}{v.city} {v.zip}
                    </div>
                    <div className="tag-list" style={{ marginTop: 6 }}>
                      {v.category && <CategoryChip category={v.category} />}
                      {v.tier && <TierChip tier={v.tier} />}
                      <span className="tiny muted">{VISIT_TYPE_LABELS[v.visit_type] || 'Visit'}</span>
                    </div>
                  </div>
                  <div className="tiny muted" style={{ whiteSpace: 'nowrap', color: 'var(--teal-dark)', fontWeight: 600 }}>
                    ✓ Planned
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {day.stops.length > 0 && day.committed.length > 0 && (
          <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 4 }}>
            Proposed
          </div>
        )}

        {day.stops.length === 0 ? null : (
          <ul className="list">
            {day.stops.map((stop, i) => {
              const rowBusy = busy || pendingPlaceId === stop.place_id;
              return (
                <li
                  key={stop.place_id}
                  className={`stop ${stop.overBudget ? 'attention-flag' : ''} ${overIndex === i ? 'drag-over' : ''} ${dragIndex === i ? 'dragging' : ''}`}
                  draggable={!rowBusy}
                  onDragStart={() => { dragIndexRef.current = i; setDragIndex(i); }}
                  onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
                  onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
                  onDrop={() => onDrop(i)}
                  onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); setOverIndex(null); }}
                >
                  <div className="reorder">
                    <span className="drag-handle" title="Drag to reorder">⠿</span>
                    <button onClick={() => move(i, -1)} disabled={rowBusy || i === 0} title="Move up">▲</button>
                    <button onClick={() => move(i, 1)} disabled={rowBusy || i === day.stops.length - 1} title="Move down">▼</button>
                  </div>
                  <div className="order">{i + 1}</div>
                  <div
                    className="main hover-row"
                    title="View place details"
                    onClick={() => setViewingPlaceId(stop.place_id)}
                  >
                    <div className="name">{stop.place_name}</div>
                    <div className="meta">
                      {stop.address ? `${stop.address}, ` : ''}{stop.city} {stop.zip}
                    </div>
                    <div className="tag-list" style={{ marginTop: 6 }}>
                      <CategoryChip category={stop.category} />
                      <TierChip tier={stop.tier} />
                      <select
                        value={stop.visitType}
                        onChange={(e) => changeVisitType(stop, e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        disabled={rowBusy}
                        style={{ width: 'auto' }}
                      >
                        {Object.entries(VISIT_TYPE_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="actions" style={{ alignItems: 'center' }}>
                    <div
                      className="tiny muted"
                      style={{ whiteSpace: 'nowrap', textAlign: 'right' }}
                      title={`Estimated: drive ${stop.driveMinutes}m + visit ${stop.visitMinutes}m + prep ${stop.prepMinutes}m + data entry ${stop.dataEntryMinutes}m`}
                    >
                      ~{formatMinutes(stop.blockMinutes)}
                      {stop.overBudget && <div style={{ color: 'var(--mauve)', fontWeight: 600 }}>Over budget</div>}
                    </div>
                    <Button variant="danger" size="small" onClick={() => removeStop(stop)} disabled={rowBusy} title="Remove from this day">✕</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div style={{ marginTop: 14 }}>
          {addingOpen ? (
            <div className="row" style={{ alignItems: 'center' }}>
              <PlacePicker placeholder="Add a stop to this day…" onPick={addStop} />
              <Button variant="ghost" size="small" onClick={() => setAddingOpen(false)}>Cancel</Button>
            </div>
          ) : (
            <div className="row" style={{ flex: 'unset', gap: 8 }}>
              <Button variant="secondary" size="small" onClick={() => setAddingOpen(true)} disabled={busy}>+ Add a stop</Button>
              {canSuggest && (
                <Button variant="ghost" size="small" onClick={toggleSuggestions} disabled={busy}>
                  {suggestionsOpen ? 'Hide suggestions' : 'Suggest a stop'}
                </Button>
              )}
            </div>
          )}
        </div>

        {suggestionsOpen && (
          <div className="stack" style={{ marginTop: 10, gap: 6 }}>
            {suggestLoading ? (
              <div className="tiny muted">Finding nearby places…</div>
            ) : suggestions.length === 0 ? (
              <div className="tiny muted">No eligible nearby places right now.</div>
            ) : (
              suggestions.map((s) => (
                <div
                  key={s.place_id}
                  className="row"
                  style={{ alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}
                >
                  <div>
                    <strong>{s.name}</strong>
                    <div className="tiny muted">{s.category ? `${s.category} · ` : ''}{s.city}{s.region ? ` · ${s.region}` : ''}</div>
                  </div>
                  <Button size="small" onClick={() => addSuggestion(s)} disabled={addingSuggestionId === s.place_id}>Add</Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Clicking a proposed stop's name opens its full place detail (same
          modal Places.jsx/People.jsx/Dashboard.jsx use) so a rep can check
          capacity/notes/history/contacts before deciding what visit type
          this stop should be. onChanged/onDeleted both just reload() the
          draft — a deleted place cascades its schedule_draft_stops row
          server-side, so the stop simply disappears from this day on the
          next load, same as removing it here directly. */}
      {viewingPlaceId && (
        <PlaceDetail
          placeId={viewingPlaceId}
          userId={userId}
          onClose={() => setViewingPlaceId(null)}
          onChanged={reload}
          onDeleted={reload}
        />
      )}
    </div>
  );
}

// Phase 6 frontend, sub-slice 3: suggestions (the "nearby eligible stop"
// prompt on under-budget days, per DraftDay above) and commit — per-day
// (DraftDay's "Accept proposal" button) and all-remaining-days (this
// component's "Accept all proposals" button). Built on top of sub-slice 2's
// live editing.
export default function PlanVisits({ userId }) {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [noticeFading, setNoticeFading] = useState(false);
  const noticeTimers = useRef([]);
  const [generating, setGenerating] = useState(false);
  const [committingAll, setCommittingAll] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // The dates the rep has picked on the calendar to plan for, each with its
  // own hours budget — [{ date, hoursPerDay }], sorted by date. Seeded from
  // the active draft's own params once (see the effect below) so "Plan
  // again" starts from whatever's already generated; committedDates pulls
  // any date that gets committed back out (see the other effect below) so a
  // day can never be re-selected once it's done — the actual fix for the
  // "still able to plan more visits for an already-committed day" bug.
  const [selectedDays, setSelectedDays] = useState([]);
  // Raw [{ date, count }] from the server — committedDates below is just the
  // date Set derived from it (what the calendar/selection-pruning need);
  // committedSummaries itself is what the "Already committed" snapshot list
  // renders, since it also wants the per-day visit count.
  const [committedSummaries, setCommittedSummaries] = useState([]);
  const committedDates = useMemo(() => new Set(committedSummaries.map((s) => s.date)), [committedSummaries]);
  const [deletingCommittedDate, setDeletingCommittedDate] = useState(null); // which "Already Planned" row's ✕ is in flight
  const [reopeningDate, setReopeningDate] = useState(null); // which "Already Planned" row's Edit is in flight
  // Dates already generated into the active draft — once a day's routes
  // have been proposed, it can't be deselected (calendar click or the ✕ in
  // the list below); discarding that day's proposal (or the whole draft) is
  // the only way to free the date back up. See Calendar.jsx's `proposed` prop.
  const proposedDates = useMemo(() => new Set((draft?.days ?? []).map((d) => d.date)), [draft]);
  const seededFromDraft = useRef(false);

  // homeBase capture: browser geolocation, or a manually entered address —
  // no rep/user location field exists in the schema yet, so this is asked
  // for at generate time instead. Manual entry is offered as an equal
  // option alongside "Use my current location" (toggled open by its own
  // button), not just shown after geolocation fails — `locationError` still
  // auto-opens it too, since at that point it's the only option left. Manual
  // entry itself is a single Mapbox-backed search box (AddressAutocomplete)
  // that resolves straight to { lat, lng, label } — no separate "look up"
  // step/button, unlike the old 4-field form this replaced.
  const [homeBase, setHomeBase] = useState(null); // { lat, lng, label }
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);

  const refreshCommittedDates = useCallback(async () => {
    setCommittedSummaries(await api.scheduleDrafts.committedDates());
  }, []);

  // Undoes a whole day's commit — only the still-open ("planned") visits on
  // that date are removed server-side (see scheduleDraft.deleteCommittedDay);
  // anything already completed/skipped that day survives, so the row can
  // shrink (a lower count) rather than disappear if there's real history left
  // on it. Re-fetches rather than patching locally so the resulting count is
  // always exactly what the server has, not a client-side guess.
  async function deleteCommittedDay(date) {
    if (!window.confirm(`Remove the planned visits for ${formatDate(date)}? This can't be undone.`)) return;
    setError(null);
    setDeletingCommittedDate(date);
    try {
      await api.scheduleDrafts.deleteCommittedDay(date);
      await refreshCommittedDates();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setDeletingCommittedDate(null);
    }
  }

  // Pulls a committed day's visits back out of `visits` and into a normal
  // editable draft day (see scheduleDraft.reopenCommittedDay) — the response
  // is a full draft view, same shape generate() returns, so it's handled the
  // same way: setDraft AND setSelectedDays together, since the reopened date
  // is now part of draft.params.days and selectedDays needs to match or it
  // silently drifts out of sync (see the seededFromDraft effect above, which
  // only syncs the two once on initial mount).
  async function reopenDay(date) {
    if (!homeBase) return; // the button is disabled in this case; guard anyway
    if (!window.confirm(`Edit the planned visits for ${formatDate(date)}? They'll temporarily show as not-yet-scheduled while you make changes — accept the updated proposal again when you're done.`)) return;
    setError(null);
    setReopeningDate(date);
    try {
      const next = await api.scheduleDrafts.reopenDay(date, { lat: homeBase.lat, lng: homeBase.lng });
      setDraft(next);
      setSelectedDays(next.params.days);
      await refreshCommittedDates();
    } catch (e) {
      setError(e.message);
    } finally {
      setReopeningDate(null);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.scheduleDrafts.active();
      if (next && openDays(next).length === 0) {
        // Every day in this draft has been fully accepted — there's no open
        // day left to discard/create-another/accept-all for, so the header
        // buttons would otherwise sit there enabled with nothing live left
        // to act on. Clean up the now-inert draft shell server-side and land
        // back in the pre-draft starting state, same end state as a manual
        // "Discard all proposals" (minus the confirm — nothing here is being
        // lost, every stop already became a real visit).
        await api.scheduleDrafts.discard(next.id);
        setDraft(null);
        setSelectedDays([]);
      } else {
        setDraft(next);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    refreshCommittedDates();
  }, [load, refreshCommittedDates]);

  // Seeds the calendar from the active draft's own selection exactly once
  // (on first load, if there's already a draft) — every later change to
  // `selectedDays` is either the user editing the calendar directly, or an
  // explicit set after a successful generate/regenerate (see generate()
  // below), never an overwrite triggered by an unrelated draft refresh.
  useEffect(() => {
    if (draft && !seededFromDraft.current) {
      seededFromDraft.current = true;
      setSelectedDays(draft.params.days);
    }
  }, [draft]);

  // A date that gains a committed visit (from committing a day, here or in
  // another tab) can never be planned again — see scheduleDraft.js's
  // validateDays, which enforces the same rule server-side. Dropping it here
  // too means a stale selection can't even be submitted to hit that 409.
  useEffect(() => {
    setSelectedDays((prev) => prev.filter((d) => !committedDates.has(d.date)));
  }, [committedDates]);

  // Auto-dismisses the notice banner (the blue "Planned N visits…" message
  // after an accept) ~10s after it appears — fades out over the last half
  // second rather than just vanishing. Runs off `notice` itself, not the
  // setNotice call sites, so it self-resets on every new message (an
  // "Accept all" notice replacing an "Accept day" one gets its own fresh
  // 10s) and does nothing when notice is cleared manually (discard/generate).
  useEffect(() => {
    noticeTimers.current.forEach(clearTimeout);
    noticeTimers.current = [];
    if (!notice) return;
    setNoticeFading(false);
    noticeTimers.current = [
      setTimeout(() => setNoticeFading(true), 9500),
      setTimeout(() => setNotice(null), 10000),
    ];
    return () => noticeTimers.current.forEach(clearTimeout);
  }, [notice]);

  // Replaces one day's slice of the draft with a freshly recalculated day
  // view (the shape every mutation endpoint returns) — never touches any
  // other day, and never re-derives anything client-side.
  function updateDay(dayView) {
    setDraft((prev) => ({ ...prev, days: prev.days.map((d) => (d.date === dayView.date ? dayView : d)) }));
  }

  // commitDay's response isn't a day view (it's { date, committed,
  // skippedCollisions } — the committed stops just became real `visits`
  // rows and are gone from the draft) so, unlike every other mutation here,
  // this reloads the whole draft rather than patching one day's slice.
  function handleDayCommitted(date, result) {
    const parts = [];
    if (result.committed.length > 0) {
      parts.push(`Planned ${result.committed.length} visit${result.committed.length === 1 ? '' : 's'} for ${formatDate(date)}.`);
    }
    if (result.skippedCollisions.length > 0) {
      parts.push(`Skipped ${result.skippedCollisions.length} (already booked elsewhere by then): ${result.skippedCollisions.map((c) => c.place_name).join(', ')}.`);
    }
    if (parts.length === 0) parts.push(`Nothing to accept for ${formatDate(date)}.`);
    setNotice(parts.join(' '));
    load();
    refreshCommittedDates();
  }

  // "Accept all proposals" commits every remaining day in one call, so unlike
  // handleDayCommitted's single `{ date, committed, skippedCollisions }` this
  // gets one of those per day committed. Same "Planned N visits for <date>"
  // phrasing as the single-day accept, just one comma-separated clause per
  // date instead of one sentence — days with nothing committed (skip-only or
  // already-empty) don't get their own clause. Skipped collisions stay a
  // single rolled-up count rather than per-day, since the day-by-day skip
  // detail (place names) is already visible in each day's card while it's
  // still open.
  function describeCommitAllResults(results) {
    const committedDays = results.filter((r) => r.committed.length > 0);
    const skipped = results.reduce((n, r) => n + r.skippedCollisions.length, 0);
    const parts = [];
    if (committedDays.length > 0) {
      const perDay = committedDays
        .map((r) => `${r.committed.length} visit${r.committed.length === 1 ? '' : 's'} for ${formatDate(r.date)}`)
        .join(', ');
      parts.push(`Planned ${perDay}.`);
    }
    if (skipped > 0) {
      parts.push(`Skipped ${skipped} (already booked elsewhere).`);
    }
    if (parts.length === 0) parts.push('Nothing to accept.');
    return parts.join(' ');
  }

  // discardDay's response is the full recalculated draft (its days list just
  // shrank by one) or null if that was the last date — either way, set it
  // directly rather than patching a slice, same as generate()'s result.
  // Also drops the date from selectedDays so the calendar shows it
  // unselected again — the whole point being that discarding a day's
  // proposal leaves things exactly as if that date had never been picked (no
  // notice banner either — the card vanishing and the calendar deselecting
  // are already the confirmation).
  function handleDayDiscarded(date, result) {
    setDraft(result);
    setSelectedDays((prev) => prev.filter((d) => d.date !== date));
  }

  async function commitAllDays() {
    if (!draft) return;
    const totalStops = draft.days.reduce((n, d) => n + d.stops.length, 0);
    if (totalStops === 0) { setError('Nothing to accept yet.'); return; }
    if (!window.confirm(`Accept every remaining proposed visit across all days? This creates real scheduled visits.`)) return;
    setError(null);
    setCommittingAll(true);
    try {
      const results = await api.scheduleDrafts.commitAll(draft.id);
      setNotice(describeCommitAllResults(results));
      await load();
      await refreshCommittedDates();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommittingAll(false);
    }
  }

  // Discards the whole proposal — every day, not just one. Any day already
  // committed is unaffected (its stops left the draft the moment they
  // became real visits), so this only throws away still-uncommitted work.
  // Clears selectedDays too — same "as if it had never been picked" goal as
  // the per-day "Discard proposal" button — so the calendar shows every
  // date unselected again, not just the draft gone. homeBase is deliberately
  // left as-is so a fresh "Plan my visits" doesn't force re-entering a start
  // location.
  async function discardDraft() {
    if (!draft) return;
    const totalStops = draft.days.reduce((n, d) => n + d.stops.length, 0);
    const warning = totalStops > 0
      ? `Discard this entire proposal? ${totalStops} proposed visit${totalStops === 1 ? '' : 's'} across every day will be lost — this can't be undone.`
      : 'Discard this proposal and start over?';
    if (!window.confirm(warning)) return;
    setError(null);
    setDiscarding(true);
    try {
      await api.scheduleDrafts.discard(draft.id);
      setDraft(null);
      setSelectedDays([]);
      setNotice(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setDiscarding(false);
    }
  }

  function useCurrentLocation() {
    setLocating(true);
    setLocationError(null);
    if (!navigator.geolocation) {
      setLocationError("This browser can't share your location — enter a start address instead.");
      setLocating(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setHomeBase({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Current location' });
        setLocating(false);
      },
      () => {
        setLocationError("Couldn't get your location — enter a start address instead.");
        setLocating(false);
      },
      { timeout: 10000 }
    );
  }

  async function generate(regenerate) {
    if (regenerate && !window.confirm('Regenerate this proposal? Any changes you\'ve made to it will be replaced.')) return;
    setError(null);
    setNotice(null);
    setGenerating(true);
    try {
      const next = await api.scheduleDrafts.generate({
        days: selectedDays.map(({ date, hoursPerDay }) => ({ date, hoursPerDay })),
        homeBase: { lat: homeBase.lat, lng: homeBase.lng },
        regenerate,
      });
      setDraft(next);
      setSelectedDays(next.params.days); // server-normalized (sorted) version of what we just sent
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  function toggleDate(iso) {
    setSelectedDays((prev) => {
      if (prev.some((d) => d.date === iso)) {
        if (proposedDates.has(iso)) return prev; // Calendar already disables this case; guard anyway
        return prev.filter((d) => d.date !== iso);
      }
      if (prev.length >= MAX_PLAN_DATES) return prev; // Calendar already disables this case; guard anyway
      if (iso < todayISO() || iso > maxPlanDateISO()) return prev; // Calendar already disables this case; guard anyway
      if (isWeekendISO(iso)) return prev; // Calendar already disables this case; guard anyway
      return [...prev, { date: iso, hoursPerDay: DEFAULT_HOURS_PER_DAY }].sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  }

  function setHoursForDate(iso, hoursPerDay) {
    setSelectedDays((prev) => prev.map((d) => (d.date === iso ? { ...d, hoursPerDay: Number(hoursPerDay) } : d)));
  }

  function removeDate(iso) {
    if (proposedDates.has(iso)) return; // same lock as the calendar — discard the day's proposal instead
    setSelectedDays((prev) => prev.filter((d) => d.date !== iso));
  }

  // Keeps the three header buttons mutually exclusive — any one of them being
  // in flight should block the other two, since they all act on the same
  // draft (e.g. regenerating while "Accept all proposals" is still
  // committing would fire a regenerate against a draft that's mid-commit).
  const busy = generating || committingAll || discarding;
  const canGenerate = !!homeBase && !generating && selectedDays.length > 0;
  // "Create another proposal" regenerates the WHOLE draft, so it should only
  // be live when something has actually changed since the last generate —
  // otherwise re-clicking it just re-runs the same generation for no reason.
  // A day already in the draft can't be removed/deselected without going
  // through "Discard proposal" (see proposedDates elsewhere in this file),
  // so the only ways selectedDays can diverge from what's already generated
  // are adding a new date or editing an existing date's hours — both real
  // reasons to regenerate. Comparing against draft.params directly (not some
  // separate "dirty" flag) means this can't drift out of sync with what
  // generate() actually just sent.
  const needsRegenerate = !draft
    || !daysEqual(selectedDays, draft.params.days)
    || !homeBase
    || homeBase.lat !== draft.params.homeBase.lat
    || homeBase.lng !== draft.params.homeBase.lng;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className={`notice-banner ${noticeFading ? 'fading' : ''}`.trim()}>{notice}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Plan My Visits</h2>
          <div className="row" style={{ flex: 'unset', alignItems: 'center', gap: 8 }}>
            {draft ? (
              <>
                <Button variant="danger" onClick={discardDraft} disabled={busy} style={{ flex: 'none', minWidth: 0 }}>
                  {discarding ? 'Discarding…' : 'Discard all proposals'}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => generate(true)}
                  disabled={!canGenerate || !needsRegenerate || busy}
                  title={needsRegenerate ? undefined : 'Nothing has changed since the current proposal was generated'}
                  style={{ flex: 'none', minWidth: 0 }}
                >
                  Create another proposal
                </Button>
                <Button onClick={commitAllDays} disabled={busy} style={{ flex: 'none', minWidth: 0 }}>
                  {committingAll ? 'Accepting…' : 'Accept all proposals'}
                </Button>
              </>
            ) : (
              <Button onClick={() => generate(false)} disabled={!canGenerate} style={{ flex: 'none', minWidth: 0 }}>Create proposal</Button>
            )}
          </div>
        </div>
        <div className="card-body">
          {/* Two columns — starting point on the left, the date picker on
              the right, split by a vertical rule (see .plan-columns) — the
              calendar/date-list content is inherently narrower than the
              card, so stacking them left the card mostly white space.
              Every button/pill in the starting-point rows gets an explicit
              flex:'none' — .row's default (`.row > * { flex: 1; min-width:
              120px }`) is meant for stretchy form-field rows (like the
              manual-address row below, which deliberately keeps the
              default), and otherwise blows a couple of short buttons up
              into oddly wide, far-apart blocks. */}
          <div className="plan-columns">
            <div className="plan-col-start">
              <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 4 }}>
                Starting point
              </div>
              <div className="plan-col-hint">Where you'll begin the day's route.</div>
              {homeBase ? (
                <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                  <span className="tiny" style={{ flex: 'none' }}>Starting from <strong>{homeBase.label}</strong></span>
                  <Button
                    variant="ghost"
                    size="small"
                    style={{ flex: 'none' }}
                    onClick={() => { setHomeBase(null); setLocationError(null); setManualEntryOpen(false); }}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                    <Button variant="secondary" onClick={useCurrentLocation} disabled={locating} style={{ flex: 'none' }}>
                      {locating ? 'Finding you…' : 'Use my current location'}
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => setManualEntryOpen((o) => !o)} style={{ flex: 'none' }}>
                      {manualEntryOpen ? 'Hide manual entry' : 'Enter address manually'}
                    </Button>
                  </div>
                  {locationError && <div className="tiny muted">{locationError}</div>}
                  {(manualEntryOpen || locationError) && (
                    <AddressAutocomplete
                      onSelect={(next) => { setHomeBase(next); setLocationError(null); }}
                    />
                  )}
                </div>
              )}
            </div>

            <div className="plan-col-dates">
              <div className="tiny muted" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 4 }}>
                Plan for these dates{selectedDays.length > 0 ? ` (${selectedDays.length})` : ''}
              </div>
              <div className="plan-col-hint">Pick weekdays up to {MAX_DAYS_AHEAD} days ahead.</div>
              <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
                <div style={{ flex: 'none', minWidth: 0 }}>
                  <Calendar
                    selected={new Set(selectedDays.map((d) => d.date))}
                    committed={committedDates}
                    proposed={proposedDates}
                    minDate={todayISO()}
                    maxDate={maxPlanDateISO()}
                    maxSelected={MAX_PLAN_DATES}
                    onToggle={toggleDate}
                  />
                </div>
                <div className="selected-days-list" style={{ flex: 'none', minWidth: 0 }}>
                  {selectedDays.length > 0 && (
                    selectedDays.map((d) => {
                      const { hours, minutes } = splitHoursPerDay(d.hoursPerDay);
                      const dateLabel = formatDate(d.date);
                      return (
                      <div key={d.date} className="selected-days-row">
                        <span className="date-label">{dateLabel}</span>
                        <div className="duration-picker">
                          <select
                            aria-label={`Hours budgeted for ${dateLabel}`}
                            value={hours}
                            onChange={(e) => setHoursForDate(d.date, Number(e.target.value) + minutes / 60)}
                          >
                            {HOUR_OPTIONS.map((h) => (
                              <option key={h} value={h}>{h} h</option>
                            ))}
                          </select>
                          <span className="duration-sep">:</span>
                          <select
                            aria-label={`Minutes budgeted for ${dateLabel}`}
                            value={minutes}
                            onChange={(e) => setHoursForDate(d.date, hours + Number(e.target.value) / 60)}
                          >
                            {MINUTE_OPTIONS.map((m) => (
                              <option key={m} value={m}>{String(m).padStart(2, '0')} m</option>
                            ))}
                          </select>
                        </div>
                        <Button
                          variant="ghost"
                          size="small"
                          onClick={() => removeDate(d.date)}
                          disabled={proposedDates.has(d.date)}
                          title={proposedDates.has(d.date) ? 'Already proposed — discard the proposal to remove this date' : 'Remove this date'}
                        >
                          ✕
                        </Button>
                      </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {committedSummaries.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Already Planned</h2>
          </div>
          <div className="card-body">
            <ul className="list">
              {committedSummaries.map((s) => (
                <li key={s.date} className="stop">
                  <div className="main">
                    <div className="name">{formatDate(s.date)}</div>
                    <div className="meta">{s.count} visit{s.count === 1 ? '' : 's'} planned</div>
                  </div>
                  <div className="actions" style={{ alignItems: 'center' }}>
                    <span className="badge committed" style={{ flex: 'none', minWidth: 0 }}>✓ Planned</span>
                    <Button
                      variant="secondary"
                      size="small"
                      onClick={() => reopenDay(s.date)}
                      disabled={!homeBase || reopeningDate === s.date || deletingCommittedDate === s.date}
                      title={homeBase ? "Pull this day's visits back into an editable proposal" : 'Set a starting point above before editing a planned day'}
                    >
                      {reopeningDate === s.date ? 'Editing…' : 'Edit'}
                    </Button>
                    <Button
                      variant="danger"
                      size="small"
                      onClick={() => deleteCommittedDay(s.date)}
                      disabled={deletingCommittedDate === s.date || reopeningDate === s.date}
                      title="Remove this day's planned visits"
                    >
                      ✕
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {loading ? (
        <div className="loading">Loading…</div>
      ) : !draft ? (
        committedSummaries.length === 0 && (
          <EmptyState message="No visits planned yet." />
        )
      ) : (
        // A day whose proposal has been fully accepted (no stops left to
        // propose, but it did produce committed visits) drops its card here —
        // it's already reflected in "Already Planned" above, so the card would
        // just be a redundant empty shell. A day with zero stops and nothing
        // committed still shows (the "Nothing planned for this day" case,
        // right after generating), and any day with open stops still shows
        // regardless of committed count (a partial commit — see commitDay's
        // skippedCollisions — leaves a real proposal still active). See
        // openDays() above — load() uses the exact same rule to auto-discard
        // the whole draft once every day's card would drop out here.
        openDays(draft)
          .map((day) => (
            <DraftDay
              key={day.date}
              day={day}
              draftId={draft.id}
              onDayUpdated={updateDay}
              onDayCommitted={handleDayCommitted}
              onDayDiscarded={handleDayDiscarded}
              onError={setError}
              reload={load}
              userId={userId}
            />
          ))
      )}
    </div>
  );
}
