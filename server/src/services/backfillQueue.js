// Durable incremental-backfill queue (see the backfill_queue migration) and
// the worker that drains it. A place lands here on successful geocode (new
// place) or address change (checkpoint 4 wires those triggers in) - this
// module only owns the queue mechanics and the drain itself.
//
// Draining reuses services/matrixCache.js's backfillMatrix wholesale rather
// than hand-rolling a "one place vs. every other place" call: backfillMatrix
// already skips any pair that's already cached, so handing it the FULL
// current place set naturally reduces to "fetch only the queued places' rows
// and columns" - everything else is a no-op skip. One shared mechanism for
// both the initial bulk backfill and every incremental one after it.
const defaultConfig = require('../config/backfillQueue');
const { backfillMatrix, coverageReport, invalidatePlace } = require('./matrixCache');

// Queues `placeId` for backfill, or resets it to a fresh retry cycle if it's
// already queued (including an already-permanently-failed one - this IS the
// "manually retry" action, and the same path checkpoint 4's address-change
// invalidation uses).
//
// next_attempt_at is always a JS Date, here and in recordFailure below -
// deliberately never knex.fn.now()/CURRENT_TIMESTAMP. better-sqlite3 stores
// a bound Date as an INTEGER but CURRENT_TIMESTAMP as TEXT, and SQLite's
// type-affinity rules order every INTEGER before every TEXT value regardless
// of what they represent - a next_attempt_at compared against
// knex.fn.now() would silently be "due" forever. Keeping both sides a JS
// Date sidesteps the mismatch entirely, and works identically on Postgres.
async function enqueue(db, placeId) {
  const fresh = { place_id: placeId, attempts: 0, last_error: null, next_attempt_at: new Date(), failed_at: null };
  await db('backfill_queue').insert(fresh).onConflict('place_id').merge(fresh);
}

// The place-lifecycle hook: routes/places.js's POST (new place) and PATCH
// (address change) handlers call this with whatever geocodeAddress just
// returned. `coords` may be null (unrecognized address, saved anyway via
// confirm_address) - invalidation always runs (an address change makes any
// cached distance for this place stale, coords or not), enqueueing only
// runs when there's an actual coordinate to backfill from.
async function onPlaceGeocoded(db, placeId, coords) {
  await invalidatePlace(db, placeId);
  if (coords) await enqueue(db, placeId);
}

// Queue rows that are due and not permanently failed, oldest-due first.
async function dueQueueEntries(db, { limit = 200 } = {}) {
  return db('backfill_queue')
    .whereNull('failed_at')
    .where('next_attempt_at', '<=', new Date())
    .orderBy('next_attempt_at')
    .limit(limit)
    .select('*');
}

async function recordSuccess(db, placeId) {
  await db('backfill_queue').where({ place_id: placeId }).del();
}

// Increments attempts and either schedules the next retry (backoff, indexed
// by attempt number) or - once MAX_ATTEMPTS is reached - marks the row
// permanently failed. A failed row stays in the table (visible in the
// coverage report, retryable via enqueue()) rather than being deleted.
async function recordFailure(db, placeId, errorMessage, config = {}) {
  const cfg = { ...defaultConfig, ...config };
  const row = await db('backfill_queue').where({ place_id: placeId }).first();
  if (!row) return; // resolved/removed by something else already - nothing to record

  const attempts = row.attempts + 1;
  const update = { attempts, last_error: String(errorMessage).slice(0, 2000) };
  if (attempts >= cfg.MAX_ATTEMPTS) {
    update.failed_at = db.fn.now();
  } else {
    const waitMinutes = cfg.BACKOFF_MINUTES[attempts - 1] ?? cfg.BACKOFF_MINUTES[cfg.BACKOFF_MINUTES.length - 1];
    update.next_attempt_at = new Date(Date.now() + waitMinutes * 60 * 1000);
  }
  await db('backfill_queue').where({ place_id: placeId }).update(update);
}

// Drains everything currently due, starting the provider only if there's
// real work (see localOsrmProvider.js's header - no standing OSRM process).
// A provider.start() or backfillMatrix failure counts as one failed attempt
// for every due entry, same retry/backoff treatment as a single bad pair -
// see recordFailure. Never throws: a caller running this on an interval
// (server/src/index.js) must not crash on a bad OSRM path or a transient
// failure.
async function drainQueue({ db, provider, config = {} } = {}) {
  const cfg = { ...defaultConfig, ...config };
  const due = await dueQueueEntries(db);
  if (due.length === 0) return { processed: 0, succeeded: 0, failed: 0 };

  const places = await db('places').whereNotNull('lat').whereNotNull('lng').select('id', 'lat', 'lng');

  let backfillError = null;
  try {
    await provider.start();
    await backfillMatrix({ db, places, provider });
  } catch (err) {
    backfillError = err;
  } finally {
    await provider.stop();
  }

  if (backfillError) {
    for (const entry of due) await recordFailure(db, entry.place_id, backfillError.message, cfg);
    return { processed: due.length, succeeded: 0, failed: due.length };
  }

  const report = await coverageReport(db, places);
  const incompleteIds = new Set(report.incomplete.map((p) => p.id));

  let succeeded = 0;
  let failed = 0;
  for (const entry of due) {
    if (incompleteIds.has(entry.place_id)) {
      await recordFailure(db, entry.place_id, 'Incomplete road-network coverage after backfill - likely off the road network (bad geocode).', cfg);
      failed++;
    } else {
      await recordSuccess(db, entry.place_id);
      succeeded++;
    }
  }
  return { processed: due.length, succeeded, failed };
}

// Settings-page diagnostic (checkpoint 5) - queue depth split the same way
// the rest of this module already treats it: `due` will resolve on its own
// at the next drain (no action needed), `failed` needs a human (MAX_ATTEMPTS
// exhausted - almost always a bad geocode putting the place off the road
// network, see drainQueue's own comment).
async function queueHealth(db) {
  const [{ due }, { failed }] = await Promise.all([
    db('backfill_queue').whereNull('failed_at').count({ due: '*' }).first(),
    db('backfill_queue').whereNotNull('failed_at').count({ failed: '*' }).first(),
  ]);
  return { due: Number(due), failed: Number(failed) };
}

module.exports = { enqueue, onPlaceGeocoded, dueQueueEntries, recordSuccess, recordFailure, drainQueue, queueHealth };
