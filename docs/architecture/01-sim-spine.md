# 01 — The simulation spine

> The frame loop, the fixed-tick cognition pass, and the renderer-agnostic seam.
> Everything else in the world hangs off this spine. Read this first after the
> [overview](00-overview.md).

## The frame loop (`js/main.js`)

`main.js` is the thin entry point. It owns the renderer/scene (built by
`js/boot.js`), the HUD (`js/ui/hud.js`), player input (`js/playerControls.js`),
and the single fixed `renderer.setAnimationLoop(frame)` callback.

**Crash latching.** The whole frame body runs inside one try/catch. Each stage is
wrapped by a `stageFn(name)` label; if any stage throws, `_crashed` latches `true`,
every later frame is skipped, and the failing stage name + stack are surfaced to the
DOM and the bottom-left debug line (which turns red). **Preserve this pattern when
adding frame work** — a throw inside the loop must name its stage, not vanish.

Game states: `start` → `playing` ⇄ `paused`, plus `dialogue`.

The `playing` stages run in this strict order each frame:

```
commander          player point-and-click → intended movement
dungeon.collide    clamp player inside dungeon grid walls (if underground)
sim.update(dt)     THE CORE — fixed-tick cognition + per-frame movement (below)
dungeon.update     dungeon bookkeeping
castInput          poll ability keys 1-4 (edge-triggered)
gather             poll G / resource-node gathering
fighter.update     advance the player body's animation/state machine
resolveCombat      blade-vs-torso hit resolution, gated by Simulation.isHostile
                   → onCombatEvents folds outcomes back into beliefs/rep/memory
hud.render         per-frame panel refresh (read-only)
camera             orbit camera follow
render             WebGL draw
```

This order matters: the sim advances, *then* the player's body animates, *then*
combat is resolved against the freshly-moved bodies, *then* the result folds back.

## Bootstrap split

The former bootstrap god-object was split three ways (all called from `main.js`):

| Module | Exports | Responsibility |
| --- | --- | --- |
| `js/boot.js` | `boot()` | Renderer (WebGL, shadows, sRGB), scene, arena build, camera, `OrbitCamera`, input, commander. Returns the wired bundle. |
| `js/ui/hud.js` | `class Hud` | Instantiates every UI panel + dialogue modal; owns transient readouts (HP fill, hurt flash, debug/crash line, stats, context prompt). `setWorld(sim, …)` re-wires panels on world rebuild; `render(game, …)` refreshes per-frame. |
| `js/playerControls.js` | `class PlayerControls` | The global keydown map + context actions: ability cast (1-4), gather (G), drink potion (H), talk (E), pause (Esc), restart (R), and all panel toggles. |

## `Simulation.update(dt)` — the fixed-tick loop (`js/sim/simulation.js`)

`Simulation` is the orchestrator. It advances **real-time movement every frame**
but runs **cognition at a fixed rate** (`SIM.tickHz`, default 6 Hz) via an
accumulator, guarded against the spiral-of-death with a per-frame step budget.

```
_acc += dt
step = 1 / SIM.tickHz
while (_acc >= step && guard-- > 0) {
  _acc -= step
  <run every fixed-tick pass over all agents, in order>   // see below
}
<run act(dt) over all agents>                              // per-FRAME
reputation.decay(dt, agents)                               // per-FRAME
```

### The canonical pass order (do not reorder casually)

Per agent, per fixed tick:

```
perceive   → write beliefs from ground-truth sightings (vantage/concealment-gated)
beliefs.decay → fade confidence + suspicion
gossip     → adopt allies' higher-confidence beliefs (capped, faded, hops++, garbled)
decide     → utility argmax over BELIEFS ONLY → goal + emergent occupation
```

Then once per tick over the world:

```
_runMarket     double-auction at market POIs; price learning; standing friction
progression.tick   class/level/behavior-profile (consumes RPG deed events)
memory.tick    episodic consolidation STM→MTM→LTM + fade
quests.refresh / quests.tick   board synthesis + ground-truth completion check
```

Then the society/drama/economy/news passes, each guarded so a throw can't freeze
the loop (see [04](04-drama-society.md) / [05](05-economy-news.md)):

```
groups → defenses → faith → watch → expeditions → patrician → intrigue
       → director → lineage → chronicle → reporter → bounties → arbitrage
```

After **all** fixed ticks for the frame complete:

```
act(dt, ctx)   per-FRAME ground-truth execution: move, produce, fight, cast,
               flee, follow, eat, rest, socialize, trade, spy, delve, caravan, wander
reputation.decay(dt)   faction rollups fade; personal standings drift to faction bias
```

**Why beliefs-refresh-then-decay-then-gossip-then-decide?** Decisions must read a
belief table that has already been freshened by perception and faded by time, so an
agent acts on the *current* state of its mind, including stale/uncertain entries.

### Key `Simulation` surface

- State: `agents`, `agentsById`, `time`, `world`, `scene`, `camps`, `towns`, plus
  the subsystem handles (`quests`, `party`, `groups`, `defenses`, `faith`, `watch`,
  `expeditions`, `patrician`, `director`, `lineage`, `chronicle`, `gazette`,
  `reporter`, `bounties`, `arbitrage`, `intrigue`).
- `spawn()`, `addPlayer()`, `reinforceCamps()`.
- `isHostile(a, b)` — the **combat-time** ground-truth hostility predicate (see
  [02](02-epistemic-split.md)).
- `onCombatEvents(events)` — folds combat outcomes into beliefs/reputation/memory.
- `_recordDeed`, `recordSuccoured`, `recordRelic` — narrative bookkeeping hooks.
- `dispose()` — **must** run on teardown (it does, in `buildWorld`). It calls
  `this._busOff()` to unsubscribe the deed router. Skip it and a rebuilt world
  double-routes events (see [03](03-rpg-abilities.md), "subscriptions stack").

## The renderer-agnostic seam: `makeFighter`

The sim core is decoupled from rendering through one factory:

```js
this.makeFighter = opts.makeFighter || ((model, o = {}) => new Fighter(model, o));
```

- **Browser default** → visual `Fighter` (Three.js model + `AnimationMixer` + health bar).
- **Headless** (`bun test/headless.mjs`) → `HeadlessFighter`, a logic-only stand-in
  with the identical combat interface but no model/canvas. `Agent._buildDecor` skips
  its canvas/meshes when `typeof document === 'undefined'`.

This seam is why the entire simulation — combat, beliefs, economy, 12k-tick soak —
runs in ~0.2s with no browser. See [the testing doc](08-testing.md).

## Agent: a thin state class over delegated passes (`js/sim/agent.js`)

`Agent` holds state (`fighter`, `beliefs`, `needs`, `inventory`, `gold`,
`priceBeliefs`, `progression`, `memory`, `goals`, `ambition`, `life`, …) and
delegates each pass to a free function in `js/sim/agent/`:

| Method | Module | Reads | Role |
| --- | --- | --- | --- |
| `perceive(ctx)` | `agent/perception.js` | ground truth | writes beliefs |
| `gossipBeliefs(ctx)` | `agent/perception.js` | beliefs | merges allies' beliefs |
| `decide(ctx)` | `agent/decide.js` | **beliefs only** | utility argmax → goal |
| `chooseOccupation(ctx)` | `agent/occupation.js` | believed prices/POIs | emergent trade |
| `act(dt, ctx)` | `agent/act.js` | ground truth | move/produce/fight/cast |
| trade helpers | `agent/trade.js` | mixed | price learning, asks/bids |
| movement helpers | `agent/movement.js` | ground truth | steering, walls, clamp |
| decor/labels | `agent/decor.js` | — | overhead label (cached) |

The call sites are unchanged from before the SRP split — `Agent.decide` etc. are
thin delegators. When the docs say "`Agent.decide`", the logic lives in
`agent/decide.js`.

### Decision shape (what `decide` actually does)
- Specialty roles short-circuit first (reporter, duel, avenger, legend-flee, bounty,
  arbitrage, spy, expedition, caravan).
- Otherwise scores ambition-tilted candidates (fight / flee / eat / work / rest /
  socialize / market / wander) and takes the argmax.
- A **Schmitt band** (`SIM.dangerRange` to enter, `SIM.safeRange` to exit) gives
  flee↔work hysteresis so agents don't thrash at a threat boundary.
- A **survival-before-commerce** gate suppresses work/rest/socialize while in danger
  or starving (the [eat-survival fix](../../CLAUDE.md)).
- The GOAP plan-step is one high-weighted candidate, not a dictator (see
  [02](02-epistemic-split.md) for the goal/planner layer).

## Invariants & gotchas

- **The freeze lesson.** Monsters and the player have `profession: null` and no
  economy. Any code on the agent/cast/combat path must guard profession/inventory/
  economy access, or one unguarded read on a professionless agent throws inside the
  fixed tick and freezes the world. Always `import` what you reference.
- **Bounded beliefs.** Per-agent table capped at `SIM.beliefsPerAgent`; overflow
  evicts the least-certain, stalest entry. Keeps the N² table from growing unbounded.
- **Label redraws are cached** by a signature string in `Agent._updateLabel`. The
  canvas/GPU upload dominates per-frame cost at dozens of agents — don't defeat it.
- **Guarded subsystem passes.** Each society/drama/economy pass is wrapped so an
  error logs rather than crashing the tick. Keep new passes guarded.
- **Tune in config, not logic** — `SIM`, `WEIGHT`, `ECON`, `MOTIVE`, etc. in
  `js/sim/simconfig.js`; `TUNE` in `js/constants.js`; `RPG` in `js/rpg/rpgconfig.js`.
