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
const { queueHealth, drainQueue } = require('../services/backfillQueue');
const { LocalOsrmProvider } = require('../services/localOsrmProvider');

const router = express.Router();

// GET /api/settings/distance-cache - read-only diagnostic for the "Distance
// Cache Fallback" group (checkpoint 5): how complete the real-road-distance
// cache is, and the incremental backfill queue's own health. Not a tunable
// (nothing here has a value to save), so it's its own endpoint rather than
// folded into the values/catalogue shape GET / and PUT / share.
router.get('/distance-cache', async (req, res, next) => {
  try {
    const places = await knex('places').whereNotNull('lat').whereNotNull('lng').select('id');
    const [coverage, queue, blocker] = await Promise.all([
      coverageReport(knex, places),
      queueHealth(knex),
      // The most recent error any queued place hit. Without this the panel
      // reads "pending, checked automatically in the background", which is
      // reassuring and wrong when every attempt is failing on the same
      // unconfigured path - retrying can't fix a configuration problem, and
      // the queue burns its attempt budget discovering that every 15 minutes.
      knex('backfill_queue').whereNotNull('last_error').orderBy('created_at', 'desc').select('last_error').first(),
    ]);
    res.json({ coverage, queue, lastError: blocker ? blocker.last_error : null, running: backfillInFlight });
  } catch (err) {
    next(err);
  }
});

// Guards against two drains at once: drainQueue spawns osrm-routed on a fixed
// port, so a second concurrent run would fail to bind and mark every queued
// place failed for a reason that isn't real.
let backfillInFlight = false;

// POST /api/settings/distance-cache/backfill - run the backfill now instead of
// waiting up to DRAIN_INTERVAL_MINUTES for the background worker. The point is
// immediate feedback: with OSRM unconfigured this returns the actual error in a
// second rather than failing silently in the background a quarter-hour later.
router.post('/distance-cache/backfill', async (req, res, next) => {
  if (backfillInFlight) return res.status(409).json({ error: 'A backfill is already running.' });
  backfillInFlight = true;
  try {
    const result = await drainQueue({ db: knex, provider: new LocalOsrmProvider() });
    const blocker = await knex('backfill_queue').whereNotNull('last_error').orderBy('created_at', 'desc').select('last_error').first();
    res.json({ ...result, lastError: blocker ? blocker.last_error : null });
  } catch (err) {
    next(err);
  } finally {
    backfillInFlight = false;
  }
});

// POST /api/settings/distance-cache/requeue - put permanently-failed places
// back in the queue with a clean attempt count.
//
// A place is retired after MAX_ATTEMPTS, which is right for a bad geocode that
// genuinely can't be routed - but wrong for an outage or an unconfigured OSRM
// path, where every attempt was spent on a problem that had nothing to do with
// the place. Once the underlying cause is fixed there has to be a way back in,
// or the only route is editing the address to re-trigger onPlaceGeocoded.
router.post('/distance-cache/requeue', async (req, res, next) => {
  try {
    const requeued = await knex('backfill_queue')
      .whereNotNull('failed_at')
      .update({ failed_at: null, attempts: 0, last_error: null, next_attempt_at: Date.now() });
    res.json({ requeued });
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
