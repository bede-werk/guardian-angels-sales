import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDate } from '../api';
import { getCurrentPosition } from '../geolocation';
import MonthCalendar from './ui/MonthCalendar';
import CalendarDayModal from './CalendarDayModal';
import PlannedDayModal from './PlannedDayModal';
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
// each day cell splits its visits into up to three independently-clickable
// pieces: "your own route-planner-committed visits" (myPlanned — opens
// PlannedDayModal, the exact same component/read-as-you're-used-to-it-in-
// Route Planner view), "completed visits" (completedVisits — any rep, opens
// CalendarDayModal filtered to just those), and "everything else"
// (otherVisits — skipped visits, plus in "All reps" scope, other reps'
// still-open planned visits — also CalendarDayModal, filtered to that).
// Planned and completed are kept strictly separate buckets by design: a
// visit only ever moves from one to the other by its own `status` actually
// changing (e.g. logging a planned visit marks that same row completed —
// see VisitLogModal), never by any special-casing here — the next load()
// just re-buckets it based on whatever status is now on the row.
function splitDayVisits(dayVisits, userId) {
  const myPlanned = [];
  const completedVisits = [];
  const otherVisits = [];
  for (const v of dayVisits) {
    if (v.status === 'planned' && v.user_id === userId) myPlanned.push(v);
    else if (v.status === 'completed') completedVisits.push(v);
    else otherVisits.push(v);
  }
  return { myPlanned, completedVisits, otherVisits };
}

// The Calendar tab: a full month grid (ui/MonthCalendar.jsx, generic/
// unbounded) fed by GET /api/visits/calendar, plus three day drill-downs
// (PlannedDayModal for your own planned route; CalendarDayModal reused
// twice over — once filtered to completed visits, once to everything else)
// and the usual place/visit modals layered on top of those. This component
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
export default function VisitsCalendar({ userId, onNavigateToPlanner }) {
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [scope, setScope] = useState('mine'); // 'mine' | 'all'
  const [visits, setVisits] = useState(null); // flat rows from the API, or null before the first load resolves
  const [users, setUsers] = useState([]); // every team member, fetched once — for rep lookups if a row's own rep_name snapshot is ever missing
  const [selectedDate, setSelectedDate] = useState(null); // iso string driving CalendarDayModal (otherVisits), or null
  const [completedDate, setCompletedDate] = useState(null); // iso string driving CalendarDayModal (completedVisits), or null
  const [plannedRouteDate, setPlannedRouteDate] = useState(null); // iso string driving PlannedDayModal (myPlanned), or null
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

  function renderDay(dateObj, iso) {
    const dayVisits = byDate.get(iso) || [];
    if (dayVisits.length === 0) {
      return <span className="month-calendar-daynum">{dateObj.getDate()}</span>;
    }
    const { myPlanned, completedVisits, otherVisits } = splitDayVisits(dayVisits, userId);
    // One dot per distinct status present among otherVisits, not one per
    // visit — a day with 3 skipped + 2 other-reps'-planned shows exactly 2
    // dots. A 'planned' dot here can only mean another rep's still-open
    // planned visit (All reps scope) — your own is always covered by the
    // badge above, never duplicated into these dots.
    const statuses = new Set(otherVisits.map((v) => v.status));
    return (
      <>
        <span className="month-calendar-daynum">{dateObj.getDate()}</span>
        {myPlanned.length > 0 && (
          <button
            type="button"
            className="planned-route-badge"
            title="View your planned route for this day"
            onClick={() => setPlannedRouteDate(iso)}
          >
            Planned Route
          </button>
        )}
        {completedVisits.length > 0 && (
          <button
            type="button"
            className="completed-visits-badge"
            title="View this day's completed visits"
            onClick={() => setCompletedDate(iso)}
          >
            Completed Visits
          </button>
        )}
        {otherVisits.length > 0 && (
          <button
            type="button"
            className="day-dots clickable"
            title="View this day's other visits"
            onClick={() => setSelectedDate(iso)}
          >
            {statuses.has('planned') && <span className="day-dot planned" />}
            {statuses.has('skipped') && <span className="day-dot skipped" />}
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
              onClick={() => setScope((s) => (s === 'mine' ? 'all' : 'mine'))}
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

      {plannedRouteDate && (
        <PlannedDayModal
          date={plannedRouteDate}
          onClose={() => setPlannedRouteDate(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onEditDay={async () => {
            const reopened = await reopenPlannedDay(plannedRouteDate);
            if (reopened) {
              setPlannedRouteDate(null);
              onNavigateToPlanner?.();
            }
          }}
          editingDay={reopeningDate === plannedRouteDate}
          onDeleteDay={async () => { if (await deletePlannedDay(plannedRouteDate)) setPlannedRouteDate(null); }}
          deletingDay={deletingPlannedDate === plannedRouteDate}
        />
      )}

      {completedDate && (
        <CalendarDayModal
          date={completedDate}
          visits={completedVisitsForSelected}
          scope={scope}
          onClose={() => setCompletedDate(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onLogVisit={(visit) => setLoggingVisit(visit)}
          onViewVisit={(visit) => setViewingVisit(visit)}
        />
      )}

      {selectedDate && (
        <CalendarDayModal
          date={selectedDate}
          visits={otherVisitsForSelected}
          scope={scope}
          onClose={() => setSelectedDate(null)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
          onLogVisit={(visit) => setLoggingVisit(visit)}
          onViewVisit={(visit) => setViewingVisit(visit)}
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
