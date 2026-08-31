import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import useClosingTransition from '../hooks/useClosingTransition';

// Search across every place on file and link this person to one of them - the
// mirror image of AssignPersonModal, initiated from the person's side. Opened
// from PersonDetail's "Assign to a place" button, replacing the inline <select>
// that used to live in the Place card. A person belongs to exactly one place,
// so unlike AssignPersonModal this is a single pick, not a batch.
//
// onAssign does the actual api.people.update call + reload in PersonDetail and
// reports back true/false, so this only closes itself on success - a failed
// save leaves the picker open.
export default function AssignPlaceModal({ personName, currentPlaceId, onAssign, saving, onClose }) {
  const { closing, requestClose } = useClosingTransition(onClose);
  const [q, setQ] = useState('');
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // id of the place picked
  const [error, setError] = useState(null);

  // The full place list is small enough (a few hundred rows, asked for
  // A-Z explicitly rather than in the directory's default all-stars/capacity
  // order) to load once and filter in the browser - keeps typing instant
  // and matches what the old inline <select> already did.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.places({ sort: 'name_asc' });
        if (!cancelled) setPlaces(rows);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = places.filter((p) => String(p.id) !== String(currentPlaceId));
    if (!needle) return rows;
    return rows.filter((p) =>
      [p.name, p.city, p.region, p.category].filter(Boolean).some((s) => s.toLowerCase().includes(needle))
    );
  }, [places, q, currentPlaceId]);

  async function assign() {
    if (!selected) return;
    setError(null);
    const ok = await onAssign(selected);
    if (ok !== false) requestClose();
  }

  return (
    <div className={`modal-backdrop${closing ? ' closing' : ''}`} onClick={(e) => { e.stopPropagation(); requestClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Assign to a Place{personName ? ` · ${personName}` : ''}</h2>
          <button className="close" title="Close" onClick={requestClose}>×</button>
        </div>
        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <input
            placeholder="Search by name, city, or category…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            disabled={saving}
            autoFocus
          />
          {loading ? (
            <div className="loading">Loading…</div>
          ) : filtered.length === 0 ? (
            <EmptyState message={q.trim() ? 'No matching places.' : 'No places on file.'} />
          ) : (
            <ul className="list">
              {filtered.map((p) => (
                <li
                  key={p.id}
                  className={`stack hover-row ${selected === p.id ? 'selected' : ''}`}
                  style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}
                  onClick={() => !saving && setSelected(p.id)}
                  title={`Link ${personName || 'this person'} to ${p.name}`}
                >
                  <div>
                    <strong>{p.name}</strong>
                    {p.category && <span className="tiny muted"> · {p.category}</span>}
                  </div>
                  <div className="tiny muted">{[p.city, p.region].filter(Boolean).join(' · ')}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="modal-foot">
          <Button onClick={assign} disabled={!selected || saving}>
            {saving ? 'Assigning…' : 'Assign'}
          </Button>
        </div>
      </div>
    </div>
  );
}
