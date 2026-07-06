// Knex configuration.
//
// This is the single place where the database engine is chosen. Locally we use
// SQLite (via better-sqlite3); in the cloud (Railway/Heroku) set NODE_ENV=production
// and provide DATABASE_URL and the app talks to PostgreSQL instead — with no query
// changes, because all data access goes through Knex.
require('dotenv').config();
const path = require('path');

const migrations = {
  directory: path.join(__dirname, 'src', 'migrations'),
};

module.exports = {
  development: {
    client: 'better-sqlite3',
    connection: {
      filename: process.env.SQLITE_FILE || path.join(__dirname, 'data', 'app.db'),
    },
    useNullAsDefault: true,
    migrations,
    // better-sqlite3 needs foreign keys turned on per-connection.
    pool: {
      afterCreate: (conn, done) => {
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      },
    },
  },

  production: {
    client: 'pg',
    connection: process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          // Most hosted Postgres (Railway/Heroku) require SSL.
          ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        }
      : undefined,
    pool: { min: 2, max: 10 },
    migrations,
  },
};
