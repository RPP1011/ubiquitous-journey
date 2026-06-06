// The Theory-of-Mind core: every agent (observer) holds a bounded table of
// BeliefStates about other agents (subjects). Beliefs are produced by direct
// perception (confidence 1.0), propagated by gossip (confidence-capped, with
// provenance), planted by deception, and decayed over time.
//
// This mirrors the spec's `belief(observer, subject) -> T` pair-map (the N²
// "what A thinks about B" layer) and the Source/confidence provenance model.

import * as THREE from 'three';
import { SIM, SOURCE, HEARSAY } from './simconfig.js';

const clampStanding = (s) => Math.max(-1, Math.min(1, s));

// How garbled is a belief? `hops` is its provenance depth: 0 = seen first-hand,
// and every social retelling adds one (capped). The narrative layer reads this to
// hedge what it prints ("as told thirdhand"); the sim reads it to garble further.
export function provenanceLabel(b) {
  const h = (b && b.hops) || 0;
  if (!b || b.source === SOURCE.WITNESSED.tag || h <= 0) return 'seen first-hand';
  if (h === 1) return 'heard from a witness';
  if (h === 2) return 'secondhand';
  if (h === 3) return 'a thirdhand rumour';
  return 'a tale much retold';
}
// a compact tag for tight UI (the inspector belief rows).
export function provenanceTag(b) {
  const h = (b && b.hops) || 0;
  if (!b || b.source === SOURCE.WITNESSED.tag || h <= 0) return 'seen';
  if (h === 1) return 'heard';
  if (h === 2) return '2nd-hand';
  if (h === 3) return 'rumour';
  return 'hearsay';
}

export class BeliefState {
  constructor(subjectId) {
    this.subjectId = subjectId;
    this.lastFaction = null;     // believed faction (a disguise can fake this)
    this.lastPos = new THREE.Vector3();
    this.lastTick = 0;
    this.confidence = 0;         // 0..1, decays over time
    this.hostile = false;        // do I think this agent is hostile to me?
    this.suspicion = 0;          // 0..1, "something's off about them"
    this.standing = 0;           // -1..1, my opinion of this subject (reputation)
    this.knownDeeds = [];        // recent deeds I've witnessed/heard about them
    this.source = SOURCE.WITNESSED.tag;
    this.hops = 0;               // provenance depth (0 = first-hand; grows with each retelling)
    this.rumorBorn = false;      // this hostility was curdled from gossip, not witnessed
  }
}

export class BeliefStore {
  constructor(observerId) {
    this.observerId = observerId;
    this.map = new Map();        // subjectId -> BeliefState
  }

  get(subjectId) { return this.map.get(subjectId) || null; }
  all() { return this.map.values(); }

  _ensure(subjectId) {
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
    let worst = null, worstScore = Infinity;
    for (const b of this.map.values()) {
      const score = b.confidence - (b.hostile ? 0.5 : 0) - b.suspicion * 0.3;
      if (score < worstScore) { worstScore = score; worst = b; }
    }
    if (worst) this.map.delete(worst.subjectId);
  }

  // Direct sighting: overwrite with ground truth at full confidence. Seeing for
  // yourself RESETS provenance — a first-hand look beats any tale (hops -> 0).
  observe(subjectId, perceivedFaction, pos, tick, hostile) {
    const b = this._ensure(subjectId);
    b.lastFaction = perceivedFaction;
    b.lastPos.copy(pos);
    b.lastTick = tick;
    b.confidence = SOURCE.WITNESSED.conf;
    b.source = SOURCE.WITNESSED.tag;
    b.hops = 0;
    if (hostile) b.hostile = true;       // sighting hostility latches on
    return b;
  }

  // Social merge: adopt another agent's belief if it's more certain than ours.
  // Confidence is capped (second-hand) and faded (per hop) — provenance-aware —
  // and the CONTENT garbles in the retelling (the telephone game): see _garble.
  mergeFrom(other /* BeliefState */, src /* SOURCE.* */) {
    if (!other) return;
    const incoming = Math.min(other.confidence * SIM.gossipFalloff, src.conf, SIM.gossipCap);
    let b = this.map.get(other.subjectId);
    if (b && b.confidence >= incoming) {
      // we already know it fresher — keep our facts, but talk still colours opinion.
      if (other.hostile) b.hostile = true;
      b.suspicion = Math.max(b.suspicion, other.suspicion * 0.6);
      this._garble(b, other, false);
      return;
    }
    b = this._ensure(other.subjectId);
    b.lastFaction = other.lastFaction;
    b.lastPos.copy(other.lastPos);
    b.lastTick = other.lastTick;
    b.confidence = incoming;
    b.source = src.tag;
    b.hops = Math.min(HEARSAY.maxHops, ((other.hops || 0) + 1));   // one more mouth removed
    if (other.hostile) b.hostile = true;
    b.suspicion = Math.max(b.suspicion, other.suspicion * 0.6);
    this._garble(b, other, true);
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
  _garble(b, other, adopt) {
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
        if (Math.random() < p) { b.hostile = true; b.source = SOURCE.RUMOR.tag; b.rumorBorn = true; }
      }
    } catch { /* never throw */ }
  }

  // Deception: forcibly write a (possibly false) belief into this store.
  plant(subjectId, { faction, pos, tick, hostile, suspicion, confidence }) {
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

  erase(subjectId) { this.map.delete(subjectId); }

  // Per-second decay of certainty and suspicion.
  decay(dt) {
    for (const b of this.map.values()) {
      b.confidence = Math.max(0, b.confidence - SIM.confidenceDecay * dt);
      b.suspicion = Math.max(0, b.suspicion - SIM.suspicionDecay * dt);
    }
  }
}
