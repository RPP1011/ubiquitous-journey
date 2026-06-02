// Hand-authored ability catalog: the baseline [Skills] granted at class tier
// milestones. Each entry is a validated AbilitySpec (data only). They span the
// three play pillars — combat, social, and economy — so a class's milestones
// can pull from whichever pillar its behaviour profile favours.
//
// Wandering-Inn flavour: bracketed [Skill] display names. classKey strings match
// the progression CLASS_TEMPLATES keys (Warrior, Berserker, Merchant, Rogue,
// Diplomat, Artisan, Mage…) used by the matcher.

import { spec, effect } from './ir.js';

const A = (o) => spec(o);   // terse alias

// ---- COMBAT ------------------------------------------------------------------
const power_strike = A({
  id: 'power_strike', name: '[Power Strike]', classKey: 'Warrior', tier: 1,
  header: { target: 'enemy', range: 2.6, cooldown: 5, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('damage', { amount: 46, tags: ['MELEE', 'FORCE'] })],
  grantsTags: ['ATTACK', 'MELEE', 'POWER'],
});

const lunge = A({
  id: 'lunge', name: '[Lunge]', classKey: 'Warrior', tier: 2,
  header: { target: 'enemy', range: 2.8, cooldown: 7, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('dash', { amount: 3.0 }),
    effect('damage', { amount: 34, tags: ['MELEE', 'PIERCE'] }),
  ],
  grantsTags: ['ATTACK', 'MELEE', 'MOBILITY'],
});

const whirlwind = A({
  id: 'whirlwind', name: '[Whirlwind]', classKey: 'Berserker', tier: 2,
  header: { target: 'enemy', range: 3.2, cooldown: 11, area: { kind: 'circle', r: 3.2 }, delivery: { kind: 'instant' } },
  effects: [
    effect('damage', { amount: 30, tags: ['MELEE', 'SWEEP'] }),
    effect('knockback', { amount: 1.6, when: 'on_hit' }),
  ],
  grantsTags: ['ATTACK', 'AOE', 'RECKLESS'],
});

const second_wind = A({
  id: 'second_wind', name: '[Second Wind]', classKey: 'Warrior', tier: 3,
  header: { target: 'self', range: 0, cooldown: 24, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('heal', { amount: 45, when: 'caster_hp_below', tags: ['RESTORE'] }),
    effect('shield', { amount: 25, dur: 6 }),
  ],
  grantsTags: ['DEFEND', 'SURVIVE', 'RESOLVE'],
});

const cleaving_blow = A({
  id: 'cleaving_blow', name: '[Cleaving Blow]', classKey: 'Berserker', tier: 1,
  header: { target: 'enemy', range: 2.8, cooldown: 6, area: { kind: 'cone', r: 2.8, deg: 100 }, delivery: { kind: 'instant' } },
  effects: [effect('damage', { amount: 38, tags: ['MELEE', 'CLEAVE'] })],
  grantsTags: ['ATTACK', 'AOE', 'MELEE'],
});

// ---- SOCIAL ------------------------------------------------------------------
const silver_tongue = A({
  id: 'silver_tongue', name: '[Silver Tongue]', classKey: 'Diplomat', tier: 1,
  header: { target: 'any', range: 6, cooldown: 12, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('plant_belief', { amount: -0.4, tags: ['CHARM', 'PERSUADE'] })],
  grantsTags: ['SOCIAL', 'PERSUADE', 'CHARM'],
});

const plant_rumor = A({
  id: 'plant_rumor', name: '[Plant Rumor]', classKey: 'Rogue', tier: 2,
  header: { target: 'any', range: 6, cooldown: 15, area: { kind: 'circle', r: 6 }, delivery: { kind: 'instant' } },
  effects: [effect('plant_belief', { amount: 0.5, tags: ['DECEIVE', 'INTRIGUE'] })],
  grantsTags: ['SOCIAL', 'DECEIVE', 'CUNNING'],
});

const read_mind = A({
  id: 'read_mind', name: '[Read the Room]', classKey: 'Rogue', tier: 1,
  header: { target: 'any', range: 7, cooldown: 10, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('scry', { amount: 0, tags: ['INSIGHT'] })],
  grantsTags: ['SOCIAL', 'INSIGHT', 'OBSERVE'],
});

// ---- ECONOMY -----------------------------------------------------------------
// economy abilities express as social/insight ops (no price hook in this engine);
// their real payoff is the tags they grant + the cast event the economy/quest
// systems can listen for. Magnitude carries the favour size.
const haggle = A({
  id: 'haggle', name: '[Haggle]', classKey: 'Merchant', tier: 1,
  header: { target: 'any', range: 5, cooldown: 8, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('plant_belief', { amount: -0.2, tags: ['BARTER', 'PROFIT'] })],
  grantsTags: ['TRADE', 'BARTER', 'PROFIT'],
});

const master_craft = A({
  id: 'master_craft', name: '[Master Craft]', classKey: 'Artisan', tier: 2,
  header: { target: 'self', range: 0, cooldown: 20, area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [effect('shield', { amount: 30, dur: 8, tags: ['CRAFT', 'TEMPER'] })],
  grantsTags: ['CRAFT', 'PRODUCE', 'MASTERY'],
});

const frost_bolt = A({
  id: 'frost_bolt', name: '[Frost Bolt]', classKey: 'Mage', tier: 1,
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
export const CLASS_MILESTONES = {
  Warrior:   { 1: 'power_strike', 4: 'lunge',         8: 'second_wind' },
  Berserker: { 1: 'cleaving_blow', 5: 'whirlwind' },
  Mage:      { 1: 'frost_bolt' },
  Rogue:     { 1: 'read_mind',    5: 'plant_rumor' },
  Diplomat:  { 2: 'silver_tongue' },
  Merchant:  { 1: 'haggle' },
  Artisan:   { 3: 'master_craft' },
};

// helper: the ability id (if any) a class unlocks at exactly `level`.
export function milestoneAt(classKey, level) {
  const m = CLASS_MILESTONES[classKey];
  return m ? m[level] || null : null;
}
