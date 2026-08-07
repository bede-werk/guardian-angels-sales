// Migration A of the computed-capacity work (see capacity-computation-spec.md
// §5, services/capacity.js — built next). Source of truth for DECLARED
// capacity: every pre-qual answer or manual adjustment appends a row here;
// nothing is ever overwritten or updated in place. 280 places at roughly one
// observation per year is a trivially small table on any real time horizon —
// deliberately not denormalized onto `places` for performance.
//
// No DB-level CHECK constraints (monthly_referrals >= 0, source enum) —
// matches this codebase's existing convention (capacity_status/
// relationship_level etc. are validated at the route layer, not the DB
// layer), and keeps the migration portable across both real backends
// (better-sqlite3 in dev, pg in production — see knexfile.js).
//
// person_id is nullable + ON DELETE SET NULL (not a hard requirement — a
// pre-qual answer might come from someone not yet on file, and the UI needs
// to keep showing "verified by Sharon, who no longer works here" even after
// Sharon herself is removed). Same for visit_id: an observation can exist
// with no backing visit at all (a manual adjustment, or an aggregate-only
// import row).
exports.up = async function up(knex) {
  await knex.schema.createTable('capacity_observations', (t) => {
    t.increments('id');
    t.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE');
    t.integer('monthly_referrals').notNullable();
    t.string('source').notNullable(); // 'prequal' | 'manual' | 'seed' | 'import'
    t.string('observed_at').notNullable(); // 'YYYY-MM-DD' — matches referral_date/scheduled_date convention
    t.integer('person_id').references('id').inTable('people').onDelete('SET NULL'); // who answered, nullable
    t.integer('visit_id').references('id').inTable('visits').onDelete('SET NULL'); // nullable — see header
    t.text('note');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['place_id', 'observed_at'], 'capacity_obs_place_observed_index');
  });

  // One-time backfill: every place with a pre-existing capacity_monthly_referrals
  // gets exactly one 'import' observation, so the new computed path has
  // something to read immediately instead of silently regressing every
  // pre-qualified place back to 'unknown' confidence.
  //
  // observed_at uses the real best-known date where one exists: for a
  // 'verified' place, that's its earliest completed visit's scheduled_date —
  // routes/visits.js's maybeCapturePreQualification only ever writes the
  // number on a place's FIRST completed visit, so that visit's date is
  // genuinely when the number was captured, not a guess. Every other case
  // (capacity_status: 'adjusted', a direct place-card edit with no
  // associated visit at all) has no reliable dated signal, so it falls back
  // to the place's own created_at — which will correctly read as stale
  // immediately. That's the honest answer, not a fabricated precision (see
  // the spec's own §5 note making this exact call).
  const places = await knex('places')
    .whereNotNull('capacity_monthly_referrals')
    .select('id', 'capacity_monthly_referrals', 'capacity_status', 'created_at');

  for (const p of places) {
    let observedAt = null;
    if (p.capacity_status === 'verified') {
      const firstVisit = await knex('visits')
        .where({ place_id: p.id, status: 'completed' })
        .orderBy('scheduled_date', 'asc')
        .first('scheduled_date');
      if (firstVisit) observedAt = firstVisit.scheduled_date;
    }
    if (!observedAt) {
      observedAt = new Date(p.created_at).toISOString().slice(0, 10);
    }
    await knex('capacity_observations').insert({
      place_id: p.id,
      monthly_referrals: p.capacity_monthly_referrals,
      source: 'import',
      observed_at: observedAt,
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('capacity_observations');
};
