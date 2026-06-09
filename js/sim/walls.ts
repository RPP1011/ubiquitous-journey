// Town walls — a stone perimeter ringing each town's built core, with gates the
// townsfolk, caravans and the player pass through. Two cleanly-split concerns:
//
//   * COLLISION (pure, headless-safe): gateWaypoint(...) + collideWalls(...) read
//     ONLY config (TOWNS.wall + TOWNS.centers), so the fixed tick blocks movement
//     IDENTICALLY in the browser and in `bun test/headless.mjs`. The model is
//     RADIAL: collideWalls blocks a step CROSSING the ring (except at a gate) but
//     keeps the new angle so the body slides along the wall; gateWaypoint routes
//     goTo through the nearest gate so it reaches a doorway head-on rather than
//     deadlocking against the wall on the radial line to an off-to-the-side goal.
//
//   * VISUAL (browser-only): buildWalls(scene) raises the ring segments + gate
//     towers. Pure cosmetics — the sim never reads a mesh.
//
// Gates are angular gaps in the ring; no pathfinding graph is needed — the
// waypoint + radial slide funnel traffic through a gate the way the river's
// ford-deflection funnels it across the water.

import * as THREE from 'three';
import { terrainHeight } from '../arena.js';
import { TOWNS } from './simconfig.js';

// CONTAINED THREE TYPE-VIEW (the vendored three.module.js leaves Object3D transform props
// — .position/.rotation/.matrix — as runtime getters tsc can't see, and over-narrows the
// Mesh material param). This minimal local view covers exactly what buildWalls() touches;
// it adds nothing at runtime (mirrors js/sim/world.ts). The collision half of this module
// is pure config and stays fully typed.
interface Mat4Like { clone(): Mat4Like; }
interface Obj3DLike {
  position: { set(x: number, y: number, z: number): void };
  rotation: { set(x: number, y: number, z: number): void };
  matrix: Mat4Like;
  name: string;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
  updateMatrix(): void;
  add(o: Obj3DLike): void;
  setMatrixAt(i: number, m: Mat4Like): void;
}
// loose so any caller's scene-view (e.g. world.ts's own SceneLike) is assignable.
interface SceneLike { add(o: unknown): void; }
// the THREE namespace cast to the loose constructors this module uses (geometry/material
// args are opaque — only the returned object shape matters here).
interface T3Shape {
  Object3D: new () => Obj3DLike;
  Group: new () => Obj3DLike;
  Mesh: new (geo: unknown, mat: unknown) => Obj3DLike;
  InstancedMesh: new (geo: unknown, mat: unknown, count: number) => Obj3DLike;
  CylinderGeometry: new (...a: number[]) => unknown;
  BoxGeometry: new (...a: number[]) => unknown;
  MeshStandardMaterial: new (opts: Record<string, unknown>) => unknown;
}
const T3 = THREE as unknown as T3Shape;

// the wall config block (loosely keyed — TOWNS.wall is an optional sub-config object).
const WALL = ((TOWNS && TOWNS.wall) || {}) as Record<string, number>;
const RADIUS = WALL.radius || 0;                 // ring radius from each town centre (0 = disabled)
const HALF = (WALL.thickness || 2) / 2;          // collision band half-thickness
const HEIGHT = WALL.height || 5;
const THICK = WALL.thickness || 2;
const GATES = WALL.gates || 4;                    // count of evenly-spaced gate gaps
const GATE_HALF = RADIUS ? ((WALL.gateWidth || 8) / 2) / RADIUS : 0;   // gate half-angle (rad, arc≈width)
const UNDERGROUND_Y = -50;                        // below this y the mover is in a dungeon: walls don't apply

function centers(): number[][] {
  return (TOWNS && TOWNS.centers && TOWNS.centers.length) ? TOWNS.centers : [[0, 0]];
}

// Is the angle (rad) aligned with one of this ring's gate gaps?
function inGate(ang: number): boolean {
  for (let g = 0; g < GATES; g++) {
    const ga = (g / GATES) * Math.PI * 2;
    let d = Math.abs(ang - ga);
    if (d > Math.PI) d = Math.PI * 2 - d;
    if (d < GATE_HALF) return true;
  }
  return false;
}

// If the straight path from (px,pz) to the target (tx,tz) would cross a town
// wall (one endpoint inside the ring, the other outside), return a WAYPOINT to
// steer through instead: the gate opening nearest the outside endpoint's angle.
// A chord from any interior point to a gate stays interior (the disc is convex),
// so steering at the gate funnels the body cleanly through the doorway — head-on,
// not clipping the edge tangentially (which is where naive "aim at the goal"
// deadlocks at a narrow gate). Returns a shared {x,z} (copy if you keep it) or
// null when no wall lies between the two points. Pure config — headless-safe.
const _wp = { x: 0, z: 0 };
export function gateWaypoint(px: number, pz: number, tx: number, tz: number): { x: number; z: number } | null {
  if (!RADIUS) return null;
  const cs = centers();
  for (let i = 0; i < cs.length; i++) {
    const cx = cs[i][0], cz = cs[i][1];
    const rp = Math.hypot(px - cx, pz - cz);
    const rt = Math.hypot(tx - cx, tz - cz);
    const pIn = rp < RADIUS, tIn = rt < RADIUS;
    if (pIn === tIn) continue;                        // both same side: this ring isn't between them
    // exit toward the gate nearest the OUTSIDE endpoint (so we surface near the goal)
    const outAng = pIn ? Math.atan2(tz - cz, tx - cx) : Math.atan2(pz - cz, px - cx);
    let bestGa = 0, bd = Infinity;
    for (let g = 0; g < GATES; g++) {
      const ga = (g / GATES) * Math.PI * 2;
      let d = outAng - ga;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < bd) { bd = Math.abs(d); bestGa = ga; }
    }
    // aim a touch past the doorway on the mover's far side so it fully clears the
    // band before goTo re-locks onto the real target (next frame, path is clear).
    const wr = RADIUS + (pIn ? 1 : -1) * (HALF + 2.5);
    _wp.x = cx + Math.cos(bestGa) * wr;
    _wp.z = cz + Math.sin(bestGa) * wr;
    return _wp;
  }
  return null;
}

// RADIAL wall collision: block a step that CROSSES a town's ring circle (except
// through a gate), but preserve the step's new ANGLE so the body slides freely
// ALONG the wall toward a gate instead of sticking. (A grid-style axis-separated
// revert deadlocks here: approaching a gate diagonally, each axis alone lands in
// stone and gets reverted even though the diagonal would enter the opening.) The
// ring is treated as a single circle at RADIUS; a blocked body is parked just
// clear of the visual band (±HALF). (px,pz) is last frame's position. Guard
// (freeze lesson): a mover below UNDERGROUND_Y is in a dungeon (≈ -400) whose x/z
// may overlap a town centre — walls are overworld-only, so bypass. Mutates
// pos.{x,z}; leaves y alone.
const EPS = 0.05;
export function collideWalls(pos: { x: number; y: number; z: number }, px: number, pz: number): void {
  if (!RADIUS || pos.y < UNDERGROUND_Y) return;
  const cs = centers();
  for (let i = 0; i < cs.length; i++) {
    const cx = cs[i][0], cz = cs[i][1];
    const pr = Math.hypot(px - cx, pz - cz);
    const nx = pos.x - cx, nz = pos.z - cz;
    const nr = Math.hypot(nx, nz);
    if ((pr < RADIUS) === (nr < RADIUS)) continue;   // didn't cross this ring this step
    if (inGate(Math.atan2(nz, nx))) continue;        // crossed at a gate: allowed
    // blocked: keep the new angle (lets the tangential slide continue), pull the
    // radius back to just outside the band on the side we came from.
    const r = pr < RADIUS ? RADIUS - HALF - EPS : RADIUS + HALF + EPS;
    const k = r / (nr || 1);
    pos.x = cx + nx * k;
    pos.z = cz + nz * k;
  }
}

// --- visual ----------------------------------------------------------------
// Raise the ring meshes + gate towers for every town. Browser-only: skipped
// headless (no document) and when walls are disabled. Stone is instanced — the
// whole perimeter of both towns is two InstancedMeshes plus a handful of towers.
export function buildWalls(scene: SceneLike): Obj3DLike | undefined {
  if (typeof document === 'undefined' || !RADIUS || !scene) return;
  const cs = centers();
  const SEGS = 96;                                  // angular resolution of the ring
  const dθ = (Math.PI * 2) / SEGS;
  const segLen = RADIUS * dθ * 1.12;               // chord + overlap so corners don't gap
  const bodies: Mat4Like[] = [], crenels: Mat4Like[] = [];   // instance matrices
  const dummy = new T3.Object3D();
  const towerGroup = new T3.Group();
  const towerGeo = new T3.CylinderGeometry(THICK * 0.95, THICK * 1.1, HEIGHT + 2.2, 8);
  const towerMat = new T3.MeshStandardMaterial({ color: 0x837b70, roughness: 1, flatShading: true });

  for (let i = 0; i < cs.length; i++) {
    const cx = cs[i][0], cz = cs[i][1];
    let k = 0;
    for (let s = 0; s < SEGS; s++) {
      const θ = s * dθ;
      if (inGate(θ)) continue;                       // gate gap: no stone
      const x = cx + Math.cos(θ) * RADIUS, z = cz + Math.sin(θ) * RADIUS;
      const baseY = safeHeight(x, z);
      // local +Z lies along the radial (depth = thickness), +X along the wall (length)
      dummy.position.set(x, baseY + HEIGHT / 2, z);
      dummy.rotation.set(0, Math.PI / 2 - θ, 0);
      dummy.updateMatrix();
      bodies.push(dummy.matrix.clone());
      // a battlement merlon on every other segment for the toothed silhouette
      if ((k++ & 1) === 0) {
        dummy.position.set(x, baseY + HEIGHT + 0.4, z);
        dummy.updateMatrix();
        crenels.push(dummy.matrix.clone());
      }
    }
    // a tower flanking each side of every gate opening
    for (let g = 0; g < GATES; g++) {
      const ga = (g / GATES) * Math.PI * 2;
      for (const e of [-1, 1]) {
        const a = ga + e * (GATE_HALF + dθ * 0.5);
        const x = cx + Math.cos(a) * RADIUS, z = cz + Math.sin(a) * RADIUS;
        const t = new T3.Mesh(towerGeo, towerMat);
        t.position.set(x, safeHeight(x, z) + (HEIGHT + 2.2) / 2, z);
        t.castShadow = true; t.receiveShadow = true;
        towerGroup.add(t);
      }
    }
  }

  const bodyMesh = makeInstanced(new T3.BoxGeometry(segLen, HEIGHT, THICK),
    new T3.MeshStandardMaterial({ color: 0x8a8278, roughness: 1, flatShading: true }), bodies);
  const crenelMesh = makeInstanced(new T3.BoxGeometry(segLen * 0.45, HEIGHT * 0.3, THICK * 1.05),
    new T3.MeshStandardMaterial({ color: 0x6f685e, roughness: 1, flatShading: true }), crenels);
  const group = new T3.Group();
  group.name = 'townWalls';
  if (bodyMesh) group.add(bodyMesh);
  if (crenelMesh) group.add(crenelMesh);
  group.add(towerGroup);
  scene.add(group);
  return group;
}

function makeInstanced(geo: unknown, mat: unknown, mats: Mat4Like[]): Obj3DLike | null {
  if (!mats.length) return null;
  const m = new T3.InstancedMesh(geo, mat, mats.length);
  for (let i = 0; i < mats.length; i++) m.setMatrixAt(i, mats[i]);
  m.castShadow = true; m.receiveShadow = true;
  m.frustumCulled = true;
  return m;
}

function safeHeight(x: number, z: number): number { try { return terrainHeight(x, z); } catch { return 0; } }
