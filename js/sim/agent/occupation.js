// Agent emergent-occupation chooser — picks the good an agent will produce/gather
// this work stint. Extracted from Agent as free functions over a passed agent
// instance: a distinct job from the utility scorer in decide.js (decide settles
// on WORK; this settles on WHAT to make). Scores each producible good by believed
// price × proximity × ambition affinity, opportunity-gated and hysteretic. Reads
// BELIEFS only; never throws. Behaviour-preserving: verbatim bodies of the old
// Agent methods. No cycles — imports config + pure helpers only.

import { ARENA_RADIUS } from '../../arena.js';
import { GOODS, RAW_OUTPUTS, BASE_PRICE, ECON } from '../simconfig.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// Which ambition each good's tags best serve — used to bias the occupation
// chooser so an agent picks work that advances a class useful to its goal:
//   renown -> combat (no good produces combat tags, so renown leans on fight/
//             wander instead — handled in decide), wealth -> trade (any good to
//             sell), mastery -> reinforce current strongest class, wanderlust ->
//             forage/raw, belonging -> social. Concretely we map each good to a
//             coarse drive so chooseOccupation can favour on-ambition work.
const GOOD_DRIVE = {
  food: 'wealth', wood: 'wealth', ore: 'wealth',
  herb: 'wanderlust', tool: 'mastery', potion: 'mastery',
};

// Pick the good this agent will produce/gather this work stint. Scores each
// producible good by believed price (reward) × proximity to its site × an
// ambition affinity, gated by OPPORTUNITY: raw goods (food/wood/ore/herb)
// anyone can gather; crafted goods (tool/potion) only if the agent holds the
// inputs. Hysteresis keeps it from thrashing. Reads BELIEFS only; never throws.
export function chooseOccupation(a, ctx) {
  try {
    if (!a.canWork) return;
    const amb = a.ambition ? a.ambition.kind : null;
    // mastery reinforces the agent's current strongest class's good (if any),
    // so a forming identity self-reinforces.
    const masterGood = (amb === 'mastery') ? strongestClassGood(a) : null;
    let best = null, bestScore = -Infinity;
    for (const good in GOODS) {
      const g = GOODS[good];
      // opportunity gate: crafted goods need their inputs in hand
      if (!g.raw && g.inputs && !Object.keys(g.inputs).every((c) => (a.inventory[c] || 0) >= g.inputs[c]))
        continue;
      // reward: believed sale price of the good
      const price = (a.priceBeliefs[good] || BASE_PRICE[good] || 1);
      // proximity: nearer sites cost less effort (believed via shared world POIs)
      let prox = 1;
      const site = ctx.world && ctx.world.nearest(g.site, a.pos);
      if (site) {
        const d = Math.hypot(site.pos.x - a.pos.x, site.pos.z - a.pos.z);
        // normalise by the agent's TOWN radius (not the whole arena) so distance
        // bites at town scale — a townsperson favours its own town's sites and
        // won't drift across the wilderness to another town's resources.
        const norm = (a.townRadius || ARENA_RADIUS * 0.6);
        prox = 1 - ECON.proximityWeight * clamp01(d / norm);
      }
      let score = price * Math.max(0.15, prox);
      // ambition affinity: favour work that serves the agent's long-term goal
      if (amb && GOOD_DRIVE[good] === amb) score *= ECON.ambitionTradeBoost;
      if (masterGood && good === masterGood) score *= ECON.ambitionTradeBoost;
      // hysteresis: stick with what I'm already making unless clearly beaten
      if (good === a._trade) score *= ECON.chooseStickiness;
      if (score > bestScore) { bestScore = score; best = good; }
    }
    if (best) a._trade = best;
    else if (!a._trade) a._trade = RAW_OUTPUTS[(Math.random() * RAW_OUTPUTS.length) | 0];
  } catch { if (!a._trade) a._trade = 'food'; }
}

// The good whose tags the agent's strongest class is built from (for the
// mastery ambition's "reinforce my identity" bias). Null if it has no class
// tied to a producible good. Read-only.
export function strongestClassGood(a) {
  const prog = a.progression;
  if (!prog || !prog.behavior_profile) return null;
  const bp = prog.behavior_profile;
  let bestGood = null, bestW = 0;
  for (const good in GOODS) {
    let w = 0;
    for (const t of GOODS[good].tags) w += bp[t] || 0;
    if (w > bestW) { bestW = w; bestGood = good; }
  }
  return bestW > 0 ? bestGood : null;
}
