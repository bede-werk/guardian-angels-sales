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
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
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
    await db('visits').insert([
      { place_id: 1, person_id: 1, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 15), met_with_type: 'named_person', outcome: 'substantive', place_name: 'Fast Place' },
      { place_id: 1, person_id: 2, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 30), met_with_type: 'named_person', outcome: 'brief', place_name: 'Fast Place' },
      { place_id: 1, person_id: null, user_id: 1, status: 'completed', scheduled_date: daysBefore(ASOF, 5), met_with_type: 'receptionist', outcome: 'materials_only', place_name: 'Fast Place' },
      // A planned (not completed) visit must be ignored entirely.
      { place_id: 1, person_id: 1, user_id: 1, status: 'planned', scheduled_date: ASOF, met_with_type: 'named_person', outcome: 'substantive', place_name: 'Fast Place' },
    ]);
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
});
