// Agent Theory-of-Mind intake — perception (sight → beliefs, folding terrain
// vision) and gossip (adopting a chatting ally's more-certain beliefs + the
// affinity it builds). Extracted from Agent as free functions over a passed
// agent instance. These read GROUND TRUTH of who is nearby but only ever WRITE
// to the agent's own BeliefStore — the epistemic split that lets deception work.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config + pure terrain helpers only.

import { terrainHeight, concealmentAt } from '../../arena.js';
import { inferDestination } from '../beliefs.js';
import { SIM, SOURCE, BAND, COMMODITIES, ECON, MAP, factionHostile } from '../simconfig.js';

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
  // PERCEIVABLES, not the bare roster: agents + inert PROPS (Scarecrows). A prop has the
  // same perceivable surface (.pos/.alive/.disguiseFaction||.faction/.id) so an observer
  // files a person-belief about it — the "mistake a scarecrow for a person" case. It has NO
  // .agent/.beliefs, but perception only WRITES to a.beliefs, so a mindless subject is fine.
  for (const o of (ctx.perceivables || ctx.agents)) {
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
    const b = a.beliefs.observe(o.id, seenFaction, o.pos, ctx.time, false);
    // believed PLAYER FAME: seeing the player (a controlled agent) records its true
    // notoriety into my belief, so the fear gate (decide.js) reads a believed scalar
    // rather than a live player handle. An NPC who never saw the player holds no belief
    // and so feels no dread. Truth-in / belief-out — the sanctioned bridge.
    if (o.controlled) b.notoriety = o.notoriety || 0;
  }
  // DESTINATION-INTENT: any tracked subject I am NO LONGER seeing — but still hold a
  // confident, freshly-stale belief about (just dropped below a full-confidence sighting)
  // and have NOT yet inferred a destination for — gets one inferred now from its last
  // heading + known geography. This is what lets a pursuer intercept a quarry that fled
  // out of sight toward an inferable place, with no omniscient roster read.
  inferLostQuarries(a, ctx);
}

// DESTINATION-INTENT upkeep for subjects I did NOT re-see this tick: for a still-confident
// stale belief with no destination yet, infer where the quarry is making for (so a pursuer
// can intercept). Re-acquisition by sight (observe) clears destPos. Belief-only + static
// geography; never reads truth. Guarded; never throws.
function inferLostQuarries(a, ctx) {
  try {
    const now = ctx.time, ttl = MAP.destTTL;
    for (const b of a.beliefs.all()) {
      if (b.subjectId === a.id) continue;
      // seen this very tick? observe() cleared destPos + destInferredAt, stamped lastTick=now → skip.
      if (b.lastTick === now) continue;
      if (b.confidence < SIM.actOnBeliefMin) continue;   // too faint to bother pursuing
      // TTL CACHE: a fresh inferred destination is TRUSTED; re-infer ONLY when it lapses
      // (or was invalidated by a re-sighting, which zeroed destInferredAt). A few dozen
      // tiny argmaxes/sec across the town, never a per-tick global anything.
      if (b.destPos && (now - b.destInferredAt) < ttl) continue;
      // intent from context: a quarry that's hostile to me (or that I, a combatant, am
      // hunting) is FLEEING (makes for an exit/cover); a monster/bandit is RAIDING (makes
      // for a crowd/the frontier); everyone else just drifts on its heading.
      const hostile = b.hostile || factionHostile(a.faction, b.lastFaction);
      const intent = (hostile || a.combatant) ? 'flee'
                   : (b.lastFaction === 'monster' || b.lastFaction === 'bandit') ? 'raid' : null;
      inferDestination(a, b, intent, ctx.map, now);
    }
  } catch { /* never throw on the tick */ }
}

// gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
export function gossipBeliefs(a, ctx) {
  if (!a.alive || a.controlled) return;
  for (const o of ctx.agents) {
    if (o === a || !o.alive || o.controlled) continue;
    // gossip iterates the REAL roster (never percepts), but guard defensively: a mindless
    // body has no .beliefs, and o.beliefs.all() on one would freeze the tick. Defence-in-depth.
    if (!o.beliefs) continue;
    if (a.pos.distanceTo(o.pos) > SIM.talkRange) continue;
    for (const b of o.beliefs.all()) {
      if (b.subjectId === a.id) continue;   // don't gossip about me to myself
      a.beliefs.mergeFrom(b, SOURCE.TALKED);
    }
    // RUMOURED PRICES: chatting also drifts my price beliefs toward this neighbour's —
    // how a price rumour spreads. This lives in the gossip BRIDGE (where reading another
    // agent's beliefs is sanctioned), not in cognition. Per fixed tick (step), scaled to
    // approximate the old per-frame drift (priceGossipPerTick). Beliefs only; bounded.
    if (!a.controlled && a.priceBeliefs && o.priceBeliefs) {
      const rate = ECON.priceGossipPerTick != null ? ECON.priceGossipPerTick : (ECON.priceGossip * 10);
      for (const c of COMMODITIES) {
        a.priceBeliefs[c] += (o.priceBeliefs[c] - a.priceBeliefs[c]) * rate;
      }
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
