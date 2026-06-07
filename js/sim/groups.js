// Social groups: parties as an AI abstraction BEYOND the player, in several
// TYPES (see GROUP_TYPES in simconfig). Townsfolk who like each other (mutual
// positive belief-standing — emergent from gossip familiarity) and are near each
// other associate. The PAIR's ambitions / professions / temperament decide which
// kind of group they form:
//
//   warband  travel + combatant   — adventurous pair: roam and fight together
//   hearth   travel + flee        — homebodies: stick together, flee danger
//   guild    loose                — same trade: cluster as professional allies
//   circle   loose                — friends: gather to socialise
//
// "travel" members flip inParty and reuse Agent._decideParty + the follow steer-fill
// (fillFollow in agent/steer.js — the same path the player's companions use, since
// Phase 2b the steering substrate), now pointed at their own leader.
// "loose" members don't follow — membership is an affiliation tag that biases
// behaviour (Agent.decide) and reads in the relations view. No new AI fork.
//
// Kept separate from the player's Party: this never touches a member whose leader
// is the player, so recruited companions and emergent NPC groups coexist.

import { BAND, GROUP_TYPES } from './simconfig.js';
import { isHomeBuilder } from './construction.js';

const adventurous = (a) =>
  (a.ambition && (a.ambition.kind === 'renown' || a.ambition.kind === 'wanderlust')) ||
  (a.personality && a.personality.risk_tolerance > 0.6);
const homebody = (a) => a.personality && a.personality.risk_tolerance < 0.45;

// the stable key of an agent's PRIMARY (strongest) class, or null. Occupation is
// emergent now, so professional kinship is "same dominant class", not "same
// profession". Guarded — never throws.
function primaryClassKey(a) {
  const pc = a && a.progression && a.progression.primaryClass && a.progression.primaryClass();
  return pc ? pc.key : null;
}

// which kind of group a compatible, co-located pair forms (priority order)
function pickType(L, F) {
  if (adventurous(L) && adventurous(F)) return 'warband';
  // guild = same TRADE, which with emergent occupations means the pair has earned
  // the SAME PRIMARY CLASS (e.g. both [Farmer]). We require a real shared class —
  // NOT a transient shared _trade — so guilds only form once an identity has
  // emerged; before that, kinship pairs read as hearths/circles (variety).
  const lk = primaryClassKey(L), fk = primaryClassKey(F);
  if (lk && fk && lk === fk) return 'guild';
  if (homebody(L) && homebody(F)) return 'hearth';
  return 'circle';
}

export class Groups {
  constructor(sim) { this.sim = sim; this._acc = 0; }

  _playerId() { return this.sim.player ? this.sim.player.id : -1; }
  _eligible(a) { return a && a.alive && a.autonomous && a.faction === 'townsfolk' && !a.watch && !isHomeBuilder(a); }
  _followersOf(id) { return this.sim.agents.filter((x) => x.alive && x.bandLeaderId === id); }
  _isLeader(a) { return this._followersOf(a.id).length > 0; }

  // fixed-tick: dissolve broken groups, then (throttled) try to grow one
  tick(ctx, dt) {
    this._prune();
    this._acc += dt;
    if (this._acc < BAND.formEvery) return;
    this._acc = 0;
    this._form();
  }

  _form() {
    // try a few distinct anchors per formation tick (not just one) so multiple
    // small groups reliably coexist — emergent occupations make any single pair's
    // TYPE noisier, so we lean on group VOLUME for a diverse town. Bounded.
    const anchors = this.sim.agents.filter((a) => this._eligible(a) && !a.inParty && a.bandLeaderId == null);
    if (!anchors.length) return;
    const tries = Math.min(BAND.formAttempts || 1, anchors.length);
    for (let t = 0; t < tries; t++) {
      const L = anchors[(Math.random() * anchors.length) | 0];
      this._formFrom(L);
    }
  }

  // attempt to grow ONE group anchored on L (the original single-anchor logic).
  _formFrom(L) {
    if (!L || L.inParty || L.bandLeaderId != null) return;
    // if L already anchors a group its type is fixed; else it's chosen per-pair
    const existing = this._followersOf(L.id);
    const fixedType = existing.length ? existing[0].groupType : null;

    let best = null, bd = BAND.joinRange * BAND.joinRange;
    for (const F of this.sim.agents) {
      if (!this._eligible(F) || F === L || F.inParty || F.bandLeaderId != null || this._isLeader(F)) continue;
      const lf = L.beliefs.get(F.id), fl = F.beliefs.get(L.id);   // must mutually like each other
      if (!lf || !fl || lf.standing < BAND.joinStanding || fl.standing < BAND.joinStanding) continue;
      const d = L.pos.distanceToSquared(F.pos);
      if (d < bd) { bd = d; best = F; }
    }
    if (!best) return;

    const type = fixedType || pickType(L, best);
    const gt = GROUP_TYPES[type];
    if (existing.length >= gt.maxFollowers) return;
    this._join(best, L, type, gt);
  }

  _join(F, L, type, gt) {
    F._bandRestore = { combatant: F.combatant, goal: F.goal };
    F.bandLeaderId = L.id;
    F.groupType = type;
    F.partySlot = this._followersOf(L.id).length;     // existing followers -> ring slot
    L.groupType = type;                               // tag the anchor too (for the UI)
    if (gt.cohesion === 'travel') {
      F.inParty = true;                               // routes to _decideParty next tick
      F.goal = { kind: 'follow' };
      if (gt.combatant) F.combatant = true;           // warbands stand and fight together
    }
    // loose groups: no follow — the tag alone biases decide() + reads in relations
  }

  _prune() {
    const pid = this._playerId();
    for (const F of this.sim.agents) {
      if (F.controlled) continue;
      if (F.bandLeaderId != null && F.bandLeaderId !== pid) {
        const L = this.sim.agentsById.get(F.bandLeaderId);
        if (F.alive && (!L || !L.alive)) this._revert(F);          // leader gone -> dissolve
      } else if (F.groupType && F.bandLeaderId == null) {
        if (!F.alive || this._followersOf(F.id).length === 0) F.groupType = null;  // empty anchor: drop label
      }
    }
  }

  _revert(F) {
    if (F._bandRestore) { F.combatant = F._bandRestore.combatant; F.goal = F._bandRestore.goal; F._bandRestore = null; }
    else F.goal = { kind: F.canWork ? 'work' : 'wander' };
    F.inParty = false;
    F.bandLeaderId = null;
    F.groupType = null;
  }

  // restore every NPC-group member (world teardown). Leaves the player's party alone.
  disband() {
    const pid = this._playerId();
    for (const F of this.sim.agents) if (F.bandLeaderId != null && F.bandLeaderId !== pid) this._revert(F);
  }
}
