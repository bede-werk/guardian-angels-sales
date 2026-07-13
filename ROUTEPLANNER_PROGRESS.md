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

## Explicitly NOT built yet

Multi-day generator (zone assignment + day filling + proximity sequencing),
draft/commit lifecycle + multi-user collision handling, pre-qual capture
(visit-logging UI + relationship-confirm/promotion prompts), and all
frontend work. None of this exists yet, even as stubs.

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

## Next step: phase 4 — the generator

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

**Key implication for phase 4, decided but not yet built:** `packTimeBlock`
(existing) is the right shape for the generator's one-time initial fill —
given a ranked candidate pool and a budget, decide how many fit, dropping
the rest. It is the *wrong* shape for the live-edit loop, because it
silently truncates (via `break`) anything past the budget rather than
returning it — which would make a user's own already-placed stops vanish
instead of getting flagged. Phase 4 needs a **second, sibling pure
function** (tentatively `evaluateDayTimeBlock` or similar) that shares
`packTimeBlock`'s math (same drive-chaining, same visit-type resolution) but
never drops a stop — it returns every stop given to it, annotated with its
running total and an `overBudget` flag, plus the day's overall over/under
amount. `packTimeBlock` stays as-is for the generator; the new function
serves recalculation after edits. Decided 2026-07-13, deliberately deferred
out of phase 3 to fold into phase 4's design rather than bolt on early.

Also still needed for phase 4: zone assignment, day filling, proximity
sequencing, and (per the interaction model above) the "nearby eligible
stop" suggestion — which can reuse `schedulingEngine.js`'s
`eligibility()`/`rankCandidates()` plus `driveTime.js`'s distance functions,
so that part is mostly wiring, not new logic.

Same checkpoint discipline as phases 1-3: pure/tested where possible, tests
via the scoped glob (not bare `node --test src` — that executes every `.js`
file it finds, including `index.js`, which starts a real server on :4000).
Stop for review once tests pass.

## Running things

- Tests: `nvm use 24` then `npm test` from `server/` (runs
  `node --test "src/**/*.test.js"`).
- Resume the branch: `git checkout bede-routeplanner`.
