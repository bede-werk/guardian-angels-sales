// Re-runnable acceptance check for the OSRM -> cached-matrix swap: compares
// this app's REAL optimizeRoute() (through the real distance cache) against
// the 7 real routes captured from the public OSRM demo server before the
// swap (__fixtures__/osrm-baseline-routes.json).
//
// Stops are shaped exactly the way scheduleGenerator.js/scheduleDraft.js
// really shape them ({ place_id, lat, lng }, no `.id`) - this is what
// checkpoint 6 exists for: an earlier version of this comparison (checkpoint
// 2) used `.id`-shaped points, which never exercised the real caller-to-
// matrix seam and so never could have caught the id-mismatch bug checkpoint
// 5/6 found and fixed (see routeOptimizer.js's withMatrixId).
//
// Reports two numbers per route, because comparing them directly is an
// apples-to-oranges mistake that has already produced one false alarm
// (checkpoint 2, and again on the first checkpoint-6 pass):
//   - app-visible: sum of legMinutes, the MIN_DRIVE_MINUTES-floored,
//     per-leg-rounded minutes a rep actually sees. A route with several very
//     short real legs (near-duplicate addresses, adjacent suites) can show a
//     large % delta here purely from the floor, with nothing wrong.
//   - raw: unrounded, unfloored matrix seconds for whichever order was
//     chosen - the fair comparison against OSRM's own raw trip.duration,
//     since neither number has a display-rounding floor baked in.
//
// Also checks, whenever the two orders disagree, whether THIS APP's chosen
// order is cheaper than the baseline's order would be under THIS APP's own
// cost matrix - proving solveRoute did its job (it's exact for <=12 free
// stops, which covers every fixture route) even when it disagrees with
// OSRM's own (heuristic, different-network) order.
const knex = require('../db/knex');
const { optimizeRoute } = require('../services/routeOptimizer');
const { loadMatrix } = require('../services/matrixCache');
const { solveRoute } = require('../services/tsp');
const fixture = require('../services/__fixtures__/osrm-baseline-routes.json');

function baselineOrder(route) {
  const { waypoints } = route.trip;
  const bySequence = new Array(waypoints.length);
  waypoints.forEach((wp, inputIdx) => { bySequence[wp.waypoint_index] = inputIdx; });
  return bySequence.slice(1).map((inputIdx) => route.input.stops[inputIdx - 1].id);
}

function rawCost(matrix, orderIndices) {
  let total = 0;
  let from = 0;
  for (const to of orderIndices) { total += matrix[from][to]; from = to; }
  return total;
}

async function main() {
  const rows = [];
  for (const route of fixture.routes) {
    const stops = route.input.stops.map((s) => ({ place_id: s.id, lat: s.lat, lng: s.lng }));

    // App-visible: the real optimizeRoute() call, exactly as scheduleDraft.js calls it.
    const appResult = await optimizeRoute(knex, { start: route.input.homeBase, stops });
    const appVisibleSeconds = appResult.legMinutes.reduce((a, b) => a + b, 0) * 60;

    // Raw: same points, same matrix, but the unrounded solver cost.
    const points = [route.input.homeBase, ...stops].map((p) => (p.id != null ? p : { ...p, id: p.place_id }));
    const { matrix, missing } = await loadMatrix(knex, points, 'seconds');
    const { order } = solveRoute(points, { startIndex: 0, endIndex: null, roundTrip: false, matrix });
    const solverIndices = order.slice(1);
    const solverRawSeconds = rawCost(matrix, solverIndices);

    const baseIds = baselineOrder(route);
    const solverOrderIds = solverIndices.map((i) => points[i].id);
    const orderMatches = JSON.stringify(baseIds) === JSON.stringify(solverOrderIds);

    const idToIndex = new Map(points.map((p, i) => [p.id, i]));
    const baselineOrderRawSecondsUnderOurMatrix = rawCost(matrix, baseIds.map((id) => idToIndex.get(id)));
    const solverBeatsBaselineOrderUnderOurMatrix = solverRawSeconds <= baselineOrderRawSecondsUnderOurMatrix + 0.01;

    const baselineSeconds = route.trip.trips[0].duration;

    rows.push({
      label: route.label,
      orderMatches,
      usedFallback: appResult.usedFallback,
      uncachedRealPairs: missing.filter(([f, t]) => f != null && t != null).length,
      baselineMin: (baselineSeconds / 60).toFixed(1),
      appVisibleMin: (appVisibleSeconds / 60).toFixed(1),
      rawSolverMin: (solverRawSeconds / 60).toFixed(1),
      rawDeltaPct: (((solverRawSeconds - baselineSeconds) / baselineSeconds) * 100).toFixed(1) + '%',
      solverBeatsBaselineOrderUnderOurMatrix: orderMatches ? 'n/a (orders match)' : solverBeatsBaselineOrderUnderOurMatrix,
    });
  }

  console.table(rows);

  const anyFallback = rows.some((r) => r.usedFallback);
  const anyWorseOrder = rows.some((r) => r.solverBeatsBaselineOrderUnderOurMatrix === false);
  if (anyFallback) console.log('\n⚠ at least one route used the geometric fallback - coverage is not 100% for these fixture places.');
  if (anyWorseOrder) console.log('\n⚠ at least one route\'s solver order costs MORE than the baseline order under our own matrix - investigate, this would mean solveRoute is not finding the optimum.');
  if (!anyFallback && !anyWorseOrder) console.log('\n✓ every route used real cached distances, and wherever the order differs from OSRM\'s, this app\'s own choice is cheaper under its own (real, cached) cost matrix.');

  await knex.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
