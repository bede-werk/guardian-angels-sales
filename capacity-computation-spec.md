# Capacity - Computation Spec

Target: Guardian Angels Sales Scheduler
Status: Implementation spec - steps 1–7 built 2026-08-07 (see HANDOFF.md §18), **step 9 done 2026-08-25** (migration `20260825000000` dropped the three legacy columns). Step 8 remains BLOCKED on the eRSP migration, not merely unstarted - it needs 455 days of dated referral history that does not exist yet.
Companion to: relationship-computation-spec.md (the other cadence axis, folded into HANDOFF.md §16 - never saved standalone either)
Replaces: manual `places.capacity_level`, frozen `capacity_monthly_referrals`, latched `capacity_status`
Also folds in: EXPLORATION tier tie-break (launch blocker), ENDANGERED referral drop-off trigger

## 1. Why

Three fields, all stagnant, all read on every ranker run:

- `capacity_level` - manual high/medium/low. Does double duty: one axis of the cadence table, and the sole ordering key for the EXPLORATION tier. Never revised against reality.
- `capacity_monthly_referrals` - written once at first pre-qual from a number someone gave at a door, then frozen forever.
- `capacity_status` - a one-way latch. Moves estimated → verified on first completed visit and never moves again. `adjusted` has no writer anywhere in the codebase. Once verified, always verified, no matter how wrong or how old the number underneath it is.

Two more fields were stored and read by nothing: `current_agency_used`, `has_inhouse_service`.
**Removed 2026-08-10** (Bede's call - see §10) rather than kept as unused intel.

Per the project convention - no manual smart fields that need upkeep - capacity becomes a computed value derived from an observation history, with a clearly-flagged manual override.

## 2. Definition (locked - do not reinterpret)

Capacity is the number of homecare referrals a place sends per month, to any agency, excluding anything routed to their own in-house service.

- Referrals sent to competitors count in full. That volume is contested, not lost, and winning it is the entire point of the sales function.
- Referrals absorbed by a place's in-house homecare service do not count. That flow is structurally unwinnable.
- Capacity is potential, not realized. It is not "how much they send us."

The design consequence. If capacity meant realized volume, a 200-bed facility that has never sent us anything would read low → 90-day cadence → we stop going → they keep sending nothing. The guess confirms itself, and the cadence table's most valuable cell (high capacity + weak relationship = visit most often) empties out by construction. Everything below exists to protect that.

## 3. The measurement asymmetry (core invariant)

The pre-qual number and the referrals table measure different quantities:

| Source | Measures |
|---|---|
| Pre-qual answer | Their total homecare referrals to anyone |
| referrals table | Referrals to Guardian Angels only |

Therefore observation corrects the estimate in one direction only:

- Upward is valid. If they claimed 5/month total and have sent us 8/month, the claim was wrong and low. Our measured volume is a hard floor on their true capacity - proof the pipe is at least that big.
- Downward is invalid. A place that claimed 15/month and sends us 0 may be sending 15 to a competitor. That is the highest-value target in the database. Demoting it to low would route us away from it permanently.

INVARIANT: measured referral volume may only raise the capacity number. It may never lower it. Downward correction happens only through a human re-ask or an explicit manual override.

This must be enforced in one place (`computeCapacityForPlace`) and covered by a test that fails loudly if a future change makes measurement bidirectional.

The same referral data is used for a second, separate purpose - detecting a place that used to refer and stopped (§9). That is an ENDANGERED trigger, not a capacity input. Do not merge the two code paths.

## 4. Buckets

Single scale, all categories. No per-category thresholds.

```js
// server/src/config/scheduling.js
CAPACITY_THRESHOLDS: {
  MEDIUM_MIN: 6,   // 0–5  => low
  HIGH_MIN:   16,  // 6–15 => medium,  16+ => high
},
```

- low: 0–5 per month
- medium: 6–15 per month
- high: 16+ per month

Zero is a real answer, not a null. A place that answers "0 - everything goes to our in-house service" is genuinely low. Do not auto-set `do_not_visit`. Surface a dismissible suggestion on PlaceDetail ("This place reports no winnable referrals. Mark as do-not-visit?") and leave the decision to the human. A 0 today is a 0 under this DON.

`do_not_visit` gained its own `do_not_visit_until` date 2026-08-10, alongside a proper "Do not visit until…" panel on PlaceDetail's Upcoming Visits card (presets + an indefinite option), not just this one-click suggestion - see HANDOFF.md §19A for the full design.

No hysteresis on bucket boundaries. Oscillation risk is near zero because the number only ratchets up between annual re-asks. Do not add a stabilisation mechanism.

## 5. Schema

### Migration A - `capacity_observations` (new table)

This table is the source of truth for declared capacity. Each pre-qual answer or manual adjustment appends a row; nothing is ever overwritten. 280 places at roughly one observation per year is a trivially small table - do not denormalise it into `places` for performance.

```sql
CREATE TABLE capacity_observations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id          INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  monthly_referrals INTEGER NOT NULL CHECK (monthly_referrals >= 0),
  source            TEXT    NOT NULL CHECK (source IN ('prequal','manual','seed','import')),
  observed_at       TEXT    NOT NULL,           -- ISO date
  person_id         INTEGER REFERENCES people(id) ON DELETE SET NULL,  -- who answered
  visit_id          INTEGER REFERENCES visits(id) ON DELETE SET NULL,
  note              TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_capacity_obs_place_observed ON capacity_observations(place_id, observed_at DESC);
```

`person_id` matters: it lets the UI say "verified by Sharon, who no longer works here."

Backfill: for every place with a non-null `capacity_monthly_referrals`, insert one row with `source = 'import'` and `observed_at` = the place's best-known verification date. If no such date exists, use the place's `created_at` - this will correctly read as stale immediately, which is the honest answer.

### Migration B - `places` columns

```sql
ALTER TABLE places ADD COLUMN capacity_override_level  TEXT;    -- 'high'|'medium'|'low', nullable
ALTER TABLE places ADD COLUMN capacity_override_reason TEXT;
ALTER TABLE places ADD COLUMN capacity_override_at     TEXT;
```

Stored separately from the computed value, same pattern as the relationship override, so divergence is visible rather than silently destructive.

### Deprecations

- `places.capacity_monthly_referrals` - stop writing immediately, keep reading during verification, drop in a follow-up migration.
- `places.capacity_level` - same.
- `places.capacity_status` - replaced by derived confidence (§6). Keep the column until every consumer is migrated, then drop. Do not add values to its enum.

> **2026-08-07 addendum, RESOLVED:** for steps 5–6, "stop writing immediately" above was not literally true for `capacity_monthly_referrals`/`capacity_status` - `routes/visits.js`'s `maybeCapturePreQualification` dual-wrote both columns alongside the new `capacity_observations` insert, because the EXPLORATION tier gate (`rankKey`'s `isEstimated` check) still read `place.capacity_status` directly. Without the bridge, a pre-qualified place would never leave EXPLORATION. (An earlier version of this note said "delete at step 6" - wrong; step 6 only swapped the cadence-lookup/`capacityRank` consumers of capacity LEVEL, not `capacity_status`, so the bridge had to survive it.) **The bridge was removed 2026-08-07 once step 7 landed and the swap was verified** (see HANDOFF.md §18's "Step 7" subsection) - `capacity_monthly_referrals`/`capacity_status` are now genuinely unread by anything ranking-related, exactly as this section originally intended.

## 6. `services/capacity.js`

Model on `services/referralMetrics.js`. Must accept an `asOf` date (default today) so the route planner can eventually evaluate per-day - same requirement as the relationship service.

```
computeCapacityForPlace(placeId, { asOf }) -> {
  declared:        { value, observedAt, source, personId } | null,
  measuredFloor:   number | null,
  effectiveMonthly: number | null,
  level:           'high' | 'medium' | 'low',
  levelSource:     'override' | 'declared' | 'measured' | 'category_seed',
  confidence:      'unknown' | 'stale' | 'fresh',
  staleAt:         ISO date | null,
  contributors:    [ ...for UI display ]
}
```

Also export `computeCapacityForPlaces(placeIds)` - a bulk path that must return values identical to N single calls (tested, §13).

### 6.1 declared

Latest `capacity_observations` row for the place with `observed_at <= asOf`. Null if none.

### 6.2 measuredFloor

Our own referral throughput, converted to a monthly rate:

```
window        = referrals attributed to this place, observed_at in (asOf - 365d, asOf]
exposureDays  = min(365, asOf - max(place.created_at, firstReferralDate))
monthlyRate   = round( count(window) / (exposureDays / 30.44) )
```

Exposure gate. Return null unless both:

```js
MEASURED_MIN_EXPOSURE_DAYS: 180,
MEASURED_MIN_REFERRAL_COUNT: 3,
```

Small counts are noisy. Because the floor only ratchets upward, the failure mode of a loose gate is over-stating capacity and over-visiting - less costly than the reverse, but still real.

### 6.3 effectiveMonthly

```js
effectiveMonthly = (declared == null && measuredFloor == null)
  ? null
  : Math.max(declared?.value ?? 0, measuredFloor ?? 0);
```

### 6.4 level - resolution order

1. `capacity_override_level` if set → `levelSource: 'override'`
2. `effectiveMonthly != null` → bucket it (§4). `levelSource` is `'measured'` if the floor won the `max()`, otherwise `'declared'`
3. Otherwise → category seed → `levelSource: 'category_seed'`

### 6.5 Category seed

Used only for places never pre-qualified and with no measured floor. Reuse whatever category defaults the app already seeds `capacity_level` from today. If none exist, use this table and flag it in HANDOFF.md as tuned-by-guess:

```js
CATEGORY_CAPACITY_SEED: {
  'Hospital': 'high', 'SNF/Rehab': 'high',
  'ALF': 'medium', 'Hospice': 'medium', 'Home Health': 'medium', 'Rehab': 'medium',
  'Physicians': 'low', 'PT': 'low', 'Community Partner': 'low',
  'Legal and Trust': 'low',
  DEFAULT: 'low',
},
```

These are guesses and the app exists to replace them. Their only job is to order the opening weeks of the sweep.

> **2026-08-07 note:** built against the real keyword table `places.capacity_level` was already seeded from (migration `20260712000000`, tuned against this app's actual category strings), not the illustrative categories above - see the spec's own instruction to "reuse whatever the app already seeds from."

### 6.6 confidence - replaces the `capacity_status` latch

```js
CAPACITY_STALE_DAYS: 365,
```

- `unknown` - no declared observation. Never pre-qualified.
- `stale` - declared observation older than `CAPACITY_STALE_DAYS`.
- `fresh` - declared observation within the window.

An override does not make a place fresh. If a place was last pre-qualified in 2024 and you manually override its level, it still needs re-asking; the override just says you don't trust the stale number in the meantime.

Why a year: re-pre-qualification is a question asked during a visit you were already making, not a separate trip, so the marginal cost is a few minutes. Across ~280 places that's roughly five re-asks a week folded into normal routing. Cheap enough to be worth it, long enough that partners aren't asked the same question twice a season.

## 7. Consumers - cadence table

No structural change. `schedulingEngine.js` stops reading `places.capacity_level` and reads level from the capacity service. The cadence matrix is untouched.

Before wiring this into the ranker, produce a distribution readout - count of places per level, split by `levelSource` and `confidence`. Throwaway dev script or endpoint. If nearly everything lands in one bucket, the thresholds are wrong and the axis is dead again, and that needs to be known before the ranker consumes it, not after. Same discipline as §12.3 of the relationship spec.

> **2026-08-07 note:** built as `npm run capacity:distribution` (`server/src/scripts/capacity-distribution.js`). Run against real data: 261 places, level axis separates fine off the category seed alone (25/34/41% high/medium/low), but 99.6% are still `category_seed`/`unknown` confidence - expected, since the 261 places are real but referral/visit history is still test-only. This validated the category-seed map, NOT the 6/16 thresholds - that check is still deferred until real pre-qual answers exist in volume (roughly 30).

## 8. Consumers - EXPLORATION tier tie-break (launch blocker)

The bug. The EXPLORATION tier (tier 3 of the four-tier lexicographic ranker) is ordered by guessed capacity level alone - three possible values across ~280 places. After the eRSP import nearly everything is unverified, so the tier is effectively unordered. Because zone selection reads `ranked[0].place.region`, an arbitrary tie picks the region for an entire day. Days get misrouted by tie-break noise.

**Done 2026-08-07.** See HANDOFF.md §18's "Step 7" subsection for the full build record, simulation results, and the one deliberate architecture change from this section's own literal wording (`rankKey` now returns a 4-element tuple for EXPLORATION instead of the single scalar every other tier uses - `compareRankKeys` was generalized to compare elementwise rather than reduce the 3 keys below into one scalar).

### 8.1 New ordering key

Sorted lexicographically within the tier:

1. `explorationRank` (ascending) - see 8.2
2. `priority_score` (descending) - already maintained, already blends tier and `is_priority`, and currently ignored by the ranker entirely. This is where human judgment about which places matter finally reaches route generation.
3. `place.id` (ascending) - final deterministic tiebreak. Never leave ordering to row insertion order; identical inputs must produce identical routes.

> **2026-08-07 note:** implemented as `rankKey`'s EXPLORATION branch returning `[TIERS.EXPLORATION, -explorationRank, priority_score, -place.id]` - the ascending keys (1 and 3) are negated so the existing single higher-first comparator (already used by every other tier's urgency/daysSince value) produces the right order for all three without needing per-index direction logic. `compareRankKeys` was generalized from a fixed `[tier, value]` pair to loop elementwise over however many within-tier values a tier's key carries.

### 8.2 explorationRank - capacity guess with a starvation guard

```js
EXPLORATION_AGING_DAYS: 90,

const baseRank = { high: 0, medium: 1, low: 2 }[level]
               + (confidence === 'stale' ? 3 : 0);   // never-asked outranks re-asked

const daysWaiting = asOf - place.exploration_eligible_since;

explorationRank = Math.max(0, baseRank - Math.floor(daysWaiting / EXPLORATION_AGING_DAYS));
```

> **2026-08-07 correction - `exploration_eligible_since` is REQUIRED, not `?? place.created_at`.** The original pseudocode above fell back to `created_at` at read time whenever this value was missing. Caught before it shipped: a place that's been fresh for months and then goes stale re-enters EXPLORATION - but with no real `exploration_eligible_since` ever recorded, the fallback would hand it `created_at`, often a year old, as its aging anchor. That backdates its waiting clock by most of a year and jumps it to rank 0 the day it goes stale, ahead of places that have genuinely never been pre-qualified and have been waiting honestly the whole time. Fixed by adding `places.exploration_eligible_since` as a real, always-populated column (migration `20260807000002`) instead: stamped to `created_at` at backfill/place-creation (nothing observed yet - eligible immediately), and to `observed_at + CAPACITY_STALE_DAYS` the moment any capacity_observations row is written (this place will next become eligible when THAT observation goes stale - computable and stamped immediately, not derived later, so a future `CAPACITY_STALE_DAYS` retune doesn't retroactively reshuffle every place already waiting in the tier). See `services/capacity.js`'s `stampExplorationEligibility`.

Two things this does:

- Fresh information beats refreshed information. A place never pre-qualified sorts above a place whose year-old number needs a refresh, at equal capacity.
- Low-capacity places stop starving. This is the fix for the concern that Legal and Trust, Community Partner, and most physician offices would bucket low, sit permanently at the bottom of EXPLORATION, never get pre-qualified, never enter the urgency-driven tier, and fall off the map. Under aging, a low place climbs to rank 0 after 180 days of waiting. At import everything shares a `created_at`, so aging is inert on day one and pure capacity ordering governs the opening sweep - which is correct.

Note this is a single scalar sort key inside one tier, not additive cross-tier weighting. The lexicographic tier structure is unchanged.

### 8.3 What does not need fixing

Verified low-capacity places do not starve in the MAINTENANCE tier, and no cadence cap should be added. Urgency is `days_since_last_visit / target_cadence`, which is scale-free: a 90-day-cadence place at 180 days has urgency 2.0 and outranks a 30-day-cadence place at 30 days (1.0). Low-capacity places surface rarely - which is the intent - but they do surface. Adding a `MAX_CADENCE_DAYS` clamp would be redundant and would quietly flatten the axis.

Zone-first generation also helps: a low-capacity place inside the zone being swept is close to free to add as fill. Geography already does much of this work.

## 9. Consumers - ENDANGERED referral drop-off

The gap. The ENDANGERED tier fires only on `urgency >= NEGLECT_MULTIPLIER` - pure calendar neglect. But the truest endangered case is a place that used to refer and stopped. A partner who sent 4/month for two years and 0 last quarter is an emergency today, and currently doesn't register until enough calendar days accumulate. That is late.

**Not started as of 2026-08-07.**

> **Source requirement, added 2026-08-07 (spec amendment - read before building this):** the detector MUST compute `recent`/`baseline` from `referrals.place_id` directly (the same source `capacity.js`'s `measuredFloorByPlace` uses), NEVER from `referralMetrics.js`'s place-level rollup (`referralMetricsByPlaceId`). That rollup joins on the referring person's *current* `place_id`, not the referral's own place attribution - so a departing named contact (DON leaving, etc.) produces the exact drop-off signature by construction: recent volume collapses to zero the moment they leave, while the baseline (computed while they still worked there) stays high. Built on the rollup, this detector would fire a false ENDANGERED alert on every contact departure, concentrated in the highest-turnover categories - in the one tier whose entire value depends on being trustworthy. This is the same divergence documented in §12's note below and in HANDOFF.md §18; it is a hard dependency for this section specifically, not just a general FYI.

### 9.1 Detector

```js
DROPOFF_RECENT_DAYS:       90,
DROPOFF_BASELINE_DAYS:     365,   // baseline window ends where recent window begins
DROPOFF_MIN_HISTORY_DAYS:  270,   // referral history required before the detector may fire
DROPOFF_MIN_BASELINE:      1.0,   // referrals/month
DROPOFF_RATIO:             0.25,
DROPOFF_COOLDOWN_DAYS:     30,
```

```
recent   = monthly rate over (asOf - 90d, asOf]
baseline = monthly rate over (asOf - 455d, asOf - 90d]     // excludes the recent window
```

Fires when all hold:

- referral history for the place spans >= `DROPOFF_MIN_HISTORY_DAYS`
- `baseline >= DROPOFF_MIN_BASELINE`
- `recent <= baseline * DROPOFF_RATIO`
- no completed visit to the place within `DROPOFF_COOLDOWN_DAYS`

### 9.2 The cooldown is not optional

Visiting a drop-off place resets its urgency but does not resume its referrals. Without a cooldown, a stopped partner pins to the top of ENDANGERED and gets routed every single week forever, colliding with the 5-day revisit floor and crowding out the rest of the territory. The cooldown gives the visit time to work before the alarm re-arms. Write this reasoning into HANDOFF.md.

### 9.3 Tier ordering

ENDANGERED splits into two ordered sub-tiers rather than inventing a normalisation between two incomparable scales:

- 2a - drop-off, sorted by lost monthly volume (`baseline - recent`) descending
- 2b - calendar neglect, sorted by urgency descending (existing behaviour, unchanged)

A place that used to send 4/month and stopped outranks a place that is 2.1× past its cadence. If a place qualifies for both, it appears once, in 2a.

### 9.4 Hard dependency

This detector requires dated referral rows. If the referral history carries no usable dates, `detectDropoff` must return an empty set rather than approximate - a false ENDANGERED alert destroys trust in the tier faster than a missing one. Gate it behind a config flag (`DROPOFF_DETECTOR_ENABLED`) so it can ship dark and be switched on when the data supports it.

## 10. current_agency_used and has_inhouse_service - REMOVED 2026-08-10

Both fields, and all associated display/functionality, were dropped at Bede's explicit request
(migration `20260810010000_drop_agency_and_inhouse_service.js`; `CapacityDetail.jsx`'s intel
block removed). This section is kept as history, not as a build target - do not re-add these
fields without asking first.

Original design, for reference: both were meant to remain intel, entering no scoring path.
In-house flow was already excluded from the capacity number by definition (§2), so a second
discount for `has_inhouse_service` would have counted the same fact twice, and "uses a
competitor" doesn't change pipe size - it changes what you say in the room.

## 11. UI changes

### PlaceDetail

- Effective monthly number, derived level, and levelSource
- When the measured floor won: "They reported 4/month; we've received 9/month. Using 9."
- Confidence badge; when stale: "Capacity last confirmed 14 months ago by Sharon Klein - worth asking again."
- Override control, showing computed vs. override side by side when they diverge
- Observation history (the `capacity_observations` rows) - this is where a partner's pipe visibly growing over three years becomes legible
- Dismissible do-not-visit suggestion when `effectiveMonthly === 0`

### VisitLogModal

- Show the pre-qual section whenever `confidence !== 'fresh'` (currently gated on `capacity_status === 'estimated'`, which never re-opens)
- When stale, phrase it as a refresh, not a first ask: "Last time we heard ~6/month. Still about right?"
- Answers append a `capacity_observations` row; they never overwrite a column
- Record which contact answered (`person_id`)

## 12. eRSP migration - what to ask for (answering the open question)

Ask for dated referral rows: one row per referral, with referral date, place, and contact where available. Everything downstream depends on dates, not totals.

Priority order:

1. Dated rows, 24+ months. Everything in this spec works at launch - measured floors, baselines, drop-off detection.
2. Dated rows, <18 months. Measured floors work. The drop-off detector needs 455 days of window, so ship it behind `DROPOFF_DETECTOR_ENABLED = false` and switch it on once native data fills the gap.
3. Aggregate totals only. Import them as `capacity_observations` rows with `source = 'import'` so they can raise the capacity floor, but do not synthesise dates to feed the detector. Start the referral clock at import date; the detector becomes available roughly 9–15 months later.

If eRSP will only export one thing, take dated referrals over contact records. Contacts can be rebuilt by walking the territory. Referral history cannot be reconstructed at all.

> **2026-08-07 note:** `measuredFloorByPlace` deliberately reads `referrals.place_id` (stamped once, at referral-creation time, from the referring person's *then-current* place - see `routes/referrals.js`) rather than the live `people.place_id` join `referralMetrics.js` uses for its own, different purpose. This means a contact who changes employers does NOT relocate their referral history under capacity's accounting - that history stays with the building it actually happened at, per §2/§14's "capacity is a property of the building" rule. `referralMetrics.js`'s place-level rollup does the opposite (it follows the contact to their new employer), so the two systems will legitimately disagree for any contact who's changed employers. Correct behavior in both cases, but flag it in HANDOFF.md - it will look like a bug the first time someone notices the numbers don't match.

## 13. Tests

1. Asymmetry - up. Declared 3, measured 12 → effective 12, level medium, `levelSource: 'measured'`.
2. **Asymmetry - down.** Declared 15, measured 0 → effective 15, level **medium**. This is the invariant test; name it so a future change can't quietly delete it.

   > **2026-08-07 correction:** originally drafted as "level high," which contradicts this spec's own §4 bucket boundaries (medium is 6–15; high starts at 16 - declared 15 buckets to medium). Corrected here to match §4 and the "Bucket boundaries" test directly below, which already asserted `15 → medium`. The asymmetry invariant itself (the value is not pulled down by a lower measurement) is what this test verifies either way; the bucket label was the only error. Implemented per this corrected version - see `capacity.test.js`'s `'Asymmetry - down'` case.

3. Exposure gate. 2 referrals over 200 days → `measuredFloor === null`. 3 referrals over 170 days → null. 3 over 200 → non-null.
4. Bucket boundaries. 5 → low, 6 → medium, 15 → medium, 16 → high, 0 → low.
5. Staleness. Observation at exactly `asOf - 365d` → fresh; at `asOf - 366d` → stale.
6. Override precedence. Override beats computed; override does not change confidence.
7. Exploration ordering determinism. Two runs over identical data produce identical order.
8. Exploration aging. A low/unknown place waiting 180 days sorts above a high place waiting 0 days. At `daysWaiting = 0` for all, ordering is pure capacity.
9. Stale below unknown. Equal capacity, one unknown and one stale → unknown first.
10. Drop-off fires. Baseline 4.0/mo, recent 0.5/mo, 400 days of history → fires; lost volume 3.5.
11. Drop-off cooldown. Same place with a completed visit 10 days ago → does not fire.
12. Drop-off floor. Baseline 0.4/mo → never fires regardless of ratio.
13. asOf respected. Computing with `asOf` six months back returns the values that were correct then.
14. Bulk parity. `computeCapacityForPlaces([a,b,c])` equals three single calls.
15. Empty case. A place with no observations and no referrals → category_seed, `confidence: 'unknown'`, no crash.

> **2026-08-07 status:** tests 1–6, 13–15 built and passing (`capacity.test.js`, 11 tests - some spec tests share one written case). Tests 7–12 (EXPLORATION ordering/aging, drop-off detector) not written - they test code from steps 8–9, not built yet.

## 14. Explicitly out of scope

- Seasonality adjustment. Deferred by decision. The drop-off detector will produce seasonal false positives if Lincoln volume swings annually; revisit after a year of live data. Note it in HANDOFF.md so it isn't rediscovered as a bug.
- Per-category capacity thresholds. Single scale by decision.
- `MAX_CADENCE_DAYS` clamp. Deliberately rejected - see §8.3.
- Auto `do_not_visit` on zero capacity. Suggestion only.
- Person-level capacity. Capacity is a property of the building, not the contact.
- Per-day `asOf` threading through `generateDraft`. The service accepts `asOf`; actually threading a per-day date through the planner remains separate work.
- Quality-weighted urgency clock. Decided 2026-08-10, not open anymore - any completed visit
  should count. See HANDOFF §16's deferred-items note.

## 15. Build order

1. Migrations A and B, plus backfill. Verify observation counts match places with prior numbers. - **done**
2. `services/capacity.js` with tests. Do not wire to anything yet. - **done**
3. Distribution readout (§7). Confirm the buckets separate before the ranker consumes them. - **done**
4. Wire into GET endpoints; PlaceDetail display. - **done**
5. VisitLogModal pre-qual gate change + observation write path. - **done**; ran with a temporary dual-write bridge to the legacy columns (see §5 addendum) through steps 6 and 7, removed once step 7 verified
6. Swap `schedulingEngine.js` cadence lookup to the computed level. Compare computed vs. legacy `capacity_level` across all places and eyeball the diff before switching. - **done 2026-08-07**: diff was 260/261 unchanged (the 1 move was the internal test place's own manual override, exercised and confirmed end to end, then cleared); before/after draft generation confirmed byte-identical on the same seed/date/zone. `targetCadenceDays`/`capacityRank` now read the computed level via `buildCandidatePool`'s new `capacityLevel` field (`effectiveCapacityLevel()` in `schedulingEngine.js`, same fallback-to-column pattern as `effectiveRelationshipLevel`). The `capacity_status`/`isEstimated` tier gate was explicitly NOT touched here - that was step 7.
7. EXPLORATION tier ordering (§8). - **done 2026-08-07**: `rankKey`'s tier gate now reads computed `confidence`, not `place.capacity_status` (`effectiveCapacityConfidence()`); within-tier order is `explorationRank` (§8.2) then `priority_score` then `place.id`, via a generalized `compareRankKeys`. Added `places.exploration_eligible_since` as a real, always-stamped column per §8.2's 2026-08-07 correction. Simulated at day 0/90/180 on real data before finalizing - see HANDOFF.md §18's "Step 7" subsection for the full numbers; matched the spec's own prediction exactly (inert at 0, medium joins rank 0 at 90, low at 180). Dual-write bridge (§5 addendum) removed after this was verified.
8. Drop-off detector (§9), shipped behind `DROPOFF_DETECTOR_ENABLED = false`. Must read `referrals.place_id` directly per §9.1's 2026-08-07 amendment, never `referralMetrics.js`'s place rollup - see HANDOFF.md's logged bug in that rollup first. - **not started**
9. Drop `capacity_monthly_referrals`, `capacity_level`, `capacity_status` in a follow-up migration once verified. - **DONE 2026-08-25**, migration `20260825000000`, which also dropped `relationship_level` (§16's equivalent) and `tier`/`is_priority`/`priority_score` (HANDOFF.md §23). The three `effective*` transition shims in `schedulingEngine.js` went with them; see that migration's header for why the engine's unit tests had to change alongside.

Steps 6 and 7 are the two that change routing behaviour. Smallest viable diffs, no opportunistic refactoring, and surface any policy question rather than resolving it in code.
