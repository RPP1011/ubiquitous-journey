# 23 — TS ⇄ Rust Parity Audit (exhaustive function map)

**Generated:** 2026-06-15, from an 8-agent fan-out inventory (7 TS areas + the Rust port).
**Bar:** behavioral parity — port every feature/function; the *only* sanctioned divergence is
determinism (per-entity RNG, fixed-point gold, inline tables vs JS `Map`s). NOT "spirit-only."

> ## 0.0 — REFRESHED SNAPSHOT (2026-06-15, later same day, post-audit commits)
> The inventory below (§0–§13) was taken **before** ~8 more commits landed. A 6-agent re-audit of the
> *current* tree corrected it. **What changed since the original count:** `signals.rs` (~23 of 57 fns),
> the RPG layer (`tags.rs` all 30, `rpgxp.rs`, `abilities.rs` — 12 catalog specs as data + 8/12 effect
> ops executable), `reason.rs` (3/9 schemas, 6/13 preds), the **ambitions** layer (`pick_ambition` +
> spawn-assignment + livelihood bias), **mood-coloured combat** (provoked fight-back), and the
> `protocol`+`server` crates (render-only wire format) are now present. The 8 **society systems**
> (seeding/lineage/houses/intrigue/patrician/watch/defenses/faith/expeditions/chronicle/groups) are
> ported as working **skeletons** (NOT independently confirmed at method-level parity — director itself
> is only 9/20 tropes, 0 arc steppers).
>
> **Current honest completeness ≈ 15–20% of behavioral parity by callable.** The deterministic
> tick-spine + a society skeleton are solid; the depth layers are still absent. **Biggest genuine gaps,
> in priority order:**
> 1. **Feature layer** — only 7 derivers (avenge/seek_fortune/grieve/defend/donate/repay/steal). Absent:
>    the **knowledge model** (observe/ask/study), **recruiter/warband**, **caution/experience**, **affect**
>    (free/wreck), apprentice, migrate, newsread, reciprocity, scout, subsistence, signalsFold.
> 2. **Steer-fill table** — 5 of ~23 fills (work/market/wander/flee/comfort). No socialize/court/sightsee/
>    shadow/hide/avoid/road/arbitrage/expedition/build/beg.
> 3. **Reputation** (player standing ledger) — entirely absent.
> 4. **News/economy depth** — arbitrage/bounties/reporter/gazette/econstats absent (need a multi-town +
>    gazette substrate the 1-town core lacks); market has no credit/tithe/favored-price/quality.
> 5. **combatEvents master fold** — strike/kill stamp only; no epithet/capture/witness-rep/loot/obituary.
> 6. **arcs SagaStore** + director breadth (11 missing tropes, 5 arc steppers, roles, caravans).
> 7. **construction / party / biography / walls / percept(scarecrow)** — entirely absent.
> 8. **Ability execution depth** — plant_belief/scry/trade_edge/craft_boost carried in IR but inert;
>    no cooldown ledger, no requirement gates, no procedural naming/generation.
>
> **Corrected stale claim:** the original §2 marked `_runMarket` absent — it is **present** (`market.rs`
> double-auction at belief-midpoint). The §0–§13 absence lists below are otherwise directionally right
> but **over-count absences** for the systems now landed (above).

**Legend:** ✅ ported (Rust equivalent exists) · 🟡 partial (a thin subset exists, most of the
function's behavior is missing) · ❌ absent (no Rust equivalent at all).

---

## 0. Executive summary

| Cluster | TS callables | ✅ | 🟡 | ❌ |
|---|---:|---:|---:|---:|
| Core sim spine (simulation/beliefs/mentalmap/percept/memory/world) | 136 | 0 | ~22 | ~114 |
| GOAP + goals (planner/motivation/arcs/signals) | 181 | 0 | ~14 | ~167 |
| Agent cognition (agent + agent/*) | 203 | 0 | ~18 | ~185 |
| Feature + reasoning layer (features/*, exec, experience, obligations, recipeKnow, schemas/*) | ~150 | 0 | 0 | ~150 |
| Director cluster (director + director/*) | 152 | ~6 | ~6 | ~140 |
| Economy + news (market/arbitrage/bounties/reporter/gazette/econstats/reputation/combatEvents/deedRouter/ai) | ~130 | 0 | ~7 | ~123 |
| Society + drama (seeding/lineage/houses/intrigue/patrician/watch/defenses/walls/faith/expeditions/chronicle/biography/groups/party/construction) | 239 | 0 | ~40 | ~199 |
| RPG (progression/classes/events/xpstats/abilities/*) | ~140 | ~12 | ~10 | ~118 |
| **TOTAL (approx.)** | **~1330** | **~18** | **~117** | **~1196** |

**Headline:** the Rust port is Waves 0–3 — the core tick loop (perceive/decide/locomotion/needs/
gossip/combat/market/progression) + a minimal society pass (lineage/faith/groups/quests/chronicle/
director). Everything is a *thin subset*; **no TS function is at full behavioral parity yet.** ~90%
of TS callables have no Rust counterpart at all.

**Whole subsystems entirely absent in Rust:** `arcs` (SagaStore), `signals` (all 60), the entire
`features/*` layer (urchin/affect/learning/recruiter/ledger/caution/apprentice/ambition_goals/alms/
migrate/subsistence/reciprocity/newsread/scout/sabotage), the `exec` registry, `experience`,
`obligations`, `recipeKnow`, the whole `schemas/*` reasoning layer, `abilities/*` (the ability DSL),
`reputation`, `combatEvents` (the master combat fold), `arbitrage`, `bounties`, `reporter`, `gazette`,
`econstats`, `deedRouter`, `seeding`, `houses`, `intrigue`, `patrician`, `watch`, `defenses`, `walls`,
`expeditions`, `biography`, `party`, `construction`, `mentalmap`, `percept`, `events` bus.

---

## 1. Dependency-ordered implementation waves (for step 5)

The missing functions are **not** independent — most features bolt onto substrate that doesn't exist.
Implementation must be sequenced; only items *within* a wave can fan out in parallel worktrees.

**Wave A — cognition substrate (keystone, mostly serial / 1–2 agents).** Everything below needs it.
- A1 `events` bus → already modeled as `Intent::Deed`; formalize a deed/event surface.
- A2 Persistent **goal-stack** (`agent.goals`, pushGoal/`_currentPlanStep`) + **plan cache** columns.
- A3 Full **memory** model: STM/MTM/LTM rings, `salient()`/`recent()`, consolidation, all Episode kinds.
- A4 Full **BeliefStore** fields: provenance/hops, suspicion, wealth-cue, sentiment, animacy, assoc,
  `plant`/`erase`/`garble`/`mergeFrom`/`inferDestination`; place-beliefs.
- A5 **MentalMap** (affordance-queried static places) + **percept** (scarecrow/disguise appearance).
- A6 The **exec registry** (EXECUTORS / DERIVERS / EFFECT_HOLDS / PLAN_OUTCOME) — the data-row seam
  every feature registers into.
- A7 The **resolver facade** (conserved world-mutation primitives: take/witnessDeed/deliverTo/
  marketClear/affect/makeOffer/teachRecipe/joinBand/say/publishDeed/solicitAlms/granaryDraw/buildSite).

**Wave B — the executor layer (fixes inert verbs; needs A6/A7).** gather/produce (fold NEW goods in —
*fixes the starvation gap*), give/pay (enables repay), consume, loot, the steer-fill table (23 fills).

**Wave C — full GOAP (needs A2/A6/B).** All 21 planner primitives + 13 atoms + the composers
(composeGold/composeNeed/composeForce) + satisfice/partial + `feltSurcharge` cost hook; full
`deriveGoals`/`pruneGoals`; ambitions; oaths; vendetta-hardening; the `goalX` factories.

**Wave D — feature-rows (fan-out friendly; each one file, needs C).** urchin · affect · learning +
recipeKnow · recruiter (+warband) · ledger + obligations · caution + experience · apprentice ·
ambition_goals · alms · migrate · subsistence · reciprocity · newsread · scout · sabotage.

**Wave E — reasoning layer (needs A4/A5).** schemas ir/vocab(16 preds/4 infers/6 resps)/interpreter/
catalogue(9 schemas).

**Wave F — RPG depth (needs A1).** abilities ir/catalog(12)/interpreter/effects(12 ops); classes
procedural naming + 3 missing templates; xpstats; events-bus consumers; `combatEvents` master fold;
`reputation`; `deedRouter`.

**Wave G — economy + news (needs B/A7).** market depth (credit/tithe/favored-price/quality/tatonnement);
arbitrage; bounties; reporter; gazette (template articles + dispatch mining); econstats; `ai/press`+`llm`
(browser-only — likely out of headless scope).

**Wave H — society + drama (fan-out friendly; needs A4/C).** seeding · houses · intrigue (disguise/
spies) · patrician · watch · defenses+walls (collision geometry) · expeditions · biography · party ·
construction (the build system) · the full director (24 tropes + 5 arc steppers + 6 role sets +
caravans + spotlight) · arcs (SagaStore) · signals (all 60).

---

## 2. Core sim spine

### simulation.ts (54) — orchestration + the resolver facade
🟡 **partial:** `update` (Rust `World::tick`), `_runMarket` (market.rs), `spawn`/`_spawnCamps`/
`_spawnCampMember`/`reinforceCamps` (Rust `spawn`/`spawn_agent`, no camps), `isHostile` (combat reads
belief flag, no reputation), `_reapCorpses`→partial (no heir escheat), `avgPrice` (no population avg),
`onCombatEvents`/`stampSlain`/`_sweepDeaths` (Rust stamps Slew in drain_intents, no full bridge).
❌ **absent (the resolver facade + bridges):** `busEmit`, `synthName`, `makePersonality`, `dispose`,
`_takeName`, `_spawnScarecrows`, `_mentalMap`, `_ctx`, `_arcPorts`, `_isRelevant` (LOD), `_cognitionCtx`,
`_cogResolver` and ALL its methods — `perceive`, `cast`, `castTarget`, `nearestVisibleOfFaction`,
`enemyNearLeader`, `warbandStrength`, `bandCombatState`(+`hpFracOf`), `seenPos`, `isLiveAgent`,
`marketClear`, `deliverTo`, `placeBenefitAt`, `granaryDraw`, `solicitAlms`, `take`, `witnessDeed`,
`publishDeed`, `say`, `affect`, `makeOffer`, `teachRecipe`, `joinBand`, `relocate`,
`buildSite.{resolve,woodOwed,feedWood,advance,pos,nearestWood}`; `addPlayer`, `playerStanding(+Label)`,
`factionStanding`, `_recordDeed`, `recordSuccoured`, `recordRelic`, `fighters`/`_perceivables`/
`spawnPercept`/`despawnPercept`.

### beliefs.ts (24) — the world-model
🟡 Rust `BeliefTable`/`PersonBelief`/`perceive::upsert`/`gossip::merge_belief` cover get/`_ensure`/
observe/decay/mergeFrom at a basic level.
❌ **absent:** `provenanceLabel`/`provenanceTag`, `garbleDeed`, `accrueSentiment`, `recordWealthCue`,
`vouch`, `recordAnimacy`, `recordAssocSighting`, `_evictIfFull` (Rust evicts by conf only),
`_carryDeed`, `mergePlaceFrom` (place beliefs), `_garble`, `plant` (deception!), `erase`,
`inferDestination`+`headingMatch` (ToM pursuit). Belief fields missing: suspicion, hops/provenance,
wealth/wealthConf, sentiment, animacyTally, assoc, intent, destPos.

### mentalmap.ts (14) — ❌ **entirely absent.** affordancesFor, Place(+affords), MentalMap.{build,
add,_addLandmarks,_addTowns,_addPOIs,known,nearest,dirTo,cost}, _d2. (Rust has flat POI work_sites only.)

### percept.ts (7) — ❌ **entirely absent.** PERCEPT_KIND, appearanceOf (disguise!), Scarecrow.{ctor,
isHitActive,torsoCenter,takeHit,update}.

### memory.ts (12) — 🟡 Rust `Memory`/`record`/`has` is a flat ring.
❌ **absent:** Ring abstraction, STM/MTM/LTM tiers, `tick`/`_consolidate`/`_fade` (consolidation),
`salient` (diversity-aware — the deriveGoals source!), `recent`, `memoryPhrase`.

### world.ts (25) — 🟡 POI registry partial. Rust has work_sites + market + base_price.
❌ **absent:** POI_KIND breadth (FIELD/FOREST/MINE/FORGE/REST/MEADOW/HUT/WELL), `_regionOf`/`_scatter`/
region-biased placement, `_buildTown` density, `randomSiteInRegion`/`randomSite*`, `nearest`(by kind),
all `make*` mesh builders (browser-only — out of headless scope).

---

## 3. GOAP + goals

### planner.ts (67) — 🟡 the backward-chainer exists; ~⅓ of the vocabulary.
✅/🟡 ported: `solveAtom`-equivalent (`solve`), `goto`/`gather`/`produce`/`buy`/`sell`/`attack` +
`approach` primitives, `believedPos`/`travelCost`/`atomHolds`/`believedPrice`-equiv, atoms
`at`/`have`/`gold_ge`/`dead`/`in_reach`, `plan` entry, `goalAvenge`/`goalSeekFortune` (in decide).
❌ **absent primitives:** `give`, `pay`, `consume`, `loot`, `shadow`, `burgle`, `rob`, `observe`,
`ask`, `study`, `hold`, `recruit`, `free`, `wreck` (14 of 21). ❌ **absent atoms:** `received`,
`know_assoc`, `know`, `need_ge`, `hold_until`, `force_ge`, `freed`, `wrecked`, `stealGold` (8 of 13).
❌ **absent machinery:** ACQUIRE table, `estimateHaul`/`haulSurcharge` (wealth-cue), the knowledge
model (`topicConfidence`/`knowsTopic`/`confidenceSurcharge`/`topicKey`), one-level Believes
(`recordBelieves`/`believesConf`/`complianceOf`), `composeGold`/`composeNeed`/`composeForce`,
`solveAll`/`initState`/`cloneState`/`applyEffect`/`applyStepsForward`/`atomSatisfied`/`effectAdvances`
(forward-state threading), `shortOrNull`/satisfice/partial/shortfall, `stepTargetPos`/`stepPrecondsHold`/
`stepEffectHolds`, the `goalX` factories (`goalAssault`/`goalSate`/`goalLearn`/`goalMuster`/`goalFree`/
`goalWreck`/`goalSteal`/`goalGrieve`/`goalDelve`/`goalRepay`).

### motivation.ts (34) — 🟡 minimal avenge/seek-fortune derivation lives in `decide::pick_avenge`.
❌ **absent:** the AMBITIONS catalogue (wealth/mastery/renown/wanderlust/belonging) + `assignAmbition`/
`updateAmbition`/`ambitionFavor`/`ambitionWantsFight`/`hasAggressiveGoal`/`pickAmbitionRival`/`snapshot`,
the OATH economy (`swearOath`/`resolveOath`/`oathMap`/forsworn scar/faithless), vendetta-hardening
(`bumpFriction`/`armAvenge`/`openVendettaArc`), `beliefAlive`/`believedBonded`, full `deriveGoals`
(repay/grieve/wary/glory/shun/delve/bloodshed/witnessed_death + npc-avenge), full `pruneGoals`
(closure memory + `awardGoalClosureXP` + oath resolve + arc close + `cautionWaste`), `dispositionGoal`,
`ambitionText`, `traceDerived`.

### arcs.ts (20) — ❌ **entirely absent.** `arcKey`, `SagaStore` + all 16 methods (openArc/appendRound/
appendBeat/touchArc/closeArc/_enforceMaxOpen/recentClosed/sweep/…). The emergent-saga registry.

### signals.ts (60) — ❌ **entirely absent.** All of it: `sampleGold`/`foldLoss`/`goldTrend`,
`noteSnub`/`snubsFelt`, `foldGoalDwell`/`goalDwellOf`/`goalDwellVector`, `foldDeed`/`deedCount`/
`deedLedger`, `foldOathSworn`/`foldOathPop`/`oaths`, `notePeaceBreak`/`peaceClock`, `foldScarcity`/
`scarcity`/`scarcityMean`, `foldGrievance`/`grievanceOf`/`isOneSided`, `esteemTruthGap`, `doomedVenture`,
`foldStreak`/`streakOf`, `foldPeril`/`perilsSurvived`, `firstDeedAt`, `debtBetween`, `wealthGini`,
`suspicionClimate`, `arcLoad`, `misallocatedSuspicion`, `sampleStanding`/`standingTrend`/
`fortuneReversals`, `sampleDisplacement`/`displacement`, `accrueBand`/`timeInBand`, `regardGap`,
`dependence`, `foldObligationDefault`/`defaultsOf`/`creditLoad`, `cohesion`, `groupCohesion`,
`presumedDead`, `loversCrossed`, `rumourDepth`, `noteBeat`/`quietIndex`, `noteWitness`/`witnessSet`,
`triangleHints`. (The narrative-signal catalog, doc 13.)

---

## 4. Agent cognition (agent + agent/*)

### agent.ts (58) — mostly thin delegators. 🟡 `drainNeeds` (needs.rs partial: decay+eat/rest, NO oath
economy/comfort caps/survival nibble), `pushGoal`/`_currentPlanStep` (no persistent stack in Rust),
`considerHostile`/`_nearestHostile` (combat.rs nearest_hostile). ❌ **absent:** `believedStrength`/
`ownStrength`/`believedForceRatio`/`strengthOf` (combat-strength reads — needed by decide/recruiter),
`_logStrike` (strike log for schemas), `homeBelief`, `totalWealth`, all trade methods (delegate to
trade.ts), ability methods (`grantAbility`/`abilityList`/…), all decor/visual.

### agent/perception.ts (6) — 🟡 `perceive` (Rust perceive.rs: sight→belief basic). ❌ **absent:**
disguise/animacy/threat/captivity/wealth cue extraction, `perceiveBuilding` (place beliefs + home),
`inferLostQuarries` (ToM pursuit intent), `bankDanger` (danger-spot memory), full `gossipBeliefs`
(snub/vouch/sentiment/price gossip — Rust merges beliefs + standing EMA only).

### agent/decide.ts (20) — 🟡 Rust `decide` is a flat priority ladder. ❌ **absent:** `scoreAndSelect`
(the utility oracle), `survivalMod`/`notorietyFear`/`quirkOf`/`quirkMul`/`recognizeWealth`/
`maybeElectDuel`, `topAmbitionGoal`/`ambitionDrive`, `pickSocialTarget`/`pickSuspectToAvoid`/
`nearestComfortSource`, the band-coordination cascade (`bandView`/`foeCap`/`breakOff`/`coordTarget`/
`decideParty`).

### agent/act.ts (49) — 🟡 on-arrival verbs split across needs/market/combat. ❌ **absent:** the whole
`registerExecutor` table (goto/attack/produce/consume/gather/buy/sell/give/pay/hold), `spyStep`,
`actControlled`, `produce`/`maybeRediscover`, `buildStep`, `combatStep` (active-perceive + ability
casting + combos), the entire **ability-casting layer** (`tryCastAbility`/`bestOffensiveAbility`/
`tryComboSetup`/`comboHold`/`tryBuffCast`/`trySelfCast`/`tryAllyCast`/`trySocialCast` + their `best*`
selectors), the **caution bookkeeping** (`cautionTouched`/`cautionPre`/`cautionPost`/`cautionEmit`/
`expectedYield`/`recordHaunt`), `marketStep`/`giveStep`/`payStep`.

### agent/steer.ts (33) — 🟡 Rust locomotion handles work/market/wander/flee/fight attractor+repulsor.
❌ **absent:** the `steer` field-composition primitive + the **STEER_FILLS table (23 fills)**:
fillMarket/Rest/Bounty/Arbitrage/Expedition/Caravan/Reporter/Sightsee/Work/Comfort/Socialize/SeekGlory/
Flee/Avoid/Hide/Shadow/Court/Follow/Protect/Migrate/Wander, + `withRoad`/`pursuitPos`/`hauntForce`/
`dangerForce`/`chooseWorkSite`/`chooseRefuge`/`resolveLeaderRef`/diurnal.

### agent/occupation.ts (8) — ❌ **absent.** `chooseOccupation` (margin×proximity×ambition×saturation),
`tradeMargin`/`masteryMul`/`tradeSkillShare`/`laborValue`/`strongestClassGood`. (Rust profession is
fixed at spawn.)

### agent/movement.ts (3) — 🟡 `goTo`/step (locomotion.rs). ❌ `_stepAlong` gate-funnel/barrier/wall+
city collision; `groundY` (browser).

### agent/trade.ts (17) — ❌ **absent.** `learnPrice`(✅ market.rs has it), `priceGossip`, `keepOf`/
`surplus`/`hasSurplus`, `wantQty`/`sellQty`/`speculativeWant`/`specHold`, `askPrice`/`bidPrice`/
`haggling`, `applyBuy`/`applySell`, `seedStash`, `tradeInputs`. (Rust market.rs has want_qty/sell_qty/
believed_price/learn_price minimal equivalents — 🟡.)

### agent/decor.ts (7) — ❌ browser-visual; out of headless scope.
### agent/select.ts (2) — ❌ `bestOption` (belief-weighted argmax — the selection primitive), `planarDist`.

---

## 5. Feature + reasoning layer — ❌ **entirely absent (the whole layer)**

- **exec/registry.ts (17):** registerExecutor/runExecutor/hasExecutor, registerDeriver/runDerivers,
  registerEffectHolds/effectHolds, registerPlanOutcome/runPlanOutcome + the 4 data tables. (A6.)
- **experience.ts (11):** the caution surcharge engine — write/decayed/recordBurn/recordWindfall/
  `feltSurcharge`/classifyYield/relevantConfidence/enforceMaxKeys/expKey.
- **obligations.ts (5):** key/triggerKey/addObligation/obligationsOf/settleObligations (the ledger).
- **recipeKnow.ts (4):** syncSet/recipeConf/learnRecipe/forgetTick (graded recipes).
- **schemas/ir.ts (8):** schema/validate/validatePred + PRED/INFER/RESP op whitelists.
- **schemas/vocab.ts (61):** 16 predicate builders+evaluators, 4 inference, 6 response, resolveSubj/
  cmpVal/nearKnownPos/nearAnyHostile/deedTagKinds/memEpisodes. (The reasoning vocabulary.)
- **schemas/interpreter.ts (8):** reason/fireOne/applyRespond/orderedCatalogue (the schema interpreter).
- **schemas/catalogue.ts (9 schemas):** flee-to-safety/intercept-fleer/go-to-ground/doubt-the-mask/
  flee-the-brawl/no-threat-no-response/rubberneck/raise-the-alarm/vulture.
- **features/* (16 files):** urchin (surveil/approach/burgle + steal deriver), affect (rob/free/wreck +
  rescue/gratitude derivers), learning (observe/ask/study + learn/forget derivers), recruiter (recruit
  + warmth/join/defection/muster derivers), ledger, caution, apprentice, ambition_goals, alms, migrate,
  subsistence, signalsFold, reciprocity, newsread, scout, sabotage. **10 EXECUTORS, ~18 DERIVERS, 2
  PLAN_OUTCOME.** (Wave D.)

---

## 6. Director cluster (director + director/*) — 152

✅/🟡 **ported (Rust director.rs):** `tick` (throttle+budget+pacing), `_raid`/`_spawnRaider` (do_raid),
`_townPop`, `_pace`/`_enterRelief`/`_inRelief` (inline), `_opportunity`/`_crisis`/`_spark` (do_opportunity/
do_crisis/do_feud — note Rust feud≈TS spark), `_townsfolkAlive`. **The Rust director has 4 tropes; TS
has 24.**
❌ **absent:** `_pruneRaiders`/`_despawn`/`_withdrawAll`, `_tropeNemesis`/`_tropeWar` (warlord/nemesis),
`_processFavoredFalls`, `_spotlight` (quiet-index casting), `_sour`/`_warm`/`_plant`/`_remember`/
`_shuffle`. **All 20 tropes.ts instigators** (reunion/unlikelyFriendship/falseWitness/favoredRise/
mistakenJealousy/betrayal/miserReformed/prodigalReturn/debtRepaid/mentorPride/spyUnmasked/tyrantMarket/
houseFeud/starCrossed/boastBackfires/rivalApprentices/feud/vendetta/prophet) + `_instigateTrope`
dispatcher. **All 5 arc steppers** (reckoning/tyrantFall/spyWeb/romance/accused) + `_advanceArcs`/
`_recordSaga`/`_arcFree`/`_seedSpyWebs`. **All role machinery** (bodyguard/duel/protégé/guardian/legend/
avenger: ~20 enlist/free/supervise/end). **Caravans** (`_tropeCaravan`/`_enlistEscort`/`_disbandEscorts`/
`_advanceCaravans`/`_caravanWindfall`).

---

## 7. Economy + news — ❌ mostly absent

- **market.ts (12):** 🟡 Rust market.rs has the double-auction + learn_price + want/sell qty. ❌
  `npcFavoredPrice` (standing-skewed clearing), `motiveTrust`, `toolQuality`/`stampQuality`,
  `extendsCredit`/`creditClear` (credit + deferred repay), `economicSlight`/`sour`, `titheGranary`,
  tatonnement.
- **arbitrage.ts (12):** ❌ entire (inter-town hauling off Gazette price reports).
- **bounties.ts (14):** ❌ entire (Gazette bounty labour market + `creditKill`).
- **reporter.ts (13):** ❌ entire (roaming gazetteer + wire desk).
- **gazette.ts (31):** ❌ entire (buildBrief/buildObituary/templateArticle + 8 kind renderers/
  gatherDispatches/Gazette store). (LLM enrichment `ai/press`+`ai/llm` = browser-only, out of scope.)
- **econstats.ts (9):** ❌ entire (economic telemetry).
- **reputation.ts (15):** ❌ entire (player standing ledger: witnessDeed/witnessForsworn/favoredPrice/
  decay/applyDeedTo/factionStanding).
- **combatEvents.ts (3):** 🟡 `onCombatEvents` (the master fold) — Rust stamps Slew only; ❌ grantEpithet,
  the full deed/XP/capture/vendetta-arc/belief/rep/loot/obituary/avenger/legend/caravan fold.
- **deedRouter.ts (2):** ❌ installDeedRouter/recordDeed.
- **ai/press.ts (8) + ai/llm.ts (11):** ❌ browser-only (fetch/localStorage) — out of headless scope.

---

## 8. Society + drama — 239

- **lineage.ts (26):** 🟡 Rust lineage.rs has births + dowry + tag inheritance + soft-cap. ❌
  `_courtship`/`_courtScore`/`_wed`/`_allyHouses` (marriage), `_apprenticeships`/`_teach`, `_surpass`/
  `_noteSurpass`, `_reconcileRivals`, `_feudGrudges`, `_blendPersonality`, `_fond`/`_safe`.
- **faith.ts (11):** 🟡 Rust faith.rs has bootstrap/spread/doubt + power. ❌ `_miracles` (heal/hearten
  flock), `anointProphet`, `_noteTier`, shrine amplification.
- **groups.ts (22):** 🟡 Rust groups.rs has formation + dissolution. ❌ `pickType`/GROUP_TYPES,
  `joinWarband` (recruiter follow-through), `_maybeRaiseHalls`/`_stampFinishedHalls` (guildhalls),
  `_handleDefection` (mutiny), `_touchLivingArcs` (saga), fellowship sagas.
- **chronicle.ts (24):** 🟡 Rust chronicle.rs logs death + class-up. ❌ BEAT table breadth, `_onEvent`/
  `_onKill`/`_onClassGained`/`_onLevel`/`_onWindfall` (bus routing), `_noteVendetta`, `_legendary`/
  `legends` (saga archive), `_legendName`, quiet-index stamping.
- **seeding.ts (16):** ❌ entire (seedNarratives/seedRivalApprentices/pin/forceBetrayal/falseWitness/
  starCross/captureTarget + makeTownsperson/seedProfile/grantSeededClass/armFromCatalog/bond).
- **houses.ts (8):** ❌ entire (assignHouse/founderHouse/brandForsworn/houseFeud set).
- **intrigue.ts (11):** ❌ entire (disguise/spies/assets: _assignSpies/_runSpy/_plantPriceTip/_cultivate/
  _runAsset/_unmask/_exposeAsset — the deception layer).
- **patrician.ts (8):** ❌ entire (peace-broker: _broker/_truce/_reconcile/_leakForsworn/_grudgeSalience).
- **watch.ts (15):** ❌ entire (Night Watch institution: muster/release/enlist/captaincy/threat).
- **defenses.ts (7) + walls.ts (12):** ❌ entire (watchtowers + town walls; collision geometry +
  gateWaypoint/collideWalls are headless-relevant, meshes browser-only).
- **expeditions.ts (22):** ❌ entire (dungeon-delving NPC parties: _maybeForm/_form/_descend/_advance/
  _advanceDelve/_endDelve/_forgeComrades/_loyalty/_foldExplore).
- **biography.ts (6):** ❌ entire (characterByname/characterClause/agentBiography/agentDrive + DRIVE).
- **party.ts (13):** ❌ entire (player companions: canRecruit/recruit/dismiss/prune).
- **construction.ts (38):** ❌ entire (the build system: qualifyHome/commission/commissionPublic/
  _makeSite/tick/_raidPass/_townLabour/_finalize/developHousing/_claimVacantHomes/displacement — the
  places-as-percepts spawner; the food-economy granary lives here too).

---

## 9. RPG

- **progression.ts (20):** 🟡 Rust progression.rs has onEvent-equiv (fold_deed)/match/grant/level/XP.
  ❌ `abilitySignature`/`_checkMilestones`/`_milestoneSpec`/`_grantAbility`/`grantEventAbility` (event
  abilities), `addNarrativeXP`, `_classTags`/`_dominantTags`, `topClasses`/`primaryClass`/`isReady`,
  catalog import.
- **classes.ts (25):** 🟡 Rust has 10 templates + match/score. ❌ 3 templates (duelist/speaker/mason —
  verify), `eventAffinity`, procedural naming (`PROC_ADJ`/`PROC_BASE`/`rankTags`/`proceduralName`/
  `proceduralKey`).
- **events.ts (8):** 🟡 modeled as `Intent::Deed`. ❌ the explicit EventBus (on/off/emit/clear) + makeEvent
  surface (needed by abilities/chronicle/econstats consumers).
- **xpstats.ts (6):** ❌ entire (XP telemetry).
- **abilities/ir.ts (17) + catalog.ts (16) + interpreter.ts (15) + effects.ts (20):** ❌ **the entire
  ability DSL** — EFFECT_OPS/spec/validate, the 12 authored specs + CLASS_MILESTONES, castSpec/
  resolveTargets/requirementsMet, the 12 EFFECTS ops (damage/heal/stun/slow/knockback/dash/shield/
  expose/plant_belief/scry/trade_edge/craft_boost). Player ability keys 1-4.

---

## 10. Out-of-scope for the headless Rust backend (by design, doc 22)

Browser/render/LLM-only — **not** parity gaps for the sim core: all `make*` mesh builders (world.ts,
walls.ts, defenses.ts, construction `_attachMesh`/`_build1`), `agent/decor.ts`, `groundY` visuals,
`ai/press.ts` + `ai/llm.ts` (fetch/localStorage), the Gazette LLM *enrichment* path (the *template*
articles ARE in scope). These should be served by the doc-20 render-only frontend, not ported to Rust.

---

## 12. Verification corrections (5-agent double-check pass)

Five agents re-checked §2–§10 against source. Corrections folded in:

**Mis-tags fixed:**
- §2 `_reapCorpses` and `avgPrice`: 🟡 → **❌ absent** (no corpse reap / heir escheat / population-avg
  price in Rust at all).
- §4 `act.ts` produce/gather: ❌ → **🟡** — the executor-registry seam is absent, but the produce/gather
  *behavior* exists at `market.rs:96–115` (own-site production) + `planner.rs:234–249` (Gather/Produce
  compiled to Work). This is what falsifies the old §11 starvation headline (now corrected).
- §4 `decide.ts`: "flat priority ladder" → **"priority ladder with two GOAP-planned rungs"** (avenge +
  seek-fortune call `plan()` at `decide.rs:114–119,146–151`).
- §8 `lineage.ts`: Rust ALSO ports **house inheritance** (`lineage.rs:161`) and `_fond` (as
  `fond_toward`, `lineage.rs:66`). Only `_safe` (danger-range birth gate) is genuinely absent.
- §9 `classes.ts`: the 3 templates Rust is missing are **brawler / duelist / trickster** — NOT
  duelist/speaker/mason (Rust HAS mason key 6 + speaker key 7). Rust template reqs are also the
  disclosed "single dominant req" simplification, not 1:1 (e.g. hunter scores MELEE not FORAGE).
- §9 abilities file list omits a 5th file, **`abilities/generate.ts`** (doc-16 procedural generator).
- §3 `signals.ts` is **57** `export function`s (not 60).

**§13 — 17 sim-backend modules the inventory MISSED entirely** (all ❌ absent in Rust; add to the waves):

*Doc-17 (primitive, motivation) + Theory-of-Mind cluster — a whole layer (→ Wave C/D):*
`motivation/registry.ts` (motivations-as-data substrate), `motivation/infer.ts` (ToM "why did they do
that"), `motivation/arbitrate.ts` (**the data-table decide() scorer = the `scoreAndSelect` "utility
oracle" §4 names but never sources**), `motives/acquire.ts`, `motives/speech.ts`, `motives/combat.ts`,
`motives/index.ts`.

*City / spatial founding (headless-relevant, → Wave H):* `cities.ts` (town→tile-fabric), `surveyor.ts`
(plot planning), `roads.ts` (inter-town road graph — `steer.withRoad` reads it), `migration.ts`
(truth-side emigration valve, distinct from `features/migrate.ts`).

*Observer / diagnostic (headless, some with own test suites → Wave A/H):* `coordination.ts` (the
believed-capability layer behind the `decideParty` cascade), `statusSensor.ts` (doc-12 §5 fall-from-grace
sensor), `trace.ts` (per-agent reasoning-trace ring), `depthMetrics.ts` (emergence metrics).

*RPG substrate (→ Wave F prereqs):* `rpg/tags.ts` (**the behavior-tag vocabulary + FNV hash every
ActionEvent + class-match depends on — a keystone, must precede Wave F**), `rpg/xp.ts` (pure XP/level
math).

**Wave-ordering fixes:**
- `signalsFold` (Wave D) imports `foldStreak`/`foldPeril` from `signals.ts` (Wave H) — a forward
  inversion. Hoist the *fold* subset of `signals.ts` into substrate before Wave D (or run signalsFold
  with Wave H).
- `rpg/tags.ts` is an unscheduled **Wave-F prerequisite** — schedule it ahead of progression/abilities.
- Verified sound: Wave D → exec registry (A6); Wave E → MentalMap (A5); `arcs.ts` (SagaStore) vs
  `director/arcs.ts` (steppers) are correctly distinct.

**Net:** the audit's structure and the ~90%-absent headline stand; the corrected total is **~1330 + 17
missed modules**, and the single most important factual fix is that **production is not missing — it's
just not a first-class executor, and long-run town survival is a tuning question.**

---

## 11. Bottom line

Full behavioral parity ≈ **porting the rest of the game** (~1330 catalogued + ~17 missed modules, §12).
It is a multi-wave effort (§1). **Correction (post-verification):** an earlier draft claimed the Rust
town "starves to extinction because no verb folds new goods in." That is **false** — `market.rs:96–115`
already mints new goods each tick (a worker at its own site bumps `inventory[good]`, cap 64; goods are
intentionally not gold-conserved). The real gap is narrower: production is a **hardcoded proximity
side-effect inside the market system, not a first-class GOAP `gather`/`produce` executor**. Whether the
long-run town is self-sustaining is then a **tuning/balance** question (drain vs. PRODUCE_CAP vs. how
often agents reach a work site and eat), not a missing mechanism — though the director soak still
depopulated by ~tick 1500, so the balance does need investigation.
