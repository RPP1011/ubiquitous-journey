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
lastPos        believed position
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
  subject's *believed* `lastPos`.
- `travelCost(agent, ctx, place)` adds a route-risk surcharge for *believed*-hostiles
  near the destination — so an agent routes around enemies it *thinks* are there, and
  can be wrong (planted rumour → detour around a phantom threat). Plans that fail
  against ground truth simply replan.

## Why it's built this way (rationale)

Theory-of-mind is the whole point of the project: NPCs that act on a *model* of the
world rather than the world itself. Keeping decisions belief-only and execution
truth-only means deception is **emergent, not special-cased** — there is no "is this
agent fooled?" branch anywhere. Disguise works because perception writes a false
faction; rumour works because gossip writes false hostility; spies work because their
true faction only matters once a blade lands. Collapse the two sides into one source
of truth and every theory-of-mind feature silently dies.

## Gotchas

- **Don't read `other.faction` inside a decision pass.** If you need hostility at
  decision time, go through the belief (`considerHostile`). Reading ground truth in
  `decide` is the canonical way to accidentally make NPCs omniscient and kill
  deception.
- **Don't read beliefs inside combat resolution.** `isHostile` deliberately mixes true
  faction with the latched-hostile belief; that's the one sanctioned crossing point.
- The player has a separate standing ledger (`reputation.js`) layered on top of the
  same `BeliefState.standing` field — see [05](05-economy-news.md).
