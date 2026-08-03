// Migration A of the computed-relationship work (see services/relationship.js).
// Adds the three fields a visit needs to carry so relationship strength can be
// measured from what actually happened on a visit, rather than from a manual
// field nobody maintains:
//
//   met_with_type  — WHO the rep actually spoke to. This is the single biggest
//                    signal: only a named_person visit builds a *person's*
//                    score; staff/receptionist/nobody accrue to the place as a
//                    shallow "we were present" floor instead. Nullable rather
//                    than notNullable+default so a missing value stays
//                    visibly missing (relationship.js treats unknown as the
//                    lowest-weight case) instead of silently masquerading as a
//                    real answer.
//   they_requested — did THEY ask us for something (materials, availability, a
//                    callback)? The purest reciprocity signal available, and
//                    the only one here that measures their investment rather
//                    than the rep's own activity.
//   actual_duration_minutes — deliberately NOT used by the relationship model.
//                    Captured now purely so config/visitTypes.js's currently
//                    hardcoded per-type minutes can eventually be calibrated
//                    against real observed durations. Highest-leverage
//                    "gets better with use" field currently not captured
//                    anywhere; costs one nullable column to start collecting.
//
// Plain alterTable — none of these are FK-bearing, so this doesn't need the
// rebuildSqliteTable pattern from 20260709000000_detach_instead_of_cascade.js
// (that's only required when CHANGING or DROPPING a column that already
// carries a foreign key).
//
// Backfill is deliberately crude: existing completed visits get
// 'named_person' if they have a person_id and 'nobody' otherwise. Those visits
// also carry outcome values from the pre-relationship enum
// (interested/not_ready/follow_up/no_answer/left_materials), which
// relationship.js's OUTCOME_WEIGHT map doesn't recognize and scores at its
// documented unknown-outcome floor — so their total contribution is small
// either way. All current visit data is test data; the real old->new outcome
// mapping is Bede's to write at historical-import time (see HANDOFF.md).
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('met_with_type'); // named_person | staff | receptionist | nobody
    t.integer('actual_duration_minutes'); // nullable — not read by the relationship model
    t.boolean('they_requested').notNullable().defaultTo(false);
  });

  // Row-by-row in JS rather than a raw correlated UPDATE, so it behaves
  // identically on SQLite and Postgres — same precedent as the place_name
  // backfill in 20260709000000_detach_instead_of_cascade.js.
  const completed = await knex('visits').where({ status: 'completed' }).select('id', 'person_id');
  for (const v of completed) {
    await knex('visits')
      .where({ id: v.id })
      .update({ met_with_type: v.person_id ? 'named_person' : 'nobody' });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('met_with_type');
    t.dropColumn('actual_duration_minutes');
    t.dropColumn('they_requested');
  });
};
