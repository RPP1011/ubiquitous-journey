// Reputation & factions: the RPG layer's social ledger for the player. Standing
// is NOT a single global number — it lives where opinions actually live: in each
// NPC's BeliefState.standing toward the player (the same -1..1 field the ToM
// layer already gossips and decays). On top of those personal opinions we keep a
// coarse per-FACTION rollup so a faction can sour toward the player wholesale
// (and so freshly-seen NPCs inherit a starting bias from their faction).
//
// Deeds are WITNESSED, not omniscient: a kind or cruel act only moves the
// standing of NPCs who actually saw it (within SIM.visionRange), plus a damped
// faction-wide bump. Standing then drifts back toward each NPC's faction bias
// over time (decay) so reputation is a living, fading thing — matching the
// belief layer's confidence/suspicion decay model.

import { SIM, FACTIONS, factionHostile } from './simconfig.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Deed table: each deed moves the *personal* standing of every witness and adds
// a smaller *faction*-wide nudge (rollup). Signs: positive = likes you more.
export const REP = {
  deeds: {
    HELPED:         { personal:  0.20, faction:  0.05, label: 'helped them' },
    QUEST_DONE:     { personal:  0.35, faction:  0.12, label: 'did a job for them' },
    KILLED_MONSTER: { personal:  0.18, faction:  0.10, label: 'slew a monster' },
    ATTACKED_NPC:   { personal: -0.40, faction: -0.12, label: 'attacked one of them' },
    KILLED_NPC:     { personal: -0.70, faction: -0.30, label: 'killed one of them' },
    THEFT:          { personal: -0.30, faction: -0.10, label: 'stole from them' },
  },

  priceFavorMax: 0.15,    // a beloved player buys 15% cheaper / sells 15% dearer
  hostileThreshold: -0.6, // standing below this turns an NPC hostile to the player
  decayPerSec: 1 / 360,   // personal standing drifts back toward faction bias / 6min
  factionDecayPerSec: 1 / 900, // faction rollups fade toward neutral more slowly
};

export class Reputation {
  // playerId is needed so we only ever touch the player's slot in each NPC's
  // belief store (NPC↔NPC opinions are the sim's business, not ours).
  constructor(playerId = null) {
    this.playerId = playerId;
    // coarse per-faction opinion of the player (-1..1). Outsider is the player's
    // own faction so it starts (and stays) friendly to itself.
    this.faction = {};
    for (const f in FACTIONS) this.faction[f] = f === 'outsider' ? 1 : 0;
  }

  setPlayer(id) { this.playerId = id; }

  // --- reads ----------------------------------------------------------------

  // What this NPC thinks of the player, in -1..1. Falls back to the NPC's
  // faction bias when it holds no personal belief about the player yet.
  standing(npcAgent, playerId = this.playerId) {
    if (!npcAgent || playerId == null) return 0;
    const b = npcAgent.beliefs.get(playerId);
    if (b) return clamp(b.standing, -1, 1);
    return this.factionStanding(npcAgent.faction);
  }

  factionStanding(faction) { return this.faction[faction] ?? 0; }

  // Will this NPC treat the player as an enemy on reputation grounds alone?
  // (isHostile in simulation.js already checks standing < hostileThreshold; this
  // is the same predicate exposed for UI / dialogue gating.)
  isHostileTo(npcAgent, playerId = this.playerId) {
    return this.standing(npcAgent, playerId) < REP.hostileThreshold;
  }

  // A short human-readable label for "what they think of you" (inspector/dialogue).
  describe(npcAgent, playerId = this.playerId) {
    const s = this.standing(npcAgent, playerId);
    if (s <= REP.hostileThreshold) return 'hostile';
    if (s < -0.25) return 'wary';
    if (s < 0.05) return 'neutral';
    if (s < 0.35) return 'friendly';
    if (s < 0.7) return 'trusts you';
    return 'devoted';
  }

  // --- writes ---------------------------------------------------------------

  // Coarse faction-wide nudge toward the player.
  bumpFaction(faction, delta) {
    if (faction == null) return;
    if (this.faction[faction] == null) this.faction[faction] = 0;
    this.faction[faction] = clamp(this.faction[faction] + delta, -1, 1);
  }

  // Apply a single deed to one NPC witness: move its personal standing toward
  // the player and record the deed on its BeliefState (so the inspector / gossip
  // can surface *why* it feels that way). Returns the witness's new standing.
  applyDeedTo(witness, deedKey, now = 0, playerId = this.playerId) {
    const deed = REP.deeds[deedKey];
    if (!deed || !witness || playerId == null || witness.id === playerId) return 0;
    // _ensure isn't public; observe()/get() are. The player has surely been
    // perceived if witnessed a deed, but be defensive and create-on-demand.
    let b = witness.beliefs.get(playerId);
    if (!b) {
      // seed a neutral personal slot (mirrors observe()'s "ground truth"
      // provenance) so the deed has a baseline to move from.
      b = witness.beliefs.observe(playerId, 'outsider', witness.pos, now, false);
      b.standing = 0;
    }
    b.standing = clamp(b.standing + deed.personal, -1, 1);
    if (deed.personal < -0.001) b.hostile = b.standing < REP.hostileThreshold;
    // record the deed for provenance (bounded, newest-first)
    b.knownDeeds.unshift({ deed: deedKey, label: deed.label, t: now });
    if (b.knownDeeds.length > 6) b.knownDeeds.length = 6;
    return b.standing;
  }

  // Witness a player deed at a position: every NPC within SIM.visionRange that
  // can "see" it updates its personal opinion, and the relevant factions take a
  // damped wholesale nudge. `subjectId` is the directly-involved NPC (e.g. the
  // one attacked / helped), which always counts as a witness even if its faction
  // differs. Returns the number of witnesses affected.
  //
  // agents: full agent list; pos: THREE.Vector3 of where it happened.
  witnessDeed(agents, deedKey, pos, now = 0, subjectId = null, playerId = this.playerId) {
    const deed = REP.deeds[deedKey];
    if (!deed || playerId == null) return 0;
    const factionsHit = new Set();
    let n = 0;
    for (const w of agents) {
      if (!w || !w.alive || w.controlled || w.id === playerId) continue;
      const seen = w.id === subjectId || (pos && w.pos.distanceTo(pos) <= SIM.visionRange);
      if (!seen) continue;
      this.applyDeedTo(w, deedKey, now, playerId);
      factionsHit.add(w.faction);
      n++;
    }
    // faction rollup (once per affected faction, not per-witness)
    for (const f of factionsHit) this.bumpFaction(f, deed.faction);
    return n;
  }

  // --- pricing --------------------------------------------------------------

  // Adjust a base price for the player as counterparty, given an NPC's standing.
  // `selling` = the NPC is selling TO the player (favoured player pays less);
  // when the NPC is buying FROM the player a favoured player is paid more, so we
  // flip the sign. standing in -1..1 maps linearly to ±priceFavorMax.
  favoredPrice(base, standing, selling = true) {
    const favor = clamp(standing, -1, 1) * REP.priceFavorMax;
    const factor = selling ? (1 - favor) : (1 + favor);
    return +(base * factor).toFixed(2);
  }

  // --- decay ----------------------------------------------------------------

  // Personal standings drift back toward each NPC's faction bias; faction
  // rollups fade toward neutral. Call once per frame (dt seconds) from the sim.
  decay(dt, agents = null, playerId = this.playerId) {
    // faction rollups -> 0 (outsider stays pinned friendly to itself)
    for (const f in this.faction) {
      if (f === 'outsider') continue;
      const k = Math.min(1, REP.factionDecayPerSec * dt);
      this.faction[f] += (0 - this.faction[f]) * k;
    }
    if (!agents || playerId == null) return;
    const k = Math.min(1, REP.decayPerSec * dt);
    for (const w of agents) {
      if (!w || w.controlled || w.id === playerId) continue;
      const b = w.beliefs.get(playerId);
      if (!b) continue;
      const bias = this.factionStanding(w.faction);
      b.standing += (bias - b.standing) * k;
      if (b.hostile && b.standing >= REP.hostileThreshold) b.hostile = false; // un-latch once forgiven
    }
  }
}
