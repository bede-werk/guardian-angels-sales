const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const {
  createCommitment,
  getOutstandingCommitments,
  getOutstandingCommitmentsForPlaces,
  getBindingCommitment,
  getBindingCommitmentsForPlaces,
  fulfillCommitment,
  waiveCommitment,
  rescheduleCommitment,
  deleteCommitment,
  attachCommitmentsMade,
} = require('./placeCommitments');

describe('placeCommitments', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
      // Matches knexfile.js's development pool hook - SQLite ignores FK
      // constraints (CASCADE/SET NULL included) unless this is set per
      // connection. Needed here specifically for the cascade tests below.
      pool: {
        afterCreate: (conn, done) => {
          conn.pragma('foreign_keys = ON');
          done(null, conn);
        },
      },
    });
    await db.migrate.latest();
  });

  after(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Full reset between tests rather than transaction-per-test: reschedule/
    // waive use their own transactions internally, and nesting those inside
    // an outer per-test transaction is more trouble than truncating.
    await db('place_commitments').del();
    await db('visits').del();
    await db('people').del();
    await db('places').del();
    await db('users').del();

    await db('users').insert({ id: 1, name: 'Test Rep', email: 'rep@test.local' });
    await db('places').insert([
      { id: 1, name: 'Place One', category: 'Hospice' },
      { id: 2, name: 'Place Two', category: 'Hospice' },
    ]);
    await db('people').insert({ id: 1, place_id: 1, name: 'Sharon Klein' });
  });

  test('earliest binds: three outstanding commitments -> binding is the earliest promised_date, not the earliest created', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-09-01' });
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });

    const binding = await getBindingCommitment(db, 1);
    assert.equal(binding.promised_date, '2026-08-15');
  });

  test('date order, not FIFO: created Aug 25 first, then Aug 20 -> binding is Aug 20', async () => {
    const first = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-25' });
    const second = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    assert.ok(second.id > first.id, 'sanity check: second really was created after first');

    const binding = await getBindingCommitment(db, 1);
    assert.equal(binding.promised_date, '2026-08-20');
    assert.equal(binding.id, second.id);
  });

  test('no outstanding commitments -> binding is null', async () => {
    assert.equal(await getBindingCommitment(db, 1), null);
  });

  test('getOutstandingCommitments lists every outstanding row for the place, earliest first, and ignores other places', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-25' });
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    await createCommitment(db, { placeId: 2, promisedDate: '2026-08-10' });

    const rows = await getOutstandingCommitments(db, 1);
    assert.deepEqual(rows.map((r) => r.promised_date), ['2026-08-15', '2026-08-25']);
  });

  test('fulfillment discharges: fulfilling a commitment sets discharged_at/discharge_reason/discharged_by_visit_id and drops it from outstanding', async () => {
    const [visitId] = await db('visits')
      .insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-20' })
      .returning('id');
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });

    const discharged = await fulfillCommitment(db, commitment.id, {
      dischargedByVisitId: visitId.id ?? visitId,
    });

    assert.ok(discharged.discharged_at);
    assert.equal(discharged.discharge_reason, 'fulfilled');
    assert.equal(discharged.discharged_by_visit_id, visitId.id ?? visitId);
    assert.equal(await getBindingCommitment(db, 1), null);
  });

  test('the retirement bug, named explicitly: fulfilling the commitment that a place was due on removes it from the binding query entirely', async () => {
    // This is the regression this whole feature exists to fix: under
    // visits.next_visit_date, nothing retired a kept promise, so a place
    // visited exactly on its promised date stayed pinned to the top of
    // every generated route forever. Guard: after fulfillment, the place
    // must not still resolve to a binding commitment.
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    await fulfillCommitment(db, commitment.id, {});

    const binding = await getBindingCommitment(db, 1);
    assert.equal(binding, null, 'a fulfilled commitment must not still bind the place');
  });

  test('fulfilling a future-dated commitment is allowed: the service does not gate on due date, the caller decides what to check', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2999-01-01' });
    const discharged = await fulfillCommitment(db, commitment.id, {});
    assert.equal(discharged.discharge_reason, 'fulfilled');
  });

  test('partial discharge: fulfilling one outstanding commitment leaves a second one at the same place untouched', async () => {
    const past = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-01' });
    const future = await createCommitment(db, { placeId: 1, promisedDate: '2026-09-01' });

    await fulfillCommitment(db, past.id, {});

    const binding = await getBindingCommitment(db, 1);
    assert.equal(binding.id, future.id, 'the future commitment is now the only outstanding one, and binds');
  });

  test('fulfilling an already-discharged commitment is a no-op: returns null, does not overwrite the original discharge', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    await waiveCommitment(db, commitment.id, { note: 'closing early' });

    const result = await fulfillCommitment(db, commitment.id, {});
    assert.equal(result, null);

    const row = await db('place_commitments').where({ id: commitment.id }).first();
    assert.equal(row.discharge_reason, 'waived', 'the original waive must survive an attempted re-discharge');
  });

  test('reschedule chain: original discharged superseded with superseded_by_id set, new commitment outstanding, only one outstanding at a time', async () => {
    const original = await createCommitment(db, {
      placeId: 1,
      promisedDate: '2026-08-20',
      personId: 1,
      note: 'asked for the DON specifically',
    });

    const rescheduled = await rescheduleCommitment(db, original.id, { promisedDate: '2026-08-27' });

    const originalRow = await db('place_commitments').where({ id: original.id }).first();
    assert.equal(originalRow.discharge_reason, 'superseded');
    assert.ok(originalRow.discharged_at);
    assert.equal(originalRow.superseded_by_id, rescheduled.id);

    assert.equal(rescheduled.discharged_at, null);
    assert.equal(rescheduled.promised_date, '2026-08-27');
    // person_id/note carried forward since the call didn't override them.
    assert.equal(rescheduled.person_id, 1);
    assert.equal(rescheduled.note, 'asked for the DON specifically');

    const outstanding = await getOutstandingCommitments(db, 1);
    assert.equal(outstanding.length, 1, 'exactly one outstanding commitment survives a reschedule');
    assert.equal(outstanding[0].id, rescheduled.id);
  });

  test('reschedule accepts overrides for person_id and note instead of always carrying the original forward', async () => {
    const original = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20', personId: 1, note: 'original note' });
    const rescheduled = await rescheduleCommitment(db, original.id, {
      promisedDate: '2026-08-27',
      personId: null,
      note: 'new note',
    });
    assert.equal(rescheduled.person_id, null);
    assert.equal(rescheduled.note, 'new note');
  });

  test('rescheduling an already-discharged commitment returns null and creates nothing new', async () => {
    const original = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    await waiveCommitment(db, original.id, {});

    const result = await rescheduleCommitment(db, original.id, { promisedDate: '2026-09-01' });
    assert.equal(result, null);

    const countAfter = await db('place_commitments').where({ place_id: 1 }).count('id as n').first();
    assert.equal(countAfter.n, 1, 'no new row should have been inserted');
  });

  test('waive falls back to normal cadence: a place with only a waived commitment has no binding commitment', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    const waived = await waiveCommitment(db, commitment.id, { note: 'place is closing' });

    assert.equal(waived.discharge_reason, 'waived');
    assert.ok(waived.discharged_at);
    assert.equal(await getBindingCommitment(db, 1), null);
  });

  test('waive appends an optional reason note rather than clobbering the original promise note', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20', note: 'promised to the DON' });
    const waived = await waiveCommitment(db, commitment.id, { note: 'place is closing' });
    assert.match(waived.note, /promised to the DON/);
    assert.match(waived.note, /place is closing/);
  });

  test('waive with no reason note leaves the original note untouched', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20', note: 'promised to the DON' });
    const waived = await waiveCommitment(db, commitment.id, {});
    assert.equal(waived.note, 'promised to the DON');
  });

  test('delete refuses an outstanding commitment', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    const ok = await deleteCommitment(db, commitment.id);
    assert.equal(ok, false);
    assert.ok(await db('place_commitments').where({ id: commitment.id }).first(), 'row should still exist');
  });

  test('delete removes a discharged commitment', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    await waiveCommitment(db, commitment.id, {});
    const ok = await deleteCommitment(db, commitment.id);
    assert.equal(ok, true);
    assert.equal(await db('place_commitments').where({ id: commitment.id }).first(), undefined);
  });

  test('delete is a no-op on an id that does not exist', async () => {
    const ok = await deleteCommitment(db, 999999);
    assert.equal(ok, false);
  });

  test('deleting a superseded row clears the earlier row\'s superseded_by_id instead of failing', async () => {
    const original = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20' });
    const rescheduled = await rescheduleCommitment(db, original.id, { promisedDate: '2026-09-01' });
    await waiveCommitment(db, rescheduled.id, {});

    const ok = await deleteCommitment(db, rescheduled.id);
    assert.equal(ok, true);

    const originalAfter = await db('place_commitments').where({ id: original.id }).first();
    assert.equal(originalAfter.superseded_by_id, null);
  });

  test('getBindingCommitmentsForPlaces returns the earliest outstanding row per place in one query, keyed by place_id', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-25' });
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    await createCommitment(db, { placeId: 2, promisedDate: '2026-08-10' });

    const map = await getBindingCommitmentsForPlaces(db, [1, 2]);
    assert.equal(map.get(1).promised_date, '2026-08-15');
    assert.equal(map.get(2).promised_date, '2026-08-10');
  });

  test('getBindingCommitmentsForPlaces omits places with no outstanding commitment', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    const map = await getBindingCommitmentsForPlaces(db, [1, 2]);
    assert.ok(map.has(1));
    assert.ok(!map.has(2));
  });

  test('getBindingCommitmentsForPlaces with no placeIds argument covers every place', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    await createCommitment(db, { placeId: 2, promisedDate: '2026-08-10' });
    const map = await getBindingCommitmentsForPlaces(db);
    assert.equal(map.size, 2);
  });

  test('getOutstandingCommitmentsForPlaces returns every outstanding row per place, earliest first, joined to the person name', async () => {
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-25' });
    await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15', personId: 1 });
    await createCommitment(db, { placeId: 2, promisedDate: '2026-08-10' });

    const byPlace = await getOutstandingCommitmentsForPlaces(db, [1, 2]);
    assert.deepEqual(byPlace.get(1).map((r) => r.promised_date), ['2026-08-15', '2026-08-25']);
    assert.equal(byPlace.get(1)[0].person_name, 'Sharon Klein');
    assert.equal(byPlace.get(2).length, 1);
  });

  test('getOutstandingCommitmentsForPlaces omits places with nothing outstanding and excludes discharged rows', async () => {
    const c = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-15' });
    await waiveCommitment(db, c.id, {});
    const byPlace = await getOutstandingCommitmentsForPlaces(db, [1, 2]);
    assert.ok(!byPlace.has(1));
    assert.ok(!byPlace.has(2));
  });

  test('cascade: deleting the source visit leaves the commitment intact with source_visit_id null', async () => {
    const [visitId] = await db('visits')
      .insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-20' })
      .returning('id');
    const id = visitId.id ?? visitId;
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-27', sourceVisitId: id });

    await db('visits').where({ id }).del();

    const row = await db('place_commitments').where({ id: commitment.id }).first();
    assert.ok(row, 'the commitment itself must survive the visit being deleted');
    assert.equal(row.source_visit_id, null);
    assert.equal(row.promised_date, '2026-08-27', 'and it is still a real, live outstanding commitment');
  });

  test('deleting the place detaches its commitments instead of destroying them (place_id -> null, row survives)', async () => {
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-27' });
    await db('places').where({ id: 1 }).del();
    const row = await db('place_commitments').where({ id: commitment.id }).first();
    assert.notEqual(row, undefined);
    assert.equal(row.place_id, null);
  });

  test('attachCommitmentsMade: a visit that promised a next visit shows it, joined to the person name', async () => {
    const [visitRow] = await db('visits')
      .insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-11' })
      .returning('id');
    const visitId = visitRow.id ?? visitRow;
    const commitment = await createCommitment(db, {
      placeId: 1,
      promisedDate: '2026-08-20',
      personId: 1,
      sourceVisitId: visitId,
    });

    const [decorated] = await attachCommitmentsMade(db, [{ id: visitId }]);
    assert.equal(decorated.commitments_made.length, 1);
    assert.equal(decorated.commitments_made[0].id, commitment.id);
    assert.equal(decorated.commitments_made[0].promised_date, '2026-08-20');
    assert.equal(decorated.commitments_made[0].person_name, 'Sharon Klein');
  });

  test('attachCommitmentsMade: a visit that made no promise gets an empty array, not null', async () => {
    const [visitRow] = await db('visits')
      .insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-11' })
      .returning('id');
    const visitId = visitRow.id ?? visitRow;
    const [decorated] = await attachCommitmentsMade(db, [{ id: visitId }]);
    assert.deepEqual(decorated.commitments_made, []);
  });

  test('attachCommitmentsMade: includes a DISCHARGED commitment too - history should still show what was promised, even once resolved', async () => {
    const [visitRow] = await db('visits')
      .insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-11' })
      .returning('id');
    const visitId = visitRow.id ?? visitRow;
    const commitment = await createCommitment(db, { placeId: 1, promisedDate: '2026-08-20', sourceVisitId: visitId });
    await waiveCommitment(db, commitment.id, { note: 'closing' });

    const [decorated] = await attachCommitmentsMade(db, [{ id: visitId }]);
    assert.equal(decorated.commitments_made.length, 1);
    assert.equal(decorated.commitments_made[0].discharge_reason, 'waived');
  });

  test('attachCommitmentsMade: deleting the source visit does not orphan the array lookup - cascade already nulled source_visit_id', async () => {
    // Belt-and-suspenders: confirms attachCommitmentsMade simply finds
    // nothing for a visit id that no longer has any commitment pointing at
    // it (whether because none was ever made, or because the FK already
    // went null on delete) rather than erroring.
    const result = await attachCommitmentsMade(db, [{ id: 999999 }]);
    assert.deepEqual(result[0].commitments_made, []);
  });
});
