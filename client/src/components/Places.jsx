import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, formatDate } from '../api';
import { TierChip, CategoryChip } from './ui/Chip';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PlaceDetail from './PlaceDetail';
import PlaceModal from './PlaceModal';
import CategoriesModal from './CategoriesModal';

// Searchable / filterable place directory with last-visit + contact info.
// Clicking any row opens that place's full detail (PlaceDetail.jsx).
export default function Places({ userId }) {
  const [filters, setFilters] = useState({ categories: [], allCategories: [], regions: [], tiers: [] }); // dropdown options, loaded once
  const [q, setQ] = useState({ search: '', category: '', tier: '', region: '', sort: '' }); // current filter values
  const [rows, setRows] = useState([]); // the filtered place list from the API
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // place id whose detail modal is open, if any
  const [adding, setAdding] = useState(false); // whether the Add Place modal is open
  const [managingCategories, setManagingCategories] = useState(false);
  // Bumped on every load() call; a response only gets applied if it's still
  // the most recent request when it resolves — guards against a slower
  // earlier keystroke's response overwriting a faster later one.
  const requestIdRef = useRef(0);

  // Load the filter dropdown options (distinct categories/tiers/regions).
  // Re-run via `refresh` (not just on mount) whenever a place create/edit/
  // delete could have introduced or removed a region — otherwise a value
  // added while this tab stays mounted won't show up in the dropdown until
  // the tab unmounts and remounts (e.g. by navigating away and back).
  const loadFilters = useCallback(() => {
    api.filters().then(setFilters).catch(() => {});
  }, []);

  useEffect(() => {
    loadFilters();
  }, [loadFilters]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.places(q);
      if (requestIdRef.current === requestId) setRows(data);
    } catch (e) {
      if (requestIdRef.current === requestId) setError(e.message);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [q]);

  // Debounce so typing in search doesn't hammer the API on every keystroke —
  // waits 200ms after the last change to `q` before actually fetching.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Refreshes both the row list and the filter dropdown options — used after
  // any create/edit/delete, since either can change what regions exist.
  const refresh = useCallback(() => {
    load();
    loadFilters();
  }, [load, loadFilters]);

  // Shorthand for wiring an <input>/<select> straight into the `q` filter state.
  const set = (k) => (e) => setQ((s) => ({ ...s, [k]: e.target.value }));

  // The category dropdown's last option is a sentinel that opens the manage-
  // categories modal instead of actually filtering — picking it never
  // touches q.category, so the select just reverts to showing whatever was
  // already selected once the modal closes.
  const MANAGE_CATEGORIES_OPTION = '__manage_categories__';
  const handleCategoryChange = (e) => {
    if (e.target.value === MANAGE_CATEGORIES_OPTION) { setManagingCategories(true); return; }
    setQ((s) => ({ ...s, category: e.target.value }));
  };

  // The "Last visit" column shows whichever date the active sort is actually
  // ordering by — team-wide by default, or just this rep's own visits when
  // one of the "by me" sorts is picked, so the sort order and the visible
  // column never disagree. Same logic as People.jsx's sortingByMe.
  const sortingByMe = q.sort === 'my_last_visited_desc' || q.sort === 'my_last_visited_asc';

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      {/* Filter bar: search box + category/tier/region dropdowns + sort. */}
      <div className="card">
        <div className="card-body">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field">Search</label>
              <input placeholder="Name, address, category…" value={q.search} onChange={set('search')} />
            </div>
            <div>
              <label className="field">Category</label>
              <select value={q.category} onChange={handleCategoryChange}>
                <option value="">All</option>
                <option value={MANAGE_CATEGORIES_OPTION}>Manage categories…</option>
                <option disabled>──────────</option>
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
              <label className="field">Region</label>
              <select value={q.region} onChange={set('region')}>
                <option value="">All</option>
                {filters.regions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Sort by</label>
              <select value={q.sort} onChange={set('sort')}>
                <option value="">Name (A-Z)</option>
                <option value="last_visited_desc">Last visited (newest first)</option>
                <option value="last_visited_asc">Last visited (oldest/never first)</option>
                <option value="my_last_visited_desc">Last visited by me (newest first)</option>
                <option value="my_last_visited_asc">Last visited by me (oldest/never first)</option>
                <option value="referrals_desc">Referrals (most first)</option>
                <option value="referrals_asc">Referrals (fewest first)</option>
                <option value="last_referral_desc">Last referral (newest first)</option>
                <option value="last_referral_asc">Last referral (oldest/never first)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Results table. Each row is clickable and opens PlaceDetail. */}
      <div className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : `${rows.length} places`}</h2>
          <Button variant="secondary" size="small" title="Create a brand-new place" onClick={() => setAdding(true)}>+ Add place</Button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Organization</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Region</th>
                <th>{sortingByMe ? 'Last visit (you)' : 'Last visit'}</th>
                <th>Referrals</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => setSelected(p.id)}>
                  <td><strong>{p.name}</strong></td>
                  <td><CategoryChip category={p.category} /></td>
                  <td><TierChip tier={p.tier} isPriority={p.is_priority} /></td>
                  <td className="muted tiny">{p.region}</td>
                  <td className="tiny">
                    {(() => {
                      const date = sortingByMe ? p.my_last_visit_date : p.last_visit_date;
                      return date ? formatDate(date) : <span className="muted">—</span>;
                    })()}
                  </td>
                  <td className="tiny">
                    {p.referral_metrics.lifetime_referrals > 0 ? (
                      <strong style={{ color: 'var(--teal-dark)', fontSize: 16 }}>{p.referral_metrics.lifetime_referrals}</strong>
                    ) : (
                      <span className="muted">None yet</span>
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
        <PlaceDetail placeId={selected} userId={userId} onClose={() => setSelected(null)} onChanged={refresh} onDeleted={refresh} />
      )}

      {adding && (
        <PlaceModal
          categories={filters.allCategories}
          onClose={() => setAdding(false)}
          onSaved={refresh}
        />
      )}

      {managingCategories && (
        <CategoriesModal onClose={() => setManagingCategories(false)} onChanged={loadFilters} />
      )}
    </div>
  );
}
