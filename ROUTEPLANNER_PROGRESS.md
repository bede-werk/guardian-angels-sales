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

## Explicitly NOT built yet

Drive-time estimator, multi-day generator (zone assignment + day filling +
proximity sequencing), draft/commit lifecycle + multi-user collision
handling, pre-qual capture (visit-logging UI + relationship-confirm/
promotion prompts), and all frontend work. None of this exists yet, even as
stubs.

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

## Next step: phase 3

Drive-time estimator + time-block packing, as pure, tested functions —
same checkpoint discipline as phases 1-2: no DB wiring, no UI, tests via the
scoped glob (not bare `node --test src` — that executes every `.js` file it
finds, including `index.js`, which starts a real server on :4000). Stop for
review once tests pass. Also have it print/show real distance estimates
computed from actual place lat/lng pairs in the dev DB, so the numbers can
be sanity-checked against real Lincoln geography, not just synthetic
coordinates.

## Running things

- Tests: `nvm use 24` then `npm test` from `server/` (runs
  `node --test "src/**/*.test.js"`).
- Resume the branch: `git checkout bede-routeplanner`.
