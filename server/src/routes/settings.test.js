// Route-level test for the distance-cache actions on the Settings page.
// Same require-cache-substitution harness as routes/places.test.js - see that
// file's header for why it's necessary.
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
testKnex.extractId = (row) => (row && row.id ? row.id : row);
require.cache[dbKnexPath] = { id: dbKnexPath, filename: dbKnexPath, loaded: true, exports: testKnex };

// A drain slow enough to actually overlap. The live check against a real server
// was inconclusive: with OSRM unconfigured the real drain throws in about a
// millisecond, so two "concurrent" requests never overlap and both succeed.
const queuePath = require.resolve('../services/backfillQueue');
const realQueue = require(queuePath);
let drainCalls = 0;
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    ...realQueue,
    drainQueue: async () => {
      drainCalls += 1;
      await new Promise((r) => setTimeout(r, 150));
      return { processed: 1, succeeded: 1, failed: 0 };
    },
  },
};

const settingsRouter = require('./settings');

let server;
let base;

before(async () => {
  await testKnex.migrate.latest();
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  await new Promise((resolve) => {
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await testKnex.destroy();
});

const post = (p) => fetch(base + p, { method: 'POST' });

describe('POST /settings/distance-cache/backfill', () => {
  test('refuses a second run while one is still going', async () => {
    // Two drains at once would both spawn osrm-routed on the same fixed port;
    // the loser fails to bind and marks every queued place failed for a reason
    // that has nothing to do with the places.
    drainCalls = 0;
    const [a, b] = await Promise.all([post('/api/settings/distance-cache/backfill'), post('/api/settings/distance-cache/backfill')]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], `expected one 200 and one 409, got ${codes}`);
    assert.equal(drainCalls, 1, 'the drain itself must only run once');
  });

  test('the guard clears afterwards, so a later run is allowed', async () => {
    const res = await post('/api/settings/distance-cache/backfill');
    assert.equal(res.status, 200, 'a run after the first finished must be allowed');
  });
});

describe('POST /settings/distance-cache/requeue', () => {
  test('clears failed_at and the attempt count, and reports how many', async () => {
    await testKnex('places').insert([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    await testKnex('backfill_queue').insert([
      { place_id: 1, attempts: 5, failed_at: '2026-08-28 12:00:00', last_error: 'OSRM_DATA_PATH is not configured', next_attempt_at: 0 },
      { place_id: 2, attempts: 2, failed_at: null, last_error: 'transient', next_attempt_at: 0 }, // still due - must be left alone
    ]);

    const res = await post('/api/settings/distance-cache/requeue');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { requeued: 1 });

    const one = await testKnex('backfill_queue').where({ place_id: 1 }).first();
    assert.equal(one.failed_at, null);
    assert.equal(one.attempts, 0);
    assert.equal(one.last_error, null);

    const two = await testKnex('backfill_queue').where({ place_id: 2 }).first();
    assert.equal(two.attempts, 2, 'a place that is merely due keeps its attempt count');
  });
});

describe('GET /settings/distance-cache', () => {
  test('surfaces the blocking error so the panel cannot read as merely pending', async () => {
    // Self-contained: the requeue test above clears last_error, and the route
    // reports the most RECENT one, so this seeds its own newest row rather than
    // depending on what an earlier test happened to leave behind.
    await testKnex('places').insert({ id: 3, name: 'C' });
    await testKnex('backfill_queue').insert({
      place_id: 3,
      attempts: 1,
      last_error: 'OSRM_DATA_PATH is not configured - run the initial OSRM setup',
      next_attempt_at: 0,
      created_at: '2099-01-01 00:00:00', // newest by a mile, so ordering is not a coin flip
    });

    const res = await fetch(base + '/api/settings/distance-cache');
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.lastError, /OSRM_DATA_PATH/);
    assert.equal(body.running, false);
  });
});
