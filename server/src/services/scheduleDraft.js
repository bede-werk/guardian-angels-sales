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
const defaultDriveConfig = require('../config/driveTime');
const defaultVisitTypesConfig = require('../config/visitTypes');
const defaultRouteOptimizerConfig = require('../config/routeOptimizer');
const { rankCandidates } = require('./schedulingEngine');
const { generateDraft, fillDayFromZone, orderedZones, outOfZoneCommitments } = require('./scheduleGenerator');
const { optimizeRoute, getRouteLegMinutes } = require('./routeOptimizer');
const { evaluateTimeBlock, evaluateOptimizedTimeBlock, resolveVisitType, isGeocoded } = require('./driveTime');
const { orgToday } = require('./orgDate');
const { computeRelationshipForPlaces, relationshipFor } = require('./relationship');

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
// Default hours budget for a date reopenCommittedDay adds to a draft's
// params.days on the fly (there's no UI step to pick hours when reopening an
// already-committed day — the rep is editing stops, not re-picking a
// schedule). Mirrors RoutePlanner.jsx's own DEFAULT_HOURS_PER_DAY constant —
// keep the two equal.
const DEFAULT_HOURS_PER_DAY = 4;
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

// orgToday (the org's "today" in America/Chicago, not UTC — see
// services/orgDate.js for the real evening-rollover bug that pinned it to a
// fixed zone) now lives in its own module, since services/relationship.js
// needs the same notion of today for its decay clock. Imported at the top of
// this file; this comment is just a signpost for anyone looking for it here.

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

  // Fatigue counts DISTINCT DAYS visited, not visit rows. One visit row is one
  // person met, so meeting three contacts at a place in a single afternoon
  // writes three rows — counting rows would burn three quarters of the
  // 4-visit fatigue budget for what was actually one trip, stretching that
  // place's cadence as if it were being over-serviced and pushing it DOWN the
  // priority list. Fatigue is about how often we show up, not how many
  // conversations happened once we were there.
  const fatigueCutoff = daysBeforeUTC(today, defaultSchedulingConfig.FATIGUE_WINDOW_DAYS);
  const recentDaysByPlace = {};
  for (const v of completedVisits) {
    if (v.scheduled_date >= fatigueCutoff && v.scheduled_date <= today) {
      if (!recentDaysByPlace[v.place_id]) recentDaysByPlace[v.place_id] = new Set();
      recentDaysByPlace[v.place_id].add(v.scheduled_date);
    }
  }
  const recentCounts = {};
  for (const [placeId, days] of Object.entries(recentDaysByPlace)) {
    recentCounts[placeId] = days.size;
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

  // Relationship level is computed, not stored (services/relationship.js) —
  // fetched once for the WHOLE pool here, exactly like the three lookups
  // above, because this function runs on every draft generation across every
  // place. A per-place call here would be catastrophic.
  //
  // `asOf: today` only: the spec's per-day re-evaluation (a place's
  // relationship decays a little further on day 5 of a plan than on day 1) is
  // deliberately out of scope for now — computeRelationshipForPlaces already
  // takes asOf so threading a per-day date through generateDraft later won't
  // need to touch this call site's shape.
  const relationshipByPlace = await computeRelationshipForPlaces(db, places.map((p) => p.id), { asOf: today });

  return places.map((place) => ({
    place,
    lastVisitDate: lastVisitByPlace[place.id] || null,
    recentCompletedCount: recentCounts[place.id] || 0,
    nextVisitDate: nextVisitByPlace[place.id] || null,
    // The EFFECTIVE level — a manual override wins over the computed value,
    // which is the whole point of the override existing.
    relationshipLevel: relationshipFor(relationshipByPlace, place.id).effective_level,
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

// The raw-query half of mergeLockedElsewhereIds, scoped to one date. Used by
// addStop/getDayZones/selectDayZone/getSuggestions to steer a rep away from
// a place another rep is ALREADY drafting, on top of what's already
// actually committed, for the one specific date each of those acts on —
// reduces how often a collision arises at all. Deliberately NOT used at
// commit time — see committedElsewherePlaceIds below for why that needs a
// narrower check. Bulk multi-date generation uses
// lockedElsewherePlaceIdsByDate instead (see its header for why a single
// date isn't enough there).
async function lockedElsewherePlaceIds(db, { date, userId }) {
  // Status-filtered the same way visits.js's own same-date collision check
  // is (see routes/visits.js's POST /visits) — a skipped visit never
  // happened, so it must not block the date for anyone else either.
  const committedRows = await db('visits').where({ scheduled_date: date }).whereNotNull('place_id').whereIn('status', ['planned', 'completed']).select('place_id');
  const otherDraftRows = await db('schedule_draft_stops as s')
    .join('schedule_drafts as d', 'd.id', 's.draft_id')
    .where('s.date', date)
    .whereNot('d.user_id', userId)
    .select('s.place_id');
  return mergeLockedElsewhereIds({ committedRows, otherDraftRows });
}

// Bulk counterpart to lockedElsewherePlaceIds: one query pair for EVERY date
// in a multi-day generation window, grouped by date in JS (same
// reduce-multiple-rows-to-one-per-key precedent as buildCandidatePool/
// loadDraftView) instead of one query pair per day. This is what lets
// generateAndPersistDraft give generateDraft a real per-date lock set —
// without it, a place another rep already has specifically on day 3 of the
// window has no way to be excluded from day 3 without the caller running
// this per date anyway.
async function lockedElsewherePlaceIdsByDate(db, { dates, userId }) {
  const byDate = {};
  for (const date of dates) byDate[date] = new Set();
  if (dates.length === 0) return byDate;

  // Same status filter as lockedElsewherePlaceIds/committedElsewherePlaceIds
  // above — this is the bulk sibling that feeds real multi-day generation
  // (generateAndPersistDraft), so a skipped visit incorrectly blocking a
  // date here matters more than the other two, not less.
  const committedRows = await db('visits').whereIn('scheduled_date', dates).whereNotNull('place_id').whereIn('status', ['planned', 'completed']).select('scheduled_date', 'place_id');
  for (const row of committedRows) byDate[row.scheduled_date].add(row.place_id);

  const otherDraftRows = await db('schedule_draft_stops as s')
    .join('schedule_drafts as d', 'd.id', 's.draft_id')
    .whereIn('s.date', dates)
    .whereNot('d.user_id', userId)
    .select('s.date', 's.place_id');
  for (const row of otherDraftRows) byDate[row.date].add(row.place_id);

  return byDate;
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
  // Same status filter as lockedElsewherePlaceIds above, for the same
  // reason: a skipped visit releases the date immediately, it doesn't hold it.
  const rows = await db('visits').where({ scheduled_date: date }).whereNotNull('place_id').whereIn('status', ['planned', 'completed']).select('place_id');
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

// Every date this user has a still-open (status: 'planned') visits row on —
// from committing a previous draft, or a planned visit logged directly
// outside the planner. Once a date is in here, the calendar disables it and
// /generate rejects it (see validateDays) — a planned day is done, not
// something a future plan should ever touch again. Deliberately excludes
// completed/skipped visits: those are finished history, not an open plan —
// a date where the only visit on the books is already completed should
// still be freely plannable. Scoped to status: 'planned' for the same
// reason deleteCommittedDay is (see its own comment) — keeping the two in
// sync means a date's count here always matches what Delete would actually
// remove. Scoped to today-or-later: a past committed date can never be
// selected anyway (validateDays rejects any date <= today on its own), so
// there's no reason to drag the user's full visit history through this
// query as it grows over time.
async function committedDateSummaries(db, userId, { today } = {}) {
  const cutoff = today || orgToday();
  const rows = await db('visits')
    .where({ user_id: userId, status: 'planned' })
    .andWhere('scheduled_date', '>=', cutoff)
    .groupBy('scheduled_date')
    .orderBy('scheduled_date')
    .select('scheduled_date as date')
    .count('* as count');
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

// The actual visits behind one "Already Planned" row — same user+date+
// status: 'planned' scope as committedDateSummaries above, so the list a
// rep sees after clicking a day always matches that day's count exactly
// (and never includes a completed/skipped visit that happens to share the
// date). Left-joins `places` for category/address/city/zip since a visit's
// place can be detached (place_id null, or the row simply gone) — v.place_name
// is the detach-safe snapshot, always present regardless.
// Includes v.scheduled_date/notes/status even though every row here is
// necessarily on `date` and status:'planned' (both already fixed by the where
// clause) — PlannedDayModal's "View visit" action feeds a row straight into
// UpcomingVisitDetailModal (status included: VisitLogModal uses it to decide
// whether its Date field is editable), which would otherwise show a blank
// header date.
//
// The person_* snapshot columns are NOT here anymore: they moved onto
// `visit_encounters` in 20260806000000_split_visit_encounters.js, and every
// row this returns is status:'planned' — a trip that hasn't happened yet, so
// it has no encounters at all until it's actually logged. There is nothing
// real to join to. (UpcomingVisitDetailModal now says exactly that in place
// of the old contact line.) Deliberately not a left join to
// visit_encounters either: a logged trip can carry several, which would emit
// the same visit once per person met and duplicate rows in a list whose
// whole contract is "one row per planned visit".
async function committedDayVisits(db, userId, date) {
  return db('visits as v')
    .leftJoin('places as p', 'v.place_id', 'p.id')
    .where({ 'v.user_id': userId, 'v.scheduled_date': date, 'v.status': 'planned' })
    .orderBy('v.sort_order')
    .select(
      'v.id as visit_id',
      'v.place_id',
      'v.place_name',
      'v.visit_type',
      'v.scheduled_date',
      'v.status',
      'v.notes',
      'p.category',
      'p.address',
      'p.city',
      'p.zip'
    );
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
// lockedElsewhere is computed per DATE across the whole window up front
// (lockedElsewherePlaceIdsByDate, one query pair for every day being
// planned rather than one per day) and handed to generateDraft as
// `lockedByDate`, which re-derives each candidate's flag fresh every
// iteration of its day loop — see that function's header for why a single
// flag computed once against generation-day used to miss a place locked
// specifically on a LATER date in the window (it would get proposed there,
// then rejected at commit by committedElsewherePlaceIds, which is correctly
// date-scoped). The per-day suggestions/addStop endpoints below were never
// affected by this — they already re-check lockedElsewhere fresh against
// their one specific date.
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
  const lockedByDate = await lockedElsewherePlaceIdsByDate(knex, { dates: fullParams.days.map((d) => d.date), userId });

  const { days: generatedDays } = await generateDraft({
    candidates: basePool,
    days: fullParams.days,
    homeBase: fullParams.homeBase,
    zoneOverrides: fullParams.zoneOverrides,
    lockedByDate,
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
// (never instead of) whatever's still left in the draft for that date.
// commitDay always commits a day's stops as a single unit and clears every
// schedule_draft_stops row for that date (plus drops the date from
// params.days once anything committed), so this draft's OWN commit action
// can never leave both non-empty for the same day. They can still coexist
// if a visit for that date was logged outside this draft entirely (directly,
// or via another draft) while this draft still lists the date as open.
// Read-only here: editing an already-committed visit goes through the
// normal visit-log flow elsewhere in the app (PersonDetail/PlaceDetail), not
// this draft UI. `place_id` can be null (detach-not-delete) — the left join
// and the `place_name` snapshot column both exist specifically to survive
// that.
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
      // v.outcome is gone — outcome is per-ENCOUNTER as of
      // 20260806000000_split_visit_encounters.js, and this list ("Planned",
      // in RoutePlanner.jsx) never rendered it. Dropped rather than re-joined:
      // a trip has zero-or-many outcomes now, so there's no honest single
      // value to put here, and nothing was reading it.
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
// Which of `placeIds` already has a completed visit dated exactly `today` —
// by ANYONE, not just this draft's owner (an ad-hoc visit logged by another
// rep counts too). Surfaced as `alreadyVisitedToday` on a draft stop
// (see loadDraftView/loadDraftDayView below) so a place that got a real
// visit today doesn't just silently keep sitting in a future day's proposal
// with no indication — the draft's own persisted stops are never
// re-validated against eligibility on read (only new candidate selection
// is), so this is a deliberately narrow, targeted flag rather than a fix to
// that broader gap. Informational only: still fully addable/removable/
// committable, same "warn, don't block" spirit as the visits.js collision
// check on ad-hoc creation.
async function alreadyVisitedTodayPlaceIds(db, placeIds, today) {
  if (!placeIds.length) return new Set();
  const rows = await db('visits')
    .where({ status: 'completed', scheduled_date: today })
    .whereIn('place_id', placeIds)
    .select('place_id');
  return new Set(rows.map((r) => r.place_id));
}

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

  // stopRows is 's.* (minus id) + p.*' — the place's own PK comes through as
  // plain `id` (same reason toDraftStopShape below reads `row.id`, not a
  // `place_id` that was never selected).
  const todaySet = await alreadyVisitedTodayPlaceIds(db, stopRows.map((r) => r.id), orgToday());

  const days = [];
  for (const date of dates) {
    const rows = byDate[date] || [];
    const stops = rows.map(toDraftStopShape).map((s) => ({ ...s, alreadyVisitedToday: todaySet.has(s.place_id) }));
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

  const todaySet = await alreadyVisitedTodayPlaceIds(db, rows.map((r) => r.id), orgToday());
  const stops = rows.map(toDraftStopShape).map((s) => ({ ...s, alreadyVisitedToday: todaySet.has(s.place_id) }));
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
  await knex.transaction(async (trx) => {
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

    // Same never-visited-defaults-to-pre_qualification rule as auto-generated
    // stops (see scheduleGenerator.js's toPackableStop) — only applied when
    // the caller didn't explicitly pick a type, so a deliberate choice from
    // the "add a stop" UI is never second-guessed.
    let resolvedVisitType = visitType || null;
    if (!resolvedVisitType) {
      const everVisited = await trx('visits').where({ place_id: placeId, status: 'completed' }).first();
      if (!everVisited) resolvedVisitType = 'pre_qualification';
    }

    // Guards against the two-request race the pre-check above (own.has(placeId))
    // can't fully close: two near-simultaneous addStop calls for the same
    // place can both pass that SELECT before either INSERT lands. The real
    // backstop is the DB-level unique(['draft_id', 'place_id']) constraint
    // (see the migration that creates schedule_draft_stops) — catch its
    // violation here and surface the same clean 409 the pre-check throws,
    // rather than letting a raw constraint error fall through as a 500. Same
    // pattern as commitDay's per-row insert loop below.
    try {
      await trx('schedule_draft_stops').insert({ draft_id: draftId, date, place_id: placeId, visit_type: resolvedVisitType, sort_order: nextSortOrder });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dupErr = new Error('That place is already in this draft');
        dupErr.status = 409;
        throw dupErr;
      }
      throw err;
    }
  });

  return loadDraftDayView(knex, draftId, date);
}

async function removeStop({ draftId, userId, date, placeId }) {
  await knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeId }).del();
  });
  return loadDraftDayView(knex, draftId, date);
}

// Discards just one day's still-open proposal, as if that date had never
// been picked at generate time: its stops are deleted AND the date itself is
// dropped from params.days, so it stops being a day this draft has an
// opinion about at all (unlike every other per-day mutation here, which
// keeps every date in params.days fixed — see loadDraftView). The rest of
// the draft (its other days) is untouched, and so is anything already
// committed for THIS day (any visits already logged for that date live in
// `visits`, not `schedule_draft_stops`, so this can never touch them —
// though in practice a fully-committed date is dropped from params.days by
// commitDay and can't be re-picked per validateDays, so this mostly guards
// against a visit logged outside this draft's own commit flow). If
// this was the last remaining date, the whole draft is deleted rather than
// left behind as an empty, dateless husk — returns null in that case (same
// "no active draft" shape getActiveDraft/loadDraftView return), otherwise
// the full recalculated draft view (there's no single "day view" to hand
// back once the day itself no longer exists).
async function discardDay({ draftId, userId, date }) {
  const draftDeleted = await knex.transaction(async (trx) => {
    const draft = await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date }).del();

    const params = JSON.parse(draft.params_json);
    const remainingDays = params.days.filter((d) => d.date !== date);

    if (remainingDays.length === 0) {
      await deleteDraft(trx, draftId);
      return true;
    }

    await trx('schedule_drafts').where({ id: draftId }).update({ params_json: JSON.stringify({ ...params, days: remainingDays }) });
    return false;
  });

  if (draftDeleted) return null;
  return loadDraftView(knex, draftId);
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
  await knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    for (let i = 0; i < placeIds.length; i++) {
      await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeIds[i] }).update({ sort_order: i });
    }
  });
  return loadDraftDayView(knex, draftId, date);
}

async function setVisitType({ draftId, userId, date, placeId, visitType }) {
  await knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: placeId }).update({ visit_type: visitType || null });
  });
  return loadDraftDayView(knex, draftId, date);
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
  // Ownership-checked up front, outside any transaction — a plain read, same
  // as generateAndPersistDraft's pre-transaction section. This is what lets
  // the OSRM /trip call below (optimizeRoute) happen without holding a DB
  // transaction open across it.
  await assertOwnsDraft(knex, draftId, userId);

  const draft = await knex('schedule_drafts').where({ id: draftId }).first();
  const params = JSON.parse(draft.params_json);

  const rows = await knex('schedule_draft_stops as s')
    .join('places as p', 'p.id', 's.place_id')
    .where({ 's.draft_id': draftId, 's.date': date })
    .orderBy('s.sort_order')
    .select('s.id as stop_id', 's.visit_type', 'p.*');

  const stops = rows.map(toDraftStopShape);
  const routable = stops.filter(isGeocoded);
  const unroutable = stops.filter((s) => !isGeocoded(s));

  if (routable.length < 2) return loadDraftDayView(knex, draftId, date); // nothing worth reordering

  const result = await optimizeRoute({ start: params.homeBase, stops: routable });
  if (!result) return loadDraftDayView(knex, draftId, date); // OSRM unreachable — order stays as-is

  const newOrder = [...result.orderedStops, ...unroutable];

  // Re-check ownership inside the write transaction: time has passed since
  // the check above (an OSRM round-trip), and the write's correctness
  // depends on being atomic with an ownership check made right before it —
  // same reasoning as every other mutation in this file.
  await knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    for (let i = 0; i < newOrder.length; i++) {
      await trx('schedule_draft_stops').where({ draft_id: draftId, date, place_id: newOrder[i].place_id }).update({ sort_order: i });
    }
  });

  return loadDraftDayView(knex, draftId, date);
}

// Ranked, eligible candidates for one day of a draft — shared by
// getDayZones (read-only) and selectDayZone (mutating) so both agree on
// exactly which zones are on offer for a given day. Deliberately date-scoped
// (excludes only OTHER dates' placements), NOT ownDraftPlaceIds(knex,
// draftId) unscoped: this day's OWN current stops must stay in the ranked
// pool, or (a) a commitment sitting among them would be invisible to
// outOfZoneCommitments, and (b) the day's own current zone could vanish from
// the list entirely if nothing else unplaced happens to sit in it — exactly
// the "the dropdown doesn't even list what's already selected" bug that'd
// produce. Only OTHER dates' placements need excluding here, to avoid
// re-ranking a place this draft already committed to on a different day
// (which schedule_draft_stops' unique(['draft_id', 'place_id']) would reject
// at insert time anyway, but better to never rank it as a candidate here).
async function rankedCandidatesForDay(db, { draftId, date, userId }) {
  const basePool = await buildCandidatePool(db, { today: date });
  const ownElsewhere = await db('schedule_draft_stops')
    .where({ draft_id: draftId })
    .whereNot('date', date)
    .select('place_id');
  const own = new Set(ownElsewhere.map((r) => r.place_id));
  const locked = await lockedElsewherePlaceIds(db, { date, userId });
  const excluded = new Set([...own, ...locked]);
  const candidates = basePool
    .filter((c) => !excluded.has(c.place.id))
    .map((c) => ({ ...c, lockedElsewhere: false })); // already excluded above

  return rankCandidates(candidates, { today: date, config: defaultSchedulingConfig });
}

// The zones (regions) a day's dropdown can offer — every region this day's
// own ranked-and-eligible candidates span (scheduleGenerator.orderedZones),
// always including whatever zone the day is currently in (see
// rankedCandidatesForDay). Read-only: no fill, no OSRM call, no write.
async function getDayZones({ draftId, userId, date }) {
  await assertOwnsDraft(knex, draftId, userId);

  const draft = await knex('schedule_drafts').where({ id: draftId }).first();
  const params = JSON.parse(draft.params_json);
  if (!params.days.some((d) => d.date === date)) {
    const err = new Error('That date is not part of this draft');
    err.status = 400;
    throw err;
  }

  const ranked = await rankedCandidatesForDay(knex, { draftId, date, userId });
  return { list: orderedZones(ranked) };
}

// "Somewhere else": the user directly picks which zone (region) a day
// covers from the dropdown (see getDayZones for the options list) instead
// of always taking the top-ranked one, then this re-fills the day from
// scratch in that zone. Ownership-checked and the candidate pool built
// PRE-transaction, same reasoning as reoptimizeDay: fillDayFromZone can make
// a real OSRM call, and a SQLite transaction held open across that would
// lock writes for everyone else for the duration.
async function selectDayZone({ draftId, userId, date, zone }) {
  await assertOwnsDraft(knex, draftId, userId);

  const draft = await knex('schedule_drafts').where({ id: draftId }).first();
  const params = JSON.parse(draft.params_json);
  const dayParams = params.days.find((d) => d.date === date);
  if (!dayParams) {
    const err = new Error('That date is not part of this draft');
    err.status = 400;
    throw err;
  }
  const budgetMinutes = dayParams.hoursPerDay * 60;

  const ranked = await rankedCandidatesForDay(knex, { draftId, date, userId });

  const zones = orderedZones(ranked);
  if (zones.length === 0) {
    const err = new Error('No eligible places to plan a zone for this date');
    err.status = 400;
    throw err;
  }
  if (!zones.includes(zone)) {
    // The dropdown's list can go stale (candidate pool shifted since it was
    // fetched) — surface that plainly rather than silently falling back to
    // some other zone the user didn't ask for.
    const err = new Error('That area is no longer available for this day — refresh and try again');
    err.status = 400;
    throw err;
  }

  const fillResult = await fillDayFromZone({
    candidates: ranked,
    zone,
    homeBase: params.homeBase,
    budgetMinutes,
    driveConfig: defaultDriveConfig,
    visitTypesConfig: defaultVisitTypesConfig,
    optimizeRoute,
    routeOptimizerConfig: defaultRouteOptimizerConfig,
  });

  // Union, not merge-with-dedupe: outOfZoneCommitments only ever looks
  // OUTSIDE the selected zone, fillResult.droppedCommitments only ever looks
  // INSIDE it — disjoint by construction (see scheduleGenerator.js's
  // comments on both).
  const droppedCommitments = [...outOfZoneCommitments(ranked, zone), ...fillResult.droppedCommitments];

  // Re-check ownership inside the write transaction: time has passed since
  // the checks above (candidate pool build + an OSRM round-trip), same
  // discipline as every other mutation in this file.
  await knex.transaction(async (trx) => {
    await assertOwnsDraft(trx, draftId, userId);
    await trx('schedule_draft_stops').where({ draft_id: draftId, date }).del();

    const rows = fillResult.stops.map((stop, i) => ({
      draft_id: draftId,
      date,
      place_id: stop.place_id,
      visit_type: stop.visitType || null,
      sort_order: i,
    }));
    if (rows.length > 0) await trx('schedule_draft_stops').insert(rows);

    // Re-read params fresh inside the transaction — it could have changed
    // since the pre-transaction read above.
    const freshDraft = await trx('schedule_drafts').where({ id: draftId }).first();
    const freshParams = JSON.parse(freshDraft.params_json);
    const updatedParams = { ...freshParams, zoneOverrides: { ...freshParams.zoneOverrides, [date]: zone } };
    await trx('schedule_drafts').where({ id: draftId }).update({ params_json: JSON.stringify(updatedParams) });
  });

  const dayView = await loadDraftDayView(knex, draftId, date);
  return { ...dayView, droppedCommitments };
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

    // Once at least one stop from this date actually became a real visit,
    // the date is done as far as this draft is concerned — drop it from
    // params.days so the draft stops claiming it's still an open proposal
    // (the ambiguous "committed AND still in the active draft" state this
    // whole reopen feature exists to eliminate). Skipped entirely if nothing
    // committed (every stop collided) — an all-collision day is still a live
    // proposal, not a done one. Deliberately does NOT delete the draft row
    // even if this empties params.days out completely: commitAll calls this
    // in a loop across multiple dates against one draftId captured up front,
    // and deleting the row mid-loop would break a later iteration's
    // assertOwnsDraft. An empty-but-present draft is already cleaned up by
    // RoutePlanner.jsx's own load() on its next read (see openDays().length
    // === 0 handling there) — no further action needed here.
    if (committedRows.length > 0) {
      const draftRow = await trx('schedule_drafts').where({ id: draftId }).first();
      const draftParams = JSON.parse(draftRow.params_json);
      const remainingDays = draftParams.days.filter((d) => d.date !== date);
      if (remainingDays.length !== draftParams.days.length) {
        await trx('schedule_drafts').where({ id: draftId }).update({ params_json: JSON.stringify({ ...draftParams, days: remainingDays }) });
      }
    }

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

// Reopens a whole day's ALREADY-COMMITTED visits back into the same
// draft-editing surface used before commit (schedule_draft_stops): pulls
// those `visits` rows back out, deletes them, and hands the day to whichever
// draft the user's currently working from — creating one (sourced from the
// passed-in `homeBase`) if they don't have one yet, or reusing an existing
// draft's own homeBase otherwise (a draft's homeBase is single-sourced from
// whenever it was created/last generated — a later per-day reopen shouldn't
// silently override it). Scoped to source: 'planner' only, same reasoning as
// commitDay's own source tagging — an ad-hoc "Log a visit" entry
// (source: 'manual') was never part of a plan and must never get swept into
// one just because it shares a date with a planner-committed day. Once the
// rows are back in schedule_draft_stops, every existing draft-editing
// endpoint (reorder/add/remove/visit-type/reoptimize/commit) works on this
// day exactly as if it had never been committed — "Accept proposal" simply
// re-commits it through the normal commitDay path.
//
// DB work stays inside a short transaction; loadDraftView (which can trigger
// a real OSRM call via evaluateDay) runs after it resolves — same
// no-network-call-inside-a-transaction convention as every other mutation in
// this file.
async function reopenCommittedDay({ userId, date, homeBase }) {
  const draftId = await knex.transaction(async (trx) => {
    const rows = await trx('visits')
      .where({ user_id: userId, scheduled_date: date, status: 'planned', source: 'planner' })
      .orderBy('sort_order')
      .select('id', 'place_id', 'visit_type', 'sort_order');

    if (rows.length === 0) {
      const err = new Error('Nothing committed for this date to edit');
      err.status = 404;
      throw err;
    }

    const existing = await getActiveDraft(trx, userId);
    let id;
    let params;
    if (existing) {
      id = existing.id;
      params = JSON.parse(existing.params_json);
    } else {
      if (!homeBase || homeBase.lat == null || homeBase.lng == null) {
        const err = new Error('homeBase is required to start editing this day');
        err.status = 400;
        throw err;
      }
      params = { days: [], homeBase, zoneOverrides: {} };
      id = await createDraft(trx, { userId, params });
    }

    if (!params.days.some((d) => d.date === date)) {
      params.days.push({ date, hoursPerDay: DEFAULT_HOURS_PER_DAY });
      params.days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      await trx('schedule_drafts').where({ id }).update({ params_json: JSON.stringify(params) });
    }

    const stopRows = rows.map((r, i) => ({
      draft_id: id,
      date,
      place_id: r.place_id,
      visit_type: r.visit_type,
      sort_order: r.sort_order ?? i,
    }));

    // One of these places can already sit on some OTHER day of this same
    // draft (e.g. a normal-cadence revisit already proposed for later this
    // week, generated before this earlier day was reopened) —
    // schedule_draft_stops' unique(draft_id, place_id) forbids the same
    // place appearing twice in one draft at all, so the plain insert below
    // would throw a raw constraint violation. What actually happened on the
    // day being reopened is real, already-committed history; it should win
    // over a not-yet-committed proposal for the same place elsewhere in the
    // draft (same "hard commitments jump the queue" precedent the ranking
    // engine itself uses — see urgency.js), so evict any such placement
    // first rather than let the insert crash on it.
    await trx('schedule_draft_stops')
      .where({ draft_id: id })
      .whereIn('place_id', rows.map((r) => r.place_id))
      .del();

    await trx('schedule_draft_stops').insert(stopRows);

    await trx('visits').whereIn('id', rows.map((r) => r.id)).del();

    return id;
  });

  return loadDraftView(knex, draftId);
}

module.exports = {
  MAX_PLAN_DATES,
  MAX_DAYS_AHEAD,
  validateDays,
  mergeLockedElsewhereIds,
  partitionCommittableStops,
  buildCandidatePool,
  lockedElsewherePlaceIds,
  lockedElsewherePlaceIdsByDate,
  committedElsewherePlaceIds,
  committedDatesForUser,
  committedDateSummaries,
  committedDayVisits,
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
  getDayZones,
  selectDayZone,
  getSuggestions,
  commitDay,
  commitAll,
  deleteCommittedDay,
  reopenCommittedDay,
};
