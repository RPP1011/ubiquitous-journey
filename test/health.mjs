// ANOMALY HEALTH-CHECKS + COHORT METRICS — the lifetrace tool's auto-flag layer (BUILD STEP 3).
//
// Five cheap heuristics that auto-catch the exact eyeball bugs a raw-total glance missed (oath churn,
// corpse bloat, salience decay-to-zero, arc-kind monoculture, behavior collapse), plus four roster-
// wide distributional cohort metrics. ALL are OBSERVER-LAYER / truth-side reads — display + tests
// only, NEVER read back by cognition (the trace's write-only rule extends: a health-check is read-
// only-on-the-side-channel). Pure functions over a finished sim; every read guarded (never throws).
//
// KEY DESIGN RULE (doc 13 rule 6, "every value names its probe"): a health-check is a RATIO with an
// absolute-N FLOOR, dividing the SMALLEST existing aggregate already folded fold-on-event — never a
// new scan. The N-floor is the load-bearing detail: it converts "eyeballing raw numbers" into "a
// scale-free ratio that only fires once the world is big enough to mean it", which is exactly why
// these four bugs were invisible to a raw-total glance but obvious as rates.
//
// Each CHECK returns { name, ok, flagged, ratio, floorMet, threshold, why, detail } — the
// {ok|flagged, ratio, floorMet} triple a test or the dev HUD asserts on the RATIO, not a magic raw
// number. Each COHORT metric returns { name, shape, ...summary }.

import { TRACE } from '../js/sim/simconfig.js';
import { REASON } from '../js/sim/trace.js';
import { deedLedger, oaths } from '../js/sim/signals.js';

const H = (TRACE && TRACE.health) || {};

// ---- small shared helpers (all guarded) -----------------------------------------------------------
function livingTownsfolk(sim) {
  const out = [];
  try { for (const a of sim.agents) if (a && a.alive && !a.controlled) out.push(a); } catch { /* */ }
  return out;
}
function quantiles(xs, qs) {
  if (!xs.length) return qs.map(() => 0);
  const s = xs.slice().sort((x, y) => x - y);
  return qs.map((q) => {
    const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[i];
  });
}
// fold time-in-each-goal from an agent's trace ring (GOAL_DERIVED stamps the (kind,t) we need —
// the design's "ride the existing trace ring"). Returns { topFrac, span, top } over the ring window.
// A SAMPLE over the bounded ring, not the exact lifetime — that is the documented, cheap approach.
export function goalBudgetOf(a) {
  try {
    const tr = (a && a.trace && a.trace.recent(64)) || [];
    const stamps = [];
    for (const e of tr) if (e && e.code === REASON.GOAL_DERIVED && e.a != null) stamps.push({ k: String(e.a), t: e.t || 0 });
    if (stamps.length < 2) return { topFrac: 0, span: 0, top: null };
    stamps.sort((x, y) => x.t - y.t);                       // recent() is newest-first → re-order to walk forward
    const span = Math.max(0, stamps[stamps.length - 1].t - stamps[0].t);
    if (span <= 0) return { topFrac: 0, span: 0, top: null };
    const byKind = {};
    for (let i = 0; i < stamps.length - 1; i++) {
      const dt = Math.max(0, stamps[i + 1].t - stamps[i].t);
      byKind[stamps[i].k] = (byKind[stamps[i].k] || 0) + dt;
    }
    let top = null, topT = 0;
    for (const k in byKind) if (byKind[k] > topT) { topT = byKind[k]; top = k; }
    return { topFrac: topT / span, span, top };
  } catch { return { topFrac: 0, span: 0, top: null }; }
}

function result(name, ratio, floorMet, threshold, flagCond, why, detail) {
  const flagged = !!(floorMet && flagCond);
  return { name, ok: !flagged, flagged, ratio, floorMet, threshold, why, detail };
}

// ============================================================================
// (a) signalChurn — per-agent narrative-signal event-rate implausibility.
// perAgentRate = totalEvents(S) / max(1, livingAgents) exceeds rateCeiling[S]. FLAG when over AND
// total >= signalFloor (so a smoke run can't trip it). Reports the RATIO, not the raw total: 786
// oaths/agent is the bug — a per-event counter on the wrong seam shows as an off-by-100x RATE while
// the raw total reads merely "big" (doc 13 §1: orderings, not measurements).
// ============================================================================
export function signalChurn(sim) {
  const living = livingTownsfolk(sim);
  const n = Math.max(1, living.length);
  const ceil = H.signalRateCeiling || { oaths: 8, deeds: 40, gossip: 200, beats: 12, goals: 60 };
  const floor = H.signalFloor || 200;
  // totals folded over the SAME roster walk (each names its existing aggregate).
  let oathTotal = 0, deedTotal = 0, gossipTotal = 0, goalTotal = 0;
  try {
    for (const a of living) {
      const o = oaths(a); for (const k in o) oathTotal += o[k].sworn;          // oaths(a) accumulator
      const d = deedLedger(a); for (const k in d) deedTotal += d[k].n;         // deedLedger(a) accumulator
      if (a.beliefs && a.beliefs.all) { for (const b of a.beliefs.all()) if (b) gossipTotal += 1; }  // belief rows ≈ gossip reach
      const tr = (a.trace && a.trace.recent(64)) || [];
      for (const e of tr) if (e && e.code === REASON.GOAL_DERIVED) goalTotal += 1;
    }
  } catch { /* never throw */ }
  const fam = [
    ['oaths', oathTotal, ceil.oaths], ['deeds', deedTotal, ceil.deeds],
    ['gossip', gossipTotal, ceil.gossip], ['goals', goalTotal, ceil.goals],
  ];
  // the WORST offender drives the verdict (report all rates in detail).
  let worst = null, worstRatio = 0;
  const detail = {};
  let anyFloor = false;
  for (const [name, total, c] of fam) {
    const rate = total / n;
    detail[name] = { total, perAgent: Number(rate.toFixed(2)), ceiling: c };
    const over = total >= floor && rate > c;
    if (total >= floor) anyFloor = true;
    if (over && rate / c > worstRatio) { worstRatio = rate / c; worst = name; }
  }
  const flagCond = worst != null;
  const ratio = flagCond ? detail[worst].perAgent / detail[worst].ceiling : 0;
  return result('signalChurn', Number(ratio.toFixed(2)), anyFloor, worst ? `${detail[worst].ceiling}/life` : `floor ${floor}`,
    flagCond, 'a per-event counter on the wrong seam (armed-every-tick / re-derive not deduped) shows as an off-by-100x RATE',
    { worst, ...detail });
}

// ============================================================================
// (b) corpseBloat — dead >> alive roster. deadFrac = dead / max(1,total); FLAG when dead > alive*ratio
// AND total >= bloatFloor. 348 total / 92 alive is the canonical "reaper isn't running" smell; a dead
// roster skews every roster-mean aggregate (standing, wealthGini) the narrative probes divide by.
// ============================================================================
export function corpseBloat(sim) {
  let alive = 0, dead = 0;
  try { for (const a of sim.agents) { if (!a || a.controlled) continue; if (a.alive) alive++; else dead++; } } catch { /* */ }
  const total = alive + dead;
  const ratio = total > 0 ? dead / Math.max(1, alive) : 0;
  const floor = H.bloatFloor || 50;
  const bloatRatio = H.bloatRatio || 2.0;
  const deadFrac = total > 0 ? dead / total : 0;
  return result('corpseBloat', Number(ratio.toFixed(2)), total >= floor, `${bloatRatio}× alive`,
    dead > alive * bloatRatio,
    'corpses accumulating in sim.agents instead of being reaped leaks memory + skews every roster-mean aggregate',
    { total, alive, dead, deadFrac: Number(deadFrac.toFixed(2)) });
}

// ============================================================================
// (c) salienceCollapse — memory decay-to-zero. Over a SAMPLE of agents' LTM/MTM, nearZeroFrac =
// fraction with salience <= eps; FLAG when nearZeroFrac >= collapseFrac OR meanSalience <= eps, AND
// sampled >= salienceFloor. The DISTRIBUTION (fraction at the floor) is load-bearing — a few live
// memories can hold the MEAN up while the store is effectively dead. decay-tuned-too-hot starves
// deriveGoals and collapses agents to idle (which (e) then catches downstream).
// ============================================================================
export function salienceCollapse(sim) {
  const eps = H.salienceEps != null ? H.salienceEps : 0.02;
  const floor = H.salienceFloor || 100;
  const collapseFrac = H.collapseFrac || 0.95;
  let sampled = 0, nearZero = 0, sumSal = 0;
  try {
    for (const a of livingTownsfolk(sim)) {
      const m = a.memory; if (!m) continue;
      const eps2 = [...(m.ltm ? m.ltm.items() : []), ...(m.mtm ? m.mtm.items() : [])];
      for (const e of eps2) { if (!e) continue; sampled++; const s = e.salience || 0; sumSal += s; if (s <= eps) nearZero++; }
    }
  } catch { /* */ }
  const nearZeroFrac = sampled > 0 ? nearZero / sampled : 0;
  const meanSalience = sampled > 0 ? sumSal / sampled : 0;
  return result('salienceCollapse', Number(nearZeroFrac.toFixed(3)), sampled >= floor, `${collapseFrac} flat`,
    nearZeroFrac >= collapseFrac || meanSalience <= eps,
    'decay outrunning reinforcement flattens every episode to zero — salient() returns nothing, deriveGoals starves',
    { sampled, nearZero, nearZeroFrac: Number(nearZeroFrac.toFixed(3)), meanSalience: Number(meanSalience.toFixed(3)) });
}

// ============================================================================
// (d) arcMonoculture — one arc-KIND (or one OUTCOME) dominates the closed-arc ring. topKindShare =
// maxOverKinds(count) / closedTotal; FLAG when > monoFrac AND closedTotal >= arcFloor. >80% one kind
// is "arc churn" — one loop firing/closing far more than the rest = the registry recording noise not
// stories (a sweep mis-tuned to lapse everything = the same smell as a top OUTCOME share). Counted at
// the same recentClosed() read the Gazette already does — just tally by kind AND by outcome.
// ============================================================================
export function arcMonoculture(sim) {
  const floor = H.arcFloor || 25;
  const monoFrac = H.monoFrac || 0.80;
  const byKind = {}, byOutcome = {};
  let total = 0;
  try {
    for (const arc of (sim.sagas && sim.sagas._closed) || []) {
      if (!arc) continue;
      total++;
      byKind[arc.kind] = (byKind[arc.kind] || 0) + 1;
      const oc = arc.outcome || 'none';
      byOutcome[oc] = (byOutcome[oc] || 0) + 1;
    }
  } catch { /* */ }
  const topOf = (m) => { let tk = null, tn = 0; for (const k in m) if (m[k] > tn) { tn = m[k]; tk = k; } return { k: tk, n: tn }; };
  const tk = topOf(byKind), to = topOf(byOutcome);
  const kindShare = total > 0 ? tk.n / total : 0;
  const outcomeShare = total > 0 ? to.n / total : 0;
  const top = Math.max(kindShare, outcomeShare);
  return result('arcMonoculture', Number(top.toFixed(2)), total >= floor, `${monoFrac} share`,
    top > monoFrac,
    'one arc-kind/outcome >80% of closed arcs = the registry recording noise not stories (a mis-tuned sweep/double-open)',
    { closedTotal: total, topKind: tk.k, topKindShare: Number(kindShare.toFixed(2)), topOutcome: to.k, topOutcomeShare: Number(outcomeShare.toFixed(2)) });
}

// ============================================================================
// (e) behaviorCollapse — agents stuck in one goal. Per-agent dominantGoalFrac = timeInGoal(top)/life;
// cohort-FLAG when the SHARE of living agents with dominantGoalFrac > stuckFrac itself exceeds
// collapsePopFrac AND living >= behaviorFloor. Per-agent it can be legitimate (a lifelong farmer);
// the POPULATION fraction flags a systemic stall (deriveGoals/pruneGoals at a fixed point) vs one
// homebody. Time-in-goal rides the trace ring's GOAL_DERIVED (kind,t) stamps.
// ============================================================================
export function behaviorCollapse(sim) {
  const floor = H.behaviorFloor || 20;
  const stuckFrac = H.stuckFrac || 0.90;
  const collapsePopFrac = H.collapsePopFrac || 0.25;
  const living = livingTownsfolk(sim);
  let measured = 0, stuck = 0;
  try {
    for (const a of living) {
      const b = goalBudgetOf(a);
      if (b.span <= 0) continue;                            // too few goal-transitions to judge — skip
      measured++;
      if (b.topFrac > stuckFrac) stuck++;
    }
  } catch { /* */ }
  const stuckPopFrac = measured > 0 ? stuck / measured : 0;
  return result('behaviorCollapse', Number(stuckPopFrac.toFixed(2)), living.length >= floor, `${collapsePopFrac} of pop`,
    stuckPopFrac > collapsePopFrac,
    'deriveGoals/pruneGoals at a fixed point — one goal dominates forever and the agent ceases to be an emergent character',
    { living: living.length, measured, stuck, stuckPopFrac: Number(stuckPopFrac.toFixed(2)) });
}

// run all five checks (the order the tool prints them).
export function runHealthChecks(sim) {
  return [signalChurn(sim), corpseBloat(sim), salienceCollapse(sim), arcMonoculture(sim), behaviorCollapse(sim)];
}

// ============================================================================
// COHORT METRICS over N agents (each { name, shape, ... }). Truth-side / observer-layer, display only.
// ============================================================================

// 1. arcEntryFraction — distinct agentIds in any Arc.principals (open+closed) / livingAgents. Are
//    stories reaching agents at all, or pooling on a few protagonists? Low => the layer is inert.
export function arcEntryFraction(sim) {
  const living = livingTownsfolk(sim);
  const ids = new Set();
  try {
    const pull = (arc) => { if (arc && Array.isArray(arc.principals)) for (const p of arc.principals) ids.add(p); };
    for (const arc of (sim.sagas && sim.sagas._closed) || []) pull(arc);
    if (sim.sagas && sim.sagas._open) for (const arc of sim.sagas._open.values()) pull(arc);
  } catch { /* */ }
  // count only ids that are LIVING townsfolk (the cohort denominator).
  const liveIds = new Set(living.map((a) => a.id));
  let inArc = 0; for (const id of ids) if (liveIds.has(id)) inArc++;
  const frac = living.length ? inArc / living.length : 0;
  return { name: 'arcEntryFraction', shape: 'scalar', value: Number(frac.toFixed(3)), inArc, living: living.length };
}

// 2. keptOathRatioDist — per-agent keptOaths / totalOaths, as a small quantile set (p10/p50/p90) + a
//    zero-bucket. "man of his word" vs "the faithless" MEASURED — and a degenerate all-0 / all-1 column
//    is itself a tuning smell (pops mis-classified — the finding-2 bug doc 13 §3 guards).
export function keptOathRatioDist(sim) {
  const eps = H.keptOathZeroEps || 1e-9;
  const ratios = [];
  let zeroBucket = 0, withOaths = 0;
  try {
    for (const a of livingTownsfolk(sim)) {
      const o = oaths(a); let sworn = 0, kept = 0;
      for (const k in o) { sworn += o[k].sworn; kept += o[k].kept; }
      if (sworn <= 0) continue;
      withOaths++;
      const r = kept / sworn;
      ratios.push(r);
      if (r <= eps) zeroBucket++;
    }
  } catch { /* */ }
  const [p10, p50, p90] = quantiles(ratios, [0.1, 0.5, 0.9]);
  return { name: 'keptOathRatioDist', shape: 'quantiles', withOaths, zeroBucket,
    p10: Number(p10.toFixed(2)), p50: Number(p50.toFixed(2)), p90: Number(p90.toFixed(2)) };
}

// 3. neverNamedFraction — living agents whose id never appears in any chronicle beat / arc beat /
//    Arc.principals, over livingAgents. The "forgotten man" share — how much of the roster the
//    narrator never once names. High => the spotlight isn't rotating (pairs with metric 1).
export function neverNamedFraction(sim) {
  const living = livingTownsfolk(sim);
  const named = new Set();
  try {
    // arc principals (open + closed)
    const pull = (arc) => { if (arc && Array.isArray(arc.principals)) for (const p of arc.principals) named.add(p); };
    for (const arc of (sim.sagas && sim.sagas._closed) || []) pull(arc);
    if (sim.sagas && sim.sagas._open) for (const arc of sim.sagas._open.values()) pull(arc);
    // chronicle beats that name an agent (by name substring, the same test the tool's eventfulness uses)
    const beats = (sim.chronicle && sim.chronicle.recent && sim.chronicle.recent(400)) || [];
    for (const b of beats) {
      if (!b || !b.text) continue;
      if (b.subjectId != null) named.add(b.subjectId);
      for (const a of living) if (a.name && b.text.indexOf(a.name) !== -1) named.add(a.id);
    }
  } catch { /* */ }
  let never = 0; for (const a of living) if (!named.has(a.id)) never++;
  const frac = living.length ? never / living.length : 0;
  return { name: 'neverNamedFraction', shape: 'scalar', value: Number(frac.toFixed(3)), never, living: living.length };
}

// 4. medianGoalBudget — median (+ p90) over living agents of the per-agent TOP-goal time-share (the
//    same dominantGoalFrac (e) computes). The cohort backstop to (e): a median near 1.0 is collapse;
//    a healthy world sits well below, confirming agents cycle goals.
export function medianGoalBudget(sim) {
  const fracs = [];
  try {
    for (const a of livingTownsfolk(sim)) { const b = goalBudgetOf(a); if (b.span > 0) fracs.push(b.topFrac); }
  } catch { /* */ }
  const [p50, p90] = quantiles(fracs, [0.5, 0.9]);
  return { name: 'medianGoalBudget', shape: 'quantiles', measured: fracs.length,
    median: Number(p50.toFixed(2)), p90: Number(p90.toFixed(2)) };
}

// run all four cohort metrics.
export function runCohort(sim) {
  return [arcEntryFraction(sim), keptOathRatioDist(sim), neverNamedFraction(sim), medianGoalBudget(sim)];
}
