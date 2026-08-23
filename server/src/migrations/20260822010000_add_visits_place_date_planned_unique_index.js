// Backstop for Manual Visit Planning's SAME_DATE_VISIT hard block
// (services/manualVisits.js's classifyConflicts): a partial unique index
// closing the same TOCTOU gap visits_place_date_active_unique closes for
// commitDay (see that migration's own comment) - a check-then-insert alone
// can't prevent two concurrent requests from both passing the conflict
// check before either write lands.
//
// Scoped to status='planned' rather than source='planner' (the older
// index's scope): manualVisits.js's own hard-block policy already treats
// "a second open plan for this place on this date" as unconditionally
// disallowed regardless of source, so this has to hold for a
// planner-committed row and a manually-planned one alike. Deliberately NOT
// status != 'skipped' either - a completed visit legitimately duplicates
// another completed visit at the same place/date (two different contacts
// met there the same day, see the older index's own note on place 264) -
// this must only ever govern still-open 'planned' rows, never 'completed'
// ones, so the two indexes' scopes are disjoint on purpose.
exports.up = async function up(knex) {
  await knex.raw(
    `CREATE UNIQUE INDEX visits_place_date_planned_unique ON visits(place_id, scheduled_date) WHERE status = 'planned'`
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS visits_place_date_planned_unique`);
};
