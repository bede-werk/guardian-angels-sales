// Drops seven `places` columns that are all fully retired - the cleanup pass
// three separate transitions each deferred "for one release."
//
// Every one of these was a MANUAL field that either governed routing or
// pretended to, and every one was replaced by something computed. They were
// kept readable for a release so computed values could be diffed against the
// old ones on real data; that comparison has happened for all three, so this
// is the end of the line.
//
//   tier
//   is_priority
//   priority_score       - retired 2026-08-23 (see 20260823000000 and
//                          services/priority.js). Tier + ⭐ was a four-level
//                          importance scale wearing a three-level costume,
//                          feeding a tie-break almost nothing read. The
//                          judgment moved to places.capacity_seed (the
//                          capacity axis) and places.is_all_star.
//
//   capacity_level
//   capacity_status
//   capacity_monthly_referrals
//                        - the manual guess, the one-way latch, and the
//                          number frozen at first pre-qual. Replaced by
//                          services/capacity.js 2026-08-07
//                          (capacity-computation-spec.md steps 1-7); this is
//                          that spec's step 9, the last one that was still
//                          open. Nothing in the ranker has read them since
//                          step 7.
//
//   relationship_level   - defaulted to 'weak', had no write path anywhere in
//                          the app, and was never once edited, so every place
//                          in the database read 'weak' and one whole axis of
//                          the cadence table did nothing. Replaced by
//                          services/relationship.js 2026-08-03 (see
//                          20260803000000-2 and HANDOFF.md §16).
//
// ORDER MATTERS, AND IT ALREADY WORKS: two earlier migrations read columns
// dropped here - 20260823000000 backfills capacity_seed from tier, and
// 20260824000000 backfills is_all_star from is_priority. Both run BEFORE this
// one, so a from-scratch migrate still sees the columns it needs at the moment
// it needs them. Don't renumber this migration earlier.
//
// WHAT ELSE HAD TO GO WITH THEM
//
// schedulingEngine.js carried three transition shims -
// effectiveRelationshipLevel/effectiveCapacityLevel/effectiveCapacityConfidence
// - each of the form `explicitValue ?? place.<legacy column>`. Each one's own
// comment said to delete it along with its column, and all three are gone now.
// That mattered more than it looks: only 6 of ~69 engine unit tests passed the
// values explicitly, so the other 63 were reaching the fallback and therefore
// exercising a code path production never took. The test file now translates
// its fixtures into explicit arguments in one documented helper instead.
//
// Also removed: scripts/capacity-legacy-diff.js (its entire job was diffing
// capacity_level against the computed level), a vestigial `p.capacity_level`
// in relationship.js's select that nothing read, and three dead fields on
// scheduleGenerator.js's stop shape that no consumer ever looked at.
//
// NO DOWN MIGRATION THAT RESTORES DATA. The columns come back empty. Their
// values are not recoverable - and would be worthless if they were, since the
// whole point is that every one of them was stale or never written. The
// `down` exists so the migration is reversible in shape (a fresh DB can roll
// back through it), not so a rollback recovers anything.
const COLUMNS = [
  'tier',
  'is_priority',
  'priority_score',
  'capacity_level',
  'capacity_status',
  'capacity_monthly_referrals',
  'relationship_level',
];

exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    for (const c of COLUMNS) t.dropColumn(c);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    // Shapes only - see the header. Types match the originals
    // (20260706000000_init.js and 20260712000000_add_scheduling_fields.js) so
    // a rolled-back schema still validates, but every column comes back NULL
    // (or 0, for the two that were NOT NULL with a default).
    t.integer('tier');
    t.boolean('is_priority').notNullable().defaultTo(false);
    t.integer('priority_score').notNullable().defaultTo(0);
    t.string('capacity_level');
    t.string('capacity_status');
    t.integer('capacity_monthly_referrals');
    t.string('relationship_level');
  });
};
