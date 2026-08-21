// Visits - one planned/completed/skipped TRIP to a place, by a rep, on a
// date, plus the encounters recorded on it. This covers logging a trip and its
// outcomes/notes, correcting one afterwards, removing a single encounter from
// it, and deleting it outright. (Creating a whole day's worth at once happens
// via the route planner's commit flow - see services/scheduleDraft.js - not here.)
const express = require('express');
const knex = require('../db/knex');
const { VISIT_TYPES } = require('../config/visitTypes');
const { attachEncounters } = require('../services/visitEncounters');
const { crossRepVisitsByPlace, findCrossRepFloorWarning, attachCrossRepFloorWarnings } = require('../services/crossRepFloorWarning');
const { detectConflicts } = require('../services/conflictDetection');
const { computeCapacityForPlace, stampExplorationEligibility } = require('../services/capacity');
const {
  createCommitment,
  fulfillCommitment,
  getOutstandingCommitments,
  getBindingCommitment,
  attachCommitmentsMade,
} = require('../services/placeCommitments');
const { orgToday } = require('../services/orgDate');
const { skipSweepMiddleware, snoozeSwallowsCommitment } = require('../services/visitLifecycle');
const { createManualVisit, editVisit, canDeleteManualVisit, canEditManualVisit } = require('../services/manualVisits');
const schedulingConfig = require('../config/scheduling');

const router = express.Router();
router.use(skipSweepMiddleware(knex));

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
// 'snoozed' - an explicit rep deferral (POST /:id/snooze below), distinct
// from 'skipped' (a passive lapse, stamped by the skip sweep in
// services/visitLifecycle.js). Both are terminal, neither writes
// lastVisitedAt/urgency the way 'completed' does.
const STATUSES = ['planned', 'completed', 'skipped', 'snoozed'];

// WHO the rep actually spoke to - the single biggest input to relationship
// scoring, since only 'named_person' can build an individual's score.
const MET_WITH_TYPES = ['named_person', 'staff', 'receptionist', 'nobody'];

// A `visits` row is the TRIP; each person/category met on it is one
// `visit_encounters` row (see migration 20260806000000_split_visit_encounters.js).
// A trip where the rep met a named contact AND got gatekept by the front desk
// is one visit with two encounters.
//
// This is what makes the relationship model reachable from the form: the
// named-contact encounter scores toward THAT PERSON's relationship, while the
// receptionist encounter scores (much lower) toward the place's floor - see
// services/relationship.js's creditsPerson/visitWeight. Recording a trip as a
// single who/what pair would force the rep to pick one and silently discard
// the other.
//
// The fan-out happens HERE rather than as N calls from the browser for two
// reasons: the collision check below must run ONCE for the trip (N separate
// POSTs would have calls 2..N colliding with call 1 and falsely warning "you
// already have a visit here"), and all-or-nothing insertion needs one
// transaction. Fatigue counting already treats these as a single trip - see
// buildCandidatePool's distinct-day counting in services/scheduleDraft.js.
const MAX_ENCOUNTERS_PER_VISIT = 20; // sanity guard, not a real-world limit

// Per-encounter fields a client may set. Everything else on the request body
// is trip-level (EDITABLE below) or ignored.
const ENCOUNTER_FIELDS = ['met_with_type', 'person_id', 'outcome', 'they_requested'];

// Columns GET /:id returns per encounter - the full editable set, since that
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
// VisitLogModal offers on any completed visit to a place whose declared
// capacity isn't fresh (capacity-computation-spec.md §11). Sent as a
// transient `capacity_monthly_referrals` body field (not a `visits` column -
// EDITABLE below intentionally excludes it); appends a capacity_observations
// row (source: 'prequal') rather than overwriting a column - see that
// table's own migration header for why nothing here is ever updated in
// place. Silently no-ops on bad/irrelevant input, same "extra field ignored"
// convention as the EDITABLE loops below - this is a best-effort
// convenience, not a required part of logging a visit.
//
// Gate is computed confidence, NOT "is this the first visit" (the old rule
// this replaced had exactly that trapdoor - miss the number on visit one and
// the place was never asked again). 'fresh' is the only confidence this may
// NOT write over - 'stale' and 'unknown' both keep the prompt coming back
// until a real, CURRENT number is captured. Still re-read server-side rather
// than trusting the client's view of the place, same reasoning the old gate
// already had.
//
// encounters (already-normalized, post-validation - see ENCOUNTER_FIELDS)
// attributes the observation to whichever named contact was met, when there
// is one; a staff/receptionist/nobody-only trip leaves person_id null rather
// than guessing.
async function maybeCapturePreQualification({ placeId, capacityMonthlyReferrals, visitId, encounters = [] }) {
  if (capacityMonthlyReferrals === undefined || capacityMonthlyReferrals === null || capacityMonthlyReferrals === '') return;
  const n = Number(capacityMonthlyReferrals);
  if (!Number.isInteger(n) || n < 0) return;

  const capacity = await computeCapacityForPlace(knex, placeId, { asOf: orgToday() });
  if (!capacity || capacity.confidence === 'fresh') return;

  const observedAt = orgToday();
  const namedEncounter = encounters.find((e) => e.person_id != null);
  await knex('capacity_observations').insert({
    place_id: placeId,
    monthly_referrals: n,
    source: 'prequal',
    observed_at: observedAt,
    person_id: namedEncounter ? namedEncounter.person_id : null,
    visit_id: visitId,
  });
  // Stamps places.exploration_eligible_since to the date THIS observation
  // goes stale - see capacity.js's stampExplorationEligibility for why.
  await stampExplorationEligibility(knex, placeId, observedAt, schedulingConfig);

  // The step-6/7 dual-write bridge that used to sit here (writing the
  // legacy capacity_monthly_referrals/capacity_status columns alongside the
  // observation above) was removed 2026-08-07 once step 7 landed and was
  // verified: schedulingEngine.js's EXPLORATION tier gate now reads the
  // computed confidence (rankKey's effectiveCapacityConfidence), not
  // place.capacity_status, so nothing downstream reads those two columns for
  // ranking anymore. They're still on the table, unread, until the spec's
  // final step drops them.
}

// promise_next_visit is a transient body field (not a `visits` column, same
// convention as capacity_monthly_referrals above) - { promised_date,
// person_id?, note? }, VisitLogModal's "promise a next visit" field (Place
// Commitments spec §5.1). Validated up front, alongside the trip fields, so
// a bad date can't leave a completed visit saved with the promise silently
// dropped - unlike fulfill_commitment_ids below, this is real input the rep
// deliberately typed, not a best-effort convenience.
function promiseNextVisitError(v) {
  if (v === undefined || v === null) return null;
  if (!v.promised_date || !/^\d{4}-\d{2}-\d{2}$/.test(v.promised_date)) {
    return 'promise_next_visit.promised_date must be in YYYY-MM-DD format';
  }
  return null;
}

async function promiseNextVisitPersonError(v) {
  if (!v || v.person_id === undefined || v.person_id === null || v.person_id === '') return null;
  const n = Number(v.person_id);
  if (!Number.isInteger(n)) return 'promise_next_visit.person_id must be a number';
  const exists = await knex('people').where({ id: n }).first('id');
  if (!exists) return 'person not found';
  return null;
}

// Applied AFTER the visit itself is saved - both need the real visit id
// (fulfillCommitment's discharged_by_visit_id, createCommitment's
// source_visit_id). Two independent side effects of "log this visit," same
// spot maybeCapturePreQualification hooks in from, gated the same way
// (completed trips only - a still-planned stop hasn't happened yet, nothing
// to fulfill or promise from).
//
// fulfillCommitmentIds is intersected against what's ACTUALLY outstanding
// right now, never trusted from the client's possibly-stale view (the panel
// was fetched when the modal opened, and time passes while a rep fills out
// the form) - anything not currently outstanding (already resolved by
// someone else, wrong place, bogus id) is silently skipped, not errored,
// same best-effort convention as maybeCapturePreQualification's own bad-input
// handling.
async function applyCommitmentSideEffects({ placeId, visitId, fulfillCommitmentIds, promiseNextVisit, createdByUserId }) {
  if (Array.isArray(fulfillCommitmentIds) && fulfillCommitmentIds.length) {
    const outstanding = await getOutstandingCommitments(knex, placeId);
    const requested = new Set(fulfillCommitmentIds.map(Number));
    for (const c of outstanding) {
      if (requested.has(c.id)) await fulfillCommitment(knex, c.id, { dischargedByVisitId: visitId });
    }
  }
  if (promiseNextVisit && promiseNextVisit.promised_date) {
    await createCommitment(knex, {
      placeId,
      promisedDate: promiseNextVisit.promised_date,
      personId: promiseNextVisit.person_id || null,
      note: promiseNextVisit.note || null,
      sourceVisitId: visitId,
      createdByUserId,
    });
  }
}

// Trip-level fields a client is allowed to set when logging/updating a visit.
// Anything not in this list in the request body is silently ignored (not
// saved). visit_type is otherwise only ever set once, at route-planner commit
// time (scheduleDraft.js) - included here so it can be corrected after the
// fact too, same as notes/date/etc.
//
// outcome/met_with_type/they_requested/person_* are deliberately absent: they
// are per-ENCOUNTER facts now, and arrive in the `encounters` array instead.
// Leaving them here would let a client "save" an outcome that has nowhere to
// land and no visible symptom.
//
// next_visit_date is ALSO deliberately absent now (removed 2026-08-11, Place
// Commitments) - it had six readers and zero writers even before this, and
// VisitLogModal's own "promise a next visit" field (see promise_next_visit
// below) is its real replacement: a place_commitments row, not a visits
// column, since a column can only ever hold one promise. The column itself
// stays on the table, frozen, until every read site is repointed and it's
// dropped in a follow-up migration.
const EDITABLE = [
  'user_id',
  'scheduled_date',
  'status',
  'notes',
  'sort_order',
  'visit_type',
  // Relationship-model capture (see services/relationship.js).
  // actual_duration_minutes is captured but deliberately unread by that model
  // - it's here to start collecting real data against which
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
// { error } or { encounters } - fully checked BEFORE any insert, so one bad
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
      // Checked against THIS visit's own ids, not just "does it exist" - an
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
      // relationship score for a single conversation - and would violate
      // visit_encounters_unique_person besides.
      if (seenPersonIds.has(personId)) {
        return { error: 'the same person cannot be recorded twice on one visit' };
      }
      seenPersonIds.add(personId);
      e.person_id = personId;
    } else {
      // Only a named_person encounter may carry a person - anything else is
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
// visit doesn't have to be assigned to a rep), so only checked when provided -
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
// Left joins, not inner - a visit's place or rep can be gone (deleted) while
// the visit itself survives; v.place_name is the durable snapshot that still
// identifies the place either way, so it isn't overridden by the (possibly
// absent) live join.
async function fetchVisit(id) {
  const visit = await knex('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .leftJoin('users as u', 'u.id', 'v.user_id')
    .where('v.id', id)
    .select(
      'v.*',
      'p.city as place_city',
      'p.zip as place_zip',
      // For VisitDetailModal's "Promised next visit" annotation - a
      // commitment made during this trip can sit unacted on if the PLACE is
      // currently snoozed/do-not-visited, which lives on a different row.
      'p.snooze_until as place_snooze_until',
      'p.do_not_visit as place_do_not_visit',
      'p.do_not_visit_until as place_do_not_visit_until',
      'u.name as user_name'
    )
    .first();
  if (!visit) return visit;
  const [withEncounters] = await attachEncounters(knex, [visit], { columns: ENCOUNTER_DETAIL_COLUMNS });
  const [withCommitments] = await attachCommitmentsMade(knex, [withEncounters]);

  // Cross-rep hard-floor warning (informational only - see
  // crossRepFloorWarning.js). No place, no floor to check against.
  if (withCommitments.place_id) {
    const byPlace = await crossRepVisitsByPlace(knex, [withCommitments.place_id]);
    withCommitments.crossRepFloorWarning = findCrossRepFloorWarning(withCommitments, byPlace.get(withCommitments.place_id) || [], schedulingConfig);
  } else {
    withCommitments.crossRepFloorWarning = null;
  }
  return withCommitments;
}

// "2026-07" -> { start: "2026-07-01", end: "2026-07-31" }. Used by the
// calendar route below to turn a month picker value into a whereBetween range
// against scheduled_date (a plain 'YYYY-MM-DD' string column, so plain string
// bounds are enough - no date-library parsing needed).
function monthRange(monthKey) {
  const [y, m] = monthKey.split('-').map(Number); // m is 1-based (7 = July)
  const lastDay = new Date(y, m, 0).getDate(); // new Date(2026, 7, 0) = July 31
  const mm = String(m).padStart(2, '0');
  return {
    start: `${y}-${mm}-01`,
    end: `${y}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

// GET /api/visits/calendar?month=YYYY-MM[&userId=<int>] - every visit
// scheduled in the given month, flat (not grouped by day - the frontend buckets
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

    // One row per TRIP - a three-person visit is one square on the calendar,
    // not three.
    //
    // Left joins, not inner - same detach-not-delete precedent as fetchVisit()
    // above and dashboard.js: a visit survives its place or rep being removed.
    // v.place_name is the durable place-name snapshot (always present); the
    // rest of the place_* fields and user_name are honestly null if detached.
    // Column list (and the `u.name as user_name` alias) deliberately mirrors
    // places.js/people.js's own visit-history queries (`v.*` + user_name) -
    // this feeds the same VisitDetailModal/UpcomingVisitDetailModal those do,
    // and a differently-named or narrower select here previously meant a
    // visit opened from the Calendar tab silently showed less than the exact
    // same row opened from PlaceDetail/PersonDetail.
    const rows = await knex('visits as v')
      .leftJoin('places as p', 'p.id', 'v.place_id')
      .leftJoin('users as u', 'u.id', 'v.user_id')
      // Manual Visit Planning spec §5 - the PLANNER's name (which can differ
      // from u.name/user_id above, the ASSIGNEE), for the "Planned by
      // {Name}" marker on a cross-rep manual stop (PlannedDayModal.jsx).
      .leftJoin('users as creator', 'creator.id', 'v.created_by_user_id')
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
        'v.planned_manually',
        'v.created_by_user_id',
        'creator.name as created_by_name'
      );

    // One extra query for the whole month, grouped in JS - never one per row.
    const withEncounters = await attachEncounters(knex, rows);

    // Cross-rep hard-floor warning (informational only - see
    // crossRepFloorWarning.js). Batched once across every distinct place in
    // the month, not once per row - VisitsCalendar.jsx passes these rows
    // straight into VisitDetailModal/CompletedVisitsModal with no refetch,
    // so this is required for the tag to reach the Calendar tab at all.
    const crossRepByPlace = await crossRepVisitsByPlace(knex, withEncounters.map((r) => r.place_id));
    res.json(attachCrossRepFloorWarnings(withEncounters, crossRepByPlace, schedulingConfig));
  } catch (err) {
    next(err);
  }
});

// GET /api/visits/:id - one whole trip, encounters included. The single call
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

// POST /api/visits - create an ad-hoc visit (outside the generated schedule),
// e.g. from the "Log a visit" button on a Place Detail page.
router.post('/', async (req, res, next) => {
  try {
    const { place_id } = req.body;
    if (!place_id) return res.status(400).json({ error: 'place_id is required' });
    const numericPlaceId = Number(place_id);
    if (Number.isNaN(numericPlaceId)) return res.status(404).json({ error: 'Place not found' });
    const place = await knex('places').where({ id: numericPlaceId }).first();
    if (!place) return res.status(404).json({ error: 'Place not found' });

    // place_name is a one-time snapshot taken here, at logging time - a
    // visit's place_id is never changed after creation, so this never needs
    // re-deriving later, even if the place is later renamed or deleted.
    const payload = { place_id: numericPlaceId, place_name: place.name };
    for (const f of EDITABLE) if (req.body[f] !== undefined) payload[f] = req.body[f];

    const fieldError = tripFieldError(payload);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const userError = await coerceUserId(payload);
    if (userError) return res.status(400).json({ error: userError });

    const promiseErr = promiseNextVisitError(req.body.promise_next_visit);
    if (promiseErr) return res.status(400).json({ error: promiseErr });
    const promisePersonErr = await promiseNextVisitPersonError(req.body.promise_next_visit);
    if (promisePersonErr) return res.status(400).json({ error: promisePersonErr });

    let encounters = [];
    if (req.body.encounters !== undefined) {
      const result = await normalizeEncounters(req.body.encounters);
      if (result.error) return res.status(400).json({ error: result.error });
      encounters = result.encounters;
    }

    // A completed trip that met nobody and no category isn't a coherent
    // record of anything - there'd be nothing to score and nothing to show.
    // 'planned' is exempt on purpose: a scheduled stop that hasn't happened
    // yet has no encounters by definition, and that's its normal state.
    if (payload.status === 'completed' && !encounters.length) {
      return res.status(400).json({ error: 'A completed visit needs at least one encounter' });
    }

    // Ad-hoc creation (this route) now runs through the same detector
    // addStop uses (services/conflictDetection.js) instead of its own
    // narrower exact-date-only check - that used to mean this was the one
    // visit-logging path with no floor protection at all: a rep could log a
    // second visit to the same place two days after their own completed one
    // with zero warning, since the floor only ever applied to the
    // auto-generator. Deliberately does NOT exclude the same rep the way
    // crossRepFloorWarning does elsewhere - a rep's own back-to-back visits
    // are exactly the case this exists to catch.
    //
    // Only SAME_DATE_VISIT actually blocks (409, unchanged - same override
    // pattern as places.js's ADDRESS_UNRECOGNIZED confirm flow: re-send with
    // `force: true` to proceed). FLOOR_COMPLETED/FLOOR_PLANNED/DRAFT_ELSEWHERE
    // are informational findings, not errors - a 409 for those would misrepresent
    // the result to any consumer of this endpoint besides VisitLogModal
    // (there is other integration surface here). Nothing is created yet
    // either, so 201 would be just as wrong a claim - 200 with the findings
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
      await maybeCapturePreQualification({ placeId: numericPlaceId, capacityMonthlyReferrals: req.body.capacity_monthly_referrals, visitId: id, encounters });
      await applyCommitmentSideEffects({
        placeId: numericPlaceId,
        visitId: id,
        fulfillCommitmentIds: req.body.fulfill_commitment_ids,
        promiseNextVisit: req.body.promise_next_visit,
        createdByUserId: req.user.id,
      });
    }

    res.status(201).json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// POST /api/visits/manual - plan a visit directly, for a future date,
// without asking the route planner to agree (Manual Visit Planning spec,
// 2026-08-12 v2, §3-§5). Distinct from POST / above: that route creates an
// ad-hoc COMPLETED (or occasionally already-known-outcome) trip; this one
// creates a still-open status:'planned' row nobody has visited yet, with its
// own, stricter conflict policy (services/manualVisits.js's classifyConflicts
// hard-blocks DRAFT_ELSEWHERE, where the route above only warns on it).
//
// Body: { place_id, scheduled_date, user_id?, notes?, visit_type?, force? }. user_id is
// the ASSIGNEE - defaults to the caller (planning for yourself is the common
// case), but any rep may plan for any other rep (§5). created_by_user_id is
// always the authenticated caller, never client-supplied - cross-rep
// planning must always be traceable to who actually made the decision.
//
// Response shapes:
//   201 { ...full visit... }       - created.
//   200 { warnings: [...] }        - a §4.2 warning (floor / do_not_visit)
//                                    fired and `force` wasn't set; nothing
//                                    written yet. Resend with force:true.
//   409 { error, code, conflicts } - a §4.1 hard block; nothing written, no
//                                    override possible.
router.post('/manual', async (req, res, next) => {
  try {
    const { place_id, scheduled_date, visit_type, force } = req.body;
    if (!place_id) return res.status(400).json({ error: 'place_id is required' });
    if (!scheduled_date || !/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
      return res.status(400).json({ error: 'scheduled_date is required, in YYYY-MM-DD format' });
    }
    const fieldError = tripFieldError(req.body);
    if (fieldError) return res.status(400).json({ error: fieldError });
    const numericPlaceId = Number(place_id);
    if (Number.isNaN(numericPlaceId)) return res.status(404).json({ error: 'Place not found' });

    let assigneeId = req.user.id;
    if (req.body.user_id !== undefined && req.body.user_id !== null && req.body.user_id !== '') {
      const numericUserId = Number(req.body.user_id);
      const assignee = Number.isNaN(numericUserId) ? null : await knex('users').where({ id: numericUserId }).first();
      if (!assignee) return res.status(400).json({ error: 'user not found' });
      assigneeId = numericUserId;
    }

    const result = await createManualVisit(knex, {
      placeId: numericPlaceId,
      scheduledDate: scheduled_date,
      userId: assigneeId,
      createdByUserId: req.user.id,
      notes: req.body.notes || null,
      visitType: visit_type || null,
      force: !!force,
    });

    if (!result.visit) return res.status(200).json({ warnings: result.warnings });
    res.status(201).json(await fetchVisit(result.visit.id));
  } catch (err) {
    if (err.status) {
      const body = { error: err.message };
      if (err.conflicts) {
        body.conflicts = err.conflicts;
        body.code = err.code;
      }
      return res.status(err.status).json(body);
    }
    next(err);
  }
});

// PATCH /api/visits/:id - log or update a visit (notes, date, status, and the
// people met on it). This is what the "Log Visit" form actually calls when
// saving. A rep can complete/correct ANY visit here, including one under a
// teammate's account and regardless of its current status - the client
// confirms that's intentional first (see the "logged under a different rep's
// account" confirm before opening VisitLogModal in VisitsCalendar.jsx/
// PlaceDetail.jsx/PersonDetail.jsx), but nothing is blocked server-side.
// Deliberate: this is the ONLY caller of this route for a still-`planned`
// visit (VisitLogModal always saves status:'completed', whatever status the
// row started at - see its own save()), so "can I log what happened on a
// colleague's still-open stop" was ever the real question a hard 403 here
// answered, and Bede's call was that it should be a confirm, not a block -
// covering for someone, or logging on their behalf, is a normal case, not a
// mistake to prevent.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    // Logging/completing a colleague's still-planned visit is deliberately
    // unrestricted here (VisitLogModal always saves as completed regardless
    // of starting status - see PATCH /:id/edit's own comment above). But
    // reassigning WHO or WHEN a still-planned visit happens is exactly what
    // that narrower /:id/edit endpoint exists to govern (assignee-only,
    // full conflict recheck) - this plain endpoint must not let a second
    // rep bypass that by PATCHing scheduled_date/user_id directly.
    if (visit.status === 'planned' && (req.body.scheduled_date !== undefined || req.body.user_id !== undefined) && !canEditManualVisit(visit, req.user.id)) {
      return res.status(403).json({ error: 'Only the assigned rep can change who or when this visit is for' });
    }

    const update = { updated_at: knex.fn.now() };
    for (const f of EDITABLE) if (req.body[f] !== undefined) update[f] = req.body[f];

    const fieldError = tripFieldError(update);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const userError = await coerceUserId(update);
    if (userError) return res.status(400).json({ error: userError });

    const promiseErr = promiseNextVisitError(req.body.promise_next_visit);
    if (promiseErr) return res.status(400).json({ error: promiseErr });
    const promisePersonErr = await promiseNextVisitPersonError(req.body.promise_next_visit);
    if (promisePersonErr) return res.status(400).json({ error: promisePersonErr });

    const existing = await knex('visit_encounters').where({ visit_id: id }).select('id');
    const existingIds = new Set(existing.map((e) => e.id));

    // `encounters` is an UPSERT BY ID, not a delete-all-then-reinsert: an
    // entry carrying an `id` updates that encounter in place, one without an
    // id is new, and any existing encounter missing from the array is
    // deleted. WHY it matters that ids survive: the client holds them for its
    // per-encounter delete buttons (DELETE /:id/encounters/:encounterId), so
    // a blanket replace would silently 404 every one of those buttons after
    // any unrelated trip-level save - a note edit would invalidate the
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
      await maybeCapturePreQualification({ placeId: visit.place_id, capacityMonthlyReferrals: req.body.capacity_monthly_referrals, visitId: id, encounters: encounters || [] });
      await applyCommitmentSideEffects({
        placeId: visit.place_id,
        visitId: id,
        fulfillCommitmentIds: req.body.fulfill_commitment_ids,
        promiseNextVisit: req.body.promise_next_visit,
        createdByUserId: req.user.id,
      });
    }

    res.json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visits/:id/edit - change a still-planned visit's date, visit
// type, and/or notes: UpcomingVisitDetailModal's "Edit" button, on a manually-planned
// visit AND a planner-committed one alike. Deliberately its own endpoint
// rather than folded into the generic PATCH /:id above: a plain date edit
// there just saves whatever's sent with no conflict check at all, but this
// has to re-run every §4 check against a NEW date first (moving Tuesday to
// Thursday is a fresh collision check against Thursday) and can come back
// with warnings pending confirmation - a response shape PATCH /:id was
// never built to return. A notes-only edit (scheduled_date omitted, or
// unchanged) skips that recheck. See services/manualVisits.js's editVisit
// for the promotion this performs on ANY successful save - planned_manually/
// source flip to look exactly like a visit planned by hand from here on,
// whichever way it started out.
//
// Only the visit's ASSIGNEE may edit it (services/manualVisits.js's
// canEditManualVisit) - narrower than the creator-may-also-delete rule on
// DELETE /:id below (§5: the creator's own permission stops at delete).
//
// Body: { scheduled_date?, notes?, visit_type?, force? }. Same response shapes as POST /manual.
router.patch('/:id/edit', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const { scheduled_date, notes, visit_type, force } = req.body;
    if (scheduled_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled_date)) {
      return res.status(400).json({ error: 'scheduled_date must be in YYYY-MM-DD format' });
    }
    const fieldError = tripFieldError(req.body);
    if (fieldError) return res.status(400).json({ error: fieldError });

    const result = await editVisit(knex, id, { scheduledDate: scheduled_date, notes, visitType: visit_type, force: !!force }, req.user.id);
    if (!result.visit) return res.status(200).json({ warnings: result.warnings });
    res.json(await fetchVisit(result.visit.id));
  } catch (err) {
    if (err.status) {
      const body = { error: err.message };
      if (err.conflicts) {
        body.conflicts = err.conflicts;
        body.code = err.code;
      }
      return res.status(err.status).json(body);
    }
    next(err);
  }
});

// POST /api/visits/:id/snooze - an explicit rep deferral of a still-planned
// visit (distinct from 'skipped', the passive lapse the sweep in
// services/visitLifecycle.js stamps on its own). Two writes, and the second
// is the one that matters: the visit resolves to 'snoozed' (the audit
// record - who deferred what, until when), and the PLACE's own
// `snooze_until` is set to the same date - the actual suppression.
// schedulingEngine.js's eligibility() has read place.snooze_until since
// 2026-07-12 with no write path anywhere until now; without this second
// write a snooze would accomplish nothing; lastVisitedAt stays untouched,
// urgency keeps climbing, and the next draft generation re-offers the place
// right away. No background job un-suppresses it later - eligibility()
// already checks `place.snooze_until >= today` live on every ranking pass,
// so it lapses naturally once the date passes, same as the skip sweep needs
// no cron.
//
// Guarded against swallowing a real commitment: if this place already has a
// binding place_commitments row (services/placeCommitments.js's
// getBindingCommitment - the earliest OUTSTANDING promised_date) and the
// chosen snoozed_until would land ON OR AFTER it, that commitment would
// never surface before the snooze lifts. A snooze that resolves BEFORE the
// commitment is due is not a conflict and proceeds silently. Requires
// `force: true` to proceed past the conflict, same override convention as
// the SAME_DATE_VISIT collision in POST / above.
//
// force: true is deliberately NOT wired to discharge or otherwise touch the
// commitment - it stays outstanding, the place stays suppressed for the
// snooze window, and once the snooze lapses the place returns to the
// COMMITMENT tier more overdue than before. Auto-clearing it here would mean
// this endpoint reaches into a promise's own record to make scheduling
// convenient, which erodes the audit trail (see HANDOFF.md §19). The route
// planner badge (Place Commitments spec §6.1) is what keeps a deferred
// promise visible during the snooze window instead.
router.post('/:id/snooze', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });
    if (visit.status !== 'planned') {
      return res.status(400).json({ error: 'Only a still-planned visit can be snoozed' });
    }
    if (visit.user_id != null && visit.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit a still-planned visit under your own account' });
    }

    const { snoozed_until } = req.body;
    if (!snoozed_until || !/^\d{4}-\d{2}-\d{2}$/.test(snoozed_until)) {
      return res.status(400).json({ error: 'snoozed_until is required, in YYYY-MM-DD format' });
    }

    if (visit.place_id && !req.body.force) {
      const commitment = await getBindingCommitment(knex, visit.place_id);
      if (snoozeSwallowsCommitment({ snoozedUntil: snoozed_until, nextVisitDate: commitment?.promised_date })) {
        return res.status(409).json({
          error: `This place has a follow-up promised for ${commitment.promised_date}. Snoozing until ${snoozed_until} would suppress it.`,
          code: 'SNOOZE_SWALLOWS_COMMITMENT',
          nextVisitDate: commitment.promised_date,
        });
      }
    }

    await knex.transaction(async (trx) => {
      await trx('visits').where({ id }).update({
        status: 'snoozed',
        snoozed_until,
        resolved_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      if (visit.place_id) {
        await trx('places').where({ id: visit.place_id }).update({ snooze_until: snoozed_until });
      }
    });

    res.json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visits/:id/encounters/:encounterId - remove ONE person/category
// from a trip, leaving the trip itself (and everyone else on it) alone.
//
// Removing the last encounter of a COMPLETED trip deletes the trip too: a
// completed visit with nobody on it is the same incoherent record POST/PATCH
// refuse to create, and leaving one behind would put it in a state the edit
// form itself can't save. Scoped to completed on purpose - an empty encounter
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
    // stop is different - that's someone else's not-yet-happened scheduled
    // visit, not history to correct - so it stays restricted to its own rep.
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

// DELETE /api/visits/:id - remove a stop from the schedule entirely (not the
// same as skipping - this deletes the row, skip just changes its status).
// Its encounters go with it via ON DELETE CASCADE, which is deliberate and
// unlike the detach-not-delete rule everywhere else: an encounter has no
// meaning without the trip it happened on.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(404).json({ error: 'Visit not found' });
    const visit = await knex('visits').where({ id }).first();
    if (!visit) return res.status(404).json({ error: 'Visit not found' });

    // A manually-planned visit's CREATOR may also delete it on someone
    // else's behalf (Manual Visit Planning spec §5) - the one case where
    // deleting a visit that isn't "your own account" is allowed. Scoped to
    // status:'planned': once it's completed or lapsed to skipped it's real
    // history, not an open plan, and the ordinary assignee-only rule below
    // is what governs it (same as every other visit).
    if (visit.planned_manually && visit.status === 'planned') {
      if (!canDeleteManualVisit(visit, req.user.id)) {
        return res.status(403).json({ error: 'Only the assigned rep or the rep who planned this visit can delete it' });
      }
    } else if (visit.user_id != null && visit.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only edit visits scheduled under your own account' });
    }

    await knex('visits').where({ id }).del();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
