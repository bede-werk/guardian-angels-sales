const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const { loadMatrix, backfillMatrix, coverageReport, invalidatePlace } = require('./matrixCache');
const { gridMeters } = require('./tsp');
const matrixCacheConfig = require('../config/matrixCache');

const DOWNTOWN = { id: 1, lat: 40.8136, lng: -96.7026 };
const EAST_LINCOLN = { id: 2, lat: 40.8140, lng: -96.6200 };
const SOUTHWEST_LINCOLN = { id: 3, lat: 40.7550, lng: -96.7700 };

describe('loadMatrix', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'Downtown', category: 'Hospice', lat: DOWNTOWN.lat, lng: DOWNTOWN.lng },
      { id: 2, name: 'East Lincoln', category: 'Hospice', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng },
      { id: 3, name: 'Southwest Lincoln', category: 'Hospice', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng },
    ]);
  });

  test('reports coverage: 0 and every off-diagonal pair as missing against an empty table', async () => {
    const places = [DOWNTOWN, EAST_LINCOLN, SOUTHWEST_LINCOLN];
    const { coverage, missing, matrix } = await loadMatrix(db, places, 'seconds');

    assert.equal(coverage, 0);
    assert.equal(missing.length, 6); // 3 places * 2 directions
    for (const [from, to] of missing) {
      assert.notEqual(from, to);
    }
    // Every off-diagonal cell still gets a real (fallback) number, not NaN/undefined.
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue;
        assert.ok(Number.isFinite(matrix[i][j]), `matrix[${i}][${j}] must be finite`);
      }
    }
  });

  test('a fully cached set reports coverage: 1 and no missing pairs', async () => {
    const places = [DOWNTOWN, EAST_LINCOLN];
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 5000, seconds: 600 },
      { from_place_id: 2, to_place_id: 1, meters: 5200, seconds: 640 },
    ]);

    const { coverage, missing, matrix } = await loadMatrix(db, places, 'seconds');
    assert.equal(coverage, 1);
    assert.equal(missing.length, 0);
    assert.equal(matrix[0][1], 600);
    assert.equal(matrix[1][0], 640);
  });

  test('a cached row is used for its own direction; the reverse direction falls back independently if absent', async () => {
    const places = [DOWNTOWN, EAST_LINCOLN];
    await db('place_distance').insert({ from_place_id: 1, to_place_id: 2, meters: 5000, seconds: 600 });

    const { coverage, missing, matrix } = await loadMatrix(db, places, 'seconds');
    assert.equal(coverage, 0.5, 'exactly one of the two directed pairs is cached');
    assert.deepEqual(missing, [[2, 1]]);
    assert.equal(matrix[0][1], 600, 'the cached direction is used as-is');

    const fallbackMeters = gridMeters(EAST_LINCOLN, DOWNTOWN, matrixCacheConfig.DETOUR_FACTOR);
    const fallbackMps = matrixCacheConfig.FALLBACK_SPEED_MPH * 0.44704;
    assert.ok(Math.abs(matrix[1][0] - fallbackMeters / fallbackMps) < 1e-6, 'the uncached reverse direction uses the geometric fallback');
  });

  test('weight: meters returns raw distance instead of duration, for both cached and fallback pairs', async () => {
    const places = [DOWNTOWN, EAST_LINCOLN];
    await db('place_distance').insert({ from_place_id: 1, to_place_id: 2, meters: 5000, seconds: 600 });

    const { matrix } = await loadMatrix(db, places, 'meters');
    assert.equal(matrix[0][1], 5000, 'cached direction returns meters, not seconds');

    const fallbackMeters = gridMeters(EAST_LINCOLN, DOWNTOWN, matrixCacheConfig.DETOUR_FACTOR);
    assert.ok(Math.abs(matrix[1][0] - fallbackMeters) < 1e-6);
  });

  test('rejects an unrecognized weight rather than silently building a meaningless matrix', async () => {
    await assert.rejects(() => loadMatrix(db, [DOWNTOWN, EAST_LINCOLN], 'furlongs'));
  });

  test('the matrix is not assumed symmetric: a cached A->B does not backfill B->A', async () => {
    const places = [DOWNTOWN, EAST_LINCOLN];
    // A deliberately asymmetric pair, as a one-way street would produce.
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 5000, seconds: 600 },
      { from_place_id: 2, to_place_id: 1, meters: 9000, seconds: 1400 },
    ]);

    const { matrix } = await loadMatrix(db, places, 'seconds');
    assert.equal(matrix[0][1], 600);
    assert.equal(matrix[1][0], 1400);
    assert.notEqual(matrix[0][1], matrix[1][0]);
  });

  test('a point with no id (e.g. a user-entered homeBase, not a real place row) never crashes and always falls back', async () => {
    const homeBase = { lat: 40.82, lng: -96.68 }; // no `id`
    await db('place_distance').insert({ from_place_id: 1, to_place_id: 2, meters: 5000, seconds: 600 });

    const { matrix, missing, coverage } = await loadMatrix(db, [homeBase, DOWNTOWN, EAST_LINCOLN], 'seconds');
    // 3 points -> 6 directed pairs total; only Downtown->East (1 of the 6) is cached.
    assert.ok(Math.abs(coverage - 1 / 6) < 1e-9, `only the one real cached pair (Downtown->East, index 1->2) counts, got ${coverage}`);
    assert.ok(missing.some(([f]) => f === undefined), 'the id-less point is reported as missing, not silently dropped');
    assert.ok(Number.isFinite(matrix[0][1]) && Number.isFinite(matrix[0][2]), 'legs to/from the id-less point still get a real fallback number');
  });

  test('n=0 and n=1 report full coverage with an empty matrix/missing list', async () => {
    const empty = await loadMatrix(db, [], 'seconds');
    assert.deepEqual(empty, { matrix: [], missing: [], coverage: 1 });

    const single = await loadMatrix(db, [DOWNTOWN], 'seconds');
    assert.equal(single.coverage, 1);
    assert.deepEqual(single.missing, []);
    assert.equal(single.matrix[0][0], 0);
  });
});

describe('backfillMatrix', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'Downtown', category: 'Hospice', lat: DOWNTOWN.lat, lng: DOWNTOWN.lng },
      { id: 2, name: 'East Lincoln', category: 'Hospice', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng },
      { id: 3, name: 'Southwest Lincoln', category: 'Hospice', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng },
    ]);
  });

  // A fake RoutingProvider: every pair gets a distinct, deterministic
  // meters/seconds value derived from the actual place ids (recovered from
  // each coordinate via a lat/lng -> id lookup, since the provider interface
  // only ever sees coordinates). `unroutable` takes [fromId, toId] pairs.
  function fakeProvider(places, { unroutable = [] } = {}) {
    const idAtCoord = new Map(places.map((p) => [`${p.lng},${p.lat}`, p.id]));
    return {
      async table(sources, destinations) {
        const idOf = (p) => idAtCoord.get(`${p.lng},${p.lat}`);
        const build = (offset) => sources.map((s) => destinations.map((d) => {
          const from = idOf(s);
          const to = idOf(d);
          return unroutable.some(([a, b]) => a === from && b === to) ? null : offset + from * 10 + to;
        }));
        return { distances: build(1000), durations: build(100) };
      },
    };
  }

  test('writes a directed row for every non-self pair in a single block', async () => {
    const places = [{ id: 1, lat: DOWNTOWN.lat, lng: DOWNTOWN.lng }, { id: 2, lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }, { id: 3, lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }];

    const { written, skipped } = await backfillMatrix({ db, places, provider: fakeProvider(places) });
    assert.equal(written, 6); // 3 places, 2 directions each
    assert.equal(skipped, 0);

    const rows = await db('place_distance').select('*').orderBy(['from_place_id', 'to_place_id']);
    assert.equal(rows.length, 6);
    assert.ok(rows.every((r) => r.source === 'osrm'));
  });

  test('is idempotent: a second run with force:false writes nothing new', async () => {
    const places = [{ id: 1, lat: DOWNTOWN.lat, lng: DOWNTOWN.lng }, { id: 2, lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }];
    const provider = fakeProvider(places);

    await backfillMatrix({ db, places, provider });
    const before = await db('place_distance').select('*').orderBy('from_place_id');

    // A whole-block-already-cached re-run is skipped before ever calling the
    // provider (see backfillMatrix's `needed` check) - `skipped` only counts
    // pairs within a block that WAS fetched, not pairs that skipped the
    // fetch entirely. The test below exercises that per-pair counting path.
    const { written, skipped } = await backfillMatrix({ db, places, provider });
    assert.equal(written, 0);
    assert.equal(skipped, 0);

    const after = await db('place_distance').select('*').orderBy('from_place_id');
    assert.deepEqual(after, before, 'nothing changed on the re-run');
  });

  test('a partially-cached block still fetches, and skips only the pairs already cached', async () => {
    // 3 places, one block (chunk covers all of them) - pre-cache just the
    // 1->2 direction so the block as a whole is still "needed" (2->1, 1->3,
    // 3->1, 2->3, 3->2 are missing), exercising the per-pair skip counter
    // rather than the whole-block skip from the test above.
    await db('place_distance').insert({ from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1, source: 'osrm' });
    const places = [{ id: 1, lat: DOWNTOWN.lat, lng: DOWNTOWN.lng }, { id: 2, lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }, { id: 3, lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng }];

    const { written, skipped } = await backfillMatrix({ db, places, provider: fakeProvider(places) });
    assert.equal(written, 5, 'the 5 still-missing directed pairs');
    assert.equal(skipped, 1, 'the one already-cached pair, within a block that still had to be fetched');

    const preserved = await db('place_distance').where({ from_place_id: 1, to_place_id: 2 }).first();
    assert.equal(preserved.meters, 1, 'the pre-existing row must not have been overwritten');
  });

  test('force:true recomputes pairs already cached', async () => {
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1, source: 'osrm' },
      { from_place_id: 2, to_place_id: 1, meters: 1, seconds: 1, source: 'osrm' },
    ]);
    const places = [{ id: 1, lat: DOWNTOWN.lat, lng: DOWNTOWN.lng }, { id: 2, lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }];

    const { written } = await backfillMatrix({ db, places, provider: fakeProvider(places), force: true });
    assert.equal(written, 2);

    const row = await db('place_distance').where({ from_place_id: 1, to_place_id: 2 }).first();
    assert.notEqual(row.meters, 1, 'the stale placeholder value must have been overwritten');
  });

  test('chunking: a place set larger than `chunk` is covered across multiple provider calls', async () => {
    await db('places').insert([
      { id: 4, name: 'D', category: 'Hospice', lat: 40.80, lng: -96.71 },
      { id: 5, name: 'E', category: 'Hospice', lat: 40.81, lng: -96.72 },
    ]);
    const places = [1, 2, 3, 4, 5].map((id) => ({ id, lat: 40.8 + id * 0.001, lng: -96.7 + id * 0.001 }));

    const progressCalls = [];
    const { written } = await backfillMatrix({
      db, places, provider: fakeProvider(places), chunk: 2,
      onProgress: (p) => progressCalls.push(p),
    });

    assert.equal(written, 20); // 5 places * 4 directions each
    assert.ok(progressCalls.length > 1, 'multiple blocks must have been processed');
    assert.equal(progressCalls[progressCalls.length - 1].block, progressCalls[progressCalls.length - 1].totalBlocks);
  });

  test('an unroutable pair (provider returns null) is skipped, not written as a garbage row', async () => {
    const places = [{ id: 1, lat: DOWNTOWN.lat, lng: DOWNTOWN.lng }, { id: 2, lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng }];

    const { written } = await backfillMatrix({ db, places, provider: fakeProvider(places, { unroutable: [[1, 2]] }) }); // place 1 -> place 2 has no route
    assert.equal(written, 1, 'only the routable direction was written');

    const row = await db('place_distance').where({ from_place_id: 1, to_place_id: 2 }).first();
    assert.equal(row, undefined);
    const reverse = await db('place_distance').where({ from_place_id: 2, to_place_id: 1 }).first();
    assert.ok(reverse);
  });

  test('a set smaller than 2 places is a no-op, and never touches the provider', async () => {
    const bogusProvider = { table: () => { throw new Error('provider should not have been called'); } };
    const result = await backfillMatrix({ db, places: [{ id: 1, lat: 40.8, lng: -96.7 }], provider: bogusProvider });
    assert.deepEqual(result, { written: 0, skipped: 0 });
  });
});

describe('coverageReport', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'Downtown', category: 'Hospice', lat: DOWNTOWN.lat, lng: DOWNTOWN.lng },
      { id: 2, name: 'East Lincoln', category: 'Hospice', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng },
      { id: 3, name: 'Southwest Lincoln', category: 'Hospice', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng },
    ]);
  });

  test('reports complete when every place has n-1 rows', async () => {
    const places = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1 },
      { from_place_id: 1, to_place_id: 3, meters: 1, seconds: 1 },
      { from_place_id: 2, to_place_id: 1, meters: 1, seconds: 1 },
      { from_place_id: 2, to_place_id: 3, meters: 1, seconds: 1 },
      { from_place_id: 3, to_place_id: 1, meters: 1, seconds: 1 },
      { from_place_id: 3, to_place_id: 2, meters: 1, seconds: 1 },
    ]);

    const report = await coverageReport(db, places);
    assert.equal(report.complete, true);
    assert.deepEqual(report.incomplete, []);
    assert.equal(report.places, 3);
    assert.equal(report.expectedRows, 6);
  });

  test('reports each under-covered place with its actual/expected row counts', async () => {
    const places = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1 },
      // place 1 is missing its row to place 3 (has 1 of 2 expected)
      // place 2 has none at all (has 0 of 2 expected)
      { from_place_id: 3, to_place_id: 1, meters: 1, seconds: 1 },
      { from_place_id: 3, to_place_id: 2, meters: 1, seconds: 1 },
    ]);

    const report = await coverageReport(db, places);
    assert.equal(report.complete, false);
    assert.deepEqual(
      report.incomplete.sort((a, b) => a.id - b.id),
      [{ id: 1, have: 1, expected: 2 }, { id: 2, have: 0, expected: 2 }]
    );
  });

  test('an empty cache reports every place as fully incomplete', async () => {
    const places = [{ id: 1 }, { id: 2 }];
    const report = await coverageReport(db, places);
    assert.equal(report.complete, false);
    assert.deepEqual(
      report.incomplete.sort((a, b) => a.id - b.id),
      [{ id: 1, have: 0, expected: 1 }, { id: 2, have: 0, expected: 1 }]
    );
  });
});

describe('invalidatePlace', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('place_distance').del();
    await db('places').del();
    await db('places').insert([
      { id: 1, name: 'Downtown', category: 'Hospice', lat: DOWNTOWN.lat, lng: DOWNTOWN.lng },
      { id: 2, name: 'East Lincoln', category: 'Hospice', lat: EAST_LINCOLN.lat, lng: EAST_LINCOLN.lng },
      { id: 3, name: 'Southwest Lincoln', category: 'Hospice', lat: SOUTHWEST_LINCOLN.lat, lng: SOUTHWEST_LINCOLN.lng },
    ]);
  });

  test('drops every row involving the given place, in both directions, leaving unrelated pairs alone', async () => {
    await db('place_distance').insert([
      { from_place_id: 1, to_place_id: 2, meters: 1, seconds: 1 },
      { from_place_id: 2, to_place_id: 1, meters: 1, seconds: 1 },
      { from_place_id: 2, to_place_id: 3, meters: 1, seconds: 1 },
    ]);

    await invalidatePlace(db, 1);

    const touched = await db('place_distance').where('from_place_id', 1).orWhere('to_place_id', 1);
    assert.equal(touched.length, 0);
    const untouched = await db('place_distance').where({ from_place_id: 2, to_place_id: 3 }).first();
    assert.ok(untouched, 'a pair not involving place 1 must survive');
  });

  test('is a harmless no-op when the place has nothing cached', async () => {
    await assert.doesNotReject(() => invalidatePlace(db, 999));
  });
});
