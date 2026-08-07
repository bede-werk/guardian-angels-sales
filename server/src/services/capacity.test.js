const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');

const {
  bucketForMonthlyReferrals,
  computeCapacityPure,
  measuredFloorByPlace,
  computeCapacityForPlaces,
  computeCapacityForPlace,
} = require('./capacity');
const config = require('../config/scheduling');

const ASOF = '2026-08-03';

// 'YYYY-MM-DD' n days before `dateStr`, UTC-safe — same convention as
// relationship.test.js's own local helper.
function daysBefore(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

function memoryDb() {
  return knexLib({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'migrations') },
  });
}

// --- Pure resolution (computeCapacityPure) ---------------------------------
// Tests 1, 2, 4, 5, 6 from capacity-computation-spec.md §13. No DB — these
// exercise the resolution logic directly, same pure/impure split as
// schedulingEngine.js/relationship.js.

describe('computeCapacityPure — asymmetry invariant', () => {
  test('up: measured exceeding declared raises the effective number', () => {
    const r = computeCapacityPure({
      declared: { value: 3, observedAt: ASOF, source: 'prequal', personId: null },
      measuredFloor: 12,
      overrideLevel: null,
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(r.effectiveMonthly, 12);
    assert.equal(r.level, 'medium');
    assert.equal(r.levelSource, 'measured');
  });

  // THE INVARIANT TEST — see this file's own header and capacity.js's header
  // comment. This must fail loudly if a future change ever lets measuredFloor
  // pull effectiveMonthly below declared.value.
  //
  // Note: the spec's own prose for this case (§13, "Asymmetry — down")
  // says "Declared 15, measured 0 -> effective 15, level high" — but 15
  // buckets to 'medium' under the spec's own §4 thresholds (medium: 6-15,
  // high: 16+), which its own bucket-boundaries test (§13, "15 -> medium")
  // confirms explicitly. That's an internal inconsistency in the spec, not
  // an ambiguity in the boundaries themselves — implementing against §4/the
  // boundaries test (the self-consistent, unambiguous source) rather than
  // the contradicting prose line. The asymmetry claim itself (effective
  // stays at declared's value, never gets pulled down to 0) is unaffected
  // either way and is what this test actually verifies.
  test('down: zero/no measured signal never pulls the declared number down', () => {
    const r = computeCapacityPure({
      declared: { value: 15, observedAt: ASOF, source: 'prequal', personId: null },
      measuredFloor: null,
      overrideLevel: null,
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(r.effectiveMonthly, 15, 'a missing/zero measured signal must never lower the declared value');
    assert.equal(r.level, 'medium');
    assert.equal(r.levelSource, 'declared');
  });
});

describe('bucketForMonthlyReferrals — boundaries', () => {
  test('5 -> low, 6 -> medium, 15 -> medium, 16 -> high, 0 -> low', () => {
    assert.equal(bucketForMonthlyReferrals(5, config.CAPACITY_THRESHOLDS), 'low');
    assert.equal(bucketForMonthlyReferrals(6, config.CAPACITY_THRESHOLDS), 'medium');
    assert.equal(bucketForMonthlyReferrals(15, config.CAPACITY_THRESHOLDS), 'medium');
    assert.equal(bucketForMonthlyReferrals(16, config.CAPACITY_THRESHOLDS), 'high');
    assert.equal(bucketForMonthlyReferrals(0, config.CAPACITY_THRESHOLDS), 'low');
  });
});

describe('computeCapacityPure — staleness', () => {
  test('observed exactly CAPACITY_STALE_DAYS ago is fresh; one day older is stale', () => {
    const fresh = computeCapacityPure({
      declared: { value: 8, observedAt: daysBefore(ASOF, config.CAPACITY_STALE_DAYS), source: 'prequal', personId: null },
      measuredFloor: null,
      overrideLevel: null,
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(fresh.confidence, 'fresh');

    const stale = computeCapacityPure({
      declared: { value: 8, observedAt: daysBefore(ASOF, config.CAPACITY_STALE_DAYS + 1), source: 'prequal', personId: null },
      measuredFloor: null,
      overrideLevel: null,
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(stale.confidence, 'stale');
  });
});

describe('computeCapacityPure — override precedence', () => {
  test('override beats computed, and does not change confidence', () => {
    const withoutOverride = computeCapacityPure({
      declared: { value: 20, observedAt: daysBefore(ASOF, config.CAPACITY_STALE_DAYS + 30), source: 'prequal', personId: null }, // stale
      measuredFloor: null,
      overrideLevel: null,
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(withoutOverride.level, 'high'); // 20 >= HIGH_MIN
    assert.equal(withoutOverride.confidence, 'stale');

    const withOverride = computeCapacityPure({
      declared: { value: 20, observedAt: daysBefore(ASOF, config.CAPACITY_STALE_DAYS + 30), source: 'prequal', personId: null },
      measuredFloor: null,
      overrideLevel: 'low',
      category: null,
      asOf: ASOF,
      config,
    });
    assert.equal(withOverride.level, 'low', 'override wins');
    assert.equal(withOverride.levelSource, 'override');
    assert.equal(withOverride.computedLevel, 'high', 'the computed value underneath is still exposed for the UI');
    assert.equal(withOverride.confidence, 'stale', 'an override must not reset the staleness clock');
  });
});

// --- Bulk DB paths -----------------------------------------------------
// Tests 3, 13, 14, 15 from spec §13 — measuredFloorByPlace's exposure gate,
// asOf being genuinely respected, bulk/single parity, and the empty case.
// Tests 7-12 (EXPLORATION tier ordering/aging, drop-off detector) belong to
// build-order steps 8-9, not built yet — deliberately not attempted here.

describe('measuredFloorByPlace — exposure gate', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Two Referrals, 200 Days', category: 'Hospice', tier: 1, priority_score: 50, created_at: daysBefore(ASOF, 400) },
      { id: 2, name: 'Three Referrals, 170 Days', category: 'Hospice', tier: 1, priority_score: 50, created_at: daysBefore(ASOF, 400) },
      { id: 3, name: 'Three Referrals, 200 Days', category: 'Hospice', tier: 1, priority_score: 50, created_at: daysBefore(ASOF, 400) },
    ]);
    await db('referrals').insert([
      // Place 1: fails the COUNT gate (2 < MEASURED_MIN_REFERRAL_COUNT) even
      // though exposure (200d) clears the floor.
      { place_id: 1, referral_date: daysBefore(ASOF, 200) },
      { place_id: 1, referral_date: daysBefore(ASOF, 100) },
      // Place 2: fails the EXPOSURE gate (170d < MEASURED_MIN_EXPOSURE_DAYS)
      // even though count (3) clears the floor.
      { place_id: 2, referral_date: daysBefore(ASOF, 170) },
      { place_id: 2, referral_date: daysBefore(ASOF, 100) },
      { place_id: 2, referral_date: daysBefore(ASOF, 50) },
      // Place 3: clears both gates.
      { place_id: 3, referral_date: daysBefore(ASOF, 200) },
      { place_id: 3, referral_date: daysBefore(ASOF, 100) },
      { place_id: 3, referral_date: daysBefore(ASOF, 50) },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('2 referrals over 200 days of exposure -> null (fails the count gate)', async () => {
    const byPlace = await measuredFloorByPlace(db, [1], ASOF, config);
    assert.equal(byPlace.has(1), false);
  });

  test('3 referrals over only 170 days of exposure -> null (fails the exposure gate)', async () => {
    const byPlace = await measuredFloorByPlace(db, [2], ASOF, config);
    assert.equal(byPlace.has(2), false);
  });

  test('3 referrals over 200 days of exposure -> non-null', async () => {
    const byPlace = await measuredFloorByPlace(db, [3], ASOF, config);
    assert.equal(byPlace.has(3), true);
    assert.equal(byPlace.get(3), Math.round(3 / (200 / 30.44)));
  });
});

describe('computeCapacityForPlace(s) — asOf, bulk parity, and the empty case', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Two Observations Over Time', category: 'Hospice', tier: 1, priority_score: 50 },
      { id: 2, name: 'Declared Only A', category: 'Physicians', tier: 1, priority_score: 50 },
      { id: 3, name: 'Declared Only B', category: 'Community Partners', tier: 1, priority_score: 50 },
      { id: 4, name: 'Never Touched', category: 'Churches', tier: 1, priority_score: 50 },
    ]);
    await db('capacity_observations').insert([
      { place_id: 1, monthly_referrals: 5, source: 'prequal', observed_at: '2026-01-01' },
      { place_id: 1, monthly_referrals: 10, source: 'prequal', observed_at: '2026-07-01' },
      { place_id: 2, monthly_referrals: 8, source: 'manual', observed_at: '2026-06-01' },
      { place_id: 3, monthly_referrals: 20, source: 'manual', observed_at: '2026-06-01' },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('asOf is respected: a later observation is invisible to an earlier asOf', async () => {
    const early = await computeCapacityForPlace(db, 1, { asOf: '2026-03-01' });
    assert.equal(early.declared.value, 5, 'only the 2026-01-01 observation existed yet');

    const late = await computeCapacityForPlace(db, 1, { asOf: '2026-08-01' });
    assert.equal(late.declared.value, 10, 'the 2026-07-01 observation is now the latest as of this later asOf');
  });

  test('bulk parity: computeCapacityForPlaces matches N single computeCapacityForPlace calls', async () => {
    const asOf = '2026-08-01';
    const bulk = await computeCapacityForPlaces(db, [2, 3], { asOf });
    const singleA = await computeCapacityForPlace(db, 2, { asOf });
    const singleB = await computeCapacityForPlace(db, 3, { asOf });
    assert.deepEqual(bulk.get(2), singleA);
    assert.deepEqual(bulk.get(3), singleB);
  });

  test('empty case: no observations, no referrals -> falls to category_seed, confidence unknown, no crash', async () => {
    const r = await computeCapacityForPlace(db, 4, { asOf: ASOF });
    assert.equal(r.declared, null);
    assert.equal(r.measuredFloor, null);
    assert.equal(r.effectiveMonthly, null);
    assert.equal(r.levelSource, 'category_seed');
    assert.equal(r.confidence, 'unknown');
    // 'Churches' matches config.CATEGORY_CAPACITY_SEED's /church/i -> 'low'.
    assert.equal(r.level, 'low');
  });
});
