// Drops visits.skip_reason (added by 20260712000000_add_scheduling_fields.js)
// — never read or written anywhere in routes/services/frontend. The whole
// "skip a stop" feature it belonged to was part of the old Schedule.jsx
// scheduler, retired 2026-07-15; nothing rebuilt an equivalent in the new
// "Plan My Visits" workspace. No FK, so a plain drop needs no
// rebuildSqliteTable rebuild.
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('skip_reason');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.text('skip_reason');
  });
};
