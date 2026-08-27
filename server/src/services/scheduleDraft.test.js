const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const { mergeLockedElsewhereIds, partitionCommittableStops, validateDays, deleteCommittedDay, discardStaleDrafts, buildCandidatePool, loadDraftView, loadDraftDayView, committedDateSummaries, committedDatesForUser, commitDay, MAX_PLAN_DATES, MAX_DAYS_AHEAD } = require('./scheduleDraft');
const { loadMatrix } = require('./matrixCache');
const defaultDriveConfig = require('../config/driveTime');

// Independently reproduces what getRouteLegMinutes/optimizeRoute would
// compute for a single a->b leg via the real matrixCache.loadMatrix, same
// convention as the old estimateDriveMinutes-based expectations this
// replaced: an expected value derived from the real underlying function, not
// re-typed by hand, but still independent of whatever loadDraftView's own
// response reports.
async function fallbackDriveMinutes(db, a, b) {
  const { matrix } = await loadMatrix(db, [a, b], 'seconds');
  return Math.max(defaultDriveConfig.MIN_DRIVE_MINUTES, Math.round(matrix[0][1] / 60));
}
const { editVisit } = require('./manualVisits');

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
  // 18-19 (skipped, don't count), Mon 20(5), Tue 21(6), Wed 22(7) - so the
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
  // shape without standing up sqlite - mirroring the query itself
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

  // Deliberately NOT scoped to source: 'planner' (Bede's call, see the
  // function's own comment) - "Discard plan" means clear the whole day,
  // manually-planned/promoted stops included. Unlike reopenCommittedDay
  // (still source:'planner'-only - pulling a manual visit into
  // schedule_draft_stops would misrepresent it as a re-orderable proposal),
  // deleting is symmetric regardless of how the row got there.
  test('does NOT scope the delete to source - a manually-planned visit on the same date is cleared too', async () => {
    const db = makeFakeDb(1);
    await deleteCommittedDay(db, { userId: 5, date: '2026-07-16' });
    assert.equal(db.calls[0].filter.source, undefined);
  });

  test('resolves to the number of rows deleted', async () => {
    const db = makeFakeDb(3);
    const result = await deleteCommittedDay(db, { userId: 5, date: '2026-07-16' });
    assert.equal(result, 3);
  });
});

describe('discardStaleDrafts', () => {
  // Same fake-db-as-call-recorder style as deleteCommittedDay's tests above -
  // enough to assert on which ids get deleted without standing up sqlite.
  function makeFakeDb(rows) {
    const calls = [];
    const db = (table) => {
      calls.push({ table });
      return {
        select: () => Promise.resolve(rows),
        whereIn(col, ids) {
          calls[calls.length - 1].whereIn = { col, ids };
          return { del: () => Promise.resolve(ids.length) };
        },
      };
    };
    db.calls = calls;
    return db;
  }

  test('deletes drafts created on an org-date before today, leaves today\'s alone', async () => {
    const db = makeFakeDb([
      { id: 1, created_at: '2026-08-11T23:30:00.000Z' }, // 6:30pm Central on the 11th - stale
      { id: 2, created_at: '2026-08-12T13:00:00.000Z' }, // 8am Central on the 12th - fresh
    ]);
    const count = await discardStaleDrafts(db, { today: '2026-08-12' });

    assert.equal(count, 1);
    assert.equal(db.calls.length, 2);
    assert.deepEqual(db.calls[1].whereIn, { col: 'id', ids: [1] });
  });

  test('does nothing when every draft is from today', async () => {
    const db = makeFakeDb([{ id: 1, created_at: '2026-08-12T13:00:00.000Z' }]);
    const count = await discardStaleDrafts(db, { today: '2026-08-12' });

    assert.equal(count, 0);
    assert.equal(db.calls.length, 1); // no whereIn/del call at all
  });

  test('does nothing when there are no drafts', async () => {
    const db = makeFakeDb([]);
    const count = await discardStaleDrafts(db, { today: '2026-08-12' });
    assert.equal(count, 0);
  });
});

// One logged visit is a TRIP row plus one row per person/category met
// (20260806000000_split_visit_encounters.js). Same helper as
// relationship.test.js's, kept local rather than shared through a new module
// - six lines each is cheaper than a file nothing else would import.
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
    //          afternoon meeting - legitimate, and the case the distinct-day
    //          dedup below still has to collapse now that a multi-contact
    //          trip is no longer expressed as several rows).
    await db('places').insert([
      { id: 1, name: 'One Big Meeting', category: 'Hospice' },
      { id: 2, name: 'Four Real Trips', category: 'Hospice' },
      { id: 3, name: 'Twice In A Day', category: 'Hospice' },
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
// plannedVisitDates to eligibility() as its OWN field - never widen
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
      { id: 1, name: 'Planned Only', category: 'Hospice' },
      { id: 2, name: 'Planned And Completed', category: 'Hospice' },
      { id: 3, name: 'Two Planned Visits', category: 'Hospice' },
      { id: 4, name: 'Neither', category: 'Hospice' },
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
    assert.equal(place.lastVisitDate, '2026-07-20', 'lastVisitDate must stay COMPLETED-only - the planned visit must not overwrite it');
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

// Only a real planner-committed visit GATES a date into "already committed"
// - blocks it from /generate (validateDays) and shows it on the calendar. A
// manual-only date is deliberately excluded from that gate (reversed
// 2026-08-19, see feedback_route_planner_proposals_only) - the generator
// already treats any status:'planned' visit, manual or planner, as a fixed,
// budget-consuming stop to route around (committedVisitsQuery/evaluateDay,
// and the same-place exclusion in lockedElsewherePlaceIds), so blocking the
// whole day added nothing beyond what those plain rules already cover. Same
// source:'planner' scoping precedent as reopenCommittedDay.
//
// Once a date clears that gate, though, its COUNT is every planned visit on
// it, any source (caught 2026-08-20) - a rep who commits a route AND
// separately hand-plans a visit for the same day should see both reflected
// in "3 visits planned," not just the 2 the route planner itself proposed;
// the drill-down committedDayVisits opens from clicking the row already
// shows all of them, so the count has to match.
describe('committedDateSummaries lists every open date unscoped by source; committedDatesForUser gates re-selection to planner-committed dates only', () => {
  let db;
  const TODAY = '2026-08-12';

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
      { id: 1, name: 'Manual Only Place', category: 'Hospice' },
      { id: 2, name: 'Planner Committed Place', category: 'Hospice' },
      { id: 3, name: 'Both Place', category: 'Hospice' },
      { id: 4, name: 'Both Place Two', category: 'Hospice' },
    ]);

    // A date with ONLY a manual visit - appears in the summary (2026-08-25:
    // manual-only dates are meant to show in "Already Planned"), but must
    // stay OUT of committedDatesForUser's gate so it stays selectable in
    // /generate.
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', planned_manually: 1, scheduled_date: '2026-08-20', place_name: 'Manual Only Place' });

    // A date with ONLY a real planner commit - still counted, unaffected by this change.
    // planner_committed: 1 alongside source: 'planner' - a hand-built fixture
    // standing in for what commitDay's real insert produces (see
    // 20260822000000_add_visits_planner_committed.js).
    await db('visits').insert({ place_id: 2, user_id: 1, status: 'planned', planned_manually: 0, source: 'planner', planner_committed: 1, scheduled_date: '2026-08-21', place_name: 'Planner Committed Place' });

    // A date with BOTH - the planner row is what gates re-selection, but the
    // summary counts both rows regardless.
    await db('visits').insert({ place_id: 3, user_id: 1, status: 'planned', planned_manually: 1, scheduled_date: '2026-08-22', place_name: 'Both Place' });
    await db('visits').insert({ place_id: 4, user_id: 1, status: 'planned', planned_manually: 0, source: 'planner', planner_committed: 1, scheduled_date: '2026-08-22', place_name: 'Both Place Two' });
  });

  after(async () => {
    await db.destroy();
  });

  test('a manual-only date appears in the summary, but is absent from the re-selection gate', async () => {
    const summaries = await committedDateSummaries(db, 1, { today: TODAY });
    const row = summaries.find((s) => s.date === '2026-08-20');
    assert.ok(row, 'a manual-only date is a real commitment and belongs in "Already Planned"');
    assert.equal(row.count, 1);

    const gated = await committedDatesForUser(db, 1, { today: TODAY });
    assert.equal(gated.has('2026-08-20'), false, 'still selectable in /generate - a manual-only date never blocks re-selection');
  });

  test('a planner-committed-only date appears in both the summary and the re-selection gate', async () => {
    const summaries = await committedDateSummaries(db, 1, { today: TODAY });
    const row = summaries.find((s) => s.date === '2026-08-21');
    assert.ok(row);
    assert.equal(row.count, 1);

    const gated = await committedDatesForUser(db, 1, { today: TODAY });
    assert.ok(gated.has('2026-08-21'));
  });

  test('a date with both counts every visit on it, not just the planner-sourced one', async () => {
    const summaries = await committedDateSummaries(db, 1, { today: TODAY });
    const row = summaries.find((s) => s.date === '2026-08-22');
    assert.ok(row);
    assert.equal(row.count, 2, 'the manual visit still counts alongside the planner-committed one');
  });

  // Regression test for the bug fixed 2026-08-22: editVisit
  // (services/manualVisits.js) promotes ANY successful hand-edit - even a
  // notes-only one, no date change - to source: 'manual'. Before
  // planner_committed existed, that silently dropped a date out of this
  // gate the moment its only planner-committed visit got a typo fixed,
  // reopening the date for a fresh /generate even though the visit was
  // still sitting there. planner_committed is meant to survive exactly
  // this. Own place/date, isolated from the shared before() fixture above
  // since this test mutates a row. Targets committedDatesForUser - the
  // function that now owns the re-selection gate this bug was about (split
  // out from committedDateSummaries 2026-08-25).
  test('a notes-only edit through editVisit does not drop the date out of the gate', async () => {
    await db('places').insert({ id: 5, name: 'Edited Notes Place', category: 'Hospice' });
    const [inserted] = await db('visits')
      .insert({ place_id: 5, user_id: 1, status: 'planned', planned_manually: 0, source: 'planner', planner_committed: 1, scheduled_date: '2026-08-23', place_name: 'Edited Notes Place' })
      .returning('id');
    const visitId = inserted && inserted.id !== undefined ? inserted.id : inserted;

    let gated = await committedDatesForUser(db, 1, { today: TODAY });
    assert.ok(gated.has('2026-08-23'), 'the date gates in before any edit, same as any other planner commit');

    const result = await editVisit(db, visitId, { notes: 'fixed a typo' }, 1);
    assert.equal(result.visit.notes, 'fixed a typo');
    assert.equal(result.visit.source, 'manual', 'the promotion itself is unaffected - still flips on any edit');

    gated = await committedDatesForUser(db, 1, { today: TODAY });
    assert.ok(gated.has('2026-08-23'), 'the date must still gate in - the visit never stopped being real');
  });
});

// The required knock-on the ticket calls out by name: "Verify loadDraftView
// recomputes the full detector, not just same-date locks. If it doesn't,
// this passes audit and fails in the field." Before Step 3, loadDraftView/
// loadDraftDayView only ever recomputed alreadyVisitedToday and
// crossRepFloorWarning for a draft's already-placed stops - never
// SAME_DATE_VISIT/FLOOR_COMPLETED/FLOOR_PLANNED/DRAFT_ELSEWHERE. This proves
// the fix end-to-end: build a draft, THEN have another rep commit a
// colliding visit, THEN reload the SAME draft and confirm the collision
// shows up without the draft itself ever being touched.
//
// The place_distance cache is empty in this in-memory test DB, so every
// leg falls back to matrixCache's geometric estimate - deterministic and
// offline by construction, no mocking needed (see routeOptimizer.test.js).
// Test places carry lat/lng because evaluateDay drops ungeocoded stops
// before evaluating them (see driveTime.js's isGeocoded) - without it, the
// very stop this test needs to inspect would never appear in `day.stops`
// at all.
describe('loadDraftView / loadDraftDayView - full detector recompute (Step 3 required knock-on)', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
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
      { id: 1, name: 'Same Day Place', category: 'Hospice', lat: 41.9, lng: -87.6 },
      { id: 2, name: 'Nearby Day Place', category: 'Hospice', lat: 41.8, lng: -87.7 },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('loadDraftView: a same-date visit another rep commits AFTER the draft was built drops the stop from the proposal on the next read', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 1, date: DATE_A, sort_order: 0 });

    const before1 = await loadDraftView(db, draftId);
    const stopBefore = before1.days[0].stops.find((s) => s.place_id === 1);
    assert.ok(stopBefore, 'the stop must actually appear in the packed day');
    assert.deepEqual(stopBefore.conflicts, [], 'clean baseline - nothing has collided yet');

    // Another rep commits a real visit to the SAME place, SAME date - after
    // the draft above was already built. Nothing about the draft itself
    // changes.
    await db('visits').insert({ place_id: 1, user_id: 2, status: 'planned', scheduled_date: DATE_A, place_name: 'Same Day Place' });

    // A SAME_DATE_VISIT conflict isn't just informational like FLOOR_*/
    // DRAFT_ELSEWHERE below - the place already has a real visit that exact
    // day, so proposing it again is never correct. loadDraftView drops the
    // stop entirely rather than surfacing it with a warning banner (see
    // hasSameDateVisitConflict in scheduleDraft.js).
    const after1 = await loadDraftView(db, draftId);
    const stopAfter = after1.days[0].stops.find((s) => s.place_id === 1);
    assert.equal(stopAfter, undefined, 'a same-date real visit must remove the stop from the proposal, not just flag it');

    // Removing it is only half the job: dropping it SILENTLY is what made
    // the stop appear to evaporate on whatever unrelated draft edit happened
    // to trigger the next read. The day has to say what it took out and who
    // took the slot (partitionSameDateDrops in scheduleDraft.js).
    const dropped = after1.days[0].droppedCollisions;
    assert.equal(dropped.length, 1, 'the drop must be reported on the day, not just performed');
    assert.equal(dropped[0].place_id, 1);
    assert.equal(dropped[0].place_name, 'Same Day Place');
    assert.equal(dropped[0].conflict.type, 'SAME_DATE_VISIT');
    assert.equal(dropped[0].conflict.otherUserId, 2, 'the other rep is named, not left as a bare "booked elsewhere"');
    assert.equal(dropped[0].conflict.status, 'planned');
  });

  // The draft row itself must SURVIVE the drop - this is a view-level filter,
  // not a delete. That's what leaves commitDay still able to see the stop and
  // report it in skippedCollisions, and it's why the notice above has to keep
  // reappearing on every read rather than firing once.
  test('loadDraftView: a dropped stop keeps its schedule_draft_stops row', async () => {
    // Its own place+date pair, not DATE_A/place 1: this describe seeds once
    // in before() (not beforeEach), so the earlier tests' visits are still
    // on the table and reusing theirs trips visits_place_date_planned_unique.
    const DATE_C = '2026-08-20';
    const params = { days: [{ date: DATE_C, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_C, sort_order: 0 });
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: DATE_C, place_name: 'Nearby Day Place' });

    const view = await loadDraftView(db, draftId);
    assert.equal(view.days[0].stops.length, 0, 'dropped from the view');
    assert.equal(view.days[0].droppedCollisions.length, 1, 'and reported');
    const rows = await db('schedule_draft_stops').where({ draft_id: draftId, place_id: 2 });
    assert.equal(rows.length, 1, 'but the underlying draft row is untouched');
  });

  test('loadDraftDayView: a nearby-day PLANNED visit committed after the fact produces FLOOR_PLANNED on reload', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 0 });

    const before1 = await loadDraftDayView(db, draftId, DATE_A);
    assert.deepEqual(before1.stops.find((s) => s.place_id === 2).conflicts, []);

    // Another rep commits a PLANNED visit to the same place two days later -
    // still within the hard floor, but NOT the same date, so this is the
    // FLOOR_PLANNED path specifically, not SAME_DATE_VISIT.
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: '2026-08-12', place_name: 'Nearby Day Place' });

    const after1 = await loadDraftDayView(db, draftId, DATE_A);
    const stopAfter = after1.stops.find((s) => s.place_id === 2);
    assert.equal(stopAfter.conflicts.length, 1);
    assert.equal(stopAfter.conflicts[0].type, 'FLOOR_PLANNED');
    assert.equal(stopAfter.conflicts[0].daysApart, 2);
  });

  // loadDraftDayView's own copy of the same drop-not-just-flag behavior
  // covered above for loadDraftView - a separate function, separate query,
  // so it gets its own test rather than assuming the two stay in sync.
  // COMPLETED (not planned) here, so both real-visit statuses that trigger
  // SAME_DATE_VISIT are covered across the two tests.
  test('loadDraftDayView: a same-date COMPLETED visit drops the stop from the proposal', async () => {
    const DATE_B = '2026-08-11';
    const params = { days: [{ date: DATE_B, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 1, date: DATE_B, sort_order: 0 });

    const before1 = await loadDraftDayView(db, draftId, DATE_B);
    assert.ok(before1.stops.find((s) => s.place_id === 1), 'clean baseline - the stop starts out present');

    await db('visits').insert({ place_id: 1, user_id: 2, status: 'completed', scheduled_date: DATE_B, place_name: 'Same Day Place' });

    const after1 = await loadDraftDayView(db, draftId, DATE_B);
    assert.equal(after1.stops.find((s) => s.place_id === 1), undefined, 'a same-date completed visit must remove the stop, not just flag it');

    // Reported here too - this is the shape every draft MUTATION returns
    // (reorder/add/remove/visit-type), which is exactly when a rep used to
    // watch a stop vanish for no stated reason.
    assert.equal(after1.droppedCollisions.length, 1, 'the one-day view reports the drop as well');
    assert.equal(after1.droppedCollisions[0].place_name, 'Same Day Place');
    assert.equal(after1.droppedCollisions[0].conflict.status, 'completed');
  });
});

// Place Commitments badge (spec §6.1) on a draft stop - loadDraftView/
// loadDraftDayView attach it via the pure commitmentBadge helper, fed by
// services/placeCommitments.js's getOutstandingCommitmentsForPlaces.
// promised_date is a fixed, clearly-past date (not "N days before whatever
// day this test happens to run") so overdueDays > 0 is true regardless of
// when this suite executes, without asserting the exact count (which WOULD
// depend on the real wall-clock date, since loadDraftView/loadDraftDayView
// call orgToday() internally, same as their pre-existing alreadyVisitedToday
// computation).
describe('loadDraftView / loadDraftDayView - Place Commitments badge', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Promised Place', category: 'Hospice', lat: 41.9, lng: -87.6 },
      { id: 2, name: 'Clean Place', category: 'Hospice', lat: 41.8, lng: -87.7 },
    ]);
    await db('people').insert({ id: 1, place_id: 1, name: 'Sharon Klein' });
    // Two outstanding commitments at place 1: the binding one (earliest,
    // overdue, named) plus a second, later one - this is what exercises
    // moreCount.
    await db('place_commitments').insert([
      { place_id: 1, promised_date: '2020-01-01', person_id: 1, note: 'asked for the DON' },
      { place_id: 1, promised_date: '2099-01-01' },
    ]);

    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    db.draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert([
      { draft_id: db.draftId, place_id: 1, date: DATE_A, sort_order: 0 },
      { draft_id: db.draftId, place_id: 2, date: DATE_A, sort_order: 1 },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('loadDraftDayView: a place with outstanding commitments carries the badge, correctly shaped', async () => {
    const view = await loadDraftDayView(db, db.draftId, DATE_A);
    const stop = view.stops.find((s) => s.place_id === 1);
    assert.ok(stop.commitment, 'a place with an outstanding commitment must carry the badge');
    assert.equal(stop.commitment.promisedDate, '2020-01-01', 'the EARLIEST outstanding commitment binds, not the later one');
    assert.equal(stop.commitment.personName, 'Sharon Klein');
    assert.equal(stop.commitment.note, 'asked for the DON');
    assert.ok(stop.commitment.overdueDays > 0, 'a promised_date years in the past must be overdue');
    assert.equal(stop.commitment.moreCount, 1, 'the second outstanding commitment counts as "+1 more", not silently dropped');
  });

  test('loadDraftDayView: a place with no outstanding commitments gets no badge', async () => {
    const view = await loadDraftDayView(db, db.draftId, DATE_A);
    const stop = view.stops.find((s) => s.place_id === 2);
    assert.equal(stop.commitment, null);
  });

  test('loadDraftView: same badge, on the whole-draft read', async () => {
    const view = await loadDraftView(db, db.draftId);
    const stop = view.days[0].stops.find((s) => s.place_id === 1);
    assert.ok(stop.commitment);
    assert.equal(stop.commitment.moreCount, 1);
  });
});

// do_not_visit rides the stop's `conflicts` array (services/doNotVisit.js's
// doNotVisitFinding, attached by stopFindings) rather than a field of its
// own, so RoutePlanner.jsx renders it through the one conflict badge it
// already has. This is the whole of addStop's do-not-visit handling: the flag
// warns, it never refuses - same policy addStop already applies to a floor
// conflict and to another rep's draft.
//
// Attached on every READ, which is the case a one-shot check at add time
// could never cover: a place marked do-not-visit AFTER it was already sitting
// in the draft. The fixture leans on that - the mark is applied between two
// loads of the same unchanged draft.
//
// Both the live and the lapsed mark use dates that don't depend on when this
// suite runs (indefinite / years past), since loadDraft*View call the real
// orgToday() internally.
describe('loadDraftView / loadDraftDayView - do_not_visit finding on a stop', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    // do_not_visit is spelled out on EVERY row: places.do_not_visit is NOT
    // NULL, and a batched insert fills a column absent from one row's object
    // with an explicit NULL for that row rather than the column default.
    await db('places').insert([
      { id: 1, name: 'Marked Place', category: 'Hospice', lat: 41.9, lng: -87.6, do_not_visit: false },
      { id: 2, name: 'Clean Place', category: 'Hospice', lat: 41.8, lng: -87.7, do_not_visit: false },
      { id: 3, name: 'Lapsed Mark Place', category: 'Hospice', lat: 41.7, lng: -87.8, do_not_visit: true, do_not_visit_until: '2020-01-01' },
    ]);

    const params = { days: [{ date: DATE_A, hoursPerDay: 8 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    db.draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert([
      { draft_id: db.draftId, place_id: 1, date: DATE_A, sort_order: 0 },
      { draft_id: db.draftId, place_id: 2, date: DATE_A, sort_order: 1 },
      { draft_id: db.draftId, place_id: 3, date: DATE_A, sort_order: 2 },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  function findingsFor(stop) {
    return (stop.conflicts || []).filter((c) => c.type === 'DO_NOT_VISIT');
  }

  test('an unmarked place carries no do-not-visit finding', async () => {
    const view = await loadDraftDayView(db, db.draftId, DATE_A);
    assert.equal(findingsFor(view.stops.find((s) => s.place_id === 1)).length, 0);
    assert.equal(findingsFor(view.stops.find((s) => s.place_id === 2)).length, 0);
  });

  test('a mark whose until-date has already passed carries no finding either', async () => {
    const view = await loadDraftDayView(db, db.draftId, DATE_A);
    assert.equal(findingsFor(view.stops.find((s) => s.place_id === 3)).length, 0);
  });

  test('marking the place do-not-visit AFTER it is already in the draft flags it on the next read', async () => {
    await db('places').where({ id: 1 }).update({ do_not_visit: true, do_not_visit_until: null });
    const view = await loadDraftDayView(db, db.draftId, DATE_A);
    const stop = view.stops.find((s) => s.place_id === 1);
    assert.deepEqual(findingsFor(stop), [{ type: 'DO_NOT_VISIT', severity: 'soft', placeId: 1 }]);
    // The stop is still there: this warns, it does not drop the row the way
    // a SAME_DATE_VISIT collision does (partitionSameDateDrops).
    assert.ok(view.stops.some((s) => s.place_id === 1), 'a marked place stays in the proposal');
    assert.equal(findingsFor(view.stops.find((s) => s.place_id === 2)).length, 0, 'the neighbouring clean stop is untouched');
  });

  test('loadDraftView: same finding on the whole-draft read', async () => {
    const view = await loadDraftView(db, db.draftId);
    const stop = view.days[0].stops.find((s) => s.place_id === 1);
    assert.deepEqual(findingsFor(stop), [{ type: 'DO_NOT_VISIT', severity: 'soft', placeId: 1 }]);
    assert.equal(findingsFor(view.days[0].stops.find((s) => s.place_id === 3)).length, 0);
  });
});

// Checkpoint 6: a stop (proposed OR committed) whose place's address changed
// AFTER the stop was set carries an ADDRESS_CHANGED finding - permanent, not
// time-boxed, per the checkpoint 6 decision (see staleAddress.js's header).
// Covers both loadDraftView/loadDraftDayView (proposed, via stopFindings)
// and committedRows (via attachStaleAddressFinding), since a rep already
// driving to a committed visit matters at least as much as a still-tentative
// proposal.
describe('loadDraftView / loadDraftDayView - ADDRESS_CHANGED finding (checkpoint 6)', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Moved Place', category: 'Hospice', lat: 41.9, lng: -87.6 },
      { id: 2, name: 'Untouched Place', category: 'Hospice', lat: 41.8, lng: -87.7 },
      { id: 3, name: 'Recently Added Place', category: 'Hospice', lat: 41.7, lng: -87.8 },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  function findingsFor(row) {
    return (row.conflicts || []).filter((c) => c.type === 'ADDRESS_CHANGED');
  }

  test('a proposed stop set BEFORE its place moves is flagged on the next read; one set AFTER is not', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 8 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    // Both stops set now, place 2 stays clean throughout.
    await db('schedule_draft_stops').insert([
      { draft_id: draftId, place_id: 1, date: DATE_A, sort_order: 0 },
      { draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 1 },
    ]);

    // Place 1's address changes AFTER the stop was already set - a real
    // future timestamp, not just "now", so this can't be flaky on a slow
    // machine where the update lands in the same clock tick as the insert.
    const later = new Date(Date.now() + 60_000);
    await db('places').where({ id: 1 }).update({ address_changed_at: later });

    const dayView = await loadDraftDayView(db, draftId, DATE_A);
    assert.deepEqual(findingsFor(dayView.stops.find((s) => s.place_id === 1)), [{ type: 'ADDRESS_CHANGED', severity: 'soft', placeId: 1 }]);
    assert.equal(findingsFor(dayView.stops.find((s) => s.place_id === 2)).length, 0, 'a place that never moved carries no finding');
    // The stop stays in the proposal - this warns, it does not drop the row
    // (same "warn, don't act" contract as do_not_visit above).
    assert.ok(dayView.stops.some((s) => s.place_id === 1));

    // Whole-draft read carries the same finding.
    const fullView = await loadDraftView(db, draftId);
    assert.deepEqual(findingsFor(fullView.days[0].stops.find((s) => s.place_id === 1)), [{ type: 'ADDRESS_CHANGED', severity: 'soft', placeId: 1 }]);

    // A stop added AFTER the address change is never stale by construction -
    // it was planned against the CURRENT address.
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 3, date: DATE_A, sort_order: 2 });
    const afterAdd = await loadDraftDayView(db, draftId, DATE_A);
    assert.equal(findingsFor(afterAdd.stops.find((s) => s.place_id === 3)).length, 0);
  });

  test('a committed visit set BEFORE its place moves is flagged; the neighbouring untouched place is not', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 8 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    await db('visits').insert([
      { place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Moved Place', visit_type: 'drop_in' },
      { place_id: 2, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Untouched Place', visit_type: 'drop_in' },
    ]);

    const later = new Date(Date.now() + 60_000);
    await db('places').where({ id: 1 }).update({ address_changed_at: later });

    const dayView = await loadDraftDayView(db, draftId, DATE_A);
    assert.deepEqual(findingsFor(dayView.committed.find((v) => v.place_id === 1)), [{ type: 'ADDRESS_CHANGED', severity: 'soft', placeId: 1 }]);
    assert.equal(findingsFor(dayView.committed.find((v) => v.place_id === 2)).length, 0);

    const fullView = await loadDraftView(db, draftId);
    assert.deepEqual(findingsFor(fullView.days[0].committed.find((v) => v.place_id === 1)), [{ type: 'ADDRESS_CHANGED', severity: 'soft', placeId: 1 }]);
  });
});

// day.committed feeds RoutePlanner.jsx's "Already Planned"/"Planned" list,
// which renders every row under a hardcoded "✓ Planned" badge - so
// committedVisitsQuery must only ever return status:'planned' rows, the same
// scope committedDayVisits (PlannedDayModal's own query) already uses. Before
// this fix it had no status filter at all: a completed (or skipped) visit
// sharing the date leaked in and rendered as a second, mislabeled "✓
// Planned" entry for a trip that already happened.
describe('loadDraftView / loadDraftDayView - day.committed is planned-only', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert({ id: 1, name: 'Guardian Angels (Test)', category: 'Community Partners', lat: 41.9, lng: -87.6 });
  });

  after(async () => {
    await db.destroy();
  });

  test('loadDraftView: two completed visits at the same place/date never appear in day.committed', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    // Two separate completed trips, same rep, same place, same day - exactly
    // the "logged twice while testing" shape that surfaced this bug.
    await db('visits').insert([
      { place_id: 1, user_id: 1, status: 'completed', scheduled_date: DATE_A, place_name: 'Guardian Angels (Test)', notes: 'This was great' },
      { place_id: 1, user_id: 1, status: 'completed', scheduled_date: DATE_A, place_name: 'Guardian Angels (Test)', notes: 'test' },
    ]);

    const view = await loadDraftView(db, draftId);
    assert.deepEqual(view.days[0].committed, [], 'completed visits must not appear in day.committed at all - that list is planned-only');
  });

  test('loadDraftView: a genuinely planned visit still appears in day.committed', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Guardian Angels (Test)' });

    const view = await loadDraftView(db, draftId);
    assert.equal(view.days[0].committed.length, 1);
    assert.equal(view.days[0].committed[0].status, 'planned');
  });

  test('loadDraftDayView: same planned-only scope as loadDraftView', async () => {
    // Its own date - DATE_A already carries a leftover 'planned' visit from
    // the previous test in this shared in-memory db (same before()-not-
    // beforeEach() pattern the rest of this file uses), which is correct and
    // irrelevant here, but would collide with this test's own "must be empty"
    // assertion if reused.
    const DATE_C = '2026-08-12';
    const params = { days: [{ date: DATE_C, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    await db('visits').insert([
      { place_id: 1, user_id: 1, status: 'completed', scheduled_date: DATE_C, place_name: 'Guardian Angels (Test)' },
      { place_id: 1, user_id: 1, status: 'skipped', scheduled_date: DATE_C, place_name: 'Guardian Angels (Test)' },
    ]);

    const view = await loadDraftDayView(db, draftId, DATE_C);
    assert.deepEqual(view.committed, [], 'completed and skipped visits must not appear in day.committed');
  });
});

// evaluateDay's committed-segment fix: a day's already-planned real visits
// must count against the budget AND shift where the first proposed stop's
// drive time is measured from - see evaluateDay's own header for the full
// rationale. The place_distance cache is empty in this in-memory test DB,
// so every leg falls back to matrixCache's geometric estimate -
// deterministic and offline by construction, same as the describe blocks
// above.
describe('evaluateDay via loadDraftView - committed visits count against the budget and shift the drive-time start point', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };
  const PLACE_A = { lat: 41.9, lng: -87.6 }; // committed visit's place
  const PLACE_B = { lat: 42.0, lng: -87.9 }; // proposed stop's place - far enough from PLACE_A, in a different direction from homeBase, that "drive from home" and "drive from PLACE_A" can't coincidentally match

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Committed Place', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'Proposed Place', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test("a committed visit's time counts against the day total, and the proposed stop's drive time starts from it, not homeBase", async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: HOME_BASE, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 0, visit_type: 'drop_in' });
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Committed Place', visit_type: 'presentation' });

    const view = await loadDraftView(db, draftId);
    const day = view.days[0];

    // Committed segment: home -> Place A, presentation (60) + prep(3) + dataEntry(5).
    const committedDrive = await fallbackDriveMinutes(db, HOME_BASE, PLACE_A);
    const committedBlock = committedDrive + 60 + 3 + 5;

    // The whole point of this fix: the proposed stop's drive time must
    // originate from Place A (where the committed visit leaves the rep),
    // not homeBase.
    const driveFromCommitted = await fallbackDriveMinutes(db, PLACE_A, PLACE_B);
    const driveFromHome = await fallbackDriveMinutes(db, HOME_BASE, PLACE_B);
    assert.notEqual(driveFromCommitted, driveFromHome, 'test coordinates must actually produce different drive times, or this assertion proves nothing');

    const proposedStop = day.stops.find((s) => s.place_id === 2);
    assert.equal(proposedStop.driveMinutes, driveFromCommitted);

    const proposedBlock = driveFromCommitted + 7 /* drop_in */ + 3 + 5;
    assert.equal(day.totalMinutes, committedBlock + proposedBlock, 'totalMinutes must be the WHOLE day (committed + proposed), not just the proposal');
    assert.equal(day.remainingMinutes, 4 * 60 - (committedBlock + proposedBlock));
  });

  test('committed visits alone can already exceed the budget, with zero proposed stops', async () => {
    const DATE_B = '2026-08-11';
    const params = { days: [{ date: DATE_B, hoursPerDay: 1 }], homeBase: HOME_BASE, zoneOverrides: {} }; // 60-minute budget
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_B, place_name: 'Committed Place', visit_type: 'presentation' });

    const view = await loadDraftView(db, draftId);
    const day = view.days[0];
    assert.equal(day.stops.length, 0, 'nothing proposed for this day');
    assert.ok(day.totalMinutes > 60, 'the committed presentation alone already exceeds a 1-hour budget');
    assert.equal(day.overBudget, true);
  });
});

// Regression test for a real bug caught while building checkpoint 5:
// evaluateDay's committed/proposed stop objects (place_id, no `.id` - see
// their construction above) never matched a place_distance row before
// routeOptimizer.js's withMatrixId fix, so this whole path silently used
// ONLY the geometric fallback, no matter how complete the backfill was. The
// describe block above never caught this because its cache is always empty
// by construction - both the buggy and fixed code produce the same fallback
// number against an empty cache. This uses a real cached row instead, with a
// value nowhere near the geometric estimate, so a regression is unmistakable.
describe('evaluateDay via loadDraftView - real cached distances actually reach the day (checkpoint 5 regression)', () => {
  let db;
  const DATE_A = '2026-08-10';
  const HOME_BASE = { lat: 41.85, lng: -87.65 };
  const PLACE_A = { lat: 41.9, lng: -87.6 }; // committed visit's place
  const PLACE_B = { lat: 42.0, lng: -87.9 }; // proposed stop's place

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert({ id: 1, name: 'Bede', email: 'bede@test.local' });
    await db('places').insert([
      { id: 1, name: 'Committed Place', category: 'Hospice', lat: PLACE_A.lat, lng: PLACE_A.lng },
      { id: 2, name: 'Proposed Place', category: 'Hospice', lat: PLACE_B.lat, lng: PLACE_B.lng },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db('schedule_draft_stops').del();
    await db('schedule_drafts').del();
    await db('visits').del();
    await db('place_distance').del();
  });

  test('a cached committed-place -> proposed-place distance is used instead of the geometric fallback, and usedFallback stays false (the only uncached leg is the never-cacheable home leg)', async () => {
    // Deliberately absurd - unmistakable if the real row is read at all.
    await db('place_distance').insert([{ from_place_id: 1, to_place_id: 2, meters: 999999, seconds: 99999 }]);

    const params = { days: [{ date: DATE_A, hoursPerDay: 100 }], homeBase: HOME_BASE, zoneOverrides: {} }; // huge budget, nothing gets dropped for time
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 0, visit_type: 'drop_in' });
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Committed Place', visit_type: 'presentation' });

    const view = await loadDraftView(db, draftId);
    const day = view.days[0];
    const proposedStop = day.stops.find((s) => s.place_id === 2);

    assert.equal(proposedStop.driveMinutes, Math.round(99999 / 60), 'the real cached value must be used, not the geometric fallback');
    assert.equal(day.usedFallback, false, 'the home leg is the only uncached one, and must not trip the flag on its own');
  });

  test('with no cached row at all, usedFallback is true (both a real committed-segment gap and a real proposed-segment gap)', async () => {
    await db('place_distance').del();
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify({ days: [{ date: DATE_A, hoursPerDay: 100 }], homeBase: HOME_BASE, zoneOverrides: {} }) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 0, visit_type: 'drop_in' });
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'planned', scheduled_date: DATE_A, place_name: 'Committed Place', visit_type: 'presentation' });

    const view = await loadDraftView(db, draftId);
    assert.equal(view.days[0].usedFallback, true);
  });
});

// commitDay's per-row insert loop wraps each `visits` insert in its own
// nested transaction (a savepoint) specifically so a Postgres unique-
// constraint violation aborts only that one nested transaction, not the
// whole `trx` the day's commit runs in (25P02 "transaction is aborted" -
// see the comment above the loop in scheduleDraft.js). SQLite (what this
// suite runs against) never enters that aborted state, so this can't
// reproduce the literal Postgres bug - but it does prove the loop's
// collision-recovery behavior (a row that loses the unique-constraint race
// gets skipped into raceCollisions while every other row in the same call
// still commits, AND the rest of the outer transaction's own statements
// still run to completion afterward) survives being restructured through
// `trx.transaction(async (sp) => ...)` savepoints instead of bare inserts
// against `trx`.
//
// A genuine two-rows-same-place-and-date collision can't be constructed by
// simply giving one draft two stops for the same place: schedule_draft_stops
// has its own unique(['draft_id', 'place_id']) constraint (see
// 20260715000000_add_schedule_drafts.js), so a place can only ever appear
// once in a given draft - commitDay's own `rows` query can therefore never
// see a same-place duplicate. The real race this fix targets is genuinely
// cross-transaction (two different reps' drafts, two different `commitDay`
// calls, racing each other), which SQLite's single-writer connection
// serializes away entirely - there's no way to land a real competing insert
// in the gap between commitDay's own precheck and its own insert using a
// second, truly concurrent transaction under this driver.
//
// `wrapForRaceInjection` simulates that gap deterministically instead: it
// intercepts the FIRST `visits` insert for a chosen place_id and, immediately
// before letting it proceed, performs an equivalent side-channel insert
// using that exact same (sub)transaction connection - standing in for
// "another rep's commit landed first." commitDay's own insert then hits the
// REAL visits_place_date_active_unique partial index and fails with a
// genuine SQLITE_CONSTRAINT_UNIQUE, exercising the actual try/catch and
// isUniqueViolation classification, not a synthetic/mocked error.
function wrapForRaceInjection(knexLike, targetPlaceId, injectedRef) {
  const wrapped = (table, ...rest) => {
    const qb = knexLike(table, ...rest);
    if (table === 'visits') {
      const originalInsert = qb.insert.bind(qb);
      qb.insert = async (row) => {
        if (!injectedRef.done && row.place_id === targetPlaceId) {
          injectedRef.done = true;
          // The "competing" insert - same shape, same (place_id,
          // scheduled_date, status, source), so it lands in the exact same
          // partial-index slot commitDay's own insert is about to claim.
          await knexLike('visits').insert({ ...row });
        }
        return originalInsert(row);
      };
    }
    return qb;
  };
  // Recurse so the savepoint transaction the fix opens per row
  // (trx.transaction(async (sp) => ...)) is wrapped the same way - the
  // injection has to fire on whichever level actually issues the insert.
  wrapped.transaction = (cb) => knexLike.transaction((trx) => cb(wrapForRaceInjection(trx, targetPlaceId, injectedRef)));
  return wrapped;
}

describe('commitDay - per-row collision recovery in the insert loop', () => {
  let db;
  const DATE_A = '2026-08-20';

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
    });
    await db.migrate.latest();
    await db('users').insert([{ id: 1, name: 'Bede', email: 'bede@test.local' }]);
    await db('places').insert([
      { id: 1, name: 'Colliding Place', category: 'Hospice', lat: 41.9, lng: -87.6 },
      { id: 2, name: 'Clean Place', category: 'Hospice', lat: 41.8, lng: -87.7 },
    ]);
  });

  after(async () => {
    await db.destroy();
  });

  test('a row that loses a same-transaction unique-constraint race is skipped; every other row in the same call still commits', async () => {
    const params = { days: [{ date: DATE_A, hoursPerDay: 4 }], homeBase: { lat: 41.85, lng: -87.65 }, zoneOverrides: {} };
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify(params) }).returning('id');
    const draftId = draftRow && draftRow.id ? draftRow.id : draftRow;

    await db('schedule_draft_stops').insert([
      { draft_id: draftId, place_id: 1, date: DATE_A, sort_order: 0, visit_type: 'drop_in' },
      { draft_id: draftId, place_id: 2, date: DATE_A, sort_order: 1, visit_type: 'drop_in' },
    ]);

    const injectedRef = { done: false };
    const raceDb = wrapForRaceInjection(db, 1, injectedRef);

    const result = await commitDay({ draftId, userId: 1, date: DATE_A, db: raceDb });

    assert.equal(injectedRef.done, true, 'the injection must actually have fired, or this test proves nothing');

    // Place 1 lost the race (its real insert hit the constraint the
    // side-channel insert just claimed); place 2 - processed in the same
    // loop, after place 1 - must still commit rather than the whole day's
    // commit rolling back, which is exactly the bug the savepoint fix
    // prevents on Postgres (25P02 poisoning the enclosing transaction).
    assert.deepEqual(result.committed.map((r) => r.place_id), [2]);
    assert.equal(result.skippedCollisions.length, 1);
    assert.equal(result.skippedCollisions[0].place_id, 1);

    // The outer transaction itself must still be healthy after the
    // collision: schedule_draft_stops for this date was cleared (a
    // statement that runs on `trx` AFTER the insert loop) and the real
    // `visits` table shows exactly the winning row.
    const remainingStops = await db('schedule_draft_stops').where({ draft_id: draftId, date: DATE_A });
    assert.equal(remainingStops.length, 0, 'post-loop trx statements must still execute - proof trx was never left in an aborted state');

    const visits = await db('visits').where({ scheduled_date: DATE_A, source: 'planner' }).select('place_id');
    assert.deepEqual(visits.map((v) => v.place_id), [2], 'only the winning row actually persisted');
  });
});
