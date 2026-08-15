// Adds the two columns a planned visit needs to resolve to 'snoozed' instead
// of just 'completed'/'skipped' (see HANDOFF.md's visit-terminal-states work).
//
//   snoozed_until - 'YYYY-MM-DD', nullable. Same plain-date-string convention
//                   as next_visit_date/places.snooze_until. Set once, at the
//                   moment a rep snoozes a planned visit; not touched again.
//   resolved_at   - timestamp, nullable. Stamped the moment a visit LEAVES
//                   'planned' for any terminal state (completed already had
//                   its own completed_at; this is the equivalent for
//                   snoozed/skipped, and gives the skip-sweep a stable anchor
//                   instead of re-deriving "when did this lapse" from
//                   scheduled_date on every read).
//
// Plain alterTable - neither column carries a FK, so no rebuildSqliteTable
// needed (see 20260709000000_detach_instead_of_cascade.js for when that
// pattern IS required).
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('snoozed_until');
    t.timestamp('resolved_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('snoozed_until');
    t.dropColumn('resolved_at');
  });
};
