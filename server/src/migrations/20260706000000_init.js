// Initial schema. Written with the Knex schema builder (not raw SQL) so the same
// migration runs unchanged on both SQLite and PostgreSQL.

exports.up = async function up(knex) {
  // Team members. One user for now, but visits reference a user so we can add more later.
  await knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('email').unique();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  // Referral partners imported from the Excel sheet.
  await knex.schema.createTable('partners', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('category');
    t.integer('tier').notNullable().defaultTo(3); // 1, 2, or 3
    t.boolean('is_priority').notNullable().defaultTo(false);
    // Precomputed so we can sort/filter cheaply. Higher = more important.
    t.integer('priority_score').notNullable().defaultTo(0);
    t.string('address');
    t.string('city');
    t.string('state');
    t.string('zip');
    t.string('region'); // derived "side of town" bucket for clustering/display
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['tier']);
    t.index(['category']);
    t.index(['zip']);
  });

  // A visit is one planned/completed/skipped call on a partner by a user on a date.
  await knex.schema.createTable('visits', (t) => {
    t.increments('id').primary();
    // Delete a partner -> delete their visits too (CASCADE). Delete a user ->
    // keep their visits, just detach them (SET NULL) so history isn't lost.
    t.integer('partner_id').notNullable().references('id').inTable('partners').onDelete('CASCADE');
    t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');

    t.string('scheduled_date'); // 'YYYY-MM-DD' — kept as text for SQLite/Postgres parity
    t.string('status').notNullable().defaultTo('planned'); // planned | completed | skipped
    t.integer('sort_order').notNullable().defaultTo(0); // route order within a day (manual reorder)

    // Visit log
    t.string('outcome'); // interested | not_ready | follow_up | no_answer
    t.text('notes');
    t.string('contact_name');
    t.string('contact_title');
    t.string('contact_email');
    t.string('contact_phone');
    t.string('next_visit_date'); // 'YYYY-MM-DD'

    t.timestamp('completed_at');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());

    t.index(['scheduled_date']);
    t.index(['partner_id']);
    t.index(['user_id']);
    t.index(['status']);
  });
};

// Reverses `up`: drops the tables in the opposite order they were created, so
// foreign keys (visits -> partners/users) are gone before their targets are.
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('visits');
  await knex.schema.dropTableIfExists('partners');
  await knex.schema.dropTableIfExists('users');
};
