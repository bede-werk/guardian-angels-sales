// Tunables for services/routeOptimizer.js — the one I/O-having module in the
// route-planner stack (see routeOptimizer.js's own header for why). Plain
// module, same convention as config/driveTime.js and config/scheduling.js.

module.exports = {
  // OSRM's free public demo server — no API key, no signup. It carries no
  // SLA, so a slow/unreachable response must never block scheduling; see
  // routeOptimizer.js's fallback to driveTime.js's haversine estimate.
  // Self-hosting OSRM or switching to a paid provider (Mapbox/Google) is the
  // documented upgrade path if the demo server's reliability becomes a real
  // problem — this is the only line that would need to change.
  OSRM_BASE_URL: 'https://router.project-osrm.org',

  // Time to wait for OSRM before giving up and falling back to the haversine
  // estimate. The demo server can be slow under load; a schedule generation
  // must still finish in a reasonable time even when it does.
  TIMEOUT_MS: 5000,

  // Caps how many stops go into a single /trip call. Real headroom over
  // what a working day can actually hold (a default working_visit day fits
  // roughly 5-6 stops) — this is a safety cap on the optimizer's input size,
  // not meant to be the thing that actually limits a day. Rank order (not
  // the optimizer) decides which stops make this cut; the optimizer only
  // sequences within it.
  MAX_OPTIMIZE_STOPS: 18,

  // Absolute ceiling on total stops in ANY single /trip call, including
  // during the top-up pass — a real technical limit (OSRM's practical
  // waypoint capacity), distinct from MAX_OPTIMIZE_STOPS above.
  // scheduleGenerator.js's topUpDay is deliberately allowed to grow a day's
  // packed set past MAX_OPTIMIZE_STOPS one candidate at a time (that's the
  // whole point of top-up — reaching leftover candidates the initial
  // selection cap excluded), so reusing MAX_OPTIMIZE_STOPS as top-up's
  // ceiling would defeat top-up entirely. This is set generously higher so
  // it's a genuine backstop, not a day-to-day constraint.
  MAX_TOPUP_STOPS: 30,

  // Floor for the top-up pass after packing: don't bother trying to squeeze
  // in one more stop unless at least this much time is left. Matches the
  // cheapest possible block (drop_in + PREP_MINUTES + DATA_ENTRY_MINUTES +
  // MIN_DRIVE_MINUTES from config/visitTypes.js and config/driveTime.js) —
  // kept as its own constant here rather than computed from those, since a
  // day with less than this left genuinely can't fit anything, regardless of
  // how those other configs get tuned later.
  MIN_TOPUP_MINUTES: 18,
};
