# Architecture overview — Hearsay / Market Town

> **Authoritative architecture reference.** These docs specify how the project works so
> you can understand it at a glance without reading the code. They describe the system
> **as built**, plus the *why* behind the load-bearing design choices. Tuning numbers
> live in config (see the locator below), not here — these docs explain structure and
> intent, which change far less often.
>
> Start here, then follow the cross-links. The most important doc is
> [02 — the epistemic split](02-epistemic-split.md): internalise that and the rest
> follows.

## What this is

A browser Three.js sandbox that began as a Mount & Blade-style directional-melee
prototype and grew into a **theory-of-mind agent simulation**. NPCs act on what they
**believe**, not what is true: they perceive, gossip (with fading confidence +
provenance), trade on price beliefs, hold grudges, level up emergent classes, and some
are spies who disguise and plant false rumours. You play one fighter; everyone forms
beliefs about you too. No build step — ES modules served over HTTP, Three.js vendored.

## The reading order

| # | Doc | Covers |
| --- | --- | --- |
| 01 | [The simulation spine](01-sim-spine.md) | frame loop, crash latching, the fixed-tick pass order, the `makeFighter` seam, the thin Agent + delegated passes |
| 02 | [The epistemic split](02-epistemic-split.md) | **the core invariant** — decisions read beliefs, execution reads ground truth; how gossip/disguise/rumour all fall out of it |
| 03 | [RPG event spine](03-rpg-abilities.md) | the deed bus → progression → emergent classes → data-only ability IR (no eval); melee-arms-the-swing |
| 04 | [Drama & society](04-drama-society.md) | Director, Seeding, Lineage, Houses, Intrigue, Patrician, Watch, Defenses, Faith, Expeditions, Chronicle, Groups |
| 05 | [Economy & journalism](05-economy-news.md) | closed money loop, the market double-auction, reputation, multi-town world, Reporter→Gazette→Bounties/Arbitrage, quests |
| 06 | [World, dungeons & player](06-world-dungeons.md) | terrain/biomes/POIs, the player + party, the deep-Y-offset dungeon isolation trick |
| 07 | [UI & input](07-ui.md) | the read-only HUD panels, dialogue, the keymap |
| 08 | [Testing & headless runtime](08-testing.md) | `bun test/headless.mjs`, the headless seam, what still needs a browser |
| 09 | [The reasoning layer](09-reasoning-layer.md) | **target architecture** — belief-gated cognition at scale: the 3-tier execution hierarchy, the steering/potential-field composition, the `InteractionSchema` IR, destination-intent ToM, GOAP worked examples, and build-time enforcement that cognition cannot read truth |

Design/feature docs (the *why we built it this way*, deeper than this reference) live
beside these in `docs/`: `goal-system.md`, `drama-plan.md`, `director-levers.md`,
`trope-catalog.md`, `reporter-agent-design.md`, `llm-npcs.md`, `refactor-plan.md`,
`roadmap.md`. The top-level `CLAUDE.md` is the working-agent quickstart; `README.md` is
the player-facing controls + spec mapping.

## The system map

```
  main.js  (frame loop, crash-latched by stage)
    │  boot.js (renderer/scene)   ui/hud.js (panels)   playerControls.js (input)
    ▼
  Simulation.update(dt)  ── fixed-tick cognition @ SIM.tickHz + per-frame act()
    │
    ├─ PER TICK, PER AGENT (order matters):
    │     perceive ─► beliefs.decay ─► gossip ─► decide
    │       (ground truth → beliefs)   (fade)   (telephone)  (BELIEFS ONLY → goal)
    │
    ├─ PER TICK, WORLD:
    │     market ─► progression ─► memory ─► quests
    │     ─► groups defenses faith watch expeditions patrician
    │        intrigue director lineage chronicle reporter bounties arbitrage
    │
    └─ PER FRAME:  act() (ground-truth execution) ─► reputation.decay
    ▼
  resolveCombat (gated by Simulation.isHostile = GROUND TRUTH)
    └─► onCombatEvents ─► folds outcomes back into beliefs / reputation / memory
                          └─► RPG deeds on the shared bus ─► progression ─► XP/classes/abilities

  THE EPISTEMIC SPLIT runs vertically through all of it:
     decisions, perception(write), gossip, planning  ── read BELIEFS
     combat, movement, isHostile                      ── read GROUND TRUTH
     → an agent can be genuinely fooled while reality still resolves correctly.
```

## The load-bearing invariants (index)

These hold across the whole codebase. Break one and something subtle dies. Each links
to where it's explained in full.

1. **The epistemic split** — decisions read beliefs, execution reads ground truth.
   Don't read `other.faction` in a decision pass; don't read beliefs in combat
   resolution. → [02](02-epistemic-split.md)
2. **The freeze lesson** — monsters and the player have `profession: null` and no
   economy. One unguarded inventory/economy access on a professionless agent throws
   inside the fixed tick and freezes the world. Always `import` what you reference. →
   [01](01-sim-spine.md)
3. **Closed money loop** — gold is never minted, only transferred (trade, loot, reward,
   dowry). Tested by the soak. → [05](05-economy-news.md)
4. **Subscriptions stack → `dispose()`** — the deed bus is a process-wide singleton;
   `Simulation.dispose()` must run on teardown or a rebuilt world double-routes events
   and multiplies XP. → [03](03-rpg-abilities.md)
5. **Abilities are data-only IR** — no `eval`; `ir.validate()` is the trust boundary;
   melee specs arm the swing rather than casting. → [03](03-rpg-abilities.md)
6. **Pass order is the spine** — `perceive → decay → gossip → decide` before
   `act`, so agents decide on a freshened-then-faded belief table. → [01](01-sim-spine.md)
7. **Guarded, self-throttled subsystem passes** — every society/drama/economy pass
   skips below its `tickEvery` and never throws into the tick. → [04](04-drama-society.md)
8. **Deep-Y dungeon isolation** — dungeons sit ~400m below the overworld; the arena
   clamps x/z only, so distance alone keeps the two worlds apart. Don't clamp Y. →
   [06](06-world-dungeons.md)
9. **UI is read-only** — panels read state each frame and never mutate the sim (dialogue
   routes through gameplay systems, not direct writes). → [07](07-ui.md)
10. **Headless parity** — the sim runs with no browser via the `makeFighter` seam; guard
    all `document`/`window` access. → [08](08-testing.md)
11. **Label redraws are cached** by a signature string (`Agent._updateLabel`); the
    canvas upload dominates per-frame cost at scale — don't defeat the cache. →
    [01](01-sim-spine.md)

## Config locator (tune here, not in logic)

| Domain | Where | Notable blocks |
| --- | --- | --- |
| Simulation behaviour | `js/sim/simconfig.js` | `SIM`, `WEIGHT`, `ECON`, `MOTIVE`, `MEMORY`, `HEARSAY`, `MAP`, `SCARECROW`, `FACTIONS`, `FACTION_RELATIONS`, `PROFESSIONS`, `GOODS`, `COMMODITIES`, `BASE_PRICE`, `MONSTER`, `ROSTER`, `TOWNS`, `CAMPS`, `DUNGEON` |
| Drama/society | `js/sim/simconfig.js` | `DIRECTOR`, `SEEDS`, `LINEAGE`, `HOUSES`, `EPITHETS`, `INTRIGUE`, `PATRICIAN`, `WATCH`, `DEFENSE`, `FAITH`, `EXPEDITION`, `CHRONICLE`, `GROUP_TYPES`, `BAND`, `PARTY` |
| Economy/news | `js/sim/simconfig.js` | `ECON`, `REPORTER`, `GAZETTE`, `BOUNTY`, `ALERT`, `ARBITRAGE`; `REP` in `reputation.js`; `QUEST` in `quest/quest.js` |
| RPG curves/caps | `js/rpg/rpgconfig.js` | `RPG` (class matching, XP, significance, tiers) |
| Combat feel | `js/constants.js` | `TUNE`, `MODEL_YAW_OFFSET`, `ATTACK_CLIP`, `CLIP` |

Also note: the starting townsfolk count is the `ROSTER` block in `simconfig.js`
(`[{ n: 23 }]`); `simulation.js` only sums and consumes it (`spawn`).

## Run & develop

```bash
python3 -m http.server 8000   # serve over HTTP (ES modules + glTF need an http:// origin)
bun test/headless.mjs         # ~0.2s headless soak + combat tests — the fast feedback loop
```

Dependencies are vendored (`vendor/three.module.js` r160 + addons, wired through the
`index.html` import map). Assets are CC0 KayKit GLBs. **Don't add npm/CDN imports** —
keep everything local and import-mapped.

## Keeping these docs honest

When you change architecture (not just tuning), update the relevant doc in the same
change. These docs claim to be authoritative; a recalled doc that names a file,
function, or invariant that no longer exists is worse than no doc. If you add a
subsystem, give it a row in the [04](04-drama-society.md)/[05](05-economy-news.md) table
and, if it introduces a new invariant, a line in the index above.
