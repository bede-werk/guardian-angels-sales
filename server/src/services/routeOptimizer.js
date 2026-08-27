// Real-routing stop sequencer for the route planner. Used to be the one
// I/O-having module in this stack (a live OSRM call); now it's a cache read
// (services/matrixCache.js) plus a local, deterministic solve
// (services/tsp.js) - no network call, no unreachable-server fallback, no
// timeout. A route with a coverage gap still resolves; see loadMatrix's own
// header for how a missing pair is estimated instead.
//
// `db` is a knex instance or an open transaction, passed in by the caller -
// same injected-db convention as services/capacity.js, so this is testable
// against an in-memory database instead of the shared app DB.
const defaultDriveConfig = require('../config/driveTime');
const { loadMatrix } = require('./matrixCache');
const { solveRoute } = require('./tsp');

// Every real caller in this app (scheduleGenerator.js, scheduleDraft.js)
// shapes a stop as { place_id, lat, lng, ... } - the domain name for a
// place - while loadMatrix/solveRoute need `.id` to match a place_distance
// row (see matrixCache.js's own comment on why the homeBase start point,
// which has neither, is the one deliberate exception). Normalizing here, at
// the one seam where a caller's stops meet the matrix, keeps that contract
// in one place instead of touching every caller's stop shape or renaming
// matrixCache.js's own field. A stop that already carries `.id` (this
// file's own tests, or any future caller) passes through untouched.
//
// This was a real bug until it was caught here (checkpoint 5): every real
// route ever computed by this app had `.id` undefined on every stop, which
// empties loadMatrix's knownIds list and skips the cache lookup entirely -
// so every leg silently used the geometric fallback, always, regardless of
// how complete the backfill was. Verified against a real cached row before
// and after this fix.
function withMatrixId(point) {
  return point.id != null ? point : { ...point, id: point.place_id };
}

// Which of `missing` (loadMatrix's list of place-pairs with no cached row)
// represent an actual, closeable coverage gap - i.e. both ends are real
// places, not the user-entered homeBase start point. homeBase can never be
// cached (see matrixCache.js's comment), so the home -> first-stop leg
// always shows up in `missing` and always would; treating that as a
// coverage problem would flag literally every route forever, even once
// every real place pair is fully backfilled. See routeOptimizer's checkpoint
// 5 policy call: only a real place-to-place gap is worth surfacing.
function realMissingPairs(missing) {
  const set = new Set();
  for (const [from, to] of missing) {
    if (from != null && to != null) set.add(`${from}:${to}`);
  }
  return set;
}

// checkpoint A follow-up: MIN_DRIVE_MINUTES exists to hedge ESTIMATE error
// (the geometric fallback loadMatrix uses for an uncached pair), not to
// second-guess a real cached OSRM duration. A leg between two places that
// share a building routinely caches at a real, honest 0-2 seconds - that's
// the routing engine telling us the true cost, not noise to be floored
// away. Investigated (checkpoint A) and confirmed a real cache hit's raw
// seconds is always the more accurate number, including its direction-
// dependent asymmetry (a one-way entrance loop can cost 90+ real seconds
// one way and near-zero the other) that a same-building override would have
// erased in both directions. The floor now applies only to a leg this
// function itself estimated - never to one the cache actually answered.
function floorLegSeconds(rawSeconds, isFallbackLeg, drive) {
  const minutes = Math.round(rawSeconds / 60);
  return isFallbackLeg ? Math.max(drive.MIN_DRIVE_MINUTES, minutes) : minutes;
}

// Solves a start-fixed, open-ended (not round-trip) optimal order over
// `stops`, given a fixed `start` point. Returns
// { orderedStops, legMinutes, usedFallback } where legMinutes[0] is
// start -> orderedStops[0] and legMinutes[i] is orderedStops[i-1] ->
// orderedStops[i] - the same stop-to-stop chaining shape driveTime.js's
// packOptimizedTimeBlock expects. usedFallback is true when at least one
// leg BETWEEN TWO REAL PLACES (never the home leg - see realMissingPairs)
// had no cached distance and used the geometric estimate instead - a
// caller must surface this rather than present the number as a real one.
async function optimizeRoute(db, { start, stops }, driveConfig = {}) {
  if (stops.length === 0) return { orderedStops: [], legMinutes: [], usedFallback: false };

  const drive = { ...defaultDriveConfig, ...driveConfig };
  const points = [start, ...stops].map(withMatrixId);

  const { matrix, missing } = await loadMatrix(db, points, 'seconds');
  const missingRealPairs = realMissingPairs(missing);
  // Every pair loadMatrix couldn't find a cached row for - unlike
  // missingRealPairs above, this deliberately keeps the home leg (it's never
  // cached, see loadMatrix's own comment) because MIN_DRIVE_MINUTES needs to
  // know "was this number estimated" for every leg, not just the ones worth
  // flagging to a rep. See floorLegSeconds's header for why the two sets
  // answer different questions and both are needed.
  const missingPairs = new Set(missing.map(([f, t]) => `${f}:${t}`));
  // startIndex: 0 + roundTrip: false + endIndex: null mirrors the OSRM
  // config this replaced (source=first, destination=any, roundtrip=false) -
  // start is pinned, the tour ends wherever is cheapest, no return leg.
  const { order } = solveRoute(points, { startIndex: 0, endIndex: null, roundTrip: false, matrix });

  const orderedIndices = order.slice(1); // drop the start point itself
  const orderedStops = orderedIndices.map((i) => points[i]);

  const legMinutes = [];
  let usedFallback = false;
  let from = 0;
  for (const to of orderedIndices) {
    const key = `${points[from].id}:${points[to].id}`;
    legMinutes.push(floorLegSeconds(matrix[from][to], missingPairs.has(key), drive));
    if (missingRealPairs.has(key)) usedFallback = true;
    from = to;
  }

  return { orderedStops, legMinutes, usedFallback };
}

// Real per-leg drive minutes for `stops` in the EXACT order given - unlike
// optimizeRoute() above, this never resequences. Built for the phase 6
// live-edit recalculation loop (driveTime.js's evaluateOptimizedTimeBlock):
// once a user has reordered/edited a draft day, recalculating its time
// budget must respect whatever order they just set, never silently
// reshuffle it back to "optimal" - that would be exactly the auto-reshuffle
// behavior the interaction model forbids. A fixed-order lookup is just
// consecutive-pair reads from the same cached matrix optimizeRoute() uses -
// there's no separate "routing" concept for this, only a different question
// asked of the same data.
//
// Returns { legMinutes, usedFallback } - legMinutes[0] is start -> stops[0],
// legMinutes[i] is stops[i-1] -> stops[i]. usedFallback: see optimizeRoute's
// identical comment above - same rule, same exclusion of the home leg.
async function getRouteLegMinutes(db, { start, stops }, driveConfig = {}) {
  if (stops.length === 0) return { legMinutes: [], usedFallback: false };

  const drive = { ...defaultDriveConfig, ...driveConfig };
  const points = [start, ...stops].map(withMatrixId);

  const { matrix, missing } = await loadMatrix(db, points, 'seconds');
  const missingRealPairs = realMissingPairs(missing);
  const missingPairs = new Set(missing.map(([f, t]) => `${f}:${t}`));

  const legMinutes = [];
  let usedFallback = false;
  for (let i = 0; i < stops.length; i++) {
    const key = `${points[i].id}:${points[i + 1].id}`;
    legMinutes.push(floorLegSeconds(matrix[i][i + 1], missingPairs.has(key), drive));
    if (missingRealPairs.has(key)) usedFallback = true;
  }

  return { legMinutes, usedFallback };
}

module.exports = { optimizeRoute, getRouteLegMinutes };
