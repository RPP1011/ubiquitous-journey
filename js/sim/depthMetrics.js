// Depth metrics — quantify HOW RICHLY the sim's mechanics and the NPCs' behaviour
// emerge, not merely THAT they do (which the soak suite already asserts). The soak
// answers "did trades happen / beliefs form / an ambition progress?" with a yes/no;
// this answers "how varied, how deep, how interconnected?" with a 0-100 score per
// metric across two axes:
//
//   • SYSTEM MECHANICS DEPTH — how many subsystems actually fire, how much they
//     INTERACT (cross-system co-activation), economic price discovery, the variety
//     of deeds/verbs/tags on the RPG bus, narrative-beat breadth, the deception
//     pipeline, director dynamics, closed-loop gold conservation.
//   • NPC BEHAVIOUR DEPTH — the behavioural repertoire NPCs exercise (goal-kind
//     diversity + entropy + per-agent breadth), the deliberative goal stack, the
//     Theory-of-Mind belief tables (richness + gossip reach + provenance), episodic
//     memory consolidation, emergent-identity (class) diversity & spread, ambitions.
//
// Design notes, deliberately mirroring the rest of the sim:
//   - HEADLESS-SAFE: reads agent/sim state only; no DOM, no Three beyond what the
//     agents already hold. Reusable from a browser "Emergence" panel later.
//   - NEVER THROWS on the tick (the freeze lesson): every signal getter and every
//     sample step is guarded; a missing/!changed subsystem degrades to 0, not a
//     crash. So this is safe to `sample()` inside a live frame loop too.
//   - TIME-SAMPLED, not just end-snapshot: behaviour, ambitions, prices and
//     subsystem activity are transient — an end-of-run snapshot under-observes the
//     diversity that genuinely emerged. The probe samples periodically and keeps
//     peaks / unions / series; stable end-state (classes, LTM, groups) is read once.

import { SIM, SOURCE } from './simconfig.js';

// --- tiny stats helpers -----------------------------------------------------
const clamp01 = (x) => Math.max(0, Math.min(1, x || 0));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
};
// Normalised Shannon entropy (0..1) of a count map — 0 = one behaviour dominates,
// 1 = perfectly even spread across the observed behaviours.
const normEntropy = (counts) => {
  const vals = [...counts.values()].filter((v) => v > 0);
  const total = vals.reduce((s, v) => s + v, 0);
  if (total <= 0 || vals.length <= 1) return 0;
  let h = 0;
  for (const v of vals) { const p = v / total; h -= p * Math.log(p); }
  return clamp01(h / Math.log(vals.length));
};
const pct = (n, d) => (d > 0 ? n / d : 0);
const pairKey = (a, b) => (a < b ? a + '+' + b : b + '+' + a);

// --- subsystem signals ------------------------------------------------------
// One row per readable subsystem counter. `get(sim)` returns a monotone-ish
// activity scalar (summed counters) — we read DELTAS between samples to know which
// subsystems FIRED in a window (for coverage + co-activation), and the first
// non-zero crossing for the emergence timeline. All getters are guarded by read().
const SIGNALS = [
  { key: 'director',  label: 'Director (raids/sparks)', get: (s) => sum(s.director?.stats, ['raids', 'opportunities', 'crises', 'sparks', 'tropes', 'reliefs']) },
  { key: 'combat',    label: 'Combat (kills)',          get: (s) => s.agents.reduce((t, a) => t + (a.life ? a.life.kills : 0), 0) },
  { key: 'economy',   label: 'Market (trades)',         get: (s) => (s._depTrades || 0) },
  { key: 'intrigue',  label: 'Intrigue (spies/plants)', get: (s) => sum(s.intrigue?.stats, ['spies', 'plants', 'exfils', 'disguised']) },
  { key: 'lineage',   label: 'Lineage (births)',        get: (s) => (s.lineage ? (s.lineage.births || 0) + (s.lineage.apprenticeships || 0) : 0) },
  { key: 'watch',     label: 'Night Watch',             get: (s) => sum(s.watch?.stats, ['recruited', 'captains', 'fallen']) },
  { key: 'faith',     label: 'Faith (small gods)',      get: (s) => sum(s.faith?.stats, ['conversions', 'miracles', 'apostasies', 'revivals']) },
  { key: 'expedition', label: 'Expeditions (delves)',   get: (s) => sum(s.expeditions?.stats, ['mounted', 'triumphs', 'losses', 'slain']) },
  { key: 'reporter',  label: 'Press (stories filed)',   get: (s) => sum(s.reporter?.stats, ['filed', 'wire']) },
  { key: 'bounties',  label: 'Bounty labour market',    get: (s) => sum(s.bounties?.stats, ['taken', 'done', 'failed']) },
  { key: 'arbitrage', label: 'Arbitrage (caravans)',    get: (s) => sum(s.arbitrage?.stats, ['taken', 'sold', 'gaveUp']) },
  { key: 'patrician', label: 'Patrician (peacemaking)', get: (s) => sum(s.patrician?.stats, ['truces', 'quelled']) },
  { key: 'quests',    label: 'Quest board',             get: (s) => (s.quests ? (s.quests.completed || 0) + (s.quests.offers ? s.quests.offers.length : 0) : 0) },
  { key: 'groups',    label: 'Social groups',           get: (s) => s.agents.filter((a) => a.bandLeaderId != null).length },
  { key: 'chronicle', label: 'Chronicle (beats)',       get: (s) => (s.chronicle ? s.chronicle.recent(9999).length : 0) },
];
function sum(obj, keys) { if (!obj) return 0; let t = 0; for (const k of keys) t += obj[k] || 0; return t; }
function read(sig, sim) { try { return sig.get(sim) || 0; } catch { return 0; } }

// ----------------------------------------------------------------------------
// The probe: construct with the sim, call sample(now) on a cadence during the run,
// then report(telemetry) once at the end. All accumulation is bounded.
export class DepthProbe {
  constructor(sim) {
    this.sim = sim;
    this.samples = 0;
    // behaviour
    this.goalCounts = new Map();          // goal.kind -> ticks observed (population-wide)
    this.agentGoalKinds = new Map();      // agentId -> Set(kinds) it has visited
    this.agentAmbitions = new Map();      // agentId -> Set(ambition.kind)
    this.ambitionKinds = new Map();       // ambition.kind -> ticks
    this.agentsWithStackedGoal = new Set(); // agentId observed carrying a derived goal
    this.goalFroms = new Set();           // distinct goal-stack provenances ('assaulted', 'windfall', …)
    // ToM peaks (beliefs decay/evict, so end-snapshot misses the peak)
    this.maxHops = 0;
    this.peakRumorBorn = 0;
    this.gossipShareSeries = [];          // per-sample share of beliefs that are 2nd-hand+
    this.peakGossipShare = 0;
    // economy price series, commodity -> [clearAvg samples]
    this.priceSeries = new Map();
    // subsystem activity
    this.sigLast = new Map();             // key -> last value
    this.sigFired = new Set();            // keys that ever advanced
    this.firstFire = [];                  // [{t, key, label}] emergence timeline
    this.coPairs = new Map();             // pairKey -> times co-activated
    // REASONING-FIRE telemetry (Phase 2a Step 4) — STRICTLY ADDITIVE: a context probe of how
    // often the InteractionSchema layer actually fires, sampled from each agent's own-state
    // _schemaFireCount (set by the interpreter every cognition tick). It feeds NO scored metric
    // and NO floor — it does not touch the behaviour/mechanics axes or the distinctGoals
    // denominator — so it can never inflate a score; it is reported as a context line only.
    this.schemaFires = 0;                 // Σ schemas fired across all samples
    this.schemaFireSamples = 0;           // agent-samples observed (for the per-agent-tick mean)
    this.schemaFireAgents = new Set();    // distinct agents that ever fired a schema
    // REASONING-COST telemetry (Phase 3 — also STRICTLY ADDITIVE, non-scored context). Counts
    // the per-tick DELIBERATIVE work — schema predicate evals (above), decide() invocations +
    // utility candidates scored, plan replans + plan depth — normalised per LIVING agent-sample
    // so "tractable" is MEASURED (the doc's per-agent-per-tick cost budget). Read from each
    // agent's own-state counters (set by interpreter/decide/planner); degrades to 0 if absent.
    // Feeds NO scored metric and NO floor — reported as a context block only, like schemaFires.
    this.decideCalls = 0;                 // Σ ticks decide() ran across all samples
    this.decideCands = 0;                 // Σ utility candidates scored
    this.planReplans = 0;                 // Σ plan (re)plans
    this.planDepthMax = 0;                // deepest plan observed (gauge)
    this.reasonCostSamples = 0;           // living non-controlled agent-samples (the denominator)
  }

  // Call each sampling window. `now` is sim time (seconds). Cheap + guarded.
  sample(now) {
    this.samples++;
    const sim = this.sim;

    // -- behaviour: goal kinds, breadth, ambitions, goal stack ----------------
    try {
      let sBelief = 0, sSecond = 0;      // town-wide belief tally THIS sample
      for (const a of sim.agents) {
        if (a.controlled || !a.alive) continue;
        const k = a.goal && a.goal.kind;
        if (k) {
          this.goalCounts.set(k, (this.goalCounts.get(k) || 0) + 1);
          let set = this.agentGoalKinds.get(a.id);
          if (!set) this.agentGoalKinds.set(a.id, (set = new Set()));
          set.add(k);
        }
        const amb = a.ambition && a.ambition.kind;
        if (amb) {
          this.ambitionKinds.set(amb, (this.ambitionKinds.get(amb) || 0) + 1);
          let as = this.agentAmbitions.get(a.id);
          if (!as) this.agentAmbitions.set(a.id, (as = new Set()));
          as.add(amb);
        }
        if (Array.isArray(a.goals) && a.goals.length) {
          this.agentsWithStackedGoal.add(a.id);
          for (const g of a.goals) if (g && g.from) this.goalFroms.add(g.from);
        }
        // reasoning-fire telemetry (additive context): how many schemas fired for this agent
        // on the most recent cognition tick. Own-state read; degrades to 0 if absent.
        const fires = a._schemaFireCount || 0;
        this.schemaFireSamples++;
        this.schemaFires += fires;
        if (fires > 0) this.schemaFireAgents.add(a.id);
        // reasoning-COST telemetry (additive context): per-tick deliberative work for this
        // agent on its most recent cognition tick. Own-state reads; degrade to 0 if absent.
        this.reasonCostSamples++;
        this.decideCalls += (a._decideCalls || 0);
        this.decideCands += (a._decideCands || 0);
        this.planReplans += (a._planReplans || 0);
        if ((a._planDepth || 0) > this.planDepthMax) this.planDepthMax = a._planDepth || 0;
        // ToM peaks
        if (a.beliefs && typeof a.beliefs.all === 'function') {
          let rumor = 0;
          for (const b of a.beliefs.all()) {
            if ((b.hops || 0) > this.maxHops) this.maxHops = b.hops || 0;
            if (b.rumorBorn) rumor++;
            sBelief++;
            if ((b.hops || 0) >= 1 || (b.source && b.source !== SOURCE.WITNESSED.tag)) sSecond++;
          }
          if (rumor > this.peakRumorBorn) this.peakRumorBorn = rumor;
        }
      }
      // live gossip prevalence: what share of the whole town's belief-space is
      // hearsay RIGHT NOW. Sampled over the run (peak + mean) because gossip
      // beliefs decay / get overwritten by fresh witnessing — a single end frame
      // badly under-counts how far rumour actually reaches.
      if (sBelief > 0) {
        const share = sSecond / sBelief;
        this.gossipShareSeries.push(share);
        if (share > this.peakGossipShare) this.peakGossipShare = share;
      }
    } catch { /* never throw on the tick */ }

    // -- economy price series -------------------------------------------------
    try {
      const rows = sim._depEconRows ? sim._depEconRows() : [];
      for (const r of rows) {
        let arr = this.priceSeries.get(r.commodity);
        if (!arr) this.priceSeries.set(r.commodity, (arr = []));
        if (r.clearAvg > 0) arr.push(r.clearAvg);
      }
    } catch { /* optional */ }

    // -- subsystem activity: deltas -> coverage, co-activation, timeline ------
    try {
      const firedNow = [];
      for (const sig of SIGNALS) {
        const v = read(sig, sim);
        const last = this.sigLast.has(sig.key) ? this.sigLast.get(sig.key) : v;
        if (v > last) {
          firedNow.push(sig.key);
          if (!this.sigFired.has(sig.key)) {
            this.sigFired.add(sig.key);
            this.firstFire.push({ t: now, key: sig.key, label: sig.label });
          }
        }
        this.sigLast.set(sig.key, v);
      }
      // every distinct pair active in the SAME window is an interaction signal
      for (let i = 0; i < firedNow.length; i++)
        for (let j = i + 1; j < firedNow.length; j++) {
          const pk = pairKey(firedNow[i], firedNow[j]);
          this.coPairs.set(pk, (this.coPairs.get(pk) || 0) + 1);
        }
    } catch { /* never throw */ }
  }

  // Build the scored report. `telemetry` supplies the RPG/econ ledger accessors so
  // this module stays decoupled from those singletons (the runner passes them in).
  report(telemetry = {}) {
    const sim = this.sim;
    const npcs = sim.agents.filter((a) => !a.controlled);
    const alive = npcs.filter((a) => a.alive);

    // ===== NPC BEHAVIOUR DEPTH ============================================
    // distinctGoals/goalEntropy are keyed on goal.kind (sampled directly above). After
    // the Phase 2b steering-substrate collapse this STILL counts the active behavioural
    // repertoire: each locomotion goal.kind maps 1:1 to a steer-fill (STEER_FILLS in
    // agent/steer.js), and the special executors (plan/fight/spy/build/eat) keep their
    // own kinds — no kind was unified, so the count is invariant under the dispatch
    // collapse (see test/suites/soak.mjs's STEER superset net, the additive proof).
    const distinctGoals = this.goalCounts.size;
    const goalEntropy = normEntropy(this.goalCounts);
    const breadth = pct(
      [...this.agentGoalKinds.values()].filter((s) => s.size >= 3).length,
      this.agentGoalKinds.size,
    );
    const deliberative = pct(this.agentsWithStackedGoal.size, npcs.length);

    // beliefs (end snapshot for richness + gossip reach)
    let beliefTotal = 0, secondHand = 0, withBeliefs = 0;
    for (const a of npcs) {
      if (!a.beliefs || typeof a.beliefs.all !== 'function') continue;
      let n = 0;
      for (const b of a.beliefs.all()) {
        n++; beliefTotal++;
        if ((b.hops || 0) >= 1 || (b.source && b.source !== SOURCE.WITNESSED.tag)) secondHand++;
      }
      if (n) withBeliefs++;
    }
    const beliefsPer = pct(beliefTotal, withBeliefs);
    // gossip reach: time-sampled MEAN share of hearsay across the run (robust to
    // the end-frame noise the snapshot `secondHand/beliefTotal` would give), with
    // the peak + deepest chain shown alongside. `secondHand` retained for context.
    const gossipMean = mean(this.gossipShareSeries);
    void secondHand;

    // memory consolidation
    const withLtm = npcs.filter((a) => a.memory && a.memory.ltm && a.memory.ltm.size > 0).length;
    const memKinds = new Set();
    for (const a of npcs) {
      try { for (const e of a.memory.salient(8)) if (e && e.kind) memKinds.add(e.kind); } catch { /**/ }
    }
    const ltmShare = pct(withLtm, npcs.length);

    // emergent identity (classes)
    const classKeys = new Set();
    const procKeys = new Set();
    const levels = [];
    let classed = 0, multiClass = 0;
    for (const a of npcs) {
      const p = a.progression; if (!p || !p.classes) continue;
      if (p.classes.size > 0) { classed++; levels.push(p.totalLevel || 0); }
      if (p.classes.size > 1) multiClass++;
      for (const k of p.classes.keys()) { classKeys.add(k); if (String(k).startsWith('proc:')) procKeys.add(k); }
    }
    const levelSpread = stdev(levels);

    const behaviour = scorecard([
      ['Behavioural repertoire', `${distinctGoals} distinct goal-kinds`, pct(distinctGoals, 11)],
      ['Behavioural entropy', `H=${goalEntropy.toFixed(2)} (even spread)`, goalEntropy],
      ['Per-agent breadth', `${(breadth * 100).toFixed(0)}% visit ≥3 behaviours`, breadth],
      ['Deliberative goals', `${(deliberative * 100).toFixed(0)}% carry a derived goal · froms:${this.goalFroms.size}`, pct(deliberative, 0.25)],
      ['ToM belief richness', `${beliefsPer.toFixed(1)} beliefs/agent (cap ${SIM.beliefsPerAgent})`, pct(beliefsPer, SIM.beliefsPerAgent)],
      ['Gossip reach', `${(gossipMean * 100).toFixed(0)}% hearsay (peak ${(this.peakGossipShare * 100).toFixed(0)}%) · max ${this.maxHops} hops`, pct(gossipMean, 0.2)],
      ['Memory consolidation', `${(ltmShare * 100).toFixed(0)}% hold LTM · ${memKinds.size} episode-kinds`, pct(ltmShare, 0.3)],
      ['Identity diversity', `${classKeys.size} classes (${procKeys.size} procedural)`, pct(classKeys.size, 12)],
      ['Identity spread', `σ(level)=${levelSpread.toFixed(1)} storied↔quiet`, pct(levelSpread, 3)],
      ['Ambition variety', `${this.ambitionKinds.size}/5 kinds pursued`, pct(this.ambitionKinds.size, 5)],
    ]);

    // ===== SYSTEM MECHANICS DEPTH =========================================
    // coverage: of the signals that are AVAILABLE (readable), how many fired
    const available = SIGNALS.filter((sig) => this.sigLast.has(sig.key)).length || SIGNALS.length;
    const coverage = pct(this.sigFired.size, available);

    const interactions = this.coPairs.size;

    // economy: commodities + price discovery (volatility of clearing price / base)
    const econRows = (telemetry.allCommodityStats && telemetry.allCommodityStats()) || [];
    const tradedGoods = (telemetry.tradedCommodityCount && telemetry.tradedCommodityCount()) || econRows.length;
    const volatilities = [];
    for (const [, series] of this.priceSeries) {
      if (series.length >= 3) { const m = mean(series); if (m > 0) volatilities.push(stdev(series) / m); }
    }
    const priceDiscovery = mean(volatilities);

    // deeds on the RPG bus: verb + tag variety, verb entropy
    const verbs = (telemetry.xpByVerb && telemetry.xpByVerb()) || [];
    const verbCounts = new Map(verbs.map((v) => [v.verb, v.n || v.xp || 1]));
    const verbEntropy = normEntropy(verbCounts);
    const tagSet = this._tagsSeen || new Set();

    // narrative: chronicle beat-kind breadth + high-drama share
    const beats = sim.chronicle ? sim.chronicle.recent(9999) : [];
    const beatKinds = new Set(beats.map((b) => b.kind));
    const HIGH = new Set(['legend', 'raid', 'vendetta', 'death', 'kill', 'union']);
    const highDrama = pct(beats.filter((b) => HIGH.has(b.kind)).length, beats.length);

    // deception pipeline stages lit (spies/plants/exfils/rumour-born hostility)
    const ig = sim.intrigue && sim.intrigue.stats;
    const decep = ig ? [ig.spies > 0, ig.plants > 0, ig.exfils > 0, this.peakRumorBorn > 0].filter(Boolean).length : 0;

    // director dynamics: distinct event types it actually used
    const ds = sim.director && sim.director.stats;
    const dirKinds = ds ? ['raids', 'opportunities', 'crises', 'sparks', 'tropes', 'reliefs'].filter((k) => ds[k] > 0).length : 0;

    const goldConserved = telemetry.goldConserved ? 1 : 0;

    const mechanics = scorecard([
      ['Subsystem coverage', `${this.sigFired.size}/${available} subsystems fired`, coverage],
      ['Cross-system interaction', `${interactions} co-activating subsystem pairs`, pct(interactions, 10)],
      ['Economic breadth', `${tradedGoods} commodities traded`, pct(tradedGoods, 3)],
      ['Price discovery', `${(priceDiscovery * 100).toFixed(1)}% clearing-price volatility`, pct(priceDiscovery, 0.08)],
      ['Deed-verb variety', `${verbs.length} verbs · H=${verbEntropy.toFixed(2)}`, pct(verbs.length, 12)],
      ['Deed-tag variety', `${tagSet.size} distinct deed tags`, pct(tagSet.size, 14)],
      ['Narrative breadth', `${beatKinds.size}/14 beat-kinds · ${(highDrama * 100).toFixed(0)}% high-drama`, pct(beatKinds.size, 10)],
      ['Deception pipeline', `${decep}/4 stages lit (spy→plant→spread→exfil)`, pct(decep, 4)],
      ['Director dynamics', `${dirKinds}/6 director levers pulled`, pct(dirKinds, 5)],
      ['Closed-loop economy', goldConserved ? 'gold conserved (no minting)' : 'LEAK — gold not conserved', goldConserved],
    ]);

    const overall = (behaviour.score + mechanics.score) / 2;
    // reasoning-fire CONTEXT (Phase 2a, strictly additive — NOT a scored axis): mean schemas
    // fired per agent-sample + how many distinct agents ever fired one. Reported, never scored.
    const reasoning = {
      perAgentTick: pct(this.schemaFires, this.schemaFireSamples),
      totalFires: this.schemaFires,
      agents: this.schemaFireAgents.size,
      // REASONING COST PER AGENT-TICK (Phase 3, additive context — NOT scored, NOT a floor).
      // Normalised by living non-controlled agent-samples so it is FLAT-PER-AGENT by
      // construction (bounded beliefs/schemas/candidates) — the metric LOD must keep flat or
      // lower as N grows. `total` sums the cheap O(1) work units (schema evals + candidates
      // scored + replans) per agent-tick; a thinned agent contributes 0 on its skipped ticks.
      cost: {
        schemaEvalsPerAgentTick: pct(this.schemaFires, this.reasonCostSamples),
        decideCallsPerAgentTick: pct(this.decideCalls, this.reasonCostSamples),
        candsPerAgentTick: pct(this.decideCands, this.reasonCostSamples),
        replansPerAgentTick: pct(this.planReplans, this.reasonCostSamples),
        planDepthMax: this.planDepthMax,
        total: pct(this.schemaFires + this.decideCands + this.planReplans, this.reasonCostSamples),
        samples: this.reasonCostSamples,
      },
    };
    return {
      overall,
      axes: { behaviour, mechanics },
      timeline: this.firstFire.slice().sort((a, b) => a.t - b.t),
      interactions: { pairs: interactions, top: topPairs(this.coPairs, 6) },
      reasoning,
      samples: this.samples,
    };
  }

  // optional: feed the deed firehose so tag variety is measured. The runner can
  // subscribe the RPG bus and push tags here; falls back to xp-verb count if not.
  noteTags(tags) {
    if (!this._tagsSeen) this._tagsSeen = new Set();
    if (Array.isArray(tags)) for (const t of tags) this._tagsSeen.add(t);
  }
}

function scorecard(rows) {
  const metrics = rows.map(([label, value, raw]) => ({ label, value, score: clamp01(raw) }));
  const score = metrics.length ? mean(metrics.map((m) => m.score)) : 0;
  return { score, metrics };
}
function topPairs(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ pair: k, n: v }));
}

// ----------------------------------------------------------------------------
// Pretty-printer — renders a report() result as a terminal scorecard. Pure string
// builder so a browser panel can reuse the same report() object differently.
const bar = (s) => { const n = Math.round(clamp01(s) * 20); return '█'.repeat(n) + '·'.repeat(20 - n); };
const grade = (s) => (s >= 0.8 ? 'A' : s >= 0.65 ? 'B' : s >= 0.5 ? 'C' : s >= 0.35 ? 'D' : 'F');

export function formatReport(rep) {
  const L = [];
  const axis = (title, ax) => {
    L.push(`\n  ${title}  —  ${(ax.score * 100).toFixed(0)}/100  [${grade(ax.score)}]`);
    for (const m of ax.metrics)
      L.push(`    ${bar(m.score)} ${(m.score * 100).toFixed(0).padStart(3)}  ${m.label.padEnd(26)} ${m.value}`);
  };
  L.push('\n╔══ EMERGENT DEPTH REPORT ════════════════════════════════════════════');
  L.push(`  OVERALL DEPTH INDEX:  ${(rep.overall * 100).toFixed(0)}/100  [${grade(rep.overall)}]   (${rep.samples} samples)`);
  axis('SYSTEM MECHANICS DEPTH', rep.axes.mechanics);
  axis('NPC BEHAVIOUR DEPTH', rep.axes.behaviour);
  L.push('\n  EMERGENCE TIMELINE (first activation):');
  L.push('    ' + (rep.timeline.length
    ? rep.timeline.map((f) => `${Math.round(f.t)}s ${f.label.replace(/ \(.*/, '')}`).join('  →  ')
    : '(none)'));
  L.push('\n  TOP CROSS-SYSTEM INTERACTIONS (subsystems firing together):');
  L.push('    ' + (rep.interactions.top.length
    ? rep.interactions.top.map((p) => `${p.pair}×${p.n}`).join('   ')
    : '(none)'));
  if (rep.reasoning) {
    L.push('\n  REASONING LAYER (InteractionSchemas — context, not scored):');
    L.push(`    ${rep.reasoning.totalFires} schema firings · ${rep.reasoning.perAgentTick.toFixed(3)}/agent-tick · ` +
      `${rep.reasoning.agents} agents reasoned`);
    const c = rep.reasoning.cost;
    if (c) {
      L.push('\n  REASONING COST PER AGENT (Phase 3 — context, not scored):');
      L.push(`    ${c.schemaEvalsPerAgentTick.toFixed(3)}/at schema-evals · ${c.decideCallsPerAgentTick.toFixed(3)}/at decide · ` +
        `${c.candsPerAgentTick.toFixed(3)}/at cands · ${c.replansPerAgentTick.toFixed(3)}/at replans · ` +
        `maxPlanDepth ${c.planDepthMax} · TOTAL ${c.total.toFixed(3)}/agent-tick`);
    }
  }
  L.push('╚══════════════════════════════════════════════════════════════════');
  return L.join('\n');
}
