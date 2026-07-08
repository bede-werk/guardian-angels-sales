// Renames "contacts" to "people" throughout the schema (matching the app's new
// People tab), links visits to a specific person instead of just a free-text
// snapshot, and gives places a durable notes field independent of any one visit.
//
//   - contacts -> people (pure rename, preserves data/indexes/FKs)
//   - referrals.contact_id -> referrals.person_id (follows the table rename)
//   - visits.contact_name/title/email/phone -> person_name/title/email/phone
//     (still a per-visit snapshot, just renamed to match)
//   - visits.person_id: NEW nullable FK to people — set when the "who did you
//     meet?" picker is used, so a person's visit history can be queried directly
//     instead of matching on the free-text snapshot.
//   - places.notes: NEW text field — durable, org-level notes (distinct from a
//     single visit's notes and a person's notes).

exports.up = async function up(knex) {
  await knex.schema.renameTable('contacts', 'people');

  await knex.schema.alterTable('referrals', (t) => {
    t.renameColumn('contact_id', 'person_id');
  });

  await knex.schema.alterTable('visits', (t) => {
    t.renameColumn('contact_name', 'person_name');
    t.renameColumn('contact_title', 'person_title');
    t.renameColumn('contact_email', 'person_email');
    t.renameColumn('contact_phone', 'person_phone');
  });

  await knex.schema.alterTable('visits', (t) => {
    t.integer('person_id').references('id').inTable('people').onDelete('SET NULL');
    t.index(['person_id']);
  });

  await knex.schema.alterTable('places', (t) => {
    t.text('notes');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('notes');
  });

  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('person_id');
  });

  await knex.schema.alterTable('visits', (t) => {
    t.renameColumn('person_name', 'contact_name');
    t.renameColumn('person_title', 'contact_title');
    t.renameColumn('person_email', 'contact_email');
    t.renameColumn('person_phone', 'contact_phone');
  });

  await knex.schema.alterTable('referrals', (t) => {
    t.renameColumn('person_id', 'contact_id');
  });

  await knex.schema.renameTable('people', 'contacts');
};
