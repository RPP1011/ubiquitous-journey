// Agent visual decoration — proxy sphere, selection ring, and the canvas
// name-label, plus the emergent profession colour the UI reads. Extracted from
// Agent as free functions over a passed agent instance. Purely visual and
// already DOM-guarded: headless (no document) skips mesh/canvas creation and the
// label updates are no-ops, so the sim runs untouched. Behaviour-preserving:
// verbatim bodies of the old Agent methods. No cycles — imports THREE + config.

import * as THREE from 'three';
import { PROFESSIONS, GOODS, PLAYER_COLOR, FACTIONS } from '../simconfig.js';
import type { Agent, BehaviorProfile } from '../../../types/sim.js';

// Re-typed config views (simconfig.js inferred without index signatures under allowJs).
const PROFESSIONS_T = PROFESSIONS as Record<string, { color: number }>;
const GOODS_T = GOODS as Record<string, { color: number; tags: string[] }>;
const FACTIONS_T = FACTIONS as Record<string, { color: number } | undefined>;
const bpW = (bp: BehaviorProfile | undefined, t: string): number =>
  (bp ? (bp as Record<string, number>)[t] : undefined) || 0;

// The vendored three.module.js exposes Object3D's position/rotation/scale/userData via
// runtime getters (Object.defineProperties), which tsc's JS inference does not surface as
// class members. This minimal view recovers the transform/userData surface this browser-
// visual decor touches. (Decor is DOM-guarded; never runs headless.)
interface Transformable {
  position: THREE.Vector3;
  rotation: { x: number; y: number; z: number };
  scale: { set(x: number, y: number, z: number): void };
  userData: Record<string, unknown>;
  add(child: object): void;
}
const xf = (o: object): Transformable => o as unknown as Transformable;

// A townsperson's colour now emerges from WHAT IT DOES, not a birthright trade:
// its currently-chosen good's colour, else the dominant deed-tag's good colour,
// else its faction colour. So a town reads as a spread of trades again even
// though nobody is born into one. Guarded — never throws.
export function profColor(a: Agent): number {
  if (a.controlled) return PLAYER_COLOR;
  if (a.profession && PROFESSIONS_T[a.profession]) return PROFESSIONS_T[a.profession].color;
  if (a._trade && GOODS_T[a._trade]) return GOODS_T[a._trade].color;
  const dom = dominantGoodColor(a);
  if (dom != null) return dom;
  return FACTIONS_T[a.faction]?.color ?? 0xffffff;   // monsters etc.
}

// Pick a colour from the agent's strongest production-related behaviour tag:
// find the good whose tags it has accumulated the most of. Read-only; null if
// it has no producing history yet.
export function dominantGoodColor(a: Agent): number | null {
  const bp = a.progression && a.progression.behavior_profile;
  if (!bp) return null;
  let bestGood: string | null = null, bestW = 0;
  for (const g in GOODS_T) {
    let w = 0;
    for (const t of GOODS_T[g].tags) w += bpW(bp, t);
    if (w > bestW) { bestW = w; bestGood = g; }
  }
  return bestGood && bestW > 0 ? GOODS_T[bestGood].color : null;
}

export function buildDecor(a: Agent): void {
  // The Fighter.root logic-surface type is minimal; the BROWSER root is a real
  // THREE.Object3D (.add/.userData). This decor path is browser-visual only.
  const root = xf(a.fighter.root as object);
  root.userData.agent = a;
  // headless (no renderer/DOM): skip the proxy sphere, selection ring and the
  // canvas name-label entirely — they're purely visual. _updateLabel/​
  // setLabelVisible already guard on the missing canvas/sprite, so the sim runs
  // untouched. This is the only DOM dependency in the whole agent path.
  if (typeof document === 'undefined') return;

  const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }));
  xf(proxy).position.y = (a.fighter.height || 1.8) * 0.55;
  xf(proxy).userData.agent = a;
  a.proxy = proxy;
  root.add(proxy);

  const ringMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  a.ringMat = ringMat;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 24), ringMat);
  a.ring = ring;
  xf(ring).rotation.x = -Math.PI / 2; xf(ring).position.y = 0.03;
  ringMat.color.setHex(profColor(a));
  root.add(ring);

  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  a._lblCanvas = canvas; a._lblCtx = canvas.getContext('2d');
  const lblTex = new THREE.CanvasTexture(canvas); lblTex.colorSpace = THREE.SRGBColorSpace;
  a._lblTex = lblTex;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: lblTex, depthTest: false, transparent: true }));
  xf(spr).scale.set(2.6, 0.65, 1);
  xf(spr).position.y = (a.fighter.height || 1.8) + 0.65;
  spr.renderOrder = 1000;
  a.label = spr;
  root.add(spr);
  updateLabel(a);
}

export function updateLabel(a: Agent): void {
  const ctx = a._lblCtx as CanvasRenderingContext2D | null; if (!ctx) return;
  const sub = a.controlled ? 'you'
    : `${a.goal?.kind ?? 'idle'}${a._tradeFlash > 0 ? ' · traded!' : ' · ' + Math.round(a.gold) + 'g'}`;
  // skip the canvas redraw + GPU upload when nothing visible changed — this is
  // the dominant per-frame cost once there are dozens of agents.
  const sig = `${a.name}|${sub}|${a._tradeFlash > 0 ? 1 : 0}`;
  if (sig === a._lblSig) return;
  a._lblSig = sig;
  const col = `#${profColor(a).toString(16).padStart(6, '0')}`;
  ctx.clearRect(0, 0, 256, 64);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, 256, 34);
  ctx.font = 'bold 24px sans-serif'; ctx.fillStyle = col;
  ctx.fillText(a.name, 128, 24);
  ctx.font = '19px sans-serif'; ctx.fillStyle = a._tradeFlash > 0 ? '#ffd36b' : '#dfe6ee';
  ctx.fillText(sub, 128, 56);
  (a._lblTex as THREE.CanvasTexture).needsUpdate = true;
}

export function setLabelVisible(a: Agent, v: boolean): void {
  if (a.label) (a.label as THREE.Sprite).visible = v;
}
