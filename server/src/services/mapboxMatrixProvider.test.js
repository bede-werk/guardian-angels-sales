const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { MapboxMatrixProvider } = require('./mapboxMatrixProvider');

// A fetchFn that records every URL it's called with and answers from a
// coordinate-indexed distance function, mimicking the Matrix API's
// row-major {distances, durations} shape. `unroutable` is a set of
// "lng,lat->lng,lat" keys that come back null.
function fakeFetch({ unroutable = new Set(), fail = null } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (fail) return fail;

    const u = new URL(url);
    const coordPart = decodeURIComponent(u.pathname.split('/').pop());
    const coords = coordPart.split(';'); // "lng,lat"
    const srcIdx = u.searchParams.get('sources').split(';').map(Number);
    const dstIdx = u.searchParams.get('destinations').split(';').map(Number);

    const val = (base, i, j) => {
      const key = `${coords[i]}->${coords[j]}`;
      if (unroutable.has(key)) return null;
      const [alng, alat] = coords[i].split(',').map(Number);
      const [blng, blat] = coords[j].split(',').map(Number);
      return base + Math.round(Math.abs(alat - blat) * 1000 + Math.abs(alng - blng) * 1000);
    };
    return {
      ok: true,
      json: async () => ({
        code: 'Ok',
        distances: srcIdx.map((i) => dstIdx.map((j) => val(1000, i, j))),
        durations: srcIdx.map((i) => dstIdx.map((j) => val(100, i, j))),
      }),
    };
  };
  return { fetchFn, calls };
}

function coords(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ lat: 40 + (i + offset) * 0.01, lng: -96 - (i + offset) * 0.01 }));
}

describe('MapboxMatrixProvider', () => {
  test('start() throws a clear error when no token is configured', async () => {
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: null });
    await assert.rejects(() => p.start(), /MAPBOX_TOKEN is not configured/);
  });

  test('start() resolves with a token; stop() is a no-op', async () => {
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test' });
    await p.start();
    await p.stop();
  });

  test('source is "mapbox" so place_distance rows are labelled honestly', () => {
    assert.equal(new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test' }).source, 'mapbox');
  });

  test('a small block is one request with the right sources/destinations params', async () => {
    const { fetchFn, calls } = fakeFetch();
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });

    const srcs = coords(2);
    const dsts = coords(3, 10);
    const { distances, durations } = await p.table(srcs, dsts);

    assert.equal(calls.length, 1);
    const u = new URL(calls[0]);
    assert.match(u.pathname, /\/mapbox\/driving\//);
    assert.equal(u.searchParams.get('annotations'), 'distance,duration');
    assert.equal(u.searchParams.get('sources'), '0;1');
    assert.equal(u.searchParams.get('destinations'), '2;3;4');
    assert.equal(u.searchParams.get('access_token'), 'pk.test');

    assert.equal(distances.length, 2);
    assert.equal(distances[0].length, 3);
    assert.ok(distances[1][2] > 0);
    assert.ok(durations[1][2] > 0);
  });

  test('one source vs 30 destinations sub-chunks under the 25-coord cap and stitches back', async () => {
    const { fetchFn, calls } = fakeFetch();
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });

    const srcs = coords(1);
    const dsts = coords(30, 5);
    const { distances, durations } = await p.table(srcs, dsts);

    // 1 source leaves 24 destination slots per request -> ceil(30/24) = 2.
    assert.equal(calls.length, 2);
    for (const c of calls) {
      const u = new URL(c);
      const total = decodeURIComponent(u.pathname.split('/').pop()).split(';').length;
      assert.ok(total <= 25, `request had ${total} coords`);
    }

    assert.equal(distances[0].length, 30);
    assert.equal(durations[0].length, 30);
    // Every cell filled from a real answer (this fake never returns null).
    assert.ok(distances[0].every((v) => typeof v === 'number'));
    // Spot-check that stitching kept destination order: cell j uses dsts[j].
    const direct = await p.table(srcs, [dsts[29]]);
    assert.equal(distances[0][29], direct.distances[0][0]);
  });

  test('many sources and many destinations stays within the cap on every request', async () => {
    const { fetchFn, calls } = fakeFetch();
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });

    const { distances } = await p.table(coords(20), coords(20, 40));
    assert.equal(distances.length, 20);
    assert.equal(distances[0].length, 20);
    for (const c of calls) {
      const u = new URL(c);
      const total = decodeURIComponent(u.pathname.split('/').pop()).split(';').length;
      assert.ok(total <= 25, `request had ${total} coords`);
    }
  });

  test('an unroutable pair comes back as null, not a fabricated number', async () => {
    const srcs = coords(1);
    const dsts = coords(2, 3);
    const key = `${srcs[0].lng},${srcs[0].lat}->${dsts[1].lng},${dsts[1].lat}`;
    const { fetchFn } = fakeFetch({ unroutable: new Set([key]) });
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });

    const { distances, durations } = await p.table(srcs, dsts);
    assert.equal(distances[0][1], null);
    assert.equal(durations[0][1], null);
    assert.ok(distances[0][0] > 0);
  });

  test('a non-OK HTTP response throws with the status', async () => {
    const { fetchFn } = fakeFetch({ fail: { ok: false, status: 422, json: async () => ({ message: 'no segment found' }) } });
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });
    await assert.rejects(() => p.table(coords(1), coords(2, 3)), /Mapbox Matrix 422/);
  });

  test('a Matrix API error code throws', async () => {
    const { fetchFn } = fakeFetch({ fail: { ok: true, json: async () => ({ code: 'ProfileNotFound' }) } });
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn, MAPBOX_REQUEST_SPACING_MS: 0 });
    await assert.rejects(() => p.table(coords(1), coords(2, 3)), /ProfileNotFound/);
  });

  test('empty inputs return empty matrices without a request', async () => {
    const { fetchFn, calls } = fakeFetch();
    const p = new MapboxMatrixProvider({ MAPBOX_TOKEN: 'pk.test', fetchFn });
    const { distances, durations } = await p.table([], coords(3));
    assert.deepEqual(distances, []);
    assert.deepEqual(durations, []);
    assert.equal(calls.length, 0);
  });
});
