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
before he moves on to the route planner. **Everything below is uncommitted** — check
`git status`.

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
- **Two real data-integrity bugs, not yet fixed:** deleting a person orphans their referrals
  with no snapshot (unlike visits) so the referrals silently vanish from every metric forever;
  and editing a visit becomes permanently blocked once its linked person is deleted, because
  `VisitLogModal` requires picking a currently-assigned person to save. Both contradict the
  app's own detach-not-delete convention — fix these before building the route planner on top
  of this data.
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

## Current state
- 2026-07-09's work (`cb706a8`) is committed. **2026-07-10's work above is not** —
  check `git status` before starting anything new.
- Local dev only — nothing deployed. `./dev.sh` runs both servers
  (backend :4000, frontend :5173).
- Database: 261 real places, a handful of real visits/referrals logged since
  the clean-slate wipe, plus Bede's own manually-created test data (place
  "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar Jr. —
  don't delete these, they're fixtures he made on purpose). Only Bede's account
  has a real password set; Nikki/Lisa/Basil still need to log in once to create
  theirs.
- **Geocoding backfill has been run** — 255/262 places have coordinates, 7 need
  manual address review (corrected 2026-07-10; earlier revisions of this file
  said the backfill hadn't run yet).
- **Two known data-integrity bugs are open** (referral orphaning on person
  delete; visit-edit lockout when the linked person is later deleted) — see the
  2026-07-10 entry above and `HANDOFF.md` §14A. Fix before building the route
  planner.
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
  the People tab, Places tab, both detail pages, and the Dashboard.
- Feeding referral metrics back into place priority scoring is still an open
  idea, now with an objective signal to use.
- Picking a date other than today when planning a route (currently today-only).
- Populating `places.phone` (not in the original Excel import) so the Call
  button on Place Detail always shows up (currently only for places someone's
  added a phone number to by hand).
- Re-running `npm run import:notes` when ready to bring back the 2 years of
  historical referrer notes.
- Still true from the original handoff: consider Postgres backups and a
  Railway spend cap whenever this gets redeployed.
