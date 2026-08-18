const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS, SECTIONS, NAMESPACES } = require('../config/tunables');
const { coerce, seedToRules, rulesToSeed, runCrossChecks, defaultFor, liveValue, DEFAULTS } = require('./settings');

// Every test here is against the pure half of settings.js. The DB half
// (loadSettings/saveSettings/resetSettings) is a thin wrapper over these plus
// a knex call, and the interesting failure modes are all in the validation
// and the config-shape conversions below.

const field = (key) => FIELDS.get(key);

describe('the tunables registry', () => {
  test('every field resolves to a real value in its config module', () => {
    // config/tunables.js already asserts this at require time; this pins it
    // as a test so the failure reads as a test failure rather than a server
    // that won't boot.
    for (const key of FIELDS.keys()) {
      assert.notEqual(liveValue(key), undefined, `${key} has no value in its config module`);
    }
  });

  test('every field carries help text', () => {
    for (const [key, f] of FIELDS) {
      assert.ok(f.help && f.help.length > 20, `${key} needs a real explanation, not "${f.help}"`);
    }
  });

  test('every numeric field is bounded on both sides', () => {
    for (const [key, f] of FIELDS) {
      if (f.type !== 'number' && f.type !== 'integer') continue;
      assert.equal(typeof f.min, 'number', `${key} needs a min`);
      assert.equal(typeof f.max, 'number', `${key} needs a max`);
      const d = defaultFor(key);
      assert.ok(d >= f.min && d <= f.max, `${key}'s own default ${d} is outside its stated bounds`);
    }
  });

  test('every default validates against its own field definition', () => {
    for (const [key, f] of FIELDS) {
      if (f.type === 'seedTable') continue; // wire shape, covered separately below
      assert.doesNotThrow(() => coerce(f, defaultFor(key)), `${key}'s default is rejected by its own rules`);
    }
  });

  test('section and group ids are unique', () => {
    const sectionIds = SECTIONS.map((s) => s.id);
    assert.equal(new Set(sectionIds).size, sectionIds.length);
    const groupIds = SECTIONS.flatMap((s) => s.groups.map((g) => `${s.id}/${g.id}`));
    assert.equal(new Set(groupIds).size, groupIds.length);
  });
});

describe('coerce - numbers', () => {
  test('accepts an in-range number and a numeric string alike', () => {
    assert.equal(coerce(field('scheduling.HARD_FLOOR_DAYS'), 9), 9);
    assert.equal(coerce(field('scheduling.HARD_FLOOR_DAYS'), ' 9 '), 9);
  });

  test('rejects out-of-range values on both sides', () => {
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), -1), /cannot be below/);
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), 500), /cannot be above/);
  });

  test('rejects a fraction where a whole number is required', () => {
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), 5.5), /whole number/);
    // ...but allows one where the field is declared as a plain number
    assert.equal(coerce(field('scheduling.NEGLECT_MULTIPLIER'), 2.5), 2.5);
  });

  test('rejects text and NaN rather than storing a broken number', () => {
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), 'soon'), /must be a number/);
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), NaN), /must be a number/);
    assert.throws(() => coerce(field('scheduling.HARD_FLOOR_DAYS'), null), /must be a number/);
  });
});

describe('coerce - non-numeric types', () => {
  test('select only accepts a listed option', () => {
    assert.equal(coerce(field('visitTypes.DEFAULT_VISIT_TYPE'), 'check_in'), 'check_in');
    assert.throws(() => coerce(field('visitTypes.DEFAULT_VISIT_TYPE'), 'lunch'), /must be one of/);
  });

  test('text is trimmed and cannot be emptied', () => {
    assert.equal(coerce(field('routeOptimizer.OSRM_BASE_URL'), '  https://example.org  '), 'https://example.org');
    assert.throws(() => coerce(field('routeOptimizer.OSRM_BASE_URL'), '   '), /cannot be empty/);
  });

  test('category lists drop blanks and duplicates', () => {
    const out = coerce(field('relationship.FAST_DECAY_CATEGORIES'), ['Hospice', ' Hospice ', '', 'Hospitals']);
    assert.deepEqual(out, ['Hospice', 'Hospitals']);
  });

  test('a seed rule must have both keywords and a level', () => {
    const f = field('scheduling.CATEGORY_CAPACITY_SEED');
    assert.throws(() => coerce(f, [{ keywords: [], level: 'high' }]), /at least one keyword/);
    assert.throws(() => coerce(f, [{ keywords: ['clinic'], level: 'enormous' }]), /capacity level/);
    assert.deepEqual(coerce(f, [{ keywords: [' clinic ', 'clinic'], level: 'low' }]), [{ keywords: ['clinic'], level: 'low' }]);
  });
});

describe('category seed shape conversion', () => {
  test('round-trips the shipped default exactly, regexes and all', () => {
    const original = DEFAULTS.scheduling.CATEGORY_CAPACITY_SEED;
    const back = rulesToSeed(seedToRules(original));
    assert.deepEqual(
      back.map(([re, level]) => [re.source, re.flags, level]),
      original.map(([re, level]) => [re.source, re.flags, level])
    );
  });

  test('splits an alternation pattern into one keyword per branch', () => {
    const rules = seedToRules([[/senior living|memory care/i, 'high']]);
    assert.deepEqual(rules, [{ keywords: ['senior living', 'memory care'], level: 'high' }]);
  });

  test('escapes regex punctuation so a typed keyword is matched literally', () => {
    const [[re]] = rulesToSeed([{ keywords: ['a.b(c)'], level: 'low' }]);
    assert.ok(re.test('xxa.b(c)xx'), 'the literal string should match');
    assert.ok(!re.test('axb(c)'), 'the dot must not act as a wildcard');
  });

  test('built patterns are case-insensitive, matching the hand-written defaults', () => {
    const [[re]] = rulesToSeed([{ keywords: ['Hospital'], level: 'high' }]);
    assert.ok(re.test('Regional hospital campus'));
  });
});

describe('cross-field checks', () => {
  test('high capacity cannot start at or below medium', () => {
    assert.throws(
      () => runCrossChecks({ 'scheduling.CAPACITY_THRESHOLDS.HIGH_MIN': 4 }),
      /High capacity must start above/
    );
  });

  test('a pending pair is judged together, not against the live values', () => {
    assert.doesNotThrow(() =>
      runCrossChecks({
        'scheduling.CAPACITY_THRESHOLDS.MEDIUM_MIN': 2,
        'scheduling.CAPACITY_THRESHOLDS.HIGH_MIN': 4,
      })
    );
  });

  test('strong must stay above medium on the relationship scale', () => {
    assert.throws(() => runCrossChecks({ 'relationship.RELATIONSHIP_THRESHOLDS.strong': 1.0 }), /Strong must start above/);
  });

  test('the medium distance band must end beyond the short band', () => {
    assert.throws(() => runCrossChecks({ 'driveTime.MEDIUM_BAND_MAX_MILES': 0.5 }), /further out than the short band/);
  });

  test('the top-up ceiling cannot fall below the per-request cap', () => {
    assert.throws(() => runCrossChecks({ 'routeOptimizer.MAX_TOPUP_STOPS': 5 }), /cannot be lower than the per-request cap/);
  });

  test('a save that touches none of the paired keys is left alone', () => {
    assert.doesNotThrow(() => runCrossChecks({ 'scheduling.HARD_FLOOR_DAYS': 3 }));
  });
});

describe('defaults snapshot', () => {
  test('is a real copy, not a reference to the live config', () => {
    const live = NAMESPACES.scheduling;
    assert.notEqual(DEFAULTS.scheduling, live, 'DEFAULTS must not alias the live module');
    assert.notEqual(DEFAULTS.scheduling.CADENCE_DAYS, live.CADENCE_DAYS, 'nested objects must be cloned too');
    assert.deepEqual(DEFAULTS.scheduling.CADENCE_DAYS, live.CADENCE_DAYS);
  });

  test('defaultFor hands back a copy each time, so a caller cannot corrupt it', () => {
    const a = defaultFor('scheduling.CADENCE_DAYS.high.weak');
    assert.equal(typeof a, 'number');
    const seedA = defaultFor('scheduling.CATEGORY_CAPACITY_SEED');
    const seedB = defaultFor('scheduling.CATEGORY_CAPACITY_SEED');
    assert.notEqual(seedA, seedB);
    seedA.length = 0;
    assert.ok(defaultFor('scheduling.CATEGORY_CAPACITY_SEED').length > 0, 'mutating a returned default must not empty the snapshot');
  });
});
