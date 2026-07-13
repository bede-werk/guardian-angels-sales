const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/scheduling');
const {
  TIERS,
  urgency,
  eligibility,
  rankKey,
  rankCandidates,
} = require('./schedulingEngine');

const TODAY = '2026-07-10';

function place(overrides = {}) {
  return {
    capacity_level: 'medium',
    capacity_status: 'estimated',
    relationship_level: 'weak',
    do_not_visit: false,
    snooze_until: null,
    ...overrides,
  };
}

function daysAgo(n, today = TODAY) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

describe('urgency() / never-visited', () => {
  test('never-visited + verified lands in the endangered (rescue) tier, not maintenance', () => {
    const neverVisited = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'weak' });
    const merelyOverdue = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'weak' }); // cadence 21

    const keyNever = rankKey({ place: neverVisited, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    const keyMerely = rankKey({ place: merelyOverdue, lastVisitDate: daysAgo(5), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });

    assert.equal(urgency({ place: neverVisited, lastVisitDate: null, recentCompletedCount: 0, today: TODAY, config }), Infinity);
    assert.equal(keyNever[0], TIERS.ENDANGERED);
    assert.equal(keyMerely[0], TIERS.MAINTENANCE);

    const ranked = rankCandidates(
      [
        { place: merelyOverdue, lastVisitDate: daysAgo(5), recentCompletedCount: 0, nextVisitDate: null },
        { place: neverVisited, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, neverVisited);
  });
});

describe('urgency() / overdue math', () => {
  test('same cadence, more days since last visit -> higher urgency, ranks first', () => {
    const a = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'strong' }); // cadence 90
    const b = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'strong' });

    const uA = urgency({ place: a, lastVisitDate: daysAgo(30), recentCompletedCount: 0, today: TODAY, config });
    const uB = urgency({ place: b, lastVisitDate: daysAgo(60), recentCompletedCount: 0, today: TODAY, config });

    assert.equal(uA, 30 / 90);
    assert.equal(uB, 60 / 90);
    assert.ok(uB > uA);

    const ranked = rankCandidates(
      [
        { place: a, lastVisitDate: daysAgo(30), recentCompletedCount: 0, nextVisitDate: null },
        { place: b, lastVisitDate: daysAgo(60), recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, b);
  });
});

describe('fatigue guard', () => {
  test('stretches cadence by FATIGUE_MULTIPLIER once recentCompletedCount hits the threshold', () => {
    const fatigued = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' }); // cadence 7
    const fresh = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' });

    const uFatigued = urgency({ place: fatigued, lastVisitDate: daysAgo(8), recentCompletedCount: config.FATIGUE_THRESHOLD, today: TODAY, config });
    const uFresh = urgency({ place: fresh, lastVisitDate: daysAgo(8), recentCompletedCount: 1, today: TODAY, config });

    assert.equal(uFatigued, 8 / (7 * config.FATIGUE_MULTIPLIER));
    assert.equal(uFresh, 8 / 7);
    assert.ok(uFatigued < uFresh, 'fatigue should lower urgency relative to an unfatigued place with identical recency');

    const ranked = rankCandidates(
      [
        { place: fatigued, lastVisitDate: daysAgo(8), recentCompletedCount: config.FATIGUE_THRESHOLD, nextVisitDate: null },
        { place: fresh, lastVisitDate: daysAgo(8), recentCompletedCount: 1, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, fresh, 'the unfatigued place should outrank the fatigued one despite identical recency');
  });
});

describe('eligibility() guards', () => {
  test('hard floor: ineligible under HARD_FLOOR_DAYS, eligible at and beyond the boundary', () => {
    const p = place();
    assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: daysAgo(3), lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS), lockedElsewhere: false, config }).eligible, true);
    assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS + 1), lockedElsewhere: false, config }).eligible, true);
  });

  test('snooze: ineligible while snooze_until is today or later, eligible once it has passed', () => {
    const snoozedToday = place({ snooze_until: TODAY });
    const snoozedFuture = place({ snooze_until: daysAgo(-5) });
    const snoozedPast = place({ snooze_until: daysAgo(1) });

    assert.equal(eligibility({ place: snoozedToday, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibility({ place: snoozedFuture, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibility({ place: snoozedPast, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, true);
  });

  test('do_not_visit always wins, regardless of everything else', () => {
    const p = place({ do_not_visit: true });
    const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'do_not_visit');
  });

  test('locked-elsewhere guard (pure half of the multi-user collision check)', () => {
    const p = place();
    const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: true, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'locked_elsewhere');
  });
});

describe('hard commitments jump the queue', () => {
  test('a due next_visit_date outranks even an unverified high-capacity place', () => {
    const committed = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'weak' });
    const unverifiedHigh = place({ capacity_status: 'estimated', capacity_level: 'high' });

    const keyCommitted = rankKey({ place: committed, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: TODAY, today: TODAY, config });
    assert.equal(keyCommitted[0], TIERS.COMMITMENT);

    const ranked = rankCandidates(
      [
        { place: unverifiedHigh, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: committed, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: TODAY },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, committed);
  });

  test('a due commitment bypasses the hard floor — a human asking us back is exactly what the floor is for', () => {
    const p = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'medium' });

    const result = eligibility({ place: p, today: TODAY, lastVisitDate: daysAgo(3), nextVisitDate: TODAY, lockedElsewhere: false, config });
    assert.equal(result.eligible, true, 'a due commitment should override the hard floor, not get silently filtered out');

    const key = rankKey({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: TODAY, today: TODAY, config });
    assert.equal(key[0], TIERS.COMMITMENT, 'and it should land in the top (commitment) tier, not just survive eligibility');
  });

  test('do_not_visit still wins even over a due commitment', () => {
    const p = place({ do_not_visit: true, capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'medium' });

    const result = eligibility({ place: p, today: TODAY, lastVisitDate: daysAgo(3), nextVisitDate: TODAY, lockedElsewhere: false, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'do_not_visit');
  });
});

describe('neglect threshold (endangered tier)', () => {
  // capacity high + relationship strong -> cadence 14, so daysSince 21 = 1.5x, 28 = 2x, 42 = 3x.
  function verifiedHighStrong() {
    return place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'strong' });
  }

  test('below NEGLECT_MULTIPLIER stays in maintenance — exploration still wins', () => {
    const p = verifiedHighStrong();
    const key = rankKey({ place: p, lastVisitDate: daysAgo(21), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(key[0], TIERS.MAINTENANCE);

    const unverified = place({ capacity_status: 'estimated', capacity_level: 'low' });
    const ranked = rankCandidates(
      [
        { place: p, lastVisitDate: daysAgo(21), recentCompletedCount: 0, nextVisitDate: null },
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, unverified);
  });

  test('at and beyond NEGLECT_MULTIPLIER jumps into the endangered tier', () => {
    const atThreshold = verifiedHighStrong();
    const beyondThreshold = verifiedHighStrong();

    assert.equal(rankKey({ place: atThreshold, lastVisitDate: daysAgo(28), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.ENDANGERED);
    assert.equal(rankKey({ place: beyondThreshold, lastVisitDate: daysAgo(42), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.ENDANGERED);

    const unverified = place({ capacity_status: 'estimated', capacity_level: 'high' });
    const ranked = rankCandidates(
      [
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: atThreshold, lastVisitDate: daysAgo(28), recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, atThreshold, 'endangered tier should outrank exploration once neglect threshold is met');
  });

  test('rescue is urgency-based, not capacity-based', () => {
    // Low-capacity, 2x overdue -> should still jump the endangered tier.
    const lowCapacityNeglected = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'weak' }); // cadence 90
    const keyLow = rankKey({ place: lowCapacityNeglected, lastVisitDate: daysAgo(180), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyLow[0], TIERS.ENDANGERED, 'a low-capacity place should still be rescued once genuinely neglected');

    // High-capacity, only mildly overdue -> must NOT jump (capacity does not buy a pass into rescue).
    const highCapacityMild = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' }); // cadence 7
    const keyHigh = rankKey({ place: highCapacityMild, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyHigh[0], TIERS.MAINTENANCE, 'a high-capacity place must not be rescued just for being mildly overdue');

    const ranked = rankCandidates(
      [
        { place: highCapacityMild, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: null },
        { place: lowCapacityNeglected, lastVisitDate: daysAgo(180), recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, lowCapacityNeglected, 'genuine neglect on a low-capacity place outranks mild overdue on a high-capacity one');
  });

  test('fatigue delays the neglect rescue (uses the stretched cadence, not the base one)', () => {
    // capacity high + weak -> base cadence 7. At 14 days that is exactly 2x base cadence.
    const notFatigued = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' });
    const fatigued = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' });

    const keyNotFatigued = rankKey({ place: notFatigued, lastVisitDate: daysAgo(14), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    const keyFatigued = rankKey({ place: fatigued, lastVisitDate: daysAgo(14), recentCompletedCount: config.FATIGUE_THRESHOLD, nextVisitDate: null, today: TODAY, config });

    assert.equal(keyNotFatigued[0], TIERS.ENDANGERED, 'without fatigue, 2x base cadence should already qualify for rescue');
    assert.equal(keyFatigued[0], TIERS.MAINTENANCE, 'with fatigue, the same 14 days is only ~1.33x the stretched cadence — not neglected yet');
  });
});

describe("spec's acceptance test, updated for the endangered tier", () => {
  test('exploration wins while merely due; neglect rescues once genuinely overdue; falls back once caught up', () => {
    const unverified = place({ capacity_status: 'estimated', capacity_level: 'high' });
    const verifiedStrong = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'strong' }); // cadence 14

    // A: merely due (20 days, 1.43x) -> exploration still wins.
    const rankedA = rankCandidates(
      [
        { place: verifiedStrong, lastVisitDate: daysAgo(20), recentCompletedCount: 0, nextVisitDate: null },
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(rankedA[0].place, unverified);

    // B: pushed past 2x cadence (30 days, ~2.14x) -> now jumps ahead.
    const rankedB = rankCandidates(
      [
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: verifiedStrong, lastVisitDate: daysAgo(30), recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(rankedB[0].place, verifiedStrong);

    // C: pulled back to just under threshold (27 days, ~1.93x) -> ordinary maintenance ordering again.
    const keyC = rankKey({ place: verifiedStrong, lastVisitDate: daysAgo(27), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyC[0], TIERS.MAINTENANCE);
    const rankedC = rankCandidates(
      [
        { place: verifiedStrong, lastVisitDate: daysAgo(27), recentCompletedCount: 0, nextVisitDate: null },
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(rankedC[0].place, unverified);
  });
});
