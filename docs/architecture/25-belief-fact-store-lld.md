# 25 — Belief fact-store (the proposition model) — LLD

> Status: **READ PATH FULLY UNIFIED ON FACTS.** Per user direction (extensibility + one model +
> per-fact epistemics > a few-% tick cost), the goal is a SINGLE belief representation — the fact
> store — with the legacy struct retired. As of now: **every belief read that drives cognition or
> observation goes through `FactStore`** (decide, planner, derivers, reason, combat, locomotion,
> market, director, tropes, patrician, lineage, groups, expeditions, refugees, signals). The fact
> store is written, decayed, hashed, deterministic (M-invariant), and the flagship open capability
> (a quantitative debt belief → a vendetta) runs end-to-end in-sim.
>
> **Remaining (the writer flip):** `perceive`, `gossip`, the `scry` ability, and the society
> belief-planters (`ensure_belief`/`sour_belief`/`warm_belief` + `seed_grudge`/`warm_to`) still WRITE
> the legacy `PersonBelief`/`BeliefTable`, which is mirrored into facts each tick by
> `World::mirror_beliefs_to_facts` (so readers see writer output). The `FactStore::to_belief_table`
> codec (the inverse of `mirror_core_from`) is in place so those writers can keep their exact tested
> logic on a transient scratch struct while facts become the only PERSISTENT store. Flipping the
> writers + deleting the `beliefs`/`beliefs_prev` columns + the struct hash fold is the final step;
> it is atomic (all writers move together) and was deferred to avoid rushing a working-sim-breaking
> refactor under a tight budget.
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

## What was built (the as-built path)

- **Substrate** — `Fact`, `ValueKind`, `ATTR_KIND`/`ATTR_DECAY`, `FA_*`, `SOURCE_*`, `FactStore`
  (sorted `Vec`, lazy decay, `FACT_CAP` evict-weakest) in `components.rs`; a `facts: Vec<FactStore>`
  column on `World` (both spawn paths). Unit-tested.
- **Hashed** — `facts` folded into `world_hash` in stable (subject, attr) order. **M-invariance holds**
  (`soak_bench`: identical golden hash across 1–32 threads), run-to-run deterministic, gold conserved.
- **The flagship capability, end-to-end** — a robbery now mints an `FA_OWES_ME` debt:
  `act::Rob` emits `Intent::Owe{creditor, debtor, amount}` → the serial `drain_intents` merge writes a
  quantitative, accumulating `FA_OWES_ME` fact into the victim's store (not gold — a belief; conserved
  trivially) → the `collect_debt` deriver reads it (own facts) and, for a debt ≥ `DEBT_VENDETTA_MIN`,
  pushes an `Avenge` intention against the debtor, settled by slaying them (`Slew` gate). So being
  robbed seeds a lasting, proportionate grudge — driven by a value the boolean struct could never
  hold. Proven LIVE in-sim (`tests/fact_capability.rs`: real runs mint debts) + behaviorally
  unit-tested (`exec::derivers::debt_tests`).

## The migration to a single model (as-built + remaining)

Decision (revised, per user): unify on ONE belief representation — the fact store — and retire the
struct. The reasons the earlier "keep the struct as a hot core" stance was wrong: the cost is ~2–6×
on belief reads that are only ~7% of the tick (a couple percent overall, on a tick 64% dominated by
society), and a single model wins on **extensibility** (a new belief = a new `FA_*` + writer + reader,
never widening a struct or its ~280 call sites), **one mechanism** (no struct/fact seam to keep in
sync), and **uniform epistemics** (per-fact confidence/provenance + ToM for every attribute).

Done (committed, green at each step — facts mirror the struct during transition, so every reader
conversion is behavior-identical):
1. Substrate + `World.facts` column + hash fold.
2. The open capability (`FA_OWES_ME` debt → `collect_debt` vendetta) end-to-end + live in-sim.
3. **All readers migrated to `FactStore`** (view/views/believes/confidence): goal derivers, the GOAP
   planner (`Pv.facts`), `decide` (homecoming/warband/flee/scout/intention-satisfied), `reason`,
   combat, locomotion, market, and the society/observer passes.

Remaining — the writer flip (atomic):
4. Rewrite `perceive`/`gossip` to load a scratch `BeliefTable` via `to_belief_table()`, run their
   exact existing logic, and store back via `mirror_core_from()` (facts = the only persistent store);
   add a `facts_prev` snapshot for gossip's cross-read.
5. Convert `scry` + the `ensure_belief`/`sour_belief`/`warm_belief` helpers (and `seed_grudge`/
   `warm_to`) to write facts (the `ensure_belief`-returns-an-index contract needs reworking).
6. Delete the `beliefs`/`beliefs_prev` columns, the mirror pass, and the struct hash fold; keep
   `PersonBelief`/`BeliefTable` only as the transient perceive/gossip scratch + test fixtures.
7. Fix the test fallout (tests that inject `w.beliefs[..]` → seed facts via `mirror_core_from`).

## Future extensions (defined vocabulary, not yet wired)

- `FA_INTENT` / `FA_DESTPLACE` exist in the attribute table but no source writes them yet (the TS
  "dormant by design" pattern) — perceive could infer a believed motive from observed motion.
- **Fact gossip.** Open facts are first-hand only today (a debt is inherently a first-person
  relationship). A `facts_prev` double-buffer (mirroring `beliefs_prev`) would let socially-meaningful
  facts spread with `hops`+1 — wire it when an attribute wants rumor propagation.

## Risks / watch-items

- **The golden hash re-baseline (Phase 2)** is the moment determinism could silently break — verify
  `soak_bench` M-invariance + `determinism.rs` after folding facts in, not just that it compiles.
- **Gossip double-buffer.** `beliefs_prev` exists so gossip reads a frozen snapshot; the fact store
  needs the same `facts_prev` discipline before any cross-read.
- **Eviction churn.** `FACT_CAP` eviction is per-upsert O(n); if perceive upserts many facts/tick,
  batch the cap-trim once after the write loop instead of per-insert.
- **Higher-order beliefs** (a fact whose `subject` is a fact handle — "Mara believes Korg hostile")
  are *enabled* by this layout but out of scope until a ToM feature needs them ([17](17-motivation-primitive-lld.md)).
