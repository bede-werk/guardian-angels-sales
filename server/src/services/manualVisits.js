// Manual Visit Planning - creating a `visits` row directly, by hand, rather
// than committing a route-planner draft. See HANDOFF.md §20/§20A/§20B for
// the full design and history (§ numbers below refer to §20 there - there
// is no separate docs/manual-visit-planning-spec.md file; that was this
// feature's original working-doc name and was never actually checked in,
// so HANDOFF.md is the real, current spec). Short version (§1): today the
// only path to a status:'planned' visit is a draft commit; this is the
// "I'm going to Tabitha on Thursday" path - the human decides, the planner
// arranges itself around the decision (see scheduleGenerator.js's hard
// exclusion logic for that side of it - the zone/anchor mechanism §7
// originally described was removed the same day it shipped, see §20A).
//
// This is a POLICY LAYER over services/conflictDetection.js, not a second
// detector (§4) - that module already computes every finding this needs
// (SAME_DATE_VISIT, FLOOR_COMPLETED, FLOOR_PLANNED, DRAFT_ELSEWHERE) at the
// right threshold (HARD_FLOOR_DAYS is already 5, matching this feature's own
// warning window). The only new thing is which findings BLOCK versus WARN -
// and that split is deliberately DIFFERENT from routes/visits.js's existing
// ad-hoc "Log a visit" policy: DRAFT_ELSEWHERE is a soft warning there, but a
// hard block here. Same finding, different policy by surface - see
// classifyConflicts below. That divergence is intentional (spec §4.1), not
// duplicated logic that drifted.
//
// Same pure/impure split as conflictDetection.js/scheduleDraft.js: policy
// decisions are plain, synchronous, directly-testable functions; a thin
// async layer does the real DB reads/writes and calls into them.
const { orgToday } = require('./orgDate');
const { detectConflicts } = require('./conflictDetection');

// -- Pure policy ------------------------------------------------------------

// Past dates are never plannable - retroactive logging (PlaceDetail/
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
// (§4.1) - a second planned/completed visit that day is literally
// impossible to resolve after the fact (a rep can't be in two places), and
// two same-day drafts create the exact conflict SAME_DATE_VISIT already
// treats as unresolvable, so DRAFT_ELSEWHERE gets the same hard treatment
// here even though the OTHER "Log a visit" route (routes/visits.js) only
// warns on it. FLOOR_COMPLETED/FLOOR_PLANNED stay warnings (§4.2) - a
// deliberate override, not a mistake, is exactly what this feature exists
// to allow past the floor.
function classifyConflicts(conflicts) {
  const blocking = conflicts.filter((c) => c.type === 'SAME_DATE_VISIT' || c.type === 'DRAFT_ELSEWHERE');
  const warnings = conflicts.filter((c) => c.type === 'FLOOR_COMPLETED' || c.type === 'FLOOR_PLANNED');
  return { blocking, warnings };
}

// One hard-block conflict -> the 409 message. Only ever called with the
// FIRST blocking conflict (see createManualVisit/editManualVisit below) -
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
// for both per spec §4.2 - the point of the message is "recently active
// here," not a completed/planned distinction the rep would need to parse
// mid-confirm. daysApart is measured against the date being PLANNED, not
// real-world today (see conflictDetection.js's detectConflicts: `today` is
// always the target date under evaluation) - "ago" implies "before now,"
// which reads wrong for a warning about a FUTURE date. "prior" carries no
// such claim.
function floorWarningMessage(conflict) {
  const n = conflict.daysApart;
  return `This place was visited ${n} day${n === 1 ? '' : 's'} prior. Plan anyway?`;
}

// do_not_visit is not a conflictDetection.js finding (that module only
// covers the floor/collision rules) - same precedence check
// schedulingEngine.js's eligibility() uses: do_not_visit_until null means
// indefinite, a date means it lapses once today passes it.
function doNotVisitWarning(place, today) {
  if (place.do_not_visit && (!place.do_not_visit_until || place.do_not_visit_until >= today)) {
    return { type: 'DO_NOT_VISIT', message: 'This place is marked do-not-visit. Plan anyway?' };
  }
  return null;
}

// Assembles the full warning list for a proposed create/edit - floor
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

// Recognizes a unique-constraint violation across both engines this app
// runs on (SQLite dev, Postgres prod) - twin of scheduleDraft.js's own
// isUniqueViolation (duplicated rather than shared: this module is
// deliberately a thin policy layer with no scheduleDraft.js dependency).
function isUniqueViolation(err) {
  return err.code === '23505' // Postgres
    || (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT'))
    || /unique constraint/i.test(err.message || '');
}

// The DB-level backstop (visits_place_date_planned_unique, migration
// 20260822010000) is only ever reached here - never by a normal user -
// because a second request won an identical race in the gap between this
// function's own conflict check above and its write, which that check
// can't see coming. Same 409 shape as blockedError so the client renders it
// identically, just without a specific `conflicts` entry to name (there's
// no fresh Conflict[] to report - only the fact that someone else's write
// got there first).
function racedError() {
  const err = new Error('This place was just booked for this date by someone else. Please refresh and try again.');
  err.status = 409;
  err.code = 'MANUAL_VISIT_BLOCKED';
  return err;
}

// -- Permissions (§5) ---------------------------------------------------
// The assignee (visit.user_id) may always edit or delete a manually-planned
// visit. The creator (visit.created_by_user_id) may ALSO delete one they
// planned for someone else, but may not edit it - editing is scoped to
// whoever's day it actually is. A third rep can do neither. Pure, so the
// permission matrix itself is directly testable without a DB.
function canEditManualVisit(visit, actingUserId) {
  return visit.user_id === actingUserId;
}

function canDeleteManualVisit(visit, actingUserId) {
  return visit.user_id === actingUserId || visit.created_by_user_id === actingUserId;
}

// -- DB-touching layer --------------------------------------------------

// Creates a manually-planned visit, or - if it's blocked/warned - reports
// why instead of writing anything. Three outcomes:
//   throws (409, err.conflicts set)  - a hard block (§4.1); nothing written.
//   { visit: null, warnings: [...] } - warning(s) only (§4.2) and `force`
//                                      wasn't set; nothing written yet, the
//                                      caller re-sends with force:true to
//                                      proceed.
//   { visit, warnings: [] }          - created.
async function createManualVisit(db, { placeId, scheduledDate, userId, createdByUserId, notes = null, visitType = null, force = false }) {
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
  // search - same `ctx.userId` contract addStop already relies on.
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
    visit_type: visitType || null,
  };
  let inserted;
  try {
    [inserted] = await db('visits').insert(payload).returning('id');
  } catch (err) {
    if (isUniqueViolation(err)) throw racedError();
    throw err;
  }
  const id = inserted && inserted.id !== undefined ? inserted.id : inserted;
  return { visit: await db('visits').where({ id }).first(), warnings: [] };
}

// Fetches a visit and confirms it's still an open plan: must exist and
// still be status: 'planned' - once it's completed (VisitLogModal) or
// lapsed (skip sweep), "editing" it no longer means anything; those are
// history now, not an open plan. Unlike the original cut of this module,
// NOT gated on planned_manually already being set - editVisit below is
// exactly how a planner-committed visit BECOMES a manually-planned one, so
// requiring that up front would make it uncallable for the one case it
// exists to handle.
async function getEditableVisit(db, id) {
  const visit = await db('visits').where({ id }).first();
  if (!visit) {
    const err = new Error('Visit not found');
    err.status = 404;
    throw err;
  }
  if (visit.status !== 'planned') {
    const err = new Error('Only a still-planned visit can be edited');
    err.status = 400;
    throw err;
  }
  return visit;
}

// Edits a still-planned visit's date, visit type, and/or notes - UpcomingVisitDetailModal's
// "Edit" button, for a manually-planned visit and a planner-committed one
// alike. Only the visit's ASSIGNEE may call this (canEditManualVisit's rule
// was never actually specific to already-manual visits, it just had no
// other caller before this).
//
// A changed date re-runs every §4 conflict check against the NEW one
// (excluding this visit's own row, so it doesn't collide with itself)
// rather than trusting the original checks still hold - moving Tuesday to
// Thursday is a fresh collision check against Thursday, and can come back
// with warnings pending confirmation (force:true resends to proceed), same
// shape as createManualVisit. Moving off the old date releases whatever
// block it was causing there for free: this is an UPDATE to the one row,
// not a delete-and-recreate. An unchanged (or omitted) date skips the
// recheck entirely - nothing about the visit's date/place changed, so
// there's nothing new to verify; a notes-only edit is exactly this case.
//
// PROMOTION: any successful save through here sets planned_manually: 1 and
// source: 'manual' - even on a visit that started life planner-committed
// (source: 'planner', planned_manually: 0). That's the point of exposing
// this on a planner-committed visit at all: from the moment a rep
// hand-edits it, it IS a manually-planned visit in every sense that
// matters downstream - the same edit/delete permission rules (§5) and the
// same conflict-recheck on any later edit through this same function.
// Note this does NOT protect it from scheduleDraft.js's deleteCommittedDay
// ("Discard plan" on PlannedDayModal) - that action deliberately clears
// the WHOLE day regardless of source/planned_manually (Bede's call, see
// that function's own comment); promotion only changes the PER-VISIT edit/
// delete rules, not the whole-day discard behavior. created_by_user_id
// backfills to the acting rep only if it was never set (a planner commit
// never sets it); an already-manual visit's real creator is never
// overwritten by a later edit.
async function editVisit(db, id, { scheduledDate, notes, visitType, force = false } = {}, actingUserId) {
  const visit = await getEditableVisit(db, id);
  if (!canEditManualVisit(visit, actingUserId)) {
    const err = new Error('Only the assigned rep can edit this visit');
    err.status = 403;
    throw err;
  }

  const update = {
    planned_manually: 1,
    source: 'manual',
    created_by_user_id: visit.created_by_user_id ?? actingUserId,
    updated_at: db.fn.now(),
  };
  if (notes !== undefined) update.notes = notes || null;
  if (visitType !== undefined) update.visit_type = visitType || null;

  const dateChanged = scheduledDate !== undefined && scheduledDate !== visit.scheduled_date;
  if (dateChanged) {
    const today = orgToday();
    const dateError = pastDateError(scheduledDate, today);
    if (dateError) {
      const err = new Error(dateError);
      err.status = 400;
      throw err;
    }

    const place = await db('places').where({ id: visit.place_id }).first();
    // A planned visit's place_id goes NULL the moment its place is deleted
    // (detach-not-delete - see the detach_instead_of_cascade migration), but
    // the visit itself stays visible/editable on the Calendar until its date
    // passes. Without this, buildWarnings/doNotVisitWarning below dereferences
    // an undefined place and 500s.
    if (!place) {
      const err = new Error('This visit\'s place has been deleted');
      err.status = 404;
      throw err;
    }
    const conflicts = await detectConflicts(db, visit.place_id, scheduledDate, { userId: visit.user_id, excludeVisitId: id });
    const { blocking, warnings: floorConflicts } = classifyConflicts(conflicts);
    if (blocking.length > 0) throw blockedError(blocking);

    const warnings = buildWarnings({ floorConflicts, place, today });
    if (warnings.length > 0 && !force) {
      return { visit: null, warnings };
    }
    update.scheduled_date = scheduledDate;
  }

  try {
    await db('visits').where({ id }).update(update);
  } catch (err) {
    if (isUniqueViolation(err)) throw racedError();
    throw err;
  }
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
  getEditableVisit,
  editVisit,
};
