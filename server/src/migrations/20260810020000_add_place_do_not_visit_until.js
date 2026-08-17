// Gives do_not_visit a real "until" date, same shape as places.snooze_until -
// NULL means indefinite once do_not_visit is true, a date means it lapses
// naturally (nothing clears it automatically; every read that cares does a
// live >= today() compare, same convention as snooze_until). See
// HANDOFF.md §19's do-not-visit addendum and capacity-computation-spec.md
// §4/§11.
exports.up = async function up(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.date('do_not_visit_until');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('places', (t) => {
    t.dropColumn('do_not_visit_until');
  });
};
