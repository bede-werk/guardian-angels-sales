const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const defaultVisitTypesConfig = require('../config/visitTypes');
const defaultRouteOptimizerConfig = require('../config/routeOptimizer');
const { estimateDriveMinutes } = require('./driveTime');
const { TIERS } = require('./schedulingEngine');
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

// A stub optimizeRoute that just puts stops in reverse of whatever order
// they're given, with a flat legMinutes for every leg — deterministic and
// distinguishable from packTimeBlock's rank-order fallback, so tests can
// prove fillDayFromZone actually used the optimizer's answer.
function reversingOptimizer(legMinutes = 10) {
  return async ({ stops }) => ({
    orderedStops: [...stops].reverse(),
    legMinutes: stops.map(() => legMinutes),
  });
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

  test('throws instead of looping forever when workingWeekdays is empty', () => {
    assert.throws(
      () => workingDays({ today: TODAY, daysAhead: 3, workingWeekdays: [], exceptionDates: [] }),
      /no working day found/
    );
  });

  test('throws instead of looping forever when exceptionDates covers every remaining candidate day', () => {
    // Every Mon-Fri date within the scan window is excepted, so no amount of
    // scanning will ever find daysAhead working days.
    const exceptionDates = [];
    let cursor = '2026-07-13';
    for (let i = 0; i < 60; i++) {
      cursor = new Date(new Date(cursor + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
      exceptionDates.push(cursor);
    }
    assert.throws(
      () => workingDays({ today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates }),
      /no working day found/
    );
  });
});

describe('fillDayFromZone', () => {
  test('packs only in-zone candidates, preserving rank order', async () => {
    const c1 = candidate(place(1, { region: 'East Lincoln' }));
    const c2 = candidate(place(2, { region: 'Southwest Lincoln' }));
    const c3 = candidate(place(3, { region: 'East Lincoln' }));

    const result = await fillDayFromZone({
      candidates: [c1, c2, c3],
      zone: 'East Lincoln',
      homeBase: DOWNTOWN,
      budgetMinutes: 1000,
    });

    assert.deepEqual(result.stops.map((s) => s.place_id), [1, 3]);
  });

  test('returns empty stops with full remainingMinutes when the zone has no candidates', async () => {
    const c1 = candidate(place(1, { region: 'East Lincoln' }));
    const result = await fillDayFromZone({ candidates: [c1], zone: 'Nowhere', homeBase: DOWNTOWN, budgetMinutes: 100 });
    assert.deepEqual(result.stops, []);
    assert.equal(result.totalMinutes, 0);
    assert.equal(result.remainingMinutes, 100);
  });

  test("resolves each stop's visitType from place.default_visit_type, falling back to DEFAULT_VISIT_TYPE when null", async () => {
    const c1 = candidate(place(1, { default_visit_type: 'presentation' }));
    const c2 = candidate(place(2, { default_visit_type: null }));

    const result = await fillDayFromZone({ candidates: [c1, c2], zone: 'East Lincoln', homeBase: DOWNTOWN, budgetMinutes: 1000 });

    assert.equal(result.stops[0].visitType, 'presentation');
    assert.equal(result.stops[1].visitType, defaultVisitTypesConfig.DEFAULT_VISIT_TYPE);
  });

  test("chains drive time from homeBase for the first stop", async () => {
    const c1 = candidate(place(1, { region: 'East Lincoln', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }));
    const result = await fillDayFromZone({ candidates: [c1], zone: 'East Lincoln', homeBase: DOWNTOWN, budgetMinutes: 1000 });
    assert.equal(result.stops[0].driveMinutes, estimateDriveMinutes(DOWNTOWN, EAST_LINCOLN, {}));
  });

  describe('with optimizeRoute (phase 5)', () => {
    test('uses the optimizer\'s order and leg minutes instead of rank-order/haversine', async () => {
      const c1 = candidate(place(1, { region: 'East Lincoln' }));
      const c2 = candidate(place(2, { region: 'East Lincoln' }));

      const result = await fillDayFromZone({
        candidates: [c1, c2],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: reversingOptimizer(7),
      });

      assert.deepEqual(result.stops.map((s) => s.place_id), [2, 1], 'reversingOptimizer should flip rank order');
      assert.ok(result.stops.every((s) => s.driveMinutes === 7));
    });

    test('falls back to packTimeBlock (rank order + haversine) when the optimizer returns null', async () => {
      const c1 = candidate(place(1, { region: 'East Lincoln' }));
      const c2 = candidate(place(2, { region: 'East Lincoln' }));
      const failingOptimizer = async () => null;

      const result = await fillDayFromZone({
        candidates: [c1, c2],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: failingOptimizer,
      });

      assert.deepEqual(result.stops.map((s) => s.place_id), [1, 2], 'unoptimized fallback should preserve rank order');
    });

    test('caps the optimizer input pool at routeOptimizerConfig.MAX_OPTIMIZE_STOPS', async () => {
      // A generous budget means the top-up pass will keep calling the
      // optimizer with progressively larger stop sets after the initial
      // call — capture only the FIRST call to isolate the pool-cap behavior
      // itself from top-up's separate, intentional reach-past-the-cap logic.
      const candidates = Array.from({ length: 5 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln' })));
      let firstCallStopCount = null;
      const capturingOptimizer = async ({ stops }) => {
        if (firstCallStopCount === null) firstCallStopCount = stops.length;
        return { orderedStops: stops, legMinutes: stops.map(() => 5) };
      };

      await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: capturingOptimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 3 },
      });

      assert.equal(firstCallStopCount, 3, 'only the top 3 rank-ordered candidates should be offered to the initial optimize call');
    });

    test('tops up leftover budget with the next-best-ranked candidate beyond the pool cap', async () => {
      // 4 same-zone drop_in candidates (each a 16min block: 1min flat drive +
      // 7 visit + 3 prep + 5 data-entry), cap of 2 for the initial optimize
      // call. Budget of 50 fits exactly 3 blocks (48) but not 4 (64) — the
      // top-up pass should reach past the pool cap to pull candidate 3 in,
      // then reject candidate 4 once it no longer fits.
      const candidates = Array.from({ length: 4 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln', default_visit_type: 'drop_in' })));
      const optimizer = async ({ stops }) => ({ orderedStops: stops, legMinutes: stops.map(() => 1) });

      const result = await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 50,
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 2, MIN_TOPUP_MINUTES: 1 },
      });

      assert.deepEqual(result.stops.map((s) => s.place_id).sort(), [1, 2, 3], 'top-up should pull candidate 3 in beyond the pool cap of 2, but reject candidate 4 once the budget is exhausted');
    });

    test('does not attempt a top-up re-optimize call once remainingMinutes drops below MIN_TOPUP_MINUTES', async () => {
      const candidates = Array.from({ length: 2 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln', default_visit_type: 'presentation' })));
      let calls = 0;
      const optimizer = async ({ stops }) => {
        calls += 1;
        return { orderedStops: stops, legMinutes: stops.map(() => 0) };
      };
      const presentationBlock = defaultVisitTypesConfig.VISIT_TYPES.presentation.minutes + defaultVisitTypesConfig.PREP_MINUTES + defaultVisitTypesConfig.DATA_ENTRY_MINUTES;

      await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: presentationBlock, // exactly enough for one stop, 0 leftover
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 1, MIN_TOPUP_MINUTES: 1 },
      });

      assert.equal(calls, 1, 'only the initial optimize call should happen; top-up should never fire with 0 remainingMinutes left');
    });

    test('never regresses: a candidate that would shrink the packed set after re-optimizing is rejected', async () => {
      const c1 = candidate(place(1, { region: 'East Lincoln', default_visit_type: 'drop_in' }));
      const c2 = candidate(place(2, { region: 'East Lincoln', default_visit_type: 'drop_in' }));

      // First call (the initial optimize) packs both fine; the top-up pass's
      // re-optimize call reports a huge leg time that blows the budget,
      // which would otherwise trim the packed set back down to 0 or 1.
      let call = 0;
      const optimizer = async ({ stops }) => {
        call += 1;
        if (call === 1) return { orderedStops: stops, legMinutes: stops.map(() => 1) };
        return { orderedStops: stops, legMinutes: stops.map(() => 9999) };
      };

      const result = await fillDayFromZone({
        candidates: [c1, c2],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 1, MIN_TOPUP_MINUTES: 1 },
      });

      assert.equal(result.stops.length, 1, 'the regressive re-optimize result should be rejected, keeping the original single packed stop');
    });

    test('droppedCommitments surfaces a commitment trimmed by the budget after the optimizer resequences it out', async () => {
      const commitmentPlace = candidate(place(1, { region: 'East Lincoln', default_visit_type: 'drop_in' }), { rankKey: [TIERS.COMMITMENT, 5] });
      const otherPlace = candidate(place(2, { region: 'East Lincoln', default_visit_type: 'drop_in' }));

      // The optimizer sequences the commitment LAST despite rank order
      // putting it first in the input — the accepted sequencing tradeoff —
      // but here the tight budget only fits one stop, so the commitment
      // loses its spot on the day entirely, not just its position.
      const reorderingOptimizer = async ({ stops }) => ({ orderedStops: [...stops].reverse(), legMinutes: stops.map(() => 1) });

      const result = await fillDayFromZone({
        candidates: [commitmentPlace, otherPlace],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 16, // fits exactly one drop_in block (1 drive + 7 + 3 + 5), not two
        optimizeRoute: reorderingOptimizer,
        routeOptimizerConfig: { MIN_TOPUP_MINUTES: 1000 }, // disable top-up so it can't rescue the commitment, isolating this check
      });

      assert.deepEqual(result.stops.map((s) => s.place_id), [2], 'the optimizer put the commitment last, so the tight budget packed the other stop instead');
      assert.deepEqual(result.droppedCommitments.map((s) => s.place_id), [1], 'the dropped commitment should be surfaced, not silently lost');
    });

    test('droppedCommitments is empty when nothing was dropped', async () => {
      const commitmentPlace = candidate(place(1, { region: 'East Lincoln' }), { rankKey: [TIERS.COMMITMENT, 5] });
      const result = await fillDayFromZone({
        candidates: [commitmentPlace],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: reversingOptimizer(5),
      });
      assert.deepEqual(result.droppedCommitments, []);
    });

    test('topUpDay stops growing the packed set once MAX_TOPUP_STOPS is hit, even with budget and candidates left', async () => {
      const candidates = Array.from({ length: 6 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln', default_visit_type: 'drop_in' })));
      const optimizer = async ({ stops }) => ({ orderedStops: stops, legMinutes: stops.map(() => 1) });

      const result = await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000, // generous — budget alone would fit all 6
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 2, MAX_TOPUP_STOPS: 3, MIN_TOPUP_MINUTES: 1 },
      });

      assert.equal(result.stops.length, 3, 'top-up should stop growing the packed set once MAX_TOPUP_STOPS is hit, even though budget and candidates remain');
    });

    test('a candidate that fails to fit after re-optimizing is skipped, not treated as the end of top-up', async () => {
      // Candidate 3 is deliberately "bad" (the optimizer reports it blows
      // the budget); candidate 4 is "good" (fits fine). Top-up should skip
      // 3 and still pick up 4, rather than giving up the moment 3 fails.
      const candidates = Array.from({ length: 4 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln', default_visit_type: 'drop_in' })));
      const optimizer = async ({ stops }) => {
        const includesBadCandidate = stops.some((s) => s.place_id === 3);
        return { orderedStops: stops, legMinutes: stops.map(() => (includesBadCandidate ? 9999 : 1)) };
      };

      const result = await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 50, // fits 3 cheap (16min) stops, never one that includes candidate 3's blown-up leg time
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 2, MIN_TOPUP_MINUTES: 1 },
      });

      assert.deepEqual(result.stops.map((s) => s.place_id).sort(), [1, 2, 4], 'candidate 3 should be skipped without blocking candidate 4 from being tried');
    });

    test('skips a network call for a candidate whose own visit type cannot fit the remaining budget', async () => {
      const cheap = candidate(place(1, { region: 'East Lincoln', default_visit_type: 'drop_in' }));
      const tooLong = candidate(place(2, { region: 'East Lincoln', default_visit_type: 'presentation' }));

      let topUpCalls = 0;
      const optimizer = async ({ stops }) => {
        if (stops.length > 1) topUpCalls += 1; // only count calls beyond the initial single-candidate optimize
        return { orderedStops: stops, legMinutes: stops.map(() => 1) };
      };

      await fillDayFromZone({
        candidates: [cheap, tooLong],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 20, // room for the drop_in (16min) plus a sliver, nowhere near presentation's 68min block
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 1, MIN_TOPUP_MINUTES: 1 },
      });

      assert.equal(topUpCalls, 0, 'the presentation candidate should be ruled out locally, without spending a network call to discover it');
    });

    test('batches multiple leftover candidates into one re-optimize call instead of one call per stop', async () => {
      // 5 same-zone drop_in candidates, cap of 2 for the initial call. A
      // generous budget means all 3 leftover candidates can plausibly fit
      // together — top-up should fold them into ONE re-optimize call
      // rather than three separate one-at-a-time round-trips.
      const candidates = Array.from({ length: 5 }, (_, i) => candidate(place(i + 1, { region: 'East Lincoln', default_visit_type: 'drop_in' })));
      let topUpCallCount = 0;
      let lastBatchSize = 0;
      const optimizer = async ({ stops }) => {
        if (stops.length > 2) { topUpCallCount += 1; lastBatchSize = stops.length; }
        return { orderedStops: stops, legMinutes: stops.map(() => 1) };
      };

      const result = await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 2, MIN_TOPUP_MINUTES: 1 },
      });

      assert.equal(result.stops.length, 5, 'all 5 candidates should end up packed');
      assert.equal(topUpCallCount, 1, 'top-up should fold all 3 leftover candidates into ONE re-optimize call, not three');
      assert.equal(lastBatchSize, 5, 'that one call should include all 5 stops (2 already-packed + 3 batched in)');
    });

    test('a batch candidate that would overflow the batch total is skipped in favor of a cheaper later one, within the same round', async () => {
      // candidate 2 (presentation, 68min block) would blow the batch total
      // on its own; candidates 3 and 4 (drop_in, 15min blocks) are cheaper
      // and rank-ordered right behind it — the batch builder should skip 2
      // and still include 3 and 4 in the same round.
      const candidates = [
        candidate(place(1, { region: 'East Lincoln', default_visit_type: 'drop_in' })),
        candidate(place(2, { region: 'East Lincoln', default_visit_type: 'presentation' })),
        candidate(place(3, { region: 'East Lincoln', default_visit_type: 'drop_in' })),
        candidate(place(4, { region: 'East Lincoln', default_visit_type: 'drop_in' })),
      ];
      const optimizer = async ({ stops }) => ({ orderedStops: stops, legMinutes: stops.map(() => 1) });

      const result = await fillDayFromZone({
        candidates,
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 50, // fits candidate 1 (16min) + two more 16min drop_ins (48 total), never candidate 2's 69min block
        optimizeRoute: optimizer,
        routeOptimizerConfig: { MAX_OPTIMIZE_STOPS: 1, MIN_TOPUP_MINUTES: 1 },
      });

      assert.deepEqual(result.stops.map((s) => s.place_id).sort(), [1, 3, 4], 'candidate 2 should be skipped in favor of the cheaper candidates 3 and 4 in the same batch');
    });

    test('threads driveConfig through to optimizeRoute so a MIN_DRIVE_MINUTES override applies on the optimized path too', async () => {
      const c1 = candidate(place(1, { region: 'East Lincoln' }));
      let receivedDriveConfig = null;
      const capturingOptimizer = async ({ stops }, config, driveConfig) => {
        receivedDriveConfig = driveConfig;
        return { orderedStops: stops, legMinutes: stops.map(() => 1) };
      };

      await fillDayFromZone({
        candidates: [c1],
        zone: 'East Lincoln',
        homeBase: DOWNTOWN,
        budgetMinutes: 1000,
        driveConfig: { MIN_DRIVE_MINUTES: 15 },
        optimizeRoute: capturingOptimizer,
      });

      assert.equal(receivedDriveConfig.MIN_DRIVE_MINUTES, 15, 'driveConfig should reach optimizeRoute, not just the haversine fallback path');
    });
  });
});

describe('generateDraft', () => {
  test('produces exactly daysAhead day entries in date order', async () => {
    const candidates = [candidate(place(1))];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 4, homeBase: DOWNTOWN,
    });
    assert.deepEqual(result.days.map((d) => d.date), ['2026-07-14', '2026-07-15', '2026-07-16']);
  });

  test("default zone shifts to the next-highest remaining candidate's region after dedupe", async () => {
    // East's best candidate (high capacity) outranks Southwest's (also high,
    // but East is listed first and capacityRank ties keep insertion order via
    // a stable sort) only for day 1; a tight budget fits exactly one stop, so
    // after day 1 dedupes East's top pick, day 2 should reconsider and pick
    // whichever region now has the top remaining candidate.
    const eastTop = candidate(place(1, { region: 'East Lincoln', capacity_level: 'high' }));
    const eastSecond = candidate(place(2, { region: 'East Lincoln', capacity_level: 'low' }));
    const southwestTop = candidate(place(3, { region: 'Southwest Lincoln', capacity_level: 'high', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }));

    const result = await generateDraft({
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

  test('zoneOverrides for a specific date wins over the computed default', async () => {
    const eastTop = candidate(place(1, { region: 'East Lincoln', capacity_level: 'high' }));
    const southwestPlace = candidate(place(2, { region: 'Southwest Lincoln', capacity_level: 'low', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }));

    const result = await generateDraft({
      candidates: [eastTop, southwestPlace],
      today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 4, homeBase: DOWNTOWN,
      zoneOverrides: { '2026-07-14': 'Southwest Lincoln' },
    });

    assert.equal(result.days[0].zone, 'Southwest Lincoln');
    assert.deepEqual(result.days[0].stops.map((s) => s.place_id), [2]);
  });

  test('multi-day dedupe: a place packed on an earlier day never reappears on a later day', async () => {
    const candidates = [
      candidate(place(1, { capacity_level: 'high' })),
      candidate(place(2, { capacity_level: 'medium' })),
      candidate(place(3, { capacity_level: 'low' })),
    ];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, // fits exactly one stop per day
      homeBase: DOWNTOWN,
    });

    const allPackedIds = result.days.flatMap((d) => d.stops.map((s) => s.place_id));
    assert.deepEqual(allPackedIds.sort(), [1, 2, 3]);
    assert.equal(new Set(allPackedIds).size, 3, 'no place should appear twice across the draft');
  });

  test('a candidate excluded by budget on day 1 remains available and gets packed on day 2', async () => {
    const candidates = [
      candidate(place(1, { capacity_level: 'high' })),
      candidate(place(2, { capacity_level: 'medium' })),
    ];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 2, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
    });

    assert.deepEqual(result.days[0].stops.map((s) => s.place_id), [1]);
    assert.deepEqual(result.days[1].stops.map((s) => s.place_id), [2]);
  });

  test('ineligible candidates (do_not_visit / hard floor / snoozed) never appear in any day\'s output', async () => {
    const blocked = candidate(place(1, { do_not_visit: true }));
    const snoozed = candidate(place(2, { snooze_until: '2026-07-20' }));
    const tooRecent = candidate(place(3, { capacity_status: 'verified' }), { lastVisitDate: '2026-07-13' }); // 1 day since -> under HARD_FLOOR_DAYS
    const eligible = candidate(place(4, { capacity_level: 'high' }));

    const result = await generateDraft({
      candidates: [blocked, snoozed, tooRecent, eligible],
      today: TODAY, daysAhead: 5, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    const allPackedIds = new Set(result.days.flatMap((d) => d.stops.map((s) => s.place_id)));
    assert.ok(!allPackedIds.has(1), 'do_not_visit place should never appear');
    assert.ok(!allPackedIds.has(2), 'snoozed place should not appear before its snooze_until passes');
    assert.ok(allPackedIds.has(4), 'the eligible place should still appear');
  });

  test('mixed visit-type budgeting within a single day reuses default_visit_type end-to-end', async () => {
    const candidates = [
      candidate(place(1, { default_visit_type: 'drop_in' })),
      candidate(place(2, { default_visit_type: 'check_in' })),
      candidate(place(3, { default_visit_type: 'working_visit' })),
      candidate(place(4, { default_visit_type: 'presentation' })),
    ];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    const stopsById = Object.fromEntries(result.days[0].stops.map((s) => [s.place_id, s]));
    assert.equal(stopsById[1].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.drop_in.minutes);
    assert.equal(stopsById[2].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.check_in.minutes);
    assert.equal(stopsById[3].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.working_visit.minutes);
    assert.equal(stopsById[4].visitMinutes, defaultVisitTypesConfig.VISIT_TYPES.presentation.minutes);
  });

  test('empty-pool day entries (zone: null) once the whole pool is exhausted', async () => {
    const candidates = [candidate(place(1)), candidate(place(2))];
    const result = await generateDraft({
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

  test('a place under the hard floor relative to today becomes eligible starting the day it actually clears the floor, not before', async () => {
    // HARD_FLOOR_DAYS defaults to 5. lastVisitDate = 2026-07-11 means:
    // day1 (07-14) daysSince=3 -> ineligible; day2 (07-15) daysSince=4 -> ineligible;
    // day3 (07-16) daysSince=5 -> eligible (>= floor).
    const candidates = [candidate(place(1, { capacity_status: 'verified' }), { lastVisitDate: '2026-07-11' })];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 3, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });

    assert.equal(result.days[0].stops.length, 0, 'day 1: still under the hard floor');
    assert.equal(result.days[1].stops.length, 0, 'day 2: still under the hard floor');
    assert.equal(result.days[2].stops.length, 1, 'day 3: the hard floor has now cleared');
    assert.equal(result.days[2].stops[0].place_id, 1);
  });

  test('config.scheduling override changes rank order', async () => {
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

    const withDefault = await generateDraft({
      candidates: [verified, estimated], today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
    });
    const withOverride = await generateDraft({
      candidates: [verified, estimated], today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 1, homeBase: DOWNTOWN,
      config: { scheduling: { NEGLECT_MULTIPLIER: 1.01 } },
    });

    assert.equal(withDefault.days[0].stops[0].place_id, 2, 'default: exploration wins while merely due');
    assert.equal(withOverride.days[0].stops[0].place_id, 1, 'override: lower NEGLECT_MULTIPLIER rescues the verified place first');
  });

  test('config.drive override changes driveMinutes', async () => {
    const candidates = [candidate(place(1, { lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }))];
    const withDefault = await generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
    });
    const withOverride = await generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 8, homeBase: DOWNTOWN,
      config: { drive: { SPEED_MPH_SHORT: 1, SPEED_MPH_MEDIUM: 1, SPEED_MPH_LONG: 1 } },
    });

    assert.ok(withOverride.days[0].stops[0].driveMinutes > withDefault.days[0].stops[0].driveMinutes);
  });

  test('config.visitTypes override changes visitMinutes', async () => {
    const candidates = [candidate(place(1, { default_visit_type: 'working_visit' }))];
    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 1, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 20, homeBase: DOWNTOWN, // generous enough to still fit the inflated 999-minute visit
      config: { visitTypes: { VISIT_TYPES: { ...defaultVisitTypesConfig.VISIT_TYPES, working_visit: { label: 'Working visit', minutes: 999 } } } },
    });

    assert.equal(result.days[0].stops[0].visitMinutes, 999);
  });

  test('full multi-day integration: 2+ zones, small synthetic candidate set', async () => {
    const eastPlaces = [1, 2, 3, 4].map((n) => candidate(place(n, { region: 'East Lincoln', capacity_level: n % 2 === 0 ? 'high' : 'medium' })));
    const southwestPlaces = [5, 6].map((n) =>
      candidate(place(n, { region: 'Southwest Lincoln', capacity_level: 'medium', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }))
    );

    const result = await generateDraft({
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

  test('with optimizeRoute: still re-ranks and dedupes correctly across days, using the optimizer for each day\'s sequence', async () => {
    const candidates = [
      candidate(place(1, { region: 'East Lincoln', capacity_level: 'high', default_visit_type: 'drop_in' })),
      candidate(place(2, { region: 'East Lincoln', capacity_level: 'medium', default_visit_type: 'drop_in' })),
    ];

    const result = await generateDraft({
      candidates, today: TODAY, daysAhead: 2, workingWeekdays: MON_FRI, exceptionDates: [],
      hoursPerDay: 0.5, homeBase: DOWNTOWN, // 30min budget: fits exactly one 20min drop_in block (5 drive + 7 visit + 3 prep + 5 data-entry), not two
      optimizeRoute: reversingOptimizer(5),
    });

    const allPackedIds = result.days.flatMap((d) => d.stops.map((s) => s.place_id));
    assert.deepEqual(allPackedIds.sort(), [1, 2], 'both candidates should still get packed exactly once across the two days');
    assert.ok(result.days.every((d) => d.stops.every((s) => s.driveMinutes === 5)), 'each day should reflect the optimizer\'s leg minutes, not the haversine estimate');
  });
});

describe('defaultRouteOptimizerConfig sanity', () => {
  test('MIN_TOPUP_MINUTES and MAX_OPTIMIZE_STOPS are positive', () => {
    assert.ok(defaultRouteOptimizerConfig.MIN_TOPUP_MINUTES > 0);
    assert.ok(defaultRouteOptimizerConfig.MAX_OPTIMIZE_STOPS > 0);
  });
});
