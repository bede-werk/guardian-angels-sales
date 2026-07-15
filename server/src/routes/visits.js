// Visits — one planned/completed/skipped touchpoint on a place, by a rep,
// on a date. This covers logging outcomes/notes/person info, skipping a
// stop, and deleting one. (Creating a whole day's worth at once happens via
// the route planner's commit flow — see services/scheduleDraft.js — not here.)
const express = require('express');
const knex = require('../db/knex');
const { validatePhone } = require('../services/phone');

const router = express.Router();

const OUTCOMES = ['interested', 'not_ready', 'follow_up', 'no_answer', 'left_materials'];
const STATUSES = ['planned', 'completed', 'skipped'];

// Fields a client is allowed to set when logging/updating a visit. Anything
// not in this list in the request body is silently ignored (not saved).
const EDITABLE = [
  'user_id',
  'scheduled_date',
  'status',
  'outcome',
  'notes',
  'person_id',
  'person_name',
  'person_title',
  'person_email',
  'person_phone',
  'next_visit_date',
  'sort_order',
];

// Re-fetches a visit joined to its place's basic info, for the response
// after a create/update (so the frontend doesn't need a second request).
// Left join, not inner — a visit's place can be gone (deleted) while the
// visit itself survives; v.place_name is the durable snapshot that still
// identifies it either way, so it isn't overridden by the (possibly absent) live join.
async function fetchVisit(id) {
  return knex('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .where('v.id', id)
    .select('v.*', 'p.city as place_city', 'p.zip as place_zip')
    .first();
}

// POST /api/visits — create an ad-hoc visit (outside the generated schedule),
// e.g. from the "Log a visit" button on a Place Detail page.
router.post('/', async (req, res, next) => {
  try {
    const { place_id } = req.body;
    if (!place_id) return res.status(400).json({ error: 'place_id is required' });
    const place = await knex('places').where({ id: place_id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    // place_name is a one-time snapshot taken here, at logging time — a
    // visit's place_id is never changed after creation, so this never needs
    // re-deriving later, even if the place is later renamed or deleted.
    const payload = { place_id, place_name: place.name };
    for (const f of EDITABLE) if (req.body[f] !== undefined) payload[f] = req.body[f];
    if (payload.outcome && !OUTCOMES.includes(payload.outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    }
    const phoneError = validatePhone(payload.person_phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Same rule as PATCH below: a visit created already-completed (e.g. an
    // ad-hoc "log a spontaneous visit" save) gets its completed_at stamped
    // immediately, not left null.
    if (payload.status === 'completed') payload.completed_at = knex.fn.now();

    const [inserted] = await knex('visits').insert(payload).returning('id');
    const id = knex.extractId(inserted);
    res.status(201).json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visits/:id — log or update a visit (notes, person, outcome, etc.).
// This is what the "Log Visit" form actually calls when saving.
router.patch('/:id', async (req, res, next) => {
  try {
    const visit = await knex('visits').where({ id: req.params.id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    if (update.outcome && !OUTCOMES.includes(update.outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    }
    if (update.status && !STATUSES.includes(update.status)) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    const phoneError = validatePhone(update.person_phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Stamp completion time only the moment a visit *becomes* completed, not
    // on every subsequent edit to an already-completed visit.
    if (update.status === 'completed' && visit.status !== 'completed') {
      update.completed_at = knex.fn.now();
    }

    await knex('visits').where({ id: req.params.id }).update(update);
    res.json(await fetchVisit(req.params.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/visits/:id/skip — convenience for skipping a stop on today's route
// without opening the full log-visit form.
router.post('/:id/skip', async (req, res, next) => {
  try {
    const visit = await knex('visits').where({ id: req.params.id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    await knex('visits').where({ id: req.params.id }).update({ status: 'skipped', updated_at: knex.fn.now() });
    res.json(await fetchVisit(req.params.id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visits/:id — remove a stop from the schedule entirely (not the
// same as skipping — this deletes the row, skip just changes its status).
router.delete('/:id', async (req, res, next) => {
  try {
    const count = await knex('visits').where({ id: req.params.id }).del();
    if (!count) return res.status(404).json({ error: 'Visit not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
