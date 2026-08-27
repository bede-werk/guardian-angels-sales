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
  nextExplorationEligibleSince,
  toDateOnly,
} = require('./capacity');
const config = require('../config/scheduling');

const ASOF = '2026-08-03';

// 'YYYY-MM-DD' n days before `dateStr`, UTC-safe - same convention as
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
// Tests 1, 2, 4, 5, 6 from capacity-computation-spec.md §13. No DB - these
// exercise the resolution logic directly, same pure/impure split as
// schedulingEngine.js/relationship.js.

describe('computeCapacityPure - asymmetry invariant', () => {
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
    assert.equal(r.level, 'high'); // 12 is high under the 2026-08-23 thresholds (4/11); was medium under the original 6/16
    assert.equal(r.levelSource, 'measured');
  });

  // THE INVARIANT TEST - see this file's own header and capacity.js's header
  // comment. This must fail loudly if a future change ever lets measuredFloor
  // pull effectiveMonthly below declared.value.
  //
  // Historical note, since the level asserted here has changed once and the
  // reasoning is easy to misread: the spec's own prose for this case (§13,
  // "Asymmetry - down") always said "Declared 15, measured 0 -> effective 15,
  // level high," but under the ORIGINAL 6/16 thresholds 15 bucketed to
  // 'medium', contradicting that prose. The spec was corrected to 'medium'
  // in 2026-08-07 to match its own §4 boundaries. The 2026-08-23 threshold
  // retune (6/16 -> 4/11) has now moved 15 back into 'high', so this line
  // reads like the spec's original prose again - by coincidence, not because
  // the earlier correction was wrong. It was right for the thresholds in
  // force at the time.
  //
  // Either way the bucket label is incidental: what this test actually
  // guards is that effectiveMonthly stays at declared's value and is never
  // pulled down toward the absent/zero measurement.
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
    assert.equal(r.level, 'high');
    assert.equal(r.levelSource, 'declared');
  });
});

// Asserts the SHIPPED default thresholds (config/scheduling.js's
// CAPACITY_THRESHOLDS, retuned 2026-08-23 from 6/16 to 4/11), on purpose:
// these boundaries decide which cadence row every pre-qualified place gets,
// so a change to them should have to come here and say so out loud.
describe('bucketForMonthlyReferrals - boundaries', () => {
  test('0 -> low, 3 -> low, 4 -> medium, 10 -> medium, 11 -> high', () => {
    assert.equal(bucketForMonthlyReferrals(0, config.CAPACITY_THRESHOLDS), 'low');
    assert.equal(bucketForMonthlyReferrals(3, config.CAPACITY_THRESHOLDS), 'low');
    assert.equal(bucketForMonthlyReferrals(4, config.CAPACITY_THRESHOLDS), 'medium');
    assert.equal(bucketForMonthlyReferrals(10, config.CAPACITY_THRESHOLDS), 'medium');
    assert.equal(bucketForMonthlyReferrals(11, config.CAPACITY_THRESHOLDS), 'high');
  });

  // The four rating choices must each land in the bucket the rating screen
  // promises, and must not sit ON a boundary - both thresholds are editable
  // from the Settings page with no cross-validation against these values, so
  // a choice with zero margin would let a one-digit tweak silently re-level a
  // whole tier of the book. See CAPACITY_SEED_VALUES' own comment.
  test('every seed choice lands in its intended bucket with room to spare', () => {
    const { major, strong, steady, occasional } = config.CAPACITY_SEED_VALUES;
    const { MEDIUM_MIN, HIGH_MIN } = config.CAPACITY_THRESHOLDS;

    assert.equal(bucketForMonthlyReferrals(major, config.CAPACITY_THRESHOLDS), 'high');
    assert.equal(bucketForMonthlyReferrals(strong, config.CAPACITY_THRESHOLDS), 'high');
    assert.equal(bucketForMonthlyReferrals(steady, config.CAPACITY_THRESHOLDS), 'medium');
    assert.equal(bucketForMonthlyReferrals(occasional, config.CAPACITY_THRESHOLDS), 'low');

    assert.ok(major > strong && strong > steady && steady > occasional, 'seed choices must be strictly descending');
    assert.ok(strong - HIGH_MIN >= 2, 'the lowest high choice needs margin above HIGH_MIN');
    assert.ok(steady - MEDIUM_MIN >= 2, 'the medium choice needs margin above MEDIUM_MIN');
    assert.ok(HIGH_MIN - steady >= 2, 'the medium choice needs margin below HIGH_MIN');
    assert.ok(MEDIUM_MIN - occasional >= 2, 'the low choice needs margin below MEDIUM_MIN');
  });
});

describe('computeCapacityPure - the human seed rung', () => {
  const seeded = (over) => computeCapacityPure({
    declared: null, seed: { value: 13, seededAt: '2026-08-23' }, measuredFloor: null,
    overrideLevel: null, category: 'Churches', asOf: ASOF, config, ...over,
  });

  test('a seed outranks the category guess', () => {
    const r = seeded();
    // 'Churches' seeds to low by keyword; the human said 13/mo.
    assert.equal(r.level, 'high');
    assert.equal(r.levelSource, 'human_seed');
    assert.equal(r.effectiveMonthly, 13);
  });

  test('no seed and no declared still falls through to the category guess', () => {
    const r = seeded({ seed: null });
    assert.equal(r.level, 'low');
    assert.equal(r.levelSource, 'category_seed');
    assert.equal(r.effectiveMonthly, null);
  });

  // The precedence rule, and the reason it is precedence rather than a max:
  // seed and declared measure the SAME quantity, so once the place has
  // actually answered, the guess has nothing left to say - in EITHER
  // direction. This is the test that fails if someone "helpfully" folds the
  // seed into the Math.max alongside measuredFloor.
  test('a real declared answer supersedes the seed outright, even a much lower one', () => {
    const r = seeded({ declared: { value: 2, observedAt: ASOF, source: 'prequal', personId: null } });
    assert.equal(r.effectiveMonthly, 2, 'the seed must not floor a lower declared answer');
    assert.equal(r.level, 'low');
    assert.equal(r.levelSource, 'declared');
  });

  test('the measured floor still raises a seed, and takes the credit', () => {
    const r = seeded({ seed: { value: 1, seededAt: '2026-08-23' }, measuredFloor: 8 });
    assert.equal(r.effectiveMonthly, 8);
    assert.equal(r.level, 'medium');
    assert.equal(r.levelSource, 'measured');
  });

  // The whole design of this rung: it moves the LEVEL without ever claiming
  // the place is known. A seeded place must stay 'unknown' so it keeps its
  // EXPLORATION-tier membership and stays queued for real pre-qualification.
  test('a seed never touches confidence', () => {
    assert.equal(seeded().confidence, 'unknown');
    assert.equal(seeded().staleAt, null);
  });

  test('a superseded seed is returned for provenance but is not a contributor', () => {
    const r = seeded({ declared: { value: 2, observedAt: ASOF, source: 'prequal', personId: null } });
    assert.equal(r.seed.value, 13, 'the UI still shows what the rep had guessed');
    assert.ok(!r.contributors.some((c) => c.type === 'human_seed'), 'a superseded seed contributed nothing');
  });

  test('an active seed IS a contributor', () => {
    const c = seeded().contributors.find((x) => x.type === 'human_seed');
    assert.equal(c.value, 13);
    assert.equal(c.seededAt, '2026-08-23');
  });
});

// Step 7 (capacity-computation-spec.md §8.2's own migration): the value
// stamped onto places.exploration_eligible_since at observation-insert time
// - the date THIS observation goes stale, not derived later at read time.
// See the migration's own header for why a live `?? created_at` fallback
// was rejected.
describe('nextExplorationEligibleSince - step 7 dual-write stamp', () => {
  test('is exactly observedAt + CAPACITY_STALE_DAYS, independent of asOf', () => {
    const observedAt = '2026-01-01';
    assert.equal(nextExplorationEligibleSince(observedAt, config), daysBefore(observedAt, -config.CAPACITY_STALE_DAYS));
  });
});

describe('computeCapacityPure - staleness', () => {
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

describe('computeCapacityPure - override precedence', () => {
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

// Checkpoint 6 follow-up: a real bug on the one machine this app currently
// runs on, not a theoretical cross-environment one. Pins TZ explicitly
// rather than relying on the test machine's own zone happening to
// reproduce it (this app's dev machine is America/Chicago, which does
// reproduce it - but a test that only fails there isn't a regression
// guard). See toDateOnly's own header in capacity.js for the mechanism.
describe('toDateOnly - a raw SQLite timestamp string is read as UTC, not local time', () => {
  const originalTz = process.env.TZ;
  after(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test('21:12 Central on the 26th (02:12 UTC on the 27th) still reads as the 26th', () => {
    process.env.TZ = 'America/Chicago';
    assert.equal(toDateOnly('2026-08-26 21:12:19'), '2026-08-26');
  });

  test('same raw string, pinned to a machine on the other side of the date line', () => {
    process.env.TZ = 'Pacific/Auckland';
    assert.equal(toDateOnly('2026-08-26 21:12:19'), '2026-08-26');
  });

  test('a real Date (what a driver returning genuine Date objects hands back) still round-trips correctly', () => {
    process.env.TZ = 'America/Chicago';
    assert.equal(toDateOnly(new Date(Date.UTC(2026, 7, 26, 21, 12, 19))), '2026-08-26');
  });
});

// --- Bulk DB paths -----------------------------------------------------
// Tests 3, 13, 14, 15 from spec §13 - measuredFloorByPlace's exposure gate,
// asOf being genuinely respected, bulk/single parity, and the empty case.
// Tests 7-12 (EXPLORATION tier ordering/aging, drop-off detector) belong to
// build-order steps 8-9, not built yet - deliberately not attempted here.

describe('measuredFloorByPlace - exposure gate', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Two Referrals, 200 Days', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
      { id: 2, name: 'Three Referrals, 170 Days', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
      { id: 3, name: 'Three Referrals, 200 Days', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
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

describe('computeCapacityForPlace(s) - asOf, bulk parity, and the empty case', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Two Observations Over Time', category: 'Hospice' },
      { id: 2, name: 'Declared Only A', category: 'Physicians' },
      { id: 3, name: 'Declared Only B', category: 'Community Partners' },
      { id: 4, name: 'Never Touched', category: 'Churches' },
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
