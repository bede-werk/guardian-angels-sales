// People — the individuals we come into contact with at a place. Covers the
// per-place roster (used by the "who did you meet?" picker and PlaceDetail's
// "People here" card), the cross-place People directory tab, and CRUD.
// Mounted at the bare /api prefix in index.js because these routes define
// their own full paths (some nest under /places/:placeId, some don't),
// rather than all sharing one /api/people prefix.
const express = require('express');
const knex = require('../db/knex');
const { validatePhone } = require('../services/phone');
const { referralMetricsByPersonId, summarizeReferralDates, metricsFor } = require('../services/referralMetrics');

const router = express.Router();

const ROLE_TYPES = ['decision_maker', 'gatekeeper', 'champion', 'other'];

// Fields a client is allowed to set on a person (mirrors the `people` migration).
const EDITABLE = [
  'name',
  'title',
  'role_type',
  'email',
  'phone',
  'preferences',
  'notes',
  'birthday',
];

// Checks the enum-like fields against their allowed values. Returns an error
// string to send back to the client, or null if everything's valid.
function validate(payload) {
  if (payload.role_type && !ROLE_TYPES.includes(payload.role_type)) {
    return `role_type must be one of ${ROLE_TYPES.join(', ')}`;
  }
  return validatePhone(payload.phone);
}

// GET /api/people — cross-place directory (the People tab). Query params:
// search (name/title), placeId, category (of their place), neverContacted=1
// (no completed visit on file yet), needsAttention=1 (referred before but
// nothing in the last 90 days — see services/referralMetrics.js).
router.get('/people', async (req, res, next) => {
  try {
    const { search, placeId, category, neverContacted, needsAttention } = req.query;

    // Last *completed* visit per person, same "only a finished call counts"
    // rule used for places (see places.js's lastVisit subquery).
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .whereNotNull('person_id')
      .select('person_id')
      .max('scheduled_date as last_visit_date')
      .groupBy('person_id')
      .as('lv');

    // Left join, not inner — a person can now be unassigned (place_id null),
    // e.g. after their place was deleted or they were manually detached, and
    // should still show up in the directory rather than disappearing.
    const query = knex('people as pe')
      .leftJoin('places as p', 'p.id', 'pe.place_id')
      .leftJoin(lastVisit, 'lv.person_id', 'pe.id')
      .select(
        'pe.*',
        'p.name as place_name',
        'p.category as place_category',
        'p.city as place_city',
        'lv.last_visit_date'
      );

    if (search) {
      const like = `%${search.toLowerCase()}%`;
      query.where((qb) => {
        qb.whereRaw('LOWER(pe.name) LIKE ?', [like]).orWhereRaw('LOWER(COALESCE(pe.title, \'\')) LIKE ?', [like]);
      });
    }
    if (placeId) query.where('pe.place_id', placeId);
    if (category) query.where('p.category', category);
    if (neverContacted === '1' || neverContacted === 'true') query.whereNull('lv.last_visit_date');

    query.orderBy('p.name', 'asc').orderBy('pe.name', 'asc');

    const people = await query;
    const metricsById = await referralMetricsByPersonId(knex, people.map((p) => p.id));
    let decorated = people.map((p) => ({ ...p, referral_metrics: metricsFor(metricsById, p.id) }));
    if (needsAttention === '1' || needsAttention === 'true') {
      decorated = decorated.filter((p) => p.referral_metrics.needs_attention);
    }
    res.json(decorated);
  } catch (err) {
    next(err);
  }
});

// GET /api/people/:id — a person with their place, full visit history (every
// visit where this person was the recorded contact), and every referral
// they've sent us.
router.get('/people/:id', async (req, res, next) => {
  try {
    const person = await knex('people').where({ id: req.params.id }).first();
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const place = await knex('places').where({ id: person.place_id }).first();

    // Visit history is for what actually happened — a still-planned or
    // skipped stop from Today's Route doesn't belong here.
    const visits = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.person_id', person.id)
      .where('v.status', 'completed')
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    const referrals = await knex('referrals')
      .where({ person_id: person.id })
      .orderBy('referral_date', 'desc')
      .orderBy('id', 'desc');

    res.json({
      ...person,
      place,
      visits,
      referrals,
      referral_metrics: summarizeReferralDates(referrals.map((r) => r.referral_date)),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:placeId/people — a place's people. Used by PlaceDetail's
// "People here" card and the "who did you meet?" picker.
router.get('/places/:placeId/people', async (req, res, next) => {
  try {
    const people = await knex('people')
      .where({ place_id: req.params.placeId })
      .orderBy('name', 'asc');
    res.json(people);
  } catch (err) {
    next(err);
  }
});

// POST /api/people — add a person. place_id is optional (a person doesn't
// have to belong anywhere, same as a place doesn't need anyone on file) —
// pass it to create them already assigned, e.g. from PlaceDetail's
// "Add person" button, or omit it to create them unassigned.
router.post('/people', async (req, res, next) => {
  try {
    const { name, place_id } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    let placeId = null;
    if (place_id !== undefined && place_id !== null && place_id !== '') {
      const place = await knex('places').where({ id: place_id }).first();
      if (!place) return res.status(400).json({ error: 'place not found' });
      placeId = place_id;
    }

    const payload = { place_id: placeId, name: String(name).trim() };
    for (const f of EDITABLE) if (f !== 'name' && req.body[f] !== undefined) payload[f] = req.body[f];

    const validationError = validate(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const person = await knex.transaction(async (trx) => {
      const [inserted] = await trx('people').insert(payload).returning('id');
      const id = knex.extractId(inserted);
      return trx('people').where({ id }).first();
    });

    res.status(201).json(person);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/people/:id — update any editable field.
router.patch('/people/:id', async (req, res, next) => {
  try {
    const existing = await knex('people').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Person not found' });

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    // place_id isn't in EDITABLE — it needs its own validation and side
    // effects (rather than a straight copy), since it's how a person gets
    // detached from a place (null) or reassigned to a different one.
    if (req.body.place_id !== undefined) {
      if (req.body.place_id === null || req.body.place_id === '') {
        update.place_id = null;
      } else {
        const place = await knex('places').where({ id: req.body.place_id }).first();
        if (!place) return res.status(400).json({ error: 'place not found' });
        update.place_id = req.body.place_id;
      }
    }

    const validationError = validate(update);
    if (validationError) return res.status(400).json({ error: validationError });

    const person = await knex.transaction(async (trx) => {
      await trx('people').where({ id: req.params.id }).update(update);
      return trx('people').where({ id: req.params.id }).first();
    });

    res.json(person);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/people/:id — permanently remove a person record. Their visit
// history survives (visits.person_id -> null via ON DELETE SET NULL, with
// the person_name/etc. snapshot keeping it readable), but their referrals
// are deleted along with them rather than left floating with no one to
// attribute them to — a referral only makes sense tied to the person who
// sent it, unlike a visit which is meaningful on its own as a record of
// something that happened. The UI confirms this with the rep before calling here.
router.delete('/people/:id', async (req, res, next) => {
  try {
    const deleted = await knex.transaction(async (trx) => {
      const person = await trx('people').where({ id: req.params.id }).first();
      if (!person) return false;
      await trx('referrals').where({ person_id: req.params.id }).del();
      await trx('people').where({ id: req.params.id }).del();
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Person not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
