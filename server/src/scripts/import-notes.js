// Import historical referrer notes from ReferrerNotes.xlsx.
//
//   npm run import:notes            # default file path
//   node src/scripts/import-notes.js "/path/to/ReferrerNotes.xlsx"
//
// Each note whose Referrer matches a place becomes a completed, "imported_note"
// visit on that place (so it appears in the place's history). Notes whose
// referrer can't be matched go into `notes_review` for manual mapping in the app.
// Idempotent: re-running won't duplicate imported visits or review rows.
const path = require('path');
const XLSX = require('xlsx');
const knex = require('../db/knex');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '..', 'ReferrerNotes.xlsx');

// Team members. The three note authors + Basil (no notes, just a team member).
// `aliases` maps the author name as written in the sheet to this user.
const USERS = [
  { name: 'Bede Fulton', email: 'bede@guardian-angels.us', aliases: ['Bede Fulton'] },
  { name: 'Nikki Shasserre', email: null, aliases: ['Nikki Shasserre', 'Nicole Shasserre'] },
  { name: 'Lisa Marks', email: null, aliases: ['Lisa Marks'] },
  { name: 'Basil Fulton', email: null, aliases: ['Basil Fulton'] },
];
const REMOVE_USERS = ['Sales Rep', 'Dana Fields']; // placeholders/test users

// Normalize a name for fuzzy comparison: lowercase, strip punctuation, collapse spaces.
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[.,'"&/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse "4/28/2026 3:40P" (or "...3:40PM") into a 'YYYY-MM-DD' string.
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/(\d)\s*([AP])M?$/i, '$1 $2M');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Build a matcher from places. Tries exact-normalized, then the text before a
// parenthesis, then the text inside a parenthesis (e.g. "Crystal (Gateway Vista)").
function buildMatcher(places) {
  const byNorm = new Map();
  for (const p of places) byNorm.set(norm(p.name), p);

  return function match(referrer) {
    if (!referrer) return null;
    const candidates = [];
    candidates.push(referrer);
    const paren = referrer.match(/^(.*?)\s*\((.*?)\)\s*$/);
    if (paren) {
      candidates.push(paren[1]); // text before "("
      candidates.push(paren[2]); // text inside "()"
    }
    for (const c of candidates) {
      const hit = byNorm.get(norm(c));
      if (hit) return hit;
    }
    return null;
  };
}

// Makes sure the real team members exist in the `users` table and removes
// leftover placeholder/test accounts, then builds a lookup from however an
// author's name was written in the spreadsheet to that user's id.
async function setupUsers(trx) {
  // Upsert the real team members (match on name).
  const nameToId = {};
  for (const u of USERS) {
    const existing = await trx('users').where({ name: u.name }).first();
    if (existing) {
      nameToId[u.name] = existing.id;
    } else {
      const [row] = await trx('users').insert({ name: u.name, email: u.email }).returning('id');
      nameToId[u.name] = row && row.id ? row.id : row;
    }
  }
  // Drop placeholder/test users (their visits, if any, are set null by FK).
  await trx('users').whereIn('name', REMOVE_USERS).del();

  // author-as-written -> user id
  const aliasToId = {};
  for (const u of USERS) for (const a of u.aliases) aliasToId[norm(a)] = nameToId[u.name];
  return { nameToId, aliasToId };
}

// Reads every note row from the workbook and, for each one, either imports it
// as a completed visit (referrer matched a place) or parks it in
// notes_review for a human to map later (referrer didn't match anything).
async function importNotes(file) {
  if (!file) file = DEFAULT_FILE;
  console.log(`Reading: ${file}`);
  const wb = XLSX.readFile(file);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false });
  console.log(`Found ${rows.length} note rows.`);

  const places = await knex('places').select('id', 'name');
  const match = buildMatcher(places);

  const stats = { imported: 0, review: 0, skippedDup: 0, noReferrer: 0, matchedRefs: new Set(), unmatchedRefs: new Set() };

  await knex.transaction(async (trx) => {
    const { aliasToId } = await setupUsers(trx);

    // One pass over every row in the spreadsheet.
    for (const r of rows) {
      const referrer = (r['Referrer'] || '').trim();
      const noteText = (r['Note'] || '').trim();
      const author = (r['Administrator'] || '').trim();
      const timeRaw = (r['Time'] || '').trim();
      const noteDate = parseDate(timeRaw);
      const authorUserId = aliasToId[norm(author)] || null;

      if (!referrer) {
        stats.noReferrer += 1;
        continue;
      }

      const place = match(referrer);
      if (place) {
        stats.matchedRefs.add(referrer);
        // Dedup: same place + date + note text already imported?
        const dup = await trx('visits')
          .where({ place_id: place.id, source: 'imported_note', scheduled_date: noteDate })
          .andWhere('notes', noteText)
          .first();
        if (dup) {
          stats.skippedDup += 1;
          continue;
        }
        await trx('visits').insert({
          place_id: place.id,
          user_id: authorUserId,
          scheduled_date: noteDate,
          status: 'completed',
          source: 'imported_note',
          notes: noteText,
          completed_at: noteDate ? `${noteDate} 12:00:00` : knex.fn.now(),
        });
        stats.imported += 1;
      } else {
        stats.unmatchedRefs.add(referrer);
        // Dedup review rows on referrer + date + note text.
        const dup = await trx('notes_review')
          .where({ referrer_raw: referrer, note_date: noteDate })
          .andWhere('note_text', noteText)
          .first();
        if (dup) {
          stats.skippedDup += 1;
          continue;
        }
        await trx('notes_review').insert({
          referrer_raw: referrer,
          note_text: noteText,
          note_date: noteDate,
          note_time_raw: timeRaw,
          author_raw: author,
          author_user_id: authorUserId,
          status: 'pending',
        });
        stats.review += 1;
      }
    }
  });

  console.log('\n=== Import summary ===');
  console.log(`Imported as visits:     ${stats.imported}`);
  console.log(`Parked for review:      ${stats.review}`);
  console.log(`Skipped (duplicates):   ${stats.skippedDup}`);
  console.log(`Rows without referrer:  ${stats.noReferrer}`);
  console.log(`Referrers matched:      ${stats.matchedRefs.size}`);
  console.log(`Referrers unmatched:    ${stats.unmatchedRefs.size}`);
  return { imported: stats.imported, review: stats.review };
}

module.exports = { importNotes };

// Run directly from the CLI (`npm run import:notes`).
if (require.main === module) {
  importNotes(process.argv[2])
    .then(() => knex.destroy())
    .catch(async (err) => {
      console.error('Notes import failed:', err);
      await knex.destroy();
      process.exit(1);
    });
}
