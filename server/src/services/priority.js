// Priority scoring and geographic bucketing.
//
// Requested ordering (highest first):
//   Tier 1 + ⭐ Priority  >  Tier 1  >  Tier 2  >  Tier 3
//
// Score = tier weight + priority bonus, so a higher number always means visit sooner.
//   Tier 1 (=75) + priority (+25) = 100   <- highest
//   Tier 1                        = 75
//   Tier 2                        = 50
//   Tier 3                        = 25
//
// This is a place-level score (drives routing) — a manual Tier/⭐ judgment today.
// It may later be adjusted by linked people's referral history (see
// services/referralMetrics.js and the `referrals` table), but that feedback
// loop isn't wired in yet.

// Computes a place's numeric priority score from its tier (1/2/3) and
// whether it's starred. Stored on places.priority_score so routes can sort
// by it cheaply instead of recomputing on every request.
function priorityScore(tier, isPriority) {
  const tierWeight = { 1: 75, 2: 50, 3: 25 }[tier] || 0; // unknown tier -> 0
  const bonus = isPriority ? 25 : 0;
  return tierWeight + bonus;
}

// Human-readable label for a place's importance.
function priorityLabel(tier, isPriority) {
  if (tier === 1 && isPriority) return 'Priority · Tier 1';
  return `Tier ${tier}`;
}

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

module.exports = { priorityScore, priorityLabel, regionForPlace };
