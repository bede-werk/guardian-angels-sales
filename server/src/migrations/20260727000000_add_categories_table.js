// Categories used to be a fixed enum in config/categories.js — this promotes
// it to a real table so it can be managed from the app (add/rename/retire)
// instead of requiring a code change + redeploy every time the business
// needs a new one. Seeded with the exact 18 values config/categories.js had
// (inlined here, not required from that file, so this migration stays a
// self-contained snapshot even after that file is deleted).
const EXISTING_CATEGORIES = [
  'Assisted Living & Senior Living',
  'Case Managers',
  'Churches',
  'Community Partners',
  'Concierge Doc',
  'Fire Stations',
  'Funeral Homes',
  'Home Medical Equipment',
  'Hospice',
  'Hospitals',
  'Legal & Trust',
  'Online Resource',
  'Pharmacies',
  'Physical Therapy',
  'Physicians',
  'Rehabilitation Centers',
  'Senior Advisors',
  'Vendors',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('categories', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable().unique();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
  await knex('categories').insert(EXISTING_CATEGORIES.map((name) => ({ name })));
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('categories');
};
