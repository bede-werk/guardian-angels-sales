// Route-level test for POST /api/referrals, covering the 2026-08-25 change
// that dropped the "this person isn't assigned to a place" 400: a referral
// now needs a PERSON, not a place. The two knock-on behaviours that decision
// rests on are pinned here too, since they're the whole reason a null
// place_id snapshot is safe to allow:
//   1. the PLACE rollup heals itself when the person is assigned later, and
//   2. the CAPACITY measured floor never sees a null-snapshot referral, not
//      even after that assignment.
//
// Uses the same require-cache substitution as visits.test.js - see that
// file's header for why routes/referrals.js's module-level
// `require('../db/knex')` can only be redirected this way, and why it's safe
// (node --test gives each test file its own process).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const express = require('express');

const dbKnexPath = require.resolve('../db/knex');
const testKnex = knexLib({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  migrations: { directory: path.join(__dirname, '..', 'migrations') },
});
testKnex.extractId = (row) => (row && row.id ? row.id : row); // matches db/knex.js's own addition

require.cache[dbKnexPath] = {
  id: dbKnexPath,
  filename: dbKnexPath,
  loaded: true,
  exports: testKnex,
};

const referralsRouter = require('./referrals');
const { referralMetricsByPlaceId } = require('../services/referralMetrics');
const { measuredFloorByPlace } = require('../services/capacity');
const schedulingConfig = require('../config/scheduling');

const ASOF = '2026-08-25';

// 'YYYY-MM-DD' n days before `dateStr`, UTC-safe - same helper capacity.test.js
// and relationship.test.js each keep locally.
function daysBefore(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// No auth middleware here, unlike visits.test.js's harness: routes/referrals.js
// never reads req.user (the real app mounts requireAuth in front of it, but no
// handler in this router branches on who's asking), so standing one up would
// only test Express.
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/referrals', referralsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

describe('POST /api/referrals - a referrer does not need a place', () => {
  let server;
  let baseUrl;

  before(async () => {
    await testKnex.migrate.latest();
    await testKnex('users').insert({ id: 1, name: 'Rep A', email: 'a@test.local' });
    await testKnex('places').insert([
      { id: 1, name: 'Hillcrest Hospice', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
      { id: 2, name: 'Mercy Rehab', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
      { id: 3, name: 'Snapshot Control', category: 'Hospice', created_at: daysBefore(ASOF, 400) },
    ]);
    await testKnex('people').insert([
      { id: 1, name: 'Placeless Pat', place_id: null }, // an attorney, a fiduciary, a family member...
      { id: 2, name: 'Assigned Ann', place_id: 1 },
    ]);

    const app = buildApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testKnex.destroy();
  });

  function post(body) {
    return fetch(`${baseUrl}/api/referrals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('saves for a person with no place, stamping a null place snapshot', async () => {
    const res = await post({ person_id: 1, referral_date: daysBefore(ASOF, 10), notes: 'Sent us the Ramirez family' });
    assert.equal(res.status, 201);
    const saved = await res.json();
    assert.equal(saved.person_id, 1);
    assert.equal(saved.place_id, null, "a placeless person's referral gets a null snapshot, not a refusal");
  });

  test('still stamps the place of a person who has one', async () => {
    const res = await post({ person_id: 2, referral_date: daysBefore(ASOF, 10), notes: 'From the discharge desk' });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).place_id, 1);
  });

  test('still requires a person - a referral with none has nowhere to be counted', async () => {
    const res = await post({ referral_date: ASOF, notes: 'Someone at that building, not sure who' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /person_id is required/);
  });

  test('404s on a person who does not exist', async () => {
    const res = await post({ person_id: 9999, notes: 'Ghost' });
    assert.equal(res.status, 404);
  });

  test("the place rollup heals itself once that person is assigned somewhere", async () => {
    const before = await referralMetricsByPlaceId(testKnex, [2], new Date(`${ASOF}T12:00:00Z`));
    assert.equal(before[2], undefined, 'Mercy Rehab has nobody on its roster yet');

    await testKnex('people').where({ id: 1 }).update({ place_id: 2 });

    const after = await referralMetricsByPlaceId(testKnex, [2], new Date(`${ASOF}T12:00:00Z`));
    assert.equal(
      after[2].lifetime_referrals,
      1,
      'the referral Pat logged while placeless rolls into Mercy Rehab retroactively - no backfill needed'
    );
  });

  test('the capacity measured floor never sees a null-snapshot referral, even after assignment', async () => {
    // Pat is on place 2's roster (previous test) and now clears BOTH capacity
    // gates on volume - 4 referrals >= MEASURED_MIN_REFERRAL_COUNT, spread over
    // more than MEASURED_MIN_EXPOSURE_DAYS, at a place created 400 days ago.
    // The floor still reads nothing for place 2, because every one of those
    // rows carries a null place_id.
    await testKnex('referrals').insert([
      { place_id: null, person_id: 1, referral_date: daysBefore(ASOF, 300) },
      { place_id: null, person_id: 1, referral_date: daysBefore(ASOF, 200) },
      { place_id: null, person_id: 1, referral_date: daysBefore(ASOF, 100) },
      // Control: the identical spread, stamped with a real place, DOES measure.
      { place_id: 3, person_id: 2, referral_date: daysBefore(ASOF, 300) },
      { place_id: 3, person_id: 2, referral_date: daysBefore(ASOF, 200) },
      { place_id: 3, person_id: 2, referral_date: daysBefore(ASOF, 100) },
      { place_id: 3, person_id: 2, referral_date: daysBefore(ASOF, 10) },
    ]);

    const floors = await measuredFloorByPlace(testKnex, [2, 3], ASOF, schedulingConfig);
    assert.equal(floors.has(2), false, 'null-snapshot referrals credit no building, by design');
    assert.equal(floors.has(3), true, 'control: the same history with a real snapshot does measure');
  });
  // --- class (payer source) ------------------------------------------------
  // Free text by design (see migration 20260828010000): the vocabulary lives
  // in eRSP and arrives with the one-time import, so the server suggests but
  // never rejects.

  function patch(id, body) {
    return fetch(`${baseUrl}/api/referrals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('stores the class it was logged with', async () => {
    const res = await post({ person_id: 2, referral_date: '2026-08-01', notes: 'n', class: 'Private Pay' });
    assert.equal(res.status, 201);
    const row = await res.json();
    assert.equal(row.class, 'Private Pay');
  });

  test('a referral logged without a class stores null, not an empty string', async () => {
    // "Nobody recorded a payer source" is a real answer; '' would be a lie
    // that also breaks the suggestion list below.
    const res = await post({ person_id: 2, referral_date: '2026-08-02', notes: 'n' });
    const row = await res.json();
    assert.equal(row.class, null);
  });

  test('class can be set and cleared on an existing referral', async () => {
    const created = await (await post({ person_id: 2, referral_date: '2026-08-03', notes: 'n' })).json();

    const set = await patch(created.id, { class: 'Medicaid' });
    assert.equal(set.status, 200);
    assert.equal((await set.json()).class, 'Medicaid');

    const cleared = await patch(created.id, { class: '' });
    assert.equal((await cleared.json()).class, null, 'clearing stores null, not an empty string');
  });

  test('a PATCH that omits class leaves the existing one alone', async () => {
    const created = await (await post({ person_id: 2, referral_date: '2026-08-04', notes: 'n', class: 'VA' })).json();
    const res = await patch(created.id, { notes: 'edited note' });
    const row = await res.json();
    assert.equal(row.notes, 'edited note');
    assert.equal(row.class, 'VA', 'an unrelated edit must not wipe the payer source');
  });

  test('GET /classes lists the distinct values on file, skipping blanks', async () => {
    await post({ person_id: 2, referral_date: '2026-08-05', notes: 'n', class: 'Medicare' });
    await post({ person_id: 2, referral_date: '2026-08-06', notes: 'n', class: 'Medicare' }); // duplicate
    await post({ person_id: 2, referral_date: '2026-08-07', notes: 'n' });                    // null

    const res = await fetch(`${baseUrl}/api/referrals/classes`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.ok(list.includes('Medicare'), 'a used class is offered');
    assert.equal(list.filter((c) => c === 'Medicare').length, 1, 'offered once, not per referral');
    assert.ok(!list.includes(null) && !list.includes(''), 'blanks are never suggested');
    assert.deepEqual([...list].sort(), list, 'returned in sorted order');
  });

  test("'classes' is not swallowed as a referral id", async () => {
    // GET /classes is declared before the /:id routes; this pins that ordering.
    const res = await fetch(`${baseUrl}/api/referrals/classes`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(await res.json()));
  });
});
