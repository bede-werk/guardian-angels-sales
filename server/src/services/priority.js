// Geographic bucketing for route clustering.
//
// This module used to also own priority scoring - `priorityScore(tier,
// isPriority)`, which turned places.tier (1/2/3) plus the ⭐ flag into a
// 100/75/50/25 value stored on places.priority_score, and `priorityLabel`,
// which rendered the same pair as text. All of it is retired as of
// 2026-08-23; region bucketing is what's left.
//
// Why it went: the tier/star pair only ever had four realised states (every
// starred place was tier 1), so it was a four-level importance scale wearing
// a three-level costume, and this header already admitted the intended
// referral-history feedback loop "isn't wired in yet" - it never was. Bede
// confirmed tier meant "how much business could this place send us," which is
// capacity's own definition, so that judgment moved to places.capacity_seed
// and now feeds the capacity axis directly instead of a tie-break almost
// nothing read. See migration 20260823000000 and services/capacity.js's
// resolution ladder.
//
// All three columns (tier, is_priority, priority_score) were dropped in
// migration 20260825000000. Don't reintroduce them - the questions they were
// reaching for are answered by places.capacity_seed (how much can this place
// send) and places.is_all_star (is it one of the ~25 that matter most).

// Rough "side of town" bucket for Lincoln, used to cluster a day's route.
// Falls back to the city name for out-of-town places (Beatrice, Waverly, etc.).
const LINCOLN_ZIP_REGION = {
  '68501': 'Central Lincoln',
  '68502': 'South Lincoln',
  '68503': 'North Lincoln',
  '68504': 'Northeast Lincoln',
  '68505': 'East Lincoln',
  '68506': 'Southeast Lincoln',
  '68507': 'Northeast Lincoln',
  '68508': 'Downtown Lincoln',
  '68510': 'East Lincoln',
  '68512': 'South Lincoln',
  '68514': 'North Lincoln',
  '68516': 'South Lincoln',
  '68517': 'North Lincoln',
  '68520': 'Southeast Lincoln',
  '68521': 'Northwest Lincoln',
  '68522': 'Southwest Lincoln',
  '68523': 'Southwest Lincoln',
  '68524': 'West Lincoln',
  '68526': 'Southeast Lincoln',
  '68527': 'East Lincoln',
  '68528': 'West Lincoln',
  '68531': 'North Lincoln',
};

// Buckets a place into a "side of town" (or their city, if not in Lincoln)
// so the scheduler can cluster a day's route into a tight geographic area.
function regionForPlace({ city, zip }) {
  const z = (zip || '').toString().trim().slice(0, 5);
  if (LINCOLN_ZIP_REGION[z]) return LINCOLN_ZIP_REGION[z];
  if (city && String(city).trim()) return String(city).trim();
  return 'Unknown';
}

module.exports = { regionForPlace };
