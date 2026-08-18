// Pure helpers behind the Dashboard rollup (routes/dashboard.js). No knex,
// no I/O - same discipline as services/driveTime.js and
// services/schedulingEngine.js: the route queries the DB, shapes rows into
// these input shapes, and calls in here. Everything below is deterministic
// and takes `today` as an argument rather than reading the clock, so the
// tests can pin a date.

const { estimateDriveMinutes, isGeocoded } = require('./driveTime');

const MS_PER_DAY = 86400000;

// 'YYYY-MM-DD' + n days, in UTC. Never local getters/setters (.getDate()/
// .setDate() read and write the HOST's calendar day, so the same call gives
// a different answer on a server in Auckland) - same UTC convention
// referralMetrics.js's recentWindowCutoff and schedulingEngine.js's
// daysSince already use. The date STRINGS this app stores are org-local
// wall dates with no time component, so treating them as UTC midnights is
// exact arithmetic, not an approximation.
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * MS_PER_DAY);
  const pad = (v) => String(v).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Whole days from `from` to `to`. Negative means `to` is in the past - which
// is exactly what "overdue" means for a commitment, so callers can read the
// sign rather than being handed a separate boolean they could disagree with.
function daysBetween(from, to) {
  const parse = (s) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / MS_PER_DAY);
}

// The seven ISO-week dates (Monday..Sunday) containing `dateStr`. Computed
// here rather than with dayjs/isoWeek so this module stays dependency-free
// and testable in isolation; routes/dashboard.js gets its week bounds from
// this, so there is exactly one definition of "this week" in play.
function isoWeekDates(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const mondayOffset = dow === 0 ? -6 : 1 - dow; // Sunday belongs to the week that started 6 days ago
  const monday = addDays(dateStr, mondayOffset);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

// Total estimated drive minutes for a day's stops IN THE ORDER GIVEN.
//
// Two deliberate limits, both surfaced in the return value rather than
// hidden:
//
// 1. Stop-to-stop only. The leg from wherever the rep actually starts is
//    NOT included, because it can't be: homeBase is captured per-session in
//    the browser and never persisted (see RoutePlanner.jsx's homeBase
//    declaration), so by the time a day is committed there is no stored
//    origin to measure from. Inventing one would be worse than omitting it.
// 2. Haversine, not OSRM. The Dashboard reloads on every tab switch, and
//    services/routeOptimizer.js talks to a public demo server with no SLA
//    and a 5s timeout. An at-a-glance figure is not worth putting a network
//    round-trip on the app's most-loaded screen; the Route Planner still
//    uses real road routing where the number actually drives decisions.
//
// Ungeocoded stops can't contribute a leg (same isGeocoded rule the packing
// code uses) - they're counted separately so the UI can say the estimate is
// partial instead of quietly understating the day.
function routeDriveEstimate(stops, driveConfig = {}) {
  const routable = stops.filter(isGeocoded);
  let minutes = 0;
  for (let i = 1; i < routable.length; i += 1) {
    minutes += estimateDriveMinutes(routable[i - 1], routable[i], driveConfig);
  }
  return {
    minutes,
    legs: Math.max(0, routable.length - 1),
    routable_stops: routable.length,
    ungeocoded_stops: stops.length - routable.length,
  };
}

// A week's visits bucketed into one entry per day, Monday..Sunday, with
// empty days present rather than missing - the card renders a fixed seven
// columns, and a sparse map would silently shift the days along.
function weekDayBuckets(visits, weekDates) {
  const byDate = new Map(weekDates.map((date) => [date, { date, completed: 0, planned: 0, skipped: 0 }]));
  for (const v of visits) {
    const bucket = byDate.get(v.scheduled_date);
    if (!bucket) continue; // shouldn't happen - the query is already bounded to the week
    if (v.status === 'completed') bucket.completed += 1;
    else if (v.status === 'planned') bucket.planned += 1;
    else if (v.status === 'skipped') bucket.skipped += 1;
    // 'snoozed' is deliberately uncounted: snoozing doesn't move the row's
    // scheduled_date (see visitLifecycle.js / HANDOFF §19), so counting it
    // on this day would report a deferral as if it were work sitting here.
  }
  return weekDates.map((date) => byDate.get(date));
}

// Rounds a minute count into the form the UI shows ("1h 25m" / "45m").
// Server-side so the same phrasing is used wherever this number appears,
// rather than each caller re-deriving it.
function formatMinutes(minutes) {
  if (!minutes) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

module.exports = {
  addDays,
  daysBetween,
  isoWeekDates,
  routeDriveEstimate,
  weekDayBuckets,
  formatMinutes,
};
