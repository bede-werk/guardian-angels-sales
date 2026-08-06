// Informational, non-blocking warning: flags a visit when a DIFFERENT rep
// has a visit (planned or completed) to the same place within
// config.HARD_FLOOR_DAYS of it. Nothing in the app enforces this across
// reps/dates today — schedulingEngine.js's hard floor only sees the current
// rep's own candidate pool, and scheduleDraft.js's commit-time collision
// check (committedElsewherePlaceIds) is deliberately scoped to the exact
// same calendar date only (see its own comment). This module doesn't change
// any of that eligibility/collision logic — it only surfaces the gap as a
// tag a rep can see, same "warn, don't block" spirit as
// alreadyVisitedTodayPlaceIds.
//
// Split query/pure like the rest of this stack (schedulingEngine.js,
// scheduleDraft.js's mergeLockedElsewhereIds): crossRepVisitsByPlace does
// the one batched DB read, findCrossRepFloorWarning is a plain-object-in,
// plain-object-out function that's directly unit-testable.
const { daysSince } = require('./schedulingEngine');

// Batched across every place in `placeIds` — never one query per place.
// Excludes 'skipped' visits: a visit that didn't happen isn't a real
// collision. Returns Map<place_id, [{id, place_id, user_id, user_name,
// scheduled_date, status}]>.
async function crossRepVisitsByPlace(db, placeIds) {
  const ids = [...new Set(placeIds)].filter((id) => id != null);
  const byPlace = new Map();
  if (!ids.length) return byPlace;
  const rows = await db('visits as v')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .whereIn('v.place_id', ids)
    .whereNot('v.status', 'skipped')
    .select('v.id', 'v.place_id', 'v.user_id', 'u.name as user_name', 'v.scheduled_date', 'v.status');
  for (const row of rows) {
    if (!byPlace.has(row.place_id)) byPlace.set(row.place_id, []);
    byPlace.get(row.place_id).push(row);
  }
  return byPlace;
}

// Pure. Scans `placeVisits` (every non-skipped visit at `visit`'s place, from
// crossRepVisitsByPlace) for the nearest OTHER-rep visit within
// config.HARD_FLOOR_DAYS days, in either direction. Strict `<`, matching
// schedulingEngine.js's own hard-floor boundary (daysSince(...) <
// config.HARD_FLOOR_DAYS) exactly. Returns the nearest match (smallest gap)
// or null.
function findCrossRepFloorWarning(visit, placeVisits, config) {
  if (!visit || !visit.user_id || !visit.scheduled_date || visit.status === 'skipped') return null;
  let best = null;
  for (const other of placeVisits || []) {
    if (other.id === visit.id) continue;
    if (!other.user_id || other.user_id === visit.user_id) continue;
    if (!other.scheduled_date || other.status === 'skipped') continue;
    const gap = Math.abs(daysSince(other.scheduled_date, visit.scheduled_date));
    if (gap < config.HARD_FLOOR_DAYS && (!best || gap < best.gap)) {
      best = { userName: other.user_name || 'another rep', scheduledDate: other.scheduled_date, visitId: other.id, gap };
    }
  }
  return best ? { userName: best.userName, scheduledDate: best.scheduledDate, visitId: best.visitId } : null;
}

// Thin pure wrapper — maps findCrossRepFloorWarning over a list of visits
// (all belonging to places present in `byPlace`), attaching the result as
// `crossRepFloorWarning`. Doesn't mutate the input array/objects.
function attachCrossRepFloorWarnings(visits, byPlace, config) {
  return visits.map((v) => ({
    ...v,
    crossRepFloorWarning: findCrossRepFloorWarning(v, byPlace.get(v.place_id) || [], config),
  }));
}

module.exports = { crossRepVisitsByPlace, findCrossRepFloorWarning, attachCrossRepFloorWarnings };
