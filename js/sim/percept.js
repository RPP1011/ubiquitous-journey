// Percepts — the registry of WHAT AN AGENT CAN BELIEVE A THING TO BE.
//
// The epistemic split taken to its end: an agent never reads the world directly. It
// perceives PERCEPTS (anything with a body + an APPEARANCE) and forms BELIEFS about
// them; all decision AND execution then run off those beliefs. Reality is touched only
// by perception (truth → belief) and geometric combat resolution (blade → whatever body
// is actually there). So a belief can be WRONG — point at a thing that has moved, died,
// or was never a person at all — and nothing downstream fails, because nothing downstream
// assumes belief == reality.
//
// `PERCEPT_KIND` is the registry of true natures a perceivable thing can have. Crucially
// an agent CANNOT read this — it only ever sees an APPEARANCE (a faction + "looks like a
// person") and records that in its belief. A Scarecrow's true kind is SCARECROW, but it
// PROJECTS the appearance of a person, so an observer files a person-belief about it and
// acts on that — the canonical "mistake a scarecrow for a person" case.

import * as THREE from 'three';

export const PERCEPT_KIND = {
  PERSON:    'person',     // a living agent (the normal case — Agent.percept-shaped)
  SCARECROW: 'scarecrow',  // an inert decoy that LOOKS like a person but has no mind
  // A BUILDING is a perceivable PLACE — a finished home/tavern registered into sim.percepts
  // (Phase 2a, places-as-percepts). Like a Scarecrow it has NO `.agent`/`.mind`, so every
  // agent-only system skips it; perception only WRITES beliefs, so it files a PLACE-belief
  // (placeKind/sheltered). Crucially a building's `alive == sheltered`: a torched-but-standing
  // home advertises `alive=false`, so an owner walking home on a stale "intact" belief
  // DISCOVERS the loss by sight (the homecoming) rather than being told telepathically.
  BUILDING:  'building',
  // future: CORPSE, STATUE, ILLUSION, MIMIC … all just "appear as a person" to perception
};

// What an observer can perceive a thing AS — the appearance vocabulary a belief records.
// (Today an appearance is just a faction + the implicit "it's a person"; this is the hook
//  for richer mistaken-identity later, e.g. believing a friend is a foe.)
export function appearanceOf(thing) {
  // a disguise overrides true faction (intrigue); a prop projects its dressed faction.
  return thing.disguiseFaction || thing.faction || 'unknown';
}

// A SCARECROW: a perceivable, hittable PROP with no agent/mind. It has exactly the surface
// perception + combat touch — id, pos, alive, an appearance faction, a torso to land a
// blade on, and takeHit — but deliberately NO `.agent`, so every agent-only system (belief
// updates, progression, memory, epithets) skips it via its existing `!agent` guards. That
// absence is the whole test: an agent can hunt and strike it believing it a person, and not
// one system that assumes a real mind behind the body will fire or fault.
export class Scarecrow {
  constructor({ id, x, z, appearsAs = 'bandit', hp = 40 }) {
    this.id = id;
    this.kind = PERCEPT_KIND.SCARECROW;   // TRUE nature — unreadable by agents
    this.faction = appearsAs;             // the faction it's DRESSED as (what it appears to be)
    this.disguiseFaction = null;
    this.alive = true;
    this.hp = hp;
    this.combatant = false;
    this.controlled = false;              // never player-driven; the explicit guard perceive/gossip read
    this.agent = null;                    // ← NOT an agent. The tolerance test.
    this.pos = new THREE.Vector3(x, 0, z);
    this.root = { position: this.pos };   // perception/movement read `.pos`; some paths read `.root`
  }

  // --- the perceivable surface (read by perception, same shape as an Agent) ---
  // (perception reads .pos / .alive / .disguiseFaction || .faction / .id directly)

  // --- the hittable BODY surface (read by resolveCombat as a target) ---
  isHitActive() { return false; }                 // a scarecrow never swings
  torsoCenter(out) { return out.copy(this.pos).setY(1.0); }
  takeHit(_dmg) {                                  // absorb the blow; "die" (topple) at 0 hp
    this.hp -= (_dmg || 0);
    if (this.hp <= 0 && this.alive) { this.alive = false; return 'dead'; }
    return this.alive ? 'hit' : 'blocked';
  }
  update() { /* inert — no animation/state machine */ }
}
