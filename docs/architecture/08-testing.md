# 08 — Testing & headless runtime

> The simulation core is decoupled from rendering, so the whole world runs with no
> browser. This is the fast feedback loop — use it to self-verify logic changes before
> any visual check.

## The fast path

```bash
bun test/headless.mjs       # ~0.2s: combat unit tests + a 12k-tick soak; exit 1 on failure
```

It drives the sim exactly like the render loop —
`sim.update → fighter.update → resolveCombat → onCombatEvents` (see
[01](01-sim-spine.md)) — and asserts the core invariants:
- no freeze over 12k frames,
- gold conservation (the [closed money loop](05-economy-news.md)),
- trades happen, beliefs form,
- every NPC has a valid ambition that progresses.

## The seam that makes it possible

Headless mode swaps the visual `Fighter` for a logic-only `HeadlessFighter`
(`js/headlessFighter.js`) via `Simulation`'s `makeFighter` factory (see
[01](01-sim-spine.md)). The two share an identical combat interface and TUNE-driven hit
timing; `HeadlessFighter` places its weapon points at chest height to match
`torsoCenter()` so headless combat frame-matches the rendered version.
`Agent._buildDecor` skips its canvas/meshes when `typeof document === 'undefined'`.

The bare `three` import specifier resolves through `tsconfig.json` paths (mirroring the
`index.html` import map), so the same ES modules load under Bun. **Bun is a dev/test
tool only — not a runtime dependency.** Don't import npm packages; keep everything
vendored and import-mapped.

## Layout

- `test/headless.mjs` — the thin runner. It loads `test/harness.mjs` (`makeOk` tally,
  `stubScene`, `makeFighter`) and the suites in `test/suites/*.mjs`, plus
  `test/scenarios.mjs`.
- `test/suites/` — `combat`, `execution`, `hearsay`, `abilities`, `planner`,
  `memoryGoals`, `obituary`, `soak`.
- Other runners: `test/scenarios.mjs`, `test/history.mjs`, and the benchmarks
  `test/bench.mjs` / `test/levelbench.mjs`.

**There is no single-suite CLI flag.** To run one suite, comment out the others in
`headless.mjs`, or import the suite into a scratch runner.

## What still needs the browser

Anything rendered or input-driven: open the page (`python3 -m http.server 8000`), click
to enter, and watch the bottom-left debug readout — it shows `state`, sim `time`, frame
count, and agent count, and turns **red** with a stage name + stack on any frame
exception (the [crash-latch](01-sim-spine.md) surface). Use this to verify camera,
input, UI panels, dialogue, and dungeon transitions.

## Gotchas

- **Run headless before claiming a logic change works.** It's ~0.2s and catches the
  freeze lesson, conservation breaks, and broken beliefs immediately.
- **Guard `document`/`window`.** New rendering or DOM code must no-op under headless or
  it throws inside the tick.
- **`Simulation.dispose()` between sub-sims.** Tests that build multiple worlds must
  dispose each, or the [deed bus subscriptions stack](03-rpg-abilities.md) and XP/class
  assertions go haywire.
