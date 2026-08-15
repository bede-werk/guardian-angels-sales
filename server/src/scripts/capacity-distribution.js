// Prints how every place in the database distributes across the computed
// capacity buckets - split by level, by levelSource, and by confidence -
// plus the effectiveMonthly spread behind them.
//
// This exists for the same reason relationship-distribution.js does (see its
// own header): the buckets are only useful if they actually SEPARATE. If
// nearly everything lands in one bucket, or nearly everything is still
// 'category_seed'/'unknown' (never pre-qualified), the axis carries no real
// information yet and the EXPLORATION tier ordering it's about to drive
// (capacity-computation-spec.md §8) would just be reading noise. Run this
// against real data BEFORE wiring capacity into schedulingEngine.js, and
// again after any re-qualification push.
//
// Read-only: computes live, writes nothing.
//
//   npm run capacity:distribution

const knex = require('../db/knex');
const { computeCapacityForPlaces } = require('../services/capacity');
const config = require('../config/scheduling');
const { orgToday } = require('../services/orgDate');

const LEVELS = ['high', 'medium', 'low'];
const LEVEL_SOURCES = ['override', 'measured', 'declared', 'category_seed'];
const CONFIDENCES = ['fresh', 'stale', 'unknown'];

function bar(count, total, width = 40) {
  if (!total) return '';
  return '#'.repeat(Math.round((count / total) * width));
}

function printBreakdown(title, keys, counts, total) {
  console.log(`\n${title}`);
  for (const key of keys) {
    const n = counts[key] || 0;
    const pct = total ? ((n / total) * 100).toFixed(1).padStart(5) : '0.0'.padStart(5);
    console.log(`  ${key.padEnd(14)} ${String(n).padStart(4)}  ${pct}%  ${bar(n, total)}`);
  }
}

async function main() {
  const asOf = orgToday();
  const places = await knex('places').select('id', 'name', 'category');
  if (!places.length) {
    console.log('No places in the database - nothing to report.');
    return;
  }

  const byPlace = await computeCapacityForPlaces(knex, places.map((p) => p.id), { asOf });
  const rows = places.map((p) => ({ ...p, cap: byPlace.get(p.id) })).filter((r) => r.cap);
  const total = rows.length;

  console.log(`\nCapacity distribution - ${total} places, as of ${asOf}`);
  console.log(`Thresholds: low 0-${config.CAPACITY_THRESHOLDS.MEDIUM_MIN - 1}, medium ${config.CAPACITY_THRESHOLDS.MEDIUM_MIN}-${config.CAPACITY_THRESHOLDS.HIGH_MIN - 1}, high ${config.CAPACITY_THRESHOLDS.HIGH_MIN}+`);
  console.log(`Stale after ${config.CAPACITY_STALE_DAYS} days; measured floor needs >=${config.MEASURED_MIN_REFERRAL_COUNT} referrals over >=${config.MEASURED_MIN_EXPOSURE_DAYS} days of exposure.`);

  const levelCounts = {};
  const sourceCounts = {};
  const confidenceCounts = {};
  for (const r of rows) {
    levelCounts[r.cap.level] = (levelCounts[r.cap.level] || 0) + 1;
    sourceCounts[r.cap.levelSource] = (sourceCounts[r.cap.levelSource] || 0) + 1;
    confidenceCounts[r.cap.confidence] = (confidenceCounts[r.cap.confidence] || 0) + 1;
  }

  printBreakdown('Level:', LEVELS, levelCounts, total);
  printBreakdown('Level source:', LEVEL_SOURCES, sourceCounts, total);
  printBreakdown('Confidence:', CONFIDENCES, confidenceCounts, total);

  const values = rows.map((r) => r.cap.effectiveMonthly).filter((v) => v != null).sort((a, b) => a - b);
  console.log(`\nEffective monthly referrals (${values.length} of ${total} places have a real number, not just a category guess):`);
  if (values.length) {
    const p = (pct) => values[Math.min(values.length - 1, Math.floor((pct / 100) * values.length))];
    console.log(`  min ${values[0]}   p50 ${p(50)}   p90 ${p(90)}   max ${values[values.length - 1]}`);
  } else {
    console.log('  (none yet - every place is still riding the category seed)');
  }

  // The health check that actually matters, same spirit as
  // relationship-distribution.js's: a single dominant bucket, or almost
  // nothing past 'category_seed'/'unknown', means this axis isn't ready to
  // drive the EXPLORATION tie-break yet.
  const dominantLevel = LEVELS.reduce((a, b) => (levelCounts[a] || 0) >= (levelCounts[b] || 0) ? a : b);
  const dominantShare = (levelCounts[dominantLevel] || 0) / total;
  const neverQualifiedShare = (sourceCounts.category_seed || 0) / total;

  console.log('');
  if (dominantShare > 0.9) {
    console.log(`  !! ${(dominantShare * 100).toFixed(0)}% of places are '${dominantLevel}'. The level axis is not separating.`);
  } else {
    console.log(`  OK - largest level bucket ('${dominantLevel}') holds ${(dominantShare * 100).toFixed(0)}% of places; the axis separates.`);
  }
  if (neverQualifiedShare > 0.9) {
    console.log(`  !! ${(neverQualifiedShare * 100).toFixed(0)}% of places have never been pre-qualified or measured (still 'category_seed'). Ordering within EXPLORATION is currently mostly the category guess, not real signal.`);
  } else {
    console.log(`  OK - only ${(neverQualifiedShare * 100).toFixed(0)}% of places are still on the category seed; most have a real declared and/or measured number.`);
  }

  console.log(`\nTop 10 by effective monthly referrals:`);
  for (const r of [...rows].filter((r) => r.cap.effectiveMonthly != null).sort((a, b) => b.cap.effectiveMonthly - a.cap.effectiveMonthly).slice(0, 10)) {
    const flag = r.cap.isOverridden ? ` [override: ${r.cap.level}, computed: ${r.cap.computedLevel}]` : '';
    console.log(`  ${String(r.cap.effectiveMonthly).padStart(4)}/mo  ${r.cap.level.padEnd(7)} ${r.cap.levelSource.padEnd(14)} ${(r.category || '-').padEnd(28)} ${r.name}${flag}`);
  }
  console.log('');
}

main()
  .then(() => knex.destroy())
  .catch((err) => {
    console.error(err);
    knex.destroy();
    process.exitCode = 1;
  });
