const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { geocodeAddress } = require('./geocoding');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function okResponse(body) {
  return { ok: true, json: async () => body };
}

describe('geocodeAddress', () => {
  test('returns null without calling fetch when no address/city/zip is given', async () => {
    let called = false;
    global.fetch = async () => { called = true; return okResponse({}); };

    const result = await geocodeAddress({});

    assert.equal(result, null);
    assert.equal(called, false);
  });

  test('returns { lat, lng } from the first address match', async () => {
    global.fetch = async () => okResponse({
      result: { addressMatches: [{ coordinates: { x: -96.7026, y: 40.8136 } }] },
    });

    const result = await geocodeAddress({ address: '123 O St', city: 'Lincoln', state: 'NE', zip: '68508' });

    assert.deepEqual(result, { lat: 40.8136, lng: -96.7026 });
  });

  test('returns null when there is no address match', async () => {
    global.fetch = async () => okResponse({ result: { addressMatches: [] } });
    const result = await geocodeAddress({ address: 'nowhere' });
    assert.equal(result, null);
  });

  test('returns null on a non-ok HTTP response', async () => {
    global.fetch = async () => ({ ok: false });
    const result = await geocodeAddress({ address: '123 O St' });
    assert.equal(result, null);
  });

  test('returns null rather than throwing on a network error', async () => {
    global.fetch = async () => { throw new Error('network unreachable'); };
    const result = await geocodeAddress({ address: '123 O St' });
    assert.equal(result, null);
  });

  test('passes an abort signal through to fetch (regression test for the missing-timeout gap)', async () => {
    // geocodeAddress() is awaited directly inside request handlers
    // (routes/places.js), so a hung upstream request must not hang the
    // caller indefinitely — the actual abort-after-TIMEOUT_MS mechanism is
    // exercised fast in fetchWithTimeout.test.js; this just confirms
    // geocodeAddress wires a signal through fetchWithTimeout at all.
    let receivedSignal;
    global.fetch = async (url, options) => { receivedSignal = options.signal; return { ok: true, json: async () => ({ result: { addressMatches: [] } }) }; };

    await geocodeAddress({ address: '123 O St' });

    assert.ok(receivedSignal instanceof AbortSignal);
  });
});
