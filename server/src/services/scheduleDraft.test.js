const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const { mergeLockedElsewhereIds, partitionCommittableStops, validateDays, deleteCommittedDay, buildCandidatePool, loadDraftView, loadDraftDayView, MAX_PLAN_DATES, MAX_DAYS_AHEAD } = require('./scheduleDraft');

describe('mergeLockedElsewhereIds', () => {
  test('unions committed and other-draft rows', () => {
    const result = mergeLockedElsewhereIds({
      committedRows: [{ place_id: 1 }],
      otherDraftRows: [{ place_id: 2 }],
    });
    assert.deepEqual([...result].sort(), [1, 2]);
  });

  test('dedupes a place appearing in both sources', () => {
    const result = mergeLockedElsewhereIds({
      committedRows: [{ place_id: 1 }],
      otherDraftRows: [{ place_id: 1 }],
    });
    assert.deepEqual([...result], [1]);
  });

  test('dedupes duplicate rows within a single source', () => {
    const result = mergeLockedElsewhereIds({
      committedRows: [{ place_id: 1 }, { place_id: 1 }, { place_id: 3 }],
      otherDraftRows: [],
    });
    assert.deepEqual([...result].sort(), [1, 3]);
  });

  test('returns an empty set when both sources are empty', () => {
    const result = mergeLockedElsewhereIds({ committedRows: [], otherDraftRows: [] });
    assert.equal(result.size, 0);
  });

  test('defaults missing sources to empty rather than throwing', () => {
    const result = mergeLockedElsewhereIds({});
    assert.equal(result.size, 0);
  });
});

describe('partitionCommittableStops', () => {
  test('everything commits when nothing is locked', () => {
    const stops = [{ place_id: 1 }, { place_id: 2 }];
    const { committable, skippedCollisions } = partitionCommittableStops(stops, new Set());
    assert.equal(committable.length, 2);
    assert.equal(skippedCollisions.length, 0);
  });

  test('a locked stop moves to skippedCollisions, the rest still commit', () => {
    const stops = [{ place_id: 1 }, { place_id: 2 }, { place_id: 3 }];
    const { committable, skippedCollisions } = partitionCommittableStops(stops, new Set([2]));

    assert.deepEqual(committable.map((s) => s.place_id), [1, 3]);
    assert.deepEqual(skippedCollisions.map((s) => s.place_id), [2]);
  });

  test('every stop collides', () => {
    const stops = [{ place_id: 1 }, { place_id: 2 }];
    const { committable, skippedCollisions } = partitionCommittableStops(stops, new Set([1, 2]));

    assert.equal(committable.length, 0);
    assert.equal(skippedCollisions.length, 2);
  });

  test('an empty day partitions to two empty arrays', () => {
    const { committable, skippedCollisions } = partitionCommittableStops([], new Set([1]));
    assert.deepEqual(committable, []);
    assert.deepEqual(skippedCollisions, []);
  });

  test('preserves each stop\'s original shape/fields in whichever bucket it lands in', () => {
    const stops = [{ place_id: 1, visit_type: 'drop_in', sort_order: 0 }];
    const { committable } = partitionCommittableStops(stops, new Set());
    assert.deepEqual(committable[0], stops[0]);
  });
});

describe('validateDays', () => {
  const TODAY = '2026-07-13';
  const noCommitted = new Set();

  test('normalizes and sorts a valid selection', () => {
    const result = validateDays(
      [{ date: '2026-07-16', hoursPerDay: 4 }, { date: '2026-07-14', hoursPerDay: 6 }],
      { today: TODAY, committedDates: noCommitted }
    );
    assert.deepEqual(result, [{ date: '2026-07-14', hoursPerDay: 6 }, { date: '2026-07-16', hoursPerDay: 4 }]);
  });

  test('rejects an empty selection', () => {
    assert.throws(() => validateDays([], { today: TODAY, committedDates: noCommitted }), /at least one date/);
  });

  test(`rejects more than ${MAX_PLAN_DATES} dates`, () => {
    const many = Array.from({ length: MAX_PLAN_DATES + 1 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, hoursPerDay: 4 }));
    assert.throws(() => validateDays(many, { today: TODAY, committedDates: noCommitted }), /cannot plan more than/i);
  });

  test('allows today itself', () => {
    const result = validateDays([{ date: TODAY, hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted });
    assert.deepEqual(result, [{ date: TODAY, hoursPerDay: 4 }]);
  });

  test('rejects a date before today', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-12', hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted }),
      /in the past/
    );
  });

  // TODAY (2026-07-13) is a Monday. Counting only weekdays toward
  // MAX_DAYS_AHEAD: Tue 14(1), Wed 15(2), Thu 16(3), Fri 17(4), Sat/Sun
  // 18-19 (skipped, don't count), Mon 20(5), Tue 21(6), Wed 22(7) — so the
  // boundary lands on 2026-07-22, two calendar days later than a raw
  // "+7 days" count would give, because the weekend in between is free.
  test(`allows a date exactly ${MAX_DAYS_AHEAD} weekdays out (skipping the weekend in between)`, () => {
    const result = validateDays([{ date: '2026-07-22', hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted });
    assert.deepEqual(result, [{ date: '2026-07-22', hoursPerDay: 4 }]);
  });

  test(`rejects a date more than ${MAX_DAYS_AHEAD} weekdays out`, () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-23', hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted }),
      /more than 7 days out/
    );
  });

  test('rejects a Saturday', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-18', hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted }),
      /weekend/
    );
  });

  test('rejects a Sunday', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-19', hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted }),
      /weekend/
    );
  });

  test('rejects an invalid hoursPerDay', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-14', hoursPerDay: 0 }], { today: TODAY, committedDates: noCommitted }),
      /invalid hours/i
    );
  });

  test('rejects a date selected twice', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-14', hoursPerDay: 4 }, { date: '2026-07-14', hoursPerDay: 5 }], { today: TODAY, committedDates: noCommitted }),
      /selected twice/
    );
  });

  test('rejects a date that already has a committed visit', () => {
    assert.throws(
      () => validateDays([{ date: '2026-07-14', hoursPerDay: 4 }], { today: TODAY, committedDates: new Set(['2026-07-14']) }),
      /already has committed visits/
    );
  });
});

describe('deleteCommittedDay', () => {
  // deleteCommittedDay isn't pure (it issues a real `visits` delete). A
  // minimal fake db that records the filter handed to `.where()` and lets
  // `.del()` return a controllable count is enough to assert on the query
  // shape without standing up sqlite — mirroring the query itself
  // (`db('visits').where({...}).del()`) closely enough that a regression to
  // either scoping would show up here as a wrong recorded filter.
  function makeFakeDb(deletedCount) {
    const calls = [];
    const db = (table) => {
      calls.push({ table });
      return {
        where(filter) {
          calls[calls.length - 1].filter = filter;
          return { del: () => Promise.resolve(deletedCount) };
        },
      };
    };
    db.calls = calls;
    return db;
  }

  test('scopes the delete to status: planned, leaving completed/skipped history untouched', async () => {
    const db = makeFakeDb(2);
    await deleteCommittedDay(db, { userId: 5, date: '2026-07-16' });

    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].table, 'visits');
    assert.equal(db.calls[0].filter.status, 'planned');
  });

  test('scopes the delete to the given userId and date', async () => {
    const db = makeFakeDb(1);
    await deleteCommittedDay(db, { userId: 7, date: '2026-07-17' });

    assert.deepEqual(db.calls[0].filter, {
      user_id: 7,
      scheduled_date: '2026-07-17',
      status: 'planned',
    });
  });

  test('resolves to the number of rows deleted', async () => {
    const db = makeFakeDb(3);
    const result = await deleteCommittedDay(db, { userId: 5, date: '2026-07-16' });
    assert.equal(result, 3);
  });
});

// One logged visit is a TRIP row plus one row per person/category met
// (20260806000000_split_visit_encounters.js). Same helper as
// relationship.test.js's, kept local rather than shared through a new module
// — six lines each is cheaper than a file nothing else would import.
async function insertVisit(db, { encounters = [], ...trip }) {
  const [row] = await db('visits').insert(trip).returning('id');
  const visitId = row && row.id ? row.id : row;
  for (const e of encounters) {
    await db('visit_encounters').insert({ ...e, visit_id: visitId });
  }
  return visitId;
}

describe('buildCandidatePool fatigue counting', () => {
  let db;
  const TODAY = '2026-08-03';

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });

    // Place 1: ONE trip, four people met that day -> one visit, four encounters.
    // Place 2: four separate trips on four different days.
    // Place 3: TWO separate trips on the SAME day (a morning drop-off and an
    //          afternoon meeting — legitimate, and the case the distinct-day
    //          dedup below still has to collapse now that a multi-contact
    //          trip is no longer expressed as several rows).
    await db('places').insert([
      { id: 1, name: 'One Big Meeting', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 2, name: 'Four Real Trips', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 3, name: 'Twice In A Day', category: 'Hospice', tier: 1, priority_score: 75 },
    ]);
    await db('people').insert([
      { id: 1, place_id: 1, name: 'A' }, { id: 2, place_id: 1, name: 'B' },
      { id: 3, place_id: 1, name: 'C' }, { id: 4, place_id: 1, name: 'D' },
    ]);

    const sameDay = '2026-07-30';
    await insertVisit(db, {
      place_id: 1, user_id: 1, status: 'completed', scheduled_date: sameDay, place_name: 'One Big Meeting',
      encounters: [1, 2, 3, 4].map((personId) => ({ person_id: personId, met_with_type: 'named_person', outcome: 'substantive' })),
    });
    for (const d of ['2026-07-10', '2026-07-17', '2026-07-24', '2026-07-31']) {
      await insertVisit(db, {
        place_id: 2, user_id: 1, status: 'completed', scheduled_date: d, place_name: 'Four Real Trips',
        encounters: [{ person_id: null, met_with_type: 'receptionist', outcome: 'materials_only' }],
      });
    }
    for (const notes of ['Morning drop-off', 'Afternoon meeting']) {
      await insertVisit(db, {
        place_id: 3, user_id: 1, status: 'completed', scheduled_date: sameDay, place_name: 'Twice In A Day', notes,
        encounters: [{ person_id: null, met_with_type: 'receptionist', outcome: 'materials_only' }],
      });
    }
  });

  after(async () => {
    await db.destroy();
  });

  test('four people met on ONE day counts as one visit, not four', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 1);
    assert.equal(place.recentCompletedCount, 1, 'one trip is one visit regardless of how many contacts were met');
  });

  test('two separate trips on the same day still count as one visited DAY', async () => {
    // The distinct-scheduled_date dedup is no longer load-bearing for the
    // multi-contact case (that's one row now), but it is still the only thing
    // standing between two genuine same-day trips and a double fatigue hit.
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 3);
    assert.equal(place.recentCompletedCount, 1, 'fatigue counts days shown up, not rows');
  });

  test('four visits on four separate days still counts as four', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 2);
    assert.equal(place.recentCompletedCount, 4, 'genuinely frequent visits must still trigger fatigue');
  });

  test('lastVisitDate is unaffected by the distinct-day change', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    assert.equal(pool.find((c) => c.place.id === 1).lastVisitDate, '2026-07-30');
    assert.equal(pool.find((c) => c.place.id === 2).lastVisitDate, '2026-07-31');
  });
});

// Step 3 of the 2026-08 remediation ticket: buildCandidatePool must feed
// plannedVisitDates to eligibility() as its OWN field — never widen
// lastVisitByPlace's status filter to include 'planned', since that field
// also drives urgency()/rankKey's cadence math (a place that only LOOKS
// recently serviced because a visit is merely planned, not completed, would
// rank as less urgent than it actually is).
describe('buildCandidatePool plannedVisitDates', () => {
  let db;
  const TODAY = '2026-08-03';

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });
    await db('places').insert([
      { id: 1, name: 'Planned Only', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 2, name: 'Planned And Completed', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 3, name: 'Two Planned Visits', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 4, name: 'Neither', category: 'Hospice', tier: 1, priority_score: 75 },
    ]);

    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: '2026-08-05', place_name: 'Planned Only' });

    await db('visits').insert({ place_id: 2, user_id: 1, status: 'completed', scheduled_date: '2026-07-20', place_name: 'Planned And Completed' });
    await db('visits').insert({ place_id: 2, user_id: 1, status: 'planned', scheduled_date: '2026-08-05', place_name: 'Planned And Completed' });

    await db('visits').insert({ place_id: 3, user_id: 1, status: 'planned', scheduled_date: '2026-08-05', place_name: 'Two Planned Visits' });
    await db('visits').insert({ place_id: 3, user_id: 1, status: 'planned', scheduled_date: '2026-08-20', place_name: 'Two Planned Visits' });
  });

  after(async () => {
    await db.destroy();
  });

  test('a place with ONLY a planned visit gets plannedVisitDates, but lastVisitDate stays null', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 1);
    assert.deepEqual(place.plannedVisitDates, ['2026-08-05']);
    assert.equal(place.lastVisitDate, null, 'a planned visit must never make an unvisited place look visited for cadence/urgency purposes');
  });

  test('a place with both keeps them as two separate fields, not merged', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 2);
    assert.equal(place.lastVisitDate, '2026-07-20', 'lastVisitDate must stay COMPLETED-only — the planned visit must not overwrite it');
    assert.deepEqual(place.plannedVisitDates, ['2026-08-05']);
  });

  test('more than one planned visit -> every date is kept, not just the nearest', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 3);
    assert.deepEqual(place.plannedVisitDates.sort(), ['2026-08-05', '2026-08-20']);
  });

  test('a place with neither gets an empty array, not null/undefined', async () => {
    const pool = await buildCandidatePool(db, { today: TODAY });
    const place = pool.find((c) => c.place.id === 4);
    assert.deepEqual(place.plannedVisitDates, []);
  });
});

// The required knock-on the ticket calls out by name: "Verify loadDraftView
// recomputes the full detector, not just same-date locks. If it doesn't,
// this passes audit and fails in the field." Before Step 3, loadDraftView/
// loadDraftDayView only ever recomputed alreadyVisitedToday and
// crossRepFloorWarning for a draft's already-placed stops — never
// SAME_DATE_VISIT/FLOOR_COMPLETED/FLOOR_PLANNED/DRAFT_ELSEWHERE. This proves
// the fix end-to-end: build a draft, THEN have another rep commit a
// colliding visit, THEN reload the SAME draft and confirm the collision
// shows up without the draft itself ever being touched.
//
// global.fetch is mocked to fail fast (falls back to the haversine
// evaluateTimeBlock — see driveTime.js) so this runs offline and fast, same
// convention as routeOptimizer.test.js. Test places carry lat/lng because
// evaluateTimeBlock silently drops ungeocoded stops from its packed output
// (see driveTime.js's isGeocoded/packStops) — without it, the very stop this
// test needs to inspect would never appear in `day.stops` at all.
describe('loadDraftView / loadDraftDayView — full detector recompute (Step 3 required knock-on)', () => {
  let db;
  const originalFetch = global.fetch;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
    global.fetch = async () => ({ ok: false, json: async () => ({}) });
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert([
      { id: 1, name: 'Bede', email: 'bede@test.local' },
      { id: 2, name: 'Sarah', email: 'sarah@test.local' },
    ]);
    await db('places').insert([
      { id: 1, name: 'Same Day Place', category: 'Hospice', tier: 1, priority_score: 75, lat: 41.9, lng: -87.6 },
      { id: 2, name: 'Nearby Day Place', category: 'Hospice', tier: 1, priority_score: 75, lat: 41.8, lng: -87.7 },
    ]);
  });

  after(async () => {
    global.fetch = originalFetch;
    await db.destroy();
  });

  test('loadDraftView: a same-date visit another rep commits AFTER the draft was built shows up on the next read', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 1, date: DATE_A, sort_order: 0 });

    const before1 = await loadDraftView(db, draftId);
    const stopBefore = before1.days[0].stops.find((s) => s.place_id === 1);
    assert.ok(stopBefore, 'the stop must actually appear in the packed day');
    assert.deepEqual(stopBefore.conflicts, [], 'clean baseline — nothing has collided yet');

    // Another rep commits a real visit to the SAME place, SAME date — after
    // the draft above was already built. Nothing about the draft itself
    // changes.
    await db('visits').insert({ place_id: 1, user_id: 2, status: 'planned', scheduled_date: DATE_A, place_name: 'Same Day Place' });

    const after1 = await loadDraftView(db, draftId);
    const stopAfter = after1.days[0].stops.find((s) => s.place_id === 1);
    assert.equal(stopAfter.conflicts.length, 1);
    assert.equal(stopAfter.conflicts[0].type, 'SAME_DATE_VISIT');
    assert.equal(stopAfter.conflicts[0].otherUserName, 'Sarah');
  });

  test('loadDraftDayView: a nearby-day PLANNED visit committed after the fact produces FLOOR_PLANNED on reload', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 0 });

    const before1 = await loadDraftDayView(db, draftId, DATE_A);
    assert.deepEqual(before1.stops.find((s) => s.place_id === 2).conflicts, []);

    // Another rep commits a PLANNED visit to the same place two days later —
    // still within the hard floor, but NOT the same date, so this is the
    // FLOOR_PLANNED path specifically, not SAME_DATE_VISIT.
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: '2026-08-12', place_name: 'Nearby Day Place' });

    const after1 = await loadDraftDayView(db, draftId, DATE_A);
    const stopAfter = after1.stops.find((s) => s.place_id === 2);
    assert.equal(stopAfter.conflicts.length, 1);
    assert.equal(stopAfter.conflicts[0].type, 'FLOOR_PLANNED');
    assert.equal(stopAfter.conflicts[0].daysApart, 2);
  });
});
