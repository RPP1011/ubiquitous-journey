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
//   (d) CULTIVATE — a spy that lingers near a GENUINELY DISCONTENTED local (poor AND
//       soured on its own town) makes a REPEATED warming offer that, over several
//       encounters, nudges that local's BELIEF toward the spy's camp (warmer toward
//       the spy, cooler toward its own town). Past a threshold the local TURNS into a
//       WITTING asset — a second-order planter that occasionally plants FOR the spy.
//
// The epistemic split is the whole point: ONLY beliefs are falsified. The spy's
// real faction is unchanged, so when blades actually land combat resolves truly.
//
// Self-contained: if INTRIGUE.enabled is false, or there are no camps / no
// townsfolk, the subsystem is inert. Spies are drawn ONLY from existing camp
// members (no new bodies, no minted gold) — they are camp combatants given a
// cover identity, not extra spawns.

import { INTRIGUE, SOURCE, SIM } from './simconfig.js';
import { rng } from './rng.js';

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
  assets: Ag[];
  stats: Record<string, number>;

  constructor(sim: Sim) {
    this.sim = sim;
    this._acc = 0;
    this._assigned = false;
    this.spies = [];
    this.assets = [];   // turned, witting townsfolk — second-order planters
    // telemetry (read-only; surfaced by the soak assertion + any future UI)
    this.stats = { spies: 0, disguised: 0, plants: 0, exfils: 0, cultivated: 0, assetPlants: 0 };
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
          plantCd: INTRIGUE.plantCadence * rng(),  // stagger first plant
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
    // turned assets plant FOR their handler — a second-order deception, slower + rarer.
    if (this.assets.length) {
      for (const asset of this.assets) {
        try { this._runAsset(asset, ctx); } catch { /* never throw on the tick */ }
      }
    }
  }

  _runSpy(spy: Ag, ctx: Ctx): void {
    if (!spy || !spy.alive || !spy.spy) return;
    const S = spy.spy;
    // dropped cover (e.g. once it starts fighting in a raid) — a spy in open
    // combat is no longer infiltrating; combat is truthful regardless.
    if (spy.goal && spy.goal.kind === 'fight') return;

    // CULTIVATE (optional grooming layer): while embedded, the spy quietly warms a
    // discontented local toward its camp. Runs each pass (independent of plant cadence) —
    // grooming is the slow, repeated work; planting is the rarer event.
    if (INTRIGUE.cultivate) { try { this._cultivate(spy, ctx); } catch { /* never throw */ } }

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
    if (!spy._spyArc && rng() < (INTRIGUE.unmaskChance || 0)) { this._unmask(spy, ctx); return; }

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

  // CULTIVATE — the spy grooms a discontented local. The spy reads GROUND TRUTH here (its
  // OWN sanctioned action: who is near, how poor, how soured) but WRITES ONLY beliefs/flags:
  // it warms the local's belief toward itself and cools it toward its own town. Past a
  // threshold the local TURNS — a witting asset that will plant FOR the spy. The asset itself
  // never has a foreign goal written into it; its later decisions still run off its OWN beliefs
  // (now warmed). Bounded: at most cultivateMaxAssets live assets per spy.
  _cultivate(spy: Ag, ctx: Ctx): void {
    const S = spy.spy;
    if (!S) return;
    // count this spy's CURRENT live, still-witting assets (the per-spy cap).
    let mine = 0;
    for (const a of this.assets) { if (a && a.alive && a._assetOf === spy.id) mine++; }
    if (mine >= (INTRIGUE.cultivateMaxAssets ?? 2)) return;

    // find the nearest genuinely discontented local within a quiet-word radius. "Discontented" =
    // POOR (carries little gold) AND SOURED on its own town (a believed-standing grievance toward
    // a townsfolk neighbour, OR simmering anger). Read from ground truth — the spy's own action.
    const r = INTRIGUE.cultivateRadius ?? 10;
    let local = null, bestD = Infinity;
    for (const o of ctx.agents) {
      if (o === spy || !o.alive || o.controlled) continue;
      if (o.faction !== 'townsfolk') continue;
      if (o._assetOf != null) continue;                       // already someone's asset
      if ((o.gold || 0) >= (INTRIGUE.cultivatePoorBelow ?? 18)) continue;   // not poor enough
      if (!this._discontent(o)) continue;                     // not soured on its town
      const d = spy.pos.distanceTo(o.pos);
      if (d <= r && d < bestD) { bestD = d; local = o; }
    }
    if (!local || !local.beliefs) return;

    // WARM the local's OWN belief toward the spy (it perceives a sympathetic stranger), and COOL
    // its belief toward a townsfolk neighbour it already resents — a slow drift, many encounters.
    const warm = INTRIGUE.cultivateWarmth ?? 0.05;
    const rel = local.beliefs.get(spy.id);
    if (rel) rel.standing = Math.min(1, (rel.standing || 0) + warm);
    else {
      // no prior belief about the spy yet — seed a faint warm one (the cover faction it perceives).
      const seeded = local.beliefs.observe(spy.id, spy.disguiseFaction || spy.faction, spy.pos, ctx.time, false);
      if (seeded) seeded.standing = warm;
    }
    this._cool(local);

    // TURN: once the local's believed standing toward the spy crosses the threshold, it becomes a
    // WITTING asset — set its own-state flags. It is now a minor planter (a second-order deceiver).
    const now = local.beliefs.get(spy.id);
    const standing = now ? (now.standing || 0) : 0;
    if (standing >= (INTRIGUE.cultivateTurnAt ?? 0.45) && local._assetOf == null) {
      local._assetOf = spy.id;                                // whose asset it is
      local._deceives = true;                                 // a (minor) planter now
      local._assetPlantCd = (INTRIGUE.assetPlantCadence ?? 22) * rng();   // stagger first plant
      this.assets.push(local);
      this.stats.cultivated++;
      if (spy.memory && spy.memory.record) {
        try { spy.memory.record({ t: ctx.time, kind: 'intrigue', withId: local.id, valence: 0.3, salience: 0.5 }); } catch { /* */ }
      }
      const ch = this.sim.chronicle;
      if (ch && ch.note) { try { ch.note('drama', spy.id, `${spy.name} has quietly turned ${local.name} — a discontented soul now whispers for the enemy.`); } catch { /* */ } }
    }
  }

  // Is this local SOURED on its own town? — a believed grievance toward a townsfolk neighbour
  // (standing at/below cultivateGrievance) OR simmering anger. Read from the local's own beliefs
  // (observer-layer read for narration of WHO is groomable — never drives the local's decision).
  _discontent(o: Ag): boolean {
    if (o.mood && (o.mood.anger || 0) > 0.4) return true;
    if (!o.beliefs || !o.beliefs.all) return false;
    const thr = INTRIGUE.cultivateGrievance ?? -0.12;
    for (const b of o.beliefs.all()) {
      if (b && b.lastFaction === 'townsfolk' && (b.standing || 0) <= thr) return true;
    }
    return false;
  }

  // Cool a local's belief toward its OWN town: nudge down its standing toward a townsfolk
  // neighbour (the camp's wedge widens). Own-belief write only.
  _cool(local: Ag): void {
    if (!local.beliefs || !local.beliefs.all) return;
    const cool = INTRIGUE.cultivateCooling ?? 0.03;
    for (const b of local.beliefs.all()) {
      if (b && b.lastFaction === 'townsfolk') { b.standing = Math.max(-1, (b.standing || 0) - cool); break; }
    }
  }

  // A turned ASSET plants FOR its handler — a second-order deception. Same falsehood as the spy
  // (an innocent neighbour believed hostile), but SLOWER (its own cadence) and RARER (a chance
  // gate): a townsperson is a reluctant, occasional whisperer, not a professional. Belief write
  // only. If the asset's handler is gone (unmasked/dead), the asset goes quiet (stays turned).
  _runAsset(asset: Ag, ctx: Ctx): void {
    if (!asset || !asset.alive || asset._assetOf == null || asset.controlled) return;
    if (asset.faction !== 'townsfolk') return;
    asset._assetPlantCd = (asset._assetPlantCd || 0) - INTRIGUE.tickEvery;
    if (asset._assetPlantCd > 0) return;
    asset._assetPlantCd = INTRIGUE.assetPlantCadence ?? 22;
    if (rng() >= (INTRIGUE.assetPlantChance ?? 0.5)) return;          // not every chance taken

    // an embedded local: it whispers to a neighbour OBSERVER about a SEPARATE innocent. Same
    // ground-truth read the spy does; writes only a false belief.
    let observer = null, victim = null;
    for (const o of ctx.agents) {
      if (o === asset || !o.alive || o.controlled) continue;
      if (o.faction !== 'townsfolk') continue;
      if (o._assetOf != null) continue;                              // don't frame fellow assets
      const d = asset.pos.distanceTo(o.pos);
      if (!observer && d <= SIM.talkRange) observer = o;
      else if (!victim && d <= INTRIGUE.frameRadius) victim = o;
      if (observer && victim) break;
    }
    if (!observer || !victim || observer === victim || !observer.beliefs) return;
    observer.beliefs.plant(victim.id, {
      faction: victim.faction,
      pos: victim.pos,
      tick: ctx.time,
      hostile: true,
      suspicion: INTRIGUE.plantSuspicion,
      confidence: INTRIGUE.plantConfidence ?? SOURCE.RUMOR.conf,
    });
    this.stats.assetPlants++;
    this.stats.plants++;
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
      // EXPOSURE MAY CHAIN: under interrogation, a caught spy may give up a known collaborator.
      // Each of its turned assets is, by a chance, exposed too — its cover dropped (it no longer
      // plants) and nearby townsfolk learn it conspired (a believed grievance, not a sighting).
      for (const asset of this.assets) {
        if (!asset || asset._assetOf !== spy.id) continue;
        if (rng() >= (INTRIGUE.assetExposeChance ?? 0.5)) continue;
        try { this._exposeAsset(asset, ctx); } catch { /* never throw */ }
      }
    } catch { /* never throw on the tick */ }
  }

  // EXPOSE AN ASSET — a turned collaborator is named. It stops planting (cover dropped) and
  // nearby townsfolk warm a grievance against it (belief write only; it is still a townsperson,
  // not a combat-hostile — the betrayal is social). The asset's own decisions remain its own.
  _exposeAsset(asset: Ag, ctx: Ctx): void {
    asset._assetOf = null;
    asset._deceives = false;
    asset._exposedAsset = true;
    this.stats.exposedAssets = (this.stats.exposedAssets || 0) + 1;
    for (const o of ctx.agents) {
      if (o === asset || !o.alive || o.controlled || o.faction !== 'townsfolk') continue;
      if (!o.beliefs || asset.pos.distanceTo(o.pos) > SIM.visionRange) continue;
      try { const b = o.beliefs.get(asset.id); if (b) b.standing = Math.max(-1, (b.standing || 0) - 0.5); } catch { /* */ }
    }
    const ch = this.sim.chronicle;
    if (ch && ch.note) { try { ch.note('drama', asset.id, `${asset.name} is named a collaborator — the spy's whisperer, now shunned.`); } catch { /* */ } }
  }
}
