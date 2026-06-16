# 24 — Rust Port: Gap-Closing Progress Tracker

**Living doc.** Tracks closing every behavioral-parity gap between the TS sim (`js/**`) and the Rust
port (`rust/sim-core/**`) toward the standing goal: *close all gaps in the Rust port*. The gap
inventory is [`23-ts-rust-parity-audit.md`](23-ts-rust-parity-audit.md) (§0.0 = the refreshed
snapshot); this doc is the **burn-down** against it.

**Bar (load-bearing):** behavioral parity — port every feature/function. The *only* sanctioned
divergence is **determinism** (per-entity RNG, fixed-point gold, inline tables vs JS `Map`s). NOT
"spirit-only," NOT redesign, NOT feature-dropping.

**Invariants that must stay green every commit** (`cd rust && cargo test --workspace`):
- determinism: golden-hash identical run-to-run **and** across `RAYON_NUM_THREADS` 1→32 (the hard gate).
- gold conserved (closed money loop — no minting; goods may mint by design).
- all unit tests + the 4 determinism-suite tests pass.

---

## Baseline (start of gap-closing push)

- **main @ `8972aa8`** — 144 tests green: 136 sim-core + 4 determinism + 3 protocol + 1 server.
- M-invariant 1–32 threads; gold conserved.
- Completeness ≈ **15–20%** of behavioral parity by callable (per the §0.0 refresh).

---

## Gap register (the burn-down)

Status: ⬜ not started · 🟡 in progress · ✅ done (at parity, green). Each line links to the wave/commit
that closes it.

### G1 — Feature layer (highest behavioral leverage; coupled hand-ports)
Current: 7 derivers (avenge, seek_fortune, grieve, defend, donate, repay, steal). Missing:
- ⬜ **caution / experience** — outcome-conditioned burned-hand surcharge (doc 11)
- ⬜ **knowledge model** — observe / ask / study (`Know(topic)` + graded recipes)
- ⬜ **recruiter / warband** — recruit-as-Inform + muster + march-on-foe
- ⬜ **affect** — free (rescue captive) / wreck (sabotage)
- ⬜ **subsistence** — hunger → sate goal
- ⬜ **scout** — curiosity → investigate uncertain-but-valuable belief
- ⬜ **migrate** — emigration prospect → relocate
- ⬜ **reciprocity** — believed-motive → trust/suspicion fold
- ⬜ **apprentice** — teach recipe deriver
- ⬜ **newsread** — gazette median → price-belief fold (needs G4 substrate)
- ⬜ **signalsFold** — outcome-streak / deed-ledger plan-outcome handler

### G2 — Steer-fill table (5 of ~23)
⬜ socialize · court · sightsee · granary/beg · build · travel/road · arbitrage · expedition ·
avoid · shadow · hide · protect · follow · migrate · seek-glory(have) · comfort(have).

### G3 — Reputation / faction-standing rollups
⬜ witnessed-deed → faction standing; standing-skewed market clearing; decay. (Player-only in TS;
in headless Rust applies as NPC-faction standing.)

### G4 — News / economy depth (needs multi-town + gazette substrate)
⬜ market depth (credit/tithe/favored-price/quality/tatonnement) · arbitrage · bounties · reporter ·
gazette (template articles) · econstats.

### G5 — combatEvents master fold
Current: strike→assaulted, kill→slew stamp. Missing:
⬜ witness beliefs (bystanders learn aggressor) · capture-on-defeat → captive → rescue ·
loot/escheat · epithet grant · obituary · vendetta-arc open · avenger/legend roles.

### G6 — arcs + director breadth
⬜ arcs SagaStore (open/append/close/sweep) · 11 missing tropes · 5 arc steppers · role machinery
(bodyguard/duel/protégé/guardian/legend/avenger) · caravans.

### G7 — World subsystems absent
⬜ construction (places-as-percepts + granary) · party (player companions) · biography ·
walls (collision geometry) · percept/scarecrow (disguise props).

### G8 — Ability execution depth
⬜ plant_belief/scry/trade_edge/craft_boost live (carried in IR, inert) · per-agent cooldown ledger ·
requirement gates (while_faithful/vs_sworn_foe/...) · procedural naming/generation.

### G9 — Cognition substrate depth
⬜ full belief fields (suspicion/sentiment/animacy/assoc/hops/provenance/destPos) ·
memory STM/MTM/LTM tiers + salient() · inferDestination (ToM pursuit) · place-beliefs ·
occupation choice (dynamic vs fixed-at-spawn) · decide utility-oracle (scoreAndSelect) · duel election.

---

## Progress log (newest first)

_(append a dated entry per landed commit: what closed, gate status, hash)_

- **(in progress)** Tracker doc created; baseline recorded. Starting G1 (feature layer) — the
  highest-leverage, proven-pattern vertical set.
</content>
</invoke>
