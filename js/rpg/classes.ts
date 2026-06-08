// CLASS_TEMPLATES + the matcher. A template is a named identity defined by:
//   requirements : [[tag, threshold], ...]  — ALL must be met by the profile
//   score_tags   : [[tag, weight], ...]      — the weighted-dot for the match
// A class is granted when the behavior-sum gate passes AND every requirement is
// met AND sigmoid(weighted dot(profile, score_tags)) >= grant gate (see xp.js /
// progression.js for the gating). Names are bracketed in Wandering-Inn flavor.

import { sigmoid, RPG } from './rpgconfig.js';
import { comboKey } from './tags.js';
import type {
  ClassTemplate, ClassGrant, BehaviorProfile, Tag,
} from '../../types/sim.js';

// key is the stable identity (used as the Map key + CLASS_MILESTONES key);
// name is the displayed [Bracketed] flavor name.
export const CLASS_TEMPLATES: ClassTemplate[] = [
  { key: 'warrior',    name: '[Warrior]',
    requirements: [['MELEE', 6]],
    score_tags:   [['MELEE', 1.0], ['KILL', 0.8], ['DEFENSE', 0.4], ['RISK', 0.3]] },

  { key: 'brawler',    name: '[Brawler]',
    requirements: [['MELEE', 4], ['RISK', 3]],
    score_tags:   [['MELEE', 0.8], ['RISK', 1.0], ['BERSERK', 0.9], ['KILL', 0.4]] },

  { key: 'duelist',    name: '[Duelist]',
    requirements: [['DUEL', 4], ['DEFENSE', 3]],
    score_tags:   [['DUEL', 1.0], ['DEFENSE', 0.9], ['MELEE', 0.5], ['RISK', 0.2]] },

  { key: 'farmer',     name: '[Farmer]',
    requirements: [['FARMING', 6]],
    score_tags:   [['FARMING', 1.0], ['ENDURANCE', 0.3]] },

  { key: 'woodcutter', name: '[Woodcutter]',
    requirements: [['WOODCUT', 6]],
    score_tags:   [['WOODCUT', 1.0], ['ENDURANCE', 0.3]] },

  { key: 'miner',      name: '[Miner]',
    requirements: [['MINING', 6]],
    score_tags:   [['MINING', 1.0], ['ENDURANCE', 0.4]] },

  { key: 'blacksmith', name: '[Blacksmith]',
    requirements: [['SMITHING', 5]],
    score_tags:   [['SMITHING', 1.0], ['CRAFTING', 0.7], ['TOOLMAKING', 0.6]] },

  { key: 'merchant',   name: '[Merchant]',
    requirements: [['TRADE', 5]],
    score_tags:   [['TRADE', 1.0], ['PROFIT', 0.9], ['HAGGLE', 0.6], ['BARTER', 0.4]] },

  // [Mason] — earned by raising buildings (the Phase-1 construction deed emits
  // verb 'build' with tags BUILD/CRAFTING/ENDURANCE). A townsperson who builds
  // their own home (or pitches into the town tavern) grows into the trade.
  { key: 'mason',      name: '[Mason]',
    requirements: [['BUILD', 5]],
    score_tags:   [['BUILD', 1.0], ['CRAFTING', 0.6], ['ENDURANCE', 0.4]] },

  { key: 'speaker',    name: '[Speaker]',
    requirements: [['PERSUADE', 4]],
    score_tags:   [['PERSUADE', 1.0], ['LEAD', 0.7], ['CHARM', 0.6], ['GOSSIP', 0.4]] },

  { key: 'trickster',  name: '[Trickster]',
    requirements: [['DECEIVE', 4]],
    score_tags:   [['DECEIVE', 1.0], ['STEALTH', 0.7], ['CHARM', 0.5], ['GOSSIP', 0.4]] },

  { key: 'hunter',     name: '[Hunter]',
    requirements: [['EXPLORE', 4], ['KILL', 2]],
    score_tags:   [['EXPLORE', 0.8], ['KILL', 0.8], ['MELEE', 0.5], ['FORAGE', 0.4]] },

  { key: 'survivor',   name: '[Survivor]',
    requirements: [['ENDURANCE', 5]],
    score_tags:   [['ENDURANCE', 1.0], ['EXPLORE', 0.5], ['HEAL', 0.5], ['FLEE', 0.3]] },
];

// Fast lookup by key (used by Progression + milestone fallback).
export const CLASS_BY_KEY: Map<string, ClassTemplate> = new Map(
  CLASS_TEMPLATES.map((t) => [t.key, t]),
);

// Does the profile satisfy every requirement of a template?
export function meetsRequirements(profile: BehaviorProfile, template: ClassTemplate): boolean {
  for (const [tag, thresh] of template.requirements) {
    if ((profile[tag] || 0) < thresh) return false;
  }
  return true;
}

// weighted dot(profile, score_tags) -> sigmoid. This IS the class-match score
// (0..1); reused for both grant-gating and XP routing (see xp.js).
export function classMatchScore(profile: BehaviorProfile, template: ClassTemplate): number {
  let dot = 0;
  for (const [tag, w] of template.score_tags) dot += (profile[tag] || 0) * w;
  // center the logistic so a modest-but-clear profile lands above the gate
  return sigmoid(dot * 0.25 - 1.0);
}

// Sum of all behavior weight a profile carries (the cheap "have they done
// enough of anything yet?" gate before we bother matching).
export function behaviorSum(profile: BehaviorProfile): number {
  let s = 0;
  for (const k in profile) s += profile[k as Tag] || 0;
  return s;
}

// The matcher: given a profile and the set of class keys already held, return
// the templates that newly qualify, each with its match score, sorted best
// first. Pure — the caller (Progression) decides how many to actually grant
// (respecting maxClasses) and how to handle the procedural fallback.
export function matchClasses(
  profile: BehaviorProfile,
  heldKeys: Set<string> = new Set(),
): ClassGrant[] {
  if (behaviorSum(profile) <= RPG.behaviorSumGate) return [];
  const grants: ClassGrant[] = [];
  for (const t of CLASS_TEMPLATES) {
    if (heldKeys.has(t.key)) continue;
    if (!meetsRequirements(profile, t)) continue;
    const score = classMatchScore(profile, t);
    if (score >= RPG.sigmoidGrantGate) grants.push({ key: t.key, name: t.name, score, template: t });
  }
  grants.sort((a, b) => b.score - a.score);
  return grants;
}

// Procedural class generator: when behavior is strong but no template matches,
// mint an [Adjective Base] class from the profile's two dominant tags so the
// agent still gets a flavorful identity (spec's procedural fallback).
const PROC_ADJ: Record<string, string> = {
  MELEE: 'Iron', DEFENSE: 'Warded', KILL: 'Bloody', RISK: 'Reckless', BERSERK: 'Raging',
  DUEL: 'Poised', SMITHING: 'Forging', CRAFTING: 'Deft', TOOLMAKING: 'Tinkering',
  FARMING: 'Verdant', MINING: 'Deepdelving', WOODCUT: 'Timber', FORAGE: 'Wandering',
  TRADE: 'Coined', PROFIT: 'Gilded', HAGGLE: 'Sharp', BARTER: 'Trading',
  PERSUADE: 'Silver', GOSSIP: 'Whispering', DECEIVE: 'Veiled', LEAD: 'Banner', CHARM: 'Honeyed',
  ENDURANCE: 'Tireless', EXPLORE: 'Roaming', HEAL: 'Mending', WANDER: 'Drifting',
  HUNGER: 'Gaunt', FLEE: 'Fleet', STEALTH: 'Shadowed',
};
const PROC_BASE: Record<string, string> = {
  MELEE: 'Fighter', DEFENSE: 'Guardian', KILL: 'Slayer', RISK: 'Daredevil', BERSERK: 'Berserker',
  DUEL: 'Bladedancer', SMITHING: 'Smith', CRAFTING: 'Artisan', TOOLMAKING: 'Toolwright',
  FARMING: 'Tiller', MINING: 'Delver', WOODCUT: 'Logger', FORAGE: 'Gatherer',
  TRADE: 'Trader', PROFIT: 'Magnate', HAGGLE: 'Dealer', BARTER: 'Peddler',
  PERSUADE: 'Orator', GOSSIP: 'Rumormonger', DECEIVE: 'Deceiver', LEAD: 'Captain', CHARM: 'Charmer',
  ENDURANCE: 'Survivor', EXPLORE: 'Wayfarer', HEAL: 'Mender', WANDER: 'Vagabond',
  HUNGER: 'Scavenger', FLEE: 'Runner', STEALTH: 'Prowler',
};

function rankTags(profile: BehaviorProfile): string[] {
  return Object.keys(profile).sort(
    (a, b) => (profile[b as Tag] || 0) - (profile[a as Tag] || 0),
  );
}

export function proceduralName(profile: BehaviorProfile): string {
  const ranked = rankTags(profile);
  const top = ranked[0];
  const second = ranked[1] || top;
  const adj = PROC_ADJ[second] || PROC_ADJ[top] || 'Wandering';
  const base = PROC_BASE[top] || 'Adventurer';
  return `[${adj} ${base}]`;
}

// A stable key for a procedural class so it isn't re-minted every interval and
// can be looked up like a template key.
export function proceduralKey(profile: BehaviorProfile): string {
  return 'proc:' + comboKey(rankTags(profile).slice(0, 2));
}
