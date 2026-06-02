// EFFECTS: the executable backing for each IR op. Every entry is a pure-ish
// function (effect, caster, target, ctx) -> bool (did it apply?). These are the
// ONLY code paths an ability can take — the interpreter looks ops up here by
// name, so a spec can never reach anything outside this map. Effects act through
// the existing Fighter API (takeHit/health/root) and the agent ToM layer
// (beliefs.plant) so abilities compose with combat and the belief sim.

import * as THREE from 'three';
import { DIR } from '../../constants.js';
import { TUNE } from '../../constants.js';

const _v = new THREE.Vector3();

// map a world-space direction (from attacker to target) to one of the four
// combat DIRs, so a spec-driven hit can be blocked just like a normal swing.
function dirTo(fromPos, toPos) {
  const dx = toPos.x - fromPos.x, dz = toPos.z - fromPos.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? DIR.RIGHT : DIR.LEFT;
  return dz > 0 ? DIR.DOWN : DIR.UP;
}

// transient status bag carried on the target Fighter (read by no one but us +
// the interpreter; kept tiny so it stays GC-friendly for ~12 agents at 6Hz).
function status(f) {
  return (f._abilityStatus ||= { slowUntil: 0, shield: 0, dashUntil: 0 });
}

export const EFFECTS = {
  // raw damage routed through the block-aware Fighter.takeHit; returns true on a
  // landed (non-blocked) hit so on_hit/on_kill triggers can chain off it.
  damage(e, caster, target, ctx) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    const dir = dirTo(caster.pos, target.pos);
    // a shield soaks flat damage first (see shield op)
    const st = status(tf);
    let dmg = e.amount;
    if (st.shield > 0) { const a = Math.min(st.shield, dmg); st.shield -= a; dmg -= a; }
    if (dmg <= 0) return false;
    const res = tf.takeHit(dmg, dir);
    return res !== 'blocked';
  },

  heal(e, caster, target) {
    const tf = (target || caster)?.fighter;
    if (!tf || !tf.alive) return false;
    tf.health = Math.min(TUNE.maxHealth, tf.health + e.amount);
    if (tf._updateHealthBar) tf._updateHealthBar();
    return true;
  },

  // borrow the stagger state machine for a stun (longer than a normal stagger).
  stun(e, caster, target) {
    const tf = target?.fighter;
    if (!tf || !tf.alive || tf.state === 'block') return false;
    tf.state = 'stagger';
    tf.staggerTimer = Math.max(tf.staggerTimer || 0, e.dur || 1);
    return true;
  },

  // mark a movement-slow window the agent locomotion can read (sim multiplies
  // moveSpeed when ctx.time < slowUntil; harmless if unread — purely additive).
  slow(e, caster, target, ctx) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    const st = status(tf);
    st.slowUntil = Math.max(st.slowUntil, (ctx?.time || 0) + (e.dur || 1));
    st.slowFactor = e.amount > 0 ? e.amount : 0.5;
    return true;
  },

  // shove the target's root straight away from the caster.
  knockback(e, caster, target) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    _v.copy(target.pos).sub(caster.pos); _v.y = 0;
    const d = _v.length() || 1;
    target.pos.x += (_v.x / d) * e.amount;
    target.pos.z += (_v.z / d) * e.amount;
    return true;
  },

  // lunge the CASTER forward along its facing (closing distance before a strike).
  dash(e, caster) {
    const cf = caster?.fighter;
    if (!cf || !cf.alive) return false;
    const yaw = cf.root.rotation.y;            // model faces +Z at yaw 0 (+offset)
    caster.pos.x += -Math.sin(yaw) * e.amount;
    caster.pos.z += -Math.cos(yaw) * e.amount;
    return true;
  },

  // grant a temporary damage-soak buffer on the caster (or target).
  shield(e, caster, target) {
    const tf = (target || caster)?.fighter;
    if (!tf) return false;
    status(tf).shield = Math.max(status(tf).shield, e.amount);
    return true;
  },

  // --- Theory-of-Mind ops: act on the belief layer, not the body ----------
  // plant a (possibly false) belief in the TARGET about the CASTER — the social
  // attack: e.amount>0 plants hostility-suspicion, e.amount<0 improves standing.
  plant_belief(e, caster, target, ctx) {
    if (!target?.beliefs || !caster) return false;
    const mag = e.amount || 0.3;
    target.beliefs.plant(caster.id, {
      faction: caster.faction,
      pos: caster.pos,
      tick: ctx?.time || 0,
      suspicion: mag > 0 ? Math.min(1, mag) : 0,
      confidence: 0.4,
    });
    const b = target.beliefs.get(caster.id);
    if (b) b.standing = Math.max(-1, Math.min(1, b.standing + mag * 0.5));
    return true;
  },

  // read a target's mind: copy what THEY believe about others into the CASTER's
  // store (capped second-hand confidence). Pure information; never damages.
  scry(e, caster, target) {
    if (!caster?.beliefs || !target?.beliefs) return false;
    let n = 0;
    for (const b of target.beliefs.all()) {
      if (b.subjectId === caster.id) continue;
      caster.beliefs.mergeFrom(b, { tag: 'scry', conf: 0.6 });
      n++;
    }
    return n > 0;
  },
};

// expose the status reader so locomotion / other systems can honour slow/shield
// without importing the whole module surface.
export function abilityStatus(fighter) { return fighter?._abilityStatus || null; }
