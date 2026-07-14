// Shared wrapper around fetch + AbortController so every external HTTP call
// in this codebase times out the same way, instead of each caller hand-
// rolling its own controller/setTimeout (routeOptimizer.js and geocoding.js
// both call third-party APIs with no SLA and must never hang a request
// waiting on one). Throws on abort/network error same as a bare fetch —
// this only unifies the timeout mechanics, not error handling, since
// callers already have their own fallback behavior on failure.
async function fetchWithTimeout(url, { timeoutMs, ...fetchOptions } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchWithTimeout };
