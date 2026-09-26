// AFFORDANCES: everything the acting unit can do THIS TURN — from where it stands or from any tile it
// can still reach — with the GM's forecast of what each will do to the field. Read-only over the
// battle; the UI lists these, previews their footprint on the grid, and runs them (move, then act).
//
//   affordances(b, u)   one entry per distinct action, from the cheapest good tile to do it from
//   forecast(b, u, a)   plain words + the tiles it touches ("spills burning coals 4 tiles — catches Garrick")
//   propTraits(p)       what an object IS, in play terms (heavy, burns, half cover, climbable…)

import { DIRS, FALL_SAFE, key, type Prop } from './map.js';
import type { Action, Battle, Spot, Unit } from './battle.js';

export type AffGroup = 'Environment' | 'Fight' | 'People' | 'Stance';
export type Subject = { kind: 'prop'; id: string } | { kind: 'unit'; id: Unit['id'] } | null;

export interface Affordance {
  /** Where to stand first (null = act from here). */
  to: Spot | null;
  /** Steps of movement that costs (0 = from here). */
  steps: number;
  action: Action;
  label: string;
  p: number;
  /** The GM's modifiers for the roll (flank, high ground, braced…). */
  notes: string[];
  /** What it will do, in plain words ('' when obvious). */
  effect: string;
  /** Tiles it touches: the fall line, the spill, the cloud, where a shoved foe lands. */
  footprint: Spot[];
  /** Foes / friends caught in the footprint. */
  catches: Unit[];
  subject: Subject;
  group: AffGroup;
  /** Environment interactions that hurt foes rank first. */
  rank: number;
  /** What the walk there costs you: opportunity swings, overwatch. */
  risks: string[];
}

export interface Verb { key: string; name: string; icon: string; group: AffGroup; env: boolean }

/** The verb an option is an instance of ("Kick", "Throw", "Power Strike", "Intimidate"). */
export function verbOf(u: Unit, a: Action): Verb {
  const V = (key: string, name: string, icon: string, group: AffGroup, env = false): Verb => ({ key, name, icon, group, env });
  switch (a.kind) {
    case 'kick': return V('kick', 'Kick', '🦶', 'Environment', true);
    case 'shove': return V('shove', 'Shove', '✋', 'Environment', true);
    case 'hew': return V('hew', 'Chop', '🪓', 'Environment', true);
    case 'throw': return V('throw', 'Throw', '🎯', 'Environment', true);
    case 'ignite': return V('ignite', 'Set alight', '🔥', 'Environment', true);
    case 'douse': return V('douse', 'Douse', '💧', 'Environment', true);
    case 'pickup': return V('pickup', 'Pick up', '👐', 'Environment', true);
    case 'attack': return V('attack', 'Attack', '⚔', 'Fight');
    case 'ability': return V(`ability:${a.abilityId}`, (u.agent.abilities.get(a.abilityId)?.name ?? 'Ability').replace(/[[\]]/g, ''), '✦', 'Fight');
    case 'subdue': return V('subdue', 'Subdue', '⛓', 'Fight');
    case 'grab': return V('grab', 'Pickpocket', '👛', 'Fight');
    case 'guard': return V('guard', 'Guard', '🛡', 'People');
    case 'aid': return V('aid', 'Aid', '✚', 'People');
    case 'free': return V('free', 'Cut free', '✂', 'People');
    case 'social': return V(`social:${a.verb}`, a.verb[0].toUpperCase() + a.verb.slice(1), '🗣', a.target != null ? 'People' : 'Stance');
    default: return V(a.kind, ({ defend: 'Brace', overwatch: 'Overwatch', block: 'Block', escape: 'Escape', wait: 'Wait', dash: 'Dash' } as Record<string, string>)[a.kind] ?? a.kind, '', 'Stance');
  }
}

/** The tile you click to aim an option: what it's done TO (thrown at, lit, kicked, struck). */
export function aimOf(b: Battle, u: Unit, a: Action): Spot | null {
  if ('at' in a && a.at) return a.at;
  if ('prop' in a && a.prop) { const p = b.map.props.get(a.prop); return p ? { x: p.x, z: p.z } : u.carrying?.id === a.prop ? { x: u.x, z: u.z } : null; }
  if ('target' in a && a.target != null) { const t = b.get(a.target as Unit['id']); if (t) return { x: t.x, z: t.z }; const p = b.map.props.get(String(a.target)); if (p) return { x: p.x, z: p.z }; }
  return null;
}

const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
const STANCES = new Set(['defend', 'overwatch', 'block', 'escape', 'wait', 'dash']);

export function actionLabel(b: Battle, u: Unit, a: Action): string {
  const T = (id: unknown) => { const t = b.get(id as Unit['id']); return t ? b.nm(t) : '?'; };
  const P = (id: string) => b.map.props.get(id)?.name ?? u.carrying?.name ?? 'it';
  switch (a.kind) {
    case 'attack': return `Attack ${T(a.target)}`;
    case 'ability': return `${u.agent.abilities.get(a.abilityId)?.name ?? 'Ability'} → ${T(a.target)}`;
    case 'shove': return b.get(a.target as Unit['id']) ? `Shove ${T(a.target)}` : `Shove ${P(String(a.target))}`;
    case 'kick': return `Kick ${P(a.prop)}`;
    case 'hew': return b.map.props.get(a.prop)?.kind === 'tree' ? `Chop ${P(a.prop)}` : `Smash ${P(a.prop)}`;
    case 'throw': return `Throw ${P(a.prop)} at ${b.unitAt(a.at.x, a.at.z) ? b.nm(b.unitAt(a.at.x, a.at.z)!) : 'there'}`;
    case 'ignite': return `Set ${b.map.propAt(a.at.x, a.at.z)?.name ?? 'the grass'} alight`;
    case 'douse': { const w = b.unitAt(a.at.x, a.at.z); return `Douse ${w ? b.nm(w) : 'the flames'}`; }
    case 'pickup': return `Pick up ${P(a.prop)}`;
    case 'grab': return `Grab ${T(a.target)}'s purse`;
    case 'subdue': return `Subdue ${T(a.target)}`;
    case 'aid': return a.target === u.id ? 'Patch yourself up' : `Aid ${T(a.target)}`;
    case 'free': return `Cut ${T(a.target)} free`;
    case 'guard': return `Guard ${T(a.target)}`;
    case 'social': return `${a.verb[0].toUpperCase() + a.verb.slice(1)}${a.target != null ? ' ' + T(a.target) : ''}`;
    case 'ready': return 'Ready';
    case 'block': return 'Block (hold the ground)';
    case 'defend': return 'Brace';
    default: return a.kind[0].toUpperCase() + a.kind.slice(1);
  }
}

function groupOf(b: Battle, a: Action): AffGroup {
  if (['attack', 'ability', 'subdue', 'grab'].includes(a.kind) || (a.kind === 'shove' && b.get(a.target as Unit['id']))) return 'Fight';
  if (['kick', 'throw', 'ignite', 'douse', 'pickup', 'shove', 'hew'].includes(a.kind)) return 'Environment';
  if (a.kind === 'social' || a.kind === 'aid' || a.kind === 'guard' || a.kind === 'free') return 'People';
  return 'Stance';
}

function subjectOf(b: Battle, a: Action): Subject {
  if ('prop' in a && a.prop) return { kind: 'prop', id: a.prop };
  if (a.kind === 'shove' && !b.get(a.target as Unit['id'])) return { kind: 'prop', id: String(a.target) };
  if (a.kind === 'ignite') { const p = b.map.propAt(a.at.x, a.at.z); return p ? { kind: 'prop', id: p.id } : null; }
  if ('target' in a && a.target != null && b.get(a.target as Unit['id'])) return { kind: 'unit', id: a.target as Unit['id'] };
  if ('at' in a) { const w = b.unitAt(a.at.x, a.at.z); return w ? { kind: 'unit', id: w.id } : null; }
  return null;
}

/** The line a heavy thing travels, stopping at a wall, prop, rise, or the first body it hits. */
function slideLine(b: Battle, p: Spot, d: [number, number], n: number): Spot[] {
  const out: Spot[] = [];
  let cx = p.x, cz = p.z;
  for (let i = 0; i < n; i++) {
    const nx = cx + d[0], nz = cz + d[1];
    const t = b.map.tile(nx, nz);
    if (!t) break;
    out.push({ x: nx, z: nz });
    const hit = b.unitAt(nx, nz);
    if ((hit && hit.out === null) || t.wall || b.map.propAt(nx, nz) || b.map.standH(nx, nz) > b.map.standH(cx, cz) + 1) break;
    cx = nx; cz = nz;
  }
  return out;
}

/** Reactions the walk along `path` provokes (the same rules moveTo applies, replayed dry). */
export function pathRisks(b: Battle, u: Unit, path: Spot[]): string[] {
  const out: string[] = [], used = new Set<Unit>();
  let prev: Spot = { x: u.x, z: u.z };
  for (const step of path) {
    for (const f of b.foesOf(u)) {
      if (used.has(f) || f.reacted || f.stunned || f.prone) continue;
      if (b.adjacent(f, prev) && !b.adjacent(f, step)) { used.add(f); out.push(`${b.nm(f)} swings as you break away`); continue; }
      if (!f.overwatch) continue;
      const ranged = b.rangedReach(f);
      if (ranged ? dist(f, step) <= ranged && b.map.sees(f.x, f.z, step.x, step.z) : b.adjacent(f, step)) { used.add(f); out.push(`walks into ${b.nm(f)}'s overwatch`); }
    }
    prev = step;
  }
  return out;
}

/** What `a`, done by u standing at `from`, will do to the field. */
export function forecast(b: Battle, u: Unit, a: Action, from: Spot = u): { effect: string; footprint: Spot[] } {
  const prop = (id: string) => b.map.props.get(id) ?? (u.carrying?.id === id ? u.carrying : undefined);
  switch (a.kind) {
    case 'kick': {
      const p = prop(a.prop); if (!p) break;
      const d = b.dirFrom(from, p);
      if (p.kind === 'brazier') {
        const fp: Spot[] = [];
        for (let i = 0; i < 4; i++) if (b.map.tile(p.x + d[0] * i, p.z + d[1] * i)) fp.push({ x: p.x + d[0] * i, z: p.z + d[1] * i });
        return { effect: 'spills burning coals 4 tiles', footprint: fp };
      }
      if (p.kind === 'table' || p.kind === 'cart') return { effect: `tips it over — ${p.kind === 'cart' ? 'full' : 'half'} cover`, footprint: [{ x: p.x, z: p.z }] };
      const n = p.kind === 'barrel' || p.kind === 'oil' ? 5 : 1;
      return { effect: n > 1 ? `rolls it up to ${n} tiles — flattens whoever it hits` : 'boots it a tile', footprint: slideLine(b, p, d, n) };
    }
    case 'shove': {
      const t = b.get(a.target as Unit['id']);
      if (t) {
        const d = b.dirFrom(from, t);
        const nx = t.x + d[0], nz = t.z + d[1];
        const tile = b.map.tile(nx, nz);
        const why = !tile ? 'off the field' : tile.burning || b.map.propAt(nx, nz)?.fireSource ? 'into the fire!'
          : b.map.standH(t.x, t.z) - b.map.standH(nx, nz) > FALL_SAFE ? 'off the ledge!' : !b.map.standable(nx, nz) || b.unitAt(nx, nz) ? 'into an obstacle' : 'a tile back';
        return { effect: `pushes ${b.nm(t)} ${why}`, footprint: tile ? [{ x: nx, z: nz }] : [] };
      }
      const p = prop(String(a.target)); if (!p) break;
      const n = p.kind === 'barrel' || p.kind === 'oil' ? 4 : 2;
      return { effect: `heaves it up to ${n} tiles`, footprint: slideLine(b, p, b.dirFrom(from, p), n) };
    }
    case 'hew': {
      const p = prop(a.prop); if (!p) break;
      const blows = Math.ceil(Math.min(p.hp, p.kind === 'tree' ? 60 : 20) / Math.max(1, b.hewDamage(u)));
      if (p.kind !== 'tree') return { effect: blows > 1 ? `${blows} blows to smash` : 'smashes it to kindling', footprint: [{ x: p.x, z: p.z }] };
      const d = b.dirFrom(from, p);
      const fp = [1, 2].map((i) => ({ x: p.x + d[0] * i, z: p.z + d[1] * i })).filter((s) => b.map.tile(s.x, s.z));
      return { effect: blows > 1 ? `${blows} blows to fell — then it falls away from you` : 'fells it — it falls away from you, leaving half cover', footprint: blows > 1 ? [{ x: p.x, z: p.z }] : fp };
    }
    case 'throw': {
      const p = prop(a.prop); if (!p) break;
      const at = a.at;
      if (p.blinding) return { effect: 'bursts into a blinding cloud', footprint: [[0, 0], ...DIRS].map(([dx, dz]) => ({ x: at.x + dx, z: at.z + dz })).filter((s) => b.map.tile(s.x, s.z)) };
      if (p.liquid) return { effect: 'soaks them — puts out fire, leaves them exposed', footprint: [{ x: at.x, z: at.z }] };
      if (p.fireSource) return { effect: 'sets them alight', footprint: [{ x: at.x, z: at.z }] };
      return { effect: p.kind === 'rocks' ? 'a hard blow' : 'a glancing blow', footprint: [{ x: at.x, z: at.z }] };
    }
    case 'ignite': {
      const p = b.map.propAt(a.at.x, a.at.z);
      const fp = [{ x: a.at.x, z: a.at.z }];
      if (p?.kind === 'oil') { for (const [dx, dz] of DIRS) if (b.map.tile(a.at.x + dx, a.at.z + dz)) fp.push({ x: a.at.x + dx, z: a.at.z + dz }); return { effect: 'the oil goes up in a burst', footprint: fp }; }
      return { effect: p ? `${p.name} catches — fire spreads to what burns nearby` : 'the grass catches', footprint: fp };
    }
    case 'douse': return { effect: 'puts out the fire', footprint: [{ x: a.at.x, z: a.at.z }] };
    case 'pickup': { const p = prop(a.prop); return { effect: p?.fireSource ? 'carry a flame — beasts fear it; light things' : p?.kind === 'relic' ? 'take the objective' : 'carry it (costs no action)', footprint: [] }; }
    case 'block': return { effect: 'foes who step next to you must stop there', footprint: DIRS.map(([dx, dz]) => ({ x: from.x + dx, z: from.z + dz })).filter((s) => b.map.tile(s.x, s.z)) };
    case 'overwatch': return { effect: 'strike the first foe who comes into reach', footprint: [] };
    case 'defend': return { effect: 'harder to hit until your next turn', footprint: [] };
    case 'guard': return { effect: 'blows at them are harder while you are close', footprint: [] };
    case 'subdue': return { effect: 'beat them down to take them alive', footprint: [] };
    case 'escape': return { effect: 'leave the fight', footprint: [] };
    default: break;
  }
  return { effect: '', footprint: [] };
}

/**
 * Everything u can do this turn. An action you can take from here is offered from here; otherwise
 * from the reachable tile that gives the best odds (then the fewest steps). Stances only from here.
 */
export function affordances(b: Battle, u: Unit): Affordance[] {
  if (u.acted || b.outcome) return [];
  const here: Spot = { x: u.x, z: u.z };
  const spots: Array<{ s: Spot; cost: number; path: Spot[] }> = [{ s: here, cost: 0, path: [] }];
  if (!u.moved) for (const [k, r] of b.reachable(u)) { const [x, z] = k.split(',').map(Number); spots.push({ s: { x, z }, cost: r.cost, path: r.path }); }
  const best = new Map<string, Affordance>();
  for (const { s, cost, path } of spots) {
    for (const a of b.options(u, s)) {
      if (cost > 0 && STANCES.has(a.kind)) continue;
      if (cost > 0 && a.kind === 'social' && a.verb !== 'intimidate') continue;
      const k = JSON.stringify(a);
      const o = b.odds(u, a, s);
      const prev = best.get(k);
      // prefer here; else higher odds; else fewer steps
      if (prev && (prev.steps === 0 || prev.p > o.p + 1e-6 || (Math.abs(prev.p - o.p) < 1e-6 && prev.steps <= cost))) continue;
      const f = forecast(b, u, a, s);
      const fpk = new Set(f.footprint.map((t) => key(t.x, t.z)));
      const catches = b.active().filter((w) => w !== u && fpk.has(key(w.x, w.z)));
      const g = groupOf(b, a);
      const foesHit = catches.filter((w) => w.side !== u.side).length, friendsHit = catches.filter((w) => w.side === u.side).length;
      const risks = cost ? pathRisks(b, u, path) : [];
      const effect = f.effect + (catches.length ? ` — catches ${catches.map((w) => b.nm(w)).join(', ')}` : '');
      best.set(k, {
        to: cost ? s : null, steps: cost, action: a, label: actionLabel(b, u, a), p: o.p, notes: o.notes, effect, footprint: f.footprint, catches,
        subject: subjectOf(b, a), group: g, rank: foesHit * 3 - friendsHit * 4 + o.p - cost * 0.1 - risks.length * 0.6, risks,
      });
    }
  }
  return [...best.values()].sort((x, y) => y.rank - x.rank);
}

/** What an object IS, in play terms. */
export function propTraits(b: Battle, u: Unit | null, p: Prop): string[] {
  const t: string[] = [];
  if (p.cover) t.push(p.cover === 2 ? 'full cover' : 'half cover');
  if (p.weight === 0) t.push('light — pick up, throw');
  else if (p.weight === 1) t.push('heavy — kick, shove');
  if (p.climbable) t.push('climb on it (high ground)');
  if (p.fireSource) t.push('fire source — lights what’s next to it');
  else if (p.flammable) t.push(p.burning > 0 ? 'burning!' : 'burns');
  if (p.kind === 'oil') t.push('bursts into flame');
  if (p.kind === 'brazier') t.push('kick it over to spill coals');
  if (p.liquid) t.push('water — douses fire');
  if (p.blinding) t.push('bursts into a blinding cloud');
  if (p.kind === 'tree' && u) t.push(`fell it: ${Math.ceil(p.hp / Math.max(1, b.hewDamage(u)))} blows, falls 2 tiles`);
  if (p.kind === 'relic') t.push('the objective');
  return t;
}

/** Short icons for an object's uses this turn (for the in-world marker). */
export function useIcons(affs: Affordance[]): string {
  const k = new Set(affs.map((a) => a.action.kind));
  return [k.has('kick') || k.has('shove') ? '🦶' : '', k.has('hew') ? '🪓' : '', k.has('pickup') ? '✋' : '', k.has('throw') ? '🎯' : '',
    k.has('ignite') ? '🔥' : '', k.has('douse') ? '💧' : ''].join('');
}

