const express = require('express');
const dayjs = require('dayjs');
const isoWeek = require('dayjs/plugin/isoWeek');
const knex = require('../db/knex');
const { loadRoute } = require('../services/scheduler');
const { priorityLabel } = require('../services/priority');

dayjs.extend(isoWeek);

const router = express.Router();

// GET /api/dashboard?userId=&date=YYYY-MM-DD
// Returns: today's route, count/list of visits completed this week, and never-visited partners.
router.get('/', async (req, res, next) => {
  try {
    const userId = req.query.userId ? Number(req.query.userId) : undefined;
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    // This (ISO) week's Monday..Sunday window, compared against scheduled_date.
    const weekStart = dayjs(date).isoWeekday(1).format('YYYY-MM-DD');
    const weekEnd = dayjs(date).isoWeekday(7).format('YYYY-MM-DD');

    const [todaysRoute, completedThisWeek, neverVisited, totals] = await Promise.all([
      loadRoute(knex, date, userId),

      knex('visits as v')
        .join('partners as p', 'p.id', 'v.partner_id')
        .where('v.status', 'completed')
        .whereBetween('v.scheduled_date', [weekStart, weekEnd])
        .modify((qb) => userId && qb.andWhere('v.user_id', userId))
        .orderBy('v.scheduled_date', 'desc')
        .select('v.id as visit_id', 'v.scheduled_date', 'v.outcome', 'p.name', 'p.city', 'p.tier'),

      // Never visited = no *completed* visit yet (a partner only planned still counts
      // as not-yet-visited, so they stay on the prospecting list until the call is done).
      knex('partners as p')
        .whereNotIn('p.id', knex('visits').where('status', 'completed').select('partner_id'))
        .orderBy('p.priority_score', 'desc')
        .orderBy('p.name', 'asc')
        .select('p.id', 'p.name', 'p.category', 'p.tier', 'p.is_priority', 'p.city', 'p.zip', 'p.region'),

      knex('partners').count({ c: '*' }).first(),
    ]);

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
        total_partners: Number(totals.c),
        partners: neverVisited.map((p) => ({
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
