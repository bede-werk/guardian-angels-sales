// Manual Visit Planning — creating a `visits` row directly, by hand, rather
// than committing a route-planner draft. See
// docs/manual-visit-planning-spec.md (v2, 2026-08-12) for the full design.
// Short version (§1): today the only path to a status:'planned' visit is a
// draft commit; this is the "I'm going to Tabitha on Thursday" path — the
// human decides, the planner arranges itself around the decision (see
// scheduleGenerator.js's hard exclusion and zone/anchor logic for that
// side of it, §7).
//
// This is a POLICY LAYER over services/conflictDetection.js, not a second
// detector (§4) — that module already computes every finding this needs
// (SAME_DATE_VISIT, FLOOR_COMPLETED, FLOOR_PLANNED, DRAFT_ELSEWHERE) at the
// right threshold (HARD_FLOOR_DAYS is already 5, matching this feature's own
// warning window). The only new thing is which findings BLOCK versus WARN —
// and that split is deliberately DIFFERENT from routes/visits.js's existing
// ad-hoc "Log a visit" policy: DRAFT_ELSEWHERE is a soft warning there, but a
// hard block here. Same finding, different policy by surface — see
// classifyConflicts below. That divergence is intentional (spec §4.1), not
// duplicated logic that drifted.
//
// Same pure/impure split as conflictDetection.js/scheduleDraft.js: policy
// decisions are plain, synchronous, directly-testable functions; a thin
// async layer does the real DB reads/writes and calls into them.
const { orgToday } = require('./orgDate');
const { detectConflicts } = require('./conflictDetection');

// -- Pure policy ------------------------------------------------------------

// Past dates are never plannable — retroactive logging (PlaceDetail/
// PersonDetail's "Log a visit") is the unrestricted path for a visit that
// already happened; this feature is exclusively for the future. `today` is
// injected (not read internally) so this stays a plain function, same as
// every other pure helper here.
function pastDateError(scheduledDate, today) {
  if (scheduledDate < today) {
    return "Visits can't be planned for past dates. To record a visit that already happened, log it from the place or person page.";
  }
  return null;
}

// Splits a detectConflicts() Conflict[] into what BLOCKS manual planning
// outright versus what only WARNS. SAME_DATE_VISIT and DRAFT_ELSEWHERE block
// (§4.1) — a second planned/completed visit that day is literally
// impossible to resolve after the fact (a rep can't be in two places), and
// two same-day drafts create the exact conflict SAME_DATE_VISIT already
// treats as unresolvable, so DRAFT_ELSEWHERE gets the same hard treatment
// here even though the OTHER "Log a visit" route (routes/visits.js) only
// warns on it. FLOOR_COMPLETED/FLOOR_PLANNED stay warnings (§4.2) — a
// deliberate override, not a mistake, is exactly what this feature exists
// to allow past the floor.
function classifyConflicts(conflicts) {
  const blocking = conflicts.filter((c) => c.type === 'SAME_DATE_VISIT' || c.type === 'DRAFT_ELSEWHERE');
  const warnings = conflicts.filter((c) => c.type === 'FLOOR_COMPLETED' || c.type === 'FLOOR_PLANNED');
  return { blocking, warnings };
}

// One hard-block conflict -> the 409 message. Only ever called with the
// FIRST blocking conflict (see createManualVisit/editManualVisit below) —
// same "one named conflict" convention detectConflictsPure itself uses per
// type, and there is realistically never more than one of each type for a
// single place+date pair anyway.
function blockingMessage(conflict) {
  if (conflict.type === 'SAME_DATE_VISIT') {
    const who = conflict.otherUserName || 'Someone';
    return `${who} is already visiting this place today.`;
  }
  // DRAFT_ELSEWHERE
  const who = conflict.otherUserName || 'another rep';
  return `This place is already in ${who}'s draft for this day.`;
}

// A FLOOR_COMPLETED/FLOOR_PLANNED conflict -> its warning line. Same wording
// for both per spec §4.2 — the point of the message is "recently active
// here," not a completed/planned distinction the rep would need to parse
// mid-confirm.
function floorWarningMessage(conflict) {
  const n = conflict.daysApart;
  return `This place was visited ${n} day${n === 1 ? '' : 's'} ago. Plan anyway?`;
}

// do_not_visit is not a conflictDetection.js finding (that module only
// covers the floor/collision rules) — same precedence check
// schedulingEngine.js's eligibility() uses: do_not_visit_until null means
// indefinite, a date means it lapses once today passes it.
function doNotVisitWarning(place, today) {
  if (place.do_not_visit && (!place.do_not_visit_until || place.do_not_visit_until >= today)) {
    return { type: 'DO_NOT_VISIT', message: 'This place is marked do-not-visit. Plan anyway?' };
  }
  return null;
}

// Assembles the full warning list for a proposed create/edit — floor
// warnings first (in whatever order detectConflicts returned them), then
// do_not_visit. Order only matters for display; nothing downstream depends
// on it.
function buildWarnings({ floorConflicts, place, today }) {
  const warnings = floorConflicts.map((c) => ({ type: c.type, message: floorWarningMessage(c), daysApart: c.daysApart }));
  const dnv = doNotVisitWarning(place, today);
  if (dnv) warnings.push(dnv);
  return warnings;
}

function blockedError(blocking) {
  const err = new Error(blockingMessage(blocking[0]));
  err.status = 409;
  err.code = 'MANUAL_VISIT_BLOCKED';
  err.conflicts = blocking;
  return err;
}

// -- Permissions (§5) ---------------------------------------------------
// The assignee (visit.user_id) may always edit or delete a manually-planned
// visit. The creator (visit.created_by_user_id) may ALSO delete one they
// planned for someone else, but may not edit it — editing is scoped to
// whoever's day it actually is. A third rep can do neither. Pure, so the
// permission matrix itself is directly testable without a DB.
function canEditManualVisit(visit, actingUserId) {
  return visit.user_id === actingUserId;
}

function canDeleteManualVisit(visit, actingUserId) {
  return visit.user_id === actingUserId || visit.created_by_user_id === actingUserId;
}

// -- DB-touching layer --------------------------------------------------

// Creates a manually-planned visit, or — if it's blocked/warned — reports
// why instead of writing anything. Three outcomes:
//   throws (409, err.conflicts set)  — a hard block (§4.1); nothing written.
//   { visit: null, warnings: [...] } — warning(s) only (§4.2) and `force`
//                                      wasn't set; nothing written yet, the
//                                      caller re-sends with force:true to
//                                      proceed.
//   { visit, warnings: [] }          — created.
async function createManualVisit(db, { placeId, scheduledDate, userId, createdByUserId, notes = null, force = false }) {
  const today = orgToday();

  const dateError = pastDateError(scheduledDate, today);
  if (dateError) {
    const err = new Error(dateError);
    err.status = 400;
    throw err;
  }

  const place = await db('places').where({ id: placeId }).first();
  if (!place) {
    const err = new Error('Place not found');
    err.status = 404;
    throw err;
  }

  // userId (the ASSIGNEE, not the planner) is what detectConflicts needs to
  // correctly exclude the assignee's OWN open draft from the DRAFT_ELSEWHERE
  // search — same `ctx.userId` contract addStop already relies on.
  const conflicts = await detectConflicts(db, placeId, scheduledDate, { userId });
  const { blocking, warnings: floorConflicts } = classifyConflicts(conflicts);
  if (blocking.length > 0) throw blockedError(blocking);

  const warnings = buildWarnings({ floorConflicts, place, today });
  if (warnings.length > 0 && !force) {
    return { visit: null, warnings };
  }

  const payload = {
    place_id: placeId,
    place_name: place.name, // one-time snapshot, same convention as routes/visits.js's POST /
    user_id: userId,
    created_by_user_id: createdByUserId,
    scheduled_date: scheduledDate,
    status: 'planned',
    planned_manually: 1,
    notes: notes || null,
  };
  const [inserted] = await db('visits').insert(payload).returning('id');
  const id = inserted && inserted.id !== undefined ? inserted.id : inserted;
  return { visit: await db('visits').where({ id }).first(), warnings: [] };
}

// Fetches a visit and confirms it's one this module is allowed to touch:
// must exist and must have been planned through THIS feature
// (planned_manually) — editing/deleting a draft-committed or ad-hoc-logged
// visit goes through the normal routes/visits.js paths instead, which have
// their own (different) rules.
async function getManualVisit(db, id) {
  const visit = await db('visits').where({ id }).first();
  if (!visit || !visit.planned_manually) {
    const err = new Error('Manual visit not found');
    err.status = 404;
    throw err;
  }
  return visit;
}

// Reschedules a manually-planned visit — re-runs every §4 check against the
// NEW date (excluding this visit's own row, so it doesn't collide with
// itself) rather than trusting the original checks still hold. Moving off
// the old date releases whatever block it was causing there for free: this
// is an UPDATE to the one row, not a delete-and-recreate, so once it
// succeeds the old date simply has no visit at that place anymore.
//
// Only a still-planned visit can be rescheduled — once it's completed
// (VisitLogModal) or lapsed (skip sweep), "moving" it no longer means
// anything; those are history now, not an open plan.
async function rescheduleManualVisit(db, id, { scheduledDate, force = false }, actingUserId) {
  const visit = await getManualVisit(db, id);
  if (!canEditManualVisit(visit, actingUserId)) {
    const err = new Error('Only the assigned rep can reschedule this visit');
    err.status = 403;
    throw err;
  }
  if (visit.status !== 'planned') {
    const err = new Error('Only a still-planned visit can be rescheduled');
    err.status = 400;
    throw err;
  }

  const today = orgToday();
  const dateError = pastDateError(scheduledDate, today);
  if (dateError) {
    const err = new Error(dateError);
    err.status = 400;
    throw err;
  }

  if (scheduledDate === visit.scheduled_date) {
    return { visit, warnings: [] }; // no real move — nothing to recheck or reset
  }

  const place = await db('places').where({ id: visit.place_id }).first();
  const conflicts = await detectConflicts(db, visit.place_id, scheduledDate, { userId: visit.user_id, excludeVisitId: id });
  const { blocking, warnings: floorConflicts } = classifyConflicts(conflicts);
  if (blocking.length > 0) throw blockedError(blocking);

  const warnings = buildWarnings({ floorConflicts, place, today });
  if (warnings.length > 0 && !force) {
    return { visit: null, warnings };
  }

  await db('visits').where({ id }).update({
    scheduled_date: scheduledDate,
    updated_at: db.fn.now(),
  });
  return { visit: await db('visits').where({ id }).first(), warnings: [] };
}

module.exports = {
  pastDateError,
  classifyConflicts,
  blockingMessage,
  floorWarningMessage,
  doNotVisitWarning,
  buildWarnings,
  canEditManualVisit,
  canDeleteManualVisit,
  createManualVisit,
  getManualVisit,
  rescheduleManualVisit,
};
