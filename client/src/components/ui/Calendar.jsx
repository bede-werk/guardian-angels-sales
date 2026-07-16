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
//   minDate: 'YYYY-MM-DD' — the earliest selectable date (today itself is
//     fine — see PlanVisits.jsx's todayISO()).
//   maxDate: 'YYYY-MM-DD' — the latest selectable date (a proposal generated
//     too far out goes stale before the rep gets there — see PlanVisits.jsx's
//     MAX_DAYS_AHEAD, mirrored from scheduleDraft.js's validateDays, which
//     enforces the same bound server-side). Can't navigate the calendar past
//     the month containing it, same as minDate's month floor.
//   maxSelected: once `selected.size` hits this, every NOT-yet-selected date
//     disables too (an already-selected one can still be clicked off, unless
//     it's also in `proposed` — see below).
//   proposed: Set of 'YYYY-MM-DD' strings already generated into the active
//     draft (see PlanVisits.jsx's proposedDates) — once a day has a real
//     proposal, deselecting it on the calendar would silently drop it from
//     the next regenerate without actually removing its proposed visits, so
//     a selected+proposed date can't be clicked off; the day's own "Discard
//     proposal" (or the page-level "Discard all proposals") is the only way
//     to free it back up.
//   A committed date can never be selected at all — see scheduleDraft.js's
//   validateDays, which enforces the same rule server-side. Same for
//   weekends — visits are only ever planned Mon-Fri, and validateDays
//   rejects a Saturday/Sunday outright rather than just leaving it out of
//   the MAX_DAYS_AHEAD count (see its maxPlanDateUTC, which already skips
//   weekends when measuring the 7-day window for exactly this reason).
export default function Calendar({ selected, committed, proposed, minDate, maxDate, maxSelected, onToggle }) {
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
  const latestMonth = startOfMonth(new Date(`${maxDate}T00:00:00`));
  const canGoBack = new Date(year, month - 1, 1) >= earliestMonth;
  const canGoForward = new Date(year, month + 1, 1) <= latestMonth;

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button type="button" className="calendar-nav" onClick={() => setMonthCursor(new Date(year, month - 1, 1))} disabled={!canGoBack} aria-label="Previous month">‹</button>
        <div className="calendar-title">{MONTH_LABELS[month]} {year}</div>
        <button type="button" className="calendar-nav" onClick={() => setMonthCursor(new Date(year, month + 1, 1))} disabled={!canGoForward} aria-label="Next month">›</button>
      </div>
      <div className="calendar-grid">
        {WEEKDAY_LABELS.map((w, i) => <div key={`h${i}`} className="calendar-weekday">{w}</div>)}
        {cells.map((date, i) => {
          if (!date) return <div key={i} className="calendar-day empty" />;
          const iso = toISODate(date);
          const isSelected = selected.has(iso);
          const isCommitted = committed.has(iso);
          const isProposed = isSelected && proposed.has(iso);
          const isPast = iso < minDate;
          const isTooFarOut = iso > maxDate;
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const disabled = isCommitted || isPast || isTooFarOut || isWeekend || isProposed || (!isSelected && atCap);
          return (
            <button
              type="button"
              key={iso}
              className={`calendar-day ${isSelected ? 'selected' : ''} ${isCommitted ? 'committed' : ''}`.trim()}
              disabled={disabled}
              title={
                isCommitted ? 'Already planned — pick a different date'
                  : isProposed ? 'Already proposed — discard the proposal to change this date'
                    : isTooFarOut ? "Too far out — plans can't be made more than a week ahead"
                      : isWeekend ? "Weekends aren't plannable — pick a weekday"
                        : undefined
              }
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
