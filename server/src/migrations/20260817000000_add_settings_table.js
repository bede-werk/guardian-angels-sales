// Storage for the settings page's tunable overrides (config/tunables.js).
//
// This table holds ONLY the values the user has actually changed. Defaults
// stay in the config/*.js modules where they've always lived, so an untouched
// install has an empty table and every number still comes from code. That
// also means "reset to default" is a DELETE, not a write, and a tunable that
// gets removed or renamed in a later version leaves behind a harmless orphan
// row rather than a value nothing can interpret (services/settings.js drops
// unknown keys on load).
exports.up = async function up(knex) {
  await knex.schema.createTable('settings', (t) => {
    // Dotted path into a config module, e.g. 'scheduling.HARD_FLOOR_DAYS'.
    // Not a foreign key to anything: the registry lives in code.
    t.string('key').primary();
    // JSON-encoded, because a tunable can be a number, a string, an array of
    // category names, or the whole category-seed rule table. Encoding
    // everything the same way avoids a type column that would have to stay in
    // sync with the registry's own type field.
    t.text('value').notNullable();
    // Who last changed it and when - the settings page shows this so a
    // surprising number can be traced back rather than just discovered.
    t.integer('updated_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('settings');
};
