const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isDoNotVisitActive, doNotVisitFinding } = require('./doNotVisit');

const TODAY = '2026-08-25';

describe('isDoNotVisitActive', () => {
  test('an unflagged place is never active, whatever the until date says', () => {
    assert.equal(isDoNotVisitActive({ do_not_visit: false, do_not_visit_until: null }, TODAY), false);
    // A stale until-date left over from an already-lifted mark must not
    // resurrect it - do_not_visit is the switch, the date only caps it.
    assert.equal(isDoNotVisitActive({ do_not_visit: false, do_not_visit_until: '2099-01-01' }, TODAY), false);
  });

  test('no until date means indefinite', () => {
    assert.equal(isDoNotVisitActive({ do_not_visit: true, do_not_visit_until: null }, TODAY), true);
    assert.equal(isDoNotVisitActive({ do_not_visit: true }, TODAY), true);
  });

  test('the until-date boundary is inclusive - a mark runs through its last day', () => {
    assert.equal(isDoNotVisitActive({ do_not_visit: true, do_not_visit_until: '2026-08-26' }, TODAY), true);
    assert.equal(isDoNotVisitActive({ do_not_visit: true, do_not_visit_until: TODAY }, TODAY), true);
    assert.equal(isDoNotVisitActive({ do_not_visit: true, do_not_visit_until: '2026-08-24' }, TODAY), false);
  });

  test('a missing place is not active rather than a crash - a planned visit\'s place can be detached (place_id NULL)', () => {
    assert.equal(isDoNotVisitActive(null, TODAY), false);
    assert.equal(isDoNotVisitActive(undefined, TODAY), false);
  });
});

describe('doNotVisitFinding', () => {
  test('null when the mark is not live', () => {
    assert.equal(doNotVisitFinding({ id: 7, do_not_visit: false }, TODAY), null);
    assert.equal(doNotVisitFinding({ id: 7, do_not_visit: true, do_not_visit_until: '2026-08-24' }, TODAY), null);
  });

  test('a Conflict-shaped finding, so it can ride a Conflict[] straight to the client', () => {
    const finding = doNotVisitFinding({ id: 7, do_not_visit: true, do_not_visit_until: null }, TODAY);
    assert.deepEqual(finding, { type: 'DO_NOT_VISIT', severity: 'soft', placeId: 7 });
  });

  test("severity is 'soft' - every surface warns on this flag, none blocks", () => {
    assert.equal(doNotVisitFinding({ id: 1, do_not_visit: true }, TODAY).severity, 'soft');
  });
});
