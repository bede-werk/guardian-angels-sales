import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, formatDate } from '../api';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PersonDetail from './PersonDetail';
import PersonModal from './PersonModal';
import PlaceDetail from './PlaceDetail';
import CategoriesModal from './CategoriesModal';
import SeedRelationshipsModal from './SeedRelationshipsModal';

// Searchable / filterable directory of every person across every place -
// the People counterpart to Places.jsx. Clicking any row opens that
// person's full detail (PersonDetail.jsx).
export default function People({ userId }) {
  const [filters, setFilters] = useState({ categories: [], allCategories: [] }); // category dropdown options, loaded once
  const [places, setPlaces] = useState([]); // every place, for the place filter + the Add Person picker
  const [q, setQ] = useState({ search: '', placeId: '', category: '', sort: '' });
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // person id whose detail modal is open, if any
  const [viewingPlaceId, setViewingPlaceId] = useState(null); // place id opened from a person's "View place" link
  const [adding, setAdding] = useState(false);
  const [managingCategories, setManagingCategories] = useState(false);
  const [seeding, setSeeding] = useState(false); // one-time relationship-seeding screen
  // Bumped on every load() call; a response only gets applied if it's still
  // the most recent request when it resolves - guards against a slower
  // earlier keystroke's response overwriting a faster later one.
  const requestIdRef = useRef(0);

  // Re-run via `refresh` (not just on mount) whenever a person/place
  // create/edit/delete could change these - otherwise a place renamed or
  // added while this tab stays mounted won't show up in the Place filter
  // or the Add Person picker until the tab unmounts and remounts.
  const loadReferenceData = useCallback(() => {
    api.filters().then(setFilters).catch(() => {});
    api.places({}).then(setPlaces).catch(() => {});
  }, []);

  useEffect(() => {
    loadReferenceData();
  }, [loadReferenceData]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.people.list(q);
      if (requestIdRef.current === requestId) setRows(data);
    } catch (e) {
      if (requestIdRef.current === requestId) setError(e.message);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [q]);

  // Debounce so typing in search doesn't hammer the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  // Refreshes both the row list and the reference data (filters/places) -
  // used after any create/edit/delete of a person or place.
  const refresh = useCallback(() => {
    load();
    loadReferenceData();
  }, [load, loadReferenceData]);

  const set = (k) => (e) => setQ((s) => ({ ...s, [k]: e.target.value }));

  // The category dropdown's last option is a sentinel that opens the manage-
  // categories modal instead of actually filtering - picking it never
  // touches q.category, so the select just reverts to showing whatever was
  // already selected once the modal closes.
  const MANAGE_CATEGORIES_OPTION = '__manage_categories__';
  const handleCategoryChange = (e) => {
    if (e.target.value === MANAGE_CATEGORIES_OPTION) { setManagingCategories(true); return; }
    setQ((s) => ({ ...s, category: e.target.value }));
  };

  // The "Last contacted" column shows whichever date the active sort is
  // actually ordering by - team-wide by default, or just this rep's own
  // visits when one of the "by me" sorts is picked, so the sort order and
  // the visible column never disagree.
  const sortingByMe = q.sort === 'my_last_contacted_desc' || q.sort === 'my_last_contacted_asc';

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      {/* Filter bar: search box + place/category dropdowns + sort. */}
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
              <select value={q.category} onChange={handleCategoryChange}>
                <option value="">All</option>
                <option value={MANAGE_CATEGORIES_OPTION}>Manage categories…</option>
                <option disabled>──────────</option>
                {filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="field">Sort by</label>
              <select value={q.sort} onChange={set('sort')}>
                <option value="">Name (A-Z)</option>
                <option value="last_contacted_desc">Last contacted (newest first)</option>
                <option value="last_contacted_asc">Last contacted (oldest/never first)</option>
                <option value="my_last_contacted_desc">Last contacted by me (newest first)</option>
                <option value="my_last_contacted_asc">Last contacted by me (oldest/never first)</option>
                <option value="referrals_desc">Referrals (most first)</option>
                <option value="referrals_asc">Referrals (fewest first)</option>
                <option value="last_referral_desc">Last referral (newest first)</option>
                <option value="last_referral_asc">Last referral (oldest/never first)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Results table. Each row is clickable and opens PersonDetail. */}
      <div className="card">
        <div className="card-head">
          <h2>{loading ? 'Loading…' : `${rows.length} people`}</h2>
          <div className="tag-list" style={{ flex: 'unset' }}>
            {/* Lives here rather than in the nav: it's an occasional
                (re-runnable) bulk task over exactly this list, not a place
                anyone needs to go day to day. */}
            <Button
              variant="secondary"
              size="small"
              title="Rate the relationships you already have, so scoring doesn't start from zero"
              onClick={() => setSeeding(true)}
            >
              Rate relationships
            </Button>
            <Button variant="secondary" size="small" title="Create a brand-new person" onClick={() => setAdding(true)}>+ Add person</Button>
          </div>
        </div>
        <div className="card-body table-scroll" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Place</th>
                <th>Referrals</th>
                <th>{sortingByMe ? 'Last contacted (you)' : 'Last contacted'}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} onClick={() => setSelected(p.id)}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.title && <div className="tiny muted">{p.title}</div>}
                  </td>
                  <td className="tiny">
                    {p.place_name ? (
                      <>{p.place_name}<br /><span className="muted">{p.place_region}</span></>
                    ) : (
                      <span className="muted">Unassigned</span>
                    )}
                  </td>
                  <td className="tiny">
                    {p.referral_metrics.lifetime_referrals > 0 ? (
                      <>
                        <strong style={{ color: 'var(--teal-dark)', fontSize: 16 }}>{p.referral_metrics.lifetime_referrals}</strong>
                        {' '}· last {formatDate(p.referral_metrics.last_referral_date)}
                      </>
                    ) : (
                      <span className="muted">None yet</span>
                    )}
                  </td>
                  <td className="tiny">
                    {(() => {
                      const date = sortingByMe ? p.my_last_visit_date : p.last_visit_date;
                      return date ? formatDate(date) : <span className="muted">-</span>;
                    })()}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={4}><EmptyState message="No people match those filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <PersonDetail
          personId={selected}
          userId={userId}
          onClose={() => setSelected(null)}
          onChanged={refresh}
          onDeleted={refresh}
          onOpenPlace={(placeId) => setViewingPlaceId(placeId)}
        />
      )}

      {viewingPlaceId && (
        <PlaceDetail placeId={viewingPlaceId} userId={userId} onClose={() => setViewingPlaceId(null)} onChanged={refresh} onDeleted={refresh} />
      )}

      {adding && (
        <PersonModal places={places} categories={filters.allCategories} onClose={() => setAdding(false)} onSaved={refresh} onCategoriesChanged={loadReferenceData} />
      )}

      {managingCategories && (
        <CategoriesModal onClose={() => setManagingCategories(false)} onChanged={loadReferenceData} />
      )}

      {seeding && (
        <SeedRelationshipsModal onClose={() => setSeeding(false)} onSaved={refresh} />
      )}
    </div>
  );
}
