const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const defaultVisitTypesConfig = require('../config/visitTypes');
const { estimateDriveMinutes } = require('./driveTime');
const { workingDays, fillDayFromZone, generateDraft } = require('./scheduleGenerator');

// 2026-07-13 is a Monday (independently verified via day-of-year math).
const TODAY = '2026-07-13';

const DOWNTOWN = { lat: 40.8136, lng: -96.7026 };
const EAST_LINCOLN = { lat: 40.8140, lng: -96.6200 };
const SOUTHWEST_LINCOLN = { lat: 40.7550, lng: -96.7700 };

const MON_FRI = [1, 2, 3, 4, 5];

function place(id, overrides = {}) {
  return {
    id,
    name: `Place ${id}`,
    region: 'East Lincoln',
    lat: EAST_LINCOLN.lat,
    lng: EAST_LINCOLN.lng,
    default_visit_type: null,
    capacity_level: 'medium',
    capacity_status: 'estimated',
    relationship_level: 'weak',
    do_not_visit: false,
    snooze_until: null,
    ...overrides,
  };
}

function candidate(p, overrides = {}) {
  return {
    place: p,
    lastVisitDate: null,
    recentCompletedCount: 0,
    nextVisitDate: null,
    lockedElsewhere: false,
    ...overrides,
  };
}

describe('workingDays', () => {
  test('skips weekends, producing exactly daysAhead entries', () => {
    const result = workingDays({ today: TODAY, daysAhead: 5, workingWeekdays: MON_FRI, exceptionDates: [] });
    assert.deepEqual(result, ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20']);
  });

  test("today itself is never included even though it's a working weekday", () => {
    const result = workingDays({ today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [] });
    assert.deepEqual(result, ['2026-07-14']);
  });

  test('also skips explicit exception dates', () => {
    const result = workingDays({ today: TODAY, daysAhead: 4, workingWeekdays: MON_FRI, exceptionDates: ['2026-07-16'] });
    assert.deepEqual(result, ['2026-07-14', '2026-07-15', '2026-07-17', '2026-07-20']);
  });

  test('boundary: an exception date that would otherwise have been the Nth working day rolls the window forward', () => {
    const result = workingDays({ today: TODAY, daysAhead: 4, workingWeekdays: MON_FRI, exceptionDates: ['2026-07-17'] });
    assert.deepEqual(result, ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-20']);
  });

  test('produces exactly daysAhead entries even when many exceptions force a long window', () => {
    const exceptionDates = ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21'];
    const result = workingDays({ today: TODAY, daysAhead: 10, workingWeekdays: MON_FRI, exceptionDates });
    assert.equal(result.length, 10);
    for (const d of result) {
      assert.ok(!exceptionDates.includes(d), `${d} should have been excluded`);
      assert.ok(MON_FRI.includes(new Date(d + 'T00:00:00Z').getUTCDay()), `${d} should be a weekday`);
    }
  });

  test('honors a non-Mon-Fri workingWeekdays set (0=Sun..6=Sat convention)', () => {
    const result = workingDays({ today: TODAY, daysAhead: 2, workingWeekdays: [0, 6], exceptionDates: [] });
    assert.deepEqual(result, ['2026-07-18', '2026-07-19']);
  });
});

describe('fillDayFromZone', () => {
  test('packs only in-zone candidates, preserving rank order', () => {
    const c1 = candidate(place(1, { region: 'East Lincoln' }));
    const c2 = candidate(place(2, { region: 'Southwest Lincoln' }));
    const c3 = candidate(place(3, { region: 'East Lincoln' }));

    const result = fillDayFromZone({
      candidates: [c1, c2, c3],
      zone: 'East Lincoln',
      homeBase: DOWNTOWN,
      budgetMinutes: 1000,
    });

    assert.deepEqual(result.stops.map((s) => s.place_id), [1, 3]);
  });

  test('returns empty stops with full remainingMinutes when the zone has no candidates', () => {
    const c1 = candidate(place(1, { region: 'East Lincoln' }));
    const result = fillDayFromZone({ candidates: [c1], zone: 'Nowhere', homeBase: DOWNTOWN, budgetMinutes: 100 });
    assert.deepEqual(result.stops, []);
    assert.equal(result.totalMinutes, 0);
    assert.equal(result.remainingMinutes, 100);
  });

  test("resolves each stop's visitType from place.default_visit_type, falling back to DEFAULT_VISIT_TYPE when null", () => {
    const c1 = candidate(place(1, { default_visit_type: 'presentation' }));
    const c2 = candidate(place(2, { default_visit_type: null }));

    const result = fillDayFromZone({ candidates: [c1, c2], zone: 'East Lincoln', homeBase: DOWNTOWN, budgetMinutes: 1000 });

    assert.equal(result.stops[0].visitType, 'presentation');
    assert.equal(result.stops[1].visitType, defaultVisitTypesConfig.DEFAULT_VISIT_TYPE);
  });

  test("chains drive time from homeBase for the first stop", () => {
    const c1 = candidate(place(1, { region: 'East Lincoln', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }));
    const result = fillDayFromZone({ candidates: [c1], zone: 'East Lincoln', homeBase: DOWNTOWN, budgetMinutes: 1000 });
    assert.equal(result.stops[0].driveMinutes, estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN, {}));
  });
});

describe('generateDraft', () => {
  test('produces exactly daysAhead day entries in date order', () => {
    const candidates = [candidate(place(1))];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 4, homeBase: DOWNTOWN,
    });
    assert.deepEqual(result.days.map((d) => d.date), ['2026-07-14', '2026-07-15', '2026-07-16']);
  });

  test("default zone shifts to the next-highest remaining candidate's region after dedupe", () => {
    // East's best candidate (high capacity) outranks Southwest's (also high,
    // but East is listed first and capacityRank ties keep insertion order via
    // a stable sort) only for day 1; a tight budget fits exactly one stop, so
    // after day 1 dedupes East's top pick, day 2 should reconsider and pick
    // whichever region now has the top remaining candidate.
    const eastTop = candidate(place(1, { region: 'East Lincoln', capacity_level: 'high' }));
    const eastSecond = candidate(place(2, { region: 'East Lincoln', capacity_level: 'low' }));
    const southwestTop = candidate(place(3, { region: 'Southwest Lincoln', capacity_level: 'high', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }));

    const result = generateDraft({
      candidates: [eastTop, eastSecond, southwestTop],
      today: TODAY, daysAhead: 2, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, // tight: fits exactly one ~38min stop, not two
      homeBase: DOWNTOWN,
    });

    assert.equal(result.days[0].zone, 'East Lincoln');
    assert.deepEqual(result.days[0].stops.map((s) => s.place_id), [1]);
    // Day 2: East's remaining candidate is low-capacity, Southwest's is
    // high-capacity, so Southwest should now be the top remaining pick.
    assert.equal(result.days[1].zone, 'Southwest Lincoln');
    assert.deepEqual(result.days[1].stops.map((s) => s.place_id), [3]);
  });

  test('zoneOverrides for a specific date wins over the computed default', () => {
    const eastTop = candidate(place(1, { region: 'East Lincoln', capacity_level: 'high' }));
    const southwestPlace = candidate(place(2, { region: 'Southwest Lincoln', capacity_level: 'low', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }));

    const result = generateDraft({
      candidates: [eastTop, southwestPlace],
      today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 4, homeBase: DOWNTOWN,
      zoneOverrides: { '2026-07-14': 'Southwest Lincoln' },
    });

    assert.equal(result.days[0].zone, 'Southwest Lincoln');
    assert.deepEqual(result.days[0].stops.map((s) => s.place_id), [2]);
  });

  test('multi-day dedupe: a place packed on an earlier day never reappears on a later day', () => {
    const candidates = [
      candidate(place(1, { capacity_level: 'high' })),
      candidate(place(2, { capacity_level: 'medium' })),
      candidate(place(3, { capacity_level: 'low' })),
    ];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, // fits exactly one stop per day
      homeBase: DOWNTOWN,
    });

    const allPackedIds = result.days.flatMap((d) => d.stops.map((s) => s.place_id));
    assert.deepEqual(allPackedIds.sort(), [1, 2, 3]);
    assert.equal(new Set(allPackedIds).size, 3, 'no place should appear twice across the draft');
  });

  test('a candidate excluded by budget on day 1 remains available and gets packed on day 2', () => {
    const candidates = [
      candidate(place(1, { capacity_level: 'high' })),
      candidate(place(2, { capacity_level: 'medium' })),
    ];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 2, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
    });

    assert.deepEqual(result.days[0].stops.map((s) => s.place_id), [1]);
    assert.deepEqual(result.days[1].stops.map((s) => s.place_id), [2]);
  });

  test('ineligible candidates (do_not_visit / hard floor / snoozed) never appear in any day\'s output', () => {
    const blocked = candidate(place(1, { do_not_visit: true }));
    const snoozed = candidate(place(2, { snooze_until: '2026-07-20' }));
    const tooRecent = candidate(place(3, { capacity_status: 'verified' }), { lastVisitDate: '2026-07-13' }); // 1 day since -> under HARD_FLOOR_DAYS
    const eligible = candidate(place(4, { capacity_level: 'high' }));

    const result = generateDraft({
      candidates: [blocked, snoozed, tooRecent, eligible],
      today: TODAY, daysAhead: 5, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    const allPackedIds = new Set(result.days.flatMap((d) => d.stops.map((s) => s.place_id)));
    assert.ok(!allPackedIds.has(1), 'do_not_visit place should never appear');
    assert.ok(!allPackedIds.has(2), 'snoozed place should not appear before its snooze_until passes');
    assert.ok(allPackedIds.has(4), 'the eligible place should still appear');
  });

  test('mixed visit-type budgeting within a single day reuses default_visit_type end-to-end', () => {
    const candidates = [
      candidate(place(1, { default_visit_type: 'drop_in' })),
      candidate(place(2, { default_visit_type: 'check_in' })),
      candidate(place(3, { default_visit_type: 'working_visit' })),
      candidate(place(4, { default_visit_type: 'presentation' })),
    ];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    const stopsById = Object.fromEntries(result.days[0].stops.map((s) => [s.place_id, s]));
    assert.equal(stopsById[1].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.drop_in.minutes);
    assert.equal(stopsById[2].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.check_in.minutes);
    assert.equal(stopsById[3].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.working_visit.minutes);
    assert.equal(stopsById[4].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.presentation.minutes);
  });

  test('empty-pool day entries (zone: null) once the whole pool is exhausted', () => {
    const candidates = [candidate(place(1)), candidate(place(2))];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 4, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN, // generous enough to pack both on day 1
    });

    assert.equal(result.days[0].stops.length, 2);
    for (const day of result.days.slice(1)) {
      assert.equal(day.zone, null);
      assert.deepEqual(day.stops, []);
      assert.equal(day.totalMinutes, 0);
    }
  });

  test('a place under the hard floor relative to today becomes eligible starting the day it actually clears the floor, not before', () => {
    // HARD_FLOOR_DAYS defaults to 5. lastVisitDate = 2026-07-11 means:
    // day1 (07-14) daysSince=3 -> ineligible; day2 (07-15) daysSince=4 -> ineligible;
    // day3 (07-16) daysSince=5 -> eligible (>= floor).
    const candidates = [candidate(place(1, { capacity_status: 'verified' }), { lastVisitDate: '2026-07-11' })];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    assert.equal(result.days[0].stops.length, 0, 'day 1: still under the hard floor');
    assert.equal(result.days[1].stops.length, 0, 'day 2: still under the hard floor');
    assert.equal(result.days[2].stops.length, 1, 'day 3: the hard floor has now cleared');
    assert.equal(result.days[2].stops[0].place_id, 1);
  });

  test('config.scheduling override changes rank order', () => {
    // capacity high + relationship strong -> cadence 14. lastVisitDate is 21
    // days before day 1 (2026-07-14) -> urgency 21/14 = 1.5x cadence. Under
    // the default NEGLECT_MULTIPLIER (2), 1.5 < 2 so the verified place stays
    // in maintenance and an estimated (exploration) competitor outranks it.
    // Lowering NEGLECT_MULTIPLIER to 1.01 pushes 1.5x into the endangered
    // tier, which outranks exploration.
    const verified = candidate(
      place(1, { capacity_status: 'verified', capacity_level: 'high', relationship_level: 'strong', region: 'East Lincoln' }),
      { lastVisitDate: '2026-06-23' }
    );
    const estimated = candidate(place(2, { capacity_status: 'estimated', capacity_level: 'high', region: 'East Lincoln' }));

    const withDefault = generateDraft({
      candidates: [verified, estimated], today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
    });
    const withOverride = generateDraft({
      candidates: [verified, estimated], today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
      config: { scheduling: { NEGLECT_MULTIPLIER: 1.01 } },
    });

    assert.equal(withDefault.days[0].stops[0].place_id, 2, 'default: exploration wins while merely due');
    assert.equal(withOverride.days[0].stops[0].place_id, 1, 'override: lower NEGLECT_MULTIPLIER rescues the verified place first');
  });

  test('config.drive override changes driveMinutes', () => {
    const candidates = [candidate(place(1, { lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }))];
    const withDefault = generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });
    const withOverride = generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
      config: { drive: { SPEED_MPH_SHORT: 1, SPEED_MPH_MEDIUM: 1, SPEED_MPH_LONG: 1 } },
    });

    assert.ok(withOverride.days[0].stops[0].driveMinutes > withDefault.days[0].stops[0].driveMinutes);
  });

  test('config.visitTypes override changes visitMinutes', () => {
    const candidates = [candidate(place(1, { default_visit_type: 'working_visit' }))];
    const result = generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 20, homeBase: DOWNTOWN, // generous enough to still fit the inflated 999-minute visit
      config: { visitTypes: { VISIT_TYPES: { ...defaultVisitTypesConfig.VISIT_TYPES, working_visit: { label: 'Working visit', minutes: 999 } } } },
    });

    assert.equal(result.days[0].stops[0].visitMinutes, 999);
  });

  test('full multi-day integration: 2+ zones, small synthetic candidate set', () => {
    const eastPlaces = [1, 2, 3, 4].map((n) => candidate(place(n, { region: 'East Lincoln', capacity_level: n % 2 === 0 ? 'high' : 'medium' })));
    const southwestPlaces = [5, 6].map((n) =>
      candidate(place(n, { region: 'Southwest Lincoln', capacity_level: 'medium', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }))
    );

    const result = generateDraft({
      candidates: [...eastPlaces, ...southwestPlaces],
      today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 4, homeBase: DOWNTOWN,
    });

    assert.equal(result.days.length, 3);
    const allPackedIds = result.days.flatMap((d) => d.stops.map((s) => s.place_id));
    assert.equal(new Set(allPackedIds).size, allPackedIds.length, 'no place should be packed twice across the draft');

    const budgetMinutes = 4 * 60;
    for (const day of result.days) {
      assert.equal(day.totalMinutes + day.remainingMinutes, budgetMinutes);
    }
  });
});
