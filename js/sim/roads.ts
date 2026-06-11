// TRADE ROADS — the static inter-town road graph. The four town cores (TOWNS.centers)
// are linked by a minimum spanning set of straight segments, hand-derived ONCE at
// module init (Kruskal over the handful of town pairs — zero runtime cost). Roads make
// long travel LEGIBLE: caravans, arbitrage haulers and expedition marches BLEND a mild
// attractor toward the nearest route point (steer.js), so travellers bunch on visible
// arteries and ambush/encounter geography emerges from geometry instead of open-field
// straight lines. A preference, never a constraint — off-route is always allowed.
//
// EPISTEMIC NOTE: this is shared STATIC geography, exactly like arena.js's LANDMARKS
// and the mental map — derived from config at load, immutable, never a roster read.
// Cognition (the steer fills) may query it freely; it is in the epistemic scan.

import { TOWNS, STEER } from './simconfig.js';

/** One straight road segment between town centres `a` and `b` (indices into
 *  TOWNS.centers), with its endpoints + length precomputed for the hot query. */
export interface RoadSegment {
  a: number; b: number;
  ax: number; az: number;
  bx: number; bz: number;
  len: number;
}

// Build the spanning set: sort all town-pair edges by length, union-find accept the
// shortest that bridge components (Kruskal). With n towns this yields n-1 segments
// connecting ALL of them — each town reaches its nearest neighbour(s), no orphans.
function buildRoadGraph(): RoadSegment[] {
  const centers = (TOWNS.centers || []) as number[][];
  const n = centers.length;
  if (n < 2) return [];                          // a one-town world has no roads
  const edges: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(centers[j][0] - centers[i][0], centers[j][1] - centers[i][1]);
      if (Number.isFinite(d) && d > 1) edges.push({ i, j, d });   // skip degenerate pairs
    }
  }
  edges.sort((p, q) => p.d - q.d);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const out: RoadSegment[] = [];
  for (const e of edges) {
    const ri = find(e.i), rj = find(e.j);
    if (ri === rj) continue;                     // already routed — keep the graph a tree
    parent[ri] = rj;
    out.push({
      a: e.i, b: e.j,
      ax: centers[e.i][0], az: centers[e.i][1],
      bx: centers[e.j][0], bz: centers[e.j][1],
      len: e.d,
    });
    if (out.length === n - 1) break;             // spanning tree complete
  }
  return out;
}

/** The road graph — built once at module init from TOWNS.centers. */
export const ROADS: RoadSegment[] = buildRoadGraph();

/** Distance from (x,z) to the nearest point on any road segment (Infinity when the
 *  world has no roads). Cheap (a few segments); used by tests/telemetry. */
export function roadDistance(x: number, z: number): number {
  let best = Infinity;
  for (const s of ROADS) {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    if (!(len2 > 0)) continue;
    let t = ((x - s.ax) * dx + (z - s.az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
    if (d < best) best = d;
  }
  return best;
}

// roadPull(x, z, tx, tz, maxDist) — the steering query: travelling from (x,z) toward
// (tx,tz), return the nearest useful point ON a road, or null (off-route is fine).
// The returned point is biased AHEAD along the segment toward the destination
// (STEER.roadAhead metres), so the pull always has a forward component — a traveller
// drifts onto the road and walks ALONG it, never gets yanked backward, never
// oscillates around the centreline. Guards: non-finite inputs → null; a candidate
// that would not make net progress toward the target is rejected (so an irrelevant
// road never out-pulls the journey). NEVER throws, NEVER returns a NaN point.
export function roadPull(
  x: number, z: number, tx: number, tz: number, maxDist = Infinity,
): { x: number; z: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(z) ||
      !Number.isFinite(tx) || !Number.isFinite(tz)) return null;
  const dTarget = Math.hypot(tx - x, tz - z);
  let best: { x: number; z: number } | null = null, bestD = maxDist;
  for (const s of ROADS) {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    if (!(len2 > 0)) continue;                   // guard a degenerate segment
    // nearest point on the segment to ME (clamped param t in [0,1])
    let t = ((x - s.ax) * dx + (z - s.az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const nx = s.ax + dx * t, nz = s.az + dz * t;
    const d = Math.hypot(nx - x, nz - z);
    if (d >= bestD) continue;                    // farther than the best route so far
    // bias AHEAD: advance t in whichever direction along the segment closes on the
    // target, by roadAhead metres (clamped to the segment ends — the town gate).
    const sign = ((tx - nx) * dx + (tz - nz) * dz) >= 0 ? 1 : -1;
    const ta = Math.max(0, Math.min(1, t + sign * ((STEER.roadAhead || 16) / Math.sqrt(len2))));
    const px = s.ax + dx * ta, pz = s.az + dz * ta;
    // progress gate: the ahead-point must be strictly closer to the destination than
    // I am (a small slack absorbs the lateral step onto the road near a route's end).
    if (Math.hypot(tx - px, tz - pz) > dTarget - 1) continue;
    best = { x: px, z: pz }; bestD = d;
  }
  return best;
}
