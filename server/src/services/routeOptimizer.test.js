const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const driveTimeConfig = require('../config/driveTime');
const { optimizeRoute, getRouteLegMinutes } = require('./routeOptimizer');
const { loadMatrix } = require('./matrixCache');
const { solveRoute } = require('./tsp');

const HOME = { lat: 40.8136, lng: -96.7026 };
const STOP_A = { id: 1, lat: 40.8140, lng: -96.6200 };
const STOP_B = { id: 2, lat: 40.7550, lng: -96.7700 };
const STOP_C = { id: 3, lat: 40.8500, lng: -96.6000 };

// A db that throws if queried, to prove the empty-stops short-circuit never
// reaches the matrix at all (same intent as the old "without calling fetch"
// assertions, just against the new dependency).
const bogusDb = () => {
  throw new Error('db should not have been queried');
};

function makeDb() {
  return knexLib({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'migrations') },
  });
}

describe('optimizeRoute', () => {
  let db;

  before(async () => {
    db = makeDb();
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: STOP_A.lat, lng: STOP_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: STOP_B.lat, lng: STOP_B.lng },
      { id: 3, name: 'C', category: 'Hospice', lat: STOP_C.lat, lng: STOP_C.lng },
    ]);
  });

  test('short-circuits on an empty stop list without querying the matrix', async () => {
    const result = await optimizeRoute(bogusDb, { start: HOME, stops: [] });
    assert.deepEqual(result, { orderedStops: [], legMinutes: [], usedFallback: false });
  });

  test('a single stop is trivially ordered, no solving needed', async () => {
    const result = await optimizeRoute(db, { start: HOME, stops: [STOP_A] });
    assert.deepEqual(result.orderedStops, [STOP_A]);
    assert.equal(result.legMinutes.length, 1);
  });

  test('wires the cached matrix into the solver: orderedStops/legMinutes match an independently computed solveRoute', async () => {
    // A deliberately lopsided matrix (B<->C very close, A far from both) so
    // the optimal order isn't just input order or geographic guesswork.
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 20000, seconds: 2000 },
      { from_place_id: 2, to_place_id: 1, meters: 20000, seconds: 2000 },
      { from_place_id: 1, to_place_id: 3, meters: 21000, seconds: 2100 },
      { from_place_id: 3, to_place_id: 1, meters: 21000, seconds: 2100 },
      { from_place_id: 2, to_place_id: 3, meters: 500, seconds: 60 },
      { from_place_id: 3, to_place_id: 2, meters: 500, seconds: 60 },
    ]);

    const stops = [STOP_A, STOP_B, STOP_C];
    const result = await optimizeRoute(db, { start: HOME, stops });

    const points = [HOME, ...stops];
    const { matrix } = await loadMatrix(db, points, 'seconds');
    const expected = solveRoute(points, { startIndex: 0, endIndex: null, roundTrip: false, matrix });
    const expectedOrderedStops = expected.order.slice(1).map((i) => points[i]);

    assert.deepEqual(result.orderedStops, expectedOrderedStops);
    assert.equal(result.legMinutes.length, stops.length);

    // Every place-to-place pair here IS cached, so none of these legs are
    // floored (checkpoint A) - only a leg loadMatrix had to estimate would
    // be. This loop's own "from" is a point INDEX (0 = home), not a place
    // id, so the home leg (index 0) is identified positionally.
    let from = 0;
    for (let i = 1; i < expected.order.length; i++) {
      const to = expected.order[i];
      const expectedMinutes = from === 0
        ? Math.max(driveTimeConfig.MIN_DRIVE_MINUTES, Math.round(matrix[from][to] / 60)) // home leg: never cached
        : Math.round(matrix[from][to] / 60); // real cached place-to-place leg: face value, no floor
      assert.equal(result.legMinutes[i - 1], expectedMinutes);
      from = to;
    }
  });

  test('floors leg minutes at MIN_DRIVE_MINUTES for an effectively-colocated pair with no cached row', async () => {
    const stop = { id: 99, lat: HOME.lat, lng: HOME.lng };
    const result = await optimizeRoute(db, { start: HOME, stops: [stop] });
    assert.equal(result.legMinutes[0], driveTimeConfig.MIN_DRIVE_MINUTES);
  });

  test('honors a driveConfig override for MIN_DRIVE_MINUTES', async () => {
    const stop = { id: 99, lat: HOME.lat, lng: HOME.lng };
    const result = await optimizeRoute(db, { start: HOME, stops: [stop] }, { MIN_DRIVE_MINUTES: 15 });
    assert.equal(result.legMinutes[0], 15);
  });

  // Checkpoint A: MIN_DRIVE_MINUTES hedges ESTIMATE error - it must never
  // override a real cached OSRM duration, however small. Investigated
  // against the full places table: every observed same-building pair
  // caches at a real, honest near-zero duration (not noise), and some
  // genuinely close pairs cache with real, direction-dependent asymmetry
  // (a one-way entrance loop) that a floor or a same-building override
  // would have erased in both directions.
  test('a real cached leg under MIN_DRIVE_MINUTES is shown at face value, not floored', async () => {
    // The cache saying 0 (real duration data - e.g. two suites in one
    // building, see checkpoint A) is what's under test here, independent of
    // STOP_A/STOP_B's own (unrelated, far-apart) fixture coordinates - the
    // 0-second row is cheap enough that the solver will always choose to
    // traverse it rather than the far more expensive uncached reverse leg.
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 5, seconds: 0 },
    ]);
    const result = await optimizeRoute(db, { start: HOME, stops: [STOP_A, STOP_B] });
    const legToB = result.legMinutes[result.orderedStops.findIndex((s) => s.id === 2)];
    assert.equal(legToB, 0, 'a real 0-second cached leg must not be floored up to MIN_DRIVE_MINUTES');
  });

  test('still resolves (via the geometric fallback) with the cache fully empty', async () => {
    const result = await optimizeRoute(db, { start: HOME, stops: [STOP_A, STOP_B, STOP_C] });
    assert.equal(result.orderedStops.length, 3);
    assert.equal(new Set(result.orderedStops.map((s) => s.id)).size, 3, 'every stop visited exactly once');
    assert.ok(result.legMinutes.every((m) => Number.isFinite(m) && m > 0));
  });

  // Regression test for the checkpoint-5 bug: every real caller in this app
  // (scheduleGenerator.js, scheduleDraft.js) shapes a stop as { place_id,
  // lat, lng } - no `.id` - which used to empty loadMatrix's knownIds list
  // and skip the cache lookup entirely, silently falling back to the
  // geometric estimate for every leg regardless of how complete the backfill
  // was. This proves a `.place_id`-only stop now actually reaches the cache.
  test('a stop shaped with place_id (not id) - the real shape every caller in this app uses - still hits the cache', async () => {
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 999999, seconds: 99999 }, // deliberately absurd, unmistakable if read
      { from_place_id: 2, to_place_id: 1, meters: 999999, seconds: 99999 },
    ]);
    const placeIdStops = [{ place_id: 1, lat: STOP_A.lat, lng: STOP_A.lng }, { place_id: 2, lat: STOP_B.lat, lng: STOP_B.lng }];
    const result = await optimizeRoute(db, { start: HOME, stops: placeIdStops });
    assert.ok(result.legMinutes.includes(Math.round(99999 / 60)), 'the real cached value must appear, not the geometric fallback');
  });

  describe('usedFallback', () => {
    test('false when every real place-to-place leg is cached, even though the home leg is never cacheable', async () => {
      await db('place_distance').insert([
        { from_place_id: 1, to_place_id: 2, meters: 20000, seconds: 2000 },
        { from_place_id: 2, to_place_id: 1, meters: 20000, seconds: 2000 },
      ]);
      const result = await optimizeRoute(db, { start: HOME, stops: [STOP_A, STOP_B] });
      // Neither STOP_A nor STOP_B has a cached row to HOME - that's expected
      // and permanent (homeBase is never a real place), and must not trip
      // the flag on its own.
      assert.equal(result.usedFallback, false);
    });

    test('true when a real place-to-place leg (not the home leg) has no cached row', async () => {
      // Only the home legs are cached - the one real place-to-place pair
      // (A<->B) is deliberately left uncached.
      await db('place_distance').insert([
        { from_place_id: 1, to_place_id: 3, meters: 1000, seconds: 100 },
        { from_place_id: 3, to_place_id: 1, meters: 1000, seconds: 100 },
      ]);
      const result = await optimizeRoute(db, { start: HOME, stops: [STOP_A, STOP_B] });
      assert.equal(result.usedFallback, true);
    });
  });
});

describe('getRouteLegMinutes', () => {
  let db;

  before(async () => {
    db = makeDb();
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: STOP_A.lat, lng: STOP_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: STOP_B.lat, lng: STOP_B.lng },
      { id: 3, name: 'C', category: 'Hospice', lat: STOP_C.lat, lng: STOP_C.lng },
    ]);
  });

  test('short-circuits on an empty stop list without querying the matrix', async () => {
    const result = await getRouteLegMinutes(bogusDb, { start: HOME, stops: [] });
    assert.deepEqual(result, { legMinutes: [], usedFallback: false });
  });

  test('chains leg minutes in the exact given order - no resequencing, even when a different order would be cheaper', async () => {
    // B<->C is a very cheap hop, A<->B is expensive - a solver would prefer
    // to visit C before B, but getRouteLegMinutes must honor the input
    // order (A, B, C) regardless, same contract the live-edit recalc loop
    // depends on.
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 20000, seconds: 2000 },
      { from_place_id: 2, to_place_id: 3, meters: 500, seconds: 60 },
    ]);

    const stops = [STOP_A, STOP_B, STOP_C];
    const result = await getRouteLegMinutes(db, { start: HOME, stops });

    const { matrix } = await loadMatrix(db, [HOME, ...stops], 'seconds');
    assert.equal(result.legMinutes[0], Math.max(driveTimeConfig.MIN_DRIVE_MINUTES, Math.round(matrix[0][1] / 60))); // home -> A: never cached, still floored
    assert.equal(result.legMinutes[1], Math.round(matrix[1][2] / 60)); // A -> B: real cached leg (2000s), face value
    // B -> C is a real cached leg too (60s = 1 minute) - checkpoint A: a real
    // cached duration under MIN_DRIVE_MINUTES is shown as-is, not floored.
    assert.equal(result.legMinutes[2], Math.round(matrix[2][3] / 60));
    assert.equal(result.legMinutes[2], 1);
  });

  test('floors leg minutes at MIN_DRIVE_MINUTES for a leg with no cached row, same as optimizeRoute', async () => {
    const stop = { id: 99, lat: HOME.lat, lng: HOME.lng };
    const result = await getRouteLegMinutes(db, { start: HOME, stops: [stop] });
    assert.equal(result.legMinutes[0], driveTimeConfig.MIN_DRIVE_MINUTES);
  });

  test('honors a driveConfig override for MIN_DRIVE_MINUTES', async () => {
    const stop = { id: 99, lat: HOME.lat, lng: HOME.lng };
    const result = await getRouteLegMinutes(db, { start: HOME, stops: [stop] }, { MIN_DRIVE_MINUTES: 15 });
    assert.equal(result.legMinutes[0], 15);
  });

  test('a real cached leg under MIN_DRIVE_MINUTES is shown at face value, not floored', async () => {
    await db('place_distance').insert([{ from_place_id: 1, to_place_id: 2, meters: 5, seconds: 0 }]);
    const result = await getRouteLegMinutes(db, { start: HOME, stops: [STOP_A, STOP_B] });
    assert.equal(result.legMinutes[1], 0, 'a real 0-second cached leg must not be floored up to MIN_DRIVE_MINUTES');
  });

  // Same real-shape regression as optimizeRoute's identical test above - this
  // is the function evaluateDay actually calls, for both the committed
  // segment (place_id-shaped) and the proposed segment (also place_id-shaped
  // - see scheduleDraft.js's toDraftStopShape).
  test('a stop shaped with place_id (not id) still hits the cache', async () => {
    await db('place_distance').insert([{ from_place_id: 1, to_place_id: 2, meters: 999999, seconds: 99999 }]);
    const stops = [{ place_id: 1, lat: STOP_A.lat, lng: STOP_A.lng }, { place_id: 2, lat: STOP_B.lat, lng: STOP_B.lng }];
    const result = await getRouteLegMinutes(db, { start: HOME, stops });
    assert.equal(result.legMinutes[1], Math.round(99999 / 60), 'the real cached value must appear, not the geometric fallback');
  });

  describe('usedFallback', () => {
    test('false when the only uncached leg is the home leg', async () => {
      await db('place_distance').insert([{ from_place_id: 1, to_place_id: 2, meters: 500, seconds: 60 }]);
      const result = await getRouteLegMinutes(db, { start: HOME, stops: [STOP_A, STOP_B] });
      assert.equal(result.usedFallback, false);
    });

    test('true when a real place-to-place leg has no cached row', async () => {
      const result = await getRouteLegMinutes(db, { start: HOME, stops: [STOP_A, STOP_B] });
      assert.equal(result.usedFallback, true);
    });
  });
});

// Checkpoint 6 regression: at 100% real coverage the fallback path is nearly
// unreachable in practice, so a bug in it (like the withMatrixId id-mismatch
// bug this checkpoint's caller-shape fix already covers, or lat/lng being
// read off the wrong property) would stay invisible until someone adds a
// place that hasn't been backfilled yet - and then a rep sees a flagged
// route with a nonsense drive time. This exercises the fallback directly,
// with REAL caller-shaped stops (place_id, no `.id` - the exact shape
// scheduleGenerator.js/scheduleDraft.js use), against REAL captured
// coordinates and REAL OSRM durations (from __fixtures__/
// osrm-baseline-routes.json's small-4-south route, not arbitrary numbers),
// and asserts the fallback lands within a sane multiple of the real value -
// generous enough to tolerate normal real-world variance (a straight-line
// estimate is never exact), tight enough to catch a units error (e.g.
// seconds treated as minutes) or a coordinates-read-off-the-wrong-shape bug,
// either of which would blow the ratio out to an order of magnitude or more.
describe('fallback path sanity - real caller-shaped stops against real captured durations', () => {
  const HOME_REAL = { lat: 40.8136, lng: -96.7026 };
  // Real: home -> stop4 captured OSRM duration 269.1s (2683.5m), an in-town leg.
  const STOP_4 = { place_id: 4, lat: 40.792788692946, lng: -96.698343570233 };
  const REAL_SECONDS_HOME_TO_STOP4 = 269.1;
  // Real: stop14 -> stop6 captured OSRM duration 558.6s (6935.5m), a longer cross-town leg.
  const STOP_14 = { place_id: 14, lat: 40.791742575301, lng: -96.707062645932 };
  const STOP_6 = { place_id: 6, lat: 40.754340925023, lng: -96.670221634471 };
  const REAL_SECONDS_STOP14_TO_STOP6 = 558.6;

  function assertSaneMultiple(fallbackMinutes, realSeconds, label) {
    const realMinutes = realSeconds / 60;
    const ratio = fallbackMinutes / realMinutes;
    assert.ok(
      ratio > 0.3 && ratio < 3,
      `${label}: fallback (${fallbackMinutes}min) must be within a sane multiple of the real duration (${realMinutes.toFixed(2)}min) - got ratio ${ratio.toFixed(2)}x, which points at a units or coordinates bug, not normal estimate variance`
    );
  }

  test('a short in-town leg (place_id-shaped stop, empty cache) lands within a sane multiple of its real captured duration', async () => {
    const db = makeDb();
    await db.migrate.latest();
    const result = await getRouteLegMinutes(db, { start: HOME_REAL, stops: [STOP_4] });
    assert.equal(result.usedFallback, false, 'the home leg is excluded from usedFallback by design - see the describe block above');
    assertSaneMultiple(result.legMinutes[0], REAL_SECONDS_HOME_TO_STOP4, 'home -> stop4');
    await db.destroy();
  });

  test('a longer cross-town leg between two real (non-home) places lands within a sane multiple of its real captured duration, and usedFallback is true', async () => {
    const db = makeDb();
    await db.migrate.latest();
    const result = await getRouteLegMinutes(db, { start: STOP_14, stops: [STOP_6] });
    assert.equal(result.usedFallback, true, 'a real place-to-place leg with nothing cached must be flagged');
    assertSaneMultiple(result.legMinutes[0], REAL_SECONDS_STOP14_TO_STOP6, 'stop14 -> stop6');
    await db.destroy();
  });
});
