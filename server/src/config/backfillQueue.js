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

  // --- Hosted routing fallback (services/mapboxMatrixProvider.js) ---------
  // When there's no local OSRM dataset (OSRM_DATA_PATH unset or missing), the
  // backfill worker uses the Mapbox Matrix API instead, so a plain container
  // deploy with nothing installed can still fill a new place's distances.
  // MAPBOX_TOKEN is a Mapbox token with Matrix API access; it falls back to
  // the client's public token (VITE_MAPBOX_TOKEN) when that's the only one
  // set. With neither a dataset nor a token, backfill has no provider and
  // queued places simply retry - nothing else breaks, the cached matrix
  // keeps serving route generation. Same infra-config category as the
  // OSRM_* vars above: env-driven, not on the settings page.
  MAPBOX_TOKEN: process.env.MAPBOX_TOKEN || process.env.VITE_MAPBOX_TOKEN || null,

  MAPBOX_MATRIX_URL: process.env.MAPBOX_MATRIX_URL || 'https://api.mapbox.com/directions-matrix/v1',

  // Pause between consecutive Matrix API requests within one backfill, to
  // stay under the API's 60-requests-per-minute ceiling.
  MAPBOX_REQUEST_SPACING_MS: Number(process.env.MAPBOX_REQUEST_SPACING_MS) || 200,

  MAPBOX_TIMEOUT_MS: Number(process.env.MAPBOX_TIMEOUT_MS) || 15000,
};
