// Visits — one planned/completed/skipped touchpoint on a place, by a rep,
// on a date. This covers logging outcomes/notes/person info, and deleting
// one. (Creating a whole day's worth at once happens via the route planner's
// commit flow — see services/scheduleDraft.js — not here.)
const express = require('express');
const knex = require('../db/knex');
const { validatePhone } = require('../services/phone');
const { VISIT_TYPES } = require('../config/visitTypes');

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

// One visit ROW is one ENCOUNTER — a single who/what/did-they-ask triple.
// A trip where the rep met a named contact AND got gatekept by the front desk
// is two encounters, so it writes two rows sharing the same place, date,
// notes and duration but each carrying its own met_with_type, person_id,
// outcome and they_requested.
//
// This is what makes the relationship model reachable from the form: the
// named-contact row scores toward THAT PERSON's relationship, while the
// receptionist row scores (much lower) toward the place's floor — see
// services/relationship.js's creditsPerson/visitWeight. Collapsing a trip
// into one row would force the rep to pick one and silently discard the other.
//
// The fan-out happens HERE rather than as N calls from the browser for two
// reasons: the collision check below must run ONCE for the trip (N separate
// POSTs would have rows 2..N colliding with row 1 and falsely warning "you
// already have a visit here"), and all-or-nothing insertion needs one
// transaction. Fatigue counting already treats these as a single trip — see
// buildCandidatePool's distinct-day counting in services/scheduleDraft.js.
const MAX_ENCOUNTERS_PER_VISIT = 20; // sanity guard, not a real-world limit

// Trip-level fields are shared by every row; everything else is per-encounter.
const ENCOUNTER_FIELDS = ['met_with_type', 'person_id', 'outcome', 'they_requested'];

// Snapshot fields are read from the people table per person rather than
// trusted from the request body: with several people in play the client would
// have to send a parallel array of contact details, and any mismatch would
// silently mis-attribute one person's phone/email onto another's visit row.
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

// Fields a client is allowed to set when logging/updating a visit. Anything
// not in this list in the request body is silently ignored (not saved).
// visit_type is otherwise only ever set once, at route-planner commit time
// (scheduleDraft.js) — included here so it can be corrected after the fact
// too, same as outcome/notes/etc.
const EDITABLE = [
  'user_id',
  'scheduled_date',
  'status',
  'outcome',
  'notes',
  'person_id',
  'person_name',
  'person_title',
  'person_email',
  'person_phone',
  'next_visit_date',
  'sort_order',
  'visit_type',
  // Relationship-model capture (see services/relationship.js).
  // actual_duration_minutes is captured but deliberately unread by that model
  // — it's here to start collecting real data against which
  // config/visitTypes.js's hardcoded per-type minutes can later be calibrated.
  'met_with_type',
  'they_requested',
  'actual_duration_minutes',
];

// Re-fetches a visit joined to its place's basic info, for the response
// after a create/update (so the frontend doesn't need a second request).
// Left join, not inner — a visit's place can be gone (deleted) while the
// visit itself survives; v.place_name is the durable snapshot that still
// identifies it either way, so it isn't overridden by the (possibly absent) live join.
async function fetchVisit(id) {
  return knex('visits as v')
    .leftJoin('places as p', 'p.id', 'v.place_id')
    .where('v.id', id)
    .select('v.*', 'p.city as place_city', 'p.zip as place_zip')
    .first();
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

    // Left joins, not inner — same detach-not-delete precedent as fetchVisit()
    // below and dashboard.js: a visit survives its place or rep being removed.
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
        'v.outcome',
        'v.notes',
        'v.visit_type',
        'v.source',
        'v.person_id',
        'v.person_name',
        'v.person_title',
        'v.person_email',
        'v.person_phone',
        'v.next_visit_date'
      );

    res.json(rows);
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
    if (payload.met_with_type && !MET_WITH_TYPES.includes(payload.met_with_type)) {
      return res.status(400).json({ error: `met_with_type must be one of ${MET_WITH_TYPES.join(', ')}` });
    }
    if (payload.outcome && !OUTCOMES.includes(payload.outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    }
    if (payload.status && !STATUSES.includes(payload.status)) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    if (payload.visit_type && !VISIT_TYPES[payload.visit_type]) {
      return res.status(400).json({ error: `visit_type must be one of ${Object.keys(VISIT_TYPES).join(', ')}` });
    }

    // user_id and person_id are both nullable FKs (a visit doesn't have to be
    // assigned to a rep or matched to a known person), so only validate them
    // when actually provided — same "look it up, 400 if missing" pattern
    // people.js uses for its own place_id foreign reference.
    if (payload.user_id !== undefined && payload.user_id !== null && payload.user_id !== '') {
      const numericUserId = Number(payload.user_id);
      if (Number.isNaN(numericUserId)) return res.status(400).json({ error: 'user not found' });
      const user = await knex('users').where({ id: numericUserId }).first();
      if (!user) return res.status(400).json({ error: 'user not found' });
      payload.user_id = numericUserId;
    }
    if (payload.person_id !== undefined && payload.person_id !== null && payload.person_id !== '') {
      const numericPersonId = Number(payload.person_id);
      if (Number.isNaN(numericPersonId)) return res.status(400).json({ error: 'person not found' });
      const person = await knex('people').where({ id: numericPersonId }).first();
      if (!person) return res.status(400).json({ error: 'person not found' });
      payload.person_id = numericPersonId;
    }

    // Several encounters on one trip (see MAX_ENCOUNTERS_PER_VISIT above).
    // Fully validated up front, before any insert, so one bad entry can't
    // leave a half-written trip behind.
    let encounters = null;
    if (req.body.encounters !== undefined) {
      if (!Array.isArray(req.body.encounters)) {
        return res.status(400).json({ error: 'encounters must be an array' });
      }
      if (req.body.encounters.length > MAX_ENCOUNTERS_PER_VISIT) {
        return res.status(400).json({ error: `A single visit can record at most ${MAX_ENCOUNTERS_PER_VISIT} encounters` });
      }
      if (req.body.encounters.length) {
        const seenPersonIds = new Set();
        const built = [];
        for (const raw of req.body.encounters) {
          if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'each encounter must be an object' });
          const e = {};
          for (const f of ENCOUNTER_FIELDS) if (raw[f] !== undefined) e[f] = raw[f];

          if (!MET_WITH_TYPES.includes(e.met_with_type)) {
            return res.status(400).json({ error: `met_with_type must be one of ${MET_WITH_TYPES.join(', ')}` });
          }
          if (!OUTCOMES.includes(e.outcome)) {
            return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
          }
          e.they_requested = Boolean(e.they_requested);

          if (e.met_with_type === 'named_person') {
            const personId = Number(e.person_id);
            if (!Number.isInteger(personId)) return res.status(400).json({ error: 'person not found' });
            // The same person twice in one trip would double-count their
            // relationship score for a single conversation.
            if (seenPersonIds.has(personId)) {
              return res.status(400).json({ error: 'the same person cannot be recorded twice on one visit' });
            }
            seenPersonIds.add(personId);
            e.person_id = personId;
          } else {
            // Only a named_person encounter may carry a person — anything
            // else is by definition "we didn't meet anyone identifiable,"
            // and a stray person_id here would wrongly credit them.
            e.person_id = null;
          }
          built.push(e);
        }

        // One query for every named person, rather than one per encounter.
        if (seenPersonIds.size) {
          const rows = await knex('people').whereIn('id', [...seenPersonIds]);
          if (rows.length !== seenPersonIds.size) return res.status(400).json({ error: 'person not found' });
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const e of built) {
            if (e.person_id != null) Object.assign(e, snapshotFromPerson(byId.get(e.person_id)));
          }
        }
        encounters = built;
      }
    }

    const phoneError = validatePhone(payload.person_phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Ad-hoc creation (this route) is the one visit-logging path with no
    // collision protection — the route planner's commit flow has its own
    // dedicated locked-elsewhere/committed-elsewhere checks (scheduleDraft.js),
    // but a plain "Log a visit" never went through them. Warn, don't block:
    // same override pattern as places.js's ADDRESS_UNRECOGNIZED confirm flow
    // — surface a 409 with who/what's already there unless the client
    // explicitly re-sends with `force: true` (VisitLogModal's "Log anyway").
    // Scoped to any planned/completed row for the same place+date, including
    // the SAME user's own (an accidental double-log, e.g. re-submitting after
    // a refresh, is exactly as worth flagging as two different reps colliding)
    // — a skipped visit doesn't really occupy the date, so that's excluded.
    if (payload.place_id && payload.scheduled_date && !req.body.force) {
      const collision = await knex('visits')
        .leftJoin('users', 'users.id', 'visits.user_id')
        .where({ 'visits.place_id': payload.place_id, 'visits.scheduled_date': payload.scheduled_date })
        .whereIn('visits.status', ['planned', 'completed'])
        .select('visits.status', 'visits.user_id', 'users.name as user_name')
        .first();
      if (collision) {
        const isSameUser = payload.user_id && collision.user_id === payload.user_id;
        const who = isSameUser ? 'You' : collision.user_name || 'Someone else';
        const verb = isSameUser ? 'have' : 'has';
        return res.status(409).json({
          error: `${who} already ${verb} a ${collision.status} visit here on this date.`,
          code: 'VISIT_COLLISION',
        });
      }
    }

    // Same rule as PATCH below: a visit created already-completed (e.g. an
    // ad-hoc "log a spontaneous visit" save) gets its completed_at stamped
    // immediately, not left null.
    if (payload.status === 'completed') payload.completed_at = knex.fn.now();

    // One row per encounter (or exactly one row when the caller sent no
    // `encounters` at all — the original single-encounter body shape is
    // unchanged, which is what the PATCH-driven edit path and any older
    // caller still use). All-or-nothing: a failure partway through must not
    // leave a trip half-recorded.
    const rowsToInsert = encounters && encounters.length
      ? encounters.map((e) => ({ ...payload, ...e }))
      : [payload];

    const ids = await knex.transaction(async (trx) => {
      const out = [];
      for (const row of rowsToInsert) {
        const [inserted] = await trx('visits').insert(row).returning('id');
        out.push(knex.extractId(inserted));
      }
      return out;
    });

    if (payload.status === 'completed') {
      await maybeCapturePreQualification({ placeId: numericPlaceId, capacityMonthlyReferrals: req.body.capacity_monthly_referrals });
    }

    // Responds with the FIRST row's full visit object — the same shape
    // single-encounter callers have always received, so nothing downstream had
    // to change — plus the ids of every row written, for a caller that wants
    // to know a trip produced several.
    const body = await fetchVisit(ids[0]);
    res.status(201).json(ids.length > 1 ? { ...body, visit_ids: ids } : body);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/visits/:id — log or update a visit (notes, person, outcome, etc.).
// This is what the "Log Visit" form actually calls when saving. A rep can
// correct any already-logged (completed/skipped) visit, including one under
// a teammate's account — the client confirms that's intentional first (see
// the "logged under a different rep's account" confirm before opening
// VisitLogModal in VisitsCalendar.jsx/PlaceDetail.jsx/PersonDetail.jsx), but
// isn't blocked here. A still-`planned` visit is different: that's someone
// else's not-yet-happened scheduled stop, not history to correct, so
// completing/editing it stays restricted to its own owning rep.
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

    if (update.met_with_type && !MET_WITH_TYPES.includes(update.met_with_type)) {
      return res.status(400).json({ error: `met_with_type must be one of ${MET_WITH_TYPES.join(', ')}` });
    }
    if (update.outcome && !OUTCOMES.includes(update.outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
    }
    if (update.status && !STATUSES.includes(update.status)) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    }
    if (update.visit_type && !VISIT_TYPES[update.visit_type]) {
      return res.status(400).json({ error: `visit_type must be one of ${Object.keys(VISIT_TYPES).join(', ')}` });
    }

    // Same nullable-FK validation as POST above — user_id/person_id are only
    // checked when the request is actually changing them.
    if (update.user_id !== undefined && update.user_id !== null && update.user_id !== '') {
      const numericUserId = Number(update.user_id);
      if (Number.isNaN(numericUserId)) return res.status(400).json({ error: 'user not found' });
      const user = await knex('users').where({ id: numericUserId }).first();
      if (!user) return res.status(400).json({ error: 'user not found' });
      update.user_id = numericUserId;
    }
    if (update.person_id !== undefined && update.person_id !== null && update.person_id !== '') {
      const numericPersonId = Number(update.person_id);
      if (Number.isNaN(numericPersonId)) return res.status(400).json({ error: 'person not found' });
      const person = await knex('people').where({ id: numericPersonId }).first();
      if (!person) return res.status(400).json({ error: 'person not found' });
      update.person_id = numericPersonId;
    }

    const phoneError = validatePhone(update.person_phone);
    if (phoneError) return res.status(400).json({ error: phoneError });

    // Stamp completion time only the moment a visit *becomes* completed, not
    // on every subsequent edit to an already-completed visit.
    if (update.status === 'completed' && visit.status !== 'completed') {
      update.completed_at = knex.fn.now();
    }

    await knex('visits').where({ id }).update(update);

    const finalStatus = update.status ?? visit.status;
    if (finalStatus === 'completed') {
      await maybeCapturePreQualification({ placeId: visit.place_id, capacityMonthlyReferrals: req.body.capacity_monthly_referrals });
    }

    res.json(await fetchVisit(id));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/visits/:id — remove a stop from the schedule entirely (not the
// same as skipping — this deletes the row, skip just changes its status).
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
