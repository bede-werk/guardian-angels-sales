// One-off: copy every row from the local SQLite database into a freshly
// migrated Postgres database. Written for the initial Railway cutover - the
// dev DB carries real data (geocoded places, the distance-matrix cache,
// people, referrals) that the bundled-spreadsheet auto-seed cannot reproduce.
//
// Usage:
//   NODE_ENV=production \
//   DATABASE_URL='postgres://…' PGSSL=require \
//   node src/scripts/pg-load-from-sqlite.js [--force] [--sqlite ./data/app.db] [--skip-migrate]
//
//   --force         target tables are TRUNCATEd first (default: abort if the
//                   target already holds data)
//   --sqlite PATH   source DB file (default: $SQLITE_FILE or ./data/app.db)
//   --skip-migrate  don't run knex migrate:latest on the target first
//
// What it does, in one transaction on the target:
//   1. (unless --skip-migrate) knex.migrate.latest() on the target
//   2. table by table, in FK-safe order, project each SQLite row onto the
//      columns that ALSO exist on the target, coercing 0/1 -> true/false for
//      boolean-typed target columns, and bulk-insert
//   3. bump each table's id sequence past the highest id copied
//   4. print a source-vs-target row-count table and exit non-zero on any
//      mismatch
//
// knex_migrations / knex_migrations_lock are deliberately NOT copied: the
// target manages its own migration ledger via step 1.

const path = require('path');
const knexLib = require('knex');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const SKIP_MIGRATE = argv.includes('--skip-migrate');
const sqliteArgIdx = argv.indexOf('--sqlite');
const SQLITE_FILE =
  sqliteArgIdx !== -1
    ? argv[sqliteArgIdx + 1]
    : process.env.SQLITE_FILE || path.join(__dirname, '..', '..', 'data', 'app.db');

if (process.env.NODE_ENV !== 'production' || !process.env.DATABASE_URL) {
  console.error('Refusing to run: set NODE_ENV=production and DATABASE_URL to the target Postgres.');
  process.exit(1);
}

// FK-safe insertion order. Every table with real data plus the ones that are
// empty today but could gain rows before a re-run - listed so a future run
// stays correct without editing this array.
const TABLE_ORDER = [
  'users',
  'categories',
  'places',
  'people',
  'referrals',
  'place_distance',
  'backfill_queue',
  'visits',
  'visit_encounters',
  'capacity_observations',
  'place_commitments',
  'schedule_drafts',
  'schedule_draft_stops',
  'settings',
];

const CHUNK = 1000;

const target = require('../db/knex'); // pg, because NODE_ENV=production
const source = knexLib({
  client: 'better-sqlite3',
  connection: { filename: SQLITE_FILE },
  useNullAsDefault: true,
});

async function targetColumns(tableName) {
  const rows = await target('information_schema.columns')
    .where({ table_schema: 'public', table_name: tableName })
    .select('column_name', 'data_type');
  const byName = new Map();
  for (const r of rows) byName.set(r.column_name, r.data_type);
  return byName;
}

async function sourceHasTable(tableName) {
  const row = await source('sqlite_master').where({ type: 'table', name: tableName }).first();
  return !!row;
}

function coerceValue(type, val) {
  if (val === null || val === undefined) return val;

  // SQLite 0/1 -> Postgres true/false.
  if (type === 'boolean') return Boolean(val);

  // Some rows store a timestamp as an epoch-ms integer (place_distance.computed_at
  // is written with Date.now()); SQLite keeps the number, Postgres needs a real
  // timestamp. Proper 'YYYY-MM-DD HH:MM:SS' strings pass straight through.
  if ((type.startsWith('timestamp') || type === 'date') && typeof val === 'number') {
    const ms = val < 1e12 ? val * 1000 : val; // tolerate seconds just in case
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) throw new Error(`unparseable ${type} value: ${val}`);
    return d.toISOString();
  }

  return val;
}

function coerceRow(row, targetCols) {
  const out = {};
  for (const [col, val] of Object.entries(row)) {
    const type = targetCols.get(col);
    if (type === undefined) continue; // column not on the target - drop it
    out[col] = coerceValue(type, val);
  }
  return out;
}

async function run() {
  console.log(`Source : ${SQLITE_FILE}`);
  console.log(`Target : ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ':****@')}`);
  console.log('');

  if (!SKIP_MIGRATE) {
    console.log('Running migrations on the target…');
    const [batchNo, log] = await target.migrate.latest();
    console.log(log.length ? `  applied ${log.length} migration(s) (batch ${batchNo})` : '  already up to date');
    console.log('');
  }

  const plan = [];
  for (const t of TABLE_ORDER) {
    if (!(await sourceHasTable(t))) continue;
    const [{ c: srcCount }] = await source(t).count({ c: '*' });
    plan.push({ table: t, srcCount: Number(srcCount) });
  }

  // Guard: never silently merge into a populated target.
  const nonEmpty = [];
  for (const { table } of plan) {
    const [{ c }] = await target(table).count({ c: '*' });
    if (Number(c) > 0) nonEmpty.push(`${table} (${c})`);
  }
  if (nonEmpty.length && !FORCE) {
    console.error(`Target already has data: ${nonEmpty.join(', ')}.`);
    console.error('Re-run with --force to TRUNCATE these tables first, or point at a fresh database.');
    process.exit(1);
  }

  const summary = [];
  await target.transaction(async (trx) => {
    if (nonEmpty.length) {
      // One TRUNCATE … CASCADE clears them all regardless of FK order.
      const names = plan.map((p) => trx.raw('??', [p.table]).toString()).join(', ');
      console.log(`--force: TRUNCATE ${names} RESTART IDENTITY CASCADE`);
      await trx.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
      console.log('');
    }

    for (const { table, srcCount } of plan) {
      const targetCols = await targetColumns(table);
      let copied = 0;

      if (srcCount > 0) {
        // Stable order so self-referencing tables (place_commitments) and any
        // id-ordered assumptions hold.
        const orderCol = targetCols.has('id') ? 'id' : targetCols.has('created_at') ? 'created_at' : null;
        let q = source(table).select('*');
        if (orderCol) q = q.orderBy(orderCol, 'asc');
        const rows = await q;

        for (let i = 0; i < rows.length; i += CHUNK) {
          const batch = rows.slice(i, i + CHUNK).map((r) => coerceRow(r, targetCols));
          await trx(table).insert(batch);
          copied += batch.length;
        }
      }

      // Bump the id sequence so the app's next INSERT doesn't collide.
      if (targetCols.has('id')) {
        await trx.raw(
          "SELECT setval(pg_get_serial_sequence(?, 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ??), 1), (SELECT COUNT(*) FROM ??) > 0)",
          [table, table, table]
        );
      }

      const [{ c: tgtCount }] = await trx(table).count({ c: '*' });
      summary.push({ table, src: srcCount, copied, target: Number(tgtCount), ok: srcCount === Number(tgtCount) });
      console.log(`  ${table.padEnd(22)} ${String(srcCount).padStart(6)} rows -> copied ${copied}`);
    }

    // Verify inside the transaction so any mismatch rolls the whole load back.
    const bad = summary.filter((s) => !s.ok);
    if (bad.length) {
      throw new Error(`row-count mismatch: ${bad.map((s) => `${s.table} ${s.src}->${s.target}`).join(', ')}`);
    }
  });

  console.log('');
  console.log('table                    source   target');
  console.log('----------------------  -------  -------');
  for (const s of summary) {
    console.log(`${s.table.padEnd(22)}  ${String(s.src).padStart(7)}  ${String(s.target).padStart(7)}  ok`);
  }

  await source.destroy();
  await target.destroy();
  console.log('\nLoad complete.');
}

run().catch(async (err) => {
  console.error('\nLoad failed (transaction rolled back):', err.message);
  try {
    await source.destroy();
    await target.destroy();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
