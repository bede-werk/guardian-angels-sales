// Place Commitments — a dated promise to return to a place, replacing
// visits.next_visit_date as the source of the COMMITMENT tier. See
// migrations/20260811010000_add_place_commitments.js and the pasted spec
// (2026-08-11) for the full design.
//
// A place can have more than one outstanding promise (tell the DON you'll be
// back the 20th and a social worker the 25th), and the one that constrains
// the planner is whichever comes DUE FIRST — the "binding" commitment is the
// earliest promised_date among outstanding rows, not the earliest created
// one. Promise the 25th today and the 20th tomorrow, and FIFO would bind you
// to the 25th while the 20th quietly passes; sorting by promised_date is
// what keeps that from happening.
//
// Outstanding = discharged_at IS NULL. Every commitment ends in exactly one
// of three discharge_reasons — fulfilled (a visit happened), superseded (a
// reschedule replaced it), or waived (a human called it off). Nothing else
// discharges one: a promised_date passing does NOT discharge it, by design —
// an unkept promise stays outstanding and climbs in overdue-ness until a
// human resolves it.
//
// This module is the DB-touching layer only: create/discharge/reschedule/
// waive, the outstanding/binding queries the scheduler and conflict
// detector read (services/scheduleDraft.js, services/conflictDetection.js,
// the snooze guard in routes/visits.js), and attachCommitmentsMade below,
// which points a visit's own history display at the commitment(s) it made
// (via source_visit_id) instead of the retired visits.next_visit_date column.

// Carries person_id/note forward from the original unless the caller
// overrides them — "editable," per the spec, not "always fresh." undefined
// means "use what the original had"; null is a deliberate clear.
function withFallback(value, fallback) {
  return value === undefined ? fallback : value;
}

async function createCommitment(
  db,
  { placeId, promisedDate, personId = null, note = null, sourceVisitId = null, createdByUserId = null }
) {
  const [inserted] = await db('place_commitments')
    .insert({
      place_id: placeId,
      promised_date: promisedDate,
      person_id: personId,
      note,
      source_visit_id: sourceVisitId,
      created_by_user_id: createdByUserId,
    })
    .returning('id');
  const id = inserted && inserted.id !== undefined ? inserted.id : inserted;
  return db('place_commitments').where({ id }).first();
}

// Every outstanding commitment for a place, earliest promised_date first —
// feeds the VisitLogModal pre-check panel and the PlaceDetail card's list,
// both of which need to show more than just the binding one.
async function getOutstandingCommitments(db, placeId) {
  return db('place_commitments')
    .where({ place_id: placeId })
    .whereNull('discharged_at')
    .orderBy('promised_date', 'asc')
    .orderBy('id', 'asc');
}

// The single commitment that actually constrains the planner for this place:
// the earliest outstanding promised_date, or null if none. This is also all
// the snooze commitment guard needs — if the binding date is already past
// the proposed snooze_until, no OTHER outstanding row can be earlier either,
// so checking the binding one alone is sufficient, not just convenient.
async function getBindingCommitment(db, placeId) {
  const row = await db('place_commitments')
    .where({ place_id: placeId })
    .whereNull('discharged_at')
    .orderBy('promised_date', 'asc')
    .orderBy('id', 'asc')
    .first();
  return row || null;
}

// Bulk sibling of getBindingCommitment, for the whole-pool consumers
// (scheduleDraft.js's buildCandidatePool, conflictDetection.js's
// detectConflictsForStops) that need one query instead of one-per-place —
// same "fetch everything, reduce to first-wins in JS" shape as
// buildCandidatePool's existing lastVisitByPlace/nextVisitByPlace maps.
// placeIds is optional; omit it to cover every place with an outstanding
// commitment.
async function getBindingCommitmentsForPlaces(db, placeIds = null) {
  const rows = await db('place_commitments')
    .whereNull('discharged_at')
    .modify((qb) => {
      if (placeIds) qb.whereIn('place_id', placeIds);
    })
    .orderBy('place_id', 'asc')
    .orderBy('promised_date', 'asc')
    .orderBy('id', 'asc');

  const byPlace = new Map();
  for (const row of rows) {
    if (!byPlace.has(row.place_id)) byPlace.set(row.place_id, row);
  }
  return byPlace;
}

// Bulk sibling of getOutstandingCommitments, for the route planner badge
// (spec §6.1): every outstanding commitment for a whole pool of places, one
// query, earliest-first per place, joined to the person's name (the badge's
// "who"). getBindingCommitmentsForPlaces above only keeps the winner, which
// isn't enough once the badge also needs "+N more" and a name — that stays
// as its own smaller/cheaper function since buildCandidatePool (its only
// caller) doesn't need either.
async function getOutstandingCommitmentsForPlaces(db, placeIds = null) {
  const rows = await db('place_commitments as pc')
    .leftJoin('people as pe', 'pe.id', 'pc.person_id')
    .whereNull('pc.discharged_at')
    .modify((qb) => {
      if (placeIds) qb.whereIn('pc.place_id', placeIds);
    })
    .orderBy('pc.place_id', 'asc')
    .orderBy('pc.promised_date', 'asc')
    .orderBy('pc.id', 'asc')
    .select('pc.id', 'pc.place_id', 'pc.promised_date', 'pc.person_id', 'pc.note', 'pe.name as person_name');

  const byPlace = new Map();
  for (const row of rows) {
    if (!byPlace.has(row.place_id)) byPlace.set(row.place_id, []);
    byPlace.get(row.place_id).push(row);
  }
  return byPlace;
}

// Discharges as fulfilled — the ordinary "we went" case, driven by
// VisitLogModal's pre-checked panel rows. Guards on whereNull('discharged_at')
// so a double-submit or a stale client can't re-discharge an already-closed
// row; returns null rather than throwing when that happens or the id doesn't
// exist, since neither is exceptional at this layer (the caller just has
// nothing further to do).
async function fulfillCommitment(db, id, { dischargedByVisitId = null } = {}) {
  const updated = await db('place_commitments')
    .where({ id })
    .whereNull('discharged_at')
    .update({
      discharged_at: db.fn.now(),
      discharge_reason: 'fulfilled',
      discharged_by_visit_id: dischargedByVisitId,
    });
  if (!updated) return null;
  return db('place_commitments').where({ id }).first();
}

// Discharges as waived — "not happening; back to normal cadence." There is
// no separate discharge-note column (see the schema comment in the
// migration), so an optional reason is appended to the existing promise note
// rather than overwriting it — waiving shouldn't erase who the promise was
// to or why it was made, only why it's being dropped.
async function waiveCommitment(db, id, { note } = {}) {
  return db.transaction(async (trx) => {
    const original = await trx('place_commitments').where({ id }).whereNull('discharged_at').first();
    if (!original) return null;

    // ' — ' (not a newline) — this note is rendered inline in a single-line
    // history row (PlaceCommitments.jsx), where a newline just collapses to
    // a run-on sentence instead of a visible break.
    const mergedNote = note
      ? original.note
        ? `${original.note} — Waived: ${note}`
        : `Waived: ${note}`
      : original.note;

    await trx('place_commitments').where({ id }).update({
      note: mergedNote,
      discharged_at: trx.fn.now(),
      discharge_reason: 'waived',
    });
    return trx('place_commitments').where({ id }).first();
  });
}

// Reschedules — discharges the original as superseded and creates a new
// outstanding commitment for the new date, carrying person_id/note forward
// unless the caller overrides them. Transactional: a reader must never see
// the old commitment discharged without the new one existing yet (or vice
// versa), since a place with neither is briefly, wrongly, off the
// COMMITMENT tier.
async function rescheduleCommitment(db, id, { promisedDate, personId, note, createdByUserId = null } = {}) {
  return db.transaction(async (trx) => {
    const original = await trx('place_commitments').where({ id }).whereNull('discharged_at').first();
    if (!original) return null;

    const [inserted] = await trx('place_commitments')
      .insert({
        place_id: original.place_id,
        promised_date: promisedDate,
        person_id: withFallback(personId, original.person_id),
        note: withFallback(note, original.note),
        source_visit_id: null, // a reschedule isn't made during a visit
        created_by_user_id: createdByUserId,
      })
      .returning('id');
    const newId = inserted && inserted.id !== undefined ? inserted.id : inserted;

    await trx('place_commitments').where({ id }).update({
      discharged_at: trx.fn.now(),
      discharge_reason: 'superseded',
      superseded_by_id: newId,
    });

    return trx('place_commitments').where({ id: newId }).first();
  });
}

// Every commitment whose source_visit_id is one of these visit ids — "the
// promise made during this trip" (spec §6.3), replacing the old per-visit
// next_visit_date column as what a visit-history row shows. Same
// batch-then-group-in-JS shape as services/visitEncounters.js's
// encountersByVisitId (this module's own precedent for "attach related data
// to a list of visits in one extra query, not one per row").
//
// Unlike the outstanding-only queries above, this includes DISCHARGED
// commitments too — a visit's history should still show "you promised the
// 20th here," whether that promise is still open, was kept, got
// rescheduled, or was waived; source_visit_id survives all of those.
async function commitmentsBySourceVisitId(db, visitIds) {
  const byVisit = new Map();
  const ids = [...new Set(visitIds.filter((id) => id != null))];
  if (!ids.length) return byVisit;

  const rows = await db('place_commitments as pc')
    .leftJoin('people as pe', 'pe.id', 'pc.person_id')
    .whereIn('pc.source_visit_id', ids)
    .orderBy('pc.id', 'asc')
    .select(
      'pc.source_visit_id',
      'pc.id',
      'pc.promised_date',
      'pc.person_id',
      'pc.note',
      'pc.discharged_at',
      'pc.discharge_reason',
      'pe.name as person_name'
    );

  for (const row of rows) {
    const { source_visit_id: visitId, ...commitment } = row;
    if (!byVisit.has(visitId)) byVisit.set(visitId, []);
    byVisit.get(visitId).push(commitment);
  }
  return byVisit;
}

// Returns `visits` with a `commitments_made` array attached to each — []
// when the trip made no promise, same "empty array, not missing/null"
// convention attachEncounters uses (a trip with nothing to show is a normal
// state, not an error).
async function attachCommitmentsMade(db, visits, { idKey = 'id' } = {}) {
  if (!visits.length) return visits;
  const byVisit = await commitmentsBySourceVisitId(db, visits.map((v) => v[idKey]));
  return visits.map((v) => ({ ...v, commitments_made: byVisit.get(v[idKey]) || [] }));
}

module.exports = {
  createCommitment,
  getOutstandingCommitments,
  getOutstandingCommitmentsForPlaces,
  getBindingCommitment,
  getBindingCommitmentsForPlaces,
  fulfillCommitment,
  waiveCommitment,
  rescheduleCommitment,
  commitmentsBySourceVisitId,
  attachCommitmentsMade,
};
