// Adds a place-level default visit type — one of config/visitTypes.js's
// VISIT_TYPES keys — that pre-fills the visit-type choice when scheduling a
// visit at this place; every visit can still choose a different type from
// its place's default. Nullable: there's no existing data to backfill this
// from, and a null default just falls through to
// config/visitTypes.js's DEFAULT_VISIT_TYPE at scheduling time.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('default_visit_type');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('default_visit_type');
  });
};
