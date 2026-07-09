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

## Current state
- Everything through today (2026-07-09, `cb706a8`) is committed. `git status`
  is clean as of this writeup.
- Local dev only — nothing deployed. `./dev.sh` runs both servers
  (backend :4000, frontend :5173).
- Database: 261 real places, a handful of real visits/referrals logged since
  the clean-slate wipe, plus Bede's own manually-created test data (place
  "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar Jr. —
  don't delete these, they're fixtures he made on purpose). Only Bede's account
  has a real password set; Nikki/Lisa/Basil still need to log in once to create
  theirs.
- Existing places haven't been backfilled with coordinates yet — `npm run
  geocode` hasn't been run against the real dataset (only new/edited places
  going forward get geocoded automatically).
- See `HANDOFF.md` §13 for the authoritative, more detailed current-state
  snapshot — this section is a summary, that one's the source of truth.

## Next steps / ideas not yet done
- **Run `npm run geocode`** to backfill lat/lng on the 261 existing places —
  new/edited ones get it automatically, but the bulk of the dataset predates
  today's geocoding work.
- Nothing in the UI uses lat/lng yet — a map view of places/routes is the
  natural next step now that coordinates exist.
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
