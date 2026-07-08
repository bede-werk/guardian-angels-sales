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
- The 2026-07-08 CRM-buildout session (Places CRUD, People tab, detach-not-delete
  semantics, a person-attributed referral system, and a computed "suggested relationship
  temperature" feature) is **committed and merged to `main`** (PR #4, `2547bfb`).
- A same-day follow-up session then **removed relationship temperature entirely** and
  replaced it with objective, time-aware **referral metrics** computed live from the
  `referrals` table — no manual field, no upkeep. See §9 (rewritten) for the full design;
  §4/§5/§8 are updated to match.
- **The referral-metrics session is NOT yet committed.** Run `git status` before doing
  anything else. Touched: `server/src/services/referralMetrics.js` (new),
  `server/src/services/relationshipTemp.js` (deleted),
  `server/src/migrations/20260710000000_drop_relationship_temp.js` (new), edits across
  `routes/people.js`, `routes/places.js`, `routes/dashboard.js`, `services/scheduler.js`,
  `services/priority.js`, and the client (`api.js`, `styles.css`, `Dashboard.jsx`,
  `People.jsx`, `Places.jsx`, `PersonDetail.jsx`, `PersonModal.jsx`, `PlaceDetail.jsx`,
  `Schedule.jsx`), plus `ui/TemperatureDot.jsx` (deleted). Don't assume section 13's
  snapshot is still accurate by the time you read this — re-check.
- Don't start new feature work without first asking Bede whether to commit the pending
  changes — he explicitly only wants commits when asked for.

**Mental model you need before touching this codebase:**
1. **Detach, don't delete.** Places, people, and visits are designed so deleting one thing
   never destroys another's history. If you're tempted to `CASCADE` a foreign key, stop and
   re-read §8 — that's almost certainly the wrong call here.
2. **Referrals belong to a person, never a place.** A place's referral metrics are *always*
   derived live (rolled up from its current roster's own numbers), never stored. If you see
   a bug where a place's numbers don't match expectations, check who's currently assigned
   there first, not the referrals table's own `place_id`-shaped assumptions (`place_id` on
   `referrals` is just a historical snapshot, not the source of truth for a place's total).
3. **No more manual "smart" fields that need upkeep.** The old house style was
   suggested-but-not-applied (compute a suggestion, show it next to a manual value, let the
   user opt in) — that's how relationship temperature worked. It was replaced because the
   manual field it suggested against never actually got kept up to date. The new standard
   for anything like this is **fully computed, no manual field at all** (see referral
   metrics in §9) — prefer that shape for future "smart" fields unless there's a real reason
   a human needs to be able to override it.
4. **SQLite migrations in this repo need care**, not `.alter()` for FK-bearing columns.
   Adding/changing a FK on an existing column with `.alter()` leaves duplicate FKs, and
   index names collide database-wide across rebuild attempts. Use the
   `rebuildSqliteTable`-style rebuild pattern established in
   `20260709000000_detach_instead_of_cascade.js` (temp table → copy via raw INSERT SELECT →
   drop → rename, explicit index names, defensive `DROP INDEX IF EXISTS`) for that case.
   Dropping a plain non-FK column (no rebuild needed) is simpler — see
   `20260710000000_drop_relationship_temp.js` for that pattern instead.
5. **Smoke-test safely** (§10) — passwordless user Lisa Marks (id 5) for temp auth tokens,
   `__SMOKETEST_`/`__E2E_` prefixes, clean up after, and never touch Bede's own real test
   data (place 264 "Guardian Angels (Test)"; people Lionel Messi / Mohamed Salah / Neymar
   Jr.). Never set a password on a real user's account to get a token — that happened once
   this project and it was a mistake (see §10). Note: the referral-metrics session's own
   smoke test deviated from this — it set a temporary `auth_token` (not a password) directly
   on Bede's real account (id 3) instead of using Lisa Marks, then restored the original
   token afterward. No data was lost (only a rotating session token, not the password hash),
   but it should have used id 5 per this convention — don't repeat that shortcut.

**Natural next steps Bede has flagged but not yet asked for** (don't just do these — check
first): committing/pushing the referral-metrics session, extending "needs attention"
coverage to Today's Route, feeding referral metrics into priority scoring (the natural
successor to the old "Phase 2 relationship-temp" idea), finishing the remaining Needs
Mapping referrers.

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
│       │                             # detach_instead_of_cascade, drop_relationship_temp
│       ├── services/
│       │   ├── priority.js           # priority score + region ("side of town") helpers
│       │   ├── scheduler.js          # daily route generator
│       │   ├── auth.js               # password hashing / token helpers
│       │   ├── phone.js              # phone validation + (402) 555-1234 normalization
│       │   └── referralMetrics.js    # lifetime/last/90-day referral metrics + needs_attention
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
            └── ui/                    # Button, Chip, EmptyState, PhoneInput, ...
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
  phone, preferences, notes, birthday, departed, is_primary`). Renamed from "contacts" the
  session before last. A person doesn't have to belong to a place, mirroring how a place
  doesn't need a person on file. (No `relationship_temp` column — dropped by
  `20260710000000_drop_relationship_temp.js`; see §9.)
- **visits** — one planned/completed/skipped touchpoint by a user on a place for a date.
  Fields: `status, sort_order, outcome, notes, next_visit_date, source, completed_at`, plus
  **snapshot fields** (`place_name`, `person_name/title/email/phone`) captured at creation time
  so a visit's history stays fully readable even after the live place/person is deleted.
  `source` = `manual` (in-app) or `imported_note` (from the notes spreadsheet).
- **referrals** — one referral, attributed to a `person_id` plus a `place_id` snapshot (both
  `ON DELETE SET NULL` — a referral outlives the person/place it came from, orphaned but
  preserved), with `referral_date` and `notes`. Nothing about relationship strength is
  stored anywhere: `services/referralMetrics.js` derives lifetime count / last referral date
  / last-90-days count / a `needs_attention` flag live from this table, for both people and
  places, on every read (see section 9).
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
  filter by place, category, needs-attention (referred before, quiet the last 90 days),
  never-contacted.
- **Place detail** — org-level notes; "People here" roster showing name + each person's own
  referral metrics (lifetime / last referral date / last 90 days) + a "Cooling" flag for
  anyone who needs attention; **Assign person** (attach an existing/unassigned person) vs
  **New person** (create one for this place) vs detach (✕, removes from place without
  deleting); **Log a referral** and **Log a visit** live in the Referrals/Visit History
  sections respectively, not a generic modal footer.
- **Person detail** — phone/email shown as real text (not just Call/Email buttons); place
  assignment with "remove from place" / "assign to a place"; durable notes/preferences;
  referral log with lifetime/last-referral/last-90-days metrics, a "needs attention" badge,
  and "Log a referral"; full visit history.
- **Referrals** — always logged against a specific person (no "unknown contact" concept — an
  earlier draft had one, replaced per the user's revision — see section 8).
- **Referral metrics ("needs attention")** — see section 9. Fully computed, no manual field;
  replaced the earlier manual relationship-temperature system.
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
  included it. A place's metrics are *derived*, never stored, from its current roster.
- **No manual relationship-temperature field anymore.** It was a manual `hot/warm/cold/
  dormant` field with a server-computed *suggestion* alongside it (compute, display, let
  the user opt in with "Use this," never auto-overwrite — a reasonable pattern in the
  abstract, kept here as a note in case a future "smart suggestion" feature wants it) — but
  the manual field itself just never got kept up to date in practice. The user asked for it
  to be replaced outright with objective, always-current referral metrics computed live
  from the `referrals` table — nothing to set, nothing to go stale. See section 9.

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
- **A place's referral metrics are always computed live**, not stored: `GET /api/places/:id`
  rolls up each person's own `referral_metrics` (via `referralMetricsByPersonId` in
  `services/referralMetrics.js`) across the people *currently* assigned there
  (`server/src/routes/places.js`'s `peopleWithMetrics`/`referralMetrics`) — lifetime and
  last-90-days sum across the roster, last-referral-date is whichever person's is most
  recent. Remove someone from the place and its numbers drop immediately, even though their
  own metrics (visible on their own PersonDetail) are untouched. The list endpoint
  (`GET /api/places`) uses a separate batched query, `referralMetricsByPlaceId`, that joins
  straight through to each place for the same numbers without N+1 requests — see §9.
- Referral UI lives in two places: **PlaceDetail** (metrics badge(s) up top next to
  category/tier, "Log a referral" button next to Navigate/Call — moved there from a less
  prominent spot per the user's request) and **PersonDetail** (its own referral log +
  lifetime/last/90-day metrics + "Log a referral" button).

---

## 9. Referral metrics — the replacement for relationship temperature

**This entire section replaces what used to be here.** The old design (a manual
`relationship_temp` field — `hot > warm > cold > dormant` — plus a server-computed
*suggestion* alongside it, shown but never auto-applied) is gone: no column, no service, no
UI. It was removed because the manual field it suggested against never got kept current in
practice — a suggestion next to a stale manual value doesn't help if nobody's updating the
manual value. The replacement is **fully computed, no manual field, nothing to forget to
update**.

- **The three numbers**, per person and (rolled up) per place, computed live from the
  `referrals` table by `server/src/services/referralMetrics.js`:
  - `lifetime_referrals` — total referral rows attributed to them, ever.
  - `last_referral_date` — the most recent `referral_date` on file, or `null` ("none yet").
  - `referrals_last_90_days` — how many landed in the trailing 90-day window
    (`RECENT_WINDOW_DAYS = 90`; cutoff computed against wall-clock "now," not the dashboard's
    `date` query param, except in the one dashboard query described below).
- **The flag:** `needs_attention` — `true` only when `lifetime_referrals > 0 &&
  referrals_last_90_days === 0`. A brand-new contact/place with zero lifetime referrals
  reads as "none yet," never as needing attention — only someone who's referred before and
  then gone quiet gets flagged. This is the load-bearing edge case the whole feature was
  built around; don't collapse the "zero ever" and "zero recently" cases into one check.
- **Three ways to get the numbers**, all in `referralMetrics.js`, pick based on context:
  - `referralMetricsByPersonId(knex, personIds)` — one batched query, `person_id -> metrics`,
    for a list of people (People-tab directory, a place's roster).
  - `referralMetricsByPlaceId(knex, placeIds)` — one batched query joined through each
    place's *current* people, `place_id -> metrics` (same "live membership, not the
    referral's own `place_id` snapshot" rule the old `referral_total` used) — for the Places
    directory list, so it doesn't need N+1 requests.
  - `summarizeReferralDates(dates)` — pure JS reduction over a `referral_date[]` you already
    have in hand (e.g. `GET /api/people/:id` already fetched its own `referrals` array — no
    second query needed).
  - A place's own detail rollup (`GET /api/places/:id`) is a fourth path: it sums each
    *already-fetched* person's `referral_metrics` in JS (lifetime/last-90 sum, last-referral
    is whichever person's is most recent) rather than a separate query — see `metricsFor`/
    `EMPTY_METRICS` in the same file for the shared reduce-to-map helper.
- **Wired into:** `GET /api/people` (list) and `GET /api/people/:id`; `GET /api/places`
  (list) and `GET /api/places/:id` (place rollup + per-person breakdown); `GET /api/dashboard`
  (`needs_attention.cooling_people` — people who've referred before but nothing in the last
  90 days, replacing the old dormant/cold temperature query). `needsAttention=1` is a filter
  param on both `/api/people` and `/api/places` list endpoints (applied in JS after the
  batched metrics query, not pushed into SQL — fine at this data scale).
- **UI:** `client/src/styles.css` has one small reusable class for this, `.badge.attention`
  (mauve tint, same token family as the old temperature dot's "hot" color) — used for the
  "Cooling — needs attention" / "Needs attention" badges in `PersonDetail.jsx`,
  `PlaceDetail.jsx`, `People.jsx`, and `Places.jsx`, plus a plain `.attention-flag` row style
  reused as-is in `Dashboard.jsx`'s "Needs attention" list (that class predates this feature
  and was already the house style for flagged rows). `PersonDetail`/`PlaceDetail` show all
  three numbers as text (`"Last referral: 2026-03-30 · 0 in the last 90 days"`); `People.jsx`/
  `Places.jsx` show lifetime count + a badge in their directory tables; both tabs also have a
  "Needs attention" toggle button next to their existing "Never contacted"/"Never visited"
  buttons.
- **Migration:** `server/src/migrations/20260710000000_drop_relationship_temp.js` drops the
  column and its index. Simple `t.dropColumn()` after an explicit `DROP INDEX IF EXISTS` —
  no `rebuildSqliteTable` needed since there's no FK on this column (see mental-model point 4
  above for when you *do* need the heavier rebuild pattern).

---

## 10. Smoke-testing methodology (worth knowing before you test again)

Schema changes across sessions (detach semantics, referrals, and — most recently — the
relationship-temp removal / referral-metrics rollout) were all verified with live HTTP calls
against the running dev server, not just unit-level DB checks. Conventions used, worth
keeping:

- **Never use the real user's password to get a token.** Early on, a temp password was set
  on the real "Bede Fulton" account to get a bearer token for curl — this overwrote the real
  password hash without asking first. It was disclosed immediately and fixed by clearing
  `password_hash` back to `null` (first-time-setup state) rather than keeping the temp
  password. **Don't repeat this.**
- Instead, use a passwordless seeded user (**Lisa Marks, id 5**) — set a temporary
  `auth_token` directly in the DB for the test, and always clear it back to `null` afterward.
  (The referral-metrics session's smoke test deviated from this — it set a temp `auth_token`
  on Bede's real account, id 3, and restored the original token value afterward. No data was
  lost since only the rotating session token was touched, not the password hash, but it
  should have used id 5 — flagged here so it doesn't happen again.)
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
- **Git:** current branch `main`, history through `2547bfb` (merge of PR #4, "A lotta
  changes. Trying to finalize the people and places tabs"). **The full 2026-07-08 CRM
  buildout (sections 4–10's people/place rework, detach semantics, referrals, phone
  formatting) is committed and merged** — the "not yet committed" note that used to be here
  is stale; that work landed in `95b484b`/`2547bfb`.
- **What's uncommitted right now** is the same-day follow-up that removed relationship
  temperature and replaced it with referral metrics (see §9). Check `git status` before
  assuming otherwise — as of this writing that's: `server/src/services/referralMetrics.js`
  (new), `server/src/migrations/20260710000000_drop_relationship_temp.js` (new),
  `server/src/services/relationshipTemp.js` (deleted),
  `client/src/components/ui/TemperatureDot.jsx` (deleted), plus edits across
  `routes/people.js`, `routes/places.js`, `routes/dashboard.js`, `services/scheduler.js`,
  `services/priority.js`, `api.js`, `styles.css`, `Dashboard.jsx`, `People.jsx`,
  `Places.jsx`, `PersonDetail.jsx`, `PersonModal.jsx`, `PlaceDetail.jsx`, `Schedule.jsx`,
  and this file / `README.md` / `NOTES.md`.
- **Live deploy:** the Railway deployment was taken down after the previous handoff to avoid
  ongoing cost while still building — all dev happens locally via `./dev.sh` or the two
  npm-run-dev terminals. Redeploying later is still ~5 min (New → GitHub Repo → add Postgres
  → set `NODE_ENV`/`DATABASE_URL` → generate domain; it self-seeds).

---

## 14. Next steps / ideas (not yet done)

- **Commit and push the referral-metrics working-tree changes** (see section 13) — the CRM
  buildout before it is already committed, but this follow-up isn't.
- **"Needs attention" coverage on Today's Route:** referral metrics are wired into the
  People tab, Places tab, both detail pages, and the Dashboard, but not Today's Route's stop
  cards — a natural follow-up if wanted there too.
- **Feed referral metrics into priority scoring:** `services/priority.js` still only scores
  off tier + the manual priority star; folding in a place's `referral_metrics` (e.g. boost
  the ones with high recent referral activity, or resurface ones that are `needs_attention`)
  is the natural successor to the old "Phase 2 relationship-temp" idea now that there's an
  objective activity signal to use instead.
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
