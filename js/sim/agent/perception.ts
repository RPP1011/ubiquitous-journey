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
import { PERCEPT_KIND } from '../percept.js';
import { STAGE, REASON } from '../trace.js';
import type { Agent, FullCtx, Perceivable } from '../../../types/sim.js';
import type { Vector3 } from 'three';
import type { EntityId, Stage, Reason } from '../../../types/sim.js';

// trace.js infers STAGE/REASON members as plain `string`; their values ARE the literal
// Stage/Reason codes, so retype them for Trace.note's typed params.
const STAGE_T = STAGE as Record<string, Stage>;
const REASON_T = REASON as Record<string, Reason>;

// The perceivable SURFACE perception reads (truth-in side of the bridge). A union of the
// agent + percept fields it touches; the building-percept extras (kind/ownerId/buildKind/
// benefitKind) are optional because a person/agent carries none. Reading these is the
// sanctioned allowlisted appearance-read — never the subject's mind.
interface PerceivedThing {
  id: EntityId;
  pos: Vector3;
  alive: boolean;
  faction: string;
  disguiseFaction?: string | null;
  controlled?: boolean;
  notoriety?: number;
  kind?: string;
  ownerId?: EntityId;
  buildKind?: string;
  benefitKind?: string;
}
const asThing = (o: Perceivable): PerceivedThing => o as unknown as PerceivedThing;

// perceive: sight of nearby agents writes high-confidence beliefs (the player
// is just another subject, so NPCs naturally form beliefs about you).
export function perceive(a: Agent, ctx: FullCtx): void {
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
  for (const raw of (ctx.perceivables || ctx.agents)) {
    if (raw === a) continue;
    const o = asThing(raw);
    // A BUILDING percept's `alive` encodes its SHELTER state, NOT whether it EXISTS — a
    // torched-but-standing home reads alive=false yet must still be PERCEIVABLE so its owner can
    // DISCOVER the ruin by sight (the homecoming). A gutted building is removed via despawnPercept,
    // so a present BUILDING is always worth perceiving. Every OTHER perceivable (a person/prop) is
    // skipped when not alive, exactly as before — a corpse/toppled prop forms no fresh belief.
    if (o.kind !== PERCEPT_KIND.BUILDING && !o.alive) continue;
    // HORIZONTAL distance: the whole sim reasons in x/z (terrain y is cosmetic
    // for the body); using 3D here would let a hill's elevation spuriously
    // "hide" an adjacent agent. Keep perception on the ground plane.
    const ddx = a.pos.x - o.pos.x, ddz = a.pos.z - o.pos.z;
    const d = Math.hypot(ddx, ddz);
    if (d > SIM.visionRange * vantage) continue;        // cheap reject first
    const cover = concealmentAt(o.pos.x, o.pos.z);      // 0..0.7
    const eff = SIM.visionRange * vantage * (1 - SIM.concealWeight * cover);
    if (d > eff) continue;                              // hidden by wood / low ground
    // PLACES-AS-PERCEPTS (Phase 2a): a finished building is a perceivable PLACE, not a person.
    // I file a PLACE-belief (placeKind + believed `sheltered` = its perceivable alive state),
    // NOT a person-belief — so it never enters the hostile/social/pursuit reasoning. If this
    // is MY OWN home I learn that fact here (homeBeliefId) — discovering my home BY SIGHT, and
    // discovering its LOSS the same way (the homecoming). A building has no .agent/.mind, so
    // perception only WRITES my belief — nothing downstream assumes a mind behind it.
    if (o.kind === PERCEPT_KIND.BUILDING) { perceiveBuilding(a, o, ctx); continue; }
    // DISGUISE (intrigue): record the PERCEIVED faction — a spy's cover identity
    // (o.disguiseFaction) if it wears one, else its true faction. This is the
    // epistemic split: beliefs hold the disguise, but ground-truth combat
    // (simulation.isHostile) reads o.faction, so a disguised raider that actually
    // strikes is still resolved as the enemy it truly is. Guarded: no disguise
    // field -> true faction, exactly as before.
    const seenFaction = o.disguiseFaction || o.faction;
    // ANIMACY (observed motion): capture my PRIOR belief BEFORE observe() overwrites its
    // lastPos, so I can tell whether the subject MOVED since I last saw it. Gated by a
    // displacement threshold AND a recency guard (prior seen on the IMMEDIATELY-preceding
    // tick) so a stale belief re-acquired after eviction+recreate does NOT register its big
    // lastPos jump as "motion" — an inert prop evicted then re-perceived stays inert, while
    // a real subject seen continuously animates. A Scarecrow never moves → never accrues.
    const prior = a.beliefs.get(o.id);
    const tickDt = 1 / SIM.tickHz;
    const movedAlive = !!(prior && prior.lastPos &&
      Math.abs(prior.lastTick - (ctx.time - tickDt)) < tickDt * 0.5 &&
      prior.lastPos.distanceToSquared(o.pos) > (SIM.moveEvidenceEps || 0.04));
    const b = a.beliefs.observe(o.id, seenFaction, o.pos, ctx.time, false);
    if (movedAlive) b.recordAnimacy('moved');   // (runtime ignores a 2nd `now` arg)
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

// Perceive a BUILDING percept (Phase 2a, places-as-percepts): write a PLACE-belief into my own
// store recording what KIND of place it is (home/tavern/building) and its believed SHELTER
// state (= the percept's perceivable `alive`, which construction sets to its shelter). This is
// truth-in / belief-out (the sanctioned bridge): perception READS the percept's surface and
// WRITES only my belief. If it is MY home I bind homeBeliefId (discover my home by sight); and
// if a previously-intact home-belief flips to sheltered=false I file a `home_lost` episode WHEN
// LEARNED (not when it burned). Guarded; never throws. `o.ownerId === a.id` compares my own id
// to a percept surface field (allowlisted, like reading o.faction).
function perceiveBuilding(a: Agent, o: PerceivedThing, ctx: FullCtx): void {
  try {
    const bb = a.beliefs.observe(o.id, 'unknown', o.pos, ctx.time, false);
    // classify the place (home if it's mine, else tavern if dressed as one, else a building).
    bb.placeKind = (o.ownerId === a.id) ? 'home'
      : ((o.buildKind === 'tavern' || o.benefitKind === 'tavern') ? 'tavern' : 'building');
    const wasSheltered = bb.sheltered;
    bb.sheltered = (o.alive !== false);                 // believed shelter = perceivable liveness
    // discover MY OWN home by sight: bind the home-belief id the first time I lay eyes on it.
    if (o.ownerId === a.id) {
      if (a.homeBeliefId == null) a.homeBeliefId = o.id;
      // LEARNED the loss: a home I believed intact is now perceived razed → file the episode
      // WHEN LEARNED (the homecoming), not when it burned. Best-effort flavour memory.
      if (a.homeBeliefId === o.id && wasSheltered === true && bb.sheltered === false && a.memory) {
        a.memory.record({ t: ctx.time, kind: 'home_lost', place: 'home', withId: a.id, valence: -1, salience: 0.7 });
      }
    }
  } catch { /* never throw on the tick */ }
}

// DESTINATION-INTENT upkeep for subjects I did NOT re-see this tick: for a still-confident
// stale belief with no destination yet, infer where the quarry is making for (so a pursuer
// can intercept). Re-acquisition by sight (observe) clears destPos. Belief-only + static
// geography; never reads truth. Guarded; never throws.
function inferLostQuarries(a: Agent, ctx: FullCtx): void {
  try {
    const now = ctx.time, ttl = MAP.destTTL;
    for (const b of a.beliefs.all()) {
      if (b.subjectId === a.id) continue;
      if (b.placeKind) continue;   // a PLACE-belief (building) is static — never a fleeing quarry
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
      const hadDest = !!b.destPos;
      inferDestination(a, b, intent, ctx.map, now);
      // TRACE (write-only, never read back): record when inference COMMITS a place for a
      // lost quarry — the destination-intent pursuit's "I think it's making for X" beat.
      // We log only on a fresh commit (it had none, now it does). Own-state; guarded.
      if (!hadDest && b.destPos) {
        a.trace.note(STAGE_T.INFER, REASON_T.DEST_INFERRED, {
          t: now, subjectId: b.subjectId, a: b.destId || 'frontier', b: b.intent || null,
        });
      }
    }
  } catch { /* never throw on the tick */ }
}

// gossip: adopt a nearby ally's more-certain beliefs (carries standing too).
export function gossipBeliefs(a: Agent, ctx: FullCtx): void {
  if (!a.alive || a.controlled) return;
  for (const o of ctx.agents) {
    if (o === a || !o.alive || o.controlled) continue;
    // gossip iterates the REAL roster (never percepts), but guard defensively: a mindless
    // body has no .beliefs, and o.beliefs.all() on one would freeze the tick. Defence-in-depth.
    if (!o.beliefs) continue;
    if (a.pos.distanceTo(o.pos) > SIM.talkRange) continue;
    for (const b of o.beliefs.all()) {
      if (b.subjectId === a.id) continue;   // don't gossip about me to myself
      // Phase 2a: NEVER gossip PLACE-beliefs (buildings). mergeFrom copies only person-belief
      // fields (not placeKind/sheltered), so a gossiped building belief would land as a MALFORMED
      // person-belief keyed on a building percept-id — junk that consumes a slot in the recipient's
      // bounded ~8-entry table and is never refreshable by sight of a person. A place is something
      // you DISCOVER by going there (perception), not something hearsay files as a person.
      if (b.placeKind) continue;
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
