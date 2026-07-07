// Renames "partners" to "places" throughout the schema, to match the CRM's
// Place/Person terminology (see the places-and-people data-model migration).
// Pure renames — renameTable/renameColumn preserve all existing data, indexes,
// and foreign keys, so this needs no backfill.

exports.up = async function up(knex) {
  await knex.schema.renameTable('partners', 'places');

  await knex.schema.alterTable('visits', (t) => {
    t.renameColumn('partner_id', 'place_id');
  });
  await knex.schema.alterTable('contacts', (t) => {
    t.renameColumn('partner_id', 'place_id');
  });
  await knex.schema.alterTable('referrals', (t) => {
    t.renameColumn('partner_id', 'place_id');
  });
  await knex.schema.alterTable('notes_review', (t) => {
    t.renameColumn('assigned_partner_id', 'assigned_place_id');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('notes_review', (t) => {
    t.renameColumn('assigned_place_id', 'assigned_partner_id');
  });
  await knex.schema.alterTable('referrals', (t) => {
    t.renameColumn('place_id', 'partner_id');
  });
  await knex.schema.alterTable('contacts', (t) => {
    t.renameColumn('place_id', 'partner_id');
  });
  await knex.schema.alterTable('visits', (t) => {
    t.renameColumn('place_id', 'partner_id');
  });

  await knex.schema.renameTable('places', 'partners');
};
