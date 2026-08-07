const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/scheduling');
const {
  TIERS,
  urgency,
  eligibility,
  rankKey,
  rankCandidates,
  explorationRank,
  compareRankKeys,
} = require('./schedulingEngine');

const TODAY = '2026-07-10';

let nextPlaceId = 1;
function place(overrides = {}) {
  return {
    id: nextPlaceId++,
    capacity_level: 'medium',
    capacity_status: 'estimated',
    relationship_level: 'weak',
    do_not_visit: false,
    snooze_until: null,
    priority_score: 0,
    // Step 7: EXPLORATION tier ordering reads this directly (no created_at
    // fallback — see the migration that added it). Defaulted to TODAY here
    // (daysWaiting = 0, the aging guard's own inert case) so every existing
    // fixture that doesn't care about aging stays meaningful unchanged.
    exploration_eligible_since: TODAY,
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

  // Step 3 of the 2026-08 remediation ticket: a planned (not yet happened)
  // visit consumes the hard floor exactly like a completed one, via its own
  // field — lastVisitDate stays null/whatever it already was, so ranking
  // (urgency/cadence) never sees it, only eligibility does.
  describe('plannedVisitDates guard (FLOOR_PLANNED)', () => {
    test('a planned visit within the floor makes an otherwise-never-visited place ineligible', () => {
      const p = place();
      const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'hard_floor');
    });

    test('eligible at and beyond the boundary, same threshold as a completed visit', () => {
      const p = place();
      assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(config.HARD_FLOOR_DAYS)], lockedElsewhere: false, config }).eligible, true);
      assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(config.HARD_FLOOR_DAYS + 1)], lockedElsewhere: false, config }).eligible, true);
    });

    // The actual bug this ticket had to avoid: a planned visit is routinely
    // dated AFTER `today` (this candidate is being ranked for an earlier day
    // in the window than the place's own planned date). An unsigned day-gap
    // there is a large negative number, which used to satisfy `< HARD_FLOOR_DAYS`
    // unconditionally and would have wrongly blocked every place with ANY
    // planned visit anywhere in the future, no matter how far out.
    test('a planned visit far in the future does not block an otherwise-eligible place', () => {
      const p = place();
      const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(-30)], lockedElsewhere: false, config });
      assert.equal(result.eligible, true);
    });

    test('a planned visit within the floor, but in the future, still blocks (bidirectional)', () => {
      const p = place();
      const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(-2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'hard_floor');
    });

    test('a due commitment suppresses FLOOR_PLANNED the same way it suppresses a completed floor conflict', () => {
      const p = place();
      const result = eligibility({ place: p, today: TODAY, lastVisitDate: null, nextVisitDate: TODAY, plannedVisitDates: [daysAgo(2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, true);
    });

    test('defaults to [] when omitted — every existing caller/test that never mentions plannedVisitDates is unaffected', () => {
      const p = place();
      assert.equal(eligibility({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, true);
    });
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

// Step 7 (capacity-computation-spec.md §8): EXPLORATION tier tie-break.
describe('explorationRank() — spec §8.2', () => {
  test('base ordering: high < medium < low at zero wait (pure capacity guess)', () => {
    assert.equal(explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 0, config }), 0);
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: 0, config }), 1);
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: 0, config }), 2);
  });

  test('stale sorts below unknown at equal capacity — "never-asked outranks re-asked"', () => {
    const unknownMedium = explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: 0, config });
    const staleMedium = explorationRank({ level: 'medium', confidence: 'stale', daysWaiting: 0, config });
    assert.ok(unknownMedium < staleMedium, 'a lower explorationRank sorts first — unknown must be lower than stale here');
  });

  test('aging pulls the rank down exactly at EXPLORATION_AGING_DAYS multiples, inert before them', () => {
    // medium: baseRank 1. Needs 1 full aging window to reach 0.
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS - 1, config }), 1, 'not yet aged a full window -> unchanged');
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS, config }), 0, 'exactly one aging window -> reaches rank 0');

    // low: baseRank 2. Needs 2 full aging windows to reach 0.
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS, config }), 1, 'one aging window is only halfway for a low-capacity place');
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS * 2, config }), 0, 'two aging windows -> reaches rank 0');
  });

  test('clamped at 0, never negative — a place cannot age past the front of the tier', () => {
    assert.equal(explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 10000, config }), 0);
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS * 5, config }), 0);
  });

  test('a low/unknown place waiting a full aging cycle sorts above a high place waiting 0 days; at daysWaiting=0 for both, ordering is pure capacity', () => {
    const waitedLow = explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS * 2, config });
    const freshHigh = explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 0, config });
    assert.ok(waitedLow <= freshHigh, 'a fully-aged low place should reach parity with (or beat) a freshly-eligible high place');

    const zeroLow = explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: 0, config });
    const zeroHigh = explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 0, config });
    assert.ok(zeroHigh < zeroLow, 'with no aging credit anywhere, capacity guess alone decides the order');
  });
});

describe('EXPLORATION tier membership — governed by confidence, not the legacy capacity_status latch', () => {
  test('capacityConfidence: "fresh" keeps a place OUT of exploration even if the legacy column still says "estimated"', () => {
    const p = place({ capacity_status: 'estimated', capacity_level: 'high', relationship_level: 'weak' }); // cadence 7
    const key = rankKey({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, capacityConfidence: 'fresh', today: TODAY, config });
    assert.notEqual(key[0], TIERS.EXPLORATION, 'confidence must govern membership now, not the stale capacity_status column');
    assert.equal(key[0], TIERS.MAINTENANCE, 'mildly overdue, fresh, and not neglected -> ordinary maintenance ordering');
  });

  test('capacityConfidence: "stale" RE-ENTERS exploration even if the legacy column still says "verified" — impossible under the old one-way latch', () => {
    const p = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'weak' });
    const key = rankKey({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, capacityConfidence: 'stale', today: TODAY, config });
    assert.equal(key[0], TIERS.EXPLORATION, 'a place whose declared number has gone stale must re-enter EXPLORATION for a fresh re-ask');
  });

  test('the fallback (no capacityConfidence supplied) still reproduces the OLD gate exactly, for this module\'s own bare-place tests', () => {
    const estimated = place({ capacity_status: 'estimated' });
    const verified = place({ capacity_status: 'verified', relationship_level: 'weak', capacity_level: 'medium' });
    assert.equal(rankKey({ place: estimated, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.EXPLORATION);
    assert.equal(rankKey({ place: verified, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.MAINTENANCE);
  });
});

describe('EXPLORATION ordering determinism and tiebreaks — spec §8.1/§13', () => {
  test('priority_score breaks a tie in explorationRank, descending', () => {
    const lowPriority = place({ capacity_status: 'estimated', capacity_level: 'medium', priority_score: 10 });
    const highPriority = place({ capacity_status: 'estimated', capacity_level: 'medium', priority_score: 90 });

    const ranked = rankCandidates(
      [
        { place: lowPriority, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: highPriority, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, highPriority, 'equal explorationRank -> higher priority_score sorts first');
  });

  test('place.id is the final deterministic tiebreak, ascending, once explorationRank and priority_score both tie', () => {
    const first = place({ capacity_status: 'estimated', capacity_level: 'medium', priority_score: 50 });
    const second = place({ capacity_status: 'estimated', capacity_level: 'medium', priority_score: 50 });
    const [lower, higher] = first.id < second.id ? [first, second] : [second, first];

    const ranked = rankCandidates(
      [
        { place: higher, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: lower, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, lower, 'fully tied on rank and priority -> lower place.id sorts first');
  });

  test('ordering is deterministic across repeated runs and independent of input array order, on identical data', () => {
    const places = ['low', 'medium', 'high', 'low', 'medium', 'high', 'low'].map((level, i) =>
      place({ capacity_status: 'estimated', capacity_level: level, priority_score: (i * 7) % 5 })
    );
    const candidates = places.map((p) => ({ place: p, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null }));

    const runA = rankCandidates(candidates, { today: TODAY, config }).map((c) => c.place.id);
    const runB = rankCandidates([...candidates].reverse(), { today: TODAY, config }).map((c) => c.place.id);
    const runC = rankCandidates([...candidates], { today: TODAY, config }).map((c) => c.place.id);

    assert.deepEqual(runB, runA, 'reversing the input order must not change the output order');
    assert.deepEqual(runC, runA, 'repeated runs over identical data must produce identical order');
  });

  test('compareRankKeys generalizes cleanly to EXPLORATION\'s 4-element key alongside every other tier\'s 2-element key', () => {
    const commitmentKey = [TIERS.COMMITMENT, 3];
    const explorationKeyIdTwo = [TIERS.EXPLORATION, -1, 50, -2]; // place.id 2 (negated)
    const explorationKeyIdOne = [TIERS.EXPLORATION, -1, 50, -1]; // place.id 1 (negated) — should sort first
    assert.ok(compareRankKeys(commitmentKey, explorationKeyIdTwo) < 0, 'lower tier always wins regardless of within-tier key length');
    assert.ok(compareRankKeys(explorationKeyIdTwo, explorationKeyIdOne) > 0, 'tier and rank tied -> the key encoding the smaller place.id must sort first');
  });
});
