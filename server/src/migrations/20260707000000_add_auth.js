// Adds password-based auth to users: a hash for the password itself and a
// long-lived session token issued at login (rotated on password change/logout).

exports.up = async function up(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.string('password_hash'); // bcrypt hash; null until the user sets a password for the first time
    t.string('auth_token'); // current session token, or null if logged out (see requireAuth.js)
    t.index(['auth_token']); // requireAuth looks users up by this on every request
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('password_hash');
    t.dropColumn('auth_token');
  });
};
