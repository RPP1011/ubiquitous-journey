# 20 (LLD) — Render-only frontend: making the View a pure observer of the sim

> **Status: DESIGN / UNBUILT.** A migration plan, not as-built. The goal: push the existing
> headless seam (`makeFighter` + `stubScene` + the `document` guards) all the way to its
> conclusion so the **frontend (Three.js scene, meshes, HUD, input) is a thin OBSERVER that reads
> sim state each frame and renders it** — never a place where simulation logic lives, and never a
> place the sim reaches INTO. Read [01 — the sim spine](01-sim-spine.md), [07 — UI & input](07-ui.md),
> and [08 — testing & headless runtime](08-testing.md) first; this doc deepens the boundary those
> three describe.
>
> Every phase below keeps `bunx tsc --noEmit` and `bun test/headless.mjs` green and the browser
> playable. No npm deps; the `.js`-extension import convention, the crash-overlay pattern, and the
> sourcemap-preserving `main.js`-stays-`.js` rule all survive untouched. Tuning stays in config.

> **The one-line thesis:** today the sim already runs headless, but it does so by **injecting
> render-shaped stubs** (a no-op `scene`, a logic-only `Fighter` whose `root.position` is still the
> agent's authoritative transform). The truth-of-position lives on a `THREE.Vector3` that *happens*
> to be cheap to fake. The target inverts that: **truth lives in plain sim state**; a **View layer**
> reads it each frame and drives Three.js objects FROM it (interpolated, pooled), and an **Input
> layer** turns user gestures into sim intents. Headless then isn't "inject a fake renderer" — it's
> "run the sim and don't construct a View."

---

## 1. Why this matters (motivation)

The headless path already proves the sim is logic-only: `test/headless.mjs` drives
`sim.update → fighter.update → resolveCombat → onCombatEvents` with no browser, in ~0.2s over a
12k-tick soak. It does this through three accommodations:

1. **`makeFighter` factory** (`simulation.ts:240`) — swaps the visual `Fighter` (model +
   `AnimationMixer` + health-bar sprite) for `HeadlessFighter` (`js/headlessFighter.ts`), a
   logic-only body with the identical combat interface.
2. **`stubScene`** (`test/harness.mjs:20`) — a `{ add(){}, remove(){} }` no-op standing in for the
   `THREE.Scene`, because the sim calls `scene.add(fighter.root)` at every spawn.
3. **`document` guards** — `decor.ts:69` (`if (typeof document === 'undefined') return`),
   `movement.ts:131` (`groundY`), `construction.ts:798`, etc. skip canvas/mesh work headless.

This works, but the boundary is **inverted**: the sim is decoupled from rendering by handing it
*fakes shaped like render objects*, not by the sim owning plain data the renderer reads. The clearest
symptom is `Agent.pos`:

```ts
// js/sim/agent.ts:303
get pos(): import('three').Vector3 { return this.fighter.root.position; }
```

The agent's **authoritative x/z/yaw transform is a `THREE.Vector3` that lives on a fighter's
scene-graph root**. Headless works only because `HeadlessFighter.root` is a hand-rolled bag
(`{ position: new THREE.Vector3(), rotation: {...}, userData: {} }`) that mimics that root's shape
(`headlessFighter.ts:61`). Move truth into the sim and the renderer becomes free to be anything
(or nothing) without the sim caring — which is exactly the property we want for a fast soak and a
clean architecture.

**Load-bearing definition.** The frontend is *load-bearing* wherever the sim cannot run, or runs
differently, unless a render/DOM object exists. Concretely:
- The sim **writes** the canonical position to a `THREE.Vector3` on a scene-graph node
  (`movement.ts:99` `a.pos.x += ux * step`).
- The sim **calls** `scene.add(...)` / `scene.remove(...)` to register/retire bodies
  (21 call sites across 10 files — see §2).
- The sim reads world-space position back THROUGH the scene graph in the browser
  (`Fighter.torsoCenter`/`weaponPoints` call `root.getWorldPosition(out)` — `fighter.ts:287`,
  `combat.ts` samples weapon points), so combat geometry depends on `scene.updateMatrixWorld(true)`
  having run that frame (`main.js:150`).

None of these *should* be true of a pure simulation. They're the residue of a directional-melee
prototype where the Three.js object WAS the entity.

---

## 2. The current coupling map (hot spots, file:line)

### 2a. Authoritative state living on a render object — the headline coupling

| Where | What | Why it's load-bearing |
| --- | --- | --- |
| `js/sim/agent.ts:303` | `get pos()` returns `fighter.root.position` | The agent's truth transform IS a `THREE.Vector3` on the body. |
| `js/sim/agent/movement.ts:99-104` | `a.pos.x += ux*step; … collideWalls(a.pos, …)` | The fixed-tick **writes truth into the mesh transform** directly. |
| `js/headlessFighter.ts:61` | `root = { position: new THREE.Vector3(), rotation, userData }` | Headless only works by **mimicking the scene-graph root's shape**. |
| `js/fighter.ts:287,274` | `torsoCenter`/`weaponPoints` call `root.getWorldPosition` | Combat geometry reads truth back **through the scene graph** (browser). |
| `js/main.js:150` | `scene.updateMatrixWorld(true)` before `resolveCombat` | Combat correctness depends on a **render-pipeline call** each frame. |
| `js/percept.ts:70-71` | `this.root = { position: this.pos }` | Percepts also expose a `.root.position` so movement/perception paths work. |
| `~37 sites` | `*.root.position` reads/writes across `js/` (`enemy.ts`, `dungeonManager.ts`, `lineage.ts`, `expeditions.ts`, `reporter.ts`, `seeding.ts`, `simulation.ts`, `raids.ts`) | Spawn/teleport/relocate all poke `fighter.root.position.set(...)`. |

### 2b. The sim calling into the scene graph (`scene.add`/`remove`)

21 call sites across 10 files spawn or retire bodies/props by mutating the scene:

| File | Sites | What it adds/removes |
| --- | --- | --- |
| `js/sim/simulation.ts` | 4 | `scene.add(fighter.root)` at every agent spawn (`:443,477,557`); `scene.remove` on death (`:1557`). |
| `js/sim/world.ts` | 4 | POI meshes + landmark meshes (`:51,157,191,192`). |
| `js/sim/construction.ts` | 3 | finished-building groups (`:762`), demolition removes (`:798,952`). |
| `js/sim/defenses.ts` | 2 | watchtower groups. |
| `js/sim/director/raids.ts` | 2 | raider spawns/retires. |
| `js/sim/expeditions.ts` | 2 | expedition-member spawns/retires. |
| `js/sim/lineage.ts` | 1 | newborn spawn. |
| `js/sim/reporter.ts` | 1 | reporter spawn. |
| `js/sim/seeding.ts` | 1 | seeded-relationship spawn. |
| `js/sim/walls.ts` | 1 | wall geometry. |

The `SceneLike` interface (`simulation.ts:105`, `add(o)/remove(o)`) is already the seam; today it's
filled by a real `Scene` (browser) or `stubScene` (tests). It is fed `fighter.root` and mesh
`Group`s — i.e. **the sim constructs render objects** (in `world.ts`, `construction.ts`, `walls.ts`,
`defenses.ts`) and hands them to `scene.add`.

### 2c. Render/DOM construction inside `js/sim/**`

| File | What it builds | Guard |
| --- | --- | --- |
| `js/sim/agent/decor.ts:60-122` | proxy sphere, selection ring, **canvas name-label sprite**, `updateLabel` (cached by `_lblSig`), `setLabelVisible` | `document`-guarded at `:69`; the only DOM dep in the agent path. |
| `js/sim/world.ts` | POI meshes (`make()` builders) | partial — meshes are passed in. |
| `js/sim/walls.ts:240`, `defenses.ts:103`, `construction.ts:762` | wall/tower/building `Group`s with `THREE` geometry+material | not guarded (only `scene.remove` is guarded). |
| `js/sim/agent/movement.ts:127-134` | `groundY` writes terrain y onto `a.pos.y` | `document`-guarded at `:131` (cosmetic; sim reasons in x/z). |

**`THREE.Vector3` as a math type is NOT coupling.** Most `THREE.` hits in `js/sim/**` (beliefs,
mentalmap, planner, steer, surveyor, watch) are `new THREE.Vector3()` used purely as a vector-math
struct — they never touch a scene graph and run fine headless. The coupling is specifically:
**(a)** truth stored on a scene-graph node's `.position`, and **(b)** the sim *constructing and
registering render objects* (meshes, sprites, groups) via `scene.add`.

### 2d. The frontend (already mostly correct, but with leaks)

- `js/main.js` — the frame loop. Correctly orchestrates `sim.update → fighter.update →
  resolveCombat`. **Leaks:** it grounds the player onto terrain (`:137`, render concern living
  beside sim), and it relies on `scene.updateMatrixWorld(true)` (`:150`) to make combat geometry
  valid. The crash-overlay try/catch (`:124-180`) is load-bearing and must be preserved verbatim in
  spirit.
- `js/boot.ts` — renderer/scene/camera/input. Clean (pure render bootstrap).
- `js/ui/hud.js` + panels — **already read-only** (invariant #9 in [00](00-overview.md)); the model
  here. Dialogue is the one sanctioned write, and it routes through gameplay systems.
- `js/playerControls.ts` / `js/commander.ts` / `js/player.ts` — input → fighter intents. `Player`
  writes movement straight onto `f.root.position` (`player.ts:50`); `Commander` drives the
  controlled agent through the *same* `Agent.act` steps the AI uses (the good pattern — it issues
  intents, not transforms).
- `js/fighter.ts` — **mixed.** The directional-combat **state machine** (`ready/aim/release/
  startBlock/takeHit/update` state transitions, hit-window timing) is pure logic shared with
  `HeadlessFighter`. The **animation** (`AnimationMixer`, clip actions, `_playLoop`,
  `_buildHealthBar`, `_updateHealthBar`) is pure visual. They're interleaved in one class today.

---

## 3. The target architecture

Three layers, one direction of dependency: **Sim → (read by) View**, **Input → (commands) Sim**.
The sim never imports the View; the View never writes the sim.

```
            ┌──────────────────────────────────────────────┐
   intents  │                   SIM (truth)                 │  plain data only
  ┌────────▶│  Agent.body: { x, z, yaw, speed, state, hp }  │◀─────────┐
  │         │  Simulation.update(dt) — fixed-tick cognition │          │ reads
  │         │  resolveCombat reads body geometry directly   │          │ (each frame)
  │         └──────────────────────────────────────────────┘          │
  │                                                                    │
┌─┴──────────────┐                                          ┌──────────┴───────────┐
│  INPUT LAYER   │                                          │     VIEW LAYER       │
│ commander /    │                                          │  AgentView pool,     │
│ playerControls │   issue: moveTo, attack(target),         │  mesh sync + lerp,   │
│ → sim commands │   castAbility(n), block(dir), talk…      │  label sprites, HUD  │
└────────────────┘                                          └──────────────────────┘
```

### 3a. Move truth into the sim: the `Body` struct

Replace "the agent's transform is `fighter.root.position`" with a plain owned struct on the agent:

```ts
// types/sim.ts (new) — pure data, no THREE
interface Body {
  x: number; z: number; y: number;   // y stays for terrain/dungeon, but is cosmetic to cognition
  yaw: number;                        // facing (the model-offset stays a render concern)
  speed: number;                      // last commanded locomotion speed
}
```

`Agent.pos` keeps its `THREE.Vector3` *shape* for now (so the ~37 `a.pos.x`/`distanceTo` call sites
don't all churn at once) but its backing store moves off the scene graph. Two viable encodings,
chosen in Phase 2:
- **(preferred)** `Agent.body: Body` is the truth; `pos` becomes a thin `Vector3`-faced accessor
  over it (or a lazily-synced scratch `Vector3` the math sites read). Combat and movement read/write
  `body`.
- **(bridge)** Keep `pos` a real `Vector3` but make it **owned by the Agent**, not by
  `fighter.root`. `fighter.root.position` (browser) is then *synced FROM* `agent.body` by the View,
  never the source of truth. This is the smallest first step and is the recommended Phase 2.

Either way the load-bearing change is: **the fixed tick writes `agent.body`, and the renderer copies
`agent.body → mesh.position` once per frame.** Combat geometry (`torsoCenter`, `weaponPoints`)
computes from `body` math, NOT from `root.getWorldPosition` — which deletes the
`scene.updateMatrixWorld(true)`-before-combat dependency (`main.js:150`) and the chest-height
weapon-point fudge in `HeadlessFighter` becomes the *only* path (no scene-graph fork).

### 3b. Split `Fighter` into `CombatBody` (logic) + `FighterView` (visual)

`HeadlessFighter` already IS the logic body — it just has a vestigial `root`. Promote the shared
contract:

- **`CombatBody`** (rename/generalize `HeadlessFighter`) — the directional-combat state machine,
  hit timing, health/death, `setFacing`/`setMoving` (writing `body.yaw`/`body.speed`),
  `weaponPoints`/`torsoCenter` computed from `body` math. **This is what the sim holds**, in both
  headless and browser. No `THREE.Scene`, no mixer.
- **`FighterView`** — owns the KayKit model, `AnimationMixer`, clip actions, health-bar sprite.
  Each frame it reads its `CombatBody`'s `{x,z,yaw,state,speed,health}` and drives the model
  (locomotion clip from `speed`, swing clip from `state` transitions, lerp position/yaw between
  fixed ticks). Constructed ONLY by the View layer; never by the sim.

The `makeFighter` seam then narrows to "make a `CombatBody`" (always logic-only); the visual half
moves to the View's per-agent `AgentView`. The browser/headless difference becomes "is there a View
constructed?", not "which fighter class did we inject?".

### 3c. The View layer (`js/view/`)

A new cluster, imported only by `main.js`/`boot.ts`:

- **`WorldView`** — holds the `Scene`, owns an `AgentView` **pool** keyed by agent id, and a
  prop/building/POI view registry. Each frame: diff the sim roster against the pool (create
  `AgentView` for new ids, retire for dead/removed), then `sync(dt, alpha)` each view.
- **`AgentView`** — the per-agent visual: model `Group`, `FighterView`, label sprite (the
  `decor.ts` canvas-label logic moves here verbatim — cache by `_lblSig` preserved), selection
  ring. `sync` lerps `root.position`/`rotation.y` toward `agent.body` using the fixed-tick
  interpolation `alpha`, and refreshes the label from `agent.goal`/`agent.gold`.
- **Pooling/lifecycle** — `WorldView` is the *only* thing that calls `scene.add`/`scene.remove` for
  agents. The sim's spawn paths stop touching the scene; they push to `sim.agents` and the View
  picks them up next frame. (Buildings/POIs/walls/towers get the same treatment: the sim emits
  plain placement data — `{kind, x, z, yaw, footprint}` — and `WorldView` materializes meshes.)
- **Interpolation** — the sim runs cognition at `SIM.tickHz` but movement per-frame already
  (`act(dt)` every frame), so position is continuous; the View's `alpha` is for smoothing yaw/clip
  blends, not for re-deriving position. (If a later phase moves movement onto the fixed tick, the
  View interpolates `prevBody → body` by `alpha = _acc / step`.)

### 3d. The Input layer (commands, not transforms)

`Commander` is already the right shape: it translates clicks into intents the controlled `Agent`
executes via the same `act` steps as the AI. Generalize:
- The player's `CombatBody` is just another agent's body; `Player`'s direct
  `f.root.position.addScaledVector` (`player.ts:50`) is rewritten to write `agent.body` (or to issue
  a move intent the sim applies), so player and NPC truth live in the same place.
- Input emits a small **command vocabulary** (`moveTo`, `attack(targetId)`, `block(dir)`,
  `castAbility(slot)`, `gather`, `talk`) that the sim applies. This makes the player headless-drivable
  too (useful for scripted scenario tests) and removes the last "input writes a mesh" path.

### 3e. What the View is allowed to read (the read-only contract)

The View reads, per frame, per agent: `body{x,z,y,yaw,speed}`, `fighter.state`/`health`/`alive`,
`goal.kind`, `gold`, `_tradeFlash`, `name`, `profColor()`, party/selection flags. It reads the
**same** state the HUD panels already read (invariant #9). It **never** writes any of it, and it
never participates in cognition — exactly the [13](13-narrative-signals.md) "write-only observer"
discipline, applied to rendering. The epistemic split is unaffected because the View reads truth to
*draw* it, never to drive a decision (the [02](02-epistemic-split.md) "is this read driving an
agent's behaviour?" test answers no).

---

## 4. Phased migration plan

Each phase is individually shippable: `bunx tsc --noEmit` clean, `bun test/headless.mjs` green,
browser playable. Ordered by **risk × leverage** — the position-truth move (P2) is the keystone and
goes early but is split into safe sub-steps. Phases tagged **[soak]** also help headless
performance; **[arch]** are purely structural.

| # | Phase | What ships | Soak win? |
| --- | --- | --- | --- |
| **P0** | **Characterize & lock** | Add a `test/suites/render.mjs` (or extend `soak`) asserting the sim runs with **`scene = null`** (not just a `stubScene`) and **no `makeFighter` visual fork** — i.e. nail down today's headless contract as a gate before refactoring. Audit `THREE.Vector3`-as-math vs scene-graph uses (this doc's §2). No production change. | [arch] |
| **P1** | **Body struct, dual-written** | Introduce `Agent.body: Body` as plain data, written **alongside** the existing `fighter.root.position` in `movement.ts`/spawn paths (truth duplicated, asserted equal in tests). Combat/cognition still read `pos`. Pure additive — zero behaviour change, byte-identical soak. | [arch] |
| **P2** | **Flip truth to `body`** | Make `Agent.pos` read from `agent.body` (Vector3-faced accessor or Agent-owned synced Vector3); `fighter.root.position` is now a *render mirror* synced FROM `body`. Delete the dual-write. `CombatBody.weaponPoints`/`torsoCenter` compute from `body` math; drop `root.getWorldPosition`. **This removes `scene.updateMatrixWorld(true)` from the combat dependency** (`main.js:150` becomes view-only). | **[soak]** |
| **P3** | **Spawn/retire stop touching the scene** | Route the 21 `scene.add/remove(fighter.root)` sites through the sim emitting roster membership only; a new `WorldView` diffs `sim.agents` each frame and owns `scene.add/remove`. `stubScene` is deleted — headless passes `scene: null`. | **[soak]** |
| **P4** | **Extract `FighterView` from `Fighter`** | Split `js/fighter.ts`: the state machine → `CombatBody` (merge with `HeadlessFighter`, the now-canonical logic body); the model/mixer/health-bar → `js/view/fighterView.js`. `makeFighter` makes a `CombatBody` always. | [arch] |
| **P5** | **Move `decor.ts` into the View** | The proxy/ring/label-sprite logic (canvas label, `_lblSig` cache, `setLabelVisible`) moves from `js/sim/agent/decor.ts` into `AgentView`. The agent keeps only the **data** the label needs (already on it). Deletes the last `document` guard from the agent path. | **[soak]** |
| **P6** | **Props/buildings/POIs as placement data** | `world.ts`, `construction.ts`, `walls.ts`, `defenses.ts` stop constructing `THREE` `Group`s; they emit `{kind,x,z,yaw,footprint,…}` placement records. `WorldView` materializes/pools the meshes. Removes the remaining `scene.*`/`THREE`-geometry construction from `js/sim/**`. | **[soak]** |
| **P7** | **Input as commands** | `Player`/`Commander`/`playerControls` emit a command vocabulary the sim applies; the player's body becomes a normal `agent.body`. `groundY`/`groundPlayer` (`main.js:137`) move into the View as a cosmetic terrain-snap. | [arch] |
| **P8** | **Render-only assertion + docs** | A build-time/test assertion that `js/sim/**` and `js/rpg/**` import no scene-graph surface (only `THREE.Vector3`-as-math, or even that banned in favour of a tiny `Vec3` struct). Update [01](01-sim-spine.md)/[07](07-ui.md)/[08](08-testing.md). | [arch] |

**Soak leverage:** P2, P3, P5, P6 each delete render-ish work from the sim/headless path —
P2 removes a per-frame `updateMatrixWorld` from combat correctness, P3 deletes the `stubScene`
indirection and per-spawn scene churn, P5/P6 remove the `document`-guarded branches the tick still
walks past. The win is modest (the guards already no-op headless) but real, and the bigger payoff is
that a future "movement on the fixed tick" optimization becomes safe once truth is plain data.

**Stop-anywhere property:** every phase leaves the codebase shippable. If the effort pauses after
P3, the sim already owns its truth and the scene is View-managed — the most valuable 60%.

---

## 5. Risks & invariants this must not break

- **The epistemic split** ([02](02-epistemic-split.md)). The View reads truth to draw it, which is
  fine (observer layer, like the Director/Gazette). The risk is *accidentally* routing a render read
  back into cognition. Mitigation: the View is a separate `js/view/**` cluster the sim never imports;
  the P8 assertion enforces the import direction.
- **Gold conservation / closed money loop** ([05](05-economy-news.md)). Untouched — no economy code
  moves. The soak's conservation assert stays the regression net.
- **The crash-overlay pattern** (`main.js:124-180`). Load-bearing debug affordance. All new View
  work runs **inside** the existing staged try/catch, each step naming its `stage` (`view.sync`,
  `view.spawn`). `main.js` stays `.js` (sourcemaps slice `.ts` frames back to source). Do not move
  the frame loop out of `main.js`.
- **Sourcemaps & the build** (`CLAUDE.md`). New `js/view/**` are `.ts`; the `bunx tsc --noEmit && bunx
  tsc` build emits them with per-file sourcemaps like everything else. No bundler, no change to the
  documented build.
- **`.js`-extension import convention.** Every new import keeps the `.js` extension on `.ts` sources
  (`import { WorldView } from './view/worldView.js'`). The shadows suite (`no stale .js beside .ts`)
  still applies to the new files.
- **No npm deps.** The View uses only the vendored `three` (bare specifier via the import map /
  tsconfig paths). Nothing new is vendored.
- **The freeze lesson.** New per-frame View work must guard professionless/inventory-less agents
  (monsters, the player) exactly like the rest of the agent path, and must `try/catch` so a View
  throw surfaces as a named crash stage rather than freezing. The View runs *outside* the fixed tick,
  so a View throw can't freeze cognition — but it can blank the screen, hence the staged catch.
- **Label-cache invariant** (#11). The `_lblSig` redraw cache moves with the label logic into
  `AgentView` **unchanged** — the canvas/GPU upload is still the dominant per-agent cost; don't defeat
  the cache during the move.
- **Headless parity** (#10). The whole point: after P3, headless is "construct no View," and
  `bun test/headless.mjs` proves frame-for-frame parity of combat/economy/beliefs. Keep the soak as
  the gate at every phase.
- **Determinism.** The View is downstream of `rng()` and reads only finished state, so it can't
  perturb the seeded stream (`rng.ts`). The P0 gate should assert seed-repro is unaffected.

---

## 6. Open questions / deferred

- **Interpolation vs. per-frame movement.** Today `act(dt)` moves every frame, so position is
  already smooth and the View needs no position lerp. If a later optimization moves movement onto the
  fixed tick (a real soak win at scale), the View must interpolate `prevBody → body` by `alpha`. The
  `Body` struct is designed to make that a localized View change.
- **`y` / terrain.** `groundY` (`movement.ts:127`) is already cosmetic (cognition is x/z). It becomes
  a pure View concern in P7. Dungeon deep-Y isolation ([06](06-world-dungeons.md)) is a *gameplay*
  fact (x/z distance), unaffected.
- **The `enemy.ts`/`player.ts` legacy controllers.** `Enemy` (the original surround-and-swing AI)
  appears vestigial vs. the agent stack; confirm liveness before P4 touches `Fighter`, and retire it
  if dead (a shadows-style win).
- **Percepts** (`js/sim/percept.ts:71` `root = { position: this.pos }`). Scarecrows/buildings expose a
  `.root` for the perception/combat paths; once `Body` is canonical, percepts carry a `body` and the
  View materializes them like any prop (P6).

---

## 7. Review notes / resolved blockers (adversarial review, 2026-06-14)

A skeptical pass verified the file:line claims and probed correctness/invariants. Most claims hold;
the items below are corrections and blockers an implementer would otherwise hit. The companion
findings report has the full detail — this section captures the load-bearing resolutions.

**Verified correct:** `agent.ts:303` pos getter, `movement.ts:99` truth write + `:131` groundY guard,
`headlessFighter.ts:61` root bag, `fighter.ts:287/274` `getWorldPosition`/`weaponNode.matrixWorld`,
`main.js:150` `updateMatrixWorld`, `simulation.ts:240` makeFighter + `:105` SceneLike, `decor.ts:69`
guard + `_lblSig` cache, `percept.ts` `root={position:this.pos}`. Movement runs **every frame**
(`simulation.ts:1506`, outside the fixed-tick `while` at `:1394`) — so the "View needs no position
lerp today" claim is correct. `Enemy` (`enemy.ts`) has **zero** `new Enemy` call sites — it is dead;
retire it (a shadows win), no liveness risk to P4.

**Correction — combat geometry is NOT animation-free (affects P2).** The browser `Fighter.weaponPoints()`
reads the **animated weapon node's** `matrixWorld` (`fighter.ts:280-282`), i.e. the blade sample
follows the swing animation; `HeadlessFighter.weaponPoints()` uses a static `aimYaw`-projected
chest-height ray. These already differ — the soak does NOT prove browser/headless combat-geometry
parity, only that the headless approximation is stable. P2's "compute `weaponPoints`/`torsoCenter`
from `body` math, drop `getWorldPosition`, behavior-preserving" therefore **changes browser hit
detection** (the swing arc stops tracking the animation). This may be desirable (true parity) but it
is a gameplay change for the playable game, not the zero-risk move P2 implies. **Resolution required:**
either (a) accept the static-geometry model browser-side as an explicit, tested feel change, or (b)
keep the animated weapon-node sample as a *View-fed* override into `body`-space — pick one before P2.

**Correction — the coupling map undercounts scene sites (affects P3/P4/P6).** §2b lists 21 sites; the
sweep finds more body/prop `scene.add/remove`, and §2b/§2c omit two whole files:
- `js/world/dungeonManager.ts` — constructs `new Fighter(...)` **directly** (`:259`, bypassing the
  `makeFighter` seam) and `scene.add(fighter.root)` (`:261`); also teleport-writes `root.position`
  at `:215,232,248,260`. Browser-only (headless never builds a DungeonManager), so it's untested by
  the soak — P3/P4 must route it through `WorldView` and the `CombatBody` factory, or it desyncs.
- `js/arena.ts` (7 `scene.add`), `js/boot.ts`, `js/main.js:70` — static world geometry; lower risk
  but should be acknowledged so P6's "removes the remaining scene.* from the sim" scope is honest
  (arena.ts is not in `js/sim/**`, so it's out of scope — state that).

**Blocker — P0 is self-contradictory as written.** P0 says "no production change" yet asserts the sim
runs with `scene = null`. Today every spawn calls `this.scene.add(...)` **unconditionally**, so
`scene = null` throws immediately — and `stubScene.add(f.root)` is called directly by test code
(`soak.mjs:275,408`, `recipes.mjs:13`). The `scene = null` gate **requires** the P3 production change
(guard/remove the spawn-time `scene.add`) and test edits. **Resolution:** P0 can only *characterize*
(audit + lock the current `stubScene` contract + the THREE-as-math vs scene-graph inventory); the
`scene = null` assertion belongs in P3's exit criteria, not P0.

**Player body parity (probe answered):** the player's fighter is a real `Fighter` whose `root.position`
is written directly by `player.ts:50` (input), `main.js:137` (ground-snap), and `dungeonManager`
(teleport) — NOT via `agent.body`/movement. So P7 is **load-bearing for correctness**, not just
cleanup: until the player writes the same `body`, P1's dual-write and P2's flip must explicitly
exclude or special-case the player (it has no `Agent.movement` path), or the player's truth and mirror
diverge. Call this out in P1/P2.

**Dungeon deep-Y (probe answered):** unaffected by the `Body` model — `y` is already cosmetic to
cognition (x/z only) and the dungeon's isolation is a gameplay x/z-distance fact. `Body.y` carries the
deep offset fine; the only care is that `groundY` must stay suppressed underground (it already checks
`a._underground`, `movement.ts:132`).

**Invariant spot-checks:** epistemic split — the View-reads-truth-to-draw argument is sound and matches
[02](02-epistemic-split.md)'s observer-layer carve-out; the P8 import-direction assertion is the right
enforcement. Crash overlay, sourcemaps, `.js`-import, gold conservation, `_lblSig` cache: untouched by
the plan as described. Freeze lesson: the View runs outside the fixed tick, so a View throw blanks the
screen but cannot freeze cognition — the staged try/catch requirement in §5 is correct.
