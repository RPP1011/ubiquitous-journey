# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Hearsay" / "Market Town" — a browser Three.js sandbox that started as a Mount & Blade-style
directional-melee prototype and grew into a Theory-of-Mind agent simulation. NPCs act on what
they **believe**, not what is true: they perceive, gossip (with fading confidence + provenance),
trade on price beliefs, hold grudges, level up emergent classes, and some are spies who disguise
and plant false rumours. You play one fighter; everyone forms beliefs about you too.

## Build / typecheck / serve

The project is migrating to **TypeScript with `tsc` as a dev-time transpiler** (a staged port;
the core sim slice is `.ts`, the rest is still `.js` via `allowJs` interop). `tsc` is the **same
category as the Bun test runner — NOT a runtime dependency**; there is no bundler and no npm
runtime dep. Three things consume the source — keep all three green:

- **Typecheck (gate):** `bunx tsc --noEmit` — strict, must be clean. This is the type firewall.
- **Tests (gate, no build):** `bun test/headless.mjs` — Bun runs `.mjs` tests and the `.ts`/`.js`
  sim sources they import **natively, with no transpile step** (~0.2s: combat unit + 12k-tick soak,
  epistemic scan, soak invariants, scenarios, scaling/LOD, homecoming, percept, schemas; exit 1 on
  failure).
- **Browser:** typecheck-then-emit, then serve:

  ```bash
  bunx tsc --noEmit && bunx tsc      # NEVER bare `bunx tsc` — see below
  python3 -m http.server 8000        # then open http://localhost:8000
  ```

  `bunx tsc` emits the whole tree (`.ts` transpiled + `.js` copied via `allowJs`) to `dist/`,
  mirroring the source layout, with per-file sourcemaps. `index.html` loads `./dist/js/main.js`;
  the import map + `vendor/` are served as-is (vendor is NEVER emitted). `dist/` is gitignored
  (reproducible output, not committed).

**Why `--noEmit && tsc`, never bare `tsc`:** under `verbatimModuleSyntax`, a value-import of a
type (e.g. `import { CognitionCtx }` instead of `import type`) is a TS error that bare `bunx tsc`
**emits anyway** (exit 0) — shipping a `dist/` that throws `does not provide an export named …` in
the browser. Only the `--noEmit` pass catches it, so the documented build runs it first and emits
only if clean (fail-fast).

**Import-specifier convention (load-bearing):** every relative import keeps a `.js` extension even
when the source is `.ts` — `import { BeliefStore } from './beliefs.js'` resolves to `beliefs.ts`.
This one rule satisfies Bun (tests), `tsc` (typecheck + verbatim emit), and the browser (loads the
emitted `.js`) **at once**, so the port needs zero import rewrites. `three` / `three/addons/*` stay
bare specifiers (resolved by `tsconfig.json` `paths` for tsc/Bun, by the import map for the browser).

**No stale shadows:** after renaming `x.js`→`x.ts`, the old `x.js` MUST be gone (use `git mv`). A
leftover `x.js` beside `x.ts` makes Bun run the stale `.js` while tsc/browser run the `.ts` — a
green gate against dead code. The headless runner asserts no such coexistence under `js/**`
(`test/suites/shadows.mjs`).

**Sourcemaps preserve the crash overlay:** `main.js` stays `.js` (its frame-loop try/catch slices
`err.stack` into the on-screen overlay — a load-bearing debug affordance). Sourcemaps map the
deeper `.ts` frames back to source so the overlay still names a real source stage + line.

It drives the sim exactly like the render loop (`sim.update` → `fighter.update` → `resolveCombat` →
`onCombatEvents`) and asserts the invariants: no freeze over 12k frames, gold conservation, trades
happen, beliefs form, every NPC has a valid ambition that progresses. `headless.mjs` is a thin runner
that loads `test/harness.mjs` (`makeOk` tally, `stubScene`, `makeFighter`) and the suites in
`test/suites/*.mjs` (`epistemic`, `shadows`, `combat`, `abilities`, `planner`, `execution`,
`memoryGoals`, `percept`, `schemas`, `hearsay`, `obituary`, `construction`, `homecoming`, `city`,
`soak`) plus `test/scenarios.mjs`. There's no single-suite CLI flag — to run one suite,
comment out the others in `headless.mjs` or import the suite into a scratch runner. Other runners:
`test/scenarios.mjs`, `test/history.mjs`, and the `test/bench.mjs` / `test/levelbench.mjs` benchmarks.
The seam is a logic-only
`js/headlessFighter.js` injected via `Simulation`'s `makeFighter` factory (browser default stays the
visual `Fighter`); `Agent._buildDecor` skips its canvas/meshes when `document` is undefined. The bare
`three` specifier resolves through `tsconfig.json` paths (mirrors the index.html import map). Bun is a
dev/test tool only — it is NOT a runtime dependency of the game; do not import npm packages.

**Visual/manual verification (still needed for anything rendered or input-driven).** Open the page,
click to enter, and watch the on-screen debug readout (bottom-left) — it shows `state`, sim `time`,
frame count, and agent count, and turns red with a stage name + stack on any frame exception.

Dependencies are vendored: `vendor/three.module.js` (r160) + addons, wired through the import map
in `index.html` (`three`, `three/addons/`). Assets are CC0 KayKit GLBs in `assets/`. Do not add
npm/import-from-CDN; keep everything local and import-mapped.

## Architecture

> **Authoritative architecture reference: [`docs/architecture/`](docs/architecture/00-overview.md).**
> Start at `00-overview.md` (system map + invariants index + config locator), then the
> per-cluster docs: `01-sim-spine`, `02-epistemic-split`, `03-rpg-abilities`,
> `04-drama-society`, `05-economy-news`, `06-world-dungeons`, `07-ui`, `08-testing`.
> The summary below is the quickstart; those docs are the full as-built spec — keep them
> updated when you change architecture (not just tuning).

> **Post-refactor module layout (SRP).** The former god-objects were split into single-
> responsibility modules — behavior moved, call sites unchanged (thin delegating methods):
> - **Agent** = a thin state class (`js/sim/agent.js`) delegating to `js/sim/agent/{perception,
>   decide,occupation,movement,act,steer,trade,decor}.js` (free fns over the instance). So
>   `Agent.decide` now lives in `agent/decide.js`, perception in `agent/perception.js`, etc.
>   **Locomotion is one potential-field primitive** (`agent/steer.js`, Phase 2b): `steer(a,
>   {attractors[],repulsors[],speed}, dt)` motors every locomotion behaviour, and the
>   `STEER_FILLS` table maps each `goal.kind` (work/market/wander/flee/follow/comfort/…) to a
>   pure `(a,ctx)→field` fill built from the agent's OWN beliefs/map/state (belief-gated by
>   construction; in the epistemic scan). `act.js` dispatches through it and fires the explicit
>   world-interaction verb (gather/strike/transfer/produce/build) on arrival — locomotion is a
>   field, world-interactions are verbs. `goTo` survives as a thin stepper delegate for the
>   still-special executors (combat, spy, plan-step transfers).
> - **Simulation** orchestration in `simulation.js`; mechanics in `js/sim/market.js` (auction),
>   `combatEvents.js` (combat→belief/rep/memory), `deedRouter.js` (bus→progression/memory).
> - **Bootstrap** split: `js/boot.js` (renderer/scene), `js/ui/hud.js` (panels), `js/playerControls.js`
>   (input); `js/main.js` is the thin entry + frame loop.
> - **Tests**: `test/harness.mjs` + `test/suites/*.mjs`, run by the thin `test/headless.mjs`.
> Names below (`Agent.decide`, etc.) still refer to those methods — now in their modules.

Entry point `js/main.js` owns the renderer/scene, the fixed `renderer.setAnimationLoop(frame)`,
DOM/HUD wiring, and player input. The whole frame body is wrapped in a try/catch that latches
`_crashed` and surfaces the failing **stage** — preserve that pattern when adding frame work.

### The simulation tick (the spine)

`Simulation.update(dt)` (`js/sim/simulation.js`) advances real-time movement every frame but runs
**cognition at a fixed rate** (`SIM.tickHz`, accumulator-driven, guarded against spiral-of-death).
Each fixed tick runs these passes **in this order** over all agents:

```
perceive → beliefs.decay → gossipBeliefs → decide → _runMarket → progression.tick → quests
```

then `act(dt)` runs every frame. This order matters: beliefs are refreshed and faded before
decisions read them.

### The epistemic split (why deception works)

This is the core invariant — keep it intact:
- **decisions** (`Agent.decide`, `Agent.perceive`, `Agent.gossipBeliefs`) read **beliefs only**,
  never ground truth.
- **execution** (`combat.js`, movement, `Simulation.isHostile`) reads **ground truth**.

So an agent can be genuinely fooled (disguise/stealth/planted rumour) while reality still resolves
correctly. `Simulation.isHostile` is the combat-time predicate (faction + latched-hostile belief +
reputation); `Agent._nearestHostile`/`considerHostile` is the belief-time one. Combat outcomes fold
back into beliefs via `Simulation.onCombatEvents` (victim + witnesses learn the aggressor).

Beliefs live in `js/sim/beliefs.js` (`BeliefStore` = the spec's per-`(observer→subject)` N² table).
The other half of the world-model is the **mental map** (`js/sim/mentalmap.js`, `MentalMap`/`Place`
on `sim.map`): a shared, read-only, STATIC places registry (town gates, POIs, arena landmarks)
queried by **affordance** (`affords('exit'|'conceal'|'safe'|'crowd'|'resource')`), never by scanning
the roster — what `inferDestination` (`beliefs.js`) reasons over to guess where a lost quarry is
making for (cached on the belief with a TTL). `js/sim/percept.js` adds **percepts** — hittable,
perceivable PROPS with no mind (a `Scarecrow` dressed as a person) kept in `sim.percepts` (never
`sim.agents`); the `fighters`/`perceivables` seams let an agent believe one a person and strike it
while every `!agent` guard skips all mind-feedback. See [09 — reasoning layer](docs/architecture/09-reasoning-layer.md).

`Agent.decide` is backed by a goal/GOAP layer: `js/sim/motivation.js` derives goals (some from
episodic `js/sim/memory.js`) and `js/sim/planner.js` plans toward them. Goals still read beliefs
only, preserving the epistemic split.

Above that, the **reasoning layer** (`js/sim/schemas/`, Phase 2a) runs `reason(agent, ctx,
catalogue)` once per agent per cognition tick (between gossip and decide): a data-only
`InteractionSchema` IR (`ir.js` shape + `validate()`), the shared predicate/inference/response
vocabulary (`vocab.js`, in the epistemic scan), the bounded priority/ttl-cached interpreter
(`interpreter.js`), and the 6 flagship schemas as data rows (`catalogue.js`). Every predicate
reads only the agent's OWN beliefs/state/memory/mental-map — never the roster (config: `SCHEMA`).
Buildings are now **places-as-percepts**: `construction.js` spawns a finished building into
`sim.percepts` with a namespaced id (`B:<n>`, disjoint from agent ids) and a believed `sheltered`
state; an agent DISCOVERS its home by sight (`homeBeliefId`) and its loss by perception or belief
decay — no telepathic re-route (the `test/suites/homecoming.mjs` gate).

### The RPG event spine

`js/rpg/events.js` exports a single shared synchronous `bus`. Every meaningful deed (strike, kill,
buy, sell, forge, produce, cast, gather…) is published as an **ActionEvent**
`{ actorId, verb, tags[], magnitude, targetId?, t }` via `makeEvent`. `Simulation`'s constructor
subscribes one router that delivers each event to `agentsById.get(actorId).progression.onEvent`.

`Progression` (`js/rpg/progression.js`, one per Agent) accumulates a weighted `behavior_profile`,
periodically matches it against class templates (`js/rpg/classes.js`) to **grant emergent classes**,
and routes XP to the best-matching held classes. Class tier milestones grant abilities from the
catalog. **Subscriptions stack** — `Simulation.dispose()` must run on teardown (it does, in
`buildWorld`) or a rebuilt world would multiply XP. The bus snapshots listeners per `emit`, so
re-entrant emits from inside `onEvent` are safe.

### Abilities = data-only IR (no eval)

`js/rpg/abilities/` is an interpreted ability DSL:
- `ir.js` — the AbilitySpec shape + `validate()` + `isMelee()`.
- `catalog.js` — concrete specs + `CLASS_MILESTONES` (which class@level grants which ability). The
  catalog is imported **lazily and fault-tolerantly** by Progression — it degrades to "no abilities"
  if absent. Don't make Progression hard-depend on it.
- `interpreter.js` — `castSpec(spec, caster, ctx)` resolves targets by area/range/cone and dispatches
  effects through the `EFFECTS` map. **Melee specs don't cast** — they arm `fighter.pendingSpec` and
  `combat.js` applies their damage op when the blade lands (so they're block/shield-aware).
- `effects.js` — the `EFFECTS` op implementations (damage, heal, shield, dash, …).

Player ability keys `1-4` map to `agent.abilityList()` slots (edge-triggered in `main.js`).

### Other subsystems

- `js/sim/world.js` — POIs (fields/forests/mines/meadows/market/rest sites); `js/arena.js` builds
  the terrain + biomes (`BIOME`, `findBiomeSpot`, `ARENA_RADIUS`).
- `js/sim/reputation.js` — player-only standing ledger; witnessed deeds (KILLED_NPC, ATTACKED_NPC,
  KILLED_MONSTER) roll up to faction standing and skew the player's market clearing prices.
- `js/quest/quest.js` (`QuestBoard`) — two layers: **emergent** offers (fetch/hunt/recover) minted
  only when an agent is genuinely stuck, plus a **radiant** generator (`_synthRadiant`) that keeps the
  board topped up to `QUEST.radiantFloor` with repeatable, player-level-scaled bounty/deliver/delve
  contracts. Completion is detected from ground truth in `tick()`; delve quests check `player.relics`.
- `js/sim/party.js` (`Party`, on `sim.party`) — companions the player recruits via dialogue
  (`[Join my party]`, gated on reputation standing). Recruiting just flips flags the existing
  `Agent.decide`/`act` branch on: `inParty` routes to `_decideParty` (fight believed-hostiles near
  self or leader, else `follow`). No AI fork. `Party.prune()` drops the dead each frame.
- `js/world/dungeon.js` + `js/world/dungeonManager.js` — Daggerfall-style procedural tile mazes.
  **Key spatial trick:** a dungeon is built into a Group at `DUNGEON.y` (≈ −400), far *below* the
  overworld. The arena clamp only constrains x/z, so a deep Y offset keeps the two worlds isolated —
  agents ~400m apart never perceive or strike each other — without any scene show/hide bookkeeping.
  `DungeonManager` spawns monster Agents into the *same* `sim.agents` roster (so combat/inspector/party
  all just work), teleports the player+party down, and swaps `scene.fog`/dims the sun for the gloom;
  exit restores them. Monsters (and the player) get axis-separated grid wall-collision; nothing else
  in the sim has collision.
- `js/dialogue/dialogue.js` + `js/ui/dialogueView.js` — talk to an NPC (`E`).
- `js/ui/` — `inspector.js` (look-to-read-mind, `F`), `mindbrowser.js`, `questLog.js`, plus
  `chronicle.js`, `partyHud.js`, `abilityIndex.js`, `classCodex.js`, `econView.js`,
  `inventoryPanel.js`, `gazette.js`, `dragtabs.js`. UI reads agent state each frame; keep it read-only.
- `js/fighter.js` — the swing/block/stagger state machine + model/animation; shared by player and
  NPCs. `js/player.js` drives the local fighter; NPCs drive theirs from `Agent.act`.

### Drama, society & emergent-narrative subsystems

These all live in `js/sim/`, are constructed by `Simulation`, and (mostly) run as fixed-tick passes
or bus subscribers. Each has a matching config block in `simconfig.js` — **tune there, not in logic.**
All of them seed/read **beliefs**, not ground truth, so the epistemic split still holds.

- `director.js` (`DIRECTOR`) — story manager with a **points budget + trope engine**; spends drama
  points to inject situations (rivalries, betrayals) when the world goes quiet, on cooldowns.
- `seeding.js` (`SEEDS`) — plants initial relationship constellations at world build (e.g. rival
  apprentices) so the Director has material to escalate.
- `lineage.js` (`LINEAGE`) — births, apprenticeship, mentorship & population dynamics; the
  pop-loop pulse / population balance is here.
- `houses.js` (`HOUSES`, `EPITHETS`) — surnames + dynastic naming; emergent hero/villain epithets.
- `intrigue.js` — the deception layer: disguise, stealth, spies planting **false** rumours.
- `patrician.js` (`PATRICIAN`) — a diegetic peace-keeper that brokers truces / reconciliations.
- `watch.js` (`WATCH`) — Night Watch civic guard institution that responds to believed threats.
- `defenses.js` / `walls.js` (`DEFENSE`) — watchtowers + town walls with gates (walls are
  collision-only geometry, like dungeon walls).
- `faith.js` (`FAITH`) — Discworld-style small gods whose power scales with believers.
- `expeditions.js` (`EXPEDITION`) — NPC adventuring parties that delve the procedural dungeons.
- `chronicle.js` / `biography.js` — world history log + per-agent biographical/drive summaries
  (surfaced by `ui/chronicle.js`).
- `groups.js` (`GROUP_TYPES`, `BAND`) — generic group/band membership backing parties and clans.

### Journalism & multi-town economy

The world is **multiple dense towns** (`TOWNS` in `simconfig.js`, each agent has a `townAnchor`)
linked by wilderness + inter-town caravans; `ARENA_RADIUS` bounds the whole map. A news layer turns
information itself into a resource agents act on:

- `reporter.js` (`REPORTER`) — a roaming gazetteer agent that interviews and files stories.
- `gazette.js` (`GAZETTE`) + `js/ai/press.js`, `js/ai/llm.js` — builds the town newspaper
  (briefs + LLM/template-enriched articles) from reporter data; toggle with `J`. UI in `ui/gazette.js`.
- `bounties.js` (`BOUNTY`, `ALERT`) — NPCs read the Gazette and answer bounties as a labour market.
- `arbitrage.js` (`ARBITRAGE`) — traders read price reports and haul goods between towns.
- `econstats.js` — economic telemetry bus subscriber (mirrors `js/rpg/xpstats.js`).

## Conventions & gotchas

- **Tuning lives in config, not logic.** Sim behaviour: `SIM`, `WEIGHT`, `ECON`, `STEER`
  (steer-fill force weights + `fleeAway`), `FACTIONS`,
  `PROFESSIONS`, `MONSTER`, `ROSTER`, `COMMODITIES`, `BASE_PRICE` in `js/sim/simconfig.js`
  (+ `ROSTER` count in `simulation.js`). RPG curves/caps in `js/rpg/rpgconfig.js` (`RPG`). Combat
  feel in `js/constants.js` (`TUNE`). Prefer changing constants over hardcoding.
- **The "freeze lesson."** Monsters and the player have `profession: null` and no economy. Any code
  on the agent/cast/combat path must guard profession/inventory/economy assumptions, or a single
  unguarded access on a professionless agent throws inside the fixed-tick loop and freezes the sim.
  Always `import` what you reference (a missing `TUNE` import once re-froze the loop).
- **Model facing:** KayKit rigs face `+Z`; `MODEL_YAW_OFFSET = PI` in `constants.js` corrects it.
  Cone/aim math in the interpreter assumes forward = `(-sin(yaw), -cos(yaw))`.
- **Label redraws are cached** by a signature string (`Agent._updateLabel`) — the canvas/GPU upload
  is the dominant per-frame cost at dozens of agents; don't defeat the cache.
- The economy is a **closed money loop** (no minting): looting transfers a corpse's actual purse;
  tool wear ties tool demand to throughput. Preserve conservation when touching trade/loot.

## Background

The ToM design ports the `extensive-sim-game` spec (belief-primitive / engine docs). See `README.md`
for the player-facing controls and the spec-mapping write-up.
