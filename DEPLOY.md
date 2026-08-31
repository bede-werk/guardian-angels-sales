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
   | `VITE_MAPBOX_TOKEN` | your Mapbox public token (`pk.…`). Powers the "enter address manually" search box **and** the distance backfill for newly added places (see "Distance backfill" below). Without it the address box shows a notice and new-place backfill can't run. Set it as a **build + runtime** var (Railway's default for a plain variable). |
   | `MAPBOX_TOKEN` | *(optional)* a separate Mapbox token for the server only — e.g. a URL-unrestricted secret token if your `pk.` token is locked to a domain. Falls back to `VITE_MAPBOX_TOKEN` when unset. |

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

## Distance backfill for newly added places

Route generation itself never needs a routing engine — it reads the
`place_distance` matrix loaded in Step 2 (100% coverage) and runs the local TSP
solver. A routing engine is only needed to fill in a **brand-new** place's road
distances after it's geocoded.

`nixpacks.toml` does **not** install `osrm-backend` (the derivation fails to
build from Nixpacks' pinned nixpkgs snapshot — commit `8f714c6`). Instead the
backfill worker uses the **Mapbox Matrix API** when no local OSRM dataset is
configured (`services/routingProvider.js` picks the provider; commit adds
`services/mapboxMatrixProvider.js`). So:

- **With `VITE_MAPBOX_TOKEN` (or `MAPBOX_TOKEN`) set** — new places backfill
  automatically within `DRAIN_INTERVAL_MINUTES` (15). A handful of new places a
  month is a few thousand Matrix "elements" — well inside Mapbox's free
  100k/month allowance.
- **With no token** — new places queue and retry, then retire to "failed" after
  `MAX_ATTEMPTS`; until backfilled they have no cached distances and the route
  planner falls back to the straight-line estimate for pairs involving them.
  Nothing else breaks. Fix by setting the token and hitting Settings → Distance
  Cache → "Retry failed places".

If you ever want to go back to a bundled local OSRM (no per-call dependency):
restore `nixpacks.toml` to `nixPkgs = ['...', 'osrm-backend']` **after**
confirming that derivation builds (newer nixpkgs pin, or a Dockerfile), ship the
processed `.osrm` dataset (~GB, not in the repo — built by
`scripts/backfill-distances.js`) on a Railway volume, and set `OSRM_DATA_PATH`.
A local dataset always wins over the Mapbox fallback.

You can also always run `npm run backfill-distances` from a laptop (which has
the full local OSRM setup) pointed at the production `DATABASE_URL`.

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
| `nixpacks.toml` drops `osrm-backend` (`8f714c6`); Mapbox Matrix API backfill provider added | the derivation fails to build from nixpacks' pinned nixpkgs → every deploy fails at the Nix setup phase; see "Distance backfill" |

Required env vars are only `NODE_ENV` and `DATABASE_URL`; `VITE_MAPBOX_TOKEN` is
strongly recommended (address search + new-place distance backfill). Auth uses
DB-stored random tokens — no session secret to set. Timezone is hardcoded to
`America/Chicago` in `services/orgDate.js` — `TZ` doesn't matter.
