// The dashboard is one big "rollup" endpoint: it runs several independent
// queries in parallel (Promise.all) and stitches the results into one JSON
// response, so the frontend can render the whole dashboard from a single
// request.
//
// Five sections, in the order the screen shows them (2026-08-18):
//   1. today                  - the day's route: count, first/next stop, drive time
//   2. this_week              - the calendar week's (Sun..Sat) completed/planned/skipped, day by day
//   3. commitments_due        - outstanding place_commitments, overdue + next N days
//   4. recent_referrals       - what just came in
//   5. top_referral_partners  - who sends the most business
//
// SCOPING, because the five are deliberately not all the same:
// (1) and (2) are about the logged-in rep's own day and week, so they take
// `userId`. (3), (4) and (5) are org-wide facts - a commitment is place-level
// and cross-rep by design (see services/placeCommitments.js's header), and a
// referral belongs to the person who sent it, not to whoever typed it in.
// Narrowing those three to one rep would hide real work rather than focus it.
const express = require('express');
const knex = require('../db/knex');
const dashboardConfig = require('../config/dashboard');
const referralsConfig = require('../config/referrals');
const { orgToday } = require('../services/orgDate');
const { recentWindowCutoff } = require('../services/referralMetrics');
const { skipSweepMiddleware } = require('../services/visitLifecycle');
const {
  addDays,
  daysBetween,
  calendarWeekDates,
  routeDriveEstimate,
  weekDayBuckets,
  formatMinutes,
} = require('../services/dashboardMetrics');

const router = express.Router();

// This router shows 'planned' visit statuses for today AND for the days
// already gone by this week, so it needs the same lapse sweep every other
// status-showing router mounts (services/visitLifecycle.js's header lists
// them). Without it, Monday's unlogged route still read "planned" here on
// Thursday while the Calendar tab - which does run the sweep - correctly
// showed it as skipped.
router.use(skipSweepMiddleware(knex));

// GET /api/dashboard?userId=&date=YYYY-MM-DD
router.get('/', async (req, res, next) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const date = req.query.date || orgToday();

    const weekDates = calendarWeekDates(date);
    const weekStart = weekDates[0];
    const weekEnd = weekDates[6];
    const horizonEnd = addDays(date, dashboardConfig.COMMITMENT_HORIZON_DAYS);
    const referralCutoff = recentWindowCutoff();

    const [todayVisits, weekVisits, commitments, recentReferrals, topPartners] =
      await Promise.all([
        // --- 1. today ----------------------------------------------------
        // Every visit dated today for this rep, in route order. lat/lng come
        // along for the drive estimate; address/city for the first-stop line.
        //
        // Left join, not inner - detach-not-delete: a completed visit
        // survives its place being deleted, and v.place_name is the durable
        // name snapshot (same precedent as visits.js's fetchVisit()).
        knex('visits as v')
          .leftJoin('places as p', 'p.id', 'v.place_id')
          .where('v.scheduled_date', date)
          .modify((qb) => userId && qb.andWhere('v.user_id', userId))
          .orderBy('v.sort_order', 'asc')
          .orderBy('v.id', 'asc')
          .select(
            'v.id as visit_id',
            'v.place_id',
            knex.raw('COALESCE(v.place_name, p.name) as name'),
            'v.status',
            'v.visit_type',
            'v.sort_order',
            'p.address',
            'p.city',
            'p.state',
            'p.zip',
            'p.category',
            'p.lat',
            'p.lng'
          ),

        // --- 2. this week ------------------------------------------------
        // The status + date is all weekDayBuckets() needs, but the strip's
        // pips are clickable (Dashboard.jsx) - each opens the day's
        // completed / planned / skipped list - so the row also carries the
        // little a CompletedVisitsModal / SkippedVisitsModal row shows
        // (place name, category, visit type). Left join, not inner:
        // detach-not-delete means v.place_name is the durable name for a
        // visit whose place is gone (same as query 1).
        knex('visits as v')
          .leftJoin('places as p', 'p.id', 'v.place_id')
          .whereBetween('v.scheduled_date', [weekStart, weekEnd])
          .modify((qb) => userId && qb.andWhere('v.user_id', userId))
          .orderBy('v.sort_order', 'asc')
          .orderBy('v.id', 'asc')
          .select(
            'v.id',
            'v.scheduled_date',
            'v.status',
            'v.place_id',
            'v.visit_type',
            'v.user_id',
            knex.raw('COALESCE(v.place_name, p.name) as place_name'),
            'p.category'
          ),

        // --- 3. commitments due ------------------------------------------
        // Outstanding = discharged_at IS NULL (services/placeCommitments.js).
        // No lower bound on promised_date on purpose: an unkept promise
        // stays outstanding and climbs in overdue-ness until a human
        // resolves it, so the oldest ones are the MOST important rows here,
        // not the ones to filter out.
        //
        // The place's own suppression fields ride along so the card can flag
        // the contradiction of a promise sitting on a snoozed/do-not-visit
        // place - the client shares one rule for that (api.js's
        // suppressionNote), so nothing is decided here.
        knex('place_commitments as pc')
          .leftJoin('places as p', 'p.id', 'pc.place_id')
          .leftJoin('people as pe', 'pe.id', 'pc.person_id')
          .whereNull('pc.discharged_at')
          .where('pc.promised_date', '<=', horizonEnd)
          .orderBy('pc.promised_date', 'asc')
          .orderBy('pc.id', 'asc')
          .select(
            'pc.id',
            'pc.place_id',
            'pc.promised_date',
            'pc.note',
            'pc.person_id',
            'pe.name as person_name',
            'p.name as place_name',
            'p.city',
            'p.snooze_until',
            'p.do_not_visit',
            'p.do_not_visit_until'
          ),

        // --- 4. recent referrals -----------------------------------------
        // Just the N most recently dated referrals, newest first - a feed of
        // "what just came in", not a windowed count (there is no "X in the
        // last 90 days" figure on this card anymore, so nothing here has to
        // agree with one).
        //
        // whereNotNull('r.person_id'): a referral belongs to the person who
        // sent it, and person_id is SET NULL when that person is deleted
        // (detach-not-delete). A person-less row has no name, no place and
        // nothing to open - it would just be a dated blank taking a slot a
        // real recent referral could use. Same reason the leaderboard below
        // inner-joins people. The join to people stays a leftJoin only
        // because a kept person can still lack a place.
        //
        // The card row itself only renders date / "Referred by {name}" /
        // note; person_title and place_name ride along for the detail popup
        // (ReferralDetailModal - "Referred by {name · title}", "Came from
        // {place}"). place_name is the SNAPSHOT place (r.place_id, stamped
        // from the referrer's place the day it was logged - see
        // routes/referrals.js), not the person's place today - the
        // leaderboard card beside this one is the one that follows a partner
        // to their current place.
        //
        // Ordered by COALESCE(referral_date, ''), not by referral_date
        // itself: referral_date is nullable, and a bare DESC sort puts NULLs
        // LAST on SQLite (dev) but FIRST on Postgres (prod) - which would
        // put every undated referral at the top of this card in production
        // only. '' sorts below every real 'YYYY-MM-DD' on both engines.
        knex('referrals as r')
          .leftJoin('people as pe', 'pe.id', 'r.person_id')
          .leftJoin('places as p', 'p.id', 'r.place_id')
          .whereNotNull('r.person_id')
          .orderByRaw("COALESCE(r.referral_date, '') desc")
          .orderBy('r.id', 'desc')
          .limit(dashboardConfig.RECENT_REFERRALS_LIMIT)
          .select(
            'r.id',
            'r.referral_date',
            'r.notes',
            // Needed because this card's rows open ReferralDetailModal, which
            // shows the payer source - without it, class reads blank when the
            // same referral is opened from here rather than a person's page.
            'r.class',
            'r.person_id',
            'pe.name as person_name',
            'pe.title as person_title',
            'p.name as place_name'
          ),

        // --- 5. top referral partners ------------------------------------
        // Inner join on people: a "partner" is a person, so a referral whose
        // person was deleted (person_id SET NULL, detach-not-delete) has
        // nobody left to credit and correctly drops out.
        //
        // The place shown is the person's CURRENT place, matching
        // referralMetrics.js's person-level rollup - a referral relationship
        // lives with the person, not the building, so this names where to
        // find them today rather than where they worked when they sent it.
        // (referrals.place_id, the frozen snapshot, is what capacity.js
        // reads instead, for the opposite and equally deliberate reason -
        // see HANDOFF.md §18.)
        knex('referrals as r')
          .join('people as pe', 'pe.id', 'r.person_id')
          .leftJoin('places as p', 'p.id', 'pe.place_id')
          .groupBy('r.person_id', 'pe.name', 'pe.title', 'pe.place_id', 'p.name', 'p.city')
          .orderByRaw('COUNT(*) desc')
          .orderByRaw("MAX(COALESCE(r.referral_date, '')) desc")
          .orderBy('pe.name', 'asc')
          .limit(dashboardConfig.TOP_PARTNERS_LIMIT)
          .select(
            'r.person_id',
            'pe.name as person_name',
            'pe.title as person_title',
            'pe.place_id',
            'p.name as place_name',
            'p.city',
            knex.raw('COUNT(*) as lifetime_referrals'),
            knex.raw("MAX(COALESCE(r.referral_date, '')) as last_referral_date"),
            knex.raw('SUM(CASE WHEN r.referral_date >= ? THEN 1 ELSE 0 END) as recent_referrals', [referralCutoff])
          ),
      ]);

    // ---- today, assembled ------------------------------------------------
    // A skipped or snoozed stop is not part of the drive: skipped means the
    // rep never went, snoozed means it was deliberately deferred (and never
    // gets a new scheduled_date - HANDOFF §19), so neither belongs in the
    // day's distance or its stop numbering.
    const route = todayVisits.filter((v) => v.status === 'planned' || v.status === 'completed');
    const drive = routeDriveEstimate(route);
    const counts = { planned: 0, completed: 0, skipped: 0, snoozed: 0 };
    for (const v of todayVisits) {
      if (counts[v.status] !== undefined) counts[v.status] += 1;
    }

    // Two different questions, both worth answering, and which one matters
    // depends on the time of day: `first_stop` is where the route begins
    // (the answer at 7am), `next_stop` is the first one not yet logged (the
    // answer at 2pm). The client shows first_stop, and adds next_stop only
    // once the day is genuinely underway.
    const firstStop = route[0] || null;
    const nextStop = route.find((v) => v.status === 'planned') || null;

    // ---- this week, assembled -------------------------------------------
    const weekCounts = { completed: 0, planned: 0, skipped: 0 };
    for (const v of weekVisits) {
      if (weekCounts[v.status] !== undefined) weekCounts[v.status] += 1;
    }
    const placesVisited = new Set(
      weekVisits.filter((v) => v.status === 'completed' && v.place_id != null).map((v) => v.place_id)
    );

    // ---- commitments, assembled -----------------------------------------
    // days_out carries the sign (negative = overdue), so the client never
    // re-derives overdue-ness from a date compare that could disagree with
    // the server's notion of today.
    const commitmentItems = commitments.map((c) => ({
      ...c,
      do_not_visit: !!c.do_not_visit,
      days_out: daysBetween(date, c.promised_date),
    }));
    const overdueCount = commitmentItems.filter((c) => c.days_out < 0).length;

    res.json({
      date,

      today: {
        date,
        counts,
        total: todayVisits.length,
        route,
        first_stop: firstStop,
        next_stop: nextStop && firstStop && nextStop.visit_id === firstStop.visit_id ? null : nextStop,
        drive: { ...drive, label: formatMinutes(drive.minutes) },
      },

      this_week: {
        start: weekStart,
        end: weekEnd,
        ...weekCounts,
        total: weekVisits.length,
        places_visited: placesVisited.size,
        days: weekDayBuckets(weekVisits, weekDates),
        // The rows behind the pips - Dashboard.jsx filters this by date +
        // status to feed a CompletedVisitsModal / SkippedVisitsModal when a
        // pip is clicked. One rep, one week: small enough to ship whole.
        visits: weekVisits,
      },

      commitments_due: {
        horizon_days: dashboardConfig.COMMITMENT_HORIZON_DAYS,
        horizon_end: horizonEnd,
        count: commitmentItems.length,
        overdue_count: overdueCount,
        // The counts above are uncapped (they describe the real backlog);
        // only the rendered list is trimmed. Sorted earliest-first already,
        // so the cut keeps the most urgent rows.
        items: commitmentItems.slice(0, dashboardConfig.COMMITMENT_LIST_LIMIT),
      },

      recent_referrals: {
        limit: dashboardConfig.RECENT_REFERRALS_LIMIT,
        items: recentReferrals,
      },

      top_referral_partners: {
        limit: dashboardConfig.TOP_PARTNERS_LIMIT,
        window_days: referralsConfig.RECENT_WINDOW_DAYS,
        items: topPartners.map((p) => ({
          ...p,
          lifetime_referrals: Number(p.lifetime_referrals),
          recent_referrals: Number(p.recent_referrals),
          // '' is the COALESCE placeholder the ordering needs, not a date -
          // don't let it reach the client as one.
          last_referral_date: p.last_referral_date || null,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
