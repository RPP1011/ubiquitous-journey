// Hand-authored ability catalog: the baseline [Skills] granted at class tier
// milestones. Each entry is a validated AbilitySpec (data only). They span the
// three play pillars — combat, social, and economy — so a class's milestones
// can pull from whichever pillar its behaviour profile favours.
//
// Wandering-Inn flavour: bracketed [Skill] display names. classKey strings match
// the lowercase CLASS_TEMPLATES keys in classes.js (warrior, brawler, hunter,
// trickster, speaker, merchant, blacksmith…) used by the matcher.

import { spec, effect } from './ir.js';
import type { AbilitySpec } from '../../../types/sim.js';

const A = (o: Parameters<typeof spec>[0]): AbilitySpec => spec(o);   // terse alias

// ---- COMBAT ------------------------------------------------------------------
const power_strike = A({
  id: 'power_strike', name: '[Power Strike]', classKey: 'warrior', tier: 1,
  header: { target: 'enemy', range: 2.6, cooldown: 5, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('damage', { amount: 46, tags: ['MELEE', 'FORCE'] })],
  grantsTags: ['ATTACK', 'MELEE', 'POWER'],
});

const lunge = A({
  id: 'lunge', name: '[Lunge]', classKey: 'warrior', tier: 2,
  header: { target: 'enemy', range: 2.8, cooldown: 7, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('dash', { amount: 3.0 }),
    effect('damage', { amount: 34, tags: ['MELEE', 'PIERCE'] }),
  ],
  grantsTags: ['ATTACK', 'MELEE', 'MOBILITY'],
});

const whirlwind = A({
  id: 'whirlwind', name: '[Whirlwind]', classKey: 'brawler', tier: 2,
  header: { target: 'enemy', range: 3.2, cooldown: 11, area: { kind: 'circle', r: 3.2 }, delivery: { kind: 'instant' } },
  effects: [
    effect('damage', { amount: 30, tags: ['MELEE', 'SWEEP'] }),
    effect('knockback', { amount: 1.6, when: 'on_hit' }),
  ],
  grantsTags: ['ATTACK', 'AOE', 'RECKLESS'],
});

const second_wind = A({
  id: 'second_wind', name: '[Second Wind]', classKey: 'warrior', tier: 3,
  header: { target: 'self', range: 0, cooldown: 24, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('heal', { amount: 45, when: 'caster_hp_below', tags: ['RESTORE'] }),
    effect('shield', { amount: 25, dur: 6 }),
  ],
  grantsTags: ['DEFEND', 'SURVIVE', 'RESOLVE'],
});

const cleaving_blow = A({
  id: 'cleaving_blow', name: '[Cleaving Blow]', classKey: 'brawler', tier: 1,
  header: { target: 'enemy', range: 2.8, cooldown: 6, area: { kind: 'cone', r: 2.8, deg: 100 }, delivery: { kind: 'instant' } },
  effects: [effect('damage', { amount: 38, tags: ['MELEE', 'CLEAVE'] })],
  grantsTags: ['ATTACK', 'AOE', 'MELEE'],
});

// ---- SOCIAL ------------------------------------------------------------------
// plant_belief sign convention (effects.ts): amount < 0 = CHARM — raises the
// target's standing toward the caster, no suspicion; amount > 0 = DECEIVE — plants
// suspicion + sours standing. Charm-type specs (silver_tongue, haggle) carry
// negative amounts on purpose.
const silver_tongue = A({
  id: 'silver_tongue', name: '[Silver Tongue]', classKey: 'speaker', tier: 1,
  header: { target: 'any', range: 6, cooldown: 12, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('plant_belief', { amount: -0.4, tags: ['CHARM', 'PERSUADE'] })],
  grantsTags: ['SOCIAL', 'PERSUADE', 'CHARM'],
});

const plant_rumor = A({
  id: 'plant_rumor', name: '[Plant Rumor]', classKey: 'trickster', tier: 2,
  header: { target: 'any', range: 6, cooldown: 15, area: { kind: 'circle', r: 6 }, delivery: { kind: 'instant' } },
  effects: [effect('plant_belief', { amount: 0.5, tags: ['DECEIVE', 'INTRIGUE'] })],
  grantsTags: ['SOCIAL', 'DECEIVE', 'CUNNING'],
});

const read_mind = A({
  id: 'read_mind', name: '[Read the Room]', classKey: 'trickster', tier: 1,
  header: { target: 'any', range: 7, cooldown: 10, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('scry', { amount: 0, tags: ['INSIGHT'] })],
  grantsTags: ['SOCIAL', 'INSIGHT', 'OBSERVE'],
});

// ---- ECONOMY -----------------------------------------------------------------
// economy abilities act through the caster-side economy ops: trade_edge opens a
// bargaining window trade.js ask/bid honour (magnitude in ABILITY.haggleEdge),
// craft_boost opens a produce-speed window produce() honours (ABILITY.craftBoostMul).
// Durations ride on the spec; the cast event still feeds the economy/quest systems.
const haggle = A({
  id: 'haggle', name: '[Haggle]', classKey: 'merchant', tier: 1,
  header: { target: 'any', range: 5, cooldown: 8, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('plant_belief', { amount: -0.2, tags: ['BARTER', 'PROFIT'] }),   // a little charm with the counterparty
    effect('trade_edge', { amount: 0, dur: 12, tags: ['BARTER'] }),         // the real mechanic: the bargaining window
  ],
  grantsTags: ['TRADE', 'BARTER', 'PROFIT'],
});

const master_craft = A({
  id: 'master_craft', name: '[Master Craft]', classKey: 'blacksmith', tier: 2,
  header: { target: 'self', range: 0, cooldown: 20, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('craft_boost', { amount: 0, dur: 10, tags: ['CRAFT', 'TEMPER'] })],
  grantsTags: ['CRAFT', 'PRODUCE', 'MASTERY'],
});

const frost_bolt = A({
  id: 'frost_bolt', name: '[Frost Bolt]', classKey: 'hunter', tier: 1,
  header: { target: 'enemy', range: 10, cooldown: 6, area: { kind: 'self' }, delivery: { kind: 'projectile', speed: 16 } },
  effects: [
    effect('damage', { amount: 28, tags: ['FROST', 'MAGIC'] }),
    effect('slow', { amount: 0.5, dur: 3, when: 'on_hit', tags: ['FROST'] }),
  ],
  grantsTags: ['CAST', 'MAGIC', 'FROST'],
});

export const ABILITY_CATALOG = {
  power_strike, lunge, whirlwind, second_wind, cleaving_blow,
  silver_tongue, plant_rumor, read_mind, haggle, master_craft, frost_bolt,
};

// CLASS_MILESTONES: classKey -> { level: abilityId }. When Progression levels a
// class past a milestone level, it grants that ability (looked up in the catalog
// and copied into agent's known abilities). Keys mirror CLASS_TEMPLATES.
export const CLASS_MILESTONES: Record<string, Record<number, string>> = {
  warrior:    { 1: 'power_strike', 4: 'lunge', 8: 'second_wind' },
  brawler:    { 1: 'cleaving_blow', 5: 'whirlwind' },
  hunter:     { 1: 'frost_bolt' },
  trickster:  { 1: 'read_mind', 5: 'plant_rumor' },
  speaker:    { 2: 'silver_tongue' },
  merchant:   { 1: 'haggle' },
  blacksmith: { 3: 'master_craft' },
};

// helper: the ability id (if any) a class unlocks at exactly `level`.
export function milestoneAt(classKey: string, level: number): string | null {
  const m = CLASS_MILESTONES[classKey];
  return m ? m[level] || null : null;
}
