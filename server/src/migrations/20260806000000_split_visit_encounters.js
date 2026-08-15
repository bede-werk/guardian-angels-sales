// Splits `visits` into a real trip + encounter pair.
//
// BEFORE: one `visits` row WAS one encounter. A trip where a rep met three
// people wrote three rows sharing place/date/rep/notes/duration, each
// carrying its own person_id/met_with_type/outcome/they_requested. There was
// no real identifier for "the trip" - only an implicit one, recoverable by
// matching the shared fields across rows (which is exactly what the client
// was doing, for display only).
//
// AFTER: `visits` is the TRIP (place, date, rep, notes, duration, status),
// and the new `visit_encounters` holds one row per person/category met, with
// a real FK back to its visit. This is what makes "one logged visit" a fact
// in the database rather than a display convention, and gives anything
// visit-specific (vs. encounter-specific) an unambiguous place to live.
//
// The relationship model is unaffected by design: it scores per ENCOUNTER
// and always did, so it reads the same field set - just sourced from a join
// instead of a flat table. See the scoring-parity test in
// services/relationship.test.js, which asserts identical scores across this
// migration.
//
// SQLite note: dropping the FK-bearing person_id column can't be done with a
// plain .alterTable() - SQLite's alter strategy would keep the old foreign
// key alongside the new table. So SQLite gets an explicit rebuild (create
// corrected table under a temp name, copy, drop, rename) exactly as
// 20260709000000_detach_instead_of_cascade.js does; Postgres drops the
// columns directly. Same reason index names are dropped first and given
// explicit names: SQLite index names are unique database-wide, so a leftover
// from a previous run (e.g. a rollback) would collide.

// --- Shared helpers (same shape as 20260709000000_detach_instead_of_cascade.js) ---

async function rebuildSqliteTable(knex, name, buildNewTable, copyColumns) {
  const tmp = `${name}_rebuild`;
  await knex.schema.dropTableIfExists(tmp);
  await buildNewTable(tmp);
  await knex.raw(`INSERT INTO "${tmp}" (${copyColumns}) SELECT ${copyColumns} FROM "${name}"`);
  await knex.schema.dropTable(name);
  await knex.schema.renameTable(tmp, name);
}

async function dropIndexIfExists(knex, indexName) {
  await knex.raw(`DROP INDEX IF EXISTS "${indexName}"`);
}

// Encounter-level columns being moved off `visits`.
const ENCOUNTER_COLUMNS = [
  'person_id',
  'person_name',
  'person_title',
  'person_email',
  'person_phone',
  'met_with_type',
  'outcome',
  'they_requested',
];

// Trip identity for the backfill. See groupIntoTrips below for why this is
// only half the story.
const TRIP_KEY_FIELDS = ['place_id', 'scheduled_date', 'user_id'];

// Fields that a genuine multi-row trip must ALSO agree on. Used as a
// confirmation, never as the primary signal - see groupIntoTrips.
const TRIP_CONFIRM_FIELDS = ['notes', 'next_visit_date', 'actual_duration_minutes'];

// Rows written by one multi-encounter POST are inserted inside a single
// transaction, so their created_at values land in the same second (or within
// one of it). Two seconds is a deliberately generous margin on a
// second-resolution column.
const SAME_TRIP_SECONDS = 2;

// Only rows that could ACTUALLY have come from a multi-encounter trip are
// ever considered for merging. Multi-row trips have exactly one origin: the
// `encounters[]` fan-out in POST /api/visits (added 2026-08-04), which always
// produces source='manual', status='completed', and a non-null place_id (the
// route 404s without a valid place). Everything else stays 1:1.
//
// This restriction is not paranoia - it fixes a real wrong-merge found while
// rehearsing this migration against the actual dev database. The route
// planner commits a whole DAY of stops in ONE transaction, so 13 stops at 13
// DIFFERENT places all share a created_at to the second. Where those places
// were later deleted, place_id is null on every one of them (detach-not-
// delete), and a naive "same place_id + date + rep + insert window" key reads
// 13 unrelated planned stops as a single 13-person trip. A null place_id is
// the ABSENCE of a place, never evidence of a shared one.
function couldBeMultiEncounter(row) {
  return row.place_id != null && row.source === 'manual' && row.status === 'completed';
}

// created_at is a 'YYYY-MM-DD HH:MM:SS' string on SQLite and a Date on
// Postgres - normalize both to epoch ms. A missing/unparseable timestamp
// returns null, which groupIntoTrips treats as "can't prove same trip".
function timestampMs(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  // Treat the naive SQLite string as UTC; only DIFFERENCES matter here, so
  // the absolute zone is irrelevant as long as it's applied consistently.
  const ms = Date.parse(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

function sameValue(a, b) {
  // '' and null both mean "not recorded" for these text columns, and the two
  // have been written interchangeably over the app's life.
  const norm = (v) => (v === '' || v === undefined ? null : v);
  return norm(a) === norm(b);
}

// Groups pre-split `visits` rows into trips.
//
// WHY created_at IS THE PRIMARY SIGNAL: matching on the shared trip fields
// alone (notes/next_visit_date/duration) silently merges two genuinely
// separate trips whenever both happen to be null - a morning drop-off and an
// afternoon meeting at the same place on the same day would collapse into
// one, and down() cannot recover the loss. Insert time can: one POST writes
// its rows together, two separate visits don't.
//
// The shared fields are still checked, but only to REFUSE a merge that
// created_at proposed. Anything refused is left as separate trips (the safe
// direction - an over-split is visible and fixable, a wrong merge is not).
function groupIntoTrips(rows, log) {
  const byKey = new Map();
  const trips = [];
  for (const row of rows) {
    // Anything that can't have come from the fan-out is its own trip, full
    // stop - never even a merge candidate.
    if (!couldBeMultiEncounter(row)) {
      trips.push([row]);
      continue;
    }
    const key = TRIP_KEY_FIELDS.map((f) => String(row[f] ?? 'null')).join('__');
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  for (const candidateRows of byKey.values()) {
    // Oldest first, so each cluster starts from its earliest row.
    const sorted = [...candidateRows].sort((a, b) => a.id - b.id);
    let cluster = [];

    const flush = () => {
      if (cluster.length) trips.push(cluster);
      cluster = [];
    };

    for (const row of sorted) {
      if (!cluster.length) {
        cluster = [row];
        continue;
      }
      const anchor = cluster[0];
      const anchorMs = timestampMs(anchor.created_at);
      const rowMs = timestampMs(row.created_at);

      const withinWindow =
        anchorMs != null && rowMs != null && Math.abs(rowMs - anchorMs) <= SAME_TRIP_SECONDS * 1000;

      if (!withinWindow) {
        flush();
        cluster = [row];
        continue;
      }

      // created_at says "same trip" - now try to disprove it.
      const disagreeing = TRIP_CONFIRM_FIELDS.filter((f) => !sameValue(anchor[f], row[f]));
      if (disagreeing.length) {
        log(
          `[split_visit_encounters] NOT merging visit ${row.id} into ${anchor.id}: ` +
            `same insert window but differing ${disagreeing.join('/')} - kept separate.`
        );
        flush();
        cluster = [row];
        continue;
      }

      // The same person twice in one trip would double-count them in the
      // relationship model, and would violate the new unique index below.
      // Pre-split data was never constrained against it, so check here.
      if (row.person_id != null && cluster.some((c) => c.person_id === row.person_id)) {
        log(
          `[split_visit_encounters] NOT merging visit ${row.id} into ${anchor.id}: ` +
            `person_id ${row.person_id} already present in that trip - kept separate.`
        );
        flush();
        cluster = [row];
        continue;
      }

      cluster.push(row);
    }
    flush();
  }
  return trips;
}

// ORDER MATTERS HERE, and not for a cosmetic reason. `visit_encounters.visit_id`
// is ON DELETE CASCADE, and the SQLite path below reshapes `visits` by DROPping
// the old table. With foreign keys enforced (knexfile turns them on per
// connection), that drop cascades and silently empties visit_encounters - an
// earlier draft of this migration did exactly that and left the table at 0 rows
// while reporting a successful backfill. So: read the old rows into memory,
// finish every change to `visits` FIRST, and only create/populate the child
// table once its parent has stopped being replaced.
exports.up = async function up(knex) {
  const isPg = knex.client.config.client === 'pg';
  const log = (msg) => console.log(msg);

  // --- 1. Read the pre-split rows and work out the trips ------------------
  const visits = await knex('visits').select(
    'id',
    'created_at',
    'source',
    'status',
    ...TRIP_KEY_FIELDS,
    ...TRIP_CONFIRM_FIELDS,
    ...ENCOUNTER_COLUMNS
  );

  // Every merge is logged: if this looks wrong weeks from now, this output is
  // the only record of what happened.
  const trips = groupIntoTrips(visits, log);

  // row id -> the visit id its encounter will hang off (itself, unless it was
  // absorbed into an earlier row's trip).
  const visitIdForRow = new Map();
  const absorbedIds = [];
  let mergedTrips = 0;
  for (const cluster of trips) {
    const survivor = cluster[0];
    for (const row of cluster) visitIdForRow.set(row.id, survivor.id);
    if (cluster.length > 1) {
      const absorbed = cluster.slice(1).map((r) => r.id);
      absorbedIds.push(...absorbed);
      mergedTrips += 1;
      log(`[split_visit_encounters] merged visits [${absorbed.join(', ')}] into visit ${survivor.id}`);
    }
  }
  log(
    `[split_visit_encounters] ${visits.length} pre-split rows -> ${trips.length} trips + ` +
      `${visits.length} encounters (${mergedTrips} trips absorbed more than one row)`
  );

  // --- 2. Drop the absorbed rows, then reshape `visits` -------------------
  if (absorbedIds.length) await knex('visits').whereIn('id', absorbedIds).del();

  if (isPg) {
    await knex.schema.alterTable('visits', (t) => t.dropForeign('person_id'));
    await knex.schema.alterTable('visits', (t) => {
      for (const c of ENCOUNTER_COLUMNS) t.dropColumn(c);
    });
  } else {
    await rebuildVisitsSqlite(knex);
  }

  // --- 3. Create the child table, now that `visits` has settled -----------
  await dropIndexIfExists(knex, 'visit_encounters_visit_id_index');
  await dropIndexIfExists(knex, 'visit_encounters_person_id_index');
  await dropIndexIfExists(knex, 'visit_encounters_unique_person');

  await knex.schema.createTable('visit_encounters', (t) => {
    t.increments('id').primary();
    // CASCADE, unlike everything else in this schema: an encounter has no
    // meaning without its trip, so "delete the visit" really should take them
    // with it. That's different from the detach-not-delete rule for
    // place/person/user, which are independent records a visit merely refers to.
    t.integer('visit_id').notNullable().references('id').inTable('visits').onDelete('CASCADE');
    // Same detach-not-delete rule the old visits.person_id had: deleting a
    // person leaves their encounters readable via the name snapshot below.
    t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
    t.string('person_name');
    t.string('person_title');
    t.string('person_email');
    t.string('person_phone');
    t.string('met_with_type'); // named_person | staff | receptionist | nobody
    t.string('outcome');
    t.boolean('they_requested').notNullable().defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.index(['visit_id'], 'visit_encounters_visit_id_index');
    t.index(['person_id'], 'visit_encounters_person_id_index');
  });

  // The same person can't be recorded twice on one trip - that would
  // double-count their decayed weight in services/relationship.js for a
  // single conversation, with no visible symptom. PARTIAL because person_id
  // is nullable by design: a trip may legitimately have several encounters
  // with no person at all (staff, receptionist, nobody), and those must not
  // collide with each other. Both SQLite and Postgres support this syntax.
  await knex.raw(
    `CREATE UNIQUE INDEX visit_encounters_unique_person ON visit_encounters (visit_id, person_id) WHERE person_id IS NOT NULL`
  );

  // --- 4. One encounter per original pre-split row ------------------------
  //
  // Except for rows that never recorded an encounter at all. A `planned` stop
  // hasn't happened yet: it has no person, no met_with_type and no outcome,
  // because nobody has been met. Writing an all-null encounter row for it
  // would invent a fact ("someone was met here") that was never recorded, and
  // the UI would read it back as a real one - a planned visit would render
  // "with someone" instead of its intended "nobody recorded yet" empty state.
  // Zero encounters IS the correct representation of a planned trip.
  //
  // A COMPLETED trip always gets an encounter even when its fields are sparse:
  // it genuinely happened, so its (partly unknown) encounter is real history,
  // and relationship.js already scores a null met_with_type/outcome at
  // documented floors rather than discarding it. It also keeps the
  // completed-trips-have-at-least-one-encounter invariant true for old data,
  // which the API now enforces for new data.
  let skipped = 0;
  for (const v of visits) {
    const recordedNothing = v.person_id == null && v.met_with_type == null && v.outcome == null;
    if (v.status !== 'completed' && recordedNothing) {
      skipped += 1;
      continue;
    }
    await knex('visit_encounters').insert({
      visit_id: visitIdForRow.get(v.id),
      person_id: v.person_id ?? null,
      person_name: v.person_name ?? null,
      person_title: v.person_title ?? null,
      person_email: v.person_email ?? null,
      person_phone: v.person_phone ?? null,
      met_with_type: v.met_with_type ?? null,
      outcome: v.outcome ?? null,
      they_requested: Boolean(v.they_requested),
    });
  }
  if (skipped) {
    log(`[split_visit_encounters] ${skipped} not-yet-happened trips left with zero encounters (correct)`);
  }
};

async function rebuildVisitsSqlite(knex) {
  for (const idx of [
    'visits_scheduled_date_index',
    'visits_place_id_index',
    'visits_user_id_index',
    'visits_status_index',
    'visits_person_id_index',
    'visits_place_status_date_index',
    'visits_user_date_index',
  ]) {
    await dropIndexIfExists(knex, idx);
  }
  // The partial unique index from 20260715000002 references `visits` too, so
  // it has to be dropped and recreated around the rebuild.
  await dropIndexIfExists(knex, 'visits_place_date_active_unique');

  await rebuildSqliteTable(
    knex,
    'visits',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').references('id').inTable('places').onDelete('SET NULL');
        t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
        t.string('scheduled_date');
        t.string('status').notNullable().defaultTo('planned');
        t.integer('sort_order').notNullable().defaultTo(0);
        t.text('notes');
        t.string('next_visit_date');
        t.timestamp('completed_at');
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.string('source').notNullable().defaultTo('manual');
        t.string('place_name');
        t.string('visit_type');
        t.integer('actual_duration_minutes');
        t.index(['scheduled_date'], 'visits_scheduled_date_index');
        t.index(['place_id'], 'visits_place_id_index');
        t.index(['user_id'], 'visits_user_id_index');
        t.index(['status'], 'visits_status_index');
        t.index(['place_id', 'status', 'scheduled_date'], 'visits_place_status_date_index');
        t.index(['user_id', 'scheduled_date'], 'visits_user_date_index');
      }),
    'id, place_id, user_id, scheduled_date, status, sort_order, notes, next_visit_date, completed_at, created_at, updated_at, source, place_name, visit_type, actual_duration_minutes'
  );

  await knex.raw(
    `CREATE UNIQUE INDEX visits_place_date_active_unique ON visits(place_id, scheduled_date) WHERE status != 'skipped' AND source = 'planner'`
  );
}

// Restores the wide `visits` shape, repopulating its encounter columns from
// each trip's FIRST encounter. A trip that recorded several people cannot
// round-trip - the others are dropped. Same documented limitation as
// 20260709000000_detach_instead_of_cascade.js's own down(): this is a schema
// rollback, not a data time machine. (It also can't un-merge trips that were
// combined by up()'s backfill.)
exports.down = async function down(knex) {
  const isPg = knex.client.config.client === 'pg';

  // Read the encounters BEFORE touching `visits` - same cascade trap as up()
  // (see its comment): the SQLite rebuild drops the parent table, which would
  // empty visit_encounters via ON DELETE CASCADE before there was any chance
  // to copy the data back.
  const encounters = await knex('visit_encounters').orderBy('id', 'asc');

  if (isPg) {
    await knex.schema.alterTable('visits', (t) => {
      t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
      t.string('person_name');
      t.string('person_title');
      t.string('person_email');
      t.string('person_phone');
      t.string('met_with_type');
      t.string('outcome');
      t.boolean('they_requested').notNullable().defaultTo(false);
    });
  } else {
    for (const idx of [
      'visits_scheduled_date_index',
      'visits_place_id_index',
      'visits_user_id_index',
      'visits_status_index',
      'visits_place_status_date_index',
      'visits_user_date_index',
    ]) {
      await dropIndexIfExists(knex, idx);
    }
    await dropIndexIfExists(knex, 'visits_place_date_active_unique');

    await rebuildSqliteTable(
      knex,
      'visits',
      (tmp) =>
        knex.schema.createTable(tmp, (t) => {
          t.increments('id').primary();
          t.integer('place_id').references('id').inTable('places').onDelete('SET NULL');
          t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
          t.string('scheduled_date');
          t.string('status').notNullable().defaultTo('planned');
          t.integer('sort_order').notNullable().defaultTo(0);
          t.string('outcome');
          t.text('notes');
          t.string('person_name');
          t.string('person_title');
          t.string('person_email');
          t.string('person_phone');
          t.string('next_visit_date');
          t.timestamp('completed_at');
          t.timestamp('created_at').defaultTo(knex.fn.now());
          t.timestamp('updated_at').defaultTo(knex.fn.now());
          t.string('source').notNullable().defaultTo('manual');
          t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
          t.string('place_name');
          t.string('visit_type');
          t.string('met_with_type');
          t.integer('actual_duration_minutes');
          t.boolean('they_requested').notNullable().defaultTo(false);
          t.index(['scheduled_date'], 'visits_scheduled_date_index');
          t.index(['place_id'], 'visits_place_id_index');
          t.index(['user_id'], 'visits_user_id_index');
          t.index(['status'], 'visits_status_index');
          t.index(['person_id'], 'visits_person_id_index');
          t.index(['place_id', 'status', 'scheduled_date'], 'visits_place_status_date_index');
          t.index(['user_id', 'scheduled_date'], 'visits_user_date_index');
        }),
      'id, place_id, user_id, scheduled_date, status, sort_order, notes, next_visit_date, completed_at, created_at, updated_at, source, place_name, visit_type, actual_duration_minutes'
    );

    await knex.raw(
      `CREATE UNIQUE INDEX visits_place_date_active_unique ON visits(place_id, scheduled_date) WHERE status != 'skipped' AND source = 'planner'`
    );
  }

  // Repopulate from the first encounter of each trip.
  const seen = new Set();
  for (const e of encounters) {
    if (seen.has(e.visit_id)) continue;
    seen.add(e.visit_id);
    await knex('visits').where({ id: e.visit_id }).update({
      person_id: e.person_id,
      person_name: e.person_name,
      person_title: e.person_title,
      person_email: e.person_email,
      person_phone: e.person_phone,
      met_with_type: e.met_with_type,
      outcome: e.outcome,
      they_requested: e.they_requested,
    });
  }

  await knex.schema.dropTableIfExists('visit_encounters');
};
