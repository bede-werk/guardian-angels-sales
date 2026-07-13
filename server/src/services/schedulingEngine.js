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

const TIERS = { COMMITMENT: 0, ENDANGERED: 1, EXPLORATION: 2, MAINTENANCE: 3 };

// Integer day count between two 'YYYY-MM-DD' strings (today - dateStr).
// Parsed as UTC calendar dates (not Date.parse) so this is immune to the
// host machine's local timezone.
function daysSince(dateStr, today) {
  const [y1, m1, d1] = dateStr.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

// Days between visits this capacity/relationship combination should target.
// Deliberately inverted: high-capacity + weak-relationship gets the
// shortest cadence (biggest gap between potential and reality = biggest
// opportunity); low-capacity + strong-relationship gets the longest (already
// maxed out).
function targetCadenceDays(capacityLevel, relationshipLevel, config) {
  return config.CADENCE_DAYS[capacityLevel][relationshipLevel];
}

// How overdue a place is, as a ratio of its target cadence. Never-visited is
// Infinity (maximally overdue). A fatigued place (>= FATIGUE_THRESHOLD
// completed visits in the trailing FATIGUE_WINDOW_DAYS) has its cadence
// stretched by FATIGUE_MULTIPLIER first, so its urgency number reflects the
// *effective* cadence, not the base one — this is the single source of
// truth used both to test the tier-1 neglect threshold and to order within
// tiers 1 and 3.
function urgency({ place, lastVisitDate, recentCompletedCount, today, config }) {
  if (!lastVisitDate) return Infinity;
  let cadence = targetCadenceDays(place.capacity_level, place.relationship_level, config);
  if (recentCompletedCount >= config.FATIGUE_THRESHOLD) cadence *= config.FATIGUE_MULTIPLIER;
  return daysSince(lastVisitDate, today) / cadence;
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
function eligibility({ place, today, lastVisitDate, nextVisitDate, lockedElsewhere, config }) {
  if (place.do_not_visit) return { eligible: false, reason: 'do_not_visit' };

  const commitmentDue = Boolean(nextVisitDate && nextVisitDate <= today);

  if (place.snooze_until && place.snooze_until >= today) return { eligible: false, reason: 'snoozed' };
  if (lockedElsewhere) return { eligible: false, reason: 'locked_elsewhere' };
  if (!commitmentDue && lastVisitDate && daysSince(lastVisitDate, today) < config.HARD_FLOOR_DAYS) {
    return { eligible: false, reason: 'hard_floor' };
  }
  return { eligible: true, reason: null };
}

// [tier, withinTierValue] — lower tier sorts first; within a tier, higher
// withinTierValue sorts first (see compareRankKeys).
function rankKey({ place, lastVisitDate, recentCompletedCount, nextVisitDate, today, config }) {
  if (nextVisitDate && nextVisitDate <= today) {
    return [TIERS.COMMITMENT, daysSince(nextVisitDate, today)];
  }

  const isEstimated = place.capacity_status === 'estimated';
  const u = urgency({ place, lastVisitDate, recentCompletedCount, today, config });

  if (!isEstimated && u >= config.NEGLECT_MULTIPLIER) {
    return [TIERS.ENDANGERED, u];
  }
  if (isEstimated) {
    return [TIERS.EXPLORATION, capacityRank(place.capacity_level)];
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

// candidates: [{ place, lastVisitDate, recentCompletedCount, nextVisitDate, lockedElsewhere }]
// Filters out ineligible candidates, then sorts the rest by rankKey.
function rankCandidates(candidates, { today, config }) {
  return candidates
    .filter((c) => eligibility({ place: c.place, today, lastVisitDate: c.lastVisitDate, nextVisitDate: c.nextVisitDate, lockedElsewhere: c.lockedElsewhere, config }).eligible)
    .map((c) => ({ ...c, rankKey: rankKey({ ...c, today, config }) }))
    .sort((a, b) => compareRankKeys(a.rankKey, b.rankKey));
}

module.exports = {
  TIERS,
  daysSince,
  targetCadenceDays,
  urgency,
  capacityRank,
  eligibility,
  rankKey,
  compareRankKeys,
  rankCandidates,
};
