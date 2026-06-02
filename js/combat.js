// Combat resolution: for every fighter currently in its active swing window,
// sample points along the weapon blade and test them against other fighters'
// torsos. Blocking that matches the attack direction negates the hit.

import * as THREE from 'three';
import { TUNE } from './constants.js';

const _torso = new THREE.Vector3();
const _p = new THREE.Vector3();
const BLADE_SAMPLES = 4;

// Returns an array of events: { type:'hit'|'blocked'|'dead', attacker, target, point }
// isHostile(attacker, target) optionally gates damage so a swing passes
// harmlessly through allies and only connects with believed enemies.
export function resolveCombat(fighters, isHostile = null) {
  const events = [];
  const hitR2 = TUNE.hitRadius * TUNE.hitRadius;

  for (const attacker of fighters) {
    if (!attacker.isHitActive()) continue;
    const [tip, origin] = attacker.weaponPoints();

    for (const target of fighters) {
      if (target === attacker || !target.alive) continue;
      if (isHostile && !isHostile(attacker, target)) continue;  // friendly-fire pass-through

      // quick reject: torso must be within reach of the attacker root
      target.torsoCenter(_torso);

      let hit = false;
      for (let i = 0; i <= BLADE_SAMPLES; i++) {
        _p.lerpVectors(origin, tip, i / BLADE_SAMPLES);
        if (_p.distanceToSquared(_torso) <= hitR2) { hit = true; break; }
      }
      if (!hit) continue;

      attacker.hasHit = true;       // one connection per swing
      const result = target.takeHit(TUNE.damage, attacker.dir);
      events.push({ type: result === 'blocked' ? 'blocked' : (result === 'dead' ? 'dead' : 'hit'),
                    attacker, target, point: _torso.clone() });
      break;                        // a swing connects with at most one target
    }
  }
  return events;
}
