// ROADS — the static inter-town road graph (js/sim/roads.ts) + the steering blend
// (withRoad inside the caravan/arbitrage/expedition fills). Asserts:
//   1. the graph is a spanning set: every town in TOWNS.centers is connected;
//   2. roadPull returns a sane, finite, ON-segment point biased AHEAD toward the
//      destination (progress, never backtrack), and null far off-route;
//   3. a caravan-style fill on a LONG leg blends target + road attractors (road
//      weaker — preference, not constraint), and a SHORT leg stays single/straight;
//   4. an actual steered walk along a route arrives without a heading reversal
//      (the ahead-bias keeps the blended field oscillation-free) and never NaNs.
// Pure unit checks over the static graph + the steering substrate — no full sim.

import * as THREE from 'three';
import { ROADS, roadPull, roadDistance } from '../../js/sim/roads.js';
import { TOWNS, STEER } from '../../js/sim/simconfig.js';
import { STEER_FILLS, steer } from '../../js/sim/agent/steer.js';

// distance from (x,z) to segment s — independent reimplementation for the assert
function distToSeg(x, z, s) {
  const dx = s.bx - s.ax, dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  let t = ((x - s.ax) * dx + (z - s.az) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(s.ax + dx * t - x, s.az + dz * t - z);
}

// a minimal steerable agent stub: steer()/_stepAlong only touch pos + the two
// fighter motor calls on this path (no profession/economy — the freeze lesson).
function stubAgent(x, z) {
  return {
    pos: new THREE.Vector3(x, 0, z),
    fighter: { setMoving() {}, setFacing() {} },
    caravanRun: null,
  };
}

export function roadsTest(ok) {
  const n = TOWNS.centers.length;

  // 1 — spanning set: n-1 segments, union-find collapses every town to one root
  ok(ROADS.length === n - 1, `road graph is a spanning tree (${ROADS.length} segments for ${n} towns)`);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const s of ROADS) parent[find(s.a)] = find(s.b);
  const roots = new Set();
  for (let i = 0; i < n; i++) roots.add(find(i));
  ok(roots.size === 1, 'road graph connects ALL towns (one component)');
  ok(ROADS.every((s) => Number.isFinite(s.ax + s.az + s.bx + s.bz + s.len) && s.len > 1),
    'every segment is finite + non-degenerate');

  // 2 — roadPull: 10m laterally off the first segment's midpoint, bound for its b-end
  const s0 = ROADS[0];
  const ux = (s0.bx - s0.ax) / s0.len, uz = (s0.bz - s0.az) / s0.len;
  const mx = (s0.ax + s0.bx) / 2, mz = (s0.az + s0.bz) / 2;
  const px = mx - uz * 10, pz = mz + ux * 10;                 // 10m off the centreline
  const rp = roadPull(px, pz, s0.bx, s0.bz, STEER.roadSnapDist);
  ok(!!rp && Number.isFinite(rp.x) && Number.isFinite(rp.z), 'roadPull returns a finite point near the route');
  if (rp) {
    ok(distToSeg(rp.x, rp.z, s0) < 0.5, 'the pulled point lies ON the segment');
    ok(Math.hypot(s0.bx - rp.x, s0.bz - rp.z) < Math.hypot(s0.bx - px, s0.bz - pz),
      'the pulled point is biased AHEAD (closer to the destination than I am)');
  }
  ok(roadPull(mx - uz * 200, mz + ux * 200, s0.bx, s0.bz, STEER.roadSnapDist) === null,
    'far off-route roadPull returns null (off-road legs stay straight)');
  ok(roadPull(NaN, pz, s0.bx, s0.bz, STEER.roadSnapDist) === null, 'non-finite input is guarded (null, no throw)');

  // 3 — the caravan fill: a LONG leg near a road blends two finite attractors
  const a = stubAgent(px, pz);
  a.caravanRun = { target: { x: s0.bx, z: s0.bz } };
  const f = STEER_FILLS.caravan(a, {});
  ok(!!f && f.attractors && f.attractors.length === 2, 'far caravan leg fields target + road attractors');
  if (f && f.attractors) {
    ok(f.attractors.every((at) => at && Number.isFinite(at.pos.x) && Number.isFinite(at.pos.z) && at.weight > 0),
      'caravan field forces are all finite (no NaN attractor)');
    ok(f.attractors[1].weight === STEER.wRoad && f.attractors[1].weight < f.attractors[0].weight,
      'road pull is the WEAKER attractor (preference, not constraint)');
  }
  // …and a SHORT leg (under roadMinDist) stays a single straight attractor
  const b = stubAgent(s0.bx - ux * 20, s0.bz - uz * 20);
  b.caravanRun = { target: { x: s0.bx, z: s0.bz } };
  const fShort = STEER_FILLS.caravan(b, {});
  ok(!!fShort && fShort.attractors.length === 1, 'short local hop keeps the plain single attractor');

  // 4 — walk the route: drive steer() with the caravan fill from just outside the
  // home town toward the far end; the blended heading must never REVERSE (the
  // ahead-bias guarantee), positions stay finite, and the body actually arrives.
  const w = stubAgent(s0.ax + ux * 20 - uz * 12, s0.az + uz * 20 + ux * 12);
  w.caravanRun = { target: { x: s0.bx, z: s0.bz } };
  let flips = 0, prevX = 0, prevZ = 0, distSum = 0, samples = 0, bad = false;
  for (let i = 0; i < 6000; i++) {
    const ox = w.pos.x, oz = w.pos.z;
    const arrived = steer(w, STEER_FILLS.caravan(w, {}), 0.1);
    if (!Number.isFinite(w.pos.x) || !Number.isFinite(w.pos.z)) { bad = true; break; }
    const sx = w.pos.x - ox, sz = w.pos.z - oz;
    const sl = Math.hypot(sx, sz), pl = Math.hypot(prevX, prevZ);
    if (sl > 1e-4 && pl > 1e-4 && (sx * prevX + sz * prevZ) / (sl * pl) < -0.5) flips++;
    if (sl > 1e-4) { prevX = sx; prevZ = sz; }
    distSum += roadDistance(w.pos.x, w.pos.z); samples++;
    if (arrived || Math.hypot(s0.bx - w.pos.x, s0.bz - w.pos.z) < 20) break;
  }
  ok(!bad, 'steered route walk never NaNs a position');
  ok(flips === 0, `heading never reverses along the route (${flips} flips)`);
  ok(Math.hypot(s0.bx - w.pos.x, s0.bz - w.pos.z) < 30, 'the walker actually reaches the destination town');
  ok(samples > 0 && distSum / samples < 12, `the walk tracks the road (mean off-route ${(distSum / samples).toFixed(1)}m)`);
}
