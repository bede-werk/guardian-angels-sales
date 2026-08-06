// Places — the organizations that get visited. This file covers
// creating a place, the searchable/filterable directory list, filter-dropdown
// options, and a single place's full detail (visits + people).
const express = require('express');
const knex = require('../db/knex');
const { priorityLabel, priorityScore, regionForPlace } = require('../services/priority');
const { geocodeAddress } = require('../services/geocoding');
const { validatePhone } = require('../services/phone');
const { referralMetricsByPersonId, referralMetricsByPlaceId, metricsFor, EMPTY_METRICS } = require('../services/referralMetrics');
const { compareDatesAsc } = require('../services/sortHelpers');
const { computeRelationshipForPlaces, relationshipFor, LEVELS: RELATIONSHIP_LEVELS } = require('../services/relationship');
const { attachEncounters } = require('../services/visitEncounters');
const { crossRepVisitsByPlace, attachCrossRepFloorWarnings } = require('../services/crossRepFloorWarning');
const schedulingConfig = require('../config/scheduling');

const router = express.Router();

// Re-sorts the already-decorated (last_visit_date/my_last_visit_date/
// referral_metrics attached) place list per the `sort` query param. Pure (no
// knex) — takes/returns plain arrays, same shape/convention as
// people.js's sortPeople. The default case returns `rows` unchanged,
// preserving the SQL query's own `priority_score desc, name asc` order, so
// "no sort picked" behaves exactly as it always has.
function sortPlaces(rows, sort) {
  switch (sort) {
    case 'last_visited_desc':
      return [...rows].sort((a, b) => -compareDatesAsc(a.last_visit_date, b.last_visit_date));
    case 'last_visited_asc':
      return [...rows].sort((a, b) => compareDatesAsc(a.last_visit_date, b.last_visit_date));
    case 'my_last_visited_desc':
      return [...rows].sort((a, b) => -compareDatesAsc(a.my_last_visit_date, b.my_last_visit_date));
    case 'my_last_visited_asc':
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

// category must match one of the canonical values in the categories table
// (managed via routes/categories.js, add/rename/retire) — empty/null is
// allowed, a place can go uncategorized.
async function categoryError(category) {
  if (category === undefined || category === null || category === '') return null;
  const exists = await knex('categories').where({ name: category }).first();
  if (!exists) return `category must be one of the existing options`;
  return null;
}

// tier is always 1, 2, or 3 — empty/null is allowed on PATCH (no change), but
// anything provided must be one of the three valid numbers.
function tierError(tier) {
  if (tier === undefined || tier === null || tier === '') return null;
  const n = Number(tier);
  if (!Number.isInteger(n) || n < 1 || n > 3) return 'tier must be 1, 2, or 3';
  return null;
}

// Fields a client is allowed to set on an existing place via PATCH. (POST
// below has its own inline handling since it also derives priority_score/region.)
const EDITABLE = ['name', 'category', 'tier', 'is_priority', 'address', 'city', 'state', 'zip', 'phone', 'notes', 'capacity_monthly_referrals', 'capacity_status'];

// capacity_monthly_referrals — "real number captured at pre-qual" (see the
// migration that added it) — is nullable (null clears back to "needs
// pre-qualification") but anything provided must be a non-negative whole
// number (referrals/month, not a fraction).
function capacityMonthlyReferralsError(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return 'capacity_monthly_referrals must be a non-negative whole number';
  return null;
}

// estimated (never pre-qualified — the default) | adjusted (corrected
// directly on the place card, no fresh visit) | verified (set from an actual
// first-visit pre-qualification conversation, see routes/visits.js's PATCH).
const CAPACITY_STATUSES = ['estimated', 'adjusted', 'verified'];

// relationship_level_override is the manual "I know this one, trust me over
// the math" escape hatch on the otherwise-computed relationship level (see
// services/relationship.js). null/'' clears it and returns the place to
// computed control; anything else must be one of the three real levels.
// Deliberately NOT in EDITABLE — it can't be a plain passthrough field
// because setting it also has to stamp who did it and when, which is what
// makes the override visible rather than silently authoritative.
function relationshipOverrideError(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!RELATIONSHIP_LEVELS.includes(v)) return `relationship_level_override must be one of: ${RELATIONSHIP_LEVELS.join(', ')}`;
  return null;
}
function capacityStatusError(v) {
  if (v === undefined) return null;
  if (!CAPACITY_STATUSES.includes(v)) return `capacity_status must be one of: ${CAPACITY_STATUSES.join(', ')}`;
  return null;
}

// POST /api/places — create a place (e.g. from an unmatched note in review,
// or manually from the UI).
router.post('/', async (req, res, next) => {
  try {
    const { name, category, tier, is_priority, address, city, state, zip, phone, confirm_address } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const catError = await categoryError(category);
    if (catError) return res.status(400).json({ error: catError });
    const tErr = tierError(tier);
    if (tErr) return res.status(400).json({ error: tErr });
    const t = tier === undefined || tier === null || tier === '' ? 3 : Number(tier);
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
// Query params: search, category, tier, region, sort (name [default] |
// last_visited_desc | last_visited_asc | my_last_visited_desc |
// my_last_visited_asc | referrals_desc | referrals_asc | last_referral_desc |
// last_referral_asc).
router.get('/', async (req, res, next) => {
  try {
    const { search, category, tier, region, sort } = req.query;

    // Subquery: last *completed* visit per place. A visit that's only planned
    // (on today's route but not yet done) must not count as a real visit.
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .select('place_id')
      .max('scheduled_date as last_visit_date')
      .count('* as visit_count')
      .groupBy('place_id')
      .as('lv');

    // Same, but scoped to only the logged-in rep's own visits — lets
    // "last visited by me" answer "have I personally been here" separately
    // from "has anyone on the team." Same pattern as people.js's myLastVisit.
    const myLastVisit = knex('visits')
      .where('status', 'completed')
      .where('user_id', req.user.id)
      .select('place_id')
      .max('scheduled_date as my_last_visit_date')
      .groupBy('place_id')
      .as('mlv');

    const query = knex('places as p')
      .leftJoin(lastVisit, 'lv.place_id', 'p.id')
      .leftJoin(myLastVisit, 'mlv.place_id', 'p.id')
      .select(
        'p.*',
        'lv.last_visit_date',
        'mlv.my_last_visit_date',
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

    // Relationship: the list only needs the effective level and the raw score
    // (for a badge and for sorting) — never the full object. `contributors`
    // alone would balloon this payload by a row per person per place, and
    // nothing in the directory view renders it.
    const relationshipByPlace = await computeRelationshipForPlaces(knex, ids);

    let decorated = places.map((p) => {
      const rel = relationshipFor(relationshipByPlace, p.id);
      return {
        ...decorate(p),
        visit_count: Number(p.visit_count) || 0,
        person: personByPlace[p.id] || null,
        referral_metrics: metricsFor(metricsByPlace, p.id),
        relationship_level: rel.effective_level,
        relationship_score: rel.score,
      };
    });
    decorated = sortPlaces(decorated, sort);

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

// GET /api/places/check-duplicate?name=...&address=... — dry-run check for
// PlaceModal's pre-save warning, no write. A different concern than
// check-address above (which asks "is this address REAL," via geocoding) —
// this asks "does a place ALREADY ON FILE look like this one," matched
// either by name or by street address (either is enough to flag; an
// existing place at the same address under a different name is just as much
// a duplicate as the same name at a different address). Same loose
// case-insensitive substring match as everywhere else in this app
// ("similar," not exact).
router.get('/check-duplicate', async (req, res, next) => {
  try {
    const { name, address } = req.query;
    if ((!name || name.trim().length < 3) && !address) return res.json([]);
    const rows = await knex('places')
      .where((qb) => {
        if (name && name.trim().length >= 3) qb.orWhereRaw('LOWER(name) LIKE ?', [`%${name.trim().toLowerCase()}%`]);
        if (address) qb.orWhereRaw('LOWER(address) LIKE ?', [`%${address.trim().toLowerCase()}%`]);
      })
      .select('id', 'name')
      .limit(5);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/places/meta/filters — distinct values for the search screen's
// filter dropdowns (category/region), plus the full canonical category list
// (allCategories, the categories table — see routes/categories.js) for the
// create/edit form's picker — deliberately not the same list: `categories`
// only shows values places actually have today (so an empty filter option
// never appears), while `allCategories` includes every category on file even
// one with zero places on it yet. Tiers are always just 1/2/3.
router.get('/meta/filters', async (req, res, next) => {
  try {
    const [categories, allCategories, regions] = await Promise.all([
      knex('places').distinct('category').whereNotNull('category').orderBy('category').pluck('category'),
      knex('categories').orderBy('name').pluck('name'),
      knex('places').distinct('region').whereNotNull('region').orderBy('region').pluck('region'),
    ]);
    res.json({ categories, allCategories, regions, tiers: [1, 2, 3] });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:id — a place with its full visit history and people.
// NOTE: this route must come after the more specific routes above (/, /meta/filters)
// since Express matches routes top-to-bottom and :id would otherwise swallow them.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    // Visit history is for what actually happened — a still-planned or
    // skipped visit doesn't belong here. One row per TRIP: a visit where the
    // rep met three people is one entry with three encounters, not three
    // entries (the grouping the client used to do by hand is now a fact of the
    // schema — see 20260806000000_split_visit_encounters.js).
    const visitRows = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.place_id', place.id)
      .where('v.status', 'completed')
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    // The mirror image of visit history: still-open route-planner-committed
    // visits, soonest first — see the "Upcoming Visits" card in
    // PlaceDetail.jsx. These normally carry NO encounters at all (nobody's
    // been met yet), which is why `encounters` is an empty array here rather
    // than missing.
    const upcomingRows = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.place_id', place.id)
      .where('v.status', 'planned')
      .orderBy('v.scheduled_date', 'asc')
      .orderBy('v.sort_order', 'asc')
      .select('v.*', 'u.name as user_name');

    // One extra query per list, grouped in JS — never one per visit.
    const [visitsWithEncounters, upcomingVisitsWithEncounters] = await Promise.all([
      attachEncounters(knex, visitRows),
      attachEncounters(knex, upcomingRows),
    ]);

    // Cross-rep hard-floor warning (informational only — see
    // crossRepFloorWarning.js): one batched query for this place, applied to
    // both lists so a rep sees it whether they're looking at history or an
    // upcoming stop.
    const crossRepByPlace = await crossRepVisitsByPlace(knex, [place.id]);
    const visits = attachCrossRepFloorWarnings(visitsWithEncounters, crossRepByPlace, schedulingConfig);
    const upcomingVisits = attachCrossRepFloorWarnings(upcomingVisitsWithEncounters, crossRepByPlace, schedulingConfig);

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
    // reads as "none yet", same rule as a person.
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

    // The full relationship object here (unlike the list view): the detail
    // screen is exactly where "why is this place weak?" has to be answerable,
    // which is what contributors/components/last_meaningful_visit are for.
    // includeTrend: true — this is one of only two callers that ever render
    // it (see relationship.js's computeRelationshipForPlaces comment).
    const relationshipByPlace = await computeRelationshipForPlaces(knex, [place.id], { includeTrend: true });

    res.json({
      ...decorate(place),
      visits,
      upcoming_visits: upcomingVisits,
      people: peopleWithMetrics,
      referral_metrics: referralMetrics,
      relationship: relationshipFor(relationshipByPlace, place.id),
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
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const existing = await knex('places').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Place not found' });

    const { confirm_address } = req.body;
    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const phoneError = validatePhone(update.phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const catError = await categoryError(update.category);
    if (catError) return res.status(400).json({ error: catError });
    const tErr = tierError(update.tier);
    if (tErr) return res.status(400).json({ error: tErr });
    const referralsErr = capacityMonthlyReferralsError(update.capacity_monthly_referrals);
    if (referralsErr) return res.status(400).json({ error: referralsErr });
    const statusErr = capacityStatusError(update.capacity_status);
    if (statusErr) return res.status(400).json({ error: statusErr });

    // Relationship override — handled outside EDITABLE because who set it and
    // when are stamped here, server-side, from the bearer token rather than
    // taken from the body. The UI's whole anti-rot contract is that an
    // override is shown next to the computed value with attribution
    // ("Strong — set manually by Bede, Jul 12 — computed: weak"), which only
    // works if that attribution can't be forged or omitted by the client.
    if (req.body.relationship_level_override !== undefined) {
      const overrideErr = relationshipOverrideError(req.body.relationship_level_override);
      if (overrideErr) return res.status(400).json({ error: overrideErr });
      const clearing = req.body.relationship_level_override === null || req.body.relationship_level_override === '';
      // Reverting to computed control clears all three columns together —
      // a stale "set by" on a place with no override would be a lie.
      update.relationship_level_override = clearing ? null : req.body.relationship_level_override;
      update.relationship_override_at = clearing ? null : knex.fn.now();
      update.relationship_override_by = clearing ? null : req.user.id;
    }

    if (update.capacity_monthly_referrals !== undefined) {
      update.capacity_monthly_referrals = update.capacity_monthly_referrals === '' || update.capacity_monthly_referrals === null
        ? null
        : Number(update.capacity_monthly_referrals);
    }

    // Tier/region/priority changes need the same derived fields kept in sync
    // as at creation time. Store the coerced numeric tier (not the raw body
    // value) so it can never diverge from the priority_score derived from it.
    if (update.tier !== undefined || update.is_priority !== undefined) {
      const t = update.tier !== undefined ? Number(update.tier) : existing.tier;
      const pri = update.is_priority !== undefined ? !!update.is_priority : !!existing.is_priority;
      if (update.tier !== undefined) update.tier = t;
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

    await knex('places').where({ id }).update(update);
    res.json(decorate(await knex('places').where({ id }).first()));
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
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const deleted = await knex('places').where({ id }).del();
    if (!deleted) return res.status(404).json({ error: 'Place not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
