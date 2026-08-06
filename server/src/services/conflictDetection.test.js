const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const config = require('../config/scheduling');
const { daysSince, isCommitmentDue, isFloorConflict, detectConflictsPure, detectConflicts } = require('./conflictDetection');

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
  test('ineligible under HARD_FLOOR_DAYS, eligible at and beyond the boundary — same cases schedulingEngine.test.js asserts through eligibility()', () => {
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

  test('FLOOR_PLANNED is not implemented yet (Step 3 stub) — a planned-only signal produces no conflict', () => {
    const conflicts = detectConflictsPure({ placeId: 1, today: TODAY, config });
    assert.ok(!conflicts.some((c) => c.type === 'FLOOR_PLANNED'));
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

// The async half — real queries, real joins, real name resolution — had no
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
      { id: 1, name: 'Floor Test Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 2, name: 'Same Date Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 3, name: 'Draft Elsewhere Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 4, name: 'Skipped Same Date Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 5, name: 'Commitment Exempt Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 6, name: 'Untouched Place', category: 'Hospice', tier: 1, priority_score: 75 },
    ]);

    // Place 1: Bede himself completed a visit 2 days before TARGET_DATE —
    // the exact P0 case: crossRepFloorWarning would swallow this (same rep),
    // detectConflicts must not.
    await db('visits').insert({ place_id: 1, user_id: 1, status: 'completed', scheduled_date: '2026-08-08', place_name: 'Floor Test Place' });

    // Place 2: Sarah has a planned visit ON the target date itself.
    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: TARGET_DATE, place_name: 'Same Date Place' });

    // Place 3: Sarah has an open draft with a stop on the target date.
    const [draftRow] = await db('schedule_drafts').insert({ user_id: 2, params_json: JSON.stringify({ days: [{ date: TARGET_DATE, hoursPerDay: 4 }] }) }).returning('id');
    const sarahDraftId = draftRow && draftRow.id ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: sarahDraftId, place_id: 3, date: TARGET_DATE, sort_order: 0 });

    // Bede's own draft, with place 6 already in it (any date) — for
    // OWN_DRAFT_DUPLICATE.
    const [bedeDraftRow] = await db('schedule_drafts').insert({ user_id: 1, params_json: JSON.stringify({ days: [{ date: TARGET_DATE, hoursPerDay: 4 }] }) }).returning('id');
    db.bedeDraftId = bedeDraftRow && bedeDraftRow.id ? bedeDraftRow.id : bedeDraftRow;
    await db('schedule_draft_stops').insert({ draft_id: db.bedeDraftId, place_id: 6, date: '2026-08-01', sort_order: 0 });

    // Place 4: a SKIPPED visit on the target date — must not produce
    // SAME_DATE_VISIT (amendment 1's fix, ported into detectConflicts since Step 1).
    await db('visits').insert({ place_id: 4, user_id: 2, status: 'skipped', scheduled_date: TARGET_DATE, place_name: 'Skipped Same Date Place' });

    // Place 5: Bede completed a visit 2 days before TARGET_DATE, but also has
    // a due commitment (next_visit_date <= TARGET_DATE) from that same visit
    // — FLOOR_COMPLETED must be suppressed.
    await db('visits').insert({ place_id: 5, user_id: 1, status: 'completed', scheduled_date: '2026-08-08', next_visit_date: TARGET_DATE, place_name: 'Commitment Exempt Place' });
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
    assert.ok(!conflicts.some((c) => c.type === 'SAME_DATE_VISIT'), 'a skipped visit never happened — it must not block the date');
  });

  test('a due commitment suppresses FLOOR_COMPLETED', async () => {
    const conflicts = await detectConflicts(db, 5, TARGET_DATE, { userId: 1 });
    assert.ok(!conflicts.some((c) => c.type === 'FLOOR_COMPLETED'), 'a human asking us back overrides the floor, same as eligibility()');
  });

  test('no signals at all -> no conflicts', async () => {
    const conflicts = await detectConflicts(db, 999, TARGET_DATE, { userId: 1 });
    assert.deepEqual(conflicts, []);
  });
});
