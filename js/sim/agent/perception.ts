// Agent Theory-of-Mind intake — perception (sight → beliefs, folding terrain
// vision) and gossip (adopting a chatting ally's more-certain beliefs + the
// affinity it builds). Extracted from Agent as free functions over a passed
// agent instance. These read GROUND TRUTH of who is nearby but only ever WRITE
// to the agent's own BeliefStore — the epistemic split that lets deception work.
// Behaviour-preserving: verbatim bodies of the old Agent methods. No cycles —
// imports config + pure terrain helpers only.

import { terrainHeight, concealmentAt } from '../../arena.js';
import { inferDestination, BeliefState } from '../beliefs.js';
import { SIM, SOURCE, BAND, COMMODITIES, ECON, MAP, SIGNALS, ESTEEM as WEALTHCUE, HEARSAY, DANGER, factionHostile } from '../simconfig.js';
import { noteSnub } from '../signals.js';
import { PERCEPT_KIND } from '../percept.js';
import { STAGE, REASON } from '../trace.js';
import { drainDeeds } from '../motivation/infer.js';
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
  threat?: number;             // the subject's combat-strength scalar — bridged into believedThreat (doc 18 M2)
  progression?: { totalLevel?: number };   // class/level brain — its totalLevel is the believed-level cue
  profession?: string | null; // a VISIBLE occupation cue (apron/tools/stall) — bridged into believedOccupation
  _trade?: string | null;     // the good it's currently making — a coarser occupation cue when profession is null
  kind?: string;
  ownerId?: EntityId;
  buildKind?: string;
  benefitKind?: string;
  _held?: boolean;             // CAPTIVE: ground-truth held state — perception bridges it to a belief
  inventory?: Record<string, number>;   // the VISIBLE carried pack — the prosperity cue (§6 wealth bridge)
}
const asThing = (o: Perceivable): PerceivedThing => o as unknown as PerceivedThing;

// perceive: sight of nearby agents writes high-confidence beliefs (the player
// is just another subject, so NPCs naturally form beliefs about you).
export function perceive(a: Agent, ctx: FullCtx): void {
  if (!a.alive || a.controlled) return;
  // docs/architecture/17 §7: process the witnessed-deed inbox (infer motives) BEFORE forming new
  // beliefs this tick. P3 stub is a no-op; P4 makes it write believedMotive + the conf-scaled fold.
  drainDeeds(a, ctx);
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
    // GENERALISED (docs/architecture/12 §9): record ANY visible agent's notoriety, not just the
    // player's — so an NPC outlaw accrues a town-read infamy the same way. Still witness-gated belief
    // (a secret robbery breeds none); RECRUIT/the outlaw arc read this believed scalar.
    if (o.notoriety) b.notoriety = o.notoriety || 0;
    // believed COMBAT STRENGTH (docs/architecture/18 M2, the FORMATION gap): seeing a subject
    // records its `threat` scalar (and its class LEVEL, the second strength cue) into my belief,
    // so a survival decision can later read a BELIEVED force estimate instead of falling back on
    // distance + faction + personality. Truth-in (the subject's own combat scalars — its bearing,
    // arms, the size of it — NEVER its live HP) / belief-out, the SAME sanctioned bridge as
    // notoriety/wealth. An NPC who never saw the foe holds no estimate (believedThreat 0). Re-
    // confirmed each sighting, faded by decay via wealthConf-style staleness on the belief itself.
    // This only BANKS the data (doc 18 M2); the consuming fight/flee reads are a later wave.
    if (o.threat) b.believedThreat = o.threat || 0;
    const lvl = o.progression && o.progression.totalLevel;
    if (lvl) b.believedLevel = lvl || 0;
    // believed OCCUPATION (doc 18 M2, optional cue — helps the later apprentice/teach fixes): the
    // trade a subject visibly plies (its apron, its stall, the good in its hands). Truth-in (a
    // visible role surface) / belief-out, same bridge. Prefer the explicit profession; fall back to
    // the good it is CURRENTLY making (_trade) for an emergent townsperson with no fixed trade.
    const occ = (o.profession != null ? o.profession : (o._trade != null ? o._trade : null));
    if (occ) b.believedOccupation = occ;
    // believed CAPTIVITY (CAPTIVE, the rescue arc): seeing a subject whose ground-truth `_held` is
    // set records it on my belief — truth-in / belief-out, the same sanctioned bridge as notoriety.
    // The affect deriver reads ONLY this belief (never `_held`), so the rescue DECISION stays in
    // belief-space. Re-confirmed each sighting; cleared when I see it freed (a freed captive idles
    // beside its rescuer, so its onlookers re-perceive it and drop the flag).
    b.captive = !!o._held;
    // believed WEALTH (docs/architecture/12 §6): a VISIBLE prosperity cue — a full pack / fine gear,
    // the carried proxy for prosperity — nudges my estimate. Truth-in (a visible surface on o, NEVER
    // o.gold) / belief-out, the same sanctioned bridge as notoriety. The recognition channel (decide)
    // reads ONLY this belief; estimateHaul uses it as its prior. Re-confirmed each sighting, faded by
    // decay. A flashy hauler reads rich, an empty-handed miser reads poor — wrong exactly when the
    // cues mislead, the same epistemic honesty the rest of the sim runs on.
    if (o.inventory) {
      let goods = 0; const tools = o.inventory.tool || 0;
      for (const k in o.inventory) goods += o.inventory[k] || 0;
      const implies = Math.max(0, Math.min(1, tools * 0.25 + goods * 0.03));
      if (implies > 0.02) b.recordWealthCue(implies, WEALTHCUE.sightWeight);
    }
  }
  // DESTINATION-INTENT: any tracked subject I am NO LONGER seeing — but still hold a
  // confident, freshly-stale belief about (just dropped below a full-confidence sighting)
  // and have NOT yet inferred a destination for — gets one inferred now from its last
  // heading + known geography. This is what lets a pursuer intercept a quarry that fled
  // out of sight toward an inferable place, with no omniscient roster read.
  inferLostQuarries(a, ctx);
  // BANKED DANGER GEOGRAPHY (doc 18 item 4): maintain the decaying set of believed-bad spots the
  // travel/wander steer fills lean away from. Own beliefs/memory only — never a truth read.
  bankDanger(a, ctx);
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
    // classify the place (home if it's mine, else by what it's dressed as — every civic kind
    // is recognisable on sight: a tavern's hearth, a shrine's spire, the granary's long store).
    bb.placeKind = (o.ownerId === a.id) ? 'home'
      : ((o.buildKind === 'tavern' || o.benefitKind === 'tavern') ? 'tavern'
        : (o.buildKind === 'guildhall' ? 'guildhall'
          : (o.buildKind === 'shrine' ? 'shrine'
            : (o.buildKind === 'granary' ? 'granary' : 'building'))));
    // a shrine wears its god openly (the banner/idol is the percept surface, like ownerId).
    if (o.buildKind === 'shrine') bb.placeGod = (o as { god?: string }).god || null;
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

// BANKED DANGER GEOGRAPHY (doc 18 item 4): the mirror of HAUNT. Maintain a small DECAYING set of
// remembered bad spots — where the agent confidently believes a hostile is/was, and where it
// witnessed a death — so the travel/wander steer fills can lean lightly AWAY from them (a felt
// geography of where it is unwise to linger). OBSERVER-banked from the agent's OWN beliefs + own
// episodic memory (a believed-hostile's lastPos, a witnessed_death position) — NEVER a truth read in
// cognition (the same own-scope inputs perception already reads). Bounded (DANGER.cap), decaying
// (per perceive pass), merge-deduped, range-gated. Pure own-state; guarded; never throws.
function bankDanger(a: Agent, ctx: FullCtx): void {
  try {
    const now = ctx.time || 0;
    let spots = a._dangerSpots;
    // decay the existing set first (the last-banked time drives the bleed), dropping the faint.
    if (spots && spots.length) {
      const kept: { x: number; z: number; w: number; t: number }[] = [];
      for (const s of spots) {
        const w = s.w - (DANGER.decayPerSec || 0.06) * Math.max(0, now - s.t);
        if (w > (DANGER.minWeight || 0.12)) kept.push({ x: s.x, z: s.z, w, t: now });
      }
      spots = a._dangerSpots = kept;
    }
    // candidate bad spots THIS pass: a believed-hostile I confidently hold near me (its lastPos), and
    // any fresh witnessed_death I recall. Own beliefs + own memory only.
    const cands: { x: number; z: number }[] = [];
    const r2 = (DANGER.bankRange || 90) * (DANGER.bankRange || 90);
    for (const b of a.beliefs.all()) {
      if (!b || b.placeKind) continue;                       // a place is not a moving danger
      if (b.confidence < SIM.actOnBeliefMin) continue;
      if (!(b.hostile || (a.considerHostile && a.considerHostile(b)))) continue;
      if (!b.lastPos || !Number.isFinite(b.lastPos.x)) continue;
      const dx = b.lastPos.x - a.pos.x, dz = b.lastPos.z - a.pos.z;
      if (dx * dx + dz * dz > r2) continue;                  // only my own neighbourhood
      cands.push({ x: b.lastPos.x, z: b.lastPos.z });
    }
    try {
      const eps = a.memory ? a.memory.recent(8) : [];
      for (const ep of eps) {
        if (!ep || ep.kind !== 'witnessed_death') continue;
        // a witnessed_death episode carries no position, but I hold beliefs about its participants —
        // the killer (byId) and the fallen (withId). Their believed lastPos marks WHERE the bloodshed
        // was (own-belief, the same scope perception reads). Prefer the killer's spot (the live danger).
        const pb = (ep.byId != null && a.beliefs.get(ep.byId)) || (ep.withId != null && a.beliefs.get(ep.withId)) || null;
        const p = pb && pb.lastPos;
        if (!p || !Number.isFinite(p.x)) continue;
        const dx = p.x - a.pos.x, dz = p.z - a.pos.z;
        if (dx * dx + dz * dz > r2) continue;
        cands.push({ x: p.x, z: p.z });
      }
    } catch { /* a memory hiccup must not abort banking */ }
    if (!cands.length) return;
    if (!spots) spots = a._dangerSpots = [];
    const md2 = (DANGER.mergeDist || 14) * (DANGER.mergeDist || 14);
    for (const c of cands) {
      // refresh an existing nearby spot (no duplicate pile-up), else add a fresh one.
      let merged = false;
      for (const s of spots) {
        const dx = s.x - c.x, dz = s.z - c.z;
        if (dx * dx + dz * dz <= md2) { s.w = DANGER.bankWeight || 1.0; s.t = now; merged = true; break; }
      }
      if (!merged) spots.push({ x: c.x, z: c.z, w: DANGER.bankWeight || 1.0, t: now });
    }
    // bound: keep the freshest/strongest, evict the faintest.
    const cap = DANGER.cap || 4;
    if (spots.length > cap) {
      spots.sort((p, q) => q.w - p.w || q.t - p.t);
      spots.length = cap;
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
    // GOSSIP-ABOUT-SELF SNUB (docs/architecture/13 §3 snubsFelt): if this chatting neighbour
    // HOLDS a negative opinion of ME (a soured standing and/or a raised suspicion), I overhear
    // them speaking ill of me — a PERCEIVED cold shoulder. noteSnub(self) is OWN-STATE (the snub
    // I felt), the legitimate input for the `slandered` memory; I do NOT read the teller's mind for
    // a decision — I only register that I was ill-spoken of. Bounded to one snub per ingest pass
    // (the `break` below already limits this to one partner per tick); the snub decay does the rest.
    if (!a.controlled) {
      const mine = o.beliefs.get(a.id);
      if (mine && ((mine.standing || 0) <= SIGNALS.snubGossipStanding ||
                   (mine.suspicion || 0) >= SIGNALS.snubGossipSuspicion)) {
        noteSnub(a, ctx.time);
      }
    }
    for (const b of o.beliefs.all()) {
      if (b.subjectId === a.id) continue;   // don't gossip about me to myself
      // PLACE-beliefs travel PLACE-SHAPED (mergePlaceFrom — the city-architecture follow-on),
      // never through the person merge (which would land them as malformed person-beliefs).
      // Only the PUBLIC kinds are worth the breath (and the listener's bounded table slots):
      // "the tavern at Crowmoor is fine", "the shrine of Om was razed". A private home is
      // nobody's news, and an unclassified 'building' carries nothing worth telling. The
      // teller also only passes on places it still holds confidently (placeGossipConf) —
      // stale half-memories don't propagate.
      if (b.placeKind) {
        if ((b.placeKind === 'tavern' || b.placeKind === 'shrine' || b.placeKind === 'granary' || b.placeKind === 'guildhall')
            && b.confidence >= (HEARSAY.placeGossipConf ?? 0.45)) {
          a.beliefs.mergePlaceFrom(b, SOURCE.TALKED);
        }
        continue;
      }
      // WITNESSED EXONERATION (the vouch): before I let this teller's belief colour mine, if the
      // teller speaks ILL of a subject I hold FIRST-HAND and FOND (a friend being slandered), I
      // talk BACK — nudging the teller's OWN belief about that subject up toward mine. Belief→
      // belief only, inside the sanctioned gossip bridge (writing the teller's store is fine here);
      // bounded by my first-hand confidence. So a well-liked agent with loyal eyewitness friends is
      // slander-resistant; a loner has no-one to vouch and is vulnerable. Never throws.
      if (!a.controlled) {
        const mine = a.beliefs.get(b.subjectId);
        BeliefState.vouch(mine, b);
      }
      a.beliefs.mergeFrom(b, SOURCE.TALKED);
    }
    // RUMOURED PRICES: chatting also drifts my price beliefs toward this neighbour's —
    // how a price rumour spreads. This lives in the gossip BRIDGE (where reading another
    // agent's beliefs is sanctioned), not in cognition. Per fixed tick (step), scaled to
    // approximate the old per-frame drift (priceGossipPerTick). Beliefs only; bounded.
    //
    // TRUST-WEIGHTED: an overheard price is NOT swallowed whole — I weight the drift by how
    // much I TRUST the teller (my OWN standing toward them, read from my OWN belief — already
    // inside the sanctioned bridge). A trusted neighbour (positive standing) moves my price
    // belief strongly; a stranger (standing ~0) only at the baseline trickle; a disliked one
    // (negative standing) barely shifts me at all. So a price rumour no longer converges the
    // whole town in a single tick — standing gates how fast it spreads, which is what leaves a
    // price gap open long enough for a clever trader to exploit. Bounded to [0,1]; mints nothing.
    if (!a.controlled && a.priceBeliefs && o.priceBeliefs) {
      const base = ECON.priceGossipPerTick != null ? ECON.priceGossipPerTick : (ECON.priceGossip * 10);
      const standing = a.beliefs.get(o.id)?.standing || 0;   // my own opinion of the teller, -1..1
      const tw = ECON.priceTrustWeight != null ? ECON.priceTrustWeight : 0.6;
      // baseline (1-tw) trickle from anyone; the rest scales with standing. Negative standing
      // pulls the multiplier below baseline (a doubted rumour), clamped ≥0 (never repels a belief).
      const trust = Math.max(0, Math.min(1, (1 - tw) + tw * standing));
      const rate = base * trust;
      if (rate > 0) {
        for (const c of COMMODITIES) {
          a.priceBeliefs[c] += (o.priceBeliefs[c] - a.priceBeliefs[c]) * rate;
        }
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
    // RELATIONSHIP SENTIMENT (SENTIMENT): this peaceful chat is ONE small pleasant interaction —
    // accrue the slow relationship EMA. Unlike affinity (which only builds from a non-negative
    // baseline), sentiment accrues even toward someone I currently resent — a long history of
    // small kindnesses can SLOWLY thaw a grudge — but its colour on standing is gentle and the
    // decay pulls it back when the kindnesses stop, so a real wrong still persists in the short
    // run. It colours standing toward where sentiment sits, so existing standing-readers benefit.
    // Belief→own-belief only; bounded; guarded.
    if (rel) rel.accrueSentiment();
    break;   // one conversation partner per tick
  }
}
