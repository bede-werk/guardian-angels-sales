import React from 'react';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Local Y-M-D, never .toISOString() (which shifts near midnight in timezones
// behind UTC) — same rule this app's other date-string code already follows
// (see Calendar.jsx/RoutePlanner.jsx's own toISODate/isoDate).
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Generic, unbounded month-grid renderer — knows nothing about visits (or
// any other domain). It owns cell layout, month navigation, and click
// dispatch; the caller owns what's inside a cell and which days are
// clickable at all, via the three callback props below. This is a
// deliberately different component from ui/Calendar.jsx (a bounded
// multi-select date *picker* for Route Planner) rather than an extension of
// it — that component's selected/committed/proposed/minDate/maxDate/
// maxSelected props are all specific to picking upcoming plan dates and
// don't fit "browse any month, view indicators, click to drill in" at all.
//   monthCursor: a Date anywhere in the month to display — CONTROLLED by the
//     caller (this component holds no month state of its own), so the
//     caller can implement things like a "Today" button without this
//     component needing to know about "today" as a concept beyond the ring.
//   onMonthChange(newCursor): fired by the ‹ › nav buttons.
//   renderDay(dateObj, iso): cell CONTENT only (e.g. day number + status
//     dots) — no wrapping button/onClick of its own, this component supplies
//     both.
//   isDayActive(iso): whether a cell is clickable at all (gets the active/
//     hover styling and disabled otherwise).
//   onDayClick(iso): fired only for a click on an isDayActive cell.
export default function MonthCalendar({ monthCursor, onMonthChange, renderDay, isDayActive, onDayClick }) {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const numDays = new Date(year, month + 1, 0).getDate();
  const todayIso = toISODate(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= numDays; d++) cells.push(new Date(year, month, d));
  // Pad the final week out to a full 7 too — otherwise the grid container's
  // own background (the thin grey grid-line color, via the gap trick below)
  // shows through as one big uncovered block where the trailing empty cells
  // would be, instead of matching the leading blanks' look.
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="month-calendar">
      <div className="calendar-head">
        <button type="button" className="calendar-nav" onClick={() => onMonthChange(new Date(year, month - 1, 1))} aria-label="Previous month">‹</button>
        <div className="calendar-title">{MONTH_LABELS[month]} {year}</div>
        <button type="button" className="calendar-nav" onClick={() => onMonthChange(new Date(year, month + 1, 1))} aria-label="Next month">›</button>
      </div>
      <div className="month-calendar-grid">
        {WEEKDAY_LABELS.map((w, i) => <div key={`h${i}`} className="calendar-weekday">{w}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="month-calendar-day empty" />;
          const iso = toISODate(date);
          const active = isDayActive(iso);
          const isToday = iso === todayIso;
          return (
            <button
              type="button"
              key={iso}
              className={`month-calendar-day ${isToday ? 'today' : ''} ${active ? 'active' : ''}`.trim()}
              disabled={!active}
              onClick={active ? () => onDayClick(iso) : undefined}
            >
              {renderDay(date, iso)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
