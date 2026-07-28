import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import MonthCalendar from './ui/MonthCalendar';
import CalendarDayModal from './CalendarDayModal';
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

// The Calendar tab: a full month grid (ui/MonthCalendar.jsx, generic/
// unbounded) fed by GET /api/visits/calendar, plus a day drill-down
// (CalendarDayModal) and the usual place/visit modals layered on top of it.
// This component owns every "which modal is open" flag for that whole
// stack — CalendarDayModal itself is read-only and just calls back up here,
// same division of responsibility PlaceDetail uses for its own nested
// PersonDetail/VisitDetailModal/VisitLogModal popups.
//
// Visits are grouped into `byDate` keyed by their raw `scheduled_date`
// string exactly as the API returns it (e.g. "2026-07-14") — never routed
// through `new Date(...).toISOString()`, which shifts near midnight in
// timezones behind UTC and would misfile a visit onto the wrong day. Both
// this map's keys and MonthCalendar's `iso` callback argument are already
// local Y-M-D strings, so a plain string compare is all that's needed.
export default function VisitsCalendar({ userId }) {
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [scope, setScope] = useState('mine'); // 'mine' | 'all'
  const [visits, setVisits] = useState(null); // flat rows from the API, or null before the first load resolves
  const [users, setUsers] = useState([]); // every team member, fetched once — for rep lookups if a row's own rep_name snapshot is ever missing
  const [selectedDate, setSelectedDate] = useState(null); // iso string driving CalendarDayModal, or null
  const [error, setError] = useState(null);

  // The three "modal on top of the day modal" flags — mirrors PlaceDetail's
  // own viewingVisit/editingVisit pattern.
  const [viewingPlaceId, setViewingPlaceId] = useState(null);
  const [loggingVisit, setLoggingVisit] = useState(null); // planned visit being turned into a completed one via VisitLogModal
  const [viewingVisit, setViewingVisit] = useState(null); // completed/skipped visit open in VisitDetailModal
  const [editingVisit, setEditingVisit] = useState(null); // visit open in VisitLogModal from VisitDetailModal's Edit

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

  // "Today" jumps the grid back to the current month and closes any open day
  // modal. Comparing month keys first avoids handing MonthCalendar a new
  // (but same-month) cursor object when we're already looking at the current
  // month — that would leave `monthKey` unchanged (so no refetch happens
  // either way), but skipping the setState entirely avoids an unnecessary
  // re-render/flicker on click.
  function goToday() {
    setSelectedDate(null);
    const now = new Date();
    if (monthKeyOf(monthCursor) !== monthKeyOf(now)) setMonthCursor(now);
  }

  function renderDay(dateObj, iso) {
    const dayVisits = byDate.get(iso);
    if (!dayVisits || dayVisits.length === 0) {
      return <span className="month-calendar-daynum">{dateObj.getDate()}</span>;
    }
    // One dot per distinct status present, not one per visit — a day with 5
    // planned + 1 completed visit shows exactly 2 dots. Fixed source order
    // (planned, completed, skipped) keeps the dots in a stable left-to-right
    // position regardless of which combination is present.
    const statuses = new Set(dayVisits.map((v) => v.status));
    return (
      <>
        <span className="month-calendar-daynum">{dateObj.getDate()}</span>
        <span className="day-dots">
          {statuses.has('planned') && <span className="day-dot planned" />}
          {statuses.has('completed') && <span className="day-dot completed" />}
          {statuses.has('skipped') && <span className="day-dot skipped" />}
        </span>
      </>
    );
  }

  function isDayActive(iso) {
    return (byDate.get(iso)?.length ?? 0) > 0;
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

  if (error) return <div className="error-banner">{error}</div>;
  if (!visits) return <div className="loading">Loading…</div>;

  const selectedVisits = selectedDate ? (byDate.get(selectedDate) || []) : [];

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-head">
          <h2>Calendar</h2>
          <div className="tag-list" style={{ flex: 'unset' }}>
            <Button
              variant={scope === 'mine' ? 'primary' : 'secondary'}
              size="small"
              title="Show only your own visits"
              onClick={() => setScope('mine')}
            >
              Mine
            </Button>
            <Button
              variant={scope === 'all' ? 'primary' : 'secondary'}
              size="small"
              title="Show every rep's visits"
              onClick={() => setScope('all')}
            >
              All reps
            </Button>
            <Button variant="secondary" size="small" title="Jump to the current month" onClick={goToday}>
              Today
            </Button>
          </div>
        </div>
        <div className="card-body">
          <MonthCalendar
            monthCursor={monthCursor}
            onMonthChange={setMonthCursor}
            renderDay={renderDay}
            isDayActive={isDayActive}
            onDayClick={(iso) => setSelectedDate(iso)}
          />
        </div>
      </div>

      {selectedDate && (
        <CalendarDayModal
          date={selectedDate}
          visits={selectedVisits}
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
