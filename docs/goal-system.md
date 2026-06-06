# Design: memory-derived goals + hierarchical planning

Status: **draft** — for iteration. LLM-free: all behaviour is interpretable rules
over the agent's own **memory + beliefs**.

Goal: give agents self-directed goals rooted in lived experience, by adding
1. a persistent **goal stack** (structured intentions, between disposition and reflex),
2. a **derivation** step that reads episodic memory to push goals, and
3. a **hierarchical, cost-based planner** that turns a goal into a primitive-action
   plan using the agent's *believed* understanding of the world.

---

## 1. Where we are today (grounded)

- **Disposition** — `agent.ambition` (`js/sim/motivation.js`): one persistent drive;
  biases scoring via `ambitionFavor`. `revenge` is a dynamic override (`seedRevenge`).
- **Reflex** — `agent.goal = {kind}` (`js/sim/agent.js#decide`): a single momentary
  intention recomputed **every tick** by utility scoring over coarse *modes*
  (`fight/flee/eat/work/rest/socialize/wander`). `act()` executes it.
- **Episodic memory** — `agent.memory` (`js/sim/memory.js`): STM→MTM→LTM ring buffers;
  `memory.salient()` returns the formative few. Read by nothing that drives behaviour.

Two problems this design fixes: (a) memory is inert, and (b) the coarse modes are not
composable — they're behavioural policies, not atomic actions, so a goal like "repay a
kindness" has no expressible plan (and we have no `give`/`pay` action at all).

---

## 2. The model: three layers

```
ambition       disposition (slow archetypal bias)            [exists, unchanged]
goal stack     structured intentions, LIFO, memory-derived    [NEW]
   │  the TOP goal is PLANNED into primitives by the planner (§4)
   │  the current plan step is injected as a high-priority candidate
per-tick goal  reflexive action chosen by utility             [exists, augmented]
```

**Decided** (not a fork): the planner's current step is a *strongly-weighted candidate*
in the existing utility contest — it does **not** dictate. So survival/needs (flee, eat)
still out-score and interrupt a plan with no preempt/restore bookkeeping; the goal stays
on the stack and the plan resumes/replans when it wins again. The utility layer is the
arbiter; the stack supplies persistence + LIFO ordering + resume.

Mundane life (eat/work/socialize/wander) stays **reactive** — it is not planned and not
an intention. Planning applies only to the deliberate goals on the stack.

---

## 3. The goal stack

`agent.goals = []` (top = last). Each entry is a **goal = a desired believed world-state**,
not an action:

```js
{ id, kind, subjectId?, place?, target?,   // 'avenge'|'grieve'|'seek_fortune'|'repay'|'delve'
  predicate,        // (agent, ctx) => bool  — is this goal satisfied yet?
  priority, bornAt, expiresAt, from }       // from = the episode that spawned it
```

Bounded: depth cap (start 4) + `expiresAt`, so the stack always drains. Push dedups by
(kind, subject/place). Pop when `predicate` is true, the subject/place is gone, or it
expires; on completion optionally record a *closure* memory (memory ↔ goals feed back).

---

## 4. Action model & planning (pure GOAP, not recipes)

The ONLY authored entities are **primitives**, each a tuple `{ precondition, effect, cost }`.
A goal is a world-state predicate. The planner **backward-chains**: find primitives whose
*effect* satisfies the (sub)goal, treat their unmet preconditions as new subgoals, recurse,
and pick the min-cost feasible path. There are **no authored methods/decompositions** —
coarse nodes like "AcquireValue" are just *subgoals* (`have(value)`), and "Purchase /
Gather / Produce" are not modeled: they're the **labels of the branches the search finds**
(the primitives `buy`/`gather`/`produce` whose effect matches `have(value)`).

### 4.1 Primitives (atomic; precondition → effect; cost)

Effects are declared as **predicate templates** so the planner can unify them with subgoals.
Most mechanics already exist (col 4); the genuinely missing one is **directed transfer**,
which is exactly what `repay`/gift needs. All transfers preserve the closed money loop.

| primitive            | precondition           | effect (predicate)        | mechanic today |
|----------------------|------------------------|---------------------------|----------------|
| `goto(place)`        | —                      | `at(place)`               | `_goTo` |
| `gather(res)`        | `at(node(res))`        | `have(res)+1`             | main.js gather |
| `produce`            | `at(site), profession, have(inputs)` | `have(output)+1` | `_produce` |
| `buy(good)`          | `at(market), gold≥price` | `have(good)+1`          | market |
| `sell(good)`         | `at(market), have(good)` | `gold+=price`           | market |
| **`give(item,n,to)`**| `at(to), have(item)≥n` | `to.received(item)`       | inlined in `quest.tick` only |
| **`pay(amt,to)`**    | `at(to), gold≥amt`     | `to.received(value)`      | inlined in quest payout/loot |
| `consume(item)`      | `have(item)`           | need/hp up                | eat / drink |
| `attack(target)`     | `in_reach(target)`     | `target.hp--`             | `_combatStep` |
| `loot(corpse)`       | `at(corpse)`           | `have(gold)`              | `onCombatEvents` |

### 4.2 Plans emerge — they are not authored

Example: goal `X.received_value`. Backward-chaining over the effects above yields, with NO
decomposition written down:

```
X.received_value
  └─ give(good,X) | pay(gold,X)          (effect matches)
       precond: at(X)  ← goto(X)
       precond: have(good)               (for give)
         └─ buy(good) | gather(res) | produce | already-in-stock   (effect matches; pick min cost)
              precond (buy): at(market)  ← goto(market) ...
```

So the same goal becomes `[goto(X), pay(gold,X)]` for a coinful agent, `[give(food,X)]` for
a food-rich one, or `[goto(market), buy(food), goto(X), give(food,X)]` for one that must
acquire first — chosen by §4.3, not by branches we typed. (An authored decomposition stays
an escape hatch only for a goal no primitive-chain can express — none exist yet.)

### 4.3 Belief-grounded cost (the heuristic — "their understanding of the world")

At each OR-node the planner scores feasible methods by **believed cost** and takes the
min. Costs read only existing per-agent state, so two agents plan differently:

- travel: `believed_distance(place)` — POI pos (`world`) or subject `belief.lastPos`.
- price: `agent.priceBeliefs[good]` (already per-agent and gossip-shifted).
- feasibility: `profession`/tool (`PROFESSIONS`, inventory), known POIs, `ECON.keep` surplus.
- risk: believed-hostiles near the route (`beliefs`) add cost.

### 4.4 Planning & execution

- **Search**: cost-minimising best-first over the AND-OR tree, depth-bounded. The action
  set is ~12 and the tree is shallow, so this is cheap. Affordable because…
- **…planning is rare**: plan once when the goal becomes the stack top; **cache** the
  primitive sequence; **replan only on failure** (a step's precondition is false — market
  was empty, the target moved). No per-tick search.
- **Execution**: the current primitive becomes the high-priority candidate in `decide()`.
  If a reactive need out-scores it, the plan is untouched and resumes next tick; if the
  world shifted enough to invalidate the next step, replan.

---

## 5. Goal derivation from memory

`deriveGoals` (sibling of `updateAmbition`) scans `memory.salient()` and pushes a goal
(as a world-state predicate) when a formative memory implies one and an equivalent isn't
already on the stack:

| episode (memory.kind)             | goal pushed         | predicate (satisfied when)        |
|-----------------------------------|---------------------|-----------------------------------|
| `assaulted` (culprit)             | `avenge(subject)`   | subject dead / timeout            |
| `witnessed_death` of a liked one  | `grieve(subject)` (+avenge if culprit) | mourning timeout    |
| `windfall` at `place`             | `seek_fortune(place)` | gold ≥ target / timeout         |
| `succoured`* (helped when desperate) | `repay(subject)` | subject received value / timeout  |
| relic-found* (`delve`)            | `delve(place)`      | relic obtained / timeout          |

`*` needs a new memory hook (we don't yet record being helped, or an NPC finding a relic).
**Revenge is re-homed here**: delete the ambition-override `seedRevenge`; the `assaulted`
memory → `avenge` goal is the single source. `ambitionWantsFight` generalises to "has an
aggressive goal (avenge/defeat) on the stack."

---

## 6. Integration points

- New `js/sim/planner.js` — primitives (precond/effect/cost), compound methods, the search.
- New/`motivation.js` — `deriveGoals`, `pruneGoals`; remove the `revenge` ambition branch.
- `js/sim/agent.js` — `this.goals = []`; `decide()` injects the planner's current step as a
  candidate; pop-on-`predicate`. New `act()` cases only for genuinely new primitives
  (`give`, `pay`).
- `js/sim/simulation.js` — record the new episodes (`succoured`, relic) where they occur.
- `js/ui/inspector.js` — show the goal stack + current plan ("repay Mira → buy bread → …").
- `test/headless.mjs` — assertions (§8).

---

## 7. Invariants & constraints

- **Freeze lesson**: planning/derivation run on the fixed tick (but rarely) — guard every
  access, bound the stack + search depth, never throw.
- **Epistemic split**: goals are *created* from the agent's memory and *planned/acted* over
  **beliefs** (believed prices, believed positions), never ground truth. Plans can be wrong
  and fail — that's intended; replanning handles it.
- **Conservation**: `give`/`pay` move value, never mint it (headless already checks gold).
- **Bounded**: stack depth, plan length, search depth all capped.

---

## 8. Verification (headless)

Full scenario list: **`docs/goal-system-tests.md`** (deterministic unit scenarios +
the stochastic soak). Headline coverage: primitive conservation/gating (`give`/`pay`);
plan synthesis + the **emergence** (food-rich farmer plans `give`, coin-rich merchant
plans `pay`, acquire-first agent plans `buy→give`); belief-divergence; replan-on-failure;
**resume after interruption**; the goal stack (dedup/LIFO/cap/expiry); memory→goal
(robbery→avenge, windfall→seek_fortune, revenge re-homed); and the soak invariants
(no freeze, gold conserved, prior systems intact).

---

## 9. Phasing

- **Phase A — primitives + planner spine.** `give`/`pay` (+ formalise the existing
  mechanics as precond/effect primitives), the cost-based AND-OR planner, the goal stack,
  `decide()` integration, **one end-to-end goal** (`repay` *or* `seek_fortune`) shown to
  produce agent-specific plans, revenge re-homed, inspector display, headless tests.
- **Phase B — breadth.** `grieve`, `delve`, the new memory hooks (`succoured`, relic),
  more methods/primitives.
- **Phase C — feedback loops.** Closure memories on completion; gratitude seeds
  band/relationship preference; grief feeds mood; cost-model tuning.

---

## 10. Decided (settled, not open questions)

- **Search, not recipes** — the agent finds plans (GOAP), it doesn't follow hand-authored
  ones; affordable because plans are computed rarely + cached.
- **Actions are `(precondition, effect, cost)` primitives only** — no authored
  methods/recipes. Coarse nodes are *subgoals* (outcomes); "Purchase/Gather/Produce" are
  emergent branch labels, not modeled entities. Hierarchy = the recursive precondition
  tree backward-chaining builds.
- **Cost over beliefs** — branch selection uses each agent's believed prices/positions/
  skills, so the same goal yields different plans per agent.
- **Planner step is a weighted candidate, never a dictator** — reflexes/needs interrupt via
  the utility scorer; the plan resumes. No urgency-score-everything model.
- **Needs stay reactive** (not intentions); **ambition and the stack stay separate layers**.
- **Bounded defaults**: stack depth 4, per-kind `expiresAt`, depth-bounded search → config.
