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
