const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { fetchWithTimeout } = require('./fetchWithTimeout');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe('fetchWithTimeout', () => {
  test('resolves with the response when fetch succeeds within the timeout', async () => {
    const fakeResponse = { ok: true };
    global.fetch = async () => fakeResponse;

    const result = await fetchWithTimeout('https://example.test', { timeoutMs: 1000 });

    assert.equal(result, fakeResponse);
  });

  test('passes a signal through to fetch alongside any other fetch options', async () => {
    let received;
    global.fetch = async (url, options) => { received = options; return { ok: true }; };

    await fetchWithTimeout('https://example.test', { timeoutMs: 1000, method: 'POST' });

    assert.equal(received.method, 'POST');
    assert.ok(received.signal instanceof AbortSignal);
  });

  test('aborts and rejects once TIMEOUT_MS elapses without fetch resolving', async () => {
    global.fetch = (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });

    await assert.rejects(() => fetchWithTimeout('https://example.test', { timeoutMs: 10 }));
  });

  test('propagates a rejection from fetch itself (e.g. a network error) without swallowing it', async () => {
    global.fetch = async () => { throw new Error('network unreachable'); };

    await assert.rejects(
      () => fetchWithTimeout('https://example.test', { timeoutMs: 1000 }),
      /network unreachable/
    );
  });
});
