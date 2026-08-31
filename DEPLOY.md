# Railway deploy runbook

Written 2026-08-30. First real redeploy since the original Railway project was
torn down. All prerequisite code fixes plus a second round of pre-deploy audit
fixes are on **`main`** as of **`8f714c6`** (2026-08-31).

Everything here is a browser + one local command. Budget ~20 min.

---

## Step 0 — deploy branch

`main` is the deploy branch. All the fixes are already merged there; point the
Railway service at `main` in Step 3, and every later push to `main` auto-deploys.
Do feature work on a branch and PR it into `main` when ready to ship.

---

## Step 1 — create the project and the database

1. Railway → **New Project**.
2. **Add PostgreSQL first** (Add → Database → PostgreSQL). Do this *before* the
   app service so the data load can happen against a clean DB.
3. Open the Postgres service → **Variables** (or the **Connect** tab) and copy
   **`DATABASE_PUBLIC_URL`** — the `...proxy.rlwy.net:PORT...` one, not the
   internal `postgres.railway.internal` one. You need the public URL because the
   loader runs from your laptop.

---

## Step 2 — load the real data

The bundled-spreadsheet auto-seed only creates ~261 bare places (no coordinates,
no distance cache, no people, no referrals). This copies the actual dev database
— 268 places (geocoded), 68,906 distance-matrix rows, 201 people, 75 referrals,
3 user accounts with their existing passwords.

From a normal terminal (nvm loaded, so `node` works):

```bash
cd ~/guardian-angels-sales/server

NODE_ENV=production \
DATABASE_URL='<paste DATABASE_PUBLIC_URL here>' \
node src/scripts/pg-load-from-sqlite.js --force
```

- The loader runs the 52 migrations itself, then loads. No separate migrate step.
- `--force` truncates the few rows migrations seed (categories) before loading.
  Safe here — the target is brand new.
- **Do not** set `PGSSL` — Railway's public endpoint needs SSL, which is the default.
- It prints a source-vs-target row-count table at the end and exits non-zero on
  any mismatch. Expect all rows `ok`.

If it fails partway, the whole load rolls back — fix and re-run, no cleanup needed.

---

## Step 3 — add the app service

1. Same project → **New → GitHub Repo** → `bede-werk/guardian-angels-sales`.
2. Settings → set the **branch** to your deploy branch from Step 0.
3. The app service → **Variables**:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (internal — type it literally, Railway resolves it) |
   | `VITE_MAPBOX_TOKEN` | *(optional)* your Mapbox token — only powers the "enter address manually" search box; without it that box shows a small notice |

4. The app service → **Settings → Networking → Generate Domain**. This is the URL
   you visit — generate it on the **app** service, never on Postgres (a database
   has no web page — that was a confusing dead end last time).

`railway.json` already pins the builder (nixpacks), build command, start command,
and healthcheck (`/api/health`), so there's nothing else to configure.
`nixpacks.toml` is comments only — it used to add `osrm-backend` but that broke
the build; see "Known gap" below.

On boot the app runs migrations (a no-op — Step 2 already did them) and its
first-run seed detects the non-empty `places` table and skips. Watch the deploy
logs for `GA Sales API listening` and `Event-loop watchdog armed`.

---

## Step 4 — verify

1. Open the generated domain.
2. Log in — your real accounts came across with their passwords: **Bede Fulton**,
   **Nikki Shasserre**, **Lisa Marks**.
3. Check a couple of surfaces:
   - Dashboard loads (this was one of the Postgres bugs — a 500 whenever a
     commitment was outstanding).
   - Route Planner → generate a day → it returns real sequenced stops (the other
     Postgres bug — the solver crashed on string coordinates).
   - People / Places / Visits tabs list data.

---

## After it's live

- Every push to the deploy branch auto-deploys.
- Set a **spend cap** in Railway billing.
- Consider enabling Railway's Postgres backups now that it holds real data.

---

## Known gap — distance backfill for brand-new places

`nixpacks.toml` no longer installs `osrm-backend` (the derivation fails to build
from Nixpacks' pinned nixpkgs snapshot and broke every deploy — commit
`8f714c6`). Consequences:

- **Normal operation is unaffected.** Routing runs entirely off the
  `place_distance` matrix loaded in Step 2 (100% coverage) plus the local TSP
  solver. The backfill worker starts on boot but no-ops — it never throws when
  OSRM is missing.
- **What breaks:** when someone geocodes a *brand-new* place, its road distances
  can't be computed, so it's queued and then retired to "failed" after
  `MAX_ATTEMPTS`. Until then that place has no cached distances and the route
  planner can't sequence it. Settings → Distance Cache shows the failures;
  "Retry failed places" won't help until OSRM works.

To close it, OSRM needs both halves on Railway:

1. Restore `nixpacks.toml` to `nixPkgs = ['...', 'osrm-backend']` — **and** first
   confirm the derivation builds (try a newer `providers`/nixpkgs pin, or a
   `[phases.setup] aptPkgs` / Docker-image route instead of Nix).
2. Ship the processed `.osrm` dataset (region extract, ~GB — *not* in the repo;
   built locally by `scripts/backfill-distances.js`) via a Railway volume or a
   build step, and set `OSRM_DATA_PATH` to its base name.

Low urgency: new places are added a few times a month, and a one-off distance
computation can also be run from a laptop against the production `DATABASE_URL`.

---

## Reference — what was broken and why (context, not steps)

Five Postgres-only problems, all fixed in `57da014`, all invisible under local
SQLite + the 685-test suite. Found by dry-running the migrate + boot against a
real local Postgres 16.

| Fix | Problem it solves |
|---|---|
| `knexfile.js` pg type parser for DATE (1082) | pg returns `Date`; code treats dates as `'YYYY-MM-DD'` strings → dashboard 500s, timed do-not-visit marks silently expire |
| `knexfile.js` pg type parser for NUMERIC (1700) | pg returns `lat`/`lng` as strings → `a.lat + b.lat` concatenates → NaN → route solver crashes every generate |
| migration `20260708120000` | pg keeps FK constraint names through column renames → `20260709000000` aborts the whole migrate on `visits_place_id_foreign does not exist` |
| `import-excel.js` stamps `exploration_eligible_since` | fresh seed left it NULL → route planner `daysSince(null)` throws on first generate |
| `.nvmrc` + `engines.node` = `24.x` | nixpacks could pick Node 18 off `">=18"`, no `better-sqlite3@12` prebuild → build fails |
| `nixpacks.toml` drops `osrm-backend` (`8f714c6`) | the derivation fails to build from nixpacks' pinned nixpkgs → every deploy fails at the Nix setup phase; see "Known gap" |

Required env vars are only `NODE_ENV` and `DATABASE_URL`. Auth uses DB-stored
random tokens — no session secret to set. Timezone is hardcoded to
`America/Chicago` in `services/orgDate.js` — `TZ` doesn't matter.
