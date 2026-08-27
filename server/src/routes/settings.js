// The Settings page's API: read the whole tunable catalogue with the values
// currently in effect, save changes, put things back to their defaults.
//
// There's no per-tunable endpoint on purpose. The page saves a batch, and
// services/settings.js validates the batch as a unit so that cross-field
// rules (high capacity must start above medium, and so on) are checked
// against what the settings would actually BE after the save rather than
// one field at a time.
const express = require('express');
const knex = require('../db/knex');
const { getSettingsView, saveSettings, resetSettings } = require('../services/settings');
const { coverageReport } = require('../services/matrixCache');
const { queueHealth } = require('../services/backfillQueue');

const router = express.Router();

// GET /api/settings/distance-cache - read-only diagnostic for the "Distance
// Cache Fallback" group (checkpoint 5): how complete the real-road-distance
// cache is, and the incremental backfill queue's own health. Not a tunable
// (nothing here has a value to save), so it's its own endpoint rather than
// folded into the values/catalogue shape GET / and PUT / share.
router.get('/distance-cache', async (req, res, next) => {
  try {
    const places = await knex('places').whereNotNull('lat').whereNotNull('lng').select('id');
    const [coverage, queue] = await Promise.all([
      coverageReport(knex, places),
      queueHealth(knex),
    ]);
    res.json({ coverage, queue });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings - the catalogue (sections, groups, help text, bounds),
// the value in effect for every tunable, the shipped default for each, and
// who last changed the ones that have been changed. One request, because the
// page is useless without all four.
router.get('/', async (req, res, next) => {
  try {
    res.json(await getSettingsView());
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/values - just the values currently in effect, keyed by
// tunable. The full catalogue above is only useful to the Settings page
// itself; screens that merely need to RESPECT a tunable (RoutePlanner's
// planning bounds, say) want the numbers and nothing else.
router.get('/values', async (req, res, next) => {
  try {
    const { values } = await getSettingsView();
    res.json(values);
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings - save a batch of changes. Body is { values: { key: value } }.
// All-or-nothing: a single rejected value fails the whole request with a
// message written for the person who typed it, and nothing is written.
router.put('/', async (req, res, next) => {
  try {
    const values = req.body && req.body.values;
    if (!values || typeof values !== 'object') return res.status(400).json({ error: 'values is required' });
    await saveSettings(values, req.user && req.user.id);
    res.json(await getSettingsView());
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// POST /api/settings/reset - back to the shipped defaults. Body { keys: [...] }
// resets just those; an empty/absent keys array resets everything.
router.post('/reset', async (req, res, next) => {
  try {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
    await resetSettings(keys);
    res.json(await getSettingsView());
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
