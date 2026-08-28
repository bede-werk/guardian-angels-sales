const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { solveRoute, buildMatrix, gridMeters } = require('./tsp');

// Deterministic PRNG (mulberry32) - reproducible "random" fixtures, no
// dependency on Math.random's seed.
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPoints(n, seed) {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => ({
    lat: 40.7 + rand() * 0.2,
    lng: -96.8 + rand() * 0.2,
  }));
}

function tourCost(matrix, order, roundTrip) {
  let s = 0;
  for (let i = 0; i + 1 < order.length; i++) s += matrix[order[i]][order[i + 1]];
  if (roundTrip && order.length > 1) s += matrix[order[order.length - 1]][order[0]];
  return s;
}

// Exhaustive search over every permutation of the free (non-fixed) indices -
// the ground truth solveRoute's Held-Karp path (exactLimit default 12) is
// checked against below exactLimit.
function bruteForceBest(matrix, points, { startIndex, endIndex, roundTrip }) {
  const free = [];
  for (let i = 0; i < points.length; i++) {
    if (i === startIndex) continue;
    if (endIndex !== null && i === endIndex) continue;
    free.push(i);
  }

  let best = Infinity;
  permute(free, (perm) => {
    const order = [startIndex, ...perm, ...(endIndex !== null ? [endIndex] : [])];
    const cost = tourCost(matrix, order, roundTrip);
    if (cost < best) best = cost;
  });
  return best;
}

function permute(arr, visit, acc = []) {
  if (arr.length === 0) {
    visit(acc);
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    permute(rest, visit, [...acc, arr[i]]);
  }
}

describe('solveRoute - determinism', () => {
  test('same input produces the same order across 100 consecutive runs', () => {
    const points = randomPoints(9, 42);
    const matrix = buildMatrix(points);
    const first = solveRoute(points, { matrix });
    for (let i = 0; i < 100; i++) {
      const result = solveRoute(points, { matrix });
      assert.deepEqual(result.order, first.order, `run ${i} diverged from run 0`);
      assert.equal(result.cost, first.cost);
    }
  });

  test('same input produces the same order on the heuristic path too (>exactLimit free stops)', () => {
    const points = randomPoints(16, 7);
    const matrix = buildMatrix(points);
    const first = solveRoute(points, { matrix, exactLimit: 12 });
    assert.equal(first.exact, false, 'this fixture must actually exercise the heuristic path');
    for (let i = 0; i < 100; i++) {
      const result = solveRoute(points, { matrix, exactLimit: 12 });
      assert.deepEqual(result.order, first.order, `run ${i} diverged from run 0`);
    }
  });
});

describe('solveRoute - matches brute-force optimum for small (<=7 stop) cases', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`seed ${seed}: 7 free stops, open path`, () => {
      const points = randomPoints(8, seed); // 1 start + 7 free
      const matrix = buildMatrix(points);
      const result = solveRoute(points, { startIndex: 0, endIndex: null, roundTrip: false, matrix });
      const best = bruteForceBest(matrix, points, { startIndex: 0, endIndex: null, roundTrip: false });

      assert.equal(result.exact, true, '7 free stops must stay within exactLimit (12) and solve exactly');
      assert.ok(Math.abs(result.cost - best) < 1e-6, `solveRoute cost ${result.cost} != brute-force optimum ${best}`);
    });

    test(`seed ${seed}: 7 free stops, round trip`, () => {
      const points = randomPoints(8, seed + 100);
      const matrix = buildMatrix(points);
      const result = solveRoute(points, { startIndex: 0, endIndex: null, roundTrip: true, matrix });
      const best = bruteForceBest(matrix, points, { startIndex: 0, endIndex: null, roundTrip: true });

      assert.ok(Math.abs(result.cost - best) < 1e-6, `solveRoute cost ${result.cost} != brute-force optimum ${best}`);
    });

    test(`seed ${seed}: 7 free stops, fixed end`, () => {
      const points = randomPoints(9, seed + 200); // 1 start + 7 free + 1 fixed end
      const matrix = buildMatrix(points);
      const result = solveRoute(points, { startIndex: 0, endIndex: 8, roundTrip: false, matrix });
      const best = bruteForceBest(matrix, points, { startIndex: 0, endIndex: 8, roundTrip: false });

      assert.ok(Math.abs(result.cost - best) < 1e-6, `solveRoute cost ${result.cost} != brute-force optimum ${best}`);
    });
  }
});

describe('solveRoute - tour shape', () => {
  test('fixed start is always order[0]', () => {
    const points = randomPoints(10, 11);
    const matrix = buildMatrix(points);
    const result = solveRoute(points, { startIndex: 0, matrix });
    assert.equal(result.order[0], 0);
  });

  test('fixed end is honored: last position when open, second-to-last when round trip', () => {
    const points = randomPoints(10, 12);
    const matrix = buildMatrix(points);

    const open = solveRoute(points, { startIndex: 0, endIndex: 5, roundTrip: false, matrix });
    assert.equal(open.order[open.order.length - 1], 5);

    const round = solveRoute(points, { startIndex: 0, endIndex: 5, roundTrip: true, matrix });
    assert.equal(round.order[round.order.length - 1], 5, 'endIndex still pins the last position even under roundTrip');
  });

  test('every tour (open, round-trip, fixed-end, heuristic) visits every stop exactly once', () => {
    const points = randomPoints(20, 13);
    const matrix = buildMatrix(points);

    const cases = [
      { startIndex: 0, endIndex: null, roundTrip: false },
      { startIndex: 0, endIndex: null, roundTrip: true },
      { startIndex: 0, endIndex: 19, roundTrip: false },
      { startIndex: 0, endIndex: 19, roundTrip: true },
    ];
    for (const opts of cases) {
      const result = solveRoute(points, { ...opts, matrix });
      assert.equal(result.order.length, points.length, JSON.stringify(opts));
      assert.equal(new Set(result.order).size, points.length, `duplicate stop in tour for ${JSON.stringify(opts)}`);
    }
  });

  test('an empty or single-point input short-circuits without touching the solver', () => {
    assert.deepEqual(solveRoute([]), { order: [], cost: 0, exact: true });
    assert.deepEqual(solveRoute([{ lat: 40.8, lng: -96.7 }]), { order: [0], cost: 0, exact: true });
  });
});

// Real driving distances are ASYMMETRIC - d[i][j] !== d[j][i] for ~99% of the
// pairs matrixCache.js caches (one-way streets, divided roads, turn
// restrictions). twoOpt used to score a candidate reversal with the textbook
// symmetric two-edge delta, which ignores the internal edges a reversal also
// flips. On an asymmetric matrix that delta mispredicts the true cost change,
// so the loop kept accepting moves that made the tour worse and cycled between
// tours forever - a wedged event loop at 100% CPU rather than a wrong answer.
// These tests pin the fix. See twoOpt's header in tsp.js.
describe('asymmetric cost matrices', () => {
  // Every directed pair gets its own independent cost, so d[i][j] and d[j][i]
  // essentially never agree - the property the symmetric delta assumed away.
  function asymmetricMatrix(n, seed) {
    const rand = mulberry32(seed);
    const m = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) m[i][j] = 500 + rand() * 9500;
      }
    }
    return m;
  }

  // n above exactLimit so this exercises greedy + 2-opt + or-opt, not Held-Karp.
  const N = 16;

  // The regression itself. A failure here is a HANG, so the timeout is the
  // real assertion - it turns an infinite loop into a reported failure
  // instead of a test run that never finishes.
  test('the heuristic path always terminates and returns a valid tour', { timeout: 20000 }, () => {
    for (let seed = 1; seed <= 300; seed++) {
      const points = randomPoints(N, seed);
      const result = solveRoute(points, { matrix: asymmetricMatrix(N, seed) });
      assert.equal(result.exact, false, `seed ${seed} should take the heuristic path`);
      assert.equal(result.order.length, N, `seed ${seed} dropped stops`);
      assert.equal(new Set(result.order).size, N, `seed ${seed} repeated a stop`);
      assert.equal(result.order[0], 0, `seed ${seed} moved the start`);
    }
  });

  test('the reported cost matches the tour actually returned', { timeout: 20000 }, () => {
    for (let seed = 1; seed <= 100; seed++) {
      const matrix = asymmetricMatrix(N, seed);
      const result = solveRoute(randomPoints(N, seed), { matrix });
      assert.ok(
        Math.abs(result.cost - tourCost(matrix, result.order, false)) < 1e-6,
        `seed ${seed}: reported ${result.cost}, actual ${tourCost(matrix, result.order, false)}`
      );
    }
  });

  // The heuristic can't beat the optimum, and shouldn't wander far from it.
  // A solver accepting moves it mis-scores fails the upper bound.
  test('the heuristic stays between the exact optimum and a sane bound', { timeout: 20000 }, () => {
    const n = 11; // 10 free stops - inside exactLimit, so exact is available
    for (let seed = 1; seed <= 100; seed++) {
      const points = randomPoints(n, seed);
      const matrix = asymmetricMatrix(n, seed);
      const exact = solveRoute(points, { matrix });
      const heuristic = solveRoute(points, { matrix, exactLimit: 0 });
      assert.equal(exact.exact, true);
      assert.ok(heuristic.cost >= exact.cost - 1e-6, `seed ${seed}: heuristic beat the optimum`);
      assert.ok(heuristic.cost <= exact.cost * 1.5, `seed ${seed}: heuristic ${heuristic.cost} vs optimum ${exact.cost}`);
    }
  });
});

describe('gridMeters', () => {
  test('detour factor scales the raw grid distance linearly', () => {
    const a = { lat: 40.8, lng: -96.7 };
    const b = { lat: 40.81, lng: -96.71 };
    const base = gridMeters(a, b, 1.0);
    assert.ok(Math.abs(gridMeters(a, b, 1.5) - base * 1.5) < 1e-6);
  });

  test('distance from a point to itself is zero', () => {
    const a = { lat: 40.8, lng: -96.7 };
    assert.equal(gridMeters(a, a), 0);
  });
});
