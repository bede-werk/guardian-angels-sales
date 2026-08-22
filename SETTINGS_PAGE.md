# The Settings page - every tunable constant, editable and explained

**Built 2026-08-17.** Reached from the ⚙ gear button in the header, immediately left of the
profile avatar.

This is the full record of that page: what it exposes, how an edit reaches the algorithm, every
file involved, and what to do when you want to add a new tunable. `HANDOFF.md` §21 is the short
version and points here; this file is the one to trust when they disagree.

---

## 1. Why it exists

Four config modules (`config/scheduling.js`, `driveTime.js`, `visitTypes.js`, `routeOptimizer.js`)
each carried a header saying some version of *"kept as named constants so a future settings-table
phase can lift them out without touching the engine itself."* This is that phase.

Bede's framing when asking for it: he wants to see and edit every tunable constant so the
algorithm can be brought in tune with what he actually wants over time - and, stated explicitly,
**he must never be in the dark about what a number he's editing does.** That second half is not a
nice-to-have; it is why the registry carries prose for every field and why the page refuses to
render a bare number with no explanation next to it.

---

## 2. The three layers

The one thing to internalise before touching any of this:

| Layer | Lives in | Holds |
|---|---|---|
| **Default** | `server/src/config/*.js` | The shipped value. Never edited at runtime. |
| **Override** | `settings` table | **Only** what the user actually changed. |
| **Meaning** | `server/src/config/tunables.js` | Label, help, raise/lower effects, bounds, legal values, UI grouping. |

Consequences that fall out of that split, all deliberate:

- **"Reset to default" is a `DELETE`, not a write.** So a shipped default that changes in a later
  version is picked up automatically by everyone who never disagreed with it. If resets wrote the
  old default back as a value, every reset would silently pin that number forever.
- **A removed or renamed tunable leaves a harmless orphan row.** `loadSettings()` drops rows whose
  key isn't in the registry - and rows that no longer validate - with a `console.warn` rather than
  refusing to boot. A stale settings row must never be the reason the server won't start.
- **The client renders itself entirely from what the server sends.** `Settings.jsx` contains no
  list of fields, no labels, no bounds. The moment it had its own copy, the two could disagree
  about what a number means, which is the exact failure the page exists to prevent.

---

## 3. How an override actually reaches the engine

`services/settings.js`'s `loadSettings()` runs in `index.js`'s `start()` **before** `app.listen`,
and writes each saved override *into* the live config module object, **mutating it in place**.

Nothing downstream knows settings exist. Every service that already did
`require('../config/scheduling')` and read `config.HARD_FLOOR_DAYS` at call time keeps working
completely unchanged and simply starts seeing the user's number. Saving from the page applies the
same mutation immediately, so there is no restart and no server-side cache to invalidate.

The alternative - threading a resolved settings object through the whole route-planner stack -
was rejected because that stack already has a config-injection seam that merges
`{ ...defaults, ...override }` at call time. Handing those call sites a *different* object means
touching every one of them; mutating the object they already read means touching none.

### THE ONE RULE

> **A tunable must be read at CALL time.**
>
> `const { X } = require('../config/foo')` at the top of a module captures the default at require
> time and then ignores every override **forever, silently**. Read `cfg.X` inside the function.

This is the only way to get this wrong, and it fails without any error, which is why it is called
out in `config/tunables.js`'s header, in each config module's header, and here.

Two smaller mechanics follow from the same rule:

- **`writePath` only ever assigns the leaf**, never an intermediate object. Other modules hold
  direct references to those (`routes/visits.js` destructures `VISIT_TYPES`), and swapping a
  parent object out would leave them pointing at an orphan that no longer receives updates.
- **`relationship.js` and `scheduleDraft.js` re-export their tunables as getters**, not values. A
  plain `X: cfg.X` in a `module.exports` object snapshots the number at require time and hands
  tests and scripts a stale one. (`scheduleDraft.test.js` destructures those exports and so still
  sees defaults - harmless, since tests never load overrides.)

---

## 4. What moved, and what is new

### New config modules (extracted so their contents could be registered as tunables)

| File | Extracted from | Contents |
|---|---|---|
| `config/relationship.js` | ~17 module-level consts in `services/relationship.js` | met-with + outcome weights, half-lives, reciprocity, level thresholds, the whole trend block, `CONTRIBUTOR_DECAY` |
| `config/planning.js` | `services/scheduleDraft.js` | `MAX_PLAN_DATES`, `DEFAULT_HOURS_PER_DAY`, `MAX_DAYS_AHEAD` |
| `config/referrals.js` | `services/referralMetrics.js` | `RECENT_WINDOW_DAYS` |

One behavioural detail in the move: `FAST_DECAY_CATEGORIES` changed from a `Set` to an **array**
(`halfLifeForCategory` now uses `.includes` instead of `.has`), because the settings layer stores
and validates plain JSON and eight entries make the lookup cost irrelevant.

### New files

| File | Job |
|---|---|
| `server/src/config/tunables.js` | The registry: sections, groups, labels, help, raise/lower effects, types, bounds. Also validates itself at require time. |
| `server/src/services/settings.js` | Defaults snapshot, path read/write, coercion + validation, cross-field checks, load/save/reset. |
| `server/src/services/settings.test.js` | 25 tests (see §10). |
| `server/src/routes/settings.js` | `GET /`, `GET /values`, `PUT /`, `POST /reset`. |
| `server/src/migrations/20260817000000_add_settings_table.js` | The `settings` table. |
| `client/src/components/Settings.jsx` | The page. Renders entirely from the server payload. |
| `client/src/hooks/useTunables.js` | Module-scope-cached read of `GET /settings/values` for screens that respect a setting without explaining it. |

### Modified files

| File | Change |
|---|---|
| `server/src/index.js` | Mounts `/api/settings`; awaits `loadSettings()` before `app.listen`. |
| `server/src/services/relationship.js` | Constants → `cfg.X` call-time reads; exports became getters. |
| `server/src/services/referralMetrics.js` | `RECENT_WINDOW_DAYS` → `cfg.RECENT_WINDOW_DAYS`. |
| `server/src/services/scheduleDraft.js` | Three planning bounds → `planningConfig.X`; exports became getters. |
| `client/src/App.jsx` | Gear button in the header; `tab === 'settings'` renders the page. |
| `client/src/api.js` | `api.settings.{view,values,save,reset}`. |
| `client/src/components/RoutePlanner.jsx` | Dropped its three hardcoded bound copies (see below). |
| `client/src/styles.css` | The `.settings-*` / `.tunable-*` / `.cadence-matrix` / `.seed-table` / `.category-picker` block, plus `.settings-trigger`. |

### RoutePlanner no longer keeps duplicate copies

It used to hardcode `MAX_PLAN_DATES`, `DEFAULT_HOURS_PER_DAY` and `MAX_DAYS_AHEAD` with a
*"mirrors scheduleDraft.js"* comment - exactly the kind of pairing that drifts the moment one side
becomes editable. It now reads all three through `hooks/useTunables.js`, and `maxPlanDateISO()`
takes the bound as an argument instead of closing over a module const.

Left as-is deliberately: if that fetch fails, the hook serves the shipped defaults rather than
taking the planner down. Those fallbacks are duplicated numbers and must stay equal to
`config/planning.js` - they only show for the few hundred milliseconds before the fetch lands, but
a wrong one there is a real (if brief) wrong answer.

---

## 5. The complete inventory (76 tunables)

Generated from the registry at the time of writing. `Lives in` is the dotted key: the first
segment names the config module, the rest is the path inside it.

### 🔁 Visit cadence

How often a place should be visited, and when the planner is allowed to override that. This is the core of the route planner: every place is scored on how far past its target cadence it has drifted, and the ones that have drifted furthest get proposed first.

**Target days between visits**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| High capacity · Strong relationship | `14` | 1 – 365 days | `scheduling.CADENCE_DAYS.high.strong` |
| High capacity · Medium relationship | `10` | 1 – 365 days | `scheduling.CADENCE_DAYS.high.medium` |
| High capacity · Weak relationship | `7` | 1 – 365 days | `scheduling.CADENCE_DAYS.high.weak` |
| Medium capacity · Strong relationship | `30` | 1 – 365 days | `scheduling.CADENCE_DAYS.medium.strong` |
| Medium capacity · Medium relationship | `21` | 1 – 365 days | `scheduling.CADENCE_DAYS.medium.medium` |
| Medium capacity · Weak relationship | `21` | 1 – 365 days | `scheduling.CADENCE_DAYS.medium.weak` |
| Low capacity · Strong relationship | `90` | 1 – 365 days | `scheduling.CADENCE_DAYS.low.strong` |
| Low capacity · Medium relationship | `60` | 1 – 365 days | `scheduling.CADENCE_DAYS.low.medium` |
| Low capacity · Weak relationship | `90` | 1 – 365 days | `scheduling.CADENCE_DAYS.low.weak` |

**Guardrails**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Minimum days between visits | `5` | 0 – 90 days | `scheduling.HARD_FLOOR_DAYS` |
| Overdue rescue multiplier | `2` | 1 – 10 x cadence | `scheduling.NEGLECT_MULTIPLIER` |

**Fatigue guard**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Fatigue lookback window | `30` | 1 – 365 days | `scheduling.FATIGUE_WINDOW_DAYS` |
| Visits before fatigue applies | `4` | 1 – 50 visits | `scheduling.FATIGUE_THRESHOLD` |
| Fatigue cadence stretch | `1.5` | 1 – 5 x cadence | `scheduling.FATIGUE_MULTIPLIER` |

**Exploration starvation guard**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Exploration ageing period | `90` | 1 – 3650 days | `scheduling.EXPLORATION_AGING_DAYS` |

### 📈 Capacity

Capacity is how much business a place can realistically send you. It is computed, never typed in: the app prefers what you were told on a pre-qualification visit, raises that to a floor if your own referral history proves more, and falls back to a category-based guess when it has neither.

**Level thresholds**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Medium starts at | `6` | 1 – 1000 referrals/mo | `scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN` |
| High starts at | `16` | 1 – 1000 referrals/mo | `scheduling.CAPACITY_THRESHOLDS.HIGH_MIN` |

**Measured floor gate**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Minimum relationship age | `180` | 0 – 3650 days | `scheduling.MEASURED_MIN_EXPOSURE_DAYS` |
| Minimum referrals in window | `3` | 1 – 100 referrals | `scheduling.MEASURED_MIN_REFERRAL_COUNT` |

**Freshness**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Capacity answer goes stale after | `365` | 1 – 3650 days | `scheduling.CAPACITY_STALE_DAYS` |

**Starting guess by category**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Category rules | 16 ordered rules | ordered keyword rules | `scheduling.CATEGORY_CAPACITY_SEED` |
| Fallback when no rule matches | `low` | high / medium / low | `scheduling.CATEGORY_CAPACITY_SEED_DEFAULT` |

### 🤝 Relationship strength

Relationship is the other axis of the cadence table, and like capacity it is computed rather than typed in. Every completed visit scores WHO you actually spoke to multiplied by WHAT happened, that score decays with time, and the results roll up from people to their place. One rule worth protecting: relationship must never be driven by referral VOLUME. Volume is the capacity axis, and if both axes read the same signal they collapse into one and the inversion that makes the cadence table useful stops working.

**Who you met**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| A named contact | `1` | 0 – 1 | `relationship.MET_WITH_WEIGHT.named_person` |
| Staff (not a named contact) | `0.35` | 0 – 1 | `relationship.MET_WITH_WEIGHT.staff` |
| The receptionist / front desk | `0.15` | 0 – 1 | `relationship.MET_WITH_WEIGHT.receptionist` |
| Nobody | `0.05` | 0 – 1 | `relationship.MET_WITH_WEIGHT.nobody` |

**What happened**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Substantive conversation | `1` | 0 – 1 | `relationship.OUTCOME_WEIGHT.substantive` |
| Introduced to someone new | `1` | 0 – 1 | `relationship.OUTCOME_WEIGHT.introduced_new` |
| Brief exchange | `0.6` | 0 – 1 | `relationship.OUTCOME_WEIGHT.brief` |
| Left materials only | `0.25` | 0 – 1 | `relationship.OUTCOME_WEIGHT.materials_only` |
| Target unavailable | `0.15` | 0 – 1 | `relationship.OUTCOME_WEIGHT.unavailable` |
| Declined | `0.1` | 0 – 1 | `relationship.OUTCOME_WEIGHT.declined` |

**How fast a relationship cools**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Fast-decay categories | 8 categories | any category names | `relationship.FAST_DECAY_CATEGORIES` |
| Fast half-life | `30` | 1 – 3650 days | `relationship.HALF_LIFE_FAST` |
| Default half-life | `60` | 1 – 3650 days | `relationship.HALF_LIFE_DEFAULT` |

**Reciprocity**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Bonus per personal detail known | `0.0625` | 0 – 1 | `relationship.DETAIL_BONUS` |
| Has ever referred | `1.15` | 1 – 3 x | `relationship.REFERRED_MULTIPLIER` |
| Asked us for something recently | `1.1` | 1 – 3 x | `relationship.REQUESTED_MULTIPLIER` |
| Reciprocity cap | `1.6` | 1 – 5 x | `relationship.MAX_RECIPROCITY` |

**Strong / medium / weak cut lines**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Strong starts at | `3.4` | 0 – 20 | `relationship.RELATIONSHIP_THRESHOLDS.strong` |
| Medium starts at | `1.4` | 0 – 20 | `relationship.RELATIONSHIP_THRESHOLDS.medium` |
| Meaningful visit threshold | `0.6` | 0 – 1 | `relationship.MEANINGFUL_WEIGHT` |

**Rolling people up to their place**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Each extra contact is worth | `0.5` | 0 – 1 x the last | `relationship.CONTRIBUTOR_DECAY` |

**Heating up and cooling down**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Heating-up sensitivity | `0.1` | 0.01 – 2 | `relationship.TREND_RELATIVE_THRESHOLD` |
| Heating-up lookback | `0.12` | 0.01 – 1 x half-life | `relationship.TREND_WINDOW_FRACTION` |
| Empty-history floor | `0.01` | 0 – 1 | `relationship.TREND_EPSILON` |
| Place cooling threshold | `1.25` | 1 – 10 x cadence | `relationship.COOLING_THRESHOLD` |
| Person cooling threshold | `0.5` | 0.05 – 5 x half-life | `relationship.PERSON_COOLING_HALF_LIFE_FRACTION` |

### ⏱️ Visit types and time

How long each kind of visit is budgeted for. This is what the planner packs a day against: get these wrong and every generated day is either over-stuffed or half empty. These are budgeting estimates for planning, not targets you are held to.

**Expected duration by visit type**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Drop-in | `7` | 1 – 480 min | `visitTypes.VISIT_TYPES.drop_in.minutes` |
| Check-in | `18` | 1 – 480 min | `visitTypes.VISIT_TYPES.check_in.minutes` |
| Working visit | `30` | 1 – 480 min | `visitTypes.VISIT_TYPES.working_visit.minutes` |
| Presentation / in-service | `60` | 1 – 480 min | `visitTypes.VISIT_TYPES.presentation.minutes` |
| Pre-qualification | `15` | 1 – 480 min | `visitTypes.VISIT_TYPES.pre_qualification.minutes` |

**Per-stop overhead**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Prep time | `3` | 0 – 120 min | `visitTypes.PREP_MINUTES` |
| Data entry time | `5` | 0 – 120 min | `visitTypes.DATA_ENTRY_MINUTES` |

**Default visit type**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Global fallback | `drop_in` | drop_in / check_in / working_visit / presentation / pre_qualification | `visitTypes.DEFAULT_VISIT_TYPE` |
| High capacity places | `working_visit` | drop_in / check_in / working_visit / presentation / pre_qualification | `visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.high` |
| Medium capacity places | `check_in` | drop_in / check_in / working_visit / presentation / pre_qualification | `visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.medium` |
| Low capacity places | `drop_in` | drop_in / check_in / working_visit / presentation / pre_qualification | `visitTypes.DEFAULT_VISIT_TYPE_BY_CAPACITY.low` |

### 🚗 Drive time estimates

How the app estimates travel between stops when the routing service is unavailable. It works from straight-line distance rather than real roads: good enough to rank and pack stops, not to navigate by. When the routing service does answer, its real numbers are used instead and only the minimum below still applies.

**Speed bands**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Short trips are under | `1` | 0.1 – 100 miles | `driveTime.SHORT_BAND_MAX_MILES` |
| Medium trips are under | `5` | 0.1 – 500 miles | `driveTime.MEDIUM_BAND_MAX_MILES` |
| Short-trip speed | `15` | 1 – 100 mph | `driveTime.SPEED_MPH_SHORT` |
| Medium-trip speed | `25` | 1 – 100 mph | `driveTime.SPEED_MPH_MEDIUM` |
| Long-trip speed | `38` | 1 – 100 mph | `driveTime.SPEED_MPH_LONG` |

**Corrections**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Road distance multiplier | `1.3` | 1 – 3 x | `driveTime.CIRCUITY_FACTOR` |
| Parking and walking in | `5` | 0 – 60 min | `driveTime.OVERHEAD_MINUTES` |
| Minimum drive between stops | `3` | 0 – 60 min | `driveTime.MIN_DRIVE_MINUTES` |

### 🗺️ Route planner

Bounds on what you can ask the planner for, and the settings for the external routing service it uses to sequence a day's stops.

**Planning bounds**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Maximum dates per draft | `10` | 1 – 60 dates | `planning.MAX_PLAN_DATES` |
| Default hours per day | `4` | 0.5 – 12 hours | `planning.DEFAULT_HOURS_PER_DAY` |
| Furthest date you can plan | `7` | 1 – 60 weekdays | `planning.MAX_DAYS_AHEAD` |

**Route optimizer**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Routing service URL | `https://router.project-osrm.org` | free text | `routeOptimizer.OSRM_BASE_URL` |
| Routing service timeout | `5000` | 100 – 60000 ms | `routeOptimizer.TIMEOUT_MS` |
| Maximum stops sent to optimize | `18` | 2 – 100 stops | `routeOptimizer.MAX_OPTIMIZE_STOPS` |
| Absolute stop ceiling | `30` | 2 – 200 stops | `routeOptimizer.MAX_TOPUP_STOPS` |
| Minimum time to attempt top-up | `18` | 1 – 240 min | `routeOptimizer.MIN_TOPUP_MINUTES` |

### 📨 Referrals

How referral activity is summarised on people and places. Everything here is derived live from the referral records; nothing is stored or needs upkeep.

**Recent activity window**

| Tunable | Ships as | Range | Lives in |
|---|---|---|---|
| Recent referrals window | `90` | 1 – 3650 days | `referrals.RECENT_WINDOW_DAYS` |

---

## 6. The two tunables that aren't plain scalars

### `scheduling.CATEGORY_CAPACITY_SEED` - the category rule table

In code this is an ordered `[RegExp, level][]`. Asking someone to hand-write a regular expression
into a settings box is a good way to get a server that won't start, so the wire and UI shape is
`[{ keywords: string[], level }]`, converted by `seedToRules` / `rulesToSeed`:

- **out:** each pattern's `source` split on `|`, backslash-escapes unwound → keyword list.
- **in:** each keyword escaped with `escapeRegExp`, joined with `|`, compiled with the `i` flag.

That round-trips every shipped pattern **exactly** (there's a test pinning source + flags + level
for all 16 rules), because the hand-written defaults only ever used `|` alternation and no other
regex metacharacters. Escaping on the way back in means a keyword someone types with a `.` or `(`
in it is matched literally rather than acting as a wildcard - also tested.

**Order is part of the setting** (first match wins), so the editor has move-up / move-down, not
just add and remove.

### `relationship.FAST_DECAY_CATEGORIES` - the fast-decay category list

These are matched against category names **exactly**, and a near-miss falls straight through to
the default half-life with no error at all. So the editor is a multi-select over the real
`categories` table, never a text box - it is not possible to type a name that doesn't exist.

A selected name that has since been renamed or retired renders **struck through in mauve** rather
than silently vanishing, so a stale entry is something you can see and remove rather than
something that just quietly stops matching anything. Clicking it removes it.

---

## 7. Validation

**Per-field**, from the registry, in `settings.js`'s `coerce()`:

- `integer` / `number` - finite, whole where declared, inside `min`/`max`. Numeric strings are
  accepted and coerced (the input keeps text while you type so a half-typed `1.` doesn't collapse
  to `0` under you).
- `select` - must be one of the declared option values.
- `text` - trimmed, non-empty, under `maxLength`.
- `categories` - array; blanks dropped, duplicates collapsed.
- `seedTable` - every rule needs at least one keyword and a legal level.

**Cross-field**, in `settings.js`'s `CROSS_CHECKS`. Each is evaluated against the state that
*would* result from the save (pending edit if present, live value otherwise), so editing one half
of a pair and saving is **not** rejected for a conflict you are halfway through fixing:

| Rule | Why |
|---|---|
| high capacity threshold > medium | otherwise no place can ever read medium |
| medium distance band > short band | otherwise the short band swallows the medium one |
| top-up stop ceiling ≥ per-request cap | otherwise the planner could never top a day up |
| relationship strong > medium | otherwise no relationship can ever read medium |

**A save is all-or-nothing.** One rejected value writes nothing, so a typo in one box cannot
half-apply a page of edits. The live config is only mutated *after* the transaction commits, so a
failed write can never leave the running server disagreeing with the database.

---

## 8. The page itself

- **Entry point.** Gear button in the header, left of the profile avatar (`.settings-trigger` -
  outlined rather than filled, so it doesn't compete with the avatar, which is the identity anchor
  in that corner).
- **Not a tab.** It renders in the same slot via `tab === 'settings'` but stays out of `TABS`.
  It's a place you visit occasionally to tune behaviour, not one of the five screens the daily job
  runs through, and putting it in the row would give it the same standing as Dashboard or Places.
  The tab bar stays visible, so clicking any tab is the way back out.
- **Sidebar of 7 sections, one shown at a time.** 76 tunables stacked would bury the ones that
  matter. Each section carries a badge counting how many of its fields differ from the shipped
  default, so "what have I changed?" is answerable without opening all seven.
- **Each tunable renders as a block, not a table row.** Label + control on one line, then the
  plain-English help, then `Higher:` / `Lower:` consequence lines. Those are phrased in terms of
  *visits actually scheduled*, never in terms of the formula - that is the whole "never in the
  dark" requirement. A table would have squeezed the explanation into a column.
- **Edits accumulate across sections and save as one batch**, which is what makes the cross-field
  checks above workable.
- **`CADENCE_DAYS` renders as the 3×3 grid it actually is.** Read as nine separate rows it loses
  the one property that matters most - that it is deliberately inverted, with the shortest cadence
  at high capacity + weak relationship. Rendering the grid makes a mis-tuned inversion visible at
  a glance.
- **Per-field footer** shows what the value ships as and who last changed it, with a "Reset to
  default" link that appears only once a field actually differs.
- **Sticky status bar** appears only when there's something to say (unsaved edits, a confirmation,
  or an error), so it isn't permanent chrome eating a strip of the viewport.

---

## 9. Adding a new tunable later

1. Put the default in the right `config/*.js` module (or add a new module and register it in
   `tunables.js`'s `NAMESPACES`).
2. **Check every consumer reads it at call time.** See THE ONE RULE in §3. This is the step that
   silently fails.
3. Add a field to the right group in `config/tunables.js`'s `SECTIONS` with `key`, `label`,
   `type`, bounds, and - non-negotiable - a real `help`, plus `raise`/`lower` if it's numeric.
4. If it pairs with another field, add a `CROSS_CHECKS` entry in `services/settings.js`.
5. That's it. No client change: the page renders it, validates it and explains it automatically.

`config/tunables.js` throws **at require time** if a key names an unknown namespace, points at a
path that doesn't exist, or resolves to an object where a leaf was expected - so a typo fails at
boot rather than the first time somebody tries to change it.

---

## 10. Testing

**443 backend tests passing** (418 before; +25 in `services/settings.test.js`). Four of the new
ones are registry-integrity guards rather than logic tests, and they're the ones most likely to
catch a future mistake:

- every field resolves to a real value in its config module;
- every field carries help text longer than 20 characters;
- every numeric field is bounded on both sides **and its own shipped default sits inside those
  bounds**;
- every shipped default validates against its own field definition.

The rest cover coercion per type, the seed-table round-trip (including regex escaping and
case-insensitivity), each cross-field rule, and that the `DEFAULTS` snapshot is a genuine deep
clone rather than an alias of the live config.

**Verified live in the browser** (Lisa Marks smoke-test token, cleared after; settings table left
empty): edit → dirty bar → deliberate cross-field rejection showing the real message → fix → save
→ persistence confirmed through `GET /api/settings/values` → sidebar badge counts → reset-all back
to shipped defaults. Also confirmed an override reaches the engine **live in the running process**:
changing the relationship medium threshold re-bucketed a score of 2.0 from `medium` to `weak` with
no restart.

**Boot resilience** exercised directly: a table containing one orphan row (unknown key), one
now-invalid row (out of bounds) and one good row loads as `{ applied: 1, skipped: 2 }`, warns
about both bad rows, applies the good one, and leaves the invalid one's tunable at its default.

---

## 11. Deliberately not done

- **No permissions.** Any logged-in user can edit. There is no role concept in `users` today, and
  inventing one for this page alone would have been the bigger change. `updated_by` is recorded
  and surfaced per field, so a surprising number is at least traceable.
- **No audit history.** The table keeps the current override only, not a log of past values.
- **No per-place or per-rep overrides.** Everything here is global to the install.
- **`OSRM_BASE_URL` is editable.** It's infrastructure rather than algorithm, but it lives in a
  config module explicitly labelled as tunables, and a bad value degrades to straight-line
  estimates rather than breaking planning - which its help text says.
- **Nothing recomputes retroactively.** Changes apply from the next plan generated; already
  planned or committed visits are untouched. The page says so in its own intro.
