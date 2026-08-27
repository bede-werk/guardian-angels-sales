// Cached real road distances between places (services/matrixCache.js),
// replacing OSRM's /trip and /table calls (and the fixed-order /route call
// in services/routeOptimizer.js) in the route-generation request path. Empty
// after this migration - scripts/backfill-distances.js fills it, and until
// then every pair falls back to the geometric estimate (see
// config/matrixCache.js).
//
// Directional on purpose: one-way streets mean A->B and B->A can genuinely
// differ, so both rows are stored rather than assuming symmetry.
//
// Lives in the app's normal DB (SQLite dev / Postgres prod via Knex), not a
// separate file - there is no standalone routing database in this app.
exports.up = async function up(knex) {
  await knex.schema.createTable('place_distance', (t) => {
    t.integer('from_place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
    t.integer('to_place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
    t.float('meters').notNullable();
    t.float('seconds').notNullable();
    // Where this row came from - 'osrm' today, room for a hosted provider
    // once the backfill queue (checkpoint 3) picks one.
    t.string('source').notNullable().defaultTo('osrm');
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.primary(['from_place_id', 'to_place_id']);
  });
  await knex.schema.alterTable('place_distance', (t) => {
    t.index('from_place_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('place_distance');
};
