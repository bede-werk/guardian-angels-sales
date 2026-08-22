const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const knexLib = require('knex');
const { orgToday } = require('./orgDate');
const {
  pastDateError,
  classifyConflicts,
  doNotVisitWarning,
  canEditManualVisit,
  canDeleteManualVisit,
  createManualVisit,
  getEditableVisit,
  editVisit,
} = require('./manualVisits');

const TODAY = orgToday();

function isoOffset(n, from = TODAY) {
  const [y, m, d] = from.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

describe('pastDateError', () => {
  test('rejects a date before today', () => {
    assert.match(pastDateError(isoOffset(-1), TODAY), /past dates/);
  });
  test('accepts today', () => {
    assert.equal(pastDateError(TODAY, TODAY), null);
  });
  test('accepts a future date', () => {
    assert.equal(pastDateError(isoOffset(5), TODAY), null);
  });
});

describe('classifyConflicts - policy divergence from routes/visits.js', () => {
  // routes/visits.js's own ad-hoc "Log a visit" POST only ever hard-blocks
  // SAME_DATE_VISIT (see that route's `sameDateConflict` check) - every
  // other finding, DRAFT_ELSEWHERE included, is informational there. Manual
  // planning is stricter on purpose (spec §4.1): a place already in another
  // rep's draft for that date is a real double-booking risk once BOTH sides
  // might commit, not just a "someone else was recently here" heads-up. This
  // test exists specifically to keep that divergence deliberate and visible,
  // not something that quietly drifts back into agreement (or apart further)
  // as either policy changes.
  test('SAME_DATE_VISIT and DRAFT_ELSEWHERE both block here', () => {
    const conflicts = [
      { type: 'SAME_DATE_VISIT', severity: 'hard' },
      { type: 'DRAFT_ELSEWHERE', severity: 'hard' },
    ];
    const { blocking } = classifyConflicts(conflicts);
    assert.deepEqual(blocking.map((c) => c.type).sort(), ['DRAFT_ELSEWHERE', 'SAME_DATE_VISIT']);
  });

  test('FLOOR_COMPLETED and FLOOR_PLANNED are warnings, not blocks', () => {
    const conflicts = [
      { type: 'FLOOR_COMPLETED', daysApart: 2 },
      { type: 'FLOOR_PLANNED', daysApart: 3 },
    ];
    const { blocking, warnings } = classifyConflicts(conflicts);
    assert.equal(blocking.length, 0);
    assert.equal(warnings.length, 2);
  });
});

describe('doNotVisitWarning', () => {
  test('no warning when do_not_visit is false', () => {
    assert.equal(doNotVisitWarning({ do_not_visit: false, do_not_visit_until: null }, TODAY), null);
  });
  test('warns when do_not_visit is true with no until date (indefinite)', () => {
    assert.ok(doNotVisitWarning({ do_not_visit: true, do_not_visit_until: null }, TODAY));
  });
  test('warns while today is on or before do_not_visit_until', () => {
    assert.ok(doNotVisitWarning({ do_not_visit: true, do_not_visit_until: TODAY }, TODAY));
    assert.ok(doNotVisitWarning({ do_not_visit: true, do_not_visit_until: isoOffset(1) }, TODAY));
  });
  test('lapses once today is past do_not_visit_until', () => {
    assert.equal(doNotVisitWarning({ do_not_visit: true, do_not_visit_until: isoOffset(-1) }, TODAY), null);
  });
});

describe('permissions (§5)', () => {
  const visit = { user_id: 1, created_by_user_id: 2 };

  test('assignee can edit and delete', () => {
    assert.equal(canEditManualVisit(visit, 1), true);
    assert.equal(canDeleteManualVisit(visit, 1), true);
  });
  test('creator can delete a visit planned for someone else, but not edit it', () => {
    assert.equal(canEditManualVisit(visit, 2), false);
    assert.equal(canDeleteManualVisit(visit, 2), true);
  });
  test('a third rep can do neither', () => {
    assert.equal(canEditManualVisit(visit, 3), false);
    assert.equal(canDeleteManualVisit(visit, 3), false);
  });
  test('a visit planned for yourself is yours alone - same id on both sides', () => {
    const own = { user_id: 1, created_by_user_id: 1 };
    assert.equal(canEditManualVisit(own, 1), true);
    assert.equal(canDeleteManualVisit(own, 1), true);
    assert.equal(canDeleteManualVisit(own, 2), false);
  });
});

describe('createManualVisit / rescheduleManualVisit (real DB)', () => {
  let db;

  before(async () => {
    db = knexLib({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      migrations: { directory: path.join(__dirname, '..', 'migrations') },
      pool: {
        afterCreate: (conn, done) => {
          conn.pragma('foreign_keys = ON');
          done(null, conn);
        },
      },
    });
    await db.migrate.latest();

    await db('users').insert([
      { id: 1, name: 'Nikki', email: 'nikki@test.local' },
      { id: 2, name: 'Lisa', email: 'lisa@test.local' },
    ]);
    await db('places').insert([
      { id: 1, name: 'Clean Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 2, name: 'Same Day Planned Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 3, name: 'Same Day Completed Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 4, name: 'Draft Elsewhere Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 5, name: 'Recently Visited Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 6, name: 'Long Ago Visited Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 8, name: 'Cross-Rep Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 10, name: 'Commitment Place', category: 'Hospice', tier: 1, priority_score: 75 },
      { id: 11, name: 'Reschedule Test Place', category: 'Hospice', tier: 1, priority_score: 75 },
    ]);
    // Separate insert: a batched multi-row insert fills any column absent
    // from one row's object with an explicit NULL for that row (to keep a
    // single union-select statement), not the column's own default - and
    // places.do_not_visit is NOT NULL, so mixing this into the array above
    // would fail every row, not just this one.
    await db('places').insert({ id: 7, name: 'Do Not Visit Place', category: 'Hospice', tier: 1, priority_score: 75, do_not_visit: true });

    await db('visits').insert({ place_id: 2, user_id: 2, status: 'planned', scheduled_date: isoOffset(3), place_name: 'Same Day Planned Place' });
    await db('visits').insert({ place_id: 3, user_id: 2, status: 'completed', scheduled_date: isoOffset(3), place_name: 'Same Day Completed Place' });

    const [draftRow] = await db('schedule_drafts').insert({ user_id: 2, params_json: JSON.stringify({ days: [{ date: isoOffset(3), hoursPerDay: 4 }] }) }).returning('id');
    const draftId = draftRow && draftRow.id !== undefined ? draftRow.id : draftRow;
    await db('schedule_draft_stops').insert({ draft_id: draftId, place_id: 4, date: isoOffset(3), sort_order: 0 });

    // Floor gap is measured against the TARGET date being planned, not
    // real "today" (see conflictDetection.js's isFloorConflict - `today`
    // there is whatever date is under consideration). Both floor tests
    // below plan for TODAY itself, so these seed dates are chosen relative
    // to TODAY: 3 days back is inside the 5-day floor, 9 days back is not.
    await db('visits').insert({ place_id: 5, user_id: 1, status: 'completed', scheduled_date: isoOffset(-3), place_name: 'Recently Visited Place' });
    await db('visits').insert({ place_id: 6, user_id: 1, status: 'completed', scheduled_date: isoOffset(-9), place_name: 'Long Ago Visited Place' });

    await db('place_commitments').insert({ place_id: 10, promised_date: isoOffset(3) });
  });

  after(async () => {
    await db.destroy();
  });

  test('past date is rejected before any DB check runs', async () => {
    await assert.rejects(
      () => createManualVisit(db, { placeId: 1, scheduledDate: isoOffset(-1), userId: 1, createdByUserId: 1 }),
      /past dates/
    );
  });

  test('same-day block: place already has a planned visit that day, any rep', async () => {
    await assert.rejects(
      () => createManualVisit(db, { placeId: 2, scheduledDate: isoOffset(3), userId: 1, createdByUserId: 1 }),
      (err) => {
        assert.equal(err.status, 409);
        assert.ok(err.conflicts.some((c) => c.type === 'SAME_DATE_VISIT'));
        return true;
      }
    );
  });

  test('same-day block: place already visited (completed) that day', async () => {
    await assert.rejects(
      () => createManualVisit(db, { placeId: 3, scheduledDate: isoOffset(3), userId: 1, createdByUserId: 1 }),
      (err) => {
        assert.equal(err.status, 409);
        assert.ok(err.conflicts.some((c) => c.type === 'SAME_DATE_VISIT'));
        return true;
      }
    );
  });

  test('draft block: place is in another rep\'s live draft for that day', async () => {
    await assert.rejects(
      () => createManualVisit(db, { placeId: 4, scheduledDate: isoOffset(3), userId: 1, createdByUserId: 1 }),
      (err) => {
        assert.equal(err.status, 409);
        assert.ok(err.conflicts.some((c) => c.type === 'DRAFT_ELSEWHERE'));
        return true;
      }
    );
  });

  test('5-day warning is not a block: visited 3 days before the target date -> warns, force:true proceeds', async () => {
    const attempt = await createManualVisit(db, { placeId: 5, scheduledDate: TODAY, userId: 1, createdByUserId: 1 });
    assert.equal(attempt.visit, null);
    assert.ok(attempt.warnings.some((w) => w.type === 'FLOOR_COMPLETED'));

    const forced = await createManualVisit(db, { placeId: 5, scheduledDate: TODAY, userId: 1, createdByUserId: 1, force: true });
    assert.ok(forced.visit);
    assert.equal(forced.visit.status, 'planned');
    assert.equal(forced.visit.planned_manually, 1);
    assert.equal(forced.visit.user_id, 1);
    assert.equal(forced.visit.created_by_user_id, 1);
  });

  test('no warning past the 5-day floor: visited 9 days before the target date', async () => {
    const result = await createManualVisit(db, { placeId: 6, scheduledDate: TODAY, userId: 1, createdByUserId: 1 });
    assert.ok(result.visit, 'created directly, no warning to confirm past the floor');
    assert.equal(result.warnings.length, 0);
  });

  test('do_not_visit warns, proceeds on force', async () => {
    const attempt = await createManualVisit(db, { placeId: 7, scheduledDate: isoOffset(4), userId: 1, createdByUserId: 1 });
    assert.equal(attempt.visit, null);
    assert.ok(attempt.warnings.some((w) => w.type === 'DO_NOT_VISIT'));

    const forced = await createManualVisit(db, { placeId: 7, scheduledDate: isoOffset(4), userId: 1, createdByUserId: 1, force: true });
    assert.ok(forced.visit);
  });

  test('cross-rep planning: created_by_user_id differs from the assignee user_id', async () => {
    const result = await createManualVisit(db, { placeId: 8, scheduledDate: isoOffset(5), userId: 2, createdByUserId: 1 });
    assert.ok(result.visit);
    assert.equal(result.visit.user_id, 2, 'assigned to Lisa');
    assert.equal(result.visit.created_by_user_id, 1, 'planned by Nikki');
  });

  test('notes are saved when provided, and default to null when omitted', async () => {
    // Both on place 1 ('Clean Place'), which carries no other visits anywhere
    // else in this file - dates kept >5 days apart so the second call doesn't
    // trip a FLOOR_PLANNED warning against the first.
    const withNotes = await createManualVisit(db, { placeId: 1, scheduledDate: isoOffset(6), userId: 1, createdByUserId: 1, notes: 'Bring the updated brochure' });
    assert.ok(withNotes.visit);
    assert.equal(withNotes.visit.notes, 'Bring the updated brochure');

    const withoutNotes = await createManualVisit(db, { placeId: 1, scheduledDate: isoOffset(20), userId: 1, createdByUserId: 1 });
    assert.ok(withoutNotes.visit);
    assert.equal(withoutNotes.visit.notes, null);
  });

  test('a manual visit on a commitment date satisfies generation but does not discharge the promise', async () => {
    const result = await createManualVisit(db, { placeId: 10, scheduledDate: isoOffset(3), userId: 1, createdByUserId: 1 });
    assert.ok(result.visit);
    const commitment = await db('place_commitments').where({ place_id: 10 }).first();
    assert.equal(commitment.discharged_at, null, 'planning alone must never discharge a commitment');
  });

  describe('editVisit - date changes (a manually-planned visit)', () => {
    // Own place (11) and widely-separated dates (>= 5 days apart from each
    // other in every combination) so none of these moves accidentally trips
    // a FLOOR_* warning from a neighboring date in this same block - only
    // the deliberate SAME_DATE_VISIT collision below should ever fire.
    const ORIGINAL_DATE = isoOffset(20);
    const COLLISION_DATE = isoOffset(30);
    const MOVED_DATE = isoOffset(45);
    let manualVisitId;

    before(async () => {
      // Someone else's real, already-planned visit at the place/date this
      // block will try (and fail) to reschedule onto.
      await db('visits').insert({ place_id: 11, user_id: 2, status: 'planned', scheduled_date: COLLISION_DATE, place_name: 'Reschedule Test Place' });

      const result = await createManualVisit(db, { placeId: 11, scheduledDate: ORIGINAL_DATE, userId: 1, createdByUserId: 2 });
      manualVisitId = result.visit.id;
    });

    test('only the assignee can edit, not the creator or a third rep', async () => {
      await assert.rejects(
        () => editVisit(db, manualVisitId, { scheduledDate: isoOffset(25) }, 2),
        (err) => { assert.equal(err.status, 403); return true; }
      );
      await assert.rejects(
        () => editVisit(db, manualVisitId, { scheduledDate: isoOffset(25) }, 3),
        (err) => { assert.equal(err.status, 403); return true; }
      );
    });

    test('no conflict recheck when the date is unchanged, but the save still goes through', async () => {
      const result = await editVisit(db, manualVisitId, { scheduledDate: ORIGINAL_DATE }, 1);
      assert.equal(result.visit.id, manualVisitId);
      assert.equal(result.warnings.length, 0);
    });

    test('moving to a colliding date is rejected; the visit stays on its original date', async () => {
      await assert.rejects(
        () => editVisit(db, manualVisitId, { scheduledDate: COLLISION_DATE }, 1),
        (err) => { assert.equal(err.status, 409); return true; }
      );
      const stillThere = await db('visits').where({ id: manualVisitId }).first();
      assert.equal(stillThere.scheduled_date, ORIGINAL_DATE, 'the original date\'s block was never released by a failed move');
    });

    test('a successful move updates scheduled_date', async () => {
      const result = await editVisit(db, manualVisitId, { scheduledDate: MOVED_DATE }, 1);
      assert.ok(result.visit);
      assert.equal(result.visit.scheduled_date, MOVED_DATE);
    });

    test('moving off the original date releases whatever block it was causing there', async () => {
      // The manual visit moved off ORIGINAL_DATE in the previous test - a
      // different rep planning the same place on that now-vacated date
      // should succeed.
      const result = await createManualVisit(db, { placeId: 11, scheduledDate: ORIGINAL_DATE, userId: 2, createdByUserId: 2 });
      assert.ok(result.visit, 'the old date is free again once the manual visit moved off it');
    });

    test('notes are saved alongside a date move', async () => {
      const result = await editVisit(db, manualVisitId, { scheduledDate: MOVED_DATE, notes: 'Bring the brochure' }, 1);
      assert.equal(result.visit.notes, 'Bring the brochure');
    });
  });

  describe('editVisit - promotes a planner-committed visit', () => {
    // place_id 2 ('Same Day Planned Place') was seeded above as an ordinary
    // status:'planned' visit with source:'planner'/planner_committed:1 (the
    // DB defaults here are 'manual'/0, so seed both explicitly) and
    // planned_manually left at its column default (0) - exactly what a
    // route-planner commit looks like, never touched by createManualVisit
    // anywhere in this file.
    let plannerVisitId;

    before(async () => {
      const row = await db('visits').where({ place_id: 2 }).first();
      await db('visits').where({ id: row.id }).update({ source: 'planner', planner_committed: 1 });
      plannerVisitId = row.id;
    });

    test('editVisit works on it even though it was never planned_manually', async () => {
      const result = await editVisit(db, plannerVisitId, { notes: 'Took over this stop' }, 2);
      assert.ok(result.visit);
      assert.equal(result.visit.notes, 'Took over this stop');
    });

    test('planner_committed survives the promotion untouched - it is a birth fact, not a current-state flag', async () => {
      // See 20260822000000_add_visits_planner_committed.js: this is exactly
      // what committedDateSummaries' gate relies on to survive an unrelated
      // hand-edit, unlike source/planned_manually above, which are meant to
      // flip.
      const row = await db('visits').where({ id: plannerVisitId }).first();
      assert.equal(row.planner_committed, 1);
    });

    test('a successful save promotes it: planned_manually and source flip, created_by_user_id backfills', async () => {
      const row = await db('visits').where({ id: plannerVisitId }).first();
      assert.equal(row.planned_manually, 1);
      assert.equal(row.source, 'manual');
      assert.equal(row.created_by_user_id, 2, 'backfilled to the rep who made the edit, since a planner commit never sets it');
    });

    test('only the assignee could have edited it, same permission as any manually-planned visit', async () => {
      await assert.rejects(
        () => editVisit(db, plannerVisitId, { notes: 'nope' }, 3),
        (err) => { assert.equal(err.status, 403); return true; }
      );
    });
  });

  describe('getEditableVisit', () => {
    test('404s on a nonexistent id', async () => {
      await assert.rejects(
        () => getEditableVisit(db, 999999),
        (err) => { assert.equal(err.status, 404); return true; }
      );
    });
    test('400s on a visit that is no longer status: planned', async () => {
      const completedVisit = await db('visits').where({ place_id: 3 }).first(); // 'Same Day Completed Place', seeded status: 'completed'
      await assert.rejects(
        () => getEditableVisit(db, completedVisit.id),
        (err) => { assert.equal(err.status, 400); return true; }
      );
    });
  });
});
