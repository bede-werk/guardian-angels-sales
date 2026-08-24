const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const config = require('../config/scheduling');
const { daysSince, isCommitmentDue, isFloorConflict, detectConflictsPure, detectConflicts, detectConflictsForStops } = require('./conflictDetection');

const TODAY = '2026-07-10';

function daysAgo(n, today = TODAY) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

describe('daysSince', () => {
  test('matches the byte-identical implementation this was moved out of schedulingEngine.js', () => {
    assert.equal(daysSince('2026-07-05', '2026-07-10'), 5);
    assert.equal(daysSince('2026-07-10', '2026-07-10'), 0);
  });
});

describe('isCommitmentDue', () => {
  test('due when nextVisitDate is today or earlier', () => {
    assert.equal(isCommitmentDue({ nextVisitDate: TODAY, today: TODAY }), true);
    assert.equal(isCommitmentDue({ nextVisitDate: daysAgo(1), today: TODAY }), true);
  });
  test('not due when nextVisitDate is in the future, or absent', () => {
    assert.equal(isCommitmentDue({ nextVisitDate: daysAgo(-1), today: TODAY }), false);
    assert.equal(isCommitmentDue({ nextVisitDate: null, today: TODAY }), false);
  });
});

describe('isFloorConflict', () => {
  test('ineligible under HARD_FLOOR_DAYS, eligible at and beyond the boundary - same cases schedulingEngine.test.js asserts through eligibility()', () => {
    assert.ok(isFloorConflict({ lastVisitDate: daysAgo(3), today: TODAY, config }));
    assert.equal(isFloorConflict({ lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS), today: TODAY, config }), null);
    assert.equal(isFloorConflict({ lastVisitDate: daysAgo(config.HARD_FLOOR_DAYS + 1), today: TODAY, config }), null);
  });
  test('no lastVisitDate -> no conflict', () => {
    assert.equal(isFloorConflict({ lastVisitDate: null, today: TODAY, config }), null);
  });
  test('reports daysApart', () => {
    assert.equal(isFloorConflict({ lastVisitDate: daysAgo(2), today: TODAY, config }).daysApart, 2);
  });

  // Step 3: this same function now also backs FLOOR_PLANNED, where the
  // "other" date routinely falls AFTER today, not just before - see the
  // header comment on the Math.abs fix.
  describe('bidirectional (Step 3 - FLOOR_PLANNED can be dated after today)', () => {
    test('a future date within the floor still conflicts', () => {
      const conflict = isFloorConflict({ lastVisitDate: daysAgo(-2), today: TODAY, config });
      assert.ok(conflict);
      assert.equal(conflict.daysApart, 2);
    });
    test('a future date at/beyond the boundary does not conflict', () => {
      assert.equal(isFloorConflict({ lastVisitDate: daysAgo(-config.HARD_FLOOR_DAYS), today: TODAY, config }), null);
    });
    test('without Math.abs this would have wrongly fired for ANY future date, no matter how far - regression guard', () => {
      assert.equal(isFloorConflict({ lastVisitDate: daysAgo(-30), today: TODAY, config }), null);
    });
  });
});

describe('detectConflictsPure', () => {
  test('no inputs -> no conflicts', () => {
    const conflicts = detectConflictsPure({ placeId: 1, today: TODAY, config });
    assert.deepEqual(conflicts, []);
  });

  test('SAME_DATE_VISIT: named, not suppressed by a commitment', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      nextVisitDate: TODAY, // commitment due
      sameDateVisit: { visitId: 9, userId: 2, userName: 'Sarah', status: 'planned', scheduledDate: TODAY },
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, 'SAME_DATE_VISIT');
    assert.equal(conflicts[0].otherUserName, 'Sarah');
    assert.equal(conflicts[0].severity, 'hard');
  });

  test('FLOOR_COMPLETED: named, with daysApart', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      lastVisitDate: daysAgo(2),
      lastVisitUserId: 3,
      lastVisitUserName: 'Marcus',
    });
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].type, 'FLOOR_COMPLETED');
    assert.equal(conflicts[0].otherUserName, 'Marcus');
    assert.equal(conflicts[0].daysApart, 2);
  });

  test('FLOOR_COMPLETED is suppressed when the most recent completed visit is dated today - same day already reported as SAME_DATE_VISIT, one collision, one warning', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      sameDateVisit: { visitId: 9, userId: 2, userName: 'Sarah', status: 'completed', scheduledDate: TODAY },
      lastVisitDate: TODAY,
      lastVisitId: 9,
      lastVisitUserId: 2,
      lastVisitUserName: 'Sarah',
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, 'SAME_DATE_VISIT');
  });

  test('FLOOR_COMPLETED is suppressed even when SAME_DATE_VISIT and the most recent completed visit are DIFFERENT rows that both happen to be dated today - two trips logged today, logging a third', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      // Two different visit ids, same date - e.g. the "same date" query and
      // the "most recent completed" query each picked a different one of two
      // trips already logged today.
      sameDateVisit: { visitId: 9, userId: 2, userName: 'Sarah', status: 'completed', scheduledDate: TODAY },
      lastVisitDate: TODAY,
      lastVisitId: 11,
      lastVisitUserId: 2,
      lastVisitUserName: 'Sarah',
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, 'SAME_DATE_VISIT');
  });

  test('FLOOR_COMPLETED is suppressed by a due commitment; SAME_DATE_VISIT is not', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      nextVisitDate: TODAY,
      lastVisitDate: daysAgo(2),
      sameDateVisit: { visitId: 9, userId: 2, userName: 'Sarah', status: 'planned', scheduledDate: TODAY },
    });
    assert.deepEqual(conflicts.map((c) => c.type), ['SAME_DATE_VISIT']);
  });

  test('no plannedVisits input -> no FLOOR_PLANNED', () => {
    const conflicts = detectConflictsPure({ placeId: 1, today: TODAY, config });
    assert.ok(!conflicts.some((c) => c.type === 'FLOOR_PLANNED'));
  });

  describe('FLOOR_PLANNED (Step 3)', () => {
    test('named, with daysApart, dated AFTER today (the common case - planned means not-yet-happened)', () => {
      const conflicts = detectConflictsPure({
        placeId: 1,
        today: TODAY,
        config,
        plannedVisits: [{ visitId: 11, userId: 4, userName: 'Priya', scheduledDate: daysAgo(-2) }],
      });
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].type, 'FLOOR_PLANNED');
      assert.equal(conflicts[0].otherUserName, 'Priya');
      assert.equal(conflicts[0].otherDate, daysAgo(-2));
      assert.equal(conflicts[0].daysApart, 2);
    });

    test('a planned visit outside the floor produces no conflict', () => {
      const conflicts = detectConflictsPure({
        placeId: 1,
        today: TODAY,
        config,
        plannedVisits: [{ visitId: 11, userId: 4, userName: 'Priya', scheduledDate: daysAgo(-30) }],
      });
      assert.ok(!conflicts.some((c) => c.type === 'FLOOR_PLANNED'));
    });

    test('more than one planned visit -> reports only the nearest', () => {
      const conflicts = detectConflictsPure({
        placeId: 1,
        today: TODAY,
        config,
        plannedVisits: [
          { visitId: 11, userId: 4, userName: 'Priya', scheduledDate: daysAgo(-4) },
          { visitId: 12, userId: 5, userName: 'Marcus', scheduledDate: daysAgo(-1) },
        ],
      });
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].sourceId, 12);
      assert.equal(conflicts[0].otherUserName, 'Marcus');
      assert.equal(conflicts[0].daysApart, 1);
    });

    test('suppressed by a due commitment, same as FLOOR_COMPLETED', () => {
      const conflicts = detectConflictsPure({
        placeId: 1,
        today: TODAY,
        config,
        nextVisitDate: TODAY,
        plannedVisits: [{ visitId: 11, userId: 4, userName: 'Priya', scheduledDate: daysAgo(-2) }],
      });
      assert.deepEqual(conflicts, []);
    });

    test('FLOOR_COMPLETED and FLOOR_PLANNED can both fire at once, for different other visits', () => {
      const conflicts = detectConflictsPure({
        placeId: 1,
        today: TODAY,
        config,
        lastVisitDate: daysAgo(2),
        lastVisitUserName: 'Marcus',
        plannedVisits: [{ visitId: 11, userId: 4, userName: 'Priya', scheduledDate: daysAgo(-2) }],
      });
      assert.deepEqual(conflicts.map((c) => c.type).sort(), ['FLOOR_COMPLETED', 'FLOOR_PLANNED']);
    });
  });

  test('DRAFT_ELSEWHERE: named, dated', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      draftElsewhere: { stopId: 5, userId: 4, userName: 'Priya', date: TODAY },
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, 'DRAFT_ELSEWHERE');
    assert.equal(conflicts[0].otherUserName, 'Priya');
  });

  test('OWN_DRAFT_DUPLICATE', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      ownDraftDuplicate: { stopId: 7, date: TODAY },
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].type, 'OWN_DRAFT_DUPLICATE');
  });

  test('all four active conflict types can surface at once, uncollapsed', () => {
    const conflicts = detectConflictsPure({
      placeId: 1,
      today: TODAY,
      config,
      sameDateVisit: { visitId: 9, userId: 2, userName: 'Sarah', status: 'planned', scheduledDate: TODAY },
      lastVisitDate: daysAgo(2),
      lastVisitUserId: 3,
      lastVisitUserName: 'Marcus',
      draftElsewhere: { stopId: 5, userId: 4, userName: 'Priya', date: TODAY },
      ownDraftDuplicate: { stopId: 7, date: TODAY },
    });
    assert.deepEqual(
      conflicts.map((c) => c.type).sort(),
      ['DRAFT_ELSEWHERE', 'FLOOR_COMPLETED', 'OWN_DRAFT_DUPLICATE', 'SAME_DATE_VISIT'].sort()
    );
  });
});

// The async half - real queries, real joins, real name resolution - had no
// caller at all until this step, so no test had ever actually run it against
// a database (the 14 cases above only exercise the pure core with hand-built
// inputs). Same in-memory-sqlite-with-real-migrations harness as
// scheduleDraft.test.js's buildCandidatePool fatigue-counting tests, because
// a fake/mocked `db` here would just prove the mock was self-consistent, not
// that the actual SQL is correct.
describe('detectConflicts (real DB)', () => {
  let db;
  const TARGET_DATE = '2026-08-10';

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
      { id: 1, name: 'Floor Test Place', category: 'Hospice' },
      { id: 2, name: 'Same Date Place', category: 'Hospice' },
      { id: 3, name: 'Draft Elsewhere Place', category: 'Hospice' },
      { id: 4, name: 'Skipped Same Date Place', category: 'Hospice' },
      { id: 5, name: 'Commitment Exempt Place', category: 'Hospice' },
      { id: 6, name: 'Untouched Place', category: 'Hospice' },
      { id: 7, name: 'Floor Planned Place', category: 'Hospice' },
      { id: 8, name: 'Two Trips Today Place', category: 'Hospice' },
    ]);

    // Place 1: Bede himself completed a visit 2 days before TARGET_DATE -
    // the exact P0 case: crossRepFloorWarning would swallow this (same rep),
    // detectConflicts must not.
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-08', place_name: 'Floor Test Place' });

    // Place 2: Sarah has a planned visit ON the target date itself.
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: TARGET_DATE, place_name: 'Same Date Place' });

    // Place 3: Sarah has an open draft with a stop on the target date.
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 2, params_json: JSON.stringify({ days: [{ date: TARGET_DATE, hoursPerDay: 4 }] }) }).returning('id');
    const sarahDraftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: sarahDraftId, place_id: 3, date: TARGET_DATE, sort_order: 0 });

    // Bede's own draft, with place 6 already in it (any date) - for
    // OWN_DRAFT_DUPLICATE.
    const [bedeDraftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify({ days: [{ date: TARGET_DATE, hoursPerDay: 4 }] }) }).returning('id');
    db.bedeDraftId = bedeDraftRow && bedeDraftRow.id ? bedeDraftRow.id : bedeDraftRow;
    await db('schedule_draft_stops').insert({ draft_id: db.bedeDraftId, place_id: 6, date: '2026-08-01', sort_order: 0 });

    // Place 4: a SKIPPED visit on the target date - must not produce
    // SAME_DATE_VISIT (amendment 1's fix, ported into detectConflicts since Step 1).
    await db('visits').insert({ place_id: 4, user_id: 2, status: 'skipped', scheduled_date: TARGET_DATE, place_name: 'Skipped Same Date Place' });

    // Place 5: Bede completed a visit 2 days before TARGET_DATE, but the
    // place also has a due, OUTSTANDING place_commitments row (promised_date
    // <= TARGET_DATE) - FLOOR_COMPLETED must be suppressed. Commitments are
    // their own table now (Place Commitments spec), not a column on the
    // visit - see services/placeCommitments.js.
    await db('visits').insert({ place_id: 5, user_id: 1, status: 'completed', scheduled_date: '2026-08-08', place_name: 'Commitment Exempt Place' });
    await db('place_commitments').insert({ place_id: 5, promised_date: TARGET_DATE });

    // Place 7: Sarah has a PLANNED (not yet happened) visit 2 days AFTER
    // TARGET_DATE - Step 3's own case. Dated after, not before, on purpose:
    // this is what the Math.abs fix in isFloorConflict exists for.
    await db('visits').insert({ place_id: 7, user_id: 2, status: 'planned', scheduled_date: '2026-08-12', place_name: 'Floor Planned Place' });

    // Place 8: Bede already completed TWO separate trips here today (two
    // distinct visit rows, same date) - the reported bug: logging a third
    // showed both SAME_DATE_VISIT and FLOOR_COMPLETED, because the "same
    // date" query and the "most recent completed" query are free to each
    // pick a DIFFERENT one of these two rows.
    await db('visits').insert({ place_id: 8, user_id: 1, status: 'completed', scheduled_date: TARGET_DATE, place_name: 'Two Trips Today Place' });
    await db('visits').insert({ place_id: 8, user_id: 1, status: 'completed', scheduled_date: TARGET_DATE, place_name: 'Two Trips Today Place' });
  });

  after(async () => {
    await db.destroy();
  });

  test('P0 acceptance case: a completed visit by the SAME rep, 2 days out, is not self-excluded', async () => {
    const conflicts = await detectConflicts(db, 1, TARGET_DATE, { userId: 1 });
    const floor = conflicts.find((c) => c.type === 'FLOOR_COMPLETED');
    assert.ok(floor, 'FLOOR_COMPLETED must fire even though the other visit belongs to the same rep');
    assert.equal(floor.otherUserId, 1);
    assert.equal(floor.otherUserName, 'Bede', 'must resolve a real name, not a bare id');
    assert.equal(floor.otherDate, '2026-08-08');
    assert.equal(floor.daysApart, 2);
  });

  test('SAME_DATE_VISIT: named, dated, from a different rep', async () => {
    const conflicts = await detectConflicts(db, 2, TARGET_DATE, { userId: 1 });
    const sameDate = conflicts.find((c) => c.type === 'SAME_DATE_VISIT');
    assert.ok(sameDate);
    assert.equal(sameDate.otherUserName, 'Sarah');
    assert.equal(sameDate.status, 'planned');
  });

  test('DRAFT_ELSEWHERE: named, dated, from another rep\'s open draft', async () => {
    const conflicts = await detectConflicts(db, 3, TARGET_DATE, { userId: 1 });
    const draftElsewhere = conflicts.find((c) => c.type === 'DRAFT_ELSEWHERE');
    assert.ok(draftElsewhere);
    assert.equal(draftElsewhere.otherUserName, 'Sarah');
    assert.equal(draftElsewhere.otherDate, TARGET_DATE);
  });

  test('OWN_DRAFT_DUPLICATE: place already in the caller\'s own draft, any date', async () => {
    const conflicts = await detectConflicts(db, 6, TARGET_DATE, { userId: 1, excludeDraftId: db.bedeDraftId });
    assert.ok(conflicts.some((c) => c.type === 'OWN_DRAFT_DUPLICATE'));
  });

  test('a skipped visit on the exact target date never produces SAME_DATE_VISIT', async () => {
    const conflicts = await detectConflicts(db, 4, TARGET_DATE, { userId: 1 });
    assert.ok(!conflicts.some((c) => c.type === 'SAME_DATE_VISIT'), 'a skipped visit never happened - it must not block the date');
  });

  test('a due commitment suppresses FLOOR_COMPLETED', async () => {
    const conflicts = await detectConflicts(db, 5, TARGET_DATE, { userId: 1 });
    assert.ok(!conflicts.some((c) => c.type === 'FLOOR_COMPLETED'), 'a human asking us back overrides the floor, same as eligibility()');
  });

  test('logging a THIRD visit at a place with two already-completed trips today reports only SAME_DATE_VISIT - reproduces the "two red warnings" bug', async () => {
    const conflicts = await detectConflicts(db, 8, TARGET_DATE, { userId: 1 });
    assert.deepEqual(conflicts.map((c) => c.type), ['SAME_DATE_VISIT']);
  });

  test('FLOOR_PLANNED (Step 3): named, dated, even though the planned visit is AFTER the target date', async () => {
    const conflicts = await detectConflicts(db, 7, TARGET_DATE, { userId: 1 });
    const floorPlanned = conflicts.find((c) => c.type === 'FLOOR_PLANNED');
    assert.ok(floorPlanned, 'a future-dated planned visit within the floor must still be caught');
    assert.equal(floorPlanned.otherUserName, 'Sarah');
    assert.equal(floorPlanned.otherDate, '2026-08-12');
    assert.equal(floorPlanned.daysApart, 2);
  });

  test('a planned visit EXACTLY on the target date is SAME_DATE_VISIT, not also FLOOR_PLANNED', async () => {
    const conflicts = await detectConflicts(db, 2, TARGET_DATE, { userId: 1 });
    assert.ok(!conflicts.some((c) => c.type === 'FLOOR_PLANNED'), 'the exact-date row is sameDateVisitRow\'s job - it must not double-count as FLOOR_PLANNED too');
  });

  test('no signals at all -> no conflicts', async () => {
    const conflicts = await detectConflicts(db, 999, TARGET_DATE, { userId: 1 });
    assert.deepEqual(conflicts, []);
  });
});

// detectConflictsForStops: the batched sibling that loadDraftView/
// loadDraftDayView (scheduleDraft.js) call once per draft-read instead of
// N detectConflicts calls, one per already-placed stop. Own DB fixture,
// separate from the block above, scoped to exactly what a draft's stops
// re-check needs: SAME_DATE_VISIT/FLOOR_COMPLETED/FLOOR_PLANNED/
// DRAFT_ELSEWHERE, batched across several place+date pairs at once.
describe('detectConflictsForStops (real DB, batched)', () => {
  let db;
  const DATE_A = '2026-08-10';
  const DATE_B = '2026-08-12';

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
      { id: 1, name: 'Clean Place', category: 'Hospice' },
      { id: 2, name: 'Same Date Place', category: 'Hospice' },
      { id: 3, name: 'Floor Completed Place', category: 'Hospice' },
      { id: 4, name: 'Floor Planned Place', category: 'Hospice' },
      { id: 5, name: 'Draft Elsewhere Place', category: 'Hospice' },
      { id: 6, name: 'Own Draft Place', category: 'Hospice' },
    ]);

    // Bede's own draft - the "draft being loaded" whose conflicts get
    // re-checked. Has its own stop, at place 6, on DATE_A, so excludeDraftId
    // has something real to exclude in the test below.
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify({ days: [{ date: DATE_A, hoursPerDay: 4 }] }) }).returning('id');
    db.bedeDraftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: db.bedeDraftId, place_id: 6, date: DATE_A, sort_order: 0 });

    // Place 2: Sarah commits a real visit on DATE_A AFTER Bede's stop was
    // already drafted there - this is the exact scenario the ticket names:
    // "another rep committing Tuesday invalidates a stop sitting in my
    // Thursday draft."
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: DATE_A, place_name: 'Same Date Place' });

    // Place 3: Bede himself completed a visit 2 days before DATE_A.
    await db('visits').insert({ place_id: 3, user_id: 1, status: 'completed', scheduled_date: '2026-08-08', place_name: 'Floor Completed Place' });

    // Place 4: Sarah has a planned visit 2 days after DATE_A.
    await db('visits').insert({ place_id: 4, user_id: 2, status: 'planned', scheduled_date: DATE_B, place_name: 'Floor Planned Place' });

    // Place 5: Sarah has an open draft stop at this place, also on DATE_A.
    const [sarahDraftRow] = await db('schedule_drafts').insert({ user_id: 2, params_json: JSON.stringify({ days: [{ date: DATE_A, hoursPerDay: 4 }] }) }).returning('id');
    const sarahDraftId = sarahDraftRow && sarahDraftRow.id ? sarahDraftRow.id : sarahDraftRow;
    await db('schedule_draft_stops').insert({ draft_id: sarahDraftId, place_id: 5, date: DATE_A, sort_order: 0 });
  });

  after(async () => {
    await db.destroy();
  });

  test('batches conflicts for every stop in one call, keyed by placeId|date', async () => {
    const stops = [1, 2, 3, 4, 5].map((placeId) => ({ placeId, date: DATE_A }));
    const byStop = await detectConflictsForStops(db, stops, { userId: 1, excludeDraftId: db.bedeDraftId });

    assert.deepEqual(byStop.get(`1|${DATE_A}`), [], 'a clean place has no conflicts');
    assert.equal(byStop.get(`2|${DATE_A}`)[0].type, 'SAME_DATE_VISIT');
    assert.equal(byStop.get(`3|${DATE_A}`)[0].type, 'FLOOR_COMPLETED');
    assert.equal(byStop.get(`4|${DATE_A}`)[0].type, 'FLOOR_PLANNED');
    assert.equal(byStop.get(`4|${DATE_A}`)[0].otherDate, DATE_B);
    assert.equal(byStop.get(`5|${DATE_A}`)[0].type, 'DRAFT_ELSEWHERE');
  });

  test('excludeDraftId keeps the caller\'s OWN draft from producing a false DRAFT_ELSEWHERE against itself, independent of the userId filter', async () => {
    // userId deliberately omitted here - isolates excludeDraftId's own
    // effect from the (already-redundant, in the normal single-user-owns-
    // one-draft case) userId exclusion the query also applies.
    const stops = [{ placeId: 6, date: DATE_A }];
    const withExclude = await detectConflictsForStops(db, stops, { excludeDraftId: db.bedeDraftId });
    assert.deepEqual(withExclude.get(`6|${DATE_A}`), []);

    const withoutExclude = await detectConflictsForStops(db, stops, {});
    assert.equal(withoutExclude.get(`6|${DATE_A}`)[0].type, 'DRAFT_ELSEWHERE', 'sanity check: without the exclusion this same stop DOES flag - proves the first assertion is excludeDraftId doing real work, not a query that never would have matched');
  });

  test('empty stops -> empty map, no query', async () => {
    const byStop = await detectConflictsForStops(db, [], { userId: 1 });
    assert.equal(byStop.size, 0);
  });
});
