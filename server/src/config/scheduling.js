// Tunables for the route-planning scoring engine (services/schedulingEngine.js).
// Plain module, not a DB table — matches this codebase's existing convention
// for tunables (see scheduler.js's DEFAULT_VISIT_MINUTES etc). NEGLECT_MULTIPLIER
// and CADENCE_DAYS are the two values most likely to want live editing later;
// keeping them as named constants here means a future settings-table phase can
// lift them out without touching the engine itself.

module.exports = {
  // Target days between visits, by capacity level x relationship level.
  // Deliberately inverted: high-capacity + weak-relationship is visited MOST
  // often (biggest gap between potential and reality = biggest opportunity).
  CADENCE_DAYS: {
    high: { strong: 14, medium: 10, weak: 7 },
    medium: { strong: 30, medium: 21, weak: 21 },
    low: { strong: 90, medium: 60, weak: 90 },
  },

  // Never propose a place visited within this many days, regardless of score.
  HARD_FLOOR_DAYS: 5,

  // Fatigue guard: if a place has this many-or-more completed visits within
  // the trailing FATIGUE_WINDOW_DAYS, its effective cadence is stretched by
  // FATIGUE_MULTIPLIER until the count drops.
  FATIGUE_WINDOW_DAYS: 30,
  FATIGUE_THRESHOLD: 4,
  FATIGUE_MULTIPLIER: 1.5,

  // A verified/adjusted place jumps into the priority (rescue) tier once it's
  // this many times past its own (possibly fatigue-stretched) cadence — real
  // measured neglect overriding an exploration guess. Rescue is urgency-based
  // only, never capacity-based (see schedulingEngine.js's rankKey).
  NEGLECT_MULTIPLIER: 2,
};
