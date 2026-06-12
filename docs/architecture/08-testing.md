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
- `test/suites/` — `epistemic` (the build-time scan, wired FIRST), `shadows` (no stale
  `.js` beside `.ts`), `combat`, `abilities`, `execution`, `planner`, `memoryGoals`,
  `schemas`, `percept`, `homecoming`, `construction` (incl. the granary gates),
  `roads`, `city`, `seeding`, `hearsay`, `obituary`, `trace`, `arcs`, `signals`,
  `learning`, `recipes`, `recruit`, `urchin`, `affect`, `obligations`, `ledger`,
  `caution`, `wealth`, `soak`, `scaling`.
- Other runners: `test/scenarios.mjs`, `test/history.mjs`, `test/depth.mjs` (the
  behavioural-depth harness), and the benchmarks `test/bench.mjs` /
  `test/levelbench.mjs`.

**There is no single-suite CLI flag.** To run one suite, comment out the others in
`headless.mjs`, or import the suite into a scratch runner.

## Seeded determinism (`js/sim/rng.ts`, `test/seedrepro.mjs`)

`rng.ts` is a seedable **mulberry32 singleton** (`rng()`/`setSeed()`/`getSeed()`)
routed through ~33 files' stochastic call sites. **Unseeded, `rng()` falls straight
through to `Math.random()`** — the existing soak is byte-identical. `Simulation`'s
constructor takes an optional `{ seed }` and arms the stream **before any spawn roll**
(pass the seed through the opts — a bare `setSeed()` before construction gets
clobbered), so two same-seed runs draw the identical sequence. Residual divergence
(direct `Math.random` holdouts, LOD draw-order, the async ability-catalog load) is
documented in `rng.js` and `test/seedrepro.mjs`, which proves the property: same-seed
identical over a 60 s run, different seeds diverge. Suites that assert on a
deliberately-faint behaviour (e.g. the soft-avoid berth, which a wanderlust ambition
roll can legitimately out-score) pin a seed instead of flaking — and restore the
unseeded stream after, so later suites keep their stochastic soak.

## The eval-tool layer (standalone probes, NOT gates)

Beside the pass/fail gate sits a layer of **observer-side eval tools** — `bun
test/<tool>.mjs`, read-only over a finished seeded sim, never part of `headless.mjs`.
They obey the trace's **write-only rule**: display/diagnostic only, never read back by
cognition. This layer is how every recent behaviour bug was *found* (the drifter
cohort, the famine profile, the belief-cap annihilation) — profile first, then fix.

- **`test/lifetrace.mjs`** — the consolidated life-story tool. Flags:
  `--seed <n>`, `--duration <secs>`, `--agent <name|id|most-eventful>` (a per-agent
  eventfulness tally folded across the run — no tick scan), `--digest` (assemble the
  frozen read-only APIs — biography, drive, reasoning trace, arcs, memory, deeds/
  oaths, irony signals, chronicle beats, obituary — into a readable life story),
  `--health-checks`, `--cohort <N>`. The mode flags **compose** (each prints its own
  section; the raw biography is the fallback when none is set).
- **`test/distprobe.mjs`** — the roster-wide **distribution/homogeneity** audit: where
  lifetrace asks "is one life rich?", distprobe asks "is interest *spread*, and are the
  ordinary lives *distinct*?" Prints eventfulness quantiles + top-decile share + zeroes,
  the top souls (class/watch/kills), three MEDIAN life summaries, and the homogeneity
  histograms — primary class, held classes, top profile tag, faith, formative-memory
  kinds, time-use by goal kind — plus an arc-churn detector and the arc-entry snowball
  check. This is the tool that found (and re-measures) the merchant / Blind-Io /
  bond-memory monocultures and the early-arc snowball.
- **`test/health.mjs`** — the pure anomaly-check functions behind `--health-checks`:
  five **ratio-with-absolute-N-floor** heuristics (signalChurn, corpseBloat,
  salienceCollapse — a distribution test, not a mean — arcMonoculture,
  behaviorCollapse) plus four roster-wide cohort metrics (arcEntryFraction,
  keptOathRatioDist, neverNamedFraction, medianGoalBudget). Each divides the smallest
  *existing* fold-on-event aggregate — never a new scan — and returns an
  `{ok|flagged, ratio, floorMet}` triple to assert on, not a magic raw number. The
  N-floor is the load-bearing detail: scale-free, can't false-fire a warm-up world.
  Thresholds in `TRACE.health` (`simconfig.ts`). Lesson recorded: behaviorCollapse
  originally scraped the 24-deep trace ring and **false-flagged 0.92 while measuring
  12/103 agents**; it now reads a dedicated bounded per-agent **goal-dwell
  accumulator** (`signals.ts` `foldGoalDwell`/`goalDwellOf`, folded at the top of
  `decide()` so every commit path is measured) — after: honest 0.14 over 103/103.
- **`test/behaviortrace.mjs`** — the behavioural-diversity probe ("is every NPC a
  discernable character"): dominant-goal histogram + Shannon evenness,
  **trait→behaviour Pearson correlations** (the acid test: do bold souls fight?),
  behavioural spread, ambition-aligned dwell, and `groupCohesion`. Substrate:
  `goalDwellVector(a, now)` in `signals.ts`. This is the instrument that quantified
  the pre-ambition gap (36% of the town drifting on `wander`, correlations ~0.26/0.11)
  and verified the fix ([09](09-reasoning-layer.md)).
- **`test/beliefsweep.mjs`** — sweeps `SIM.beliefsPerAgent` in-process (caps 12–300 ×
  seeds), measuring legibility, cohesion, table fill, and ms/frame per arm. Source of
  the measured cap of 25 and the **annihilation finding** ([02](02-epistemic-split.md)).
- **`test/starveprobe.mjs`** — seeded starvation census (dedup `_diedOfHunger`,
  destitute-vs-moneyed split, mean distance from town anchor) — the
  [survival ladder's](14-survival-economy.md) before/after measure.
- **`test/seedrepro.mjs`** — the determinism gate for the tools above.

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
