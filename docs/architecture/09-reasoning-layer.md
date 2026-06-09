# The reasoning layer — belief-gated cognition at scale

> **Status.** This doc specifies the **target architecture** for agent reasoning, and the
> contract every build phase compiles against. It is part as-built, part designed:
> - **Phase 0 (✓ landed)** — the whole cognition/execution layer is belief-gated and the
>   "belief-only" contract is now *mechanical*, not conventional. Delivered by the
>   `epistemic-lockdown` workflow: a **restricted cognition ctx** (`Simulation._cognitionCtx`
>   hands `decide()`/`act()` no `agents`/`agentsById`/`player` handle — truth is
>   *structurally unreachable*) plus a **build-time scan gate** (`test/suites/epistemic.mjs`,
>   wired first into `headless.mjs`) that fails the build on any forbidden truth-access —
>   proven to trip on an injected `ctx.agentsById` and clean otherwise (0 leaks). A first
>   cut of **destination-intent pursuit** shipped with it, and the omniscient-pursuit
>   scenarios were reconciled with their original assertions intact. See also the updated
>   [02 — the epistemic split](02-epistemic-split.md).
> - **Phase 1 (✓ landed)** — the **world-model substrate**. Delivered by the
>   `world-model` workflow: a shared, read-only **mental map** (`js/sim/mentalmap.js`,
>   `MentalMap`/`Place`) snapshotted once from static geography (town gates, POIs, arena
>   landmarks) and queried by **affordance** (`affords('exit'|'conceal'|'safe'|'crowd'|
>   'resource')`) — never by scanning the roster (it holds no live entity; it is in the
>   epistemic scan). **Destination-intent inference** upgraded to the doc's `inferDestination`
>   argmax: heading-match + intent-conditional affordance bonus − distance, **cached on the
>   belief with a TTL** (`MAP.destTTL`) and invalidated the instant perception re-acquires the
>   quarry. And the **Scarecrow percept** (`js/sim/percept.js`) is now wired into the sim:
>   `sim.percepts` + the `fighters`/`perceivables` seams let an agent perceive a mindless prop,
>   believe it a person, close on it and strike it — with no system faulting (the `!agent`
>   guards skip all mind-feedback). Config in `MAP`/`SCARECROW` (`simconfig.js`); both
>   default-off paths keep the soak/depth baselines byte-identical. The `no-threat-no-response`
>   self-correction (the prop figuring) is schema #6 — landed in Phase 2a (it reads the animacy
>   tally added there).
> - **Phase 2a (✓ landed)** — the **additive** half of Phase 2. Delivered by the
>   `interaction-schemas` workflow: the `InteractionSchema` **IR + interpreter + shared
>   predicate/inference/response vocabulary** (`js/sim/schemas/{ir,vocab,interpreter,catalogue}.js`,
>   data-only, no `eval`, evaluated per-agent at the cognition tick over that agent's own
>   beliefs/state/mental-map — bounded O(beliefs × rules), priority/ttl-cached), the **animacy
>   tally** on beliefs (evidence a subject acted alive — moved/struck/blocked/harmed-me — feeding
>   schema #6), the **6 flagship schemas as data rows** (flee-to-safety, intercept-fleer,
>   go-to-ground, doubt-the-mask, flee-the-brawl, no-threat-no-response — all six now drive
>   behaviour: flee/fight set the active goal directly, and the dispositions hide/shadow/avoid are
>   ALSO direct schema-set goals with the act.js executor, not inert stack entries), and
>   **places-as-percepts**: buildings (the agent's own home + taverns) are perceivable percepts
>   with a *believed* `sheltered` state and a `placeKind`, affordances gained `shelter`/`rest`,
>   and **both [known debts](#known-debts--leaks-the-gate-cannot-catch) are RETIRED** (home state
>   is now discovered by sight/decay, the comfort branch is belief-backed). The **homecoming gate**
>   (`test/suites/homecoming.mjs`) passes: a miner with a stale home-intact belief walks home,
>   discovers the ruin by perception (case A) or self-corrects by belief decay (case B), then
>   reroutes — no telepathic re-route.
> - **Phase 2b (✓ landed)** — the **steering substrate**. Delivered by the `steering-substrate`
>   workflow: ONE potential-field locomotion primitive `steer(a, {attractors[], repulsors[],
>   speed}, dt)` (`js/sim/agent/steer.js`, in the epistemic scan) — a weighted-sum move along the
>   normalised force field, with goTo-identical arrival/grounding (it reuses goTo's exact
>   `_stepAlong` stepping body, so speeds/arrival-radius/barrier-deflect/terrain-slow/wall-collision
>   are byte-identical). The ~12-entry `goal.kind` locomotion switch in `act.js` **collapsed** into a
>   `STEER_FILLS` dispatch table: each locomotion-shaped behaviour (work/market/rest/comfort/socialize/
>   wander/sightsee/bounty/arbitrage/expedition/caravan/reporter/follow + the Phase-2a dispositions
>   flee/hide/shadow/avoid) is a pure `(a, ctx) → field` **steer-fill** built from the agent's OWN
>   beliefs/mental-map/own-state, motored by the single `steer()` executor. **World-interaction verbs
>   stay explicit** (gather/strike/block/transfer/produce/build, fired on the boolean `steer()`
>   returns — locomotion is a field, world-interactions are verbs). `fleeFrom`/`followLeader` retired
>   (now `fillFlee`/`fillFollow`); `goTo` stays as a thin `_stepAlong` delegate for the
>   still-special executors (spy state-machine, the plan-step transfer verbs, combatStep). The
>   dispositions fold in cleanly: the schema response ops (`vocab.js` `hide`/`shadow`/`avoid`/`fleeTo`)
>   build the goal inline with the fields the steer-fills read. **Behaviour-preserving** — every
>   baseline `goal.kind` still emerges (the `steer:` repertoire gate), the soak/scenario/homecoming/
>   percept/schema suites are green, and the depth index held (84/100, 21 distinct goal-kinds,
>   entropy H=0.68). Config in `STEER` (`simconfig.js`; only `fleeAway` is new — speeds/arrival/
>   stand-off gaps reuse the existing `SIM`/`SOCIAL`/`ECON` constants).
> - **Phase 3 (✓ landed)** — **Scale: a measured cost metric + amortized (LOD) cognition.**
>   Delivered by the `scale` workflow. Two pieces: (1) a **reasoning-cost-per-agent-per-tick
>   metric** (`depthMetrics.js` `report().reasoning.cost`, surfaced in `test/depth.mjs` and the
>   standalone `test/scaling.mjs`): per-tick deliberative work — schema predicate evals
>   (`_schemaFireCount`), `decide()` invocations + utility candidates scored (`_decideCands`),
>   plan replans (`_planReplans`) + max plan depth — summed per **living** agent-sample so
>   "tractable" is MEASURED, not asserted. (2) **LOD / amortized cognition** (`LOD` in
>   `simconfig.js`, scheduling in `Simulation.update`): agents are tiered by **relevance**
>   (`Simulation._isRelevant`, truth-side — in combat/fleeing, locked pursuit, active role/party,
>   carried goal-stack, an act-on threat belief, a recent goal-kind change, near the player, or
>   near own town centre — the last two give a **headless fallback** with no player); RELEVANT
>   agents run the slow passes (`reason()` + `decide()`, with `plan()` riding along) EVERY fixed
>   tick, the distant/idle tail only every `LOD.stride`-th tick — hung on the existing fixed-tick
>   accumulator ([01](01-sim-spine.md)). `perceive`/`decay`/`gossip`/market/society stay every
>   tick (no blind window on a threat — perception un-thinned + relevance re-checked every tick =>
>   a newly-perceived threat **promotes the agent the same tick**, before the flee band, so a
>   thinned agent never misses an urgent reaction), and `act(dt)`/movement stay **every frame**
>   (bodies move smoothly while cognition is amortized). The relevance gate reads ONLY own-state +
>   truth from Simulation orchestration — no cognition file gains a roster/relevance read, so the
>   epistemic scan stays clean. Small worlds (N ≤ `LOD.fullFidelityBelow`) run everyone
>   full-fidelity, so the scenario/soak sub-sims are byte-identical. **Gate met** — per-agent cost
>   is sub-linear/flat as N grows (standalone proof at N≈50/100/200: as N doubles 100→200,
>   per-agent cost grows only ×1.13 LOD-off / ×1.11 LOD-on — essentially flat once the
>   fixed-radius town saturates; LOD-on never raises cost and LOWERS it at every N), soak + the
>   whole scenario suite + epistemic scan green, depth floors held (90/100, 20 distinct
>   goal-kinds, H=0.72).
> - **Phases 4–5 (designed)** — the covert/domestic substrate, breadth. Marked *(designed)*
>   below until landed.
>
> Read [02 — the epistemic split](02-epistemic-split.md) first. This doc takes that
> invariant to its conclusion: agents reason **and execute** purely on their world-model,
> and reality is touched in exactly two sanctioned places. The single most important idea:
> **belief-gating is not only correctness — it is the scalability mechanism.** An agent that
> cannot read the roster cannot do O(N²) reasoning; it is structurally bounded to its own
> ~8-entry belief table. Correctness and tractability are the same constraint.

## Why this layer exists

The sim already reasons about *what is where* (beliefs) and *what to do next* (the
[goal/GOAP layer](05-economy-news.md), `motivation.js` + `planner.js`). To support a
growing library of **reasonable social interactions** — pursue a fleeing foe to where you
think it's *going*, mistake a scarecrow for a person, hide rather than just run, doubt a
disguise, scatter from a brawl — without a combinatorial explosion of code or compute, we
need a structured reasoning layer with three properties:

1. **Belief-only** — it never reads ground truth (enforced at build time, below).
2. **Bounded** — per-agent work is O(beliefs × rules), so the town is O(N), not O(N²).
3. **Data-driven** — new interactions are *data rows*, not new branches in `decide.js`.

The codebase already proves the data-driven pattern three times — the [ability IR](03-rpg-abilities.md),
class templates (`classes.js`), and the trope engine (`director/`). This layer reuses it.

---

## The three-tier execution hierarchy

Separate by **cadence**, not abstraction. Depth lives in the slow tier (amortized);
execution stays flat and cheap. **Three agent tiers, plus one world resolver that is not
part of the agent — and only two of them run per frame.**

| Tier | Cadence | Folds in | Reads | Emits | Truth? |
| --- | --- | --- | --- | --- | --- |
| **1 · Deliberative** (intent) | slow / amortized (≤ `SIM.tickHz`, LOD) | ambition + goal-stack + **reasoning/inference** + plan | beliefs, memory, mental-map, own state | a **committed intent** | belief-only |
| **2 · Executive** (arbitration) | cognition tick (`SIM.tickHz`) | `decide.js` — utility pick + interruption (flee overrides work) | beliefs + the intent | the active behaviour, in **belief-space** | belief-only |
| **3 · Reactive** (enact) | **every frame** | `act` → `movement` (steer) → `fighter` (body SM) | the behaviour's belief params + own state | body motion / swing | belief-only |
| — **World resolver** | **every frame** | `combat.js` geometry, `market.js` clearing | the *real* bodies | hits / trades | the **only** truth-toucher |

**Rules of the hierarchy:**
- Tiers 1–2 *set* intent; tier 3 *enacts* it. They hand down **one thing**: a committed
  intent expressed entirely in belief-space (target = a believed subject; destination = a
  believed/inferred place).
- The count that governs *compute* is the fast path = **2 layers**; the count that governs
  *truth exposure* is also **2** (perception in, resolver out) — both fixed regardless of
  how rich tier 1 grows.
- **Do not add a fourth tier.** The temptations (a "strategic" layer above ambition, or
  per-behaviour sub-planners below the plan) reintroduce handoff latency and per-tick cost
  for marginal gain. A behaviour that seems to need a new tier almost always wants a new
  `InteractionSchema` in tier 1 instead.

This is the classic deliberative / executive / reactive architecture; it is the sweet spot
precisely because it caps execution at two flat layers while letting tier 1 grow as deep as
the interaction catalogue needs — at the slow cadence, under the LOD budget, never on the
frame.

---

## The world-model substrate

Everything reasons off one private world-model per agent:

- **Beliefs** (`beliefs.js`) — the per-`(observer→subject)` table, **bounded to
  `SIM.beliefsPerAgent`** (~8). Each `BeliefState` carries `lastFaction`, `lastPos`,
  `confidence`, `hostile`, `suspicion`, `standing`, `source`/`hops`, and *(designed)* a
  cached **intent** + **inferred destination** (below), plus an **animacy tally** — evidence
  of whether the subject has been *observed acting alive* (moving, striking, blocking,
  harming me). Repeated engagement with **zero** observed animacy is what lets an agent
  *reason* that a believed-foe is actually inert (schema #6) — belief revision from
  contradicting evidence, not a truth-read.
- **Episodic memory** (`memory.js`) — the autobiography; goals derive from it.
- **Own state** — needs, inventory, mastery, personality, ambition.
- **Mental map** *(✓ landed, Phase 1)* — the agent's known **places**: town gates
  (computed from `TOWNS.wall`), POIs (`world.js`), landmarks (`arena.js`). A handful of
  entries, read-only, shared static geography (`js/sim/mentalmap.js`, `MentalMap`/`Place`,
  on `sim.map`). Queried by affordance (`affords('exit','conceal','safe','crowd','resource')`),
  never by scanning the roster. It holds **no live entity** — a *believed* home/hideout stays
  a BELIEF field, never a shared Place. In the epistemic scan; never throws on the tick.

> **The bound is the budget.** Reasoning may only ever quantify over *my* ~8 beliefs and
> ~8 known places. No rule can iterate the roster — the [enforcement](#build-time-enforcement)
> makes a roster scan *inexpressible*.

---

## Composition: finite primitives, open behaviours

**Is "fleeing" a state?** No — it is a *composition*. The correct shape is
`run + from:threat + to:inferred-refuge`, where `to` collapses to *"directly away"* when no
refuge is believed. A single parametric primitive covers both fleeing-blindly and
fleeing-to-the-gate.

**What is finite (and stays small):**
- the **body state machine** — `fighter.js`: idle / move / ready / attack / block / stagger
  (~6). Irreducible physical states.
- **interaction verbs** — `strike`, `block`, `gather`, `transfer`, `wait` (~5). Discrete
  world actions.
- **one locomotion primitive** — `steer(attractors[], repulsors[], speed)` *(✓ landed, Phase 2b —
  `js/sim/agent/steer.js`; the `STEER_FILLS` table is the open behaviour layer over it)*.

**What is open (compositional, unbounded):** every "behaviour" is a *fill* of that
vocabulary, produced by data, never a code branch:

```
flee   = steer(attract:[refuge?],       repel:[threat],  run)            // to:refuge, else "away"
pursue = steer(attract:[believedDest],   repel:[],        run)  + strike@reach
hide   = steer(attract:[cover],          repel:[hunter],  run)  + wait+stealth
forage = steer(attract:[resourceNode],   repel:[danger],  walk) + gather@reach
patrol = steer(attract:[nextWaypoint],   repel:[],        walk)
```

Flee and pursue are the **same primitive** — they differ only in the *sign and target* of
the field.

### The belief table *is* the potential field *(✓ landed, Phase 2b)*

Each belief contributes a force; steering is the weighted sum over my ≤8 beliefs + ≤8 known
places — **O(k), trivially cheap, and belief-gated by construction** (the field is literally
made of beliefs). As built, `steer()` (`js/sim/agent/steer.js`) is exactly this weighted sum: every
force `pos` comes from the agent's own `beliefs.*.lastPos`, its own-state targets, the static
mental map / world POIs, or the resolver-facade snapshots — never the roster (the file is in the
epistemic scan). A force whose `pos` is missing/NaN (a belief pointing at a despawned percept) is
SKIPPED, and an empty/all-stale field idles (never NaN-steps) — the freeze lesson made structural.

| belief | force |
| --- | --- |
| hostile (conf × threat) | repulsor |
| friend (standing) | attractor |
| inferred destination / refuge | attractor |
| a witnessed brawl | repulsor around its `lastPos` |

**Composition boundary:** fully parametric at the steering layer; **bounded sequencing** via
the existing planner (`steer → gather`, `steer → strike`); **no free recursion** — a
behaviour is `(field-fill + optional verb)`, optionally sequenced, never a behaviour
*containing* behaviours. That cap keeps execution a single flat tier-3 executor.

**Caution:** locomotion is a field; world-interactions are verbs. Trading, building, the
actual swing stay explicit primitives — a behaviour fires them on arrival/contact. Hybrid,
not pure potential-field.

**Effect on the current code (Phase 2b ✓ landed):** the ~12-entry `goal.kind` locomotion enum
(`work/flee/wander/market/comfort/socialize/sightsee/rest/bounty/arbitrage/expedition/caravan/
reporter/follow/hide/shadow/avoid`) **collapsed** into one steering executor (`steer()`,
`js/sim/agent/steer.js`) + the handful of explicit verbs; each named behaviour is now a
**steer-fill** — a pure `(a, ctx) → {attractors,repulsors,speed}` `STEER_FILLS` table entry that
reads the agent's own beliefs/map/state — dispatched through the single `steer()` executor in
`act.js` (the on-arrival/in-place verb fires on the boolean `steer()` returns). Fewer code paths,
unbounded behaviours. The genuinely-special executors (combat, the spy/plan state machines, build)
stay dispatched, not table-filled. The three dispositions with no prior kind (`hide`/`shadow`/
`avoid`) folded in as `fillHide`/`fillShadow`/`fillAvoid` (their goals built inline by the schema
response ops in `vocab.js`).

> **As-built divergence from the sketch above.** The `flee = steer(attract:[refuge?],
> repel:[threat])` sketch shows a *simultaneous* refuge-attract + threat-repel field (curved flight
> past a threat toward cover). The shipped fills are strictly **XOR** — a refuge attractor OR a
> threat repulsor, never both in one field — because the old `goTo`/`fleeFrom` code had no such
> case, and a simultaneous field is a NEW behaviour (out of scope for this behaviour-preserving
> collapse). `steer()` implements the full weighted sum (the correct substrate for a future
> simultaneous-field feature), but no current fill exercises the divergent path: an attractor fill's
> weighted-sum heading equals its single-attractor arrival point exactly, so it reproduces `goTo`
> byte-for-byte; a pure-repulsor fill reproduces `fleeFrom` (a 6m synthetic away-point + the
> radial-from-origin fallback) and never "arrives".

---

## The `InteractionSchema` IR *(✓ landed, Phase 2a)*

A schema is a data entry the interpreter evaluates — the social analogue of an
`AbilitySpec`. As built: the IR + `validate()` live in `js/sim/schemas/ir.js`; the builder/
evaluator vocabulary in `vocab.js` (in the epistemic scan); the bounded, priority/ttl-cached
`reason(agent, ctx, catalogue)` in `interpreter.js`; the rows in `catalogue.js`. Config (master
gate, dwell, inert threshold) in `SCHEMA` (`simconfig.js`).

```js
InteractionSchema = {
  id,
  subject,    // 'self' | 'believed'  — whose situation am I reasoning about?
  when,       // predicate over MY beliefs + own state + mental map (never truth)
  infer,      // (optional) write a cached higher-order belief: intent / destination / role
  respond,    // a goal / steer-fill I adopt as a result
  priority, ttl, cost,   // for the bounded, cached, LOD scheduler
}
```

### Shared vocabulary (the reuse lever)

```js
// predicates (boolean, over beliefs / own-state / map)
all(...) any(...) not(x)
believe(subj, field, op, val)      // believe('hostile','==',true), believe('confidence','<',.3)
witnessed(subj, deedTag)           // from episodic memory
selfNeed(need, op, val)  selfIs(tag)  outmatchedBy(subj)
nearKnown(affords, range)          // mental-map query, NOT a roster scan
perceivedNow(subj)
selfEngaged(subj, strikes>=n)      // I've struck it n times (my own action count)
observedAnimacy(subj, since)       // did I perceive it act ALIVE — move, strike, block, harm me?

// inference ops (write cached fields onto a belief; TTL'd)
setIntent(kind)                    // 'flee' | 'hunt' | 'trade' | 'guard' …
inferDestination(strategy)         // ← the ToM core, below
raise(field, amount)

// response ops (a goal the existing motivation/planner already execute)
goal(kind, args)  intercept(at)  fleeTo(place)  shadow(subj)  avoid(around,to)
```

### The flagship interactions — as data *(✓ landed: all six in `catalogue.js`)*

Six very different behaviours — flee, intercept, hide, suspect, scatter, unmask-the-inert —
each ~6 lines reusing the *same* primitives. A new interaction is a data row, not a branch in
`decide.js`. The sketches below are near-verbatim what shipped; two as-built notes: (1) schema
#5's proximity clause is `nearSubject('@a', 7)` (a real belief-lastPos-vs-my-pos gate), not the
degenerate `nearKnown('me', …)` the early sketch used; (2) doubt-the-mask only fires while the
subject is *not yet* believed hostile (`believe('@x','hostile','==',false)`) — once you're sure,
the committed avenge/fight intent owns you and shadowing would be regressive.

```js
// 1. QUARRY — believe I'm hunted and I'm no fighter → break for an EXIT or COVER.
{ id:'flee-to-safety', subject:'self',
  when: all( any(believe('@hunter','hostile','==',true), nearKnown('threat',9)),
             not(selfIs('combatant')), selfNeed('safety','<',0.4) ),
  infer: setIntent('flee'),
  respond: fleeTo( nearKnown(affords('exit','conceal')) ), priority:.9, ttl:4 }

// 2. PURSUER — infer WHERE the quarry is making for, and cut it off there (Theory of Mind).
{ id:'intercept-fleer', subject:'believed',
  when: all( believe('@q','hostile','==',true), believe('@q','intent','==','flee'),
             not(perceivedNow('@q')) ),                 // I've lost sight of it
  infer: inferDestination('flee'),                      // → belief('@q','dest', <place>)
  respond: intercept( at: believedField('@q','dest') ), priority:.85, ttl:6 }

// 3. HIDE — outmatched, don't just run (you lose); seek CONCEALMENT and go quiet.
{ id:'go-to-ground', subject:'self',
  when: all( believe('@hunter','hostile','==',true), outmatchedBy('@hunter') ),
  infer: setIntent('hide'),
  respond: goal('hide', at: nearKnown(affords('conceal')), thenStill:true ), priority:.95, ttl:8 }

// 4. SUSPECT A DISGUISE — a "friend" whose deed contradicts its face (intrigue, no truth read).
{ id:'doubt-the-mask', subject:'believed',
  when: all( believe('@x','lastFaction','==', selfFaction()), witnessed('@x','HOSTILE_ACT') ),
  infer: raise('suspicion', .4),                        // curdles toward 'hostile' on repeat
  respond: goal('shadow', subj:'@x'), priority:.5, ttl:30 }

// 5. BYSTANDER — believe a fight is breaking out nearby → clear the danger zone.
{ id:'flee-the-brawl', subject:'self',
  when: all( any(witnessed('@a','STRUCK'), believe('@a','hostile','==',true)),
             nearKnown('me',7), not(selfIs('combatant')) ),
  infer: setIntent('flee'),
  respond: avoid( around: believedField('@a','lastPos'), to: nearKnown(affords('safe')) ),
  priority:.7, ttl:3 }

// 6. UNMASK THE INERT — a "hostile" I've struck repeatedly that never fights back, flees,
//    blocks, or harms me is, by my OWN evidence, no threat at all (a scarecrow, a corpse,
//    a statue). Belief REVISED from contradicting observation — correction by reasoning,
//    not omniscience; it reads only my own strikes + my perceptions of its (lack of) animacy.
{ id:'no-threat-no-response', subject:'believed',
  when: all( believe('@x','hostile','==',true),
             selfEngaged('@x', strikes>=3),                 // I've hit it several times…
             not(observedAnimacy('@x', since:'engage')) ),  // …yet zero reaction
  infer: raise('inertEvidence', 1, then: set('hostile',false) above: thresh),
  respond: goal('disengage'),                                // lose interest, move on
  priority:.6, ttl:20 }
```

---

## Destination-intent inference *(✓ landed, Phase 1)*

The one piece of real "new code," and it is tiny and bounded — **Theory of Mind, not
dead-reckoning.** When an agent loses sight of a pursued subject it does **not** extrapolate
a velocity; it infers *where the subject is trying to go* from its last-seen heading + known
geography + context, and intercepts there.

> **As built** (`inferDestination(observer, belief, intent, map, now)` in `beliefs.js`,
> called from `inferLostQuarries` in `perception.js`): the sketch below shipped almost
> verbatim — the argmax is over `map.known(observer.townId, lastPos, MAP.knownPlaces)`, the
> weights are `MAP.wHeading/wAfford/wNear`, and the result is cached on the belief
> (`destId`/`destPos`/`intent`/`destInferredAt`) for `MAP.destTTL` seconds, re-inferred only
> on lapse and zeroed by `observe()` on a re-sighting. Fallbacks: a moving quarry with no
> fitting place extends along the heading toward the frontier; a still quarry stands and
> searches at `lastPos`. `raid`/`hunt` reward a `crowd` place. All static-geography + belief
> reads — it is in the epistemic scan and never throws.

```js
// "Where is this quarry trying to GO?" — pure belief + mental map + context. O(#places).
function inferDestination(observer, b /*belief about the quarry*/, intent) {
  let best = null, score = -Infinity;
  for (const place of observer.map.known()) {            // gates, hideouts, believed-home, market…
    let s = 0;
    s += headingMatch(b.lastHeading, observer.map.dirTo(b.lastPos, place)) * W.heading; // aimed at it?
    if (intent === 'flee') s += place.affords('exit','conceal') ?  W.flee : -W.flee;    // a fleer wants out/cover
    if (intent === 'hunt') s += place.affords('crowd','victim') ?  W.hunt :  0;         // a hunter wants its mark
    s -= observer.map.cost(b.lastPos, place) * W.near;                                  // nearer is likelier
    if (s > score) { score = s; best = place; }
  }
  return best;            // the BELIEVED destination → schema #2 intercepts here
}
```

Cached on the belief with a TTL, invalidated the instant perception contradicts it. A town
of 100 agents re-infers a destination only when one is *actively pursuing and has lost
sight* — a few dozen tiny argmaxes per second, not a global anything.

---

## The full GOAP loop, with everything threaded

The GOAP layer (`motivation.js` goals + `planner.js` plans) runs **in belief-space
end-to-end**: preconditions, effects, and the goal predicate are all predicates over the
agent's *beliefs*, so a plan re-plans when the *world-model* — not the world — changes.

**The pieces:**
- **Goal** = a desired belief-state predicate (`believe(dead, Rook)`).
- **Action** = `{ pre:[atoms], eff:[atoms], body, cost }` where atoms read beliefs, and
  `body` is a tier-3 emission: a **steer-fill** and/or an **interaction verb**.
- **Planner** = backward search chaining actions whose `eff` satisfy others' `pre`.
- **Replan** = a perception that changes a `pre`/`eff` belief invalidates the plan.

**The action library (small, belief-gated):**
```
approach(s)    pre: —                          eff: in_reach(s)   body: steer(attract:[belief(s).where])
strike(s)      pre: in_reach(s)                eff: dead(s)*      body: strike@reach
gather(g@node) pre: at(node)                   eff: have(g,+1)    body: steer(attract:[node]) + gather@reach
buy(g)         pre: at(market), gold_ge(price) eff: have(g,+1)    body: steer(attract:[market]) + transfer
forge(tool)    pre: have(wood,1),have(ore,1)   eff: have(tool,1)  body: wait + craft
flee()         pre: —                          eff: safe()        body: steer(repel:[threat],attract:[refuge?],run)
```

### Example 1 — The vendetta (threads every layer)
*Bram was assaulted by Rook, a believed bandit who bolts east toward the gate.*

- **Tier 1 · memory→goal** (`deriveGoals`): `assaulted(Rook)` memory pushes `avenge(Rook)`,
  predicate `believe(dead,Rook)`.
- **Tier 1 · reasoning** (schema `intercept-fleer` fires — hostile, `intent:flee`, *not
  perceived now*): `inferDestination('flee')` → **the main Gate**; writes
  `belief(Rook).where = Gate`.
- **Tier 1 · plan** for `believe(dead,Rook)`: `strike` needs `in_reach`; `approach` gives
  it → **Plan = [approach(Rook), strike(Rook)]**, where `approach`'s target is
  `belief(Rook).where` = the **Gate** (inferred destination — not the cold trail, not truth).
- **Tier 2 · executive** (`decide`): no danger/hunger to interrupt → the plan step wins.
- **Tier 3 · reactive**: `approach.body = steer(attract:[Gate], run)` → Bram **cuts Rook
  off at the gate**. On believed `in_reach` → `strike` → `fighter.ready/release`.
- **Resolver** (`combat.js`): blade samples geometry. Rook there → hit, `isHostile` reads
  the *true* faction. Rook slipped out → blade hits air; Bram only *learns* via perception.
- **Closure**: kill → Bram perceives the fall → `believe(dead,Rook)` → goal **pops**,
  records `triumph`. Escape unseen → `belief(Rook)` decays → `in_reach`/`where` go stale →
  **falls to search** → re-acquire, or the grudge **expires** (goes cold). All emergent.

### Example 2 — "Forge a tool," with replanning
**Goal:** `have(tool,1)`.
- **Plan A:** `[buy(wood), buy(ore), forge]`. Bram steers to market, buys wood — then his
  belief updates (no ore seller at market) → `buy(ore).pre` fails → **plan invalidated**.
- **Replan B:** `[gather(ore@mine), forge]` → `steer(attract:[believed mine]) + gather` →
  forge. A hostile belief en route injects `flee` (higher priority) → tier 2 interrupts →
  `steer(repel:[threat])` dominates the field → he breaks off; the forge plan resumes from
  the stack. Same machinery; replans on *belief* change.

### Example 3 — The scarecrow, *through* GOAP (the tolerance test)
Bram perceives a scarecrow dressed as a bandit → `belief(hostile, S)` with a *person*
appearance. The exact vendetta path runs: `goal=defeat(S)` → `[approach(S), strike(S)]` →
`steer(attract:[belief(S).where])` → he marches over and swings.
- The resolver lands the blade on the scarecrow's **body** (`torsoCenter/takeHit`);
  `combatEvents` sees `target.agent == null` → **skips** all mind-feedback via its existing
  `!A||!T` guard. Nothing assumes a person.
- **Then he figures it out.** The prop never flees, strikes back, blocks, or harms him —
  so after a few unanswered blows the `no-threat-no-response` schema fires: by Bram's own
  evidence (his strikes + his perception of its total lack of animacy) this "bandit" poses
  no threat. He **revises the belief** (`hostile → false`, `inert`), drops the defeat goal,
  and **disengages, puzzled** — the mistake self-correcting through *reasoning*, not a
  truth-read. (Had he kept hacking, the prop would simply topple — but the smarter, emergent
  outcome is that he realises it was never a foe.) He was fooled at first and reasoned his
  way out, and not one system faulted on the way.

### Example 4 — the homecoming (the domestic counterpart) *(✓ landed, Phase 2a)*
*Mirek the miner has been at the eastern vein since dawn; raiders torched his home at noon.*

- **The cheat this example retired:** the instant the roof failed, `construction.js` used to
  clear `owner.home` — the world writing into the miner's head from across the map, no
  perception involved — and the comfort branch live-queried `buildSites` for a tavern. He
  "knew" telepathically; the homecoming never happened. Both were [known debts](#known-debts--leaks-the-gate-cannot-catch),
  now retired (see the gate `test/suites/homecoming.mjs`).
- **As built:** his home is a *percept* he holds a belief about (a believed `sheltered`
  state, conf high, last refreshed at dawn). The comfort plan runs in belief space:
  `[goto(believed-home), rest]`. He walks home — to ash. **Perception contradicts the belief
  on arrival** (case A, discovery by sight) *or* the stale belief decays past the act-on
  floor with the percept despawned (case B): belief revised, plan invalidated, replan
  against the next-best *believed* shelter — `nearKnown(affords('shelter'))` → the tavern.
- An episodic `home_lost` memory derives goals: **rebuild** (feeding the existing
  construction-demand loop) and **avenge** if a witness gossips him the culprit's name. The
  Chronicle gets its beat *when he learns*, not when it burned.
- **The gossip variant is the ToM payoff:** a neighbour who watched it burn tells him at the
  mine — he grieves early and the trip never happens. Same machinery, different information
  flow. No combat anywhere in this example: the split is not a combat feature.

### Example 5 — the urchin and the merchant (covert; epistemic atoms in the planner)
*Pip, an urchin with an empty purse, marks Master Olen, a merchant believed rich.*

The goal is **`steal(Olen)`** — derived from the wealth need like any motivation. *Knowing
where he keeps it is a precondition*, not a goal: the planner backward-chains through an
**epistemic atom**, and knowledge-acquisition appears inside the plan only when the
knowledge is missing (the same stock-vs-acquire shape as the B5 planner test — `shadow` is
the epistemic `gather`):

```
burgle(stash)    pre: know_assoc(Olen,'stash'), at(stash),
                      believedFar(Olen,stash), noWitnessBelievedNear   eff: have(gold)
approach(stash)  pre: know_assoc(Olen,'stash')                         eff: at(stash)
shadow(Olen)     pre: —              eff: know_assoc(Olen,'stash')     // slow, safe
ask(informant)   pre: near(inf.)     eff: know_assoc(Olen,'stash')     // fast, alerts the mark
```

- **Plan-step choice is the behavioural modelling:** `shadow` vs `ask` is an ordinary cost
  decision — a charming agent asks around, a despised urchin stalks. If gossip already
  supplied the stash, `know_assoc` is pre-satisfied and the plan collapses to
  `[approach, burgle]` — a tip is literally *plan-cost saved*, pricing information through
  the planner (the journalism layer's info-as-resource theme, made mechanical).
- `shadow` steers at a standoff **outside the mark's modelled sight** (assume his vision
  mirrors my own config — rule-based second-order ToM v1). Its effect is *non-guaranteed*:
  sightings accumulate in episodic memory and consolidate into a **subject↔place association
  belief** (`assoc(Olen,'stash') = P`, role-tagged); the step runs under a budget and the
  existing goal-expiry path (the D4 test) drains plans whose acquisition never lands.
- **The counter-schema** (`sense-the-tail`): repeated sightings of the same face near me →
  `vigilant` → vary route / **relocate the stash** / report to the Watch. Relocation silently
  stales Pip's association belief — the heist hits an empty cache and he must re-case.
  Cat-and-mouse, fully emergent, no scripted heist.
- **Consequences ride existing rails:** `steal`/`shadow` deeds → `behavior_profile` → an
  emergent Thief class; witnessed theft → gossip → Watch → bounty → a Gazette crime story.
  With lineage spawning children into poverty, the career arc — urchin → cutpurse → wanted —
  is emergent, not authored.
- **Prerequisite:** stored wealth. Today gold is purse-only, so the scenario is
  *unrepresentable* — there is nothing to stash. Purse vs stash is its own (small, prior)
  economy change: carried gold is lootable on death, stored gold is burglable while away,
  and both stay inside the closed money loop.

### Example 6 — the teacher (the *useful* cooperative mirror of the urchin)
*Mistress Edda, a master smith, is the cooperative twin of Pip: covert belief **acquisition**
becomes overt belief **distribution** — the same `know(X)` substrate, opposite intent.*

The trap to avoid: a teacher who transmits beliefs nobody's decisions depend on is a gossip
NPC in a mortarboard. A teacher is *useful* only when what's taught is **scarce**,
**consequential**, and **cheaper than the alternative** — so the design starts from where an
agent provably does worse for lack of knowledge. Four teachable goods, each with a metric:

| Good | The deficit today | Metric (taught vs control) |
| --- | --- | --- |
| **Price calibration** | per-agent price beliefs already drift (soak: herb cleared 7.6 vs belief 9.6±2.8) | gold lost to belief-vs-clearing spread |
| **Danger geography** | agents die in the wilds learning the hard way; `travelCost` already routes around believed threats | wilds mortality / 1000 ticks |
| **Craft know-how (recipes)** | — *see below; the load-bearing one* — | time-to-first-produce; chain survival |
| **Map spots** (waits on per-agent known-places) | shared-static map means everyone "knows" the same geography | time-to-first-gather |

- **Demand emerges from the planner, not a script.** A `learn(topic)` step
  (`pre: near(teacher), gold ≥ tuition; eff: know(topic)`) competes inside an ordinary plan:
  a young trader's `seek_fortune` weighs `[learn(prices) → trade]` against `[trade blindly]`,
  and buys the lesson exactly when tuition < the expected losses it avoids. Same epistemic
  atoms as the urchin's `know_assoc`, pointed at a legitimate market.
- **Transmission stays belief-gated:** `teach` writes through the existing **gossip bridge**
  with `source: 'taught'` provenance (higher trust than street rumour) — the student *hears*
  the lesson; the teacher never writes another mind directly. A `quiz` step updates the
  teacher's *model of what the student knows* through perception (cooperative, bounded
  second-order ToM — a teacher models ~2 apprentices, not the town).
- **Supply rides existing rails:** tuition is closed-loop gold income; `teach`/`learn` deeds
  drift the `behavior_profile` → an emergent **Teacher** class (the "Wise" epithet), nobody
  assigned. **Refuse-list:** no direct XP transfer (that cheapens *earned* emergent classes —
  teaching seeds beliefs + unlocks know-how; the student still levels by doing), no
  shared-static curricula (useless by construction), no ambient "mentor buff" (a stat aura
  bypasses the belief system entirely).

**Recipe knowledge — where teaching becomes infrastructure.** Gate a production chain on
own-state `knows(recipe_X)` (own-state, so cognition reads it freely — no split issue),
transferable only by teaching/apprenticeship or **observation** (`shadow` the apothecary —
the urchin machinery verbatim, now industrial espionage) or slow self-rediscovery (an
"invention" Chronicle beat). Now knowledge transmission is *economically load-bearing*:

- the last apothecary dying **untaught** removes potions from the economy until someone
  re-discovers the craft → scarcity → price spike → a Gazette story (the market does this
  for free);
- **guild secrets** (`groups.js` — teach only in-group → a knowledge cartel), **family
  recipes** (`houses.js` + lineage → a house asset that dies with an untaught line),
  **monopoly pricing** (one knower → concentrated supply → the existing clearing prices it).

Guards: a *belief* about whether someone else knows a recipe is second-order and can be wrong
(pay tuition to a fraud). **Migration is baseline-identical** (the `SCARECROW.enabled`
pattern): seed every current professional with their recipe, so the soak is unchanged on day
one — scarcity emerges only through generational turnover, where it belongs. Recipe-gating
lands as its own small economy commit *before* the teaching schemas (like purse-vs-stash).

### Example 7 — the camp rescue (asymmetric operations; the catalogue *composes*)
*An adventuring party of **4** takes a bandit **camp of 30+** — and wins because of the
**knowledge gap**, not the sword-count.* This is the capstone: it works only if Examples 1–6's
primitives compose, with no new behaviour code.

- **Scout, don't charge.** A scout surveils the camp from a concealment standoff (the urchin's
  `shadow` machinery). The ≤8-entry belief cap makes tracking 30 individual bandits
  *inexpressible* — so observation necessarily **aggregates** into a **place-occupancy belief**
  on the camp percept (believed strength ≈ N). That bound is a *feature*: it's why armies are
  reasoned about as *forces at places*, not rosters.
- **The planner refuses the frontal assault.** Group-level `outmatchedBy` (party strength vs
  believed occupancy) fails the `[assault]` plan outright — the party does *not* suicide. It
  waits.
- **The window is event-triggered (v1).** The scout perceives the **raid column departing** →
  revises camp occupancy 30 → ~5. *Now* `[infiltrate → free(captives) → exfiltrate]` becomes
  feasible. (Learned routines/schedules — "they always raid at dusk" — are explicitly a v2;
  v1 only needs *perceive the departure*.)
- **Infiltrate** via `affords('conceal')` routes outside modelled sentry vision (second-order
  ToM again); **`free(captive)`** is a new verb on a **captive state** (held agents can't act
  until freed, then `follow` the party out — ties into the quest `recover` type).
- **The system becomes its own antagonist:** the returning bandits run **Phase-1
  destination-intent inference** to pursue the fleeing party — the rescue is a race against the
  same machinery that powers every pursuit.

**The gate is the point** (`test/suites/camp-rescue.mjs`, a Phase-5 capstone): (a) 4 beat 30+
**with** the scouted window; (b) **control** — the same party *without* the knowledge is
refused by its own planner, or wiped if forced; (c) **epistemic honesty** — if the scout is
absent when the column leaves, the window is never detected (no telepathic raid-sensing);
(d) the scan + structural checks stay green; captives are real agents. If the knowledge-blind
control doesn't *lose*, the feature is a fraud — the win must be *the knowledge*. (`expeditions.js`
then makes NPC-run rescues an emergent follow-on.)

**What to notice:** one executor, many behaviours (every locomotion is a steer-fill);
GOAP runs in belief-space end-to-end, so planning, replanning, pursuit, *mistakes*,
*discoveries* (Ex. 4), *heists on stale information* (Ex. 5), *teaching* (Ex. 6) and
*asymmetric operations* (Ex. 7) all flow through the same pipe; deliberative depth is all
tier-1 (amortized), tier-3 per frame is just *steer + maybe a verb*.

---

## The situation library (the design bar for the catalogue)

What the schema catalogue must cover **out of the box**, organised by the substrate each
family *forces* — every entry is a future schema/test candidate, and a family lands when its
test passes headless. (Pursuit was the first consumer of the world-model, not the shape of
it; this table is the proof of generality.)

| | Family | Situations | Substrate it forces |
| --- | --- | --- | --- |
| **A** | **Place-state beliefs** | the homecoming (Ex. 4); the dry vein (miner treks to a believed-rich, actually-depleted mine; gossips "played out" — supply rumours, true or false); the closed gate (curfew → detour to another `affords('exit')`); the desecrated shrine (the small god *actually weakens* as believers learn — faith ⨯ belief-propagation) | places-as-percepts: believed *state* on known places, revised by perception/gossip |
| **B** | **Liveness & whereabouts in non-combat plans** | the dead vendor (plan `buy(potion)` → empty hut → replan/ask); the apprentice's dead master (→ `find_new_mentor`, lineage); the unwitting widow (belief decays → worry → *seek information*; grief lands by hearsay days late, or never) | `believedDead` generalised beyond vengeance; absence-of-evidence as evidence |
| **C** | **Institutional / information staleness** | the claimed bounty (wasted trip → the gazette earns a *credibility*, like gossip provenance); the arbitrage bust (widely-published prices are already priced in — herding from shared beliefs) | news/quest state as belief-with-staleness, not live reads |
| **D** | **Second-order ToM** | "they think I did it" (framed agent flees/hides/petitions the patrician *because he believes they believe*); `sense-the-tail` (Ex. 5's counter-schema) | beliefs about others' beliefs — `notoriety` is the existing one-off special case |
| **E** | **Epistemic atoms** | every "ask around" ending above; Ex. 5's `know_assoc` precondition with `shadow`/`ask` chosen by cost | `know(X)` pre/eff atoms in the planner; actions whose effects acquire beliefs. (`know(X)` as a *terminal* goal exists for exactly two professions where information is the job: the reporter and the spy.) |
| **F** | **Compound invalidation** | Rip van Winkle: an expedition returns after three days to a raided town — buildings gone, a friend dead, prices shifted. **A test, not a feature**: assert mass belief-revision happens via perception/gossip on re-entry, never a sync from truth | nothing new — the gate that proves A–E compose |
| **G** | **Cooperative knowledge distribution** | the teacher (Ex. 6) — price calibration, danger geography, **recipe know-how**, map spots, demand priced by the planner (`learn` when tuition < losses-avoided); the priest as a teacher of god-beliefs (faith propagation made principled) | the *write* side of family E: `teach`/`quiz`; `source:'taught'` gossip provenance; `knows(recipe)` own-state gating production; bounded cooperative second-order ToM |
| **H** | **Asymmetric operations** | the camp rescue (Ex. 7) — scout → place-occupancy belief → refuse frontal assault → exploit a perceived window → infiltrate/`free(captive)`/exfiltrate while the foe's own destination-intent pursues you | **place-occupancy (aggregate-strength) beliefs** (the ≤8 cap forces aggregation — armies as forces-at-places); group-level `outmatchedBy`; captive state + `free` verb; the catalogue composing into operations |

### Probe-backed gap analysis (the Phase-5 priority order)

A generative sweep — 35 imagined situations (unconstrained by current support), each mapped to a
GOAP framing and, where expressible, run through the *real* `plan()` to confirm what chains and
what dead-ends — produced this **leverage-ranked** shortlist of the missing substrate. Each is a
small, data-shaped addition (a belief-field, an atom pred, or a primitive with pre/eff) consistent
with the existing patterns; the count is how many of the 35 situations it unlocks.

| Missing substrate | Kind | Unlocks | Family |
| --- | --- | --- | --- |
| **`believedStandingToMe`** — generalise the one-off `notoriety` into a believed-other's-belief-about-me field + a goal predicate `believe(@x,'standingToMe','>=',v)` | belief-field + atom | **7** (courtship, blackmail, framing, rep-laundering, bribery-effect, feigned-weakness, double-agent) | D |
| **Per-place price belief** `priceAt(good,place)` + a `haul(good,from,to)` primitive | belief-field + primitive | **3–4** (smuggling/arbitrage, monopoly, contraband) — makes `arbitrage.js` *plannable* | C |
| **Dynamic place-state beliefs on resource nodes & gates** (`depleted`/`infected`/`closed`/`watched`), read in `travelCost` + as preconditions | belief-field | **4–5** (dry vein, plague, curfew, famine migration) — Family A beyond homes | A |
| **Captive state + `free(subj)` verb** | belief-field + primitive | **4** (jailbreak, siege, feast-assembly, camp rescue) | H |
| **`know(recipe)` atom + `learn`/`teach` primitives** (pre `near(teacher)`+`gold≥tuition`, eff `know(recipe)`) | atom + primitives | **2–3** (apprenticeship, the teacher) — *probe-proven: a non-knower can only `buy`, never plan to learn the craft* | G |
| **`coerce`/`demand` primitive** — eff raises `gold_ge` via the mark's transfer; pre `leverage(mark)`+`in_reach` | primitive + belief-field | **2** (blackmail, extortion) | D/E |
| **`sabotage`/`destroy` verb** on a building/tool percept (eff: revise its usable/`sheltered` state) | primitive | **2** (sabotage, eviction) — generalises the truth-side raid/ruin | A/H |
| **Place-occupancy (aggregate-strength) belief + group-level `outmatchedBy`** | belief-field + pred | **2** (siege, camp rescue) — the ≤8-cap-forced aggregation | H |

The top three together touch ~14 of the 35 situations and are the leverage core; #4–#6 are the
already-named Phase-4/5 features (captive/`free`, `know(recipe)`/teach) the roadmap specifies.

### The actual boundary (and the patterns that respect it)

The split forbids exactly two narrow operations in cognition: **reading ground truth**, and
**writing another agent's belief store directly**. It does *not* forbid reasoning or acting on what
others believe — that lives entirely inside one agent's own model. The sweep at first mis-flagged
three families as "structural limits"; two of them are really **in-paradigm patterns**, and only a
sliver of the third is a genuine gap:

1. **Second-order ToM (deception, framing, feigned weakness) — IN-MODEL, not forbidden.** A
   `believedStandingToMe` / `believedBelief(target,claim)` field is the *actor's own* belief about a
   foreign mind — held in the actor's store, like any belief. A `deceive`/`feign` primitive's
   planner-effect writes that **own** second-order belief ("I now expect the target believes X"); it
   never touches `target.beliefs`. The target's *actual* update flows through the existing
   perception/gossip bridges when it perceives the disguise / hears the planted rumour — and may not
   happen (the actor misread → acted on a false second-order belief → replans). Identical shape to
   the urchin burgling a stale stash. The *only* forbidden version is a primitive that mutates
   `target.beliefs` directly — which second-order ToM never needs.
2. **Coordination by command — emergent, not joint-planned.** A leader estimates, from its OWN
   beliefs (standing, loyalty, group membership), how likely each agent is to comply, then plans its
   OWN action — `command(followers, muster)` — with an **optimistic effect** ("they probably
   assemble", weighted by that estimate). The followers independently decide to heed or not (their
   own cognition reacting to the heard command). No co-planner, no shared plan: the leader acts on
   its own model and reconciles by replanning if the muster falls short. The one genuinely
   inexpressible thing is narrower — a precondition that requires another agent's **guaranteed**
   commitment ("Y *will* bring food" as a fact) — and optimistic-effect-and-replan routes around it.
3. **Temporal scheduling — the one real gap (and partly deferrable).** The plan is an ordered step
   list with no clock: no "due at T", "every N days", or "default-consequence after a deadline".
   Goals carry only an `expiresAt` decay. Recurrence is re-derived each tick from memory; a genuine
   obligation-with-deadline needs a temporal substrate the GOAP layer lacks — though even this
   softens (a deadline can be a believed-place-state that flips; a cadence, a memory-triggered
   re-derivation). The Ex. 7 "learned schedule" is a v2 for this reason.

The takeaway flips from the first pass: almost everything the sweep surfaced — including the
deception and command families — is *in-paradigm*. The split is a narrow rule about two specific
operations, not a ban on social cognition. (Sub-combat tactical ToM — a feint — remains below the
planner's altitude by the three-tier rule.)

---

## Build-time enforcement

> The contract the whole layer compiles against: **cognition/execution touches only beliefs,
> own state, and the mental map. Reality is touched only by perception (in) and the resolver
> (out).** "Next to nothing uses global information," made mechanical.

This project has no compiler — the "build" is `bun test/headless.mjs`
([08 — testing](08-testing.md)). Enforcement is therefore two-pronged:

1. **Structural** — the cognition/execution layer receives a *restricted context* with no
   `agents` / `agentsById` / `player` handle, so truth is **unreachable**, not merely
   forbidden.
2. **Static scan** — a suite (`test/suites/epistemic.mjs`, wired into `headless.mjs`) reads
   the cognition/execution source and **fails** on any reference to `ctx.agents` /
   `agentsById` / `ctx.player`, or any dereference of another entity's true
   `.pos/.faction/.alive/.inventory/.gold`. Allowlisted: `perception.js`, `combat.js`,
   `simulation.js`, `combatEvents.js` (the bridge / resolver / orchestration).

Every belief→object dereference that *does* remain must be guarded for `undefined` (a belief
may point at a non-agent percept — a scarecrow, a phantom): **never throw on the tick** (the
freeze lesson, [01](01-sim-spine.md)).

### Known debts — leaks the gate cannot catch

The gate catches cognition *reading* truth. It cannot catch the **world writing cognition
state**, nor a sanctioned ctx field that carries *dynamic* truth. Two instances were named here;
**both are now RETIRED by places-as-percepts (Phase 2a):**

1. **`owner.home = null` on shelter loss — RETIRED.** The world no longer writes the owner's
   cognition. A finished building is registered as a **percept** (`construction.js _finalize`,
   `kind: PERCEPT_KIND.BUILDING`, namespaced id `B:<n>` so it can never collide with an agent id in
   the shared per-observer belief table) carrying a perceivable `alive`/`sheltered` surface. The
   owner **discovers** his home by sight (`perceiveBuilding` binds `homeBeliefId` and files a
   *belief* with `placeKind:'home'` + believed `sheltered`), and discovers its **loss** the same
   way — perception flips the believed `sheltered` to false and files a `home_lost` episode *when
   learned*, not when it burned. A fully-ruined+despawned home (no percept) self-corrects by belief
   **decay** instead. Construction-demand bookkeeping stays truth-side (deliberate seam: building
   ownership/raid/ruin are world systems; only the agent's *knowledge* of its home is belief-gated).
2. **`buildSites` on the restricted cognition ctx — RETIRED.** The comfort branch no longer
   live-queries dynamic build state. `nearestComfortSource` (`decide.js`) reads the agent's OWN
   home-belief (trusted only while believed-intact AND confidence ≥ the act-on floor) and otherwise
   falls back to a **static** `shelter`/`rest` Place on the shared mental map (a finished tavern is
   added once as static geography — homes are NOT, so a razed home can't poison shared geography).

Add to this list rather than silently accepting a third — a debt named here with a
retirement path is a design decision; an unnamed one is a regression.

---

## Scalability engineering

The cost model at ~100 agents × `SIM.tickHz` × 8 beliefs × ~15 cheap rules ≈ low tens of
thousands of O(1) evals/sec — trivial — **provided** these hold:

- **Bounded belief tables** — O(k) per agent → O(N·k) total. The single biggest lever, and
  the enforcement guarantees it (no roster scans are expressible).
- **Lazy + cached inference** — compute intent/destination *when a decision needs it*, cache
  on the belief with a TTL, invalidate on contradicting perception. Never re-infer every tick.
- **LOD / amortization** *(✓ landed, Phase 3)* — cognition is tiered by relevance:
  `Simulation._isRelevant` (truth-side, own-state + truth, never a cognition file) marks agents in
  combat/fleeing, locked pursuit, an active role/party, carrying a goal-stack, holding an act-on
  threat belief, recently re-deliberated, near the player, or near their own town centre as
  RELEVANT — those run `reason()` + `decide()` (and `plan()`) EVERY fixed tick; the distant/idle
  tail runs them only every `LOD.stride`-th tick, hung on the existing fixed-tick accumulator
  ([01](01-sim-spine.md)). `perceive`/`decay`/`gossip` stay un-thinned (relevance re-checked each
  tick => a freshly-perceived threat promotes the agent immediately — no missed urgent reaction);
  `act(dt)`/movement stay every frame. Config: `LOD` in `simconfig.js` (`stride`, `fullFidelityBelow`,
  `playerRadius`, `townCentreRadius`, `hostileConf`, `recentWindow`).
- **Shared static facts** — geography / gate / destination candidates precomputed once,
  read-only. Destination *inference* is a cheap lookup, not a per-agent search.
- **Profiled** *(✓ landed, Phase 3)* — the depth harness ([08](08-testing.md), `depthMetrics`)
  carries a **reasoning-cost-per-agent-per-tick** metric (`report().reasoning.cost`): per-tick
  schema evals + `decide()` calls + utility candidates scored + plan replans + max plan depth,
  normalised per **living** agent-sample (a thinned agent contributes 0 on a skipped tick, so the
  metric MEASURES the LOD win). Surfaced in `test/depth.mjs` (context block) and asserted
  sub-linear-in-N by `test/scaling.mjs` (full, N≈50/100/200, LOD-off vs LOD-on) + the fast
  in-suite `test/suites/scaling.mjs` (folded into the headless gate). Measured: at N≈200 the
  metric is ≈4.5/agent-tick, essentially flat from N≈100 (×1.11) and lower under LOD than without.
  Adding breadth is free of compute risk: 50 interactions is 50 data rows over one interpreter;
  cost scales with *firings*, not catalogue size.
- **Bounded derived state** — the per-`(subject, place)` sighting tallies behind association
  beliefs (Phase 4, Ex. 5) are the first state that grows O(beliefs × places). It stays ≤8×8,
  but it is the first spot where the bound needs an **explicit eviction rule** (mirror the
  belief table's least-certain-stalest eviction) rather than falling out of a table size —
  the Phase 3 cost metric watches it from day one.

---

## Roadmap

Each phase is one well-scoped **workflow** (audit → design → implement → adversarially verify
against the soak + the depth/perf harness), so the build-up stays orchestrated and measured.

| Phase | Delivers | Gate |
| --- | --- | --- |
| **0 — Foundation** *(✓ landed)* | belief-gating + restricted ctx (`_cognitionCtx`) + the build-time scan (`test/suites/epistemic.mjs`) + first-cut destination-intent pursuit | **met** — soak green (40+ runs), gate proven to fail on an injected violation, 0 leaks |
| **1 — World-model** *(✓ landed)* | mental-map/places registry (`mentalmap.js`) + affordance-weighted destination-intent inference (TTL-cached, invalidation on re-sight) + the Scarecrow percept wired in | **met** — soak green (incl. epistemic scan, 0 leaks); scarecrow tolerance + pursuit-intercept suite passes; depth 84/100 |
| **2a — Interaction framework** *(✓ landed)* | the `InteractionSchema` IR + interpreter + shared vocabulary + the 6 flagship schemas (all six drive behaviour); the **animacy tally** feeding schema #6; **places-as-percepts** — buildings/own-home as percepts with belief entries (the Scarecrow substrate generalised; affordances gained `shelter`/`rest`), retiring **both** [known debts](#known-debts--leaks-the-gate-cannot-catch) | **met** — soak green (incl. epistemic scan, 0 leaks); the **homecoming test** passes (stale home-intact belief → walk home → discover by sight / decay → reroute, no telepathy); depth floors hold (≈86/100, 19–20 distinct goal-kinds — up from 18 as the schema dispositions became active) |
| **2b — Steering substrate** *(✓ landed)* | the ~12-entry `goal.kind` locomotion enum collapsed → one `steer()` potential-field executor (`js/sim/agent/steer.js`) + a `STEER_FILLS` table of pure `(a,ctx)→field` steer-fills; the named behaviours moved up into data; world-interaction verbs stay explicit (fired on arrival/contact); `fleeFrom`/`followLeader` retired (→ `fillFlee`/`fillFollow`); the Phase-2a dispositions hide/shadow/avoid folded in (goals built inline by `vocab.js`, locomotion by `fillHide`/`fillShadow`/`fillAvoid`) | **met** — fewer code paths, behaviour preserved: soak + scenario + homecoming + percept + schema suites green (incl. epistemic scan, 0 leaks; `steer:` repertoire gate — every baseline goal.kind still emerges), depth held (84/100, 21 distinct goal-kinds, entropy H=0.68) |
| **3 — Scale** *(✓ landed)* | the **reasoning-cost-per-agent-per-tick metric** (`depthMetrics` `reasoning.cost`, in `test/depth.mjs` + `test/scaling.mjs`) + **LOD / amortized cognition** (`LOD` config; relevance-tiered `reason()`/`decide()` cadence on the fixed-tick accumulator; `perceive`/`act`/movement un-thinned so no urgent reaction is missed) | **met** — per-agent cost SUB-LINEAR/flat as N grows (N≈100→200: ×1.13 off / ×1.11 on; LOD-on never raises it, lowers it at every N); soak + scenarios + epistemic scan green; depth floors held (90/100, 20 goal-kinds, H=0.72) |
| **4 — Covert & domestic substrate** | **epistemic atoms** in the planner (`know_assoc`/`know(recipe)` pre/eff; `shadow`/`ask`/`teach`/`quiz` actions that acquire or distribute beliefs), **subject↔place association beliefs** (consolidated from sightings, explicit eviction), the **perception-modelling standoff** (second-order ToM v1, shared by the urchin's stalk and the teacher's curriculum model). Two **economy commits land first**, each baseline-identical via seeding + conservation-preserved: **stored wealth** (purse vs stash — burglable vs lootable) and **recipe-gating** (`knows(recipe_X)` own-state gating production chains). Then the adversarial flagship (**urchin**, Ex. 5) and the cooperative flagship (**teacher**, Ex. 6) over the same substrate; **witness-gated property deeds** (combatEvents' witness logic generalised to crime) | **urchin**: case → infer-stash → burgle end-to-end headless; counter-relocation stales the belief → empty cache; gold conserved. **teacher A/B cohort gate**: a taught cohort beats a same-seed control on trade margin / wilds mortality / time-to-class, gold conserved (tuition is a transfer); **kill the teacher → the next cohort measurably degrades** (knowledge loss is real). If taught ≈ control, the feature fails by its own test |
| **5 — Breadth + capstone** | grow the interaction catalogue (data only) across the [situation library](#the-situation-library-the-design-bar-for-the-catalogue); **place-occupancy (aggregate-strength) beliefs**, group-level `outmatchedBy`, **captive state + the `free` verb** | depth + perf measured each addition; **the camp-rescue capstone** (Ex. 7, `test/suites/camp-rescue.mjs`): 4 beat 30+ **via the scouted window**, the knowledge-blind **control loses** (refused by its own planner or wiped), and a **scout absent at departure never detects the window** (no telepathic raid-sensing) — the proof the catalogue *composes* into operations |

## How we measure

The [depth-eval harness](08-testing.md) (`bun test/depth.mjs`, `depthMetrics.js`) is the
behavioural-richness gauge — behavioural repertoire/entropy, ToM belief richness, cross-system
interaction. Phase 3 adds a perf budget (reasoning cost/agent/tick). A phase lands only when it
raises depth without breaking the soak, the enforcement gate, or the per-agent cost ceiling.

---

*See also: [02 — the epistemic split](02-epistemic-split.md) (the invariant this extends),
[01 — the simulation spine](01-sim-spine.md) (the tick cadence the tiers hang on),
[03 — RPG/abilities](03-rpg-abilities.md) (the data-only IR precedent),
[05 — economy & journalism](05-economy-news.md) (the GOAP goals/planner this threads through),
[08 — testing](08-testing.md) (the soak + depth/enforcement gates).*
