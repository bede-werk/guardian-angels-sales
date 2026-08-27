// Cached real-road distance matrix, backed by the place_distance table (see
// its migration). This is the read path route generation now depends on
// instead of a live OSRM /trip or /table call - see services/routeOptimizer.js
// for the callers and services/tsp.js for the solver this matrix feeds.
//
// A pair missing from the cache falls back to the geometric estimate
// (services/tsp.js's gridMeters, calibrated via config/matrixCache.js) and is
// reported in `missing` so a caller can flag the result as provisional
// rather than silently serving a worse answer. This never blocks: an empty
// table (before the first backfill) just means every pair falls back.
//
// `db` is a knex instance or an open transaction - same injected-db
// convention as services/capacity.js, so this is testable against an
// in-memory database.
const { gridMeters } = require('./tsp');
const defaultConfig = require('../config/matrixCache');

const MPH_TO_MPS = 0.44704;

// Comfortably under SQLite's default 500-term compound-SELECT limit, which
// is what .insert().onConflict().merge() compiles to per row on that
// dialect - see backfillMatrix's write loop.
const WRITE_BATCH = 400;

// @param places  Array<{id, lat, lng}>
// @param weight  'meters' | 'seconds'
// @returns {matrix: Float64Array[], missing: Array<[number,number]>, coverage: number}
//   matrix[i][j] is the cost from places[i] to places[j]. Not assumed
//   symmetric: one-way streets mean A->B and B->A can genuinely differ, and
//   the cache stores both directions separately.
async function loadMatrix(db, places, weight = 'seconds', config = {}) {
  if (weight !== 'meters' && weight !== 'seconds') {
    throw new Error(`loadMatrix: weight must be 'meters' or 'seconds', got '${weight}'`);
  }
  const cfg = { ...defaultConfig, ...config };
  const n = places.length;
  const ids = places.map((p) => p.id);
  const pos = new Map(ids.map((id, i) => [id, i]));

  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  const have = Array.from({ length: n }, () => new Uint8Array(n));
  for (let i = 0; i < n; i++) have[i][i] = 1;

  // A route's start point (homeBase) is user-entered coordinates, not a row
  // in `places` - it has no id, and can never have a cached row either. Keep
  // it out of the IN-list entirely: passing `undefined` as a bind parameter
  // throws in better-sqlite3, and it would never match anything anyway.
  const knownIds = ids.filter((id) => id != null);

  if (n > 1 && knownIds.length > 1) {
    const rows = await db('place_distance')
      .whereIn('from_place_id', knownIds)
      .whereIn('to_place_id', knownIds)
      .select('from_place_id as f', 'to_place_id as t', weight === 'seconds' ? 'seconds as w' : 'meters as w');

    for (const r of rows) {
      const i = pos.get(r.f);
      const j = pos.get(r.t);
      if (i === undefined || j === undefined || i === j) continue;
      matrix[i][j] = r.w;
      have[i][j] = 1;
    }
  }

  const fallbackMetersPerSecond = cfg.FALLBACK_SPEED_MPH * MPH_TO_MPS;
  const missing = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (have[i][j]) continue;
      missing.push([ids[i], ids[j]]);
      const meters = gridMeters(places[i], places[j], cfg.DETOUR_FACTOR);
      matrix[i][j] = weight === 'seconds' ? meters / fallbackMetersPerSecond : meters;
    }
  }

  const total = n * (n - 1);
  return {
    matrix,
    missing,
    coverage: total === 0 ? 1 : 1 - missing.length / total,
  };
}

// ---------------------------------------------------------------------------
// Write path - scripts/backfill-distances.js (the initial bulk run) and
// services/backfillQueue.js (the incremental worker) are the only callers.
// Never called from the request path.
// ---------------------------------------------------------------------------

/**
 * Fills in every missing directed pair among `places` using a RoutingProvider
 * (see services/localOsrmProvider.js - the only implementation today).
 * Chunked so no single request exceeds the provider's coordinate limit.
 * Idempotent: safe to re-run, only computes what's absent unless `force` is
 * set (e.g. after an OSM data refresh). Doesn't start/stop the provider
 * itself - that's the caller's job, since a caller may run several
 * backfillMatrix calls (or none, if the queue is empty) across one
 * provider lifecycle.
 *
 * A RoutingProvider must implement:
 *   async table(sources, destinations) -> {distances: number[][], durations: number[][]}
 *   where sources/destinations are Array<{lat, lng}>, and the returned
 *   matrices are indexed [source position][destination position].
 *
 * @param {object} opts
 * @param {import('knex')} opts.db
 * @param {Array<{id:number, lat:number, lng:number}>} opts.places
 * @param {{table: Function}} opts.provider
 * @param {number} [opts.chunk]     coordinates per axis per request
 * @param {boolean} [opts.force]    recompute pairs already cached
 * @param {(p:object)=>void} [opts.onProgress]
 */
async function backfillMatrix({ db, places, provider, chunk = 80, force = false, onProgress = () => {} }) {
  const n = places.length;
  if (n < 2) return { written: 0, skipped: 0 };

  const cached = new Set();
  if (!force) {
    const rows = await db('place_distance').select('from_place_id as f', 'to_place_id as t');
    for (const r of rows) cached.add(`${r.f}:${r.t}`);
  }

  const blocks = [];
  for (let i = 0; i < n; i += chunk) blocks.push([i, Math.min(i + chunk, n)]);

  let written = 0;
  let skipped = 0;
  const totalBlocks = blocks.length * blocks.length;
  let done = 0;

  for (const [s0, s1] of blocks) {
    for (const [d0, d1] of blocks) {
      const srcs = places.slice(s0, s1);
      const dsts = places.slice(d0, d1);

      // Skip the whole block if every pair in it is already cached.
      let needed = false;
      for (const a of srcs) {
        for (const b of dsts) {
          if (a.id === b.id) continue;
          if (!cached.has(`${a.id}:${b.id}`)) { needed = true; break; }
        }
        if (needed) break;
      }
      done++;
      onProgress({ block: done, totalBlocks, written, skipped });
      if (!needed) continue;

      const toCoord = (p) => ({ lat: p.lat, lng: p.lng });
      const { distances, durations } = await provider.table(srcs.map(toCoord), dsts.map(toCoord));

      const rows = [];
      for (let a = 0; a < srcs.length; a++) {
        for (let b = 0; b < dsts.length; b++) {
          const from = srcs[a].id;
          const to = dsts[b].id;
          if (from === to) continue;
          if (!force && cached.has(`${from}:${to}`)) { skipped++; continue; }
          const meters = distances?.[a]?.[b];
          const seconds = durations?.[a]?.[b];
          if (meters == null || seconds == null) continue; // unroutable (off the road network)
          rows.push({ from_place_id: from, to_place_id: to, meters, seconds, source: 'osrm', computed_at: new Date() });
        }
      }
      // SQLite compiles .insert().onConflict().merge() as one UNION-ALL'd
      // SELECT per row, and caps compound SELECTs at 500 terms - an 80x80
      // block (up to 6,320 directed pairs) blows well past that in one call,
      // so this writes in sub-batches regardless of dialect.
      for (let i = 0; i < rows.length; i += WRITE_BATCH) {
        const batch = rows.slice(i, i + WRITE_BATCH);
        await db('place_distance').insert(batch).onConflict(['from_place_id', 'to_place_id']).merge();
        written += batch.length;
      }
    }
  }

  return { written, skipped };
}

/**
 * Drops every cached pair involving `placeId`, in both directions. Called
 * when a place's address changes (routes/places.js's PATCH handler, via
 * backfillQueue.js's onPlaceGeocoded) - the old rows describe a location
 * that no longer applies, whether or not the new address re-geocoded
 * successfully. A harmless no-op for a place with nothing cached yet (e.g.
 * a brand-new place, or one that was never geocoded).
 */
async function invalidatePlace(db, placeId) {
  await db('place_distance').where('from_place_id', placeId).orWhere('to_place_id', placeId).del();
}

/** Which places have incomplete coverage. Also the settings-page (checkpoint 5) health check. */
async function coverageReport(db, places) {
  const n = places.length;
  const counts = new Map(places.map((p) => [p.id, 0]));
  const rows = await db('place_distance').select('from_place_id as f').count('* as c').groupBy('from_place_id');
  for (const r of rows) {
    if (counts.has(r.f)) counts.set(r.f, Number(r.c));
  }
  const expected = n - 1;
  const incomplete = [...counts.entries()]
    .filter(([, c]) => c < expected)
    .map(([id, c]) => ({ id, have: c, expected }));
  return {
    places: n,
    expectedRows: n * (n - 1),
    incomplete,
    complete: incomplete.length === 0,
  };
}

module.exports = { loadMatrix, backfillMatrix, coverageReport, invalidatePlace };
