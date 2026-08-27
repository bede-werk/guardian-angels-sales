// Tunables for scheduleGenerator.js's stop-count caps feeding
// services/routeOptimizer.js's solve. Plain module, same convention as
// config/driveTime.js and config/scheduling.js.
//
// OSRM_BASE_URL/TIMEOUT_MS used to live here (routeOptimizer.js called OSRM's
// /trip and /route live, request-path). That call is gone - routeOptimizer.js
// now reads a local cache (services/matrixCache.js) and solves locally
// (services/tsp.js), so there's no per-request service URL or timeout left
// to tune. See config/matrixCache.js for the fallback-estimate tunables that
// replaced them, and config/backfillQueue.js's OSRM_DATA_PATH/OSRM_ROUTED_BIN
// for the occasional local maintenance job (scripts/backfill-distances.js)
// that fills the cache - a local osrm-routed process, not a remote URL.

module.exports = {
  // Caps how many stops go into a single solve. Real headroom over
  // what a working day can actually hold (a default working_visit day fits
  // roughly 5-6 stops) - this is a safety cap on the optimizer's input size,
  // not meant to be the thing that actually limits a day. Rank order (not
  // the optimizer) decides which stops make this cut; the optimizer only
  // sequences within it.
  MAX_OPTIMIZE_STOPS: 18,

  // Absolute ceiling on total stops in any single solve, including during
  // the top-up pass - distinct from MAX_OPTIMIZE_STOPS above. Past
  // tsp.js's exactLimit (12 free stops) the solver switches from exact
  // (Held-Karp) to a heuristic multi-start search, which stays fast well
  // beyond this ceiling - it's a deliberate backstop on request size, not a
  // hard technical limit the way OSRM's waypoint cap used to be.
  // scheduleGenerator.js's topUpDay is deliberately allowed to grow a day's
  // packed set past MAX_OPTIMIZE_STOPS one candidate at a time (that's the
  // whole point of top-up - reaching leftover candidates the initial
  // selection cap excluded), so reusing MAX_OPTIMIZE_STOPS as top-up's
  // ceiling would defeat top-up entirely. This is set generously higher so
  // it's a genuine backstop, not a day-to-day constraint.
  MAX_TOPUP_STOPS: 30,

  // Floor for the top-up pass after packing: don't bother trying to squeeze
  // in one more stop unless at least this much time is left. Matches the
  // cheapest possible block (drop_in + PREP_MINUTES + DATA_ENTRY_MINUTES +
  // MIN_DRIVE_MINUTES from config/visitTypes.js and config/driveTime.js) -
  // kept as its own constant here rather than computed from those, since a
  // day with less than this left genuinely can't fit anything, regardless of
  // how those other configs get tuned later.
  MIN_TOPUP_MINUTES: 18,
};
