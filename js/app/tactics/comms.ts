// COMMUNICATION: talk is a first-class, free move — once per turn you can call out to your side.
// Nobody obeys: a call is weighed by each listener's own decision-making (ai.ts), scaled by how
// far they trust the speaker (loyalty, bond, a chief's authority), whether it clashes with who they
// are (asking the merciful to cut down a yielding man), and whether it's any good from where they
// stand. Foes close by may overhear, and brace.
//
//   ask    "Borin, block Fitch" / "everyone on the archer"      → listeners may do it
//   plan   "I'll shove Garrick"                                   → allies can predict you exactly

import type { Action, Battle, Spot, Unit } from './battle.js';

type Id = Unit['id'];
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

/** What the speaker wants done (or says they'll do). Unset fields don't constrain. */
export interface Want {
  kinds: string[];
  target?: Id;           // a foe to act on
  ally?: Id;             // a friend to guard / aid / free / keep someone from
  prop?: string;
  piece?: string;
  near?: Spot;           // be about here ("hold the gate", "come to me")
}

export interface Call {
  id: number;
  from: Id;
  /** Who it's for: named listeners, or everyone on the speaker's side. */
  to: Id[] | 'all';
  kind: 'ask' | 'plan';
  want: Want;
  words: string;
  round: number;
  heardBy: Id[];
  /** Listeners who have already answered it (did it, or said no). */
  answered: Id[];
}

/** Earshot: close, or in sight and not far. */
export function hears(b: Battle, speaker: Unit, l: Unit): boolean {
  if (l === speaker || l.out !== null) return false;
  const d = dist(speaker, l);
  return d <= 5 || (d <= 10 && b.map.sees(speaker.x, speaker.z, l.x, l.z));
}

/** Does doing `a` from `at` answer the want? */
export function answers(w: Want, a: Action, at: Spot): boolean {
  const kind = a.kind === 'ability' ? 'attack' : a.kind === 'ready' ? `ready:${a.response.kind === 'ability' ? 'attack' : a.response.kind}` : a.kind;
  if (!w.kinds.includes(kind) && !(kind.startsWith('ready:') && w.kinds.includes(kind.slice(6)))) return false;
  const A = a as Record<string, unknown>;
  if (w.target != null && A.target !== undefined && A.target !== w.target && A.target !== -1) return false;
  if (w.target != null && a.kind === 'throw') { /* thrown at a tile — accept */ }
  if (w.ally != null && ['guard', 'aid', 'free'].includes(a.kind) && A.target !== w.ally) return false;
  if (w.prop != null && A.prop !== undefined && A.prop !== w.prop && A.target !== w.prop) return false;
  if (w.piece != null && a.kind === 'use' && a.piece !== w.piece) return false;
  if (w.near && dist(at, w.near) > 1) return false;
  return true;
}

/**
 * How ready `l` is to do what `s` asks (0..1) — and, when low, why. Trust is loyalty and the bond
 * for companions, rank for foes; it drops when the ask cuts against who they are.
 */
export function willingness(b: Battle, l: Unit, s: Unit, w: Want): { w: number; why: string } {
  if (l.morale === 'broken') return { w: 0, why: 'is past listening' };
  let trust: number;
  if (l.traits) trust = 0.25 + 0.5 * l.traits.loyalty + 0.1 * b.bondOf(l, s).lvl;
  else trust = 0.4 + (s.tags.has('chief') || s.tactic === 'leader' ? 0.35 : 0);
  trust -= b.brokenWord.get(s.id) ?? 0;                                   // said one thing, did another
  if (b.bondOf(l, s).kind === 'rival') trust -= 0.2;                      // and a rival hears everything as an order
  let why = '';
  const t = w.target != null ? b.get(w.target) : undefined;
  const tr = l.traits;
  if (tr && t && w.kinds.some((k) => k === 'attack' || k === 'ignite') && (t.morale === 'broken' || t.out === 'yielded') && tr.compassion > 0.6) { trust *= 0.2; why = 'won\'t strike someone who has given up'; }
  if (tr && w.kinds.includes('subdue') && tr.ruthlessness > 0.65) { trust *= 0.5; why = 'sees no point taking them alive'; }
  if (tr && w.kinds.includes('ignite') && tr.compassion > 0.75 && b.units.some((x) => x.out === null && (x.tags.has('captive') || x.tactic === 'civilian'))) { trust *= 0.35; why = 'won\'t risk the fire near the innocent'; }
  if (tr && w.kinds.some((k) => k === 'block' || k === 'guard') && tr.bravery < 0.35) { trust *= 0.6; why = 'hasn\'t the nerve to stand in the way'; }
  return { w: Math.max(0, Math.min(1, trust)), why };
}

/** Calls this unit heard that bear on its choice now: asks meant for it, and plans from its side. */
export function heardCalls(b: Battle, u: Unit): Call[] {
  return b.calls.filter((c) => c.round >= b.round - 1 && c.heardBy.includes(u.id) && c.from !== u.id);
}

/** Can `l` do what's wanted from anywhere it can reach this turn? */
export function feasible(b: Battle, l: Unit, w: Want): boolean {
  const spots: Spot[] = [{ x: l.x, z: l.z }, ...[...b.reachable(l).keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; })];
  return spots.some((s) => b.options(l, s).some((a) => answers(w, a, s)));
}

/** Where the want points (the foe, the friend, the thing) — to close in on when it's out of reach. */
export function wantSpot(b: Battle, w: Want): Spot | null {
  if (w.target != null) { const t = b.get(w.target); if (t) return t; }
  if (w.ally != null) { const t = b.get(w.ally); if (t) return t; }
  if (w.piece) { const pc = b.pieces.get(w.piece); if (pc) return { x: pc.at[0][0], z: pc.at[0][1] }; }
  if (w.prop) { const pr = b.map.props.get(w.prop); if (pr) return pr; }
  return w.near ?? null;
}

/** "likely" / "maybe" / "unlikely" — the player's read on whether they'll go along. */
export function likelihood(b: Battle, l: Unit, s: Unit, w: Want): { p: number; words: string } {
  const will = willingness(b, l, s, w);
  const can = feasible(b, l, w);
  const closer = !can && wantSpot(b, w) !== null;
  const p = can ? will.w : closer ? will.w * 0.9 : will.w * 0.15;
  const words = !can ? (closer ? `${p >= 0.65 ? 'likely to close in' : p >= 0.4 ? 'may close in' : 'unlikely to'} — out of reach this turn` : 'can\'t, from where they are') : will.why ? `${p >= 0.5 ? 'probably, though' : 'unlikely —'} ${will.why}` : p >= 0.65 ? 'likely' : p >= 0.4 ? 'maybe' : 'unlikely';
  return { p, words };
}

/** What people call each other in a hurry: "Maud", "Garrick", "the gaunt wolf", "the Grey Mother". */
export function callName(name: string): string {
  if (/^the /i.test(name)) return name;
  if (/ wolf$/i.test(name)) return `the ${name.toLowerCase()}`;
  return name.replace(/^(sister|brother|master|old)\s+/i, '').split(' ')[0];
}
