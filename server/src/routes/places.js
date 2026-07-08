// Places — the organizations that get visited. This file covers
// creating a place, the searchable/filterable directory list, filter-dropdown
// options, and a single place's full detail (visits + people).
const express = require('express');
const dayjs = require('dayjs');
const knex = require('../db/knex');
const { priorityLabel, priorityScore, regionForPlace } = require('../services/priority');
const { validatePhone } = require('../services/phone');
const { suggestRelationshipTemp } = require('../services/relationshipTemp');

const router = express.Router();

// Fields a client is allowed to set on an existing place via PATCH. (POST
// below has its own inline handling since it also derives priority_score/region.)
const EDITABLE = ['name', 'category', 'tier', 'is_priority', 'address', 'city', 'state', 'zip', 'phone', 'notes'];

// POST /api/places — create a place (e.g. from an unmatched note in review,
// or manually from the UI).
router.post('/', async (req, res, next) => {
  try {
    const { name, category, tier, is_priority, address, city, state, zip, phone } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const t = Number(tier) || 3;
    const pri = !!is_priority;
    const payload = {
      name: String(name).trim(),
      category: category || null,
      tier: t,
      is_priority: pri,
      priority_score: priorityScore(t, pri), // precomputed so list queries can sort on it cheaply
      address: address || null,
      city: city || null,
      state: state || 'NE',
      zip: zip || null,
      phone: phone || null,
      region: regionForPlace({ city, zip }),
    };
    const [row] = await knex('places').insert(payload).returning('id');
    const id = row && row.id ? row.id : row;
    const place = await knex('places').where({ id }).first();
    res.status(201).json(place);
  } catch (err) {
    next(err);
  }
});

// Attach a human-friendly priority label ("Tier 1", "Priority · Tier 1") and
// coerce is_priority to a real boolean (SQLite stores it as 0/1).
function decorate(p) {
  return { ...p, is_priority: !!p.is_priority, priority_label: priorityLabel(p.tier, !!p.is_priority) };
}

// GET /api/places — searchable / filterable list with last-visit + contact info.
// Query params: search, category, tier, city, zip, neverVisited=1
router.get('/', async (req, res, next) => {
  try {
    const { search, category, tier, city, zip, neverVisited } = req.query;

    // Subquery: last *completed* visit per place. A visit that's only planned
    // (on today's route but not yet done) must not count as a real visit.
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .select('place_id')
      .max('scheduled_date as last_visit_date')
      .count('* as visit_count')
      .groupBy('place_id')
      .as('lv');

    const query = knex('places as p')
      .leftJoin(lastVisit, 'lv.place_id', 'p.id')
      .select(
        'p.*',
        'lv.last_visit_date',
        knex.raw('COALESCE(lv.visit_count, 0) as visit_count')
      );

    // Each filter param is optional — only narrow the query if it was actually passed.
    if (search) {
      const like = `%${search.toLowerCase()}%`;
      query.where((qb) => {
        qb.whereRaw('LOWER(p.name) LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE(p.address, \'\')) LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE(p.category, \'\')) LIKE ?', [like]);
      });
    }
    if (category) query.where('p.category', category);
    if (tier) query.where('p.tier', Number(tier));
    if (city) query.where('p.city', city);
    if (zip) query.where('p.zip', zip);
    if (neverVisited === '1' || neverVisited === 'true') query.whereNull('lv.last_visit_date');

    query.orderBy('p.priority_score', 'desc').orderBy('p.name', 'asc');

    // Pull each place's primary person (or earliest-added, if none marked primary)
    // to show a name/phone/temperature preview in the directory table without
    // requiring a separate request per row.
    const places = await query;
    const ids = places.map((p) => p.id);
    const people = ids.length
      ? await knex('people')
          .whereIn('place_id', ids)
          .where('departed', false)
          .orderBy('is_primary', 'desc')
          .orderBy('id', 'asc')
          .select('place_id', 'name', 'phone', 'email', 'relationship_temp')
      : [];
    // Same "first row per place_id wins" trick used elsewhere: since the query
    // is sorted is_primary desc, the first row seen per place is the right one.
    const personByPlace = {};
    for (const c of people) if (!personByPlace[c.place_id]) personByPlace[c.place_id] = c;

    // Referral totals: same rule as GET /:id — a place's total is the sum of
    // its *current* people's own referral counts, computed here for every
    // place at once (referrals joined to people's live place_id, not the
    // referral's own place_id snapshot) so the directory doesn't need N+1 requests.
    const referralTotals = ids.length
      ? await knex('referrals as r')
          .join('people as pe', 'pe.id', 'r.person_id')
          .whereIn('pe.place_id', ids)
          .groupBy('pe.place_id')
          .select('pe.place_id')
          .count('r.id as count')
      : [];
    const referralTotalByPlace = {};
    for (const row of referralTotals) referralTotalByPlace[row.place_id] = Number(row.count);

    res.json(
      places.map((p) => ({
        ...decorate(p),
        visit_count: Number(p.visit_count) || 0,
        person: personByPlace[p.id] || null,
        referral_total: referralTotalByPlace[p.id] || 0,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/places/meta/filters — distinct values for the search screen's
// filter dropdowns (category/city/zip). Tiers are always just 1/2/3.
router.get('/meta/filters', async (req, res, next) => {
  try {
    const [categories, cities, zips] = await Promise.all([
      knex('places').distinct('category').whereNotNull('category').orderBy('category').pluck('category'),
      knex('places').distinct('city').whereNotNull('city').orderBy('city').pluck('city'),
      knex('places').distinct('zip').whereNotNull('zip').orderBy('zip').pluck('zip'),
    ]);
    res.json({ categories, cities, zips, tiers: [1, 2, 3] });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:id — a place with its full visit history and people.
// NOTE: this route must come after the more specific routes above (/, /meta/filters)
// since Express matches routes top-to-bottom and :id would otherwise swallow them.
router.get('/:id', async (req, res, next) => {
  try {
    const place = await knex('places').where({ id: req.params.id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    const visits = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.place_id', place.id)
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    const people = await knex('people')
      .where({ place_id: place.id })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');

    // A place's referral total is just the sum of its *current* people's own
    // referral counts — not a count keyed off referrals.place_id — so it
    // automatically drops when someone's removed and rises when someone new
    // (who already has referrals on their record) is added.
    const peopleIds = people.map((p) => p.id);
    const referralCounts = peopleIds.length
      ? await knex('referrals').whereIn('person_id', peopleIds).select('person_id').count('* as count').groupBy('person_id')
      : [];
    const countByPerson = {};
    for (const r of referralCounts) countByPerson[r.person_id] = Number(r.count);

    // Suggested relationship temperature: same recency-vs-cadence decay for
    // every person here, since it's judged off this one place's own last
    // completed visit — reuses `visits` (already fetched above) instead of a
    // separate query. Each person's *starting point* still differs, since
    // decay is relative to their own current manual value.
    const lastCompletedVisit = visits.find((v) => v.status === 'completed');
    const daysSinceLastVisit = lastCompletedVisit
      ? dayjs().diff(dayjs(lastCompletedVisit.scheduled_date), 'day')
      : null;

    const peopleWithCounts = people.map((c) => ({
      ...c,
      departed: !!c.departed,
      is_primary: !!c.is_primary,
      referral_count: countByPerson[c.id] || 0,
      suggested_relationship_temp: suggestRelationshipTemp({
        currentTemp: c.relationship_temp,
        tier: place.tier,
        daysSinceLastVisit,
      }),
    }));

    res.json({
      ...decorate(place),
      visits,
      people: peopleWithCounts,
      referral_total: peopleWithCounts.reduce((sum, p) => sum + p.referral_count, 0),
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/places/:id — update a place's own fields (used today for the
// durable, org-level "notes" field on PlaceDetail — separate from any single
// visit's notes or a person's notes).
router.patch('/:id', async (req, res, next) => {
  try {
    const existing = await knex('places').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Place not found' });

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const phoneError = validatePhone(update.phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Tier/region/priority changes need the same derived fields kept in sync
    // as at creation time.
    if (update.tier !== undefined || update.is_priority !== undefined) {
      const t = update.tier !== undefined ? Number(update.tier) : existing.tier;
      const pri = update.is_priority !== undefined ? !!update.is_priority : !!existing.is_priority;
      update.priority_score = priorityScore(t, pri);
    }
    if (update.city !== undefined || update.zip !== undefined) {
      update.region = regionForPlace({
        city: update.city !== undefined ? update.city : existing.city,
        zip: update.zip !== undefined ? update.zip : existing.zip,
      });
    }

    await knex('places').where({ id: req.params.id }).update(update);
    res.json(decorate(await knex('places').where({ id: req.params.id }).first()));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/places/:id — remove only the place itself. People who were here
// are detached, not deleted (place_id -> null, at the DB level via ON DELETE
// SET NULL), and every visit logged here survives the same way (its
// place_name snapshot is what keeps that history readable afterward). This
// is permanent for the place's own details, but not for anyone's history.
router.delete('/:id', async (req, res, next) => {
  try {
    // "Primary contact at this place" stops making sense the moment they're
    // unassigned, so clear it before the place (and the FK's SET NULL) detaches them.
    await knex('people').where({ place_id: req.params.id }).update({ is_primary: false });

    const deleted = await knex('places').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Place not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
