// Pure drive-time estimator + time-block packing for the route planner. No
// knex, no I/O — same discipline as services/schedulingEngine.js: a later
// phase's job is "query the DB, shape rows into these input shapes, call this
// module." See config/driveTime.js for the drive-time tunables and
// config/visitTypes.js for the visit-type durations packing budgets against.
//
// Distance is straight-line (haversine) scaled by a circuity factor to
// approximate real road distance, then converted to minutes at a
// distance-banded average speed, plus a fixed overhead for parking/walking
// in. This is deliberately simple — swapping in a real routing API later
// only means rewriting estimateDriveMinutes(); packTimeBlock() doesn't
// change.

const defaultConfig = require('../config/driveTime');
const defaultVisitTypesConfig = require('../config/visitTypes');

const EARTH_RADIUS_MILES = 3958.8;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance between two { lat, lng } points, in miles.
function haversineMiles(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

// Picks the average speed for a trip of this (road, post-circuity) distance —
// see config/driveTime.js for why one flat speed can't serve both a
// parking-lot hop and a cross-town trip. Band edges are inclusive on their
// lower bound: exactly SHORT_BAND_MAX_MILES is already "medium" (typical
// secondary-road speed), exactly MEDIUM_BAND_MAX_MILES is still "medium",
// not yet "long".
function speedForRoadMiles(roadMiles, cfg) {
  if (roadMiles < cfg.SHORT_BAND_MAX_MILES) return cfg.SPEED_MPH_SHORT;
  if (roadMiles <= cfg.MEDIUM_BAND_MAX_MILES) return cfg.SPEED_MPH_MEDIUM;
  return cfg.SPEED_MPH_LONG;
}

// Estimated drive time in minutes between two { lat, lng } points. Straight-
// line distance is scaled by CIRCUITY_FACTOR to approximate road distance,
// converted to minutes at the speed band that distance falls into (see
// speedForRoadMiles), then OVERHEAD_MINUTES is added for parking/walking in.
// Floored at MIN_DRIVE_MINUTES so two colocated places (same building/
// complex) never estimate to ~0.
function estimateDriveMinutes(a, b, config = {}) {
  const cfg = { ...defaultConfig, ...config };

  const roadMiles = haversineMiles(a, b) * cfg.CIRCUITY_FACTOR;
  const speed = speedForRoadMiles(roadMiles, cfg);
  const minutes = (roadMiles / speed) * 60 + cfg.OVERHEAD_MINUTES;
  return Math.max(cfg.MIN_DRIVE_MINUTES, Math.round(minutes));
}

// Total time a stop consumes in a route: drive time, prep (reviewing notes
// on the way in), the visit itself, and data-entry (logging the outcome on
// the way out). prepMinutes/dataEntryMinutes default to 0 so call sites that
// predate them still work unchanged.
function timeBlockMinutes({ driveMinutes, visitMinutes, prepMinutes = 0, dataEntryMinutes = 0 }) {
  return driveMinutes + visitMinutes + prepMinutes + dataEntryMinutes;
}

// Falls back to DEFAULT_VISIT_TYPE when no type is given — a visit or place
// that predates this scheme, or simply didn't specify one.
function resolveVisitType(visitType, config = {}) {
  return visitType ?? config.DEFAULT_VISIT_TYPE ?? defaultVisitTypesConfig.DEFAULT_VISIT_TYPE;
}

// Minutes budgeted for a visit of this type — see config/visitTypes.js for
// the type list and their durations. Throws on an unrecognized type rather
// than silently guessing a duration.
function visitDurationMinutes(visitType, config = {}) {
  const types = config.VISIT_TYPES ?? defaultVisitTypesConfig.VISIT_TYPES;
  const resolvedType = resolveVisitType(visitType, config);
  const entry = types[resolvedType];
  if (!entry) throw new Error(`Unknown visit type: ${resolvedType}`);
  return entry.minutes;
}

// Shared packing loop behind packTimeBlock and packOptimizedTimeBlock: walks
// `stops` in the given order, accumulating each one's time block until the
// budget would be exceeded — breaking at that first stop rather than
// skipping ahead to a shorter one later, since skipping would break the
// caller's intended sequencing. `getDriveMinutes(from, stop, index)`
// abstracts over the only real difference between the two callers (a live
// haversine estimate vs. a precomputed real-routing leg time); everything
// else — visit-type resolution, prep/data-entry overhead, budget trimming —
// is identical between them.
//
// Each stop's visit duration comes from its own visitType if set (e.g. a
// place's default_visit_type, or a visit's explicit choice), falling back to
// `defaultVisitType` for the whole pack, then to
// config/visitTypes.js's DEFAULT_VISIT_TYPE — never a flat assumption.
// Prep and data-entry time (config/visitTypes.js's PREP_MINUTES/
// DATA_ENTRY_MINUTES) are flat per-stop overhead, same for every visit type,
// unlike the visit duration itself.
function packStops(stops, getDriveMinutes, { start, budgetMinutes, defaultVisitType, visitTypesConfig } = {}) {
  const packed = [];
  let totalMinutes = 0;
  let from = start;
  const prepMinutes = visitTypesConfig?.PREP_MINUTES ?? defaultVisitTypesConfig.PREP_MINUTES;
  const dataEntryMinutes = visitTypesConfig?.DATA_ENTRY_MINUTES ?? defaultVisitTypesConfig.DATA_ENTRY_MINUTES;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const driveMinutes = getDriveMinutes(from, stop, i);
    const visitType = resolveVisitType(stop.visitType ?? defaultVisitType, visitTypesConfig);
    const visitMinutes = visitDurationMinutes(visitType, visitTypesConfig);
    const blockMinutes = timeBlockMinutes({ driveMinutes, visitMinutes, prepMinutes, dataEntryMinutes });

    if (totalMinutes + blockMinutes > budgetMinutes) break;

    totalMinutes += blockMinutes;
    packed.push({ ...stop, visitType, driveMinutes, prepMinutes, visitMinutes, dataEntryMinutes, blockMinutes, runningTotalMinutes: totalMinutes });
    from = stop;
  }

  return { stops: packed, totalMinutes, remainingMinutes: budgetMinutes - totalMinutes };
}

// Greedily packs already-ordered stops into a fixed time budget using the
// haversine drive-time estimate. This does not reorder or choose stops —
// that's the caller's job (zone assignment + rank order, or
// services/routeOptimizer.js for a real-routing order); this function only
// answers "given this sequence, how many fit and what does the day look
// like." This is also the offline fallback when routeOptimizer.js's OSRM
// call fails or times out — see scheduleGenerator.js's fillDayFromZone.
//
// A stop with no lat/lng is a geocoding gap — there's no honest drive-time
// estimate to/from an unknown location. Exported so every caller that needs
// to pre-filter a candidate pool (e.g. scheduleGenerator.js, before handing
// stops to services/routeOptimizer.js) shares this exact definition instead
// of each re-deriving it inline.
function isGeocoded(stop) {
  return stop.lat != null && stop.lng != null;
}

// Stops missing lat/lng (a geocoding gap) are dropped before packing — see
// isGeocoded().
function packTimeBlock(stops, { start, budgetMinutes, defaultVisitType, driveConfig, visitTypesConfig } = {}) {
  const geocoded = stops.filter(isGeocoded);
  return packStops(geocoded, (from, stop) => estimateDriveMinutes(from, stop, driveConfig), {
    start,
    budgetMinutes,
    defaultVisitType,
    visitTypesConfig,
  });
}

// Packs stops already ordered and timed by services/routeOptimizer.js's
// optimizeRoute(): legMinutes[i] is the real OSRM drive time from stops[i-1]
// (or `start` for i=0) to stops[i]. Same budget-trim semantics as
// packTimeBlock — only the drive-time source differs. Stops here are assumed
// already geocoded, since they had to have lat/lng to reach the optimizer in
// the first place.
function packOptimizedTimeBlock(stops, legMinutes, { start, budgetMinutes, defaultVisitType, visitTypesConfig } = {}) {
  return packStops(stops, (_from, _stop, i) => legMinutes[i], { start, budgetMinutes, defaultVisitType, visitTypesConfig });
}

module.exports = {
  haversineMiles,
  speedForRoadMiles,
  estimateDriveMinutes,
  timeBlockMinutes,
  resolveVisitType,
  visitDurationMinutes,
  isGeocoded,
  packTimeBlock,
  packOptimizedTimeBlock,
};
