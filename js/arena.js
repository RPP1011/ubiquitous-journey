// The arena: ground, grid, lighting, sky. Returns nothing the game needs to
// keep beyond adding it to the scene.

import * as THREE from 'three';

export const ARENA_RADIUS = 22;

export function buildArena(scene) {
  scene.background = new THREE.Color(0x8fb8d8);
  scene.fog = new THREE.Fog(0x8fb8d8, 30, 70);

  // ground
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6b7d52, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(ARENA_RADIUS + 8, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // a subtle grid to read movement & distance
  const grid = new THREE.GridHelper(ARENA_RADIUS * 2, ARENA_RADIUS * 2, 0x39482b, 0x4a5c38);
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  grid.position.y = 0.01;
  scene.add(grid);

  // arena boundary ring
  const ringGeo = new THREE.RingGeometry(ARENA_RADIUS, ARENA_RADIUS + 0.35, 96);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x2c361f, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  scene.add(ring);

  // lighting
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4030, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
  sun.position.set(12, 20, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 22;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);
}
