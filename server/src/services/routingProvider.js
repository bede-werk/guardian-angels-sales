// Picks the RoutingProvider the distance backfill should use, from what's
// configured in the environment. Order:
//
//   1. Local OSRM  - when OSRM_DATA_PATH points at a real preprocessed
//      dataset. Fastest, no per-call cost, no third-party dependency; this is
//      the dev machine and any deploy that ships the .osrm files.
//   2. Mapbox Matrix API - when there's no local dataset but MAPBOX_TOKEN is
//      set. Works on a plain container with nothing to install or ship, which
//      is why a Railway-style deploy uses it.
//   3. Local OSRM anyway - with neither configured, so start() throws the
//      existing "run the initial OSRM setup" error and the queue's
//      retry/backoff bookkeeping absorbs it exactly as it did before. Nothing
//      else breaks: the cached matrix keeps serving route generation.
//
// Every caller that backfills distances (the in-process worker in index.js,
// the Settings "run backfill now" route) goes through here so the choice is
// made in one place. scripts/backfill-distances.js stays on LocalOsrmProvider
// directly - it's the operator's bulk tool and always has the dataset.
const fs = require('node:fs');
const { LocalOsrmProvider } = require('./localOsrmProvider');
const { MapboxMatrixProvider } = require('./mapboxMatrixProvider');
const config = require('../config/backfillQueue');

function createRoutingProvider(overrides = {}) {
  const cfg = { ...config, ...overrides };
  const hasLocalOsrm = Boolean(cfg.OSRM_DATA_PATH)
    && fs.existsSync(`${cfg.OSRM_DATA_PATH}.properties`);

  if (!hasLocalOsrm && cfg.MAPBOX_TOKEN) {
    return new MapboxMatrixProvider(overrides);
  }
  return new LocalOsrmProvider(overrides);
}

module.exports = { createRoutingProvider };
