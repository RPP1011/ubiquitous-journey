// Write-in actions on the grid: free text → { move?, action } readings, ranked, each with the
// odds from where you'd be standing. The GM (this file) also solves the obvious positioning:
//
//   "kick the brazier into Garrick"      → walk to the side of the brazier AWAY from Garrick, kick
//   "shove Mira into the fire"           → stand on the side of Mira opposite the fire, shove
//   "climb onto the cart and hit Tomas"  → move onto the cart, attack if Tomas is in reach
//   "if anyone goes for Borin, I trip them" → READY { attacks Borin } → shove (the open target)
//   "throw the flour at Mira"            → pick it up where it lies, throw
//
// Text never sets a magnitude or invents a thing: every noun must resolve to a unit or prop on
// this map, and every reading is re-checked against battle.options() from its standing tile.

import { DIRS, key, type Prop } from './map.js';
import type { Action, Battle, Claim, Spot, Trigger, Unit } from './battle.js';

export interface GridReading {
  to: Spot | null;
  action: Action;
  label: string;
  p: number;
  notes: string[];
  score: number;
}

const has = (t: string, ...ws: string[]) => ws.some((w) => new RegExp(`(^| )${w}( |$)`).test(t));
const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

const V = {
  attack: ['hit', 'strike', 'attack', 'slash', 'stab', 'swing', 'cut', 'punch', 'smash', 'bash', 'chop', 'lunge', 'hack', 'kill', 'shoot', 'thrust', 'cleave'],
  shove: ['shove', 'push', 'barge', 'tackle', 'ram', 'bowl', 'knock', 'heave', 'roll', 'shoulder'],
  kick: ['kick', 'boot', 'tip', 'topple', 'overturn', 'knock over', 'flip'],
  throw: ['throw', 'hurl', 'fling', 'toss', 'lob', 'chuck'],
  ignite: ['light', 'ignite', 'burn', 'set fire', 'torch', 'set alight', 'kindle'],
  douse: ['douse', 'splash', 'extinguish', 'put out', 'soak', 'drench'],
  pickup: ['pick up', 'grab the', 'take the', 'lift the', 'snatch the'],
  grab: ['steal', 'rob', 'pickpocket', 'purse', 'cut his purse', 'cut her purse', 'gold'],
  subdue: ['subdue', 'knock out', 'disarm', 'pin', 'wrestle', 'restrain', 'arrest', 'alive', 'choke', 'grapple'],
  aid: ['heal', 'bandage', 'potion', 'tend', 'patch', 'help up', 'revive', 'drag'],
  guard: ['protect', 'guard', 'cover', 'shield', 'watch over'],
  defend: ['defend', 'block', 'parry', 'brace', 'hold my ground', 'dodge'],
  overwatch: ['overwatch', 'watch', 'wait for', 'hold', 'ready', 'keep watch'],
  escape: ['flee', 'run away', 'escape', 'retreat', 'withdraw', 'get out'],
  intimidate: ['threaten', 'intimidate', 'roar', 'snarl', 'menace', 'scare', 'frighten', 'glare'],
  taunt: ['taunt', 'mock', 'insult', 'jeer', 'provoke', 'come at me', 'goad'],
  bluff: ['lie', 'bluff', 'trick', 'tell', 'shout that', 'claim', 'behind you', 'traitor', 'reinforcements', 'guards are coming'],
  rally: ['rally', 'to arms', 'help me', 'call for help', 'with me', 'inspire'],
  parley: ['parley', 'negotiate', 'surrender', 'truce', 'bargain', 'talk them down', 'lay down', 'stand down', 'yield'],
};

type VerbKey = keyof typeof V;

function units(b: Battle, text: string, pool: Unit[]): Array<{ u: Unit; at: number }> {
  const out: Array<{ u: Unit; at: number }> = [];
  for (const u of pool) {
    const names = u.agent.controlled ? [] : [u.agent.name, ...u.agent.name.split(/\s+/).filter((w) => w.length >= 3), u.agent.faction, u.agent.faction === 'bandit' ? 'brigand' : ''];
    let at = -1;
    for (const n of names) { if (!n) continue; const i = text.indexOf(` ${n.toLowerCase()} `); if (i >= 0 && (at < 0 || i < at)) at = i; const j = text.indexOf(` ${n.toLowerCase()}s `); if (j >= 0 && (at < 0 || j < at)) at = j; }
    if (at >= 0) out.push({ u, at });
  }
  return out.sort((a, c) => a.at - c.at);
}

/**
 * Where to stand so that pushing/kicking `thing` sends it (or its spill) down a line that
 * actually reaches `toward` within `len` tiles. Null when no side lines up.
 */
function lineSide(thing: Spot, toward: Spot, len: number): Spot | null {
  for (const [dx, dz] of DIRS) {
    for (let i = 1; i <= len; i++) if (thing.x + dx * i === toward.x && thing.z + dz * i === toward.z) return { x: thing.x - dx, z: thing.z - dz };
  }
  return null;
}

/** The tile from which pushing/kicking `thing` sends it toward `toward` (the opposite side). */
function behind(thing: Spot, toward: Spot): Spot {
  const dx = toward.x - thing.x, dz = toward.z - thing.z;
  return Math.abs(dx) >= Math.abs(dz) ? { x: thing.x - Math.sign(dx || 1), z: thing.z } : { x: thing.x, z: thing.z - Math.sign(dz || 1) };
}

export function readWriteIn(b: Battle, u: Unit, raw: string): GridReading[] {
  const text = norm(raw);
  if (text.trim().length < 2) return [];

  // --- conditional: "if/when <trigger>, <response>" → READY -----------------------------------
  const cond = /^\s*(if|when|should|once|as soon as)\s+(.+?)(,|;|\s+then\s+|\s+—\s+)(.+)$/i.exec(raw);
  if (cond) {
    const trig = readTrigger(b, u, norm(cond[2]));
    const resp = trig && readWriteIn(b, u, cond[4]).find((r) => r.to === null || true);
    if (trig && resp) {
      const openTarget = /( them | him | her | whoever | anyone | it )/.test(` ${cond[4]} `) || !('target' in resp.action);
      const response: Action = openTarget && 'target' in resp.action && trig.on !== 'moves' ? { ...resp.action, target: -1 } as Action : resp.action;
      return [{ to: resp.to, action: { kind: 'ready', trigger: trig, response }, label: `Ready: ${describeTrigger(b, trig)} → ${resp.label}`, p: 1, notes: ['held until it happens'], score: 10 }];
    }
  }

  const foes = b.foesOf(u), friends = [...b.friendsOf(u), ...b.downed(u.side)];
  const namedFoes = units(b, text, foes), namedFriends = units(b, text, friends);
  const target = namedFoes[0]?.u ?? (has(text, 'him', 'her', 'them', 'it', 'the brute') ? b.nearestFoe(u) : foes.length === 1 ? foes[0] : b.nearestFoe(u));
  const prop = b.map.propNamed(text, u, 14) ?? (u.carrying && u.carrying.nouns.some((n) => text.includes(` ${n} `)) ? u.carrying : undefined);
  const selfRef = has(text, 'myself', 'me', 'my wounds', 'yourself');
  const hazard = has(text, 'fire', 'flames', 'campfire', 'coals', 'brazier') ? 'fire' : has(text, 'ledge', 'edge', 'cliff', 'off') ? 'ledge' : null;

  const verbs = (Object.keys(V) as VerbKey[]).map((k) => {
    let score = 0, at = -1;
    for (const w of V[k]) { const i = text.indexOf(` ${w} `); if (i >= 0) { score += w.includes(' ') ? 2 : 1; at = Math.max(at, i); } }
    return { k, score: score + (at >= 0 ? at / 1000 : 0) };
  }).filter((v) => v.score > 0).sort((a, c) => c.score - a.score);

  const out: GridReading[] = [];
  const push = (to: Spot | null, action: Action, label: string, score: number) => {
    const from = to ?? u;
    if (to && !(to.x === u.x && to.z === u.z) && !b.reachable(u).has(key(to.x, to.z))) return;
    if (!['ready', 'social', 'wait'].includes(action.kind) && !b.options(u, from).some((o) => sameKind(o, action))) return;
    const o = b.odds(u, action, from);
    out.push({ to: to && (to.x !== u.x || to.z !== u.z) ? to : null, action, label: to && (to.x !== u.x || to.z !== u.z) ? `${label} (after moving)` : label, p: o.p, notes: o.notes, score });
  };
  /** Try the action from here, then from the reachable tiles that make it legal (nearest first). */
  const anywhere = (action: Action, label: string, score: number, prefer?: Spot) => {
    if (prefer) push(prefer, action, label, score + 0.5);
    push(null, action, label, score);
    if (out.some((r) => sameKind(r.action, action))) return;
    const tiles = [...b.reachable(u).keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; }).sort((p, q) => dist(p, u) - dist(q, u));
    for (const t of tiles) { if (b.options(u, t).some((o) => sameKind(o, action))) { push(t, action, label, score - 0.2); break; } }
  };

  // explicit destination: "climb onto the cart", "get behind the crates", "move next to Mira"
  const dest = readDestination(b, u, text, prop, namedFoes[0]?.u ?? null);

  for (const { k, score } of verbs) {
    switch (k) {
      case 'attack': if (target) { const ab = abilityNamed(u, text); anywhere(ab ? { kind: 'ability', abilityId: ab, target: target.id } : { kind: 'attack', target: target.id }, `${ab ? u.agent.abilities.get(ab)!.name : 'Attack'} → ${b.nm(target)}`, score, dest ?? undefined); } break;
      case 'shove': {
        if (prop && prop.weight === 1 && (!namedFoes.length || text.indexOf(` ${prop.nouns[0]}`) < (namedFoes[0].at))) {
          const lined = target ? lineSide(prop, target, prop.kind === 'barrel' || prop.kind === 'oil' ? 4 : 2) : null;
          const at = target ? lined ?? behind(prop, target) : null;
          anywhere({ kind: 'shove', target: prop.id }, `Shove ${prop.name}${target ? ` toward ${b.nm(target)}` : ''}`, score + 1, at ?? undefined);
        } else if (target) {
          // into the fire / off the ledge: stand on the far side of the target from the hazard
          let at: Spot | undefined;
          if (hazard) {
            const hz = findHazard(b, target, hazard);
            if (hz) at = behind(target, hz);
          }
          anywhere({ kind: 'shove', target: target.id }, `Shove ${b.nm(target)}${hazard ? (hazard === 'fire' ? ' into the fire' : ' off the edge') : ''}`, score + (hazard ? 1 : 0), at);
        }
        break;
      }
      case 'kick': {
        if (prop && prop.weight === 1) {
          const len = prop.kind === 'brazier' ? 4 : prop.kind === 'barrel' || prop.kind === 'oil' ? 5 : 1;
          const lined = target ? lineSide(prop, target, len) : null;
          const at = target ? lined ?? behind(prop, target) : undefined;
          const n0 = out.length;
          anywhere({ kind: 'kick', prop: prop.id }, `Kick ${prop.name}${target ? ` at ${b.nm(target)}` : ''}`, score + 1.5, at);
          if (target && !lined) for (let i = n0; i < out.length; i++) out[i].notes.push(`${b.nm(target)} is not in line — it won't reach`);
        } else if (target) anywhere({ kind: 'shove', target: target.id }, `Kick ${b.nm(target)} back`, score);
        break;
      }
      case 'throw': {
        const light = prop && prop.weight === 0 ? prop : u.carrying ?? b.map.propNamed(' rock rocks stone ', u, 3);
        if (light && target) anywhere({ kind: 'throw', prop: light.id, at: { x: target.x, z: target.z } }, `Throw ${light.name} at ${b.nm(target)}`, score + 1);
        break;
      }
      case 'ignite': {
        const spot = prop ? { x: prop.x, z: prop.z } : target && has(text, 'grass', 'ground', 'feet') ? { x: target.x, z: target.z } : null;
        if (spot) anywhere({ kind: 'ignite', at: spot }, `Set ${prop ? prop.name : 'the grass'} alight`, score + 1);
        break;
      }
      case 'douse': {
        const who = namedFriends[0]?.u ?? (selfRef ? u : null);
        const spot = who ? { x: who.x, z: who.z } : prop ? { x: prop.x, z: prop.z } : { x: u.x, z: u.z };
        anywhere({ kind: 'douse', at: spot }, 'Douse the flames', score);
        break;
      }
      case 'pickup': if (prop && prop.weight === 0) anywhere({ kind: 'pickup', prop: prop.id }, `Pick up ${prop.name}`, score); break;
      case 'grab': if (target && !(prop && prop.weight === 0 && !has(text, 'purse', 'gold'))) anywhere({ kind: 'grab', target: target.id }, `Grab ${b.nm(target)}'s purse`, score); break;
      case 'subdue': if (target) anywhere({ kind: 'subdue', target: target.id }, `Subdue ${b.nm(target)}`, score); break;
      case 'aid': { const w = namedFriends[0]?.u ?? u; anywhere({ kind: 'aid', target: w.id }, w === u ? 'Patch yourself up' : `Aid ${b.nm(w)}`, score); break; }
      case 'guard': { const w = namedFriends[0]?.u; if (w) anywhere({ kind: 'guard', target: w.id }, `Guard ${b.nm(w)}`, score); break; }
      case 'defend': push(dest, { kind: 'defend' }, 'Brace', score); break;
      case 'overwatch': push(dest, { kind: 'overwatch' }, 'Overwatch', score); break;
      case 'escape': {
        if (b.map.edge(u.x, u.z)) push(null, { kind: 'escape' }, 'Escape', score + 1);
        else { const e = nearestEdge(b, u); if (e) push(e, { kind: 'defend' }, 'Run for the edge', score); }
        break;
      }
      case 'intimidate': if (target) push(dest, { kind: 'social', verb: 'intimidate', target: target.id }, `Intimidate ${b.nm(target)}`, score); break;
      case 'taunt': if (target) push(dest, { kind: 'social', verb: 'taunt', target: target.id }, `Taunt ${b.nm(target)}`, score); break;
      case 'bluff': {
        if (!target) break;
        let claim: Claim = 'look_behind'; let subject: Unit['id'] | undefined;
        if (has(text, 'traitor', 'betray', 'sold you out', 'spy', 'working for') && namedFoes.length >= 2) {
          const accIdx = Math.max(...['traitor', 'betray', 'sold you out', 'spy', 'working for'].map((w) => text.indexOf(` ${w}`)));
          const acc = [...namedFoes].reverse().find((n) => n.at < accIdx) ?? namedFoes[namedFoes.length - 1];
          const listener = namedFoes.find((n) => n.u !== acc.u)!;
          claim = 'turncoat'; subject = acc.u.id;
          push(dest, { kind: 'social', verb: 'bluff', target: listener.u.id, claim, subject }, `Convince ${b.nm(listener.u)} that ${b.nm(acc.u)} is a traitor`, score + 2);
          break;
        }
        if (has(text, 'reinforcements', 'guards are coming', 'the watch', 'soldiers', 'more of us')) claim = 'reinforcements';
        push(dest, { kind: 'social', verb: 'bluff', target: target.id, claim }, `Bluff ${b.nm(target)} (${claim.replace('_', ' ')})`, score);
        break;
      }
      case 'rally': push(dest, { kind: 'social', verb: 'rally' }, 'Rally', score); break;
      case 'parley': push(dest, { kind: 'social', verb: 'parley' }, 'Parley', score); break;
    }
  }
  // a bare destination ("climb onto the cart") is a move + brace
  if (dest && !out.length) push(dest, { kind: 'defend' }, 'Move and brace', 1);
  // the flourish is the player's words: keep a fresh-trick bonus working through act(u, a, flourish)
  const seen = new Set<string>();
  return out.sort((a, c) => c.score - a.score).filter((r) => { const k = JSON.stringify([r.to, r.action]); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
}

function sameKind(a: Action, c: Action): boolean {
  if (a.kind !== c.kind) return false;
  const A = a as Record<string, unknown>, C = c as Record<string, unknown>;
  for (const k of ['target', 'prop', 'abilityId']) if (A[k] !== undefined && C[k] !== undefined && A[k] !== C[k]) return false;
  if ('at' in a && 'at' in c) return a.at.x === c.at.x && a.at.z === c.at.z;
  return true;
}

function abilityNamed(u: Unit, text: string): string | undefined {
  for (const ab of u.agent.abilities?.values?.() ?? []) {
    const words = ab.name.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
    if (words.length && words.every((w) => text.includes(w))) return ab.id;
  }
  return undefined;
}

function findHazard(b: Battle, t: Unit, kind: 'fire' | 'ledge'): Spot | null {
  for (const [dx, dz] of DIRS) {
    const x = t.x + dx, z = t.z + dz;
    const tile = b.map.tile(x, z); if (!tile) continue;
    if (kind === 'fire' && (tile.burning || b.map.propAt(x, z)?.fireSource)) return { x, z };
    if (kind === 'ledge' && b.map.standH(t.x, t.z) - b.map.standH(x, z) > 3) return { x, z };
  }
  return null;
}

function nearestEdge(b: Battle, u: Unit): Spot | null {
  let best: Spot | null = null, bd = 99;
  for (const k of b.reachable(u).keys()) { const [x, z] = k.split(',').map(Number); if (!b.map.edge(x, z)) continue; const d = dist({ x, z }, u); if (d < bd) { bd = d; best = { x, z }; } }
  return best;
}

function readDestination(b: Battle, u: Unit, text: string, prop: Prop | undefined, foe: Unit | null): Spot | null {
  const reach = b.reachable(u);
  const ok = (s: Spot) => reach.has(key(s.x, s.z));
  if (prop && /( climb | onto | on top of | up on | stand on | get on )/.test(text) && prop.climbable && ok(prop)) return { x: prop.x, z: prop.z };
  if (prop && /( behind | cover | duck )/.test(text)) {
    const foe0 = b.nearestFoe(u);
    if (foe0) { const s = behind(prop, foe0); if (ok(s)) return s; }
  }
  if (foe && /( behind | flank | around | back of )/.test(text)) {
    const s = { x: foe.x - foe.facing[0], z: foe.z - foe.facing[1] };
    if (ok(s)) return s;
  }
  if (/( high ground | higher | up the | hill | rise )/.test(text)) {
    let best: Spot | null = null, bh = b.map.standH(u.x, u.z);
    for (const k of reach.keys()) { const [x, z] = k.split(',').map(Number); const h = b.map.standH(x, z); if (h > bh) { bh = h; best = { x, z }; } }
    return best;
  }
  return null;
}

function readTrigger(b: Battle, u: Unit, text: string): Trigger | null {
  const foes = b.foesOf(u), friends = b.friendsOf(u);
  const f = units(b, text, friends)[0]?.u;
  if (f && /( attacks | goes for | hits | touches | swings at | comes for | attack | go for | hit )/.test(text)) return { on: 'attacks', ward: f.id };
  const foe = units(b, text, foes)[0]?.u;
  if (foe && /( moves | move | runs | run | comes | steps | charges | charge )/.test(text)) return { on: 'moves', who: foe.id };
  const prop = b.map.propNamed(text, u, 20);
  if (prop && /( near | nears | close to | next to | by | reaches | reach )/.test(text)) return { on: 'nears', prop: prop.id };
  if (/( comes close | gets close | in reach | within reach | comes near | approaches | closes in | charges | anyone comes )/.test(text)) return { on: 'reach' };
  return null;
}

export function describeTrigger(b: Battle, t: Trigger): string {
  switch (t.on) {
    case 'attacks': return `if anyone attacks ${b.get(t.ward) ? b.nm(b.get(t.ward)!) : 'them'}`;
    case 'moves': return `when ${b.get(t.who) ? b.nm(b.get(t.who)!) : 'they'} move${b.get(t.who)?.agent.controlled ? '' : 's'}`;
    case 'nears': return `when someone nears ${b.map.props.get(t.prop)?.name ?? 'it'}`;
    case 'enter': return 'when someone enters the area';
    case 'reach': return 'when a foe comes within reach';
  }
}
