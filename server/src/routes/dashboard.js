// The dashboard is one big "rollup" endpoint: it runs several independent
// queries in parallel (Promise.all) and stitches the results into one JSON
// response, so the frontend can render the whole dashboard from a single request.
const express = require('express');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek'); // adds Monday-start-of-week helpers to dayjs
const knex = require('../db/knex');
const { priorityLabel } = require('../services/priority');
const { recentWindowCutoff } = require('../services/referralMetrics');

dayjs.extend(isoWeek);

const router = express.Router();

// GET /api/dashboard?userId=&date=YYYY-MM-DD
// Returns: visits completed this week, never-visited places, and a "needs
// attention" rollup (cooling people + overdue visits).
router.get('/', async (req, res, next) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    // This (ISO) week's Monday..Sunday window, compared against scheduled_date.
    const weekStart = dayjs(date).isoWeekday(1).format('YYYY-MM-DD');
    const weekEnd = dayjs(date).isoWeekday(7).format('YYYY-MM-DD');

    const [completedThisWeek, neverVisited, totals, coolingPeople, nextVisitRows] =
      await Promise.all([
        // Left join, not inner — a completed visit is history that should
        // survive its place being deleted later (detach-not-delete). Prefer
        // the durable v.place_name snapshot for the name; city/tier have no
        // snapshot column, so those are honestly null for a detached visit
        // (same precedent as visits.js's fetchVisit()).
        knex('visits as v')
          .leftJoin('places as p', 'p.id', 'v.place_id')
          .where('v.status', 'completed')
          .whereBetween('v.scheduled_date', [weekStart, weekEnd])
          .modify((qb) => userId && qb.andWhere('v.user_id', userId))
          .orderBy('v.scheduled_date', 'desc')
          .select(
            'v.id as visit_id',
            'v.scheduled_date',
            'v.outcome',
            knex.raw('COALESCE(v.place_name, p.name) as name'),
            'p.city',
            'p.tier'
          ),

        // Never visited = no *completed* visit yet (a place only planned still counts
        // as not-yet-visited, so they stay on the prospecting list until the call is done).
        knex('places as p')
          .whereNotIn('p.id', knex('visits').where('status', 'completed').whereNotNull('place_id').select('place_id'))
          .orderBy('p.priority_score', 'desc')
          .orderBy('p.name', 'asc')
          .select('p.id', 'p.name', 'p.category', 'p.tier', 'p.is_priority', 'p.city', 'p.zip', 'p.region'),

        knex('places').count({ c: '*' }).first(),

        // Needs attention: cooling relationships (referred before, but
        // nothing in the last 90 days)...
        // Left join, not inner — a person can be unassigned (place_id null),
        // e.g. after their place was deleted or they were manually detached,
        // and should still be flagged as cooling rather than disappearing
        // (mirrors people.js's GET /people?needsAttention=1 query).
        knex('people as pe')
          .leftJoin('places as p', 'p.id', 'pe.place_id')
          .join('referrals as r', 'r.person_id', 'pe.id')
          .groupBy('pe.id', 'pe.name', 'pe.place_id', 'p.name')
          .havingRaw('SUM(CASE WHEN r.referral_date >= ? THEN 1 ELSE 0 END) = 0', [recentWindowCutoff(dayjs(date).toDate())])
          .orderBy('p.name', 'asc')
          .select(
            'pe.id as person_id',
            'pe.name as person_name',
            'pe.place_id',
            'p.name as place_name',
            knex.raw('COUNT(r.id) as lifetime_referrals'),
            knex.raw('MAX(r.referral_date) as last_referral_date')
          ),

        // ...and every visit that has a next_visit_date on file, so we can find overdue ones.
        // Intentionally an INNER join (not detach-not-delete "leftJoin everywhere"):
        // this list is place-centric and forward-looking ("you're overdue to
        // revisit place X"), unlike the visit-history and person-centric queries
        // above. If the place has been deleted there's nothing left to revisit,
        // so it's correct for it to drop off here rather than survive as a
        // dangling entry with no place to open.
        knex('visits as v')
          .join('places as p', 'p.id', 'v.place_id')
          .whereNotNull('v.next_visit_date')
          .orderBy('v.place_id')
          .orderBy('v.scheduled_date', 'desc')
          .orderBy('v.id', 'desc')
          .select(
            'v.place_id',
            'v.next_visit_date',
            'p.name',
            'p.category',
            'p.tier',
            'p.is_priority',
            'p.city',
            'p.zip'
          ),
      ]);

    // The query above returns every visit with a next_visit_date, one place at a
    // time, newest-first — so the first row per place_id is that place's most
    // current next-visit-date. Anything before "today" counts as overdue.
    // Keep only each place's most recent next_visit_date, then filter to overdue ones.
    const latestNextVisitByPlace = {};
    for (const r of nextVisitRows) if (!(r.place_id in latestNextVisitByPlace)) latestNextVisitByPlace[r.place_id] = r;
    const overduePlaces = Object.values(latestNextVisitByPlace)
      .filter((r) => r.next_visit_date < date)
      .sort((a, b) => a.next_visit_date.localeCompare(b.next_visit_date));

    res.json({
      date,
      week: { start: weekStart, end: weekEnd },
      completed_this_week: {
        count: completedThisWeek.length,
        visits: completedThisWeek,
      },
      never_visited: {
        count: neverVisited.length,
        total_places: Number(totals.c),
        places: neverVisited.map((p) => ({
          ...p,
          is_priority: !!p.is_priority,
          priority_label: priorityLabel(p.tier, !!p.is_priority),
        })),
      },
      needs_attention: {
        count: coolingPeople.length + overduePlaces.length,
        cooling_people: coolingPeople,
        overdue_places: overduePlaces,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
