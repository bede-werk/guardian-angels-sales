const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LocalOsrmProvider } = require('./localOsrmProvider');

// A fake child process: real EventEmitter (so once/removeListener work
// exactly like a real ChildProcess), kill() just schedules an 'exit'.
function fakeChild() {
  const child = new EventEmitter();
  child.kill = (signal) => {
    setImmediate(() => child.emit('exit', signal === 'SIGKILL' ? null : 0));
  };
  return child;
}

// A fetchFn that fails `failures` times (simulating "server not listening
// yet") before succeeding.
function fetchAfter(failures) {
  let calls = 0;
  return async () => {
    calls++;
    if (calls <= failures) throw new Error('connect ECONNREFUSED');
    return { ok: true, json: async () => ({ code: 'Ok', distances: [[0]], durations: [[0]] }) };
  };
}

describe('LocalOsrmProvider', () => {
  let dataPath;

  beforeEach(() => {
    dataPath = path.join(os.tmpdir(), `fake-${Date.now()}-${Math.random().toString(36).slice(2)}.osrm`);
    // OSRM_DATA_PATH is a base name, not a literal file - see start()'s own
    // comment. Only the .properties sidecar needs to exist for the check.
    fs.writeFileSync(`${dataPath}.properties`, '');
  });

  afterEach(() => {
    fs.rmSync(`${dataPath}.properties`, { force: true });
  });

  test('start() rejects when OSRM_DATA_PATH is not configured', async () => {
    const provider = new LocalOsrmProvider({ OSRM_DATA_PATH: null });
    await assert.rejects(() => provider.start(), /OSRM_DATA_PATH is not configured/);
  });

  test('start() rejects when the data file does not exist', async () => {
    const provider = new LocalOsrmProvider({ OSRM_DATA_PATH: '/nonexistent/path.osrm' });
    await assert.rejects(() => provider.start(), /not found/);
  });

  test('start() spawns with the configured port and max-table-size, and resolves once the port answers', async () => {
    let spawnArgs = null;
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      OSRM_PORT: 6001,
      OSRM_MAX_TABLE_SIZE: 1234,
      spawnFn: (bin, args) => { spawnArgs = { bin, args }; return fakeChild(); },
      fetchFn: fetchAfter(0),
    });

    await provider.start();

    assert.equal(spawnArgs.bin, 'osrm-routed');
    assert.deepEqual(spawnArgs.args, ['--algorithm', 'mld', '--port', '6001', '--max-table-size', '1234', dataPath]);
  });

  test('start() polls until ready rather than failing on the first connection refusal', async () => {
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      spawnFn: () => fakeChild(),
      fetchFn: fetchAfter(3),
    });
    await provider.start(); // must not throw despite 3 initial failures
  });

  test('start() is idempotent - a second call does not spawn again', async () => {
    let spawnCount = 0;
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      spawnFn: () => { spawnCount++; return fakeChild(); },
      fetchFn: fetchAfter(0),
    });
    await provider.start();
    await provider.start();
    assert.equal(spawnCount, 1);
  });

  test('start() rejects promptly if the process exits before becoming ready', async () => {
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      spawnFn: () => {
        const child = fakeChild();
        setImmediate(() => child.emit('exit', 1));
        return child;
      },
      // Would eventually "succeed", but the early exit must win the race.
      fetchFn: fetchAfter(1000),
    });
    await assert.rejects(() => provider.start(), /exited early/);
  });

  test('start() rejects after the startup timeout if the port never answers', async () => {
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      OSRM_STARTUP_TIMEOUT_MS: 50,
      spawnFn: () => fakeChild(),
      fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    await assert.rejects(() => provider.start(), /did not become ready/);
  });

  test('table() throws if called before start()', async () => {
    const provider = new LocalOsrmProvider({ OSRM_DATA_PATH: dataPath });
    await assert.rejects(() => provider.table([{ lat: 1, lng: 1 }], [{ lat: 2, lng: 2 }]), /before start\(\)/);
  });

  test('table() builds the request from sources/destinations and returns the parsed matrices', async () => {
    let requestedUrl = null;
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      OSRM_PORT: 6002,
      spawnFn: () => fakeChild(),
      fetchFn: async (url) => {
        if (url.includes('/table/v1/driving/0,0')) return { ok: true, json: async () => ({ code: 'Ok' }) }; // readiness probe
        requestedUrl = url;
        return { ok: true, json: async () => ({ code: 'Ok', distances: [[1000, 2000]], durations: [[100, 200]] }) };
      },
    });
    await provider.start();

    const sources = [{ lat: 40.8, lng: -96.7 }];
    const destinations = [{ lat: 40.81, lng: -96.71 }, { lat: 40.82, lng: -96.72 }];
    const result = await provider.table(sources, destinations);

    assert.deepEqual(result, { distances: [[1000, 2000]], durations: [[100, 200]] });
    assert.ok(requestedUrl.startsWith('http://127.0.0.1:6002/table/v1/driving/'));
    assert.match(requestedUrl, /sources=0&destinations=1;2/);
  });

  test('table() throws on a non-Ok OSRM response', async () => {
    const provider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      spawnFn: () => fakeChild(),
      fetchFn: async (url) => {
        if (url.includes('0,0;')) return { ok: true, json: async () => ({ code: 'Ok' }) };
        return { ok: true, json: async () => ({ code: 'NoTable', message: 'too many coordinates' }) };
      },
    });
    await provider.start();
    await assert.rejects(() => provider.table([{ lat: 1, lng: 1 }], [{ lat: 2, lng: 2 }]), /NoTable/);
  });

  test('stop() kills the process and resolves; stop() before start() is a harmless no-op', async () => {
    const provider = new LocalOsrmProvider({ OSRM_DATA_PATH: dataPath });
    await provider.stop(); // never started - must not throw

    let killed = false;
    const startedProvider = new LocalOsrmProvider({
      OSRM_DATA_PATH: dataPath,
      spawnFn: () => {
        const child = fakeChild();
        const realKill = child.kill.bind(child);
        child.kill = (signal) => { killed = true; realKill(signal); };
        return child;
      },
      fetchFn: fetchAfter(0),
    });
    await startedProvider.start();
    await startedProvider.stop();
    assert.ok(killed);
  });
});
