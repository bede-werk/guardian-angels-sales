# Working Notes — Where I Left Off

## 2026-07-07

Big session — took the app from a bare visit-scheduler to the start of a real CRM.
In order:

### 1. Authentication
- Added a proper login landing page: pick your name from a dropdown, then either
  log in (if you already have a password) or set one for the first time.
- Passwords are bcrypt-hashed; sessions use a bearer token stored on the user row,
  rotated on login/password-change, cleared on logout.
- Every API route except `/api/auth/*` and `/api/health` now requires a valid
  token — the data is actually locked down, not just hidden behind a UI gate.
- Added a "Change password" flow from the header.
- Removed the old "Team member" switcher dropdown from the header — who you're
  acting as is now just whoever is logged in. (Prior behavior: anyone could plan/
  view any rep's route from one shared session.)
- Locked the header date to always show *today*, read-only — no more picking an
  arbitrary date. (Planning a route for a different day is a follow-up idea, not
  built yet.)

### 2. CRM data model: Places vs. People
- Split the old flat "partners" idea into two real entities, per the brand/CRM
  spec: **places** (organizations you visit — tier, priority, address, region)
  and **contacts** (people at a place — role, relationship temperature hot/warm/
  cold/dormant, departed flag, primary flag).
- Added a `referrals` table (partner_id/place_id + contact_id) so referral
  attribution can eventually feed back into place priority — schema only, no
  logic wired up yet.
- Rescaled priority scoring to Tier 1 + ⭐ = 100 / Tier 1 = 75 / Tier 2 = 50 /
  Tier 3 = 25 (was 35/30/20/10) and backfilled all existing rows.

### 3. Full visual/brand redesign
- Built out the real Guardian Angels brand system: Blue/Teal/Mauve/Grey palette,
  Source Serif 4 (headings) + Nunito Sans (everything else) as free substitutes
  for the licensed Minion Pro/Avenir fonts, real logo SVGs + generated favicons.
- Built a small reusable component library (`client/src/components/ui/`): Logo,
  Button, Card, Chip (tier/status/outcome/category), TemperatureDot, StatTile,
  EmptyState, Header, Splash.
- Rebuilt every screen against it: branded login/splash, Today's Route (progress
  bar, "who to ask for" with temperature dot, mauve never-visited flag, Navigate/
  Log Visit buttons, mobile slide-up sheet for Log Visit), Partner→Place Detail
  ("People here" contact cards, referral placeholder, visit history), Dashboard
  (stat tiles + new "Needs attention" panel: departed/cooling contacts + overdue
  next-visit dates), Places directory, Needs Mapping.
- Added basic contacts CRUD (add/edit a person at a place, mark primary/departed)
  since the redesigned screens needed real data to show instead of empty states.
- Added a 5th visit outcome, "Left materials."

### 4. Cleared old data for a clean slate
- At the user's request, wiped all 260 `visits` rows and the 110-row Needs
  Mapping backlog so every place shows "never visited" while the app is still
  being built. Source spreadsheets are untouched — re-running `npm run
  import:notes` later will regenerate this data whenever it's time to go live.

### 5. Commented the whole codebase
- Went through every server and client source file and added explanatory
  comments (file purpose, what each function/component does, non-obvious logic)
  so the code is readable end to end, not just to me.

### 6. Renamed "partner" → "place" everywhere
- The CRM spec settled on Place/Person as the two core entities, so did a full
  literal rename: the `partners` DB table, every `partner_id` FK column, every
  route/service/variable/component name, UI copy, and both README.md/HANDOFF.md.
- `PartnerDetail.jsx` → `PlaceDetail.jsx`, `Partners.jsx` → `Places.jsx`,
  `/api/partners` → `/api/places`, etc.
- Left alone on purpose: real data strings like the "Aging Partners" place name
  and "Community Partners" category — those are business names, not code terms.

## 2026-07-08

A big CRM-buildout session happened earlier this day too (Places CRUD, People tab,
detach-not-delete semantics, a person-attributed referral system, and a manual
`relationship_temp` field with a computed suggestion) — it's not written up as its
own entry here, but it's committed (`95b484b`/`2547bfb`, merged PR #4) and fully
documented in `HANDOFF.md` sections 4–10 if you need the detail.

### Removed relationship temperature, replaced with referral metrics
The manual `hot/warm/cold/dormant` field on people (plus the suggestion feature
from the session above) is gone. It never actually got kept up to date in
practice — a suggestion next to a stale manual value isn't useful — so at the
user's request it's replaced entirely with **objective, time-aware referral
metrics** that need no manual upkeep:
- For every person, and rolled up for every place: **lifetime referral count**,
  **last referral date** ("none yet" if there aren't any), and **referrals in
  the last 90 days**.
- A person/place with referrals in the past but nothing in the last 90 days is
  flagged **"needs attention"** — surfaced on the Dashboard's Needs Attention
  card, and as a filter + badge on both the People and Places tabs.
- Edge cases handled explicitly: brand-new (zero lifetime referrals) reads as
  "none yet," never as needing attention — only a referrer who's gone quiet
  after actually referring before gets flagged.
- New: `server/src/services/referralMetrics.js` (all the computation logic),
  `server/src/migrations/20260710000000_drop_relationship_temp.js` (drops the
  column). Deleted: `server/src/services/relationshipTemp.js`,
  `client/src/components/ui/TemperatureDot.jsx`. Updated: the people/places/
  dashboard routes, the scheduler's primary-person query, and every screen that
  used to show a temperature dot (People, Places, PersonDetail, PlaceDetail,
  Dashboard, Schedule).
- Smoke-tested against the real dev DB (inserted/removed dated test referrals on
  the existing "Lionel Messi" test person to exercise the 90-day boundary, then
  cleaned up) — see `HANDOFF.md` §9/§10 for the full writeup, including a note
  that this session's smoke test used Bede's own account for a temp auth token
  instead of the usual passwordless test user, which it shouldn't have.

## 2026-07-09

A polish-and-fill-gaps session on top of the 2026-07-08 CRM buildout — no new
entities, mostly making the People/Places detail views actually complete and
adding one real new capability (geocoding). Five commits through the day
(`74ca2a1`…`cb706a8`), all committed.

### 1. Geocoding — places now have real lat/lng
- New `server/src/services/geocoding.js`: one function, `geocodeAddress()`,
  against the US Census Bureau's free public geocoder (no API key needed).
  Returns `{ lat, lng }` or `null` — best-effort only, never blocks creating/
  editing a place if it fails.
- Wired into `POST /api/places` and `PATCH /api/places/:id`: whenever
  address/city/state/zip is set or changes, the place is automatically
  re-geocoded and `geocoded_at` stamped.
- New backfill script, `npm run geocode` (`server/src/scripts/geocode-places.js`),
  using the Census's *batch* endpoint (up to 10k addresses/request) to geocode
  every existing place that doesn't have a `geocoded_at` yet in one shot —
  safe to re-run, only touches unprocessed rows.
- New migration `20260711000000_add_geocoded_at_to_places.js` adds the
  `geocoded_at` timestamp. The `lat`/`lng` columns themselves already existed
  (added back in the original places/people schema for future routing use)
  but were never actually populated until now.
- Nothing in the UI consumes lat/lng yet (no map view) — this just lays the
  groundwork by making sure the data's actually there.

### 2. Visit detail popup + editing, in both People and Places
- New `client/src/components/VisitDetailModal.jsx` — a read-only popup with
  everything on file for one visit (status, outcome, logged-by rep, full
  contact snapshot, notes, next-visit date), reached by clicking a visit row
  in either PersonDetail or PlaceDetail. Has an Edit button that opens the
  existing `VisitLogModal` pre-filled so it PATCHes instead of creating a
  duplicate.
- This let the inline visit-history rows themselves get decluttered — they
  used to show status/outcome chips and the full contact snapshot inline;
  now they're just date + who/where + a notes preview, with everything else
  moved into the popup.
- Visits can now also be deleted directly from either detail view (a small ✕
  on the row) — `DELETE /api/visits/:id`, no route change needed, this was
  just never wired up client-side before.

### 3. Places can finally be edited
- `PlaceModal.jsx` only ever supported *creating* a place — there was no way
  to fix a typo'd address or category on an existing one short of delete +
  recreate. It now doubles as an edit form: pass it a `place` prop and it
  pre-fills and PATCHes instead of POSTs. Wired up via a new "Edit" button on
  `PlaceDetail`.

### 4. PersonDetail brought up to parity with PlaceDetail
PersonDetail's notes/preferences/birthday used to be one static block, edited
all-or-nothing. It now matches the click-to-edit pattern PlaceDetail's notes
already had — each of the three fields is independently click-to-edit with
its own Save/Remove, and PlaceDetail's own notes gained a Remove option it
was missing (edit-only before today). Also: the contact block (phone/email)
moved to the top of the card as its own tinted panel, the role_type badge is
now visible in the header, and clicking a person's assigned place jumps
straight to that place instead of needing a separate "View place" button.

### 5. Small UX polish, app-wide
- Hover tooltips (`title=`) added to nearly every button and icon-only
  control — closes, filter toggles, detach/delete actions — for affordance.
- New reusable `.hover-row` CSS class (subtle blue-tint hover) for the new
  crop of click-to-edit/click-to-view rows, with a `:has(.btn:hover)` rule so
  a nested button's own hover state wins instead of both lighting up.
- Dates are now formatted `M/D/YYYY` for display everywhere (new
  `formatDate()` helper in `api.js`) instead of showing the raw
  `YYYY-MM-DD` storage format — visit dates, referral dates, the header date,
  dashboard stat hints, Needs Mapping note dates, all of it. Storage/query
  format is unchanged, this is display-only.
- The "unassign a person from a place" (✕) button changed from a red danger
  button to a plain ghost button in both detail views — it wasn't destructive
  enough to earn the red treatment (the person isn't deleted, just detached).

## 2026-07-10

A polish session on the People/Places detail views, then a full audit at Bede's request
before he moves on to the route planner. Was uncommitted when originally written up below;
**all of it was committed later the same day** as `848b246`/`dc5d940` — see the correction
in the "Full audit" entry below and don't trust the "uncommitted" framing that follows.

### 1. Delete buttons + standardized inline-editor button layout
- `ReferralDetailModal.jsx` and `VisitDetailModal.jsx` both got a bottom-left **Delete**
  button (wired to the existing `removeReferral`/`removeVisit` handlers, which already
  confirm + error-handle) — these popups previously only offered Edit.
- Place notes and Person notes/preferences/birthday's inline click-to-edit forms were all
  standardized to the same button layout: **Delete** far left (only shown once there's a
  saved value to delete), **Cancel** and **Save** grouped on the right with **Save always the
  rightmost button**. Button label changed from "Remove" to "Delete" throughout for
  consistency with the popups above.
- Person's preferences field changed from a single-line `<input>` to a resizable 3-row
  `<textarea>`, matching notes (same Enter-to-save / Shift+Enter-for-newline behavior).

### 2. Editing one field now backs out of any other in-progress action
Previously, clicking to edit notes while preferences was already mid-edit left both open at
once — same for opening any other action (Assign to a place, Log a referral, viewing a
referral/visit row, clicking Edit) while a field edit was in progress. Now:
- `PersonDetail.jsx` — `beginEditNotes`/`beginEditPreferences`/`beginEditBirthday` each close
  the other two fields (and the assign-to-place picker) before opening; a new
  `exitFieldEdits()` is called from every other action button/row (Assign to a place, Log a
  referral, viewing a referral/visit row, Edit) so starting any of those also backs out of
  whichever field was mid-edit.
- `PlaceDetail.jsx` — same idea, simpler since there's only one field (notes):
  `setEditingNotes(false)` threaded into Assign person, New person, Log a referral, Log a
  visit, viewing a visit row, viewing a person row, and Edit.
- This extends the existing "backdrop click cancels an in-progress edit" behavior
  (`handleBackdropClick` in both files) to cover every other way to navigate away, not just
  the backdrop.

### 3. AssignPersonModal's "browse unassigned" list is back
`AssignPersonModal.jsx` (opened from PlaceDetail's "Assign person" button) used to require
typing something before showing any results. It now loads and shows every currently-
unassigned person by default (labeled "Unassigned people"), on top of the existing 200ms-
debounced search-everyone box, which still works for reassigning someone from another place.

### 4. Full audit of People/Places + route-planner readiness
Bede asked to review the whole People/Places surface — "does it look good, am I missing
anything" — before starting the route planner, and to split into as many agents as needed.
Ran 4 parallel agents (People flow, Places flow, shared visit/referral machinery, and a
route-planner-readiness pass). **Full findings written up in `HANDOFF.md` §14A (known issues)
and §14B (route-planner readiness) — not duplicated here, go there for the real detail.**
Headlines:
- **Two real data-integrity bugs, found and fixed the same day (`dc5d940`):** deleting a
  person used to orphan their referrals with no snapshot (unlike visits), silently vanishing
  them from every metric forever; and editing a visit used to become permanently blocked once
  its linked person was deleted, because `VisitLogModal` required picking a currently-assigned
  person to save. Both contradicted the app's own detach-not-delete convention. Fix: deleting a
  person now deletes their referrals in the same transaction instead of orphaning them;
  `VisitLogModal` no longer requires a live person — it locks to the preserved name snapshot
  when the original person is gone.
- **Correction to earlier notes/HANDOFF entries:** the geocoding backfill (§9A in HANDOFF,
  and the "Next steps" list below) said it "hasn't been run yet against the real dataset" —
  that was checked against the live dev DB during this audit and is **no longer true**: 255 of
  262 places have `lat`/`lng`. 7 addresses didn't match and need manual review. Both
  HANDOFF.md and this file's "Current state"/"Next steps" sections below have been corrected.
- **Route-planner readiness:** geocoding data is ready, but nothing downstream uses it yet —
  `scheduler.js` only does priority + region/zip-bucket clustering, no distance/duration math
  anywhere, no mapping library in either `package.json`, no visit-duration/time-window/driver-
  start-location fields in the schema, no UI shows a map or per-stop distance. See HANDOFF
  §14B for the full punch list and suggested build order.
- Several medium-priority gaps also flagged (silently-swallowed fetch errors and stale-
  response races in People/Places/AssignPersonModal search, Departed status invisible in the
  People list, Needs-Mapping's place-create path skips geocoding, Schedule.jsx's remove/skip
  actions missing confirm/error-handling that the equivalent action has elsewhere, unnormalized
  category free text) — see HANDOFF §14A for the complete list.

## 2026-07-11 to 2026-07-13 — Route planner phases 1-4

Started the route planner in earnest on branch `bede-routeplanner`. Dropped the unused
`departed`/`is_primary` flags on people (2026-07-11 migration — neither was ever really used).
Then, phase by phase, each stopped for review before the next started:
- **Phases 1-2** (`2661151`): a four-tier lexicographic scoring/eligibility engine
  (`schedulingEngine.js`) — commitments beat endangered/rescue beat exploration beat
  maintenance, never additive. 15 tests.
- **Phase 3** (`bda0ee8`, `5a104a2`): a drive-time estimator (haversine × circuity factor,
  distance-banded speed) and visit types with real durations — `drop_in`/`check_in`/
  `working_visit`/`presentation`/`pre_qualification` (`87024c0` later split the old single
  "standard" type into check-in and working-visit once Bede wanted that distinction) — plus
  time-block packing that greedily trims a day's stops to a budget.
- **Phase 4** (`1ac0776`): a multi-day draft generator — walks N working days, re-ranks the
  candidate pool fresh against *each day's own date* (not once against today), assigns each
  day a zone (reusing the existing `places.region` field), dedupes packed places across days.
- Also fixed a small UI bug the same week: the angel icon overlapping the sticky modal
  header/footer while scrolling (`81e60b8`).

69 tests passing by the end of phase 4. Full design rationale for all of this (including
several explicit "don't re-derive this" decisions) lives in `ROUTEPLANNER_PROGRESS.md` at the
repo root — that file, not this one, is the source of truth for the route planner's
architecture; this entry is just a pointer.

## 2026-07-14 — Route planner phases 5-6 (backend+API), full codebase audit, and phase 6 frontend sub-slices 1-2

The biggest single day on the route planner so far. In order:

1. **Phase 5** (`84d32bf`): replaced the haversine drive-time estimate with a real routing
   API — OSRM's public demo server, chosen deliberately over Google/Mapbox to keep the same
   free/no-key posture as the existing Census geocoder, and because cost-consciousness is a
   running theme here (Railway was taken down earlier specifically to avoid ongoing cost).
   Added real stop-sequencing/route optimization on top (rank order still picks which stops
   are candidates; the optimizer only sequences them — an explicit, confirmed tradeoff). A
   `/code-review high` pass caught and fixed 5 real issues before this got committed (a
   malformed OSRM response silently producing `NaN` math, a config override not reaching the
   optimized path, a swallowed error masking real bugs as "OSRM is down," commitments
   droppable with no visibility, and a smarter batched top-up redesign). 110 tests.
2. **Full codebase audit** (`c408809`) — Bede asked for a clean-code pass ("find dead code
   and bugs... I want this project very clean"), 4 parallel agents across
   routes/services/migrations/client. Found and fixed same-day, most notably: **a real
   security leak** — `GET/POST /api/users` returned every user's `password_hash` and live
   `auth_token` with no column filtering, so any logged-in user could grab another user's
   session and impersonate them; and **a live-breaking bug** in the OLD scheduler
   (`services/scheduler.js`, still what `Schedule.jsx`/dashboard actually use) — a
   `.whereNotIn()` subquery could return a NULL `place_id` (an expected, normal state under
   this app's detach-not-delete model), and SQL's `NOT IN` against any NULL evaluates to NULL
   for every row — meaning route generation would have silently returned zero candidates
   forever, for every user, the first time any place was ever deleted. Also: locked
   `places.category` down to a real enum instead of free text (18 canonical values, matching
   what was already clean in the live DB — no admin UI to add more, deliberately deferred
   until actually needed), added missing error handling/stale-response guards across
   People/Places/AssignPersonModal, and a handful of smaller cleanups. 112 tests. Only
   remaining item: Bede is removing `NeedsMapping.jsx` himself — flag dangling references
   (`App.jsx`'s nav, `routes/notesReview.js`) once that happens.
3. **Phase 6, backend+API** (`95049c7`): the draft/commit lifecycle — dedicated
   `schedule_drafts`/`schedule_draft_stops` tables (not reused `visits` rows), a live-edit-safe
   never-drop time evaluator alongside the existing greedy packer, and
   `/api/schedule-drafts/*` routes (generate/active/reorder/add-stop/remove-stop/
   set-visit-type/suggestions/commit-one-day/commit-all). A required two-user smoke test (not
   just happy-path) caught a real deadlock bug in commit-time collision checking before this
   shipped — see `ROUTEPLANNER_PROGRESS.md` for the exact mechanism. 139 tests. Old scheduler
   deliberately left running unchanged — no frontend existed yet for the new engine.
4. **Phase 6 frontend, sub-slice 1** (`ce2f41f`): the first slice of the new UI — a "Plan My
   Visits" tab (next to, not replacing, "Today's Route") with a generate form and a read-only
   render of the multi-day draft. Built on the real design system (`styles.css` tokens +
   `client/src/components/ui/*` — no separate spec doc exists, confirmed with Bede). Verified
   live in a real headless browser (Playwright, installed temporarily since `chromium-cli`
   wasn't available), not just typechecked.
5. **Phase 6 frontend, sub-slice 2**: live editing on top of slice 1 — reorder, remove,
   ad-hoc add, visit-type change, each recalculating that day's running totals/over-budget
   flags in place via the existing API, nothing ever auto-dropped or auto-reshuffled beyond
   what the user touched. Extracted a shared `PlacePicker` component out of `NeedsMapping.jsx`
   rather than duplicating it. Also verified live the same way as slice 1.

Full technical detail for all of the above (the actual design decisions, code shapes, and
what was verified how) lives in `ROUTEPLANNER_PROGRESS.md` — treat that as the primary source,
this is a summary for the day's log.

## 2026-07-15 — Route planner frontend sub-slice 3 (suggestions + commit)

Last slice of the phase 6 frontend build. Added to `PlanVisits.jsx`:
- **Suggestions**: a "Suggest a stop" button on any day that isn't over budget and has free
  minutes, wired to the already-built `GET .../suggestions` endpoint. Shows nearby eligible
  candidates (name/category/city/zone); "Add" reuses the same add-stop endpoint the ad-hoc
  picker uses — a suggestion is just a pre-filtered candidate, not a different kind of add.
- **Commit**: a per-day "Commit day" button (in each day's card header) and a top-level
  "Commit all" button (next to "Plan again"), both behind a confirm dialog (matches
  `Schedule.jsx`'s existing confirm-before-destructive-action pattern). `commitDay`'s response
  isn't a day view — the committed stops just became real `visits` rows and vanished from the
  draft — so this is the one mutation in the screen that triggers a full draft reload rather
  than patching one day's slice. A new blue `.notice-banner` style (alongside the existing red
  `.error-banner`) reports what got committed, and separately calls out any stops skipped for
  a same-day collision with someone else's committed visit (`skippedCollisions`).

**Verified live** (Playwright against the real dev server, Lisa Marks id 5 temp token, per the
usual smoke-test discipline): generated a 5-day draft, opened suggestions on an under-budget
day (5 real nearby candidates returned, correctly zone-filtered to "South Lincoln"), added one
via the suggestion panel (5→6 stops, budget correctly flipped to "20m over" — the never-drop
evaluator working as designed, not a bug), committed that day (6 real `visits` rows created,
notice banner correct), then committed all remaining days (20 more `visits` rows, notice banner
correct). Confirmed directly in the DB: 26 total `visits` rows in the right shape
(`visit_type` resolved, not null), 0 leftover `schedule_draft_stops`. Fully cleaned up after:
deleted all 26 test `visits` rows and the test draft, cleared Lisa's temp `auth_token` back to
null.

**This means old-scheduler retirement is now unblocked** (see Next steps) — sub-slice 3 was
the last thing gating it.

## 2026-07-15 — Old scheduler retired

Removed the old single-day scheduler now that the route planner's "Plan My Visits" workspace
is functionally complete end-to-end. Deleted outright: `server/src/services/scheduler.js`,
`server/src/routes/schedule.js` (the `/api/schedule` prefix, `GET /`/`POST /generate`/`PATCH
/reorder`), `client/src/components/Schedule.jsx`, and the "Today's Route" nav tab. Also
removed everything that only existed to support it: `client/src/api.js`'s `schedule`/
`generateSchedule`/`reorder` methods, `StatusChip` (`ui/Chip.jsx`) and its `.badge.status-*`
CSS (no other consumer left), and dead `.stop.done`/`.stop.skipped`/`.stop-contact`/
`.stop-note-preview`/`.stop-buttons`/`.grid.cols2` CSS rules.

**One deliberate call on Bede's instruction ("remove all of that... very clean"):** the
Dashboard's "Today's Route" card (stat tile + stop list + "Open route" button) also depended
on the old scheduler's `loadRoute()` query. Rather than keep a slimmed read-only version of
it, the whole card was removed — Dashboard now shows 2 stat tiles (was 3) and the "Completed
this week" card as a standalone full-width card instead of a two-column layout paired with
the removed route card.

Went through every file the old scheduler touched and updated stale comments referencing it
(`scheduleDraft.js`, `scheduleDrafts.js`, `visits.js`, `places.js`, `people.js`,
`PlanVisits.jsx`, `PersonDetail.jsx`, `PlaceDetail.jsx`, `VisitLogModal.jsx`) rather than
leaving dangling references to a deleted file. Also caught the API docs table in `README.md`,
which still listed the deleted `/api/schedule*` endpoints and had never been updated with the
route planner's actual `/api/schedule-drafts/*`/`/api/geocode` endpoints — added those, plus
rewrote the stale "Daily schedule generator" and "Dashboard — today's route" feature bullets.

**Verified**: 139 backend tests still pass, client build succeeds (59 modules, down from 60),
and a live Playwright pass (Lisa Marks id 5 temp token, cleaned up after) confirmed the nav
bar now shows exactly 5 tabs with no "Today's Route", the Dashboard renders cleanly with no
empty gap where the removed card was, `Plan My Visits` still works, `GET /api/schedule` now
404s, and `GET /api/dashboard` no longer returns a `today` key — with zero console/page errors
throughout.

**Not yet committed** — per house rule, only when Bede asks.

## Current state
- Working on branch `bede-routeplanner` — ahead of `origin/bede-routeplanner`, not merged
  into `main`, not pushed. Push/PR only when Bede asks.
- Route planner: phases 1-6 (scoring engine, drive-time, visit types, multi-day generator,
  real routing API + optimization, draft/commit lifecycle) are all built, tested, and
  committed on the backend/API side. **All three frontend sub-slices are built and verified
  live**: 1 (generate + read-only view), 2 (live editing), 3 (suggestions + commit). The
  "Plan My Visits" workspace is functionally complete end-to-end and is now the **only**
  route-planning surface in the app — **the old single-day scheduler is fully removed**
  (`services/scheduler.js`/`routes/schedule.js`/`Schedule.jsx`/"Today's Route" tab all
  deleted, along with the Dashboard's old route card).
- **The two 2026-07-10 data-integrity bugs are fixed** (`dc5d940`, same day) — don't warn
  about them as open issues anymore.
- **`places.category` is now a locked enum**, not free text (`c408809`) — see
  `server/src/config/categories.js`.
- One known gap still open from the 2026-07-10 audit, not yet fixed: places created via the
  Needs Mapping "create place" flow (`routes/notesReview.js`) still skip geocoding — a second,
  hand-rolled insert path that duplicates `POST /api/places` but never calls
  `geocodeAddress(...)`.
- Local dev only — nothing deployed. `./dev.sh` runs both servers
  (backend :4000, frontend :5173).
- Database: 261 real places, a handful of real visits/referrals logged since
  the clean-slate wipe, plus Bede's own manually-created test data (place
  "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar Jr. —
  don't delete these, they're fixtures he made on purpose). Only Bede's account
  has a real password set; Nikki/Lisa/Basil still need to log in once to create
  theirs.
- **Geocoding backfill has been run** — 255/262 places have coordinates, 7 need
  manual address review (still open, see below).
- See `HANDOFF.md` §13 for the authoritative, more detailed current-state
  snapshot — this section is a summary, that one's the source of truth.

## Next steps / ideas not yet done
- **Manually review the 7 places with unmatched addresses** before any
  routing logic assumes every place has coordinates.
- **Fix the Needs Mapping geocoding gap** — places created via
  `routes/notesReview.js`'s create-place flow still skip `geocodeAddress()`.
- Referral metrics still aren't shown on Today's Route's stop cards — only
  the People tab, Places tab, both detail pages, and the Dashboard. Consider
  whether this is even still worth doing once the new workspace replaces
  Today's Route, vs. building it there instead.
- Feeding referral metrics back into place priority scoring is still an open
  idea, now with an objective signal to use.
- `NEGLECT_MULTIPLIER`/`CADENCE_DAYS` (route-planner scoring config) are meant
  to become user-editable settings eventually, not stay hardcoded.
- Populating `places.phone` (not in the original Excel import) so the Call
  button on Place Detail always shows up (currently only for places someone's
  added a phone number to by hand).
- Re-running `npm run import:notes` when ready to bring back the 2 years of
  historical referrer notes.
- Still true from the original handoff: consider Postgres backups and a
  Railway spend cap whenever this gets redeployed.
