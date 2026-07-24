// Removes people.role_type (decision_maker/gatekeeper/champion/other). Bede's
// call: too ambiguous to reliably fill in for every person being loaded into
// the app, and not useful enough to justify the upkeep — a person's existing
// free-text `title` already conveys enough of this. No index existed on this
// column, so (unlike relationship_temp's drop) there's no DROP INDEX step needed.
exports.up = async function up(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('role_type');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.string('role_type');
  });
};
