// Hosted-routing RoutingProvider backed by the Mapbox Matrix API, used by the
// incremental distance backfill (services/backfillQueue.js) when a newly
// geocoded place needs its road distances filled in. It's the deployed
// stand-in for LocalOsrmProvider: no osrm-routed binary to install, no
// preprocessed .osrm dataset to ship - just an HTTPS call - which is what
// lets distance backfill work on a plain container (e.g. Railway). See
// matrixCache.js's backfillMatrix for the RoutingProvider contract, and
// services/routingProvider.js for how one or the other gets picked.
//
// The Matrix API caps a request at 25 total coordinates (sources +
// destinations) and 60 requests/minute. backfillMatrix hands this provider
// blocks far larger than that (it's written against OSRM's effectively
// unbounded /table), so table() sub-chunks internally to stay under the
// coordinate cap and paces requests to stay under the rate limit. Callers
// get back the same {distances, durations} matrix OSRM would have returned.
//
// Billing is one "element" per source-destination pair. Filling both
// directions for a new place is ~2 x (place count) elements; at a handful of
// new places a month that stays well inside Mapbox's free monthly allowance.
const { fetchWithTimeout } = require('./fetchWithTimeout');
const defaultConfig = require('../config/backfillQueue');

const PROFILE = 'mapbox/driving';
const MAX_COORDS = 25; // Matrix API hard limit: sources + destinations per request

// Split n items into consecutive [start, end) ranges of at most `size`.
function ranges(n, size) {
  const out = [];
  for (let i = 0; i < n; i += size) out.push([i, Math.min(i + size, n)]);
  return out;
}

class MapboxMatrixProvider {
  constructor(config = {}) {
    this.cfg = { ...defaultConfig, ...config };
    this.token = this.cfg.MAPBOX_TOKEN;
    this.baseUrl = this.cfg.MAPBOX_MATRIX_URL || 'https://api.mapbox.com/directions-matrix/v1';
    this.spacingMs = this.cfg.MAPBOX_REQUEST_SPACING_MS ?? 200;
    this.fetchFn = this.cfg.fetchFn
      || ((url) => fetchWithTimeout(url, { timeoutMs: this.cfg.MAPBOX_TIMEOUT_MS }));
  }

  // Labels the place_distance rows this provider's numbers land in (see
  // matrixCache.js's write loop), so a mixed cache stays honest about where
  // each pair came from.
  get source() {
    return 'mapbox';
  }

  // No process to manage - the "readiness" check is just that a token is
  // configured, surfaced here rather than on the first table() call so
  // drainQueue records one clear, actionable failure for every queued place
  // instead of a cryptic 401 partway through a backfill.
  async start() {
    if (!this.token) {
      throw new Error(
        'MAPBOX_TOKEN is not configured - set it to a Mapbox token with Matrix API access to enable distance backfill, or configure OSRM_DATA_PATH for a local OSRM instead.',
      );
    }
  }

  async stop() {}

  // sources, destinations: Array<{lat, lng}>. Returns { distances (metres),
  // durations (seconds) } as (number|null) matrices indexed
  // [sourcePosition][destinationPosition] - the same contract as
  // LocalOsrmProvider.table(). null means no route was found for that pair.
  async table(sources, destinations) {
    if (!this.token) throw new Error('MapboxMatrixProvider.table() called before start()');

    const distances = sources.map(() => new Array(destinations.length).fill(null));
    const durations = sources.map(() => new Array(destinations.length).fill(null));
    if (sources.length === 0 || destinations.length === 0) return { distances, durations };

    // Keep every request's coordinate count (sBlock + dBlock) <= MAX_COORDS,
    // biased toward more destinations per request since the incremental
    // worker's dominant shape is one new source vs. many destinations.
    const sBlockSize = Math.max(1, Math.min(sources.length, MAX_COORDS - 1));
    const dBlockSize = Math.max(1, MAX_COORDS - sBlockSize);

    let firstRequest = true;
    for (const [s0, s1] of ranges(sources.length, sBlockSize)) {
      for (const [d0, d1] of ranges(destinations.length, dBlockSize)) {
        if (!firstRequest && this.spacingMs) {
          await new Promise((resolve) => setTimeout(resolve, this.spacingMs));
        }
        firstRequest = false;

        const srcBlock = sources.slice(s0, s1);
        const dstBlock = destinations.slice(d0, d1);
        const { distances: dBlk, durations: tBlk } = await this._request(srcBlock, dstBlock);

        for (let a = 0; a < srcBlock.length; a++) {
          for (let b = 0; b < dstBlock.length; b++) {
            distances[s0 + a][d0 + b] = dBlk?.[a]?.[b] ?? null;
            durations[s0 + a][d0 + b] = tBlk?.[a]?.[b] ?? null;
          }
        }
      }
    }
    return { distances, durations };
  }

  // One Matrix API call for a block already known to be within the coordinate
  // cap. The coordinate list is sources followed by destinations; the
  // sources= / destinations= params then select by position into it.
  async _request(sources, destinations) {
    const coords = [...sources, ...destinations].map((p) => `${p.lng},${p.lat}`).join(';');
    const srcIdx = sources.map((_, i) => i).join(';');
    const dstIdx = destinations.map((_, i) => sources.length + i).join(';');
    const url =
      `${this.baseUrl}/${PROFILE}/${coords}`
      + `?annotations=distance,duration&sources=${srcIdx}&destinations=${dstIdx}`
      + `&access_token=${encodeURIComponent(this.token)}`;

    const res = await this.fetchFn(url);
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON error body */ }
      throw new Error(`Mapbox Matrix ${res.status} ${detail}`.trim());
    }
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(`Mapbox Matrix: ${body.code} ${body.message ?? ''}`.trim());
    return { distances: body.distances, durations: body.durations };
  }
}

module.exports = { MapboxMatrixProvider };
