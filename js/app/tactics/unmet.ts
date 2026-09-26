// UNMET REQUESTS: when a write-in can't become an action, say WHY — and keep it.
//
// Every refused request is recorded with its text, the GM's reason, where it happened and what
// was lying around. That record is design input: it's the list of things players tried that the
// rules don't cover yet (persisted in the browser; readable from the journal and the console).

import type { Battle, Unit } from './battle.js';
import { addressee } from './writein.js';

export interface UnmetRequest { at: number; text: string; reason: string; where: string; near: string[]; who: string; }

/** Verbs players reach for that the tactical rules don't model (yet). */
const UNSUPPORTED: Array<[RegExp, string]> = [
  [/\b(dig|trench|bury)\b/, 'digging'],
  [/\b(build|barricade|wall up|fortify)\b/, 'building'],
  [/\b(swim|dive)\b/, 'swimming'],
  [/\b(pray|bless|curse)\b/, 'prayer'],
  [/\b(poison|drug)\b/, 'poison'],
  [/\b(trap|snare|tripwire)\b/, 'traps'],
  [/\b(tie|rope|lasso|bind (him|her|them))\b/, 'rope-work'],
  [/\b(climb (the |a )?tree|up the tree)\b/, 'climbing trees'],
  [/\b(jump over|vault|leap over)\b/, 'vaulting'],
  [/\b(fireball|lightning|teleport|summon)\b/, 'magic you don\'t have'],
  [/\b(ride|mount|horse)\b/, 'riding'],
  [/\b(sing|dance|play (a|the) )\b/, 'performance'],
  [/\b(disguise|cloak|pretend to be|dress as)\b/, 'disguises'],
  [/\b(swap|switch|trade) places\b/, 'swapping places'],
  [/\b(throw|hurl) (my|his|her|the) (sword|axe|blade|weapon|knife|spear)\b/, 'throwing your weapon'],
  [/\bdisarm\b/, 'disarming'],
  [/\btrip\b/, 'tripping'],
  [/\b(bribe|offer .* (purse|gold|coin|silver)|pay (him|her|them))\b/, 'bribes'],
  [/\b(carry|drag|haul) .* (out|away|to safety|clear)\b/, 'carrying people'],
];

/** Reasons that describe the circumstances, not a missing capability. */
export function isSituational(reason: string): boolean {
  return /out of reach|there's no |nobody |already acted|not hurt/.test(reason);
}

/** Why the GM can't read this. */
export function explainUnmet(b: Battle, u: Unit, raw: string): string {
  const text = ` ${raw.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ')} `;
  const to = addressee(b, u, raw).who;
  if (to && to !== u) return `${to.agent.name} makes their own choices in a fight — you can't give them orders`;
  for (const [re, what] of UNSUPPORTED) if (re.test(text)) return `the rules don't cover ${what} yet`;
  if (/\b(hide|sneak|stealth|vanish|lie low|creep)\b/.test(text)) return 'there is no brush or tall grass within reach to hide in';
  if (/\b(bandage|heal|patch|potion|tend)\b/.test(text) && ![u, ...b.friendsOf(u), ...b.downed(u.side)].some((x) => x.agent.fighter.health < 100 || x.out === 'downed'))
    return 'nobody on your side is hurt';
  const prop = b.map.propNamed(text, u, 99);
  if (prop) {
    const d = Math.abs(prop.x - u.x) + Math.abs(prop.z - u.z);
    return d > 1 ? `${prop.name} is out of reach this turn (${d} tiles away)` : `there's nothing that verb does to ${prop.name} here`;
  }
  // a noun that isn't a unit's name, a scene word, or a prop: the field genuinely lacks it
  const names = new Set(b.units.flatMap((x) => x.agent.name.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)));
  const scene = new Set(['fight', 'enemy', 'enemies', 'foe', 'foes', 'bandit', 'bandits', 'wolf', 'wolves', 'man', 'woman', 'way', 'hill', 'rise', 'ground', 'road', 'path', 'field',
    'hand', 'hands', 'weapon', 'blade', 'sword', 'axe', 'gate', 'line', 'front', 'back', 'side', 'edge', 'mine', 'camp', 'fire', 'flames', 'pack', 'others', 'rest', 'lot', 'handful', 'moment', 'turn']);
  const nouns = [...text.matchAll(/\b(the|a|an|that|this) ([a-z]+)/g)].map((m) => m[2]).filter((n) => !names.has(n) && !scene.has(n));
  if (nouns[0]) return `there's no ${nouns[0]} on this field`;
  if (u.acted) return 'you have already acted this turn';
  return 'the GM couldn\'t turn that into an action';
}

const KEY = 'hearsay.unmet.v1';
const memory: UnmetRequest[] = [];

export function recordUnmet(b: Battle, u: Unit, text: string, reason: string, where: string): UnmetRequest {
  const near = [...b.map.props.values()].filter((p) => Math.abs(p.x - u.x) + Math.abs(p.z - u.z) <= 3).map((p) => p.name);
  const r: UnmetRequest = { at: Date.now(), text, reason, where, near: [...new Set(near)], who: u.agent.controlled ? 'you' : u.agent.name };
  memory.push(r);
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '[]') as UnmetRequest[];
    all.push(r);
    localStorage.setItem(KEY, JSON.stringify(all.slice(-200)));
  } catch { /* headless / private mode: memory only */ }
  return r;
}

export function unmetRequests(): UnmetRequest[] {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null') ?? memory; } catch { return memory; }
}
