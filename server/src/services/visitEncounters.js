// Visit encounters - the who-was-met rows hanging off a trip (see migration
// 20260806000000_split_visit_encounters.js, which split one flat `visits` row
// per encounter into a trip + its encounters).
//
// This module exists because four separate list views - the Calendar tab, a
// place's visit history, a person's visit history and the dashboard - all
// need the exact same thing: trips with a short "who was met" summary
// attached, fetched in ONE extra query rather than one per row. Same
// batch-then-group-in-JS shape (and same reason) as referralMetrics.js's
// referralMetricsByPersonId.
//
// It is deliberately NOT used by anything that scores: services/relationship.js
// reads encounters joined to their trip's scheduled_date, which is a different
// query with a different shape.

// What a LIST row needs: enough to render "with Dana Ruiz and the
// receptionist", and nothing else. Outcome is excluded because a trip now has
// several of them and a list has no honest place to show one; the contact
// snapshot (title/email/phone) is excluded because no list renders it and
// shipping it would put every contact detail on file into a month-wide
// calendar payload. GET /api/visits/:id is the one call that returns
// everything - see routes/visits.js.
const SUMMARY_COLUMNS = ['person_name', 'met_with_type'];

// visit_id -> [encounter, ...], in insertion order (which is the order the rep
// ticked people in the log form). One query for every id passed.
async function encountersByVisitId(knex, visitIds, columns = SUMMARY_COLUMNS) {
  const byVisit = new Map();
  const ids = [...new Set(visitIds.filter((id) => id != null))];
  if (!ids.length) return byVisit;

  const rows = await knex('visit_encounters')
    .whereIn('visit_id', ids)
    .orderBy('id', 'asc')
    .select('visit_id', ...columns);

  for (const row of rows) {
    const { visit_id: visitId, ...encounter } = row;
    // SQLite stores booleans as 0/1; the client treats this as a real boolean.
    if (encounter.they_requested !== undefined) encounter.they_requested = !!encounter.they_requested;
    if (!byVisit.has(visitId)) byVisit.set(visitId, []);
    byVisit.get(visitId).push(encounter);
  }
  return byVisit;
}

// Returns `visits` with an `encounters` array attached to each. A trip with no
// encounters gets [] rather than null - a still-`planned` visit legitimately
// has none yet, and that's a normal state, not missing data.
//
// idKey exists because dashboard.js aliases the visit id to `visit_id` in its
// own select; everything else uses the plain `id`.
async function attachEncounters(knex, visits, { columns = SUMMARY_COLUMNS, idKey = 'id' } = {}) {
  if (!visits.length) return visits;
  const byVisit = await encountersByVisitId(knex, visits.map((v) => v[idKey]), columns);
  return visits.map((v) => ({ ...v, encounters: byVisit.get(v[idKey]) || [] }));
}

module.exports = {
  SUMMARY_COLUMNS,
  encountersByVisitId,
  attachEncounters,
};
