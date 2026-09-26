// Tabletop combat rules: the tuning block, the dice, and the stat derivation.
//
// Stats are DERIVED from what the engine already tracks (class level, the behaviour-tag
// profile, personality, mood) — an agent who has spent its life brawling has Might, a
// schemer has Presence. Nothing here is stored; a combatant's sheet is recomputed at the
// start of each encounter, so progression outside combat is reflected immediately.

import { rng } from '../../sim/rng.js';
import { TUNE } from '../../constants.js';
import type { Agent } from '../../../types/sim.js';

export const COMBAT = {
  roundSec: 3,            // sim-seconds the world advances per resolved round
  playbackSec: 1.1,       // real seconds the frontend spends playing a round back
  engageRadius: 7,        // player-to-foe distance that opens an encounter
  joinRadius: 16,         // bystanders this close to the fight may join at a round boundary
  leaveRadius: 30,        // a member this far from the fight's centre has left it
  baseDefense: 10,
  defendBonus: 4,
  guardBonus: 3,
  damageBase: TUNE.damage,          // a plain hit, before Might
  critMul: 1.5,
  exposeMul: 1.5,
  playerEdge: 2,          // the protagonist's flat bonus to every check (combatlab: +1 lost ~half of even duels; +2 ≈ 70–75% wins, ~5 rounds)
  novelBonus: 2,          // "rule of cool": the first use of a new write-in trick in a fight
  staleTrickPenalty: 2,   // …and repeating it becomes predictable
  moraleDC: 11,
  moraleBreakHp: 0.35,    // below this HP fraction a combatant tests its nerve each round
  highStakes: {
    playerHp: 0.45,       // the player is badly hurt
    companionHp: 0.35,    // a companion is about to fall
    odds: 1.3,            // the other side's believed strength exceeds ours by this ratio
    namedFoe: true,       // a foe with an epithet (a nemesis, a champion)
  },
  allyJoin: {
    courage: 0.5,         // minimum nerve score (risk_tolerance-driven) to wade in
    fondness: 0.2,        // standing toward the player's side that counts as "on our side"
  },
  maxRounds: 30,          // hard stop (the freeze lesson: nothing unbounded)
};

export type Stat = 'might' | 'finesse' | 'presence' | 'nerve';

export interface Sheet {
  might: number;
  finesse: number;
  presence: number;
  nerve: number;
  level: number;
}

/** A d20 roll from the shared deterministic stream. */
export function d20(): number { return 1 + Math.floor(rng() * 20); }

/** Chance a d20 + mod meets dc (for the preview chip; nat 20 always hits, nat 1 always misses). */
export function chance(mod: number, dc: number): number {
  const need = dc - mod;                 // minimum face that succeeds
  const faces = Math.max(1, Math.min(19, 21 - need));
  return faces / 20;
}

export interface Check { roll: number; total: number; dc: number; ok: boolean; crit: boolean; fumble: boolean; }

export function check(mod: number, dc: number): Check {
  const roll = d20();
  const total = roll + mod;
  const crit = roll === 20, fumble = roll === 1;
  return { roll, total, dc, ok: crit || (!fumble && total >= dc), crit, fumble };
}

const TAGS: Record<Exclude<Stat, 'nerve'>, string[]> = {
  might: ['MELEE', 'BERSERK', 'KILL', 'DUEL', 'RISK'],
  finesse: ['DEFENSE', 'STEALTH', 'FLEE', 'EXPLORE', 'WANDER'],
  presence: ['PERSUADE', 'CHARM', 'DECEIVE', 'LEAD', 'GOSSIP'],
};

function share(profile: Record<string, number> | undefined, tags: string[]): number {
  if (!profile) return 0;
  let total = 0, hit = 0;
  for (const k in profile) { const v = profile[k] || 0; total += v; if (tags.includes(k)) hit += v; }
  return total > 0 ? hit / total : 0;
}

/** Derive a combat sheet from engine state. Guarded for professionless/stub agents (freeze lesson). */
export function sheetOf(a: Agent): Sheet {
  const prog = (a as { progression?: { totalLevel?: number; behavior_profile?: Record<string, number> } }).progression;
  const level = (prog && prog.totalLevel) || 0;
  const prof = prog && prog.behavior_profile;
  const P = (a.personality || {}) as Record<string, number>;
  const fear = (a.mood && a.mood.fear) || 0;
  const monster = a.faction === 'monster';
  const edge = a.controlled ? COMBAT.playerEdge : 0;
  const lv = Math.min(level, 30);
  return {
    level,
    might: Math.round(1 + lv / 5 + share(prof, TAGS.might) * 4 + (monster ? 1 : 0) + (a.combatant ? 1 : 0)) + edge,
    finesse: Math.round(1 + lv / 7 + share(prof, TAGS.finesse) * 4) + edge,
    presence: Math.round(lv / 7 + share(prof, TAGS.presence) * 5 + (P.social_drive || 0) * 2) + edge,
    nerve: Math.round((P.risk_tolerance ?? 0.5) * 5 + lv / 6 - fear * 3 + (monster ? 2 : 0)) + edge,
  };
}
