// Changes what happens when a place or person is deleted: instead of taking
// their visits (and, for a place, its people) down with them, everything just
// detaches. A deleted place's people become unassigned (place_id null) rather
// than deleted; a deleted place's (or person's) visits survive with a null
// place_id/person_id instead of being removed.
//
//   - visits.place_id / people.place_id / referrals.place_id+person_id:
//     NOT NULL + ON DELETE CASCADE -> nullable + ON DELETE SET NULL
//     (visits.person_id was already SET NULL from the people-rename migration)
//   - visits.place_name: NEW text snapshot of the place's name at the time the
//     visit was logged (mirrors the existing person_name/phone/email
//     snapshot), so a visit is still readable ("visited at Old Clinic") even
//     after that place is deleted and its live name is gone.
//
// SQLite note: a plain `.alter()` on a column that already has a foreign key
// doesn't replace that key — SQLite's rebuild-the-table strategy for altering
// a column ends up keeping the old FK *and* adding the new one. So on SQLite
// this migration rebuilds the three affected tables explicitly (create the
// corrected table under a temp name, copy the data across, drop the old one,
// rename) instead of using `.alter()`. Postgres supports dropping/re-adding
// just the constraint directly, so it takes the simpler path.
//
// Every index below is given an explicit name (rather than letting knex derive
// one from the temp table) and is dropped first if it happens to already
// exist. SQLite index names are unique *database-wide*, not per-table, so
// without this an index left over from a previous run of this same migration
// (e.g. a rollback) collides with the new one.

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

exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('place_name');
  });

  // Backfill the snapshot for any visits that already exist, from the place
  // they're currently linked to. Done row-by-row in JS rather than a raw
  // correlated-subquery UPDATE so this works identically on SQLite and Postgres.
  const rows = await knex('visits as v').join('places as p', 'p.id', 'v.place_id').select('v.id', 'p.name');
  for (const row of rows) {
    await knex('visits').where({ id: row.id }).update({ place_name: row.name });
  }

  const isPg = knex.client.config.client === 'pg';

  if (isPg) {
    await knex.schema.alterTable('visits', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('visits', (t) => t.integer('place_id').nullable().alter());
    await knex.schema.alterTable('visits', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('SET NULL');
    });

    await knex.schema.alterTable('people', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('people', (t) => t.integer('place_id').nullable().alter());
    await knex.schema.alterTable('people', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('SET NULL');
    });

    await knex.schema.alterTable('referrals', (t) => {
      t.dropForeign('place_id');
      t.dropForeign('person_id');
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.integer('place_id').nullable().alter();
      t.integer('person_id').nullable().alter();
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('SET NULL');
      t.foreign('person_id').references('id').inTable('people').onDelete('SET NULL');
    });
    return;
  }

  // --- SQLite: explicit rebuilds, one table at a time ---

  for (const idx of ['visits_scheduled_date_index', 'visits_place_id_index', 'visits_user_id_index', 'visits_status_index', 'visits_person_id_index']) {
    await dropIndexIfExists(knex, idx);
  }
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
        t.index(['scheduled_date'], 'visits_scheduled_date_index');
        t.index(['place_id'], 'visits_place_id_index');
        t.index(['user_id'], 'visits_user_id_index');
        t.index(['status'], 'visits_status_index');
        t.index(['person_id'], 'visits_person_id_index');
      }),
    'id, place_id, user_id, scheduled_date, status, sort_order, outcome, notes, person_name, person_title, person_email, person_phone, next_visit_date, completed_at, created_at, updated_at, source, person_id, place_name'
  );

  for (const idx of ['people_place_id_index', 'people_relationship_temp_index']) {
    await dropIndexIfExists(knex, idx);
  }
  await rebuildSqliteTable(
    knex,
    'people',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').references('id').inTable('places').onDelete('SET NULL');
        t.string('name').notNullable();
        t.string('title');
        t.string('role_type');
        t.string('email');
        t.string('phone');
        t.string('relationship_temp');
        t.text('preferences');
        t.text('notes');
        t.string('birthday');
        t.boolean('departed').notNullable().defaultTo(false);
        t.boolean('is_primary').notNullable().defaultTo(false);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.index(['place_id'], 'people_place_id_index');
        t.index(['relationship_temp'], 'people_relationship_temp_index');
      }),
    'id, place_id, name, title, role_type, email, phone, relationship_temp, preferences, notes, birthday, departed, is_primary, created_at, updated_at'
  );

  for (const idx of ['referrals_place_id_index', 'referrals_person_id_index']) {
    await dropIndexIfExists(knex, idx);
  }
  await rebuildSqliteTable(
    knex,
    'referrals',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').references('id').inTable('places').onDelete('SET NULL');
        t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
        t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
        t.string('referral_date');
        t.text('notes');
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['place_id'], 'referrals_place_id_index');
        t.index(['person_id'], 'referrals_person_id_index');
      }),
    'id, place_id, person_id, user_id, referral_date, notes, created_at'
  );
};

exports.down = async function down(knex) {
  const isPg = knex.client.config.client === 'pg';

  if (isPg) {
    await knex.schema.alterTable('referrals', (t) => {
      t.dropForeign('place_id');
      t.dropForeign('person_id');
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.integer('place_id').notNullable().alter();
      t.integer('person_id').notNullable().alter();
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('CASCADE');
      t.foreign('person_id').references('id').inTable('people').onDelete('CASCADE');
    });

    await knex.schema.alterTable('people', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('people', (t) => t.integer('place_id').notNullable().alter());
    await knex.schema.alterTable('people', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('CASCADE');
    });

    await knex.schema.alterTable('visits', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('visits', (t) => t.integer('place_id').notNullable().alter());
    await knex.schema.alterTable('visits', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('CASCADE');
    });

    await knex.schema.alterTable('visits', (t) => {
      t.dropColumn('place_name');
    });
    return;
  }

  // SQLite: rebuild back to NOT NULL + CASCADE. (Any rows that picked up a
  // null place_id/person_id while this migration was active can't round-trip
  // back to NOT NULL — same documented limitation as the priority_score
  // backfill in an earlier migration: down() is a schema rollback, not a
  // data time machine.)
  for (const idx of ['referrals_place_id_index', 'referrals_person_id_index']) {
    await dropIndexIfExists(knex, idx);
  }
  await rebuildSqliteTable(
    knex,
    'referrals',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
        t.integer('person_id').notNullable().references('id').inTable('people').onDelete('CASCADE');
        t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
        t.string('referral_date');
        t.text('notes');
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.index(['place_id'], 'referrals_place_id_index');
        t.index(['person_id'], 'referrals_person_id_index');
      }),
    'id, place_id, person_id, user_id, referral_date, notes, created_at'
  );

  for (const idx of ['people_place_id_index', 'people_relationship_temp_index']) {
    await dropIndexIfExists(knex, idx);
  }
  await rebuildSqliteTable(
    knex,
    'people',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
        t.string('name').notNullable();
        t.string('title');
        t.string('role_type');
        t.string('email');
        t.string('phone');
        t.string('relationship_temp');
        t.text('preferences');
        t.text('notes');
        t.string('birthday');
        t.boolean('departed').notNullable().defaultTo(false);
        t.boolean('is_primary').notNullable().defaultTo(false);
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.fn.now());
        t.index(['place_id'], 'people_place_id_index');
        t.index(['relationship_temp'], 'people_relationship_temp_index');
      }),
    'id, place_id, name, title, role_type, email, phone, relationship_temp, preferences, notes, birthday, departed, is_primary, created_at, updated_at'
  );

  for (const idx of ['visits_scheduled_date_index', 'visits_place_id_index', 'visits_user_id_index', 'visits_status_index', 'visits_person_id_index']) {
    await dropIndexIfExists(knex, idx);
  }
  await rebuildSqliteTable(
    knex,
    'visits',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
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
        t.index(['scheduled_date'], 'visits_scheduled_date_index');
        t.index(['place_id'], 'visits_place_id_index');
        t.index(['user_id'], 'visits_user_id_index');
        t.index(['status'], 'visits_status_index');
        t.index(['person_id'], 'visits_person_id_index');
      }),
    'id, place_id, user_id, scheduled_date, status, sort_order, outcome, notes, person_name, person_title, person_email, person_phone, next_visit_date, completed_at, created_at, updated_at, source, person_id'
  );
};
