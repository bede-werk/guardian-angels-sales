// Turns a blocked event loop into a process exit.
//
// WHY THIS EXISTS. On 2026-08-28 a bug in tsp.js's 2-opt search spun forever
// on the request path. The process stayed "alive" - listening, 100% CPU, every
// request hanging including /api/health - for 19 hours before anyone noticed.
// Nothing caught it, and nothing was going to:
//
//   - Railway's restart policies (ON_FAILURE / ALWAYS) both need the process to
//     STOP. A wedged process never does.
//   - Railway's healthcheck runs only at deploy time. Their docs: "Railway does
//     not monitor the healthcheck endpoint after the deployment has gone live."
//   - Every in-process timeout (server.requestTimeout, res.setTimeout,
//     Promise.race against a timer) needs the event loop to run a timer - the
//     one thing a blocked event loop cannot do.
//
// So the check has to live off-thread. The main thread stamps a shared
// heartbeat; a monitor thread (eventLoopWatchdog.worker.js) watches the stamp
// go stale and kills the process. That converts an invisible hang into a crash
// with a log line, which supervisors DO act on.
//
// This is a backstop, not a fix. The real fix for that outage was bounding the
// solver (see tsp.js's MAX_LOCAL_SEARCH_PASSES). This is what catches the bug
// nobody has thought of yet.
const path = require('path');
const { Worker } = require('worker_threads');
const defaultConfig = require('../config/watchdog');

// Pure decision the monitor thread makes, exported so it can be tested without
// spawning anything or killing anybody. A zero/absent stamp means "the main
// thread hasn't checked in yet", which is startup, not a stall.
function isStalled(lastBeatMs, nowMs, stallMs) {
  if (!lastBeatMs) return false;
  return nowMs - lastBeatMs > stallMs;
}

/**
 * Starts the heartbeat and its monitor thread.
 *
 * @param {object} [config]  defaults to config/watchdog.js
 * @returns {{stop: Function}|null}  null when disabled; otherwise a handle
 *   whose stop() clears the heartbeat and terminates the monitor.
 */
function startWatchdog(config = defaultConfig) {
  if (config.DISABLED) return null;

  // BigInt64Array so the millisecond stamp can't overflow, and Atomics so the
  // read on the monitor thread can't tear against the write on this one.
  const heartbeat = new SharedArrayBuffer(8);
  const view = new BigInt64Array(heartbeat);
  Atomics.store(view, 0, BigInt(Date.now()));

  const beat = setInterval(() => {
    Atomics.store(view, 0, BigInt(Date.now()));
  }, config.HEARTBEAT_MS);
  beat.unref(); // never keep the process alive just to say it's alive

  const worker = new Worker(path.join(__dirname, 'eventLoopWatchdog.worker.js'), {
    workerData: {
      heartbeat,
      checkIntervalMs: config.CHECK_INTERVAL_MS,
      stallMs: config.STALL_MS,
    },
  });
  worker.unref(); // same reasoning as startBackfillWorker's unref in index.js

  // A watchdog that fails to start must never be the reason the app won't run -
  // it's a safety net, and a missing safety net is strictly better than a
  // server that won't boot.
  worker.on('error', (err) => {
    console.error('Event-loop watchdog failed (server still running):', err.message);
  });

  return {
    stop: () => {
      clearInterval(beat);
      return worker.terminate();
    },
  };
}

module.exports = { startWatchdog, isStalled };
