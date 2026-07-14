// The visit type chosen during route-planner drafting (drop_in/check_in/
// working_visit/presentation/pre_qualification — see config/visitTypes.js)
// drives the whole time-budget math, so it needs somewhere to land once a
// draft stop is committed to a real visit — see 20260713000000's
// places.default_visit_type for the same nullable-override convention.
// Plain column add, no FK — no rebuildSqliteTable pattern needed (see
// 20260709000000_detach_instead_of_cascade.js's header for when that's
// required).
exports.up = async function up(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.string('visit_type');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('visits', (t) => {
    t.dropColumn('visit_type');
  });
};
