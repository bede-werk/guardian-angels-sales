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

## Current state
- All of the above is committed and merged to `main` (see recent commits).
- Local dev only — nothing deployed. `./dev.sh` runs both servers
  (backend :4000, frontend :5173).
- Database: 261 real places, 0 visits, 0 contacts, 0 notes-review backlog — a
  clean slate. Only Bede's account has a real password set; Nikki/Lisa/Basil
  still need to log in once to create theirs.

## Next steps / ideas not yet done
- Referral logging UI (schema exists, nothing writes to it yet).
- Feeding contact relationship_temp + referral history back into place
  priority scoring (explicitly deferred in the data-model spec).
- Picking a date other than today when planning a route (currently today-only).
- Populating `places.phone` (not in the original Excel import) so the Call
  button on Place Detail actually shows up.
- Re-running `npm run import:notes` when ready to bring back the 2 years of
  historical referrer notes.
- Still true from the original handoff: consider Postgres backups and a
  Railway spend cap whenever this gets redeployed.
