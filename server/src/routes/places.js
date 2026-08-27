// Places - the organizations that get visited. This file covers
// creating a place, the searchable/filterable directory list, filter-dropdown
// options, and a single place's full detail (visits + people).
const express = require('express');
const knex = require('../db/knex');
const { regionForPlace } = require('../services/priority');
const { geocodeAddress } = require('../services/geocoding');
const { validatePhone } = require('../services/phone');
const { referralMetricsByPersonId, referralMetricsByPlaceId, metricsFor, EMPTY_METRICS } = require('../services/referralMetrics');
const { compareDatesAsc } = require('../services/sortHelpers');
const { computeRelationshipForPlaces, relationshipFor, LEVELS: RELATIONSHIP_LEVELS } = require('../services/relationship');
const { attachEncounters } = require('../services/visitEncounters');
const { crossRepVisitsByPlace, attachCrossRepFloorWarnings } = require('../services/crossRepFloorWarning');
const { computeCapacityForPlace, computeCapacityForPlaces, stampExplorationEligibility, latestObservationsByPlace } = require('../services/capacity');
const { orgToday } = require('../services/orgDate');
const { skipSweepMiddleware } = require('../services/visitLifecycle');
const { createCommitment, rescheduleCommitment, waiveCommitment, deleteCommitment, attachCommitmentsMade } = require('../services/placeCommitments');
const { onPlaceGeocoded } = require('../services/backfillQueue');
const schedulingConfig = require('../config/scheduling');

// The three real capacity buckets - same list capacity.js's own
// bucketForMonthlyReferrals resolves into, used here only to validate
// capacity_override_level (the level is a human's direct bucket choice, not
// a number to be bucketed).
const CAPACITY_LEVELS = ['high', 'medium', 'low'];

const router = express.Router();
router.use(skipSweepMiddleware(knex));

// Re-sorts the already-decorated (last_visit_date/my_last_visit_date/
// referral_metrics attached) place list per the `sort` query param. Pure (no
// knex) - takes/returns plain arrays, same shape/convention as
// people.js's sortPeople. The default case returns `rows` unchanged,
// preserving the SQL query's own `capacity_seed desc, name asc` order, so
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
// (managed via routes/categories.js, add/rename/retire) - empty/null is
// allowed, a place can go uncategorized.
async function categoryError(category) {
  if (category === undefined || category === null || category === '') return null;
  const exists = await knex('categories').where({ name: category }).first();
  if (!exists) return `category must be one of the existing options`;
  return null;
}

// The human capacity rating, in referrals/month (see migration
// 20260823000000). Validated against the CURRENT set of rating choices rather
// than a hardcoded list, since those four numbers are Settings-editable - read
// at call time, never destructured at require time, or an override is silently
// ignored (SETTINGS_PAGE.md's one rule).
//
// null/'' is meaningful and allowed: it clears the rating back to "no read
// given," which drops the place to the category guess exactly as it behaved
// before this rung existed.
function capacitySeedError(seed) {
  if (seed === undefined || seed === null || seed === '') return null;
  const n = Number(seed);
  const allowed = Object.values(schedulingConfig.CAPACITY_SEED_VALUES);
  if (!Number.isInteger(n) || !allowed.includes(n)) {
    return `capacity_seed must be one of the rating choices (${allowed.join(', ')})`;
  }
  return null;
}

// null/'' is the "indefinite" case (or "not marked", when do_not_visit
// itself is false) - anything else must be a real YYYY-MM-DD date.
function doNotVisitUntilError(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'do_not_visit_until must be in YYYY-MM-DD format';
  return null;
}

// Fields a client is allowed to set on an existing place via PATCH. (POST
// below has its own inline handling since it also derives region and stamps
// capacity_seeded_at/exploration_eligible_since.)
//
// Setting a place's declared capacity happens via POST
// /:id/capacity-observations below, which APPENDS to capacity_observations -
// see that route's own comment for why an append-only log replaced a single
// frozen number. (capacity_monthly_referrals/capacity_status used to be
// called out as deliberately absent from this list; both columns were dropped
// in 20260825000000, so there is nothing left to exclude.)
// do_not_visit was previously a schema field with no write path anywhere in
// the app (only ever read, by schedulingEngine.js's eligibility() guard) -
// added here now because capacity-computation-spec.md §4/§11 gives it its
// first real UI entry point: a dismissible "this place reports no winnable
// referrals" suggestion on a zero-capacity place. Plain boolean, no
// validation beyond the truthy coercion PATCH already does everywhere else.
//
// do_not_visit_until (added 2026-08-10) is do_not_visit's own "until" date,
// same shape/convention as places.snooze_until - the client always writes
// the pair together (see PlaceDetail.jsx's setDoNotVisit/liftDoNotVisit), so
// a stale until date left over from a lapsed mark can never silently limit
// a fresh one.
//
// tier/is_priority were REMOVED from this list 2026-08-23, replaced by
// capacity_seed - the same judgment, in the unit it was always really
// expressing (referrals/month), now feeding the capacity axis instead of a
// tie-break. Both columns were dropped outright in 20260825000000. See
// services/priority.js's header for the full reasoning.
//
// is_all_star (2026-08-24) is a plain boolean passthrough - the soft target in
// config/scheduling.js's ALL_STAR_TARGET is surfaced to the client as a live
// count (see /meta/filters below) and warned about there, deliberately NOT
// enforced here. Bede's call: past the target it warns and lets it through.
const EDITABLE = ['name', 'category', 'capacity_seed', 'is_all_star', 'address', 'city', 'state', 'zip', 'phone', 'notes', 'do_not_visit', 'do_not_visit_until'];

// relationship_level_override is the manual "I know this one, trust me over
// the math" escape hatch on the otherwise-computed relationship level (see
// services/relationship.js). null/'' clears it and returns the place to
// computed control; anything else must be one of the three real levels.
// Deliberately NOT in EDITABLE - it can't be a plain passthrough field
// because setting it also has to stamp who did it and when, which is what
// makes the override visible rather than silently authoritative.
function relationshipOverrideError(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!RELATIONSHIP_LEVELS.includes(v)) return `relationship_level_override must be one of: ${RELATIONSHIP_LEVELS.join(', ')}`;
  return null;
}

// capacity_override_level - same "I know this one, trust me over the math"
// escape hatch as relationship_level_override, mirrored exactly (see
// 20260807000001_add_place_capacity_override.js's own header for why this
// one carries a free-text reason instead of a `_by` user id). null/''
// clears it back to computed control; anything else must be one of the
// three real capacity levels - it's a direct bucket choice, not a number to
// be re-bucketed.
function capacityOverrideLevelError(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!CAPACITY_LEVELS.includes(v)) return `capacity_override_level must be one of: ${CAPACITY_LEVELS.join(', ')}`;
  return null;
}

// promised_date is required on create/reschedule (unlike do_not_visit_until's
// null-means-indefinite) - a commitment with no date isn't a commitment.
function commitmentDateError(v) {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'promised_date is required and must be in YYYY-MM-DD format';
  return null;
}

// person_id is optional (a commitment can be place-level with nobody named),
// but if given it must resolve to a real person - same "look it up, error if
// missing" pattern routes/visits.js's encounter validation uses.
async function commitmentPersonIdError(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return 'person_id must be a number';
  const exists = await knex('people').where({ id: n }).first('id');
  if (!exists) return 'person not found';
  return null;
}

// Re-fetches a commitment joined to its person/creator names - used to
// decorate the single row returned by create/reschedule/waive below, same
// shape as the joined list GET /:id bundles into `commitments`.
function loadCommitment(id) {
  return knex('place_commitments as pc')
    .leftJoin('people as pe', 'pe.id', 'pc.person_id')
    .leftJoin('users as u', 'u.id', 'pc.created_by_user_id')
    .where('pc.id', id)
    .select('pc.*', 'pe.name as person_name', 'u.name as created_by_name')
    .first();
}

// The number a place-card or pre-qual answer declares - validated here
// because it's shared by both write paths onto capacity_observations (this
// file's POST /:id/capacity-observations below, and routes/visits.js's
// first-visit capture) rather than duplicated in each.
function monthlyReferralsError(v) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isInteger(n) || n < 0) {
    return 'monthly_referrals must be a non-negative whole number';
  }
  return null;
}

// POST /api/places - create a place (e.g. from an unmatched note in review,
// or manually from the UI).
router.post('/', async (req, res, next) => {
  try {
    const { name, category, capacity_seed, is_all_star, address, city, state, zip, phone, confirm_address } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const catError = await categoryError(category);
    if (catError) return res.status(400).json({ error: catError });
    const seedErr = capacitySeedError(capacity_seed);
    if (seedErr) return res.status(400).json({ error: seedErr });
    // An omitted rating stays NULL rather than defaulting to the lowest
    // choice: "nobody has rated this yet" and "somebody looked and said it
    // barely sends anything" are different claims, and only the first should
    // fall through to the category guess. The old tier field defaulted to 3
    // here, which is exactly how 147 places came to assert a judgment nobody
    // had actually made.
    const rated = !(capacity_seed === undefined || capacity_seed === null || capacity_seed === '');
    const payload = {
      name: String(name).trim(),
      category: category || null,
      capacity_seed: rated ? Number(capacity_seed) : null,
      capacity_seeded_at: rated ? orgToday() : null,
      is_all_star: !!is_all_star,
      address: address || null,
      city: city || null,
      state: state || 'NE',
      zip: zip || null,
      phone: phone || null,
      region: regionForPlace({ city, zip }),
      // Never pre-qualified yet - eligible for EXPLORATION from day one. See
      // the migration that added this column for why it's stamped
      // explicitly here rather than left to a schema-level default.
      exploration_eligible_since: orgToday(),
    };
    let coords = null;
    if (address || city || zip) {
      coords = await geocodeAddress({ address, city, state: payload.state, zip });
      if (!coords && !confirm_address) {
        return res.status(422).json({
          error: "Address not recognized - double-check it, or save anyway if you're sure.",
          code: 'ADDRESS_UNRECOGNIZED',
        });
      }
      payload.lat = coords ? coords.lat : null;
      payload.lng = coords ? coords.lng : null;
      payload.geocoded_at = knex.fn.now();
    }
    const [row] = await knex('places').insert(payload).returning('id');
    const id = knex.extractId(row);
    // A brand-new place has nothing cached yet, so there's nothing to
    // invalidate - only queue a backfill, and only when there's a real
    // coordinate to compute from.
    if (coords) await onPlaceGeocoded(knex, id, coords);
    const place = await knex('places').where({ id }).first();
    res.status(201).json(place);
  } catch (err) {
    next(err);
  }
});

// (There used to be a `decorate(p)` here. It attached a `priority_label`
// ("Tier 1", "Priority · Tier 1") that nothing in the client ever read, and
// coerced places.is_priority from SQLite's 0/1 into a real boolean. Both
// fields were retired 2026-08-23 - see services/priority.js's header - which
// left the function spreading its argument and nothing else, so it's gone
// and its four call sites spread the row directly.)

// GET /api/places - searchable / filterable list with last-visit + contact info.
// Query params: search, category, tier, region, sort (name [default] |
// last_visited_desc | last_visited_asc | my_last_visited_desc |
// my_last_visited_asc | referrals_desc | referrals_asc | last_referral_desc |
// last_referral_asc).
router.get('/', async (req, res, next) => {
  try {
    const { search, category, capacity, allStar, unrated, region, sort } = req.query;

    // Subquery: last *completed* visit per place. A visit that's only planned
    // (on today's route but not yet done) must not count as a real visit.
    const lastVisit = knex('visits')
      .where('status', 'completed')
      .select('place_id')
      .max('scheduled_date as last_visit_date')
      .count('* as visit_count')
      .groupBy('place_id')
      .as('lv');

    // Same, but scoped to only the logged-in rep's own visits - lets
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

    // Each filter param is optional - only narrow the query if it was actually passed.
    if (search) {
      const like = `%${search.toLowerCase()}%`;
      query.where((qb) => {
        qb.whereRaw('LOWER(p.name) LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE(p.address, \'\')) LIKE ?', [like])
          .orWhereRaw('LOWER(COALESCE(p.category, \'\')) LIKE ?', [like]);
      });
    }
    if (category) query.where('p.category', category);
    if (region) query.where('p.region', region);
    // The rating-review queue: places still carrying the tier backfill that
    // nobody has explicitly confirmed. A NULL capacity_seeded_at is the
    // marker - see the PATCH handler, which stamps it even when a rep
    // re-confirms the same value.
    if (unrated === '1') query.whereNull('p.capacity_seeded_at');
    // Its own param rather than a fourth value on `capacity`: an all-star is
    // orthogonal to the level, not another level (a low-capacity all-star is
    // the whole point of the flag). The Places filter bar folds both into one
    // dropdown for the user - see Places.jsx - but they stay separate here.
    if (allStar === '1') query.where('p.is_all_star', true);

    // capacity_seed, not priority_score - see services/priority.js's header.
    // Descending puts the biggest referral sources at the top of the
    // directory, which is what the old priority_score sort was really for.
    // NULLs (unrated) sort last under both SQLite and Postgres only if we say
    // so explicitly, hence the COALESCE rather than a bare orderBy.
    query.orderByRaw('COALESCE(p.capacity_seed, -1) desc').orderBy('p.name', 'asc');

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

    // Referral metrics: same rule as GET /:id - a place's numbers are rolled
    // up from its *current* people (referrals joined to people's live
    // place_id, not the referral's own place_id snapshot), computed here for
    // every place at once so the directory doesn't need N+1 requests.
    const metricsByPlace = await referralMetricsByPlaceId(knex, ids);

    // Relationship: the list only needs the effective level and the raw score
    // (for a badge and for sorting) - never the full object. `contributors`
    // alone would balloon this payload by a row per person per place, and
    // nothing in the directory view renders it.
    const relationshipByPlace = await computeRelationshipForPlaces(knex, ids);

    // Capacity: same bulk-once pattern as relationship above (three queries
    // regardless of row count), and the same trimmed shape - the list gets
    // `capacity_level`, the detail route gets the full `capacity` object,
    // exactly as relationship_level/relationship already split.
    //
    // The `capacity` filter below can only be applied HERE, not in SQL: the
    // level is resolved from an observation log, a measured referral rate and
    // the rating, so there is no column to put in a WHERE clause.
    //
    // `capacity_level` here is the COMPUTED level, not a column - the
    // places.capacity_level column (the 2026-07-12 keyword seed) was dropped
    // in 20260825000000, so `...p` no longer carries anything by that name
    // and this line is its only source. Same shape as relationship_level
    // just below it.
    const capacityByPlace = await computeCapacityForPlaces(knex, ids);

    let decorated = places.map((p) => {
      const rel = relationshipFor(relationshipByPlace, p.id);
      const cap = capacityByPlace.get(p.id);
      return {
        ...p,
        visit_count: Number(p.visit_count) || 0,
        person: personByPlace[p.id] || null,
        referral_metrics: metricsFor(metricsByPlace, p.id),
        relationship_level: rel.effective_level,
        relationship_score: rel.score,
        capacity_level: cap ? cap.level : null,
        capacity_level_source: cap ? cap.levelSource : null,
      };
    });
    if (capacity) decorated = decorated.filter((p) => p.capacity_level === capacity);
    decorated = sortPlaces(decorated, sort);

    res.json(decorated);
  } catch (err) {
    next(err);
  }
});

// GET /api/places/check-address - dry-run geocode check, no write. Lets the
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

// GET /api/places/check-duplicate?name=...&address=... - dry-run check for
// PlaceModal's pre-save warning, no write. A different concern than
// check-address above (which asks "is this address REAL," via geocoding) -
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

// POST /api/places/rate-capacity - the rating screen's bulk save. Mirrors
// routes/people.js's /people/seed-relationships exactly: validate everything
// first, then apply in one transaction, because a half-applied rating pass is
// worse than none - there'd be no way to tell which half landed.
//
// A null/'' seed CLEARS a place's rating (back to the category guess) rather
// than being rejected, same as the single-place PATCH. Each entry may carry
// `seed`, `is_all_star`, or both; an absent key leaves that field untouched,
// so starring a place doesn't silently re-stamp its rating date.
//
// Re-runnable by design. Re-rating a place overwrites its value and re-stamps
// capacity_seeded_at, and re-confirming the SAME value still re-stamps it:
// the date records that a human looked, and "looked and agreed" is a real
// answer - it's what moves a place out of the unrated review queue.
router.post('/rate-capacity', async (req, res, next) => {
  try {
    const entries = req.body;
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'body must be an array of { place_id, seed }' });
    if (!entries.length) return res.json({ updated: 0 });

    const writes = [];
    for (const entry of entries) {
      const placeId = Number(entry?.place_id);
      if (!Number.isInteger(placeId)) return res.status(400).json({ error: 'each entry needs a numeric place_id' });

      // An entry may carry either field, or both - the rating screen lets a
      // rep star a place without re-rating it, and vice versa. An ABSENT key
      // means "leave this one alone", which is why each field is built into
      // the update object conditionally rather than defaulted.
      const update = {};
      if ('seed' in entry) {
        const seedErr = capacitySeedError(entry.seed);
        if (seedErr) return res.status(400).json({ error: `place ${placeId}: ${seedErr}` });
        const clearing = entry.seed === null || entry.seed === undefined || entry.seed === '';
        update.capacity_seed = clearing ? null : Number(entry.seed);
        update.capacity_seeded_at = clearing ? null : orgToday();
      }
      if ('is_all_star' in entry) update.is_all_star = !!entry.is_all_star;

      if (!Object.keys(update).length) {
        return res.status(400).json({ error: `place ${placeId}: entry changes nothing - send seed, is_all_star, or both` });
      }
      writes.push({ id: placeId, update });
    }

    const ids = writes.map((w) => w.id);
    const found = await knex('places').whereIn('id', ids).select('id');
    if (found.length !== new Set(ids).size) {
      return res.status(400).json({ error: 'one or more places not found' });
    }

    await knex.transaction(async (trx) => {
      for (const w of writes) {
        await trx('places').where({ id: w.id }).update({ ...w.update, updated_at: trx.fn.now() });
      }
    });

    res.json({ updated: writes.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/meta/filters - distinct values for the search screen's
// filter dropdowns (category/region), plus the full canonical category list
// (allCategories, the categories table - see routes/categories.js) for the
// create/edit form's picker - deliberately not the same list: `categories`
// only shows values places actually have today (so an empty filter option
// never appears), while `allCategories` includes every category on file even
// one with zero places on it yet.
//
// `capacityLevels` replaced `tiers: [1, 2, 3]` on 2026-08-23. It's a fixed
// list rather than a DISTINCT over the table for the same reason tiers was:
// the three levels always exist as filter options even if no place currently
// resolves to one of them. `seedChoices` gives the rating UI its four options
// and their current values, read at call time so a Settings override is
// picked up (SETTINGS_PAGE.md's one rule), alongside the thresholds each
// choice is measured against - that pairing is what lets the rating screen
// show which bucket a choice lands in instead of hardcoding it.
router.get('/meta/filters', async (req, res, next) => {
  try {
    const [categories, allCategories, regions, allStarRow] = await Promise.all([
      knex('places').distinct('category').whereNotNull('category').orderBy('category').pluck('category'),
      knex('categories').orderBy('name').pluck('name'),
      knex('places').distinct('region').whereNotNull('region').orderBy('region').pluck('region'),
      knex('places').where({ is_all_star: true }).count({ n: '*' }).first(),
    ]);
    res.json({
      categories,
      allCategories,
      regions,
      capacityLevels: CAPACITY_LEVELS,
      seedChoices: schedulingConfig.CAPACITY_SEED_VALUES,
      capacityThresholds: schedulingConfig.CAPACITY_THRESHOLDS,
      // The all-star scarcity pair. The count is what keeps this flag from
      // drifting into meaninglessness the way ⭐ Priority did - it has to be
      // visible wherever the flag is set, so it ships alongside the target
      // rather than being something each screen counts for itself.
      allStarCount: Number(allStarRow.n) || 0,
      allStarTarget: schedulingConfig.ALL_STAR_TARGET,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/places/:id - a place with its full visit history and people.
// NOTE: this route must come after the more specific routes above (/, /meta/filters)
// since Express matches routes top-to-bottom and :id would otherwise swallow them.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    // Visit history is everything that's resolved one way or another - a
    // still-planned visit doesn't belong here, but a skipped one does: it's
    // shown as a past row tagged "Skipped" (PlaceDetail.jsx) rather than
    // hidden behind a separate rollup. One row per TRIP: a visit where the
    // rep met three people is one entry with three encounters, not three
    // entries (the grouping the client used to do by hand is now a fact of the
    // schema - see 20260806000000_split_visit_encounters.js).
    const visitRows = await knex('visits as v')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .where('v.place_id', place.id)
      .whereIn('v.status', ['completed', 'skipped'])
      .orderBy('v.scheduled_date', 'desc')
      .orderBy('v.id', 'desc')
      .select('v.*', 'u.name as user_name');

    // The mirror image of visit history: still-open route-planner-committed
    // visits, soonest first - see the "Upcoming Visits" card in
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

    // One extra query per list, grouped in JS - never one per visit.
    const [visitsWithEncounters, upcomingVisitsWithEncounters] = await Promise.all([
      attachEncounters(knex, visitRows),
      attachEncounters(knex, upcomingRows),
    ]);

    // "The promise made during this trip" (Place Commitments spec §6.3) -
    // completed history only. An upcoming (still-planned) visit can't have
    // made a promise yet; that only happens when it's logged, via
    // VisitLogModal's promise_next_visit field.
    const visitsWithCommitments = await attachCommitmentsMade(knex, visitsWithEncounters);

    // Cross-rep hard-floor warning (informational only - see
    // crossRepFloorWarning.js): one batched query for this place, applied to
    // both lists so a rep sees it whether they're looking at history or an
    // upcoming stop.
    const crossRepByPlace = await crossRepVisitsByPlace(knex, [place.id]);
    const visits = attachCrossRepFloorWarnings(visitsWithCommitments, crossRepByPlace, schedulingConfig);
    const upcomingVisits = attachCrossRepFloorWarnings(upcomingVisitsWithEncounters, crossRepByPlace, schedulingConfig);

    const people = await knex('people')
      .where({ place_id: place.id })
      .orderBy('name', 'asc');

    // A place's referral metrics are just the roll-up of its *current*
    // people's own metrics - not keyed off referrals.place_id - so they
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
    // includeTrend: true - this is one of only two callers that ever render
    // it (see relationship.js's computeRelationshipForPlaces comment).
    const relationshipByPlace = await computeRelationshipForPlaces(knex, [place.id], { includeTrend: true });

    // Same "full object on the detail screen" reasoning as relationship
    // above - capacity-computation-spec.md §11 needs the whole thing
    // (contributors, confidence, staleAt) to explain the number, not just a
    // bucket. capacity_observations: the append-only history itself, newest
    // first, left-joined to the person who answered (nullable - see that
    // migration's header) so the UI can say "verified by Sharon, who no
    // longer works here" even after Sharon's own record is gone.
    const [capacity, capacityObservations] = await Promise.all([
      computeCapacityForPlace(knex, place.id, { asOf: orgToday() }),
      knex('capacity_observations as co')
        .leftJoin('people as pe', 'pe.id', 'co.person_id')
        .where('co.place_id', place.id)
        .orderBy('co.observed_at', 'desc')
        .orderBy('co.id', 'desc')
        .select('co.*', 'pe.name as person_name'),
    ]);

    // Place Commitments (services/placeCommitments.js) - every commitment on
    // file for this place, split outstanding/discharged. Small per-place
    // dataset (commitments are rare, dated promises, not routine data), so
    // both halves are always fetched together rather than the discharged
    // half needing its own request when PlaceDetail's history toggle opens.
    // Bundled here (not a separate GET /:id/commitments route) so
    // VisitLogModal's existing api.place() fetch picks it up for free too -
    // see that modal's own "load the place itself" effect.
    const commitmentRows = await knex('place_commitments as pc')
      .leftJoin('people as pe', 'pe.id', 'pc.person_id')
      .leftJoin('users as u', 'u.id', 'pc.created_by_user_id')
      .where('pc.place_id', place.id)
      .orderBy('pc.promised_date', 'asc')
      .orderBy('pc.id', 'asc')
      .select('pc.*', 'pe.name as person_name', 'u.name as created_by_name');

    res.json({
      ...place,
      visits,
      upcoming_visits: upcomingVisits,
      people: peopleWithMetrics,
      referral_metrics: referralMetrics,
      relationship: relationshipFor(relationshipByPlace, place.id),
      capacity,
      capacity_observations: capacityObservations,
      commitments: {
        outstanding: commitmentRows.filter((r) => !r.discharged_at),
        // Most-recently-resolved first - a history list reads newest-first,
        // unlike the outstanding list above (soonest-due-first).
        discharged: commitmentRows.filter((r) => r.discharged_at).sort((a, b) => (a.discharged_at < b.discharged_at ? 1 : -1)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/places/:id - update a place's own fields (used today for the
// durable, org-level "notes" field on PlaceDetail - separate from any single
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
    const seedErr = capacitySeedError(update.capacity_seed);
    if (seedErr) return res.status(400).json({ error: seedErr });
    const dnvErr = doNotVisitUntilError(update.do_not_visit_until);
    if (dnvErr) return res.status(400).json({ error: dnvErr });

    // Relationship override - handled outside EDITABLE because who set it and
    // when are stamped here, server-side, from the bearer token rather than
    // taken from the body. The UI's whole anti-rot contract is that an
    // override is shown next to the computed value with attribution
    // ("Strong - set manually by Bede, Jul 12 - computed: weak"), which only
    // works if that attribution can't be forged or omitted by the client.
    if (req.body.relationship_level_override !== undefined) {
      const overrideErr = relationshipOverrideError(req.body.relationship_level_override);
      if (overrideErr) return res.status(400).json({ error: overrideErr });
      const clearing = req.body.relationship_level_override === null || req.body.relationship_level_override === '';
      // Reverting to computed control clears all three columns together -
      // a stale "set by" on a place with no override would be a lie.
      update.relationship_level_override = clearing ? null : req.body.relationship_level_override;
      update.relationship_override_at = clearing ? null : knex.fn.now();
      update.relationship_override_by = clearing ? null : req.user.id;
    }

    // Capacity override - same pattern, one field lighter (a free-text
    // reason instead of a `_by` user id; see capacityOverrideLevelError's
    // own comment for why).
    if (req.body.capacity_override_level !== undefined) {
      const overrideErr = capacityOverrideLevelError(req.body.capacity_override_level);
      if (overrideErr) return res.status(400).json({ error: overrideErr });
      const clearing = req.body.capacity_override_level === null || req.body.capacity_override_level === '';
      update.capacity_override_level = clearing ? null : req.body.capacity_override_level;
      update.capacity_override_reason = clearing ? null : (req.body.capacity_override_reason || null);
      update.capacity_override_at = clearing ? null : knex.fn.now();
    }

    // Rating the capacity stamps WHEN it was rated, server-side - the client
    // never sends the date. A NULL capacity_seeded_at is what distinguishes
    // "backfilled from the old spreadsheet tier, nobody has actually looked"
    // from "a rep rated this place," which is the queue the rating screen
    // works through. Store the coerced number, not the raw body value.
    //
    // Re-confirming the SAME value still stamps the date: the point of the
    // review pass is recording that a human looked, and "looked and agreed"
    // is a real answer. Clearing the rating clears the date with it, so a
    // place can never claim to have been rated on a day when it holds no
    // rating.
    if (update.capacity_seed !== undefined) {
      const clearing = update.capacity_seed === null || update.capacity_seed === '';
      update.capacity_seed = clearing ? null : Number(update.capacity_seed);
      update.capacity_seeded_at = clearing ? null : orgToday();
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
          error: "Address not recognized - double-check it, or save anyway if you're sure.",
          code: 'ADDRESS_UNRECOGNIZED',
        });
      }
      update.lat = coords ? coords.lat : null;
      update.lng = coords ? coords.lng : null;
      update.geocoded_at = knex.fn.now();
      // Distinct from geocoded_at above (stamped on every pass through this
      // block, including a re-save of an unchanged address): this only fires
      // when the submitted fields actually differ from what was stored, so a
      // bulk re-geocode or a form re-save can't flag a place that didn't
      // move. Compared as normalized strings, not the returned lat/lng - two
      // geocodes of the same address can return coordinates that differ in
      // the last decimal place, which would false-flag every re-save. See
      // services/staleAddress.js, the only reader of this column.
      const addressFieldsChanged =
        (update.address !== undefined && update.address !== existing.address) ||
        (update.city !== undefined && update.city !== existing.city) ||
        (update.state !== undefined && update.state !== existing.state) ||
        (update.zip !== undefined && update.zip !== existing.zip);
      if (addressFieldsChanged) update.address_changed_at = knex.fn.now();
      // An existing place's address changing invalidates any distances
      // already cached for it, coords or not - a failed re-geocode (saved
      // anyway via confirm_address) is still a location change, just to an
      // unknown one. Only queue a fresh backfill when there's a real
      // coordinate to compute from.
      await onPlaceGeocoded(knex, id, coords);
    }

    await knex('places').where({ id }).update(update);
    res.json(await knex('places').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// POST /api/places/:id/capacity-observations - record a fresh declared
// capacity number (capacity-computation-spec.md §5/§11). Appends a new
// capacity_observations row rather than overwriting a column: nothing here
// is ever updated in place, so a partner's number visibly growing over
// three years of re-asks stays legible instead of only the latest answer
// surviving. DELETE below exists purely to undo a mis-entered row, not as a
// second way to revise history - see that route's own comment. source:
// 'manual' - a direct place-card edit with no visit behind it. routes/
// visits.js's own first-visit capture inserts its own rows with source:
// 'prequal' (has a visit_id/person_id); this is the OTHER entry point,
// PlaceDetail's own "Add/Edit pre-qualification" card.
router.post('/:id/capacity-observations', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    const referralsErr = monthlyReferralsError(req.body.monthly_referrals);
    if (referralsErr) return res.status(400).json({ error: referralsErr });

    const observedAt = orgToday();
    const [row] = await knex('capacity_observations')
      .insert({
        place_id: id,
        monthly_referrals: Math.round(Number(req.body.monthly_referrals)),
        source: 'manual',
        observed_at: observedAt,
        note: req.body.note || null,
      })
      .returning('id');
    const observationId = knex.extractId(row);
    // Stamps places.exploration_eligible_since to the date THIS observation
    // goes stale - see capacity.js's stampExplorationEligibility for why.
    await stampExplorationEligibility(knex, id, observedAt, schedulingConfig);
    const observation = await knex('capacity_observations').where({ id: observationId }).first();
    res.status(201).json(observation);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/places/:id/capacity-observations/:observationId - undo a
// mis-entered row (fat-fingered number, wrong place). Deliberately does NOT
// touch places.exploration_eligible_since even if this was the observation
// that stamped it - that value is a one-way "stamp on write, never
// re-derive" clock (see capacity.js's stampExplorationEligibility and the
// migration that added the column), so the worst case here is the place
// waits a little longer than ideal before re-entering EXPLORATION, never a
// false-urgent flag from a phantom row.
router.delete('/:id/capacity-observations/:observationId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const observationId = Number(req.params.observationId);
    if (Number.isNaN(id) || Number.isNaN(observationId)) return res.status(404).json({ error: 'Observation not found' });
    const existing = await knex('capacity_observations').where({ id: observationId, place_id: id }).first();
    if (!existing) return res.status(404).json({ error: 'Observation not found' });

    await knex('capacity_observations').where({ id: observationId }).del();

    // The deleted observation's own write stamped exploration_eligible_since
    // up to CAPACITY_STALE_DAYS out (see capacity.js's stampExplorationEligibility) -
    // left alone, a mis-entered observation deleted right after would freeze
    // this place out of EXPLORATION's aging/starvation-guard credit until
    // that stale future date. Re-stamp from whatever observation is now the
    // newest remaining one, or back to today if none remain.
    const remaining = await latestObservationsByPlace(knex, [id], orgToday());
    const newest = remaining.get(id);
    await stampExplorationEligibility(knex, id, newest ? newest.observedAt : orgToday(), schedulingConfig);

    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /api/places/:id/commitments - add a dated promise directly, no visit
// involved (PlaceDetail's Commitments panel - see PlaceCommitments.jsx and
// services/placeCommitments.js's module header for the model). source_visit_id
// is always null from this route; VisitLogModal's own "promise a next visit"
// field creates its commitment through routes/visits.js instead, once that's
// wired up, so it can carry the visit's own id as provenance.
router.post('/:id/commitments', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    const dateErr = commitmentDateError(req.body.promised_date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    const personErr = await commitmentPersonIdError(req.body.person_id);
    if (personErr) return res.status(400).json({ error: personErr });

    const commitment = await createCommitment(knex, {
      placeId: id,
      promisedDate: req.body.promised_date,
      personId: req.body.person_id || null,
      note: req.body.note || null,
      createdByUserId: req.user.id,
    });
    res.status(201).json(await loadCommitment(commitment.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/places/:id/commitments/:commitmentId/reschedule - discharges the
// original as superseded and creates a new outstanding commitment for the
// new date (spec §6.2). person_id/note carry forward from the original
// unless this request overrides them; created_by_user_id on the new row is
// always whoever's rescheduling now, not carried forward.
router.post('/:id/commitments/:commitmentId/reschedule', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const commitmentId = Number(req.params.commitmentId);
    if (Number.isNaN(id) || Number.isNaN(commitmentId)) return res.status(404).json({ error: 'Commitment not found' });
    const existing = await knex('place_commitments').where({ id: commitmentId, place_id: id }).first();
    if (!existing) return res.status(404).json({ error: 'Commitment not found' });
    if (existing.discharged_at) return res.status(409).json({ error: 'This commitment has already been resolved' });

    const dateErr = commitmentDateError(req.body.promised_date);
    if (dateErr) return res.status(400).json({ error: dateErr });
    if (req.body.person_id !== undefined) {
      const personErr = await commitmentPersonIdError(req.body.person_id);
      if (personErr) return res.status(400).json({ error: personErr });
    }

    const rescheduled = await rescheduleCommitment(knex, commitmentId, {
      promisedDate: req.body.promised_date,
      personId: req.body.person_id !== undefined ? (req.body.person_id || null) : undefined,
      note: req.body.note !== undefined ? (req.body.note || null) : undefined,
      createdByUserId: req.user.id,
    });
    // null means someone else discharged this exact commitment in the gap
    // between the pre-check above and rescheduleCommitment's own atomic
    // re-check (services/placeCommitments.js) - same "already resolved"
    // 409 as the pre-check, just reached via the race instead.
    if (!rescheduled) return res.status(409).json({ error: 'This commitment has already been resolved' });
    res.status(201).json(await loadCommitment(rescheduled.id));
  } catch (err) {
    next(err);
  }
});

// POST /api/places/:id/commitments/:commitmentId/waive - discharges as
// waived, with an optional reason appended to the promise's own note (spec
// §6.2 - there's no separate discharge-note column, see
// services/placeCommitments.js's waiveCommitment).
router.post('/:id/commitments/:commitmentId/waive', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const commitmentId = Number(req.params.commitmentId);
    if (Number.isNaN(id) || Number.isNaN(commitmentId)) return res.status(404).json({ error: 'Commitment not found' });
    const existing = await knex('place_commitments').where({ id: commitmentId, place_id: id }).first();
    if (!existing) return res.status(404).json({ error: 'Commitment not found' });
    if (existing.discharged_at) return res.status(409).json({ error: 'This commitment has already been resolved' });

    const waived = await waiveCommitment(knex, commitmentId, { note: req.body.note });
    // Same race as reschedule above - null means it was already discharged
    // by a concurrent request between the pre-check and this call.
    if (!waived) return res.status(409).json({ error: 'This commitment has already been resolved' });
    res.json(await loadCommitment(waived.id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/places/:id/commitments/:commitmentId - history cleanup only.
// Only discharged commitments can be deleted this way; an outstanding
// promise has to be waived, rescheduled, or fulfilled first - this isn't a
// second way to back out of a live one.
router.delete('/:id/commitments/:commitmentId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const commitmentId = Number(req.params.commitmentId);
    if (Number.isNaN(id) || Number.isNaN(commitmentId)) return res.status(404).json({ error: 'Commitment not found' });
    const existing = await knex('place_commitments').where({ id: commitmentId, place_id: id }).first();
    if (!existing) return res.status(404).json({ error: 'Commitment not found' });
    if (!existing.discharged_at) {
      return res.status(409).json({ error: 'This commitment is still outstanding - waive, reschedule, or fulfill it first' });
    }

    await deleteCommitment(knex, commitmentId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// DELETE /api/places/:id/snooze - lift an active place-level snooze early
// (POST /api/visits/:id/snooze is the only way snooze_until gets SET; this
// is the only way it gets cleared before its own date arrives). Deliberately
// a plain clear, not tied to the visit that originally set it - that visit
// stays 'snoozed' as its own permanent record of what was deferred and why;
// this only undoes the place-level suppression schedulingEngine.js's
// eligibility() reads.
router.delete('/:id/snooze', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });
    await knex('places').where({ id }).update({ snooze_until: null });
    res.json(await knex('places').where({ id }).first());
  } catch (err) {
    next(err);
  }
});

// DELETE /api/places/:id - remove only the place itself. People who were here
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
