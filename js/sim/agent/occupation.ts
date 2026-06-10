// Agent emergent-occupation chooser — picks the good an agent will produce/gather
// this work stint. Extracted from Agent as free functions over a passed agent
// instance: a distinct job from the utility scorer in decide.js (decide settles
// on WORK; this settles on WHAT to make). Scores each producible good by believed
// price × proximity × ambition affinity, opportunity-gated and hysteretic. Reads
// BELIEFS only; never throws. Behaviour-preserving: verbatim bodies of the old
// Agent methods. No cycles — imports config + pure helpers only.

import { ARENA_RADIUS } from '../../arena.js';
import { rng } from '../rng.js';
import { GOODS, RAW_OUTPUTS, BASE_PRICE, ECON } from '../simconfig.js';
import type { Agent, BehaviorProfile, CognitionCtx } from '../../../types/sim.js';

// One commodity definition (simconfig GOODS entry). Re-typed locally because simconfig.js
// is inferred without an index signature (allowJs); these objects ARE string-keyed at runtime.
interface GoodDef { site: string; raw: boolean; inputs: Record<string, number> | null; color: number; tags: string[] }
const GOODS_T = GOODS as Record<string, GoodDef>;
const BASE_PRICE_T = BASE_PRICE as Record<string, number>;
// behavior_profile is keyed by the Tag union; production tags arrive as plain strings.
const bpW = (bp: BehaviorProfile | undefined, t: string): number =>
  (bp ? (bp as Record<string, number>)[t] : undefined) || 0;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

// Which ambition each good's tags best serve — used to bias the occupation
// chooser so an agent picks work that advances a class useful to its goal:
//   renown -> combat (no good produces combat tags, so renown leans on fight/
//             wander instead — handled in decide), wealth -> trade (any good to
//             sell), mastery -> reinforce current strongest class, wanderlust ->
//             forage/raw, belonging -> social. Concretely we map each good to a
//             coarse drive so chooseOccupation can favour on-ambition work.
const GOOD_DRIVE: Record<string, string> = {
  food: 'wealth', wood: 'wealth', ore: 'wealth',
  herb: 'wanderlust', tool: 'mastery', potion: 'mastery',
};

// Net margin (the effective value of labour) of producing one unit of `good`: the
// agent's BELIEVED sale price MINUS the believed cost of its recipe inputs. Raw
// goods have no inputs, so margin = price. This is what stops the town chasing the
// dearest STICKER price (tool=14) while its inputs (wood+ore) cost nearly as much —
// a high-priced good whose inputs are dear is poor work. Belief-only; pure.
export function tradeMargin(a: Agent, good: string): number {
  const g = GOODS_T[good]; if (!g) return 0;
  const gross = a.priceBeliefs[good] || BASE_PRICE_T[good] || 1;
  let cost = 0;
  if (g.inputs) for (const c in g.inputs) cost += (a.priceBeliefs[c] || BASE_PRICE_T[c] || 1) * g.inputs[c];
  return gross - cost;
}

// COMPARATIVE ADVANTAGE: the share of this agent's accumulated behaviour that sits
// in `good`'s tags (0..1) — i.e. how SKILLED it already is at that trade. An agent
// that has DONE a lot of a craft is better at it, so it both PREFERS it (occupation
// choice, below) and is more PRODUCTIVE at it (produce(), act.js). Because the profile
// decays when idle, skill tracks recent vocation — so staying at a trade compounds
// into a specialist, while defecting erodes the edge. Belief/profile-only; pure.
// the union of every good's craft tags — the PRODUCTION subspace of the behaviour
// profile. Skill is measured within this subspace so the universal TRADE/HAGGLE tags
// (every agent buys/sells) can't swamp the vocation signal.
const PROD_TAGS = ((): Set<string> => { const s = new Set<string>(); for (const g in GOODS_T) for (const t of GOODS_T[g].tags) s.add(t); return s; })();

// MASTERY multiplier — the steep, persistent productivity/competitiveness edge a unit
// has at `good` from how much of it it has ever made (agent.mastery, slow-decaying).
// Steeply increasing (sqrt curve) and capped: a seasoned specialist runs several-fold a
// novice, so it out-produces and undercuts newcomers — making the field nearly closed to
// low-mastery competitors. 1.0 for a novice. Used in produce() AND chooseOccupation. Pure.
export function masteryMul(a: Agent, good: string): number {
  const m = (a.mastery && a.mastery[good]) || 0;
  if (m <= 0) return 1;
  // UNCAPPED: the edge tracks the permanent skill spread without ceiling, so a grandmaster
  // keeps pulling away from the field instead of bunching at a cap everyone reaches. The
  // sqrt keeps the growth sub-linear (diminishing returns) so it climbs steeply early then
  // gently — a 72-unit master runs ~×12 while a 9-unit dabbler is ~×5.
  return 1 + ECON.masteryGain * Math.sqrt(m);
}

export function tradeSkillShare(a: Agent, good: string): number {
  const bp = a.progression && a.progression.behavior_profile;
  if (!GOODS_T[good] || !bp) return 0;
  // share of the agent's PRODUCTION activity that is this good — stable comparative
  // advantage, normalised within the craft subspace only (not the whole profile, which
  // trading dominates). A dedicated woodcutter's production is ~all WOODCUT → ~1 here.
  let mine = 0, tot = 0;
  for (const t of GOODS_T[good].tags) mine += bpW(bp, t);
  for (const t of PROD_TAGS) tot += bpW(bp, t);
  return tot > 0 ? Math.min(1, mine / tot) : 0;
}

// The effective value of this agent's labour right now (0..1) — its WORK MORALE. This is
// the best PERSONAL return across the goods it can produce: per-unit NET margin × the
// agent's OWN productivity (mastery) at that good, normalised by ECON.laborValueRef. The
// productivity factor is the crux: when masters flood a field and crash its price, a NOVICE
// (×1 output) earns terrible value there — its morale collapses, so decide() steers it to
// LEISURE or, via chooseOccupation, to an OPEN niche where its return is better. The MASTER
// (×N output) still clears a good living from the same cheap good, so its morale — and its
// work — hold. So the price collapse demoralises exactly the uncompetitive, not the skilled:
// the labour market self-sorts. Raw goods are always producible, so it never hits literal
// zero. Belief/own-state only; guarded — defaults to "worth working" on any error.
export function laborValue(a: Agent): number {
  try {
    let best = 0;
    for (const good in GOODS_T) {
      const g = GOODS_T[good];
      if (!g.raw && g.inputs && !Object.keys(g.inputs).every((c) => (a.inventory[c] || 0) >= g.inputs![c])) continue;
      const m = tradeMargin(a, good) * masteryMul(a, good);   // PERSONAL return = margin × my output
      if (m > best) best = m;
    }
    return clamp01(best / (ECON.laborValueRef || 5));
  } catch { return 1; }
}

// Pick the good this agent will produce/gather this work stint. Scores each
// producible good by NET MARGIN (reward) × proximity to its site × an ambition
// affinity × a self-saturation damp, gated by OPPORTUNITY: raw goods (food/wood/
// ore/herb) anyone can gather; crafted goods (tool/potion) only if the agent holds
// the inputs. Hysteresis keeps it from thrashing. Reads BELIEFS only; never throws.
export function chooseOccupation(a: Agent, ctx: CognitionCtx): void {
  try {
    if (!a.canWork) return;
    const amb = a.ambition ? a.ambition.kind : null;
    // mastery reinforces the agent's current strongest class's good (if any),
    // so a forming identity self-reinforces.
    const masterGood = (amb === 'mastery') ? strongestClassGood(a) : null;
    let best: string | null = null, bestScore = -Infinity;
    for (const good in GOODS_T) {
      const g = GOODS_T[good];
      // RECIPE GATE: a crafted good I don't KNOW the recipe for is unproducible — skip it
      // (own-state read; always-live; guarded so a recipe-less/professionless agent never
      // throws). Raw goods (no inputs) are never gated. Inert while every producer is seeded
      // with every recipe; bites only when a newcomer is left un-taught.
      if (g.inputs && !(a.recipes && a.recipes.has(good))) continue;
      // opportunity gate: crafted goods need their inputs in hand
      if (!g.raw && g.inputs && !Object.keys(g.inputs).every((c) => (a.inventory[c] || 0) >= g.inputs![c]))
        continue;
      // reward: NET margin of the good (sale price minus believed input costs) —
      // the effective value of the labour, floored to a tiny positive so a break-even
      // good is still a last resort and the score never goes <= 0.
      const margin = Math.max(ECON.marginFloor, tradeMargin(a, good));
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
      // saturation: damp a good this agent is already DROWNING in — its own unsold
      // surplus (held beyond what it keeps) it can't move. A personal, belief-clean
      // glut signal, so a smith with a pile of unsellable tools diversifies instead
      // of forging more of what nobody buys (the herd-into-tools breaker).
      const glut = Math.max(0, (a.inventory[good] || 0) - ((ECON.keep as Record<string, number>)[good] || 0));
      const sat = 1 / (1 + ECON.saturationWeight * glut);
      // MASTERY LOYALTY: a GENTLE fraction of the (steep) productivity edge feeds the choice
      // — enough to keep a master loyal to its craft (its mastered field is more lucrative
      // for it), but not so much that the whole town herds into the highest-value good. The
      // dominating edge lives in throughput (produce()); here it's just a loyalty nudge.
      // Mastery starts at 0, so the FIRST choice is still margin/proximity-driven.
      const loyalty = 1 + ECON.masteryChoiceWeight * (masteryMul(a, good) - 1);
      let score = margin * Math.max(0.15, prox) * sat * loyalty;
      // ambition affinity: favour work that serves the agent's long-term goal
      if (amb && GOOD_DRIVE[good] === amb) score *= ECON.ambitionTradeBoost;
      if (masterGood && good === masterGood) score *= ECON.ambitionTradeBoost;
      // hysteresis: stick with what I'm already making unless clearly beaten
      if (good === a._trade) score *= ECON.chooseStickiness;
      if (score > bestScore) { bestScore = score; best = good; }
    }
    if (best) a._trade = best;
    else if (!a._trade) a._trade = RAW_OUTPUTS[(rng() * RAW_OUTPUTS.length) | 0];
  } catch { if (!a._trade) a._trade = 'food'; }
}

// The good whose tags the agent's strongest class is built from (for the
// mastery ambition's "reinforce my identity" bias). Null if it has no class
// tied to a producible good. Read-only.
export function strongestClassGood(a: Agent): string | null {
  const prog = a.progression;
  if (!prog || !prog.behavior_profile) return null;
  const bp = prog.behavior_profile;
  let bestGood: string | null = null, bestW = 0;
  for (const good in GOODS_T) {
    let w = 0;
    for (const t of GOODS_T[good].tags) w += bpW(bp, t);
    if (w > bestW) { bestW = w; bestGood = good; }
  }
  return bestW > 0 ? bestGood : null;
}
