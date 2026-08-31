// Postgres-only: normalize the foreign-key constraint names left stale by the
// partners->places (20260707020000) and contacts->people (20260708000000)
// renames.
//
// Postgres keeps a constraint's ORIGINAL name when the column or table it
// covers is renamed. So after those two migrations, `visits.place_id`'s FK is
// still called `visits_partner_id_foreign`, `people.place_id`'s is
// `contacts_partner_id_foreign`, and so on. Knex's `.dropForeign('place_id')`
// derives the name `visits_place_id_foreign` - which does not exist - so
// 20260709000000_detach_instead_of_cascade.js's Postgres branch fails on a
// fresh deploy with:
//
//   alter table "visits" drop constraint "visits_place_id_foreign" -
//   constraint "visits_place_id_foreign" of relation "visits" does not exist
//
// This renames the four constraints that later migrations drop by name to the
// canonical `<table>_<column>_foreign` form Knex expects. SQLite never names FK
// constraints (and alters columns by rebuilding the whole table), so there is
// nothing to do there - the guard makes this a no-op on every dev database.
//
// Ordered 20260708120000 so it runs after the renames and before the first
// migration that drops one of these constraints by name.

const STALE = [
  ['visits', 'visits_partner_id_foreign', 'visits_place_id_foreign'],
  ['people', 'contacts_partner_id_foreign', 'people_place_id_foreign'],
  ['referrals', 'referrals_partner_id_foreign', 'referrals_place_id_foreign'],
  ['referrals', 'referrals_contact_id_foreign', 'referrals_person_id_foreign'],
];

exports.up = async function up(knex) {
  if (knex.client.config.client !== 'pg') return;

  for (const [table, from, to] of STALE) {
    const { rows } = await knex.raw(
      'SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass',
      [from, table]
    );
    if (rows.length) {
      await knex.raw('ALTER TABLE ?? RENAME CONSTRAINT ?? TO ??', [table, from, to]);
    }
  }
};

exports.down = async function down(knex) {
  if (knex.client.config.client !== 'pg') return;

  // Reverse only what still carries the canonical name, so a re-up stays clean.
  for (const [table, from, to] of STALE) {
    const { rows } = await knex.raw(
      'SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass',
      [to, table]
    );
    if (rows.length) {
      await knex.raw('ALTER TABLE ?? RENAME CONSTRAINT ?? TO ??', [table, to, from]);
    }
  }
};
