const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLockedElsewhereIds, partitionCommittableStops, validateDays, deleteCommittedDay, MAX_PLAN_DATES, MAX_DAYS_AHEAD } = require('./scheduleDraft');

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
  // deleteCommittedDay isn't pure (it issues a real `visits` delete), and
  // nothing in this codebase's service-level tests spins up a real/mock Knex
  // DB (scheduleDraft.test.js and its siblings only exercise pure functions).
  // A minimal fake db that records the filter handed to `.where()` and lets
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
