// Follow-up to 20260812000000_add_manual_visit_planning_fields.js — see
// docs/manual-visit-planning-spec.md (v2, 2026-08-12) §2.1. `origin` was a
// near-synonym for the existing `source` column ('planner' vs 'manual') but
// answering a DIFFERENT question, with 'manual' meaning opposite things in
// each: logged-after-the-fact on `source`, planned-in-advance on `origin`.
// Same word, two columns, opposite meanings — not shipping that.
//
// `planned_manually` replaces it: the question it answers is yes/no ("was
// this planned in advance through the manual-planning feature"), so it's a
// 0/1 flag, not a two-value enum. `source` is untouched — it still means
// exactly what it always has.
//
// Implemented as add-new-column + backfill + drop-old rather than a literal
// RENAME COLUMN + type change: `origin` is TEXT and `planned_manually` is
// INTEGER, and a single rename can't also change type — doing both as
// separate, portable steps (works identically on SQLite/dev and
// Postgres/prod) avoids relying on either engine's specific ALTER COLUMN
// TYPE syntax. No real data at risk: the previous migration's own backfill
// only ever set `origin = 'draft'` (its column default) on every existing
// row — no `'manual'` value has ever been written, since this feature's
// create path (services/manualVisits.js) doesn't exist yet.
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.integer('planned_manually').notNullable().defaultTo(0);
  });
  await knex('visits').where({ origin: 'manual' }).update({ planned_manually: 1 });
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('origin');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.text('origin').notNullable().defaultTo('draft');
  });
  await knex('visits').where({ planned_manually: 1 }).update({ origin: 'manual' });
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('planned_manually');
  });
};
