// One-time backfill: gives every currently-passwordless user a known default
// password ("Angels#1") instead of leaving them to self-serve one via the
// unauthenticated POST /api/auth/set-password — that endpoint can't require
// auth (there's no session yet on first login), which left a window where
// anyone reaching the API could claim an account before its real owner did.
// A stopgap ahead of a real login-page redesign (Bede: change-password
// button, a single seamless login form) — not the final answer, just closes
// the immediate gap for accounts that exist today.
const { hashPassword } = require('../services/auth');

const DEFAULT_PASSWORD = 'Angels#1';

exports.up = async function up(knex) {
  const password_hash = await hashPassword(DEFAULT_PASSWORD);
  await knex('users').whereNull('password_hash').update({ password_hash });
};

exports.down = async function down() {
  // Deliberately a no-op — same convention as this repo's other one-time data
  // backfills (e.g. 20260712000000_add_scheduling_fields.js's capacity_level
  // seed): reversing "give these accounts a password" isn't meaningful once
  // people may have already logged in and changed it.
};
