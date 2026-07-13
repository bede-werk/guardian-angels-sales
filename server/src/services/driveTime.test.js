const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/driveTime');
const visitTypesConfig = require('../config/visitTypes');
const { haversineMiles, speedForRoadMiles, estimateDriveMinutes, timeBlockMinutes, resolveVisitType, visitDurationMinutes, packTimeBlock } = require('./driveTime');

// Lincoln, NE reference points, roughly downtown / east / southwest, for
// tests that want "real-shaped" coordinates rather than synthetic ones.
const DOWNTOWN = { lat: 40.8136, lng: -96.7026 };
const EAST_LINCOLN = { lat: 40.8140, lng: -96.6200 }; // a few miles east
const SOUTHWEST_LINCOLN = { lat: 40.7550, lng: -96.7700 }; // clear across town

// Builds a point due north of origin landing at approximately targetRoadMiles
// of *road* (post-circuity) distance away — comfortably inside a speed band,
// not testing the exact boundary (see speedForRoadMiles tests for that).
// ~69 miles per degree of latitude is a good enough approximation here: the
// test recomputes the actual haversine/road distance from the real point
// afterward rather than trusting this number.
function pointAtRoadMiles(origin, targetRoadMiles, cfg) {
  const targetHaversineMiles = targetRoadMiles / cfg.CIRCUITY_FACTOR;
  return { lat: origin.lat + targetHaversineMiles / 69, lng: origin.lng };
}

describe('haversineMiles', () => {
  test('same point is zero distance', () => {
    assert.equal(haversineMiles(DOWNTOWN, DOWNTOWN), 0);
  });

  test('one degree of latitude is approximately 69 miles', () => {
    const a = { lat: 40, lng: -96 };
    const b = { lat: 41, lng: -96 };
    const miles = haversineMiles(a, b);
    assert.ok(Math.abs(miles - 69) < 1, `expected ~69 miles, got ${miles}`);
  });

  test('is symmetric', () => {
    assert.equal(haversineMiles(DOWNTOWN, EAST_LINCOLN), haversineMiles(EAST_LINCOLN, DOWNTOWN));
  });
});

describe('speedForRoadMiles bands', () => {
  test('under SHORT_BAND_MAX_MILES uses SPEED_MPH_SHORT', () => {
    assert.equal(speedForRoadMiles(0.5, config), config.SPEED_MPH_SHORT);
  });

  test('exactly SHORT_BAND_MAX_MILES is already SPEED_MPH_MEDIUM (lower bound of the middle band is inclusive)', () => {
    assert.equal(speedForRoadMiles(config.SHORT_BAND_MAX_MILES, config), config.SPEED_MPH_MEDIUM);
  });

  test('between the two boundaries uses SPEED_MPH_MEDIUM', () => {
    assert.equal(speedForRoadMiles(3, config), config.SPEED_MPH_MEDIUM);
  });

  test('exactly MEDIUM_BAND_MAX_MILES is still SPEED_MPH_MEDIUM, not yet SPEED_MPH_LONG', () => {
    assert.equal(speedForRoadMiles(config.MEDIUM_BAND_MAX_MILES, config), config.SPEED_MPH_MEDIUM);
  });

  test('just over MEDIUM_BAND_MAX_MILES uses SPEED_MPH_LONG', () => {
    assert.equal(speedForRoadMiles(config.MEDIUM_BAND_MAX_MILES + 0.01, config), config.SPEED_MPH_LONG);
  });
});

describe('estimateDriveMinutes', () => {
  test('farther points take longer than closer ones', () => {
    const near = estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN, {});
    const far = estimateDriveMinutes(DOWNTOWN, SOUTHWEST_LINCOLN, {});
    assert.ok(far > near, `expected the cross-town pair (${far}) to take longer than the nearby pair (${near})`);
  });

  test('floors at MIN_DRIVE_MINUTES for two effectively-colocated points', () => {
    // With OVERHEAD_MINUTES at its default (5), overhead alone already
    // exceeds MIN_DRIVE_MINUTES (3), so the floor can't be observed under
    // default config — zero it out here to isolate the floor itself.
    const a = { lat: 40.8136, lng: -96.7026 };
    const b = { lat: 40.8137, lng: -96.7027 }; // ~15 feet away
    assert.equal(estimateDriveMinutes(a, b, { OVERHEAD_MINUTES: 0 }), config.MIN_DRIVE_MINUTES);
  });

  // Each case below builds a point landing comfortably inside one band, then
  // recomputes the actual road distance from the real haversine result (not
  // the approximation used to construct the point) so the expected value is
  // derived the same way estimateDriveMinutes derives its own answer —
  // exercising the plumbing between estimateDriveMinutes, speedForRoadMiles,
  // and the config, not just re-asserting a hardcoded number.
  for (const [label, targetRoadMiles] of [
    ['short band (sub-mile hop)', 0.5],
    ['medium band (typical nearby hop)', 3],
    ['long band (arterial/highway trip)', 8],
  ]) {
    test(`uses the ${label} speed`, () => {
      const b = pointAtRoadMiles(DOWNTOWN, targetRoadMiles, config);
      const actualRoadMiles = haversineMiles(DOWNTOWN, b) * config.CIRCUITY_FACTOR;
      const expectedSpeed = speedForRoadMiles(actualRoadMiles, config);
      const expectedMinutes = Math.max(config.MIN_DRIVE_MINUTES, Math.round((actualRoadMiles / expectedSpeed) * 60 + config.OVERHEAD_MINUTES));

      assert.equal(estimateDriveMinutes(DOWNTOWN, b, {}), expectedMinutes);
    });
  }

  test('respects config overrides instead of silently falling back to defaults', () => {
    // DOWNTOWN -> SOUTHWEST_LINCOLN is in the long band (~6.98 road miles), so
    // overriding SPEED_MPH_LONG is the override that actually changes this pair.
    const withDefault = estimateDriveMinutes(DOWNTOWN, SOUTHWEST_LINCOLN, {});
    const withSlowerSpeed = estimateDriveMinutes(DOWNTOWN, SOUTHWEST_LINCOLN, { SPEED_MPH_LONG: 10 });
    assert.ok(withSlowerSpeed > withDefault, 'a slower configured speed should raise the estimate');

    const withNoOverhead = estimateDriveMinutes(DOWNTOWN, SOUTHWEST_LINCOLN, { OVERHEAD_MINUTES: 0 });
    assert.ok(withNoOverhead < withDefault, 'dropping overhead to 0 should lower the estimate');
  });
});

describe('timeBlockMinutes', () => {
  test('is drive time plus visit time', () => {
    assert.equal(timeBlockMinutes({ driveMinutes: 12, visitMinutes: 30 }), 42);
  });

  test('sums all four components when prep and data-entry are given', () => {
    assert.equal(timeBlockMinutes({ driveMinutes: 12, visitMinutes: 30, prepMinutes: 3, dataEntryMinutes: 5 }), 50);
  });

  test('defaults prepMinutes/dataEntryMinutes to 0 so old call sites still work', () => {
    assert.equal(timeBlockMinutes({ driveMinutes: 12, visitMinutes: 30 }), 42);
  });
});

describe('resolveVisitType / visitDurationMinutes', () => {
  test('falls back to DEFAULT_VISIT_TYPE when no type is given', () => {
    assert.equal(resolveVisitType(undefined, {}), visitTypesConfig.DEFAULT_VISIT_TYPE);
  });

  test('an explicit type wins over the default', () => {
    assert.equal(resolveVisitType('presentation', {}), 'presentation');
  });

  test('returns each configured type\'s minutes', () => {
    assert.equal(visitDurationMinutes('drop_in', {}), visitTypesConfig.VISIT_TYPES.drop_in.minutes);
    assert.equal(visitDurationMinutes('standard', {}), visitTypesConfig.VISIT_TYPES.standard.minutes);
    assert.equal(visitDurationMinutes('presentation', {}), visitTypesConfig.VISIT_TYPES.presentation.minutes);
    assert.equal(visitDurationMinutes('pre_qualification', {}), visitTypesConfig.VISIT_TYPES.pre_qualification.minutes);
  });

  test('throws on an unrecognized visit type rather than guessing a duration', () => {
    assert.throws(() => visitDurationMinutes('made_up_type', {}), /Unknown visit type/);
  });
});

describe('packTimeBlock', () => {
  function stop(id, coords, overrides = {}) {
    return { id, ...coords, ...overrides };
  }

  test('chains drive time stop-to-stop, not always from the start point', () => {
    const stops = [stop('a', EAST_LINCOLN), stop('b', SOUTHWEST_LINCOLN)];
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: 1000, defaultVisitType: 'standard' });

    assert.equal(result.stops.length, 2);
    assert.equal(result.stops[0].driveMinutes, estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN, {}));
    assert.equal(result.stops[1].driveMinutes, estimateDriveMinutes(EAST_LINCOLN, SOUTHWEST_LINCOLN, {}), 'second stop\'s drive time should originate from the first stop, not from start');
  });

  test('stops packing once the next stop would exceed the budget, rather than skipping ahead', () => {
    const stops = [stop('a', EAST_LINCOLN), stop('b', SOUTHWEST_LINCOLN), stop('c', EAST_LINCOLN)];
    const tightBudget = timeBlockMinutes({
      driveMinutes: estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN, {}),
      visitMinutes: visitTypesConfig.VISIT_TYPES.standard.minutes,
      prepMinutes: visitTypesConfig.PREP_MINUTES,
      dataEntryMinutes: visitTypesConfig.DATA_ENTRY_MINUTES,
    });

    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: tightBudget, defaultVisitType: 'standard' });

    assert.equal(result.stops.length, 1);
    assert.equal(result.stops[0].id, 'a');
    assert.equal(result.remainingMinutes, 0);
  });

  test('skips stops missing lat/lng rather than guessing', () => {
    const stops = [stop('geocoded-a', EAST_LINCOLN), stop('ungeocoded', { lat: null, lng: null }), stop('geocoded-b', SOUTHWEST_LINCOLN)];
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: 1000, defaultVisitType: 'standard' });

    assert.equal(result.stops.length, 2);
    assert.ok(result.stops.every((s) => s.id !== 'ungeocoded'));
  });

  test('per-stop visitType overrides the pack default', () => {
    const stops = [stop('a', EAST_LINCOLN, { visitType: 'presentation' })];
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: 1000, defaultVisitType: 'standard' });
    assert.equal(result.stops[0].visitType, 'presentation');
    assert.equal(result.stops[0].visitMinutes, visitTypesConfig.VISIT_TYPES.presentation.minutes);
  });

  test('falls all the way back to config DEFAULT_VISIT_TYPE when neither the stop nor the pack call specify one', () => {
    const stops = [stop('a', EAST_LINCOLN)];
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: 1000 });
    assert.equal(result.stops[0].visitType, visitTypesConfig.DEFAULT_VISIT_TYPE);
    assert.equal(result.stops[0].visitMinutes, visitTypesConfig.VISIT_TYPES[visitTypesConfig.DEFAULT_VISIT_TYPE].minutes);
  });

  test('totalMinutes and remainingMinutes stay consistent with the budget', () => {
    const stops = [stop('a', EAST_LINCOLN), stop('b', SOUTHWEST_LINCOLN)];
    const budgetMinutes = 240;
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes, defaultVisitType: 'standard' });
    assert.equal(result.totalMinutes + result.remainingMinutes, budgetMinutes);
    assert.equal(result.totalMinutes, result.stops.reduce((sum, s) => sum + s.blockMinutes, 0));
  });

  test('reports prepMinutes and dataEntryMinutes on each packed stop', () => {
    const stops = [stop('a', EAST_LINCOLN)];
    const result = packTimeBlock(stops, { start: DOWNTOWN, budgetMinutes: 1000 });
    assert.equal(result.stops[0].prepMinutes, visitTypesConfig.PREP_MINUTES);
    assert.equal(result.stops[0].dataEntryMinutes, visitTypesConfig.DATA_ENTRY_MINUTES);
  });

  test('a visitTypesConfig override of PREP_MINUTES/DATA_ENTRY_MINUTES changes totals', () => {
    const stops = [stop('a', EAST_LINCOLN, { visitType: 'standard' })];
    const withDefaults = packTimeBlock(stops, { start: EAST_LINCOLN, budgetMinutes: 1000 });
    const withOverride = packTimeBlock(stops, {
      start: EAST_LINCOLN,
      budgetMinutes: 1000,
      visitTypesConfig: { PREP_MINUTES: 20, DATA_ENTRY_MINUTES: 20 },
    });
    const expectedDelta = (20 - visitTypesConfig.PREP_MINUTES) + (20 - visitTypesConfig.DATA_ENTRY_MINUTES);
    assert.equal(withOverride.totalMinutes, withDefaults.totalMinutes + expectedDelta);
  });

  test('mixed visit-type durations in a single day pack correctly', () => {
    // A realistic day: a quick drop-in, a standard visit, and an in-service
    // presentation, all near each other so drive time doesn't dominate the
    // math — this isolates that per-stop durations are actually being used.
    const dropIn = stop('drop-in', EAST_LINCOLN, { visitType: 'drop_in' });
    const standard = stop('standard', EAST_LINCOLN, { visitType: 'standard' });
    const presentation = stop('presentation', EAST_LINCOLN, { visitType: 'presentation' });
    const stops = [dropIn, standard, presentation];

    const result = packTimeBlock(stops, { start: EAST_LINCOLN, budgetMinutes: 1000 });

    assert.equal(result.stops.length, 3);
    assert.equal(result.stops[0].visitMinutes, visitTypesConfig.VISIT_TYPES.drop_in.minutes);
    assert.equal(result.stops[1].visitMinutes, visitTypesConfig.VISIT_TYPES.standard.minutes);
    assert.equal(result.stops[2].visitMinutes, visitTypesConfig.VISIT_TYPES.presentation.minutes);

    // Every stop here is EAST_LINCOLN itself, so drive time between them is
    // just the MIN_DRIVE_MINUTES floor (same-point distance) — the only
    // thing that varies stop-to-stop is the visit duration. Prep/data-entry
    // are flat per stop, same as drive time in this fixture.
    const driveMinutes = result.stops[0].driveMinutes;
    const prep = visitTypesConfig.PREP_MINUTES;
    const dataEntry = visitTypesConfig.DATA_ENTRY_MINUTES;
    const expectedTotal =
      (driveMinutes + prep + visitTypesConfig.VISIT_TYPES.drop_in.minutes + dataEntry) +
      (driveMinutes + prep + visitTypesConfig.VISIT_TYPES.standard.minutes + dataEntry) +
      (driveMinutes + prep + visitTypesConfig.VISIT_TYPES.presentation.minutes + dataEntry);
    assert.equal(result.totalMinutes, expectedTotal);
  });

  test('a tight budget fits more short drop-ins than it would standard visits', () => {
    const dropIns = [stop('a', EAST_LINCOLN, { visitType: 'drop_in' }), stop('b', EAST_LINCOLN, { visitType: 'drop_in' }), stop('c', EAST_LINCOLN, { visitType: 'drop_in' })];
    const standards = [stop('a', EAST_LINCOLN, { visitType: 'standard' }), stop('b', EAST_LINCOLN, { visitType: 'standard' }), stop('c', EAST_LINCOLN, { visitType: 'standard' })];

    const driveMinutes = estimateDriveMinutes(EAST_LINCOLN, EAST_LINCOLN, {});
    const budgetMinutes = 3 * (driveMinutes + visitTypesConfig.PREP_MINUTES + visitTypesConfig.VISIT_TYPES.drop_in.minutes + visitTypesConfig.DATA_ENTRY_MINUTES);

    const dropInResult = packTimeBlock(dropIns, { start: EAST_LINCOLN, budgetMinutes });
    const standardResult = packTimeBlock(standards, { start: EAST_LINCOLN, budgetMinutes });

    assert.equal(dropInResult.stops.length, 3, 'all three drop-ins should fit in a budget sized exactly for three drop-ins');
    assert.ok(standardResult.stops.length < 3, 'the same budget should not fit three longer standard visits');
  });
});
