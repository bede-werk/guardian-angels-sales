const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const driveTimeConfig = require('../config/driveTime');
const { optimizeRoute } = require('./routeOptimizer');

const DOWNTOWN = { lat: 40.8136, lng: -96.7026 };
const EAST_LINCOLN = { lat: 40.8140, lng: -96.6200 };
const SOUTHWEST_LINCOLN = { lat: 40.7550, lng: -96.7700 };

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function okResponse(body) {
  return { ok: true, json: async () => body };
}

describe('optimizeRoute', () => {
  test('short-circuits on an empty stop list without calling fetch', async () => {
    let called = false;
    global.fetch = async () => { called = true; return okResponse({}); };

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [] });

    assert.deepEqual(result, { orderedStops: [], legMinutes: [] });
    assert.equal(called, false);
  });

  test('reorders stops per waypoint_index and chains leg minutes start-first', async () => {
    const stopA = { place_id: 'a', ...EAST_LINCOLN };
    const stopB = { place_id: 'b', ...SOUTHWEST_LINCOLN };

    // Input order is [start, a, b] but OSRM decides b should be visited
    // before a (waypoint_index 1 for b, 2 for a) — orderedStops must follow
    // trip order, not input order.
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [
        { waypoint_index: 0 }, // start
        { waypoint_index: 2 }, // stopA
        { waypoint_index: 1 }, // stopB
      ],
      trips: [{ legs: [{ duration: 600 }, { duration: 300 }] }], // 10min, 5min
    });

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [stopA, stopB] });

    assert.deepEqual(result.orderedStops.map((s) => s.place_id), ['b', 'a']);
    assert.deepEqual(result.legMinutes, [10, 5]);
  });

  test('floors leg minutes at MIN_DRIVE_MINUTES, same as the haversine fallback', async () => {
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
      trips: [{ legs: [{ duration: 1 }] }], // ~0.02min, effectively colocated
    });

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] });

    assert.equal(result.legMinutes[0], driveTimeConfig.MIN_DRIVE_MINUTES);
  });

  test('returns null on a non-ok HTTP response', async () => {
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] });
    assert.equal(result, null);
  });

  test('returns null when OSRM reports a non-Ok code (e.g. NoTrips)', async () => {
    global.fetch = async () => okResponse({ code: 'NoTrips' });
    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] });
    assert.equal(result, null);
  });

  test('returns null rather than throwing on a network error', async () => {
    global.fetch = async () => { throw new Error('network unreachable'); };
    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] });
    assert.equal(result, null);
  });

  test('returns null rather than hanging when the request exceeds TIMEOUT_MS', async () => {
    global.fetch = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

    const result = await optimizeRoute(
      { start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] },
      { TIMEOUT_MS: 10 }
    );

    assert.equal(result, null);
  });

  test('returns null rather than trusting a legs array shorter than the requested stop count', async () => {
    // 2 stops requested but OSRM only returned 1 leg — a malformed-but-200-OK
    // response the free demo server could plausibly return under load.
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }, { waypoint_index: 2 }],
      trips: [{ legs: [{ duration: 300 }] }],
    });

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }, { place_id: 'b', ...SOUTHWEST_LINCOLN }] });

    assert.equal(result, null);
  });

  test('returns null rather than trusting a waypoints array that does not match the input point count', async () => {
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }], // missing the 2nd stop's waypoint
      trips: [{ legs: [{ duration: 300 }, { duration: 300 }] }],
    });

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }, { place_id: 'b', ...SOUTHWEST_LINCOLN }] });

    assert.equal(result, null);
  });

  test('returns null rather than propagating a non-numeric leg duration', async () => {
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
      trips: [{ legs: [{ duration: null }] }],
    });

    const result = await optimizeRoute({ start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] });

    assert.equal(result, null, 'a non-numeric duration must not silently become NaN in legMinutes');
  });

  test('honors a driveConfig override for MIN_DRIVE_MINUTES, same as the haversine fallback would', async () => {
    global.fetch = async () => okResponse({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 1 }],
      trips: [{ legs: [{ duration: 1 }] }], // ~0.02min, effectively colocated
    });

    const result = await optimizeRoute(
      { start: DOWNTOWN, stops: [{ place_id: 'a', ...EAST_LINCOLN }] },
      {},
      { MIN_DRIVE_MINUTES: 15 }
    );

    assert.equal(result.legMinutes[0], 15, 'a configured MIN_DRIVE_MINUTES override should reach the optimized path, not just the haversine fallback');
  });
});
