import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDate } from '../api';
import { getCurrentPosition } from '../geolocation';
import MonthCalendar from './ui/MonthCalendar';
import CalendarDayModal from './CalendarDayModal';
import PlannedDayModal from './PlannedDayModal';
import DayOverflowModal from './DayOverflowModal';
import PlaceDetail from './PlaceDetail';
import VisitLogModal from './VisitLogModal';
import VisitDetailModal from './VisitDetailModal';

// "YYYY-MM" for a given Date, computed off its local year/month fields —
// never .toISOString() (see the module-level warning below and
// ui/MonthCalendar.jsx's own toISODate), which would round-trip through UTC
// and can land on the wrong month near a local midnight.
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// A day is never clickable as a whole (see ui/MonthCalendar.jsx) — instead
// each day cell splits its visits into independently-clickable pieces. Three
// possible buckets per visit: a rep's still-open planned route
// (plannedGroups, one group per rep — own group opens PlannedDayModal, the
// exact same component/read-as-you're-used-to-it-in-Route-Planner view;
// every other rep's group opens CalendarDayModal instead), completed visits
// (completedVisits — any rep, opens CalendarDayModal filtered to just
// those), and skipped visits (otherVisits — the one status left once
// planned/completed are both accounted for above — also CalendarDayModal).
// Planned and completed are kept strictly separate buckets by design: a
// visit only ever moves from one to the other by its own `status` actually
// changing (e.g. logging a planned visit marks that same row completed —
// see VisitLogModal), never by any special-casing here — the next load()
// just re-buckets it based on whatever status is now on the row.
//
// One further pass turns plannedGroups/completedVisits into a flat, capped
// list of "pills" for the cell to actually render — see buildDayPills/
// splitPillsForDay below.
function splitDayVisits(dayVisits, userId) {
  const plannedByUser = new Map(); // user_id -> { userId, repName, visits }
  const completedVisits = [];
  const otherVisits = [];
  for (const v of dayVisits) {
    if (v.status === 'planned') {
      let group = plannedByUser.get(v.user_id);
      if (!group) {
        group = { userId: v.user_id, repName: v.rep_name, visits: [] };
        plannedByUser.set(v.user_id, group);
      }
      group.visits.push(v);
    } else if (v.status === 'completed') completedVisits.push(v);
    else otherVisits.push(v);
  }
  // Own group always first, then everyone else alphabetically by name.
  const plannedGroups = [...plannedByUser.values()].sort((a, b) => {
    if (a.userId === userId) return -1;
    if (b.userId === userId) return 1;
    return (a.repName || '').localeCompare(b.repName || '');
  });
  return { plannedGroups, completedVisits, otherVisits };
}

// A day cell's pill badges, in priority order: your own planned route (if
// any), then completed visits (if any), then every other rep's planned
// route alphabetically. Used both to decide what's visible in the cell and
// what's listed in the "+N more" overflow modal — same order either way, so
// a pill never seems to jump around between the two.
function buildDayPills(dayVisits, userId) {
  const { plannedGroups, completedVisits } = splitDayVisits(dayVisits, userId);
  const mineGroup = plannedGroups.find((g) => g.userId === userId);
  const otherGroups = plannedGroups.filter((g) => g.userId !== userId);
  const pills = [];
  if (mineGroup) {
    pills.push({ key: `planned-${mineGroup.userId}`, kind: 'planned', group: mineGroup, label: 'My Planned Route' });
  }
  if (completedVisits.length > 0) {
    pills.push({ key: 'completed', kind: 'completed', label: 'Completed Visits' });
  }
  otherGroups.forEach((g) => {
    pills.push({ key: `planned-${g.userId}`, kind: 'planned', group: g, label: `${g.repName || 'Unknown rep'}'s Planned Route` });
  });
  return pills;
}

// However many reps have a route (or completed visits) on a given day, the
// cell itself never grows to fit them — see the grid-track/badge overflow
// rules in styles.css. Past MAX_VISIBLE_PILLS, the rest collapse into a
// single "+N more" chip (DayOverflowModal) instead.
const MAX_VISIBLE_PILLS = 3;

function splitPillsForDay(dayVisits, userId) {
  const pills = buildDayPills(dayVisits, userId);
  const visibleCount = pills.length > MAX_VISIBLE_PILLS ? MAX_VISIBLE_PILLS - 1 : pills.length;
  return { visible: pills.slice(0, visibleCount), overflow: pills.slice(visibleCount) };
}

// The "+N more" chip opens an enlarged view of the *whole* day, not just the
// overflowed pills — so unlike buildDayPills (cell-only), this also folds in
// a "Skipped Visits" pill when there are any, matching the day cell's own
// separate skipped-dot indicator but as a full pill here since there's a
// whole modal to spend on it instead of a ~64px cell.
function buildFullDayPills(dayVisits, userId) {
  const { otherVisits } = splitDayVisits(dayVisits, userId);
  const pills = buildDayPills(dayVisits, userId);
  if (otherVisits.length > 0) {
    pills.push({ key: 'skipped', kind: 'skipped', label: 'Skipped Visits' });
  }
  return pills;
}

// The Calendar tab: a full month grid (ui/MonthCalendar.jsx, generic/
// unbounded) fed by GET /api/visits/calendar, plus its day drill-downs
// (PlannedDayModal for your own planned route; CalendarDayModal for
// everything else — another rep's planned route, completed visits, skipped
// visits) and the usual place/visit modals layered on top of those. This component
// owns every "which modal is open" flag for that whole stack, same division
// of responsibility PlaceDetail uses for its own nested PersonDetail/
// VisitDetailModal/VisitLogModal popups.
//
// Visits are grouped into `byDate` keyed by their raw `scheduled_date`
// string exactly as the API returns it (e.g. "2026-07-14") — never routed
// through `new Date(...).toISOString()`, which shifts near midnight in
// timezones behind UTC and would misfile a visit onto the wrong day. Both
// this map's keys and MonthCalendar's `iso` callback argument are already
// local Y-M-D strings, so a plain string compare is all that's needed.
// `scope`/`onScopeChange` are lifted up to App.jsx rather than owned here —
// this component unmounts entirely on every tab switch (see App.jsx), so a
// plain local useState would silently reset back to "Mine" each time you
// left and returned to this tab. Living in App.jsx instead lets it survive
// that remount; App.jsx explicitly resets it back to 'mine' on logout, so a
// fresh session always starts on your own calendar.
export default function VisitsCalendar({ userId, onNavigateToPlanner, scope, onScopeChange }) {
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [visits, setVisits] = useState(null); // flat rows from the API, or null before the first load resolves
  const [users, setUsers] = useState([]); // every team member, fetched once — for rep lookups if a row's own rep_name snapshot is ever missing
  const [selectedDate, setSelectedDate] = useState(null); // iso string driving CalendarDayModal (otherVisits), or null
  const [completedDate, setCompletedDate] = useState(null); // iso string driving CalendarDayModal (completedVisits), or null
  const [plannedRouteView, setPlannedRouteView] = useState(null); // { date, group } driving the planned-route modal (own or another rep's), or null
  const [overflowAnchor, setOverflowAnchor] = useState(null); // { date, el } driving the "+N more" popover (DayOverflowModal) — `el` is the whole day cell, so the popover can land right on top of it — or null
  const [error, setError] = useState(null); // blocks the whole tab — only for the month load itself
  const [actionError, setActionError] = useState(null); // inline banner — edit/delete-day failures, doesn't blow away the grid/modal

  // The three "modal on top of the day modal" flags — mirrors PlaceDetail's
  // own viewingVisit/editingVisit pattern.
  const [viewingPlaceId, setViewingPlaceId] = useState(null);
  const [loggingVisit, setLoggingVisit] = useState(null); // planned visit being turned into a completed one via VisitLogModal
  const [viewingVisit, setViewingVisit] = useState(null); // completed/skipped visit open in VisitDetailModal
  const [editingVisit, setEditingVisit] = useState(null); // visit open in VisitLogModal from VisitDetailModal's Edit

  // Mirrors RoutePlanner.jsx's own reopenDay/deleteCommittedDay busy-state
  // flags — PlannedDayModal's Edit/Delete buttons expect the same shape.
  const [reopeningDate, setReopeningDate] = useState(null);
  const [deletingPlannedDate, setDeletingPlannedDate] = useState(null);

  useEffect(() => {
    api.users.list().then(setUsers).catch(() => {});
  }, []);

  const monthKey = monthKeyOf(monthCursor);

  // The popover is anchored to a specific chip button in the grid — changing
  // months re-renders the whole grid (that button included), so close it
  // rather than leave it floating over a now-different month with a stale
  // anchor.
  useEffect(() => {
    setOverflowAnchor(null);
  }, [monthKey]);

  // No setVisits(null) here on purpose — same shape as Dashboard.jsx's own
  // load(): after the first successful load, later month/scope changes just
  // replace `visits` in place rather than flashing the whole tab back to the
  // loading screen.
  const load = useCallback(() => {
    setError(null);
    api.visitsCalendar(monthKey, scope === 'mine' ? userId : undefined)
      .then(setVisits)
      .catch((e) => setError(e.message));
  }, [monthKey, scope, userId]);

  useEffect(() => {
    load();
  }, [load]);

  const byDate = useMemo(() => {
    const m = new Map();
    (visits || []).forEach((v) => {
      const list = m.get(v.scheduled_date);
      if (list) list.push(v);
      else m.set(v.scheduled_date, [v]);
    });
    return m;
  }, [visits]);

  // A pill's own action — same target whether it's clicked directly off the
  // day cell or picked out of DayOverflowModal's enlarged view.
  function openPill(pill, iso) {
    if (pill.kind === 'completed') setCompletedDate(iso);
    else if (pill.kind === 'skipped') setSelectedDate(iso);
    else setPlannedRouteView({ date: iso, group: pill.group });
  }

  // The day number itself is always clickable — same DayOverflowModal the
  // "+N more" chip opens, just with every pill for the day (buildFullDayPills)
  // rather than only the overflow, and with no chip needed to get there.
  // Works even on an empty day (an empty pills list, handled by
  // DayOverflowModal's own empty state) so every day gets the same "open it
  // up for a closer look" affordance.
  function renderDayNum(dateObj, iso) {
    return (
      <button
        type="button"
        className="month-calendar-daynum"
        title={`View everything on ${formatDate(iso)}`}
        onClick={(e) => setOverflowAnchor({ date: iso, el: e.currentTarget.closest('.month-calendar-day') })}
      >
        {dateObj.getDate()}
      </button>
    );
  }

  function renderDay(dateObj, iso) {
    const dayVisits = byDate.get(iso) || [];
    if (dayVisits.length === 0) {
      return renderDayNum(dateObj, iso);
    }
    const { otherVisits } = splitDayVisits(dayVisits, userId);
    const { visible, overflow } = splitPillsForDay(dayVisits, userId);
    return (
      <>
        {renderDayNum(dateObj, iso)}
        {visible.map((pill) => (
          <button
            key={pill.key}
            type="button"
            className={pill.kind === 'completed' ? 'completed-visits-badge' : 'planned-route-badge'}
            title={`View ${pill.label} for this day`}
            onClick={() => openPill(pill, iso)}
          >
            {pill.label}
          </button>
        ))}
        {overflow.length > 0 && (
          <button
            type="button"
            className="pill-overflow-badge"
            title={`View ${overflow.length} more for this day`}
            onClick={(e) => setOverflowAnchor({ date: iso, el: e.currentTarget.closest('.month-calendar-day') })}
          >
            +{overflow.length} more
          </button>
        )}
        {otherVisits.length > 0 && (
          <button
            type="button"
            className="day-dots clickable"
            title="View this day's skipped visits"
            onClick={() => setSelectedDate(iso)}
          >
            <span className="day-dot skipped" />
          </button>
        )}
      </>
    );
  }

  // Shared by the visit-detail popup's Delete action — same shape as
  // PlaceDetail.jsx/PersonDetail.jsx's own removeVisit.
  async function removeVisit(visit) {
    if (!window.confirm("Delete this visit? This can't be undone.")) return;
    try {
      await api.deleteVisit(visit.id);
      load();
    } catch (e) {
      window.alert(e.message);
    }
  }

  // Pulls a committed day's visits back out into an editable route-planner
  // draft — same endpoint and auto-locate-if-no-starting-point behavior as
  // RoutePlanner.jsx's own reopenDay (this tab has no draft workspace of its
  // own to show the result in, so a successful reopen hands off to the
  // Route Planner tab via onNavigateToPlanner instead of rendering anything
  // here itself).
  async function reopenPlannedDay(date) {
    if (!window.confirm(`Edit the planned visits for ${formatDate(date)}? They'll temporarily show as not-yet-scheduled while you make changes — accept the updated proposal again when you're done.`)) return false;
    setActionError(null);
    setReopeningDate(date);
    try {
      const loc = await getCurrentPosition();
      await api.scheduleDrafts.reopenDay(date, { lat: loc.lat, lng: loc.lng });
      return true;
    } catch (e) {
      setActionError(e.message);
      return false;
    } finally {
      setReopeningDate(null);
    }
  }

  // Same endpoint/confirm copy as RoutePlanner.jsx's deleteCommittedDay.
  async function deletePlannedDay(date) {
    if (!window.confirm(`Remove the planned visits for ${formatDate(date)}? This can't be undone.`)) return false;
    setActionError(null);
    setDeletingPlannedDate(date);
    try {
      await api.scheduleDrafts.deleteCommittedDay(date);
      await load();
      return true;
    } catch (e) {
      setActionError(e.message);
      return false;
    } finally {
      setDeletingPlannedDate(null);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!visits) return <div className="loading">Loading…</div>;

  const otherVisitsForSelected = selectedDate ? splitDayVisits(byDate.get(selectedDate) || [], userId).otherVisits : [];
  const completedVisitsForSelected = completedDate ? splitDayVisits(byDate.get(completedDate) || [], userId).completedVisits : [];
  const isPlannedViewMine = plannedRouteView ? plannedRouteView.group.userId === userId : true;
  const fullPillsForOverflow = overflowAnchor ? buildFullDayPills(byDate.get(overflowAnchor.date) || [], userId) : [];

  return (
    <div className="grid" style={{ gap: 16 }}>
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Calendar</h2>
          <div className="tag-list" style={{ flex: 'unset' }}>
            {/* One button, not two — split down the middle, the filled half
                shows the current scope. Clicking anywhere on it flips to the
                other side, rather than each half being its own click target. */}
            <button
              type="button"
              className="scope-toggle"
              title="Toggle between your own visits and every rep's"
              onClick={() => onScopeChange(scope === 'mine' ? 'all' : 'mine')}
            >
              <span className={`scope-toggle-half ${scope === 'mine' ? 'active' : ''}`}>Mine</span>
              <span className={`scope-toggle-half ${scope === 'all' ? 'active' : ''}`}>All reps</span>
            </button>
          </div>
        </div>
        <div className="card-body">
          <MonthCalendar
            monthCursor={monthCursor}
            onMonthChange={setMonthCursor}
            renderDay={renderDay}
          />
        </div>
      </div>

      {/* Own group fetches fresh from the server and gets the full whole-day
          Edit/Delete footer. Another rep's group reuses the same component/
          look (already-loaded data passed straight in), just read-only —
          reopening/deleting a route only makes sense for the rep who owns
          it (see PlannedDayModal's own comment). */}
      {plannedRouteView && isPlannedViewMine && (
        <PlannedDayModal
          date={plannedRouteView.date}
          onClose={() => setPlannedRouteView(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onEditDay={async () => {
            const reopened = await reopenPlannedDay(plannedRouteView.date);
            if (reopened) {
              setPlannedRouteView(null);
              onNavigateToPlanner?.();
            }
          }}
          editingDay={reopeningDate === plannedRouteView.date}
          onDeleteDay={async () => { if (await deletePlannedDay(plannedRouteView.date)) setPlannedRouteView(null); }}
          deletingDay={deletingPlannedDate === plannedRouteView.date}
        />
      )}

      {plannedRouteView && !isPlannedViewMine && (
        <PlannedDayModal
          date={plannedRouteView.date}
          title={`${plannedRouteView.group.repName || 'Unknown rep'}'s Planned Route`}
          visits={plannedRouteView.group.visits}
          readOnly
          onClose={() => setPlannedRouteView(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
        />
      )}

      {completedDate && (
        <CalendarDayModal
          date={completedDate}
          title="Completed Visits"
          visits={completedVisitsForSelected}
          showRepName={scope === 'all'}
          onClose={() => setCompletedDate(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onLogVisit={(visit) => setLoggingVisit(visit)}
          onViewVisit={(visit) => setViewingVisit(visit)}
        />
      )}

      {selectedDate && (
        <CalendarDayModal
          date={selectedDate}
          title="Skipped Visits"
          visits={otherVisitsForSelected}
          showRepName={scope === 'all'}
          onClose={() => setSelectedDate(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onLogVisit={(visit) => setLoggingVisit(visit)}
          onViewVisit={(visit) => setViewingVisit(visit)}
        />
      )}

      {overflowAnchor && (
        <DayOverflowModal
          date={overflowAnchor.date}
          anchorEl={overflowAnchor.el}
          pills={fullPillsForOverflow}
          onClose={() => setOverflowAnchor(null)}
          onSelect={(pill) => { setOverflowAnchor(null); openPill(pill, overflowAnchor.date); }}
        />
      )}

      {viewingPlaceId && (
        <PlaceDetail
          placeId={viewingPlaceId}
          userId={userId}
          onClose={() => setViewingPlaceId(null)}
          onChanged={load}
          onDeleted={load}
        />
      )}

      {/* Turns an already-scheduled planned visit into a completed one —
          passing visit_id makes VisitLogModal PATCH the existing row instead
          of creating a new one, same as PlaceDetail/PersonDetail's own
          editingVisit flow. No date gating: logging a late visit is allowed. */}
      {loggingVisit && (
        <VisitLogModal
          visit={{ ...loggingVisit, visit_id: loggingVisit.id }}
          userId={userId}
          onClose={() => setLoggingVisit(null)}
          onSaved={() => { setLoggingVisit(null); load(); }}
        />
      )}

      {viewingVisit && (
        <VisitDetailModal
          visit={viewingVisit}
          onClose={() => setViewingVisit(null)}
          onEdit={(v) => { setViewingVisit(null); setEditingVisit(v); }}
          onDelete={(v) => { setViewingVisit(null); removeVisit(v); }}
        />
      )}

      {editingVisit && (
        <VisitLogModal
          visit={{ ...editingVisit, visit_id: editingVisit.id }}
          userId={userId}
          onClose={() => setEditingVisit(null)}
          onSaved={() => { setEditingVisit(null); load(); }}
        />
      )}
    </div>
  );
}
