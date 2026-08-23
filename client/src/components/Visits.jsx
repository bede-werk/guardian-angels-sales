import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, today, formatDate, VISIT_TYPE_LABELS, OUTCOME_LABELS, MET_WITH_LABELS } from '../api';
import { StatusChip } from './ui/Chip';
import { encounterSummary } from './VisitDetailModal';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import PlanVisitModal from './PlanVisitModal';
import VisitDetailModal from './VisitDetailModal';
import UpcomingVisitDetailModal from './UpcomingVisitDetailModal';
import ResolvedVisitDetailModal from './ResolvedVisitDetailModal';
import VisitLogModal from './VisitLogModal';
import PlaceDetail from './PlaceDetail';

// How many visits a "page" is - see the pagination comment on loadMore()
// below for why this is a growing LIMIT rather than real OFFSET paging.
const PAGE_SIZE = 50;

// The shape App.jsx lifts this tab's filter state into, for the same reason
// VisitsCalendar's `scope` is lifted (see App.jsx's own comment on
// calendarScope): this tab unmounts entirely on every tab switch (only the
// active tab is mounted - see App.jsx), so a plain local useState here would
// silently reset a hard-won filter set every time a rep tabbed away and
// back. Exported so App.jsx imports this shape rather than duplicating it.
export const DEFAULT_VISIT_FILTERS = {
  search: '',
  status: '',
  userId: '', // "Mine" toggle - a string (matches <select>'s value type), not the number api.visits.list expects
  from: '',
  to: '',
  sort: 'date_desc',
  visitType: '',
  outcome: '',
  metWith: '',
  category: '',
  tier: '',
  region: '',
  origin: '',
  plannedBy: '',
  theyRequested: false,
  madeCommitment: false,
  hasNotes: false,
};

// Local, same-shape helper as PlaceDetail.jsx's/UpcomingVisitDetailModal's
// own addDaysISO - built from local Date getters, never toISOString()
// (see api.js's today() comment: that rolls the date to tomorrow for the
// whole early-evening-through-midnight stretch in any timezone behind UTC,
// which is exactly the org's timezone).
function addDaysISO(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Each quick filter is a PATCH over just {status, from, to} - applying one
// always clears the other two's fields first (via the spread in the click
// handler below), so "Today" and "Skipped" can never silently combine into
// a confusing joint filter. `isActive` reads back the same three fields to
// decide whether to render as pressed.
const QUICK_FILTERS = [
  { key: 'today', label: 'Today', patch: () => ({ status: '', from: today(), to: today() }) },
  { key: 'week', label: 'This week', patch: () => ({ status: '', from: today(), to: addDaysISO(6) }) },
  // No date bound needed - the skip sweep (visitLifecycle.js) resolves any
  // lapsed 'planned' row to 'skipped' before this list is ever built, so a
  // still-'planned' visit is, by construction, always upcoming.
  { key: 'upcoming', label: 'Upcoming', patch: () => ({ status: 'planned', from: '', to: '' }) },
  // The recoverable-work bucket - ResolvedVisitDetailModal offers "Log this
  // visit" on every row here. Bounded to the last 30 days so ancient lapses
  // don't dominate; older ones are still reachable by clearing the date.
  { key: 'skipped', label: 'Skipped', patch: () => ({ status: 'skipped', from: addDaysISO(-30), to: '' }) },
  // This tab is the ONLY place in the app that can list a snoozed visit -
  // the Calendar tab deliberately drops them (see VisitsCalendar.jsx's own
  // comment): a snooze never moves scheduled_date, so there's no day on the
  // grid that's honestly "about" it.
  { key: 'snoozed', label: 'Snoozed', patch: () => ({ status: 'snoozed', from: '', to: '' }) },
];

function quickFilterActive(quick, filters) {
  const patch = quick.patch();
  return filters.status === patch.status && filters.from === patch.from && filters.to === patch.to;
}

// Turns the filter-state object into the query params api.visits.list
// expects. Boolean checkbox filters become the API's '1'/absent convention;
// api.visits.list itself drops every '' /null/undefined entry, so an unset
// text/select filter needs no special-casing here.
function buildParams(filters, limit) {
  return {
    ...filters,
    theyRequested: filters.theyRequested ? '1' : undefined,
    madeCommitment: filters.madeCommitment ? '1' : undefined,
    hasNotes: filters.hasNotes ? '1' : undefined,
    limit,
    offset: 0,
  };
}

const SORT_OPTIONS = [
  { value: 'date_desc', label: 'Date (newest first)' },
  { value: 'date_asc', label: 'Date (oldest first)' },
  { value: 'place_asc', label: 'Place (A-Z)' },
  { value: 'rep', label: 'Rep (A-Z)' },
  { value: 'status', label: 'Status' },
];

const ORIGIN_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'manual', label: 'Planned manually' },
  { value: 'planner', label: 'From route planner' },
];

// Truncates a notes preview for the table cell - the full text is always
// available via the native `title` tooltip, same "truncate the cell, keep
// the whole thing one hover away" convention as Places.jsx's region column.
function truncate(text, max) {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// The Visits tab: every visit ever recorded, searchable/filterable/
// paginated (server/src/routes/visits.js's GET /), plus the same plan/log/
// edit/snooze/delete actions every other visit surface in the app already
// offers - this tab is a LENS onto existing data and existing mutation
// flows, not a new way to mutate one. Row-click opens whichever detail
// modal matches that row's status, exactly as VisitsCalendar's day
// drill-downs already do; the permission rules for what each modal's
// buttons can attempt are enforced server-side (see manualVisits.js's
// canEditManualVisit/canDeleteManualVisit and the visits.js route handlers
// themselves) - this tab offers the same buttons unconditionally and lets a
// denial surface as the modal's own inline error or a window.alert, exactly
// like VisitsCalendar.jsx/Dashboard.jsx already do. Duplicating that
// permission matrix here as a second, client-side copy would be exactly the
// kind of drift this codebase's services avoid elsewhere.
export default function Visits({ userId, onNavigateToPlanner, filters, onFiltersChange }) {
  const [visits, setVisits] = useState([]); // never reset to [] on a refetch - see load() below
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null); // null until the first response - see the summary strip's own guard
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showMoreFilters, setShowMoreFilters] = useState(false);

  const [users, setUsers] = useState([]);
  const [placeFilters, setPlaceFilters] = useState({ categories: [], regions: [], tiers: [] });

  const [planningVisit, setPlanningVisit] = useState(false);

  // Which modal is open, one at a time, matching whichever status the
  // clicked row had.
  const [viewingCompleted, setViewingCompleted] = useState(null);
  const [viewingUpcoming, setViewingUpcoming] = useState(null);
  const [viewingResolved, setViewingResolved] = useState(null); // skipped or snoozed
  const [editingVisit, setEditingVisit] = useState(null); // handed to VisitLogModal by any of the three above
  const [viewingPlaceId, setViewingPlaceId] = useState(null);

  // Bumped on every load() call; a response only applies if it's still the
  // newest in flight - same stale-response guard as Places.jsx's own
  // requestIdRef, needed here for the same reason (a slow early keystroke's
  // response must not overwrite a fast later one).
  const requestIdRef = useRef(0);
  // How many PAGE_SIZE-chunks are currently on screen. "Load more" grows
  // this and re-requests with a bigger LIMIT (offset always 0) rather than
  // asking for the next OFFSET window - so a refresh after a mutation (see
  // refresh() below) can re-fetch everything already loaded, in one request,
  // without the scroll position snapping back to the top the way resetting
  // to page 1 would.
  const pagesLoadedRef = useRef(1);

  useEffect(() => {
    api.users.list().then(setUsers).catch(() => {});
    api.filters().then(setPlaceFilters).catch(() => {});
  }, []);

  const load = useCallback(async (limit) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.visits.list(buildParams(filters, limit));
      if (requestIdRef.current !== requestId) return; // a newer request already won
      setVisits(data.visits);
      setTotal(data.total);
      setSummary(data.summary);
    } catch (e) {
      if (requestIdRef.current === requestId) setError(e.message);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [filters]);

  // Debounced re-load on any filter/sort change (200ms, same as
  // Places.jsx) - and ALWAYS resets pagination back to one page. Without
  // that reset, changing a filter while three pages were loaded would ask
  // for 150 rows matching the NEW filter, which is a harmless over-fetch,
  // but "Showing X of Y" would read strangely against a total that just
  // shrank - resetting keeps the page-size math honest after every change.
  useEffect(() => {
    pagesLoadedRef.current = 1;
    const t = setTimeout(() => load(PAGE_SIZE), 200);
    return () => clearTimeout(t);
  }, [filters, load]);

  function loadMore() {
    pagesLoadedRef.current += 1;
    load(PAGE_SIZE * pagesLoadedRef.current);
  }

  // Called after any mutation (plan/log/edit/snooze/delete) - re-fetches
  // exactly what's currently on screen (see pagesLoadedRef's comment above)
  // rather than resetting to page 1.
  const refresh = useCallback(() => load(PAGE_SIZE * pagesLoadedRef.current), [load]);

  // If a mutation moved the open modal's row out of the current filter
  // (completing a visit while filtered to status=planned, editing a date
  // out of the current from/to range, ...), close it rather than leave it
  // open over a row that's no longer in `visits` - same pattern
  // VisitsCalendar.jsx's own completedDate effect uses. Keyed off `visits`
  // itself (not `filters`), so this only fires after an actual refetch
  // replaces the array - never on the same render a modal was just opened
  // from a row already known to be in it.
  useEffect(() => {
    if (viewingCompleted && !visits.some((v) => v.id === viewingCompleted.id)) setViewingCompleted(null);
    if (viewingUpcoming && !visits.some((v) => v.id === viewingUpcoming.id)) setViewingUpcoming(null);
    if (viewingResolved && !visits.some((v) => v.id === viewingResolved.id)) setViewingResolved(null);
  }, [visits]); // eslint-disable-line react-hooks/exhaustive-deps

  function set(key) {
    return (e) => onFiltersChange({ ...filters, [key]: e.target.value });
  }
  function setChecked(key) {
    return (e) => onFiltersChange({ ...filters, [key]: e.target.checked });
  }

  function toggleQuickFilter(quick) {
    onFiltersChange({ ...filters, ...(quickFilterActive(quick, filters) ? { status: '', from: '', to: '' } : quick.patch()) });
  }

  function toggleMine() {
    const mine = String(userId);
    onFiltersChange({ ...filters, userId: filters.userId === mine ? '' : mine });
  }

  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_VISIT_FILTERS);

  function openRow(v) {
    if (v.status === 'completed') setViewingCompleted(v);
    else if (v.status === 'planned') setViewingUpcoming(v);
    else setViewingResolved(v); // skipped or snoozed
  }

  // Same confirm+delete+reload shape as Dashboard.jsx's removeViewingVisit /
  // VisitsCalendar.jsx's removeVisit - a delete the server may still reject
  // (e.g. not the assignee) surfaces as a plain alert, same as those two.
  async function deleteVisit(visit, closeFn) {
    if (!window.confirm("Delete this visit? This can't be undone.")) return;
    try {
      await api.deleteVisit(visit.id);
      closeFn(null);
      refresh();
    } catch (e) {
      window.alert(e.message);
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      {error && <div className="error-banner">{error}</div>}

      {/* Quick filters - one click sets several fields at once. Clicking an
          already-active one clears back to no date/status filter; "Mine" is
          an independent toggle (composable with any of the others) since it
          filters on a different field (userId) entirely. */}
      <div className="card">
        <div className="card-body">
          <div className="tag-list">
            {QUICK_FILTERS.map((q) => (
              <Button
                key={q.key}
                variant={quickFilterActive(q, filters) ? 'secondary' : 'ghost'}
                size="small"
                onClick={() => toggleQuickFilter(q)}
              >
                {q.label}
              </Button>
            ))}
            <Button variant={filters.userId === String(userId) ? 'secondary' : 'ghost'} size="small" onClick={toggleMine}>
              Mine
            </Button>
            {!isDefault && (
              <Button variant="ghost" size="small" style={{ marginLeft: 'auto' }} onClick={() => onFiltersChange(DEFAULT_VISIT_FILTERS)}>
                Clear all
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Filter bar. */}
      <div className="card">
        <div className="card-body stack">
          <div className="row">
            <div style={{ flex: 2 }}>
              <label className="field">Search</label>
              <input placeholder="Place, notes, who was met…" value={filters.search} onChange={set('search')} />
            </div>
            <div>
              {/* Single-select even though the API accepts a comma list -
                  the UI has no use for "planned OR skipped" today, and the
                  quick-filter chips above already cover the common
                  combinations. */}
              <label className="field">Status</label>
              <select value={filters.status} onChange={set('status')}>
                <option value="">All</option>
                <option value="planned">Planned</option>
                <option value="completed">Completed</option>
                <option value="skipped">Skipped</option>
                <option value="snoozed">Snoozed</option>
              </select>
            </div>
            <div>
              <label className="field">Rep</label>
              <select value={filters.userId} onChange={set('userId')}>
                <option value="">All</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div>
              <label className="field">From</label>
              <input type="date" value={filters.from} onChange={set('from')} />
            </div>
            <div>
              <label className="field">To</label>
              <input type="date" value={filters.to} onChange={set('to')} />
            </div>
            <div>
              <label className="field">Sort by</label>
              <select value={filters.sort} onChange={set('sort')}>
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          {showMoreFilters && (
            <div className="row">
              <div>
                <label className="field">Visit type</label>
                <select value={filters.visitType} onChange={set('visitType')}>
                  <option value="">Any</option>
                  {Object.entries(VISIT_TYPE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Outcome</label>
                <select value={filters.outcome} onChange={set('outcome')}>
                  <option value="">Any</option>
                  {Object.entries(OUTCOME_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Met with</label>
                <select value={filters.metWith} onChange={set('metWith')}>
                  <option value="">Any</option>
                  {Object.entries(MET_WITH_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Category</label>
                <select value={filters.category} onChange={set('category')}>
                  <option value="">Any</option>
                  {placeFilters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Tier</label>
                <select value={filters.tier} onChange={set('tier')}>
                  <option value="">Any</option>
                  {placeFilters.tiers.map((t) => <option key={t} value={t}>Tier {t}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Region</label>
                <select value={filters.region} onChange={set('region')}>
                  <option value="">Any</option>
                  {placeFilters.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Origin</label>
                <select value={filters.origin} onChange={set('origin')}>
                  {ORIGIN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="field">Planned by</label>
                <select value={filters.plannedBy} onChange={set('plannedBy')}>
                  <option value="">Anyone</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            </div>
          )}

          {showMoreFilters && (
            <div className="tag-list">
              <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={filters.theyRequested} onChange={setChecked('theyRequested')} />
                They asked for something
              </label>
              <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={filters.madeCommitment} onChange={setChecked('madeCommitment')} />
                Made a commitment
              </label>
              <label className="tiny" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input type="checkbox" checked={filters.hasNotes} onChange={setChecked('hasNotes')} />
                Has notes
              </label>
            </div>
          )}

          <Button variant="ghost" size="small" style={{ alignSelf: 'flex-start' }} onClick={() => setShowMoreFilters((s) => !s)}>
            {showMoreFilters ? 'Fewer filters ▴' : 'More filters ▾'}
          </Button>
        </div>
      </div>

      {/* Summary strip - deliberately ignores the status filter (see
          server/src/services/visitQuery.js's summarizeVisits) so the four
          counts stay a stable segmented control: clicking "Skipped" narrows
          the table below without the OTHER three numbers changing out from
          under the click. Hidden entirely until the first response lands,
          rather than flashing zeros. */}
      {summary && (
        <div className="card">
          <div className="card-body">
            <div className="tag-list" style={{ alignItems: 'center' }}>
              <span className="tiny muted" style={{ marginRight: 8 }}>Across all statuses matching these filters:</span>
              {['planned', 'completed', 'skipped', 'snoozed'].map((s) => (
                <button
                  key={s}
                  type="button"
                  className="link-button tiny"
                  onClick={() => onFiltersChange({ ...filters, status: filters.status === s ? '' : s })}
                >
                  <strong>{summary[s]}</strong> {s}
                </button>
              ))}
              <span className="tiny muted">· <strong>{summary.places}</strong> places touched</span>
            </div>
          </div>
        </div>
      )}

      {/* Results table. */}
      <div className="card">
        <div className="card-head">
          <h2>{loading && visits.length === 0 ? 'Loading…' : `${total} visit${total === 1 ? '' : 's'}`}</h2>
          <div className="tag-list" style={{ flex: 'unset' }}>
            <Button
              variant="secondary"
              size="small"
              title="Schedule a future visit directly, without the route planner"
              onClick={() => setPlanningVisit(true)}
            >
              + Plan a visit
            </Button>
            <Button
              size="small"
              title="Plan an entire day's route in the Route Planner"
              onClick={onNavigateToPlanner}
            >
              Plan a whole day →
            </Button>
          </div>
        </div>
        <div className="card-body table-scroll" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th>Place</th>
                <th>Type</th>
                <th>Rep</th>
                <th>Who was met</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.id} className="hover-row" onClick={() => openRow(v)}>
                  <td className="tiny"><strong>{formatDate(v.scheduled_date)}</strong></td>
                  <td><StatusChip status={v.status} /></td>
                  <td className="tiny">
                    {v.place_name || 'Unknown place'}
                    {/* detach-not-delete: a visit outlives its place. See
                        this file's header comment on why the filter bar's
                        category/tier/region excludes rows like this one. */}
                    {v.place_id == null && <span className="muted"> (place deleted)</span>}
                  </td>
                  <td className="tiny">{VISIT_TYPE_LABELS[v.visit_type] || <span className="muted">—</span>}</td>
                  <td className="tiny">
                    {v.user_name || <span className="muted">Unassigned</span>}
                    {v.created_by_user_id != null && v.created_by_user_id !== v.user_id && (
                      <span className="muted"> · planned by {v.created_by_name || 'another rep'}</span>
                    )}
                  </td>
                  <td className="tiny">{encounterSummary(v.encounters) || <span className="muted">—</span>}</td>
                  <td className="tiny" title={v.notes || undefined}>{truncate(v.notes, 60) || <span className="muted">—</span>}</td>
                  <td className="tiny" onClick={(e) => e.stopPropagation()}>
                    {v.place_id != null && (
                      <Button variant="ghost" size="small" title="View this place's details" onClick={() => setViewingPlaceId(v.place_id)}>
                        View place
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && visits.length === 0 && (
                <tr><td colSpan={8}><EmptyState message="No visits match those filters." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
        {visits.length < total && (
          <div className="card-body" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="tiny muted">Showing {visits.length} of {total}</span>
            <Button variant="secondary" size="small" onClick={loadMore} disabled={loading}>Load 50 more</Button>
          </div>
        )}
      </div>

      {planningVisit && (
        <PlanVisitModal
          userId={userId}
          users={users}
          onClose={() => setPlanningVisit(false)}
          onSaved={() => { setPlanningVisit(false); refresh(); }}
        />
      )}

      {viewingCompleted && (
        <VisitDetailModal
          visit={viewingCompleted}
          onClose={() => setViewingCompleted(null)}
          onEdit={(v) => {
            // Same "rewriting someone else's history" confirm as
            // VisitsCalendar.jsx's own VisitDetailModal wiring - this only
            // guards EDITING an already-completed record; logging/covering a
            // still-open visit under a teammate's account (below) needs no
            // such confirm (see routes/visits.js's PATCH comment: that's a
            // normal case, not a mistake to prevent).
            if (v.user_id != null && v.user_id !== userId && !window.confirm("This visit is logged under a different rep's account. Edit it anyway?")) return;
            setViewingCompleted(null);
            setEditingVisit(v);
          }}
          onDelete={(v) => deleteVisit(v, setViewingCompleted)}
          onChanged={refresh}
        />
      )}

      {viewingUpcoming && (
        <UpcomingVisitDetailModal
          visit={viewingUpcoming}
          userId={userId}
          onClose={() => setViewingUpcoming(null)}
          onComplete={(v) => { setViewingUpcoming(null); setEditingVisit(v); }}
          onSnoozed={() => { setViewingUpcoming(null); refresh(); }}
          onEdited={() => { setViewingUpcoming(null); refresh(); }}
          onDelete={(v) => deleteVisit(v, setViewingUpcoming)}
        />
      )}

      {viewingResolved && (
        <ResolvedVisitDetailModal
          visit={viewingResolved}
          onClose={() => setViewingResolved(null)}
          onComplete={(v) => { setViewingResolved(null); setEditingVisit(v); }}
        />
      )}

      {editingVisit && (
        <VisitLogModal
          visit={{ ...editingVisit, visit_id: editingVisit.id }}
          userId={userId}
          onClose={() => setEditingVisit(null)}
          onSaved={() => { setEditingVisit(null); refresh(); }}
        />
      )}

      {viewingPlaceId && (
        <PlaceDetail placeId={viewingPlaceId} userId={userId} onClose={() => setViewingPlaceId(null)} onChanged={refresh} onDeleted={refresh} />
      )}
    </div>
  );
}
