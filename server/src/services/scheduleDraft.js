// Wires the pure route-planner engine (schedulingEngine.js/driveTime.js/
// scheduleGenerator.js/routeOptimizer.js) to the database. Owns the
// draft/commit lifecycle: generating a multi-day draft into
// schedule_drafts/schedule_draft_stops, live-recalculating a day on every
// read (never cached — see loadDraftDayView), collision handling
// (lockedElsewhere), and committing a day into real `visits` rows.
//
// The collision/commit DECISION logic is pulled out into plain functions
// (mergeLockedElsewhereIds, partitionCommittableStops) that take
// already-fetched rows and return a decision — no knex, no async — so it's
// directly unit-testable (see scheduleDraft.test.js) even though the
// queries that feed it aren't. This is the most consequential code in the
// planner (it's what stops two reps double-booking the same place), so it
// gets the same "query the DB, shape rows, call a pure function" split the
// rest of this stack uses.
const knex = require('../db/knex');
const defaultSchedulingConfig = require('../config/scheduling');
const { rankCandidates } = require('./schedulingEngine');
const { generateDraft, workingDays } = require('./scheduleGenerator');
const { optimizeRoute, getRouteLegMinutes } = require('./routeOptimizer');
const { evaluateTimeBlock, evaluateOptimizedTimeBlock, resolveVisitType, isGeocoded } = require('./driveTime');

// -- Pure: collision + commit-eligibility -----------------------------------

// Given the raw rows two separate queries return — that date's `visits`
// (any user, any status: two reps shouldn't be sent to the same place same
// day) and that date's OTHER users' active `schedule_draft_stops` (a place
// already claimed on someone else's in-progress draft for that date) —
// returns the unioned Set of place ids locked for that date. A place used
// elsewhere in the SAME user's own draft (any date) is a separate concern
// (own-draft dedupe), not folded in here — see ownDraftPlaceIds below.
function mergeLockedElsewhereIds({ committedRows = [], otherDraftRows = [] }) {
  const ids = new Set();
  for (const row of committedRows) ids.add(row.place_id);
  for (const row of otherDraftRows) ids.add(row.place_id);
  return ids;
}

// Given a day's current draft stops and a freshly-queried locked-id set
// (re-checked right before commit — time may have passed since a stop was
// added to the draft), splits them into what can become real `visits` rows
// and what collided since. Never throws/fails the whole commit — a
// collision is reported back, not silently dropped or fatal.
function partitionCommittableStops(stops, lockedPlaceIds) {
  const committable = [];
  const skippedCollisions = [];
  for (const stop of stops) {
    (lockedPlaceIds.has(stop.place_id) ? skippedCollisions : committable).push(stop);
  }
  return { committable, skippedCollisions };
}

module.exports.mergeLockedElsewhereIds = mergeLockedElsewhereIds;
module.exports.partitionCommittableStops = partitionCommittableStops;

// -- DB-touching layer --------------------------------------------------

// UTC-safe "today", matching scheduleGenerator.js's hand-rolled date
// convention (no dayjs in this half of the stack) rather than dashboard.js's
// local-time dayjs default — this feeds directly into schedulingEngine's own
// UTC date math.
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Queries `places` plus, per place: last COMPLETED visit date, count of
// completed visits in the trailing FATIGUE_WINDOW_DAYS before `today`, and
// next_visit_date off the most recent visit (any status) that set one.
// Shapes rows into rankCandidates' expected input, minus `lockedElsewhere`
// (date-specific — attached separately, see generateAndPersistDraft/
// getSuggestions). Reduces multiple queries to one-row-per-place in JS
// rather than correlated subqueries — more portable across SQLite/Postgres.
async function buildCandidatePool(db, { today }) {
  const places = await db('places').select('*');

  const completedVisits = await db('visits')
    .where({ status: 'completed' })
    .whereNotNull('place_id')
    .orderBy('place_id')
    .orderBy('scheduled_date', 'desc')
    .select('place_id', 'scheduled_date');

  const lastVisitByPlace = {};
  for (const v of completedVisits) {
    if (!lastVisitByPlace[v.place_id]) lastVisitByPlace[v.place_id] = v.scheduled_date;
  }

  const fatigueCutoff = daysBeforeUTC(today, defaultSchedulingConfig.FATIGUE_WINDOW_DAYS);
  const recentCounts = {};
  for (const v of completedVisits) {
    if (v.scheduled_date >= fatigueCutoff && v.scheduled_date <= today) {
      recentCounts[v.place_id] = (recentCounts[v.place_id] || 0) + 1;
    }
  }

  const nextDateVisits = await db('visits')
    .whereNotNull('place_id')
    .whereNotNull('next_visit_date')
    .orderBy('place_id')
    .orderBy('scheduled_date', 'desc')
    .select('place_id', 'next_visit_date');
  const nextVisitByPlace = {};
  for (const v of nextDateVisits) {
    if (!nextVisitByPlace[v.place_id]) nextVisitByPlace[v.place_id] = v.next_visit_date;
  }

  return places.map((place) => ({
    place,
    lastVisitDate: lastVisitByPlace[place.id] || null,
    recentCompletedCount: recentCounts[place.id] || 0,
    nextVisitDate: nextVisitByPlace[place.id] || null,
  }));
}

function daysBeforeUTC(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// The raw-query half of mergeLockedElsewhereIds. Used at generation and
// addStop time to steer a rep away from a place another rep is ALREADY
// drafting, on top of what's already actually committed — reduces how often
// a collision arises at all. Deliberately NOT used at commit time — see
// committedElsewherePlaceIds below for why that needs a narrower check.
async function lockedElsewherePlaceIds(db, { date, userId }) {
  const committedRows = await db('visits').where({ scheduled_date: date }).whereNotNull('place_id').select('place_id');
  const otherDraftRows = await db('schedule_draft_stops as s')
    .join('schedule_drafts as d', 'd.id', 's.draft_id')
    .where('s.date', date)
    .whereNot('d.user_id', userId)
    .select('s.place_id');
  return mergeLockedElsewhereIds({ committedRows, otherDraftRows });
}

// What actually blocks a COMMIT: real `visits` rows only, never another
// user's still-uncommitted draft stops. Confirmed necessary by the
// two-user smoke test: using lockedElsewherePlaceIds (which also counts
// other drafts) here deadlocked BOTH reps out of ever committing a place
// they each independently had in their own still-open draft — neither
// commit could succeed, since each saw the other's uncommitted draft as a
// lock. An uncommitted draft is a proposal, not a claim; first to actually
// commit is the only real lock, so this only looks at `visits`.
async function committedElsewherePlaceIds(db, { date }) {
  const rows = await db('visits').where({ scheduled_date: date }).whereNotNull('place_id').select('place_id');
  return new Set(rows.map((r) => r.place_id));
}

// A place already used anywhere in THIS user's own active draft (any date) —
// separate from lockedElsewhere, which is specifically about other reps'
// commitments/drafts. Mirrors generateDraft()'s existing in-memory
// dedupe-across-days behavior.
async function ownDraftPlaceIds(db, draftId) {
  const rows = await db('schedule_draft_stops').where({ draft_id: draftId }).select('place_id');
  return new Set(rows.map((r) => r.place_id));
}

async function getActiveDraft(db, userId) {
  return db('schedule_drafts').where({ user_id: userId }).orderBy('id', 'desc').first();
}

async function createDraft(db, { userId, params }) {
  const [inserted] = await db('schedule_drafts').insert({ user_id: userId, params_json: JSON.stringify(params) }).returning('id');
  return knex.extractId(inserted);
}

async function deleteDraft(db, draftId) {
  await db('schedule_drafts').where({ id: draftId }).del(); // cascades to schedule_draft_stops
}

async function assertOwnsDraft(db, draftId, userId) {
  const draft = await db('schedule_drafts').where({ id: draftId }).first();
  if (!draft) {
    const err = new Error('Draft not found');
    err.status = 404;
    throw err;
  }
  if (draft.user_id !== userId) {
    const err = new Error('Not your draft');
    err.status = 403;
    throw err;
  }
  return draft;
}

// Builds (or, with `regenerate: true`, rebuilds) a user's active draft.
// The candidate pool + engine call (generateDraft, which may make several
// real OSRM network calls — see routeOptimizer.js/scheduleGenerator.js) run
// OUTSIDE any DB transaction: holding a SQLite transaction open across
// several seconds of network I/O would lock the whole database file for
// writes for the duration, blocking every other request. Only the final
// persistence step (delete-old + insert-new draft rows) is wrapped in one.
//
// lockedElsewhere is computed ONCE, against `today` (generation time), not
// re-checked per day within this multi-day run — scheduleGenerator's
// generateDraft() takes a single candidate pool for the whole window, so
// there's no per-day hook for it here. This is conservative (a place locked
// by another rep for tomorrow stays excluded from the whole draft, even a
// day it'd actually be free) rather than risky (double-booking) — and the
// per-day suggestions/addStop below re-check lockedElsewhere fresh against
// each specific date, so a user can still pick it up later if it's
// genuinely free that day.
async function generateAndPersistDraft({ userId, params, regenerate = false }) {
  const today = params.today || todayUTC();
  const fullParams = {
    daysAhead: params.daysAhead ?? 5,
    workingWeekdays: params.workingWeekdays ?? [1, 2, 3, 4, 5],
    exceptionDates: params.exceptionDates ?? [],
    hoursPerDay: params.hoursPerDay ?? 4,
    homeBase: params.homeBase,
    zoneOverrides: params.zoneOverrides ?? {},
    today,
  };

  const existing = await getActiveDraft(knex, userId);
  if (existing && !regenerate) return loadDraftView(knex, existing.id);

  const basePool = await buildCandidatePool(knex, { today });
  const locked = await lockedElsewherePlaceIds(knex, { date: today, userId });
  const candidates = basePool.map((c) => ({ ...c, lockedElsewhere: locked.has(c.place.id) }));

  const { days } = await generateDraft({
    candidates,
    today,
    daysAhead: fullParams.daysAhead,
    workingWeekdays: fullParams.workingWeekdays,
    exceptionDates: fullParams.exceptionDates,
    hoursPerDay: fullParams.hoursPerDay,
    homeBase: fullParams.homeBase,
    zoneOverrides: fullParams.zoneOverrides,
    optimizeRoute, // real OSRM-backed optimizer, finally wired in (phase 5 left it opt-in)
  });

  return knex.transaction(async (trx) => {
    // Re-check inside the transaction: another generate call could have run
    // between the read above and now.
    const stillExisting = await getActiveDraft(trx, userId);
    if (stillExisting && !regenerate) return loadDraftView(trx, stillExisting.id);
    if (stillExisting) await deleteDraft(trx, stillExisting.id);

    const draftId = await createDraft(trx, { userId, params: fullParams });

    const rows = [];
    for (const day of days) {
      day.stops.forEach((stop, i) => {
        rows.push({ draft_id: draftId, date: day.date, place_id: stop.place_id, visit_type: stop.visitType || null, sort_order: i });
      });
    }
    if (rows.length > 0) await trx('schedule_draft_stops').insert(rows);

    return loadDraftView(trx, draftId);
  });
}

function toDraftStopShape(row) {
  return {
    place_id: row.id,
    place_name: row.name,
    stop_id: row.stop_id,
    region: row.region,
    lat: row.lat,
    lng: row.lng,
    visitType: row.visit_type || row.default_visit_type,
    category: row.category,
    tier: row.tier,
    address: row.address,
    city: row.city,
    zip: row.zip,
  };
}

// Real-first, haversine-fallback time evaluation for a day's stops IN THEIR
// CURRENT ORDER — never resequences (see routeOptimizer.js's
// getRouteLegMinutes header for why that matters for live-edit recalc).
async function evaluateDay(stops, { homeBase, budgetMinutes }) {
  if (stops.length === 0) {
    return { stops: [], totalMinutes: 0, remainingMinutes: budgetMinutes, overBudget: false };
  }

  const legs = await getRouteLegMinutes({ start: homeBase, stops });
  const result = legs
    ? evaluateOptimizedTimeBlock(stops, legs.legMinutes, { start: homeBase, budgetMinutes })
    : evaluateTimeBlock(stops, { start: homeBase, budgetMinutes });

  return { ...result, overBudget: result.remainingMinutes < 0 };
}

// Full recalculated draft (every day) — the "live workspace" read. Nothing
// here is cached: every call re-derives running totals/overBudget flags from
// the currently-persisted stops, matching this app's existing "no manual
// fields that need upkeep" convention (referralMetrics.js works the same
// way). Days with zero stops still appear (reconstructed via
// scheduleGenerator's workingDays(), the same helper generateDraft() uses
// internally) rather than silently vanishing.
async function loadDraftView(db, draftId) {
  const draft = await db('schedule_drafts').where({ id: draftId }).first();
  if (!draft) return null;
  const params = JSON.parse(draft.params_json);

  const stopRows = await db('schedule_draft_stops as s')
    .join('places as p', 'p.id', 's.place_id')
    .where('s.draft_id', draftId)
    .orderBy('s.date')
    .orderBy('s.sort_order')
    .select('s.id as stop_id', 's.date', 's.visit_type', 'p.*');

  const byDate = {};
  for (const row of stopRows) {
    (byDate[row.date] ||= []).push(row);
  }

  const dates = workingDays({
    today: params.today,
    daysAhead: params.daysAhead,
    workingWeekdays: params.workingWeekdays,
    exceptionDates: params.exceptionDates,
  });
  const budgetMinutes = params.hoursPerDay * 60;

  const days = [];
  for (const date of dates) {
    const rows = byDate[date] || [];
    const stops = rows.map(toDraftStopShape);
    const evaluated = await evaluateDay(stops, { homeBase: params.homeBase, budgetMinutes });
    days.push({ date, zone: params.zoneOverrides?.[date] ?? rows[0]?.region ?? null, ...evaluated });
  }

  return { id: draft.id, userId: draft.user_id, params, days };
}

// Same as loadDraftView but scoped to one day — what every mutation endpoint
// returns, so a reorder/add/remove/visit-type-change doesn't need to
// recompute (or transmit) every other day.
async function loadDraftDayView(db, draftId, date) {
  const draft = await db('schedule_drafts').where({ id: draftId }).first();
  if (!draft) return null;
  const params = JSON.parse(draft.params_json);

  const rows = await db('schedule_draft_stops as s')
    .join('places as p', 'p.id', 's.place_id')
    .where({ 's.draft_id': draftId, 's.date': date })
    .orderBy('s.sort_order')
    .select('s.id as stop_id', 's.visit_type', 'p.*');

  const stops = rows.map(toDraftStopShape);
  const budgetMinutes = params.hoursPerDay * 60;
  const evaluated = await evaluateDay(stops, { homeBase: params.homeBase, budgetMinutes });

  return { date, zone: params.zoneOverrides?.[date] ?? rows[0]?.region ?? null, ...evaluated };
}

// Adds a stop (from a suggestion, or ad hoc) to one day of a draft.
// Rejects (409) a place already used anywhere else in this user's own draft,
// or locked elsewhere (committed by anyone, or on another user's active
// draft) for this specific date — both checked fresh, not against whatever
// was true when the draft was generated.
async function addStop({ draftId, userId, date, placeId, visitType }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);

    const own = await ownDraftPlaceIds(trx, draftId);
    if (own.has(placeId)) {
      const err = new Error('That place is already in this draft');
      err.status = 409;
      throw err;
    }

    const locked = await lockedElsewherePlaceIds(trx, { date, userId });
    if (locked.has(placeId)) {
      const err = new Error('That place is already booked elsewhere for this date');
      err.status = 409;
      throw err;
    }

    const place = await trx('places').where({ id: placeId }).first();
    if (!place) {
      const err = new Error('Place not found');
      err.status = 404;
      throw err;
    }

    const { max } = await trx('schedule_draft_stops').where({ draft_id: draftId, date }).max('sort_order as max').first();
    const nextSortOrder = (max ?? -1) + 1;

    await trx('schedule_draft_stops').insert({ draft_id: draftId, date, place_id: placeId, visit_type: visitType || null, sort_order: nextSortOrder });

    return loadDraftDayView(trx, draftId, date);
  });
}

async function removeStop({ draftId, userId, date, placeId }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeId }).del();
    return loadDraftDayView(trx, draftId, date);
  });
}

// Discards the whole proposal — every day, not just one. Unlike
// generate({ regenerate: true }), this doesn't build a replacement; the
// caller goes back to having no active draft at all. Ownership-checked
// (unlike the bare deleteDraft() above, which trusts its caller already did
// that — this is the one entry point meant to be reachable directly from a
// route). Nothing to return: once it's gone, there's no draft left to load.
async function deleteActiveDraft({ draftId, userId }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await deleteDraft(trx, draftId);
  });
}

async function reorderDay({ draftId, userId, date, placeIds }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    for (let i = 0; i < placeIds.length; i++) {
      await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeIds[i] }).update({ sort_order: i });
    }
    return loadDraftDayView(trx, draftId, date);
  });
}

async function setVisitType({ draftId, userId, date, placeId, visitType }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeId }).update({ visit_type: visitType || null });
    return loadDraftDayView(trx, draftId, date);
  });
}

// Re-sequences a day's stops via a real OSRM /trip call — the ONE mutation
// that's allowed to resequence, since a user clicking "Re-optimize" is
// explicitly asking for that. Every other mutation above deliberately
// preserves whatever order the stops are already in (see
// routeOptimizer.js's getRouteLegMinutes header for why that matters for
// the rest of the live-edit loop). Only reorders stops with coordinates —
// an ungeocoded stop (rare; see driveTime.js's isGeocoded) has no honest
// route to compute, so it's left at the end in its current relative order
// rather than dropped. Falls back to leaving the whole day's order
// untouched if OSRM is unreachable/times out (optimizeRoute returns null) —
// this never drops a stop, only fails to reorder it.
async function reoptimizeDay({ draftId, userId, date }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);

    const draft = await trx('schedule_drafts').where({ id: draftId }).first();
    const params = JSON.parse(draft.params_json);

    const rows = await trx('schedule_draft_stops as s')
      .join('places as p', 'p.id', 's.place_id')
      .where({ 's.draft_id': draftId, 's.date': date })
      .orderBy('s.sort_order')
      .select('s.id as stop_id', 's.visit_type', 'p.*');

    const stops = rows.map(toDraftStopShape);
    const routable = stops.filter(isGeocoded);
    const unroutable = stops.filter((s) => !isGeocoded(s));

    if (routable.length < 2) return loadDraftDayView(trx, draftId, date); // nothing worth reordering

    const result = await optimizeRoute({ start: params.homeBase, stops: routable });
    if (!result) return loadDraftDayView(trx, draftId, date); // OSRM unreachable — order stays as-is

    const newOrder = [...result.orderedStops, ...unroutable];
    for (let i = 0; i < newOrder.length; i++) {
      await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: newOrder[i].place_id }).update({ sort_order: i });
    }

    return loadDraftDayView(trx, draftId, date);
  });
}

// Nearby eligible candidates not yet in the draft, for the "day is under
// budget — want to add one more?" suggestion. Mostly wiring: eligibility/
// ranking already exist in schedulingEngine.js.
async function getSuggestions({ draftId, userId, date, limit = 5 }) {
  await assertOwnsDraft(knex, draftId, userId);

  const own = await ownDraftPlaceIds(knex, draftId);
  const locked = await lockedElsewherePlaceIds(knex, { date, userId });
  const excluded = new Set([...own, ...locked]);

  const basePool = await buildCandidatePool(knex, { today: date });
  const candidates = basePool
    .filter((c) => !excluded.has(c.place.id))
    .map((c) => ({ ...c, lockedElsewhere: false })); // already excluded above

  const ranked = rankCandidates(candidates, { today: date, config: defaultSchedulingConfig });

  const dayView = await loadDraftDayView(knex, draftId, date);
  const inZone = dayView?.zone ? ranked.filter((c) => c.place.region === dayView.zone) : ranked;
  const top = (inZone.length > 0 ? inZone : ranked).slice(0, limit);

  return top.map((c) => ({
    place_id: c.place.id,
    name: c.place.name,
    region: c.place.region,
    city: c.place.city,
    category: c.place.category,
  }));
}

// Commits one day's draft stops into real `visits` rows. Re-checks
// lockedElsewhere right before writing (time may have passed since a stop
// was added) — any stop that's since collided is excluded and reported back
// in `skippedCollisions` rather than failing the whole commit. Either way,
// the day's draft stops are cleared afterward — a collided stop can't be
// committed here, and leaving it in the still-draft view would just invite
// hitting the same collision again.
async function commitDay({ draftId, userId, date }) {
  return knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);

    const rows = await trx('schedule_draft_stops as s')
      .join('places as p', 'p.id', 's.place_id')
      .where({ 's.draft_id': draftId, 's.date': date })
      .select('s.place_id', 's.visit_type', 's.sort_order', 'p.name as place_name', 'p.default_visit_type');

    if (rows.length === 0) return { date, committed: [], skippedCollisions: [] };

    const locked = await committedElsewherePlaceIds(trx, { date });
    const { committable, skippedCollisions } = partitionCommittableStops(rows, locked);

    // Resolve down to a concrete type here (draft override -> place default
    // -> config default) rather than passing s.visit_type through as-is —
    // otherwise a stop that only ever inherited its type from the place's
    // default_visit_type (never an explicit override) would commit with
    // visit_type: null, silently losing the very duration info the draft
    // view showed the whole time it was being edited.
    const visitRows = committable.map((r) => ({
      place_id: r.place_id,
      visit_type: resolveVisitType(r.visit_type || r.default_visit_type),
      place_name: r.place_name,
      user_id: userId,
      scheduled_date: date,
      status: 'planned',
      sort_order: r.sort_order,
    }));
    if (visitRows.length > 0) await trx('visits').insert(visitRows);

    await trx('schedule_draft_stops').where({ draft_id: draftId, date }).del();

    return {
      date,
      committed: visitRows,
      skippedCollisions: skippedCollisions.map((r) => ({ place_id: r.place_id, place_name: r.place_name })),
    };
  });
}

async function commitAll({ draftId, userId }) {
  const dateRows = await knex('schedule_draft_stops').where({ draft_id: draftId }).distinct('date').select('date').orderBy('date');
  const results = [];
  for (const { date } of dateRows) {
    results.push(await commitDay({ draftId, userId, date }));
  }
  return results;
}

module.exports = {
  mergeLockedElsewhereIds,
  partitionCommittableStops,
  buildCandidatePool,
  lockedElsewherePlaceIds,
  committedElsewherePlaceIds,
  ownDraftPlaceIds,
  getActiveDraft,
  createDraft,
  deleteDraft,
  generateAndPersistDraft,
  loadDraftView,
  loadDraftDayView,
  addStop,
  removeStop,
  deleteActiveDraft,
  reorderDay,
  setVisitType,
  reoptimizeDay,
  getSuggestions,
  commitDay,
  commitAll,
};
