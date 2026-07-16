// Referrals — a person sending business to Guardian Angels. Every referral
// is attributed to a specific person; a place's referral total is just the
// sum of the referral counts of whoever currently works there (see
// routes/places.js), so there's no separate "unattributed to a place" concept.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// POST /api/referrals — log a referral for a person. The referral's place_id
// is a snapshot of that person's place *at the time it's logged* (not
// independently settable from the client) — mostly a historical breadcrumb,
// since place totals are computed live from each person's current tally.
router.post('/', async (req, res, next) => {
  try {
    const { person_id, referral_date, notes } = req.body;
    if (!person_id) return res.status(400).json({ error: 'person_id is required' });
    const numericPersonId = Number(person_id);
    if (Number.isNaN(numericPersonId)) return res.status(404).json({ error: 'Person not found' });

    const person = await knex('people').where({ id: numericPersonId }).first();
    if (!person) return res.status(404).json({ error: 'Person not found' });
    if (!person.place_id) {
      return res
        .status(400)
        .json({ error: "This person isn't assigned to a place, so a referral can't be attributed through them" });
    }

    const [inserted] = await knex('referrals')
      .insert({
        place_id: person.place_id,
        person_id: numericPersonId,
        referral_date: referral_date || null,
        notes: notes || null,
      })
      .returning('id');
    const id = knex.extractId(inserted);
    res.status(201).json(await knex('referrals').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/referrals/:id — edit the date/notes on an existing referral.
// person_id isn't editable here — a referral attributed to the wrong person
// should be deleted and re-logged instead, same as place_id (its snapshot
// follows person_id at creation time, see POST above).
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Referral not found' });
    const existing = await knex('referrals').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Referral not found' });

    const update = {};
    if (req.body.referral_date !== undefined) update.referral_date = req.body.referral_date || null;
    if (req.body.notes !== undefined) update.notes = req.body.notes || null;

    await knex('referrals').where({ id }).update(update);
    res.json(await knex('referrals').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/referrals/:id — undo a mis-logged referral.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Referral not found' });
    const count = await knex('referrals').where({ id }).del();
    if (!count) return res.status(404).json({ error: 'Referral not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
