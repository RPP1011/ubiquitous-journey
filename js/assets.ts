// Asset loading: load each character GLB once, then hand out independent
// skinned clones (with their own skeletons) for every fighter.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTERS, HIDE_WEAPON_FRAGMENTS, TUNE } from './constants.js';

// The vendored three.module.js + addons are un-typed JS. These minimal views
// recover exactly the scene-graph surface the loader/cloner/traversal below touch
// (the getter-installed members tsc can't see). Add nothing at runtime.
interface Obj3D {
  name: string;
  visible: boolean;
  isMesh?: boolean;
  geometry?: { boundingBox: THREE.Box3 | null; computeBoundingBox(): void };
  matrixWorld: THREE.Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
  frustumCulled: boolean;
  position: THREE.Vector3;
  scale: { setScalar(s: number): void };
  updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void;
  traverse(cb: (o: Obj3D) => void): void;
  add(child: object): void;
}
// One animation clip (opaque to this module — handed straight to the Fighter's mixer).
type AnimationClip = unknown;
interface GLTF { scene: Obj3D; animations: AnimationClip[]; }
interface CacheEntry { scene: Obj3D; animations: AnimationClip[]; weapon: string; }

/** A ready-to-use fighter model built from a cached character. */
export interface CharacterInstance {
  root: object;                 // THREE.Group placed in the world
  model: Obj3D;
  animations: AnimationClip[];
  weaponNode: Obj3D | null;
  weaponTipLocal: THREE.Vector3;
  height: number;
}

const loader = new GLTFLoader() as { load(url: string, onLoad: (g: GLTF) => void, onProgress: undefined, onError: (e: unknown) => void): void };
const cache = new Map<string, CacheEntry>();

function loadGLTF(url: string): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf), undefined, reject);
  });
}

// Preload all configured characters. Returns when every GLB is ready.
export async function preloadCharacters(): Promise<void> {
  for (const [key, cfg] of Object.entries(CHARACTERS)) {
    const gltf = await loadGLTF(cfg.url);
    cache.set(key, { scene: gltf.scene, animations: gltf.animations, weapon: cfg.weapon });
  }
}

// Compute the bounding box of only the *visible* meshes under root.
function visibleBox(root: Obj3D): THREE.Box3 | null {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let found = false;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (o.isMesh && o.visible && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.geometry.boundingBox) {
        tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
        if (!found) { box.copy(tmp); found = true; } else { box.union(tmp); }
      }
    }
  });
  return found ? box : null;
}

// Build a ready-to-use fighter model from a cached character.
export function createCharacterInstance(key: string): CharacterInstance {
  const entry = cache.get(key);
  if (!entry) throw new Error(`character "${key}" not preloaded`);

  const model = cloneSkinned(entry.scene as unknown as object) as unknown as Obj3D;

  // Toggle weapon/attachment visibility: keep only the chosen 1H weapon.
  let weaponNode: Obj3D | null = null;
  model.traverse((o) => {
    if (o.name === entry.weapon) { weaponNode = o; o.visible = true; return; }
    if (HIDE_WEAPON_FRAGMENTS.some((frag) => o.name.includes(frag))) o.visible = false;
  });

  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; }
  });

  // Normalise height so combat tuning is model-independent.
  // Measure the body only (hide the held weapon so it can't inflate height).
  // weaponNode is mutated inside the traverse closure above, which TS's flow
  // analysis can't track (it still sees the `= null` init) — read through a
  // widened local so toggling visibility typechecks.
  const wn = weaponNode as Obj3D | null;
  if (wn) wn.visible = false;
  const box = visibleBox(model);
  if (wn) wn.visible = true;
  const rawHeight = box ? box.max.y - box.min.y : TUNE.targetHeight;
  const scale = TUNE.targetHeight / rawHeight;

  // Wrap in a group so we scale/translate without disturbing the rig.
  const root = new THREE.Group();
  model.scale.setScalar(scale);
  // drop feet to y=0
  if (box) model.position.y = -box.min.y * scale;
  (root as unknown as Obj3D).add(model);

  // Pre-compute the weapon tip in the weapon node's local space (far end
  // along its longest local axis) for hit sampling.
  let weaponTipLocal = new THREE.Vector3(0, 0.5, 0);
  if (wn) {
    const wnode: Obj3D = wn;
    const wbox = new THREE.Box3();
    let any = false;
    wnode.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(wnode.matrixWorld).invert();
    wnode.traverse((o) => {
      if (o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        if (o.geometry.boundingBox) {
          const b = o.geometry.boundingBox.clone()
            .applyMatrix4(o.matrixWorld).applyMatrix4(inv);
          if (!any) { wbox.copy(b); any = true; } else { wbox.union(b); }
        }
      }
    });
    if (any) {
      // longest axis = blade length; tip = far end of that axis
      const size = new THREE.Vector3(); wbox.getSize(size);
      const c = new THREE.Vector3(); wbox.getCenter(c);
      weaponTipLocal = c.clone();
      if (size.y >= size.x && size.y >= size.z) weaponTipLocal.y = wbox.max.y;
      else if (size.z >= size.x) weaponTipLocal.z = wbox.max.z;
      else weaponTipLocal.x = wbox.max.x;
    }
  }

  return {
    root,
    model,
    animations: entry.animations,
    weaponNode: wn,
    weaponTipLocal,
    height: TUNE.targetHeight,
  };
}
