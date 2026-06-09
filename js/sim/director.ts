// The DIRECTOR — a LIGHT, config-driven drama nudge (docs/drama-plan.md §1).
//
// It is NOT a scripted tension curve. Emergence runs the world; the Director just
// reads world-state on a slow throttle and occasionally rolls a config-weighted
// SEED event that the existing systems (combat, beliefs, groups, memory, market)
// propagate into story:
//
//   RAID        spawn a small WAVE of monster-faction raiders near the town. Size
//               and frequency scale with living POPULATION — bigger/more often as
//               the town grows, weak/rare when decimated. This single rule is the
//               difficulty curve AND the anti-massacre valve (a culled town gets a
//               reprieve to recover). Raiders carry ZERO gold (spawning never mints
//               money — the soak asserts gold is conserved start==end).
//   OPPORTUNITY a passing rich caravan (a trader) or a recruitable wanderer.
//   CRISIS      a light transient scarcity nudge (raises a few price beliefs).
//   SPARK       seed a feud (two townsfolk to mutual negative standing) or a theft.
//
// Invariants honoured: never throw or stall on the fixed tick (everything guarded);
// decisions read beliefs not truth (we only seed beliefs / spawn bodies, we never
// touch the decide/perceive truth split); concurrent director raiders are capped so
// the world is never swarmed.
//
// ---------------------------------------------------------------------------------
// SRP SPLIT (mirrors the Agent split): this class is now a thin STATE + ORCHESTRATION
// shell. The behaviour lives in `js/sim/director/*.js` as free functions over the
// instance `d`; each is reached through a one-line delegator below so every internal
// `this._foo()` call site (and the external `_recordSaga`/`_enlistGuardian` callers in
// combatEvents.js) is unchanged. All mutable state stays on the instance.
//   raids.js    — raid waves, raider lifecycle, warlord (war) + nemesis
//   roll.js     — points budget, weighted roll, tension/relief pacing, light nudges
//   tropes.js   — the trope engine (dispatcher + ~20 instigators)
//   arcs.js     — multi-beat story arcs + sagas
//   roles.js    — bodyguard / duel / protégé / guardian / legend / avenger roles
//   caravans.js — trade-road runs the bandits prey on
import { DIRECTOR } from './simconfig.js';
import { BEAT } from './chronicle.js';
import { clamp } from './director/util.js';
import * as raids from './director/raids.js';
import * as roll from './director/roll.js';
import * as tropes from './director/tropes.js';
import * as arcs from './director/arcs.js';
import * as roles from './director/roles.js';
import * as caravans from './director/caravans.js';

// The Director is a thin STATE+ORCHESTRATION shell; behaviour lives in js/sim/director/*.ts
// over the instance. `sim` (a separate, wave-2 cluster still in .js) and the long tail of
// ad-hoc drama state (arcs/sagas/feud lists/tone/cooldown maps) are typed opaquely on
// purpose — the surface is large and freeform; behaviour is unchanged and fully guarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Arc = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Saga = any;

export class Director {
  sim: Sim;
  _acc: number;
  _sinceEvent: number;
  _raiders: Ag[];
  _lastRaidAt: number;
  _lastTropeAt: number;
  _warlord: Ag | null;
  _warCamp: Ag | null;
  _caravans: Ag[];
  _lastCaravanAt: number;
  _tension: number;
  _reliefUntil: number;
  _threatWas: boolean;
  _points: number;
  _lastPop: number | null;
  stats: Record<string, number>;
  // the long tail of ad-hoc drama state lazily set across the behaviour modules
  // (_favored, _arcs, _sagas, _tone, _kindAt, _reunited, _arcSeq, _coreCache, …).
  [k: string]: unknown;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;            // throttle accumulator (sim-seconds)
    this._sinceEvent = 0;     // sim-seconds since ANY director event fired
    this._raiders = [];       // live director-spawned raider agents (capped)
    this._lastRaidAt = -Infinity;
    this._lastTropeAt = -Infinity;
    this._warlord = null;       // the reigning warlord (a camp leader at war), or null
    this._warCamp = null;       // the warlord's camp (its host marches with it)
    this._caravans = [];        // dispatched trade caravans currently on the road
    this._lastCaravanAt = -Infinity;
    // dramatic pacing (see DIRECTOR.pacing): tension rises with peril, and a relief
    // window opens when a high-tension peak resolves.
    this._tension = 0;
    this._reliefUntil = -Infinity;
    this._threatWas = false;
    // points budget (see DIRECTOR.points): accrues with prosperity, drained by deaths,
    // spent on incidents.
    this._points = 0;
    this._lastPop = null;
    // telemetry the soak / chronicle can read; never asserted on internally.
    this.stats = { raids: 0, opportunities: 0, crises: 0, sparks: 0, spawned: 0, tropes: 0, reliefs: 0 };
  }

  // count living townsfolk — the population knob that scales raid pressure.
  _townPop(): number {
    let n = 0;
    for (const a of this.sim.agents) {
      if (a.alive && a.autonomous && a.faction === 'townsfolk') n++;
    }
    return n;
  }

  // fixed-tick entry. Self-throttled to DIRECTOR.interval; fully guarded so a bad
  // roll can never throw inside the sim's fixed-tick while-loop (the freeze lesson).
  tick(ctx: Ctx, dt: number): void {
    this._sinceEvent += dt;
    this._acc += dt;
    if (this._acc < DIRECTOR.interval) return;
    this._acc = 0;
    try {
      this._pruneRaiders();
      // the war ENDS when the warlord falls — a saga-worthy victory. The broken host
      // falls back to its camp (re-leashed) so it lurks the frontier again.
      if (this._warlord && !this._warlord.alive) {
        this._note(BEAT.LEGEND, -13, `The warlord ${this._warlord.name || 'who menaced the town'} has fallen — the town has won the war.`);
        this.stats.wars = (this.stats.wars || 0) + 1;
        if (this._warCamp) {
          for (const m of this._warCamp.members) {
            if (!m || !m.alive) continue;
            m.homeAnchor = m._warHome || this._warCamp.anchor;
            m.leashR = m.leashR || 50;
            m.atWar = false;
          }
          this._warCamp = null;
        }
        this._warlord = null;
        this._tension = 1;          // a war IS the peak…
        this._enterRelief();        // …and winning it always earns the town a relief.
      }
      // a town at/below the cull floor: call off any ongoing raid so it can recover.
      if (this._townPop() < DIRECTOR.raid.minPop) this._withdrawAll();
      // advance any dispatched trade caravans (out → home / windfall) + send a new
      // one on a steady cadence — a recurring supply run the bandits will prey on.
      this._advanceCaravans();
      const CC = DIRECTOR.caravan || {};
      if (this._townPop() >= (CC.minTownPop || 16) &&
          !this._caravans.some((c) => c && c.alive && c.caravanRun) &&
          this.sim.time - this._lastCaravanAt > (CC.every || 70)) {
        if (this._tropeCaravan()) this._lastCaravanAt = this.sim.time;
      }
      // keep the antagonist camps alive (the bandit/rival factions + spy pool) so
      // the world stays in conflict instead of the camps self-annihilating early.
      if (this.sim.reinforceCamps) this.sim.reinforceCamps();
      this._pace();        // dramatic rhythm: track tension, open a relief after a peak
      this._processFavoredFalls();   // close out any favored-rise arc whose fall is due
      this._superviseBodyguards();   // end a guard's duty when their charge falls
      this._superviseDuels();        // resolve a duel on yield (low HP) or timeout
      this._seedSpyWebs();           // catch a freshly-disguised spy for a slow-burn web
      this._superviseAvengers();     // keep the player's personal nemeses hunting (no decay)
      this._superviseGrateful();     // keep the player's saved-life guardians loyal (no decay)
      this._superviseProtege();      // a famous player inspires a youth to follow + grow into a hero
      this._superviseLegend();       // decay the player's legend + narrate villain/hero milestones
      this._advanceArcs();           // step any multi-beat story arcs toward their climax
      this._roll(ctx);
    } catch { /* never throw / stall on the fixed tick */ }
  }

  // --- SHARED BELIEF / UTILITY HELPERS (used across the behaviour modules) -------

  // push observer A's belief-standing toward B downward (a grievance seed).
  _sour(A: Ag, B: Ag, drop: number): void {
    if (!A || !B || !A.beliefs) return;
    const b = A.beliefs._ensure ? A.beliefs._ensure(B.id) : null;
    if (!b) return;
    b.standing = clamp(b.standing - drop, -1, 1);
    if (b.confidence < 0.4) b.confidence = 0.4;   // a believed grievance, not a sighting
  }

  // the inverse of _sour: warm A's belief-standing toward B (un-latches enmity).
  _warm(A: Ag, B: Ag, amt: number): void {
    if (!A || !B || !A.beliefs || !A.beliefs._ensure) return;
    const b = A.beliefs._ensure(B.id);
    if (!b) return;
    b.standing = clamp(b.standing + amt, -1, 1);
    if (amt > 0) b.hostile = false;
    if (b.confidence < 0.4) b.confidence = 0.4;
  }

  // plant a believed opinion in an OBSERVER about a subject (the spark for slander /
  // a false reputation spike). Belief-only — never touches ground truth (the split).
  _plant(observer: Ag, subjectId: unknown, { dStanding = 0, suspicion = 0, confidence = 0 }: { dStanding?: number; suspicion?: number; confidence?: number }): void {
    if (!observer || !observer.beliefs || !observer.beliefs._ensure) return;
    const b = observer.beliefs._ensure(subjectId);
    if (!b) return;
    if (dStanding) b.standing = clamp(b.standing + dStanding, -1, 1);
    if (suspicion) b.suspicion = Math.min(1, Math.max(b.suspicion, suspicion));
    if (confidence) b.confidence = Math.min(1, Math.max(b.confidence, confidence));
  }

  _remember(a: Ag, ep: unknown): void { try { if (a && a.memory && a.memory.record) a.memory.record(ep); } catch { /* never throw */ } }

  _townsfolkAlive(): Ag[] { return this.sim.agents.filter((a: any) => a.alive && a.autonomous && a.faction === 'townsfolk'); }
  _lvl(a: Ag): number { return (a.progression && a.progression.totalLevel) || 0; }
  _note(kind: string, id: unknown, text: string, arc?: unknown): void { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note(kind, id, text, arc); } catch { /* */ } }
  _shuffle<T>(arr: T[]): T[] { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  // idle, non-grouped townsfolk are the safe pool to nudge (we avoid disturbing
  // agents already busy in a party/group or fleeing).
  _idleTownsfolk(): Ag[] {
    return this.sim.agents.filter((a: any) =>
      a.alive && a.autonomous && a.faction === 'townsfolk');
  }

  // --- DELEGATORS: behaviour lives in js/sim/director/*; call sites stay unchanged --

  // raids.js
  _pruneRaiders() { return raids._pruneRaiders(this); }
  _despawn(a: Ag) { return raids._despawn(this, a); }
  _withdrawAll() { return raids._withdrawAll(this); }
  _raid(pop: number) { return raids._raid(this, pop); }
  _spawnRaider(x: number, z: number) { return raids._spawnRaider(this, x, z); }
  _tropeNemesis() { return raids._tropeNemesis(this); }
  _tropeWar() { return raids._tropeWar(this); }

  // roll.js
  _pace() { return roll._pace(this); }
  _enterRelief() { return roll._enterRelief(this); }
  _inRelief() { return roll._inRelief(this); }
  _roll(ctx: Ctx) { return roll._roll(this, ctx); }
  _opportunity(pop: number) { return roll._opportunity(this, pop); }
  _crisis() { return roll._crisis(this); }
  _spark() { return roll._spark(this); }
  _processFavoredFalls() { return roll._processFavoredFalls(this); }

  // tropes.js
  _instigateTrope(ctx: Ctx) { return tropes._instigateTrope(this, ctx); }
  _tropeReunion(folk: Ag[]) { return tropes._tropeReunion(this, folk); }
  _tropeUnlikelyFriendship(folk: Ag[]) { return tropes._tropeUnlikelyFriendship(this, folk); }
  _tropeFalseWitness(folk: Ag[]) { return tropes._tropeFalseWitness(this, folk); }
  _tropeFavoredRise(folk: Ag[]) { return tropes._tropeFavoredRise(this, folk); }
  _tropeMistakenJealousy(folk: Ag[]) { return tropes._tropeMistakenJealousy(this, folk); }
  _tropeBetrayal(folk: Ag[]) { return tropes._tropeBetrayal(this, folk); }
  _tropeMiserReformed(folk: Ag[]) { return tropes._tropeMiserReformed(this, folk); }
  _tropeProdigalReturn(folk: Ag[]) { return tropes._tropeProdigalReturn(this, folk); }
  _tropeDebtRepaid(folk: Ag[]) { return tropes._tropeDebtRepaid(this, folk); }
  _tropeMentorPride(folk: Ag[]) { return tropes._tropeMentorPride(this, folk); }
  _tropeSpyUnmasked() { return tropes._tropeSpyUnmasked(this); }
  _tropeTyrantMarket(folk: Ag[]) { return tropes._tropeTyrantMarket(this, folk); }
  _tropeHouseFeud(folk: Ag[]) { return tropes._tropeHouseFeud(this, folk); }
  _tropeStarCrossed(folk: Ag[]) { return tropes._tropeStarCrossed(this, folk); }
  _tropeBoastBackfires(folk: Ag[]) { return tropes._tropeBoastBackfires(this, folk); }
  _tropeRivalApprentices(folk: Ag[], T: unknown) { return tropes._tropeRivalApprentices(this, folk, T); }
  _tropeFeud(folk: Ag[], T: unknown) { return tropes._tropeFeud(this, folk, T); }
  _tropeVendetta(folk: Ag[], T: unknown) { return tropes._tropeVendetta(this, folk, T); }
  _tropeProphet(folk: Ag[], T: unknown) { return tropes._tropeProphet(this, folk, T); }

  // arcs.js
  _advanceArcs() { return arcs._advanceArcs(this); }
  _recordSaga(saga: Saga) { return arcs._recordSaga(this, saga); }
  _arcFree(a: Ag) { return arcs._arcFree(this, a); }
  _stepReckoning(arc: Arc, now: number) { return arcs._stepReckoning(this, arc, now); }
  _stepTyrantFall(arc: Arc, now: number) { return arcs._stepTyrantFall(this, arc, now); }
  _stepSpyWeb(arc: Arc, now: number) { return arcs._stepSpyWeb(this, arc, now); }
  _stepRomance(arc: Arc, now: number) { return arcs._stepRomance(this, arc, now); }
  _stepAccused(arc: Arc, now: number) { return arcs._stepAccused(this, arc, now); }
  _seedSpyWebs() { return arcs._seedSpyWebs(this); }

  // roles.js
  _tropeBodyguard(folk: Ag[]) { return roles._tropeBodyguard(this, folk); }
  _enlistBodyguard(g: Ag, charge: Ag) { return roles._enlistBodyguard(this, g, charge); }
  _freeBodyguard(g: Ag) { return roles._freeBodyguard(this, g); }
  _superviseBodyguards() { return roles._superviseBodyguards(this); }
  _enlistDuelist(a: Ag) { return roles._enlistDuelist(this, a); }
  _freeDuelist(a: Ag) { return roles._freeDuelist(this, a); }
  _resolveDuel(victor: Ag, yielder: Ag, satisfied: boolean) { return roles._resolveDuel(this, victor, yielder, satisfied); }
  _superviseDuels() { return roles._superviseDuels(this); }
  _tropeDuel(folk: Ag[]) { return roles._tropeDuel(this, folk); }
  _superviseProtege() { return roles._superviseProtege(this); }
  _enlistProtege(g: Ag, player: Ag) { return roles._enlistProtege(this, g, player); }
  _freeProtege(g: Ag) { return roles._freeProtege(this, g); }
  _endProtege(a: Ag, why: string) { return roles._endProtege(this, a, why); }
  _enlistGuardian(g: Ag, player: Ag, savedFrom: string) { return roles._enlistGuardian(this, g, player, savedFrom); }
  _freeGuardian(g: Ag) { return roles._freeGuardian(this, g); }
  _superviseGrateful() { return roles._superviseGrateful(this); }
  _endGuardian(a: Ag, why: string) { return roles._endGuardian(this, a, why); }
  _superviseLegend() { return roles._superviseLegend(this); }
  _superviseAvengers() { return roles._superviseAvengers(this); }
  _endAvenger(a: Ag, why: string) { return roles._endAvenger(this, a, why); }

  // caravans.js
  _tropeCaravan() { return caravans._tropeCaravan(this); }
  _enlistEscort(a: Ag, leader: Ag, role: string, good: string) { return caravans._enlistEscort(this, a, leader, role, good); }
  _disbandEscorts(trader: Ag) { return caravans._disbandEscorts(this, trader); }
  _advanceCaravans() { return caravans._advanceCaravans(this); }
  _caravanWindfall(trader: Ag, good: string) { return caravans._caravanWindfall(this, trader, good); }
}
