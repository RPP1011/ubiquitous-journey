# 25 — Belief fact-store (the proposition model) — LLD

> Status: **Phase 1 landed** (substrate present + tested, unwired). Phases 2–5 pending.
> Supersedes the fixed `PersonBelief`/`BeliefTable` struct as the belief representation.
> See also: [02 — the epistemic split](02-epistemic-split.md), [10 — knowledge model](10-action-grammar.md),
> [22 — Rust ECS backend](22-rust-ecs-backend-lld.md) (determinism mandate).

## Why

The as-built belief is a fixed-schema struct — `PersonBelief` in `components.rs`, held in a cap-25
`BeliefTable` per agent (a `find(subject)` linear scan → struct field access). It has two costs:

1. **Closed ontology / lossy.** An agent can only believe things the struct has a *column* for.
   `hostile`, `lastFaction`, `believedWealth` exist; "Korg owes me 5 gold", "the bridge is out",
   "Mara promised to meet me at dusk" do not. Anything without a column is unrepresentable (or
   crammed into an untyped bag). Each new believable fact needs a struct edit + every predicate.
2. **Coarse epistemics.** One struct per topic, so an *agent* belief carries null place fields and a
   *place* belief carries meaningless `hostile`/`standing`; and confidence/provenance/recency are
   mostly **whole-record** scalars, not per-fact.

A belief *wants* to be a **proposition**: `{subject, attribute, value}` plus confidence, provenance,
and age. The fact store makes that the representation. Topics span agents, places, motives, items —
the N×M-over-topics model, where M is the handful of topics an agent actually tracks.

## The decision (and why the perf is accepted)

Product call: **richness per agent beats agent count.** "Near-infinite boring agents" add no value;
the goal is interesting agents that maximize value per player interaction. So we take the more
powerful model and eat the performance penalty.

The penalty was measured before committing (prototypes in `src/bin/`, kept for re-runs):

- **`beliefbench`** — fact reads are ~2–6× slower than struct field access, ~2.6× memory. Use an
  FxHash-style integer hasher, **not** std `HashMap`'s SipHash (which blows up at scale). Even so the
  inline struct wins targeted reads on locality — so the gain is not speed, it is capability.
- **`tickprofile`** (+ `World::step_profiled`) — the decisive number: the belief-READ phases
  (`reason`+`decide`+`gossip`) are only **~6.9% of the tick** at 5k agents; the real bottleneck is
  `rest` (society/progression/sagas) at **~64%**. A fact-store slowdown hits a small slice — worst
  case ~+34% tick, realistically +5–10%. **Beliefs are not the tick bottleneck.**

## The model

A `Fact` is 20 bytes, all ints (`components.rs`):

```
Fact { subject: u32, value: u32, observed_at: u32, base_conf: u16, attr: u8, src: u8, hops: u8 }
```

The key idea: **`attr` implies the value-kind** via a static `ATTR_KIND` table, so a fact needs no
per-fact type tag. `value: u32` is read as a Bool / Symbol (interned enum) / Quant (fixed-point) /
Entity / FBits (`f32::to_bits`, for positions) / Place id depending only on `attr`.

- **Attributes** (`FA_*`): `0..=5` (faction, hostile, last_x, last_z, threat, standing) mirror
  `PersonBelief`'s hot fields so Phase 2 can mirror them 1:1. `6..` is the open tail —
  `FA_INTENT` (believed motive), `FA_DESTPLACE` (believed destination), `FA_OWES_ME` (a debt) —
  things the struct could never carry. Extending the ontology = adding a `FA_*` const + two table
  rows, no struct surgery.
- **Lazy decay.** `ATTR_DECAY[attr]` is confidence lost per tick. `Fact::conf_now(now)` computes
  `base_conf − decay·age` at read time — decay never iterates the store on the tick. A 0-decay attr
  (`FA_OWES_ME`) is a ledger fact: not forgotten by time, only **settled** by an event.
- **Per-agent `FactStore`** = a `Vec<Fact>` kept **sorted by (subject, attr)**: O(log n) `get`,
  stable iteration, soft-capped at `FACT_CAP` (96 — richer than `BELIEF_CAP`=25) with deterministic
  lowest-confidence eviction (ties by key).

### Determinism (the load-bearing constraint)

The M=1≡M=N golden hash ([22](22-rust-ecs-backend-lld.md)) must survive. Rules:

- **No HashMap in the read/hash surface.** The store is a sorted `Vec` — deterministic iteration.
  (The `FactHash` in `beliefbench` is a perf probe only; the real store never hashes.)
- **A `Vec` per agent is the one deliberate departure** from the inline-`Copy` column rule. Accepted
  per this doc; it does not threaten determinism (order is stable), only the "no heap in columns"
  performance property.
- **Folded into `hash.rs` in stable (subject, attr) order** once it carries data (Phase 2).
- Written **own-row only** in parallel phases (like `beliefs`), or via the serial intent merge for
  cross-agent effects (a minted debt). Lazy decay is a pure read ⇒ no write-race.

## Migration plan (phased, green at each step)

~280 references across 25 files read `PersonBelief`/`BeliefTable` (`bt.find(s)` → `bt.bodies[ix].field`),
including `hash.rs`. So this is incremental, never a big-bang.

- **Phase 1 — substrate (LANDED).** `Fact`, `ValueKind`, `ATTR_KIND`/`ATTR_DECAY`, `FA_*`,
  `FactStore` (+ unit tests) in `components.rs`; a `facts: Vec<FactStore>` column on `World`,
  initialized in both spawn paths. Unwired ⇒ stores stay empty ⇒ golden hash unchanged. **228 unit
  tests + determinism gate green.**
- **Phase 2 — mirror + hash.** `perceive` writes the core facts (`FA_FACTION`/`HOSTILE`/`LASTX`/
  `LASTZ`/`THREAT`/`STANDING`) alongside the struct, mirroring the same values. Fold `facts` into
  `world_hash` in stable order. The golden hash value changes once (re-baseline); **M-invariance and
  run-to-run must still pass** — that is the gate that proves the parallel writes are race-free.
- **Phase 3 — read parity.** Migrate ONE consumer (a `decide` predicate or a deriver) to read from
  `facts` via a helper, behind an assertion that struct and fact agree. Proves the read path.
- **Phase 4 — the capability.** Wire a genuinely-new OPEN attribute end-to-end: `FA_OWES_ME` minted
  by an event (a loan/robbery) through the serial intent merge (closed gold loop preserved), read by
  a new "collect debt" deriver → behavior. This is the thing the struct could not do — the proof the
  model earns its cost.
- **Phase 5 — retire the struct.** Migrate remaining `PersonBelief` field reads to `facts`
  one attribute at a time; when the last consumer is off it, delete `PersonBelief`/`BeliefTable` and
  the `beliefs`/`beliefs_prev` columns (gossip's double-buffer becomes a `facts_prev` snapshot).

## Risks / watch-items

- **The golden hash re-baseline (Phase 2)** is the moment determinism could silently break — verify
  `soak_bench` M-invariance + `determinism.rs` after folding facts in, not just that it compiles.
- **Gossip double-buffer.** `beliefs_prev` exists so gossip reads a frozen snapshot; the fact store
  needs the same `facts_prev` discipline before any cross-read.
- **Eviction churn.** `FACT_CAP` eviction is per-upsert O(n); if perceive upserts many facts/tick,
  batch the cap-trim once after the write loop instead of per-insert.
- **Higher-order beliefs** (a fact whose `subject` is a fact handle — "Mara believes Korg hostile")
  are *enabled* by this layout but out of scope until a ToM feature needs them ([17](17-motivation-primitive-lld.md)).
