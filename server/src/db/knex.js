// Shared Knex instance used by the whole app.
// The environment (development => SQLite, production => Postgres) is chosen in knexfile.js.
const knexLib = require('knex');
const config = require('../../knexfile');

const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const knex = knexLib(config[env]);

module.exports = knex;
