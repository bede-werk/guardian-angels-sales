# Guardian Angels Homecare — Sales Visit Scheduler

A full-stack app for planning and logging referral-place sales visits around Lincoln, NE.

- **Backend:** Node.js + Express + Knex, SQLite locally (swap to PostgreSQL for the cloud with no query changes)
- **Frontend:** React + Vite
- **Data:** imported from `Guardian Angels Sales List.xlsx` (sheet `📋 Visit Tracker`, ~261 places)

## Features

- **Auth** — simple bearer-token login (pick your name, set a password on first use). All `/api` routes except login require it.
- **Import** the Excel place list into the database (idempotent — safe to re-run).
- **Route planner ("Plan My Visits")** — generates a multi-day draft of visits from a four-tier priority model (commitments > endangered/overdue > exploration > maintenance), sequenced by real driving routes (OSRM) within a daily time budget. Live-editable (reorder, add, remove, change visit type) with in-place time/budget recalculation, plus a "suggest a stop" prompt on under-budget days. Commit a day (or everything remaining) to turn draft stops into real visits, with multi-user collision protection so two reps can't get double-booked into the same place on the same day.
- **Places tab** — full CRUD directory (add/edit/delete places), search & filter by category, tier, city, zip; each row shows last (completed) visit, a preview contact, and the place's live referral tally.
- **People tab** — a cross-place directory of every individual contact, independent of place assignment (a person doesn't need a place, and a place doesn't need a person). Search/filter by place, category, "needs attention" (referred before but quiet the last 90 days), or "never contacted."
- **Place detail** — editable org-level fields (an **Edit** button opens the same form used to create places, pre-filled), org-level notes (click-to-edit, with Save/Cancel/**Delete**), a simple roster ("People here") with each person's own referral metrics (lifetime count, last referral date, last-90-days count) and a "cooling" flag for anyone who's gone quiet, an **Assign person** picker (attach someone who already exists — shows a default list of every currently-unassigned person, plus the existing search-everyone box) vs **New person** (create one from scratch), detach-without-deleting, and **Log a referral** / **Log a visit** actions. The place's own referral metrics (top of the card, and in the directory table) are always the live roll-up of its *currently assigned* people's own numbers.
- **Person detail** — contact info (phone/email shown as real text, not just Call/Email buttons) in its own panel, notes/preferences/birthday each independently click-to-edit (notes and preferences are both resizable textareas), a referral log with lifetime/last-referral/last-90-days metrics and a "needs attention" flag, plus full visit history that survives even if they're later detached from a place. Starting an edit on any one field (or any other action on the card — assigning a place, logging/viewing a referral or visit, opening Edit) automatically backs out of whichever other field is mid-edit, so you never end up with two unsaved drafts open at once.
- **Inline field editors (Place notes; Person notes/preferences/birthday)** — a standardized button layout: **Delete** on the far left (only shown once there's a saved value to delete), **Cancel** and **Save** grouped on the right with Save on the far right.
- **Visit detail popup** — clicking a visit row on either detail page opens a read-only popup with everything on file for that visit (status, outcome, logged-by rep, contact snapshot, notes, next-visit date), with an Edit button into the same visit-logging form, and a **Delete** button (bottom-left) to remove the visit entirely. Keeps the inline visit-history rows themselves down to just date + who/where + a notes preview.
- **Referral detail popup** — same pattern as the visit detail popup: clicking a referral row opens `ReferralDetailModal` with the full note, an Edit button, and a bottom-left **Delete** button.
- **Geocoding** — every place's address is resolved to lat/lng via the US Census Bureau's free geocoder (no API key) whenever it's created or its address changes. `npm run geocode` backfills any place that doesn't have coordinates yet, using the Census batch endpoint (up to 10,000 addresses per request). Best-effort only — a failed lookup never blocks saving a place. **The backfill has been run against the real dataset** — 255 of 262 places have lat/lng as of 2026-07-10; the other 7 didn't match and need manual address review (see Known issues below). One gap: places created via the Needs Mapping "create place" flow (`notesReview.js`) skip geocoding entirely — only the main `POST /api/places` path geocodes. Nothing in the UI consumes the coordinates yet (no map view), but the data's there for one.
- **Detach, don't cascade-delete** — deleting a place only deletes the place: its people are unassigned (not deleted) and every visit logged there is preserved via a `place_name` snapshot. Deleting a person similarly preserves their visit history. People can be removed from a place (or reassigned) without losing any history.
- **Referrals** — every referral is logged against a specific person. A person's own metrics follow them if they move (or are removed from) a place; a place's numbers are always derived live from its current roster, so they drop immediately when someone's detached.
- **Referral metrics — objective, no manual upkeep** — every person and place shows three numbers computed live from the referrals table: lifetime referral count, most recent referral date ("none yet" if there aren't any), and referrals in the last 90 days. A person or place with referrals in the past but nothing in the last 90 days is flagged **"needs attention" / "cooling"** — surfaced on the Dashboard, and filterable on both the People and Places tabs. There's no manual field to set or forget; see `server/src/services/referralMetrics.js`. (This replaced an earlier manual `hot/warm/cold/dormant` relationship-temperature field, removed because it required upkeep nobody kept up with.)
- **Visit logging** — notes, key contact (name / title / email / phone), outcome (interested / not ready / follow up / no answer), and next visit date. Phone numbers are normalized to `(402) 555-1234` everywhere they're entered.
- **Dashboard** — visits completed this week, high-priority places never visited, and a "needs attention" rollup (cooling relationships, overdue next-visit dates).
- **Multi-user ready** — visits are assigned to a team member; the schema supports adding more reps later.
- **Historical notes import** — loads 2 years of referrer notes (`ReferrerNotes.xlsx`) into
  place history. Notes whose referrer can't be auto-matched land in a **Needs Mapping**
  screen where you assign each to a place (or create one).

### Priority scoring

`Tier 1 + ⭐ Priority` (35) > `Tier 1` (30) > `Tier 2` (20) > `Tier 3` (10). Higher score = visited sooner.

---

## Known issues (found 2026-07-10, not yet fixed)

Full detail, plus a route-planner readiness assessment, in `HANDOFF.md` §14A/§14B. The two that matter most:

1. **Deleting a person orphans their referrals with no snapshot.** `visits` has `person_name`/etc. snapshot columns so visit history survives a person being deleted, but `referrals` has no equivalent — a deleted person's referrals silently drop out of every referral-metrics rollup forever. Contradicts this app's own "detach, don't delete" rule.
2. **Editing a visit becomes permanently blocked if the linked person is later deleted.** `VisitLogModal`'s save button requires a *currently-assigned* `person_id`; a deleted person's visit has `person_id = null` even though the name/contact snapshot survives, so the edit form can't be saved without reattributing the visit to someone else.

Fix both before building the route planner on top of this data — it leans on visits/referrals that these bugs can silently corrupt.

---

## Prerequisites

Node.js 18+ (this project was built with v24 via nvm).

> **Note:** Node is installed via **nvm** on this machine. If `node` isn't found in a new
> terminal, run `nvm use 24` first (or add `nvm use 24` to your shell profile).

---

## Run it locally

Open **two terminals**.

### 1. Backend (API on http://localhost:4000)

```bash
cd server
npm install          # first time only
npm run seed         # runs migrations + imports the Excel file (first time only)
npm run dev          # starts the API with auto-reload
```

### 2. Frontend (app on http://localhost:5173)

```bash
cd client
npm install          # first time only
cp .env.example .env # first time only — set VITE_MAPBOX_TOKEN (see below)
npm run dev
```

> The route planner's "enter address manually" box (`components/ui/AddressAutocomplete.jsx`)
> needs a free Mapbox access token in `client/.env` (`VITE_MAPBOX_TOKEN`) to power its live
> address suggestions. Without one, that box shows a small inline notice instead of failing
> silently — everything else in the app works fine either way.

Then open **http://localhost:5173**.

> The Vite dev server proxies `/api` to the backend on port 4000, so you only ever
> open the one URL in your browser.

---

## Backend scripts (`server/`)

| Command | What it does |
| --- | --- |
| `npm run migrate` | Create/upgrade the database schema |
| `npm run import` | Import places from the Excel file (idempotent upsert) |
| `npm run import:notes` | Import historical referrer notes (idempotent) |
| `npm run geocode` | Backfill lat/lng for every place without a `geocoded_at` yet (idempotent) |
| `npm run seed` | `migrate` + `import` + `import:notes` |
| `npm run reset` | Drop everything and re-seed from Excel |
| `npm run dev` | Start API with `--watch` auto-reload |
| `npm run start` | Start API (production style) |

Import a different workbook: `node src/scripts/import-excel.js "/path/to/file.xlsx"`

---

## API overview

All routes below require an `Authorization: Bearer <token>` header (obtained via
`/api/auth/login`) except where noted.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/auth/users` | Login picker (name + whether a password is set) — no auth |
| POST | `/api/auth/set-password` · `/api/auth/login` | First-time password / login — no auth |
| GET | `/api/auth/me` | Restore a session from a saved token |
| POST | `/api/auth/change-password` · `/api/auth/logout` | Account actions |
| GET | `/api/users` · POST `/api/users` | Team members |
| GET | `/api/places` | List/search/filter (`search, category, tier, city, zip, neverVisited, needsAttention`) — includes each place's `referral_metrics` (`lifetime_referrals, last_referral_date, referrals_last_90_days, needs_attention`) and a preview contact |
| GET | `/api/places/:id` | Place + full visit history + people (each with its own `referral_metrics`) + the place's own rolled-up `referral_metrics` |
| GET | `/api/places/meta/filters` | Distinct categories/cities/zips/tiers for dropdowns |
| POST | `/api/places` | Create a place |
| PATCH | `/api/places/:id` | Update a place's own fields (name, tier, notes, etc.) |
| DELETE | `/api/places/:id` | Delete the place only — people are detached (not deleted), visits preserved via a `place_name` snapshot |
| GET | `/api/people` | Cross-place directory (`search, placeId, category, neverContacted, needsAttention`) |
| GET | `/api/people/:id` | Person + place + full visit history + referrals + `referral_metrics` |
| GET | `/api/places/:placeId/people` | A place's roster |
| POST | `/api/people` | Create a person (`place_id` optional — a person can be unassigned) |
| PATCH | `/api/people/:id` | Update a person; `place_id: null` detaches without deleting |
| DELETE | `/api/people/:id` | Delete a person permanently (visits they were on stay, via snapshot fields) |
| POST | `/api/referrals` | Log a referral against a person |
| DELETE | `/api/referrals/:id` | Delete a referral |
| POST | `/api/schedule-drafts/generate` | Generate (or fetch, if one exists) a multi-day route-planner draft |
| GET | `/api/schedule-drafts/active` | The caller's current draft, fully recalculated |
| PATCH | `/api/schedule-drafts/:id/days/:date/reorder` | Reorder a day's draft stops |
| POST | `/api/schedule-drafts/:id/days/:date/stops` | Add a stop to a day |
| DELETE | `/api/schedule-drafts/:id/days/:date/stops/:placeId` | Remove a stop from a day |
| PATCH | `/api/schedule-drafts/:id/days/:date/stops/:placeId` | Change a stop's visit type |
| GET | `/api/schedule-drafts/:id/days/:date/suggestions` | Nearby eligible candidates for an under-budget day |
| POST | `/api/schedule-drafts/:id/days/:date/commit` | Commit one day's draft stops into real visits |
| POST | `/api/schedule-drafts/:id/commit` | Commit every remaining day |
| POST | `/api/visits` | Create an ad-hoc visit |
| PATCH | `/api/visits/:id` | Log/update a visit |
| POST | `/api/visits/:id/skip` | Skip a stop |
| DELETE | `/api/visits/:id` | Remove a stop |
| GET | `/api/dashboard?userId=&date=` | Dashboard rollups |
| GET | `/api/notes-review?status=` · `/api/notes-review/count` | "Needs Mapping" queue + badge count |
| POST | `/api/notes-review/:id/assign` · `/create-place` · `/dismiss` | Resolve an unmatched imported note |

---

## Deploying to the cloud (Railway / Heroku)

The database engine is chosen entirely in `server/knexfile.js`:

- **Local:** SQLite (`better-sqlite3`), file at `server/data/app.db`.
- **Production:** set `NODE_ENV=production` and `DATABASE_URL=postgres://…` — the app
  switches to PostgreSQL with **no query changes** (everything goes through Knex).

Everything needed is already in the repo:

- `pg` is installed in `server/`.
- Root `package.json` has `build` (installs both packages + builds the client) and `start`.
- `Procfile` runs `web: npm start` and, on each release, `release: npm run seed`
  (migrate + import against Postgres — idempotent).
- In production, Express serves `client/dist`, so **one service hosts API + UI**.

### Railway

1. New project → Deploy from repo. Add a **PostgreSQL** plugin (sets `DATABASE_URL`).
2. Add a variable `NODE_ENV=production`.
3. Railway builds with `npm run build` and starts with `npm start`. The `Procfile`
   `release` step seeds the database. Done — open the generated URL.

### Heroku

```bash
heroku create guardian-angels-sales
heroku addons:create heroku-postgresql:essential-0
heroku config:set NODE_ENV=production
git push heroku main         # runs heroku-postbuild, then the Procfile release seeds the DB
```

> `heroku-postbuild` builds the client; the `release` phase runs migrations + import.
> If you'd rather not import on every release, remove `npm run import` from the
> `Procfile` release line and run it once with `heroku run npm run import`.

---

## Data model

- **users** — team members (`id, name, email, password_hash, auth_token`).
- **places** — referral places (`tier, is_priority, priority_score, address, city, zip, region, phone, notes, lat, lng, geocoded_at, …`). `lat`/`lng` are resolved automatically from the address (see Geocoding above) and `geocoded_at` tracks when that last happened, so the backfill script knows what's left to do. Deleting a place only deletes the place row.
- **people** — individual contacts (`place_id` nullable, `name, title, role_type, email, phone, preferences, notes, birthday, departed, is_primary`). `place_id` is `ON DELETE SET NULL` — a person survives their place being deleted, and can be detached/reassigned freely. (No `relationship_temp` column anymore — see referrals below.)
- **visits** — one planned/completed/skipped call by a user on a place for a date,
  with `sort_order` (route order), outcome, notes, `next_visit_date`, and snapshot fields (`place_name`, `person_name/title/email/phone`) so history stays readable even after the live place/person record is gone. `place_id`/`person_id` are `ON DELETE SET NULL`.
- **referrals** — one referral, attributed to a `person_id` and a `place_id` snapshot (both `ON DELETE SET NULL` — a referral outlives the person/place it came from, orphaned but preserved as history), with `referral_date` and `notes`. Nothing about "relationship strength" is stored: `server/src/services/referralMetrics.js` derives lifetime count / last referral date / last-90-days count / a `needs_attention` flag live from this table for both people and places, on every read — this is the entire replacement for the old manual `relationship_temp` field.
- **notes_review** — "needs mapping" bucket for imported notes whose referrer didn't auto-match a place.
