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

## 2026-07-14

Small polish session on the header and the AssignPersonModal person-picker, plus one
open product question surfaced (not acted on yet). Two commits, both on branch `basil`.

### 1. Header cleanup
- Removed the "Change password" button/trigger from the header (`App.jsx`) — the
  `ChangePassword` modal component and its `showChangePassword` state are still wired up
  and rendered, there's just no button left to open it. **It needs a new home somewhere
  else in the UI** — until then, nobody can change their password from the app.
- Flattened Date / Signed in as / Log out from a two-line (label-over-value) layout onto
  one line (`.user-menu` is no longer `flex-direction: column`).
- "Date" and "Signed in as" labels now use the existing `.muted` grey utility class
  (previously same color/weight as the value next to them). Log out button moved off
  `size="small"` to the default button size, per request ("a little bigger").
- Commit: `1dd7ec0` — "Simplify header: drop Change password button, one-line layout".

### 2. AssignPersonModal: checkboxes → click-to-highlight
- Replaced the per-row checkbox in the "Assign people" modal's person list with
  click-anywhere-on-the-row selection: clicking toggles a persistent highlight
  (new `.hover-row.selected` CSS rule, `var(--blue-tint-2)`) instead of checking a box.
  Underlying logic unchanged — still the same `Set` of selected ids and "Assign N people"
  button as before.
- Along the way, fixed a layout bug the refactor itself introduced: making the `<li>` a
  flex-column (`.stack`) broke the person's name and title (previously inline, e.g. "Angela
  Reyes · Activities Director") onto separate lines, since each direct child of a `.stack`
  becomes its own row. Fixed by nesting name+title back into their own inline `<div>`,
  matching the row pattern already used in PersonDetail/PlaceDetail. Verified by rendering
  the real component markup against the app's actual stylesheet in a throwaway Playwright
  screenshot (not committed, scratch-only) before and after the fix.
- Commit: `b755edf` — "Replace AssignPersonModal checkboxes with click-to-highlight rows".

### 3. Open question, not acted on: multi-tenant / sell-to-other-companies
Came up discussing the login page: this app may eventually be sold to other companies, not
just used internally by Guardian Angels. Flagged (but did not change) that the current login
flow — a dropdown listing every employee's name, then a password — won't scale to that: it
publicly exposes one company's full staff roster, and there's no company/tenant concept
anywhere in the auth model (`server/src/routes/auth.js` is a flat user list scoped to one
org). **No code was written for this** — it's an open design question to revisit before
investing further in login/auth polish, not a confirmed roadmap item.
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

**Committed** same session as `6213fcc` alongside sub-slice 3, per Bede's explicit ask.

## 2026-07-15 — Route planner UX feedback pass (Re-optimize, Discard plan, time display)

Once the workspace was feature-complete and retired the old scheduler, Bede started actually
using it live and walked through the UI asking questions and requesting changes in real time.
Three real features came out of that, all `PlanVisits.jsx` + supporting backend — full
technical detail in `ROUTEPLANNER_PROGRESS.md`'s same-titled section, this is the summary:

1. **"Re-optimize" per day** — new `POST /api/schedule-drafts/:id/days/:date/reoptimize`,
   the first live-edit mutation allowed to resequence a day's stops (every other edit
   deliberately preserves order). Button visibility/enabled state went through two rounds of
   Bede's own live correction: first "only show once edited, hide after clicking," then
   corrected to "stay visible but disabled after clicking, only re-enable on the next edit."
   Visit-type changes deliberately don't trigger it (they can't affect drive order); add/
   remove/reorder do.
2. **"Discard plan"** — new `DELETE /api/schedule-drafts/:id`, ownership-checked, discards
   the whole multi-day proposal at once (not just one day), cascades cleanly through the
   existing FK. Distinct from "Plan again" (discard + immediately regenerate in one click) —
   this just goes back to empty.
3. **Per-stop time + day-total prominence** — each stop now shows its own time contribution
   (drive+visit+prep+data-entry, with a hover tooltip breaking it down) instead of a running
   cumulative total; the day's total moved into a new large, bold `.progress-total` line
   above the progress bar instead of buried in the small caption.

All three verified live via Playwright (Lisa Marks id 5, cleaned up after each run), including
walking the Re-optimize button through all 6 expected visibility/enabled state transitions.
139 backend tests pass, client build stays clean throughout.

## 2026-07-15 (continued) — manual address entry + a "Committed" day view

Two more live-feedback rounds the same day. (1) The start-location picker's manual address
form used to only appear as a fallback after geolocation failed — Bede wanted it available
proactively, so an "Enter address manually" button now sits next to "Use my current location"
and opens the same form immediately either way. (2) A committed day used to just look empty —
no sign anything happened. `loadDraftView`/`loadDraftDayView` now also return each day's real
committed `visits` rows, and the UI shows a "✓ N committed" badge plus a read-only list of
those stops; a day with leftover draft stops alongside committed ones (a partial commit) shows
both, labeled separately.

Verified live — and the committed-view test incidentally caught a real cross-user collision
against Bede's own already-committed schedule (confirmed his data was untouched): 4 of 5
stops committed, 1 correctly skipped and reported, exactly as designed. 139 tests pass, build
clean. **Committed, pushed, and opened as a PR against `main`** this session, per Bede's ask —
see GitHub for the PR.

## 2026-07-15 — Code-quality bug hunt (regular pass + "ultra" 6-agent deep pass)

A different kind of session than the entries above — not route-planner feature work, a
dedicated bug-hunting/code-quality pass at Bede's request, on branch `bede-working`, run in
two rounds.

### Round 1 — full-app review (client + server, "regular" depth)
Bede asked for a full review, "every bug or issue or dead code." Found and fixed:
- **CRITICAL:** `server/src/routes/dashboard.js`'s "never visited" query had the exact same
  `.whereNotIn()`-against-nullable-column bug class the 2026-07-14 audit already found and
  fixed once in the old (now-deleted) scheduler — a detached completed visit's NULL `place_id`
  poisoned the `NOT IN` subquery, silently zeroing the whole "Never Visited" dashboard widget
  the first time any place with completed-visit history was ever deleted. Fixed with
  `.whereNotNull('place_id')`.
- `PlanVisits.jsx`/`Calendar.jsx` (the calendar-date-picker feature, mid-flight and uncommitted
  going into this session): `MAX_PLAN_DATES` had been mistakenly set to 7 instead of mirroring
  the server's real 10, combined with a same-session change making "today" itself selectable —
  together could block a rep from picking a fully legitimate 8th weekday. Fixed by restoring
  `MAX_PLAN_DATES = 10` and rewording the UI hint to reference `MAX_DAYS_AHEAD` instead.
- `notesReview.js`'s `POST /:id/create-place` skipped the `places.category` enum validation
  entirely — a second, worse gap on top of the already-known geocoding gap on that same path
  (§14A). Added the same `categoryError()` check `places.js` uses.
- `client/src/components/ui/PlacePicker.jsx` was missing the stale-response-guard +
  error-handling convention every other debounced search already has — brought into line.
- `NeedsMapping.jsx`'s `CreatePlaceModal.save()` had zero error handling (silent failure on
  network error) — added try/catch + error banner.
- `PlanVisits.jsx`'s `deleteCommittedDay` didn't reload the draft, leaving a
  partially-committed day's card stale — added a `load()` call.
- The "No visits planned yet" empty state had silently disappeared in a refactor — restored,
  reworded per Bede's request to drop "Let's map out your days" (too cutesy) — now just
  "No visits planned yet."
- `scheduleDraft.js`'s `deleteCommittedDay` had zero test coverage — added 3 tests.
- `visits.js` didn't validate `user_id`/`person_id` existence before insert/update — added
  400-level checks.
- Two dead-code cleanups: `VisitLogModal.jsx`'s unreachable `visit?.name` fallback removed;
  `phone.js`'s unused `PHONE_REGEX` export removed (kept internally).
- Deferred, not urgent: `visit_type` not patchable post-commit via `PATCH /api/visits/:id`;
  several route-planner scheduling fields on `places` (capacity_level, relationship_level,
  do_not_visit, snooze_until, default_visit_type, etc.) have no API route to set/update yet —
  only ever populated by a one-time migration backfill.

### Round 2 — "ultra" 6-agent deep review
Bede asked for a much deeper pass, explicitly "ultra" depth — 6 parallel review agents, each
assigned a narrow slice (route-planner core engine, route-planner API+frontend, core CRUD
routes, core CRUD frontend, data-model/migration consistency, a dedicated security pass).
~25 issues found; Bede picked 7 to fix immediately (rest deferred, see below):

1. **Most serious — a real TOCTOU race in `commitDay` let two reps double-book the same
   place/date.** No unique constraint existed on `visits(place_id, scheduled_date)`, so under
   Postgres's READ COMMITTED isolation two concurrent commits could both pass the pre-check and
   both insert. Fixed with a new migration,
   `server/src/migrations/20260715000002_add_visits_place_date_unique_index.js`, adding a
   **partial** unique index — `visits_place_date_active_unique` on `(place_id, scheduled_date)
   WHERE status != 'skipped' AND source = 'planner'` — deliberately scoped to
   `source = 'planner'`, not a blanket place+date rule: real dev data (place 264 "Guardian
   Angels (Test)," two manual same-day visits to different contacts — Lionel Messi and "New
   Guy") proved ad-hoc "Log a visit" legitimately allows multiple visits to the same place on
   the same day, and a blanket constraint would've broken that unrelated, working capability.
   `commitDay` now tags its own inserts `source: 'planner'` (previously silently inherited the
   DB's plain `'manual'` default) and inserts one row at a time inside its transaction,
   catching a unique-violation per row into the existing `skippedCollisions` mechanism instead
   of crashing with a raw 500.
2. Non-numeric IDs (`:id` route params, and body FKs like `place_id`/`user_id`/`person_id`)
   crashed with a raw 500 on Postgres but looked fine in local SQLite dev testing (SQLite's
   storage-class comparison silently no-matches a string against an int column → a clean,
   already-passing 404; Postgres infers an integer type from context and throws `invalid input
   syntax for integer`, uncaught, surfaced as a 500). Added `Number()` coercion + NaN guards
   across `places.js`, `people.js`, `visits.js`, `referrals.js`, `notesReview.js`, reusing each
   route's existing error message/status — `scheduleDrafts.js` already did this correctly
   everywhere and was the reference pattern. Worth remembering: this bug class is invisible in
   local SQLite dev testing — needs Postgres, or at least suspicion of any un-coerced
   `req.params.id`.
3. Any rep could edit/skip/delete another rep's visits — no ownership check on `visits.js`'s
   `PATCH /:id`, `POST /:id/skip`, `DELETE /:id`. Per Bede's explicit framing ("only be able to
   edit routes planned on their own account"), added
   `if (visit.user_id != null && visit.user_id !== req.user.id) return 403` to all three —
   deliberately `!= null` so an unassigned visit stays editable by anyone, only a visit with a
   *different specific* owner gets blocked; `user_id` stays reassignable by the current owner
   (a "hand this off to Nikki" flow was preserved, not removed).
4. `dashboard.js` had the SAME bug class as round 1's critical fix, twice more — but via wrong
   JOIN type (INNER instead of LEFT): "completed this week" and "needs attention / cooling
   people" both inner-joined against `places`, silently dropping data the moment a place
   involved got deleted. Fixed both to LEFT JOIN, with `COALESCE(v.place_name, p.name)` for the
   visit-history query (matching `visits.js`'s `fetchVisit()` precedent for surviving a deleted
   place via its snapshot column). A third similar-looking query ("overdue places," also an
   inner join) was deliberately left alone after reasoning through it — a deleted place has
   nothing left to revisit, so excluding it there is actually correct. **This bug class
   (`whereNotIn`/inner-join against a nullable FK, breaking detach-not-delete) has now shown up
   3 times across 2 files** (the old, now-deleted scheduler, and `dashboard.js` twice) — worth
   a dedicated grep sweep in any future full-codebase audit.
5. An ungeocoded place could be added to a draft, silently vanish from the review UI (the
   drive-time fallback path filters ungeocoded stops out of what it shows), yet still get
   committed to a real visit the rep never actually saw reviewed. Fixed in two places: `addStop`
   now rejects (400) adding an ungeocoded place at all; `commitDay` also filters ungeocoded
   stops out of what it commits (defense-in-depth for a place whose address gets edited and
   re-geocoding fails after it's already sitting in an active draft), folding them into the same
   `skippedCollisions` reporting.
6. Discarding a day wasn't fully protected: `addStop` never validated a date against the
   draft's own selected dates, and `commitAll` sourced its commit list from raw
   `schedule_draft_stops` rather than the draft's own `params.days`, so a stray/duplicate add
   targeting an already-discarded date could get silently resurrected on the next "Accept all."
   Fixed: `addStop` now 400s if the date isn't one of the draft's own `params.days`; `commitAll`
   now checks draft ownership upfront (a bonus fix — it previously skipped the ownership check
   whenever the target draft had zero stops) and only commits dates still present in
   `params.days`.
7. Client "today" (browser local time) and server "today" (previously raw UTC, via
   `scheduleDraft.js`'s `todayUTC()`) could disagree by a full calendar day for several hours
   every evening in any US timezone behind UTC — spuriously rejecting an evening "plan for
   today" as "in the past" with no way for the rep to have known. Since this app is for one
   single-office team (Lincoln, NE), fixed by anchoring the server's "today" to a fixed
   `America/Chicago` timezone via `Intl.DateTimeFormat`/`formatToParts` (renamed the function
   `todayUTC()` → `orgToday()` to be honest about what it now does), rather than trusting a
   client-supplied date. No client-side change was needed — the client never sent its own
   `today` value to the server.

**Deferred, not fixed this session** (Bede: "hold on the others for another prompt") — roughly
18 more findings from the ultra pass, not acted on, including: transactions held open across
live OSRM network calls in most draft mutations (a real connection-pool-exhaustion risk as
usage grows); `PersonModal.jsx`/`PlaceModal.jsx` Save can get permanently stuck on a network
failure during their duplicate-check pre-step; missing confirm dialog on "Create another
proposal" (silently deletes+regenerates the whole draft); partial-commit day's budget math
ignoring time already spent on stops committed in an earlier partial commit; Dashboard's
embedded place-delete not refreshing the Dashboard's own cached lists; `PersonDetail.jsx`'s
`exitFieldEdits()` not closing the "assign to a place" picker; `visits.js` `POST /` not
validating `status` against its enum (only `PATCH` does); a pre-auth account-takeover window in
`auth.js` (`GET /users`/`POST /set-password` aren't behind `requireAuth`). Full list isn't
duplicated here — this was intentionally not an exhaustive fix-everything pass, don't assume
otherwise.

**Verification:** 146 backend tests pass (up from 143 at the start of the session), client
build clean throughout both rounds, the new migration applied cleanly against the dev DB.
**Committed, pushed, and merged into `main`** at the end of this session, per Bede's explicit
request — done as a direct git merge rather than a GitHub PR, since the `gh` CLI wasn't
available in this environment.

## Current state
- Working on branch `bede-routeplanner`, pushed and merged into `main` via PR as of
  2026-07-15 (Bede explicitly asked for this so his coworkers could access the code) — check
  `git log main` / GitHub for the exact merge commit rather than trusting a hardcoded hash
  here. Keep working on `bede-routeplanner` for anything further unless told otherwise; always
  check `git status` before starting new work and only push/merge again when asked.
- **Later the same day, a separate code-quality session ran on branch `bede-working`** (not a
  route-planner feature session — see the "Code-quality bug hunt" entry above): a regular
  full-app review pass plus an "ultra" 6-agent deep-review pass, together fixing a real
  double-booking race condition in `commitDay` (new partial-unique-index migration), missing
  cross-user ownership checks on `visits.js`, a Postgres-only crash on non-numeric IDs (invisible
  under local SQLite testing), two more instances of the `whereNotIn`/inner-join-against-
  nullable-FK bug class in `dashboard.js` (the same class fixed once already in the
  now-deleted old scheduler — this makes 3 occurrences across 2 files total, worth a dedicated
  grep sweep next time), a client/server "today" timezone mismatch, and several smaller gaps
  (dead code, missing validation, missing error handling). Roughly 18 further findings from the
  ultra pass were intentionally deferred at Bede's request, not fixed — this was not a
  fix-everything pass. 146 backend tests pass, client build clean. **Committed, pushed, and
  merged into `main`** at the end of that session (direct git merge, not a GitHub PR — `gh`
  wasn't available in this environment).
- Route planner: phases 1-6 (scoring engine, drive-time, visit types, multi-day generator,
  real routing API + optimization, draft/commit lifecycle) are all built, tested, and
  committed on the backend/API side. **All three frontend sub-slices are built and verified
  live**: 1 (generate + read-only view), 2 (live editing), 3 (suggestions + commit). The
  "Plan My Visits" workspace is functionally complete end-to-end and is now the **only**
  route-planning surface in the app — **the old single-day scheduler is fully removed**
  (`services/scheduler.js`/`routes/schedule.js`/`Schedule.jsx`/"Today's Route" tab all
  deleted, along with the Dashboard's old route card).
- **Bede is now live-testing the workspace and requesting real UX refinements as he goes**
  (Re-optimize per day, Discard plan, clearer time display — see the 2026-07-15 "UX feedback
  pass" entry above). Expect this pattern to continue in future sessions: small, targeted
  live-feedback requests rather than a fixed backlog.
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
  don't delete these, they're fixtures he made on purpose). All four users now
  have a password set — as of 2026-07-22, anyone who didn't already have one
  was backfilled to a default (`Angels#1`, see that session's entry below);
  this line was already stale before that (Lisa's had a real password since
  2026-07-14) — a reminder to update this section instead of trusting it blindly.
- **Geocoding backfill has been run** — 255/262 places have coordinates, 7 need
  manual address review (still open, see below).
- See `HANDOFF.md` §13 for the authoritative, more detailed current-state
  snapshot — this section is a summary, that one's the source of truth.
- **2026-07-14's header/AssignPersonModal work (above) is committed** on branch `basil`
  (`1dd7ec0`, `b755edf`) but **not yet pushed** — `basil` is currently 2 commits ahead of
  its remote counterpart `origin/basil-working` beyond what was already unpushed before
  today. Working tree is otherwise clean.
- **"Change password" is currently unreachable in the UI** — the button was removed from
  the header today and hasn't been given a new home yet. The modal/logic itself still
  works fine if wired to a new trigger.

## Next steps / ideas not yet done
- **Give "Change password" a new home in the UI** — removed from the header 2026-07-14,
  not yet placed anywhere else.
- **Decide on multi-tenancy before more login/auth work** — see the 2026-07-14 entry
  above. Open question, nothing built.
- **Fix the two known bugs in `HANDOFF.md` §14A first** — before building the
  route planner or anything else that leans on visits/referrals data.
- **Manually review the 7 places with unmatched addresses** (see above) before
  any routing logic assumes every place has coordinates.
- **Build the route planner** — see `HANDOFF.md` §14B for what's ready vs.
  missing and a suggested build order (short version: no distance/duration math
  or mapping library exists yet, and there's no visit-duration/time-window/
  driver-start-location data in the schema).
- Referral metrics still aren't shown on Today's Route's stop cards — only
- **Manually review the 7 places with unmatched addresses** before any
  routing logic assumes every place has coordinates.
- **Fix the Needs Mapping geocoding gap** — places created via
  `routes/notesReview.js`'s create-place flow still skip `geocodeAddress()`.
- Referral metrics still aren't shown on Plan My Visits' stop cards — only
  the People tab, Places tab, both detail pages, and the Dashboard.
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

## 2026-07-22 — Reopen-a-committed-day feature + ultra-review backlog cleanup

Branch `bede-working`. Two threads: a "Plan My Visits" feature Bede had already started before
this session (reopening an already-committed day back into an editable draft), and working
through part of the ~18-item backlog deferred from 2026-07-15's ultra review.

**Reopen a committed day** — full writeup in `ROUTEPLANNER_PROGRESS.md`'s new entry. Short
version: a new "Edit" button on a committed day pulls its `visits` rows back into
`schedule_draft_stops` via a new `reopenCommittedDay` service function and
`POST /api/schedule-drafts/days/:date/reopen` route, so a planned day can be reordered/added-
to/removed-from/re-optimized/re-committed exactly like it was never accepted in the first
place. Bundled in: `commitDay` no longer leaves a fully-committed date lingering in the draft's
own `params.days` (the ambiguous "committed AND still an open proposal" state this feature
exists to eliminate); the OSRM-call-held-open-inside-a-transaction anti-pattern in
`reoptimizeDay` is fixed (ownership check + the network call now happen outside any
transaction); `addStop`'s duplicate-add race now returns a clean 409 instead of a raw 500.

**Ultra-review backlog, picked off one at a time as Bede reviewed the list:**
1. `POST /api/visits` now validates `status` against its enum (only `PATCH` did before).
2. `places.js` now validates `tier` is 1/2/3 on both `POST` and `PATCH` (new `tierError()`,
   same shape as the existing `categoryError()`); `PATCH` also now writes the *coerced numeric*
   tier back, not the raw request-body value, so it can never diverge from the `priority_score`
   derived from it.
3. `visits.skip_reason` turned out to be worse than "an orphaned column" — the entire "skip a
   stop" feature it belonged to (`POST /api/visits/:id/skip`, `api.skipVisit()`) had zero
   callers anywhere in the frontend, a leftover from the old `Schedule.jsx` scheduler retired
   2026-07-15 that nobody rebuilt an equivalent for in the new workspace. Dropped the column
   (new migration, no FK/rebuild needed) and deleted the dead route + client fn. `status:
   'skipped'` itself is untouched — still a valid value settable via the regular `PATCH`, and
   still relied on by the partial unique index from 2026-07-15.
4. The pre-auth account-takeover window (`GET /api/auth/users`/`POST /api/auth/set-password`
   aren't behind `requireAuth`, necessarily — there's no session before first login) got a
   stopgap, not a full fix: every currently-passwordless user now has a real default password
   (`Angels#1`, new migration, ran against the dev DB — only Nikki Shasserre was affected there,
   everyone else already had one). This closes the "claim someone else's account before they
   ever log in" window for accounts that exist *today*; a user created in the future still
   starts passwordless and is exposed to the same window until their first login. Bede's still
   designing the real login-page overhaul (a "seamless" single login form, a change-password
   button) — this is explicitly a stopgap ahead of that, not the final answer.
5. `PersonModal.jsx`/`PlaceModal.jsx`'s stuck-Save bug: the duplicate-name/address pre-check
   ran outside any try/catch, so a network failure there left Save disabled forever with no
   error shown. Fixed via a new shared `client/src/hooks/usePreSaveCheck.js` helper (both forms
   now go through it) instead of fixing the same bug twice in parallel, so the two forms'
   error-handling can't drift apart again.
6. `Dashboard.jsx`'s embedded `PlaceDetail` now has `onDeleted={load}` — deleting a place from
   the Dashboard now actually refreshes it, matching Places.jsx/People.jsx.
7. `PersonDetail.jsx`'s `exitFieldEdits()` now also closes the "assign to a place" picker
   (previously only reset notes/preferences/birthday edit state, unlike the backdrop-click
   handler which reset all four).
8. `assignToPlace()` got an in-flight guard (`savingAssign`), matching the save-in-progress
   pattern every other handler in that file already used.
9. `useDuplicateMatches`'s debounce effect now depends on `search`, not just `query`/`enabled`/
   `minLength`. Its one real caller (`NeedsMapping.jsx`'s `CreatePlaceModal`) was passing an
   inline arrow function that got a new identity every render — applying the dependency fix
   as-is would've caused a refetch on every unrelated keystroke in that modal (category/tier/
   city/zip), so that call site got its own `search` callback wrapped in `useCallback` first.

**Deliberately left alone, Bede's call for later:** rebuilding "skip a stop" as a real feature
(declined in favor of cleanup — see #3 above); the two remaining capability-gap items from
2026-07-15 (`visit_type` not patchable after commit; nine scheduling-profile fields on `places`
with no API surface at all) — neither is a bug, both are "build this UI" scope decisions.

**Verification:** 146 backend tests pass throughout (unchanged count — no new tests added this
session), client build clean (62 modules), the two new migrations applied cleanly against the
dev DB. Committed on `bede-working` per Bede's explicit request — not pushed/merged, ask before
doing either.
