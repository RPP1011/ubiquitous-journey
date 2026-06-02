// Center-screen agent picker: raycast from the camera through an NDC point
// (usually the screen centre, where the reticle sits) against each agent's
// invisible `proxy` sphere — the same hit-proxy the Inspector uses. Returns the
// agent under the crosshair, or null. Shared by interact / dialogue triggers.

import * as THREE from 'three';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

// camera     : THREE.PerspectiveCamera the player looks through
// ndcCenter  : {x,y} in normalised device coords (0,0 = screen centre). Pass
//              null/undefined to default to the centre (the combat reticle).
// agents     : the Simulation's agent list (each may carry .proxy + .alive)
export function pickAgent(camera, ndcCenter, agents) {
  if (!camera || !agents || !agents.length) return null;
  _ndc.set(ndcCenter ? ndcCenter.x : 0, ndcCenter ? ndcCenter.y : 0);
  _ray.setFromCamera(_ndc, camera);
  const proxies = agents.filter((a) => a.alive && a.proxy && !a.controlled).map((a) => a.proxy);
  if (!proxies.length) return null;
  const hits = _ray.intersectObjects(proxies, false);
  return hits.length ? hits[0].object.userData.agent : null;
}
