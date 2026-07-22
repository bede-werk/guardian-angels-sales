// Route planner draft/commit lifecycle — thin HTTP wrappers around
// services/scheduleDraft.js, which has all the actual logic.
//
// Every route acts on req.user (set by middleware/requireAuth.js from the
// caller's own bearer token), not a client-supplied userId — a draft is
// owned by whoever generated it, and scheduleDraft.js's assertOwnsDraft
// enforces that on every mutation, since getting this wrong is exactly the
// double-booking risk phase 6 exists to prevent.
const express = require('express');
const knex = require('../db/knex');
const scheduleDraft = require('../services/scheduleDraft');

const router = express.Router();

// Routes below throw errors carrying a `status` (404/403/409) for expected
// failure cases (not found, not yours, collision) — this wrapper respects
// that instead of always falling through to the generic 500 handler.
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };
}

// POST /api/schedule-drafts/generate
// Body: { days: [{ date, hoursPerDay }], homeBase, zoneOverrides?, regenerate? }
// `days` is the exact set of calendar dates the user picked (up to
// scheduleDraft.MAX_PLAN_DATES), each with its own hours budget — validated
// (future dates only, no dupes, no date that's already committed — see
// scheduleDraft.validateDays) before anything is generated. If an active
// draft already exists and regenerate isn't set, just returns it
// (recalculated) instead of duplicating — same convention as the old
// scheduler's POST /generate.
router.post('/generate', handle(async (req, res) => {
  const { homeBase, regenerate } = req.body;
  if (!homeBase || homeBase.lat == null || homeBase.lng == null) {
    return res.status(400).json({ error: 'homeBase: { lat, lng } is required' });
  }
  const draft = await scheduleDraft.generateAndPersistDraft({
    userId: req.user.id,
    params: req.body,
    regenerate: !!regenerate,
  });
  res.json(draft);
}));

// GET /api/schedule-drafts/active — the caller's current draft, fully
// recalculated (every day), or null if they don't have one.
router.get('/active', handle(async (req, res) => {
  const existing = await scheduleDraft.getActiveDraft(knex, req.user.id);
  if (!existing) return res.json(null);
  res.json(await scheduleDraft.loadDraftView(knex, existing.id));
}));

// GET /api/schedule-drafts/committed-dates — every today-or-later date this
// user already has real visits scheduled on, with a count each:
// [{ date, count }]. The "Plan My Visits" calendar disables these dates (a
// day that's already been committed can never be selected for another round
// of planning) and the page also renders them as a plain "already committed"
// snapshot list.
router.get('/committed-dates', handle(async (req, res) => {
  const summaries = await scheduleDraft.committedDateSummaries(knex, req.user.id);
  res.json(summaries);
}));

// POST /api/schedule-drafts/days/:date/reopen — reopen an already-committed
// day back into an editable draft: pulls that date's committed (planner-
// sourced) visits back into schedule_draft_stops and deletes the visits rows
// (see scheduleDraft.reopenCommittedDay). From here on, every existing
// draft-editing endpoint below (reorder/add/remove/visit-type/reoptimize/
// commit) works on this day exactly as if it had never been committed.
// Body: { homeBase? } — required only if the caller has no active draft yet;
// ignored (the existing draft's own homeBase wins) if they do.
router.post('/days/:date/reopen', handle(async (req, res) => {
  const draft = await scheduleDraft.reopenCommittedDay({ userId: req.user.id, date: req.params.date, homeBase: req.body.homeBase });
  res.json(draft);
}));

// DELETE /api/schedule-drafts/committed-dates/:date — undo a whole day's
// commit: removes every still-planned (not completed/skipped) visit this
// user has on that date — see scheduleDraft.deleteCommittedDay for why
// completed/skipped history is deliberately left alone. Frees the date back
// up on the calendar once nothing real is left on it.
router.delete('/committed-dates/:date', handle(async (req, res) => {
  const deleted = await scheduleDraft.deleteCommittedDay(knex, { userId: req.user.id, date: req.params.date });
  res.json({ date: req.params.date, deleted });
}));

// DELETE /api/schedule-drafts/:id/days/:date — discard just this day's
// still-open proposal, as if that date had never been picked at all (every
// other day, and anything already accepted for THIS day, is untouched — see
// scheduleDraft.js's discardDay). Returns the full recalculated draft view
// (its days list just shrank by one), or null if that was the last date and
// the whole draft is gone now.
router.delete('/:id/days/:date', handle(async (req, res) => {
  const result = await scheduleDraft.discardDay({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date });
  res.json(result);
}));

// PATCH /api/schedule-drafts/:id/days/:date/reorder
// Body: { placeIds: [...] } — new order is the array order itself.
router.patch('/:id/days/:date/reorder', handle(async (req, res) => {
  const { placeIds } = req.body;
  if (!Array.isArray(placeIds)) return res.status(400).json({ error: 'placeIds must be an array of place ids' });
  const day = await scheduleDraft.reorderDay({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date, placeIds });
  res.json(day);
}));

// POST /api/schedule-drafts/:id/days/:date/stops
// Body: { placeId, visitType? } — add a stop (from a suggestion, or ad hoc).
router.post('/:id/days/:date/stops', handle(async (req, res) => {
  const { placeId, visitType } = req.body;
  if (!placeId) return res.status(400).json({ error: 'placeId is required' });
  const day = await scheduleDraft.addStop({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date, placeId: Number(placeId), visitType });
  res.status(201).json(day);
}));

// DELETE /api/schedule-drafts/:id/days/:date/stops/:placeId
router.delete('/:id/days/:date/stops/:placeId', handle(async (req, res) => {
  const day = await scheduleDraft.removeStop({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date, placeId: Number(req.params.placeId) });
  res.json(day);
}));

// PATCH /api/schedule-drafts/:id/days/:date/stops/:placeId
// Body: { visitType }
router.patch('/:id/days/:date/stops/:placeId', handle(async (req, res) => {
  const { visitType } = req.body;
  const day = await scheduleDraft.setVisitType({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date, placeId: Number(req.params.placeId), visitType });
  res.json(day);
}));

// POST /api/schedule-drafts/:id/days/:date/reoptimize — re-sequence a day's
// current stops via a real OSRM call (does not add/remove any stop).
router.post('/:id/days/:date/reoptimize', handle(async (req, res) => {
  const day = await scheduleDraft.reoptimizeDay({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date });
  res.json(day);
}));

// GET /api/schedule-drafts/:id/days/:date/suggestions — top nearby eligible
// candidates not already in the draft, for the "day is under budget" prompt.
router.get('/:id/days/:date/suggestions', handle(async (req, res) => {
  const suggestions = await scheduleDraft.getSuggestions({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date });
  res.json(suggestions);
}));

// POST /api/schedule-drafts/:id/days/:date/commit — commit one day to real visits rows.
router.post('/:id/days/:date/commit', handle(async (req, res) => {
  const result = await scheduleDraft.commitDay({ draftId: Number(req.params.id), userId: req.user.id, date: req.params.date });
  res.json(result);
}));

// POST /api/schedule-drafts/:id/commit — commit every remaining day, in date order.
router.post('/:id/commit', handle(async (req, res) => {
  const results = await scheduleDraft.commitAll({ draftId: Number(req.params.id), userId: req.user.id });
  res.json(results);
}));

// DELETE /api/schedule-drafts/:id — discard the whole proposal (every day),
// not just one day's stops. No replacement is generated — the caller goes
// back to having no active draft.
router.delete('/:id', handle(async (req, res) => {
  await scheduleDraft.deleteActiveDraft({ draftId: Number(req.params.id), userId: req.user.id });
  res.status(204).end();
}));

module.exports = router;
