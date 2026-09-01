// Replaces the single `users.auth_token` column with a real `sessions` table -
// one row per device a user is logged in on. Before this, every login rotated
// that one column, so signing in on a phone silently signed out the laptop.
// Now each login inserts its own session row and logout deletes just that one;
// change-password still clears every session for the user (its security point).
//
// See middleware/requireAuth.js (token lookup) and routes/auth.js (issue/clear).
//
// ---------------------------------------------------------------------------
// WHY transaction:false AND THE PRAGMA - same load-bearing reason as
// 20260828020000_drop_import_source_columns.js: SQLite has no real DROP COLUMN,
// so Knex rebuilds the table (create-copy-drop-rename), and that DROP fires
// every foreign key pointing AT `users` - visits.user_id, referrals.user_id,
// schedule_drafts.user_id (ON DELETE CASCADE!), and more. Rebuilding `users`
// with FKs on would blank or delete rows across half the schema. `PRAGMA
// foreign_keys` is a no-op inside a transaction, so turning it off needs
// config.transaction = false. Postgres has native DROP COLUMN and is
// unaffected; this guard is for the local SQLite databases.
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
  if (!(await knex.schema.hasTable('sessions'))) {
    await knex.schema.createTable('sessions', (t) => {
      t.increments('id').primary();
      t.string('token').notNullable().unique(); // requireAuth looks sessions up by this every request
      t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('user_agent'); // best-effort device label for a future "active sessions" view
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now()); // refreshed at most hourly - see requireAuth.js
      t.index(['user_id']);
    });
  }

  // Carry every currently-logged-in user across so the deploy doesn't bounce
  // anyone: their saved token keeps working, now as a session row.
  if (await knex.schema.hasColumn('users', 'auth_token')) {
    const live = await knex('users').whereNotNull('auth_token').select('id', 'auth_token');
    for (const u of live) {
      const exists = await knex('sessions').where({ token: u.auth_token }).first();
      if (!exists) await knex('sessions').insert({ token: u.auth_token, user_id: u.id });
    }

    await withoutForeignKeys(knex, async () => {
      await knex.schema.alterTable('users', (t) => {
        t.dropColumn('auth_token');
      });
    });
  }
};

exports.down = async function down(knex) {
  // Re-add the column (native ADD COLUMN in SQLite, no rebuild, so no FK guard
  // needed here) and hand each user back one token - the newest session they
  // have - so a rollback still leaves them logged in on one device.
  if (!(await knex.schema.hasColumn('users', 'auth_token'))) {
    await knex.schema.alterTable('users', (t) => {
      t.string('auth_token');
      t.index(['auth_token']);
    });
  }

  if (await knex.schema.hasTable('sessions')) {
    const sessions = await knex('sessions').orderBy('created_at', 'desc');
    const seen = new Set();
    for (const s of sessions) {
      if (seen.has(s.user_id)) continue;
      seen.add(s.user_id);
      await knex('users').where({ id: s.user_id }).update({ auth_token: s.token });
    }
    await knex.schema.dropTable('sessions');
  }
};
