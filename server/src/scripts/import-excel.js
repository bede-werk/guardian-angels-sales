// Import the referral place list from the Excel workbook into the `places` table.
//
// Usage:
//   npm run import                 # uses the default workbook path
//   node src/scripts/import-excel.js "/path/to/file.xlsx"
//
// Idempotent: it upserts on (name, address) so re-running won't create duplicates.
const path = require('path');
const XLSX = require('xlsx');
const knex = require('../db/knex');
const { priorityScore, regionForPlace } = require('../services/priority');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'Guardian Angels Sales List.xlsx');
const SHEET_NAME = '📋 Visit Tracker';
const HEADER_ROW = 2; // 1-indexed row in the sheet that holds column headers

// Clean up known typos/inconsistencies in the source spreadsheet's category column.
function normalizeCategory(raw) {
  if (!raw) return null;
  const c = String(raw).trim();
  const fixes = {
    'Legal and Trust': 'Legal & Trust',
    'Senior Adisors': 'Senior Advisors',
  };
  return fixes[c] || c;
}

// Pulls the first digit out of the Tier column (e.g. "Tier 1" -> 1). Defaults
// to 3 (lowest priority) if the cell is blank or doesn't contain a digit.
function parseTier(raw) {
  const m = String(raw || '').match(/(\d)/);
  return m ? parseInt(m[1], 10) : 3;
}

// Normalizes a spreadsheet cell: trims whitespace and turns blank strings into
// null (so "empty" is consistent whether the cell was blank or just spaces).
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Reads the workbook and upserts every place row into the database.
// Returns { inserted, updated, total } counts for the caller to log/report.
async function importPlaces(file) {
  if (!file) file = DEFAULT_FILE;
  console.log(`Reading: ${file}`);

  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }

  // Read as a matrix (array of arrays) rather than objects, so we can honor the
  // header being on row 2 instead of row 1 (the sheet has a title row above it).
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const header = matrix[HEADER_ROW - 1].map((h) => String(h == null ? '' : h).trim());
  const col = (name) => header.indexOf(name); // column index for a given header name

  const idx = {
    priority: col('Priority'),
    tier: col('Tier'),
    name: col('Organization / Location'),
    category: col('Source Category'),
    address: col('Address'),
    city: col('City'),
    state: col('St'),
    zip: col('Zip'),
  };

  const rows = matrix.slice(HEADER_ROW); // data starts after the header row
  const places = [];
  for (const r of rows) {
    const name = clean(r[idx.name]);
    if (!name) continue; // skip blank/spacer rows

    const tier = parseTier(r[idx.tier]);
    const isPriority = /priority/i.test(String(r[idx.priority] || ''));
    const city = clean(r[idx.city]);
    const zip = clean(r[idx.zip]);

    places.push({
      name,
      category: normalizeCategory(r[idx.category]),
      tier,
      is_priority: isPriority,
      priority_score: priorityScore(tier, isPriority),
      address: clean(r[idx.address]),
      city,
      state: clean(r[idx.state]),
      zip,
      region: regionForPlace({ city, zip }),
      updated_at: knex.fn.now(),
    });
  }

  console.log(`Parsed ${places.length} places.`);

  // Upsert one at a time inside a transaction: for each parsed row, look for an
  // existing place with the same name+address; update it if found, otherwise
  // insert a new one. This is what makes re-running the import safe/idempotent.
  let inserted = 0;
  let updated = 0;
  await knex.transaction(async (trx) => {
    for (const p of places) {
      // Upsert keyed on name + address (stable identity for these records).
      const existing = await trx('places')
        .where({ name: p.name })
        .andWhere((qb) => (p.address ? qb.where({ address: p.address }) : qb.whereNull('address')))
        .first();

      if (existing) {
        await trx('places').where({ id: existing.id }).update(p);
        updated += 1;
      } else {
        await trx('places').insert(p);
        inserted += 1;
      }
    }
  });

  // Ensure at least one team member exists so the app is usable immediately.
  const userCount = await knex('users').count({ c: '*' }).first();
  if (Number(userCount.c) === 0) {
    await knex('users').insert({ name: 'Sales Rep', email: 'rep@guardian-angels.us' });
    console.log('Seeded default user: Sales Rep');
  }

  const total = await knex('places').count({ c: '*' }).first();
  console.log(`Import complete. Inserted ${inserted}, updated ${updated}. Total places: ${total.c}.`);
  return { inserted, updated, total: Number(total.c) };
}

module.exports = { importPlaces };

// Run directly from the CLI (`npm run import`).
if (require.main === module) {
  importPlaces(process.argv[2])
    .then(() => knex.destroy())
    .catch(async (err) => {
      console.error('Import failed:', err);
      await knex.destroy();
      process.exit(1);
    });
}
