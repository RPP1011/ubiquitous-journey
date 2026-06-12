# 04 — Drama, society & emergent narrative

> The systems that make the world *feel* alive: a story director, dynastic lineage,
> spies, peacekeepers, civic guards, small gods, adventuring parties, and the
> chronicle that records it all. Every one of them seeds or reads **beliefs**, not
> ground truth, so the [epistemic split](02-epistemic-split.md) holds end to end.

## Shared shape

All of these live in `js/sim/`, are constructed once in the `Simulation` constructor,
and run as a guarded fixed-tick pass (see the pass order in [01](01-sim-spine.md)).
Each has a config block in `js/sim/simconfig.js` — **tune there, not in logic.** Each
is **self-throttled** (internal accumulator, skips below its `tickEvery`) and **fully
guarded** (a throw logs, never freezes the tick — the freeze lesson). None of them
mint gold.

| System | File | Config | Role |
| --- | --- | --- | --- |
| Director | `director.js` | `DIRECTOR` | drama seed engine (points budget + tropes) |
| Seeding | `seeding.js` | `SEEDS` | plant initial relationship constellations at build |
| Lineage | `lineage.js` | `LINEAGE` | births, apprenticeship, reconciliation |
| Migration | `migration.js` + `features/migrate.js` | `MIGRATE` | the emigration valve against multi-town population skew |
| Houses/Epithets | `houses.js` | `HOUSES`, `EPITHETS` | surnames, dynastic feuds, earned names |
| Intrigue | `intrigue.js` | `INTRIGUE` | disguise, stealth, spies, false rumours |
| Patrician | `patrician.js` | `PATRICIAN` | diegetic peacekeeper, brokers truces |
| Watch | `watch.js` | `WATCH` | Night-Watch civic guard, musters to threats |
| Defenses/Walls | `defenses.js`, `walls.js` | `DEFENSE` | watchtowers + collision-only town walls |
| Faith | `faith.js` | `FAITH` | belief-powered small gods |
| Expeditions | `expeditions.js` | `EXPEDITION` | NPC adventuring parties that delve |
| Chronicle/Biography | `chronicle.js`, `biography.js` | `CHRONICLE` | world history feed + per-agent bios |
| Groups | `groups.js` | `GROUP_TYPES`, `BAND`, `GROUP_NAMES`, `COHESION` | named groups/bands that live their bond |

## Director (`director.js`, `DIRECTOR`)

A light, config-weighted **drama seed engine** — not a story scripter. On a slow
throttle it spends from a **points budget** (`_points`, accrues with prosperity,
drains on deaths) to inject situations the existing systems then propagate:
`_spawnRaiders` (combatants spawned with **zero gold** — no minting; transient waves,
not sieges, and capped so they never swarm), `_spawnOpportunity` (a trader caravan),
`_sparkFeud` / `_sparkTheft` (seed mutual negative *belief*-standing or a theft that
mints nothing), `_crisis` (nudge a few price *beliefs*), and `rollTrope` (fire a
major arc-closure beat). It only ever plants beliefs, never ground-truth hostility.

**SRP module layout.** `director.js` is now a thin **state + orchestration** shell
(constructor, the guarded `tick`, shared belief/util helpers, and one-line delegators);
behaviour lives in `js/sim/director/*.js` as free functions over the instance `d`, so
every `this._foo()` call site (and the external `_recordSaga`/`_enlistGuardian` callers
in `combatEvents.js`) is unchanged: `raids.js` (waves/raider lifecycle/warlord/nemesis),
`roll.js` (points budget + weighted roll + tension/relief pacing + light nudges),
`tropes.js` (the dispatcher + ~20 instigators), `arcs.js` (multi-beat arcs + sagas),
`roles.js` (bodyguard/duel/protégé/guardian/legend/avenger), `caravans.js` (trade runs),
`util.js` (`rand`/`clamp`).

**Spotlight casting** (docs/architecture/13 F.`quietIndex`'s consumer): trope instigators
fire on the *first* matching constellation they scan, so their candidate pools are ordered
by `Director._spotlight` — `quietIndex` (sim-time since the agent was last chronicle-named)
plus `DIRECTOR.spotlightJitter` seconds of uniform noise, longest-quiet first. The
long-unnamed get first crack at trope roles, rotating the spotlight into the gray mass
instead of re-casting whoever drama already found (measured before: 86% of multi-arc agents
entered their first arc in the first third of a run). Observer-layer: casting, not cognition.

Deep design notes: [`docs/director-levers.md`](../director-levers.md),
[`docs/drama-plan.md`](../drama-plan.md), [`docs/trope-catalog.md`](../trope-catalog.md).

## Seeding (`seeding.js`, `SEEDS`)

Runs **once** from `Simulation.spawn()` to plant initial conditions that grow into
recognisable tropes — giving the Director material to escalate. The shipped seed is
**rival apprentices**: a seasoned master (armed with a pre-validated catalog ability)
plus two apprentices who resent each other (mutual negative belief-standing + durable
`rival` bond memories), with a chronicle beat noting the premise. Helpers:
`makeTownsperson`, `seedProfile` (set a behaviour-tag fingerprint), `grantSeededClass`,
`sour` (negative belief-standing), `bond` (durable memory bond). Guarded — a bad seed
never aborts world build.

## Lineage (`lineage.js`, `LINEAGE`)

Population renewal without aging, on two threads:
- **Births** — a mutually-fond, SAFE-and-FED pair bears a child who inherits ~30% of
  each parent's behaviour tags. Soft-capped at `LINEAGE.popSoftCap`; Director raids are
  the real population control. Gold is **moved** (small dowry debited from a parent),
  never minted; children usually start at 0 gold.
- **Apprenticeship** — a young/low-level townsperson copies ~30% of a nearby
  high-class master's dominant tags, fast-tracking that class. `_surpass` marks when an
  apprentice out-levels the master; `_reconcileRivals` lets long feuds heal into peace.

Births/apprenticeships check *belief*-standing, never ground-truth faction. Houses
(below) give children their surname.

## Houses & Epithets (`houses.js`, `HOUSES`/`EPITHETS`)

- **Houses** — each founding townsperson heads a house; children carry the surname
  down the bloodline ("Aldric Vael"). A feud between two houses persists across
  generations (`areHousesFeuding`/`setHouseFeud`) until a cross-house marriage heals it.
- **Epithets** — distinction earns a name. A foe who slays ≥`EPITHETS.villainKills`
  becomes a dread nemesis; a townsperson who fells ≥`heroKills` a hero; a coward who
  survives ≥`escapesForLegend` a "Rincewind". Granted from `combatEvents.js`
  (`grantEpithet`) on kills/escapes.

## Intrigue (`intrigue.js`, `INTRIGUE`)

The deception layer made concrete (the payoff of the epistemic split):
- **Disguise** — a spy carries `disguiseFaction`; perception writes the *perceived*
  faction into observers' beliefs while combat reads the *true* one.
- **Plant rumour** — a spy near a townsperson calls `BeliefStore.plant` to write a
  **false** hostile belief about a third party (low confidence, rumour provenance).
- **Spy behaviour** — a `spy` goal branch in `decide`/`act`: scout toward the town
  core → plant → exfiltrate to the camp anchor.

Spies are drawn from existing camp bodies (no new spawns, no minted gold) and
`_assignSpies` is idempotent. Only beliefs are falsified; combat always reads true
factions. Inert if disabled or there are no camps/townsfolk.

## Patrician (`patrician.js`, `PATRICIAN`)

A diegetic peacekeeper (Vetinari). The Director makes drama; the Patrician *manages*
it — not removing tension but keeping the city whole. Each interval `_broker` finds the
most mutually-hostile townsfolk pair and either `_truce` (pull standing toward neutral,
un-latch hostility) or `_reconcile` (turn standing positive, record a bond). Belief-only,
touches no gold, fully guarded.

## Watch (`watch.js`, `WATCH`)

A Night-Watch civic guard (the City Watch). Brave townsfolk are re-flagged
(`combatant=true`, `canWork=false`, leashed to the town core) and **muster** in
proportion to perceived threat near the core, standing down (with hysteresis, so it
doesn't thrash) in peace. A Gazette threat **alert** triggers an immediate muster
bonus. `_captaincy` elevates the strongest watchman to Captain (a rising "Vimes").
Reuses existing combat/leash; touches no gold.

## Defenses & Walls (`defenses.js`/`walls.js`, `DEFENSE`)

Each town core is ringed with **watchtowers** that fire on the nearest town-hostile
body within range on a cooldown. **Crucially, tower killing power does *not* scale with
population**, so a decimated town can still hold its core and rebuild (a robust floor).
Towers read *perceived* faction (a disguised spy fools them); combat elsewhere reads
true faction. **Walls** are stone rings with evenly-spaced gates — collision-only
geometry (like dungeon walls), routed around by `movement.js`. Built only for real
spawned towns, never in bare test sub-sims.

## Faith (`faith.js`, `FAITH`)

Discworld-style **small gods**: a god's power *is* its believer count. The faithful
proselytise (conversion odds rise with the god's power), some lapse (except a small
god's last believer, who stays loyal), and gods work **miracles** (heal + courage)
scaled by flock size — a belief → power → miracle → thrive → more-belief loop. An
agent's faith is `a.faith`. A nearly-dead god can be revived by the Director anointing
a prophet. Touches no gold.

**The pantheon contends — the bandwagon is tamed** (the Blind-Io-monoculture fix): each
believer already rolls conversion independently, so a *linear* per-believer bonus made
total pull ~flock² and one god always swept the town (measured: 126/140 one god). The
bandwagon bonus is now **per √believer** (`powerConvertBonus`), and **crowding doubt**
(`crowdDoubtAt`) scales the lapse rate up with flock size — a god grown great holds many
in name only. Great gods still dominate; they no longer extinguish the pantheon.

## Expeditions (`expeditions.js`, `EXPEDITION`)

NPC adventuring parties — the DF-adventurer / M&B arc for the townsfolk. A renowned
captain rallies a brave company (reusing the warband/groups follow path), marches out
to hunt the wilds or, more often, **delves** underground into an isolated Y pocket
(`EXPEDITION.delveDepth` ≈ −900, see [06](06-world-dungeons.md)), and returns in triumph or
broken. The captain's movement uses a dedicated `expedition` goal. Off-screen delves
are narrated through the chronicle. Gated on a real spawned town.

## Chronicle & Biography (`chronicle.js`/`biography.js`, `CHRONICLE`)

The world's live drama feed. The Chronicle **subscribes to the deed bus** (like
[xpstats/econstats](05-economy-news.md)) and distils the firehose down to *notable*
beats — kills, deaths, vendettas, prodigies rising, fortunes — plus raid/birth beats
polled from Director/Lineage counters. It keeps a bounded `_ring` (~80 beats) plus a
longer-lived `_legends` saga of the truly momentous, with a `_dedupe` window and a
`_seq` id for cheap UI change-detection. Pure capture: it reads state read-only and
never influences behaviour. `biography.js` exposes `agentBiography()`/`agentDrive()`
for per-agent narrative summaries. Surfaced by the [Chronicle UI](07-ui.md) (`N`).

## Groups (`groups.js`, `GROUP_TYPES`/`BAND`/`GROUP_NAMES`/`COHESION`)

Parties-as-AI generalised beyond the player. Townsfolk with mutual positive
belief-standing who are near each other associate into a **warband** (roam + fight),
**hearth** (stick together, flee danger), **guild** (same primary class, loose
professional cluster), or **circle** (friends, loose social cluster). "Travel" groups
flip `inParty` and reuse the follow path pointed at their own leader (no new AI fork);
"loose" groups are an affiliation tag. Members' mutual affinity grows while grouped
(capped). Never touches a player-led party — that's [`party.js`](06-world-dungeons.md).

**Groups LIVE their bond (Phase B2)** — membership was nearly inert (a flat socialize
×1.6 nudge + a relations tag); now each type pulls members toward the group's *life*,
tuned per type via `GROUP_TYPES[type].pull` (config, not logic):

- A **circle** gathers — its socialize candidate gets the pull (2.2), and a member
  with no chosen friend **converges on the believed anchor**: its OWN belief of its
  OWN `bandLeaderId` (the `resolveLeaderRef` pattern, no roster read; the anchor
  itself stays put as the gathering point). Belief-gated convergence — a member whose
  track of the anchor decays drifts off, honestly.
- A **guild** works its shared trade — the work candidate gets the pull (1.5; the
  craft IS the bond) and keeps the fraternise nudge.
- A **hearth** shelters TOGETHER — `decideParty`'s flee resolves to the shelter/rest
  place nearest the *believed* leader (own belief + the static map; `fillFlee` already
  honours a `toPos`), so the pair converges on ONE refuge instead of scattering.

**Named fellowships with saga arcs (Phase B3)** — a fresh emergent group coins a NAME
at formation (`GROUP_NAMES` pools, drawn via the seeded `rng()`; flavour only, no
mechanics), and every join files a round on a `fellowship` saga arc — **lazy-open via
`SagaStore.appendRound`** (a never-joined group files no tale; the warband-muster
churn lesson), keyed `fellowship:<type>:<anchor>` (disjoint from the recruiter's
warband muster arc). Dissolution — leader gone, or dwindled to one — closes it
`'disbanded'`. A band/guild/circle is now a CHARACTER in the chronicle ("Aldric joined
the Hearthside Circle of Wenna"). **A living fellowship is not a lapsed tale** (the
endures fix): the group keeper re-arms every living group's open arc on its formation
cadence (`SagaStore.touchArc` — TTL only, no beat), because a fellowship files rounds
only on joins, so a stable group that stopped recruiting used to read as a story that
petered out (`'lapsed'`) while its hall still stood. Only real dissolution files an
ending. Observer-layer only; guarded.

**The instrument**: `groupCohesion(sim)` (`js/sim/signals.ts`) is the truth-side
observer metric — per group ≥ 2 members, `clamp01(1 − meanPairwiseDist /
COHESION.refDist) × coActFrac` — printed by `test/behaviortrace.mjs`
([08](08-testing.md)). Honest history: at B2-landing it read 0.09/0.05 (the pull lost
to comfort/market/ambition too often); driving personality through the **need drains**
(social×social_drive, novelty×curiosity — score-only multipliers proved too weak
because the candidate rarely existed to be scaled) lifted it to ~0.23, ~2× the
pre-B2 baseline.

The idle-time *individual* counterpart — an agent pursuing its standing ambition
instead of wandering — is the persistent-ambition layer in
[09](09-reasoning-layer.md).

**The Guildhall (`HALL`).** A named fellowship gets a PLACE: a loose group that has
endured (≥ `HALL.minMembers` members for ≥ `HALL.minAgeSecs` since formation) and
whose anchor holds `HALL.woodCost` wood commissions a `guildhall` near the town core
through the same public-works machinery as the tavern (`commissionPublic` → CityGrid
plot + ambient town labour; the anchor's wood is banked into the site — conserved, no
minting). On completion Groups stamps `groupHallId` on the anchor and every member
(execution side, like `groupName`); cognition only ever reads the own-state stamp plus
the member's OWN place-belief of that building (discovered by sight, the `homeBeliefId`
pattern), so decide's loose-group block converges the socialize candidate on the HALL
(`toPos`, honoured by `fillSocialize`) instead of the anchor's wandering person — a
fixed gathering point that measurably lifts `groupCohesion` (signals.ts). Dissolution
clears the stamps; the hall persists as a town building (abandoned halls are flavour).

## Cross-cutting invariants

1. **No minting.** Raiders, reporters, and gazetteers spawn with 0 gold; dowries are
   moved, not created. The economy stays a [closed loop](05-economy-news.md).
2. **Beliefs, never ground truth.** Every system above seeds or reads beliefs/standing.
   This is what lets the Director, Intrigue, and rumour all interoperate.
3. **Self-throttled + guarded.** Each pass skips below its `tickEvery` and never throws
   into the fixed tick.
4. **Population bounded** by `LINEAGE.popSoftCap` + Director raids; town defense has a
   population-independent floor so towns can't be permanently wiped.
