const express = require('express');
const knex = require('../db/knex');
const { generateSchedule, loadRoute, capacityFor } = require('../services/scheduler');

const router = express.Router();

// GET /api/schedule?date=YYYY-MM-DD&userId= — the route for a given day.
router.get('/', async (req, res, next) => {
  try {
    const { date, userId } = req.query;
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    const route = await loadRoute(knex, date, userId ? Number(userId) : undefined);
    res.json(route);
  } catch (err) {
    next(err);
  }
});

// POST /api/schedule/generate — auto-build a ~4hr clustered, priority-ordered route.
// Body: { date, userId, hours?, visitMinutes?, travelMinutes?, regenerate? }
router.post('/generate', async (req, res, next) => {
  try {
    const { date, userId, hours, visitMinutes, travelMinutes, regenerate } = req.body;
    if (!date) return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
    const route = await generateSchedule({
      date,
      userId: userId ? Number(userId) : undefined,
      hours: hours ? Number(hours) : undefined,
      visitMinutes: visitMinutes ? Number(visitMinutes) : undefined,
      travelMinutes: travelMinutes ? Number(travelMinutes) : undefined,
      regenerate: !!regenerate,
    });
    res.json({
      capacity: capacityFor({ hours, visitMinutes, travelMinutes }),
      count: route.length,
      route,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/schedule/reorder — persist a manual reorder / swap of the day's stops.
// Body: { orderedVisitIds: [id, id, ...] }
router.patch('/reorder', async (req, res, next) => {
  try {
    const { orderedVisitIds } = req.body;
    if (!Array.isArray(orderedVisitIds)) {
      return res.status(400).json({ error: 'orderedVisitIds must be an array of visit ids' });
    }
    await knex.transaction(async (trx) => {
      for (let i = 0; i < orderedVisitIds.length; i += 1) {
        await trx('visits').where({ id: orderedVisitIds[i] }).update({ sort_order: i, updated_at: trx.fn.now() });
      }
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
