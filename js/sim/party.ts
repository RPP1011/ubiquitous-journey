// Party: a BAND of companions following a leader. A member is an ordinary Agent
// flipped into "follow + fight alongside the leader" mode. We don't fork the AI —
// recruitment just sets flags the existing Agent.decide / Agent.act already branch
// on (goal 'follow', combatant=true). Recruiting/dismissing happen through dialogue
// ([Join my party] / [Dismiss]); this class only owns the roster + the flag
// bookkeeping so it can be cleanly undone.
//
// THE LEADER IS NOT THE PLAYER BY CONSTRUCTION. The leader is whatever Agent was
// passed to the constructor (player OR NPC). The player's party is simply "the band
// whose leader happens to be the controlled agent" — the player is special ONLY for
// input; the band machinery treats every leader identically. The recruit standing
// gate reads the player-only reputation ledger when the leader IS the player
// (preserving the dialogue gate); for an NPC leader the would-be member's OWN
// belief-standing toward the leader is the gate (the epistemic, no-roster cue).

import { PARTY } from './simconfig.js';
import { bus, makeEvent } from '../rpg/events.js';

// `sim` (the owning Simulation — a separate, wave-2 cluster still in .js) and the party
// MEMBERS + leader (Agents, via the long-tail party flags they branch on) are typed
// opaquely on purpose. Behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

export class Party {
  sim: Sim;
  members: Ag[];
  _leaderAgent: Ag;

  // The leader defaults to sim.player ONLY as a back-compat convenience for the
  // player-led party (its single call site passes nothing). Any band — NPC-led
  // included — passes its own leader Agent. No leader is special; the player is just
  // the one whose leader is the controlled agent.
  constructor(sim: Sim, leader?: Ag) {
    this.sim = sim;
    this.members = [];     // Agents, ordered — index drives the follow-ring slot
    this._leaderAgent = (leader !== undefined) ? leader : (sim ? sim.player : null);
  }

  get leader(): Ag { return this._leaderAgent || (this.sim ? this.sim.player : null); }
  get leaderId(): unknown { const L = this.leader; return L ? L.id : null; }
  // Is this band the controlled player's? Only used by callers that genuinely need
  // the input distinction (HUD, dialogue) — never by the band machinery itself.
  get isPlayerLed(): boolean { const L = this.leader; return !!(L && L.controlled); }
  get size(): number { return this.members.length; }
  has(a: Ag): boolean { return this.members.includes(a); }
  isFull(): boolean { return this.members.length >= PARTY.maxSize; }

  // Would this NPC agree to join right now? Townsfolk only, must be alive, not the
  // leader itself, not already recruited, party not full, and it has to actually like
  // the leader. For a player-led band the standing is read off the player-only
  // reputation ledger (the dialogue gate); for an NPC-led band there is no such ledger,
  // so the candidate's OWN belief-standing toward the leader is the cue (epistemic).
  canRecruit(a: Ag): boolean {
    if (!a || !a.alive || a.controlled || this.has(a)) return false;
    if (a.faction === 'monster') return false;
    const L = this.leader;
    if (!L || a === L) return false;
    if (this.isFull()) return false;
    const standing = this.isPlayerLed
      ? (this.sim.reputation ? this.sim.reputation.standing(a) : 0)
      : (a.beliefs && a.beliefs.get(L.id) ? (a.beliefs.get(L.id).standing || 0) : 0);
    return standing >= PARTY.recruitStanding;
  }

  // Flip an NPC into a follower of THIS band's leader. Reversible: we stash what we
  // overwrote so dismiss() can restore the agent to an ordinary townsperson.
  recruit(a: Ag): boolean {
    if (!this.canRecruit(a)) return false;
    const L = this.leader;
    a.inParty = true;
    a._partyRestore = { combatant: a.combatant, goal: a.goal };
    a.combatant = true;                 // companions hold the line, never flee
    a.partySlot = this.members.length;
    a.goal = { kind: 'follow' };
    a.bandLeaderId = L.id;              // the band is a warband led by this leader
    a.groupType = 'warband';
    if (L && L.groupType == null) L.groupType = 'warband';   // tag the anchor (UI/relations)
    this.members.push(a);
    bus.emit(makeEvent({ actorId: a.id, verb: 'recruited', tags: [], magnitude: 1, t: this.sim.time }));
    return true;
  }

  dismiss(a: Ag): boolean {
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
  prune(): boolean {
    let changed = false;
    for (const a of [...this.members]) {
      if (!a.alive) { this.dismiss(a); changed = true; }
    }
    return changed;
  }

  _reslot(): void { this.members.forEach((m, i) => (m.partySlot = i)); }

  // Tear the whole party down (world rebuild). Restores every member first.
  disband(): void { for (const a of [...this.members]) this.dismiss(a); }
}
