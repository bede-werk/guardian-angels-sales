const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../config/scheduling');
const { findCrossRepFloorWarning, attachCrossRepFloorWarnings } = require('./crossRepFloorWarning');

const TODAY = '2026-07-10';

function visit(overrides = {}) {
  return {
    id: 1,
    place_id: 100,
    user_id: 1,
    scheduled_date: TODAY,
    status: 'planned',
    ...overrides,
  };
}

describe('findCrossRepFloorWarning', () => {
  test('cross-rep, within the window -> flags with the nearest other visit', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const other = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-08' });

    const warning = findCrossRepFloorWarning(target, [target, other], config);

    assert.deepEqual(warning, { userName: 'Jane Rep', scheduledDate: '2026-07-08', visitId: 2, status: 'planned' });
  });

  test('same-rep, any gap -> never flags', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const sameRep = visit({ id: 2, user_id: 1, user_name: 'Same Rep', scheduled_date: '2026-07-09' });

    assert.equal(findCrossRepFloorWarning(target, [target, sameRep], config), null);
  });

  test('exactly HARD_FLOOR_DAYS apart -> does not flag (boundary is strict <)', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const other = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-05' }); // 5 days, HARD_FLOOR_DAYS

    assert.equal(config.HARD_FLOOR_DAYS, 5);
    assert.equal(findCrossRepFloorWarning(target, [target, other], config), null);
  });

  test('HARD_FLOOR_DAYS - 1 apart -> flags (just inside the window)', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const other = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-06' }); // 4 days

    const warning = findCrossRepFloorWarning(target, [target, other], config);
    assert.equal(warning.userName, 'Jane Rep');
  });

  test('a skipped candidate visit -> excluded, no flag', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const skipped = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-09', status: 'skipped' });

    // Query layer normally filters skipped rows out before this ever runs;
    // this asserts the pure function is defensive on its own too.
    assert.equal(findCrossRepFloorWarning(target, [target, skipped], config), null);
  });

  test('target visit itself is skipped -> never flags, regardless of neighbors', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10', status: 'skipped' });
    const other = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-09' });

    assert.equal(findCrossRepFloorWarning(target, [target, other], config), null);
  });

  test('self-row present in candidates -> excluded by id, not mistaken for a collision', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });

    assert.equal(findCrossRepFloorWarning(target, [target], config), null);
  });

  test('multiple colliding candidates -> picks the nearest one', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const far = visit({ id: 2, user_id: 2, user_name: 'Far Rep', scheduled_date: '2026-07-07' }); // 3 days
    const near = visit({ id: 3, user_id: 3, user_name: 'Near Rep', scheduled_date: '2026-07-09' }); // 1 day

    const warning = findCrossRepFloorWarning(target, [target, far, near], config);
    assert.equal(warning.userName, 'Near Rep');
  });

  test('carries the other visit\'s status -> lets callers tell planned from completed', () => {
    const target = visit({ id: 1, user_id: 1, scheduled_date: '2026-07-10' });
    const other = visit({ id: 2, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-08', status: 'completed' });

    const warning = findCrossRepFloorWarning(target, [target, other], config);
    assert.equal(warning.status, 'completed');
  });

  test('missing user_id or scheduled_date on the target -> returns null', () => {
    const other = visit({ id: 2, user_id: 2, scheduled_date: '2026-07-09' });

    assert.equal(findCrossRepFloorWarning(visit({ id: 1, user_id: null }), [other], config), null);
    assert.equal(findCrossRepFloorWarning(visit({ id: 1, scheduled_date: null }), [other], config), null);
  });
});

describe('attachCrossRepFloorWarnings', () => {
  test('maps per-visit warnings by place without mutating the input', () => {
    const v1 = visit({ id: 1, place_id: 100, user_id: 1, scheduled_date: '2026-07-10' });
    const v2 = visit({ id: 2, place_id: 100, user_id: 2, user_name: 'Jane Rep', scheduled_date: '2026-07-09' });
    const byPlace = new Map([[100, [v1, v2]]]);

    const result = attachCrossRepFloorWarnings([v1, v2], byPlace, config);

    assert.equal(result[0].crossRepFloorWarning.userName, 'Jane Rep');
    assert.equal(result[1].crossRepFloorWarning.userName, 'another rep'); // v1 has no user_name override -> falls back
    assert.equal(v1.crossRepFloorWarning, undefined); // original input untouched
  });
});
