# Guardian Angels Sales Scheduler — Project Handoff

_Last updated: 2026-07-06_

This document is a self-contained context dump so work can resume in a new session.
It summarizes what was built, key decisions, how to run it, the Railway deploy saga,
current state, and next steps.

---

## 1. What this is

A full-stack **sales visit scheduling app** for **Guardian Angels Homecare** (Lincoln, NE).
It helps a small team plan and log referral-partner sales visits, and it holds 2 years of
historical notes as partner history.

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
├── Guardian Angels Sales List.xlsx   # partner source data (sheet "📋 Visit Tracker", header row 2)
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
│       ├── migrations/               # 20260706000000_init, 20260706010000_notes_import
│       ├── services/
│       │   ├── priority.js           # priority score + region ("side of town") helpers
│       │   └── scheduler.js          # daily route generator
│       ├── routes/                   # partners, visits, schedule, dashboard, users, notesReview
│       └── scripts/
│           ├── import-excel.js       # importPartners() — partner list
│           └── import-notes.js       # importNotes() — historical notes
└── client/
    ├── vite.config.js                # dev proxy /api -> :4000
    └── src/
        ├── App.jsx                   # tabs: Dashboard, Today's Route, Partners, Needs Mapping
        ├── api.js
        ├── styles.css
        └── components/               # Dashboard, Schedule, Partners, PartnerDetail,
                                      # VisitLogModal, NeedsMapping, Badges
```

---

## 4. Data model (tables)

- **users** — team members (`id, name, email`). Current: **Bede Fulton, Nikki Shasserre,
  Lisa Marks, Basil Fulton**. (Placeholder "Sales Rep" and test "Dana Fields" were removed.)
- **partners** — referral partners from the Excel (`name, category, tier 1/2/3, is_priority,
  priority_score, address, city, state, zip, region`). 261 rows.
- **visits** — one planned/completed/skipped touchpoint by a user on a partner for a date.
  Fields: `status, sort_order, outcome, notes, contact_*, next_visit_date, source, completed_at`.
  `source` = `manual` (in-app) or `imported_note` (from the notes spreadsheet).
- **notes_review** — "needs mapping" bucket: imported notes whose referrer didn't match a
  partner (`referrer_raw, note_text, note_date, author_*, status, assigned_*`).

---

## 5. Key features (all built & working)

- **Import partners** from Excel (idempotent upsert). Normalizes category typos
  (`Legal and Trust`→`Legal & Trust`, `Senior Adisors`→`Senior Advisors`).
- **Daily schedule generator** — fills ~4 hrs (30 min visit + 15 min travel ≈ 5 stops),
  seeds on highest-priority partner, clusters by region/zip, orders by priority. Manual
  reorder (drag-and-drop + up/down arrows), skip, remove.
- **Visit logging** — outcome (interested / not_ready / follow_up / no_answer), notes,
  key contact (name/title/email/phone), next visit date.
- **Partner directory** — search + filter (category, tier, city, zip, never-visited); shows
  last **completed** visit and latest contact.
- **Dashboard** — today's route, visits completed this week, high-priority never-visited.
- **Multi-user** — visits assigned to a team member; routes/dashboards are per-user;
  scheduler avoids double-booking a partner across reps on the same day.
- **Historical notes import + "Needs Mapping" tab** — see section 7.

### Priority scoring (see `services/priority.js`)
`Tier 1 + ⭐ Priority` = 35 · `Tier 1` = 30 · `Tier 2` = 20 · `Tier 3` = 10. Higher = sooner.

---

## 6. Key decisions & conventions

- **Knex everywhere** so SQLite→Postgres is a config swap only.
- **Dates stored as `'YYYY-MM-DD'` strings** for SQLite/Postgres parity.
- **"Visited" = has a *completed* visit.** Last-visit-date and "never visited" ignore
  merely-planned visits.
- **Notes are stored as visits** (one unified history timeline per partner), marked
  `source='imported_note'`, rather than a separate notes concept.
- **User asked (design decisions):** only import notes whose referrer cleanly matches a
  partner; park everything else (including individual people's names) in a review bucket
  to map by hand — do **not** auto-create partners.
- Note author `"Nicole Shasserre"` in the sheet maps to the user **"Nikki Shasserre"**.

---

## 7. Historical notes import (ReferrerNotes.xlsx)

343 note rows, authors: Nikki (237), Bede (81), Lisa (25). Run via `npm run import:notes`
(idempotent). Latest result:
- **226 notes** matched a partner → imported as completed history visits (attributed to author).
- **110 notes / 77 referrers** unmatched → **Needs Mapping** tab.
- 3 duplicate + 4 blank-referrer rows skipped.

**Needs Mapping tab** (with count badge): each unmatched referrer grouped with its notes.
Per referrer you can **assign to an existing partner** (searchable picker), **create a new
partner**, or **set aside** — action applies to all of that referrer's notes. Assigning
converts the note(s) into visits on the chosen partner.

---

## 8. How to run locally

Two terminals (or `./dev.sh` for both). Node is via nvm — run `nvm use 24` if needed.

```bash
# Terminal 1 — API on http://localhost:4000
cd ~/guardian-angels-sales/server
npm install            # first time
npm run seed           # first time: migrate + import partners + import notes
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
| `npm run import` | Import partners (idempotent) |
| `npm run import:notes` | Import historical notes (idempotent) |
| `npm run seed` | migrate + import + import:notes |
| `npm run reset` | Drop all + re-seed |
| `npm run dev` / `npm run start` | Run API |

---

## 9. Deployment (Railway) — what we learned

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

## 10. Current state (as of this handoff)

- **Code:** committed & pushed. Latest commits:
  - `c2ec9d6` Seed database on app startup instead of during build
  - `e8dc851` Import historical referrer notes + Needs Mapping, add railway.json
  - `73b1bba` Initial commit
- **Live deploy:** was successfully running at
  `https://guardian-angels-sales-production.up.railway.app/` (261 partners, notes seeded).
- **⏸️ Decision in progress:** the user is **taking the Railway deployment DOWN** to avoid
  ongoing cost while still building (all dev happens locally). Plan: delete the Railway
  project (app + Postgres). GitHub repo and local app are unaffected. Redeploy later is
  ~5 min (New → GitHub Repo → add Postgres → set the 2 vars → generate domain; it self-seeds).

---

## 11. Next steps / ideas (not yet done)

- **Authentication / login** — the app is currently public with real contact data. Add before
  sharing the URL widely. (High priority before "real" use.)
- **Finish mapping** the remaining unmatched referrers in the Needs Mapping tab.
- **Postgres backups** once real data accumulates (Railway backups or `pg_dump`).
- **Dev workflow:** consider working on branches and only merging to `main` when you want the
  live site to redeploy (every push to `main` auto-deploys).
- Set a **spend cap** in Railway billing as a safety net.
- Possible enhancements: custom domain, richer reporting/exports, map view for routes,
  email/calendar integration, editing partner details in the UI.

---

## 12. Quick "resume tomorrow" checklist

1. Open the folder: `code ~/guardian-angels-sales`
2. Ensure Node: `nvm use 24` (or rely on `./dev.sh`)
3. Start it: `cd ~/guardian-angels-sales && ./dev.sh` → open http://localhost:5173
4. Decide on: taking Railway down (if not done), then continue building features locally.
