// Visits — one planned/completed/skipped TRIP to a place, by a rep, on a
// date, plus the encounters recorded on it. This covers logging a trip and its
// outcomes/notes, correcting one afterwards, removing a single encounter from
// it, and deleting it outright. (Creating a whole day's worth at once happens
// via the route planner's commit flow — see services/scheduleDraft.js — not here.)
const express = require('express');
const knex = require('../db/knex');
const { VISIT_TYPES } = require('../config/visitTypes');
const { attachEncounters } = require('../services/visitEncounters');
const { crossRepVisitsByPlace, findCrossRepFloorWarning, attachCrossRepFloorWarnings } = require('../services/crossRepFloorWarning');
const { detectConflicts } = require('../services/conflictDetection');
const schedulingConfig = require('../config/scheduling');

const router = express.Router();

// Outcomes are now the six observable events the relationship model scores
// against (see services/relationship.js's OUTCOME_WEIGHT). This REPLACED the
// original set (interested/not_ready/follow_up/no_answer/left_materials)
// outright rather than running both: the old values were evaluative ("how did
// it feel") where these are observational ("what happened"), so there's no
// honest 1:1 mapping, and a two-enum period would mean every consumer
// carrying both maps forever.
//
// Existing rows keep their old string. relationship.js scores an unrecognized
// outcome at a documented floor rather than throwing, so old visits degrade
// quietly instead of breaking anything. All current visit data is test data;
// the real old->new backfill is Bede's to write when historical data actually
// gets imported (tracked in HANDOFF.md).
const OUTCOMES = ['substantive', 'introduced_new', 'brief', 'materials_only', 'unavailable', 'declined'];
const STATUSES = ['planned', 'completed', 'skipped'];

// WHO the rep actually spoke to — the single biggest input to relationship
// scoring, since only 'named_person' can build an individual's score.
const MET_WITH_TYPES = ['named_person', 'staff', 'receptionist', 'nobody'];

// A `visits` row is the TRIP; each person/category met on it is one
// `visit_encounters` row (see migration 20260806000000_split_visit_encounters.js).
// A trip where the rep met a named contact AND got gatekept by the front desk
// is one visit with two encounters.
//
// This is what makes the relationship model reachable from the form: the
// named-contact encounter scores toward THAT PERSON's relationship, while the
// receptionist encounter scores (much lower) toward the place's floor — see
// services/relationship.js's creditsPerson/visitWeight. Recording a trip as a
// single who/what pair would force the rep to pick one and silently discard
// the other.
//
// The fan-out happens HERE rather than as N calls from the browser for two
// reasons: the collision check below must run ONCE for the trip (N separate
// POSTs would have calls 2..N colliding with call 1 and falsely warning "you
// already have a visit here"), and all-or-nothing insertion needs one
// transaction. Fatigue counting already treats these as a single trip — see
// buildCandidatePool's distinct-day counting in services/scheduleDraft.js.
const MAX_ENCOUNTERS_PER_VISIT = 20; // sanity guard, not a real-world limit

// Per-encounter fields a client may set. Everything else on the request body
// is trip-level (EDITABLE below) or ignored.
const ENCOUNTER_FIELDS = ['met_with_type', 'person_id', 'outcome', 'they_requested'];

// Columns GET /:id returns per encounter — the full editable set, since that
// route is what VisitDetailModal opens an existing trip with. List views get
// the much shorter summary instead (services/visitEncounters.js).
const ENCOUNTER_DETAIL_COLUMNS = [
  'id',
  'person_id',
  'person_name',
  'person_title',
  'person_email',
  'person_phone',
  'met_with_type',
  'outcome',
  'they_requested',
];

// Snapshot fields are read from the people table per person rather than
// trusted from the request body: with several people in play the client would
// have to send a parallel array of contact details, and any mismatch would
// silently mis-attribute one person's phone/email onto another's encounter.
function snapshotFromPerson(person) {
  return {
    person_id: person.id,
    person_name: person.name || null,
    person_title: person.title || null,
    person_email: person.email || null,
    person_phone: person.phone || null,
  };
}

// Captures the "avg. referrals/month discovered at pre-qual" number that
// VisitLogModal offers on any completed visit to a place that hasn't been
// pre-qualified yet. Sent as a transient `capacity_monthly_referrals` body
// field (not a `visits` column — EDITABLE below intentionally excludes it);
// writes through to `places.capacity_monthly_referrals` and flips
// `capacity_status` to 'verified' — the same fields routes/places.js's PATCH
// lets a rep correct directly afterward (landing as 'adjusted' instead, see
// its own comment). Silently no-ops on bad/irrelevant input, same "extra field
// ignored" convention as the EDITABLE loops below — this is a best-effort
// convenience, not a required part of logging a visit.
async function maybeCapturePreQualification({ placeId, capacityMonthlyReferrals }) {
  if (capacityMonthlyReferrals === undefined || capacityMonthlyReferrals === null || capacityMonthlyReferrals === '') return;
  const n = Number(capacityMonthlyReferrals);
  if (!Number.isInteger(n) || n < 0) return;

  // Gate is capacity_status, NOT "is this the first visit." The old
  // first-visit-only rule had a trapdoor: miss the number on visit one and
  // the place was never asked again, so it sat on an estimated capacity
  // forever — permanently stuck in the ranker's exploration tier. Keying off
  // 'estimated' means the prompt keeps coming back until a real number is
  // actually captured, and stops the moment one is.
  //
  // Still re-read server-side rather than trusting the client's view of the
  // place: 'estimated' is the only state this may write over, so a second
  // capture can never clobber a verified/adjusted number.
  const place = await knex('places').where({ id: placeId }).first();
  if (!place || place.capacity_status !== 'estimated') return;

  await knex('places').where({ id: placeId }).update({ capacity_monthly_referrals: n, capacity_status: 'verified' });
}

// Trip-level fields a client is allowed to set when logging/updating a visit.
// Anything not in this list in the request body is silently ignored (not
// saved). visit_type is otherwise only ever set once, at route-planner commit
// time (scheduleDraft.js) — included here so it can be corrected after the
// fact too, same as notes/date/etc.
//
// outcome/met_with_type/they_requested/person_* are deliberately absent: they
// are per-ENCOUNTER facts now, and arrive in the `encounters` array instead.
// Leaving them here would let a client "save" an outcome that has nowhere to
// land and no visible symptom.
const EDITABLE = [
  'user_id',
  'scheduled_date',
  'status',
  'notes',
  'next_visit_date',
  'sort_order',
  'visit_type',
  // Relationship-model capture (see services/relationship.js).
  // actual_duration_minutes is captured but deliberately unread by that model
  // — it's here to start collecting real data against which
  // config/visitTypes.js's hardcoded per-type minutes can later be calibrated.
  'actual_duration_minutes',
];

// Validates the trip-level enum fields shared by POST and PATCH. Returns an
// error string for the client, or null.
function tripFieldError(payload) {
  if (payload.status && !STATUSES.includes(payload.status)) {
    return `status must be one of ${STATUSES.join(', ')}`;
  }
  if (payload.visit_type && !VISIT_TYPES[payload.visit_type]) {
    return `visit_type must be one of ${Object.keys(VISIT_TYPES).join(', ')}`;
  }
  return null;
}

// Validates and normalizes a request's `encounters` array into rows ready to
// write, resolving each named person's contact snapshot server-side. Returns
// { error } or { encounters } — fully checked BEFORE any insert, so one bad
// entry can't leave a half-written trip behind.
//
// `existingIds` (PATCH only) is the set of encounter ids already on this
// visit. Its presence is what turns an entry's `id` into "update this one";
// on POST there is nothing to update, so an id there is meaningless and
// ignored, same "extra field ignored" convention as EDITABLE.
async function normalizeEncounters(raw, { existingIds } = {}) {
  if (!Array.isArray(raw)) return { error: 'encounters must be an array' };
  if (raw.length > MAX_ENCOUNTERS_PER_VISIT) {
    return { error: `A single visit can record at most ${MAX_ENCOUNTERS_PER_VISIT} encounters` };
  }

  const seenPersonIds = new Set();
  const seenEncounterIds = new Set();
  const built = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return { error: 'each encounter must be an object' };
    const e = {};
    for (const f of ENCOUNTER_FIELDS) if (entry[f] !== undefined) e[f] = entry[f];

    if (existingIds && entry.id !== undefined && entry.id !== null && entry.id !== '') {
      const encounterId = Number(entry.id);
      // Checked against THIS visit's own ids, not just "does it exist" — an
      // id from another trip would otherwise let one visit's save rewrite
      // another visit's encounter.
      if (!Number.isInteger(encounterId) || !existingIds.has(encounterId)) {
        return { error: 'encounter not found on this visit' };
      }
      if (seenEncounterIds.has(encounterId)) {
        return { error: 'the same encounter cannot appear twice in one update' };
      }
      seenEncounterIds.add(encounterId);
      e.id = encounterId;
    }

    if (!MET_WITH_TYPES.includes(e.met_with_type)) {
      return { error: `met_with_type must be one of ${MET_WITH_TYPES.join(', ')}` };
    }
    if (!OUTCOMES.includes(e.outcome)) {
      return { error: `outcome must be one of ${OUTCOMES.join(', ')}` };
    }
    e.they_requested = Boolean(e.they_requested);

    if (e.met_with_type === 'named_person') {
      const personId = Number(e.person_id);
      if (!Number.isInteger(personId)) return { error: 'person not found' };
      // The same person twice in one trip would double-count their
      // relationship score for a single conversation — and would violate
      // visit_encounters_unique_person besides.
      if (seenPersonIds.has(personId)) {
        return { error: 'the same person cannot be recorded twice on one visit' };
      }
      seenPersonIds.add(personId);
      e.person_id = personId;
    } else {
      // Only a named_person encounter may carry a person — anything else is
      // by definition "we didn't meet anyone identifiable," and a stray
      // person_id here would wrongly credit them. The snapshot columns go
      // with it: they describe that person, not the category.
      e.person_id = null;
      e.person_name = null;
      e.person_title = null;
      e.person_email = null;
      e.person_phone = null;
    }
    built.push(e);
  }

  // One query for every named person, rather than one per encounter.
  if (seenPersonIds.size) {
    const rows = await knex('people').whereIn('id', [...seenPersonIds]);
    if (rows.length !== seenPersonIds.size) return { error: 'person not found' };
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const e of built) {
      if (e.person_id != null) Object.assign(e, snapshotFromPerson(byId.get(e.person_id)));
    }
  }

  return { encounters: built };
}

// Validates user_id when a request is actually setting it. Nullable FK (a
// visit doesn't have to be assigned to a rep), so only checked when provided —
// same "look it up, 400 if missing" pattern people.js uses for place_id.
// Mutates `payload` with the coerced number. Returns an error string or null.
async function coerceUserId(payload) {
  if (payload.user_id === undefined || payload.user_id === null || payload.user_id === '') return null;
  const numericUserId = Number(payload.user_id);
  if (Number.isNaN(numericUserId)) return 'user not found';
  const user = await knex('users').where({ id: numericUserId }).first();
  if (!user) return 'user not found';
  payload.user_id = numericUserId;
  return null;
}

// Re-fetches a whole trip: its own fields, its place's basic info, the rep's
// name, and every encounter on it. This is what the client opens a visit with
// (GET /:id) and what a create/update responds with, so the frontend never
// needs a second request.
// Left joins, not inner — a visit's place or rep can be gone (deleted) while
// the visit itself survives; v.place_name is the durable snapshot that still
// identifies the place either way, so it isn't overridden by the (possibly
// absent) live join.
async function fetchVisit(id) {
  const visit = await knex('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .where('v.id', id)
    .select('v.*', 'p.city as place_city', 'p.zip as place_zip', 'u.name as user_name')
    .first();
  if (!visit) return visit;
  const [withEncounters] = await attachEncounters(knex, [visit], { columns: ENCOUNTER_DETAIL_COLUMNS });

  // Cross-rep hard-floor warning (informational only — see
  // crossRepFloorWarning.js). No place, no floor to check against.
  if (withEncounters.place_id) {
    const byPlace = await crossRepVisitsByPlace(knex, [withEncounters.place_id]);
    withEncounters.crossRepFloorWarning = findCrossRepFloorWarning(withEncounters, byPlace.get(withEncounters.place_id) || [], schedulingConfig);
  } else {
    withEncounters.crossRepFloorWarning = null;
  }
  return withEncounters;
}

// "2026-07" -> { start: "2026-07-01", end: "2026-07-31" }. Used by the
// calendar route below to turn a month picker value into a whereBetween range
// against scheduled_date (a plain 'YYYY-MM-DD' string column, so plain string
// bounds are enough — no date-library parsing needed).
function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number); // m is 1-based (7 = July)
  const lastDay = new Date(y, m, 0).getDate(); // new Date(2026, 7, 0) = July 31
  const mm = String(m).padStart(2, '0');
  return {
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

// GET /api/visits/calendar?month=YYYY-MM[&userId=<int>] — every visit
// scheduled in the given month, flat (not grouped by day — the frontend buckets
// by scheduled_date itself). Omitting userId returns all reps' visits ("All
// reps" mode); scoping is by the query param, not the caller's own identity.
router.get('/calendar', async (req, res, next) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month is required, in YYYY-MM format' });
    }
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const { start, end } = monthRange(month);

    // One row per TRIP — a three-person visit is one square on the calendar,
    // not three.
    //
    // Left joins, not inner — same detach-not-delete precedent as fetchVisit()
    // above and dashboard.js: a visit survives its place or rep being removed.
    // v.place_name is the durable place-name snapshot (always present); the
    // rest of the place_* fields and user_name are honestly null if detached.
    // Column list (and the `u.name as user_name` alias) deliberately mirrors
    // places.js/people.js's own visit-history queries (`v.*` + user_name) —
    // this feeds the same VisitDetailModal/UpcomingVisitDetailModal those do,
    // and a differently-named or narrower select here previously meant a
    // visit opened from the Calendar tab silently showed less than the exact
    // same row opened from PlaceDetail/PersonDetail.
    const rows = await knex('visits as v')
      .leftJoin('places as p', 'p.id', 'v.place_id')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      .whereBetween('v.scheduled_date', [start, end])
      .modify((qb) => userId && qb.andWhere('v.user_id', userId))
      .orderBy('v.scheduled_date', 'asc')
      .orderBy('v.sort_order', 'asc')
      .select(
        'v.id',
        'v.place_id',
        'v.place_name',
        'p.category',
        'p.tier',
        'p.address',
        'p.city',
        'p.zip',
        'v.user_id',
        'u.name as user_name',
        'v.scheduled_date',
        'v.status',
        'v.notes',
        'v.visit_type',
        'v.source',
        'v.next_visit_date'
      );

    // One extra query for the whole month, grouped in JS — never one per row.
    const withEncounters = await attachEncounters(knex, rows);

    // Cross-rep hard-floor warning (informational only — see
    // crossRepFloorWarning.js). Batched once across every distinct place in
    // the month, not once per row — VisitsCalendar.jsx passes these rows
    // straight into VisitDetailModal/CompletedVisitsModal with no refetch,
    // so this is required for the tag to reach the Calendar tab at all.
    const crossRepByPlace = await crossRepVisitsByPlace(knex, withEncounters.map((r) => r.place_id));
    res.json(attachCrossRepFloorWarnings(withEncounters, crossRepByPlace, schedulingConfig));
  } catch (err) {
    next(err);
  }
});

// GET /api/visits/:id — one whole trip, encounters included. The single call
// VisitDetailModal opens a visit with. Registered after /calendar so Express
// doesn't match "calendar" as an :id.
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await fetchVisit(id);
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    res.json(visit);
  } catch (err) {
    next(err);
  }
});

// POST /api/visits — create an ad-hoc visit (outside the generated schedule),
// e.g. from the "Log a visit" button on a Place Detail page.
router.post('/', async (req, res, next) => {
  try {
    const { place_id } = req.body;
    if (!place_id) return res.status(400).json({ error: 'place_id is required' });
    const numericPlaceId = Number(place_id);
    if (Number.isNaN(numericPlaceId)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id: numericPlaceId }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    // place_name is a one-time snapshot taken here, at logging time — a
    // visit's place_id is never changed after creation, so this never needs
    // re-deriving later, even if the place is later renamed or deleted.
    const payload = { place_id: numericPlaceId, place_name: place.name };
    for (const f of EDITABLE) if (req.body[f] !== undefined) payload[f] = req.body[f];

    const fieldError = tripFieldError(payload);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const userError = await coerceUserId(payload);
    if (userError) return res.status(400).json({ error: userError });

    let encounters = [];
    if (req.body.encounters !== undefined) {
      const result = await normalizeEncounters(req.body.encounters);
      if (result.error) return res.status(400).json({ error: result.error });
      encounters = result.encounters;
    }

    // A completed trip that met nobody and no category isn't a coherent
    // record of anything — there'd be nothing to score and nothing to show.
    // 'planned' is exempt on purpose: a scheduled stop that hasn't happened
    // yet has no encounters by definition, and that's its normal state.
    if (payload.status === 'completed' && !encounters.length) {
      return res.status(400).json({ error: 'A completed visit needs at least one encounter' });
    }

    // Ad-hoc creation (this route) now runs through the same detector
    // addStop uses (services/conflictDetection.js) instead of its own
    // narrower exact-date-only check — that used to mean this was the one
    // visit-logging path with no floor protection at all: a rep could log a
    // second visit to the same place two days after their own completed one
    // with zero warning, since the floor only ever applied to the
    // auto-generator. Deliberately does NOT exclude the same rep the way
    // crossRepFloorWarning does elsewhere — a rep's own back-to-back visits
    // are exactly the case this exists to catch.
    //
    // Only SAME_DATE_VISIT actually blocks (409, unchanged — same override
    // pattern as places.js's ADDRESS_UNRECOGNIZED confirm flow: re-send with
    // `force: true` to proceed). FLOOR_COMPLETED/FLOOR_PLANNED/DRAFT_ELSEWHERE
    // are informational findings, not errors — a 409 for those would misrepresent
    // the result to any consumer of this endpoint besides VisitLogModal
    // (there is other integration surface here). Nothing is created yet
    // either, so 201 would be just as wrong a claim — 200 with the findings
    // is the honest response: request succeeded, nothing rejected, nothing
    // written. The client decides whether that's worth a confirmation click
    // before re-sending with `force: true` to actually create it.
    if (payload.place_id && payload.scheduled_date && !req.body.force) {
      const conflicts = await detectConflicts(knex, payload.place_id, payload.scheduled_date, { userId: payload.user_id });
      const sameDateConflict = conflicts.find((c) => c.type === 'SAME_DATE_VISIT');
      if (sameDateConflict) {
        const isSameUser = payload.user_id && sameDateConflict.otherUserId === payload.user_id;
        const who = isSameUser ? 'You' : sameDateConflict.otherUserName || 'Someone else';
        const verb = isSameUser ? 'have' : 'has';
        return res.status(409).json({
          error: `${who} already ${verb} a ${sameDateConflict.status} visit here on this date.`,
          code: 'VISIT_COLLISION',
          conflicts,
        });
      }
      if (conflicts.length > 0) {
        return res.status(200).json({ conflicts });
      }
    }

    // Same rule as PATCH below: a visit created already-completed (e.g. an
    // ad-hoc "log a spontaneous visit" save) gets its completed_at stamped
    // immediately, not left null.
    if (payload.status === 'completed') payload.completed_at = knex.fn.now();

    // One trip row plus its encounters, all-or-nothing: a failure partway
    // through must not leave a trip recorded with half its people on it.
    const id = await knex.transaction(async (trx) => {
      const [inserted] = await trx('visits').insert(payload).returning('id');
      const visitId = knex.extractId(inserted);
      if (encounters.length) {
        await trx('visit_encounters').insert(encounters.map((e) => ({ ...e, visit_id: visitId })));
      }
      return visitId;
    });

    if (payload.status === 'completed') {
      await maybeCapturePreQualification({ placeId: numericPlaceId, capacityMonthlyReferrals: req.body.capacity_monthly_referrals });
    }

    res.status(201).json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visits/:id — log or update a visit (notes, date, status, and the
// people met on it). This is what the "Log Visit" form actually calls when
// saving. A rep can correct any already-logged (completed/skipped) visit,
// including one under a teammate's account — the client confirms that's
// intentional first (see the "logged under a different rep's account" confirm
// before opening VisitLogModal in VisitsCalendar.jsx/PlaceDetail.jsx/
// PersonDetail.jsx), but isn't blocked here. A still-`planned` visit is
// different: that's someone else's not-yet-happened scheduled stop, not
// history to correct, so completing/editing it stays restricted to its own
// owning rep.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    if (visit.status === 'planned' && visit.user_id != null && visit.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit a still-planned visit under your own account' });
    }

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const fieldError = tripFieldError(update);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const userError = await coerceUserId(update);
    if (userError) return res.status(400).json({ error: userError });

    const existing = await knex('visit_encounters').where({ visit_id: id }).select('id');
    const existingIds = new Set(existing.map((e) => e.id));

    // `encounters` is an UPSERT BY ID, not a delete-all-then-reinsert: an
    // entry carrying an `id` updates that encounter in place, one without an
    // id is new, and any existing encounter missing from the array is
    // deleted. WHY it matters that ids survive: the client holds them for its
    // per-encounter delete buttons (DELETE /:id/encounters/:encounterId), so
    // a blanket replace would silently 404 every one of those buttons after
    // any unrelated trip-level save — a note edit would invalidate the
    // encounter list it was displayed next to.
    //
    // Encounter id churn has NO effect on scoring, in either direction:
    // services/relationship.js decays against the TRIP's scheduled_date and
    // never reads visit_encounters.created_at or id (see its ENCOUNTER_SELECT
    // comment). So nothing here needs to preserve encounter timestamps, and
    // nobody should later "fix" them believing the model depends on them.
    let encounters = null;
    if (req.body.encounters !== undefined) {
      const result = await normalizeEncounters(req.body.encounters, { existingIds });
      if (result.error) return res.status(400).json({ error: result.error });
      encounters = result.encounters;
    }

    const finalStatus = update.status ?? visit.status;
    const finalEncounterCount = encounters ? encounters.length : existingIds.size;
    // Same rule as POST: completing a trip means recording who was there.
    if (finalStatus === 'completed' && finalEncounterCount === 0) {
      return res.status(400).json({ error: 'A completed visit needs at least one encounter' });
    }

    // Stamp completion time only the moment a visit *becomes* completed, not
    // on every subsequent edit to an already-completed visit.
    if (update.status === 'completed' && visit.status !== 'completed') {
      update.completed_at = knex.fn.now();
    }

    await knex.transaction(async (trx) => {
      await trx('visits').where({ id }).update(update);
      if (!encounters) return;

      const keptIds = encounters.filter((e) => e.id).map((e) => e.id);
      await trx('visit_encounters')
        .where({ visit_id: id })
        .modify((qb) => keptIds.length && qb.whereNotIn('id', keptIds))
        .del();

      // Clear the person off every row about to be rewritten, first and in
      // one query. visit_encounters_unique_person is enforced per statement,
      // not at commit, so swapping two people between two existing encounters
      // of the same trip would collide halfway through the updates below even
      // though the final state is perfectly valid.
      if (keptIds.length) {
        await trx('visit_encounters').whereIn('id', keptIds).update({ person_id: null });
      }

      const inserts = [];
      for (const e of encounters) {
        const { id: encounterId, ...fields } = e;
        if (encounterId) {
          await trx('visit_encounters').where({ id: encounterId }).update({ ...fields, updated_at: trx.fn.now() });
        } else {
          inserts.push({ ...fields, visit_id: id });
        }
      }
      if (inserts.length) await trx('visit_encounters').insert(inserts);
    });

    if (finalStatus === 'completed') {
      await maybeCapturePreQualification({ placeId: visit.place_id, capacityMonthlyReferrals: req.body.capacity_monthly_referrals });
    }

    res.json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visits/:id/encounters/:encounterId — remove ONE person/category
// from a trip, leaving the trip itself (and everyone else on it) alone.
//
// Removing the last encounter of a COMPLETED trip deletes the trip too: a
// completed visit with nobody on it is the same incoherent record POST/PATCH
// refuse to create, and leaving one behind would put it in a state the edit
// form itself can't save. Scoped to completed on purpose — an empty encounter
// set is the normal state of a still-planned stop, so deleting one there would
// silently wipe a scheduled visit off the route.
router.delete('/:id/encounters/:encounterId', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const encounterId = Number(req.params.encounterId);
    if (Number.isNaN(id) || Number.isNaN(encounterId)) return res.status(404).json({ error: 'Encounter not found' });

    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    // Same ownership rule as PATCH /:id, not DELETE /:id below: removing one
    // encounter is an edit to the trip (a rep correcting what a teammate
    // logged, e.g. "that outcome was wrong" or "I wasn't actually there"),
    // not the destructive act of deleting the visit outright. A still-planned
    // stop is different — that's someone else's not-yet-happened scheduled
    // visit, not history to correct — so it stays restricted to its own rep.
    if (visit.status === 'planned' && visit.user_id != null && visit.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit a still-planned visit under your own account' });
    }

    const encounter = await knex('visit_encounters').where({ id: encounterId, visit_id: id }).first();
    if (!encounter) return res.status(404).json({ error: 'Encounter not found' });

    const deletedVisit = await knex.transaction(async (trx) => {
      await trx('visit_encounters').where({ id: encounterId }).del();
      const remaining = await trx('visit_encounters').where({ visit_id: id }).first();
      if (remaining || visit.status !== 'completed') return false;
      await trx('visits').where({ id }).del();
      return true;
    });

    // The client needs to know whether it should close the visit entirely or
    // just drop a row from the list it's showing.
    res.json({ deleted_visit: deletedVisit });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visits/:id — remove a stop from the schedule entirely (not the
// same as skipping — this deletes the row, skip just changes its status).
// Its encounters go with it via ON DELETE CASCADE, which is deliberate and
// unlike the detach-not-delete rule everywhere else: an encounter has no
// meaning without the trip it happened on.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    if (visit.user_id != null && visit.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit visits scheduled under your own account' });
    }
    await knex('visits').where({ id }).del();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
