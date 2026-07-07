// The dashboard is one big "rollup" endpoint: it runs several independent
// queries in parallel (Promise.all) and stitches the results into one JSON
// response, so the frontend can render the whole dashboard from a single request.
const express = require('express');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek'); // adds Monday-start-of-week helpers to dayjs
const knex = require('../db/knex');
const { loadRoute } = require('../services/scheduler');
const { priorityLabel } = require('../services/priority');

dayjs.extend(isoWeek);

const router = express.Router();

// GET /api/dashboard?userId=&date=YYYY-MM-DD
// Returns: today's route, visits completed this week, never-visited places,
// and a "needs attention" rollup (departed/cooling contacts + overdue visits).
router.get('/', async (req, res, next) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    // This (ISO) week's Monday..Sunday window, compared against scheduled_date.
    const weekStart = dayjs(date).isoWeekday(1).format('YYYY-MM-DD');
    const weekEnd = dayjs(date).isoWeekday(7).format('YYYY-MM-DD');

    const [todaysRoute, completedThisWeek, neverVisited, totals, departedContacts, coolingContacts, nextVisitRows] =
      await Promise.all([
        loadRoute(knex, date, userId),

        knex('visits as v')
          .join('places as p', 'p.id', 'v.place_id')
          .where('v.status', 'completed')
          .whereBetween('v.scheduled_date', [weekStart, weekEnd])
          .modify((qb) => userId && qb.andWhere('v.user_id', userId))
          .orderBy('v.scheduled_date', 'desc')
          .select('v.id as visit_id', 'v.scheduled_date', 'v.outcome', 'p.name', 'p.city', 'p.tier'),

        // Never visited = no *completed* visit yet (a place only planned still counts
        // as not-yet-visited, so they stay on the prospecting list until the call is done).
        knex('places as p')
          .whereNotIn('p.id', knex('visits').where('status', 'completed').select('place_id'))
          .orderBy('p.priority_score', 'desc')
          .orderBy('p.name', 'asc')
          .select('p.id', 'p.name', 'p.category', 'p.tier', 'p.is_priority', 'p.city', 'p.zip', 'p.region'),

        knex('places').count({ c: '*' }).first(),

        // Needs attention: turnover (departed contacts)...
        knex('contacts as c')
          .join('places as p', 'p.id', 'c.place_id')
          .where('c.departed', true)
          .orderBy('p.name', 'asc')
          .select('c.id as contact_id', 'c.name as contact_name', 'c.place_id', 'p.name as place_name'),

        // ...cooling relationships (dormant/cold contacts, not already departed)...
        knex('contacts as c')
          .join('places as p', 'p.id', 'c.place_id')
          .where('c.departed', false)
          .whereIn('c.relationship_temp', ['dormant', 'cold'])
          .orderBy('p.name', 'asc')
          .select(
            'c.id as contact_id',
            'c.name as contact_name',
            'c.relationship_temp',
            'c.place_id',
            'p.name as place_name'
          ),

        // ...and every visit that has a next_visit_date on file, so we can find overdue ones.
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
      today: {
        count: todaysRoute.length,
        planned: todaysRoute.filter((v) => v.status === 'planned').length,
        completed: todaysRoute.filter((v) => v.status === 'completed').length,
        route: todaysRoute,
      },
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
        count: departedContacts.length + coolingContacts.length + overduePlaces.length,
        departed_contacts: departedContacts,
        cooling_contacts: coolingContacts,
        overdue_places: overduePlaces,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
