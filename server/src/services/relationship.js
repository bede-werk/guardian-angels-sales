// Computed relationship strength — the objective, decaying replacement for
// the manual places.relationship_level field, modelled directly on
// services/referralMetrics.js (nothing stored, derived live on every read).
//
// WHY THIS EXISTS
// relationship_level is one of the two axes of schedulingEngine.js's cadence
// table. It defaults to 'weak', has no automatic write path anywhere, and in
// practice was never edited — so every place read 'weak' and the cadence table
// was effectively running on capacity alone. That's the same failure that
// killed the old relationship_temp field (dropped in
// 20260710000000_drop_relationship_temp.js): a manual "smart" field that needs
// upkeep and doesn't get it. Per this project's own convention — no manual
// smart fields that need upkeep — the replacement is a fully computed value
// with a clearly-flagged manual override (see places.relationship_level_override).
//
// TWO DESIGN RULES WORTH NOT BREAKING LATER
//
// 1. Relationship is measured at the PERSON level and rolled up to the place.
//    A relationship is with Sharon at Tabitha, not with Tabitha. A person who
//    moves takes their score with them (rollup reads live people.place_id,
//    same rule referralMetrics.js already uses).
//
// 2. Relationship must NOT be driven by referral VOLUME. Volume is the
//    capacity axis. If both axes read the same signal they collapse into one,
//    and the deliberate inversion that makes the cadence table valuable
//    (high-capacity + weak-relationship gets visited most often) stops working
//    because that cell empties out by construction. Relationship measures
//    investment and reciprocity; capacity measures throughput. A single binary
//    "has ever referred" is permitted here; counts and rates are NOT — which
//    is why the referral query below deliberately selects DISTINCT person_id
//    and never a COUNT.

const { daysSince } = require('./schedulingEngine');
const { orgToday } = require('./orgDate');

// --- Weights -------------------------------------------------------------

// WHO the rep actually spoke to. Only 'named_person' builds a person's score;
// the rest accrue to the place as a direct "floor" contribution (see
// rollUpPlace), so a place serviced diligently without ever meeting anyone
// reads as "present but shallow" — which is accurate.
const MET_WITH_WEIGHT = {
  named_person: 1.0,
  staff: 0.35,
  receptionist: 0.15,
  nobody: 0.05,
};

// A visit whose met_with_type is null/unrecognized (pre-migration history, or
// a visit completed through a path that never captured it) is scored as the
// weakest known case rather than thrown away or trusted — and, like the other
// non-named-person cases, it can never credit a person.
const UNKNOWN_MET_WITH_WEIGHT = MET_WITH_WEIGHT.nobody;

// WHAT actually happened. Deliberately observable rather than evaluative, so
// these describe events rather than the rep's feelings about them and don't
// inflate over time.
const OUTCOME_WEIGHT = {
  substantive: 1.0, // real conversation with a decision-maker or influencer
  introduced_new: 1.0, // introduced to someone new at the org
  brief: 0.6, // short exchange, pleasant but not substantive
  materials_only: 0.25, // left materials, no meaningful contact
  unavailable: 0.15, // target unavailable / gatekept
  declined: 0.1, // explicitly not interested right now
};

// Floor for an outcome this model doesn't recognize — which today means every
// pre-existing visit, since the historical outcome enum
// (interested/not_ready/follow_up/no_answer/left_materials) shares no values
// with the one above. Set to the lowest real weight rather than 0 so old
// visits contribute *something* without being able to inflate a score.
// Writing the real old->new mapping is deferred to whenever actual historical
// data gets imported (all current visit data is test data) — see HANDOFF.md.
const UNKNOWN_OUTCOME_WEIGHT = OUTCOME_WEIGHT.declined;

// A visit at or above this RAW (pre-decay) weight counts as "meaningful" for
// last_meaningful_visit. Deliberately raw, not decayed: a genuinely
// substantive visit eight months ago was still substantive at the time, and
// this field exists to explain a score ("last meaningful visit 94 days ago"),
// not to re-litigate it.
const MEANINGFUL_WEIGHT = 0.6;

// --- Decay ---------------------------------------------------------------

// Half-life is a property of the place's CATEGORY: a hospital relationship
// goes cold faster than a funeral home's. Exact strings reconciled against the
// seeded `categories` table (20260727000000_add_categories_table.js) — a
// near-miss here would silently fall through to the default with no error.
const FAST_DECAY_CATEGORIES = new Set([
  'Assisted Living & Senior Living',
  'Community Partners',
  'Hospice',
  'Hospitals',
  'Physical Therapy',
  'Physicians',
  'Rehabilitation Centers',
  'Legal & Trust',
]);

const HALF_LIFE_FAST = 30; // days
const HALF_LIFE_DEFAULT = 60; // days — everything else, including any category added later

// Hardcoded on purpose: no UI, no schema, no `categories` column. Any category
// not on the fast list — including ones added after this ships — is 60 days.
// A person with no assigned place gets the default too.
function halfLifeForCategory(category) {
  return FAST_DECAY_CATEGORIES.has(category) ? HALF_LIFE_FAST : HALF_LIFE_DEFAULT;
}

// 0.5 ^ (age / halfLife). Clamped at age 0 so a same-day visit (or a
// defensively-handled future date) can never score ABOVE its own raw weight.
function decayFactor(ageDays, halfLifeDays) {
  const age = Math.max(0, ageDays);
  return 0.5 ** (age / halfLifeDays);
}

// --- Per-visit -----------------------------------------------------------

// Only a named_person visit that actually carries a person_id can credit a
// person. Everything else — staff/receptionist/nobody, an unrecognized
// met_with_type, or a 'named_person' visit whose person record was since
// detached (person_id nulled by ON DELETE SET NULL) — falls through to the
// place's floor instead. Every visit lands somewhere; none silently vanish.
function creditsPerson(visit) {
  return visit.met_with_type === 'named_person' && visit.person_id != null;
}

// visit_weight = met-with weight x outcome weight. A substantive sit-down with
// a named contact scores 1.0; a drop-off at the front desk scores
// 0.05 x 0.25 = 0.0125. Both are real visits; their relationship value differs
// by ~80x, which is the entire point of multiplying the two axes.
function visitWeight(visit) {
  const metWith = MET_WITH_WEIGHT[visit.met_with_type] ?? UNKNOWN_MET_WITH_WEIGHT;
  const outcome = OUTCOME_WEIGHT[visit.outcome] ?? UNKNOWN_OUTCOME_WEIGHT;
  return metWith * outcome;
}

function decayedVisitWeight(visit, { asOf, halfLifeDays }) {
  return visitWeight(visit) * decayFactor(daysSince(visit.scheduled_date, asOf), halfLifeDays);
}

// --- Reciprocity ---------------------------------------------------------

// Signals that THEY invested in the relationship, not just that the rep showed
// up. Without this the score is a mirror of the rep's own behavior and "strong
// relationship" reduces to "we visit here a lot," which is circular.
const DETAIL_BONUS = 0.0625; // x4 known personal details -> max 1.25
const REFERRED_MULTIPLIER = 1.15; // has ever referred (BINARY — never a count, see the header)
const REQUESTED_MULTIPLIER = 1.1; // they asked us for something recently
const MAX_RECIPROCITY = 1.6; // hard cap (natural max is 1.25 * 1.15 * 1.1 = 1.58125)

// Known personal detail is a STOCK, not a flow — it doesn't decay. You don't
// know someone's birthday unless the relationship is real, and you don't stop
// knowing it because a quarter went by.
function reciprocityMultiplier(person, { hasReferral, requestedRecently }) {
  let detail = 1.0;
  if (person.birthday_month != null && person.birthday_day != null) detail += DETAIL_BONUS;
  if (person.preferences && String(person.preferences).trim()) detail += DETAIL_BONUS;
  if (person.email && String(person.email).trim()) detail += DETAIL_BONUS;
  if (person.phone && String(person.phone).trim()) detail += DETAIL_BONUS;

  const referred = hasReferral ? REFERRED_MULTIPLIER : 1.0;
  const requested = requestedRecently ? REQUESTED_MULTIPLIER : 1.0;

  return Math.min(MAX_RECIPROCITY, detail * referred * requested);
}

// --- Buckets -------------------------------------------------------------

// Category-INDEPENDENT by design. The steady-state score for a constant visit
// cadence c under half-life H is 1 / (1 - 0.5^(c/H)), which depends only on
// the ratio c/H — so a 30-day-category place visited every 15 days and a
// 60-day-category place visited every 30 days both score 3.41. One scale, two
// clocks: the per-category half-lives already encode "what counts as attentive
// here," so the thresholds don't need to move with them.
//
//   visited 2x as often as half-life -> 3.41  (strong)
//   visited exactly at half-life     -> 2.00  (medium)
//   visited half as often            -> 1.33  (weak boundary)
//
// Those figures assume weight-1.0 visits (named person, substantive). Real
// scores land lower, which is correct.
const RELATIONSHIP_THRESHOLDS = { strong: 3.4, medium: 1.3 };
const LEVELS = ['strong', 'medium', 'weak'];

function levelForScore(score) {
  if (score >= RELATIONSHIP_THRESHOLDS.strong) return 'strong';
  if (score >= RELATIONSHIP_THRESHOLDS.medium) return 'medium';
  return 'weak';
}

// --- Person --------------------------------------------------------------

// person_score = (raw visit score x reciprocity) + decayed seed.
//
// The seed is deliberately NOT multiplied by reciprocity: it already encodes a
// holistic human judgment that includes reciprocity, so multiplying would
// double-count it. See migration 20260803000001 for why a decaying seed beats
// a permanent override.
function computePersonRelationship({ person, visits, hasReferral, halfLifeDays, asOf }) {
  const crediting = visits.filter(creditsPerson);

  let rawScore = 0;
  let lastMeaningful = null;
  let requestedRecently = false;

  for (const v of crediting) {
    rawScore += decayedVisitWeight(v, { asOf, halfLifeDays });

    if (visitWeight(v) >= MEANINGFUL_WEIGHT && (!lastMeaningful || v.scheduled_date > lastMeaningful)) {
      lastMeaningful = v.scheduled_date;
    }
    // "Asked us for something" only counts inside the trailing half-life —
    // a request from two years ago isn't live reciprocity.
    if (v.they_requested && daysSince(v.scheduled_date, asOf) <= halfLifeDays) requestedRecently = true;
  }

  const multiplier = reciprocityMultiplier(person, { hasReferral, requestedRecently });
  const visitComponent = rawScore * multiplier;

  const seedComponent =
    person.relationship_seed != null && person.relationship_seeded_at
      ? person.relationship_seed * decayFactor(daysSince(person.relationship_seeded_at, asOf), halfLifeDays)
      : 0;

  const score = visitComponent + seedComponent;

  return {
    score,
    level: levelForScore(score),
    seed_component: seedComponent,
    visit_component: visitComponent,
    reciprocity_multiplier: multiplier,
    visit_count_weighted: rawScore, // pre-multiplier, for explaining the number
    last_meaningful_visit: lastMeaningful,
  };
}

// --- Place ---------------------------------------------------------------

// Each additional contact is worth half the last: p0 + 0.5*p1 + 0.25*p2 + ...
// The strongest relationship sets the floor; breadth still counts but with
// sharply diminishing returns. A place with one genuine champion beats a place
// with six lukewarm contacts, while still pricing in the redundancy risk when
// a champion leaves. A zero-scoring contact contributes exactly zero at any
// position, so extra weak contacts can never dilute a strong one.
const CONTRIBUTOR_DECAY = 0.5;

// Only contributors that actually move the number are listed — a place with
// six assigned people and one real contact should read as one real contact,
// not five rows of zeroes.
function rollUpPlace({ place, personEntries, floorVisits, asOf, overrideUserName }) {
  const halfLifeDays = halfLifeForCategory(place.category);

  const ranked = [...personEntries].sort((a, b) => b.relationship.score - a.relationship.score);

  let peopleComponent = 0;
  const contributors = [];
  ranked.forEach((entry, i) => {
    const weight = CONTRIBUTOR_DECAY ** i;
    const contribution = entry.relationship.score * weight;
    peopleComponent += contribution;
    if (entry.relationship.score > 0) {
      contributors.push({
        person_id: entry.person.id,
        name: entry.person.name,
        score: entry.relationship.score,
        weight,
        contribution,
      });
    }
  });

  // Visits that never met a named person still say something real about the
  // place ("we show up here"), just not about any individual relationship.
  const floorComponent = floorVisits.reduce((sum, v) => sum + decayedVisitWeight(v, { asOf, halfLifeDays }), 0);

  const score = peopleComponent + floorComponent;
  const computedLevel = levelForScore(score);

  const isOverridden = Boolean(place.relationship_level_override);

  return {
    score,
    level: computedLevel,
    effective_level: place.relationship_level_override || computedLevel,
    is_overridden: isOverridden,
    override: isOverridden
      ? {
          level: place.relationship_level_override,
          at: place.relationship_override_at || null,
          by_user_id: place.relationship_override_by || null,
          by_name: overrideUserName || null,
        }
      : null,
    people_component: peopleComponent,
    floor_component: floorComponent,
    contributors,
  };
}

// --- Bulk DB paths -------------------------------------------------------
//
// Both take knex explicitly (matching referralMetrics.js's convention) and
// must stay BULK: buildCandidatePool ranks every place on every draft
// generation, so a per-place query here would be catastrophic there. Same
// shape as referralMetrics.js / buildCandidatePool throughout — a fixed
// number of queries, then group and compute in JS. No correlated subqueries,
// no per-row lookups.
//
// `asOf` matters because the route planner generates drafts up to 7 weekdays
// out and each day should eventually be evaluated as of THAT day, not as of
// generation day. Threaded through from the start even though today's callers
// all pass today — retrofitting it later would mean touching every call site.

const PERSON_FIELDS = ['id', 'place_id', 'name', 'email', 'phone', 'preferences', 'birthday_month', 'birthday_day', 'relationship_seed', 'relationship_seeded_at'];
const VISIT_FIELDS = ['place_id', 'person_id', 'met_with_type', 'outcome', 'scheduled_date', 'they_requested'];

// person_id -> true. DISTINCT only, never a count — see the axis-separation
// rule in this file's header. The model must not have access to volume.
async function referredPersonIds(knex, personIds) {
  if (!personIds.length) return new Set();
  const rows = await knex('referrals').whereIn('person_id', personIds).distinct('person_id').select('person_id');
  return new Set(rows.map((r) => r.person_id));
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (r[key] == null) continue;
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

// person_id -> PersonRelationship. Half-life comes from the person's CURRENTLY
// assigned place's category (left-joined, so an unassigned person still
// resolves — to the default). Moving a person between places therefore changes
// their decay rate; that's intentional, not a bug to guard against.
async function computeRelationshipForPeople(knex, personIds, { asOf } = {}) {
  const out = new Map();
  if (!personIds.length) return out;
  const date = asOf || orgToday();

  const people = await knex('people as pe')
    .leftJoin('places as p', 'p.id', 'pe.place_id')
    .whereIn('pe.id', personIds)
    .select(PERSON_FIELDS.map((f) => `pe.${f}`))
    .select('p.category as place_category');

  const visits = await knex('visits')
    .where({ status: 'completed' })
    .whereIn('person_id', personIds)
    .select(VISIT_FIELDS);

  const referred = await referredPersonIds(knex, personIds);
  const visitsByPerson = groupBy(visits, 'person_id');

  for (const person of people) {
    out.set(
      person.id,
      computePersonRelationship({
        person,
        visits: visitsByPerson.get(person.id) || [],
        hasReferral: referred.has(person.id),
        halfLifeDays: halfLifeForCategory(person.place_category),
        asOf: date,
      })
    );
  }
  return out;
}

// place_id -> PlaceRelationship. Four queries total regardless of how many
// places are asked for.
async function computeRelationshipForPlaces(knex, placeIds, { asOf } = {}) {
  const out = new Map();
  if (!placeIds.length) return out;
  const date = asOf || orgToday();

  const places = await knex('places as p')
    .leftJoin('users as u', 'u.id', 'p.relationship_override_by')
    .whereIn('p.id', placeIds)
    .select('p.id', 'p.category', 'p.relationship_level_override', 'p.relationship_override_at', 'p.relationship_override_by')
    .select('u.name as override_by_name');

  const people = await knex('people').whereIn('place_id', placeIds).select(PERSON_FIELDS);

  const visits = await knex('visits')
    .where({ status: 'completed' })
    .whereIn('place_id', placeIds)
    .select(VISIT_FIELDS);

  const referred = await referredPersonIds(knex, people.map((p) => p.id));

  const peopleByPlace = groupBy(people, 'place_id');
  const visitsByPlace = groupBy(visits, 'place_id');
  const visitsByPerson = groupBy(visits, 'person_id');

  for (const place of places) {
    const placeVisits = visitsByPlace.get(place.id) || [];
    const halfLifeDays = halfLifeForCategory(place.category);

    const personEntries = (peopleByPlace.get(place.id) || []).map((person) => ({
      person,
      relationship: computePersonRelationship({
        person,
        // A person's own visits, not just this place's — their score travels
        // with them, and a visit logged before they moved still counts.
        visits: visitsByPerson.get(person.id) || [],
        hasReferral: referred.has(person.id),
        halfLifeDays,
        asOf: date,
      }),
    }));

    out.set(
      place.id,
      rollUpPlace({
        place,
        personEntries,
        floorVisits: placeVisits.filter((v) => !creditsPerson(v)),
        asOf: date,
        overrideUserName: place.override_by_name,
      })
    );
  }
  return out;
}

// "No people, no visits" — a real and common answer, not missing data.
const EMPTY_PLACE_RELATIONSHIP = {
  score: 0,
  level: 'weak',
  effective_level: 'weak',
  is_overridden: false,
  override: null,
  people_component: 0,
  floor_component: 0,
  contributors: [],
};

function relationshipFor(byId, id) {
  return byId.get(id) || EMPTY_PLACE_RELATIONSHIP;
}

module.exports = {
  // constants (exported for tests and for the distribution readout)
  MET_WITH_WEIGHT,
  OUTCOME_WEIGHT,
  FAST_DECAY_CATEGORIES,
  HALF_LIFE_FAST,
  HALF_LIFE_DEFAULT,
  RELATIONSHIP_THRESHOLDS,
  MAX_RECIPROCITY,
  LEVELS,
  EMPTY_PLACE_RELATIONSHIP,
  // pure
  halfLifeForCategory,
  decayFactor,
  creditsPerson,
  visitWeight,
  decayedVisitWeight,
  reciprocityMultiplier,
  levelForScore,
  computePersonRelationship,
  rollUpPlace,
  relationshipFor,
  // bulk DB
  computeRelationshipForPeople,
  computeRelationshipForPlaces,
};
