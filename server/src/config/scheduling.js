// Tunables for the route-planning scoring engine (services/schedulingEngine.js).
// Plain module, not a DB table - matches this codebase's existing convention
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
  // this many times past its own (possibly fatigue-stretched) cadence - real
  // measured neglect overriding an exploration guess. Rescue is urgency-based
  // only, never capacity-based (see schedulingEngine.js's rankKey).
  NEGLECT_MULTIPLIER: 2,

  // Tunables for services/capacity.js (capacity-computation-spec.md). Single
  // scale across every category - see the spec's §4 for why per-category
  // thresholds were rejected.
  // Retuned 2026-08-23 (was 6/16). Bede's call, against his own market: at a
  // 16/month bar essentially nothing in this book ever reaches high, so the
  // top row of CADENCE_DAYS would never apply to anything. Only places
  // carrying a real NUMBER re-bucket when these move (2 of 263 at the time of
  // the change) - CATEGORY_CAPACITY_SEED below assigns levels directly, so
  // the ~99% of places still on the category guess are untouched by a
  // threshold change. These bite later, as pre-qualification actually
  // happens, which is why they were worth getting right before that data
  // exists rather than after.
  CAPACITY_THRESHOLDS: {
    MEDIUM_MIN: 4, // 0-3 => low
    HIGH_MIN: 11, // 4-10 => medium, 11+ => high
  },

  // The four choices the place capacity rating screen offers, in
  // referrals/month - the human seed that stands in for a real pre-qual
  // answer until one exists (see services/capacity.js's resolution ladder and
  // migration 20260823000000, which backfilled these from the old
  // tier/is_priority pair).
  //
  // Same unit as capacity_observations.monthly_referrals on purpose: a seed
  // is a guess at exactly the quantity a pre-qual answer measures, which is
  // what makes it legitimate to substitute one for the other.
  //
  // Every value deliberately sits at least 2 away from a CAPACITY_THRESHOLDS
  // boundary. Both thresholds are independently editable from the Settings
  // page with no cross-validation against these numbers, so a value sitting
  // ON a boundary would let a one-digit threshold tweak silently re-level a
  // whole tier of the book. The rating screen shows which bucket each choice
  // currently lands in, computed live from the thresholds, so the coupling
  // stays visible rather than silent.
  //
  // `major` and `strong` both resolve to high at the shipped thresholds, and
  // that is intended: capacity has three levels, so any four-choice scale
  // collapses somewhere, and the gap between "great account" and "best
  // account" matters less for cadence than the gap between "occasional" and
  // "steady." The distinction survives as places.priority_score, which is the
  // EXPLORATION tier's tie-break within a capacity level.
  CAPACITY_SEED_VALUES: {
    major: 15,
    strong: 13,
    steady: 7,
    occasional: 1,
  },

  // How many all-star places the book is meant to hold (see migration
  // 20260824000000 and schedulingEngine.js's bumpCapacityLevel). An all-star
  // is one of the handful of places that matter most. It exists because
  // capacity is a pure count and cannot see the low-volume, high-value source
  // - but it is not restricted to those: an already-high-capacity all-star is
  // a normal, expected case where the bump simply has nothing left to give.
  //
  // This is a SOFT target, deliberately (Bede's call). Nothing refuses to
  // set the 26th; the UI shows the live count against this number and warns
  // past it. The number is the point, not the enforcement: a flag with no
  // sense of scarcity drifts until it means nothing, which is exactly how the
  // ⭐ Priority flag this replaced died. 25 comes from Bede's own read on
  // homecare - you need ~20 genuine all-star sources and the rest are
  // ordinary.
  ALL_STAR_TARGET: 25,

  // Our own referral throughput only counts as a measured floor once there's
  // enough of it to not be noise - small counts over a short window are
  // exactly the kind of "3 referrals in a week" fluke that shouldn't ratchet
  // a place's capacity number up permanently (see spec §6.2 - the floor only
  // ever raises, never lowers, so a loose gate's failure mode is
  // over-stating capacity, not under-stating it).
  MEASURED_MIN_EXPOSURE_DAYS: 180,
  MEASURED_MIN_REFERRAL_COUNT: 3,

  // A declared observation (pre-qual answer or manual override) older than
  // this many days is 'stale', not 'fresh' - see spec §6.6. An override does
  // NOT reset this clock; it only says "don't trust the stale number in the
  // meantime," it doesn't make the number current again.
  CAPACITY_STALE_DAYS: 365,

  // Starting guess for a place that's never been pre-qualified and has no
  // measured referral floor yet - spec §6.5. Ordered first-match-wins,
  // case-insensitive substring match against places.category. This is a
  // FRESH copy of the same keyword table the 20260712000000 migration
  // seeded places.capacity_level from (not imported from that migration -
  // migrations in this codebase are frozen historical snapshots, not living
  // config; see that migration's own header). Keep the two in sync only if
  // there's a reason to - the migration's copy did its one-time job already
  // and this one is what actually governs new/never-pre-qualified places
  // going forward. Tuned against the real category values in this dataset,
  // not just the spec's illustrative examples (which used category names -
  // 'SNF/Rehab', 'ALF', 'Legal and Trust' - that don't match this app's
  // actual, messier category strings).
  CATEGORY_CAPACITY_SEED: [
    [/hospital/i, 'high'],
    [/rehab/i, 'high'],
    [/physical therapy/i, 'high'],
    [/senior living|assisted living|independent living|memory care/i, 'high'],
    [/senior advisor/i, 'high'],
    [/case manager/i, 'high'],
    [/hospice/i, 'medium'],
    [/physician|concierge doc|medical/i, 'medium'],
    [/pharmac/i, 'medium'],
    [/community partner/i, 'medium'],
    [/elder law|legal|attorney|trust/i, 'low'],
    [/church/i, 'low'],
    [/fire station/i, 'low'],
    [/vendor/i, 'low'],
    [/funeral/i, 'low'],
    [/online resource/i, 'low'],
  ],
  CATEGORY_CAPACITY_SEED_DEFAULT: 'low', // spec §6.5's explicit DEFAULT - deliberately more conservative than the migration's 'medium' fallback, since this now governs live ranking, not a one-time backfill guess

  // EXPLORATION tier starvation guard (spec §8.2, step 7). Every
  // EXPLORATION_AGING_DAYS a place spends waiting (see
  // places.exploration_eligible_since) pulls its explorationRank down by 1,
  // so a low-capacity/never-verified place doesn't sit at the bottom of the
  // tier forever - it eventually climbs to rank 0 on wait time alone. Single
  // named tuning knob per the spec, ship as specced.
  EXPLORATION_AGING_DAYS: 90,
};
