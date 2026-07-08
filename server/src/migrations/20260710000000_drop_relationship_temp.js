// Removes the manual relationship-temperature field (hot/warm/cold/dormant).
// It's replaced by objective, time-aware referral metrics computed live from
// the `referrals` table (see services/referralMetrics.js) — nothing to store,
// so there's no replacement column here.
exports.up = async function up(knex) {
  await knex.raw('DROP INDEX IF EXISTS "people_relationship_temp_index"');
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('relationship_temp');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.string('relationship_temp');
  });
  await knex.raw('DROP INDEX IF EXISTS "people_relationship_temp_index"');
  await knex.schema.alterTable('people', (t) => {
    t.index(['relationship_temp'], 'people_relationship_temp_index');
  });
};
