const express = require('express');
const knex = require('../db/knex');
const { priorityLabel, priorityScore, regionForPartner } = require('../services/priority');

const router = express.Router();

// POST /api/partners — create a partner (e.g. from an unmatched note in review).
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
      priority_score: priorityScore(t, pri),
      address: address || null,
      city: city || null,
      state: state || 'NE',
      zip: zip || null,
      region: regionForPartner({ city, zip }),
    };
    const [row] = await knex('partners').insert(payload).returning('id');
    const id = row && row.id ? row.id : row;
    const partner = await knex('partners').where({ id }).first();
    res.status(201).json(partner);
  } catch (err) {
    next(err);
  }
});

// Attach a human-friendly priority label to a partner row.
function decorate(p) {
  return { ...p, is_priority: !!p.is_priority, priority_label: priorityLabel(p.tier, !!p.is_priority) };
}

// GET /api/partners — searchable / filterable list with last-visit + contact info.
// Query params: search, category, tier, city, zip, neverVisited=1
router.get('/', async (req, res, next) => {
  try {
    const { search, category, tier, city, zip, neverVisited } = req.query;

    // Subquery: last *completed* visit per partner. A visit that's only planned
    // (on today's route but not yet done) must not count as a real visit.
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .select('partner_id')
      .max('scheduled_date as last_visit_date')
      .count('* as visit_count')
      .groupBy('partner_id')
      .as('lv');

    const query = knex('partners as p')
      .leftJoin(lastVisit, 'lv.partner_id', 'p.id')
      .select(
        'p.*',
        'lv.last_visit_date',
        knex.raw('COALESCE(lv.visit_count, 0) as visit_count')
      );

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

    // Pull each partner's primary contact (or earliest-added, if none marked primary).
    const partners = await query;
    const ids = partners.map((p) => p.id);
    const contacts = ids.length
      ? await knex('contacts')
          .whereIn('partner_id', ids)
          .where('departed', false)
          .orderBy('is_primary', 'desc')
          .orderBy('id', 'asc')
          .select('partner_id', 'name', 'phone', 'email', 'relationship_temp')
      : [];
    const contactByPartner = {};
    for (const c of contacts) if (!contactByPartner[c.partner_id]) contactByPartner[c.partner_id] = c;

    res.json(
      partners.map((p) => ({
        ...decorate(p),
        visit_count: Number(p.visit_count) || 0,
        contact: contactByPartner[p.id] || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// GET /api/partners/meta/filters — distinct values for filter dropdowns.
router.get('/meta/filters', async (req, res, next) => {
  try {
    const [categories, cities, zips] = await Promise.all([
      knex('partners').distinct('category').whereNotNull('category').orderBy('category').pluck('category'),
      knex('partners').distinct('city').whereNotNull('city').orderBy('city').pluck('city'),
      knex('partners').distinct('zip').whereNotNull('zip').orderBy('zip').pluck('zip'),
    ]);
    res.json({ categories, cities, zips, tiers: [1, 2, 3] });
  } catch (err) {
    next(err);
  }
});

// GET /api/partners/:id — a partner with its full visit history.
router.get('/:id', async (req, res, next) => {
  try {
    const partner = await knex('partners').where({ id: req.params.id }).first();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const visits = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.partner_id', partner.id)
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    const contacts = await knex('contacts')
      .where({ partner_id: partner.id })
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc');

    res.json({
      ...decorate(partner),
      visits,
      contacts: contacts.map((c) => ({ ...c, departed: !!c.departed, is_primary: !!c.is_primary })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
