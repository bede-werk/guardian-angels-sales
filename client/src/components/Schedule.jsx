import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { TierBadge, StatusBadge, OutcomeBadge } from './Badges';
import VisitLogModal from './VisitLogModal';

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

  const activeCount = route.filter((v) => v.status !== 'skipped').length;

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Route for {date}</h2>
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
              <button className="btn" onClick={() => generate(false)}>Generate route</button>
            ) : (
              <button className="btn secondary" onClick={() => generate(true)}>Regenerate</button>
            )}
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="loading">Loading…</div>
          ) : route.length === 0 ? (
            <div className="empty">
              No stops planned for this day.<br />
              Click <strong>Generate route</strong> to auto-build a clustered, priority-ordered day.
            </div>
          ) : (
            <>
              <div className="muted tiny" style={{ marginBottom: 8 }}>
                {activeCount} active stop{activeCount === 1 ? '' : 's'} · ordered by priority within the tightest geographic cluster
              </div>
              <ul className="list">
                {route.map((v, i) => (
                  <li
                    key={v.visit_id}
                    className={`stop ${v.status === 'completed' ? 'done' : ''} ${v.status === 'skipped' ? 'skipped' : ''} ${overIndex === i ? 'drag-over' : ''} ${dragIndex === i ? 'dragging' : ''}`}
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
                        {v.category} · {v.address ? `${v.address}, ` : ''}{v.city} {v.zip} · <strong>{v.region}</strong>
                      </div>
                      <div className="tag-list" style={{ marginTop: 6 }}>
                        <TierBadge tier={v.tier} isPriority={!!v.is_priority} />
                        <StatusBadge status={v.status} />
                        <OutcomeBadge outcome={v.outcome} />
                        {v.contact_name && <span className="tiny muted">· {v.contact_name}</span>}
                      </div>
                    </div>
                    <div className="actions">
                      <button className="btn small" onClick={() => setLogging(v)}>
                        {v.status === 'completed' ? 'Edit log' : 'Log visit'}
                      </button>
                      {v.status !== 'skipped' && (
                        <button className="btn small secondary" onClick={() => skip(v)}>Skip</button>
                      )}
                      <button className="btn small danger" onClick={() => remove(v)} title="Remove from route">✕</button>
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
