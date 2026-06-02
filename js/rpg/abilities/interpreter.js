// The ability interpreter: castSpec() turns a validated AbilitySpec into actual
// effects. It is the runtime that reads the data-only IR and dispatches each
// effect through the EFFECTS map — no eval, no code in the spec. Flow:
//   1. validate + cooldown gate (per-caster, keyed by spec id)
//   2. resolve targets from header.area / range / target over ctx.agents
//   3. apply each effect, honouring its trigger gate (on_hit/on_kill/hp_below)
//   4. set cooldown, emit a cast ActionEvent on the bus (feeds progression + UI)
//
// Melee specs that "ride the swing" are NOT cast here — combat.js applies their
// damage op directly when the weapon connects (see isMelee + integration notes).
// castSpec is for instant / self / area / social abilities pressed by the player
// or chosen by an NPC.

import * as THREE from 'three';
import { bus } from '../events.js';
import { validate, isMelee } from './ir.js';
import { EFFECTS } from './effects.js';

const _v = new THREE.Vector3();

// per-agent cooldown ledger lives on the agent so it survives across casts and
// is inspectable; Progression also mirrors cooldowns but this is the authority
// the interpreter actually enforces.
function cooldowns(agent) { return (agent._abilityCd ||= new Map()); }

export function onCooldown(agent, spec, now) {
  const until = cooldowns(agent).get(spec.id) || 0;
  return now < until;
}

// castSpec(spec, caster, ctx) -> bool (did it fire?). ctx = the sim _ctx()
// { agents, agentsById, world, time }.
export function castSpec(spec, caster, ctx) {
  if (!spec || !caster || !caster.alive) return false;
  if (!validate(spec)) { console.warn('ability rejected by validate()', spec?.id); return false; }

  const now = ctx?.time ?? 0;
  if (onCooldown(caster, spec, now)) return false;

  // melee specs don't fire instantly — they arm the swing instead. If something
  // calls castSpec on a melee spec, arm it on the fighter and bail (combat.js
  // will resolve the damage when the blade lands).
  if (isMelee(spec)) {
    caster.fighter.pendingSpec = spec;
    cooldowns(caster).set(spec.id, now + spec.header.cooldown);
    emitCast(spec, caster, now, /*magnitude*/ damageOf(spec));
    return true;
  }

  const targets = resolveTargets(spec, caster, ctx);
  // self-only abilities (heal/shield/dash) still "fire" with no foes present
  const selfOnly = spec.header.target === 'self' || spec.header.area.kind === 'self';
  if (!selfOnly && targets.length === 0) return false;

  let landed = false;
  for (const e of spec.effects) {
    const fn = EFFECTS[e.op];
    if (!fn) continue;
    if (e.chance < 1 && Math.random() > e.chance) continue;

    if (e.op === 'heal' || e.op === 'shield' || e.op === 'dash') {
      // caster-affecting ops ignore the foe list
      if (gateTrigger(e, caster, caster, false, now)) landed = fn(e, caster, caster, ctx) || landed;
      continue;
    }
    for (const t of targets) {
      const hostileHit = e.op === 'damage';
      if (!gateTrigger(e, caster, t, false, now)) continue;
      const ok = fn(e, caster, t, ctx);
      landed = ok || landed;
      // chain on_kill / on_hit effects against the same target
      if (ok && hostileHit) runChained(spec, e, caster, t, ctx, now);
    }
  }

  cooldowns(caster).set(spec.id, now + spec.header.cooldown);
  emitCast(spec, caster, now, magnitudeOf(spec));
  return landed || selfOnly;
}

// trigger gate: on_hit/on_kill are evaluated AFTER a primary hit (runChained);
// the hp_below triggers are pre-conditions checked here.
function gateTrigger(e, caster, target, postHit, now) {
  switch (e.when) {
    case null: case undefined: return !postHit ? true : false;
    case 'on_hit':  return postHit;
    case 'on_kill': return postHit && target && !target.alive;
    case 'target_hp_below':
      return !!target?.fighter && target.fighter.health < hpFrac(target, e.amount);
    case 'caster_hp_below':
      return !!caster?.fighter && caster.fighter.health < hpFrac(caster, e.amount);
    default: return false;
  }
}

// for *_hp_below the effect.amount is read as a fraction-of-max threshold (0..1)
function hpFrac(agent, frac) {
  const max = agent.fighter?.constructor ? 100 : 100; // TUNE.maxHealth is 100
  return max * Math.max(0, Math.min(1, frac || 0.3));
}

// secondary effects that trigger off the primary hit (on_hit / on_kill).
function runChained(spec, primary, caster, target, ctx, now) {
  for (const e of spec.effects) {
    if (e === primary) continue;
    if (e.when !== 'on_hit' && e.when !== 'on_kill') continue;
    if (!gateTrigger(e, caster, target, true, now)) continue;
    if (e.chance < 1 && Math.random() > e.chance) continue;
    const fn = EFFECTS[e.op];
    if (fn) fn(e, caster, e.op === 'heal' || e.op === 'shield' || e.op === 'dash' ? caster : target, ctx);
  }
}

// ---- target resolution by area + range over the agent list ------------------
function resolveTargets(spec, caster, ctx) {
  const h = spec.header;
  if (h.target === 'self' || h.area.kind === 'self') return [];

  const agents = ctx?.agents || [];
  const out = [];
  const cf = caster.fighter;
  const yaw = cf ? cf.root.rotation.y : 0;
  const reach = h.area.kind === 'circle' ? h.area.r
    : h.area.kind === 'cone' ? h.area.r
    : h.area.kind === 'line' ? h.area.len
    : h.range;

  for (const o of agents) {
    if (o === caster || !o.alive) continue;
    if (!wants(spec, caster, o)) continue;
    _v.copy(o.pos).sub(caster.pos); _v.y = 0;
    const d = _v.length();
    if (d > reach + 0.001) continue;

    if (h.area.kind === 'cone') {
      // forward is -sin(yaw), -cos(yaw) (KayKit faces +Z; MODEL_YAW_OFFSET=PI)
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const dot = (fx * _v.x + fz * _v.z) / (d || 1);
      const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      if (ang > h.area.deg * 0.5) continue;
    }
    out.push(o);
    // single-target (no area) keeps only the nearest valid foe
  }

  if (h.area.kind === 'self' || (h.area.kind !== 'circle' && h.area.kind !== 'cone' && h.area.kind !== 'line')) {
    // point/instant single target: nearest only
    out.sort((a, b) => caster.pos.distanceToSquared(a.pos) - caster.pos.distanceToSquared(b.pos));
    return out.slice(0, 1);
  }
  return out;
}

// does this caster want to affect agent o, given the spec's target kind?
function wants(spec, caster, o) {
  const kind = spec.header.target;
  if (kind === 'any') return true;
  // hostility/ally judged by belief + faction, mirroring simulation.isHostile
  const hostile = isFoe(caster, o);
  if (kind === 'enemy') return hostile;
  if (kind === 'ally')  return !hostile;
  return true;
}

function isFoe(caster, o) {
  if (caster.faction && o.faction && caster.faction !== o.faction) {
    if (caster.faction === 'monster' || o.faction === 'monster') return true;
  }
  const b = caster.beliefs?.get?.(o.id);
  if (b && (b.hostile || b.standing < -0.6)) return true;
  // the player aims at whatever they target; treat cross-faction as foe-able
  if (caster.controlled) return caster.faction !== o.faction;
  return false;
}

// ---- ActionEvent emission ---------------------------------------------------
function emitCast(spec, caster, now, magnitude) {
  bus.emit({
    actorId: caster.id,
    verb: 'cast',
    tags: spec.grantsTags && spec.grantsTags.length ? spec.grantsTags.slice() : ['CAST'],
    magnitude,
    targetId: undefined,
    t: now,
    abilityId: spec.id,          // extra context for progression/quests (ignored by the contract)
  });
}

function damageOf(spec) {
  for (const e of spec.effects) if (e.op === 'damage') return e.amount;
  return 0;
}
function magnitudeOf(spec) {
  let m = 0;
  for (const e of spec.effects) m = Math.max(m, Math.abs(e.amount), e.dur);
  return m;
}
