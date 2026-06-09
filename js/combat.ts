// Combat resolution: for every fighter currently in its active swing window,
// sample points along the weapon blade and test them against other fighters'
// torsos. Blocking that matches the attack direction negates the hit.

import * as THREE from 'three';
import { TUNE } from './constants.js';
import { EFFECTS } from './rpg/abilities/effects.js';
import type { Fighter, CombatEvent } from '../types/sim.js';
import type { CastCtx } from '../types/sim.js';

const _torso = new THREE.Vector3();
const _p = new THREE.Vector3();
const BLADE_SAMPLES = 4;

/** A swing-time hostility gate: true if the attacker's blow should connect with target. */
export type HostileGate = (attacker: Fighter, target: Fighter) => boolean;

// Returns an array of events: { type:'hit'|'blocked'|'dead', attacker, target, point }
// isHostile(attacker, target) optionally gates damage so a swing passes
// harmlessly through allies and only connects with believed enemies.
export function resolveCombat(
  fighters: Fighter[],
  isHostile: HostileGate | null = null,
  ctx: CastCtx | null = null,
): CombatEvent[] {
  const events: CombatEvent[] = [];
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

      // Ability-spec melee routing: if the attacker armed a pendingSpec (player
      // pressed an ability key, then swung), apply that spec's damage op through
      // the agent layer (block-aware, shield-aware). Fall back to flat damage for
      // ability-less / professionless fighters (monsters, unarmed player swings).
      const spec = attacker.pendingSpec;
      const aAgent = attacker.agent, tAgent = target.agent;
      let result;
      if (spec && aAgent && tAgent) {
        // pick the spec's damage effect; if none, fall back to flat damage.
        const dmgEff = spec.effects.find((e) => e.op === 'damage');
        if (dmgEff) {
          const landed = EFFECTS.damage(dmgEff, aAgent, tAgent, ctx);
          // EFFECTS.damage already called target.fighter.takeHit; derive the event
          // type from the fighter's resulting state.
          result = !landed ? 'blocked' : (!target.alive ? 'dead' : 'hit');
          // also run any non-damage same-spec effects gated on the hit (e.g.
          // knockback when:'on_hit') so melee specs compose like cast ones.
          if (landed) {
            for (const e of spec.effects) {
              if (e === dmgEff || e.op === 'damage') continue;
              if (e.when && e.when !== 'on_hit') continue;
              if (e.chance < 1 && Math.random() > e.chance) continue;
              const fn = EFFECTS[e.op];
              if (fn) fn(e, aAgent, (e.op === 'heal' || e.op === 'shield' || e.op === 'dash') ? aAgent : tAgent, ctx);
            }
          }
        } else {
          result = target.takeHit(TUNE.damage, attacker.dir);
        }
        attacker.pendingSpec = null;   // one spec consumed per swing
      } else {
        result = target.takeHit(TUNE.damage, attacker.dir);
      }

      events.push({ type: result === 'blocked' ? 'blocked' : (result === 'dead' ? 'dead' : 'hit'),
                    attacker, target, point: _torso.clone() });
      break;                        // a swing connects with at most one target
    }
  }
  return events;
}
