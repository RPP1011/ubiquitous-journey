# 06 — World, terrain, dungeons & the player

> The physical stage: terrain and biomes, points of interest, the player's party, and
> the Daggerfall-style procedural dungeons that hang ~400m below the overworld held
> apart by nothing but a Y offset.

## Terrain & arena (`js/arena.js`, `js/sim/world.js`)

`arena.js` builds the terrain mesh and biomes; `world.js` owns the points of interest.

- `ARENA_RADIUS` bounds the whole map. Movement clamps **x/z only** — Y is left free,
  which is the structural trick the dungeons exploit (below).
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
