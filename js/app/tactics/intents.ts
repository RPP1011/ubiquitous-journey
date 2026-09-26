// INTENTS: at the start of your turn every other unit settles what it will do on its own next turn,
// and COMMITS to it. Foes share their plans with the friends in earshot (so they coordinate
// exactly) and shout the notable ones — which is how you read them. On its turn a unit carries out
// its intent if it still can; if you've moved the target, blocked the lane or knocked it down, the
// plan is foiled and it has to think again. Telegraphed, counterable — each turn a small puzzle.

import { planTurn } from './ai.js';
import { hears, callName, type Want } from './comms.js';
import type { Action, Battle, Spot, Unit } from './battle.js';

type Id = Unit['id'];

export interface Intent {
  unit: Id;
  /** Where it will act from (null = where it stands). */
  to: Spot | null;
  action: Action;
  why: string;
  /** The unit it means to act on, if any. */
  target?: Id;
  round: number;
}

const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

function targetOf(a: Action): Id | undefined {
  if ('target' in a && a.target != null && typeof a.target !== 'string') return a.target as Id;
  if (a.kind === 'ready' && 'target' in a.response && a.response.target != null && a.response.target !== -1) return a.response.target as Id;
  return undefined;
}

/** The kind of thing an intent is, in the words of a call (for allies' predictions). */
function wantOf(a: Action): Want {
  const t = targetOf(a);
  const kind = a.kind === 'ability' ? 'attack' : a.kind;
  return { kinds: [kind], ...(t != null ? { target: t } : {}) };
}

/** What a foe shouts when its plan is worth shouting. */
function shout(b: Battle, u: Unit, a: Action): string | null {
  const t = targetOf(a) != null ? b.get(targetOf(a)!) : undefined;
  const who = t ? (t.agent.controlled ? 'you' : callName(t.agent.name)) : '';
  if (u.tactic === 'beast') return null;
  switch (a.kind) {
    case 'attack': case 'ability': return t ? (t.tactic === 'healer' ? `The healer — get ${who}!` : t.agent.controlled ? 'I\'ll gut you myself!' : `${who[0].toUpperCase() + who.slice(1)}'s mine!`) : null;
    case 'charge': return t ? `Out of my way — I'm coming for ${who}!` : null;
    case 'shove': return t ? `I'll put ${who} in the dirt!` : null;
    case 'use': return 'Bring it down on them!';
    case 'overwatch': return 'Let them come. I\'m ready.';
    case 'escape': return 'I\'m done — I\'m getting out!';
    case 'social': return a.verb === 'rally' ? 'On me! Hold together!' : null;
    default: return null;
  }
}

/** Settle every other unit's next move, and let their side hear it. Called as your turn begins. */
export function telegraph(b: Battle): void {
  b.intents.clear();
  const shouted: Array<{ u: Unit; words: string; w: number }> = [];
  for (const u of b.active()) {
    if (b.playerControls(u) || u.tactic === 'civilian' || u.bound) continue;
    const p = planTurn(b, u, { predict: true });
    const it: Intent = { unit: u.id, to: p.to, action: p.action, why: p.why, target: targetOf(p.action), round: b.round };
    b.intents.set(u.id, it);
    // enemy comms: the plan is shared with the friends in earshot (their theory of mind is then exact)
    const heardBy = b.active().filter((l) => l !== u && l.side === u.side && hears(b, u, l)).map((l) => l.id);
    b.calls.push({ id: -1, from: u.id, to: 'all', kind: 'plan', want: wantOf(p.action), words: '', round: b.round, heardBy, answered: [] });
    if (u.side !== 'us') {
      const words = shout(b, u, p.action);
      const t = it.target != null ? b.get(it.target) : undefined;
      if (words) shouted.push({ u, words, w: (t?.agent.controlled ? 2 : 1) + (u.tags.has('chief') ? 1 : 0) + (p.action.kind === 'charge' ? 1 : 0) });
    }
  }
  // the loudest one or two are heard by everyone
  for (const s of shouted.sort((x, y) => y.w - x.w).slice(0, 2)) b.note('social', `${b.nm(s.u, true)}: “${s.words}”`);
  if (b.calls.length > 60) b.calls.splice(0, b.calls.length - 60);
}

/**
 * On its turn, a unit carries out what it committed to — from the planned tile if it can still
 * get there, else from anywhere it can do the same thing. Returns null when the plan is foiled.
 */
export function honour(b: Battle, u: Unit, it: Intent): { to: Spot | null; action: Action } | null {
  if (it.round < b.round - 1) return null;
  const t = it.target != null ? b.get(it.target) : undefined;
  if (it.target != null && (!t || t.out !== null)) return null;
  const reach = u.moved ? new Map() : b.reachable(u);
  const here = { x: u.x, z: u.z };
  const tiles: Spot[] = [here, ...[...reach.keys()].map((k: string) => { const [x, z] = k.split(',').map(Number); return { x, z }; })];
  const goal = it.to ?? here;
  tiles.sort((p, q) => dist(p, goal) - dist(q, goal));
  const same = (o: Action) => JSON.stringify({ ...o, at: undefined }) === JSON.stringify({ ...it.action, at: undefined }) || (o.kind === it.action.kind && targetOf(o) != null && targetOf(o) === targetOf(it.action));
  for (const s of tiles) {
    if (['defend', 'overwatch', 'block', 'wait'].includes(it.action.kind) && dist(s, goal) > 0 && tiles.some((x) => dist(x, goal) === 0)) continue;
    const o = b.options(u, s).find(same);
    if (o) return { to: s.x === u.x && s.z === u.z ? null : s, action: o };
  }
  return null;
}
