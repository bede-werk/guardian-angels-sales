const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { isStalled, wasSuspended } = require('./eventLoopWatchdog');

const WATCHDOG = path.join(__dirname, 'eventLoopWatchdog.js');

// Runs `body` in a fresh child process with the watchdog armed on a short
// fuse, and resolves with how that child ended. A child process is the only
// honest way to test this: the failure it guards against is a blocked event
// loop, and a test that blocked THIS process could never report anything.
function runChild(body, env = {}, onStart = null) {
  return new Promise((resolve) => {
    const src = `const { startWatchdog } = require(${JSON.stringify(WATCHDOG)}); startWatchdog(); ${body}`;
    const child = spawn(process.execPath, ['-e', src], {
      env: {
        ...process.env,
        WATCHDOG_HEARTBEAT_MS: '100',
        WATCHDOG_CHECK_INTERVAL_MS: '200',
        WATCHDOG_STALL_MS: '1000',
        // Scaled down with the rest of the fuses: at the 5s production default
        // no freeze a test is willing to sit through would register as one.
        WATCHDOG_SUSPEND_SLACK_MS: '400',
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const startedAt = Date.now();
    child.on('exit', (code, signal) => resolve({ code, signal, stderr, elapsed: Date.now() - startedAt }));
    if (onStart) onStart(child);
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

describe('wasSuspended', () => {
  test('a tick arriving on schedule is not a suspend', () => {
    assert.equal(wasSuspended(200, 200, 400), false);
  });

  test('ordinary jitter within the slack is not a suspend', () => {
    assert.equal(wasSuspended(550, 200, 400), false);
  });

  test('exactly at the slack boundary is not yet a suspend', () => {
    assert.equal(wasSuspended(600, 200, 400), false);
  });

  test('a tick overdue past the slack is a suspend', () => {
    assert.equal(wasSuspended(5000, 200, 400), true);
  });

  test('a laptop-sleep-sized gap is a suspend', () => {
    // The 2026-08-28 case: the machine slept for hours between two ticks.
    assert.equal(wasSuspended(6 * 60 * 60 * 1000, 2000, 5000), true);
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


describe('the watchdog against a suspended process', () => {
  // The 2026-08-28 regression. A laptop that sleeps freezes BOTH threads, so
  // the main thread cannot stamp while Date.now() runs on regardless. The
  // watchdog read that as a wedge and SIGKILLed a healthy server; because
  // `node --watch` waits for a file change after a crash rather than
  // restarting, the API stayed down and every proxied /api call 500ed.
  //
  // SIGSTOP/SIGCONT is the honest reproduction: like sleep, it freezes every
  // thread in the process, monitor included.
  function freezeTrial(body, freezeMs = 1500) {
    return runChild(body, {}, async (child) => {
      await delay(500); // let the monitor boot and take a heartbeat first
      child.kill('SIGSTOP');
      await delay(freezeMs);
      child.kill('SIGCONT');
    });
  }

  // Repeated because the OLD bug was a RACE, not a certainty, and a one-shot
  // test would have quietly passed against the very code it was written to
  // catch (measured: it killed on only 7 of 20 freezes).
  //
  // At the moment of resume both threads have an overdue timer and both fire
  // at once. If the main thread's heartbeat lands first the stamp is refreshed
  // and the old code survived; if the monitor's check landed first it killed.
  // One coin flip per freeze, so the fix is what makes this deterministic -
  // pre-fix, surviving all 12 trials has probability 0.65^12, under 1%.
  //
  // Trials run in parallel: they are independent idle processes, so this costs
  // one child's lifetime rather than twelve.
  const TRIALS = 12;

  test('survives repeated freezes longer than the stall limit', { timeout: 60000 }, async () => {
    const runs = await Promise.all(
      Array.from({ length: TRIALS }, () => freezeTrial('setTimeout(() => process.exit(0), 4000);'))
    );

    const killed = runs.filter((r) => r.signal === 'SIGKILL');
    assert.equal(
      killed.length,
      0,
      `${killed.length}/${TRIALS} healthy processes killed after a freeze: ${killed[0]?.stderr ?? ''}`
    );
    assert.ok(runs.every((r) => r.code === 0));
  });

  test('still kills a process that wedges after a freeze', { timeout: 30000 }, async () => {
    // Guards the FIX rather than the bug: the grace period after a resume has
    // to expire, not disarm the watchdog. A process that comes back from sleep
    // and THEN wedges is still an outage.
    const r = await freezeTrial('setTimeout(() => { for (;;) {} }, 4000);');

    assert.equal(r.signal, 'SIGKILL', `expected SIGKILL, got signal=${r.signal} code=${r.code}`);
    assert.match(r.stderr, /event loop blocked/i);
  });
});
