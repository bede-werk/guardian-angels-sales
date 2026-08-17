// Migration B of the computed-relationship work (see services/relationship.js).
//
// The seed exists to solve exactly one problem: on the day the computed model
// ships, no visit carries met_with_type/outcome data rich enough to score, so
// every place would read `weak` - including places where a real, valuable
// relationship exists. Weak + high capacity is a 7-day cadence, so the ranker
// would demand visits everywhere at once.
//
// relationship_seed is a converged SCORE value (not a bucket, not a
// multiplier) captured once per person from the rep's own judgment, and it
// decays on exactly the same clock as real visit weight:
//
//   decayed_seed = relationship_seed * 0.5 ^ (days_since_seeded / HALF_LIFE)
//
// That decay is the whole point, and why this is a seed rather than a
// permanent manual override: it's accurate on day one, washes out on its own
// (~3% of original after 5 months at a 30-day half-life - no expiry logic, no
// cleanup task), and self-corrects in the right direction. A real relationship
// gets visited, and genuine measured score replaces the seed as it fades. An
// optimistic seed that's never followed up decays to nothing, which is the
// honest answer. A seed is a claim with an expiration date attached; an
// override is a claim that is silently wrong forever.
//
// Both columns nullable: NULL seed means "no read given," which scores 0 and
// is a legitimate answer during seeding, not missing data to backfill.
// relationship_seeded_at is a plain 'YYYY-MM-DD' string, matching the existing
// convention for date-only columns here (next_visit_date, referral_date,
// snooze_until) rather than a timestamp - the decay math only ever works in
// whole days.
exports.up = async function up(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.float('relationship_seed'); // converged score value, e.g. 4.0 champion / 2.0 solid / 0.8 acquaintance
    t.string('relationship_seeded_at'); // 'YYYY-MM-DD', nullable - decay clock origin
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('relationship_seed');
    t.dropColumn('relationship_seeded_at');
  });
};
