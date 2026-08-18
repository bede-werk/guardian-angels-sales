const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { estimateDriveMinutes } = require('./driveTime');
const {
  addDays,
  daysBetween,
  isoWeekDates,
  routeDriveEstimate,
  weekDayBuckets,
  formatMinutes,
} = require('./dashboardMetrics');

// Same Lincoln, NE reference points driveTime.test.js uses.
const DOWNTOWN = { lat: 40.8136, lng: -96.7026 };
const EAST_LINCOLN = { lat: 40.814, lng: -96.62 };
const SOUTHWEST_LINCOLN = { lat: 40.755, lng: -96.77 };

describe('addDays', () => {
  test('moves forward and backward', () => {
    assert.equal(addDays('2026-08-18', 1), '2026-08-19');
    assert.equal(addDays('2026-08-18', -1), '2026-08-17');
    assert.equal(addDays('2026-08-18', 0), '2026-08-18');
  });

  test('crosses month and year boundaries', () => {
    assert.equal(addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2027-01-01', -1), '2026-12-31');
  });

  test('handles a leap day', () => {
    assert.equal(addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(addDays('2028-02-29', 1), '2028-03-01');
  });

  // The whole reason this is UTC arithmetic rather than .setDate(): a US
  // Central server crossing a DST boundary must still count 24h as one day.
  test('is unaffected by a DST transition', () => {
    assert.equal(addDays('2026-03-07', 2), '2026-03-09'); // US spring forward is 2026-03-08
    assert.equal(addDays('2026-10-31', 2), '2026-11-02'); // US fall back is 2026-11-01
  });
});

describe('daysBetween', () => {
  test('is positive for a future date and negative for a past one', () => {
    assert.equal(daysBetween('2026-08-18', '2026-09-01'), 14);
    assert.equal(daysBetween('2026-08-18', '2026-08-11'), -7);
    assert.equal(daysBetween('2026-08-18', '2026-08-18'), 0);
  });
});

describe('isoWeekDates', () => {
  test('returns Monday through Sunday for a midweek date', () => {
    assert.deepEqual(isoWeekDates('2026-08-19'), [
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23',
    ]);
  });

  test('a Monday is the first day of its own week, not the last of the previous one', () => {
    assert.equal(isoWeekDates('2026-08-17')[0], '2026-08-17');
  });

  // The one case a naive `date - dayOfWeek + 1` gets wrong: JS numbers Sunday
  // as 0, so Sunday would land on the Monday of the NEXT week.
  test('a Sunday belongs to the week that started six days earlier', () => {
    const week = isoWeekDates('2026-08-16');
    assert.equal(week[0], '2026-08-10');
    assert.equal(week[6], '2026-08-16');
  });

  test('always returns seven consecutive days', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2028-02-29']) {
      const week = isoWeekDates(date);
      assert.equal(week.length, 7);
      week.forEach((d, i) => i > 0 && assert.equal(d, addDays(week[i - 1], 1)));
      assert.ok(week.includes(date), `${date} should appear in its own week`);
    }
  });
});

describe('routeDriveEstimate', () => {
  test('no stops and a single stop both have no drive time', () => {
    assert.equal(routeDriveEstimate([]).minutes, 0);
    assert.equal(routeDriveEstimate([DOWNTOWN]).minutes, 0);
    assert.equal(routeDriveEstimate([DOWNTOWN]).legs, 0);
  });

  // The documented limit: this is stop-to-stop only, because the origin the
  // rep actually drove from is never persisted. Three stops = two legs.
  test('counts legs BETWEEN stops, never a leg from an origin', () => {
    const result = routeDriveEstimate([DOWNTOWN, EAST_LINCOLN, SOUTHWEST_LINCOLN]);
    assert.equal(result.legs, 2);
    assert.equal(
      result.minutes,
      estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN) + estimateDriveMinutes(EAST_LINCOLN, SOUTHWEST_LINCOLN)
    );
  });

  test('respects the order given rather than resequencing', () => {
    const forward = routeDriveEstimate([DOWNTOWN, EAST_LINCOLN, SOUTHWEST_LINCOLN]);
    const shuffled = routeDriveEstimate([EAST_LINCOLN, SOUTHWEST_LINCOLN, DOWNTOWN]);
    assert.notEqual(forward.minutes, shuffled.minutes);
  });

  test('ungeocoded stops are excluded from the legs and reported separately', () => {
    const withGap = routeDriveEstimate([DOWNTOWN, { lat: null, lng: null }, EAST_LINCOLN]);
    assert.equal(withGap.ungeocoded_stops, 1);
    assert.equal(withGap.routable_stops, 2);
    // The gap closes up rather than producing a zero-length leg - the two
    // geocoded stops are still measured against each other.
    assert.equal(withGap.legs, 1);
    assert.equal(withGap.minutes, estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN));
  });

  test('a driveConfig override reaches the estimator', () => {
    const fast = routeDriveEstimate([DOWNTOWN, SOUTHWEST_LINCOLN], { SPEED_MPH_LONG: 80 });
    const slow = routeDriveEstimate([DOWNTOWN, SOUTHWEST_LINCOLN], { SPEED_MPH_LONG: 20 });
    assert.ok(fast.minutes < slow.minutes);
  });
});

describe('weekDayBuckets', () => {
  const week = isoWeekDates('2026-08-18');

  test('always returns one entry per week day, in order, even with no visits', () => {
    const buckets = weekDayBuckets([], week);
    assert.equal(buckets.length, 7);
    assert.deepEqual(buckets.map((b) => b.date), week);
    assert.ok(buckets.every((b) => b.completed === 0 && b.planned === 0 && b.skipped === 0));
  });

  test('counts each status onto its own day', () => {
    const buckets = weekDayBuckets(
      [
        { scheduled_date: '2026-08-17', status: 'completed' },
        { scheduled_date: '2026-08-17', status: 'completed' },
        { scheduled_date: '2026-08-17', status: 'skipped' },
        { scheduled_date: '2026-08-20', status: 'planned' },
      ],
      week
    );
    assert.deepEqual(buckets[0], { date: '2026-08-17', completed: 2, planned: 0, skipped: 1 });
    assert.deepEqual(buckets[3], { date: '2026-08-20', completed: 0, planned: 1, skipped: 0 });
  });

  // A snoozed visit keeps its original scheduled_date (snoozing sets
  // places.snooze_until, it never moves the row - HANDOFF §19), so counting
  // it here would show a deliberate deferral as work sitting on that day.
  test('snoozed visits are not counted as any status', () => {
    const buckets = weekDayBuckets([{ scheduled_date: '2026-08-18', status: 'snoozed' }], week);
    assert.deepEqual(buckets[1], { date: '2026-08-18', completed: 0, planned: 0, skipped: 0 });
  });

  test('a visit outside the week is ignored rather than throwing', () => {
    const buckets = weekDayBuckets([{ scheduled_date: '2026-09-01', status: 'completed' }], week);
    assert.ok(buckets.every((b) => b.completed === 0));
  });
});

describe('formatMinutes', () => {
  test('renders minutes, hours, and both', () => {
    assert.equal(formatMinutes(0), '0m');
    assert.equal(formatMinutes(45), '45m');
    assert.equal(formatMinutes(60), '1h');
    assert.equal(formatMinutes(85), '1h 25m');
    assert.equal(formatMinutes(125), '2h 5m');
  });
});
