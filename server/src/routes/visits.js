const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

const OUTCOMES = ['interested', 'not_ready', 'follow_up', 'no_answer', 'left_materials'];
const STATUSES = ['planned', 'completed', 'skipped'];

// Fields a client is allowed to set when logging/updating a visit.
const EDITABLE = [
  'user_id',
  'scheduled_date',
  'status',
  'outcome',
  'notes',
  'contact_name',
  'contact_title',
  'contact_email',
  'contact_phone',
  'next_visit_date',
  'sort_order',
];

async function fetchVisit(id) {
  return knex('visits as v')
    .join('partners as p', 'p.id', 'v.partner_id')
    .where('v.id', id)
    .select('v.*', 'p.name as partner_name', 'p.city as partner_city', 'p.zip as partner_zip')
    .first();
}

// POST /api/visits — create an ad-hoc visit (outside the generated schedule).
router.post('/', async (req, res, next) => {
  try {
    const { partner_id } = req.body;
    if (!partner_id) return res.status(400).json({ error: 'partner_id is required' });

    const payload = { partner_id };
    for (const f of EDITABLE) if (req.body[f] !== undefined) payload[f] = req.body[f];
    if (payload.outcome && !OUTCOMES.includes(payload.outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    }

    const [inserted] = await knex('visits').insert(payload).returning('id');
    const id = inserted && inserted.id ? inserted.id : inserted;
    res.status(201).json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visits/:id — log or update a visit (notes, contact, outcome, etc.).
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

    // Stamp completion time when a visit transitions to completed.
    if (update.status === 'completed' && visit.status !== 'completed') {
      update.completed_at = knex.fn.now();
    }

    await knex('visits').where({ id: req.params.id }).update(update);
    res.json(await fetchVisit(req.params.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/visits/:id/skip — convenience for skipping a stop.
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

// DELETE /api/visits/:id — remove a stop from the schedule.
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
