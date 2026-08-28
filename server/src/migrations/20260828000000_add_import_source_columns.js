// TEMPORARY - added for the one-time eRSP migration, meant to be dropped once
// the Cleanup tab's queue is empty and that tab is removed.
//
// The import writes straight into the real `people`/`referrals` tables rather
// than a staging area (a one-time job into what were empty tables doesn't earn
// a staging system). Links it can't resolve are left NULL: a person whose
// employer didn't match any of the 263 places gets `place_id` NULL, a referral
// whose referrer didn't match anyone gets `person_id` NULL.
//
// A NULL alone isn't repairable, though - it says something is missing without
// saying what the CSV claimed, and the CSV is discarded after the import. That
// is what these columns carry: the raw unmatched text off the source row, so
// the Cleanup tab can show "the file said 'Bryan Health - East Campus'" next
// to a place picker. Without them the only way to fix a row would be to go
// back to a file that no longer exists.
//
// NULL on every pre-existing row, which is honest - nothing before this import
// came from a CSV at all.
exports.up = async function up(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.text('import_source');
  });
  await knex.schema.alterTable('referrals', (t) => {
    t.text('import_source');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('import_source');
  });
  await knex.schema.alterTable('referrals', (t) => {
    t.dropColumn('import_source');
  });
};
