// The organization's "today" as a plain 'YYYY-MM-DD' string.
//
// Extracted out of scheduleDraft.js (where it lived as a private helper) once
// services/relationship.js needed the same notion of today for its decay
// clock — same precedent as fetchWithTimeout.js being lifted out of
// routeOptimizer.js when geocoding.js turned out to need it too. A real
// second consumer, not speculative reuse. Keeping one definition matters more
// than usual here: two copies of this that drifted apart would put the route
// planner and the relationship decay clock on different days.
//
// Guardian Angels operates out of one office (Lincoln, NE — America/Chicago),
// so "today" is computed in that fixed zone rather than raw UTC. Using UTC
// directly caused a real bug: for several hours every evening (once UTC has
// already rolled to the next calendar day, any time after ~7pm Central), the
// server's idea of "today" was a day ahead of every rep's browser (which
// computes "today" in ITS local timezone — see RoutePlanner.jsx's todayISO()) —
// spuriously rejecting an evening plan-for-today request as "in the past."
// A fixed IANA zone (not a client-supplied one) keeps this server-
// authoritative rather than trusting client input for something logic-
// relevant. formatToParts (not a locale's default format string) guarantees
// exact YYYY-MM-DD regardless of ICU/locale quirks.
function orgToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = { orgToday };
