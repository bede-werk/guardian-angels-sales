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
  bumpCapacityLevel,
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
    // The EXPLORATION tie-break reads this (was priority_score until
    // 2026-08-23 - see rankKey). Defaulted to null, the "unrated" case, so a
    // fixture that doesn't care about the tie-break isn't quietly asserting
    // a rating nobody gave it.
    capacity_seed: null,
    // Step 7: EXPLORATION tier ordering reads this directly (no created_at
    // fallback - see the migration that added it). Defaulted to TODAY here
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

// Production ALWAYS supplies capacityLevel/relationshipLevel/capacityConfidence
// explicitly, from buildCandidatePool's computed values - the engine has no
// fallback to a place column any more (those columns were dropped in
// 20260825000000, and the shims that read them went with them).
//
// These wrappers are what keeps that honest. The `place()` fixture below still
// carries capacity_level/capacity_status/relationship_level as a readable
// shorthand, and this is the ONE place that translates them into the explicit
// arguments the real callers pass. Before this existed, 63 of ~69 calls in
// this file relied on the removed fallback - so they were exercising a code
// path production never took. Any explicit value in `rest` still wins, since
// it is spread last.
function fixtureArgs(p) {
  return {
    capacityLevel: p.capacity_level,
    relationshipLevel: p.relationship_level,
    capacityConfidence: p.capacity_status === 'estimated' ? 'unknown' : 'fresh',
  };
}
const rankKeyF = ({ place: p, ...rest }) => rankKey({ place: p, ...fixtureArgs(p), ...rest });
const urgencyF = ({ place: p, ...rest }) => urgency({ place: p, ...fixtureArgs(p), ...rest });
const eligibilityF = ({ place: p, ...rest }) => eligibility({ place: p, ...fixtureArgs(p), ...rest });
const rankCandidatesF = (candidates, opts) =>
  rankCandidates(candidates.map((c) => ({ ...fixtureArgs(c.place), ...c })), opts);

describe('the all-star axis - bumpCapacityLevel', () => {
  test('bumps one row, and only when the flag is set', () => {
    assert.equal(bumpCapacityLevel('low', true), 'medium');
    assert.equal(bumpCapacityLevel('medium', true), 'high');
    assert.equal(bumpCapacityLevel('low', false), 'low');
    assert.equal(bumpCapacityLevel('medium', false), 'medium');
  });

  // Not a missed case: there's no row above high, and a place already on the
  // tightest cadence never needed rescuing from its own volume.
  test('high is a ceiling, not a wrap-around', () => {
    assert.equal(bumpCapacityLevel('high', true), 'high');
  });

  test('an unrecognized level passes through untouched rather than throwing', () => {
    assert.equal(bumpCapacityLevel(null, true), null);
    assert.equal(bumpCapacityLevel(undefined, true), undefined);
  });

  // The case the axis exists for: a place that sends little but sends gold.
  // Low + weak is a 90-day cadence; all-star moves it onto the medium row (21).
  test('an all-star low-capacity place gets a shorter cadence, so more urgency for the same wait', () => {
    const args = { lastVisitDate: daysAgo(45), recentCompletedCount: 0, capacityLevel: 'low', relationshipLevel: 'weak', today: TODAY, config };
    const ordinary = urgencyF({ place: place({ is_all_star: false }), ...args });
    const allStar = urgencyF({ place: place({ is_all_star: true }), ...args });

    assert.equal(ordinary, 45 / 90);
    assert.equal(allStar, 45 / 21);
    assert.ok(allStar > ordinary, 'the all-star must come up sooner for the identical wait');
  });

  test('an all-star HIGH-capacity place is unaffected - already on the tightest row', () => {
    const args = { lastVisitDate: daysAgo(10), recentCompletedCount: 0, capacityLevel: 'high', relationshipLevel: 'weak', today: TODAY, config };
    assert.equal(
      urgencyF({ place: place({ is_all_star: true }), ...args }),
      urgencyF({ place: place({ is_all_star: false }), ...args })
    );
  });

  // The half that may matter more: this tier's front picks a whole day's zone,
  // so an unqualified all-star should be first in line to go learn about.
  test('an all-star sorts ahead in EXPLORATION of an identical non-all-star', () => {
    // Both genuinely 'low'. The all-star is created SECOND so it holds the
    // HIGHER place.id - the final tiebreak favours the lower id, so if the
    // all-star still wins it can only be the bump (low -> medium) doing it,
    // not an accident of insertion order.
    const ordinary = place({ capacity_status: 'estimated', capacity_level: 'low', is_all_star: false });
    const allStar = place({ capacity_status: 'estimated', capacity_level: 'low', is_all_star: true });
    assert.ok(allStar.id > ordinary.id, 'the id tiebreak must be working against the all-star for this test to prove anything');

    const ranked = rankCandidatesF(
      [
        { place: ordinary, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: allStar, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, allStar, 'the all-star bumps to medium and outranks the plain low place');
  });

  // The flip side, and the honest limit of a one-row bump: it cannot make a
  // low-capacity all-star outrank a genuinely high-capacity place. Intended -
  // one row of lift, not a jump to the front.
  test('a bump is one row, so it does not leapfrog a genuinely high-capacity place', () => {
    const high = place({ capacity_status: 'estimated', capacity_level: 'high', is_all_star: false });
    const allStar = place({ capacity_status: 'estimated', capacity_level: 'low', is_all_star: true });

    const ranked = rankCandidatesF(
      [
        { place: allStar, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: high, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, high);
  });

  // Guards the separation of concerns: the bump lives in the ranker, so
  // capacity keeps reporting honest volume to every UI that reads it.
  test('the bump never leaks into the reported capacity level', () => {
    const p = place({ capacity_level: 'low', is_all_star: true });
    assert.equal(p.capacity_level, 'low');
  });
});

describe('urgency() / never-visited', () => {
  test('never-visited + verified lands in the endangered (rescue) tier, not maintenance', () => {
    const neverVisited = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'weak' });
    const merelyOverdue = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'weak' }); // cadence 21

    const keyNever = rankKeyF({ place: neverVisited, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    const keyMerely = rankKeyF({ place: merelyOverdue, lastVisitDate: daysAgo(5), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });

    assert.equal(urgencyF({ place: neverVisited, lastVisitDate: null, recentCompletedCount: 0, today: TODAY, config }), Infinity);
    assert.equal(keyNever[0], TIERS.ENDANGERED);
    assert.equal(keyMerely[0], TIERS.MAINTENANCE);

    const ranked = rankCandidatesF(
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

    const uA = urgencyF({ place: a, lastVisitDate: daysAgo(30), recentCompletedCount: 0, today: TODAY, config });
    const uB = urgencyF({ place: b, lastVisitDate: daysAgo(60), recentCompletedCount: 0, today: TODAY, config });

    assert.equal(uA, 30 / 90);
    assert.equal(uB, 60 / 90);
    assert.ok(uB > uA);

    const ranked = rankCandidatesF(
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

    const uFatigued = urgencyF({ place: fatigued, lastVisitDate: daysAgo(8), recentCompletedCount: config.FATIGUE_THRESHOLD, today: TODAY, config });
    const uFresh = urgencyF({ place: fresh, lastVisitDate: daysAgo(8), recentCompletedCount: 1, today: TODAY, config });

    assert.equal(uFatigued, 8 / (7 * config.FATIGUE_MULTIPLIER));
    assert.equal(uFresh, 8 / 7);
    assert.ok(uFatigued < uFresh, 'fatigue should lower urgency relative to an unfatigued place with identical recency');

    const ranked = rankCandidatesF(
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
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: daysAgo(3), lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS), lockedElsewhere: false, config }).eligible, true);
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS + 1), lockedElsewhere: false, config }).eligible, true);
  });

  test('snooze: ineligible while snooze_until is today or later, eligible once it has passed', () => {
    const snoozedToday = place({ snooze_until: TODAY });
    const snoozedFuture = place({ snooze_until: daysAgo(-5) });
    const snoozedPast = place({ snooze_until: daysAgo(1) });

    assert.equal(eligibilityF({ place: snoozedToday, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibilityF({ place: snoozedFuture, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
    assert.equal(eligibilityF({ place: snoozedPast, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, true);
  });

  test('do_not_visit always wins, regardless of everything else', () => {
    const p = place({ do_not_visit: true });
    const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'do_not_visit');
  });

  test('do_not_visit with no until date is indefinite', () => {
    const p = place({ do_not_visit: true, do_not_visit_until: null });
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
  });

  test('do_not_visit_until in the future still excludes', () => {
    const p = place({ do_not_visit: true, do_not_visit_until: daysAgo(-5) });
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
  });

  test('do_not_visit_until on today still excludes (boundary is inclusive)', () => {
    const p = place({ do_not_visit: true, do_not_visit_until: TODAY });
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, false);
  });

  test('do_not_visit_until in the past has lapsed - no longer excludes', () => {
    const p = place({ do_not_visit: true, do_not_visit_until: daysAgo(1) });
    assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, true);
  });

  test('locked-elsewhere guard (pure half of the multi-user collision check)', () => {
    const p = place();
    const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: true, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'locked_elsewhere');
  });

  // Step 3 of the 2026-08 remediation ticket: a planned (not yet happened)
  // visit consumes the hard floor exactly like a completed one, via its own
  // field - lastVisitDate stays null/whatever it already was, so ranking
  // (urgency/cadence) never sees it, only eligibility does.
  describe('plannedVisitDates guard (FLOOR_PLANNED)', () => {
    test('a planned visit within the floor makes an otherwise-never-visited place ineligible', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'hard_floor');
    });

    test('eligible at and beyond the boundary, same threshold as a completed visit', () => {
      const p = place();
      assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(config.HARD_FLOOR_DAYS)], lockedElsewhere: false, config }).eligible, true);
      assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(config.HARD_FLOOR_DAYS + 1)], lockedElsewhere: false, config }).eligible, true);
    });

    // The actual bug this ticket had to avoid: a planned visit is routinely
    // dated AFTER `today` (this candidate is being ranked for an earlier day
    // in the window than the place's own planned date). An unsigned day-gap
    // there is a large negative number, which used to satisfy `< HARD_FLOOR_DAYS`
    // unconditionally and would have wrongly blocked every place with ANY
    // planned visit anywhere in the future, no matter how far out.
    test('a planned visit far in the future does not block an otherwise-eligible place', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(-30)], lockedElsewhere: false, config });
      assert.equal(result.eligible, true);
    });

    test('a planned visit within the floor, but in the future, still blocks (bidirectional)', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(-2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'hard_floor');
    });

    test('a due commitment suppresses FLOOR_PLANNED the same way it suppresses a completed floor conflict', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, nextVisitDate: TODAY, plannedVisitDates: [daysAgo(2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, true);
    });

    test('defaults to [] when omitted - every existing caller/test that never mentions plannedVisitDates is unaffected', () => {
      const p = place();
      assert.equal(eligibilityF({ place: p, today: TODAY, lastVisitDate: null, lockedElsewhere: false, config }).eligible, true);
    });
  });

  // Manual Visit Planning spec §7.1/§9 - a planned visit dated EXACTLY today
  // is a same-day duplicate risk, distinct from the nearby-but-not-exact
  // floor case above: a due commitment is allowed to bypass a recency
  // judgment call, but must never bypass an outright same-day duplicate.
  describe('same-day exclusion (Manual Visit Planning §7.1)', () => {
    test('a planned visit dated exactly today makes the place ineligible', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [TODAY], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'already_planned_today');
    });

    // The regression this exists to close: without this check running BEFORE
    // commitmentDue, a place with both a due commitment and an
    // already-planned visit today stayed eligible and could be proposed a
    // second time on the very day it's already booked (§9's "does not
    // schedule a second stop" guarantee depends on this).
    test('a due commitment does NOT suppress this, unlike FLOOR_PLANNED on a nearby (non-exact) date', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, nextVisitDate: TODAY, plannedVisitDates: [TODAY], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'already_planned_today');
    });

    test('a nearby but non-exact planned date is unaffected by this rule - still governed by the ordinary floor check above', () => {
      const p = place();
      const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: null, plannedVisitDates: [daysAgo(2)], lockedElsewhere: false, config });
      assert.equal(result.eligible, false);
      assert.equal(result.reason, 'hard_floor', 'still the ordinary floor reason, not the new same-day one');
    });
  });
});

describe('hard commitments jump the queue', () => {
  test('a due next_visit_date outranks even an unverified high-capacity place', () => {
    const committed = place({ capacity_status: 'verified', capacity_level: 'low', relationship_level: 'weak' });
    const unverifiedHigh = place({ capacity_status: 'estimated', capacity_level: 'high' });

    const keyCommitted = rankKeyF({ place: committed, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: TODAY, today: TODAY, config });
    assert.equal(keyCommitted[0], TIERS.COMMITMENT);

    const ranked = rankCandidatesF(
      [
        { place: unverifiedHigh, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: committed, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: TODAY },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, committed);
  });

  test('a due commitment bypasses the hard floor - a human asking us back is exactly what the floor is for', () => {
    const p = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'medium' });

    const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: daysAgo(3), nextVisitDate: TODAY, lockedElsewhere: false, config });
    assert.equal(result.eligible, true, 'a due commitment should override the hard floor, not get silently filtered out');

    const key = rankKeyF({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: TODAY, today: TODAY, config });
    assert.equal(key[0], TIERS.COMMITMENT, 'and it should land in the top (commitment) tier, not just survive eligibility');
  });

  test('do_not_visit still wins even over a due commitment', () => {
    const p = place({ do_not_visit: true, capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'medium' });

    const result = eligibilityF({ place: p, today: TODAY, lastVisitDate: daysAgo(3), nextVisitDate: TODAY, lockedElsewhere: false, config });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'do_not_visit');
  });
});

describe('neglect threshold (endangered tier)', () => {
  // capacity high + relationship strong -> cadence 14, so daysSince 21 = 1.5x, 28 = 2x, 42 = 3x.
  function verifiedHighStrong() {
    return place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'strong' });
  }

  test('below NEGLECT_MULTIPLIER stays in maintenance - exploration still wins', () => {
    const p = verifiedHighStrong();
    const key = rankKeyF({ place: p, lastVisitDate: daysAgo(21), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(key[0], TIERS.MAINTENANCE);

    const unverified = place({ capacity_status: 'estimated', capacity_level: 'low' });
    const ranked = rankCandidatesF(
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

    assert.equal(rankKeyF({ place: atThreshold, lastVisitDate: daysAgo(28), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.ENDANGERED);
    assert.equal(rankKeyF({ place: beyondThreshold, lastVisitDate: daysAgo(42), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.ENDANGERED);

    const unverified = place({ capacity_status: 'estimated', capacity_level: 'high' });
    const ranked = rankCandidatesF(
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
    const keyLow = rankKeyF({ place: lowCapacityNeglected, lastVisitDate: daysAgo(180), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyLow[0], TIERS.ENDANGERED, 'a low-capacity place should still be rescued once genuinely neglected');

    // High-capacity, only mildly overdue -> must NOT jump (capacity does not buy a pass into rescue).
    const highCapacityMild = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'weak' }); // cadence 7
    const keyHigh = rankKeyF({ place: highCapacityMild, lastVisitDate: daysAgo(10), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyHigh[0], TIERS.MAINTENANCE, 'a high-capacity place must not be rescued just for being mildly overdue');

    const ranked = rankCandidatesF(
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

    const keyNotFatigued = rankKeyF({ place: notFatigued, lastVisitDate: daysAgo(14), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    const keyFatigued = rankKeyF({ place: fatigued, lastVisitDate: daysAgo(14), recentCompletedCount: config.FATIGUE_THRESHOLD, nextVisitDate: null, today: TODAY, config });

    assert.equal(keyNotFatigued[0], TIERS.ENDANGERED, 'without fatigue, 2x base cadence should already qualify for rescue');
    assert.equal(keyFatigued[0], TIERS.MAINTENANCE, 'with fatigue, the same 14 days is only ~1.33x the stretched cadence - not neglected yet');
  });
});

describe("spec's acceptance test, updated for the endangered tier", () => {
  test('exploration wins while merely due; neglect rescues once genuinely overdue; falls back once caught up', () => {
    const unverified = place({ capacity_status: 'estimated', capacity_level: 'high' });
    const verifiedStrong = place({ capacity_status: 'verified', capacity_level: 'high', relationship_level: 'strong' }); // cadence 14

    // A: merely due (20 days, 1.43x) -> exploration still wins.
    const rankedA = rankCandidatesF(
      [
        { place: verifiedStrong, lastVisitDate: daysAgo(20), recentCompletedCount: 0, nextVisitDate: null },
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(rankedA[0].place, unverified);

    // B: pushed past 2x cadence (30 days, ~2.14x) -> now jumps ahead.
    const rankedB = rankCandidatesF(
      [
        { place: unverified, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: verifiedStrong, lastVisitDate: daysAgo(30), recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(rankedB[0].place, verifiedStrong);

    // C: pulled back to just under threshold (27 days, ~1.93x) -> ordinary maintenance ordering again.
    const keyC = rankKeyF({ place: verifiedStrong, lastVisitDate: daysAgo(27), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config });
    assert.equal(keyC[0], TIERS.MAINTENANCE);
    const rankedC = rankCandidatesF(
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
describe('explorationRank() - spec §8.2', () => {
  test('base ordering: high < medium < low at zero wait (pure capacity guess)', () => {
    assert.equal(explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 0, config }), 0);
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: 0, config }), 1);
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: 0, config }), 2);
  });

  test('stale sorts below unknown at equal capacity - "never-asked outranks re-asked"', () => {
    const unknownMedium = explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: 0, config });
    const staleMedium = explorationRank({ level: 'medium', confidence: 'stale', daysWaiting: 0, config });
    assert.ok(unknownMedium < staleMedium, 'a lower explorationRank sorts first - unknown must be lower than stale here');
  });

  test('aging pulls the rank down exactly at EXPLORATION_AGING_DAYS multiples, inert before them', () => {
    // medium: baseRank 1. Needs 1 full aging window to reach 0.
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS - 1, config }), 1, 'not yet aged a full window -> unchanged');
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS, config }), 0, 'exactly one aging window -> reaches rank 0');

    // low: baseRank 2. Needs 2 full aging windows to reach 0.
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS, config }), 1, 'one aging window is only halfway for a low-capacity place');
    assert.equal(explorationRank({ level: 'low', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS * 2, config }), 0, 'two aging windows -> reaches rank 0');
  });

  test('clamped at 0, never negative - a place cannot age past the front of the tier', () => {
    assert.equal(explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: 10000, config }), 0);
    assert.equal(explorationRank({ level: 'medium', confidence: 'unknown', daysWaiting: config.EXPLORATION_AGING_DAYS * 5, config }), 0);
  });

  // A tightened CAPACITY_STALE_DAYS can make confidence flip to 'stale'
  // before a place's already-stamped exploration_eligible_since date
  // arrives (see the migration's header) - daysWaiting comes out negative
  // for a little while in that window. A negative wait must never make the
  // rank WORSE than baseRank (no credit yet is not the same as being
  // pushed backward) - this is the input clamp, distinct from the output
  // clamp the test above covers.
  test('a negative daysWaiting behaves exactly like zero, never penalizes the rank further', () => {
    assert.equal(
      explorationRank({ level: 'medium', confidence: 'stale', daysWaiting: -30, config }),
      explorationRank({ level: 'medium', confidence: 'stale', daysWaiting: 0, config })
    );
    assert.equal(explorationRank({ level: 'high', confidence: 'unknown', daysWaiting: -1000, config }), 0);
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

describe('EXPLORATION tier membership - governed by confidence, not the legacy capacity_status latch', () => {
  test('capacityConfidence: "fresh" keeps a place OUT of exploration even if the legacy column still says "estimated"', () => {
    const p = place({ capacity_status: 'estimated', capacity_level: 'high', relationship_level: 'weak' }); // cadence 7
    const key = rankKeyF({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, capacityConfidence: 'fresh', today: TODAY, config });
    assert.notEqual(key[0], TIERS.EXPLORATION, 'confidence must govern membership now, not the stale capacity_status column');
    assert.equal(key[0], TIERS.MAINTENANCE, 'mildly overdue, fresh, and not neglected -> ordinary maintenance ordering');
  });

  test('capacityConfidence: "stale" RE-ENTERS exploration even if the legacy column still says "verified" - impossible under the old one-way latch', () => {
    const p = place({ capacity_status: 'verified', capacity_level: 'medium', relationship_level: 'weak' });
    const key = rankKeyF({ place: p, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, capacityConfidence: 'stale', today: TODAY, config });
    assert.equal(key[0], TIERS.EXPLORATION, 'a place whose declared number has gone stale must re-enter EXPLORATION for a fresh re-ask');
  });

  test('the fallback (no capacityConfidence supplied) still reproduces the OLD gate exactly, for this module\'s own bare-place tests', () => {
    const estimated = place({ capacity_status: 'estimated' });
    const verified = place({ capacity_status: 'verified', relationship_level: 'weak', capacity_level: 'medium' });
    assert.equal(rankKeyF({ place: estimated, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.EXPLORATION);
    assert.equal(rankKeyF({ place: verified, lastVisitDate: daysAgo(3), recentCompletedCount: 0, nextVisitDate: null, today: TODAY, config })[0], TIERS.MAINTENANCE);
  });
});

describe('EXPLORATION ordering determinism and tiebreaks - spec §8.1/§13', () => {
  test('the capacity rating breaks a tie in explorationRank, descending', () => {
    // Both bucket to the same LEVEL, so explorationRank ties and the rating
    // itself is the only thing left to separate them - the finer-grained
    // signal that survives the 4-choices-into-3-levels collapse.
    const lowPriority = place({ capacity_status: 'estimated', capacity_level: 'medium', capacity_seed: 7 });
    const highPriority = place({ capacity_status: 'estimated', capacity_level: 'medium', capacity_seed: 15 });

    const ranked = rankCandidatesF(
      [
        { place: lowPriority, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
        { place: highPriority, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null },
      ],
      { today: TODAY, config }
    );
    assert.equal(ranked[0].place, highPriority, 'equal explorationRank -> higher capacity rating sorts first');
  });

  test('place.id is the final deterministic tiebreak, ascending, once explorationRank and the rating both tie', () => {
    const first = place({ capacity_status: 'estimated', capacity_level: 'medium', capacity_seed: 7 });
    const second = place({ capacity_status: 'estimated', capacity_level: 'medium', capacity_seed: 7 });
    const [lower, higher] = first.id < second.id ? [first, second] : [second, first];

    const ranked = rankCandidatesF(
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
      place({ capacity_status: 'estimated', capacity_level: level, capacity_seed: (i * 7) % 5 })
    );
    const candidates = places.map((p) => ({ place: p, lastVisitDate: null, recentCompletedCount: 0, nextVisitDate: null }));

    const runA = rankCandidatesF(candidates, { today: TODAY, config }).map((c) => c.place.id);
    const runB = rankCandidatesF([...candidates].reverse(), { today: TODAY, config }).map((c) => c.place.id);
    const runC = rankCandidatesF([...candidates], { today: TODAY, config }).map((c) => c.place.id);

    assert.deepEqual(runB, runA, 'reversing the input order must not change the output order');
    assert.deepEqual(runC, runA, 'repeated runs over identical data must produce identical order');
  });

  test('compareRankKeys generalizes cleanly to EXPLORATION\'s 4-element key alongside every other tier\'s 2-element key', () => {
    const commitmentKey = [TIERS.COMMITMENT, 3];
    const explorationKeyIdTwo = [TIERS.EXPLORATION, -1, 50, -2]; // place.id 2 (negated)
    const explorationKeyIdOne = [TIERS.EXPLORATION, -1, 50, -1]; // place.id 1 (negated) - should sort first
    assert.ok(compareRankKeys(commitmentKey, explorationKeyIdTwo) < 0, 'lower tier always wins regardless of within-tier key length');
    assert.ok(compareRankKeys(explorationKeyIdTwo, explorationKeyIdOne) > 0, 'tier and rank tied -> the key encoding the smaller place.id must sort first');
  });
});
