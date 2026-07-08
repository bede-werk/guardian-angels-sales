// Computes a *suggested* relationship temperature for a person — a decay
// applied to whatever their manual value currently is (or a neutral "warm"
// baseline if none is set yet), based on how overdue their place is for a
// visit. This never touches the stored value; it's a suggestion only, shown
// alongside the manual one so a rep can decide whether to act on it (see
// routes/people.js, routes/places.js, PersonDetail.jsx, PlaceDetail.jsx).
//
// Phase 1 factor: recency. A place's target visit cadence is derived from
// its tier (the same tier-drives-frequency idea as priority_score) and
// compared against days since its last completed visit:
//   within 1x target cadence     -> holds (no suggested change)
//   within 2x target cadence     -> suggest one step cooler
//   beyond 2x, or never visited  -> suggest dormant outright
//
// Designed to grow a second factor later: referral activity (already
// tracked per-person via the referrals table) could offset or reduce the
// decay steps computed here — add it as another contribution to `steps`
// inside suggestRelationshipTemp, without changing this function's shape.

const TEMPS = ['hot', 'warm', 'cold', 'dormant']; // warmest -> coolest

// Target visit cadence per tier, in days. Tier 1 (most important) is
// expected to be visited most often.
const TARGET_CADENCE_DAYS = { 1: 30, 2: 60, 3: 90 };

// How many steps of cooling the recency factor alone suggests.
function recencyDecaySteps(daysSinceLastVisit, targetCadenceDays) {
  if (daysSinceLastVisit == null) return TEMPS.length - 1; // never visited -> dormant
  if (daysSinceLastVisit <= targetCadenceDays) return 0; // on-cadence -> holds
  if (daysSinceLastVisit <= targetCadenceDays * 2) return 1; // past 1x -> one step cooler
  return TEMPS.length - 1; // past 2x -> dormant
}

// Suggests a temperature by applying decay steps to the *current* manual
// value (defaulting to "warm" if nothing's been set yet). Decay only ever
// moves toward "dormant" — it never warms someone back up on its own.
function suggestRelationshipTemp({ currentTemp, tier, daysSinceLastVisit }) {
  const targetCadenceDays = TARGET_CADENCE_DAYS[tier] || TARGET_CADENCE_DAYS[3];
  const steps = recencyDecaySteps(daysSinceLastVisit, targetCadenceDays);

  const startIndex = TEMPS.indexOf(currentTemp);
  const baseIndex = startIndex === -1 ? TEMPS.indexOf('warm') : startIndex;
  return TEMPS[Math.min(baseIndex + steps, TEMPS.length - 1)];
}

module.exports = { suggestRelationshipTemp, TARGET_CADENCE_DAYS, TEMPS };
