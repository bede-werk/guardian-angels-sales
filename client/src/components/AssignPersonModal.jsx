import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// Search across every person already on file and assign one or more of them
// to this place at once. Reassigns them (place_id -> this place) if they're
// currently elsewhere, same as PersonDetail's own "Assign to a place" picker
// — this is just the mirror image, initiated from the place's side. The
// counterpart to PlaceDetail's "Create person" button, which makes a
// brand-new record instead.
export default function AssignPersonModal({ placeId, placeName, onClose, onAssigned }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [unassigned, setUnassigned] = useState([]);
  const [loadingUnassigned, setLoadingUnassigned] = useState(true);
  const [selected, setSelected] = useState(() => new Set()); // ids picked for the batch assign
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState(null);

  // Default view: everyone with no place yet, so there's something to pick
  // from before typing a single character.
  useEffect(() => {
    let cancelled = false;
    setLoadingUnassigned(true);
    (async () => {
      try {
        const rows = await api.people.list({});
        if (!cancelled) setUnassigned(rows.filter((p) => !p.place_id));
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoadingUnassigned(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Debounced search, same 200ms pattern used elsewhere (Places.jsx, People.jsx).
  // Searches everyone on file, not just the unassigned — a person already at
  // another place can still be reassigned here.
  useEffect(() => {
    if (!q.trim()) { setResults([]); return; }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const rows = await api.people.list({ search: q });
        // Already here? Nothing to do — leave them out of their own pick list.
        if (!cancelled) setResults(rows.filter((p) => String(p.place_id) !== String(placeId)).slice(0, 20));
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, placeId]);

  const searching = q.trim().length > 0;
  const list = searching ? results : unassigned;
  const listLoading = searching ? loading : loadingUnassigned;

  function toggle(personId) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(personId)) next.delete(personId);
      else next.add(personId);
      return next;
    });
  }

  async function assignSelected() {
    setAssigning(true);
    setError(null);
    try {
      await Promise.all([...selected].map((id) => api.people.update(id, { place_id: placeId })));
      onAssigned?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setAssigning(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Assign people{placeName ? ` to ${placeName}` : ''}</h2>
          <button className="close" title="Close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <input placeholder="Search by name or title…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {!searching && (
            <div className="tiny muted" style={{ marginTop: 10 }}>Unassigned people</div>
          )}
          {listLoading ? (
            <div className="loading">{searching ? 'Searching…' : 'Loading…'}</div>
          ) : list.length === 0 ? (
            <EmptyState message={searching ? 'No matching people.' : 'No unassigned people on file.'} />
          ) : (
            <ul className="list">
              {list.map((p) => (
                <li
                  key={p.id}
                  className={`stack hover-row ${selected.has(p.id) ? 'selected' : ''}`}
                  style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}
                  onClick={() => !assigning && toggle(p.id)}
                  title={`Link ${p.name} to ${placeName || 'this place'}${p.place_name ? ` (moves them from ${p.place_name})` : ''}`}
                >
                  <div>
                    <strong>{p.name}</strong>
                    {p.title && <span className="tiny muted"> · {p.title}</span>}
                  </div>
                  <div className="tiny muted">{p.place_name ? `Currently at ${p.place_name}` : 'Unassigned'}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose} disabled={assigning}>Cancel</Button>
          <Button onClick={assignSelected} disabled={selected.size === 0 || assigning}>
            {assigning ? 'Assigning…' : `Assign ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
