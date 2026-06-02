// Pure XP / level math. No state — Progression owns the per-agent ledgers and
// calls these. Three pieces:
//   xpForLevel(level, totalLevel) — the canonical cost curve (scales with both
//     the class's own level AND the agent's total level, so polymaths grind).
//   significance(ev, prog, now)   — the optional novelty/risk/grind multiplier
//     applied to every XP gain (default ON; tunable in rpgconfig).
//   classMatchScore               — re-exported from classes.js (the sigmoid
//     weighted-dot) so callers have one XP entrypoint.

import { RPG, sigmoid } from './rpgconfig.js';
import { classMatchScore } from './classes.js';
import { comboKey } from './tags.js';

export { classMatchScore };

// xp_needed(level, totalLevel) = 50 * exp(0.1*level) * (1 + (totalLevel/100)^2)
// Cost to go FROM `level` to level+1. totalLevel is the agent's summed levels
// across all classes — so the more classes/levels you hold, the costlier each.
export function xpForLevel(level, totalLevel = 0) {
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
export function significance(ev, prog, now) {
  if (!RPG.significanceOn) {
    return { mult: 1, comboKey: null, deedKey: null, novel: false };
  }
  let mult = RPG.sigBase;

  // novelty: first time this exact tag-combo appears for the agent
  const cKey = ev.tags.length ? comboKey(ev.tags) : 0;
  const novel = ev.tags.length > 0 && !prog._comboSeen.has(cKey);
  if (novel) mult *= RPG.sigNovelComboMult;

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
export function xpFromEvent(score, sigMult) {
  return score * RPG.xpScoreScalar * sigMult;
}
