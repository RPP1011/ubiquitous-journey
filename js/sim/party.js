// Party: the companions the player has recruited. The player is the leader; a
// member is an ordinary Agent flipped into "follow + fight alongside you" mode.
// We don't fork the AI — recruitment just sets flags the existing Agent.decide /
// Agent.act already branch on (goal 'follow', combatant=true). Recruiting and
// dismissing happen through dialogue ([Join my party] / [Dismiss]); this class
// only owns the roster + the flag bookkeeping so it can be cleanly undone.

import { PARTY } from './simconfig.js';
import { bus, makeEvent } from '../rpg/events.js';

export class Party {
  constructor(sim) {
    this.sim = sim;
    this.members = [];     // Agents, ordered — index drives the follow-ring slot
  }

  get leader() { return this.sim.player; }
  get size() { return this.members.length; }
  has(a) { return this.members.includes(a); }
  isFull() { return this.members.length >= PARTY.maxSize; }

  // Would this NPC agree to join right now? Townsfolk only, must be alive, not
  // already recruited, party not full, and it has to actually like the player.
  canRecruit(a) {
    if (!a || !a.alive || a.controlled || this.has(a)) return false;
    if (a.faction === 'monster') return false;
    if (this.isFull()) return false;
    const standing = this.sim.reputation ? this.sim.reputation.standing(a) : 0;
    return standing >= PARTY.recruitStanding;
  }

  // Flip an NPC into a follower. Reversible: we stash what we overwrote so
  // dismiss() can restore the agent to an ordinary townsperson.
  recruit(a) {
    if (!this.canRecruit(a)) return false;
    a.inParty = true;
    a._partyRestore = { combatant: a.combatant, goal: a.goal };
    a.combatant = true;                 // companions hold the line, never flee
    a.partySlot = this.members.length;
    a.goal = { kind: 'follow' };
    a.bandLeaderId = this.sim.player.id; // the player's party is a warband led by you
    a.groupType = 'warband';
    this.members.push(a);
    bus.emit(makeEvent({ actorId: a.id, verb: 'recruited', tags: [], magnitude: 1, t: this.sim.time }));
    return true;
  }

  dismiss(a) {
    if (!this.has(a)) return false;
    a.inParty = false;
    a.bandLeaderId = null;
    a.groupType = null;
    if (a._partyRestore) {
      a.combatant = a._partyRestore.combatant;
      a._partyRestore = null;
    }
    a.goal = { kind: a.canWork ? 'work' : 'wander' };
    this.members = this.members.filter((m) => m !== a);
    this._reslot();
    bus.emit(makeEvent({ actorId: a.id, verb: 'dismissed', tags: [], magnitude: 1, t: this.sim.time }));
    return true;
  }

  // Drop anyone who died (their corpse stays in the world; they just leave the
  // roster). Called every frame from the sim so the HUD + slots stay honest.
  prune() {
    let changed = false;
    for (const a of [...this.members]) {
      if (!a.alive) { this.dismiss(a); changed = true; }
    }
    return changed;
  }

  _reslot() { this.members.forEach((m, i) => (m.partySlot = i)); }

  // Tear the whole party down (world rebuild). Restores every member first.
  disband() { for (const a of [...this.members]) this.dismiss(a); }
}
