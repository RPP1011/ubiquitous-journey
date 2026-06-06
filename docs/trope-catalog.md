# Trope Catalog — Widening the Director's Dramatic-Situation Map

## The model

A **trope** is a small machine the Director runs against the *living* simulation:

> **precondition SCAN** over current agents/beliefs/houses → a **SPARK** (belief plant, memory record, faction/house flag, or controlled spawn) injected into systems that already exist → an **emergent arc** the chronicle/gazette narrates.

The Director never scripts the outcome. It seeds a tension and lets `perceive → beliefs.decay → gossipBeliefs → decide → market → progression → quests` carry it. Today the engine ships **7** tropes (`director.js` `_instigateTrope` / `_trope*`), all in the CONFLICT/VENGEANCE corner: `rivalApprentices`, `feud` (+House feud), `vendetta`, `prophet`, `nemesis`, `war`, `caravanRaid`. This catalog widens the roster across the whole map of dramatic situations (cf. Polti's 36).

## The six constraints (every entry obeys them)

1. **Epistemic split** — sparks write *beliefs*, never ground truth. An agent can be genuinely fooled (planted rumour, disguise, false standing) while combat/movement/`isHostile` still resolve on true faction.
2. **Freeze-safe** — sparks are bounded, guarded writes (belief/memory/flag). No throws inside the fixed tick, no async/IO, no wall-clock dependence. Professionless agents (monsters/player) are never assumed to have inventory/economy.
3. **Closed money loop** — no gold minting. Gifts/tithes/dowries are `give`/`pay` transfers; loot transfers a real purse.
4. **Anti-extinction** — no trope mandates a death. Deaths remain combat-emergent; population-floor mercy rules still apply.
5. **Deterministic** — pure scan + bounded spark; safe to re-run each (throttled) pass; idempotent via per-pair/per-agent flags.
6. **Player-agnostic** — sparks target autonomous townsfolk and never assume `sim.player`. If the player happens to be a participant, beliefs about them flow normally.

## Cost tiers

- **cheap** — reuses existing systems wholesale; spark is one or two belief/memory writes.
- **moderate** — a small new field/flag or goal-derivation extension; otherwise existing systems.
- **expensive** — multi-stage choreography, new spawn paths, or several coordinated subsystems.

Expressibility is **now** (buildable on current substrate) or **needs-behavior** (requires a named new verb/field first).

---

## LOVE & ROMANCE

**Courtship Rivalry (the love triangle)** — *Two suitors vie for one beloved; the jilted rival must accept or escalate.* Seed a fond trio, inject a third suitor whose standing toward the beloved exceeds the first's.
SCAN: unattached trio A(beloved)/B/C in proximity; A fond toward both B and C; B believes it holds A's highest affection (standing>0.3 toward A); fire when C's standing toward A > B's and B/C are mutually aware.
SPARK: lower B→A standing −0.1, latch B→C suspicion +0.3 ("C is courting A") as half-true rumour (no hostile yet); record B bond memory rel='courtship_rival' valence −0.3.
GROWS INTO: B escalates (sabotage/feud) or accepts (avoids A, reconciles); lineage marries A to whoever holds her highest affection — wedding, jilted-lover vendetta, or quiet heartbreak in LTM.
REUSES: beliefs.mergeFrom; lineage._courtship; groups.pickType; combatEvents.onCombatEvents; memory.record + motivation.deriveGoals; director._sour.
TIER: moderate · **now**.
RISKS: jealousy is planted belief (B genuinely fooled until it witnesses A+C); idempotent re-fire; no mint; no mandated death.

**Mistaken Jealousy (false betrayal)** — *A lover believes a false rumour that their mate betrayed them.* Plant a low-confidence false hostile in a fond couple via a motivated third party.
SCAN: stable couple A/B (mateId or hearth band), A→B standing ≥0.5; a third party X with motive to separate them exists.
SPARK: `beliefs.plant(A,{subject:B, hostile:true, confidence:0.3, suspicion:0.4})` ("B is unfaithful/in league with bandits"); record A betrayal memory withId=B valence −0.7.
GROWS INTO: A avoids B (gossip skips hostiles); decay heals it, or a witness vouches for B (contrary high-confidence belief overwrites the lie) → regretful reunion; if A drops below −0.6 it latches hostile → avenge → tragic split.
REUSES: beliefs.plant/decay/mergeFrom; reputation.witnessDeed; memory + motivation; patrician brokering; intrigue._runSpy/_unmask.
TIER: moderate · **now**.
RISKS: B's innocence untouched (epistemic split); belief decays unless reinforced; no mint; works if player is A or B.

**Forbidden Love (faction rift)** — *Lovers across hostile factions/feuding houses; their bond invites retaliation.* A spy-lover unmasked, or two feuding-house lovers whose marriage heals the feud.
SCAN: fond pair A(townsfolk)/B(spy, disguiseFaction=townsfolk, true faction enemy), OR A/C in feuding houses (areHousesFeuding), both ≥ LINEAGE.pairStanding, unmarried.
SPARK: spy path — plant suspicion 0.5 in A's allies, low-confidence spy rumour, then `_unmask(B)` so A witnesses the true faction; record forbidden_love memory valence −0.5 on both. Feud path — let lineage pair them; `_wed` calls `_allyHouses` to heal.
GROWS INTO: unmasked → A chooses defection (belong-goal toward B's faction) or rejection (betrayal→avenge); feuding-house wedding heals the feud (legendary union).
REUSES: beliefs.plant; intrigue._unmask; lineage._courtship/_wed/_allyHouses; houses.areHousesFeuding/endHouseFeud; memory + motivation; groups._form; combatEvents.grantEpithet (traitor).
TIER: expensive · **now**.
RISKS: forbiddenness is political fact, not a lie; unmask guarded; defection is faction shift not gold; player reputation engaged if involved.

**Widowhood & Remarriage (the second chance)** — *A widow rebuilds; the town watches if the new mate honors the old love.* After a cooling period a widow forms a new fond bond; children may approve or resent.
SCAN: A with cleared mateId + a mate_death/witnessed_death LTM episode; A→B standing ≥0.5 mutual, B ≠ old mate; higher salience if A's children by the old mate live.
SPARK: record widowhood memory withId=old_mate rel='lost_love' valence −0.6 and second_chance withId=B valence +0.4; warm B→children +0.2; gossip "A is moving on"; seed accept/reject ambition in living children.
GROWS INTO: courtship→remarriage; children accept (warm to B) or fracture the household; A's LTM holds both the death and the new love — bittersweet biography.
REUSES: lineage._wed/_allyHouses; memory + motivation; groups._form; beliefs.mergeFrom/_ensure; combatEvents (kin vendetta if B mistreats A); patrician.
TIER: moderate · **now**.
RISKS: dowry from real purse (no mint); about continuation not loss; town's "moving on" belief is a true reading; player as A or child sees it organically.

**Arranged vs. Chosen (the marriage pact)** — *A political match collides with one party's true affection.* Arrange A/B while A is fond of C; duty vs. desire.
SCAN: unattached A/B from compatible houses/trades; A fond toward third agent C (≥ pairStanding); B fond of A but A not fond of B; A/B houses share political/economic synergy.
SPARK: make social pressure explicit (belief the marriage is "expected"); A→C −0.1 ("we can't be"), B→A −0.2; record arranged_marriage duty_bond valence −0.1 on both; if houses feud, the match could heal it.
GROWS INTO: ACCEPT (duty marriage that may warm), ELOPE with C (standing loss, scandal), or COMPROMISE (secret affair → love triangle). Memory records duty/sacrifice/scandal.
REUSES: lineage._courtship/_allyHouses; memory + motivation (grieve/belong/repay); beliefs.plant/mergeFrom; groups; reputation.
TIER: expensive · **now**.
RISKS: pressure is ground truth, preference is belief (A may be deceived about C); choice is emergent not forced; dowry transfers only; player gets a dialogue choice.

**The Jilted Lover (spurned & vengeful)** — *A rejected suitor refuses the loss and escalates.* High past affinity, current rejection → obsession.
SCAN: A with high past standing toward B (memory shows fondness); B→A now low or B newly paired to C; A has a rejection/betrayal LTM.
SPARK: record jilted memory withId=B rel='spurned' valence −0.8; A→B to −0.4, optionally A→C −0.5; seed reconcile/avenge goal; record jealousy memory.
GROWS INTO: gifts/threats/gossip-isolation/violence biased by personality; attacking C backfires (witnesses latch A hostile, B sours further). Closes in acceptance (grieve), escalation (dangerous reputation), or rare win-back.
REUSES: memory.record; **motivation.deriveGoals must learn 'jilted'/'rejection' → reconcile/avenge**; beliefs.mergeFrom; act giveStep; combatEvents; groups; reputation; patrician truce.
TIER: expensive · **needs-behavior** (extend deriveGoals to read jilted/rejection memories).
RISKS: obsession is genuine memory-driven state; gifts are transfers; sabotage is gossip/reputation only (no steal verb); no mandated death; player as B/C gets "warn off A".

**Elopement (love defies duty)** — *Forbidden lovers flee together, abandoning home.* Fond pair under an unmarriageable conflict become a wandering band.
SCAN: fond mutual A/B with a marriage-blocking conflict (spy mismatch, feuding house, lost companion); both can survive outdoors; low standing in home faction (less to lose).
SPARK: record impossible_love elopement_bond valence +0.6 on both; push 'flee_together'/wanderlust goal; form warband on A/B; chronicle BEAT.ROMANCE departure; drop town anchor (leashless).
GROWS INTO: wandering band of two; families grieve; town may mount a pursuit (player quest); over time forgotten, or one falls in the wilds (survivor grieves), or they settle — tragedy or bittersweet survival.
REUSES: lineage._wed; groups/expeditions warband; memory; **motivation must seed wanderlust/belong_to_mate**; beliefs.mergeFrom; director pursuit-goal; combatEvents; reputation.
TIER: expensive · **needs-behavior** (elopement→wanderlust goal; optional pursuit goal).
RISKS: love is ground truth, decision is emergent; no mint; success is survival not death; player choice via dialogue.

**Love & Honor (jealousy over reputation)** — *A devoted suitor must decide whether to stand by a disgraced beloved at cost to their own standing.*
SCAN: A→B standing ≥0.3 while count(C: C→B standing < −0.3) > 5 (town dislikes B); A's average town standing > 0 (A respected).
SPARK: gossip-merge a "B is a bad influence" low-confidence rumour into A (rejectable); record honor_test withId=B rel='love_over_reputation' valence +0.5; A's town standing −0.15 (association cost).
GROWS INTO: A defends B (A's faction standing slowly drops, B's rises if A is believed; loyalty memory deepens bond) or abandons B (A recovers, B isolates, B records betrayal). LTM holds "stood by B" (TRIUMPH) vs "chose reputation" (SHAME).
REUSES: reputation.witnessDeed; beliefs.mergeFrom; memory; combatEvents (shared glory validates defense); groups (band rebuilds B's standing); motivation (loyalty/repay or grieve).
TIER: moderate · **now**.
RISKS: A's belief in B may be true or deceived; deltas bounded/decay-safe; no mint; costs standing not life.

---

## AMBITION & THE FALL

**The Favored Rise** — *An upstart wins a reputation windfall and acts entitled until standing decays.* Plant a false standing-spike, watch the inevitable crash.
SCAN: townsfolk standing <0.3 (socially invisible) + ambition in {wealth,mastery,renown}; gossip footprint >2; fresh reputation bump (combat win/quest). Spark on the 2nd/3rd strongest gossip contact.
SPARK: `beliefs.plant(target,{standing:+0.4,confidence:0.7,hostile:false})` on each close gossip-partner. Target reads inflated opinion and over-demands.
GROWS INTO: standing decays; the agent is refused credit/recruitment; the fall sharpens; if the player helped them climb, they may blame the player (invert standing hostile).
REUSES: beliefs.plant; gossipBeliefs; reputation.witnessDeed + dialogue standing read; ambitionFavor; chooseOccupation.
TIER: moderate · **now**.
RISKS: lie is belief-only (combat reads true faction); no mint; the fall doesn't kill; targets an NPC pair.

**The Tyrant's Market** — *A high-standing producer abuses reputation, gouging the poor.* Latch hostility + spike price-beliefs + plant a gouging rumour.
SCAN: producer of a staple (food/ore/wood); standing >0.5 with ≥3 observers; same town; no competing renown/wanderlust pull.
SPARK: latch hostile on tyrant + customer kin; `director._sour` all customers; `plant({standing:−0.3,suspicion:0.6})` framing greed in nearby townsfolk.
GROWS INTO: market avoids the tyrant; scarcity + arbitrage build; a rival floods supply; ambition stalls; forgiveness (lower prices) or nemesis-tier antagonist.
REUSES: beliefs.plant; director._sour; houses.setHouseFeud; priceBeliefs; chooseOccupation; market clearing; arbitrage.
TIER: expensive · **now**.
RISKS: gold unchanged until real trades; honest-transaction checks read true standing; shunned not killed; deterministic.

**The Usurper** — *An apprentice rises faster than the master and contests their standing.* Plant a solo-kill rumour crediting the apprentice; latch mutual rivalry; sour the master.
SCAN: master (level ≥ masterMinLevel) + apprentice in proximity; apprentice within 0.15 standing of master; no surpass-triumph yet; ambition renown/mastery.
SPARK: plant a witnessed-death-style deed crediting the apprentice into shared observers; set mutual rivalId; `director._sour(master, shared allies, −0.15)`.
GROWS INTO: apprentice surpasses master (lineage._surpass / standing inversion); master accepts, fights (vendetta), or withdraws; House ripples to children's baselines.
REUSES: beliefs.plant; lineage.masterId/_surpass; director rivalId; director._sour; gossipBeliefs; ambitionFavor.
TIER: expensive · **now**.
RISKS: belief writes + flag sets only; no mint; rumour false, combat true; master socially-dies but recovers.

**The Reformer's Corruption** — *A genuinely-loved leader corrupts as they consolidate power, oblivious behind a warm inner circle.* Engineer a delusional gulf.
SCAN: agent with faith != null; standing >0.5 with ≥5 observers; no House feud; personality.altruism <0.7.
SPARK: plant `{standing:−0.3,suspicion:0.5,confidence:0.5}` (unfair tithes) into the OUTER town; `director._sour(prophet, non-inner-circle, −0.2)`; keep inner-circle beliefs warm so the leader still believes itself universally loved.
GROWS INTO: flock shrinks, tithe income dries; escalating demands on loyalists; splinter prophet or hostile latch + exile; redemption, full fall, or isolationist cult.
REUSES: beliefs.plant; faith._spread/anointProphet; gossipBeliefs; act give/pay (tithes); reputation.witnessDeed; director._sour.
TIER: expensive · **now**.
RISKS: corruption is planted in outer circle only (true gulf); tithes are transfers; exiled not killed; deterministic.

**The Overreacher** — *An ambitious NPC over-commits beyond their means and falls.* Bait with a too-good opportunity.
SCAN: ambition.progress >0.6 but gold < wealthTarget×0.4 OR level < masteryLevel×0.4; no aggressive goal; risk_tolerance >0.6; no recent failure memory.
SPARK: `priceBeliefs[rare] *= 1.8` + plant a high-value monster bounty belief; inject a DEFEAT goal at priority 0.8.
GROWS INTO: reckless pursuit (wanders far, fights above weight, takes on debt); fails/dies; ambition resets, lenders sour, creditor vendetta; humility, desperation/crime, or flight.
REUSES: priceBeliefs; goals/planner; ambition.progress; beliefs.plant; reputation.witnessDeed; give/pay (debt).
TIER: moderate · **now**.
RISKS: debt internalized in belief/goal layer (transfers only); false confidence vs true level; death emergent not forced; deterministic.

**The Rival's Sabotage** — *Two niche-competitors undermine each other via rumour, not blades.* Plant mutual suspicion.
SCAN: two NPCs <25 units apart; same ambition.kind; same trade good OR same masterId OR same romantic target; not already feuding (standing not < −0.35).
SPARK: `plant(rival,{standing:−0.25,suspicion:0.7,confidence:0.55})` ("they're out to get you") in each; optionally plant a false shared-vendor theft into neutral observers.
GROWS INTO: parallel strategies (out-produce / poach allies); glutted-good price pressure; wild standing swings; one abandons niche, they reconcile, or open vendetta; player ally forces a choice.
REUSES: beliefs.plant; dialogue persuade; chooseOccupation; gossipBeliefs; ambitionFavor; patrician._reconcile.
TIER: moderate · **now**.
RISKS: rumours are belief-only; market pressure emergent (no mint); ground-truth deeds untouched; reconciliation/niche-switch off-ramps; deterministic.

**The Phoenix** — *A shattered ambitious soul renounces grand aims for quiet ones and finds peace.* Reframe after catastrophic failure.
SCAN: recent failure memory (failed_goal or combat defeat); ambition.progress reset/low; standing <0 with 2+ observers; no active vendetta/avenge; altruism >0.5 OR social_drive >0.5.
SPARK: `plant(humble_figure,{standing:+0.65,confidence:0.7,source:WITNESSED})`; inject DEVOTION/BELONGING goal; `assignAmbition` with 'avoid original kind' (humbled pool: mastery/belonging).
GROWS INTO: rebuilds a quieter identity — craft focus, courtship/family, mentoring a younger NPC; standing heals via quiet deeds; redemptive unless isolated/punished.
REUSES: beliefs.plant; goals/planner; assignAmbition(avoid); lineage._teach/_wed; reputation.witnessDeed.
TIER: moderate · **now**.
RISKS: admiration is the agent's conscious reframe (not deception-planted); less wealth is emergent; survives and thrives; deterministic.

**The Hedge-Lord** — *A mediocre NPC seizes a crisis-vacuum, then clings to power past reason.* Petty tyranny born of opportunity.
SCAN: active CRISIS; standing 0.1–0.4, isolated (few strong bonds); ambition wealth/mastery; no leadership role; near crisis site.
SPARK: `plant(self,{standing:+0.5,confidence:0.6})` (false self-importance); inject a LEAD goal (band-follow flags) to gather a crew; latch follower standing into a mini-faction.
GROWS INTO: crisis resolves but demands persist; town leaders/Watch challenge the illegitimate authority; graceful demotion, bitter hostility, or stubborn obstacle — fall sharper because there was never real authority.
REUSES: beliefs.plant; director._sour; goals/planner; give/pay (tithes); reputation.witnessDeed; gossipBeliefs; expeditions warband band-follow.
TIER: moderate · **needs-behavior** (**LEAD**: agent organizes 3–6 NPCs for a shared task for a fixed duration via reused party band-follow flags + bandLeaderId; data-only, freeze/money/epistemic-safe).
RISKS: false self-confidence is belief-only; tithes are transfers; never forced to death; deterministic.

---

## MYSTERY, SECRETS & IDENTITY

**The Unrecognized Heir** — *A foundling is revealed to share kin with an NPC, re-sorting bonds and debts.* Plant a kinship belief, then late-bind the real kinIds link.
SCAN: young (level<3) orphan A (no mateId, no living kinIds, no house); agent B who shares a multi-gen house or witnessed A's parent fall; gossip has mentioned the parent to A.
SPARK: plant A→B suspicion "you seem familiar"; if B's dead parent is A's, boost A's reputation-standing toward B; next tick manifest the kinIds link (so memory chains/avenge work); chronicle the discovery.
GROWS INTO: A investigates B in dialogue; inherits the dead parent's feud (rivalId) and house; allies (marriage heals an old House feud) or rivals (avenge a still-living killer).
REUSES: beliefs.plant; lineage kinIds + inherited rivalId/feud machinery; combatEvents kin-avenge; motivation.deriveGoals; houses.setHouseFeud; dialogue._doCheck.
TIER: moderate · **now**.
RISKS: inject kinIds BEFORE memory reads it (guard all writes); standing boost on a non-real-kin orphan is epistemic deception that flips on truth-surface; gate inherited feuds to living representatives only.

**The Spy Unmasked** — *A trusted neighbour is revealed a spy; standing shatters into collective betrayal.* Trigger `_unmask` explicitly off rising suspicion.
SCAN: spy S with disguiseFaction != null; observer O near S with a not-yet-hostile belief; O's suspicion rising; S has planted ≥N rumours (intrigue.stats.plants ≥ threshold).
SPARK: emit "close call" memories to nearby townsfolk; when any suspicion crosses 0.6, `_unmask(S)` — drop disguiseFaction, latch hostile in all townsfolk, chronicle "a trusted neighbour was a spy".
GROWS INTO: S hunted/flees; the planted feuds DON'T auto-resolve (collateral innocents stay hostile) → patrician or player-dialogue reconciliation arc.
REUSES: intrigue._unmask; beliefs.plant; combatEvents watch rally; patrician._reconcile; dialogue._doCheck.
TIER: moderate · **now**.
RISKS: unmask is permanent (ensure rescue or fast death); patrol reconcile so collateral feuds get repaired; kill spy before feuds metastasize.

**The Returning Ghost** — *A townsperson believed dead returns, poisoning loyalties built on a false-death rumour.* Seed a false witnessed_death while X is away.
SCAN: X far away (active expedition or pos > leashR×2); bystander W with a faded belief about X (confidence <0.3); avenger A with a low-byId witnessed_death memory of X + latched hostile + avenge goal.
SPARK: plant a vague "death" belief in W; W gossips it at RUMOR conf; A derives avenge(killer,X); standing toward the "killer" crashes; record A's false witnessed_death (salience 0.7+); chronicle "word has come that X fell".
GROWS INTO: X returns, perception flips to alive, but A's avenge goal is locked → X warms A via dialogue/give, A confronts the false killer, or patrician brokers; goal expires when X is proven alive.
REUSES: beliefs.plant; perception.perceive; memory.record; motivation.deriveGoals; expeditions._end/_restore; dialogue._doCheck; patrician._reconcile.
TIER: moderate · **now**.
RISKS: only fire if X is genuinely away (no spoof); set goal.expiresAt so stale ghosts time out; slow standing repair so disbelief matters.

**The Changeling Secret** — *A born townsperson harbors a hidden identity/deed that, exposed, re-sorts loyalty.*
SCAN: townsperson A with house + standing>0 with 2+ neighbors; gossip-reachable; a candidate secret (bandit-aligned master / exposable weakness / conflicting faith).
SPARK: pick a secret; plant high suspicion (0.4+, RUMOR) in B near A; B gossips capped at 0.5; suspicion rises; at 0.6+ A's standing with gossipers drops; chronicle "whispers about A have begun".
GROWS INTO: A is suspected → confess (needs verb) for early repair, deny (suspicion fades), spread (standing crash), or rivals exploit it; owns the secret or is exposed but scandal clears as newer gossip replaces it.
REUSES: beliefs suspicion field; gossipBeliefs; dialogue._doCheck; memory.record; reputation; motivation (grieve).
TIER: moderate · **needs-behavior** (**CONFESS**: dialogue action revealing a self-secret to a high-standing listener — success = reconciliation bond, failure = standing floor; once per secret).
RISKS: without CONFESS the early-repair branch is lost; scale gossip decay so a single plant can't paranoid the whole town; secrets must be NPC-internal, never expose real player deceptions.

**The Rival's Mirror** — *Two bitter rivals discover shared kin, flipping rivalry to kinship or deeper feud.* Only fire on a real shared ancestor.
SCAN: R1.rivalId===R2.id (mutual latched hostile, both standing < −0.5); both townsfolk; a real shared dead parent (kinIds backward search) OR overlapping witnessed_death memory of the same fallen agent.
SPARK: plant R1 kinship suspicion ("R2 is my sibling", conf 0.5); record R1 bond memory "discovered kin"; R1 shares it in gossip/dialogue; R2's confidence jumps; lineage._reconcileRivals fires (or a confrontation).
GROWS INTO: immediate reconciliation (rivalId cleared, +0.4 standing, children no longer auto-feud); reluctant partnership; or deeper feud if the revelation surfaces favoritism (−0.8).
REUSES: beliefs.plant; lineage kinIds; gossipBeliefs; memory.record; lineage._reconcileRivals; dialogue._doCheck; combatEvents rally.
TIER: expensive · **now**.
RISKS: never plant fake kinship (only real shared ancestor); reconciliation irreversible (one revelation per pair, no flapping); coordinate shared avenge goal if the shared parent's killer lives.

**The False Prophet Exposed** — *A rising prophet is revealed a charlatan/infiltrator, triggering a crisis of faith.*
SCAN: prophet P (faith != null, anointed flag); flock ≥3 follow P's creed; observer O near P (<20) with a high-salience counter-memory; O→P confidence <0.5.
SPARK: plant high suspicion + low hostile ("prophet is a fraud", suspicion 0.7, RUMOR conf) in O; O gossips; faith._doubt triggers (flock loses 0.1 faith per high-suspicion observation); chronicle "doubts cloud the faith".
GROWS INTO: flock fractures (god weakens); P doubles down or is confronted; if a spy, climactic dual exposure; rival prophet rises; true god reasserted or flock splinters.
REUSES: beliefs.plant; gossipBeliefs; faith._doubt/anointProphet; dialogue._doCheck; intrigue._unmask; motivation (grieve).
TIER: expensive · **now**.
RISKS: bridge beliefs.suspicion → faith._doubt (separate stores); require sustained suspicion (no flip on one doubt); spy exposure ≠ faith crisis (plant prophecy-fraud too for a compound scandal).

**The Hidden Heir** — *A low-status townsperson is revealed to carry a House line, gaining standing, feuds, and dynasty stakes.*
SCAN: townsperson A with null/false house; a dead/distant founder F whose kinIds point to A (or A's parent/grandparent memory of F); a credible knower M (patrician/master/elder).
SPARK: plant high-confidence belief in M "A is heir to House F"; M tells A in dialogue; `assignHouse(A,F)` (name rewrite); inherit the feud (latch hostile to enemy house); house members warm +0.15; chronicle the revelation.
GROWS INTO: A embraces (allies + grudges), denies (house picks another heir), must resolve the feud (marry/reconcile/avenge), or unrecognized-heir kin surface; becomes a leader or sparks a civil war.
REUSES: beliefs.plant; houses.assignHouse; lineage kinIds + feudingHouseOf; dialogue._doCheck; reputation; motivation (belong/politics); patrician; combatEvents rally.
TIER: expensive · **now**.
RISKS: house assignment immutable (verify kinIds first, idempotent one-heir); inherited feud irreversible; only awaken against a living enemy line (`feudingHouseOf != null`).

---

## JUSTICE, CRIME & ACCUSATION

**The Framed Innocent** — *An innocent is believed guilty via planted false rumour.* A spy/rival marks them as thief/murderer in many minds.
SCAN: agent with low standing (−0.6+) from RUMOR-sourced hostile beliefs in 3+ witnesses, with NO matching true deed-record (distinguish low-conf RUMOR from high-conf WITNESSED).
SPARK: plant 2–3 false hostile beliefs (rumor provenance, low confidence) on the victim, gossiped across observers; fires when a persistent spy has been embedded 8+ seconds without exfil.
GROWS INTO: the innocent flees as an outlaw; a false bounty publishes; if the framer is later unmasked, standing warms +0.3 as the lie decays and truth emerges; the accused may return to reclaim their name.
REUSES: beliefs.plant/mergeFrom; reputation deed tables; combatEvents observe; intrigue._runSpy; memory (false accusations have no episode).
TIER: moderate · **now**.
RISKS: planting guarded; false beliefs decay unreinforced; gold/inventory untouched (belief-only); standing < −0.8 from majority = emergent exile (no explicit state needed).

**The Vigilante's Vengeance** — *An NPC hunts a killer without sanction; the town judges the deed by the victim's standing.*
SCAN: avenger with latched hostile + avenge goal kills a target ALSO disliked by 2+ independent witnesses (justice), OR kills a neutral/popular target (vigilante murder).
SPARK: on a combat death where the killer carries a fresh avenge goal (witnessed_death salience 0.7+) and the target's standing is widely low or factionally hostile, color the chronicle "vigilante justice" vs "righteous retribution" by witnesses' prior standing.
GROWS INTO: disliked victim → +0.15 per witness toward avenger (justified); popular victim → avenger's standing craters, counter-vendetta or Gazette bounty on THEM; cycle closes when a second killer avenges the first.
REUSES: combatEvents avenge-from-memory + witness latch; memory witnessed_death byId/withId/salience; reputation.applyDeedTo (KILLED_NPC −0.70); motivation.hasAggressiveGoal; combatEvents NEMESIS beat.
TIER: moderate · **now**.
RISKS: avenge must be memory-latched (not injected); standing clamped −1..1; deeds move standing once, reputation.decay heals — no infinite spiral.

**The False Witness** — *A lying witness poisons an innocent's reputation through gossip.* The cheapest accusation trope.
SCAN: agent with low belief (−0.3+) about a target who gossips to 3+ separate observers (moving their standing) with NO supporting WITNESSED deed-record yet high confidence.
SPARK: pick target + a pre-disliking gossiper; spread the false belief over 2–3 cycles; gossip damps via mergeFrom (gossipFalloff/gossipCap) so multi-hop reduces confidence; popular targets resist, isolated ones tank.
GROWS INTO: the witness's credibility erodes (their beliefs decay); well-acquainted observers resist with high-confidence truth; a witnessed GOOD deed by the target crowds the rumour out of bounded belief tables; the witness may be forced to recant.
REUSES: beliefs.mergeFrom + _evictIfFull; gossipBeliefs (ambient social contact); reputation.witnessDeed (good deeds crowd out negatives).
TIER: cheap · **now**.
RISKS: gossip already spreads damped (no new code); never inject false deeds into memory (belief-level only); bounded table auto-evicts old rumours.

**The Outlaw Exile** — *An agent grows so widely hated they are driven out and hunted on return.*
SCAN: count townsfolk with hostile (standing < −0.6, conf 0.6+) toward one agent; when >6 independent observers and 60% of alive townsfolk cross the threshold, the outlaw line is reached.
SPARK: after a major witnessed crime, reputation.witnessDeed sinks dozens of observers; set `a.outlaw=true`; next watch.tick treats them as a town-threat and alerts the Watch.
GROWS INTO: leashed to the frontier or flees; the Watch musters on return; may join bandits or become a nomadic antagonist; a bounty posts; closes in death, capture, or town-forgetting (decay back above threshold, hostile persists unless patrician reconciles).
REUSES: reputation.hostileThreshold; watch._threat (extend to outlaw flag); reputation.applyDeedTo/witnessDeed; beliefs hostile latch; watch homeAnchor/leashR.
TIER: moderate · **needs-behavior** (**outlaw flag** `a.outlaw` for Watch muster + trade-barring; `_flagOutlaw`/`_unflagOutlaw` clearable on reconciliation/recovery).
RISKS: standing-detection alone is implicit — need explicit flag; leashR keeps outlaws mobile (not trapped); flag must be clearable.

**The Trial by Testimony** — *Witnesses are weighed; the accused is judged guilty-and-exiled or innocent-and-reconciled.*
SCAN: 3+ agents hold DIFFERENT beliefs about the same contested event; compare confidence, source (WITNESSED vs RUMOR), hostile — low-conf RUMOR = weak testimony, high-conf WITNESSED = strong.
SPARK: a Patrician/Justice NPC summons 3–4 strongest-belief witnesses (triggered on high-variance standing spread, 3+ observers); interrogate each; tally; verdict. Guilty → accuser standing rises, accused drops; innocent → accuser confidence marked SOURCE.DISCREDITED, innocent warms.
GROWS INTO: guilty confirms outlaw status (Watch + bounty); innocent restores +0.2 per favorable witness and marks the false accuser unreliable (lower gossip priority); chronicled as a JUSTICE beat; later pardon possible.
REUSES: beliefs.confidence + SOURCE enum (add DISCREDITED); patrician._reconcile (a condemning group-reconciliation); dialogue._doCheck; reputation.applyDeedTo (verdict moves standing en masse).
TIER: expensive · **needs-behavior** (**summon-witnesses** + **interrogate-testimony** verbs; add **SOURCE.DISCREDITED** to simconfig).
RISKS: two new verbs; new SOURCE constant; verdict deterministic (tally from live confidence); false-accuser punishment moved once then decays.

**The Mob's Reckoning** — *An angry mob drags the accused to extra-judicial "justice".*
SCAN: count townsfolk with standing < −0.7 AND hostile AND anger >0.4 AND within 40 of the accused; when ≥3 and persistent (2+ ticks), trigger; distinguish from a warband by leaderless + single shared target + high anger.
SPARK: a major violent act (KILLED_NPC×2 / ATTACKED_NPC×3) with >8 witnesses sinks many to hostile; witnessing death boosts anger; on the next decide where 3+ hostile-angry townsfolk meet near the target, they spontaneously band on a shared fight-goal (no leader).
GROWS INTO: mob fights — lynch (accused killed) or exile (accused flees >60); participant morale dips; if the victim was innocent, later discovery triggers a guilt beat + harder recovery + patrician restitution.
REUSES: combatEvents anger-on-death; beliefs hostile + standing + anger; act combatStep; reputation KILLED_NPC −0.70; memory witnessed_death (enables later investigation).
TIER: expensive · **needs-behavior** (**leaderless VIGILANTE_MOB / MOB group type** in groups.js — current groups require bandLeaderId; coordinate via shared goal.target).
RISKS: needs a leaderless group type; mob driven by belief/perception (not omniscient); reuse warband combat + retreat/rout; innocent lynching leaves memory evidence for reversal.

**The Fugitive Pursued** — *An outlaw flees with hunters on their heels, becoming nomad antagonist or companion.*
SCAN: outlaw (a.outlaw, standing < −0.8 from >6) >60 from town core for 3+ ticks AND a townsfolk/Watch member actively pursuing (chase goal, moving toward); chase persists while standing+hostility hold.
SPARK: on Watch muster / major crime, flag outlaw + town-alert; brave townsfolk or the Watch form a pursuit warband; if the outlaw clears bounds and breaks line-of-sight 60s+, belief decays and pursuit gives up; the new camp-anchor becomes a frontier point.
GROWS INTO: successful fugitive establishes a frontier home, may shift faction (bandit/rival clan), recurring road skirmishes; powerful ones return as antagonists (escalate war), weak ones vanish; capture, pardon, or ascension.
REUSES: beliefs hostile + standing decay; motivation.seek_fortune (bandit); expeditions caravan/band travel; director warlord promotion; watch fallen-watchman beat; combatEvents KIN_AVENGE (dead pursuers' kin join).
TIER: expensive · **needs-behavior** (**chase-fugitive / hunt-outlaw goal** keyed on last-seen belief, not a fixed target; belief decay slows when distance >120; capture via summary death or a stub exile-bond).
RISKS: chase from beliefs (lastPos/lastTick), not omniscience; cold-scent via slowed decay at distance; no imprisonment state — use death or a quest-based exile-bond.

---

## SACRIFICE & LOYALTY

**Sworn Brothers** — *Two equal warriors swear a binding oath of mutual aid under shared threat.*
SCAN: alive townsfolk, totalLevel ≥8, within 4m; co-combatants in the past 60s; mutual standing >0.5; both in believed-danger OR sharing recent assaulted/bloodshed memories.
SPARK: per-pair _oathAge counter; after >3 ticks as co-combatants under threat, inject bond memory withId=other valence 1 salience 0.8 on both; set mutual `committedTo`; latch mutual hostile=false, standing +0.25.
GROWS INTO: an inseparable warband; can gate a third's recruitment; if one falls abroad the oath-brother mounts a solo avenge/retrieval expedition.
REUSES: beliefs.observe/mergeFrom; combatEvents witness + stand bump + KIN_AVENGE; lineage mateId persistence pattern; memory.record (bond); motivation witnessed_death; party recruitment gates.
TIER: moderate · **needs-behavior** (**committedTo** field, analog to mateId but non-romantic; throttle the N² pair-scan every 3 ticks; only set if neither already committed; block dual warbands not apprenticeship).
RISKS: bounded oathAge map (evict oldest); no mint; mutual non-hostile is truthful; survivor free to re-oath; deterministic; NPC↔NPC only.

**The Loyal Companion** — *One soul follows a leader so faithfully they become the leader's shadow and trusted voice.*
SCAN: townsfolk A; a leader L (player or high-standing NPC) where L→A standing ≥0.6 OR A has 2+ bond/succoured memories with L in the past 180s; A has no _loyal_to; A not in a party/expedition.
SPARK: set `A._loyal_to=L.id`; `beliefs.plant(L,{hostile:false,confidence:0.95,standing:1.0})`; record A bond memory valence 1 salience 0.85; gossip the devotion to nearby allies; emit a beat; small faction nudge if L is the player.
GROWS INTO: a proxy voice in dialogue; on L's death inherits a high-priority avenge goal; on separation a reunite goal; multiple loyal companions form a self-reinforcing circle.
REUSES: beliefs.plant(conf 0.95)/mergeFrom; combatEvents witness; memory.record; motivation.goalAvenge; reputation.applyDeedTo.
TIER: moderate · **now**.
RISKS: new **_loyal_to** field blocks rival recruitment (`party.canRecruit` checks `!a._loyal_to || a._loyal_to===player.id`); plant/record/bump bounded; devotion is a real belief (no deception); deterministic; bidirectional player↔NPC.

**Betrayal of a Friend** — *A trusted confidant turns hostile; trust is weaponized.* The Director sours a standing oath.
SCAN: A with _loyal_to=L or committedTo=B, A→L|B hostile=false, standing ≥0.5, not yet _betrayed; alive autonomous townsfolk.
SPARK: `beliefs.plant(L,{hostile:true, standing:current−0.6, confidence:0.9})`; record A 'betrayed' memory withId=L valence −1 salience 0.9; set `A._betrayed=L.id` (cooldown); null `A._loyal_to`; chronicle BEAT.VENDETTA; reputation hit if L is player.
GROWS INTO: a long-lived avenge goal (expiresAt +360); betrayal gossips (allies sour toward L); companions question the leader; reconciliation needs acknowledgment + a substantial apology-gift.
REUSES: beliefs.plant(hostile)/mergeFrom; combatEvents witness latch; memory.record; motivation.deriveGoals; reputation.bumpFaction.
TIER: expensive · **now** (needs new memory kind 'betrayed' + a director spark _tropeBetray).
RISKS: belief matches reality (real shift, not a lie about L's deeds); bounded; no mint; spur to conflict not death; NPC↔NPC or NPC↔player boss-beat.

**Self-Sacrifice for Kin or Ideal** — *A selfless soul takes the blow meant for a beloved.*
SCAN: protector X (combatant, standing[L] ≥0.5, ideally oath-brother/loyal) + protected L; live combat near a believed-hostile (isHostile(X,foe)); X not the player; L is kin (kinIds/mateId) or leader (bandLeaderId=X).
SPARK: set `X.bodyguard=L.id`; in combatStep, before damage, re-route incoming hits on L within 3m to X; on X death emit BEAT.HEROIC + record L 'protected' memory withId=X valence 1 salience 0.9 + grant X 'shield' epithet; if X survives, grant 'guardian' + X.standing[L] +0.2; clear bodyguard after combat.
GROWS INTO: a legendary epithet spreads in gossip; on X's death L inherits an owe_life_debt goal (and X's unfinished goals); amplified for oath/loyal circles; a town mourn beat.
REUSES: combat.resolveCombat/takeHit (inject re-route); combatEvents.grantEpithet + kin notify; memory.record (protected/saved_by); lineage kinIds/mateId; motivation goal inheritance.
TIER: expensive · **needs-behavior** (**SHIELD**: damage-intercept at combat-resolve; `agent.bodyguard=targetId`, single target, re-route within 3m).
RISKS: single conditional (freeze-safe); no mint; observed action (no lies); shield-death is a normal death; pure combat predicate; player can shield or be auto-shielded by loyal followers.

**The Bodyguard** — *A sworn protector is mustered to stand watch over one person; their post is sacred.*
SCAN: a player or notable NPC L (alive, totalLevel ≥10); an X (townsfolk, alive, not in party, not already a bodyguard, loyal_to/committedTo=L OR standing[L] ≥0.7) meeting the Watch courage threshold.
SPARK: set `X._bodyguard_to=L.id`; `X.homeAnchor=L.pos` (updated each tick to follow); combatant=true, canWork=false; epithet 'shadow' + name rewrite; standing[L] +0.2; leashR=2; if a hostile is within visionRange of L, auto-commit X to fight it; BEAT.MENTOR; clear + beat on either's death.
GROWS INTO: bond deepens with uneventful service; wounds taking (via SHIELD) are chronicled; death-at-post is a legendary beat (L gains 'protected by'); long service → custodian role; haste-dismissal can sour into betrayal.
REUSES: watch._muster/_enlist (fork leash+combatant, bind to one principal) + _revert; combatEvents.grantEpithet; decide inDanger/fight; beliefs.observe; act movement homeAnchor.
TIER: moderate · **now** (needs new **_bodyguard_to** field + decide/act guards; dialogue dismiss).
RISKS: homeAnchor/leashR already shared — distinguish by field; flag + per-tick position copy + belief-read predicate (freeze-safe); no mint; real belief + real leash (no deception); normal death; player must hire/accept (never forced).

**Debt of Honour Repaid** — *The saved must repay in deed, not coin; the promise hangs until settled.*
SCAN: A with a 'succoured' memory (withId=B) recorded 60–480s ago; B alive; A has no { kind:'repaid', withId:B }; A autonomous townsfolk.
SPARK: record A 'debt_of_honour' memory withId=B valence 1 salience 0.8; deriveGoals pushes goalRepayDebt(B); predicate checks A has the item AND is within arriveDist of B (present, not remote); on satisfaction record 'repaid' + `awardGoalClosureXP(A,0.8)`; BEAT.FORTUNE; set `A._repaid[B]=true`.
GROWS INTO: failure within expiry → a 'shame' epithet + faction hit; lavish repayment → sworn allegiance; repeated succours → patronage (loyal-companion); death-with-debt → B inherits a 'repaid_in_blood' avenge; multi-gen familial debt.
REUSES: act giveStep/payStep + recordSuccour; memory.record (debt_of_honour/repaid); motivation goalRepay + awardGoalClosureXP; combatEvents.grantEpithet (shame); beliefs.mergeFrom.
TIER: cheap · **now** (new memory kinds 'debt_of_honour'/'repaid'; deriveGoals extension).
RISKS: give/pay are gold-neutral transfers; debt is a real succoured-memory belief (no lies); single-append memory; deterministic; player can be debtor or succouror.

**Divided Loyalty** — *Pulled between a beloved leader and a feuding kinsman, a soul tears itself apart until forced to choose.*
SCAN: A (townsfolk) with committedTo/_loyal_to=L1 AND a belief b→R with standing ≥0.6 where R feuds L1 (or R is A's mate/kin); no serve/aid goals yet; L1 and R alive; optionally L1/R >16m apart.
SPARK: record A 'divided' memory withIds=[L1,R] valence 0 salience 0.85; push g1=goalServeLeader(L1, 0.7) + g2=goalAidKin(R, 0.7); each tick decide picks the nearer subject; forced combat with one drops belief in the other −0.1 (dissonance); on resolution record a closure with the chosen + a betrayal toward the abandoned.
GROWS INTO: volatility (allies doubt A); choosing L1 latches hostile to R; choosing R drops L1 −0.4 + faction hits; reconciliation needs L1↔R peace (patrician/wedding heals feud); 'steadfast' vs 'fickle' epithets; multi-gen inheritance.
REUSES: motivation goal stack; decide goal-selection (extend to competing equal goals via proximity tiebreaker); combatEvents witness + breach_of_faith deed; grantEpithet; memory.record; beliefs.mergeFrom; houses.feudingHouseOf; patrician._reconcile.
TIER: expensive · **needs-behavior** (decide accepts competing equal-priority goals w/ proximity tiebreak; new goals serve_leader/aid_kin; new memory kinds divided/closure; new deed breach_of_faith).
RISKS: proximity check pure (freeze-safe); no mint; conflict is in goals not lies; volatile not suicidal; deterministic; soft tick-flip is more emergent than hard break.

---

## REDEMPTION & TRANSFORMATION

**The Coward's Stand** — *A timid soul, seeing a loved one fall, holds the line for the first time and transforms.*
SCAN: alive non-combatant NPC, risk_tolerance <0.3 (or recently-pruned flee goal); a witnessed_death of kin/high-affinity ally (salience ≥0.7) in the last 5 ticks within 50m; no 'survivor' epithet yet.
SPARK: set `a._couragousUntil = time+5` and override decide to reject the flee candidate while the flag holds; if they land a melee blow and the town wins, grant the epithet, bump risk_tolerance +0.2 (cap 0.8, once), pivot ambition to renown.
GROWS INTO: pursues monster hunts and riskier goals; mentors; Watch/expedition recruit; or a poignant death finding courage too late.
REUSES: combatEvents.grantEpithet; motivation ambitionWantsFight/assignAmbition; decide flee logic (flag-guarded); memory STM/MTM; reputation.witnessDeed (MELEE bump).
TIER: moderate · **now**.
RISKS: flee-override is a 5-tick flag cleared on victory/timeout; salience ≥0.7 gate (no bystander triggers); +0.2 bump once (a._courageBumped); grantEpithet idempotent.

**The Miser Reformed** — *A hoarder is shamed/surprised into generosity and discovers belonging.*
SCAN: alive autonomous townsfolk; altruism <0.2 and ambition.kind='wealth'; gold ≥40; a needy townsfolk within 30m (hunger <0.2 or just-widowed); no give/pay in the last 20 ticks.
SPARK: present a dialogue choice [Give gold] vs [Turn away]; on give run giveStep (closed loop); bump altruism +0.25 (clamped, once); reroll ambition to 'belonging'; record receiver 'succoured'; witnesses observe a HELPED deed (+0.20 personal / +0.05 faction).
GROWS INTO: becomes a community pillar, courts a family-oriented partner, children inherit higher altruism, a patrician-like peacemaker; relapse = tragedy.
REUSES: act giveStep/payStep; motivation.assignAmbition; beliefs.plant/observe + reputation.applyDeedTo; dialogue._doCheck; lineage._courtship/_wed; memory.record (succoured → repay).
TIER: moderate · **now**.
RISKS: giveStep checks inventory before debit/credit (closed); altruism bump once (a._altruismBoosted); dialogue gated on need predicates; reroll idempotent (a._miserReformed).

**The Prodigal's Return** — *A restless wanderer hears of a grieving family and comes home in remorse.*
SCAN: townsfolk with ambition wanderlust/renown; living kin/mate in town; outside town bounds 40s+ (track _prodigalStartedAt/_lastTownDist) or in a caravan 60+ ticks; a kin/mate carries witnessed_absence or a grieve goal; no _prodigalArc flag.
SPARK: record wanderer guilt memory; sour kin→wanderer to −0.3 + mood.sorrow +0.4; gossip the absence; reduce wander/flee utility + boost a repay(kin) goal pulling them home.
GROWS INTO: reunion, local marriage, rooted children, mentorship; a repeated pattern earns a dark 'Faithless/Restless' epithet — single return = redemption, cycle = tragedy.
REUSES: motivation.deriveGoals (repay) + assignAmbition (belonging); beliefs.plant/observe; decide wander candidate + ambitionFavor; lineage._courtship/_wed; memory.record (grieve/reunited); reputation.witnessDeed.
TIER: moderate · **now**.
RISKS: distance/time state machine guards against rapid boundary-flapping; kin salience >0.65 gate; ambition reroll idempotent (_prodigalReoriented); relapse escalates to 'traitor' + standing crash.

**The Heretic's Conversion** — *A devout believer watches their dying god fade and converts to a rising rival's faith amid guilt.*
SCAN: townsfolk faith=OldGod with oldGod.power==smallGodAt (last believer); a different newGod power ≥3 with a recent miracle/anointing (<5 ticks); agent within 20m of a newGod believer; not yet lapsed; no _heresisDone.
SPARK: mood.sorrow +0.3 + plant a doubt-suspicion toward OldGod (god pseudo-agent or a _godDoubt flag); on a witnessed newGod miracle plant conviction (conf 0.7 / _seesMiracle); faith._spread drifts OldGod→faithless→NewGod; record 'apostasy' memory salience 0.6 valence −0.3 (healing via decay).
GROWS INTO: a pillar of the new faith / future prophet; if OldGod is revived, re-conversion or a tested commitment; children inherit no faith but the parent's internal-conflict tags.
REUSES: faith.anointProphet/_miracles/_spread/_doubt; beliefs.plant; memory.record (apostasy); motivation.assignAmbition; lineage._inheritTags.
TIER: moderate · **now**.
RISKS: faith-belief wrapper (better: a small a.faithBeliefs map / _godDoubt/_godConviction flags); tighten miracle scheduling so heretics witness proof; cap re-conversions (_apostasies max 2); narrate the valence healing in chronicle.

---

## RECOVERY & LOSS

**The Orphan Taken In** — *A childless townsperson witnesses an orphaning and raises the child.*
SCAN: dead townsfolk with living kinIds; a nearby alive townsperson (within proximity) with low/zero kinIds who witnessed the death (or heard it via gossip).
SPARK: plant 'succoured' memory on child withId=rescuer; set `child.adopterId=rescuer.id`; warm rescuer→child +0.3; if the child has a witnessed_death of the true parent, record it faint (salience 0.3, fast fade) as a latent thread; chronicle the bond.
GROWS INTO: the ward grows up bonded; if the killer's name later surfaces, the avenge goal collides with love for the foster parent; the ward's marriage makes the adoptive line genealogically real.
REUSES: combatEvents KIN_AVENGE (orphaning at death-time); beliefs warm; lineage kinIds; memory.record; motivation.deriveGoals (grieve/avenge); gazette/chronicle.
TIER: moderate · **needs-behavior** (**ADOPT**: new narrative-only **adopterId** field — kinIds stays canonical for all vendetta/inheritance; dialogue 'call rescuer parent' + the avenge-vs-protect collision).
RISKS: adopterId narrative-only (never gates incest/inheritance); keep pair in contact so the warm belief survives eviction; bond rightly fades if they drift apart.

**The Mourning Wake** — *Kin and friends gather to grieve; standing warms and the dead are remembered.* The cheapest loss beat.
SCAN: every death of a townsperson with living kinIds where kin are within town bounds; or any notable agent's death (communal loss).
SPARK: schedule a 1–2 tick wake; record kin 'closure' memory withId=dead salience 0.4; warm mutual mourner standing +0.2; satisfy/remove any matching grieve goal; chronicle BEAT.MEMORIAL with epithet; add a decaying 'mourning' tag (30 ticks) that others perceive and respond to.
GROWS INTO: sympathetic socializing during the mourning window; permanent LTM trace; children's witnessed_death → potential revenge; community rallies to the bereaved mate.
REUSES: combatEvents KIN_AVENGE/witness; memory.record (closure, dedup-safe vs witnessed_death); beliefs warm; motivation.pruneGoals (grieve satisfied); chronicle.note; transient-tag pattern (a._mournSince).
TIER: cheap · **now**.
RISKS: use a distinct 'closure' kind to avoid witnessed_death dedup; gate the wake once per death; bound the standing cascade to ~8 nearby; mate widowing — clear mateId at death; community-avenge already exists in combatEvents.

**The Reunion of Kin** — *Separated distant relatives recognize their shared house and reaffirm lineage.* Cheap, warm.
SCAN: alive townspeople A/B with A.house===B.house, within proximity, kinIds NOT already linked (distant relatives), no prior reunion together (bidirectional _reunited key); prefer pairs in town 30+ ticks.
SPARK: record 'reunion' memory on both salience 0.5; warm mutual standing +0.25 (clamped); satisfy a matching grieve goal keyed to the reunited agent; chronicle the recognition; mark _reunited both directions.
GROWS INTO: warmth deepens via gossip; potential house-marriage (two branches uniting); they may stand together against a common rival or form a band; an affair/adoption twist can surface a false-kin scandal.
REUSES: beliefs warm; lineage kinIds; memory.record; motivation.deriveGoals (grieve satisfied, strict withId match); houses; party; gazette; gossipBeliefs.
TIER: cheap · **now**.
RISKS: bidirectional dedup key; grieve match strict by withId; clamp standing; _fond is voluntary (no auto-marriage); affair twist keeps the epistemic split (kinIds canonical vs false-kin belief).

**The Lost One Found** — *A search recovers a missing agent, alive but changed by absence.*
SCAN: townsfolk alive but isolated (far/alone) or retro-flagged 'lost'; living kin/mate in town; trigger on a kin joining a recovery expedition or a director-rolled seek_lost_one goal.
SPARK: on the search expedition reaching the lost agent, plant searcher 'reunion' memory; offer 'Convince to return' (standing ≥0.2 check); on agree set following + escort; on arrival warm kin standing +0.5; cancel kin grieve goals.
GROWS INTO: re-acclimation (skills decayed 10–20%, re-earned); mate moved on or welcomes back; unrecognizing children; latent trauma suspicion that decays; if deliberately abandoned, an avenge goal.
REUSES: expeditions._endDelve; beliefs warm; party (escort); memory.record (reunion); motivation.deriveGoals (homecoming/avenge); progression.totalLevel (decay); gazette; dialogue.
TIER: moderate · **now** (needs an optional expedition.objective={recover_lost_agent,targetId}).
RISKS: expeditions lack objectives — add the optional field; after decay call planner.clearPlan; reintegration intentionally slow; mate re-establishment via _fond (re-mate or poignant loss); heal broken kinIds links on return; goal satisfaction via reunion memory pre-empting grieve.

**The Expedition Returned** — *A band returns from a delve in triumph or grief; survivors are celebrated or questioned.*
SCAN: an expedition ends (expeditions._endDelve); read captain, band roster, relic/loot; which members are alive vs dead; for each dead member scan the town for living kin.
SPARK: warm captain↔kin +0.3; for each dead band member plant kin 'witnessed_death'; success → captain epithet ('the Legendary'); failure (0 relics, >50% casualties) → survivor 'haunted' epithet; chronicle the saga + a memorial beat per fallen.
GROWS INTO: a 4–6 beat saga: reunion → celebration/sorrow → legacy (Gazette fame draws recruits) → haunting (a fading 'traumatized' tag lowers risk tolerance + withdraws socially); births gated during the expedition unlock on return; double grief if home suffered while away.
REUSES: expeditions._endDelve; beliefs warm + gossip; memory.record (witnessed_death/triumph); combatEvents.grantEpithet; lineage births (paused→resume); motivation (grieve/repay); gazette/chronicle; transient trauma tag.
TIER: moderate · **now**.
RISKS: hook the return moment (captain re-enters town bounds); reconstruct deaths from the band roster (approx tick); resume gestation on return; bound fame/blame standing to ~8 nearby; trauma is a mood-driven read (no new decide logic); relics are display flavor (no conservation risk).

**The Homecomer Unrecognized** — *An old friend returns to find people have moved on; recognition is cold.* Decay-driven heartbreak.
SCAN: pairs (A,B) not immediate family, no interaction in 20+ ticks (decayed standing near zero), both alive in town, within proximity; A signals long absence (wanderlust ambition / large _lastPos shift) — find B as A's highest historical-standing oldest friend.
SPARK: emit B a 'Do you remember [A]?' prompt [belief check: B→A standing >0.1 after decay]. PASS → +0.1 + reunion memory + warm chronicle. FAIL → −0.2 + 'stranger' memory + hurt chronicle. Mark _encountered_homecoming so it doesn't repeat.
GROWS INTO: PASS → re-bonding, satisfies belonging; outsider-relearning the social map. FAIL → sour/mild hostility, A seeks other old friends or drifts away again. Ex-mate path: re-marriage (mateId intact) or cold rejection (re-mated) = lost-love tragedy.
REUSES: beliefs.decay; memory.record (reunion/stranger); dialogue._doCheck; gossipBeliefs; lineage._fond/_courtship; motivation (belonging/wanderlust); reputation; gazette.
TIER: cheap · **now** (needs the 'Do you remember me?' dialogue flow on _doCheck).
RISKS: tune decay so 20-tick absence yields ~0.1 (neutral, not hostile); distinct memory kinds avoid dedup collapse; ex-mate re-marriage gated by _fond (closed loop); _encountered_homecoming + reprieve prevents a rejection death-spiral.

---

## MYSTERY/IDENTITY & COMEDY (Picaresque)

**Mistaken Identity** — *An innocent is confused for a villain and entangled in their feuds.* (Comedic register; deduped from the Justice 'Framed Innocent' by its disguise-confusion framing.)
SCAN: a disguised spy / traveling stranger near town core + two or more separate belief-hostile links to the SAME innocent target from unrelated observers.
SPARK: plant hostile beliefs on 3–5 separate townsfolk about one designated innocent (staggered ticks, via intrigue.plant), or redirect existing spy plants at a single target.
GROWS INTO: the innocent flees/hides/fights false accusers; bystanders gossip the confusion; when beliefs decay, accumulated combat standing-drops crash the innocent's reputation — comedy + tragedy blend.
REUSES: beliefs.plant; intrigue._runSpy (point at one target); perception gossip; combatEvents.observe; reputation.witnessDeed; dialogue._doCheck.
TIER: moderate · **now**.
RISKS: guard plants in try/catch; hostile only latches if confused townsfolk actually fight (emergent); standing drops via combat not _sour; never plant on the player; self-resolves on decay.

**The Boast Backfires** — *A vain agent boasts of an undone feat; the planted fame demands proof.*
SCAN: high-ambition renown-seeker with monsterKills below their boasted tally + multiple townsfolk who believe standing >0 toward them (rumour-planted fame); tightens when a real monster spawns near them.
SPARK: pick a boaster; plant positive reputation + false 'monster kill' rumours (RUMOR confidence) in 2–4 townsfolk; optionally spawn a monster near them to call the bluff.
GROWS INTO: the boaster's ambition reads REAL monsterKills (gap drives tension); when tested they FLEE (standing crash), FIGHT (boast may luck into truth), or CONFESS (lose standing, regain integrity).
REUSES: beliefs.plant (knownDeeds, RUMOR); motivation renown.progress; gossipBeliefs; combatEvents.grantEpithet (grant heroic name / retract on exposure); director._note; reputation.
TIER: moderate · **now**.
RISKS: planting a deed-belief never changes life.monsterKills; ambition reads real stats; exposure emergent (real monster/rival/gazette); fleeing-loss is natural witness consequence; boast can become true (no retroactive punishment).

**The Lucky Survivor** — *A hapless fool survives danger by chance and earns unearned bravery-fame.*
SCAN: low totalLevel (<3) + high curiosity/risk_tolerance, present in combats (witnessed_death/assaulted memories but no killed_* deeds) + multiple positive standing-beliefs from gossip-spread heroism; tightens when offered a party/bounty they can't handle.
SPARK: identify a hapless agent near spawned combat; arrange a passive survival (allies kill the foe, foe targets someone else, last-second flee); plant +0.3 standing + false 'bravery' knownDeed in 2–3 witnesses; trigger a recruit/bounty that calls them to a real test.
GROWS INTO: undeserved renown draws recruits expecting a miracle-worker; the next real fight exposes incompetence; humiliation, comic-relief mascot, or another lucky save cementing the myth.
REUSES: combatEvents observe/record (witnessed not killed); beliefs.plant; gossipBeliefs; motivation renown desync; party.recruit; dialogue recruit gate; grantEpithet (gain then lose 'The Fortunate').
TIER: cheap · **now**.
RISKS: no new combat mechanics (passive survival only); moderate +0.3 boost; memory records what was seen not done; exposure via real combat (no unmasking verb); life stats truthful, ambition reads them.

**Unlikely Friendship** — *Two opposites or feud-faction members form a scandalous bond.*
SCAN: A/B with A→B standing < −0.2 OR hostile, AND different faction OR feuding houses, PLUS repeated proximity (<20m for 5+ ticks) PLUS unrelated positive interactions (both help a third, both excel at a craft, both survive a raid).
SPARK: warm one side `A→B standing +=0.25` to break the hostility symmetry (A notices B's good side); DO NOT latch hostile; let mergeFrom + gossip + shared deeds carry the rest.
GROWS INTO: continued proximity warms both sides; eventual party recruitment (standing gate now met); cross-house marriage later heals the feud (_allyHouses); scandal is social gossip the feuding families must accept.
REUSES: beliefs.mergeFrom; combatEvents observe/record (shared combat); gossipBeliefs; lineage._wed/_allyHouses; party.recruit (standing gate); director._note.
TIER: cheap · **now**.
RISKS: never latch hostile artificially (it unlatches naturally on warming); proximity emergent; marriage voluntary via _fond; if the nudge fails, the trope simply doesn't fire (probabilistic).

**The Trickster** — *A charismatic rogue plays rivals against each other for profit, then must flee when seen through.*
SCAN: high social_drive (≥0.7) + curiosity (≥0.6) + low altruism (<0.4) at the intersection of feuding pairs; present in multiple near-hostile belief pairs (standing −0.2..0.2); stands to profit from escalation.
SPARK: flag `a.trickster=true`; for each rival pair the trickster knows, plant a sour belief A→B −0.15 and vice versa ("the trickster overheard X trash Y"); when a pair drops below −0.3 the trickster profits via cheap buys (no mint).
GROWS INTO: manipulation builds feuds + price volatility; rivals/townsfolk notice the trickster is the common thread; on exposure standing crashes everywhere — flee with profits (arbitrage) or brazen it out (persuade/intimidate); ostracized and hunted if they stay.
REUSES: beliefs.plant; gossipBeliefs; director._spark/_sour (trickster-directed); market trade (manipulated prices); reputation.witnessDeed (on exposure); dialogue persuade/intimidate; arbitrage._take (flee).
TIER: expensive · **now**.
RISKS: plants false beliefs, never artificial standing-drops; profit is closed-loop arbitrage; exposure can be a timer (active N ticks + multiple feuds → ~30%/roll uncovered); trickster must stay neutral (no hostile latch) or cover blows; a seed, not a puppet-master.

**The Fool** — *A bumbler accidentally achieves heroic outcomes and is celebrated despite deserving ridicule.*
SCAN: totalLevel ≤2 + high curiosity/social_drive present during a high-conflict scenario (raid / feud escalation / ambush); they succeed at an improbable outcome (kill a higher-level foe, persuade a hostile pair, survive 1v3 with allies) — success by CHANCE.
SPARK: no spark needed (emergent luck); the Director may NUDGE them into high stakes — spawn a raid near them, pair them with a competence-expecting party, or issue a bounty they stumble into — then let RNG decide.
GROWS INTO: on a win, witnesses record real deeds + plant standing; recruiters expect a miracle-worker; the next high-stakes test likely exposes them — humiliation, re-luck, or chaos-mascot adoption.
REUSES: combatEvents observe/record (outcome recorded regardless of intent); reputation.witnessDeed (a lucky kill is a kill); motivation renown (real monsterKills, by luck); party.recruit; dialogue persuade/intimidate (RNG success); director._note.
TIER: cheap · **now**.
RISKS: no fake deeds — the fool must actually execute and succeed (RNG/lucky collision); success breeds expectation + later exposure; standing is real (reflects witnessed outcomes); exposure via repeated failure (no exposure mechanic).

---

## CONFLICT & VENGEANCE (extensions to the existing corner)

**Rival Camp Raid** — *Rival camps raid EACH OTHER (not the town).* Extends the existing town-facing caravanRaid.
SCAN: two non-town camps with mutual latched hostile (or areHousesFeuding), each with a leader + ≥4 members, both home-anchored, neither already in an inter-camp conflict (registry sim.camps).
SPARK: pick the more aggressive camp's leader; `_spawnRaider` 3–5 bodies (gold=0); set goal.kind='campRaid' with targetCampId; march as a band toward the rival anchor; survivors latch witnesses hostile.
GROWS INTO: losers suffer morale + population loss; the losing leader pursues an avenge counter-raid escalation; chronicle "Camp A raided Camp B — B hunts for vengeance".
REUSES: director._spawnRaider + TTL despawn; decide (new campRaid goal); movement.goTo + combatStep; combatEvents.observe; groups dissolve.
TIER: moderate · **needs-behavior** (**campRaid goal**: read target camp anchor, march, fight members on sight, withdraw/despawn on TTL; `director._tropeCampRaid` scans camps).
RISKS: spawn + goal-set guarded; raiders gold=0, camp members aren't lootable (true faction); true faction (epistemic intact); only fires when BOTH camps ≥ minPop; TTL withdrawal (no siege).

**Mutiny / Defection** — *A band member breaks ranks mid-conflict and defects to a rival.*
SCAN: autonomous group member (inParty or bandLeaderId) with hostile toward their leader OR a witnessed co-member death + standing < −0.3; not the leader; not a player companion.
SPARK: `beliefs.plant(leader,{hostile:true})`; set `_defecting=true`; on decide the agent drops group flags, swaps faction (to _originalFaction or a camp faction), and re-plants hostile on former groupmates; combatEvents consolidates the break.
GROWS INTO: fractured warband (cohesion penalty); a defecting town recruit gets a "Reclaim the Traitor" bounty; the defector may seek revenge on their former group.
REUSES: beliefs.plant; groups._revert; decide faction-branching; combatEvents.onCombatEvents (grief seeds next defection).
TIER: moderate · **needs-behavior** (decide branch on `_defecting`: _revert + faction swap + hostile plant, then re-decide; `director._tropeDefection` gated on morale).
RISKS: faction swap + plant guarded, alive-checked; no gold transfer (keeps own inventory); post-swap combat reads new true faction (no asymmetry); non-leader only, morale-gated, one defection per group per pass.

**Duel of Honor** — *Two personal rivals settle a blood debt in binding single combat.*
SCAN: alive pair with mutual latched hostile, mutual standing < −0.8, both free agents (not in groups/party/watch), within 8 tiles, both carrying a real combat/grievance memory, neither a nemesis/warlord.
SPARK: set both goal={kind:'duel', opponentId}; town alert "A duel of honor erupts!"; bystanders within 20 record a spectator memory (+0.1 eventual winner / −0.1 loser); combat locked (no allies, no flee); ends on loser death/surrender.
GROWS INTO: winner commemorated ('Duelist'/hero), loser shamed/demoted; the feud CLOSES (hostile unlatched, standing warmed to −0.1 wary respect); a House-leader loss shifts house standing; chronicle "A bested B — honor is satisfied".
REUSES: combatEvents.grantEpithet; beliefs unlatch + warm (reverse of patrician pattern); movement.goTo lock within 8 tiles; act.combatStep (gated by duel goal — no ally reinforcement); memory.record (spectator).
TIER: moderate · **now** (needs **duel goal**: 1v1 lock, no flee/group-break, blocks interference).
RISKS: goal-set + epithet sync on tick; no mint (corpse lootable after); spectator beliefs updated by witness (no deception); not triggered in towns ≤ minPop; interruption leaves feud unresolved.

**Massacre Prevented** — *A cascading slaughter is averted by a heroic stand mid-raid.*
SCAN: during an active raid — >40% of non-combatant townsfolk dead in the last ~10 ticks (director death tally); ≥1 alive hero in the town core (Duelist/hero epithet, high level/kills, or party member); wave + leader alive; tension ≥0.6.
SPARK: broadcast BEAT.HEROIC; flag the hero `_moraleSurge={speedMul:1.3, threatMul:1.5, hpBoost:20, until:time+15}`; rally townsfolk within 20 (fear→0, standing +0.15 toward hero); if the hero kills the wave leader before the surge expires, `director._withdrawAll()` despawns the wave.
GROWS INTO: a told-and-retold saga; survivors gain 'Survivor', hero gains renown (awardGoalClosureXP); relief window opens; later-born children gain a +0.2 legendary-standing memory; defeated raiders fear the hero (−0.2).
REUSES: director._withdrawAll; combatEvents.grantEpithet; motivation.awardGoalClosureXP; chronicle BEAT.HEROIC; act.combatStep (passive stat boost read).
TIER: moderate · **now** (needs a director death-tally check + `_tropeMassacrePrevented` + the `_moraleSurge` passive flag).
RISKS: morale surge is a tick-bounded temp flag (reverts at until); HP boost temporary, raid despawn already gold-neutral; townsfolk see the rally (ground truth + perception align, no false beliefs); if the hero dies first the massacre proceeds (tragedy), with the existing pop-floor mercy reprieve as backstop.

---

## Coverage: BEFORE vs AFTER

**BEFORE** — the engine occupied a single corner of the dramatic-situation map: 7 tropes (rivalApprentices, feud/House-feud, vendetta, prophet, nemesis, war, caravanRaid) all in CONFLICT/VENGEANCE — enmity, faction war, and a lone faith beat. Whole Polti corners were empty: no romance/kinship arcs (pursuit, love-vs-duty, marriage, jealousy), no ambition/fall (hubris, usurpation, corruption, downfall), no mystery/identity (recognition, disguise, the returned dead, the hidden heir), no justice/crime (false accusation, trial, mob, the fugitive), no sacrifice/loyalty (oaths, the protector, betrayal, divided allegiance), no redemption/transformation, no recovery/loss (mourning, reunion, homecoming), and no comedic/picaresque texture.

**AFTER** — this catalog adds 55 tropes across nine registers, reaching every major corner: LOVE & ROMANCE (8), AMBITION & THE FALL (8), MYSTERY/IDENTITY (7), JUSTICE/CRIME (7), SACRIFICE/LOYALTY (7), REDEMPTION/TRANSFORMATION (4), RECOVERY/LOSS (6), COMEDY/PICARESQUE (6 incl. one deduped from Justice), and extensions to CONFLICT/VENGEANCE (4). It maps Polti situations such as Recovery of a Lost One, Recognition, Fatal Imprudence, Self-Sacrifice for Kin/Ideal, Mistaken Jealousy, Rivalry of Superior/Inferior, Obstacles to Love, Conflict with a God, Erroneous Judgment, and Remorse — turning the Director from a feud-and-raid engine into a full life-and-loss dramatist while every entry holds the six constraints. 38 of the 55 are buildable on the current substrate ('now'); the remaining 17 are unlocked by a small, named set of new verbs/fields (LEAD, CONFESS, SHIELD, ADOPT, committedTo, _loyal_to, _bodyguard_to, outlaw flag, leaderless MOB type, campRaid/duel/chase goals, SOURCE.DISCREDITED, deriveGoals extensions).

## Top build-first (Tier-1, now-expressible, drama-per-effort, register-diverse)

1. The Mourning Wake (RECOVERY/LOSS, cheap) — communal grief beat, reuses everything.
2. The Reunion of Kin (RECOVERY/LOSS, cheap) — warm kinship payoff, kinIds + memory only.
3. The False Witness (JUSTICE, cheap) — pure gossip-damped reputation poisoning, no new code.
4. Unlikely Friendship (COMEDY, cheap) — one standing nudge flips an enmity to a bond.
5. The Coward's Stand (REDEMPTION, moderate) — a single flee-override flag yields a transformation arc.
6. Courtship Rivalry (LOVE, moderate) — the love triangle that branches into wedding/vendetta/heartbreak.
7. The Favored Rise (AMBITION, moderate) — one false standing-spike → an upstart's inevitable fall.
8. The Spy Unmasked (MYSTERY, moderate) — explicit `_unmask` trigger + collateral-feud reconciliation.
9. Duel of Honor (CONFLICT, moderate) — a 1v1 lock goal that actually RESOLVES feuds instead of spawning more.
10. The Loyal Companion (LOYALTY, moderate) — `_loyal_to` devotion seeds proxy-voice, avenge, and reunion arcs.