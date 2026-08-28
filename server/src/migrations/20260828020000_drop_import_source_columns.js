// Drops the two columns migration 20260828000000 added for the one-time eRSP
// migration. Both were verified empty before this ran: every imported person
// and referral had its gaps closed by hand, which cleared each note as it was
// resolved, so no information is lost here.
//
// ---------------------------------------------------------------------------
// WHY transaction:false AND THE PRAGMA - this bit is load-bearing.
//
// SQLite has no real DROP COLUMN, so Knex emulates it: create a new table, copy
// the rows, DROP the old table, rename. That DROP fires every foreign key
// pointing AT the table being rebuilt - and knexfile.js turns `PRAGMA
// foreign_keys = ON` on for every connection. Rebuilding `people` therefore
// fires referrals.person_id's ON DELETE SET NULL and silently blanks the
// referrer on every referral in the database. It did exactly that on
// 2026-08-28 (75 referrals, restored from a backup).
//
// `PRAGMA foreign_keys` is a NO-OP inside a transaction, and Knex wraps each
// migration in one by default - so turning it off is only possible with
// `config.transaction = false` below. The two must go together; the pragma
// alone looks right and does nothing.
//
// Postgres is unaffected (native DROP COLUMN, no table rebuild), so this guard
// is specifically for SQLite - which is every local dev database.
//
// The same trap applies to ANY dropColumn on a table others reference. A drop
// on `places` would be worse still: place_distance, capacity_observations,
// backfill_queue and schedule_draft_stops all reference it ON DELETE CASCADE,
// so a rebuild would DELETE the whole cached distance matrix.
// ---------------------------------------------------------------------------
exports.config = { transaction: false };

async function withoutForeignKeys(knex, fn) {
  const isSqlite = String(knex.client.config.client).includes('sqlite');
  if (!isSqlite) return fn();
  await knex.raw('PRAGMA foreign_keys = OFF');
  try {
    return await fn();
  } finally {
    await knex.raw('PRAGMA foreign_keys = ON');
  }
}

exports.up = async function up(knex) {
  await withoutForeignKeys(knex, async () => {
    await knex.schema.alterTable('people', (t) => {
      t.dropColumn('import_source');
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.dropColumn('import_source');
    });
  });
};

// Re-adds them empty. The notes themselves aren't recoverable - they described
// a spreadsheet that is no longer the system of record.
exports.down = async function down(knex) {
  await withoutForeignKeys(knex, async () => {
    await knex.schema.alterTable('people', (t) => {
      t.text('import_source');
    });
    await knex.schema.alterTable('referrals', (t) => {
      t.text('import_source');
    });
  });
};
