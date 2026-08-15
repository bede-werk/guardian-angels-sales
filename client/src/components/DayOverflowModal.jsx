import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDate, today } from '../api';
import EmptyState from './ui/EmptyState';
import Button from './ui/Button';
import PlanVisitModal from './PlanVisitModal';

// Which of the day cell's own pill classes to reuse for each kind, so this
// popover reads as "the same day cell, zoomed in" rather than a new visual
// language - same colors (blue/teal/grey), just full-size and untruncated
// (see .day-overview-pill in styles.css, which overrides the cell-sized
// clamping those classes also carry).
const PILL_CLASS = {
  planned: 'planned-route-badge',
  completed: 'completed-visits-badge',
  skipped: 'skipped-visits-badge',
};

// The day number's (and the "+N more" chip's, when there is one) drill-down
// - a Google-Calendar-style popover that lands on top of the day cell that
// opened it (`anchorEl`, the whole `.month-calendar-day` cell - see
// VisitsCalendar.jsx's renderDayNum/onClick), covering it entirely rather
// than floating off to one side, showing every pill for that whole day (not
// just the ones that didn't fit in the cell - see buildFullDayPills)
// instead of a centered modal that takes over the screen. The day number is
// always clickable this way, even on a day with nothing on it at all (an
// empty `pills` list, handled below), so every day gets the same "open it
// up for a closer look" affordance. Rendered via a portal straight onto
// <body>, not nested inside the day cell: .month-calendar-grid has
// overflow:hidden for its own rounded corners, which would otherwise clip
// anything that spilled past the cell's own tiny box.
//
// Positioned in document coordinates (getBoundingClientRect + window.scroll
// X/Y), not viewport-fixed - this page scrolls as a whole (the calendar grid
// has no scroll region of its own), so an absolutely-positioned popover
// naturally scrolls along with the cell it's anchored to instead of
// detaching from it.
// `userId`/`users`/`onChanged` are only needed for the Manual Visit Planning
// control below (Manual Visit Planning spec §3) - this is genuinely new UI,
// not a modification of an existing add flow, since no day-view add
// affordance existed anywhere in VisitsCalendar before this.
export default function DayOverflowModal({ date, pills, anchorEl, userId, users, onClose, onSelect, onChanged }) {
  const popoverRef = useRef(null);
  const [style, setStyle] = useState({ visibility: 'hidden', top: 0, left: 0 });

  // "Plan a visit…" opens PlanVisitModal with THIS day already fixed (see
  // that component's own header comment) - a real, separate overlay now,
  // not an inline form that used to grow the popover itself.
  const [planningVisit, setPlanningVisit] = useState(false);

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover || !anchorEl) return;
    const margin = 8; // never flush against the viewport edge
    const anchorRect = anchorEl.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const clamp = (value, max) => Math.max(margin, Math.min(value, max));

    // Centered on the cell's own midpoint (both axes), not flush with its
    // top-left corner - still reads as covering that day (the popover is
    // always at least as big as the cell), but this way it's pulled toward
    // the middle of the screen for edge cells (e.g. the bottom row) instead
    // of jamming up against the edge it happened to be closest to.
    const top = anchorRect.top + anchorRect.height / 2 - popoverRect.height / 2;
    const left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;

    setStyle({
      visibility: 'visible',
      top: clamp(top, window.innerHeight - popoverRect.height - margin) + window.scrollY,
      left: clamp(left, window.innerWidth - popoverRect.width - margin) + window.scrollX,
    });
  }, [anchorEl, pills]);

  // Closes on a click anywhere outside the popover (the day cell behind it
  // included) or on Escape - there's no backdrop to catch this the way a
  // real modal's modal-backdrop does.
  useEffect(() => {
    function handlePointerDown(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) onClose();
    }
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <>
      {createPortal(
        <div className="day-overview-popover" style={style} ref={popoverRef}>
          <div className="day-overview-popover-head">
            <h3>{formatDate(date)}</h3>
            <button className="close" title="Close" onClick={onClose}>×</button>
          </div>
          {pills.length === 0 ? (
            <EmptyState message="Nothing on the calendar for this day." />
          ) : (
            <div className="day-overview-pills">
              {pills.map((pill) => (
                <button
                  key={pill.key}
                  type="button"
                  className={`day-overview-pill ${PILL_CLASS[pill.kind]}`}
                  onClick={() => onSelect(pill)}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          )}

          {/* Manual Visit Planning (spec §3) - plan a real, still-open visit
              directly for THIS day, no route-planner draft involved. Hidden
              for a past day: creation would always be rejected (§4.1's
              past-date block), so there's nothing useful the control could
              do there. */}
          {date >= today() && (
            <div className="day-overview-plan">
              <Button variant="secondary" size="small" onClick={() => setPlanningVisit(true)}>
                Plan a visit…
              </Button>
            </div>
          )}
        </div>,
        document.body
      )}

      {planningVisit && (
        <PlanVisitModal
          date={date}
          userId={userId}
          users={users}
          onClose={() => setPlanningVisit(false)}
          onSaved={() => { setPlanningVisit(false); onChanged?.(); }}
        />
      )}
    </>
  );
}
