// COMPANIONS: four people who travel with you, and change because of what happens to them.
//
// Each has a persistent PROFILE — traits (bravery, compassion, loyalty to you, ruthlessness),
// MEMORIES of specific moments, and running tallies. Traits drive the tactical AI directly
// (the timid break when hurt; the compassionate go to the fallen and won't cut down the
// fleeing; the ruthless finish them and reach for fire), so development is visible as
// BEHAVIOUR, not just numbers. Profiles persist across runs.
//
// Growth comes from two sources, folded after every battle:
//   what happened TO them   — went down (and who hauled them up), fled, held the line, killed
//   what YOU did in front of them — burned people, cut down the fleeing, spared a beaten foe,
//                             cut a captive free, lifted a purse; each companion judges by
//                             their own compassion and ruthlessness.

import type { Battle, BattleEvent, Traits, Unit } from '../tactics/battle.js';

export type CompanionKey = 'borin' | 'wren' | 'pip' | 'maud';

export interface CompanionDef {
  key: CompanionKey;
  name: string;
  short: string;
  title: string;
  blurb: string;
  model: 'knight' | 'barbarian' | 'rogue' | 'hooded';
  tactic: 'guardian' | 'archer' | 'rogue' | 'healer';
  abilities: string[];
  potions: number;
  base: Traits;
  social: number;          // presence for bluffs/intimidation
}

export const COMPANIONS: Record<CompanionKey, CompanionDef> = {
  borin: { key: 'borin', name: 'Borin Ashgrove', short: 'Borin', title: 'the shield', blurb: 'A gruff ex-militiaman who never quite left the wall.',
    model: 'knight', tactic: 'guardian', abilities: ['power_strike', 'second_wind'], potions: 1,
    base: { bravery: 0.72, compassion: 0.5, loyalty: 0.55, ruthlessness: 0.3 }, social: 0.3 },
  wren: { key: 'wren', name: 'Wren Tallow', short: 'Wren', title: 'the hunter', blurb: 'A quiet trapper who counts arrows and people the same way.',
    model: 'hooded', tactic: 'archer', abilities: ['shortbow', 'expose_weakness'], potions: 0,
    base: { bravery: 0.55, compassion: 0.3, loyalty: 0.45, ruthlessness: 0.55 }, social: 0.2 },
  pip: { key: 'pip', name: 'Pip Marrow', short: 'Pip', title: 'the tanner\'s boy', blurb: 'Seventeen, quick-tongued, and very sure he is not afraid.',
    model: 'rogue', tactic: 'rogue', abilities: ['lunge'], potions: 0,
    base: { bravery: 0.22, compassion: 0.7, loyalty: 0.6, ruthlessness: 0.15 }, social: 0.9 },
  maud: { key: 'maud', name: 'Sister Maud', short: 'Maud', title: 'of the chapel', blurb: 'A field-nurse from the chapel who has buried too many.',
    model: 'knight', tactic: 'healer', abilities: [], potions: 3,
    base: { bravery: 0.45, compassion: 0.92, loyalty: 0.5, ruthlessness: 0.05 }, social: 0.6 },
};

export interface Memory { run: number; stage: string; text: string; tag: string; delta: Partial<Traits>; }

export interface CompanionProfile {
  key: CompanionKey;
  traits: Traits;
  memories: Memory[];
  stats: { runs: number; battles: number; kills: number; downs: number; fled: number; saves: number; revivedBy: Record<string, number> };
  alive: boolean;
  departed: boolean;       // left the company over what you did
}

export function freshProfile(key: CompanionKey): CompanionProfile {
  return { key, traits: { ...COMPANIONS[key].base }, memories: [], stats: { runs: 0, battles: 0, kills: 0, downs: 0, fled: 0, saves: 0, revivedBy: {} }, alive: true, departed: false };
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** Apply a trait change and remember why. */
function grow(p: CompanionProfile, run: number, stage: string, tag: string, text: string, delta: Partial<Traits>): void {
  for (const k of Object.keys(delta) as Array<keyof Traits>) p.traits[k] = clamp(p.traits[k] + (delta[k] as number));
  p.memories.push({ run, stage, text, tag, delta });
  if (p.memories.length > 40) p.memories.splice(0, p.memories.length - 40);
}

/**
 * Fold one battle into every companion who was there. `nameOf` resolves unit ids to names;
 * `unitKey` maps a unit id to a companion key (or 'player').
 */
export function developFromBattle(b: Battle, profiles: Map<CompanionKey, CompanionProfile>, companionOf: Map<Unit['id'], CompanionKey>,
  playerId: Unit['id'], run: number, stage: string): string[] {
  const lines: string[] = [];
  const nm = (id: Unit['id'] | undefined) => { const u = id != null ? b.get(id) : undefined; return u ? (u.agent.controlled ? 'you' : u.agent.name) : 'someone'; };
  const ev = (k: BattleEvent['kind']) => b.events.filter((e) => e.kind === k);
  const won = b.outcome === 'victory' || b.outcome === 'truce';
  for (const [uid, key] of companionOf) {
    const p = profiles.get(key)!;
    const u = b.get(uid);
    if (!u) continue;
    const first = COMPANIONS[key].short;
    p.stats.battles++;
    const before = { ...p.traits };
    // what happened to them
    for (const e of ev('down').filter((e) => e.target === uid)) {
      p.stats.downs++;
      const saver = ev('revive').find((r) => r.target === uid && r.round >= e.round);
      if (saver && saver.actor === playerId) {
        grow(p, run, stage, 'saved-by-you', `You hauled me up when ${nm(e.actor)} put me down at ${stage}.`, { loyalty: +0.1, bravery: +0.02 });
      } else if (saver) {
        const by = companionOf.get(saver.actor!);
        if (by) p.stats.revivedBy[by] = (p.stats.revivedBy[by] || 0) + 1;
        grow(p, run, stage, 'saved-by-friend', `${nm(saver.actor)} got me back on my feet at ${stage}.`, { bravery: +0.01 });
      } else {
        grow(p, run, stage, 'fell', `${nm(e.actor)} put me in the dirt at ${stage}.`, { bravery: -0.04 });
      }
    }
    const fled = ev('escape').some((e) => e.actor === uid) || ev('broken').some((e) => e.actor === uid);
    if (fled) {
      p.stats.fled++;
      grow(p, run, stage, 'fled', `I ran at ${stage}. I heard you shouting after me.`, { bravery: -0.03 });
    } else if (u.out === null && u.agent.alive && won) {
      // held the line: the timid grow most from simply staying
      const held = 0.03 + (0.5 - Math.min(0.5, p.traits.bravery)) * 0.16;
      grow(p, run, stage, 'held', `I held my ground at ${stage}.`, { bravery: +held });
    }
    const kills = ev('kill').filter((e) => e.actor === uid).length;
    const finishes = ev('finish').filter((e) => e.actor === uid);
    p.stats.kills += kills + finishes.length;
    if (finishes.length) grow(p, run, stage, 'finished', `I cut down ${nm(finishes[0].target)} as they ran.`, { ruthlessness: +0.06, compassion: -0.03 });
    for (const e of ev('revive').filter((e) => e.actor === uid)) {
      p.stats.saves++;
      if (e.target === playerId) grow(p, run, stage, 'saved-you', `I dragged you out of it at ${stage}.`, { loyalty: +0.04, bravery: +0.04 });
    }
    for (const e of ev('free').filter((e) => e.actor === uid)) grow(p, run, stage, 'freed', `I cut ${nm(e.target)} loose at ${stage}.`, { compassion: +0.03, bravery: +0.02 });

    // what YOU did, judged by who they are
    const c = p.traits.compassion, r = p.traits.ruthlessness;
    const burnedPeople = ev('ignite').filter((e) => e.actor === playerId && e.target != null).length + ev('hazard').filter((e) => e.actor === playerId && e.detail === 'fire').length;
    if (burnedPeople) {
      if (c > 0.6) grow(p, run, stage, 'you-burned', `You set men on fire at ${stage}. I can still hear it.`, { loyalty: -0.07 * burnedPeople });
      else if (r > 0.45) grow(p, run, stage, 'you-burned', `You used the fire at ${stage}. Smart. Ugly, but smart.`, { loyalty: +0.03, ruthlessness: +0.02 });
    }
    const yourFinishes = ev('finish').filter((e) => e.actor === playerId);
    if (yourFinishes.length) {
      if (c > 0.55) grow(p, run, stage, 'you-finished', `You struck down ${nm(yourFinishes[0].target)} with their back turned at ${stage}.`, { loyalty: -0.08 });
      else if (r > 0.5) grow(p, run, stage, 'you-finished', `You didn't let ${nm(yourFinishes[0].target)} get away at ${stage}.`, { loyalty: +0.03 });
    }
    const spared = ev('yield').filter((e) => e.actor === playerId || (e.detail === 'surrender')).length + ev('parley').filter((e) => e.actor === playerId).length;
    if (spared) {
      if (c > 0.5) grow(p, run, stage, 'you-spared', `You let them live at ${stage}.`, { loyalty: +0.06, compassion: +0.02 });
      else if (r > 0.55) grow(p, run, stage, 'you-spared', `You let them walk away at ${stage}. They'll be back.`, { loyalty: -0.03 });
    }
    if (ev('grab').some((e) => e.actor === playerId) && c > 0.5) grow(p, run, stage, 'you-robbed', `You went through a beaten man's purse at ${stage}.`, { loyalty: -0.05 });
    if (ev('free').some((e) => e.actor === playerId)) grow(p, run, stage, 'you-freed', `You cut the captive loose yourself at ${stage}.`, { loyalty: +0.03 + c * 0.04 });
    if (won) p.traits.bravery = clamp(p.traits.bravery + 0.01);

    const d = (k: keyof Traits) => p.traits[k] - before[k];
    const moved = (['bravery', 'compassion', 'loyalty', 'ruthlessness'] as const).filter((k) => Math.abs(d(k)) >= 0.04);
    if (moved.length) lines.push(`${first}: ${moved.map((k) => `${k} ${d(k) > 0 ? '▲' : '▼'}`).join(', ')}`);
  }
  return lines;
}

/** Something a companion says — before a battle, after one, or in the hub. Draws on memories. */
/** What a companion says to someone they've grown close to (a bond of 2+), before a fight. */
export function pairBark(k: CompanionKey, other: string | null, rival = false): string {
  if (rival) switch (k) {
    case 'pip': return other ? `Try not to trip over me this time, ${other}.` : `Just — say what you'll do, and do it. For once.`;
    case 'borin': return other ? `${other} can mind their own hide. I've my own to guard.` : `I'll follow the plan. If there is one.`;
    case 'wren': return other ? `Stay out of my line, ${other}. I won't wait for you.` : `I'll do it my way. You can watch.`;
    case 'maud': return other ? `I'll mend ${other} if I must. Don't ask me to like it.` : `I'm here for them, not for you.`;
  }
  switch (k) {
    case 'pip': return other ? `Stay close to me, ${other}. Or — I'll stay close to you.` : `If it goes bad, I'm at your back. I mean it.`;
    case 'borin': return other ? `${other}, on my shield. Nobody touches you today.` : `You call it, I'll hold it. Same as always.`;
    case 'wren': return other ? `${other} — I've got your left. Don't make me waste arrows.` : `Say where. I'll put one there.`;
    case 'maud': return other ? `${other}, keep close. I'm not losing you to this lot.` : `Whatever happens, I'll patch you up. Don't make it hard.`;
  }
}

export function bark(p: CompanionProfile, moment: 'setout' | 'prebattle' | 'victory' | 'hub', place = ''): string {
  const def = COMPANIONS[p.key];
  const t = p.traits;
  const last = (tag: string) => [...p.memories].reverse().find((m) => m.tag === tag);
  const ran = last('fled'), held = last('held'), saved = last('saved-by-you'), burned = last('you-burned'), finished = last('you-finished'), spared = last('you-spared');
  switch (def.key) {
    case 'pip':
      if (moment === 'prebattle') {
        if (ran && t.bravery < 0.35) return `(quietly) I won't run this time. I won't.`;
        if (t.bravery >= 0.45 && ran) return `Last time I ran. Watch me now — I'm staying.`;
        if (t.bravery < 0.3) return `Are there many of them? There are, aren't there.`;
        return `Right behind you. Well — near you.`;
      }
      if (moment === 'victory') return t.bravery >= 0.45 ? `Did you see that? I stood right there!` : held ? `I... I held. Mostly.` : `Is it over? It's over.`;
      if (moment === 'setout') return saved ? `You pulled me out last time. I owe you. Let's go.` : `I've got a good feeling. Mostly.`;
      break;
    case 'borin':
      if (moment === 'prebattle') return t.loyalty < 0.35 ? `I'll hold the line. For the coin.` : `Shields up. Stay behind me, the lot of you.`;
      if (moment === 'victory') return burned && t.compassion > 0.45 ? `Won. Didn't have to be like that, though.` : `That's how it's done.`;
      if (moment === 'setout') return finished && t.loyalty < 0.45 ? `I'll come. But no more knifing men in the back.` : `Ready when you are.`;
      break;
    case 'wren':
      if (moment === 'prebattle') return t.ruthlessness > 0.6 ? `None of them walk away. That's how you stay safe.` : `I'll find a high spot.`;
      if (moment === 'victory') return spared && t.ruthlessness > 0.55 ? `You let one live. Remember that when he comes back.` : `Clean enough.`;
      if (moment === 'setout') return `Arrows fletched. Let's go.`;
      break;
    case 'maud':
      if (moment === 'prebattle') return burned ? `No fire this time. I'm asking you.` : `I'll keep you all breathing. Mind the wounded.`;
      if (moment === 'victory') return spared ? `You showed mercy. That matters more than you know.` : burned || finished ? `...Let me see to the dead.` : `Hold still, let me look at that cut.`;
      if (moment === 'setout') return t.loyalty < 0.3 ? `I'll come. For their sake, not yours.` : `The chapel sends its blessing. And bandages.`;
      break;
  }
  if (moment === 'hub') return p.memories.length ? `"${p.memories[p.memories.length - 1].text}"` : `…`;
  return '…';
}

/** A companion whose loyalty has collapsed leaves the company after a run. */
export function checkDeparture(p: CompanionProfile): string | null {
  if (!p.departed && p.traits.loyalty < 0.12) {
    p.departed = true;
    return `${COMPANIONS[p.key].name} leaves the company. "I won't be part of this anymore."`;
  }
  return null;
}
