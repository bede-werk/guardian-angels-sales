const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { mergeLockedElsewhereIds, partitionCommittableStops } = require('./scheduleDraft');

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
