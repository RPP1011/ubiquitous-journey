# 22 — The application layer: the game on top of the engine

> **Status: as built.** Everything under `js/app/**` plus its views in `js/ui/{runView,tacticsView,
> battleRender,stagecraft}.ts`. The engine (`js/sim`, `js/rpg`) never imports it.

## The shape of the game

A **run** is: the hub → take a quest → three tactical battles in different parts of the world →
home → the town hears about it. Companions travel with you and change; the town remembers.

```
main.js (run mode)                 RunUI (screens, autoplay script)
   │                                  │
   ├─ Session (js/app/session.ts)  ◄──┤  RunController (js/app/run/run.ts) ── save (localStorage)
   │     one canonical frame step     │     ├─ quests.ts      what the stages are
   │     run lifecycle                │     ├─ companions.ts  traits, memories, growth, barks
   │                                  │     ├─ hub.ts         cast, tales, provenance, dialogue
   └─ TacticsView / BattleRender  ◄───┘     └─ tactics/*      the battles
```

## Layering rules

1. **The engine never imports the app.** The app drives the engine through `Session`, the sim's
   public methods, and the agents themselves (beliefs, personality, inventory, fighter).
2. **Every wound is folded through `sim.onCombatEvents`.** Tactical battles don't bypass the engine:
   witnesses, reputation, vendettas, notoriety and XP react to grid combat exactly as to real-time.
3. **Decisions read beliefs; resolution reads truth.** The tactical AI chooses from the unit's
   own beliefs, traits and objective; `Battle` resolves on ground truth (the epistemic split).
4. **Text never sets a magnitude.** Write-ins (`tactics/writein.ts`) resolve to the closed
   `Action` vocabulary; every noun must be a unit or prop on this map, and every reading is
   re-checked against `battle.options()` from its standing tile.
5. **Views are read-only.** Every order goes through `Battle.moveTo / act / endTurn` or
   `RunController`; stagecraft only sets presentation overrides (`_plate`, `_hideLabel`, `_ringColor`).

## Tactics (`js/app/tactics`)

- `map.ts` — a 16×16 grid of 2 m tiles cut from the real world; heights in half-metre levels
  (climb ≤ 2, falls hurt); props from nearby POIs or a stage's layout, each with weight, cover,
  material and affordances. Line of sight; XCOM-style directional cover.
- `battle.ts` — initiative-ordered unit turns (move + action or dash), facing and flank/back blows,
  opportunity strikes, overwatch and the general **Ready** (trigger → response, fires before a blow
  on a ward). Systemic environment: spreading fire, oil bursts, spilled braziers, douse, shoves into
  hazards/off ledges, tipped cover, blinding flour. Social verbs (bluff with claims incl. turncoat,
  intimidate, taunt, rally, parley). Downed + death saves; morale; captives; relics; a structured
  `events` stream.
- `ai.ts` — utility over (tile, action): role-shaped positioning (archer, beast, leader, healer,
  guardian, rogue, civilian) + EU weighted by objective, battle goals and **traits**.
- `writein.ts` — free text → `{move?, action}` with GM positioning; conditionals become Ready.
- `affordances.ts` — everything the acting unit can do this turn, from here or any reachable tile
  (best odds, then fewest steps), each with a **forecast** (plain words + the tiles it touches + who
  it catches) and the **risks** of the walk (opportunity swings, overwatch — the movement rules
  replayed dry). `verbOf`/`aimOf` drive the verb-first turn UI.
- `director.ts` — opens a battle around a real-time fight (sandbox mode).

**The turn UI (`ui/tacticsView.ts`) is verb-first.** The panel lists verbs with a count of how many
things you can do each to this turn (environment verbs first, amber; orange when one would catch a
foe) — never every verb × target. Pick a verb: its targets light up on the grid; hover one for the
preview (path cyan, object yellow, footprint orange) and a card with the forecast and risks; click
it to move and act. Objects you can use carry a small icon marker; hovering anything shows what it is.
Stances are one-click. The write-in box works alongside.

## Presentation: cues and choreography

The rules resolve an action instantly; the screen shows it over time. `Battle` appends **presentation
cues** (`cues`: step, strike, shot, dmg, slide, spill, throw, fire, say, coins, yield, …) as pure data —
the rules never read them and building them never draws from `rng()`, so headless runs are identical.
`ui/battleFX.ts` plays them as timed beats: KayKit clips on the bodies (fighters are `fxLock`ed so
logic-time hits don't animate early), procedural particles/projectiles/rings/tethers, speech bubbles with
the actual words, floating numbers. Bodies are rewound so later beats don't spoil earlier ones; HP bars
(`stagecraft.ts`) and captions follow the beats; NPC turns and battle-end wait while `fx.busy`.
Props are primitive-built models (`ui/propModels.ts`) eased toward their logical tiles (barrels roll,
tables tip, burnt props shrink away).

## The run (`js/app/run`)

- `companions.ts` — Borin, Wren, Pip, Maud. Traits (bravery, compassion, loyalty, ruthlessness)
  drive the AI; `developFromBattle` folds what happened to them and what they watched **you** do.
- `hub.ts` — six people with values and kin. `tellTales` spreads a run's deeds: companions to their
  confidants (Pip embellishes), eyewitness kin first-hand, the inn to everyone a hop later (lurid at
  2+ hops). `speak` builds lines from what each person heard, from whom, and what they value.
- `run.ts` — `RunController`: hub setup (remembered deeds re-seated as engine beliefs), stage
  battlefields in the right biome, objective checks, deeds, growth, patch-up, save.
- `autopilot.ts` — plays runs with a disposition (merciful / ruthless / pragmatic) and phrases its
  actions as write-ins (used by recordings and `test/suites/runs.mjs`).

## Tests and tools

- `test/suites/session.mjs`, `tactics.mjs`, `runs.mjs` — in the headless gate.
- `test/runbalance.mjs` — seeded run batches: stage wins, objectives, who fled.
- URL flags: `?sandbox` (old free-roam town), `?autoplay`, `?fresh` (wipe the save), `?debug`.
