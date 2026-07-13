# Route Planner — progress notes

Working branch: `bede-routeplanner` (not merged to main). Resume with `git checkout bede-routeplanner`.

## Done and committed (phases 1-2)

Commit `2661151` — schema + config + scoring engine, 15 passing tests.

- `server/src/migrations/20260712000000_add_scheduling_fields.js` — adds
  `capacity_level`/`capacity_monthly_referrals`/`capacity_status`/
  `current_agency_used`/`has_inhouse_service`/`relationship_level`/
  `snooze_until`/`do_not_visit` to `places`, `skip_reason` to `visits`, plus
  eligibility-query indexes. Backfills `capacity_level` for all 262 existing
  places from a keyword match against their real category values.
- `server/src/config/scheduling.js` — cadence matrix + tunable constants
  (plain module, no settings table — matches this codebase's existing
  convention for tunables).
- `server/src/services/schedulingEngine.js` — the pure scoring/eligibility
  engine.
- `server/src/services/schedulingEngine.test.js` — 15 tests, all passing.

## Key design decisions (don't re-derive these)

**Four-tier ranking, lexicographic not additive.** Lower tier always wins;
within a tier, sorted by that tier's own value, descending:
0. **Commitments** — `nextVisitDate <= today`. Most-overdue-promise first.
1. **Endangered/rescue** — verified/adjusted places whose urgency has reached
   `NEGLECT_MULTIPLIER` (2×) their own (possibly fatigue-stretched) cadence.
   Sorted by urgency.
2. **Exploration** — unverified (`capacity_status === 'estimated'`) places.
   Sorted by capacity-level guess (high > medium > low), NOT urgency.
3. **Maintenance** — everything else (verified/adjusted, below the neglect
   threshold). Sorted by urgency. Never-visited = `Infinity` urgency, which
   in practice pushes a never-visited-but-verified place straight into tier 1
   (rescue), not tier 3 — an emergent, correct consequence of the model, not
   a special case.

**Rescue is urgency-based, never capacity-based.** A low-capacity verified
place that's genuinely 2×+ overdue jumps to tier 1 just as easily as a
high-capacity one — capacity is potential, not the reason a place gets
rescued. Don't let a future change couple these two.

**`NEGLECT_MULTIPLIER = 2`** in `config/scheduling.js` — the one tuning knob
for how much real neglect it takes to override an exploration guess.

**Eligibility guard precedence** (`eligibility()` in `schedulingEngine.js`):
`do_not_visit` excludes always (even over a due commitment) → a due
commitment (`nextVisitDate <= today`) bypasses the hard floor only (a human
explicitly asking us back is exactly what the floor exists to protect
against overriding) → otherwise the floor/snooze/locked-elsewhere guards
apply normally.

## Done, uncommitted (phase 3)

Drive-time estimator + time-block packing + visit types, pure/tested, no DB
wiring beyond one migration and one sanity-check readout. 42 tests passing
(`npm test` from `server/`).

- `server/src/config/driveTime.js` — distance-banded speed constants
  (`SHORT_BAND_MAX_MILES`/`MEDIUM_BAND_MAX_MILES` boundaries at 1/5 road
  miles; `SPEED_MPH_SHORT`/`MEDIUM`/`LONG` at 15/25/38), circuity factor
  (1.3), fixed overhead (5 min), and `MIN_DRIVE_MINUTES` floor (3 — lowered
  from 5 at Bede's request; note overhead alone already exceeds it under
  default config, so the floor can't currently bind — that's fine, overhead
  is doing that job now).
- `server/src/config/visitTypes.js` — `drop_in` (10 min), `standard` (25),
  `presentation` (45), `pre_qualification` (20). `pre_qualification` folds in
  a concept that already existed (capacity fields captured "at pre-qual")
  rather than becoming a second mechanism.
- `server/src/migrations/20260713000000_add_default_visit_type_to_places.js`
  — nullable `default_visit_type` on `places` (applied to dev DB, batch 12).
  Pre-fills the type choice when scheduling a visit there; always
  overridable per visit. No route/service reads or writes it yet.
- `server/src/services/driveTime.js` — `haversineMiles`, `speedForRoadMiles`,
  `estimateDriveMinutes` (bands road distance, not straight-line, since
  that's what determines which kind of road you're actually on),
  `resolveVisitType`/`visitDurationMinutes` (throws on an unrecognized
  type), `timeBlockMinutes`, and `packTimeBlock` (greedy, chains drive time
  stop-to-stop, stops at the first budget-busting stop rather than skipping
  ahead — see the phase-4 note below on why this specific behavior matters).
- `server/src/services/driveTime.test.js` — 27 tests covering all of the
  above, including exact band boundaries (1mi, 5mi) and mixed visit-type
  durations packed into one day.

Sanity-checked against real dev-DB geography (Pioneer Heart Institute /
Snyder Physical Therapy, same plaza, 70th & Van Dorn; Bryan Medical Center
East / Butherus-Maser & Love, nearby east Lincoln; Fire Station 11 / St.
Andrew Dung-Lac, cross-town NW-to-NE) — cross-town estimate went from 45 min
(flat 25mph) to 32 min (banded speeds), still probably a bit high versus a
real routing API but a real improvement, and further tuning is just a config
edit now.

## Done, uncommitted (phase 4)

Multi-day draft schedule generator, pure/tested, no DB wiring beyond one
sanity-check readout (not committed — see below). 69 tests passing
(`npm test` from `server/`).

- **Prerequisite folded in first**: `driveTime.js`'s `timeBlockMinutes`/
  `packTimeBlock` now add `PREP_MINUTES`/`DATA_ENTRY_MINUTES` (3/5 min,
  `config/visitTypes.js`) on top of drive+visit time — these had been added
  to config in phase 3 but never wired into the actual math until now.
- `server/src/services/scheduleGenerator.js` — `workingDays()` (hand-rolled
  UTC-safe date math, no dayjs, same convention as `schedulingEngine.js`'s
  `daysSince()`), `toPackableStop()`, `fillDayFromZone()`, and the
  orchestrator `generateDraft()`.
- `server/src/services/scheduleGenerator.test.js` — 27 tests.

**Key design decisions (confirmed with Bede, don't re-derive):**
- **Zone = the existing `places.region` field.** No new schema/concept —
  reuses the "side of town" bucket already derived by
  `services/priority.js`'s `regionForPlace()` and already used by the
  single-day `scheduler.js` for clustering.
- **Default zone per day = the region of the single top-ranked eligible
  candidate remaining** in the pool (mirrors `scheduler.js`'s existing
  seed-then-cluster precedent). Overridable per day via `zoneOverrides`.
- **Eligibility/urgency are re-ranked once per day, against that day's own
  calendar date** — not ranked once up front against today. A place whose
  hard floor lapses by day 3, or a commitment that becomes due by day 4, is
  correctly reflected starting that day. This was an explicit choice over
  the simpler "rank once" alternative — confirmed with Bede specifically
  because a 5-day-out draft should reflect each day arriving, not "if you
  did all this today."
- **No within-day proximity resequencing.** Stops fill in four-tier rank
  order; `packTimeBlock`'s existing trim-to-budget (truncating) behavior is
  reused as-is for this one-time generation fill — the separate never-drop/
  flag-only function for the live-edit loop (see below) is still a later
  slice, not this one.
- **Multi-day dedupe**: once a candidate is actually packed into a day, it's
  removed from the pool for every later day; candidates merely considered
  (wrong zone that day, or excluded by budget) remain available later.
- **`homeBase: {lat, lng}`** (each day's drive-time origin) is an explicit
  generator input, not sourced from anywhere — no user/rep location field
  exists anywhere in the schema yet (confirmed absent from `users` and
  every config file; `HANDOFF.md`/`NOTES.md` already flagged this as a known
  gap). A real value has to come from a future settings/profile phase.
- **"Days ahead" = N working days**, transparently skipping weekends and
  `exceptionDates`, always producing exactly N day-entries.

Sanity-checked with a throwaway (uncommitted, deleted after use) script
pulling all 255 geocoded places plus real visit history from the dev DB:
5 working days, 4-hour budget, 5 zones in a row (Southeast → South → East →
Northeast → Southeast again), 25 real stops packed, zero duplicates across
the draft, ~210-230 minutes used per day (9-30 min slack) — looked right.

## Explicitly NOT built yet

Draft/commit lifecycle + multi-user collision handling, the live-edit
recalculation loop (see the never-drop/flag-only packing function noted
below — still not built), pre-qual capture (visit-logging UI +
relationship-confirm/promotion prompts), and all frontend work. None of this
exists yet, even as stubs.

## Open questions / notes for later

- **Spot-check the category → capacity seeding.** Most mappings are
  spec-explicit or obvious; two were eyeballed and worth a second look:
  **Case Managers** and **Concierge Doc** (both seeded as-is in the
  migration's `CAPACITY_BY_CATEGORY_KEYWORD` table — see that file for the
  full mapping and reasoning). Nothing blocks on this; `capacity_status`
  moves to `'adjusted'` the moment anyone hand-corrects a place, same as any
  other seeded guess.
- **`NEGLECT_MULTIPLIER` and `CADENCE_DAYS` are meant to become user-editable
  settings later**, not stay hardcoded forever. Kept as named constants in
  `config/scheduling.js` for now specifically so a future settings-table
  phase can lift them out without touching the engine itself.

## Next step: phase 5 — draft/commit lifecycle, collision, and the live-edit loop

The target interaction model (from a separate conversation Bede had about
what this should feel like, worth preserving verbatim-ish so it isn't
re-derived from scratch):

> The draft schedule is a live, interactive workspace — not a static
> proposal that requires regeneration to change. The generator runs once to
> populate each day. After that, every edit (changing a stop's visit type,
> reordering, removing, swapping) recalculates that day's running
> time-total immediately and in place. When a day goes over its hour budget,
> show it — flag the stops that fall past the limit — but do NOT
> auto-remove or auto-reshuffle stops the user didn't touch; the user
> decides what to cut or carry to another day. When a day is under budget,
> surface a non-intrusive suggestion to add a nearby eligible stop, which
> the user can accept or dismiss. The only automatic behavior is keeping the
> time math current and flagging over/under; all actual add/remove/reshuffle
> decisions stay with the user. No second generation round-trip.

**Key implication, decided but not yet built:** `packTimeBlock` (phase 3) is
the right shape for `generateDraft`'s (phase 4) one-time initial fill —
given a ranked candidate pool and a budget, decide how many fit, dropping
the rest. It is the *wrong* shape for the live-edit loop, because it
silently truncates (via `break`) anything past the budget rather than
returning it — which would make a user's own already-placed stops vanish
instead of getting flagged. Phase 5 needs a **second, sibling pure
function** (tentatively `evaluateDayTimeBlock` or similar) that shares
`packTimeBlock`'s math (same drive-chaining, same visit-type resolution) but
never drops a stop — it returns every stop given to it, annotated with its
running total and an `overBudget` flag, plus the day's overall over/under
amount. `packTimeBlock`/`generateDraft` stay as-is for initial generation;
the new function serves recalculation after edits.

Also needed for phase 5: the "nearby eligible stop" suggestion when a day is
under budget (per the interaction model above) — can reuse
`schedulingEngine.js`'s `eligibility()`/`rankCandidates()` plus
`driveTime.js`'s distance functions, so that part is mostly wiring, not new
logic — plus the actual persistence (draft rows written to `visits` as
`planned`?) and multi-user collision handling (`lockedElsewhere`, already a
first-class input throughout the pure layer, just never wired to a real
query yet).

Same checkpoint discipline as phases 1-4: pure/tested where possible, tests
via the scoped glob (not bare `node --test src` — that executes every `.js`
file it finds, including `index.js`, which starts a real server on :4000).
Stop for review once tests pass.

## Running things

- Tests: `nvm use 24` then `npm test` from `server/` (runs
  `node --test "src/**/*.test.js"`).
- Resume the branch: `git checkout bede-routeplanner`.
