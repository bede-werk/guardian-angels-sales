import React from 'react';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Local Y-M-D, never .toISOString() (which shifts near midnight in timezones
// behind UTC) - same rule this app's other date-string code already follows
// (see Calendar.jsx/RoutePlanner.jsx's own toISODate/isoDate).
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Generic, unbounded month-grid renderer - knows nothing about visits (or
// any other domain). It owns cell layout and month navigation; the caller
// owns everything about what's inside a cell, including whether/how any of
// it is clickable. This is a deliberately different component from
// ui/Calendar.jsx (a bounded multi-select date *picker* for Route Planner)
// rather than an extension of it - that component's selected/committed/
// proposed/minDate/maxDate/maxSelected props are all specific to picking
// upcoming plan dates and don't fit "browse any month, view indicators,
// drill into specific parts of a day" at all.
//   monthCursor: a Date anywhere in the month to display - CONTROLLED by the
//     caller (this component holds no month state of its own), so the
//     caller can implement things like a "Today" button without this
//     component needing to know about "today" as a concept beyond the ring.
//   onMonthChange(newCursor): fired by the ‹ › nav buttons.
//   renderDay(dateObj, iso): full cell CONTENT - day number plus whatever
//     the caller wants underneath it. The cell itself is a plain non-
//     interactive <div> (not a <button>, and no onClick of its own) - a day
//     as a whole is never one big click target; renderDay supplies its own
//     nested clickable elements instead (e.g. a "Planned Route" badge, or
//     the day number itself, which stays clickable even on an empty day).
export default function MonthCalendar({ monthCursor, onMonthChange, renderDay }) {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const numDays = new Date(year, month + 1, 0).getDate();
  const todayIso = toISODate(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= numDays; d++) cells.push(new Date(year, month, d));
  // Pad the final week out to a full 7 too - otherwise the grid container's
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
          const isToday = iso === todayIso;
          return (
            <div key={iso} className={`month-calendar-day ${isToday ? 'today' : ''}`.trim()}>
              {renderDay(date, iso)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
