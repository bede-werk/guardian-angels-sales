// A stop (proposed or committed) whose place's address CHANGED since the
// stop was set - checkpoint 6's staleness finding. Keyed off
// places.address_changed_at (20260827000000), not geocoded_at: geocoded_at
// bumps on every PATCH that merely re-submits the same address (and on any
// future bulk re-geocode), which would flag the whole roster at once -
// address_changed_at is stamped only when the address actually differs
// (routes/places.js's PATCH handler is the only writer).
//
// This is NOT about the rep being sent to a wrong address: every read
// resolves a stop's address/coordinates LIVE via a join to `places` (see
// scheduleDraft.js's toDraftStopShape/committedVisitsQuery - neither
// schedule_draft_stops nor visits stores its own lat/lng/address), so the
// rep always sees the place's current, correct address. What's stale is the
// DRIVE-TIME NUMBERS the day's totals were built from: they were computed
// against a location that no longer applies, and matrixCache.js's
// invalidatePlace (checkpoint 4) drops the cached distance the moment the
// address changes - so the next read recomputes silently, which is exactly
// what Locked Decision #5 says never to do without telling the rep.
//
// Permanent once true, by design (checkpoint 6 decision, option 3): there is
// no "reviewed it, dismiss" state anywhere in this schema to hang a clear
// condition on, and the two rejected alternatives both have a real failure
// mode - a time-box clears the flag on a stop that is still genuinely
// wrong, and a dismiss/acknowledge state is new schema this app doesn't need
// yet (revisit only if this turns out to fire often - see the checkpoint 6
// count). The condition can only be true for a stop that predates the
// address move, so a stop created/committed AFTER the move is never flagged
// by construction - no clearing logic is needed for that half.
// Normalizes a timestamp column's value to an epoch number, regardless of
// which shape the driver handed back. Postgres (production) always returns
// a JS Date for a timestamp column; better-sqlite3 (dev) returns whatever
// was actually written - a raw 'YYYY-MM-DD HH:MM:SS' string for a
// knex.fn.now() default, or a Date/epoch-int for an explicit JS Date write.
// Comparing two values in THE SAME shape is safe either way (a naive
// `new Date(string)` misparses SQLite's no-timezone string as local time,
// but the same misparse-shift cancels out against another string) - the
// real risk is comparing MIXED shapes, which is exactly the checkpoint-3
// bug class (backfillQueue.js's own header) recurring here. Normalizing
// both sides through this before comparing removes that risk regardless of
// which shape either one happens to be in.
function toEpoch(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`).getTime();
  }
  return new Date(value).getTime();
}

function isAddressStale(place, referenceCreatedAt) {
  if (!place || !place.address_changed_at || !referenceCreatedAt) return false;
  return toEpoch(place.address_changed_at) > toEpoch(referenceCreatedAt);
}

// Same { type, severity, placeId } vocabulary conflictDetection.js's
// Conflict and doNotVisit.js's doNotVisitFinding use, so this rides the one
// findings array every caller (and the one badge every client) already has,
// instead of a second parallel signal. Deliberately its own type
// (ADDRESS_CHANGED), not folded into usedFallback (services/routeOptimizer.js) -
// "we're estimating this leg" and "a stop on this day moved and these times
// are stale" are different facts a rep needs told apart.
function staleAddressFinding(place, referenceCreatedAt) {
  if (!isAddressStale(place, referenceCreatedAt)) return null;
  return { type: 'ADDRESS_CHANGED', severity: 'soft', placeId: place.id ?? null };
}

module.exports = { isAddressStale, staleAddressFinding };
