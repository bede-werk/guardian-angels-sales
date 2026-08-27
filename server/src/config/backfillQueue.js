// Tunables for services/backfillQueue.js (retry policy, drain cadence) and
// services/localOsrmProvider.js (the on-demand local OSRM process). The OSRM
// process settings are deployment/infrastructure config, same category as
// DATABASE_PATH - env-var driven, not on the settings page. Retry policy and
// drain cadence ARE operator-tunable, same as everything else in config/.

module.exports = {
  // How many times a queued place is retried before it's marked permanently
  // failed (visible in the coverage report, not auto-retried again).
  MAX_ATTEMPTS: 5,

  // Backoff schedule in minutes, indexed by attempt number: after the 1st
  // failure wait 1 minute before the 2nd try, after the 2nd wait 5 before
  // the 3rd, etc. 5 attempts means 4 gaps between them - the 5th failure
  // has nothing to wait for, it just marks the row permanently failed.
  BACKOFF_MINUTES: [1, 5, 15, 60],

  // How often the in-process worker checks the queue for due work. Cheap
  // when the queue is empty (one indexed read) - OSRM itself is only ever
  // started when there's actually something to backfill.
  DRAIN_INTERVAL_MINUTES: 15,

  // Path to the region's preprocessed .osrm file. No default - a fresh
  // deployment has no OSM data until an operator runs the initial setup
  // (see scripts/backfill-distances.js), and the worker must fail loudly,
  // not guess at a path.
  OSRM_DATA_PATH: process.env.OSRM_DATA_PATH || null,

  // Assumed on PATH in production (installed via nixpacks.toml's osrm-backend
  // package); overridable for local dev where it's a Homebrew/other install.
  OSRM_ROUTED_BIN: process.env.OSRM_ROUTED_BIN || 'osrm-routed',

  OSRM_PORT: Number(process.env.OSRM_PORT) || 5555,

  // OSRM's own --max-table-size defaults to 100, meant for a live/public
  // server fielding arbitrary requests. This app only ever asks for "one
  // place vs. every other place," so it's raised generously - a company
  // with a few thousand places should never hit this ceiling.
  OSRM_MAX_TABLE_SIZE: 2000,

  // How long to wait for osrm-routed to report ready before giving up.
  OSRM_STARTUP_TIMEOUT_MS: 20000,
};
