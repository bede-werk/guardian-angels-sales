# Guardian Angels Sales Scheduler - Project Handoff

_Last updated: 2026-07-29_

This document is a self-contained context dump so work can resume in a new session.
It summarizes what was built, key decisions, how to run it, the Railway deploy saga,
current state, and next steps.

---

## 0. Start here (note to self, written 2026-07-09)

If you're picking this project back up cold, read this section first - it'll reorient you
faster than the full doc below.

---

### 2026-08-03 - Relationship level is now COMPUTED (new §16 at the bottom of this doc)

`places.relationship_level` was a manual field that defaulted to `'weak'`, had no write path
anywhere in the app, and had never once been edited - so every place read `'weak'` and one of
the two axes of the route planner's cadence table was doing nothing. It's been replaced with a
computed, decaying score (`server/src/services/relationship.js`), measured per PERSON and
rolled up to the place, with a manual override that is always displayed next to the computed
value it replaces. **Full design, the three new migrations, and the deferred items are in §16
- read that before touching relationship, capacity, or visit-outcome code.**

Two things it's worth knowing immediately, because both will otherwise look like bugs:

1. **Visit outcomes were replaced outright.** `interested / not_ready / follow_up / no_answer /
   left_materials` → `substantive / introduced_new / brief / materials_only / unavailable /
   declined`. No old→new mapping was written: the old values were evaluative ("how did it
   feel"), the new ones observational ("what happened"), so there's no honest 1:1. Existing
   rows keep their old string and score at a documented floor rather than throwing.
   **Writing the real backfill is a to-do for whenever actual historical data gets imported**
   (all current visit data is test data) - see §16's deferred list.
2. **Everything currently scores 0 / `weak`, and that is correct, not broken.** No visit in the
   DB carries the new capture fields yet, and every existing completed visit is detached
   (`place_id` null) from smoke-test cleanup. Run `npm run relationship:distribution` (new) to
   see the live picture - it warns loudly when one bucket holds >90% of places, which is the
   signal that the axis isn't separating and half-lives/thresholds need tuning before the
   ranker leans on it. Seeding (People tab → "Rate relationships") is what makes day one honest.

### 2026-08-07 - Capacity is now COMPUTED too (new §18 at the bottom of this doc), steps 1–7 of 9

The other cadence axis got the same treatment as relationship above. `places.capacity_level`/
`capacity_monthly_referrals`/`capacity_status` were a manual guess, a number frozen at first
pre-qual, and a one-way latch respectively - replaced with `server/src/services/capacity.js`,
computed from an append-only `capacity_observations` log plus our own measured referral
throughput, with the same override pattern. `schedulingEngine.js`'s cadence lookup AND the
EXPLORATION tier (membership and ordering) both now read the computed service - nothing left in
the ranker reads `place.capacity_level`/`capacity_status` anymore (steps 6–7, done - see §18 for
both verifications). **Full design and the two remaining steps are in
[capacity-computation-spec.md](capacity-computation-spec.md) and §18 below - read before touching
capacity, the EXPLORATION tier, or scheduling cadence.** Step 8 (the drop-off detector) is
**BLOCKED, not just pending** - it needs 455 days of dated referral history, which doesn't exist
until the eRSP migration lands, and Bede isn't touching that migration for a while. There's
nothing to build against; don't pick it up speculatively.

One thing worth knowing immediately, because it was briefly logged as a bug and isn't one:

- **Capacity and `referralMetrics.js`'s PLACE-level rollup deliberately disagree on job-changing
  contacts - both are correct for what they each measure.** `referrals.place_id` is stamped once
  at referral creation from the referring person's place *at that time* and never re-stamped
  (`routes/referrals.js`). `capacity.js`'s measured floor reads that frozen snapshot directly, so
  it stays attributed to whichever building actually generated the referral, per the spec's
  "capacity is a property of the building, not the contact" rule (§2/§14) - capacity describes the
  *building's* historical output, independent of who currently staffs it.
  `referralMetrics.js`'s place-level rollup (`referralMetricsByPlaceId`) instead joins on the
  contact's *current* place on purpose: a referral relationship lives with the *person*, not the
  building, so the displayed number should follow a strong referral source when they change jobs,
  and the place they left should stop getting credit for a relationship that's no longer there.
  This was scoped as a bug on 2026-08-07 by over-applying capacity's building-scoped reasoning to a
  metric it was never meant to govern - re-reviewed and closed 2026-08-10 (Bede's call) as working
  as intended. See §18's now-closed writeup. `referralMetrics.js`'s PERSON-level rollup was never
  in question either way - it has no notion of "place" in its query at all.

The temporary dual-write bridge (`routes/visits.js`'s `maybeCapturePreQualification` writing the
legacy `capacity_monthly_referrals`/`capacity_status` columns) that used to be documented here was
**removed 2026-08-07** once step 7 landed and was verified - nothing ranking-related reads those
two columns anymore, so there was nothing left for it to bridge to. See §18's "Step 7" subsection.

### 2026-08-25 - One "manually planned by {Name}" marker, not two

`RoutePlanner.jsx` and `PlannedDayModal.jsx` each rendered the manual-stop marker as two adjacent
pieces, which read as "manually planned planned by Bede Fulton" (Bede's own handwritten note). Both
now call one helper, `api.js`'s `manualPlanNote(visit)`, which returns the whole phrase - `manually
planned by {Name}` when the planner isn't the assignee, plain `manually planned` otherwise, `null`
when the visit wasn't manually planned. PlannedDayModal sentence-cases it (it follows a ` · ` break;
RoutePlanner's sits in a row of lowercase chips).

Centralizing it settled a disagreement the two views had: RoutePlanner compared the creator against
the **viewer**, PlannedDayModal against the **assignee**, so a stop one rep planned for another
named the planner in one view and not the other. Assignee is the rule now, which is what §21 already
documented. That comparison also needed `v.user_id`, which `scheduleDraft.js`'s
`committedVisitsQuery` had never selected (it's pinned by the where clause) - added, or the helper
would have compared against `undefined` and named the planner on every manual stop. `manualPlanNote`
also treats a missing `user_id` as "don't name anyone", so a query that forgets the column loses the
name rather than inventing an attribution.

### 2026-08-25 - "Nobody" no longer claims a drop-off

Meeting no one used to be recorded as `materials_only` ("Left materials only"), locked in by
`VisitLogModal.jsx` the moment 'nobody' was picked - so every locked-door, empty-desk trip went on
file asserting a drop-off that often hadn't happened. Bede raised it 2026-08-25: not meeting anyone
shouldn't force a claim that materials were left.

`MET_WITH_LABELS.nobody` is now plain `'Nobody'` (was `'Nobody - drop-off'`), and the forced
outcome became a two-option picker in `VisitLogModal.jsx` (`NOBODY_OUTCOME_LABELS`): **No one was
available** (`unavailable`, weight 0.15) or **Left materials only** (`materials_only`, 0.25). The
first is the seeded default - not meeting anyone is the claim being made, and the drop-off is now
the deliberate pick rather than the automatic one.

Both are ordinary `OUTCOMES` values, so nothing else had to learn a new one; only the wording is
local to the form, since `OUTCOME_LABELS.unavailable` ("They were unavailable") presupposes a "they"
the rep never named. Changing what gets STORED was the point, not just the copy: the visit detail
modal, the outcome chips and the Visits tab's outcome filter all render off that one value, so
relabelling the form alone would have left "Left materials only" showing on those visits everywhere
else. A no-contact encounter now weighs 0.05 x 0.15 rather than 0.05 x 0.25 - the settings page's
"about 0.01" illustration is still about right. No backfill: there were zero `nobody` encounters on
file when this changed.

The full outcome list stays OFF for nobody - "I met no one" can't produce a substantive
conversation - and the seeding effect deliberately does not clobber an outcome that's already valid
for the encounter, so a rep's pick (or an existing row's value, in edit mode) survives an unrelated
change to who was met.

### 2026-08-25 - A referral no longer requires the referrer to be at a place

`POST /api/referrals` used to 400 when the person had no `place_id`. It doesn't any more - only
`person_id` is required. That block was an inconsistency, not a guardrail: `POST /api/people` has
always made `place_id` optional, the People directory left-joins so unassigned people still render,
and detach-not-delete nulls a whole roster's `place_id` when a place is deleted - so a person can
go placeless with the rep doing nothing wrong. The refusal's only real effect was to push a field
rep into fake-assigning a plausible place (worse data than a null) or not logging the referral at
all. Real referral sources genuinely outside any building we visit - an elder-law attorney, a
fiduciary, a former client's family - now fit the model instead of having to be forced into it.

Two knock-on behaviours, both intended, both commented at `routes/referrals.js`'s POST: the PLACE
rollup heals itself (`referralMetricsByPlaceId` joins on the person's *current* place, so assigning
them somewhere later sweeps in every referral they logged while placeless), while the CAPACITY
measured floor never sees a null-snapshot referral at all, because it reads `referrals.place_id`
directly - the deliberate split described in the mental-model principles below and §18. That second
one is a one-directional, conservative under-count, and is deliberately NOT backfilled when the
person is later assigned a place: backfilling would mis-credit every job-changer, which is the exact
thing the snapshot exists to prevent.

### 2026-08-25 - Seven retired `places` columns dropped (new §25)

`tier`, `is_priority`, `priority_score`, `capacity_level`, `capacity_status`,
`capacity_monthly_referrals` and `relationship_level` are GONE (migration `20260825000000`). If
you're reading older code comments that describe any of them as "kept but frozen for one release,"
that release is over. This also closes `capacity-computation-spec.md`'s step 9.

`capacity_level` and `relationship_level` still appear in API responses - those are the COMPUTED
values, attached explicitly in `routes/places.js`. There is no column behind either name.

### 2026-08-24 - A third axis: all-star (new §24)

`places.is_all_star` marks the ~25 places that matter most and lifts a place ONE capacity row in
the cadence lookup and the exploration ordering. It exists because capacity is a pure COUNT and
`referrals` has no value/duration/payer column, so a low-volume, high-value source is structurally
invisible. **Read §24 before touching the cadence lookup or "simplifying" what looks like a
duplicate of the flag §23 just deleted.**

Two things that will otherwise mislead:

1. **This IS the ⭐ Priority flag, rebuilt one day after being retired, on purpose.** §24 lists the
   three things that killed the old one (no defined meaning, no consequence, no protected scarcity)
   and what replaces each. If any of them regress, so has this.
2. **It currently does nothing on Guardian Angels' data, and that's expected.** All 23 all-stars
   already read `high` capacity, and there's no row above `high`. An all-star that's already at the
   top is a normal case, not a broken backfill - the flag means "one of the most important," not
   "punches above its volume." Another agency's top 25 will include low-volume sources where the
   bump does real work.

### 2026-08-23 - Tier and ⭐ Priority are gone; capacity has a human rating (new §23)

`places.tier`/`is_priority`/`priority_score` are retired. Tier meant "how much business could this
place send us," which is capacity's own definition, so the judgment moved to
`places.capacity_seed` and now feeds the capacity axis instead of a tie-break almost nothing read.
`CAPACITY_THRESHOLDS` retuned 6/16 → 4/11 the same day. **Read §23 before touching capacity
resolution, the Places/Visits capacity filters, or anything that used to read tier.**

Three things that will otherwise look like bugs:

1. **46% of places changed capacity level** the day this shipped, and that's the point - 99.2% of
   them had been running on a keyword match against their category name. Level source
   `category_seed` went from 99.2% to 0%.
2. **The rating deliberately does not decay and deliberately never touches `confidence`** - unlike
   `relationship_seed`, which does both. Capacity is a rate, not a decaying quantity; §23 explains
   why decaying it would silently demote the whole book.
3. **`tier`/`is_priority`/`priority_score` columns still exist**, frozen and unread, pending a
   follow-up drop migration. `capacity_level` (the legacy column) is likewise still there and is
   deliberately *shadowed* by the computed level in API responses - never serve the stale one.

### 2026-08-10 - Visit terminal states: `snoozed` + `skipped` (new §19 at the bottom of this doc)

Every planned visit now resolves to exactly one of `completed`/`snoozed`/`skipped` - `skipped` is
a passive lapse (no cron; stamped by request-time middleware, see §19), `snoozed` is a deliberate
rep deferral (`POST /api/visits/:id/snooze`) that also suppresses the place via the previously-
dormant `places.snooze_until`, now finally visible on `PlaceDetail.jsx` with a way to lift it
early. **Read §19 before touching visit statuses, the skip sweep, or the snooze commitment
guard** - it also documents a deliberate decision (forced snooze leaves `next_visit_date`
untouched) that should not get "fixed" later, and the encounter invariant that made the old
`VisitDetailModal` delete-trip bug turn out to be unreachable rather than live.

**What this app is, in one line:** a CRM-ish tool for Guardian Angels Homecare's sales team
to plan visits to referral places, log who they talked to, and track referrals - built this
year in a series of same-day feature sessions directly with Bede (the owner/primary user).

**Where things stand right now:**
- The 2026-07-08 CRM-buildout session (Places CRUD, People tab, detach-not-delete
  semantics, a person-attributed referral system) and that same day's follow-up
  (relationship-temperature removal, replaced with objective **referral metrics** - §9) are
  both **committed and merged to `main`** (through `10cebf2`).
- **2026-07-09 was a polish session** on top of that: places can now be **edited** (not just
  created - `PlaceModal.jsx` doubles as create/edit now), visits got a **detail popup +
  edit + delete** (new `VisitDetailModal.jsx`), PersonDetail's notes/preferences/birthday
  became independently click-to-edit (matching the pattern PlaceDetail's notes already had),
  dates display as `M/D/YYYY` everywhere (`formatDate()` in `api.js`) instead of raw
  `YYYY-MM-DD`, and - the one genuinely new capability, not just polish - **places now get
  geocoded** (address → lat/lng) automatically via the free US Census geocoder, with a
  `npm run geocode` backfill script for the 261 existing places. See §5 and the new §9A for
  the full design. Five commits, all committed (`74ca2a1`…`cb706a8`).
- **2026-07-10 was another polish-plus-audit session, still UNCOMMITTED as of this
  writing** (check `git status`): `ReferralDetailModal.jsx` and `VisitDetailModal.jsx` both
  got a bottom-left **Delete** button; the Place-notes / Person-notes/preferences/birthday
  inline editors were all standardized to Delete-far-left / Cancel+Save-on-the-right (Save
  always the rightmost button), and starting an edit on any one of them (or taking any other
  action on the card - assign to place, log/view a referral or visit, open Edit) now backs
  out of whichever other field was mid-edit instead of leaving multiple drafts open;
  Person's preferences field became a resizable textarea (was a single-line input, now
  matches notes); `AssignPersonModal` got its default "browse everyone unassigned" list back
  alongside the existing search box. Then, at Bede's request, ran a 4-agent audit of the
  whole People/Places surface plus a route-planner-readiness assessment - **see §14A for two
  real data-integrity bugs found (not yet fixed) and §14B for the route-planner findings**,
  most notably that the geocoding backfill mentioned above **has now actually been run**
  (contradicts the still-stale-sounding wording elsewhere in this doc before this edit pass -
  see §9A/§13, now corrected).
- Don't start new feature work without first asking Bede whether to commit pending
  changes - he explicitly only wants commits when asked for.
- **2026-07-10's audit findings were fixed the same day** (`dc5d940`) - despite the
  "not yet fixed" wording that used to follow this bullet. Both data-integrity bugs (referral
  orphaning on person delete; visit-edit lockout when the linked person is deleted) are
  resolved. See the corrected §14A.
- **2026-07-11 through 2026-07-13:** route planner phases 1-4 built on branch
  `bede-routeplanner` - a four-tier scoring engine, a drive-time estimator + visit-type
  durations, and a multi-day draft generator (haversine-based, no real routing API yet at this
  point). Also dropped the unused `departed`/`is_primary` flags on people. 69 tests by the end
  of phase 4. Full detail in `ROUTEPLANNER_PROGRESS.md`, not here.
- **2026-07-14 was the biggest single day on this project so far:** phase 5 (real routing API
  via OSRM + stop-sequencing optimization, `84d32bf`); a full codebase audit at Bede's request
  that found and fixed **a real security leak** (`GET/POST /api/users` used to leak every
  user's password hash and live session token to any logged-in user) and **a live-breaking
  bug** in the scheduler actually in production use (a SQL `NOT IN` against a subquery that
  could contain NULL silently zeroed out route generation for everyone, forever, the first
  time any place was ever deleted) - `c408809`; phase 6's draft/commit lifecycle backend + API
  (`95049c7`); and the first two sub-slices of phase 6's frontend - a new "Plan My Visits" tab
  with generate + read-only view (`ce2f41f`), then live editing (reorder/add/remove/visit-type
  changes with in-place time recalculation and over-budget flagging). 139 tests. The old
  scheduler/"Today's Route" screen is still fully working and untouched throughout - it stays
  that way until the new workspace's frontend is complete enough to replace it. Full detail in
  `ROUTEPLANNER_PROGRESS.md` and `NOTES.md`'s 2026-07-14 entry, not here.
- **2026-07-15:** phase 6 frontend sub-slice 3 - suggestions (a "Suggest a stop" prompt on
  under-budget days, wired to the already-built `getSuggestions` endpoint) and commit (per-day
  and full, both confirm-gated, both wired to `commitDay`/`commitAll`). Verified live: a real
  suggestion was added, a day was committed (6 real `visits` rows), then the remaining days
  were committed (20 more) - 26 total, correctly shaped, 0 leftover draft stops. **This was the
  last piece of the new route-planner frontend** - the "Plan My Visits" workspace is now
  functionally complete end-to-end (generate → edit → suggest → commit). Same day, at Bede's
  request ("I want this code to be very clean"), **the old scheduler was fully retired**:
  `services/scheduler.js`, `routes/schedule.js`, `Schedule.jsx`, and the "Today's Route" tab
  all deleted, plus the Dashboard's old route card (a deliberate choice - full removal, not a
  slimmed-down read-only keep - confirmed with Bede) and every dead CSS rule/comment that only
  existed to support it. 139 tests still pass, client build succeeds, verified live with zero
  console errors. Full detail in `ROUTEPLANNER_PROGRESS.md` and `NOTES.md`'s 2026-07-15
  entries, not here.
- **Also 2026-07-15, same session:** with the workspace feature-complete, Bede started
  live-testing it and requesting real UX refinements as he went - a "Re-optimize" button per
  day (real-OSRM resequencing, gated by session-only client state that took two rounds of
  Bede's own live correction to get right - see `NOTES.md`/`ROUTEPLANNER_PROGRESS.md`), a
  "Discard plan" button (ownership-checked `DELETE /api/schedule-drafts/:id`, cascades
  cleanly), and moving each stop's individual time + the day's running total to be much more
  visually prominent. Two more rounds followed the same session: manual address entry made
  available up front (not just as a geolocation-failure fallback), and a read-only "Committed"
  section per day so a committed day doesn't just look empty. **Bede then explicitly asked to
  commit, push, and merge the whole batch into `main` via a PR** so his coworkers could access
  it - done same session. Expect this live-feedback pattern to continue in future sessions.
- **Later 2026-07-15, a separate session on branch `bede-working`:** a dedicated code-quality/
  bug-hunting pass, not route-planner feature work - Bede asked for a full-app review, then a
  much deeper "ultra" 6-parallel-agent pass on top of it. Regular pass fixed a critical
  `dashboard.js` bug (same `.whereNotIn()`-against-nullable-`place_id` class the 2026-07-14
  audit found once already in the old scheduler, recurred here) plus several smaller gaps
  (category-enum validation missing on the Needs Mapping create-place path, a `MAX_PLAN_DATES`
  off-by-one in the new calendar date picker, missing error handling/test coverage, dead code).
  The ultra pass found ~25 issues across 6 slices (route-planner engine, route-planner API/
  frontend, core CRUD routes/frontend, data-model/migration consistency, security); Bede picked
  7 to fix immediately, most notably a real TOCTOU double-booking race in `commitDay` (new
  partial-unique-index migration, scoped to `source = 'planner'` only), missing cross-user
  ownership checks on `visits.js`, a Postgres-only crash on non-numeric IDs invisible under
  local SQLite testing, and two more `dashboard.js` instances of the same nullable-FK bug class
  (via INNER JOIN this time) - see the corrected note in §14A. ~18 further ultra-pass findings
  were deliberately deferred, not fixed. 146 tests pass (up from 143), client build clean.
  **Committed, pushed, and merged into `main`** at the end of this session per Bede's explicit
  request - a direct git merge, not a GitHub PR, since `gh` wasn't available in this
  environment. Full detail in `NOTES.md`'s same-dated "Code-quality bug hunt" entry.
- **2026-07-22, branch `bede-working`:** picked up two threads - a "Plan My Visits" feature
  Bede had already started (reopening an already-committed day back into an editable draft,
  see `ROUTEPLANNER_PROGRESS.md`'s new entry), plus working through the ~18-item ultra-review
  backlog `NOTES.md`/§0 above deferred. Fixed: `POST /api/visits` wasn't validating `status`
  against its enum (only `PATCH` was); `places.js` never validated `tier` was 1/2/3 (PATCH
  could even let a place's stored `tier` diverge from the `priority_score` derived from it -
  now the coerced numeric value is what's written, not the raw body value); the fully-orphaned
  `visits.skip_reason` column was dropped (new migration) along with the dead
  `POST /api/visits/:id/skip` route and `api.skipVisit()` client fn - the whole "skip a stop"
  concept was a leftover from the retired `Schedule.jsx`, never rebuilt in the new workspace,
  `status: 'skipped'` itself is unaffected and still fully supported via the regular `PATCH`;
  every currently-passwordless user got backfilled to a real default password (`Angels#1`, new
  migration) as a stopgap for the pre-auth account-takeover window (`GET /auth/users`/
  `POST /auth/set-password` still aren't behind `requireAuth` and can't be - Bede's still
  designing a real login-page overhaul, this just closes the "claim someone else's account
  before they ever log in" window for accounts that exist today, not future ones); the
  `PersonModal.jsx`/`PlaceModal.jsx` stuck-Save bug (network failure during the duplicate/
  address pre-check used to leave Save disabled forever) fixed via a new shared
  `usePreSaveCheck` helper so the two forms' error handling can't drift apart again; Dashboard's
  embedded place-delete now refreshes the Dashboard (`onDeleted={load}`, matching Places.jsx/
  People.jsx); `PersonDetail.jsx`'s `exitFieldEdits()` now also closes the "assign to a place"
  picker; `assignToPlace()` got an in-flight guard matching the rest of that file's save
  handlers; `useDuplicateMatches`'s effect now depends on `search` (its one caller,
  `NeedsMapping.jsx`, had to get its own `search` callback wrapped in `useCallback` first, or
  the fix would've caused a refetch on every unrelated keystroke in that modal); the long-open
  Needs Mapping geocoding gap (§14A) is closed - `notesReview.js`'s `POST /:id/create-place`
  now calls `geocodeAddress()` the same way `routes/places.js`'s create route does, best-effort
  and non-blocking, so places created from that flow no longer silently skip lat/lng. Also
  cleaned up a few stale/imprecise comments in `scheduleDraft.js` (`committedVisitsQuery`,
  `removeStop`) that still described pre-reopen-feature behavior (implied a partial commit
  could leave both a committed visit and a draft stop for the same day - no longer possible now
  that `commitDay` always commits/clears a full day and drops it from `params.days`) - no
  behavior change, just brought the comments back in line with the code. Two items were
  deliberately left for Bede to scope later: `visits.skip_reason`'s wider "skip a stop" concept
  could be rebuilt as a real feature (declined - cleanup only, per above) and the remaining
  ~9 unbuilt scheduling-field API surface / `visit_type`-not-patchable capability gaps (see
  §14A's "still open" notes) haven't been touched. 146 tests pass, client build clean
  throughout. **Pushed and merged into `main`** later the same session (2026-07-22), along
  with everything else below through the visit-type-default bullet - a fast-forward merge
  (direct `git merge`, `gh` unavailable in this environment, same as 2026-07-15's precedent),
  at Bede's explicit request.
- **Also 2026-07-22, same session, a UI/UX request from Bede:** the route planner's "enter
  address manually" start-location form (4 separate street/city/state/zip fields + a "Use this
  address" button, geocoded one-shot via the free Census API) was replaced with a single
  Google-Maps-search-style box - type freely, pick a live suggestion, done, no separate lookup
  step. New dependency: `@mapbox/search-js-react`'s `SearchBox` component, wrapped in
  `client/src/components/ui/AddressAutocomplete.jsx` and themed to match this app's existing
  inputs/dropdowns (colors/radius/shadow copied from `styles.css`'s design tokens, since the
  component is a custom element and can't read the app's own CSS classes directly), biased
  toward Lincoln, NE via a `proximity` option. Needs a free Mapbox access token in
  `client/.env` (`VITE_MAPBOX_TOKEN`, see `client/.env.example`) - Bede has one now; the
  component shows a small inline notice instead of failing silently if it's ever missing.
  This made the old single-shot `POST /api/geocode` route (and `api.geocode()` client fn)
  genuinely dead code - both deleted, along with the manual-entry-specific state/handler in
  `PlanVisits.jsx` (`manualAddress`, `geocoding`, `lookUpManualAddress`) they existed for. The
  Census geocoder itself (`services/geocoding.js`) is untouched and still does all of the
  place-address geocoding described in §9A - this only replaced the router's own
  start-of-day-location entry point, a different use case (live suggestions while typing vs.
  one-shot resolve-a-complete-address). Verified live end-to-end (typed a Lincoln address, got
  real suggestions, selected one, start location set correctly) via a temporary Lisa Marks
  smoke-test token, cleared after. 146 tests pass, client build clean. Not yet
  pushed/merged.
- **Also 2026-07-22, four more live-feedback rounds on "Plan My Visits":** (1) the per-date
  budget picker now does hours **and** minutes (two selects grouped in one `.duration-picker`
  pill) instead of whole hours only - needed zero backend changes, `hoursPerDay` was already a
  decimal on the wire. (2) Clicking a proposed stop now opens its full `PlaceDetail` (reused
  as-is - same modal Places/People/Dashboard already use) so a rep can check capacity/notes/
  history before picking a visit type; `PlanVisits.jsx` gained a `userId` prop (threaded from
  `App.jsx`, same as the other tabs) since `PlaceDetail` needs it downstream. (3) Two rounds of
  hover-highlight polish on that same stop row: made the highlight cover the whole row (`:has()`
  off `.main`'s hover state, not just `.main`'s own box) while excluding the visit-type select
  and reorder/remove buttons, then made it instant instead of partially-fading (the shared
  `.hover-row` transition only animated one of the two now-overlapping background layers).
  (4) `config/visitTypes.js`'s `DEFAULT_VISIT_TYPE` changed from `working_visit` (30 min) to
  `drop_in` (7 min) - flagged to Bede as a real behavior change, not cosmetic: every one of the
  262 real places has `default_visit_type: NULL`, so all of them ride this fallback, and it's
  the actual per-stop duration the planner budgets, not just a dropdown's initial value (a test
  4-hour day went from packing 6 stops to 12). Two `scheduleGenerator.test.js` tests that
  encoded the old 30-minute assumption in a tight-budget scenario got their specific place
  fixtures pinned to `working_visit` explicitly, so they test what they're supposed to
  regardless of the global default. 146 tests pass (2 fixed), client build clean. Full detail
  in `NOTES.md`'s matching 2026-07-22 entry.
- **2026-07-23, still on `bede-working`:** several live-feedback rounds on the proposed-stop
  row's layout in "Plan My Visits" (ending at: name+category+tier pills on one line, address
  below, fixed-width visit-type select + fixed-width estimated time + remove button on the
  right - a real alignment bug along the way, where a longer visit-type label was shifting
  every row's dropdown left by a few px, fixed by giving both the time display and the select a
  fixed width instead of content-driven sizing). Then a new feature: "Already Planned" days are
  now a click-through drill-down (`PlannedDayModal.jsx`) instead of exposing Edit/Delete
  directly on the row - the modal lists that day's actual visits (clickable into full
  `PlaceDetail`) with Edit/Delete moved into its footer, matching the Place/Person modal
  convention. New backend read (`scheduleDraft.committedDayVisits` + `GET /api/schedule-drafts/
  committed-dates/:date/visits`). 146 tests pass, client build clean. Full detail in
  `NOTES.md`'s and `ROUTEPLANNER_PROGRESS.md`'s matching 2026-07-23 entries.

**Mental model you need before touching this codebase:**
1. **Detach, don't delete.** Places, people, and visits are designed so deleting one thing
   never destroys another's history. If you're tempted to `CASCADE` a foreign key, stop and
   re-read §8 - that's almost certainly the wrong call here.
2. **Referrals belong to a person, never a place.** A place's referral metrics are *always*
   derived live (rolled up from its current roster's own numbers), never stored. If you see
   a bug where a place's numbers don't match expectations, check who's currently assigned
   there first, not the referrals table's own `place_id`-shaped assumptions (`place_id` on
   `referrals` is just a historical snapshot, not the source of truth for a place's total). A
   referral doesn't even need a place - only a person. Logging one for someone with no `place_id`
   is allowed and stamps a null snapshot (2026-08-25, see the dated entry near the top).
3. **No more manual "smart" fields that need upkeep.** The old house style was
   suggested-but-not-applied (compute a suggestion, show it next to a manual value, let the
   user opt in) - that's how relationship temperature worked. It was replaced because the
   manual field it suggested against never actually got kept up to date. The new standard
   for anything like this is **fully computed, no manual field at all** (see referral
   metrics in §9) - prefer that shape for future "smart" fields unless there's a real reason
   a human needs to be able to override it.
4. **SQLite migrations in this repo need care**, not `.alter()` for FK-bearing columns.
   Adding/changing a FK on an existing column with `.alter()` leaves duplicate FKs, and
   index names collide database-wide across rebuild attempts. Use the
   `rebuildSqliteTable`-style rebuild pattern established in
   `20260709000000_detach_instead_of_cascade.js` (temp table → copy via raw INSERT SELECT →
   drop → rename, explicit index names, defensive `DROP INDEX IF EXISTS`) for that case.
   Dropping/adding a plain non-FK column (no rebuild needed) is simpler - see
   `20260710000000_drop_relationship_temp.js` or `20260711000000_add_geocoded_at_to_places.js`
   for that pattern instead.
5. **Smoke-test safely** (§10) - passwordless user Lisa Marks (id 5) for temp auth tokens,
   `__SMOKETEST_`/`__E2E_` prefixes, clean up after, and never touch Bede's own real test
   data (place 264 "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar
   Jr.). Never set a password on a real user's account to get a token - that happened once
   this project and it was a mistake (see §10, and again briefly on 2026-07-08 - don't repeat
   that shortcut either).
6. **Geocoding is best-effort and non-blocking.** `services/geocoding.js`'s
   `geocodeAddress()` returns `null` on any failure (bad address, network error, no match) -
   creating/editing a place must never fail or hang because the Census API is slow or down.
   If you touch this, keep that contract.

**Natural next steps Bede has flagged but not yet asked for** (don't just do these - check
first): feeding referral metrics into priority scoring (the natural successor to the old
"Phase 2 relationship-temp" idea) - see §14's note on `needs_attention` having been removed
app-wide 2026-07-24; the underlying `referral_metrics` numbers (lifetime/last/90-day) are
still live and usable here, just not that specific flag.

**If something in this note contradicts the actual code** (a file's gone, a function's
renamed), trust the code - this note is a snapshot from one point in time, not a live source
of truth. Update it once you've re-verified, the same way this section itself was written.

---

## 1. What this is

A full-stack **sales visit scheduling app** for **Guardian Angels Homecare** (Lincoln, NE).
It helps a small team plan and log referral-place sales visits, and it holds 2 years of
historical notes as place history.

**Location on disk:** `/Users/bedefulton/guardian-angels-sales`
**GitHub:** private repo `guardian-angels-sales` (source of truth)

---

## 2. Tech stack

- **Backend:** Node.js + Express, **Knex** query builder
- **Database:** SQLite locally (`better-sqlite3`), **PostgreSQL** in production - swap is
  config-only via `server/knexfile.js` (all data access goes through Knex, no query changes)
- **Frontend:** React + Vite (plain CSS, no UI framework)
- **Deploy target:** Railway (also Heroku-compatible)

### ⚠️ Environment gotcha (important)
Node is **not on the default PATH** on this Mac - it's installed via **nvm** at
`~/.nvm/versions/node/v24.18.0`. If `node: command not found`, run `nvm use 24` first,
or use the helper `./dev.sh` which sets PATH automatically.

---

## 3. Directory structure

```
guardian-angels-sales/
├── Guardian Angels Sales List.xlsx   # place source data (sheet "📋 Visit Tracker", header row 2)
├── ReferrerNotes.xlsx                # 2 years of notes (Referrer, Time, Administrator, Note)
├── dev.sh                            # starts backend + frontend together (handles nvm PATH)
├── package.json                      # root: build/start scripts for cloud deploy
├── Procfile                          # web: npm start
├── railway.json                      # pins builder=NIXPACKS, build/start commands
├── README.md
├── HANDOFF.md                        # (this file)
├── SETTINGS_PAGE.md                  # the tunable-constants Settings page, in full (see §21)
├── capacity-computation-spec.md      # the computed-capacity model (see §18)
├── ROUTEPLANNER_PROGRESS.md          # route-planner build log
├── server/
│   ├── knexfile.js                   # SQLite (dev) vs Postgres (prod) selection
│   ├── .env / .env.example
│   └── src/
│       ├── index.js                  # Express app; runs migrations + auto-seeds on boot in prod
│       ├── db/knex.js
│       ├── middleware/               # requireAuth (bearer token)
│       ├── migrations/               # init, add_auth, places_and_people,
│       │                             # rename_partners_to_places, people_and_place_notes,
│       │                             # detach_instead_of_cascade, drop_relationship_temp,
│       │                             # drop_departed_and_is_primary, add_scheduling_fields,
│       │                             # add_default_visit_type_to_places,
│       │                             # add_schedule_drafts (+ _stops), add_categories_table,
│       │                             # drop_notes_review
│       ├── config/                   # the DEFAULT value of every tunable constant. Overrides
│       │                             # now live in the `settings` table and are written into
│       │                             # these objects at boot - see SETTINGS_PAGE.md:
│       │                             # scheduling.js, driveTime.js, visitTypes.js,
│       │                             # routeOptimizer.js, relationship.js, planning.js,
│       │                             # referrals.js, plus tunables.js (the registry: what each
│       │                             # one MEANS - label, help, bounds, legal values).
│       │                             # (places.category is a DB table, see routes/categories.js)
│       ├── services/
│       │   ├── priority.js           # priority score + region ("side of town") helpers
│       │   ├── schedulingEngine.js   # route planner: four-tier scoring/eligibility
│       │   ├── driveTime.js          # haversine estimate + real-OSRM-backed time-block packing
│       │   ├── scheduleGenerator.js  # multi-day draft generator (generateDraft())
│       │   ├── routeOptimizer.js     # OSRM /trip + /route calls (the one I/O-having pure-ish module)
│       │   ├── scheduleDraft.js      # draft CRUD, live recalc, commit - the DB orchestration layer
│       │   ├── auth.js               # password hashing / token helpers
│       │   ├── phone.js              # phone validation + (402) 555-1234 normalization
│       │   ├── referralMetrics.js    # lifetime/last/recent-window referral metrics
│       │   ├── relationship.js      # computed relationship strength (person -> place rollup)
│       │   ├── capacity.js          # computed capacity (declared / measured floor / category seed)
│       │   ├── settings.js          # loads tunable overrides onto config/*.js; save/reset/validate
│       │   ├── geocoding.js          # geocodeAddress() - address -> {lat, lng} via US Census
│       │   └── fetchWithTimeout.js   # shared AbortController+setTimeout wrapper (OSRM, geocoding)
│       ├── routes/                   # auth, places, people, referrals, visits,
│       │                             # scheduleDrafts (route planner), dashboard,
│       │                             # users, categories, settings
│       └── scripts/
│           ├── import-excel.js       # importPlaces() - place list
│           └── geocode-places.js     # geocodePlaces() - backfills lat/lng for ungeocoded places
└── client/
    ├── vite.config.js                # dev proxy /api -> :4000
    └── src/
        ├── App.jsx                   # tabs: Dashboard, Route Planner, Calendar, Places,
        │                              # People (+ the header gear -> Settings, not a tab)
        ├── hooks/useTunables.js      # cached read of the tunables other screens must respect
        ├── api.js                    # incl. formatDate() - YYYY-MM-DD -> M/D/YYYY for display
        ├── styles.css
        └── components/
            ├── Login.jsx, ChangePassword.jsx
            ├── Dashboard.jsx
            ├── RoutePlanner.jsx                     # route-planner workspace ("Route Planner" tab)
            ├── Places.jsx, PlaceDetail.jsx, PlaceModal.jsx      # PlaceModal: create AND edit
            ├── People.jsx, PersonDetail.jsx, PersonModal.jsx, AssignPersonModal.jsx
            ├── ReferralModal.jsx, ReferralDetailModal.jsx
            ├── VisitLogModal.jsx, VisitDetailModal.jsx, CategoriesModal.jsx
            ├── Settings.jsx                          # every tunable constant, explained
            └── ui/                    # Button, Chip, EmptyState, PhoneInput, PlacePicker, ...
```

---

## 4. Data model (tables)

- **users** - team members (`id, name, email, password_hash, auth_token`). Current: **Bede
  Fulton, Nikki Shasserre, Lisa Marks, Basil Fulton**. Auth is a simple bearer token stored
  directly on the user row (`server/src/routes/auth.js` + `services/auth.js`).
- **places** - referral organizations (`name, category, tier 1/2/3, is_priority,
  priority_score, address, city, state, zip, region, phone, notes`, plus route-planner fields
  added 2026-07-10/13: `capacity_level`/`capacity_monthly_referrals`/`capacity_status`/
  `relationship_level`/`snooze_until`/`do_not_visit`/`default_visit_type`; `do_not_visit_until`
  added 2026-08-10 (see §19A); `current_agency_used`/`has_inhouse_service` were dropped
  2026-08-10 - see `capacity-computation-spec.md` §10). `category` is now a locked enum
  (`config/categories.js`), not free text (2026-07-14). Originally imported from Excel
  (261 rows), now a full CRUD directory - add/edit/delete from the UI. Deleting a place
  deletes only that row; see section 8 for what happens to its people/visits.
- **people** - individual contacts (`place_id` nullable, `name, title, role_type, email,
  phone, preferences, notes, birthday`). Renamed from "contacts" the session before last. A
  person doesn't have to belong to a place, mirroring how a place doesn't need a person on
  file. (No `relationship_temp` column - dropped by `20260710000000_drop_relationship_temp.js`;
  see §9. No `departed`/`is_primary` either - dropped 2026-07-11, neither was ever really used.)
- **schedule_drafts** / **schedule_draft_stops** - the new route planner's draft/commit
  lifecycle (added 2026-07-14). A stop's presence in `schedule_draft_stops` IS the draft - no
  soft-delete status, no stored running-totals (recomputed live on every read, same convention
  as referral metrics). `visits` also gained a nullable `visit_type` the same day, so a draft's
  visit-type choice has somewhere to land at commit. See `ROUTEPLANNER_PROGRESS.md` for the
  full schema/design - not duplicated here.
- **visits** - one planned/completed/skipped TRIP by a user to a place on a date. Fields:
  `status, sort_order, notes, next_visit_date, actual_duration_minutes, visit_type, source,
  completed_at`, plus the `place_name` **snapshot** captured at creation time so a visit stays
  readable after the live place is deleted. `source` = `manual` (in-app) or `imported_note`.
  **Restructured 2026-08-05 (§17)** - who was met moved out to `visit_encounters`.
- **visit_encounters** - one row per person/category met on a trip (`visit_id` FK
  `ON DELETE CASCADE`, `person_id` FK `ON DELETE SET NULL`, the `person_name/title/email/phone`
  snapshot, `met_with_type, outcome, they_requested`). A trip where a rep met a named contact
  AND got gatekept by the front desk is one `visits` row with two encounters. A partial unique
  index `(visit_id, person_id) WHERE person_id IS NOT NULL` stops the same person being
  recorded twice on one trip. A still-`planned` visit legitimately has ZERO encounters. See §17.
- **referrals** - one referral, attributed to a `person_id` plus a `place_id` snapshot (both
  `ON DELETE SET NULL` - a referral outlives the person/place it came from, orphaned but
  preserved), with `referral_date` and `notes`. `place_id` can also be null from birth: the
  referrer doesn't have to be assigned to a place at all (2026-08-25). Nothing about relationship strength is
  stored anywhere: `services/referralMetrics.js` derives lifetime count / last referral date
  / last-90-days count / a `needs_attention` flag live from this table, for both people and
  places, on every read (see section 9). **Known gap (§14A #1):** unlike `visits`, this table
  has no name-snapshot columns, so once `person_id` nulls out the referral is unattributed and
  drops out of every metric even though the row itself still exists.
- **categories** - the canonical, admin-editable list of place categories (`id, name`).
  `places.category` is validated against it. Managed via `routes/categories.js` and
  `CategoriesModal.jsx` (add/rename/retire - see §13's 2026-07-27 bullet).

---

## 5. Key features (all built & working)

- **Auth** - pick your name, set a password on first use, bearer token thereafter. All
  `/api` routes except the login flow require `requireAuth`.
- **Import places** from Excel (idempotent upsert). Normalizes category typos
  (`Legal and Trust`→`Legal & Trust`, `Senior Adisors`→`Senior Advisors`).
- **Route Planner (tab)** - four-tier priority scoring (commitments >
  endangered/rescue > exploration > maintenance), real drive-time via OSRM with
  stop-sequencing optimization, a multi-day draft you generate once and then edit live
  (reorder/add/remove/change visit type, with in-place time recalculation and over-budget
  flagging - nothing auto-drops or auto-reshuffles), a "suggest a stop" prompt on
  under-budget days, and commit (per-day or all) to turn draft stops into real `visits` rows
  with multi-user collision protection. This is the app's only route-planning surface - the
  old single-day scheduler ("Today's Route" tab) was retired 2026-07-15, see
  `ROUTEPLANNER_PROGRESS.md` for the full build.
- **Visit logging** - outcome (interested / not_ready / follow_up / no_answer), notes,
  key contact (name/title/email/phone), next visit date. Phone numbers are normalized to
  `(402) 555-1234` at every entry point (`services/phone.js` + `ui/PhoneInput.jsx`).
- **Places tab** - full CRUD directory: search + filter (category, tier, city, zip,
  never-visited); each row shows last **completed** visit, a preview contact, and the
  place's live referral tally (Contact column was removed once phone/email moved into
  PlaceDetail itself).
- **People tab** - cross-place directory of every person, independent of place assignment;
  filter by place, category, needs-attention (referred before, quiet the last 90 days),
  never-contacted.
- **Place detail** - editable core fields via an **Edit** button (`PlaceModal.jsx` doubles as
  create/edit, added 2026-07-09 - there was previously no way to fix a typo'd address short
  of delete + recreate); org-level notes (click-to-edit, standardized Delete/Cancel/Save
  layout - see below); "People here" roster showing name + each person's own referral
  metrics (lifetime / last referral date / last 90 days) + a "Cooling" flag for anyone who
  needs attention; **Assign person** - `AssignPersonModal` shows a default list of every
  currently-unassigned person plus the existing debounced search-everyone box (the default
  list was restored 2026-07-10 after being dropped in an earlier pass) - vs **New person**
  (create one for this place) vs detach (✕, ghost-styled, removes from place without
  deleting); **Log a referral** and **Log a visit** live in the People/Visit History sections
  respectively, not a generic modal footer.
- **Person detail** - phone/email shown as real text in its own panel (not just Call/Email
  buttons); place assignment with "remove from place" / "assign to a place" (clicking the
  place row itself now navigates there); notes/preferences/birthday each independently
  click-to-edit (2026-07-09 - previously one static all-or-nothing block; preferences became
  a resizable textarea on 2026-07-10, was a single-line input); referral log with
  lifetime/last-referral/last-90-days metrics, a "needs attention" badge, and "Log a
  referral"; full visit history.
- **Inline field editors - standardized layout (2026-07-10).** Place notes and Person
  notes/preferences/birthday all now show the same button arrangement while editing:
  **Delete** far left (only rendered once there's a saved value to delete), **Cancel** and
  **Save** grouped on the right with Save always the rightmost button. Labels changed from
  "Remove" to "Delete" for consistency with the visit/referral detail popups below. Opening
  any one of these fields for editing - or taking any other action on the card at all
  (assign to a place, log/view a referral or visit, click Edit) - now backs out of whichever
  other field was mid-edit, the same way a backdrop click already did; see
  `exitFieldEdits()`/`beginEdit*()` in `PersonDetail.jsx` and the inline `setEditingNotes(false)`
  calls threaded through `PlaceDetail.jsx`'s other action handlers.
- **Visit detail popup** - click any visit row (either detail page) to open `VisitDetailModal`:
  status/outcome chips, logged-by rep, full contact snapshot, notes, next-visit date, an Edit
  button (opens `VisitLogModal` pre-filled to PATCH), and a bottom-left **Delete** button.
  Added 2026-07-09 (delete button added 2026-07-10) so the inline visit-history rows could be
  trimmed down to date + who/where + a notes preview.
- **Referral detail popup** - same pattern as the visit detail popup: click a referral row
  (either detail page) to open `ReferralDetailModal` - full note, an Edit button into
  `ReferralModal`, and a bottom-left **Delete** button (added 2026-07-10).
- **Referrals** - always logged against a specific person (no "unknown contact" concept - an
  earlier draft had one, replaced per the user's revision - see section 8).
- **Referral metrics ("needs attention")** - see section 9. Fully computed, no manual field;
  replaced the earlier manual relationship-temperature system.
- **Geocoding** - see section 9A. Every place's address is auto-resolved to lat/lng on
  create/update via the free US Census geocoder; `npm run geocode` backfills existing rows.
- **Dashboard** - visits completed this week, high-priority never-visited, needs-attention rollup.
- **Multi-user** - visits assigned to a team member; the route planner avoids double-booking a
  place across reps on the same day (see the collision handling in `scheduleDraft.js`).
- **Categories are a real, admin-editable table** - see §13's 2026-07-27 bullet. (Section 7
  below, "Historical notes import," describes a feature that was fully removed 2026-07-27 -
  kept only as historical record, not current state.)
- **Dates display as `M/D/YYYY`** everywhere in the UI (`formatDate()` in `client/src/api.js`,
  added 2026-07-09) - storage/query format is still `'YYYY-MM-DD'` throughout, this is
  display-only. Don't use `formatDate()`'s output for an `<input type="date">` value.

### Priority scoring (see `services/priority.js`)
`Tier 1 + ⭐ Priority` = 35 · `Tier 1` = 30 · `Tier 2` = 20 · `Tier 3` = 10. Higher = sooner.

---

## 6. Key decisions & conventions

- **Knex everywhere** so SQLite→Postgres is a config swap only.
- **Dates stored as `'YYYY-MM-DD'` strings** for SQLite/Postgres parity.
- **"Visited" = has a *completed* visit.** Last-visit-date and "never visited" ignore
  merely-planned visits.
- **Notes are stored as visits** (one unified history timeline per place), marked
  `source='imported_note'`, rather than a separate notes concept.
- **User asked (design decisions):** only import notes whose referrer cleanly matches a
  place; park everything else (including individual people's names) in a review bucket
  to map by hand - do **not** auto-create places.
- Note author `"Nicole Shasserre"` in the sheet maps to the user **"Nikki Shasserre"**.
- **Detach, don't cascade-delete** (see section 8) - this is the single biggest schema
  decision made this session and touches places, people, visits, and referrals.
- **A referral's "owner" is a person, full stop.** No place-only/unattributed referral
  concept - the user explicitly asked for that to be removed after an earlier draft
  included it. A place's metrics are *derived*, never stored, from its current roster.
- **No manual relationship-temperature field anymore.** It was a manual `hot/warm/cold/
  dormant` field with a server-computed *suggestion* alongside it (compute, display, let
  the user opt in with "Use this," never auto-overwrite - a reasonable pattern in the
  abstract, kept here as a note in case a future "smart suggestion" feature wants it) - but
  the manual field itself just never got kept up to date in practice. The user asked for it
  to be replaced outright with objective, always-current referral metrics computed live
  from the `referrals` table - nothing to set, nothing to go stale. See section 9.

---

## 7. Historical notes import (ReferrerNotes.xlsx) - REMOVED 2026-07-27, history only

**This entire feature (the `import:notes` script, the `notes_review` table, the `notesReview.js`
API, and the "Needs Mapping" tab) was deleted 2026-07-27 at Bede's explicit request - no trace
left in the running app.** He's planning a from-scratch replacement later; don't resurrect this
version. See §13's 2026-07-27 bullet for exactly what was removed. The rest of this section is
kept only as a record of what the feature originally did, not as current state.

343 note rows, authors: Nikki (237), Bede (81), Lisa (25). Run via `npm run import:notes`
(idempotent). Latest result:
- **226 notes** matched a place → imported as completed history visits (attributed to author).
- **110 notes / 77 referrers** unmatched → **Needs Mapping** tab.
- 3 duplicate + 4 blank-referrer rows skipped.

**Needs Mapping tab** (with count badge): each unmatched referrer grouped with its notes.
Per referrer you can **assign to an existing place** (searchable picker), **create a new
place**, or **set aside** - action applies to all of that referrer's notes. Assigning
converts the note(s) into visits on the chosen place.

---

## 8. Detach-not-delete + the referral model

This was the biggest schema/behavior change this session, driven by the user wanting to
never lose history when a place or person is removed.

- **Delete a place** → the place row is gone; everyone who was there gets `place_id = null`
  (detached, not deleted - `ON DELETE SET NULL`); every visit logged there survives, with
  `visits.place_name` snapshotted at creation time so it still reads correctly even though
  the live place is gone.
- **Delete a person** → same idea: their visits survive via `visits.person_name/title/
  email/phone` snapshots.
- **Remove a person from a place** (without deleting them) → `PATCH /api/people/:id` with
  `place_id: null`. Available both from PlaceDetail's roster (✕ button) and PersonDetail's
  own "Remove from place" button.
- **A person doesn't need a place, and a place doesn't need a person** - creating either
  never requires the other.
- **PlaceDetail's two "add a person" actions are deliberately different**: **Assign person**
  (`AssignPersonModal.jsx`) picks from existing/unassigned people and attaches them;
  **New person** creates a brand-new record for this place. (Originally both called "Add
  person" - renamed to "Assign person" partway through per the user's request, along with
  the component/handler naming.)
- **Referrals belong to a person, not a place.** `POST /api/referrals` always takes a
  `person_id`. An earlier draft of this feature let a referral be logged with no contact
  ("unknown contact / attribute to location only") and rolled that into the place's total -
  the user later asked for that concept to be removed entirely, so every referral is now
  always attributed to a specific person, full stop.
- **A place's referral metrics are always computed live**, not stored: `GET /api/places/:id`
  rolls up each person's own `referral_metrics` (via `referralMetricsByPersonId` in
  `services/referralMetrics.js`) across the people *currently* assigned there
  (`server/src/routes/places.js`'s `peopleWithMetrics`/`referralMetrics`) - lifetime and
  last-90-days sum across the roster, last-referral-date is whichever person's is most
  recent. Remove someone from the place and its numbers drop immediately, even though their
  own metrics (visible on their own PersonDetail) are untouched. The list endpoint
  (`GET /api/places`) uses a separate batched query, `referralMetricsByPlaceId`, that joins
  straight through to each place for the same numbers without N+1 requests - see §9.
- Referral UI lives in two places: **PlaceDetail** (metrics badge(s) up top next to
  category/tier, "Log a referral" button next to Navigate/Call - moved there from a less
  prominent spot per the user's request) and **PersonDetail** (its own referral log +
  lifetime/last/90-day metrics + "Log a referral" button).

---

## 9. Referral metrics - the replacement for relationship temperature

**This entire section replaces what used to be here.** The old design (a manual
`relationship_temp` field - `hot > warm > cold > dormant` - plus a server-computed
*suggestion* alongside it, shown but never auto-applied) is gone: no column, no service, no
UI. It was removed because the manual field it suggested against never got kept current in
practice - a suggestion next to a stale manual value doesn't help if nobody's updating the
manual value. The replacement is **fully computed, no manual field, nothing to forget to
update**.

- **The three numbers**, per person and (rolled up) per place, computed live from the
  `referrals` table by `server/src/services/referralMetrics.js`:
  - `lifetime_referrals` - total referral rows attributed to them, ever.
  - `last_referral_date` - the most recent `referral_date` on file, or `null` ("none yet").
  - `referrals_last_90_days` - how many landed in the trailing 90-day window
    (`RECENT_WINDOW_DAYS = 90`; cutoff computed against wall-clock "now," not the dashboard's
    `date` query param, except in the one dashboard query described below).
- **The flag:** `needs_attention` - `true` only when `lifetime_referrals > 0 &&
  referrals_last_90_days === 0`. A brand-new contact/place with zero lifetime referrals
  reads as "none yet," never as needing attention - only someone who's referred before and
  then gone quiet gets flagged. This is the load-bearing edge case the whole feature was
  built around; don't collapse the "zero ever" and "zero recently" cases into one check.
- **Three ways to get the numbers**, all in `referralMetrics.js`, pick based on context:
  - `referralMetricsByPersonId(knex, personIds)` - one batched query, `person_id -> metrics`,
    for a list of people (People-tab directory, a place's roster).
  - `referralMetricsByPlaceId(knex, placeIds)` - one batched query joined through each
    place's *current* people, `place_id -> metrics` (same "live membership, not the
    referral's own `place_id` snapshot" rule the old `referral_total` used) - for the Places
    directory list, so it doesn't need N+1 requests.
  - `summarizeReferralDates(dates)` - pure JS reduction over a `referral_date[]` you already
    have in hand (e.g. `GET /api/people/:id` already fetched its own `referrals` array - no
    second query needed).
  - A place's own detail rollup (`GET /api/places/:id`) is a fourth path: it sums each
    *already-fetched* person's `referral_metrics` in JS (lifetime/last-90 sum, last-referral
    is whichever person's is most recent) rather than a separate query - see `metricsFor`/
    `EMPTY_METRICS` in the same file for the shared reduce-to-map helper.
- **Wired into:** `GET /api/people` (list) and `GET /api/people/:id`; `GET /api/places`
  (list) and `GET /api/places/:id` (place rollup + per-person breakdown); `GET /api/dashboard`
  (`needs_attention.cooling_people` - people who've referred before but nothing in the last
  90 days, replacing the old dormant/cold temperature query). `needsAttention=1` is a filter
  param on both `/api/people` and `/api/places` list endpoints (applied in JS after the
  batched metrics query, not pushed into SQL - fine at this data scale).
- **UI:** `client/src/styles.css` has one small reusable class for this, `.badge.attention`
  (mauve tint, same token family as the old temperature dot's "hot" color) - used for the
  "Cooling - needs attention" / "Needs attention" badges in `PersonDetail.jsx`,
  `PlaceDetail.jsx`, `People.jsx`, and `Places.jsx`, plus a plain `.attention-flag` row style
  reused as-is in `Dashboard.jsx`'s "Needs attention" list (that class predates this feature
  and was already the house style for flagged rows). `PersonDetail`/`PlaceDetail` show all
  three numbers as text (`"Last referral: 2026-03-30 · 0 in the last 90 days"`); `People.jsx`/
  `Places.jsx` show lifetime count + a badge in their directory tables; both tabs also have a
  "Needs attention" toggle button next to their existing "Never contacted"/"Never visited"
  buttons.
- **Migration:** `server/src/migrations/20260710000000_drop_relationship_temp.js` drops the
  column and its index. Simple `t.dropColumn()` after an explicit `DROP INDEX IF EXISTS` -
  no `rebuildSqliteTable` needed since there's no FK on this column (see mental-model point 4
  above for when you *do* need the heavier rebuild pattern).

---

## 9A. Geocoding - address → lat/lng (added 2026-07-09)

Places have had unused `lat`/`lng` columns since the original places/people schema (meant for
future routing use, never populated). This session actually populated them.

- **`server/src/services/geocoding.js`** - the whole provider surface is one function,
  `geocodeAddress({ address, city, state, zip })`, against the **US Census Bureau's free
  public geocoder** (`geocoding.geo.census.gov`, no API key, no cost). Returns `{ lat, lng }`
  for the first match or `null` for no match / any failure (bad address, network error,
  non-2xx response) - deliberately isolated behind this one function's shape so swapping
  providers later (e.g. if Census coverage/uptime becomes a problem) only means rewriting this
  file, nothing that calls it.
- **Contract: best-effort, never blocking.** Geocoding failures are swallowed to `null`, not
  thrown - creating or editing a place must never fail, hang, or error out because the Census
  API is slow, down, or the address doesn't resolve. Keep this contract if you touch the code.
- **Wired into `server/src/routes/places.js`:** `POST /api/places` geocodes on create whenever
  any of address/city/zip is set; `PATCH /api/places/:id` re-geocodes whenever any of
  address/city/state/zip changes (using the merged existing+incoming values, not just what was
  in the PATCH body). Both stamp `geocoded_at = now()` regardless of match/no-match, and set
  `lat`/`lng` to `null` on no match (so a place is never left with stale coordinates from a
  previous address).
- **Backfill script:** `npm run geocode` → `server/src/scripts/geocode-places.js`. Selects
  every place with `geocoded_at IS NULL`, batches them through the Census's separate *batch*
  endpoint (CSV in, CSV out, up to 10,000 addresses/request - comfortably one call for the
  whole table), and stamps every row's `geocoded_at` whether it matched or not so re-running
  the script never re-sends already-attempted rows. Logs a list of unmatched addresses at the
  end for manual review. **Has now been run against the real dataset** (confirmed against the
  dev DB during the 2026-07-10 audit - see §14A/§14B): 255 of 262 places have `lat`/`lng`; the
  other 7 were stamped `geocoded_at` (so the script wouldn't re-attempt them) but had no
  coordinates because Census didn't match their address. (Earlier revisions of this doc said
  the backfill hadn't run yet - that was true as of 2026-07-09, corrected here.)
  **Manually reviewed 2026-07-22 (§14):** 5 of the 7 are genuinely non-geocodable (2 PO Boxes,
  3 "(Online)" referral sources with no physical address) - expected, not a data problem. The
  other 2 had real addresses Census just doesn't have indexed; cross-checked against
  OpenStreetMap and hand-set their `lat`/`lng` directly. No manual-override field exists, so
  this is durable only until one of those 2 places' address is edited again (see §14).
- **Migration:** `server/src/migrations/20260711000000_add_geocoded_at_to_places.js` adds a
  plain `t.timestamp('geocoded_at')` - no FK, no rebuild needed (see mental-model point 4).
  The `lat`/`lng` columns themselves are older (`20260707010000_places_and_people.js`).
- **Nothing in the UI reads lat/lng yet** - no map view, no distance-based sorting. This
  session only made sure the data exists; using it is a follow-up idea (§14).

---

## 10. Smoke-testing methodology (worth knowing before you test again)

Schema changes across sessions (detach semantics, referrals, and - most recently - the
relationship-temp removal / referral-metrics rollout) were all verified with live HTTP calls
against the running dev server, not just unit-level DB checks. Conventions used, worth
keeping:

- **Never use the real user's password to get a token.** Early on, a temp password was set
  on the real "Bede Fulton" account to get a bearer token for curl - this overwrote the real
  password hash without asking first. It was disclosed immediately and fixed by clearing
  `password_hash` back to `null` (first-time-setup state) rather than keeping the temp
  password. **Don't repeat this.**
- Instead, use a passwordless seeded user (**Lisa Marks, id 5**) - set a temporary
  `auth_token` directly in the DB for the test, and always clear it back to `null` afterward.
  (The referral-metrics session's smoke test deviated from this - it set a temp `auth_token`
  on Bede's real account, id 3, and restored the original token value afterward. No data was
  lost since only the rotating session token was touched, not the password hash, but it
  should have used id 5 - flagged here so it doesn't happen again.)
- Test data is always prefixed distinctly (`__E2E_`, `__SMOKETEST_`) and cleaned up by that
  prefix immediately after verification.
- Never touch the user's own real records while testing - in particular, place id 264
  ("Guardian Angels (Test)") and people "Lionel Messi" / "Mohamed Salah" / "Neymar Jr." are
  the user's own manually-created test data, not fixtures to delete.
- Deleting a person before deleting a visit they're on will `SET NULL` the visit's
  `person_id` before a second delete-by-`person_id` can match it - clean up visits by a
  distinctive `place_name`/snapshot field instead if you hit this.

---

## 11. How to run locally

Two terminals (or `./dev.sh` for both). Node is via nvm - run `nvm use 24` if needed.

```bash
# Terminal 1 - API on http://localhost:4000
cd ~/guardian-angels-sales/server
npm install            # first time
npm run seed           # first time: migrate + import places + import notes
npm run dev

# Terminal 2 - app on http://localhost:5173
cd ~/guardian-angels-sales/client
npm install            # first time
npm run dev
```

### Backend scripts (`server/`)
| Command | Does |
|---|---|
| `npm run migrate` | Create/upgrade schema |
| `npm run import` | Import places (idempotent) |
| `npm run import:notes` | Import historical notes (idempotent) |
| `npm run seed` | migrate + import + import:notes |
| `npm run reset` | Drop all + re-seed |
| `npm run dev` / `npm run start` | Run API |

---

## 12. Deployment (Railway) - what we learned

The app deploys to Railway from GitHub. **Two services:** the app (from the repo) and a
**Postgres** plugin. Required app-service variables:
- `NODE_ENV=production`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`

### The big lesson: seed at RUNTIME, not build
The database is **not reachable during the build phase** (sealed container). Earlier attempts
to seed via a build/pre-deploy `npm run seed` failed with **"Unable to acquire a connection."**
**Fix:** `server/src/index.js` now runs migrations on startup and **auto-seeds on first boot
if the DB is empty** (in the background, after the server is already listening). So deploys
"just work" - no build/pre-deploy DB commands needed. `railway.json` and `Procfile` no longer
seed. **Production data is safe** across deploys (auto-seed only runs when DB is empty).

Other gotchas seen along the way: the public "failed to respond" link was on the **Postgres**
service (databases have no website - use the **app** service's domain); a monorepo confused
Railway's autodetection until `railway.json` pinned the builder/commands.

---

## 13. Current state (as of this handoff)

- **2026-07-14 addendum (branch `basil`):** a small header + AssignPersonModal polish
  session - see `NOTES.md`'s 2026-07-14 entry for the full write-up. Two commits,
  `1dd7ec0` (header: dropped the "Change password" button/one-line Date/Signed-in-as/Log
  out layout) and `b755edf` (AssignPersonModal: checkbox multi-select replaced with
  click-to-highlight rows). **Not yet pushed** to `origin/basil-working`. Two things to
  know before touching this area again: (1) **"Change password" has no UI trigger right
  now** - it was removed from the header and needs a new home before anyone can use it
  again; (2) an **open, unresolved product question** was raised - this app may eventually
  be sold to other companies, not just used internally, and the current login (a dropdown
  of every employee's name, no company/tenant concept in `server/src/routes/auth.js`)
  won't scale to that. Nothing was built for it - flag it before investing further in
  login/auth work.
- **Auth shipped:** the "add authentication before sharing the URL" item from the previous
  handoff is done - bearer-token login is live and required on all `/api` routes except the
  login flow itself.
- **Git:** working branch `bede-routeplanner`. The full 2026-07-08 CRM buildout and
  2026-07-09's polish session are committed and merged to `main`. **2026-07-10's audit-fix
  session (`848b246`/`dc5d940`) is committed** - both data-integrity bugs from that day's audit
  are fixed, contrary to older wording in this doc. **2026-07-11 through 2026-07-15's entire
  route planner build (phases 1-6 backend+API, a full codebase audit, all three phase 6
  frontend sub-slices, the old-scheduler retirement, and a round of live UX-feedback
  refinements) is committed on `bede-routeplanner` and, as of 2026-07-15, pushed and merged
  into `main` via a GitHub PR** at Bede's explicit request so his coworkers can access it -
  check `git log main`/GitHub for the exact merge commit rather than trusting a hardcoded hash
  here. See the 2026-07-14/07-15 bullets in §0 and `ROUTEPLANNER_PROGRESS.md`/`NOTES.md` for
  the full detail. Always check `git status` before starting new work and ask Bede before
  committing/pushing/merging, same as always - this was a one-time explicit exception, not a
  standing instruction to keep doing it automatically.
- **Geocoding backfill has been run against real data:** 255 of 262 places have `lat`/`lng`;
  7 are stamped `geocoded_at` but unmatched and still need manual address review. See §9A.
  Places created via the Needs Mapping "create place" flow (`routes/notesReview.js`) used to
  skip geocoding entirely - **fixed 2026-07-22** (§14A), that path now geocodes the same way
  `POST /api/places` does.
- **`places.category` is validated against a real `categories` table**, not free text.
  Originally a locked enum in `server/src/config/categories.js` (2026-07-14 audit, `c408809`) -
  **that file is now deleted**; as of 2026-07-27 the canonical list lives in a `categories` DB
  table (migration `20260727000000`) managed via `routes/categories.js` and a new
  `CategoriesModal.jsx` (add/rename/retire, reachable from a "Manage categories…" option in the
  People/Places category filter dropdowns). `POST`/`PATCH /api/places` still reject any
  non-matching value, just checked against the table now instead of the hardcoded array.
- **The route planner is real and fully usable end-to-end in the UI - and is now the only
  route-planning surface in the app.** Backend/API (phases 1-6) is fully built, tested
  (139 tests), and committed. The "Route Planner" tab has generate, live editing
  (reorder/add/remove/visit-type), suggestions, and commit (per-day and full) all built and
  verified live (2026-07-15) - drafts can be built, edited, and committed to real `visits`
  rows entirely from the new UI. **The old scheduler is fully deleted** (same day, at Bede's
  request) - `services/scheduler.js`, `routes/schedule.js`, `Schedule.jsx`, the "Today's
  Route" tab, and the Dashboard's old route card are all gone; see §0's 2026-07-15 bullet.
  Committed and merged into `main` as of 2026-07-15. See `ROUTEPLANNER_PROGRESS.md` for the
  whole build.
- **Live deploy:** the Railway deployment was taken down after an earlier handoff to avoid
  ongoing cost while still building - all dev happens locally via `./dev.sh` or the two
  npm-run-dev terminals. Redeploying later is still ~5 min (New → GitHub Repo → add Postgres
  → set `NODE_ENV`/`DATABASE_URL` → generate domain; it self-seeds).
- **2026-07-15, later the same day (branch `bede-working`):** a dedicated code-quality/
  bug-hunting session, separate from the route-planner work above - a regular full-app review
  pass followed by an "ultra" 6-agent deep-review pass. Fixed: a critical `dashboard.js` bug
  (the same `whereNotIn`-against-nullable-`place_id` class from the old scheduler, recurred -
  see the corrected §14A note); a real TOCTOU double-booking race in `commitDay`, closed with a
  new partial unique index
  (`server/src/migrations/20260715000002_add_visits_place_date_unique_index.js`, scoped to
  `source = 'planner'` so ad-hoc same-place/same-day "Log a visit" entries stay unaffected);
  missing cross-user ownership checks on `visits.js`'s `PATCH`/`skip`/`DELETE`; a Postgres-only
  500 on non-numeric IDs that's invisible under local SQLite testing (fixed with `Number()` +
  NaN guards across several routes); two more `dashboard.js` instances of the nullable-FK bug
  class (via INNER JOIN, fixed to LEFT JOIN); ungeocoded places sneaking into a committed visit
  unreviewed; a discarded-day resurrection edge case in `addStop`/`commitAll`; and a client/
  server "today" timezone mismatch (server now anchors to `America/Chicago` via a renamed
  `orgToday()`). ~18 further findings from the ultra pass were deliberately deferred, not an
  exhaustive fix-everything pass. 146 tests pass (up from 143), client build clean. **Committed,
  pushed, and merged into `main`** at the end of this session per Bede's explicit request - a
  direct git merge, not a GitHub PR, since `gh` wasn't available in this environment. Full
  detail in `NOTES.md`'s "Code-quality bug hunt" entry and the §0/§14A notes above.
- **2026-07-22, still on `bede-working`:** a "Plan My Visits" feature (reopening a committed
  day) plus a chunk of the deferred ultra-review backlog - see §0's 2026-07-22 bullet for the
  full list and `ROUTEPLANNER_PROGRESS.md` for the reopen-day feature's own writeup. Every
  currently-passwordless user now has a real default password (`Angels#1`) instead of an open
  self-serve first-login flow - the pre-auth account-takeover window itself (unauthenticated
  `GET /auth/users`/`POST /auth/set-password`) is still open pending a real login-page
  redesign Bede hasn't finalized yet. `visits.skip_reason` and the dead "skip a stop" code path
  it belonged to are gone. The Needs Mapping create-place geocoding gap (§14A) is closed. 146
  tests pass, client build clean. Committed on `bede-working` (see `git log` for the hash) -
  **pushed and merged into `main`** later the same session, per Bede's explicit request.
- **Also 2026-07-22:** the route planner's manual start-location entry is now a single live
  address-search box (Mapbox `SearchBox`, `client/src/components/ui/AddressAutocomplete.jsx`)
  instead of 4 separate fields + a lookup button - see §0's matching bullet for the full
  writeup. New client dependency (`@mapbox/search-js-react`) and a new required env var for
  local dev (`client/.env`'s `VITE_MAPBOX_TOKEN`, see `client/.env.example`). The old
  `POST /api/geocode` route and `api.geocode()` client fn are gone (dead code once this
  landed) - this does **not** touch place-address geocoding (§9A), which still runs through
  the free Census geocoder untouched. Verified live, 146 tests pass, client build clean.
- **Also 2026-07-22, four more "Plan My Visits" live-feedback rounds:** the per-date budget
  picker supports minutes now, not just whole hours; clicking a proposed stop opens its full
  `PlaceDetail` (capacity/notes/people/history) so a rep can make a better-informed visit-type
  choice; the stop row's hover highlight covers the whole row (not just its clickable `.main`
  sub-box) and turns on/off instantly rather than partially fading; and the route planner's
  fallback visit-type duration is now **Drop-in (7 min)**, not Working visit (30 min) - a real
  scheduling-behavior change since every place currently rests on this fallback, not just a
  UI default. See §0's matching bullet and `NOTES.md` for full detail. 146 tests pass (2 fixed
  to stay correct under the new default), client build clean. **Pushed and merged into `main`**
  the same session, per Bede's explicit request.
- **2026-07-23:** proposed-stop row layout iterated through several live-feedback rounds (ended
  at name+pills / address / fixed-width select+time+remove - see §0's matching bullet for the
  alignment-bug fix). New: "Already Planned" days open a drill-down modal (`PlannedDayModal.jsx`)
  on click instead of showing Edit/Delete directly on the row; those actions moved into the
  modal's footer. New read endpoint (`GET /api/schedule-drafts/committed-dates/:date/visits`).
  146 tests pass, client build clean.
- **2026-07-24 (not previously logged in this doc - see `git log`/People.jsx for the actual
  diff):** People tab got sort/filter polish, `needs_attention` was removed app-wide (it never
  fed the route-planner algorithm, was purely a display flag), and `people.role_type` was
  dropped entirely (migration `20260724000000_drop_people_role_type.js`) - too ambiguous to
  fill in reliably, the free-text `title` field covers it well enough.
- **2026-07-27:** categories promoted from a hardcoded enum to a real, admin-editable
  `categories` table (see the corrected bullet above and `NOTES.md`'s matching entry for full
  detail) - new `CategoriesModal.jsx`, `routes/categories.js`, migration `20260727000000`.
  Places tab gained full sort parity with People (Last visited/by me, Referrals, Last referral)
  and lost its "Never visited" toggle (superseded by sorting oldest/never-first); its Location
  column dropped city/zip down to just Region, and referral-count styling now matches People's.
  People tab gained a "Last contacted by me" sort. `PersonModal`'s place picker can create a
  new place inline (nested `PlaceModal`, auto-selected on save). `PersonDetail` can now log a
  visit directly (previously view/edit only) when the person has a place assigned. 146 tests
  pass, client build clean. Committed as `a8af5c2`, **pushed and merged into `main`** the same
  session per Bede's explicit request.
- **2026-07-27, later the same day:** the "Needs Mapping" tab and everything behind it removed
  entirely at Bede's explicit request ("I don't want any trails of its functionality... I have
  no use for it any more") - see §7 (now marked removed) for what it used to do. Deleted:
  `NeedsMapping.jsx`, `hooks/useDuplicateMatches.js` and `ui/DuplicateWarning.jsx` (only caller
  of both was NeedsMapping), `routes/notesReview.js`, `scripts/import-notes.js`, the
  `notes_review` table (new migration `20260727010000_drop_notes_review.js` - a plain table
  drop, not editing the original `20260706010000_notes_import.js` that created it), the "Needs
  Mapping" nav tab + its badge count (`App.jsx`), the now-fully-dead `.tab .count`/
  `.warning-banner` CSS, and every `api.js`/`README.md` reference. Also removed the
  `import:notes` step from the production auto-seed (`index.js`'s `seedIfEmpty()`) and `npm run
  seed` - **explicit tradeoff, confirmed with Bede**: a future fresh deploy will only seed
  places from the main spreadsheet, not backfill historical visits from `ReferrerNotes.xlsx`
  anymore; he's building a from-scratch replacement for that later, don't resurrect this
  version. `visits.source` (`manual`/`imported_note`/`planner`) was deliberately left
  untouched - still load-bearing for the route planner's commit-collision unique index, not
  specific to this feature. `ui/PlacePicker.jsx` was kept (still used by Plan My Visits'
  ad-hoc "+ Add a stop" flow) - only its stale NeedsMapping-referencing comment was fixed.
- **2026-07-27, still later:** "Somewhere else" - a manual per-day zone override for the route
  planner, cycling through a day's ranked candidate regions instead of always taking the
  top-ranked one. Full design reviewed with Bede before any code (touch-points + threading plan
  + explicit sign-off on 3 decisions), then built via two parallel background subagents off a
  frozen contract once the shared pure functions were done. New in `scheduleGenerator.js`:
  `orderedZones`/`stepZone`/`outOfZoneCommitments` (13 new tests). New in `scheduleDraft.js`:
  `cycleDayZone`, persisting the resolved zone *name* (not an index) into the existing
  `params.zoneOverrides[date]` slot both read functions already checked - no changes needed
  there. New route `POST /:id/days/:date/zone` (`direction: 1|-1`). New UI: a "Somewhere else"
  button + "Area N of M" indicator per day, plus a dropped-commitments notice banner.
  **Real finding from the design review**: `droppedCommitments` never actually reached an API
  response before this session - computed by `fillDayFromZone`, discarded by
  `generateAndPersistDraft`, never recomputed by the read functions, never referenced client-
  side. This is the first time it's live. **A real bug caught by live testing** (not code
  review): the subagent's first cut excluded this day's own current stops from re-ranking
  (correct for avoiding a re-pack collision, wrong for commitment visibility - it made a
  commitment sitting among them invisible to the new drop-detection too), giving back an empty
  `droppedCommitments` on the first live call when it should have had one; fixed by scoping the
  exclusion to only the draft's other dates. Verified live end-to-end (a real backdated
  commitment, cycled zones, confirmed the exact notice text and that forward/backward/wraparound
  all behave correctly). 159 tests pass (146 + 13 new), client build clean. Full narrative,
  including the design-review findings and three rounds of UI polish, in `NOTES.md`'s matching
  entry. Not yet pushed - see `git log`/`git status`.
- **2026-07-28:** a real double-booking bug fix (multi-day `generate` could propose a place
  another rep already had committed for that exact date - `lockedElsewhere` was computed once
  against generation-day instead of per-day; new `lockedElsewherePlaceIdsByDate` fixes it); the
  "Plan My Visits" tab renamed to **Route Planner** (`PlanVisits.jsx` → `RoutePlanner.jsx`,
  everywhere current-state); a full Calendar-tab interaction overhaul (a day cell is never
  clickable itself anymore - `ui/MonthCalendar.jsx` now renders a plain `<div>`, not a `<button>`;
  each day instead shows up to three independently-clickable pieces: a "Planned Route" badge
  (your own planned visits, opens `PlannedDayModal` with full Edit/Delete, Edit hands off to the
  Route Planner tab), a "Completed Visits" badge, and status dots for everything else; the
  "Today" button was removed outright; Mine/All-reps became one split-down-the-middle toggle
  button instead of two); and another real bug fix - "Already Planned" (`committedDateSummaries`/
  `committedDayVisits`) never filtered by `status`, so a completed visit sharing a date with a
  planned one polluted the list - both now scoped to `status: 'planned'`. 153 tests pass, client
  build clean throughout. Full narrative in `NOTES.md`'s matching entry. Not yet pushed.
- **2026-07-29:** a long live-feedback session on the Calendar tab. "All reps" scope now actually
  shows other reps' planned routes (grouped per rep, "My Planned Route" / "`<Name>`'s Planned
  Route") instead of lumping them into an unlabeled dot; `PlannedDayModal` gained
  `visits`/`title`/`readOnly` props so another rep's route reuses the same look as your own, minus
  Edit/Delete. Two real CSS reflow bugs fixed: a long pill forcing its whole grid column (and the
  page) wider (`grid-template-columns` needed `minmax(0, 1fr)`, not bare `1fr`), and the page
  shifting left/right on every tab switch (scrollbar toggling on/off - fixed with `html {
  overflow-y: scroll; scrollbar-gutter: stable; }`). A "+N more" chip now caps how many pills a day
  cell shows; clicking it (or now, clicking the day number itself, even on an empty day) opens
  `DayOverflowModal` - rebuilt across several rounds into a real anchored popover (portal to
  `<body>`, positioned in document coordinates, centered on the day cell's own midpoint then
  clamped to the viewport so it doesn't jam against a screen edge) showing every pill as an actual
  rectangular (not fully-rounded - "nothing else in this app lets you click a rounded pill") colored
  button. The Mine/All-reps scope toggle is now lifted into `App.jsx` so it survives switching tabs,
  reset back to "Mine" only on logout. Also: "Upcoming Visits" (a `status: 'planned'` mirror of
  Visit History) was added to both PlaceDetail and PersonDetail, then deliberately reverted from
  PersonDetail alone - route-planner-committed visits never get a `person_id`, so that card would
  read empty for everyone until the planning flow changes to support pinning a contact ahead of
  time. 153 tests pass, client build clean. Full narrative in `NOTES.md`'s matching entry. Not yet
  pushed.

---

## 14. Next steps / ideas (not yet done)

- **DONE (2026-07-22).** ~~Manually review the 7 places whose addresses didn't geocode~~ (§9A).
  5 turned out to be genuinely non-geocodable (2 PO Boxes, 3 "(Online)" referral sources with
  no physical address) - nothing to fix, `addStop` already refuses to route them with a clear
  error. The other 2 (Nebraska DHHS Administrative Offices, Southwood Lutheran Church) have
  real street addresses the free Census geocoder simply doesn't have indexed; cross-checked
  both against OpenStreetMap's geocoder (which resolved them exactly) and hand-set their
  `lat`/`lng` directly in the DB. Caveat: there's still no manual lat/lng override field, so if
  either place's address is edited again through the app, Census will fail again and the
  existing "address not recognized - save anyway?" dialog will null the coordinates back out if
  someone clicks through it. Fixing that for real means picking a second geocoding provider -
  a real design decision, not done here.
- **DONE (2026-07-29).** ~~Fix `CalendarDayModal`'s hardcoded title suffix~~ - first fixed with an
  explicit `title` prop, then rendered moot entirely: at Bede's request, the shared component was
  split into two dedicated ones, `CompletedVisitsModal.jsx` and `SkippedVisitsModal.jsx`
  (`CalendarDayModal.jsx` no longer exists), so there's no longer a shared title to mismatch.
- **Feed referral metrics into priority scoring:** `services/priority.js` still only scores
  off tier + the manual priority star; folding in a place's `referral_metrics` (e.g. boost
  the ones with high recent referral activity) is the natural successor to the old "Phase 2
  relationship-temp" idea now that there's an objective activity signal to use instead. (Note:
  the old `needs_attention` flag this used to reference was removed app-wide 2026-07-24 -
  don't resurface it, just the raw lifetime/last/90-day numbers.)
- `NEGLECT_MULTIPLIER`/`CADENCE_DAYS` (route-planner scoring config) are meant to become
  user-editable settings eventually, not stay hardcoded.
- **Postgres backups** once real data accumulates (Railway backups or `pg_dump`), if/when
  redeployed.
- **Dev workflow:** consider working on branches and only merging to `main` when you want the
  live site to redeploy (every push to `main` auto-deploys), once redeployed.
- Set a **spend cap** in Railway billing as a safety net, once redeployed.
- Possible enhancements: custom domain, richer reporting/exports, email/calendar integration.

---

## 14A. Known issues (found in the 2026-07-10 audit; two critical ones fixed same day)

Bede asked for a full read through the People/Places tabs and everything they touch before
starting the route planner. Ran a 4-agent audit (People flow, Places flow, shared
visit/referral machinery, route-planner readiness). Two findings were real data-integrity bugs
that contradicted this app's own detach-not-delete convention (§8):

1. **FIXED (`dc5d940`, 2026-07-10). Deleting a person used to orphan their referrals - no
   snapshot, unlike visits.** `DELETE /api/people/:id` hard-deleted the person row;
   `referrals.person_id` went `null` via `ON DELETE SET NULL` with no snapshot columns
   (unlike `visits`), so the referral became permanently unattributed and silently vanished
   from every referral-metrics rollup. **Fixed** by deleting a person's referrals in the same
   transaction instead of orphaning them.
2. **FIXED (`dc5d940`, 2026-07-10). Editing a visit used to become permanently blocked once
   its linked person was deleted.** `VisitLogModal.jsx`'s `canSave` required a
   *currently-assigned* `person_id`, so once the linked person was deleted the edit form's
   person dropdown reset to empty and Save stayed disabled until a *different* live person
   was picked - silently reattributing that visit's history. **Fixed:** the picker now locks
   to the preserved name snapshot instead of requiring a live person when the original is gone.

Lower-priority findings from the same audit - status as of the 2026-07-14 follow-up audit
(`c408809`), which fixed most of these:
- **FIXED.** `People.jsx`, `Places.jsx`, and `AssignPersonModal.jsx`'s search/list loads now
  have error banners and a stale-response guard on their debounced search (a slower earlier
  response can no longer overwrite a faster later one).
- **Moot.** The People directory's missing "Departed" status is moot - the `departed` field
  was dropped from the schema entirely on 2026-07-11 (nobody was using it).
- **FIXED (2026-07-22).** Places created via the Needs Mapping "create place" flow
  (`server/src/routes/notesReview.js`) used to skip geocoding entirely - a second, hand-rolled
  insert path that duplicated `POST /api/places` but never called `geocodeAddress(...)`. Now
  calls it the same way, best-effort and non-blocking.
- **FIXED.** `Schedule.jsx`'s remove/skip-stop actions now confirm, error-handle, and disable
  the row while in flight, matching `removeVisit()` elsewhere.
- **FIXED.** `places.category` is now a locked enum (`server/src/config/categories.js`), not
  free text - `POST`/`PATCH /api/places` reject any non-matching value. Bede deliberately
  deferred building an "add a category" admin UI until it's actually needed.
- **FIXED (2026-07-22).** Filter dropdown options (category/tier/region in Places.jsx, the
  place picker/filter in People.jsx) used to be fetched once per mount and not refresh when a
  new value was added elsewhere in the same session. Both now re-fetch alongside the row list
  on every create/edit/delete.

**New findings from the 2026-07-14 full-codebase audit (`c408809`), both fixed same day:**
- **Critical, was live in production:** `GET`/`POST /api/users` returned full user rows
  including `password_hash` and the live `auth_token` with no column filtering - any
  authenticated user could grab another user's session token and impersonate them. Fixed with
  a `SAFE_COLUMNS` select, matching `routes/auth.js`'s existing `publicUser` pattern.
- **Live-breaking bug in the scheduler actually in production use:**
  `services/scheduler.js`'s `generateSchedule()` used `.whereNotIn('id', subquery)` where the
  subquery could return a NULL `place_id` (an expected state under detach-not-delete) - SQL's
  `NOT IN` against any NULL evaluates to NULL for every row, so once any place had ever been
  deleted, route generation would silently return zero candidates forever, for every user.
  Fixed with `.whereNotNull('place_id')` on both subqueries.

What's confirmed solid (don't second-guess these without new evidence): referral-metrics
rollups are correctly live-computed from each entity's *current* state, never stale/stored;
`needs_attention`/`never_visited` are computed live on every read; detach-not-delete now works
correctly everywhere, including people→referrals.

**Correction, 2026-07-15:** the "detach-not-delete now works correctly everywhere" line above
was too broad. The same `.whereNotIn()`/inner-join-against-a-nullable-FK bug class recurred -
`dashboard.js`'s "never visited" widget had the identical `whereNotIn` bug as the old scheduler
(fixed same day, `.whereNotNull('place_id')`), and its "completed this week"/"needs attention"
queries had the same class again via INNER JOIN instead of LEFT JOIN (also fixed same day). That
makes **3 occurrences across 2 files** now, not the isolated one this section implied - see the
2026-07-15 bullet in §0 and `NOTES.md`'s "Code-quality bug hunt" entry for the fixes. Don't
treat "confirmed solid" as proof this bug class can't recur elsewhere; a dedicated grep sweep
for `whereNotIn`/inner joins against nullable FK columns is still worth doing in a future audit.

---

## 14B. Route-planner readiness (2026-07-10 assessment)

**Very stale as of 2026-07-15 - the route planner is done on the backend/API side and now
fully usable end-to-end in the UI, on branch `bede-routeplanner` (not yet merged to `main`).**
Everything below this point describes the *pre-build* state (nothing existed yet) and should
not be trusted for current status - read `ROUTEPLANNER_PROGRESS.md` at the repo root instead,
kept up to date phase-by-phase. Short version: phases 1-6 are all built, tested (139 tests), and
committed - four-tier scoring engine, drive-time via a real routing API (OSRM) with
stop-sequencing optimization, visit-type durations, a multi-day draft generator, and a full
draft/commit lifecycle with multi-user collision handling. On top of that, all three frontend
sub-slices are built and verified live: a "Plan My Visits" tab with generate, live editing
(reorder/add/remove/visit-type, in-place time recalculation, over-budget flagging),
suggestions, and commit (per-day and full). The old scheduler this whole section originally
assumed would still be the app's only option is now fully retired (2026-07-15) - the route
planner is the only route-planning surface left in the app.

Bede's next planned feature is a real route planner (plan a day's driving route between
places). Assessed what's actually ready vs. missing:

**Ready:**
- `lat`/`lng` are populated for 255/262 places (§9A) and already returned by
  `GET /api/places` / `GET /api/places/:id` (plain `p.*`/spread, nothing strips them) - no
  backend change needed to start reading coordinates.
- `region` (side-of-town bucket, `services/priority.js`) is already computed and stored per
  place, usable as a coarse pre-filter.
- `services/geocoding.js` is a clean, swappable single-function boundary if a real routing
  provider (driving-distance/duration, not just geocoding) gets added later.
- Referral-metrics rollups (needed if routing ever factors in referral activity) are solid
  and live-computed - see §14A's "confirmed solid" note.

**Missing (in rough build order):**
1. **The 7 unmatched-address places** need manual review/correction before a router can trust
   "every place has coordinates."
2. **No distance/duration math anywhere.** `services/scheduler.js`'s `clusterSort` only buckets
   by `region` → `city` → zip-code-number proximity - a coarse sort, not geographic routing.
   No haversine calc, no routing-API call, nothing touches `lat`/`lng` in `scheduler.js`,
   `priority.js`, or `routes/schedule.js`. Neither `client/package.json` nor
   `server/package.json` has a mapping/routing library (no leaflet, mapbox-gl, turf,
   google-maps, osrm-client, etc.) - this is the core missing piece.
3. **No visit-duration, time-window, working-hours, or driver-start-location data anywhere in
   the schema.** `scheduler.js`'s `DEFAULT_VISIT_MINUTES`/`DEFAULT_TRAVEL_MINUTES` are
   hardcoded global constants, not per-place/per-visit/per-user data. `users` has no
   home-base/start-location field. A real router needs at least a start point and per-stop
   duration estimates - this needs a schema decision, not just new logic.
4. **`Schedule.jsx` presents visits in priority/region-bucket order, not a geographically
   routed order** - no distance shown between stops, no map, no multi-stop route. "Navigate"
   builds a single-destination Google Maps link from address text, not coordinates.
5. **No UI surfaces lat/lng at all** - no map view, no "needs geocoding" indicator anywhere in
   `Places.jsx`/`PlaceDetail.jsx`.
6. **No "pick which places to route today" selection UI** - `generateSchedule`
   (`scheduler.js`) auto-picks candidates by priority/never-visited; there's no way to
   manually choose a subset to route.

**Suggested build order:** (a) resolve the 7 unmatched addresses, (b) add a distance/duration
engine (haversine is enough to start; a real routing API is a later upgrade) plus a driver
start location and a per-stop duration model - this is a schema change, decide it early, (c)
wire that into `scheduler.js`'s ordering in place of/alongside `clusterSort`, (d) surface it in
`Schedule.jsx`/`PlaceDetail` with an actual map.

---

## 15. Quick "resume tomorrow" checklist

1. Open the folder: `code ~/guardian-angels-sales`
2. Ensure Node: `nvm use 24` (or rely on `./dev.sh`)
3. `git checkout bede-working` - active work happens here, periodically merged into `main`
   (most recently 2026-07-22, all pushed). `bede-routeplanner` was the branch for this
   *before* 2026-07-15's merge - long since folded into `main`, don't resume work there.
4. Start it: `cd ~/guardian-angels-sales && ./dev.sh` → open http://localhost:5173
5. Check `git status` before starting anything new - ask Bede before committing, always.
6. Read `ROUTEPLANNER_PROGRESS.md` before touching the route planner - it's the up-to-date
   source of truth, phase-by-phase. All three frontend sub-slices are done and the old
   scheduler is fully retired - the route planner is the app's only route-planning surface.
7. §14A's two critical bugs are fixed - no need to fix them again, just don't reintroduce them.
8. Read §16 before touching relationship level or visit outcomes - the outcome enum changed and
   relationship is now computed, not stored.
9. Read §18 (and `capacity-computation-spec.md`) before touching capacity, the EXPLORATION tier,
   or scheduling cadence - capacity is now computed too, steps 1–7 of 9 done (the ranker no longer
   reads any legacy capacity_* column at all). Step 8 (drop-off detector) is BLOCKED on the eRSP
   migration, not just unstarted - don't pick it up speculatively. Step 9 (drop the legacy columns)
   not started.

---

## 16. Computed relationship level (built 2026-08-03)

Replaces the manual `places.relationship_level` field. Built from Bede's own written spec;
this section records what was built, the decisions taken along the way, and what's deliberately
left open.

### Why

`relationship_level` is one of the two axes of `config/scheduling.js`'s cadence table (the other
is `capacity_level`). It defaulted to `'weak'`, had no write path in any route or UI, and had
never been edited - so **every place in the database read `'weak'`**, and the cadence table was
effectively running on capacity alone. That's the same failure that killed the old
`relationship_temp` field (§9): a manual "smart" field that needs upkeep and doesn't get it.

### The model (`server/src/services/relationship.js`)

Relationship is measured **per person** and rolled up to the place - a relationship is with
Sharon at Tabitha, not with Tabitha. Nothing is stored; it's computed live on every read, same
convention as referral metrics (§9).

- **Per-visit weight** = who you met × what happened. `named_person` 1.0 / `staff` 0.35 /
  `receptionist` 0.15 / `nobody` 0.05, times `substantive` 1.0 / `introduced_new` 1.0 /
  `brief` 0.6 / `materials_only` 0.25 / `unavailable` 0.15 / `declined` 0.1. A real sit-down
  scores 1.0; a front-desk brochure drop scores 0.0125 - an ~80× spread, which is the point.
- **Decay**: every visit's weight halves every half-life. 30 days for fast-moving categories
  (`Assisted Living & Senior Living`, `Community Partners`, `Hospice`, `Hospitals`,
  `Physical Therapy`, `Physicians`, `Rehabilitation Centers`, `Legal & Trust`), 60 days for
  everything else including any category added later. Exact strings must match the seeded
  `categories` table - a near-miss silently falls through to the default, so there's a test
  guarding precisely that.
- **Reciprocity multiplier** measures *their* investment, not the rep's: +0.0625 per known
  personal detail (birthday, preferences, email, phone), ×1.15 if they've ever referred,
  ×1.1 if they asked us for something within the trailing half-life. Capped at ×1.6.
- **Place rollup**: people sorted by score, each worth half the last (`p0 + 0.5·p1 + 0.25·p2…`),
  plus a floor from visits that never met a named person. One champion beats six lukewarm
  contacts; a zero-scoring contact contributes exactly zero at any position, so extra weak
  contacts can never dilute a strong one.
- **Buckets**: strong ≥ 3.4, medium ≥ 1.3, else weak - category-independent by design, since
  steady-state score depends only on the *ratio* of visit cadence to half-life.

**Axis separation is load-bearing.** Relationship must never read referral *volume* - that's the
capacity axis. If both axes read the same signal they collapse into one and the deliberate
inversion that makes the cadence table valuable (high-capacity + weak-relationship gets visited
most often) stops working, because that cell empties out by construction. "Has ever referred" is
allowed as a **binary**; the referral query selects `DISTINCT person_id` and never a `COUNT`
specifically so the model has no access to volume.

### Seeding

Without intervention every place reads `weak` on day one. `people.relationship_seed` holds a
one-time converged score value (Champion 4.0 / Solid 2.0 / Acquaintance 0.8) that **decays on
the same clock as real visit weight** - ~3% of original after five months on a 30-day category.
No expiry logic, no cleanup task: a real relationship gets visited and earns genuine score as
the seed fades; an optimistic seed never followed up decays to nothing, which is the honest
answer. *A seed is a claim with an expiration date attached; an override is a claim that is
silently wrong forever.* UI: People tab → "Rate relationships". Re-runnable - re-seeding
overwrites the value and resets the decay clock. That screen only lists people with no completed
visit yet (once a real visit lands, the algorithm has genuine signal and the row drops off); a
person who still has a seed but never got visited can also be reset back to "never rated" from
the same picker.

### Override

`places.relationship_level_override` + `_at` + `_by`. The effective level is
`override ?? computed`, and that's what the scheduler reads. The UI **always shows the computed
value next to an override when they disagree** ("Set manually by Bede on 8/3 - computed: weak").
That visible divergence is the entire anti-rot mechanism; an override that silently looks like a
computed value is exactly how a manual field goes stale unnoticed. Who/when are stamped
server-side from the bearer token, never taken from the request body.

### Schema (3 migrations, `20260803000000`–`20260803000002`)

- `visits`: `met_with_type`, `they_requested`, `actual_duration_minutes`
- `people`: `relationship_seed`, `relationship_seeded_at`
- `places`: `relationship_level_override`, `relationship_override_at`, `relationship_override_by`

`places.relationship_level` is **deliberately still on the table** as a read-only legacy column
for one release, so computed values can be compared against the old manual ones on real data.
Drop it in a follow-up once that comparison is done. `schedulingEngine.js`'s
`effectiveRelationshipLevel()` has a fallback to it that exists only for that transition -
delete the fallback along with the column.

*(Migration note, since the project convention here is easy to over-apply: adding a **new**
nullable FK column uses a plain `.alterTable()`. The `rebuildSqliteTable` dance from
`20260709000000` is only needed when CHANGING or DROPPING a column that already carries an FK.
Verified against the real dev SQLite - the new FK landed with `ON DELETE SET NULL` intact.)*

### Two decisions recorded here because the spec asked for them

1. **Visit outcomes: replaced outright, no dual-running.** See §0's summary. The old→new
   backfill is deferred to real-data-import time; unrecognized outcomes score at
   `OUTCOME_WEIGHT.declined` (0.1) rather than 0 or `NaN`, so old rows degrade quietly.
2. **`maybeCapturePreQualification` now gates on `capacity_status === 'estimated'`,
   not "is this the first visit."** The old rule had a trapdoor: miss the number on visit one
   and the place was never asked again, leaving it stuck on an estimated capacity forever -
   which meant permanently stuck in the ranker's exploration tier. The prompt now returns on
   every completed visit until a real number is captured, and stops the moment one is.

### Deliberately deferred - do NOT rediscover these as mystery bugs

- **Quality-weighted urgency clock - DECIDED, not deferred (2026-08-10).** `lastVisitDate`
  counts *all* completed visits regardless of quality, so a front-desk drop-off resets the
  urgency clock and trips the 5-day hard floor exactly like a substantive meeting - while
  contributing ~1% of the relationship weight. Bede's call: this is intended, not a gap. Any
  completed visit should count. Don't weight the urgency clock by visit quality later without
  checking with him first - this isn't an open question anymore.
- **Old→new visit-outcome backfill**, and what `visit_weight` should resolve to for a
  backfilled visit whose outcome doesn't map cleanly. Both punted because all current visit
  data is test data.
- **Per-day `asOf` in the route planner.** `computeRelationshipForPlaces` already accepts
  `asOf`; `buildCandidatePool` passes generation-day only. Threading a per-day date through
  `generateDraft` (so day 5 of a plan sees slightly more decay than day 1) is separate work.
- **`capacity_level` is still never written by anything.** Seeded once by keyword-match against
  category in `20260712000000` and never touched since - so any place created after that
  migration has `capacity_level: null` and silently falls back to the `medium` cadence row.
  Pre-existing gap, unrelated to this work, but it's the *other* axis of the same table.
- **Threshold judgment call - DECIDED 2026-08-10.** The spec's prose called "visited at half
  the half-life rate" the *weak* boundary, but the original threshold constant (`medium: 1.3`)
  put that case in **medium** (converged value 1.3333, clearing 1.3 by only 0.033). Bede said he
  didn't have a preference and left the call to me; went with the prose's intent -
  `RELATIONSHIP_THRESHOLDS.medium` is now `1.4`, so that boundary case reads weak. Updated in
  `relationship.js` and `relationship.test.js`.

### Testing

`server/src/services/relationship.test.js` - 46 tests (suite total: 154 → 200). Mostly pure
math, **plus a real in-memory SQLite database** (migrated, seeded, torn down) for the bulk query
paths. That's deliberate: the pure suite cannot catch a bad column name or a mis-keyed groupBy,
which is exactly the bug that shipped once before in this subsystem (a `r.place_id` that was
really `r.id`, which 154 pure tests sailed past and only a live run caught).

`npm run relationship:distribution` prints the live bucket distribution and warns when one
bucket holds >90% of places. Run it before letting the ranker lean on these values, and again
after any seeding pass.

---

## 17. Visits split into trips + encounters (2026-08-05)

**The change:** `visits` used to be one row per PERSON MET. A trip where a rep met three
people wrote three rows sharing place/date/rep/notes/duration, each carrying its own
`person_id`/`met_with_type`/`outcome`/`they_requested`. There was no real identifier for "the
trip" - only an implicit one, recoverable by matching the shared fields across rows, which is
what the client was doing purely for display.

Now `visits` IS the trip and the new `visit_encounters` holds one row per person/category met
(see §4). Migration: `20260806000000_split_visit_encounters.js`.

### Why, and what it bought

The encounter-level model itself was right and is unchanged - `services/relationship.js` has
to score "substantive with Sharon" and "gatekept by the front desk" separately, which a single
flat row can't express. What was wrong was that the TRIP had no identity, so anything
visit-specific (vs. encounter-specific) had nowhere to live and every consumer had to re-derive
trip grouping for itself. It also silently caused a real bug: `routes/dashboard.js`'s "completed
this week" counted rows, so one 3-person trip read as 3 completed visits.

### Two traps this migration hit, both worth not re-learning

1. **Don't group pre-split rows by matching trip fields alone.** Two genuinely separate visits
   (a morning drop-off and an afternoon meeting at the same place, same day) with `notes` and
   `actual_duration_minutes` both NULL match on every field and would wrongly collapse into one
   - irreversibly; `down()` cannot recover it. The migration keys on `created_at` instead (one
   multi-encounter POST inserts its rows in one transaction, so they land in the same second)
   and uses the shared fields only to VETO a merge, never to propose one.
2. **A NULL `place_id` is not an identity.** The route planner commits a whole DAY in one
   transaction, so a dozen stops at a dozen DIFFERENT places share a `created_at` to the second.
   Where those places were later deleted, `place_id` is NULL on all of them (detach-not-delete),
   and a naive key read 13 unrelated planned stops as one 13-person trip. Caught while
   rehearsing against the real dev DB. Merging is now restricted to rows that could actually
   have come from the multi-encounter POST fan-out: `place_id NOT NULL AND source='manual' AND
   status='completed'`. Every merge is logged to stdout.

Third trap, in the migration mechanics: `visit_encounters.visit_id` is `ON DELETE CASCADE`, and
the SQLite reshape of `visits` DROPs the table. With foreign keys on, that cascade silently
emptied `visit_encounters` while the backfill reported success. Both `up()` and `down()` now
read the old rows into memory and finish every change to `visits` BEFORE the child table exists
or is repopulated.

### Rules that came out of it

- **A completed trip must have at least one encounter** - POST and PATCH both reject
  `status:'completed'` with an empty encounter set, and deleting the last encounter of a
  completed trip deletes the trip. A `planned` trip with zero encounters is normal and exempt.
- **Deleting the last encounter is warned about specifically.** The trip carries `notes` and
  `next_visit_date`, and `next_visit_date` is load-bearing - it's what puts a place in the
  COMMITMENT tier in `schedulingEngine.js`. The confirm dialog names what else is being
  destroyed rather than showing a generic prompt.
- **`PATCH /api/visits/:id` upserts encounters BY ID**, it does not delete-all-then-reinsert.
  `VisitDetailModal` holds encounter ids for its per-encounter delete buttons; a blanket replace
  would 404 every one of them after any unrelated trip-level save.
- **Encounter id/timestamp churn does NOT affect scoring.** `relationship.js` decays against the
  TRIP's `scheduled_date`, never `visit_encounters.created_at`. Don't "fix" encounter timestamps
  believing scoring depends on them.
- **`visits_place_date_active_unique`** (the partial index from `20260715000002`, scoped to
  `source='planner'`) now means what it always claimed to: one trip per place per day. It was
  never widened beyond `source='planner'` - extending it to manual logging is a separate
  decision, and manual same-day double-logging is still a deliberate capability behind the
  collision warning's "Save anyway".

### API shape

`GET /api/visits/:id` is new and returns the full trip with every encounter field - it's the
only call that does. List endpoints (`/calendar`, place/person visit history, dashboard) return
one row per trip with a lightweight `encounters: [{person_name, met_with_type}]` summary, so a
summary line renders without a second fetch. `people.js`'s `GET /:id` asks for `person_id` too
on top of that summary - it's the one caller that needs to tell "this person's own encounter"
apart from an attendee who merely shares their name (see PersonDetail.jsx's `otherAttendees`).
`DELETE /api/visits/:id/encounters/:encounterId` removes one person from a trip.

**Permission rule for the encounter endpoints matches `PATCH /:id`, not `DELETE /:id`:**
removing one encounter (or editing a trip's encounters via PATCH) is a correction any rep can
make cross-rep once the trip is completed/skipped - same as correcting notes or an outcome.
Only a still-`planned` stop stays locked to its own rep. Deleting the WHOLE visit outright
(`DELETE /:id`) is the stricter, owner-only rule; that asymmetry is deliberate; encounter-level
edits and whole-visit deletion are different acts.

`VisitLogModal` no longer has separate create vs. edit UIs - creating an ad-hoc visit,
completing a planned route-planner stop, and editing an existing trip all use the same
multi-encounter flow, which deleted a large parallel code path rather than adding one.

### Known gap, deliberately deferred - read before touching skip functionality

`VisitDetailModal.jsx`'s `deletesTrip` check reads `trip.status !== 'planned'`, but the server
only actually auto-deletes the trip (in `DELETE /:id/encounters/:encounterId`) when
`visit.status === 'completed'`. A `skipped` visit that somehow carries encounters falls into the
gap: the client would show the destructive "whole visit will be deleted" warning, the server
would leave the trip standing, and the client would close the modal believing it was gone.

**Currently unreachable** - nothing in the app sets a visit's status to `skipped` today (only
`VisitLogModal` calls `updateVisit`, always with `status: 'completed'`), but `SkippedVisitsModal.jsx`
already exists reading that status, so a skip feature is clearly intended. Bede: fix this as
part of building that feature properly, not in isolation - the right fix depends on what a
skipped-with-encounters trip is even supposed to mean once that exists.

---

## 18. Computed capacity (steps 1–7 of 9 built 2026-08-07)

Replaces the manual `places.capacity_level`, the frozen `places.capacity_monthly_referrals`, and
the one-way `places.capacity_status` latch. Built from Bede's own written spec -
[capacity-computation-spec.md](capacity-computation-spec.md), 15 sections, saved into the repo
root at the same time as this section (the code had been citing it by filename all along, but it
had only ever existed as pasted text - if you're looking for the spec and can't find it, that's
why; it's real now). Read the spec for the full definition, bucket math, and schema; this section
records what shipped, the judgment calls, and what's still open.

### Why

`capacity_level` is the other axis of `config/scheduling.js`'s cadence table (relationship is
§16's). Same failure mode as `relationship_level` before it, in three different flavors: a manual
guess (`capacity_level`) never revised, a number frozen the moment someone first answered it
(`capacity_monthly_referrals`), and a one-way latch (`capacity_status`: estimated → verified on
first completed visit and never re-examined, no matter how stale). None of the three self-correct.

### The model (`server/src/services/capacity.js`)

Modeled on `services/referralMetrics.js`/`relationship.js`, with one invariant the other two axes
don't have: **measured referral volume may only raise the capacity number, never lower it**
(spec §3). The pre-qual answer and the `referrals` table measure different things - total
referrals to anyone, vs. referrals to us specifically - so a place that claimed 15/month and
sends us 0 might be sending all 15 to a competitor. Demoting it to `low` would permanently route
sales away from the highest-value kind of target in the database. Downward correction only ever
happens through a human re-ask or an explicit override.

- **declared**: latest `capacity_observations` row for the place.
- **measuredFloor**: our own referral throughput converted to a monthly rate, gated behind a
  minimum exposure window (180 days) and minimum count (3) so small samples can't manufacture a
  floor.
- **effectiveMonthly**: `max(declared, measuredFloor)` - the asymmetry invariant, enforced in
  exactly one place and covered by a named test that fails loudly if it's ever made bidirectional.
- **level**: bucketed from `effectiveMonthly` - low 0–5, medium 6–15, high 16+ - unless an
  override is set, or nothing's ever been observed/measured, in which case it falls back to a
  category-seed guess (the same real keyword table that already seeds `places.capacity_level`
  today).
- **confidence**: `unknown` (never pre-qualified) / `stale` (declared observation older than 365
  days) / `fresh`. Replaces the old `capacity_status` latch. An override does not make a place
  fresh - it still needs re-asking, the override just says don't trust the stale number meanwhile.

### Schema (2 migrations, `20260807000000`–`20260807000001`)

- `capacity_observations` (new table): append-only declared-capacity log. One row per pre-qual
  answer or manual adjustment; nothing is ever overwritten - this is what lets PlaceDetail show a
  partner's pipe visibly growing over three years. Backfilled from every place's prior
  `capacity_monthly_referrals`.
- `places`: `capacity_override_level`, `capacity_override_reason`, `capacity_override_at` - same
  pattern as `relationship_level_override`, one field lighter (a free-text reason instead of a
  `_by` user id).

### Override

Same anti-rot mechanism as relationship's override (§16): the UI always shows computed vs.
override side by side when they diverge, so a stale manual call is visible, not silently trusted
forever.

### Step 6 - cadence lookup swapped to the computed level (done 2026-08-07)

`schedulingEngine.js`'s `targetCadenceDays()` and the EXPLORATION tier's `capacityRank()` both
used to read `place.capacity_level` (the raw, frozen column) directly. `buildCandidatePool`
(`scheduleDraft.js`) now also computes capacity for the whole pool in one batched
`computeCapacityForPlaces` call, exactly like it already does for relationship, and attaches the
result as `capacityLevel` on each candidate. `schedulingEngine.js` reads that via a new
`effectiveCapacityLevel({ place, capacityLevel })` helper - same transition-fallback shape as
`effectiveRelationshipLevel`, falling back to `place.capacity_level` only when no candidate-level
value is supplied (i.e. only in this module's own bare-place-object unit tests; production always
supplies it). Delete the fallback once the legacy column is dropped (step 9), same as
relationship's.

**Deliberately NOT touched in this step:** `rankKey`'s `isEstimated` tier gate still read
`place.capacity_status` directly, not the computed `confidence`, at the time step 6 shipped - that
was step 7's swap (the EXPLORATION tier rework), done later the same day. See the next subsection.

**Verification performed before finalizing, both requested explicitly:**
- **Legacy-vs-computed diff** (`npm run capacity:legacy-diff`, new script): 260/261 places (99.6%)
  unchanged. The 1 move was the internal test place ("Guardian Angels (Test)"), and only because it
  was carrying a manual capacity override left over from exercising the override UI during steps
  1–5 - not a real disagreement.
- **Override path exercised end to end** on that same test place before clearing it: confirmed
  `capacity_override_level` flows through `computeCapacityForPlace` → `buildCandidatePool`'s
  `capacityLevel` → `effectiveCapacityLevel` → `targetCadenceDays`, changing its cadence target
  from 21 days (legacy `medium`) to 60 days (override `low`) at the same relationship level - and,
  holding `lastVisitDate` at a fixed 60-days-ago for illustration, urgency from 2.86 down to 1.0 at
  the same inputs otherwise. The override was then cleared (`capacity_override_level/_reason/_at`
  all set back to `null`) so the test place stops carrying a fake value; it now resolves naturally
  to `low` via its real declared observation (5/month, which legitimately buckets under `medium`'s
  6-referral floor - the legacy column's `medium` was simply stale).
- **Before/after draft generation, same date/zone/home base**: ran `generateDraft` once against a
  temporary copy of the pre-swap `scheduleDraft.js`/`schedulingEngine.js`/`scheduleGenerator.js`
  (pulled from the prior commit via `git show HEAD:...`, loaded under throwaway filenames, never
  written into the working tree as a real change) and once against the current code, same
  `today`/target date/zone override/home base, real OSRM optimizer both times. Output - stop order,
  visit types, `totalMinutes`, `remainingMinutes` - was byte-identical. Confirms the swap changed
  nothing for any place whose level didn't move, which is what the near-total diff overlap predicts
  but doesn't itself prove.

### Step 7 - EXPLORATION tier tie-break (done 2026-08-07)

The launch-blocker the spec opens with: the EXPLORATION tier was ordered by a bare capacity-level
guess (3 possible values), so after import - nearly everything unverified - the tier was
effectively unordered. Since zone selection reads `ranked[0].place.region`, an arbitrary tie
picked the region for an entire day.

**Two changes, both in `schedulingEngine.js`:**
1. **Tier membership**: `rankKey`'s gate now reads the computed capacity service's `confidence`
   (`unknown`/`stale` → still in EXPLORATION, `fresh` → out), via a new
   `effectiveCapacityConfidence({ place, capacityConfidence })` - same transition-fallback shape as
   `effectiveCapacityLevel`/`effectiveRelationshipLevel`, mapping the legacy `capacity_status` to
   its nearest confidence equivalent only for this module's own bare-place-object tests. This is
   the change that finally makes `place.capacity_status` unread by anything ranking-related - and
   the reason a FRESH place can now re-enter EXPLORATION later if its declared observation ages
   past `CAPACITY_STALE_DAYS`, which was structurally impossible under the old one-way latch
   (estimated → verified, never revisited).
2. **Within-tier ordering** (spec §8.1): `explorationRank` (ascending) → `priority_score`
   (descending) → `place.id` (ascending, final tiebreak). `rankKey`'s EXPLORATION branch now
   returns a 4-element tuple (`[TIERS.EXPLORATION, -rank, priority_score, -place.id]`, the two
   ascending keys negated) instead of the single scalar every other tier uses; `compareRankKeys`
   was generalized from a fixed `[tier, value]` pair to loop elementwise over however many
   within-tier values a tier's key carries - every other tier's existing single-value tuples are
   unaffected. `explorationRank` itself (spec §8.2) is a new pure function, directly unit-tested.

**`places.exploration_eligible_since` - a real column, not the spec's own `?? created_at`
fallback.** Bede caught this before it shipped: the spec's original §8.2 pseudocode fell back to
`place.created_at` at read time when this value was missing. A place that's been fresh for months
and then goes stale re-enters EXPLORATION - but the fallback would hand it `created_at`, often a
year old, as its aging anchor, backdating its wait clock and jumping it to rank 0 the day it goes
stale, ahead of places that have genuinely never been pre-qualified. Fixed with migration
`20260807000002`: a real column, stamped explicitly at every write site (never derived at read
time) - `created_at` at place creation/backfill (nothing observed yet, eligible immediately), and
`observed_at + CAPACITY_STALE_DAYS` the moment ANY `capacity_observations` row is written
(`services/capacity.js`'s `stampExplorationEligibility`, called from both
`routes/places.js`'s `POST /:id/capacity-observations` and `routes/visits.js`'s
`maybeCapturePreQualification`) - this place will next become eligible when THAT observation goes
stale, which is knowable and stamped immediately rather than reshuffling retroactively if
`CAPACITY_STALE_DAYS` is ever retuned later.

**Simulation performed before finalizing, exactly as requested - day 0/90/180, same zone/home
base, real data:**
```
day 0   (2026-08-07): rank 0 = 65 high only         (medium=90 sits at rank 1, low=105 at rank 2 - inert, as designed)
day 90  (2026-11-05): rank 0 = 65 high + 90 medium = 155  (medium has joined rank 0; low=105 still at rank 1)
day 180 (2027-02-03): rank 0 = 65 high + 90 medium + 105 low = 260  (every EXPLORATION place has reached rank 0)
```
Matches the spec's own prediction exactly: inert at day 0, medium reaches rank 0 around day 90, low
around day 180. (`priority_score` ties mean the raw top-N list stays dominated by the same
`is_priority` places throughout - the rank-0 COMPOSITION by level, not the top-N list, is what
actually shows the shift; both were checked.) A same-zone/home-base draft was also generated at
each snapshot as a secondary check - differs snapshot to snapshot as expected, since the pool
actually entering rank 0 changes.

Ordering itself (not just rank-0 composition) was verified empirically too: at day 0, the ordered
tier is all 65 `high` places first (id ascending within `priority_score` ties, `priority_score`
descending across ties), THEN all 90 `medium` places begin - including a `medium` place with
`priority_score: 100` sorting strictly after a `high` place with `priority_score: 25`.
`explorationRank` is confirmed the primary key; `priority_score`/`place.id` only ever break a tie
within one rank, never override it.

**Known, deliberately-not-fixed consequence of day 180's all-260-at-rank-0 state - the aging guard
is a cliff, not a fade, and that's structural, not a bug.** Because every one of the 259 bulk-import
places shares the exact same `created_at` (2026-07-06), and none has been individually
pre-qualified, they all cross `EXPLORATION_AGING_DAYS`'s multiples on the same calendar day. §8.2's
per-place aging is working exactly as designed - it's the INPUT (one shared import date across
nearly the whole territory) that produces a step function instead of a gradual staggering. Once
every place reaches rank 0, `explorationRank` has no more capacity signal left to offer and ordering
falls through entirely to `priority_score` then `place.id` - meaning `is_priority` places, which
already dominate the front of the tier from day 0 (see the ordering check above), are ALL that's
left steering EXPLORATION by day 180 if nothing has been pre-qualified by then. This will self-heal
naturally as real pre-qual answers land (each one moves a place to `declared`/`measured`
`levelSource` and out of `category_seed`, so it stops being part of the undifferentiated mass and
gets its own real `exploration_eligible_since` going forward, staggered by whenever it was actually
asked) - but until enough real answers exist, the cliff is real. Left as-is deliberately: fixing it
now would mean guessing at a staggering scheme with no real sweep-rate data yet to tune it against.
Revisit once the real pre-qualification pace is known.

**The dual-write bridge was removed as the final part of this step**, once the above was verified:
`routes/visits.js`'s `maybeCapturePreQualification` no longer writes
`capacity_monthly_referrals`/`capacity_status` to `places` at all - nothing ranking-related reads
either column anymore, so there was nothing left for the bridge to bridge to.

### Judgment calls recorded here because the spec asked for them (or a spec error was caught)

1. **§13 test 2 ("Asymmetry - down") had a bucket-boundary contradiction** - its prose said
   "Declared 15, measured 0 → level high," which contradicts the spec's own §4 boundaries (medium
   is 6–15; high starts at 16). Implemented per §4 - declared 15 buckets to `medium` - since the
   invariant the test actually exists to verify (the value isn't pulled down by a low measurement)
   holds either way. Corrected directly in `capacity-computation-spec.md` §13 so this doesn't
   resurface as a live contradiction; same pattern as the 2 errors caught in the relationship spec
   (§16).
2. **`measuredFloorByPlace` reads `referrals.place_id` directly**, not the live `people.place_id`
   join `referralMetrics.js`'s own place rollup uses. Deliberate - see the "will disagree" note in
   §0 above and the addendum in `capacity-computation-spec.md` §12.
3. **Return shape extends the spec's literal §6 fields** with `computedLevel`/`isOverridden`,
   needed to satisfy §11's "show computed vs. override side by side" UI requirement, which the
   literal `level`/`levelSource` alone can't render. Mirrors `relationship.js`'s existing
   `level`/`effective_level`/`override` shape.
4. **`CATEGORY_CAPACITY_SEED` uses the real keyword table** already seeding
   `places.capacity_level` (migration `20260712000000`, tuned against this app's actual category
   strings), not the spec's illustrative placeholder categories - the spec's own text says to
   reuse whatever the app already seeds from.

### Testing

`capacity.test.js`, 12 tests, covering the in-scope spec cases (asymmetry both directions, bucket
boundaries, exposure gate, staleness, override precedence, `asOf`, bulk parity, empty case,
`nextExplorationEligibleSince`). `schedulingEngine.test.js` picked up the rest of spec §13's
EXPLORATION list (tests 7–9: ordering determinism, aging, stale-below-unknown) plus tier-membership
and tiebreak coverage, 12 new tests total there. Spec tests 10–12 (drop-off detector) intentionally
not written - they test code from step 8, not built. `npm run capacity:distribution` is the
health-check readout (mirrors `relationship:distribution`).

### Deliberately deferred - do NOT rediscover these as mystery bugs

- **Steps 6–7 are done** (see their own subsections above). **Step 8 (drop-off detector) is
  BLOCKED**, not just unstarted - it needs 455 days of dated referral history the eRSP migration
  hasn't landed yet; nothing to build against, don't pick it up speculatively. **Step 9** (drop the
  three legacy columns - all now fully unread by anything ranking-related) is unstarted, ordinary
  backlog.
- **`referralMetrics.js`'s place-level rollup was briefly logged as a bug (2026-08-07), then
  closed 2026-08-10 as working as intended** - see its own subsection below. Don't re-flag it.
- **The distribution readout validated the category-seed axis, not the 6/16 thresholds** - 99.6%
  of real places are still `category_seed`/`unknown` confidence (expected - real places, test-only
  referral/visit history). Re-check the thresholds once roughly 30 real pre-quals exist.

### `referralMetrics.js`'s place-level rollup - logged as a bug 2026-08-07, CLOSED 2026-08-10 (not a bug)

**Status: investigated, confirmed working as intended.** On 2026-08-07 this was logged as a bug -
see the git history of this section for the original writeup - after `capacity.js`'s
`measuredFloorByPlace` was deliberately built to read `referrals.place_id` directly (§18's judgment
call #2) instead of joining through `people`'s current `place_id` the way
`referralMetricsByPlaceId` does. The two systems' disagreement on job-changing contacts looked like
one of them must be wrong, and capacity's building-scoped reasoning got over-applied to
`referralMetrics.js` by analogy.

**On 2026-08-10, reviewing the proposed fix, Bede's call: the analogy doesn't hold.** A referral
relationship lives with the *person*, not the building - if a strong referral source changes jobs,
the place's displayed number should follow them to their new employer, and the place they left
should stop getting credit for a relationship that's no longer there. That's exactly what
`referralMetricsByPlaceId`'s current join does. This also isn't a new realization - mental model
principle #2 near the top of this doc ("Referrals belong to a person, never a place... if you see a
bug where a place's numbers don't match expectations, check who's currently assigned there first")
already documented this as intentional *before* the 2026-08-07 mis-scoping happened.

**Capacity and `referralMetrics.js` are correctly answering two different questions, not
disagreeing about one.** Capacity asks "how much has this *building* historically generated,"
independent of current staff - that's why it deliberately reads the frozen `referrals.place_id`
snapshot. `referralMetrics.js`'s place rollup asks "how strong is our relationship with whoever
currently works here" - that's why it deliberately follows the current roster. Both are correct for
what they measure; neither should be made to match the other.

**No code changed.** `referralMetricsByPlaceId`, `routes/places.js`'s `GET /`, and `GET /:id`'s
reduce-based summary are all unchanged and all correct as they stand. `referralMetricsByPersonId`
(the PERSON-level rollup) was never in question either way - confirmed during the original scoping
that it has no notion of "place" in its query at all.

---

## 19. Visit terminal states - `snoozed` and `skipped` (2026-08-10)

Every planned visit now resolves to exactly one of `completed`, `snoozed`, or `skipped`.
`skipped` is a passive lapse; `snoozed` is a deliberate rep deferral. Neither writes
`lastVisitedAt` or touches urgency - only `completed` does. Full build in
`server/src/services/visitLifecycle.js` (both mechanisms), `POST /api/visits/:id/snooze`
(the endpoint), and `DELETE /api/places/:id/snooze` (lifting one early).

**The encounter invariant** (worth stating plainly, since it's what made the old
`VisitDetailModal.jsx:95` bug (`trip.status !== 'planned'`, now correctly
`trip.status === 'completed'`) turn out to be unreachable rather than live): encounters only
ever come into existence through the visit log (`VisitLogModal`, which drives a visit toward
`completed`). A `planned` visit is created with zero encounters and stays that way - it can
never acquire any without becoming `completed` first, and a `skipped` visit inherits that same
empty state and has no path to gain encounters afterward either. So an empty `encounters` array
reliably means *never logged*, not *logged and then emptied down to nothing* - don't write code
that treats those two as ambiguous.

**Forced-snooze + `next_visit_date` - a decision, not a gap, don't "fix" it later.** Snoozing a
place (`POST /api/visits/:id/snooze`) is guarded against swallowing a live commitment: if the
place's most-recent-set `next_visit_date` falls on/after the chosen `snoozed_until`, the request
409s with `code: 'SNOOZE_SWALLOWS_COMMITMENT'` and the caller must confirm and resend with
`force: true`. On a forced snooze, `next_visit_date` itself is deliberately left untouched. It
usually lives on a *different, already-completed* visit row than the one being snoozed - having
the snooze endpoint reach back and rewrite that row's field to make current scheduling tidier
would mean silently revising a different record's history to keep the system convenient, which
runs against the whole detach-not-delete/audit-trail spirit of this app's data model (see mental
model point 1 near the top of this doc). Nothing is silently lost either way:
`schedulingEngine.js`'s `eligibility()` has a fixed precedence - a due commitment only bypasses
the *hard floor* guard, never the snooze guard (see that function's own comment) - so a forced
snooze suppresses the place, promised follow-up included, for the whole window on purpose. When
the snooze lapses, `next_visit_date` is still sitting there, now overdue, and the place lands
straight in `TIERS.COMMITMENT` ranked by how overdue it is - a real bonus (deferring a promise
makes it resurface hotter, not neutral), not a rationalization for leaving it alone.

**FIXED 2026-08-10** (was a known, deliberately deferred display gap): `VisitDetailModal.jsx` and
`PersonDetail.jsx` now annotate a bare `"Next visit: {date}"` line when that date falls under an
active place-level snooze OR do-not-visit - both via the new shared `suppressionNote(place)`
helper in `api.js` (also backs `isSnoozeActive`/`isDoNotVisitActive`, so every reader compares
the same way the server's `schedulingEngine.js` does). `VisitDetailModal`'s `trip` needed three
new joined columns to get there - `routes/visits.js`'s `fetchVisit()` now selects
`p.snooze_until`/`p.do_not_visit`/`p.do_not_visit_until` as `place_*` aliases, since a visit row
alone doesn't carry its place's own suppression state. `PersonDetail.jsx` needed no server
change - `GET /api/people/:id` already returns a full `place` row.

**`do_not_visit` got its own "until" date the same session (`do_not_visit_until`, migration
`20260810020000`) - see the new §19A below for the full design**, alongside consolidating both
snooze and do-not-visit's status/controls onto the Upcoming Visits card (moved off the Details
card, which only ever had the snooze half).

**`places.snooze_until` had a write path with no display anywhere until the 2026-08-10 session
that added it** - a place could vanish from routing for up to a month with literally no UI
explanation. Shown on `PlaceDetail.jsx`'s Upcoming Visits card (`"Snoozed - out of routing until
{date}"` + a `Lift snooze` button, `DELETE /api/places/:id/snooze`) whenever `snooze_until` is
still active, plus a computed `skipped_visit_count` on the Details card
(`"Skipped N times - planned, then never visited"`, plain text, no warning styling - live
`COUNT` over `visits.status = 'skipped'`, same "computed, never
stored" convention as referral metrics in §9).

**Skip-sweep mechanics, worth knowing before assuming it isn't running:** there's no cron/job
infrastructure in this app, so lapsed `planned` rows (`scheduled_date < today`, org-local) are
flipped to `skipped` by `resolveLapsedPlannedVisits()`, mounted as router-level middleware on the
three routers that actually surface a `planned` visit to a user - `routes/visits.js` (calendar,
single-visit fetch), `routes/places.js` (`GET /:id`'s `upcoming_visits` - easy to miss, not the
obvious one), and `routes/scheduleDrafts.js` (route planner committed-day views). Verified live
against synthetic lapsed rows on all three. The 47 pre-existing planned trips from §17's
2026-08-05 migration were checked as a real-world backlog test and turned out to be gone from
the dev DB already (a reset somewhere in the sessions since, not a defect in the sweep) - the dev
DB currently has 19 visits total and zero skipped rows, so don't be surprised by an empty
`SkippedVisitsModal`/zero skip counts until real usage accumulates some.

**Tests:** `snoozeSwallowsCommitment()` (the guard's actual three-branch decision - no commitment,
before it, on/after it) is unit-tested in `server/src/services/visitLifecycle.test.js`, pulled out
of the route so it's testable the same way `schedulingEngine.js`'s pure functions are. The
endpoint/middleware/sweep themselves were verified live (smoke-tested through Lisa Marks, real
HTTP calls, real browser click-through screenshots) rather than given route-level automated tests
- matches this project's existing convention (pure logic modules get `*.test.js`; routes get
smoke-tested).

---

## 19A. `do_not_visit_until` + consolidated Upcoming Visits card (2026-08-10)

Same session as §19, at Bede's follow-up request: `do_not_visit` (a plain boolean since
2026-07-12, only ever settable via a dismissible zero-capacity suggestion on `CapacityDetail.jsx`
- see §18) gained its own `until` date, and both it and snooze got a real home on
`PlaceDetail.jsx`'s Upcoming Visits card instead of a one-click-only toggle.

**Schema:** `places.do_not_visit_until` (migration `20260810020000_add_place_do_not_visit_until`),
nullable date. Same convention as `snooze_until` - never cleared automatically once it lapses,
every reader does a live `>= today` compare instead. `null` while `do_not_visit` is `true` means
indefinite; `null` while `do_not_visit` is `false` means never marked (or already lifted).

**Server:** `schedulingEngine.js`'s `eligibility()` guard changed from a bare `place.do_not_visit`
check to `place.do_not_visit && (!place.do_not_visit_until || place.do_not_visit_until >= today)`
- still excludes always, even over a due commitment, exactly like before (see that function's own
precedence comment). `routes/places.js`'s `EDITABLE` gained `do_not_visit_until` alongside the
existing `do_not_visit`, with `doNotVisitUntilError()` validating the `YYYY-MM-DD` format (or
null/'' for indefinite/clear). **The client always writes both fields together** - marking or
re-marking sends `{ do_not_visit: true, do_not_visit_until }`, lifting sends
`{ do_not_visit: false, do_not_visit_until: null }`. This isn't just tidiness: a stale
`do_not_visit_until` left over from an already-lapsed mark must never silently cap a fresh
indefinite one if only `do_not_visit` were re-sent alone.

**Client, `api.js`:** three new shared helpers so every surface computes "is this place currently
suppressed" the same way the server does - `isSnoozeActive(place)`, `isDoNotVisitActive(place)`,
and `suppressionNote(place)` (the `" (deferred by an active snooze)"` /
`" (this place is marked do-not-visit)"` suffix for a bare `"Next visit: {date}"` line, do-not-
visit taking precedence when - rare, but not disallowed - both are somehow active at once).

**Client, `PlaceDetail.jsx`:** the Upcoming Visits card head now has a `"Do not visit…"` trigger
(hidden while already active or while the panel's open); the card body shows an active-snooze
banner (moved here from the Details card, which only ever had this half) and an active-do-not-
visit banner, each with their own action(s) - snooze gets `Lift snooze` only (starting/changing a
snooze still requires opening a specific upcoming visit's own popup, since `POST /:id/snooze`
is visit-scoped by design - see §19); do-not-visit gets both `Change` (reopens the panel with a
new choice) and `Lift`. The panel itself (`DO_NOT_VISIT_PRESETS`: 1/3/6 months, deliberately
longer-scale than `UpcomingVisitDetailModal`'s own 1/2-week/1-month `SNOOZE_PRESETS` - do-not-
visit is a "stop proposing this place" call, not a short rotation nudge) plus an `Indefinitely`
button and a custom date input, same shape as the snooze panel it's modeled on.
`CapacityDetail.jsx`'s existing one-click "Mark" suggestion still works (now calls
`setDoNotVisit(null)` - indefinite) and its gating condition switched from `!place.do_not_visit`
to `!isDoNotVisitActive(place)` so it doesn't stay hidden forever after a dated mark lapses.

**Verified live** (Lisa Marks smoke-test token, real place - id 2, "Ambassador Health of
Lincoln" - reverted to its original clean state afterward): marked 1-month, confirmed the status
banner and its date; used `Change` → `Indefinitely`, confirmed the banner updated; `Lift`,
confirmed the trigger button reappeared and the banner cleared. 333 tests pass (4 new, covering
`do_not_visit_until`'s indefinite/future/on-boundary/lapsed cases in `schedulingEngine.test.js`),
client build clean.

**Deliberately not built:** no commitment guard on do-not-visit analogous to
`snoozeSwallowsCommitment()` - marking do-not-visit can silently suppress a promised
`next_visit_date` the same way an unguarded snooze would have. Not asked for; do-not-visit reads
as a more deliberate, less accidental action than a rotation snooze, so the asymmetry is a
judgment call, not an oversight. Revisit if it turns out to bite someone in practice.

## 20. Manual Visit Planning (2026-08-12)

**The zone/anchor mechanism described in this section (`is_anchor`, `pickZoneForDay`'s manual-stop
branching, the live detour-cost estimate, the ⚓ Anchored toggle) was removed the same day, a few
hours later - see §20A.** Bede's call: too much coupling between the planner and a human's own
decision. Kept below as a record of what was built and why, not as current state; the plain
Manual Visit Planning feature itself (plan a real visit directly, no draft) is unaffected and
still exactly as described here.

### Why

Before this, the only path to a `status: 'planned'` visit was committing a route-planner draft -
there was no way to say "I'm going to Tabitha on Thursday" without asking the planner to agree
first. `VisitLogModal` hardcodes `status: 'completed'` on save, so it could never produce a
`'planned'` row either. Manual planning inverts that: the human decides, a real `visits` row is
created directly, and the generator arranges itself around it. This is a genuinely different
object from a place commitment (`§16`'s replacement of `next_visit_date`, later) - a commitment
obligates the planner to produce a stop on a date; a manual visit *is* the stop.

### Schema (2 migrations, `20260812000000`–`20260812010000`)

`visits` gained three columns: `planned_manually` (integer 0/1, NOT NULL default 0 - the first
migration added it as a text `origin` column with `'draft'`/`'manual'` values, which turned out to
collide in meaning with the pre-existing `source` column; the second migration renamed it to this
boolean-style int instead, see that migration's own header for the full reasoning), `is_anchor`
(nullable integer - `NULL` = no generation has run against this day yet, `1` = anchored, `0` =
explicitly floated; a plain boolean default can't distinguish "never asked" from "asked and
declined", which is what the zone-conflict logic below needs), and `created_by_user_id` (who
*planned* the visit - always the authenticated caller, backfilled to each row's own `user_id` -
distinct from `user_id`, who the visit is *for*, since any rep may plan for any other rep).

**`planned_manually` is not the same axis as the existing `source` column.** `source` is
`'planner'` (committed from a route-planner draft) vs `'manual'` (the DB default, everything
else - including ad-hoc "Log a visit" entries). `planned_manually` answers a narrower question:
was this specific row created through the new manual-planning feature. An ad-hoc-logged completed
visit has `source: 'manual'` and `planned_manually: 0` - both true at once, meaning different
things. Don't conflate them.

### Server

`services/manualVisits.js` is a **policy layer over `services/conflictDetection.js`**, not a
second detector - that module already computed every finding needed
(`SAME_DATE_VISIT`/`FLOOR_COMPLETED`/`FLOOR_PLANNED`/`DRAFT_ELSEWHERE`) at the right threshold
(`HARD_FLOOR_DAYS` was already 5). The only new code is which findings **block** vs **warn**, and
that split is deliberately different from the existing ad-hoc "Log a visit" route
(`routes/visits.js`'s `POST /`): `DRAFT_ELSEWHERE` is a soft warning there, but a **hard block**
for manual planning (`createManualVisit`/`rescheduleManualVisit`'s `classifyConflicts`). Same
finding, two different policies depending on which surface is asking - this is intentional, not
drift, and there's a test (`manualVisits.test.js`) asserting the divergence explicitly so it stays
visible if either policy changes later.

**One visit per place per day, full stop - deliberate policy, not an oversight.** Two reps at the
same large multi-department facility on the same day is blocked exactly like anywhere else. If
this ever gets "fixed" to allow it, that's a real product decision, not a bug fix.

Endpoints: `POST /api/visits/manual` (create), `PATCH /api/visits/:id/reschedule` (re-runs every
check against the new date, resets `is_anchor` to `NULL` on any real move - deliberately its own
endpoint rather than folded into the generic `PATCH /api/visits/:id`, since that route has no
warn-then-confirm response shape and was never built for one). Delete reuses the existing
`DELETE /api/visits/:id` with one added permission clause: a manually-planned, still-`'planned'`
visit's **creator** may also delete it on the assignee's behalf (cross-rep planning, see below) -
scoped to `planned_manually && status === 'planned'` so a completed/skipped visit still falls back
to the ordinary assignee-only rule. The anchor toggle reuses the generic `PATCH` too (`is_anchor`
added to `EDITABLE`) - toggling "recomputes nothing," it only changes what the *next* reoptimize
does, so there's no side effect for a dedicated endpoint to own.

**Cross-rep planning:** `user_id` is the assignee, `created_by_user_id` the planner, and they can
differ. The assignee may always edit or delete; the creator may additionally delete (not edit) a
visit planned for someone else; a third rep can do neither. **Known gap, not built:** no
notification. If Nikki plans a stop on Lisa's Thursday and Lisa never opens that day, it lapses to
`skipped` (the existing skip sweep, unchanged) and Nikki has no idea - there's no notification
infrastructure and no dashboard yet. The "manually planned by {Name}" marker (`RoutePlanner.jsx`'s
committed rows, `PlannedDayModal.jsx`'s rows, the Calendar tab via the same modal) is the entire
mitigation for now. **This is a real dashboard requirement once one exists**: cross-rep planned
visits assigned to you need surfacing somewhere the assignee will actually see it.

**Generator integration (`schedulingEngine.js`, `scheduleGenerator.js`, `scheduleDraft.js`):**

- *Hard exclusion.* A place with a visit already planned exactly `today` is now an **unconditional**
  eligibility exclusion (`schedulingEngine.js`'s `eligibility()`, new `already_planned_today`
  reason), checked *before* the due-commitment exemption is even evaluated. This closes a real gap
  found live: the pre-existing floor logic already excluded a same-day planned visit via the
  ordinary 5-day floor (`daysApart === 0` always trips it) - but a due commitment bypasses that
  floor, so a place with **both** a due commitment **and** an already-planned visit today stayed
  eligible and could have been proposed a second time on the same day it was already booked. Not
  hypothetical - manual planning makes "a place with both" a normal occurrence, not an edge case.
- *Zone/anchor decision* (`scheduleGenerator.js`'s `pickZoneForDay`, called from `generateDraft`'s
  per-day loop): no manual stop → unchanged. Manual stop whose region already matches the
  algorithm's natural pick → silent, `is_anchor = 1`, no interruption. Manual stop in a **different**
  region → the day silently generates in the *manual stop's* zone instead (still no blocking
  prompt - generation itself must never interrupt), `is_anchor = 1` for it. An explicit zone
  override (an earlier "Somewhere else" pick, replayed on regenerate) always wins outright, never
  second-guessed by this logic - but anchor bookkeeping still updates to match reality.
- *Live detour cost* (`scheduleDraft.js`'s `getDayZones`, extended response: `{ list, anchor,
  alternative }`): when there's a real zone conflict, an extra real-optimizer round-trip computes
  how many minutes the algorithm's zone would cost if picked instead (fills that zone without the
  manual stop, then re-evaluates with it inserted as an already-committed leg, subtracts the
  stop's own fixed visit/prep/data-entry time to isolate drive-only cost). **Never cached** - same
  "recompute live on every read" convention `loadDraftView`/`loadDraftDayView` already use - so
  it can't go stale, but it does mean the number can take several real seconds to appear (verified
  live: sub-second normally, but this specific field waited ~5–10s behind two chained OSRM calls).
  `RoutePlanner.jsx`'s existing "Somewhere else" dropdown (`InlineDropdown`) is where this
  surfaces - no new modal, per the spec's explicit instruction to reuse it. Picking the
  alternative zone from that same dropdown (`selectDayZone`) is what actually flips `is_anchor` to
  `0`; picking the anchor's own zone (or the silent no-conflict path above) sets it to `1`.
- *Reoptimize* (`scheduleDraft.js`'s `reoptimizeDay`): when an anchored manual stop exists for the
  date, the OSRM `/trip` call now starts from **the anchor's own coordinates** instead of
  `homeBase` - same idea `evaluateDay` already applies to the *displayed* estimate (a committed
  segment's real end point, not home, is where a proposed stop's drive time is measured from),
  extended here to the actual routing call so the optimized *order* reflects it too. A floating or
  absent manual stop changes nothing - ordered exactly as before.
- *Joining the draft*: a manual visit never becomes a `schedule_draft_stops` row - it's already a
  real `visits` row, so it simply shows up via the existing `committed` list (`committedVisitsQuery`/
  `committedDayVisits`, both extended with `planned_manually`/`created_by_user_id`/
  `created_by_name`/`is_anchor`) alongside whatever the generator proposed. The route **never
  auto-reoptimizes** - adding/discovering a manual stop leaves existing draft order untouched;
  reordering only ever happens on an explicit "Re-optimize route" click.

**A second live-smoke-test-only bug, unrelated to the generator, also had to be fixed to make any
of the above reachable at all:** `committedDateSummaries` (which `validateDays` uses to reject
re-picking an "already committed" date) and `deleteCommittedDay` both queried `visits` with no
`source`/`planned_manually` filter. Before this feature, that was harmless - no `status: 'planned'`
row could exist without `source: 'planner'` (`VisitLogModal` always saved `'completed'`), so the
gap was dead code. The moment a manual visit could exist, it broke immediately: a fresh manual
visit alone made `/generate` 400 with *"already has committed visits"* (caught live, mid-smoke-test
- see `committedDateSummaries`'s own comment), and `deleteCommittedDay` would have silently deleted
a rep's deliberately-planned manual visit as collateral damage of "undo this day's commit."
Fixed by excluding `planned_manually` rows from the summary and scoping the delete to
`source: 'planner'` - the exact same tag `commitDay`/`reopenCommittedDay` already use for
identical reasons.

### Client

Three surfaces, matching the spec's explicit scoping - **no new button in the route planner**: it
already has "Add a stop" (adds to the *draft*, commits later), and a second same-named control
that writes a real row immediately would be a same-name-different-consequence trap. The planner's
only changes are display (below).

- **`PlaceDetail.jsx`**: a "Plan a visit" control in the Upcoming Visits card, right beside
  `PlaceCommitments.jsx`'s own "Add…" - same inline-toggle-reveals-a-row-of-inputs shape
  (date + rep picker, defaulting to self), same warn-then-`force`-confirm flow
  `api.planVisit`/`api.rescheduleVisit` return.
- **`VisitsCalendar.jsx` / `DayOverflowModal.jsx`**: genuinely new UI - the day-number drill-down
  popover had no add affordance at all before this. Reuses `ui/PlacePicker.jsx` (the same
  searchable picker `RoutePlanner.jsx`'s own "Add a stop" already used) plus a rep `<select>`.
- **`RoutePlanner.jsx`**: display-only. Committed rows show "manually planned", or "manually
  planned by {Name}" when the creator differs from the assignee (one phrase since 2026-08-25 - see
  the dated entry near the top); a manually-planned row gets an anchor
  toggle button (⚓ Anchored / Anchor); the day header's zone dropdown carries the live detour-cost
  line described above. `PlannedDayModal.jsx` (shared by the Calendar tab's own "already planned"
  drill-down) got the same manual/cross-rep marker on its rows.

### Testing

420 backend tests pass (client build clean) as of this section. New coverage added for this
feature: `manualVisits.test.js` (29 tests - policy divergence, all four §4.1/
§4.2 conditions, cross-rep creation, permissions matrix, reschedule collision/anchor-reset/block-
release), `schedulingEngine.test.js`'s new `already_planned_today` describe block (the commitment-
bypass regression), `scheduleGenerator.test.js`'s `pickZoneForDay`/`generateDraft` manual-stop
describe blocks (11 tests), `scheduleDraft.test.js`'s `manualStopsForDates` and
`committedDateSummaries` describe blocks (7 tests). **Verified live** end-to-end (Lisa Marks
smoke-test token, real places, reverted after): plan → same-day/draft-elsewhere hard blocks →
reschedule → generate with a real zone conflict (confirmed `is_anchor` persisted, confirmed the
live detour number, confirmed picking the alternative zone flips the anchor) → reoptimize with an
anchor present → all three client surfaces screenshotted and visually confirmed rendering
correctly (`PlaceDetail`'s Plan-a-visit panel, the Calendar day-popover's Plan-a-visit + place
search, `RoutePlanner`'s manual/cross-rep/anchor markers and the detour message).

### Deliberately deferred - do NOT rediscover these as mystery gaps

- **No notification infrastructure for cross-rep planned visits** (see above) - a real dashboard
  requirement, not yet built because the dashboard itself doesn't have a slot for it yet.
- **`snoozed` visits are invisible on the Calendar tab.** Pre-existing, unrelated to this feature,
  but surfaced again while working in this area: `VisitsCalendar.jsx`'s `splitDayVisits` explicitly
  drops `'snoozed'` status from every pill bucket (see that function's own comment - a snoozed
  visit never gets a new `scheduled_date`, so there's no date on the calendar that's honestly
  "about" the snooze). The only place a snooze is visible today is `PlaceDetail.jsx`'s own banner.
  Not part of this build; worth fixing on its own if it comes up.
- **Multi-rep same-day visits to one building** - blocked by policy, see above. Not a bug.
- **Recurring manual visits** - out of scope, never discussed as a requirement.
- **Auto-reoptimize on any event** - always user-initiated, by design (§8's "do not auto-reshuffle"
  applies to anchor deletion/toggling too, and generation itself never reoptimizes an
  already-generated day just because a manual stop showed up on it).

## 20A. Manual Visit Planning simplified - zone/anchor mechanism removed (2026-08-12)

### Why

A few hours after §20 shipped, Bede's read on it: "too much and too hard to understand." His
framing, verbatim intent: the route planner's only job is to propose an optimal day given
constraints; a manually-planned visit is the human's own decision and should always trump the
algorithm. The two should never be *combined* - once a visit is planned, by any means, it should
be treated exactly like any other already-planned visit, and the planner should just naturally
work around it using the plain rules it already has (don't propose a second visit to a place
already being visited that day; warn, don't block, inside the 5-day floor). No merging, no
anchoring, no live detour-cost math, no UI for any of it. See the `feedback_route_planner_proposals_only`
memory for the durable principle this cemented.

### The fix was one pivot, not a rewrite

`scheduleDraft.js`'s `committedDateSummaries` used to carve manual-only dates out of "already
committed" specifically so `/generate` could still run on them (that's what the whole anchor
mechanism needed room to operate in). Removing that carve-out - a manual visit now counts toward
"already committed" exactly like a planner-committed one - was the entire behavioral fix: a
manually-planned date now shows as already-planned in the calendar and `/generate` rejects it
outright, same as any other committed date. The planner simply never runs on it, so there's
nothing left to anchor a zone choice around.

### What got deleted

Everything downstream of that pivot became unreachable and was removed outright, not left as dead
code: `scheduleDraft.js`'s `manualStopsForDates` (deleted entirely), the anchor-writeback loop in
`generateAndPersistDraft`, the live detour-cost branch in `getDayZones` (now returns just
`{ list }`), the writeback loop in `selectDayZone`, the anchored-start-point override in
`reoptimizeDay`, `manualStopBlockMinutes`; `scheduleGenerator.js`'s `pickZoneForDay` (simplified to
`explicitZone || algorithmZone`, no more `manualStops`/`anchorUpdates`) and `generateDraft`'s
`manualStopsByDate` param; the `is_anchor` column itself
(`20260812020000_drop_visits_is_anchor.js` - no FK, plain drop); `routes/visits.js`'s `is_anchor`
`EDITABLE` entry/validation/`GET /calendar` select; `manualVisits.js`'s `is_anchor: null` on
create/reschedule; `RoutePlanner.jsx`'s Anchor/⚓ toggle and the "switching to X adds ~N min"
banner (the "manually planned"/"planned by {name}" text markers stayed - those are unrelated
display, not part of the mechanism).

**Confirmed explicitly out of scope / untouched**, since it's easy to assume this was a bigger
change than it was: `deleteCommittedDay`/`reopenCommittedDay`'s `source: 'planner'` scoping
(already excluded manual visits from whole-day bulk actions on a mixed day - nothing to fix
there); `evaluateDay`'s general committed-time budget math (a separate, pre-existing mechanism
`getDayZones`' deleted code was just reusing for a one-off estimate); `schedulingEngine.js`'s
`already_planned_today` hard exclusion and the plain 5-day floor warnings (place-level,
source-agnostic, completely separate code path - this is exactly the "regular rules" the pivot
above now leans on).

**One real gap the pivot exposed, and had to be fixed as part of the same change:** a manual-only
day is now reachable in the "Already Planned" drill-down (`PlannedDayModal.jsx`), whose whole-day
Discard plan/Edit buttons are scoped server-side to `source: 'planner'` - for a manual-only day
that meant Discard silently deleted zero rows (looked like success, wasn't) and Edit 404'd.
Fixed: those two buttons now only render when the day has at least one non-manual visit; falls
back to a bare Close otherwise. Per-visit delete (see below) is the correct action there instead.

### Also shipped this same day, separate from the anchor removal

- **Individual delete for a still-planned visit.** `DELETE /api/visits/:id` already worked for any
  visit, but no UI exposed it for an upcoming (not-yet-completed) one - only completed Visit
  History rows had a delete button. Added to `UpcomingVisitDetailModal.jsx` (an `onDelete` prop,
  omitted in read-only contexts, same "omit the prop to omit the action" convention
  `onComplete`/`onSnoozed` already used), wired through every caller (`PlaceDetail.jsx`,
  `PlannedDayModal.jsx`) to each one's existing `removeVisit`.
- **`PlanVisitModal.jsx`** replaced two separate cramped inline forms (§20's client section above
  is now stale on this point) with one shared, dual-mode modal: pass `placeId`/`placeName` to fix
  the place (`PlaceDetail.jsx`'s "Plan a visit…" button - now living in the Upcoming Visits
  card-head next to "Do not visit…", not its own row down in the body), or pass `date` to fix the
  date instead and let the user pick a place via `ui/PlacePicker.jsx` (`DayOverflowModal.jsx`'s
  calendar day-drill-down "Plan a visit…" button, which lost its own inline
  place-picker-plus-rep-select form in the same change). `PlacePicker.jsx` gained an `autoFocus`
  prop for this. One real bug caught and fixed: `DayOverflowModal` closes itself on any
  document-level `mousedown` outside its own popover DOM; since `PlanVisitModal` isn't nested
  inside that popover, interacting with it would have bubbled up and silently closed the popover
  (and the modal along with it) on the very first click. Fixed with
  `onMouseDown={(e) => e.stopPropagation()}` on the modal's own backdrop.
- **Notes field** on manual planning: `createManualVisit` accepts an optional `notes` param
  (`routes/visits.js`'s `POST /manual` passes `req.body.notes` through), surfaced as a textarea in
  `PlanVisitModal`. No new display code needed - `UpcomingVisitDetailModal.jsx` already rendered
  `visit.notes` when present.
- `.day-overview-plan` (the "Plan a visit…" button's wrapper in `DayOverflowModal`'s popover)
  gained a top border + margin in `styles.css` - it used to sit flush against the pill list (or
  the empty state) above it with no visual separation.

### Testing

406 backend tests passing after the removal (down from the 420 §20 reported, net of the deleted
`pickZoneForDay`/`manualStopsByDate`/`manualStopsForDates` describe blocks minus the few rewritten
in place - `committedDateSummaries`' own describe now asserts the OPPOSITE of what §20 built:
a manual-only date is present in the summary, not absent). Client build clean. Verified live
end-to-end in the browser (Lisa Marks smoke-test token, reverted after) for every piece above:
the calendar's Plan-a-visit modal staying open through a place search, notes round-tripping onto
`UpcomingVisitDetailModal`, and the two relocated/spaced buttons in `PlaceDetail`/`DayOverflowModal`.

> **Stale as of §20B below**: that last sentence describes the state right after this section's
> own pivot - `committedDateSummaries` gated on *any* status:'planned' visit, manual included. §20B
> reversed that a second time (a manual-only date going back to NOT gating in, same direction as
> §20's original design, for an unrelated reason). Don't treat this paragraph as current behavior.

## 20B. Reschedule generalized into a full edit, day-selection reopened, generation-time budget packing, Dashboard integration (2026-08-15 - 2026-08-21)

This section fills a real gap: three shipped commits after §20A landed with no HANDOFF write-up
at all (`638ee89`, 2026-08-15; `e4ca4fd`, 2026-08-21) - the only trace of most of this was inline
code comments. Caught during an unrelated deep-dive audit of Manual Visit Planning, 2026-08-22.

### Reschedule generalized into a full edit, with promotion (`638ee89`, 2026-08-15)

`services/manualVisits.js`'s reschedule-only endpoint/service was replaced outright by
`editVisit`/`PATCH /api/visits/:id/edit` - same §4 conflict-recheck-on-date-change behavior, but
now also accepts `notes` and `visit_type`, and applies to **any** still-`planned` visit, not just
one that started `planned_manually`. This is the one endpoint in the app that can turn a plain
route-planner-committed stop into a manually-planned one: on ANY successful save through it -
even a notes-only edit with no date change at all - the visit is promoted (`planned_manually: 1`,
`source: 'manual'`, `created_by_user_id` backfilled if it was never set). Only the visit's
ASSIGNEE may call it (`canEditManualVisit`). See `manualVisits.js`'s own `editVisit` comment for
the full reasoning, and §20C below for a real bug this promotion caused, found and fixed later.

Same commit, unrelated cleanup while in the area: `PATCH /api/visits/:id` (the plain endpoint
`VisitLogModal` uses to log/complete a visit) no longer blocks completing a teammate's
still-`planned` visit - it always saved `status: 'completed'` regardless of starting status
anyway, so the block was answering a question nobody asked; reassigning WHO or WHEN a visit is
for is what the new `/edit` endpoint governs instead, and that stays assignee-only. `PlaceDetail`'s
visit history also started including skipped visits alongside completed ones (tagged), dropping
the separate `skipped_visit_count` rollup.

### Day-selection reopened a second time + generation-time budget packing (`e4ca4fd`, 2026-08-21)

Two related fixes to `scheduleDraft.js`, landed the same commit as the Dashboard work below:

1. **`committedDateSummaries`'s gate went back to excluding a manual-only date** (same direction
   as §20's original design, opposite of §20A's pivot, for an unrelated reason this time - not a
   third reversal of the same argument, a distinct bug): a day already carrying a manually-planned
   visit no longer blocks that date from being selected for `/generate` - only a date with a real
   *planner-committed* visit does. The gate query changed from "does this date have any
   `status:'planned'` row" to "does it have one with `source: 'planner'`"; the returned COUNT stays
   unscoped (every visit on the date, any source), so a day mixing a manual visit with a
   planner-committed one still shows the right total in "Already Planned" - see that function's own
   comment for the reasoning this superseded.
2. **`generateAndPersistDraft` now pre-subtracts a day's already-committed minutes on the FIRST
   fill**, not just at view/reoptimize time: it computes each date's committed minutes up front
   (via `evaluateDay`'s existing committed-segment math, real OSRM when available) and passes
   `committedMinutesByDate` into `scheduleGenerator.js`'s `generateDraft`, which now does
   `budgetMinutes = Math.max(0, hoursPerDay*60 - (committedMinutesByDate[date] || 0))` per day
   before packing. Deliberately budget-only - zone selection and a proposed stop's drive-time start
   point stay exactly as if the committed visit didn't exist, keeping this on the safe/arithmetic
   side of the "never merge/anchor" principle in §20A, not the location-coupling that principle
   actually bans.

### Dashboard interactivity + visit-type capture (`e4ca4fd`, 2026-08-21)

- **Dashboard's Today card is a normal, fully-interactive surface now**, not read-only: clicking a
  visit opens the same log/snooze/edit/delete `UpcomingVisitDetailModal` every other screen uses;
  "View all stops" opens today's full list in `PlannedDayModal`, with a working whole-day Edit
  (`reopenCommittedDay` - pulls today's visits back into an editable Route Planner draft, then
  hands off to the Planner tab since the Dashboard has no draft workspace of its own to show the
  result in) and Discard.
- **`PlanVisitModal` and `UpcomingVisitDetailModal`'s edit panel both gained a Visit type field**,
  threaded through `POST /visits/manual` and `PATCH /:id/edit` - previously a manually-planned
  visit could only ever get a type via the "add a stop" capacity-based default, never chosen
  directly.

## 20C. Bug fix: a hand-edit could silently unlock an already-committed day (2026-08-22)

### The bug

Found during a code-review deep-dive of the whole feature, then confirmed with a live repro
script against the real services (not just reasoning from the code) before being fixed.

`editVisit`'s promotion (§20B above) flips `source` to `'manual'` on **any** successful save,
including a pure notes or visit-type edit with the date unchanged. `committedDateSummaries`'s gate
(§20B above) decided whether a date counted as "already committed" - locking it out of a fresh
`/generate` - by checking for a `source: 'planner'` row. Put those two together: if a rep opened
the day's only planner-committed visit and fixed a typo in its notes, `source` silently flipped
away from `'planner'`, the date dropped out of the gate, and the Route Planner's own date-picker
(`RoutePlanner.jsx`'s `committedDates`) showed that day as open again for a brand-new `/generate` -
even though the original visit was still sitting there, unresolved. Confirmed live: blocked before
the edit, freely selectable after, from a notes-only save.

Not a data-corruption bug - the generator's other safety nets (`lockedElsewherePlaceIdsByDate`,
`committedMinutesByDate`) are unscoped by `source`, so a fresh generate on that date still
wouldn't re-propose the same place and would still account for its time correctly - but the
"this day is locked, the planner won't touch it" guarantee the gate exists to provide silently
stopped being true, from an edit that looked completely unrelated to scheduling.

### The fix

New column `visits.planner_committed` (migration `20260822000000_add_visits_planner_committed.js`,
backfilled from the existing `source = 'planner'` rows) - a permanent birth fact set once by
`commitDay`'s insert and never touched again by anything, including `editVisit`'s promotion.
`committedDateSummaries`'s gate now checks `planner_committed: 1` instead of `source: 'planner'`,
so it can no longer be erased by an unrelated later edit. `source` itself is untouched and still
means exactly what it always has (including as the scoping column for the
`visits_place_date_active_unique` partial index, and for `reopenCommittedDay`'s "can this row be
pulled back into a re-orderable draft" question, which is correctly a different question - a
hand-edited visit should stay excluded from reopen, and does).

**Left deliberately unfixed, flagged rather than silently expanded into**: the
`visits_place_date_active_unique` partial index (`WHERE ... source = 'planner'`) also stops
protecting a promoted row once it's been hand-edited - a second rep could theoretically win a
same-place-same-date race against it at the exact moment of a `commitDay` insert. This is
pre-existing (true regardless of this fix) and much narrower than the bug above: the app-level
pre-check (`committedElsewherePlaceIds`, unscoped by source) already blocks a normal-latency
double-book; only the sub-millisecond TOCTOU backstop for that one already-promoted row would be
missing. Touching a live unique index is a bigger, riskier change than this fix warranted -
revisit only if it ever actually bites.

New tests: `scheduleDraft.test.js`'s `committedDateSummaries` describe block gained a case proving
a notes-only `editVisit` no longer drops a date out of the gate; `manualVisits.test.js`'s
promotion describe block gained a case proving `planner_committed` survives the promotion
untouched. 488 backend tests pass (up 2, both new), client build clean.

## 21. Settings page - every tunable constant, editable and explained (2026-08-17)

**Full write-up lives in `SETTINGS_PAGE.md`** - the inventory of all 76 tunables, the file map,
how to add a new one, and the testing record. This is the short version; when the two disagree,
that file is the one to trust.

Four config modules each carried a header promising "a future settings-table phase can lift these
out without touching the engine itself." This is that phase. Bede asked to see and edit every
tunable constant so the algorithm can be tuned over time, and - explicitly - to never be in the
dark about what a number he's editing does.

**Three layers.** `config/*.js` holds the shipped defaults and is never edited at runtime; the
`settings` table holds *only* what the user actually changed; `config/tunables.js` holds the
meaning (label, help, raise/lower effects, bounds, legal values). So "reset" is a DELETE, a
removed tunable leaves a harmless orphan row that `loadSettings` warns about and skips, and the
client renders itself entirely from the server payload with no field list of its own.

**How an override lands.** `loadSettings()` runs before `app.listen` and writes each override
*into* the live config module object, mutating in place. Nothing downstream needed rewiring.

> **THE ONE RULE:** a tunable must be read at CALL time. `const { X } = require('../config/foo')`
> captures the default at require time and ignores every override forever, silently. Read
> `cfg.X` inside the function.

**What moved.** Three new config modules extracted so their contents could be registered:
`config/relationship.js` (~17 consts out of `services/relationship.js`), `config/planning.js`
and `config/referrals.js`. `RoutePlanner.jsx` dropped its three hardcoded copies of the
planning bounds - they had a "mirrors scheduleDraft.js" comment, exactly the pairing that drifts
once one side becomes editable - and now reads them via `hooks/useTunables.js`.

**Two non-scalar tunables got real editors:** the category→capacity rules are an ordered keyword
table (order is part of the setting, first match wins) rather than raw regex input, and
fast-decay categories are a multi-select over the real `categories` table because those match
names exactly and a near-miss fails silently.

**UI.** Gear button in the header, left of the profile avatar. Deliberately not a tab. Sidebar of
7 sections with per-section "changed from default" badges, one section shown at a time, each
tunable a block with help plus Higher:/Lower: consequence lines. `CADENCE_DAYS` renders as the
3x3 grid it actually is, so a mis-tuned inversion is visible at a glance.

**Testing.** 443 backend tests passing (up from 418), including four registry-integrity guards
(every field resolves, every field has help, every numeric field is bounded and its own default
fits inside those bounds, every default validates). Verified live in the browser end to end, and
boot resilience exercised against orphan/invalid rows. See `SETTINGS_PAGE.md` §10.

## 22. Visits tab - search/filter/paginate over every visit ever recorded (2026-08-22)

Sixth tab (`Dashboard | Route Planner | Calendar | Visits | Places | People`), added because
every other visit surface in the app is a keyhole onto one slice: Calendar is one month bucketed
by day, PlaceDetail/PersonDetail are one place/person, Dashboard is today+this week. Nothing
before this could answer "every skipped pre-qualification in July" or list a visit across a date
range spanning months. It's a LENS, not a new way to mutate a visit - every plan/log/edit/snooze/
delete action here is the exact same modal (`PlanVisitModal`, `VisitDetailModal`,
`UpcomingVisitDetailModal`, `VisitLogModal`) every other tab already uses; row-click just opens
whichever one matches that row's status.

**Two statuses were invisible anywhere in the UI before this**, and this tab is now the only
place either can be seen:
- `snoozed` - `VisitsCalendar.jsx` deliberately drops these from the month grid (a snooze never
  moves `scheduled_date`, so there's no day on the calendar that's honestly "about" it).
- `skipped`, across more than one day at a time - the Calendar only ever shows one day's worth
  in its drill-down.

**Server: `GET /api/visits`** (`server/src/routes/visits.js`, registered just before the existing
`GET /calendar`) - new `server/src/services/visitQuery.js` does the work, following the same
pure/impure split as `manualVisits.js`/`conflictDetection.js`:
- `parseVisitListParams(query)` - pure validation/normalization/clamping (limit 1-200, default
  50; malformed dates/unknown status/unknown sort all throw a 400).
- `applyVisitFilters(qb, params)` - the ONE WHERE-clause builder, shared by the page query, the
  total count, and the status summary, so those three can never disagree. Every encounter-based
  filter (`personId`, `outcome`, `metWith`, `theyRequested`) and `madeCommitment` uses
  `whereExists`, never a join - a join would fan a trip with N matching encounters into N
  duplicate rows and inflate the count.
- Every sort tiebreaks down to `v.id`, or LIMIT/OFFSET pagination would skip/duplicate rows
  across pages whenever the primary sort key ties (routine - same-day visits are the normal
  case).
- LEFT JOINs throughout (detach-not-delete: a visit outlives its place/rep). A place-attribute
  filter (`category`/`tier`/`region`) therefore naturally excludes a detached visit - intended,
  not a bug, and called out in the client's own row rendering (`(place deleted)`).

**Deliberate summary semantics**: `summarizeVisits` applies every filter EXCEPT `status`, so the
four status counts (`planned`/`completed`/`skipped`/`snoozed`) act as a stable segmented control
- clicking "Skipped" narrows the table below without the other three numbers jumping. The
summary strip is captioned "Across all statuses matching these filters" so this doesn't read as
a contradiction against the table's own (status-respecting) total.

**Client** (`client/src/components/Visits.jsx`): filter bar modeled on `Places.jsx` (debounced
200ms, `requestIdRef` stale-response guard, `rows` never nulled on refetch). Five quick-filter
chips (Today / This week / Upcoming / Skipped / Snoozed) each set `{status, from, to}` as one
patch, clearing the other two fields so they can't silently combine; "Mine" is a sixth, independent
toggle on `userId`. "More filters" discloses type/outcome/met-with/category/tier/region/origin/
planned-by plus three checkboxes.

Pagination is a growing LIMIT at `offset: 0` (`PAGE_SIZE * pagesLoaded`), not real OFFSET paging -
"Load more" and "refresh after a mutation" are the same request shape, and a refresh after
editing/logging/deleting a row re-fetches exactly what's already on screen instead of resetting
scroll to page 1. If a mutation moves the open modal's row out of the current filter, the modal
closes itself once the refetch confirms the row is gone (same pattern as `VisitsCalendar.jsx`'s
`completedDate` effect).

Filter state (`DEFAULT_VISIT_FILTERS`, exported from `Visits.jsx`) is lifted into `App.jsx` for
the same reason `calendarScope` already is: the tab unmounts entirely on every tab switch, so a
local `useState` would silently reset a hard-won filter set. Reset on logout alongside
`calendarScope`.

**No new client-side permission gating** - buttons are offered unconditionally and a denial
surfaces as the modal's own inline error or a `window.alert`, exactly like `VisitsCalendar.jsx`/
`Dashboard.jsx` already do for the same modals. Reproducing the edit/delete permission matrix
(`manualVisits.js`'s `canEditManualVisit`/`canDeleteManualVisit`, the route handlers' own
ownership checks) as a second, client-side copy here would be exactly the kind of drift this
codebase's services already avoid.

**Refactors along the way**: `encounterSummary` (the "with Flibber Gibblits and a staff member"
one-liner) moved from a private `PlaceDetail.jsx` helper into `VisitDetailModal.jsx` and exported
- that file's header comment already claims to be the one home for this vocabulary, and a third
consumer (this tab) needing its own copy was the drift that comment warns against.
`SkippedVisitDetailModal.jsx` was renamed to `ResolvedVisitDetailModal.jsx` and generalized to
render either terminal status (`skipped` or `snoozed`) off `visit.status`, since a fourth status
existed with no viewer before this tab needed one; both existing call sites
(`VisitsCalendar.jsx`, `PlaceDetail.jsx`) updated, behavior unchanged for `skipped`.

**Testing**: `server/src/services/visitQuery.test.js`, 29 new tests (in-memory sqlite, no
require-cache trick needed since `visitQuery.js` takes `db` as a parameter rather than requiring
the module-level singleton) - covers `parseVisitListParams`'s validation, every filter alone and
combined, the anti-fan-out regression (an encounter filter on a trip with 3 encounters returns
the trip exactly once), pagination disjointness, a detached visit's visibility rules, and the
summary's status-independence. 517 backend tests passing total. Verified live in the browser
(Playwright + system Chrome, per the existing local-testing convention) against real data -
confirmed both actual snoozed visits in the dev DB are now visible for the first time anywhere in
the app.

---

## 23. Tier and ⭐ Priority retired - the capacity rating (2026-08-23)

Replaces `places.tier`, `places.is_priority` and `places.priority_score` with a single human
capacity rating, `places.capacity_seed`, which feeds the computed capacity axis (§18) instead of
a tie-break almost nothing read.

### Why

`services/priority.js` turned tier (1/2/3) plus the ⭐ flag into a 100/75/50/25 `priority_score`.
Two problems, both structural:

1. **It was a four-level scale wearing a three-level costume.** All 23 starred places were tier 1,
   so the pair had exactly four realised states. The checkbox looked orthogonal and never was.
2. **It fed almost nothing.** `priority_score` was the EXPLORATION tier's second sort key and the
   Places directory's default sort. That was the entire consumer list - its own header comment
   admitted the intended referral-history feedback loop "isn't wired in yet," and it never was.

Meanwhile capacity - one of the two axes of the cadence table - had *no* human input at all. A
place that had never been pre-qualified fell all the way through to a keyword match on its
category name (`CATEGORY_CAPACITY_SEED`), which governed **99.2% of the book**. So the rep's own
read on each place was being discarded while a keyword guess drove the routing.

Bede confirmed 2026-08-23 that tier meant "how much business could this place send us" - word for
word `capacity.js`'s own locked definition. Tier was never a separate axis that correlated with
capacity; it *was* a capacity reading. This moves it to where it counts.

### The resolution ladder (`computeCapacityPure`)

A third rung between the two that existed:

1. `declared` - a real pre-qual answer. **Supersedes the rating outright.**
2. `seed` - the rep's rating, standing in until a real answer exists.
3. `category_seed` - the keyword guess, now a genuine last resort.

`measuredFloor` still raises whichever rung won, through the same `Math.max`. **The asymmetry
invariant is untouched.**

**Why precedence and not a max** (the thing most likely to get "helpfully" refactored): `declared`
and `measuredFloor` measure genuinely different quantities - "total to anyone" vs "just to us" -
which is why neither may correct the other downward. `declared` and `seed` measure *the same
quantity*, so once the place has actually told us, the guess has nothing left to contribute in
either direction. There's a test named for this.

### The rating does NOT decay, and that is the design

`relationship_seed` (§16) decays because a relationship score *is* a decaying quantity. Capacity
is a **rate**. A place that could send 10 a month does not become a 3-a-month place because time
passed, so decaying this would silently demote the entire book - the exact opposite of the
ratchet-only invariant.

What expresses "this is still only a guess" is **`confidence`, which the rating never touches**. A
rated place stays `unknown`, stays in the EXPLORATION tier, and stays queued for real
pre-qualification. The rating makes its *cadence* honest today without making the ranker believe
it knows anything. Nothing expires; nothing needs a cleanup task.

### Thresholds retuned, and the boundary-margin rule

`CAPACITY_THRESHOLDS` went from 6/16 to **4/11** (low 0-3, medium 4-10, high 11+). At a 16/month
bar nothing in this book ever reaches high, so the top row of `CADENCE_DAYS` would never apply to
anything. Only places carrying a real *number* re-bucket when these move - 2 of 263 at the time -
since `CATEGORY_CAPACITY_SEED` assigns levels directly.

The four rating values are `major: 15, strong: 13, steady: 7, occasional: 1`
(`CAPACITY_SEED_VALUES`). **Every value deliberately sits at least 2 away from a threshold.**
Bede's first draft used 11 against a `HIGH_MIN` of 11; both thresholds are independently editable
from Settings with no cross-validation against these numbers, so a value sitting *on* a boundary
would let a one-digit tweak silently re-level 25 places and halve their cadence. The rating screen
prints which bucket each choice currently lands in, computed from the live thresholds, so the
coupling stays visible. There's a test asserting the margins.

`major` and `strong` both resolve to `high` at the shipped values, on purpose: capacity has three
levels, so any four-choice scale collapses somewhere, and the gap between "great account" and
"best account" matters less for cadence than the gap between "occasional" and "steady." The
distinction survives as the EXPLORATION tie-break, which now reads `capacity_seed` directly.

### Measured impact (before vs. after, thresholds held constant to isolate the rating)

```
             before   after          level source: category_seed 99.2% -> 0%
  high          66      49
  medium        91      67           visits/day demanded: 14.9 -> 11.8
  low          106     147           moved: 120 of 263 (31 up, 89 down)
```

**46% of the book changes level.** The front of the EXPLORATION queue - which picks each day's
zone - reshuffles completely: it was GO Physical Therapy ×3 plus four assisted-living facilities
(all keyword hits) and is now CHI Health at Home, Aging Partners, four family-medicine practices,
and McHenry Haszard Law. That last one is the tell - the keyword table sends anything matching
`legal|attorney|trust` to `low`, so a top account was structurally unreachable at the front of the
queue. The 89 places that moved *down* are mostly PT and assisted living the keyword table called
high and Bede had tiered 3.

### Schema and what's still frozen

Migration `20260823000000` adds `capacity_seed` (integer, referrals/month) and
`capacity_seeded_at` ('YYYY-MM-DD'), backfilled losslessly: tier1+★→15, tier1→13, tier2→7,
tier3→1. The four values are hardcoded in the migration on purpose - a migration that reads
mutable config produces a different database depending on when it runs.

**A NULL `capacity_seeded_at` means "backfilled from the spreadsheet tier, nobody has actually
confirmed it,"** which is the review queue the rating screen works through (`?unrated=1`).
Confirming a place stamps the date *even when the value doesn't change* - "looked and agreed" is a
real answer, and it's what moves a place out of the queue.

`tier`, `is_priority` and `priority_score` **still exist and are frozen** - nothing writes them,
every reader has moved. Same one-release transition pattern `relationship_level`/`capacity_level`
used. **Dropping them is a follow-up migration, not done yet.**

### Watch out for

- **`capacity_level` is a shadowed name.** The legacy column (frozen 2026-07-12 keyword seed) is
  still on the table and comes through any `p.*` select. `GET /places` deliberately overwrites it
  with the computed level, and `toDraftStopShape` deliberately does *not* read it. Nothing should
  ever hand out the stale one under that name.
- **The Places and Visits `capacity` filters can't be SQL.** The level is computed, so
  `GET /places` filters in JS after resolving, and `GET /visits` resolves to a set of place ids
  first (`attachCapacityPlaceIds`, which must run before both `listVisits` and `summarizeVisits`
  or the page and the counts drift).
- **Settings cross-check**: the four rating values must stay strictly descending.

### Testing

525 backend tests (8 new in `capacity.test.js` covering the seed rung, precedence over a *lower*
declared answer, the confidence invariant, contributor rules, and the boundary margins). Client
build clean. Verified live against the real dev DB with a temporary Lisa Marks token (reverted
afterwards, place 2 restored to its exact backfilled state): the bulk save stamps `seeded_at` and
recomputes the level while `confidence` stays `unknown`, an off-menu seed value is rejected by
name, and the capacity filters return 49/67/147 on places and reject an unknown level with a 400.

---

## 24. The all-star axis - a third input, not a third dimension (2026-08-24)

Adds `places.is_all_star`: a scarce human designation of the ~25 places that matter most, which
lifts a place one capacity row when the cadence table looks it up. Built the day after §23, and
**read §23 first** - this rebuilds a flag that section had just retired, deliberately.

### Why a third axis at all

Capacity is locked as a COUNT ("the number of homecare referrals a place SENDS per month"), and
`referrals` carries no value, service type, case duration, or payer column - only a date, a person,
a place, and free-text notes. So the model structurally cannot see that a trust attorney sending
one 24/7 live-in case a quarter is worth more than a PT clinic sending four short post-op cases a
month. The attorney reads `low` and gets a 90-day cadence.

Bede's framing: in homecare you only need ~20-25 genuine all-star referral sources and the rest are
ordinary. That's what makes this a scarce FLAG rather than a per-place "referral value" rating - a
per-place rating has no natural ceiling and could drift to 90 "high-value" places, where a top-25
list can't inflate without someone noticing.

### One row, not 27 cells

`bumpCapacityLevel(level, isAllStar)`: `low`→`medium`, `medium`→`high`, `high` unchanged. A third
3-level axis would make `CADENCE_DAYS` 27 cells; across 263 places most would hold two or three,
which is never enough cases to tune against. The bump buys the same expressiveness for the case it
exists to fix, against a 9-cell table nobody has to re-learn.

Applied in exactly two places, both in `schedulingEngine.js`:
- **`urgency()`** - the cadence lookup. `low`+`weak` is 90 days; all-star puts it on the 21-day row.
- **`rankKey()`'s EXPLORATION branch** - possibly the more valuable half. That tier's front picks a
  whole day's ZONE, so a place named as one of the ~25 that matters most and never pre-qualified
  now surfaces first. Nothing surfaced that before.

**It never touches the capacity level `capacity.js` computes or any UI displays.** Capacity keeps
reporting honest volume; the adjustment lives in the ranker. A place shown `low` but visited every
21 days is explained by its ★ chip, not by capacity quietly reporting a number nobody declared.

### What "all-star" means - the correction worth not re-making

The first draft of this work defined an all-star as a place that "matters MORE than its referral
volume says" - a corrective flag scoped to low-volume sources. **That was too narrow.** Reasoning
from it produced a wrong conclusion: since all 23 backfilled all-stars already read `high`, the bump
does nothing for any of them, which briefly looked like a broken backfill.

Bede's actual meaning is the broader one: **simply the ~25 places that matter most.** An all-star
that's already high-capacity is normal and expected - the flag lifts a place unless it's already at
the top, and being at the top is not a failure of the flag. That GA's own book currently saturates
says nothing about the design; **this is a general product feature, and another agency's top 25 will
include low-volume sources where the bump does real work.** Verified live: starring a `low` place
moved its cadence 90d → 21d and its urgency 0.50 → 2.14.

### Scarcity is the mechanism, and it is SOFT

`ALL_STAR_TARGET: 25` (Settings-editable). Nothing refuses the 26th - Bede's explicit call. What
keeps the flag honest is that the **live count is always visible** wherever it's set (the Rate
capacity screen shows "★ 23 of 25 all-stars" at all times, not only when over, and switches to a
`.warn-banner` past the target explaining why scarcity is the point). A budget you can only see once
you've blown it isn't a budget.

**This is the ⭐ Priority flag rebuilt on purpose.** §23 retired `is_priority` one day earlier. It
died of three things, and if any of them come back this has regressed into what it replaced:
1. **No defined meaning** - "priority" was never written down. This one is: the ~25 that matter most.
2. **No consequence** - it fed `priority_score`, a tie-break almost nothing read. This changes cadence.
3. **No protected scarcity** - a checkbox with no sense of "25". Hence the target and the count.

Backfilled from the retired `is_priority` (23 places, inside the target) and **kept** - "the ones I'd
starred" and "the ones that matter most" are close enough to be a good seed.

### Watch out for

- `is_all_star` reaches the ranker via `buildCandidatePool`'s `select('*')`. SQLite stores 0/1;
  `bumpCapacityLevel` treats it as truthy, which is correct in both drivers.
- The bulk save (`POST /places/rate-capacity`) takes `{ place_id, seed?, is_all_star? }` - an
  **absent key leaves that field alone**, so starring a place does NOT re-stamp
  `capacity_seeded_at` and pull it out of the rating review queue. There's a live-verified case for
  this.
- The Places filter folds all-star into the Capacity dropdown for the user but sends a **separate
  `allStar` param** - it's orthogonal to the level (a low-capacity all-star is the whole point), not
  a fourth level.
- `.warn-banner` was added to `styles.css` sharing `.error-banner`'s rule - a soft warning where
  nothing failed. Don't reach for `.error-banner` for these.

### Testing

533 backend tests (8 new): the bump's truth table, `high` as a ceiling, an unrecognized level
passing through, the cadence/urgency effect, inertness for a high-capacity all-star, an all-star
outranking an identical non-all-star in EXPLORATION (constructed so the id tiebreak works *against*
it, or the test would prove nothing), and the one-row limit not leapfrogging a genuinely high place.
Client build clean. Verified live against the dev DB with a temporary Lisa Marks token (reverted;
Union College un-starred, count back to 23).

---

## 25. Seven retired `places` columns dropped (2026-08-25)

Migration `20260825000000` removes `tier`, `is_priority`, `priority_score`, `capacity_level`,
`capacity_status`, `capacity_monthly_referrals`, and `relationship_level` - the cleanup pass for
three separate transitions that each deferred "for one release."

Every one was a MANUAL field that governed routing or pretended to, and every one had already been
replaced by something computed. They were kept readable so computed values could be diffed against
the old ones on real data; that comparison happened for all three, so this closes them out.

- **tier / is_priority / priority_score** - retired 2026-08-23 (§23), replaced by
  `capacity_seed` and `is_all_star`.
- **capacity_level / capacity_status / capacity_monthly_referrals** - this is
  `capacity-computation-spec.md`'s **step 9**, the last open item in that spec. Marked done there.
  (Step 8, the drop-off detector, is still BLOCKED on the eRSP migration - not merely unstarted.)
- **relationship_level** - §16's equivalent. It defaulted to `'weak'`, had no write path anywhere,
  and was never once edited, so every place read `'weak'` and a whole cadence axis did nothing.

### The three transition shims went with them - and that mattered more than it looks

`schedulingEngine.js` carried `effectiveRelationshipLevel`, `effectiveCapacityLevel`, and
`effectiveCapacityConfidence`, each of the form `explicitValue ?? place.<legacy column>`. Each
one's own comment said to delete it along with its column.

**Only 6 of ~69 engine unit tests were passing the values explicitly.** The other 63 were reaching
the fallback - so they were exercising a code path production never took, and would have kept
passing through a regression in the real one. Both pure-object test files now translate their
fixtures into explicit arguments in a single documented helper (`fixtureArgs` +
`rankKeyF`/`urgencyF`/`eligibilityF`/`rankCandidatesF` in `schedulingEngine.test.js`; the
`candidate()` helper in `scheduleGenerator.test.js`). The fixtures still read the same; the calls
now match production.

### Also removed

- `scripts/capacity-legacy-diff.js` and its `capacity:legacy-diff` npm script - its whole job was
  diffing `capacity_level` against the computed level.
- A vestigial `p.capacity_level` in `relationship.js`'s select that nothing read.
- Three dead fields (`capacity_level`/`capacity_status`/`relationship_level`) on
  `scheduleGenerator.js`'s stop shape that no consumer ever looked at.
- ~139 now-invalid column keys across nine DB-backed test fixtures.

### Watch out for

- **`capacity_level` and `relationship_level` still appear in API responses.** Both are the
  COMPUTED values, attached explicitly in `routes/places.js` - there is no column behind either
  name any more, so `...p` contributes nothing and those lines are the only source. Don't read them
  as columns.
- **Migration order is load-bearing.** `20260823000000` backfills `capacity_seed` from `tier` and
  `20260824000000` backfills `is_all_star` from `is_priority`; both run BEFORE this one, so a
  from-scratch migrate still sees what it needs. **Don't renumber this migration earlier.**
- `down` restores the columns' SHAPE only - every value comes back NULL. Their contents are not
  recoverable and would be worthless anyway, since the entire point is that each was stale or never
  written.
- The Excel importer is now the only place `tier`/`Priority` exist at all; it translates them into
  a capacity rating on the way in, using the same four-way mapping the backfill used.

### Verification

533 backend tests, client build clean. Migration round-tripped (`down` then `up`) on a throwaway
copy of the dev DB with data intact (23 all-stars, 263 rated). Live smoke test against the migrated
dev DB with a temporary Lisa Marks token, reverted afterwards: places list/detail, the visits list,
the capacity filter, dashboard and settings all 200, and a **real route-planner draft generated
end to end** (zone "Southeast Lincoln", 9 stops, capacity levels resolved) - then that throwaway
draft was deleted.
