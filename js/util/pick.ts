// Center-screen agent picker: raycast from the camera through an NDC point
// (usually the screen centre, where the reticle sits) against each agent's
// invisible `proxy` sphere — the same hit-proxy the Inspector uses. Returns the
// agent under the crosshair, or null. Shared by interact / dialogue triggers.

import * as THREE from 'three';
import type { Agent } from '../../types/sim.js';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

// An agent as seen through the picker: the typed Agent plus its browser-only hit
// `proxy` (an invisible sphere carried in decor, not part of the headless Agent
// shape — so it's a structural extension here, not on the shared type).
type PickableAgent = Agent & { proxy?: THREE.Object3D };

// camera     : THREE.PerspectiveCamera the player looks through
// ndcCenter  : {x,y} in normalised device coords (0,0 = screen centre). Pass
//              null/undefined to default to the centre (the combat reticle).
// agents     : the Simulation's agent list (each may carry .proxy + .alive)
export function pickAgent(
  camera: THREE.Camera | null | undefined,
  ndcCenter: { x: number; y: number } | null | undefined,
  agents: PickableAgent[] | null | undefined,
): Agent | null {
  if (!camera || !agents || !agents.length) return null;
  _ndc.set(ndcCenter ? ndcCenter.x : 0, ndcCenter ? ndcCenter.y : 0);
  _ray.setFromCamera(_ndc, camera);
  const proxies = agents
    .filter((a) => a.alive && a.proxy && !a.controlled)
    .map((a) => a.proxy as THREE.Object3D);
  if (!proxies.length) return null;
  const hits = _ray.intersectObjects(proxies, false);
  return hits.length ? (hits[0].object.userData.agent as Agent) : null;
}
