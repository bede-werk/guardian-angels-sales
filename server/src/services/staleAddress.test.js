const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isAddressStale, staleAddressFinding } = require('./staleAddress');

describe('isAddressStale', () => {
  test('true when the place changed address after the reference timestamp', () => {
    assert.equal(isAddressStale({ address_changed_at: '2026-08-20T00:00:00Z' }, '2026-08-10T00:00:00Z'), true);
  });

  test('false when the place changed address before the reference timestamp', () => {
    assert.equal(isAddressStale({ address_changed_at: '2026-08-01T00:00:00Z' }, '2026-08-10T00:00:00Z'), false);
  });

  test('false when they are exactly equal - the stop was set at the same moment the address was, not after', () => {
    assert.equal(isAddressStale({ address_changed_at: '2026-08-10T00:00:00Z' }, '2026-08-10T00:00:00Z'), false);
  });

  test('false with no place, no address_changed_at, or no reference timestamp - never crashes on a detached visit', () => {
    assert.equal(isAddressStale(null, '2026-08-10T00:00:00Z'), false);
    assert.equal(isAddressStale({ address_changed_at: null }, '2026-08-10T00:00:00Z'), false);
    assert.equal(isAddressStale({ address_changed_at: '2026-08-20T00:00:00Z' }, null), false);
  });

  test('accepts either Date objects or ISO strings on either side', () => {
    assert.equal(isAddressStale({ address_changed_at: new Date('2026-08-20') }, '2026-08-10T00:00:00Z'), true);
    assert.equal(isAddressStale({ address_changed_at: '2026-08-20T00:00:00Z' }, new Date('2026-08-10')), true);
  });

  // Regression test for a real bug this checkpoint's own first pass hit:
  // better-sqlite3 returns a knex.fn.now()-defaulted timestamp column as a
  // raw 'YYYY-MM-DD HH:MM:SS' string with NO timezone marker (it's UTC, but
  // nothing says so) - a bare `new Date(thatString)` parses it as LOCAL
  // time, silently shifting it by the server's UTC offset. Comparing two
  // values in the SAME shape cancels the shift out (both sides misparse the
  // same way), which is why this stayed invisible in the "same shape"
  // tests above - it only breaks when one side is that raw SQLite string
  // and the other is a real Date/epoch (e.g. an explicit `new Date()` write
  // elsewhere, or a Postgres-returned Date in a mixed-environment test).
  // This is the same bug CLASS as backfillQueue.js's next_attempt_at
  // comparison (checkpoint 3), recurring in a new place. Note: Postgres's
  // driver can't actually produce this mismatch for address_changed_at -
  // every timestamp column in this schema compiles to timestamptz (verified
  // against knex's own postgres column compiler, checkpoint 6 follow-up),
  // so pg always hands back a real Date. This test still matters because
  // better-sqlite3 - the only database this app currently runs against - is
  // exactly the driver that returns the raw string.
  test('a raw no-timezone SQLite timestamp string compared against a real Date is not silently misparsed as local time', () => {
    // A UTC instant, in the exact string shape better-sqlite3 hands back for
    // a knex.fn.now() default - no 'T', no 'Z', no offset.
    const sqliteStyleUtcString = '2026-08-26 21:12:19';
    // One second later, as a real Date/epoch (what an explicit `new Date()`
    // write, or Postgres's own driver, would hand back).
    const oneSecondLater = new Date(Date.UTC(2026, 7, 26, 21, 12, 20));
    assert.equal(
      isAddressStale({ address_changed_at: oneSecondLater }, sqliteStyleUtcString),
      true,
      'a Date genuinely one second after the SQLite string must read as later, not shifted by the local UTC offset'
    );
    // And the reverse: the string one second BEFORE the Date must not
    // register as stale.
    assert.equal(
      isAddressStale({ address_changed_at: sqliteStyleUtcString }, oneSecondLater),
      false
    );
  });
});

describe('staleAddressFinding', () => {
  test('returns null when the address is not stale', () => {
    assert.equal(staleAddressFinding({ id: 1, address_changed_at: '2026-08-01' }, '2026-08-10'), null);
  });

  test('returns an ADDRESS_CHANGED finding, carrying the place id, when stale', () => {
    const finding = staleAddressFinding({ id: 7, address_changed_at: '2026-08-20' }, '2026-08-10');
    assert.deepEqual(finding, { type: 'ADDRESS_CHANGED', severity: 'soft', placeId: 7 });
  });

  test('placeId is null rather than throwing when the place has no id', () => {
    const finding = staleAddressFinding({ address_changed_at: '2026-08-20' }, '2026-08-10');
    assert.equal(finding.placeId, null);
  });
});
