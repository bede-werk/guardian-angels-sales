// Real-routing stop sequencer for the route planner — the one deliberately
// I/O-having module in this stack. Every other route-planner service
// (schedulingEngine.js, driveTime.js, scheduleGenerator.js) is pure/no-I/O by
// design: query the DB, shape rows, call the pure function. This module is
// the exception because there's no honest pure substitute for "what's the
// actual optimal driving order and real drive time for these stops" — that's
// what config/routeOptimizer.js's OSRM_BASE_URL is for.
//
// Calls OSRM's /trip endpoint, which solves both concerns this codebase used
// to treat as separate phase-5 questions (a real distance matrix, and an
// efficient stop order) in one request. Never throws: any failure (network,
// timeout, malformed response) resolves to null so callers fall back to
// driveTime.js's haversine estimate — the demo server carries no SLA and a
// schedule generation must never hang or break on it.

const defaultConfig = require('../config/routeOptimizer');
const defaultDriveConfig = require('../config/driveTime');
const { fetchWithTimeout } = require('./fetchWithTimeout');

// Requests a start-fixed, open-ended (not round-trip) optimal order over
// `stops`, given a fixed `start` point. Returns
// { orderedStops, legMinutes } where legMinutes[0] is start -> orderedStops[0]
// and legMinutes[i] is orderedStops[i-1] -> orderedStops[i] — the same
// stop-to-stop chaining shape driveTime.js's packTimeBlock already expects.
// Returns null on any failure — including a malformed-but-200-OK response,
// which the demo server's lack of an SLA makes a realistic failure mode, not
// just network/timeout errors.
//
// `driveConfig` mirrors driveTime.js's own config override shape (e.g.
// MIN_DRIVE_MINUTES) so a caller's config.drive override applies identically
// whether a given day ends up using real OSRM minutes or the haversine
// fallback — it's a separate parameter from `config` (routeOptimizer's own
// tunables) since the two are unrelated config namespaces.
async function optimizeRoute({ start, stops }, config = {}, driveConfig = {}) {
  if (stops.length === 0) return { orderedStops: [], legMinutes: [] };

  const cfg = { ...defaultConfig, ...config };
  const drive = { ...defaultDriveConfig, ...driveConfig };
  const points = [start, ...stops];
  const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(';');
  // roundtrip=false + source=first + destination=any: start is pinned to
  // `start`, the trip ends wherever OSRM finds most efficient — a sales rep
  // doesn't need to drive back to homeBase between stops.
  const url = `${cfg.OSRM_BASE_URL}/trip/v1/driving/${coordinates}?roundtrip=false&source=first&destination=any&overview=false`;

  try {
    const res = await fetchWithTimeout(url, { timeoutMs: cfg.TIMEOUT_MS });
    if (!res.ok) return null;

    const data = await res.json();
    if (data.code !== 'Ok' || !data.trips?.[0]?.legs || !data.waypoints) return null;

    const legs = data.trips[0].legs;
    // A legs array that doesn't match the input size, or a leg with a
    // missing/non-numeric duration, is a malformed-but-200-OK response —
    // trusting it would silently propagate NaN into every downstream budget
    // calculation (NaN comparisons are always false, so the packing loop's
    // budget-trim check would never fire). Treat it the same as any other
    // failure: null, and let the caller fall back to the haversine estimate.
    if (legs.length !== stops.length || data.waypoints.length !== points.length) return null;
    if (legs.some((leg) => !Number.isFinite(leg.duration))) return null;

    // data.waypoints is in INPUT order (start first, then stops in the order
    // passed in); each entry's waypoint_index gives its position in the
    // computed trip. source=first guarantees the start point lands at
    // waypoint_index 0, so it's always first after sorting.
    const tripOrder = data.waypoints
      .map((wp, inputIndex) => ({ inputIndex, tripIndex: wp.waypoint_index }))
      .sort((a, b) => a.tripIndex - b.tripIndex);

    const orderedStops = tripOrder.slice(1).map(({ inputIndex }) => points[inputIndex]);
    const legMinutes = legs.map((leg) => Math.max(drive.MIN_DRIVE_MINUTES, Math.round(leg.duration / 60)));

    return { orderedStops, legMinutes };
  } catch (err) {
    // Deliberately never throws (see header comment) — but a silent,
    // unlogged null makes a genuine parsing bug indistinguishable from OSRM
    // being down; both would otherwise look identical to callers forever.
    console.error('routeOptimizer.optimizeRoute failed, falling back to the haversine estimate —', err.message);
    return null;
  }
}

// Real per-leg drive minutes for `stops` in the EXACT order given — unlike
// optimizeRoute() above, this never resequences. Built for the phase 6
// live-edit recalculation loop (driveTime.js's evaluateOptimizedTimeBlock):
// once a user has reordered/edited a draft day, recalculating its time
// budget must respect whatever order they just set, never silently
// reshuffle it back to "optimal" — that would be exactly the auto-reshuffle
// behavior the interaction model forbids. Calls OSRM's /route endpoint
// (fixed-order multi-waypoint routing), not /trip (which solves an ordering
// problem we don't want solved here).
//
// Returns { legMinutes } — legMinutes[0] is start -> stops[0], legMinutes[i]
// is stops[i-1] -> stops[i] — or null on any failure (network, timeout,
// malformed response), same never-throws/fall-back-to-haversine discipline
// as optimizeRoute().
async function getRouteLegMinutes({ start, stops }, config = {}, driveConfig = {}) {
  if (stops.length === 0) return { legMinutes: [] };

  const cfg = { ...defaultConfig, ...config };
  const drive = { ...defaultDriveConfig, ...driveConfig };
  const points = [start, ...stops];
  const coordinates = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${cfg.OSRM_BASE_URL}/route/v1/driving/${coordinates}?overview=false&steps=false`;

  try {
    const res = await fetchWithTimeout(url, { timeoutMs: cfg.TIMEOUT_MS });
    if (!res.ok) return null;

    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.[0]?.legs) return null;

    const legs = data.routes[0].legs;
    // Same malformed-but-200-OK guard as optimizeRoute() — a legs array of
    // the wrong length, or any non-finite duration, must never silently
    // propagate NaN into the budget math downstream.
    if (legs.length !== stops.length) return null;
    if (legs.some((leg) => !Number.isFinite(leg.duration))) return null;

    const legMinutes = legs.map((leg) => Math.max(drive.MIN_DRIVE_MINUTES, Math.round(leg.duration / 60)));
    return { legMinutes };
  } catch (err) {
    console.error('routeOptimizer.getRouteLegMinutes failed, falling back to the haversine estimate —', err.message);
    return null;
  }
}

module.exports = { optimizeRoute, getRouteLegMinutes };
