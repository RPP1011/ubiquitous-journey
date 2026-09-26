// The declared action: a closed, data-only vocabulary every combatant (player, companion,
// ally, foe) declares from. Write-in text is PARSED into one of these — the text never sets a
// magnitude; the rules table does. That is the trust boundary for free-text input, the same
// way ir.validate() is the trust boundary for abilities.

import type { Stat } from './rules.js';

export type EntityRef = number | string;

export const VERBS = [
  'strike', 'ability', 'defend', 'guard', 'shove', 'trip', 'feint',
  'bluff', 'intimidate', 'taunt', 'rally', 'aid', 'improvise', 'flee', 'parley',
] as const;
export type CombatVerb = typeof VERBS[number];

/** What a bluff claims. Each claim reads the listener's OWN beliefs to set its difficulty. */
export const CLAIMS = ['look_behind', 'reinforcements', 'turncoat', 'surrender_terms'] as const;
export type Claim = typeof CLAIMS[number];

export interface Intent {
  verb: CombatVerb;
  targetId?: EntityRef;          // foe for hostile verbs, ally for guard/aid
  abilityId?: string;            // verb 'ability'
  claim?: Claim;                 // verb 'bluff'
  subjectId?: EntityRef;         // bluff 'turncoat': who the listener is told is a traitor
  /** Write-in flavour kept for narration + novelty ("kick the brazier") — never read for magnitude. */
  flourish?: string;
  /** The raw text the player typed, if any (logged, never re-parsed during resolution). */
  text?: string;
}

/** Which verbs need a target, and which side it must be on. */
export const TARGETING: Record<CombatVerb, 'foe' | 'ally' | 'self' | 'none' | 'foe?'> = {
  strike: 'foe', ability: 'foe?', defend: 'self', guard: 'ally', shove: 'foe', trip: 'foe',
  feint: 'foe', bluff: 'foe', intimidate: 'foe', taunt: 'foe', rally: 'none', aid: 'ally',
  improvise: 'foe', flee: 'none', parley: 'none',
};

/** The stat a verb is checked on (the rules pick the DC). */
export const VERB_STAT: Record<CombatVerb, Stat | null> = {
  strike: 'might', ability: null, defend: null, guard: null, shove: 'might', trip: 'finesse',
  feint: 'finesse', bluff: 'presence', intimidate: 'presence', taunt: 'presence',
  rally: 'presence', aid: 'finesse', improvise: 'finesse', flee: 'finesse', parley: 'presence',
};

export const VERB_LABEL: Record<CombatVerb, string> = {
  strike: 'Strike', ability: 'Ability', defend: 'Defend', guard: 'Guard', shove: 'Shove',
  trip: 'Trip', feint: 'Feint', bluff: 'Bluff', intimidate: 'Intimidate', taunt: 'Taunt',
  rally: 'Rally', aid: 'Aid', improvise: 'Improvise', flee: 'Flee', parley: 'Parley',
};

/** Structural validation against the closed vocabulary. The encounter re-checks ids/sides. */
export function validateIntent(x: unknown): x is Intent {
  if (!x || typeof x !== 'object') return false;
  const i = x as Intent;
  if (!(VERBS as readonly string[]).includes(i.verb)) return false;
  if (i.claim != null && !(CLAIMS as readonly string[]).includes(i.claim)) return false;
  if (i.verb === 'ability' && typeof i.abilityId !== 'string') return false;
  if (i.flourish != null && (typeof i.flourish !== 'string' || i.flourish.length > 120)) return false;
  return true;
}
