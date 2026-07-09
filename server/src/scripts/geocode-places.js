// Backfills lat/lng for every place that hasn't been geocoded yet, using the
// Census Bureau's free batch geocoder (up to 10,000 addresses per request —
// comfortably covers our whole places table in one call).
//
// Usage:
//   npm run geocode
//
// Safe to re-run: only places with geocoded_at IS NULL are sent, and every
// row processed (matched or not) gets geocoded_at stamped so it isn't retried
// next run. Places whose address changes later are re-geocoded automatically
// by the create/update routes in routes/places.js, not by this script.
const knex = require('../db/knex');

const BATCH_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/addressbatch';

// One CSV field, quoted if it contains a comma or quote (per the CSV format
// the Census batch endpoint expects).
function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(places) {
  return places
    .map((p) => [p.id, p.address, p.city, p.state, p.zip].map(csvField).join(','))
    .join('\n');
}

// Parses the batch endpoint's response CSV into { id -> { lat, lng } | null }.
// Response columns: Unique ID, Input Address, Match Status, Match Type,
// Matched Address, Coordinates, Tiger Line ID, Side.
function parseResults(csvText) {
  const results = {};
  for (const line of csvText.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
    const clean = (f) => (f || '').replace(/^"|"$/g, '').replace(/""/g, '"');
    const id = clean(fields[0]);
    const matchStatus = clean(fields[2]);
    const coordinates = clean(fields[5]);
    if (matchStatus === 'Match' && coordinates) {
      const [lng, lat] = coordinates.split(',').map(Number);
      results[id] = { lat, lng };
    } else {
      results[id] = null;
    }
  }
  return results;
}

async function geocodePlaces() {
  const places = await knex('places').whereNull('geocoded_at').select('id', 'address', 'city', 'state', 'zip');
  if (!places.length) {
    console.log('Nothing to geocode — every place already has a geocoded_at.');
    return { matched: 0, unmatched: 0 };
  }

  console.log(`Geocoding ${places.length} place(s)...`);

  const form = new FormData();
  form.set('benchmark', 'Public_AR_Current');
  form.set('addressFile', new Blob([toCsv(places)], { type: 'text/csv' }), 'places.csv');

  const res = await fetch(BATCH_ENDPOINT, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Batch geocoder request failed: ${res.status} ${res.statusText}`);
  const results = parseResults(await res.text());

  let matched = 0;
  const unmatched = [];
  await knex.transaction(async (trx) => {
    for (const p of places) {
      const coords = results[String(p.id)];
      if (coords) {
        await trx('places').where({ id: p.id }).update({ lat: coords.lat, lng: coords.lng, geocoded_at: trx.fn.now() });
        matched += 1;
      } else {
        await trx('places').where({ id: p.id }).update({ geocoded_at: trx.fn.now() });
        unmatched.push(p);
      }
    }
  });

  console.log(`Matched ${matched}/${places.length}.`);
  if (unmatched.length) {
    console.log('Unmatched (left without coordinates — check these addresses):');
    for (const p of unmatched) console.log(`  #${p.id} ${p.address || ''}, ${p.city || ''}, ${p.state || ''} ${p.zip || ''}`);
  }
  return { matched, unmatched: unmatched.length };
}

module.exports = { geocodePlaces };

if (require.main === module) {
  geocodePlaces()
    .then(() => knex.destroy())
    .catch(async (err) => {
      console.error('Geocoding failed:', err);
      await knex.destroy();
      process.exit(1);
    });
}
