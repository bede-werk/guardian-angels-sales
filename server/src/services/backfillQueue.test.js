const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const knexLib = require('knex');
const { enqueue, onPlaceGeocoded, dueQueueEntries, recordSuccess, recordFailure, drainQueue, queueHealth } = require('./backfillQueue');
const backfillQueueConfig = require('../config/backfillQueue');

const PLACE_A = { id: 1, lat: 40.8136, lng: -96.7026 };
const PLACE_B = { id: 2, lat: 40.8140, lng: -96.6200 };
const PLACE_C = { id: 3, lat: 40.7550, lng: -96.7700 };

function memoryDb() {
  return knexLib({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'migrations') },
  });
}

// A fake RoutingProvider - see matrixCache.test.js's fakeProvider for the
// same shape. `fail` makes start() (or, if 'table', the table() call) throw.
function fakeProvider({ fail = null, unroutable = [] } = {}) {
  const calls = { start: 0, stop: 0, table: 0 };
  return {
    calls,
    async start() {
      calls.start++;
      if (fail === 'start') throw new Error('OSRM failed to start');
    },
    async stop() {
      calls.stop++;
    },
    async table(sources, destinations) {
      calls.table++;
      if (fail === 'table') throw new Error('OSRM table request failed');
      const build = (offset) => sources.map((s) => destinations.map((d) => {
        if (unroutable.some(([lat, lng]) => lat === d.lat && lng === d.lng)) return null;
        return offset + Math.round(s.lat * 1000) + Math.round(d.lat * 1000);
      }));
      return { distances: build(1000), durations: build(100) };
    },
  };
}

describe('enqueue / dueQueueEntries', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('backfill_queue').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
    ]);
  });

  test('enqueue inserts a fresh, immediately-due row', async () => {
    await enqueue(db, 1);
    const due = await dueQueueEntries(db);
    assert.equal(due.length, 1);
    assert.equal(due[0].place_id, 1);
    assert.equal(due[0].attempts, 0);
    assert.equal(due[0].failed_at, null);
  });

  test('re-enqueueing an already-queued place resets it to a fresh cycle', async () => {
    await enqueue(db, 1);
    await recordFailure(db, 1, 'boom'); // attempts: 1, next_attempt_at pushed into the future
    let due = await dueQueueEntries(db);
    assert.equal(due.length, 0, 'not due yet after a failure with a real backoff');

    await enqueue(db, 1); // re-queue (e.g. an operator manually retrying, or checkpoint 4's address-change path)
    due = await dueQueueEntries(db);
    assert.equal(due.length, 1);
    assert.equal(due[0].attempts, 0, 'attempts reset');
  });

  test('a permanently-failed place is not due, even if its next_attempt_at is in the past', async () => {
    await enqueue(db, 1);
    for (let i = 0; i < backfillQueueConfig.MAX_ATTEMPTS; i++) await recordFailure(db, 1, 'boom');

    const row = await db('backfill_queue').where({ place_id: 1 }).first();
    assert.ok(row.failed_at, 'must be marked permanently failed after MAX_ATTEMPTS');

    await db('backfill_queue').where({ place_id: 1 }).update({ next_attempt_at: new Date(Date.now() - 1000) });
    const due = await dueQueueEntries(db);
    assert.equal(due.length, 0, 'failed_at excludes it regardless of next_attempt_at');
  });

  test('recordSuccess removes the row entirely', async () => {
    await enqueue(db, 1);
    await recordSuccess(db, 1);
    const row = await db('backfill_queue').where({ place_id: 1 }).first();
    assert.equal(row, undefined);
  });

  test('recordFailure on an already-resolved place is a harmless no-op', async () => {
    await assert.doesNotReject(() => recordFailure(db, 999, 'boom'));
  });
});

describe('onPlaceGeocoded', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('backfill_queue').del();
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
    ]);
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1 },
      { from_place_id: 2, to_place_id: 1, meters: 1, seconds: 1 },
    ]);
  });

  test('a real coordinate invalidates the place\'s cached rows and queues it for backfill', async () => {
    await onPlaceGeocoded(db, 1, { lat: 41, lng: -97 });

    const touched = await db('place_distance').where('from_place_id', 1).orWhere('to_place_id', 1);
    assert.equal(touched.length, 0);

    const queued = await db('backfill_queue').where({ place_id: 1 }).first();
    assert.ok(queued, 'must be queued when a real coordinate is given');
  });

  test('a null coordinate (failed geocode) still invalidates but does not queue', async () => {
    await onPlaceGeocoded(db, 1, null);

    const touched = await db('place_distance').where('from_place_id', 1).orWhere('to_place_id', 1);
    assert.equal(touched.length, 0);

    const queued = await db('backfill_queue').where({ place_id: 1 }).first();
    assert.equal(queued, undefined, 'nothing to backfill without a real coordinate');
  });
});

describe('queueHealth', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('backfill_queue').del();
  });

  test('splits due (will retry on its own) from permanently failed (needs a human)', async () => {
    await enqueue(db, 1);
    await enqueue(db, 2);
    for (let i = 0; i < backfillQueueConfig.MAX_ATTEMPTS; i++) await recordFailure(db, 2, 'boom');

    const health = await queueHealth(db);
    assert.deepEqual(health, { due: 1, failed: 1 });
  });

  test('an empty queue reports zero for both', async () => {
    assert.deepEqual(await queueHealth(db), { due: 0, failed: 0 });
  });
});

describe('recordFailure - backoff progression', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
    await db('places').insert({ id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng });
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('backfill_queue').del();
    await enqueue(db, 1);
  });

  test('each failure schedules the next attempt per the configured backoff, until MAX_ATTEMPTS marks it permanently failed', async () => {
    for (let attempt = 1; attempt <= backfillQueueConfig.MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      await recordFailure(db, 1, `failure #${attempt}`);
      const row = await db('backfill_queue').where({ place_id: 1 }).first();

      assert.equal(row.attempts, attempt);
      assert.equal(row.last_error, `failure #${attempt}`);

      if (attempt < backfillQueueConfig.MAX_ATTEMPTS) {
        assert.equal(row.failed_at, null, `attempt ${attempt} must not be permanently failed yet`);
        const expectedWaitMs = backfillQueueConfig.BACKOFF_MINUTES[attempt - 1] * 60 * 1000;
        const actualWaitMs = new Date(row.next_attempt_at).getTime() - before;
        assert.ok(Math.abs(actualWaitMs - expectedWaitMs) < 2000, `attempt ${attempt}: expected ~${expectedWaitMs}ms wait, got ${actualWaitMs}ms`);
      } else {
        assert.ok(row.failed_at, 'the final attempt must mark the row permanently failed');
      }
    }
  });
});

describe('drainQueue', () => {
  let db;

  before(async () => {
    db = memoryDb();
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('backfill_queue').del();
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'B', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
      { id: 3, name: 'C', category: 'Hospice', lat: PLACE_C.lat, lng: PLACE_C.lng },
    ]);
  });

  test('nothing due: the provider is never touched', async () => {
    const provider = fakeProvider();
    const result = await drainQueue({ db, provider });
    assert.deepEqual(result, { processed: 0, succeeded: 0, failed: 0 });
    assert.equal(provider.calls.start, 0);
    assert.equal(provider.calls.table, 0);
  });

  test('due work: provider is started, drained, and stopped; the queue entry is resolved on success', async () => {
    await enqueue(db, 3); // place 3 is "new" - 1 and 2 already fully covered

    const provider = fakeProvider();
    const result = await drainQueue({ db, provider });

    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(provider.calls.start, 1);
    assert.equal(provider.calls.stop, 1);

    const row = await db('backfill_queue').where({ place_id: 3 }).first();
    assert.equal(row, undefined, 'resolved queue entries are removed');

    const rows = await db('place_distance').select('*');
    assert.equal(rows.length, 6, 'place 3 now has rows to and from both other places');
  });

  // Required by the checkpoint: a failing provider must not lose the queue
  // entry or corrupt place_distance - the entry stays queued (with an
  // incremented attempt count) for the next drain, and nothing partial or
  // wrong gets written.
  test('a failing provider increments attempts without losing the queue entry or corrupting cached rows', async () => {
    await db('place_distance').insert({ from_place_id: 1, to_place_id: 2, meters: 111, seconds: 11, source: 'osrm' });
    await enqueue(db, 3);

    const provider = fakeProvider({ fail: 'start' });
    const result = await drainQueue({ db, provider });

    assert.equal(result.processed, 1);
    assert.equal(result.failed, 1);
    assert.equal(provider.calls.stop, 1, 'stop() still runs even though start() failed');

    const row = await db('backfill_queue').where({ place_id: 3 }).first();
    assert.ok(row, 'the queue entry must still exist');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /OSRM failed to start/);
    assert.equal(row.failed_at, null, 'one failure must not exhaust the retry budget');

    const preserved = await db('place_distance').where({ from_place_id: 1, to_place_id: 2 }).first();
    assert.equal(preserved.meters, 111, 'pre-existing cached rows must be untouched by a failed drain');
    const newRows = await db('place_distance').where({ from_place_id: 3 }).orWhere({ to_place_id: 3 });
    assert.equal(newRows.length, 0, 'no partial/garbage rows for the place that failed');
  });

  test('a table() failure mid-backfill is treated the same as a start() failure', async () => {
    await enqueue(db, 3);
    const provider = fakeProvider({ fail: 'table' });
    const result = await drainQueue({ db, provider });
    assert.equal(result.failed, 1);
    const row = await db('backfill_queue').where({ place_id: 3 }).first();
    assert.equal(row.attempts, 1);
  });

  test('a place that stays under-covered after the backfill (unroutable) is recorded as a failure, not a success', async () => {
    await enqueue(db, 3);
    // Place 3 can never reach place 2 - simulates a bad geocode dropping it
    // off the road network.
    const provider = fakeProvider({ unroutable: [[PLACE_B.lat, PLACE_B.lng]] });

    const result = await drainQueue({ db, provider });
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);

    const row = await db('backfill_queue').where({ place_id: 3 }).first();
    assert.ok(row);
    assert.match(row.last_error, /road network/);
  });

  test('multiple due places are all drained in one provider lifecycle (start/stop called once, not per place)', async () => {
    await enqueue(db, 2);
    await enqueue(db, 3);
    const provider = fakeProvider();

    const result = await drainQueue({ db, provider });
    assert.equal(result.processed, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(provider.calls.start, 1);
    assert.equal(provider.calls.stop, 1);
  });
});

// The checkpoint's other required test: queued work must survive a
// simulated process restart. :memory: databases don't persist across
// connections by definition, so this uses a real temp file and two
// sequential Knex connections - the second standing in for "the process
// restarted and reconnected."
describe('queue durability across a simulated restart', () => {
  let filename;

  before(() => {
    filename = path.join(os.tmpdir(), `backfill-queue-restart-${Date.now()}.sqlite`);
  });

  after(() => {
    fs.rmSync(filename, { force: true });
    fs.rmSync(`${filename}-journal`, { force: true });
  });

  test('a queued entry (and its attempt history) is still there after reconnecting to the same file', async () => {
    const first = knexLib({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await first.migrate.latest();
    await first('places').insert({ id: 1, name: 'A', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng });
    await enqueue(first, 1);
    await recordFailure(first, 1, 'first attempt failed');
    await first.destroy(); // "process exits"

    const second = knexLib({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    try {
      const row = await second('backfill_queue').where({ place_id: 1 }).first();
      assert.ok(row, 'the queue entry must have survived the restart');
      assert.equal(row.attempts, 1);
      assert.equal(row.last_error, 'first attempt failed');
    } finally {
      await second.destroy();
    }
  });
});
