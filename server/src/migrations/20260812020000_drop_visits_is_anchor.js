// Drops visits.is_anchor — the "arrange the rest of a day around a manual
// stop" mechanism it backed has been removed outright, not just its
// consumers repointed: a manually-planned visit now counts as "already
// committed" (scheduleDraft.js's committedDateSummaries, the same-day
// carve-out for it removed) exactly like a draft-committed one, so the
// generator never runs on that date at all — nothing left to anchor a zone
// choice around. Every former reader/writer is gone:
//   - scheduleDraft.js: manualStopsForDates (deleted), the anchor-writeback
//     loop in generateAndPersistDraft, the detour-cost branch in
//     getDayZones, the writeback loop in selectDayZone, and the
//     anchored-start-point override in reoptimizeDay — all removed. The
//     is_anchor SELECTs in committedDayVisits/committedVisitsQuery too.
//   - scheduleGenerator.js: pickZoneForDay's manualStops param/anchorUpdates
//     return, and generateDraft's manualStopsByDate param — removed.
//   - routes/visits.js: is_anchor dropped from EDITABLE, its validation, and
//     the GET /calendar select.
//   - manualVisits.js: stopped setting it on create/reschedule.
//   - RoutePlanner.jsx: the Anchor/⚓ Anchored toggle and the "switching to
//     X adds ~N min of driving" detour banner — removed (the "manually
//     planned"/"planned by {name}" markers stay; those are unrelated).
// No FK on this column, so a plain drop needs no rebuildSqliteTable rebuild
// — same precedent as 20260811020000_drop_visits_next_visit_date.js.
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('is_anchor');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.integer('is_anchor');
  });
};
