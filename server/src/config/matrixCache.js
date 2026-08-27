// Tunables for services/matrixCache.js's geometric fallback - the estimate
// used ONLY for a place pair not yet in the place_distance cache (see that
// file's loadMatrix). Once a pair is backfilled, these numbers never affect
// it again.
//
// Calibrated against server/src/services/__fixtures__/osrm-baseline-routes.json
// (506 real OSRM pairs across Lincoln, NE captured 2026-08-25): the grid
// metric's median error was already ~1%, so DETOUR_FACTOR stays close to 1.0
// rather than the untuned 1.0 guess a from-scratch default would need.

module.exports = {
  // Multiplies services/tsp.js's gridMeters() (Manhattan distance on the
  // local tangent plane). 1.0 = trust the raw grid distance. Recalibrate by
  // comparing gridMeters(a, b, 1.0) against real place_distance.meters once
  // there's a full backfill to sample from - see tsp.js's header for the
  // procedure this was seeded from.
  DETOUR_FACTOR: 1.01,

  // Flat average speed used to turn a fallback meters estimate into a
  // seconds estimate, when weight === 'seconds'. Median implied speed from
  // the same calibration sample (a mix of short in-town hops and longer
  // cross-town legs).
  FALLBACK_SPEED_MPH: 27,
};
