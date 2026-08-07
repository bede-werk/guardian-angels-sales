// Computed capacity — the objective, ratchet-only replacement for the manual
// places.capacity_level, the frozen places.capacity_monthly_referrals, and
// the one-way capacity_status latch. Modelled on services/referralMetrics.js
// (asOf-aware, nothing stored beyond the observation history itself) and
// services/relationship.js (pure computation + bulk DB layer, computed value
// with a clearly-flagged manual override) — the two spec's own companion.
//
// DEFINITION (locked): capacity is the number of homecare referrals a place
// SENDS per month, to any agency, excluding whatever their own in-house
// service absorbs. It is potential, not realized — "how much they COULD
// send," not "how much they send US." See capacity-computation-spec.md §2
// for the full "why," including the self-confirming-guess failure mode this
// exists to prevent.
//
// THE CORE INVARIANT — READ BEFORE TOUCHING effectiveMonthly BELOW:
// declared (their own pre-qual answer) and measuredFloor (our own referral
// throughput) measure different quantities — declared is "total to anyone,"
// measured is "just to us." Measurement may therefore only RAISE the
// capacity number, never lower it: our own volume is proof of a floor, but
// zero volume from us proves nothing about what they send elsewhere (could
// be a competitor getting all of it — the highest-value target in the
// database, not a demotion candidate). This is why effectiveMonthly is a
// Math.max(), never an average, override, or replacement, and why there is
// no code path anywhere in this file that lets measuredFloor push the
// number down. See the "Asymmetry — down" test in capacity.test.js, which
// exists specifically to fail loudly if this ever becomes bidirectional.

const { daysSince } = require('./schedulingEngine');
const { orgToday } = require('./orgDate');
const defaultConfig = require('../config/scheduling');

// --- Pure date helpers -----------------------------------------------------

// 'YYYY-MM-DD' n days after dateStr (n may be negative) — UTC-safe, same
// convention as relationship.js's daysBefore/schedulingEngine.js's daysSince.
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

// A DB timestamp (string or Date, depending on driver — better-sqlite3 vs
// pg) reduced to a plain 'YYYY-MM-DD' date string, matching every other date
// field in this service.
function toDateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

// --- Pure bucketing / seeding ----------------------------------------------

// Spec §4. Single scale, no per-category thresholds, no hysteresis.
function bucketForMonthlyReferrals(value, thresholds) {
  if (value >= thresholds.HIGH_MIN) return 'high';
  if (value >= thresholds.MEDIUM_MIN) return 'medium';
  return 'low';
}

// Spec §6.5. Ordered first-match-wins, case-insensitive substring match
// against a place's (free-text, unnormalized) category — same shape as the
// 20260712000000 migration's one-time seed, kept as a fresh, independent
// copy in config/scheduling.js (see that config's own comment for why).
function categorySeedLevel(category, seedTable, defaultLevel) {
  const c = String(category || '');
  for (const [pattern, level] of seedTable) {
    if (pattern.test(c)) return level;
  }
  return defaultLevel;
}

// --- Pure resolution (spec §6.3-6.6) ---------------------------------------

// Everything here is plain data in, plain data out — no knex — so the
// resolution logic (the asymmetry invariant, the override precedence, the
// staleness clock) is directly unit-testable without a DB, same pure/impure
// split as schedulingEngine.js and relationship.js.
//
// declared: { value, observedAt, source, personId } | null
// measuredFloor: number | null (already gated — see measuredFloorByPlace;
//   this function never re-applies the exposure/count gate itself)
// overrideLevel: 'high' | 'medium' | 'low' | null
function computeCapacityPure({ declared, measuredFloor, overrideLevel, category, asOf, config }) {
  // THE INVARIANT: max, never anything that could let measuredFloor pull
  // the number down. See this file's header before changing this line.
  const effectiveMonthly = declared == null && measuredFloor == null ? null : Math.max(declared?.value ?? 0, measuredFloor ?? 0);

  let computedLevel;
  let computedLevelSource;
  if (effectiveMonthly != null) {
    computedLevel = bucketForMonthlyReferrals(effectiveMonthly, config.CAPACITY_THRESHOLDS);
    // Which side actually produced effectiveMonthly — ties (declared exactly
    // equals measuredFloor) credit 'measured', since the point of the floor
    // winning is "our own numbers confirm/exceed the claim," which a tie
    // still does.
    const floorWon = measuredFloor != null && measuredFloor >= (declared?.value ?? 0);
    computedLevelSource = floorWon ? 'measured' : 'declared';
  } else {
    computedLevel = categorySeedLevel(category, config.CATEGORY_CAPACITY_SEED, config.CATEGORY_CAPACITY_SEED_DEFAULT);
    computedLevelSource = 'category_seed';
  }

  // Override wins outright, but the computed value underneath is still
  // carried on the result (computedLevel) so the UI can show both side by
  // side when they diverge — same "override and computed shown together"
  // contract as relationship.js's rollUpPlace (places.relationship_level_override).
  const isOverridden = Boolean(overrideLevel);
  const level = overrideLevel || computedLevel;
  const levelSource = isOverridden ? 'override' : computedLevelSource;

  // Confidence is about the DECLARED observation's age only — an override
  // does not reset this clock (spec §6.6: "the override just says you don't
  // trust the stale number in the meantime," it doesn't refresh it).
  let confidence;
  let staleAt;
  if (!declared) {
    confidence = 'unknown';
    staleAt = null;
  } else {
    staleAt = addDays(declared.observedAt, config.CAPACITY_STALE_DAYS);
    confidence = daysSince(declared.observedAt, asOf) > config.CAPACITY_STALE_DAYS ? 'stale' : 'fresh';
  }

  const contributors = [];
  if (declared) {
    contributors.push({ type: 'declared', value: declared.value, observedAt: declared.observedAt, source: declared.source, personId: declared.personId ?? null });
  }
  if (measuredFloor != null) {
    contributors.push({ type: 'measured', value: measuredFloor });
  }

  return {
    declared,
    measuredFloor,
    effectiveMonthly,
    level,
    levelSource,
    // Extension beyond the spec's literal return shape (§6): needed for
    // §11's PlaceDetail requirement to show "computed vs. override side by
    // side when they diverge" — there's no way to render that without
    // knowing what the computed value WOULD be under an active override.
    computedLevel,
    isOverridden,
    confidence,
    staleAt,
    contributors,
  };
}

// --- EXPLORATION tier eligibility stamp (spec §8.2, step 7) ---------------
//
// places.exploration_eligible_since holds the date this place next becomes
// eligible for the EXPLORATION tier — see the migration that added it for
// why this is a real, explicitly-stamped column rather than a `?? created_at`
// fallback computed at read time. A fresh declared observation means this
// place will next become eligible once THAT observation goes stale, so the
// value is knowable (and stamped) the moment the observation is written —
// never derived later, so a future CAPACITY_STALE_DAYS retune doesn't
// retroactively reshuffle every place already waiting in EXPLORATION.

// Pure: the actual date math, unit-testable without a DB.
function nextExplorationEligibleSince(observedAt, config) {
  return addDays(observedAt, config.CAPACITY_STALE_DAYS);
}

// Impure: called by every capacity_observations write site (POST
// /:id/capacity-observations, routes/visits.js's maybeCapturePreQualification)
// immediately after inserting the observation row.
async function stampExplorationEligibility(knex, placeId, observedAt, config = defaultConfig) {
  await knex('places').where({ id: placeId }).update({
    exploration_eligible_since: nextExplorationEligibleSince(observedAt, config),
  });
}

// --- Bulk DB paths -----------------------------------------------------
//
// Both take knex explicitly (matching referralMetrics.js/relationship.js's
// convention) and stay strictly bulk — a fixed number of queries regardless
// of how many placeIds are asked for, then group-and-compute in JS. This
// runs over every place in the candidate pool on every draft generation
// once wired into schedulingEngine.js (not yet — see the spec's build
// order), so a per-place query here would be catastrophic there.

// Latest capacity_observations row per place, as of `asOf` — spec §6.1.
// ORDER BY + first-row-per-key-wins-in-JS, same reduce pattern
// buildCandidatePool/scheduleDraft.js already use throughout this codebase
// (see e.g. buildCandidatePool's lastVisitByPlace) rather than a
// per-place correlated subquery.
async function latestObservationsByPlace(knex, placeIds, asOf) {
  const out = new Map();
  if (!placeIds.length) return out;

  const rows = await knex('capacity_observations')
    .whereIn('place_id', placeIds)
    .where('observed_at', '<=', asOf)
    .orderBy('place_id')
    .orderBy('observed_at', 'desc')
    .orderBy('id', 'desc') // tiebreak: same-day observations, latest write wins
    .select('place_id', 'monthly_referrals', 'observed_at', 'source', 'person_id');

  for (const r of rows) {
    if (!out.has(r.place_id)) {
      out.set(r.place_id, { value: r.monthly_referrals, observedAt: r.observed_at, source: r.source, personId: r.person_id });
    }
  }
  return out;
}

// Our own measured referral floor per place, as of `asOf` — spec §6.2.
// Gated by MEASURED_MIN_EXPOSURE_DAYS/MEASURED_MIN_REFERRAL_COUNT; a
// place that doesn't clear both is simply absent from the returned map
// (read as null by the caller), not present with a 0.
//
// Deliberately uses referrals.place_id DIRECTLY (the snapshot of which
// building the referral actually came from), NOT the live people.place_id
// join referralMetrics.js's referralMetricsByPlaceId uses for its own,
// different purpose. That join exists because a PERSON's relationship score
// should follow them if they change employer — but capacity is explicitly a
// property of the BUILDING, not the contact (spec §14), so a referral a
// place's building generated should stay attributed to that building even
// after whichever staff member logged it moves on.
async function measuredFloorByPlace(knex, placeIds, asOf, config) {
  const out = new Map();
  if (!placeIds.length) return out;

  const places = await knex('places').whereIn('id', placeIds).select('id', 'created_at');
  const createdAtByPlace = new Map(places.map((p) => [p.id, toDateOnly(p.created_at)]));

  const rows = await knex('referrals').whereIn('place_id', placeIds).where('referral_date', '<=', asOf).select('place_id', 'referral_date');

  const datesByPlace = new Map();
  for (const r of rows) {
    if (!datesByPlace.has(r.place_id)) datesByPlace.set(r.place_id, []);
    datesByPlace.get(r.place_id).push(r.referral_date);
  }

  const windowStart = addDays(asOf, -365); // exclusive lower bound — spec's (asOf-365d, asOf]

  for (const placeId of placeIds) {
    const dates = datesByPlace.get(placeId);
    if (!dates || dates.length === 0) continue; // no referrals ever -> not in map -> null

    const windowCount = dates.filter((d) => d > windowStart).length;
    const firstReferralDate = dates.reduce((min, d) => (d < min ? d : min), dates[0]);
    const createdAt = createdAtByPlace.get(placeId);
    const anchorDate = firstReferralDate > createdAt ? firstReferralDate : createdAt; // later of the two, per spec
    const exposureDays = Math.min(365, daysSince(anchorDate, asOf));

    if (exposureDays < config.MEASURED_MIN_EXPOSURE_DAYS || windowCount < config.MEASURED_MIN_REFERRAL_COUNT) continue; // gated out -> null

    out.set(placeId, Math.round(windowCount / (exposureDays / 30.44)));
  }
  return out;
}

// place_id -> capacity result (see computeCapacityPure's return shape, plus
// `override` metadata attached here since that comes straight off the
// places row rather than anything the pure layer needs to know about
// structurally). Three queries total regardless of how many places are
// asked for.
async function computeCapacityForPlaces(knex, placeIds, { asOf, config = defaultConfig } = {}) {
  const out = new Map();
  if (!placeIds.length) return out;
  const date = asOf || orgToday();

  const places = await knex('places')
    .whereIn('id', placeIds)
    .select('id', 'category', 'capacity_override_level', 'capacity_override_reason', 'capacity_override_at');

  const [declaredByPlace, measuredByPlace] = await Promise.all([
    latestObservationsByPlace(knex, placeIds, date),
    measuredFloorByPlace(knex, placeIds, date, config),
  ]);

  for (const place of places) {
    const declared = declaredByPlace.get(place.id) || null;
    const measuredFloor = measuredByPlace.has(place.id) ? measuredByPlace.get(place.id) : null;
    const overrideLevel = place.capacity_override_level || null;

    const result = computeCapacityPure({ declared, measuredFloor, overrideLevel, category: place.category, asOf: date, config });

    out.set(place.id, {
      ...result,
      override: overrideLevel
        ? { level: overrideLevel, reason: place.capacity_override_reason || null, at: place.capacity_override_at || null }
        : null,
    });
  }
  return out;
}

// Single-place convenience wrapper — implemented literally as a one-element
// call into computeCapacityForPlaces so the two can never drift apart (see
// the "Bulk parity" test in capacity.test.js). Returns null for a place id
// that doesn't exist in `places` at all.
async function computeCapacityForPlace(knex, placeId, { asOf, config } = {}) {
  const byId = await computeCapacityForPlaces(knex, [placeId], { asOf, config });
  return byId.get(placeId) || null;
}

module.exports = {
  // pure
  addDays,
  toDateOnly,
  bucketForMonthlyReferrals,
  categorySeedLevel,
  computeCapacityPure,
  nextExplorationEligibleSince,
  // bulk DB
  latestObservationsByPlace,
  measuredFloorByPlace,
  computeCapacityForPlaces,
  computeCapacityForPlace,
  stampExplorationEligibility,
};
