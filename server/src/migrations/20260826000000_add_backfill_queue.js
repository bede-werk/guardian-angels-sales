// Durable queue behind the incremental distance backfill (services/backfillQueue.js).
// A place lands here when it needs its place_distance rows computed - new
// place, successful geocode - or recomputed - address change. One row per
// place (re-queueing an already-queued place resets it rather than
// duplicating), and it survives a restart: Railway redeploys the container
// on every push, so an in-memory queue would silently lose work.
exports.up = async function up(knex) {
  await knex.schema.createTable('backfill_queue', (t) => {
    t.integer('place_id').primary().references('id').inTable('places').onDelete('CASCADE');
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    // When this row becomes eligible to try again - now for a fresh entry,
    // pushed out by the retry backoff after a failure. The worker's read
    // query is just "due and not permanently failed".
    t.timestamp('next_attempt_at').notNullable().defaultTo(knex.fn.now());
    // Set once attempts are exhausted - the row stays (for the coverage
    // report and a manual retry) instead of being deleted, but the worker
    // stops picking it up.
    t.timestamp('failed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  await knex.schema.alterTable('backfill_queue', (t) => {
    t.index(['failed_at', 'next_attempt_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('backfill_queue');
};
