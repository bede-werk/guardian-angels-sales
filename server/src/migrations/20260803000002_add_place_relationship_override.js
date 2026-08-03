// Migration C of the computed-relationship work (see services/relationship.js).
//
// Once relationship level is computed, a rep still needs a way to say "no, I
// know this one — trust me over the math." That's this override. It's kept
// deliberately heavier than a plain string column: who set it and when are
// stored alongside it, because the UI's contract is that an override and the
// computed value are shown TOGETHER whenever they disagree ("Strong (set
// manually by Bede, Jul 12) — computed: weak").
//
// That visible divergence is the entire mechanism keeping this from rotting
// the way the old manual relationship_temp field did (dropped in
// 20260710000000_drop_relationship_temp.js for going stale in practice). An
// override that silently replaces the computed value is invisible, and
// invisible is exactly how a manual field goes stale without anyone noticing.
// Overrides don't expire — they just can't hide.
//
// relationship_override_by is a brand-new NULLABLE FK, which is why this is a
// plain alterTable and not the rebuildSqliteTable dance from
// 20260709000000_detach_instead_of_cascade.js: that pattern is required when
// CHANGING or DROPPING a column that already carries a foreign key (SQLite
// keeps the old FK alongside the new one), not when adding a fresh one.
// SQLite's ALTER TABLE ADD COLUMN accepts a REFERENCES clause as long as the
// default is NULL, which it is.
//
// places.relationship_level is deliberately LEFT IN PLACE and untouched here.
// It becomes a read-only legacy column for one release so computed values can
// be compared against the old manual ones on real data before anything
// switches over (see the spec's build order — "compare computed vs. legacy
// across all places before switching"). Dropping it is a follow-up migration
// once that comparison is done, not this one's job.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('relationship_level_override'); // strong | medium | weak — nullable, null means "use computed"
    t.timestamp('relationship_override_at');
    t.integer('relationship_override_by').references('id').inTable('users').onDelete('SET NULL');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('relationship_level_override');
    t.dropColumn('relationship_override_at');
    t.dropColumn('relationship_override_by');
  });
};
