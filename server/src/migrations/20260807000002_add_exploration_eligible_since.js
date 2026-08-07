// Migration for capacity-computation-spec.md §8.2 (EXPLORATION tier aging
// guard, step 7). Adds a REAL column instead of the spec's own original
// pseudocode, which fell back to `place.created_at` at READ time whenever
// this value was missing:
//
//   daysWaiting = asOf - (place.exploration_eligible_since ?? place.created_at)
//
// Bede caught the bug that fallback would cause before it shipped: a place
// that's been FRESH for months (recently pre-qualified) and then goes stale
// re-enters EXPLORATION — but with no real eligible_since ever recorded, the
// live fallback would hand it `created_at`, often a year old, as its aging
// anchor. That backdates its "waiting" clock by the better part of a year
// and jumps it straight to rank 0 the DAY it goes stale — ahead of places
// that have genuinely never been pre-qualified at all and have been waiting
// the honest way. A real, explicitly-stamped column has no such fallback to
// misuse: it always holds the actual date this place became (or will next
// become) eligible for EXPLORATION, so daysWaiting is always the real wait.
//
// Two write events keep this column current going forward (see
// routes/places.js's POST /:id/capacity-observations and routes/visits.js's
// maybeCapturePreQualification, plus POST /places for brand-new rows):
//   - A place is created: eligible immediately (never pre-qualified yet).
//   - A capacity_observations row is inserted: this place will next become
//     eligible when THAT observation goes stale, i.e.
//     observed_at + CAPACITY_STALE_DAYS — computed and stamped immediately,
//     not derived later, so a future CAPACITY_STALE_DAYS retune doesn't
//     retroactively reshuffle every place already waiting in EXPLORATION.
//
// No DB-level default: relying on a schema-level `knex.fn.now()`/CURRENT_DATE
// default here risks a raw timestamp landing in a column every other
// consumer (daysSince, in services/schedulingEngine.js) expects as a plain
// 'YYYY-MM-DD' string — same convention capacity_observations.observed_at
// documents. The application sets this column explicitly at every write
// site instead (matches this migration's own backfill below).
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('exploration_eligible_since');
  });

  const CAPACITY_STALE_DAYS = require('../config/scheduling').CAPACITY_STALE_DAYS;

  const places = await knex('places').select('id', 'created_at');
  const latestObservations = await knex('capacity_observations')
    .orderBy('place_id')
    .orderBy('observed_at', 'desc')
    .orderBy('id', 'desc')
    .select('place_id', 'observed_at');

  const latestByPlace = new Map();
  for (const row of latestObservations) {
    if (!latestByPlace.has(row.place_id)) latestByPlace.set(row.place_id, row.observed_at);
  }

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
  }

  for (const place of places) {
    const latestObservedAt = latestByPlace.get(place.id);
    // A place with a declared observation becomes eligible again once that
    // observation goes stale — even if that date is in the past (an old
    // 'import' backfill observation, say) or the future (a fresh one). A
    // place with none at all has been eligible since it was created.
    const eligibleSince = latestObservedAt
      ? addDays(latestObservedAt, CAPACITY_STALE_DAYS)
      : new Date(place.created_at).toISOString().slice(0, 10);
    await knex('places').where({ id: place.id }).update({ exploration_eligible_since: eligibleSince });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('exploration_eligible_since');
  });
};
