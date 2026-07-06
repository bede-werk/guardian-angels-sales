// Import the referral partner list from the Excel workbook into the `partners` table.
//
// Usage:
//   npm run import                 # uses the default workbook path
//   node src/scripts/import-excel.js "/path/to/file.xlsx"
//
// Idempotent: it upserts on (name, address) so re-running won't create duplicates.
const path = require('path');
const XLSX = require('xlsx');
const knex = require('../db/knex');
const { priorityScore, regionForPartner } = require('../services/priority');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'Guardian Angels Sales List.xlsx');
const SHEET_NAME = '📋 Visit Tracker';
const HEADER_ROW = 2; // 1-indexed row in the sheet that holds column headers

// Clean up known inconsistencies in the source data.
function normalizeCategory(raw) {
  if (!raw) return null;
  const c = String(raw).trim();
  const fixes = {
    'Legal and Trust': 'Legal & Trust',
    'Senior Adisors': 'Senior Advisors',
  };
  return fixes[c] || c;
}

function parseTier(raw) {
  const m = String(raw || '').match(/(\d)/);
  return m ? parseInt(m[1], 10) : 3;
}

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function importPartners(file) {
  if (!file) file = DEFAULT_FILE;
  console.log(`Reading: ${file}`);

  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(`Sheet "${SHEET_NAME}" not found. Available: ${wb.SheetNames.join(', ')}`);
  }

  // Read as a matrix so we can honor the header being on row 2.
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  const header = matrix[HEADER_ROW - 1].map((h) => String(h == null ? '' : h).trim());
  const col = (name) => header.indexOf(name);

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
  const partners = [];
  for (const r of rows) {
    const name = clean(r[idx.name]);
    if (!name) continue; // skip blank/spacer rows

    const tier = parseTier(r[idx.tier]);
    const isPriority = /priority/i.test(String(r[idx.priority] || ''));
    const city = clean(r[idx.city]);
    const zip = clean(r[idx.zip]);

    partners.push({
      name,
      category: normalizeCategory(r[idx.category]),
      tier,
      is_priority: isPriority,
      priority_score: priorityScore(tier, isPriority),
      address: clean(r[idx.address]),
      city,
      state: clean(r[idx.state]),
      zip,
      region: regionForPartner({ city, zip }),
      updated_at: knex.fn.now(),
    });
  }

  console.log(`Parsed ${partners.length} partners.`);

  let inserted = 0;
  let updated = 0;
  await knex.transaction(async (trx) => {
    for (const p of partners) {
      // Upsert keyed on name + address (stable identity for these records).
      const existing = await trx('partners')
        .where({ name: p.name })
        .andWhere((qb) => (p.address ? qb.where({ address: p.address }) : qb.whereNull('address')))
        .first();

      if (existing) {
        await trx('partners').where({ id: existing.id }).update(p);
        updated += 1;
      } else {
        await trx('partners').insert(p);
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

  const total = await knex('partners').count({ c: '*' }).first();
  console.log(`Import complete. Inserted ${inserted}, updated ${updated}. Total partners: ${total.c}.`);
  return { inserted, updated, total: Number(total.c) };
}

module.exports = { importPartners };

// Run directly from the CLI (`npm run import`).
if (require.main === module) {
  importPartners(process.argv[2])
    .then(() => knex.destroy())
    .catch(async (err) => {
      console.error('Import failed:', err);
      await knex.destroy();
      process.exit(1);
    });
}
