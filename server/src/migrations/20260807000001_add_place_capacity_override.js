// Migration B of the computed-capacity work (see 20260807000000's header,
// services/capacity.js). Mirrors the relationship-override pattern
// (20260803000002_add_place_relationship_override.js) in spirit - the
// override is stored SEPARATELY from the computed value, so the two can be
// shown together whenever they disagree, rather than one silently replacing
// the other. That visible divergence is what keeps an override from rotting
// the way a plain manual field does.
//
// Deliberately a free-text reason column here (capacity_override_reason)
// rather than the relationship override's `_by` user FK - this override
// exists specifically to let a rep say "I don't trust the stale number
// underneath this" in their own words, not just record who clicked a
// button; per the capacity spec's own schema (§5).
//
// All nullable, brand-new columns - plain alterTable, no rebuildSqliteTable
// dance needed (that's only required when changing/dropping a column that
// already carries a foreign key - see 20260709000000_detach_instead_of_cascade.js).
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('capacity_override_level'); // 'high' | 'medium' | 'low', nullable - null means "use computed"
    t.text('capacity_override_reason');
    t.timestamp('capacity_override_at');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('capacity_override_level');
    t.dropColumn('capacity_override_reason');
    t.dropColumn('capacity_override_at');
  });
};
