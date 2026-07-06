# Guardian Angels Homecare — Sales Visit Scheduler

A full-stack app for planning and logging referral-partner sales visits around Lincoln, NE.

- **Backend:** Node.js + Express + Knex, SQLite locally (swap to PostgreSQL for the cloud with no query changes)
- **Frontend:** React + Vite
- **Data:** imported from `Guardian Angels Sales List.xlsx` (sheet `📋 Visit Tracker`, ~261 partners)

## Features

- **Import** the Excel partner list into the database (idempotent — safe to re-run).
- **Daily schedule generator** — auto-picks ~4 hours of visits (30 min each + travel), clustered by side-of-town / zip and ordered by priority. Manually reorder, skip, or remove stops.
- **Visit logging** — notes, key contact (name / title / email / phone), outcome (interested / not ready / follow up / no answer), and next visit date.
- **Partner directory** — search & filter by category, tier, city, zip; shows last (completed) visit and latest contact.
- **Dashboard** — today's route, visits completed this week, and high-priority partners never visited.
- **Multi-user ready** — visits are assigned to a team member; the schema supports adding more reps later.

### Priority scoring

`Tier 1 + ⭐ Priority` (35) > `Tier 1` (30) > `Tier 2` (20) > `Tier 3` (10). Higher score = visited sooner.

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
npm run dev
```

Then open **http://localhost:5173**.

> The Vite dev server proxies `/api` to the backend on port 4000, so you only ever
> open the one URL in your browser.

---

## Backend scripts (`server/`)

| Command | What it does |
| --- | --- |
| `npm run migrate` | Create/upgrade the database schema |
| `npm run import` | Import partners from the Excel file (idempotent upsert) |
| `npm run seed` | `migrate` + `import` |
| `npm run reset` | Drop everything and re-seed from Excel |
| `npm run dev` | Start API with `--watch` auto-reload |
| `npm run start` | Start API (production style) |

Import a different workbook: `node src/scripts/import-excel.js "/path/to/file.xlsx"`

---

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/users` · POST `/api/users` | Team members |
| GET | `/api/partners` | List/search/filter (`search, category, tier, city, zip, neverVisited`) |
| GET | `/api/partners/:id` | Partner + full visit history |
| GET | `/api/partners/meta/filters` | Distinct categories/cities/zips/tiers for dropdowns |
| GET | `/api/schedule?date=&userId=` | A day's route |
| POST | `/api/schedule/generate` | Build a clustered, priority-ordered route |
| PATCH | `/api/schedule/reorder` | Persist a manual reorder (`orderedVisitIds`) |
| POST | `/api/visits` | Create an ad-hoc visit |
| PATCH | `/api/visits/:id` | Log/update a visit |
| POST | `/api/visits/:id/skip` | Skip a stop |
| DELETE | `/api/visits/:id` | Remove a stop |
| GET | `/api/dashboard?userId=&date=` | Dashboard rollups |

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

- **users** — team members (`id, name, email`).
- **partners** — imported referral partners (`tier, is_priority, priority_score, address, city, zip, region, …`).
- **visits** — one planned/completed/skipped call by a user on a partner for a date,
  with `sort_order` (route order), outcome, notes, contact fields, and `next_visit_date`.
