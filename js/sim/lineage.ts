// LINEAGE: renewal-without-aging drama (docs/drama-plan.md §2). Three threads:
//
//   BIRTHS         — a mutually-fond, SAFE + FED pair, over time, bears a CHILD
//                    townsperson. The child inherits a blend of the parents'
//                    personality + a fraction (~30%) of their behaviour tags, so
//                    trades/temperaments run in families. Gated on STABILITY so a
//                    town under siege stops having children and a town at peace
//                    grows (the population feedback loop). Growth is soft-capped;
//                    Director raids are the real population control.
//   APPRENTICESHIP — a young/low-total-level townsperson learns from a nearby
//                    high-class master: ~30% of the master's dominant behaviour
//                    tags are COPIED onto the apprentice (fast-tracking that
//                    class), and a mentorship bond memory is recorded on both.
//
// CONSTRAINTS honoured here:
//  * never throw / never stall the fixed tick — every pass is fully guarded.
//  * GOLD CONSERVED — a child is born with gold 0 OR a small dowry that is MOVED
//    (debited from a parent, credited to the child), never minted.
//  * decisions read beliefs — births read the pair's mutual belief-standing.
//  * population is BOUNDED by config (popSoftCap).
//
// Self-throttled: Simulation just calls lineage.tick(ctx, step) on the fixed loop.

import * as THREE from 'three';
import { rng } from './rng.js';
import { Agent } from './agent.js';
import { LINEAGE, SIM } from './simconfig.js';
import { terrainHeight } from '../arena.js';
import { assignHouse, areHousesFeuding, endHouseFeud, feudingHouseOf } from './houses.js';

// `sim`/`ctx` (the owning Simulation + cognition context — wave-2, still .js) and the
// parent/child/master/apprentice Agents (via their kin/mate/master flags) are typed
// opaquely on purpose; behaviour is unchanged (gold conserved, beliefs read for safety).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

export class Lineage {
  sim: Sim;
  _acc: number;
  _appAcc: number;
  _gestating: Map<string, number>;
  _birthReady: Map<unknown, number>;
  _taught: Map<string, number>;
  births: number;
  apprenticeships: number;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;             // birth-pass throttle
    this._appAcc = 0;          // apprenticeship-pass throttle
    // per-pair gestation: pairKey -> accumulated stable sim-seconds. A pair that
    // qualifies this pass GAINS tickEvery; one that lapses (drifted apart, became
    // unsafe) DECAYS rather than resetting — so the ordinary wandering of fond
    // townsfolk doesn't perpetually abort a pregnancy, but a real disruption (a
    // raid, a break-up) still erodes it. Reaches gestationSecs -> a child.
    this._gestating = new Map();
    // per-agent birth cooldown: agentId -> sim-time it may parent again
    this._birthReady = new Map();
    // per-pair teaching cooldown: bondKey -> sim-time it may teach again
    this._taught = new Map();
    this.births = 0;           // lifetime tally (telemetry)
    this.apprenticeships = 0;
  }

  // fixed-tick entry (self-throttled). Never throws.
  tick(ctx: Ctx, dt: number): void {
    try {
      this._acc += dt;
      if (this._acc >= LINEAGE.tickEvery) {
        this._acc = 0;
        if (LINEAGE.birthEnabled) this._births(ctx);
      }
      this._appAcc += dt;
      if (this._appAcc >= LINEAGE.apprenticeEvery) {
        this._appAcc = 0;
        if (LINEAGE.apprenticeEnabled) this._apprenticeships(ctx);
        this._surpass();
        this._reconcileRivals();
        if (LINEAGE.feudGrudgeEnabled) this._feudGrudges();
      }
    } catch { /* never stall the fixed tick (the freeze lesson) */ }
  }

  // is `a` an alive, non-controlled, non-combatant townsperson? (a candidate
  // parent / apprentice / master — never a monster or the player)
  _civ(a: Ag): boolean {
    return a && a.alive && a.autonomous && !a.combatant && a.faction === 'townsfolk';
  }

  _livingTownsfolk(): number {
    return this.sim.agents.filter((a: any) => this._civ(a)).length;
  }

  // a parent is SAFE if it believes no hostile is within danger range, and FED if
  // its hunger is healthy. Births are gated on both (stability). Belief-only for
  // the safety read — decisions read beliefs, never ground truth.
  _safe(a: Ag, ctx: Ctx): boolean {
    const h = a._nearestHostile ? a._nearestHostile(ctx) : null;
    if (!h) return true;
    const d = a.pos.distanceTo(h.pos);
    return d > SIM.dangerRange;
  }
  _fed(a: Ag): boolean {
    return a.needs && a.needs.hunger >= LINEAGE.fedHunger;
  }

  // do A and B mutually like each other enough to pair-bond? (mutual belief
  // standing, OR an existing hearth bond between them). Belief-only read.
  _fond(A: Ag, B: Ag): boolean {
    // an established social bond (same group: one leads the other, or both follow
    // the same anchor) is the most reliable, persistent affinity the sim maintains
    // — a hearth especially (homebodies who stay together) reads as a couple.
    if (A.bandLeaderId === B.id || B.bandLeaderId === A.id) return true;
    if (A.bandLeaderId != null && A.bandLeaderId === B.bandLeaderId) return true;
    // otherwise: high mutual belief-standing (decisions read beliefs).
    const ab = A.beliefs.get(B.id), ba = B.beliefs.get(A.id);
    return !!(ab && ba && ab.standing >= LINEAGE.pairStanding && ba.standing >= LINEAGE.pairStanding);
  }

  _pairKey(a: Ag, b: Ag): string { return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`; }

  // BIRTHS pass --------------------------------------------------------------
  // Births run off PERSISTENT COUPLES (a.mateId), not a fresh proximity scan each
  // tick. A couple forms from a fond, co-located pair once; thereafter it GESTATES
  // on a bond basis — accumulating while both partners are fit (fed + safe + still
  // civilian), pausing/decaying when one isn't (a siege, a hungry season, a partner
  // marched off to a warband). This is what makes the population loop actually
  // PULSE: a peaceful town's couples reliably bear children (pop ↑), a besieged
  // town's don't (pop holds/↓) — without depending on two homebodies happening to
  // stand within a few metres for 30s straight (which almost never held).
  _births(ctx: Ctx): void {
    // the cap is PER TOWN — scale it by the number of towns so every town in the
    // open world sustains its own bloodlines (births are naturally within-town:
    // couples court by proximity).
    const towns = (this.sim.towns && this.sim.towns.length) || 1;
    if (this._livingTownsfolk() >= LINEAGE.popSoftCap * towns) { this._gestating.clear(); return; }
    const now = this.sim.time;
    const step = LINEAGE.tickEvery;
    const civs = this.sim.agents.filter((a: any) => this._civ(a));

    // (1) court: pair up some unattached, fond, co-located, fit townsfolk into
    // lasting couples (bounded — at most one new couple per pass).
    this._courtship(ctx, civs);

    // (2) gestate established couples.
    const seen = new Set();
    let bornThisPass = false;        // at most one birth per pass (bounded growth)
    for (const A of civs) {
      if (A.mateId == null) continue;
      const B = this.sim.agentsById.get(A.mateId);
      if (!B || !B.alive) { A.mateId = null; continue; }   // widowed -> free to re-pair
      if (A.id > B.id) continue;                           // visit each couple once
      if (!this._civ(B)) continue;                         // partner at war: pause (no decay churn)

      const fit = this._fed(A) && this._fed(B) && this._safe(A, ctx) && this._safe(B, ctx);
      if (!fit) continue;                                  // unfit couples fall through to decay below
      const key = this._pairKey(A, B);
      seen.add(key);
      const acc = Math.min(LINEAGE.gestationSecs, (this._gestating.get(key) || 0) + step);
      this._gestating.set(key, acc);

      if (!bornThisPass && acc >= LINEAGE.gestationSecs &&
          (this._birthReady.get(A.id) || 0) <= now && (this._birthReady.get(B.id) || 0) <= now) {
        if (this._birth(A, B, ctx)) {
          this._gestating.set(key, 0);                     // reset; the couple can bear again later
          this._birthReady.set(A.id, now + LINEAGE.birthCooldownSecs);
          this._birthReady.set(B.id, now + LINEAGE.birthCooldownSecs);
          bornThisPass = true;
        }
      }
    }

    // a couple that wasn't fit this pass DECAYS its gestation (doesn't hard-reset):
    // a brief scare shouldn't abort a pregnancy, but a real disruption (a raid, a
    // famine) erodes it — the population feedback loop.
    for (const key of [...this._gestating.keys()]) {
      if (seen.has(key)) continue;
      const v = (this._gestating.get(key) || 0) - step;
      if (v <= 0) this._gestating.delete(key);
      else this._gestating.set(key, v);
    }
  }

  // COURTSHIP — wed at most one new couple per pass. A candidate pair must both be
  // unattached, fond, fit (fed + safe), and currently within mateRange (they met).
  // Once wed the bond PERSISTS (a.mateId) and survives them drifting apart to work.
  _courtship(ctx: Ctx, civs: Ag[]): void {
    for (let i = 0; i < civs.length; i++) {
      const A = civs[i];
      if (A.mateId != null || !this._fed(A) || !this._safe(A, ctx)) continue;
      let best = null, bd = LINEAGE.mateRange * LINEAGE.mateRange;
      for (let j = i + 1; j < civs.length; j++) {
        const B = civs[j];
        if (B.mateId != null || !this._fond(A, B)) continue;
        if (!this._fed(B) || !this._safe(B, ctx)) continue;
        const d = A.pos.distanceToSquared(B.pos);
        if (d < bd) { bd = d; best = B; }
      }
      if (best) { this._wed(A, best); return; }            // one new couple per pass
    }
  }

  _wed(A: Ag, B: Ag): void {
    A.mateId = B.id; B.mateId = A.id;
    const t = this.sim.time;
    this._bond(A, B.id, t, 'mate');
    this._bond(B, A.id, t, 'mate');
    // a WEDDING — the warm counterpoint to all the bloodshed. A marriage across two
    // Houses JOINS their lines: a real alliance (their members warm to each other,
    // any lingering hostility cleared) and a saga-worthy union. Same/no-house weds
    // are a lighter beat in the rolling feed.
    const ch = this.sim.chronicle;
    const cross = A.house && B.house && A.house !== B.house;
    if (cross) {
      // ROMEO & JULIET (happy ending): a wedding across two FEUDING houses HEALS the
      // long feud — a saga-worthy reconciliation, not a tragedy.
      const healed = areHousesFeuding(this.sim, A.house, B.house);
      this._allyHouses(A.house, B.house);
      if (healed) endHouseFeud(this.sim, A.house, B.house);
      if (ch && ch.note) ch.note('union', A.id, healed
        ? `${A.name} and ${B.name} have wed — and the long feud between Houses ${A.house} and ${B.house} is ended.`
        : `${A.name} and ${B.name} have wed, uniting Houses ${A.house} and ${B.house}.`);
    } else if (ch && ch.note) {
      ch.note('union', A.id, `${A.name} and ${B.name} have wed.`);
    }
  }

  // a MARRIAGE ALLIANCE — warm every member of one house toward every member of the
  // other and clear any hostility between them (the union ties the two lines, and
  // can quietly end a simmering inter-house feud). Bounded: houses are small.
  _allyHouses(h1: string, h2: string): void {
    const here = (h: any) => this.sim.agents.filter((a: any) => a.alive && a.faction === 'townsfolk' && a.house === h);
    const m1 = here(h1), m2 = here(h2);
    for (const a of m1) for (const b of m2) {
      if (a === b) continue;
      for (const [x, y] of [[a, b], [b, a]]) {
        const rb = x.beliefs && x.beliefs._ensure ? x.beliefs._ensure(y.id) : null;
        if (rb) { rb.standing = Math.min(1, (rb.standing || 0) + 0.2); rb.hostile = false; }
      }
    }
  }

  // spawn one CHILD agent near its parents, inheriting blended personality + a
  // fraction of their behaviour tags. Gold conserved (0 or a MOVED dowry).
  // Returns true on success, false if anything prevented the birth (guarded).
  _birth(A: Ag, B: Ag, ctx: Ctx): boolean {
    try {
      const sim = this.sim;
      const px = (A.pos.x + B.pos.x) / 2 + (rng() * 4 - 2);
      const pz = (A.pos.z + B.pos.z) / 2 + (rng() * 4 - 2);
      const py = typeof document === 'undefined' ? 0 : terrainHeight(px, pz);

      const model = (A.fighter && A.fighter.characterKey) || 'knight';
      const fighter = sim.makeFighter(model, {});
      fighter.root.position.set(px, py, pz);
      sim.scene.add(fighter.root);

      const child = new Agent(fighter, {
        id: sim._nextId++,
        name: sim._takeName(),
        profession: null,
        personality: this._blendPersonality(A.personality, B.personality),
        faction: 'townsfolk',
        townsperson: true,
      });

      // HOME TOWN (open world): a child belongs to its parents' town, so it
      // lives/works/defends there instead of drifting to the world origin.
      child.townId = A.townId != null ? A.townId : B.townId;
      child.townAnchor = A.townAnchor || B.townAnchor;
      child.townRadius = A.townRadius || B.townRadius;

      // seed the child's behaviour profile from a fraction of each parent's
      // dominant tags, so trades/temperaments run in families. Additive (a tag a
      // child inherits from BOTH parents stacks). Guarded.
      this._inheritTags(child, A);
      this._inheritTags(child, B);

      // GOLD CONSERVED: a child starts with 0 gold by construction; if a dowry is
      // configured, MOVE it from the wealthier parent (debit parent, credit child)
      // — never minted. The dowry can never exceed what the parent holds.
      child.gold = 0;
      const dowry = Math.min(LINEAGE.dowry, this._richer(A, B).gold);
      if (dowry > 0) {
        const giver = this._richer(A, B);
        giver.gold -= dowry;
        child.gold += dowry;
      }

      sim.agents.push(child);
      sim.agentsById.set(child.id, child);

      // KIN GRAPH: a direct two-way link (child <-> each parent) so a death can
      // reach absent family for the orphan/widow vendetta arc (see combatEvents).
      child.kinIds = [A.id, B.id];
      (A.kinIds ||= []).push(child.id);
      (B.kinIds ||= []).push(child.id);

      // HOUSE: the child carries a parent's surname down the bloodline. Mark the
      // house as having borne a child so its eventual extinction is a "line ended"
      // beat worth telling (a lone childless founder dying is not a fallen House).
      const house = A.house || B.house;
      if (house) { assignHouse(child, house); if (sim._houseEverGrew) sim._houseEverGrew.add(house); }

      // INHERITED FEUD (multi-generational saga): a child born into a House that is at
      // FEUD takes up the family grudge — it grows up a sworn RIVAL of the enemy
      // bloodline (a living, un-rivalled member of the feuding house). The strife thus
      // outlives its founders, passing down the generations until a marriage heals it.
      try {
        if (house && !child.rivalId) {
          const enemyHouse = feudingHouseOf(sim, house);
          if (enemyHouse) {
            const foe = sim.agents.find((o: any) => o.alive && !o.controlled && o.faction === 'townsfolk' && o.house === enemyHouse && o.rivalId == null);
            if (foe) {
              child.rivalId = foe.id; foe.rivalId = child.id;
              if (sim.chronicle && sim.chronicle.note) sim.chronicle.note('vendetta', child.id, `${child.name} is born into the feud between Houses ${house} and ${enemyHouse} — and inherits the grudge.`);
            }
          }
        }
      } catch { /* never throw on the tick */ }

      // record the kinship as a bond memory on parents + child (the saga hook:
      // a killed parent -> orphaned child -> grows up -> avenges them).
      const t = sim.time;
      this._bond(A, child.id, t, 'kin');
      this._bond(B, child.id, t, 'kin');
      this._bond(child, A.id, t, 'kin');
      this._bond(child, B.id, t, 'kin');

      this.births++;
      return true;
    } catch { return false; }      // a failed birth must never stall the tick
  }

  _richer(A: Ag, B: Ag): Ag { return A.gold >= B.gold ? A : B; }

  _blendPersonality(pa: Record<string, number> | null | undefined, pb: Record<string, number> | null | undefined): Record<string, number> {
    const a = pa || {}, b = pb || {};
    const keys = ['risk_tolerance', 'social_drive', 'ambition', 'altruism', 'curiosity'];
    const out: Record<string, number> = {};
    for (const k of keys) {
      const base = ((a[k] ?? 0.5) + (b[k] ?? 0.5)) / 2;
      const j = (rng() * 2 - 1) * LINEAGE.personalityJitter;
      out[k] = clamp01(base + j);
    }
    return out;
  }

  // copy a FRACTION of a parent's top-N behaviour tags onto the child's profile.
  _inheritTags(child: Ag, parent: Ag): void {
    const bp = parent && parent.progression && parent.progression.behavior_profile;
    const cp = child && child.progression && child.progression.behavior_profile;
    if (!bp || !cp) return;
    const top = Object.keys(bp).sort((x, y) => bp[y] - bp[x]).slice(0, LINEAGE.inheritTagTop);
    for (const tag of top) {
      const add = bp[tag] * LINEAGE.inheritTagFraction;
      if (add > 0) cp[tag] = (cp[tag] || 0) + add;
    }
  }

  // APPRENTICESHIP pass ------------------------------------------------------
  // pair a young/low-total-level townsperson with a nearby high-class master of a
  // trade; copy a fraction of the master's dominant tags to fast-track that class.
  _apprenticeships(ctx: Ctx): void {
    const now = this.sim.time;
    const civs = this.sim.agents.filter((a: any) => this._civ(a));
    const masters = civs.filter((a: any) => this._totalLevel(a) >= LINEAGE.masterMinLevel);
    if (!masters.length) return;

    for (const app of civs) {
      if (this._totalLevel(app) > LINEAGE.apprenticeMaxLevel) continue;
      // nearest eligible master that this apprentice doesn't already match
      let master = null, bd = LINEAGE.masterRange * LINEAGE.masterRange;
      for (const m of masters) {
        if (m === app) continue;
        const key = `${m.id}->${app.id}`;
        if ((this._taught.get(key) || 0) > now) continue;
        const d = app.pos.distanceToSquared(m.pos);
        if (d < bd) { bd = d; master = m; }
      }
      if (!master) continue;
      if (this._teach(master, app, now)) {
        this._taught.set(`${master.id}->${app.id}`, now + LINEAGE.bondCooldownSecs);
      }
    }
  }

  _totalLevel(a: Ag): number {
    return (a && a.progression && a.progression.totalLevel) || 0;
  }

  // copy ~30% of the master's dominant behaviour tags onto the apprentice and
  // record a mentorship bond memory on both. Guarded; returns true on a session.
  _teach(master: Ag, app: Ag, now: number): boolean {
    try {
      const mp = master.progression && master.progression.behavior_profile;
      const ap = app.progression && app.progression.behavior_profile;
      if (!mp || !ap) return false;
      const top = Object.keys(mp).sort((x, y) => mp[y] - mp[x]).slice(0, LINEAGE.copyTagTop);
      if (!top.length) return false;
      let copied = false;
      for (const tag of top) {
        const add = mp[tag] * LINEAGE.copyTagFraction;
        if (add > 0) { ap[tag] = (ap[tag] || 0) + add; copied = true; }
      }
      if (!copied) return false;
      this._bond(app, master.id, now, 'mentor');
      this._bond(master, app.id, now, 'apprentice');
      this.apprenticeships++;
      return true;
    } catch { return false; }
  }

  // SURPASS — the payoff that closes the rival-apprentices arc: when an apprentice's
  // total level pulls clear of their living master (or old rival) by a margin, the
  // student has outgrown the teacher (or won the rivalry). Announced ONCE each.
  _surpass(): void {
    const margin = LINEAGE.surpassMargin || 2;
    for (const a of this.sim.agents) {
      if (!a.alive || a.controlled || a.faction !== 'townsfolk' || !a.progression) continue;
      const lvl = a.progression.totalLevel || 0;
      if (a.masterId != null && !a._surpassedMaster) {
        const m = this.sim.agentsById.get(a.masterId);
        if (m && m.alive && m.progression && m !== a && lvl >= (m.progression.totalLevel || 0) + margin) {
          a._surpassedMaster = true;
          this._noteSurpass(`${a.name} has surpassed ${m.name}, once their master.`, a.id);
        }
      }
      if (a.rivalId != null && !a._surpassedRival) {
        const r = this.sim.agentsById.get(a.rivalId);
        if (r && r.alive && r.progression && r !== a && lvl >= (r.progression.totalLevel || 0) + margin) {
          a._surpassedRival = true;
          this._noteSurpass(`${a.name} has outstripped ${r.name}, their old rival.`, a.id);
        }
      }
    }
  }

  _noteSurpass(text: string, id?: unknown): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('mentor', id == null ? -3 : id, text); } catch { /* never throw */ } }

  // RECONCILIATION — the peaceful end of a rivalry. Two long-standing rivals (the
  // durable `rivalId` bond, unlike a feud's standing which "forgiveness" drift erodes
  // in seconds) eventually set their strife aside and become friends — more readily
  // once one has surpassed the other (the contest is settled). The warm counterpoint
  // to all the vengeance. Across Houses it's a peace between two lines.
  _reconcileRivals(): void {
    for (const a of this.sim.agents) {
      if (!a.alive || a.controlled || a.faction !== 'townsfolk' || a.rivalId == null) continue;
      const b = this.sim.agentsById.get(a.rivalId);
      if (!b || !b.alive || b.rivalId !== a.id || a.id > b.id) continue;   // each living pair once
      const settled = a._surpassedRival || b._surpassedRival;             // the contest has a victor
      const chance = (LINEAGE.reconcileChance || 0.25) * (settled ? 1 : 0.3);
      if (rng() > chance) continue;
      a.rivalId = null; b.rivalId = null;                                  // the rivalry is over
      for (const [x, y] of [[a, b], [b, a]]) {
        const rb = x.beliefs && x.beliefs._ensure ? x.beliefs._ensure(y.id) : null;
        if (rb) { rb.standing = Math.max(rb.standing || 0, 0.4); rb.hostile = false; }
        if (x.memory) { try { x.memory.record({ t: this.sim.time, kind: 'bond', withId: y.id, rel: 'reconciled', valence: 1, salience: 0.7 }); } catch { /* */ } }
      }
      const houses = a.house && b.house && a.house !== b.house;
      const text = houses
        ? `Once rivals, ${a.name} and ${b.name} have reconciled, ending the strife between Houses ${a.house} and ${b.house}.`
        : `Once bitter rivals, ${a.name} and ${b.name} have made their peace.`;
      if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('legend', a.id, text);
      return;   // one reconciliation per pass
    }
  }

  // INHERITED FEUDS, ACTED — make a House's dynastic grudge VISIBLE on the street. A young
  // member of a feuding house, on PERCEIVING a member of the RIVAL house, SOURS its belief
  // about that neighbour: a low standing + mild suspicion (NOT auto-hostility — that would
  // over-escalate; a soured belief is enough for the existing avoid/shun behaviour to act on).
  //
  // EPISTEMIC DISCIPLINE: the souring agent reads only its OWN beliefs (the subjects it has
  // freshly perceived), its OWN house, and the STATIC house-feud registry (a shared world fact,
  // like the mental map — areHousesFeuding). The perceived neighbour's HOUSE is a static
  // dynastic surname (a public, on-sight fact, not a hidden truth), resolved via agentsById from
  // the believed subject id — no roster SCAN to decide who to sour. Bounded per pass; idempotent
  // (skips a belief already soured to this level). Guarded; never throws on the tick.
  _feudGrudges(): void {
    const sim = this.sim;
    if (!sim.houseFeuds || !sim.houseFeuds.size) return;        // no feuds → wholly inert
    const tgtStanding = (typeof LINEAGE.feudGrudgeStanding === 'number') ? LINEAGE.feudGrudgeStanding : -0.4;
    const susp = (typeof LINEAGE.feudGrudgeSuspicion === 'number') ? LINEAGE.feudGrudgeSuspicion : 0.3;
    const cap = LINEAGE.feudGrudgePerPass || 4;
    const confFloor = 0.5;                                       // only act on a CONFIDENT (freshly-seen) belief
    let stamped = 0;
    for (const a of sim.agents) {
      if (stamped >= cap) break;
      if (!this._civ(a) || !a.house || !a.beliefs) continue;
      if (this._totalLevel(a) > (LINEAGE.feudYoungMaxLevel ?? 4)) continue;   // YOUNG members only
      // does my house feud with ANY house? (cheap early-out before scanning my beliefs)
      if (!feudingHouseOf(sim, a.house)) continue;
      let did = false;
      try {
        for (const b of a.beliefs.all()) {
          if (!b || (b.confidence || 0) < confFloor) continue;   // a subject I currently, confidently perceive
          const o = sim.agentsById.get(b.subjectId);
          if (!o || !o.alive || o.controlled || o.faction !== 'townsfolk' || !o.house) continue;
          if (!areHousesFeuding(sim, a.house, o.house)) continue; // static shared world fact
          if ((b.standing || 0) <= tgtStanding && (b.suspicion || 0) >= susp) continue; // already soured
          b.standing = Math.min(b.standing || 0, tgtStanding);    // cool toward the rival bloodline
          b.suspicion = Math.max(b.suspicion || 0, susp);         // "something's off about them"
          did = true;
          break;                                                  // one fresh grudge per agent per pass
        }
      } catch { /* a single bad belief must never abort the pass */ }
      if (did) stamped++;
    }
  }

  // record a `bond` episode (memory.js renders it "joined with X"). `rel` is kept
  // on the episode for the chronicle/biography to distinguish kin vs mentorship.
  // SALIENCE BY WEIGHT OF THE TIE (the bond-crowding fix): a wedding or a child is
  // formative (0.75, crosses ltmThreshold 0.6); an apprenticeship is workplace routine
  // (0.5 — MTM only, fades). At a flat 0.7 the ~hundreds of apprenticeships a run
  // churns out filled the 10-slot LTM ring and EVICTED every rarer memory — the median
  // biography read "joined with X" four times and nothing else. The biography's bond
  // scan reads MTM too, so fresh mentorships still show; they just stop being the only
  // thing a life remembers.
  _bond(a: Ag, withId: unknown, t: number, rel: string): void {
    if (!a || !a.memory) return;
    try {
      const formative = rel === 'mate' || rel === 'kin';
      a.memory.record({ t, kind: 'bond', withId, rel, valence: 1, salience: formative ? 0.75 : 0.5 });
    } catch { /* never throw on the tick */ }
  }
}
