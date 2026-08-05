// The dashboard is one big "rollup" endpoint: it runs several independent
// queries in parallel (Promise.all) and stitches the results into one JSON
// response, so the frontend can render the whole dashboard from a single request.
const express = require('express');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek'); // adds Monday-start-of-week helpers to dayjs
const knex = require('../db/knex');
const { priorityLabel } = require('../services/priority');
const { attachEncounters } = require('../services/visitEncounters');

dayjs.extend(isoWeek);

const router = express.Router();

// GET /api/dashboard?userId=&date=YYYY-MM-DD
// Returns: visits completed this week, and never-visited places.
router.get('/', async (req, res, next) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    // This (ISO) week's Monday..Sunday window, compared against scheduled_date.
    const weekStart = dayjs(date).isoWeekday(1).format('YYYY-MM-DD');
    const weekEnd = dayjs(date).isoWeekday(7).format('YYYY-MM-DD');

    const [completedThisWeek, neverVisited, totals] =
      await Promise.all([
        // One row per completed TRIP. This used to be one row per encounter,
        // which counted a visit where the rep met three people as three
        // visits — "12 visits this week" has to mean twelve times a rep drove
        // somewhere, not twelve conversations.
        //
        // No `outcome` column: a trip now has one per person met, so a single
        // field for it can only ever be a lie. The lightweight `encounters`
        // summary attached below is what the card shows instead.
        //
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
      ]);

    // One extra query for the week's trips, grouped in JS — never one per row.
    // Sequenced after the Promise.all rather than inside it because it needs
    // the visit ids that query returns.
    const completedWithEncounters = await attachEncounters(knex, completedThisWeek, { idKey: 'visit_id' });

    res.json({
      date,
      week: { start: weekStart, end: weekEnd },
      completed_this_week: {
        count: completedWithEncounters.length,
        visits: completedWithEncounters,
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
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
