import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import TemperatureDot from './ui/TemperatureDot';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PartnerDetail from './PartnerDetail';

// Searchable / filterable partner directory with last-visit + contact info.
export default function Partners() {
  const [filters, setFilters] = useState({ categories: [], cities: [], zips: [], tiers: [] });
  const [q, setQ] = useState({ search: '', category: '', tier: '', city: '', zip: '', neverVisited: '' });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.filters().then(setFilters).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await api.partners(q));
    } finally {
      setLoading(false);
    }
  }, [q]);

  // Debounce so typing in search doesn't hammer the API.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const set = (k) => (e) => setQ((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="grid" style={{ gap: 16 }}>
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

      <div className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : `${rows.length} partners`}</h2>
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
                    {p.contact ? (
                      <div className="stack">
                        <span>{p.contact.name}</span>
                        {p.contact.relationship_temp && <TemperatureDot temp={p.contact.relationship_temp} />}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={6}><EmptyState message="No partners match those filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <PartnerDetail partnerId={selected} onClose={() => setSelected(null)} onChanged={load} />
      )}
    </div>
  );
}
