// Removes places.default_visit_type (added 20260713000000). Bede's call
// (2026-08-11): a place's default visit type is now fully computed —
// 'pre_qualification' until capacity is declared, then keyed off capacity
// level (config/visitTypes.js's DEFAULT_VISIT_TYPE_BY_CAPACITY, resolved by
// scheduleGenerator.js's defaultVisitTypeForCapacity) — so the stored,
// never-actually-editable column is dead weight, same treatment
// current_agency_used/has_inhouse_service got in
// 20260810010000_drop_agency_and_inhouse_service.js.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('default_visit_type');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('default_visit_type');
  });
};
