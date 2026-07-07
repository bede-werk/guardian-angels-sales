// CRM data-model split: "places" (partners) vs. "people" (contacts).
//
//   - partners gains the remaining place-level fields (main phone, lat/lng for routing).
//   - contacts is new: one-to-many off partners, every contact must belong to a place.
//   - referrals is new: links a referral to BOTH a partner and a contact so place
//     rankings can later be informed by contact-level relationship data. Nothing reads
//     this table yet — it's schema laid down ahead of that feature.
//
// Also backfills partners.priority_score onto the new scale (Tier 1 + Priority = 100,
// Tier 1 = 75, Tier 2 = 50, Tier 3 = 25). The formula is inlined here (not imported
// from services/priority.js) so this migration's behavior is frozen regardless of
// future edits to that file.

function priorityScore(tier, isPriority) {
  const tierWeight = { 1: 75, 2: 50, 3: 25 }[tier] || 0;
  const bonus = isPriority ? 25 : 0;
  return tierWeight + bonus;
}

exports.up = async function up(knex) {
  await knex.schema.alterTable('partners', (t) => {
    t.string('phone');
    t.decimal('lat', 10, 6);
    t.decimal('lng', 10, 6);
  });

  await knex.schema.createTable('contacts', (t) => {
    t.increments('id').primary();
    t.integer('partner_id').notNullable().references('id').inTable('partners').onDelete('CASCADE');

    t.string('name').notNullable();
    t.string('title');
    t.string('role_type'); // decision_maker | gatekeeper | champion | other

    t.string('email');
    t.string('phone'); // direct/cell, distinct from the place's main line

    t.string('relationship_temp'); // hot | warm | cold | dormant
    t.text('preferences');
    t.text('notes');
    t.string('birthday'); // free-form — birth year often unknown

    t.boolean('departed').notNullable().defaultTo(false); // turnover flag
    t.boolean('is_primary').notNullable().defaultTo(false);

    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['partner_id']);
    t.index(['relationship_temp']);
  });

  await knex.schema.createTable('referrals', (t) => {
    t.increments('id').primary();
    t.integer('partner_id').notNullable().references('id').inTable('partners').onDelete('CASCADE');
    t.integer('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');

    t.string('referral_date'); // 'YYYY-MM-DD'
    t.text('notes');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['partner_id']);
    t.index(['contact_id']);
  });

  // Backfill: recompute every partner's priority_score onto the new scale.
  const partners = await knex('partners').select('id', 'tier', 'is_priority');
  for (const p of partners) {
    await knex('partners')
      .where({ id: p.id })
      .update({ priority_score: priorityScore(p.tier, !!p.is_priority) });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.dropTableIfExists('contacts');
  await knex.schema.alterTable('partners', (t) => {
    t.dropColumn('phone');
    t.dropColumn('lat');
    t.dropColumn('lng');
  });
  // Note: priority_score backfill is not reversed — the old scale isn't recoverable
  // from tier/is_priority alone without the old formula, and down() migrations here
  // are for schema rollback, not a data time machine.
};
