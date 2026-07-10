// Shared Knex instance used by the whole app.
// The environment (development => SQLite, production => Postgres) is chosen in knexfile.js.
// Every route/service imports THIS file (not knex directly) so there's a single
// shared database connection pool for the whole server.
const knexLib = require('knex');
const config = require('../../knexfile');

// Pick which connection settings to use from knexfile.js based on NODE_ENV.
// Locally NODE_ENV isn't set to 'production', so this defaults to 'development' (SQLite).
const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';
const knex = knexLib(config[env]);

// better-sqlite3's .returning('id') gives back an id-only row on some Knex
// versions; Postgres gives the full row. Normalize either shape to just the id.
knex.extractId = (row) => (row && row.id ? row.id : row);

module.exports = knex;
