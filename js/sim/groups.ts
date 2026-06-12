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

import { BAND, GROUP_TYPES, GROUP_NAMES, HALL } from './simconfig.js';
import { rng } from './rng.js';
import { isHomeBuilder, BUILD_KIND } from './construction.js';

// `sim` (the owning Simulation — wave-2, still .js) and the agents (via their long-tail
// band/group flags) are typed opaquely on purpose; behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

// the per-type group config block, dynamically keyed by group-type name (GROUP_TYPES[type]).
const GROUP_TYPES_T = GROUP_TYPES as Record<string, { cohesion: string; combatant?: boolean; maxFollowers: number }>;

const adventurous = (a: Ag): boolean =>
  (a.ambition && (a.ambition.kind === 'renown' || a.ambition.kind === 'wanderlust')) ||
  (a.personality && a.personality.risk_tolerance > 0.6);
const homebody = (a: Ag): boolean => a.personality && a.personality.risk_tolerance < 0.45;

// the stable key of an agent's PRIMARY (strongest) class, or null. Occupation is
// emergent now, so professional kinship is "same dominant class", not "same
// profession". Guarded — never throws.
function primaryClassKey(a: Ag): string | null {
  const pc = a && a.progression && a.progression.primaryClass && a.progression.primaryClass();
  return pc ? pc.key : null;
}

// which kind of group a compatible, co-located pair forms (priority order)
function pickType(L: Ag, F: Ag): string {
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
  sim: Sim;
  _acc: number;
  // THE GUILDHALL: hall build-sites pending completion, keyed by the commissioning
  // group's anchor id. Drained each tick (_stampFinishedHalls) — on completion every
  // member is stamped `groupHallId` (execution side, like _join stamps groupName).
  _hallSites: Map<unknown, Ag>;

  constructor(sim: Sim) { this.sim = sim; this._acc = 0; this._hallSites = new Map(); }

  _playerId(): unknown { return this.sim.player ? this.sim.player.id : -1; }
  _eligible(a: Ag): boolean { return a && a.alive && a.autonomous && a.faction === 'townsfolk' && !a.watch && !isHomeBuilder(a); }
  _followersOf(id: unknown): Ag[] { return this.sim.agents.filter((x: Ag) => x.alive && x.bandLeaderId === id); }
  _isLeader(a: Ag): boolean { return this._followersOf(a.id).length > 0; }

  // fixed-tick: dissolve broken groups, then (throttled) try to grow one — and let
  // an enduring, funded fellowship raise (then move into) its hall.
  tick(ctx: unknown, dt: number): void {
    this._prune();
    this._stampFinishedHalls();
    this._acc += dt;
    if (this._acc < BAND.formEvery) return;
    this._acc = 0;
    this._form();
    this._maybeRaiseHalls();
  }

  _form(): void {
    // try a few distinct anchors per formation tick (not just one) so multiple
    // small groups reliably coexist — emergent occupations make any single pair's
    // TYPE noisier, so we lean on group VOLUME for a diverse town. Bounded.
    const anchors = this.sim.agents.filter((a: Ag) => this._eligible(a) && !a.inParty && a.bandLeaderId == null);
    if (!anchors.length) return;
    const tries = Math.min(BAND.formAttempts || 1, anchors.length);
    for (let t = 0; t < tries; t++) {
      const L = anchors[(rng() * anchors.length) | 0];
      this._formFrom(L);
    }
  }

  // attempt to grow ONE group anchored on L (the original single-anchor logic).
  _formFrom(L: Ag): void {
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
    const gt = GROUP_TYPES_T[type];
    if (existing.length >= gt.maxFollowers) return;
    this._join(best, L, type, gt);
  }

  _join(F: Ag, L: Ag, type: string, gt: { cohesion: string; combatant?: boolean; maxFollowers: number }): void {
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
    // LEGIBLE FELLOWSHIP (Phase B3): a fresh group coins a NAME (seeded rng — flavour only) and
    // every join files a round on its `fellowship` saga arc, so a band/guild/circle is a CHARACTER
    // in the chronicle with a beginning ("Wenna joined the Hearthside Circle") and, on dissolution
    // (_prune), an end. Lazy-open via appendRound (a never-joined group files no tale). Keyed
    // `fellowship:<type>:<anchor>` — disjoint from the recruiter's `warband:<id>` muster arc.
    // Observer-layer bookkeeping only; guarded (never throws on the tick).
    try {
      const pool = (GROUP_NAMES as Record<string, string[]>)[type];
      if (!L.groupName && pool && pool.length) L.groupName = pool[(rng() * pool.length) | 0];
      F.groupName = L.groupName || null;
      // THE GUILDHALL: stamp the group's FORMATION time on the anchor at first join (the
      // endurance gate _maybeRaiseHalls ages against), and hand a late joiner the hall
      // the fellowship already raised (own-state stamp, like groupName above).
      if (L._groupFormedAt == null) L._groupFormedAt = this.sim.time || 0;
      F.groupHallId = L.groupHallId || null;
      if (this.sim.sagas) this.sim.sagas.appendRound(
        { kind: 'fellowship', key: 'fellowship:' + type + ':' + L.id, principals: [L.id, F.id] },
        `${F.name} joined ${L.groupName || 'the ' + type} of ${L.name}.`);
    } catch { /* never throw */ }
  }

  // PUBLIC band-join used by the RECRUITER follow-through (WARBAND, docs/architecture/10-lld
  // §19 item 4): a candidate that has formed its OWN decision to join an NPC leader's warband
  // (decided in cognition — recruiter.ts' deriver, off the follower's own _offers/standing/
  // personality) requests the flag flip HERE, on the EXECUTION side, through the SAME _join path
  // every emergent band uses. No parallel system: this only flips the existing band flags
  // (inParty / bandLeaderId / groupType:'warband' / partySlot / combatant) exactly like
  // Party.recruit. Guards everything (the freeze lesson); returns whether the agent joined.
  joinWarband(F: Ag, leaderId: unknown, cap: number): boolean {
    try {
      if (!F || !F.alive || F.controlled) return false;
      if (F.inParty || F.bandLeaderId != null) return false;     // already banded
      if (F.faction === 'monster' || !F.autonomous) return false;
      const L = this.sim.agentsById.get(leaderId);
      if (!L || !L.alive || L === F || L.controlled) return false;
      if (L.faction === 'monster') return false;                 // peers, not a monster's thralls
      const gt = GROUP_TYPES_T.warband;
      if (!gt) return false;
      const limit = Math.max(1, Math.min(cap || gt.maxFollowers, gt.maxFollowers));
      if (this._followersOf(L.id).length >= limit) return false; // band is full
      this._join(F, L, 'warband', gt);
      // WARBAND ARC (docs/architecture/12 §3.5): a fresh follower is an escalation round on the
      // leader's muster arc ("N now ride with them"); re-arms its TTL. The arc opens LAZILY HERE on the
      // first follower (never eagerly at muster — a never-escalated muster files no tale). Observer; guarded.
      try { if (this.sim.sagas) this.sim.sagas.appendRound({ kind: 'warband', key: 'warband:' + L.id, principals: [L.id] }, `${F.name} rode to ${L.name}'s banner.`); } catch { /* never throw */ }
      return true;
    } catch { return false; }
  }

  // ── THE GUILDHALL: a named fellowship gets a PLACE ────────────────────────────
  // A person is a wandering target; a hall makes the group feel real. A LOOSE group
  // (guild/circle) that has ENDURED (≥ HALL.minMembers members for ≥ HALL.minAgeSecs
  // since formation) and whose anchor holds the wood commissions a hall near the town
  // core through the SAME public-works machinery the tavern uses (commissionPublic →
  // the CityGrid plot + ambient town labour). The anchor BANKS its wood into the site
  // (a real inventory, conserved — no minting). Execution side: this walks the roster
  // legally; cognition only ever sees the own-state stamp + its own place-belief.
  _maybeRaiseHalls(): void {
    try {
      const bs = this.sim.buildSites;
      if (!bs || !bs.commissionPublic) return;
      const now = this.sim.time || 0;
      for (const L of this.sim.agents) {
        if (!L.alive || L.controlled || !L.groupType || L.bandLeaderId != null) continue;
        const gt = GROUP_TYPES_T[L.groupType];
        if (!gt || gt.cohesion !== 'loose') continue;             // halls are a LOOSE-group thing
        if (L.groupHallId != null || this._hallSites.has(L.id)) continue;   // has / awaits one
        // ENDURANCE: stamp a formation time if none exists (pre-hall groups), then age-gate.
        if (L._groupFormedAt == null) { L._groupFormedAt = now; continue; }
        if ((now - L._groupFormedAt) < HALL.minAgeSecs) continue;
        if (1 + this._followersOf(L.id).length < HALL.minMembers) continue; // not grown yet
        const wood = (L.inventory && L.inventory.wood) || 0;
        if (wood < HALL.woodCost) continue;                       // unfunded — keep gathering
        const town = this._townOf(L.townId);
        if (!town) continue;
        const site = bs.commissionPublic(town, BUILD_KIND.GUILDHALL, null, { time: now });
        if (!site) continue;                                      // city full — try later
        // the anchor banks the hall's wood into the site (conserved commodity transfer).
        L.inventory.wood = wood - HALL.woodCost;
        site.woodHave = Math.min(site.woodNeeded, HALL.woodCost);
        site.groupName = L.groupName || null;                     // the chronicle names the hall
        this._hallSites.set(L.id, site);
        // a round on the fellowship's saga: the ambition declared. Observer; guarded.
        try {
          if (this.sim.sagas) this.sim.sagas.appendRound(
            { kind: 'fellowship', key: 'fellowship:' + L.groupType + ':' + L.id, principals: [L.id] },
            `${L.groupName || 'the ' + L.groupType} of ${L.name} laid the foundations of a hall.`);
        } catch { /* never throw */ }
      }
    } catch { /* never throw on the tick */ }
  }

  // Drain pending hall sites: when one finishes, stamp `groupHallId` (the building's
  // percept/place id) on the anchor AND every current member — execution side, exactly
  // like _join stamps groupName. Members still DISCOVER the hall by sight (the place-
  // belief decide reads is filed by their own perception); the stamp only tells them
  // which building is THEIRS. A group that dissolved mid-build forfeits its claim (the
  // hall, if it still rises, persists as a town building — abandoned halls are flavour).
  _stampFinishedHalls(): void {
    if (!this._hallSites.size) return;
    try {
      const bs = this.sim.buildSites;
      for (const [anchorId, site] of this._hallSites) {
        const L = this.sim.agentsById.get(anchorId);
        if (!L || !L.alive || !L.groupType) { this._hallSites.delete(anchorId); continue; }
        if (!site.done) {
          // ABANDONED (spliced from the active sites without finishing)? Drop the claim
          // so an enduring group may commission again once re-funded.
          if (bs && bs.siteById && !bs.siteById(site.id)) this._hallSites.delete(anchorId);
          continue;
        }
        if (!site.building) { this._hallSites.delete(anchorId); continue; }
        const hid = site.building.id;
        L.groupHallId = hid;
        for (const F of this._followersOf(anchorId)) F.groupHallId = hid;
        this._hallSites.delete(anchorId);
        // LEGIBILITY: the fellowship's saga gets its hall-raising round. (The chronicle
        // beat — "X raised its hall in <town>" — is filed by construction._finalize.)
        try {
          if (this.sim.sagas) this.sim.sagas.appendRound(
            { kind: 'fellowship', key: 'fellowship:' + L.groupType + ':' + L.id, principals: [L.id] },
            `${L.groupName || 'the ' + L.groupType} of ${L.name} raised its hall.`);
        } catch { /* never throw */ }
      }
    } catch { /* never throw on the tick */ }
  }

  // the anchor's town record (for the hall's plot claim). Guarded; falls back to town 0.
  _townOf(townId: unknown): { id: unknown } | null {
    try {
      const towns = this.sim.towns || [];
      for (const tw of towns) if (tw.id === townId) return tw;
      return towns[0] || null;
    } catch { return null; }
  }

  _prune(): void {
    const pid = this._playerId();
    for (const F of this.sim.agents) {
      if (F.controlled) continue;
      if (F.bandLeaderId != null && F.bandLeaderId !== pid) {
        const L = this.sim.agentsById.get(F.bandLeaderId);
        if (F.alive && (!L || !L.alive)) {
          // CLOSE THE TALE (Phase B3): the leader's death/vanishing ends the fellowship —
          // file the close BEFORE the flags are cleared (we still know type + leader id).
          // closeArc on a never-opened key is a no-op; guarded.
          try { if (this.sim.sagas && F.groupType) this.sim.sagas.closeArc('fellowship:' + F.groupType + ':' + F.bandLeaderId, 'disbanded'); } catch { /* never throw */ }
          this._revert(F);                                         // leader gone -> dissolve
        }
      } else if (F.groupType && F.bandLeaderId == null) {
        if (!F.alive || this._followersOf(F.id).length === 0) {
          // empty anchor: the fellowship has dwindled to one — close its tale + drop the label.
          // The hall claim goes too (the building persists as a town building — abandoned
          // halls are flavour); a pending site forfeits its stamp (_stampFinishedHalls guard).
          try { if (this.sim.sagas) this.sim.sagas.closeArc('fellowship:' + F.groupType + ':' + F.id, 'disbanded'); } catch { /* never throw */ }
          F.groupType = null; F.groupName = null;
          F.groupHallId = null; F._groupFormedAt = null;
          this._hallSites.delete(F.id);
        }
      }
    }
  }

  _revert(F: Ag): void {
    if (F._bandRestore) { F.combatant = F._bandRestore.combatant; F.goal = F._bandRestore.goal; F._bandRestore = null; }
    else F.goal = { kind: F.canWork ? 'work' : 'wander' };
    F.inParty = false;
    F.bandLeaderId = null;
    F.groupType = null;
    F.groupName = null;
    F.groupHallId = null;   // the fellowship's hall is no longer this member's gathering point
  }

  // restore every NPC-group member (world teardown). Leaves the player's party alone.
  disband(): void {
    const pid = this._playerId();
    for (const F of this.sim.agents) if (F.bandLeaderId != null && F.bandLeaderId !== pid) this._revert(F);
    this._hallSites.clear();
  }
}
