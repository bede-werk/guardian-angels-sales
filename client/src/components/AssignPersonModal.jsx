import React, { useEffect, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';

// Search across every person already on file and assign one of them to this
// place. Reassigns them (place_id -> this place) if they're currently
// elsewhere, same as PersonDetail's own "Assign to a place" picker — this is
// just the mirror image, initiated from the place's side. The counterpart to
// PlaceDetail's "Create person" button, which makes a brand-new record instead.
export default function AssignPersonModal({ placeId, placeName, onClose, onAssigned }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [unassigned, setUnassigned] = useState([]);
  const [loadingUnassigned, setLoadingUnassigned] = useState(true);
  const [busyId, setBusyId] = useState(null);
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
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const rows = await api.people.list({ search: q });
        // Already here? Nothing to do — leave them out of their own pick list.
        setResults(rows.filter((p) => String(p.place_id) !== String(placeId)).slice(0, 20));
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, placeId]);

  const searching = q.trim().length > 0;
  const list = searching ? results : unassigned;
  const listLoading = searching ? loading : loadingUnassigned;

  async function assign(person) {
    setBusyId(person.id);
    setError(null);
    try {
      await api.people.update(person.id, { place_id: placeId });
      onAssigned?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusyId(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Assign a person{placeName ? ` to ${placeName}` : ''}</h2>
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
                <li key={p.id} className="stack" style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <div>
                      <strong>{p.name}</strong>
                      {p.title && <span className="tiny muted"> · {p.title}</span>}
                      <div className="tiny muted">{p.place_name ? `Currently at ${p.place_name}` : 'Unassigned'}</div>
                    </div>
                    <Button
                      size="small"
                      style={{ flex: 'unset' }}
                      title={`Link ${p.name} to ${placeName || 'this place'}${p.place_name ? ` (moves them from ${p.place_name})` : ''}`}
                      onClick={() => assign(p)}
                      disabled={busyId === p.id}
                    >
                      {busyId === p.id ? 'Assigning…' : 'Assign here'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
