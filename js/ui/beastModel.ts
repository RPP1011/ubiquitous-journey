// BEAST MODELS: the KayKit rigs are all people, so a wolf wears a low-poly body built here. The
// fighter's own rig stays (hidden) so clip timings, facing and positions all keep working; the
// wolf body reads the fighter's state each frame — trots when it moves, lunges when it acts,
// lies down when it's done for.

import * as THREE from 'three';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const X = (o: unknown) => o as Any;

interface FighterLike { root: Any; model: Any; state: string; moveSpeed: number; alive: boolean; update(dt: number): void; _wolf?: boolean }

function mat(color: number, emissive = 0): Any { return new THREE.MeshStandardMaterial({ color, roughness: 0.9, emissive, emissiveIntensity: emissive ? 0.9 : 0 }); }
function mesh(g: Any, geo: Any, m: Any, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): Any {
  const o = X(new THREE.Mesh(geo, m)); o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; g.add(o); return o;
}

/** A wolf, facing +Z, standing on y = 0. */
function buildWolf(color: number, scale: number): { g: Any; legs: Any[]; head: Any; tail: Any } {
  const g = X(new THREE.Group());
  const fur = mat(color), dark = mat(new THREE.Color(color).multiplyScalar(0.55).getHex()), eye = mat(0xffd24a, 0xffb000);
  mesh(g, new THREE.CapsuleGeometry(0.26, 0.75, 4, 8), fur, 0, 0.72, 0, Math.PI / 2);           // body
  mesh(g, new THREE.SphereGeometry(0.33, 8, 6), fur, 0, 0.8, 0.36).scale.set(1, 1.05, 0.9);    // chest / ruff
  const head = X(new THREE.Group()); head.position.set(0, 0.98, 0.62); g.add(head);
  mesh(head, new THREE.BoxGeometry(0.3, 0.28, 0.32), fur, 0, 0, 0);
  mesh(head, new THREE.BoxGeometry(0.17, 0.14, 0.26), dark, 0, -0.05, 0.25);                      // snout
  for (const s of [-1, 1]) {
    mesh(head, new THREE.ConeGeometry(0.07, 0.18, 4), dark, s * 0.1, 0.2, -0.04);                  // ears
    mesh(head, new THREE.BoxGeometry(0.05, 0.04, 0.02), eye, s * 0.08, 0.05, 0.165);               // eyes
  }
  const legs: Any[] = [];
  for (const [x, z] of [[-0.14, 0.34], [0.14, 0.34], [-0.14, -0.34], [0.14, -0.34]]) {
    const hip = X(new THREE.Group()); hip.position.set(x, 0.62, z); g.add(hip);
    mesh(hip, new THREE.CylinderGeometry(0.06, 0.045, 0.62, 5), dark, 0, -0.31, 0);
    legs.push(hip);
  }
  const tail = X(new THREE.Group()); tail.position.set(0, 0.82, -0.55); g.add(tail);
  mesh(tail, new THREE.CylinderGeometry(0.07, 0.03, 0.55, 5), fur, 0, -0.1, -0.22, -1.1);
  g.scale.set(scale, scale, scale);
  return { g, legs, head, tail };
}

/** Swap a fighter's body for a wolf (idempotent). Visual only. */
export function dressAsWolf(f: FighterLike, opts: { color?: number; scale?: number } = {}): void {
  if (f._wolf) return;
  f._wolf = true;
  const w = buildWolf(opts.color ?? 0x6b6f72, opts.scale ?? 1);
  w.g.rotation.y = f.model.rotation?.y ?? 0;
  f.model.visible = false;
  f.root.add(w.g);
  let t = 0, act = 0;
  const base = f.update.bind(f);
  f.update = (dt: number) => {
    base(dt);
    t += dt;
    const moving = f.moveSpeed > 0.15;
    const acting = f.state === 'act' || f.state === 'attack';
    act = acting ? Math.min(1, act + dt * 6) : Math.max(0, act - dt * 4);
    const stride = moving ? Math.sin(t * (6 + f.moveSpeed * 1.5)) * 0.6 : 0;
    w.legs.forEach((l: Any, i: number) => { l.rotation.x = (i === 0 || i === 3 ? stride : -stride); });
    w.tail.rotation.x = Math.sin(t * 3) * 0.15 + (acting ? -0.5 : 0);
    w.head.position.z = 0.62 + act * 0.25;                       // the lunge
    w.head.rotation.x = act * 0.35 - (moving ? 0 : Math.sin(t * 1.3) * 0.05);
    w.g.position.z = act * 0.3;
    // down or dead: lie on its side
    const down = !f.alive || f.state === 'dead';
    w.g.rotation.z += ((down ? Math.PI / 2 : 0) - w.g.rotation.z) * Math.min(1, dt * 5);
    w.g.position.y = down ? 0.25 : 0;
  };
}

/** A beast's look by its name: black, gaunt, pale, the Grey Mother. */
export function wolfLook(name: string, chief: boolean): { color: number; scale: number } {
  const n = name.toLowerCase();
  const color = n.includes('black') ? 0x2c2c2e : n.includes('pale') || n.includes('grey mother') ? 0xc4c6c8 : n.includes('gaunt') || n.includes('lean') ? 0x8e8a7e
    : n.includes('scarred') || n.includes('torn') ? 0x5a4e44 : n.includes('young') ? 0x8a8478 : 0x6b6f72;
  return { color, scale: chief ? 1.6 : n.includes('young') ? 0.8 : 1 };
}
