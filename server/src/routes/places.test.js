// Route-level test for checkpoint 4's place-lifecycle hook: POST/PATCH must
// invalidate/enqueue the backfill queue (services/backfillQueue.js) exactly
// when the place's coordinates change, and DELETE must cascade to both
// place_distance and backfill_queue. Same require-cache-substitution harness
// as routes/visits.test.js - see that file's header for why it's necessary
// (routes/places.js does `const knex = require('../db/knex')` at module
// load time, no injectable `db` param).
const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
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
  // Needed for the DELETE cascade test below - see knexfile.js's own
  // development pool hook, and placeCommitments.test.js's identical setup.
  pool: {
    afterCreate: (conn, done) => {
      conn.pragma('foreign_keys = ON');
      done(null, conn);
    },
  },
});
testKnex.extractId = (row) => (row && row.id ? row.id : row);

require.cache[dbKnexPath] = {
  id: dbKnexPath,
  filename: dbKnexPath,
  loaded: true,
  exports: testKnex,
};

const placesRouter = require('./places');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    const userId = Number(req.headers['x-test-user-id']);
    if (!Number.isInteger(userId)) return res.status(401).json({ error: 'Not authenticated' });
    const user = await testKnex('users').where({ id: userId }).first();
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  });
  app.use('/api/places', placesRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message || 'Internal server error' });
  });
  return app;
}

let server;
let baseUrl;
const originalFetch = global.fetch;

before(async () => {
  await testKnex.migrate.latest();
  await testKnex('users').insert({ id: 1, name: 'Rep A', email: 'a@test.local' });

  const app = buildApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await testKnex.destroy();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function okMatch(lat, lng) {
  return async () => ({ ok: true, json: async () => ({ result: { addressMatches: [{ coordinates: { x: lng, y: lat } }] } }) });
}
function noMatch() {
  return async () => ({ ok: true, json: async () => ({ result: { addressMatches: [] } }) });
}

// Tests below stub global.fetch to fake the server's OUTBOUND call to the
// Census geocoder - but these helpers make the test's OWN inbound call to
// the local test server, over the same global `fetch`. Using the captured
// originalFetch here keeps the two calls from colliding (the stub would
// otherwise intercept the request to our own server too).
function postAs(userId, body) {
  return originalFetch(`${baseUrl}/api/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(userId) },
    body: JSON.stringify(body),
  });
}
function patchAs(userId, id, body) {
  return originalFetch(`${baseUrl}/api/places/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-test-user-id': String(userId) },
    body: JSON.stringify(body),
  });
}
function deleteAs(userId, id) {
  return originalFetch(`${baseUrl}/api/places/${id}`, {
    method: 'DELETE',
    headers: { 'x-test-user-id': String(userId) },
  });
}

describe('POST /api/places - geocode lifecycle hook', () => {
  beforeEach(async () => {
    await testKnex('backfill_queue').del();
    await testKnex('places').del();
  });

  test('a successfully geocoded address enqueues a fresh backfill_queue entry', async () => {
    global.fetch = okMatch(40.8136, -96.7026);
    const res = await postAs(1, { name: 'New Place', address: '123 O St', city: 'Lincoln', zip: '68508' });
    assert.equal(res.status, 201);
    const place = await res.json();

    const queued = await testKnex('backfill_queue').where({ place_id: place.id }).first();
    assert.ok(queued, 'the new place must be queued for backfill');
    assert.equal(queued.attempts, 0);
  });

  test('a place created with no address at all is never queued', async () => {
    const res = await postAs(1, { name: 'No Address Place' });
    assert.equal(res.status, 201);
    const place = await res.json();

    const queued = await testKnex('backfill_queue').where({ place_id: place.id }).first();
    assert.equal(queued, undefined);
  });

  test('an unrecognized address saved anyway (confirm_address) is not queued - there is no coordinate to backfill from', async () => {
    global.fetch = noMatch();
    const res = await postAs(1, { name: 'Bad Address Place', address: 'nowhere', confirm_address: true });
    assert.equal(res.status, 201);
    const place = await res.json();
    assert.equal(place.lat, null);

    const queued = await testKnex('backfill_queue').where({ place_id: place.id }).first();
    assert.equal(queued, undefined);
  });
});

describe('PATCH /api/places/:id - invalidate + re-enqueue on address change', () => {
  let placeId, otherPlaceId, thirdPlaceId;

  beforeEach(async () => {
    await testKnex('backfill_queue').del();
    await testKnex('place_distance').del();
    await testKnex('places').del();

    [placeId, otherPlaceId, thirdPlaceId] = await Promise.all(
      [
        { name: 'Moving Place', category: 'Hospice', lat: 40.81, lng: -96.70 },
        { name: 'Other Place', category: 'Hospice', lat: 40.82, lng: -96.71 },
        { name: 'Third Place', category: 'Hospice', lat: 40.83, lng: -96.72 },
      ].map(async (p) => {
        const [row] = await testKnex('places').insert(p).returning('id');
        return testKnex.extractId(row);
      })
    );

    // Cached distances touching the place under test (both directions), plus
    // one pair that doesn't involve it at all - the control for "only THIS
    // place's rows get dropped."
    await testKnex('place_distance').insert([
      { from_place_id: placeId, to_place_id: otherPlaceId, meters: 1000, seconds: 100 },
      { from_place_id: otherPlaceId, to_place_id: placeId, meters: 1000, seconds: 100 },
      { from_place_id: otherPlaceId, to_place_id: thirdPlaceId, meters: 2000, seconds: 200 },
    ]);
  });

  test('a successful re-geocode invalidates this place\'s cached rows (only) and enqueues a fresh backfill', async () => {
    global.fetch = okMatch(41.0, -97.0);
    const res = await patchAs(1, placeId, { address: '456 New St', city: 'Lincoln', zip: '68508' });
    assert.equal(res.status, 200);

    const touched = await testKnex('place_distance').where('from_place_id', placeId).orWhere('to_place_id', placeId);
    assert.equal(touched.length, 0, 'both directions involving the moved place must be gone');

    const control = await testKnex('place_distance').where({ from_place_id: otherPlaceId, to_place_id: thirdPlaceId }).first();
    assert.ok(control, 'a pair not involving the moved place must survive untouched');

    const queued = await testKnex('backfill_queue').where({ place_id: placeId }).first();
    assert.ok(queued, 'the place must be re-queued for a fresh backfill');
  });

  // Checkpoint 6 follow-up: address_changed_at (services/staleAddress.js's
  // only reader) must fire only on a genuine change, never on a re-save -
  // that's the whole reason it exists instead of reusing geocoded_at, which
  // bumps unconditionally (see the migration's header).
  test('a genuine address change stamps address_changed_at', async () => {
    global.fetch = okMatch(41.0, -97.0);
    const res = await patchAs(1, placeId, { address: '456 New St', city: 'Lincoln', zip: '68508' });
    assert.equal(res.status, 200);

    const place = await testKnex('places').where({ id: placeId }).first();
    assert.ok(place.address_changed_at, 'the first real address on this place is still a change from nothing');
  });

  test('re-submitting the identical address does not re-stamp address_changed_at', async () => {
    global.fetch = okMatch(41.0, -97.0);
    const first = await patchAs(1, placeId, { address: '456 New St', city: 'Lincoln', zip: '68508' });
    assert.equal(first.status, 200);
    const afterFirst = await testKnex('places').where({ id: placeId }).first();
    assert.ok(afterFirst.address_changed_at);
    const stampedAt = String(afterFirst.address_changed_at);

    const second = await patchAs(1, placeId, { address: '456 New St', city: 'Lincoln', zip: '68508' });
    assert.equal(second.status, 200);
    const afterSecond = await testKnex('places').where({ id: placeId }).first();

    assert.equal(String(afterSecond.address_changed_at), stampedAt, 'resubmitting the same address must not move the flag');
  });

  test('a failed re-geocode (confirm_address) still invalidates cached rows but does not enqueue', async () => {
    global.fetch = noMatch();
    const res = await patchAs(1, placeId, { address: 'nowhere', confirm_address: true });
    assert.equal(res.status, 200);
    const place = await res.json();
    assert.equal(place.lat, null);

    const touched = await testKnex('place_distance').where('from_place_id', placeId).orWhere('to_place_id', placeId);
    assert.equal(touched.length, 0, 'the old cached rows describe a location that no longer applies');

    const queued = await testKnex('backfill_queue').where({ place_id: placeId }).first();
    assert.equal(queued, undefined, 'nothing to backfill without a real coordinate');
  });

  test('patching a field unrelated to address touches neither the cache nor the queue', async () => {
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ result: { addressMatches: [] } }) }; };

    const res = await patchAs(1, placeId, { notes: 'just a note' });
    assert.equal(res.status, 200);
    assert.equal(fetchCalled, false, 'no address field changed, so no re-geocode should happen at all');

    const touched = await testKnex('place_distance').where('from_place_id', placeId).orWhere('to_place_id', placeId);
    assert.equal(touched.length, 2, 'cached rows for this place must be untouched');

    const queued = await testKnex('backfill_queue').where({ place_id: placeId }).first();
    assert.equal(queued, undefined);

    const place = await testKnex('places').where({ id: placeId }).first();
    assert.equal(place.address_changed_at, null);
  });
});

describe('DELETE /api/places/:id - cascades to cached distances and any queued backfill', () => {
  let placeId, otherPlaceId, thirdPlaceId;

  beforeEach(async () => {
    await testKnex('backfill_queue').del();
    await testKnex('place_distance').del();
    await testKnex('places').del();

    [placeId, otherPlaceId, thirdPlaceId] = await Promise.all(
      [
        { name: 'Doomed Place', category: 'Hospice', lat: 40.81, lng: -96.70 },
        { name: 'Other Place', category: 'Hospice', lat: 40.82, lng: -96.71 },
        { name: 'Third Place', category: 'Hospice', lat: 40.83, lng: -96.72 },
      ].map(async (p) => {
        const [row] = await testKnex('places').insert(p).returning('id');
        return testKnex.extractId(row);
      })
    );

    await testKnex('place_distance').insert([
      { from_place_id: placeId, to_place_id: otherPlaceId, meters: 1000, seconds: 100 },
      { from_place_id: otherPlaceId, to_place_id: placeId, meters: 1000, seconds: 100 },
      { from_place_id: otherPlaceId, to_place_id: thirdPlaceId, meters: 2000, seconds: 200 },
    ]);
    await testKnex('backfill_queue').insert({ place_id: placeId });
  });

  test('deleting a place removes its place_distance rows (both directions) and its backfill_queue row, leaving unrelated rows alone', async () => {
    const res = await deleteAs(1, placeId);
    assert.equal(res.status, 204);

    const touched = await testKnex('place_distance').where('from_place_id', placeId).orWhere('to_place_id', placeId);
    assert.equal(touched.length, 0);

    const queued = await testKnex('backfill_queue').where({ place_id: placeId }).first();
    assert.equal(queued, undefined);

    const control = await testKnex('place_distance').where({ from_place_id: otherPlaceId, to_place_id: thirdPlaceId }).first();
    assert.ok(control, 'a pair not involving the deleted place must survive untouched');
  });
});
