import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, navigateUrl } from '../api';
import { TierChip, StatusChip, OutcomeChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import VisitLogModal from './VisitLogModal';

const MINUTES_PER_STOP = 45; // matches the scheduler's 30min visit + 15min travel assumption

function formatHoursUsed(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// Today's route: auto-generate ~4hrs of clustered, priority-ordered stops, then
// manually reorder / swap / skip / log each one.
export default function Schedule({ date, userId }) {
  const [route, setRoute] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [logging, setLogging] = useState(null); // visit being logged
  const [hours, setHours] = useState(4);
  const [dragIndex, setDragIndex] = useState(null); // for styling only
  const [overIndex, setOverIndex] = useState(null);
  const dragIndexRef = useRef(null); // source of truth for the drag (avoids stale closure)

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
  async function persistOrder(next) {
    setRoute(next);
    try {
      await api.reorder(next.map((v) => v.visit_id));
    } catch (e) {
      setError(e.message);
      load();
    }
  }

  // Move a stop up/down (arrow-button fallback).
  function move(index, dir) {
    const target = index + dir;
    if (target < 0 || target >= route.length) return;
    const next = [...route];
    [next[index], next[target]] = [next[target], next[index]];
    persistOrder(next);
  }

  // Drag a stop to a new position and persist.
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
                      {v.primary_contact && (
                        <div className="stop-contact">
                          <span className="tiny">Ask for <strong>{v.primary_contact.name}</strong></span>{' '}
                          {v.primary_contact.relationship_temp && (
                            <TemperatureDot temp={v.primary_contact.relationship_temp} />
                          )}
                        </div>
                      )}
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

      {logging && (
        <VisitLogModal
          visit={logging}
          onClose={() => setLogging(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
