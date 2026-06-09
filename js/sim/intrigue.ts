// INTRIGUE — the dormant Theory-of-Mind DECEPTION layer, switched on (drama
// §3). This is the soul of the ToM design: agents act on what they BELIEVE, so a
// deceiver wins by FALSIFYING BELIEFS, never ground truth. Three light mechanics,
// all config-gated, all guarded so they never throw/stall on the fixed tick:
//
//   (a) DISGUISE — a spy carries a `disguiseFaction`; perception.js records the
//       PERCEIVED faction (disguise) into observers' beliefs, while ground-truth
//       combat (simulation.isHostile) keeps reading the TRUE faction. So a bandit
//       spy walks the town read as a townsperson — fooling decisions, not reality.
//   (b) PLANT RUMOR — a spy near a townsperson writes a FALSE belief (via
//       BeliefStore.plant) into that observer about a THIRD, innocent townsperson:
//       marks the innocent as hostile, at low RUMOR confidence with rumor
//       provenance, so it fades (decay) unless reinforced — a planted feud spark.
//   (c) SPY behaviour — an infiltrator scouts toward the town core, plants while
//       there, then EXFILTRATES back to its camp anchor (decide.js `spy` branch).
//
// The epistemic split is the whole point: ONLY beliefs are falsified. The spy's
// real faction is unchanged, so when blades actually land combat resolves truly.
//
// Self-contained: if INTRIGUE.enabled is false, or there are no camps / no
// townsfolk, the subsystem is inert. Spies are drawn ONLY from existing camp
// members (no new bodies, no minted gold) — they are camp combatants given a
// cover identity, not extra spawns.

import { INTRIGUE, SOURCE, SIM } from './simconfig.js';

// `sim`/`ctx` (the owning Simulation + its cognition context — wave-2, still .js) and the
// spy Agents (via their disguise/spy state flags) are typed opaquely on purpose; the
// epistemic split is preserved at runtime (only beliefs are falsified). Behaviour unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = any;

export class Intrigue {
  sim: Sim;
  _acc: number;
  _assigned: boolean;
  spies: Ag[];
  stats: Record<string, number>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._assigned = false;
    this.spies = [];
    // telemetry (read-only; surfaced by the soak assertion + any future UI)
    this.stats = { spies: 0, disguised: 0, plants: 0, exfils: 0 };
  }

  // Pick the spies once the world has spawned: a config fraction of each enabling
  // camp's members become infiltrators wearing a town cover identity. Idempotent.
  _assignSpies(): void {
    this._assigned = true;
    const sim = this.sim;
    if (!INTRIGUE || !INTRIGUE.enabled || !sim.camps) return;
    for (const key in sim.camps) {
      const camp = sim.camps[key];
      if (!camp || !Array.isArray(camp.members)) continue;
      if (INTRIGUE.spyFactions && INTRIGUE.spyFactions.indexOf(camp.faction) === -1) continue;
      // followers (not the leader) make the spies — the leader stays to lead.
      const pool = camp.members.filter((m: any) => m && m.alive && m !== camp.leader);
      const want = Math.min(pool.length, Math.max(0, Math.round(pool.length * INTRIGUE.spyFraction)));
      for (let i = 0; i < want; i++) {
        const m = pool[i];
        // cover identity: perceived as the town (disguise), AND a town cover NAME so
        // it walks among the townsfolk as a trusted neighbour — its unmasking later
        // lands as a betrayal. Ground truth faction is untouched (combat reads true).
        m.disguiseFaction = INTRIGUE.disguiseAs;
        if (INTRIGUE.coverName && sim._takeName) { m._realName = m.name; m.name = sim._takeName(); }
        m.spy = {
          homeKey: key,
          anchor: camp.anchor ? camp.anchor.clone() : null,  // exfil destination
          phase: 'scout',          // scout -> exfil -> (run home) -> scout
          plantCd: INTRIGUE.plantCadence * Math.random(),  // stagger first plant
        };
        this.spies.push(m);
        this.stats.spies++;
      }
    }
  }

  // Per-cadence: each live, disguised spy near the town core that has a willing
  // OBSERVER (a townsperson within talk range) plants a false feud spark — marking
  // a third innocent townsperson as hostile in the observer's beliefs. Guarded.
  tick(ctx: Ctx, step: number): void {
    if (!INTRIGUE || !INTRIGUE.enabled) return;
    if (!this._assigned) this._assignSpies();
    if (!this.spies.length) return;

    this._acc += step;
    if (this._acc < INTRIGUE.tickEvery) return;
    this._acc = 0;

    this.stats.disguised = this.spies.filter((s) => s && s.alive && s.disguiseFaction).length;

    for (const spy of this.spies) {
      try { this._runSpy(spy, ctx); } catch { /* never throw on the tick */ }
    }
  }

  _runSpy(spy: Ag, ctx: Ctx): void {
    if (!spy || !spy.alive || !spy.spy) return;
    const S = spy.spy;
    // dropped cover (e.g. once it starts fighting in a raid) — a spy in open
    // combat is no longer infiltrating; combat is truthful regardless.
    if (spy.goal && spy.goal.kind === 'fight') return;

    S.plantCd -= INTRIGUE.tickEvery;
    if (S.phase !== 'scout' || S.plantCd > 0) return;

    // only plant while genuinely INSIDE the town core (near the market/origin) —
    // a spy must be embedded to whisper a rumour.
    const distCore = Math.hypot(spy.pos.x, spy.pos.z);
    if (distCore > INTRIGUE.coreRadius) return;

    // find a townsperson OBSERVER within talk range to whisper to, and a SEPARATE
    // innocent townsperson to frame. Both read from ground truth here (this is the
    // deceiver's own action, not a belief query) but we WRITE only a false belief.
    let observer = null, victim = null;
    for (const o of ctx.agents) {
      if (o === spy || !o.alive || o.controlled) continue;
      if (o.faction !== 'townsfolk') continue;
      const d = spy.pos.distanceTo(o.pos);
      if (!observer && d <= SIM.talkRange) observer = o;
      else if (!victim && d <= INTRIGUE.frameRadius) victim = o;
      if (observer && victim) break;
    }
    if (!observer || !victim || observer === victim) return;

    // PLANT: write a FALSE hostile belief into the observer about the innocent
    // victim — low confidence, rumor provenance, so it FADES unless reinforced.
    // This is the spark that can ignite a feud (the observer now believes a
    // peaceful neighbour means it harm).
    observer.beliefs.plant(victim.id, {
      faction: victim.faction,           // they DO know who it is — the lie is the intent
      pos: victim.pos,
      tick: ctx.time,
      hostile: true,                     // the falsehood: "this neighbour is hostile"
      suspicion: INTRIGUE.plantSuspicion,
      confidence: INTRIGUE.plantConfidence ?? SOURCE.RUMOR.conf,
    });
    this.stats.plants++;
    S.plantCd = INTRIGUE.plantCadence;

    // CAUGHT IN THE ACT — a plant may be witnessed, exposing the spy. Its cover is
    // blown: ground-truth faction now shows, and the town turns on the traitor.
    // (Skipped while the Director is running this spy as a SPY'S WEB arc — there the
    // exposure is a built-up revelation, not an abrupt catch, so the arc owns it.)
    if (!spy._spyArc && Math.random() < (INTRIGUE.unmaskChance || 0)) { this._unmask(spy, ctx); return; }

    // record the deceit so the inspector/chronicle can read it (guarded).
    if (spy.memory && spy.memory.record) {
      try {
        spy.memory.record({
          t: ctx.time, kind: 'intrigue', withId: observer.id,
          valence: -0.4, salience: 0.5,
        });
      } catch { /* never throw */ }
    }

    // having planted, exfiltrate (decide.js drives the actual movement).
    if (INTRIGUE.exfilAfterPlant) { S.phase = 'exfil'; this.stats.exfils++; }
  }

  // UNMASK — the spy is exposed. Drop its cover (so perception now reads its TRUE,
  // hostile faction and the town hunts it), stop it spying, and let every nearby
  // townsperson SEE the truth at once. A saga-worthy beat: a trusted neighbour was
  // a bandit infiltrator all along.
  _unmask(spy: Ag, ctx: Ctx): void {
    try {
      spy.disguiseFaction = null;     // cover blown — true faction now perceived
      spy.spy = null;                 // no longer an infiltrator (a hunted enemy now)
      spy._unmasked = true;
      this.stats.unmasked = (this.stats.unmasked || 0) + 1;
      // every nearby townsperson now KNOWS the truth (latched hostile on the spy).
      for (const o of ctx.agents) {
        if (o === spy || !o.alive || o.controlled || o.faction !== 'townsfolk') continue;
        if (spy.pos.distanceTo(o.pos) > SIM.visionRange) continue;
        try { const b = o.beliefs.observe(spy.id, spy.faction, spy.pos, ctx.time, true); if (b) b.hostile = true; } catch { /* */ }
      }
      const ch = this.sim.chronicle;
      if (ch && ch.note) ch.note('legend', spy.id, `${spy.name} is unmasked as a bandit spy — a traitor in the town's midst, now hunted.`);
    } catch { /* never throw on the tick */ }
  }
}
