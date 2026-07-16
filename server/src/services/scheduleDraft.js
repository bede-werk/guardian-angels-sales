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
const { generateDraft } = require('./scheduleGenerator');
const { optimizeRoute, getRouteLegMinutes } = require('./routeOptimizer');
const { evaluateTimeBlock, evaluateOptimizedTimeBlock, resolveVisitType, isGeocoded } = require('./driveTime');

// Recognizes a unique-constraint violation across both engines this app runs
// on (SQLite in dev, Postgres in prod) — see commitDay's per-row insert loop,
// which relies on this to distinguish "this row lost a race" (skip it) from
// a real error (rethrow).
function isUniqueViolation(err) {
  return err.code === '23505' // Postgres
    || (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT'))
    || /unique constraint/i.test(err.message || '');
}

// Calendar-driven planning: the user hand-picks which dates to plan (and how
// many hours on each) rather than the old "N days ahead" auto-window, so
// these are UI-facing bounds on that selection rather than generator config.
const MAX_PLAN_DATES = 10;
// A day's ranking/candidate pool is only as fresh as the moment it was
// generated — a commitment that becomes due, or a new higher-priority place,
// between generation and the actual visit date won't retroactively reshuffle
// an already-proposed day. Capping how far out a date can be planned bounds
// how stale a proposal can get before the rep would naturally regenerate it
// anyway. Chosen with Bede 2026-07-15: a week out — counted in weekdays (see
// maxPlanDateUTC below), not raw calendar days, at Bede's request the same
// day: a weekend sitting in the middle of the window shouldn't eat into it.
const MAX_DAYS_AHEAD = 7;

// Validates + normalizes the `days` the client sent for /generate: every
// entry must be a real future date with a positive hoursPerDay, no date can
// be picked twice, and — the actual fix for "I can still plan a day I
// already committed" — no date already carrying a committed visit for this
// user is allowed through. Pure (no knex) so it's directly unit-testable;
// `committedDates` is a Set the caller already queried fresh.
function validateDays(rawDays, { today, committedDates }) {
  if (!Array.isArray(rawDays) || rawDays.length === 0) {
    const err = new Error('Pick at least one date to plan for');
    err.status = 400;
    throw err;
  }
  if (rawDays.length > MAX_PLAN_DATES) {
    const err = new Error(`Cannot plan more than ${MAX_PLAN_DATES} dates at once`);
    err.status = 400;
    throw err;
  }

  const maxDate = maxPlanDateUTC(today);
  const seen = new Set();
  const normalized = [];
  for (const entry of rawDays) {
    const date = entry?.date;
    const hoursPerDay = Number(entry?.hoursPerDay);

    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const err = new Error(`Invalid date: ${date}`);
      err.status = 400;
      throw err;
    }
    if (date < today) {
      const err = new Error(`${date} is in the past — pick today or a future date`);
      err.status = 400;
      throw err;
    }
    if (date > maxDate) {
      const err = new Error(`${date} is more than ${MAX_DAYS_AHEAD} days out — pick a closer date`);
      err.status = 400;
      throw err;
    }
    if (isWeekendUTC(date)) {
      const err = new Error(`${date} is a weekend — visits are only planned Mon-Fri`);
      err.status = 400;
      throw err;
    }
    if (!(hoursPerDay > 0)) {
      const err = new Error(`Invalid hours for ${date}`);
      err.status = 400;
      throw err;
    }
    if (seen.has(date)) {
      const err = new Error(`${date} was selected twice`);
      err.status = 400;
      throw err;
    }
    seen.add(date);
    if (committedDates.has(date)) {
      const err = new Error(`${date} already has committed visits — pick a different date`);
      err.status = 409;
      throw err;
    }
    normalized.push({ date, hoursPerDay });
  }

  normalized.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return normalized;
}


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

// Guardian Angels operates out of one office (Lincoln, NE — America/Chicago),
// so "today" is computed in that fixed zone rather than raw UTC. Using UTC
// directly caused a real bug: for several hours every evening (once UTC has
// already rolled to the next calendar day, any time after ~7pm Central), the
// server's idea of "today" was a day ahead of every rep's browser (which
// computes "today" in ITS local timezone — see PlanVisits.jsx's todayISO()) —
// spuriously rejecting an evening plan-for-today request as "in the past."
// A fixed IANA zone (not a client-supplied one) keeps this server-
// authoritative rather than trusting client input for something logic-
// relevant. formatToParts (not a locale's default format string) guarantees
// exact YYYY-MM-DD regardless of ICU/locale quirks.
function orgToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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

// The latest date validateDays allows — walks forward from `today` one day
// at a time, only counting weekdays (Mon-Fri) against MAX_DAYS_AHEAD, so a
// Saturday/Sunday inside the window doesn't shrink the actual planning
// horizon. A weekend date that ends up inside the resulting window is still
// itself selectable (this only affects where the boundary lands, not which
// dates within it are pickable).
function maxPlanDateUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  let remaining = MAX_DAYS_AHEAD;
  while (remaining > 0) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay(); // 0 = Sunday, 6 = Saturday
    if (dow !== 0 && dow !== 6) remaining--;
  }
  return dt.toISOString().slice(0, 10);
}

// Visits are only ever planned Mon-Fri — validateDays rejects a weekend date
// outright rather than just excluding it from the MAX_DAYS_AHEAD count.
function isWeekendUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
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

// Every date this user already has a real `visits` row on — from committing
// a previous draft, or logged directly outside the planner. Once a date is
// in here, the calendar disables it and /generate rejects it (see
// validateDays) — a committed day is done, not something a future plan
// should ever touch again. Scoped to today-or-later: a past committed date
// can never be selected anyway (validateDays rejects any date <= today on
// its own), so there's no reason to drag the user's full visit history
// through this query as it grows over time.
async function committedDateSummaries(db, userId, { today } = {}) {
  const cutoff = today || orgToday();
  const rows = await db('visits')
    .where({ user_id: userId })
    .andWhere('scheduled_date', '>=', cutoff)
    .groupBy('scheduled_date')
    .orderBy('scheduled_date')
    .select('scheduled_date as date')
    .count('* as count');
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

async function committedDatesForUser(db, userId, { today } = {}) {
  const summaries = await committedDateSummaries(db, userId, { today });
  return new Set(summaries.map((s) => s.date));
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
  const today = params.today || orgToday();

  const existing = await getActiveDraft(knex, userId);
  if (existing && !regenerate) return loadDraftView(knex, existing.id);

  const committedDates = await committedDatesForUser(knex, userId, { today });
  const days = validateDays(params.days, { today, committedDates });
  const fullParams = {
    days,
    homeBase: params.homeBase,
    zoneOverrides: params.zoneOverrides ?? {},
  };

  const basePool = await buildCandidatePool(knex, { today });
  const locked = await lockedElsewherePlaceIds(knex, { date: today, userId });
  const candidates = basePool.map((c) => ({ ...c, lockedElsewhere: locked.has(c.place.id) }));

  const { days: generatedDays } = await generateDraft({
    candidates,
    days: fullParams.days,
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
    for (const day of generatedDays) {
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

// Real `visits` rows already committed for this user — shown ALONGSIDE
// (never instead of) whatever's still left in the draft for that date,
// since a partial commit (some stops hit a same-day collision and stayed in
// the draft — see commitDay's skippedCollisions) can leave both non-empty
// for the same day. Read-only here: editing an already-committed visit goes
// through the normal visit-log flow elsewhere in the app (PersonDetail/
// PlaceDetail), not this draft UI. `place_id` can be null (detach-not-
// delete) — the left join and the `place_name` snapshot column both exist
// specifically to survive that.
function committedVisitsQuery(db, { userId }) {
  return db('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .where({ 'v.user_id': userId })
    .orderBy('v.sort_order')
    .select(
      'v.id as visit_id',
      'v.place_id',
      'v.place_name',
      'v.visit_type',
      'v.status',
      'v.outcome',
      'v.scheduled_date',
      'v.sort_order',
      'p.category',
      'p.tier',
      'p.address',
      'p.city',
      'p.zip'
    );
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
// way). Days with zero stops still appear (one per params.days entry — the
// exact dates the user picked at generate time) rather than silently
// vanishing.
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

  const dates = params.days.map((d) => d.date);
  const hoursPerDayByDate = Object.fromEntries(params.days.map((d) => [d.date, d.hoursPerDay]));

  // One query for the whole window's committed visits, grouped by date in
  // JS — same "reduce multiple rows to one-per-key in JS rather than N
  // queries in a loop" precedent this codebase already uses (see
  // buildCandidatePool/dashboard.js), instead of a query per day.
  const committedRows = await committedVisitsQuery(db, { userId: draft.user_id }).whereIn('v.scheduled_date', dates);
  const committedByDate = {};
  for (const row of committedRows) (committedByDate[row.scheduled_date] ||= []).push(row);

  const days = [];
  for (const date of dates) {
    const rows = byDate[date] || [];
    const stops = rows.map(toDraftStopShape);
    const budgetMinutes = hoursPerDayByDate[date] * 60;
    const evaluated = await evaluateDay(stops, { homeBase: params.homeBase, budgetMinutes });
    days.push({ date, zone: params.zoneOverrides?.[date] ?? rows[0]?.region ?? null, committed: committedByDate[date] || [], ...evaluated });
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
  const hoursPerDay = params.days.find((d) => d.date === date)?.hoursPerDay ?? 0;
  const budgetMinutes = hoursPerDay * 60;
  const evaluated = await evaluateDay(stops, { homeBase: params.homeBase, budgetMinutes });
  const committed = await committedVisitsQuery(db, { userId: draft.user_id }).where('v.scheduled_date', date);

  return { date, zone: params.zoneOverrides?.[date] ?? rows[0]?.region ?? null, committed, ...evaluated };
}

// Adds a stop (from a suggestion, or ad hoc) to one day of a draft.
// Rejects (409) a place already used anywhere else in this user's own draft,
// or locked elsewhere (committed by anyone, or on another user's active
// draft) for this specific date — both checked fresh, not against whatever
// was true when the draft was generated.
async function addStop({ draftId, userId, date, placeId, visitType }) {
  return knex.transaction(async (trx) => {
    const draft = await assertOwnsDraft(trx, draftId, userId);
    const draftParams = JSON.parse(draft.params_json);
    if (!draftParams.days.some((d) => d.date === date)) {
      const err = new Error('That date is not part of this draft');
      err.status = 400;
      throw err;
    }

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
    if (!isGeocoded(place)) {
      const err = new Error("This place doesn't have map coordinates yet and can't be added to a route — geocode its address first.");
      err.status = 400;
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

// Discards just one day's still-open proposal, as if that date had never
// been picked at generate time: its stops are deleted AND the date itself is
// dropped from params.days, so it stops being a day this draft has an
// opinion about at all (unlike every other per-day mutation here, which
// keeps every date in params.days fixed — see loadDraftView). The rest of
// the draft (its other days) is untouched, and so is anything already
// accepted for THIS day (a prior partial commit's visits rows live in
// `visits`, not `schedule_draft_stops`, so this can never touch them). If
// this was the last remaining date, the whole draft is deleted rather than
// left behind as an empty, dateless husk — returns null in that case (same
// "no active draft" shape getActiveDraft/loadDraftView return), otherwise
// the full recalculated draft view (there's no single "day view" to hand
// back once the day itself no longer exists).
async function discardDay({ draftId, userId, date }) {
  return knex.transaction(async (trx) => {
    const draft = await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date }).del();

    const params = JSON.parse(draft.params_json);
    const remainingDays = params.days.filter((d) => d.date !== date);

    if (remainingDays.length === 0) {
      await deleteDraft(trx, draftId);
      return null;
    }

    await trx('schedule_drafts').where({ id: draftId }).update({ params_json: JSON.stringify({ ...params, days: remainingDays }) });
    return loadDraftView(trx, draftId);
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
      .select('s.place_id', 's.visit_type', 's.sort_order', 'p.name as place_name', 'p.default_visit_type', 'p.lat', 'p.lng');

    if (rows.length === 0) return { date, committed: [], skippedCollisions: [] };

    // Defense-in-depth: a stop can have gone ungeocoded AFTER being added to
    // the draft (its place's address was edited and re-geocoding failed) —
    // addStop's own isGeocoded check only guards the moment of adding. Never
    // silently commit something that isn't even visible in the draft view;
    // treat it the same as a real collision.
    const geocodedRows = rows.filter((r) => isGeocoded({ lat: r.lat, lng: r.lng }));
    const ungeocodedRows = rows.filter((r) => !isGeocoded({ lat: r.lat, lng: r.lng }));

    const locked = await committedElsewherePlaceIds(trx, { date });
    const { committable, skippedCollisions: precheckCollisions } = partitionCommittableStops(geocodedRows, locked);

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
      // Distinguishes a planner-committed visit from one logged directly via
      // "Log a visit" (which stays the DB's plain 'manual' default) — needed
      // so visits_place_date_active_unique (see that migration) can be scoped
      // to only the planner's own commits. Logging two ad-hoc manual visits
      // to the same place on the same day (e.g. two different contacts met
      // there) is a legitimate, unrelated capability this must not restrict —
      // only two reps' planner commits racing for the same place/date should
      // ever be blocked.
      source: 'planner',
    }));

    // Insert one row at a time (rather than one bulk insert) so that a
    // unique-constraint violation on a single row — the TOCTOU race the
    // pre-check above can miss under READ COMMITTED, now closed by the
    // visits_place_date_active_unique partial index — only knocks that one
    // row out instead of failing the whole day's commit.
    const committedRows = [];
    const raceCollisions = [];
    for (const row of visitRows) {
      try {
        await trx('visits').insert(row);
        committedRows.push(row);
      } catch (err) {
        if (isUniqueViolation(err)) {
          raceCollisions.push(row);
        } else {
          throw err;
        }
      }
    }

    await trx('schedule_draft_stops').where({ draft_id: draftId, date }).del();

    const skippedCollisions = [
      ...precheckCollisions.map((r) => ({ place_id: r.place_id, place_name: r.place_name })),
      ...ungeocodedRows.map((r) => ({ place_id: r.place_id, place_name: r.place_name })),
      ...raceCollisions.map((r) => ({ place_id: r.place_id, place_name: r.place_name })),
    ];

    return {
      date,
      committed: committedRows,
      skippedCollisions,
    };
  });
}

async function commitAll({ draftId, userId }) {
  const draft = await assertOwnsDraft(knex, draftId, userId);
  const params = JSON.parse(draft.params_json);
  const validDates = new Set(params.days.map((d) => d.date));
  const dateRows = await knex('schedule_draft_stops').where({ draft_id: draftId }).distinct('date').select('date').orderBy('date');
  const results = [];
  for (const { date } of dateRows) {
    if (!validDates.has(date)) continue; // stray/orphaned date — shouldn't exist post-fix, skip defensively
    results.push(await commitDay({ draftId, userId, date }));
  }
  return results;
}

// Undoes a whole day's commit — the counterpart to commitDay/commitAll.
// Deliberately scoped to status: 'planned': a rep who's already logged an
// outcome for one of that day's stops has real completed/skipped history
// there, which this must never touch (same "never destroy visit history"
// spirit as detach-not-delete elsewhere in this app — see project-overview)
// — only the still-open plan gets removed. Once this empties a date out
// entirely, committedDateSummaries naturally stops counting it, which is
// what frees it back up as a selectable calendar date.
async function deleteCommittedDay(db, { userId, date }) {
  return db('visits').where({ user_id: userId, scheduled_date: date, status: 'planned' }).del();
}

module.exports = {
  MAX_PLAN_DATES,
  MAX_DAYS_AHEAD,
  validateDays,
  mergeLockedElsewhereIds,
  partitionCommittableStops,
  buildCandidatePool,
  lockedElsewherePlaceIds,
  committedElsewherePlaceIds,
  committedDatesForUser,
  committedDateSummaries,
  ownDraftPlaceIds,
  getActiveDraft,
  createDraft,
  deleteDraft,
  generateAndPersistDraft,
  loadDraftView,
  loadDraftDayView,
  addStop,
  removeStop,
  discardDay,
  deleteActiveDraft,
  reorderDay,
  setVisitType,
  reoptimizeDay,
  getSuggestions,
  commitDay,
  commitAll,
  deleteCommittedDay,
};
