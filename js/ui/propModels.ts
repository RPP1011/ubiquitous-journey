// Low-poly prop models for the battle map, built from three.js primitives (no asset files).
// Each builder returns a Group whose origin sits on the ground at the tile centre.

import * as THREE from 'three';

type Mat = THREE.MeshBasicMaterial;
const lam = (color: number, emissive = 0): Mat =>
  new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 1 : 0 }) as unknown as Mat;
interface O3 { position: { set(x: number, y: number, z: number): void }; rotation: { x: number; y: number; z: number }; scale: { set(x: number, y: number, z: number): void }; add(o: unknown): void }
const o3 = (m: unknown) => m as O3;

function part(g: THREE.Group, geo: THREE.BufferGeometry, mat: Mat, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  o3(m).position.set(x, y, z); o3(m).rotation.x = rx; o3(m).rotation.y = ry; o3(m).rotation.z = rz;
  o3(g).add(m);
  return m;
}

const WOOD = 0x8a6238, DARK = 0x4a3220, IRON = 0x3a3d44, STONE = 0x85847d, EMBER = 0xff6a1a;

const BUILDERS: Record<string, (g: THREE.Group) => void> = {
  crate(g) {
    part(g, new THREE.BoxGeometry(1.1, 1.0, 1.1), lam(WOOD), 0, 0.5, 0);
    for (const s of [-1, 1]) {
      part(g, new THREE.BoxGeometry(1.14, 0.12, 0.12), lam(DARK), 0, 0.5 + s * 0.42, 0.52);
      part(g, new THREE.BoxGeometry(0.12, 1.02, 0.12), lam(DARK), s * 0.5, 0.5, 0.52);
    }
    part(g, new THREE.BoxGeometry(1.35, 0.1, 0.1), lam(DARK), 0, 0.5, 0.56, 0, 0, Math.PI / 4.4);
  },
  barrel(g) {
    const prof = [0.42, 0.5, 0.53, 0.5, 0.42].map((r, i) => new THREE.Vector2(r, i * 0.27));
    part(g, new THREE.LatheGeometry(prof, 14), lam(0x7a522e), 0, 0, 0);
    part(g, new THREE.CircleGeometry(0.42, 14), lam(DARK), 0, 1.08, 0, -Math.PI / 2);
    for (const y of [0.2, 0.88]) part(g, new THREE.TorusGeometry(0.5, 0.035, 5, 16), lam(IRON), 0, y, 0, Math.PI / 2);
  },
  oil(g) {
    BUILDERS.barrel(g);
    part(g, new THREE.TorusGeometry(0.535, 0.05, 5, 16), lam(0xb03020), 0, 0.54, 0, Math.PI / 2);
    part(g, new THREE.CircleGeometry(0.55, 12), lam(0x1a1410), 0.35, 0.02, 0.3, -Math.PI / 2);
  },
  hay(g) {
    part(g, new THREE.CylinderGeometry(0.6, 0.6, 1.2, 12), lam(0xd8b64a), 0, 0.6, 0, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) part(g, new THREE.CircleGeometry(0.6, 12), lam(0xc49a36), s * 0.61, 0.6, 0, 0, s * Math.PI / 2);
    part(g, new THREE.TorusGeometry(0.61, 0.025, 4, 14), lam(0x8a6a2a), 0, 0.6, 0, 0, Math.PI / 2);
  },
  campfire(g) {
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; part(g, new THREE.DodecahedronGeometry(0.2), lam(STONE), Math.cos(a) * 0.62, 0.12, Math.sin(a) * 0.62, a, a); }
    for (let i = 0; i < 3; i++) part(g, new THREE.CylinderGeometry(0.08, 0.08, 1.0, 6), lam(DARK), 0, 0.2, 0, Math.PI / 2 - 0.35, (i / 3) * Math.PI);
    part(g, new THREE.SphereGeometry(0.28, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), lam(0x401a08, EMBER), 0, 0.05, 0);
  },
  brazier(g) {
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; part(g, new THREE.CylinderGeometry(0.04, 0.05, 0.9, 5), lam(IRON), Math.cos(a) * 0.3, 0.45, Math.sin(a) * 0.3, Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25); }
    part(g, new THREE.CylinderGeometry(0.55, 0.3, 0.35, 12, 1, true), lam(IRON), 0, 0.95, 0);
    part(g, new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2.6), lam(0x401a08, EMBER), 0, 0.92, 0);
  },
  bucket(g) {
    part(g, new THREE.CylinderGeometry(0.28, 0.22, 0.45, 10, 1, true), lam(0x7a5a38), 0, 0.23, 0);
    part(g, new THREE.CircleGeometry(0.26, 10), lam(0x3f8fd0), 0, 0.4, 0, -Math.PI / 2);
    part(g, new THREE.TorusGeometry(0.27, 0.02, 4, 12, Math.PI), lam(IRON), 0, 0.46, 0);
  },
  flour(g) {
    const s = part(g, new THREE.SphereGeometry(0.34, 10, 8), lam(0xefe8d6), 0, 0.3, 0); o3(s).scale.set(1, 1.1, 0.8);
    part(g, new THREE.CylinderGeometry(0.1, 0.16, 0.18, 8), lam(0xe0d6bf), 0, 0.68, 0);
    part(g, new THREE.TorusGeometry(0.1, 0.02, 4, 10), lam(0x8a6a2a), 0, 0.64, 0, Math.PI / 2);
  },
  rocks(g) { for (const [x, z, r] of [[-0.2, 0, 0.28], [0.22, 0.12, 0.22], [0.05, -0.25, 0.18]]) part(g, new THREE.DodecahedronGeometry(r), lam(STONE), x, r * 0.8, z, x * 3, z * 2); },
  table(g) {
    part(g, new THREE.BoxGeometry(1.7, 0.1, 0.85), lam(0x9a7248), 0, 0.85, 0);
    for (const [x, z] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]]) part(g, new THREE.BoxGeometry(0.09, 0.82, 0.09), lam(DARK), x, 0.41, z);
    part(g, new THREE.BoxGeometry(0.3, 0.2, 0.25), lam(0xb5563a), -0.3, 0.99, 0.1);
    part(g, new THREE.CylinderGeometry(0.1, 0.1, 0.25, 8), lam(0xd8c9a0), 0.35, 1.02, -0.1);
  },
  cart(g) {
    part(g, new THREE.BoxGeometry(1.7, 0.5, 1.1), lam(0x7a5530), 0, 0.85, 0);
    part(g, new THREE.BoxGeometry(1.7, 0.08, 1.1), lam(DARK), 0, 0.62, 0);
    for (const z of [-0.62, 0.62]) { part(g, new THREE.CylinderGeometry(0.45, 0.45, 0.1, 14), lam(DARK), -0.2, 0.45, z, Math.PI / 2); part(g, new THREE.CylinderGeometry(0.08, 0.08, 0.14, 6), lam(IRON), -0.2, 0.45, z, Math.PI / 2); }
    for (const z of [-0.35, 0.35]) part(g, new THREE.BoxGeometry(1.2, 0.07, 0.07), lam(DARK), 1.35, 0.75, z, 0, 0, -0.25);
  },
  tree(g) {
    part(g, new THREE.CylinderGeometry(0.16, 0.24, 1.4, 7), lam(0x5a3e28), 0, 0.7, 0);
    for (const [y, r, h] of [[1.7, 1.0, 1.5], [2.5, 0.78, 1.3], [3.2, 0.52, 1.1]]) part(g, new THREE.ConeGeometry(r, h, 8), lam(0x2f5e2f), 0, y, 0);
  },
  well(g) {
    part(g, new THREE.CylinderGeometry(0.8, 0.85, 0.8, 16, 1, true), lam(STONE), 0, 0.4, 0);
    part(g, new THREE.TorusGeometry(0.8, 0.09, 6, 18), lam(0x9a9890), 0, 0.8, 0, Math.PI / 2);
    part(g, new THREE.CircleGeometry(0.76, 16), lam(0x1f3e57), 0, 0.5, 0, -Math.PI / 2);
    for (const x of [-0.75, 0.75]) part(g, new THREE.BoxGeometry(0.1, 1.5, 0.1), lam(DARK), x, 1.25, 0);
    part(g, new THREE.ConeGeometry(1.15, 0.6, 4), lam(0x6b3a2a), 0, 2.2, 0, 0, Math.PI / 4);
    part(g, new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6), lam(DARK), 0, 1.7, 0, 0, 0, Math.PI / 2);
  },
  rubble(g) {
    for (const [x, z, r, c] of [[-0.35, -0.2, 0.42, STONE], [0.3, 0.1, 0.36, 0x77766f], [0, 0.35, 0.3, 0x8e8c84], [-0.1, 0.05, 0.26, 0x6e6d66], [0.4, -0.35, 0.22, STONE]]) part(g, new THREE.DodecahedronGeometry(r), lam(c), x, r * 0.6, z, x * 4, z * 3, x * 2);
    part(g, new THREE.BoxGeometry(0.9, 0.12, 0.2), lam(DARK), 0.1, 0.35, -0.1, 0, 0.7, 0.3);
  },
  log(g) {
    part(g, new THREE.CylinderGeometry(0.28, 0.3, 1.8, 9), lam(0x5e4128), 0, 0.28, 0, 0, 0, Math.PI / 2);
    for (const s of [-1, 1]) part(g, new THREE.CircleGeometry(0.28, 9), lam(0xb8905a), s * 0.91, 0.28, 0, 0, s * Math.PI / 2);
  },
  torch(g) {
    part(g, new THREE.CylinderGeometry(0.05, 0.06, 1.3, 6), lam(DARK), 0, 0.65, 0);
    part(g, new THREE.CylinderGeometry(0.1, 0.07, 0.2, 6), lam(0x2a1a10, EMBER), 0, 1.35, 0);
  },
  relic(g) {
    part(g, new THREE.BoxGeometry(0.5, 0.3, 0.34), lam(0xd8dde6), 0, 0.15, 0);
    part(g, new THREE.BoxGeometry(0.54, 0.08, 0.38), lam(0xd4b24a), 0, 0.33, 0);
    part(g, new THREE.BoxGeometry(0.05, 0.22, 0.05), lam(0xd4b24a), 0, 0.48, 0);
    part(g, new THREE.BoxGeometry(0.16, 0.05, 0.05), lam(0xd4b24a), 0, 0.52, 0);
  },
  tent(g) {
    part(g, new THREE.ConeGeometry(1.25, 1.9, 4, 1, true), lam(0xb9a57c), 0, 0.95, 0, 0, Math.PI / 4);
    part(g, new THREE.CylinderGeometry(0.04, 0.04, 2.1, 5), lam(DARK), 0, 1.05, 0);
    part(g, new THREE.PlaneGeometry(0.6, 1.0), lam(0x2a2218), 0, 0.5, 0.62, -0.32);
  },
};

export function buildProp(kind: string): THREE.Group {
  const g = new THREE.Group();
  (BUILDERS[kind] ?? BUILDERS.crate)(g);
  return g;
}
