// Tunables for the computed relationship model (services/relationship.js).
//
// These used to be module-level consts inside relationship.js itself. They
// were lifted out here for the same reason config/scheduling.js exists: the
// settings page (services/settings.js + config/tunables.js) can only make a
// number live-editable if it lives in a config module whose object can be
// mutated in place. relationship.js reads every one of these at CALL time,
// never destructures them at require time, so a saved override takes effect
// on the next computation with no restart.
//
// See services/relationship.js's own header for the two design rules behind
// this model (relationship is measured per-PERSON and rolled up; relationship
// must never be driven by referral VOLUME - that's the capacity axis).
module.exports = {
  // WHO the rep actually spoke to. Only 'named_person' builds a person's
  // score; the rest accrue to the place as a direct "floor" contribution (see
  // relationship.js's rollUpPlace), so a place serviced diligently without
  // ever meeting anyone reads as "present but shallow" - which is accurate.
  // A visit whose met_with_type is null/unrecognized is scored as `nobody`
  // rather than thrown away or trusted.
  MET_WITH_WEIGHT: {
    named_person: 1.0,
    staff: 0.35,
    receptionist: 0.15,
    nobody: 0.05,
  },

  // WHAT actually happened. Deliberately observable rather than evaluative, so
  // these describe events rather than the rep's feelings about them and don't
  // inflate over time. An unrecognized outcome (which today means every
  // pre-existing visit, since the historical enum shares no values with this
  // one) falls back to `declined`, the lowest real weight - old visits
  // contribute something without being able to inflate a score.
  OUTCOME_WEIGHT: {
    substantive: 1.0, // real conversation with a decision-maker or influencer
    introduced_new: 1.0, // introduced to someone new at the org
    brief: 0.6, // short exchange, pleasant but not substantive
    materials_only: 0.25, // left materials, no meaningful contact
    unavailable: 0.15, // target unavailable / gatekept
    declined: 0.1, // explicitly not interested right now
  },

  // A visit at or above this RAW (pre-decay) weight counts as "meaningful"
  // for last_meaningful_visit. Deliberately raw, not decayed: a genuinely
  // substantive visit eight months ago was still substantive at the time, and
  // this field exists to explain a score, not to re-litigate it.
  MEANINGFUL_WEIGHT: 0.6,

  // Half-life is a property of the place's CATEGORY: a hospital relationship
  // goes cold faster than a funeral home's. These must be EXACT category
  // names as they appear in the `categories` table - a near-miss silently
  // falls through to HALF_LIFE_DEFAULT with no error, which is why the
  // settings page renders this as a picker over real categories rather than
  // a free-text box.
  FAST_DECAY_CATEGORIES: [
    'Assisted Living & Senior Living',
    'Community Partners',
    'Hospice',
    'Hospitals',
    'Physical Therapy',
    'Physicians',
    'Rehabilitation Centers',
    'Legal & Trust',
  ],

  HALF_LIFE_FAST: 30, // days, for the categories listed above
  HALF_LIFE_DEFAULT: 60, // days, everything else including any category added later

  // Reciprocity: signals that THEY invested in the relationship, not just
  // that the rep showed up. Without this the score is a mirror of the rep's
  // own behavior and "strong relationship" reduces to "we visit here a lot,"
  // which is circular.
  DETAIL_BONUS: 0.0625, // x4 known personal details -> max 1.25
  REFERRED_MULTIPLIER: 1.15, // has ever referred (BINARY - never a count, see relationship.js's header)
  REQUESTED_MULTIPLIER: 1.1, // they asked us for something recently
  MAX_RECIPROCITY: 1.6, // hard cap (natural max is 1.25 * 1.15 * 1.1 = 1.58125)

  // Score -> level buckets. Category-INDEPENDENT by design: the steady-state
  // score for a constant visit cadence c under half-life H is
  // 1 / (1 - 0.5^(c/H)), which depends only on the ratio c/H, so a
  // 30-day-category place visited every 15 days and a 60-day-category place
  // visited every 30 days both score 3.41. One scale, two clocks.
  //
  //   visited 2x as often as half-life -> 3.41  (strong)
  //   visited exactly at half-life     -> 2.00  (medium)
  //   visited half as often            -> 1.33  (weak boundary)
  //
  // medium's floor is 1.4, not the 1.33 convergence value itself: Bede
  // decided (2026-08-10) that "visited half as often as the half-life" should
  // read weak, so the threshold sits just above that boundary.
  RELATIONSHIP_THRESHOLDS: { strong: 3.4, medium: 1.4 },

  // Trend (heating up / cooling down) - purely a display signal, never fed
  // back into score/level. TWO INDEPENDENT mechanisms, not one; see
  // relationship.js's trend section for why a decay ratio structurally cannot
  // express long neglect and so cannot stand in for the cooling clock.
  TREND_RELATIVE_THRESHOLD: 0.1, // must move >=10% to read as a real HEATING UP move, not noise
  TREND_EPSILON: 0.01, // both sides at/below this = "no history at either point," not a trend
  TREND_WINDOW_FRACTION: 0.12, // heating-up lookback as a fraction of the half-life: ~4d fast, ~7d default
  COOLING_THRESHOLD: 1.25, // place is "cooling" once this many times past its target cadence
  PERSON_COOLING_HALF_LIFE_FRACTION: 0.5, // person is "cooling" this far into the half-life since their last meaningful visit

  // Place rollup: each additional contact is worth this much of the last -
  // p0 + 0.5*p1 + 0.25*p2 + ... The strongest relationship sets the floor;
  // breadth still counts but with sharply diminishing returns.
  CONTRIBUTOR_DECAY: 0.5,
};
