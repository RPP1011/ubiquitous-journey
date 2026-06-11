// THE NARRATIVE-SIGNAL CATALOG (docs/architecture/13). Small, bounded, EVENT-FOLDED values the
// observer layer measures so probes (the status sensor, the Gazette, future tropes) have something
// to read. This file holds the priority-cut slice doc 12 step 3 consumes:
//   · goldFast / goldSlow — two-timescale EWMAs of gold (Family A): rise/fall/reversal, replacing a
//     running max so RUIN means a FAST fall, not the spend-down of a windfall (doc-12 review 3).
//   · lossReason ring — the last K downward gold steps TAGGED robbed/spent/fined/gifted (Family A),
//     so RUIN can require an INVOLUNTARY cause (the classification-site discipline, [13] rule 4).
//   · snubsFelt — a per-agent counter of PERCEIVED cold treatment (Family B), the own-state evidence
//     that legitimises the `slandered` memory write (doc-12 review 1) instead of a foreign roster read.
//
// Pure helpers over a lazily-created per-agent `_signals` record, mirroring obligations/experience:
// bounded ring, lazy time-decay (no per-tick pass), every function guarded (never throws on the tick).

import { SIGNALS, COHESION } from './simconfig.js';
import type { Agent, EntityId } from '../../types/sim.js';

interface LossStep { t: number; reason: string; amt: number; }
export interface SignalState {
  gFast: number; gSlow: number; gT: number;   // gold EWMAs + last-sample time
  loss: LossStep[];                            // bounded ring of tagged downward gold steps
  snubs: number; snubT: number;                // snubsFelt counter + last-update (for lazy decay)
  // SECOND SLICE — observer-sampled trajectory fields (lazy; undefined until first sampled):
  sFast?: number; sSlow?: number; stT?: number;        // standing EWMAs + last-sample time (Family A)
  revN?: number; revT?: number; lastSign?: number;     // fortuneReversals: count, last-t, last (fast−slow) sign
  disp?: number; dispT?: number;                       // displacement EWMA + last-sample time (Family A)
  band?: { poor: number; rich: number; outlaw: number }; bandT?: number;   // timeInBand accumulators (Family A)
  dwell?: Record<string, number>; dwellKind?: string; dwellT?: number;     // goal-dwell accumulator: seconds-per-goalKind + current kind + entered-at (the behaviorCollapse measure)
}

function st(a: Agent): SignalState {
  const aa = a as Agent & { _signals?: SignalState };
  if (!aa._signals) aa._signals = { gFast: a.gold || 0, gSlow: a.gold || 0, gT: 0, loss: [], snubs: 0, snubT: 0 };
  return aa._signals;
}
function peek(a: Agent): SignalState | null { return (a as Agent & { _signals?: SignalState })._signals || null; }

// SAMPLE the gold EWMAs toward the agent's CURRENT gold (a time-anchored exponential average). Called
// from the observer pass — a periodic sample, not a per-tick scan. Two half-lives: fast tracks recent
// fortune, slow the long baseline; a sharp drop pulls fast below slow (the RUIN signal). Guarded.
export function sampleGold(a: Agent, now: number): void {
  if (!a) return;
  try {
    const s = st(a); const g = a.gold || 0;
    const dt = Math.max(0, now - s.gT);
    s.gFast = g + (s.gFast - g) * Math.pow(0.5, dt / (SIGNALS.goldHalfFast || 120));
    s.gSlow = g + (s.gSlow - g) * Math.pow(0.5, dt / (SIGNALS.goldHalfSlow || 600));
    s.gT = now;
  } catch { /* never throw on the tick */ }
}

// TAG a downward gold step with its REASON (robbed/fined = involuntary; spent/gifted = voluntary).
// Folded at the conserved transfer sites (the resolver knows which verb moved the gold). Bounded ring.
export function foldLoss(a: Agent, reason: string, amount: number, now: number): void {
  if (!a || !reason) return;
  try {
    if (!(amount > (SIGNALS.lossMin || 1))) return;
    const s = st(a);
    s.loss.push({ t: now, reason, amt: amount });
    while (s.loss.length > (SIGNALS.lossRing || 8)) s.loss.shift();
  } catch { /* never throw */ }
}

// the involuntary (or any named-reason) SHARE of recent losses, by gold amount, over a window. The
// RUIN detector reads this so a voluntary spend-down (all 'spent') never reads as catastrophe.
export function lossReasonShare(a: Agent, reasons: string[], windowSecs: number, now: number): number {
  const s = peek(a); if (!s || !s.loss.length) return 0;
  let named = 0, total = 0;
  for (const l of s.loss) {
    if (now - l.t > windowSecs) continue;
    total += l.amt;
    if (reasons.indexOf(l.reason) !== -1) named += l.amt;
  }
  return total > 0 ? named / total : 0;
}

// the gold TREND — {fast, slow}. Falls back to current gold when no signal state exists yet.
export function goldTrend(a: Agent): { fast: number; slow: number } {
  const s = peek(a); return s ? { fast: s.gFast, slow: s.gSlow } : { fast: a.gold || 0, slow: a.gold || 0 };
}

function snubDecay(s: SignalState, now: number): number {
  const dt = Math.max(0, now - s.snubT);
  return s.snubs * Math.pow(0.5, dt / (SIGNALS.snubHalfLife || 180));
}

// NOTE a perceived snub — a refused trade, a failed ask, gossip-about-self overheard. OWN-STATE
// (the agent felt the cold shoulder); the legitimate input for the `slandered` memory (review 1).
export function noteSnub(a: Agent, now: number): void {
  if (!a) return;
  try { const s = st(a); s.snubs = snubDecay(s, now) + 1; s.snubT = now; } catch { /* never throw */ }
}

// the decayed snubsFelt count (a cold shoulder fades). Read by the status sensor's slander gate.
export function snubsFelt(a: Agent, now: number): number {
  const s = peek(a); return s ? snubDecay(s, now) : 0;
}

// ── GOAL-DWELL accumulator (the behaviorCollapse measure). A small per-agent Record<goalKind,seconds>
// + the CURRENT committed kind + the sim-time it was entered. Folded on decide()'s EXISTING goal-commit
// seam: when the committed goal.kind CHANGES, charge (now − enteredAt) to the PREVIOUS kind and reset.
// So it measures dwell over the WHOLE life (a lifelong farmer legitimately camps 'work' — that is what
// the cohort fraction is for), not a biased 24-deep trace-ring window. PURE OBSERVER/TELEMETRY: an
// own-scalar write, NEVER read back to drive a decision (the epistemic split holds). Guarded; bounded
// (goalKinds are a tiny fixed vocabulary). The lazy `now − enteredAt` of the in-progress kind is added
// by the reader, so no per-tick pass is needed.
export function foldGoalDwell(a: Agent, kind: string, now: number): void {
  if (!a || !kind) return;
  try {
    const s = st(a);
    if (!s.dwell) s.dwell = {};
    if (s.dwellKind === undefined) { s.dwellKind = kind; s.dwellT = now; return; }   // first commit: just arm
    if (s.dwellKind === kind) return;                                                 // same goal still held — nothing to charge yet
    const dt = Math.max(0, now - (s.dwellT || now));
    s.dwell[s.dwellKind] = (s.dwell[s.dwellKind] || 0) + dt;                          // charge the time spent in the PREVIOUS kind
    s.dwellKind = kind; s.dwellT = now;                                               // enter the new kind
  } catch { /* never throw on the tick */ }
}

// the agent's goal-dwell budget: { topFrac, span, top } over its WHOLE measured life — the same shape
// goalBudgetOf returned, now off the dwell accumulator (the whole living roster is measured, not the
// thin trace-ring subset). Folds the in-progress kind's lazy (now − enteredAt) so the current camp
// counts. Returns zeros when the agent has not yet committed two goals. Guarded.
export function goalDwellOf(a: Agent, now: number): { topFrac: number; span: number; top: string | null } {
  try {
    const s = peek(a);
    if (!s || !s.dwell || s.dwellKind === undefined) return { topFrac: 0, span: 0, top: null };
    const byKind: Record<string, number> = {};
    let span = 0;
    for (const k in s.dwell) { byKind[k] = s.dwell[k]; span += s.dwell[k]; }
    const live = Math.max(0, now - (s.dwellT || now));                                // the in-progress kind's uncharged dwell
    byKind[s.dwellKind] = (byKind[s.dwellKind] || 0) + live;
    span += live;
    if (span <= 0) return { topFrac: 0, span: 0, top: null };
    let top: string | null = null, topT = 0;
    for (const k in byKind) if (byKind[k] > topT) { topT = byKind[k]; top = k; }
    return { topFrac: topT / span, span, top };
  } catch { return { topFrac: 0, span: 0, top: null }; }
}

// The FULL per-goalKind dwell vector (seconds), in-progress kind's live time folded in — the raw
// material a behavioural-diversity / personality-correlation probe needs (does a bold soul actually
// spend its life fighting?). Same lazy read as goalDwellOf; never throws. `{}` if nothing dwelt yet.
export function goalDwellVector(a: Agent, now: number): Record<string, number> {
  try {
    const s = peek(a);
    if (!s || !s.dwell || s.dwellKind === undefined) return {};
    const byKind: Record<string, number> = {};
    for (const k in s.dwell) byKind[k] = s.dwell[k];
    const live = Math.max(0, now - (s.dwellT || now));
    byKind[s.dwellKind] = (byKind[s.dwellKind] || 0) + live;
    return byKind;
  } catch { return {}; }
}

// ============================================================================
// MORE CATALOG SIGNALS (docs/architecture/13 Families C/D/E — the §8 priority cut)
// Each names its probe and folds on an EXISTING event seam — never a per-tick scan.
// ============================================================================

// ── Family E: deedLedger(a) — counts + first/last timestamps by tag (thefts/kills/rescues/gifts/
// frees). The TRUTH side of witnessDeed/the combat fold. Feeds esteemTruthGap, epithets, obituaries.
interface DeedTally { n: number; first: number; last: number; }
export function foldDeed(a: Agent, tag: string, now: number): void {
  if (!a || !tag) return;
  try {
    const aa = a as Agent & { _deeds?: Record<string, DeedTally> };
    const d = aa._deeds || (aa._deeds = {});
    const t = d[tag] || (d[tag] = { n: 0, first: now, last: now });
    t.n += 1; t.last = now;
  } catch { /* never throw */ }
}
export function deedCount(a: Agent, tag: string): number {
  const d = (a as Agent & { _deeds?: Record<string, DeedTally> })._deeds;
  return d && d[tag] ? d[tag].n : 0;
}
export function deedLedger(a: Agent): Record<string, DeedTally> {
  return (a as Agent & { _deeds?: Record<string, DeedTally> })._deeds || {};
}

// ── Family E: oaths(a) — narrative-weight goals (avenge/repay/court/rescue) recorded WITH their pop
// REASON (rule 4): kept (satisfied) vs abandoned (expired/unreachable). "a man of his word" measured.
interface OathTally { sworn: number; kept: number; abandoned: number; }
export function foldOathSworn(a: Agent, kind: string): void {
  if (!a || !kind) return;
  try { const o = oaths(a); (o[kind] || (o[kind] = { sworn: 0, kept: 0, abandoned: 0 })).sworn += 1; } catch { /* */ }
}
export function foldOathPop(a: Agent, kind: string, reason: 'kept' | 'abandoned'): void {
  if (!a || !kind) return;
  try { const t = oaths(a)[kind] || (oaths(a)[kind] = { sworn: 0, kept: 0, abandoned: 0 }); t[reason] += 1; } catch { /* */ }
}
export function oaths(a: Agent): Record<string, OathTally> {
  const aa = a as Agent & { _oaths?: Record<string, OathTally> };
  return aa._oaths || (aa._oaths = {});
}

// ── Family D: town climate. peaceClock — sim-time since the last townsfolk death by violence; the
// chronicle's connective tissue ("the first killing since midwinter"). Folded on the combat death fold.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
export function notePeaceBreak(sim: Sim, now: number): void {
  try { (sim as Sim & { _lastViolentDeath?: number })._lastViolentDeath = now; } catch { /* */ }
}
export function peaceClock(sim: Sim, now: number): number {
  const t = (sim as Sim & { _lastViolentDeath?: number })._lastViolentDeath;
  return t == null ? now : Math.max(0, now - t);
}

// ── Family D: scarcity[good] — a good's clearing price deviation from its long-run EWMA mean. Folded
// on marketClear. >1 = dear (famine), <1 = cheap (glut). Feeds famine/glut arcs + narratable booms.
interface ScarcityState { mean: number; t: number; }
export function foldScarcity(sim: Sim, good: string, price: number, now: number): void {
  if (!good || !(price > 0)) return;
  try {
    const m = (sim as Sim & { _scarcity?: Record<string, ScarcityState> });
    const store = m._scarcity || (m._scarcity = {});
    const s = store[good];
    if (!s) { store[good] = { mean: price, t: now }; return; }
    const dt = Math.max(0, now - s.t);
    s.mean = price + (s.mean - price) * Math.pow(0.5, dt / (SIGNALS.scarcityHalf || 1200));
    s.t = now;
  } catch { /* never throw */ }
}
export function scarcity(sim: Sim, good: string): number {
  const s = (sim as Sim & { _scarcity?: Record<string, ScarcityState> })._scarcity;
  return s && s[good] && s[good].mean > 0 ? 1 : 1;   // placeholder ratio; the live ratio is read with a price (below)
}
export function scarcityMean(sim: Sim, good: string): number {
  const s = (sim as Sim & { _scarcity?: Record<string, ScarcityState> })._scarcity;
  return s && s[good] ? s[good].mean : 0;
}

// ── Family B: grievance(a,b) — a SPARSE, LRU'd signed blow ledger between a pair (rounds, last-blow-
// by, mean inter-blow interval). Folded on the combat/vendetta blow fold. Escalation slope (intervals
// shrinking = feud accelerating → Gazette urgency) + ONE-SIDEDNESS (all blows one direction =
// persecution, not feud). Never a full N² matrix (rule 5): only pairs that actually traded blows.
interface Grievance { rounds: number; byA: number; byB: number; lastT: number; meanGap: number; aId: string; bId: string; touched: number; }
function grievanceStore(sim: Sim): Map<string, Grievance> {
  const m = sim as Sim & { _grievance?: Map<string, Grievance> };
  return m._grievance || (m._grievance = new Map());
}
export function foldGrievance(sim: Sim, fromId: unknown, toId: unknown, now: number): void {
  if (fromId == null || toId == null) return;
  try {
    const a = String(fromId), b = String(toId);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = lo + ':' + hi;
    const store = grievanceStore(sim);
    let g = store.get(key);
    if (!g) { g = { rounds: 0, byA: 0, byB: 0, lastT: now, meanGap: 0, aId: lo, bId: hi, touched: now }; store.set(key, g); }
    const gap = now - g.lastT;
    if (g.rounds > 0) g.meanGap = g.meanGap === 0 ? gap : g.meanGap * 0.6 + gap * 0.4;   // EWMA of inter-blow gap
    g.rounds += 1; g.lastT = now; g.touched = now;
    if (a === lo) g.byA += 1; else g.byB += 1;
    while (store.size > (SIGNALS.grievanceMax || 64)) {                                    // LRU evict the stalest
      let oldestKey: string | null = null, oldestT = Infinity;
      for (const [k, v] of store) if (v.touched < oldestT) { oldestT = v.touched; oldestKey = k; }
      if (oldestKey) store.delete(oldestKey); else break;
    }
  } catch { /* never throw */ }
}
// the feud's character: accelerating? (recent gaps shrinking) and one-sided? (all blows one way).
export function grievanceOf(sim: Sim, aId: unknown, bId: unknown): Grievance | null {
  try {
    const a = String(aId), b = String(bId);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return grievanceStore(sim).get(lo + ':' + hi) || null;
  } catch { return null; }
}
export function isOneSided(g: Grievance | null): boolean {
  return !!g && g.rounds >= (SIGNALS.grievanceMinRounds || 3) && (g.byA === 0 || g.byB === 0);
}

// ── Family C: dramatic irony, quantified ([T] by construction — the OMNISCIENT layer's privilege:
// it reads a belief AND the truth it's about, and the GAP is the irony. No agent can compute these;
// no cognition path may read them. Observer-layer helpers (read truth freely), guarded.

// esteemTruthGap(a) — the town's mean opinion/believed-wealth of `a` vs a's TRUE deed ledger + gold.
// Positive standingGap = the CELEBRATED VILLAIN (esteemed despite dark deeds); negative = the UNSUNG
// HERO (rescues/gifts unrewarded). wealthGap = believed-rich-but-broke (a flashy spender), or vice-versa.
export function esteemTruthGap(sim: Sim, a: Agent): { standingGap: number; wealthGap: number; darkDeeds: number; goodDeeds: number } {
  let sStanding = 0, sWealth = 0, n = 0;
  try {
    for (const o of (sim.agents as Agent[])) {
      if (!o || o === a || !o.alive || o.controlled || !o.beliefs) continue;
      const b = o.beliefs.get(a.id);
      if (!b) continue;
      sStanding += (b.standing || 0); sWealth += (b.believedWealth || 0); n++;
    }
  } catch { /* */ }
  const meanStanding = n ? sStanding / n : 0;
  const meanBelievedWealth = n ? sWealth / n : 0;
  const darkDeeds = deedCount(a, 'theft') + deedCount(a, 'kill');
  const goodDeeds = deedCount(a, 'rescue') + deedCount(a, 'gift');
  const trueWealth = Math.max(0, Math.min(1, (a.gold || 0) / 200));         // a rough 0..1 truth scale
  // standingGap: esteem MINUS what the deeds deserve (good - dark, scaled). wealthGap: believed - true.
  const deserved = Math.max(-1, Math.min(1, (goodDeeds - darkDeeds) * 0.2));
  return { standingGap: meanStanding - deserved, wealthGap: meanBelievedWealth - trueWealth, darkDeeds, goodDeeds };
}

// doomedVenture(a) — a's active avenge/assault goal points at a target that is ALREADY truth-dead/gone:
// "marching on a ghost." The narrator can foreshadow the wasted raid the moment it departs. Computed
// once over the agent's active goals (bounded). Reads truth (the target's liveness) — observer-only.
export function doomedVenture(sim: Sim, a: Agent): boolean {
  try {
    const goals = (a as Agent & { goals?: Array<{ kind?: string; subjectId?: unknown }> }).goals;
    if (!Array.isArray(goals)) return false;
    for (const g of goals) {
      if (!g || (g.kind !== 'avenge' && g.kind !== 'assault' && g.kind !== 'fight')) continue;
      if (g.subjectId == null) continue;
      const t = sim.agentsById.get(g.subjectId);
      if (!t || !t.alive) return true;                                       // hunting the already-dead
    }
  } catch { /* */ }
  return false;
}

// ── Family A: streak[key] — consecutive same-status outcomes per watched strategy ("third failed
// heist in a row"). Folded on PLAN_OUTCOME. + perilsSurvived(a) — count of peril outcomes (a veteran
// of near-misses). Both feed desperation/veteran colour. Folded by features/signalsFold.ts.
interface StreakState { key: string; status: string; run: number; }
export function foldStreak(a: Agent, prim: string, status: string, _now: number): void {
  if (!a || !prim) return;
  try {
    const aa = a as Agent & { _streak?: Record<string, StreakState> };
    const st0 = aa._streak || (aa._streak = {});
    const s = st0[prim] || (st0[prim] = { key: prim, status, run: 0 });
    s.run = s.status === status ? s.run + 1 : 1;
    s.status = status;
  } catch { /* */ }
}
export function streakOf(a: Agent, prim: string): { status: string; run: number } {
  const s = (a as Agent & { _streak?: Record<string, StreakState> })._streak;
  return s && s[prim] ? { status: s[prim].status, run: s[prim].run } : { status: '', run: 0 };
}
export function foldPeril(a: Agent, _now: number): void {
  if (!a) return;
  try { const aa = a as Agent & { _perils?: number }; aa._perils = (aa._perils || 0) + 1; } catch { /* */ }
}
export function perilsSurvived(a: Agent): number { return (a as Agent & { _perils?: number })._perils || 0; }

// ── Family E: firsts(a) — the sim-time of an agent's FIRST deed of a kind (corruption measured from
// firstTheft onward; biography beats). Read off deedLedger's `first` timestamp (one-shot by nature).
export function firstDeedAt(a: Agent, tag: string): number | null {
  const d = (a as Agent & { _deeds?: Record<string, DeedTally> })._deeds;
  return d && d[tag] ? d[tag].first : null;
}

// ── Family B: debt(a→b) — a's net unpaid obligation to b, summed over a's ledger (the moneylender /
// betrayal-setup signal). A pure READ over the agent's own obligation store; no fold needed.
export function debtBetween(a: Agent, toId: unknown): number {
  try {
    const obs = (a as Agent & { _obligations?: Array<{ action?: string; counterparty?: unknown; amount?: number }> })._obligations;
    if (!Array.isArray(obs)) return 0;
    let sum = 0;
    for (const o of obs) { if (o && (o.action === 'pay' || o.action === 'repay') && o.counterparty === toId) sum += (o.amount || 0); }
    return sum;
  } catch { return 0; }
}

// ── Family D: town climate — pure observer-pass aggregates over the roster (the §5 pass already walks
// it). wealthGini (gold concentration 0..1), suspicionClimate (total mass + top-1 share = diffuse fear
// vs a NAMED villain era), cohesion (mean in-town standing). All read truth; observer-only; guarded.
export function wealthGini(sim: Sim): number {
  try {
    const gs: number[] = [];
    for (const o of (sim.agents as Agent[])) { if (o && o.alive && !o.controlled && o.faction === 'townsfolk') gs.push(Math.max(0, o.gold || 0)); }
    const n = gs.length; if (n < 2) return 0;
    gs.sort((x, y) => x - y);
    let cum = 0, area = 0; const total = gs.reduce((s, g) => s + g, 0);
    if (total <= 0) return 0;
    for (let i = 0; i < n; i++) { cum += gs[i]; area += cum - gs[i] / 2; }
    return Math.max(0, Math.min(1, 1 - (2 * area) / (n * total)));
  } catch { return 0; }
}
export function suspicionClimate(sim: Sim): { mass: number; top1Share: number } {
  try {
    const per = new Map<unknown, number>();
    for (const o of (sim.agents as Agent[])) {
      if (!o || !o.alive || o.controlled || !o.beliefs || !o.beliefs.all) continue;
      for (const b of o.beliefs.all()) { if (b && b.suspicion > 0.2) per.set(b.subjectId, (per.get(b.subjectId) || 0) + b.suspicion); }
    }
    let mass = 0, top = 0;
    for (const v of per.values()) { mass += v; if (v > top) top = v; }
    return { mass, top1Share: mass > 0 ? top / mass : 0 };
  } catch { return { mass: 0, top1Share: 0 }; }
}

// ── Family F: arcLoad(a) — open arcs sharing `a` as a principal (protagonist pressure: pile on, or
// spotlight the quiet). A read over the registry's open arcs (bounded). Observer-only.
export function arcLoad(sim: Sim, a: Agent): number {
  try {
    const open = sim.sagas && sim.sagas._open; if (!open) return 0;
    let n = 0;
    for (const arc of open.values()) { if (arc.principals && arc.principals.indexOf(a.id) !== -1) n++; }
    return n;
  } catch { return 0; }
}

// misallocatedSuspicion(a) — the town carries real suspicion of `a` who has done NO true theft: the
// emergent Innocent-Accused (suspicion arising falsely, the better story than an authored one). Reads
// the roster's suspicion (truth) + a's true deed ledger. Observer-only.
export function misallocatedSuspicion(sim: Sim, a: Agent): number {
  try {
    if (deedCount(a, 'theft') > 0) return 0;                                 // genuinely guilty → not misallocated
    let mass = 0;
    for (const o of (sim.agents as Agent[])) {
      if (!o || o === a || !o.alive || o.controlled || !o.beliefs) continue;
      const b = o.beliefs.get(a.id);
      if (b && b.suspicion > 0.3) mass += b.suspicion;
    }
    return mass;
  } catch { return 0; }
}

// ============================================================================
// SECOND SLICE (docs/architecture/13) — the catalog rows that fold on an existing seam beyond the
// priority cut. Each names its probe; each folds on a real event (never a per-tick scan). The
// observer-pass samples (standing EWMAs, displacement, time-in-band, the town aggregates) are
// SAMPLED from runStatusSensor (the already-budgeted §5 walk), not from a new scan.
// ============================================================================

// ── Family A: standingFast/Slow — two EWMAs of the ROSTER MEAN standing toward an agent, mirroring
// sampleGold (a time-anchored exponential average). SAMPLED in the observer pass, which already
// computes the mean. Fall-from-Grace's social half; the Ruinous-Rumor slope. Guarded.
export function sampleStanding(a: Agent, mean: number, now: number): void {
  if (!a) return;
  try {
    const s = st(a);
    if (s.stT === undefined) { s.sFast = mean; s.sSlow = mean; s.stT = 0; s.revN = 0; s.revT = 0; s.lastSign = 0; }
    const dt = Math.max(0, now - (s.stT || 0));
    s.sFast = mean + ((s.sFast ?? mean) - mean) * Math.pow(0.5, dt / (SIGNALS.standHalfFast || 120));
    s.sSlow = mean + ((s.sSlow ?? mean) - mean) * Math.pow(0.5, dt / (SIGNALS.standHalfSlow || 600));
    s.stT = now;
    // ── Family A: fortuneReversals — count + last-t of (gold fast−slow) SIGN FLIPS past a magnitude
    // gate. "The agent whose life keeps turning" (protagonist pressure; rags↔ruin chaining). Derived
    // HERE, in the same observer sample, when the flip is noticed (no separate scan).
    const gap = s.gFast - s.gSlow;
    if (Math.abs(gap) >= (SIGNALS.reversalGate || 15)) {
      const sign = gap > 0 ? 1 : -1;
      if (s.lastSign && sign !== s.lastSign) { s.revN = (s.revN || 0) + 1; s.revT = now; }
      s.lastSign = sign;
    }
  } catch { /* never throw on the tick */ }
}
export function standingTrend(a: Agent): { fast: number; slow: number } {
  const s = peek(a); return s && s.stT !== undefined ? { fast: s.sFast || 0, slow: s.sSlow || 0 } : { fast: 0, slow: 0 };
}
export function fortuneReversals(a: Agent): { count: number; lastAt: number } {
  const s = peek(a); return s ? { count: s.revN || 0, lastAt: s.revT || 0 } : { count: 0, lastAt: 0 };
}

// ── Family A: displacement — an EWMA of distance from the agent's believed home/claimed bed. Exile
// detection (high displacement + low standing); the wanderer; homecoming beats. SAMPLED in the
// observer pass off the agent's OWN homeBelief pos vs current pos (own-state truth, observer-read).
export function sampleDisplacement(a: Agent, now: number): void {
  if (!a) return;
  try {
    const hb = typeof a.homeBelief === 'function' ? a.homeBelief() : null;
    const home = hb && (hb as { lastPos?: { distanceTo(p: unknown): number } }).lastPos;
    if (!home || !a.pos || typeof home.distanceTo !== 'function') return;    // no home anchor yet → nothing to sample
    const d = home.distanceTo(a.pos);
    const s = st(a);
    const dt = Math.max(0, now - (s.dispT || 0));
    s.disp = d + ((s.disp || d) - d) * Math.pow(0.5, dt / (SIGNALS.dispHalf || 300));
    s.dispT = now;
  } catch { /* never throw */ }
}
export function displacement(a: Agent): number { const s = peek(a); return s ? (s.disp || 0) : 0; }

// ── Family A: timeInBand — sim-time SPENT in a poverty / wealth / outlaw band (endurance stories:
// "the long winter"; rags arcs need DURATION, not just crossings). Accumulated in the observer pass
// off the agent's OWN gold band — the band edges checked at the same sample (no separate scan).
export function accrueBand(a: Agent, now: number): void {
  if (!a) return;
  try {
    const s = st(a);
    const dt = s.bandT === undefined ? 0 : Math.max(0, now - s.bandT);
    s.bandT = now;
    if (!s.band) s.band = { poor: 0, rich: 0, outlaw: 0 };
    const g = a.gold || 0;
    if (g <= (SIGNALS.poorBand || 8)) s.band.poor += dt;
    else if (g >= (SIGNALS.richBand || 120)) s.band.rich += dt;
    const noto = (a as Agent & { notoriety?: number }).notoriety || 0;
    if (noto >= (SIGNALS.outlawBand || 0.3)) s.band.outlaw += dt;
  } catch { /* never throw */ }
}
export function timeInBand(a: Agent, band: 'poor' | 'rich' | 'outlaw'): number {
  const s = peek(a); return s && s.band ? (s.band[band] || 0) : 0;
}

// ── Family B: regardGap(a,b) — standing(a→b) − standing(b→a) for an interacting pair. Unrequited
// regard: romance fuel and betrayal fuel are the same number with different signs. A pure read over
// each side's OWN belief store (sparse by construction — only computed for a named pair). Observer-only.
export function regardGap(a: Agent, b: Agent): number {
  try {
    if (!a || !b || !a.beliefs || !b.beliefs) return 0;
    const ab = a.beliefs.get(b.id), ba = b.beliefs.get(a.id);
    return ((ab && ab.standing) || 0) - ((ba && ba.standing) || 0);
  } catch { return 0; }
}

// ── Family B: dependence(a) — the share of a's POSITIVE-standing mass concentrated on ONE other
// agent (top-1 over a's own beliefs). "Everything rides on one person" — grief/devastation setup
// when that one dies (the probe pre-casts the mourner). A pure read over a's OWN beliefs. Observer-only.
export function dependence(a: Agent): { share: number; onId: unknown } {
  try {
    if (!a || !a.beliefs || !a.beliefs.all) return { share: 0, onId: null };
    let total = 0, top = 0; let onId: unknown = null;
    for (const b of a.beliefs.all()) {
      const s = b && b.standing > 0 ? b.standing : 0;
      if (s <= 0) continue;
      total += s;
      if (s > top) { top = s; onId = b.subjectId; }
    }
    return total > 0 ? { share: top / total, onId } : { share: 0, onId: null };
  } catch { return { share: 0, onId: null }; }
}

// ── Family D: creditLoad — the town's active-obligations count + a DEFAULT-RATE EWMA (a credit-crisis
// arc; the moneylender protagonist). A lapsed obligation = a DEFAULT, folded at the settle site
// (settleObligations stores the per-agent default tally; the town count aggregates in the observer pass).
// foldObligationDefault is OWN-STATE (a tally on the agent); creditLoad reads the roster (observer-only).
export function foldObligationDefault(a: Agent, n: number): void {
  if (!a || !(n > 0)) return;
  try { const aa = a as Agent & { _defaults?: number }; aa._defaults = (aa._defaults || 0) + n; } catch { /* never throw */ }
}
export function defaultsOf(a: Agent): number { return (a as Agent & { _defaults?: number })._defaults || 0; }
export function creditLoad(sim: Sim): { actives: number; defaults: number; defaultRate: number } {
  try {
    let actives = 0, defaults = 0;
    for (const o of (sim.agents as Agent[])) {
      if (!o || !o.alive) continue;
      const obs = (o as Agent & { _obligations?: unknown[] })._obligations;
      if (Array.isArray(obs)) actives += obs.length;
      defaults += defaultsOf(o);
    }
    return { actives, defaults, defaultRate: actives + defaults > 0 ? defaults / (actives + defaults) : 0 };
  } catch { return { actives: 0, defaults: 0, defaultRate: 0 }; }
}

// ── Family D: cohesion — the town's mean IN-TOWN standing vs its mean standing toward OUTSIDERS.
// Factionalisation: when the in-group warms while the out-group cools, the civil-strife arc opens
// itself. An observer-pass aggregate over the roster (pure read; truth-side; bounded by the walk).
export function cohesion(sim: Sim): { inTown: number; outsider: number; split: number } {
  try {
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    for (const o of (sim.agents as Agent[])) {
      if (!o || !o.alive || o.controlled || o.faction !== 'townsfolk' || !o.beliefs || !o.beliefs.all) continue;
      for (const b of o.beliefs.all()) {
        if (!b || typeof b.standing !== 'number') continue;
        const subj = sim.agentsById && sim.agentsById.get(b.subjectId);
        if (!subj || subj.faction === undefined) continue;
        if (subj.faction === 'townsfolk') { inSum += b.standing; inN++; }
        else if (subj.faction !== 'monster') { outSum += b.standing; outN++; }
      }
    }
    const inTown = inN ? inSum / inN : 0, outsider = outN ? outSum / outN : 0;
    return { inTown, outsider, split: inTown - outsider };
  } catch { return { inTown: 0, outsider: 0, split: 0 }; }
}

// ── GROUP COHESION (Phase B2) — do groups LIVE as groups? Bucket living townsfolk by group
// (followers by bandLeaderId; a loose anchor by its own id), and per group with ≥2 present
// members score 0..1 = clamp01(1 - meanPairwiseDist/COHESION.refDist) × coActFrac (the share
// whose committed goal.kind matches the group's modal kind). Tight clusters acting alike read
// high; a "group" that is only a relations-view tag reads ~0. Truth-side observer (display +
// the behaviour trace only — never read by cognition); bounded by the roster walk; guarded.
export function groupCohesion(sim: Sim): { mean: number; groups: number } {
  try {
    const buckets = new Map<unknown, Agent[]>();
    for (const o of (sim.agents as Agent[])) {
      if (!o || !o.alive || o.controlled || o.faction !== 'townsfolk') continue;
      const og = o as Agent & { bandLeaderId?: unknown; groupType?: string | null };
      const key = og.bandLeaderId != null ? og.bandLeaderId : (og.groupType ? o.id : null);
      if (key == null) continue;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(o);
    }
    let sum = 0, n = 0;
    const ref = (COHESION && COHESION.refDist) || 18;
    for (const members of buckets.values()) {
      if (members.length < 2) continue;
      let dSum = 0, dN = 0;
      const kinds = new Map<string, number>();
      for (let i = 0; i < members.length; i++) {
        const gk = members[i].goal && members[i].goal!.kind;
        if (gk) kinds.set(gk, (kinds.get(gk) || 0) + 1);
        for (let j = i + 1; j < members.length; j++) { dSum += members[i].pos.distanceTo(members[j].pos); dN++; }
      }
      let modal = 0; for (const c of kinds.values()) if (c > modal) modal = c;
      const spatial = Math.max(0, Math.min(1, 1 - (dN ? dSum / dN : ref) / ref));
      sum += spatial * (modal / members.length); n++;
    }
    return { mean: n ? sum / n : 0, groups: n };
  } catch { return { mean: 0, groups: 0 }; }
}

// ── Family C: presumedDead(a) — k agents believe `a` dead/gone (a stale whereabouts belief: its
// confidence has decayed past a floor) while a LIVES. Return-of-the-presumed-dead; the inheritance
// dispute that shouldn't have started. Reads the roster's beliefs (truth-side, observer-only); bounded.
export function presumedDead(sim: Sim, a: Agent): number {
  try {
    if (!a || !a.alive) return 0;                                            // only the irony of a LIVE agent presumed gone
    let k = 0;
    for (const o of (sim.agents as Agent[])) {
      if (!o || o === a || !o.alive || o.controlled || !o.beliefs) continue;
      const b = o.beliefs.get(a.id);
      if (b && (b.confidence || 0) <= (SIGNALS.presumedDeadConf || 0.05)) k++;   // long unseen → believed gone
    }
    return k;
  } catch { return 0; }
}

// ── Family C: loversCrossed(a,b) — each of a COURTING pair believes something false about the other
// (dead/departed: a stale, decayed whereabouts belief while the partner lives). The Romeo-misinformation
// beat — the narrator knows the tragedy is avoidable. Reads each side's belief vs the other's truth.
export function loversCrossed(a: Agent, b: Agent): boolean {
  try {
    if (!a || !b || !a.beliefs || !b.beliefs) return false;
    const ab = a.beliefs.get(b.id), ba = b.beliefs.get(a.id);
    const aBlind = b.alive && (!ab || (ab.confidence || 0) <= (SIGNALS.presumedDeadConf || 0.05));
    const bBlind = a.alive && (!ba || (ba.confidence || 0) <= (SIGNALS.presumedDeadConf || 0.05));
    return aBlind || bBlind;                                                 // either believes the other gone
  } catch { return false; }
}

// ── Family F: rumourDepth(subject) — the provenance-chain length (max hops) of a spreading rumour
// about a subject across the roster. Distortion index — "by the third telling, the theft was a murder";
// Ruinous-Rumor's mechanism made visible. BeliefState.hops already exists; this exposes the max read.
export function rumourDepth(sim: Sim, subjectId: unknown): number {
  try {
    let maxH = 0;
    for (const o of (sim.agents as Agent[])) {
      if (!o || !o.alive || o.controlled || !o.beliefs) continue;
      const b = o.beliefs.get(subjectId as EntityId);
      if (b && (b.hops || 0) > maxH) maxH = b.hops || 0;
    }
    return maxH;
  } catch { return 0; }
}

// ── Family F: quietIndex(a) — sim-time since `a` last appeared in ANY chronicle beat. The forgotten
// man; fresh-protagonist casting so the spotlight rotates. Folded on the chronicle WRITE (noteBeat
// stamps the subject's last-beat time on the sim); quietIndex reads the elapsed since. Town-level map.
export function noteBeat(sim: Sim, subjectId: unknown, now: number): void {
  if (subjectId == null) return;
  try {
    const m = sim as Sim & { _lastBeat?: Map<unknown, number> };
    const store = m._lastBeat || (m._lastBeat = new Map());
    store.set(subjectId, now);
    while (store.size > (SIGNALS.quietMax || 256)) { const k = store.keys().next().value; store.delete(k); }   // bounded
  } catch { /* never throw */ }
}
export function quietIndex(sim: Sim, a: Agent, now: number): number {
  try {
    const m = (sim as Sim & { _lastBeat?: Map<unknown, number> })._lastBeat;
    const t = m && a ? m.get(a.id) : undefined;
    return t == null ? now : Math.max(0, now - t);                          // never seen in a beat → maximally quiet
  } catch { return 0; }
}

// ── Family F: witnessSet(event) — who SAW each dramatic event (a short-retention ring keyed by deed).
// Casting: the confidant, the lone witness, the unreliable narrator. witnessDeed already iterates the
// witnesses; this retains a brief ring of (deedKey → witnessIds + t), LRU-evicted. Observer-only.
interface WitnessRecord { ids: unknown[]; t: number; }
export function noteWitness(sim: Sim, deedKey: string, witnessId: unknown, now: number): void {
  if (!deedKey || witnessId == null) return;
  try {
    const m = sim as Sim & { _witnessSets?: Map<string, WitnessRecord> };
    const store = m._witnessSets || (m._witnessSets = new Map());
    let rec = store.get(deedKey);
    if (!rec) { rec = { ids: [], t: now }; store.set(deedKey, rec); }
    if (rec.ids.indexOf(witnessId) === -1 && rec.ids.length < (SIGNALS.witnessMax || 12)) rec.ids.push(witnessId);
    rec.t = now;
    while (store.size > (SIGNALS.witnessRing || 32)) { const k = store.keys().next().value; store.delete(k); }   // LRU-ish ring
  } catch { /* never throw */ }
}
export function witnessSet(sim: Sim, deedKey: string): unknown[] {
  try { const m = (sim as Sim & { _witnessSets?: Map<string, WitnessRecord> })._witnessSets; const r = m && m.get(deedKey); return r ? r.ids.slice() : []; }
  catch { return []; }
}

// ── Family B: triangle hints — shared third parties across the principals of OPEN arcs (+ each
// principal's `_courtingId`). Two suitors, two avengers, master-and-two-students — staged-collision
// probes. Computed over sagas._open only (tiny sets), at the observer pass / arc open. Returns the
// third-party ids each shared by >= 2 distinct arcs (the collision candidates). Observer-only.
export function triangleHints(sim: Sim): Array<{ thirdId: unknown; arcs: number }> {
  try {
    const open = sim.sagas && sim.sagas._open; if (!open) return [];
    const seen = new Map<unknown, number>();
    let arcs = 0;
    for (const arc of open.values()) {
      if (++arcs > (SIGNALS.triangleArcCap || 64)) break;                   // bounded — never the whole history
      const ps = arc.principals; if (!Array.isArray(ps)) continue;
      const here = new Set<unknown>(ps);
      for (const id of ps) {                                                // a principal's courting target is a third party
        const ag = sim.agentsById && sim.agentsById.get(id);
        const cid = ag && (ag as Agent & { _courtingId?: unknown })._courtingId;
        if (cid != null) here.add(cid);
      }
      for (const id of here) seen.set(id, (seen.get(id) || 0) + 1);
    }
    const out: Array<{ thirdId: unknown; arcs: number }> = [];
    for (const [id, n] of seen) if (n >= 2) out.push({ thirdId: id, arcs: n });   // shared by >= 2 arcs = a collision hint
    return out;
  } catch { return []; }
}

// NOT BUILT — these wait for a feature that does not exist yet (noted per the build brief):
//   · secretExposure(a, deed) — needs a `Secret` topic kind in the belief/gossip model (unbuilt).
//   · outOfCharacterActs(a)   — needs the conscience-cost / disposition-gate-crossing feature (unbuilt).
