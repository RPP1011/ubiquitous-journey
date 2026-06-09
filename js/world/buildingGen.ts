// Parametric building generator for the Phase-1 emergent-buildings system. NO
// templates: a finished home/tavern is assembled fresh from primitives
// (Box/Cone/Cylinder/prism) every time, with footprint, storeys, roof shape,
// door/windows, chimney and banner all driven by an rng + params. Purpose
// (home vs tavern) and wealth only BIAS the params — they never select a
// hand-built mesh — so no two buildings are identical and nothing is placed by
// hand. BuildSites._attachMesh calls this lazily under the browser guard and
// feeds it a SEEDED rng so a building's geometry is reproducible per `seed`.
//
// Browser-only: this module is dynamically imported only when `document` exists
// (BuildSites keeps it out of the headless module graph entirely). It is pure
// THREE geometry — no document/canvas access — so it stays import-safe, but the
// dynamic-import gate means the headless sim never even loads it. The returned
// Group is local to the origin (y from 0 up); the caller offsets it onto the
// terrain and applies the street-facing yaw. Visual vocabulary mirrors
// world.js make*(): MeshStandardMaterial, roughness 1, flatShading on roofs,
// castShadow where it reads, cheap primitives (≤ ~30 meshes), no textures/glTF.

import * as THREE from 'three';

// The vendored `three` is un-typed for the runtime-installed transform members
// (Object3D.position/rotation/scale come from defineProperties, invisible to tsc).
// A minimal local view of a built node + a cast-view of the THREE constructors we
// use, mirroring js/sim/world.ts. One justified cast (T3); adds nothing at runtime.
interface Obj3D {
  position: { set(x: number, y: number, z: number): void; copy(v: { x: number; y: number; z: number }): unknown; x: number; y: number; z: number };
  rotation: { set(x: number, y: number, z: number): void; copy(r: unknown): unknown; x: number; y: number; z: number };
  castShadow: boolean;
  add(...o: unknown[]): void;
  userData: Record<string, unknown>;
}
type Ctor0<T> = new () => T;
type Ctor1<T> = new (...args: unknown[]) => T;
interface T3Shape {
  Group: Ctor0<Obj3D>;
  Mesh: Ctor1<Obj3D>;
  PointLight: Ctor1<Obj3D>;
  ConeGeometry: Ctor1<unknown>;
  CylinderGeometry: Ctor1<unknown>;
  BoxGeometry: Ctor1<unknown>;
  MeshStandardMaterial: Ctor1<unknown>;
}
const T3 = THREE as unknown as T3Shape;

// Parameters that BIAS (never select) the procedural geometry. All optional; the
// generator fills sane defaults. footprint is tiles-as-metres (w×d).
export interface BuildParams {
  kind?: string;
  wealth?: number;
  footprint?: { w?: number; d?: number };
  storeys?: number;
  palette?: number[];
  seed?: number;
}

// Wall/plaster palettes a building can be tinted from (indexed by rng or biased
// by wealth toward the painted/lighter rows). Purely cosmetic data, no state.
export const palettes: number[][] = [
  [0x8a6b4a, 0x9c7a52, 0x7a5d40],   // 0 — plain wattle/wood
  [0xb89a6a, 0xc7ab7c, 0xa98a5c],   // 1 — limewashed plaster
  [0xc9b48a, 0xd8c79c, 0xb8a274],   // 2 — fair painted (wealthier)
  [0xa8b0b8, 0xb8c0c8, 0x98a0a8],   // 3 — stone-grey burgher house
];

// Roof colours, chosen by rng and nudged by wealth (thatch → tile → slate).
const ROOF_COLS = [0x6b4a2e, 0x7a4a32, 0x8a4a3a, 0x4f5a62, 0x5a4632];

// Helper: a standard town material (roughness 1, like world.js make*()).
// Returns an untyped THREE material (the cast-view yields `unknown`).
function mat(color: number, flat?: boolean): unknown {
  return new T3.MeshStandardMaterial({ color, roughness: 1, flatShading: !!flat });
}

// pick an element of `arr` using rng (never Math.random — determinism).
function pick<T>(rng: () => number, arr: T[]): T { return arr[(rng() * arr.length) | 0]; }

// uniform in [lo,hi) via the seeded rng.
function rand(rng: () => number, lo: number, hi: number): number { return lo + rng() * (hi - lo); }

// tint a hex colour by a small multiplicative factor (wealth lightening, etc).
function tint(hex: number, f: number): number {
  let r = (hex >> 16) & 0xff, g = (hex >> 8) & 0xff, b = hex & 0xff;
  r = Math.min(255, (r * f) | 0); g = Math.min(255, (g * f) | 0); b = Math.min(255, (b * f) | 0);
  return (r << 16) | (g << 8) | b;
}

// Assemble a unique building Group from primitives. `rng` is a seeded PRNG
// (`() => [0,1)`), `params` = { kind, wealth, footprint:{w,d}, storeys, palette, seed }.
export function generateBuilding(rng: () => number, params: BuildParams): Obj3D {
  const g = new T3.Group();
  const p: BuildParams = params || {};
  const kind = p.kind === 'tavern' ? 'tavern' : 'home';
  const wealth = Math.max(0, +(p.wealth ?? 0) || 0);
  const fp = p.footprint || { w: 4, d: 4 };
  const baseW = Math.max(2, +(fp.w ?? 0) || 4);
  const baseD = Math.max(2, +(fp.d ?? 0) || 4);
  const storeys = Math.max(1, Math.min(3, ((p.storeys ?? 0) | 0) || 1));

  // colour scheme: wealth biases toward the painted/stone palette rows; rng
  // jitters within so neighbours of the same purse still differ.
  const pal = (Array.isArray(p.palette) && p.palette.length)
    ? p.palette
    : palettes[Math.min(palettes.length - 1, (wealth + (rng() < 0.4 ? 1 : 0)) | 0)] || palettes[0];
  const wallTint = 1 + wealth * 0.04;                 // wealthier → lighter/painted
  const storeyH = 2.0 + wealth * 0.2;                 // taller floors at higher tiers

  // -- 1. STONE BASE COURSE (wealth ≥ 1 sits the house on a grey plinth) ------
  let groundY = 0;
  if (wealth >= 1) {
    const ch = 0.35 + rng() * 0.2;
    const course = new T3.Mesh(
      new T3.BoxGeometry(baseW + 0.3, ch, baseD + 0.3), mat(0x8a8276, true));
    course.position.y = ch / 2; course.castShadow = true;
    g.add(course);
    groundY = ch;
  }

  // -- 2. WALLS: a Box body per storey, stacked + slightly stepped by rng -----
  let y = groundY;
  let topW = baseW, topD = baseD, topY = groundY;
  for (let s = 0; s < storeys; s++) {
    // upper storeys jitter inward a touch so the silhouette steps (jetty/setback).
    const shrink = s === 0 ? 0 : rand(rng, 0.05, 0.35) * s;
    const w = Math.max(1.6, baseW - shrink);
    const d = Math.max(1.6, baseD - shrink);
    const wall = new T3.Mesh(
      new T3.BoxGeometry(w, storeyH, d),
      mat(tint(pick(rng, pal), wallTint)));
    wall.position.y = y + storeyH / 2;
    wall.castShadow = true;
    g.add(wall);
    topW = w; topD = d; topY = y + storeyH; y = topY;
  }
  const eaveY = topY;                                 // wall-top height (roof springs here)

  // -- 3. ROOF: a gable (two slanted Boxes) OR a 4-sided cone, by rng ---------
  const roofCol = tint(pick(rng, ROOF_COLS), 1 + wealth * 0.03);
  const pitch = (kind === 'tavern' ? 1.3 : 1.0) * (0.9 + wealth * 0.1) * rand(rng, 0.8, 1.2);
  const gable = rng() < 0.55;
  if (gable) {
    // two slanted planks meeting at a ridge over the building's long axis.
    const slope = (storeyH * 0.5 + 0.5) * pitch;
    const halfW = topW * 0.5;
    const len = Math.hypot(halfW, slope);
    const ang = Math.atan2(slope, halfW);
    for (const side of [-1, 1]) {
      const plank = new T3.Mesh(
        new T3.BoxGeometry(len, 0.18, topD + 0.4), mat(roofCol, true));
      plank.position.set(side * halfW * 0.5, eaveY + slope * 0.5, 0);
      plank.rotation.z = side * ang;
      plank.castShadow = true;
      g.add(plank);
    }
    // ridge cap so the two planks read as a roof, not a tent gap.
    const ridge = new T3.Mesh(
      new T3.BoxGeometry(0.22, 0.22, topD + 0.4), mat(tint(roofCol, 0.85), true));
    ridge.position.y = eaveY + slope; g.add(ridge);
  } else {
    // a 4-sided pyramid cone (rotated π/4 like world.js makeHut's roof).
    const rr = Math.hypot(topW, topD) * 0.55;
    const rh = (storeyH * 0.7 + 0.6) * pitch;
    const cone = new T3.Mesh(new T3.ConeGeometry(rr, rh, 4), mat(roofCol, true));
    cone.position.y = eaveY + rh / 2; cone.rotation.y = Math.PI / 4;
    cone.castShadow = true; g.add(cone);
  }

  // -- 4. DOOR + WINDOWS on the street-facing side (+x; caller's yaw orients) -
  // KayKit/world convention: the Group's +x faces the lane after the caller
  // rotates it, so we recess the door on +x.
  const doorMat = mat(0x3a281a);
  const doorW = rand(rng, 0.8, 1.1), doorH = Math.min(storeyH - 0.3, 1.8 + wealth * 0.1);
  const door = new T3.Mesh(new T3.BoxGeometry(0.12, doorH, doorW), doorMat);
  door.position.set(baseW / 2 + 0.02, groundY + doorH / 2, rand(rng, -baseD * 0.15, baseD * 0.15));
  g.add(door);

  // windows scale with footprint × storeys; jittered positions, darker glass.
  const glass = mat(0x26323c);
  const winPerStorey = Math.max(1, Math.min(3, Math.round((baseW + baseD) / 5)));
  for (let s = 0; s < storeys; s++) {
    const wy = groundY + s * storeyH + storeyH * 0.55;
    for (let i = 0; i < winPerStorey; i++) {
      const ws = rand(rng, 0.4, 0.7);
      // alternate windows between the street face (+x) and a side face (±z).
      const onFace = rng() < 0.6;
      const win = new T3.Mesh(new T3.BoxGeometry(0.08, ws, ws), glass);
      if (onFace) {
        win.position.set(baseW / 2 + 0.02, wy, rand(rng, -baseD * 0.35, baseD * 0.35));
      } else {
        win.position.set(rand(rng, -baseW * 0.35, baseW * 0.35), wy, (rng() < 0.5 ? 1 : -1) * (baseD / 2 + 0.02));
        win.rotation.y = Math.PI / 2;
      }
      g.add(win);
      // WEALTH: shutters flanking the glass (small painted Boxes).
      if (wealth >= 1 && rng() < 0.6) {
        for (const off of [-1, 1]) {
          const sh = new T3.Mesh(new T3.BoxGeometry(0.06, ws, ws * 0.3), mat(tint(pick(rng, pal), 0.8)));
          sh.position.copy(win.position);
          sh.rotation.copy(win.rotation);
          // nudge the shutter out along the window's local width axis.
          if (onFace) sh.position.z += off * (ws * 0.65);
          else sh.position.x += off * (ws * 0.65);
          g.add(sh);
        }
      }
    }
  }

  // WEALTH: a slim second-storey balcony over the door (thin Box deck + posts).
  if (storeys >= 2 && wealth >= 2 && rng() < 0.7) {
    const deck = new T3.Mesh(new T3.BoxGeometry(0.5, 0.08, baseD * 0.6), mat(0x6a4b2f));
    deck.position.set(baseW / 2 + 0.25, groundY + storeyH + 0.1, 0);
    g.add(deck);
    for (const off of [-1, 1]) {
      const post = new T3.Mesh(new T3.CylinderGeometry(0.04, 0.04, 0.6, 6), mat(0x6a4b2f));
      post.position.set(baseW / 2 + 0.45, groundY + storeyH + 0.4, off * baseD * 0.25);
      g.add(post);
    }
  }

  // -- 5. CHIMNEY: a thin Box + a tiny cone smoke-cowl, off-centre by rng -----
  const chimneys = kind === 'tavern' ? (rng() < 0.5 ? 2 : 1) : 1;
  for (let c = 0; c < chimneys; c++) {
    const cw = rand(rng, 0.25, 0.4);
    const ch = rand(rng, 0.9, 1.5);
    const cx = rand(rng, -topW * 0.3, topW * 0.3);
    const cz = rand(rng, -topD * 0.3, topD * 0.3);
    const stack = new T3.Mesh(new T3.BoxGeometry(cw, ch, cw), mat(0x6f5a4a, true));
    stack.position.set(cx, eaveY + ch * 0.5, cz);
    stack.castShadow = true; g.add(stack);
    const cowl = new T3.Mesh(new T3.ConeGeometry(cw * 0.6, cw * 0.6, 5), mat(0x4a3a30, true));
    cowl.position.set(cx, eaveY + ch + cw * 0.3, cz); g.add(cowl);
  }

  // -- 6. TAVERN EXTRAS: a hanging sign, barrels by the door, a warm light ----
  if (kind === 'tavern') {
    // sign arm + board jutting from the street face beside the door.
    const arm = new T3.Mesh(new T3.CylinderGeometry(0.04, 0.04, 0.9, 6), mat(0x4a3526));
    arm.rotation.z = Math.PI / 2;
    arm.position.set(baseW / 2 + 0.45, groundY + storeyH * 0.85, baseD * 0.35);
    g.add(arm);
    const board = new T3.Mesh(new T3.BoxGeometry(0.06, 0.6, 0.7), mat(pick(rng, [0x7a3a2a, 0x3a5a7a, 0x5a4632])));
    board.position.set(baseW / 2 + 0.85, groundY + storeyH * 0.85 - 0.35, baseD * 0.35);
    g.add(board);
    // a couple of barrels flanking the door.
    for (const off of [-1, 1]) {
      const barrel = new T3.Mesh(new T3.CylinderGeometry(0.3, 0.26, 0.7, 10), mat(0x6a4b2f));
      barrel.position.set(baseW / 2 + 0.4, groundY + 0.35, off * (doorW + rand(rng, 0.3, 0.6)));
      barrel.castShadow = true; g.add(barrel);
    }
    // a small warm hearth-glow (browser ambience, like makeForge; ≤1 per tavern).
    const light = new T3.PointLight(0xff9a40, 5, 10, 2);
    light.position.set(baseW / 2 + 0.3, groundY + storeyH * 0.5, 0);
    g.add(light);
  }

  return g;
}
