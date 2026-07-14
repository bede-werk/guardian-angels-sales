import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PlacePicker from './ui/PlacePicker';

const HOURS_OPTIONS = [2, 3, 4, 5, 6];

// Turns a minute count into "1h 45m" / "45m" / "2h" (same idea as
// Schedule.jsx's formatHoursUsed, kept local rather than shared since this
// screen is meant to fully replace Schedule.jsx eventually — no point wiring
// a shared util into the screen that's on its way out).
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
function DraftDay({ day, draftId, onDayUpdated, onError, reload }) {
  const [busy, setBusy] = useState(false); // a reorder/add/remove request is in flight for this day
  const [pendingPlaceId, setPendingPlaceId] = useState(null); // one stop's own request (visit-type change)
  const [addingOpen, setAddingOpen] = useState(false);

  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const dragIndexRef = useRef(null);

  const budgetMinutes = day.totalMinutes + day.remainingMinutes;
  const usedPct = budgetMinutes > 0 ? Math.min(100, Math.round((day.totalMinutes / budgetMinutes) * 100)) : 0;

  // Optimistically shows the new order right away (stale running totals until
  // the server responds, since those depend on real drive time between
  // stops) — same pattern Schedule.jsx uses for its own reordering. Rolls
  // back via a full reload if the server rejects it.
  function persistReorder(nextStops) {
    onError(null);
    onDayUpdated({ ...day, stops: nextStops });
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
        {day.overBudget && <span className="badge attention">Over budget</span>}
      </div>
      <div className="card-body">
        <div style={{ marginBottom: 14 }}>
          <div className="progress-bar">
            <div className="fill" style={{ width: `${usedPct}%` }} />
          </div>
          <div className="progress-label">
            {day.stops.length} stop{day.stops.length === 1 ? '' : 's'} · {formatMinutes(day.totalMinutes)} of {formatMinutes(budgetMinutes)}
            {day.overBudget
              ? ` · ${formatMinutes(-day.remainingMinutes)} over`
              : day.remainingMinutes > 0
                ? ` · ${formatMinutes(day.remainingMinutes)} free`
                : ''}
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
                    <div className="tiny muted" style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {formatMinutes(stop.runningTotalMinutes)}
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
            <Button variant="secondary" size="small" onClick={() => setAddingOpen(true)}>+ Add a stop</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// Phase 6 frontend, sub-slice 2: live editing on top of sub-slice 1's
// generate + read-only view — reorder, add/remove, and visit-type changes,
// each recalculating that day's running totals/over-budget flags in place.
// Suggestions (the "nearby eligible stop" prompt) and commit are sub-slice 3.
export default function PlanVisits() {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);

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
              <Button variant="secondary" onClick={() => generate(true)} disabled={!canGenerate}>Plan again</Button>
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
            onError={setError}
            reload={load}
          />
        ))
      )}
    </div>
  );
}
