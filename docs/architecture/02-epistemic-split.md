# 02 — The epistemic split (why deception works)

> The single most important invariant in the codebase. If you internalise one
> thing, make it this. Everything theory-of-mind — gossip, disguise, spies, rumour,
> grudges — is a consequence of this one rule.

## The rule

```
DECISIONS read BELIEFS.        EXECUTION reads GROUND TRUTH.
```

- **Decisions** — `Agent.decide`, `Agent.perceive` (*write* side), `Agent.gossipBeliefs`,
  `chooseOccupation`, the goal/planner layer — read an agent's `beliefs` and
  `priceBeliefs` only. They never read another agent's true `faction`, position, or
  inventory directly.
- **Execution** — `combat.js`, movement, production, `Simulation.isHostile` — read
  ground truth: actual factions, actual positions, actual HP.

Because the two halves read different sources of truth, an agent can be **genuinely
fooled** — act on a false belief — while reality still resolves correctly. A spy in
disguise is *believed* friendly (so no one attacks it on sight) but combat, if it
ever happens, resolves on its *true* faction. That gap is the entire deception layer.

## The two hostility predicates (do not conflate them)

| Predicate | File | Reads | Used at |
| --- | --- | --- | --- |
| `Agent.considerHostile(belief)` / `Agent._nearestHostile(ctx)` | `agent.js`, `agent/decide.js` | **beliefs** (latched-hostile flag + believed faction) | decision time — "who do I *think* is a threat?" |
| `Simulation.isHostile(a, b)` | `simulation.js` | **ground truth** (true faction relations + latched-hostile belief + player reputation) | combat time — "does this blade actually connect as an attack?" |

`Agent._nearestHostile` chooses *who to approach/flee*; `Simulation.isHostile` (called
from `resolveCombat` in the frame loop) decides *whether a landed blade counts as a
hit*. Allies' swings pass through each other because `isHostile` returns false; a
disguised spy is skipped by `_nearestHostile` because the believed faction looks
friendly.

## How beliefs are stored (`js/sim/beliefs.js`)

`BeliefStore` is the spec's per-`(observer → subject)` N² table: each observer holds a
bounded map of `subjectId → BeliefState`. Bounded by `SIM.beliefsPerAgent`; overflow
evicts the least-certain, stalest entry.

`BeliefState` fields:

```
subjectId      who this is about
lastFaction    BELIEVED faction — may be a disguise, not the truth
lastPos        believed position (where I last SAW it)
heading        last-seen UNIT direction of motion (observed; drives destination-intent)
destId/destPos believed DESTINATION a lost quarry is making for (static geography) — see below
intent         'flee'|'raid'|'home'|null — why it's headed there
notoriety      believed PLAYER fame (the fear gate; written by perception)
lastTick       when last updated
confidence     0..1, decays over time
hostile        do I think this subject is hostile? (latches via combat)
suspicion      0..1, "something is off" — can curdle into false hostility
standing       -1..1, my opinion of them (gossips + decays)
source         SOURCE.WITNESSED | TALKED | RUMOR tag
hops           provenance depth: 0 = first-hand, caps at HEARSAY.maxHops
rumorBorn      true if this hostility curdled out of gossip rather than a sighting
```

Key `BeliefStore` methods:
- `observe(subjectId, perceivedFaction, pos, tick, hostile)` — a first-hand sighting,
  confidence 1.0, hops 0. **Note it records `perceivedFaction`** — perception passes
  `o.disguiseFaction || o.faction`, which is where disguise enters the belief table.
- `mergeFrom(other, SOURCE.*)` — gossip merge: capped confidence, faded by hop, garbled.
- `plant(subjectId, {...})` — deception write (spy planting a false hostile belief).
- `decay(dt)` — per-second confidence/suspicion fade.
- `erase(subjectId)`.

Provenance helpers `provenanceLabel(b)` / `provenanceTag(b)` turn `hops` into the
inspector's "seen first-hand / heard from a witness / secondhand / a thirdhand rumour
/ a tale much retold" text.

## The three belief passes, in tick order

The fixed tick runs `perceive → decay → gossip → decide` (see [01](01-sim-spine.md)).
That ordering is the epistemic split in motion:

1. **`perceive(ctx)`** (`agent/perception.js`) — reads ground-truth agents, **writes
   beliefs only.** Gated by terrain vantage (`terrainHeight × SIM.vantagePerMeter`)
   and concealment (`concealmentAt(pos)`), so cover and high ground change *who you
   can know about*, not just who you can hit. Writes `o.disguiseFaction || o.faction`
   — disguise is laundered into belief here.
2. **`beliefs.decay(step)`** — confidence and suspicion fade, so unrefreshed knowledge
   grows uncertain and eventually drops out of the bounded table.
3. **`gossipBeliefs(ctx)`** — adopt a friendly neighbour's *higher-confidence*
   beliefs. Merge confidence is capped (`min(other.conf × SIM.gossipFalloff, …,
   SIM.gossipCap)`), `hops` increments (capped at `HEARSAY.maxHops`), and the content
   is **garbled** by `_garble`:
   - Mild opinions (`|standing| < HEARSAY.chargeThresh`) spread undistorted but damped.
   - Charged opinions are sticky and exaggerated; bad news outgrows good ("the
     telephone game").
   - At `hops ≥ 2`, a sufficiently negative standing (`≤ -HEARSAY.tipStanding`) can
     **curdle suspicion into false hostility** with chance
     `min(0.5, HEARSAY.tipChancePerHop × (hops-1))`. This is how an unfounded rumour
     turns into a real, fought-over feud.
4. **`decide(ctx)`** — utility argmax over the belief table only.

## How combat folds back into beliefs (`js/sim/combatEvents.js`)

`Simulation.onCombatEvents(events)` is the return path: ground-truth combat outcomes
become belief updates (and RPG deeds, reputation, memory). For each `hit` / `blocked`
/ `dead` event:

- **Belief nudge** — the victim and nearby witnesses latch `belief.hostile = true`
  toward the aggressor. **This is what breaks a disguise**: a spy that attacks is now
  *known* hostile by everyone who saw it, regardless of its costume.
- RPG deeds emitted to the bus (`strike`/`kill`/`block` verbs, MELEE/KILL/RISK/DEFENSE
  tags) → progression XP (see [03](03-rpg-abilities.md)).
- Lifetime tallies (`a.life.kills`, `a.life.monsterKills`), epithet thresholds,
  player reputation credit, vendetta-closure chronicle beats, and witness memory
  episodes.

## The planner respects the split too (`js/sim/planner.js`)

The GOAP layer plans over beliefs, not truth:
- `believedPos(agent, ctx, place)` resolves a target to the nearest POI or the
  subject's *believed* `lastPos` — **belief-only, no roster fallback** (a subject with no
  confident belief is an unknown place → the plan fails and replans).
- `travelCost(agent, ctx, place)` adds a route-risk surcharge for *believed*-hostiles
  near the destination — so an agent routes around enemies it *thinks* are there, and
  can be wrong (planted rumour → detour around a phantom threat). Plans that fail
  against ground truth simply replan.
- `believedDead(agent, subjectId)` (the `dead`/`in_reach` atoms, the `attack` step effect,
  `goalAvenge.predicate`) reads the agent's own `_slain` bridge signal + belief absence —
  never a foreign `.alive`. See the `_slain` death bridge above.

## Why it's built this way (rationale)

Theory-of-mind is the whole point of the project: NPCs that act on a *model* of the
world rather than the world itself. Keeping decisions belief-only and execution
truth-only means deception is **emergent, not special-cased** — there is no "is this
agent fooled?" branch anywhere. Disguise works because perception writes a false
faction; rumour works because gossip writes false hostility; spies work because their
true faction only matters once a blade lands. Collapse the two sides into one source
of truth and every theory-of-mind feature silently dies.

## Structural enforcement — restricted ctx + the build-time scan

The split is no longer a convention you must remember; it is **enforced two ways** (belt
and suspenders).

### Suspenders — the restricted cognition ctx (`simulation.js`)

`Simulation.update` builds **two** context objects and hands them to different layers:

- **`_ctx()` — the FULL bridge ctx** `{ agents, agentsById, world, time, player, playerId,
  buildSites, cities, resolver }`. Handed ONLY to the sanctioned reality-touch +
  orchestration code: `perceive` / `gossipBeliefs`, `onCombatEvents`, the combat resolver,
  and the subsystem ticks. These legitimately read ground truth to *write beliefs* or
  *resolve physics*.
- **`_cognitionCtx()` — the RESTRICTED ctx** `{ world, time, buildSites, cities, playerId,
  partyLeader, resolver }`. Handed to `a.decide(ctx)` and `a.act(dt, ctx)`. It carries **no
  `agents`, no `agentsById`, no `player` object** — so a roster scan/lookup in cognition
  has *nothing to dereference*. Truth is **structurally unreachable** from the decision and
  execution-of-decision code.

The few legitimate cross-agent needs cognition still has are met without the roster:

| Need | How cognition gets it (no roster) |
| --- | --- |
| Player-fear gate | `ctx.playerId` (a scalar) → the agent's OWN `beliefs.get(playerId)`; perception writes a believed `notoriety` field. An NPC who never saw the player feels nothing. |
| Duel / avenger / bounty / spy targets | resolved through `a.beliefs.get(id)` (lastPos / lastFaction / confidence), or `resolver.isLiveAgent(id)` / `resolver.nearestVisibleOfFaction(...)`. |
| Companion leader pos | NPC band → `a.beliefs.get(a.bandLeaderId).lastPos`; the player-led party only → `ctx.partyLeader` (a documented controlled-leader exception, marked `// EPISTEMIC-OK:`). |
| Ability casting | `ctx.resolver.castTarget(observer, id)` (real body only when vision-confirmed) + `ctx.resolver.cast(spec, caster)` (interpreter resolves area/range over the true roster *inside the sim* — geometric execution, like combat). |
| Trade / transfers | `ctx.resolver.marketClear(a, good, side)` and `ctx.resolver.deliverTo(from, toId, payload)` perform the conserved transfer against whoever is actually at the market / co-located, and fire the *receiver's own* succour/standing hooks. The agent never reads `cp.gold` / `to.inventory`. |

The **resolver** (`Simulation._cogResolver()`) is a narrow facade: cognition holds only its
methods (`perceive`, `castTarget`, `cast`, `nearestVisibleOfFaction`, `enemyNearLeader`,
`seenPos`, `isLiveAgent`, `marketClear`, `deliverTo`) — never the internal `agentsById` it
closes over — so it cannot scan or dereference arbitrary entities. Every method is
vision-/conservation-gated and guarded (never throws on the tick).

### Belt — the static source scan (`test/suites/epistemic.mjs`)

`epistemicScan(ok)` is wired **first** into `test/headless.mjs` (the project's "build"). It
reads each cognition/execution source file as text, strips comments + strings, and FAILS on
forbidden ground-truth access:

- the handle regexes `ctx.agents`, `ctx.agentsById`, `ctx.player` (but `ctx.playerId` is
  allowed), `sim.agents(ById)`;
- a secondary belt: a foreign TRUE-STATE deref (`.alive` / `.faction` / `.inventory` /
  `.gold` / `.notoriety` / `.priceBeliefs` / `.needs`) off a local conventionally named for
  another entity (`o`, `foe`, `target`, `leader`, `cp`, `to`, …). `.pos` is deliberately
  NOT flagged — a belief reference (`_nearestHostile`'s `{ id, pos: lastPos }`) and a
  resolver snapshot both legitimately carry one, and a foreign agent's *true* `.pos` is only
  reachable through the (already-banned) roster handles.

Scanned (must be clean): `decide.js`, `act.js`, `movement.js`, `occupation.js`, `trade.js`,
`motivation.js`, `planner.js`, `agent.js`, `mentalmap.js` (the shared static places registry —
static-geography reads only), and the **reasoning layer** `schemas/{ir,vocab,interpreter,
catalogue}.js` (Phase 2a — the schema evaluators read only the agent's own beliefs/state/map).
Allowlisted (the sanctioned bridge/resolver/
orchestration): `perception.js`, `combat.js`, `combatEvents.js`, `simulation.js`. A
deliberate carve-out on a single line is self-documented with a trailing
`// EPISTEMIC-OK: <reason>` marker the scan recognises and skips (used only for the
controlled-party-leader reads). The suite also asserts the **structural** property: that
`simulation.js`'s `_cognitionCtx()` literal hands cognition no `agentsById:` / `player:`
handle. Belt (scan) + suspenders (restricted ctx) are both verified by the gate.

> **Known debts (the gate's blind spot) — both RETIRED in Phase 2a.** Belt + suspenders
> catch cognition *reading* truth; they could not catch the world *writing* cognition state
> nor a sanctioned ctx field carrying dynamic truth. The two named instances are now closed by
> **places-as-percepts**: (1) the instant `owner.home = null` on shelter loss is gone — a
> building is a **percept** (namespaced id `B:<n>`) the owner DISCOVERS by sight (binding
> `homeBeliefId` to a `placeKind:'home'` belief with a believed `sheltered`), and discovers the
> LOSS by perception or by belief decay (no percept) — never telepathically; (2) the comfort
> branch no longer live-queries `buildSites` — `nearestComfortSource` reads the owner's home
> *belief* (trusted while believed-intact and fresh) else a STATIC shelter/rest Place. The world
> systems (raid/ruin/construction-demand) still read ground truth — only the agent's *knowledge*
> of its home is belief-gated. See [09 — known debts](09-reasoning-layer.md#known-debts--leaks-the-gate-cannot-catch).

## Destination-intent pursuit (Theory of Mind, not dead-reckoning)

When an agent loses sight of a quarry it is pursuing it does **not** extrapolate a velocity
vector. The old `BeliefState.vel` field is gone; in its place:

```
heading   last-seen UNIT direction of motion (observed, set in observe())
destId    believed DESTINATION key (a landmark name) or null
destPos   resolved world pos of that destination (STATIC geography) or null
intent    'flee' | 'raid' | 'home' | null
notoriety believed player fame (the fear gate)
```

- `inferDestination(observer, belief, intent, map, now)` (`beliefs.js`) — called from
  perception (`inferLostQuarries`) when a tracked subject leaves sight — runs an argmax over
  the observer's **mental map** (`MentalMap`, the shared static places registry — town
  gates / POIs / arena landmarks, `js/sim/mentalmap.js`), scoring each known place by
  `headingMatch × MAP.wHeading + intent-conditional affordance bonus × MAP.wAfford −
  distance × MAP.wNear`. The affordance term is intent-conditional: a `flee` quarry is drawn
  to places that `affords('exit','conceal')`, a `raid`/`hunt` quarry to a `crowd`. Falls back
  to "keep going along the heading toward the frontier" or "stand and search at the last
  sighting". The chosen destination is **cached on the belief** (`destId`/`destPos`/`intent`/
  `destInferredAt`) for `MAP.destTTL` seconds and re-inferred only on lapse; a re-sighting
  (`observe()`) clears it (contradicting-perception invalidation). It reads only the static
  shared `map` + the belief itself — no live roster. Tuning lives in `MAP` (`simconfig.js`).
- `combatStep` (`act.js`) navigates the pursuit: while the belief is **fresh** (confidence
  ≥ `SIM.reacquireConf`, just sighted) it closes on `lastPos`; once the belief goes **stale**
  (out of sight, below `reacquireConf`) it intercepts at `destPos` instead. `resolver.perceive`
  re-acquires the quarry the moment it comes back into sight (resetting `lastPos` + clearing
  `destPos`); if it never reappears the belief decays and the pursuer breaks off.

This catches a quarry that flees toward an inferable place **without any omniscient roster
read** — the pursuer commits to a static geography point inferred from the last sighting and
re-acquires by vision. A quarry that vanishes somewhere uninferable is correctly LOST.

### The `_slain` death bridge (resolving a vendetta out of sight)

A vendetta goal (`avenge` / a duel) must close when its target truly dies — even out of the
avenger's sight, even if the killing blow was a ranged ability (which bypasses the melee
combat-event path). The goal layer never reads a foreign `.alive`; instead:

- `planner.believedDead(agent, subjectId)` is true when the agent's own `_slain` set contains
  the id **or** it holds no belief about it at all (a belief merely faded by distance is *not*
  death — the pursuit keeps hunting).
- `Simulation.stampSlain(dead, killer)` (the shared bridge, called from `onCombatEvents` for
  melee kills) and `Simulation._sweepDeaths()` (a per-frame catch-all for ability/tower/
  scripted deaths the melee path misses) stamp the dead id onto the `_slain` set of the killer
  and of every agent carrying a vendetta / hostile belief / assault-memory about it, and erase
  their stale belief. So a death echoes to its avengers wherever they are, however it landed.

## Gotchas

- **Don't read `other.faction` inside a decision pass.** If you need hostility at
  decision time, go through the belief (`considerHostile`). Reading ground truth in
  `decide` is the canonical way to accidentally make NPCs omniscient and kill
  deception.
- **Don't read beliefs inside combat resolution.** `isHostile` deliberately mixes true
  faction with the latched-hostile belief; that's the one sanctioned crossing point.
- The player has a separate standing ledger (`reputation.js`) layered on top of the
  same `BeliefState.standing` field — see [05](05-economy-news.md).
