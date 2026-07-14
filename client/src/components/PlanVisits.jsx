import React, { useCallback, useEffect, useState } from 'react';
import { api, formatDate, VISIT_TYPE_LABELS } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

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

// Phase 6 frontend, sub-slice 1: generate-inputs + a read-only render of the
// active multi-day draft (server/src/routes/scheduleDrafts.js). Editing
// (reorder/add/remove/visit-type), suggestions, and commit are later slices —
// this screen only generates and displays.
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
        draft.days.map((day) => {
          const budgetMinutes = day.totalMinutes + day.remainingMinutes;
          const usedPct = budgetMinutes > 0 ? Math.min(100, Math.round((day.totalMinutes / budgetMinutes) * 100)) : 0;
          return (
            <div className="card" key={day.date}>
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
                    {day.stops.map((stop, i) => (
                      <li key={stop.place_id} className={`stop ${stop.overBudget ? 'attention-flag' : ''}`}>
                        <div className="order">{i + 1}</div>
                        <div className="main">
                          <div className="name">{stop.place_name}</div>
                          <div className="meta">
                            {stop.address ? `${stop.address}, ` : ''}{stop.city} {stop.zip}
                          </div>
                          <div className="tag-list" style={{ marginTop: 6 }}>
                            <CategoryChip category={stop.category} />
                            <TierChip tier={stop.tier} />
                            <span className="badge role">{VISIT_TYPE_LABELS[stop.visitType] || stop.visitType}</span>
                          </div>
                        </div>
                        <div className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                          {formatMinutes(stop.runningTotalMinutes)}
                          {stop.overBudget && <div style={{ color: 'var(--mauve)', fontWeight: 600 }}>Over budget</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
