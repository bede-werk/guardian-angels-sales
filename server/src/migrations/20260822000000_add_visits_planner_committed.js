// Manual Visit Planning bug fix, 2026-08-22. See HANDOFF.md's Manual Visit
// Planning section (§20/§20A/§20B) for the full story.
//
// `committedDateSummaries` (services/scheduleDraft.js) decides whether a
// date is "already committed" - locked from a fresh /generate call - by
// checking whether any of that date's still-planned visits carries
// source: 'planner'. That held up fine until editVisit
// (services/manualVisits.js) started promoting ANY successful hand-edit -
// even a notes-only one, no date change at all - to source: 'manual'. If a
// date's only planner-committed visit gets its notes fixed, `source`
// silently flips away from 'planner' and the date's "already committed"
// protection disappears from the Route Planner's own date-picker - even
// though the visit is still sitting there, unresolved. Confirmed live
// before this fix: a plain notes edit on the day's only committed visit
// reopened that date for a fresh /generate.
//
// Root cause: `source` was being asked two different questions at once -
// "how did this row come to exist" (commitDay's write, a permanent fact)
// and "does a rep currently own hand-editing rights over it" (editVisit's
// promotion, which is SUPPOSED to be free to change - that part is
// deliberate, not being touched here). `planner_committed` splits those
// apart: written ONCE, only by commitDay's insert, and never touched again
// by anything else - same "permanent snapshot, never revised" convention
// as visits.place_name - so committedDateSummaries has a birth fact to gate
// on that editVisit's promotion can no longer silently erase.
//
// Backfilled from the CURRENT source column: every existing source:
// 'planner' row really was committed by the planner, so this is an exact
// backfill, not a guess.
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.integer('planner_committed').notNullable().defaultTo(0);
  });
  await knex('visits').where({ source: 'planner' }).update({ planner_committed: 1 });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('planner_committed');
  });
};
