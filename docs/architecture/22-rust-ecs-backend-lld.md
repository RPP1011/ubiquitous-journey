# 22 (PLAN) — Rust ECS backend port: a parallel sim core behind a clean web split

> **Status: PROPOSAL / migration plan (no code yet).** Ports the simulation from single-threaded
> TypeScript into a **Rust simulation core** built on a **purpose-built ECS**, parallelised with
> **`rayon`**, running headless inside a **web server** that streams render state to a **thin
> JavaScript/Three.js frontend**. This is the structural answer to two findings already documented:
> [21 — soak performance](21-soak-performance-lld.md) (the single-threaded sim floors at ~180–195s
> because `perceive`/`reason`/`decide` are CPU-bound and only marginally optimisable under strict
> behaviour-preservation) and [20 — render-only frontend](20-render-only-frontend-lld.md) (the
> Three.js layer should be a pure *view*, not load-bearing). A Rust+ECS+rayon core makes the
> per-agent cognition genuinely data-parallel across cores, and a server boundary makes the
> frontend a renderer by construction. Read [01 — sim spine](01-sim-spine.md), [02 — the epistemic
> split](02-epistemic-split.md), and [21] first — this plan leans on all three.

> **✅ Wave 0 spike — VALIDATED (2026-06-14).** The keystone (`rust/sim-core/`) is built and the core
> thesis is proven: a `rayon`-parallel `perceive` over the SoA roster + spatially-sorted `Perceivable`
> surface + counting-sort grid + per-entity RNG. The golden hash is **bit-identical across 1/2/4/8
> threads (M-invariance gate green)**, and `perceive` scales **7.2–7.4× on 8 cores** (N=2k and N=8k);
> `cargo test` green (M=1≡M=8 determinism + grid superset correctness). The deferred per-system wave
> (the `/batch`) can now proceed on this foundation. Build: `cd rust && cargo test && cargo run
> --release --bin soak_bench`.

> **One-line summary:** entities are rows in flat (SoA) component columns held in **two buffers**;
> every system **reads the frozen `prev` buffer and writes `next`**, so all reads are race-free and
> the per-agent passes (`perceive`/`gossip`/`reason`/`decide`/locomotion) run fully parallel via
> `rayon::par_iter_mut`. Cross-agent effects become **intents drained in a deterministic merge —
> landing a tick behind, by design**. A typed **view layer** (not the borrow checker alone) makes the
> epistemic split a compile error. The Rust sim is deterministic **on its own terms** (no TS parity).
> The server streams a render snapshot to a dumb Three.js client.

---

## 1. Why port (and why now)

- **The parallelism ceiling.** [21] measured the deterministic soak at ~195–209s, dominated by
  `perceive` (37–42%, ~126 real beliefs/agent/tick), `reason` (27%), `decide` (14%) — all per-agent
  compute. JS is single-threaded; worker threads can't share the rich object heap, so in-JS
  parallelism would mean either serialising agents every tick (costs more than it saves) or a
  data-oriented rewrite anyway. **If we're rewriting the data model for parallelism, Rust + a real
  ECS is the honest target** — `rayon` turns "iterate agents" into "iterate agents across N cores".
- **A clean backend/frontend split for free.** Today truth lives partly on Three.js objects
  (`agent.pos === fighter.root.position`; see [20]). A server boundary forces the sim to own
  authoritative state in plain data and the client to *render a copy* — the split becomes physical,
  not a discipline we hand-maintain.
- **A fresh start, not a transliteration** ([21] fixed determinism in TS, but we **don't port
  *against* the TS sim** — §9): the Rust core preserves the *design*, is tuned on its own terms, and
  never has to match TS numerics (which would diverge with every commit anyway).
- **Headroom for scale.** The current world is one dense ~300-agent town. A parallel core makes
  thousands of agents / many towns tractable — the design has always wanted this (`TOWNS`,
  `ARENA_RADIUS` expansion).

**Honest cost up front:** not the "mature enterprise rewrite" an earlier draft implied. The whole TS
sim is **~39.5k LOC built in ~12 days / 229 commits** at AI-assisted velocity, and much of it ports
cheaply (config data, data-driven IR). A Rust core at this cadence is **weeks, not quarters**; the
real risk is the *novel* engineering (deterministic-parallel ECS + views, the intent merge, netcode-
if-remote), which a small up-front spike retires. §8 phases it so the perf thesis lands at P2.

---

## 2. Target architecture

```
                ┌──────────────────────────── Rust workspace ───────────────────────────┐
                │                                                                        │
  player input  │   ┌─────────────┐   systems (rayon)    ┌──────────────────────────┐   │
  ───────────►  │   │  net / ws   │  ───────────────►    │  sim-core  (custom ECS)  │   │
  (commands)    │   │  server     │   snapshot (binary)  │  components + systems     │   │
                │   │ (axum/tokio)│  ◄───────────────    │  rayon parallel schedule │   │
  ◄───────────  │   └─────────────┘                      │  deterministic PRNG      │   │
  render state  │         ▲                              └──────────────────────────┘   │
  (snapshots)   │         │ serialize render view                                       │
                └─────────┼──────────────────────────────────────────────────────────--┘
                          │ WebSocket (binary frames)
                ┌─────────▼───────────────────────────────────────┐
                │  thin web frontend  (JS / TypeScript)            │
                │  Three.js renderer + input — NO simulation logic │
                │  (the doc-20 "view" realised as a network client)│
                └─────────────────────────────────────────────────┘
```

- **`sim-core`** (Rust lib, no_std-friendly where possible): the ECS, components, systems, the
  fixed-tick scheduler, the seeded PRNG. **Headless and renderer-agnostic by construction** — it has
  no concept of a scene. This is where `rayon` lives.
- **`server`** (Rust bin): `axum`/`tokio` HTTP+WebSocket. Owns the real-time loop (fixed-tick
  cognition + per-frame interpolation cadence), runs `sim-core`, serialises a **render snapshot**
  (entity transforms, labels, fired events, HUD-relevant scalars) to connected clients, and applies
  **input commands** from them.
- **frontend** (existing `vendor/three` stack, slimmed): connects over WebSocket, receives
  snapshots, drives a pooled scene graph (interpolating between snapshots), translates input to
  commands. It is exactly the [20] *view* — but the truth is now across a socket instead of across a
  function call, so there is *no way* for it to be load-bearing.
- **Two deployment shapes from one core** (decide in §10): (a) **native server** — `rayon` over all
  cores, multiplayer-capable, the headless test target; (b) **`wasm32` build** of `sim-core` run
  in-browser for a serverless single-player mode (no `rayon` there — wasm threads are constrained;
  the same systems run serially). The core stays identical; only the host differs.

---

## 3. The custom ECS

**Why roll our own (with eyes open).** Mature crates exist — `bevy_ecs`, `hecs`, `legion`,
`flecs`-rs. They are excellent and would save months. We choose a **purpose-built ECS** only because
this sim has three unusual requirements that fight a general scheduler, and we want total control of
them: **(1) bit-stable determinism under parallelism** (general schedulers may reorder/auto-thread
in engine-defined order), **(2) the epistemic split as an enforced access rule** (cognition systems
must be *unable* to take a mutable borrow of the roster), and **(3) a fixed, dense entity population**
(hundreds–thousands of long-lived agents, not millions of churning entities), which lets us use the
simplest possible storage. *If the schedule-control story turns out cheap on `bevy_ecs`, prefer it —
re-evaluate at the end of Phase 0.*

**Storage — Struct-of-Arrays, dense columns.** Entities are a generational `EntityId { idx, gen }`.
Each component type is a column `Vec<C>` indexed by `idx`, with a roster-wide `alive: BitSet`.
Because the population is dense and long-lived, we avoid archetype churn entirely: every column is
sized to the entity capacity; a "monster has no profession" is a `None`/sentinel, not a missing
archetype. This gives cache-friendly linear scans (the hot pattern) and trivial `rayon` chunking.

```
struct World {
    alive: BitSet,
    free:  Vec<u32>,                  // recycled slots (deterministic LIFO)
    // WARM — persistent SoA columns, STABLE-SLOT order, streamed by par_iter_mut (own-write):
    pos:        Vec<[f32; 3]>,        // authoritative transform (was fighter.root.position); f32 (§3.3)
    vel:        Vec<[f32; 3]>,
    faction:    Vec<Faction>,
    beliefs:    Vec<BeliefTable>,     // inline cap-25, split subjects[]/bodies[] (§3.2), own-write
    goals:      Vec<GoalStack>,
    needs:      Vec<Needs>,
    gold:       Vec<i64>,             // FIXED-POINT minor units — exact conservation, order-free (§3.3)
    inventory:  Vec<Inventory>,
    personality:Vec<Personality>,
    rng:        Vec<DeterministicRng>,// PER-ENTITY sub-streams, seeded by spawn-generation id (§4)
    // HOT — rebuilt + spatially sorted each tick; the neighbour read-surface (§3.1):
    perceivable:Vec<Perceivable>,     // ~32B AoS, Morton/cell order; grid indexes ranges into THIS
    grid:       SpatialGrid,          // (start,len) ranges into `perceivable`; deterministic buckets
    // COLD — segregated, never inline with hot (§3.1): names/houses/biography/memory/sagas …
    cold:       ColdStore,
    map:        MentalMap,            // shared, read-only static geography
    intents:    IntentQueue,          // cross-agent effects emitted in the parallel phase, drained
}                                     //   in the deterministic merge → land in `next` a tick behind
// WARM columns are held as TWO copies — `prev` (frozen, all reads) and `next` (all writes), swapped
// each tick (§4). The HOT `perceivable` surface is a per-tick projection of `prev`, not double-buffered.
```

**Systems** take a typed **view** over the buffers, not raw `&mut World` — a `PerceptionView` /
`CognitionView` / `ExecutionView` (§5) that exposes exactly the columns that system may touch
(`prev` for reads, `next[self]` for own writes, the intent queue for cross-effects). This is what
makes the epistemic split a compile error *and* lets the scheduler prove disjointness. The fixed-tick
order mirrors today (`perceive → decay → gossip → reason → decide`, then the intent merge =
`market`/`combat`/transfers; `progression`/`quests`; locomotion per frame).

### 3.1 Cache-aware memory layout (the core of the design)

**Governing rule: layout follows access pattern, and the two hot patterns here are opposites.**
- `perceive`/`reason`/`decide` *stream* their own agents (touch one concern across many entities →
  **SoA**: a dense column, perfect sequential locality, hardware-prefetchable, no wasted bytes).
- But `perceive` *also gathers ~10 fields of each of ~126 neighbours* per agent (many fields of one
  entity → **AoS**: pure SoA would make each neighbour cost 8–10 separate column cache-misses ⇒
  ~1000+ misses/agent/tick — catastrophic).

So the layout is a **deliberate hybrid**, and the dominant lever is keeping the *neighbour read-set*
tiny and spatially contiguous so it stays in cache.

**Three temperature tiers** (the cardinal sin is letting cold bytes share a hot cache line):

| Tier | Touched | Layout | Examples |
|---|---|---|---|
| **HOT** | every tick, by self *and as a neighbour* | the **Perceivable surface** (AoS, packed, spatially sorted — below) | x, z, faction, flags, profession, level, notoriety, threat, wealth-cue |
| **WARM** | every cognition tick, **self only** | SoA columns, stable-slot order, streamed by `par_iter_mut` | belief table, goals, needs, personality, inventory, per-entity RNG |
| **COLD** | rarely (chronicle / UI / inspector / lineage) | separate arrays, often behind an index — **never** inline with hot | name, house, biography, episodic memory, saga membership, full progression history |

**The Perceivable surface — the single most important structure.** A packed, AoS, ~32-byte row per
entity holding *exactly* the fields others read about it, rebuilt each tick:

```rust
#[repr(C)]                          // ~32B → 2 rows per 64B cache line
struct Perceivable {
    x: f32, z: f32,                 // 8  f32 is ample: ~0.1 mm precision across a 1 km arena
    faction: u8,                    // 1  the PERCEIVED faction (disguise already folded in)
    flags: u8,                      // 1  alive | held | building | disguised bits
    profession: u8, level: u8,      // 2
    notoriety: u16, threat: u16,    // 4  quantized (believed scalars never need f64)
    wealth_cue: u16,                // 2  precomputed ONCE here (the per-subject inventory sum —
    _pad: [u8; 14],                 //    a byte-identical-style win we found in [21], now structural)
}
```

Two compounding wins from this one struct:
1. **One cache line per neighbour, not 8–10.** Reading a neighbour = one ~32B load.
2. **It fits in cache.** At 32 B/agent: **1k agents = 32 KB (≈ L1), 10k = 320 KB (L2/L3).** Keep this
   array small (aggressive `u8`/`u16` quantization, `f32` not `f64`) and `perceive`'s ~126 neighbour
   reads become L1/L2 hits after the first sweep. *Every byte shaved here buys cache residency at
   scale* — this is why the believed scalars are quantized, not `f64`.

**Spatial sort / tiling — the locality multiplier.** Rebuild the Perceivable array each tick in
**spatial order** (cell-bucketed, or Morton/Z-order); the spatial grid stores `(start, len)` *ranges*
into it, not scattered indices. Then a 3×3-cell neighbour query reads a **contiguous span** →
sequential, prefetched, minimal misses. Iterate agents in the *same* spatial order (tile by cell) so
consecutive agents share an overlapping neighbour span that stays hot across them. The heavy
persistent columns (beliefs etc.) stay in **stable-slot order** — we sort only the cheap 32 B
surface, never the 1 KB belief tables.

### 3.2 The belief table — packed, with a split match-array

`BeliefTable` is the load-bearing WARM component — and the **dominant per-entity memory**: the real
`BeliefState` (`types/beliefs.ts`) is ~40 fields, so even packed (`PersonBelief`, Appendix A) it is
~25 × ~56 B ≈ **1.4 KB/agent** — bigger than everything else combined. It's an inline `ArrayVec`
(no heap, no `Map`), so `par_iter_mut` is allocation-free and each agent mutates only its own slot. But
`perceive` does *"find my belief about neighbour O"* ~126×/tick — striding 25 fat structs is ~22
lines/lookup. So **split it SoA-within-the-entity**: a dense `subjects: [EntityId; 25]` match-array
(~2 lines, kept sorted for a branch-light scan / small binary search) beside the `bodies:
[PersonBelief; 25]`. The hot lookup touches only the id array; a body is read/written only on a hit.
Place-beliefs (home/tavern/shrine/…) are *few and smaller* → a separate `places: [PlaceBelief; 8]`,
not mixed into the person table. The cap-25 eviction that bit us in [21] becomes a deterministic policy
on the sorted array (and `perceive`'s neighbour order — §4 rule 4 — defines it).

### 3.3 Numeric representation — `f32` hot, **integers for conserved quantities**

- **`f32` for positions/velocities and all believed scalars** — half the footprint of `f64` ⇒ twice
  the cache density on the hot path; precision is irrelevant for a game-space sim.
- **Fixed-point integers (`i64` minor units) for gold and any *conserved* quantity.** This is both a
  cache and a *determinism* win: integer transfers are **exact** (conservation can't drift) and
  **order-independent to sum**, so the intent-merge's economy reductions are bit-stable for free —
  removing the float-summation-order worry from §4 for the whole economy.

### 3.4 `rayon` mechanics — false sharing & alignment

Per-entity parallel writes are disjoint *logically*, but at chunk boundaries two threads can write the
same 64 B line (**false sharing** → silent slowdown). Mitigations: chunk `par_iter_mut` on
**cache-line-aligned** boundaries (`with_min_len`, stride a multiple of 64 B); the 1 KB belief tables
are naturally line-isolated; small `f32` columns need explicit alignment. Hot arrays are
`#[repr(align(64))]` at the base. (This never affects *correctness* or determinism — only speed — but
it's the difference between 5× and 7× on 8 cores.)

### 3.5 Measure, don't guess

Cache behaviour is empirical. From P0 the spike must report **L1/L2/L3 miss rates and miss-stall
cycles** (`perf stat`/`cachegrind`/`vtune`) on `perceive`, and A/B the two decisions that actually
matter: (a) AoS Perceivable surface vs naïve all-SoA, (b) spatial-sorted iteration vs slot-order. The
numbers above are the *hypotheses* the spike validates; the layout is locked only once they hold.

---

## 4. Concurrency model: **double-buffered, actions a tick behind**

The whole concurrency story is one decision: **two copies of the mutable world (`prev`, `next`);
every system READS `prev` (frozen, immutable) and WRITES `next`.** Because all reads hit an immutable
buffer, *no read can ever race a write* — uniformly, for every system, with no per-system access
proofs or phase-ordering gymnastics. This is simpler than chasing minimal copies (and supersedes the
"snapshot only positions" sketch earlier drafts had): the copy is cheap at these scales (hundreds of
agents × a few dozen columns ≈ a few hundred KB/tick; own-written columns aren't copied, they're
overwritten).

**A tick:**
1. Build the spatial grid from `prev` (serial, O(n) — cheap).
2. **Parallel phase (`rayon`).** Every per-agent system runs `par_iter_mut` over its own column,
   reading `prev` (shared `&`) and writing `next[self]` (exclusive). Each entity touches only its own
   row → no write conflicts, order-independent. **This now covers essentially all cognition** —
   `perceive`, `gossip` (reads the partner's `prev` beliefs — no longer a serial special case!),
   `reason`, `decide`, `decay`, locomotion/`steer`, need-drain.
3. **Cross-agent effects are not written directly.** Anything that touches *another* entity (a strike
   on C, a transfer to C, `joinBand`, a deed, a cast that hits others) is **emitted as an intent**
   into a queue during the parallel phase.
4. **Deterministic merge (serial, cheap).** Drain the intent queue and apply effects to `next` in a
   **fixed order** (by target id, then source id), validating against the *evolving* `next` state so
   contention and conservation resolve deterministically (e.g. two buyers for the last unit: the
   first in order wins, the second's intent fails — realistic, and reproducible). Effects therefore
   land in `next`, visible to reads **next** tick.
5. Swap `prev`/`next`.

**"Actions a tick behind" is the accepted semantic** (maintainer decision): an agent decides on the
previous tick's world and its cross-agent effect resolves one tick later. At the 6 Hz cognition tick
that's ~167 ms of lag on *emergent* effects (trades, joins, gossip, deeds, witnessed consequences) —
**invisible** for economy/social/belief dynamics. The merge replaces the synchronous TS deed bus; the
deed-timing question the review raised is *answered*, not deferred: deeds are intents, resolved in the
next merge, by design.

> **The one latency-sensitive exception — player melee.** Directional melee (the game's origin) feels
> a tick of lag. Keep **player combat resolution per-frame/immediate** as a special-cased fast path
> (and/or client-predicted, §6), outside the tick-behind cognition merge. NPC-vs-NPC combat can ride
> the merge.

This collapses the old parallel/serial taxonomy: the **only** serial work is the grid build and the
intent merge — both cheap, because most agents emit zero cross-effects per tick. The expensive 78%
(perceive/reason/decide) is fully parallel.

**Determinism (the hard gate — within Rust, M=1 ≡ M=8; see §9):**
1. **Per-entity parallel systems are deterministic by construction** — each closure reads `prev` and
   writes only `next[self]`, so the result is independent of how `rayon` splits work.
2. **Intent merge is fixed-order** (target id, then source id); any float accumulation (damage, gold)
   sums in that order → bit-stable. **No `rayon` float `reduce`/`sum` ever feeds behaviour.**
3. **Per-entity RNG sub-streams.** Each entity owns a `DeterministicRng` seeded from
   `hash(world_seed, spawn_generation_id)` — *not* the recycled slot index, so id reuse can't collide
   or reset a stream. Parallel draws are independent and reproducible regardless of core count. A
   single global stream survives only for serial world-gen/director rolls. (Algorithm is free —
   `pcg`/`xoshiro`; no TS parity to preserve, §9.)
4. **Spatial-grid buckets iterate in a deterministic order** (Vec insertion or sorted — never
   `HashMap` iteration), since perceive's neighbour order is behaviourally load-bearing ([21]) and
   defines the cap-25 belief eviction.

**Expected scaling.** Two compounding wins, not one: Rust is **~3–5× faster single-threaded** than JS
for this struct/numeric work *before any threads*, and then the ~78% parallel phase divides by cores.
Ballpark from the [21] soak (~195s in JS): Rust single-thread ≈ 40–65s; with the parallel phase at
M=8 ≈ **~15–30s**. The serial tail (grid + merge) is small *and* also gets Rust's raw speedup — so
there's no JS-style Amdahl wall. Comfortably under the 2-minute goal, with headroom for far larger
worlds.

---

## 5. The epistemic split → a compile-enforced *view* layer

**Correction to an earlier draft (and a review finding):** the double-buffer/borrow model gives
*parallelism safety* (no cross-write races) — it does **not**, on its own, give the epistemic split.
The split is about what cognition may **read**: it must decide on *beliefs*, not ground truth. A
cognition closure holding `&prev` (immutable) can still read everyone's true `pos`/`faction`/`gold`
and decide on it — that compiles, and violates the split. So the split needs its own enforcement: a
**view/capability layer** of restricted borrows, distinct from the concurrency model.

Three view types over the world columns:

- **`PerceptionView`** — may read the roster's *truth* columns from `prev` (`pos`, `faction`,
  `notoriety`, `threat`, inventory, `disguise`, …) and writes only `next.beliefs[self]`. This is the
  *one* sanctioned truth→belief bridge ([02]'s "truth in, belief out"). `perceive` runs here.
- **`CognitionView`** — exposes own state + own beliefs (`prev`) + the static `MentalMap`, and **does
  not name the roster truth columns at all** (they're not fields of this view). `reason`/`decide`
  *cannot* read another entity's `gold`/`faction` because the type gives them no way to — the split
  becomes a compile error, the way `CognitionCtx` is a compile error in TS today, but stronger.
- **`ExecutionView`** — the intent-merge phase; full read of `prev` + write of `next`, ground-truth
  resolution (`combat`, `market`, transfers, `isHostile`). Exactly the TS execution side.

So the split and the parallelism are **related but separate** guarantees: the double-buffer makes
reads race-free; the view layer makes "cognition reads beliefs, not truth" a type error. Both are
deliberate design, not freebies from `&`/`&mut` — and together they make [02] *stronger* than the
`epistemic.mjs` source scan it replaces.

---

## 6. Backend ↔ frontend protocol

- **Transport:** WebSocket, binary frames. Snapshot rate decoupled from cognition: server interpolates
  movement per frame and pushes render snapshots at ~20–30 Hz; client interpolates between them.
- **Server → client (render snapshot):** a compact, *render-only* projection — per visible entity:
  `{id, x, y, z, yaw, anim_state, label_sig, faction_tint, hp_frac}`; plus fired **events** for VFX
  (a strike, a trade, a death), and HUD scalars (gazette ticks, econ readouts). Crucially this is the
  *believed/visible* surface, not the full mind — the inspector ("look to read a mind", `F`) becomes
  a **request/response** (client asks for entity X's belief view; server answers) so we don't stream
  every agent's full N² beliefs.
- **Client → server (commands):** `Move{dir}`, `Strike`, `Ability{slot}`, `Interact{targetId}`,
  `Recruit{targetId}`, `EnterDungeon`, `OpenGazette` — the input vocabulary [20] already sketches.
  The player becomes *just another entity* the server simulates; the client sends intents, never
  mutates state.
- **Determinism/authority:** the server is authoritative; the client is a renderer + input source.
  This is what makes multiplayer and server-side perf possible, and what makes "frontend is
  load-bearing" structurally impossible.
- **Delta encoding** (later optimisation): snapshots diff against the last acked snapshot per client.

---

## 7. Port inventory — current TS subsystems → Rust

The surface is large. Grouped by cluster, with the parallel/serial classification and porting risk.
(Source map: [00-overview](00-overview.md).)

| Cluster | TS modules | Rust home | Phase | Parallel? |
|---|---|---|---|---|
| Sim spine | `simulation.ts`, the tick loop | `sim-core::schedule` | 1 | scheduler |
| Movement/steer | `agent/movement`, `agent/steer` (`STEER_FILLS`) | `systems::locomotion` | 1 | parallel (own-write) |
| Perception | `agent/perception`, `beliefs`, `mentalmap`, `percept` | `systems::perceive` + `BeliefTable` | 2 | **parallel** (own-write) |
| Gossip | `agent/perception::gossipBeliefs` | `systems::gossip` | 2 | **parallel** (reads `prev` beliefs; vouch/snub → intents) |
| Reasoning | `schemas/{ir,vocab,interpreter,catalogue}` | `systems::reason` (data-driven IR) | 3 | parallel |
| GOAP / motivation | `motivation`, `planner`, `exec/registry`, `features/*` | `systems::decide` + `planner` | 3 | parallel (own-write) |
| Action grammar features | `urchin, affect, learning, recipeKnow, recruiter, ledger, caution` | `features::*` (data rows) | 3 | mixed |
| RPG spine | `rpg/events` bus, `progression`, `classes` | `DeedQueue` + `systems::progression` | 2 | bus serial; progression parallel |
| Abilities | `abilities/{ir,catalog,interpreter,effects}` | `abilities::*` (interpreted IR) | 3 | cast = serial-merge |
| Combat | `combat.ts`, `fighter.ts` (state machine) | `systems::combat` + `CombatBody` | 2 | serial-merge |
| Economy | `market` (auction), `econstats`, `arbitrage`, `bounties`, `reputation` | `systems::market` + telemetry | 4 | market serial-merge |
| Drama/society | `director, seeding, lineage, houses, intrigue, patrician, watch, defenses/walls, faith, expeditions, groups` | `society::*` | 5 | mostly observer/throttled-serial |
| News | `reporter, gazette, ai/press, ai/llm, bounties` | `news::*` (LLM via server-side async) | 5 | observer |
| Coordination | `coordination.ts`, `decideParty`, `bandCombatState` | `systems::coordinate` | 4 | parallel-read snapshot |
| World/dungeon | `world` (POIs), `arena` (terrain/biomes), `world/dungeon*` | `worldgen::*` | 1 | gen serial |
| Quests | `quest/quest` | `systems::quests` | 4 | serial |
| UI / inspector / HUD | `ui/*`, `dialogue/*`, `player`, `boot`, `playerControls` | **stays JS frontend** + server query API | 6 | client |

Two things deliberately *don't* port into the core: the **renderer/UI** (stays JS frontend, §6) and
the **LLM/press enrichment** (runs server-side async off the tick — it never gated the sim).

---

## 8. Phased migration (TS keeps running until cutover)

Each phase is independently demoable; the TS sim stays the *playable* build until Phase 7 — **not as
a parity oracle** (we don't match it, §9), just so there's always something runnable.

- **P0 — Scaffold.** Cargo workspace (`sim-core`, `server`, `protocol`). Custom ECS skeleton + the
  determinism harness (seeded PRNG, golden-state hashing). Decide roll-your-own vs `bevy_ecs` here on
  evidence (build the scheduler spike; keep if it gives clean deterministic control).
- **P1 — Headless spine.** Worldgen (arena/biomes/POIs/towns), entity spawn, movement + steer-fill
  locomotion, the fixed-tick scheduler. Milestone: N agents wander a town headless, deterministic,
  `rayon` parallel locomotion. No beliefs yet.
- **P2 — Epistemic core.** `perceive` (parallel) + `BeliefTable` + spatial grid, `gossip` (now
  parallel — reads `prev` beliefs, §4), the intent-queue + merge, progression, combat + the conserved
  economy primitives (transfer, market clear). Milestone: the §9 invariants hold (gold conserved,
  beliefs form, trades), and **parallel `perceive` beats single-threaded TS at equal N** — the perf
  thesis, demonstrated.
- **P3 — Cognition.** The reasoning IR (`reason`), GOAP (`decide`/`planner`), the action-grammar
  features, abilities. Milestone: emergent classes + a believable behavioural repertoire emerge.
- **P4 — Society & economy depth.** Director, lineage, factions, watch, coordination, quests,
  arbitrage/bounties. Milestone: a full-fidelity town that *feels* alive (judged on its own terms, §9).
- **P5 — Server + protocol.** `axum`/WS, render-snapshot serialisation, command intake, the
  inspector query API. **Decide here: localhost/in-process server vs remote** (the netcode fork, §10).
- **P6 — Frontend client.** Slim the Three.js layer to a snapshot renderer + input→command (this *is*
  doc [20]'s view, network-backed). Player becomes a server entity.
- **P7 — Cutover.** Flip the playable build to the Rust backend; retire the TS sim (it is *not* kept
  as an oracle — there's nothing to match it against, §9).

Optional **P8 — `wasm32` single-player** (§2): build `sim-core` to wasm for a serverless browser mode.

---

## 9. Determinism — within Rust only (no TS parity)

**Decision (maintainer): we do NOT target behavioural parity with the TS sim.** Cross-language
bit-parity is impossible (libm transcendentals, RNG model, `rayon` order) *and* pointless — the TS
sim is being replaced, so the two would only diverge further with every commit. Chasing parity is
negative work. The Rust sim is a **fresh implementation that preserves the DESIGN** (the epistemic
split, the subsystem set, the emergent thesis) and is **tuned on its own terms**.

- **Within-Rust determinism — the one HARD gate.** Golden-hash the full world state each tick; assert
  identical **across runs and across core counts (M=1 ≡ M=8)**. The double-buffer + per-entity RNG +
  fixed-order intent merge make this achievable; it is the Rust analogue of [21]'s seed fix and must
  be green from P1. (M-invariance is the canary: it breaks the instant a `rayon` float reduce, a
  `HashMap` iteration, or a slot-indexed RNG seed sneaks into a behaviour path.)
- **"Is it a good sim" — a judgment gate, not an automated match.** Re-implement the *spirit* of the
  TS suite's invariants as Rust tests — gold conservation, trade volume in a sane band, belief
  formation, emergent-class diversity, behavioural-repertoire breadth, population stability, Director
  cadence — as a **spec for "a believable town,"** not a numeric comparison to TS. Tune to taste.
- **Perf gate.** Report the Rust soak-equivalent wall-clock at M=1/2/4/8 (raw Rust speedup × parallel
  scaling), and the serial fraction (grid + merge). Target: comfortably under the 2-minute goal (§4
  ballpark ~15–30s).

---

## 10. Risks, open questions, alternatives

- **[SCOPE — recalibrated]** Not "months-long enterprise rewrite." Ground truth: the *entire* TS sim
  is **~39.5k LOC built in ~12 days / 229 commits** at AI-assisted velocity — and much of it ports
  cheaply (`simconfig.ts` ≈ 2.9k lines of *tuning data* → a config struct; abilities/schemas/action-
  grammar are already **data-driven IR** that transcribes almost directly). A Rust core at this
  cadence is **weeks, not quarters**. What does *not* shrink with velocity is the genuinely novel
  engineering — the deterministic-parallel ECS + view layer (§4/§5), the intent-merge, and the
  netcode-if-remote (below) — but those are *design* risks, bounded, and the right target of an
  up-front spike, not LOC.
- **[NEEDS DECISION] Deployment: localhost/in-process server vs remote.** This is the real fork, and
  it gates the netcode cost. **Localhost/in-process** (the server is a subprocess of the client, or
  the same binary): gets the clean split + `rayon` perf + render-only frontend with **zero netcode** —
  the recommended first target. **Remote/multiplayer**: needs **client-side prediction + reconciliation
  for the player's own fighter**, because directional melee (the game's origin) feels even a frame of
  RTT — a whole subsystem. Recommend: ship localhost first; treat remote as a later, opt-in layer.
- **[NEEDS DECISION] Roll-your-own ECS vs `bevy_ecs`/`hecs`.** Spike both in P0. **Honest correction:**
  "for determinism" is a *weak* reason — `bevy_ecs` can be made deterministic with explicit ordering,
  and its `par_iter` is `rayon` underneath (same rules). The real reasons to roll your own are (a) the
  **epistemic view layer** (§5 — you need custom access types regardless) and (b) dense-fixed-
  population simplicity. Keep only if those win clearly; a custom ECS is a real artifact with its own
  bugs.
- **[NEEDS DECISION] Server-only vs also `wasm32`.** Build the core host-agnostic so the serverless
  single-player wasm mode (P8) is nearly free; `rayon` runs only on native.
- **The deed bus is *resolved*, not open (§4).** Synchronous broadcast → intent queue drained in the
  next merge: the witness-gated per-perceiver discipline ([emergent-consequences]) is preserved; the
  timing is **one tick behind, by design and accepted**. (Earlier draft listed this as a risk to
  verify — the double-buffer decision settles it.)
- **`rayon` determinism caveats** are the canary, not a vibe — enumerated as hard rules in §4
  (no float reduce in behaviour, deterministic grid-bucket order, generation-id RNG seeds).
- **LLM/press** moves server-side async; ensure it never blocks the tick (it doesn't today).
- **No TS oracle after cutover (§9)** — the "is it good" gate is judgment + re-implemented invariant
  tests, not a numeric match. This is a deliberate accepted trade, not an oversight.

---

## 11. What this unlocks (the payoff)

- **Real multi-core cognition** — the [21] wall (perceive/reason/decide single-threaded) falls; the
  soak's dominant cost parallelises; thousands of agents / many towns become feasible.
- **A frontend that cannot be load-bearing** — [20]'s split made physical by a socket.
- **The epistemic split as a compile error** — via the §5 view layer (cognition can't *name* truth
  columns), not the borrow checker alone — [02] strengthened from a source-scan to a type.
- **Multiplayer & server-side worlds** — a shared authoritative sim, clients as renderers.
- **A deterministic, parallel, data-oriented core** — the "fast, parallelizable concurrent data
  structures" the original performance goal asked for, done at the architecture level instead of
  fought against inside a single JS thread.

---

## Appendix A — the full component catalog (Rust)

The TS `Agent` (`types/agent.ts`) is a ~120-field god-object; the freeze-lesson note there confirms
the split: a handful of fields are on *every* agent (→ **dense** components, contiguous columns), the
long tail are *role/state* only a few agents ever have (→ **sparse** components — a `SparseSet<T>` /
`Vec<Option<T>>` iterated only by their own system, never bloating the hot columns). Strings never
live on the hot path: `faction`/`profession`/`goal.kind` are **enums** (`u8`); `name`/`house`/
`group_name`/`epithet` are **interned** (`u32` into a cold string table). All believed scalars and
positions are **quantized** per §3.3. *Every field below is pinned against the actual
`types/{agent,beliefs,goals,rpg,memory,events,economy,news,motivation,combat,percept,abilities}.ts`
(read 2026-06-14).* Two findings shaped it: **(a)** `BeliefState` is ~40 fields and a *union* of
person- and place-belief concerns → split into `PersonBelief` (the hot N² cell) + `PlaceBelief` (few,
small); it is the **dominant per-entity memory** (~25 × ~56 B ≈ 1.4 KB/agent). **(b)** the `Tag`
vocabulary and `Commodity` set are *closed* (30 tags, 6 commodities) → fixed arrays, not maps.

```rust
// ───────────────────────── identity & interning ─────────────────────────
// TS EntityId = number | string ('B:3' for buildings). Unify: one u32 space, high bit tags buildings.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct EntityId { idx: u32, gen: u32 }          // generational; RNG seeds off a monotonic spawn id
type StrId = u32;                                // index into World.cold.strings (interned)

// ───────────────────────── interned enums (no strings hot) ───────────────
#[repr(u8)] enum Faction { Townsfolk, Monster, Raider, Watch, Bandit, Beast, Player /*…*/ }
#[repr(u8)] enum Profession { None, Blacksmith, Farmer, Miner, Woodcutter, Hunter, Trader,
                              Mason, Healer, Scholar /*…*/ }
// types/economy.ts: Commodity is CLOSED — exactly these six. Index into the fixed [N_COMMODITIES] arrays.
#[repr(u8)] enum Commodity { Food, Wood, Ore, Tool, Herb, Potion }
const N_COMMODITIES: usize = 6;
const N_TRAITS:      usize = /* cfg.personality, fixed */ 8;
// types/events.ts: Tag is the CLOSED 30-entry behaviour vocabulary (the behavior_profile keys).
#[repr(u8)] enum Tag { Melee, Defense, Kill, Risk, Berserk, Duel,                 // combat (6)
                       Smithing, Crafting, Toolmaking, Build,                     // craft (4)
                       Farming, Mining, Woodcut, Forage,                          // gather (4)
                       Trade, Profit, Haggle, Barter,                             // trade (4)
                       Persuade, Gossip, Deceive, Lead, Charm,                    // social (5)
                       Endurance, Explore, Heal, Wander, Hunger, Flee, Stealth }  // survival (7)
const N_TAGS: usize = 30;
// types/goals.ts GoalKind (≈35) — but in Rust the variant DATA lives on the enum (see `Goal` below).
#[repr(u8)] enum GoalKind { Idle, Work, Wander, Eat, Rest, Socialize, Market, Comfort, Build, Sightsee,
    Flee, Fight, Follow, Plan, Spy, Bounty, Arbitrage, Expedition, Caravan, Reporter, Avenge, Grieve,
    Repay, SeekFortune, Delve, Defeat, Avoid, Hide, Shadow, Goto, Approach, Beg, Granary, Protect }
// types/memory.ts EpisodeKind, types/abilities.ts EffectOp, types/percept.ts PerceptKind,
// types/combat.ts FighterState/FighterDir — all closed enums, interned the same way:
#[repr(u8)] enum EpisodeKind { Triumph, Bloodshed, Assaulted, WitnessedDeath, WitnessedAggression,
    Survived, Windfall, Milestone, Bond, Succoured, Relic, Closure, Ruined, Thwarted, Slandered }
#[repr(u8)] enum EffectOp { Damage, Heal, Stun, Slow, Knockback, Dash, Shield, Expose,
                            PlantBelief, Scry, TradeEdge, CraftBoost }
#[repr(u8)] enum PerceptKind { Person, Scarecrow, Building }
#[repr(u8)] enum FighterState { Idle, Ready, Attack, Recover, Block, Stagger, Dead }
#[repr(u8)] enum FighterDir { Up, Down, Left, Right }

// ═════════════════════ DENSE components (one column per, every agent) ═════════════════════

// ── HOT (also projected into the per-tick `Perceivable` surface, §3.1) ──
struct Body { x: f32, z: f32, y: f32, yaw: f32, speed: f32, flags: u8 /* alive|controlled|held */ }

// the directional-melee swing state machine (types/combat.ts Fighter — every agent has one; the
// per-frame combat body, resolved immediate for the player §4). The TS `fighter.root.position` IS
// `Body` above (truth moved off the THREE node, doc 20); this is the rest of the fighter's state.
struct CombatBody { state: FighterState, dir: FighterDir, block_dir: FighterDir, has_hit: bool,
                    health: f32, target_yaw: f32, dur: f32, recover: f32, stagger: f32,
                    pending_spec: Option<u16> /*AbilitySpecId routed onto the next swing*/ }

// ── WARM (own-streamed each cognition tick; double-buffered prev/next, §4) ──
struct Needs { hunger: f32, energy: f32, social: f32, comfort: f32, novelty: f32 }
struct Mood  { fear: f32, anger: f32, joy: f32, pride: f32, loneliness: f32, grief: f32 }
struct Life  { kills: u32, monster_kills: u32, dist: f32, social: f32 }
struct Personality([f32; N_TRAITS]);            // fixed trait vector (was Record<string,number>)
struct Roles { profession: Profession, faction: Faction,
               townsperson: bool, combatant: bool, can_work: bool, threat: u16 }

struct BeliefTable {                             // §3.2 — inline, split for the hot match scan
    subjects: ArrayVec<EntityId, 25>,            // dense id match-array (~2 cache lines), sorted
    bodies:   ArrayVec<PersonBelief, 25>,        // parallel payloads (read/written only on a hit)
    places:   ArrayVec<PlaceBelief, 8>,          // place-beliefs are FEW + small — kept separate (below)
}
struct GoalStack { active: Option<Goal>, stack: ArrayVec<Goal, 4>, ambition: Option<Ambition> }

struct Economy {
    gold:  i64,                                  // FIXED-POINT minor units — exact conservation (§3.3)
    stash: i64,
    inventory:    [u16; N_COMMODITIES],          // quantities (was Record<string,number>)
    mastery:      [u8;  N_COMMODITIES],          // 0..255 skill per good (was Record, empty for monsters)
    price_belief: [u16; N_COMMODITIES],          // quantized believed prices
    recipes:      u32,                           // bitset of known craftable goods (was Set<string>)
    tool_wear: f32, trade_kind: Option<Commodity>,
}

struct Progression {                             // types/rpg.ts Progression
    behavior_profile: [f32; N_TAGS],             // weighted tag tallies (was Record; CLOSED Tag keys)
    classes: ArrayVec<ClassInstance, 4>,         // held emergent classes (ClassInstance below)
    total_level: u16, narrative_xp: f32, narrative_beats: u32,
    abilities: ArrayVec<u16 /*AbilitySpecId*/, 8>,   // interned ids into the shared ABILITY_CATALOG
    cooldowns: ArrayVec<(u16, u32 /*ready-at tick*/), 8>,
}
struct ClassInstance { key: u8 /*ClassId*/, name: StrId, level: u16, xp: u32 }

struct Rng(u64);                                 // per-entity sub-stream (pcg/xoshiro), §4

// LOD / scheduling / timers (own-state, written by scheduler + act)
struct Clocks { rpg_now: u32, sim_now: u32, attack_cd: f32, cast_cd: f32, release: f32,
                produce_accum: f32, build_accum: f32, smith: f32, lod_tick: u32 }

// ── COLD (rare reads: chronicle / UI / inspector / lineage) — segregated arrays ──
struct Identity { name: StrId, house: StrId, epithet: StrId, quirk: u8 }
// types/memory.ts Memory — three consolidating rings of Episode (STM→MTM→LTM). Bounded, cold;
// read by grief/gratitude/revenge derivation + biography. Kept in its own arena behind an index.
struct Memory { stm: Ring<Episode>, mtm: Ring<Episode>, ltm: Ring<Episode> }   // Ring = fixed circular buf
struct Episode { t: u32, kind: EpisodeKind, with_id: Option<EntityId>, by_id: Option<EntityId>,
                 place: StrId, valence: i8 /*−1..1 q*/, salience: u8 /*0..1 q*/, label: StrId }
// Trace (reasoning ring, debug) is cold too — a small ring of {stage, reason, t, a, subjectId}.

// ═════════════════════ SPARSE components (role/state — few agents) ═════════════════════
// Stored in SparseSet<T> keyed by EntityId; a system iterates only the set, not the roster.
struct Spy        { phase: u8 /*scout|exfil*/, anchor: Option<[f32;2]>, scout: Option<[f32;2]> }
struct Duel       { with: EntityId, start: u32, restore_combatant: bool, restore_can_work: bool }
struct Captive    { held: bool, captor: Option<EntityId>, freed_by: Option<EntityId> }
struct Migration  { town: u16, x: f32, z: f32, until: u32 }
struct Arbitrage  { dest: [f32; 2] }
struct Expedition { target: [f32; 2] }
struct Caravan    { target: [f32; 2] }
struct PartyMember{ slot: u8 }
struct BandMember { leader: EntityId, group_name: StrId, hall: Option<EntityId>,
                    formed_at: u32, role_control: f32, role_burst: f32, role_support: f32 }
struct Mate       { id: EntityId }
struct Courting   { sweetheart: EntityId }
struct Bounty     { quest: EntityId, kind: u8 /*hunt|avenge|…*/, faction: Option<Faction>,
                    killer: Option<EntityId>, count: u16, got: u16, toward: [f32;2],
                    giver: EntityId, expire: u32 }      // types/news.ts Bounty
struct Obligations(Vec<Obligation>);             // the Phase-5 commitment ledger
struct Anchors    { home: Option<[f32;2]>, town: Option<[f32;2]>, town_radius: f32,
                    camp: Option<[f32;2]>, camp_patrol_r: f32, roam: Option<RoamState> }
struct Reporter   { target: Option<[f32; 2]> }
struct Notoriety(u16);                           // player/outlaw fame (controlled + emergent outlaws)
struct Disguise   { faction: Faction }           // perceived-faction override (spies)
// breadth-vocabulary belief topics (lazily present): Strength(place), Secret(subject),
// Recipe(good) graded, Believes(subject,topic) one-level, caution surcharge store:
struct KnowTopics { strength: SmallMap<StrId,(f32,f32)>, secret: SmallMap<EntityId,f32>,
                    recipe: SmallMap<Commodity,(f32,u8,u32)>, believes: SmallMap<u64,f32>,
                    caution: SmallMap<u64,(f32,u32,u32)> }
// transient Inform mailboxes (bounded): begging pleas, recruit offers, land-rumour prospects, deeds
struct Mailboxes  { pleas: ArrayVec<(EntityId,u32),4>, offers: ArrayVec<RecruitOffer,4>,
                    prospects: ArrayVec<Prospect,4>, deeds: ArrayVec<Deed,8>, puzzles: ArrayVec<Puzzle,4> }

// ═════════════════════ shared value types ═════════════════════
// types/beliefs.ts BeliefState, split person/place (§3.2 finding (a)). PersonBelief is the N² hot cell.
struct PersonBelief {                            // packed ~56 B (quantize aggressively — it's ×25/agent)
    last_x: f32, last_z: f32,                    //  8  believed last position (NOT truth; map anchor)
    heading: u8,                                 //  1  last-seen motion direction, quantized to 256ths
    last_faction: Faction,                       //  1  believed (a disguise fakes it)
    confidence: u16, standing: i16, suspicion: u8,// 5  conf 0..1, standing −1..1, "off about them"
    sentiment: i16,                              //  2  slow relationship EMA (colours standing)
    notoriety: u16, believed_threat: u16, believed_level: u8, believed_occupation: Profession, // 6
    believed_wealth: u16, wealth_conf: u16, believed_kindness: u16,                             // 6
    last_tick: u32,                              //  4
    source: u8, hops: u8,                        //  2  provenance tag + depth (0 = first-hand)
    flags: u16,                                  //  2  hostile|captive|inert|rumor_born|faction_hostile
                                                 //     |disguised|believed_motive_present
    believed_motive: u8, motive_conf: u16,       //  3  ToM inference output (sparse — usually none)
    // pursuit (inferred destination) — present only when inferred; small enough to inline:
    dest_x: f32, dest_z: f32, dest_inferred_at: u32, intent: u8,
    animacy: Option<Box<AnimacyTally>>,          // lazy: struck/blocked/harmed_me/moved (sparse)
    assoc: Option<Box<AssocBelief>>,             // urchin stash association (sparse)
}
struct PlaceBelief { place_id: EntityId, kind: u8 /*home|tavern|shrine|granary|guildhall|building*/,
                     x: f32, z: f32, sheltered: bool, god: StrId, benefit_felt: u16,
                     confidence: u16, last_tick: u32 }
struct AnimacyTally { struck: u16, blocked: u16, harmed_me: u16, moved: u16 }
struct AssocBelief  { place_kind: u8, x: f32, z: f32, conf: u16, sightings: u8 }

// types/goals.ts Goal — the TS loose bag becomes a Rust ENUM carrying each kind's data (far cleaner;
// the messy `target: Vector3 | EntityId` overlap disappears). `predicate: fn` (a few schema goals)
// → a `PredId` into a registry, since closures can't live cache-friendly in a column.
enum Goal {
    Idle, Work { site: Option<[f32;2]> }, Wander, Eat, Rest, Socialize { with_id: Option<EntityId> },
    Market, Comfort { to_pos: Option<[f32;2]>, src_kind: u8 }, Build, Sightsee { to: [f32;2] },
    Flee { from_id: Option<EntityId> }, Fight { target: EntityId }, Follow { leader: EntityId },
    Hide, Shadow { subject: EntityId }, Avoid { from_id: EntityId }, Protect { ally: EntityId },
    Bounty { toward: [f32;2] }, Arbitrage, Expedition, Caravan, Reporter,
    Avenge { target: EntityId }, Grieve { for_id: EntityId }, Repay { to: EntityId },
    SeekFortune, Delve, Beg, Granary,
    Plan { plan: Box<Plan> },                    // a GOAP plan carries its own step list (below)
}
struct Plan { steps: ArrayVec<PlanStep, 8>, cost: f32, partial: bool, shortfall: f32 }
struct PlanStep { prim: u8 /*goto|gather|produce|buy|sell|give|pay|…*/, bind: PlanBind,
                  verb: u8, snap: Option<(i64,u32)> /*caution: gold,t0*/, acted: bool, emitted: bool }
struct PlanBind { place: StrId, good: Option<Commodity>, n: u16, site: StrId, price: u16,
                  to: Option<EntityId>, amt: i64, target: Option<EntityId>, conf: f32 }
struct Atom { pred: u8, place: StrId, good: Option<Commodity>, n: u16, amt: i64,
              subject: Option<EntityId>, value: f32, need: u8, level: f32, topic: Option<KnowTopic>,
              cond: Option<Box<Atom>>, deadline: u32 }   // planner predicate (types/goals.ts Atom)
struct KnowTopic { kind: u8 /*loc|whereabouts|price|recipe|strength|secret|state*/,
                   subject: Option<EntityId>, place: StrId, good: Option<Commodity>, attribute: u8 }
struct Ambition { kind: u8, label: StrId, progress: f32, t0: u32, revenge: bool,
                  target_id: Option<EntityId>, target_place: StrId }    // types/goals.ts Ambition
struct Obligation { trigger: u8, action: u8, counterparty: Option<EntityId>,
                    amount: i64, expiry: u32, made_at: u32, due_at: u32 }   // types/agent.ts Obligation
struct RoamState { x: f32, z: f32, r: f32 }

// types/motivation.ts Deed — the OBSERVABLE envelope (in the perceivedDeeds mailbox; ToM inference):
struct Deed { actor: EntityId, primitive: u8, target: Option<EntityId>, surface_tag: u8,
              scene_cues: SmallMap<u8,f32>, magnitude: u16, t: u32 }
struct Motive { key: u8, primitive: u8, bind: Goal }     // types/agent.ts motive (committed this tick)

// types/abilities.ts — abilities are INTERNED in a shared, read-only catalog (not per-agent data);
// agents hold only ability-ids + cooldowns (in Progression). The catalog row:
struct AbilitySpec { id: u16, name: StrId, class_key: u8, tier: u8, header: AbilityHeader,
                     effects: ArrayVec<AbilityEffect, 4>, grants_tags: u32 /*Tag bitset*/ }
struct AbilityHeader { target: u8 /*self|enemy|ally|any*/, range: f32, cooldown: f32, cast_time: f32,
                       area: AbilityArea, delivery: AbilityDelivery }
enum AbilityArea { SelfA, Circle{r:f32}, Cone{r:f32,deg:f32}, Line{len:f32} }
enum AbilityDelivery { Instant, Projectile{speed:f32}, Zone{radius:f32} }
struct AbilityEffect { op: EffectOp, amount: f32, dur: f32, chance: f32,
                       when: u8 /*null|on_hit|on_kill|target_hp_below|caster_hp_below*/, tags: u32 }

// ═════════════════════ non-agent entities (no mind) — types/percept.ts ═════════════════════
// Percepts (scarecrows) + buildings share the perceive+combat surface with agents (id/pos/alive/
// faction/torso) but carry NO mind (`agent = null`). They go in the SAME `perceivable` array via the
// disjoint id namespace (TS `B:<n>` → the building tag bit), so perceive sees them with zero special-
// casing — the "mistake a scarecrow for a person" tolerance. Their persistent data is tiny + sparse:
struct Percept  { kind: PerceptKind, faction: Faction, disguise: Option<Faction>,
                  alive: bool /*building: == sheltered*/, hp: f32, combatant: bool }
struct Building { kind: u8, owner: Option<EntityId>, sheltered: bool, benefit_kind: u8, god: StrId }
// STATIC, shared, read-only (built once at worldgen, never an entity column): types/world.ts
//   Poi { kind, pos, region }, Place { id, kind, pos, name, town_id, affords-bitset }, MentalMap.
// Mailbox payloads referenced above: RecruitOffer { from: EntityId, payoff: i64, t: u32 },
//   Prospect { town: u16, x: f32, z: f32, t: u32 }, Puzzle { deed: Deed, best: u8, conf: u16, t: u32 }.
// SmallMap<K,V> = a tiny inline assoc-vec (≤8) — no heap, no HashMap (determinism + cache).
```

**Why this shape is cache- and parallelism-correct:**
- **`PersonBelief` is the memory budget** (~25 × ~56 B ≈ 1.4 KB/agent — the dominant per-entity cost,
  far above the 32 B `Perceivable` row). It's streamed once/agent/tick (own table, sequential), and
  the `subjects[]` split (§3.2) keeps the 126×/tick "do I know O?" lookup off the fat bodies. Quantize
  it hard — every byte is ×25.
- **Dense vs sparse by population** keeps hot columns lean — a town of farmers carries no
  `Duel`/`Spy`/`Migration`/`Bounty` bytes; those systems iterate a handful of `SparseSet` entries.
- **Closed enums + interned strings + fixed arrays** (`[_; N_TAGS]`, `[_; N_COMMODITIES]`) keep every
  hot byte numeric — no `String`/`HashMap` pointer-chasing in `perceive`/`decide`; faction/profession/
  goal/tag logic is a jump table or array index. `Goal` as an enum erases the TS union mess.
- **Fixed-point `i64` economy** makes conservation exact and the merge's money reductions order-free.
- **The `Perceivable` projection** (§3.1) = `Body` + `Roles` + `Notoriety`/`threat` + the precomputed
  wealth-cue — the one ~32 B AoS surface every neighbour scan shares (and the only thing spatially
  re-sorted each tick).
- **`Memory`/`Trace`/`Identity`/`AbilitySpec` catalog are cold/shared and segregated**, so the soak's
  hot loop never pays for the inspector's, chronicle's, or ability-catalog's data.
