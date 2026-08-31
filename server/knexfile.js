// Knex configuration.
//
// This is the single place where the database engine is chosen. Locally we use
// SQLite (via better-sqlite3); in the cloud (Railway/Heroku) set NODE_ENV=production
// and provide DATABASE_URL and the app talks to PostgreSQL instead - with no query
// changes, because all data access goes through Knex.
require('dotenv').config();
const path = require('path');

const migrations = {
  directory: path.join(__dirname, 'src', 'migrations'),
};

// Two Postgres type-parser overrides so prod matches what SQLite (dev + the
// test suite) gives us. Loaded here, not db/knex.js, so the `knex migrate` CLI
// gets them too. Both are safe: each targets exactly one column shape.
//
//  - OID 1082 (DATE): pg returns a JS Date; SQLite a 'YYYY-MM-DD' string. Every
//    date in this app is a string, compared AS a string everywhere
//    (services/orgDate.js, doNotVisit.js, dashboardMetrics.js's daysBetween).
//    Left alone, place_commitments.promised_date / places.do_not_visit_until
//    come back as Dates on prod only - 500ing the dashboard (daysBetween calls
//    .slice) and silently disabling every timed do-not-visit mark.
//
//  - OID 1700 (NUMERIC/DECIMAL): pg returns a string to preserve precision;
//    SQLite a number. The ONLY numeric columns are places.lat / places.lng
//    (everything else is t.float -> real -> already a number). Left alone,
//    gridMeters()'s `(a.lat + b.lat)` string-concatenates -> NaN -> the route
//    planner's solver crashes on every generate. parseFloat is exact at 6dp.
if (process.env.NODE_ENV === 'production') {
  const pgTypes = require('pg').types;
  pgTypes.setTypeParser(1082, (value) => value);
  pgTypes.setTypeParser(1700, (value) => (value === null ? null : parseFloat(value)));
}

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
