// Adds password-based auth to users: a hash for the password itself and a
// long-lived session token issued at login (rotated on password change/logout).

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('password_hash');
    t.string('auth_token');
    t.index(['auth_token']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('password_hash');
    t.dropColumn('auth_token');
  });
};
