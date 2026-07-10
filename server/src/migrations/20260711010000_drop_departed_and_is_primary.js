// Removes the "primary contact" and "departed" flags on people. Both were
// manually-set markers; there's no computed replacement — the app just no
// longer distinguishes people this way.
exports.up = async function up(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('departed');
    t.dropColumn('is_primary');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.boolean('departed').notNullable().defaultTo(false);
    t.boolean('is_primary').notNullable().defaultTo(false);
  });
};
