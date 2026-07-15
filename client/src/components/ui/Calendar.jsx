import React, { useState } from 'react';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Month-grid, multi-select calendar for Plan My Visits' date picker (see
// PlanVisits.jsx) — a rep hand-picks which calendar dates to plan for
// instead of the old "N days ahead" auto-window.
//   selected/committed: Sets of 'YYYY-MM-DD' strings.
//   minDate: 'YYYY-MM-DD' — the earliest selectable date (today is never
//     selectable, same as the old daysAhead window's convention).
//   maxSelected: once `selected.size` hits this, every NOT-yet-selected date
//     disables too (an already-selected one can still be clicked off).
//   A committed date can never be selected at all — see scheduleDraft.js's
//   validateDays, which enforces the same rule server-side.
export default function Calendar({ selected, committed, minDate, maxSelected, onToggle }) {
  const [monthCursor, setMonthCursor] = useState(startOfMonth(new Date(`${minDate}T00:00:00`)));

  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const numDays = new Date(year, month + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= numDays; d++) cells.push(new Date(year, month, d));

  const atCap = selected.size >= maxSelected;
  const earliestMonth = startOfMonth(new Date(`${minDate}T00:00:00`));
  const canGoBack = new Date(year, month - 1, 1) >= earliestMonth;

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button type="button" className="calendar-nav" onClick={() => setMonthCursor(new Date(year, month - 1, 1))} disabled={!canGoBack} aria-label="Previous month">‹</button>
        <div className="calendar-title">{MONTH_LABELS[month]} {year}</div>
        <button type="button" className="calendar-nav" onClick={() => setMonthCursor(new Date(year, month + 1, 1))} aria-label="Next month">›</button>
      </div>
      <div className="calendar-grid">
        {WEEKDAY_LABELS.map((w, i) => <div key={`h${i}`} className="calendar-weekday">{w}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="calendar-day empty" />;
          const iso = toISODate(date);
          const isSelected = selected.has(iso);
          const isCommitted = committed.has(iso);
          const isPast = iso < minDate;
          const disabled = isCommitted || isPast || (!isSelected && atCap);
          return (
            <button
              type="button"
              key={iso}
              className={`calendar-day ${isSelected ? 'selected' : ''} ${isCommitted ? 'committed' : ''}`.trim()}
              disabled={disabled}
              title={isCommitted ? 'Already planned — pick a different date' : undefined}
              onClick={() => onToggle(iso)}
            >
              {date.getDate()}
              {isCommitted && <span className="calendar-day-check">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
