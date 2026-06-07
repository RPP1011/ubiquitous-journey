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
> - **Phases 1–4 (designed)** — the mental-map + richer destination-intent inference, the
>   `InteractionSchema` framework, the steering substrate, LOD/amortization. Marked
>   *(designed)* below until landed.
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
- **Mental map** *(designed)* — the agent's known **places**: town gates (`walls.js`),
  POIs (`world.js`), landmarks (`arena.js`), and its *believed* home/hideout. A handful of
  entries, read-only, shared static geography. Queried by affordance (`affords('exit',
  'conceal', 'safe', 'crowd')`), never by scanning the roster.

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
- **one locomotion primitive** — `steer(attractors[], repulsors[], speed)`.

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

### The belief table *is* the potential field

Each belief contributes a force; steering is the weighted sum over my ≤8 beliefs + ≤8 known
places — **O(k), trivially cheap, and belief-gated by construction** (the field is literally
made of beliefs):

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

**Effect on the current code:** the ~12-entry `goal.kind` enum
(`work/flee/fight/wander/market/comfort/…`) **collapses** into one steering executor +
the handful of verbs; the named behaviours move *up* into tier-1 data. Fewer code paths,
unbounded behaviours.

---

## The `InteractionSchema` IR *(designed)*

A schema is a data entry the interpreter evaluates — the social analogue of an
`AbilitySpec`:

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

### Five flagship interactions — as data

Five very different behaviours — flee, intercept, hide, suspect, scatter — each ~6 lines
reusing the *same* primitives. A new interaction is a data row, not a branch in `decide.js`.

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

## Destination-intent inference *(designed)*

The one piece of real "new code," and it is tiny and bounded — **Theory of Mind, not
dead-reckoning.** When an agent loses sight of a pursued subject it does **not** extrapolate
a velocity; it infers *where the subject is trying to go* from its last-seen heading + known
geography + context, and intercepts there.

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

**What to notice:** one executor, many behaviours (every locomotion is a steer-fill);
GOAP runs in belief-space end-to-end, so planning, replanning, pursuit, and *mistakes* all
flow through the same pipe; deliberative depth is all tier-1 (amortized), tier-3 per frame
is just *steer + maybe a verb*.

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

---

## Scalability engineering

The cost model at ~100 agents × `SIM.tickHz` × 8 beliefs × ~15 cheap rules ≈ low tens of
thousands of O(1) evals/sec — trivial — **provided** these hold:

- **Bounded belief tables** — O(k) per agent → O(N·k) total. The single biggest lever, and
  the enforcement guarantees it (no roster scans are expressible).
- **Lazy + cached inference** — compute intent/destination *when a decision needs it*, cache
  on the belief with a TTL, invalidate on contradicting perception. Never re-infer every tick.
- **LOD / amortization** — tier cognition by relevance: agents near the player reason fully
  each tick; distant/idle agents run a thinned schema set or a slower cadence (hang it on the
  existing fixed-tick accumulator, [01](01-sim-spine.md)).
- **Shared static facts** — geography / gate / destination candidates precomputed once,
  read-only. Destination *inference* is a cheap lookup, not a per-agent search.
- **Profiled** — extend the depth harness ([08](08-testing.md), `depthMetrics`) with a
  **reasoning-cost-per-agent-per-tick** metric so "tractable" is *measured*. Adding breadth is
  free of compute risk: 50 interactions is 50 data rows over one interpreter; cost scales with
  *firings*, not catalogue size.

---

## Roadmap

Each phase is one well-scoped **workflow** (audit → design → implement → adversarially verify
against the soak + the depth/perf harness), so the build-up stays orchestrated and measured.

| Phase | Delivers | Gate |
| --- | --- | --- |
| **0 — Foundation** *(✓ landed)* | belief-gating + restricted ctx (`_cognitionCtx`) + the build-time scan (`test/suites/epistemic.mjs`) + first-cut destination-intent pursuit | **met** — soak green (40+ runs), gate proven to fail on an injected violation, 0 leaks |
| **1 — World-model** | mental-map/places registry + destination-intent inference + predicted behaviour | belief-gated pursuit works (scenarios reconciled); scarecrow test passes |
| **2 — Interaction framework** | the `InteractionSchema` IR + interpreter + the 5 flagship schemas; collapse `goal.kind` → steer-fills | depth harness shows new distinct behaviours + higher entropy |
| **3 — Scale** | LOD / amortized cognition + the reasoning-cost metric | per-agent reasoning cost flat as N grows |
| **4 — Breadth** | grow the interaction catalogue (data only) | depth + perf measured each addition |

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
