// Single source of "does placing a visit at this place, on this date,
// collide with something" — the floor/collision rules that used to live
// only inside schedulingEngine.js's eligibility() (the generation path) and
// were separately, narrowly reinvented (or simply missing) everywhere else
// a visit/stop gets created: scheduleDraft.js's addStop (own-draft dedupe +
// same-date lock only, no floor at all) and routes/visits.js's manual
// "Log a visit" (exact-date collision only, no floor at all — see that
// route's own comment admitting it). One rule set, several callers.
//
// Follows this stack's existing pure/impure split (schedulingEngine.js
// itself; scheduleDraft.js's mergeLockedElsewhereIds/partitionCommittableStops;
// crossRepFloorWarning.js's crossRepVisitsByPlace/findCrossRepFloorWarning):
// the RULES live in plain, synchronous, directly-testable functions; a
// separate async layer does the real DB reads and calls into them.
//
// daysSince lives HERE (not schedulingEngine.js, where it used to be
// defined) so this module has no dependency on schedulingEngine.js at all —
// schedulingEngine.js depends on THIS module instead, and re-exports
// daysSince unchanged so its other existing consumers (crossRepFloorWarning.js,
// relationship.js) don't need to change their require() at all. The reverse
// direction (this module requiring schedulingEngine.js for daysSince, which
// in turn requires this module for isFloorConflict/isCommitmentDue) would be
// a circular require — harmless-looking until whichever module loads second
// destructures a function off the other's still-empty module.exports and
// gets undefined. Not worth the risk for one function.
const defaultSchedulingConfig = require('../config/scheduling');

// -- Pure date math / rules -----------------------------------------------

// Integer day count between two 'YYYY-MM-DD' strings (today - dateStr).
// Parsed as UTC calendar dates (not Date.parse) so this is immune to the
// host machine's local timezone. Moved verbatim from schedulingEngine.js —
// byte-identical, not re-derived.
function daysSince(dateStr, today) {
  const [y1, m1, d1] = dateStr.split('-').map(Number);
  const [y2, m2, d2] = today.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

// A due next_visit_date (a human explicitly asking us back) bypasses the
// hard floor — see isFloorConflict. Ported verbatim from schedulingEngine.js's
// eligibility(), which used to inline this same `Boolean(...)` check.
function isCommitmentDue({ nextVisitDate, today }) {
  return Boolean(nextVisitDate && nextVisitDate <= today);
}

// Ported verbatim from schedulingEngine.js's eligibility() hard-floor
// comparison (`daysSince(lastVisitDate, today) < config.HARD_FLOOR_DAYS`).
// Returns null (no conflict) or { daysApart }.
function isFloorConflict({ lastVisitDate, today, config }) {
  if (!lastVisitDate) return null;
  const daysApart = daysSince(lastVisitDate, today);
  if (daysApart >= config.HARD_FLOOR_DAYS) return null;
  return { daysApart };
}

// Assembles the full Conflict[] list for one place+date from already-
// fetched, pre-shaped inputs — no knex, no async, directly unit-testable.
// Every field on `input` besides placeId/today/config is optional: a caller
// only supplies what it fetched / is relevant to its call site. Generation's
// pool-wide pass (via schedulingEngine.js's eligibility()) never has a
// sameDateVisit/draftElsewhere/ownDraftDuplicate to give, since ranking a
// ~280-place pool doesn't work against one single target place+date the way
// addStop/manual-log do — those still only ever call the two rule
// functions above directly (isCommitmentDue/isFloorConflict), not this.
//
// today: the date conflicts are being evaluated FOR, not necessarily the
// real calendar date. Matches every existing caller's convention (see e.g.
// scheduleDraft.js's rankedCandidatesForDay/getSuggestions, which both pass
// `today: date` — the day being planned — into buildCandidatePool/
// rankCandidates, not org-today) — the floor is measured relative to the
// visit date under consideration, not to whenever the query happens to run.
//
// Conflict shape:
//   { type, severity: 'hard'|'soft', placeId, otherUserId, otherUserName,
//     otherDate, daysApart, sourceId, sourceKind: 'visit'|'draft_stop' }
function detectConflictsPure(input) {
  const { placeId, today, config } = input;
  const conflicts = [];

  if (input.sameDateVisit) {
    const v = input.sameDateVisit;
    conflicts.push({
      type: 'SAME_DATE_VISIT',
      severity: 'hard',
      placeId,
      otherUserId: v.userId ?? null,
      otherUserName: v.userName ?? null,
      otherDate: v.scheduledDate,
      daysApart: 0,
      sourceId: v.visitId ?? null,
      sourceKind: 'visit',
      status: v.status,
    });
  }

  // Commitment exemption suppresses FLOOR_COMPLETED (and, from Step 3,
  // FLOOR_PLANNED) — never SAME_DATE_VISIT, which is a same-day fact, not a
  // recency guess a commitment could override.
  const commitmentDue = isCommitmentDue({ nextVisitDate: input.nextVisitDate, today });
  if (!commitmentDue) {
    const floor = isFloorConflict({ lastVisitDate: input.lastVisitDate, today, config });
    if (floor) {
      conflicts.push({
        type: 'FLOOR_COMPLETED',
        severity: 'hard',
        placeId,
        otherUserId: input.lastVisitUserId ?? null,
        otherUserName: input.lastVisitUserName ?? null,
        otherDate: input.lastVisitDate,
        daysApart: floor.daysApart,
        sourceId: input.lastVisitId ?? null,
        sourceKind: 'visit',
      });
    }

    // FLOOR_PLANNED is intentionally not implemented yet — planned visits
    // don't consume the floor until Step 3 of the remediation ticket. This
    // function always returns [] worth of FLOOR_PLANNED conflicts for now.
  }

  if (input.draftElsewhere) {
    const d = input.draftElsewhere;
    conflicts.push({
      type: 'DRAFT_ELSEWHERE',
      severity: 'hard',
      placeId,
      otherUserId: d.userId ?? null,
      otherUserName: d.userName ?? null,
      otherDate: d.date,
      daysApart: null,
      sourceId: d.stopId ?? null,
      sourceKind: 'draft_stop',
    });
  }

  if (input.ownDraftDuplicate) {
    conflicts.push({
      type: 'OWN_DRAFT_DUPLICATE',
      severity: 'hard',
      placeId,
      otherUserId: null,
      otherUserName: null,
      otherDate: input.ownDraftDuplicate.date ?? null,
      daysApart: null,
      sourceId: input.ownDraftDuplicate.stopId ?? null,
      sourceKind: 'draft_stop',
    });
  }

  return conflicts;
}

// -- DB-touching layer ------------------------------------------------------

// One place, one target date. Fetches everything detectConflictsPure needs
// and resolves user names via join — callers get names, never bare ids (see
// the remediation ticket: an unresolved id is how the generic "already
// booked elsewhere" 409 message happened in addStop).
//
// No production caller yet as of this extraction (Step 1): addStop and the
// manual visit-log route are wired to call this in Step 2. Built now,
// against real tables, because Step 1's job is landing one correct detector
// for those steps to call — not because anything invokes it today.
//
// db: knex or an open transaction — same convention every other DB-touching
// function in scheduleDraft.js uses for this parameter.
// ctx.userId: the requesting user (excluded from DRAFT_ELSEWHERE's "other
//   user" search — a place in your OWN open draft elsewhere is
//   ownDraftDuplicate's job, not this).
// ctx.excludeVisitId: ignore this visit row (editing one in place).
// ctx.excludeDraftId: the caller's own draft id, if any — both excludes it
//   from the DRAFT_ELSEWHERE search and is what OWN_DRAFT_DUPLICATE checks
//   against.
// ctx.workingSet: place_ids already placed in an in-progress, not-yet-
//   persisted proposal (a caller building several stops in one request
//   before any of them are written). No current caller needs this — every
//   existing/Step-2 caller persists one stop per call, already covered by
//   ownDraftDuplicate via a DB read — accepted now so a future bulk caller
//   doesn't need a signature change.
async function detectConflicts(db, placeId, targetDate, ctx = {}) {
  const { userId, excludeVisitId = null, excludeDraftId = null, workingSet = [] } = ctx;
  const config = ctx.config || defaultSchedulingConfig;
  const today = targetDate;

  const sameDateVisitRow = await db('visits as v')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .where({ 'v.place_id': placeId, 'v.scheduled_date': targetDate })
    .whereIn('v.status', ['planned', 'completed'])
    .modify((qb) => { if (excludeVisitId) qb.whereNot('v.id', excludeVisitId); })
    .select('v.id as visitId', 'v.user_id as userId', 'u.name as userName', 'v.status')
    .first();

  const lastCompletedRow = await db('visits as v')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .where({ 'v.place_id': placeId, 'v.status': 'completed' })
    .modify((qb) => { if (excludeVisitId) qb.whereNot('v.id', excludeVisitId); })
    .orderBy('v.scheduled_date', 'desc')
    .select('v.id as visitId', 'v.user_id as userId', 'u.name as userName', 'v.scheduled_date as scheduledDate')
    .first();

  // Any status (not just completed/planned) that set one, same as
  // buildCandidatePool's nextDateVisits — a commitment can come off a
  // skipped trip ("couldn't get in, but come back Thursday").
  const nextVisitRow = await db('visits')
    .where({ place_id: placeId })
    .whereNotNull('next_visit_date')
    .orderBy('scheduled_date', 'desc')
    .select('next_visit_date as nextVisitDate')
    .first();

  const draftElsewhereRow = await db('schedule_draft_stops as s')
    .join('schedule_drafts as d', 'd.id', 's.draft_id')
    .leftJoin('users as u', 'u.id', 'd.user_id')
    .where({ 's.place_id': placeId, 's.date': targetDate })
    .modify((qb) => {
      if (userId != null) qb.whereNot('d.user_id', userId);
      if (excludeDraftId) qb.whereNot('d.id', excludeDraftId);
    })
    .select('s.id as stopId', 'd.user_id as userId', 'u.name as userName', 's.date')
    .first();

  let ownDraftDuplicate = null;
  if (excludeDraftId) {
    const ownRow = await db('schedule_draft_stops')
      .where({ draft_id: excludeDraftId, place_id: placeId })
      .select('id as stopId', 'date')
      .first();
    if (ownRow) ownDraftDuplicate = { stopId: ownRow.stopId, date: ownRow.date };
  }
  if (!ownDraftDuplicate && workingSet.includes(placeId)) {
    ownDraftDuplicate = { stopId: null, date: null };
  }

  return detectConflictsPure({
    placeId,
    today,
    config,
    sameDateVisit: sameDateVisitRow
      ? { visitId: sameDateVisitRow.visitId, userId: sameDateVisitRow.userId, userName: sameDateVisitRow.userName, status: sameDateVisitRow.status, scheduledDate: targetDate }
      : null,
    lastVisitDate: lastCompletedRow ? lastCompletedRow.scheduledDate : null,
    lastVisitId: lastCompletedRow ? lastCompletedRow.visitId : null,
    lastVisitUserId: lastCompletedRow ? lastCompletedRow.userId : null,
    lastVisitUserName: lastCompletedRow ? lastCompletedRow.userName : null,
    nextVisitDate: nextVisitRow ? nextVisitRow.nextVisitDate : null,
    draftElsewhere: draftElsewhereRow
      ? { stopId: draftElsewhereRow.stopId, userId: draftElsewhereRow.userId, userName: draftElsewhereRow.userName, date: draftElsewhereRow.date }
      : null,
    ownDraftDuplicate,
  });
}

module.exports = {
  daysSince,
  isCommitmentDue,
  isFloorConflict,
  detectConflictsPure,
  detectConflicts,
};
