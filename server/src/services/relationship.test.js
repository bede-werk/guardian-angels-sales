const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');

const {
  HALF_LIFE_FAST,
  HALF_LIFE_DEFAULT,
  MAX_RECIPROCITY,
  EMPTY_PLACE_RELATIONSHIP,
  halfLifeForCategory,
  decayFactor,
  creditsPerson,
  visitWeight,
  reciprocityMultiplier,
  levelForScore,
  computePersonRelationship,
  rollUpPlace,
  computeRelationshipForPeople,
  computeRelationshipForPlaces,
  isHeatingUp,
  isPlaceCoolingDown,
  isPersonCoolingDown,
  personScoreAsOf,
} = require('./relationship');

const ASOF = '2026-08-03';

// 'YYYY-MM-DD' n days before `dateStr`, UTC-safe — same convention as
// schedulingEngine.js's daysSince, which this module's decay reads through.
function daysBefore(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// A person with zero reciprocity signals, so score == raw visit weight and the
// decay math is readable in isolation.
function barePerson(overrides = {}) {
  return {
    id: 1,
    name: 'Test Person',
    email: null,
    phone: null,
    preferences: null,
    birthday_month: null,
    birthday_day: null,
    relationship_seed: null,
    relationship_seeded_at: null,
    ...overrides,
  };
}

// A full-weight visit: named person + substantive == 1.0 raw.
function visit(scheduledDate, overrides = {}) {
  return {
    place_id: 1,
    person_id: 1,
    met_with_type: 'named_person',
    outcome: 'substantive',
    scheduled_date: scheduledDate,
    they_requested: false,
    ...overrides,
  };
}

function close(actual, expected, tolerance = 0.001, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message || `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

// One logged visit is now a TRIP row plus one row per person/category met
// (20260806000000_split_visit_encounters.js). Fixtures that used to be a
// single flat `visits` insert have to spell out both halves; this keeps the
// call sites about as readable as they were.
async function insertVisit(db, { encounters = [], ...trip }) {
  const [row] = await db('visits').insert(trip).returning('id');
  const visitId = row && row.id ? row.id : row;
  for (const e of encounters) {
    await db('visit_encounters').insert({ ...e, visit_id: visitId });
  }
  return visitId;
}

function memoryDb() {
  return knexLib({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'migrations') },
  });
}

describe('decay math', () => {
  test('a single weight-1.0 visit exactly HALF_LIFE days ago scores 0.5', () => {
    const r = computePersonRelationship({
      person: barePerson(),
      visits: [visit(daysBefore(ASOF, HALF_LIFE_DEFAULT))],
      hasReferral: false,
      halfLifeDays: HALF_LIFE_DEFAULT,
      asOf: ASOF,
    });
    close(r.score, 0.5);
    assert.equal(r.reciprocity_multiplier, 1.0, 'no reciprocity signals set');
  });

  test('a same-day visit scores its full raw weight, and a future date cannot exceed it', () => {
    const sameDay = computePersonRelationship({
      person: barePerson(), visits: [visit(ASOF)], hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    close(sameDay.score, 1.0);

    // Defensive: a completed visit dated in the future must not decay UPWARD.
    const future = computePersonRelationship({
      person: barePerson(), visits: [visit('2026-12-25')], hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    close(future.score, 1.0);
  });

  test('steady state: visits at exactly HALF_LIFE cadence converge to ~2.0', () => {
    const visits = Array.from({ length: 10 }, (_, i) => visit(daysBefore(ASOF, i * HALF_LIFE_DEFAULT)));
    const r = computePersonRelationship({
      person: barePerson(), visits, hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    // Geometric series 1 + 1/2 + 1/4 + ... = 2 - 0.5^9
    close(r.score, 2.0, 0.01);
  });

  // The steady-state score for a constant cadence c under half-life H is
  // 1 / (1 - 0.5^(c/H)) — a function of the RATIO only, which is what lets one
  // set of thresholds serve both the 30-day and 60-day clocks.
  test('the documented cadence-to-bucket table holds', () => {
    const scoreAtCadence = (cadence) => {
      const visits = Array.from({ length: 20 }, (_, i) => visit(daysBefore(ASOF, i * cadence)));
      return computePersonRelationship({
        person: barePerson(), visits, hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
      }).score;
    };
    close(scoreAtCadence(HALF_LIFE_DEFAULT / 2), 3.4142, 0.02);
    assert.equal(levelForScore(scoreAtCadence(HALF_LIFE_DEFAULT / 2)), 'strong');
    close(scoreAtCadence(HALF_LIFE_DEFAULT), 2.0, 0.02);
    assert.equal(levelForScore(scoreAtCadence(HALF_LIFE_DEFAULT)), 'medium');
    close(scoreAtCadence(HALF_LIFE_DEFAULT * 2), 1.3333, 0.02);
  });

  // FLAGGED FOR BEDE — a real judgment call, not a bug. The spec's prose table
  // labels "visited half as often as the half-life" as the WEAK boundary, but
  // its own threshold constant (medium: 1.3) makes that case land in MEDIUM:
  // the true converged value is 1.3333, clearing 1.3 by only 0.033. So a place
  // visited at half its target rate currently reads medium by a hair. If the
  // prose was the real intent, RELATIONSHIP_THRESHOLDS.medium needs to move
  // above 1.3333 (e.g. 1.4). Asserting the explicit constant — the
  // unambiguous, machine-readable half of the spec — until Bede decides.
  test('a place visited at half its half-life rate currently lands just inside medium', () => {
    const visits = Array.from({ length: 20 }, (_, i) => visit(daysBefore(ASOF, i * HALF_LIFE_DEFAULT * 2)));
    const score = computePersonRelationship({
      person: barePerson(), visits, hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    }).score;
    close(score, 1.3333, 0.02);
    assert.equal(levelForScore(score), 'medium');
    assert.ok(score - 1.3 < 0.04, 'it clears the medium threshold by a very thin margin');
  });
});

describe('trend (heating up / cooling down)', () => {
  test('isHeatingUp is false when both sides are effectively zero — no history either way', () => {
    assert.equal(isHeatingUp(0, 0), false);
    assert.equal(isHeatingUp(0.005, 0.008), false);
  });

  test('isHeatingUp requires clearing the relative threshold — small moves read as noise', () => {
    assert.equal(isHeatingUp(1.05, 1.0), false, 'a 5% bump does not clear the 10% threshold');
    assert.equal(isHeatingUp(1.11, 1.0), true);
  });

  test('isHeatingUp treats a real score appearing from nothing as heating up', () => {
    assert.equal(isHeatingUp(0.955, 0), true);
  });

  test('pure decay alone (no new visit) never registers as heating up, for any half-life', () => {
    // The property the window size was chosen around: with nothing new,
    // current == historical * 0.5^(TREND_WINDOW_FRACTION), independent of
    // the half-life itself. That ratio (~0.92) must stay under the 1.1
    // "real move" line, or a place with no activity at all would spuriously
    // read as heating up.
    const pureDecayRatio = 0.5 ** 0.12;
    assert.equal(isHeatingUp(pureDecayRatio, 1.0), false);
  });

  test('isPlaceCoolingDown is false with no visit history at all — nothing to be overdue from', () => {
    assert.equal(
      isPlaceCoolingDown({ place: { capacity_level: 'medium' }, lastVisitDate: null, recentCompletedCount: 0, relationshipLevel: 'medium', today: ASOF }),
      false
    );
  });

  test('isPlaceCoolingDown fires once elapsed time clears COOLING_THRESHOLD x the target cadence', () => {
    // capacity 'medium' x relationship 'medium' -> a 21-day target cadence
    // (config/scheduling.js CADENCE_DAYS). 1.25 x 21 = 26.25.
    const place = { capacity_level: 'medium' };
    assert.equal(
      isPlaceCoolingDown({ place, lastVisitDate: daysBefore(ASOF, 20), recentCompletedCount: 0, relationshipLevel: 'medium', today: ASOF }),
      false,
      '20 days is still under the 26.25-day line'
    );
    assert.equal(
      isPlaceCoolingDown({ place, lastVisitDate: daysBefore(ASOF, 27), recentCompletedCount: 0, relationshipLevel: 'medium', today: ASOF }),
      true,
      '27 days clears it'
    );
  });

  test('isPersonCoolingDown is false with no meaningful visit at all', () => {
    assert.equal(isPersonCoolingDown({ lastMeaningfulVisit: null, halfLifeDays: HALF_LIFE_FAST, today: ASOF }), false);
  });

  test('isPersonCoolingDown fires once elapsed time clears half the half-life', () => {
    assert.equal(isPersonCoolingDown({ lastMeaningfulVisit: daysBefore(ASOF, 14), halfLifeDays: HALF_LIFE_FAST, today: ASOF }), false, '14 days is under half of a 30-day half-life');
    assert.equal(isPersonCoolingDown({ lastMeaningfulVisit: daysBefore(ASOF, 16), halfLifeDays: HALF_LIFE_FAST, today: ASOF }), true, '16 days clears it');
  });

  test('personScoreAsOf excludes a visit that had not happened yet as of the reference date', () => {
    const visits = [visit(daysBefore(ASOF, 5)), visit(daysBefore(ASOF, 40))];
    const referenceDate = daysBefore(ASOF, 20);
    const asOfPast = personScoreAsOf({
      person: barePerson(), visits, hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, referenceDate,
    });
    // Only the 40-day-ago visit existed by referenceDate; unlike
    // computePersonRelationship's own "future visit clamps to full weight"
    // behavior (asOf-is-today callers), a visit outside the visible window is
    // excluded outright rather than credited at age zero.
    const expected = computePersonRelationship({
      person: barePerson(), visits: [visit(daysBefore(ASOF, 40))], hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: referenceDate,
    }).score;
    close(asOfPast, expected);
  });

  test('personScoreAsOf excludes a seed planted after the reference date', () => {
    const person = barePerson({ relationship_seed: 4.0, relationship_seeded_at: daysBefore(ASOF, 5) });
    const asOfPast = personScoreAsOf({
      person, visits: [], hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, referenceDate: daysBefore(ASOF, 20),
    });
    assert.equal(asOfPast, 0, 'the seed did not exist 20 days ago if it was only planted 5 days ago');
  });
});

describe('category half-life', () => {
  test('exact seeded category strings map to the fast clock; anything else defaults', () => {
    assert.equal(halfLifeForCategory('Hospice'), HALF_LIFE_FAST);
    assert.equal(halfLifeForCategory('Assisted Living & Senior Living'), HALF_LIFE_FAST);
    assert.equal(halfLifeForCategory('Rehabilitation Centers'), HALF_LIFE_FAST);
    assert.equal(halfLifeForCategory('Hospitals'), HALF_LIFE_FAST);
    // Real seeded categories that are deliberately NOT on the fast list.
    assert.equal(halfLifeForCategory('Churches'), HALF_LIFE_DEFAULT);
    assert.equal(halfLifeForCategory('Funeral Homes'), HALF_LIFE_DEFAULT);
    // A category invented later, and no category at all.
    assert.equal(halfLifeForCategory('Something Added In 2027'), HALF_LIFE_DEFAULT);
    assert.equal(halfLifeForCategory(null), HALF_LIFE_DEFAULT);
  });

  test('near-miss category names do NOT get the fast clock (guards the exact-string reconciliation)', () => {
    // These are the strings an earlier draft of the spec used; they are not
    // the real seeded values, and matching them loosely would silently give
    // the wrong clock to a whole category.
    assert.equal(halfLifeForCategory('Hospital'), HALF_LIFE_DEFAULT);
    assert.equal(halfLifeForCategory('Assisted Living'), HALF_LIFE_DEFAULT);
    assert.equal(halfLifeForCategory('Rehab'), HALF_LIFE_DEFAULT);
    assert.equal(halfLifeForCategory('Community Partner'), HALF_LIFE_DEFAULT);
  });

  test('the same visit history scores differently on a fast vs. default clock', () => {
    const visits = [visit(daysBefore(ASOF, 30))];
    const hospice = computePersonRelationship({
      person: barePerson(), visits, hasReferral: false, halfLifeDays: halfLifeForCategory('Hospice'), asOf: ASOF,
    });
    const church = computePersonRelationship({
      person: barePerson(), visits, hasReferral: false, halfLifeDays: halfLifeForCategory('Churches'), asOf: ASOF,
    });
    close(hospice.score, 0.5, 0.001, '30 days on a 30-day clock is exactly one half-life');
    close(church.score, 0.7071, 0.001, '30 days on a 60-day clock is only half a half-life');
    assert.ok(hospice.score < church.score, 'the fast clock must decay harder over the same elapsed time');
  });
});

describe('met-with weighting', () => {
  test('only a named_person visit carrying a person_id credits a person', () => {
    assert.equal(creditsPerson(visit(ASOF)), true);
    assert.equal(creditsPerson(visit(ASOF, { met_with_type: 'staff' })), false);
    assert.equal(creditsPerson(visit(ASOF, { met_with_type: 'receptionist' })), false);
    assert.equal(creditsPerson(visit(ASOF, { met_with_type: 'nobody' })), false);
    assert.equal(creditsPerson(visit(ASOF, { met_with_type: null })), false);
    // A named_person visit whose person record was detached can't credit anyone.
    assert.equal(creditsPerson(visit(ASOF, { person_id: null })), false);
  });

  test('a nobody visit never contributes to a person score', () => {
    const r = computePersonRelationship({
      person: barePerson(),
      visits: [visit(ASOF, { met_with_type: 'nobody' })],
      hasReferral: false,
      halfLifeDays: HALF_LIFE_DEFAULT,
      asOf: ASOF,
    });
    assert.equal(r.score, 0);
    assert.equal(r.visit_count_weighted, 0);
    assert.equal(r.last_meaningful_visit, null);
  });

  test('a nobody visit DOES contribute to a place floor_component', () => {
    const r = rollUpPlace({
      place: { id: 1, category: 'Churches' },
      personEntries: [],
      floorVisits: [visit(ASOF, { met_with_type: 'nobody', outcome: 'materials_only' })],
      asOf: ASOF,
    });
    close(r.floor_component, 0.05 * 0.25); // 0.0125 — present but shallow
    assert.equal(r.people_component, 0);
    close(r.score, 0.0125);
    assert.equal(r.level, 'weak');
  });

  test('visit weight multiplies the two axes (~80x between a real meeting and a front-desk drop-off)', () => {
    close(visitWeight(visit(ASOF)), 1.0);
    close(visitWeight(visit(ASOF, { met_with_type: 'nobody', outcome: 'materials_only' })), 0.0125);
    // An unrecognized legacy outcome falls to the documented floor rather than NaN.
    const legacy = visitWeight(visit(ASOF, { outcome: 'left_materials' }));
    assert.ok(Number.isFinite(legacy), 'a legacy outcome value must not produce NaN');
    close(legacy, 0.1);
    // An unrecognized met_with_type likewise floors instead of poisoning the sum.
    const unknownMetWith = visitWeight(visit(ASOF, { met_with_type: 'carrier_pigeon' }));
    assert.ok(Number.isFinite(unknownMetWith));
    close(unknownMetWith, 0.05);
  });

  test('last_meaningful_visit uses RAW weight and picks the most recent qualifying visit', () => {
    const r = computePersonRelationship({
      person: barePerson(),
      visits: [
        visit(daysBefore(ASOF, 400)), // substantive but ancient — still meaningful
        visit(daysBefore(ASOF, 5), { outcome: 'materials_only' }), // recent but only 0.25 raw
      ],
      hasReferral: false,
      halfLifeDays: HALF_LIFE_DEFAULT,
      asOf: ASOF,
    });
    assert.equal(
      r.last_meaningful_visit,
      daysBefore(ASOF, 400),
      'decay must not disqualify a visit that was substantive at the time'
    );
  });
});

describe('reciprocity multiplier', () => {
  test('each known personal detail adds 0.0625, to a max of 1.25', () => {
    close(reciprocityMultiplier(barePerson(), { hasReferral: false, requestedRecently: false }), 1.0);
    close(reciprocityMultiplier(barePerson({ email: 'a@b.c' }), { hasReferral: false, requestedRecently: false }), 1.0625);
    const allDetails = barePerson({ email: 'a@b.c', phone: '(402) 555-1234', preferences: 'likes coffee', birthday_month: 3, birthday_day: 14 });
    close(reciprocityMultiplier(allDetails, { hasReferral: false, requestedRecently: false }), 1.25);
  });

  test('a blank-but-present detail field does not count', () => {
    close(reciprocityMultiplier(barePerson({ preferences: '   ', email: '' }), { hasReferral: false, requestedRecently: false }), 1.0);
  });

  test('a half-set birthday does not count — both month and day are required', () => {
    close(reciprocityMultiplier(barePerson({ birthday_month: 3 }), { hasReferral: false, requestedRecently: false }), 1.0);
  });

  test('has-ever-referred is binary (x1.15) and never scales with volume', () => {
    const p = barePerson();
    close(reciprocityMultiplier(p, { hasReferral: true, requestedRecently: false }), 1.15);
    // There is deliberately no way to express "referred 50 times" here — the
    // model has no access to a count. See the axis-separation rule.
  });

  test('a person with every signal set never exceeds the x1.6 cap', () => {
    const maxed = barePerson({ email: 'a@b.c', phone: '(402) 555-1234', preferences: 'likes coffee', birthday_month: 3, birthday_day: 14 });
    const m = reciprocityMultiplier(maxed, { hasReferral: true, requestedRecently: true });
    close(m, 1.25 * 1.15 * 1.1); // 1.58125 — under the cap naturally
    assert.ok(m <= MAX_RECIPROCITY, `multiplier ${m} must never exceed ${MAX_RECIPROCITY}`);
  });

  test('they_requested only counts inside the trailing half-life', () => {
    const recent = computePersonRelationship({
      person: barePerson(),
      visits: [visit(daysBefore(ASOF, 10), { they_requested: true })],
      hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    close(recent.reciprocity_multiplier, 1.1);

    const stale = computePersonRelationship({
      person: barePerson(),
      visits: [visit(daysBefore(ASOF, 400), { they_requested: true })],
      hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    close(stale.reciprocity_multiplier, 1.0, 0.001, 'a request from over a year ago is not live reciprocity');
  });
});

describe('seed decay', () => {
  // NOTE: the written spec's example ("a 4.0 seed at 30-day half-life reads
  // ~2.0 after 30 days, ~0.5 after 60") is arithmetically off for the 60-day
  // figure — 4.0 halves to 2.0 at 30 days, 1.0 at 60, and only reaches 0.5 at
  // 90. The formula itself is unambiguous, so these assert the formula.
  const seeded = (seedDaysAgo) =>
    computePersonRelationship({
      person: barePerson({ relationship_seed: 4.0, relationship_seeded_at: daysBefore(ASOF, seedDaysAgo) }),
      visits: [], hasReferral: false, halfLifeDays: HALF_LIFE_FAST, asOf: ASOF,
    });

  test('a 4.0 seed on a 30-day clock halves every 30 days', () => {
    close(seeded(0).score, 4.0);
    close(seeded(30).score, 2.0);
    close(seeded(60).score, 1.0);
    close(seeded(90).score, 0.5);
  });

  test('the seed washes out on its own without any expiry logic', () => {
    // ~5 months at a 30-day half-life leaves roughly 3% of the original.
    assert.ok(seeded(150).score < 4.0 * 0.04);
    assert.ok(seeded(150).score > 0, 'it fades toward zero rather than being cut off');
  });

  test('the seed is NOT multiplied by reciprocity (it already encodes that judgment)', () => {
    const maxed = barePerson({
      relationship_seed: 4.0,
      relationship_seeded_at: ASOF,
      email: 'a@b.c', phone: '(402) 555-1234', preferences: 'likes coffee', birthday_month: 3, birthday_day: 14,
    });
    const r = computePersonRelationship({
      person: maxed, visits: [], hasReferral: true, halfLifeDays: HALF_LIFE_FAST, asOf: ASOF,
    });
    close(r.seed_component, 4.0, 0.001, 'seed must be added after the multiplier, not through it');
    close(r.score, 4.0);
    assert.ok(r.reciprocity_multiplier > 1, 'the multiplier is still reported for explainability');
  });

  test('seed and visit components are reported separately and sum to the score', () => {
    const r = computePersonRelationship({
      person: barePerson({ relationship_seed: 2.0, relationship_seeded_at: daysBefore(ASOF, 30) }),
      visits: [visit(ASOF)],
      hasReferral: false, halfLifeDays: HALF_LIFE_FAST, asOf: ASOF,
    });
    close(r.seed_component, 1.0);
    close(r.visit_component, 1.0);
    close(r.score, 2.0);
  });

  test('a seed with no seeded_at date is ignored rather than treated as never decaying', () => {
    const r = computePersonRelationship({
      person: barePerson({ relationship_seed: 4.0, relationship_seeded_at: null }),
      visits: [], hasReferral: false, halfLifeDays: HALF_LIFE_FAST, asOf: ASOF,
    });
    assert.equal(r.seed_component, 0);
  });
});

describe('place rollup', () => {
  const entry = (id, score) => ({ person: { id, name: `P${id}` }, relationship: { score } });

  test('three people at 4.0 roll up to 7.0 — not 12.0 (plain sum) and not 4.0 (max only)', () => {
    const r = rollUpPlace({
      place: { id: 1, category: 'Churches' },
      personEntries: [entry(1, 4.0), entry(2, 4.0), entry(3, 4.0)],
      floorVisits: [], asOf: ASOF,
    });
    close(r.people_component, 7.0); // 4 + 2 + 1
    close(r.score, 7.0);
    assert.equal(r.level, 'strong');
  });

  test('contributors are sorted by score descending regardless of input order', () => {
    const r = rollUpPlace({
      place: { id: 1, category: 'Churches' },
      personEntries: [entry(1, 0.5), entry(2, 4.0), entry(3, 2.0)],
      floorVisits: [], asOf: ASOF,
    });
    assert.deepEqual(r.contributors.map((c) => c.person_id), [2, 3, 1]);
    close(r.people_component, 4.0 + 0.5 * 2.0 + 0.25 * 0.5);
  });

  test('one champion beats many lukewarm contacts', () => {
    const champion = rollUpPlace({
      place: { id: 1, category: 'Churches' }, personEntries: [entry(1, 4.0)], floorVisits: [], asOf: ASOF,
    });
    const lukewarm = rollUpPlace({
      place: { id: 2, category: 'Churches' },
      personEntries: Array.from({ length: 6 }, (_, i) => entry(i + 1, 0.8)),
      floorVisits: [], asOf: ASOF,
    });
    assert.ok(champion.score > lukewarm.score);
  });

  test('zero-scoring contacts cannot dilute a strong one, and are omitted from contributors', () => {
    const r = rollUpPlace({
      place: { id: 1, category: 'Churches' },
      personEntries: [entry(1, 4.0), ...Array.from({ length: 10 }, (_, i) => entry(i + 2, 0))],
      floorVisits: [], asOf: ASOF,
    });
    close(r.score, 4.0, 0.001, 'ten zero-scoring people must add exactly nothing');
    assert.equal(r.contributors.length, 1);
    assert.equal(r.contributors[0].person_id, 1);
  });

  test('contributors report their own weight and post-weight contribution', () => {
    const r = rollUpPlace({
      place: { id: 1, category: 'Churches' },
      personEntries: [entry(1, 4.0), entry(2, 2.0)],
      floorVisits: [], asOf: ASOF,
    });
    assert.equal(r.contributors[0].weight, 1);
    close(r.contributors[0].contribution, 4.0);
    assert.equal(r.contributors[1].weight, 0.5);
    close(r.contributors[1].contribution, 1.0);
  });
});

describe('override precedence', () => {
  const base = {
    place: { id: 1, category: 'Churches' },
    personEntries: [{ person: { id: 1, name: 'P1' }, relationship: { score: 0.1 } }],
    floorVisits: [],
    asOf: ASOF,
  };

  test('with no override, effective_level follows the computed value', () => {
    const r = rollUpPlace(base);
    assert.equal(r.level, 'weak');
    assert.equal(r.effective_level, 'weak');
    assert.equal(r.is_overridden, false);
    assert.equal(r.override, null);
  });

  test('an override wins, but the computed value is still reported alongside it', () => {
    const r = rollUpPlace({
      ...base,
      place: {
        id: 1, category: 'Churches',
        relationship_level_override: 'strong',
        relationship_override_at: '2026-07-12T10:00:00.000Z',
        relationship_override_by: 3,
      },
      overrideUserName: 'Bede Fulton',
    });
    assert.equal(r.effective_level, 'strong');
    assert.equal(r.level, 'weak', 'the computed value must survive so the UI can show the divergence');
    assert.equal(r.is_overridden, true);
    assert.equal(r.override.level, 'strong');
    assert.equal(r.override.by_name, 'Bede Fulton');
    assert.equal(r.override.by_user_id, 3);
  });

  test('clearing the override restores computed control', () => {
    const r = rollUpPlace({ ...base, place: { id: 1, category: 'Churches', relationship_level_override: null } });
    assert.equal(r.is_overridden, false);
    assert.equal(r.effective_level, r.level);
  });
});

describe('empty cases', () => {
  test('a person with no visits and no seed scores 0 and reads weak', () => {
    const r = computePersonRelationship({
      person: barePerson(), visits: [], hasReferral: false, halfLifeDays: HALF_LIFE_DEFAULT, asOf: ASOF,
    });
    assert.equal(r.score, 0);
    assert.equal(r.level, 'weak');
    assert.equal(r.last_meaningful_visit, null);
  });

  test('a place with no people and no visits scores 0 and reads weak', () => {
    const r = rollUpPlace({ place: { id: 1, category: 'Churches' }, personEntries: [], floorVisits: [], asOf: ASOF });
    assert.equal(r.score, 0);
    assert.equal(r.level, 'weak');
    assert.deepEqual(r.contributors, []);
  });

  test('the shared empty shape is weak and inert', () => {
    assert.equal(EMPTY_PLACE_RELATIONSHIP.score, 0);
    assert.equal(EMPTY_PLACE_RELATIONSHIP.effective_level, 'weak');
    assert.equal(EMPTY_PLACE_RELATIONSHIP.is_overridden, false);
  });

  test('levelForScore boundaries are inclusive at the threshold', () => {
    assert.equal(levelForScore(3.4), 'strong');
    assert.equal(levelForScore(3.399), 'medium');
    assert.equal(levelForScore(1.3), 'medium');
    assert.equal(levelForScore(1.299), 'weak');
    assert.equal(levelForScore(0), 'weak');
  });

  test('decayFactor is well-defined at zero age', () => {
    assert.equal(decayFactor(0, HALF_LIFE_DEFAULT), 1);
  });
});

// The pure suite above can't catch a bad column name or a mis-keyed groupBy —
// exactly the class of bug that shipped once before in this subsystem (a
// `r.place_id` that was really `r.id`, which the pure tests sailed past and
// only a live run caught). These run the real queries against a real,
// migrated, in-memory SQLite database.
describe('bulk DB paths', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();

    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });
    await db('categories').insert([{ name: 'Hospice' }, { name: 'Churches' }]).onConflict('name').ignore();

    // Place 1 (Hospice, fast clock): one strong contact + one floor visit.
    // Place 2 (Churches, default clock): one contact with a seed, no visits.
    // Place 3: nothing at all.
    await db('places').insert([
      { id: 1, name: 'Fast Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 2, name: 'Slow Place', category: 'Churches', tier: 3, priority_score: 25 },
      { id: 3, name: 'Empty Place', category: 'Churches', tier: 3, priority_score: 25 },
    ]);
    await db('people').insert([
      { id: 1, place_id: 1, name: 'Sharon K.', email: 's@test.local', phone: '(402) 555-0100' },
      { id: 2, place_id: 1, name: 'Marcus T.' },
      { id: 3, place_id: 2, name: 'Seeded Only', relationship_seed: 4.0, relationship_seeded_at: daysBefore(ASOF, 60) },
    ]);
    await insertVisit(db, {
      place_id: 1, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 15), place_name: 'Fast Place',
      encounters: [{ person_id: 1, met_with_type: 'named_person', outcome: 'substantive' }],
    });
    await insertVisit(db, {
      place_id: 1, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 30), place_name: 'Fast Place',
      encounters: [{ person_id: 2, met_with_type: 'named_person', outcome: 'brief' }],
    });
    await insertVisit(db, {
      place_id: 1, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 5), place_name: 'Fast Place',
      encounters: [{ person_id: null, met_with_type: 'receptionist', outcome: 'materials_only' }],
    });
    // A planned (not completed) visit must be ignored entirely — including
    // its encounter, which is exactly what the join's `v.status` filter is
    // for now that the two live in different tables.
    await insertVisit(db, {
      place_id: 1, user_id: 1, status: 'planned', scheduled_date: ASOF, place_name: 'Fast Place',
      encounters: [{ person_id: 1, met_with_type: 'named_person', outcome: 'substantive' }],
    });
    await db('referrals').insert({ place_id: 1, person_id: 1, user_id: 1, referral_date: daysBefore(ASOF, 20) });
  });

  after(async () => {
    await db.destroy();
  });

  test('computeRelationshipForPlaces returns a real score for a populated place', async () => {
    const byPlace = await computeRelationshipForPlaces(db, [1], { asOf: ASOF });
    const r = byPlace.get(1);
    assert.ok(r, 'place 1 must be present in the result map');
    assert.ok(r.score > 0);
    assert.ok(r.people_component > 0, 'named-person visits must land in people_component');
    assert.ok(r.floor_component > 0, 'the receptionist visit must land in floor_component');
    assert.equal(r.contributors.length, 2);
    assert.equal(r.contributors[0].name, 'Sharon K.', 'the substantive+referring contact should rank first');
  });

  test('a completed visit is required — planned visits are ignored', async () => {
    const byPerson = await computeRelationshipForPeople(db, [1], { asOf: ASOF });
    const r = byPerson.get(1);
    // One completed substantive visit 15 days ago on a 30-day (Hospice) clock:
    // 1.0 * 0.5^(15/30) = 0.7071, times reciprocity (email+phone = 1.125,
    // has referred = 1.15).
    close(r.visit_count_weighted, 0.7071, 0.001, 'only the single completed visit counts');
    close(r.reciprocity_multiplier, 1.125 * 1.15, 0.001);
  });

  test('half-life follows the person\'s current place category through the join', async () => {
    const byPerson = await computeRelationshipForPeople(db, [2], { asOf: ASOF });
    // Marcus: one 'brief' (0.6) visit 30 days ago at a Hospice place -> exactly
    // one half-life -> 0.3. On the default 60-day clock it would be 0.424.
    close(byPerson.get(2).visit_count_weighted, 0.3, 0.001);
  });

  test('a seeded person with zero visits still scores, and decays on their category clock', async () => {
    const byPlace = await computeRelationshipForPlaces(db, [2], { asOf: ASOF });
    const r = byPlace.get(2);
    // 4.0 seeded 60 days ago on the Churches (60-day) clock -> exactly 2.0.
    close(r.score, 2.0, 0.001);
    assert.equal(r.level, 'medium');
    assert.equal(r.contributors.length, 1);
  });

  test('an empty place resolves to a zero score rather than being absent or NaN', async () => {
    const byPlace = await computeRelationshipForPlaces(db, [3], { asOf: ASOF });
    const r = byPlace.get(3);
    assert.equal(r.score, 0);
    assert.equal(r.effective_level, 'weak');
    assert.deepEqual(r.contributors, []);
  });

  test('bulk parity: one call for three places equals three single-place calls', async () => {
    const bulk = await computeRelationshipForPlaces(db, [1, 2, 3], { asOf: ASOF });
    const single = new Map();
    for (const id of [1, 2, 3]) {
      const one = await computeRelationshipForPlaces(db, [id], { asOf: ASOF });
      single.set(id, one.get(id));
    }
    for (const id of [1, 2, 3]) {
      assert.deepEqual(bulk.get(id), single.get(id), `place ${id} must be identical via either path`);
    }
  });

  test('bulk parity holds for people too', async () => {
    const bulk = await computeRelationshipForPeople(db, [1, 2, 3], { asOf: ASOF });
    for (const id of [1, 2, 3]) {
      const one = await computeRelationshipForPeople(db, [id], { asOf: ASOF });
      assert.deepEqual(bulk.get(id), one.get(id), `person ${id} must be identical via either path`);
    }
  });

  test('an empty id list short-circuits to an empty map without querying', async () => {
    assert.equal((await computeRelationshipForPlaces(db, [], { asOf: ASOF })).size, 0);
    assert.equal((await computeRelationshipForPeople(db, [], { asOf: ASOF })).size, 0);
  });

  test('an override set on a real row surfaces with the overriding user\'s name', async () => {
    // Place 1 computes to 'weak' on this data, so override with 'strong' to
    // create a real divergence for the UI contract to surface.
    await db('places').where({ id: 1 }).update({
      relationship_level_override: 'strong',
      relationship_override_at: new Date().toISOString(),
      relationship_override_by: 1,
    });
    const r = (await computeRelationshipForPlaces(db, [1], { asOf: ASOF })).get(1);
    assert.equal(r.effective_level, 'strong');
    assert.equal(r.is_overridden, true);
    assert.equal(r.override.by_name, 'Test Rep');
    assert.equal(r.level, 'weak', 'the computed value must survive alongside the override');
    assert.notEqual(r.level, r.effective_level, 'the divergence must be visible to the UI');
    await db('places').where({ id: 1 }).update({
      relationship_level_override: null, relationship_override_at: null, relationship_override_by: null,
    });
  });

  test('includeTrend defaults to false — the bulk/list path never computes it', async () => {
    const r = (await computeRelationshipForPlaces(db, [1], { asOf: ASOF })).get(1);
    assert.equal(r.trend, null);
    const p = (await computeRelationshipForPeople(db, [1], { asOf: ASOF })).get(1);
    assert.equal(p.trend, null);
  });

  test('a place with a recent (even non-meaningful) visit is neither heating nor cooling', async () => {
    // Place 1's most recent completed visit — of ANY kind, including the
    // receptionist drop-off — was 5 days ago, well inside its ~21-day target
    // cadence (medium capacity default x weak relationship). Cooling down
    // cares about "did we show up," not "did we meet someone," so this must
    // NOT read as cooling just because its named-person contacts are stale.
    const r = (await computeRelationshipForPlaces(db, [1], { asOf: ASOF, includeTrend: true })).get(1);
    assert.equal(r.trend, null);
  });

  test('a place well past its own target cadence reads as cooling down', async () => {
    await db('places').insert({ id: 5, name: 'Overdue Place', category: 'Hospice', tier: 3, priority_score: 25, capacity_level: 'medium' });
    // A single old, unremarkable visit: enough to give the place a
    // (barely-nonzero, 'weak') score and a lastVisitDate, without any
    // named-person contact to make it 'heating up' territory. 40 days on a
    // medium/weak 21-day cadence is 1.9x — well past the 1.25x line.
    await insertVisit(db, {
      place_id: 5, user_id: 1, status: 'completed',
      scheduled_date: daysBefore(ASOF, 40), place_name: 'Overdue Place',
      encounters: [{ person_id: null, met_with_type: 'receptionist', outcome: 'materials_only' }],
    });
    const r = (await computeRelationshipForPlaces(db, [5], { asOf: ASOF, includeTrend: true })).get(5);
    assert.equal(r.level, 'weak');
    assert.equal(r.trend, 'down');
  });

  test('a never-visited place is not cooling down — there is nothing to be overdue from', async () => {
    const r = (await computeRelationshipForPlaces(db, [3], { asOf: ASOF, includeTrend: true })).get(3);
    assert.equal(r.score, 0);
    assert.equal(r.trend, null);
  });

  test('a fresh visit inside the heating-up window reads as heating up, for both the person and the place', async () => {
    await db('places').insert({ id: 4, name: 'Fresh Place', category: 'Hospice', tier: 1, priority_score: 75 });
    await db('people').insert({ id: 4, place_id: 4, name: 'New Contact' });
    // A substantive visit just 2 days ago, inside the ~4-day heating-up
    // window for a 30-day (Hospice) half-life — there was no relationship at
    // all as of the reference date, so this must register as a real gain.
    await insertVisit(db, {
      place_id: 4, user_id: 1, status: 'completed',
      scheduled_date: daysBefore(ASOF, 2), place_name: 'Fresh Place',
      encounters: [{ person_id: 4, met_with_type: 'named_person', outcome: 'substantive' }],
    });

    const place = (await computeRelationshipForPlaces(db, [4], { asOf: ASOF, includeTrend: true })).get(4);
    assert.equal(place.trend, 'up');
    const person = (await computeRelationshipForPeople(db, [4], { asOf: ASOF, includeTrend: true })).get(4);
    assert.equal(person.trend, 'up');
  });

  test('a person\'s own cooldown is independent of their place — it does not inherit the place\'s status', async () => {
    // Marcus (person 2, at Fast Place/Hospice) has one 'brief' visit 30 days
    // ago — his last MEANINGFUL visit — which is past half of Hospice's
    // 30-day half-life (15 days), so HE reads as cooling down even though
    // Fast Place itself (person 1's more recent activity) does not.
    const marcus = (await computeRelationshipForPeople(db, [2], { asOf: ASOF, includeTrend: true })).get(2);
    assert.equal(marcus.trend, 'down');
  });

  test('trend is suppressed under a manual override', async () => {
    await db('places').where({ id: 1 }).update({
      relationship_level_override: 'strong', relationship_override_at: new Date().toISOString(), relationship_override_by: 1,
    });
    const r = (await computeRelationshipForPlaces(db, [1], { asOf: ASOF, includeTrend: true })).get(1);
    assert.equal(r.is_overridden, true);
    assert.equal(r.trend, null, 'an override is the answer — a computed direction alongside it would just contradict it');
    await db('places').where({ id: 1 }).update({
      relationship_level_override: null, relationship_override_at: null, relationship_override_by: null,
    });
  });
});

// The single real risk in the visit_encounters split is that the new join
// silently changes WHAT the scoring functions see — a wrong column name, a
// dropped row, a row duplicated by a bad join condition. None of those
// announce themselves; they just quietly move every number in the app. So
// this suite pins the math across the migration itself: seed FLAT pre-split
// rows, compute what the scores SHOULD be straight from those rows using the
// pure functions (which take plain arrays and are untouched by any schema —
// they ARE the math), run the split, then assert the real post-split DB path
// lands on exactly those numbers.
//
// EXACT equality, never a tolerance: the inputs are unchanged by definition,
// so any difference at all is a bug, not rounding.
describe('the visit_encounters split', () => {
  let db;

  // A single afternoon at place 10 where the rep met three people. Pre-split
  // this was three rows; post-split it must be ONE trip with three encounters.
  const TRIP_M_DATE = daysBefore(ASOF, 12);
  // created_at is the migration's PRIMARY trip signal (see groupIntoTrips's
  // header): rows written by one POST land inside the same second or two.
  const TRIP_M_CREATED = '2026-07-22 14:30:00';
  const TRIP_M_CREATED_1S = '2026-07-22 14:30:01';

  // Two genuinely separate trips to place 11 on the same day — a morning
  // drop-off and an afternoon meeting. Their created_at values are inside the
  // merge window, so ONLY the differing notes stop them collapsing into one.
  // This is the exact bug class the grouping key was designed around.
  const PAIR_DATE = daysBefore(ASOF, 20);

  const PLACE_IDS = [10, 11, 12];
  const PERSON_IDS = [100, 101, 102, 103];

  // Flat, pre-split `visits` rows: one row per encounter, encounter fields
  // inline. Deliberately spread across met_with_type, outcome, they_requested,
  // status, and the whole decay curve so a join that drops or duplicates any
  // one class of row moves a score somewhere.
  const PRE_SPLIT_VISITS = [
    // --- the multi-encounter trip ---
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: TRIP_M_DATE, place_name: 'Hospice A', notes: 'Quarterly check-in', created_at: TRIP_M_CREATED,
      person_id: 100, person_name: 'Alice A.', person_title: 'Director', person_email: 'alice@test.local', person_phone: '(402) 555-0001',
      met_with_type: 'named_person', outcome: 'substantive', they_requested: true },
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: TRIP_M_DATE, place_name: 'Hospice A', notes: 'Quarterly check-in', created_at: TRIP_M_CREATED_1S,
      person_id: 101, person_name: 'Bob B.', met_with_type: 'named_person', outcome: 'brief', they_requested: false },
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: TRIP_M_DATE, place_name: 'Hospice A', notes: 'Quarterly check-in', created_at: TRIP_M_CREATED_1S,
      person_id: null, met_with_type: 'staff', outcome: 'introduced_new', they_requested: false },

    // --- the same-day / different-notes pair ---
    { place_id: 11, user_id: 1, status: 'completed', scheduled_date: PAIR_DATE, place_name: 'Church B', notes: 'Morning drop-off', created_at: '2026-07-14 09:00:00',
      person_id: null, met_with_type: 'receptionist', outcome: 'materials_only', they_requested: false },
    { place_id: 11, user_id: 1, status: 'completed', scheduled_date: PAIR_DATE, place_name: 'Church B', notes: 'Afternoon meeting', created_at: '2026-07-14 09:00:01',
      person_id: 102, person_name: 'Cara C.', met_with_type: 'named_person', outcome: 'substantive', they_requested: false },

    // --- ordinary single-encounter trips, spread across the decay curve ---
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 45), place_name: 'Hospice A', created_at: '2026-06-19 10:00:00',
      person_id: 100, met_with_type: 'named_person', outcome: 'materials_only', they_requested: false },
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 3), place_name: 'Hospice A', created_at: '2026-07-31 16:00:00',
      person_id: null, met_with_type: 'nobody', outcome: 'unavailable', they_requested: false },
    // A 'named_person' row whose person record was since detached — must fall
    // through to the place FLOOR, never credit anyone. The exact case
    // creditsPerson exists for, and the one most likely to be mis-shuffled by
    // a join that reads person_id off the wrong side.
    { place_id: 10, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 8), place_name: 'Hospice A', created_at: '2026-07-26 11:00:00',
      person_id: null, person_name: 'Departed D.', met_with_type: 'named_person', outcome: 'substantive', they_requested: false },
    // they_requested TRUE but ancient — outside the trailing half-life, so it
    // must NOT switch the reciprocity multiplier on.
    { place_id: 11, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 90), place_name: 'Church B', created_at: '2026-05-05 09:00:00',
      person_id: 102, met_with_type: 'named_person', outcome: 'introduced_new', they_requested: true },
    // Legacy/unrecognized values on both axes — these must land on the
    // documented floors rather than vanish or produce NaN.
    { place_id: 11, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 60), place_name: 'Church B', created_at: '2026-06-04 09:00:00',
      person_id: null, met_with_type: 'carrier_pigeon', outcome: 'left_materials', they_requested: false },
    // A place with no people at all — pure floor.
    { place_id: 12, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 30), place_name: 'Bare Place', created_at: '2026-07-04 09:00:00',
      person_id: null, met_with_type: 'receptionist', outcome: 'declined', they_requested: false },
    { place_id: 12, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 200), place_name: 'Bare Place', created_at: '2026-01-15 09:00:00',
      person_id: null, met_with_type: 'staff', outcome: 'brief', they_requested: false },

    // --- non-completed rows: invisible to scoring on BOTH sides of the split.
    // Post-split the status lives on the trip while the encounter lives
    // elsewhere, so these are what prove the join's `v.status` filter works.
    { place_id: 10, user_id: 1, status: 'planned', scheduled_date: ASOF, place_name: 'Hospice A', created_at: '2026-08-03 08:00:00',
      person_id: 100, met_with_type: 'named_person', outcome: 'substantive', they_requested: true },
    { place_id: 10, user_id: 1, status: 'skipped', scheduled_date: daysBefore(ASOF, 70), place_name: 'Hospice A', created_at: '2026-05-25 08:00:00',
      person_id: 101, met_with_type: 'named_person', outcome: 'substantive', they_requested: false },
  ];

  // Filled in by before(), from the PRE-split rows, using only pure functions.
  let expectedPeople;
  let expectedPlaces;
  let preSplitVisitCount;

  before(async () => {
    db = memoryDb();
    // Migrate to the point IMMEDIATELY BEFORE the split: everything, then
    // step exactly one migration back (migrate.down() reverts a single
    // migration; migrate.rollback() would undo the whole batch).
    await db.migrate.latest();
    await db.migrate.down();

    // Guard the assumption above rather than trusting it — if another
    // migration is ever added after the split, this suite would otherwise
    // silently start testing the wrong boundary.
    assert.equal(await db.schema.hasTable('visit_encounters'), false, 'must be sitting on the PRE-split schema');
    assert.equal(await db.schema.hasColumn('visits', 'met_with_type'), true, 'pre-split visits still carries the encounter columns');

    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });
    await db('places').insert([
      { id: 10, name: 'Hospice A', category: 'Hospice', tier: 1, priority_score: 80 },   // fast clock
      { id: 11, name: 'Church B', category: 'Churches', tier: 2, priority_score: 50 },   // default clock
      { id: 12, name: 'Bare Place', category: 'Funeral Homes', tier: 3, priority_score: 20 },
    ]);
    await db('people').insert([
      // Every reciprocity signal is represented across these four: contact
      // details, a birthday, preferences, a referral, a seed, and one person
      // with nothing at all.
      { id: 100, place_id: 10, name: 'Alice A.', email: 'alice@test.local', phone: '(402) 555-0001' },
      { id: 101, place_id: 10, name: 'Bob B.' },
      { id: 102, place_id: 11, name: 'Cara C.', preferences: 'black coffee', birthday_month: 4, birthday_day: 9,
        relationship_seed: 3.0, relationship_seeded_at: daysBefore(ASOF, 40) },
      { id: 103, place_id: 11, name: 'Dan D.' }, // no visits — a genuine zero
    ]);
    await db('referrals').insert({ place_id: 10, person_id: 100, user_id: 1, referral_date: daysBefore(ASOF, 25) });
    await db('visits').insert(PRE_SPLIT_VISITS);
    preSplitVisitCount = PRE_SPLIT_VISITS.length;

    // The OLD query, verbatim: exactly the six columns relationship.js's
    // VISIT_FIELDS used to pull off the flat table. These rows are the
    // ground truth the post-split join has to reproduce.
    const preRows = await db('visits')
      .where({ status: 'completed' })
      .select('place_id', 'person_id', 'met_with_type', 'outcome', 'scheduled_date', 'they_requested');

    const people = await db('people').whereIn('id', PERSON_IDS).select('*');
    const places = await db('places').whereIn('id', PLACE_IDS).select('*');
    const categoryByPlace = new Map(places.map((p) => [p.id, p.category]));
    const referredIds = new Set([100]);

    // Expected PERSON scores. Mirrors computeRelationshipForPeople's own
    // grouping (a person's visits are their own, wherever they happened; the
    // half-life comes from their currently-assigned place's category).
    expectedPeople = new Map();
    for (const person of people) {
      expectedPeople.set(
        person.id,
        computePersonRelationship({
          person,
          visits: preRows.filter((r) => r.person_id === person.id),
          hasReferral: referredIds.has(person.id),
          halfLifeDays: halfLifeForCategory(categoryByPlace.get(person.place_id)),
          asOf: ASOF,
        })
      );
    }

    // Expected PLACE scores. Mirrors computeRelationshipForPlaces: people
    // rolled up with diminishing returns, plus a floor from every visit that
    // didn't credit a named person.
    expectedPlaces = new Map();
    for (const place of places) {
      const halfLifeDays = halfLifeForCategory(place.category);
      const placeRows = preRows.filter((r) => r.place_id === place.id);
      const personEntries = people
        .filter((p) => p.place_id === place.id)
        .map((person) => ({
          person,
          relationship: computePersonRelationship({
            person,
            visits: preRows.filter((r) => r.person_id === person.id),
            hasReferral: referredIds.has(person.id),
            halfLifeDays,
            asOf: ASOF,
          }),
        }));
      expectedPlaces.set(
        place.id,
        rollUpPlace({ place, personEntries, floorVisits: placeRows.filter((r) => !creditsPerson(r)), asOf: ASOF })
      );
    }

    // Everything above was computed from the flat schema. NOW split it.
    await db.migrate.up();
    assert.equal(await db.schema.hasTable('visit_encounters'), true, 'the split migration must have run');
    assert.equal(await db.schema.hasColumn('visits', 'met_with_type'), false, 'encounter columns must be gone from visits');
  });

  after(async () => {
    await db.destroy();
  });

  describe('scoring parity', () => {
    test('every person score is bit-for-bit identical across the split', async () => {
      const actual = await computeRelationshipForPeople(db, PERSON_IDS, { asOf: ASOF });
      assert.equal(actual.size, PERSON_IDS.length, 'no person may drop out of the result map');
      for (const id of PERSON_IDS) {
        const a = actual.get(id);
        const e = expectedPeople.get(id);
        assert.equal(a.score, e.score, `person ${id} score`);
        assert.equal(a.level, e.level, `person ${id} level`);
        assert.equal(a.visit_count_weighted, e.visit_count_weighted, `person ${id} weighted visit count`);
        assert.equal(a.reciprocity_multiplier, e.reciprocity_multiplier, `person ${id} reciprocity`);
        assert.equal(a.seed_component, e.seed_component, `person ${id} seed component`);
        assert.equal(a.visit_component, e.visit_component, `person ${id} visit component`);
        assert.equal(a.last_meaningful_visit, e.last_meaningful_visit, `person ${id} last meaningful visit`);
      }
    });

    test('every place score is bit-for-bit identical across the split', async () => {
      const actual = await computeRelationshipForPlaces(db, PLACE_IDS, { asOf: ASOF });
      assert.equal(actual.size, PLACE_IDS.length, 'no place may drop out of the result map');
      for (const id of PLACE_IDS) {
        const a = actual.get(id);
        const e = expectedPlaces.get(id);
        assert.equal(a.score, e.score, `place ${id} score`);
        assert.equal(a.level, e.level, `place ${id} level`);
        assert.equal(a.people_component, e.people_component, `place ${id} people component`);
        assert.equal(a.floor_component, e.floor_component, `place ${id} floor component`);
        assert.deepEqual(
          a.contributors.map((c) => [c.person_id, c.score, c.contribution]),
          e.contributors.map((c) => [c.person_id, c.score, c.contribution]),
          `place ${id} contributors`
        );
      }
    });

    // Guards the assertion above from passing vacuously. If the fixture ever
    // degenerates to all-zeroes, "identical" would still hold and the parity
    // test would stop proving anything.
    test('the parity fixture actually produces non-trivial scores to compare', async () => {
      const people = await computeRelationshipForPeople(db, PERSON_IDS, { asOf: ASOF });
      const places = await computeRelationshipForPlaces(db, PLACE_IDS, { asOf: ASOF });
      assert.ok(people.get(100).score > 0, 'Alice must score something');
      assert.ok(people.get(102).seed_component > 0, 'Cara must carry a live seed');
      assert.equal(people.get(103).score, 0, 'Dan has no history at all — a real zero, not a missing row');
      for (const id of PLACE_IDS) assert.ok(places.get(id).score > 0, `place ${id} must score something`);
      assert.ok(places.get(10).floor_component > 0, 'the detached-person and nobody visits must land on the floor');
      assert.ok(places.get(12).people_component === 0, 'a place with no people has no people component');
    });

    // The narrowest possible statement of "the join didn't drop or duplicate
    // anything": every completed encounter is still visible to the model
    // exactly once. A join on the wrong key is the classic way to silently
    // fan a place's floor out by a factor of N.
    test('the join sees each completed encounter exactly once', async () => {
      const completedTrips = await db('visits').where({ status: 'completed' }).select('id');
      const encounters = await db('visit_encounters').whereIn('visit_id', completedTrips.map((t) => t.id));
      const alice = (await computeRelationshipForPeople(db, [100], { asOf: ASOF })).get(100);
      const aliceEncounters = encounters.filter((e) => e.person_id === 100 && e.met_with_type === 'named_person');
      assert.equal(aliceEncounters.length, 2, 'fixture sanity: Alice has two crediting encounters');
      assert.equal(alice.visit_count_weighted, expectedPeople.get(100).visit_count_weighted);
    });
  });

  describe('the migration itself', () => {
    test('no encounter was lost or invented — one per pre-split row', async () => {
      const [{ count }] = await db('visit_encounters').count('* as count');
      assert.equal(Number(count), preSplitVisitCount);
    });

    test('the multi-encounter trip collapsed into ONE visit with three encounters', async () => {
      const trips = await db('visits').where({ place_id: 10, scheduled_date: TRIP_M_DATE }).select('*');
      assert.equal(trips.length, 1, 'three rows written by one POST are one trip');
      assert.equal(trips[0].notes, 'Quarterly check-in', 'the trip keeps its shared notes');

      const encounters = await db('visit_encounters').where({ visit_id: trips[0].id }).orderBy('id');
      assert.equal(encounters.length, 3);
      assert.deepEqual(encounters.map((e) => e.person_id), [100, 101, null]);
      assert.deepEqual(encounters.map((e) => e.met_with_type), ['named_person', 'named_person', 'staff']);
      assert.deepEqual(encounters.map((e) => e.outcome), ['substantive', 'brief', 'introduced_new']);
    });

    test('the same-day / different-notes pair did NOT merge', async () => {
      // The whole reason created_at is only the FIRST half of the grouping
      // key: these two rows landed inside the same insert window, so a
      // created_at-only rule would have merged a morning drop-off and an
      // afternoon meeting into one trip — an unrecoverable loss, since down()
      // cannot un-merge. The differing notes veto the merge.
      const trips = await db('visits').where({ place_id: 11, scheduled_date: PAIR_DATE }).orderBy('id').select('*');
      assert.equal(trips.length, 2, 'two genuinely separate trips must stay two trips');
      assert.deepEqual(trips.map((t) => t.notes), ['Morning drop-off', 'Afternoon meeting']);
      for (const trip of trips) {
        const encounters = await db('visit_encounters').where({ visit_id: trip.id });
        assert.equal(encounters.length, 1, 'each kept exactly its own encounter');
      }
    });

    test('encounter data survived intact — met_with_type, outcome, they_requested and the person snapshot', async () => {
      const alice = await db('visit_encounters').where({ person_id: 100, met_with_type: 'named_person', outcome: 'substantive' }).first();
      assert.equal(alice.person_name, 'Alice A.');
      assert.equal(alice.person_title, 'Director');
      assert.equal(alice.person_email, 'alice@test.local');
      assert.equal(alice.person_phone, '(402) 555-0001');
      assert.ok(alice.they_requested, 'they_requested must survive as true');

      // The detached-person snapshot: no person_id, but the name is still
      // readable — the whole point of detach-not-delete carrying over.
      const departed = await db('visit_encounters').where({ person_name: 'Departed D.' }).first();
      assert.equal(departed.person_id, null);
      assert.equal(departed.met_with_type, 'named_person');

      // Legacy values are moved verbatim, not normalized — the model floors
      // them at read time (see UNKNOWN_*_WEIGHT), the migration doesn't guess.
      const legacy = await db('visit_encounters').where({ met_with_type: 'carrier_pigeon' }).first();
      assert.equal(legacy.outcome, 'left_materials');
    });

    test('non-completed trips kept their encounters too — they are hidden by status, not deleted', async () => {
      const planned = await db('visits').where({ status: 'planned' }).first();
      const encounters = await db('visit_encounters').where({ visit_id: planned.id });
      assert.equal(encounters.length, 1, 'a planned trip still owns its encounter row');
    });
  });
});

// The partial unique index is the only thing standing between the model and
// double-counting one conversation. It's PARTIAL for a reason that's easy to
// get wrong in a rewrite: person_id is nullable by design (staff/receptionist/
// nobody encounters have no person at all), so a plain unique index would cap
// a trip at one anonymous encounter on Postgres-like engines and generally
// misrepresent what the constraint is for.
describe('visit_encounters unique-person index', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });
    await db('places').insert({ id: 1, name: 'Somewhere', category: 'Churches', tier: 2, priority_score: 50 });
    await db('people').insert([{ id: 1, place_id: 1, name: 'A' }, { id: 2, place_id: 1, name: 'B' }]);
    await db('visits').insert([
      { id: 1, place_id: 1, user_id: 1, status: 'completed', scheduled_date: ASOF, place_name: 'Somewhere' },
      { id: 2, place_id: 1, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 7), place_name: 'Somewhere' },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('the same person cannot be recorded twice on one trip', async () => {
    await db('visit_encounters').insert({ visit_id: 1, person_id: 1, met_with_type: 'named_person', outcome: 'substantive' });
    await assert.rejects(
      () => db('visit_encounters').insert({ visit_id: 1, person_id: 1, met_with_type: 'named_person', outcome: 'brief' }),
      /unique/i,
      'one conversation must not be able to count twice'
    );
  });

  test('a different person on the same trip is fine', async () => {
    await db('visit_encounters').insert({ visit_id: 1, person_id: 2, met_with_type: 'named_person', outcome: 'brief' });
    const rows = await db('visit_encounters').where({ visit_id: 1 }).whereNotNull('person_id');
    assert.equal(rows.length, 2);
  });

  test('the same person on a DIFFERENT trip is fine — the constraint is per-trip', async () => {
    await db('visit_encounters').insert({ visit_id: 2, person_id: 1, met_with_type: 'named_person', outcome: 'substantive' });
    const rows = await db('visit_encounters').where({ person_id: 1 });
    assert.equal(rows.length, 2);
  });

  test('several person-less encounters on one trip are allowed — that is what PARTIAL buys', async () => {
    await db('visit_encounters').insert([
      { visit_id: 1, person_id: null, met_with_type: 'staff', outcome: 'brief' },
      { visit_id: 1, person_id: null, met_with_type: 'receptionist', outcome: 'materials_only' },
      { visit_id: 1, person_id: null, met_with_type: 'nobody', outcome: 'unavailable' },
    ]);
    const rows = await db('visit_encounters').where({ visit_id: 1 }).whereNull('person_id');
    assert.equal(rows.length, 3, 'three anonymous encounters on one trip must not collide with each other');
  });
});
