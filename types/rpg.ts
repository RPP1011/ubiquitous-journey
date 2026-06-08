// The RPG progression brain (js/rpg/progression.js + classes.js): the per-agent
// class/level/XP machine that folds deeds into a behavior_profile, matches class
// templates, and grants emergent classes + milestone abilities.

import type { AbilitySpec } from './abilities.js';
import type { ActionEvent, BehaviorProfile, Tag } from './events.js';

/** A named class identity defined by tag requirements + a weighted score (classes.js). */
export interface ClassTemplate {
  key: string;
  name: string;                          // the displayed [Bracketed] flavour name
  requirements: Array<[Tag, number]>;    // ALL must be met by the profile
  score_tags: Array<[Tag, number]>;      // the weighted-dot for the match
}

/** A granted class held on an agent (Progression.classes value). */
export interface ClassInstance {
  key: string;
  name: string;
  level: number;
  xp: number;
}

/** A newly-qualifying class returned by the matcher (classes.js matchClasses). */
export interface ClassGrant {
  key: string;
  name: string;
  score: number;
  template: ClassTemplate;
}

/** The significance multiplier bundle (js/rpg/xp.js significance output). */
export interface Significance {
  mult: number;
  comboKey: number | null;
  deedKey: string | null;
}

/** Per-verb XP attribution row (telemetry — js/rpg/xpstats.js). */
export interface VerbXp {
  verb: string;
  xp: number;
}

/** Per-class XP attribution row (telemetry). */
export interface ClassXp {
  classKey: string;
  xp: number;
}

/** The per-Agent progression machine (js/rpg/progression.js Progression). */
export interface Progression {
  agent: unknown;                        // back-ref to the owning Agent (circular; loose)
  behavior_profile: BehaviorProfile;
  classes: Map<string, ClassInstance>;
  abilities: Map<string, AbilitySpec>;
  cooldowns: Map<string, number>;        // abilityId -> sim-time usable again
  totalLevel: number;
  narrativeXp: number;
  narrativeBeats: number;

  onEvent(ev: ActionEvent, now: number): void;
  tick(now: number): void;
  addXP(amount: number, now?: number): void;
  addNarrativeXP(salience: number, now?: number, mult?: number): void;
  topClasses(n?: number): ClassInstance[];
  primaryClass(): ClassInstance | null;
  isReady(abilityId: string, now: number): boolean;
}
