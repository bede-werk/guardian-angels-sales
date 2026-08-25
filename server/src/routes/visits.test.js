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

// One migrated db and one listening server for the whole FILE, not per
// describe: the require-cache substitution above is process-wide, so a
// per-describe `after` that called testKnex.destroy() would tear the shared
// connection out from under every describe that ran later.
let server;
let baseUrl;

before(async () => {
  await testKnex.migrate.latest();
  await testKnex('users').insert([
    { id: 1, name: 'Rep A', email: 'a@test.local' },
    { id: 2, name: 'Rep B', email: 'b@test.local' },
  ]);
  // Separate single-row inserts, not one batch: places.do_not_visit is NOT
  // NULL, and a batched insert fills a column absent from one row's object
  // with an explicit NULL for that row rather than the column's default.
  await testKnex('places').insert({ id: 1, name: 'Test Place', category: 'Hospice' });
  await testKnex('places').insert({ id: 2, name: 'Do Not Visit Place', category: 'Hospice', do_not_visit: true });
  await testKnex('places').insert({ id: 3, name: 'Lapsed Mark Place', category: 'Hospice', do_not_visit: true, do_not_visit_until: '2020-01-01' });

  const app = buildApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testKnex.destroy();
});

describe('PATCH /api/visits/:id — authorization on a still-planned visit', () => {
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

// do_not_visit used to be honoured on only two of the five visit write paths
// (services/manualVisits.js's create and edit). This route — "Log a visit"
// from PlaceDetail/PersonDetail — was one of the three that ignored it
// entirely: a rep could record a visit to a place they had deliberately
// marked "stop going here" and see nothing at all.
//
// It warns, it does not block. The mark is about future trips; a trip that
// already happened can't be un-taken by refusing to record it. So the
// finding rides the same `conflicts` array the floor/collision findings
// already use (services/doNotVisit.js's doNotVisitFinding), the response is
// the same 200-with-findings-and-nothing-written the floor warnings get, and
// force:true is the same override.
//
// LOG_DATE is deliberately in the past — this route's normal case is a trip
// that already happened, and the mark is compared against org-today, not the
// visit's own date (only the mark's END is stored, so "was this place marked
// back then" is unanswerable). That's exactly the behaviour these tests pin.
describe('POST /api/visits — do_not_visit warns on the "Log a visit" path', () => {
  const LOG_DATE = '2020-06-15';

  function logVisit(placeId, body = {}) {
    return fetch(`${baseUrl}/api/visits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-user-id': '1' },
      body: JSON.stringify({
        place_id: placeId,
        scheduled_date: LOG_DATE,
        status: 'completed',
        user_id: 1,
        encounters: [{ met_with_type: 'receptionist', outcome: 'materials_only' }],
        ...body,
      }),
    });
  }

  const visitsAt = (placeId) => testKnex('visits').where({ place_id: placeId, scheduled_date: LOG_DATE });

  test('an unmarked place logs straight through, with no confirm step', async () => {
    const res = await logVisit(1);
    assert.equal(res.status, 201);
    assert.equal((await visitsAt(1)).length, 1);
  });

  test('a marked place comes back 200 with a DO_NOT_VISIT finding and writes nothing', async () => {
    const res = await logVisit(2);
    assert.equal(res.status, 200, 'a warning is not an error - the request succeeded, nothing was rejected');
    const body = await res.json();
    assert.equal(body.id, undefined, 'no visit was created');
    assert.deepEqual(
      body.conflicts.filter((c) => c.type === 'DO_NOT_VISIT'),
      [{ type: 'DO_NOT_VISIT', severity: 'soft', placeId: 2 }]
    );
    assert.equal((await visitsAt(2)).length, 0, 'nothing written until the rep confirms');
  });

  test('force:true logs it anyway - the flag never blocks', async () => {
    const res = await logVisit(2, { force: true });
    assert.equal(res.status, 201);
    const rows = await visitsAt(2);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'completed');
  });

  test('a mark whose until-date has already passed does not warn', async () => {
    const res = await logVisit(3);
    assert.equal(res.status, 201, 'a lapsed mark is no mark at all');
    assert.equal((await visitsAt(3)).length, 1);
  });
});
