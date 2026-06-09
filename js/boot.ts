// Bootstrap: renderer / scene / camera / arena / input / commander setup.
// Owns the WebGL context and the static scene scaffolding so main.js can stay a
// thin entry point. Returns the live objects the frame loop drives.

import * as THREE from 'three';
import { buildArena } from './arena.js';
import { Input } from './input.js';
import { OrbitCamera } from './camera.js';
import { Commander } from './commander.js';

// The vendored `three` is un-typed JS: TS cannot see the real WebGLRenderer /
// Scene / PerspectiveCamera ctor signatures or their defineProperties-installed
// members. We view THREE through a minimal hand-written shape covering exactly
// what boot() touches; adds nothing at runtime. (Mirrors world.ts's T3 pattern.)
interface RendererLike {
  domElement: HTMLCanvasElement;
  setPixelRatio(r: number): void;
  setSize(w: number, h: number): void;
  shadowMap: { enabled: boolean; type: number };
  outputColorSpace: number;
}
interface CameraLike {
  position: { set(x: number, y: number, z: number): void };
}
interface SceneLike {
  add(o: unknown): void;
}
interface ThreeView {
  WebGLRenderer: new (opts: { antialias: boolean }) => RendererLike;
  Scene: new () => SceneLike;
  PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => CameraLike;
  PCFSoftShadowMap: number;
  SRGBColorSpace: number;
}
const T3 = THREE as unknown as ThreeView;

// The live objects boot() hands back to the frame loop. orbitCam/input/commander
// come from un-typed `.js` modules (allowJs interop), so their shapes are inferred.
export interface BootResult {
  renderer: RendererLike;
  scene: SceneLike;
  camera: CameraLike;
  orbitCam: OrbitCamera;
  input: Input;
  commander: Commander;
}

// Build renderer/scene/camera/arena/input/commander. Side effects (appending the
// canvas, adding the commander marker, building the arena into the scene) match
// the original top-level bootstrap exactly.
export function boot(): BootResult {
  const renderer = new T3.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T3.PCFSoftShadowMap;
  renderer.outputColorSpace = T3.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  const scene = new T3.Scene();
  // vendored-three boundary: scene/camera are real THREE objects, but boot and the
  // combat-path (arena/camera/commander) each model the untyped `three` with their own
  // local views, which don't structurally align — cast across the seam.
  buildArena(scene as unknown as Parameters<typeof buildArena>[0]);

  const camera = new T3.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(0, 4, 8);

  const orbitCam = new OrbitCamera(camera as unknown as ConstructorParameters<typeof OrbitCamera>[0]);
  const input = new Input(renderer.domElement);
  const commander = new Commander(renderer.domElement, camera as unknown as ConstructorParameters<typeof Commander>[1], orbitCam);   // point-and-click control
  scene.add(commander.marker);

  return { renderer, scene, camera, orbitCam, input, commander };
}
