// Prints how every place in the database distributes across the computed
// relationship buckets, plus the score spread behind them.
//
// This exists because the buckets are only useful if they actually SEPARATE.
// If ~everything piles into one bucket, the relationship axis is dead again -
// exactly the failure this whole subsystem replaced - and the half-lives or
// thresholds need tuning BEFORE the ranker starts consuming the values. Run
// this against real data before wiring relationship into scheduling, and again
// after any seeding pass.
//
// Read-only: computes live, writes nothing.
//
//   npm run relationship:distribution

const knex = require('../db/knex');
const { computeRelationshipForPlaces, RELATIONSHIP_THRESHOLDS, LEVELS } = require('../services/relationship');
const { orgToday } = require('../services/orgDate');

function bar(count, total, width = 40) {
  if (!total) return '';
  return '#'.repeat(Math.round((count / total) * width));
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function main() {
  const asOf = orgToday();
  const places = await knex('places').select('id', 'name', 'category');
  if (!places.length) {
    console.log('No places in the database - nothing to report.');
    return;
  }

  const byPlace = await computeRelationshipForPlaces(knex, places.map((p) => p.id), { asOf });

  const rows = places.map((p) => ({ ...p, rel: byPlace.get(p.id) })).filter((r) => r.rel);
  const total = rows.length;

  console.log(`\nRelationship distribution - ${total} places, as of ${asOf}`);
  console.log(`Thresholds: strong >= ${RELATIONSHIP_THRESHOLDS.strong}, medium >= ${RELATIONSHIP_THRESHOLDS.medium}, else weak\n`);

  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  for (const r of rows) counts[r.rel.level] += 1;

  for (const level of LEVELS) {
    const n = counts[level];
    const pct = ((n / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${level.padEnd(7)} ${String(n).padStart(4)}  ${pct}%  ${bar(n, total)}`);
  }

  const scores = rows.map((r) => r.rel.score).sort((a, b) => a - b);
  const nonZero = scores.filter((s) => s > 0);
  console.log(`\nScore spread:`);
  console.log(`  min ${scores[0].toFixed(3)}   p50 ${percentile(scores, 50).toFixed(3)}   p90 ${percentile(scores, 90).toFixed(3)}   max ${scores[scores.length - 1].toFixed(3)}`);
  console.log(`  places scoring exactly 0: ${scores.length - nonZero.length} of ${total}`);

  // The health check that actually matters. A single bucket holding nearly
  // everything means the axis carries no information, whatever the scores say.
  const dominant = LEVELS.reduce((a, b) => (counts[a] >= counts[b] ? a : b));
  const dominantShare = counts[dominant] / total;
  console.log('');
  if (dominantShare > 0.9) {
    console.log(`  !! ${(dominantShare * 100).toFixed(0)}% of places are '${dominant}'. The axis is not separating.`);
    console.log(`     Tune half-lives/thresholds (or seed more people) before letting the ranker read this.`);
  } else {
    console.log(`  OK - largest bucket ('${dominant}') holds ${(dominantShare * 100).toFixed(0)}% of places; the axis separates.`);
  }

  const seeded = await knex('people').whereNotNull('relationship_seed').count('* as c').first();
  const people = await knex('people').count('* as c').first();
  console.log(`\n  Seeded people: ${seeded.c} of ${people.c}. (Unseeded people with no visit history contribute 0.)`);

  console.log(`\nTop 10 by score:`);
  for (const r of [...rows].sort((a, b) => b.rel.score - a.rel.score).slice(0, 10)) {
    const flag = r.rel.is_overridden ? ` [override: ${r.rel.effective_level}]` : '';
    console.log(`  ${r.rel.score.toFixed(3).padStart(7)}  ${r.rel.level.padEnd(7)} ${(r.category || '-').padEnd(32)} ${r.name}${flag}`);
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
