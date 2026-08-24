import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDate, MONTH_NAMES } from '../api';
import { getCurrentPosition } from '../geolocation';
import MonthCalendar from './ui/MonthCalendar';
import CompletedVisitsModal from './CompletedVisitsModal';
import SkippedVisitsModal from './SkippedVisitsModal';
import ResolvedVisitDetailModal from './ResolvedVisitDetailModal';
import PlannedDayModal from './PlannedDayModal';
import DayOverflowModal from './DayOverflowModal';
import BirthdayModal from './BirthdayModal';
import PlaceDetail from './PlaceDetail';
import PersonDetail from './PersonDetail';
import VisitLogModal from './VisitLogModal';
import VisitDetailModal from './VisitDetailModal';

// "YYYY-MM" for a given Date, computed off its local year/month fields -
// never .toISOString() (see the module-level warning below and
// ui/MonthCalendar.jsx's own toISODate), which would round-trip through UTC
// and can land on the wrong month near a local midnight.
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// A day is never clickable as a whole (see ui/MonthCalendar.jsx) - instead
// each day cell splits its visits into independently-clickable pieces. Three
// possible buckets per visit: a rep's still-open planned route
// (plannedGroups, one group per rep - own group opens PlannedDayModal, the
// exact same component/read-as-you're-used-to-it-in-Route-Planner view;
// every other rep's group opens PlannedDayModal too, read-only), completed
// visits (completedVisits - any rep, opens CompletedVisitsModal), and
// skipped visits (otherVisits - status: 'skipped' specifically, opens
// SkippedVisitsModal, which assumes every row it's handed IS 'skipped').
// Planned and completed are kept strictly separate buckets by design: a
// visit only ever moves from one to the other by its own `status` actually
// changing (e.g. logging a planned visit marks that same row completed -
// see VisitLogModal), never by any special-casing here - the next load()
// just re-buckets it based on whatever status is now on the row.
//
// 'snoozed' visits (services/visitLifecycle.js) are deliberately dropped
// here, not folded into otherVisits - otherVisits used to be "whatever's
// left once planned/completed are accounted for," which quietly meant
// "skipped" until 'snoozed' became a fourth status, silently mislabeling a
// deliberate deferral as a passive lapse. A snoozed visit never gets a new
// scheduled_date (snoozing only sets places.snooze_until; it doesn't move
// the row), so there's no date on the calendar that's actually "about" the
// snooze - the only current UI for it is PlaceDetail's own snooze banner.
//
// One further pass turns plannedGroups/completedVisits into a flat, capped
// list of "pills" for the cell to actually render - see buildDayPills/
// splitPillsForDay below.
function splitDayVisits(dayVisits, userId) {
  const plannedByUser = new Map(); // user_id -> { userId, repName, visits }
  const completedVisits = [];
  const otherVisits = [];
  for (const v of dayVisits) {
    if (v.status === 'planned') {
      let group = plannedByUser.get(v.user_id);
      if (!group) {
        group = { userId: v.user_id, repName: v.user_name, visits: [] };
        plannedByUser.set(v.user_id, group);
      }
      group.visits.push(v);
    } else if (v.status === 'completed') completedVisits.push(v);
    else if (v.status === 'skipped') otherVisits.push(v);
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
// what's listed in the "+N more" overflow modal - same order either way, so
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
// cell itself never grows to fit them - see the grid-track/badge overflow
// rules in styles.css. Past MAX_VISIBLE_PILLS, the rest collapse into a
// single "+N more" chip (DayOverflowModal) instead.
const MAX_VISIBLE_PILLS = 3;

function splitPillsForDay(dayVisits, userId) {
  const pills = buildDayPills(dayVisits, userId);
  const visibleCount = pills.length > MAX_VISIBLE_PILLS ? MAX_VISIBLE_PILLS - 1 : pills.length;
  return { visible: pills.slice(0, visibleCount), overflow: pills.slice(visibleCount) };
}

// The "+N more" chip opens an enlarged view of the *whole* day, not just the
// overflowed pills - so unlike buildDayPills (cell-only, capped at
// MAX_VISIBLE_PILLS), this also folds in a "Skipped Visits" pill when there
// are any, same badge the day cell itself renders directly (renderDay),
// just untruncated and with no cap here since there's a whole modal to
// spend on it instead of a ~64px cell.
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
// (PlannedDayModal for a planned route, own or another rep's;
// CompletedVisitsModal/SkippedVisitsModal for those statuses) and the usual
// place/visit modals layered on top of those. This component
// owns every "which modal is open" flag for that whole stack, same division
// of responsibility PlaceDetail uses for its own nested PersonDetail/
// VisitDetailModal/VisitLogModal popups.
//
// Visits are grouped into `byDate` keyed by their raw `scheduled_date`
// string exactly as the API returns it (e.g. "2026-07-14") - never routed
// through `new Date(...).toISOString()`, which shifts near midnight in
// timezones behind UTC and would misfile a visit onto the wrong day. Both
// this map's keys and MonthCalendar's `iso` callback argument are already
// local Y-M-D strings, so a plain string compare is all that's needed.
// `scope`/`onScopeChange` are lifted up to App.jsx rather than owned here -
// this component unmounts entirely on every tab switch (see App.jsx), so a
// plain local useState would silently reset back to "Mine" each time you
// left and returned to this tab. Living in App.jsx instead lets it survive
// that remount; App.jsx explicitly resets it back to 'mine' on logout, so a
// fresh session always starts on your own calendar.
export default function VisitsCalendar({ userId, onNavigateToPlanner, scope, onScopeChange }) {
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [visits, setVisits] = useState(null); // flat rows from the API, or null before the first load resolves
  const [users, setUsers] = useState([]); // every team member, fetched once - for rep lookups if a row's own user_name snapshot is ever missing
  const [selectedDate, setSelectedDate] = useState(null); // iso string driving SkippedVisitsModal (otherVisits), or null
  const [completedDate, setCompletedDate] = useState(null); // iso string driving CompletedVisitsModal, or null
  const [plannedRouteView, setPlannedRouteView] = useState(null); // { date, group } driving the planned-route modal (own or another rep's), or null
  const [overflowAnchor, setOverflowAnchor] = useState(null); // { date, el } driving the "+N more" popover (DayOverflowModal) - `el` is the whole day cell, so the popover can land right on top of it - or null
  const [error, setError] = useState(null); // blocks the whole tab - only for the month load itself
  const [actionError, setActionError] = useState(null); // inline banner - edit/delete-day failures, doesn't blow away the grid/modal

  // Birthdays - a separate fetch from `visits`, keyed by month only (1-12,
  // no year: a birthday has none on file, and recurs every year by
  // construction) and never scoped by scope/userId, since a birthday isn't
  // rep-owned data any more than a place or person is elsewhere in this app.
  const [birthdaysByDay, setBirthdaysByDay] = useState(new Map()); // day-of-month (1-31) -> people[]
  const [viewingBirthdaysFor, setViewingBirthdaysFor] = useState(null); // day number driving BirthdayModal, or null
  const [viewingPersonId, setViewingPersonId] = useState(null); // person whose full PersonDetail is open, if any

  // The "modal on top of the day modal" flags - mirrors PlaceDetail's own
  // viewingVisit/editingVisit pattern.
  const [viewingPlaceId, setViewingPlaceId] = useState(null);
  const [viewingVisit, setViewingVisit] = useState(null); // completed visit open in VisitDetailModal
  const [viewingResolvedVisit, setViewingResolvedVisit] = useState(null); // skipped/snoozed visit open in ResolvedVisitDetailModal
  const [editingVisit, setEditingVisit] = useState(null); // visit open in VisitLogModal from VisitDetailModal's Edit

  // Mirrors RoutePlanner.jsx's own reopenDay/deleteCommittedDay busy-state
  // flags - PlannedDayModal's Edit/Delete buttons expect the same shape.
  const [reopeningDate, setReopeningDate] = useState(null);
  const [deletingPlannedDate, setDeletingPlannedDate] = useState(null);

  useEffect(() => {
    api.users.list().then(setUsers).catch(() => {});
  }, []);

  const monthKey = monthKeyOf(monthCursor);

  // The popover is anchored to a specific chip button in the grid - changing
  // months re-renders the whole grid (that button included), so close it
  // rather than leave it floating over a now-different month with a stale
  // anchor. BirthdayModal is keyed off a plain day number, meaningless once
  // the viewed month changes, so it closes here too.
  useEffect(() => {
    setOverflowAnchor(null);
    setViewingBirthdaysFor(null);
  }, [monthKey]);

  const birthdayMonth = monthCursor.getMonth() + 1; // 1-12

  const loadBirthdays = useCallback(() => {
    api.people.birthdays(birthdayMonth)
      .then((rows) => {
        const m = new Map();
        rows.forEach((r) => {
          const list = m.get(r.birthday_day);
          if (list) list.push(r);
          else m.set(r.birthday_day, [r]);
        });
        setBirthdaysByDay(m);
      })
      .catch(() => {}); // non-critical - a failed birthday fetch shouldn't block the calendar itself
  }, [birthdayMonth]);

  useEffect(() => {
    loadBirthdays();
  }, [loadBirthdays]);

  // No setVisits(null) here on purpose - same shape as Dashboard.jsx's own
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

  // Rare, but possible: editing a completed visit open in CompletedVisitsModal
  // can move it off this day entirely (e.g. correcting its date) - once a
  // reload reflects that, this day has nothing completed left to show, so
  // close the modal instead of leaving it open on an empty list.
  useEffect(() => {
    if (!completedDate) return;
    const stillHasCompleted = (byDate.get(completedDate) || []).some((v) => v.status === 'completed');
    if (!stillHasCompleted) setCompletedDate(null);
  }, [completedDate, byDate]);

  // A pill's own action - same target whether it's clicked directly off the
  // day cell or picked out of DayOverflowModal's enlarged view.
  function openPill(pill, iso) {
    if (pill.kind === 'completed') setCompletedDate(iso);
    else if (pill.kind === 'skipped') setSelectedDate(iso);
    else setPlannedRouteView({ date: iso, group: pill.group });
  }

  // The day number itself is always clickable - same DayOverflowModal the
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

  // The day number plus its birthday badge (if any), as one row at the top
  // of the cell - kept out of the visit-pill stack below entirely, so a
  // birthday never eats into MAX_VISIBLE_PILLS or forces the cell to grow.
  function renderDayTop(dateObj, iso, dayBirthdays) {
    if (dayBirthdays.length === 0) return renderDayNum(dateObj, iso);
    return (
      <div className="month-calendar-day-top">
        {renderDayNum(dateObj, iso)}
        <button
          type="button"
          className="birthday-badge"
          title={`View ${dayBirthdays.length > 1 ? `${dayBirthdays.length} birthdays` : 'birthday'} this day`}
          onClick={() => setViewingBirthdaysFor(dateObj.getDate())}
        >
          🎂{dayBirthdays.length > 1 ? ` ${dayBirthdays.length}` : ''}
        </button>
      </div>
    );
  }

  function renderDay(dateObj, iso) {
    const dayVisits = byDate.get(iso) || [];
    const dayBirthdays = birthdaysByDay.get(dateObj.getDate()) || [];
    if (dayVisits.length === 0 && dayBirthdays.length === 0) {
      return renderDayNum(dateObj, iso);
    }
    const { otherVisits } = splitDayVisits(dayVisits, userId);
    const { visible, overflow } = splitPillsForDay(dayVisits, userId);
    return (
      <>
        {renderDayTop(dateObj, iso, dayBirthdays)}
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
            className="skipped-visits-badge"
            title="View this day's skipped visits"
            onClick={() => setSelectedDate(iso)}
          >
            Skipped Visits
          </button>
        )}
      </>
    );
  }

  // Shared by the visit-detail popup's Delete action - same shape as
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
  // draft - same endpoint and auto-locate-if-no-starting-point behavior as
  // RoutePlanner.jsx's own reopenDay (this tab has no draft workspace of its
  // own to show the result in, so a successful reopen hands off to the
  // Route Planner tab via onNavigateToPlanner instead of rendering anything
  // here itself).
  async function reopenPlannedDay(date) {
    if (!window.confirm(`Edit the planned visits for ${formatDate(date)}? They'll temporarily show as not-yet-scheduled while you make changes - accept the updated proposal again when you're done.`)) return false;
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
  const birthdaysForSelectedDay = viewingBirthdaysFor ? birthdaysByDay.get(viewingBirthdaysFor) || [] : [];

  return (
    <div className="grid" style={{ gap: 16 }}>
      {actionError && <div className="error-banner">{actionError}</div>}

      <div className="card">
        <div className="card-head">
          <h2>Calendar</h2>
          <div className="tag-list" style={{ flex: 'unset' }}>
            {/* One button, not two - split down the middle, the filled half
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
          look (already-loaded data passed straight in), just read-only -
          reopening/deleting a route only makes sense for the rep who owns
          it (see PlannedDayModal's own comment). */}
      {plannedRouteView && isPlannedViewMine && (
        <PlannedDayModal
          date={plannedRouteView.date}
          userId={userId}
          onChanged={load}
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
        <CompletedVisitsModal
          date={completedDate}
          visits={completedVisitsForSelected}
          showContact={scope === 'all'}
          onClose={() => setCompletedDate(null)}
          onViewVisit={(visit) => setViewingVisit(visit)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
        />
      )}

      {selectedDate && (
        <SkippedVisitsModal
          date={selectedDate}
          visits={otherVisitsForSelected}
          showRepName={scope === 'all'}
          onClose={() => setSelectedDate(null)}
          onViewVisit={(visit) => setViewingResolvedVisit(visit)}
          onViewPlace={(placeId) => setViewingPlaceId(placeId)}
        />
      )}

      {overflowAnchor && (
        <DayOverflowModal
          date={overflowAnchor.date}
          anchorEl={overflowAnchor.el}
          pills={fullPillsForOverflow}
          userId={userId}
          users={users}
          onClose={() => setOverflowAnchor(null)}
          onSelect={(pill) => { setOverflowAnchor(null); openPill(pill, overflowAnchor.date); }}
          onChanged={load}
        />
      )}

      {viewingBirthdaysFor && (
        <BirthdayModal
          label={`${MONTH_NAMES[monthCursor.getMonth()]} ${viewingBirthdaysFor}`}
          people={birthdaysForSelectedDay}
          onClose={() => setViewingBirthdaysFor(null)}
          onViewPerson={(personId) => { setViewingBirthdaysFor(null); setViewingPersonId(personId); }}
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

      {viewingPersonId && (
        <PersonDetail
          personId={viewingPersonId}
          userId={userId}
          onClose={() => setViewingPersonId(null)}
          onOpenPlace={(placeId) => { setViewingPersonId(null); setViewingPlaceId(placeId); }}
          onChanged={loadBirthdays}
          onDeleted={() => { setViewingPersonId(null); loadBirthdays(); }}
        />
      )}

      {viewingVisit && (
        <VisitDetailModal
          visit={viewingVisit}
          onClose={() => setViewingVisit(null)}
          onEdit={(v) => {
            if (v.user_id != null && v.user_id !== userId && !window.confirm("This visit is logged under a different rep's account. Edit it anyway?")) return;
            setViewingVisit(null);
            setEditingVisit(v);
          }}
          onDelete={(v) => { setViewingVisit(null); removeVisit(v); }}
          // Removing one person from a trip can change what the grid shows -
          // and can delete the trip outright when it was the last encounter -
          // so the month has to be refetched, not just the open modal.
          onChanged={load}
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

      {viewingResolvedVisit && (
        <ResolvedVisitDetailModal
          visit={viewingResolvedVisit}
          onClose={() => setViewingResolvedVisit(null)}
          onComplete={(v) => { setViewingResolvedVisit(null); setEditingVisit(v); }}
          onDelete={(v) => { setViewingResolvedVisit(null); removeVisit(v); }}
        />
      )}
    </div>
  );
}
