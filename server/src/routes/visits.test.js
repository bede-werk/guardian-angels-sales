// Route-level test for PATCH /api/visits/:id's authorization boundary on a
// still-planned visit. No route-level test file existed for visits.js before
// this — every other test in this repo is service-level (see
// src/services/*.test.js) — so this builds the minimum real HTTP harness
// needed to exercise the actual Express handler (not a reimplementation of
// its logic), including the module-level `knex` every route/service in this
// file shares (src/db/knex.js).
//
// THE TRICK: routes/visits.js (and everything it requires) does
// `const knex = require('../db/knex')` at module load time — there's no
// injectable `db` param like services/scheduleDraft.js's commitDay has. To
// point that shared connection at an isolated in-memory sqlite db instead of
// the real dev database, this pre-populates Node's require cache for
// db/knex.js's resolved path with a fake module whose `exports` is our own
// migrated in-memory knex instance, BEFORE routes/visits.js (or any of its
// dependencies) is required for the first time. Every subsequent
// `require('../db/knex')` anywhere in this process resolves to the same
// cache entry — including from services/manualVisits.js, capacity.js,
// placeCommitments.js, etc. — because Node keys the cache by resolved
// absolute path, not by which file did the requiring. This only works
// because `node --test` runs each test file in its own process, so this
// substitution can't leak into other test files.
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
// Matches db/knex.js's own addition — routes/visits.js's POST handler calls
// knex.extractId on an insert result.
testKnex.extractId = (row) => (row && row.id ? row.id : row);

require.cache[dbKnexPath] = {
  id: dbKnexPath,
  filename: dbKnexPath,
  loaded: true,
  exports: testKnex,
};

const visitsRouter = require('./visits');

// A date far enough in the future that visitLifecycle.js's skipSweepMiddleware
// (mounted on this router, runs on every request) never lapses these fixture
// visits into 'skipped' out from under a test — that sweep compares against
// the REAL wall-clock orgToday(), not a fixed test date.
const FUTURE_DATE = '2099-01-01';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Stand-in for middleware/requireAuth.js: real auth resolves a Bearer
  // token to a user row via the same `knex`; tests just say who they are
  // directly via a header, which is all requireAuth's req.user contract
  // (route handlers only ever read req.user.id) needs to exercise the
  // routes themselves.
  app.use(async (req, res, next) => {
    const userId = Number(req.headers['x-test-user-id']);
    if (!Number.isInteger(userId)) return res.status(401).json({ error: 'Not authenticated' });
    const user = await testKnex('users').where({ id: userId }).first();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  });
  app.use('/api/visits', visitsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

describe('PATCH /api/visits/:id — authorization on a still-planned visit', () => {
  let server;
  let baseUrl;

  before(async () => {
    await testKnex.migrate.latest();
    await testKnex('users').insert([
      { id: 1, name: 'Rep A', email: 'a@test.local' },
      { id: 2, name: 'Rep B', email: 'b@test.local' },
    ]);
    await testKnex('places').insert({ id: 1, name: 'Test Place', category: 'Hospice', tier: 1, priority_score: 75 });

    const app = buildApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testKnex.destroy();
  });

  // Fresh planned visit owned by Rep B (id 2) for each test, so one test's
  // mutation (or lack of it) can't bleed into another's. Clears out any
  // still-'planned' leftover from a PREVIOUS test first — a rejected (403)
  // PATCH leaves that row exactly as it started, so without this the next
  // test's insert collides with it under visits_place_date_planned_unique
  // (both are place_id:1 @ FUTURE_DATE, still 'planned').
  let visitId;
  async function freshPlannedVisitOwnedByRepB() {
    await testKnex('visits').where({ place_id: 1, scheduled_date: FUTURE_DATE, status: 'planned' }).del();
    const [row] = await testKnex('visits')
      .insert({ place_id: 1, place_name: 'Test Place', user_id: 2, status: 'planned', scheduled_date: FUTURE_DATE })
      .returning('id');
    return testKnex.extractId(row);
  }

  function patchAs(userId, id, body) {
    return fetch(`${baseUrl}/api/visits/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(userId) },
      body: JSON.stringify(body),
    });
  }

  test('rep A cannot change scheduled_date on rep B\'s still-planned visit', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(1, visitId, { scheduled_date: '2099-02-02' });
    assert.equal(res.status, 403);
    const row = await testKnex('visits').where({ id: visitId }).first();
    assert.equal(row.scheduled_date, FUTURE_DATE, 'the date must be unchanged');
  });

  test('rep A cannot reassign (user_id) rep B\'s still-planned visit', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(1, visitId, { user_id: 1 });
    assert.equal(res.status, 403);
    const row = await testKnex('visits').where({ id: visitId }).first();
    assert.equal(row.user_id, 2, 'ownership must be unchanged');
  });

  test('rep A CAN still edit other fields (notes) on rep B\'s still-planned visit', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(1, visitId, { notes: 'covering this stop for Rep B' });
    assert.equal(res.status, 200);
    const row = await testKnex('visits').where({ id: visitId }).first();
    assert.equal(row.notes, 'covering this stop for Rep B');
  });

  test('rep A CAN log encounters and complete rep B\'s still-planned visit', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(1, visitId, {
      status: 'completed',
      encounters: [{ met_with_type: 'receptionist', outcome: 'materials_only' }],
    });
    assert.equal(res.status, 200);
    const row = await testKnex('visits').where({ id: visitId }).first();
    assert.equal(row.status, 'completed');
  });

  test('rep B (the actual owner) can still change the date and reassign normally', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(2, visitId, { scheduled_date: '2099-03-03', user_id: 1 });
    assert.equal(res.status, 200);
    const row = await testKnex('visits').where({ id: visitId }).first();
    assert.equal(row.scheduled_date, '2099-03-03');
    assert.equal(row.user_id, 1);
  });

  test('sending scheduled_date/user_id unchanged from their current value still requires ownership (the check is on "trying to set", not "trying to change the value")', async () => {
    visitId = await freshPlannedVisitOwnedByRepB();
    const res = await patchAs(1, visitId, { scheduled_date: FUTURE_DATE });
    assert.equal(res.status, 403);
  });
});
