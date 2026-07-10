import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, navigateUrl } from '../api';
import { TierChip, StatusChip, OutcomeChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';

const MINUTES_PER_STOP = 45; // matches the scheduler's 30min visit + 15min travel assumption

// Turns a minute count into "1h 45m" / "45m" / "2h" for the progress line.
function formatHoursUsed(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Today's route: auto-generate ~4hrs of clustered, priority-ordered stops, then
// manually reorder / swap / skip / log each one. This is the "star screen" —
// see server/src/services/scheduler.js for how the route is actually built.
export default function Schedule({ date, userId }) {
  const [route, setRoute] = useState([]); // array of stops, in route order
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [logging, setLogging] = useState(null); // the stop currently open in the Log Visit modal, or null
  const [hours, setHours] = useState(4); // hours budget picked in the dropdown, used when (re)generating

  // Drag-and-drop reordering state. dragIndex/overIndex are just for CSS
  // styling (which row is being dragged / hovered over); dragIndexRef is the
  // actual source of truth read inside onDrop, since state updates inside
  // drag event handlers can be stale by the time the drop event fires.
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const dragIndexRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoute(await api.schedule(date, userId));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [date, userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Builds (or rebuilds) today's route. `regenerate: true` throws out any
  // not-yet-completed stops first (see POST /api/schedule/generate).
  async function generate(regenerate) {
    setError(null);
    try {
      const res = await api.generateSchedule({ date, userId, hours: Number(hours), regenerate });
      setRoute(res.route);
    } catch (e) {
      setError(e.message);
    }
  }

  // Persist a reordered array of stops (optimistic; reloads on failure).
  // "Optimistic" means the UI updates instantly (setRoute(next)) instead of
  // waiting for the server to confirm — feels snappier for a quick reorder.
  async function persistOrder(next) {
    setRoute(next);
    try {
      await api.reorder(next.map((v) => v.visit_id));
    } catch (e) {
      setError(e.message);
      load(); // something went wrong — reload the real order from the server
    }
  }

  // Move a stop up/down (arrow-button fallback for devices without drag/drop, e.g. touch).
  function move(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= route.length) return;
    const next = [...route];
    [next[index], next[target]] = [next[target], next[index]];
    persistOrder(next);
  }

  // Drag a stop to a new position and persist. Standard HTML5 drag-and-drop:
  // onDragStart remembers which row is being dragged, onDrop on the target row
  // splices it out of its old spot and into the new one.
  function onDrop(targetIndex) {
    const from = dragIndexRef.current;
    if (from === null || from === targetIndex) return;
    const next = [...route];
    const [moved] = next.splice(from, 1);
    next.splice(targetIndex, 0, moved);
    dragIndexRef.current = null;
    setDragIndex(null);
    setOverIndex(null);
    persistOrder(next);
  }

  async function skip(v) {
    await api.skipVisit(v.visit_id);
    load();
  }
  async function remove(v) {
    await api.deleteVisit(v.visit_id);
    load();
  }

  // Progress bar math: skipped stops don't count toward "active" totals, and
  // "time used" is an estimate (completed count × the scheduler's assumed
  // 45 min/stop), since we don't track actual visit durations.
  const activeStops = route.filter((v) => v.status !== 'skipped');
  const completedCount = activeStops.filter((v) => v.status === 'completed').length;
  const progressPct = activeStops.length ? Math.round((completedCount / activeStops.length) * 100) : 0;
  const minutesUsed = completedCount * MINUTES_PER_STOP;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Today's route</h2>
          <div className="row" style={{ flex: 'unset', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 90 }}>
              <label className="field">Hours</label>
              <select value={hours} onChange={(e) => setHours(e.target.value)}>
                {[2, 3, 4, 5, 6].map((h) => (
                  <option key={h} value={h}>{h} hrs</option>
                ))}
              </select>
            </div>
            {/* First-time build vs. rebuild get different labels/behavior. */}
            {route.length === 0 ? (
              <Button onClick={() => generate(false)}>Plan today's visits</Button>
            ) : (
              <Button variant="secondary" onClick={() => generate(true)}>Plan again</Button>
            )}
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="loading">Loading…</div>
          ) : route.length === 0 ? (
            <EmptyState
              message="No visits planned yet. Let's map out your day."
              action={<Button onClick={() => generate(false)}>Plan today's visits</Button>}
            />
          ) : (
            <>
              {/* Progress bar: "X of Y visits done · Zh Zm of Nh used". */}
              <div style={{ marginBottom: 14 }}>
                <div className="progress-bar">
                  <div className="fill" style={{ width: `${progressPct}%` }} />
                </div>
                <div className="progress-label">
                  {completedCount} of {activeStops.length} visit{activeStops.length === 1 ? '' : 's'} done ·{' '}
                  {formatHoursUsed(minutesUsed)} of {hours}h used
                </div>
              </div>
              <ul className="list">
                {/* Each <li> is one stop card: draggable for reordering, with
                    up/down arrow buttons as a non-drag fallback. */}
                {route.map((v, i) => (
                  <li
                    key={v.visit_id}
                    className={`stop ${v.status === 'completed' ? 'done' : ''} ${v.status === 'skipped' ? 'skipped' : ''} ${v.never_visited ? 'attention-flag' : ''} ${overIndex === i ? 'drag-over' : ''} ${dragIndex === i ? 'dragging' : ''}`}
                    draggable
                    onDragStart={() => { dragIndexRef.current = i; setDragIndex(i); }}
                    onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
                    onDragLeave={() => setOverIndex((o) => (o === i ? null : o))}
                    onDrop={() => onDrop(i)}
                    onDragEnd={() => { dragIndexRef.current = null; setDragIndex(null); setOverIndex(null); }}
                  >
                    <div className="reorder">
                      <span className="drag-handle" title="Drag to reorder">⠿</span>
                      <button onClick={() => move(i, -1)} disabled={i === 0} title="Move up">▲</button>
                      <button onClick={() => move(i, 1)} disabled={i === route.length - 1} title="Move down">▼</button>
                    </div>
                    <div className="order">{i + 1}</div>
                    <div className="main">
                      <div className="name">{v.name}</div>
                      <div className="meta">
                        {v.address ? `${v.address}, ` : ''}{v.city} {v.zip} · <strong>{v.region}</strong>
                      </div>
                      <div className="tag-list" style={{ marginTop: 6 }}>
                        <CategoryChip category={v.category} />
                        <TierChip tier={v.tier} isPriority={!!v.is_priority} />
                        <StatusChip status={v.status} />
                        <OutcomeChip outcome={v.outcome} />
                        {v.never_visited && <span className="badge star" style={{ background: 'var(--mauve-tint-1)', color: 'var(--mauve)' }}>Never visited</span>}
                      </div>
                      {/* "Who to ask for" — this place's contact person, from
                          the people table. */}
                      {v.contact_person && (
                        <div className="stop-contact">
                          <span className="tiny">Ask for <strong>{v.contact_person.name}</strong></span>
                        </div>
                      )}
                      {/* A one-line preview of what happened last time you visited. */}
                      {v.last_visit_notes && (
                        <div className="stop-note-preview">"{v.last_visit_notes}"</div>
                      )}
                      <div className="stop-buttons">
                        <Button variant="secondary" size="big" onClick={() => window.open(navigateUrl(v), '_blank')}>
                          Navigate
                        </Button>
                        <Button size="big" onClick={() => setLogging(v)}>
                          {v.status === 'completed' ? 'Edit log' : 'Log Visit'}
                        </Button>
                      </div>
                    </div>
                    <div className="actions">
                      {v.status !== 'skipped' && (
                        <Button variant="secondary" size="small" onClick={() => skip(v)}>Skip</Button>
                      )}
                      <Button variant="danger" size="small" onClick={() => remove(v)} title="Remove from route">✕</Button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      {/* Opened by the "Log Visit"/"Edit log" button on a stop above. */}
      {logging && (
        <VisitLogModal
          visit={logging}
          userId={userId}
          onClose={() => setLogging(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
