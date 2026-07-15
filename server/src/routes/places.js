// Places — the organizations that get visited. This file covers
// creating a place, the searchable/filterable directory list, filter-dropdown
// options, and a single place's full detail (visits + people).
const express = require('express');
const knex = require('../db/knex');
const { priorityLabel, priorityScore, regionForPlace } = require('../services/priority');
const { geocodeAddress } = require('../services/geocoding');
const { validatePhone } = require('../services/phone');
const { referralMetricsByPersonId, referralMetricsByPlaceId, metricsFor, EMPTY_METRICS } = require('../services/referralMetrics');
const CATEGORIES = require('../config/categories');

const router = express.Router();

// category is a fixed enum (config/categories.js), not free text — empty/null
// is allowed (a place can go uncategorized), but anything provided must match
// exactly one of the canonical values.
function categoryError(category) {
  if (category === undefined || category === null || category === '') return null;
  if (!CATEGORIES.includes(category)) return `category must be one of the existing options`;
  return null;
}

// Fields a client is allowed to set on an existing place via PATCH. (POST
// below has its own inline handling since it also derives priority_score/region.)
const EDITABLE = ['name', 'category', 'tier', 'is_priority', 'address', 'city', 'state', 'zip', 'phone', 'notes'];

// POST /api/places — create a place (e.g. from an unmatched note in review,
// or manually from the UI).
router.post('/', async (req, res, next) => {
  try {
    const { name, category, tier, is_priority, address, city, state, zip, phone, confirm_address } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const catError = categoryError(category);
    if (catError) return res.status(400).json({ error: catError });
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
    if (address || city || zip) {
      const coords = await geocodeAddress({ address, city, state: payload.state, zip });
      if (!coords && !confirm_address) {
        return res.status(422).json({
          error: "Address not recognized — double-check it, or save anyway if you're sure.",
          code: 'ADDRESS_UNRECOGNIZED',
        });
      }
      payload.lat = coords ? coords.lat : null;
      payload.lng = coords ? coords.lng : null;
      payload.geocoded_at = knex.fn.now();
    }
    const [row] = await knex('places').insert(payload).returning('id');
    const id = knex.extractId(row);
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
// Query params: search, category, tier, region, neverVisited=1,
// needsAttention=1 (referred before but nothing in the last 90 days).
router.get('/', async (req, res, next) => {
  try {
    const { search, category, tier, region, neverVisited, needsAttention } = req.query;

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
    if (region) query.where('p.region', region);
    if (neverVisited === '1' || neverVisited === 'true') query.whereNull('lv.last_visit_date');

    query.orderBy('p.priority_score', 'desc').orderBy('p.name', 'asc');

    // Pull each place's earliest-added person to show a name/phone preview in
    // the directory table without requiring a separate request per row.
    const places = await query;
    const ids = places.map((p) => p.id);
    const people = ids.length
      ? await knex('people')
          .whereIn('place_id', ids)
          .orderBy('id', 'asc')
          .select('place_id', 'name', 'phone', 'email')
      : [];
    // Same "first row per place_id wins" trick used elsewhere: since the query
    // is sorted by id, the first row seen per place is the earliest-added person.
    const personByPlace = {};
    for (const c of people) if (!personByPlace[c.place_id]) personByPlace[c.place_id] = c;

    // Referral metrics: same rule as GET /:id — a place's numbers are rolled
    // up from its *current* people (referrals joined to people's live
    // place_id, not the referral's own place_id snapshot), computed here for
    // every place at once so the directory doesn't need N+1 requests.
    const metricsByPlace = await referralMetricsByPlaceId(knex, ids);

    let decorated = places.map((p) => ({
      ...decorate(p),
      visit_count: Number(p.visit_count) || 0,
      person: personByPlace[p.id] || null,
      referral_metrics: metricsFor(metricsByPlace, p.id),
    }));
    if (needsAttention === '1' || needsAttention === 'true') {
      decorated = decorated.filter((p) => p.referral_metrics.needs_attention);
    }

    res.json(decorated);
  } catch (err) {
    next(err);
  }
});

// GET /api/places/check-address — dry-run geocode check, no write. Lets the
// client find out *before* save whether an address looks bad, so it can be
// flagged in the same confirmation pop-up as a duplicate-name warning
// instead of only surfacing after the save attempt (see POST/PATCH below,
// which still re-check on write as a safety net).
router.get('/check-address', async (req, res, next) => {
  try {
    const { address, city, state, zip } = req.query;
    if (!address && !city && !zip) return res.json({ recognized: true });
    const coords = await geocodeAddress({ address, city, state: state || 'NE', zip });
    res.json({ recognized: !!coords });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/meta/filters — distinct values for the search screen's
// filter dropdowns (category/region), plus the full canonical category enum
// (allCategories, config/categories.js) for the create/edit form's picker —
// deliberately not the same list: `categories` only shows values places
// actually have today (so an empty filter option never appears), while
// `allCategories` includes every valid choice even one with zero places on
// it yet. Tiers are always just 1/2/3.
router.get('/meta/filters', async (req, res, next) => {
  try {
    const [categories, regions] = await Promise.all([
      knex('places').distinct('category').whereNotNull('category').orderBy('category').pluck('category'),
      knex('places').distinct('region').whereNotNull('region').orderBy('region').pluck('region'),
    ]);
    res.json({ categories, allCategories: CATEGORIES, regions, tiers: [1, 2, 3] });
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

    // Visit history is for what actually happened — a still-planned or
    // skipped visit doesn't belong here.
    const visits = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.place_id', place.id)
      .where('v.status', 'completed')
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    const people = await knex('people')
      .where({ place_id: place.id })
      .orderBy('name', 'asc');

    // A place's referral metrics are just the roll-up of its *current*
    // people's own metrics — not keyed off referrals.place_id — so they
    // automatically drop when someone's removed and rise when someone new
    // (who already has referrals on their record) is added.
    const peopleIds = people.map((p) => p.id);
    const metricsByPerson = await referralMetricsByPersonId(knex, peopleIds);

    const peopleWithMetrics = people.map((c) => ({
      ...c,
      referral_metrics: metricsFor(metricsByPerson, c.id),
    }));

    // Sum lifetime and last-90-days across people; last_referral_date is
    // whichever person's is most recent. A place with no referrals at all
    // reads as "none yet" (needs_attention stays false), same rule as a person.
    const referralMetrics = peopleWithMetrics.reduce(
      (acc, p) => ({
        lifetime_referrals: acc.lifetime_referrals + p.referral_metrics.lifetime_referrals,
        referrals_last_90_days: acc.referrals_last_90_days + p.referral_metrics.referrals_last_90_days,
        last_referral_date:
          p.referral_metrics.last_referral_date &&
          (!acc.last_referral_date || p.referral_metrics.last_referral_date > acc.last_referral_date)
            ? p.referral_metrics.last_referral_date
            : acc.last_referral_date,
      }),
      { ...EMPTY_METRICS }
    );
    referralMetrics.needs_attention = referralMetrics.lifetime_referrals > 0 && referralMetrics.referrals_last_90_days === 0;

    res.json({
      ...decorate(place),
      visits,
      people: peopleWithMetrics,
      referral_metrics: referralMetrics,
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

    const { confirm_address } = req.body;
    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const phoneError = validatePhone(update.phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const catError = categoryError(update.category);
    if (catError) return res.status(400).json({ error: catError });

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
    if (
      update.address !== undefined ||
      update.city !== undefined ||
      update.state !== undefined ||
      update.zip !== undefined
    ) {
      const coords = await geocodeAddress({
        address: update.address !== undefined ? update.address : existing.address,
        city: update.city !== undefined ? update.city : existing.city,
        state: update.state !== undefined ? update.state : existing.state,
        zip: update.zip !== undefined ? update.zip : existing.zip,
      });
      if (!coords && !confirm_address) {
        return res.status(422).json({
          error: "Address not recognized — double-check it, or save anyway if you're sure.",
          code: 'ADDRESS_UNRECOGNIZED',
        });
      }
      update.lat = coords ? coords.lat : null;
      update.lng = coords ? coords.lng : null;
      update.geocoded_at = knex.fn.now();
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
    const deleted = await knex('places').where({ id: req.params.id }).del();
    if (!deleted) return res.status(404).json({ error: 'Place not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
