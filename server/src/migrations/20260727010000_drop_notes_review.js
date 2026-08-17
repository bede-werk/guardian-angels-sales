// Removes the "Needs Mapping" feature entirely, per Bede's request - no more
// use for manually resolving unmatched historical referrer notes, and he's
// planning a from-scratch replacement for that workflow later. Drops
// notes_review outright (a plain table drop, not a FK-bearing column change
// on another table, so no rebuildSqliteTable dance needed - see
// 20260709000000_detach_instead_of_cascade.js for when that pattern is
// actually required). visits.source (added by the same original migration
// that created this table, 20260706010000_notes_import.js) is untouched -
// it's still load-bearing for the route planner's commit-collision unique
// index (source: 'planner' vs 'manual'), not specific to this feature.
exports.up = async function up(knex) {
  await knex.schema.dropTableIfExists('notes_review');
};

exports.down = async function down(knex) {
  await knex.schema.createTable('notes_review', (t) => {
    t.increments('id').primary();
    t.string('referrer_raw').notNullable();
    t.text('note_text');
    t.string('note_date');
    t.string('note_time_raw');
    t.string('author_raw');
    t.integer('author_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('status').notNullable().defaultTo('pending');
    t.integer('assigned_place_id').references('id').inTable('places').onDelete('SET NULL');
    t.integer('assigned_visit_id').references('id').inTable('visits').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['status']);
    t.index('author_user_id', 'notes_review_author_user_id_index');
  });
};
