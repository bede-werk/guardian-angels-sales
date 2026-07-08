# Guardian Angels Sales Scheduler — Project Handoff

_Last updated: 2026-07-08_

This document is a self-contained context dump so work can resume in a new session.
It summarizes what was built, key decisions, how to run it, the Railway deploy saga,
current state, and next steps.

---

## 0. Start here (note to self, written 2026-07-08)

If you're picking this project back up cold, read this section first — it'll reorient you
faster than the full doc below.

**What this app is, in one line:** a CRM-ish tool for Guardian Angels Homecare's sales team
to plan visits to referral places, log who they talked to, and track referrals — built this
year in a series of same-day feature sessions directly with Bede (the owner/primary user).

**Where things stand right now:**
- The last full session (2026-07-08) built, in order: Places CRUD, a People tab (renamed
  from "contacts"), phone-number formatting, detach-not-delete semantics for places/people/
  visits (see §8), a full person-attributed referral system (see §8), and a computed
  "suggested relationship temperature" feature (see §9). All of it is implemented, smoke-
  tested against the real dev DB, and working.
- **None of it is committed.** Run `git status` before doing anything else — every file
  touched this session is still sitting as uncommitted changes/untracked files on `main`.
  Don't assume section 13's snapshot is still accurate; re-check.
- Don't start new feature work without first asking Bede whether to commit the pending
  changes — he explicitly only wants commits when asked for.

**Mental model you need before touching this codebase:**
1. **Detach, don't delete.** Places, people, and visits are designed so deleting one thing
   never destroys another's history. If you're tempted to `CASCADE` a foreign key, stop and
   re-read §8 — that's almost certainly the wrong call here.
2. **Referrals belong to a person, never a place.** A place's referral total is *always*
   derived live (sum of its current roster's own counts), never stored. If you see a bug
   where a place's total doesn't match expectations, check who's currently assigned there
   first, not the referrals table's own `place_id`-shaped assumptions (there is no
   `place_id` on referrals).
3. **Suggested-but-not-applied is the house style for "smart" fields.** Relationship
   temperature works this way (§9) — compute a suggestion, show it next to the manual
   value, let the user opt in with a button, never silently overwrite. Follow this pattern
   for anything else "smart" Bede asks for later.
4. **SQLite migrations in this repo need care**, not `.alter()`. Adding/changing a FK on an
   existing column with `.alter()` leaves duplicate FKs, and index names collide
   database-wide across rebuild attempts. Use the `rebuildSqliteTable`-style rebuild
   pattern already established in `20260709000000_detach_instead_of_cascade.js` (temp table
   → copy via raw INSERT SELECT → drop → rename, explicit index names, defensive
   `DROP INDEX IF EXISTS`) rather than reinventing it.
5. **Smoke-test safely** (§10) — passwordless user Lisa Marks (id 5) for temp auth tokens,
   `__SMOKETEST_`/`__E2E_` prefixes, clean up after, and never touch Bede's own real test
   data (place 264 "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar
   Jr.). Never set a password on a real user's account to get a token — that happened once
   this project and it was a mistake (see §10).

**Natural next steps Bede has flagged but not yet asked for** (don't just do these — check
first): extending the relationship-temp suggestion to the People tab/Dashboard/Today's
Route, a Phase 2 referral-activity factor for relationship temp, committing/pushing this
session's work, finishing the remaining Needs Mapping referrers.

**If something in this note contradicts the actual code** (a file's gone, a function's
renamed), trust the code — this note is a snapshot from one point in time, not a live source
of truth. Update it once you've re-verified, the same way this section itself was written.

---

## 1. What this is

A full-stack **sales visit scheduling app** for **Guardian Angels Homecare** (Lincoln, NE).
It helps a small team plan and log referral-place sales visits, and it holds 2 years of
historical notes as place history.

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
├── Guardian Angels Sales List.xlsx   # place source data (sheet "📋 Visit Tracker", header row 2)
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
│       ├── middleware/               # requireAuth (bearer token)
│       ├── migrations/               # init, notes_import, add_auth, places_and_people,
│       │                             # rename_partners_to_places, people_and_place_notes,
│       │                             # detach_instead_of_cascade
│       ├── services/
│       │   ├── priority.js           # priority score + region ("side of town") helpers
│       │   ├── scheduler.js          # daily route generator
│       │   ├── auth.js               # password hashing / token helpers
│       │   ├── phone.js              # phone validation + (402) 555-1234 normalization
│       │   └── relationshipTemp.js   # suggested relationship-temperature decay model
│       ├── routes/                   # auth, places, people, referrals, visits, schedule,
│       │                             # dashboard, users, notesReview
│       └── scripts/
│           ├── import-excel.js       # importPlaces() — place list
│           └── import-notes.js       # importNotes() — historical notes
└── client/
    ├── vite.config.js                # dev proxy /api -> :4000
    └── src/
        ├── App.jsx                   # tabs: Dashboard, Today's Route, Places, People, Needs Mapping
        ├── api.js
        ├── styles.css
        └── components/
            ├── Login.jsx, ChangePassword.jsx
            ├── Dashboard.jsx, Schedule.jsx
            ├── Places.jsx, PlaceDetail.jsx, PlaceModal.jsx
            ├── People.jsx, PersonDetail.jsx, PersonModal.jsx, AssignPersonModal.jsx
            ├── ReferralModal.jsx
            ├── VisitLogModal.jsx, NeedsMapping.jsx
            └── ui/                    # Button, Chip, EmptyState, PhoneInput, TemperatureDot, ...
```

---

## 4. Data model (tables)

- **users** — team members (`id, name, email, password_hash, auth_token`). Current: **Bede
  Fulton, Nikki Shasserre, Lisa Marks, Basil Fulton**. Auth is a simple bearer token stored
  directly on the user row (`server/src/routes/auth.js` + `services/auth.js`).
- **places** — referral organizations (`name, category, tier 1/2/3, is_priority,
  priority_score, address, city, state, zip, region, phone, notes`). Originally imported from
  Excel (261 rows), now a full CRUD directory — add/edit/delete from the UI. Deleting a place
  deletes only that row; see section 8 for what happens to its people/visits.
- **people** — individual contacts (`place_id` nullable, `name, title, role_type, email,
  phone, relationship_temp, preferences, notes, birthday, departed, is_primary`). Renamed
  from "contacts" this session. A person doesn't have to belong to a place, mirroring how a
  place doesn't need a person on file.
- **visits** — one planned/completed/skipped touchpoint by a user on a place for a date.
  Fields: `status, sort_order, outcome, notes, next_visit_date, source, completed_at`, plus
  **snapshot fields** (`place_name`, `person_name/title/email/phone`) captured at creation time
  so a visit's history stays fully readable even after the live place/person is deleted.
  `source` = `manual` (in-app) or `imported_note` (from the notes spreadsheet).
- **referrals** — one referral, always attributed to a `person_id` (cascade-deletes with the
  person, since a referral has no meaning detached from who sent it), with `referral_date` and
  `notes`. A place's referral total is never stored — it's computed live as the sum of its
  *currently assigned* people's own counts (see section 8).
- **notes_review** — "needs mapping" bucket: imported notes whose referrer didn't match a
  place (`referrer_raw, note_text, note_date, author_*, status, assigned_*`).

---

## 5. Key features (all built & working)

- **Auth** — pick your name, set a password on first use, bearer token thereafter. All
  `/api` routes except the login flow require `requireAuth`.
- **Import places** from Excel (idempotent upsert). Normalizes category typos
  (`Legal and Trust`→`Legal & Trust`, `Senior Adisors`→`Senior Advisors`).
- **Daily schedule generator** — fills ~4 hrs (30 min visit + 15 min travel ≈ 5 stops),
  seeds on highest-priority place, clusters by region/zip, orders by priority. Manual
  reorder (drag-and-drop + up/down arrows), skip, remove.
- **Visit logging** — outcome (interested / not_ready / follow_up / no_answer), notes,
  key contact (name/title/email/phone), next visit date. Phone numbers are normalized to
  `(402) 555-1234` at every entry point (`services/phone.js` + `ui/PhoneInput.jsx`).
- **Places tab** — full CRUD directory: search + filter (category, tier, city, zip,
  never-visited); each row shows last **completed** visit, a preview contact, and the
  place's live referral tally (Contact column was removed once phone/email moved into
  PlaceDetail itself).
- **People tab** — cross-place directory of every person, independent of place assignment;
  filter by place, category, relationship temp, never-contacted.
- **Place detail** — org-level notes; "People here" roster showing name + referral count +
  relationship temp (+ suggested temp hint) per person; **Assign person** (attach an
  existing/unassigned person) vs **New person** (create one for this place) vs detach
  (✕, removes from place without deleting); **Log a referral** and **Log a visit** live in
  the Referrals/Visit History sections respectively, not a generic modal footer.
- **Person detail** — phone/email shown as real text (not just Call/Email buttons); place
  assignment with "remove from place" / "assign to a place"; durable notes/preferences;
  referral log + count + "Log a referral"; full visit history; relationship-temp suggestion
  with a one-click "Use this" apply button.
- **Referrals** — always logged against a specific person (no "unknown contact" concept — an
  earlier draft had one, replaced per the user's revision — see section 8).
- **Relationship temperature suggestion** — Phase 1 (recency-vs-cadence decay); see section
  9. Manual value is the source of truth; the suggestion is only ever surfaced, never
  auto-applied.
- **Dashboard** — today's route, visits completed this week, high-priority never-visited.
- **Multi-user** — visits assigned to a team member; routes/dashboards are per-user;
  scheduler avoids double-booking a place across reps on the same day.
- **Historical notes import + "Needs Mapping" tab** — see section 7.

### Priority scoring (see `services/priority.js`)
`Tier 1 + ⭐ Priority` = 35 · `Tier 1` = 30 · `Tier 2` = 20 · `Tier 3` = 10. Higher = sooner.

---

## 6. Key decisions & conventions

- **Knex everywhere** so SQLite→Postgres is a config swap only.
- **Dates stored as `'YYYY-MM-DD'` strings** for SQLite/Postgres parity.
- **"Visited" = has a *completed* visit.** Last-visit-date and "never visited" ignore
  merely-planned visits.
- **Notes are stored as visits** (one unified history timeline per place), marked
  `source='imported_note'`, rather than a separate notes concept.
- **User asked (design decisions):** only import notes whose referrer cleanly matches a
  place; park everything else (including individual people's names) in a review bucket
  to map by hand — do **not** auto-create places.
- Note author `"Nicole Shasserre"` in the sheet maps to the user **"Nikki Shasserre"**.
- **Detach, don't cascade-delete** (see section 8) — this is the single biggest schema
  decision made this session and touches places, people, visits, and referrals.
- **A referral's "owner" is a person, full stop.** No place-only/unattributed referral
  concept — the user explicitly asked for that to be removed after an earlier draft
  included it. A place's total is *derived*, never stored, from its current roster.
- **Suggested values are additive, never destructive** — same pattern used for relationship
  temperature: compute and display a suggestion, let the user apply it deliberately, never
  overwrite the manual field automatically. Apply this pattern to any future "smart
  suggestion" feature.

---

## 7. Historical notes import (ReferrerNotes.xlsx)

343 note rows, authors: Nikki (237), Bede (81), Lisa (25). Run via `npm run import:notes`
(idempotent). Latest result:
- **226 notes** matched a place → imported as completed history visits (attributed to author).
- **110 notes / 77 referrers** unmatched → **Needs Mapping** tab.
- 3 duplicate + 4 blank-referrer rows skipped.

**Needs Mapping tab** (with count badge): each unmatched referrer grouped with its notes.
Per referrer you can **assign to an existing place** (searchable picker), **create a new
place**, or **set aside** — action applies to all of that referrer's notes. Assigning
converts the note(s) into visits on the chosen place.

---

## 8. Detach-not-delete + the referral model

This was the biggest schema/behavior change this session, driven by the user wanting to
never lose history when a place or person is removed.

- **Delete a place** → the place row is gone; everyone who was there gets `place_id = null`
  (detached, not deleted — `ON DELETE SET NULL`); every visit logged there survives, with
  `visits.place_name` snapshotted at creation time so it still reads correctly even though
  the live place is gone.
- **Delete a person** → same idea: their visits survive via `visits.person_name/title/
  email/phone` snapshots.
- **Remove a person from a place** (without deleting them) → `PATCH /api/people/:id` with
  `place_id: null`. Available both from PlaceDetail's roster (✕ button) and PersonDetail's
  own "Remove from place" button.
- **A person doesn't need a place, and a place doesn't need a person** — creating either
  never requires the other.
- **PlaceDetail's two "add a person" actions are deliberately different**: **Assign person**
  (`AssignPersonModal.jsx`) picks from existing/unassigned people and attaches them;
  **New person** creates a brand-new record for this place. (Originally both called "Add
  person" — renamed to "Assign person" partway through per the user's request, along with
  the component/handler naming.)
- **Referrals belong to a person, not a place.** `POST /api/referrals` always takes a
  `person_id`. An earlier draft of this feature let a referral be logged with no contact
  ("unknown contact / attribute to location only") and rolled that into the place's total —
  the user later asked for that concept to be removed entirely, so every referral is now
  always attributed to a specific person, full stop.
- **A place's referral total is always computed live**, not stored: `GET /api/places/:id`
  sums `referral_count` across the people *currently* assigned there
  (`server/src/routes/places.js`'s `peopleWithCounts`/`referral_total`). Remove someone from
  the place and the total drops immediately, even though their own referral count (visible on
  their own PersonDetail) is untouched. The same live-sum logic is precomputed per-place in
  the `GET /api/places` list query so the directory table can show it without N+1 requests.
- Referral UI lives in two places: **PlaceDetail** (tally badge up top next to
  category/tier, "Log a referral" button next to Navigate/Call — moved there from a less
  prominent spot per the user's request) and **PersonDetail** (its own referral log + count
  + "Log a referral" button).

---

## 9. Relationship temperature: manual + suggested (Phase 1)

`relationship_temp` (`hot > warm > cold > dormant`) has always been a manual field on
`people`. This session added a **server-computed suggestion** alongside it — the manual
value stays the single source of truth; the suggestion is only ever displayed, never
auto-applied.

- **Logic:** `server/src/services/relationshipTemp.js`. `TARGET_CADENCE_DAYS` per place tier
  (`{1: 30, 2: 60, 3: 90}`). Compares days-since-last-*completed*-visit-at-that-place against
  the cadence: on-cadence → holds; past 1× → suggest one step cooler; past 2× (or never
  visited) → suggest `dormant`. The decay steps from the person's *current* manual value
  (not an independent absolute scale), and is intentionally structured (`recencyDecaySteps`
  as its own function, `suggestRelationshipTemp` composing it) so a second factor — referral
  activity — can be added later without reworking the shape.
- **Wired into:** `GET /api/people/:id` (uses the person's place's last completed visit) and
  `GET /api/places/:id` (computed per-person in the roster, reusing the visits already
  fetched for the place — no extra query). **Not** wired into the People-tab directory list,
  Dashboard, or Today's Route — those would need extra per-row queries; a natural follow-up
  if the user wants it everywhere.
- **UI:** shown only when the suggestion differs from the manual value (`tempDiffers` in both
  `PersonDetail.jsx` and `PlaceDetail.jsx`). PersonDetail gets a full "Suggested: X" badge +
  "Use this" button (PATCHes `relationship_temp` to match). PlaceDetail's roster rows get a
  compact "→ cold" style hint instead, since space is tighter there.

---

## 10. Smoke-testing methodology (worth knowing before you test again)

Schema changes this session (detach semantics, referrals, relationship temp) were all
verified with live HTTP calls against the running dev server, not just unit-level DB checks.
Conventions used, worth keeping:

- **Never use the real user's password to get a token.** Early on, a temp password was set
  on the real "Bede Fulton" account to get a bearer token for curl — this overwrote the real
  password hash without asking first. It was disclosed immediately and fixed by clearing
  `password_hash` back to `null` (first-time-setup state) rather than keeping the temp
  password. **Don't repeat this.**
- Instead, use a passwordless seeded user (**Lisa Marks, id 5**) — set a temporary
  `auth_token` directly in the DB for the test, and always clear it back to `null` afterward.
- Test data is always prefixed distinctly (`__E2E_`, `__SMOKETEST_`) and cleaned up by that
  prefix immediately after verification.
- Never touch the user's own real records while testing — in particular, place id 264
  ("Guardian Angels (Test)") and people "Lionel Messi" / "Mohamed Salah" / "Neymar Jr." are
  the user's own manually-created test data, not fixtures to delete.
- Deleting a person before deleting a visit they're on will `SET NULL` the visit's
  `person_id` before a second delete-by-`person_id` can match it — clean up visits by a
  distinctive `place_name`/snapshot field instead if you hit this.

---

## 11. How to run locally

Two terminals (or `./dev.sh` for both). Node is via nvm — run `nvm use 24` if needed.

```bash
# Terminal 1 — API on http://localhost:4000
cd ~/guardian-angels-sales/server
npm install            # first time
npm run seed           # first time: migrate + import places + import notes
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
| `npm run import` | Import places (idempotent) |
| `npm run import:notes` | Import historical notes (idempotent) |
| `npm run seed` | migrate + import + import:notes |
| `npm run reset` | Drop all + re-seed |
| `npm run dev` / `npm run start` | Run API |

---

## 12. Deployment (Railway) — what we learned

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

## 13. Current state (as of this handoff)

- **Auth shipped:** the "add authentication before sharing the URL" item from the previous
  handoff is done — bearer-token login is live and required on all `/api` routes except the
  login flow itself.
- **Git:** current branch `main`, clean-ish history through `22f2a87` (merge of the visual
  redesign / places-rename work). **Everything described in sections 4–10 above (people/place
  rework, detach semantics, referrals, phone formatting, relationship-temp suggestion) is
  present in the working tree but not yet committed** — check `git status` before assuming
  it's pushed. New/modified files include `server/src/routes/referrals.js`,
  `server/src/services/relationshipTemp.js`,
  `server/src/migrations/20260709000000_detach_instead_of_cascade.js`,
  `client/src/components/AssignPersonModal.jsx`, `client/src/components/ReferralModal.jsx`,
  plus edits across `PlaceDetail.jsx`, `PersonDetail.jsx`, `Places.jsx`, `People.jsx`,
  `PersonModal.jsx`, `api.js`, `people.js`, `places.js`, `visits.js`, `scheduler.js`,
  `index.js`.
- **Live deploy:** the Railway deployment was taken down after the previous handoff to avoid
  ongoing cost while still building — all dev happens locally via `./dev.sh` or the two
  npm-run-dev terminals. Redeploying later is still ~5 min (New → GitHub Repo → add Postgres
  → set `NODE_ENV`/`DATABASE_URL` → generate domain; it self-seeds).

---

## 14. Next steps / ideas (not yet done)

- **Commit and push the current working-tree changes** (see section 13) — nothing from this
  session has been committed yet.
- **Relationship-temp suggestion coverage:** currently only on PersonDetail/PlaceDetail.
  Extending it to the People-tab directory list, Dashboard, or Today's Route would need
  per-row query work — a natural follow-up if wanted everywhere.
- **Phase 2 of relationship temp:** fold in referral-activity as a second decay factor (the
  service was structured to make this additive).
- **Finish mapping** the remaining unmatched referrers in the Needs Mapping tab.
- **Postgres backups** once real data accumulates (Railway backups or `pg_dump`), if/when
  redeployed.
- **Dev workflow:** consider working on branches and only merging to `main` when you want the
  live site to redeploy (every push to `main` auto-deploys), once redeployed.
- Set a **spend cap** in Railway billing as a safety net, once redeployed.
- Possible enhancements: custom domain, richer reporting/exports, map view for routes,
  email/calendar integration.

---

## 15. Quick "resume tomorrow" checklist

1. Open the folder: `code ~/guardian-angels-sales`
2. Ensure Node: `nvm use 24` (or rely on `./dev.sh`)
3. Start it: `cd ~/guardian-angels-sales && ./dev.sh` → open http://localhost:5173
4. Check `git status` — this session's work is uncommitted; decide whether to commit before
   starting anything new.
