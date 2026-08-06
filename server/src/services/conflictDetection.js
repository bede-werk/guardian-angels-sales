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
// comparison (`daysSince(lastVisitDate, today) < config.HARD_FLOOR_DAYS`),
// with one generalization: Math.abs on the gap. A completed visit is always
// dated on or before `today` in practice, so this was a no-op for
// FLOOR_COMPLETED. It stops being a no-op for FLOOR_PLANNED (Step 3) — a
// planned visit is routinely dated AFTER `today` (a place planned for day 1
// of a window, evaluated again as a candidate for day 5), and an unsigned
// gap there would read as an enormous negative number, which is always
// `< HARD_FLOOR_DAYS` and would wrongly flag every future planned visit,
// no matter how far out, as a floor conflict. Same fix already proven
// correct next door in crossRepFloorWarning.js's findCrossRepFloorWarning,
// which has compared gaps with Math.abs since it was written.
// Returns null (no conflict) or { daysApart }.
function isFloorConflict({ lastVisitDate, today, config }) {
  if (!lastVisitDate) return null;
  const daysApart = Math.abs(daysSince(lastVisitDate, today));
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

  // Commitment exemption suppresses FLOOR_COMPLETED and FLOOR_PLANNED —
  // never SAME_DATE_VISIT, which is a same-day fact, not a recency guess a
  // commitment could override.
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

    // input.plannedVisits: every OTHER planned visit at this place (the one
    // exactly on `today`, if any, is already SAME_DATE_VISIT's job — callers
    // exclude it so the two conflicts don't both fire for the same row).
    // More than one can exist in theory (nothing before this ticket stopped
    // two reps from independently planning the same place on different
    // dates), so this reports the SINGLE nearest violator, same "one named
    // conflict per type" shape as FLOOR_COMPLETED's single lastVisitDate.
    let nearestPlanned = null;
    for (const v of input.plannedVisits || []) {
      const planned = isFloorConflict({ lastVisitDate: v.scheduledDate, today, config });
      if (planned && (!nearestPlanned || planned.daysApart < nearestPlanned.daysApart)) {
        nearestPlanned = { ...v, daysApart: planned.daysApart };
      }
    }
    if (nearestPlanned) {
      conflicts.push({
        type: 'FLOOR_PLANNED',
        severity: 'hard',
        placeId,
        otherUserId: nearestPlanned.userId ?? null,
        otherUserName: nearestPlanned.userName ?? null,
        otherDate: nearestPlanned.scheduledDate,
        daysApart: nearestPlanned.daysApart,
        sourceId: nearestPlanned.visitId ?? null,
        sourceKind: 'visit',
      });
    }
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

  // FLOOR_PLANNED's candidates (Step 3): every OTHER planned visit at this
  // place — excludes exactly `targetDate` since a planned visit dated there
  // is already sameDateVisitRow's job (see detectConflictsPure's comment).
  // Every row within HARD_FLOOR_DAYS gets reduced to the single nearest by
  // the pure layer, not here.
  const plannedRows = await db('visits as v')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .where({ 'v.place_id': placeId, 'v.status': 'planned' })
    .whereNot('v.scheduled_date', targetDate)
    .modify((qb) => { if (excludeVisitId) qb.whereNot('v.id', excludeVisitId); })
    .select('v.id as visitId', 'v.user_id as userId', 'u.name as userName', 'v.scheduled_date as scheduledDate');

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
    plannedVisits: plannedRows,
    draftElsewhere: draftElsewhereRow
      ? { stopId: draftElsewhereRow.stopId, userId: draftElsewhereRow.userId, userName: draftElsewhereRow.userName, date: draftElsewhereRow.date }
      : null,
    ownDraftDuplicate,
  });
}

// Batched sibling of detectConflicts: the same rules, for MANY place+date
// pairs in one pass, instead of one detectConflicts call (5 queries) per
// pair. Built for loadDraftView/loadDraftDayView (scheduleDraft.js) — a
// draft's own already-placed stops need re-checking against the detector on
// every read (another rep can commit a colliding visit at any time after a
// stop was added), and calling detectConflicts once per stop would turn
// "load a draft" into an O(stops) burst of queries, the exact N+1 pattern
// this codebase's other batched lookups (buildCandidatePool,
// crossRepVisitsByPlace, lockedElsewherePlaceIdsByDate) all exist to avoid.
//
// `stops`: [{ placeId, date }] — a draft's own stops (or a single day's).
// Returns Map<`${placeId}|${date}`, Conflict[]>.
//
// Does not check OWN_DRAFT_DUPLICATE: every stop passed in is already
// legitimately placed (own-draft dedupe already ran at addStop time), so
// there is nothing to detect there on a read — unlike detectConflicts,
// which runs BEFORE a placement to decide whether to allow it.
async function detectConflictsForStops(db, stops, ctx = {}) {
  const { userId, excludeDraftId = null } = ctx;
  const config = ctx.config || defaultSchedulingConfig;

  const result = new Map();
  const placeIds = [...new Set(stops.map((s) => s.placeId))];
  if (placeIds.length === 0) return result;

  // Every status: sameDateVisit/lastVisitDate/plannedVisits each need their
  // own status filter (see detectConflicts above), and next_visit_date can
  // come off a skipped visit — so this fetches everything for these places
  // and lets the per-stop loop below filter, exactly like detectConflicts'
  // five separate single-place queries, just gathered as one multi-place
  // query instead of five.
  const visitRows = await db('visits as v')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .whereIn('v.place_id', placeIds)
    .select('v.id as visitId', 'v.place_id as placeId', 'v.user_id as userId', 'u.name as userName', 'v.scheduled_date as scheduledDate', 'v.status', 'v.next_visit_date as nextVisitDate');
  const visitsByPlace = new Map();
  for (const row of visitRows) {
    if (!visitsByPlace.has(row.placeId)) visitsByPlace.set(row.placeId, []);
    visitsByPlace.get(row.placeId).push(row);
  }

  const draftRows = await db('schedule_draft_stops as s')
    .join('schedule_drafts as d', 'd.id', 's.draft_id')
    .leftJoin('users as u', 'u.id', 'd.user_id')
    .whereIn('s.place_id', placeIds)
    .modify((qb) => {
      if (userId != null) qb.whereNot('d.user_id', userId);
      if (excludeDraftId) qb.whereNot('d.id', excludeDraftId);
    })
    .select('s.place_id as placeId', 's.date', 's.id as stopId', 'd.user_id as userId', 'u.name as userName');
  const draftsByPlace = new Map();
  for (const row of draftRows) {
    if (!draftsByPlace.has(row.placeId)) draftsByPlace.set(row.placeId, []);
    draftsByPlace.get(row.placeId).push(row);
  }

  for (const { placeId, date } of stops) {
    const visits = visitsByPlace.get(placeId) || [];
    const sameDateVisit = visits.find((v) => v.scheduledDate === date && (v.status === 'planned' || v.status === 'completed')) || null;
    const completed = visits.filter((v) => v.status === 'completed');
    const lastCompleted = completed.length
      ? completed.reduce((a, b) => (a.scheduledDate > b.scheduledDate ? a : b))
      : null;
    const planned = visits.filter((v) => v.status === 'planned' && v.scheduledDate !== date);
    const withCommitment = visits
      .filter((v) => v.nextVisitDate)
      .reduce((a, b) => (!a || b.scheduledDate > a.scheduledDate ? b : a), null);
    const draftElsewhere = (draftsByPlace.get(placeId) || []).find((d) => d.date === date) || null;

    const conflicts = detectConflictsPure({
      placeId,
      today: date,
      config,
      sameDateVisit: sameDateVisit
        ? { visitId: sameDateVisit.visitId, userId: sameDateVisit.userId, userName: sameDateVisit.userName, status: sameDateVisit.status, scheduledDate: date }
        : null,
      lastVisitDate: lastCompleted ? lastCompleted.scheduledDate : null,
      lastVisitId: lastCompleted ? lastCompleted.visitId : null,
      lastVisitUserId: lastCompleted ? lastCompleted.userId : null,
      lastVisitUserName: lastCompleted ? lastCompleted.userName : null,
      nextVisitDate: withCommitment ? withCommitment.nextVisitDate : null,
      plannedVisits: planned.map((v) => ({ visitId: v.visitId, userId: v.userId, userName: v.userName, scheduledDate: v.scheduledDate })),
      draftElsewhere: draftElsewhere
        ? { stopId: draftElsewhere.stopId, userId: draftElsewhere.userId, userName: draftElsewhere.userName, date: draftElsewhere.date }
        : null,
    });
    result.set(`${placeId}|${date}`, conflicts);
  }
  return result;
}

module.exports = {
  daysSince,
  isCommitmentDue,
  isFloorConflict,
  detectConflictsPure,
  detectConflicts,
  detectConflictsForStops,
};
