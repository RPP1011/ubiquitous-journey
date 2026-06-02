// The Theory-of-Mind core: every agent (observer) holds a bounded table of
// BeliefStates about other agents (subjects). Beliefs are produced by direct
// perception (confidence 1.0), propagated by gossip (confidence-capped, with
// provenance), planted by deception, and decayed over time.
//
// This mirrors the spec's `belief(observer, subject) -> T` pair-map (the N²
// "what A thinks about B" layer) and the Source/confidence provenance model.

import * as THREE from 'three';
import { SIM, SOURCE } from './simconfig.js';

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

  // Direct sighting: overwrite with ground truth at full confidence.
  observe(subjectId, perceivedFaction, pos, tick, hostile) {
    const b = this._ensure(subjectId);
    b.lastFaction = perceivedFaction;
    b.lastPos.copy(pos);
    b.lastTick = tick;
    b.confidence = SOURCE.WITNESSED.conf;
    b.source = SOURCE.WITNESSED.tag;
    if (hostile) b.hostile = true;       // sighting hostility latches on
    return b;
  }

  // Social merge: adopt another agent's belief if it's more certain than ours.
  // Confidence is capped (second-hand) and faded (per hop) — provenance-aware.
  mergeFrom(other /* BeliefState */, src /* SOURCE.* */) {
    if (!other) return;
    const incoming = Math.min(other.confidence * SIM.gossipFalloff, src.conf, SIM.gossipCap);
    const b = this.map.get(other.subjectId);
    if (b && b.confidence >= incoming) {
      // we already know better — but still pick up hostility/suspicion/standing hints
      if (other.hostile) b.hostile = true;
      b.suspicion = Math.max(b.suspicion, other.suspicion * 0.6);
      b.standing += (other.standing - b.standing) * SIM.gossipFalloff * 0.5;
      return;
    }
    const dst = this._ensure(other.subjectId);
    dst.lastFaction = other.lastFaction;
    dst.lastPos.copy(other.lastPos);
    dst.lastTick = other.lastTick;
    dst.confidence = incoming;
    dst.source = src.tag;
    if (other.hostile) dst.hostile = true;
    dst.suspicion = Math.max(dst.suspicion, other.suspicion * 0.6);
    // reputation spreads second-hand (toward the gossiper's opinion, damped)
    dst.standing += (other.standing - dst.standing) * SIM.gossipFalloff * 0.5;
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
