// GOAP backward-chaining planner (docs/goal-system.md §4).
//
// The ONLY authored entities are PRIMITIVES — each a tuple of
// { precondition, effect (predicate template), cost }. A goal is a world-state
// predicate plus the target effect atoms that satisfy it. The planner
// backward-chains: find a primitive whose EFFECT unifies with an open subgoal,
// push that primitive's unmet PRECONDITIONS as fresh subgoals, recurse, and
// keep the min-cost feasible ordered primitive list (or null).
//
// EPISTEMIC SPLIT (hard invariant): every precondition / cost reads only the
// agent's BELIEVED state — believed prices (agent.priceBeliefs), believed
// positions (world POIs + belief.lastPos), profession/inventory it actually
// holds, and believed-hostiles on the route. The planner NEVER reads ground
// truth about other agents' inventories or true positions. A plan may be wrong
// and fail at execution time; replanning (Phase 2) handles that.
//
// FREEZE LESSON: pure data, no throws, depth + frontier bounded. Phase 1 keeps
// this module standalone — it is NOT wired into decide() yet.

import * as THREE from 'three';
import { PROFESSIONS, COMMODITIES, ECON, SIM, URCHIN, QUANTITY } from './simconfig.js';
import { POI_KIND } from './world.js';
import { STAGE, REASON } from './trace.js';
import type { Agent, CognitionCtx, Goal, Plan, PlanStep, EntityId, Atom as AtomT, Stage, Reason } from '../../types/sim.js';

// STAGE/REASON are runtime constants in the (still-JS) trace.js — allowJs widens their
// members to `string`, but Trace.note wants the narrow Stage/Reason literal unions. These
// re-narrow at the boundary (the values ARE valid literals) — one cast, not per-call.
const ST = STAGE as Record<string, Stage>;
const RS = REASON as Record<string, Reason>;

// ── Internal planner shapes (module-local) ──────────────────────────────────
// The planner runs on a SUPERSET of the public Atom/PlanBind vocabulary (it adds
// a {subjectId}-place form, the 'sated' subgoal, and corpseId/item/value fields),
// so these widen the shared shapes rather than reinventing them. A `place` is a
// POI-kind string OR a {subjectId} target descriptor resolved via belief.
type PlannerPlace = string | { subjectId?: EntityId; assoc?: string };
// One subgoal atom the solver chases (the public Atom widened with the extra preds).
interface SubAtom {
  pred: string;
  place?: PlannerPlace;
  good?: string;
  n?: number;
  amt?: number;
  subjectId?: EntityId;
  value?: number;
  kind?: string;
  item?: string;
  corpseId?: EntityId;
  need?: string;        // need_ge: which need the graded threshold is on
  level?: number;       // need_ge: the believed need-level to reach (0..1)
}
// The concrete params a primitive's effectMatches chose (one loose bind per primitive).
interface Bind {
  name?: string;
  place?: PlannerPlace;
  good?: string;
  n?: number;
  site?: string | null;
  inputs?: Record<string, number> | null;
  price?: number;
  item?: string;
  to?: EntityId;
  amt?: number;
  target?: EntityId;
  corpse?: EntityId;
  fromStock?: boolean;
}
// The simulated believed-state the solver threads forward (inventory/gold/at/received).
interface SimState {
  inv: Record<string, number>;
  gold: number;
  at: PlannerPlace | null;
  received: Record<string, boolean>;
  knownAssoc: Record<string, boolean>;   // subjectIds whose `assoc` an earlier shadow/ask step arranged
  need: Record<string, number>;          // believed need-levels the plan raises (graded-needs composition)
}
// One authored primitive (effectMatches/precondition/cost + executor metadata).
interface Primitive {
  name: string;
  effectMatches(sg: SubAtom, bind: Bind | null, agent: Agent): Bind | null;
  precondition(agent: Agent, ctx: CognitionCtx, bind: Bind): SubAtom[];
  cost(agent: Agent, ctx: CognitionCtx, bind: Bind): number;
  exec: { verb: string };
}
// A solved sub-result: an ordered primitive list + its accumulated cost.
interface Solved { steps: PlanStep[]; cost: number; }
// The best-first search state threaded through the whole solve. `n` bounds the frontier;
// the rest are the Phase-1 threshold-composition side-channel: `widen` (a bold agent taps
// riskier sources), `partial`/`shortfall` (set when a numeric target was UNREACHABLE — the
// satisfice plan() reads to cool the goal down). All absent/false when QUANTITY is off.
interface Frontier { n: number; widen?: boolean; partial?: boolean; shortfall?: number; }

// PROFESSIONS (from the still-JS simconfig) keyed by dynamic profession name. One typed
// view so the planner can index it by an arbitrary string without per-access casts.
interface ProfDef { output: string; site: string; inputs?: Record<string, number> | null; }
const PROFS = PROFESSIONS as Record<string, ProfDef>;

// --- bounds (config-able) ---------------------------------------------------
export const PLAN = {
  maxDepth: 5,         // backward-chaining recursion depth cap
  maxFrontier: 64,     // best-first frontier size cap (guards search blowup)
  maxPlan: 8,          // emitted primitive-sequence length cap
  giftN: 1,            // units handed over by a give/gift step
  routeRisk: 6,        // cost added per believed-hostile near the travel route
  riskRange: 12,       // how near a hostile must be to a route endpoint to count
  travelPerMetre: 0.08,// believed-distance -> cost
  actBase: 1,          // flat cost of a non-travel primitive
  // --- goal-stack bounds (Phase 2 wiring) ---
  stackDepth: 4,       // hard cap on agent.goals (LIFO; oldest/lowest dropped)
  reachRange: 2.2,     // distance at which a transfer/attack target is "at" reach
  // --- numeric-threshold composition (docs/architecture/10, Phase 1; gated by QUANTITY) ---
  partialCooldown: 12, // sim-seconds an unreachable threshold goal rests before re-planning
};

// Goods an agent can hand over as a gift of "value" (consumable/tradeable).
const GIFTABLE = ['food', 'potion', 'herb', 'wood', 'ore', 'tool'];

// ---------------------------------------------------------------------------
// Believed-world helpers. All reads here are belief-grounded.
// ---------------------------------------------------------------------------

// The site POI kind a given commodity is GATHERED / PRODUCED at (its profession
// site). Raw goods (food/wood/ore/herb) map to a resource node; tool/potion are
// crafted (need a profession), handled by the produce primitive.
function siteKindForGood(good: string): string | null {
  for (const k in PROFS) {
    if (PROFS[k].output === good) return PROFS[k].site;
  }
  return null;
}
// Is `good` a raw resource an agent can gather at a node without a profession?
const RAW_GOODS = new Set(['food', 'wood', 'ore', 'herb']);

// BRIDGE-BASED "believed dead" — the epistemic-split replacement for every omniscient
// `o.alive` read in the goal/plan layer. The AUTHORITATIVE death signal is the agent's own
// `_slain` set, stamped by the combat BRIDGE (onCombatEvents) on the KILLER and on every
// agent carrying an avenge/duel against the fallen — so a death OUT OF the agent's own
// sight still resolves its vendetta through a sanctioned write, while a quarry merely fled
// out of sight is NOT mistaken for dead (its belief just goes stale, and the destination-
// intent pursuit keeps hunting it until it is re-acquired and slain, or the goal expires).
// Reads only the agent's OWN state. Never the roster, never a foreign liveness flag.
//
// "Believed dead" is TRUE when EITHER:
//   · the `_slain` BRIDGE marked it — the authoritative, sanctioned out-of-sight death
//     signal stamped by onCombatEvents on the killer and on every agent carrying an
//     avenge/duel against the fallen; OR
//   · I hold NO belief about it AT ALL (the store has no entry). A quarry merely fled out of
//     sight still has a belief ENTRY (faded, but present) — that is NOT death, so the
//     destination-intent pursuit keeps hunting it. A belief is only truly ABSENT when it was
//     never formed, or when perception CONTRADICTED the sighting (I looked right at where I
//     thought it was, in plain view, and it was gone) and erased it — which is exactly when
//     a vendetta against a vanished foe should lapse. We test belief ABSENCE, never low
//     confidence, so an out-of-sight quarry is never mistaken for dead.
// Reads only the agent's OWN state (_slain + own BeliefStore). Never the roster.
function believedDead(agent: Agent | null, subjectId: EntityId): boolean {
  if (!agent) return true;
  if (agent._slain && agent._slain.has(subjectId)) return true;
  return !(agent.beliefs && agent.beliefs.get(subjectId));
}

// Believed position of a "place". A place is either a POI kind (string POI_KIND)
// or a target descriptor { subjectId } resolved via the agent's belief.lastPos.
function believedPos(agent: Agent, ctx: CognitionCtx, place: PlannerPlace | null | undefined): import('three').Vector3 | null {
  if (!place) return null;
  if (typeof place === 'object' && place.subjectId != null) {
    const b = agent.beliefs && agent.beliefs.get(place.subjectId);
    if (place.assoc) {
      // a subject↔place ASSOCIATION (the believed stash) — resolve to the assoc pos, NOT the
      // mark's body. Unknown until consolidated (`shadow`) or gossiped → null (unreachable).
      if (b && b.assoc && b.assoc.placeKind === place.assoc) return new THREE.Vector3(b.assoc.pos.x, 0, b.assoc.pos.z);
      return null;
    }
    // BELIEF-ONLY: navigate toward where I BELIEVE the subject is (its last sighting),
    // never its true position. No confident belief -> unknown place (null). The pursuit
    // model (combatStep) handles re-acquisition + the inferred destination separately.
    if (b && b.confidence > 0) return b.lastPos;
    return null;
  }
  // a POI kind string (the {subjectId} form returned above)
  const poi = ctx.world && ctx.world.nearest(place as string, agent.pos);
  return poi ? poi.pos : null;
}

// Believed travel cost from the agent to a place (metres -> cost), plus a route
// risk surcharge for believed-hostiles sitting near the destination.
function travelCost(agent: Agent, ctx: CognitionCtx, place: PlannerPlace | null | undefined): number {
  const tp = believedPos(agent, ctx, place);
  if (!tp) return Infinity;            // unknown / unreachable place
  const d = Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z);
  let cost = d * PLAN.travelPerMetre;
  // risk: believed-hostiles I'm confident about that sit near the destination
  if (agent.beliefs) {
    for (const b of agent.beliefs.all()) {
      if (b.confidence < SIM.actOnBeliefMin) continue;
      const hostile = b.hostile || (agent.considerHostile && agent.considerHostile(b));
      if (!hostile) continue;
      const rd = Math.hypot(b.lastPos.x - tp.x, b.lastPos.z - tp.z);
      if (rd < PLAN.riskRange) cost += PLAN.routeRisk;
    }
  }
  return cost;
}

// Believed price of a good (already per-agent + gossip-shifted).
function believedPrice(agent: Agent, good: string): number | null {
  const p = agent.priceBeliefs ? agent.priceBeliefs[good] : null;
  return (typeof p === 'number' && p > 0) ? p : null;
}

// How many units of `good` the agent can spare as a gift without dipping below
// its personal keep reserve (ECON.keep).
function giveableStock(agent: Agent, good: string): number {
  const have = (agent.inventory && agent.inventory[good]) || 0;
  const keep = ((ECON.keep as Record<string, number> | undefined)?.[good]) || 0;
  return Math.max(0, Math.floor(have - keep));
}

// ---------------------------------------------------------------------------
// Subgoal atoms. A subgoal is a believed-state predicate the planner must
// satisfy. `holds(agent, ctx)` tests it against believed state.
// ---------------------------------------------------------------------------
export const Atom = {
  at: (place: PlannerPlace): SubAtom => ({ pred: 'at', place }),
  have: (good: string, n = 1): SubAtom => ({ pred: 'have', good, n }),
  goldGe: (amt: number): SubAtom => ({ pred: 'gold_ge', amt }),
  received: (subjectId: EntityId, value: number, kind = 'any'): SubAtom => ({ pred: 'received', subjectId, value, kind }),
  dead: (subjectId: EntityId): SubAtom => ({ pred: 'dead', subjectId }),
  inReach: (subjectId: EntityId): SubAtom => ({ pred: 'in_reach', subjectId }),
  // EPISTEMIC ATOM (Phase 4): I hold a believed subject↔place association (where the mark
  // stashes). Satisfied by an `assoc` belief — surveilled (`shadow`) or gossiped. Own-state.
  knowAssoc: (subjectId: EntityId): SubAtom => ({ pred: 'know_assoc', subjectId }),
  // gold_ge flavoured with the MARK to burgle (routes the burgle primitive); plain gold_ge
  // (no subjectId) is the honest seek_fortune target satisfied by sell/loot.
  stealGold: (amt: number, subjectId: EntityId): SubAtom => ({ pred: 'gold_ge', amt, subjectId }),
  // GRADED NEED (Phase 1): a need raised to AT LEAST `level` (0..1) — a threshold, not a
  // flag, so eating twice when one meal is short is an ordinary composed plan.
  needGe: (need: string, level: number): SubAtom => ({ pred: 'need_ge', need, level }),
};

function atomHolds(atom: SubAtom, agent: Agent, ctx: CognitionCtx): boolean {
  switch (atom.pred) {
    case 'at': {
      const tp = believedPos(agent, ctx, atom.place);
      if (!tp) return false;
      return Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z) <= SIM.arriveDist + 0.01;
    }
    case 'have':
      return ((atom.good ? agent.inventory?.[atom.good] : 0) || 0) >= (atom.n || 0);
    case 'gold_ge':
      return (agent.gold || 0) >= (atom.amt || 0);
    case 'received':
      // satisfied only by an explicit transfer this plan performs; never true a priori
      return false;
    case 'dead': {
      // BELIEF/BRIDGE-BASED: the subject is "believed dead" when a combat bridge stamped it
      // on my _slain set (I struck the killing blow, even out of my own sight) OR I hold no
      // confident belief about it any more. No roster/liveness read.
      return believedDead(agent, atom.subjectId as EntityId);
    }
    case 'in_reach': {
      // BELIEF-ONLY reach test: am I at the subject's last-believed position? No live read.
      const b = atom.subjectId != null && agent.beliefs ? agent.beliefs.get(atom.subjectId) : null;
      const tp = (b && b.confidence > 0) ? b.lastPos : null;
      if (!tp) return false;
      return Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z) <= 2.2;
    }
    case 'know_assoc': {
      // EPISTEMIC: do I hold a consolidated association (the mark's believed stash)? Own
      // belief only — surveilled or gossiped. If gossip pre-supplied it, the plan collapses.
      const b = atom.subjectId != null && agent.beliefs ? agent.beliefs.get(atom.subjectId) : null;
      return !!(b && b.assoc);
    }
    case 'need_ge':
      // GRADED NEED (Phase 1): is the need already at/above the threshold level? Own state.
      return ((atom.need ? agent.needs?.[atom.need] : 0) || 0) >= (atom.level || 0);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Primitive registry. Each primitive declares:
//   name
//   effectMatches(subgoal, bind) -> bound-step object | null   (unification)
//   precondition(agent, ctx, bind) -> array of subgoal atoms   (unmet => recurse)
//   cost(agent, ctx, bind) -> number
//   exec: metadata the Phase-2 executor will read (verb + how to fill params)
// A "bind" is the concrete parameters chosen when the effect unified with a
// subgoal (e.g. give binds {item, n, to}).
// ---------------------------------------------------------------------------
export const PRIMITIVES: Primitive[] = [
  // goto(place): effect at(place)
  {
    name: 'goto',
    effectMatches(sg) {
      if (sg.pred !== 'at') return null;
      // assoc-places (the believed stash) are reached by `approach` (pre: know_assoc), not a
      // bare goto — so a missing association inserts surveil/ask rather than a dead-end goto.
      if (sg.place && typeof sg.place === 'object' && sg.place.assoc) return null;
      return { name: 'goto', place: sg.place };
    },
    precondition() { return []; },     // movement has no believed precondition
    cost(agent, ctx, bind) { return travelCost(agent, ctx, bind.place); },
    exec: { verb: 'goto' },
  },

  // gather(good): effect have(good)+1 ; precond at(node(good)) ; raw goods only
  {
    name: 'gather',
    effectMatches(sg) {
      if (sg.pred !== 'have' || !sg.good || !RAW_GOODS.has(sg.good)) return null;
      const site = siteKindForGood(sg.good);
      if (!site) return null;
      return { name: 'gather', good: sg.good, n: sg.n, site };
    },
    precondition(agent, ctx, bind) { return [Atom.at(bind.site as string)]; },
    cost(agent, ctx, bind) {
      // a few seconds of gathering per unit (cheaper if you already work this node)
      const own = agent.profession && PROFS[agent.profession]?.output === bind.good;
      return PLAN.actBase * (own ? 1 : 2) * (bind.n || 1);
    },
    exec: { verb: 'gather' },
  },

  // produce: effect have(output)+1 ; precond at(site) + profession + inputs
  {
    name: 'produce',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'have' || !agent.profession) return null;
      const prof = PROFS[agent.profession];
      if (!prof || prof.output !== sg.good) return null;
      return { name: 'produce', good: sg.good, n: sg.n, site: prof.site, inputs: prof.inputs || null };
    },
    precondition(agent, ctx, bind) {
      const pre = [Atom.at(bind.site as string)];
      if (bind.inputs) for (const c in bind.inputs) pre.push(Atom.have(c, bind.inputs[c]));
      return pre;
    },
    cost() { return PLAN.actBase * 2; },
    exec: { verb: 'produce' },
  },

  // buy(good): effect have(good)+1 ; precond at(market) + gold >= price
  {
    name: 'buy',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'have' || !sg.good) return null;
      const price = believedPrice(agent, sg.good);
      if (price == null) return null;
      return { name: 'buy', good: sg.good, n: sg.n, price };
    },
    precondition(agent, ctx, bind) {
      return [Atom.at(POI_KIND.MARKET), Atom.goldGe((bind.price || 0) * (bind.n || 1))];
    },
    cost(agent, ctx, bind) { return (bind.price || 0) * (bind.n || 1); },
    exec: { verb: 'buy' },
  },

  // sell(good): effect gold += price ; precond at(market) + have(good)
  {
    name: 'sell',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'gold_ge') return null;
      // choose a good we can plausibly sell toward the gold target: our surplus
      let best: string | null = null, bestPrice = 0;
      for (const c of COMMODITIES) {
        const price = believedPrice(agent, c);
        if (price == null) continue;
        if (giveableStock(agent, c) > 0 && price > bestPrice) { best = c; bestPrice = price; }
      }
      if (!best) return null;
      return { name: 'sell', good: best, price: bestPrice };
    },
    precondition(agent, ctx, bind) {
      return [Atom.at(POI_KIND.MARKET), Atom.have(bind.good as string, 1)];
    },
    cost(agent, ctx, bind) { return PLAN.actBase; },
    exec: { verb: 'sell' },
  },

  // give(item, n, to): effect to.received(value) [goods] ; precond at(to)+have
  {
    name: 'give',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'received') return null;
      if (sg.kind === 'coin') return null;                 // goal demands coin -> use pay
      // pick a giveable good we either hold a surplus of or could acquire
      let chosen: string | null = null;
      for (const g of GIFTABLE) {
        if (giveableStock(agent, g) > 0) { chosen = g; break; }
      }
      // if we hold nothing giveable, still offer 'food' as the acquire-first path
      const item = chosen || (sg.kind === 'food' ? 'food' : 'food');
      const n = PLAN.giftN;
      return { name: 'give', item, n, to: sg.subjectId, fromStock: !!chosen };
    },
    precondition(agent, ctx, bind) {
      // acquire the good FIRST, then travel to the target: ordering the goto LAST
      // ensures the agent is actually at(to) when the give lands, even when the
      // `have` subgoal itself involves travelling away to a market/node to acquire.
      return [Atom.have(bind.item as string, bind.n), Atom.at({ subjectId: bind.to as EntityId })];
    },
    cost(agent, ctx, bind) {
      // value handed over is a real cost (we lose the good); from-stock cheaper
      const price = believedPrice(agent, bind.item as string) || 1;
      return price * (bind.n || 0) * 0.5;
    },
    exec: { verb: 'give' },
  },

  // pay(amt, to): effect to.received(value) [coin] ; precond at(to)+gold>=amt
  {
    name: 'pay',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'received') return null;
      if (sg.kind === 'food' || sg.kind === 'goods') return null;  // goal demands a good
      const amt = Math.max(1, Math.round(sg.value || 1));
      return { name: 'pay', amt, to: sg.subjectId };
    },
    precondition(agent, ctx, bind) {
      // raise the coin FIRST (may require a market trip), then travel to the
      // target so the agent is at(to) when the pay lands (see give's note).
      return [Atom.goldGe(bind.amt || 0), Atom.at({ subjectId: bind.to as EntityId })];
    },
    cost(agent, ctx, bind) { return bind.amt || 0; },   // coin handed over is the cost
    exec: { verb: 'pay' },
  },

  // consume(item): effect need/hp up (modelled as a have-precond action)
  {
    name: 'consume',
    effectMatches(sg) {
      if (sg.pred !== 'sated') return null;
      return { name: 'consume', item: sg.item || 'food' };
    },
    precondition(agent, ctx, bind) { return [Atom.have(bind.item as string, 1)]; },
    cost() { return PLAN.actBase; },
    exec: { verb: 'consume' },
  },

  // attack(target): effect target.hp-- (chain toward dead) ; precond in_reach
  {
    name: 'attack',
    effectMatches(sg) {
      if (sg.pred !== 'dead') return null;
      return { name: 'attack', target: sg.subjectId };
    },
    precondition(agent, ctx, bind) { return [Atom.inReach(bind.target as EntityId)]; },
    cost(agent, ctx, bind) {
      // distance to believed target position + combat risk
      const tp = believedPos(agent, ctx, { subjectId: bind.target as EntityId });
      const d = tp ? Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z) : 40;
      return d * PLAN.travelPerMetre + PLAN.actBase * 3;
    },
    exec: { verb: 'attack' },
  },

  // loot(corpse): effect have(gold) from a corpse ; precond at(corpse)
  {
    name: 'loot',
    effectMatches(sg) {
      if (sg.pred !== 'gold_ge') return null;
      if (sg.corpseId == null) return null;       // only when a known corpse exists
      return { name: 'loot', corpse: sg.corpseId };
    },
    precondition(agent, ctx, bind) { return [Atom.at({ subjectId: bind.corpse as EntityId })]; },
    cost() { return PLAN.actBase; },
    exec: { verb: 'loot' },
  },

  // ── EPISTEMIC primitives (Phase 4, the urchin). Gated by URCHIN.enabled: every
  // effectMatches early-returns null when off, so the planner emits none and the soak is
  // byte-stable. The tri+ slot into the SAME backward-chainer as gather/produce. ───────────

  // shadow(mark): the epistemic GATHER — surveil to ACQUIRE know_assoc. pre: — (the executor
  // does the slow follow-at-standoff). `shadow` is to know_assoc what `gather` is to have.
  {
    name: 'shadow',
    effectMatches(sg) {
      if (!URCHIN.enabled || sg.pred !== 'know_assoc' || sg.subjectId == null) return null;
      return { name: 'shadow', target: sg.subjectId };
    },
    precondition() { return []; },                 // the surveil itself is the acquisition
    cost() { return URCHIN.shadowCost; },           // slow but safe
    exec: { verb: 'surveil' },
  },

  // approach(stash): reach the believed stash. pre: know_assoc (so an unknown stash inserts
  // shadow BEFORE moving — distinct from a bare goto, which can't reach an assoc-place).
  {
    name: 'approach',
    effectMatches(sg) {
      if (!URCHIN.enabled || sg.pred !== 'at') return null;
      const pl = sg.place;
      if (!(pl && typeof pl === 'object' && pl.assoc)) return null;
      return { name: 'approach', place: pl, target: pl.subjectId };
    },
    precondition(agent, ctx, bind) { return [Atom.knowAssoc(bind.target as EntityId)]; },
    cost(agent, ctx, bind) {
      const c = travelCost(agent, ctx, bind.place);
      if (Number.isFinite(c)) return c;
      // stash not localized YET (planning the surveil that will reveal it) — estimate via the
      // mark's believed position; the exact assoc pos resolves once `shadow` has run.
      const c2 = travelCost(agent, ctx, { subjectId: bind.target });
      return Number.isFinite(c2) ? c2 : PLAN.actBase * 4;
    },
    exec: { verb: 'approach' },
  },

  // burgle(mark): effect have(gold) from the mark's believed stash. pre: know_assoc + at(stash).
  // Only matches a MARK-flavoured gold_ge (subjectId set) — plain seek_fortune gold_ge is
  // untouched (sell/loot). The believedFar/no-witness SAFETY gates land with the counter-schema.
  {
    name: 'burgle',
    effectMatches(sg) {
      if (!URCHIN.enabled || sg.pred !== 'gold_ge' || sg.subjectId == null) return null;
      return { name: 'burgle', target: sg.subjectId, place: { subjectId: sg.subjectId, assoc: 'stash' }, amt: sg.amt };
    },
    precondition(agent, ctx, bind) { return [Atom.knowAssoc(bind.target as EntityId), Atom.at(bind.place as PlannerPlace)]; },
    cost() { return PLAN.actBase; },
    exec: { verb: 'burgle' },
  },
];

const byName = (n: string): Primitive | null => PRIMITIVES.find((p) => p.name === n) || null;

// in_reach also wants the agent AT the target's believed pos: chain via goto.
// We special-case it so attack plans become [goto(subject) -> attack].
function inReachPrecond(bind: { target: EntityId }): SubAtom[] { return [Atom.at({ subjectId: bind.target })]; }

// ---------------------------------------------------------------------------
// PHASE 1 — numeric-threshold composition (docs/architecture/10). Gated by
// QUANTITY.enabled at the solveAtom seam: when off, neither composer is reached and
// the planner is byte-identical. Each composer reasons over the HANDFUL of believed
// sources an agent actually knows of, greedily stacking the best yield-for-cost until
// the believed total crosses the target — or, when it cannot, returns the best PARTIAL
// plan (the SATISFICE) and flags `frontier.partial`/`shortfall` so plan() cools the goal.
// This is the one place the planner spends more than one step on a single numeric atom.
// ---------------------------------------------------------------------------

// Build a plan step in the shape the generic solver emits (so the executor + precond
// helpers read it uniformly): { prim, bind, exec:{verb} }.
function mkStep(name: string, bind: Bind, verb: string): PlanStep {
  return { prim: name, bind: bind as unknown as PlanStep['bind'], exec: { verb } };
}

// Greedily raise believed gold to `target` by SELLING surplus at the believed market —
// the conserved (moved-not-made) source a professionless poor agent actually has. Best
// believed price first (best yield per uniform sell-cost). `frontier.widen` (a bold or
// hard-driven agent) sells into the keep RESERVE too — the doc's "widen toward riskier
// options". Threads a per-good simulated surplus so each sale depletes the source. Returns
// [goto(market), sell×k]; sets frontier.partial when the believed total still falls short.
function composeGold(agent: Agent, ctx: CognitionCtx, atom: SubAtom, frontier: Frontier, simState: SimState): Solved {
  const target = atom.amt || 0;
  let gold = simState.gold || 0;
  if (gold >= target) return { steps: [], cost: 0 };
  const marketCost = travelCost(agent, ctx, POI_KIND.MARKET);   // believed market; ∞ if none in mind
  const keep = (ECON.keep as Record<string, number> | undefined) || {};
  // enumerate sell-sources from the SIMULATED inventory, best believed price first.
  const sources: { good: string; price: number; units: number }[] = [];
  for (const c of COMMODITIES) {
    const price = believedPrice(agent, c);
    if (price == null) continue;
    const reserve = frontier.widen ? 0 : (keep[c] || 0);
    const units = Math.max(0, Math.floor((simState.inv[c] || 0) - reserve));
    if (units > 0) sources.push({ good: c, price, units });
  }
  sources.sort((a, b) => b.price - a.price);
  const steps: PlanStep[] = [];
  let cost = 0;
  for (const src of sources) {
    if (gold >= target || steps.length >= PLAN.maxPlan - 1) break;
    // sell a BATCH of this good — only as many units as the target still needs (the doc's
    // "a cartload's believed yield"). The believed yield is price × units; the source depletes.
    const need = Math.ceil((target - gold) / src.price);
    const n = Math.min(src.units, need);
    if (n <= 0) continue;
    steps.push(mkStep('sell', { name: 'sell', good: src.good, price: src.price, n }, 'sell'));
    cost += PLAN.actBase;
    gold += src.price * n;
  }
  if (steps.length && Number.isFinite(marketCost)) {
    steps.unshift(mkStep('goto', { name: 'goto', place: POI_KIND.MARKET }, 'goto'));
    cost += marketCost;
  } else if (steps.length) {
    // believed market unreachable: can't actually sell — drop the steps, it's a pure shortfall.
    steps.length = 0; cost = 0; gold = simState.gold || 0;
  }
  if (gold < target) { frontier.partial = true; frontier.shortfall = target - gold; }
  return { steps, cost };
}

// Raise a graded NEED to AT LEAST `level` by eating — meeting a need is crossing a
// threshold, not flipping a flag, so one meal short means a second meal is an ordinary
// composed plan. Acquire the meals first (through the generic acquire machinery — gather /
// buy / from stock), then eat them. Phase-1 scope is hunger (the one need with a consumable
// good); other needs (rest/heal/socialise) join as their Tend rows land. Sets
// frontier.partial when the meals can't be acquired (the satisfice the caller cools down).
function composeNeed(agent: Agent, ctx: CognitionCtx, atom: SubAtom, depth: number, frontier: Frontier, simState: SimState): Solved {
  const need = atom.need || 'hunger';
  const level = atom.level || 0;
  const cur = (simState.need[need] != null) ? simState.need[need] : ((agent.needs && agent.needs[need]) || 0);
  if (need !== 'hunger' || cur >= level) {
    if (cur < level) { frontier.partial = true; frontier.shortfall = level - cur; }
    return { steps: [], cost: 0 };
  }
  const meals = Math.max(1, Math.min(PLAN.maxPlan - 1, Math.ceil((level - cur) / (QUANTITY.needMeal || 0.34))));
  // acquire the food first (generic solver: from stock, gather, buy, …), then eat it.
  const acquire = solveAll(agent, ctx, [Atom.have('food', meals)], depth + 1, frontier, simState);
  if (!acquire) { frontier.partial = true; frontier.shortfall = level - cur; return { steps: [], cost: 0 }; }
  const steps: PlanStep[] = [...acquire.steps];
  let cost = acquire.cost;
  for (let i = 0; i < meals && steps.length < PLAN.maxPlan; i++) {
    steps.push(mkStep('consume', { name: 'consume', item: 'food' } as Bind, 'consume'));
    cost += PLAN.actBase;
  }
  return { steps, cost };
}

// ---------------------------------------------------------------------------
// The backward-chaining solver. Returns the min-cost ordered primitive list
// that satisfies `goalAtom` from believed state, or null. Depth + frontier
// bounded; every access guarded; never throws.
// ---------------------------------------------------------------------------

// Solve a single open atom into an ordered primitive list (steps) + cost.
// `inv` is a believed-inventory delta map tracking goods/gold the plan already
// arranges, so a later precond can be met by an earlier step's effect.
function solveAtom(agent: Agent, ctx: CognitionCtx, atom: SubAtom, depth: number, frontier: Frontier, simState: SimState): Solved | null {
  if (depth > PLAN.maxDepth) return null;
  if (frontier.n > PLAN.maxFrontier) return null;
  frontier.n++;

  // already satisfied in the simulated believed state?
  if (atomSatisfied(atom, agent, ctx, simState)) return { steps: [], cost: 0 };

  // PHASE 1 (gated by QUANTITY): numeric-threshold atoms COMPOSE several acquisitions toward
  // the target instead of emitting a single advancing step, and satisfice + flag the frontier
  // when it cannot be reached. The subjectId-flavoured gold_ge (the urchin's burgle) keeps its
  // own single-source path. Off → neither branch is reached, so the planner is byte-identical.
  if (QUANTITY.enabled) {
    if (atom.pred === 'gold_ge' && atom.subjectId == null) return composeGold(agent, ctx, atom, frontier, simState);
    if (atom.pred === 'need_ge') return composeNeed(agent, ctx, atom, depth, frontier, simState);
  }

  let best: Solved | null = null;
  for (const prim of PRIMITIVES) {
    const bind = prim.effectMatches(atom, null, agent);
    if (!bind) continue;
    if (!effectAdvances(prim, atom, bind, agent, ctx, simState)) continue;

    // simulate this primitive's effect on a cloned believed state
    const next = cloneState(simState);
    applyEffect(prim, bind, agent, next);

    // gather this primitive's preconditions
    let pre = prim.precondition(agent, ctx, bind);
    // in_reach decomposes to "at the target's believed position"
    pre = pre.flatMap((p) => (p.pred === 'in_reach' ? inReachPrecond({ target: p.subjectId as EntityId }) : [p]));

    const sub = solveAll(agent, ctx, pre, depth + 1, frontier, next);
    if (!sub) continue;

    const stepCost = prim.cost(agent, ctx, bind);
    if (!Number.isFinite(stepCost)) continue;      // unreachable place / unknown price
    const cost = stepCost + sub.cost;
    if (!Number.isFinite(cost)) continue;
    // bind carries the planner's wider place form ({subjectId}); the PlanStep boundary
    // models it as the loose PlanBind that the act() executor reads — cast at the seam.
    const step: PlanStep = { prim: prim.name, bind: bind as unknown as PlanStep['bind'], exec: prim.exec };
    const steps: PlanStep[] = [...sub.steps, step];
    if (steps.length > PLAN.maxPlan) continue;
    if (!best || cost < best.cost) best = { steps, cost };
  }
  return best;
}

// Solve a list of atoms in order, threading the simulated state forward.
function solveAll(agent: Agent, ctx: CognitionCtx, atoms: SubAtom[], depth: number, frontier: Frontier, simState: SimState): Solved | null {
  let state = simState, steps: PlanStep[] = [], cost = 0;
  for (const atom of atoms) {
    const r = solveAtom(agent, ctx, atom, depth, frontier, state);
    if (!r) return null;
    steps = steps.concat(r.steps);
    cost += r.cost;
    // re-apply already handled inside solveAtom via clone; recompute forward
    state = applyStepsForward(agent, state, r.steps);
  }
  return { steps, cost };
}

// --- simulated believed-state bookkeeping ----------------------------------
// We track only what a precondition might read: inventory deltas, gold delta,
// the agent's planned position (which place it will be "at"), received-flags.
function initState(agent: Agent): SimState {
  const inv: Record<string, number> = {};
  for (const c of COMMODITIES) inv[c] = (agent.inventory && agent.inventory[c]) || 0;
  return { inv, gold: agent.gold || 0, at: null, received: {}, knownAssoc: {}, need: { ...(agent.needs || {}) } };
}
function cloneState(s: SimState): SimState {
  return { inv: { ...s.inv }, gold: s.gold, at: s.at, received: { ...s.received }, knownAssoc: { ...s.knownAssoc }, need: { ...s.need } };
}
function applyEffect(prim: Primitive, bind: Bind, agent: Agent, s: SimState): void {
  switch (prim.name) {
    case 'goto':    s.at = bind.place ?? null; break;
    case 'gather':  s.inv[bind.good!] = (s.inv[bind.good!] || 0) + (bind.n || 1); break;
    case 'produce': s.inv[bind.good!] = (s.inv[bind.good!] || 0) + (bind.n || 1); break;
    case 'buy':     s.inv[bind.good!] = (s.inv[bind.good!] || 0) + (bind.n || 1);
                    s.gold -= (bind.price || 0) * (bind.n || 1); break;
    case 'sell':    s.inv[bind.good!] = Math.max(0, (s.inv[bind.good!] || 0) - 1);
                    s.gold += (bind.price || 0); break;
    case 'give':    s.inv[bind.item!] = Math.max(0, (s.inv[bind.item!] || 0) - (bind.n || 0));
                    s.received[String(bind.to)] = true; break;
    case 'pay':     s.gold -= (bind.amt || 0); s.received[String(bind.to)] = true; break;
    case 'consume': s.inv[bind.item!] = Math.max(0, (s.inv[bind.item!] || 0) - 1); break;
    case 'loot':    s.gold += 1; break;
    case 'attack':  break;
    // epistemic (urchin): shadow/ask ARRANGE the association; approach moves to it; burgle
    // converts the believed stash into gold (the believed amount, like loot raises gold).
    case 'shadow':   s.knownAssoc[String(bind.target)] = true; break;
    case 'approach': s.at = bind.place ?? null; break;
    case 'burgle':   s.gold += (bind.amt || 0); break;
  }
}
function applyStepsForward(agent: Agent, s: SimState, steps: PlanStep[]): SimState {
  const state = cloneState(s);
  for (const st of steps) {
    const prim = byName(st.prim);
    if (prim) applyEffect(prim, st.bind as Bind, agent, state);
  }
  return state;
}

// Is the atom satisfied in the SIMULATED believed state (real state + planned
// effects)? Falls back to the live believed test when the sim doesn't track it.
function atomSatisfied(atom: SubAtom, agent: Agent, ctx: CognitionCtx, s: SimState): boolean {
  switch (atom.pred) {
    case 'at':
      return placesEqual(s.at, atom.place ?? null) || atomHolds(atom, agent, ctx);
    case 'have':
      return ((atom.good ? s.inv[atom.good] : 0) || 0) >= (atom.n || 0);
    case 'gold_ge':
      return (s.gold || 0) >= (atom.amt || 0);
    case 'received':
      return !!s.received[String(atom.subjectId)];
    case 'know_assoc':
      return !!s.knownAssoc[String(atom.subjectId)] || atomHolds(atom, agent, ctx);
    case 'need_ge':
      return ((atom.need ? s.need[atom.need] : 0) || 0) >= (atom.level || 0);
    default:
      return atomHolds(atom, agent, ctx);
  }
}
function placesEqual(a: PlannerPlace | null, b: PlannerPlace | null): boolean {
  if (!a || !b) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.subjectId != null && a.subjectId === b.subjectId;
}

// Does applying this primitive actually move us toward the atom (avoid no-op
// loops, e.g. selling to raise gold we already have)?
function effectAdvances(prim: Primitive, atom: SubAtom, bind: Bind, agent: Agent, ctx: CognitionCtx, s: SimState): boolean {
  switch (atom.pred) {
    case 'have':   return true;
    case 'gold_ge': {
      // only useful if we don't already have the gold and the step raises it
      if ((s.gold || 0) >= (atom.amt || 0)) return false;
      return prim.name === 'sell' || prim.name === 'loot' || prim.name === 'burgle';
    }
    case 'at':     return prim.name === 'goto' || prim.name === 'approach';
    case 'received': return prim.name === 'give' || prim.name === 'pay';
    case 'dead':   return prim.name === 'attack';
    case 'know_assoc': {
      if (atomHolds(atom, agent, ctx)) return false;   // gossip already supplied it → no step
      return prim.name === 'shadow';                    // (ask added later as the noisy alt)
    }
    default:       return true;
  }
}

// ---------------------------------------------------------------------------
// Public entry: plan(agent, goal, ctx).
// `goal` is { atoms: [Atom...] } (the target effect atoms). Returns an ordered
// plan { steps:[{prim,bind,exec}], cost } or null. Deterministic given state +
// beliefs (cost-min with first-found tie-break).
// ---------------------------------------------------------------------------
export function plan(agent: Agent, goal: Goal, ctx: CognitionCtx): Plan | null {
  if (!agent || !goal || !ctx) return null;
  const atoms = (goal.atoms || (goal.atom ? [goal.atom] : null)) as SubAtom[] | null;
  if (!atoms || !atoms.length) return null;
  try {
    const frontier: Frontier = { n: 0 };
    // PHASE 1 (gated): drive-scaled WIDENING — a bold agent widens the failure search toward
    // riskier sources (sells into its keep reserve). Personality (risk_tolerance) is the lever
    // the doc names; the timid never widen. Off / no personality → undefined (no widen).
    if (QUANTITY.enabled && agent.personality) frontier.widen = (agent.personality.risk_tolerance || 0) >= QUANTITY.widenRiskTol;
    const state = initState(agent);
    const r = solveAll(agent, ctx, atoms, 0, frontier, state);
    // a PARTIAL result is the SATISFICE for an unreachable numeric threshold: it may carry
    // the best steps the agent can run (earn what it can) OR be empty (pure shortfall). Either
    // way it is NOT a dead end — plan() returns it (marked) so the goal layer runs/cools it
    // rather than dropping the goal, and the drive persists in motivation.
    const partial = !!(QUANTITY.enabled && frontier.partial);
    // TRACE (write-only, never read back): the GOAP outcome for this goal — a found plan
    // (with its step count) or a dead end (no feasible primitive chain → the agent replans
    // or abandons). Own data (goal kind + plan length). note() is internally guarded, and
    // agent.trace is always present (ctor) — so it is called directly, never read-guarded
    // (a `.trace` read would trip the write-only scan rule). Bounded — planning is per-goal.
    if (!r || (!r.steps.length && !partial)) agent.trace.note(ST.PLAN, RS.PLAN_FAILED, { t: ctx.time, a: goal.kind || null });
    else agent.trace.note(ST.PLAN, RS.PLAN_FOUND, { t: ctx.time, a: r.steps.length, b: goal.kind || null });
    if (!r) return null;
    if (!r.steps.length && !partial) return null;
    const out: Plan = { steps: r.steps, cost: r.cost };
    if (partial) { out.partial = true; out.shortfall = frontier.shortfall; }
    return out;
  } catch (_e) {
    return null;   // never throw on the tick
  }
}

// ---------------------------------------------------------------------------
// Phase-2 executor support. The agent's act() runs the current step; these
// belief-grounded helpers let it (a) find where to walk, (b) know when a step's
// effect has landed (advance), and (c) know when the NEXT step's preconditions
// no longer hold (replan). All read believed state only; none throw.
// ---------------------------------------------------------------------------

// Resolve a step bind's `place` to a believed world position (POI or subject).
export function stepTargetPos(agent: Agent, ctx: CognitionCtx, place: PlannerPlace | null | undefined): import('three').Vector3 | null {
  try { return believedPos(agent, ctx, place); } catch { return null; }
}

// Are all of this primitive's preconditions satisfied right now (live believed
// state, NOT the planner's simulated forward state)? Used to detect a step that
// has lost its footing (market emptied, gold spent, target moved out of reach).
export function stepPrecondsHold(agent: Agent, ctx: CognitionCtx, step: PlanStep): boolean {
  if (!agent || !step) return false;
  const prim = byName(step.prim);
  if (!prim) return false;
  try {
    let pre = prim.precondition(agent, ctx, step.bind as Bind) || [];
    pre = pre.flatMap((p) => (p.pred === 'in_reach' ? inReachPrecond({ target: p.subjectId as EntityId }) : [p]));
    return pre.every((atom) => atomHolds(atom, agent, ctx));
  } catch { return false; }
}

// Has this step's EFFECT landed in live believed state (so we may advance to the
// next step)? `received` flags are tracked on agent._repaid by the give/pay
// executor, so we read that here. Belief-grounded; never throws.
export function stepEffectHolds(agent: Agent, ctx: CognitionCtx, step: PlanStep): boolean {
  if (!agent || !step) return false;
  const bind = step.bind as Bind;
  // `_repaid` is the give/pay executor's received-flag map (own-state, set by act()).
  const repaid = agent._repaid as Record<string, boolean> | undefined;
  try {
    switch (step.prim) {
      case 'goto':
        return atomHolds(Atom.at(bind.place as PlannerPlace), agent, ctx);
      case 'gather': case 'produce': case 'buy':
        return ((bind.good ? agent.inventory?.[bind.good] : 0) || 0) >= (bind.n || 1);
      case 'sell':
        return true;   // a single sell tick raises gold; loop guard handled by goal predicate
      case 'give': case 'pay':
        return !!(repaid && repaid[String(bind.to)]);
      case 'consume':
        return true;
      case 'attack':
        return believedDead(agent, bind.target as EntityId);   // believed-dead (belief/_slain), not a roster read
      case 'loot':
        return true;
      default: return false;
    }
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Goal / predicate helpers — build the goal descriptors the stack will hold.
// Each returns { kind, atoms, predicate(agent,ctx), target? }.
// `predicate` is satisfied-when (read by the stack to pop a finished goal). It
// reads beliefs / ground-truth-of-self only, never others' inventories.
// ---------------------------------------------------------------------------

// avenge(subjectId): subject dead.
export function goalAvenge(subjectId: EntityId): Goal {
  return {
    kind: 'avenge', subjectId,
    atoms: [Atom.dead(subjectId)] as AtomT[],
    // satisfied when the subject is BELIEVED DEAD: a combat bridge marked it slain by me
    // (_slain — the sanctioned out-of-sight death signal) OR I no longer hold a confident
    // belief about it. Never reads the live roster.
    predicate(agent: unknown) { return believedDead(agent as Agent, subjectId); },
  };
}

// seek_fortune(place, target): hold gold >= target.
export function goalSeekFortune(place: string, target: number): Goal {
  const amt = Math.max(1, target || 0);
  return {
    kind: 'seek_fortune', place, target: amt,
    atoms: [Atom.goldGe(amt)] as AtomT[],
    predicate(agent: unknown) { return ((agent as Agent).gold || 0) >= amt; },
  };
}

// sate(need, level): raise a graded need ABOVE a believed level by eating (Phase 1; the
// threshold composition is gated by QUANTITY at the planner seam). Deliberately NOT wired
// into deriveGoals — the reactive needs scheduler still services hunger live; this exposes
// the SAME need as a planner threshold so a later breadth phase can compose a meal-run toward
// it (the doc's "needs are graded"). predicate reads own need only; never others'.
export function goalSate(need: string, level: number): Goal {
  const lv = Math.max(0, Math.min(1, level || 0));
  return {
    kind: 'sate', need, target: lv,
    atoms: [Atom.needGe(need, lv)] as AtomT[],
    predicate(agent: unknown) { const n = (agent as Agent).needs; return !!(n && (n[need] || 0) >= lv); },
  };
}

// steal(mark, target): hold gold >= target by BURGLING the mark's believed stash. The
// gold_ge atom carries the mark so the burgle primitive routes to it; the same gold target
// as seek_fortune, but the gold arrives via a heist (shadow → approach → burgle) — and if
// the urchin has no `assoc` belief yet, the chainer prepends the epistemic gather (surveil).
export function goalSteal(subjectId: EntityId, target: number): Goal {
  const amt = Math.max(1, target || 0);
  return {
    kind: 'steal', subjectId, target: amt,
    atoms: [Atom.stealGold(amt, subjectId)] as AtomT[],
    predicate(agent: unknown) { return ((agent as Agent).gold || 0) >= amt; },
  };
}

// grieve(subjectId): mourning a fallen friend. There is no PLAN for grief — it is
// a disposition that simply runs its course; the predicate is satisfied only by the
// mourning timeout (expiresAt, set by deriveGoals). atoms is empty so the planner
// returns null for it (no primitive chain), and decide() never injects a plan step.
// When the culprit is known, deriveGoals also pushes a SEPARATE avenge(culprit) goal
// (which DOES plan). Keeping grief plan-less is what lets it sit on the stack and
// "decay" out without ever competing with the reactive needs loop.
export function goalGrieve(subjectId: EntityId): Goal {
  return {
    kind: 'grieve', subjectId,
    atoms: [],                        // no actionable plan — grief just runs its course
    predicate() { return false; },    // only the expiresAt timeout pops it
  };
}

// delve(place): venture into a place to recover a relic. NPCs have no `relics`
// mechanic of their own (that is player-only via quests), so for NPCs the goal is
// aspirational: it biases them toward the place (a goto plan) and pops on the
// relic flag (if one is ever set) or its timeout. The plan is just [goto(place)].
export function goalDelve(place: string): Goal {
  return {
    kind: 'delve', place,
    atoms: [Atom.at(place)] as AtomT[],
    predicate(agent: unknown) { const relics = (agent as Agent).relics; return !!(relics && (relics as unknown[]).length > 0); },
  };
}

// repay(subjectId, value, kind): subject received `value` of `kind` from me.
// `kind`: 'any' (give OR pay), 'coin' (pay), 'food'/'goods' (give a good).
export function goalRepay(subjectId: EntityId, value = 1, kind = 'any'): Goal {
  return {
    kind: 'repay', subjectId, target: value, valueKind: kind,
    atoms: [Atom.received(subjectId, value, kind)] as AtomT[],
    // satisfied when an explicit transfer set the flag; the stack stamps
    // goal._satisfied via markReceived() when a give/pay to subjectId executes.
    predicate(agent: unknown) {
      const repaid = (agent as Agent)._repaid as Record<string, boolean> | undefined;
      return !!(repaid && repaid[String(subjectId)]);
    },
  };
}

// ---------------------------------------------------------------------------
// SCHEMA DISPOSITIONS (Phase 2a → 2b LANDED) — hide/shadow/avoid are the
// plan-less goal kinds the flagship InteractionSchemas adopt as a response.
// They were Phase-2a collapse-fodder; Phase 2b LANDED them as steer-fills:
//   · the GOAL OBJECT is now built INLINE by the schema response ops in
//     js/sim/schemas/vocab.js (`hide`/`shadow`/`avoid`/`fleeTo`), which carry
//     toPos/around/subjectId exactly as the steer-fills read them;
//   · the LOCOMOTION is fillHide/fillShadow/fillAvoid/fillFlee in
//     js/sim/agent/steer.js, dispatched through the single steer() executor
//     (no per-kind branch in act.js — they fall through STEER_FILLS[k]).
// The standalone goalHide/goalShadow/goalAvoid factories that once lived here
// (Phase-2a placeholders) were retired with that collapse — they had no callers
// and the inline vocab builders supersede them. Disposition goals stay PLAN-LESS
// (atoms:[]) so _currentPlanStep lets them sit on the stack and pruneGoals ages
// them off by the interpreter-stamped expiresAt, exactly like grief.
// ---------------------------------------------------------------------------
