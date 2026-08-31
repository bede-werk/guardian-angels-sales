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
const { regionForPlace } = require('../services/priority');
const { orgToday } = require('../services/orgDate');
const schedulingConfig = require('../config/scheduling');

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

// Translates the spreadsheet's Tier column (e.g. "Tier 1") plus its Priority
// column into a capacity rating in referrals/month - the same four-way
// mapping migration 20260823000000 used to backfill the existing 263 places,
// kept identical so a re-import can't disagree with what's already in the DB.
//
// The tier/is_priority COLUMNS are gone (dropped in 20260825000000); this
// spreadsheet is now the only place those two values exist at all, and they're
// translated into a capacity rating on the way in rather than stored.
//
// A blank/unparseable Tier cell now yields NULL - "nobody rated this" - where
// it used to default to 3. That default is exactly how 147 places came to
// assert a judgment nobody had made; an unrated place falls through to the
// category guess instead, which is the honest answer.
function parseCapacitySeed(tierRaw, priorityRaw, seedValues) {
  const m = String(tierRaw || '').match(/(\d)/);
  if (!m) return null;
  const tier = parseInt(m[1], 10);
  const isPriority = /priority/i.test(String(priorityRaw || ''));
  if (tier === 1) return isPriority ? seedValues.major : seedValues.strong;
  if (tier === 2) return seedValues.steady;
  if (tier === 3) return seedValues.occasional;
  return null; // a tier outside 1-3 has no honest translation
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

    const capacitySeed = parseCapacitySeed(r[idx.tier], r[idx.priority], schedulingConfig.CAPACITY_SEED_VALUES);
    const city = clean(r[idx.city]);
    const zip = clean(r[idx.zip]);

    places.push({
      name,
      category: normalizeCategory(r[idx.category]),
      capacity_seed: capacitySeed,
      // Left NULL deliberately, matching the migration's own backfill: a
      // rating that came off a spreadsheet has not been confirmed by anyone,
      // and NULL here is what puts the place in the review queue.
      capacity_seeded_at: null,
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
        // A brand-new place is eligible for EXPLORATION immediately - same
        // stamp POST /api/places writes (routes/places.js). Only on INSERT:
        // an existing row may already carry a real eligible_since (e.g. a
        // future date from a capacity observation) that a re-import must not
        // clobber. Without this, every seeded place has it NULL and the route
        // planner's daysSince(exploration_eligible_since) throws on first
        // generate - see services/schedulingEngine.js.
        await trx('places').insert({ ...p, exploration_eligible_since: orgToday() });
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
