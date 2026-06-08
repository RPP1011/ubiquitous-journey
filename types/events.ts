// The RPG event spine (js/rpg/events.js + js/rpg/tags.js). Every meaningful deed is
// published as an ActionEvent; Progression accumulates the tags into a behavior_profile.

import type { EntityId } from './core.js';

/** The CLOSED, frozen behaviour-tag vocabulary (js/rpg/tags.js TAGS). Keys of a profile. */
export type Tag =
  // combat
  | 'MELEE' | 'DEFENSE' | 'KILL' | 'RISK' | 'BERSERK' | 'DUEL'
  // craft
  | 'SMITHING' | 'CRAFTING' | 'TOOLMAKING'
  // gather
  | 'FARMING' | 'MINING' | 'WOODCUT' | 'FORAGE'
  // trade
  | 'TRADE' | 'PROFIT' | 'HAGGLE' | 'BARTER'
  // social
  | 'PERSUADE' | 'GOSSIP' | 'DECEIVE' | 'LEAD' | 'CHARM'
  // survival
  | 'ENDURANCE' | 'EXPLORE' | 'HEAL' | 'WANDER' | 'HUNGER' | 'FLEE' | 'STEALTH';

/** Known deed verbs; OPEN so any string is accepted while the known set autocompletes. */
type KnownVerb =
  | 'level' | 'class_gained' | 'ability_gained' | 'cast' | 'strike' | 'kill'
  | 'block' | 'buy' | 'sell' | 'forge' | 'produce' | 'gather' | 'build' | 'narrative';
export type Verb = KnownVerb | (string & {});

/** A published deed (js/rpg/events.js makeEvent output). */
export interface ActionEvent {
  actorId: EntityId;
  verb: Verb;
  tags: Tag[];
  magnitude: number;
  targetId?: EntityId;
  t: number;
}

/** The spec accepted by makeEvent/emit (tags un-sanitized, magnitude/t defaulted). */
export interface ActionEventSpec {
  actorId: EntityId;
  verb: Verb;
  tags?: string[];
  magnitude?: number;
  targetId?: EntityId;
  t?: number;
}

/** The single shared synchronous fan-out bus (js/rpg/events.js EventBus). */
export interface EventBus {
  on(fn: (ev: ActionEvent) => void): () => void;   // returns an unsubscribe fn
  off(fn: (ev: ActionEvent) => void): void;
  emit(ev: ActionEvent): void;
  clear(): void;
}

/** Weighted tag tallies (Progression.behavior_profile). */
export type BehaviorProfile = Partial<Record<Tag, number>>;
