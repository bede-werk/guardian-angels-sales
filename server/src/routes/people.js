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
const { compareDatesAsc } = require('../services/sortHelpers');
const { computeRelationshipForPeople } = require('../services/relationship');
const { orgToday } = require('../services/orgDate');

const router = express.Router();

// Fields a client is allowed to set on a person (mirrors the `people` migration).
const EDITABLE = [
  'name',
  'title',
  'email',
  'phone',
  'preferences',
  'notes',
  'birthday_month',
  'birthday_day',
];

// Checks the enum-like fields against their allowed values. Returns an error
// string to send back to the client, or null if everything's valid. Plain
// bounds checks, not full per-month day-count validation — the client's own
// Day <select> only ever offers valid days for whichever month is picked, so
// this is just a backstop.
function validate(payload) {
  const phoneErr = validatePhone(payload.phone);
  if (phoneErr) return phoneErr;
  if (payload.birthday_month != null && (payload.birthday_month < 1 || payload.birthday_month > 12)) {
    return 'birthday_month must be between 1 and 12';
  }
  if (payload.birthday_day != null && (payload.birthday_day < 1 || payload.birthday_day > 31)) {
    return 'birthday_day must be between 1 and 31';
  }
  return null;
}

// relationship_seed is a converged SCORE value (see migration
// 20260803000001), not a bucket and not a multiplier — a rep's one-time
// judgment of an existing relationship, which then decays on the same clock as
// real visit weight. Null clears it. Deliberately not in EDITABLE: setting it
// also stamps relationship_seeded_at server-side, since that date is the
// origin of the decay clock and a client-supplied one could park a seed at
// full strength forever.
const MAX_RELATIONSHIP_SEED = 10;

function relationshipSeedError(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'relationship_seed must be a non-negative number';
  if (n > MAX_RELATIONSHIP_SEED) return `relationship_seed must be ${MAX_RELATIONSHIP_SEED} or less`;
  return null;
}

// '' (the picker's unselected option) -> null (clearing), otherwise Number(...)
// — same coercion shape as person_id/user_id elsewhere in this app. Mutates
// payload in place; called after EDITABLE has already copied raw body values in.
function coerceBirthdayFields(payload) {
  if (payload.birthday_month !== undefined) {
    payload.birthday_month = payload.birthday_month === '' || payload.birthday_month === null ? null : Number(payload.birthday_month);
  }
  if (payload.birthday_day !== undefined) {
    payload.birthday_day = payload.birthday_day === '' || payload.birthday_day === null ? null : Number(payload.birthday_day);
  }
}

// Re-sorts the already-decorated (referral_metrics attached) people list per
// the `sort` query param. Pure (no knex) — takes/returns plain arrays. The
// default case returns `rows` unchanged, preserving the SQL query's own
// `p.name, pe.name` order, so "no sort picked" behaves exactly as it always
// has. Array.prototype.sort is spec-guaranteed stable, so every case here
// keeps that same name-order as its tiebreaker for free.
function sortPeople(rows, sort) {
  switch (sort) {
    case 'last_contacted_desc':
      return [...rows].sort((a, b) => -compareDatesAsc(a.last_visit_date, b.last_visit_date));
    case 'last_contacted_asc':
      return [...rows].sort((a, b) => compareDatesAsc(a.last_visit_date, b.last_visit_date));
    case 'my_last_contacted_desc':
      return [...rows].sort((a, b) => -compareDatesAsc(a.my_last_visit_date, b.my_last_visit_date));
    case 'my_last_contacted_asc':
      return [...rows].sort((a, b) => compareDatesAsc(a.my_last_visit_date, b.my_last_visit_date));
    case 'referrals_desc':
      return [...rows].sort((a, b) => b.referral_metrics.lifetime_referrals - a.referral_metrics.lifetime_referrals);
    case 'referrals_asc':
      return [...rows].sort((a, b) => a.referral_metrics.lifetime_referrals - b.referral_metrics.lifetime_referrals);
    case 'last_referral_desc':
      return [...rows].sort((a, b) => -compareDatesAsc(a.referral_metrics.last_referral_date, b.referral_metrics.last_referral_date));
    case 'last_referral_asc':
      return [...rows].sort((a, b) => compareDatesAsc(a.referral_metrics.last_referral_date, b.referral_metrics.last_referral_date));
    default:
      return rows;
  }
}

// GET /api/people — cross-place directory (the People tab). Query params:
// search (name/title), placeId, category (of their place),
// sort (name [default] | last_contacted_desc | last_contacted_asc |
// my_last_contacted_desc | my_last_contacted_asc | referrals_desc |
// referrals_asc | last_referral_desc | last_referral_asc).
router.get('/people', async (req, res, next) => {
  try {
    const { search, placeId, category, sort } = req.query;

    // Last *completed* visit per person, same "only a finished call counts"
    // rule used for places (see places.js's lastVisit subquery).
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .whereNotNull('person_id')
      .select('person_id')
      .max('scheduled_date as last_visit_date')
      .groupBy('person_id')
      .as('lv');

    // Same, but scoped to only the logged-in rep's own visits — lets
    // "last contacted by me" answer "have I personally talked to this
    // person" separately from "has anyone on the team."
    const myLastVisit = knex('visits')
      .where('status', 'completed')
      .where('user_id', req.user.id)
      .whereNotNull('person_id')
      .select('person_id')
      .max('scheduled_date as my_last_visit_date')
      .groupBy('person_id')
      .as('mlv');

    // Left join, not inner — a person can now be unassigned (place_id null),
    // e.g. after their place was deleted or they were manually detached, and
    // should still show up in the directory rather than disappearing.
    const query = knex('people as pe')
      .leftJoin('places as p', 'p.id', 'pe.place_id')
      .leftJoin(lastVisit, 'lv.person_id', 'pe.id')
      .leftJoin(myLastVisit, 'mlv.person_id', 'pe.id')
      .select(
        'pe.*',
        'p.name as place_name',
        'p.region as place_region',
        'lv.last_visit_date',
        'mlv.my_last_visit_date'
      );

    if (search) {
      const like = `%${search.toLowerCase()}%`;
      query.where((qb) => {
        qb.whereRaw('LOWER(pe.name) LIKE ?', [like]).orWhereRaw('LOWER(COALESCE(pe.title, \'\')) LIKE ?', [like]);
      });
    }
    if (placeId) query.where('pe.place_id', placeId);
    if (category) query.where('p.category', category);

    query.orderBy('p.name', 'asc').orderBy('pe.name', 'asc');

    const people = await query;
    const metricsById = await referralMetricsByPersonId(knex, people.map((p) => p.id));
    let decorated = people.map((p) => ({ ...p, referral_metrics: metricsFor(metricsById, p.id) }));
    decorated = sortPeople(decorated, sort);
    res.json(decorated);
  } catch (err) {
    next(err);
  }
});

// GET /api/people/birthdays?month=<1-12> — every person with a birthday in
// the given month, across every place, for the Calendar tab's birthday
// badges. Registered before /people/:id so Express doesn't match "birthdays"
// as an :id param. Not scoped to the requesting rep at all (no userId
// filter) — a birthday isn't rep-owned data, same as places/people generally
// aren't anywhere else in this app. No year in the query either, since
// birthday_month/day themselves have no year — a birthday recurs every year
// by construction, so this always answers "who has a birthday in month X"
// regardless of which year's instance of that month the Calendar happens to
// be showing.
router.get('/people/birthdays', async (req, res, next) => {
  try {
    const month = Number(req.query.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'month is required, 1-12' });
    }
    const rows = await knex('people as pe')
      .leftJoin('places as p', 'p.id', 'pe.place_id')
      .where('pe.birthday_month', month)
      .orderBy('pe.birthday_day', 'asc')
      .select('pe.id', 'pe.name', 'pe.place_id', 'p.name as place_name', 'pe.birthday_day');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/people/check-duplicate?name=... — dry-run check for PersonModal's
// pre-save warning, no write. Deliberately its OWN endpoint rather than
// reusing GET /people's general `search` (which also matches `title` — a
// duplicate check should only ever be about the person's actual name).
// Same loose case-insensitive substring match as everywhere else in this
// app ("similar," not exact) — org-wide, not scoped to a place, since the
// same person can turn up at more than one place.
router.get('/people/check-duplicate', async (req, res, next) => {
  try {
    const { name } = req.query;
    if (!name || name.trim().length < 3) return res.json([]);
    const rows = await knex('people')
      .whereRaw('LOWER(name) LIKE ?', [`%${name.trim().toLowerCase()}%`])
      .select('id', 'name')
      .limit(5);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/people/:id — a person with their place, full visit history (every
// visit where this person was the recorded contact), and every referral
// they've sent us.
router.get('/people/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Person not found' });
    const person = await knex('people').where({ id }).first();
    if (!person) return res.status(404).json({ error: 'Person not found' });

    const place = await knex('places').where({ id: person.place_id }).first();

    // Visit history is for what actually happened — a still-planned or
    // skipped visit doesn't belong here.
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

    // Full relationship object — this screen is where "why does this person
    // read weak?" has to be answerable (last meaningful visit, how much of the
    // score is still a fading initial estimate, what the reciprocity
    // multiplier is doing).
    const relationshipByPerson = await computeRelationshipForPeople(knex, [person.id]);

    res.json({
      ...person,
      place,
      visits,
      referrals,
      referral_metrics: summarizeReferralDates(referrals.map((r) => r.referral_date)),
      relationship: relationshipByPerson.get(person.id) || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:placeId/people — a place's people. Used by PlaceDetail's
// "People here" card and the "who did you meet?" picker.
router.get('/places/:placeId/people', async (req, res, next) => {
  try {
    const placeId = Number(req.params.placeId);
    if (Number.isNaN(placeId)) return res.json([]);
    const people = await knex('people')
      .where({ place_id: placeId })
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
      const numericPlaceId = Number(place_id);
      if (Number.isNaN(numericPlaceId)) return res.status(400).json({ error: 'place not found' });
      const place = await knex('places').where({ id: numericPlaceId }).first();
      if (!place) return res.status(400).json({ error: 'place not found' });
      placeId = numericPlaceId;
    }

    const payload = { place_id: placeId, name: String(name).trim() };
    for (const f of EDITABLE) if (f !== 'name' && req.body[f] !== undefined) payload[f] = req.body[f];
    coerceBirthdayFields(payload);

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

// POST /api/people/seed-relationships — bulk one-time relationship seeding
// (see the seeding screen). Body: [{ person_id, seed }], where a null/''
// seed clears that person's seed instead of setting one.
//
// Re-runnable by design: re-seeding a person overwrites their value and resets
// relationship_seeded_at to today, restarting the decay clock. That's the
// intended way to correct a seed you got wrong, so this deliberately does not
// refuse to touch an already-seeded person.
//
// All-or-nothing in one transaction — a half-applied seeding pass would be
// worse than none, since there'd be no way to tell which half landed.
router.post('/people/seed-relationships', async (req, res, next) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'body must be an array of { person_id, seed }' });
    if (!entries.length) return res.json({ updated: 0 });

    // Validate everything BEFORE writing anything, so a bad row at the end
    // can't leave the first half of the pass applied.
    const writes = [];
    for (const entry of entries) {
      const personId = Number(entry?.person_id);
      if (!Number.isInteger(personId)) return res.status(400).json({ error: 'each entry needs a numeric person_id' });
      const seedErr = relationshipSeedError(entry.seed);
      if (seedErr) return res.status(400).json({ error: `person ${personId}: ${seedErr}` });
      const clearing = entry.seed === null || entry.seed === undefined || entry.seed === '';
      writes.push({
        id: personId,
        relationship_seed: clearing ? null : Number(entry.seed),
        relationship_seeded_at: clearing ? null : orgToday(),
      });
    }

    const ids = writes.map((w) => w.id);
    const found = await knex('people').whereIn('id', ids).select('id');
    if (found.length !== new Set(ids).size) {
      return res.status(400).json({ error: 'one or more people not found' });
    }

    await knex.transaction(async (trx) => {
      for (const w of writes) {
        await trx('people').where({ id: w.id }).update({
          relationship_seed: w.relationship_seed,
          relationship_seeded_at: w.relationship_seeded_at,
          updated_at: trx.fn.now(),
        });
      }
    });

    res.json({ updated: writes.length });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/people/:id — update any editable field.
router.patch('/people/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Person not found' });
    const existing = await knex('people').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Person not found' });

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];
    coerceBirthdayFields(update);

    // place_id isn't in EDITABLE — it needs its own validation and side
    // effects (rather than a straight copy), since it's how a person gets
    // detached from a place (null) or reassigned to a different one.
    if (req.body.place_id !== undefined) {
      if (req.body.place_id === null || req.body.place_id === '') {
        update.place_id = null;
      } else {
        const numericPlaceId = Number(req.body.place_id);
        if (Number.isNaN(numericPlaceId)) return res.status(400).json({ error: 'place not found' });
        const place = await knex('places').where({ id: numericPlaceId }).first();
        if (!place) return res.status(400).json({ error: 'place not found' });
        update.place_id = numericPlaceId;
      }
    }

    // relationship_seed, like place_id above, isn't a straight copy: writing
    // it also (re)starts the decay clock, so relationship_seeded_at is stamped
    // here rather than trusted from the body. Re-seeding the same person
    // overwrites the value AND resets the clock, which is what makes the
    // seeding screen safely re-runnable.
    if (req.body.relationship_seed !== undefined) {
      const seedErr = relationshipSeedError(req.body.relationship_seed);
      if (seedErr) return res.status(400).json({ error: seedErr });
      const clearing = req.body.relationship_seed === null || req.body.relationship_seed === '';
      update.relationship_seed = clearing ? null : Number(req.body.relationship_seed);
      update.relationship_seeded_at = clearing ? null : orgToday();
    }

    const validationError = validate(update);
    if (validationError) return res.status(400).json({ error: validationError });

    const person = await knex.transaction(async (trx) => {
      await trx('people').where({ id }).update(update);
      return trx('people').where({ id }).first();
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
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Person not found' });
    const deleted = await knex.transaction(async (trx) => {
      const person = await trx('people').where({ id }).first();
      if (!person) return false;
      await trx('referrals').where({ person_id: id }).del();
      await trx('people').where({ id }).del();
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Person not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
