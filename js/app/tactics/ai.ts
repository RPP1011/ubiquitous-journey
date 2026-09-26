// Tactical AI: pick the best (tile, action) pair for a unit's turn.
//
//   score = position value (role-shaped: archers keep range and cover, beasts flank and fear
//           fire, leaders hold high ground, healers hang back, guardians stay by the wounded)
//         + best action from that tile: EU = p × gain, weighted by the unit's OBJECTIVE, its
//           battle GOALS (free the captive, carry out the relic, take the chief) and — for
//           companions and the player's autopilot — TRAITS (bravery, compassion, ruthlessness).
//
// Traits are where personality becomes behaviour: the timid break for the edge when hurt, the
// compassionate won't cut down someone running away and go to the fallen first, the ruthless
// finish the fleeing and reach for fire.

import { TUNE } from '../../constants.js';
import { rng } from '../../sim/rng.js';
import { FALL_SAFE, DIRS, key } from './map.js';
import type { Action, Battle, Spot, Unit } from './battle.js';

const frac = (u: Unit) => Math.max(0, u.agent.fighter.health) / TUNE.maxHealth;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

export interface Plan { to: Spot | null; action: Action; score: number; why: string; }

const T = (u: Unit) => u.traits ?? { bravery: 0.5, compassion: 0.5, loyalty: 0.5, ruthlessness: 0.3 };

export function planTurn(b: Battle, u: Unit): Plan {
  const o = b.objectiveOf(u);
  const tr = T(u);
  const P = (u.agent.personality || {}) as Record<string, number>;
  const risk = u.traits ? tr.bravery : (P.risk_tolerance ?? 0.5);
  const foes = b.foesOf(u);
  const friends = b.friendsOf(u);
  const goals = b.goals;

  // a freed captive runs for it
  if (u.tactic === 'civilian') return fleePlan(b, u, 'run for safety');

  // the timid break when it goes badly (companions' bravery; broken morale for anyone)
  const cornered = foes.filter((f) => dist(f, u) <= 1).length;
  const terrified = u.morale === 'broken' || (u.traits && tr.bravery < 0.3 && (frac(u) < 0.5 || cornered >= 2));
  if (terrified && u.role !== 'player') {
    if (b.map.edge(u.x, u.z)) return { to: null, action: { kind: 'escape' }, score: 3, why: 'flee' };
    return fleePlan(b, u, u.traits ? 'loses their nerve' : 'breaks and runs');
  }

  const weight = (t: Unit): number => {
    let w: number;
    switch (o.kind) {
      case 'avenge': w = t.id === o.targetId ? 5 : 0.2; break;
      case 'rob': case 'capture': case 'enforce': case 'glory': w = t.id === o.targetId ? 2.5 : 0.7; break;
      case 'feed': w = 1 + (1 - frac(t)) * 2; break;
      case 'protect': { const ward = o.wardId != null ? b.get(o.wardId) : undefined; w = ward?.lastHitBy === t ? 3 : 1; break; }
      default: w = t.role === 'player' ? 1.2 : 1;
    }
    if (t.tags.has('chief') && goals.chief === t.id && u.side === 'us') w *= 1.6;
    if (t.tactic === 'archer' || t.tactic === 'healer') w *= 1.2;                  // pick off the back line
    if (t.morale === 'broken') w *= u.traits || u.role === 'player' ? Math.max(0.05, 0.3 + tr.ruthlessness * 2 - tr.compassion) : 0.6;
    if (t.tags.has('captive')) w *= u.side === 'them' ? 1.4 : 0;                   // guards cut down an escaping captive
    return w;
  };
  // the merciful take NAMED people alive (a chief, someone's son); others want the chief alive by order
  const named = (t: Unit) => t.tags.has('chief') || [...t.tags].some((x) => x.startsWith('kin:'));
  const lethalOk = (t: Unit) => !((o.kind === 'rob' || o.kind === 'capture' || o.kind === 'enforce') && t.id === o.targetId)
    && !(u.side === 'us' && goals.chief === t.id && goals.spareChief)
    && !(u.side === 'us' && tr.compassion > 0.8 && named(t) && t.agent.faction !== 'monster');

  const reach = u.moved ? new Map() : b.reachable(u);
  const spots: Spot[] = [{ x: u.x, z: u.z }, ...[...reach.keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; })];
  const scored = spots.map((s) => ({ s, v: positionValue(b, u, s) })).sort((a, c) => c.v - a.v).slice(0, 26);
  for (const f of [...foes, ...friends.filter((f) => f.bound || f.out === 'downed')]) {
    let best: Spot | null = null, bd = 99;
    for (const s of spots) { const d = dist(s, f); if (d === 1 && dist(s, u) < bd) { best = s; bd = dist(s, u); } }
    if (best && !scored.some((x) => x.s.x === best!.x && x.s.z === best!.z)) scored.push({ s: best, v: positionValue(b, u, best) });
  }
  for (const d of b.downed(u.side)) {
    for (const s of spots) if (dist(s, d) === 1 && !scored.some((x) => x.s.x === s.x && x.s.z === s.z)) { scored.push({ s, v: positionValue(b, u, s) }); break; }
  }
  if (goals.retrieve) {
    const rel = b.map.props.get(goals.retrieve);
    if (rel) for (const s of spots) if (dist(s, rel) <= 1 && !scored.some((x) => x.s.x === s.x && x.s.z === s.z)) { scored.push({ s, v: positionValue(b, u, s) }); break; }
  }

  let best: Plan = { to: null, action: { kind: 'defend' }, score: 0.05, why: 'hold' };
  const consider = (to: Spot, action: Action, gain: number, why: string, posV: number) => {
    const sc = posV + gain * (1 + (rng() - 0.5) * 0.15);
    if (sc > best.score) best = { to: to.x === u.x && to.z === u.z ? null : to, action, score: sc, why };
  };
  const forced = (u.turnedOn && u.turnedOn.out === null ? u.turnedOn : null) ?? (u.tauntedBy && u.tauntedBy.out === null ? u.tauntedBy : null);
  const civiliansNear = (s: Spot) => b.units.filter((x) => x.out === null && (x.tags.has('captive') || x.tactic === 'civilian') && dist(x, s) <= 2).length;

  for (const { s, v } of scored) {
    for (const a of b.options(u, s)) {
      const t = 'target' in a && a.target != null ? b.get(a.target as Unit['id']) : undefined;
      if (forced && t && t !== forced && !['aid', 'free'].includes(a.kind)) continue;
      const p = b.odds(u, a, s).p;
      let g = 0, why: string = a.kind;
      switch (a.kind) {
        case 'attack': case 'ability': {
          if (!t) break;
          const spec = a.kind === 'ability' ? u.agent.abilities.get(a.abilityId) : undefined;
          const dmg = spec ? (spec.effects.filter((e) => e.op === 'damage').reduce((q, e) => q + e.amount, 0) || 16) : TUNE.damage * (0.75 + 0.08 * u.sheet.might);
          const kill = dmg >= t.agent.fighter.health;
          g = p * weight(t) * (Math.min(1, dmg / Math.max(1, t.agent.fighter.health)) + (kill ? (lethalOk(t) ? 0.7 : -0.9) : 0));
          if (spec && spec.header.range > 3 && dist(s, t) > 1) g *= 1.15;       // shooting from range is safer
          if (spec?.effects.some((e) => e.op === 'expose') && friends.length) g += p * 0.35 * weight(t);
          why = t.morale === 'broken' ? 'cut down the fleeing' : spec ? spec.name : 'attack';
          break;
        }
        case 'shove': {
          if (!t) break;
          const d = b.dirFrom(s, t), nx = t.x + d[0], nz = t.z + d[1];
          const tile = b.map.tile(nx, nz);
          let bonus = 0.12;
          if (tile && (tile.burning || b.map.propAt(nx, nz)?.fireSource)) { bonus = 1.0 * (0.5 + tr.ruthlessness); why = 'shove into the fire'; }
          else if (tile && b.map.standH(t.x, t.z) - b.map.standH(nx, nz) > FALL_SAFE) { bonus = 0.9; why = 'shove off the ledge'; }
          else if (!tile || !b.map.standable(nx, nz)) { bonus = 0.3; why = 'slam into the wall'; }
          if (t.tactic === 'archer') bonus += 0.15;
          g = p * weight(t) * bonus;
          break;
        }
        case 'kick': {
          const pr = b.map.props.get(a.prop); if (!pr) break;
          const d = b.dirFrom(s, pr);
          const line = (n: number) => foes.filter((f) => { for (let i = 0; i < n; i++) if (f.x === pr.x + d[0] * i && f.z === pr.z + d[1] * i) return true; return false; });
          if (pr.kind === 'brazier') { const vs = line(4); g = vs.length * 0.9 * (0.6 + tr.ruthlessness) - civiliansNear(pr) * tr.compassion * 1.5; why = 'spill the brazier on them'; }
          else if (pr.kind === 'barrel' || pr.kind === 'oil') { g = line(5).length * 0.6; why = 'roll the barrel into them'; }
          else if ((pr.kind === 'table' || pr.kind === 'cart') && !pr.tipped) { g = foes.some((f) => f.tactic === 'archer') ? 0.3 : 0.1; why = 'make cover'; }
          break;
        }
        case 'ignite': {
          const near = foes.filter((f) => dist(f, a.at) <= 1);
          const ours = friends.filter((f) => dist(f, a.at) <= 2).length + (dist(s, a.at) <= 1 ? 1 : 0);
          const pr = b.map.propAt(a.at.x, a.at.z);
          g = near.length * (pr?.kind === 'oil' ? 1.4 : pr?.kind === 'hay' || pr?.kind === 'tent' ? 0.9 : 0.45) * (0.5 + tr.ruthlessness) - ours * 0.8 - civiliansNear(a.at) * (0.5 + tr.compassion * 2);
          if (u.tactic === 'beast') g = -1;
          why = pr ? `set ${pr.name} alight` : 'light the grass';
          break;
        }
        case 'throw': {
          const tu = b.unitAt(a.at.x, a.at.z);
          const pr = b.map.props.get(a.prop) ?? u.carrying;
          if (!tu || !pr || pr.kind === 'relic') break;
          g = p * weight(tu) * (pr.fireSource ? 0.9 * (0.4 + tr.ruthlessness) : pr.blinding ? (tu.tactic === 'archer' ? 0.8 : 0.45) : pr.liquid ? 0.15 : 0.35);
          break;
        }
        case 'douse': g = (u.burning > 0 && dist(s, a.at) <= 1 ? 1.3 : 0) + friends.filter((f) => f.burning && dist(f, a.at) <= 1).length * (0.4 + tr.compassion * 0.6); why = 'put out the fire'; break;
        case 'pickup': {
          const pr = b.map.props.get(a.prop);
          g = pr?.kind === 'relic' && goals.retrieve === pr.id && u.side === 'us' ? 1.8 : 0; why = 'take the reliquary';
          if (pr?.fireSource && !u.carrying && tr.ruthlessness > 0.5) { g = 0.35 * tr.ruthlessness; why = 'take up a torch'; }
          break;
        }
        case 'free': g = u.side === 'us' ? 2.0 + tr.compassion : 0; why = 'cut the captive free'; break;
        case 'grab': g = (o.kind === 'rob' && u.loot === 0 && t ? p * (t.id === o.targetId ? 1.8 : 0.9) : 0) + (u.traits || u.role === 'player' ? p * tr.ruthlessness * 0.5 * (1 - tr.compassion) : 0); break;
        case 'subdue': {
          if (!t) break;
          const want = (o.kind === 'capture' || o.kind === 'enforce') && t.id === o.targetId ? 1
            : (u.side === 'us' && goals.chief === t.id && goals.spareChief) ? 1.2
            : u.side === 'us' && tr.compassion > 0.8 && named(t) && t.agent.faction !== 'monster' ? 1.1 : tr.compassion * 0.4;
          g = p * want * (frac(t) < 0.45 ? 2.0 : 0.6);
          why = 'take them alive';
          break;
        }
        case 'aid': {
          const w = t ?? u;
          const care = 0.5 + tr.compassion * 1.2 + (u.tactic === 'healer' ? 0.8 : 0);
          g = w.out === 'downed' ? p * care * (w.role === 'player' ? 1.6 : 1.2) * (o.kind === 'protect' && o.wardId === w.id ? 1.5 : 1)
            : p * (1 - frac(w)) * (w === u ? 1.1 : 0.7 * care) * (frac(w) < 0.5 ? 1 : 0.15);
          why = w.out === 'downed' ? `haul ${b.nm(w)} up` : 'patch up';
          break;
        }
        case 'guard': g = t && frac(t) < 0.6 ? (o.kind === 'protect' && o.wardId === t.id ? 0.9 : 0.25 + tr.bravery * 0.3) * (u.tactic === 'guardian' ? 1.5 : 1) : 0; break;
        case 'defend': g = 0.08 + foes.filter((f) => dist(f, s) <= 1).length * 0.1 * (1.2 - risk) * (1 - frac(u)); break;
        // overwatch only pays when a foe could actually come into reach next turn; otherwise advance
        case 'overwatch': g = foes.some((f) => dist(f, s) <= 1) ? 0 : foes.some((f) => dist(f, s) <= f.move + 1) ? (u.tactic === 'archer' || u.tactic === 'leader' ? 0.4 : 0.2) : 0.02; break;
        case 'escape': {
          const carrying = u.carrying?.kind === 'relic';
          g = (o.kind === 'survive' ? 2.5 : 0) + (o.kind === 'rob' && u.loot > 0 ? 3 : 0) + (carrying && u.side === 'us' ? 3 : 0);
          if (u.role === 'player' && !carrying) g = 0;
          break;
        }
        case 'social': {
          if (a.verb === 'intimidate' && t) g = p * weight(t) * (t.morale === 'shaken' ? 0.9 : 0.4) * (u.sheet.presence >= 2 ? 1 : 0.3) * (u.tactic === 'leader' ? 1.4 : 1);
          else if (a.verb === 'bluff' && t) g = p * weight(t) * 0.3 * (u.sheet.presence >= 2 ? 1 : 0.3) * (u.tactic === 'rogue' ? 2 : 1);
          else if (a.verb === 'taunt' && t && (o.kind === 'protect' || u.tactic === 'guardian')) g = p * 0.6 * tr.bravery;
          else if (a.verb === 'rally') g = u.tactic === 'leader' && friends.some((f) => f.morale !== 'steady') ? p * 1.1 : 0;
          else if (a.verb === 'parley') {
            g = o.kind === 'survive' || (frac(u) < 0.3 && foes.length > friends.length + 1) ? p * 1.2 : 0;
            if (u.side === 'them' && u.tags.has('chief') && frac(u) < 0.35) g = p * 1.6;                // a beaten chief sues for terms
            if (u.side === 'us' && goals.chief && goals.spareChief) { const c = b.get(goals.chief); if (c && c.out === null && frac(c) < 0.4) g = p * 1.8; }
          }
          break;
        }
        default: break;
      }
      if (g > 0) consider(s, a, g, why, v);
    }
  }
  // nothing worth doing in reach: advance on the goal (captive, relic, chief) or the objective's target
  if (best.score < 0.3 && !u.moved) {
    const aim: Spot | undefined =
      (u.side === 'us' && goals.rescue != null ? b.units.find((x) => x.id === goals.rescue && x.bound) : undefined)
      ?? (u.side === 'us' && goals.retrieve ? b.map.props.get(goals.retrieve) : undefined)
      ?? (o.targetId != null ? b.get(o.targetId) : undefined) ?? b.nearestFoe(u);
    if (aim) {
      let bs: Spot | null = null, bd = dist(u, aim);
      for (const s of spots) { const d = dist(s, aim); if (d < bd) { bd = d; bs = s; } }
      if (bs) best = { to: bs, action: u.tactic === 'archer' ? { kind: 'overwatch' } : { kind: 'defend' }, score: 0.2, why: 'close in' };
    }
  }
  // the relic-bearer makes for the edge once the fight is thinning
  if (u.carrying?.kind === 'relic' && u.side === 'us' && !u.moved && u.role !== 'player') { const e = fleePlan(b, u, 'carry the reliquary out'); if (e.to) best = e; }
  return best;
}

function fleePlan(b: Battle, u: Unit, why: string): Plan {
  if (b.map.edge(u.x, u.z)) return { to: null, action: { kind: 'escape' }, score: 3, why };
  let best: Spot | null = null, bd = 99;
  const foes = b.foesOf(u);
  for (const k of b.reachable(u).keys()) {
    const [x, z] = k.split(',').map(Number);
    const edgeD = Math.min(x, z, b.map.n - 1 - x, b.map.n - 1 - z);
    const threat = foes.filter((f) => dist(f, { x, z }) <= 1).length;
    const d = edgeD + threat * 3;
    if (d < bd) { bd = d; best = { x, z }; }
  }
  const at = best ?? { x: u.x, z: u.z };
  return { to: best, action: b.map.edge(at.x, at.z) ? { kind: 'escape' } : { kind: 'defend' }, score: 2, why };
}

/** How good a spot is to stand on, before any action — shaped by the unit's role. */
function positionValue(b: Battle, u: Unit, s: Spot): number {
  let v = 0;
  const t = b.map.tile(s.x, s.z)!;
  if (t.burning) v -= 1.5;
  const foes = b.foesOf(u);
  const nearest = Math.min(...foes.map((f) => dist(f, s)), 12);
  const role = u.tactic;
  for (const f of foes) {
    if (!b.map.sees(f.x, f.z, s.x, s.z)) { v += 0.03; continue; }
    v += b.map.coverAgainst(s.x, s.z, f.x, f.z) * (role === 'archer' || role === 'healer' ? 0.12 : 0.06);
    v += b.heightEdge(s, f) * (role === 'archer' || role === 'leader' ? 0.18 : 0.08);
    if (b.facingOf(s, f) === 'back') v += role === 'beast' || role === 'rogue' || role === 'skirmisher' ? 0.3 : 0.1;
    else if (b.facingOf(s, f) === 'side') v += role === 'beast' || role === 'rogue' ? 0.12 : 0.03;
  }
  if (role === 'archer') v += nearest >= 3 && nearest <= 6 ? 0.35 : nearest <= 1 ? -0.4 : 0;
  if (role === 'healer') v += nearest >= 2 ? 0.15 : -0.2;
  if (role === 'leader') v += nearest >= 2 && nearest <= 4 ? 0.15 : 0;
  if (role === 'beast') for (const [dx, dz] of [[0, 0], ...DIRS]) { const n = b.map.tile(s.x + dx, s.z + dz); if (n && (n.burning || b.map.propAt(n.x, n.z)?.fireSource)) v -= 0.8; }
  if (role === 'guardian') { const hurt = b.friendsOf(u).find((f) => f.out === null && frac(f) < 0.6); if (hurt && dist(hurt, s) === 1) v += 0.2; }
  if (key(s.x, s.z) === key(u.x, u.z)) v += 0.02;
  return v;
}

/** Run a unit's whole turn: move (if planned), act, end facing the nearest foe. */
export function runTurn(b: Battle, u: Unit): Plan {
  const plan = planTurn(b, u);
  if (plan.to) b.moveTo(u, plan.to);
  if (u.out === null && u.agent.alive && b.current() === u && !u.acted) {
    const err = b.act(u, plan.action);
    if (err && plan.action.kind !== 'defend') b.act(u, { kind: 'defend' });
  }
  if (b.current() === u) b.endTurn(u);
  return plan;
}
