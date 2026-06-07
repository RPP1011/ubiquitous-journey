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

import { PROFESSIONS, COMMODITIES, ECON, SIM } from './simconfig.js';
import { POI_KIND } from './world.js';

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
};

// Goods an agent can hand over as a gift of "value" (consumable/tradeable).
const GIFTABLE = ['food', 'potion', 'herb', 'wood', 'ore', 'tool'];

// ---------------------------------------------------------------------------
// Believed-world helpers. All reads here are belief-grounded.
// ---------------------------------------------------------------------------

// The site POI kind a given commodity is GATHERED / PRODUCED at (its profession
// site). Raw goods (food/wood/ore/herb) map to a resource node; tool/potion are
// crafted (need a profession), handled by the produce primitive.
function siteKindForGood(good) {
  for (const k in PROFESSIONS) {
    if (PROFESSIONS[k].output === good) return PROFESSIONS[k].site;
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
function believedDead(agent, subjectId) {
  if (!agent) return true;
  if (agent._slain && agent._slain.has(subjectId)) return true;
  return !(agent.beliefs && agent.beliefs.get(subjectId));
}

// Believed position of a "place". A place is either a POI kind (string POI_KIND)
// or a target descriptor { subjectId } resolved via the agent's belief.lastPos.
function believedPos(agent, ctx, place) {
  if (!place) return null;
  if (typeof place === 'object' && place.subjectId != null) {
    // BELIEF-ONLY: navigate toward where I BELIEVE the subject is (its last sighting),
    // never its true position. No confident belief -> unknown place (null). The pursuit
    // model (combatStep) handles re-acquisition + the inferred destination separately.
    const b = agent.beliefs && agent.beliefs.get(place.subjectId);
    if (b && b.confidence > 0) return b.lastPos;
    return null;
  }
  // a POI kind string
  const poi = ctx.world && ctx.world.nearest(place, agent.pos);
  return poi ? poi.pos : null;
}

// Believed travel cost from the agent to a place (metres -> cost), plus a route
// risk surcharge for believed-hostiles sitting near the destination.
function travelCost(agent, ctx, place) {
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
function believedPrice(agent, good) {
  const p = agent.priceBeliefs ? agent.priceBeliefs[good] : null;
  return (typeof p === 'number' && p > 0) ? p : null;
}

// How many units of `good` the agent can spare as a gift without dipping below
// its personal keep reserve (ECON.keep).
function giveableStock(agent, good) {
  const have = (agent.inventory && agent.inventory[good]) || 0;
  const keep = (ECON.keep && ECON.keep[good]) || 0;
  return Math.max(0, Math.floor(have - keep));
}

// ---------------------------------------------------------------------------
// Subgoal atoms. A subgoal is a believed-state predicate the planner must
// satisfy. `holds(agent, ctx)` tests it against believed state.
// ---------------------------------------------------------------------------
export const Atom = {
  at: (place) => ({ pred: 'at', place }),
  have: (good, n = 1) => ({ pred: 'have', good, n }),
  goldGe: (amt) => ({ pred: 'gold_ge', amt }),
  received: (subjectId, value, kind = 'any') => ({ pred: 'received', subjectId, value, kind }),
  dead: (subjectId) => ({ pred: 'dead', subjectId }),
  inReach: (subjectId) => ({ pred: 'in_reach', subjectId }),
};

function atomHolds(atom, agent, ctx) {
  switch (atom.pred) {
    case 'at': {
      const tp = believedPos(agent, ctx, atom.place);
      if (!tp) return false;
      return Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z) <= SIM.arriveDist + 0.01;
    }
    case 'have':
      return ((agent.inventory && agent.inventory[atom.good]) || 0) >= atom.n;
    case 'gold_ge':
      return (agent.gold || 0) >= atom.amt;
    case 'received':
      // satisfied only by an explicit transfer this plan performs; never true a priori
      return false;
    case 'dead': {
      // BELIEF/BRIDGE-BASED: the subject is "believed dead" when a combat bridge stamped it
      // on my _slain set (I struck the killing blow, even out of my own sight) OR I hold no
      // confident belief about it any more. No roster/liveness read.
      return believedDead(agent, atom.subjectId);
    }
    case 'in_reach': {
      // BELIEF-ONLY reach test: am I at the subject's last-believed position? No live read.
      const b = agent.beliefs && agent.beliefs.get(atom.subjectId);
      const tp = (b && b.confidence > 0) ? b.lastPos : null;
      if (!tp) return false;
      return Math.hypot(tp.x - agent.pos.x, tp.z - agent.pos.z) <= 2.2;
    }
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
export const PRIMITIVES = [
  // goto(place): effect at(place)
  {
    name: 'goto',
    effectMatches(sg) {
      if (sg.pred !== 'at') return null;
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
      if (sg.pred !== 'have' || !RAW_GOODS.has(sg.good)) return null;
      const site = siteKindForGood(sg.good);
      if (!site) return null;
      return { name: 'gather', good: sg.good, n: sg.n, site };
    },
    precondition(agent, ctx, bind) { return [Atom.at(bind.site)]; },
    cost(agent, ctx, bind) {
      // a few seconds of gathering per unit (cheaper if you already work this node)
      const own = agent.profession && PROFESSIONS[agent.profession]?.output === bind.good;
      return PLAN.actBase * (own ? 1 : 2) * (bind.n || 1);
    },
    exec: { verb: 'gather' },
  },

  // produce: effect have(output)+1 ; precond at(site) + profession + inputs
  {
    name: 'produce',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'have' || !agent.profession) return null;
      const prof = PROFESSIONS[agent.profession];
      if (!prof || prof.output !== sg.good) return null;
      return { name: 'produce', good: sg.good, n: sg.n, site: prof.site, inputs: prof.inputs || null };
    },
    precondition(agent, ctx, bind) {
      const pre = [Atom.at(bind.site)];
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
      if (sg.pred !== 'have') return null;
      const price = believedPrice(agent, sg.good);
      if (price == null) return null;
      return { name: 'buy', good: sg.good, n: sg.n, price };
    },
    precondition(agent, ctx, bind) {
      return [Atom.at(POI_KIND.MARKET), Atom.goldGe(bind.price * (bind.n || 1))];
    },
    cost(agent, ctx, bind) { return bind.price * (bind.n || 1); },
    exec: { verb: 'buy' },
  },

  // sell(good): effect gold += price ; precond at(market) + have(good)
  {
    name: 'sell',
    effectMatches(sg, _bind, agent) {
      if (sg.pred !== 'gold_ge') return null;
      // choose a good we can plausibly sell toward the gold target: our surplus
      let best = null, bestPrice = 0;
      for (const c of COMMODITIES) {
        const price = believedPrice(agent, c);
        if (price == null) continue;
        if (giveableStock(agent, c) > 0 && price > bestPrice) { best = c; bestPrice = price; }
      }
      if (!best) return null;
      return { name: 'sell', good: best, price: bestPrice };
    },
    precondition(agent, ctx, bind) {
      return [Atom.at(POI_KIND.MARKET), Atom.have(bind.good, 1)];
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
      let chosen = null;
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
      return [Atom.have(bind.item, bind.n), Atom.at({ subjectId: bind.to })];
    },
    cost(agent, ctx, bind) {
      // value handed over is a real cost (we lose the good); from-stock cheaper
      const price = believedPrice(agent, bind.item) || 1;
      return price * bind.n * 0.5;
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
      return [Atom.goldGe(bind.amt), Atom.at({ subjectId: bind.to })];
    },
    cost(agent, ctx, bind) { return bind.amt; },   // coin handed over is the cost
    exec: { verb: 'pay' },
  },

  // consume(item): effect need/hp up (modelled as a have-precond action)
  {
    name: 'consume',
    effectMatches(sg) {
      if (sg.pred !== 'sated') return null;
      return { name: 'consume', item: sg.item || 'food' };
    },
    precondition(agent, ctx, bind) { return [Atom.have(bind.item, 1)]; },
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
    precondition(agent, ctx, bind) { return [Atom.inReach(bind.target)]; },
    cost(agent, ctx, bind) {
      // distance to believed target position + combat risk
      const tp = believedPos(agent, ctx, { subjectId: bind.target });
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
    precondition(agent, ctx, bind) { return [Atom.at({ subjectId: bind.corpse })]; },
    cost() { return PLAN.actBase; },
    exec: { verb: 'loot' },
  },
];

const byName = (n) => PRIMITIVES.find((p) => p.name === n) || null;

// in_reach also wants the agent AT the target's believed pos: chain via goto.
// We special-case it so attack plans become [goto(subject) -> attack].
function inReachPrecond(bind) { return [Atom.at({ subjectId: bind.target })]; }

// ---------------------------------------------------------------------------
// The backward-chaining solver. Returns the min-cost ordered primitive list
// that satisfies `goalAtom` from believed state, or null. Depth + frontier
// bounded; every access guarded; never throws.
// ---------------------------------------------------------------------------

// Solve a single open atom into an ordered primitive list (steps) + cost.
// `inv` is a believed-inventory delta map tracking goods/gold the plan already
// arranges, so a later precond can be met by an earlier step's effect.
function solveAtom(agent, ctx, atom, depth, frontier, simState) {
  if (depth > PLAN.maxDepth) return null;
  if (frontier.n > PLAN.maxFrontier) return null;
  frontier.n++;

  // already satisfied in the simulated believed state?
  if (atomSatisfied(atom, agent, ctx, simState)) return { steps: [], cost: 0 };

  let best = null;
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
    pre = pre.flatMap((p) => (p.pred === 'in_reach' ? inReachPrecond({ target: p.subjectId }) : [p]));

    const sub = solveAll(agent, ctx, pre, depth + 1, frontier, next);
    if (!sub) continue;

    const stepCost = prim.cost(agent, ctx, bind);
    if (!Number.isFinite(stepCost)) continue;      // unreachable place / unknown price
    const cost = stepCost + sub.cost;
    if (!Number.isFinite(cost)) continue;
    const steps = [...sub.steps, { prim: prim.name, bind, exec: prim.exec }];
    if (steps.length > PLAN.maxPlan) continue;
    if (!best || cost < best.cost) best = { steps, cost };
  }
  return best;
}

// Solve a list of atoms in order, threading the simulated state forward.
function solveAll(agent, ctx, atoms, depth, frontier, simState) {
  let state = simState, steps = [], cost = 0;
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
function initState(agent) {
  const inv = {};
  for (const c of COMMODITIES) inv[c] = (agent.inventory && agent.inventory[c]) || 0;
  return { inv, gold: agent.gold || 0, at: null, received: {} };
}
function cloneState(s) {
  return { inv: { ...s.inv }, gold: s.gold, at: s.at, received: { ...s.received } };
}
function applyEffect(prim, bind, agent, s) {
  switch (prim.name) {
    case 'goto':    s.at = bind.place; break;
    case 'gather':  s.inv[bind.good] = (s.inv[bind.good] || 0) + (bind.n || 1); break;
    case 'produce': s.inv[bind.good] = (s.inv[bind.good] || 0) + (bind.n || 1); break;
    case 'buy':     s.inv[bind.good] = (s.inv[bind.good] || 0) + (bind.n || 1);
                    s.gold -= bind.price * (bind.n || 1); break;
    case 'sell':    s.inv[bind.good] = Math.max(0, (s.inv[bind.good] || 0) - 1);
                    s.gold += bind.price; break;
    case 'give':    s.inv[bind.item] = Math.max(0, (s.inv[bind.item] || 0) - bind.n);
                    s.received[bind.to] = true; break;
    case 'pay':     s.gold -= bind.amt; s.received[bind.to] = true; break;
    case 'consume': s.inv[bind.item] = Math.max(0, (s.inv[bind.item] || 0) - 1); break;
    case 'loot':    s.gold += 1; break;
    case 'attack':  break;
  }
}
function applyStepsForward(agent, s, steps) {
  let state = cloneState(s);
  for (const st of steps) {
    const prim = byName(st.prim);
    if (prim) applyEffect(prim, st.bind, agent, state);
  }
  return state;
}

// Is the atom satisfied in the SIMULATED believed state (real state + planned
// effects)? Falls back to the live believed test when the sim doesn't track it.
function atomSatisfied(atom, agent, ctx, s) {
  switch (atom.pred) {
    case 'at':
      return placesEqual(s.at, atom.place) || atomHolds(atom, agent, ctx);
    case 'have':
      return (s.inv[atom.good] || 0) >= atom.n;
    case 'gold_ge':
      return (s.gold || 0) >= atom.amt;
    case 'received':
      return !!s.received[atom.subjectId];
    default:
      return atomHolds(atom, agent, ctx);
  }
}
function placesEqual(a, b) {
  if (!a || !b) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.subjectId != null && a.subjectId === b.subjectId;
}

// Does applying this primitive actually move us toward the atom (avoid no-op
// loops, e.g. selling to raise gold we already have)?
function effectAdvances(prim, atom, bind, agent, ctx, s) {
  switch (atom.pred) {
    case 'have':   return true;
    case 'gold_ge': {
      // only useful if we don't already have the gold and the step raises it
      if ((s.gold || 0) >= atom.amt) return false;
      return prim.name === 'sell' || prim.name === 'loot';
    }
    case 'at':     return prim.name === 'goto';
    case 'received': return prim.name === 'give' || prim.name === 'pay';
    case 'dead':   return prim.name === 'attack';
    default:       return true;
  }
}

// ---------------------------------------------------------------------------
// Public entry: plan(agent, goal, ctx).
// `goal` is { atoms: [Atom...] } (the target effect atoms). Returns an ordered
// plan { steps:[{prim,bind,exec}], cost } or null. Deterministic given state +
// beliefs (cost-min with first-found tie-break).
// ---------------------------------------------------------------------------
export function plan(agent, goal, ctx) {
  if (!agent || !goal || !ctx) return null;
  const atoms = goal.atoms || (goal.atom ? [goal.atom] : null);
  if (!atoms || !atoms.length) return null;
  try {
    const frontier = { n: 0 };
    const state = initState(agent);
    const r = solveAll(agent, ctx, atoms, 0, frontier, state);
    if (!r || !r.steps.length) return null;
    return { steps: r.steps, cost: r.cost };
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
export function stepTargetPos(agent, ctx, place) {
  try { return believedPos(agent, ctx, place); } catch { return null; }
}

// Are all of this primitive's preconditions satisfied right now (live believed
// state, NOT the planner's simulated forward state)? Used to detect a step that
// has lost its footing (market emptied, gold spent, target moved out of reach).
export function stepPrecondsHold(agent, ctx, step) {
  if (!agent || !step) return false;
  const prim = byName(step.prim);
  if (!prim) return false;
  try {
    let pre = prim.precondition(agent, ctx, step.bind) || [];
    pre = pre.flatMap((p) => (p.pred === 'in_reach' ? inReachPrecond({ target: p.subjectId }) : [p]));
    return pre.every((atom) => atomHolds(atom, agent, ctx));
  } catch { return false; }
}

// Has this step's EFFECT landed in live believed state (so we may advance to the
// next step)? `received` flags are tracked on agent._repaid by the give/pay
// executor, so we read that here. Belief-grounded; never throws.
export function stepEffectHolds(agent, ctx, step) {
  if (!agent || !step) return false;
  try {
    switch (step.prim) {
      case 'goto':
        return atomHolds(Atom.at(step.bind.place), agent, ctx);
      case 'gather': case 'produce': case 'buy':
        return ((agent.inventory && agent.inventory[step.bind.good]) || 0) >= (step.bind.n || 1);
      case 'sell':
        return true;   // a single sell tick raises gold; loop guard handled by goal predicate
      case 'give': case 'pay':
        return !!(agent._repaid && agent._repaid[step.bind.to]);
      case 'consume':
        return true;
      case 'attack':
        return believedDead(agent, step.bind.target);   // believed-dead (belief/_slain), not a roster read
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
export function goalAvenge(subjectId) {
  return {
    kind: 'avenge', subjectId,
    atoms: [Atom.dead(subjectId)],
    // satisfied when the subject is BELIEVED DEAD: a combat bridge marked it slain by me
    // (_slain — the sanctioned out-of-sight death signal) OR I no longer hold a confident
    // belief about it. Never reads the live roster.
    predicate(agent) { return believedDead(agent, subjectId); },
  };
}

// seek_fortune(place, target): hold gold >= target.
export function goalSeekFortune(place, target) {
  const amt = Math.max(1, target || 0);
  return {
    kind: 'seek_fortune', place, target: amt,
    atoms: [Atom.goldGe(amt)],
    predicate(agent) { return (agent.gold || 0) >= amt; },
  };
}

// grieve(subjectId): mourning a fallen friend. There is no PLAN for grief — it is
// a disposition that simply runs its course; the predicate is satisfied only by the
// mourning timeout (expiresAt, set by deriveGoals). atoms is empty so the planner
// returns null for it (no primitive chain), and decide() never injects a plan step.
// When the culprit is known, deriveGoals also pushes a SEPARATE avenge(culprit) goal
// (which DOES plan). Keeping grief plan-less is what lets it sit on the stack and
// "decay" out without ever competing with the reactive needs loop.
export function goalGrieve(subjectId) {
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
export function goalDelve(place) {
  return {
    kind: 'delve', place,
    atoms: [Atom.at(place)],
    predicate(agent) { return !!(agent.relics && agent.relics > 0); },
  };
}

// repay(subjectId, value, kind): subject received `value` of `kind` from me.
// `kind`: 'any' (give OR pay), 'coin' (pay), 'food'/'goods' (give a good).
export function goalRepay(subjectId, value = 1, kind = 'any') {
  return {
    kind: 'repay', subjectId, target: value, valueKind: kind,
    atoms: [Atom.received(subjectId, value, kind)],
    // satisfied when an explicit transfer set the flag; the stack stamps
    // goal._satisfied via markReceived() when a give/pay to subjectId executes.
    predicate(agent) { return !!(agent._repaid && agent._repaid[subjectId]); },
  };
}

// ---------------------------------------------------------------------------
// SCHEMA DISPOSITIONS (Phase 2a) — the minimal new goal kinds the flagship
// InteractionSchemas adopt when no EXISTING kind fits the response. They are
// PLAN-LESS dispositions (atoms:[]) so _currentPlanStep lets them sit on the
// stack and pruneGoals ages them off by expiresAt (the interpreter stamps it),
// exactly like grief. act.js carries the matching locomotion case for each.
//
// Phase 2b COLLAPSE-FODDER: hide/shadow/avoid are three special-cases of the
// same steer() potential-field primitive (attract to cover / trail at a stand-
// off / repel from a danger zone toward safety). When Phase 2b lands steer(),
// these three kinds collapse into goal.kind -> steer-fills and this trio of
// factories + their act.js cases are deleted. Kept minimal + commented so the
// retirement is mechanical.
// ---------------------------------------------------------------------------

// hide(toPos): go to ground at a concealing place and stay still until the
// disposition times out. Plan-less; pos carried on the goal by the schema.
export function goalHide(toPos) {
  return {
    kind: 'hide', toPos: toPos || null,
    atoms: [],                          // disposition: no plan, runs its course
    predicate() { return false; },      // only the expiresAt timeout pops it
  };
}

// shadow(subjectId): trail a SUSPECTED mask at a distance (collapse-fodder).
export function goalShadow(subjectId) {
  return {
    kind: 'shadow', subjectId,
    atoms: [],
    predicate() { return false; },
  };
}

// avoid(around, toPos): clear a believed danger zone — steer away from `around`
// (a believed brawl's lastPos) toward a safe place (collapse-fodder).
export function goalAvoid(around, toPos) {
  return {
    kind: 'avoid', around: around || null, toPos: toPos || null,
    atoms: [],
    predicate() { return false; },
  };
}
