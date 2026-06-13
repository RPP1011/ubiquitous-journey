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
  xpNeedBase: 30,            // 30 * exp(0.08*level) * (1 + (total/100)^2). Flattened
  xpNeedExp: 0.08,           //   from 50/0.1 so a storied agent's handful of
                             //   narrative beats actually CONVERTS to levels
                             //   (15-30), while a quiet labourer's tiny routine
                             //   income still plateaus ~5-8 (headroom + spread).
  routeTopK: 2,              // route an event's XP to its best-matching K classes

  // --- significance multiplier (the optional novelty/risk/grind term) -------
  significanceOn: true,      // master switch; OFF -> flat 1.0 multiplier
  sigBase: 1.0,
  sigNovelComboMult: 2.5,    // first time this tag-combo is seen for the agent
  sigKillMult: 1.8,          // an event tagged KILL
  sigRiskMult: 1.5,          // an event tagged RISK (scaled by magnitude)
  sigGrindHalfLifeSec: 30,   // identical deeds within this window decay toward..
  sigGrindFloor: 0.25,       // ..this floor (repetition is worth less)
  // STAKES ARE DILUTED BY COMPANY (M0 applied to levelling): a combat deed done beside
  // allies is worth less per soul — slaying a horror alone and last-hitting it in a mob
  // of a hundred are vastly different feats. Identity (behavior_profile) is NOT diluted
  // (hunting in a band still makes you a warrior); only the XP significance is. Applied
  // only when the deed carries an `allies` count (combat folds attach it; crafting never).
  sigSoloMult: 1.5,          // a TRUE solo combat deed (allies=0) is amplified
  sigAllyDilution: 0.2,      // mult /= (1 + allies x this): 4 comrades halve it, 100 bury it
  sigCap: 4.0,               // clamp the combined multiplier

  // --- LEVELS BUY REAL POWER (the gap-closer) -------------------------------
  // Levels previously added ZERO combat power (TUNE.damage flat) — a level-24 veteran and
  // a level-1 farmhand swung the same sword, so no amount of solo levelling could close
  // the gap that party size opens. Base swing damage now scales with TOTAL level, capped.
  levelDamagePerLevel: 0.04, // +4% base swing damage per total level…
  levelDamageCap: 2.5,       // …to a 2.5x ceiling (level ~37). Offence-only by design:
                             //   maxHealth is a global constant consumed as fractions in
                             //   ~20 places — defence scales via abilities/shields instead

  // --- GENERATION budget (doc 16 §4: same tier = same power, spent differently) ----
  gen: {
    budgetBase: 30,          // B(t) = budgetBase x budgetGrowth^(t-1)
    budgetGrowth: 1.35,      // steeper than the old 1.18 — tiers should feel earned
    dmgPerPoint: 1.0,        // damage bought per budget point
    healPerPoint: 1.1,       // healing is slightly dearer
    shieldPerPoint: 0.9,     // shielding slightly cheaper
    slowCostPerSec: 6,       // control durations are priced per second…
    stunCostPerSec: 14,      // …stun far dearer than slow
    windowCostPerSec: 4,     // craft/trade windows priced per second
  },
  // EVENT GRANTS (doc 15 PR1): one event-born ability per agent per this many sim-seconds
  // (M8's same-moment grace), whatever the seam.
  eventGrantGraceSec: 600,

  // --- narrative beats (the GRIND-IMMUNE xp channel) ------------------------
  // The "what a character has LIVED" axis. Routine produce/buy/sell stays the
  // low, plateauing income above; the dramatic beats episodic memory already
  // records (a monster slain, a goal-stack closure, a windfall, a witnessed
  // death, a brush with death) pay SIZABLE xp that bypasses the significance
  // grind floor entirely. The award is `narrativeXpScalar * salience` so the
  // memory salience model is the single "how notable" signal — a storied life
  // (kills/quests/vendettas) climbs; a quiet labourer's life does not.
  narrativeXpScalar: 165,    // xp = this * episode-salience (salience in 0..1)
  narrativeGoalBonus: {      // per goal-kind closure multiplier on the scalar
    avenge: 1.6, defeat: 1.4, delve: 1.5, seek_fortune: 1.0,
    repay: 0.8, grieve: 0.7,
  },
  narrativeWindfallMult: 0.55, // windfalls are FREQUENT for a merchant — discount
                               //   them so a fat purse doesn't out-story genuine
                               //   danger (kills/near-death) or goal closure. The
                               //   biggest beats remain the dramatic ones.
  nearDeathHpFrac: 0.3,      // surviving a blow at/below this HP fraction is a beat
  nearDeathSalience: 0.5,    // salience of a near-death survival episode
  nearDeathCooldownSec: 45,  // min sim-s between near-death beats (a long fight is
                             //   ONE brush with death, not a torrent of them)
  narrativeGoalMinAgeSec: 6, // a goal must be PURSUED this long before its closure
                             //   pays xp (an instantly-resatisfied re-derivation =0)

  // --- ability tier milestones ----------------------------------------------
  // a class grants its catalog ability when it crosses one of these levels;
  // Progression looks these up in CLASS_MILESTONES (per-class override) and
  // falls back to "grant whatever the catalog lists at this level".
  tierLevels: [1, 5, 10, 20],
};

// --- NPC ability USE (the cast hooks in js/sim/agent/act.js) -----------------
// Tuning for when an NPC actually spends a cast on something other than an attack.
export const ABILITY = {
  selfCastHpFrac: 0.5,   // in combat, below this health fraction an NPC spends its
                         //   cast cadence on a READY self-targeted heal/shield spec
                         //   (second_wind etc.) instead of an offensive one
  haggleEdge: 0.05,      // haggle's bargaining window (trade_edge op): ask this
                         //   fraction MORE / bid this fraction LESS while it lasts.
                         //   Shifts only the bid/ask midpoint both parties exchange
                         //   (conserved); a harder bargain can also lose the match.
  craftBoostMul: 1.6,    // master_craft (craft_boost op): produce-speed multiplier
                         //   while the window is open
};

// Sigmoid used by the class matcher + significance shaping. Stable for large |x|.
export function sigmoid(x: number): number {
  if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
  const z = Math.exp(x); return z / (1 + z);
}
