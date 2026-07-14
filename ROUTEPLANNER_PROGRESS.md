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

## Done and committed (phase 3) — `bda0ee8`, `5a104a2`

Drive-time estimator + time-block packing + visit types, pure/tested, no DB
wiring beyond one migration and one sanity-check readout. 42 tests passing
(`npm test` from `server/`) at the time this was written; see the visit-type
duration update below and phase 5 for what changed since.

- `server/src/config/driveTime.js` — distance-banded speed constants
  (`SHORT_BAND_MAX_MILES`/`MEDIUM_BAND_MAX_MILES` boundaries at 1/5 road
  miles; `SPEED_MPH_SHORT`/`MEDIUM`/`LONG` at 15/25/38), circuity factor
  (1.3), fixed overhead (5 min), and `MIN_DRIVE_MINUTES` floor (3 — lowered
  from 5 at Bede's request; note overhead alone already exceeds it under
  default config, so the floor can't currently bind — that's fine, overhead
  is doing that job now).
- `server/src/config/visitTypes.js` — originally `drop_in` (10 min), `standard`
  (25), `presentation` (45), `pre_qualification` (20); **updated `87024c0`
  (2026-07-13)** to split `standard` into two real types once Bede wanted
  that distinction: `drop_in` (7), `check_in` (18, a short single-contact
  touch), `working_visit` (30, the new default, replaces `standard`),
  `presentation` (60), `pre_qualification` (15) — current values, see
  `client/src/api.js`'s `VISIT_TYPE_LABELS` for the frontend's copy of this
  same list. `pre_qualification` folds in a concept that already existed
  (capacity fields captured "at pre-qual") rather than becoming a second
  mechanism.
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
real routing API but a real improvement. (Update 2026-07-14: rather than
keep tuning the approximation further, Bede has decided to replace it with
an actual routing API — see phase 5 below.)

## Done and committed (phase 4) — `1ac0776`

Multi-day draft schedule generator, pure/tested, no DB wiring beyond one
sanity-check readout. 69 tests passing
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

## Status update (2026-07-14) — phases 5 and 6 are done

Everything phase 4 flagged as "explicitly not built yet" (real routing API,
stop-sequencing, draft/commit lifecycle, collision handling, the live-edit
recalculation loop) **has since been built** — see the phase 5/6 sections
below, which used to describe these as future plans and now describe what
was actually shipped, plus two frontend sub-slices on top of the phase 6
API. Still genuinely not built: pre-qual capture (visit-logging UI/
relationship-confirm prompts), suggestions + commit in the UI (frontend
sub-slice 3, next up), and retiring the old `services/scheduler.js`/
`routes/schedule.js`/`Schedule.jsx` "Today's Route" screen (deliberately
still running in parallel — see the frontend sections below).

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

## Phase 5 — real routing API + stop-sequencing optimization (DONE, committed `84d32bf`)

Below is the original design-decision writeup from when this was still a
plan; kept as-is since the reasoning is still exactly why it's built this
way. **What actually shipped, 2026-07-14:** provider is **OSRM's public demo
server** (`/trip` endpoint — does distance-matrix and waypoint-sequencing in
one call, no API key/signup, matching `geocoding.js`'s existing free-provider
precedent). New `server/src/config/routeOptimizer.js`
(`MAX_OPTIMIZE_STOPS: 18`, `MAX_TOPUP_STOPS: 30`, `MIN_TOPUP_MINUTES: 18`,
5s timeout) and `server/src/services/routeOptimizer.js`
(`optimizeRoute`/`getRouteLegMinutes`) — the one deliberately I/O-having
module in the whole route-planner stack; everything else stays pure/no-I/O.
`driveTime.js` gained `packOptimizedTimeBlock` (real per-leg OSRM minutes)
alongside the original haversine `packTimeBlock`, which stays in the codebase
permanently as the offline fallback when OSRM is unreachable — `optimizeRoute`
returns `null` on any failure (bad response, network error, timeout) and
callers always fall back, never throw/block. `scheduleGenerator.js`'s
`fillDayFromZone`/`generateDraft` became async, cap the per-zone candidate
pool at `MAX_OPTIMIZE_STOPS` before calling the optimizer, and run a
**top-up pass** after the initial pack/trim (batches next-best unpacked
candidates per re-optimize call rather than one network round-trip per
candidate — Bede's own idea, refined during code review). **Rank order still
picks which stops are candidates; the optimizer only sequences them** — the
four-tier priority model's guarantee is preserved at the "who's a candidate"
level only, an explicit accepted tradeoff (a closer-but-lower-ranked stop can
sequence before a farther-but-higher-ranked one within the capped pool).
A same-day `/code-review high` pass found and fixed 5 real issues before this
was committed (NaN propagating through a malformed-but-200-OK OSRM response,
a `MIN_DRIVE_MINUTES` override silently not reaching the optimized path, a
swallowed error that made "OSRM down" indistinguishable from "response
parsing bug" forever, commitments silently droppable with no visibility, and
the topup redesign above) — 110 tests passing at commit time (139 as of
phase 6, below). Not committed to `main` — sits on `bede-routeplanner` only,
1 commit ahead of `origin/bede-routeplanner` as of this writing.

Original design-decision writeup follows, for the reasoning:

**1. Replace the haversine + distance-banded-speed estimate in
`driveTime.js`'s `estimateDriveMinutes()` with a real routing API call**
(actual road distance/duration, not an approximation). Provider not yet
chosen (Google Maps Directions, Mapbox Directions, OSRM self-hosted, etc.) —
that's an open decision for next session, along with API-key/cost/rate-limit
handling. This was anticipated by design: `driveTime.js`'s module comment
has said since phase 3 that "swapping in a real routing API later only
means rewriting estimateDriveMinutes(); packTimeBlock() doesn't change" —
still true in spirit, but see the architectural wrinkle below.

**Architectural wrinkle to resolve before writing code:** every pure module
built so far (`schedulingEngine.js`, `driveTime.js`, `scheduleGenerator.js`)
has been synchronous, no I/O, by deliberate discipline. A real routing API
call is inherently async (network) and should be batched/cached rather than
called pairwise-per-stop-per-day (a 5-day draft with 5 stops/day is ~25
sequential drive-time lookups today; a real API wants a distance-matrix
call per day's candidate set, not 25 round-trips). This means
`estimateDriveMinutes` can no longer stay a synchronous drop-in — either
`packTimeBlock`/`generateDraft` become async and take a pre-fetched distance
matrix instead of calling `estimateDriveMinutes` inline, or a caching layer
sits in front of the API so the pure functions keep calling something
synchronous that's backed by a pre-warmed cache. Decide this shape before
touching `packTimeBlock`'s internals — it's a bigger change than "swap one
function's implementation."

**2. Add a stop-sequencing/route-optimization function** that reorders a
day's stops for a genuinely efficient route, replacing the current
"four-tier rank order = visit order" behavior (an explicit phase-4
simplification — see the "No within-day proximity resequencing" decision
above, which this work directly reverses). **Algorithm not yet decided** —
Bede hasn't settled on an approach yet. Options to weigh next session, not
a decision made now: a nearest-neighbor greedy heuristic (simple, fast,
good-enough for ~5-8 stops/day), a 2-opt improvement pass on top of
nearest-neighbor (better tours, still cheap at this scale), a small exact
TSP solver (feasible only because day-sized stop counts are tiny), or
leaning on the routing API's own waypoint-optimization feature if the
chosen provider has one (e.g. Google's `optimizeWaypoints`) — which would
also fold decision 1 and 2 into a single API call. That last option is
worth evaluating first once a provider is picked, since it could mean not
writing a TSP-style algorithm at all.

**Open question this raises for ranking:** today, four-tier rank order
*is* visit order (highest-priority stop first). If stops get reordered for
route efficiency, does rank order still decide *which* stops make the cut
when the day is over budget (packing), while optimization only decides the
*sequence* of whichever stops got picked — or does optimization get a say
in which stops are chosen too (e.g. dropping the priority order slightly
if it makes the whole day's route meaningfully shorter)? Needs a decision
before implementation; leaning toward "rank order picks the stops,
optimization only sequences them" to keep the four-tier model's guarantees
intact, but confirm with Bede before building.

Same checkpoint discipline as phases 1-4: pure/tested where possible (the
sequencing algorithm itself can and should stay a pure function even if
distance lookups become async/cached), tests via the scoped glob, stop for
review once tests pass and a sample draft looks right.

## Phase 6 — draft/commit lifecycle, collision, backend+API (DONE, committed `95049c7`)

Bede's scoping decisions going in: the new engine fully replaces the old
single-day scheduler *eventually*, but this pass was backend/API only —
`services/scheduler.js`/`routes/schedule.js`/`Schedule.jsx`/dashboard's
`loadRoute` were deliberately left untouched and re-verified still working,
since deleting them with no new UI yet would leave the app with no working
route-planning screen at all. Drafts got **dedicated new tables**, not
reused `visits` rows: `schedule_drafts` (one-active-per-user, enforced in
app code) + `schedule_draft_stops` (a stop's presence in the table IS the
draft — no soft-delete status, no stored running-totals; those are
recomputed live on every read, same "no manual fields" convention as
referral metrics). Also added `visits.visit_type` (a draft's visit-type
choice had nowhere to land at commit otherwise).

**New pure functions** (`driveTime.js`): `evaluateTimeBlock`/
`evaluateOptimizedTimeBlock` — the never-drop sibling to
`packTimeBlock`/`packOptimizedTimeBlock` this section originally flagged as
needed (see "Key implication" below, still accurate). (`routeOptimizer.js`):
`getRouteLegMinutes` — calls OSRM's `/route` (not `/trip`) so it respects
the caller's exact stop order instead of resequencing, since live-edit
recalculation must never silently reshuffle a user's own reorder back to
"optimal." 139 tests passing (up from 110 pre-phase-6).

**New DB orchestration layer**: `server/src/services/scheduleDraft.js`
(candidate-pool building, draft CRUD, `loadDraftView`/`loadDraftDayView` —
live recalc on every read, real-OSRM-first with haversine fallback, never
resequences) + `server/src/routes/scheduleDrafts.js` mounted at
`/api/schedule-drafts` (generate/active/reorder/add-stop/remove-stop/
set-visit-type/suggestions/commit-one-day/commit-all). Every route acts on
`req.user` from the bearer token, not a client-supplied `userId` — stricter
than the old scheduler's routes, deliberately, since this is exactly the
double-booking surface phase 6 exists to close.

**Known, accepted simplification:** `lockedElsewhere` at draft-generation
time is computed once against the generation date, not re-checked per future
day within the multi-day run. Conservative-not-risky by design; the live
per-day `addStop`/suggestions endpoints re-check fresh per specific date.

**Real bug found and fixed by the required two-user smoke test** (this is
why Bede insisted on it rather than a happy-path-only check): the initial
`commitDay` used the same `lockedElsewherePlaceIds` (visits + OTHER USERS'
draft stops) that generation/addStop correctly use — at commit time this
deadlocked, since two reps who both independently had the same place in
their still-open drafts for the same date each saw the OTHER's uncommitted
draft as a lock, so neither could ever commit it. Fixed with a narrower
`committedElsewherePlaceIds` (real `visits` rows only — an uncommitted draft
is a proposal, not a claim) used specifically by `commitDay`.

The target interaction model this was built against (from a separate
conversation Bede had about what it should feel like, worth preserving
verbatim-ish so it isn't re-derived from scratch — this is now implemented,
not aspirational):

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

**Key implication (built as described):** `packTimeBlock` (phase 3) is
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

The "nearby eligible stop" suggestion when a day is under budget (per the
interaction model above) reused `schedulingEngine.js`'s
`eligibility()`/`rankCandidates()` plus `driveTime.js`'s distance functions
as planned — `getSuggestions` in `scheduleDraft.js`. Persistence landed as
the dedicated `schedule_drafts`/`schedule_draft_stops` tables described
above (not `visits` rows with a `planned` status, which is what this
paragraph originally floated); multi-user collision handling is
`lockedElsewherePlaceIds`/`committedElsewherePlaceIds`, also above.

**Smoke-tested via Lisa Marks (id 5) + a throwaway `__SMOKETEST_Rep2` user**
(created, used, then fully deleted — including nulling Lisa's temp
`auth_token` back out), per this repo's smoke-test safety rules. All test
`visits`/`schedule_drafts`/`schedule_draft_stops` rows cleaned up after. Old
scheduler re-verified working unchanged after the build.

## Phase 6 frontend, sub-slice 1 — generate + read-only view (DONE, committed `ce2f41f`)

First of a 3-sub-slice frontend build Bede asked to be split up and reviewed
one at a time (matches this whole project's "stop for review" discipline):
(1) generate-inputs + read-only multi-day view, (2) live editing, (3)
suggestions + commit. This section covers (1).

No `guardian-angels-ui-spec.md` exists anywhere (repo or filesystem) despite
being the first place this was expected to be documented — confirmed with
Bede at the start of this slice to treat `client/src/styles.css` (design
tokens + component CSS, already heavily self-documented) and
`client/src/components/ui/*` (Button, Chip, EmptyState, Header, Logo) as the
real design-system source of truth instead. If that spec file ever turns up
or gets written, reconcile against it — for now these are the two places
that actually define the brand system in code.

**Built:** a new "Plan My Visits" tab in `App.jsx`, placed right after
"Today's Route" (which stays fully working, untouched — retiring the old
scheduler is still explicitly a later step, not this one). New
`client/src/components/PlanVisits.jsx`: a generate form (days ahead,
hours/day) plus a read-only render of `GET /api/schedule-drafts/active`'s
per-day stops/running totals/over-budget flags. `client/src/api.js` gained
`api.scheduleDrafts.{generate,active}`, `api.geocode`, `VISIT_TYPE_LABELS`.

**homeBase decision:** no rep/user location field exists in the schema
(flagged as a gap back in phase 4) — resolved for the UI by capturing it
fresh at generate time via `navigator.geolocation` ("Use my current
location"), falling back to a manual street/city/state/zip form when
denied/unavailable. The manual path needed a real geocoding endpoint, so
added `server/src/routes/geocode.js` (`POST /api/geocode`, thin wrapper
around the existing `services/geocoding.js#geocodeAddress`, previously only
ever called internally from `routes/places.js`) — mounted behind the same
global `requireAuth` as everything else.

**Verified live**, not just typechecked: no `chromium-cli` available in this
environment, so Playwright was installed temporarily into a scratch
directory (not committed) and used to drive real headless Chromium against
the actual dev server — logged in as Lisa Marks (id 5, temp `auth_token`
only, cleared after), granted mock geolocation, opened the new tab,
generated a real 5-day draft against live dev-DB places (real
OSRM-derived routing, correct zones, correct running totals/budget math),
confirmed no console errors and correct brand rendering. Cleaned up fully
after: deleted the smoke-test `schedule_drafts`/`schedule_draft_stops` rows,
cleared Lisa's `auth_token`, confirmed zero stray `visits` rows.

## Phase 6 frontend, sub-slice 2 — live editing (DONE, committed alongside this doc update)

Reorder (drag + up/down arrow fallback, same pattern as the old
`Schedule.jsx`), remove, ad-hoc add (via a place-search picker), and
visit-type change — each calls its `/api/schedule-drafts/:id/days/:date/...`
endpoint and replaces only that day's slice of client state from the
response (`loadDraftDayView`'s shape), never touching any other day or
re-deriving anything client-side. The server always recalculates running
totals/`overBudget` flags fresh on every mutation, so the live time math and
over/under-budget flagging fall out of that for free — nothing is ever
auto-dropped or auto-reshuffled beyond exactly what the user just did,
matching the interaction model above.

**Reused rather than duplicated:** the searchable place-picker autocomplete
(debounced search, click-outside-to-close) already existed as a private
component inside `NeedsMapping.jsx` for assigning a note to a place. Rather
than copy ~40 lines of identical logic for the new "+ Add a stop" flow, it
was extracted to `client/src/components/ui/PlacePicker.jsx` (took a
`placeholder` prop to support both call sites' different copy) and
`NeedsMapping.jsx` now imports it instead of defining it locally — a real
second-use case, not speculative reuse.

Reorder is optimistic (shows the new order immediately, same UX pattern
`Schedule.jsx` already uses) but with stale running totals until the
server's authoritative recalculation lands and replaces it a moment later —
totals depend on real drive time between stops, so they can't be computed
correctly client-side. A failed reorder falls back to a full reload of the
active draft rather than trying to hand-roll a rollback.

**Verified live** the same way as sub-slice 1 (fresh temp token on Lisa
Marks, cleaned up after): generated a small 2-day draft, changed a stop's
visit type and watched its running total recalculate (50m → 1h 20m,
matching the presentation type's longer duration), reordered two stops with
the move-down arrow and confirmed the order actually swapped, removed a stop
and watched the day's stop count and totals update, added a stop via the
picker and watched it land as a new last stop with a correct running total.
Over/under-budget flagging (day-level badge + per-stop flag + red border)
kept working correctly through all of these edits. No console errors. Also
re-verified `NeedsMapping.jsx` still renders with no errors after the
`PlacePicker` extraction. All smoke-test rows/tokens cleaned up after.

**Next:** sub-slice 3 — suggestions (the "nearby eligible stop" prompt on
under-budget days, wired to the already-built `getSuggestions` endpoint) and
commit (per-day and full), same one-slice-at-a-time review discipline. After
that, retiring the old scheduler becomes possible for the first time.

## Running things

- Tests: `nvm use 24` then `npm test` from `server/` (runs
  `node --test "src/**/*.test.js"`).
- Client dev server: `cd client && npm run dev` (or `./dev.sh` from the repo
  root runs both); client build: `npm run build` from `client/`.
- Resume the branch: `git checkout bede-routeplanner` — as of this writing,
  ahead of `origin/bede-routeplanner` and not merged into `main`; push/PR
  only when Bede asks.
