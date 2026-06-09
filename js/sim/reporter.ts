// THE REPORTER — a roaming "gazetteer" agent that finds the most newsworthy soul,
// walks to them, lingers a moment (the "interview" = a co-located read of their
// state), and FILES a StoryBrief to the Gazette. Everything here is deterministic
// and headless-safe (Math.random + state only; no I/O, no await — the freeze
// lesson); the optional LLM prose lives in the browser press pump (js/ai/press.js).
//
// Modeled on Watch/Expeditions: a normal Agent re-flagged (`reporter = true`,
// non-combatant) and steered by this thin subsystem. Movement reuses the goal/act
// path — decide.js routes a reporter to a `reporter` goal; act.js walks it toward
// `agent.reporterTarget`. The reporter physically WALKS BETWEEN TOWNS to reach an
// out-of-town subject, so its travel IS the inter-town news-courier mechanic.

import * as THREE from 'three';
import { Agent } from './agent.js';
import { REPORTER, MONSTER, GAZETTE, ALERT } from './simconfig.js';
import { buildBrief, gatherDispatches } from './gazette.js';
import type { FullCtx } from '../../types/sim.js';
import type { Dispatch } from './gazette.js';

// The (still-.js) Simulation is reached into loosely here (towns/agents/gazette/quests/
// makeFighter + a wide untyped news tail), so a precise type would be all-optional noise.
type Sim = any;   // js Simulation — justified loose type (untyped sim spine + news tail)
type Ag = any;    // a roster agent + its transient reporter scratch fields — justified loose type

const REPORTER_PERSONALITY = { risk_tolerance: 0.35, social_drive: 0.95, ambition: 0.5, altruism: 0.6, curiosity: 0.95 };

export class Reporter {
  sim: Sim;
  _acc: number;
  _wireAcc: number;
  _filedSigs: Map<string, number>;
  reporters: Agent[];
  stats: { filed: number; wire: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._wireAcc = 0;
    this._filedSigs = new Map();   // dispatch sig -> last-filed sim-time (dedupe the desks)
    this.reporters = [];      // the gazetteer agent(s)
    this.stats = { filed: 0, wire: 0 };
  }

  // create the gazetteer agent(s) — called from Simulation.spawn() after townsfolk.
  spawn(): void {
    if (!REPORTER || !REPORTER.enabled) return;
    const n = REPORTER.count || 1;
    for (let i = 0; i < n; i++) this._spawnOne(i);
  }

  _spawnOne(i: number): Agent {
    const sim = this.sim;
    const town = (sim.towns && sim.towns[i % sim.towns.length]) || { center: new THREE.Vector3(), radius: 70, id: 0 };
    const fighter = sim.makeFighter('knight', {});
    const px = town.center.x + (Math.random() * 6 - 3), pz = town.center.z + (Math.random() * 6 - 3);
    const py = typeof document === 'undefined' ? 0 : 0;
    fighter.root.position.set(px, py, pz);
    sim.scene.add(fighter.root);
    // ids are numeric in this sim (EntityId = number|string); AgentCfg.id is narrowly
    // typed `string` in the wave-1 agent port, so pass the loose spawn cfg as any.
    const a = new Agent(fighter, {
      id: sim._nextId++, name: REPORTER.name || 'the Gazetteer',
      profession: null, personality: { ...REPORTER_PERSONALITY }, faction: 'townsfolk',
    } as any);
    a.reporter = true;
    a.combatant = false;            // a press observer, never a fighter
    a.canWork = false;              // no trade / economy (guarded everywhere)
    a.gold = 0;                     // PURSELESS: no economy, so spawning/respawning a
                                    //   gazetteer never mints gold (closed money loop)
    a.townId = town.id != null ? town.id : (i % (sim.towns ? sim.towns.length : 1));
    a.townAnchor = town.center;
    a.townRadius = town.radius;
    a._rPhase = 'roam';
    sim.agents.push(a);
    sim.agentsById.set(a.id, a);
    this.reporters.push(a);
    return a;
  }

  tick(ctx: FullCtx | null, dt: number): void {
    try {
      if (!this.sim._spawned || !REPORTER || !REPORTER.enabled) return;
      this._acc += dt;
      if (this._acc < (REPORTER.tickEvery || 2)) return;
      const step = this._acc; this._acc = 0;
      this._ensureReporters();
      for (const r of this.reporters) {
        if (!r || !r.alive) continue;
        this._stepReporter(r, step);
      }
      this._wireDesk(step);     // the intel desks: file fresh, high-value useful news
    } catch { /* never throw on the tick */ }
  }

  // THE WIRE DESK — the paper sells USEFUL info: each cycle, publish the single
  // freshest, highest-VALUE dispatch (a price shock, a road danger, a posted
  // bounty) that isn't on cooldown. This is what makes the Gazette worth buying.
  _wireDesk(step: number): void {
    this._wireAcc += step;
    if (this._wireAcc < (GAZETTE.wireEvery || 10)) return;
    this._wireAcc = 0;
    const sim = this.sim, now = sim.time;
    const items = gatherDispatches(sim);
    let best: Dispatch | null = null;
    for (const it of items) {
      const last = this._filedSigs.get(it.sig);
      if (last != null && now - last < this._cooldown(it.brief.kind)) continue;   // recently covered
      if (!best || it.value > best.value) best = it;
    }
    if (best && best.value >= (GAZETTE.wireFloor || 1.0) && sim.gazette) {
      sim.gazette.file(best.brief);
      this._filedSigs.set(best.sig, now);
      this.stats.wire++;
      // a published THREAT advisory puts that town on ALERT — the Watch musters
      // early and caravans hold off the road (channel 2: the town reads the warning).
      const threatTownId = best.brief.townId as number | null | undefined;
      if (best.brief.kind === 'threat' && threatTownId != null && sim.towns && sim.towns[threatTownId]) {
        sim.towns[threatTownId]._alertUntil = now + (ALERT.duration || 110);
      }
      if (this._filedSigs.size > 256) {   // bound the dedupe map
        for (const [k, t] of this._filedSigs) if (now - t > 600) this._filedSigs.delete(k);
      }
    }
  }

  _cooldown(kind: string): number {
    if (kind === 'market') return GAZETTE.cooldownMarket || 150;
    if (kind === 'threat') return GAZETTE.cooldownThreat || 300;
    if (kind === 'opportunity') return GAZETTE.cooldownOpp || 220;
    return 200;
  }

  _stepReporter(r: Ag, step: number): void {
    const sim = this.sim, now = sim.time;
    const phase = r._rPhase || 'roam';
    if (phase === 'roam') {
      r.reporterTarget = null;     // wander home town until a subject is chosen
      if (now - (r._rLastSelect == null ? -Infinity : r._rLastSelect) >= (REPORTER.selectEvery || 8)) {
        r._rLastSelect = now;
        const subj = this._select(r);
        if (subj) { r._rSubjectId = subj.id; r.reporterTarget = subj.pos; r._rPhase = 'travel'; r._rTravelT = now; }
      }
    } else if (phase === 'travel') {
      const subj = sim.agentsById.get(r._rSubjectId);
      if (!subj || !subj.alive) { r._rPhase = 'roam'; return; }
      r.reporterTarget = subj.pos;                 // live re-acquire as the subject moves
      const d = r.pos.distanceTo(subj.pos);
      if (d <= (REPORTER.interviewRange || 6)) { r._rPhase = 'interview'; r._rDwell = 0; }
      else if (now - (r._rTravelT || now) > (REPORTER.travelTimeout || 90)) { r._rPhase = 'roam'; }
    } else if (phase === 'interview') {
      const subj = sim.agentsById.get(r._rSubjectId);
      if (!subj || !subj.alive) { r._rPhase = 'roam'; return; }
      if (r.pos.distanceTo(subj.pos) > (REPORTER.interviewRange || 6) * 1.6) { r._rPhase = 'travel'; return; }
      r._rDwell = (r._rDwell || 0) + step;
      if (r._rDwell >= (REPORTER.dwellSecs || 2)) {
        this._file(r, subj);
        subj._lastInterviewedT = now;
        r._rSubjectId = null; r._rPhase = 'roam'; r._rLastSelect = now;   // cooldown before next hunt
      }
    }
  }

  // file a story: build the brief and publish it to the Gazette (template now; the
  // browser press pump may upgrade the prose with the LLM later, in place).
  _file(r: Agent, subj: Agent): void {
    try {
      const brief = buildBrief(subj, this.sim);
      brief.filedInTown = (this.sim.towns && this.sim.towns[r.townId as number] && this.sim.towns[r.townId as number].name) || brief.dateline;
      if (this.sim.gazette) { this.sim.gazette.file(brief); this.stats.filed++; }
    } catch { /* never throw */ }
  }

  // pick the most NEWSWORTHY living townsperson for this reporter (town-biased).
  _select(r: Agent): Agent | null {
    const sim = this.sim, now = sim.time;
    let best: Agent | null = null, bestScore = (REPORTER.minNewsworthy || 0.5);
    for (const a of sim.agents) {
      if (!a || !a.alive || a.controlled || a.reporter) continue;
      if (a.faction === MONSTER.faction || a.faction !== 'townsfolk') continue;
      // cooldown: don't re-feature a soul we just covered
      if (a._lastInterviewedT != null && now - a._lastInterviewedT < (REPORTER.subjectCooldown || 120)) continue;
      let s = this._score(a, now);
      if (a.townId === r.townId) s += 0.2;     // mild home-town bias (still travels for a big story)
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }

  // a PERSON's reader-value: who readers actually want to know about — the powerful,
  // the storied, those tied to a feud or a fresh PIVOTAL turn (a windfall, a relic,
  // a reconciliation). NOT raw memory salience: that featured every bystander who
  // "saw X fall" after one death. Scaled to compare with the wire desks' values.
  _score(a: Agent, now: number): number {
    let s = 0;
    try {
      const lvl = (a.progression && a.progression.totalLevel) || 0;
      s += Math.min(1.2, lvl / 25);                       // the powerful are worth knowing
      if (a.epithet) s += (REPORTER.wEpithet || 0.8);     // a named hero/legend
      if (a.nemesis || a.warlord) s += (REPORTER.wRole || 0.5) + 0.6;
      else if (a.watch) s += (REPORTER.wRole || 0.5);
      if (a.rivalId != null) s += (REPORTER.wRival || 0.5);
      const esc = (a.life && a.life.escapes) || 0;
      if (esc) s += (REPORTER.wEscape || 0.4) * Math.min(1, esc / 3);
      // a fresh PIVOTAL (non-grind) memory — a windfall / relic / milestone / closure
      // is genuinely newsworthy; a routine raider kill is not.
      const eps = a.memory && a.memory.salient ? a.memory.salient(4) : [];
      for (const e of eps) {
        if (!e) continue;
        if ((e.kind === 'windfall' || e.kind === 'relic' || e.kind === 'milestone' || e.kind === 'closure' || e.kind === 'succoured')
            && now - (e.t || 0) < (REPORTER.recencyWindow || 60)) { s += (REPORTER.wRecency || 0.6); break; }
      }
    } catch { /* */ }
    return s;
  }

  _ensureReporters(): void {
    this.reporters = this.reporters.filter((r) => r && r.alive);
    const want = (REPORTER.count || 1);
    while (this.reporters.length < want) {
      const r = this._spawnOne(this.reporters.length);
      if (!r) break;
    }
  }

  dispose(): void { this.reporters = []; }
}
