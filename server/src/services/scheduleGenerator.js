// Multi-day draft schedule generator. No knex/DB I/O — query the DB, shape
// rows into these input shapes, call this module — but as of phase 5, this
// module (and fillDayFromZone specifically) is no longer synchronous/pure
// like schedulingEngine.js/driveTime.js: it optionally calls out to
// services/routeOptimizer.js's optimizeRoute() for a real driving order.
// That call is intentionally *not* defaulted here — callers that don't pass
// `optimizeRoute` (all of today's tests, and any code not yet ready to hit a
// real routing API) get the exact same haversine/rank-order behavior as
// before. Wiring the real optimizeRoute in is the caller's job, same as it's
// the caller's job to assemble every other input shape.
//
// Deliberately out of scope here (see ROUTEPLANNER_PROGRESS.md's phase-4/5
// notes): the draft/commit lifecycle, multi-user collision handling, and the
// separate never-drop/flag-only packing function the later live-edit
// recalculation loop will need — packTimeBlock/packOptimizedTimeBlock's
// trim-to-budget/truncating behavior is exactly right for this one-time
// generation fill.

const defaultSchedulingConfig = require('../config/scheduling');
const defaultDriveConfig = require('../config/driveTime');
const defaultVisitTypesConfig = require('../config/visitTypes');
const defaultRouteOptimizerConfig = require('../config/routeOptimizer');
const { rankCandidates, TIERS } = require('./schedulingEngine');
const { packTimeBlock, packOptimizedTimeBlock, isGeocoded, resolveVisitType, visitDurationMinutes } = require('./driveTime');

// Shapes a ranked candidate into packTimeBlock's stop input. Keeps the
// fields needed to read/identify the draft; packTimeBlock spreads these
// through untouched into its output.
function toPackableStop({ place }) {
  return {
    place_id: place.id,
    place_name: place.name,
    region: place.region,
    lat: place.lat,
    lng: place.lng,
    visitType: place.default_visit_type,
    capacity_level: place.capacity_level,
    capacity_status: place.capacity_status,
    relationship_level: place.relationship_level,
  };
}

// Packs one day: filters `candidates` (already ranked) down to `zone`, then
// either hands them to packTimeBlock in that same rank order (no
// `optimizeRoute` given — the pre-phase-5 behavior, and the fallback when
// OSRM fails), or, when `optimizeRoute` is given: rank order still decides
// which stops are *candidates* (capped at routeOptimizerConfig's
// MAX_OPTIMIZE_STOPS — real headroom over what a day can hold, not a working
// constraint), but the optimizer decides their *sequence* within that
// capped pool — a closer-but-lower-ranked stop can be visited before a
// farther-but-higher-ranked one, trading strict priority for real route
// efficiency (an accepted, conscious tradeoff — see the phase-5 discussion
// in project memory). Does not choose the zone or manage the multi-day
// pool — that's generateDraft's job.
//
// The tradeoff above is about *sequencing*, but the budget trim (in either
// packTimeBlock or packOptimizedTimeBlock) can go further and drop a stop
// from the day entirely — including, in principle, a TIERS.COMMITMENT stop
// (an explicit due-date promise, which schedulingEngine.js otherwise
// guarantees jumps every other guard). That's a different and worse outcome
// than reordering, so it's tracked and surfaced rather than left silent:
// `droppedCommitments` on the returned result lists any in-zone commitment
// that didn't make the final packed stops, regardless of which path (or
// which trim) is responsible.
async function fillDayFromZone({ candidates, zone, homeBase, budgetMinutes, driveConfig, visitTypesConfig, optimizeRoute, routeOptimizerConfig }) {
  const inZone = candidates.filter((c) => c.place.region === zone);
  const pool = inZone.map(toPackableStop);
  const commitmentStops = inZone.filter((c) => c.rankKey?.[0] === TIERS.COMMITMENT).map(toPackableStop);

  let result;
  if (optimizeRoute) {
    const cfg = { ...defaultRouteOptimizerConfig, ...routeOptimizerConfig };
    const geocodedPool = pool.filter(isGeocoded);

    if (geocodedPool.length > 0) {
      const capped = geocodedPool.slice(0, cfg.MAX_OPTIMIZE_STOPS);
      const optimized = await optimizeRoute({ start: homeBase, stops: capped }, cfg, driveConfig);

      if (optimized) {
        const packed = packOptimizedTimeBlock(optimized.orderedStops, optimized.legMinutes, { start: homeBase, budgetMinutes, visitTypesConfig });
        result = await topUpDay(packed, geocodedPool, { homeBase, budgetMinutes, optimizeRoute, visitTypesConfig, routeOptimizerConfig: cfg, driveConfig });
      }
    }
  }

  if (!result) {
    result = packTimeBlock(pool, { start: homeBase, budgetMinutes, driveConfig, visitTypesConfig });
  }

  const packedIds = new Set(result.stops.map((s) => s.place_id));
  const droppedCommitments = commitmentStops.filter((s) => !packedIds.has(s.place_id));

  return { ...result, droppedCommitments };
}

// After the optimizer's tighter real routing packs a day, there can be real
// slack left that the old greedy trim-to-budget had no way to notice (it
// only ever walked stops in one fixed order and broke at the first that
// didn't fit). While there's enough time left for at least one more
// plausible stop AND the packed set hasn't hit MAX_TOPUP_STOPS (a separate,
// more generous ceiling than fillDayFromZone's initial-selection
// MAX_OPTIMIZE_STOPS cap — top-up is deliberately meant to reach past that
// cap, so it needs its own backstop rather than reusing it):
//
// Each round, BATCH as many next-best-ranked unpacked candidates as could
// plausibly fit into ONE re-optimize call, rather than spending a separate
// network round-trip per candidate — a day with real slack could otherwise
// need one OSRM call per stop added. "Plausibly fit" is the same cheap local
// lower bound as before (a candidate's own visit + prep + data-entry time,
// ignoring drive time, which can only make the true requirement larger)
// applied against the batch's running total, not just the day's total —
// a candidate whose lower bound alone would overflow the batch so far is
// skipped (not treated as ending the batch), since geocodedPool is rank
// order, not cost order, and a later, cheaper candidate might still belong
// in this round.
//
// The whole batch — previously packed stops plus every candidate in the
// batch — goes to the optimizer in one call. Whatever real drive time
// reveals actually fits (which can be fewer than the whole batch, or in
// principle all of it) is accepted as a partial win; only a batch that nets
// zero new stops is rejected outright (added to `rejected`, never retried).
// This still terminates: each round either grows the packed count (bounded
// by MAX_TOPUP_STOPS) or moves at least one candidate into the rejected set
// (bounded by geocodedPool's size), so it can't loop forever even though a
// rejected whole-batch is coarser than the old one-candidate-at-a-time
// rejection.
async function topUpDay(packed, geocodedPool, { homeBase, budgetMinutes, optimizeRoute, visitTypesConfig, routeOptimizerConfig, driveConfig }) {
  let { stops, totalMinutes, remainingMinutes } = packed;
  const rejected = new Set();
  const prepMinutes = visitTypesConfig?.PREP_MINUTES ?? defaultVisitTypesConfig.PREP_MINUTES;
  const dataEntryMinutes = visitTypesConfig?.DATA_ENTRY_MINUTES ?? defaultVisitTypesConfig.DATA_ENTRY_MINUTES;
  const minimumBlockFor = (stop) => visitDurationMinutes(resolveVisitType(stop.visitType, visitTypesConfig), visitTypesConfig) + prepMinutes + dataEntryMinutes;

  while (remainingMinutes >= routeOptimizerConfig.MIN_TOPUP_MINUTES && stops.length < routeOptimizerConfig.MAX_TOPUP_STOPS) {
    const packedIds = new Set(stops.map((s) => s.place_id));
    const available = geocodedPool.filter((s) => !packedIds.has(s.place_id) && !rejected.has(s.place_id));

    const batch = [];
    let batchMinutes = 0;
    for (const stop of available) {
      if (stops.length + batch.length >= routeOptimizerConfig.MAX_TOPUP_STOPS) break;
      const minimumBlock = minimumBlockFor(stop);
      if (batchMinutes + minimumBlock > remainingMinutes) continue; // this one doesn't fit alongside what's already in the batch — a cheaper one later might
      batch.push(stop);
      batchMinutes += minimumBlock;
    }
    if (batch.length === 0) break; // nothing left could possibly fit, even alone — no point spending a network call

    const optimized = await optimizeRoute({ start: homeBase, stops: [...stops, ...batch] }, routeOptimizerConfig, driveConfig);
    if (!optimized) break; // can't safely re-sequence without the optimizer; stop trying to top up

    const trial = packOptimizedTimeBlock(optimized.orderedStops, optimized.legMinutes, { start: homeBase, budgetMinutes, visitTypesConfig });
    if (trial.stops.length <= stops.length) {
      for (const stop of batch) rejected.add(stop.place_id); // real drive time ruled out the whole batch — don't retry these
      continue;
    }

    ({ stops, totalMinutes, remainingMinutes } = trial);
  }

  return { stops, totalMinutes, remainingMinutes };
}

// Top-level orchestrator. `days` is the caller's explicit, already-validated
// list of `{ date, hoursPerDay }` pairs (picked by hand on the "Plan My
// Visits" calendar — see scheduleDraft.js's validateDays) rather than a
// daysAhead/workingWeekdays/exceptionDates window this module used to
// compute itself; a caller-chosen date list means an already-committed date
// simply never gets handed in, instead of this module needing to know
// anything about commit state. For each day: re-ranks the remaining pool
// against THAT DAY'S OWN DATE (not once against `today`) — a place whose
// hard floor lapses by day 3, or a commitment that becomes due by day 4, is
// picked up correctly rather than frozen at today's view of the world.
// Picks a zone (zoneOverrides[date] if given, else the region of the
// top-ranked remaining candidate), packs it via fillDayFromZone (using that
// day's own hoursPerDay budget), then removes every PACKED place from the
// pool before the next day — candidates merely considered (wrong zone, or
// excluded by budget truncation) remain available for a later day.
//
// A plain for-of loop, not .map(): each day's ranking depends on `remaining`
// as left by the previous day, and fillDayFromZone is async since phase 5 —
// .map()'s callback would fire for every date before any single await
// resolved, running every day against the SAME stale `remaining` pool
// instead of each day seeing the previous day's dedupe.
async function generateDraft({ candidates, days, homeBase, zoneOverrides = {}, config = {}, optimizeRoute }) {
  const schedulingConfig = { ...defaultSchedulingConfig, ...(config.scheduling ?? {}) };
  const driveConfig = { ...defaultDriveConfig, ...(config.drive ?? {}) };
  const visitTypesConfig = { ...defaultVisitTypesConfig, ...(config.visitTypes ?? {}) };
  const routeOptimizerConfig = { ...defaultRouteOptimizerConfig, ...(config.routeOptimizer ?? {}) };

  let remaining = candidates; // raw pool; shrinks as places get packed across days

  const result = [];
  for (const { date, hoursPerDay } of days) {
    const budgetMinutes = hoursPerDay * 60;
    const ranked = rankCandidates(remaining, { today: date, config: schedulingConfig });

    if (ranked.length === 0) {
      result.push({ date, zone: null, stops: [], totalMinutes: 0, remainingMinutes: budgetMinutes, droppedCommitments: [] });
      continue;
    }

    const zone = zoneOverrides[date] ?? ranked[0].place.region;
    const { stops, totalMinutes, remainingMinutes, droppedCommitments } = await fillDayFromZone({
      candidates: ranked,
      zone,
      homeBase,
      budgetMinutes,
      driveConfig,
      visitTypesConfig,
      optimizeRoute,
      routeOptimizerConfig,
    });

    const packedIds = new Set(stops.map((s) => s.place_id));
    remaining = remaining.filter((c) => !packedIds.has(c.place.id));

    result.push({ date, zone, stops, totalMinutes, remainingMinutes, droppedCommitments });
  }

  return { days: result };
}

module.exports = {
  toPackableStop,
  fillDayFromZone,
  generateDraft,
};
