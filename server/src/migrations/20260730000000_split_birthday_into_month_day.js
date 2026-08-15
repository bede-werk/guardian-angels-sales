// Replaces people.birthday (free-form text, e.g. "March 14" - deliberately
// year-less since birth year is often unknown) with a real, structured
// birthday_month (1-12) / birthday_day (1-31) pair, so it can actually be
// used (populating the Calendar tab's birthday badges) instead of just
// being free-typed text that can hold garbage like "January 75" or "asdf".
// No backfill: the handful of existing values are all test data (some of it
// exactly that kind of garbage) and Bede's call was not to bother preserving
// them - real drop, not a soft-deprecated leftover column, same precedent as
// 20260724000000_drop_people_role_type.js.
exports.up = async function up(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.integer('birthday_month'); // 1-12, nullable
    t.integer('birthday_day'); // 1-31, nullable
  });
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('birthday');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('people', (t) => {
    t.string('birthday');
  });
  await knex.schema.alterTable('people', (t) => {
    t.dropColumn('birthday_month');
    t.dropColumn('birthday_day');
  });
};
