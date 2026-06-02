// Asset loading: load each character GLB once, then hand out independent
// skinned clones (with their own skeletons) for every fighter.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTERS, HIDE_WEAPON_FRAGMENTS, TUNE } from './constants.js';

const loader = new GLTFLoader();
const cache = new Map();   // key -> { scene, animations }

function loadGLTF(url) {
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => resolve(gltf), undefined, reject);
  });
}

// Preload all configured characters. Returns when every GLB is ready.
export async function preloadCharacters() {
  for (const [key, cfg] of Object.entries(CHARACTERS)) {
    const gltf = await loadGLTF(cfg.url);
    cache.set(key, { scene: gltf.scene, animations: gltf.animations, weapon: cfg.weapon });
  }
}

// Compute the bounding box of only the *visible* meshes under root.
function visibleBox(root) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let found = false;
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (o.isMesh && o.visible && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      if (!found) { box.copy(tmp); found = true; } else { box.union(tmp); }
    }
  });
  return found ? box : null;
}

// Build a ready-to-use fighter model from a cached character.
// Returns { root, model, animations, weaponNode, weaponTipLocal, height }.
export function createCharacterInstance(key) {
  const entry = cache.get(key);
  if (!entry) throw new Error(`character "${key}" not preloaded`);

  const model = cloneSkinned(entry.scene);

  // Toggle weapon/attachment visibility: keep only the chosen 1H weapon.
  let weaponNode = null;
  model.traverse((o) => {
    if (o.name === entry.weapon) { weaponNode = o; o.visible = true; return; }
    if (HIDE_WEAPON_FRAGMENTS.some((frag) => o.name.includes(frag))) o.visible = false;
  });

  model.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; }
  });

  // Normalise height so combat tuning is model-independent.
  // Measure the body only (hide the held weapon so it can't inflate height).
  if (weaponNode) weaponNode.visible = false;
  const box = visibleBox(model);
  if (weaponNode) weaponNode.visible = true;
  const rawHeight = box ? box.max.y - box.min.y : TUNE.targetHeight;
  const scale = TUNE.targetHeight / rawHeight;

  // Wrap in a group so we scale/translate without disturbing the rig.
  const root = new THREE.Group();
  model.scale.setScalar(scale);
  // drop feet to y=0
  if (box) model.position.y = -box.min.y * scale;
  root.add(model);

  // Pre-compute the weapon tip in the weapon node's local space (far end
  // along its longest local axis) for hit sampling.
  let weaponTipLocal = new THREE.Vector3(0, 0.5, 0);
  if (weaponNode) {
    const wbox = new THREE.Box3();
    let any = false;
    weaponNode.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(weaponNode.matrixWorld).invert();
    weaponNode.traverse((o) => {
      if (o.isMesh && o.geometry) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.clone()
          .applyMatrix4(o.matrixWorld).applyMatrix4(inv);
        if (!any) { wbox.copy(b); any = true; } else { wbox.union(b); }
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
    weaponNode,
    weaponTipLocal,
    height: TUNE.targetHeight,
  };
}
