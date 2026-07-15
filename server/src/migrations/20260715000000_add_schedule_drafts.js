// Phase 6 (route planner): draft/commit lifecycle. A draft is the multi-day
// route-planner engine's output before a rep has reviewed/edited/committed
// it — kept in its own tables, fully separate from `visits`, until each
// day is explicitly committed (see services/scheduleDraft.js). Nothing here
// needs the app's usual detach-and-snapshot treatment (see
// 20260709000000_detach_instead_of_cascade.js) because a draft is ephemeral
// working state, not history: deleting a place or user mid-draft just drops
// it from the draft (CASCADE), never preserved.
exports.up = async function up(knex) {
  await knex.schema.createTable('schedule_drafts', (t) => {
    t.increments('id').primary();
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');

    // The generateDraft() inputs that produced this draft (days: [{ date,
    // hoursPerDay }], homeBase, zoneOverrides) — kept so a day can be
    // regenerated/extended later without the caller re-supplying everything.
    t.text('params_json').notNullable();

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    // "One active draft per user" is enforced in application code (see
    // scheduleDraft.js's getActiveDraft/createDraft), not a DB constraint —
    // same convention as scheduler.js's existing "plan already exists for
    // the day" check.
    t.index(['user_id']);
  });

  await knex.schema.createTable('schedule_draft_stops', (t) => {
    t.increments('id').primary();
    t.integer('draft_id').notNullable().references('id').inTable('schedule_drafts').onDelete('CASCADE');
    t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');

    t.string('date').notNullable(); // 'YYYY-MM-DD'
    t.string('visit_type'); // nullable override — falls back to places.default_visit_type
    t.integer('sort_order').notNullable().defaultTo(0);

    t.timestamp('created_at').defaultTo(knex.fn.now());

    // No 'removed'/status column: a stop's presence in this table IS the
    // draft — removing a stop is a DELETE, not a soft flag. No stored
    // running-totals/overBudget either — those are recomputed live on every
    // read (scheduleDraft.js's loadDraftView), matching this app's existing
    // "no manual fields that need upkeep" convention (referralMetrics.js
    // works the same way).
    t.index(['draft_id', 'date']);
    t.index(['place_id']);
    t.unique(['draft_id', 'place_id']); // a place can't appear twice in one user's own draft
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('schedule_draft_stops');
  await knex.schema.dropTableIfExists('schedule_drafts');
};
