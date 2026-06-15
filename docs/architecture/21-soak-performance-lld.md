# 21 (LLD) — Headless soak / test-suite performance: implementation spec

> **Status: DESIGN (not yet as-built).** Goal-driven: make `bun test/headless.mjs` run as fast as
> possible on high-end consumer hardware (baseline **9m44s** wall; the soak suite alone ~**95s**).
> **Hard constraint chosen by the maintainer: BEHAVIOR-PRESERVING ONLY** — every optimization must be
> mathematically/observationally equivalent to today's sim, so `bunx tsc --noEmit` stays clean and
> `bun test/headless.mjs` stays green *with no assertion or baseline edits*. No LOD-style approximation
> that changes emergent trajectories. Two sanctioned levers: **(A)** parallelize the test RUNNER across
> CPU cores (zero sim change), and **(B)** a basket of behavior-preserving sim-tick speedups. Read
> [00 — overview](00-overview.md), [01 — sim spine](01-sim-spine.md), [08 — testing](08-testing.md),
> and [02 — epistemic split](02-epistemic-split.md) first; this doc only changes *how fast* those run,
> never *what* they compute.

> **One-line summary:** the suite is dominated by the fixed-tick cognition spine running over a dense
> ~300-agent town; the runner runs ~36 suites sequentially in one process. Run the suites in parallel
> (bounded below by the longest single suite — the soak), and shave the soak's per-tick cost with exact
> wins: a spatial grid to skip provably-out-of-range perceivables, scratch-object reuse to kill
> per-frame GC churn, cached per-frame roster views, and collapsing two O(N²) observer passes to O(N).

---

## 1. Why it's slow — measured baseline

Measured on this machine (`bun test/headless.mjs`, seed `0xC00D19`):

- **Full suite: ~9m44s–11.2min (584–672s) wall** across runs (machine-load variance; profiling agent
  measured 671.8s). (Windows `time` under-reports child CPU — `user`/`sys` ≈ 0.8s is a measurement
  artifact; `performance.now()` instrumentation confirms the work is real CPU inside `Simulation.update`,
  99.8% of soak wall time.)
- **Soak suite alone: ~172.7s (uninstrumented)** — the profiling agent's clean measurement; **already
  OVER the 2-minute target.** (Earlier 95s was an extrapolation; 170.7s/172.7s from two independent
  instrumented runs is authoritative.) The soak is the single **longest pole**, so it bounds any parallel
  runner — getting the *full suite* under 2 min REQUIRES getting the soak itself well under 2 min.
- The remaining ~8 min is the **other ~35 suites**, many of which also build and drive `Simulation`
  (`scaling` runs 3 sims at N≈60/100/170; `scenarios`, `expeditions`, the 7 `motivation` suites,
  `construction`, `homecoming`, `city`, `migration`, `arcs`, `seeding`…). **Therefore a core sim-tick
  speedup multiplies across the whole suite, not just the soak.**

**Per-pass profile of `Simulation.update`** (3000-frame instrumented run; from the O(N²) audit):

Two independent instrumented runs (O(N²) audit, 3000-frame; profiling agent, full soak) agree on the
ranking; the profiling agent **isolated `reason` as its own 27% pass** (the O(N²) audit had lumped it
into a mixed bucket):

| Pass | % of update | Shape |
|---|---|---|
| `Agent.perceive` | **~37–42%** | per-agent scan of all perceivables — every tick |
| **`reason` (schema interpreter)** | **~27%** | due-agents/tick — 9 active schemas × belief table |
| `Agent.act` (+ steer) | ~11–16% | per-agent, **every frame** (60Hz), 3.7M calls |
| `Agent.decide` | ~8–14% | per-agent, bounded by `beliefs.all()` (cap 25), LOD-gated |
| `groups.tick` | ~4% | O(N²), throttled (`BAND.formEvery`≈20s) |
| `Agent.gossipBeliefs` | ~2.5–3.7% | per-agent roster scan — every tick |
| `statusSensor` | <1% live, 2×O(N²) per 6s fire | throttled |
| `_runMarket` | ~0.8% | per-agent `world.nearest(MARKET)` every tick |
| decay / progression / memory / society passes | <1% each | bounded / throttled |

Config: `SIM.tickHz = 6` (cognition every ~10th frame); `perceive`/`gossip`/`decay`/`act` run **un-thinned
every tick**; `reason`/`decide` are LOD-amortized but LOD only engages above `LOD.fullFidelityBelow = 40`
and exempts anyone near a town centre, so at N≈311 in one dense town **most agents stay full-fidelity**.

**The density reality (load-bearing for the grid's ROI).** A direct probe at frame 2000 (seed
`0xC00D19`): N=311 alive, town spans ~325×410m, and the **average agent has ~126 neighbours within the
22m vision range** (142 within 33m, 268 within 99m). So perceive's cost is *mostly fundamental* — each
agent genuinely perceives ~126 subjects and writes a belief for each. A spatial grid removes only the
**provably-out-of-range** tail; it is an **exact ~1.5–1.9× on perceive**, not the order-of-magnitude its
"90% distance-rejects" framing first suggested. This is why the soak needs a *basket* of wins, not one.

> **CROSS-CHECK (landed).** An independent data-structure audit measured the soak at **170.7s** on its
> run (instrumentation inflates totals ~25%; ratios hold), with `perceive` ≈ **43%** (vs 35% here — the
> spread is warmup/measurement variance; both agree it is the dominant pass). It independently reached the
> **same #1 recommendation (the spatial grid)** and independently flagged the **same load-bearing
> correctness constraint** as §3.B1 below: the query radius MUST cover `visionRange × maxVantage ≈ 33m`,
> not bare `visionRange`, or a high-ground agent silently stops perceiving distant-but-visible subjects.
> It also proposed LOD-gating perceive's own-belief sub-walks (`inferLostQuarries`/`bankDanger`) to 1Hz —
> **REJECTED here as behavior-changing** (it alters inference cadence; the maintainer mandated
> behavior-preserving only). Its other picks (incremental roster views; *leave* `BeliefStore` layout
> alone — decay is already stride-amortized and the table is capped at 25) match §3.B3 / §3.B-omitted.
> The only still-pending input is the profiling agent's per-**suite** wall breakdown for the §2 partition
> table — obtainable empirically by timing each suite when P1 is built, so it does not gate the design.

---

## 2. Lever A — parallelize the test runner (the full-suite win)

**Thesis.** `test/headless.mjs` imports every suite and runs them sequentially in one Bun process. The
suites are already **independent and self-contained** (each builds its own `World`+`Simulation` from the
shared `stubScene`/`makeFighter` in `test/harness.mjs`; the ambient seed is set once at the top). Running
them as N worker processes over the cores collapses 8 min of sequential other-suites into roughly the
cost of the **heaviest worker's bucket**. With the soak isolated on its own worker, the full-suite wall
≈ `max(soak_time, heaviest_other_bucket)`. On high-end hardware (16–32 cores) the other ~35 suites pack
well under the soak's time, so **the full suite converges to ≈ the soak time** — which Lever B then
drives down.

**Design (behavior-identical output, just faster):**

1. A new runner `test/run-parallel.mjs` (the existing `test/headless.mjs` stays as the canonical
   single-process runner — the parallel one is additive, and CI/`CLAUDE.md` can point at either).
2. **Partition** the suites into K buckets by measured cost (greedy longest-processing-time bin-packing;
   the soak gets a dedicated bucket; `scaling` — 3 sims — its own; the cheap unit suites pack together).
   The partition is a static table keyed by suite name (no dynamic work-stealing needed for ~36 items).
3. Each worker is a child Bun process running a thin entry that: `setSeed(0xC00D19)` (identical ambient
   seed → identical draws → **identical PASS/FAIL**), imports only its bucket's suites, runs them in the
   **same relative order** as today, and writes its tally (counts + the FAIL lines) to stdout as one JSON
   line.
4. The parent spawns the workers (`Bun.spawn` / `child_process`), waits for all, **merges tallies**, prints
   the PASS/FAIL lines (grouped by suite so output stays readable), and sets exit code = 1 iff any
   worker reported a failure or died.

**Behavior-preservation argument.** Determinism is per-process: every suite that matters already either
rides the ambient `setSeed(0xC00D19)` or passes its own `opts.seed` to its `Simulation` (the seeded-suite
work in [08](08-testing.md)). Splitting processes cannot change a suite's draws because **no suite reads
another suite's state** — they share only imported pure modules. The only observable change is **stdout
ordering**, which is not asserted on. The shared-seed contract is the one invariant to guard: the
parallel entry must call `setSeed` before importing/running, exactly as `headless.mjs` does.

**Risks / open items:**
- A suite with a hidden **module-level mutable singleton** that two suites in the same worker share
  (e.g. an event `bus`, `xpstats`, `econstats` accumulators) — within a worker, suites run sequentially
  in one process exactly as today, so same-worker sharing is unchanged. **Cross-worker** there is no
  sharing. The risk is only if a *currently-relied-upon* cross-suite ordering exists; the single-process
  run proves today's order is green, and we preserve per-bucket order. **Audit needed:** confirm no suite
  depends on a *prior* suite having run (grep for global accumulators read without reset). [see §6]
- `scenarios.mjs`/`history.mjs` may print a lot; keep their stdout buffered per-worker and flush in
  partition order.

---

## 3. Lever B — behavior-preserving sim-tick speedups

Each item: **current → why slow → change → expected gain → why it preserves behavior → risk.** Ordered by
ROI. All of these speed the soak *and* every other sim-running suite.

### B1 — Spatial grid for perceive / gossip (exact range cull)
- **Current:** `perceive` (`js/sim/agent/perception.ts:67`) iterates **all** `ctx.perceivables` per agent
  per tick; `gossipBeliefs` (`:310`) iterates **all** `ctx.agents`. O(N·M) per tick, un-thinned.
- **Change:** a `SpatialGrid` (`js/sim/spatialgrid.ts`) — a uniform bucket-hash on the x/z ground plane,
  rebuilt **once per cognition tick** in `Simulation.update` (just before the `perceive` pass,
  `simulation.ts:1417`) from `ctx.perceivables`, attached as `ctx.grid`. `perceive`/`gossip` query the
  3×3 cell neighbourhood of the agent instead of the full list. The grid exposes a no-alloc
  `near(x, z): T[]` returning a **shared scratch array** (valid until the next call — single-threaded, each
  pass fully consumes it before the next agent's call).
- **Cell size = the MAX possible effective vision** so the returned set is a guaranteed **superset** of
  anything perceivable: `cell = SIM.visionRange × maxVantage` where `maxVantage = 1 + 0.5 = 1.5` ⇒
  `cell ≈ 33m`. With `cell ≥ maxEffectiveRange`, the 3×3 neighbourhood provably contains every perceivable
  within range; `perceive` then runs its **exact unchanged** distance + concealment test on each candidate
  and rejects the rest. **Nothing in range is ever missed → byte-identical beliefs.**
- **Expected gain:** the two audits bracket it: conservatively ~1.5–1.9× on perceive at the densest
  warmup (126 within vision), up to ~3× at the data-structure audit's measured density (89 within vision,
  361 perceivables scanned → ~89 effective). Either way perceive 35–43% → ~15–20% of update; gossip
  (`talkRange = 3.4m ≪ cell`) gets a larger relative cull (its hits are a handful per cell — its query may
  even use a single cell). Net soak: roughly **170→115–125s** by this change alone (data-structure audit).
- **API (as-built target):** `class SpatialGrid { rebuild(items); near(x,z): T[] }` — `rebuild` clears
  and re-bins all live perceivables once per tick (reusing bucket arrays from a free pool to avoid GC);
  `near` returns the shared scratch (3×3 block gather) the caller iterates with its existing
  for-of + exact-reject body unchanged.
- **Behavior-preservation:** the grid only *avoids touching* perceivables that are mathematically beyond
  the largest range any observer could have. The per-pair body, ordering within the candidate set
  (iteration order of `near()` must match a deterministic order — see risk), and every belief write are
  unchanged.
- **Risk:** **iteration order.** `perceive`'s writes are last-write-wins per subject within a tick, but a
  given observer sees each subject **once**, so order across *different* subjects doesn't change any single
  belief's value. Confirm no pass relies on perceivable *iteration order* for a tie-break (grep). The grid
  must enumerate candidates in a **stable** order (e.g. insertion order, which mirrors `perceivables`
  order) to keep any incidental ordering identical. Buildings/props (non-agent perceivables) must be in
  the grid too (perceive consumes them); gossip skips non-agents via its existing `!o.beliefs` guard.

### B1b — `reason` (schema interpreter) hot-path cleanups — the #2 pass (27%)
- **Current:** `reason(agent, ctx, catalogue)` runs the `InteractionSchema` interpreter
  (`js/sim/schemas/interpreter.ts`) per due-agent per tick. The profiler found two pure-overhead hot
  spots: (a) **the static 9-schema catalogue is re-sorted by priority every call** (`interpreter.ts:71`)
  — same order every time; (b) **a fresh string TTL key `` `${s.id}|${env.subjectId}` `` is allocated on
  every predicate evaluation** (`interpreter.ts:99`), hot string garbage at 9 schemas × due-agents × tick.
- **Change:** (a) pre-sort the catalogue **once** (module load or first call) since priority is static —
  iterate the pre-sorted array; (b) replace the per-eval string key with a composite numeric key or a
  nested `Map<schemaId, Map<subjectId, ttl>>` so no string is built per evaluation.
- **Expected gain:** `reason` is ~27% of update — even a 20–30% trim of it is ~5–8% of total soak.
- **Behavior-preservation:** a stable pre-sort yields the **identical evaluation order** (priority is the
  sort key and is static; ties keep their original order via a stable sort); the TTL cache keyed
  numerically/nested holds the **same (schema,subject)→ttl** mapping as the string key — same cache hits,
  same fires. No predicate result changes.
- **Risk:** the sort must be **stable** and the pre-sorted array must not be mutated by per-agent state;
  the cache-key change must preserve the exact (schema,subject) identity (no collisions). Verify against
  the `schemas` suite + the soak's output-stability assertions.

### B2 — Kill steer-fill per-frame allocation (scratch reuse)
- **Current:** `act` (`js/sim/agent/act.ts:128`) calls a steer-fill **every frame per agent**; nearly every
  fill (`attractField`, `withRoad`, `fillFollow`, `fillWander`, `chooseWorkSite`, `chooseRefuge`,
  `fillSightsee`, …) allocates a fresh `Field` object + `attractors`/`repulsors` arrays + `Force` objects
  (~3.6M Field allocations + arrays + forces over the soak — the dominant GC source).
- **Change:** reuse a **pooled scratch field** that fills mutate in place. `steer()` consumes the field
  synchronously before the next fill runs, so a single per-agent (or module) scratch with pre-allocated
  force slots is safe in this single-threaded sim. Helpers (`chooseWorkSite`/`chooseRefuge`) reuse a
  scratch candidate array (`.length = 0`) and hoist their `distanceOf`/`valueOf` closures out of the loop.
- **Expected gain:** removes the bulk of soak GC churn; act 15.8%→~10–12%, plus less GC stall everywhere.
- **Behavior-preservation:** identical force math, identical `steer()` output — only the allocation
  lifetime changes. The steer-collapse regression net in `soak.mjs` (every baseline `goal.kind` still
  emerges) is the guard.
- **Risk:** a fill that **composes** another fill into the same scratch (e.g. `withRoad` pushing a second
  attractor) must not alias a single shared force slot incorrectly. Mitigate by giving the scratch enough
  fixed slots (max forces any fill uses is small: ≤2 attractors + ≤1 repulsor) and resetting lengths at
  entry. Re-entrancy: no fill calls `near()`/another fill that grabs the *same* scratch mid-build except
  the known `withRoad`/`hauntForce`/`dangerForce` composition — handle those explicitly.

### B3 — Cache per-frame roster views (`fighters`, `_perceivables`, ctx)
- **Current:** `sim.fighters` (`simulation.ts:624`) rebuilds a 300-element `.map()` array **on every
  access** (twice per frame in the soak loop); `_perceivables()` `.concat()`s once buildings exist; `_ctx()`
  / `_cognitionCtx()` rebuild a fresh literal each frame.
- **Change:** maintain `fighters` and `_perceivables` as **cached arrays rebuilt only on roster/percept
  mutation** (spawn / reap / percept add+remove already funnel through known methods); reuse a single ctx
  object by mutating its `time`/`perceivables` fields per frame. In the soak driver, hoist `sim.fighters`
  to one call per frame.
- **Expected gain:** removes ~24k+ 300-element array allocations + 2 ctx literals/frame over the soak.
- **Behavior-preservation:** same contents; cache invalidation is keyed to the exact mutation points that
  change membership. The ctx is read-only to consumers, so reusing the object is invisible.
- **Risk:** missing an invalidation site → stale roster. Mitigate with a single `_invalidateRosterCaches()`
  called from every add/remove/death path, asserted in a small unit check (roster cache equals a fresh
  rebuild after each mutation).

### B4 — Collapse `statusSensor` 2×O(N²) → O(N) per fire
- **Current:** `runStatusSensor` calls `statusSensor` per agent; each call runs `rosterMeanStanding`
  (`statusSensor.ts:28`, full roster scan + `beliefs.get`) **and** the rags-to-riches deference-mass loop
  (`:79`) — 2×O(N²) every `STATUS.passSecs ≈ 6s`.
- **Change:** once per fire, do **one** O(N²) sweep that accumulates, per subject id, `{sumStanding,
  count, warmCount}` over all observers, into a scratch `Map`; each agent then reads its own row in O(1).
  Collapses 2×O(N²) → 1×O(N²) (and the per-subject row is reusable for both the mean and the deference
  mass). Optional further step (incremental inbound-standing sums maintained on belief change) is **out of
  scope** — higher behavior-preservation risk; the single-sweep collapse is the safe win.
- **Expected gain:** ~2–3× on the statusSensor share of the ~27% bucket.
- **Behavior-preservation:** the computed `mean` and `warmed` counts are **identical** (same operands, same
  summation set; floating-point summation order is preserved by iterating the roster in the same order).
- **Risk:** float summation order — keep the accumulation roster-ordered so `sum/n` is bit-identical.

### B5 — Grid-prefilter the O(N²) society passes
- **Current:** `groups.tick` `_formFrom` (`groups.ts:131`) and similar throttled passes nest roster loops.
- **Change:** reuse the §B1 grid for their neighbour candidate search (band-formation, faith spread,
  courtship) where the inner loop is a *proximity* query. Throttled already, so low absolute ROI — **do
  last**, only if §B1–B4 leave the ~27% bucket dominant.
- **Behavior-preservation:** same as B1 — exact superset cull within the pass's own radius.

### B6 — perceive per-pair micro-opts (within the candidate set)
- **Current:** `perceive` uses `Math.hypot` for the first reject (`perception.ts:80`); several hot gates
  elsewhere use `distanceTo`/`Math.hypot` where squared distance suffices.
- **Change:** square the **reject** comparison (`dx*dx+dz*dz > (range)²`) — the concealment-refined check
  can keep the sqrt only when needed; hoist per-observer invariants (`vantage`, `eff` base) out of the
  loop (already partly done). Same for `gossip`'s `talkRange` gate and the ally/social range gates.
- **Behavior-preservation:** squared-distance comparison is exactly equivalent to the sqrt comparison for
  the **reject branch**; values that survive still get the precise computation. No belief value changes.
- **Risk:** ensure any place that *uses* the distance magnitude (not just compares it) keeps the sqrt.

### B7 — `runMarket` nearest-market cache
- **Current:** `atMarket` calls `world.nearest(POI_KIND.MARKET, a.pos)` per agent per tick
  (`market.ts:193`). Markets are static.
- **Change:** precompute each agent's nearest market once (cache on the agent; invalidate on town change,
  which is rare) or bucket agents by town. Low ROI (0.8%) — opportunistic.

---

## 4. Phasing (each step keeps `tsc --noEmit` + `headless.mjs` green)

The levers are independent; ship small. After **every** phase: run `bunx tsc --noEmit` and the
single-process `bun test/headless.mjs`, and record the soak suite's wall time.

- **P1 — Parallel runner (Lever A).** Add `test/run-parallel.mjs` + the per-bucket entry; partition table;
  tally merge. Pure additive; `headless.mjs` untouched. Verify identical PASS/FAIL set vs single-process.
  **Biggest full-suite win, zero sim change** → do first.
- **P2 — Spatial grid (B1).** Add `spatialgrid.ts`; wire `ctx.grid`; route `perceive` + `gossip`. Guard the
  candidate-iteration order. (Epistemic scan: the grid is built by the orchestrator from `perceivables`
  and queried with own-position only — it reads no foreign truth into cognition; confirm it passes
  `test/suites/epistemic.mjs`.)
- **P3 — Scratch reuse in steer (B2)** + **per-frame caches (B3).** The GC wins. Lean on the steer
  regression net + roster-cache unit check.
- **P4 — statusSensor collapse (B4)** + **perceive micro-opts (B6)** + **market cache (B7).**
- **P5 — society-pass grid prefilter (B5)** — only if still worthwhile after P2–P4 re-profile.

Re-profile after P2–P4 to decide whether the soak is low enough that the parallel runner already puts the
full suite where we want it; B5 is contingent.

---

## 5. Invariants this work must NOT touch

- **Epistemic split** ([02](02-epistemic-split.md)): the grid/caches are orchestrator-built observer
  infrastructure queried with the agent's OWN position; they feed `perceive`/`gossip` the same candidates
  the full scan would. No cognition pass gains a new foreign-truth read. The grid module must pass the
  epistemic source scan (it lives on the execution/orchestration side, like `_perceivables`).
- **Gold conservation, the freeze lesson, profession/inventory guards** — untouched; no economic or
  agent-shape change.
- **Determinism / seeded suite** ([08](08-testing.md)) — preserved by identical draw order (parallel
  workers re-seed; sim changes don't alter RNG consumption: none of B1–B7 call `rng()` differently).
- **The soak's own regression nets** — the steer `goal.kind` repertoire superset, gold conservation,
  trades-occurred, director valves — are the behavior-preservation test oracle; they must stay green
  unedited. **If any soak assertion needs editing, the change was NOT behavior-preserving and is rejected.**

---

## 6. Open questions / blockers

- **[RESOLVED] Behavior fidelity:** maintainer chose **behavior-preserving only** — no LOD approximation.
  All §3 items are exact; the approximate options (K-nearest perceive cap, coarse distant cognition) are
  **out of scope**.
- **[RESOLVED] Parallelism sanctioned:** yes — Lever A is in scope.
- **[RESOLVED] Target:** maximize on high-end consumer hardware; full-suite and soak both.
- **[NEEDS AUDIT, not user] Cross-suite state coupling for the parallel runner (§2 risk).** Before P1
  lands, grep for module-level mutable singletons read across suites without reset (`bus`, `xpstats`,
  `econstats`, any `setSeed`-sensitive global). Within a worker, suite order is preserved, so the only
  failure mode is a suite that *today* relies on a **previous** suite having run. The single-process green
  run is evidence none does, but confirm explicitly. **This is a code audit, not a maintainer decision.**
- **[CONFIRM cheaply] Grid candidate-iteration order (§3.B1 risk).** Determine whether any consumer relies
  on `perceivables` iteration order for a tie-break. Expectation: no (each subject is seen once per
  observer). If confirmed, the grid may enumerate in any stable order; if not, mirror insertion order.
- **[CROSS-CHECK] Fold in** the profiling agent's per-suite breakdown (parallel-runner partition) and the
  data-structure agent's grid-API refinements when they land.

> **Unrelated but surfaced:** doc 20 (render-only frontend) is **architectural, not a soak-perf lever**
> (its `document`-guarded branches already no-op headless; its one soak-relevant change —
> `updateMatrixWorld` on the combat path — is a *browser* cost). Its self-review found one **[NEEDS USER]**
> blocker (P2 combat geometry: animated weapon-node sample vs static `aimYaw` ray). That question is
> independent of this performance work.

---

## 7. Measurement plan

- Baseline recorded: full suite 9m44s; soak ~95s; per-pass profile + density above.
- After each phase: `bunx tsc --noEmit` (clean) → `bun test/headless.mjs` (green, **no assertion edits**)
  → record soak wall + (for P1) full-suite wall under `test/run-parallel.mjs`.
- Keep the instrumentation as a scratch `test/profrun.mjs` (per-pass timers) so each phase's gain is
  attributable to the pass it targeted, not guessed.
- **Acceptance:** full-suite wall minimized; the headline number to report is `test/run-parallel.mjs`
  wall (the parallel path) and the single-process soak wall (the long-pole the parallel path is bounded
  by). Behavior-preservation is proven by the unedited green suite.

---

## 8. Review notes / resolved blockers (adversarial verification pass)

> Verified against the actual code at this commit. file:line evidence inline. The two flagged audits
> (Lever A cross-suite state; B1 candidate-iteration order) are RESOLVED below; one new blocker the
> doc UNDERSTATED is surfaced and resolved (the **ambient RNG stream is module-level mutable state**,
> so it IS cross-suite shared state — but the suite assertions are draw-tolerant, so the parallel
> runner is safe with one explicit guard). Verdict at the end.

### 8.1 B1 — spatial-grid max-range correctness  ✔ VERIFIED, with a correction to the cell-size rationale

- `perception.ts:62` — `vantage = 1 + Math.max(-0.2, Math.min(0.5, myH * SIM.vantagePerMeter))` ⇒
  `vantage ∈ [0.8, 1.5]`. Max vantage **1.5**. ✔
- `perception.ts:81` cheap reject `d > SIM.visionRange * vantage`; `:83` `eff = visionRange × vantage ×
  (1 − concealWeight·cover)`. `concealmentAt` (`arena.ts:128–137`) returns `Math.max(0, Math.min(0.7, c))`
  ⇒ `cover ≥ 0` ⇒ the `(1 − …)` factor ∈ (0,1] ⇒ **`eff ≤ visionRange × vantage ≤ visionRange × 1.5`**.
  Concealment only REDUCES range. ✔ So `cell ≥ visionRange × 1.5 = 33m` is a guaranteed superset for the
  perceive pass. **Byte-identical beliefs hold** — the grid only avoids touching provably-out-of-range
  candidates.
- **CORRECTION — `visionRange` is the global perceive max, but the cell-size *justification* in §B1 is
  slightly wrong as written.** `SIM.visionRange` is a single global constant (`simconfig.ts:1855`,
  value 22); it is **never per-agent, never class/ability/buff-boosted, never terrain-scaled beyond the
  vantage/conceal factors already in perceive**. I grepped every `visionRange` site:
  - The ONLY belief-writing sight path is `perceive` (`perception.ts`). There is **no second long-range
    sensor** (no hearing, no scout/spy vision wider than base) that writes beliefs. The spy pass
    (`intrigue.ts:357,383`), watch (`watch.ts`), reporter, and combat-witness folds
    (`combatEvents.ts:386,519`, `simulation.ts:1116,1128,1136,1176`) all gate at **exactly
    `SIM.visionRange`** (≤ 22m < 33m cell) — so a 33m grid is a superset for them too IF they were ever
    routed through it (they are not in P2; they stay full-scan).
  - Two sites use a **larger** multiple but neither is a perceive/grid consumer: `beliefs.ts:532`
    `inferDestination` uses `visionRange*1.6` to project a *destination point along a heading* (a derived
    geography point, not a perception radius — no candidate enumeration), and `combatEvents.ts:609`
    `(visionRange*3)²` is a **rally** radius (a witness-broadcast, full-roster scan, not perceive). If B5
    ever grid-prefilters those passes, each pass must size its OWN query radius to its own constant
    (`*1.6`, `*3`) — the §B1 33m cell is sized for perceive ONLY. **Do not reuse the perceive grid's
    `near()` for a pass with a larger radius without widening the query to that pass's radius.** (B5 §note.)
  - `gossipBeliefs` (`perception.ts:315`) gates at `SIM.talkRange = 3.4` (`simconfig.ts:1838`) ≪ 33m cell.
    `decide.ts:286,362` ally/foe gates use `visionRange` (≤ cell). All proximity consumers the grid
    would serve are SMALLER than the cell. ✔
- **RESOLVED true max range + cell size:** the perceive grid must cover **`SIM.visionRange × 1.5 ≈ 33m`**;
  `cell = 33m`, 3×3 neighbourhood query, is a guaranteed superset. gossip (talkRange 3.4m) and the
  decide ally/foe gates (≤ visionRange) are all strictly inside one cell.

### 8.2 B1 — iteration-order safety  ✔ VERIFIED — any stable order is sufficient

- `perceive` (`perception.ts:67`) is the ONLY consumer of `ctx.perceivables` (grep: `gossip`/`intrigue`/
  `surveyor` consume `ctx.agents`, the roster, not perceivables). Inside the loop each candidate `o` is
  processed **independently** and writes via `a.beliefs.observe(o.id, …)` keyed by `o.id`. There is **no
  cross-subject tie-break, no "first match wins" over the candidate set, no min/argmax that depends on
  visiting order** — every belief write is a function of `(a, o)` alone.
- The only way order could matter is if the SAME subject id appeared twice in one perceivables list
  (last-write-wins). It cannot: `sim.percepts` is disjoint from `sim.agents` (`simulation.ts:642`,
  building ids namespaced `B:<n>`), and `_perceivables()` is `agents.concat(percepts)` (`:636`) — each id
  appears exactly once. **Each observer sees each subject exactly once per tick.**
- **RESOLVED order requirement:** the grid may enumerate candidates in **ANY stable order**. It need NOT
  preserve `perceivables` insertion order — there is no incidental ordering dependence to protect. (The
  §B1 "mirror insertion order to be safe" caution is over-cautious; it is harmless but unnecessary.)
  *Non-determinism caveat:* the order must be **deterministic across runs** (a fixed bucket-walk order),
  not literally insertion order — never rng-seeded, never Map-iteration-of-a-mutated-Map. A stable cell
  walk satisfies this.

### 8.3 B2 — scratch-reuse safety  ✔ VERIFIED — scratch needs **2 attractor + 1 repulsor** fixed slots

- `act.ts:128–129` — dispatch is `const field = fill(a, ctx); const arrived = steer(a, field, dt)`:
  `steer()` **fully consumes the field synchronously** (Stage A loops `field.attractors`/`field.repulsors`,
  produces a heading, steps, returns a bool — `steer.ts:121–191`) before the next agent's `fill()` runs.
  No field is retained across calls; nothing stores a returned `Field`/`Force`. ✔ Single-threaded, fully
  synchronous — a module-level pooled scratch is safe.
- **Max forces any single fill emits** (enumerated across all of `steer.ts`):
  - `attractField` → 1 attractor.
  - `withRoad` (`:78`) → up to **2 attractors** (target + road point) **+ up to 1 repulsor** (`dangerForce`).
  - `fillWander` townsfolk branch (`:381–391`) → up to **2 attractors** (wanderTarget + `hauntForce`)
    **+ up to 1 repulsor** (`dangerForce`).
  - `fillFollow` (`:636–637`) → 1 attractor (or a `snapTo`, which carries no force arrays).
  - `fillFlee`/`fillAvoid`/`fillProtect`/all others → 1 attractor OR 1 repulsor (XOR).
  - **Global maximum = 2 attractors + 1 repulsor.** (`withRoad` and the townsfolk-wander branch are the
    only two that hit it; both compose a SECOND attractor + a danger repulsor into one field.)
- **Composition / aliasing hazard:** a fill composing a helper (`hauntForce`, `dangerForce`, `roadPull`)
  builds its `Force` objects INLINE into a freshly-allocated `attractors`/`repulsors` array TODAY. If you
  pool the `Field` + its two arrays, the hazard is: a helper returning a `Force` that the fill then
  `.push`es. With a pooled scratch you must (a) `scratch.attractors.length = 0; scratch.repulsors.length =
  0` at fill entry, and (b) WRITE INTO pre-allocated slot objects (`slot.pos = …; slot.weight = …`) rather
  than pushing helper-returned `Force` literals — otherwise a helper's returned object escapes the pool.
  None of the helpers retain a reference to the `Force` they return, and `steer` reads `f.pos`/`f.weight`
  immediately, so in-place mutation is observationally identical.
- **RESOLVED scratch slot count:** a safe scratch needs **2 attractor slots + 1 repulsor slot** (3 `Force`
  objects + the 2 arrays + 1 `Field`), reset (`length=0`) at each fill entry. No fill re-enters another
  fill that grabs the same scratch mid-build (helpers return plain `Force`/point objects, they do not call
  `steer` or another fill). The `snapTo` path uses no force slots. **One module-level scratch is correct**
  (a per-agent scratch is unnecessary — fields never outlive a single `fill→steer` pair).
  *Watch-out:* `_away` (`steer.ts:92`) and `ZERO` (`steer.ts:65`) are already module scratch/constants and
  are consumed synchronously — leave them; do not also route them through the new pool.

### 8.4 B3 — cache-invalidation completeness  ⚠ VERIFIED-WITH-CAVEAT — membership is mutated in MANY scattered places; there is NO single chokepoint

`sim.agents` membership and `sim.percepts` are mutated at these exact sites (grep `agents.push|splice`,
`agentsById.set|delete`, `spawnPercept|despawnPercept|percepts.push|splice`). **These are the precise
invalidation points a cached `fighters`/`_perceivables` must hook:**

*Roster ADD (`agents.push` + `agentsById.set`):*
- `simulation.ts:455–456` (spawn townsfolk), `:487–488` (spawn camp/monster bodies), `:575–576`
  (`spawnAgent` generic), `:610–611` (`addPlayer`).
- `expeditions.ts:183` (expedition member spawn).
- `lineage.ts:342–343` (birth).
- `director/raids.ts:150–151` (raid spawn).
- `reporter.ts:81–82` (reporter spawn).
- `seeding.ts:124–125` (narrative seed spawn).
- `dungeonManager.ts:270–271` (dungeon monster spawn).

*Roster REMOVE (`agents.splice` + `agentsById.delete`):*
- `simulation.ts:1558–1560` (the reaper — the death/escheat path).
- `expeditions.ts:193–194` (expedition return/disband).
- `director/raids.ts:60–61` (raid despawn).
- `dungeonManager.ts:281–283` (dungeon teardown).

*Percept mutation:*
- `simulation.ts:642` `spawnPercept` (the chokepoint — Scarecrow `:664`, construction `construction.ts:627`
  both route through it).
- `simulation.ts:646` `despawnPercept` (construction `construction.ts:795` routes through it).

**Findings / mitigation:**
- **`percepts` DOES have a single chokepoint** (`spawnPercept`/`despawnPercept`). A cached `_perceivables`
  is safe: invalidate in exactly those two methods. ✔ Low risk.
- **`agents` does NOT have a single chokepoint** — 8 add sites + 4 remove sites across 6 files. A cached
  `fighters` array is therefore HIGHER risk than the doc implies ("spawn / reap / percept add+remove
  already funnel through known methods" — the percepts do; the roster does NOT). Two safe options:
  1. **Recommended:** add a `_addAgent(a)`/`_removeAgent(a)` pair on `Simulation` that does the
     `push`+`set` / `splice`+`delete` AND `_invalidateRosterCaches()`, then mechanically route all 12 sites
     through it (they already do the same two-line push/set pair, so this is a pure refactor — no behavior
     change). This CREATES the chokepoint the cache needs. The roster-cache unit check (`fighters` equals a
     fresh `.map()` rebuild after each mutation) the doc proposes is the guard.
  2. Cheaper but weaker: dirty-flag the cache on a length change detected at `fighters` access
     (`if (this._fightersCache && this._fightersCache.length === this.agents.length) return cache`) — but a
     same-length swap (a death + a birth in one tick) defeats it. **Reject option 2** — the same-length
     race is exactly the kind of silent staleness the freeze-lesson warns against.
- The `fighters` getter (`simulation.ts:624–629`) also folds in combat-body percepts; its cache must
  invalidate on BOTH roster AND percept mutation. The `_perceivables` cache (`:635–637`) invalidates on
  percept mutation only (it references `this.agents` live — but `.concat` snapshots, so it must also
  invalidate on roster mutation). **Conclusion: both caches key to `_invalidateRosterCaches()` called from
  the new `_addAgent`/`_removeAgent` AND from `spawnPercept`/`despawnPercept`.**
- **RESOLVED invalidation site list:** the 12 roster sites + 2 percept methods above. B3 is implementable
  behavior-preservingly ONLY if P3 first introduces the `_addAgent`/`_removeAgent` chokepoint refactor;
  hooking 12 scattered call sites by hand is the stated risk and SHOULD be the refactor, not 12 edits.

### 8.5 B4 — statusSensor float-order  ✔ VERIFIED — single sweep can be bit-identical

- `rosterMeanStanding` (`statusSensor.ts:28–38`) iterates `sim.agents` in array order accumulating
  `sum += b.standing; n++` then returns `sum/n`. The rags deference-mass loop (`:79–83`) iterates
  `sim.agents` in the **same array order** counting `warmed`. Both are `for (const o of sim.agents)` with
  identical skip predicates (`!o || o===a || !o.alive || o.controlled || !o.beliefs`).
- A single precompute sweep over `sim.agents` (the SAME array, SAME order) accumulating per-subject
  `{sumStanding, count, warmCount}` into a scratch `Map`, then each agent reading its own row, produces
  **bit-identical `sum/n`** (same operands, same summation order → same IEEE-754 rounding) and an identical
  integer `warmed` count. ✔
- **One caveat the change MUST honour:** the collapsed sweep is `for each observer o: for each subject a:
  accumulate row[a]`. To keep `sum/n` bit-identical to the current `for each subject a: for each observer
  o` shape, accumulate row[a] in **observer-array order** (the outer loop is observers, inner is the
  observer's belief table) — equivalently, ensure each subject's `sumStanding` is summed over observers in
  `sim.agents` order. The current code sums per-subject over observers in roster order; the collapsed sweep
  naturally does the same if the outer loop is `sim.agents` (observers) and rows are keyed by subject. ✔
- **RESOLVED:** bit-identical preserved by keeping the roster-order accumulation. Safe win.

### 8.6 Lever A — cross-suite shared mutable state  ⚠ RESOLVED, but the doc's premise is WRONG and needs the fix below

> The doc claims (§2): "no suite reads another suite's state — they share only imported **pure** modules."
> **This is false.** Three module-level mutable singletons are shared across all suites in a process:
> the event `bus` (`events.ts:55`), the `xpstats`/`econstats` accumulators (`xpstats.ts:10`,
> `econstats.ts`), and — the one the doc misses entirely — **the ambient RNG stream `_a` in `rng.ts:28`**.
> The verdict is still "parallel-safe", but for a more careful reason than the doc gives.

**(a) The event `bus` — SAFE despite stacking.** Suites build a `Simulation`; its constructor subscribes
the deed router (`simulation.ts:265` `installDeedRouter`) + the coord witness (`:267`). **No suite calls
`sim.dispose()`** except `signals.mjs:715` (softAvoid) — so subscriptions STACK across the ~36 suites in
one process. This is harmless: `installDeedRouter` (`deedRouter.ts:24–31`) looks up `ev.actorId` in **its
own captured `sim.agentsById`**; a stale sim's router returns `undefined` for a later sim's agent and
no-ops. The bus snapshots listeners per emit (`events.ts:43–45`), so a stale listener can't corrupt a live
emit. **Cross-sim isolation holds with or without dispose** — identical today and per-worker. (Note: this
means today's single-process run ALREADY tolerates N stacked routers; the parallel runner has FEWER per
worker, strictly less stacking. No new risk.)

**(b) `xpstats` / `econstats` — SAFE because the Simulation ctor resets them.** They are module globals
(`xpstats.ts:10`, `econstats.ts`) but `Simulation`'s constructor calls `resetXpStats()` + `resetEconStats()`
(`simulation.ts:259–260`) on EVERY build. The only readers in the headless path are `soak.mjs:140,196`
(`econTotals`/`xpByVerb`), and the soak reads them **after building its own sim** (`soak.mjs:23`), which
reset them. So the soak measures ONLY its own run regardless of what ran before. ✔ No suite reads an
accumulator populated by a *prior* suite. (The other reader, `test/depth.mjs:26–27`, calls the resets
itself and is NOT in `headless.mjs`.)

**(c) The ambient RNG stream — the REAL cross-suite coupling, and the one P1 must guard.** `rng.ts` is a
module singleton: `setSeed(0xC00D19)` (`headless.mjs:65`) arms one shared mulberry32 counter `_a`, and
EVERY suite that builds `new Simulation(…)` **without** `opts.seed` rides that single advancing stream
(`simulation.ts:232` only re-seeds when `opts.seed !== undefined`). I grepped all suite `new Simulation`
calls: **only `signals.mjs:659` passes `{ seed: 1234 }`**; every other suite (including the **soak**,
`soak.mjs:23`) inherits the ambient stream **at whatever position the preceding suites left it.**
- Consequence: a suite's `rng()` draws depend on **how many draws every prior suite consumed**. If the
  parallel runner repartitions suites into different buckets, each suite's *starting stream position*
  changes → its draws change. The doc's "splitting processes cannot change a suite's draws" is therefore
  **only true if each worker reproduces the exact ambient-stream prefix the single-process run had at that
  suite's start** — which a naive partition does NOT.
- **Why it is nonetheless safe (the resolving evidence):** the suites that ride the ambient stream assert
  **draw-tolerant aggregate invariants**, not specific draws. The soak (the only big stochastic ambient
  rider) asserts conservation equalities, "trades > 0", "≥2 commodities", "≥1 chronicle beat", "≥2 group
  types", "some ambition progressed" (`soak.mjs:130–208`) — all hold for ANY reasonable seed/position, not
  a pinned sequence. The small hand-built suites (softAvoid, depth, schemas, motivation fixtures) use
  fixed fixtures and do not draw rng for their assertions. **No suite pins a specific rng draw it inherited
  from a prior suite.** Independent corroboration: `signals.mjs:714` already calls `setSeed(getSeed())` —
  which `getSeed()` returns the seed *number* `0xC00D19`, so `setSeed` RESETS the stream to position 0
  mid-run (`rng.ts:46–49`). The current single-process suite **already survives an ambient-stream reset
  partway through** and stays green — direct proof the downstream suites (incl. the soak) are not pinned to
  a precise inherited stream position.
- **REQUIRED GUARD for P1 (this is the resolution, not just an observation):** the per-bucket worker entry
  MUST, like `headless.mjs`, call `setSeed(0xC00D19)` once before running its suites, AND must preserve the
  construction-suite isolation (`headless.mjs:154–157`: snapshot `getState()`, `setSeed(2024)`, run
  `constructionTest`, `setState(prev)`) **within whatever bucket holds `constructionTest`** — keep
  `constructionTest` and its getState/setState wrapper together in ONE bucket. With per-worker
  `setSeed(0xC00D19)` + draw-tolerant assertions, repartitioning is safe. Do **not** rely on reproducing
  the cross-suite stream prefix — that is brittle and unnecessary; rely on the assertions being aggregate.
- **One suite that is NOT freely relocatable:** `constructionTest` (`headless.mjs:155`) is the ONLY suite
  that depends on a SPECIFIC seed (`2024`, "verified to clear the builder-housed + guildhall-converge
  gates") and snapshots/restores the ambient stream around itself. It is **self-isolating** (it sets its
  own seed and restores), so it is relocatable to any bucket **provided its getState/setState wrapper
  travels with it** (it currently lives in the runner, not the suite — the parallel entry must replicate
  that wrapper around it). `signals.mjs`'s softAvoid/oathArc sub-tests that pass `seed:1234` and restore
  are likewise self-contained. Every other suite is draw-tolerant and freely relocatable.
- **VERDICT (audit #6):** parallel-safe **with the per-worker `setSeed(0xC00D19)` guard + keeping the
  constructionTest seed-isolation wrapper intact in its bucket.** No suite reads a prior suite's xpstats/
  econstats/bus state; the only cross-suite coupling (the ambient RNG position) is absorbed by draw-tolerant
  assertions, independently proven by the existing mid-run `setSeed` reset surviving green.

### 8.7 Other "behavior-preserving" claims & cross-phase dependencies

- **B6 squared-distance reject — VERIFIED equivalent**, with one precision caveat. `perception.ts:80` uses
  `Math.hypot(ddx, ddz)` then compares `d > visionRange*vantage` (`:81`) and `d > eff` (`:84`). Replacing
  the FIRST reject with `ddx*ddx+ddz*ddz > (visionRange*vantage)²` is exactly equivalent **for the reject
  branch**. BUT note `d` (the sqrt) is **not reused** after the gates in the current body — it is only
  compared, never stored on the belief. So B6 can drop the sqrt for BOTH gates and never needs it back,
  *unless* a future field consumes magnitude. (The `eff` gate's `d` is also only compared.) ✔ No belief
  value changes. Keep `concealmentAt` reading `o.pos` unchanged.
- **B5 grid reuse — VERIFIED hazard (already flagged in §8.1):** `groups.ts` / faith / courtship passes
  have their OWN radii. Do not reuse the 33m perceive cell unless the pass's radius ≤ 33m; size the query
  to the pass's own constant. Low ROI; contingent.
- **B7 market cache — VERIFIED low-risk.** `market.ts:193` `atMarket` calls `world.nearest(MARKET, a.pos)`;
  markets are static POIs. A per-agent nearest-market cache invalidated on town change is behavior-identical
  (the nearest static POI to a fixed-town agent doesn't change). ✔
- **Cross-phase independence — VERIFIED, with ONE ordering constraint.** P1 (runner) is fully additive
  (`headless.mjs` untouched) and independent of P2–P5. P2 (grid) / P3 (scratch+caches) / P4 (statusSensor+
  micro-opts) / P5 each touch disjoint code (perceive vs steer vs simulation getters vs statusSensor) and
  can ship in any order. **The one real constraint: B3 (per-frame caches) MUST land its `_addAgent`/
  `_removeAgent` chokepoint refactor (§8.4) BEFORE or WITH the `fighters` cache**, or the cache goes stale
  on a lineage birth / raid spawn / expedition return / dungeon spawn — those are live in the soak and
  WOULD silently break gold-conservation reads or roster-count assertions. This is the single hidden
  cross-cutting dependency; it is *within* B3, not across phases.

### 8.8 Blockers

- **[resolved: B1 cell size]** Perceive grid cell = `SIM.visionRange × 1.5 ≈ 33m`; superset-correct; vision
  is the global perceive max (no wider belief-writing sensor exists). gossip/decide gates all < 1 cell.
- **[resolved: B1 iteration order]** Any *deterministic* stable order; insertion order NOT required; each
  subject seen once per observer (percept/agent ids disjoint).
- **[resolved: B2 scratch slots]** 2 attractor + 1 repulsor fixed slots, `length=0` reset at fill entry,
  in-place slot mutation (don't push helper-returned Force literals). One module-level scratch.
- **[resolved: B3 invalidation]** 12 roster sites (8 add / 4 remove across 6 files) + 2 percept methods
  listed in §8.4. **Requires a `_addAgent`/`_removeAgent` chokepoint refactor first** (roster has NO single
  chokepoint today; percepts do). With the chokepoint, behavior-preserving.
- **[resolved: B4 float order]** Single sweep is bit-identical if accumulated in roster (observer-array)
  order.
- **[resolved: Lever A]** Parallel-safe with per-worker `setSeed(0xC00D19)` + keeping the constructionTest
  getState/setState seed-isolation wrapper in its bucket. The doc's "suites share only pure modules" is
  false (bus/xpstats/econstats/rng are mutable singletons) but each is either ctor-reset (xpstats/econstats),
  lookup-isolated (bus), or draw-tolerant (rng) — proven by the existing mid-run `setSeed` reset staying
  green. No suite reads a prior suite's accumulator. constructionTest is the only seed-pinned suite and is
  self-isolating.
- **[NEEDS USER: none]** No maintainer decision is required; all audits resolve to code facts.

### 8.9 Verdict

**Implementation-ready, with two mandatory implementation notes folded in (not blockers):**
1. **P1** must re-seed per worker (`setSeed(0xC00D19)`) and keep the `constructionTest` seed-isolation
   wrapper inside its bucket. Rely on draw-tolerant assertions, NOT on reproducing the cross-suite RNG
   prefix.
2. **P3/B3** must introduce a `Simulation._addAgent`/`_removeAgent` chokepoint (pure refactor of the 12
   existing push/splice sites) before caching `fighters`; `_perceivables` already has the
   `spawnPercept`/`despawnPercept` chokepoint. Both caches invalidate via one `_invalidateRosterCaches()`.

Everything else (B1/B2/B4/B6/B7) is behavior-preserving as specified and verified above. The §B1
cell-size *rationale text* should be read with §8.1's correction (the cell is sized for perceive's
`visionRange×1.5`; other passes with larger radii must NOT reuse that cell unwidened).
