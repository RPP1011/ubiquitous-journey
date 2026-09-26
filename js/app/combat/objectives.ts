// What an NPC is fighting FOR. Derived fresh each round from the agent's own engine state —
// ambition, vendettas, duty, faction appetite, bonds, personality, mood — never from truth
// about anyone else. The utility AI (ai.ts) scores every action against this objective, so a
// bandit goes for your purse and runs, an avenger ignores everyone but its quarry, a watchman
// tries to END the fight, and a glory-hound seeks out the strongest blade on the field.

import type { Agent } from '../../../types/sim.js';
type EntityRef = number | string;

export type ObjectiveKind =
  | 'avenge'    // kill one specific foe (a vendetta, a duel, a hunted killer); nothing else matters
  | 'rob'       // take a purse and get away with it
  | 'capture'   // beat a foe down and take them alive (raiders, rivals)
  | 'feed'      // a beast: bring down the weakest, then drag it off
  | 'enforce'   // the Watch: stop the fight — subdue the one it believes started it
  | 'protect'   // keep a ward alive (a companion's leader, a parent's child, a friend)
  | 'glory'     // renown: beat the most dangerous foe, and be seen doing it
  | 'survive'   // get out alive (the timid, the broken)
  | 'win';      // plain: see the other side off

export interface Objective {
  kind: ObjectiveKind;
  targetId?: EntityRef;   // who it is about (the quarry, the mark)
  wardId?: EntityRef;     // protect: who it is keeping alive
  label: string;          // how an onlooker would read it ("wants your purse")
}

/** The minimal view of the fight the objective reader needs (ids + sides, no live truth). */
export interface FightView {
  selfId: EntityRef;
  foes: ReadonlyArray<{ id: EntityRef; name: string; controlled: boolean }>;
  friends: ReadonlyArray<{ id: EntityRef; name: string; controlled: boolean }>;
  playerId: EntityRef | null;
  isCompanion: boolean;
}

const CAPTORS = ['rival'];

export function objectiveOf(a: Agent, v: FightView): Objective {
  const P = (a.personality || {}) as Record<string, number>;
  const foe = (id: unknown) => v.foes.find((f) => f.id === id);
  const fear = (a.mood && a.mood.fear) || 0;
  const nameOf = (id: unknown) => { const f = v.foes.find((x) => x.id === id); return f ? (f.controlled ? 'you' : f.name) : 'someone'; };

  // a sworn quarry on the field eclipses everything
  // (a sworn avenger, a duellist, or one already hunting a foe it bears a deep grudge against)
  const hunted = a.goal && a.goal.kind === 'fight' ? a.goal.targetId : null;
  const grudge = hunted != null && (a.beliefs.get(hunted)?.standing ?? 0) < -0.7 ? hunted : null;
  const quarryId = [a.avengerOf, a._duelWith, grudge]
    .find((id) => id != null && foe(id));
  if (quarryId != null) return { kind: 'avenge', targetId: quarryId, label: `is here for ${nameOf(quarryId)} alone` };

  // the timid and the terrified want out
  if ((!a.combatant && (P.risk_tolerance ?? 0.5) < 0.3) || fear > 0.75) return { kind: 'survive', label: 'wants out alive' };

  // duty: a watchman ends fights; it goes for whoever it BELIEVES is the aggressor
  if ((a as { watch?: boolean }).watch) {
    const culprit = v.foes.map((f) => ({ f, b: a.beliefs.get(f.id) }))
      .sort((x, y) => ((y.b?.suspicion || 0) - (y.b?.standing || 0)) - ((x.b?.suspicion || 0) - (x.b?.standing || 0)))[0];
    return { kind: 'enforce', targetId: culprit?.f.id, label: culprit ? `means to arrest ${nameOf(culprit.f.id)}` : 'means to end this' };
  }

  // appetite by faction
  if (a.faction === 'monster') {
    return { kind: 'feed', label: 'is hungry' };
  }
  if (a.faction === 'bandit') {
    // the mark: whoever it believes is richest
    const mark = v.foes.map((f) => ({ f, w: a.beliefs.get(f.id)?.believedWealth ?? 0.3 })).sort((x, y) => y.w - x.w)[0];
    return { kind: 'rob', targetId: mark?.f.id, label: mark ? `is after ${mark.f.controlled ? 'your' : mark.f.name + "'s"} purse` : 'wants loot' };
  }
  if (CAPTORS.includes(a.faction)) {
    const mark = v.foes[0];
    return { kind: 'capture', targetId: mark?.id, label: mark ? `wants ${nameOf(mark.id)} alive` : 'takes prisoners' };
  }
  // a poor, bold, uncaring townsperson in a brawl sees an opportunity
  if (a.townsperson && (a.gold || 0) < 8 && (P.risk_tolerance ?? 0.5) > 0.6 && (P.altruism ?? 0.5) < 0.35) {
    const mark = v.foes.map((f) => ({ f, w: a.beliefs.get(f.id)?.believedWealth ?? 0.3 })).sort((x, y) => y.w - x.w)[0];
    if (mark) return { kind: 'rob', targetId: mark.f.id, label: `eyes ${mark.f.controlled ? 'your' : mark.f.name + "'s"} purse` };
  }

  // bonds: a companion guards its leader; the caring guard the most loved friend on the field
  if (v.isCompanion && v.playerId != null && v.friends.some((f) => f.id === v.playerId) && (P.altruism ?? 0.5) >= 0.4) {
    return { kind: 'protect', wardId: v.playerId, label: 'is watching your back' };
  }
  if ((P.altruism ?? 0.5) > 0.65) {
    const ward = v.friends.filter((f) => f.id !== v.selfId).map((f) => ({ f, s: a.beliefs.get(f.id)?.standing ?? 0 }))
      .sort((x, y) => y.s - x.s)[0];
    if (ward && ward.s > 0.3) return { kind: 'protect', wardId: ward.f.id, label: `is shielding ${ward.f.controlled ? 'you' : ward.f.name}` };
  }

  // renown: find the most dangerous blade it believes is here
  if (a.ambition && a.ambition.kind === 'renown') {
    const champ = v.foes.map((f) => ({ f, t: a.beliefs.get(f.id)?.believedThreat ?? 0 })).sort((x, y) => y.t - x.t)[0];
    return { kind: 'glory', targetId: champ?.f.id, label: champ ? `wants to be the one who beats ${nameOf(champ.f.id)}` : 'wants glory' };
  }

  return { kind: 'win', label: 'fights to win' };
}
