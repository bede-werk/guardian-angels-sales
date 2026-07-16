// Belt-and-suspenders for the collision-avoidance logic in
// services/scheduleDraft.js's commitDay: a partial unique index is the real
// guarantee against two reps' concurrent commits both inserting a visit for
// the same place on the same date (a TOCTOU race the application-level
// check-then-insert alone can't close under READ COMMITTED). Excludes
// status='skipped' — a skipped stop for a place/date shouldn't block a real
// visit at that same place/date later. Works on both SQLite (dev) and
// Postgres (prod) via CREATE UNIQUE INDEX ... WHERE, a partial index both
// engines support identically.
//
// Scoped to source='planner' — commitDay is the only inserter that tags its
// rows this way — so this only ever governs the route planner's own commits,
// the actual source of the race. Logging two ad-hoc "manual" visits to the
// same place on the same date (e.g. two different contacts met there in one
// day) is a legitimate, unrelated, pre-existing capability (confirmed against
// real data on 2026-07-15 — place 264 had two same-day manual visits) that
// this must not restrict; a blanket place+date rule would have broken it.
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE UNIQUE INDEX visits_place_date_active_unique ON visits(place_id, scheduled_date) WHERE status != 'skipped' AND source = 'planner'`
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS visits_place_date_active_unique`);
};
