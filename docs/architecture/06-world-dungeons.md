# 06 — World, terrain, dungeons & the player

> The physical stage: terrain and biomes, points of interest, the player's party, and
> the Daggerfall-style procedural dungeons that hang ~400m below the overworld held
> apart by nothing but a Y offset.

## Terrain & arena (`js/arena.js`, `js/sim/world.js`)

`arena.js` builds the terrain mesh and biomes; `world.js` owns the points of interest.

- `ARENA_RADIUS` bounds the whole map — **600 m since the Phase A expansion**
  (~1.1 km², up from 0.32 km²/r=320, which held two towns 210 m apart — one Skyrim
  city district; Gothic 1, the genre's proof that DENSE beats sparse, is ~1 km²).
  Landmarks, monster camps and the seek_glory prowl band all scale **off the radius**
  (×0.32..×0.92), so the frontier band (270..552 m) stays wilderness beyond the
  settled core. Movement clamps **x/z only** — Y is left free, which is the
  structural trick the dungeons exploit (below).
- **Four towns** (`TOWNS` in `simconfig.ts`): Eastmarket (ironhill — ore+wood rich,
  herb-poor), Crowmoor (green — herb rich, ore+wood-poor), Highford (breadbasket —
  food+wood rich, ore-poor), Saltwick (delvers' — ore+herb rich, wood-poor). All
  centres sit within ~250 m of origin with varied inter-town distances (210–460 m), so
  caravans get real routes and each town surpluses what another lacks — genuine
  comparative advantage ([05](05-economy-news.md)). `ROSTER` is **per town** (4 × 23 ⇒
  96 spawn, growing to ~140+). Measured at landing (seed 31, 1200 s): all four towns
  alive, pop 96→142, gold conserved to the coin; noted watch items — the bigger
  distances re-stress the [survival ladder](14-survival-economy.md), and population
  skews toward the origin town (lineage density compounding — emergent urbanization).
- `BIOME` / `findBiomeSpot(biome, minR, maxR)` place sites in biome rings; `regionAt(x,
  z)` classifies a region (which sets monster danger — town stays safer, the frontier
  is dangerous). `terrainHeight(x, z)` is procedural elevation (browser-visual; settles
  agent Y) and `concealmentAt(pos)` feeds perception's cover gating.
- **POIs** (`world.js`) — fields, forests, mines, meadows, markets, rest/social sites.
  Production sites anchor the [emergent occupations](05-economy-news.md); market POIs
  are where [trade clears](05-economy-news.md); rest/social sites satisfy needs.
- **Vantage & cover are real.** Perception scales vision range by terrain height
  (`SIM.vantagePerMeter`) and shrinks it by concealment — high ground and cover change
  *what an agent can know*, feeding straight into the [belief table](02-epistemic-split.md).

See [05](05-economy-news.md) for the multi-town `TOWNS` layout and walls
([04](04-drama-society.md)) that sit on this terrain.

## Roads (`js/sim/roads.ts`, `STEER.wRoad`)

The four towns are linked by **visible roads that long-range travellers actually
follow** — travel becomes legible (caravans bunch on routes; ambush geography emerges
from geometry, not open-field straight lines).

- **The graph is static shared geography** (like `LANDMARKS`; in the epistemic scan):
  a minimum spanning set over `TOWNS.centers` (Kruskal at module init — 3 segments for
  4 towns) plus `roadPull(x, z, tx, tz, maxDist)`, a guarded distance-to-segment query
  returning the nearest on-route point biased **ahead** along the segment toward the
  destination (progress-gated — never a backward yank, never NaN).
- **Steering preference, not a rail** (`agent/steer.ts` `withRoad()`): the long-range
  fills (caravan / arbitrage / expedition / market-haul) blend a SECOND, weaker
  attractor (`STEER.wRoad` 0.55 < `wAttract` 1.0) toward the road point — only on legs
  beyond `STEER.roadMinDist` with a road within `STEER.roadSnapDist`. The true target
  stays the PRIMARY attractor, so facing/arrival are unchanged and corners get cut
  naturally. This is the **first live use of `steer()`'s weighted-sum substrate**
  ([09](09-reasoning-layer.md)).
- **The wall-funnel fix** (`movement.ts`, `TOWNS.wall.funnel` = 40 m): the gate
  waypoint of a walled destination now overrides a mover's heading only within the
  funnel distance. Before, a walled destination 200 m ahead flattened the whole march
  into a forced straight line at the far gate — **silently defeating the blended field**
  (measured: identical trajectories with the blend on/off until this fix).
  `collideWalls` still hard-blocks the ring at any range; near-doorway funnelling is
  unchanged.
- Visuals are dirt ribbon strips draped over `terrainHeight` per segment, browser-only
  (`typeof document` guard, like the walls/defenses meshes).

Measured (kinematic probe, blend ON vs `roadMinDist=Infinity` baseline): a direct
route tracks the road 2.9 m vs 6.6 m mean; a route with **no direct road** (T2→T3,
past the hub) 5.3 m vs 30.0 m (max 13.7 vs 57.9) — **5.7× closer for +2.5% travel
time**. Gated by `test/suites/roads.mjs` (graph connectivity via union-find, roadPull
guards, fill blending — road weaker, short hops stay single-attractor — and a steered
route walk: zero heading reversals, no NaN, arrives, mean off-route 2.7 m).

## The player (`js/player.js`, `js/commander.js`, `js/playerControls.js`)

The player drives a `Fighter` like any NPC (shared swing/block/stagger state machine,
[03](03-rpg-abilities.md)). `commander.js` turns point-and-click into intended
movement/targeting; `playerControls.js` owns the keymap (move WASD, run Shift, attack
LMB-flick, block RMB-flick, abilities 1-4, gather G, drink H, talk E, plus panel
toggles). The player is increasingly *just another agent* — the standing
"[player-as-agent](../../CLAUDE.md)" refactor is factoring `controlled`/`sim.player` out
of system code so the player has full agent symmetry. Everyone forms beliefs about the
player too.

## Party: companions the player recruits (`js/sim/party.js`, `PARTY`)

`Party` (on `sim.party`) is recruited through [dialogue](07-ui.md) (`[Join my party]`,
gated on reputation standing ≥ `PARTY.recruitStanding`). Recruiting just **flips flags**
on an existing agent — `inParty=true`, `combatant=true`, `goal='follow'`,
`bandLeaderId=player.id` — so the existing `Agent.decide`/`act` branch handles it:
`inParty` routes to `_decideParty` (fight believed-hostiles near self or leader, else
follow). **No AI fork.** Dismiss restores the stashed flags. `Party.prune()` drops the
dead each frame. This is the same machinery as NPC [Groups](04-drama-society.md), just
with the player as leader — and Groups never touches a player-led member.

## Dungeons (`js/world/dungeon.js`, `js/world/dungeonManager.js`, `DUNGEON`)

Daggerfall-style procedural tile mazes, and the cleverest spatial trick in the codebase.

### The deep-Y-offset isolation trick

A dungeon is built into a Group at `DUNGEON.y` (≈ −400), far **below** the overworld.
The arena clamp constrains only x/z, so a deep Y offset keeps the two worlds completely
isolated: an overworld agent at y≈0 and a dungeon agent at y≈−400 are ~400m apart —
past every vision and combat radius — so they never perceive or strike each other.
**No scene show/hide bookkeeping is needed**; the physics of distance does it for free.
(Expedition delves use an even deeper pocket, `EXPEDITION.delveDepth` ≈ −900, to isolate
them from both the overworld and the player's own dungeon — see [04](04-drama-society.md).)

### Dungeon (`dungeon.js`)
One level = a procedurally-carved tile maze: a recursive-backtracker perfect maze over
odd cells (`carveMaze`), 2–4 random 3×3 chambers punched in with some braided loops
(`openRoomsAndLoops`), and a BFS (`farthestFloor`) to place the down-stairs at the
farthest point. Markers: entrance, stairs, treasure, monster spawns. Tiles are 3.0m,
walls 3.4m tall, grid radius 4 (9×9).

### DungeonManager (`dungeonManager.js`)
The bridge between overworld and underworld, constructed in `main.js`. It scatters
cave-mouth portals across the wilds (`placeEntrances`); the `E` context action
(`tryPortal`) enters/descends/exits as appropriate. On `enter`: build a level deep
below, swap `scene.fog` and dim the sun for gloom, **spawn monster Agents into the same
`sim.agents` roster** (so combat, inspector, and party all just work — no special
casing), and teleport the player + party down. `descend` builds level N+1 with tougher
monsters; `exit` restores the overworld scene and despawns the dungeon's `_mobIds`.

### Collision
Monsters and the player get **axis-separated grid wall-collision** inside the dungeon
(and against [town walls](04-drama-society.md)). Nothing else in the sim has collision —
agents pass through each other; only walls and dungeon geometry block movement.

## Gotchas

- **Don't add Y-clamping to the arena.** The whole dungeon isolation scheme depends on
  Y being unconstrained. Clamp x/z only.
- **Dungeon monsters are real agents** in `sim.agents`. They have `profession: null` —
  so the [freeze lesson](01-sim-spine.md) applies: guard economy/inventory access on
  any code they touch.
- **Model facing.** KayKit rigs face `+Z`; `MODEL_YAW_OFFSET = PI` (`constants.js`)
  corrects it, and the interpreter's cone/aim math assumes forward = `(-sin yaw,
  -cos yaw)`. Get this wrong and abilities/attacks aim backwards.
