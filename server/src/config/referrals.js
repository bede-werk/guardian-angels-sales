// Tunables for services/referralMetrics.js - the live-derived referral
// numbers shown on people and places (nothing stored, nothing needs upkeep).
module.exports = {
  // The trailing window behind `referrals_last_90_days`. This is the
  // "recent throughput" number the UI shows; note that the capacity model's
  // own measured-floor window is a separate, longer gate (see
  // config/scheduling.js's MEASURED_MIN_EXPOSURE_DAYS) so that a short burst
  // of referrals can't permanently ratchet a place's capacity up.
  //
  // The field LABEL follows this number - it renders as "last N days"
  // wherever it appears, so changing it here doesn't leave the UI lying.
  RECENT_WINDOW_DAYS: 90,
};
