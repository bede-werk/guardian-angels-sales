// Separate from geocoded_at (added 20260711000000), which answers "when did
// we last run geocoding" - true on every PATCH that touches address fields,
// even a re-save of the same address, and true for the whole roster after any
// future bulk re-geocode (provider switch, coordinate refresh). This column
// answers a narrower question - "did the address actually move" - and is
// only ever stamped by routes/places.js's PATCH handler, and only when the
// submitted address/city/state/zip differ from what was already stored.
// NULL on every existing row: no address-change history exists before this
// column did, which is the correct "nothing recorded" default, not a lie.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.timestamp('address_changed_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('address_changed_at');
  });
};
