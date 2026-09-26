// Write-in actions on the grid, in two stages:
//
//   INTERPRET  text → Intent[]   what the player MEANT: a verb and the things it's about
//              (a unit, a prop, a direction, a hazard, a claim). Two interchangeable
//              interpreters produce the same Intent shape:
//                interpretRegex   deterministic lexicon + name matching (instant, offline, tests)
//                interpretLLM     a small local model (tactics/llmParse.ts), schema-constrained
//   RESOLVE    Intent[] → GridReading[]   what that means ON THIS FIELD: the legal action, where to
//              stand for it (the GM's positioning), the odds. Deterministic and shared — the model
//              never decides magnitudes, legality or placement.
//
//   "kick the brazier into Garrick"      → walk to the side of the brazier AWAY from Garrick, kick
//   "shove Mira into the fire"           → stand opposite the fire, shove
//   "cut down the tree and use it as cover" → fell it toward the enemy
//   "if anyone goes for Borin, I trip them" → READY { attacks Borin } → shove (the open target)
//
// An intent the field can't serve this turn (too far) resolves to a CLOSE-IN reading: move toward
// it now, flagged `deferred`, so the player sees the plan instead of a refusal.

import { DIRS, key, type Prop } from './map.js';
import type { Action, Battle, Claim, Spot, Trigger, Unit } from './battle.js';
import { HEWABLE } from './battle.js';

export interface GridReading {
  to: Spot | null;
  action: Action;
  label: string;
  p: number;
  notes: string[];
  score: number;
  /** The intent is out of reach this turn; this reading moves you toward it. */
  deferred?: boolean;
  /** Produced by the model interpreter (shown with a mark in the UI). */
  model?: boolean;
}

export type Verb = 'attack' | 'shove' | 'kick' | 'hew' | 'throw' | 'ignite' | 'douse' | 'pickup' | 'grab' | 'subdue' | 'aid'
  | 'free' | 'guard' | 'defend' | 'overwatch' | 'escape' | 'intimidate' | 'taunt' | 'bluff' | 'rally' | 'parley' | 'move';

/** What the player meant, independent of how it gets done on this field. */
export interface Intent {
  verb: Verb;
  target?: Unit['id'];              // a foe (or the listener of a bluff)
  ally?: Unit['id'];                // a friend (aid, guard, free)
  prop?: string;                    // a prop id
  toward?: Unit['id'] | 'cover';    // where a kicked/felled/shoved thing should go
  hazard?: 'fire' | 'ledge';        // shove INTO this
  claim?: Claim; subject?: Unit['id'];
  self?: boolean;
  ability?: string;
  dest?: 'onto' | 'behind-prop' | 'behind-foe' | 'high';   // where to stand first
  destProp?: string;                // the prop `dest` refers to (climb onto / get behind)
  destFoe?: Unit['id'];             // the foe `dest` refers to (get behind)
  score: number;
}

export const VERBS: readonly Verb[] = ['attack', 'shove', 'kick', 'hew', 'throw', 'ignite', 'douse', 'pickup', 'grab', 'subdue', 'aid',
  'free', 'guard', 'defend', 'overwatch', 'escape', 'intimidate', 'taunt', 'bluff', 'rally', 'parley', 'move'];

const has = (t: string, ...ws: string[]) => ws.some((w) => new RegExp(`(^| )${w}( |$)`).test(t));
export const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/'s\b/g, '').replace(/\s+/g, ' ').trim()} `;
const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

const V: Record<Exclude<Verb, 'move'>, string[]> = {
  attack: ['hit', 'strike', 'attack', 'slash', 'stab', 'swing', 'punch', 'bash', 'lunge', 'kill', 'shoot', 'thrust', 'cleave',
    'go for', 'charge', 'rush', 'engage', 'finish off', 'take down', 'cut down', 'run through', 'fight'],
  shove: ['shove', 'push', 'barge', 'tackle', 'ram', 'bowl', 'knock', 'heave', 'roll', 'shoulder', 'drive'],
  kick: ['kick', 'boot', 'tip', 'topple', 'overturn', 'knock over', 'flip'],
  hew: ['cut down', 'chop', 'chop down', 'fell', 'hew', 'hack down', 'hack apart', 'axe', 'break', 'smash', 'splinter', 'timber'],
  throw: ['throw', 'hurl', 'fling', 'toss', 'lob', 'chuck', 'pelt'],
  ignite: ['light', 'ignite', 'burn', 'set fire', 'set alight', 'kindle', 'on fire'],
  douse: ['douse', 'splash', 'extinguish', 'put out', 'soak', 'drench'],
  pickup: ['pick up', 'grab the', 'take the', 'lift the', 'snatch the', 'take up'],
  grab: ['steal', 'rob', 'pickpocket', 'purse', 'cut his purse', 'cut her purse', 'gold'],
  subdue: ['subdue', 'knock out', 'pin', 'wrestle', 'restrain', 'arrest', 'alive', 'choke', 'grapple', 'take him alive'],
  aid: ['heal', 'bandage', 'potion', 'tend', 'patch', 'help up', 'revive', 'bind my', 'bind his', 'bind her'],
  free: ['free', 'cut free', 'cut loose', 'untie', 'ropes', 'bonds', 'release', 'unbind', 'cut the ropes', 'rescue'],
  guard: ['protect', 'guard', 'cover', 'shield', 'watch over', 'stand over'],
  defend: ['defend', 'block', 'parry', 'brace', 'hold my ground', 'hold the line', 'dodge'],
  overwatch: ['overwatch', 'watch', 'wait for', 'hold', 'ready', 'keep watch'],
  escape: ['flee', 'run away', 'escape', 'retreat', 'withdraw', 'get out'],
  intimidate: ['threaten', 'intimidate', 'roar', 'snarl', 'menace', 'scare', 'frighten', 'glare', 'brandish', 'wave the torch', 'drive off'],
  taunt: ['taunt', 'mock', 'insult', 'jeer', 'provoke', 'come at me', 'goad', 'challenge'],
  bluff: ['lie', 'bluff', 'trick', 'tell', 'shout that', 'claim', 'behind you', 'traitor', 'reinforcements', 'guards are coming'],
  rally: ['rally', 'to arms', 'help me', 'call for help', 'with me', 'inspire'],
  parley: ['parley', 'negotiate', 'surrender', 'truce', 'bargain', 'talk them down', 'lay down', 'stand down', 'yield'],
};

const STOP = new Set(['the', 'and', 'wolf', 'old', 'big', 'young', 'sister', 'master', 'brother']);
const GENERIC = new Set(['bandit', 'brigand', 'monster', 'wolf', 'rival', 'townsfolk']);

/** Every way the text can name a unit: full name, name without "the", distinctive tokens, faction. */
function nameForms(u: Unit): string[] {
  if (u.agent.controlled) return [];
  const full = norm(u.agent.name).trim();
  const forms = [full, full.replace(/^the /, '')];
  for (const w of full.split(' ')) if (w.length >= 3 && !STOP.has(w)) forms.push(w);
  forms.push(u.agent.faction, u.agent.faction === 'bandit' ? 'brigand' : '', u.agent.faction === 'monster' ? 'wolf' : '');
  return forms.filter(Boolean);
}

/** Units the text names, earliest first; a longer (more specific) match beats a shorter one. */
export function namedUnits(text: string, pool: Unit[]): Array<{ u: Unit; at: number; len: number }> {
  const hits: Array<{ u: Unit; at: number; len: number }> = [];
  for (const u of pool) {
    let best: { at: number; len: number } | null = null;
    for (const f of nameForms(u)) {
      const m = new RegExp(`(^| )${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?( |$)`).exec(text);
      // a generic form ("bandit", "wolf") scores 0: it only counts when nobody is named specifically
      const len = GENERIC.has(f) ? 0 : f.length;
      if (m && (!best || len > best.len)) best = { at: m.index, len };
    }
    if (best) hits.push({ u, ...best });
  }
  const specific = hits.some((h) => h.len > 0);
  return hits.filter((h) => !specific || h.len > 0).sort((a, c) => a.at - c.at || c.len - a.len);
}

function lineSide(thing: Spot, toward: Spot, len: number): Spot | null {
  for (const [dx, dz] of DIRS) for (let i = 1; i <= len; i++) if (thing.x + dx * i === toward.x && thing.z + dz * i === toward.z) return { x: thing.x - dx, z: thing.z - dz };
  return null;
}
function behind(thing: Spot, toward: Spot): Spot {
  const dx = toward.x - thing.x, dz = toward.z - thing.z;
  return Math.abs(dx) >= Math.abs(dz) ? { x: thing.x - Math.sign(dx || 1), z: thing.z } : { x: thing.x, z: thing.z - Math.sign(dz || 1) };
}

// ---------------------------------------------------------------------------------------------
// INTERPRET (regex)

/** Drop purpose clauses ("…so he can't escape", "…to block their line") before reading the verb. */
function core(text: string): string {
  const cut = text.search(/ (so that|so|to stop|to keep|in order to|to block|to make|before|while) /);
  return cut > 4 ? `${text.slice(0, cut)} ` : text;
}

export function interpretRegex(b: Battle, u: Unit, raw: string): Intent[] {
  const text = norm(raw);
  if (text.trim().length < 2) return [];
  const c = core(text);
  const foes = b.foesOf(u), friends = [...b.friendsOf(u), ...b.downed(u.side)];
  const namedFoes = namedUnits(text, foes), namedFriends = namedUnits(text, friends);
  const target = namedFoes[0]?.u ?? (has(text, 'him', 'her', 'them', 'it', 'the brute') || foes.length === 1 ? b.nearestFoe(u) : b.nearestFoe(u));
  const prop = b.map.propNamed(text, u, 14) ?? (u.carrying && u.carrying.nouns.some((n) => text.includes(` ${n} `)) ? u.carrying : undefined);
  const selfRef = has(text, 'myself', 'me', 'my wounds', 'yourself');
  const hazard = has(text, 'fire', 'flames', 'campfire', 'coals', 'brazier') ? 'fire' as const : has(text, 'ledge', 'edge', 'cliff', 'off') ? 'ledge' as const : undefined;
  const dest: Intent['dest'] = prop && / (climb|onto|on top of|up on|stand on|get on|hop up on) /.test(text) && prop.climbable ? 'onto'
    : prop && / (behind|duck) /.test(text) ? 'behind-prop'
    : namedFoes[0] && / (behind|flank|around|back of) /.test(text) ? 'behind-foe'
    : / (high ground|higher|up the|hill|rise) /.test(text) ? 'high' : undefined;

  const out: Intent[] = [];
  for (const k of Object.keys(V) as Array<keyof typeof V>) {
    let score = 0, at = -1;
    for (const w of V[k]) { const i = c.indexOf(` ${w} `); if (i >= 0) { score += w.includes(' ') ? 2 : 1; at = Math.max(at, i); } }
    if (!score) continue;
    score += at / 1000;
    const I: Intent = { verb: k, score, dest, destProp: prop?.id, destFoe: namedFoes[0]?.u.id };
    switch (k) {
      case 'attack': I.target = target?.id; I.ability = abilityNamed(u, text); break;
      case 'shove':
        if (prop && prop.weight === 1 && (!namedFoes.length || text.indexOf(` ${prop.nouns[0]}`) < namedFoes[0].at)) { I.prop = prop.id; I.toward = namedFoes[0]?.u.id ?? target?.id; I.score += 1; }
        else { I.target = target?.id; I.hazard = hazard; if (hazard) I.score += 1; }
        break;
      case 'kick':
        if (prop && prop.weight === 1) { I.prop = prop.id; I.toward = namedFoes[0]?.u.id; I.score += 1.5; }
        else I.target = target?.id;
        break;
      case 'hew': {
        const wood = prop && HEWABLE.includes(prop.kind) ? prop : has(text, 'tree', 'trees', 'oak', 'pine', 'trunk') ? b.map.propNamed(' tree ', u, 6) : undefined;
        if (!wood) continue;
        I.prop = wood.id; I.toward = namedFoes[0]?.u.id ?? (has(text, 'cover', 'shield', 'wall', 'barrier', 'between') ? 'cover' : undefined); I.score += 1.5;
        break;
      }
      case 'throw': { const light = prop && prop.weight === 0 ? prop : u.carrying ?? b.map.propNamed(' rock rocks stone ', u, 3); if (light) I.prop = light.id; I.target = target?.id; I.score += 2; break; }
      case 'ignite': if (prop) I.prop = prop.id; else if (has(text, 'grass', 'ground', 'feet')) I.target = target?.id; else continue; break;
      case 'douse': I.ally = namedFriends[0]?.u.id; I.self = selfRef; if (prop) I.prop = prop.id; break;
      case 'pickup': if (prop && prop.weight === 0) I.prop = prop.id; else continue; break;
      case 'grab': if (prop && prop.weight === 0 && !has(text, 'purse', 'gold')) continue; I.target = target?.id; break;
      case 'subdue': I.target = target?.id; break;
      case 'aid': I.ally = namedFriends[0]?.u.id; I.self = !namedFriends.length; break;
      case 'free': I.ally = namedFriends.find((n) => n.u.bound)?.u.id ?? friends.find((f) => f.bound)?.id; if (I.ally == null) continue; I.score += 1; break;
      case 'guard': I.ally = namedFriends[0]?.u.id; if (I.ally == null) continue; break;
      case 'intimidate': case 'taunt': I.target = target?.id; break;
      case 'bluff': {
        I.target = target?.id; I.claim = 'look_behind';
        if (has(text, 'traitor', 'betray', 'sold you out', 'spy', 'working for') && namedFoes.length >= 2) {
          const accIdx = Math.max(...['traitor', 'betray', 'sold you out', 'spy', 'working for'].map((w) => text.indexOf(` ${w}`)));
          const acc = [...namedFoes].reverse().find((n) => n.at < accIdx) ?? namedFoes[namedFoes.length - 1];
          I.target = namedFoes.find((n) => n.u !== acc.u)!.u.id; I.subject = acc.u.id; I.claim = 'turncoat'; I.score += 2;
        } else if (has(text, 'reinforcements', 'guards are coming', 'the watch', 'soldiers', 'more of us')) I.claim = 'reinforcements';
        break;
      }
    }
    out.push(I);
  }
  if (!out.length && dest) out.push({ verb: 'move', dest, destProp: prop?.id, destFoe: namedFoes[0]?.u.id, score: 1 });
  return out.sort((a, c2) => c2.score - a.score);
}

// ---------------------------------------------------------------------------------------------
// RESOLVE (deterministic, shared by every interpreter)

export function resolveIntents(b: Battle, u: Unit, intents: Intent[], model = false): GridReading[] {
  const out: GridReading[] = [];
  const reach = b.reachable(u);
  const reachable = (s: Spot) => (s.x === u.x && s.z === u.z) || reach.has(key(s.x, s.z));
  const unitOf = (id?: Unit['id']) => (id == null ? undefined : b.get(id));
  const push = (to: Spot | null, action: Action, label: string, score: number): boolean => {
    const from = to ?? u;
    if (to && !reachable(to)) return false;
    if (!['ready', 'social', 'wait'].includes(action.kind) && !b.options(u, from).some((o) => sameKind(o, action))) return false;
    const o = b.odds(u, action, from);
    const moved = to && (to.x !== u.x || to.z !== u.z);
    out.push({ to: moved ? to : null, action, label: moved ? `${label} (after moving)` : label, p: o.p, notes: o.notes, score, model });
    return true;
  };
  /** Try from the preferred tile, here, then the nearest tile that makes it legal; else close in. */
  const anywhere = (action: Action, label: string, score: number, prefer?: Spot | null, closeInOn?: Spot) => {
    if (prefer && push(prefer, action, label, score + 0.5)) return;
    if (push(null, action, label, score)) return;
    const tiles = [...reach.keys()].map((k) => { const [x, z] = k.split(',').map(Number); return { x, z }; }).sort((p, q) => dist(p, u) - dist(q, u));
    for (const t of tiles) if (b.options(u, t).some((o) => sameKind(o, action))) { push(t, action, label, score - 0.2); return; }
    if (closeInOn) closeIn(closeInOn, label, score - 1);
  };
  const closeIn = (aim: Spot, label: string, score: number) => {
    let best: Spot | null = null, bd = dist(u, aim);
    for (const k of reach.keys()) { const [x, z] = k.split(',').map(Number); const d = dist({ x, z }, aim); if (d < bd) { bd = d; best = { x, z }; } }
    if (!best) return;
    out.push({ to: best, action: { kind: 'defend' }, label: `Close in to ${label[0].toLowerCase()}${label.slice(1)} next turn`, p: 1, notes: ['out of reach this turn — moving closer'], score, deferred: true, model });
  };
  const destSpot = (I: Intent): Spot | null => {
    const pr = I.destProp ? b.map.props.get(I.destProp) : undefined;
    const foe = unitOf(I.destFoe ?? I.target);
    if (I.dest === 'onto' && pr && pr.climbable && reachable(pr)) return { x: pr.x, z: pr.z };
    if (I.dest === 'behind-prop' && pr) { const f0 = b.nearestFoe(u); if (f0) { const s = behind(pr, f0); if (reachable(s)) return s; } }
    if (I.dest === 'behind-foe' && foe) { const s = { x: foe.x - foe.facing[0], z: foe.z - foe.facing[1] }; if (reachable(s)) return s; }
    if (I.dest === 'high') {
      let best: Spot | null = null, bh = b.map.standH(u.x, u.z);
      for (const k of reach.keys()) { const [x, z] = k.split(',').map(Number); const h = b.map.standH(x, z); if (h > bh) { bh = h; best = { x, z }; } }
      return best;
    }
    return null;
  };

  for (const I of intents) {
    const score = I.score;
    const t = unitOf(I.target), ally = unitOf(I.ally);
    const pr = I.prop ? b.map.props.get(I.prop) ?? (u.carrying?.id === I.prop ? u.carrying : undefined) : undefined;
    const dest = destSpot(I);
    const towardUnit = typeof I.toward === 'number' || (typeof I.toward === 'string' && I.toward !== 'cover') ? unitOf(I.toward as Unit['id']) : undefined;
    switch (I.verb) {
      case 'attack': if (t) anywhere(I.ability ? { kind: 'ability', abilityId: I.ability, target: t.id } : { kind: 'attack', target: t.id }, `${I.ability ? u.agent.abilities.get(I.ability)!.name : 'Attack'} → ${b.nm(t)}`, score, dest, t); break;
      case 'shove':
        if (pr && pr.weight === 1) {
          const tw = towardUnit ?? t;
          const lined = tw ? lineSide(pr, tw, pr.kind === 'barrel' || pr.kind === 'oil' ? 4 : 2) : null;
          anywhere({ kind: 'shove', target: pr.id }, `Shove ${pr.name}${tw ? ` toward ${b.nm(tw)}` : ''}`, score, tw ? lined ?? behind(pr, tw) : null, pr);
        } else if (t) {
          const hz = I.hazard ? findHazard(b, t, I.hazard) : null;
          anywhere({ kind: 'shove', target: t.id }, `Shove ${b.nm(t)}${I.hazard ? (I.hazard === 'fire' ? ' into the fire' : ' off the edge') : ''}`, score, hz ? behind(t, hz) : null, t);
        }
        break;
      case 'hew': {
        if (!pr) break;
        const onto = towardUnit ?? (I.toward === 'cover' ? b.nearestFoe(u) : undefined);
        const lined = onto ? lineSide(pr, onto, 2) : null;
        const toward = onto ? (lined ? { x: 2 * pr.x - lined.x, z: 2 * pr.z - lined.z } : { x: pr.x + b.dirFrom(pr, onto)[0], z: pr.z + b.dirFrom(pr, onto)[1] }) : undefined;
        const blows = Math.ceil(Math.min(pr.hp, pr.kind === 'tree' ? 60 : 20) / Math.max(1, b.hewDamage(u)));
        const n0 = out.length;
        anywhere({ kind: 'hew', prop: pr.id, toward }, `${pr.kind === 'tree' ? 'Fell' : 'Smash'} ${pr.name}${onto && pr.kind === 'tree' ? (towardUnit ? ` onto ${b.nm(onto)}` : ' toward the enemy, for cover') : ''}`, score, onto ? lined ?? behind(pr, onto) : null, pr);
        for (let i = n0; i < out.length; i++) if (!out[i].deferred) out[i].notes.push(blows > 1 ? `${blows} blows to bring it down — this is 1` : pr.kind === 'tree' ? 'it falls this turn — leaves a log (half cover)' : 'it breaks this turn');
        break;
      }
      case 'kick':
        if (pr && pr.weight === 1) {
          const len = pr.kind === 'brazier' ? 4 : pr.kind === 'barrel' || pr.kind === 'oil' ? 5 : 1;
          const lined = towardUnit ? lineSide(pr, towardUnit, len) : null;
          const n0 = out.length;
          anywhere({ kind: 'kick', prop: pr.id }, `Kick ${pr.name}${towardUnit ? ` at ${b.nm(towardUnit)}` : pr.kind === 'table' || pr.kind === 'cart' ? ' over, for cover' : ''}`, score, towardUnit ? lined ?? behind(pr, towardUnit) : null, pr);
          if (towardUnit && !lined) for (let i = n0; i < out.length; i++) out[i].notes.push(`${b.nm(towardUnit)} is not in line — it won't reach`);
        } else if (t) anywhere({ kind: 'shove', target: t.id }, `Kick ${b.nm(t)} back`, score, dest, t);
        break;
      case 'throw': if (pr && t) anywhere({ kind: 'throw', prop: pr.id, at: { x: t.x, z: t.z } }, `Throw ${pr.name} at ${b.nm(t)}`, score, dest, pr); break;
      case 'ignite': {
        const spot = pr ? { x: pr.x, z: pr.z } : t ? { x: t.x, z: t.z } : null;
        if (spot) anywhere({ kind: 'ignite', at: spot }, `Set ${pr ? pr.name : 'the grass'} alight`, score, dest, spot);
        break;
      }
      case 'douse': {
        const who = ally ?? (I.self ? u : null);
        const spot = who ? { x: who.x, z: who.z } : pr ? { x: pr.x, z: pr.z } : { x: u.x, z: u.z };
        anywhere({ kind: 'douse', at: spot }, 'Douse the flames', score);
        break;
      }
      case 'pickup': if (pr) anywhere({ kind: 'pickup', prop: pr.id }, `Pick up ${pr.name}`, score, dest, pr); break;
      case 'grab': if (t) anywhere({ kind: 'grab', target: t.id }, `Grab ${b.nm(t)}'s purse`, score, dest, t); break;
      case 'subdue': if (t) anywhere({ kind: 'subdue', target: t.id }, `Subdue ${b.nm(t)}`, score, dest, t); break;
      case 'aid': { const w = ally ?? u; anywhere({ kind: 'aid', target: w.id }, w === u ? 'Patch yourself up' : `Aid ${b.nm(w)}`, score, null, w); break; }
      case 'free': if (ally) anywhere({ kind: 'free', target: ally.id }, `Cut ${b.nm(ally)} free`, score, null, ally); break;
      case 'guard': if (ally) anywhere({ kind: 'guard', target: ally.id }, `Guard ${b.nm(ally)}`, score, null, ally); break;
      case 'defend': push(dest, { kind: 'defend' }, 'Brace', score); break;
      case 'overwatch': push(dest, { kind: 'overwatch' }, 'Overwatch', score); break;
      case 'move': if (dest) push(dest, { kind: 'defend' }, 'Move and brace', score); break;
      case 'escape': {
        if (b.map.edge(u.x, u.z)) push(null, { kind: 'escape' }, 'Escape', score + 1);
        else { const e = nearestEdge(b, u); if (e) push(e, { kind: 'defend' }, 'Run for the edge', score); }
        break;
      }
      case 'intimidate': if (t) push(dest, { kind: 'social', verb: 'intimidate', target: t.id }, `Intimidate ${b.nm(t)}${b.flameAt(u) && t.tactic === 'beast' ? ' with fire' : ''}`, score); break;
      case 'taunt': if (t) push(dest, { kind: 'social', verb: 'taunt', target: t.id }, `Taunt ${b.nm(t)}`, score); break;
      case 'bluff': {
        if (!t) break;
        const claim = I.claim ?? 'look_behind';
        const s = unitOf(I.subject);
        if (claim === 'turncoat' && s) push(dest, { kind: 'social', verb: 'bluff', target: t.id, claim, subject: s.id }, `Convince ${b.nm(t)} that ${b.nm(s)} is a traitor`, score);
        else push(dest, { kind: 'social', verb: 'bluff', target: t.id, claim: claim === 'turncoat' ? 'look_behind' : claim }, `Bluff ${b.nm(t)} (${claim.replace('_', ' ')})`, score);
        break;
      }
      case 'rally': push(dest, { kind: 'social', verb: 'rally' }, 'Rally', score); break;
      case 'parley': push(dest, { kind: 'social', verb: 'parley' }, 'Parley', score); break;
    }
  }
  const seen = new Set<string>();
  return out.sort((a, c) => (a.deferred ? 1 : 0) - (c.deferred ? 1 : 0) || c.score - a.score)
    .filter((r) => { const k = JSON.stringify([r.to, r.action]); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
}

// ---------------------------------------------------------------------------------------------

/** The instant path: regex interpretation, deterministic resolution. Conditionals become READY. */
export function readWriteIn(b: Battle, u: Unit, raw: string): GridReading[] {
  const cond = splitConditional(raw);
  if (cond) {
    const trig = readTrigger(b, u, norm(cond.when));
    if (trig) return readyReadings(b, u, trig, cond.then, interpretRegex(b, u, cond.then));
  }
  return resolveIntents(b, u, interpretRegex(b, u, raw));
}

export function splitConditional(raw: string): { when: string; then: string } | null {
  const m = /^\s*(if|when|should|once|as soon as)\s+(.+?)(,|;|\s+then\s+|\s+—\s+)(.+)$/i.exec(raw);
  return m ? { when: m[2], then: m[4] } : null;
}

/** A readied response: resolved LOOSELY (the target may only come into reach when it fires). */
export function readyReadings(b: Battle, u: Unit, trig: Trigger, thenText: string, intents: Intent[], model = false): GridReading[] {
  const I = intents[0];
  if (!I) return [];
  const t = I.target != null ? b.get(I.target) : undefined;
  const open = /( them | him | her | whoever | anyone | it )/.test(` ${thenText.toLowerCase()} `) || !t;
  let response: Action | null = null, label = '';
  switch (I.verb) {
    case 'attack': response = I.ability ? { kind: 'ability', abilityId: I.ability, target: open ? -1 : t!.id } : { kind: 'attack', target: open ? -1 : t!.id }; label = 'strike'; break;
    case 'shove': case 'kick': response = I.prop ? { kind: I.verb, ...(I.verb === 'kick' ? { prop: I.prop } : { target: I.prop }) } as Action : { kind: 'shove', target: open ? -1 : t!.id }; label = I.verb; break;
    case 'subdue': response = { kind: 'subdue', target: open ? -1 : t!.id }; label = 'subdue'; break;
    case 'throw': if (I.prop) { response = { kind: 'throw', prop: I.prop, at: { x: -1, z: -1 } }; label = 'throw'; } break;
    case 'ignite': if (I.prop) { const p = b.map.props.get(I.prop); if (p) { response = { kind: 'ignite', at: { x: p.x, z: p.z } }; label = 'light it'; } } break;
    case 'intimidate': case 'taunt': case 'bluff': response = { kind: 'social', verb: I.verb, target: open ? -1 : t!.id, ...(I.verb === 'bluff' ? { claim: I.claim ?? 'look_behind' } : {}) } as Action; label = I.verb; break;
    case 'guard': if (I.ally != null) { response = { kind: 'guard', target: I.ally }; label = 'guard'; } break;
    case 'aid': response = { kind: 'aid', target: I.ally ?? u.id }; label = 'aid'; break;
    default: break;
  }
  if (!response) return [];
  return [{ to: null, action: { kind: 'ready', trigger: trig, response }, label: `Ready: ${describeTrigger(b, trig)} → ${label}`, p: 1, notes: ['held until it happens'], score: 10, model }];
}

export function sameKind(a: Action, c: Action): boolean {
  if (a.kind !== c.kind) return false;
  const A = a as Record<string, unknown>, C = c as Record<string, unknown>;
  for (const k of ['target', 'prop', 'abilityId']) if (A[k] !== undefined && C[k] !== undefined && A[k] !== C[k]) return false;
  if ('at' in a && 'at' in c) return a.at.x === c.at.x && a.at.z === c.at.z;
  return true;
}

export function abilityNamed(u: Unit, text: string): string | undefined {
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

export function readTrigger(b: Battle, u: Unit, text: string): Trigger | null {
  const foes = b.foesOf(u), friends = b.friendsOf(u);
  const f = namedUnits(text, friends)[0]?.u;
  if (f && /( attacks | goes for | hits | touches | swings at | comes for | attack | go for | hit )/.test(text)) return { on: 'attacks', ward: f.id };
  const foe = namedUnits(text, foes)[0]?.u;
  if (/( comes close | gets close | in reach | within reach | comes near | approaches | closes in | anyone comes )/.test(text)) return { on: 'reach' };
  if (foe && /( moves | move | runs | run | comes | steps | charges | charge )/.test(text)) return { on: 'moves', who: foe.id };
  const prop = b.map.propNamed(text, u, 20);
  if (prop && /( near | nears | close to | next to | by | reaches | reach )/.test(text)) return { on: 'nears', prop: prop.id };
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

export type { Prop };
