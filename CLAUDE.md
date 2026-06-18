# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Hearsay" / "Market Town" — a Theory-of-Mind agent simulation. NPCs act on what they **believe**,
not on what is true: they perceive, gossip (with fading confidence + provenance), trade on price
beliefs, hold grudges, level up emergent classes, join warbands, follow small gods, and some are
spies who disguise and plant false rumours. It began as a browser TypeScript/Three.js sandbox; that
codebase is **gone**. The project is now a **Rust ECS simulation** (parallel, deterministic) with a
thin render-only frontend planned on top.

> The repo is just two trees: **`rust/`** (the sim) and **`docs/`** (architecture). There is no
> TypeScript/JS sim anymore — older docs/memories that reference `js/**`, `types/**`, `.ts`/`.mjs`
> files, `tsc`, or Bun are **historical**. Don't call Rust "the port"; it's the sim.

## Build / test / run

Everything is Rust, in the `rust/` workspace (run cargo from there). No npm, no bundler.

```bash
cd rust
cargo test -p sim-core               # the gate: unit tests + determinism + integration (see below)
cargo test -p sim-core --release     # same, faster for the slow determinism/soak tests
cargo build --release                # build all crates + bins
```

**The test gate (`cargo test -p sim-core`)** — three layers, all must stay green:

- **Unit tests** (in-module, ~228) — the bulk of behaviour coverage.
- **`tests/determinism.rs`** — the load-bearing gates: `run_to_run_deterministic` (same seed → same
  hash), `m_invariant_across_core_counts` (**THE gate** — golden hash bit-identical across rayon
  thread counts M=1/2/4/8), `grid_superset_no_dropped_neighbours` (the 3×3 cell query never silently
  drops an in-range neighbour), `gold_conserved` (closed money loop).
- **`tests/town_survival.rs`** — the world doesn't collapse: a single town keeps ≥50% over 2500
  ticks (subsistence economy), and a region of towns each keeps ≥33% of its founders.

**Perf + determinism bench (not a unit test):**

```bash
cargo run --release --bin soak_bench            # N=2000, frames=200 (defaults)
cargo run --release --bin soak_bench 5000 100   # N=5000, frames=100
```

`soak_bench` runs the same seeded sim in rayon pools of 1/2/4/8/… threads, prints the `perceive`
wall + per-tick cost + speedup, and **asserts the golden hash is identical across every thread
count** (exit 1 on divergence). This is the M=1≡M=N canary — run it after any change that touches the
parallel phases or the hash surface.

**Diagnostic binaries** (`rust/sim-core/src/bin/`): `liveness` (region liveliness probe),
`food`/`roles` (economy/occupation probes), `tickprofile` (per-phase tick breakdown — backed by
`World::step_profiled`), `beliefbench` (belief-layout perf probe). The `server` crate runs the sim
headless or over TCP: `cargo run --release --bin server [seed] [frames] [addr]`.

## Architecture

> **Authoritative reference: [`docs/architecture/`](docs/architecture/00-overview.md).** Start at
> `00-overview`, then `02-epistemic-split` (the core invariant), `22-rust-ecs-backend-lld` (the
> backend design + determinism mandate), and `24-rust-port-progress` (the living gap burn-down —
> what's built vs deferred). Per-cluster docs `01`–`21` describe each subsystem (sim spine, RPG/
> abilities, drama/society, economy/news, reasoning layer, action grammar, caution, narrative
> tooling/signals, survival economy, party coordination, …). Keep these updated when you change
> architecture, not just tuning. Note: docs predating the Rust move describe the same designs in TS
> terms — the *design* still holds; the *file paths* are now Rust.

### The workspace (three crates)

- **`sim-core`** — the ECS world + all systems (the simulation). Depends only on `rayon`.
- **`protocol`** — a dependency-free little-endian wire format (backend→frontend snapshot). Carries
  only render-visible state (positions, factions, goal, health, level), **never beliefs/cognition**
  — the epistemic-split boundary made physical.
- **`server`** — authoritative backend: owns the `sim-core` world, advances it, projects to a
  `protocol::WorldSnapshot` over raw length-prefixed TCP (std::net only).

### The ECS world

`World` (`world.rs`) is **Structure-of-Arrays**: every per-agent attribute is a dense `Vec<T>`
indexed by a stable entity id, where `T` is `Copy`/inline (scalar or small struct) — no heap, no
`String`/`Map` per agent, so columns stream cache-friendly. Cold/variable data (names, sagas,
biography) lives in separate storage keyed by id. Beliefs are **double-buffered**
(`beliefs` written this tick, `beliefs_prev` frozen for gossip to cross-read).

### The tick (the spine)

`World::tick()` runs these phases **in this order** (see also `step_timing`/`step_profiled`):

```
needs → reason → decide → locomotion → refresh_cues → build_surface → perceive → snapshot_beliefs
  → gossip → combat → abilities → newsread → market → act → drain_intents → release_freed_captives
  → sagas.sweep → progression → society_phase
```

- **Parallel, own-write** (rayon `par_iter_mut`, each agent writes only its own row): needs, reason,
  decide, locomotion, perceive, gossip, combat, abilities, newsread, market, act, progression.
- **Serial** (one pass, mutates the world / merges cross-agent effects): build_surface,
  snapshot_beliefs, drain_intents, release_freed_captives, sagas.sweep, **society_phase** (director,
  faith, lineage, watch, intrigue, defenses, expeditions, refugees, houses, tropes, …).
- **`build_surface`** rebuilds the ~32-byte `Perceivable` row per agent and counting-sorts it into
  the spatial `Grid` (cell-major, deterministic). `perceive` then reads neighbours via a 3×3 cell
  query over that frozen surface — this is the scaling lever (7.2–7.4× on 8 cores).

### The epistemic split (why deception works)

The core invariant — keep it intact:

- **Decisions read beliefs only** — perceive, gossip, reason, decide, the planner, derivers, act.
- **Execution reads ground truth** — combat resolution, locomotion, hostility checks, production.

So an agent can be genuinely fooled (disguise, planted rumour, a scarecrow believed a person) while
reality still resolves correctly. Combat outcomes fold back into beliefs (victim + witnesses learn
the aggressor). The split is a **cognition** boundary, not an observer one: the chronicle/gazette/
director read the whole roster's truth to *narrate* history — fine, because that doesn't drive an
agent's decision. Test: "does this read drive an agent's behaviour?" → if yes, belief-scope it.

### Cross-agent effects = the intent merge

Parallel phases never write another agent's row. A cross-agent effect (a strike, a trade, a gift, a
minted debt) is **emitted as an Intent** during the parallel phase and resolved in the serial
`drain_intents` pass in deterministic order. This is why effects land a tick behind — by design, and
it is what keeps M=1≡M=N.

### Beliefs: struct today, fact-store next

Beliefs are **two layers** (see [`25-belief-fact-store-lld`](docs/architecture/25-belief-fact-store-lld.md)):

- **`PersonBelief` / `BeliefTable`** (`components.rs`, `World.beliefs`) — the hot **closed core**
  (faction, hostile, pos, threat, standing, …): a cap-25 per-agent table, `find(subject)` → field
  access. The fast read surface the cognition phases hit.
- **`FactStore`** (`components.rs`, `World.facts`) — the **open proposition layer**: interned int
  facts `{subject, attr, value, conf, provenance, observed_at}` where `attr` implies the value-kind.
  Holds what the struct can't — e.g. `FA_OWES_ME`, a quantitative debt minted when an agent is robbed
  (`Intent::Owe` → the merge), read by the `collect_debt` deriver to seed a vendetta. Sorted `Vec`
  (deterministic, **no HashMap in the hash surface**), lazy decay, folded into `world_hash`.

Adding a new kind of belief = a new `FA_*` attribute + a writer (event/inference) + a reader
(deriver/predicate); no struct surgery. The perf cost is accepted deliberately (richness per agent >
agent count; belief reads are only ~7% of the tick). Retiring the struct into facts is a possible
future cleanup but is cost-only and out of scope.

## Conventions & gotchas

- **Determinism is the prime directive.** Anything you add to a parallel phase must write only its
  own row (or emit an Intent), draw randomness from the per-entity `DeterministicRng` (`rng.rs`,
  splitmix64 seeded off a stable id), and **never** introduce a `HashMap` into the read/hash surface
  (iteration order would diverge across threads). After touching parallel phases or `hash.rs`, run
  `cargo run --release --bin soak_bench` and confirm M-invariance + the determinism tests.
- **The golden hash (`hash.rs`)** folds every mutable column in stable id order — it's the canary.
  If you add a column that carries simulated state, fold it in; if you change what a column means,
  the hash *value* changes (re-baseline) but M-invariance must still hold.
- **Closed money loop — no minting.** Gold is fixed-point `i64`, only ever transferred (trade, loot,
  reward, tithe, bounty, caravan). `total_gold()` (purses + stashes + every fund) is invariant;
  `gold_conserved` enforces it. Preserve conservation when touching trade/loot/rewards.
- **Tuning lives in config/constants, not logic.** Sim/economy/RPG curves are constants (per-module
  consts and config blocks) — prefer changing those over hardcoding behaviour.
- **The "freeze lesson."** Monsters and the player have no profession/economy. Any code on the
  agent/combat path must guard profession/inventory assumptions, or one unguarded access on a
  professionless agent panics inside the tick. Always `import`/`use` what you reference.
- **Percepts share the grid.** Non-agent perceivables (buildings, a scarecrow) live past `world.n`
  on the shared surface; every `for_near` consumer that indexes agent columns must guard `j >= n`.
- **Components stay `Copy`/inline.** Don't add heap (`Vec`/`String`/`Map`) to a hot per-agent column
  without a determinism + perf reason. The fact-store `Vec` (doc 25) is the one sanctioned exception.

## Background

This ports the Theory-of-Mind design (belief-primitive / engine spec) into a parallel Rust ECS; the
full backend rationale and the Wave-0 determinism proof are in
[`docs/architecture/22`](docs/architecture/22-rust-ecs-backend-lld.md), and the gap burn-down toward
TS-feature parity is [`docs/architecture/24`](docs/architecture/24-rust-port-progress.md).
