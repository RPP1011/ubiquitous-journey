// Agent Theory-of-Mind intake — perception (sight → beliefs, folding terrain
// vision) and gossip (adopting a chatting ally's more-certain beliefs + the
// affinity it builds). Extracted from Agent as free functions over a passed
// agent instance. These read GROUND TRUTH of who is nearby but only ever WRITE
// to the agent's own BeliefStore — the epistemic split that lets deception work.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config + pure terrain helpers only.

import { terrainHeight, concealmentAt } from '../../arena.js';
import { SIM, SOURCE, BAND } from '../simconfig.js';

// perceive: sight of nearby agents writes high-confidence beliefs (the player
// is just another subject, so NPCs naturally form beliefs about you).
export function perceive(a, ctx) {
  if (!a.alive || a.controlled) return;
  // terrain shapes sight: high ground sees FARTHER, and a quarry hiding in
  // deep wood / a low vale is HARDER to spot. Effective range = base vision ×
  // a vantage gain (my elevation) × the target's concealment penalty. This is
  // the perception asymmetry that powers ambush + spy/disguise (beliefs only).
  const myH = terrainHeight(a.pos.x, a.pos.z);
  const vantage = 1 + Math.max(-0.2, Math.min(0.5, myH * SIM.vantagePerMeter));
  for (const o of ctx.agents) {
    if (o === a || !o.alive) continue;
    // HORIZONTAL distance: the whole sim reasons in x/z (terrain y is cosmetic
    // for the body); using 3D here would let a hill's elevation spuriously
    // "hide" an adjacent agent. Keep perception on the ground plane.
    const ddx = a.pos.x - o.pos.x, ddz = a.pos.z - o.pos.z;
    const d = Math.hypot(ddx, ddz);
    if (d > SIM.visionRange * vantage) continue;        // cheap reject first
    const cover = concealmentAt(o.pos.x, o.pos.z);      // 0..0.7
    const eff = SIM.visionRange * vantage * (1 - SIM.concealWeight * cover);
    if (d > eff) continue;                              // hidden by wood / low ground
    // DISGUISE (intrigue): record the PERCEIVED faction — a spy's cover identity
    // (o.disguiseFaction) if it wears one, else its true faction. This is the
    // epistemic split: beliefs hold the disguise, but ground-truth combat
    // (simulation.isHostile) reads o.faction, so a disguised raider that actually
    // strikes is still resolved as the enemy it truly is. Guarded: no disguise
    // field -> true faction, exactly as before.
    const seenFaction = o.disguiseFaction || o.faction;
    a.beliefs.observe(o.id, seenFaction, o.pos, ctx.time, false);
  }
}

// gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
export function gossipBeliefs(a, ctx) {
  if (!a.alive || a.controlled) return;
  for (const o of ctx.agents) {
    if (o === a || !o.alive || o.controlled) continue;
    if (a.pos.distanceTo(o.pos) > SIM.talkRange) continue;
    for (const b of o.beliefs.all()) {
      if (b.subjectId === a.id) continue;   // don't gossip about me to myself
      a.beliefs.mergeFrom(b, SOURCE.TALKED);
    }
    // chatting peacefully builds familiarity: a small positive standing toward
    // this neighbour. Emergent friendships — they seed social groups and surface
    // in the relations view. BUT a real grudge (negative standing) does NOT melt
    // just from proximity — you don't warm to someone you resent merely by standing
    // near them; that must be mended by an actual good turn (reconciliation). So
    // affinity only builds from a non-negative baseline, which lets economic slights
    // and gossip-borne grudges PERSIST (and the telephone game amplify them) instead
    // of being scrubbed away every tick (the bug that kept the town all-positive).
    const rel = a.beliefs.get(o.id);
    if (rel && !rel.hostile && rel.standing >= 0) rel.standing = Math.min(BAND.affinityCap, rel.standing + BAND.affinityGain);
    break;   // one conversation partner per tick
  }
}
