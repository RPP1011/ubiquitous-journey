# Test scenarios: memory-derived goals + planner

Companion to `goal-system.md`. These are the scenarios Phase A/B must turn green. They
run headless (`bun test/headless.mjs`). Two flavours:

- **Unit** — construct explicit agent/world state (inventory, gold, position, beliefs,
  a pushed goal) and assert a deterministic outcome. No RNG; the planner is deterministic
  given state + beliefs (cost-min with a fixed tie-break). Model: the existing combat unit.
- **Soak** — the stochastic 12k-frame run; asserts invariants, not specific outcomes.

Notation: `give(food×2 → X)` = the primitive; `[a → b → c]` = an ordered plan; `X.recv` =
the predicate "X received value from me".

---

## A. Primitives (precondition / effect / conservation)

- **A1 give conserves goods.** A.food=5, B.food=1, A adjacent to B. `give(food×2→B)`
  → A.food=3, B.food=3; `sum(food)` unchanged. ✔ effect + conservation.
- **A2 give gated by precondition.** (a) A not adjacent to B → no-op, no transfer.
  (b) A.food=0 → no-op. Neither throws.
- **A3 pay conserves gold.** A.gold=50, B.gold=10, adjacent. `pay(20→B)` → A=30, B=30;
  `sum(gold)` unchanged. `pay(amt>gold)` → no-op.
- **A4 effect predicate fires.** After A1, the planner predicate `B.recv` evaluates true.

## B. Planner — synthesis, cost, belief-divergence (the emergence)

Each: push goal `repay(X)` (predicate `X.recv`) onto an agent, call the planner, assert the
returned plan. X is a fixed nearby townsperson.

- **B1 well-formed plan.** Any capable agent → non-empty plan; last step is `give`/`pay`
  targeting X; every step's precondition is satisfiable by the prior steps' effects from
  the agent's believed state (no gaps).
- **B2 from stock (farmer).** Agent holds surplus food → `[goto(X) → give(food→X)]`. No
  market trip.
- **B3 pay gold (merchant).** Agent has gold, no giveable surplus, goal accepts coin →
  `[goto(X) → pay(gold→X)]`. Uses `pay`, not `give`.
- **B4 acquire-first (emergent multi-step).** Goal demands a *good* (gift of food); agent
  holds none but has gold near a market → `[goto(market) → buy(food) → goto(X) →
  give(food→X)]`. The branch nobody authored.
- **B5 cost picks the cheaper means.** Agent has BOTH stock food AND gold, market far →
  plan uses from-stock `give`, NOT `buy` (assert no market step). Remove the stock → it
  switches to buy/gather.
- **B6 belief divergence.** Two agents identical except `priceBeliefs`/position (one by the
  market, one far; or differing professions) → for the same goal, their plans (or plan
  costs) differ. Same goal, different lived understanding → different plan.
- **B7 infeasible → graceful.** Agent with no gold, no stock, no usable profession, no
  reachable market → planner returns null; goal is flagged unreachable and
  abandoned/expired. No throw.

## C. Execution & replanning

Drive the real frame loop (`sim.update → fighter.update → resolveCombat`) with the agent
holding a goal; the planner's current step is the high-priority candidate.

- **C1 plan completes.** `[goto(X) → give(food→X)]` runs to completion: predicate true →
  goal popped; X.food increased by the gifted amount; gold/goods conserved.
- **C2 replan on moved target.** X relocates mid-plan → the `goto` re-targets X's new
  believed pos (or a replan occurs); plan still completes.
- **C3 replan on lost precondition.** Plan was `buy(food)` but the agent's gold is spent /
  believed price now exceeds gold → precondition fails → replans to `gather` (if a node is
  known) or abandons. No crash.
- **C4 resume after interruption.** Agent mid-plan toward X; a hostile spawns adjacent →
  that tick the goal is `flee` (utility out-scores the plan step) and the agent does NOT
  keep walking to X; remove the threat → the goal is still on the stack and the plan
  resumes to completion.

## D. Goal stack

- **D1 dedup.** `deriveGoals` twice on the same memory → exactly one goal instance.
- **D2 LIFO interrupt + resume.** Agent pursuing `seek_fortune`; gets assaulted →
  `avenge` pushed on top → pursues avenge; aggressor dies → `avenge` pops → `seek_fortune`
  is top again and resumes.
- **D3 depth cap.** Push > cap (4) goals → `goals.length == 4`; the lowest-priority/oldest
  was dropped.
- **D4 expiry.** A short-`expiresAt`, unsatisfiable goal drains after its timeout (removed).

## E. Memory-derived goals (integration)

- **E1 robbery → avenge → resolve.** A attacks B (B survives) → B gains an `assaulted`
  memory → `deriveGoals` pushes `avenge(A)` → B plans `Defeat(A)` = `[goto(A) →
  attack(A)…]`; drive until B kills A → `avenge` predicate true → popped.
- **E2 windfall → seek_fortune.** Inject a `windfall` memory (place=market) → `seek_fortune`
  pushed → pops when `gold ≥ target`.
- **E3 revenge re-homed.** `seedRevenge` no longer mutates `ambition`; after an assault the
  victim's `ambition` is unchanged and an `avenge` goal appears on `goals` instead.

## F. Soak / regression (stochastic, already in harness)

- **F1 no freeze.** 12k frames with the planner active, no throw.
- **F2 conservation.** `sum(gold)` constant across the soak (give/pay/quests don't mint).
- **F3 prior systems intact.** Beliefs form, ambitions progress, groups form, memory
  consolidates — all still pass.
- **F4 report (not asserted).** Count agents with active goals/plans; print a few sample
  plans next to the biographies, e.g. `Mira: repay Tomas → [goto market, buy bread, goto
  Tomas, give bread]`.

---

## G. Whole-system scenario tests (full stack, end-to-end)

The unit scenarios (A–E) prove each mechanism alone. These run the **real `Simulation`**
with a curated cast through the **real frame loop** (`sim.update → fighter.update →
resolveCombat → onCombatEvents`) and assert the **causal chain across every layer**:
perceive → beliefs → memory → derivation → planner → act → consequence. This is what
proves the *narrative engine*, not just the parts.

Setup is deterministic (construct/place named agents, set their state); assertions are on
**eventual** outcomes within a tick budget, tolerant of combat-swing RNG. Each scenario
asserts an ordered chain of checkpoints, not a single value.

**Harness needed** (`test/scenarios.mjs`, built in Phase A): a Simulation of
`HeadlessFighter`s with a **named cast** at fixed positions and set
inventory/gold/beliefs/standing, plus helpers — `inject(agent, memory)`,
`push(agent, goal)`, `runFrames(n)`, `runUntil(pred, maxFrames)`, and per-checkpoint
asserts. Reused by every G scenario.

### G1 — The Grudge (revenge, full stack) — Phase A
Cast: peaceful farmer **B**, aggressor **A**, bystander **C**, in sight of each other.
Script: A strikes B once (B survives). Assert the chain:
1. B (and witness C) hold a hostile, negative-standing belief about A.
2. B has an `assaulted` memory of A.
3. Within K ticks `avenge(A)` is on `B.goals` — and `B.ambition` is **unchanged** (revenge re-homed).
4. B's plan is `Defeat(A)`: B moves to A's believed position and attacks.
5. Within budget A dies → `avenge` pops → B records a closure memory.
6. Gold/goods conserved throughout.

### G2 — The Repayment (planner end-to-end, the emergence) — Phase A
Cast: benefactor **X**; debtor **D**. Setup: push `repay(X)` on D (Phase B: derive it from a
staged `succoured` memory instead). Assert: D synthesizes a plan from its own means, executes
it live (travels, acquires if needed, hands over), `X.recv` becomes true, goal pops, conserved.
Run the **same** scenario three ways — D = food-rich farmer / coin-rich merchant / must-buy
laborer — and assert all complete via **different plans** (emergence, observed end-to-end).

### G3 — The Windfall (fortune, full stack) — Phase A
Cast: trader **T**. Script: T realizes a large-profit sale → `windfall` memory. Assert:
`seek_fortune` pushed → T plans + pursues earning (produce/sell) → gold crosses target → pops.

### G4 — Interrupted on the road (resume, full stack) — Phase A
Cast: D pursuing a `repay`/`avenge` plan toward a distant target; monster **M** placed on D's
path. Assert: while M is near, D's tick goal is flee/fight M (NOT continued travel); after M is
gone, the original goal is still on `D.goals` and the plan **resumes** to completion.

### G5 — Grief & vendetta (full stack) — Phase B
Cast: friends **B** & **C** (mutual high standing), killer **A**. Script: A kills C in B's
sight. Assert: B records a high-salience `witnessed_death(C)` (grief), pushes `grieve`
(+ `avenge(A)`, culprit known), behaves accordingly, then resolves/decays.

### G6 — Two debtors, divergent plans (emergence in the wild) — Phase A
Cast: X, plus D1 (food-rich) and D2 (coin-rich) both owing X; push `repay(X)` on both. Assert
both complete via **different** primitive plans, world stays conserved.

---

## Coverage map

| layer                    | scenarios            | phase |
|--------------------------|----------------------|-------|
| primitives               | A1–A4                | A |
| planner core             | B1–B5, B7            | A |
| belief divergence        | B6                   | A |
| execution/replan         | C1–C4                | A |
| goal stack               | D1–D4                | A |
| memory→goals             | E1, E3               | A |
| memory→goals             | E2 (+ grieve/delve)  | B |
| soak/regression          | F1–F4                | A (kept green throughout) |
| **full-stack scenarios** | **G1–G4, G6**        | **A** |
| **full-stack scenarios** | **G2(derived), G5**  | **B** |
