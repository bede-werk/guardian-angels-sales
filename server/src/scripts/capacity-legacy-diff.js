// Place-by-place diff of the legacy `places.capacity_level` column against
// the computed capacity service's `level` - required by
// capacity-computation-spec.md §15 step 6 ("compare computed-vs-legacy
// capacity_level across all real places and eyeball the diff before
// switching") before schedulingEngine.js's cadence lookup is actually
// swapped over. Nothing is wired to anything here; this is read-only
// reconnaissance to review BEFORE the swap, not after.
//
// Scope matches what step 6 actually touches: schedulingEngine.js's
// targetCadenceDays()/capacityRank() both read place.capacity_level only.
// place.capacity_status (the isEstimated tier-gate) is a separate consumer
// not in scope for step 6 - see the script's own footer note.
//
//   npm run capacity:legacy-diff

const knex = require('../db/knex');
const { computeCapacityForPlaces } = require('../services/capacity');
const { orgToday } = require('../services/orgDate');

async function main() {
  const asOf = orgToday();
  const places = await knex('places').select('id', 'name', 'category', 'capacity_level', 'capacity_status', 'capacity_monthly_referrals');
  if (!places.length) {
    console.log('No places in the database - nothing to report.');
    return;
  }

  const byPlace = await computeCapacityForPlaces(knex, places.map((p) => p.id), { asOf });
  const rows = places.map((p) => ({ ...p, cap: byPlace.get(p.id) })).filter((r) => r.cap);
  const total = rows.length;

  const same = rows.filter((r) => (r.capacity_level || null) === r.cap.level);
  const moved = rows.filter((r) => (r.capacity_level || null) !== r.cap.level);

  console.log(`\nLegacy capacity_level vs. computed level - ${total} places, as of ${asOf}`);
  console.log(`  unchanged: ${same.length} (${((same.length / total) * 100).toFixed(1)}%)`);
  console.log(`  moved:     ${moved.length} (${((moved.length / total) * 100).toFixed(1)}%)`);

  // Every move, broken down by WHY it moved - this is the part actually
  // worth eyeballing. A move explained by 'category_seed' (legacy column's
  // one-time backfill vs. the live category-seed table, which may have
  // changed since) is a different risk profile than a move explained by
  // 'measured' (our own referral data now outranks a stale/never-set
  // legacy guess) or 'declared' (a real pre-qual answer the legacy column
  // never picked up, e.g. logged before this build's dual-write bridge).
  const byReason = {};
  for (const r of moved) {
    const reason = r.cap.levelSource;
    (byReason[reason] ||= []).push(r);
  }

  for (const [reason, list] of Object.entries(byReason)) {
    console.log(`\n-- moved, computed levelSource = '${reason}' (${list.length}) --`);
    for (const r of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const legacy = r.capacity_level || '(null)';
      console.log(
        `  ${legacy.padEnd(8)} -> ${r.cap.level.padEnd(8)} conf=${r.cap.confidence.padEnd(8)} ` +
        `eff=${String(r.cap.effectiveMonthly ?? '-').padStart(4)}/mo  legacy_status=${(r.capacity_status || '-').padEnd(9)} ` +
        `legacy_referrals=${r.capacity_monthly_referrals ?? '-'}  ${(r.category || '-').padEnd(28)} ${r.name}`
      );
    }
  }

  console.log(`\n(place.capacity_status / the EXPLORATION tier's isEstimated gate is NOT in this diff`);
  console.log(` - that consumer is step 7's scope, not step 6's; it is untouched here.)\n`);
}

main()
  .then(() => knex.destroy())
  .catch((err) => {
    console.error(err);
    knex.destroy();
    process.exitCode = 1;
  });
