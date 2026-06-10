// THE STATUS-DELTA / FAILURE SENSOR (docs/architecture/12 §5). A guarded OMNISCIENT observer-layer
// probe — a sibling of the chronicle/Director pass, NOT agent cognition — that fires on a DOWNWARD
// crossing so fall-from-grace / burned-veteran / the tragic shun become visible. It reads ground
// truth freely (the true roster mean standing), but respects the BEHAVIOUR boundary the doc reviews
// hardened:
//   · RUIN reads the TREND EWMAs (not a running max) AND requires an INVOLUNTARY loss cause — a
//     voluntary spend-down is not ruin (review 3). Its `ruined` memory reads OWN GOLD (whitelist-legal).
//   · The SHUNNED *beat* fires off the true roster mean (narrator's privilege), but the `slandered`
//     *memory* — a cognition input the victim acts on — is gated on `snubsFelt` (perceivable evidence
//     the victim itself accumulated), never the foreign mean (review 1 / the whitelist).
//   · RETIRE reads the agent's OWN experience store (own-state).
// Every crossing flag clears past a recover band (hysteresis) so fall–recover–fall can fire again.
// Guarded throughout; never throws on the tick.

import { STATUS, RAGS, OUTLAW } from './simconfig.js';
import { BEAT } from './chronicle.js';
import { sampleGold, goldTrend, lossReasonShare, snubsFelt,
  sampleStanding, sampleDisplacement, accrueBand } from './signals.js';
import { feltSurcharge } from './experience.js';
import type { Agent } from '../../types/sim.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;

// the TRUE mean opinion of `a` across the roster (every OTHER agent's belief standing toward a).
// A plain roster scan — legitimate here because the probe is the narrator, not an NPC. Returns 0
// when no one holds an opinion yet (so a just-spawned agent isn't "shunned").
function rosterMeanStanding(sim: Sim, a: Agent): number {
  let sum = 0, n = 0;
  try {
    for (const o of sim.agents) {
      if (!o || o === a || !o.alive || o.controlled || !o.beliefs) continue;
      const b = o.beliefs.get(a.id);
      if (b && typeof b.standing === 'number') { sum += b.standing; n++; }
    }
  } catch { /* never throw */ }
  return n ? sum / n : 0;
}

// the per-agent probe. `now` is sim-time. Reads truth + the signal store; writes beats (narrator) and
// own-state/perceivable-evidence memories (whitelist). Guarded.
export function statusSensor(a: Agent, sim: Sim, now: number): void {
  if (!a || !a.alive || a.controlled || a.faction === 'monster') return;
  // monsters/props carry no status arc; a controlled player narrates differently.
  try {
    sampleGold(a, now);
    const { fast, slow } = goldTrend(a);
    const aa = a as Agent & { _ruined?: boolean; _slandered?: boolean; _retired?: boolean; _shunnedBeat?: boolean; _outlawDone?: boolean };

    // ── RUIN: a FAST fall below the relaxed baseline AND an INVOLUNTARY cause ──────────────────
    const fellHard = slow >= (STATUS.minGoldHigh || 20) && fast <= slow * STATUS.ruinFrac;
    const involuntary = lossReasonShare(a, ['robbed', 'fined'], STATUS.lossWindow, now) >= STATUS.involuntaryFrac;
    if (fellHard && involuntary && !aa._ruined) {
      aa._ruined = true;
      record(a, { t: now, kind: 'ruined', valence: -1, salience: 0.7 });      // OWN GOLD → own-state (whitelist)
      note(sim, BEAT.RUIN, a.id, `${a.name} has fallen on hard times.`);
      try { if (sim.sagas) sim.sagas.closeArc('rags:' + a.id, 'ruined'); } catch { /* never throw */ }
    } else if (aa._ruined && fast >= slow * STATUS.recoverFracGold) {
      aa._ruined = false;                                                     // recovered past the band → can fire again
    }

    // ── RAGS-TO-RICHES: open on a real climb; close 'celebrated' on DEFERENCE MASS (§6, review b) ──
    try {
      if (sim.sagas) {
        const rk = 'rags:' + a.id;
        if (slow >= RAGS.openGold && !sim.sagas.findArc(rk) && !aa._ruined) {
          sim.sagas.openArc({ kind: 'ragsToRiches', key: rk, principals: [a.id], text: `${a.name} is climbing out of poverty.` });
        }
        if (sim.sagas.findArc(rk)) {
          // DEFERENCE MASS, not net mean (the envy mirror can hold net standing down): count perceivers
          // whose standing toward a is genuinely warm. A roster scan — legitimate in the observer pass.
          let warmed = 0;
          for (const o of sim.agents) {
            if (!o || o === a || !o.alive || o.controlled || !o.beliefs) continue;
            const b = o.beliefs.get(a.id);
            if (b && (b.standing || 0) >= RAGS.deferBar) warmed++;
          }
          if (warmed >= RAGS.celebrateMass) sim.sagas.closeArc(rk, 'celebrated', `${a.name} is esteemed across the town for their fortune.`);
        }
      }
    } catch { /* never throw */ }

    // ── SHUNNED: the BEAT fires off the true mean (narrator); the MEMORY needs perceivable evidence ──
    const mean = rosterMeanStanding(sim, a);
    // §13 second slice — SAMPLE the observer-pass trajectory signals here, off the mean this pass
    // already computed (no new scan): the standing EWMAs + fortuneReversals, the home-displacement
    // EWMA, and the gold/notoriety band accumulators. All own-state-or-mean writes; guarded inside.
    sampleStanding(a, mean, now);
    sampleDisplacement(a, now);
    accrueBand(a, now);
    if (mean <= STATUS.shunStanding && !aa._shunnedBeat) {
      aa._shunnedBeat = true;
      note(sim, BEAT.SHUNNED, a.id, `${a.name} finds the town has turned cold.`);
    } else if (aa._shunnedBeat && mean >= STATUS.shunStanding * STATUS.recoverFracThresh) {
      aa._shunnedBeat = false;
    }
    // the `slandered` MEMORY is gated on snubsFelt — OWN-STATE perceivable evidence, NOT the mean.
    const snubs = snubsFelt(a, now);
    if (snubs >= STATUS.snubThreshold && !aa._slandered) {
      aa._slandered = true;
      record(a, { t: now, kind: 'slandered', valence: -1, salience: 0.7 });
    } else if (aa._slandered && snubs <= STATUS.snubThreshold * STATUS.recoverFracThresh) {
      aa._slandered = false;
    }

    // ── OUTLAW: NPC infamy arc (docs/architecture/12 §3.5 / §9). Open as notoriety crosses dreadAt
    // (a rising bandit the town has come to read), close 'celebrated' at legendAt (an outlaw legend).
    // The Watch catching them would close 'brought_down' (a death fold), a richer follow-up.
    try {
      if (sim.sagas && a.faction !== 'townsfolk') {
        const noto = (a as Agent & { notoriety?: number }).notoriety || 0;
        const ok = 'outlaw:' + a.id;
        if (noto >= OUTLAW.dreadAt && !sim.sagas.findArc(ok) && !aa._outlawDone) {
          sim.sagas.openArc({ kind: 'outlaw', key: ok, principals: [a.id], text: `${a.name} is becoming a name to dread.` });
        }
        if (noto >= OUTLAW.legendAt && sim.sagas.findArc(ok)) {
          sim.sagas.closeArc(ok, 'celebrated', `${a.name} has become an outlaw legend.`);
          aa._outlawDone = true;
        }
      }
    } catch { /* never throw */ }

    // ── RETIRE/RELAPSE: the agent's OWN experience store (own-state) ──────────────────────────
    const burn = feltSurcharge(a, 'burgle', null, now);
    if (burn >= STATUS.retireSurcharge && !aa._retired) {
      aa._retired = true;
      record(a, { t: now, kind: 'thwarted', valence: -1, salience: 0.6 });
      note(sim, BEAT.RETIRE, a.id, `${a.name} has given up the thieving life.`);
      try { if (sim.sagas) sim.sagas.openArc({ kind: 'burnedVeteran', key: 'burned:' + a.id, principals: [a.id] }); } catch { /* never throw */ }
    } else if (aa._retired && burn <= STATUS.retireSurcharge * STATUS.recoverFracThresh) {
      aa._retired = false;                                                    // surcharge decayed → may relapse, then re-retire
    }
  } catch { /* never throw on the tick */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function record(a: Agent, ep: any): void {
  try { if (a.memory && typeof a.memory.record === 'function') a.memory.record(ep); } catch { /* never throw */ }
}
function note(sim: Sim, kind: string, subj: unknown, text: string): void {
  try { if (sim.chronicle && sim.chronicle.note) sim.chronicle.note(kind, subj, text); } catch { /* never throw */ }
}

// THE WORLD PASS — self-throttled (STATUS.passSecs), walks the roster once. Called from the
// Simulation's world passes beside the chronicle/Director tick. Guarded; never throws.
export function runStatusSensor(sim: Sim): void {
  try {
    const now = sim.time || 0;
    const s = sim as Sim & { _statusSensorLast?: number };
    if (now - (s._statusSensorLast ?? -Infinity) < (STATUS.passSecs || 0)) return;
    s._statusSensorLast = now;
    for (const a of sim.agents) statusSensor(a, sim, now);
  } catch { /* never throw on the tick */ }
}
