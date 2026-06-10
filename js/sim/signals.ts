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

import { SIGNALS } from './simconfig.js';
import type { Agent } from '../../types/sim.js';

interface LossStep { t: number; reason: string; amt: number; }
export interface SignalState {
  gFast: number; gSlow: number; gT: number;   // gold EWMAs + last-sample time
  loss: LossStep[];                            // bounded ring of tagged downward gold steps
  snubs: number; snubT: number;                // snubsFelt counter + last-update (for lazy decay)
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
