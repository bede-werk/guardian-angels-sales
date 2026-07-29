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
   (`App.jsx`'s nav, `routes/notesReview.js`) once that happens. **[Done 2026-07-27 — see that
   date's entry below; the whole feature was removed, not just NeedsMapping.jsx itself.]**
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
- The Needs Mapping "create place" flow (`routes/notesReview.js`) — a second, hand-rolled
  insert path that duplicates `POST /api/places` — used to skip geocoding entirely; **fixed
  2026-07-22**, see that entry below.
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
10. The long-open Needs Mapping geocoding gap: `notesReview.js`'s `POST /:id/create-place` — a
    second, hand-rolled place-insert path — never called `geocodeAddress()`, unlike
    `routes/places.js`'s create route. Now it does, same best-effort/non-blocking contract.
    Also cleaned up two stale comments in `scheduleDraft.js` (`committedVisitsQuery`,
    `removeStop`) that still described the pre-reopen-feature world where a partial commit
    could leave a committed visit and a draft stop coexisting for the same day — no longer
    possible now that `commitDay` always commits/clears a whole day at once (see the reopen-day
    feature above). No behavior change, comments only.

**Deliberately left alone, Bede's call for later:** rebuilding "skip a stop" as a real feature
(declined in favor of cleanup — see #3 above); the two remaining capability-gap items from
2026-07-15 (`visit_type` not patchable after commit; nine scheduling-profile fields on `places`
with no API surface at all) — neither is a bug, both are "build this UI" scope decisions.

**Verification:** 146 backend tests pass throughout (unchanged count — no new tests added this
session), client build clean (62 modules), the two new migrations applied cleanly against the
dev DB. Committed on `bede-working` per Bede's explicit request — **pushed and merged into
`main`** later the same session (2026-07-22), along with every other entry below through the
default-visit-type change, per another explicit request.

## 2026-07-22 (later same day) — Mapbox address autocomplete for the route planner

A UI/UX request, not a bug fix: Bede wanted the route planner's "enter address manually"
start-location form to feel like a Google Maps search — one box, type freely, pick a
suggestion — instead of the existing 4 separate street/city/state/zip fields plus a "Use this
address" button that geocoded them all in one shot via the free Census API.

Researched options first (Google Places, Mapbox Search Box, Radar, Geoapify, Photon/OSM) and
reported back trade-offs — free tier size, account/key friction, React-component readiness.
Went with **Mapbox Search Box** (`@mapbox/search-js-react`'s `SearchBox` component): its
official React component is purpose-built for exactly this one-box-live-suggestions flow, and
its free tier (100k requests/month) needs no credit card to start.

**Built:** `client/src/components/ui/AddressAutocomplete.jsx` wraps `<SearchBox>`, themed via
Mapbox's Theme API to match this app's existing inputs/dropdowns (colors/border-radius/shadow
values copied from `styles.css`'s design tokens — the component is a custom element under the
hood and can't read the app's own CSS classes directly), with `proximity` biased toward
Lincoln, NE so results favor the area without excluding matches elsewhere (a rep occasionally
starts from home, out of town, etc.). `onRetrieve` maps Mapbox's response to the same
`{ lat, lng, label }` shape `PlanVisits.jsx` already used from browser geolocation, so the
calling code didn't need to change at all past the swap itself.

**Wired into `PlanVisits.jsx`:** replaced the whole 4-field form + "Use this address" button
with one `<AddressAutocomplete>` — selecting a suggestion *is* the confirmation now, no
separate lookup step. Removed the state/handler that only existed for the old form
(`manualAddress`, `geocoding`, `lookUpManualAddress`).

**Cleanup this made possible:** the old single-shot `POST /api/geocode` route
(`server/src/routes/geocode.js`) and `api.geocode()` client fn had no other caller anywhere in
the app — both deleted. Doesn't touch place-address geocoding (`services/geocoding.js`, §9A in
`HANDOFF.md`) at all — that's a different use case (resolve one complete address server-side
via the free Census API when a place is created/edited) and still works exactly as before.

**Setup:** needs a free Mapbox access token in `client/.env` (`VITE_MAPBOX_TOKEN` — see the new
`client/.env.example`). Bede signed up and provided one this session. The component shows a
small inline notice instead of erroring if the token's ever missing.

**Verified live:** typed a real Lincoln address, got live suggestions styled to match the rest
of the app, selected one, and the start-location display updated correctly ("Starting from
8300 West O Street, Lincoln, Nebraska 68528, United States" + Change link) — via a temporary
Lisa Marks (id 5) smoke-test token, cleared afterward. No console errors. 146 backend tests
pass (unchanged — no backend logic touched besides deleting the dead route), client build
clean.

## 2026-07-22 (later still) — Plan My Visits: duration picker, click-to-view place detail, default visit type

Four more small, targeted UX requests from Bede on the same "Plan My Visits" surface, same
session/branch (`bede-working`).

**Hours + minutes duration picker.** The per-date daily-budget control was a single `<select>`
in whole-hour steps (2/3/4/5/6 hrs). Bede wanted minute-level granularity. Turned out to need
zero backend changes — `hoursPerDay` was already a decimal on the wire (`scheduleDraft.js`'s
`budgetMinutes = hoursPerDay * 60`, validated only as `> 0`, no integer requirement), so a value
like 4.5 was already fully supported end to end; only the UI was artificially limited to whole
hours. Replaced the single select with two (`HOUR_OPTIONS` 1-9, `MINUTE_OPTIONS` 0/15/30/45,
`PlanVisits.jsx`), grouped inside one bordered `.duration-picker` pill (`styles.css`) so it
still reads as one "duration" control rather than two disconnected dropdowns.
`splitHoursPerDay()` converts the stored decimal to whole `{hours, minutes}` for display;
`HOUR_OPTIONS` deliberately starts at 1 (never 0) so the two selects can never combine to a
0-value that would trip the server's `hoursPerDay > 0` check. Verified live end-to-end,
including generating a real draft with a 4.5-hour budget and confirming the request body
(`hoursPerDay: 4.5`) and the resulting draft's `~4h 22m of 4h 30m` display both came out right.

**Click a proposed stop to open its full place detail.** Bede wanted to see a place's full
context (notes, capacity, people, referral metrics, visit history) before deciding what visit
type a proposed stop should get, without leaving the planner. Reused `PlaceDetail.jsx` as-is —
already a self-contained "slide-in modal" component (`placeId`/`userId`/`onClose`/`onChanged`/
`onDeleted` props) shared by Places.jsx/People.jsx/Dashboard.jsx — rather than building anything
new. `PlanVisits.jsx` didn't receive a `userId` prop before now (schedule-draft endpoints infer
the user from the auth token server-side, so it never needed one); added it, threaded from
`App.jsx` the same way Places/People/Dashboard already get it, since `PlaceDetail` needs it for
its own nested "Log a visit"/`PersonDetail` actions. The click target is just the stop's `.main`
block (name/meta/tags), not the whole `<li>` — that row already has drag-and-drop plus several
of its own interactive controls (reorder buttons, the visit-type select, a remove button) as
flex siblings/children, and wrapping the entire row would have meant adding
`stopPropagation()` to every one of them. Only the visit-type `<select>` needed one (it's nested
inside `.main`). Deleting a place from inside this embedded modal is safe without any backend
change: `schedule_draft_stops.place_id` is `ON DELETE CASCADE`, so the stop's row just vanishes
server-side and `reload()` (passed through as `onChanged`/`onDeleted`) picks that up on the next
fetch — same outcome as removing the stop directly.

**Hover-highlight cosmetic fixes, two rounds.** First: the row's hover highlight only painted
`.main`'s own box (the middle slice of the row), not the full row width, since `.reorder`/
`.order`/`.actions` are `.main`'s flex siblings, not descendants — looked like a narrow,
off-center highlight rather than "this whole row opens the place." Fixed with `:has()`
(`.stop:has(.main.hover-row:hover) { background: var(--blue-tint-1); }` — the existing
`.hover-row` shared class, reused as-is, doesn't have this problem anywhere else it's used,
since in every other spot the hover-row div already *is* the full clickable row) so the
full-width `.stop` `<li>` repaints off its `.main` child's hover state, plus a matching
cancel-both-layers rule (`:has(...):has(select:hover)`) so hovering the visit-type select
nested inside `.main`, or the reorder/remove buttons (`.main`'s siblings, never triggering
`.main:hover` at all), shows no row-wide highlight — only each control's own hover style.
Second round, reported as "that animation looking thing": the pre-existing `.hover-row`
class's `transition: background 0.1s ease` only animated `.main`'s own background, not the new
`.stop`-level one painted alongside it, so the two layers visibly fell out of sync (one fading,
one snapping) instead of reading as one highlight. Scoped `transition: none` to `.stop .main
.hover-row` specifically (not the shared `.hover-row` class itself, which still fades normally
everywhere else it's used — click-to-edit notes, PersonDetail's place row, PlaceDetail's people
roster) per Bede's preference for instant on/off over a matched fade.

**Default visit type changed to Drop-in.** `server/src/config/visitTypes.js`'s
`DEFAULT_VISIT_TYPE` was `working_visit` (30 min); changed to `drop_in` (7 min). Flagged to
Bede as a bigger change than it might sound: every one of the 262 real places in the dev DB
currently has `default_visit_type: NULL`, so *all of them* were resting on this fallback — it's
not just what a dropdown shows pre-selected, it's the actual duration the route planner budgets
per stop when packing a day (confirmed live: the same 4-hour test budget went from packing 6
stops to 12). Two `scheduleGenerator.test.js` tests broke as a direct result — both were using a
deliberately tight 1-hour budget to test "a candidate excluded by budget on day 1 rolls over to
day 2," calibrated against the old 30-minute default, so a 7-minute default no longer excluded
the second candidate. Fixed by pinning those two tests' specific place fixtures to
`default_visit_type: 'working_visit'` explicitly, rather than just updating the expected
numbers — keeps the tests' actual intent (tight-budget exclusion/rollover) correct regardless
of whatever the global default gets set to next.

**Verification:** 146 backend tests pass (2 fixed, not just re-passing by coincidence), client
build clean throughout all four changes. Committed (`e958d83`), then **pushed and merged into
`main`** the same session (fast-forward, direct `git merge` — `gh` still unavailable in this
environment), per Bede's explicit request.

## 2026-07-22 (evening) — Geocoding review, filter-dropdown staleness, and a real Plan My
## Visits button-layout bug

Branch `bede-working`. Picked off two items from HANDOFF §14's backlog, then a run of live
UX feedback on Plan My Visits' "+ Add a stop"/"Suggest a stop" controls that turned up an
actual layout bug along the way — not just polish.

**Manually reviewed the 7 places that never geocoded (§9A/§14).** Queried `places` for
`lat IS NULL`. 5 are genuinely non-geocodable and always will be: 2 are PO Boxes (Health at
Home Consultants, Lincoln Right to Life), 3 are "(Online)" referral sources with no physical
address at all (A Place for Mom, Chefs For Seniors, Stephanie Oelke) — nothing to fix, and
`addStop` already refuses to route them with a clear error rather than failing silently. The
other 2 (Nebraska DHHS Administrative Offices — "301 Centennial Mall S, Floor 3"; Southwood
Lutheran Church — "4301 Wilderness Hills Blvd") have real street addresses that the free
Census geocoder just doesn't have indexed — confirmed by hitting the Census API directly with
several address-format variants (stripping "Floor 3", trying "Boulevard" vs "Blvd," etc.), all
returning zero matches. Cross-checked both against OpenStreetMap's Nominatim geocoder, which
resolved them exactly (matched by name — "Nebraska State Office Building" at the DHHS address,
"Southwood Lutheran Church" at the other), and hand-set their `lat`/`lng` directly in the dev
DB. **Known fragility, not fixed:** `places.js` has no manual lat/lng override — `lat`/`lng`
are only ever set by re-running `geocodeAddress()` against the address fields, and `PATCH`
re-attempts geocoding any time address/city/state/zip is present in the request body (which
`PlaceModal.jsx` always sends, even unchanged). If either of these 2 places is edited again,
Census will fail again, the existing "address not recognized — save anyway?" dialog will pop,
and clicking through it nulls the coordinates back out. Real fix would mean adding a second
geocoding provider or a manual override field — a design decision, not done here.

**Filter dropdowns went stale within a session (Places.jsx/People.jsx).** Both fetched their
reference data (Places: category/tier/region options; People: category options + the full
places list backing the Place filter and Add Person picker) once on mount only. Editing a
place's city/region, or creating/renaming a place, while staying on the same tab wouldn't
show up in the dropdown until the tab unmounted and remounted (e.g. navigating away and back).
Fixed by extracting the reference-data fetch into its own `loadFilters`/`loadReferenceData`
callback and wiring a combined `refresh` (row list + reference data) into every place/person
create/edit/delete callback that used to just call `load`.

**Bug: "+ Add a stop" let you pick a place already in the draft, only to 409 on submit.**
`ui/PlacePicker.jsx`'s search had zero exclusion — it searched every place, while the
"Suggest a stop" panel already correctly excluded in-draft places server-side. Added an
`excludeIds` prop to `PlacePicker` (filters results client-side before capping to 8); wired
`PlanVisits.jsx` to compute a `draftPlaceIds` set across **every day in the active draft, not
just the one being edited** — matching `scheduleDraft.js`'s `addStop`, which rejects a place
already used anywhere in the user's own draft regardless of which day you try to add it to.

**Add/Suggest button mutual exclusivity, then a real bug in how "Suggest a stop" hid itself.**
Live feedback, iterative: first, made "+ Add a stop" clicked → hides both buttons, shows the
picker + Cancel (Bede confirmed he liked this). Then the mirror case: "Suggest a stop" clicked
→ hides "+ Add a stop", shows only "Hide suggestions" alone in the row. Then Bede hit a case
where "Suggest a stop" disappeared entirely after adding a stop — turned out `canSuggest`
(`!day.overBudget && day.remainingMinutes > 0`) was wrapped around the whole button
(`{canSuggest && <Button>...}`), so filling a day's remaining budget via "+ Add a stop"
silently removed "Suggest a stop" from the DOM instead of just disabling it. Changed to always
render the button, `disabled={busy || !canSuggest}` with an explanatory title tooltip.

**A real layout bug, found by actually rendering the page, not just reading the CSS.** Set up
a throwaway Playwright session (`playwright-core` pointed at the system-installed Chrome, no
fresh Chromium download needed — `chromium-cli` isn't available in this environment) against
the local dev server, logged in as Lisa Marks (id 5, temp token, per the smoke-test
convention) with a real generated draft. Measured actual rendered widths: "+ Add a stop" and
"Suggest a stop" were **509px wide** — vs. 108px for "Discard proposal," a correctly-sized
button right above them. Root cause: both are direct children of a `.row` flex container,
which defaults every child to `flex: 1; min-width: 120px` (see `styles.css`) — every *other*
button in this file (Discard/Accept/Re-optimize) explicitly opts out with
`style={{ flex: 'none', minWidth: 0 }}`, but these two, plus the "Cancel" button next to the
add-stop picker and each suggestion row's "Add" button, never did, so they silently inherited
the stretch. Fixed by adding the same override to all four. Re-measured after the fix:
"+ Add a stop" 509px → 86px, "Suggest a stop" 509px → 98px. Confirmed via before/after
screenshots. Cleaned up the throwaway draft and cleared Lisa's temp token afterward.

**Over-budget pill moved next to the date/region, not in the button row** (Bede's ask) — and
while nested inside the `<h2>`, it silently inherited the heading's serif font
(`h1, h2, h3 { font-family: var(--font-serif); }`) instead of the sans font every other
`.badge` uses, since `.badge` itself never set `font-family`. Fixed on `.badge` directly (not
a one-off inline style on this instance) so it's correct regardless of where a badge ends up
nested in the future.

**Right-alignment** (Bede's ask, applied after the sizing fix made it meaningful):
`justifyContent: 'flex-end'` on the default add/suggest row and the suggestions-open row —
"Hide suggestions" also got the same `flex: none, minWidth: 0` treatment so it's small and
right-aligned instead of stretching full-width (superseding the full-width look from the
mutual-exclusivity change earlier the same session, which Bede explicitly liked at the time
but changed his mind on once he saw the compact-button alternative).

**Verification:** 146 backend tests pass (no backend changes this session), client build
clean throughout. Restarted the dev servers (`./dev.sh`) after the Playwright pass, since
stopping them to clean up the test session took the live site down mid-conversation — worth
remembering: don't kill ports 4000/5173 as throwaway cleanup while Bede might still be using
the running app.

## 2026-07-23 — Proposed-stop row layout (several live-feedback rounds) + a new
## "Already Planned" day drill-down modal

Branch `bede-working`. All live UX feedback on "Plan My Visits," verified after every change
via a throwaway Playwright session against the real dev server (Lisa Marks id 5, temp token,
cleaned up each time per the smoke-test convention) — screenshots and, for the alignment fix,
actual measured DOM coordinates, not just eyeballing CSS.

**A divider between the last proposed stop and the "+ Add a stop"/"Suggest a stop" row** — a
`borderTop` on that row's wrapper, shown only when the day actually has stops (`day.stops.length
> 0`) so an empty day doesn't get a stray line.

**The proposed-stop row went through several compaction rounds, each a distinct ask:**
1. Category/tier/visit-type chips were already one flex row (`tag-list`) below the address —
   confirmed via screenshots at 1400/1100/800px that they never actually wrap, so "put them on
   one line" turned out to mean something else; asked Bede to disambiguate with three mockup
   options and he picked **drop the address from the list entirely** (still viewable via the
   place-detail click-through) — 3 lines/stop down to 2 (name; category/tier/visit-type).
2. Then: category/tier pills moved up onto the **name's** line; visit-type dropdown demoted to
   its own second line alone.
3. Then: visit-type dropdown moved back up, this time to the right side next to the estimated
   time/remove button — one line/stop total (name+pills left, select+time+✕ right).
4. Then: address came back (Bede wanted it after all) — now sitting under the name+pills line,
   and the visit-type select got breathing room (`gap: 14`) before the time/remove button.
5. **Real bug, not just polish:** a longer visit type ("Presentation / in-service") made the
   estimated-time text wider ("~27m" → "~1h 18m"), which shrank the flexible name column next
   to it, which shifted every row's dropdown left by a few px — rows didn't line up. Root cause
   was the time display having no fixed width. Fixed with `width: 90` on that div plus `width:
   190` (was `'auto'`) on the select itself, so neither box's size depends on its own text
   length. Verified by measuring actual `boundingBox()` x-coordinates across all 18 rows in a
   real generated draft (one stop switched to `presentation` to force the long label) — every
   select sits at the exact same x, not just visually close.

End state: `place_id + category chip + tier chip` (line 1), `address` (line 2), then on the
right: fixed-width visit-type select, fixed-width estimated time, remove button — all on line 1.
See `client/src/components/PlanVisits.jsx` around the stop `<li>` render (~line 404 onward).

**New: click an "Already Planned" day to see what's actually on it, in a modal.** Previously
each day in the "Already Planned" card was a plain row with Edit/Delete buttons sitting directly
on it, and no way to see which places were actually scheduled without reopening the whole day
into an editable draft first. Bede wanted a Places/People-style split instead: the row itself
becomes a plain clickable summary, and a new modal (`client/src/components/PlannedDayModal.jsx`)
shows the day's actual visits (name, category, tier, address, visit type — each visit clickable
to open the same `PlaceDetail` modal used everywhere else), with Edit and Delete moved into the
modal's footer (Delete bottom-left, Close/Edit on the right — same layout convention as
Place/Person modals).

Needed one new read: `visits` had no per-date list endpoint, only the count-per-date
`committedDateSummaries` query backing the old row. Added `scheduleDraft.committedDayVisits(db,
userId, date)` (`server/src/services/scheduleDraft.js`) — left-joins `places` for category/tier/
address/city/zip (a visit's place can be detached, so this can't be an inner join; `place_name`
is always present as the detach-safe snapshot) — and a new route, `GET /api/schedule-drafts/
committed-dates/:date/visits` (`server/src/routes/scheduleDrafts.js`). Deliberately the exact
same `user_id` + `scheduled_date` scope as the existing count query (no extra status/source
filter), so the modal's visit count always matches the row's stated count.

`reopenDay`/`deleteCommittedDay` (the functions the old row's Edit/✕ already called) now return
a boolean (previously nothing) so the modal knows whether to close itself after a confirm-gated
action actually succeeds, rather than always closing regardless of outcome.

Modal widened from an initial 480px to 640px after Bede tried it live and asked for more room —
default `.modal` max-width is 560px, so this is deliberately wider than the app's other modals to
comfortably fit a day's full stop list without cramming.

**Verified live, full click-through:** opened the modal on a real committed 12-stop day, clicked
a visit into full `PlaceDetail` and back (day modal still open behind it, not double-closed),
Edit (pulled the day back into an editable proposal, modal closed, all 12 stops now editable),
and Delete (removed the day, modal closed, "Already Planned" card disappeared, calendar date
freed back up) — each on its own freshly-committed test day, cleaned up after.

**Noticed, not fixed:** loading a fully-committed day fresh shows a brief "Draft not found"
error banner. Root cause is React StrictMode double-invoking `PlanVisits.jsx`'s `load()` effect
in dev only (`main.jsx` wraps the app in `<React.StrictMode>`) — when a draft's every day is
already committed, `load()` auto-discards the now-empty draft shell server-side, and the second
StrictMode-only invocation tries to discard the same already-gone draft and 404s. Doesn't happen
in production (StrictMode's double-invoke is dev-only) and isn't specific to this session's
changes — flagged to Bede rather than fixed, since it wasn't the ask.

Also asked directly why the "Already Planned" day's Edit button was disabled for Bede on
7/23/2026 (today): `homeBase` (the day's-route starting point) is captured fresh each page load
from geolocation or manual entry, never persisted — so a fresh session with neither set yet
disables Edit until "Use my current location"/"Enter address manually" is clicked once. Not a
bug, same gating the old row's Edit button already had; the tooltip already said as much
("Set a starting point before editing a planned day").

146 backend tests pass throughout, client build clean.

## 2026-07-27 — Categories become a real table, People/Places sort parity, log-a-visit from PersonDetail

Series of small live-feedback requests, same pattern as recent sessions: build something, Bede
clicks through it, asks for a refinement, repeat. All verified live via Playwright (Lisa Marks
id 5, temp token, cleaned up after every check per the smoke-test rule), 146 backend tests pass
throughout, client build clean throughout.

**Textarea resize removed app-wide.** One-line CSS fix (`textarea { resize: none; }` in
`styles.css`) — every notes field in the app (Person/Place/Referral/Visit modals) shares the
same base input styling, so this single rule covered all of them.

**Place categories are now a real, admin-editable table — no longer a hardcoded enum.**
Previously `server/src/config/categories.js` was a fixed 18-value JS array; `POST`/`PATCH
/api/places` validated against it in memory. **This is now stale in §13 of `HANDOFF.md` where
it says otherwise — corrected there.** New migration `20260727000000_add_categories_table.js`
creates a `categories` table seeded with the same 18 values (inlined into the migration, not
`require()`d, so the migration stays a self-contained snapshot); `config/categories.js` is
deleted. New `server/src/routes/categories.js`: list (with a live per-category place count),
add, rename (cascades to every place using the old name — a rename isn't a historical record
the way a place/person delete is, so this one *should* propagate), and delete (a retired
category doesn't touch or block the places using it — they just fall back to `category = null`,
already a normal state, matching the app's detach-not-destroy convention rather than a hard
FK). `routes/places.js` and `routes/notesReview.js` both now validate against the DB table.

New `client/src/components/CategoriesModal.jsx` — went through several live-feedback rounds to
its final shape: a plain list, each row a clickable name (click to rename inline, autofocus +
Save/Cancel) and a small red ✕ on the right (styled to match the app's existing danger-button ✕
convention from `PlanVisits.jsx`'s remove-stop button, then sized down slightly). The "add new
category" field is always visible, spans the row's width, with a compact `secondary`/`small` Add
button matching "+ Add person"/"+ Add place" elsewhere (fixed a flex-stretch bug where the button
was inheriting the taller input's height — needed `alignItems: 'center'` on the row). No
standalone "Manage categories" button in the filter bar — instead the Category filter dropdown
itself has a "Manage categories…" sentinel option (People.jsx and Places.jsx both), positioned
right after "All" (not buried at the bottom) so picking it opens the modal without ever actually
changing the filter's selected value.

**People tab: new "Last contacted by me" sort**, alongside the existing team-wide "Last
contacted" — `routes/people.js` gained a second last-visit subquery scoped to `req.user.id`. The
"Last contacted" column relabels to "Last contacted (you)" and swaps in your own last-visit date
whenever one of the "by me" sorts is active, so the column and the sort order never disagree.

**Places tab now has full sort parity with People** ("Last visited"/"Last visited by me" instead
of "contacted", plus the existing Referrals/Last referral options) — same server-side pattern,
`routes/places.js` gained its own `my_last_visit_date` subquery and a `sortPlaces()`. Extracted
the shared null-safe `compareDatesAsc` date comparator (previously duplicated identically in
`people.js`) into new `server/src/services/sortHelpers.js`, used by both routes now. The
"Never visited" toggle button is gone — sorting by "Last visited (oldest/never first)" already
surfaces those places first, so the dedicated button was redundant (Bede's call). The place
list's "Location" column no longer shows city/zip, just region — renamed to "Region" to match.
Referral count styling (bold, teal, 16px) now matches the People tab exactly, was previously
plain text.

**PersonModal's place picker can create a brand-new place inline.** When adding a person from
the People tab (no fixed place yet), the "Place" dropdown has a "+ Add a new place…" option
(positioned right after "No place (unassigned)", not at the bottom) that opens a nested
`PlaceModal` on top of the person form — same stacked-modal pattern `PlaceDetail.jsx` already
uses for its own nested Person/Assign modals. Saving the new place closes the nested modal,
returns to the person form, and auto-selects the place that was just created (merged into the
dropdown's options locally, since the `places` prop won't reflect it until the parent reloads).

**PersonDetail can now log a visit directly**, not just view/edit ones already on file — this
was a real gap, not a deliberate restriction (visits are anchored to a place, and PlaceDetail's
"Log a visit" flow was never mirrored onto PersonDetail). New "Log a visit" button next to
"Visit history", shown only when the person has a place assigned (a visit needs one; hidden
entirely for unassigned people rather than shown disabled). `VisitLogModal` gained an optional
`initialPerson` prop that pre-selects the "who did you meet?" picker as a convenience default
(still changeable, unlike the existing `personRecordGone`-locked case) — used here to default to
whoever's PersonDetail you're already looking at.

## 2026-07-27 (later the same day) — Needs Mapping removed entirely

Bede's explicit request, no ambiguity: "Can we remove the Needs Mapping tab entirely now. I
don't want any trails of its functionality. I have no use for it any more." He's planning a
from-scratch replacement for historical-notes-import later — this isn't a "hide it for now,"
it's a full removal, and nothing about the new version should assume this old shape.

**One real design fork worth remembering:** `scripts/import-notes.js` did double duty — it
imported referrer notes that matched an existing place as real completed visits (history), and
parked unmatched ones in `notes_review` for the Needs Mapping tab (workflow). It's also wired
into the production auto-seed (`index.js`'s `seedIfEmpty()`, runs on a fresh empty-DB deploy).
Asked directly rather than assuming: keep a simplified matched-only importer (auto-seed still
backfills history, just silently skips unmatched notes) vs. delete the whole thing. **Bede chose
full deletion** — a future fresh deploy will only seed places from the main spreadsheet;
`ReferrerNotes.xlsx`'s historical visit data won't get imported at all until his new
from-scratch version exists. Checked first whether this was actually safe to lose: dev DB had
**zero** rows in `notes_review` and **zero** `imported_note` visits at the time — so nothing
in-progress was actually destroyed by this choice, just a not-yet-exercised capability.

**Full deletion list:** `client/src/components/NeedsMapping.jsx`, `hooks/useDuplicateMatches.js`
and `ui/DuplicateWarning.jsx` (both had exactly one caller — NeedsMapping — so both went fully
dead the moment it did; found `DuplicateWarning.jsx` by grepping for its own remaining callers
after the fact, not from the initial file-reference survey, worth remembering to re-check for
second-order dead code like this), `server/src/routes/notesReview.js`,
`server/src/scripts/import-notes.js`. New migration `20260727010000_drop_notes_review.js` drops
the `notes_review` table outright — a plain `dropTableIfExists`, not editing the original
`20260706010000_notes_import.js` that created it (this repo's established convention: schema
removals are new migrations, never edits to already-applied history, see
`20260724000000_drop_people_role_type.js` for the precedent). `App.jsx` lost the "Needs Mapping"
nav tab and its pending-count badge machinery entirely; the now-fully-dead `.tab .count` and
`.warning-banner` CSS rules went with it (double-checked neither was used anywhere else first).

**Deliberately NOT touched, and why:** `visits.source` (`manual`/`imported_note`/`planner`)
stays — it's still load-bearing for the route planner's commit-collision unique index
(`source: 'planner'` scoping, see the 2026-07-15 ultra-review entry above), completely
unrelated to Needs Mapping despite being added by the same original migration. `ui/
PlacePicker.jsx` stays too — originally lived only in NeedsMapping, but PlanVisits.jsx's ad-hoc
"+ Add a stop" flow has depended on it since 2026-07-14; only its stale comment referencing
NeedsMapping got fixed, not the component itself.

Also swept and fixed every stale "Needs Mapping" reference in `README.md` (feature bullet,
scripts table, API route table, schema table) and `HANDOFF.md` — corrected the file-tree
diagram (§3), the schema section (§4, `notes_review` bullet replaced with the newer
`categories` table that's actually current), the key-features list (§5), marked all of §7
"Historical notes import" as removed-but-kept-for-history rather than deleting that section
outright (matches this doc's own established convention for retiring a section — see how
§14A/§14B already do this), and removed two now-impossible "next step" suggestions that
referenced finishing Needs Mapping work. Left every genuinely historical dated session-log
entry alone (including the still-accurate-as-history "Needs Mapping geocoding gap, fixed
2026-07-22" bullets) — those are a record of what was true then, not live claims about now.

146 backend tests pass, client build clean, verified live (nav bar shows exactly 4 tabs — no
"Needs Mapping" — `GET /api/notes-review` 404s, no console errors on any tab).

## 2026-07-27 (still later) — "Somewhere else": manual zone override for a draft day

Bede wanted a way to say "I'd rather work a different area today" on a generated draft day,
instead of always taking whichever region the top-ranked candidate happens to be in. He asked
for a design review before any code — walked through `scheduleGenerator.js`/`scheduleDraft.js`
with him first (touch-points, exact threading plan, open questions) and got explicit sign-off
on three decisions before writing anything: (1) persist the *resolved zone name* per date, not
a bare integer index — reuses the existing `params.zoneOverrides[date]` slot `loadDraftView`/
`loadDraftDayView` already read, so "index persists across edits, resets on regenerate" falls
out for free with zero changes to those functions; (2) the "a commitment in a non-selected zone
must still surface as dropped" requirement is scoped to only the new zone-cycle endpoint, not
backported into plain `generateDraft`/`fillDayFromZone` (a real, narrower version of the same
gap already existed there too, just rare — see below); (3) the API supports both directions
(`direction: 1 | -1`) from day one even though the UI only ships a single "Somewhere else"
button — reversibility comes from the cycle wrapping around, not a visible "back" control yet.

**Real architectural findings from the review, worth remembering:** `droppedCommitments`
(the "a promise didn't make the cut" flag `fillDayFromZone` computes) never actually survived
past the initial `/generate` call before this — `generateAndPersistDraft` computed it and threw
it away, `loadDraftView`/`loadDraftDayView` never recomputed it, the client never referenced it.
This session is the first time it reaches an API response for real. Also: there was no existing
"local re-sequence path" doing zone selection (steps 2c→2e) to reuse, despite that being how the
request was originally framed — `addStop`/`removeStop`/`reorderDay`/`setVisitType` only ever
mutate stops directly, `reoptimizeDay` only resequences what's already there; none of them touch
candidate ranking. `fillDayFromZone` itself was already zone-agnostic (takes `zone` as a plain
parameter, no assumption baked in) — the "zone = top-ranked region" default lived one level up,
in `generateDraft`'s per-day loop and in the two read functions' display-fallback line. Both
findings meant this needed a genuinely new function, not a modification of an existing one.

**Built, in parallel via two background subagents** once the shared contract was fully pinned
down (exact function signatures, endpoint shape, response fields) — the foundation (pure
functions + their tests) was done directly first since everything else needed its exact shape:

- `scheduleGenerator.js`: three new pure, unit-tested functions — `orderedZones(ranked)` (dedup
  regions in rank order — index 0 is always what the default pick would choose),
  `stepZone(zones, currentZone, direction)` (cyclic, wraps both ways — the actual "Somewhere
  else" logic and the reversibility guarantee), `outOfZoneCommitments(ranked, zone)` (every
  commitment-tier candidate NOT in the selected zone — the fix for the gap above; disjoint from
  `fillDayFromZone`'s own `droppedCommitments` by construction, union the two for the full
  picture). 13 new tests.
- `scheduleDraft.js`: new `cycleDayZone({ draftId, userId, date, direction })` — rebuilds the
  candidate pool for that date, ranks, derives the zone list, steps to the next zone, re-runs
  `fillDayFromZone` (identical packing behavior to generation, only the zone differs), persists
  by replacing that date's `schedule_draft_stops` and writing the resolved zone name into
  `params.zoneOverrides[date]`.
- `scheduleDrafts.js`: new `POST /:id/days/:date/zone` route, `direction` validated to `1`/`-1`/
  omitted only.
- `api.js` + `PlanVisits.jsx`: a "Somewhere else" button per day (scoped to that day's own
  `busy` state, no full-draft reload — same pattern every other per-day mutation already uses),
  an "Area N of M" position indicator, and a notice banner reusing the exact `.notice-banner`
  mechanism `commitDay`'s skipped-collisions message already uses, for when
  `droppedCommitments` comes back non-empty.

**A real bug caught by live testing, not code review**, in the subagent's otherwise-correct
implementation: `cycleDayZone`'s own-draft exclusion originally reused the existing
`ownDraftPlaceIds(draftId)` helper unscoped — correct reasoning for avoiding a re-pack
collision (a place can't belong to two regions, so this day's own current stops could never
spuriously collide with the new zone's candidates), but wrong for commitment visibility: it also
excluded this day's own current stops from the re-ranked pool entirely, which made a commitment
sitting among them invisible to `outOfZoneCommitments` too — the exact "silently drop a promise"
outcome the whole feature exists to prevent. Only caught by generating a real draft with a real
backdated commitment (`next_visit_date` due, `scheduled_date` in the past — a same-day
`scheduled_date` turned out to *also* trip the separate `lockedElsewhere` check, a test-setup
trap worth remembering for next time) and hitting the live endpoint — the first live call came
back with an empty `droppedCommitments` when it should have had one. Fixed by scoping the
exclusion to only the draft's *other* dates, not the current one.

**Verified live end-to-end** (Lisa Marks id 5, temp token, cleaned up after every check):
generated a draft with a real commitment in Southeast Lincoln, clicked "Somewhere else", landed
on East Lincoln (Area 2 of 15), notice banner read exactly "Switched to a different area for
7/28/2026 — 1 commitment outside it won't be visited today: Primary Care Partners." — confirmed
via direct API calls too that forward/backward/wraparound all behave correctly and an invalid
`direction` value 400s. 159 backend tests pass (146 + 13 new), client build clean throughout.

**Live UI polish, same session** (three quick rounds after Bede tried it): moved the
"Somewhere else" button from the day card's right-side action group to sit next to the date/
region on the left; added a "·" separator matching the app's existing date-region separator
exactly (first attempt used a muted/lighter span that didn't match the bold h2 text — fixed to
plain inline text inheriting the header's own styling); moved that separator to sit between the
region name and the "Area N of M" indicator (it only appears after the first cycle, so this only
matters once the rep has actually clicked the button once) rather than between "Area N of M" and
the button itself.

## 2026-07-28 — Real double-booking bug fix, Route Planner rename, Calendar tab overhaul, "Already Planned" status-filter bug

Builds on the same day's earlier `1393abf` (new Calendar tab) / `b04c33b` (zone-picker cycling
→ direct-select dropdown) commits, both already in before this session started.

**Real bug fix: multi-day generate could propose a place another rep already had committed for
that exact date.** Bede noticed live: he could still be offered a place already locked in on
someone else's calendar for the same day (couldn't accept it — `commitDay`'s own collision check
is correctly date-scoped — but it shouldn't have been proposed at all). Root cause:
`generateAndPersistDraft` computed the locked-elsewhere set ONCE against generation-day
(`today`), then handed `generateDraft` a single static `lockedElsewhere` flag per candidate,
reused unchanged across every day in a multi-day window — a place locked specifically on day 3
of the window (not generation-day) was invisible to that check. This is exactly what an earlier
session's "known, documented, accepted simplification" note (in phase 6's write-up above) wrongly
excused as safe — it wasn't. Fixed with a new `lockedElsewherePlaceIdsByDate(db, {dates, userId})`
(one query pair for the whole window, grouped by date in JS) feeding a new `lockedByDate` param
on `generateDraft`, which now re-derives each candidate's `lockedElsewhere` flag fresh every
iteration of its day loop instead of once up front. New regression test in
`scheduleGenerator.test.js` proves a place locked on day 1 only is excluded day 1, still offered
day 2. Verified live too: Lisa Marks (temp token) generated a 2-day draft while a throwaway
`__SMOKETEST_Rep2` user had a real committed visit to a throwaway place (pinned to the `Beatrice`
region — only 1 other real place there, keeps ranking deterministic) on day 1 — day 1 correctly
excluded it, day 2 correctly still offered it. 153 tests pass (up from 152, the one new
regression test). All test data fully cleaned up after.

**"Plan My Visits" tab renamed to "Route Planner"** — more accurately reflects what it is (the
suggest/optimize tool) versus the new Calendar tab (the actual full picture of everything
planned). `PlanVisits.jsx` → `RoutePlanner.jsx` (component, file, export), nav label + `<h2>`,
every current-state comment referencing it across client/server, README's feature bullet, and
HANDOFF.md's file-tree/features-list/two open-items bullets. Deliberately left NOTES.md/
`ROUTEPLANNER_PROGRESS.md`/HANDOFF.md's own dated changelog entries alone — those describe what
the tab was actually called *at the time*, rewriting them would misrepresent history.

**PlannedDayModal** ("Already Planned" day drill-down, reused later this session by the Calendar
tab too): dropped the tier chip (category alone is enough there; the now-dead `p.tier` column
also dropped from `committedDayVisits`' query). Edit button used to be disabled whenever no
starting point (`homeBase`) was set yet, with a "go set one first" tooltip — now it stays enabled
and auto-locates: a new shared `client/src/geolocation.js` (`getCurrentPosition()`, promise-
wrapped browser geolocation) is called automatically if `homeBase` is empty when Edit is clicked,
same fallback both `RoutePlanner.jsx`'s own reopenDay and its "Use my current location" button
now share. Verified live with geolocation mocked and no starting point ever set client-side —
Edit rendered enabled, resolved the mock location, day genuinely reopened into an editable draft.

**Calendar tab overhaul** (multiple rounds of live feedback, all Bede-directed): the day cell
itself is now never clickable at all — `ui/MonthCalendar.jsx`'s contract changed from a `<button>`
wrapping the whole cell (with `isDayActive`/`onDayClick` props) to a plain `<div>`; the caller's
`renderDay` supplies its own nested clickable elements instead. `VisitsCalendar.jsx` splits each
day's visits into three buckets (`splitDayVisits`): **your own planned-status visits** → a blue
"Planned Route" badge opening `PlannedDayModal` (only ever your own — there's no endpoint to view
another rep's day, confirmed with Bede before building); **completed visits, any rep** → a teal
"Completed Visits" badge (renamed from a plain "Completed" chip after Bede's follow-up) opening
`CalendarDayModal` filtered to just those; **everything else** (skipped, plus other reps'
still-open planned visits in "All reps" scope) → the pre-existing small status dots, still
clickable, still `CalendarDayModal`, just narrower now. Full Edit/Delete parity confirmed with
Bede for the "Planned Route" badge — Edit reopens the day (same auto-locate as above) and hands
off to the Route Planner tab via a new `onNavigateToPlanner` prop threaded from `App.jsx`, since
the Calendar tab has no draft workspace of its own to show the result in; Delete removes the
day's planned visits with the same confirm/endpoint as Route Planner's own. The "Today" button
(and its `goToday` handler) was removed outright, per Bede's direct ask — no replacement. The
Mine/All-reps pair of buttons became one `.scope-toggle` button split down the middle (one click
target, not two) — first pass used a fully-rounded pill, Bede asked for it to read like the app's
other small buttons instead, so it now uses `--radius-sm` + `.btn.small`'s padding/font-size.
Every piece live-verified via Playwright (Lisa Marks temp token, mocked geolocation where
needed, cleaned up after each check) — including a locator gotcha worth remembering: Playwright's
`hasText` regex matches raw `textContent`, which has no inserted newlines for flex/block layout,
so anchored regexes like `/^29$/m` against a whole multi-child cell silently match nothing: filter
on the specific leaf element (`.month-calendar-daynum`) instead.

**Real bug fix: "Already Planned" (Route Planner) was showing completed visits too.** Bede caught
this from his own real usage, not a smoke test — he had a real completed visit logged for today
(7/28) and it was showing up in the "Already Planned" list/modal, which should only ever be
still-open planned visits. Root cause: `committedDateSummaries` (the date-list/count query, also
what blocks re-planning a date) and `committedDayVisits` (what `PlannedDayModal` actually
displays) never filtered by `status` at all — any visit, any status, counted. Both now scope to
`status: 'planned'`, matching `deleteCommittedDay`'s existing scope (previously mismatched: a
date's shown count could include a completed visit Delete would never actually clear). Verified
read-only against Bede's own real account (never touched his data) — before the fix,
`committedDateSummaries` for him included 7/28 (the completed "Guardian Angels (Test)" visit
lands there); after, only his two genuinely-planned dates (7/29, 7/30) show. 153 tests pass,
client build clean.

**Flagged, deliberately NOT fixed — revisit tomorrow:** `PlannedDayModal.jsx`/
`CalendarDayModal.jsx` picked up a manual title-suffix edit outside this session's own changes
(`<h2>{formatDate(date)} · Planned Visits</h2>` / `· Completed Visits` — presumably Bede's own
direct edit, not something I wrote). Real issue: `CalendarDayModal` is reused for TWO different
filtered views in the Calendar tab now (the "Completed Visits" badge AND the leftover skipped/
other-reps'-planned dots) — the hardcoded "· Completed Visits" suffix will show on the skipped
popup too, mislabeling it. Bede's explicit call: leave it exactly as-is, just flag it here for
tomorrow rather than making the suffix conditional now.

**Resolved 2026-07-29** — see below: `CalendarDayModal` now takes an explicit `title` prop (no
more hardcoded suffix), used for all three of its callers ("Completed Visits", "Skipped Visits",
and another rep's planned route before that moved to `PlannedDayModal` instead).

## 2026-07-29 — Calendar tab: other reps' planned routes, grid-reflow fixes, a real anchored "+N more"/day-number popover, scope-toggle persistence, rectangular pills

A long back-and-forth session, all Bede-directed live feedback on the Calendar tab built the day
before, plus one detour into PlaceDetail/PersonDetail. In commit order (roughly):

**"All reps" now actually shows other reps' planned routes, not just a generic dot.**
`VisitsCalendar.jsx`'s `splitDayVisits` used to filter `myPlanned` to just `userId`, dumping every
other rep's still-open planned visit into the same catch-all bucket as skipped visits (a single
unlabeled blue dot). Now it groups all `status: 'planned'` rows by `user_id` into `plannedGroups`
(own group always first, then everyone else alphabetically), and `renderDay` shows one "Planned
Route"-style badge per group: **"My Planned Route"** for your own, **"`<Name>`'s Planned Route"**
for everyone else's. Your own badge still opens `PlannedDayModal` (fetches fresh from
`committedDayVisits`, has the full Edit/Delete footer). Bede's next ask: make another rep's badge
*look* the same as your own, minus Edit/Delete — so `PlannedDayModal` gained `visits` (preloaded,
skips its own fetch), `title` (override the header), and `readOnly` (drops Edit/Delete down to a
bare Close) props, and now handles both cases. `CalendarDayModal` also gained a `title` prop
(replacing its old hardcoded "· Completed Visits" suffix — see the flagged item above, now
resolved) and a `showRepName` prop (replacing an overloaded `scope` prop that existed only to
toggle one "with {rep}" line).

**Two rounds of "the grid keeps resizing" bug fixes, both real CSS gotchas:**
1. A long pill's text (e.g. "Nikki Shasserre's Planned Route") was forcing its whole day cell —
   and the grid column alongside it — wider, because `grid-template-columns: repeat(7, 1fr)` has
   an implicit per-track minimum of `auto` (the content's min-content size), which a `white-space:
   nowrap` pill defeats. Fixed with `repeat(7, minmax(0, 1fr))` plus `max-width: 100%; overflow:
   hidden; text-overflow: ellipsis` on the pill classes themselves — long labels now truncate
   in-place instead of blowing out the layout.
2. Separately, switching tabs shifted the whole centered `.app` container left/right by a few
   pixels, because tabs vary a lot in page height and the vertical scrollbar toggling on/off
   changes the available width. Fixed globally with `html { overflow-y: scroll; scrollbar-gutter:
   stable; }` — the scrollbar's gutter is now always reserved, whether or not a given tab actually
   needs to scroll.

**"+N more" overflow chip**, for when a day has more pills than fit: `buildDayPills`/
`splitPillsForDay` turn a day's pills into one capped, priority-ordered list (yours first, then
completed, then everyone else alphabetically); anything past the cap (`MAX_VISIBLE_PILLS`,
currently 3 — Bede raised it from an initial 2 himself, edited directly in the file) collapses
into a "+N more" chip.

**`DayOverflowModal` went through four real design iterations, all live Bede feedback, each one
actually built and screenshot-verified rather than just discussed:**
1. First cut: a plain centered modal, a plain `<ul>` list of the overflow pills only.
2. → An "enlarged view of the whole day": switched to showing *every* pill for the day (own +
   completed + every other rep, via new `buildFullDayPills`, not just the overflowed ones), each
   rendered as an actual colored pill (reusing `.planned-route-badge`/`.completed-visits-badge`
   colors) instead of a plain list row — plus a new "Skipped Visits" pill kind, since skipped
   visits are a plain dot in the cell but deserve a full pill in this enlarged view. Still a
   centered modal at this point.
3. → A real anchored popover, not a modal: rendered via `createPortal` straight onto `<body>`
   (`.month-calendar-grid` has `overflow: hidden` for its own rounded corners, which would
   otherwise clip a popover nested inside a day cell), positioned in *document* coordinates
   (`getBoundingClientRect()` + `window.scrollX/Y`, not viewport-`fixed`) so it scrolls naturally
   with the page. Closes on click-outside or Escape (no backdrop to catch that for you, unlike a
   real modal). Caught one real bug during live verification: forgot `position: absolute` on the
   popover's own CSS, so its computed `top`/`left` had no effect and it rendered at the bottom of
   `<body>` — fixed by adding the missing declaration.
   Repositioned twice more per direct feedback: first to land flush on the day cell's own
   top-left corner (anchored to the whole `.month-calendar-day`, not just the chip button) so it
   visually *covers* the day instead of floating beside it; then, after Bede reported the bottom
   row's popover looking bad jammed against the screen's bottom edge, changed to center on the
   cell's own midpoint (both axes) first and only *then* clamp to the viewport — still covers the
   cell, but now gravitates toward the middle of the screen for edge-row/column cells instead of
   hugging whichever edge was closest.
4. → Pills changed from one-per-row wrapping at 14px to one-per-line (`flex-direction: column`)
   at 12px, per Bede's ask ("only one pill per line" + "just a little too big").

**Every colorful pill across the Calendar tab — day cell badges and the popover's own — reshaped
from a fully-rounded pill (`border-radius: 999px`) to the app's actual button radius
(`var(--radius-sm)`).** Bede's reasoning, worth remembering for any future badge/chip: *nothing
else in this app lets you click a rounded pill*, so keeping that shape on the one place you
genuinely can click was sending the wrong signal. One shared base-rule edit did it everywhere,
since `.day-overview-pill`/`.skipped-visits-badge` never override `border-radius` themselves.

**The day number itself is now clickable**, opening the same `DayOverflowModal` popover
(`buildFullDayPills`, not just the overflow) even on a day with nothing on it at all — every day
now gets the same "open it up for a closer look" affordance, not just ones with a "+N more" chip.
`DayOverflowModal` gained an `EmptyState` fallback for that empty-day case. `.month-calendar-daynum`
went from a plain `<span>` to a `<button>` reset back to looking identical (`font: inherit; color:
inherit`) plus a blue hover as the one clickability hint, since the number itself carries no other
visual cue that it's a button now.

**Scope toggle now survives switching tabs.** `VisitsCalendar` unmounts entirely on every tab
switch (`App.jsx`'s `{tab === 'calendar' && <VisitsCalendar .../>}`), so its own `useState('mine')`
was silently resetting back to "Mine" every time you left and returned to the Calendar tab — Bede
wanted it to stick until logout. Lifted `scope`/`onScopeChange` up into `App.jsx` (which never
unmounts), with `logout()` explicitly resetting it back to `'mine'` so a fresh session always
starts on your own calendar. Verified via a real logout+relogin round-trip (fresh temp token both
times, since `logout()` invalidates the old one server-side): toggle set to "All reps" → switch
tabs away and back → still "All reps" → log out, log back in → back to "Mine".

**Detour: "Upcoming Visits" added to PlaceDetail and PersonDetail, then reverted from PersonDetail
only.** New `GET /api/places/:id` and (briefly) `GET /api/people/:id` field `upcoming_visits` —
same shape as the existing `visits` (history) query, just `status: 'planned'` and soonest-first
instead of most-recent-first — plus a new read-only `UpcomingVisitDetailModal.jsx` (view-only for
now, editability deliberately deferred). Live-tested against Bede's real committed visits before
either side landed. Then, before committing, Bede asked directly whether the PersonDetail side was
worth keeping — flagged that route-planner-committed visits only ever get a `place_id`/`user_id`,
never a `person_id` (nothing in the current planning flow lets you pin a specific contact ahead of
time), so that card would read "Nothing upcoming" for every person, indefinitely. Bede agreed to
cut it. **PlaceDetail keeps its "Upcoming visits" card** (genuinely populated, since a planned
visit always has a `place_id`); **PersonDetail's was fully reverted**, both the UI (card, modal,
state, imports) and the server-side query/field on `GET /api/people/:id` — nothing dead left
behind on either side.

All of the above verified live via Playwright against a temp auth token on Lisa Marks (id 5, per
house convention — never Bede's real account), cleaned up after every check; several rounds used
Bede's own real committed visits (read-only) as realistic multi-rep test data, and two rounds
needed one throwaway `visits` row inserted and deleted afterward (a third rep's planned stop, to
get a 3rd/4th pill; a skipped-status stop, to check that pill's color) since real data didn't
happen to cover those cases that day. 153 tests pass throughout (no backend logic changed except
the `upcoming_visits` add-then-revert on `people.js`, which nets to no diff), client build clean.
