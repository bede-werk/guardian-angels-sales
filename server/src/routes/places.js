// Places — the organizations that get visited. This file covers
// creating a place, the searchable/filterable directory list, filter-dropdown
// options, and a single place's full detail (visits + contacts).
const express = require('express');
const knex = require('../db/knex');
const { priorityLabel, priorityScore, regionForPlace } = require('../services/priority');

const router = express.Router();

// POST /api/places — create a place (e.g. from an unmatched note in review,
// or manually from the UI).
router.post('/', async (req, res, next) => {
  try {
    const { name, category, tier, is_priority, address, city, state, zip } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
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

    // Pull each place's primary contact (or earliest-added, if none marked primary)
    // to show a name/phone/temperature preview in the directory table without
    // requiring a separate request per row.
    const places = await query;
    const ids = places.map((p) => p.id);
    const contacts = ids.length
      ? await knex('contacts')
          .whereIn('place_id', ids)
          .where('departed', false)
          .orderBy('is_primary', 'desc')
          .orderBy('id', 'asc')
          .select('place_id', 'name', 'phone', 'email', 'relationship_temp')
      : [];
    // Same "first row per place_id wins" trick used elsewhere: since the query
    // is sorted is_primary desc, the first row seen per place is the right one.
    const contactByPlace = {};
    for (const c of contacts) if (!contactByPlace[c.place_id]) contactByPlace[c.place_id] = c;

    res.json(
      places.map((p) => ({
        ...decorate(p),
        visit_count: Number(p.visit_count) || 0,
        contact: contactByPlace[p.id] || null,
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

// GET /api/places/:id — a place with its full visit history and contacts.
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

    const contacts = await knex('contacts')
      .where({ place_id: place.id })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');

    res.json({
      ...decorate(place),
      visits,
      contacts: contacts.map((c) => ({ ...c, departed: !!c.departed, is_primary: !!c.is_primary })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
