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
import { areaTiles } from './pieces.js';
import { answers, callName, feasible, heardCalls, wantSpot, willingness } from './comms.js';

const frac = (u: Unit) => Math.max(0, u.agent.fighter.health) / TUNE.maxHealth;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

export interface Plan { to: Spot | null; action: Action; score: number; why: string; }

const T = (u: Unit) => u.traits ?? { bravery: 0.5, compassion: 0.5, loyalty: 0.5, ruthlessness: 0.3 };

/**
 * TEAMWORK: how well u reads a friend — the bond between them, and u's loyalty. It sets how deep
 * u's theory of mind about that friend goes (simulate their turn, or just guess).
 */
export function teamwork(b: Battle, u: Unit, a: Unit): number { return b.bondOf(u, a).lvl + (u.traits ? u.traits.loyalty * 2 : 1); }

/**
 * THEORY OF MIND about the rest of my side this round: which foes will the friends who act after
 * me go for? Told (an announced plan) → certain. Close teamwork → I simulate their turn. Otherwise
 * a guess: whoever is nearest them. The player's mind can't be read — only what they say.
 */
export function predictAllies(b: Battle, u: Unit): Map<Unit['id'], number> {
  const out = new Map<Unit['id'], number>();
  const bump = (t: Unit['id'], w: number) => out.set(t, Math.max(out.get(t) ?? 0, w));
  const idx = b.order.indexOf(u);
  for (const a of b.order.slice(idx + 1)) {
    if (a.side !== u.side || a.out !== null || a.tactic === 'civilian' || a.bound) continue;
    const plan = b.calls.find((c) => c.kind === 'plan' && c.from === a.id && c.round >= b.round - 1 && c.heardBy.includes(u.id));
    if (plan) { if (plan.want.target != null) bump(plan.want.target, 1); continue; }
    if (a.role === 'player') continue;
    const tw = teamwork(b, u, a), tf = Math.min(1, 0.2 + 0.25 * tw);
    if (tw >= 2) {
      const p = planTurn(b, a, { predict: true });
      const t = (p.action as { target?: Unit['id'] }).target;
      if (t != null && t !== -1 && b.get(t)?.side !== u.side) bump(t, tf);
    } else {
      const f = b.nearestFoe(a);
      if (f && dist(f, a) <= a.move + 1) bump(f.id, tf * 0.6);
    }
  }
  return out;
}

/** The foe an action would lay open for someone else (prone, exposed, stunned) — if any. */
function setupOf(b: Battle, u: Unit, a: Action, s: Spot): Unit['id'] | null {
  const t = 'target' in a && a.target != null ? b.get(a.target as Unit['id']) : undefined;
  switch (a.kind) {
    case 'shove': {
      if (!t) return null;
      const d = b.dirFrom(s, t), nx = t.x + d[0], nz = t.z + d[1];
      const tile = b.map.tile(nx, nz);
      return !tile || !b.map.standable(nx, nz) || b.unitAt(nx, nz) || b.map.standH(t.x, t.z) - b.map.standH(nx, nz) > FALL_SAFE ? t.id : null;
    }
    case 'ability': { const spec = u.agent.abilities.get(a.abilityId); return t && spec?.effects.some((e) => e.op === 'expose' || e.op === 'stun' || e.op === 'knockback') ? t.id : null; }
    case 'social': return t && a.verb === 'bluff' && a.claim === 'look_behind' ? t.id : null;
    case 'trip': return t ? t.id : null;
    case 'throw': { const p = b.map.props.get(a.prop) ?? u.carrying; const tu = b.unitAt(a.at.x, a.at.z); return p?.blinding && tu ? tu.id : null; }
    case 'use': {
      const pc = b.pieces.get(a.piece); if (!pc) return null;
      for (const e of pc.effects) if (e.do === 'hit' && e.prone) for (const q of areaTiles(pc, e.area, s, (x) => !!b.map.tile(x.x, x.z))) { const v = b.unitAt(q.x, q.z); if (v && v.side !== u.side) return v.id; }
      return null;
    }
    default: return null;
  }
}

export function planTurn(b: Battle, u: Unit, opts: { predict?: boolean } = {}): Plan {
  const o = b.objectiveOf(u);
  const tr = T(u);
  const P = (u.agent.personality || {}) as Record<string, number>;
  const risk = u.traits ? tr.bravery : (P.risk_tolerance ?? 0.5);
  const foes = b.foesOf(u);
  const friends = b.friendsOf(u);
  const goals = b.goals;
  // what this unit heard: asks meant for it (weighed by trust in the speaker), and threats it overheard
  const heard = heardCalls(b, u);
  const asks = heard.filter((c) => c.kind === 'ask' && b.get(c.from)?.side === u.side && (c.to === 'all' || c.to.includes(u.id)))
    .map((c) => ({ c, w: willingness(b, u, b.get(c.from)!, c.want).w, can: opts.predict ? true : feasible(b, u, c.want), at: wantSpot(b, c.want) }));
  const threatened = heard.some((c) => b.get(c.from)?.side !== u.side && c.want.target === u.id);
  // theory of mind: what the friends acting after me will go for (deeper the better we work together)
  const predicted = opts.predict ? new Map<Unit['id'], number>() : predictAllies(b, u);

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
    const sc = posV + gain * (1 + (opts.predict ? 0 : (rng() - 0.5) * 0.15));
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
          // exploit what a friend set up; hit what my friends are about to hit
          const ftm = b.followThrough(u, t);
          if (ftm) { g *= 1 + (ftm.mul - 1) * 1.5; why = `follow through on ${b.nm(ftm.by)}'s opening`; }
          g += p * 0.35 * (predicted.get(t.id) ?? 0);
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
        case 'hew': {
          const pr = b.map.props.get(a.prop);
          if (!pr || pr.kind !== 'tree' || pr.hp > b.hewDamage(u)) break;
          const d = b.dirFrom(s, pr);
          const under = foes.filter((f) => [1, 2].some((i) => f.x === pr.x + d[0] * i && f.z === pr.z + d[1] * i));
          g = under.length * 0.85; why = 'fell the tree on them';
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
        case 'trip': case 'disarm': {
          if (!t) break;
          // worth it as a set-up for friends (follow-through), or to blunt a heavy hitter
          const heavy = t.tactic === 'brute' || t.tactic === 'leader' || t.tags.has('chief');
          g = a.kind === 'trip' ? p * weight(t) * 0.25 : p * weight(t) * (heavy && !t.disarmed ? 0.4 : 0.1);
          why = a.kind === 'trip' ? 'sweep their legs' : 'knock the weapon away';
          break;
        }
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
        case 'use': {
          // a set-piece: worth what it catches (the same area maths the rules use), minus friends in the way
          const pc = b.pieces.get(a.piece);
          if (!pc || u.tactic === 'beast') break;
          const anchor = { x: pc.at[0][0], z: pc.at[0][1] };
          let val = 0;
          for (const e of pc.effects) {
            if (e.do === 'shake') { val += foes.filter((f) => dist(f, anchor) <= e.r && f.morale === 'steady' && f.out === null).length * 0.35; continue; }
            const tiles = new Set(areaTiles(pc, e.area, s, (q) => !!b.map.tile(q.x, q.z), (q) => !!b.unitAt(q.x, q.z)).map((q) => `${q.x},${q.z}`));
            const caught = b.active().filter((w) => w !== u && tiles.has(`${w.x},${w.z}`));
            const fh = caught.filter((w) => w.side !== u.side), mh = caught.filter((w) => w.side === u.side);
            if (e.do === 'hit') val += fh.reduce((q, w) => q + weight(w) * (Math.min(1, e.dmg / Math.max(1, w.agent.fighter.health)) + (e.prone ? 0.25 : 0)), 0) - mh.length * 1.1;
            else if (e.do === 'ignite') val += fh.length * 0.8 * (0.5 + tr.ruthlessness) - mh.length * 1.2 - civiliansNear(anchor) * tr.compassion;
            else if (e.do === 'flood') val += friends.filter((f) => f.burning > 0 && tiles.has(`${f.x},${f.z}`)).length * 0.8;
          }
          g = p * val; why = pc.label.toLowerCase();
          break;
        }
        case 'block': {
          // worth it when a foe could reach someone soft behind me next turn, and I stand in the lane
          const soft = friends.filter((w) => w !== u && (frac(w) < 0.6 || w.tactic === 'healer' || w.tactic === 'archer' || w.bound || w.carrying?.kind === 'relic') && dist(w, s) <= 2);
          const lanes = foes.filter((f) => dist(f, s) > 1 && dist(f, s) <= f.move + 1 && soft.some((w) => dist(f, s) < dist(f, w)));
          g = lanes.length && soft.length ? (0.22 + tr.bravery * 0.2) * (u.tactic === 'guardian' ? 1.6 : u.tactic === 'healer' || u.tactic === 'archer' ? 0.3 : u.tactic === 'beast' ? 0 : 1) * Math.min(2, lanes.length) : 0;
          why = 'hold the lane';
          break;
        }
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
      // set a foe up for a friend who will be there to finish it
      const su = setupOf(b, u, a, s);
      if (su != null && (predicted.get(su) ?? 0) > 0) { g += p * 0.55 * predicted.get(su)!; why = `set up ${b.nm(b.get(su)!)} for a friend`; }
      // what I was asked, if I'll go along with it; and bracing when I heard them plan against me
      let asked = 0;
      for (const { c, w, can, at } of asks) {
        if (answers(c.want, a, s)) asked += 0.9 * w;
        else if (!can && at) asked += 0.45 * w * Math.max(0, dist(u, at) - dist(s, at)) / Math.max(1, u.move);   // out of reach: close in
      }
      if (threatened && (a.kind === 'defend' || a.kind === 'block')) asked += 0.35;
      if (asked > 0.2 && !opts.predict) why = `${why} (as asked)`;
      if (g + asked > 0) consider(s, a, g + asked, why, v);
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

/** A companion answers a call meant for them: they'll do it, or say why not. Said once per call. */
function answerCalls(b: Battle, u: Unit, plan: Plan): void {
  const at = plan.to ?? { x: u.x, z: u.z };
  for (const c of heardCalls(b, u)) {
    if (c.kind !== 'ask' || c.answered.includes(u.id) || c.to === 'all' || !c.to.includes(u.id)) continue;
    const s = b.get(c.from); if (!s) continue;
    c.answered.push(u.id);
    if (!u.traits && u.tactic === 'beast') continue;
    const first = callName(u.agent.name);
    if (answers(c.want, plan.action, at)) { b.note('social', `${first}: “${u.traits && u.traits.loyalty > 0.6 ? 'On it!' : 'Aye.'}”`); continue; }
    const will = willingness(b, u, s, c.want);
    b.note('social', will.w < 0.35 ? `${first} won't${will.why ? ` — ${will.why}` : ''}.` : `${first} has a better idea: ${plan.why}.`);
  }
}

/** A leader barks an order at the start of their turn (their side weighs it like any call). */
function callOrders(b: Battle, u: Unit): void {
  if (u.tactic !== 'leader' || u.spoke || u.out !== null || b.round % 2 === 0) return;
  const foes = b.foesOf(u).filter((f) => f.out === null);
  if (!foes.length) return;
  const mark = foes.sort((x, y) => (y.tactic === 'healer' || y.tactic === 'archer' ? 1 : 0) - (x.tactic === 'healer' || x.tactic === 'archer' ? 1 : 0) || frac(x) - frac(y))[0];
  b.speak(u, { to: 'all', kind: 'ask', want: { kinds: ['attack'], target: mark.id }, words: `Take ${mark.agent.controlled ? 'that one' : callName(mark.agent.name)}!` });
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
  for (const f of foes) {
    if (dist(f, s) !== 1) continue;
    const opp = b.unitAt(2 * f.x - s.x, 2 * f.z - s.z);
    if (opp && opp !== u && opp.side === u.side && opp.out === null) v += role === 'rogue' || role === 'skirmisher' || role === 'beast' ? 0.3 : 0.15;
  }
  if (key(s.x, s.z) === key(u.x, u.z)) v += 0.02;
  return v;
}

/** Run a unit's whole turn: move (if planned), act, end facing the nearest foe. */
export function runTurn(b: Battle, u: Unit): Plan {
  callOrders(b, u);
  const plan = planTurn(b, u);
  answerCalls(b, u, plan);
  if (plan.to) b.moveTo(u, plan.to);
  const before = new Map(b.foesOf(u).map((f) => [f, [f.prone, f.exposed, f.stunned].join()]));
  if (u.out === null && u.agent.alive && b.current() === u && !u.acted) {
    const err = b.act(u, plan.action);
    if (err && plan.action.kind !== 'defend') b.act(u, { kind: 'defend' });
  }
  // laid someone open? call it, so the others can pile in
  if (!u.spoke && u.out === null && (u.traits || u.tactic === 'leader')) {
    const opened = [...before].find(([f, was]) => f.out === null && [f.prone, f.exposed, f.stunned].join() !== was && (f.prone || f.exposed || f.stunned));
    if (opened) {
      const f = opened[0];
      b.speak(u, { to: 'all', kind: 'ask', want: { kinds: ['attack'], target: f.id }, words: `${callName(f.agent.name)}'s ${f.prone ? 'down' : f.stunned ? 'reeling' : 'open'} — on them!` });
    }
  }
  if (b.current() === u) b.endTurn(u);
  return plan;
}
