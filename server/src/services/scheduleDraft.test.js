const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLockedElsewhereIds, partitionCommittableStops, validateDays, MAX_PLAN_DATES } = require('./scheduleDraft');

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

  test('rejects a date that is today or earlier', () => {
    assert.throws(
      () => validateDays([{ date: TODAY, hoursPerDay: 4 }], { today: TODAY, committedDates: noCommitted }),
      /in the past/
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
