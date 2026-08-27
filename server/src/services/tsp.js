// Dependency-free route optimizer - replaces OSRM's /trip endpoint (see
// matrixCache.js for what replaces /table and the fixed-order /route call).
// Deterministic: the same inputs always produce the same stop order, which
// matters when a rep re-opens a route and expects to see what they left.
//
// Two independent concerns:
//   1. The COST MATRIX - how far apart two places are. matrixCache.js owns
//      this at runtime (cached real distances, geometric fallback for gaps).
//   2. The SOLVER - what order to visit them in. That's everything below.

const EARTH_R = 6371000; // meters

// Great-circle distance. Underestimates real driving in a grid city - see
// gridMeters below, which is what matrixCache.js's fallback actually uses.
function haversineMeters(a, b) {
  const R = Math.PI / 180;
  const dLat = (b.lat - a.lat) * R;
  const dLng = (b.lng - a.lng) * R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

// Manhattan distance on the local tangent plane, scaled by a detour factor.
// For a north-south/east-west street grid (Lincoln, NE) this tracks real
// driving distance far better than haversine. `detour` is calibrated against
// real OSRM distances - see config/matrixCache.js.
function gridMeters(a, b, detour = 1.0) {
  const R = Math.PI / 180;
  const meanLat = ((a.lat + b.lat) / 2) * R;
  const dy = (b.lat - a.lat) * R * EARTH_R;
  const dx = (b.lng - a.lng) * R * EARTH_R * Math.cos(meanLat);
  return (Math.abs(dx) + Math.abs(dy)) * detour;
}

// Build an n x n symmetric cost matrix from coordinates. Only used when no
// precomputed matrix is passed in (matrixCache.js always passes one).
function buildMatrix(points, metric = (a, b) => gridMeters(a, b)) {
  const n = points.length;
  const d = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = metric(points[i], points[j]);
      d[i][j] = v;
      d[j][i] = v;
    }
  }
  return d;
}

// @param points  Array<{lat, lng}>
// @param options.startIndex  index of the fixed first stop (default 0)
// @param options.endIndex    index of a fixed last stop, or null
// @param options.roundTrip   return to startIndex at the end
// @param options.matrix      precomputed costs (not assumed symmetric)
// @param options.metric      used only when matrix is null
// @param options.exactLimit  solve exactly at or below this many free stops
// @param options.restarts    greedy restarts for the heuristic path
// @returns {order: number[], cost: number, exact: boolean} - order is
//   indices into `points`, in visit order (order[0] === startIndex always).
function solveRoute(points, options = {}) {
  const {
    startIndex = 0,
    endIndex = null,
    roundTrip = false,
    matrix = null,
    metric = (a, b) => gridMeters(a, b),
    exactLimit = 12,
    restarts = 12,
  } = options;

  const n = points.length;
  if (n === 0) return { order: [], cost: 0, exact: true };
  if (n === 1) return { order: [0], cost: 0, exact: true };

  const D = matrix ?? buildMatrix(points, metric);

  // Canonical layout: [start, ...free, end?]
  const free = [];
  for (let i = 0; i < n; i++) {
    if (i === startIndex) continue;
    if (endIndex !== null && i === endIndex) continue;
    free.push(i);
  }
  const canon = [startIndex, ...free];
  const pinEnd = endIndex !== null;
  if (pinEnd) canon.push(endIndex);

  const k = canon.length;
  const d = Array.from({ length: k }, (_, i) => {
    const row = new Float64Array(k);
    for (let j = 0; j < k; j++) row[j] = D[canon[i]][canon[j]];
    return row;
  });

  let tour;
  let exact = false;

  if (free.length <= exactLimit) {
    tour = heldKarp(d, k, roundTrip, pinEnd);
    exact = true;
  } else {
    // Deterministic multi-start: force the first hop to each of the N nearest
    // neighbours of the start, improve each, keep the best.
    const movable = [];
    for (let i = 1; i < k; i++) if (!(pinEnd && i === k - 1)) movable.push(i);
    movable.sort((a, b) => d[0][a] - d[0][b]);
    const seeds = [null, ...movable.slice(0, restarts)];

    let best = null;
    let bestCost = Infinity;
    for (const seed of seeds) {
      let t = greedyTour(d, k, pinEnd, seed);
      t = twoOpt(d, t, roundTrip, pinEnd);
      t = orOpt(d, t, roundTrip, pinEnd);
      t = twoOpt(d, t, roundTrip, pinEnd);
      const c = tourCost(d, t, roundTrip);
      if (c < bestCost) {
        bestCost = c;
        best = t;
      }
    }
    tour = best;
  }

  return {
    order: tour.map((li) => canon[li]),
    cost: tourCost(d, tour, roundTrip),
    exact,
  };
}

function tourCost(d, t, roundTrip) {
  let s = 0;
  for (let i = 0; i + 1 < t.length; i++) s += d[t[i]][t[i + 1]];
  if (roundTrip && t.length > 1) s += d[t[t.length - 1]][t[0]];
  return s;
}

// Nearest-neighbour construction, optionally forcing the first hop.
function greedyTour(d, k, pinEnd, forcedFirst) {
  const endIdx = pinEnd ? k - 1 : -1;
  const unvisited = new Set();
  for (let i = 1; i < k; i++) if (i !== endIdx) unvisited.add(i);

  const t = [0];
  let cur = 0;
  if (forcedFirst != null && unvisited.has(forcedFirst)) {
    t.push(forcedFirst);
    unvisited.delete(forcedFirst);
    cur = forcedFirst;
  }
  while (unvisited.size) {
    let best = -1;
    let bestD = Infinity;
    for (const j of unvisited) {
      if (d[cur][j] < bestD) {
        bestD = d[cur][j];
        best = j;
      }
    }
    t.push(best);
    unvisited.delete(best);
    cur = best;
  }
  if (pinEnd) t.push(endIdx);
  return t;
}

// 2-opt: reverse a segment when it shortens the tour. Uncrosses the route.
function twoOpt(d, t, roundTrip, pinEnd) {
  const k = t.length;
  const lastMovable = pinEnd ? k - 2 : k - 1;
  const succ = (p) => (p + 1 < k ? t[p + 1] : roundTrip ? t[0] : null);

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i <= lastMovable; i++) {
      for (let j = i + 1; j <= lastMovable; j++) {
        const a = t[i - 1];
        const b = t[i];
        const c = t[j];
        const e = succ(j);
        const delta =
          e === null
            ? d[a][c] - d[a][b]
            : d[a][c] + d[b][e] - d[a][b] - d[c][e];
        if (delta < -1e-9) {
          reverseInPlace(t, i, j);
          improved = true;
        }
      }
    }
  }
  return t;
}

// Or-opt: relocate a run of 1-3 stops elsewhere in the tour (either
// orientation). Catches the "one stop stranded on the wrong loop" case that
// 2-opt alone leaves behind.
function orOpt(d, t, roundTrip, pinEnd, maxSeg = 3) {
  let improved = true;
  while (improved) {
    improved = false;
    const k = t.length;
    const lastMovable = pinEnd ? k - 2 : k - 1;

    outer: for (let L = 1; L <= maxSeg; L++) {
      for (let i = 1; i + L - 1 <= lastMovable; i++) {
        const seg = t.slice(i, i + L);
        const rest = t.slice(0, i).concat(t.slice(i + L));
        const insertLimit = pinEnd ? rest.length - 1 : rest.length;

        let bestCost = tourCost(d, t, roundTrip) - 1e-9;
        let bestTour = null;

        for (let p = 1; p <= insertLimit; p++) {
          if (p === i) continue; // no-op
          for (const s of [seg, [...seg].reverse()]) {
            const cand = [...rest.slice(0, p), ...s, ...rest.slice(p)];
            const c = tourCost(d, cand, roundTrip);
            if (c < bestCost) {
              bestCost = c;
              bestTour = cand;
            }
          }
        }
        if (bestTour) {
          t = bestTour;
          improved = true;
          break outer;
        }
      }
    }
  }
  return t;
}

// Held-Karp exact DP. O(2^m * m^2) over m free stops.
function heldKarp(d, k, roundTrip, pinEnd) {
  const endIdx = pinEnd ? k - 1 : -1;
  const free = [];
  for (let i = 1; i < k; i++) if (i !== endIdx) free.push(i);
  const m = free.length;

  if (m === 0) {
    const t = [0];
    if (pinEnd) t.push(endIdx);
    return t;
  }

  const size = 1 << m;
  const dp = new Float64Array(size * m).fill(Infinity);
  const par = new Int16Array(size * m).fill(-1);

  for (let j = 0; j < m; j++) dp[(1 << j) * m + j] = d[0][free[j]];

  for (let mask = 1; mask < size; mask++) {
    for (let j = 0; j < m; j++) {
      if (!(mask & (1 << j))) continue;
      const cur = dp[mask * m + j];
      if (cur === Infinity) continue;
      for (let q = 0; q < m; q++) {
        if (mask & (1 << q)) continue;
        const nm = mask | (1 << q);
        const nd = cur + d[free[j]][free[q]];
        if (nd < dp[nm * m + q]) {
          dp[nm * m + q] = nd;
          par[nm * m + q] = j;
        }
      }
    }
  }

  const full = size - 1;
  let best = Infinity;
  let bestJ = 0;
  for (let j = 0; j < m; j++) {
    let c = dp[full * m + j];
    if (c === Infinity) continue;
    if (roundTrip) c += d[free[j]][0];
    else if (pinEnd) c += d[free[j]][endIdx];
    if (c < best) {
      best = c;
      bestJ = j;
    }
  }

  const rev = [];
  let mask = full;
  let j = bestJ;
  while (j !== -1) {
    rev.push(free[j]);
    const pj = par[mask * m + j];
    mask ^= 1 << j;
    j = pj;
  }
  rev.reverse();

  const t = [0, ...rev];
  if (pinEnd) t.push(endIdx);
  return t;
}

function reverseInPlace(t, i, j) {
  while (i < j) {
    const tmp = t[i];
    t[i] = t[j];
    t[j] = tmp;
    i++;
    j--;
  }
}

module.exports = { haversineMeters, gridMeters, buildMatrix, solveRoute };
