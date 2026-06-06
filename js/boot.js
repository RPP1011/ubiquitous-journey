// Bootstrap: renderer / scene / camera / arena / input / commander setup.
// Owns the WebGL context and the static scene scaffolding so main.js can stay a
// thin entry point. Returns the live objects the frame loop drives.

import * as THREE from 'three';
import { buildArena } from './arena.js';
import { Input } from './input.js';
import { OrbitCamera } from './camera.js';
import { Commander } from './commander.js';

// Build renderer/scene/camera/arena/input/commander. Side effects (appending the
// canvas, adding the commander marker, building the arena into the scene) match
// the original top-level bootstrap exactly.
export function boot() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  buildArena(scene);

  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(0, 4, 8);

  const orbitCam = new OrbitCamera(camera);
  const input = new Input(renderer.domElement);
  const commander = new Commander(renderer.domElement, camera, orbitCam);   // point-and-click control
  scene.add(commander.marker);

  return { renderer, scene, camera, orbitCam, input, commander };
}
