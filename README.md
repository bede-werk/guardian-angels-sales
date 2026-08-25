# Guardian Angels Homecare - Sales Visit Scheduler

A full-stack app for planning and logging referral-place sales visits around Lincoln, NE.

- **Backend:** Node.js + Express + Knex, SQLite locally (swap to PostgreSQL for the cloud with no query changes)
- **Frontend:** React + Vite
- **Data:** imported from `Guardian Angels Sales List.xlsx` (sheet `📋 Visit Tracker`, ~263 places)
- **Tests:** 561 unit tests (`cd server && npm test`)

---

## The screens

Six tabs, plus a Settings page behind the ⚙ in the header.

- **Dashboard** - five live cards: today's route (count, first/next stop, drive-time estimate, a Navigate button that hands the day to Google Maps), the ISO week day-by-day, outstanding commitments (overdue + the next N days), recent referrals, and top referral partners. Cards 1-2 are scoped to the logged-in rep; commitments and referrals are org-wide facts and deliberately are not. The dashboard is a full editing surface, not a read-only summary - rows open the real detail modals.
- **Route Planner** - generates a multi-day draft of proposed visits from a four-tier priority model (commitment > endangered > exploration > maintenance), sequenced by real driving routes (OSRM) within a daily time budget. Live-editable (reorder, add, remove, change visit type, re-optimize, pick a different zone for a day) with in-place time/budget recalculation, plus a "suggest a stop" prompt on under-budget days. Commit a day (or everything remaining) to turn proposed stops into real visits; committed days can be reopened or undone. Multi-user collision protection stops two reps being double-booked into the same place on the same day.
- **Calendar** - a month grid of every visit, toggleable between "mine" and "all reps", with 🎂 birthday badges on the days contacts have one.
- **Visits** - search, filter and paginate over every visit ever recorded, across every status. This is the only screen that surfaces snoozed and skipped visits.
- **Places** - the place directory. Search and filter by category, computed capacity level, all-star, unrated, and region; sort by name, last visit, my last visit, referral count, or last referral. Full CRUD, inline place creation from other forms, and each row shows its last completed visit, a preview contact, and the place's live referral tally.
- **People** - a cross-place directory of every individual contact, independent of place assignment (a person doesn't need a place, and a place doesn't need a person). Search, filter by place and category, and the same sort options as Places.
- **Settings (⚙)** - every tunable constant in the scheduling model, editable and explained, in eight sections: Visit Cadence, Capacity, Relationship Strength, Visit Types and Time, Drive Time Estimates, Route Planner, Referrals, Dashboard. Three layers: `config/*.js` ships the defaults, the `settings` table stores only what's been changed, and `config/tunables.js` says what each one means and what values are legal. See `SETTINGS_PAGE.md`.

---

## How the app decides where to go

Nothing about a place's importance is a manual field you have to remember to update. Two computed axes drive the schedule, and each has a clearly-flagged manual override.

**Capacity** (`server/src/services/capacity.js`) - how many homecare referrals a place sends per month, *to anyone*, excluding whatever their own in-house service absorbs. Potential, not realized: "how much they could send," not "how much they send us." Resolved from a ladder of a rep's capacity rating, their own pre-qualification answer, our measured referral throughput, and a category-based guess, then bucketed **low / medium / high** (medium starts at 4/mo, high at 11/mo - both editable in Settings). The core invariant: measurement may only ever *raise* the number, never lower it - our own volume proves a floor, but zero volume from us proves nothing about what they send elsewhere. See `capacity-computation-spec.md`.

**Relationship strength** (`server/src/services/relationship.js`) - measured at the *person* level and rolled up to the place, from what actually happened on visits (who was met, what the outcome was), decaying over time. Bucketed **weak / medium / strong**. Deliberately not driven by referral *volume* - that's capacity's job, and if both axes read the same signal they collapse into one and the most valuable cell of the cadence table (high capacity + weak relationship) empties out by construction.

The two axes index a 3×3 **cadence table** - how many days should pass between visits - guarded by a hard floor between visits, a fatigue stretch for places visited too often lately, and an overdue rescue multiplier. On top of that, the ranker sorts candidates into four tiers:

| Tier | What it means |
| --- | --- |
| **Commitment** | You promised to come back on a date. Ranked by how overdue that promise is. |
| **Endangered** | Past its cadence and getting worse. |
| **Exploration** | Never pre-qualified - we don't know what this place is worth yet. Ages upward so a place can't starve in this tier forever. |
| **Maintenance** | Everything else, by urgency. |

**All-star** (`places.is_all_star`) is a third input, not a third dimension: a scarce flag for the ~25 places that matter most, with the live count shown wherever it's set so it can't quietly drift into meaninglessness the way the old ⭐ Priority flag did.

> Retired: `tier`, `is_priority`, `priority_score`, `capacity_level`, `capacity_status`, `capacity_monthly_referrals` and `relationship_level` were all dropped from `places` on 2026-08-25 (migration `20260825000000`). Every one was a manual field replaced by a computed one. Don't reintroduce them.

---

## Other features

- **Auth** - simple bearer-token login (pick your name, set a password on first use). All `/api` routes except login require it.
- **Import** the Excel place list into the database (idempotent - safe to re-run).
- **Place detail** - editable org-level fields, click-to-edit notes, a "People here" roster with each person's own referral metrics, an **Assign person** picker vs **New person**, detach-without-deleting, **Log a referral** / **Log a visit**, an Upcoming Visits card (which is also where snooze and do-not-visit live), a Commitments card, and a capacity panel showing the observation history and why the computed number is what it is.
- **Person detail** - contact info, notes/preferences/birthday each independently click-to-edit, a referral log with lifetime / last-referral / last-90-days metrics, and full visit history that survives being detached from a place. Starting an edit on any one field automatically backs out of whichever other field is mid-edit, so you never end up with two unsaved drafts open at once.
- **Visits are trips, encounters are people** - one `visits` row is one trip to one place on one date; each person or category met on it is a `visit_encounters` row. A rep who met a named contact *and* got gatekept by the front desk logs one visit with two encounters. A still-planned trip has none yet.
- **Visit detail popup** - the trip's own facts (logged-by rep, notes, duration, promises made) plus every person met, each expandable in place for their own outcome, contact snapshot, and whether they asked for something. Edit opens the same visit-logging form pre-filled; Delete removes the whole trip.
- **Place commitments** - a dated promise to return, replacing the old `visits.next_visit_date`. A place can hold several outstanding promises at once; the one that binds the planner is whichever comes **due first**, not whichever was made first. Each ends in exactly one of *fulfilled*, *superseded* or *waived* - a date passing does **not** discharge a promise, by design: an unkept one stays outstanding and climbs in overdue-ness until a human resolves it.
- **Manual visit planning** - plan a real visit directly on a place and date without going through the generator, with hard blocks for genuine conflicts and overridable warnings for soft ones. The route planner *proposes*; it never lets a manually-planned visit's location steer its zone or routing (it does subtract that visit's duration from the day's budget).
- **Visit terminal states** - a planned visit whose date has passed is swept to `skipped` on read (there's no background-job infrastructure here, so it runs as router middleware). Snooze is the deliberate counterpart: push a visit out to a later date on purpose.
- **Do not visit** - a rep's deliberate "stop going here" mark on a place, either indefinite or with an until-date that lapses on its own. Enforced on every path that writes a visit (`server/src/services/doNotVisit.js`).
- **Geocoding** - every place's address is resolved to lat/lng via the US Census Bureau's free geocoder (no API key) whenever it's created or its address changes. `npm run geocode` backfills anything missing via the Census batch endpoint. Best-effort - a failed lookup never blocks saving a place. Currently **258 of 263** places have coordinates; the rest didn't match and need manual address review.
- **Detach, don't cascade-delete** - deleting a place only deletes the place: its people are unassigned (not deleted) and every visit logged there is preserved via a `place_name` snapshot. Deleting a person preserves their visit history the same way. People can be removed from a place, or reassigned, without losing any history.
- **Referral metrics - objective, no manual upkeep** - every person and place shows three numbers computed live from the `referrals` table on every read: lifetime count, most recent referral date, and referrals in the last 90 days. A person's metrics follow them if they move; a place's numbers are always the live roll-up of its *current* roster, so they drop immediately when someone's detached. A referral can be logged against a person who isn't at a place at all. See `server/src/services/referralMetrics.js`.
- **Categories** - a real database table with its own management modal, reachable from the place and person forms. Not free text, and not a hardcoded enum.
- **Phone normalization** - phone numbers are normalized to `(402) 555-1234` everywhere they're entered.
- **Multi-user** - visits are assigned to a team member, ownership is enforced on the write paths, and the double-booking races found in the 2026-08-22 audit are closed.

---

## Prerequisites

Node.js 18+ (this project was built with v24 via nvm).

> **Note:** Node is installed via **nvm** on this machine. If `node` isn't found in a new
> terminal, run `nvm use 24` first (or add `nvm use 24` to your shell profile).

---

## Run it locally

First time only:

```bash
cd server && npm install && npm run seed   # migrations + Excel import
cd ../client && npm install
cp .env.example .env                       # then set VITE_MAPBOX_TOKEN (see below)
```

Then, from the repo root, start both halves at once:

```bash
npm run dev        # runs ./dev.sh - backend on :4000, frontend on :5173, Ctrl+C stops both
```

`dev.sh` also puts nvm's Node on `PATH` itself, so it works from a non-login shell.

<details>
<summary>Or run them in two terminals</summary>

```bash
cd server && npm run dev     # API on http://localhost:4000
cd client && npm run dev     # app on http://localhost:5173
```
</details>

Then open **http://localhost:5173**. The Vite dev server proxies `/api` to the backend on
port 4000, so you only ever open the one URL in your browser.

> The route planner's "enter address manually" box (`components/ui/AddressAutocomplete.jsx`)
> needs a free Mapbox access token in `client/.env` (`VITE_MAPBOX_TOKEN`) to power its live
> address suggestions. Without one, that box shows a small inline notice instead of failing
> silently - everything else in the app works fine either way.

---

## Backend scripts (`server/`)

| Command | What it does |
| --- | --- |
| `npm run migrate` | Create/upgrade the database schema |
| `npm run rollback` | Roll back the last migration batch |
| `npm run import` | Import places from the Excel file (idempotent upsert) |
| `npm run geocode` | Backfill lat/lng for every place without a `geocoded_at` yet (idempotent) |
| `npm run seed` | `migrate` + `import` |
| `npm run reset` | Drop everything and re-seed from Excel |
| `npm test` | Run the unit test suite (561 tests) |
| `npm run relationship:distribution` | Print how the computed relationship levels spread across the real book |
| `npm run capacity:distribution` | Same, for computed capacity levels |
| `npm run dev` | Start API with `--watch` auto-reload |
| `npm run start` | Start API (production style) |

Import a different workbook: `node src/scripts/import-excel.js "/path/to/file.xlsx"`

---

## API overview

All routes require an `Authorization: Bearer <token>` header (obtained via
`/api/auth/login`) except where noted.

### Auth and users

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/auth/users` | Login picker (name + whether a password is set) - no auth |
| POST | `/api/auth/set-password` · `/api/auth/login` | First-time password / login - no auth |
| GET | `/api/auth/me` | Restore a session from a saved token |
| POST | `/api/auth/change-password` · `/api/auth/logout` | Account actions |
| GET · POST | `/api/users` | Team members (never returns `password_hash` or `auth_token`) |

### Places

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/places` | List/search/filter (`search, category, capacity, allStar, unrated, region, sort`) - includes each place's `referral_metrics`, computed capacity and relationship, last-visit dates and a preview contact |
| GET | `/api/places/:id` | Place + visit history + upcoming visits + roster (each with their own `referral_metrics`) + rolled-up `referral_metrics` + computed `relationship` + computed `capacity` + capacity observations + commitments (outstanding/discharged) |
| GET | `/api/places/meta/filters` | Categories in use, all categories, regions, capacity levels, rating choices and thresholds, all-star count vs target |
| GET | `/api/places/check-address` · `/api/places/check-duplicate` | Pre-save checks for the create/edit form |
| POST | `/api/places` | Create a place (geocoded on the way in; unrecognized addresses return `422 ADDRESS_UNRECOGNIZED` unless `confirm_address`) |
| PATCH | `/api/places/:id` | Update a place. `relationship_level_override` and `capacity_override_level` are handled separately from the plain fields, because setting one also stamps who did it and when |
| POST | `/api/places/rate-capacity` | Bulk capacity rating from the People/Places rater |
| POST · DELETE | `/api/places/:id/capacity-observations[/:observationId]` | Append to / remove from a place's capacity observation history |
| POST | `/api/places/:id/commitments` | Make a dated promise to return |
| POST | `/api/places/:id/commitments/:commitmentId/reschedule` · `/waive` | Supersede a promise with a new date, or call it off |
| DELETE | `/api/places/:id/commitments/:commitmentId` | Remove a commitment |
| DELETE | `/api/places/:id/snooze` | Clear a place-level snooze |
| DELETE | `/api/places/:id` | Delete the place only - people are detached (not deleted), visits preserved via a `place_name` snapshot |

### People and referrals

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/people` | Cross-place directory (`search, placeId, category, sort`) |
| GET | `/api/people/:id` | Person + place + visit history + referrals + `referral_metrics` + computed `relationship` |
| GET | `/api/people/birthdays` | Birthdays, for the Calendar tab's 🎂 badges |
| GET | `/api/people/check-duplicate` | Pre-save check for the create form |
| GET | `/api/places/:placeId/people` | A place's roster |
| POST | `/api/people` | Create a person (`place_id` optional - a person can be unassigned) |
| PATCH | `/api/people/:id` | Update a person; `place_id: null` detaches without deleting; `relationship_seed` sets the one-time relationship seed (decay clock stamped server-side) |
| POST | `/api/people/seed-relationships` | Bulk relationship seeding (`[{ person_id, seed }]`), all-or-nothing, re-runnable |
| DELETE | `/api/people/:id` | Delete a person permanently (visits they were on stay, via snapshot fields; their referrals are deleted in the same transaction rather than orphaned) |
| POST · PATCH · DELETE | `/api/referrals[/:id]` | Log, edit or delete a referral against a person |

### Visits

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/visits` | The Visits tab: search/filter/paginate (`search, status, from, to, userId, plannedBy, placeId, personId, category, capacity, region, visitType, outcome, metWith, theyRequested, origin, hasNotes, madeCommitment, sort, limit, offset`) |
| GET | `/api/visits/calendar?month=&userId=` | One month of visits for the Calendar grid |
| GET | `/api/visits/:id` | The full trip, every encounter included - the only call that returns per-encounter outcome/contact detail |
| POST | `/api/visits` | Create an ad-hoc visit (trip), optionally with an `encounters[]` array |
| POST | `/api/visits/manual` | Plan a real visit by hand. `201` created · `200 { warnings }` soft block, resend with `force: true` · `409 { conflicts }` hard block, no override |
| PATCH | `/api/visits/:id` | Log/update a trip's own fields; an `encounters[]` array upserts by id (an entry with an existing id updates it, one without inserts, any existing encounter missing from the array is deleted) |
| PATCH | `/api/visits/:id/edit` | Edit a planned visit's date/notes/type. Assignee only - narrower than delete, which the creator may also do |
| POST | `/api/visits/:id/snooze` | Push a planned visit out to a later date |
| DELETE | `/api/visits/:id/encounters/:encounterId` | Remove one person/category from a trip; deletes the trip too if it was the last encounter on a completed one |
| DELETE | `/api/visits/:id` | Delete the whole trip (its encounters cascade with it) |

### Route planner

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/schedule-drafts/generate` | Generate (or fetch, if one exists) a multi-day draft |
| GET | `/api/schedule-drafts/active` | The caller's current draft, fully recalculated |
| GET | `/api/schedule-drafts/committed-dates` | Dates this user already has real visits on, with a count each (the calendar disables them) |
| GET | `/api/schedule-drafts/committed-dates/:date/visits` | The visits behind one "Already Planned" day |
| DELETE | `/api/schedule-drafts/committed-dates/:date` | Undo a day's commit - removes still-planned visits only, never completed/skipped history |
| POST | `/api/schedule-drafts/days/:date/reopen` | Pull a committed day back into the draft for re-editing |
| PATCH | `/api/schedule-drafts/:id/days/:date/reorder` | Reorder a day's stops |
| POST · DELETE · PATCH | `/api/schedule-drafts/:id/days/:date/stops[/:placeId]` | Add a stop · remove one · change its visit type |
| POST | `/api/schedule-drafts/:id/days/:date/reoptimize` | Re-sequence a day's current stops via OSRM (adds/removes nothing) |
| GET · POST | `/api/schedule-drafts/:id/days/:date/zone[s]` | The "Somewhere else" zone list, and re-filling a day in a chosen zone |
| GET | `/api/schedule-drafts/:id/days/:date/suggestions` | Nearby eligible candidates for an under-budget day |
| POST | `/api/schedule-drafts/:id/days/:date/commit` · `/api/schedule-drafts/:id/commit` | Commit one day, or every remaining day, into real visits |
| DELETE | `/api/schedule-drafts/:id` · `/:id/days/:date` | Discard a whole draft, or one day of it |

### Dashboard, categories, settings

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dashboard?userId=&date=` | All five dashboard cards in one response |
| GET · POST · PATCH · DELETE | `/api/categories[/:id]` | Manage the category list |
| GET | `/api/settings` | Every tunable: its meaning, bounds, shipped default, value in effect, and who last changed it |
| GET | `/api/settings/values` | Just the current values (what the client reads) |
| PUT | `/api/settings` | Save overrides |
| POST | `/api/settings/reset` | Reset to shipped defaults |

---

## Deploying to the cloud (Railway / Heroku)

The database engine is chosen entirely in `server/knexfile.js`:

- **Local:** SQLite (`better-sqlite3`), file at `server/data/app.db`.
- **Production:** set `NODE_ENV=production` and `DATABASE_URL=postgres://…` - the app
  switches to PostgreSQL with **no query changes** (everything goes through Knex).

Everything needed is already in the repo:

- `pg` is installed in `server/`.
- Root `package.json` has `build` (installs both packages + builds the client) and `start`.
- `Procfile` runs `web: npm start` and, on each release, `release: npm run seed`
  (migrate + import against Postgres - idempotent).
- In production, Express serves `client/dist`, so **one service hosts API + UI**.

### Railway

1. New project → Deploy from repo. Add a **PostgreSQL** plugin (sets `DATABASE_URL`).
2. Add a variable `NODE_ENV=production`.
3. Railway builds with `npm run build` and starts with `npm start`. The `Procfile`
   `release` step seeds the database. Done - open the generated URL.

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

- **users** - team members (`id, name, email, password_hash, auth_token`).
- **places** - referral places (`name, category, address, city, state, zip, region, phone, notes, lat, lng, geocoded_at`), plus the judgment fields: `capacity_seed`/`capacity_seeded_at` (a rep's rating), `capacity_override_level`/`_reason`/`_at`, `relationship_level_override`/`_at`/`_by`, `is_all_star`, `exploration_eligible_since`, `snooze_until`, and `do_not_visit`/`do_not_visit_until`. `lat`/`lng` are resolved automatically from the address. Deleting a place only deletes the place row.
- **people** - individual contacts (`place_id` nullable, `name, title, email, phone, preferences, notes, birthday_month, birthday_day, relationship_seed, relationship_seeded_at`). `place_id` is `ON DELETE SET NULL` - a person survives their place being deleted, and can be detached or reassigned freely.
- **visits** - one planned/completed/skipped TRIP by a user to a place on a date, with `sort_order` (route order), `notes`, `visit_type`, `actual_duration_minutes`, `status`, `snoozed_until`, `resolved_at`, `source`, `planned_manually`, `planner_committed`, `created_by_user_id`, and a `place_name` snapshot so history stays readable even after the live place record is gone. `place_id` is `ON DELETE SET NULL`. Two partial unique indexes stop the same place being double-booked on the same date.
- **visit_encounters** - one row per person/category met on a trip (`visit_id` `ON DELETE CASCADE`, `person_id` `ON DELETE SET NULL`, `person_name/title/email/phone` snapshot, `met_with_type, outcome, they_requested`). A partial unique index stops the same person being recorded twice on one trip.
- **place_commitments** - a dated promise to return (`place_id, promised_date, person_id, note, source_visit_id, created_by_user_id`), discharged via `discharged_at` + `discharge_reason` (`fulfilled` / `superseded` / `waived`), with `superseded_by_id` chaining reschedules. Outstanding = `discharged_at IS NULL`.
- **capacity_observations** - the append-only history behind a computed capacity number (`place_id, monthly_referrals, source, observed_at, person_id, visit_id, note`). `person_id` is nullable so a place can still say "verified by Sharon" after Sharon's own record is gone.
- **referrals** - one referral, attributed to a `person_id` and a `place_id` snapshot (both `ON DELETE SET NULL`), with `referral_date` and `notes`. Nothing about relationship strength is stored here.
- **categories** - the canonical category list (`name`, unique).
- **settings** - only the tunables that have been changed from their shipped default (`key, value, updated_by, updated_at`).
- **schedule_drafts** / **schedule_draft_stops** - a rep's in-progress route plan before it's committed into real visits.

---

## Where the rest of the documentation lives

| File | What's in it |
| --- | --- |
| `HANDOFF.md` | The main project narrative - data model, decisions, conventions, and a dated section per major feature (§16 relationship, §17 encounters, §18 capacity, §19 terminal states, §20 manual planning, §21 settings, §22 Visits tab, §23-25 the capacity rating and column drops) |
| `NOTES.md` | Running log of audits, bug hunts and fixes |
| `UI_SPEC.md` | The living pattern catalog - buttons, chips, dismiss affordances, and the title rules. Check it before inventing a new one |
| `SETTINGS_PAGE.md` | The Settings page's three-layer architecture and its one rule: read tunables at call time, never at require time |
| `capacity-computation-spec.md` | The full capacity model, including the self-confirming-guess failure mode it exists to prevent |
| `ROUTEPLANNER_PROGRESS.md` | The route planner's design and build history |
