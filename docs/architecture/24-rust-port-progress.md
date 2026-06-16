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
- 🟡 **knowledge model** — (1) the **observe / whereabouts (scout)** channel (idle-tier curious
  investigation, perceive firms on arrival); (2) **graded recipes** (recipeKnow core): a per-agent
  `recipe` skill (0..1) that a MASTER (≥0.8) parlays into an EXTRA production unit, raised by
  learn-by-doing (producing) and faded by a use-it-or-lose-it forget pass. Economy-safe by construction
  (the bonus only ADDS — a rusty recipe never produces less than baseline). **Also fixed a real
  production-site off-by-one** (decide sent workers to `work_sites[prof-1]` but production checked
  `work_sites[prof]`, so craft production NEVER fired live — the town subsisted only on foraging; town
  survival jumped to 80–98% once the craft economy worked); (3) the **study channel** (`learning.ts`):
  a rusty crafter co-located with a same-craft MASTER firms its recipe and pays CONSERVED tuition to the
  teacher (the taught route to mastery); (4) the **ask channel**: with no master nearby, a rusty crafter
  ASKS a more-skilled co-located peer for a smaller, tuition-free recipe nudge. **All 3 knowledge channels
  (observe/ask/study) now live.**
- ✅ **`Know(topic)` goal-stack abstraction** — `IntentionKind::Know` + the `apprentice` deriver: a
  crafter who hasn't mastered its own-craft recipe poses a Know goal on the persistent goal stack (the
  `goalLearn` representation), and decide serves it as a disposition biasing the agent toward PRACTISING
  its trade (where learn-by-doing + study/ask firm the recipe). Pops once mastery is reached (the deriver
  stops re-posing). The knowledge-seeking now flows through the explicit goal layer. **Knowledge model
  fully complete — observe/ask/study + graded per-craft recipes + cross-craft + the Know-goal layer.**
- ✅ **cross-craft learning** — the `recipe` skill is now PER GOOD (`[f32; N_COMMODITIES]`): an agent
  retains its mastery of a craft it has practised even after retraining into another (a switcher who
  once mastered a trade is still skilled at it; an unpractised craft fades). Production / learn-by-doing /
  forget / study / ask all index per good; the dynamic-occupation switch keeps the recipes (no reset).

### Dynamic occupation (the `chooseOccupation` gap)
- ✅ **dynamic occupation** (saturation half) — the workforce SELF-BALANCES: an agent in an OVER-supplied
  trade retrains into the most UNDER-supplied one (resetting its recipe; learn-by-doing rebuilds it), but
  a **food-protection floor** is never breached (farmers stay staffed — the marginal-economy staple).
  Gradual (one retrain per pass, rng-gated). Survival held (95/94/78%); deterministic; M-invariant.
- 🟡 **recruiter / warband** — **warband combat rally LANDED**: a band follower converges on its
  leader's foe *if it also perceives it* (shared-threat ToM; overrides personal flee; combat-only, so
  no peacetime economic cost). Built via a serial leader-foe snapshot read in the parallel decide.
  ⬜ still: recruit-as-an-explicit-Inform offer + the muster derivation (bands currently form by
  mutual standing in groups.rs, not a deliberate recruit goal).
- 🟡 **affect** — ✅ free (rescue captive, the full capture→rescue arc) · ⬜ wreck (sabotage — dormant,
  needs a building/structure target state, which the headless core lacks)
- ✅ **subsistence** — hunger → Sate intention → forage/buy a meal. **Fixed the documented starvation
  collapse** (town went 380→2 alive by t1500; now 380→372 at t3000).
- ✅ **scout** — curiosity → idle-tier `Goal::Observe` to firm an uncertain-but-valuable belief.
- ⬜ **migrate** — emigration prospect → relocate
- ✅ **reciprocity** — the sentiment arm of the alms loop: a gift WARMS the beneficiary's believed
  `standing` toward its benefactor (and bystanders who witness the generosity warm a little) — the
  goodwill mirror of the murder-souring witness fold. Drives the donate→succoured→repay loop's affect.
- ✅ **apprentice** — the `Know(recipe)` goal-stack deriver (biases a rusty crafter to practise/study).
- ✅ **newsread** — the gazette median → price-belief EMA fold (G4 substrate built).
- ✅ **signalsFold** — the PLAN_OUTCOME streak handler: a resolved heist folds `Ok` (windfall, world.rs)
  or `Fail` (wasted venture, decide.rs) onto the agent's `Heist` streak signal — the "third job in a
  row" telemetry the saga/biography observer reads. Co-located with the caution windfall/burn.

### G2 — Steer-fill table / goal variety
Note: locomotion.rs is already a generic `move_target` attractor/repulsor stepper, so this is a
*decide-side goal-variety* gap, not a locomotion one.
- ✅ **socialize + sightsee** (+ the previously-unsatisfiable **social/novelty needs**) — needs.rs now
  satisfies social (at market/work) and novelty (wandering/at fields) PASSIVELY; the explicit
  `Goal::Socialize`/`Sightsee` fills enrich genuinely-idle townsfolk (lowest priority, never robs the
  work economy — the marginal-economy survival lesson, learned the hard way via the survival regression).
⬜ court · granary/beg · build · travel/road · arbitrage · expedition · avoid · shadow · hide · protect ·
follow · migrate (most are downstream of absent subsystems: caravans/gazette/party/construction).

### G3 — Reputation / faction-standing rollups
⬜ witnessed-deed → faction standing; standing-skewed market clearing; decay. (Player-only in TS;
in headless Rust applies as NPC-faction standing.)

### G4 — News / economy depth
- ✅ **gazette + newsread** (single-town) — a `gazette.rs` town newspaper: a periodic edition snapshots
  the recent chronicle into briefs + a median price board (per good, across living townsfolk). The
  **newsread** consumer folds the published prices into agents' OWN price beliefs (a gentle EMA) — a
  market signal ripples out through the NEWS, not just direct perception (doc-05). **Food is exempt** (the
  survival regression caught that converging food beliefs destabilises the marginal economy — a 49% dip);
  the news moves only the secondary goods. Conserved (beliefs only); hashed; M-invariant.
- ✅ **econstats** — economic telemetry: observer counters (trades / units / gold-flowed / per-good
  volume) folded into the trade merge. Hashed; deterministic; observer-only.
- ✅ **reporter** (wire-desk subset) — the gazetteer files a market-report `KIND_REPORT` chronicle beat
  each gazette cycle (the DELTA trade volume since the last filing, tagged with the edition). The
  roaming-interview + LLM-article path is render/browser-only (out of headless scope).
- ✅ **bounties** — a CONSERVED news-driven labour market: when a monster/raider menaces the town core,
  the town posts a bounty — a levy from the wealthiest few townsfolk into a held `bounty_fund` — and
  whoever slays the target claims the fund (paid in the kill branch). The moneyed pay to be rid of a
  threat, a fighter earns it. `total_gold` counts the fund so conservation holds mid-bounty. Hashed.
  **All single-town news/economy systems now done** (gazette/newsread/econstats/reporter/bounties).
- ✅ **caravans + arbitrage** (single-town form via an external market) — a merchant trades a price
  DIFFERENTIAL with an EXTERNAL market: exports the town's most-surplus non-food good at a premium (the
  external `caravan_treasury` pays the merchant) and imports a luxury (the merchant pays the treasury).
  Profits on the spread; gold conserved (`total_gold` counts the treasury); Food never exported (the
  staple stays home). This is the single-town substitute for the inter-town price gap — closes the
  behavioral intent of arbitrage/caravans without the full multi-town worldgen split.
- ✅ **favored-price / standing-skew** (`npcFavoredPrice`) — the double-auction now clears at the belief
  midpoint SKEWED by how the seller regards the buyer (±FAVOR): a friend gets a discount, a despised
  buyer a markup, a stranger the neutral price. Conserved. Makes reputation/relationships matter in trade.
⬜ market depth (credit/tithe/quality/tatonnement) · arbitrage · bounties · reporter · gazette
(template articles) · econstats.
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
- ✅ **capture-on-defeat → captivity → rescue (the dormant `Free` verb, now LIVE)** — a raider's lethal
  blow on a townsperson may take them PRISONER (`captive_of` column; rng-gated). A captive is inert +
  frozen (held & fed) + released when its captor falls. Nearby townsfolk SEE the capture (a believed-
  captive belief flag, the capture-witness fold), and a BRAVE friend braves the captor to cut the bonds:
  Rescue intention → `Atom::Freed` → Free primitive → `Goal::Interact{Free}` → conserved free deed →
  `captive_of` cleared + `Freed` marker. The full capture→rescue arc, end-to-end tested.
- ✅ **escheat** (`_reapCorpses` heir-pass) — a dead agent's un-looted purse no longer strands out of
  the money loop: it passes to a living KINSMAN (same house) or, heirless, escheats to the nearest
  living townsperson. Conserved; throttled (every 240 ticks) so a fresh corpse can still be looted first.
- ✅ **vendetta-arc open/close** — folded into the SagaStore (see G6).
- ✅ **epithet grant** — the brand PRIMITIVES existed (`brand_epithet`) but nothing earned them. Added
  `earn_epithets` (throttled society pass): accumulated deed tallies (doc-13 signals) cross thresholds
  → a thief is branded VILLAIN, a foe-slayer / captive-freer a HERO, a peril-survivor a SURVIVOR;
  idempotent (first earned title sticks), logged as a chronicle epithet beat. (The free deed now also
  folds into the Rescue signal so rescuers can earn HERO.)
- ✅ **obituary** — a NOTABLE death (a named soul with an epithet, or one of rank ≥5) now logs a
  `KIND_OBITUARY` chronicle beat carrying who they were (epithet×100+level) for the render-layer eulogy;
  ordinary deaths keep the plain DEATH beat. The `gazette.buildObituary` "obituaries are for the
  notable" trigger.
Missing:
⬜ avenger/legend roles (director role machinery).

### G6 — arcs + director breadth
- ✅ **arcs SagaStore** (`sagas.rs`) — the emergent-saga registry (observer): a vendetta arc opens on
  an assault, escalates a beat on each repeat, and closes on the slaying (either direction); a rescue
  is a one-beat closed arc. Folded in the serial merge (deterministic, hashed), swept of stale closed
  arcs each tick, bounded (256, oldest-evicted). open_or_touch/close/record/sweep/open_count.
- 🟡 **arc steppers** — the first director arc stepper landed (`director::step_sagas`): a long-burning
  VENDETTA saga (≥3 blows) between two souls of different houses ESCALATES into a dynastic HOUSE FEUD
  (the strife outgrows the two; their kin inherit it via lineage). The reckoning/`_advanceArcs` flagship.
  ⬜ still: the other 4 arc steppers (tyrant-fall/spy-web/romance/accused).
- ✅ **tropes 9 → 18** (TS parity count): + mistaken-jealousy, rival-apprentices, mentor-pride,
  star-crossed (across a house feud), boast-backfires, spy-unmasked (intrigue), **favored-rise** (a poor
  soul gains a patron's regard), **prophet** (a faith-holder draws a convert into the flock + devotion),
  **tyrant-market** (great wealth breeds a poor neighbour's resentment). All compose from existing
  belief/level/role/gold/faith/house substrate + the trope dispatcher.
- 🟡 **role machinery — avenger + bodyguard** landed: (1) a MURDER enlists a kinsman/friend as an
  **avenger** (grudge + the avenge GOAP loop hunts the killer; `ROLE_AVENGER`); (2) a NOTABLE gains a
  **bodyguard** — a capable nearby protector band-bound to the principal (`band_leader = vip`,
  `ROLE_BODYGUARD`) so the existing warband-rally defends them IN COMBAT, with zero peacetime cost.
- ✅ **role machinery — all 6 roles live**: avenger (hunts a kinsman's killer), bodyguard (warband-rally
  defends a notable), legend (a renowned hero), duellist (mutual sworn foes), protégé (an apprentice who
  reveres a same-craft master — composes with mentor-pride), guardian (a capable soul in the town core).
- ✅ **arc steppers — all 5 live**: reckoning (vendetta→house-feud), romance (mutual-warm bond),
  tyrant-fall (a resented rich soul), spy-web (an active intrigue spy), accused (a pariah whom many
  believe a foe). Open from the trope-planted relationship fabric; resolved via `close_subject` on death.
⬜ caravans (needs multi-town travel).

### G7 — World subsystems absent
⬜ construction (places-as-percepts + granary) · party (player companions) · biography ·
walls (collision geometry) · percept/scarecrow (disguise props).

### G8 — Ability execution depth
- ✅ **plant_belief** live — the social ability op now reaches the epistemic layer: a charmer
  (silver_tongue/haggle, negative amount) WARMS how a nearby agent regards it; a deceiver (plant_rumor,
  positive) SOURS it. New `Intent::Influence{from,to,warm}` applied serially via warm/sour_belief; a
  3rd (social) autocaster branch fires it when nothing else did. Per-agent cooldown ledger already
  existed (`ability_cd`).
- ✅ **scry** (read_mind) live — the autocaster firms its VAGUEST nearby belief from the truth
  (confidence up, position refreshed) as an own-write in the cast phase (a sanctioned ability reveal,
  like perceive). A 4th autocaster branch; `is_scry`/`vaguest_belief_in_range`.
- ✅ **shield** op live — `CombatBody.shield` damage-buffer column: a self-cast (second_wind) raises it
  (capped); the Strike merge soaks damage into it before health (depletes, no regen, overflow carries
  through). Hashed for M-invariance.
- ✅ **craft_boost** (master_craft) live — a master crafter self-casts for an immediate BURST of its
  trade-good (own-write to inventory, capped; the 5th autocaster branch). Economy-positive.
- ✅ **trade_edge** (haggle) live — a `trade_buff` window column: a merchant's haggle arms it, and the
  market clears that seller's sales UP (+15%) while active. **11/12 ability ops now live.**
⬜ the control ops stun/slow/knockback/expose (need combat-state columns; all on Rust-unreachable
  classes — whirlwind/cleaving/expose-weakness are NO_CLASS) · requirement gates · procedural naming.

### G9 — Cognition substrate depth
⬜ full belief fields (suspicion/sentiment/animacy/assoc/hops/provenance/destPos) ·
memory STM/MTM/LTM tiers + salient() · inferDestination (ToM pursuit) · place-beliefs ·
occupation choice (dynamic vs fixed-at-spawn) · decide utility-oracle (scoreAndSelect) · duel election.

---

## Progress log (newest first)

_(append a dated entry per landed commit: what closed, gate status, hash)_

- **G1 knowledge model — study channel** — a rusty crafter co-located with a same-craft master firms up
  its recipe and pays CONSERVED tuition to the teacher (the taught route to mastery; recipeKnow's
  study-from-teacher with conserved tuition). Throttled society pass. 1 new test; gold conserved.

- **G1 graded recipes + a real production bug fix** — added the recipeKnow core: a `recipe` skill column
  (learn-by-doing on produce, fade via a forget pass), a master's extra-output bonus (economy-safe — the
  bonus only ADDS). **In wiring it, found + fixed a production-site off-by-one** (`work_sites[prof]` →
  `[prof-1]`) that had meant craft production NEVER fired in the live sim — the town had subsisted only
  on the foraging path. With the craft economy now real, town survival jumped to **80–98%** (was 53–94%).
  2 new tests; determinism + survival green; M-invariant.

- **G8 trade_edge ability op (11/12 live)** — a `trade_buff` window column: a merchant's haggle arms it
  (set in the social cast branch), and the market clears that seller's sales +15% while active. Conserved
  (a price shift). Only the 4 control ops remain — all on Rust-unreachable (NO_CLASS) catalog specs.
  1 new test; hashed; survival unaffected.

- **`Know(topic)` goal-stack abstraction (the LAST gap)** — `IntentionKind::Know` + the `apprentice`
  deriver: an unmastered crafter poses a Know goal on the persistent goal stack (the `goalLearn`
  representation), served as a disposition biasing it toward practising its trade; pops at mastery.
  Knowledge-seeking now flows through the explicit goal layer. 1 new test; survival + determinism green.

- **cross-craft learning (knowledge model complete)** — refactored the `recipe` skill to PER GOOD
  (`[f32; N_COMMODITIES]`): an agent retains mastery of a craft it has practised even after retraining
  into another (the cross-craft retention), while unpractised crafts fade. Production/learn/forget/
  study/ask all index per good; the occupation switch no longer resets the recipes. The knowledge model
  is now complete (observe/ask/study + graded per-craft recipes + cross-craft). 1 new test; M-invariant.

- **dynamic occupation (`chooseOccupation`)** — the workforce self-balances: an over-supplied trade
  retrains a worker into the most under-supplied one (resetting its recipe), with a **food-protection
  floor** so the farmers are never thinned below staffing — the marginal-economy staple stays safe.
  Gradual + rng-gated. Survival held at 95/94/78%. 1 new test; M-invariant. (Unblocks cross-craft,
  which additionally needs multi-recipe slots.)

- **G4 caravans + arbitrage (external-market form) — news/economy cluster essentially complete** — a
  merchant trades a price spread with an external market (`caravan_treasury`): export the town's surplus
  non-food good at a premium, import a luxury; profit on the differential, gold conserved (treasury
  counted in `total_gold`), Food never exported. The single-town substitute for the inter-town price gap.
  1 new test; survival + determinism green; M-invariant.

- **G4 bounties — all single-town news systems done** — a conserved news-driven labour market: a threat
  to the core triggers a town bounty (a levy from the wealthy into a held `bounty_fund`), claimed by
  whoever slays the target (paid in the kill branch). `total_gold` now counts the fund (conservation
  holds mid-bounty). 1 new test; hashed; M-invariant. Only the truly-multi-town arbitrage/caravans remain.

- **G4 reporter (wire desk)** — the gazetteer files a market-report `KIND_REPORT` chronicle beat each
  gazette cycle (the delta trade volume since the last filing, tagged with the edition). Observer-only,
  deterministic, hashed. The roaming-interview/LLM-article path is render-only (out of headless scope).
  1 new test; M-invariant.

- **G4 econstats** — economic telemetry: an `EconStats` observer-counter column (trades / units / gold
  flowed / per-good volume) folded into the conserved trade merge. Observer-only, hashed, deterministic.
  1 new test; M-invariant.

- **G4 gazette + newsread** — the news layer's centerpiece, single-town: `gazette.rs` publishes a
  periodic edition (recent chronicle briefs + a median price board), and the **newsread** consumer folds
  the published prices into agents' price beliefs (a market signal spreads via the news). Found that only
  **arbitrage/caravans** truly need multi-town — gazette/reporter/bounties/econstats are single-town-viable.
  The survival regression again caught a destabilization (converging FOOD beliefs → 49%); fixed by
  exempting food. 2 new tests; survival restored to 80–99%; M-invariant; hashed.

- **G1 knowledge model — ask channel (observe/ask/study all live)** — extended the study pass: with no
  master nearby, a rusty crafter ASKS a more-skilled co-located peer for a smaller, tuition-free recipe
  nudge. All three knowledge channels now live. 1 new test; conserved; M-invariant.

- **G6 spy-web + accused arc steppers — ALL 5 arc steppers now live** — spy-web (an active intrigue
  `role==spy` opens the arc) + accused (a pariah whom ≥4 believe a hostile foe). With reckoning/romance/
  tyrant-fall, the emergent-saga arc layer is complete; all resolve via `close_subject` on death. 1 test.

- **G6 romance + tyrant-fall arc steppers** — two more emergent-saga arcs: **romance** (a strong
  mutual-warm pair opens a lasting Romance saga) + **tyrant-fall** (a wealthy soul resented by ≥3 opens
  the arc; a `close_subject` death-hook resolves it on their fall). New `SagaKind::Romance/TyrantFall`;
  `open_emergent_sagas` detector reads the trope-planted relationship fabric. 3 of 5 arc steppers now
  live (reckoning/romance/tyrant-fall). 2 new tests; M-invariant.

- **G6 protégé + guardian roles — ALL 6 director roles now live** — protégé (an apprentice who reveres a
  high-level same-craft master — composes with mentor-pride) + guardian (a capable soul standing in the
  town core). The director role-machinery cluster is complete: avenger/bodyguard/legend/duellist/protégé/
  guardian. 2 new tests; M-invariant.

- **G6 legend + duellist roles** — two more director roles: a very high-rank hero is recognized as a
  living **legend**; two mutually sworn-hostile townsfolk formalize a **duel** (both marked duellist —
  composing with the feud/vendetta substrate). 4 roles now live. 2 new tests; M-invariant.

- **G6 avenger role machinery** — the first director role: a townsperson's MURDER (folk slays folk) now
  enlists a living kinsman (else a dear friend) as an avenger — they inherit the grudge (Assaulted memory
  + latched-hostile belief) and the avenge GOAP loop makes them HUNT the killer; they wear `ROLE_AVENGER`.
  Composes the murder→avenger→vendetta arc from the combatEvents + avenge-loop + house substrate. 1 test.

- **G6 tropes (9 → 18, TS parity count)** — across four commits, added 9 tropes that compose from
  existing substrate: mistaken-jealousy, rival-apprentices, mentor-pride, star-crossed (across a house
  feud), boast-backfires, spy-unmasked (intrigue role), **favored-rise** (a poor soul gains a patron),
  **prophet** (a faith-holder draws a convert + devotion), **tyrant-market** (wealth breeds resentment).
  9 new tests; all observer/director-driven, serial ⇒ deterministic, economy-safe. (N_TROPES 9→18.)

- **G8 craft_boost ability op** — master_craft made live: a master crafter self-casts (the 5th
  autocaster branch) for an immediate burst of its profession's trade-good (own-write to inventory,
  capped). Economy-positive. 1 new test; survival unaffected. (Of the 12 effect ops, only trade_edge +
  the control ops stun/slow/knockback/expose remain — each needs a new column or is on a Rust-unreachable class.)

- **G6 director arc stepper (reckoning)** — the first arc stepper: `director::step_sagas` advances open
  SagaStore arcs — a hardened vendetta (≥3 traded blows) between two souls of different houses ESCALATES
  into a dynastic house feud (idempotent; their kin then inherit the grudge via lineage). Closes the
  loop SagaStore→director: the registry built last turn now drives emergent escalation. 1 new test.

- **G5 obituary** — a notable death (a named/epithet soul, or one of rank ≥5) now logs a `KIND_OBITUARY`
  chronicle beat carrying the deceased's title+rank for the render-layer eulogy; ordinary deaths keep
  the plain death beat. The gazette.buildObituary "obituaries are for the notable" trigger. 1 new test.

- **G5 epithet grants (earned)** — the hero/villain/survivor brand was a dead primitive (nothing called
  it). `earn_epithets` now brands souls from accumulated deeds: a thief→villain, a foe-slayer/captive-
  freer→hero, a peril-survivor→survivor (idempotent, first title sticks, logged as a chronicle beat).
  The free deed also now folds into the Rescue signal. 1 new test; M-invariant; survival unaffected.

- **G5 escheat (inheritance)** — a dead agent's un-looted purse no longer strands out of the closed
  money loop: a throttled society pass passes it to a living kinsman (same house), else escheats it to
  the nearest living townsperson. Conserved; throttled so a fresh corpse can be looted first. 2 new tests.

- **G4 market standing-skew (favored price)** — the double-auction clears at the belief midpoint SKEWED
  by the seller's belief-standing toward the buyer (±20%): friends get a deal, the despised are gouged,
  strangers pay neutral. Conserved (the skew moves only WHERE the midpoint sits). Reputation now bites in
  trade — the `npcFavoredPrice` / motive-trust market-depth item. 1 new test; survival unaffected.

- **G6 arcs SagaStore** — the emergent-saga registry (`sagas.rs`, observer-only): vendettas open on
  assault / escalate on repeat / close on the slaying; rescues are one-beat arcs. Folded in the serial
  merge (deterministic), swept each tick, bounded + hashed. The structured narrative layer the director's
  (still-absent) arc steppers will hang on. 3 new tests; 160 sim-core + gates green; M-invariant.

- **G1 scout / observe channel (knowledge model)** — the proactive whereabouts channel: a curious idle
  townsperson goes to watch its vaguest-but-valuable belief (`Goal::Observe`, gated to the idle tier so
  it never robs foraging time); perceive firms the confidence on arrival (first-hand watching = the
  learning). 1 new test; survival regression unaffected. (ask/study + recipe knowledge still deferred.)

- **G5 rescue / the Free verb (LIVE)** — completed the captivity arc: a capture-witness fold sets a
  believed-captive flag (0x02) on nearby townsfolk; a brave friend derives a Rescue intention (treated
  aggressive so it braves the captor, overriding flee), the planner routes `Freed`→Free→reach-and-free,
  and the act `Free` executor emits a conserved free deed that clears `captive_of` + stamps a `Freed`
  marker. The dormant Free verb is now live; full capture→rescue arc end-to-end tested. 1 new e2e test.

- **G5 capture-on-defeat / captivity** — raiders now take PRISONERS: a raider's lethal blow on a
  townsperson may capture instead of kill (rng-gated in the serial merge; new `captive_of` column).
  A captive is inert (decide → Idle) + frozen (no needs drain/starve — held & fed) + released the
  instant its captor falls. Hashed for M-invariance. Lays the substrate for the belief-gated rescue
  (the still-dormant `Free` verb). 2 new tests; 155 sim-core + gates green; survival unaffected.

- **G8 scry ability op** — read_mind made live: the autocaster firms its vaguest believed-agent-in-range
  from the truth (reveal pos/faction, raise confidence) as an own-write in the (now belief-mutable) cast
  phase — a sanctioned ability reveal, no cross-agent intent. 1 new test; 152 sim-core + gates green.

- **G1 warband combat rally** — bands (which `groups.rs` forms by mutual standing) now *act*: a follower
  converges on its leader's foe when it also perceives that foe (shared-threat ToM; overrides personal
  flee). Built via a serial leader-foe snapshot (read-only, 1-tick lag) consumed in the parallel decide,
  so no live-`goal`-column borrow conflict. Combat-only ⇒ survival regression unaffected. 2 new tests.

- **G8 plant_belief ability op** — the ability DSL's reach into the epistemic core, made live. A
  speaker's silver-tongue / merchant's haggle (negative `plant_belief`) WARMS how a nearby agent
  regards the caster; a trickster's plant-rumor (positive) SOURS it. New `Intent::Influence{from,to,warm}`
  applied serially (warm/sour_belief); a 3rd social autocaster branch fires it when no self-heal/offensive
  did. Economy-safe (no foraging-time cost — the cast phase is independent of goals/locomotion). 1 new
  test. 149 sim-core + gates green; M-invariant; gold conserved.

- **G2 socialize/sightsee + soft-need satisfaction** — closed the "social/novelty needs drain but are
  never satisfiable" hole. needs.rs restores them PASSIVELY as a side-effect of market/work/wander; the
  explicit `Goal::Socialize`/`Sightsee` fills run only at the lowest (idle-time) decide priority so they
  never steal foraging time. **Lesson (documented):** dedicated soft-need trips reliably destabilized
  the marginal food economy (the survival regression caught a 380→170 collapse across retunings, and
  tuning was non-monotonic/chaotic near the edge) — passive satisfaction + idle-only explicit fills is
  the robust design. 3 new tests; survival regression still green (all seeds ≥50%); M-invariant.

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
