// Removes current_agency_used/has_inhouse_service (added 20260712000000).
// Bede's call (2026-08-10): drop the fields and all associated functionality,
// not just leave them as unused intel - see capacity-computation-spec.md §10
// and HANDOFF.md §18 for the removal note.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('current_agency_used');
    t.dropColumn('has_inhouse_service');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.text('current_agency_used');
    t.boolean('has_inhouse_service');
  });
};
