// Tracks when a place's lat/lng were last (attempted to be) resolved, so the
// backfill script can skip rows it already processed instead of re-guessing
// from lat/lng alone (a place can be attempted and still have no match).
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.timestamp('geocoded_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('geocoded_at');
  });
};
