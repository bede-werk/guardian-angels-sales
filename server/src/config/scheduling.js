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

  // Tunables for services/capacity.js (capacity-computation-spec.md). Single
  // scale across every category — see the spec's §4 for why per-category
  // thresholds were rejected.
  CAPACITY_THRESHOLDS: {
    MEDIUM_MIN: 6, // 0-5 => low
    HIGH_MIN: 16, // 6-15 => medium, 16+ => high
  },

  // Our own referral throughput only counts as a measured floor once there's
  // enough of it to not be noise — small counts over a short window are
  // exactly the kind of "3 referrals in a week" fluke that shouldn't ratchet
  // a place's capacity number up permanently (see spec §6.2 — the floor only
  // ever raises, never lowers, so a loose gate's failure mode is
  // over-stating capacity, not under-stating it).
  MEASURED_MIN_EXPOSURE_DAYS: 180,
  MEASURED_MIN_REFERRAL_COUNT: 3,

  // A declared observation (pre-qual answer or manual override) older than
  // this many days is 'stale', not 'fresh' — see spec §6.6. An override does
  // NOT reset this clock; it only says "don't trust the stale number in the
  // meantime," it doesn't make the number current again.
  CAPACITY_STALE_DAYS: 365,

  // Starting guess for a place that's never been pre-qualified and has no
  // measured referral floor yet — spec §6.5. Ordered first-match-wins,
  // case-insensitive substring match against places.category. This is a
  // FRESH copy of the same keyword table the 20260712000000 migration
  // seeded places.capacity_level from (not imported from that migration —
  // migrations in this codebase are frozen historical snapshots, not living
  // config; see that migration's own header). Keep the two in sync only if
  // there's a reason to — the migration's copy did its one-time job already
  // and this one is what actually governs new/never-pre-qualified places
  // going forward. Tuned against the real category values in this dataset,
  // not just the spec's illustrative examples (which used category names —
  // 'SNF/Rehab', 'ALF', 'Legal and Trust' — that don't match this app's
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
  CATEGORY_CAPACITY_SEED_DEFAULT: 'low', // spec §6.5's explicit DEFAULT — deliberately more conservative than the migration's 'medium' fallback, since this now governs live ranking, not a one-time backfill guess

  // EXPLORATION tier starvation guard (spec §8.2, step 7). Every
  // EXPLORATION_AGING_DAYS a place spends waiting (see
  // places.exploration_eligible_since) pulls its explorationRank down by 1,
  // so a low-capacity/never-verified place doesn't sit at the bottom of the
  // tier forever — it eventually climbs to rank 0 on wait time alone. Single
  // named tuning knob per the spec, ship as specced.
  EXPLORATION_AGING_DAYS: 90,
};
