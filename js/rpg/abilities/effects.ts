// EFFECTS: the executable backing for each IR op. Every entry is a pure-ish
// function (effect, caster, target, ctx) -> bool (did it apply?). These are the
// ONLY code paths an ability can take — the interpreter looks ops up here by
// name, so a spec can never reach anything outside this map. Effects act through
// the existing Fighter API (takeHit/health/root) and the agent ToM layer
// (beliefs.plant) so abilities compose with combat and the belief sim.

import * as THREE from 'three';
import { DIR } from '../../constants.js';
import { TUNE } from '../../constants.js';
import { COORD } from '../../sim/simconfig.js';
import type { Vector3 } from 'three';
import type { EffectFn, EffectOp, FighterDir, Fighter } from '../../../types/sim.js';

// The transient ability-status bag we stash on a Fighter (not part of the shared Fighter
// type — a private detail of this module + the interpreter). Accessed via the augmented
// fighter handle below so reads/writes stay typed without touching the shared layer.
interface AbilityStatusBag {
  slowUntil: number;
  shield: number;
  dashUntil: number;
  slowFactor?: number;
  _exposeUntil?: number;   // combo window expiry (docs/architecture/19 §9): damage amps then clears it
  _exposeAmp?: number;     // damage multiplier applied to the next hit while the window is open
}
// a Fighter as this module sees it: the shared body + our private status/health-bar hooks.
type StatusFighter = Fighter & {
  _abilityStatus?: AbilityStatusBag;
  _updateHealthBar?: () => void;
};

const _v = new THREE.Vector3();

// map a world-space direction (from attacker to target) to one of the four
// combat DIRs, so a spec-driven hit can be blocked just like a normal swing.
function dirTo(fromPos: Vector3, toPos: Vector3): FighterDir {
  const dx = toPos.x - fromPos.x, dz = toPos.z - fromPos.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? DIR.RIGHT : DIR.LEFT;
  return dz > 0 ? DIR.DOWN : DIR.UP;
}

// transient status bag carried on the target Fighter (read by no one but us +
// the interpreter; kept tiny so it stays GC-friendly for ~12 agents at 6Hz).
function status(f: StatusFighter): AbilityStatusBag {
  return (f._abilityStatus ||= { slowUntil: 0, shield: 0, dashUntil: 0 });
}

// docs/architecture/19 §3/§8a — the combat-state scalars the band snapshot exposes, read by the
// COORD coordination cascade. Both read ONLY the transient status bag (+ the stagger machine); pure
// and guarded (the freeze lesson). `ccUntilOf` = the absolute sim-time a target is "controlled"
// until — a CC OPENING a coordinating ally exploits — taken as the later of (stagger remaining made
// absolute) and (an active slow window). `exposeActive` = a combo window (the §9 expose op) is open.
export function ccUntilOf(f: StatusFighter | null | undefined, now: number): number {
  if (!f) return 0;
  const stagger = (f.state === 'stagger' && (f.staggerTimer || 0) > 0) ? now + f.staggerTimer : 0;
  const slow = f._abilityStatus ? f._abilityStatus.slowUntil : 0;
  return Math.max(stagger, slow);
}
export function exposeActive(f: StatusFighter | null | undefined, now: number): boolean {
  const st = f && f._abilityStatus;
  return !!(st && (st._exposeUntil || 0) > now);
}

// docs/architecture/19 §9 — the combo PAYOFF: amplify (and CONSUME) an open expose window. Called
// from BOTH damage paths — EFFECTS.damage (spec/ranged) AND the plain-swing fallback in combat.ts —
// so an ordinary companion swing into an exposed foe lands the combo too (the audit's dual-path
// finding). Pure; returns the (possibly amplified) damage and clears the window when it fires.
export function applyExpose(f: StatusFighter | null | undefined, dmg: number, now: number): number {
  if (!exposeActive(f, now)) return dmg;
  const st = (f as StatusFighter)._abilityStatus!;
  const out = dmg * (st._exposeAmp || 1);
  st._exposeUntil = 0; st._exposeAmp = 1;   // one-shot: the window closes on the landing hit
  return out;
}

export const EFFECTS: Record<EffectOp, EffectFn> = {
  // raw damage routed through the block-aware Fighter.takeHit; returns true on a
  // landed (non-blocked) hit so on_hit/on_kill triggers can chain off it.
  damage(e, caster, target, ctx) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    const dir = dirTo(caster.pos, target.pos);
    // a shield soaks flat damage first (see shield op)
    const st = status(tf);
    // docs/architecture/19 §9: an open expose window amplifies (and consumes) this hit BEFORE the
    // shield soak — a combo land. No-op (returns dmg unchanged) when no window is open.
    let dmg = applyExpose(tf, e.amount, ctx?.time || 0);
    if (st.shield > 0) { const a = Math.min(st.shield, dmg); st.shield -= a; dmg -= a; }
    if (dmg <= 0) return false;
    const res = tf.takeHit(dmg, dir);
    return res !== 'blocked';
  },

  heal(e, caster, target) {
    const tf = (target || caster)?.fighter as StatusFighter | undefined;
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

  // mark a movement-slow window the agent locomotion reads: the shared stepper
  // (agent/movement.js _stepAlong) and the combat pursuit (agent/act.js combatStep)
  // multiply their speed by slowFactor while now < slowUntil (via slowMul below).
  slow(e, caster, target, ctx) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    const st = status(tf);
    st.slowUntil = Math.max(st.slowUntil, (ctx?.time || 0) + (e.dur || 1));
    st.slowFactor = e.amount > 0 ? e.amount : 0.5;
    return true;
  },

  // docs/architecture/19 §9 — the combo SETUP: open a damage-amplify window on the target (consumed
  // by applyExpose on the next landing hit, both damage paths). A HOSTILE op (the interpreter's
  // friendly-fire guard keeps it off allies). Timed like slow; `amount` is a MULTIPLIER (not raw
  // magnitude), self-clamped to COORD.exposeAmpMax so a generated/LLM spec can't make it a nuke.
  expose(e, caster, target, ctx) {
    const tf = target?.fighter;
    if (!tf || !tf.alive) return false;
    const st = status(tf);
    st._exposeUntil = Math.max(st._exposeUntil || 0, (ctx?.time || 0) + (e.dur || 1));
    const amp = Math.max(1, Math.min(COORD.exposeAmpMax || 2, e.amount || COORD.exposeAmp || 1.5));
    st._exposeAmp = Math.max(st._exposeAmp || 1, amp);
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
  // plant a (possibly false) belief in the TARGET about the CASTER. ONE op, two
  // social casts, signed by amount:
  //   amount < 0 — CHARM (silver_tongue / haggle): goodwill. RAISES the target's
  //     standing toward the caster; plants no suspicion.
  //   amount > 0 — DECEIVE (plant_rumor): the social attack. Plants suspicion and
  //     SOURS the target's standing toward the caster.
  // (The pre-fix code added mag*0.5 directly, so a charm's negative amount LOWERED
  // standing — charm was a self-inflicted smear. The sign now matches the catalog.)
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
    if (b) b.standing = Math.max(-1, Math.min(1, b.standing - mag * 0.5));
    return true;
  },

  // --- economy ops: own-state windows on the CASTER other systems read ------
  // THE HAGGLE EDGE: open a bargaining window (an expiry stamp on the caster's own
  // state). trade.js ask/bid read it to drive a harder bargain while it lasts; the
  // edge magnitude lives in config (ABILITY.haggleEdge), the duration on the spec.
  // Conserved by construction: the edge only shifts the bid/ask midpoint BOTH
  // parties exchange — no gold is minted or burned. Ignores `target` entirely.
  trade_edge(e, caster, _target, ctx) {
    if (!caster || !caster.alive) return false;
    const now = ctx?.time || 0;
    caster._haggleEdgeUntil = Math.max(caster._haggleEdgeUntil || 0, now + (e.dur || 0));
    return true;
  },

  // MASTER CRAFT: open a produce-speed window on the caster's own state. act.js
  // produce() multiplies its skillMul by ABILITY.craftBoostMul while it lasts.
  craft_boost(e, caster, _target, ctx) {
    if (!caster || !caster.alive) return false;
    const now = ctx?.time || 0;
    caster._craftBoostUntil = Math.max(caster._craftBoostUntil || 0, now + (e.dur || 0));
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
export function abilityStatus(fighter: StatusFighter | null | undefined): AbilityStatusBag | null {
  return fighter?._abilityStatus || null;
}

// The movement-speed multiplier a slow window imposes at sim-time `now` (1 when
// unslowed/expired). ONE cheap guarded read for the per-frame movement path (the
// freeze lesson: no deref chains, never throws). `now` must be the same clock the
// slow op stamped (ctx.time, the sim time).
export function slowMul(fighter: StatusFighter | null | undefined, now: number): number {
  const st = fighter?._abilityStatus;
  return (st && now < st.slowUntil) ? (st.slowFactor ?? 0.5) : 1;
}
