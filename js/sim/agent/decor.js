// Agent visual decoration — proxy sphere, selection ring, and the canvas
// name-label, plus the emergent profession colour the UI reads. Extracted from
// Agent as free functions over a passed agent instance. Purely visual and
// already DOM-guarded: headless (no document) skips mesh/canvas creation and the
// label updates are no-ops, so the sim runs untouched. Behaviour-preserving:
// verbatim bodies of the old Agent methods. No cycles — imports THREE + config.

import * as THREE from 'three';
import { PROFESSIONS, GOODS, PLAYER_COLOR, FACTIONS } from '../simconfig.js';

// A townsperson's colour now emerges from WHAT IT DOES, not a birthright trade:
// its currently-chosen good's colour, else the dominant deed-tag's good colour,
// else its faction colour. So a town reads as a spread of trades again even
// though nobody is born into one. Guarded — never throws.
export function profColor(a) {
  if (a.controlled) return PLAYER_COLOR;
  if (a.profession && PROFESSIONS[a.profession]) return PROFESSIONS[a.profession].color;
  if (a._trade && GOODS[a._trade]) return GOODS[a._trade].color;
  const dom = dominantGoodColor(a);
  if (dom != null) return dom;
  return FACTIONS[a.faction]?.color ?? 0xffffff;   // monsters etc.
}

// Pick a colour from the agent's strongest production-related behaviour tag:
// find the good whose tags it has accumulated the most of. Read-only; null if
// it has no producing history yet.
export function dominantGoodColor(a) {
  const bp = a.progression && a.progression.behavior_profile;
  if (!bp) return null;
  let bestGood = null, bestW = 0;
  for (const g in GOODS) {
    let w = 0;
    for (const t of GOODS[g].tags) w += bp[t] || 0;
    if (w > bestW) { bestW = w; bestGood = g; }
  }
  return bestGood && bestW > 0 ? GOODS[bestGood].color : null;
}

export function buildDecor(a) {
  a.fighter.root.userData.agent = a;
  // headless (no renderer/DOM): skip the proxy sphere, selection ring and the
  // canvas name-label entirely — they're purely visual. _updateLabel/​
  // setLabelVisible already guard on the missing canvas/sprite, so the sim runs
  // untouched. This is the only DOM dependency in the whole agent path.
  if (typeof document === 'undefined') return;

  const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false }));
  proxy.position.y = (a.fighter.height || 1.8) * 0.55;
  proxy.userData.agent = a;
  a.proxy = proxy;
  a.fighter.root.add(proxy);

  a.ringMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
  a.ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 24), a.ringMat);
  a.ring.rotation.x = -Math.PI / 2; a.ring.position.y = 0.03;
  a.ringMat.color.setHex(profColor(a));
  a.fighter.root.add(a.ring);

  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  a._lblCanvas = canvas; a._lblCtx = canvas.getContext('2d');
  a._lblTex = new THREE.CanvasTexture(canvas); a._lblTex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: a._lblTex, depthTest: false, transparent: true }));
  spr.scale.set(2.6, 0.65, 1);
  spr.position.y = (a.fighter.height || 1.8) + 0.65;
  spr.renderOrder = 1000;
  a.label = spr;
  a.fighter.root.add(spr);
  updateLabel(a);
}

export function updateLabel(a) {
  const ctx = a._lblCtx; if (!ctx) return;
  const sub = a.controlled ? 'you'
    : `${a.goal.kind}${a._tradeFlash > 0 ? ' · traded!' : ' · ' + Math.round(a.gold) + 'g'}`;
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
  a._lblTex.needsUpdate = true;
}

export function setLabelVisible(a, v) { if (a.label) a.label.visible = v; }
