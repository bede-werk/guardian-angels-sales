// Service-level tests for the Visits tab's query engine. Unlike
// routes/visits.test.js, no require-cache substitution trick is needed here:
// visitQuery.js takes `db` as an explicit parameter rather than requiring
// the module-level ../db/knex singleton, so a plain in-memory sqlite
// instance can be passed straight in.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');

const { parseVisitListParams, listVisits, summarizeVisits } = require('./visitQuery');

const testKnex = knexLib({
  client: 'better-sqlite3',
  connection: { filename: ':memory:' },
  useNullAsDefault: true,
  migrations: { directory: path.join(__dirname, '..', 'migrations') },
});

describe('visitQuery', () => {
  before(async () => {
    await testKnex.migrate.latest();

    await testKnex('users').insert([
      { id: 1, name: 'Rep A', email: 'a@test.local' },
      { id: 2, name: 'Rep B', email: 'b@test.local' },
    ]);

    await testKnex('places').insert([
      { id: 1, name: 'Tabitha Hospice', category: 'Hospice', tier: 1, region: 'North', priority_score: 90 },
      { id: 2, name: 'Sunrise Clinic', category: 'Physicians', tier: 2, region: 'South', priority_score: 50 },
    ]);

    await testKnex('people').insert([
      { id: 1, place_id: 1, name: 'Dana Ruiz' },
      { id: 2, place_id: 2, name: 'Sam Lee' },
    ]);

    // v1: completed at place 1, encounter with person 1, outcome substantive,
    // they_requested true, made a commitment. Explicit ids throughout this
    // fixture set (rather than relying on .returning('id')) since every row
    // needs to be cross-referenced by a stable number below.
    await testKnex('visits').insert({
      id: 1, place_id: 1, place_name: 'Tabitha Hospice', user_id: 1, created_by_user_id: 1,
      status: 'completed', scheduled_date: '2026-01-05', notes: 'good visit', visit_type: 'check_in',
    });
    await testKnex('visit_encounters').insert({
      visit_id: 1, person_id: 1, person_name: 'Dana Ruiz', met_with_type: 'named_person', outcome: 'substantive', they_requested: true,
    });
    await testKnex('place_commitments').insert({ place_id: 1, promised_date: '2026-02-01', source_visit_id: 1 });

    // v2: completed at place 2, encounter with receptionist, outcome brief.
    await testKnex('visits').insert({
      id: 2, place_id: 2, place_name: 'Sunrise Clinic', user_id: 2, created_by_user_id: 2,
      status: 'completed', scheduled_date: '2026-01-10', visit_type: 'drop_in',
    });
    await testKnex('visit_encounters').insert({
      visit_id: 2, met_with_type: 'receptionist', outcome: 'brief', they_requested: false,
    });

    // v3: skipped at place 1, no encounters.
    await testKnex('visits').insert({
      id: 3, place_id: 1, place_name: 'Tabitha Hospice', user_id: 1, created_by_user_id: 1,
      status: 'skipped', scheduled_date: '2026-01-15',
    });

    // v4: planned (future), manually planned, at place 2.
    await testKnex('visits').insert({
      id: 4, place_id: 2, place_name: 'Sunrise Clinic', user_id: 2, created_by_user_id: 1,
      status: 'planned', scheduled_date: '2099-01-01', planned_manually: 1, source: 'manual',
    });

    // v5: snoozed, place 1.
    await testKnex('visits').insert({
      id: 5, place_id: 1, place_name: 'Tabitha Hospice', user_id: 2, created_by_user_id: 2,
      status: 'snoozed', scheduled_date: '2026-01-20', snoozed_until: '2026-02-20',
    });

    // v6: DETACHED - place_id NULL, only the durable place_name snapshot survives.
    await testKnex('visits').insert({
      id: 6, place_id: null, place_name: 'Deleted Place LLC', user_id: 1, created_by_user_id: 1,
      status: 'completed', scheduled_date: '2026-01-25',
    });

    // v7/v8/v9/v10: four more completed visits at place 1, same date, for
    // pagination/tiebreak testing (ids 7-10, ascending).
    for (let i = 7; i <= 10; i++) {
      await testKnex('visits').insert({
        id: i, place_id: 1, place_name: 'Tabitha Hospice', user_id: 1, created_by_user_id: 1,
        status: 'completed', scheduled_date: '2026-03-01',
      });
    }
  });

  after(async () => {
    await testKnex.destroy();
  });

  describe('parseVisitListParams (pure)', () => {
    test('defaults when nothing is passed', () => {
      const p = parseVisitListParams({});
      assert.equal(p.sort, 'date_desc');
      assert.equal(p.limit, 50);
      assert.equal(p.offset, 0);
      assert.equal(p.status, null);
    });

    test('treats empty-string params as absent', () => {
      const p = parseVisitListParams({ search: '', category: '', status: '' });
      assert.equal(p.search, null);
      assert.equal(p.category, null);
      assert.equal(p.status, null);
    });

    test('clamps limit above the max down to 200', () => {
      assert.equal(parseVisitListParams({ limit: '9999' }).limit, 200);
    });

    test('clamps limit below 1 up to 1', () => {
      assert.equal(parseVisitListParams({ limit: '0' }).limit, 1);
      assert.equal(parseVisitListParams({ limit: '-5' }).limit, 1);
    });

    test('rejects a malformed from date', () => {
      assert.throws(() => parseVisitListParams({ from: '01/05/2026' }), /YYYY-MM-DD/);
    });

    test('rejects an unknown status', () => {
      assert.throws(() => parseVisitListParams({ status: 'bogus' }), /Unknown status/);
    });

    test('rejects an unknown sort', () => {
      assert.throws(() => parseVisitListParams({ sort: 'bogus' }), /Unknown sort/);
    });

    test('normalizes a comma-separated status list, de-duplicated', () => {
      const p = parseVisitListParams({ status: 'planned,skipped,planned' });
      assert.deepEqual(p.status, ['planned', 'skipped']);
    });
  });

  describe('listVisits filters', () => {
    async function ids(overrides) {
      const { visits } = await listVisits(testKnex, parseVisitListParams(overrides));
      return visits.map((v) => v.id);
    }

    test('no filters returns every visit', async () => {
      const { total } = await listVisits(testKnex, parseVisitListParams({}));
      assert.equal(total, 10);
    });

    test('status filter', async () => {
      assert.deepEqual((await ids({ status: 'skipped' })).sort((a, b) => a - b), [3]);
    });

    test('a snoozed visit is listable', async () => {
      assert.deepEqual(await ids({ status: 'snoozed' }), [5]);
    });

    test('date range filter is inclusive', async () => {
      assert.deepEqual((await ids({ from: '2026-01-10', to: '2026-01-20' })).sort((a, b) => a - b), [2, 3, 5]);
    });

    test('userId filters to the assignee', async () => {
      assert.deepEqual((await ids({ userId: 2 })).sort((a, b) => a - b), [2, 4, 5]);
    });

    test('plannedBy filters to created_by_user_id (distinct from the assignee)', async () => {
      // v4 is assigned to Rep B (user_id 2) but planned BY Rep A (created_by_user_id 1).
      assert.deepEqual(await ids({ plannedBy: 1, status: 'planned' }), [4]);
    });

    test('category/tier/region filter on the joined place', async () => {
      assert.deepEqual((await ids({ category: 'Physicians' })).sort((a, b) => a - b), [2, 4]);
      assert.deepEqual((await ids({ tier: 1, status: 'completed' })).sort((a, b) => a - b), [1, 7, 8, 9, 10]);
      assert.deepEqual((await ids({ region: 'South' })).sort((a, b) => a - b), [2, 4]);
    });

    test('a detached visit (place_id NULL) appears unfiltered but drops out under a category filter', async () => {
      assert.ok((await ids({ status: 'completed' })).includes(6));
      assert.ok(!(await ids({ category: 'Hospice' })).includes(6));
    });

    test('origin: manual vs planner', async () => {
      assert.deepEqual(await ids({ origin: 'manual' }), [4]);
      const planner = await ids({ origin: 'planner' });
      assert.ok(!planner.includes(4));
      assert.ok(planner.includes(1));
    });

    test('hasNotes', async () => {
      assert.deepEqual(await ids({ hasNotes: '1' }), [1]);
    });

    test('madeCommitment', async () => {
      assert.deepEqual(await ids({ madeCommitment: '1' }), [1]);
    });

    test('search matches place name, notes, and encounter person name', async () => {
      // 'tabitha' alone legitimately matches every visit at that place
      // (1, 3, 5, 7, 8, 9, 10), not just v1 - this is place-NAME matching,
      // exercised on its own further down via notes/person instead.
      assert.deepEqual((await ids({ search: 'tabitha' })).sort((a, b) => a - b), [1, 3, 5, 7, 8, 9, 10]);
      assert.deepEqual(await ids({ search: 'good visit' }), [1]); // notes match, unique to v1
      assert.deepEqual(await ids({ search: 'dana' }), [1]); // encounter person_name match, unique to v1
    });

    describe('encounter filters do not fan out rows', () => {
      before(async () => {
        // Give v1 two MORE encounters so it has 3 total - if outcome/metWith
        // filtering used a join instead of whereExists, this trip would
        // wrongly appear 3 times (or more) in the result instead of once.
        await testKnex('people').insert([{ id: 3, place_id: 1, name: 'Extra Person' }]);
        await testKnex('visit_encounters').insert([
          { visit_id: 1, person_id: 3, person_name: 'Extra Person', met_with_type: 'named_person', outcome: 'substantive' },
          { visit_id: 1, met_with_type: 'staff', outcome: 'substantive' },
        ]);
      });

      test('outcome filter returns the trip exactly once despite 3 matching encounters', async () => {
        const { visits, total } = await listVisits(testKnex, parseVisitListParams({ outcome: 'substantive' }));
        const matches = visits.filter((v) => v.id === 1);
        assert.equal(matches.length, 1);
        assert.equal(total, 1);
      });

      test('personId filter still returns one row', async () => {
        assert.deepEqual((await ids({ personId: 1 })), [1]);
      });

      test('metWith filter still returns one row', async () => {
        assert.deepEqual((await ids({ metWith: 'staff' })), [1]);
      });

      test('theyRequested filter still returns one row', async () => {
        assert.deepEqual((await ids({ theyRequested: '1' })), [1]);
      });
    });

    test('combined filters AND together', async () => {
      // completed AND tier 1 AND region North -> only place 1's completed visits.
      const result = (await ids({ status: 'completed', tier: 1, region: 'North' })).sort((a, b) => a - b);
      assert.deepEqual(result, [1, 7, 8, 9, 10]);
    });
  });

  describe('pagination and sort stability', () => {
    test('offset=0/limit=2 and offset=2/limit=2 are disjoint and together cover the first 4 in order', async () => {
      const params = parseVisitListParams({ status: 'completed', tier: 1, region: 'North', sort: 'date_asc', limit: 2, offset: 0 });
      const page1 = (await listVisits(testKnex, params)).visits.map((v) => v.id);
      const page2 = (await listVisits(testKnex, { ...params, offset: 2 })).visits.map((v) => v.id);
      assert.equal(page1.length, 2);
      assert.equal(page2.length, 2);
      assert.deepEqual(page1.filter((id) => page2.includes(id)), []);

      const whole = (await listVisits(testKnex, { ...params, limit: 4, offset: 0 })).visits.map((v) => v.id);
      assert.deepEqual([...page1, ...page2], whole);
    });
  });

  describe('summarizeVisits', () => {
    test('total equals the sum of the four status counts', async () => {
      const s = await summarizeVisits(testKnex, parseVisitListParams({}));
      assert.equal(s.total, s.planned + s.completed + s.skipped + s.snoozed);
      assert.equal(s.total, 10);
    });

    test('summary ignores the status filter while listVisits total respects it', async () => {
      const params = parseVisitListParams({ status: 'completed' });
      const { total } = await listVisits(testKnex, params);
      const summary = await summarizeVisits(testKnex, params);
      assert.equal(total, 7); // completed: 1, 2, 6, 7, 8, 9, 10
      assert.ok(summary.skipped > 0, 'summary must still report skipped visits even though the list is filtered to completed');
      assert.ok(summary.snoozed > 0, 'summary must still report snoozed visits even though the list is filtered to completed');
    });

    test('places counts distinct non-null place_id', async () => {
      const s = await summarizeVisits(testKnex, parseVisitListParams({}));
      assert.equal(s.places, 2); // places 1 and 2 - the detached visit (place_id NULL) doesn't count
    });
  });
});
