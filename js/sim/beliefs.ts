// The Theory-of-Mind core: every agent (observer) holds a bounded table of
// BeliefStates about other agents (subjects). Beliefs are produced by direct
// perception (confidence 1.0), propagated by gossip (confidence-capped, with
// provenance), planted by deception, and decayed over time.
//
// This mirrors the spec's `belief(observer, subject) -> T` pair-map (the N²
// "what A thinks about B" layer) and the Source/confidence provenance model.

import * as THREE from 'three';
import { rng } from './rng.js';
import { ARENA_RADIUS } from '../arena.js';
import { SIM, SOURCE, HEARSAY, SENTIMENT, MAP } from './simconfig.js';
import type {
  AnimacyTally, AssocBelief, BeliefState as IBeliefState, BeliefStore as IBeliefStore,
  PlantOpts, EntityId, MentalMap, Place, Vec2Like,
} from '../../types/sim.js';

const clampStanding = (s: number) => Math.max(-1, Math.min(1, s));

// How garbled is a belief? `hops` is its provenance depth: 0 = seen first-hand,
// and every social retelling adds one (capped). The narrative layer reads this to
// hedge what it prints ("as told thirdhand"); the sim reads it to garble further.
export function provenanceLabel(b: IBeliefState | null | undefined) {
  const h = (b && b.hops) || 0;
  if (!b || b.source === SOURCE.WITNESSED.tag || h <= 0) return 'seen first-hand';
  if (h === 1) return 'heard from a witness';
  if (h === 2) return 'secondhand';
  if (h === 3) return 'a thirdhand rumour';
  return 'a tale much retold';
}
// a compact tag for tight UI (the inspector belief rows).
export function provenanceTag(b: IBeliefState | null | undefined) {
  const h = (b && b.hops) || 0;
  if (!b || b.source === SOURCE.WITNESSED.tag || h <= 0) return 'seen';
  if (h === 1) return 'heard';
  if (h === 2) return '2nd-hand';
  if (h === 3) return 'rumour';
  return 'hearsay';
}

// A deed remembered about a subject — the CONTENT behind a reputation ("killed a man"),
// not just its sign. Recorded first-hand (reputation.apply for player deeds, combatEvents for
// witnessed kills) and carried — garbling — down a gossip chain by mergeFrom (deeds-travel).
export interface KnownDeed { deed: string; label: string; t: number; hops?: number }

// The telephone game for CONTENT: a deed exaggerates as it's retold. Past a few mouths a
// striking becomes a killing, a theft becomes "a known thief". First/second-hand tellings
// keep the true label; only a much-retold tale (hops≥3) curdles into the lurid version —
// the same hops gate the standing/hostility garble uses. Returns the (possibly) worse label.
const DEED_ESCALATION: Record<string, string> = {
  struck: 'left a man for dead', attacked: 'killed a man', wounded: 'killed a man',
  robbed: 'is a known thief', stole: 'is a known thief',
};
function garbleDeed(deed: string, label: string, hops: number): string {
  return hops >= 3 && DEED_ESCALATION[deed] ? DEED_ESCALATION[deed] : label;
}

export class BeliefState implements IBeliefState {
  subjectId: EntityId;
  lastFaction: string | null;
  lastPos: THREE.Vector3;
  heading: THREE.Vector3;
  destId: string | null;
  destPos: THREE.Vector3 | null;
  intent: string | null;
  destInferredAt: number;
  notoriety: number;
  lastTick: number;
  confidence: number;
  hostile: boolean;
  suspicion: number;
  standing: number;
  knownDeeds: unknown[];
  source: string;
  hops: number;
  rumorBorn: boolean;
  animacyTally: AnimacyTally | null;
  placeKind: string | null;
  sheltered: boolean | null;
  placeGod: string | null;
  benefitFelt: number | null;
  captive: boolean;
  inertEvidence: number;
  inert: boolean;
  assoc: AssocBelief | null;
  assocSightings: number;
  believedWealth: number;
  wealthConf: number;
  sentiment: number;

  constructor(subjectId: EntityId) {
    this.subjectId = subjectId;
    this.lastFaction = null;     // believed faction (a disguise can fake this)
    this.lastPos = new THREE.Vector3();   // where I last SAW it (the anchor of my mental map)
    // DESTINATION-INTENT pursuit (Theory of Mind, NOT velocity dead-reckoning): when a
    // tracked quarry leaves sight I do NOT extrapolate a vector. I record its OBSERVED
    // heading and INFER a likely destination from known geography + context, then move to
    // intercept there. heading is observed (not projected forward); destPos is a STATIC
    // geography point (shared knowledge, legit), so committing to it reads no live truth.
    this.heading = new THREE.Vector3();   // last-seen unit direction of motion (observed)
    this.destId = null;          // believed destination key (a Place.id) or null
    this.destPos = null;         // resolved world pos of that destination (static geography) or null
    this.intent = null;          // 'flee'|'raid'|'home'|null — why it's headed there
    this.destInferredAt = 0;     // sim-time the dest was inferred (TTL cache; 0 = none/lapsed)
    this.notoriety = 0;          // believed player fame (fear gate); written by perception
    this.lastTick = 0;
    this.confidence = 0;         // 0..1, decays over time
    this.hostile = false;        // do I think this agent is hostile to me?
    this.suspicion = 0;          // 0..1, "something's off about them"
    this.standing = 0;           // -1..1, my opinion of this subject (reputation)
    this.knownDeeds = [];        // recent deeds I've witnessed/heard about them
    this.source = SOURCE.WITNESSED.tag;
    this.hops = 0;               // provenance depth (0 = first-hand; grows with each retelling)
    this.rumorBorn = false;      // this hostility was curdled from gossip, not witnessed
    // ANIMACY TALLY (lazy; null until the subject is observed acting alive) — cumulative
    // evidence the subject MOVED, STRUCK, BLOCKED, or HARMED ME since I started tracking
    // it. A believed-foe I've struck repeatedly that never accrues a tally is, by my own
    // evidence, inert (a scarecrow / corpse / statue) — schema #6 (no-threat-no-response)
    // revises the belief off this. Written ONLY by the allowlisted bridges (perception's
    // observed-motion + combatEvents' struck/blocked/harmedMe); NOT reset by observe()
    // (liveness evidence is cumulative). A scarecrow re-perceived forever never gains one.
    this.animacyTally = null;
    // PLACE-as-percept fields (Phase 2a, places-as-percepts) — null for a person-belief.
    // placeKind: 'building'|'home'|'tavern'|'shrine'|'granary'|'guildhall'; sheltered: believed
    // shelter state (true/false). placeGod: whose shrine I believe this is (perceived off the
    // building's surface). benefitFelt: the comfort quality I have EXPERIENCED here (0..1,
    // stamped by act.ts while resting — my own lived experience, never a truth-read) — the
    // believed-best comfort routing weighs it against the cultural prior for the kind.
    this.placeKind = null;
    this.sheltered = null;
    this.placeGod = null;
    this.benefitFelt = null;
    // CAPTIVE (the rescue arc): believed-held — perception sets it true when I SEE a subject whose
    // ground-truth `_held` is set (a captive), false otherwise. The affect deriver reads ONLY this
    // belief (never `_held`) to form a goalFree, preserving the epistemic split. Off by default.
    this.captive = false;
    // higher-order reasoning scalars the schema layer accrues (e.g. inertEvidence).
    this.inertEvidence = 0;
    // REVISED-INERT flag: schema #6 sets this once inertEvidence crosses its threshold —
    // a subject I've proven harmless by my own repeated strikes + zero observed animacy.
    // considerHostile() honours it, so it overrides BOTH a latched hostile and the faction
    // prior (the disengage from a proven scarecrow). False for every live subject.
    this.inert = false;
    // SUBJECT↔PLACE ASSOCIATION (Phase 4, the urchin's epistemic gather) — null until
    // repeated surveil sightings consolidate a believed stash/cache location, or gossip
    // supplies one first. Read by the planner's `know_assoc` precondition (own-state).
    this.assoc = null;
    this.assocSightings = 0;
    // believed PROSPERITY of the subject (docs/architecture/12 §6): evidence-accrual like every other
    // belief field — nudged by a visible cue (recordWealthCue), faded by decay. NEVER ground truth.
    this.believedWealth = 0;
    this.wealthConf = 0;
    // RELATIONSHIP SENTIMENT (SENTIMENT): a slow EMA of "do I generally like being near this
    // person?", built across many small pleasant/cold interactions rather than any single deed.
    // Bounded to ±SENTIMENT.cap, eased toward a pleasant target by repeated proximity (perception's
    // chat affinity), decayed gently toward neutral, and folded back as a small COLOUR on standing.
    // Starts neutral; never ground truth.
    this.sentiment = 0;
  }

  // RELATIONSHIP SENTIMENT upkeep (SENTIMENT). Called from the chat-affinity bridge when this
  // observer shares a peaceful moment with the subject. Eases sentiment toward the pleasant
  // target (a slow EMA), then COLOURS standing a little toward where sentiment now sits — so a
  // long history of small kindnesses lifts the relationship even with no dramatic event, and
  // existing standing-reading behaviour benefits without touching decide. Bounded; never throws.
  accrueSentiment() {
    try {
      const cap = SENTIMENT.cap;
      const tgt = Math.min(cap, SENTIMENT.pleasantTarget);
      this.sentiment = Math.max(-cap, Math.min(cap, this.sentiment + (tgt - this.sentiment) * SENTIMENT.emaGain));
      // colour standing toward sentiment (bounded by clampStanding) — a gentle pull, not a set.
      this.standing = clampStanding(this.standing + (this.sentiment - this.standing) * SENTIMENT.colourGain);
    } catch { /* never throw on the tick */ }
  }

  // nudge the believed-wealth estimate toward `implies` (0..1) by `weight` — a perceived prosperity
  // cue (a fat trade, fine gear, an owned home). Mirrors recordAssocSighting: evidence firms the
  // estimate + its confidence; decay fades the confidence so a stale read goes uncertain. Guarded.
  recordWealthCue(implies: number, weight: number) {
    const w = Math.max(0, Math.min(1, weight || 0));
    const imp = Math.max(0, Math.min(1, implies || 0));
    this.believedWealth = Math.max(0, Math.min(1, this.believedWealth + (imp - this.believedWealth) * w));
    this.wealthConf = Math.min(1, this.wealthConf + w * (1 - this.wealthConf));
  }

  // WITNESSED EXONERATION — the VOUCH (HEARSAY.vouch*). A first-hand FOND belief beats hearsay:
  // mergeFrom already won't let a tale overturn my fresher belief, but a vouch goes further — I
  // talk BACK. Given my OWN first-hand belief `mine` about a subject (fond + confident) and a
  // teller's belief `theirs` about that same subject which marks it hostile / holds a lower
  // standing, I nudge THEIR belief up toward mine — defending a friend's name. The push scales
  // with MY first-hand confidence, is bounded (never past mine — I plead, I don't overwrite), and
  // only lifts a RUMOUR-born hostility (never a witnessed one — I can't talk a man out of what he
  // saw with his own eyes). Belief→belief only; the caller is the gossip bridge (sanctioned to
  // touch the teller's store). Returns true if a vouch landed (trace/test visibility). Never throws.
  static vouch(mine: BeliefState | null | undefined, theirs: BeliefState | null | undefined): boolean {
    try {
      if (!mine || !theirs) return false;
      if ((mine.hops || 0) !== 0) return false;               // only on my OWN first-hand knowledge
      if (mine.placeKind || theirs.placeKind) return false;   // places have no reputation to defend
      if ((mine.standing || 0) < HEARSAY.vouchStanding) return false;   // I must hold them FOND
      if ((mine.confidence || 0) < HEARSAY.vouchConf) return false;     // …and CONFIDENTLY so
      const slandered = theirs.hostile || (theirs.standing || 0) < mine.standing;
      if (!slandered) return false;                           // nothing to push back on
      const push = HEARSAY.vouchStrength * (mine.confidence || 0);      // bounded by my conf
      if ((theirs.standing || 0) < mine.standing)
        theirs.standing = clampStanding(theirs.standing + (mine.standing - theirs.standing) * push);
      if (theirs.hostile && theirs.rumorBorn && push >= HEARSAY.vouchHostileHeal) {
        theirs.hostile = false; theirs.rumorBorn = false;     // a strong plea clears a hearsay feud
      }
      return true;
    } catch { return false; /* never throw on the tick */ }
  }

  // record one piece of liveness evidence on this belief (lazy-allocates the tally on the
  // first observed action). `kind` ∈ 'struck'|'blocked'|'harmedMe'|'moved'. Guarded.
  recordAnimacy(kind: 'struck' | 'blocked' | 'harmedMe' | 'moved' /*, now */) {
    if (!kind) return;
    if (!this.animacyTally) this.animacyTally = { struck: 0, blocked: 0, harmedMe: 0, moved: 0 };
    if (this.animacyTally[kind] != null) this.animacyTally[kind] += 1;
  }

  // accumulate one surveil sighting of this subject near a `placeKind` (the urchin's
  // `shadow`/`surveil` — the epistemic gather). The loose tally CONSOLIDATES into a
  // believed `assoc` only after `minSightings` confirmations; confidence grows by
  // `gainConf` per sighting (capped 1). Own-state, guarded, never throws.
  recordAssocSighting(placeKind: string, pos: Vec2Like, gainConf: number, minSightings: number) {
    if (!placeKind) return;
    this.assocSightings += 1;
    const conf = Math.min(1, (this.assoc ? this.assoc.conf : 0) + (gainConf || 0));
    if (this.assocSightings >= (minSightings || 1)) {
      this.assoc = { placeKind, pos: { x: pos.x, z: pos.z }, conf };
    }
  }
}

export class BeliefStore implements IBeliefStore {
  observerId: EntityId;
  map: Map<EntityId, BeliefState>;

  constructor(observerId: EntityId) {
    this.observerId = observerId;
    this.map = new Map();        // subjectId -> BeliefState
  }

  get(subjectId: EntityId): BeliefState | null { return this.map.get(subjectId) || null; }
  all() { return this.map.values(); }

  _ensure(subjectId: EntityId): BeliefState {
    let b = this.map.get(subjectId);
    if (!b) {
      this._evictIfFull();
      b = new BeliefState(subjectId);
      this.map.set(subjectId, b);
    }
    return b;
  }

  // Keep the table bounded (spec: BoundedMap<…, 8>). Evict the least-certain,
  // stalest belief when full.
  _evictIfFull() {
    if (this.map.size < SIM.beliefsPerAgent) return;
    let worst: BeliefState | null = null, worstScore = Infinity;
    for (const b of this.map.values()) {
      // PLACES-AS-PERCEPTS (Phase 2a): never evict the observer's OWN HOME belief — it is the
      // agent's cognition-visible housing state (homeBelief), which must survive a long
      // absence (the homecoming relies on the stale-intact belief persisting until perception
      // or decay revises it). It is revised by SIGHT, never by eviction. Other place-beliefs
      // (taverns) are evictable like any subject — they are re-perceivable / map-backed.
      if (b.placeKind === 'home') continue;
      const score = b.confidence - (b.hostile ? 0.5 : 0) - b.suspicion * 0.3;
      if (score < worstScore) { worstScore = score; worst = b; }
    }
    if (worst) this.map.delete(worst.subjectId);
  }

  // Direct sighting: overwrite with ground truth at full confidence. Seeing for
  // yourself RESETS provenance — a first-hand look beats any tale (hops -> 0).
  observe(subjectId: EntityId, perceivedFaction: string | null, pos: THREE.Vector3, tick: number, hostile: boolean): BeliefState {
    const b = this._ensure(subjectId);
    b.lastFaction = perceivedFaction;
    // record the observed HEADING (unit direction of motion): the displacement since I
    // last saw it, normalised. This is OBSERVED (not extrapolated forward) — the
    // destination-intent pursuit reads it to infer WHERE the quarry is making for and
    // intercept there. A fresh sighting (no prior, or a long gap = a "jump") records no
    // heading, so I don't infer off a stale anchor.
    const dt = tick - b.lastTick;
    if (b.lastTick > 0 && dt > 0 && dt <= HEARSAY.predictMaxGap) {
      const hx = pos.x - b.lastPos.x, hz = pos.z - b.lastPos.z;
      const hl = Math.hypot(hx, hz);
      if (hl > 1e-4) b.heading.set(hx / hl, 0, hz / hl);
      else b.heading.set(0, 0, 0);
    } else {
      b.heading.set(0, 0, 0);
    }
    b.lastPos.copy(pos);
    b.lastTick = tick;
    b.confidence = SOURCE.WITNESSED.conf;
    b.source = SOURCE.WITNESSED.tag;
    b.hops = 0;
    // re-acquired by sight: the quarry is here, so any stale inferred destination is moot.
    // Clearing destInferredAt too is the contradicting-perception INVALIDATION — the next
    // stale tick re-infers from scratch rather than trusting a now-falsified cache.
    b.destId = null; b.destPos = null; b.intent = null; b.destInferredAt = 0;
    if (hostile) b.hostile = true;       // sighting hostility latches on
    return b;
  }

  // Social merge: adopt another agent's belief if it's more certain than ours.
  // Confidence is capped (second-hand) and faded (per hop) — provenance-aware —
  // and the CONTENT garbles in the retelling (the telephone game): see _garble.
  mergeFrom(other: BeliefState | null | undefined /* BeliefState */, src: unknown /* SOURCE.* */) {
    if (!other) return;
    const s = src as { tag: string; conf: number };   // a SOURCE.* descriptor
    const incoming = Math.min(other.confidence * SIM.gossipFalloff, s.conf, SIM.gossipCap);
    let b = this.map.get(other.subjectId);
    if (b && b.confidence >= incoming) {
      // we already know it fresher — keep our facts, but talk still colours opinion.
      if (other.hostile) b.hostile = true;
      b.suspicion = Math.max(b.suspicion, other.suspicion * 0.6);
      this._garble(b, other, false);
      this._carryDeed(b, other);
      return;
    }
    b = this._ensure(other.subjectId);
    b.lastFaction = other.lastFaction;
    b.lastPos.copy(other.lastPos);
    b.lastTick = other.lastTick;
    b.confidence = incoming;
    b.source = s.tag;
    b.hops = Math.min(HEARSAY.maxHops, ((other.hops || 0) + 1));   // one more mouth removed
    if (other.hostile) b.hostile = true;
    b.suspicion = Math.max(b.suspicion, other.suspicion * 0.6);
    this._garble(b, other, true);
    this._carryDeed(b, other);
  }

  // DEEDS TRAVEL: a reputation's CONTENT spreads, not just its sign. Carry the teller's freshest
  // known deed about the subject onto my belief, garbling the label by how far the tale has
  // travelled (my hops) — so "he struck a man" can reach me, third-hand, as "he killed a man".
  // The same story coming back around isn't piled up twice (dedup by deed+time). Capped, like
  // reputation.apply's own list. Gated + clamped; never throws (the freeze lesson).
  _carryDeed(b: BeliefState, other: BeliefState) {
    try {
      const od = other.knownDeeds as KnownDeed[];
      if (!od || !od.length) return;
      const top = od[0];
      if (!top || !top.deed) return;
      const bd = b.knownDeeds as KnownDeed[];
      if (bd.some((d) => d && d.deed === top.deed && Math.abs((d.t || 0) - (top.t || 0)) < 1)) return;
      const hops = b.hops || 0;
      bd.unshift({ deed: top.deed, label: garbleDeed(top.deed, top.label, hops), t: top.t || 0, hops });
      if (bd.length > 6) bd.length = 6;
    } catch { /* never throw */ }
  }

  // PLACE HEARSAY (the city-architecture follow-on): adopt a neighbour's belief about a
  // BUILDING, kept PLACE-SHAPED — "the tavern at Crowmoor is fine", "the shrine of Om was
  // razed". Distinct from mergeFrom on purpose: a place has no reputation to garble — no
  // standing, no hostility, no suspicion — only kind / where / shelter state / felt quality.
  // The hearsay physics still hold: confidence falls off per mouth (gossipFalloff × cap),
  // hops deepen, SIGHT ALWAYS WINS (a fresher own-belief is kept — hearsay never outranks
  // eyes), and a TOLD quality lands damped (placeQualityDamp: hearing of a hearth is weaker
  // than having sat at it). The one asymmetry: news of RUIN updates even a fresher-held
  // 'intact' when the teller's sighting is NEWER — bad news travels.
  mergePlaceFrom(other: BeliefState | null | undefined, src: unknown /* SOURCE.* */) {
    if (!other || !other.placeKind) return;
    const s = src as { tag: string; conf: number };
    const incoming = Math.min(other.confidence * SIM.gossipFalloff, s.conf, SIM.gossipCap);
    let b = this.map.get(other.subjectId);
    if (b && b.confidence >= incoming) {
      if (other.sheltered === false && b.sheltered !== false && (other.lastTick || 0) > (b.lastTick || 0)) b.sheltered = false;
      return;
    }
    b = this._ensure(other.subjectId);
    b.placeKind = other.placeKind;
    b.placeGod = other.placeGod;
    b.sheltered = other.sheltered;
    b.lastPos.copy(other.lastPos);
    b.lastTick = other.lastTick;
    b.lastFaction = 'unknown';
    b.confidence = incoming;
    b.source = s.tag;
    b.hops = Math.min(HEARSAY.maxHops, ((other.hops || 0) + 1));
    if (other.benefitFelt != null)
      b.benefitFelt = Math.max(b.benefitFelt || 0, other.benefitFelt * (HEARSAY.placeQualityDamp ?? 0.7));
  }

  // The telephone game: distort the belief's CONTENT as it passes along.
  //  · MILD talk (ordinary goodwill/coolness, |standing|<chargeThresh) spreads
  //    undistorted and DAMPED, exactly as reputation always did — so the social
  //    fabric (friendships, groups) holds.
  //  · A CHARGED opinion is STICKY: a fresh listener adopts an EXAGGERATED form of
  //    it near-whole (bad news faster than good), so outrage COMPOUNDS toward the
  //    extreme down a chain of tellers — the rumour that grows in the telling.
  //  · suspicion, told and retold, can curdle into a FALSE hostility (a feud born of
  //    pure talk), bounded by how garbled the tale already is (hops).
  // `adopt` = we took this belief whole (fresh/less-certain); else we only let talk
  // nudge a belief we already hold. Clamped + gated; never throws (the freeze lesson).
  _garble(b: BeliefState, other: BeliefState, adopt: boolean) {
    try {
      const s = other.standing || 0;
      if (Math.abs(s) >= HEARSAY.chargeThresh) {
        const tgt = clampStanding(s * (1 + HEARSAY.amplify * (s < 0 ? HEARSAY.negBias : 1)));
        b.standing = adopt ? tgt : clampStanding(b.standing + (tgt - b.standing) * SIM.gossipFalloff * 0.5);
      } else {
        b.standing = clampStanding(b.standing + (s - b.standing) * SIM.gossipFalloff * 0.5);
      }
      // a name blackened past tipStanding by enough retellings can curdle into a
      // FALSE hostility in the listener's mind — a feud born of pure talk. Only on
      // hearsay (hops>=2); a first-hand belief is never overturned by a tale.
      if (!b.hostile && (b.hops || 0) >= 2 && b.standing <= -HEARSAY.tipStanding) {
        const p = Math.min(0.5, HEARSAY.tipChancePerHop * ((b.hops || 0) - 1));
        if (rng() < p) { b.hostile = true; b.source = SOURCE.RUMOR.tag; b.rumorBorn = true; }
      }
    } catch { /* never throw */ }
  }

  // Deception: forcibly write a (possibly false) belief into this store.
  plant(subjectId: EntityId, { faction, pos, tick, hostile, suspicion, confidence }: PlantOpts): BeliefState {
    const b = this._ensure(subjectId);
    if (faction !== undefined) b.lastFaction = faction;
    if (pos) b.lastPos.copy(pos);
    if (tick !== undefined) b.lastTick = tick;
    if (hostile !== undefined) b.hostile = hostile;
    if (suspicion !== undefined) b.suspicion = Math.max(b.suspicion, suspicion);
    b.confidence = confidence ?? SOURCE.RUMOR.conf;
    b.source = SOURCE.RUMOR.tag;
    b.hops = Math.max(b.hops || 0, 2);   // a planted whisper already reads as hearsay
    return b;
  }

  erase(subjectId: EntityId) { this.map.delete(subjectId); }

  // Per-second decay of certainty and suspicion.
  decay(dt: number) {
    for (const b of this.map.values()) {
      // TIE-WEIGHTED RETENTION (non-uniform decay): confidence in someone fades SLOWER the more
      // they personally MATTER to me — keyed on |standing| (a real relationship, love OR hate),
      // NEVER on mere suspicion/the hostile flag. The distinction is load-bearing: the belief-cap
      // sweep showed unbounded minds annihilate the town (cap>=100 -> 1-3 survivors) because
      // witnessed/gossiped hostility about STRANGERS never faded — hostility metastasized until
      // everyone fought everyone. A stranger you only heard ill of fades (feuds die by being
      // forgotten); the one who actually wronged or loved you stays in mind (vendettas stay
      // PERSONAL). Spouse/blood-enemy ≈ (1+tieRetention)x slower than a market acquaintance.
      // NON-AGENT (place) beliefs retain by NATURE, not by tie: a building doesn't walk, so
      // positional knowledge of it never goes stale like a person's — only its believed STATE
      // (sheltered) changes, and rarely. placeRetention slows every placeKind belief (the
      // eviction pass already never drops one's home; this is the decay-side of that
      // precedent — the homecoming's stale-intact home belief persists until SIGHT revises it,
      // while a torched tavern unvisited for long enough still fades to uncertainty). Props/
      // scarecrows carry no placeKind and keep person-rate fade — being mistaken for a person
      // is their entire job.
      const tie = b.placeKind ? (SIM.placeRetention || 0) : (SIM.tieRetention || 0) * Math.min(1, Math.abs(b.standing || 0));
      const keep = 1 + tie;
      b.confidence = Math.max(0, b.confidence - (SIM.confidenceDecay * dt) / keep);
      b.suspicion = Math.max(0, b.suspicion - SIM.suspicionDecay * dt);
      // a believed-wealth read goes stale like any other: fade its confidence so an unrefreshed
      // prosperity estimate becomes uncertain (the recognition channel weights by wealthConf).
      if (b.wealthConf > 0) b.wealthConf = Math.max(0, b.wealthConf - SIM.confidenceDecay * dt);
      // RELATIONSHIP SENTIMENT (SENTIMENT) drifts GENTLY back toward neutral when unreinforced —
      // a like/dislike fades without renewed pleasant proximity (forgetting), but far slower than
      // confidence, so it is a LASTING relationship memory. Symmetric (both signs decay to 0);
      // places carry no sentiment so this no-ops for them. Bounded.
      if (b.sentiment) {
        const step = SENTIMENT.decayPerSec * dt;
        b.sentiment = b.sentiment > 0 ? Math.max(0, b.sentiment - step) : Math.min(0, b.sentiment + step);
      }
    }
  }
}

// DESTINATION-INTENT inference (Theory of Mind, NOT dead-reckoning). Called when a
// tracked quarry leaves the observer's sight: infer WHERE it is trying to GO from its
// last-seen heading + the observer's KNOWN PLACES (mental map) + context — then the
// pursuer intercepts there. An argmax over the observer's ~8 known places (O(#places)):
//   score = headingMatch(0..1) × wHeading                 (is the quarry aimed at it?)
//         + intent-conditional affordance bonus × wAfford (a fleer wants exit/conceal,
//                                                           a raider/hunter wants a crowd)
//         − distance × wNear                              (nearer is likelier).
// Fallbacks: a moving quarry with no fitting place → presume it keeps going along the
// heading toward the frontier; a still quarry → stand-and-search at lastPos. It writes
// belief.destId (a Place.id) / destPos / intent / destInferredAt. Reads ONLY the shared
// static `map` + the belief itself — no live roster, no foreign truth. Pure; never throws.
//   `observer` — the pursuer (its townId scopes which places it knows).
//   `belief`   — the BeliefState about the quarry (already updated to last sighting).
//   `intent`   — 'flee'|'raid'|'hunt'|null, computed by the caller from context.
//   `map`      — the shared MentalMap (ctx.map); `now` — current sim-time (TTL stamp).
export function inferDestination(
  observer: { townId?: number | null } | null | undefined,
  belief: BeliefState | null | undefined,
  intent: string | null,
  map: MentalMap | null | undefined,
  now: number,
) {
  try {
    if (!belief || !map) return;
    const last = belief.lastPos;
    const hx = belief.heading.x, hz = belief.heading.z;
    const moving = Math.hypot(hx, hz) > 1e-3;
    const places = map.known(observer && observer.townId, last, MAP.knownPlaces);

    let best: Place | null = null, score = -Infinity;
    for (const place of places) {
      let s = 0;
      if (moving) s += headingMatch(hx, hz, last, place, map) * MAP.wHeading;
      if (intent === 'flee') s += (place.affords('exit', 'conceal') ? MAP.wAfford : -MAP.wAfford);
      else if (intent === 'raid' || intent === 'hunt') s += (place.affords('crowd') ? MAP.wAfford : 0);
      s -= map.cost(last, place) * MAP.wNear;
      if (s > score) { score = s; best = place; }
    }

    if (best && score > -Infinity) {
      belief.destId = best.id;
      belief.destPos = best.pos.clone();
      belief.intent = intent;
    } else if (moving) {
      // no known place fits: presume it keeps going a bounded distance along the heading
      // toward the frontier (still a static, derived point — not a live read).
      const reach = Math.min(ARENA_RADIUS, SIM.visionRange * 1.6);
      belief.destPos = new THREE.Vector3(last.x + hx * reach, 0, last.z + hz * reach);
      belief.destId = null;
      belief.intent = intent;
    } else {
      // heading unknown → stand-and-search where last seen.
      belief.destPos = new THREE.Vector3(last.x, 0, last.z);
      belief.destId = null;
      belief.intent = null;
    }
    belief.destInferredAt = now || 0;
  } catch { /* never throw on the tick */ }
}

// headingMatch — the dot of the quarry's unit heading with the unit direction from its
// last position to a candidate place, clamped to [0,1] (a place BEHIND the heading scores
// 0). The doc's headingMatch(b.lastHeading, map.dirTo(b.lastPos, place)). Static math.
const _dir = new THREE.Vector3();
function headingMatch(hx: number, hz: number, fromPos: THREE.Vector3, place: Place, map: MentalMap) {
  map.dirTo(fromPos, place, _dir);
  const dot = hx * _dir.x + hz * _dir.z;
  return dot > 0 ? (dot > 1 ? 1 : dot) : 0;
}
