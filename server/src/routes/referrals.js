// Referrals - a person sending business to Guardian Angels. Every referral
// is attributed to a specific person; a place's referral total is just the
// sum of the referral counts of whoever currently works there (see
// routes/places.js), so a referral is never logged *against* a place directly.
//
// person_id is REQUIRED - a referral with no person has nowhere to be counted,
// since both rollups key on it. A PLACE is not. Plenty of real referral sources
// don't sit in a building we visit (an elder-law attorney, a fiduciary, a
// former client's family), and detach-not-delete can leave a person placeless
// through no action of the rep's - deleting a place nulls its whole roster's
// place_id. Refusing those referrals wouldn't prevent bad data, it would just
// push the rep into fake-assigning a plausible place, which is worse data than
// a null. What a null place snapshot does and doesn't cost is on POST below.
const express = require('express');
const knex = require('../db/knex');

const router = express.Router();

// GET /api/referrals/classes - the payer sources already in use, for the log
// form's suggestion list. Declared before the /:id routes so 'classes' can't
// be swallowed as an id.
//
// This is a suggestion list, not a whitelist: the column is free text (see
// migration 20260828010000) and the server never rejects a new value. It
// exists so two people typing the same payer spell it the same way.
router.get('/classes', async (req, res, next) => {
  try {
    const rows = await knex('referrals')
      .whereNotNull('class')
      .whereNot('class', '')
      .distinct('class')
      .orderBy('class');
    res.json(rows.map((r) => r.class));
  } catch (err) {
    next(err);
  }
});

// POST /api/referrals - log a referral for a person. The referral's place_id
// is a snapshot of that person's place *at the time it's logged* (not
// independently settable from the client) - mostly a historical breadcrumb,
// since place totals are computed live from each person's current tally.
//
// A person with no place is allowed and stamps a null snapshot. Two
// consequences, both intended:
//   - The PLACE rollup heals itself. referralMetricsByPlaceId joins on the
//     person's *current* place, so assigning them to a place later pulls every
//     referral they logged while placeless into that place's total. Nothing to
//     backfill.
//   - The CAPACITY floor never sees it. capacity.js's measuredFloorByPlace
//     reads this frozen snapshot directly (capacity is a property of the
//     BUILDING, not the contact), so a null-snapshot referral credits no
//     building's measured referrals/month, ever. Right for a referrer who
//     genuinely isn't in a building; a conservative under-count for one whose
//     place we just hadn't entered yet. Deliberately not auto-backfilled on
//     assignment - that would mis-credit every job-changer, which is the exact
//     thing the snapshot exists to prevent.
router.post('/', async (req, res, next) => {
  try {
    // `class` is deliberately read off req.body rather than destructured with
    // the rest: `class` is a reserved word in JS, so `const { class } = ...`
    // is a syntax error. It's fine as an object KEY further down.
    const { person_id, referral_date, notes } = req.body;
    const referralClass = req.body.class;
    if (!person_id) return res.status(400).json({ error: 'person_id is required' });
    const numericPersonId = Number(person_id);
    if (Number.isNaN(numericPersonId)) return res.status(404).json({ error: 'Person not found' });

    const person = await knex('people').where({ id: numericPersonId }).first();
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const [inserted] = await knex('referrals')
      .insert({
        place_id: person.place_id, // null when this person isn't assigned anywhere - see above
        person_id: numericPersonId,
        referral_date: referral_date || null,
        notes: notes || null,
        class: referralClass || null,
      })
      .returning('id');
    const id = knex.extractId(inserted);
    res.status(201).json(await knex('referrals').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// PATCH /api/referrals/:id - edit the date/notes on an existing referral.
// person_id isn't editable here - a referral attributed to the wrong person
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
    if (req.body.class !== undefined) update.class = req.body.class || null;

    await knex('referrals').where({ id }).update(update);
    res.json(await knex('referrals').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/referrals/:id - undo a mis-logged referral.
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
