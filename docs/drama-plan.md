# Plan: make the world interesting (paced, recovering, escalating drama)

Status: **BUILT + integrated** (2026-06 — all four parallel workflows landed; headless
green). Director (`js/sim/director.js`), Lineage (`js/sim/lineage.js`), Factions+intrigue
(`js/sim/intrigue.js` + 6 factions/`FACTION_RELATIONS`/`CAMPS` in simconfig), and the
Chronicle (`js/sim/chronicle.js` + `js/ui/chronicle.js`, toggle **N**) are all wired into
`simulation.js` as subsystems and exercised by `test/suites/soak.mjs`.

## Integration pass — fixes + open balance items (post-merge)
The four built in isolation; the *combined* world needed reconciliation:
- **FIXED — massacre regression.** The new bandit/rival `CAMPS` are faction-hostile to the
  town, but camp members fell into the *townsfolk* roam band (`act.js` wander) and drifted
  into the village, constantly hunting civilians — that, stacked on Director raiders spawning
  close (ring 26–44), wiped the town ~7% of runs. Fix: camps now PATROL their anchor
  (`campAnchor`/`patrolR`, a frontier lair — "not wandering mobs"), and the Director raid is
  gentler + valve-earlier (`minPop 6→9`, `perTownsfolk .18→.12`, `maxConcurrent 7→5`,
  `maxWave 4→3`, ring 34–50). 0 wipes in 200+ runs after.
- **FIXED — lineage soak flake.** Two fond townsfolk can emergently form a *warband*
  (`groups.js` sets `combatant=true`), and Lineage only bears children from a non-combatant
  pair → the deterministic sub-sim flaked to 0 births. The sub-sim now silences `groups.tick`
  + pins `combatant=false`, and guards the trailing `child0` read.
- **RESOLVED — the loop now pulses, and defence is structural.** Three changes:
  1. **Mate-bonds (`lineage.js`).** Births run off PERSISTENT couples (`a.mateId`) gestating on a
     *bond* basis (pause/decay only when a partner is unsafe/hungry/at-war), not a fragile
     every-frame proximity scan — so a peaceful town reliably grows and a besieged one stops.
  2. **Camp reinforcement (`simulation.reinforceCamps`, driven by the Director).** Camps top
     their ranks back up (gold-neutral) so the bandit/rival factions + spy pool ENDURE instead
     of self-annihilating.
  3. **Town watchtowers (`defenses.js`) + territorial leash.** This was the real fix: there was
     **no defensive advantage** — townsfolk fled and were picked off, so raid-count was a
     knife-edge between plateau and extinction (same config → A oscillated, B went extinct, C
     flatlined). Now the core is ringed with watchtowers whose killing power is FIXED
     (independent of civilian numbers) → the robust anti-extinction floor; and camps/monsters
     are LEASHED to their home ground (won't chase a victim into the village), so only the
     Director's TTL-limited raid WAVES assault the town. Result across seeds: town breathes
     ~22↔41, never extinct, factions endure, high birth/death churn (generational turnover).
Apprenticeship, intrigue, the Director event mix, and the Chronicle all work as designed.

Status (original): **direction locked** (decisions below); buildable design.

## Diagnosis
The long rollout showed only two states: **bland grind** (town survives, merchants slowly
level) or **massacre** (bandits wipe ~23 townsfolk in 2 min, then a dead world for 165 more).
Gaps: no pacing (all threat at t=0), no renewal (population only shrinks), all-or-nothing
fights (instakills, worsened by NPC casting).

## Thesis
The emergent **reaction** machinery is already excellent — memory → goals (avenge/grieve/
repay) → social groups → classes → biographies that read like war chronicles. The fix is on
the **input + persistence** side: paced events + a self-renewing population, and the existing
systems turn them into propagating story.

## Decisions (locked)
1. **Director = a LIGHT, config-driven nudge** — not a heavy scripted tension curve. Emergence runs; the Director just biases event probabilities (all tunable in config).
2. **Renewal = births + apprenticeship** (not migrants) — which also gives us a **mentorship** mechanic and its whole trope-space (prodigies, rival apprentices, the master's death, lineages, inherited grudges).
3. **Factional depth NOW** — multiple factions + the **intrigue / deception** layer (the original ToM soul: disguise, planted rumors, spies).
4. **The player is a WITNESS** — the drama is NPC/faction-driven and resolves *without* the player. Their one controlled body can poke around, but the world does not revolve around them. (This settles the recurring keystone and *simplifies* everything: no player-objective to design — the UI is the lens for watching.)

## Plan

### 0. Prerequisite — survivable conflict (already queued as the balance fix)
Fix AoE friendly-fire (bandits killing each other); de-lethalize (graduated threat, NPC cast
nerf, retreat/injury vs instakill) so a fight is a *wounded→flee→avenged→recover arc*.

### 1. The Director — light, config-driven (`js/sim/director.js` + `DIRECTOR` config)
Throttled. Each interval it rolls config-weighted event chances, gently modulated by
world-state (alive population, wealth, recent deaths, time-since-last-event):
- **Raids — scaled to POPULATION (the key knob).** Raid size/frequency rise with the number
  of living townsfolk (and wealth), arriving in **waves with lulls** (never the whole camp at
  once). This single rule does triple duty: the difficulty curve, the population control (a
  big town is culled back), AND the anti-massacre safety valve (a decimated town faces weak
  threats and gets a reprieve to recover). See the population feedback loop below.
- **Opportunities** — a rich caravan, a recruitable wanderer, a relic rumor.
- **Crises** — a scarcity shock, a sickness, a hard season.
- **Sparks** — a feud, a theft, a challenge.
Every event is a *seed*; the emergent systems propagate it. All weights/cadence in config so
"interestingness" is tuned, not coded.

### 2. Lineage: births + apprenticeship + mentorship (`js/sim/lineage.js`)
- **Births — gated on STABILITY.** A mutually-fond pair (a **hearth** group) produces a child
  over time, but ONLY while stable: safe (no recent danger nearby) + fed. So a town under
  siege stops having children, and a town at peace grows — the other half of the feedback loop.
  The child inherits a blend of parents' personality + a fraction of their behavior-tags
  (the spec's ~30% carry-over), so trades/temperaments run in families.
- **Apprenticeship** — a young/low-class agent apprentices to a high-class master of a trade
  (a **guild** bond); inherits ~30% of the master's profile tags, fast-tracking that class.
- **No aging.** We don't need lifespans/old-age death — **raid pressure is the population
  control** (§1), so generations turn over through *the drama itself*, not a clock.
- The payoff is **generational saga** straight out of existing systems: a killed parent →
  orphaned child → grows up → **avenges** them (grudge memory; the spec decays vengeance 5×
  slower); a master's prodigy surpasses then buries them; a lineage of smiths or a feud
  handed down. Mentorship + family map onto the **guild/hearth** social groups we already have.

### Population feedback loop (the heart of "ongoing drama, no massacre")
```
safe + fed → births → population ↑ → raids escalate → losses + instability
   → births pause → population ↓ → raids ebb → reprieve → recovery → (repeat)
```
The town **pulses** — prosperity / crisis / rebuilding — instead of grinding flat or dying
once. Both knobs (birth rate, raid-vs-population scaling) live in config, so the cycle's
amplitude and period are tunable.

### 3. Factions + intrigue (activate the dormant deception layer)
- **Factions** — stand up **3–4 at once** beyond town/monster: the **town**, an organized
  **bandit camp** (a leader + raid goals, not wandering mobs), a **rival settlement/clan**,
  and an **outsider** faction. Distinct hostility relations + goals; raids/intrigue flow
  between them.
- **Intrigue** — turn on the ToM deception the engine was built for: `BeliefStore.plant`
  already exists. Agents can **disguise** (perceived as another faction), **plant false
  rumors** (write false beliefs into others), and **spy**. A spy in the town, a planted rumor
  igniting a feud, a disguised infiltrator before a raid — *non-combat* drama from beliefs.

### 4. Consequence amplification (wire what we have, louder)
A death → witnesses' grief seeds a **revenge warband** that hunts the killers; a hero's
deeds → renown → **followers + leadership** → the band goes monster-hunting. Mostly tuning +
connecting memory/goals/groups/reputation so chains are strong and legible.

### 5. The chronicle (legibility) — a live event feed
Surface the war-chronicle histories we dumped headless, in-game: raids, deaths, vendettas
declared, prodigies rising, feuds, fortunes. The witness's lens.

## Sequencing (rides on the queue)
`0 survivable conflict` → `SRP refactor` (already planned; it makes the rest **parallel**) →
then, as **parallel workflows** (the refactor's payoff): `Director`, `Lineage`,
`Factions+intrigue`, `Chronicle`.

## Resolved
1. **No aging** — population is controlled by **population-scaled raid pressure** instead.
2. **Factions** — stand up **3–4 at once**.
3. **Births** — **gated on stability** (safe + fed).

The plan is fully spec'd; it queues behind the survivable-conflict fix and the SRP refactor,
after which the Director / Lineage / Factions+intrigue / Chronicle build as parallel workflows.
