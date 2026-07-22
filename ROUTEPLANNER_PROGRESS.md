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
was actually shipped, including all three frontend sub-slices on top of the
phase 6 API. The old single-day scheduler this whole document originally
assumed would keep running in parallel is now fully removed (see "Old
scheduler retired" below). Still genuinely not built: pre-qual capture
(visit-logging UI/relationship-confirm prompts).

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

## Phase 6 frontend, sub-slice 3 — suggestions + commit (DONE, 2026-07-15)

Last of the 3-sub-slice frontend plan. Both new pieces sit on top of sub-slice 2's
`DraftDay` component, no new backend work needed — `getSuggestions`/`commitDay`/`commitAll`
were already built and tested as part of phase 6's backend.

**Suggestions:** a "Suggest a stop" button appears on a day's card whenever
`!day.overBudget && day.remainingMinutes > 0` (next to "+ Add a stop"). Clicking it fetches
`GET .../days/:date/suggestions` on demand (not eagerly for every day — a real API call) and
renders each candidate's name/category/city/zone with an "Add" button. Adding a suggestion
calls the exact same `addStop` endpoint the ad-hoc `PlacePicker` flow uses — a suggestion is
just a pre-filtered candidate, not a different code path — and removes it from the local
suggestions list on success (rather than an automatic re-fetch) so the panel doesn't need a
second round trip just to stop offering something already added.

**Commit:** `commitDay` (per-day, in each `DraftDay`'s card header) and `commitAll` (top-level,
next to "Plan again"), both gated behind `window.confirm` — matches `Schedule.jsx`'s existing
confirm-before-destructive-action convention. `commitDay`'s response shape (`{ date, committed,
skippedCollisions }`) isn't a day view — the committed stops just became real `visits` rows and
are gone from the draft — so this is the one mutation in `PlanVisits.jsx` that triggers a full
`load()` (whole-draft reload) instead of patching one day's slice via `onDayUpdated`. A new
`.notice-banner` CSS class (blue, alongside the existing red `.error-banner`) reports what got
committed and separately surfaces any `skippedCollisions` (a stop that collided with a
same-date `visits` row committed by someone else since it was added to this draft).

**Verified live** the same way as sub-slices 1-2 (fresh temp token on Lisa Marks, cleaned up
after): generated a 5-day draft, opened suggestions on the first (under-budget) day — 5 real
nearby candidates came back, correctly zone-filtered to that day's zone ("South Lincoln") —
added one via its "Add" button (5→6 stops, running total correctly flipped the day to "20m
over," which is the never-drop evaluator working exactly as designed for a user-driven add, not
a bug), committed that day (6 real `visits` rows landed, `visit_type` correctly resolved from
draft override → place default, notice banner text correct), then committed all remaining days
(20 more `visits` rows). Confirmed directly against the dev DB: 26 total `visits` rows in the
right shape, 0 leftover `schedule_draft_stops`. No console errors. Fully cleaned up after:
deleted all 26 test `visits` rows plus the test draft, cleared Lisa's temp `auth_token` back to
null.

**All three route-planner frontend sub-slices are now done.** The "Plan My Visits" workspace
(generate → live-edit → suggest → commit) is functionally complete end-to-end.

## Old scheduler retired (2026-07-15)

Deleted outright: `server/src/services/scheduler.js`, `server/src/routes/schedule.js` (the
whole `/api/schedule` prefix — `GET /`, `POST /generate`, `PATCH /reorder`),
`client/src/components/Schedule.jsx`, and the "Today's Route" nav tab in `App.jsx`. Also
removed everything that only existed to support it:
- `client/src/api.js`'s `schedule`/`generateSchedule`/`reorder` methods (the new system's
  `api.scheduleDrafts.*` namespace is untouched, no naming collisions).
- `StatusChip` (`ui/Chip.jsx`) and its `.badge.status-*` CSS — no other consumer existed.
- Dead CSS: `.stop.done`/`.stop.skipped`/`.stop-contact`/`.stop-note-preview`/
  `.stop-buttons`/`.grid.cols2` (all Schedule.jsx-only). Shared classes reused by
  `PlanVisits.jsx` (`.stop.dragging`/`.drag-over`, `.drag-handle`, `.reorder`,
  `.progress-bar`/`.progress-label`) were kept — only their stale "Schedule.jsx" comments
  were updated to point at `PlanVisits.jsx` instead.

**Bede's explicit call on the one non-obvious tradeoff:** the Dashboard's "Today's Route" card
(stat tile + stop list + "Open route" button) depended on the old scheduler's `loadRoute()`
query — a read-only display, not generation logic, so it could technically have been kept by
moving the query elsewhere. Asked Bede directly rather than assuming; he chose full removal
("remove all of that... very clean") over keeping a slimmed read-only version. Dashboard now
shows 2 stat tiles (was 3) and "Completed this week" as a standalone full-width card instead
of a two-column layout paired with the removed route card.

Every file that referenced the old scheduler in a comment (not just code) was updated rather
than left dangling: `scheduleDraft.js`, `scheduleDrafts.js`, `visits.js`, `places.js`,
`people.js`, `PlanVisits.jsx`, `PersonDetail.jsx`, `PlaceDetail.jsx`, `VisitLogModal.jsx`.
`README.md`'s API table still listed the deleted `/api/schedule*` endpoints and had never
been updated with the route planner's real endpoints — fixed, plus rewrote the stale "Daily
schedule generator" and "Dashboard — today's route" feature-list bullets.

**Verified**: 139 backend tests pass unchanged, client build succeeds (59 modules, down from
60), and a live Playwright pass (Lisa Marks id 5 temp token, cleaned up after) confirmed: the
nav bar shows exactly 5 tabs with no "Today's Route", the Dashboard renders cleanly with no
layout gap where the old card was, `Plan My Visits` still works end-to-end, `GET /api/schedule`
now 404s, `GET /api/dashboard` no longer returns a `today` key — zero console/page errors
throughout.

**The route planner is now the only route-planning surface in the app.** There is no
old-system fallback left to fall back to.

## Post-retirement UX feedback pass (2026-07-15)

With the workspace feature-complete, Bede started actually using it and walked through the
UI live, asking questions and requesting changes as he went. Three real features came out of
that session, all in `PlanVisits.jsx` + supporting backend:

**1. Manual "Re-optimize" per day.** New `POST /api/schedule-drafts/:id/days/:date/reoptimize`
(`scheduleDraft.js`'s `reoptimizeDay`) — the first live-edit mutation allowed to resequence a
day's stops, using the same real-OSRM `optimizeRoute()` generation already uses internally.
Every other mutation (add/remove/reorder/visit-type) deliberately preserves whatever order the
stops are already in (see `getRouteLegMinutes`'s header comment) — this is the one exception,
and only because the user explicitly asked for it via the button. Falls back to leaving the
order untouched if OSRM is unreachable; never drops a stop, even an ungeocoded one (routed
stops get resequenced, ungeocoded ones are appended after, in their prior relative order).

**Button gating went through two rounds of refinement, both driven by Bede's own follow-up
corrections** (session-only client state in `PlanVisits.jsx`, not persisted — no schema
change):
- Round 1: show it only once a day has been edited (add/remove/reorder), hide it again once
  clicked. Visit-type changes deliberately don't count — they only change a stop's duration,
  never which order is fastest to drive.
- Round 2 (Bede's correction): don't hide the button after clicking — keep it visible but
  **disabled**, and only re-enable (not re-show) it once the day is edited again. Two booleans
  now: `everEdited` (sticky true, controls visibility) and `needsReoptimize` (toggles,
  controls enabled/disabled). Verified all 6 state transitions live (generate → hidden;
  visit-type change → still hidden; reorder → visible+enabled; click → visible+disabled;
  another visit-type change → unchanged; remove → visible+enabled again).

**2. "Discard plan" button.** New `DELETE /api/schedule-drafts/:id` (`deleteActiveDraft` —
ownership-checked wrapper around the pre-existing internal `deleteDraft`, which the regenerate
path already used but which was never safe to expose directly to a route). Discards the
*whole* multi-day proposal at once, not one day — cascades through the existing FK
(`schedule_draft_stops.draft_id ON DELETE CASCADE`, enforced even on SQLite via
`PRAGMA foreign_keys = ON` in `knexfile.js`) so nothing's left orphaned. Already-committed days
are unaffected (their stops left the draft the moment they became real `visits` rows).
`homeBase` is deliberately left set client-side afterward so a fresh generate doesn't force
re-entering a start location. Distinct from "Plan again" (discard + immediately regenerate in
one click) — Discard just goes back to the empty state, no replacement.

**3. Per-stop time + day-total prominence.** Each stop's own row (next to its remove button)
now shows `stop.blockMinutes` (drive + visit + prep + data entry — its own contribution to the
day) instead of `stop.runningTotalMinutes` (cumulative up to that point) — Bede specifically
wanted "the amount of time each visit is expected to take," not a running tally, per-row.
Added a hover tooltip breaking the number down into its four components. Separately, the
day-level total moved out of the small `.progress-label` caption into a new prominent
`.progress-total` line (bold, 20px, serif, blue-dark) above the progress bar — "3h 43m of 4h"
now reads as the headline, with "5 stops · 17m free" as a smaller caption underneath.

**Verified live** for all three (Playwright, Lisa Marks id 5 temp token, cleaned up after each
run): Re-optimize actually resequenced a shuffled day via a real OSRM call; the gating state
machine matched all 6 expected transitions exactly; Discard collapsed a 6-card draft down to
the empty state and left zero orphaned DB rows; per-stop times summed exactly to the
prominent day total (50+48+43+41+41 = 223min = "3h 43m", confirmed via screenshot). 139
backend tests pass throughout, client build stays clean (59 modules).

**Committed 2026-07-15** on `bede-routeplanner` (`git log` for the exact hash — not
hardcoded here to avoid a doc referencing its own not-yet-existing commit). Not yet pushed to
`origin/bede-routeplanner`.

**Next**: nothing specific queued — Bede is still walking through the workspace and giving
live feedback; expect more of this same pattern (small, targeted UX asks) before this is
considered done-done. No open technical debt from this pass.

## Two more live-feedback additions, same day (2026-07-15)

**Manual address entry, always available.** The generate form's start-location picker used to
only show the manual street/city/state/zip form as a fallback after "Use my current location"
failed or was denied. Bede wanted it available proactively instead. Added a new
`manualEntryOpen` toggle (`PlanVisits.jsx`) — an "Enter address manually" button next to "Use
my current location" opens the same form immediately, no geolocation attempt required. The
old auto-open-on-failure behavior (`locationError`) still works unchanged; the form now opens
on `manualEntryOpen || locationError`, either condition. No backend change — reuses the
existing `/api/geocode` endpoint.

**Read-only "Committed" section per day.** After a day's stops get committed, they used to
just vanish from the draft view — a fully-committed day looked identical to an empty one, with
no indication anything happened. `loadDraftView`/`loadDraftDayView` (`scheduleDraft.js`) now
also return a `committed` array — real `visits` rows for that user+date, via a new
`committedVisitsQuery` helper (one query for the whole window in `loadDraftView`, grouped by
date in JS per this codebase's existing "N rows collapsed in JS, not N queries" convention;
one direct query for the single date in `loadDraftDayView`). The frontend shows a green
"✓ N committed" badge in the day's header plus a read-only "Committed" list (name/address/
category/tier/visit-type per stop) — deliberately not editable here; editing an already-
committed visit still goes through the normal visit-log flow elsewhere in the app. If a day
has BOTH committed stops and leftover draft stops (e.g. one stop hit a same-day collision and
stayed in the draft while the rest committed), both sections show, with a "Still planning"
label distinguishing them.

**Verified live** — both features worked as designed; the committed-view test also incidentally
caught a **real** cross-user collision against Bede's own already-committed schedule (his real
usage data, confirmed untouched afterward): 4 of 5 stops committed, 1 correctly skipped and
reported in the notice banner, and the day's badge/section correctly showed "✓ 4 committed"
with the 5th nowhere to be found in either the committed list or the leftover draft — exactly
right, not a bug. 139 backend tests pass, client build clean throughout.

**This batch (Re-optimize/Discard/time-display + these two) is being committed, pushed, and
opened as a PR against `main` this session** — see `git log`/GitHub for the final commit hash
and PR number; not hardcoded here to avoid this doc referencing state that doesn't exist yet
at write-time.

## Reopen a committed day (2026-07-22)

Once a day's stops were committed, they were locked — the only way to change anything about a
planned day after accepting it was to delete individual `visits` rows by hand, or delete the
whole committed day and re-plan it from scratch. Added a proper "Edit" path instead.

**Backend:** `scheduleDraft.reopenCommittedDay({ userId, date, homeBase })` pulls that date's
still-planned (`status: 'planned'`, `source: 'planner'` only — an ad-hoc `source: 'manual'`
"Log a visit" entry sharing the date must never get swept in) `visits` rows back out, deletes
them, and inserts them into `schedule_draft_stops` on whichever draft the user's currently
working from — reusing an existing active draft's own `homeBase` if they have one, or creating
a new draft (from the passed-in `homeBase`) if they don't. From that point on, every existing
draft-editing endpoint (reorder/add/remove/visit-type/reoptimize/commit) treats the day exactly
as if it had never been committed — "Accept proposal" simply re-commits it through the normal
`commitDay` path. New route: `POST /api/schedule-drafts/days/:date/reopen`.

One correctness fix this required: `commitDay` used to leave a committed date sitting in the
draft's own `params.days` forever, so a day could be simultaneously "committed" (real `visits`
rows exist) AND "still an open proposal" (still shows in the draft view) — exactly the
ambiguous state this whole feature exists to eliminate. Fixed: once at least one stop from a
date actually commits, that date is dropped from `params.days` (skipped entirely if every stop
collided — an all-collision day is still a live proposal, not a done one). Deliberately does
*not* delete the draft row even if this empties `params.days` out completely, since `commitAll`
calls `commitDay` in a loop against one `draftId` captured up front — deleting mid-loop would
break a later iteration's ownership check. An empty-but-present draft cleans itself up on
`PlanVisits.jsx`'s own next `load()`.

**Frontend:** an "Edit" button next to each "✓ Planned" day's badge in the "Already Planned"
list, gated on having a `homeBase` set (same requirement as generating a new draft) and
confirm-gated ("They'll temporarily show as not-yet-scheduled while you make changes…").

**Two related fixes bundled in with this work:**
- `reoptimizeDay` used to hold a DB transaction open across the real OSRM `/trip` network call
  (up to a few seconds) — the exact anti-pattern this file's own comments warn against
  elsewhere, and a real connection-pool-exhaustion risk as usage grows (flagged in the
  2026-07-15 ultra-review backlog). Fixed: the ownership check and OSRM call now happen outside
  any transaction; only the final sort-order write re-checks ownership and runs inside one.
- `addStop`'s two-request duplicate-add race (same place, same draft, two near-simultaneous
  requests) used to surface a raw 500 from the `unique(['draft_id', 'place_id'])` constraint
  instead of the clean 409 the pre-check throws for the non-race case. Fixed by catching the
  constraint violation and translating it, same pattern `commitDay`'s own per-row insert loop
  already used.

146 backend tests pass, client build clean. Committed on `bede-working` (see `git log` for the
hash) — not yet pushed/merged.

## Mapbox address autocomplete for manual start-location entry (2026-07-22)

A UI/UX request: the generate form's "enter address manually" start-location entry was 4
separate street/city/state/zip fields plus a "Use this address" button (one-shot geocode via
the free Census API). Replaced with a single Google-Maps-search-style box — type freely, pick
a live suggestion, done.

New client dependency, `@mapbox/search-js-react` — its `SearchBox` component is purpose-built
for exactly this flow. Wrapped in `client/src/components/ui/AddressAutocomplete.jsx`, themed
to match the app's own inputs/dropdowns via Mapbox's Theme API (it's a custom element, can't
read this app's CSS classes directly), `proximity`-biased toward Lincoln, NE. `onRetrieve`
maps straight to the `{ lat, lng, label }` shape `homeBase` already used, so nothing else in
`PlanVisits.jsx`'s generate flow had to change. Needs `client/.env`'s `VITE_MAPBOX_TOKEN` (see
`client/.env.example`) — shows an inline notice instead of erroring if it's missing.

The old one-shot `POST /api/geocode` route and `api.geocode()` client fn had no other caller,
so both were deleted along with the manual-entry-only state/handler (`manualAddress`,
`geocoding`, `lookUpManualAddress`) they existed for. Doesn't touch place-address geocoding
(`services/geocoding.js`) — different use case, still Census-backed, untouched.

Verified live: real Lincoln address, live suggestions, selected one, start-location display
updated correctly, no console errors. 146 backend tests pass (route deletion only, no logic
changed), client build clean.

## Plan My Visits: duration picker, click-to-view place detail, default visit type (2026-07-22)

Four more small live-feedback rounds from Bede on the same tab, same day.

**Hours + minutes budget picker.** The per-date daily budget was a single whole-hours
`<select>` (2-6). `hoursPerDay` was already a decimal on the wire (`budgetMinutes = hoursPerDay
* 60`, validated as just `> 0`), so no backend change was needed — replaced it with two selects
(hours 1-9, minutes 0/15/30/45) grouped in one bordered `.duration-picker` pill so it still
reads as one control. `splitHoursPerDay()` converts the stored decimal for display;
`HOUR_OPTIONS` starts at 1 (never 0) so the pair can never combine to a 0-value. Verified with a
real generated draft at a 4.5-hour budget (`hoursPerDay: 4.5` in the request, `~4h 22m of 4h
30m` in the resulting day).

**Click a stop to open its place detail.** Reused `PlaceDetail.jsx` unchanged — the same
`placeId`/`userId`/`onClose`/`onChanged`/`onDeleted` modal Places/People/Dashboard already use.
`PlanVisits.jsx` didn't take a `userId` prop before (schedule-draft endpoints infer the user
from the auth token, never needed one) — added it, threaded from `App.jsx`. Click target is
just the stop's `.main` block, not the whole `<li>`, since that row already owns drag-and-drop
plus its own reorder/visit-type/remove controls as siblings — only the visit-type `<select>`
(nested inside `.main`) needed `stopPropagation()`. Deleting a place from inside the modal is
safe with no backend change: `schedule_draft_stops.place_id` is `ON DELETE CASCADE`, so the
stop just disappears on the next `reload()`.

**Hover-highlight polish, two rounds.** The highlight only covered `.main`'s own box, not the
full row (`.reorder`/`.order`/`.actions` are siblings, not descendants) — fixed via
`.stop:has(.main.hover-row:hover)` repainting the full-width `<li>`, with a matching
`:has(...):has(select:hover)` cancel rule so the visit-type select and the reorder/remove
buttons never show it. Then: the shared `.hover-row` transition only animated one of the two
now-overlapping background layers, so hovering looked like an inconsistent fade — scoped
`transition: none` to this specific row (not the shared class, which still fades everywhere
else it's used) for instant on/off instead, per Bede's preference.

**Default visit type: Drop-in, not Working visit.** `config/visitTypes.js`'s
`DEFAULT_VISIT_TYPE` changed from `working_visit` (30 min) to `drop_in` (7 min). Bigger than a
UI tweak: all 262 real places have `default_visit_type: NULL`, so every one of them rides this
fallback for actual duration budgeting, not just a dropdown's initial value — a test 4-hour day
went from 6 packed stops to 12. Flagged explicitly to Bede for that reason. Two
`scheduleGenerator.test.js` tests encoded the old 30-minute assumption in a tight-budget
exclusion/rollover scenario; fixed by pinning those specific place fixtures to
`default_visit_type: 'working_visit'` explicitly rather than just updating the expected
numbers, so the tests stay correct regardless of the global default going forward.

146 backend tests pass (2 fixed), client build clean throughout all four changes.

## Running things

- Tests: `nvm use 24` then `npm test` from `server/` (runs
  `node --test "src/**/*.test.js"`).
- Client dev server: `cd client && npm run dev` (or `./dev.sh` from the repo
  root runs both); client build: `npm run build` from `client/`.
- Resume the branch: `git checkout bede-routeplanner` — as of this writing,
  ahead of `origin/bede-routeplanner` and not merged into `main`; push/PR
  only when Bede asks.
