// On-demand local OSRM: the RoutingProvider implementation used both by the
// bulk backfill script and the incremental backfill queue worker. Nothing
// else in the app ever imports this file - see matrixCache.js's backfillMatrix
// for the interface a RoutingProvider must implement (start/stop/table).
//
// "On-demand" means exactly that: osrm-routed is spawned as a child process
// only for the duration of a backfill run (start() ... table() calls ...
// stop()), not left running. A new place is created a few times a month, so
// there's no standing cost to avoid paying - see config/backfillQueue.js's
// header for why these settings are deployment config, not a business
// tunable.
const { spawn: defaultSpawn } = require('node:child_process');
const fs = require('node:fs');
const defaultConfig = require('../config/backfillQueue');

// @param sources/destinations  Array<{lat, lng}>
function buildTableUrl({ baseUrl, sources, destinations }) {
  const coords = [...sources, ...destinations].map((p) => `${p.lng},${p.lat}`).join(';');
  const sourceIdx = sources.map((_, i) => i).join(';');
  const destIdx = destinations.map((_, i) => sources.length + i).join(';');
  return `${baseUrl}/table/v1/driving/${coords}?sources=${sourceIdx}&destinations=${destIdx}&annotations=distance,duration`;
}

class LocalOsrmProvider {
  constructor(config = {}) {
    this.cfg = { ...defaultConfig, ...config };
    this.spawnFn = this.cfg.spawnFn || defaultSpawn;
    this.fetchFn = this.cfg.fetchFn || fetch;
    this.process = null;
    this.baseUrl = `http://127.0.0.1:${this.cfg.OSRM_PORT}`;
  }

  // Spawns osrm-routed and resolves once it's actually answering requests.
  // Rejects promptly (rather than waiting the full timeout) if the process
  // exits early - a missing binary or a corrupt/missing .osrm file both
  // surface as an early exit, not a hang.
  async start() {
    if (this.process) return; // already running - start() is idempotent

    if (!this.cfg.OSRM_DATA_PATH) {
      throw new Error('OSRM_DATA_PATH is not configured - run the initial OSRM setup (see scripts/backfill-distances.js) before backfilling.');
    }
    // OSRM_DATA_PATH is a base name, not a literal file - osrm-extract's
    // output is a set of sidecar files (nebraska.osrm.properties,
    // nebraska.osrm.geometry, ...), never a bare "nebraska.osrm" itself.
    // .properties is always present in a valid dataset, so its existence
    // stands in for "the dataset is there."
    if (!fs.existsSync(`${this.cfg.OSRM_DATA_PATH}.properties`)) {
      throw new Error(`OSRM data not found at ${this.cfg.OSRM_DATA_PATH} (expected ${this.cfg.OSRM_DATA_PATH}.properties) - run the initial OSRM setup first.`);
    }

    const child = this.spawnFn(this.cfg.OSRM_ROUTED_BIN, [
      '--algorithm', 'mld',
      '--port', String(this.cfg.OSRM_PORT),
      '--max-table-size', String(this.cfg.OSRM_MAX_TABLE_SIZE),
      this.cfg.OSRM_DATA_PATH,
    ]);
    this.process = child;

    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.process = null;
        reject(err);
      };

      child.once('error', fail); // e.g. ENOENT - osrm-routed isn't on PATH
      child.once('exit', (code) => fail(new Error(`osrm-routed exited early (code ${code}) before becoming ready - check its stderr output.`)));

      const startedAt = Date.now();
      const poll = async () => {
        if (settled) return;
        try {
          // Any HTTP response (even an error one) means the server is up -
          // this deliberately doesn't validate the query itself.
          await this.fetchFn(`${this.baseUrl}/table/v1/driving/0,0;0.01,0.01`);
          if (settled) return;
          settled = true;
          child.removeListener('error', fail);
          child.removeListener('exit', fail);
          resolve();
        } catch {
          if (Date.now() - startedAt > this.cfg.OSRM_STARTUP_TIMEOUT_MS) {
            fail(new Error(`osrm-routed did not become ready within ${this.cfg.OSRM_STARTUP_TIMEOUT_MS}ms.`));
            return;
          }
          setTimeout(poll, 200);
        }
      };
      poll();
    });
  }

  async stop() {
    if (!this.process) return;
    const child = this.process;
    this.process = null;
    await new Promise((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      // Local, short-lived process - if it doesn't exit promptly, force it
      // rather than let a backfill run hang the worker forever.
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 5000);
    });
  }

  async table(sources, destinations) {
    if (!this.process) throw new Error('LocalOsrmProvider.table() called before start()');

    const url = buildTableUrl({ baseUrl: this.baseUrl, sources, destinations });
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const body = await res.json();
    if (body.code !== 'Ok') throw new Error(`OSRM: ${body.code} ${body.message ?? ''}`);
    return { distances: body.distances, durations: body.durations };
  }
}

module.exports = { LocalOsrmProvider };
