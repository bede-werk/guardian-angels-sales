// The runtime settings layer behind the Settings page.
//
// HOW THE THREE LAYERS FIT TOGETHER
//   config/*.js       the default value of every tunable, shipped in code.
//   settings table    only the values the user has actually changed.
//   config/tunables.js what each tunable means, and what values are legal.
//
// This module owns the join between them: at boot it reads the overrides out
// of the table and writes them INTO the live config module objects, mutating
// them in place. Nothing downstream needs to know settings exist. Every
// service that already did `require('../config/scheduling')` and read
// `config.HARD_FLOOR_DAYS` at call time keeps working unchanged and simply
// starts seeing the user's number.
//
// WHY MUTATE IN PLACE RATHER THAN HAND OUT A MERGED COPY
// Because the alternative is threading a settings object through the entire
// route-planner stack, and the stack already has a config-injection seam that
// merges `{ ...defaults, ...override }` at call time. Handing those call sites
// a *different* object would mean touching every one of them; mutating the
// object they already read means touching none. The one rule this depends on
// is in config/tunables.js's header: read `cfg.X` at call time, never
// destructure at require time.
//
// WHY THE DEFAULTS SNAPSHOT IS TAKEN AT REQUIRE TIME
// Once an override has been applied, the config module no longer knows what
// it originally said, so "reset to default" would have nothing to reset TO.
// DEFAULTS below is deep-cloned the moment this module first loads, which is
// necessarily before any override can have been applied.
const knex = require('../db/knex');
const { SECTIONS, FIELDS, NAMESPACES } = require('../config/tunables');

// Deep clone that also survives the RegExp values in CATEGORY_CAPACITY_SEED
// (structuredClone throws on them, JSON round-tripping silently eats them).
function deepClone(value) {
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepClone(v)]));
  }
  return value;
}

// Pristine copy of every namespace, taken before anything can have been
// applied. Read-only from here on.
const DEFAULTS = Object.fromEntries(
  Object.entries(NAMESPACES).map(([ns, mod]) => [ns, deepClone(mod)])
);

// --- path helpers --------------------------------------------------------

function readPath(root, segments) {
  return segments.reduce((node, seg) => (node == null ? undefined : node[seg]), root);
}

// Writes only the LEAF. Never replaces an intermediate object, because other
// modules hold direct references to those (routes/visits.js destructures
// VISIT_TYPES, for instance) and swapping one out would leave them pointing
// at an orphan.
function writePath(root, segments, value) {
  const parent = readPath(root, segments.slice(0, -1));
  parent[segments[segments.length - 1]] = value;
}

function splitKey(key) {
  const [ns, ...rest] = key.split('.');
  return { ns, segments: rest };
}

function defaultFor(key) {
  const { ns, segments } = splitKey(key);
  return deepClone(readPath(DEFAULTS[ns], segments));
}

function liveValue(key) {
  const { ns, segments } = splitKey(key);
  return readPath(NAMESPACES[ns], segments);
}

// --- the category-seed rule table ----------------------------------------
//
// In code this is an ordered list of [RegExp, level] pairs, and the patterns
// happen to use `|` alternation and nothing else. The UI edits it as a list
// of plain keywords instead, because asking someone to hand-write a regular
// expression into a settings box is a good way to get a server that won't
// start. These two functions convert between the shapes losslessly for every
// pattern the defaults actually use.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// [RegExp, level][] -> [{ keywords: string[], level }][]
function seedToRules(seed) {
  return seed.map(([pattern, level]) => ({
    keywords: pattern.source.split('|').map((k) => k.replace(/\\(.)/g, '$1')),
    level,
  }));
}

// [{ keywords, level }][] -> [RegExp, level][]
function rulesToSeed(rules) {
  return rules.map((rule) => [
    new RegExp(rule.keywords.map(escapeRegExp).join('|'), 'i'),
    rule.level,
  ]);
}

// The wire shape for a value: everything is plain JSON by the time it reaches
// the client or the settings table.
function toWire(key, value) {
  return key === 'scheduling.CATEGORY_CAPACITY_SEED' ? seedToRules(value) : value;
}

function fromWire(key, value) {
  return key === 'scheduling.CATEGORY_CAPACITY_SEED' ? rulesToSeed(value) : value;
}

// --- validation ----------------------------------------------------------

// Turns whatever arrived over the wire into a legal value for `field`, or
// throws with a message written for the person who typed it. Returns the
// value in WIRE shape; the caller converts to config shape via fromWire.
function coerce(field, raw) {
  const label = field.label;

  switch (field.type) {
    case 'integer':
    case 'number': {
      const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${label} must be a number`);
      if (field.type === 'integer' && !Number.isInteger(n)) throw new Error(`${label} must be a whole number`);
      if (field.min != null && n < field.min) throw new Error(`${label} cannot be below ${field.min}`);
      if (field.max != null && n > field.max) throw new Error(`${label} cannot be above ${field.max}`);
      return n;
    }

    case 'select': {
      const allowed = field.options.map((o) => o.value);
      if (!allowed.includes(raw)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
      return raw;
    }

    case 'text': {
      const s = String(raw ?? '').trim();
      if (!s) throw new Error(`${label} cannot be empty`);
      if (field.maxLength && s.length > field.maxLength) throw new Error(`${label} is too long`);
      return s;
    }

    case 'categories': {
      if (!Array.isArray(raw)) throw new Error(`${label} must be a list`);
      const names = raw.map((v) => String(v).trim()).filter(Boolean);
      return [...new Set(names)];
    }

    case 'seedTable': {
      if (!Array.isArray(raw)) throw new Error(`${label} must be a list of rules`);
      const allowed = field.options.map((o) => o.value);
      return raw.map((rule, i) => {
        const keywords = (Array.isArray(rule?.keywords) ? rule.keywords : [])
          .map((k) => String(k).trim())
          .filter(Boolean);
        if (keywords.length === 0) throw new Error(`Rule ${i + 1} needs at least one keyword`);
        if (!allowed.includes(rule?.level)) throw new Error(`Rule ${i + 1} needs a capacity level`);
        return { keywords: [...new Set(keywords)], level: rule.level };
      });
    }

    default:
      throw new Error(`Unsupported tunable type "${field.type}"`);
  }
}

// Rules that involve more than one field, checked against the values that
// WOULD be in effect after a save. Each of these is called out in the
// affected field's own help text, so the message here just needs to name the
// conflict rather than re-explain it.
const CROSS_CHECKS = [
  {
    keys: ['scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN', 'scheduling.CAPACITY_THRESHOLDS.HIGH_MIN'],
    check: (v) => v['scheduling.CAPACITY_THRESHOLDS.HIGH_MIN'] > v['scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN'],
    message: 'High capacity must start above where medium starts, otherwise no place can ever be medium.',
  },
  {
    keys: [
      'scheduling.CAPACITY_SEED_VALUES.major',
      'scheduling.CAPACITY_SEED_VALUES.strong',
      'scheduling.CAPACITY_SEED_VALUES.steady',
      'scheduling.CAPACITY_SEED_VALUES.occasional',
    ],
    check: (v) =>
      v['scheduling.CAPACITY_SEED_VALUES.major'] > v['scheduling.CAPACITY_SEED_VALUES.strong'] &&
      v['scheduling.CAPACITY_SEED_VALUES.strong'] > v['scheduling.CAPACITY_SEED_VALUES.steady'] &&
      v['scheduling.CAPACITY_SEED_VALUES.steady'] > v['scheduling.CAPACITY_SEED_VALUES.occasional'],
    message: 'The four rating choices must decrease from major down to occasional, or the rating screen would offer a bigger source a smaller number.',
  },
  {
    keys: ['driveTime.SHORT_BAND_MAX_MILES', 'driveTime.MEDIUM_BAND_MAX_MILES'],
    check: (v) => v['driveTime.MEDIUM_BAND_MAX_MILES'] > v['driveTime.SHORT_BAND_MAX_MILES'],
    message: 'The medium distance band must end further out than the short band, otherwise the short band swallows it.',
  },
  {
    keys: ['routeOptimizer.MAX_OPTIMIZE_STOPS', 'routeOptimizer.MAX_TOPUP_STOPS'],
    check: (v) => v['routeOptimizer.MAX_TOPUP_STOPS'] >= v['routeOptimizer.MAX_OPTIMIZE_STOPS'],
    message: 'The absolute stop ceiling cannot be lower than the per-request cap, or the planner could never top a day up.',
  },
  {
    keys: ['relationship.RELATIONSHIP_THRESHOLDS.strong', 'relationship.RELATIONSHIP_THRESHOLDS.medium'],
    check: (v) => v['relationship.RELATIONSHIP_THRESHOLDS.strong'] > v['relationship.RELATIONSHIP_THRESHOLDS.medium'],
    message: 'Strong must start above medium, otherwise no relationship can ever read medium.',
  },
];

function runCrossChecks(pending) {
  // Every key's effective value: the pending edit if there is one, otherwise
  // whatever is live right now.
  const effective = (key) => (key in pending ? pending[key] : toWire(key, liveValue(key)));
  for (const rule of CROSS_CHECKS) {
    if (!rule.keys.some((k) => k in pending)) continue; // this save doesn't touch the rule
    const values = Object.fromEntries(rule.keys.map((k) => [k, effective(k)]));
    if (!rule.check(values)) throw new Error(rule.message);
  }
}

// --- applying ------------------------------------------------------------

function applyOne(key, wireValue) {
  const { ns, segments } = splitKey(key);
  writePath(NAMESPACES[ns], segments, fromWire(key, wireValue));
}

function resetOne(key) {
  const { ns, segments } = splitKey(key);
  writePath(NAMESPACES[ns], segments, defaultFor(key));
}

// --- public API ----------------------------------------------------------

// Reads every saved override and writes it into the live config modules.
// Called once from index.js before the server starts listening.
//
// A row whose key is no longer in the registry, or whose value no longer
// validates (bounds tightened in a later version, say), is skipped with a
// warning rather than thrown: a stale settings row must never be the reason
// the server won't boot.
async function loadSettings() {
  let rows;
  try {
    rows = await knex('settings').select('key', 'value');
  } catch (err) {
    console.error('Could not read settings, running on defaults:', err.message);
    return { applied: 0, skipped: 0 };
  }

  let applied = 0;
  let skipped = 0;
  for (const row of rows) {
    const field = FIELDS.get(row.key);
    if (!field) {
      console.warn(`Ignoring saved setting for unknown tunable "${row.key}"`);
      skipped += 1;
      continue;
    }
    try {
      applyOne(row.key, coerce(field, JSON.parse(row.value)));
      applied += 1;
    } catch (err) {
      console.warn(`Ignoring invalid saved setting "${row.key}": ${err.message}`);
      skipped += 1;
    }
  }
  return { applied, skipped };
}

// Everything the settings page needs to render: the catalogue, the value in
// effect for each tunable, its default, and who last changed it.
async function getSettingsView() {
  const rows = await knex('settings as s')
    .leftJoin('users as u', 'u.id', 's.updated_by')
    .select('s.key', 's.updated_at', 'u.name as updated_by_name');
  const meta = Object.fromEntries(rows.map((r) => [r.key, { updatedAt: r.updated_at, updatedByName: r.updated_by_name }]));

  const values = {};
  const defaults = {};
  for (const key of FIELDS.keys()) {
    values[key] = toWire(key, liveValue(key));
    defaults[key] = toWire(key, defaultFor(key));
  }

  return { sections: SECTIONS, values, defaults, meta };
}

// Validates and saves a batch of changes, then applies them immediately.
// All-or-nothing: if any single value is rejected, nothing is written, so a
// typo in one box can't half-apply a page of edits.
//
// A value that matches the shipped default DELETES its row rather than
// storing it. That keeps the table a record of genuine divergence from the
// defaults, and means a later change to a default is picked up by everyone
// who never disagreed with it.
async function saveSettings(updates, userId) {
  const keys = Object.keys(updates || {});
  if (keys.length === 0) return { changed: 0 };

  const validated = {};
  for (const key of keys) {
    const field = FIELDS.get(key);
    if (!field) throw Object.assign(new Error(`Unknown setting "${key}"`), { status: 400 });
    try {
      validated[key] = coerce(field, updates[key]);
    } catch (err) {
      throw Object.assign(err, { status: 400 });
    }
  }

  try {
    runCrossChecks(validated);
  } catch (err) {
    throw Object.assign(err, { status: 400 });
  }

  const now = new Date().toISOString();
  await knex.transaction(async (trx) => {
    for (const [key, value] of Object.entries(validated)) {
      const isDefault = JSON.stringify(value) === JSON.stringify(toWire(key, defaultFor(key)));
      if (isDefault) {
        await trx('settings').where({ key }).del();
        continue;
      }
      const payload = { key, value: JSON.stringify(value), updated_by: userId ?? null, updated_at: now };
      const updated = await trx('settings').where({ key }).update(payload);
      if (!updated) await trx('settings').insert(payload);
    }
  });

  // Only touch the live config after the write has committed, so a failed
  // transaction can't leave the running server disagreeing with the database.
  for (const [key, value] of Object.entries(validated)) {
    if (JSON.stringify(value) === JSON.stringify(toWire(key, defaultFor(key)))) resetOne(key);
    else applyOne(key, value);
  }

  return { changed: keys.length };
}

// Puts one or more tunables back to their shipped defaults. `keys` omitted
// means all of them.
async function resetSettings(keys) {
  const targets = keys && keys.length ? keys : [...FIELDS.keys()];
  const unknown = targets.filter((k) => !FIELDS.has(k));
  if (unknown.length) throw Object.assign(new Error(`Unknown setting "${unknown[0]}"`), { status: 400 });

  await knex('settings').whereIn('key', targets).del();
  targets.forEach(resetOne);
  return { reset: targets.length };
}

module.exports = {
  loadSettings,
  getSettingsView,
  saveSettings,
  resetSettings,
  // exported for tests
  DEFAULTS,
  coerce,
  seedToRules,
  rulesToSeed,
  runCrossChecks,
  defaultFor,
  liveValue,
};
