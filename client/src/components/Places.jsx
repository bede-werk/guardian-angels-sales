import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PlaceDetail from './PlaceDetail';
import PlaceModal from './PlaceModal';

// Searchable / filterable place directory with last-visit + contact info.
// Clicking any row opens that place's full detail (PlaceDetail.jsx).
export default function Places() {
  const [filters, setFilters] = useState({ categories: [], cities: [], zips: [], tiers: [] }); // dropdown options, loaded once
  const [q, setQ] = useState({ search: '', category: '', tier: '', city: '', zip: '', neverVisited: '' }); // current filter values
  const [rows, setRows] = useState([]); // the filtered place list from the API
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // place id whose detail modal is open, if any
  const [adding, setAdding] = useState(false); // whether the Add Place modal is open

  // Load the filter dropdown options (distinct categories/cities/zips) once on mount.
  useEffect(() => {
    api.filters().then(setFilters).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.places(q));
    } finally {
      setLoading(false);
    }
  }, [q]);

  // Debounce so typing in search doesn't hammer the API on every keystroke —
  // waits 200ms after the last change to `q` before actually fetching.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Shorthand for wiring an <input>/<select> straight into the `q` filter state.
  const set = (k) => (e) => setQ((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* Filter bar: search box + category/tier/city/zip dropdowns + a
          "Never visited" toggle button. */}
      <div className="card">
        <div className="card-body">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field">Search</label>
              <input placeholder="Name, address, category…" value={q.search} onChange={set('search')} />
            </div>
            <div>
              <label className="field">Category</label>
              <select value={q.category} onChange={set('category')}>
                <option value="">All</option>
                {filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Tier</label>
              <select value={q.tier} onChange={set('tier')}>
                <option value="">All</option>
                {filters.tiers.map((t) => <option key={t} value={t}>Tier {t}</option>)}
              </select>
            </div>
            <div>
              <label className="field">City</label>
              <select value={q.city} onChange={set('city')}>
                <option value="">All</option>
                {filters.cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Zip</label>
              <select value={q.zip} onChange={set('zip')}>
                <option value="">All</option>
                {filters.zips.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
            <div style={{ flex: 'unset' }}>
              <label className="field">&nbsp;</label>
              <Button
                variant={q.neverVisited ? 'primary' : 'secondary'}
                onClick={() => setQ((s) => ({ ...s, neverVisited: s.neverVisited ? '' : '1' }))}
              >
                Never visited
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Results table. Each row is clickable and opens PlaceDetail. */}
      <div className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : `${rows.length} places`}</h2>
          <Button variant="secondary" size="small" onClick={() => setAdding(true)}>+ Add place</Button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Location</th>
                <th>Last visit</th>
                <th>Contact</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => setSelected(p.id)}>
                  <td><strong>{p.name}</strong></td>
                  <td><CategoryChip category={p.category} /></td>
                  <td><TierChip tier={p.tier} isPriority={p.is_priority} /></td>
                  <td className="muted tiny">{p.city} {p.zip}<br />{p.region}</td>
                  <td className="tiny">{p.last_visit_date || <span className="muted">—</span>}</td>
                  <td className="tiny">
                    {/* p.person is this place's primary person, included by
                        the API's list endpoint so this column doesn't need a
                        separate request per row. */}
                    {p.person ? (
                      <div className="stack">
                        <span>{p.person.name}</span>
                        {p.person.relationship_temp && <TemperatureDot temp={p.person.relationship_temp} />}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6}><EmptyState message="No places match those filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <PlaceDetail placeId={selected} onClose={() => setSelected(null)} onChanged={load} onDeleted={load} />
      )}

      {adding && (
        <PlaceModal
          categories={filters.categories}
          onClose={() => setAdding(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
