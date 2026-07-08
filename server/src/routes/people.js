// People — the individuals we come into contact with at a place. Covers the
// per-place roster (used by the "who did you meet?" picker and PlaceDetail's
// "People here" card), the cross-place People directory tab, and CRUD.
// Mounted at the bare /api prefix in index.js because these routes define
// their own full paths (some nest under /places/:placeId, some don't),
// rather than all sharing one /api/people prefix.
const express = require('express');
const dayjs = require('dayjs');
const knex = require('../db/knex');
const { validatePhone } = require('../services/phone');
const { suggestRelationshipTemp } = require('../services/relationshipTemp');

const router = express.Router();

const ROLE_TYPES = ['decision_maker', 'gatekeeper', 'champion', 'other'];
const TEMPS = ['hot', 'warm', 'cold', 'dormant'];

// Fields a client is allowed to set on a person (mirrors the `people` migration).
const EDITABLE = [
  'name',
  'title',
  'role_type',
  'email',
  'phone',
  'relationship_temp',
  'preferences',
  'notes',
  'birthday',
  'departed',
  'is_primary',
];

// Checks the enum-like fields against their allowed values. Returns an error
// string to send back to the client, or null if everything's valid.
function validate(payload) {
  if (payload.role_type && !ROLE_TYPES.includes(payload.role_type)) {
    return `role_type must be one of ${ROLE_TYPES.join(', ')}`;
  }
  if (payload.relationship_temp && !TEMPS.includes(payload.relationship_temp)) {
    return `relationship_temp must be one of ${TEMPS.join(', ')}`;
  }
  return validatePhone(payload.phone);
}

// Only one person per place can be primary at a time. Called whenever a
// create/update sets is_primary=true, so the previous primary (if any) is
// automatically demoted in the same transaction.
async function unsetOtherPrimaries(trx, placeId, keepId) {
  await trx('people').where({ place_id: placeId }).whereNot({ id: keepId }).update({ is_primary: false });
}

// SQLite stores booleans as 0/1 — coerce them back to real booleans for the API.
function decorate(p) {
  return { ...p, departed: !!p.departed, is_primary: !!p.is_primary };
}

// GET /api/people — cross-place directory (the People tab). Query params:
// search (name/title), placeId, category (of their place), temp
// (relationship_temp), neverContacted=1 (no completed visit on file yet).
router.get('/people', async (req, res, next) => {
  try {
    const { search, placeId, category, temp, neverContacted } = req.query;

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
    if (temp) query.where('pe.relationship_temp', temp);
    if (neverContacted === '1' || neverContacted === 'true') query.whereNull('lv.last_visit_date');

    query.orderBy('p.name', 'asc').orderBy('pe.is_primary', 'desc').orderBy('pe.name', 'asc');

    const people = await query;
    res.json(people.map(decorate));
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

    const visits = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.person_id', person.id)
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    const referrals = await knex('referrals')
      .where({ person_id: person.id })
      .orderBy('referral_date', 'desc')
      .orderBy('id', 'desc');

    // Suggested temperature needs a place to judge cadence against — an
    // unassigned person has no visit recency to speak of, so no suggestion.
    let suggestedRelationshipTemp = null;
    if (place) {
      const lastPlaceVisit = await knex('visits')
        .where({ place_id: place.id, status: 'completed' })
        .orderBy('scheduled_date', 'desc')
        .first();
      const daysSinceLastVisit = lastPlaceVisit
        ? dayjs().diff(dayjs(lastPlaceVisit.scheduled_date), 'day')
        : null;
      suggestedRelationshipTemp = suggestRelationshipTemp({
        currentTemp: person.relationship_temp,
        tier: place.tier,
        daysSinceLastVisit,
      });
    }

    res.json({
      ...decorate(person),
      place,
      visits,
      referrals,
      suggested_relationship_temp: suggestedRelationshipTemp,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:placeId/people — a place's people, primary first. Used by
// PlaceDetail's "People here" card and the "who did you meet?" picker.
router.get('/places/:placeId/people', async (req, res, next) => {
  try {
    const people = await knex('people')
      .where({ place_id: req.params.placeId })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');
    res.json(people.map(decorate));
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
    if (!placeId) payload.is_primary = false; // "primary at a place" needs a place

    const validationError = validate(payload);
    if (validationError) return res.status(400).json({ error: validationError });

    const person = await knex.transaction(async (trx) => {
      const [inserted] = await trx('people').insert(payload).returning('id');
      // better-sqlite3's returning() gives back an id-only row on some Knex
      // versions; Postgres gives the full row. Normalize to just the id here.
      const id = inserted && inserted.id ? inserted.id : inserted;
      if (payload.is_primary && placeId) await unsetOtherPrimaries(trx, placeId, id);
      return trx('people').where({ id }).first();
    });

    res.status(201).json(decorate(person));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/people/:id — update any field (role, temperature, departed, etc.).
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
        update.is_primary = false; // "primary at a place" is meaningless once unassigned
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
      const effectivePlaceId = update.place_id !== undefined ? update.place_id : existing.place_id;
      if (update.is_primary && effectivePlaceId) await unsetOtherPrimaries(trx, effectivePlaceId, req.params.id);
      return trx('people').where({ id: req.params.id }).first();
    });

    res.json(decorate(person));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/people/:id — permanently remove a person record. (Note: for
// someone who's simply left their job, prefer PATCHing departed=true instead —
// that keeps their visit history intact and flags the relationship for rebuilding.)
router.delete('/people/:id', async (req, res, next) => {
  try {
    const count = await knex('people').where({ id: req.params.id }).del();
    if (!count) return res.status(404).json({ error: 'Person not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
