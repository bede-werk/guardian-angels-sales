// Null-safe ascending date compare, shared by routes/people.js and
// routes/places.js's directory sort options - a null date (never visited/
// contacted/referred) sorts as "oldest possible" (first in ascending order,
// last once a caller flips it for descending) rather than being pushed to
// one arbitrary end regardless of direction: whichever direction you're
// sorting by, "never happened" is the most-overdue case, so it belongs at
// the "oldest" end either way.
function compareDatesAsc(a, b) {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : 1;
}

module.exports = { compareDatesAsc };
