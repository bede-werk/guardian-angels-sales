// Tunables for the drive-time estimator (services/driveTime.js). Plain
// module, same convention as config/scheduling.js — no settings table yet,
// but kept as named constants so a future settings-table phase can lift them
// out without touching the estimator itself.
//
// This estimates road distance from straight-line (haversine) distance
// rather than calling a routing API — good enough to rank and pack stops,
// not to turn-by-turn navigate. Swap in a real routing API later by
// rewriting estimateDriveMinutes() alone; nothing that calls it needs to
// change.
module.exports = {
  // Average driving speed isn't one number — a parking-lot-to-parking-lot
  // hop and a cross-town trip that gets onto arterials/highway don't drive
  // anything alike. Banded by road distance (post-CIRCUITY_FACTOR), not
  // straight-line, since it's the distance actually driven that determines
  // which kind of road you're on.
  //
  //   under SHORT_BAND_MAX_MILES        -> SPEED_MPH_SHORT
  //   SHORT_BAND_MAX_MILES..MEDIUM_BAND_MAX_MILES (inclusive) -> SPEED_MPH_MEDIUM
  //   over MEDIUM_BAND_MAX_MILES        -> SPEED_MPH_LONG
  SHORT_BAND_MAX_MILES: 1,
  MEDIUM_BAND_MAX_MILES: 5,

  // Dominated by turning out of one parking lot and into another; barely
  // gets out of second gear.
  SPEED_MPH_SHORT: 15,
  // Typical secondary-road hop between nearby stops.
  SPEED_MPH_MEDIUM: 25,
  // Long enough to get onto arterials or a highway stretch for at least
  // part of the trip.
  SPEED_MPH_LONG: 38,

  // Straight-line distance underestimates real road distance because roads
  // aren't straight (grid streets, one-ways, river/rail crossings). 1.3 is a
  // typical urban-grid circuity ratio (road miles / straight-line miles).
  CIRCUITY_FACTOR: 1.3,

  // Fixed cost of parking and walking in, added on top of drive time —
  // roughly constant whether the next stop is next door or across town.
  OVERHEAD_MINUTES: 5,

  // Floor so two places in the same complex/building never estimate to ~0.
  MIN_DRIVE_MINUTES: 3,
};
