// THE NIGHT WATCH — a civic guard institution (Discworld's City Watch). The town
// had only passive watchtowers; this adds MORTAL, LED defenders. Brave townsfolk are
// mustered to hold the core when raiders threaten, swelling with the danger and
// standing down in peace; the senior watchman is the CAPTAIN (a Vimes who rises).
//
// A watchman is just a townsperson re-flagged: combatant (fights), canWork off (on
// duty, not at a trade), and LEASHED to the core (homeAnchor = origin + a leash, so
// they hold the line and never chase a raider out to the frontier — reusing the same
// territorial-leash the camps/monsters use). Released members revert cleanly.
//
// Reuses combat + the leash; touches no gold. Guarded — never throws on the tick.

import * as THREE from 'three';
import { WATCH, TOWNS, ALERT, factionHostile } from './simconfig.js';
import { isHomeBuilder } from './construction.js';

export class Watch {
  constructor(sim) {
    this.sim = sim;
    this._acc = 0;
    this._calm = [];            // per-town sim-seconds since last threatened (hysteresis)
    this.roster = [];           // current watchmen (agents), each tagged with _watchTown
    this.captain = null;
    this._founded = false;
    this.stats = { recruited: 0, fallen: 0, captains: 0 };
  }

  // the town cores to guard (open world: one watch institution, many towns). Prefer
  // the spawned town registry; fall back to the TOWNS config, else the origin.
  _cores() {
    if (this._coreCache) return this._coreCache;
    if (this.sim.towns && this.sim.towns.length) this._coreCache = this.sim.towns.map((t) => ({ pos: t.center, r: t.radius, town: t }));
    else {
      const cs = (TOWNS && TOWNS.centers && TOWNS.centers.length) ? TOWNS.centers : [[0, 0]];
      const r = (TOWNS && TOWNS.radius) || 70;
      this._coreCache = cs.map((c) => ({ pos: new THREE.Vector3(c[0], 0, c[1]), r }));
    }
    return this._coreCache;
  }

  tick(ctx, dt) {
    try {
      if (!this.sim._spawned) return;   // a real town only (not bare test sub-sims)
      this._acc += dt;
      if (this._acc < WATCH.tickEvery) return;
      this._acc = 0;
      this._prune();
      const cores = this._cores();
      // each town musters its OWN guard from its OWN brave townsfolk and leashes
      // them to its core — so defenders never drain toward another town.
      for (let ti = 0; ti < cores.length; ti++) {
        const core = cores[ti];
        const threat = this._threat(core.pos);
        // a town on ALERT (a Gazette threat advisory was just published about it)
        // musters EARLY — brave folk answer the warning before the foe is in sight.
        const alerted = core.town && core.town._alertUntil != null && this.sim.time < core.town._alertUntil;
        this._calm[ti] = (threat > 0 || alerted) ? 0 : (this._calm[ti] || 0) + (WATCH.tickEvery || 4);
        const target = Math.max(0, Math.min(WATCH.max || 8,
          (WATCH.base || 0) + Math.round(threat * (WATCH.perThreat || 0)) + (alerted ? (ALERT.watchBonus || 4) : 0)));
        const have = this.roster.filter((w) => w._watchTown === ti).length;
        if (have < target) this._muster(core, ti, target);
        else if (have > target && this._calm[ti] >= (WATCH.standDownAfter || 30)) this._releaseOne(ti);
      }
      this._captaincy();
    } catch { /* never throw on the tick */ }
  }

  _lvl(a) { return (a && a.progression && a.progression.totalLevel) || 0; }

  // count town-hostile bodies menacing a given core (that town's muster signal).
  _threat(corePos) {
    let n = 0;
    const r2 = (WATCH.threatRange || 64) ** 2;
    for (const a of this.sim.agents) {
      if (!a.alive || a.controlled) continue;
      if (!factionHostile('townsfolk', a.disguiseFaction || a.faction)) continue;
      if (corePos.distanceToSquared(a.pos) <= r2) n++;
    }
    return n;
  }

  // drop the fallen from the roster (a watchman's death is a beat).
  _prune() {
    const kept = [];
    for (const w of this.roster) {
      if (w && w.alive && w.watch) kept.push(w);
      else if (w) { this.stats.fallen++; this._revert(w); this._note(`Watchman ${w.name} fell defending the town.`, w.id); }
    }
    this.roster = kept;
  }

  // willing recruits for a town: brave, free townsfolk near THAT core, not already
  // serving / in a band. Proximity gate (within the town's home band) keeps each
  // town's guard drawn from its own people.
  _willing(core) {
    const r2 = (core.r || 70) ** 2;
    return this.sim.agents.filter((a) =>
      a.alive && a.autonomous && a.faction === 'townsfolk' && !a.watch && !a.combatant && !a.inParty && !a.reporter &&
      !isHomeBuilder(a) &&   // don't conscript someone raising (or about to raise) their home
      a.personality && a.personality.risk_tolerance >= (WATCH.recruitRisk || 0) &&
      core.pos.distanceToSquared(a.pos) <= r2)
      .sort((x, y) => this._lvl(y) - this._lvl(x));   // veterans first
  }

  _muster(core, ti, target) {
    const pool = this._willing(core);
    let have = this.roster.filter((w) => w._watchTown === ti).length;
    let i = 0;
    while (have < target && i < pool.length) {
      this._enlist(pool[i++], core, ti);
      have++;
    }
    if (!this._founded && this.roster.length) {
      this._founded = true;
      const cap = this._seniorOf(this.roster);
      this._note(`${(cap && cap.name) || 'A townsman'} founded the Town Watch.`, cap ? cap.id : -11);
    }
  }

  _enlist(a, core, ti) {
    a._watchRestore = { combatant: a.combatant, canWork: a.canWork };
    a.watch = true;
    a._watchTown = ti;
    a.combatant = true;                 // a watchman holds the line
    a.canWork = false;                  // on duty, not at a trade
    a.homeAnchor = core.pos;            // territorial leash: defend THIS core...
    a.leashR = WATCH.leashR || 44;      //   ...never chase a raider to the frontier
    a.campAnchor = core.pos;            // patrol the core when idle (act.js wander branch)
    a.campPatrolR = WATCH.patrolR || 14;
    this.roster.push(a);
    this.stats.recruited++;
  }

  // peace: release the single most-junior watchman of a town back to civilian life
  // (never below the standing base; one per pass, gated on that town's calm).
  _releaseOne(ti) {
    const town = this.roster.filter((w) => w._watchTown === ti);
    if (town.length <= (WATCH.base || 0)) return;
    let jr = null;
    for (const w of town) if (w && w.alive && (!jr || this._lvl(w) < this._lvl(jr))) jr = w;
    if (jr) { this._revert(jr); this.roster = this.roster.filter((w) => w.watch); }
  }

  _revert(a) {
    if (!a) return;
    const r = a._watchRestore;
    a.watch = false;
    a._watchTown = undefined;
    a.combatant = r ? r.combatant : false;
    a.canWork = r ? r.canWork : (a.faction !== 'monster');
    a._watchRestore = null;
    a.homeAnchor = null; a.leashR = 0;
    a.campAnchor = null;
  }

  _seniorOf(list) {
    let best = null;
    for (const w of list) if (w && w.alive && (!best || this._lvl(w) > this._lvl(best))) best = w;
    return best;
  }

  // the senior watchman commands; announce a change of captain (a Vimes rises).
  _captaincy() {
    const cap = this._seniorOf(this.roster);
    if (cap && cap !== this.captain) {
      const first = !this.captain;
      this.captain = cap;
      this.stats.captains++;
      if (!first || this._founded) this._note(`${cap.name} took command of the Watch.`, cap.id);
    } else if (!cap) {
      this.captain = null;
    }
  }

  _note(text, id) { try { if (this.sim.chronicle && this.sim.chronicle.note) this.sim.chronicle.note('watch', id == null ? -11 : id, text); } catch { /* */ } }

  // restore every watchman (world teardown / dispose) so flags don't leak.
  disband() { for (const w of this.roster.slice()) this._revert(w); this.roster = []; this.captain = null; }
}
