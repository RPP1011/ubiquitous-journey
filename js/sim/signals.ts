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
