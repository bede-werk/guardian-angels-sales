# Guardian Angels Sales Scheduler — Project Handoff

_Last updated: 2026-07-29_

This document is a self-contained context dump so work can resume in a new session.
It summarizes what was built, key decisions, how to run it, the Railway deploy saga,
current state, and next steps.

---

## 0. Start here (note to self, written 2026-07-09)

If you're picking this project back up cold, read this section first — it'll reorient you
faster than the full doc below.

---

### 2026-08-03 — Relationship level is now COMPUTED (new §16 at the bottom of this doc)

`places.relationship_level` was a manual field that defaulted to `'weak'`, had no write path
anywhere in the app, and had never once been edited — so every place read `'weak'` and one of
the two axes of the route planner's cadence table was doing nothing. It's been replaced with a
computed, decaying score (`server/src/services/relationship.js`), measured per PERSON and
rolled up to the place, with a manual override that is always displayed next to the computed
value it replaces. **Full design, the three new migrations, and the deferred items are in §16
— read that before touching relationship, capacity, or visit-outcome code.**

Two things it's worth knowing immediately, because both will otherwise look like bugs:

1. **Visit outcomes were replaced outright.** `interested / not_ready / follow_up / no_answer /
   left_materials` → `substantive / introduced_new / brief / materials_only / unavailable /
   declined`. No old→new mapping was written: the old values were evaluative ("how did it
   feel"), the new ones observational ("what happened"), so there's no honest 1:1. Existing
   rows keep their old string and score at a documented floor rather than throwing.
   **Writing the real backfill is a to-do for whenever actual historical data gets imported**
   (all current visit data is test data) — see §16's deferred list.
2. **Everything currently scores 0 / `weak`, and that is correct, not broken.** No visit in the
   DB carries the new capture fields yet, and every existing completed visit is detached
   (`place_id` null) from smoke-test cleanup. Run `npm run relationship:distribution` (new) to
   see the live picture — it warns loudly when one bucket holds >90% of places, which is the
   signal that the axis isn't separating and half-lives/thresholds need tuning before the
   ranker leans on it. Seeding (People tab → "Seed relationships") is what makes day one honest.

### 2026-08-07 — Capacity is now COMPUTED too (new §18 at the bottom of this doc), steps 1–5 of 9

The other cadence axis got the same treatment as relationship above. `places.capacity_level`/
`capacity_monthly_referrals`/`capacity_status` were a manual guess, a number frozen at first
pre-qual, and a one-way latch respectively — replaced with `server/src/services/capacity.js`,
computed from an append-only `capacity_observations` log plus our own measured referral
throughput, with the same override pattern. **Full design and the two deferred ranker-facing
steps are in [capacity-computation-spec.md](capacity-computation-spec.md) and §18 below — read
before touching capacity, the EXPLORATION tier, or scheduling cadence.**

Two things worth knowing immediately, because both will otherwise look like bugs:

1. **Capacity and `referralMetrics.js`'s place rollup will disagree for any contact who's
   changed employers, and both are correct.** `referrals.place_id` is stamped once at referral
   creation from the referring person's place *at that time* and never re-stamped
   (`routes/referrals.js`) — so `capacity.js`'s measured floor stays attributed to whichever
   building actually generated the referral, per the spec's "capacity is a property of the
   building, not the contact" rule (§2/§14). `referralMetrics.js`'s own place-level rollup does
   the opposite on purpose (it follows the contact's *current* place, see its own
   `referralMetricsByPlaceId` comment) — so a place's two referral counts can legitimately
   diverge the moment someone changes jobs. Neither is a bug; don't "fix" one to match the other.
2. **A temporary dual-write bridge is live and must be deleted at step 6.** `schedulingEngine.js`
   hasn't been swapped to read the computed service yet, so `routes/visits.js`'s
   `maybeCapturePreQualification` also writes the legacy `capacity_monthly_referrals`/
   `capacity_status` columns straight to `places` alongside the new observation row — otherwise a
   pre-qualified place would never leave the EXPLORATION tier (which still reads only the old
   columns) and would get routed back for pre-qualification forever. Clearly commented as a
   bridge in `routes/visits.js`; remove it the moment step 6 lands.

**What this app is, in one line:** a CRM-ish tool for Guardian Angels Homecare's sales team
to plan visits to referral places, log who they talked to, and track referrals — built this
year in a series of same-day feature sessions directly with Bede (the owner/primary user).

**Where things stand right now:**
- The 2026-07-08 CRM-buildout session (Places CRUD, People tab, detach-not-delete
  semantics, a person-attributed referral system) and that same day's follow-up
  (relationship-temperature removal, replaced with objective **referral metrics** — §9) are
  both **committed and merged to `main`** (through `10cebf2`).
- **2026-07-09 was a polish session** on top of that: places can now be **edited** (not just
  created — `PlaceModal.jsx` doubles as create/edit now), visits got a **detail popup +
  edit + delete** (new `VisitDetailModal.jsx`), PersonDetail's notes/preferences/birthday
  became independently click-to-edit (matching the pattern PlaceDetail's notes already had),
  dates display as `M/D/YYYY` everywhere (`formatDate()` in `api.js`) instead of raw
  `YYYY-MM-DD`, and — the one genuinely new capability, not just polish — **places now get
  geocoded** (address → lat/lng) automatically via the free US Census geocoder, with a
  `npm run geocode` backfill script for the 261 existing places. See §5 and the new §9A for
  the full design. Five commits, all committed (`74ca2a1`…`cb706a8`).
- **2026-07-10 was another polish-plus-audit session, still UNCOMMITTED as of this
  writing** (check `git status`): `ReferralDetailModal.jsx` and `VisitDetailModal.jsx` both
  got a bottom-left **Delete** button; the Place-notes / Person-notes/preferences/birthday
  inline editors were all standardized to Delete-far-left / Cancel+Save-on-the-right (Save
  always the rightmost button), and starting an edit on any one of them (or taking any other
  action on the card — assign to place, log/view a referral or visit, open Edit) now backs
  out of whichever other field was mid-edit instead of leaving multiple drafts open;
  Person's preferences field became a resizable textarea (was a single-line input, now
  matches notes); `AssignPersonModal` got its default "browse everyone unassigned" list back
  alongside the existing search box. Then, at Bede's request, ran a 4-agent audit of the
  whole People/Places surface plus a route-planner-readiness assessment — **see §14A for two
  real data-integrity bugs found (not yet fixed) and §14B for the route-planner findings**,
  most notably that the geocoding backfill mentioned above **has now actually been run**
  (contradicts the still-stale-sounding wording elsewhere in this doc before this edit pass —
  see §9A/§13, now corrected).
- Don't start new feature work without first asking Bede whether to commit pending
  changes — he explicitly only wants commits when asked for.
- **2026-07-10's audit findings were fixed the same day** (`dc5d940`) — despite the
  "not yet fixed" wording that used to follow this bullet. Both data-integrity bugs (referral
  orphaning on person delete; visit-edit lockout when the linked person is deleted) are
  resolved. See the corrected §14A.
- **2026-07-11 through 2026-07-13:** route planner phases 1-4 built on branch
  `bede-routeplanner` — a four-tier scoring engine, a drive-time estimator + visit-type
  durations, and a multi-day draft generator (haversine-based, no real routing API yet at this
  point). Also dropped the unused `departed`/`is_primary` flags on people. 69 tests by the end
  of phase 4. Full detail in `ROUTEPLANNER_PROGRESS.md`, not here.
- **2026-07-14 was the biggest single day on this project so far:** phase 5 (real routing API
  via OSRM + stop-sequencing optimization, `84d32bf`); a full codebase audit at Bede's request
  that found and fixed **a real security leak** (`GET/POST /api/users` used to leak every
  user's password hash and live session token to any logged-in user) and **a live-breaking
  bug** in the scheduler actually in production use (a SQL `NOT IN` against a subquery that
  could contain NULL silently zeroed out route generation for everyone, forever, the first
  time any place was ever deleted) — `c408809`; phase 6's draft/commit lifecycle backend + API
  (`95049c7`); and the first two sub-slices of phase 6's frontend — a new "Plan My Visits" tab
  with generate + read-only view (`ce2f41f`), then live editing (reorder/add/remove/visit-type
  changes with in-place time recalculation and over-budget flagging). 139 tests. The old
  scheduler/"Today's Route" screen is still fully working and untouched throughout — it stays
  that way until the new workspace's frontend is complete enough to replace it. Full detail in
  `ROUTEPLANNER_PROGRESS.md` and `NOTES.md`'s 2026-07-14 entry, not here.
- **2026-07-15:** phase 6 frontend sub-slice 3 — suggestions (a "Suggest a stop" prompt on
  under-budget days, wired to the already-built `getSuggestions` endpoint) and commit (per-day
  and full, both confirm-gated, both wired to `commitDay`/`commitAll`). Verified live: a real
  suggestion was added, a day was committed (6 real `visits` rows), then the remaining days
  were committed (20 more) — 26 total, correctly shaped, 0 leftover draft stops. **This was the
  last piece of the new route-planner frontend** — the "Plan My Visits" workspace is now
  functionally complete end-to-end (generate → edit → suggest → commit). Same day, at Bede's
  request ("I want this code to be very clean"), **the old scheduler was fully retired**:
  `services/scheduler.js`, `routes/schedule.js`, `Schedule.jsx`, and the "Today's Route" tab
  all deleted, plus the Dashboard's old route card (a deliberate choice — full removal, not a
  slimmed-down read-only keep — confirmed with Bede) and every dead CSS rule/comment that only
  existed to support it. 139 tests still pass, client build succeeds, verified live with zero
  console errors. Full detail in `ROUTEPLANNER_PROGRESS.md` and `NOTES.md`'s 2026-07-15
  entries, not here.
- **Also 2026-07-15, same session:** with the workspace feature-complete, Bede started
  live-testing it and requesting real UX refinements as he went — a "Re-optimize" button per
  day (real-OSRM resequencing, gated by session-only client state that took two rounds of
  Bede's own live correction to get right — see `NOTES.md`/`ROUTEPLANNER_PROGRESS.md`), a
  "Discard plan" button (ownership-checked `DELETE /api/schedule-drafts/:id`, cascades
  cleanly), and moving each stop's individual time + the day's running total to be much more
  visually prominent. Two more rounds followed the same session: manual address entry made
  available up front (not just as a geolocation-failure fallback), and a read-only "Committed"
  section per day so a committed day doesn't just look empty. **Bede then explicitly asked to
  commit, push, and merge the whole batch into `main` via a PR** so his coworkers could access
  it — done same session. Expect this live-feedback pattern to continue in future sessions.
- **Later 2026-07-15, a separate session on branch `bede-working`:** a dedicated code-quality/
  bug-hunting pass, not route-planner feature work — Bede asked for a full-app review, then a
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
  (via INNER JOIN this time) — see the corrected note in §14A. ~18 further ultra-pass findings
  were deliberately deferred, not fixed. 146 tests pass (up from 143), client build clean.
  **Committed, pushed, and merged into `main`** at the end of this session per Bede's explicit
  request — a direct git merge, not a GitHub PR, since `gh` wasn't available in this
  environment. Full detail in `NOTES.md`'s same-dated "Code-quality bug hunt" entry.
- **2026-07-22, branch `bede-working`:** picked up two threads — a "Plan My Visits" feature
  Bede had already started (reopening an already-committed day back into an editable draft,
  see `ROUTEPLANNER_PROGRESS.md`'s new entry), plus working through the ~18-item ultra-review
  backlog `NOTES.md`/§0 above deferred. Fixed: `POST /api/visits` wasn't validating `status`
  against its enum (only `PATCH` was); `places.js` never validated `tier` was 1/2/3 (PATCH
  could even let a place's stored `tier` diverge from the `priority_score` derived from it —
  now the coerced numeric value is what's written, not the raw body value); the fully-orphaned
  `visits.skip_reason` column was dropped (new migration) along with the dead
  `POST /api/visits/:id/skip` route and `api.skipVisit()` client fn — the whole "skip a stop"
  concept was a leftover from the retired `Schedule.jsx`, never rebuilt in the new workspace,
  `status: 'skipped'` itself is unaffected and still fully supported via the regular `PATCH`;
  every currently-passwordless user got backfilled to a real default password (`Angels#1`, new
  migration) as a stopgap for the pre-auth account-takeover window (`GET /auth/users`/
  `POST /auth/set-password` still aren't behind `requireAuth` and can't be — Bede's still
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
  Needs Mapping geocoding gap (§14A) is closed — `notesReview.js`'s `POST /:id/create-place`
  now calls `geocodeAddress()` the same way `routes/places.js`'s create route does, best-effort
  and non-blocking, so places created from that flow no longer silently skip lat/lng. Also
  cleaned up a few stale/imprecise comments in `scheduleDraft.js` (`committedVisitsQuery`,
  `removeStop`) that still described pre-reopen-feature behavior (implied a partial commit
  could leave both a committed visit and a draft stop for the same day — no longer possible now
  that `commitDay` always commits/clears a full day and drops it from `params.days`) — no
  behavior change, just brought the comments back in line with the code. Two items were
  deliberately left for Bede to scope later: `visits.skip_reason`'s wider "skip a stop" concept
  could be rebuilt as a real feature (declined — cleanup only, per above) and the remaining
  ~9 unbuilt scheduling-field API surface / `visit_type`-not-patchable capability gaps (see
  §14A's "still open" notes) haven't been touched. 146 tests pass, client build clean
  throughout. **Pushed and merged into `main`** later the same session (2026-07-22), along
  with everything else below through the visit-type-default bullet — a fast-forward merge
  (direct `git merge`, `gh` unavailable in this environment, same as 2026-07-15's precedent),
  at Bede's explicit request.
- **Also 2026-07-22, same session, a UI/UX request from Bede:** the route planner's "enter
  address manually" start-location form (4 separate street/city/state/zip fields + a "Use this
  address" button, geocoded one-shot via the free Census API) was replaced with a single
  Google-Maps-search-style box — type freely, pick a live suggestion, done, no separate lookup
  step. New dependency: `@mapbox/search-js-react`'s `SearchBox` component, wrapped in
  `client/src/components/ui/AddressAutocomplete.jsx` and themed to match this app's existing
  inputs/dropdowns (colors/radius/shadow copied from `styles.css`'s design tokens, since the
  component is a custom element and can't read the app's own CSS classes directly), biased
  toward Lincoln, NE via a `proximity` option. Needs a free Mapbox access token in
  `client/.env` (`VITE_MAPBOX_TOKEN`, see `client/.env.example`) — Bede has one now; the
  component shows a small inline notice instead of failing silently if it's ever missing.
  This made the old single-shot `POST /api/geocode` route (and `api.geocode()` client fn)
  genuinely dead code — both deleted, along with the manual-entry-specific state/handler in
  `PlanVisits.jsx` (`manualAddress`, `geocoding`, `lookUpManualAddress`) they existed for. The
  Census geocoder itself (`services/geocoding.js`) is untouched and still does all of the
  place-address geocoding described in §9A — this only replaced the router's own
  start-of-day-location entry point, a different use case (live suggestions while typing vs.
  one-shot resolve-a-complete-address). Verified live end-to-end (typed a Lincoln address, got
  real suggestions, selected one, start location set correctly) via a temporary Lisa Marks
  smoke-test token, cleared after. 146 tests pass, client build clean. Not yet
  pushed/merged.
- **Also 2026-07-22, four more live-feedback rounds on "Plan My Visits":** (1) the per-date
  budget picker now does hours **and** minutes (two selects grouped in one `.duration-picker`
  pill) instead of whole hours only — needed zero backend changes, `hoursPerDay` was already a
  decimal on the wire. (2) Clicking a proposed stop now opens its full `PlaceDetail` (reused
  as-is — same modal Places/People/Dashboard already use) so a rep can check capacity/notes/
  history before picking a visit type; `PlanVisits.jsx` gained a `userId` prop (threaded from
  `App.jsx`, same as the other tabs) since `PlaceDetail` needs it downstream. (3) Two rounds of
  hover-highlight polish on that same stop row: made the highlight cover the whole row (`:has()`
  off `.main`'s hover state, not just `.main`'s own box) while excluding the visit-type select
  and reorder/remove buttons, then made it instant instead of partially-fading (the shared
  `.hover-row` transition only animated one of the two now-overlapping background layers).
  (4) `config/visitTypes.js`'s `DEFAULT_VISIT_TYPE` changed from `working_visit` (30 min) to
  `drop_in` (7 min) — flagged to Bede as a real behavior change, not cosmetic: every one of the
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
  right — a real alignment bug along the way, where a longer visit-type label was shifting
  every row's dropdown left by a few px, fixed by giving both the time display and the select a
  fixed width instead of content-driven sizing). Then a new feature: "Already Planned" days are
  now a click-through drill-down (`PlannedDayModal.jsx`) instead of exposing Edit/Delete
  directly on the row — the modal lists that day's actual visits (clickable into full
  `PlaceDetail`) with Edit/Delete moved into its footer, matching the Place/Person modal
  convention. New backend read (`scheduleDraft.committedDayVisits` + `GET /api/schedule-drafts/
  committed-dates/:date/visits`). 146 tests pass, client build clean. Full detail in
  `NOTES.md`'s and `ROUTEPLANNER_PROGRESS.md`'s matching 2026-07-23 entries.

**Mental model you need before touching this codebase:**
1. **Detach, don't delete.** Places, people, and visits are designed so deleting one thing
   never destroys another's history. If you're tempted to `CASCADE` a foreign key, stop and
   re-read §8 — that's almost certainly the wrong call here.
2. **Referrals belong to a person, never a place.** A place's referral metrics are *always*
   derived live (rolled up from its current roster's own numbers), never stored. If you see
   a bug where a place's numbers don't match expectations, check who's currently assigned
   there first, not the referrals table's own `place_id`-shaped assumptions (`place_id` on
   `referrals` is just a historical snapshot, not the source of truth for a place's total).
3. **No more manual "smart" fields that need upkeep.** The old house style was
   suggested-but-not-applied (compute a suggestion, show it next to a manual value, let the
   user opt in) — that's how relationship temperature worked. It was replaced because the
   manual field it suggested against never actually got kept up to date. The new standard
   for anything like this is **fully computed, no manual field at all** (see referral
   metrics in §9) — prefer that shape for future "smart" fields unless there's a real reason
   a human needs to be able to override it.
4. **SQLite migrations in this repo need care**, not `.alter()` for FK-bearing columns.
   Adding/changing a FK on an existing column with `.alter()` leaves duplicate FKs, and
   index names collide database-wide across rebuild attempts. Use the
   `rebuildSqliteTable`-style rebuild pattern established in
   `20260709000000_detach_instead_of_cascade.js` (temp table → copy via raw INSERT SELECT →
   drop → rename, explicit index names, defensive `DROP INDEX IF EXISTS`) for that case.
   Dropping/adding a plain non-FK column (no rebuild needed) is simpler — see
   `20260710000000_drop_relationship_temp.js` or `20260711000000_add_geocoded_at_to_places.js`
   for that pattern instead.
5. **Smoke-test safely** (§10) — passwordless user Lisa Marks (id 5) for temp auth tokens,
   `__SMOKETEST_`/`__E2E_` prefixes, clean up after, and never touch Bede's own real test
   data (place 264 "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar
   Jr.). Never set a password on a real user's account to get a token — that happened once
   this project and it was a mistake (see §10, and again briefly on 2026-07-08 — don't repeat
   that shortcut either).
6. **Geocoding is best-effort and non-blocking.** `services/geocoding.js`'s
   `geocodeAddress()` returns `null` on any failure (bad address, network error, no match) —
   creating/editing a place must never fail or hang because the Census API is slow or down.
   If you touch this, keep that contract.

**Natural next steps Bede has flagged but not yet asked for** (don't just do these — check
first): feeding referral metrics into priority scoring (the natural successor to the old
"Phase 2 relationship-temp" idea) — see §14's note on `needs_attention` having been removed
app-wide 2026-07-24; the underlying `referral_metrics` numbers (lifetime/last/90-day) are
still live and usable here, just not that specific flag.

**If something in this note contradicts the actual code** (a file's gone, a function's
renamed), trust the code — this note is a snapshot from one point in time, not a live source
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
- **Database:** SQLite locally (`better-sqlite3`), **PostgreSQL** in production — swap is
  config-only via `server/knexfile.js` (all data access goes through Knex, no query changes)
- **Frontend:** React + Vite (plain CSS, no UI framework)
- **Deploy target:** Railway (also Heroku-compatible)

### ⚠️ Environment gotcha (important)
Node is **not on the default PATH** on this Mac — it's installed via **nvm** at
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
│       ├── config/                   # route-planner tuning constants (plain modules, no
│       │                             # settings table — see ROUTEPLANNER_PROGRESS.md):
│       │                             # scheduling.js, driveTime.js, visitTypes.js,
│       │                             # routeOptimizer.js (places.category is now a DB table,
│       │                             # see routes/categories.js, not a config file)
│       ├── services/
│       │   ├── priority.js           # priority score + region ("side of town") helpers
│       │   ├── schedulingEngine.js   # route planner: four-tier scoring/eligibility
│       │   ├── driveTime.js          # haversine estimate + real-OSRM-backed time-block packing
│       │   ├── scheduleGenerator.js  # multi-day draft generator (generateDraft())
│       │   ├── routeOptimizer.js     # OSRM /trip + /route calls (the one I/O-having pure-ish module)
│       │   ├── scheduleDraft.js      # draft CRUD, live recalc, commit — the DB orchestration layer
│       │   ├── auth.js               # password hashing / token helpers
│       │   ├── phone.js              # phone validation + (402) 555-1234 normalization
│       │   ├── referralMetrics.js    # lifetime/last/90-day referral metrics + needs_attention
│       │   ├── geocoding.js          # geocodeAddress() — address -> {lat, lng} via US Census
│       │   └── fetchWithTimeout.js   # shared AbortController+setTimeout wrapper (OSRM, geocoding)
│       ├── routes/                   # auth, places, people, referrals, visits,
│       │                             # scheduleDrafts (route planner), dashboard,
│       │                             # users, categories
│       └── scripts/
│           ├── import-excel.js       # importPlaces() — place list
│           └── geocode-places.js     # geocodePlaces() — backfills lat/lng for ungeocoded places
└── client/
    ├── vite.config.js                # dev proxy /api -> :4000
    └── src/
        ├── App.jsx                   # tabs: Dashboard, Route Planner, Places, People
        ├── api.js                    # incl. formatDate() — YYYY-MM-DD -> M/D/YYYY for display
        ├── styles.css
        └── components/
            ├── Login.jsx, ChangePassword.jsx
            ├── Dashboard.jsx
            ├── RoutePlanner.jsx                     # route-planner workspace ("Route Planner" tab)
            ├── Places.jsx, PlaceDetail.jsx, PlaceModal.jsx      # PlaceModal: create AND edit
            ├── People.jsx, PersonDetail.jsx, PersonModal.jsx, AssignPersonModal.jsx
            ├── ReferralModal.jsx, ReferralDetailModal.jsx
            ├── VisitLogModal.jsx, VisitDetailModal.jsx, CategoriesModal.jsx
            └── ui/                    # Button, Chip, EmptyState, PhoneInput, PlacePicker, ...
```

---

## 4. Data model (tables)

- **users** — team members (`id, name, email, password_hash, auth_token`). Current: **Bede
  Fulton, Nikki Shasserre, Lisa Marks, Basil Fulton**. Auth is a simple bearer token stored
  directly on the user row (`server/src/routes/auth.js` + `services/auth.js`).
- **places** — referral organizations (`name, category, tier 1/2/3, is_priority,
  priority_score, address, city, state, zip, region, phone, notes`, plus route-planner fields
  added 2026-07-10/13: `capacity_level`/`capacity_monthly_referrals`/`capacity_status`/
  `current_agency_used`/`has_inhouse_service`/`relationship_level`/`snooze_until`/
  `do_not_visit`/`default_visit_type`). `category` is now a locked enum
  (`config/categories.js`), not free text (2026-07-14). Originally imported from Excel
  (261 rows), now a full CRUD directory — add/edit/delete from the UI. Deleting a place
  deletes only that row; see section 8 for what happens to its people/visits.
- **people** — individual contacts (`place_id` nullable, `name, title, role_type, email,
  phone, preferences, notes, birthday`). Renamed from "contacts" the session before last. A
  person doesn't have to belong to a place, mirroring how a place doesn't need a person on
  file. (No `relationship_temp` column — dropped by `20260710000000_drop_relationship_temp.js`;
  see §9. No `departed`/`is_primary` either — dropped 2026-07-11, neither was ever really used.)
- **schedule_drafts** / **schedule_draft_stops** — the new route planner's draft/commit
  lifecycle (added 2026-07-14). A stop's presence in `schedule_draft_stops` IS the draft — no
  soft-delete status, no stored running-totals (recomputed live on every read, same convention
  as referral metrics). `visits` also gained a nullable `visit_type` the same day, so a draft's
  visit-type choice has somewhere to land at commit. See `ROUTEPLANNER_PROGRESS.md` for the
  full schema/design — not duplicated here.
- **visits** — one planned/completed/skipped TRIP by a user to a place on a date. Fields:
  `status, sort_order, notes, next_visit_date, actual_duration_minutes, visit_type, source,
  completed_at`, plus the `place_name` **snapshot** captured at creation time so a visit stays
  readable after the live place is deleted. `source` = `manual` (in-app) or `imported_note`.
  **Restructured 2026-08-05 (§17)** — who was met moved out to `visit_encounters`.
- **visit_encounters** — one row per person/category met on a trip (`visit_id` FK
  `ON DELETE CASCADE`, `person_id` FK `ON DELETE SET NULL`, the `person_name/title/email/phone`
  snapshot, `met_with_type, outcome, they_requested`). A trip where a rep met a named contact
  AND got gatekept by the front desk is one `visits` row with two encounters. A partial unique
  index `(visit_id, person_id) WHERE person_id IS NOT NULL` stops the same person being
  recorded twice on one trip. A still-`planned` visit legitimately has ZERO encounters. See §17.
- **referrals** — one referral, attributed to a `person_id` plus a `place_id` snapshot (both
  `ON DELETE SET NULL` — a referral outlives the person/place it came from, orphaned but
  preserved), with `referral_date` and `notes`. Nothing about relationship strength is
  stored anywhere: `services/referralMetrics.js` derives lifetime count / last referral date
  / last-90-days count / a `needs_attention` flag live from this table, for both people and
  places, on every read (see section 9). **Known gap (§14A #1):** unlike `visits`, this table
  has no name-snapshot columns, so once `person_id` nulls out the referral is unattributed and
  drops out of every metric even though the row itself still exists.
- **categories** — the canonical, admin-editable list of place categories (`id, name`).
  `places.category` is validated against it. Managed via `routes/categories.js` and
  `CategoriesModal.jsx` (add/rename/retire — see §13's 2026-07-27 bullet).

---

## 5. Key features (all built & working)

- **Auth** — pick your name, set a password on first use, bearer token thereafter. All
  `/api` routes except the login flow require `requireAuth`.
- **Import places** from Excel (idempotent upsert). Normalizes category typos
  (`Legal and Trust`→`Legal & Trust`, `Senior Adisors`→`Senior Advisors`).
- **Route Planner (tab)** — four-tier priority scoring (commitments >
  endangered/rescue > exploration > maintenance), real drive-time via OSRM with
  stop-sequencing optimization, a multi-day draft you generate once and then edit live
  (reorder/add/remove/change visit type, with in-place time recalculation and over-budget
  flagging — nothing auto-drops or auto-reshuffles), a "suggest a stop" prompt on
  under-budget days, and commit (per-day or all) to turn draft stops into real `visits` rows
  with multi-user collision protection. This is the app's only route-planning surface — the
  old single-day scheduler ("Today's Route" tab) was retired 2026-07-15, see
  `ROUTEPLANNER_PROGRESS.md` for the full build.
- **Visit logging** — outcome (interested / not_ready / follow_up / no_answer), notes,
  key contact (name/title/email/phone), next visit date. Phone numbers are normalized to
  `(402) 555-1234` at every entry point (`services/phone.js` + `ui/PhoneInput.jsx`).
- **Places tab** — full CRUD directory: search + filter (category, tier, city, zip,
  never-visited); each row shows last **completed** visit, a preview contact, and the
  place's live referral tally (Contact column was removed once phone/email moved into
  PlaceDetail itself).
- **People tab** — cross-place directory of every person, independent of place assignment;
  filter by place, category, needs-attention (referred before, quiet the last 90 days),
  never-contacted.
- **Place detail** — editable core fields via an **Edit** button (`PlaceModal.jsx` doubles as
  create/edit, added 2026-07-09 — there was previously no way to fix a typo'd address short
  of delete + recreate); org-level notes (click-to-edit, standardized Delete/Cancel/Save
  layout — see below); "People here" roster showing name + each person's own referral
  metrics (lifetime / last referral date / last 90 days) + a "Cooling" flag for anyone who
  needs attention; **Assign person** — `AssignPersonModal` shows a default list of every
  currently-unassigned person plus the existing debounced search-everyone box (the default
  list was restored 2026-07-10 after being dropped in an earlier pass) — vs **New person**
  (create one for this place) vs detach (✕, ghost-styled, removes from place without
  deleting); **Log a referral** and **Log a visit** live in the People/Visit History sections
  respectively, not a generic modal footer.
- **Person detail** — phone/email shown as real text in its own panel (not just Call/Email
  buttons); place assignment with "remove from place" / "assign to a place" (clicking the
  place row itself now navigates there); notes/preferences/birthday each independently
  click-to-edit (2026-07-09 — previously one static all-or-nothing block; preferences became
  a resizable textarea on 2026-07-10, was a single-line input); referral log with
  lifetime/last-referral/last-90-days metrics, a "needs attention" badge, and "Log a
  referral"; full visit history.
- **Inline field editors — standardized layout (2026-07-10).** Place notes and Person
  notes/preferences/birthday all now show the same button arrangement while editing:
  **Delete** far left (only rendered once there's a saved value to delete), **Cancel** and
  **Save** grouped on the right with Save always the rightmost button. Labels changed from
  "Remove" to "Delete" for consistency with the visit/referral detail popups below. Opening
  any one of these fields for editing — or taking any other action on the card at all
  (assign to a place, log/view a referral or visit, click Edit) — now backs out of whichever
  other field was mid-edit, the same way a backdrop click already did; see
  `exitFieldEdits()`/`beginEdit*()` in `PersonDetail.jsx` and the inline `setEditingNotes(false)`
  calls threaded through `PlaceDetail.jsx`'s other action handlers.
- **Visit detail popup** — click any visit row (either detail page) to open `VisitDetailModal`:
  status/outcome chips, logged-by rep, full contact snapshot, notes, next-visit date, an Edit
  button (opens `VisitLogModal` pre-filled to PATCH), and a bottom-left **Delete** button.
  Added 2026-07-09 (delete button added 2026-07-10) so the inline visit-history rows could be
  trimmed down to date + who/where + a notes preview.
- **Referral detail popup** — same pattern as the visit detail popup: click a referral row
  (either detail page) to open `ReferralDetailModal` — full note, an Edit button into
  `ReferralModal`, and a bottom-left **Delete** button (added 2026-07-10).
- **Referrals** — always logged against a specific person (no "unknown contact" concept — an
  earlier draft had one, replaced per the user's revision — see section 8).
- **Referral metrics ("needs attention")** — see section 9. Fully computed, no manual field;
  replaced the earlier manual relationship-temperature system.
- **Geocoding** — see section 9A. Every place's address is auto-resolved to lat/lng on
  create/update via the free US Census geocoder; `npm run geocode` backfills existing rows.
- **Dashboard** — visits completed this week, high-priority never-visited, needs-attention rollup.
- **Multi-user** — visits assigned to a team member; the route planner avoids double-booking a
  place across reps on the same day (see the collision handling in `scheduleDraft.js`).
- **Categories are a real, admin-editable table** — see §13's 2026-07-27 bullet. (Section 7
  below, "Historical notes import," describes a feature that was fully removed 2026-07-27 —
  kept only as historical record, not current state.)
- **Dates display as `M/D/YYYY`** everywhere in the UI (`formatDate()` in `client/src/api.js`,
  added 2026-07-09) — storage/query format is still `'YYYY-MM-DD'` throughout, this is
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
  to map by hand — do **not** auto-create places.
- Note author `"Nicole Shasserre"` in the sheet maps to the user **"Nikki Shasserre"**.
- **Detach, don't cascade-delete** (see section 8) — this is the single biggest schema
  decision made this session and touches places, people, visits, and referrals.
- **A referral's "owner" is a person, full stop.** No place-only/unattributed referral
  concept — the user explicitly asked for that to be removed after an earlier draft
  included it. A place's metrics are *derived*, never stored, from its current roster.
- **No manual relationship-temperature field anymore.** It was a manual `hot/warm/cold/
  dormant` field with a server-computed *suggestion* alongside it (compute, display, let
  the user opt in with "Use this," never auto-overwrite — a reasonable pattern in the
  abstract, kept here as a note in case a future "smart suggestion" feature wants it) — but
  the manual field itself just never got kept up to date in practice. The user asked for it
  to be replaced outright with objective, always-current referral metrics computed live
  from the `referrals` table — nothing to set, nothing to go stale. See section 9.

---

## 7. Historical notes import (ReferrerNotes.xlsx) — REMOVED 2026-07-27, history only

**This entire feature (the `import:notes` script, the `notes_review` table, the `notesReview.js`
API, and the "Needs Mapping" tab) was deleted 2026-07-27 at Bede's explicit request — no trace
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
place**, or **set aside** — action applies to all of that referrer's notes. Assigning
converts the note(s) into visits on the chosen place.

---

## 8. Detach-not-delete + the referral model

This was the biggest schema/behavior change this session, driven by the user wanting to
never lose history when a place or person is removed.

- **Delete a place** → the place row is gone; everyone who was there gets `place_id = null`
  (detached, not deleted — `ON DELETE SET NULL`); every visit logged there survives, with
  `visits.place_name` snapshotted at creation time so it still reads correctly even though
  the live place is gone.
- **Delete a person** → same idea: their visits survive via `visits.person_name/title/
  email/phone` snapshots.
- **Remove a person from a place** (without deleting them) → `PATCH /api/people/:id` with
  `place_id: null`. Available both from PlaceDetail's roster (✕ button) and PersonDetail's
  own "Remove from place" button.
- **A person doesn't need a place, and a place doesn't need a person** — creating either
  never requires the other.
- **PlaceDetail's two "add a person" actions are deliberately different**: **Assign person**
  (`AssignPersonModal.jsx`) picks from existing/unassigned people and attaches them;
  **New person** creates a brand-new record for this place. (Originally both called "Add
  person" — renamed to "Assign person" partway through per the user's request, along with
  the component/handler naming.)
- **Referrals belong to a person, not a place.** `POST /api/referrals` always takes a
  `person_id`. An earlier draft of this feature let a referral be logged with no contact
  ("unknown contact / attribute to location only") and rolled that into the place's total —
  the user later asked for that concept to be removed entirely, so every referral is now
  always attributed to a specific person, full stop.
- **A place's referral metrics are always computed live**, not stored: `GET /api/places/:id`
  rolls up each person's own `referral_metrics` (via `referralMetricsByPersonId` in
  `services/referralMetrics.js`) across the people *currently* assigned there
  (`server/src/routes/places.js`'s `peopleWithMetrics`/`referralMetrics`) — lifetime and
  last-90-days sum across the roster, last-referral-date is whichever person's is most
  recent. Remove someone from the place and its numbers drop immediately, even though their
  own metrics (visible on their own PersonDetail) are untouched. The list endpoint
  (`GET /api/places`) uses a separate batched query, `referralMetricsByPlaceId`, that joins
  straight through to each place for the same numbers without N+1 requests — see §9.
- Referral UI lives in two places: **PlaceDetail** (metrics badge(s) up top next to
  category/tier, "Log a referral" button next to Navigate/Call — moved there from a less
  prominent spot per the user's request) and **PersonDetail** (its own referral log +
  lifetime/last/90-day metrics + "Log a referral" button).

---

## 9. Referral metrics — the replacement for relationship temperature

**This entire section replaces what used to be here.** The old design (a manual
`relationship_temp` field — `hot > warm > cold > dormant` — plus a server-computed
*suggestion* alongside it, shown but never auto-applied) is gone: no column, no service, no
UI. It was removed because the manual field it suggested against never got kept current in
practice — a suggestion next to a stale manual value doesn't help if nobody's updating the
manual value. The replacement is **fully computed, no manual field, nothing to forget to
update**.

- **The three numbers**, per person and (rolled up) per place, computed live from the
  `referrals` table by `server/src/services/referralMetrics.js`:
  - `lifetime_referrals` — total referral rows attributed to them, ever.
  - `last_referral_date` — the most recent `referral_date` on file, or `null` ("none yet").
  - `referrals_last_90_days` — how many landed in the trailing 90-day window
    (`RECENT_WINDOW_DAYS = 90`; cutoff computed against wall-clock "now," not the dashboard's
    `date` query param, except in the one dashboard query described below).
- **The flag:** `needs_attention` — `true` only when `lifetime_referrals > 0 &&
  referrals_last_90_days === 0`. A brand-new contact/place with zero lifetime referrals
  reads as "none yet," never as needing attention — only someone who's referred before and
  then gone quiet gets flagged. This is the load-bearing edge case the whole feature was
  built around; don't collapse the "zero ever" and "zero recently" cases into one check.
- **Three ways to get the numbers**, all in `referralMetrics.js`, pick based on context:
  - `referralMetricsByPersonId(knex, personIds)` — one batched query, `person_id -> metrics`,
    for a list of people (People-tab directory, a place's roster).
  - `referralMetricsByPlaceId(knex, placeIds)` — one batched query joined through each
    place's *current* people, `place_id -> metrics` (same "live membership, not the
    referral's own `place_id` snapshot" rule the old `referral_total` used) — for the Places
    directory list, so it doesn't need N+1 requests.
  - `summarizeReferralDates(dates)` — pure JS reduction over a `referral_date[]` you already
    have in hand (e.g. `GET /api/people/:id` already fetched its own `referrals` array — no
    second query needed).
  - A place's own detail rollup (`GET /api/places/:id`) is a fourth path: it sums each
    *already-fetched* person's `referral_metrics` in JS (lifetime/last-90 sum, last-referral
    is whichever person's is most recent) rather than a separate query — see `metricsFor`/
    `EMPTY_METRICS` in the same file for the shared reduce-to-map helper.
- **Wired into:** `GET /api/people` (list) and `GET /api/people/:id`; `GET /api/places`
  (list) and `GET /api/places/:id` (place rollup + per-person breakdown); `GET /api/dashboard`
  (`needs_attention.cooling_people` — people who've referred before but nothing in the last
  90 days, replacing the old dormant/cold temperature query). `needsAttention=1` is a filter
  param on both `/api/people` and `/api/places` list endpoints (applied in JS after the
  batched metrics query, not pushed into SQL — fine at this data scale).
- **UI:** `client/src/styles.css` has one small reusable class for this, `.badge.attention`
  (mauve tint, same token family as the old temperature dot's "hot" color) — used for the
  "Cooling — needs attention" / "Needs attention" badges in `PersonDetail.jsx`,
  `PlaceDetail.jsx`, `People.jsx`, and `Places.jsx`, plus a plain `.attention-flag` row style
  reused as-is in `Dashboard.jsx`'s "Needs attention" list (that class predates this feature
  and was already the house style for flagged rows). `PersonDetail`/`PlaceDetail` show all
  three numbers as text (`"Last referral: 2026-03-30 · 0 in the last 90 days"`); `People.jsx`/
  `Places.jsx` show lifetime count + a badge in their directory tables; both tabs also have a
  "Needs attention" toggle button next to their existing "Never contacted"/"Never visited"
  buttons.
- **Migration:** `server/src/migrations/20260710000000_drop_relationship_temp.js` drops the
  column and its index. Simple `t.dropColumn()` after an explicit `DROP INDEX IF EXISTS` —
  no `rebuildSqliteTable` needed since there's no FK on this column (see mental-model point 4
  above for when you *do* need the heavier rebuild pattern).

---

## 9A. Geocoding — address → lat/lng (added 2026-07-09)

Places have had unused `lat`/`lng` columns since the original places/people schema (meant for
future routing use, never populated). This session actually populated them.

- **`server/src/services/geocoding.js`** — the whole provider surface is one function,
  `geocodeAddress({ address, city, state, zip })`, against the **US Census Bureau's free
  public geocoder** (`geocoding.geo.census.gov`, no API key, no cost). Returns `{ lat, lng }`
  for the first match or `null` for no match / any failure (bad address, network error,
  non-2xx response) — deliberately isolated behind this one function's shape so swapping
  providers later (e.g. if Census coverage/uptime becomes a problem) only means rewriting this
  file, nothing that calls it.
- **Contract: best-effort, never blocking.** Geocoding failures are swallowed to `null`, not
  thrown — creating or editing a place must never fail, hang, or error out because the Census
  API is slow, down, or the address doesn't resolve. Keep this contract if you touch the code.
- **Wired into `server/src/routes/places.js`:** `POST /api/places` geocodes on create whenever
  any of address/city/zip is set; `PATCH /api/places/:id` re-geocodes whenever any of
  address/city/state/zip changes (using the merged existing+incoming values, not just what was
  in the PATCH body). Both stamp `geocoded_at = now()` regardless of match/no-match, and set
  `lat`/`lng` to `null` on no match (so a place is never left with stale coordinates from a
  previous address).
- **Backfill script:** `npm run geocode` → `server/src/scripts/geocode-places.js`. Selects
  every place with `geocoded_at IS NULL`, batches them through the Census's separate *batch*
  endpoint (CSV in, CSV out, up to 10,000 addresses/request — comfortably one call for the
  whole table), and stamps every row's `geocoded_at` whether it matched or not so re-running
  the script never re-sends already-attempted rows. Logs a list of unmatched addresses at the
  end for manual review. **Has now been run against the real dataset** (confirmed against the
  dev DB during the 2026-07-10 audit — see §14A/§14B): 255 of 262 places have `lat`/`lng`; the
  other 7 were stamped `geocoded_at` (so the script wouldn't re-attempt them) but had no
  coordinates because Census didn't match their address. (Earlier revisions of this doc said
  the backfill hadn't run yet — that was true as of 2026-07-09, corrected here.)
  **Manually reviewed 2026-07-22 (§14):** 5 of the 7 are genuinely non-geocodable (2 PO Boxes,
  3 "(Online)" referral sources with no physical address) — expected, not a data problem. The
  other 2 had real addresses Census just doesn't have indexed; cross-checked against
  OpenStreetMap and hand-set their `lat`/`lng` directly. No manual-override field exists, so
  this is durable only until one of those 2 places' address is edited again (see §14).
- **Migration:** `server/src/migrations/20260711000000_add_geocoded_at_to_places.js` adds a
  plain `t.timestamp('geocoded_at')` — no FK, no rebuild needed (see mental-model point 4).
  The `lat`/`lng` columns themselves are older (`20260707010000_places_and_people.js`).
- **Nothing in the UI reads lat/lng yet** — no map view, no distance-based sorting. This
  session only made sure the data exists; using it is a follow-up idea (§14).

---

## 10. Smoke-testing methodology (worth knowing before you test again)

Schema changes across sessions (detach semantics, referrals, and — most recently — the
relationship-temp removal / referral-metrics rollout) were all verified with live HTTP calls
against the running dev server, not just unit-level DB checks. Conventions used, worth
keeping:

- **Never use the real user's password to get a token.** Early on, a temp password was set
  on the real "Bede Fulton" account to get a bearer token for curl — this overwrote the real
  password hash without asking first. It was disclosed immediately and fixed by clearing
  `password_hash` back to `null` (first-time-setup state) rather than keeping the temp
  password. **Don't repeat this.**
- Instead, use a passwordless seeded user (**Lisa Marks, id 5**) — set a temporary
  `auth_token` directly in the DB for the test, and always clear it back to `null` afterward.
  (The referral-metrics session's smoke test deviated from this — it set a temp `auth_token`
  on Bede's real account, id 3, and restored the original token value afterward. No data was
  lost since only the rotating session token was touched, not the password hash, but it
  should have used id 5 — flagged here so it doesn't happen again.)
- Test data is always prefixed distinctly (`__E2E_`, `__SMOKETEST_`) and cleaned up by that
  prefix immediately after verification.
- Never touch the user's own real records while testing — in particular, place id 264
  ("Guardian Angels (Test)") and people "Lionel Messi" / "Mohamed Salah" / "Neymar Jr." are
  the user's own manually-created test data, not fixtures to delete.
- Deleting a person before deleting a visit they're on will `SET NULL` the visit's
  `person_id` before a second delete-by-`person_id` can match it — clean up visits by a
  distinctive `place_name`/snapshot field instead if you hit this.

---

## 11. How to run locally

Two terminals (or `./dev.sh` for both). Node is via nvm — run `nvm use 24` if needed.

```bash
# Terminal 1 — API on http://localhost:4000
cd ~/guardian-angels-sales/server
npm install            # first time
npm run seed           # first time: migrate + import places + import notes
npm run dev

# Terminal 2 — app on http://localhost:5173
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

## 12. Deployment (Railway) — what we learned

The app deploys to Railway from GitHub. **Two services:** the app (from the repo) and a
**Postgres** plugin. Required app-service variables:
- `NODE_ENV=production`
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`

### The big lesson: seed at RUNTIME, not build
The database is **not reachable during the build phase** (sealed container). Earlier attempts
to seed via a build/pre-deploy `npm run seed` failed with **"Unable to acquire a connection."**
**Fix:** `server/src/index.js` now runs migrations on startup and **auto-seeds on first boot
if the DB is empty** (in the background, after the server is already listening). So deploys
"just work" — no build/pre-deploy DB commands needed. `railway.json` and `Procfile` no longer
seed. **Production data is safe** across deploys (auto-seed only runs when DB is empty).

Other gotchas seen along the way: the public "failed to respond" link was on the **Postgres**
service (databases have no website — use the **app** service's domain); a monorepo confused
Railway's autodetection until `railway.json` pinned the builder/commands.

---

## 13. Current state (as of this handoff)

- **2026-07-14 addendum (branch `basil`):** a small header + AssignPersonModal polish
  session — see `NOTES.md`'s 2026-07-14 entry for the full write-up. Two commits,
  `1dd7ec0` (header: dropped the "Change password" button/one-line Date/Signed-in-as/Log
  out layout) and `b755edf` (AssignPersonModal: checkbox multi-select replaced with
  click-to-highlight rows). **Not yet pushed** to `origin/basil-working`. Two things to
  know before touching this area again: (1) **"Change password" has no UI trigger right
  now** — it was removed from the header and needs a new home before anyone can use it
  again; (2) an **open, unresolved product question** was raised — this app may eventually
  be sold to other companies, not just used internally, and the current login (a dropdown
  of every employee's name, no company/tenant concept in `server/src/routes/auth.js`)
  won't scale to that. Nothing was built for it — flag it before investing further in
  login/auth work.
- **Auth shipped:** the "add authentication before sharing the URL" item from the previous
  handoff is done — bearer-token login is live and required on all `/api` routes except the
  login flow itself.
- **Git:** working branch `bede-routeplanner`. The full 2026-07-08 CRM buildout and
  2026-07-09's polish session are committed and merged to `main`. **2026-07-10's audit-fix
  session (`848b246`/`dc5d940`) is committed** — both data-integrity bugs from that day's audit
  are fixed, contrary to older wording in this doc. **2026-07-11 through 2026-07-15's entire
  route planner build (phases 1-6 backend+API, a full codebase audit, all three phase 6
  frontend sub-slices, the old-scheduler retirement, and a round of live UX-feedback
  refinements) is committed on `bede-routeplanner` and, as of 2026-07-15, pushed and merged
  into `main` via a GitHub PR** at Bede's explicit request so his coworkers can access it —
  check `git log main`/GitHub for the exact merge commit rather than trusting a hardcoded hash
  here. See the 2026-07-14/07-15 bullets in §0 and `ROUTEPLANNER_PROGRESS.md`/`NOTES.md` for
  the full detail. Always check `git status` before starting new work and ask Bede before
  committing/pushing/merging, same as always — this was a one-time explicit exception, not a
  standing instruction to keep doing it automatically.
- **Geocoding backfill has been run against real data:** 255 of 262 places have `lat`/`lng`;
  7 are stamped `geocoded_at` but unmatched and still need manual address review. See §9A.
  Places created via the Needs Mapping "create place" flow (`routes/notesReview.js`) used to
  skip geocoding entirely — **fixed 2026-07-22** (§14A), that path now geocodes the same way
  `POST /api/places` does.
- **`places.category` is validated against a real `categories` table**, not free text.
  Originally a locked enum in `server/src/config/categories.js` (2026-07-14 audit, `c408809`) —
  **that file is now deleted**; as of 2026-07-27 the canonical list lives in a `categories` DB
  table (migration `20260727000000`) managed via `routes/categories.js` and a new
  `CategoriesModal.jsx` (add/rename/retire, reachable from a "Manage categories…" option in the
  People/Places category filter dropdowns). `POST`/`PATCH /api/places` still reject any
  non-matching value, just checked against the table now instead of the hardcoded array.
- **The route planner is real and fully usable end-to-end in the UI — and is now the only
  route-planning surface in the app.** Backend/API (phases 1-6) is fully built, tested
  (139 tests), and committed. The "Route Planner" tab has generate, live editing
  (reorder/add/remove/visit-type), suggestions, and commit (per-day and full) all built and
  verified live (2026-07-15) — drafts can be built, edited, and committed to real `visits`
  rows entirely from the new UI. **The old scheduler is fully deleted** (same day, at Bede's
  request) — `services/scheduler.js`, `routes/schedule.js`, `Schedule.jsx`, the "Today's
  Route" tab, and the Dashboard's old route card are all gone; see §0's 2026-07-15 bullet.
  Committed and merged into `main` as of 2026-07-15. See `ROUTEPLANNER_PROGRESS.md` for the
  whole build.
- **Live deploy:** the Railway deployment was taken down after an earlier handoff to avoid
  ongoing cost while still building — all dev happens locally via `./dev.sh` or the two
  npm-run-dev terminals. Redeploying later is still ~5 min (New → GitHub Repo → add Postgres
  → set `NODE_ENV`/`DATABASE_URL` → generate domain; it self-seeds).
- **2026-07-15, later the same day (branch `bede-working`):** a dedicated code-quality/
  bug-hunting session, separate from the route-planner work above — a regular full-app review
  pass followed by an "ultra" 6-agent deep-review pass. Fixed: a critical `dashboard.js` bug
  (the same `whereNotIn`-against-nullable-`place_id` class from the old scheduler, recurred —
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
  pushed, and merged into `main`** at the end of this session per Bede's explicit request — a
  direct git merge, not a GitHub PR, since `gh` wasn't available in this environment. Full
  detail in `NOTES.md`'s "Code-quality bug hunt" entry and the §0/§14A notes above.
- **2026-07-22, still on `bede-working`:** a "Plan My Visits" feature (reopening a committed
  day) plus a chunk of the deferred ultra-review backlog — see §0's 2026-07-22 bullet for the
  full list and `ROUTEPLANNER_PROGRESS.md` for the reopen-day feature's own writeup. Every
  currently-passwordless user now has a real default password (`Angels#1`) instead of an open
  self-serve first-login flow — the pre-auth account-takeover window itself (unauthenticated
  `GET /auth/users`/`POST /auth/set-password`) is still open pending a real login-page
  redesign Bede hasn't finalized yet. `visits.skip_reason` and the dead "skip a stop" code path
  it belonged to are gone. The Needs Mapping create-place geocoding gap (§14A) is closed. 146
  tests pass, client build clean. Committed on `bede-working` (see `git log` for the hash) —
  **pushed and merged into `main`** later the same session, per Bede's explicit request.
- **Also 2026-07-22:** the route planner's manual start-location entry is now a single live
  address-search box (Mapbox `SearchBox`, `client/src/components/ui/AddressAutocomplete.jsx`)
  instead of 4 separate fields + a lookup button — see §0's matching bullet for the full
  writeup. New client dependency (`@mapbox/search-js-react`) and a new required env var for
  local dev (`client/.env`'s `VITE_MAPBOX_TOKEN`, see `client/.env.example`). The old
  `POST /api/geocode` route and `api.geocode()` client fn are gone (dead code once this
  landed) — this does **not** touch place-address geocoding (§9A), which still runs through
  the free Census geocoder untouched. Verified live, 146 tests pass, client build clean.
- **Also 2026-07-22, four more "Plan My Visits" live-feedback rounds:** the per-date budget
  picker supports minutes now, not just whole hours; clicking a proposed stop opens its full
  `PlaceDetail` (capacity/notes/people/history) so a rep can make a better-informed visit-type
  choice; the stop row's hover highlight covers the whole row (not just its clickable `.main`
  sub-box) and turns on/off instantly rather than partially fading; and the route planner's
  fallback visit-type duration is now **Drop-in (7 min)**, not Working visit (30 min) — a real
  scheduling-behavior change since every place currently rests on this fallback, not just a
  UI default. See §0's matching bullet and `NOTES.md` for full detail. 146 tests pass (2 fixed
  to stay correct under the new default), client build clean. **Pushed and merged into `main`**
  the same session, per Bede's explicit request.
- **2026-07-23:** proposed-stop row layout iterated through several live-feedback rounds (ended
  at name+pills / address / fixed-width select+time+remove — see §0's matching bullet for the
  alignment-bug fix). New: "Already Planned" days open a drill-down modal (`PlannedDayModal.jsx`)
  on click instead of showing Edit/Delete directly on the row; those actions moved into the
  modal's footer. New read endpoint (`GET /api/schedule-drafts/committed-dates/:date/visits`).
  146 tests pass, client build clean.
- **2026-07-24 (not previously logged in this doc — see `git log`/People.jsx for the actual
  diff):** People tab got sort/filter polish, `needs_attention` was removed app-wide (it never
  fed the route-planner algorithm, was purely a display flag), and `people.role_type` was
  dropped entirely (migration `20260724000000_drop_people_role_type.js`) — too ambiguous to
  fill in reliably, the free-text `title` field covers it well enough.
- **2026-07-27:** categories promoted from a hardcoded enum to a real, admin-editable
  `categories` table (see the corrected bullet above and `NOTES.md`'s matching entry for full
  detail) — new `CategoriesModal.jsx`, `routes/categories.js`, migration `20260727000000`.
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
  no use for it any more") — see §7 (now marked removed) for what it used to do. Deleted:
  `NeedsMapping.jsx`, `hooks/useDuplicateMatches.js` and `ui/DuplicateWarning.jsx` (only caller
  of both was NeedsMapping), `routes/notesReview.js`, `scripts/import-notes.js`, the
  `notes_review` table (new migration `20260727010000_drop_notes_review.js` — a plain table
  drop, not editing the original `20260706010000_notes_import.js` that created it), the "Needs
  Mapping" nav tab + its badge count (`App.jsx`), the now-fully-dead `.tab .count`/
  `.warning-banner` CSS, and every `api.js`/`README.md` reference. Also removed the
  `import:notes` step from the production auto-seed (`index.js`'s `seedIfEmpty()`) and `npm run
  seed` — **explicit tradeoff, confirmed with Bede**: a future fresh deploy will only seed
  places from the main spreadsheet, not backfill historical visits from `ReferrerNotes.xlsx`
  anymore; he's building a from-scratch replacement for that later, don't resurrect this
  version. `visits.source` (`manual`/`imported_note`/`planner`) was deliberately left
  untouched — still load-bearing for the route planner's commit-collision unique index, not
  specific to this feature. `ui/PlacePicker.jsx` was kept (still used by Plan My Visits'
  ad-hoc "+ Add a stop" flow) — only its stale NeedsMapping-referencing comment was fixed.
- **2026-07-27, still later:** "Somewhere else" — a manual per-day zone override for the route
  planner, cycling through a day's ranked candidate regions instead of always taking the
  top-ranked one. Full design reviewed with Bede before any code (touch-points + threading plan
  + explicit sign-off on 3 decisions), then built via two parallel background subagents off a
  frozen contract once the shared pure functions were done. New in `scheduleGenerator.js`:
  `orderedZones`/`stepZone`/`outOfZoneCommitments` (13 new tests). New in `scheduleDraft.js`:
  `cycleDayZone`, persisting the resolved zone *name* (not an index) into the existing
  `params.zoneOverrides[date]` slot both read functions already checked — no changes needed
  there. New route `POST /:id/days/:date/zone` (`direction: 1|-1`). New UI: a "Somewhere else"
  button + "Area N of M" indicator per day, plus a dropped-commitments notice banner.
  **Real finding from the design review**: `droppedCommitments` never actually reached an API
  response before this session — computed by `fillDayFromZone`, discarded by
  `generateAndPersistDraft`, never recomputed by the read functions, never referenced client-
  side. This is the first time it's live. **A real bug caught by live testing** (not code
  review): the subagent's first cut excluded this day's own current stops from re-ranking
  (correct for avoiding a re-pack collision, wrong for commitment visibility — it made a
  commitment sitting among them invisible to the new drop-detection too), giving back an empty
  `droppedCommitments` on the first live call when it should have had one; fixed by scoping the
  exclusion to only the draft's other dates. Verified live end-to-end (a real backdated
  commitment, cycled zones, confirmed the exact notice text and that forward/backward/wraparound
  all behave correctly). 159 tests pass (146 + 13 new), client build clean. Full narrative,
  including the design-review findings and three rounds of UI polish, in `NOTES.md`'s matching
  entry. Not yet pushed — see `git log`/`git status`.
- **2026-07-28:** a real double-booking bug fix (multi-day `generate` could propose a place
  another rep already had committed for that exact date — `lockedElsewhere` was computed once
  against generation-day instead of per-day; new `lockedElsewherePlaceIdsByDate` fixes it); the
  "Plan My Visits" tab renamed to **Route Planner** (`PlanVisits.jsx` → `RoutePlanner.jsx`,
  everywhere current-state); a full Calendar-tab interaction overhaul (a day cell is never
  clickable itself anymore — `ui/MonthCalendar.jsx` now renders a plain `<div>`, not a `<button>`;
  each day instead shows up to three independently-clickable pieces: a "Planned Route" badge
  (your own planned visits, opens `PlannedDayModal` with full Edit/Delete, Edit hands off to the
  Route Planner tab), a "Completed Visits" badge, and status dots for everything else; the
  "Today" button was removed outright; Mine/All-reps became one split-down-the-middle toggle
  button instead of two); and another real bug fix — "Already Planned" (`committedDateSummaries`/
  `committedDayVisits`) never filtered by `status`, so a completed visit sharing a date with a
  planned one polluted the list — both now scoped to `status: 'planned'`. 153 tests pass, client
  build clean throughout. Full narrative in `NOTES.md`'s matching entry. Not yet pushed.
- **2026-07-29:** a long live-feedback session on the Calendar tab. "All reps" scope now actually
  shows other reps' planned routes (grouped per rep, "My Planned Route" / "`<Name>`'s Planned
  Route") instead of lumping them into an unlabeled dot; `PlannedDayModal` gained
  `visits`/`title`/`readOnly` props so another rep's route reuses the same look as your own, minus
  Edit/Delete. Two real CSS reflow bugs fixed: a long pill forcing its whole grid column (and the
  page) wider (`grid-template-columns` needed `minmax(0, 1fr)`, not bare `1fr`), and the page
  shifting left/right on every tab switch (scrollbar toggling on/off — fixed with `html {
  overflow-y: scroll; scrollbar-gutter: stable; }`). A "+N more" chip now caps how many pills a day
  cell shows; clicking it (or now, clicking the day number itself, even on an empty day) opens
  `DayOverflowModal` — rebuilt across several rounds into a real anchored popover (portal to
  `<body>`, positioned in document coordinates, centered on the day cell's own midpoint then
  clamped to the viewport so it doesn't jam against a screen edge) showing every pill as an actual
  rectangular (not fully-rounded — "nothing else in this app lets you click a rounded pill") colored
  button. The Mine/All-reps scope toggle is now lifted into `App.jsx` so it survives switching tabs,
  reset back to "Mine" only on logout. Also: "Upcoming Visits" (a `status: 'planned'` mirror of
  Visit History) was added to both PlaceDetail and PersonDetail, then deliberately reverted from
  PersonDetail alone — route-planner-committed visits never get a `person_id`, so that card would
  read empty for everyone until the planning flow changes to support pinning a contact ahead of
  time. 153 tests pass, client build clean. Full narrative in `NOTES.md`'s matching entry. Not yet
  pushed.

---

## 14. Next steps / ideas (not yet done)

- **DONE (2026-07-22).** ~~Manually review the 7 places whose addresses didn't geocode~~ (§9A).
  5 turned out to be genuinely non-geocodable (2 PO Boxes, 3 "(Online)" referral sources with
  no physical address) — nothing to fix, `addStop` already refuses to route them with a clear
  error. The other 2 (Nebraska DHHS Administrative Offices, Southwood Lutheran Church) have
  real street addresses the free Census geocoder simply doesn't have indexed; cross-checked
  both against OpenStreetMap's geocoder (which resolved them exactly) and hand-set their
  `lat`/`lng` directly in the DB. Caveat: there's still no manual lat/lng override field, so if
  either place's address is edited again through the app, Census will fail again and the
  existing "address not recognized — save anyway?" dialog will null the coordinates back out if
  someone clicks through it. Fixing that for real means picking a second geocoding provider —
  a real design decision, not done here.
- **DONE (2026-07-29).** ~~Fix `CalendarDayModal`'s hardcoded title suffix~~ — first fixed with an
  explicit `title` prop, then rendered moot entirely: at Bede's request, the shared component was
  split into two dedicated ones, `CompletedVisitsModal.jsx` and `SkippedVisitsModal.jsx`
  (`CalendarDayModal.jsx` no longer exists), so there's no longer a shared title to mismatch.
- **Feed referral metrics into priority scoring:** `services/priority.js` still only scores
  off tier + the manual priority star; folding in a place's `referral_metrics` (e.g. boost
  the ones with high recent referral activity) is the natural successor to the old "Phase 2
  relationship-temp" idea now that there's an objective activity signal to use instead. (Note:
  the old `needs_attention` flag this used to reference was removed app-wide 2026-07-24 —
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

1. **FIXED (`dc5d940`, 2026-07-10). Deleting a person used to orphan their referrals — no
   snapshot, unlike visits.** `DELETE /api/people/:id` hard-deleted the person row;
   `referrals.person_id` went `null` via `ON DELETE SET NULL` with no snapshot columns
   (unlike `visits`), so the referral became permanently unattributed and silently vanished
   from every referral-metrics rollup. **Fixed** by deleting a person's referrals in the same
   transaction instead of orphaning them.
2. **FIXED (`dc5d940`, 2026-07-10). Editing a visit used to become permanently blocked once
   its linked person was deleted.** `VisitLogModal.jsx`'s `canSave` required a
   *currently-assigned* `person_id`, so once the linked person was deleted the edit form's
   person dropdown reset to empty and Save stayed disabled until a *different* live person
   was picked — silently reattributing that visit's history. **Fixed:** the picker now locks
   to the preserved name snapshot instead of requiring a live person when the original is gone.

Lower-priority findings from the same audit — status as of the 2026-07-14 follow-up audit
(`c408809`), which fixed most of these:
- **FIXED.** `People.jsx`, `Places.jsx`, and `AssignPersonModal.jsx`'s search/list loads now
  have error banners and a stale-response guard on their debounced search (a slower earlier
  response can no longer overwrite a faster later one).
- **Moot.** The People directory's missing "Departed" status is moot — the `departed` field
  was dropped from the schema entirely on 2026-07-11 (nobody was using it).
- **FIXED (2026-07-22).** Places created via the Needs Mapping "create place" flow
  (`server/src/routes/notesReview.js`) used to skip geocoding entirely — a second, hand-rolled
  insert path that duplicated `POST /api/places` but never called `geocodeAddress(...)`. Now
  calls it the same way, best-effort and non-blocking.
- **FIXED.** `Schedule.jsx`'s remove/skip-stop actions now confirm, error-handle, and disable
  the row while in flight, matching `removeVisit()` elsewhere.
- **FIXED.** `places.category` is now a locked enum (`server/src/config/categories.js`), not
  free text — `POST`/`PATCH /api/places` reject any non-matching value. Bede deliberately
  deferred building an "add a category" admin UI until it's actually needed.
- **FIXED (2026-07-22).** Filter dropdown options (category/tier/region in Places.jsx, the
  place picker/filter in People.jsx) used to be fetched once per mount and not refresh when a
  new value was added elsewhere in the same session. Both now re-fetch alongside the row list
  on every create/edit/delete.

**New findings from the 2026-07-14 full-codebase audit (`c408809`), both fixed same day:**
- **Critical, was live in production:** `GET`/`POST /api/users` returned full user rows
  including `password_hash` and the live `auth_token` with no column filtering — any
  authenticated user could grab another user's session token and impersonate them. Fixed with
  a `SAFE_COLUMNS` select, matching `routes/auth.js`'s existing `publicUser` pattern.
- **Live-breaking bug in the scheduler actually in production use:**
  `services/scheduler.js`'s `generateSchedule()` used `.whereNotIn('id', subquery)` where the
  subquery could return a NULL `place_id` (an expected state under detach-not-delete) — SQL's
  `NOT IN` against any NULL evaluates to NULL for every row, so once any place had ever been
  deleted, route generation would silently return zero candidates forever, for every user.
  Fixed with `.whereNotNull('place_id')` on both subqueries.

What's confirmed solid (don't second-guess these without new evidence): referral-metrics
rollups are correctly live-computed from each entity's *current* state, never stale/stored;
`needs_attention`/`never_visited` are computed live on every read; detach-not-delete now works
correctly everywhere, including people→referrals.

**Correction, 2026-07-15:** the "detach-not-delete now works correctly everywhere" line above
was too broad. The same `.whereNotIn()`/inner-join-against-a-nullable-FK bug class recurred —
`dashboard.js`'s "never visited" widget had the identical `whereNotIn` bug as the old scheduler
(fixed same day, `.whereNotNull('place_id')`), and its "completed this week"/"needs attention"
queries had the same class again via INNER JOIN instead of LEFT JOIN (also fixed same day). That
makes **3 occurrences across 2 files** now, not the isolated one this section implied — see the
2026-07-15 bullet in §0 and `NOTES.md`'s "Code-quality bug hunt" entry for the fixes. Don't
treat "confirmed solid" as proof this bug class can't recur elsewhere; a dedicated grep sweep
for `whereNotIn`/inner joins against nullable FK columns is still worth doing in a future audit.

---

## 14B. Route-planner readiness (2026-07-10 assessment)

**Very stale as of 2026-07-15 — the route planner is done on the backend/API side and now
fully usable end-to-end in the UI, on branch `bede-routeplanner` (not yet merged to `main`).**
Everything below this point describes the *pre-build* state (nothing existed yet) and should
not be trusted for current status — read `ROUTEPLANNER_PROGRESS.md` at the repo root instead,
kept up to date phase-by-phase. Short version: phases 1-6 are all built, tested (139 tests), and
committed — four-tier scoring engine, drive-time via a real routing API (OSRM) with
stop-sequencing optimization, visit-type durations, a multi-day draft generator, and a full
draft/commit lifecycle with multi-user collision handling. On top of that, all three frontend
sub-slices are built and verified live: a "Plan My Visits" tab with generate, live editing
(reorder/add/remove/visit-type, in-place time recalculation, over-budget flagging),
suggestions, and commit (per-day and full). The old scheduler this whole section originally
assumed would still be the app's only option is now fully retired (2026-07-15) — the route
planner is the only route-planning surface left in the app.

Bede's next planned feature is a real route planner (plan a day's driving route between
places). Assessed what's actually ready vs. missing:

**Ready:**
- `lat`/`lng` are populated for 255/262 places (§9A) and already returned by
  `GET /api/places` / `GET /api/places/:id` (plain `p.*`/spread, nothing strips them) — no
  backend change needed to start reading coordinates.
- `region` (side-of-town bucket, `services/priority.js`) is already computed and stored per
  place, usable as a coarse pre-filter.
- `services/geocoding.js` is a clean, swappable single-function boundary if a real routing
  provider (driving-distance/duration, not just geocoding) gets added later.
- Referral-metrics rollups (needed if routing ever factors in referral activity) are solid
  and live-computed — see §14A's "confirmed solid" note.

**Missing (in rough build order):**
1. **The 7 unmatched-address places** need manual review/correction before a router can trust
   "every place has coordinates."
2. **No distance/duration math anywhere.** `services/scheduler.js`'s `clusterSort` only buckets
   by `region` → `city` → zip-code-number proximity — a coarse sort, not geographic routing.
   No haversine calc, no routing-API call, nothing touches `lat`/`lng` in `scheduler.js`,
   `priority.js`, or `routes/schedule.js`. Neither `client/package.json` nor
   `server/package.json` has a mapping/routing library (no leaflet, mapbox-gl, turf,
   google-maps, osrm-client, etc.) — this is the core missing piece.
3. **No visit-duration, time-window, working-hours, or driver-start-location data anywhere in
   the schema.** `scheduler.js`'s `DEFAULT_VISIT_MINUTES`/`DEFAULT_TRAVEL_MINUTES` are
   hardcoded global constants, not per-place/per-visit/per-user data. `users` has no
   home-base/start-location field. A real router needs at least a start point and per-stop
   duration estimates — this needs a schema decision, not just new logic.
4. **`Schedule.jsx` presents visits in priority/region-bucket order, not a geographically
   routed order** — no distance shown between stops, no map, no multi-stop route. "Navigate"
   builds a single-destination Google Maps link from address text, not coordinates.
5. **No UI surfaces lat/lng at all** — no map view, no "needs geocoding" indicator anywhere in
   `Places.jsx`/`PlaceDetail.jsx`.
6. **No "pick which places to route today" selection UI** — `generateSchedule`
   (`scheduler.js`) auto-picks candidates by priority/never-visited; there's no way to
   manually choose a subset to route.

**Suggested build order:** (a) resolve the 7 unmatched addresses, (b) add a distance/duration
engine (haversine is enough to start; a real routing API is a later upgrade) plus a driver
start location and a per-stop duration model — this is a schema change, decide it early, (c)
wire that into `scheduler.js`'s ordering in place of/alongside `clusterSort`, (d) surface it in
`Schedule.jsx`/`PlaceDetail` with an actual map.

---

## 15. Quick "resume tomorrow" checklist

1. Open the folder: `code ~/guardian-angels-sales`
2. Ensure Node: `nvm use 24` (or rely on `./dev.sh`)
3. `git checkout bede-working` — active work happens here, periodically merged into `main`
   (most recently 2026-07-22, all pushed). `bede-routeplanner` was the branch for this
   *before* 2026-07-15's merge — long since folded into `main`, don't resume work there.
4. Start it: `cd ~/guardian-angels-sales && ./dev.sh` → open http://localhost:5173
5. Check `git status` before starting anything new — ask Bede before committing, always.
6. Read `ROUTEPLANNER_PROGRESS.md` before touching the route planner — it's the up-to-date
   source of truth, phase-by-phase. All three frontend sub-slices are done and the old
   scheduler is fully retired — the route planner is the app's only route-planning surface.
7. §14A's two critical bugs are fixed — no need to fix them again, just don't reintroduce them.
8. Read §16 before touching relationship level or visit outcomes — the outcome enum changed and
   relationship is now computed, not stored.
9. Read §18 (and `capacity-computation-spec.md`) before touching capacity, the EXPLORATION tier,
   or scheduling cadence — capacity is now computed too, steps 1–5 of 9 only, and there's a
   temporary dual-write bridge in `routes/visits.js` that must be deleted at step 6.

---

## 16. Computed relationship level (built 2026-08-03)

Replaces the manual `places.relationship_level` field. Built from Bede's own written spec;
this section records what was built, the decisions taken along the way, and what's deliberately
left open.

### Why

`relationship_level` is one of the two axes of `config/scheduling.js`'s cadence table (the other
is `capacity_level`). It defaulted to `'weak'`, had no write path in any route or UI, and had
never been edited — so **every place in the database read `'weak'`**, and the cadence table was
effectively running on capacity alone. That's the same failure that killed the old
`relationship_temp` field (§9): a manual "smart" field that needs upkeep and doesn't get it.

### The model (`server/src/services/relationship.js`)

Relationship is measured **per person** and rolled up to the place — a relationship is with
Sharon at Tabitha, not with Tabitha. Nothing is stored; it's computed live on every read, same
convention as referral metrics (§9).

- **Per-visit weight** = who you met × what happened. `named_person` 1.0 / `staff` 0.35 /
  `receptionist` 0.15 / `nobody` 0.05, times `substantive` 1.0 / `introduced_new` 1.0 /
  `brief` 0.6 / `materials_only` 0.25 / `unavailable` 0.15 / `declined` 0.1. A real sit-down
  scores 1.0; a front-desk brochure drop scores 0.0125 — an ~80× spread, which is the point.
- **Decay**: every visit's weight halves every half-life. 30 days for fast-moving categories
  (`Assisted Living & Senior Living`, `Community Partners`, `Hospice`, `Hospitals`,
  `Physical Therapy`, `Physicians`, `Rehabilitation Centers`, `Legal & Trust`), 60 days for
  everything else including any category added later. Exact strings must match the seeded
  `categories` table — a near-miss silently falls through to the default, so there's a test
  guarding precisely that.
- **Reciprocity multiplier** measures *their* investment, not the rep's: +0.0625 per known
  personal detail (birthday, preferences, email, phone), ×1.15 if they've ever referred,
  ×1.1 if they asked us for something within the trailing half-life. Capped at ×1.6.
- **Place rollup**: people sorted by score, each worth half the last (`p0 + 0.5·p1 + 0.25·p2…`),
  plus a floor from visits that never met a named person. One champion beats six lukewarm
  contacts; a zero-scoring contact contributes exactly zero at any position, so extra weak
  contacts can never dilute a strong one.
- **Buckets**: strong ≥ 3.4, medium ≥ 1.3, else weak — category-independent by design, since
  steady-state score depends only on the *ratio* of visit cadence to half-life.

**Axis separation is load-bearing.** Relationship must never read referral *volume* — that's the
capacity axis. If both axes read the same signal they collapse into one and the deliberate
inversion that makes the cadence table valuable (high-capacity + weak-relationship gets visited
most often) stops working, because that cell empties out by construction. "Has ever referred" is
allowed as a **binary**; the referral query selects `DISTINCT person_id` and never a `COUNT`
specifically so the model has no access to volume.

### Seeding

Without intervention every place reads `weak` on day one. `people.relationship_seed` holds a
one-time converged score value (Champion 4.0 / Solid 2.0 / Acquaintance 0.8) that **decays on
the same clock as real visit weight** — ~3% of original after five months on a 30-day category.
No expiry logic, no cleanup task: a real relationship gets visited and earns genuine score as
the seed fades; an optimistic seed never followed up decays to nothing, which is the honest
answer. *A seed is a claim with an expiration date attached; an override is a claim that is
silently wrong forever.* UI: People tab → "Seed relationships". Re-runnable — re-seeding
overwrites the value and resets the decay clock.

### Override

`places.relationship_level_override` + `_at` + `_by`. The effective level is
`override ?? computed`, and that's what the scheduler reads. The UI **always shows the computed
value next to an override when they disagree** ("Set manually by Bede on 8/3 — computed: weak").
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
`effectiveRelationshipLevel()` has a fallback to it that exists only for that transition —
delete the fallback along with the column.

*(Migration note, since the project convention here is easy to over-apply: adding a **new**
nullable FK column uses a plain `.alterTable()`. The `rebuildSqliteTable` dance from
`20260709000000` is only needed when CHANGING or DROPPING a column that already carries an FK.
Verified against the real dev SQLite — the new FK landed with `ON DELETE SET NULL` intact.)*

### Two decisions recorded here because the spec asked for them

1. **Visit outcomes: replaced outright, no dual-running.** See §0's summary. The old→new
   backfill is deferred to real-data-import time; unrecognized outcomes score at
   `OUTCOME_WEIGHT.declined` (0.1) rather than 0 or `NaN`, so old rows degrade quietly.
2. **`maybeCapturePreQualification` now gates on `capacity_status === 'estimated'`,
   not "is this the first visit."** The old rule had a trapdoor: miss the number on visit one
   and the place was never asked again, leaving it stuck on an estimated capacity forever —
   which meant permanently stuck in the ranker's exploration tier. The prompt now returns on
   every completed visit until a real number is captured, and stops the moment one is.

### Deliberately deferred — do NOT rediscover these as mystery bugs

- **Quality-weighted urgency clock.** `lastVisitDate` counts *all* completed visits regardless
  of quality, so a front-desk drop-off resets the urgency clock and trips the 5-day hard floor
  exactly like a substantive meeting — while contributing ~1% of the relationship weight. A rep
  doing easy drop-offs can therefore keep a place looking recently-visited and floor-blocked
  while its relationship score quietly decays. Two possible fixes, both out of scope here:
  weight the urgency clock by visit quality, and/or let the ENDANGERED tier trigger on
  relationship decay rather than urgency alone.
- **Old→new visit-outcome backfill**, and what `visit_weight` should resolve to for a
  backfilled visit whose outcome doesn't map cleanly. Both punted because all current visit
  data is test data.
- **Per-day `asOf` in the route planner.** `computeRelationshipForPlaces` already accepts
  `asOf`; `buildCandidatePool` passes generation-day only. Threading a per-day date through
  `generateDraft` (so day 5 of a plan sees slightly more decay than day 1) is separate work.
- **`capacity_level` is still never written by anything.** Seeded once by keyword-match against
  category in `20260712000000` and never touched since — so any place created after that
  migration has `capacity_level: null` and silently falls back to the `medium` cadence row.
  Pre-existing gap, unrelated to this work, but it's the *other* axis of the same table.
- **Threshold judgment call**: the spec's prose calls "visited at half the half-life rate" the
  *weak* boundary, but its own threshold constant (`medium: 1.3`) puts that case in **medium** —
  the true converged value is 1.3333, clearing 1.3 by only 0.033. Implemented per the explicit
  constant. If the prose was the real intent, `RELATIONSHIP_THRESHOLDS.medium` needs to move
  above 1.3333 (≈1.4). Flagged in `relationship.test.js` too.

### Testing

`server/src/services/relationship.test.js` — 46 tests (suite total: 154 → 200). Mostly pure
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
trip" — only an implicit one, recoverable by matching the shared fields across rows, which is
what the client was doing purely for display.

Now `visits` IS the trip and the new `visit_encounters` holds one row per person/category met
(see §4). Migration: `20260806000000_split_visit_encounters.js`.

### Why, and what it bought

The encounter-level model itself was right and is unchanged — `services/relationship.js` has
to score "substantive with Sharon" and "gatekept by the front desk" separately, which a single
flat row can't express. What was wrong was that the TRIP had no identity, so anything
visit-specific (vs. encounter-specific) had nowhere to live and every consumer had to re-derive
trip grouping for itself. It also silently caused a real bug: `routes/dashboard.js`'s "completed
this week" counted rows, so one 3-person trip read as 3 completed visits.

### Two traps this migration hit, both worth not re-learning

1. **Don't group pre-split rows by matching trip fields alone.** Two genuinely separate visits
   (a morning drop-off and an afternoon meeting at the same place, same day) with `notes` and
   `actual_duration_minutes` both NULL match on every field and would wrongly collapse into one
   — irreversibly; `down()` cannot recover it. The migration keys on `created_at` instead (one
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

- **A completed trip must have at least one encounter** — POST and PATCH both reject
  `status:'completed'` with an empty encounter set, and deleting the last encounter of a
  completed trip deletes the trip. A `planned` trip with zero encounters is normal and exempt.
- **Deleting the last encounter is warned about specifically.** The trip carries `notes` and
  `next_visit_date`, and `next_visit_date` is load-bearing — it's what puts a place in the
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
  never widened beyond `source='planner'` — extending it to manual logging is a separate
  decision, and manual same-day double-logging is still a deliberate capability behind the
  collision warning's "Save anyway".

### API shape

`GET /api/visits/:id` is new and returns the full trip with every encounter field — it's the
only call that does. List endpoints (`/calendar`, place/person visit history, dashboard) return
one row per trip with a lightweight `encounters: [{person_name, met_with_type}]` summary, so a
summary line renders without a second fetch. `people.js`'s `GET /:id` asks for `person_id` too
on top of that summary — it's the one caller that needs to tell "this person's own encounter"
apart from an attendee who merely shares their name (see PersonDetail.jsx's `otherAttendees`).
`DELETE /api/visits/:id/encounters/:encounterId` removes one person from a trip.

**Permission rule for the encounter endpoints matches `PATCH /:id`, not `DELETE /:id`:**
removing one encounter (or editing a trip's encounters via PATCH) is a correction any rep can
make cross-rep once the trip is completed/skipped — same as correcting notes or an outcome.
Only a still-`planned` stop stays locked to its own rep. Deleting the WHOLE visit outright
(`DELETE /:id`) is the stricter, owner-only rule; that asymmetry is deliberate; encounter-level
edits and whole-visit deletion are different acts.

`VisitLogModal` no longer has separate create vs. edit UIs — creating an ad-hoc visit,
completing a planned route-planner stop, and editing an existing trip all use the same
multi-encounter flow, which deleted a large parallel code path rather than adding one.

### Known gap, deliberately deferred — read before touching skip functionality

`VisitDetailModal.jsx`'s `deletesTrip` check reads `trip.status !== 'planned'`, but the server
only actually auto-deletes the trip (in `DELETE /:id/encounters/:encounterId`) when
`visit.status === 'completed'`. A `skipped` visit that somehow carries encounters falls into the
gap: the client would show the destructive "whole visit will be deleted" warning, the server
would leave the trip standing, and the client would close the modal believing it was gone.

**Currently unreachable** — nothing in the app sets a visit's status to `skipped` today (only
`VisitLogModal` calls `updateVisit`, always with `status: 'completed'`), but `SkippedVisitsModal.jsx`
already exists reading that status, so a skip feature is clearly intended. Bede: fix this as
part of building that feature properly, not in isolation — the right fix depends on what a
skipped-with-encounters trip is even supposed to mean once that exists.

---

## 18. Computed capacity (steps 1–5 of 9 built 2026-08-07)

Replaces the manual `places.capacity_level`, the frozen `places.capacity_monthly_referrals`, and
the one-way `places.capacity_status` latch. Built from Bede's own written spec —
[capacity-computation-spec.md](capacity-computation-spec.md), 15 sections, saved into the repo
root at the same time as this section (the code had been citing it by filename all along, but it
had only ever existed as pasted text — if you're looking for the spec and can't find it, that's
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
(spec §3). The pre-qual answer and the `referrals` table measure different things — total
referrals to anyone, vs. referrals to us specifically — so a place that claimed 15/month and
sends us 0 might be sending all 15 to a competitor. Demoting it to `low` would permanently route
sales away from the highest-value kind of target in the database. Downward correction only ever
happens through a human re-ask or an explicit override.

- **declared**: latest `capacity_observations` row for the place.
- **measuredFloor**: our own referral throughput converted to a monthly rate, gated behind a
  minimum exposure window (180 days) and minimum count (3) so small samples can't manufacture a
  floor.
- **effectiveMonthly**: `max(declared, measuredFloor)` — the asymmetry invariant, enforced in
  exactly one place and covered by a named test that fails loudly if it's ever made bidirectional.
- **level**: bucketed from `effectiveMonthly` — low 0–5, medium 6–15, high 16+ — unless an
  override is set, or nothing's ever been observed/measured, in which case it falls back to a
  category-seed guess (the same real keyword table that already seeds `places.capacity_level`
  today).
- **confidence**: `unknown` (never pre-qualified) / `stale` (declared observation older than 365
  days) / `fresh`. Replaces the old `capacity_status` latch. An override does not make a place
  fresh — it still needs re-asking, the override just says don't trust the stale number meanwhile.

### Schema (2 migrations, `20260807000000`–`20260807000001`)

- `capacity_observations` (new table): append-only declared-capacity log. One row per pre-qual
  answer or manual adjustment; nothing is ever overwritten — this is what lets PlaceDetail show a
  partner's pipe visibly growing over three years. Backfilled from every place's prior
  `capacity_monthly_referrals`.
- `places`: `capacity_override_level`, `capacity_override_reason`, `capacity_override_at` — same
  pattern as `relationship_level_override`, one field lighter (a free-text reason instead of a
  `_by` user id).

### Override

Same anti-rot mechanism as relationship's override (§16): the UI always shows computed vs.
override side by side when they diverge, so a stale manual call is visible, not silently trusted
forever.

### Judgment calls recorded here because the spec asked for them (or a spec error was caught)

1. **§13 test 2 ("Asymmetry — down") had a bucket-boundary contradiction** — its prose said
   "Declared 15, measured 0 → level high," which contradicts the spec's own §4 boundaries (medium
   is 6–15; high starts at 16). Implemented per §4 — declared 15 buckets to `medium` — since the
   invariant the test actually exists to verify (the value isn't pulled down by a low measurement)
   holds either way. Corrected directly in `capacity-computation-spec.md` §13 so this doesn't
   resurface as a live contradiction; same pattern as the 2 errors caught in the relationship spec
   (§16).
2. **`measuredFloorByPlace` reads `referrals.place_id` directly**, not the live `people.place_id`
   join `referralMetrics.js`'s own place rollup uses. Deliberate — see the "will disagree" note in
   §0 above and the addendum in `capacity-computation-spec.md` §12.
3. **Return shape extends the spec's literal §6 fields** with `computedLevel`/`isOverridden`,
   needed to satisfy §11's "show computed vs. override side by side" UI requirement, which the
   literal `level`/`levelSource` alone can't render. Mirrors `relationship.js`'s existing
   `level`/`effective_level`/`override` shape.
4. **`CATEGORY_CAPACITY_SEED` uses the real keyword table** already seeding
   `places.capacity_level` (migration `20260712000000`, tuned against this app's actual category
   strings), not the spec's illustrative placeholder categories — the spec's own text says to
   reuse whatever the app already seeds from.

### Testing

`capacity.test.js`, 11 tests, covering the in-scope spec cases (asymmetry both directions, bucket
boundaries, exposure gate, staleness, override precedence, `asOf`, bulk parity, empty case). Spec
tests 7–12 (EXPLORATION ordering/aging, drop-off detector) intentionally not written — they test
code from steps 8–9, not built. `npm run capacity:distribution` is the health-check readout (mirrors
`relationship:distribution`); run again before wiring step 6/7 in.

### Deliberately deferred — do NOT rediscover these as mystery bugs

- **The dual-write bridge** (`routes/visits.js`'s `maybeCapturePreQualification`, see §0 above) —
  writes the legacy `capacity_monthly_referrals`/`capacity_status` columns alongside the new
  observation row, purely so `schedulingEngine.js` (still reading only the old columns) doesn't
  strand pre-qualified places in EXPLORATION forever. Delete it the moment step 6 lands.
- **Capacity vs. `referralMetrics.js` disagreement for job-changing contacts** — see §0 above.
  Correct in both cases; will look like a bug the first time someone notices.
- **Steps 6–9 are not started**, by Bede's own pacing choice (steps 1–5 now, stop and report,
  steps 6–9 later): swapping `schedulingEngine.js`'s cadence lookup to the computed service,
  fixing the EXPLORATION tier's tie-break (a real launch blocker — ties currently pick a day's
  entire zone at random), the drop-off detector, and dropping the three legacy columns.
- **The distribution readout validated the category-seed axis, not the 6/16 thresholds** — 99.6%
  of real places are still `category_seed`/`unknown` confidence (expected — real places, test-only
  referral/visit history). Re-check the thresholds once roughly 30 real pre-quals exist.
