# Director Levers — a points-budget menu for the storyteller

> Design doc. Not an implementation. Companion to `docs/drama-plan.md` §1 and the
> existing `js/sim/director.js` + `DIRECTOR` in `js/sim/simconfig.js`.

## 0. The model we're converting to

RimWorld-style **points budget**. The scaffold already exists in config
(`DIRECTOR.points`, `js/sim/simconfig.js:748`) and is the contract every lever below
plugs into:

- a **drama budget** accrues each director roll, `base + perPop·(pop − raid.minPop)`
  (prosperity → drama), capped at `points.max` so you can't hoard infinitely;
- **deaths drain it** (`deathDrain` per townsperson lost since the last roll) — the
  mercy / adaptation valve;
- incidents are **bought**: a wave costs `raidPerRaider · waveSize`; everything else has a
  per-kind `cost`. Banking through calm funds an occasional **climax**; a bled town's
  empty purse buys nothing → a natural reprieve (this unifies scaling, pacing, and mercy
  into one number, and retires the old `eventChance`/`quietBias` dice).

The job of *this* doc is to give that purse **many meaningful things to buy**. Today the
menu is: raid / opportunity / crisis / spark / trope{rivalApprentices, feud, vendetta,
prophet, nemesis, war, caravanRaid} + caravan dispatch (`director.js:222-673`). That's a
strong THREAT and SOCIAL spine but thin on ECONOMIC, FACTION/POLITICAL, POSITIVE, and
WORLD registers. Below: ~22 levers across six registers, each priced into a cost tier.

### Cost tiers (suggested point bands; tune in `DIRECTOR.points.cost`)

| tier | band | meaning |
|------|------|---------|
| **cheap** | 1–3 | belief-only nudges, single-agent flags; fire often, texture the world |
| **moderate** | 4–9 | a small spawn / a multi-agent social state change / a caravan-class set-piece |
| **expensive** | 10–20 | a named recurring antagonist, a multi-agent faction event, a festival |
| **climax** | 20–50 | the war/coup/siege payoff you bank toward; rare, world-shaking, leashed |

Pricing principle: **cost ≈ drama footprint × duration × extinction risk**. A wave is
already metered *per body* (`raidPerRaider`) — keep that variable-cost idea for any lever
that spawns N bodies, so the budget gates magnitude, not just frequency.

---

## 1. Constraints every lever must respect

These are load-bearing. Each lever below restates which ones bite it.

1. **FREEZE LESSON.** Anything reached from the fixed tick must be fully guarded and
   never throw or stall. The Director's `tick()` already wraps everything in `try/catch`
   (`director.js:125,161`); every new lever is one more body inside that. Guard every
   profession / inventory / economy / belief-store access — a professionless monster or a
   missing belief map must *skip*, not throw. Never unbounded-loop on the tick.
2. **CLOSED MONEY LOOP.** No minting. Spawned bodies get `gold = 0` and empty inventories
   (the `_spawnRaider` pattern, `director.js:282-284`); all economic levers move price
   *beliefs* or *transfer* existing purses — never `+= gold`. (Watch the known loot-mint
   hazard from `player-as-agent` if any lever grants drops.)
3. **EPISTEMIC SPLIT.** Decisions read **beliefs**, execution reads **truth**. Levers seed
   *beliefs* (`beliefs.plant` / `_ensure().standing` / `priceBeliefs`) or spawn *bodies*;
   they never reach into `decide`/`perceive` to lie about ground truth. Deception works by
   planting a belief that disagrees with reality (the spy/disguise/rumour path), letting
   an agent be genuinely fooled while combat still resolves on truth.
4. **ANTI-EXTINCTION.** No lever can wipe a town. Honour `raid.minPop` reprieve
   (`_withdrawAll`, `director.js:108`), the territorial **leash** (`homeAnchor`/`leashR`),
   and **TTLs** (`_raidExpire` → `_pruneRaiders`). Lethal levers get a TTL *and* a
   pop-floor gate; a town below floor refunds/cancels the lever.
5. **DETERMINISM / HEADLESS-SAFETY.** `Math.random()` is fine; **no `Date`, no I/O, no
   `await`** on the tick. Anything touching meshes/canvas must guard
   `typeof document === 'undefined'` (the headless path), like `_spawnRaider`
   (`director.js:274`). LLM/flavor text is strictly off-tick (the Gazette/Press pattern).
6. **PLAYER IS JUST AN AGENT.** No lever assumes `sim.player` exists (the sim runs fully
   headless). Use `a.autonomous` filters, never `!a.controlled` special-casing; the
   player, if present, is targeted/affected like any other agent.

---

## 2. THREAT register (raids / monsters / disasters)

The fear engine. Variable-cost spawns; all gold-neutral, TTL'd, leashed, floor-gated.

### T1 — Raid wave  *(BUILT)*
- **Pitch:** a pop-scaled wave of monster-faction raiders arrives at the town ring.
- **Mechanic:** `director._raid` (`director.js:225`) — already metered per-raider via
  `points.raidPerRaider`; budget should now *cap want* (`want = min(want, floor(budget /
  raidPerRaider))`) so a poor town gets a token poke and a rich one a real wave.
- **Cost:** moderate→climax (variable, `raidPerRaider · waveSize`). **Register:** THREAT.
- **Risk:** anti-extinction (already handled: minPop, TTL, leash, withdraw).

### T2 — Nemesis raid-boss  *(BUILT)*
- **Pitch:** promote a live raider to a named, persistent, fast boss the town must fell.
- **Mechanic:** `_tropeNemesis` → `grantEpithet(sim, boss, 'villain')`
  (`director.js:500`). One at a time; exempt from TTL/withdraw; kin-avenger + hero arcs
  compose around it.
- **Cost:** expensive. **Register:** THREAT. **Risk:** must keep the "one nemesis" guard
  and `bossSpeedMul` (else inert) — leave the existing leash/withdraw exemption singular.

### T3 — Monster incursion (a *kind*, not a faction)  *(PARTIAL — reuses delve horrors)*
- **Pitch:** a pack of wild beasts (wolves/`_spawnHorror`-style) strays from the wilds into
  a town's outskirts — apolitical danger, no warlord, no camp.
- **Mechanic:** reuse `expeditions._spawnHorror` (`expeditions.js:137`) spawn shape but at
  overworld Y near a town ring; leash to a wilderness anchor with a short TTL so it's a
  *scare*, not a siege. Distinct from raiders: no faction politics, can't escalate to war.
- **Cost:** moderate. **Register:** THREAT. **Risk:** freeze (guard horror spawn like
  raiders), anti-extinction (TTL + small pack + leash).

### T4 — Plague / wasting sickness  *(NEW)*
- **Pitch:** a sickness settles on a town — folk weaken, fear rises, the faithful pray.
- **Mechanic:** mark N nearby townsfolk `a.sick = { until }` (a flag, like
  `_alertUntil`). Effects must reuse EXISTING fields only: nudge `mood.fear` up, apply a
  mild `speedMul` debuff, and bias them toward the existing `eat`/`rest` goals (slower to
  work). It is **non-lethal by itself** (no HP drain — that risks extinction and the
  freeze path); the drama is the *fear + Watch/Faith response + a miracle that lifts it*.
  Recovery on TTL clears the flag and can fire a relief-style beat.
- **Cost:** moderate. **Register:** THREAT. **Risk:** anti-extinction (NEVER fatal; flag
  + TTL only); freeze (guard `mood`/goal access — monsters have neither).

### T5 — Wildfire / failed-harvest blight (environmental)  *(NEW, leans on T4 + crisis)*
- **Pitch:** a fire on the fields / a blight ruins a staple at its source.
- **Mechanic:** pure economic-belief shock layered on a *visible* cause: pick a town,
  spike `priceBeliefs[food|wood]` across nearby folk (the `_crisis` mechanic,
  `director.js:323`) and fire a threat-flavored chronicle beat + set `town._alertUntil`
  (so caravans hold and the Watch stirs — channel-2 reuse). No terrain mutation needed.
- **Cost:** cheap→moderate. **Register:** THREAT/ECONOMIC. **Risk:** money loop (beliefs
  only, no inventory burn); anti-extinction (don't spike *food* so hard a town starves —
  the eat-survival lesson: food deficits are fatal; cap the multiplier).

---

## 3. SOCIAL / RELATIONAL register (the trope engine)

Belief-only, cheap, high drama-per-point. This is where the budget buys *texture*.

### S1 — Spark (feud-or-theft seed)  *(BUILT)*
- **Pitch:** two townsfolk come to mistrust each other.
- **Mechanic:** `_spark` (`director.js:347`) — sours belief-standing both ways (feud) or
  one way (theft). **Cost:** cheap. **Risk:** grudge-persistence (must latch `hostile` to
  stick — `_tropeFeud` does; raw `_spark` is transient by design).

### S2 — Feud → House feud  *(BUILT)*
- **Pitch:** deepen a simmering dislike into open, latched enmity — and if cross-House,
  set the lines against each other (inherited by children).
- **Mechanic:** `_tropeFeud` (`director.js:427`) + `setHouseFeud`. **Cost:** moderate.
  **Register:** SOCIAL. **Risk:** epistemic (belief-only ✓); anti-extinction (expressed as
  `rivalId` social competition, not auto-violence — keep it that way).

### S3 — Vendetta  *(BUILT)*
- **Pitch:** amplify a *real* grievance into a sworn, hostile-latched vendetta.
- **Mechanic:** `_tropeVendetta` (`director.js:463`) — only fires on a genuine grievance.
  **Cost:** moderate. **Register:** SOCIAL. **Risk:** epistemic ✓ (reads existing beliefs).

### S4 — Rival apprentices  *(BUILT)*
- **Pitch:** a master + two young neighbours → seed their rivalry to be the heir.
- **Mechanic:** `_tropeRivalApprentices` (`director.js:407`). **Cost:** moderate.
  **Register:** SOCIAL.

### S5 — Forbidden romance / courtship spark  *(NEW)*
- **Pitch:** the Director plays matchmaker — kindle attraction between two unbonded
  souls, especially across a House feud (the Romeo-&-Juliet seed).
- **Mechanic:** the inverse of `_sour`: *warm* mutual belief-standing (`b.standing += `,
  `confidence ≥ 0.4`) between two unbonded, fed, proximate townsfolk and optionally set a
  courtship hint the lineage system reads. Lineage already does weddings/`_wed` and
  `areHousesFeuding` healing (`drama-systems`); this just supplies the *spark* the way the
  trope engine supplies feud sparks. A cross-feud match that weds → `endHouseFeud` payoff.
- **Cost:** cheap. **Register:** SOCIAL/POSITIVE. **Risk:** epistemic (belief + flag only);
  freeze (guard `personality`/`mateId`); must not force births (only nudge — lineage owns
  gestation gating).

### S6 — Betrayal / the unmasked friend  *(PARTIAL — reuses intrigue)*
- **Pitch:** a trusted neighbour is revealed (or *framed*) as a wrongdoer.
- **Mechanic:** two flavours. (a) **Real:** trigger an existing spy's `intrigue._unmask`
  (`intrigue.js:154`) — drops the cover, latches the town hostile, fires the saga betrayal
  beat. (b) **Framed (pure deception):** `beliefs.plant` a false `suspicion`/`hostile`
  belief about an innocent into several townsfolk (the spy plant path, `intrigue.js`),
  which fades unless reinforced — a slander that may or may not stick. This is the cleanest
  showcase of the epistemic split.
- **Cost:** moderate. **Register:** SOCIAL/POLITICAL. **Risk:** epistemic is the *point*
  (belief-only ✓); freeze (guard belief store); the framed variant must remain *recoverable*
  (decay) so it can't permanently brick an innocent's social life.

### S7 — Schism (a faith splits)  *(NEW — reuses faith)*
- **Pitch:** a rival prophet rises preaching a *different* god, splitting a congregation.
- **Mechanic:** `faith.anointProphet(agent, preferGod)` (`faith.js:122`) but pass a
  *specific* god different from the dominant one, choosing a charismatic believer of the
  big flock as the new prophet — so the town now has two competing faiths. Belief-spread
  (`_spread`) then contests members; the social friction is emergent. Optionally `_sour`
  the two prophets for an open rivalry.
- **Cost:** moderate. **Register:** SOCIAL/FAITH. **Risk:** freeze (guard `sim.faith`
  existence — already done in `_tropeProphet`).

---

## 4. ECONOMIC register (shortages / booms / trade / the Gazette)

All move **price beliefs** or **transfer** purses. The Gazette → NPC-exploit channels
(`reporter-agent`) are the multiplier: an economic lever that publishes becomes a *plan*
other agents act on.

### E1 — Crisis (scarcity nudge)  *(BUILT)*
- **Pitch:** one staple grows dear across the town.
- **Mechanic:** `_crisis` (`director.js:323`) raises `priceBeliefs[good]`. **Cost:** cheap.
  **Register:** ECONOMIC. **Risk:** money loop (belief-only ✓); don't starve via food (E5).

### E2 — Caravan dispatch + ambush  *(BUILT)*
- **Pitch:** a laden inter-town caravan sets out; bandits lie in wait on the road.
- **Mechanic:** `_tropeCaravan`/`_advanceCaravans` (`director.js:550,643`) — escorts
  (warband guards + hearth porters), a leashed road ambush, windfall on safe return /
  shortage on loss (`combatEvents`). **Cost:** moderate (variable: it spawns ambushers,
  so price it `raidPerRaider · ambushers` like a mini-wave). **Register:** ECONOMIC/THREAT.
  **Risk:** all handled; note the open multitown follow-up (losses ~0 on the long road —
  retune leash/deadliness, not a new lever).

### E3 — Boom / windfall  *(PARTIAL — the caravan-return half exists)*
- **Pitch:** a sudden prosperity — a rich vein struck, a bumper harvest — makes a good
  plentiful and lifts the mood.
- **Mechanic:** `_caravanWindfall` (`director.js:664`) already lowers `priceBeliefs[good]`;
  generalize it into a standalone lever the budget buys *directly* (not only as a caravan
  payoff): pick a town, cheapen a staple across nearby folk, fire a FORTUNE beat, and
  optionally lift `mood.fear`/raise a little ambition. The relief register's economic twin.
- **Cost:** cheap. **Register:** ECONOMIC/POSITIVE. **Risk:** money loop (belief-only ✓).

### E4 — Bounty posting (the Gazette as an action surface)  *(PARTIAL — bounty hunting exists)*
- **Pitch:** the Director *commissions* a public bounty on a live nemesis/warlord; NPCs
  read it and ride out.
- **Mechanic:** the consumption side is BUILT — `js/sim/bounties.js` has free braves read
  Gazette OPPORTUNITY articles and hunt the named foe, paying from the giver's purse on
  completion (gold-conserved, `reporter-agent`). The *new* part is the Director **minting
  the contract**: post a quest-board hunt offer (the existing `QuestBoard` emergent/radiant
  path) targeting the active nemesis, so the threat the budget spent on (T2/coup) gets a
  matching player-and-NPC call to action. Couples THREAT spend → economic/heroic response.
- **Cost:** cheap. **Register:** ECONOMIC/FACTION. **Risk:** money loop (reward must come
  from a real giver purse / standing debt, never minted — the bounties path already does
  this); player-agnostic (NPC hunters race the player, first finisher wins).

### E5 — Famine relief convoy (anti-extinction *positive* economic)  *(NEW)*
- **Pitch:** a town in genuine food trouble receives an aid caravan from a neighbour.
- **Mechanic:** when a town's median food belief or larder is low, dispatch a caravan
  (E2 machinery) carrying `food` *toward* the struggling town; safe arrival fires the
  windfall on `food` there. This is the explicit safeguard the `eat-survival`/specialization
  finding said food trade needs — and it's a *positive* spend that also defuses the one
  fatal economic state.
- **Cost:** moderate. **Register:** ECONOMIC/RELIEF. **Risk:** anti-extinction (this is a
  *relief* lever — never the cause of scarcity); money loop (belief windfall, no minting).

---

## 5. FACTION / POLITICAL register (wars / coups / the watch / the patrician / intrigue)

The big-ticket, banked-toward spends. Climax-priced and tightly leashed.

### F1 — War / warlord  *(BUILT)*
- **Pitch:** a camp chief rises as a named warlord; the host marches; raids intensify
  until a hero fells the warlord.
- **Mechanic:** `_tropeWar` (`director.js:513`) — un-leashes the whole `_warCamp` host,
  nemesis-boss machinery, `DIRECTOR.war` multipliers, ends on warlord death with a saga
  beat + relief. **Cost:** climax. **Register:** FACTION. **Risk:** all handled; one war at
  a time; the floor (towers + minPop reprieve) survives it (verified). **The flagship
  thing the points budget banks toward.**

### F2 — Spy infiltration surge  *(PARTIAL — reuses intrigue)*
- **Pitch:** an enemy faction floods a town with disguised infiltrators planting rumours.
- **Mechanic:** the Director temporarily *boosts* `intrigue` activity — bump the plant
  rate / assign an extra disguised spy from the camp pool (`intrigue._assignSpies`,
  `intrigue.js:39`) toward a target town for a window. Pure deception substrate: cover
  names, `beliefs.plant`, `unmaskChance`. The Watch/heroes hunt unmasked spies.
- **Cost:** moderate. **Register:** POLITICAL. **Risk:** epistemic (this IS the deception
  path ✓); money loop (spies are gold-neutral camp bodies); freeze (guard `sim.intrigue`).

### F3 — Watch muster / martial law  *(PARTIAL — Watch is reactive today)*
- **Pitch:** the Director *pre-empts* — calls up the Night Watch ahead of a threat (or in
  response to unrest).
- **Mechanic:** the Watch is BUILT (`watch.js`) and already responds to published threats
  via `town._alertUntil` + `ALERT.watchBonus` (`reporter-agent` channel 2). The Director
  lever just *sets the alert* (or bumps the muster target) directly — useful as a
  *deliberate* counter-spend right before a banked raid lands, so the climax has defenders.
- **Cost:** cheap. **Register:** POLITICAL. **Risk:** freeze (guard `sim.watch`/`sim.towns`).

### F4 — Patrician decree / brokered peace  *(PARTIAL — Patrician is autonomous today)*
- **Pitch:** the town's Vetinari intervenes — forces a truce, exiles a troublemaker, taxes
  a windfall.
- **Mechanic:** the Patrician (`patrician.js`) already brokers the worst feud each cycle as
  a *counterforce* to the Director. The lever is the Director *commissioning* an
  intervention out of band: call `patrician._reconcile`/`_truce` on a chosen pair, or flag
  an agent for "exile" (a leash/anchor change that walks them out of town for a TTL). Lets
  the budget buy *de-escalation* deliberately, not just chaos.
- **Cost:** moderate. **Register:** POLITICAL/RELIEF. **Risk:** epistemic (belief standing
  edits ✓); freeze (guard `sim.patrician`).

### F5 — Coup / patrician assassination  *(NEW — climax)*
- **Pitch:** the established order is overthrown — the patrician is targeted, a faction
  seizes the town's leadership, alliances flip.
- **Mechanic:** the rare, banked political climax. Reuse pieces: latch a cabal of
  townsfolk + an intrigue spy hostile to the current Patrician-class agent (belief plant +
  `hostile`), trigger a `FACTION_RELATIONS` flip (ally↔enemy) so the world re-sorts, and on
  resolution either install a new figure (epithet/role flag) or restore order (relief). No
  new bodies required — it's a re-wiring of existing standing + faction relations.
- **Cost:** climax. **Register:** POLITICAL. **Risk:** anti-extinction (it's a leadership
  flip, not a massacre — cap any violence with TTL + minPop gate); epistemic (standing/
  faction-belief edits ✓); freeze (guard every faction/relation map access).

---

## 6. POSITIVE / RELIEF register (festivals / weddings / reconciliations / miracles / heroes)

The emotional contrast the pacing layer (`DIRECTOR.pacing`) proved the world needs. Cheap,
often *suppressed-into* during a relief window — but now also *buyable* with banked points.

### P1 — Relief / feast  *(BUILT — automatic, make it also buyable)*
- **Pitch:** the danger passes; the town feasts, fear lifts, old quarrels set aside.
- **Mechanic:** `_enterRelief` (`director.js:180`) — clears `mood.fear` on townsfolk, fires
  a FORTUNE beat, suppresses raids/crises for `reliefDuration`. Today it's *triggered by
  pacing*; expose it as a thing the budget can buy outright (a planned festival).
- **Cost:** cheap. **Register:** POSITIVE. **Risk:** none material (belief/mood only).

### P2 — Festival / market fair  *(NEW)*
- **Pitch:** a town holds a fair — folk gather at the market, trade briskly, bonds form.
- **Mechanic:** combine E3 (a transient buy-side price lift at the market) + a social pull
  (nudge nearby idle townsfolk toward the market POI for a window, raising co-location →
  more belief pairs → more emergent friendship/courtship). Reuses the localized-market hub
  + the `socialize` goal substrate. A FORTUNE beat datelines it in the Gazette.
- **Cost:** moderate. **Register:** POSITIVE/ECONOMIC. **Risk:** money loop (price beliefs
  only ✓); freeze (guard goal/`priceBeliefs`).

### P3 — Wedding  *(BUILT — automatic; expose as a positive beat the budget can favour)*
- **Pitch:** a union — and across a feud, an alliance that heals two Houses.
- **Mechanic:** lineage `_wed` (`drama-systems`) already narrates unions + `_allyHouses` +
  `endHouseFeud`. The Director can *favour* it by spending S5 (courtship spark) on a
  cross-feud pair, then letting lineage close it. **Cost:** cheap (via S5). **Register:**
  POSITIVE. **Risk:** don't force births (lineage owns gating).

### P4 — Reconciliation  *(BUILT — make it buyable like F4)*
- **Pitch:** long-standing rivals set strife aside and become friends.
- **Mechanic:** `lineage._reconcileRivals` / `patrician._reconcile` (`drama-systems`).
  Director-commissioned via F4. **Cost:** cheap. **Register:** POSITIVE/RELIEF.

### P5 — Miracle  *(PARTIAL — reuses faith)*
- **Pitch:** in a town's darkest hour, the dominant god answers — the faithful are healed
  and emboldened.
- **Mechanic:** the Director triggers an out-of-band `faith._miracles` pulse (`faith.js:101`)
  — heal + `mood.fear` relief scaled by flock size — timed to land *during* a raid/plague
  for maximum contrast. Reuses the existing miracle op exactly.
- **Cost:** moderate. **Register:** POSITIVE/FAITH. **Risk:** money loop (none); the
  STAKES lesson — miracle heal is deliberately weak (`FAITH.miracleHeal` 7→3) so it's a
  *boon not regen*; a Director-bought miracle must stay a pulse, not over-defend the town.

### P6 — Hero returns / expedition triumph  *(PARTIAL — reuses expeditions)*
- **Pitch:** a renowned captain rallies a warband, ventures to the wilds/a dungeon, and
  returns bearing a relic and a tale.
- **Mechanic:** `expeditions._form`/`_descend` (`expeditions.js:80,114`) is BUILT but
  demoted to rare flavour (compact world → bland always-wins). The Director lever is to
  *commission* one deliberately (call `_maybeForm` past its cooldown) — best as a relief
  spend when a banked threat has resolved, so the saga gets its denouement.
- **Cost:** moderate. **Register:** POSITIVE/EXPLORATION. **Risk:** all handled by
  expeditions (gold-neutral horrors, delve isolation Y-pocket, restore on return).

---

## 7. WORLD / EXPLORATION register (expeditions / dungeons / migrants / settlements / refugees)

The "the world is bigger than this town" register — strongest in the multi-town world.

### W1 — Opportunity (caravan / wanderer)  *(BUILT)*
- **Pitch:** a passing rich trader brightens the market, or a curious wanderer is nudged to
  roam and meet people.
- **Mechanic:** `_opportunity` (`director.js:299`) — price-belief lift OR a curiosity nudge.
  **Cost:** cheap. **Register:** WORLD/ECONOMIC. **Risk:** money loop (belief-only ✓).

### W2 — Migrant / newcomer  *(NEW)*
- **Pitch:** a stranger arrives seeking a place — a new face who joins town life.
- **Mechanic:** spawn ONE full townsperson-shaped Agent (the `_spawnRaider` factory
  pattern, but `faction:'townsfolk'`, a real personality, profession assigned, `gold=0` so
  no minting, tagged to a town's anchor). It then lives via the normal occupation/decide
  passes. A controlled trickle (gated by `popSoftCap`) — a *positive* counter to deaths
  that the budget pays for, distinct from births (no parents needed). Could carry a House
  to seed new dynasties.
- **Cost:** moderate. **Register:** WORLD. **Risk:** money loop (`gold=0`, transfer-only ✓);
  anti-extinction (it ADDS pop — gate to respect `popSoftCap` so it doesn't overcrowd);
  freeze (build it exactly like an existing townsperson; guard the document/mesh path).

### W3 — Refugees fleeing a raided town  *(NEW — multitown payoff)*
- **Pitch:** when one town is hit hard (war/raid/plague), survivors flee to a neighbour,
  carrying fear and rumour.
- **Mechanic:** the migrant lever (W2) *triggered by* a sister town's distress: re-anchor a
  few low-pop-town townsfolk (or spawn newcomers) to a neighbour town's anchor, carrying a
  high-`mood.fear` + a planted rumour about the threat they fled (epistemic: their *belief*
  travels). This is the explicit inter-town narrative payoff `open-world-multitown` flagged
  as the "real payoff to build." News/fear travels town-to-town with bodies.
- **Cost:** moderate. **Register:** WORLD/SOCIAL. **Risk:** anti-extinction (MOVING bodies
  between towns is pop-neutral overall — never deletes the source town below floor; gate on
  the source being genuinely distressed); freeze (guard anchor/`mood` access).

### W4 — A new settlement founded  *(NEW — climax, multitown)*
- **Pitch:** a charismatic leader leads a band off to found a new town on the frontier.
- **Mechanic:** the rare world-growth climax. A renowned captain + followers (the
  expedition/warband recruiting path) march to an empty `TOWNS`-adjacent frontier point,
  and on arrival the Director registers a new lightweight town anchor + re-anchors them to
  it (reusing `townAnchor`/`townId`). Defences (towers) and a market would need to ring it
  (`defenses.build` reads `sim.towns`). The `drama-systems` scaling finding says DON'T grow
  population for its own sake — so price this CLIMAX and gate it on a healthy world so it's
  an occasional epic, not a diffusion engine.
- **Cost:** climax. **Register:** WORLD. **Risk:** the scaling finding (bigger world =
  shallower stories) — keep RARE; freeze (guard the town-registry mutation heavily);
  determinism (no terrain-dependent code on the headless path).

### W5 — Dungeon rumour / delve  *(BUILT — reuses expeditions/dungeons)*
- **Pitch:** word of a relic in the deep sends a party underground; some return changed.
- **Mechanic:** `expeditions._descend`/`_advanceDelve`/`_endDelve` (`expeditions.js:114-242`)
  — the Y-pocket isolation trick, gold-neutral horrors, relic or "left below." Director
  commissions it (W6-style) past cooldown. **Cost:** moderate. **Register:** EXPLORATION.
  **Risk:** all handled (the `a.alive` getter bug is fixed; uses `fighter.alive=false`).

---

## 8. Summary — the 5 highest-value NEW levers to build first

Ranked by drama-per-effort: maximum new story surface for the least new code, every
constraint already satisfiable by reusing a system that's BUILT.

1. **E3 — Boom / windfall (standalone).** *Trivial effort, immediate value.* Generalize
   the existing `_caravanWindfall` (`director.js:664`) into a directly-buyable lever. Gives
   the ECONOMIC register a *positive* spend (today the budget can only buy economic *pain*
   via `_crisis`), and pairs with the pacing-relief register. Pure belief edit — zero
   constraint risk. Best ratio on the board.

2. **W2 — Migrant / newcomer.** *Low effort (the spawn factory exists), high value.* The
   budget's first lever that adds *positive population* on demand — a counter to deaths
   distinct from births, seeding new faces/Houses for every other social lever to act on.
   Reuses `_spawnRaider`'s gold-neutral spawn shape with a townsfolk config; only real care
   is the `popSoftCap` gate. Directly unlocks W3.

3. **W3 — Refugees fleeing a raided town.** *Builds on W2; delivers the headline multitown
   payoff.* `open-world-multitown` explicitly named "refugees fleeing a raided town" and
   "news/fear traveling town-to-town" as the real unbuilt payoff. Re-anchoring distressed
   bodies + a planted threat-rumour is a clean showcase of the epistemic split AND the
   inter-town world, and it's pop-neutral (anti-extinction-safe by construction).

4. **T4 — Plague / wasting sickness.** *Moderate effort, fills the empty environmental-
   threat slot.* A *non-faction, non-lethal* threat (fear + debuff + slowed work, TTL'd)
   is a genuinely new kind of pressure — and crucially it's the natural setup for P5
   (miracle) and F3 (watch) *response* spends, creating threat→relief arcs without spawning
   a single hostile body. The only discipline is keeping it strictly non-fatal (no HP
   drain) per the eat-survival/extinction lessons.

5. **F2 — Spy infiltration surge.** *Low-moderate effort, activates the dormant deception
   soul.* The intrigue substrate (disguise, `beliefs.plant`, cover names, `_unmask`) is
   fully BUILT but fires only ~1–2 times a game. A Director lever that *buys* a burst of it
   makes the ToM-deception core — the project's reason for existing — a thing the
   storyteller can deliberately stage, and it feeds S6 (betrayal) and F5 (coup).

### Cross-cutting insight

The richest design move isn't any single lever — it's that **the points budget lets the
Director compose levers into arcs across registers**: bank → buy a THREAT (raid/war/plague)
→ buy a POLITICAL response (watch muster, bounty posting) → spend the death-drain-induced
lull on RELIEF (miracle, festival, hero's return), with WORLD levers (refugees, newcomers)
carrying consequences between towns. The existing pacing layer already does a crude version
of this automatically (relief after a peak); the budget generalizes it into a *purchasable*
build-up→climax→denouement the storyteller authors deliberately. So the menu should be
designed as **pairs that set up and pay off each other** (threat↔relief, deception↔unmasking,
scarcity↔windfall, war↔hero), not as an undifferentiated list — that's what turns a points
budget from a difficulty dial into a storyteller. And almost every high-value addition is a
*new entry point into an already-built system*, because this codebase's emergent substrate is
deep and what's scarce — exactly as the scaling probe found — is the **spark**, which is what
the Director (and now the budget) exists to supply.
