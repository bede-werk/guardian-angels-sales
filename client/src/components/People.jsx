import React, { useEffect, useState, useCallback } from 'react';
import { api, formatDate } from '../api';
import { CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PersonDetail from './PersonDetail';
import PersonModal from './PersonModal';
import PlaceDetail from './PlaceDetail';

// Searchable / filterable directory of every person across every place —
// the People counterpart to Places.jsx. Clicking any row opens that
// person's full detail (PersonDetail.jsx).
export default function People() {
  const [filters, setFilters] = useState({ categories: [] }); // category dropdown options, loaded once
  const [places, setPlaces] = useState([]); // every place, for the place filter + the Add Person picker
  const [q, setQ] = useState({ search: '', placeId: '', category: '', neverContacted: '', needsAttention: '' });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // person id whose detail modal is open, if any
  const [viewingPlaceId, setViewingPlaceId] = useState(null); // place id opened from a person's "View place" link
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.filters().then(setFilters).catch(() => {});
    api.places({}).then(setPlaces).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.people.list(q));
    } finally {
      setLoading(false);
    }
  }, [q]);

  // Debounce so typing in search doesn't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const set = (k) => (e) => setQ((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* Filter bar: search box + place/category dropdowns + "Never
          contacted" / "Needs attention" toggle buttons. */}
      <div className="card">
        <div className="card-body">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field">Search</label>
              <input placeholder="Name, title…" value={q.search} onChange={set('search')} />
            </div>
            <div>
              <label className="field">Place</label>
              <select value={q.placeId} onChange={set('placeId')}>
                <option value="">All</option>
                {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Category</label>
              <select value={q.category} onChange={set('category')}>
                <option value="">All</option>
                {filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ flex: 'unset' }}>
              <label className="field">&nbsp;</label>
              <Button
                variant={q.neverContacted ? 'primary' : 'secondary'}
                title={q.neverContacted ? 'Showing only people with no visit ever logged — click to clear this filter' : 'Filter to only people with no visit ever logged'}
                onClick={() => setQ((s) => ({ ...s, neverContacted: s.neverContacted ? '' : '1' }))}
              >
                Never contacted
              </Button>
            </div>
            <div style={{ flex: 'unset' }}>
              <label className="field">&nbsp;</label>
              <Button
                variant={q.needsAttention ? 'primary' : 'secondary'}
                onClick={() => setQ((s) => ({ ...s, needsAttention: s.needsAttention ? '' : '1' }))}
                title="Referred before, but nothing in the last 90 days"
              >
                Needs attention
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Results table. Each row is clickable and opens PersonDetail. */}
      <div className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : `${rows.length} people`}</h2>
          <Button variant="secondary" size="small" title="Create a brand-new person" onClick={() => setAdding(true)}>+ Add person</Button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Place</th>
                <th>Category</th>
                <th>Referrals</th>
                <th>Last contacted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => setSelected(p.id)}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.is_primary && <span className="badge star" style={{ marginLeft: 6 }}>★</span>}
                    {p.title && <div className="tiny muted">{p.title}</div>}
                  </td>
                  <td className="tiny">
                    {p.place_name ? (
                      <>{p.place_name}<br /><span className="muted">{p.place_city}</span></>
                    ) : (
                      <span className="muted">Unassigned</span>
                    )}
                  </td>
                  <td><CategoryChip category={p.place_category} /></td>
                  <td className="tiny">
                    {p.referral_metrics.lifetime_referrals > 0 ? (
                      <>
                        {p.referral_metrics.lifetime_referrals} · last {formatDate(p.referral_metrics.last_referral_date)}
                        {p.referral_metrics.needs_attention && (
                          <div><span className="badge attention" style={{ marginTop: 2 }}>Needs attention</span></div>
                        )}
                      </>
                    ) : (
                      <span className="muted">None yet</span>
                    )}
                  </td>
                  <td className="tiny">{p.last_visit_date ? formatDate(p.last_visit_date) : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={5}><EmptyState message="No people match those filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <PersonDetail
          personId={selected}
          onClose={() => setSelected(null)}
          onChanged={load}
          onDeleted={load}
          onOpenPlace={(placeId) => setViewingPlaceId(placeId)}
        />
      )}

      {viewingPlaceId && (
        <PlaceDetail placeId={viewingPlaceId} onClose={() => setViewingPlaceId(null)} onChanged={load} onDeleted={load} />
      )}

      {adding && (
        <PersonModal places={places} onClose={() => setAdding(false)} onSaved={load} />
      )}
    </div>
  );
}
