const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { snoozeSwallowsCommitment } = require('./visitLifecycle');

describe('snoozeSwallowsCommitment()', () => {
  test('no commitment on file -> never a conflict', () => {
    assert.equal(snoozeSwallowsCommitment({ snoozedUntil: '2026-09-15', nextVisitDate: null }), false);
    assert.equal(snoozeSwallowsCommitment({ snoozedUntil: '2026-09-15', nextVisitDate: undefined }), false);
  });

  test('snoozedUntil strictly before the commitment -> not a conflict, the commitment still surfaces on its own first', () => {
    assert.equal(snoozeSwallowsCommitment({ snoozedUntil: '2026-08-20', nextVisitDate: '2026-09-01' }), false);
  });

  test('snoozedUntil on the commitment date itself -> a conflict (boundary is inclusive)', () => {
    assert.equal(snoozeSwallowsCommitment({ snoozedUntil: '2026-09-01', nextVisitDate: '2026-09-01' }), true);
  });

  test('snoozedUntil after the commitment -> a conflict', () => {
    assert.equal(snoozeSwallowsCommitment({ snoozedUntil: '2026-09-15', nextVisitDate: '2026-09-01' }), true);
  });
});
