// Place Commitments - replaces visits.next_visit_date as the source of the
// COMMITMENT tier. See docs/place-commitments-spec.md (pasted spec,
// 2026-08-11) for the full design. Short version: next_visit_date had six
// readers and zero writers, and the one column it lived on can't hold two
// outstanding promises (tell the DON you'll be back the 20th and a social
// worker the 25th, and the second overwrites the first) or retire a kept one
// (visit the 20th and the date just sits there, pinned to the top of every
// route forever). A commitment is place-level and cross-rep, same as
// snooze_until/do_not_visit - it doesn't matter who the promise was made to,
// only that it constrains the planner.
//
// discharged_at IS NULL = outstanding. The binding date for a place is the
// EARLIEST promised_date among its outstanding rows, not the earliest
// created - promise the 25th today and the 20th tomorrow, and FIFO would
// bind you to the 25th while the 20th quietly passes.
//
// source_visit_id is provenance only (where the promise was made), not
// storage - both write surfaces (VisitLogModal and PlaceDetail's standalone
// add-a-commitment control) produce the same row shape. discharged_by_visit_id
// is separate: which visit fulfilled it, possibly not the one it came from.
//
// Backfill (2026-08-11, dev DB): checked before writing this - every
// visits.next_visit_date value on file (7 rows) is an empty string, not a
// real date, and all 7 are already-detached rows (place_id NULL). Zero real
// promises exist to carry forward here. The backfill below still implements
// the general rule (promised_date >= today -> outstanding, else discharged
// as a historical waive) in case this ever runs against a DB that does have
// real values - on this one it's a no-op, verified by row count after.
exports.up = async function up(knex) {
  await knex.schema.createTable('place_commitments', (t) => {
    t.increments('id').primary();
    t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
    t.date('promised_date').notNullable();
    t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
    t.text('note');
    t.integer('source_visit_id').references('id').inTable('visits').onDelete('SET NULL');
    t.integer('created_by_user_id').references('id').inTable('users');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.timestamp('discharged_at');
    t.string('discharge_reason').checkIn(['fulfilled', 'superseded', 'waived']);
    t.integer('discharged_by_visit_id').references('id').inTable('visits').onDelete('SET NULL');
    t.integer('superseded_by_id').references('id').inTable('place_commitments').onDelete('SET NULL');
  });

  // Partial index: only outstanding rows need to be found fast (binding-date
  // lookups, the snooze guard, the ranker). Same WHERE-clause-index pattern
  // as visits_place_date_active_unique - works identically on SQLite (dev)
  // and Postgres (prod).
  await knex.raw(
    `CREATE INDEX idx_place_commitments_outstanding ON place_commitments(place_id, promised_date) WHERE discharged_at IS NULL`
  );

  const { orgToday } = require('../services/orgDate');
  const today = orgToday();

  // '' counts as NOT NULL in SQL but isn't a real date - every value on
  // file today happens to be exactly this artifact, not a genuine promise.
  const legacyRows = await knex('visits')
    .whereNotNull('next_visit_date')
    .where('next_visit_date', '!=', '')
    .select('id', 'place_id', 'next_visit_date', 'created_at');

  const toInsert = legacyRows
    .filter((v) => v.place_id != null)
    .map((v) => {
      const outstanding = v.next_visit_date >= today;
      return {
        place_id: v.place_id,
        promised_date: v.next_visit_date,
        person_id: null,
        note: outstanding ? null : 'backfill: historical, never actionable',
        source_visit_id: v.id,
        created_by_user_id: null,
        created_at: v.created_at,
        discharged_at: outstanding ? null : knex.fn.now(),
        discharge_reason: outstanding ? null : 'waived',
        discharged_by_visit_id: null,
        superseded_by_id: null,
      };
    });

  if (toInsert.length) {
    await knex('place_commitments').insert(toInsert);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[place_commitments backfill] ${legacyRows.length} legacy visits.next_visit_date value(s) found, ` +
      `${toInsert.length} carried forward (${toInsert.filter((r) => !r.discharged_at).length} outstanding, ` +
      `${toInsert.filter((r) => r.discharged_at).length} waived as historical), ` +
      `${legacyRows.length - toInsert.length} skipped (no place_id).`
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('place_commitments');
};
