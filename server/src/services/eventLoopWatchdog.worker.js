// Monitor thread for services/eventLoopWatchdog.js.
//
// Runs on its own thread, which is the entire point: a blocked main thread
// can't run its own timers, so every in-process guard that relies on one
// (server.requestTimeout, res.setTimeout, Promise.race against a timer,
// setInterval on the main thread) is silently useless against exactly the
// failure this is here to catch. This timer keeps ticking regardless.
const fs = require('fs');
const { workerData } = require('worker_threads');

const { heartbeat, checkIntervalMs, stallMs } = workerData;
const view = new BigInt64Array(heartbeat);

setInterval(() => {
  const last = Number(Atomics.load(view, 0));
  if (!last) return; // not stamped yet

  const stale = Date.now() - last;
  if (stale <= stallMs) return;

  // SIGKILL rather than process.exit(): process.exit() in a worker only ends
  // the WORKER, leaving the wedged main thread exactly as it was. A signal to
  // our own pid takes the whole process down, and SIGKILL specifically can't
  // be swallowed by a handler the blocked main thread could never run anyway.
  // The non-zero exit is also what makes Railway's ON_FAILURE restart policy
  // fire - that policy needs the process to actually stop, which is why a
  // wedge used to be invisible to it.
  // fs.writeSync straight to fd 2, NOT console.error: a worker's console
  // output is forwarded to the parent thread for writing, and the parent
  // thread is precisely what's blocked here - so console.error produces
  // nothing at all, and the process would die with no explanation. A direct
  // synchronous fd write doesn't involve the main thread and lands before
  // the SIGKILL below.
  fs.writeSync(
    2,
    `FATAL: event loop blocked for ${Math.round(stale / 1000)}s ` +
      `(watchdog limit ${Math.round(stallMs / 1000)}s). Killing the process so the supervisor can restart it.\n`
  );
  process.kill(process.pid, 'SIGKILL');
}, checkIntervalMs);
// Deliberately NOT unref'd. This interval is the only thing on this thread's
// event loop, so unref'ing it would let the worker exit immediately and
// monitor nothing. The parent unrefs the Worker HANDLE instead, which is what
// keeps the watchdog from holding the process open on its own.
