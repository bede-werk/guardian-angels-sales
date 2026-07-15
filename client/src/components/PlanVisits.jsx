import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PlacePicker from './ui/PlacePicker';

const HOURS_OPTIONS = [2, 3, 4, 5, 6];

// Turns a minute count into "1h 45m" / "45m" / "2h".
function formatMinutes(minutes) {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = Math.round(abs % 60);
  if (h === 0) return `${sign}${m}m`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

// One day's card: stop list with reorder (drag + arrow fallback), remove,
// visit-type change, and ad-hoc add. Every mutation calls its endpoint and
// replaces this day's slice from the response (loadDraftDayView's return) —
// the server always recalculates running totals/overBudget fresh, so the
// live time math and over-budget flagging just fall out of that, per the
// interaction model: edits recalculate in place, nothing is ever auto-
// dropped or auto-reshuffled beyond what the user themselves just did.
function DraftDay({ day, draftId, onDayUpdated, onError, reload, onDayCommitted }) {
  const [busy, setBusy] = useState(false); // a reorder/add/remove request is in flight for this day
  const [pendingPlaceId, setPendingPlaceId] = useState(null); // one stop's own request (visit-type change)
  const [addingOpen, setAddingOpen] = useState(false);

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
    if (!window.confirm(`Commit ${day.stops.length} visit${day.stops.length === 1 ? '' : 's'} for ${formatDate(day.date)}? This creates real scheduled visits.`)) return;
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
          {day.overBudget && <span className="badge attention">Over budget</span>}
          {everEdited && day.stops.length >= 2 && (
            <Button
              size="small"
              variant="secondary"
              onClick={reoptimize}
              disabled={busy || !needsReoptimize}
              title={needsReoptimize ? "Re-sequence this day's stops for the shortest real drive route" : 'Already optimized — edit the day to re-enable'}
            >
              Re-optimize
            </Button>
          )}
          <Button size="small" onClick={commitThisDay} disabled={busy || day.stops.length === 0} title="Turn this day's stops into real scheduled visits">
            Commit day
          </Button>
        </div>
      </div>
      <div className="card-body">
        <div style={{ marginBottom: 14 }}>
          <div className="progress-total">
            {formatMinutes(day.totalMinutes)} <span className="muted" style={{ fontWeight: 400 }}>of {formatMinutes(budgetMinutes)}</span>
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

        {day.stops.length === 0 ? (
          <EmptyState message="Nothing planned for this day." />
        ) : (
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
                  <div className="main">
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
                      title={`Drive ${stop.driveMinutes}m + visit ${stop.visitMinutes}m + prep ${stop.prepMinutes}m + data entry ${stop.dataEntryMinutes}m`}
                    >
                      {formatMinutes(stop.blockMinutes)}
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
              <Button variant="secondary" size="small" onClick={() => setAddingOpen(true)}>+ Add a stop</Button>
              {canSuggest && (
                <Button variant="ghost" size="small" onClick={toggleSuggestions}>
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
    </div>
  );
}

// Phase 6 frontend, sub-slice 3: suggestions (the "nearby eligible stop"
// prompt on under-budget days, per DraftDay above) and commit — per-day
// (DraftDay's "Commit day" button) and all-remaining-days (this component's
// "Commit all" button). Built on top of sub-slice 2's live editing.
export default function PlanVisits() {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [committingAll, setCommittingAll] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const [daysAhead, setDaysAhead] = useState(5);
  const [hoursPerDay, setHoursPerDay] = useState(4);

  // homeBase capture: browser geolocation first, manual address as fallback
  // (see conversation decision — no rep/user location field exists in the
  // schema yet, so this is asked for at generate time instead).
  const [homeBase, setHomeBase] = useState(null); // { lat, lng, label }
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState(null);
  const [manualAddress, setManualAddress] = useState({ address: '', city: '', state: '', zip: '' });
  const [geocoding, setGeocoding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDraft(await api.scheduleDrafts.active());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      parts.push(`Committed ${result.committed.length} visit${result.committed.length === 1 ? '' : 's'} for ${formatDate(date)}.`);
    }
    if (result.skippedCollisions.length > 0) {
      parts.push(`Skipped ${result.skippedCollisions.length} (already booked elsewhere by then): ${result.skippedCollisions.map((c) => c.place_name).join(', ')}.`);
    }
    if (parts.length === 0) parts.push(`Nothing to commit for ${formatDate(date)}.`);
    setNotice(parts.join(' '));
    load();
  }

  async function commitAllDays() {
    if (!draft) return;
    const totalStops = draft.days.reduce((n, d) => n + d.stops.length, 0);
    if (totalStops === 0) { setError('Nothing to commit yet.'); return; }
    if (!window.confirm(`Commit every remaining planned visit across all days? This creates real scheduled visits.`)) return;
    setError(null);
    setCommittingAll(true);
    try {
      const results = await api.scheduleDrafts.commitAll(draft.id);
      const committed = results.reduce((n, r) => n + r.committed.length, 0);
      const skipped = results.reduce((n, r) => n + r.skippedCollisions.length, 0);
      setNotice(`Committed ${committed} visit${committed === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} (already booked elsewhere)` : ''}.`);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setCommittingAll(false);
    }
  }

  // Discards the whole proposal — every day, not just one. Any day already
  // committed is unaffected (its stops left the draft the moment they
  // became real visits), so this only throws away still-uncommitted work.
  // homeBase is deliberately left as-is so a fresh "Plan my visits" doesn't
  // force re-entering a start location.
  async function discardDraft() {
    if (!draft) return;
    const totalStops = draft.days.reduce((n, d) => n + d.stops.length, 0);
    const warning = totalStops > 0
      ? `Discard this entire proposal? ${totalStops} planned visit${totalStops === 1 ? '' : 's'} across every day will be lost — this can't be undone.`
      : 'Discard this proposal and start over?';
    if (!window.confirm(warning)) return;
    setError(null);
    setDiscarding(true);
    try {
      await api.scheduleDrafts.discard(draft.id);
      setDraft(null);
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

  async function lookUpManualAddress() {
    setGeocoding(true);
    setError(null);
    try {
      const coords = await api.geocode(manualAddress);
      if (!coords) {
        setError("Couldn't find that address — check it and try again.");
        return;
      }
      const label = [manualAddress.address, manualAddress.city].filter(Boolean).join(', ') || 'Start address';
      setHomeBase({ ...coords, label });
      setLocationError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setGeocoding(false);
    }
  }

  async function generate(regenerate) {
    setError(null);
    setNotice(null);
    setGenerating(true);
    try {
      const next = await api.scheduleDrafts.generate({
        daysAhead: Number(daysAhead),
        hoursPerDay: Number(hoursPerDay),
        homeBase: { lat: homeBase.lat, lng: homeBase.lng },
        regenerate,
      });
      setDraft(next);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating(false);
    }
  }

  const canGenerate = !!homeBase && !generating;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}
      {notice && <div className="notice-banner">{notice}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Plan my visits</h2>
          <div className="row" style={{ flex: 'unset', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 90 }}>
              <label className="field">Days</label>
              <input
                type="number"
                min={1}
                max={10}
                value={daysAhead}
                onChange={(e) => setDaysAhead(e.target.value)}
                style={{ width: 70 }}
              />
            </div>
            <div style={{ minWidth: 90 }}>
              <label className="field">Hours/day</label>
              <select value={hoursPerDay} onChange={(e) => setHoursPerDay(e.target.value)}>
                {HOURS_OPTIONS.map((h) => (
                  <option key={h} value={h}>{h} hrs</option>
                ))}
              </select>
            </div>
            {draft ? (
              <>
                <Button variant="danger" onClick={discardDraft} disabled={discarding || committingAll}>
                  {discarding ? 'Discarding…' : 'Discard plan'}
                </Button>
                <Button variant="secondary" onClick={() => generate(true)} disabled={!canGenerate}>Plan again</Button>
                <Button onClick={commitAllDays} disabled={committingAll}>
                  {committingAll ? 'Committing…' : 'Commit all'}
                </Button>
              </>
            ) : (
              <Button onClick={() => generate(false)} disabled={!canGenerate}>Plan my visits</Button>
            )}
          </div>
        </div>
        <div className="card-body">
          {/* Start-location capture — required before generating. */}
          {homeBase ? (
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="tiny muted">Starting from <strong>{homeBase.label}</strong></span>
              <Button variant="ghost" size="small" onClick={() => { setHomeBase(null); setLocationError(null); }}>Change</Button>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <Button variant="secondary" onClick={useCurrentLocation} disabled={locating}>
                {locating ? 'Finding you…' : 'Use my current location'}
              </Button>
              {locationError && (
                <>
                  <div className="tiny muted">{locationError}</div>
                  <div className="row">
                    <div>
                      <label className="field">Street address</label>
                      <input value={manualAddress.address} onChange={(e) => setManualAddress({ ...manualAddress, address: e.target.value })} />
                    </div>
                    <div>
                      <label className="field">City</label>
                      <input value={manualAddress.city} onChange={(e) => setManualAddress({ ...manualAddress, city: e.target.value })} />
                    </div>
                    <div style={{ minWidth: 70 }}>
                      <label className="field">State</label>
                      <input value={manualAddress.state} onChange={(e) => setManualAddress({ ...manualAddress, state: e.target.value })} />
                    </div>
                    <div style={{ minWidth: 90 }}>
                      <label className="field">Zip</label>
                      <input value={manualAddress.zip} onChange={(e) => setManualAddress({ ...manualAddress, zip: e.target.value })} />
                    </div>
                    <Button size="small" onClick={lookUpManualAddress} disabled={geocoding}>
                      {geocoding ? 'Looking up…' : 'Use this address'}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="loading">Loading…</div>
      ) : !draft ? (
        <EmptyState message="No visits planned yet. Let's map out your days." />
      ) : (
        draft.days.map((day) => (
          <DraftDay
            key={day.date}
            day={day}
            draftId={draft.id}
            onDayUpdated={updateDay}
            onDayCommitted={handleDayCommitted}
            onError={setError}
            reload={load}
          />
        ))
      )}
    </div>
  );
}
