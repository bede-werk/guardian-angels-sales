// places.do_not_visit / do_not_visit_until - the one predicate, and the one
// finding shape, every write path shares.
//
// The flag is a rep's deliberate "stop going here" mark on a PLACE, set from
// PlaceDetail.jsx's Upcoming Visits card (presets, a custom date, or
// "Indefinitely") and from CapacityDetail.jsx's zero-capacity suggestion.
// It is NOT a conflictDetection.js finding and must not become one: that
// module answers "does a visit here on THIS DATE collide with something",
// where its `today` means the date under evaluation. This flag is a live
// property of the place itself, always compared against real org-today, and
// it has no other visit to point at.
//
// Lives in its own module rather than in schedulingEngine.js (where the
// canonical precedence rule sits) so the four consumers - the ranker, the
// manual-plan policy layer, the "Log a visit" route, and the route planner's
// draft views - can share it without any of them taking a dependency on the
// ranker. No requires of its own, so it can never be half of a cycle.

// do_not_visit_until mirrors snooze_until's own "never cleared, just live-
// compared" convention: null/unset means indefinite once do_not_visit is
// true, a date means the mark lapses on its own once today passes it. The
// boundary is inclusive - a mark that runs "until the 24th" still excludes
// on the 24th.
function isDoNotVisitActive(place, today) {
  if (!place || !place.do_not_visit) return false;
  return !place.do_not_visit_until || place.do_not_visit_until >= today;
}

// The finding, in the same { type, severity, placeId } vocabulary
// conflictDetection.js's Conflict uses - so a caller can push it onto a
// Conflict[] it is already returning and every client that renders one
// renders this too, without a second parallel array. Deliberately carries
// no otherDate/daysApart/otherUserName: there is no other visit and no other
// rep involved, only the place's own flag.
function doNotVisitFinding(place, today) {
  if (!isDoNotVisitActive(place, today)) return null;
  return { type: 'DO_NOT_VISIT', severity: 'soft', placeId: place.id ?? null };
}

module.exports = { isDoNotVisitActive, doNotVisitFinding };
