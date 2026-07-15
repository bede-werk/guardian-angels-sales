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
// Body: { daysAhead?, workingWeekdays?, exceptionDates?, hoursPerDay?, homeBase, zoneOverrides?, regenerate? }
// If an active draft already exists and regenerate isn't set, just returns
// it (recalculated) instead of duplicating — same convention as the old
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

module.exports = router;
