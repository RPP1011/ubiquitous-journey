// Procedural ability generation, v2 — the doc-16 PIPELINE (the v1 three-template builder
// is gone). A spec is ASSEMBLED, not selected: FORM × PRIMARY op (budget-priced) × RIDER
// (t2+) × optional story-state CONDITION, drawn by a seeded stream from pools the class's
// tags (or the grant EVENT) vote in. The authored surface is VOCABULARY tables; the variety
// is the cross product with real identities and moments.
//
// Hard rules (unchanged + extended):
//   - Output MUST pass ir.validate() within ir.LIMITS; null on failure (callers treat as
//     "no grant"). DETERMINISTIC: seeded from fnv1a — no Math.random, no Date.
//   - R1 (the slow lesson): every op in a pool HAS a consumer (damage/heal/shield/stun/
//     slow are combat-live; plant_belief/scry act on beliefs; trade_edge/craft_boost are
//     the haggle/master_craft hooks).
//   - R2: a CLASS mint's id/name derive from its mechanical SIGNATURE — identical mechanics
//     share one name (and one cooldown key) world-wide. An EVENT mint's name comes from its
//     seam's register lexicon and its id from the moment — uniqueness is the point there.
//   - M1: condition refunds MULTIPLY as retained cost, floor 0.3 (≤70% refund), max 2
//     conditions (also enforced structurally by ir.validate).

import { spec, effect, validate, LIMITS } from './ir.js';
import { abilitySignature } from '../progression.js';
import { RPG } from '../rpgconfig.js';
import { fnv1a } from '../tags.js';
import type { AbilitySpec, AbilityArea, AbilityEffect, AbilityRequire, AbilityHeader, EffectOp } from '../../../types/sim.js';

// ---- deterministic seeded stream (unchanged from v1) ------------------------
interface Stream { next(): number; frac(): number; pick<T>(arr: readonly T[]): T; }
function seedFor(key: string, salt = 0): number { return fnv1a(`${key}|${salt}`); }
function nextState(s: number): number {
  s ^= (s << 13); s >>>= 0; s ^= (s >>> 17); s ^= (s << 5); s >>>= 0; return s >>> 0;
}
function stream(seed: number): Stream {
  let s = seed >>> 0 || 0x9e3779b9;
  return {
    next() { s = nextState(s); return s; },
    frac() { return this.next() / 0x100000000; },
    pick<T>(arr: readonly T[]): T { return arr[this.next() % arr.length]; },
  };
}

// ---- archetypes: six, voted by tags ------------------------------------------
type Archetype = 'combat' | 'defensive' | 'craft' | 'trade' | 'social' | 'cunning';
const VOTES: Record<Archetype, readonly string[]> = {
  combat:    ['MELEE', 'KILL', 'RISK', 'BERSERK', 'DUEL', 'ATTACK', 'POWER'],
  defensive: ['DEFENSE', 'ENDURANCE', 'HEAL', 'FLEE', 'SURVIVE', 'RESOLVE'],
  craft:     ['SMITHING', 'CRAFTING', 'TOOLMAKING', 'FARMING', 'MINING', 'WOODCUT', 'FORAGE', 'BUILD'],
  trade:     ['TRADE', 'PROFIT', 'HAGGLE', 'BARTER'],
  social:    ['PERSUADE', 'CHARM', 'GOSSIP', 'LEAD', 'SOCIAL'],
  cunning:   ['DECEIVE', 'STEALTH', 'CUNNING', 'INTRIGUE'],
};
const ARCH_ORDER: readonly Archetype[] = ['combat', 'defensive', 'craft', 'trade', 'social', 'cunning'];

function classifyArchetype(tags: readonly string[]): Archetype {
  let best: Archetype = 'combat', bestN = -1;
  for (const a of ARCH_ORDER) {
    let n = 0;
    for (const t of tags) if (VOTES[a].includes(t)) n++;
    if (n > bestN) { bestN = n; best = a; }
  }
  return best;
}

// ---- tier + budget ------------------------------------------------------------
function tierIndex(tier: unknown): number {
  const t = Math.floor(Number(tier));
  return isFinite(t) && t >= 1 ? t : 1;
}
const G = () => (RPG.gen || {}) as Record<string, number>;
function budgetFor(tier: number): number {
  return (G().budgetBase ?? 30) * Math.pow(G().budgetGrowth ?? 1.35, tierIndex(tier) - 1);
}
// M1: refunds MULTIPLY as retained cost, floored at 0.3 (cap 70% total refund).
const COND_RETAIN: Record<string, number> = {
  vs_sworn_foe: 0.4, while_faithful: 0.65, while_oaths_kept: 0.75, near_home: 0.75,
};
function refundFor(requires: AbilityRequire[] | undefined): number {
  let retain = 1;
  for (const r of requires || []) retain *= COND_RETAIN[r.kind] ?? 1;
  return Math.max(0.3, retain);
}
const clampAmt = (x: number): number => Math.max(0, Math.min(LIMITS.amount, Math.round(x * 10) / 10));
const clampDur = (x: number): number => Math.max(0, Math.min(LIMITS.dur, Math.round(x * 10) / 10));
const clampCd  = (x: number): number => Math.max(1, Math.min(LIMITS.cooldown, Math.round(x * 10) / 10));

// ---- the clause assembly --------------------------------------------------------
interface Built { header: Partial<AbilityHeader>; effects: AbilityEffect[]; grantsTags: string[]; primary: EffectOp; form: string; }

function build(archetype: Archetype, tier: number, rng: Stream, tags: readonly string[], requires?: AbilityRequire[]): Built {
  const t = tierIndex(tier);
  const budget = budgetFor(t) / refundFor(requires);   // a bound ability is a STRONGER one
  const cdBase = clampCd(5 + 2.2 * (t - 1));

  if (archetype === 'combat') {
    const projectile = rng.frac() > (tags.includes('MELEE') ? 0.7 : 0.4);
    const dmg = clampAmt(budget * (G().dmgPerPoint ?? 1.0));
    const effects: AbilityEffect[] = [effect('damage', { amount: dmg, tags: projectile ? ['CAST', 'MELEE'] : ['MELEE', 'FORCE'] })];
    let form = projectile ? 'projectile' : 'melee';
    let area: AbilityArea = { kind: 'self' };
    if (!projectile && t >= 3) { area = { kind: 'cone', r: Math.min(LIMITS.areaR, 2.6 + 0.3 * t), deg: 100 }; form = 'cone'; }
    if (t >= 2) {
      // tiers add CLAUSES: a rider, not just numbers (R5)
      const rider = rng.pick(['knockback', 'slow', 'stun'] as const);
      if (rider === 'knockback') effects.push(effect('knockback', { amount: clampAmt(1.2 + 0.4 * t), when: 'on_hit', tags: ['FORCE'] }));
      else if (rider === 'slow') effects.push(effect('slow', { amount: 0.5, dur: clampDur(1.5 + 0.5 * t), when: 'on_hit', tags: ['FROST'] }));
      else effects.push(effect('stun', { dur: clampDur(0.8 + 0.25 * t), when: 'on_hit', tags: ['CONTROL'] }));
    }
    return {
      header: projectile
        ? { target: 'enemy', range: Math.min(LIMITS.range, 9 + 1.5 * t), cooldown: cdBase, area: { kind: 'self' }, delivery: { kind: 'projectile', speed: Math.min(LIMITS.speed, 16 + 4 * t) } }
        : { target: 'enemy', range: 2.6, cooldown: cdBase, area, delivery: { kind: 'instant' } },
      effects, grantsTags: projectile ? ['CAST', 'ATTACK', 'POWER'] : ['ATTACK', 'MELEE', 'POWER'],
      primary: 'damage', form,
    };
  }
  if (archetype === 'defensive') {
    const wantHeal = rng.frac() < (tags.includes('HEAL') || tags.includes('ENDURANCE') ? 0.65 : 0.35);
    const effects: AbilityEffect[] = [];
    let primary: EffectOp = 'shield';
    if (wantHeal) { primary = 'heal'; effects.push(effect('heal', { amount: clampAmt(budget / (G().healPerPoint ?? 1.1)), when: 'caster_hp_below', tags: ['RESTORE'] })); }
    effects.push(effect('shield', { amount: clampAmt((wantHeal ? budget * 0.4 : budget) / (G().shieldPerPoint ?? 0.9)), dur: clampDur(4 + t), tags: ['WARD'] }));
    return {
      header: { target: 'self', range: 0, cooldown: clampCd(14 + 3 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
      effects, grantsTags: ['DEFEND', 'SURVIVE', 'RESOLVE'], primary, form: 'self',
    };
  }
  if (archetype === 'craft') {
    // the master_craft hook: a produce-speed window; budget buys duration.
    return {
      header: { target: 'self', range: 0, cooldown: clampCd(18 + 4 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
      effects: [effect('craft_boost', { amount: Math.min(2.2, 1.3 + 0.1 * t), dur: clampDur(budget / (G().windowCostPerSec ?? 4)), tags: ['CRAFT'] })],
      grantsTags: ['CRAFT', 'PRODUCE', 'MASTERY'], primary: 'craft_boost' as EffectOp, form: 'self',
    };
  }
  if (archetype === 'trade') {
    // the haggle hook: a price-edge window; budget buys duration.
    return {
      header: { target: 'self', range: 0, cooldown: clampCd(14 + 3 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
      effects: [effect('trade_edge', { amount: 0.05 + 0.01 * Math.min(5, t), dur: clampDur(budget / (G().windowCostPerSec ?? 4)), tags: ['BARTER', 'PROFIT'] })],
      grantsTags: ['TRADE', 'BARTER', 'PROFIT'], primary: 'trade_edge' as EffectOp, form: 'self',
    };
  }
  if (archetype === 'social') {
    const wantScry = rng.frac() < 0.4;
    if (wantScry) {
      return {
        header: { target: 'any', range: 6 + 0.5 * t, cooldown: clampCd(10 + 2 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
        effects: [effect('scry', { amount: 0, tags: ['INSIGHT'] })],
        grantsTags: ['SOCIAL', 'INSIGHT', 'OBSERVE'], primary: 'scry', form: 'gaze',
      };
    }
    // charm: NEGATIVE amount raises the target's standing toward the caster (sign fixed)
    return {
      header: { target: 'any', range: 6, cooldown: clampCd(12 + 2 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
      effects: [effect('plant_belief', { amount: -Math.min(1, 0.25 + 0.07 * t + budget / 400), tags: ['CHARM', 'PERSUADE'] })],
      grantsTags: ['SOCIAL', 'PERSUADE', 'CHARM'], primary: 'plant_belief', form: 'charm',
    };
  }
  // cunning: a rumour (positive plant), or control.
  const wantRumour = rng.frac() < 0.5;
  if (wantRumour) {
    return {
      header: { target: 'any', range: 6, cooldown: clampCd(15 + 2 * t), area: t >= 2 ? { kind: 'circle', r: Math.min(LIMITS.areaR, 4 + 0.6 * t) } : { kind: 'self' }, delivery: { kind: 'instant' } },
      effects: [effect('plant_belief', { amount: Math.min(1, 0.35 + 0.07 * t), tags: ['DECEIVE', 'INTRIGUE'] })],
      grantsTags: ['SOCIAL', 'DECEIVE', 'CUNNING'], primary: 'plant_belief', form: 'whisper',
    };
  }
  const useStun = t >= 2 && rng.frac() < 0.4;
  return {
    header: { target: 'enemy', range: Math.min(8, 6 + 0.5 * t), cooldown: clampCd(9 + 2 * t), area: { kind: 'self' }, delivery: { kind: 'instant' } },
    effects: [useStun
      ? effect('stun', { dur: clampDur(budget / (G().stunCostPerSec ?? 14)), when: 'on_hit', tags: ['CONTROL'] })
      : effect('slow', { amount: 0.5, dur: clampDur(budget / (G().slowCostPerSec ?? 6)), tags: ['CONTROL'] })],
    grantsTags: ['SOCIAL', 'CONTROL', 'CUNNING'], primary: useStun ? 'stun' : 'slow', form: 'snare',
  };
}

// ---- names ----------------------------------------------------------------------
const TIER_ADJ = ['Lesser', 'Steady', 'Greater', 'Master', 'Grand', 'Peerless'];
const OP_NOUN: Record<string, string> = {
  'damage/melee': 'Strike', 'damage/cone': 'Cleave', 'damage/projectile': 'Bolt',
  'heal/self': 'Mending', 'shield/self': 'Ward',
  'craft_boost/self': 'Craft', 'trade_edge/self': 'Bargain',
  'plant_belief/charm': 'Charm', 'plant_belief/whisper': 'Whisper', 'scry/gaze': 'Eye',
  'slow/snare': 'Snare', 'stun/snare': 'Hold',
};
const TAG_EPITHET: Record<string, string> = {
  FARMING: 'Harvest', WOODCUT: 'Timber', MINING: 'Stone', FORAGE: 'Herbwise', SMITHING: 'Forge',
  CRAFTING: 'Maker’s', TRADE: 'Ledger', PROFIT: 'Coin', HAGGLE: 'Market', BARTER: 'Trader’s',
  PERSUADE: 'Silver', CHARM: 'Honeyed', GOSSIP: 'Whispered', LEAD: 'Banner', DECEIVE: 'Shadow',
  STEALTH: 'Veiled', MELEE: 'War', KILL: 'Reaver’s', RISK: 'Daring', DEFENSE: 'Iron',
  ENDURANCE: 'Stalwart', HEAL: 'Mercy’s', EXPLORE: 'Wayfarer’s', BUILD: 'Mason’s',
};
function epithetFor(tags: readonly string[], rng: Stream): string {
  const hits = tags.filter((t) => TAG_EPITHET[t]);
  return hits.length ? TAG_EPITHET[rng.pick(hits)] : '';
}

// ---- public API: CLASS mints (R2: id/name from the mechanical signature) ------------
interface ClassDescriptor { classKey?: string; key?: string; tags?: unknown; }
export function generateAbility(cls: ClassDescriptor | null | undefined, tier: unknown): AbilitySpec | null {
  const classKey = cls?.classKey ?? cls?.key ?? 'proc';
  const tags: string[] = Array.isArray(cls?.tags) ? cls.tags.filter((t): t is string => typeof t === 'string') : [];
  const t = tierIndex(tier);
  const archetype = classifyArchetype(tags);
  const rng = stream(seedFor(`${classKey}|${t}|${archetype}`, 1));
  const body = build(archetype, t, rng, tags);

  // R2 — name + id derive from the SIGNATURE: identical mechanics share one name (and one
  // cooldown key) everywhere; a name difference always means a mechanics difference.
  const draft = spec({ id: 'sig', classKey, tier: t, header: body.header, effects: body.effects, grantsTags: body.grantsTags });
  const sig = abilitySignature(draft);
  const sigHash = fnv1a(sig).toString(36);
  const adj = TIER_ADJ[Math.min(TIER_ADJ.length - 1, t - 1)];
  const noun = OP_NOUN[`${body.primary}/${body.form}`] || 'Skill';
  const epithet = epithetFor(tags, stream(seedFor(sig, 2)));   // seeded by the SIGNATURE, not the class
  const out = spec({
    id: `gen_${sigHash}`,
    name: `[${adj}${epithet ? ' ' + epithet : ''} ${noun}]`,
    classKey, tier: t, header: body.header, effects: body.effects, grantsTags: body.grantsTags,
  });
  return validate(out) ? out : null;
}

// ---- public API: EVENT mints (doc 15 grant seams; provenance + condition-bound) -----
// `register` picks the name lexicon; the SEAM supplies the condition (refund -> stronger);
// names carry no person-ids (cognition mints them) — the WHO lives in origin.withId and is
// rendered by the display layer (biography/codex) via nameOf.
const NAME_LEXICON: Record<string, readonly string[]> = {
  vengeance: ['The Vow Kept', 'Blood Debt Paid', 'What Was Owed', 'The Long Memory'],
  guile:     ['What Promises Are Worth', 'The Loose Tongue', 'A Debt Unpaid', 'The Sideways Look'],
  holy:      ['{god}’s Mercy', '{god}’s Calm', 'The {god} Blessing', '{god}’s Quiet Hand'],
  grit:      ['The Day I Did Not Die', 'Second Dawn', 'Not Yet', 'The Stubborn Hour'],
};
export interface EventGrantDesc {
  seam: string;            // e.g. 'oath:kept' — joins the id + origin
  agentId: number | string;
  t: number;               // sim-time of the moment (joins the seed — determinism per moment)
  tier?: number;
  archetype: Archetype;
  register: keyof typeof NAME_LEXICON | string;
  tags?: string[];
  requires?: AbilityRequire[];
  god?: string;
  withId?: number | string | null;
  originText: string;
}
export function generateEventAbility(d: EventGrantDesc): AbilitySpec | null {
  if (!d || !d.seam) return null;
  const t = tierIndex(d.tier ?? 2);
  const rng = stream(seedFor(`${d.agentId}|${d.seam}|${Math.floor(d.t)}`, 3));
  const body = build(d.archetype, t, rng, d.tags || [], d.requires);
  const pool = NAME_LEXICON[d.register as string] || NAME_LEXICON.grit;
  const raw = rng.pick(pool).replace('{god}', d.god || 'the gods');
  const out = spec({
    id: `evt_${d.seam.replace(/[^a-z0-9]+/gi, '_')}_${d.agentId}_${Math.floor(d.t)}`,
    name: `[${raw}]`,
    classKey: null, tier: t,
    header: { ...body.header, ...(d.requires && d.requires.length ? { requires: d.requires } : {}) },
    effects: body.effects, grantsTags: body.grantsTags,
    origin: { seam: d.seam, withId: d.withId ?? null, t: d.t, text: d.originText },
  });
  return validate(out) ? out : null;
}
