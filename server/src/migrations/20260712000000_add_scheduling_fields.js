// Adds the scheduling-engine fields from the Route Planner spec: capacity
// (potential, seeded from category then refined by pre-qualification) and
// relationship (manually judged) on places, plus a couple of guard fields
// (snooze/do-not-visit) and a skip_reason on visits. Also backfills every
// existing place's capacity_level from a keyword match against its
// (free-text, unnormalized) category, since the scoring engine needs a
// starting guess for places that haven't been pre-qualified yet.
//
// All plain alterTable calls — none of these are FK-bearing columns, so this
// doesn't need the rebuildSqliteTable rebuild pattern from
// 20260709000000_detach_instead_of_cascade.js (that's only required when
// changing/dropping a column that already carries a foreign key).

// Ordered first-match-wins, case-insensitive substring match against
// places.category. Tuned against the real category values in this dataset
// (see `SELECT category, COUNT(*) ... GROUP BY category` — Churches,
// Physicians, Assisted Living & Senior Living, Community Partners, Fire
// Stations, Physical Therapy, Rehabilitation Centers, Home Medical
// Equipment, Hospice, Hospitals, Legal & Trust, Vendors, Concierge Doc,
// Online Resource, Pharmacies, Case Managers, Funeral Homes, Senior
// Advisors), not just the spec's illustrative examples. A category that
// matches nothing falls back to 'medium' — adjustable per-place later via
// capacity_status = 'adjusted'.
const CAPACITY_BY_CATEGORY_KEYWORD = [
  [/hospital/i, 'high'],
  [/rehab/i, 'high'],
  [/physical therapy/i, 'high'],
  [/senior living|assisted living|independent living|memory care/i, 'high'],
  [/senior advisor/i, 'high'],
  [/case manager/i, 'high'],
  [/hospice/i, 'medium'],
  [/physician|concierge doc|medical/i, 'medium'],
  [/pharmac/i, 'medium'],
  [/community partner/i, 'medium'],
  [/elder law|legal|attorney|trust/i, 'low'],
  [/church/i, 'low'],
  [/fire station/i, 'low'],
  [/vendor/i, 'low'],
  [/funeral/i, 'low'],
  [/online resource/i, 'low'],
];

function capacityLevelForCategory(category) {
  const c = String(category || '');
  for (const [pattern, level] of CAPACITY_BY_CATEGORY_KEYWORD) {
    if (pattern.test(c)) return level;
  }
  return 'medium'; // documented fallback default
}

exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.string('capacity_level'); // high | medium | low
    t.integer('capacity_monthly_referrals'); // nullable — real number captured at pre-qual
    t.string('capacity_status').notNullable().defaultTo('estimated'); // estimated | adjusted | verified
    t.text('current_agency_used'); // free text intel, not a scoring input
    t.boolean('has_inhouse_service'); // nullable — unknown until pre-qual asks
    t.string('relationship_level').notNullable().defaultTo('weak'); // strong | medium | weak — never auto-set
    t.string('snooze_until'); // 'YYYY-MM-DD', nullable — matches next_visit_date/referral_date/birthday convention
    t.boolean('do_not_visit').notNullable().defaultTo(false);
  });

  await knex.schema.alterTable('visits', (t) => {
    t.text('skip_reason');
  });

  // The scoring engine's DB integration (later phase) will filter/aggregate
  // visits by exactly this triple (place_id + status + date-range), and
  // schedule/collision queries filter by user_id + date — index both now so
  // that phase doesn't need its own migration just for indexes.
  await knex.schema.alterTable('visits', (t) => {
    t.index(['place_id', 'status', 'scheduled_date'], 'visits_place_status_date_index');
    t.index(['user_id', 'scheduled_date'], 'visits_user_date_index');
  });

  // One-time backfill: seed every existing place's capacity_level from its
  // category. capacity_status is already defaulted to 'estimated' by the
  // column default above; set it explicitly here too for clarity/idempotency.
  const places = await knex('places').select('id', 'category');
  for (const p of places) {
    await knex('places')
      .where({ id: p.id })
      .update({ capacity_level: capacityLevelForCategory(p.category), capacity_status: 'estimated' });
  }
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropIndex(['place_id', 'status', 'scheduled_date'], 'visits_place_status_date_index');
    t.dropIndex(['user_id', 'scheduled_date'], 'visits_user_date_index');
  });
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('skip_reason');
  });
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('capacity_level');
    t.dropColumn('capacity_monthly_referrals');
    t.dropColumn('capacity_status');
    t.dropColumn('current_agency_used');
    t.dropColumn('has_inhouse_service');
    t.dropColumn('relationship_level');
    t.dropColumn('snooze_until');
    t.dropColumn('do_not_visit');
  });
};
