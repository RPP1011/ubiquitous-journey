// PLAYTESTER: tries reasonable strategies in a real battle situation, atomised into concrete
// write-ins, and notices which ones the rules can't do. Feeds the SUPPORT QUEUE.
//
//   strategy  a plan a sensible player might have ("make cover", "use the fire", "rescue")
//   atom      one concrete write-in toward it, phrased against THIS field's units and props,
//             with the action kinds that would count as the game understanding it
//   probe     read each atom with the real parser from the unit's real position:
//               supported    a top reading is one of the expected kinds
//               misread      the parser read it as something else (it thinks it understood)
//               unsupported  no reading at all (the GM says why)
//               unreachable  the right action exists but not from here this turn (not a gap)
//
// Probing is read-only (the parser never mutates the battle), so it can run mid-fight.

import { readWriteIn, type GridReading } from './writein.js';
import { explainUnmet, isSituational } from './unmet.js';
import type { Battle, Unit } from './battle.js';

/** Action kinds a probe can expect. Kinds that don't exist yet (carry, trip…) mark wished-for verbs. */
export const ACTION_KINDS = ['attack', 'ability', 'shove', 'kick', 'hew', 'throw', 'ignite', 'douse', 'pickup', 'grab', 'subdue',
  'aid', 'free', 'guard', 'social', 'overwatch', 'defend', 'dash', 'escape', 'ready',
  // not (yet) in the rules — expecting one of these always fails, which is the point
  'carry', 'trip', 'hide', 'dig', 'build', 'climb', 'give', 'disguise', 'trap', 'distract'] as const;

export interface Atom { strategy: string; capability: string; text: string; expect: string[]; }
export interface ProbeResult { atom: Atom; status: 'supported' | 'misread' | 'unsupported' | 'unreachable'; got: string | null; reason: string | null; }
// 'unreachable' = situational: the capability exists (or the field lacks the thing) — not a rules gap

export interface Situation {
  stage: string; objective: string; you: string;
  units: Array<{ name: string; side: string; role: string; tactic: string; hp: number; at: [number, number]; status: string[] }>;
  props: Array<{ kind: string; name: string; at: [number, number]; tags: string[] }>;
  high: Array<[number, number]>;
  actionKinds: readonly string[];
}

export function situation(b: Battle, u: Unit, stage: string, objective: string): Situation {
  const high: Array<[number, number]> = [];
  for (const t of b.map.tiles) if (t.h >= 3) high.push([t.x, t.z]);
  return {
    stage, objective, you: u.agent.controlled ? 'You' : u.agent.name,
    units: b.units.filter((x) => x.out === null || x.out === 'downed').map((x) => ({
      name: x.agent.controlled ? 'You' : x.agent.name, side: x.side, role: x.role, tactic: x.tactic, hp: Math.round(x.agent.fighter.health), at: [x.x, x.z],
      status: [x.bound ? 'bound' : '', x.out === 'downed' ? 'downed' : '', x.burning ? 'burning' : '', x.carrying ? `carrying ${x.carrying.kind}` : ''].filter(Boolean),
    })),
    props: [...b.map.props.values()].map((p) => ({ kind: p.kind, name: p.name, at: [p.x, p.z],
      tags: [p.flammable ? 'flammable' : '', p.fireSource ? 'fire' : '', p.liquid ? 'water' : '', p.weight === 0 ? 'light' : p.weight === 1 ? 'heavy' : 'fixed', p.cover ? `cover${p.cover}` : '', p.climbable ? 'climbable' : ''].filter(Boolean) })),
    high: high.slice(0, 40),
    actionKinds: ACTION_KINDS,
  };
}

/** Read each atom with the real parser from the unit's position. */
export function probe(b: Battle, u: Unit, atoms: Atom[]): ProbeResult[] {
  return atoms.map((atom) => {
    return judge(atom, readWriteIn(b, u, atom.text), () => explainUnmet(b, u, atom.text), b, u);
  });
}

/** Judge one interpretation: only the TOP reading counts; a close-in is situational, not a gap. */
export function judge(atom: Atom, rs: GridReading[], why: () => string, b: Battle, u: Unit): ProbeResult {
  {
    const top = rs[0];
    const kind = top ? (top.action.kind === 'ready' ? `ready:${top.action.response.kind}` : top.action.kind) : null;
    if (top && !top.deferred && (atom.expect.includes(kind!) || atom.expect.includes(kind!.split(':')[0]) || (kind!.startsWith('ready:') && atom.expect.includes(kind!.slice(6)))))
      return { atom, status: 'supported', got: kind, reason: null };
    if (top && top.deferred) return { atom, status: 'unreachable', got: top.label, reason: 'out of reach this turn' };
    if (top) return { atom, status: 'misread', got: `${top.label} [${kind}]`, reason: null };
    const reason = why();
    // the right kind of action exists on this field, just not from where you stand this turn
    const spots = [{ x: u.x, z: u.z }, ...[...b.reachable(u).keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; })];
    const existsHere = spots.some((sp) => b.options(u, sp).some((o) => atom.expect.includes(o.kind)));
    const unreachable = isSituational(reason) || (existsHere && /out of reach|nobody/.test(reason));
    return { atom, status: unreachable ? 'unreachable' : 'unsupported', got: null, reason };
  }
}

// ---------------------------------------------------------------------------------------------
// the template playtester: strategies a sensible player reaches for, phrased against the field

export function templateAtoms(b: Battle, u: Unit): Atom[] {
  const foes = b.foesOf(u), friends = b.friendsOf(u);
  const nm = (x: Unit) => x.agent.name.split(' ')[0];
  const f = foes[0], f2 = foes[1], ally = friends.find((x) => !x.tags.has('captive')), captive = b.units.find((x) => x.tags.has('captive') && x.out === null);
  const props = [...b.map.props.values()];
  const has = (k: string) => props.find((p) => p.kind === k);
  const beasts = foes.some((x) => x.tactic === 'beast');
  const A: Atom[] = [];
  const add = (strategy: string, capability: string, text: string, expect: string[]) => A.push({ strategy, capability, text, expect });
  if (!f) return A;
  // make cover
  if (has('tree')) add('make cover', 'fell-tree', 'cut down the tree and use it as cover', ['hew']);
  if (has('table')) add('make cover', 'tip-furniture', 'kick over the table for cover', ['kick']);
  if (has('crate')) add('make cover', 'push-cover', `push the crate between me and ${nm(f)}`, ['shove']);
  if (has('crate') || has('cart')) add('make cover', 'barricade', 'build a barricade out of the crates', ['build', 'shove']);
  add('make cover', 'dig', 'dig in behind a mound of earth', ['dig', 'defend']);
  add('make cover', 'take-cover', `duck behind the ${props.find((p) => p.cover)?.nouns[0] ?? 'crate'}`, ['defend']);
  // fire
  if (has('hay') || has('tent')) add('use fire', 'ignite-prop', `set the ${has('hay') ? 'hay' : 'tent'} on fire`, ['ignite']);
  if (has('torch')) add('use fire', 'throw-fire', `throw the torch at ${nm(f)}`, ['throw']);
  if (has('brazier')) add('use fire', 'spill-brazier', `kick the brazier into ${nm(f)}`, ['kick']);
  if (has('oil')) add('use fire', 'pour-oil', `pour the oil under ${nm(f)} and light it`, ['ignite', 'kick', 'shove']);
  add('use fire', 'smoke-out', 'smoke them out with the fire', ['ignite']);
  // position & terrain
  if (has('cart') || has('crate')) add('take position', 'climb-prop', `climb onto the ${has('cart') ? 'cart' : 'crate'}`, ['defend', 'climb']);
  if (has('tree')) add('take position', 'climb-tree', 'climb the tree to get a better angle', ['climb']);
  add('take position', 'high-ground', 'take the high ground', ['defend']);
  add('take position', 'flank', `circle around behind ${nm(f)}`, ['defend', 'attack']);
  if (has('cart')) add('deny ground', 'block-path', 'block the path with the cart', ['shove', 'kick']);
  add('deny ground', 'tripwire', 'string a rope across the path to trip them', ['trap']);
  // melee craft
  if (props.some((p) => p.fireSource)) add('melee craft', 'shove-hazard', `shove ${nm(f)} into the fire`, ['shove']);
  add('melee craft', 'trip', `trip ${nm(f)} and knock them down`, ['trip', 'shove']);
  add('melee craft', 'disarm', `disarm ${nm(f)}`, ['subdue']);
  add('melee craft', 'throw-weapon', `throw my sword at ${nm(f)}`, ['throw']);
  if (has('rocks')) add('melee craft', 'throw-rock', `pick up a rock and throw it at ${nm(f)}`, ['throw', 'pickup']);
  add('melee craft', 'ready-strike', `if ${nm(f)} comes close, hit him`, ['ready']);
  // words
  add('talk', 'demand-surrender', 'demand their surrender', ['social']);
  add('talk', 'bribe', `offer ${nm(f)} my purse to walk away`, ['social']);
  if (f2) add('talk', 'turncoat', `tell ${nm(f)} that ${nm(f2)} is a traitor`, ['social']);
  add('talk', 'false-surrender', 'pretend to surrender, then strike', ['social']);
  add('talk', 'intimidate', `threaten ${nm(f)} — you will die here`, ['social']);
  // support
  if (ally) {
    add('look after the company', 'guard-ally', `protect ${nm(ally)}`, ['guard']);
    add('look after the company', 'drag-ally', `drag ${nm(ally)} to safety`, ['carry']);
    add('look after the company', 'give-item', `give ${nm(ally)} a potion`, ['give', 'aid']);
    add('look after the company', 'swap-places', `swap places with ${nm(ally)}`, ['dash']);
  }
  add('look after the company', 'self-heal', 'bandage my wounds', ['aid']);
  // objectives
  if (captive) {
    add('rescue', 'free-captive', `cut ${nm(captive)} free`, ['free']);
    add('rescue', 'carry-person', `carry ${nm(captive)} out of here`, ['carry']);
    add('rescue', 'escort', `tell ${nm(captive)} to run for the trees`, ['social']);
  }
  if (has('relic')) add('retrieve', 'grab-relic', 'grab the reliquary', ['pickup']);
  // beasts
  if (beasts) {
    add('beasts', 'scare-with-fire', 'wave the torch to scare the wolves off', ['social', 'throw']);
    add('beasts', 'distract-animals', 'throw them some meat to distract them', ['distract', 'throw']);
    add('beasts', 'howl-down', 'roar at the pack to drive them off', ['social']);
  }
  // concealment
  add('stealth', 'hide', 'hide behind the trees', ['hide', 'defend']);
  add('stealth', 'disguise', "put on a dead bandit's cloak", ['disguise']);
  return A;
}
