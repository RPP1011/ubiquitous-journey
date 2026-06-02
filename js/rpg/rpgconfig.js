// Tuning constants for the class / level / XP engine. Pulled out so the curves
// can be balanced without touching logic. All times are in SIM seconds.

export const RPG = {
  // --- class matching -------------------------------------------------------
  maxClasses: 5,             // hard cap on simultaneous classes (spec)
  matchIntervalSec: 8,       // how often Progression re-tests the profile
  behaviorSumGate: 10,       // behavior-sum must exceed this before any grant
  sigmoidGrantGate: 0.30,    // sigmoid(weighted dot) must reach this to grant
  consolidateLevel: 80,      // total level at/after which we stop granting new
                             //   classes and consolidate onto the highest
  totalLevelCap: 100,        // hard total-level ceiling

  // --- behavior profile accumulation ---------------------------------------
  profileDecayPerSec: 1 / 600, // slow forgetting of stale behavior (per sec)
  profileMax: 60,            // clamp on any single tag's accumulated weight

  // --- XP / leveling --------------------------------------------------------
  xpScoreScalar: 0.5,        // xp_gain = classMatchScore * this * significance
  xpNeedBase: 50,            // 50 * exp(0.1*level) * (1 + (total/100)^2)
  xpNeedExp: 0.1,
  routeTopK: 2,              // route an event's XP to its best-matching K classes

  // --- significance multiplier (the optional novelty/risk/grind term) -------
  significanceOn: true,      // master switch; OFF -> flat 1.0 multiplier
  sigBase: 1.0,
  sigNovelComboMult: 2.5,    // first time this tag-combo is seen for the agent
  sigKillMult: 1.8,          // an event tagged KILL
  sigRiskMult: 1.5,          // an event tagged RISK (scaled by magnitude)
  sigGrindHalfLifeSec: 30,   // identical deeds within this window decay toward..
  sigGrindFloor: 0.25,       // ..this floor (repetition is worth less)
  sigCap: 4.0,               // clamp the combined multiplier

  // --- ability tier milestones ----------------------------------------------
  // a class grants its catalog ability when it crosses one of these levels;
  // Progression looks these up in CLASS_MILESTONES (per-class override) and
  // falls back to "grant whatever the catalog lists at this level".
  tierLevels: [1, 5, 10, 20],
};

// Sigmoid used by the class matcher + significance shaping. Stable for large |x|.
export function sigmoid(x) {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}
