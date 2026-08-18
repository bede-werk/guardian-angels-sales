// Tunables for the calendar-driven planning UI's bounds (services/
// scheduleDraft.js). These are limits on what the rep is allowed to ASK the
// planner for, not inputs to the ranking algorithm itself - which is why they
// live in their own namespace rather than in config/scheduling.js.
//
// RoutePlanner.jsx used to hardcode its own copies of all three with a
// "keep the two equal" comment. It now fetches these from GET /api/settings
// instead, so there is exactly one source of truth and no way for the client
// and server bounds to drift apart.
module.exports = {
  // How many dates can go into a single draft. A soft UI bound, not an
  // engine constraint - each date is planned independently.
  MAX_PLAN_DATES: 10,

  // Default hours budget for a date. Used by RoutePlanner.jsx as the starting
  // value in the date picker, and by scheduleDraft.js's reopenCommittedDay
  // for a date added to a draft on the fly (there's no UI step to pick hours
  // when reopening an already-committed day - the rep is editing stops, not
  // re-picking a schedule).
  DEFAULT_HOURS_PER_DAY: 4,

  // A day's ranking/candidate pool is only as fresh as the moment it was
  // generated - a commitment that becomes due, or a new higher-priority
  // place, between generation and the actual visit date won't retroactively
  // reshuffle an already-proposed day. Capping how far out a date can be
  // planned bounds how stale a proposal can get before the rep would
  // naturally regenerate it anyway. Chosen with Bede 2026-07-15: a week out,
  // counted in WEEKDAYS (see scheduleDraft.js's maxPlanDateUTC), not raw
  // calendar days, so a weekend sitting in the middle of the window doesn't
  // eat into it.
  MAX_DAYS_AHEAD: 7,
};
