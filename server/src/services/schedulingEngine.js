// Pure scoring/eligibility engine for the route planner. No knex, no I/O —
// every function takes plain-object inputs so it's directly unit-testable;
// a later phase's job is just "query the DB, shape rows into these input
// shapes, call this module." See server/src/config/scheduling.js for the
// tunable constants (CADENCE_DAYS, HARD_FLOOR_DAYS, FATIGUE_*, NEGLECT_MULTIPLIER).
//
// Ranking model (see the route-planner plan for the full rationale): a
// lexicographic 4-tier sort, not an additive score. Lower tier always wins;
// within a tier, candidates are ordered by that tier's own value, descending.
//
//   0. Hard commitments   — nextVisitDate <= today. Most overdue promise first.
//   1. Endangered verified — capacity_status !== 'estimated' AND urgency >=
//      NEGLECT_MULTIPLIER (real measured neglect rescues a verified place
//      that exploration would otherwise bury — rescue is urgency-based only,
//      never capacity-based, so a low-capacity verified place can jump this
//      tier just as easily as a high-capacity one).
//   2. Exploration        — capacity_status === 'estimated'. Ordered by
//      capacity-level guess (high > medium > low), NOT by urgency — learning
//      beats maintaining during the pre-qualification era.
//   3. Everything else     — verified/adjusted places below the neglect
//      threshold. Ordered by urgency, descending. Never-visited is Infinity
//      urgency, but a never-visited place is essentially always still
//      'estimated', so in practice it lands in tier 2, not here.
//
// This is what makes "one formula, two eras, no mode switch" true: every
// place's tier is computed the same way, always — it just moves from tier 2
// to tier 3 the moment capacity_status leaves 'estimated', and can visit
// tier 1 from tier 3 if it's neglected long enough.

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
// the exploration tier — higher sorts first.
function capacityRank(capacityLevel) {
  return { high: 2, medium: 1, low: 0 }[capacityLevel] ?? -1;
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

// [tier, withinTierValue] — lower tier sorts first; within a tier, higher
// withinTierValue sorts first (see compareRankKeys).
//
// isEstimated still reads place.capacity_status directly, NOT the computed
// capacity service's `confidence` — that's capacity-computation-spec.md step
// 7's swap (the EXPLORATION tier rework), not step 6's. Step 6 is scoped to
// the cadence-lookup/capacityRank consumers of capacity LEVEL only; the tier
// gate itself is untouched here on purpose. capacity_status is kept current
// by routes/visits.js's dual-write bridge in the meantime (see that
// function's own comment) — it survives through step 7, not just step 6.
function rankKey({ place, lastVisitDate, recentCompletedCount, nextVisitDate, relationshipLevel, capacityLevel, today, config }) {
  if (nextVisitDate && nextVisitDate <= today) {
    return [TIERS.COMMITMENT, daysSince(nextVisitDate, today)];
  }

  const isEstimated = place.capacity_status === 'estimated';
  const u = urgency({ place, lastVisitDate, recentCompletedCount, relationshipLevel, capacityLevel, today, config });

  if (!isEstimated && u >= config.NEGLECT_MULTIPLIER) {
    return [TIERS.ENDANGERED, u];
  }
  if (isEstimated) {
    return [TIERS.EXPLORATION, capacityRank(effectiveCapacityLevel({ place, capacityLevel }))];
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

function compareRankKeys(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return compareDesc(a[1], b[1]);
}

// candidates: [{ place, lastVisitDate, recentCompletedCount, nextVisitDate, plannedVisitDates, lockedElsewhere, relationshipLevel, capacityLevel }]
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
  urgency,
  capacityRank,
  eligibility,
  rankKey,
  compareRankKeys,
  rankCandidates,
};
