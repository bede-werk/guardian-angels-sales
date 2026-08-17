// place_commitments.place_id was created NOT NULL + ON DELETE CASCADE (see
// 20260811010000_add_place_commitments.js), which contradicts the
// detach-not-delete convention every sibling table follows (visits.place_id/
// people.place_id/referrals.place_id - see 20260709000000_detach_instead_of_cascade.js):
// deleting a place is supposed to preserve history with a null place_id, not
// take related rows down with it. Right now deleting a place silently
// destroys every commitment made there, which erases "Promised next visit -
// fulfilled" annotations off visits/people whose own history the earlier
// migration went out of its way to keep.
//
// Same SQLite-vs-Postgres split as that migration: Postgres can drop/re-add
// just the constraint; SQLite has to rebuild the table (a plain .alter() on
// a column that already carries a foreign key keeps the old FK as well as
// adding the new one).

async function dropIndexIfExists(knex, indexName) {
  await knex.raw(`DROP INDEX IF EXISTS "${indexName}"`);
}

async function rebuildSqliteTable(knex, name, buildNewTable, copyColumns) {
  const tmp = `${name}_rebuild`;
  await knex.schema.dropTableIfExists(tmp);
  await buildNewTable(tmp);
  await knex.raw(`INSERT INTO "${tmp}" (${copyColumns}) SELECT ${copyColumns} FROM "${name}"`);
  await knex.schema.dropTable(name);
  await knex.schema.renameTable(tmp, name);
}

const COLUMNS =
  'id, place_id, promised_date, person_id, note, source_visit_id, created_by_user_id, created_at, discharged_at, discharge_reason, discharged_by_visit_id, superseded_by_id';

exports.up = async function up(knex) {
  const isPg = knex.client.config.client === 'pg';

  if (isPg) {
    await knex.schema.alterTable('place_commitments', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('place_commitments', (t) => t.integer('place_id').nullable().alter());
    await knex.schema.alterTable('place_commitments', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('SET NULL');
    });
    return;
  }

  await dropIndexIfExists(knex, 'idx_place_commitments_outstanding');
  await rebuildSqliteTable(
    knex,
    'place_commitments',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
        t.increments('id').primary();
        t.integer('place_id').references('id').inTable('places').onDelete('SET NULL');
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
      }),
    COLUMNS
  );
  await knex.raw(
    `CREATE INDEX idx_place_commitments_outstanding ON place_commitments(place_id, promised_date) WHERE discharged_at IS NULL`
  );
};

exports.down = async function down(knex) {
  const isPg = knex.client.config.client === 'pg';

  if (isPg) {
    await knex.schema.alterTable('place_commitments', (t) => t.dropForeign('place_id'));
    await knex.schema.alterTable('place_commitments', (t) => t.integer('place_id').notNullable().alter());
    await knex.schema.alterTable('place_commitments', (t) => {
      t.foreign('place_id').references('id').inTable('places').onDelete('CASCADE');
    });
    return;
  }

  // SQLite: rebuild back to NOT NULL + CASCADE. Same documented limitation
  // as the detach_instead_of_cascade migration's own down() - any row that
  // picked up a null place_id while this was active can't round-trip back
  // to NOT NULL; down() is a schema rollback, not a data time machine.
  await dropIndexIfExists(knex, 'idx_place_commitments_outstanding');
  await rebuildSqliteTable(
    knex,
    'place_commitments',
    (tmp) =>
      knex.schema.createTable(tmp, (t) => {
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
      }),
    COLUMNS
  );
  await knex.raw(
    `CREATE INDEX idx_place_commitments_outstanding ON place_commitments(place_id, promised_date) WHERE discharged_at IS NULL`
  );
};
