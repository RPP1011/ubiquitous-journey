# 10 — The action grammar & the knowledge model

> **Status: DESIGN — not yet implemented.** This is the target form of the reasoning layer's
> **deliberative tier** (`planner.js` actions + the propositions they read/write). It supersedes
> the concrete Phase-4 Step-2 primitives (`shadow`/`approach`/`know_assoc`), which are a first,
> hand-coded instance of what this generalises. The reasoning-layer overview is
> [09](09-reasoning-layer.md); the locomotion counterpart (one `steer()` + `STEER_FILLS`) is
> [09 §Composition](09-reasoning-layer.md#composition-finite-primitives-open-behaviours). Read
> those first — this doc is the world-interaction half of "finite primitives, open behaviours,"
> plus the knowledge substrate it reads.

---

## 1. The problem: a grammar that couples verb with purpose

The naïve way to add behaviours is one primitive per situation: `buy`, `loot`, `burgle`, `coerce`,
`tax`, `beg` — six primitives that are all *acquire a resource*, reached six ways. Or `shadow`
welded to "learn where a mark stashes," when the *same* surveil should also learn a recipe, or a
camp's strength. Each primitive fuses four independent things:

```
burgle  =  VERB(seize) ⊗ SOURCE(stash) ⊗ THEME(gold) ⊗ EFFECT(have gold)
```

That couples `verb × object × method × framing`, and the product is what explodes — *later*, once
the catalogue grows past a dozen situations. The whole point of [09 Ex. 7](09-reasoning-layer.md)
("the catalogue *composes*, no new behaviour code") is to never pay that product. This doc is the
grammar that makes it true.

---

## 2. Two levels: effects ⟂ actions (the verbs are neither)

There are exactly two levels, and the named verbs are **sugar over them**:

- **Effects** — *what changes*; the planner's **parameterized goal-currency**. A small, fixed
  vocabulary the backward-chainer reasons in: `Have(R)`, `At(place)`, `NeedMet(need)`,
  `Know(topic)`, `Believes(subj, topic)`, `Dead/Freed/Intact(entity)`. The parameter is a typed
  term, so one effect family spans many situations.
- **Actions** — *what the agent does*; each declares the effect it produces. The planner chains on
  effects and **selects actions by cost**.

**Actions are surface labels over `(effect + parameter-row)`.** `burgle ≡ (Have(gold),
source=stash, transfer, covert→theft)`. The planner never refers to "burgle"; it chains on
`Have(gold)` and picks the cheapest feasible row. The **irreducible grammar is the effects + the
dimension-values** (`source`, `conserves?`, `consent`, `channel`, …); `buy`/`loot`/`burgle` are
nicknames for points in that space, so a new action is a new **row (data)**, not new code.

> This is Schank's Conceptual Dependency: every surface verb = a primitive act + modifiers.
> `Transfer` is **ATRANS** (transfer of possession), `Learn`/`Inform` are **MTRANS** (transfer of
> mental info), `Move` is **PTRANS** (physical transfer of location). `buy` and `steal` differ only
> in the consent modifier; `tell` and `teach` are both MTRANS. The grammar is that decomposition.

---

## 3. The effect vocabulary — and why the blank cells are the invariants

Every action changes *some* state. The producible effects partition cleanly by **(whose? × which
aspect?)**:

| aspect | self | another entity |
| --- | --- | --- |
| location | **Move** → `At` | ∅ — they move themselves (no-roster) |
| possessions | **Transfer** → `Have` / `Received` | only as a *side-effect* of Transfer (give/seize), never my direct reach |
| condition | **Tend** → `NeedMet` | ∅ |
| knowledge | **Learn** → `Know` | — |
| a mind | — | **Inform** → `Believes` (*my* model) → perception/gossip bridge (optimistic, may not land) |
| physical world-state | — | **Affect** → `Dead/Freed/Intact` |

Six reachable cells, six effect-producers. **The blank cells are the founding constraints made
visible**: I cannot directly move, feed, or decide *for* another agent (they act for themselves —
the no-roster rule), and a foreign *mind* is writable only *through* `Inform`'s bridge (the
epistemic split). The grammar's empty cells are not gaps; they are the invariants.

A note on `Tend` vs `Transfer`: `Have(food)` is *possessing* food; `NeedMet(hunger)` is having
*eaten* it. `consume` bridges one to the other (`pre: have(food); eff: NeedMet(hunger)`), so
condition is a distinct effect class, not a sub-case of possession.

---

## 4. The action tables (the rows that stamp out the verbs)

Each effect's actions are a table whose **columns are the genuine differences**. The combinatorial
product collapses to *rows + dimension-values*, not enumerated primitives.

```
Transfer → Have      columns: source-kind × conserves? × consent→deed
   gather (node,   MINT,     —→labour)        produce (self+recipe, MINT, craft)
   buy    (market, transfer, consent)         loot    (corpse,       transfer, ownerless)
   filch  (stash,  transfer, covert→theft)    seize   (holder,       transfer, force→robbery)
   levy   (holder, transfer, authority→tax)   beg     (holder,       transfer, charity→alms)
   give/pay (self→other, transfer, consent→received)         # Transfer is bidirectional

Learn → Know         columns: channel  ( = the provenance tiers )
   observe (first-hand → source:witnessed)    ask (testimony → source:talked, hops+1)
   study   (instruction → source:taught)      # topic is a PARAMETER — see §5

Inform → Believes    columns: channel × veracity
   disguise (show-false)  demonstrate (show-true)  rumor (tell-gossip)
   command  (tell-imperative, +authority pre)   teach (tell-true-instruction)

Affect → state       columns: target-state
   strike → Dead      free → Freed      wreck → ¬Intact

Tend → NeedMet        columns: need
   eat   rest   heal   socialize
```

`conserves?` is **load-bearing**: `gather`/`produce` *mint* a good from a node/recipe (production
from the environment); the rest *transfer* existing wealth — the closed money loop. Collapsing a
mint row with a transfer row would break conservation, so they stay distinct rows.

---

## 5. The knowledge model

`Know(topic)` is the part the grammar most depends on and the part that needs real design: the
planner's covert and cooperative families (urchin, teacher, scout, blackmailer, framer) are all
"acquire/act-on a belief." Knowledge in the codebase today is **scattered across stores with
inconsistent metadata** — relational facts on the belief table (with confidence/provenance/decay),
but `recipes` a bare `Set`, `priceBeliefs` a bare map, second-order a one-off scalar (`notoriety`).
This section unifies them.

### 5.1 A topic is a proposition

A `topic` is a proposition an agent can hold, of the form `Relation(args)`. The catalogue the 35
[situation-library](09-reasoning-layer.md#the-situation-library-the-design-bar-for-the-catalogue)
scenarios require:

| topic | meaning | value | about | scenarios |
| --- | --- | --- | --- | --- |
| `Loc(subj, role)` | where subj keeps its *role* place (stash/home/workshop) | position | a subject | urchin, espionage |
| `Whereabouts(subj)` | where subj is now | position | a subject | dead-vendor, pursuit |
| `Strength(place)` | aggregate force/occupancy at a place | number ≈N | a place-percept | camp rescue, siege |
| `State(place, attr)` | place is depleted / infected / closed / sheltered | enum/bool | a place-percept | famine, plague, curfew, homecoming |
| `Recipe(good)` | how to make a good | grade 0..1 | **a good (world)** | teacher, espionage |
| `Price(good, place)` | what a good clears at, where | number | a (good × place-percept) | arbitrage |
| `Secret(subj)` | subj has a shameful fact (leverage) | bool + tag | a subject | blackmail |
| `Owns(subj, place)` | subj owns a place | bool | a subject↔place | eviction, inheritance |
| `StandingToMe(subj)` | how subj regards me | number | a subject (2nd-order) | courtship, rep-laundering |
| `Believes(subj, topic)` | subj believes *topic* | nested topic | a subject (2nd-order) | framing, deception, command |

**Almost every topic is *relational*** — a fact about an entity already in the belief table (agents
*and* place-percepts, since [places are percepts](09-reasoning-layer.md)). `Recipe(good)` is the
lone genuinely *world* topic (a craft skill, owned by no one). `Price` is relational-on-a-market.

### 5.2 The metadata invariant (the engine of wrong / gossip / forget)

> **Every knowable carries `{ value, confidence ∈ [0,1], provenance (source tag + hops), lastTick }`.**

This is the non-negotiable. It is *already* true for belief-table fields, and it is exactly what
lets a fact be **wrong** (acted on falsely → the urchin's stale stash), **spread** (gossiped with
fading confidence + provenance), and **forgotten** (decayed). That triad is the engine behind *all*
of deception, staleness, and learning. Knowledge that lacks it — today's `recipes` Set, `priceBeliefs`
map — cannot participate: a recipe can't be imperfectly taught, mis-learned from a fraud, or lost
when the last apothecary dies. **Unifying the metadata, not the storage, is the design.**

### 5.3 Storage: extend the belief table, don't replace it

The belief table is *already* the knowledge substrate with the right metadata. So:

- **Relational topics → fields on the `(observer → entity)` BeliefState.** `Whereabouts` is the
  existing `lastPos`+`confidence`; `Loc` is the Step-2 `assoc`; `Strength`/`State` are fields on the
  entity's place-percept belief; `Secret`/`Owns`/`StandingToMe`/`Believes` are new belief fields.
  These ride the existing gossip + decay machinery for free.
- **The world topic `Recipe(good)` → an own-state map that gains the *same metadata shape*:**
  `recipes: Map<good, { grade, conf, source, lastTick }>` (replacing the bare `Set`). It is *not*
  forced onto the belief table (a good is not an entity), but it carries value+confidence+provenance+
  decay so the *same* operations apply.
- **`Know(topic)` is a typed accessor** that dispatches by `topic` to the right store. The
  uniformity lives in the **metadata + the accessor interface**, not in one monolithic store.

> Rejected alternative: a single monolithic knowledge store subsuming beliefs + recipes + prices.
> Cleaner on paper, but a high-risk re-home of the working N² belief table for no behavioural gain.
> Extend, don't replace.

### 5.4 The accessors

- **`Know(topic)` (read — `atomHolds`):** dispatch by topic kind. Relational → read the entity's
  belief field, satisfied when present **and `confidence ≥ τ`** (a confidence floor, so a vague
  rumour doesn't satisfy a precondition a heist depends on). `Recipe` → read the own-state recipe
  map, satisfied when `grade·conf ≥ craftThreshold`.
- **`Learn{channel}(topic)` (write — the actions):** all three accrue *evidence* toward a topic and
  consolidate it (the Step-2 `recordAssocSighting` generalised to `recordEvidence(topic, gain)`):
  - `observe(target, topic)` — first-hand surveil; high consolidation confidence; `source:witnessed`.
  - `ask(informant, topic)` — testimony; written at gossip-confidence; `source:talked, hops+1`;
    cheaper but noisier (and may alert the subject).
  - `study(teacher, topic)` — instruction; high trust; `source:taught`; `pre: near(teacher) ∧
    gold≥tuition`. (The *teacher's* side is `Inform{teach}` — §4.)
- **Gossip** propagates a topic exactly like any belief — `gossipBeliefs` already does this for
  hostility/whereabouts; it extends to `Loc`/`Recipe`-rumour/`Price`/`Strength` with the standard
  confidence-cap + `hops`. A *tip* is plan-cost saved (the chain collapses when gossip pre-supplies
  the topic).
- **Decay** fades confidence on the shared schedule (`beliefs.decay`); world topics decay via the
  same metadata — an unused, untaught recipe fades toward *lost*.

### 5.5 Worked lifecycles (the model expressing real knowledge)

1. **Recipe scarcity through turnover** — a master holds `Recipe(potion)` at `conf 0.9, source:taught`
   → `produce` (conf gates craft quality/failure) → `Inform{teach}` to an apprentice whose `study`
   writes `conf 0.7` → over generations, untaught lines **decay** → the last knower dies → town-wide
   `Recipe(potion).conf → 0` → potions vanish → scarcity → price spike → a Gazette story. The spec's
   economy story, now mechanical, *because recipes carry the metadata*.
2. **Arbitrage bust** — `Price(good, townB)` held at conf, **gossiped** (everyone reads the same
   number) → I plan the haul → on arrival the real clearing < believed (herding already priced it) →
   my `Price` belief was *stale* → bust + replan. Identical staleness machinery to a stale
   `Whereabouts`.
3. **Blackmail** — `observe(mark)` accrues `Secret(mark)` evidence → consolidates at conf →
   `Know(Secret)` satisfied → `coerce`. If the secret-belief was a **false** low-evidence
   consolidation, the mark calls the bluff (and now holds a hostile belief about me).
4. **Framing (second-order)** — I hold `Believes(townsfolk, I'm-guilty)` at conf — itself acquired by
   `observe`-ing their accusatory behaviour toward me — and a schema fires flee/petition. The
   second-order topic is just another belief field with the same metadata.

---

## 6. Grammar ⟂ executor — nothing is a grammar one-off

Every action is `(effect, parameterized row, terminal verb)`. The idiosyncrasy lives **one layer
down**, in the **executor** the terminal verb fires on arrival (dispatched off `exec.verb` in
`act.js`, already separate from the planner):

| action | terminal verb | executor (where the real, varied code is) |
| --- | --- | --- |
| `strike` | a blow | the combat state-machine (repeat, block, hp accrual) |
| `filch`/`burgle` | take | conserved gold transfer (`deliverTo`-style) |
| `free` | unbind | flip the captive's `held` flag, truth-side (like combat resolves hp) |
| `observe` | watch | evidence-accrual into the topic's store (§5.4) |

`free` looks bespoke but **factors exactly like `burgle`** — a trivial terminal act gated by hard
preconditions (`at(captive) ∧ unopposed`), where `unopposed` decomposes through
`Learn{observe}(Strength)` + the scouted window + `Move`. So **"one-off" means a one-off *executor*,
never a one-off grammar entry.** The grammar stays uniform; executors are where idiosyncrasy is
allowed and expected.

---

## 7. The collapses (the minimality proof)

Demanding that every verb justify a distinct effect-cell or dimension-point deletes four would-be
primitives — proof the basis is minimal, not arbitrary:

- **`Standing`/`Influence` as an effect → dropped.** "Raise subj's regard for me" is `Transfer(give)`
  to the subject, whose bridged consequence is a standing shift, tracked as the actor's second-order
  `Believes(subj, StandingToMe↑)`. Courtship = give-gifts + watch the belief.
- **`Produce` as a top-level verb → dropped.** It is a `Transfer{mint}` row.
- **`approach` → dropped.** It is `Move` to a **know-gated place** (resolves via `Know(Loc)`; if
  unknown, `Move`'s precondition *is* `Know(Loc)`, which inserts `Learn{observe}`). **This deletes
  the `approach` primitive added in Phase-4 Step 2.**
- **`shadow`'s triplication** (a vocab response, a steer-fill, a planner primitive) → one
  `Learn{observe}` whose locomotion *is* the shared steer-fill.

---

## 8. Runtime shape: this is *not* a behaviour tree

The opposite — and that opposition is why GOAP was chosen. A behaviour tree is an *authored*
control-flow graph that grows with the number of behaviours and is walked by every agent. Here there
is no such structure. The runtime is **four flat sets + one generic searcher, none of which knows
what "arbitrage" or "blackmail" is**:

1. a flat set of ~30 **action rows** (`PRIMITIVES`, mostly generated from the §4 tables) — no action
   references another; a dictionary, not a graph;
2. a flat set of **goal-generators** (`motivation.deriveGoals`) reading an agent's *own*
   needs/beliefs/memory;
3. one generic **backward-chainer** (`plan()`, ~150 fixed lines) with **zero scenario knowledge**;
4. a flat set of reactive **schema rows** ([the InteractionSchema catalogue](09-reasoning-layer.md#the-interactionschema-ir-landed-phase-2a)).

```
authored & shared (small, fixed):          per-agent & derived (transient, discarded):
  ~30 action rows ─────────────┐
  ~N goal-generators           ├──►  plan(A, goalA) → A's 4-step heist
  plan()  (~150 lines)         │     plan(B, goalB) → B's 2-step trade
  ~M reactive schema rows ─────┘     reason(C)      → C flees
```

The "behaviour tree" for camp-rescue is **built on demand, per-agent, per-tick, from that agent's
beliefs — a transient ~8-node search tree — and thrown away.** The 35 scenarios are not 35 things in
the code; they are emergent *paths* through the same ~30 rows under different belief-states. **Code
grows with the basis (~rows); behaviours are the emergent compositions.** Agents share the *grammar*
(a dictionary + syntax), never a behaviour — like speakers of one language producing different
sentences; the variation lives in the N² belief table, not in shared control flow.

Cost: planning runs only on a goal change or replan trigger, is hard-bounded (`maxDepth 5`,
`maxFrontier 64`, `maxPlan 8`), and is amortised by [Phase-3 LOD](09-reasoning-layer.md) — the
sub-linear *reasoning-cost-per-agent-per-tick* the depth harness gates.

---

## 9. What the grammar expresses (coverage + the real control-structures)

All 35 situation-library scenarios are expressible: **~29 fully in-paradigm** (needing only *data* —
the §5.1 topics, the §4 rows, a `sanctuary` affordance, a `group-outmatchedBy` predicate, one
pool/institution percept); **5 have a temporal component** (debt/tax cadence, child-provisioning,
siege rationing, periodic conscription) whose *actions* are supported but whose *recurrence/deadline*
is the one genuine partial gap (softenable: a deadline is a place-state that flips, a cadence is a
memory-triggered re-derivation); **1 is a deliberate tier-boundary** (a combat feint — fighter SM).

Tracing the hard ones through the *real* planner (not the one-line caricature) surfaces three control
structures the grammar must — and does — support, all on existing machinery:

- **Cost-min ≠ profit-max.** Economic plans (arbitrage, cornering) *emerge* when local options are
  exhausted; the planner finds the cheapest feasible path and replans when a shared price-belief
  proves stale (the bust). It never "chases profit."
- **Social actions are optimistic + reactive + budgeted, not chains.** `feign`/`coerce`/`bribe`/
  `command`/`court` are `Inform` → own second-order belief, *arm a reaction*, and **expire** (the D4
  goal-expiry) if the other doesn't play along — with a real downside (exposure, a hostile belief
  planted in the mark). "A plan" here is *act to shift the odds, arm a reaction, expire if the bet
  fails.*
- **Operations are multi-phase: refuse-gate + event-window.** Camp-rescue/siege are *refuse → scout →
  detect window → exploit*, gated on aggregate beliefs (`Strength`, group-`outmatchedBy`), with a
  knowledge-blind control that **provably loses** (the win must *be* the knowledge).

The tax across all of them: **the belief a plan reads must first be *populated*** — prices by gossip,
`Strength` by a scout, a `Secret` by surveillance. The plan can't form until the world-model carries
the fact, which is exactly what makes the behaviour *believable* (act on stale/absent info → wasted
trip, called bluff, missed window) rather than omniscient.

---

## 10. Implementation & sequencing

**Form.** The backward-chainer is unchanged; the actions are **generated from the §4 dimension
rows** (`PRIMITIVES = [...CORE, ...TRANSFER.map(makeRow), ...LEARN.map(makeRow)]`) — the codebase's
own IR-as-data idiom (*a behaviour is a row, not a branch*, identical to the schema catalogue and the
ability DSL). The knowledge model (§5) lands as: the topic accessors (`Know`/`recordEvidence`), the
belief-field extensions, and `recipes` re-homed from `Set` to the metadata map.

**Sequencing** (each step behaviour-preserving, gated by `bunx tsc --noEmit` + `bun test/headless.mjs`
+ `bun test/depth.mjs`; new features day-one OFF behind config flags, byte-stable soak):

1. **Knowledge axis first** — the §5 model + `Know(topic)` + `Learn{observe/ask/study}`. Generalise
   Step-2's `know_assoc → Know(topic)`, fold `shadow → observe(Loc)`, **delete `approach`** (→ `Move`
   to a know-gated place). This is where Phase-4 lives, and it makes the **teacher fall out as
   `Learn{study}(Recipe)`** reusing one machine.
2. **Resource axis** — fold `buy`/`gather`/`produce`/`loot`/`burgle` into the generated
   `Transfer{method}` table.
3. **The rest of the §4 rows + §5.1 topics**, as Phase-5 breadth demands them — each a row/field, not
   new code: `Transfer{filch/seize/levy/beg}`, the `Believes` effect (the highest ToM lever),
   `Affect{wreck/free}`, the place-state/`Strength`/`Secret`/`Price` topics.

The [Phase-5 gap shortlist](09-reasoning-layer.md#probe-backed-gap-analysis-the-phase-5-priority-order)
is, in these terms, almost entirely **rows / fields / topics — data, not code.**
