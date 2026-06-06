# Refactor plan — SRP modularization

Status: **planning**, for approval. Goal: split the god-objects into
single-responsibility modules so (a) each file has one reason to change and
(b) independent work hits **disjoint files** → future workflows parallelize
instead of serializing. **Purely structural — zero behavior change.** The
163-check headless suite is the invariant: it must stay green with **no
assertion edits**.

## The offenders (one file, many responsibilities)

| file | responsibilities it currently mixes |
|---|---|
| **`js/sim/agent.js`** (~700 lines) | state/identity · perception+gossip · decision (utility, occupation chooser, ambition, goal-stack, party) · action (act dispatch, **movement**, production, combat-step, flee/follow, controlled) · trade/market interface · ability casting · visual decor/label |
| **`js/sim/simulation.js`** | orchestration (spawn/tick/dispose) · the market double-auction · combat→belief/rep/memory folding · the bus deed-router |
| **`js/main.js`** | renderer/scene/camera bootstrap · HUD panel wiring · player input (cast/gather/dialogue/keys) · the frame loop · game state |
| **`test/headless.mjs`** | combat unit · soak · planner · execution · memory-goals · abilities · econ — all in one file |

`agent.js` is the keystone: movement, decision, leveling-hooks, and terrain all
live there, which is why every recent task collided on it.

## Target module map (SRP)

**Agent: a thin STATE class + behavior modules** (the data-and-functions split).
`Agent` holds state and exposes the same method names the sim already calls
(`perceive/decide/act/...`), each a one-line delegate to a free function. Logic
moves out; call sites are untouched.

- `js/sim/agent.js` — the `Agent` class: fields + thin delegating methods. Nothing else.
- `js/sim/agent/perception.js` — `perceive`, `gossipBeliefs`, `priceGossip` (ToM intake).
- `js/sim/agent/decide.js` — `decide` (utility scorer), `chooseOccupation`, `_decideParty`; calls deriveGoals/pruneGoals. **(the flee/work hysteresis fix lands here.)**
- `js/sim/agent/movement.js` — `_goTo`, flee vector, follow-slot positioning, facing/arrive. Pure locomotion. **(movement tweaks land here, alone.)**
- `js/sim/agent/act.js` — `act` dispatch, `_produce`, `_combatStep`, `actControlled`, ability-cast trigger (uses movement).
- `js/sim/agent/trade.js` — `keepOf/surplus/wantQty/sellQty/askPrice/bidPrice/applyBuy/applySell/learnPrice`.
- `js/sim/agent/decor.js` — `_buildDecor`, `_updateLabel`, `setLabelVisible`, `profColor` (visual; already DOM-guarded).

**Simulation: orchestration vs. mechanics**
- `js/sim/simulation.js` — constructor (wires subsystems), `spawn`, `update` tick loop, `dispose`, `_ctx`. Orchestration only.
- `js/sim/market.js` — `_runMarket` (the standing-order double auction).
- `js/sim/combatEvents.js` — `onCombatEvents` (combat → beliefs/reputation/memory/grudge folding).
- `js/sim/deedRouter.js` — the bus subscription + `_recordDeed` (events → progression + memory).

**main.js: bootstrap vs. HUD vs. input**
- `js/main.js` — thin entry: build, wire, run the loop.
- `js/boot.js` — renderer/scene/camera/arena/lighting setup.
- `js/ui/hud.js` — instantiate + `setAgents`/render every panel (inspector/mind/questLog/inventory/classCodex/econView/abilityIndex/partyHud) behind one `Hud` facade.
- `js/playerControls.js` — cast keys, gather, dialogue triggers, the keydown map.

**tests: one suite per file**
- `test/harness.mjs` — the `ok` tally + `buildSim`/`makeFighter` helpers (shared).
- `test/suites/{combat,soak,planner,execution,memoryGoals,abilities,econ}.mjs` — each exports `run(ok)`.
- `test/headless.mjs` — thin runner: import suites + `scenarios.mjs`, run, exit code.

## Rules
- **Behavior-preserving.** No logic changes, no assertion changes. If a test needs editing, the split was wrong.
- **No cycles.** Behavior modules operate on a passed `agent`/`sim` instance; they import *config* and pure helpers, never each other circularly. `Agent` imports its behavior modules (or they're injected) — pick the direction that avoids cycles (likely: `agent.js` imports the behavior fns).
- **Config stays in `*config.js`** (simconfig/rpgconfig/constants).
- **Don't over-fragment.** Group by cohesive responsibility, not per-method. The list above is the floor; stop there unless a module is still doing two jobs.

## Order (risk-ascending; verify `bun test/headless.mjs` green between each)
1. **Tests** → per-suite files. Zero product-code risk; gives smaller files + keeps the net intact for the rest.
2. **Simulation** → `market.js`, `combatEvents.js`, `deedRouter.js`. Pure extraction.
3. **Agent** → the 6 behavior modules, **one extraction at a time, headless green between** (trade → decor → perception → movement → act → decide, easiest-first). Highest risk; the 163 checks are the gate.
4. **main.js** → `boot.js`, `ui/hud.js`, `playerControls.js`. Browser-only (headless doesn't import main.js) → verify by `serve + curl` resolve + a manual smoke.

## Verification
- After every step: `bun test/headless.mjs` → 163/0, no assertion edits.
- Final: 3× headless (flake check) + serve & `curl` the browser entry chain (200s) + a manual page smoke (it loads, panels open, an agent moves).

## The workflow (to launch AFTER this is approved AND the current workflow lands)
Phases mirror the order: `Tests-split` → `Simulation-split` → `Agent-split`
(sub-stepped) → `main-split` → `Verify & fix` (loop until green + browser resolves).
It **cannot** run concurrently with any feature workflow (it rewrites the same
hot files), so it goes solo.

## Open calls
1. **Delegation style** — thin `Agent` methods calling free functions (recommended; preserves call sites) vs. fuller move to free functions everywhere (bigger churn).
2. **Folder vs. prefix** — `js/sim/agent/*.js` subfolder (recommended) vs. `js/sim/agent-*.js` flat.
3. **How hard to push** — stop at the module floor above, or split further (e.g. decide's occupation chooser into its own file)?
