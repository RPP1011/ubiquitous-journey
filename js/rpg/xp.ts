// Pure XP / level math. No state — Progression owns the per-agent ledgers and
// calls these. Three pieces:
//   xpForLevel(level, totalLevel) — the canonical cost curve (scales with both
//     the class's own level AND the agent's total level, so polymaths grind).
//   significance(ev, prog, now)   — the optional novelty/risk/grind multiplier
//     applied to every XP gain (default ON; tunable in rpgconfig).
//   classMatchScore               — re-exported from classes.js (the sigmoid
//     weighted-dot) so callers have one XP entrypoint.

import { RPG } from './rpgconfig.js';
import { classMatchScore } from './classes.js';
import { comboKey } from './tags.js';
import type { ActionEvent } from '../../types/sim.js';

export { classMatchScore };

// The slice of Progression that significance() reads: two per-agent ledgers the
// caller maintains (key → seen / key → lastTime). Kept local so this stays a pure
// function over just the maps it touches (the fields aren't on the shared type).
interface SigProgress {
  _comboSeen: Set<number>;       // novelty set (Progression._comboSeen); we only .has() it
  _deedLast: Map<string, number>;
}

// What significance() reports back so the caller can update its ledgers (no hidden writes).
interface SigResult {
  mult: number;
  comboKey: number | null;
  deedKey: string | null;
  novel: boolean;
}

// xp_needed(level, totalLevel) = xpNeedBase * exp(xpNeedExp*level) * (1 + (totalLevel/100)^2)
// Cost to go FROM `level` to level+1. totalLevel is the agent's summed levels
// across all classes — so the more classes/levels you hold, the costlier each.
// The curve is deliberately gentle (base/exp flattened in Phase 1) so a storied
// agent's grind-immune NARRATIVE beats convert to real levels (15-30) while a
// quiet labourer's tiny, grind-decayed routine income still plateaus low.
export function xpForLevel(level: number, totalLevel = 0): number {
  const t = totalLevel / 100;
  return RPG.xpNeedBase * Math.exp(RPG.xpNeedExp * level) * (1 + t * t);
}

// The significance / novelty / risk / grind-decay multiplier on an XP gain.
//   - novel tag-combo for this agent: big boost (you did something new).
//   - KILL / RISK tags: combat danger pays more (RISK scales with magnitude).
//   - grind decay: repeating the SAME deed (verb+combo) within a half-life
//     window decays its worth toward a floor (recency half-life).
// `prog` must expose two Maps the caller maintains: _comboSeen (key->true) and
// _deedLast (key->lastTime). We READ them here and report what to update via
// the returned record so this stays pure-ish (no hidden writes).
export function significance(ev: ActionEvent, prog: SigProgress, now: number): SigResult {
  if (!RPG.significanceOn) {
    return { mult: 1, comboKey: null, deedKey: null, novel: false };
  }
  let mult = RPG.sigBase;

  // novelty: first time this exact tag-combo appears for the agent
  const cKey = ev.tags.length ? comboKey(ev.tags) : 0;
  const novel = ev.tags.length > 0 && !prog._comboSeen.has(cKey);
  if (novel) mult *= RPG.sigNovelComboMult;

  // STAKES ARE DILUTED BY COMPANY (only when the deed carries an allies count — the
  // combat folds attach it; a forge deed never does): a solo feat amplifies, a deed
  // done in a crowd divides. mult /= (1 + allies x dilution); allies=0 => x sigSoloMult.
  if (typeof ev.allies === 'number') {
    mult *= ev.allies <= 0 ? (RPG.sigSoloMult || 1)
      : 1 / (1 + ev.allies * (RPG.sigAllyDilution || 0));
  }

  // risk / kill emphasis
  if (ev.tags.includes('KILL')) mult *= RPG.sigKillMult;
  if (ev.tags.includes('RISK')) {
    // scale the risk bonus by how big the deed was (magnitude ~ danger)
    const m = Math.max(0, Math.min(1, ev.magnitude));
    mult *= 1 + (RPG.sigRiskMult - 1) * m;
  }

  // grind decay: same verb+combo seen recently -> worth less, recency half-life
  const dKey = ev.verb + ':' + cKey;
  const last = prog._deedLast.get(dKey);
  if (last != null) {
    const dt = Math.max(0, now - last);
    // half-life decay: factor = 0.5 ^ (dt / halfLife); fresh repeat -> ~floor,
    // long-ago repeat -> ~1. Blend toward the grind floor.
    const decayed = Math.pow(0.5, RPG.sigGrindHalfLifeSec > 0 ? (RPG.sigGrindHalfLifeSec - dt) / RPG.sigGrindHalfLifeSec : 0);
    // when dt is small, (halfLife-dt)/halfLife ~ 1 -> 0.5^1 = 0.5 strong damp;
    // clamp into [floor, 1].
    const grind = Math.max(RPG.sigGrindFloor, Math.min(1, 1 - decayed * (1 - RPG.sigGrindFloor)));
    mult *= grind;
  }

  mult = Math.max(0, Math.min(RPG.sigCap, mult));
  return { mult, comboKey: cKey, deedKey: dKey, novel };
}

// Convenience: full XP awarded by an event toward a class, before routing.
//   xp = classMatchScore * xpScoreScalar * significanceMult
export function xpFromEvent(score: number, sigMult: number): number {
  return score * RPG.xpScoreScalar * sigMult;
}
