// Manual Visit Planning - three new columns on `visits`. See
// docs/manual-visit-planning-spec.md (pasted spec, 2026-08-12) §2 for the
// full design.
//
//   origin             - 'draft' | 'manual'. Distinguishes a visit the human
//                         planned directly (this feature) from every other
//                         way a visits row comes to exist today - both a
//                         route-planner draft commit (source='planner') and
//                         an ad-hoc "Log a visit" entry (source='manual',
//                         the DB default on that OTHER column) backfill to
//                         'draft' here. Yes, an ad-hoc logged visit backfills
//                         to origin='draft' even though it was never part of
//                         a draft - origin's only job is "did the NEW manual-
//                         planning surfaces create this," not a full history
//                         of how a row was made (that's still `source`'s
//                         job). Defaulting the column covers every existing
//                         row; no separate backfill query needed.
//   created_by_user_id - who PLANNED the visit, deliberately distinct from
//                         user_id (who the visit is FOR) - cross-rep
//                         planning is allowed (§5), so "who decided this"
//                         and "whose day is this" are different questions.
//                         Backfilled to each row's own user_id: every visit
//                         that exists before this feature was planned by (or
//                         for) the same rep it's assigned to.
//   is_anchor           - nullable on purpose: NULL (no generation has run
//                         against this day yet), 1 (anchor - the day's zone
//                         is built around this stop), 0 (float - explicitly
//                         declined to anchor). A plain boolean defaulting to
//                         0 can't distinguish "never asked" from "asked and
//                         declined," which is what the §7.2 anchor prompt
//                         needs to fire exactly once per manual stop. Left
//                         NULL on every existing row (no manual stops exist
//                         yet by definition - this feature didn't exist).
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.text('origin').notNullable().defaultTo('draft');
    t.integer('created_by_user_id').references('id').inTable('users');
    t.integer('is_anchor');
  });

  await knex('visits').update({ created_by_user_id: knex.raw('user_id') });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('origin');
    t.dropColumn('created_by_user_id');
    t.dropColumn('is_anchor');
  });
};
