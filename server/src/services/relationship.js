// Computed relationship strength - the objective, decaying replacement for
// the manual places.relationship_level field, modelled directly on
// services/referralMetrics.js (nothing stored, derived live on every read).
//
// WHY THIS EXISTS
// relationship_level is one of the two axes of schedulingEngine.js's cadence
// table. It defaults to 'weak', has no automatic write path anywhere, and in
// practice was never edited - so every place read 'weak' and the cadence table
// was effectively running on capacity alone. That's the same failure that
// killed the old relationship_temp field (dropped in
// 20260710000000_drop_relationship_temp.js): a manual "smart" field that needs
// upkeep and doesn't get it. Per this project's own convention - no manual
// smart fields that need upkeep - the replacement is a fully computed value
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
//    "has ever referred" is permitted here; counts and rates are NOT - which
//    is why the referral query below deliberately selects DISTINCT person_id
//    and never a COUNT.

const { daysSince, urgency } = require('./schedulingEngine');
const { orgToday } = require('./orgDate');
const { computeCapacityForPlaces } = require('./capacity');
const schedulingConfig = require('../config/scheduling');

// --- Weights -------------------------------------------------------------

// WHO the rep actually spoke to. Only 'named_person' builds a person's score;
// the rest accrue to the place as a direct "floor" contribution (see
// rollUpPlace), so a place serviced diligently without ever meeting anyone
// reads as "present but shallow" - which is accurate.
const MET_WITH_WEIGHT = {
  named_person: 1.0,
  staff: 0.35,
  receptionist: 0.15,
  nobody: 0.05,
};

// A visit whose met_with_type is null/unrecognized (pre-migration history, or
// a visit completed through a path that never captured it) is scored as the
// weakest known case rather than thrown away or trusted - and, like the other
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

// Floor for an outcome this model doesn't recognize - which today means every
// pre-existing visit, since the historical outcome enum
// (interested/not_ready/follow_up/no_answer/left_materials) shares no values
// with the one above. Set to the lowest real weight rather than 0 so old
// visits contribute *something* without being able to inflate a score.
// Writing the real old->new mapping is deferred to whenever actual historical
// data gets imported (all current visit data is test data) - see HANDOFF.md.
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
// seeded `categories` table (20260727000000_add_categories_table.js) - a
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
const HALF_LIFE_DEFAULT = 60; // days - everything else, including any category added later

// Hardcoded on purpose: no UI, no schema, no `categories` column. Any category
// not on the fast list - including ones added after this ships - is 60 days.
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
// person. Everything else - staff/receptionist/nobody, an unrecognized
// met_with_type, or a 'named_person' visit whose person record was since
// detached (person_id nulled by ON DELETE SET NULL) - falls through to the
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
const REFERRED_MULTIPLIER = 1.15; // has ever referred (BINARY - never a count, see the header)
const REQUESTED_MULTIPLIER = 1.1; // they asked us for something recently
const MAX_RECIPROCITY = 1.6; // hard cap (natural max is 1.25 * 1.15 * 1.1 = 1.58125)

// Known personal detail is a STOCK, not a flow - it doesn't decay. You don't
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
// the ratio c/H - so a 30-day-category place visited every 15 days and a
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
//
// medium's floor is 1.4, not the 1.33 convergence value itself: Bede decided
// (2026-08-10) that "visited half as often as the half-life" should read
// weak, matching the prose table above, so the threshold sits just above
// that boundary rather than just below it.
const RELATIONSHIP_THRESHOLDS = { strong: 3.4, medium: 1.4 };
const LEVELS = ['strong', 'medium', 'weak'];

function levelForScore(score) {
  if (score >= RELATIONSHIP_THRESHOLDS.strong) return 'strong';
  if (score >= RELATIONSHIP_THRESHOLDS.medium) return 'medium';
  return 'weak';
}

// --- Trend (heating up / cooling down) ------------------------------------
//
// Purely a display signal - it never feeds back into score/level, so it's
// bolted on as one extra field rather than woven into the scoring functions
// above. Two INDEPENDENT mechanisms, not one - they answer different
// questions and neither can stand in for the other:
//
// HEATING UP asks "did something real just happen" - today's score vs. the
// same computation re-run as of a past reference date. Decay is the only
// thing that ever pulls a score down between two evaluations of one visit
// history, so a higher score today than at the reference date can only mean
// something real (a visit, a fresh referral, a newly-live reciprocity
// signal) outpaced decay in between. This is deliberately a SHORT-lived
// burst signal: once decay catches back up, it goes quiet on its own.
//
// COOLING DOWN asks "has too much time passed since we last showed up" -
// answered against a target cadence, not a score ratio. A ratio-vs-N-days-
// ago comparison can never represent open-ended neglect: exponential decay
// is self-similar, so once nothing new has happened for a while, the ratio
// between "now" and "N days ago" locks onto a fixed constant and simply
// stops changing, forever - it can say "quiet recently" but never "quiet for
// a long time." Elapsed time since the last (meaningful) contact, compared
// against how often this relationship is EXPECTED to be nurtured, has no
// such ceiling: the longer it's ignored, the further past the line it gets.
const TREND_RELATIVE_THRESHOLD = 0.1; // must move >=10% to read as a real HEATING UP move, not noise
const TREND_EPSILON = 0.01; // both sides at/below this = "no history at either point," not a trend

// The heating-up lookback scales with the category's own half-life - same
// "one scale, two clocks" idea the LEVEL thresholds above already use - so a
// fast-decay category gets flagged on a shorter lookback than a slow one.
// Deliberately SHORT (not half the half-life): pure decay with nothing new
// must itself stay inside the +/-10% band above, or "heating up" would never
// be able to go quiet on its own - see the derivation in the trend-design
// conversation. 0.5^(0.12) ~= 0.917 for the fast clock, 0.5^(0.12) again for
// the default clock (the ratio only depends on the FRACTION, not the
// half-life itself) - comfortably inside the +/-10% band with margin to
// spare against integer-day rounding.
const TREND_WINDOW_FRACTION = 0.12; // ~4d fast-decay categories, ~7d default

// Cooling down (PLACE): flagged once a place is this many times past its own
// target cadence (see schedulingEngine.js's targetCadenceDays/urgency - the
// exact function the route planner itself uses to decide when a place is
// overdue for a rescue visit). Deliberately EARLIER than NEGLECT_MULTIPLIER
// (2.0, config/scheduling.js) - an early warning that shows before the
// scheduler's own "endangered" tier kicks in, not a duplicate of it.
const COOLING_THRESHOLD = 1.25;

// Cooling down (PERSON): flagged once it's been this fraction of the
// category's half-life since their last MEANINGFUL visit (not just any
// visit - a front-desk drop-off shouldn't reset this clock). Half of the
// half-life, per Bede: the score has decayed by ~29% at that point, not yet
// halved - an earlier nudge than waiting for the full half-life.
const PERSON_COOLING_HALF_LIFE_FRACTION = 0.5;

function trendWindowDays(halfLifeDays) {
  return Math.round(halfLifeDays * TREND_WINDOW_FRACTION);
}

// 'YYYY-MM-DD' n days before `dateStr` - UTC-safe, same convention as
// schedulingEngine.js's daysSince.
function daysBefore(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * 86400000).toISOString().slice(0, 10);
}

function isHeatingUp(current, historical) {
  if (current <= TREND_EPSILON && historical <= TREND_EPSILON) return false;
  return current > historical * (1 + TREND_RELATIVE_THRESHOLD);
}

// today - lastVisitDate, as a multiple of this place's own target cadence
// (capacity x relationship, fatigue-stretched the same way the scheduler
// itself stretches it - see schedulingEngine.js's urgency). A never-visited
// place (lastVisitDate null) has nothing to be overdue FROM, so it's never
// "cooling" - that's what EMPTY/no-history already communicates.
function isPlaceCoolingDown({ place, lastVisitDate, recentCompletedCount, relationshipLevel, capacityLevel, today }) {
  if (!lastVisitDate) return false;
  const u = urgency({ place, lastVisitDate, recentCompletedCount, relationshipLevel, capacityLevel, today, config: schedulingConfig });
  return u > COOLING_THRESHOLD;
}

// Same idea, person-scoped: no cadence table at the person level, so this
// compares straight against the category half-life instead of a capacity x
// relationship lookup.
function isPersonCoolingDown({ lastMeaningfulVisit, halfLifeDays, today }) {
  if (!lastMeaningfulVisit) return false;
  return daysSince(lastMeaningfulVisit, today) > halfLifeDays * PERSON_COOLING_HALF_LIFE_FRACTION;
}

// Re-runs computePersonRelationship as of a past date, seeing only the
// visits and seed that existed by then. Filtering happens HERE, on the
// inputs, rather than inside computePersonRelationship itself - that
// function's own "a future-dated visit clamps to full weight, never decays
// upward" defensive behavior (see its tests) is for asOf-is-today callers and
// would wrongly give full credit to a visit that, from referenceDate's
// vantage point, hadn't happened yet.
function personScoreAsOf({ person, visits, hasReferral, halfLifeDays, referenceDate }) {
  const visibleVisits = visits.filter((v) => v.scheduled_date <= referenceDate);
  const visiblePerson =
    person.relationship_seeded_at && person.relationship_seeded_at > referenceDate
      ? { ...person, relationship_seed: null, relationship_seeded_at: null }
      : person;
  return computePersonRelationship({
    person: visiblePerson,
    visits: visibleVisits,
    hasReferral,
    halfLifeDays,
    asOf: referenceDate,
  }).score;
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
    // "Asked us for something" only counts inside the trailing half-life -
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

// Only contributors that actually move the number are listed - a place with
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
// shape as referralMetrics.js / buildCandidatePool throughout - a fixed
// number of queries, then group and compute in JS. No correlated subqueries,
// no per-row lookups.
//
// `asOf` matters because the route planner generates drafts up to 7 weekdays
// out and each day should eventually be evaluated as of THAT day, not as of
// generation day. Threaded through from the start even though today's callers
// all pass today - retrofitting it later would mean touching every call site.

const PERSON_FIELDS = ['id', 'place_id', 'name', 'email', 'phone', 'preferences', 'birthday_month', 'birthday_day', 'relationship_seed', 'relationship_seeded_at'];

// One row here is one ENCOUNTER - which is exactly what every scoring
// function below already assumed, back when one flat `visits` row WAS one
// encounter (see 20260806000000_split_visit_encounters.js). The split moved
// the who/what half onto `visit_encounters` and left the where/when half on
// `visits`, so the same field set now comes from a join instead of a single
// table. Nothing downstream of this select changed: same column names, same
// one-row-per-encounter cardinality, therefore identical scores. The
// scoring-parity test in relationship.test.js asserts precisely that.
//
// DECAY READS THE TRIP'S scheduled_date, NEVER visit_encounters.created_at.
// created_at is when the row was *written* - a visit backdated at logging
// time, or an encounter added to an existing trip days later, would decay
// from the wrong clock. The date the rep actually stood in the building is
// the only honest age for this model, and it lives on `visits`.
const ENCOUNTER_SELECT = [
  'v.place_id',
  'v.scheduled_date',
  've.person_id',
  've.met_with_type',
  've.outcome',
  've.they_requested',
];

// The shared half of both bulk queries below. Still one query per call - the
// join replaces a table scan with a table scan, it does not turn either
// function into a per-row lookup (computeRelationshipForPlaces runs over all
// 261 places on every Places-directory load and inside the route planner's
// candidate pool).
function completedEncounters(knex) {
  return knex('visit_encounters as ve')
    .join('visits as v', 'v.id', 've.visit_id')
    .where('v.status', 'completed')
    .select(ENCOUNTER_SELECT);
}

// person_id -> true. DISTINCT only, never a count - see the axis-separation
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
// resolves - to the default). Moving a person between places therefore changes
// their decay rate; that's intentional, not a bug to guard against.
// `includeTrend` defaults to false: trend is a second full pass over the
// same data (a historical re-run of the score), and the only two callers
// that ever render it are the single-person and single-place detail routes.
// Every bulk caller - the Places/People directories, the route planner's
// candidate pool, the relationship-distribution script - asks for many rows
// at once and never shows trend, so they get the cheap path for free just by
// not opting in.
async function computeRelationshipForPeople(knex, personIds, { asOf, includeTrend = false } = {}) {
  const out = new Map();
  if (!personIds.length) return out;
  const date = asOf || orgToday();

  const people = await knex('people as pe')
    .leftJoin('places as p', 'p.id', 'pe.place_id')
    .whereIn('pe.id', personIds)
    .select(PERSON_FIELDS.map((f) => `pe.${f}`))
    .select('p.category as place_category');

  const visits = await completedEncounters(knex).whereIn('ve.person_id', personIds);

  const referred = await referredPersonIds(knex, personIds);
  const visitsByPerson = groupBy(visits, 'person_id');

  for (const person of people) {
    const halfLifeDays = halfLifeForCategory(person.place_category);
    const personVisits = visitsByPerson.get(person.id) || [];
    const hasReferral = referred.has(person.id);

    const current = computePersonRelationship({ person, visits: personVisits, hasReferral, halfLifeDays, asOf: date });

    let trend = null;
    if (includeTrend) {
      const referenceDate = daysBefore(date, trendWindowDays(halfLifeDays));
      const historicalScore = personScoreAsOf({ person, visits: personVisits, hasReferral, halfLifeDays, referenceDate });
      if (isHeatingUp(current.score, historicalScore)) {
        trend = 'up';
      } else if (isPersonCoolingDown({ lastMeaningfulVisit: current.last_meaningful_visit, halfLifeDays, today: date })) {
        trend = 'down';
      }
    }

    out.set(person.id, { ...current, trend });
  }
  return out;
}

// place_id -> PlaceRelationship. Four queries total regardless of how many
// places are asked for. `includeTrend` defaults to false - see the comment
// on computeRelationshipForPeople; the same reasoning applies here, and this
// is the function the Places directory (261 rows on every load) and the
// route planner's candidate pool both call in bulk.
async function computeRelationshipForPlaces(knex, placeIds, { asOf, includeTrend = false } = {}) {
  const out = new Map();
  if (!placeIds.length) return out;
  const date = asOf || orgToday();

  const places = await knex('places as p')
    .leftJoin('users as u', 'u.id', 'p.relationship_override_by')
    .whereIn('p.id', placeIds)
    .select('p.id', 'p.category', 'p.capacity_level', 'p.relationship_level_override', 'p.relationship_override_at', 'p.relationship_override_by')
    .select('u.name as override_by_name');

  const people = await knex('people').whereIn('place_id', placeIds).select(PERSON_FIELDS);
  const peopleIds = people.map((p) => p.id);

  // Place-scoped: only for floorVisits/visitsByPlace below (visits that
  // didn't credit a named person, and the place-level "we showed up here"
  // rollup for the trend check).
  const visits = await completedEncounters(knex).whereIn('v.place_id', placeIds);
  // Person-scoped, separately: a person's own visit history has to travel
  // with them regardless of which place is being asked about right now, or
  // the SAME person/place scores differently depending on whether the
  // caller requested one place or all of them (their history at any place
  // outside the current placeIds batch would otherwise just be invisible).
  const personVisits = peopleIds.length ? await completedEncounters(knex).whereIn('ve.person_id', peopleIds) : [];

  const referred = await referredPersonIds(knex, peopleIds);

  // Only fetched when trend is actually requested - the cooling-down check
  // below needs each place's CURRENT computed capacity level, not the
  // frozen places.capacity_level column that effectiveCapacityLevel()
  // otherwise silently falls back to (a tests-only fallback per that
  // function's own comment - it must not fire here in production).
  const capacityByPlace = includeTrend ? await computeCapacityForPlaces(knex, placeIds, { asOf: date }) : null;

  const peopleByPlace = groupBy(people, 'place_id');
  const visitsByPlace = groupBy(visits, 'place_id');
  const visitsByPerson = groupBy(personVisits, 'person_id');

  for (const place of places) {
    const placeVisits = visitsByPlace.get(place.id) || [];
    const halfLifeDays = halfLifeForCategory(place.category);
    const placePeople = peopleByPlace.get(place.id) || [];
    const floorVisits = placeVisits.filter((v) => !creditsPerson(v));

    const personEntries = placePeople.map((person) => ({
      person,
      relationship: computePersonRelationship({
        person,
        // A person's own visits, not just this place's - their score travels
        // with them, and a visit logged before they moved still counts.
        visits: visitsByPerson.get(person.id) || [],
        hasReferral: referred.has(person.id),
        halfLifeDays,
        asOf: date,
      }),
    }));

    const current = rollUpPlace({ place, personEntries, floorVisits, asOf: date, overrideUserName: place.override_by_name });

    // Trend is suppressed under a manual override - the override IS the
    // answer at that point, and a computed "cooling down" next to a pinned
    // "Strong" would just read as a contradiction nobody asked for.
    let trend = null;
    if (includeTrend && !current.is_overridden) {
      const referenceDate = daysBefore(date, trendWindowDays(halfLifeDays));
      const historicalPersonEntries = placePeople.map((person) => ({
        person,
        relationship: {
          score: personScoreAsOf({
            person,
            visits: visitsByPerson.get(person.id) || [],
            hasReferral: referred.has(person.id),
            halfLifeDays,
            referenceDate,
          }),
        },
      }));
      const historicalFloorVisits = floorVisits.filter((v) => v.scheduled_date <= referenceDate);
      const historical = rollUpPlace({
        place,
        personEntries: historicalPersonEntries,
        floorVisits: historicalFloorVisits,
        asOf: referenceDate,
        overrideUserName: place.override_by_name,
      });

      if (isHeatingUp(current.score, historical.score)) {
        trend = 'up';
      } else {
        // "Last visit" and "recent volume" for the overdue check are ANY
        // completed visit (matching urgency()'s own semantics in the
        // scheduler), not just visits that credited a named person - floor
        // visits count toward "we showed up here" just as they do for score.
        // Recent volume counts DISTINCT DAYS, not rows, for the same reason
        // buildCandidatePool does (see its comment): one row is one person
        // met, so a single multi-contact trip must not read as several visits.
        const lastVisitDate = placeVisits.reduce((max, v) => (!max || v.scheduled_date > max ? v.scheduled_date : max), null);
        const recentCompletedCount = new Set(
          placeVisits.filter((v) => daysSince(v.scheduled_date, date) <= schedulingConfig.FATIGUE_WINDOW_DAYS).map((v) => v.scheduled_date)
        ).size;
        const capacityLevel = capacityByPlace.get(place.id)?.level;
        if (isPlaceCoolingDown({ place, lastVisitDate, recentCompletedCount, relationshipLevel: current.level, capacityLevel, today: date })) {
          trend = 'down';
        }
      }
    }

    out.set(place.id, { ...current, trend });
  }
  return out;
}

// "No people, no visits" - a real and common answer, not missing data.
const EMPTY_PLACE_RELATIONSHIP = {
  score: 0,
  level: 'weak',
  effective_level: 'weak',
  is_overridden: false,
  override: null,
  people_component: 0,
  floor_component: 0,
  contributors: [],
  trend: null,
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
  TREND_WINDOW_FRACTION,
  TREND_RELATIVE_THRESHOLD,
  TREND_EPSILON,
  COOLING_THRESHOLD,
  PERSON_COOLING_HALF_LIFE_FRACTION,
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
  trendWindowDays,
  daysBefore,
  isHeatingUp,
  isPlaceCoolingDown,
  isPersonCoolingDown,
  personScoreAsOf,
  // bulk DB
  computeRelationshipForPeople,
  computeRelationshipForPlaces,
};
