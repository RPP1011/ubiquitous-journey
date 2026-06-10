# 10 (LLD) — The action grammar & knowledge model: implementation spec

> **Status: low-level design.** This is the *implementation* companion to
> [`10-action-grammar.md`](10-action-grammar.md) (the conceptual design). Read the design doc
> first — it owns the *why*. This doc owns the *how*: the module map, the data structures, and
> step-by-step pseudocode for every piece, written so an implementer (or a worktree agent) can
> build a phase without re-deriving it from prose. Pseudocode here mirrors the real shapes in
> `js/sim/planner.ts`, `js/sim/exec/registry.ts`, `js/sim/obligations.ts`, `js/sim/agent/act.ts`,
> and `js/sim/simulation.ts` — when they diverge, the **code wins** and this doc is the bug.
>
> Two hard invariants override everything below:
> - **The epistemic split** ([02](02-epistemic-split.md)): *cognition* (derivers, goals, the
>   planner, every `cost`/`precondition`/`atomHolds`) reads **beliefs and own-state only**;
>   *execution* (executors, the resolver) reads ground truth. A deriver that scans the roster is a
>   bug even if it typechecks.
> - **Verbs are data** ([§7](#7-verbs-are-data--the-three-registries)): the verb→executor binding
>   is a registry *map*, never a hand-grown `switch`. Adding a behaviour = registering a row.
>
> And the project-wide **freeze lesson**: every function on the tick path is guarded, never throws,
> and is depth/frontier/length-bounded. A single unguarded access on a professionless agent freezes
> the fixed-tick loop.

---

## 1. Module map

| file | layer | responsibility |
| --- | --- | --- |
| `js/sim/planner.ts` | cognition | the GOAP backward-chainer, the `Atom` vocabulary, the `PRIMITIVES` rows, the `ACQUIRE` table, the threshold composers, the knowledge-model accessors, the goal factories, and the execution-support reads (`stepEffectHolds`/`stepPrecondsHold`/`stepTargetPos`). The whole *vocabulary*. |
| `js/sim/motivation.ts` | cognition | `deriveGoals` — turns beliefs/needs/memory into goals; runs `runDerivers` (feature derivers) first, then the built-in episode→goal table. |
| `js/sim/exec/registry.ts` | seam | the three data registries — `EXECUTORS` (verb→executor), `DERIVERS` (goal-derivers), `EFFECT_HOLDS` (verb→effect-landed predicate) — plus their `register*`/`run*` accessors. The thing that makes verbs data. |
| `js/sim/agent/act.ts` | execution | `execPlanStep` (run the current step, advance/pop), `execPrimitive` (registry dispatch), and the **base-verb registrations** (goto/gather/produce/buy/sell/give/pay/consume/attack/hold). |
| `js/sim/obligations.ts` | both | the obligation ledger: `addObligation`/`settleObligations`/`obligationsOf`/`triggerKey`. Pure helpers; a feature wires them into the tick. |
| `js/sim/simulation.ts` | execution | constructs `ctx.resolver` — the conserved world-mutation primitives `take`/`witnessDeed`/`affect`/`deliverTo`/`marketClear`. Imports the feature index to self-register verbs. |
| `js/sim/features/*.ts` | both | **one file per feature** (urchin/learning/recruiter/affect/ledger). Each registers its executors/derivers/effect-holds as an import side-effect, gated by its own flag. Disjoint by construction (one file + one test, no shared edits). |
| `types/goals.ts` | types | `Atom`, `KnowTopic`, `PlanBind`, `PlanStep`, `Plan`, `Goal`, `Ambition`. Author shared shapes here, re-export from the `types/sim.ts` barrel. |
| `types/agent.ts` | types | `Obligation` and the `Agent` knowledge fields (`_theyBelieve`, `_strengthBelief`, `_secretBelief`, `_obligations`, `_slain`, `_repaid`, `_freedBy`, `_held`, `_wrecked`). |
| `test/suites/planner.mjs` | test | the gated phase tests (Q*/K*/R*/H*/M*/A*). `obligations.mjs` covers the ledger. |

### Where each piece runs in the tick

The cognition passes run at `SIM.tickHz` in this fixed order (see [01](01-sim-spine.md)):

```
perceive → beliefs.decay → gossipBeliefs → reason → deriveGoals → decide → _runMarket → progression.tick → quests
                                              │           │           │
                                              │           │           └── plan(agent, goal, ctx)  [planner.ts]
                                              │           └── runDerivers(a, ctx) + episode→goal table  [motivation.ts]
                                              └── (the schema interpreter; orthogonal)
act(dt)  [every frame] ── execPlanStep → execPrimitive → runExecutor(verb)  [act.ts → registry → resolver]
```

The **obligation ledger settle** is a per-tick pass a feature adds inside the cognition phase
(before `deriveGoals`, so a fired commitment can derive its deferred goal the same tick).

---

## 2. Core data structures

All module-local to `planner.ts` unless noted. The planner runs on a **superset** of the public
`Atom`/`PlanBind` vocabulary (`types/goals.ts`) — it adds the `{subjectId}` place form, extra preds,
and bookkeeping fields — so the internal shapes *widen* the public ones rather than reinventing them.

```ts
// A "place" is either a POI-kind string OR a belief-resolved target descriptor.
type PlannerPlace = string | { subjectId?: EntityId; assoc?: string };

// One open subgoal the solver chases. (public Atom + planner-only preds/fields)
interface SubAtom {
  pred: 'at'|'have'|'gold_ge'|'received'|'dead'|'in_reach'|'know_assoc'
       |'need_ge'|'know'|'hold_until'|'force_ge'|'freed'|'wrecked'|'sated';
  place?: PlannerPlace; good?: string; n?: number; amt?: number;
  subjectId?: EntityId; value?: number; kind?: string; item?: string; corpseId?: EntityId;
  need?: string; level?: number;        // need_ge: graded need + target level (0..1)
  topic?: KnowTopic;                     // know: the proposition
  cond?: SubAtom; deadline?: number;     // hold_until: the wait condition + window deadline
}

// The concrete params a primitive's effectMatches chose (one loose bind per primitive).
interface Bind { name?; place?; good?; n?; site?; inputs?; price?; item?; to?;
                 amt?; target?; corpse?; fromStock?; topic?; cond?; deadline?; }

// The simulated believed-state the solver threads FORWARD as it chains steps.
interface SimState {
  inv: Record<string, number>;          // believed inventory deltas
  gold: number;
  at: PlannerPlace | null;               // where the plan will have walked to
  received: Record<string, boolean>;     // subjectIds an earlier give/pay satisfied
  knownAssoc: Record<string, boolean>;   // subjectIds an earlier shadow/ask localised
  need: Record<string, number>;          // graded need-levels the plan raises
  known: Record<string, boolean>;        // topic-keys an earlier observe/ask/study learned
  held: Record<string, boolean>;         // hold_until conds an earlier hold waited out
  force: number;                         // believed force mustered so far
  freed: Record<string, boolean>;        // entities a free step freed
  wrecked: Record<string, boolean>;      // entities a wreck step wrecked
}

// One authored primitive. effectMatches = unification; precondition = subgoals to recurse on.
interface Primitive {
  name: string;
  effectMatches(sg: SubAtom, bind: Bind|null, agent: Agent): Bind | null;   // null = doesn't apply
  precondition(agent, ctx, bind): SubAtom[];
  cost(agent, ctx, bind): number;        // Infinity = infeasible (unknown place / unknown price)
  exec: { verb: string; made?: boolean; socialTrace?: string };
}

interface Solved   { steps: PlanStep[]; cost: number; }
// Best-first search state threaded through one solve. `n` bounds the frontier; the rest are the
// threshold-composition side-channel (all absent/false when QUANTITY/RECRUIT are off).
interface Frontier { n: number; widen?: boolean; partial?: boolean; shortfall?: number; }
```

`KnowTopic`, `PlanStep`, `Plan`, `Goal` are public (`types/goals.ts`); `Obligation` is in
`types/agent.ts`. See those files for the authoritative field lists.

### Bounds (the freeze backstop), in `PLAN`

```
maxDepth      = 5    // backward-chaining recursion cap
maxFrontier   = 64   // best-first frontier cap (guards search blowup)
maxPlan       = 8    // emitted step-sequence cap
travelPerMetre= 0.08 // believed distance → cost
actBase       = 1    // flat cost of a non-travel primitive
routeRisk     = 6    // cost added per believed-hostile near the route
riskRange     = 12   // how near a hostile must be to count
partialCooldown = 12 // sim-seconds an unreachable threshold goal rests (also QUANTITY.partialCooldown)
```

---

## 3. The planner core — backward chaining

The only authored entities are `PRIMITIVES`. A goal is `{ atoms: SubAtom[] }`. The solver:
finds a primitive whose **effect unifies** with an open atom, pushes its **unmet preconditions**
as fresh subgoals, recurses, and keeps the **min-cost** feasible ordered step list (or `null`).

### 3.1 `atomHolds(atom, agent, ctx)` — believed-state predicate

Tests one atom against **live believed state** (own inventory/gold/needs/beliefs). Belief-only.

```
atomHolds(atom, agent, ctx):
  switch atom.pred:
    at:        tp = believedPos(agent, ctx, atom.place); return tp && dist(agent.pos, tp) <= arriveDist
    have:      return agent.inventory[atom.good] >= atom.n
    gold_ge:   return agent.gold >= atom.amt
    received:  return false                       // only an explicit transfer THIS plan satisfies it
    dead:      return believedDead(agent, atom.subjectId)   // _slain bridge OR no belief entry at all
    in_reach:  b = agent.beliefs.get(atom.subjectId); return b.conf>0 && dist(agent.pos, b.lastPos) <= 2.2
    know_assoc:b = agent.beliefs.get(atom.subjectId); return !!(b && b.assoc)
    need_ge:   return agent.needs[atom.need] >= atom.level
    know:      return knowsTopic(agent, atom.topic)         // §6
    hold_until:return atom.cond ? atomHolds(atom.cond, …) : true   // window already open ⇒ no wait
    force_ge:  return RECRUIT.selfStrength >= atom.amt      // a lone agent's LIVE force is just its own
    freed/wrecked: return false                  // only an explicit free/wreck THIS plan satisfies it
    default:   return false
```

> **`believedDead`** is the epistemic-split replacement for every `o.alive` read: true when the
> `_slain` combat-bridge marked it (the sanctioned out-of-sight death signal) **or** the agent holds
> *no belief entry at all*. A quarry merely fled out of sight still has a (faded) entry → not dead.
> Test belief **absence**, never low confidence.

### 3.2 `solveAtom` — solve one open atom

```
solveAtom(agent, ctx, atom, depth, frontier, simState) -> Solved | null:
  if depth > maxDepth: return null
  if frontier.n > maxFrontier: return null
  frontier.n++

  if atomSatisfied(atom, agent, ctx, simState): return { steps: [], cost: 0 }   // §3.4

  // ── threshold composition intercept — these COMPOSE many steps toward a number ──
  if atom.pred=='gold_ge' and atom.subjectId==null:    return composeGold(…)     // §5.1
  if atom.pred=='need_ge':                             return composeNeed(…)     // §5.2
  if atom.pred=='force_ge':                            return composeForce(…)    // §5.3

  // ── generic backward-chain over every primitive ──
  best = null
  for prim in PRIMITIVES:
    bind = prim.effectMatches(atom, null, agent)
    if !bind: continue                              // this primitive can't produce this effect
    if !effectAdvances(prim, atom, bind, …): continue   // no-op guard (§3.5)

    next = clone(simState); applyEffect(prim, bind, agent, next)   // simulate its effect (§3.4)
    pre  = prim.precondition(agent, ctx, bind)
    pre  = pre.flatMap(p -> p.pred=='in_reach' ? [Atom.at({subjectId:p.subjectId})] : [p])
    sub  = solveAll(agent, ctx, pre, depth+1, frontier, next)      // recurse on preconditions
    if !sub: continue

    stepCost = prim.cost(agent, ctx, bind)
    if !finite(stepCost): continue                  // unreachable place / unknown price
    cost  = stepCost + sub.cost
    steps = [...sub.steps, { prim: prim.name, bind, exec: prim.exec }]   // step appended AFTER its preconds
    if steps.length > maxPlan: continue
    if !best or cost < best.cost: best = { steps, cost }
  return best
```

### 3.3 `solveAll` — solve a list in order, threading state

```
solveAll(agent, ctx, atoms, depth, frontier, simState) -> Solved | null:
  state = simState; steps = []; cost = 0
  for atom in atoms:
    r = solveAtom(agent, ctx, atom, depth, frontier, state)
    if !r: return null
    steps += r.steps; cost += r.cost
    state = applyStepsForward(agent, state, r.steps)   // re-simulate so the NEXT atom sees the effects
  return { steps, cost }
```

### 3.4 Forward simulation — `SimState`, `applyEffect`, `atomSatisfied`

The solver threads a **cloned** believed-state forward so a later precondition can be met by an
earlier step's effect (buy needs gold a sell produced; give needs a good a gather produced).

```
applyEffect(prim, bind, agent, s):   // mutate the cloned SimState by this step's believed effect
  goto/approach: s.at = bind.place
  gather/produce:s.inv[bind.good] += bind.n
  buy:           s.inv[bind.good] += bind.n; s.gold -= bind.price*bind.n
  sell:          s.inv[bind.good] -= 1;      s.gold += bind.price
  give:          s.inv[bind.item] -= bind.n; s.received[bind.to] = true
  pay:           s.gold -= bind.amt;         s.received[bind.to] = true
  consume:       s.inv[bind.item] -= 1
  loot:          s.gold += 1
  shadow:        s.knownAssoc[bind.target] = true
  burgle/rob:    s.gold += bind.amt                 // MOVED from the source (conserved at exec)
  observe/ask/study: s.known[topicKey(bind.topic)] = true
  hold:          s.held[holdKey(bind.cond)] = true  // reason THROUGH the wait optimistically
  recruit:       s.force += bind.amt                // compliance-weighted believed strength
  free:          s.freed[bind.target] = true
  wreck:         s.wrecked[bind.target] = true

atomSatisfied(atom, agent, ctx, s):  // satisfied in real state + planned effects?
  reads s.* first, falling back to atomHolds(atom) for preds the sim doesn't track.
  e.g. at:        placesEqual(s.at, atom.place) || atomHolds(atom)
       gold_ge:   s.gold >= atom.amt
       know:      s.known[topicKey(atom.topic)] || atomHolds(atom)
       freed:     s.freed[atom.subjectId]
```

> **Important subtlety:** `received`/`freed`/`wrecked`/`force_ge`/`hold_until` are *a-priori unmet*
> in `atomHolds` (return false / self-strength) — only an explicit step in **this** plan satisfies
> them, tracked in `SimState`. This is what makes `repay`/`free`/`muster` always emit their step.

### 3.5 `effectAdvances` — the no-op guard

Stops the solver looping (e.g. "sell to raise gold we already have"). Pure, reads `SimState`.

```
effectAdvances(prim, atom, bind, …):
  gold_ge:  if s.gold >= atom.amt: false; else prim.name in {sell,loot,burgle,rob}
  at:       prim.name in {goto, approach}
  received: prim.name in {give, pay}
  dead:     prim.name == attack
  know_assoc:if atomHolds(atom): false (gossip supplied it); else prim.name==shadow
  know:     if atomHolds(atom): false; else prim.name in {observe,ask,study}
  hold_until:if atomHolds(atom): false (window open); else prim.name==hold
  force_ge: if s.force>=atom.amt: false; else prim.name==recruit
  freed:    prim.name==free;  wrecked: prim.name==wreck
  have:     true;  default: true
```

### 3.6 `plan(agent, goal, ctx)` — the public entry

```
plan(agent, goal, ctx) -> Plan | null:
  atoms = goal.atoms ?? (goal.atom ? [goal.atom] : null)
  if !atoms.length: return null
  try:
    frontier = { n: 0 }
    if agent.personality:                                           // drive-scaled WIDEN (§5, §15)
      frontier.widen = agent.personality.risk_tolerance >= QUANTITY.widenRiskTol
    r = solveAll(agent, ctx, atoms, depth=0, frontier, initState(agent))
    partial = !!frontier.partial                                    // set ONLY by a composer
    trace.note(PLAN, r ? PLAN_FOUND : PLAN_FAILED, …)               // write-only
    if !r: return null
    if !r.steps.length and !partial: return null                    // truly nothing to do
    out = { steps: r.steps, cost: r.cost }
    if partial: out.partial = true; out.shortfall = frontier.shortfall
    return out
  catch: return null                                                // NEVER throw on the tick
```

> `frontier.partial` is set by any composer that satisfices (`composeGold`/`composeNeed`/
> `composeForce`); `plan()` reads it raw to mark the result partial.

---

## 4. Execution loop — running a plan, advancing, popping

`execPlanStep` (act.ts, every frame) runs the current step, advances the pointer when the step's
**effect lands**, and pops the goal when its **predicate** holds.

```
execPlanStep(a, dt, ctx):
  goal = a.goals.top()
  step = a.goal.step    // decide() injects the candidate PlanStep onto the committed 'plan' goal
  if !goal or !step: a.fighter.setMoving(0); return
  try:
    execPrimitive(a, step, dt, ctx)                               // run the verb
    if stepEffectHolds(a, ctx, step) and goal.plan:               // effect landed?
      ptr = goal.step (numeric) ?? 0
      if goal.plan.steps[ptr] === step: goal.step = ptr + 1       // advance only if still on it
    if goal.predicate(a, ctx):                                    // goal complete?
      a.goals.pop()
      a.memory.record({ kind: goal.kind=='avenge'?'triumph':'closure', withId: goal.subjectId, … })
      awardGoalClosureXP(a, goal, …)
  catch: a.fighter.setMoving(0)

execPrimitive(a, step, dt, ctx):                                   // VERBS ARE DATA
  verb = step.exec ? step.exec.verb : step.prim
  if !runExecutor(verb, a, step, dt, ctx): a.fighter.setMoving(0)  // unknown verb idles
```

`stepEffectHolds` consults the **registry first** (a feature's own effect-landed predicate), then a
base switch:

```
stepEffectHolds(a, ctx, step):
  reg = effectHolds(step.prim, a, ctx, step)   // registry — feature verbs advance from their own file
  if reg !== undefined: return reg
  switch step.prim:                            // base verbs
    goto:            atomHolds(Atom.at(bind.place))
    gather/produce/buy: agent.inventory[bind.good] >= bind.n
    sell/consume/loot: true                    // single tick suffices; goal predicate guards the loop
    give/pay:        a._repaid[bind.to]         // set by the give/pay executor
    attack:          believedDead(a, bind.target)
    hold:            bind.cond ? atomHolds(bind.cond) : true   // advance when the window opens
    default:         false
```

`stepPrecondsHold(a, ctx, step)` re-tests a step's preconditions against **live** believed state
(not the forward sim) so a step that lost its footing (market emptied, target moved) triggers a
replan. Used by `decide`.

---

## 5. Phase 1 — numeric-threshold composition

A `gold_ge`/`need_ge`/`force_ge` atom does **not** emit a single advancing step — it **composes**
several acquisitions toward the target, greedily, over the handful of believed sources the agent
knows of. This is the one place the planner spends more than one step on a single numeric atom.
Always-live at the `solveAtom` intercept (gold/need via `QUANTITY`'s tuning, force via `RECRUIT`'s).

### The satisfice / widen / cooldown contract (read this before any composer)

The unreachable target is the **common case**, not an edge. A composer must:

1. **Greedy fill** — add the best believed yield-for-cost source, then the next, until the believed
   total crosses the target.
2. **Widen** (`frontier.widen`) — a bold/hard-driven agent taps riskier sources it would otherwise
   pass over (sells into the keep reserve, acts on thinner leads). Set in `plan()` from
   `personality.risk_tolerance >= QUANTITY.widenRiskTol`.
3. **Satisfice vs infeasible — the depth rule** (the bug that surfaced when QUANTITY went live):
   - At **depth 0** (the goal's own atom): if the target can't be reached, set
     `frontier.partial = true; frontier.shortfall = …` and return the **best partial plan**
     (earn what you can). `plan()` returns it marked; the goal layer runs it then **cools the goal
     down** (`goal._cooldownUntil = now + PLAN.partialCooldown`) so it isn't re-attempted every tick.
   - At **depth > 0** (a sub-precondition, e.g. the gold a `buy` needs): an unreachable threshold is
     **`null` (infeasible)**, so the branch that needs it loses to one that can actually be met. A
     0-cost empty "satisfice" here would make an unaffordable `buy` look free and beat `gather`.

   Encapsulated as `shortOrNull(depth, frontier, shortfall)`: `depth>0 → null`; else flag partial,
   return `{steps:[], cost:0}`.

### 5.1 `composeGold` — sell surplus toward a gold target

```
composeGold(agent, ctx, atom, depth, frontier, s) -> Solved | null:
  target = atom.amt; gold = s.gold
  if gold >= target: return { steps:[], cost:0 }
  marketCost = travelCost(agent, ctx, MARKET)             // ∞ if no believed market
  sources = []
  for c in COMMODITIES:
    price = believedPrice(agent, c); if price==null: continue
    reserve = frontier.widen ? 0 : ECON.keep[c]           // WIDEN sells into the reserve
    units = floor(s.inv[c] - reserve); if units>0: sources.push({c, price, units})
  sources.sort(by price desc)                              // best yield per uniform sell-cost first
  steps=[]; cost=0
  for src in sources:
    if gold>=target or steps.length>=maxPlan-1: break
    need = ceil((target-gold)/src.price); n = min(src.units, need)
    steps.push(sellStep(src.c, src.price, n))              // ONE batched sell of n units (yield price*n)
    cost += actBase; gold += src.price*n
  if steps.length and finite(marketCost): steps.unshift(gotoStep(MARKET)); cost += marketCost
  else if steps.length: steps=[]; gold=s.gold             // market unreachable ⇒ pure shortfall
  if gold < target:
    if depth>0: return null                                // infeasible as a sub-precond
    frontier.partial=true; frontier.shortfall=target-gold  // satisfice at the goal's own atom
  return { steps, cost }
```

> **Gotcha:** batch the sell into **one** step of `n` units (yield `price*n`), not `n` per-unit
> steps — per-unit sells blow the `maxPlan=8` cap.

### 5.2 `composeNeed` — eat toward a graded need

```
composeNeed(agent, ctx, atom, depth, frontier, s):
  need = atom.need ?? 'hunger'; level = atom.level
  cur = s.need[need] ?? agent.needs[need]
  if cur >= level: return { steps:[], cost:0 }
  if need != 'hunger': return shortOrNull(depth, frontier, level-cur)   // only hunger has a meal channel yet
  meals = clamp(ceil((level-cur)/QUANTITY.needMeal), 1, maxPlan-1)
  acquire = solveAll(agent, ctx, [Atom.have('food', meals)], depth+1, frontier, s)  // generic acquire
  if !acquire: return shortOrNull(depth, frontier, level-cur)
  steps = [...acquire.steps]; cost = acquire.cost
  repeat meals times (bounded by maxPlan): steps.push(consumeStep('food')); cost += actBase
  return { steps, cost }
```

### 5.3 `composeForce` — recruit toward a believed force (Phase 5)

```
composeForce(agent, ctx, atom, depth, frontier, s):
  target = atom.amt; force = s.force ?? RECRUIT.selfStrength
  if force >= target: return { steps:[], cost:0 }
  cands = []
  for b in agent.beliefs.all():                            // BELIEF-ONLY — never the roster
    if b.confidence < SIM.actOnBeliefMin: continue
    if b.hostile or considerHostile(b): continue           // not a foe
    if b.standing < RECRUIT.minStanding: continue          // disposed enough to ask
    contrib = RECRUIT.candidateStrength * complianceOf(b.standing)   // §12
    if contrib < RECRUIT.minCompliance: continue
    cands.push({ id: b.subjectId, contrib })
  cands.sort(by contrib desc)                              // cheapest RELIABLE force first
  steps=[]; cost=0
  for c in cands:
    if force>=target or steps.length>=maxPlan-1: break
    d = dist(agent.pos, believedPos(c.id)) ?? 30
    steps.push(recruitStep(c.id, c.contrib)); cost += d*travelPerMetre + actBase; force += c.contrib
  if force < target:
    if depth>0: return null
    frontier.partial=true; frontier.shortfall=target-force
  return { steps, cost }
```

> The leader **over-counts exactly when its read of a candidate's standing is wrong** — the muster
> can fall short at execution, which is the whole point. `force_ge.atomHolds` returns
> `RECRUIT.selfStrength >= amt` (a lone agent), so a real party reaching strength is an execution
> mechanic (`goalMuster.predicate` is `false` — only the live party satisfies it).

---

## 6. Phase 2 — the knowledge model

`Know(topic)` is a requirement like `Have`/`At`. A **topic** is a proposition with a **home**:

| topic `kind` | home (the field `topicConfidence` reads) |
| --- | --- |
| `loc` (a stash, by `subjectId`) | `agent.beliefs.get(subjectId).assoc.conf` |
| `whereabouts` | `agent.beliefs.get(subjectId).confidence` |
| `price` (by `good`) | `agent.priceBeliefs[good] > 0 ? 1 : 0` (no per-good conf yet) |
| `recipe` (by `good`) | `agent.recipes.has(good) ? 1 : 0` (binary today) |
| `strength` (by `place`) | `agent._strengthBelief.get(place).conf` |
| `secret` (by `subjectId`) | `agent._secretBelief.get(subjectId).conf` |

```
topicKey(t)        = `${t.kind}:${t.subjectId??''}:${t.place??''}:${t.good??''}`   // stable map key
topicConfidence(a,t)= read t's home field above (0 when unknown)                    // own-state only
knowsTopic(a,t)    = topicConfidence(a,t) >= KNOW.minConf                            // present AND confident

// COST-INCLUDES-CONFIDENCE — the one place confidence feeds back into a decision.
confidenceSurcharge(a, t):
  return max(0, 1 - topicConfidence(a,t)) * KNOW.confCostScale   // a guess inflates the cost (sure ⇒ 0)
```

The three write channels are primitives (no precondition for observe/ask — the watch *is* the
acquisition):

```
observe(topic): cost KNOW.observeCost   // first-hand, slow, trusted; serves ANY topic (subsumes shadow)
ask(topic):     cost KNOW.askCost        // told; cheap, vaguer, tips the subject off; loc/whereabouts/price only
study(topic):   cost KNOW.studyTuition   // taught; pre: gold>=tuition + at(market); recipes only
```

> **The four fields every fact carries** — value, confidence, provenance (retelling-depth), and
> last-updated time — already exist on the belief table for facts about others. The recipe set **was
> the gap** (a binary `Set`); now **always-live** (`js/sim/recipeKnow.ts`): a
> per-recipe `{conf, hops, t}` map backs the Set so recipes are graded knowledge — half-learned from
> a brief teacher, forgotten when not practised (so a craft dies out once its last practising holder
> stops). The `learning` feature owns it. Reading/writing/fading reuse the same evidence-accrual
> (study/observe push conf up via `learnRecipe`; `forgetTick` fades the unpractised; the Set is the
> craftable view at `craftMinConf`).

### One-level `Believes` (Phase 5)

`I believe subject believes <topicKey>`, at a confidence. Own-state, lazily created, **capped at one
level** (no "I believe you believe I believe…").

```
believesKey(subjectId, topicKey) = `${subjectId}:${topicKey}`
recordBelieves(a, subjectId, topicKey, conf): a._theyBelieve.set(key, { conf: clamp01(conf) })
believesConf (a, subjectId, topicKey):        return a._theyBelieve.get(key)?.conf ?? 0
```

---

## 7. Verbs are data — the three registries

`js/sim/exec/registry.ts`. The verb→executor binding is a **map**, dispatched by lookup. Adding a
behaviour = registering a row from a feature's own file; no shared `switch` is ever edited.

```
EXECUTORS:    Record<verb, (a, step, dt, ctx) => void>   // world-interaction on arrival (ground truth)
DERIVERS:     Array<(a, ctx) => void>                    // belief→goal, run each cognition tick
EFFECT_HOLDS: Record<verb, (a, ctx, step) => boolean>    // "has this step's effect landed?"

registerExecutor(verb, fn)   // last writer wins per verb; guards a bad arg
runExecutor(verb, a, step, dt, ctx) -> boolean   // unknown verb → false (caller idles); try/catch → false
registerDeriver(fn)          // dedups; appended to DERIVERS
runDerivers(a, ctx)          // runs each, INDEPENDENTLY guarded (one fault never blocks another)
registerEffectHolds(verb, fn)
effectHolds(verb, a, ctx, step) -> boolean | undefined   // undefined = no row (caller falls back)
```

Base verbs are registered in `act.ts` at module load (`goto`/`gather`/`produce`/`buy`/`sell`/
`give`/`pay`/`consume`/`attack`/`hold`). Feature verbs register from their feature file (§13).

---

## 8. The resolver — generic mechanics, emergent consequences

`ctx.resolver` (built in `simulation.ts`) is the **execution** half: it touches ground truth. The
rule (see the `emergent-consequences` design note): **keep the mechanic and the consequence
separate, and let the consequence emerge.** A "moved" acquire is ONE generic conserved transfer;
the social meaning is the acquire row's `socialTrace` **data**; the souring **emerges** from
perception, per-perceiver, witness-gated.

```
// CONSERVED TAKE — the one mechanic behind loot/burgle/rob/take. Debits source, credits taker.
// NO baked reaction. Caller gates location (at the stash / on the mark / at the corpse).
take(a, sourceId, { gold?, item?, n? }) -> amountMoved:
  src = agentsById.get(sourceId); if !src: return 0
  if gold: got = min(gold, src.gold); src.gold -= got; a.gold += got; return got
  if item: got = min(n, src.inventory[item]); src.inventory[item] -= got; a.inventory[item] += got; return got

// EMERGENT CONSEQUENCE — mirrors onCombatEvents' fold. The wrong sours the VICTIM and every
// bystander who can SEE the actor, each through ITS OWN belief, scaled by ITS OWN relationship.
witnessDeed(actor, victimId, kind, severity=0.4):
  victim = agentsById.get(victimId)
  if victim within visionRange of actor:                 // WITNESS-GATED (unseen ⇒ no suspicion)
    rel = victim.beliefs.get(actor.id) ?? victim.beliefs.observe(actor.id, …)
    betrayal = 1 + max(0, rel.standing)                  // valued-then-wronged stings more
    rel.standing  -= severity * betrayal
    rel.suspicion += severity
  for w in agents where w sees actor and w != actor,victim:
    w.beliefs.get(actor.id).suspicion += severity * 0.5  // bystanders, lighter
  busEmit({ actorId: actor.id, verb: kind, tags:['THEFT','RISK'], magnitude: severity })  // feeds emergent class

// PHYSICAL AFFECT — the physical change only (like combat resolving health). Reaction emerges.
affect(actor, targetId, state) -> boolean:
  t = agentsById.get(targetId)
  if state=='freed':  t._held=false; t._freedBy=actor.id; return true   // captive's gratitude EMERGES from _freedBy
  if state=='wrecked':t._wrecked=true; return true

deliverTo(from, toId, { item?,n? | gold? }) -> boolean  // co-location-gated conserved give/pay; warms receiver
marketClear(a, good, isBuy)                             // conserved clearing vs a real counterparty AT the market
```

> Never write `pilfer(thief, markId, amount)` with a hardcoded `-0.4` on only the mark. That bakes a
> bespoke social function and a single-victim reaction. Use `take` + `witnessDeed` — the social
> trace is data, the reaction is per-perceiver and witness-gated.

---

## 9. Phase 3 — the ACQUIRE table (made vs moved)

Acquire primitives are generated from rows; the row carries the conservation class + social trace
into `exec` (the single source of it).

```
ACQUIRE = [
  { verb:'gather',  source:'node',     made:true,  socialTrace:'honest_labour' },
  { verb:'produce', source:'workshop', made:true,  socialTrace:'craft' },
  { verb:'buy',     source:'market',   made:false, socialTrace:'paid_trade' },
  { verb:'loot',    source:'corpse',   made:false, socialTrace:'none' },
  { verb:'burgle',  source:'cache',    made:false, socialTrace:'theft' },
  { verb:'rob',     source:'person',   made:false, socialTrace:'robbery' },
]
acquireExec(verb) = { verb, made: row.made, socialTrace: row.socialTrace }   // read off the table, never hand-duplicated
```

> **Made vs moved is a rule, not a label.** `made` rows (gather/produce) create goods from the
> environment + a recipe. `moved` rows relocate existing value: the believed yield comes from the
> **source's** holdings, and the executor **debits the source** as it credits the agent (`take`),
> so the money supply stays closed. A made row and a moved row **cannot be merged**. Any future
> moved row inherits this.

---

## 10. Phase 4 — waiting & deadlines

A `hold` step keeps the agent at a safe/hidden spot, re-checks `cond` each tick, and advances when
`cond` becomes believed-true. It abandons **two ways, and they differ**:

- **Deadline** — `goal.expiresAt` passes (window never opened) → `pruneGoals` drops the goal.
- **Discovered** — the spot stops being safe → the **reactive layer preempts** the held step.
  `decide` already scores `flee` over a plan step when a believed threat appears, so a believed
  threat mid-hold fires the same flee any agent would, dropping/suspending the plan; the agent
  re-plans from wherever it ends up.

```
hold executor (act.ts):                          // already registered
  tp = stepTargetPos(a, ctx, step.bind.place)
  if tp and dist(a.pos, tp) > arriveDist: steer(a, {attractors:[{pos:tp}]}, dt)   // walk to cover
  else: a.fighter.setMoving(0)                                                     // wait
hold effect-holds: bind.cond ? atomHolds(bind.cond) : true     // advance when the window opens
```

The plan reasons **through** the wait optimistically (`applyEffect` sets `s.held[…]`), so downstream
steps are planned; execution actually waits or abandons. Rescue shape: `goto vantage → observe camp
→ hold-until Strength drops → go → free`.

> **Recurrence is NOT a plan step.** A plan is a one-shot ordered list with at most a deadline. A
> thing that *repeats* (a seasonal debt, a nightly patrol) is re-derived from the **obligation
> ledger** (§11) each time it comes due.

---

## 11. The obligation ledger (the one new store)

`js/sim/obligations.ts`. A small per-agent store of standing **intentions**, each a `(trigger,
deferred action, counterparty, expiry)`, checked against perception each tick. Structurally a
little belief table with decay; bounded by `LEDGER.max`. It absorbs the two things pushed out of the
one-shot plan.

```
Obligation = { trigger: 'time'|<perceived-event>, action: <deferred goal kind>,
               counterparty?: EntityId, dueAt?: number /*time triggers*/, expiry: number }

key(o)        = `${o.trigger}:${o.action}:${o.counterparty??''}`     // dedup identity
triggerKey(o) = `${o.trigger}:${o.counterparty??''}`                 // perception fires against this

addObligation(agent, obl):                       // arm; dedups by key; bounded (oldest dropped)
  agent._obligations ??= []
  if agent._obligations.some(o => key(o)==key(obl)): return
  agent._obligations.push(obl); while length > LEDGER.max: shift()

// THE PER-TICK SETTLE — discharge fired, drop lapsed, keep the rest. Returns the FIRED obligations.
settleObligations(agent, firedTriggers: Set<string>, now) -> Obligation[]:
  fired = []
  agent._obligations = agent._obligations.filter(o ->
    if o.trigger=='time' and now>=o.dueAt:     fired.push(o); return false   // RECURRENCE
    if firedTriggers.has(triggerKey(o)):       fired.push(o); return false   // COMMITMENT
    if now>=o.expiry: return false                                           // LAPSE
    return true)
  return fired
```

> **Why a commitment can't just be a hold-until step:** *lifetime*. A hold-until wait lives and dies
> inside one plan (drop the plan on the next re-plan, the wait is gone). A ledger entry **outlives
> every plan** between promising and keeping — so the persistent thing sits *outside* any plan.
>
> **Reciprocity does NOT use the ledger.** "I owe her one" is a scalar on my belief about her (a
> relational field like standing); a large enough debt **generates a `repay` goal of its own** (the
> planner already has `goalRepay`). The line is *what it waits on*: reciprocity is a standing
> magnitude the agent acts on of its own accord (no armed trigger); a commitment is armed for a
> **specific perceived event** ("you deliver → I pay") — and arming/persisting that trigger is what
> the ledger is for.

---

## 12. Phase 5 — the recruiter, both ends

The hardest path; walking both ends cleanly is the strongest evidence the architecture holds.

**Leader side (prediction).** `recruit` is an acquisition feeding `force_ge` via `composeForce`
(§5.3). Its effect is **not** "+1 to my force" — it is a **belief**: *I believe this candidate will
follow*, at a **compliance** confidence read off the cue the leader can see (the candidate's
standing). `recruit.effectMatches` returns `null` (composeForce is the authority for `force_ge`); the
primitive exists only so `byName('recruit')` resolves for the forward-state recompute and carries the
verb.

```
complianceOf(standing) = clamp01(0.5 + 0.5*standing)   // loyal friend high, wary stranger low
```

**Follower side (independent decision).** `recruit` does **not** write a goal into the candidate
(that's the forbidden foreign-mind write). It is an **`Inform`**: the executor makes an *offer* the
candidate perceives (a share, a role, an appeal to standing) + `recordBelieves` on the leader's side.
What happens next is the candidate's **own** motivation — a deriver weighs the believed payoff
against believed risk, tilted by standing toward the leader, and (if favourable) forms its **own**
join goal (the reputation-gated party-join the sim already has, with a risk/reward weighing on top).

> The failure now has a mechanism at **both** ends: no-shows didn't roll low — they **re-planned**
> (their own scout-gossip put the camp higher, a better opportunity won, a fear preempted), and the
> leader, unable to see those internals, over-counted. Hence a careful leader prefers four certain
> followers to eight doubtful ones, and one who can raise the believed payoff recruits more reliably.

**Affect rows** (`free`/`wreck`) are trivial final acts gated by a hard requirement (`in_reach`,
and in the full rescue *unopposed*, supplied by the hold-until on camp strength). They plan against a
**believed** physical state and are as exposed to being wrong as a raid on a moved cache. Goals:
`goalFree`/`goalWreck` (predicate external — confirmed by perception). Executors call
`resolver.affect`.

---

## 13. The feature-module pattern

Each action-grammar feature is **one file** in `js/sim/features/` + **one test suite**, registering
its verbs/derivers/effect-holds as an import **side-effect**, always-live (no per-feature flag).
Disjoint by construction — a feature touches no shared code, which is what let the phases be built in
parallel worktrees. `js/sim/features/index.ts` imports them all; `simulation.ts` imports the index once.

```ts
// js/sim/features/index.ts
import './urchin.js'; import './learning.js'; import './recruiter.js';
import './affect.js'; import './ledger.js';
export {};
```

**Skeleton every feature follows:**

```ts
import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
import { goalX } from '../planner.js';
import { FLAG } from '../simconfig.js';   // tuning fields only — no on/off switch

// Registration is unconditional (always-live; gating is by branch). The verb/deriver/effect-holds
// rows are registered as an import side-effect.
registerExecutor('verb', (a, step, dt, ctx) => { /* world-interaction; MAY read truth via ctx.resolver */ });
registerDeriver((a, ctx) => { /* belief/own-state ONLY → a.pushGoal(goalX(...)) */ });
registerEffectHolds('verb', (a, ctx, step) => /* believed test the step's effect landed */);
```

> **DERIVERS are cognition** — belief/own-state only (epistemic split). **EXECUTORS are execution**
> — may read truth, but only through `ctx.resolver` (so conservation holds). Pick targets/roles from
> **belief cues + personality** (an emergent wealth estimate, an emergent disposition), never a
> hardcoded role.

### Per-feature pseudocode

**`urchin.ts`** (flagship heist; `URCHIN` tuning). Verbs `surveil`/`approach`/`burgle`:

```
surveil(a, step):  walk toward the believed mark at standoff; on enough watching,
                   a.beliefs.get(markId).recordAssocSighting('stash', pos, conf)
approach(a, step): steer to the believed assoc (stash) pos
burgle(a, step):   when at the stash: ctx.resolver.take(a, markId, { gold: believedHaul })
                   then ctx.resolver.witnessDeed(a, markId, 'theft')   // reaction EMERGES; don't hardcode
deriver:           a poor/despised agent with a believed-rich mark → a.pushGoal(goalSteal(markId, target))
                   (mark + believedHaul from CUES on the belief — an emergent wealth estimate; §16)
effect-holds:      surveil → knows the stash (assoc present); burgle → gold raised
```

**`learning.ts`** (`KNOW` tuning). Verbs `observe`/`ask`/`study`:

```
observe(topic): watch first-hand; accrue evidence into the topic's home (recipe/whereabouts/…)
ask(topic):     be told by a nearby holder (gossip-style, lower confidence)
study(topic):   at a teacher/market, pay tuition via the market resolver; add the recipe to a.recipes
deriver:        a producer wanting a good whose recipe it lacks → a.pushGoal(goalLearn({kind:'recipe', good}))
effect-holds:   observe/ask/study → knowsTopic(a, topic)
ALSO: upgrade a.recipes from a binary Set to the four-field graded knowledge (the recipe lifecycle)
```

**`recruiter.ts`** (`RECRUIT`/`WARBAND` tuning). Verb `recruit` + both ends:

```
recruit(candidate): approach; on reach, make the OFFER the candidate perceives + recordBelieves(leader, …)
deriver (leader):   believes a camp too strong to face alone → a.pushGoal(goalMuster(strength))
deriver (follower): a candidate perceiving a good-enough offer forms its OWN join goal (reuse Party)
effect-holds:       recruit → the offer landed
NO foreign-mind write: recruit is an Inform; the follower decides for itself.
```

**`affect.ts`** (`ROB`/`CAPTIVE` tuning; rob/free/wreck always-live). Verbs `rob`/`free`/`wreck`:

```
rob(mark):     approach; on reach, ctx.resolver.take(a, markId, { gold: believedHaul })
               then ctx.resolver.witnessDeed(a, markId, 'robbery')   // EMERGES
free(captive): approach; on reach, ctx.resolver.affect(a, captiveId, 'freed')   // gratitude EMERGES from _freedBy
wreck(target): approach; on reach, ctx.resolver.affect(a, targetId, 'wrecked')
derivers:      e.g. a rescuer believing a friend is held → a.pushGoal(goalFree(captiveId))
effect-holds:  rob → gold raised; free → captive believed freed; wreck → target believed wrecked
```

**`ledger.ts`** (`LEDGER` tuning). Wires `obligations.ts` into the tick:

```
producer:    arm a commitment when a promise is made (a credit deal, a vow) → addObligation(a, {…})
per-tick:    fired = settleObligations(a, firedTriggersFromPerception(a), now)
             for o in fired: a.pushGoal(deferredGoalFor(o))   // a fired "pay when delivered" → repay/pay goal
recurrence:  a seasonal debt re-armed each time its time-trigger fires (re-addObligation with next dueAt)
reads:       OWN perception/beliefs only (epistemic split)
```

---

## 14. Goal derivation & personality

`deriveGoals` (motivation.ts) runs `runDerivers(a, ctx)` first (feature derivers as data rows), then
the built-in episode→goal table (assaulted→avenge, windfall→seek_fortune, succoured→repay,
witnessed_death→grieve(+avenge), relic→delve). Every derived goal gets `priority`, `from`, and an
`expiresAt`. `pushGoal` dedups by `(kind, subject/place)` so re-scanning a memory is idempotent.

**Personality weights the machinery already here, at three points** (it adds no actions/effects — a
small fixed innate vector, partly inherited):

1. **What you want** — derivers weight goal formation: the ambitious form wealth/renown goals sooner;
   the sociable reach for belonging; the curious observe/explore; the kind form help-goals.
2. **What you'll pay/risk** — `risk_tolerance` re-weights `cost` (discounts danger/uncertainty
   penalties; sets how far the failure path widens — `frontier.widen`). `altruism` discounts the
   cost of give/help.
3. **What you'll consider** — some goals are **gated by disposition**: a scrupulous agent's derivers
   never produce theft/coercion even when broke and able; a larcenous one reaches for them. This is
   what stops "everyone turns thief when money is tight."

---

## 15. Acting under uncertainty — the wealth-cue estimate

A believed quantity that can never be observed (the gold inside a cache) is an **expected value with
a confidence**, inferred from proxies. Formed by the **same evidence-accrual** that builds every
other belief, anchored on a prior. **Always-live** (`estimateHaul` in `planner.ts`, `ESTIMATE`
tuning): a faction-category prior (`b.lastFaction`) nudged by the cues on
the agent's OWN belief — how established the mark is (`b.confidence`), a SEEN stash (`b.assoc`),
believed fame (`b.notoriety`) — each firming the confidence via `firmUp(c,w)=c+(1-c)w`. The urchin
deriver targets the believed-richest mark (`value × confidence`) and aims the goal for the estimate;
`haulSurcharge` folds the confidence into the burgle/rob cost so a hazy guess cases longer (the flat
`URCHIN.deriveTarget` fallback is gone):

```
estimateHaul(agent, markId):
  prior = baselineForCategory(believedCategory(markId))   // "a merchant is worth ~X", low confidence
  est = prior; conf = lowPrior
  for cue in perceivedWealthCues(markId):                 // a fat trade SEEN, a guarded house, gossip "he's rich"
    est  = nudge(est, cue.implies)                        // shift toward what the cue implies
    conf = firmUp(conf, cue.weight)                       // first-hand counts more than heard
  return { value: est, confidence: conf }                 // value/conf/provenance/decay, like any belief
```

Every input is itself a belief (the agent acts on what it *thinks* it saw, never the real ledger), so
it stays in belief-space. The two levers that carry it are already in the design:
`confidenceSurcharge` (a hazy estimate makes the heist *expensive* → case longer) and `risk_tolerance`
(the appetite for the spread). The estimate is **wrong precisely when the cues mislead** — a flashy
merchant who banks everything reads fat and yields an empty cache. That is the only fairness it's owed.

---

## 16. Scale — the planning budget (future ceiling)

A plan is ~3 µs; threshold composition adds a small pass → low tens of µs. The hard case is the
**burst** (40 traders who heard the same price rumour all find it stale and re-plan the same tick),
which survives because per-plan cost is **capped**: population × per-plan ≈ 3 ms at ~250 agents.

Beyond that, a **per-tick planning budget** (not yet built; a ceiling, not the normal path):

```
plannerQueue: priority queue (urgency × nearness)
each tick: pop up to PLAN_BUDGET agents wanting to (re)plan; the rest spill to the next few ticks
```

The give is **latency** (a low-priority off-screen agent reacts a tick or two late); the world stays
**correct** — conserved quantities are maintained by the market/physics passes every tick (never
thinned). "Thinned" means *deliberates less often*, never *goes dark*. The harness gates
reasoning-cost-per-agent-per-tick to stay flat as population grows.

---

## 17. The gating discipline — gating is by branch, not by in-code flags

> **Status update.** The action grammar was *built* phase-by-phase behind day-one-OFF
> `enabled`/`graded` flags so each commit left the long-running soak byte-identical. That scaffolding
> is **removed**: the decision is **gating is done by branch, not by an in-code flag.** Every feature
> below is now **always-live on the mainline** — there is no `enabled`/`graded` field in its config
> block and no "off path" / fallback branch. The config blocks keep only their **tuning** fields. The
> table is kept as the as-built map of *what each former flag gated* (now unconditional code).

The remaining discipline:

- each change leaves `bunx tsc --noEmit && bunx tsc` clean and `bun test/headless.mjs` green;
- a primitive's `effectMatches` matches on its predicate alone (no flag term); the planner emits its
  steps whenever the subgoal fits;
- `confidenceSurcharge` / `haulSurcharge` always compute (a confident fact still surcharges 0);
- shared types are re-exported from the `types/sim.ts` barrel (`KnowTopic`, `Obligation`);
- to gate a feature *out*, do it on a **branch** — do not reintroduce an in-code flag.

| feature (`js/sim/simconfig.ts` block) | phase | gates (now unconditional) |
| --- | --- | --- |
| `QUANTITY` | 1 | the `composeGold`/`composeNeed` intercept + drive-scaled widen |
| `KNOW` | 2 | observe/ask/study rows + `confidenceSurcharge` |
| `ROB` | 3 | the `rob` acquire row |
| `URCHIN` | (2) | shadow/approach/burgle (the urchin heist) |
| `HOLD` | 4 | the `hold` row |
| `RECRUIT` | 5 | the `force_ge` composer + `recruit` row |
| `WARBAND` | 5 | the recruiter follow-through: a warmed candidate's own join-decision deriver + `resolver.joinBand` (NPC marching ally) |
| `AFFECT` | 5 | the `free`/`wreck` rows |
| `CAPTIVE` | 5 | the captivity → rescue TRIGGER: capture-on-defeat + the `captive` belief + the `goalFree` rescue deriver + emergent gratitude (the `free` arc's live payoff) |
| `LEDGER` | 5 | the per-tick ledger arm/settle/discharge wiring |
| `ESTIMATE` | 6 | the wealth-cue haul `estimateHaul` + `haulSurcharge` (the urchin deriver targets the believed-richest mark; the flat `deriveTarget` path is gone) |
| `RECIPES` (graded) | 6 | graded recipe conf (`recipeKnow.ts`: half-learned/forget + `teachRecipe` tuition); the binary-Set fallback is gone |

---

## 18. Testing pattern

Phase tests live in `test/suites/planner.mjs` (`obligations.mjs` for the ledger) plus the per-feature
suites. The features are always-live, so a suite just sets up the agent and asserts directly — no
flag toggle / `finally` restore (a suite that needs a *deterministic* outcome may still pin a
**tuning** field like `CAPTIVE.captureChance = 1`, restoring it in `finally`):

```
function testKnowledge(ok) {
  const a = makeFighter(...);
  const p = plan(a, goalLearn({ kind:'recipe', good:'potion' }), ctx);
  ok(p && p.steps.some(s => s.prim==='study'), 'K1: a recipe goal plans a study step');
  // … K2..K4
}
```

No single-suite CLI flag — to run one, comment the others out of `headless.mjs` or import the suite
into a scratch runner. The `groups` soak is RNG-flaky (passes on re-run).

---

## 19. Current implementation status & the gaps

**The live wiring is implemented and ALWAYS-LIVE on the mainline.** All feature modules in
`js/sim/features/` are built — each registers its executors / derivers / effect-holds as an import
side-effect, disjoint (one file + one test). The full headless suite (typecheck + 12k-tick soak +
every feature suite) is green with every feature live, and the action grammar runs end-to-end through
the real frame loop:

| feature (file) | verbs wired | live deriver |
| --- | --- | --- |
| `urchin.ts` | surveil / approach / burgle | poor + larcenous → `goalSteal` (mark from belief cues) |
| `affect.ts` | rob / free / wreck | rob shares the steal deriver; **free is LIVE** (a liked believed-captive + bold/kind → `goalFree`, via the `CAPTIVE` capture trigger); wreck dormant (no enemy structure entity to target) |
| `learning.ts` | observe / ask / study | a crafter lacking its recipe → `goalLearn` |
| `recruiter.ts` | recruit | bold leader vs strong foe → `goalMuster`; follower warms from a perceived offer + the `WARBAND` join follow-through |
| `ledger.ts` | (no verb — a settle deriver) | a `succoured` memory arms a commitment; meeting the benefactor fires the deferred repay |
| `caution.ts` | (no verb — a plan-outcome handler) | writes the per-strategy surcharge on a watched act's outcome |

Each feature's `test/suites/*.mjs` drives it through the frame loop (heist, robbery, free/wreck,
recipe-learning, the offer + one-level `Believes`, the ledger arm→fire→discharge, the caution burn).
A populated two-town soak with everything live is **stable** — gold conserved, town survives, no
freeze — and produces emergent thievery (see §20).

The seam invariants held all the way through: `take`/`witnessDeed`/`affect`/`makeOffer` are generic
conserved resolver primitives; the social meaning is the row's `socialTrace` data; the souring
**emerges** per-perceiver from `witnessDeed`; `recruit` is an Inform (`makeOffer` + `recordBelieves`),
never a foreign-mind write. One executor gotcha worth recording: **effect-holds is keyed by
`step.prim`, not the exec verb** — so `surveil`'s effect-holds registers under its prim `shadow`.

The **remaining gaps** (each a follow-up; nothing is gated behind a flag any more):

1. ~~**Recipe knowledge is still binary.**~~ **DONE & always-live.** Graded recipes are wired
   (`js/sim/recipeKnow.ts`): `a._recipeKnow` holds per-recipe `{conf,hops,t}`, the
   binary `a.recipes` Set is the *craftable* view (in iff conf ≥ `craftMinConf`), so a recipe is
   **half-learned** below the bar, firmed by repeated study/watching, and **forgotten** if not
   practised (`forgetTick` fades every recipe but the agent's `_trade` — a craft dies out of a town
   once its last practising holder stops). `study` now pays a **conserved tuition** to a co-located
   teacher (`resolver.teachRecipe`). `topicConfidence('recipe')` reads the graded conf. (Tests:
   `learning G1–G4`.)
2. ~~**Wealth-cue estimation is a flat constant**~~ — **DONE & always-live.** `estimateHaul` (§15)
   is wired: the urchin deriver targets the believed-richest mark and aims for the inferred haul,
   and `haulSurcharge` folds the estimate's confidence into the heist cost. A thief's expected haul
   is a belief-cue inference, wrong exactly when the cues mislead. (Tests: `urchin W1–W4`.)
3. ~~**`free`/`wreck` carry no live deriver**~~ — **`free` DONE & always-live** (the captivity →
   rescue arc). The `CAPTIVE` trigger wires it: on a captor-faction (bandit/rival/monster)
   lethal blow against a non-combatant townsperson, the victim is CAPTURED instead of killed —
   revived + `_held` + `_captorId` (EXECUTION, in `combatEvents.ts`); a held captive idles (decide/act
   guards). Perception bridges a seen `_held` to a `captive` flag on the witness's BELIEF; the
   `affect.ts` rescue deriver (belief + own-personality ONLY — a well-liked believed-captive +
   bold/kind disposition) forms `goalFree`; the freed captive's gratitude EMERGES (a per-perceiver
   warmth on its OWN belief about `_freedBy`, the positive mirror of `witnessDeed`). Gold is conserved
   across capture (no death-loot), and the captive never deadlocks the soak.
   (Tests: `affect CAPTIVE CAP1–2 / PER / RES1–3`.) **`wreck` stays dormant** by design: the resolver's
   `affect('wrecked')` operates on `sim.agentsById` (agents), and there is no enemy-owned agent-or-
   percept STRUCTURE carrying a believed position + hostility to target — watchtowers are bare
   emplacements (no id/belief), buildings are non-hostile place-percepts — so a clean `wreck` deriver
   would require inventing a structure-as-roster-entity subsystem (explicitly out of scope; not forced).
4. **NPC war-party formation/following — BUILT & always-live** (`WARBAND` tuning). `recruit`'s
   belief half (offer, prediction, follower belief-shift) was already wired; the follow-through now
   turns a warmed candidate into a marching NPC ally **without a parallel system**. The seam:
   - `Party` is no longer player-only — its leader is whatever Agent the constructor is handed
     (`get leader()` returns it; the player's party is just "the band whose leader is the controlled
     agent", special only for input). The recruit standing gate reads the player-only reputation
     ledger for a player-led band, the candidate's OWN belief-standing for an NPC-led band.
   - A second follower-side **deriver** in `recruiter.ts` (cognition: reads ONLY the follower's own
     `_offers` + its belief-standing toward the offerer + personality — no roster) forms the
     candidate's **own** decision to join, then requests the flag flip through the EXECUTION seam
     `ctx.resolver.joinBand(follower, leaderId, cap)` → `Groups.joinWarband` → the **same** `_join`
     every emergent band uses (flips `inParty`/`bandLeaderId`/`groupType:'warband'`/`partySlot`/
     `combatant`). The existing `decideParty`/`fillFollow`/`enemyNearLeader` path — already
     NPC-leader-aware off belief — marches and fights it. No AI fork, no foreign-mind write
     (recruitment stays an Inform; the candidate asked to join itself). Tests in
     `test/suites/recruit.mjs` (an NPC candidate joins an NPC leader and follows; a populated smoke
     stays gold-conserved + un-wiped + freeze-free).
   - **The directed-assault half is now wired (the former dangling piece).** A mustered leader no
     longer just recruits forever: once `ctx.resolver.warbandStrength(leader)` (its OWN believed band
     force, execution-mediated) crosses the muster target, the leader-side deriver pushes
     `goalAssault(foe)` — it marches on the **believed** foe (the avenge-style pursue-and-attack
     mechanic, combat on ground truth) and the band **converges** via `decideParty`. So `goalMuster`
     reaching strength now has a downstream consumer; the capstone fires end-to-end. Tests
     `recruit.mjs` `warband 5` (banded leader → `assault`) / `warband 6` (lone leader → `muster` first);
     soak stays town-un-wiped + gold-conserved with it live.
5. **The planning budget (§16) is unbuilt** — fine at the target population; a future ceiling.

## 20. Narrative-depth evaluation

A populated two-town world (~65 NPCs) run ~150 sim-seconds with the grammar live, measuring what
**emerges** versus the soak invariants (these runs predate the flag removal; the grammar is now
always-live, which is the "full grammar" row):

| run | freeze | gold | town pop | emergent deeds | thieves / marks | suspicion fallout |
| --- | --- | --- | --- | --- | --- | --- |
| heist (urchin + rob + knowledge) | none | 2600 → 2600 | 50 → 62 | 9 robberies | 5 / 31 | Σ susp 1.0 |
| full grammar (all features live) | none | 2600 → 2600 | 50 → 61 | 18 robberies | 12 / 51 | Σ susp 3.6 (max 0.87), 19 soured pairs |

What this demonstrates about narrative depth:

- **Crime is a believable consequence of circumstance × character, not a switch.** Of ~65 townsfolk,
  only the **poor** (a circumstance that drifts as agents spend down) who are *also* **bold + uncaring**
  (low altruism, high risk_tolerance — the disposition gate) turn to robbery. The scrupulous and the
  timid never do, even when broke. Thefts are *rare* (single digits over the run), which is the gate
  working — "not everyone turns thief when money is tight."
- **The consequence is emergent and per-perceiver.** A robbery sours the victim hard (the betrayal
  multiplier) and seeds lighter suspicion in every bystander who *saw* it — through each one's **own**
  belief store, witness-gated. An unseen theft breeds no suspicion. The town accrues a real
  crime-and-distrust layer (Σ suspicion, soured pairs) with no global "reputation" bookkeeping —
  it is the sum of private beliefs.
- **The grammar composes with the existing world.** Thieves preyed on **51 distinct marks**, picked
  from belief cues (the most-established local in mind ≈ prosperous), while the rest of the town kept
  trading, learning recipes (`learn` goals fire in the hundreds), and the population *grew* — the
  crime layer rides on top of a conserved economy rather than replacing it.
- **The hard invariants survive the new behaviour.** Gold is conserved to the cent across every
  theft/robbery (the `take` debits the source), the town is never wiped, and nothing freezes — the
  whole point of keeping the mechanic generic + conserved and letting only the *consequence* emerge.

The honest bound (per §19): the depth on display is the **theft-and-suspicion** arc plus
recipe-learning and the recruiter's belief half. The rescue (captivity + free), sabotage triggers,
graded recipes, wealth-cue estimation, and NPC war-parties are wired-but-dormant or follow-ups —
the *vocabulary* speaks them, but the *triggers/payoffs* that make them visible in the soak are the
next breadth step.
