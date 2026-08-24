// Route-level test for GET /api/dashboard's five sections. Same in-memory
// sqlite harness as routes/visits.test.js — see that file's header for why
// the require cache has to be pre-populated before the router is required
// (every route/service does `require('../db/knex')` at module load; there's
// no injectable db param).
//
// What's worth testing at this level rather than in
// services/dashboardMetrics.test.js: the SQL-shaped decisions the pure
// helpers can't see — rep scoping (today/this week are per-rep; commitments
// and referrals are org-wide on purpose), the ordering fix for nullable
// referral_date, discharged commitments staying out, and detach-not-delete
// rows surviving with a null place.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const express = require('express');

const dbKnexPath = require.resolve('../db/knex');
const testKnex = knexLib({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  migrations: { directory: path.join(__dirname, '..', 'migrations') },
});
testKnex.extractId = (row) => (row && row.id ? row.id : row);

require.cache[dbKnexPath] = {
  id: dbKnexPath,
  filename: dbKnexPath,
  loaded: true,
  exports: testKnex,
};

const dashboardRouter = require('./dashboard');
const dashboardConfig = require('../config/dashboard');

// The date every request in this file asks for. Deliberately in the future so
// visitLifecycle.js's skipSweepMiddleware — which this router mounts and
// which compares against the REAL wall clock, not this date — can never lapse
// a fixture's 'planned' row into 'skipped' mid-test.
const TODAY = '2099-06-17'; // a Wednesday
const WEEK_START = '2099-06-15'; // Monday
const WEEK_END = '2099-06-21'; // Sunday

// Two Lincoln, NE points about four miles apart — far enough that the
// haversine estimate is comfortably above MIN_DRIVE_MINUTES.
const DOWNTOWN = { lat: 40.8136, lng: -96.7026 };
const EAST = { lat: 40.814, lng: -96.62 };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(async (req, res, next) => {
    const userId = Number(req.headers['x-test-user-id']);
    if (!Number.isInteger(userId)) return res.status(401).json({ error: 'Not authenticated' });
    req.user = await testKnex('users').where({ id: userId }).first();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    next();
  });
  app.use('/api/dashboard', dashboardRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(500).json({ error: err.message || 'Internal server error' }));
  return app;
}

describe('GET /api/dashboard', () => {
  let server;
  let baseUrl;

  before(async () => {
    await testKnex.migrate.latest();
    await testKnex('users').insert([
      { id: 1, name: 'Rep A', email: 'a@test.local' },
      { id: 2, name: 'Rep B', email: 'b@test.local' },
    ]);
    await testKnex('places').insert([
      { id: 1, name: 'Alpha Hospice', category: 'Hospice', city: 'Lincoln', lat: DOWNTOWN.lat, lng: DOWNTOWN.lng },
      { id: 2, name: 'Beta Clinic', category: 'Physicians', city: 'Lincoln', lat: EAST.lat, lng: EAST.lng },
      { id: 3, name: 'Gamma Home', category: 'Assisted Living', city: 'Waverly' }, // deliberately ungeocoded
    ]);
    await testKnex('people').insert([
      { id: 1, name: 'Dana Ortiz', title: 'DON', place_id: 1 },
      { id: 2, name: 'Chris Webb', title: 'Social Worker', place_id: 2 },
    ]);

    const app = buildApp();
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await testKnex.destroy();
  });

  // Every test starts from a clean slate on the tables it writes to, so one
  // section's fixtures can't quietly change another section's counts.
  beforeEach(async () => {
    await testKnex('visit_encounters').del();
    await testKnex('visits').del();
    await testKnex('place_commitments').del();
    await testKnex('referrals').del();
  });

  function get(userId = 1, date = TODAY) {
    return fetch(`${baseUrl}/api/dashboard?userId=${userId}&date=${date}`, {
      headers: { 'x-test-user-id': String(userId) },
    }).then(async (res) => {
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      return res.json();
    });
  }

  const visit = (over = {}) => ({
    place_id: 1, place_name: 'Alpha Hospice', user_id: 1, status: 'planned', scheduled_date: TODAY, sort_order: 0, ...over,
  });

  // ------------------------------------------------------------ 1. today

  describe('today', () => {
    test('is empty and does not throw on a day with nothing scheduled', async () => {
      const body = await get();
      assert.equal(body.today.total, 0);
      assert.equal(body.today.first_stop, null);
      assert.equal(body.today.next_stop, null);
      assert.equal(body.today.drive.minutes, 0);
      assert.equal(body.today.drive.label, '0m');
    });

    test('counts by status and orders the route by sort_order', async () => {
      await testKnex('visits').insert([
        visit({ place_id: 2, place_name: 'Beta Clinic', sort_order: 1 }),
        visit({ place_id: 1, sort_order: 0, status: 'completed' }),
        visit({ place_id: 3, place_name: 'Gamma Home', sort_order: 2, status: 'skipped' }),
      ]);
      const body = await get();
      assert.deepEqual(body.today.counts, { planned: 1, completed: 1, skipped: 1, snoozed: 0 });
      assert.equal(body.today.total, 3);
      // The skipped stop is not part of the route: the rep never drove there.
      assert.deepEqual(body.today.route.map((r) => r.name), ['Alpha Hospice', 'Beta Clinic']);
    });

    test('first_stop is the route start; next_stop appears only once it is a different stop', async () => {
      await testKnex('visits').insert([visit({ sort_order: 0 }), visit({ place_id: 2, place_name: 'Beta Clinic', sort_order: 1 })]);

      // Nothing logged yet — the first stop IS the next one, so next_stop is
      // suppressed rather than repeating it.
      let body = await get();
      assert.equal(body.today.first_stop.name, 'Alpha Hospice');
      assert.equal(body.today.next_stop, null);

      // Once stop one is logged, "where do I go next" has a different answer.
      await testKnex('visits').where({ place_id: 1 }).update({ status: 'completed' });
      body = await get();
      assert.equal(body.today.first_stop.name, 'Alpha Hospice');
      assert.equal(body.today.next_stop.name, 'Beta Clinic');
    });

    test('drive time is measured between stops and flags ungeocoded ones', async () => {
      await testKnex('visits').insert([
        visit({ place_id: 1, sort_order: 0 }),
        visit({ place_id: 2, place_name: 'Beta Clinic', sort_order: 1 }),
        visit({ place_id: 3, place_name: 'Gamma Home', sort_order: 2 }),
      ]);
      const body = await get();
      assert.ok(body.today.drive.minutes > 0, 'two geocoded stops should produce a real estimate');
      assert.equal(body.today.drive.legs, 1, 'three stops, one of them ungeocoded, is one measurable leg');
      assert.equal(body.today.drive.ungeocoded_stops, 1);
      assert.match(body.today.drive.label, /^\d+m$|^\d+h/);
    });

    test('is scoped to the requesting rep', async () => {
      await testKnex('visits').insert([visit({ user_id: 1 }), visit({ place_id: 2, place_name: 'Beta Clinic', user_id: 2 })]);
      assert.equal((await get(1)).today.total, 1);
      assert.equal((await get(2)).today.total, 1);
    });

    // detach-not-delete: a completed visit outlives its place, and only
    // v.place_name survives to name it.
    test('a detached visit still shows its snapshot name', async () => {
      await testKnex('visits').insert(visit({ place_id: null, place_name: 'Deleted Place', status: 'completed' }));
      const body = await get();
      assert.equal(body.today.route[0].name, 'Deleted Place');
      assert.equal(body.today.route[0].city, null);
    });
  });

  // -------------------------------------------------------- 2. this week

  describe('this_week', () => {
    test('spans Monday to Sunday and buckets every day', async () => {
      const body = await get();
      assert.equal(body.this_week.start, WEEK_START);
      assert.equal(body.this_week.end, WEEK_END);
      assert.equal(body.this_week.days.length, 7);
    });

    test('counts statuses and distinct places visited', async () => {
      await testKnex('visits').insert([
        visit({ place_id: 1, scheduled_date: WEEK_START, status: 'completed' }),
        visit({ place_id: 1, scheduled_date: '2099-06-16', status: 'completed' }), // same place twice
        visit({ place_id: 2, place_name: 'Beta Clinic', scheduled_date: '2099-06-16', status: 'completed' }),
        visit({ place_id: 3, place_name: 'Gamma Home', scheduled_date: WEEK_END, status: 'planned' }),
      ]);
      const body = await get();
      assert.equal(body.this_week.completed, 3);
      assert.equal(body.this_week.planned, 1);
      assert.equal(body.this_week.places_visited, 2, 'the same place visited twice is one place');
      assert.equal(body.this_week.days[0].completed, 1);
      assert.equal(body.this_week.days[1].completed, 2);
    });

    test('excludes visits outside the week', async () => {
      await testKnex('visits').insert([
        visit({ scheduled_date: '2099-06-14', status: 'completed' }), // the Sunday before
        visit({ scheduled_date: '2099-06-22', status: 'planned' }), // the Monday after
      ]);
      const body = await get();
      assert.equal(body.this_week.total, 0);
    });
  });

  // -------------------------------------------------- 3. commitments due

  describe('commitments_due', () => {
    const commitment = (over = {}) => ({ place_id: 1, promised_date: TODAY, ...over });

    test('includes overdue commitments with a negative days_out', async () => {
      await testKnex('place_commitments').insert(commitment({ promised_date: '2099-06-01' }));
      const body = await get();
      assert.equal(body.commitments_due.count, 1);
      assert.equal(body.commitments_due.overdue_count, 1);
      assert.equal(body.commitments_due.items[0].days_out, -16);
    });

    test('includes commitments inside the horizon and excludes ones beyond it', async () => {
      const { COMMITMENT_HORIZON_DAYS } = dashboardConfig;
      await testKnex('place_commitments').insert([
        commitment({ promised_date: '2099-06-20' }), // 3 days out
        commitment({ place_id: 2, promised_date: '2099-12-31' }), // far beyond any sane horizon
      ]);
      const body = await get();
      assert.equal(body.commitments_due.horizon_days, COMMITMENT_HORIZON_DAYS);
      assert.equal(body.commitments_due.count, 1);
      assert.equal(body.commitments_due.items[0].days_out, 3);
      assert.equal(body.commitments_due.overdue_count, 0);
    });

    test('a discharged commitment is not due', async () => {
      await testKnex('place_commitments').insert([
        commitment({ discharged_at: new Date().toISOString(), discharge_reason: 'fulfilled' }),
        commitment({ place_id: 2, discharged_at: new Date().toISOString(), discharge_reason: 'waived' }),
      ]);
      const body = await get();
      assert.equal(body.commitments_due.count, 0);
    });

    test('is earliest-first and carries the place, person and suppression state', async () => {
      await testKnex('places').where({ id: 1 }).update({ snooze_until: '2099-12-01' });
      await testKnex('place_commitments').insert([
        commitment({ place_id: 2, promised_date: '2099-06-20', person_id: 2 }),
        commitment({ place_id: 1, promised_date: '2099-06-18', person_id: 1, note: 'promised the DON' }),
      ]);
      const body = await get();
      const [first, second] = body.commitments_due.items;
      assert.equal(first.promised_date, '2099-06-18');
      assert.equal(first.place_name, 'Alpha Hospice');
      assert.equal(first.person_name, 'Dana Ortiz');
      assert.equal(first.note, 'promised the DON');
      assert.equal(first.snooze_until, '2099-12-01', 'the card needs this to flag the contradiction');
      assert.equal(second.promised_date, '2099-06-20');
      await testKnex('places').where({ id: 1 }).update({ snooze_until: null });
    });

    // A commitment is place-level and cross-rep by design — narrowing it to
    // one rep would hide a promise the org made.
    test('is NOT scoped to the requesting rep', async () => {
      await testKnex('place_commitments').insert(commitment({ created_by_user_id: 1 }));
      assert.equal((await get(2)).commitments_due.count, 1);
    });
  });

  // ---------------------------------------------------- 4/5. referrals

  describe('referrals', () => {
    const daysAgo = (n) => {
      const d = new Date(Date.now() - n * 86400000);
      return d.toISOString().slice(0, 10);
    };

    test('lists the most recent referrals newest-first', async () => {
      await testKnex('referrals').insert([
        { person_id: 1, place_id: 1, referral_date: daysAgo(30) },
        { person_id: 2, place_id: 2, referral_date: daysAgo(1) },
        { person_id: 1, place_id: 1, referral_date: daysAgo(10) },
      ]);
      const body = await get();
      const dates = body.recent_referrals.items.map((r) => r.referral_date);
      assert.deepEqual(dates, [daysAgo(1), daysAgo(10), daysAgo(30)]);
      assert.equal(body.recent_referrals.items[0].person_name, 'Chris Webb');
      assert.equal(body.recent_referrals.items[0].place_name, 'Beta Clinic');
    });

    // referral_date is nullable, and a bare DESC sort disagrees across
    // engines about where NULLs go (last on SQLite, first on Postgres). The
    // COALESCE keeps undated rows at the bottom on both.
    test('an undated referral sorts last, not first', async () => {
      await testKnex('referrals').insert([
        { person_id: 1, place_id: 1, referral_date: null },
        { person_id: 2, place_id: 2, referral_date: daysAgo(5) },
      ]);
      const body = await get();
      assert.equal(body.recent_referrals.items[0].referral_date, daysAgo(5));
      assert.equal(body.recent_referrals.items[1].referral_date, null);
    });

    test('the window count only counts referrals inside the recent window', async () => {
      await testKnex('referrals').insert([
        { person_id: 1, place_id: 1, referral_date: daysAgo(5) },
        { person_id: 1, place_id: 1, referral_date: daysAgo(400) },
      ]);
      const body = await get();
      assert.equal(body.recent_referrals.window_count, 1);
    });

    test('the list is capped at the configured limit', async () => {
      const many = Array.from({ length: dashboardConfig.RECENT_REFERRALS_LIMIT + 5 }, (_, i) => ({
        person_id: 1, place_id: 1, referral_date: daysAgo(i + 1),
      }));
      await testKnex('referrals').insert(many);
      const body = await get();
      assert.equal(body.recent_referrals.items.length, dashboardConfig.RECENT_REFERRALS_LIMIT);
    });

    test('top partners rank by lifetime count and carry the recent figure', async () => {
      await testKnex('referrals').insert([
        { person_id: 1, place_id: 1, referral_date: daysAgo(5) },
        { person_id: 1, place_id: 1, referral_date: daysAgo(6) },
        { person_id: 1, place_id: 1, referral_date: daysAgo(400) },
        { person_id: 2, place_id: 2, referral_date: daysAgo(2) },
      ]);
      const body = await get();
      const [top, second] = body.top_referral_partners.items;
      assert.equal(top.person_name, 'Dana Ortiz');
      assert.equal(top.lifetime_referrals, 3);
      assert.equal(top.recent_referrals, 2, 'the 400-day-old one is outside the recent window');
      assert.equal(top.last_referral_date, daysAgo(5));
      assert.equal(top.place_name, 'Alpha Hospice');
      assert.equal(second.person_name, 'Chris Webb');
      assert.equal(second.lifetime_referrals, 1);
    });

    // person_id is SET NULL when a person is deleted (detach-not-delete), so
    // there is nobody left to credit — the row must drop out of the
    // leaderboard rather than appear as a nameless partner.
    test('a referral with no person is excluded from the leaderboard', async () => {
      await testKnex('referrals').insert([
        { person_id: null, place_id: 1, referral_date: daysAgo(1) },
        { person_id: 1, place_id: 1, referral_date: daysAgo(2) },
      ]);
      const body = await get();
      assert.equal(body.top_referral_partners.items.length, 1);
      assert.equal(body.top_referral_partners.items[0].person_name, 'Dana Ortiz');
    });

    test('a partner with no dated referrals reports a null last date, not an empty string', async () => {
      await testKnex('referrals').insert({ person_id: 1, place_id: 1, referral_date: null });
      const body = await get();
      assert.equal(body.top_referral_partners.items[0].last_referral_date, null);
    });
  });
});
