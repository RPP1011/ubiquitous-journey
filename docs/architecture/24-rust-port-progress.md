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
- ✅ **caution / experience** — outcome-conditioned burned-hand surcharge (doc 11). Per-strategy
  `Experience` store (fixed per-verb array, determinism-safe), `experience.rs` math (decay/burn/windfall/
  felt-surcharge/classify-yield), planner cost read, windfall-on-rob-success + burn-on-lost-venture
  writes, and a behavioral steal-gate (a burned thief retires). Hashed for the M-invariance canary.
- ⬜ **knowledge model** — observe / ask / study (`Know(topic)` + graded recipes)
- ⬜ **recruiter / warband** — recruit-as-Inform + muster + march-on-foe
- ⬜ **affect** — free (rescue captive) / wreck (sabotage)
- ✅ **subsistence** — hunger → Sate intention → forage/buy a meal (commit below). **Fixed the
  documented starvation collapse** (town went 380→2 alive by t1500; now 380→372 at t3000).
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
- ✅ **gather executor** (Wave-B) — `Goal::Gather{site, good}` + the market production-pass forager:
  capital-free foraging of a raw good open to any agent (the planner's forage path was previously
  inert — it compiled to `Goal::Work`, which mints only own-profession output). Unblocks subsistence
  + any forage-to-acquire plan.

### G5 — combatEvents master fold
Current: strike→assaulted, kill→slew stamp.
- ✅ **witness beliefs** (bystanders learn the aggressor) — nearby townsfolk who see a killing form a
  belief about the killer: grief + a hostile "murderer" belief (townsperson-on-townsperson), reinforced
  predator-fear (monster takes a neighbour), or admiration (townsperson slays a monster). Gossip then
  spreads it. Also makes the previously-dead `WitnessedDeath` episode (grieve's source) actually fire.
- ✅ **loot** (the dormant Loot verb, made live) — a victor who slew a believed-monied foe strips the
  corpse (`Slew` memory + wealth cue ⇒ Loot intention ⇒ `Atom::Looted` ⇒ reach-and-take ⇒ conserved
  `Hand` of the whole purse ⇒ `Looted` marker). Closes the economy-on-death loop (a fallen agent's
  gold returns to circulation instead of stranding on the corpse).
Missing:
⬜ capture-on-defeat → captive → rescue · escheat (heirless estates) · epithet grant · obituary ·
vendetta-arc open · avenger/legend roles.

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

- **G5 loot vertical** — the dormant Loot verb made live. New `EpisodeKind::Looted` +
  `IntentionKind::Loot` + `Atom::Looted` + a loot primitive (reach-and-take) + a `loot` deriver
  (from a `Slew` memory + believed wealth cue) + the `Looted` marker stamp on the act's loot deed. A
  victor now strips a slain monied foe's corpse — gold returns to circulation (the act `Hand` already
  conserved it). 1 e2e test. 145 sim-core + gates green; M-invariant; gold conserved.

- **G1 caution / experience (doc-11 flagship)** — the burned-hand half of regret. New `Experience`
  column (a fixed `[ActExp; 12]` indexed by planner verb — no HashMap, so determinism-safe) + `experience.rs`
  (lazy half-life decay, asymmetric burn/windfall clamps, luck-discounted attribution, rt-relief read).
  Wired: the planner prices `felt_surcharge` into each strategy's cost; a successful rob writes a
  (shallow, diminishing) windfall; a lost-track venture burns a waste; and the steal deriver gates on
  the felt surcharge so a thief whose heists keep failing retires (even the boldest, once fully burned).
  Added to the world hash. 5 new tests. 144 sim-core + gates green; M-invariant; gold conserved.

- **G5 combatEvents witness fold** — bystanders now learn from killings. A new `fold_kill_witnesses`
  in the serial `drain_intents` kill branch: nearby living townsfolk record `WitnessedDeath` (grief)
  and form a belief about the killer — hostile "murderer" (folk-on-folk), reinforced predator-fear, or
  admiration of a monster-slayer. The killer's reputation now SPREADS (and gossip carries it). Wires up
  the previously-inert `WitnessedDeath` episode. 2 new tests. 139 sim-core + gates green; M-invariant.

- **G1 subsistence + G4 gather executor** — closed the documented **starvation collapse**. Added
  `IntentionKind::Sate` + the `subsistence` deriver (hungry + empty larder ⇒ pose a meal to the
  planner), a first-class `Goal::Gather{site, good}` + market-pass forager (capital-free foraging,
  any agent), and split the planner's gather-vs-produce compile. The survival reflex now falls through
  to foraging instead of stalling on the inert `Eat`. New `tests/town_survival.rs` regression (town
  380→372 alive at t3000, was 380→2 at t1500). Gates: 137 sim-core + 4 determinism + 1 survival +
  3 protocol + 1 server green; M-invariant 1–32; gold conserved.

- **(start)** Tracker doc created; baseline recorded. Starting G1 (feature layer).
</content>
</invoke>
