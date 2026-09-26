// THE HUB: the town you come home to, and the people in it who hear what you did.
//
// Nobody in the hub was at the fight. They learn through TALES:
//   - companions come home and talk — to Marta at the inn (she hears everything), and each to
//     the people they're close to (Maud to the chapel, Borin to the reeve, Wren to the smith,
//     Pip to anyone who'll listen — and Pip embellishes);
//   - the people you saved or spared tell it themselves (Elsie to her mother; a bandit you let
//     walk tells his father);
//   - whatever Marta hears goes round the town a hop later, and a thrice-told tale curdles into
//     the lurid version.
// Each NPC keeps what they heard with its PROVENANCE (who told them, how many hops), judges it
// by their own VALUES, and talks about it — so the reeve, the priest and a bandit's father
// react to the same night in the mill very differently.

import type { CompanionKey } from './companions.js';

export type Value = 'mercy' | 'courage' | 'order' | 'fire' | 'theft' | 'loyalty' | 'cruelty';

export interface HubNpcDef {
  key: string;
  name: string;
  role: string;
  poi: string;                   // where they stand (world POI kind)
  values: Partial<Record<Value, number>>;   // how much each kind of deed moves them (+/−)
  confidants: CompanionKey[];    // companions who come to them with tales
  kin?: { name: string; relation: string };
  model: 'knight' | 'barbarian';
}

/** Curated stations around the market square (the square is at the origin; the camera looks north). */
export const HUB_SPOTS: Record<string, [number, number]> = {
  tom: [-6.5, -1.5], anselm: [-4.6, -4.8], reeve: [-1.2, -6.2], nan: [2.2, -6.0], marta: [5.0, -4.2], hilde: [6.8, -1.2],
};
export const COMPANY_SPOTS: Array<[number, number]> = [[-3.2, 3.4], [-1.1, 3.9], [1.1, 3.9], [3.2, 3.4]];
export const PLAYER_SPOT: [number, number] = [0, 1.6];

export const HUB_NPCS: HubNpcDef[] = [
  { key: 'reeve', name: 'Reeve Aldous', role: 'the reeve', poi: 'market', values: { order: 1, courage: 0.7, mercy: 0.1, theft: -0.8, fire: -0.2, cruelty: -0.2 }, confidants: ['borin'], model: 'knight' },
  { key: 'marta', name: 'Marta Brewer', role: 'keeps the inn', poi: 'rest', values: { courage: 0.5, mercy: 0.5, fire: -0.4, loyalty: 0.6, cruelty: -0.5 }, confidants: ['borin', 'wren', 'pip', 'maud'], model: 'knight' },
  { key: 'anselm', name: 'Brother Anselm', role: 'the chapel', poi: 'well', values: { mercy: 1, fire: -1, theft: -0.6, courage: 0.2, loyalty: 0.3, cruelty: -1 }, confidants: ['maud'], model: 'knight' },
  { key: 'hilde', name: 'Hilde Stagg', role: 'the smith', poi: 'forge', values: { courage: 1, mercy: -0.2, fire: 0.1, order: 0.3, cruelty: 0.2 }, confidants: ['wren'], model: 'barbarian' },
  { key: 'tom', name: 'Old Tom Garrow', role: 'a widower by the well', poi: 'well', values: { mercy: 0.8, courage: 0.1, cruelty: -0.8 }, confidants: ['pip'], kin: { name: 'Col Garrow', relation: 'son' }, model: 'barbarian' },
  { key: 'nan', name: 'Nan Miller', role: 'the miller\'s widow', poi: 'market', values: { mercy: 0.6, courage: 0.5, fire: -0.5, cruelty: -0.6 }, confidants: ['pip', 'maud'], kin: { name: 'Elsie Miller', relation: 'daughter' }, model: 'knight' },
];

/** A thing that happened on a run, as the world might tell it. */
export interface Deed {
  id: string;
  run: number;
  stage: string;
  label: string;                 // the plain telling
  lurid: string;                 // what it becomes after a few retellings
  tags: Value[];
  weight: number;                // how much it matters (0.5 minor … 2 huge)
  witnesses: string[];           // companion keys, or eyewitness hub-kin keys ('nan', 'tom')
  kin?: { npc: string; fate: 'killed' | 'spared' | 'saved' | 'lost' };
  about: 'player' | CompanionKey;
}

export interface Heard { deed: string; hops: number; from: string; run: number; }

export interface HubState {
  heard: Record<string, Heard[]>;          // npc key → what they've heard
  standing: Record<string, number>;        // npc key → opinion of you (−1..1)
}

export function freshHub(): HubState {
  return { heard: {}, standing: Object.fromEntries(HUB_NPCS.map((n) => [n.key, 0.1])) };
}

const EMBELLISHERS: CompanionKey[] = ['pip'];

/**
 * Spread a run's deeds through the town. Returns human-readable lines describing who told whom.
 * `present` are the companions who came home (a companion who left or died tells nothing).
 */
export function tellTales(hub: HubState, deeds: Deed[], present: CompanionKey[], nameOf: (k: string) => string): string[] {
  const lines: string[] = [];
  const hear = (npc: string, d: Deed, hops: number, from: string) => {
    const list = (hub.heard[npc] ??= []);
    const prior = list.find((h) => h.deed === d.id);
    if (prior && prior.hops <= hops) return false;
    if (prior) { prior.hops = hops; prior.from = from; } else list.push({ deed: d.id, hops, from, run: d.run });
    judge(hub, npc, d, hops);
    return true;
  };
  for (const d of deeds) {
    // eyewitnesses from the town tell their own kin first-hand
    for (const w of d.witnesses) if (HUB_NPCS.some((n) => n.key === w)) hear(w, d, 0, 'saw it');
    // companions tell their confidants (and Marta); Pip embellishes
    for (const c of d.witnesses) {
      if (!present.includes(c as CompanionKey)) continue;
      const hops = EMBELLISHERS.includes(c as CompanionKey) ? 2 : 1;
      for (const n of HUB_NPCS) if (n.confidants.includes(c as CompanionKey) && hear(n.key, d, hops, c)) lines.push(`${nameOf(c)} tells ${n.name} how ${d.label}.`);
    }
  }
  // the inn: whatever Marta knows, the town knows a hop later
  for (const h of hub.heard['marta'] ?? []) {
    const d = deeds.find((x) => x.id === h.deed); if (!d) continue;
    for (const n of HUB_NPCS) if (n.key !== 'marta' && hear(n.key, d, h.hops + 1, 'marta')) { /* quiet spread */ }
  }
  return lines;
}

function judge(hub: HubState, npc: string, d: Deed, hops: number): void {
  const def = HUB_NPCS.find((n) => n.key === npc)!;
  const trust = hops === 0 ? 1 : hops === 1 ? 0.8 : 0.55;
  let delta = 0;
  for (const t of d.tags) delta += (def.values[t] ?? 0) * 0.12 * d.weight;
  if (d.kin && d.kin.npc === npc) delta += d.kin.fate === 'killed' || d.kin.fate === 'lost' ? -0.9 : 0.7;
  if (d.about !== 'player') delta *= 0.3;           // deeds about companions colour the company less
  hub.standing[npc] = Math.max(-1, Math.min(1, (hub.standing[npc] ?? 0) + delta * trust));
}

export interface HubLine { speaker: string; text: string; mood: 'warm' | 'cool' | 'cold' | 'neutral'; }

export interface HubContext {
  deeds: Deed[];
  runs: number;
  nameOf: (k: string) => string;
  companionNews: Array<{ key: CompanionKey; text: string }>;   // "Pip's walking taller", "Maud has left"
  questOffer: (npc: string) => string | null;
}

/** What this person says when you walk up to them now. Built from what they've heard, and from whom. */
export function speak(hub: HubState, npc: string, ctx: HubContext): HubLine[] {
  const def = HUB_NPCS.find((n) => n.key === npc)!;
  const s = hub.standing[npc] ?? 0;
  const mood: HubLine['mood'] = s > 0.35 ? 'warm' : s < -0.35 ? 'cold' : s < -0.05 ? 'cool' : 'neutral';
  const out: HubLine[] = [];
  const say = (text: string, m: HubLine['mood'] = mood) => out.push({ speaker: def.name, text, mood: m });
  const heard = (hub.heard[npc] ?? []).map((h) => ({ h, d: ctx.deeds.find((d) => d.id === h.deed)! })).filter((x) => x.d);

  if (ctx.runs === 0 && !heard.length) {
    say(greet(def, 'neutral'));
  } else {
    say(greet(def, mood));
  }
  // kin first: nothing else matters to a parent
  const kin = heard.find((x) => x.d.kin && x.d.kin.npc === npc);
  if (kin && def.kin) {
    const f = kin.d.kin!.fate;
    const who = def.kin.name.split(' ')[0];
    if (f === 'killed') say(`${kin.h.hops === 0 ? 'I saw' : `${source(kin.h, ctx)} told me`} what happened to my ${def.kin.relation} on ${kin.d.stage}. ${who} was a fool, but he was mine. Don't speak to me.`, 'cold');
    else if (f === 'spared') say(`${kin.h.from === 'saw it' ? `${who} came home.` : `They say you let ${who} live.`} He told me you could have killed him and didn't. I don't know what to say to you. Thank you.`, 'warm');
    else if (f === 'saved') say(`My ${def.kin.relation} is home because of you. ${kin.h.hops === 0 ? `${who} told me everything — how you cut the ropes.` : ''} Anything I have is yours.`, 'warm');
    else if (f === 'lost') say(`You were sent for my ${def.kin.relation}. You came back without her.`, 'cold');
  }
  // the deed that most engages this person's values, told with its provenance
  const scored = heard.filter((x) => x !== kin).map((x) => ({ ...x, v: x.d.tags.reduce((a, t) => a + Math.abs(def.values[t] ?? 0), 0) * x.d.weight + x.d.run * 0.3 }))
    .sort((a, b) => b.v - a.v);
  const said = new Set<string>();
  for (const x of scored.slice(0, 2)) {
    if (x.v <= 0.15) continue;
    const told = x.h.hops >= 2 ? x.d.lurid : x.d.label;
    const approve = x.d.tags.reduce((a, t) => a + (def.values[t] ?? 0), 0) >= 0;
    const lead = x.h.hops === 0 ? 'I saw' : x.h.hops === 1 ? `${source(x.h, ctx)} told me` : `${x.h.from === 'marta' ? 'Word at the Brewer\'s' : `${source(x.h, ctx)} swears`} is that`;
    const subject = x.d.about === 'player' ? 'you' : ctx.nameOf(x.d.about);
    let tail = reaction(def, x.d, approve);
    if (said.has(tail)) tail = ''; else said.add(tail);
    say(`${lead} ${subject} ${told.replace(/^you /, '')}${x.h.hops >= 2 ? ' — or so they say' : ''}. ${tail}`, approve ? (mood === 'cold' ? 'cool' : 'warm') : 'cool');
  }
  // what they've noticed about your company
  for (const n of ctx.companionNews.slice(0, 1)) say(n.text);
  const offer = ctx.questOffer(npc);
  if (offer) say(offer);
  if (out.length === 1 && ctx.runs > 0) say(idle(def, mood));
  return out;
}

function source(h: Heard, ctx: HubContext): string {
  if (h.from === 'marta') return 'Marta';
  if (h.from === 'saw it') return 'I';
  return ctx.nameOf(h.from).split(' ')[0];
}

function greet(def: HubNpcDef, mood: HubLine['mood']): string {
  const G: Record<string, Record<HubLine['mood'], string>> = {
    reeve: { neutral: 'You\'re the sellsword Marta mentioned. Good. I have work.', warm: 'There you are. The town\'s been talking.', cool: 'Hm. You\'re back.', cold: 'I have nothing to say to you that isn\'t business.' },
    marta: { neutral: 'Welcome to the Brewer\'s. Sit, eat, tell me something worth repeating.', warm: 'Sit down, sit down — first round\'s on me!', cool: 'Ale\'s the same price as always.', cold: 'Pay first.' },
    anselm: { neutral: 'Peace to you, traveller.', warm: 'Peace to you, friend. The chapel remembers kindness.', cool: 'Peace to you. I have been praying for you.', cold: 'I will pray for you. I cannot bless you.' },
    hilde: { neutral: 'Need something sharpened?', warm: 'Ha! The wolf-killer walks in. What do you need?', cool: 'Blades are blades. Coin is coin.', cold: 'Find another smith.' },
    tom: { neutral: 'Mm. Evening.', warm: 'Evening. Come, sit a moment.', cool: '...', cold: 'Leave me be.' },
    nan: { neutral: 'Please — have you heard anything of my Elsie?', warm: 'Bless you. Bless you.', cool: 'Oh. It\'s you.', cold: 'Get away from my door.' },
  };
  return G[def.key]?.[mood] ?? '...';
}

function reaction(def: HubNpcDef, d: Deed, approve: boolean): string {
  const k = def.key;
  if (d.tags.includes('cruelty')) return k === 'anselm' ? 'A man running away is no threat to anyone. Remember that.' : k === 'hilde' ? "Can't leave them to come back. Fair enough." : k === 'tom' ? "Someone's boy, that was." : "That's cold.";
  if (d.tags.includes('fire')) return k === 'anselm' ? 'Burning men alive. God forgive you — I am not sure I can.' : k === 'hilde' ? 'Fire works. I\'d not have the stomach, mind.' : approve ? '' : 'That\'s not the kind of thing people forget.';
  if (d.tags.includes('mercy')) return k === 'anselm' ? 'There is hope for you yet.' : k === 'hilde' ? 'Soft. They\'ll be back with friends.' : k === 'reeve' ? 'Mercy\'s fine until they raid the south road again.' : 'That was well done.';
  if (d.tags.includes('theft')) return k === 'reeve' ? 'Looting the dead is still looting.' : k === 'hilde' ? 'Dead men don\'t need purses.' : 'Hm.';
  if (d.tags.includes('courage')) return k === 'hilde' ? 'That\'s the stuff of songs.' : k === 'reeve' ? 'Good. That\'s what I paid for.' : 'You\'ve got nerve, I\'ll give you that.';
  return approve ? '' : 'I don\'t like it.';
}

function idle(def: HubNpcDef, mood: HubLine['mood']): string {
  return mood === 'cold' ? 'We\'re done here.' : def.key === 'marta' ? 'The whole town\'s talking about your lot.' : 'Safe roads.';
}
