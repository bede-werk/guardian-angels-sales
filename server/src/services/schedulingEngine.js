// Pure scoring/eligibility engine for the route planner. No knex, no I/O —
// every function takes plain-object inputs so it's directly unit-testable;
// a later phase's job is just "query the DB, shape rows into these input
// shapes, call this module." See server/src/config/scheduling.js for the
// tunable constants (CADENCE_DAYS, HARD_FLOOR_DAYS, FATIGUE_*, NEGLECT_MULTIPLIER).
//
// Ranking model (see the route-planner plan for the full rationale): a
// lexicographic 4-tier sort, not an additive score. Lower tier always wins;
// within a tier, candidates are ordered by that tier's own value(s).
//
//   0. Hard commitments   — nextVisitDate <= today. Most overdue promise first.
//   1. Endangered verified — capacity confidence 'fresh' AND urgency >=
//      NEGLECT_MULTIPLIER (real measured neglect rescues a verified place
//      that exploration would otherwise bury — rescue is urgency-based only,
//      never capacity-based, so a low-capacity verified place can jump this
//      tier just as easily as a high-capacity one).
//   2. Exploration        — capacity confidence 'unknown' or 'stale' (spec
//      capacity-computation-spec.md §8, step 7). Ordered by explorationRank
//      (capacity-level guess, stale ranked below unknown, aged down toward 0
//      the longer a place has waited — see explorationRank below), then
//      priority_score descending, then place.id ascending as a final
//      deterministic tiebreak (spec §8.1) — NOT by urgency; learning beats
//      maintaining during the pre-qualification era.
//   3. Everything else     — fresh places below the neglect threshold.
//      Ordered by urgency, descending. Never-visited is Infinity urgency,
//      but a never-visited place is essentially always still
//      unknown/stale, so in practice it lands in tier 2, not here.
//
// This is what makes "one formula, two eras, no mode switch" true: every
// place's tier is computed the same way, always — it just moves from tier 2
// to tier 3 the moment its declared observation goes (or stays) fresh, and
// can visit tier 1 from tier 3 if it's neglected long enough. Unlike the old
// one-way capacity_status latch this replaced, a FRESH place can re-enter
// tier 2 later if its declared observation ages past CAPACITY_STALE_DAYS —
// deliberate, see capacity.js's confidence model.

// daysSince/isCommitmentDue/isFloorConflict now live in conflictDetection.js
// (the shared floor/collision rule module — see its header) and are
// re-exported below unchanged, so existing consumers of this module's
// daysSince (crossRepFloorWarning.js, relationship.js) don't need to change
// their require() at all.
const { daysSince, isCommitmentDue, isFloorConflict } = require('./conflictDetection');

const TIERS = { COMMITMENT: 0, ENDANGERED: 1, EXPLORATION: 2, MAINTENANCE: 3 };

// Days between visits this capacity/relationship combination should target.
// Deliberately inverted: high-capacity + weak-relationship gets the
// shortest cadence (biggest gap between potential and reality = biggest
// opportunity); low-capacity + strong-relationship gets the longest (already
// maxed out).
// Falls back to 'medium'/'weak' — the same defaults the
// 20260712000000_add_scheduling_fields.js migration itself uses (capacity
// backfill's own documented fallback, and relationship_level's column
// default) — for a place with a null/unrecognized capacity level or
// relationship_level, e.g. one created after that migration ran without
// either field ever being set by a route.
function targetCadenceDays(capacityLevel, relationshipLevel, config) {
  const byCapacity = config.CADENCE_DAYS[capacityLevel] || config.CADENCE_DAYS.medium;
  return byCapacity[relationshipLevel] ?? byCapacity.weak;
}

// How overdue a place is, as a ratio of its target cadence. Never-visited is
// Infinity (maximally overdue). A fatigued place (>= FATIGUE_THRESHOLD
// completed visits in the trailing FATIGUE_WINDOW_DAYS) has its cadence
// stretched by FATIGUE_MULTIPLIER first, so its urgency number reflects the
// *effective* cadence, not the base one — this is the single source of
// truth used both to test the tier-1 neglect threshold and to order within
// tiers 1 and 3.
function urgency({ place, lastVisitDate, recentCompletedCount, relationshipLevel, capacityLevel, today, config }) {
  if (!lastVisitDate) return Infinity;
  let cadence = targetCadenceDays(effectiveCapacityLevel({ place, capacityLevel }), effectiveRelationshipLevel({ place, relationshipLevel }), config);
  if (recentCompletedCount >= config.FATIGUE_THRESHOLD) cadence *= config.FATIGUE_MULTIPLIER;
  return daysSince(lastVisitDate, today) / cadence;
}

// Relationship level is now COMPUTED (services/relationship.js) and supplied
// per-candidate by buildCandidatePool, rather than read off the place row —
// places.relationship_level was a manual field that defaulted to 'weak' and
// was never once edited, which quietly flattened this whole axis of the
// cadence table.
//
// The fallback to place.relationship_level exists only for the transition:
// places.relationship_level is deliberately still on the table for one
// release so computed values can be compared against the old manual ones on
// real data. In production buildCandidatePool always supplies
// relationshipLevel, so the fallback never fires; it's what keeps this
// module's own pure tests (which construct bare place objects) meaningful in
// the meantime. Delete it along with the column.
function effectiveRelationshipLevel({ place, relationshipLevel }) {
  return relationshipLevel ?? place.relationship_level;
}

// Same transition pattern as effectiveRelationshipLevel above, one release
// later: capacity level is now COMPUTED (services/capacity.js,
// capacity-computation-spec.md step 6) and supplied per-candidate by
// buildCandidatePool, rather than read off place.capacity_level — the raw
// column is a frozen one-time guess/pre-qual snapshot, never revised against
// reality (see the spec's §1). The fallback to place.capacity_level exists
// only so this module's own pure tests (bare place objects, no pool) stay
// meaningful; buildCandidatePool always supplies capacityLevel in production,
// so the fallback never fires there. Delete it once the legacy column is
// dropped (spec step 9).
function effectiveCapacityLevel({ place, capacityLevel }) {
  return capacityLevel ?? place.capacity_level;
}

// Ordinal for "ordered among themselves by capacity level (guess)" within
// the exploration tier — higher sorts first. Superseded by explorationRank
// below (step 7) for actual ranking; kept/exported only because
// scheduleDraft.test.js and older fixtures may still reference it directly.
function capacityRank(capacityLevel) {
  return { high: 2, medium: 1, low: 0 }[capacityLevel] ?? -1;
}

// Same transition pattern once more, step 7: EXPLORATION tier MEMBERSHIP is
// now governed by the computed capacity service's `confidence`, not the old
// one-way `capacity_status` latch (estimated -> verified, never revisited).
// A place whose declared observation ages past CAPACITY_STALE_DAYS now
// correctly RE-ENTERS exploration — impossible under the old latch, and
// exactly what capacity.js's confidence model exists to enable (spec §6.6,
// §8).
//
// The fallback maps the OLD status values to their nearest confidence
// equivalent so this module's own bare-place-object tests keep meaning
// something: 'estimated' (never verified) -> 'unknown' (still in
// exploration); anything else ('verified'/'adjusted') -> 'fresh' (out of
// exploration) — exactly the old gate's own boolean, just re-expressed.
// Production always supplies capacityConfidence from buildCandidatePool, so
// this fallback never fires there. Delete it once the legacy column is
// dropped (spec step 9).
function effectiveCapacityConfidence({ place, capacityConfidence }) {
  if (capacityConfidence) return capacityConfidence;
  return place.capacity_status === 'estimated' ? 'unknown' : 'fresh';
}

// Spec §8.2 — how candidates are ordered AMONG THEMSELVES within the
// EXPLORATION tier. Lower explorationRank sorts FIRST (opposite convention
// from every other tier's within-tier value — see rankKey/compareRankKeys
// below for how the sign flip reconciles this within one comparator).
//
// baseRank: capacity-level guess, high/medium/low, with a stale observation
// penalized below unknown — "never-asked outranks re-asked" (spec's own
// phrase): a place we've never even tried to ask deserves the benefit of
// the doubt over one whose number we know is old.
//
// Aging then pulls the rank down toward 0 the longer a place has waited
// (daysWaiting / EXPLORATION_AGING_DAYS, floored) — the starvation guard:
// without it, a low-capacity or stale place would sit at the bottom of
// EXPLORATION forever and never get re-asked. At daysWaiting = 0 for every
// candidate (e.g. right after import, when every place shares one
// created_at), this term is inert and ordering is pure capacity guess — see
// the spec's own worked example.
//
// daysWaiting is clamped to >= 0 HERE, on the input, not just on the final
// return value below. A negative daysWaiting is possible: places.
// exploration_eligible_since is stamped once, at observation-insert time,
// using CAPACITY_STALE_DAYS as it stood THAT day (deliberately — see the
// migration's own header, this is what keeps a later threshold retune from
// retroactively reshuffling everyone already waiting). If that threshold is
// ever tightened, a place's live-computed confidence can flip to 'stale'
// before its already-stamped eligible_since date arrives, so
// daysSince(eligible_since, today) comes out negative for a little while.
// Without this clamp, floor(negative / AGING_DAYS) is a negative integer,
// which makes `baseRank - floor(...)` LARGER — i.e. worse, sorting the place
// further back — the opposite of "no aging credit yet." The final
// `Math.max(0, ...)` below only floors the RESULT at the front of the tier;
// it does nothing to stop a negative daysWaiting from pushing a place
// backward first.
function explorationRank({ level, confidence, daysWaiting, config }) {
  const baseRank = ({ high: 0, medium: 1, low: 2 }[level] ?? 2) + (confidence === 'stale' ? 3 : 0);
  const waited = Math.max(0, daysWaiting);
  return Math.max(0, baseRank - Math.floor(waited / config.EXPLORATION_AGING_DAYS));
}

// The guard gate, applied before ranking. Returns { eligible, reason }
// rather than a bare bool so callers/UI can explain a skip.
//
// Precedence: do_not_visit excludes always, even over a due commitment (the
// ultimate manual veto) -> a due commitment (nextVisitDate <= today) bypasses
// the hard floor only, since a human explicitly asking us back is exactly
// the justification the floor exists to protect against overriding -> every
// other guard (snooze, locked-elsewhere, and the floor itself when there's
// no due commitment) applies normally.
//
// plannedVisitDates (Step 3 of the 2026-08 remediation ticket): every OTHER
// planned visit this place already has on the books, checked against the
// SAME hard floor a completed visit is — a planned visit is a real
// commitment already made, and proposing this place again nearby in time is
// exactly the double-booking risk the floor exists to prevent. Deliberately
// NOT folded into lastVisitDate: that field also drives urgency()/rankKey's
// cadence math below, and a planned-but-not-yet-happened visit must not
// affect how overdue a place LOOKS — only whether it's eligible at all.
function eligibility({ place, today, lastVisitDate, nextVisitDate, plannedVisitDates = [], lockedElsewhere, config }) {
  if (place.do_not_visit) return { eligible: false, reason: 'do_not_visit' };

  const commitmentDue = isCommitmentDue({ nextVisitDate, today });

  if (place.snooze_until && place.snooze_until >= today) return { eligible: false, reason: 'snoozed' };
  if (lockedElsewhere) return { eligible: false, reason: 'locked_elsewhere' };
  if (!commitmentDue) {
    if (isFloorConflict({ lastVisitDate, today, config })) {
      return { eligible: false, reason: 'hard_floor' };
    }
    if (plannedVisitDates.some((date) => isFloorConflict({ lastVisitDate: date, today, config }))) {
      return { eligible: false, reason: 'hard_floor' };
    }
  }
  return { eligible: true, reason: null };
}

// [tier, ...withinTierValues] — lower tier sorts first; within a tier, each
// subsequent value sorts higher-first (see compareRankKeys) — EXPLORATION's
// explorationRank/place.id are negated at construction so their intended
// ascending order comes out of the same higher-first comparator every other
// tier already uses, rather than teaching compareRankKeys per-index
// direction.
//
// EXPLORATION membership now reads the computed capacity service's
// `confidence` (step 7), not place.capacity_status directly — step 6 only
// swapped the cadence-lookup/capacityRank consumers of capacity LEVEL, this
// is what finally retires place.capacity_status as a ranking input.
// routes/visits.js's dual-write bridge (kept it current in the meantime)
// should be deleted now that this has landed and been verified — see that
// function's own comment.
function rankKey({ place, lastVisitDate, recentCompletedCount, nextVisitDate, relationshipLevel, capacityLevel, capacityConfidence, today, config }) {
  if (nextVisitDate && nextVisitDate <= today) {
    return [TIERS.COMMITMENT, daysSince(nextVisitDate, today)];
  }

  const confidence = effectiveCapacityConfidence({ place, capacityConfidence });
  const inExploration = confidence !== 'fresh';
  const u = urgency({ place, lastVisitDate, recentCompletedCount, relationshipLevel, capacityLevel, today, config });

  if (!inExploration && u >= config.NEGLECT_MULTIPLIER) {
    return [TIERS.ENDANGERED, u];
  }
  if (inExploration) {
    const level = effectiveCapacityLevel({ place, capacityLevel });
    const daysWaiting = daysSince(place.exploration_eligible_since, today);
    const rank = explorationRank({ level, confidence, daysWaiting, config });
    // Spec §8.1: explorationRank ascending, priority_score descending,
    // place.id ascending — the first and third are negated so a single
    // higher-first comparator (compareDesc, applied elementwise by
    // compareRankKeys) produces the right order for all three at once.
    return [TIERS.EXPLORATION, -rank, place.priority_score ?? 0, -place.id];
  }
  return [TIERS.MAINTENANCE, u];
}

// Descending compare that treats Infinity as strictly larger than any other
// Infinity-free value without producing NaN (plain `b - a` breaks when both
// sides are Infinity, since Infinity - Infinity is NaN).
function compareDesc(a, b) {
  if (a === b) return 0;
  if (a === Infinity) return -1;
  if (b === Infinity) return 1;
  return b - a;
}

// Generalized beyond a fixed [tier, value] pair (step 7's EXPLORATION tier
// needs 3 within-tier values, every other tier still needs just 1) — same
// tier-then-descending-elementwise comparison either way. Two rankKeys are
// only ever compared when both came from candidates, so within a tier both
// arrays are always the same length; the `?? 0` is just defensive, not a
// real cross-tier-length case.
function compareRankKeys(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  for (let i = 1; i < Math.max(a.length, b.length); i++) {
    const cmp = compareDesc(a[i] ?? 0, b[i] ?? 0);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

// candidates: [{ place, lastVisitDate, recentCompletedCount, nextVisitDate, plannedVisitDates, lockedElsewhere, relationshipLevel, capacityLevel, capacityConfidence }]
// Filters out ineligible candidates, then sorts the rest by rankKey.
function rankCandidates(candidates, { today, config }) {
  return candidates
    .filter((c) => eligibility({ place: c.place, today, lastVisitDate: c.lastVisitDate, nextVisitDate: c.nextVisitDate, plannedVisitDates: c.plannedVisitDates, lockedElsewhere: c.lockedElsewhere, config }).eligible)
    .map((c) => ({ ...c, rankKey: rankKey({ ...c, today, config }) }))
    .sort((a, b) => compareRankKeys(a.rankKey, b.rankKey));
}

module.exports = {
  TIERS,
  daysSince,
  targetCadenceDays,
  effectiveRelationshipLevel,
  effectiveCapacityLevel,
  effectiveCapacityConfidence,
  urgency,
  capacityRank,
  explorationRank,
  eligibility,
  rankKey,
  compareRankKeys,
  rankCandidates,
};
