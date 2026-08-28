const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { isStalled } = require('./eventLoopWatchdog');

const WATCHDOG = path.join(__dirname, 'eventLoopWatchdog.js');

// Runs `body` in a fresh child process with the watchdog armed on a short
// fuse, and resolves with how that child ended. A child process is the only
// honest way to test this: the failure it guards against is a blocked event
// loop, and a test that blocked THIS process could never report anything.
function runChild(body, env = {}) {
  return new Promise((resolve) => {
    const src = `const { startWatchdog } = require(${JSON.stringify(WATCHDOG)}); startWatchdog(); ${body}`;
    const child = spawn(process.execPath, ['-e', src], {
      env: {
        ...process.env,
        WATCHDOG_HEARTBEAT_MS: '100',
        WATCHDOG_CHECK_INTERVAL_MS: '200',
        WATCHDOG_STALL_MS: '1000',
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const startedAt = Date.now();
    child.on('exit', (code, signal) => resolve({ code, signal, stderr, elapsed: Date.now() - startedAt }));
  });
}

describe('isStalled', () => {
  test('a heartbeat within the limit is not a stall', () => {
    assert.equal(isStalled(1_000_000, 1_000_500, 1000), false);
  });

  test('a heartbeat older than the limit is a stall', () => {
    assert.equal(isStalled(1_000_000, 1_002_000, 1000), true);
  });

  test('exactly at the limit is not yet a stall', () => {
    assert.equal(isStalled(1_000_000, 1_001_000, 1000), false);
  });

  test('an unstamped heartbeat is startup, not a stall', () => {
    assert.equal(isStalled(0, 9_999_999, 1000), false);
  });
});

describe('the watchdog against a real blocked event loop', () => {
  test('kills a process whose event loop is wedged', { timeout: 30000 }, async () => {
    // Let the monitor thread boot and take one heartbeat, then spin forever -
    // the same shape as the 2026-08-28 tsp.js hang.
    const r = await runChild('setTimeout(() => { for (;;) {} }, 300);');

    assert.equal(r.signal, 'SIGKILL', `expected SIGKILL, got signal=${r.signal} code=${r.code}`);
    assert.match(r.stderr, /event loop blocked/i);
    assert.ok(r.elapsed < 20000, `took ${r.elapsed}ms to notice`);
  });

  test('leaves a healthy process alone well past the stall limit', { timeout: 30000 }, async () => {
    // Stays responsive for 4x the 1s stall limit, then exits cleanly on its
    // own. A watchdog that trips here would restart the server under load.
    const r = await runChild('setTimeout(() => process.exit(0), 4000);');

    assert.equal(r.signal, null, `healthy process was signalled: ${r.signal}`);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
  });

  test('WATCHDOG_DISABLED=1 leaves a wedged process running', { timeout: 30000 }, async () => {
    // The escape hatch has to actually disable it, or there's no way to turn
    // the safety net off if it ever misfires in production.
    const r = await runChild('setTimeout(() => { const end = Date.now() + 3000; while (Date.now() < end) {} process.exit(7); }, 300);', {
      WATCHDOG_DISABLED: '1',
    });

    assert.equal(r.signal, null, 'disabled watchdog still killed the process');
    assert.equal(r.code, 7);
  });
});
