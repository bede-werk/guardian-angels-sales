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
// see classifyConflicts below.
//
// DRAFT_ELSEWHERE used to be a hard block here, deliberately diverging from
// routes/visits.js's "Log a visit" policy, which only ever warned on it
// (spec §4.1). That divergence was retired 2026-08-25: it contradicted the
// rule scheduleDraft.js's committedElsewherePlaceIds states outright - "an
// uncommitted draft is a proposal, not a claim; first to actually commit is
// the only real lock" - which is why commitDay has never let another rep's
// draft stop a commit. Blocking the DELIBERATE hand-plan path on a proposal
// that commit itself ignores was the strictest reading of the weakest
// signal, and it could lock a rep out of a real decision until the other
// rep's draft aged out at the next day rollover. It warns now, like
// everywhere else. Losing the race is already handled: the winner's row
// makes the loser's stop a SAME_DATE_VISIT, which drops it from their day
// and says so by name (scheduleDraft.js's partitionSameDateDrops), and
// visits_place_date_planned_unique + racedError below backstop a true
// simultaneous double-book.
//
// Same pure/impure split as conflictDetection.js/scheduleDraft.js: policy
// decisions are plain, synchronous, directly-testable functions; a thin
// async layer does the real DB reads/writes and calls into them.
const { orgToday } = require('./orgDate');
const { detectConflicts } = require('./conflictDetection');
const { isDoNotVisitActive } = require('./doNotVisit');

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
// outright versus what only WARNS. SAME_DATE_VISIT is the only hard block
// (§4.1): a second planned/completed visit on the same day is a real,
// already-recorded fact and is literally impossible to resolve after the
// fact - a rep can't be in two places. Everything else warns (§4.2) - a
// deliberate override, not a mistake, is exactly what this feature exists to
// allow. FLOOR_COMPLETED/FLOOR_PLANNED are recency heuristics. DRAFT_ELSEWHERE
// is another rep's uncommitted PROPOSAL, which nothing downstream honours as
// a claim (see this file's header, and scheduleDraft.js's
// committedElsewherePlaceIds) - it is worth saying out loud, not worth
// refusing on.
//
// scheduleDraft.js's addStop keeps its own copy of this same one-type filter
// rather than importing this (that module has no manualVisits.js dependency,
// and these were two deliberately DIFFERENT policies until they converged) -
// if the set of blocking types ever changes again, change it in both, and
// see addStop's own header for the other half of the reasoning.
function classifyConflicts(conflicts) {
  const blocking = conflicts.filter((c) => c.type === 'SAME_DATE_VISIT');
  const warnings = conflicts.filter(
    (c) => c.type === 'FLOOR_COMPLETED' || c.type === 'FLOOR_PLANNED' || c.type === 'DRAFT_ELSEWHERE'
  );
  return { blocking, warnings };
}

// One hard-block conflict -> the 409 message. Only ever called with the
// FIRST blocking conflict (see createManualVisit/editManualVisit below) -
// same "one named conflict" convention detectConflictsPure itself uses per
// type, and there is realistically never more than one of each type for a
// single place+date pair anyway. SAME_DATE_VISIT is the only type
// classifyConflicts puts in `blocking`, so there is nothing to branch on:
// the DRAFT_ELSEWHERE arm this used to carry moved to warningMessage below
// when that type stopped blocking (see this file's header), rather than
// being kept here as an unreachable second copy of the same sentence.
//
// "on this date" (not "today") and "a {status} visit" (not "is visiting") -
// the manual-plan's target date is essentially always a FUTURE date
// (pastDateError blocks anything earlier; this feature exists specifically
// for dates ahead), so both the word "today" and a present-continuous "is
// visiting" claim were wrong the moment this ran for any date but literally
// today. The {status} noun phrase ("planned"/"completed" visit) sidesteps
// needing separate past/future verb tenses entirely - same trick
// routes/visits.js's own SAME_DATE_VISIT 409 message (POST /api/visits)
// already uses.
//
// `viewerId` is the rep this sentence is being SHOWN to (the acting user -
// createManualVisit's createdByUserId, editVisit's actingUserId), not the
// visit's assignee: planning for someone else and hitting THEIR existing
// visit should name them, not say "you". Without this branch the collision
// read "Bede Fulton already has a planned visit here" to Bede himself -
// same "You" vs a name handling routes/visits.js's POST /api/visits and
// RoutePlanner.jsx's stopConflictMessage/droppedStopMessage all already do,
// and the last of the four surfaces to get it.
function blockingMessage(conflict, viewerId) {
  const isViewer = viewerId != null && conflict.otherUserId === viewerId;
  const who = isViewer ? 'You' : conflict.otherUserName || 'Someone';
  const verb = isViewer ? 'have' : 'has';
  return `${who} already ${verb} a ${conflict.status} visit here on this date.`;
}

// A warning-tier conflict -> its line. Named for the tier rather than the
// types in it (it was floorWarningMessage) since DRAFT_ELSEWHERE joined
// them, and it is not a floor rule at all.
//
// daysApart is measured against the date being PLANNED, not real-world today
// (see conflictDetection.js's detectConflicts: `today` is always the target
// date under evaluation).
//
// FLOOR_COMPLETED is always a real past event (a completed visit's date can
// never be in the future - see VisitLogModal.jsx's date input, capped at
// today()), so "was visited ... prior" is always accurate there. FLOOR_PLANNED
// hasn't happened - it's another still-open plan, which could land on
// either side of the date being evaluated (nearestPlanned picks whichever
// planned visit is CLOSEST, not necessarily earlier) - "was visited" is
// wrong tense-wise (nothing happened yet) and "prior" would sometimes be
// wrong direction-wise too. "already has a visit planned within N days"
// makes neither claim while keeping the same "recently active here" signal
// spec §4.2 wants, so this no longer needs the shared wording that used to
// paper over the difference.
function warningMessage(conflict) {
  // Word-for-word the sentence blockingMessage used to return for this type,
  // plus the same "Plan anyway?" every other warning ends in - the fact
  // being reported did not change, only whether it stops you.
  if (conflict.type === 'DRAFT_ELSEWHERE') {
    const who = conflict.otherUserName || 'another rep';
    return `This place is already in ${who}'s draft for this day. Plan anyway?`;
  }
  const n = conflict.daysApart;
  const nDays = `${n} day${n === 1 ? '' : 's'}`;
  return conflict.type === 'FLOOR_COMPLETED'
    ? `This place was visited ${nDays} prior. Plan anyway?`
    : `This place already has a visit planned within ${nDays}. Plan anyway?`;
}

// do_not_visit is not a conflictDetection.js finding (that module only
// covers the floor/collision rules) - it rides this feature's own §4.2
// warning list instead. The PREDICATE is shared, though: services/doNotVisit.js
// owns the "is this mark still live today" rule that schedulingEngine.js's
// eligibility(), routes/visits.js's "Log a visit" and scheduleDraft.js's
// draft views all read too, so the flag can never mean one thing here and
// another there. Only the sentence is local - this surface plans a visit, so
// it asks "Plan anyway?".
function doNotVisitWarning(place, today) {
  if (isDoNotVisitActive(place, today)) {
    return { type: 'DO_NOT_VISIT', message: 'This place is marked do-not-visit. Plan anyway?' };
  }
  return null;
}

// Assembles the full warning list for a proposed create/edit - the
// detector's warning-tier conflicts first (in whatever order detectConflicts
// returned them), then do_not_visit. Order only matters for display; nothing
// downstream depends on it (both clients run their own primaryWarning
// priority over this array).
function buildWarnings({ warningConflicts, place, today }) {
  const warnings = warningConflicts.map((c) => ({ type: c.type, message: warningMessage(c), daysApart: c.daysApart }));
  const dnv = doNotVisitWarning(place, today);
  if (dnv) warnings.push(dnv);
  return warnings;
}

function blockedError(blocking, viewerId) {
  const err = new Error(blockingMessage(blocking[0], viewerId));
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
  const { blocking, warnings: warningConflicts } = classifyConflicts(conflicts);
  // createdByUserId, not userId: the message goes back to whoever submitted
  // this request, and "You" has to mean them - see blockingMessage.
  if (blocking.length > 0) throw blockedError(blocking, createdByUserId);

  const warnings = buildWarnings({ warningConflicts, place, today });
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
    const { blocking, warnings: warningConflicts } = classifyConflicts(conflicts);
    if (blocking.length > 0) throw blockedError(blocking, actingUserId);

    const warnings = buildWarnings({ warningConflicts, place, today });
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
  warningMessage,
  doNotVisitWarning,
  buildWarnings,
  canEditManualVisit,
  canDeleteManualVisit,
  createManualVisit,
  getEditableVisit,
  editVisit,
};
