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

    const [todaysRoute, completedThisWeek, neverVisited, totals, departedContacts, coolingContacts, nextVisitRows] =
      await Promise.all([
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

        // Needs attention: turnover (departed contacts)...
        knex('contacts as c')
          .join('partners as p', 'p.id', 'c.partner_id')
          .where('c.departed', true)
          .orderBy('p.name', 'asc')
          .select('c.id as contact_id', 'c.name as contact_name', 'c.partner_id', 'p.name as partner_name'),

        // ...cooling relationships (dormant/cold contacts, not already departed)...
        knex('contacts as c')
          .join('partners as p', 'p.id', 'c.partner_id')
          .where('c.departed', false)
          .whereIn('c.relationship_temp', ['dormant', 'cold'])
          .orderBy('p.name', 'asc')
          .select(
            'c.id as contact_id',
            'c.name as contact_name',
            'c.relationship_temp',
            'c.partner_id',
            'p.name as partner_name'
          ),

        // ...and every visit that has a next_visit_date on file, so we can find overdue ones.
        knex('visits as v')
          .join('partners as p', 'p.id', 'v.partner_id')
          .whereNotNull('v.next_visit_date')
          .orderBy('v.partner_id')
          .orderBy('v.scheduled_date', 'desc')
          .orderBy('v.id', 'desc')
          .select(
            'v.partner_id',
            'v.next_visit_date',
            'p.name',
            'p.category',
            'p.tier',
            'p.is_priority',
            'p.city',
            'p.zip'
          ),
      ]);

    // Keep only each partner's most recent next_visit_date, then filter to overdue ones.
    const latestNextVisitByPartner = {};
    for (const r of nextVisitRows) if (!(r.partner_id in latestNextVisitByPartner)) latestNextVisitByPartner[r.partner_id] = r;
    const overduePartners = Object.values(latestNextVisitByPartner)
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
        total_partners: Number(totals.c),
        partners: neverVisited.map((p) => ({
          ...p,
          is_priority: !!p.is_priority,
          priority_label: priorityLabel(p.tier, !!p.is_priority),
        })),
      },
      needs_attention: {
        count: departedContacts.length + coolingContacts.length + overduePartners.length,
        departed_contacts: departedContacts,
        cooling_contacts: coolingContacts,
        overdue_partners: overduePartners,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
