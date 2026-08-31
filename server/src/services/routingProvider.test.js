const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoutingProvider } = require('./routingProvider');
const { LocalOsrmProvider } = require('./localOsrmProvider');
const { MapboxMatrixProvider } = require('./mapboxMatrixProvider');

describe('createRoutingProvider', () => {
  let dataBase;

  beforeEach(() => {
    dataBase = path.join(os.tmpdir(), `rp-${Date.now()}-${Math.random().toString(36).slice(2)}.osrm`);
  });

  afterEach(() => {
    try { fs.unlinkSync(`${dataBase}.properties`); } catch { /* not created */ }
  });

  test('a real local OSRM dataset wins even when a Mapbox token is also set', () => {
    fs.writeFileSync(`${dataBase}.properties`, '');
    const p = createRoutingProvider({ OSRM_DATA_PATH: dataBase, MAPBOX_TOKEN: 'pk.test' });
    assert.ok(p instanceof LocalOsrmProvider);
  });

  test('no local dataset + a Mapbox token -> the Mapbox provider', () => {
    const p = createRoutingProvider({ OSRM_DATA_PATH: dataBase, MAPBOX_TOKEN: 'pk.test' });
    assert.ok(p instanceof MapboxMatrixProvider);
  });

  test('OSRM_DATA_PATH unset + a Mapbox token -> the Mapbox provider', () => {
    const p = createRoutingProvider({ OSRM_DATA_PATH: null, MAPBOX_TOKEN: 'pk.test' });
    assert.ok(p instanceof MapboxMatrixProvider);
  });

  test('neither configured -> LocalOsrmProvider (its start() throws the existing setup error)', async () => {
    const p = createRoutingProvider({ OSRM_DATA_PATH: null, MAPBOX_TOKEN: null });
    assert.ok(p instanceof LocalOsrmProvider);
    await assert.rejects(() => p.start(), /OSRM_DATA_PATH is not configured/);
  });
});
