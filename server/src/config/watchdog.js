// Tunables for services/eventLoopWatchdog.js - the monitor thread that turns a
// blocked event loop into a process exit.
//
// Deployment/infrastructure config, the same category as config/backfillQueue.js's
// OSRM paths: env-var driven, deliberately NOT on the settings page. The right
// value depends on where the app runs and what restarts it, not on how a rep
// wants the app to behave.

module.exports = {
  // How often the main thread stamps the shared heartbeat. Cheap - one atomic
  // store, no allocation.
  HEARTBEAT_MS: Number(process.env.WATCHDOG_HEARTBEAT_MS) || 1000,

  // How often the monitor thread reads that stamp.
  CHECK_INTERVAL_MS: Number(process.env.WATCHDOG_CHECK_INTERVAL_MS) || 2000,

  // How stale the heartbeat must get before the monitor kills the process.
  // Deliberately far longer than any legitimate synchronous pause this app
  // can have: the largest route solve tsp.js can be asked for (30 stops,
  // bounded by MAX_LOCAL_SEARCH_PASSES) measures ~50ms, and nothing else on
  // the request path blocks at all. 30s is three orders of magnitude of
  // headroom, so a trip here means something is genuinely wedged.
  STALL_MS: Number(process.env.WATCHDOG_STALL_MS) || 30000,

  // How much later than CHECK_INTERVAL_MS the monitor's own tick may arrive
  // before we read it as "this whole process was frozen" rather than "the main
  // thread is wedged" - see wasSuspended() in services/eventLoopWatchdog.js.
  // Ordinary timer jitter is milliseconds; a suspend is seconds to hours. 5s
  // sits far above the former and far below the latter.
  SUSPEND_SLACK_MS: Number(process.env.WATCHDOG_SUSPEND_SLACK_MS) || 5000,

  // Escape hatch: WATCHDOG_DISABLED=1 turns the monitor off entirely.
  DISABLED: process.env.WATCHDOG_DISABLED === '1',
};
