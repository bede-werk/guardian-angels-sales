// Adds support for importing historical referrer notes:
//   - visits.source  — distinguishes imported notes from routes generated in-app
//   - notes_review   — holding area for notes whose referrer didn't match a partner,
//                      to be assigned to a partner (or turned into one) by hand.

exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('source').notNullable().defaultTo('manual'); // manual | imported_note
  });

  await knex.schema.createTable('notes_review', (t) => {
    t.increments('id').primary();
    t.string('referrer_raw').notNullable(); // referrer text as written in the sheet
    t.text('note_text');
    t.string('note_date'); // 'YYYY-MM-DD'
    t.string('note_time_raw'); // original "4/28/2026 3:40P"
    t.string('author_raw');
    t.integer('author_user_id').references('id').inTable('users').onDelete('SET NULL');
    t.string('status').notNullable().defaultTo('pending'); // pending | assigned | dismissed
    t.integer('assigned_partner_id').references('id').inTable('partners').onDelete('SET NULL');
    t.integer('assigned_visit_id').references('id').inTable('visits').onDelete('SET NULL');
    t.timestamp('created_at').defaultTo(knex.fn.now());

    t.index(['status']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('notes_review');
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('source');
  });
};
