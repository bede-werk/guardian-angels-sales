import React, { useEffect, useState, useCallback } from 'react';
import { api, formatDate } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import StatTile from './ui/StatTile';
import EmptyState from './ui/EmptyState';
import PlaceDetail from './PlaceDetail';

// Short, inline forms of met_with_type. MET_WITH_LABELS in api.js reads as a
// form option ("A staff member (name unknown)") - far too long for a one-line
// list row, so it's shortened here the same way PlaceDetail.jsx shortens it
// for its own visit history.
const ENCOUNTER_SHORT_LABELS = { staff: 'a staff member', receptionist: 'the receptionist' };

// A trip's `encounters` summary as one short line. The list endpoints only
// return name + category per encounter (full per-encounter detail needs
// GET /api/visits/:id), and a row here has one line to spend, so this names
// the first person met and counts the rest rather than listing them all.
function encounterSummary(encounters) {
  if (!encounters || encounters.length === 0) return null;
  // 'nobody' is mutually exclusive with every other type at log time (see
  // VisitLogModal), so it can only ever appear alone - and "with nobody"
  // doesn't read as English.
  if (encounters[0].met_with_type === 'nobody') return 'nobody in';
  const [first, ...rest] = encounters;
  const who = first.met_with_type === 'named_person'
    ? first.person_name || 'someone'
    : ENCOUNTER_SHORT_LABELS[first.met_with_type] || 'someone';
  return `with ${who}${rest.length > 0 ? ` +${rest.length}` : ''}`;
}

// At-a-glance: visits completed this week and places never visited. This
// whole screen is driven by one request: GET /api/dashboard (see
// server/src/routes/dashboard.js), which bundles everything below into one response.
export default function Dashboard({ date, userId }) {
  const [data, setData] = useState(null); // the dashboard API response, or null while loading
  const [error, setError] = useState(null);
  const [selectedPlaceId, setSelectedPlaceId] = useState(null); // which place's detail modal is open, if any

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.dashboard(userId, date));
    } catch (e) {
      setError(e.message);
    }
  }, [date, userId]);

  // Reload whenever the logged-in user or date changes (date never actually
  // changes today since there's no date picker, but userId can).
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading">Loading dashboard…</div>;

  const neverPct = data.never_visited.total_places
    ? Math.round((data.never_visited.count / data.never_visited.total_places) * 100)
    : 0;

  return (
    <div className="grid" style={{ gap: 20 }}>
      {/* Two big stat tiles across the top. */}
      <div className="grid stats">
        <StatTile
          num={data.completed_this_week.count}
          label="Visits completed this week"
          hint={`${formatDate(data.week.start)} → ${formatDate(data.week.end)}`}
        />
        <StatTile
          num={data.never_visited.count}
          label="Places never visited"
          hint={`${neverPct}% of ${data.never_visited.total_places} total`}
        />
      </div>

      <div className="card">
        <div className="card-head"><h2>Completed this week</h2></div>
        <div className="card-body">
          {data.completed_this_week.visits.length === 0 ? (
            <EmptyState message="Nothing completed yet this week." />
          ) : (
            <ul className="list">
              {/* One row per TRIP, not per encounter - a single outcome chip
                  used to sit on the right, but a trip that met three people
                  has three outcomes, so there's no one value to chip. Who was
                  met folds into the meta line instead. */}
              {data.completed_this_week.visits.map((v) => (
                <li key={v.visit_id} className="stop">
                  <div className="main">
                    <div className="name tiny">{v.name}</div>
                    <div className="meta">
                      {[formatDate(v.scheduled_date), v.city, encounterSummary(v.encounters)].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Prospecting list: highest-priority places that have never had a completed visit. */}
      <div className="card">
        <div className="card-head">
          <h2>High-priority places never visited</h2>
          <span className="muted tiny">top {Math.min(12, data.never_visited.places.length)} by priority</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr><th>Organization</th><th>Category</th><th>Priority</th><th>Location</th></tr>
            </thead>
            <tbody>
              {data.never_visited.places.slice(0, 12).map((p) => (
                <tr key={p.id} onClick={() => setSelectedPlaceId(p.id)}>
                  <td><strong>{p.name}</strong></td>
                  <td><CategoryChip category={p.category} /></td>
                  <td><TierChip tier={p.tier} isPriority={p.is_priority} /></td>
                  <td className="muted tiny">{p.city} {p.zip} · {p.region}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Clicking any place row/card above opens this same detail modal. */}
      {selectedPlaceId && (
        <PlaceDetail placeId={selectedPlaceId} userId={userId} onClose={() => setSelectedPlaceId(null)} onChanged={load} onDeleted={load} />
      )}
    </div>
  );
}
