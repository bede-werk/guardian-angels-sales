// One-time (then occasional) job: fills the place_distance cache from a
// local OSRM instance. This is the only place in the app that ever needs
// OSRM running - route generation itself never calls it (see
// services/matrixCache.js's header), and this script starts/stops OSRM
// itself (see services/localOsrmProvider.js) rather than expecting one
// already running.
//
// Usage:
//   brew install osrm-backend                      (native, no Docker - or use Docker if you prefer)
//   curl -O https://download.geofabrik.de/north-america/us/nebraska-latest.osm.pbf   (~95MB)
//   osrm-extract -p <profiles>/car.lua nebraska-latest.osm.pbf   (~11s, ~2.4GB peak RAM)
//   osrm-partition nebraska-latest.osrm && osrm-customize nebraska-latest.osrm   (~8s combined)
//   OSRM_DATA_PATH=/path/to/nebraska-latest.osrm npm run backfill-distances
//
// The extract/partition/customize output (~900MB of nebraska-latest.osrm.*
// sidecar files) is what has to live wherever OSRM_DATA_PATH points, in
// production too (see .env.example) - this script itself never uploads
// anything anywhere, it only reads whatever's already at that path.
//
// Flags:
//   --force        recompute pairs already cached (after an OSM data refresh)
//   --chunk N      coordinates per axis per OSRM request (default 80)
//   --osrm-data-path PATH  overrides $OSRM_DATA_PATH
const knex = require('../db/knex');
const { backfillMatrix, coverageReport } = require('../services/matrixCache');
const { LocalOsrmProvider } = require('../services/localOsrmProvider');

function flagValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const force = process.argv.includes('--force');
const chunk = Number(flagValue('--chunk', 80));
const osrmDataPath = flagValue('--osrm-data-path', process.env.OSRM_DATA_PATH);

async function main() {
  const places = await knex('places')
    .whereNotNull('lat')
    .whereNotNull('lng')
    .select('id', 'lat', 'lng')
    .orderBy('id');

  if (places.length < 2) {
    console.error('Need at least 2 geocoded places. Found', places.length);
    process.exit(1);
  }

  const pairs = places.length * (places.length - 1);
  console.log(`${places.length} places -> ${pairs.toLocaleString()} directed pairs`);
  console.log(`OSRM data: ${osrmDataPath}  chunk: ${chunk}  force: ${force}\n`);

  const provider = new LocalOsrmProvider({ OSRM_DATA_PATH: osrmDataPath });
  console.log('Starting local OSRM…');
  await provider.start();

  const started = Date.now();
  let lastLog = 0;

  let written;
  let skipped;
  try {
    ({ written, skipped } = await backfillMatrix({
      db: knex,
      places,
      provider,
      chunk,
      force,
      onProgress: ({ block, totalBlocks, written: w }) => {
        const now = Date.now();
        if (now - lastLog < 1000 && block !== totalBlocks) return;
        lastLog = now;
        const pct = ((block / totalBlocks) * 100).toFixed(1);
        process.stdout.write(`\r  block ${block}/${totalBlocks} (${pct}%)  ${w.toLocaleString()} rows written   `);
      },
    }));
  } finally {
    await provider.stop();
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\nwrote ${written.toLocaleString()}, skipped ${skipped.toLocaleString()} in ${elapsed}s`);

  const report = await coverageReport(knex, places);
  if (report.complete) {
    console.log('Coverage complete.');
  } else {
    console.log(`\nIncomplete coverage for ${report.incomplete.length} place(s):`);
    for (const p of report.incomplete.slice(0, 20)) {
      console.log(`  place ${p.id}: ${p.have}/${p.expected}`);
    }
    console.log('Usually a bad geocode dropping a place off the road network.');
  }

  await knex.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
