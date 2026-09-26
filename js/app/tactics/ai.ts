// Tactical AI: pick the best (tile, action) pair for an NPC's turn.
//
//   score = position value (cover vs foes it can see, height, not standing in fire, flanking)
//         + best action from that tile, EU = p × gain, weighted by the NPC's OBJECTIVE
//
// Deliberately compact — combat design carries the fun; the AI just has to use the same toys
// the player has (shoves into fire and off ledges, spilled braziers, lit hay, cover, flanks,
// readied ambushes) and want what its objective wants.

import { TUNE } from '../../constants.js';
import { rng } from '../../sim/rng.js';
import { FALL_SAFE, key } from './map.js';
import type { Action, Battle, Spot, Unit } from './battle.js';

const frac = (u: Unit) => Math.max(0, u.agent.fighter.health) / TUNE.maxHealth;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

export interface Plan { to: Spot | null; action: Action; score: number; why: string; }

export function planTurn(b: Battle, u: Unit): Plan {
  const o = b.objectiveOf(u);
  const P = (u.agent.personality || {}) as Record<string, number>;
  const risk = P.risk_tolerance ?? 0.5;
  const foes = b.foesOf(u);
  const weight = (t: Unit): number => {
    switch (o.kind) {
      case 'avenge': return t.id === o.targetId ? 5 : 0.2;
      case 'rob': case 'capture': case 'enforce': case 'glory': return t.id === o.targetId ? 2.5 : 0.7;
      case 'feed': return 1 + (1 - frac(t)) * 2;
      case 'protect': { const w = o.wardId != null ? b.get(o.wardId) : undefined; return w?.lastHitBy === t ? 3 : 1; }
      default: return t.role === 'player' ? 1.2 : 1;
    }
  };
  const lethalOk = (t: Unit) => !((o.kind === 'rob' || o.kind === 'capture' || o.kind === 'enforce') && t.id === o.targetId);

  // candidate standing spots: here + reachable (bounded)
  const reach = u.moved ? new Map() : b.reachable(u);
  const spots: Spot[] = [{ x: u.x, z: u.z }, ...[...reach.keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; })];
  const scoredSpots = spots.map((s) => ({ s, v: positionValue(b, u, s, o.kind === 'survive' || u.morale === 'broken') }))
    .sort((a, b2) => b2.v - a.v).slice(0, 24);
  // always consider stepping next to each foe (melee) even if the position is unattractive
  for (const f of foes) {
    let best: Spot | null = null, bd = 99;
    for (const s of spots) { const d = dist(s, f); if (d === 1 && (!best || dist(s, u) < bd)) { best = s; bd = dist(s, u); } }
    if (best && !scoredSpots.some((x) => x.s.x === best!.x && x.s.z === best!.z)) scoredSpots.push({ s: best, v: positionValue(b, u, best, false) });
  }

  let bestPlan: Plan = { to: null, action: { kind: 'defend' }, score: 0.05, why: 'hold' };
  const consider = (to: Spot, action: Action, gain: number, why: string, posV: number) => {
    const sc = posV + gain * (1 + (rng() - 0.5) * 0.15);
    if (sc > bestPlan.score) bestPlan = { to: to.x === u.x && to.z === u.z ? null : to, action, score: sc, why };
  };

  // compelled: a taunt or a planted "traitor" belief
  const forced = (u.turnedOn && u.turnedOn.out === null ? u.turnedOn : null) ?? (u.tauntedBy && u.tauntedBy.out === null ? u.tauntedBy : null);

  for (const { s, v } of scoredSpots) {
    const opts = b.options(u, s);
    for (const a of opts) {
      const t = 'target' in a && a.target != null ? b.get(a.target as Unit['id']) : undefined;
      if (forced && t && t !== forced && a.kind !== 'aid') continue;
      const p = b.odds(u, a, s).p;
      let g = 0, why: string = a.kind;
      switch (a.kind) {
        case 'attack': case 'ability': {
          if (!t) break;
          const dmg = a.kind === 'ability' ? (u.agent.abilities.get(a.abilityId)?.effects.filter((e) => e.op === 'damage').reduce((q, e) => q + e.amount, 0) || 20) : TUNE.damage * (0.75 + 0.08 * u.sheet.might);
          const kill = dmg >= t.agent.fighter.health;
          g = p * weight(t) * (Math.min(1, dmg / Math.max(1, t.agent.fighter.health)) + (kill ? (lethalOk(t) ? 0.7 : -0.6) : 0));
          break;
        }
        case 'shove': {
          if (!t) break;
          const d = b.dirFrom(s, t), nx = t.x + d[0], nz = t.z + d[1];
          const tile = b.map.tile(nx, nz);
          let bonus = 0.15;
          if (tile && (tile.burning || b.map.propAt(nx, nz)?.fireSource)) { bonus = 1.1; why = 'shove into the fire'; }
          else if (tile && b.map.standH(t.x, t.z) - b.map.standH(nx, nz) > FALL_SAFE) { bonus = 0.9; why = 'shove off the ledge'; }
          else if (!tile || !b.map.standable(nx, nz)) { bonus = 0.35; why = 'slam into the wall'; }
          g = p * weight(t) * bonus;
          break;
        }
        case 'kick': {
          const pr = b.map.props.get(a.prop); if (!pr) break;
          const d = b.dirFrom(s, pr);
          const victims = foes.filter((f) => { for (let i = 0; i < 4; i++) if (f.x === pr.x + d[0] * i && f.z === pr.z + d[1] * i) return true; return false; });
          if (pr.kind === 'brazier' && victims.length) { g = 0.9 * victims.length; why = 'spill the brazier on them'; }
          else if ((pr.kind === 'barrel' || pr.kind === 'oil') && victims.length) { g = 0.6 * victims.length; why = 'roll the barrel into them'; }
          else if ((pr.kind === 'table' || pr.kind === 'cart') && !pr.tipped) { g = 0.15; why = 'make cover'; }
          break;
        }
        case 'ignite': {
          const near = foes.filter((f) => dist(f, a.at) <= 1);
          const nearUs = b.friendsOf(u).filter((f) => dist(f, a.at) <= 1).length + (dist(s, a.at) <= 1 ? 1 : 0);
          const pr = b.map.propAt(a.at.x, a.at.z);
          g = near.length * (pr?.kind === 'oil' ? 1.4 : pr?.kind === 'hay' ? 0.9 : 0.5) - nearUs * 0.8;
          why = pr ? `set ${pr.name} alight` : 'light the grass';
          break;
        }
        case 'throw': {
          const tu = b.unitAt(a.at.x, a.at.z);
          const pr = b.map.props.get(a.prop) ?? u.carrying;
          if (!tu || !pr) break;
          g = p * weight(tu) * (pr.fireSource ? 0.9 : pr.blinding ? 0.5 : pr.liquid ? 0.2 : 0.35);
          break;
        }
        case 'douse': g = (u.burning > 0 && dist(s, a.at) <= 1 ? 1.2 : 0) + b.friendsOf(u).filter((f) => f.burning && dist(f, a.at) <= 1).length * 0.6; why = 'put out the fire'; break;
        case 'grab': g = o.kind === 'rob' && u.loot === 0 && t ? p * (t.id === o.targetId ? 1.8 : 0.9) : 0; break;
        case 'subdue': g = (o.kind === 'capture' || o.kind === 'enforce') && t && t.id === o.targetId ? p * (frac(t) < 0.45 ? 2.2 : 0.7) : 0; break;
        case 'aid': {
          const w = t ?? u;
          g = w.out === 'downed' ? p * (o.kind === 'protect' && o.wardId === w.id ? 2.4 : 1.2) : p * (1 - frac(w)) * (w === u ? 1.1 : 0.7) * (frac(w) < 0.5 ? 1 : 0.2);
          break;
        }
        case 'guard': g = t && frac(t) < 0.6 ? (o.kind === 'protect' && o.wardId === t.id ? 0.9 : 0.25) : 0; break;
        case 'defend': g = 0.08 + foes.filter((f) => dist(f, s) <= 1).length * 0.1 * (1.2 - risk) * (1 - frac(u)); break;
        case 'overwatch': g = foes.some((f) => dist(f, s) <= 1) ? 0 : 0.18; break;
        case 'escape': g = (o.kind === 'survive' || u.morale === 'broken' ? 2.5 : 0) + (o.kind === 'rob' && u.loot > 0 ? 3 : 0); break;
        case 'social': {
          if (a.verb === 'intimidate' && t) g = p * weight(t) * (t.morale === 'shaken' ? 0.9 : 0.4) * (u.sheet.presence >= 2 ? 1 : 0.3);
          else if (a.verb === 'bluff' && t) g = p * weight(t) * 0.3 * (u.sheet.presence >= 2 ? 1 : 0.3);
          else if (a.verb === 'taunt' && t && o.kind === 'protect') g = p * 0.8;
          else if (a.verb === 'parley') g = o.kind === 'survive' || (frac(u) < 0.3 && foes.length > b.friendsOf(u).length + 1) ? p * 1.2 : 0;
          break;
        }
        default: break;
      }
      if (g > 0) consider(s, a, g, why, v);
    }
  }
  // nothing worth doing in reach: advance on the objective's target (or the nearest foe)
  if (bestPlan.score < 0.25 && foes.length && !u.moved) {
    const goal = (o.targetId != null ? b.get(o.targetId) : undefined) ?? b.nearestFoe(u)!;
    let best: Spot | null = null, bd = dist(u, goal);
    for (const s of spots) { const d = dist(s, goal); if (d < bd) { bd = d; best = s; } }
    if (best) bestPlan = { to: best, action: { kind: 'defend' }, score: 0.2, why: 'close in' };
  }
  return bestPlan;
}

/** How good a spot is to stand on, before any action. */
function positionValue(b: Battle, u: Unit, s: Spot, timid: boolean): number {
  let v = 0;
  const t = b.map.tile(s.x, s.z)!;
  if (t.burning) v -= 1.5;
  const foes = b.foesOf(u);
  for (const f of foes) {
    const seen = b.map.sees(f.x, f.z, s.x, s.z);
    if (!seen) { v += timid ? 0.12 : 0.03; continue; }
    const cov = b.map.coverAgainst(s.x, s.z, f.x, f.z);
    v += cov * 0.06;
    v += b.heightEdge(s, f) * 0.08;
    if (b.facingOf(s, f) === 'back') v += 0.1;
  }
  if (timid) v += Math.min(...foes.map((f) => dist(f, s)), 10) * 0.05 + (b.map.edge(s.x, s.z) ? 0.3 : 0);
  if (key(s.x, s.z) === key(u.x, u.z)) v += 0.02;   // a little inertia
  return v;
}

/** Run an NPC's whole turn: move (if planned), act, end facing the nearest foe. */
export function runTurn(b: Battle, u: Unit): Plan {
  const plan = planTurn(b, u);
  if (plan.to) b.moveTo(u, plan.to);
  if (u.out === null && u.agent.alive && b.current() === u && !u.acted) b.act(u, plan.action);
  if (b.current() === u) b.endTurn(u);
  return plan;
}
