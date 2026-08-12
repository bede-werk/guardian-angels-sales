// Drops visits.next_visit_date — the Place Commitments spec's final step
// (§10 build order, step 8), now that every consumer has been verified
// against place_commitments instead:
//   - step 1 (20260811010000_add_place_commitments.js): backfilled what was
//     on file (0 real values — every non-null row was an empty-string
//     artifact) and stopped it being read by the backfill's own source.
//   - step 4 (routes/visits.js EDITABLE): stopped being written.
//   - step 5 (scheduleDraft.js/conflictDetection.js/the snooze guard):
//     stopped being read for ranking/eligibility.
//   - step 7 (routes/places.js, routes/people.js, routes/visits.js's
//     fetchVisit; PlaceDetail.jsx/PersonDetail.jsx/VisitDetailModal.jsx):
//     stopped being read for display, replaced by commitments_made
//     (source_visit_id).
// No FK on this column, so a plain drop needs no rebuildSqliteTable rebuild
// — same precedent as 20260722000000_drop_visits_skip_reason.js.
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('next_visit_date');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('next_visit_date');
  });
};
