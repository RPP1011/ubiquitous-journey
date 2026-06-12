# 14 — The survival ladder (lethal hunger & the economy of staying alive)

> Hunger is **lethal**. A townsperson whose stomach sits empty long enough loses health
> until it eats or dies — and the whole stack of behaviour that keeps a town fed is a
> **ladder** of rungs, each one built because the previous rung's death-probe showed who
> was still dying and why. This doc is the as-built spec of that ladder: the death
> mechanic, every rung in score order, the conservation rules, and the measured numbers.
> The famine went from a background massacre (50–73 starvation deaths / 20 min) to a
> real-but-rare chronicled fate (~15–19, then ≈ a quarter of the famine peak per capita)
> one profiled layer at a time.

The method matters as much as the mechanics: **every rung was found by profiling the
actual dead** (`test/starveprobe.mjs`, the lifetrace digests), never by guessing. Each
fix names the decision bug it closed.

## Death by want (`STARVE`, `Agent.drainNeeds` in `js/sim/agent.ts`)

Once hunger has sat at empty past `STARVE.graceSecs` (60 — covers the walk home),
health drains at `STARVE.healthPerSec` (2.0, ~a minute from full) until the agent eats
or dies. Scope gates, all load-bearing:

- **Townsfolk only** (`a.townsperson && a.faction === 'townsfolk'`). Monsters and
  bandits keep no economy (the freeze lesson) — a lethal stomach would passively wipe
  their whole ecology.
- **Held captives exempt** (`!a._held`) — a captor sustains its ransom asset, and a
  captive can't act to feed itself; rescue arcs stay viable.
- **The inert-fixture contract**: bare scenario-cast agents are `townsperson=false`
  (`agent.ts`), so a test fixture can never starve (or donate alms) mid-checkpoint and
  perturb a suite's conservation arithmetic. Every *real* soul — spawned townsfolk,
  lineage children, watch/warband conversions — carries the flag.

Death takes the same `alive=false` path as an expedition loss; the corpse reaper files
the chronicle beat ("X starved in want."), flags `_diedOfHunger` (what the starvation
probe dedup-counts), and the existing **escheat keeps gold conserved** — death by want
never mints or destroys a coin.

## The ladder, rung by rung

The rungs are ordered by **score tier**, not by code path — survival competes in the
ordinary `decide()` scorer (and below it), never as a hard override. From routine to
emergency:

### 1. Market provisioning for the professionless (the `canWork` gate bug)

**Why purchasing never worked:** `decide.ts` gated the *entire* life scheduler — eating
included — on `a.canWork`, so a professionless townsperson (watch guard, warband
fighter, child) never even *considered* the eat/market candidates, while the auction
itself would happily have served anyone at the stalls with gold. The fix is a
**survival-provisioning block** for `!canWork` townsfolk: eat what you carry, go buy
food when the pack runs out. Urgency **rides the actual hunger deficit** — a fed but
foodless soul scores ~0.4 (loses to a live plan; provisioning can wait), a starving one
~1.6. A flat out-of-food bonus was tried first and **beat `WEIGHT.plan`, yanking fed
agents off mid-plan to go shopping** — urgency must be a function of need, not of
inventory state.

### 2. Campaign rations (`ECON.rationMul`, `agent/trade.ts`)

A townsfolk **combatant** keeps `rationMul × ECON.keep.food` (×2) in its pack
(`wantQty`). A civilian larder (~5 min of meals) starved frontier fighters whose patrol
is a map-length round trip from the stalls — the first probe's famine was **all
gold-rich fighters**. Paired with the decide-side gate: **no campaign without rations**
— the `seek_glory` ambition candidate yields until provisioned (`food ≥ 1`), letting
the market/forage candidates win that window before the march resumes
([09 — the persistent-ambition layer](09-reasoning-layer.md)).

### 3. Subsistence planning (`js/sim/features/subsistence.ts`, `SUBSIST`) — the dormant-trigger lesson

`goalSate` existed in the planner vocabulary for a long time with **no live trigger**
(a documented dormant breadth step, [10](10-action-grammar.md)). The lesson: agents
never "decided to make money to eat" because **nobody ever handed the planner the
problem** — hunger lived only in the reactive scorer. The subsistence deriver now
**poses hunger to the planner as a goal** (priority `SUBSIST.priority` 0.85 — above
ambition, below avenge), and the *existing* vocabulary solves it by cost: **buy** at
market (has coin) or **forage** at a field (capital-free gather — raw goods need no
profession). No new verbs; a live trigger over dormant vocabulary.

### 4. The survival nibble (`Agent.drainNeeds`, `ECON.nibbleBelow`) — no scorer competition

The death probe found agents starving **with 20 meals in the bag**: the deliberate eat
candidate is danger-gated, and a frontier fighter lives inside the flee/fight Schmitt
band — so it fought until it dropped, food in hand. A critically-hungry agent
(`hunger < nibbleBelow`, 0.25) now **eats as it goes** — no goal, no candidate, no
scorer competition at all; it happens inside `drainNeeds`. The threshold sits well
under `eatUrgent`, so the deliberate eat **goal** still owns ordinary meals (the
repertoire soak asserts it). Critical hunger also damps the comfort pull ×0.3 — the
probe watched comfort-dwellers die at home with a live sate goal on the stack and a
field 30 m away; a starving body doesn't care about a soft bed.

### 5. Alms (`js/sim/features/alms.ts`, `ALMS`, `resolver.solicitAlms`) — honest: flourish, not the safety net

A **destitute** pauper (no food, no coin, hungry) gets a `beg` candidate at the market
— scored **under** `WEIGHT.plan` (`begWeight` 0.8, maxing ~1.2 vs plan's 1.3), so
begging is the last resort after the planner found no forage/buy route. Begging is a
visible **Inform** (the recruiter-offer pattern): the resolver writes pleas into
bystanders' perceivable `_pleas` mailbox (bounded, TTL'd), and hearing a plea
**refreshes the listener's belief in the pauper** — necessary because the bounded ToM
table evicts an unremarkable pauper within ticks: *you cannot give to someone you
can't keep in mind* (the alms post-mortem that motivated the belief-cap rework,
[02](02-epistemic-split.md)). Each bystander then decides **for itself** off its OWN
altruism/kin/surplus (`donorAltruismMin`, `donorSurplusGold`) via the conserved repay
plan — so whether a town feeds its poor *emerges from who its people are*.
**Honest status:** gifts rarely land (donors' repay plans seldom win their busy
scorers) — alms is legible flavour; subsistence + the nibble are the real net.

### 6. The granary (`construction.ts` `BUILD_KIND.GRANARY`, `GRANARY`) — the civic rung

One public larder per grown town. Three conserved mechanics:

- **Commission** — the Surveyor commissions ONE granary per town at
  `SURVEYOR.granaryMinPop` (10), mirroring the tavern commission exactly (the shared
  `_townPop` gate). The finished building registers a static-map **`larder`** Place —
  discovered geography, places-as-percepts like the tavern's hearth.
- **Tithe in kind** (`market.ts` `titheGranary`) — `GRANARY.titheFrac` (0.15) of a FOOD
  unit cleared at that town's market moves from the buyer's pack into the larder. Food
  is produced/consumed, not conserved like gold, so the tax mints nothing and **gold
  never moves**. Two measured corrections, both at the mechanic (**the
  net-harmful-tithe lesson**): the first probe read NET HARM (starved 22 → 37) because
  the tithe taxed *every* food clear — including a hungry pauper's single meal — so it
  now falls only on **provisioning** buys (the buyer still holds a whole meal after
  it); and `stockCap` dropped 40 → 12, because four high-capped larders hoarded ~160
  meals out of circulation while serving 3 back — **a famine buffer, not a hoard**.
- **Emergency draw** (`resolver.granaryDraw`, co-location-gated like `deliverTo`) — a
  destitute townsperson that *knows* the larder draws ONE meal. The candidate ranks
  `drawBump` above beg (the civic answer wins the tie); a failed draw stamps the
  agent's OWN `_granaryEmptyUntil` memory, suppressing the trip while it holds (beg
  wins meanwhile — no telepathic stock-sensing). **The emergency-room fix:** at
  beg-tier weight the candidate *always lost* to a live cross-map subsistence plan, and
  the seed-31 probe watched 21 destitute starve ~83 m from stocked larders
  (mealsServed = 1). Inside the survival-nibble band the candidate now pitches at
  `GRANARY.urgentWeight` (1.6) — **over `WEIGHT.plan` (1.3), under the danger tier**
  (survival from violence still wins). After: 25–50 meals served / 20 min (seeds 31/7).

### Side-channel: press rations (`reporter.ts`)

The gazetteer starved on a loop — its role override never eats or shops and it carries
`gold=0` by design. The paper now provisions it with food at spawn: goods aren't
conserved, only gold, so this mints nothing.

## The score-tier map (keep this ordering intact)

```
danger (flee/fight Schmitt band)                  — always wins
GRANARY.urgentWeight 1.6 (starving destitute)     — over plan, under danger
WEIGHT.plan 1.3 (subsistence buy/forage plan)
provisioning market candidate (rides hunger deficit, ~0.4 fed → ~1.6 starving)
granary draw (beg + drawBump)  >  beg (≤ ~1.2)    — both under plan
ambition activity (capped at plan − 0.05)         — yields to all of the above
wander                                            — the floor
survival nibble                                   — NOT a candidate at all (drainNeeds)
```

Don't insert a new survival behaviour as a hard gate or override — every famine fix
above worked by **pitching a candidate at the right tier**, and the two regressions
(the flat out-of-food bonus; the beg-tier granary) were both tier mistakes.

## Measured arc (seeds 31/77 unless noted, 1200 s runs)

| Stage | Starvation deaths / 20 min |
| --- | --- |
| Lethal hunger lands, pre-ladder (f8b0f5b) | 50–73 (gold-rich fighters; then the destitute) |
| + subsistence, nibble, alms (7e8409a) | 19 / 15; destitute at any moment 1–3 |
| + rations gate, comfort damp (15db16d) | living pop 66–75 → 84–88, deaths hold 18/32 — per-capita ≈ ¼ of the famine peak |
| Phase A world ×3.4 area (a7f248b) | 53 (bigger distances re-stress the ladder — noted for tuning) |
| + granary (8f60a72) | larders serve 25–50 meals / 20 min; the starving destitute draw first |

Death by want remains a real, chronicled fate — an *event* the town mourns, not a
background massacre and not impossible.

## Eval tooling

`test/starveprobe.mjs` — a standalone harness (not a gate): seeded sim for N
sim-seconds, dedup-counting corpses flagged `_diedOfHunger`, splitting the dead into
**destitute vs moneyed** and reporting mean distance from their town anchor (that
distance split is what diagnosed both the fighter famine and the larder-tier bug).
Gate-side, `test/suites/construction.mjs` holds the granary gates (commission at the
pop threshold / a cleared food trade tithes / a co-located destitute draws / a bare
larder serves nothing — beg's turn). See [08](08-testing.md).

## Config locator

`STARVE` (lethality), `SUBSIST` (the goalSate trigger), `ALMS` (begging + donors),
`GRANARY` (tithe/draw/tiers), `SURVEYOR.granary*` (commission), `ECON.rationMul` /
`ECON.nibbleBelow` / `ECON.eatUrgent` — all in `js/sim/simconfig.ts`. Tune there, not
in logic.

## Cross-cutting invariants

1. **Lethal hunger is townsperson-gated, captive-exempt.** Widening it to monsters/
   bandits wipes their ecology; dropping the `_held` exemption kills every ransom arc.
2. **Nothing on the ladder moves gold except a real purchase.** The tithe is in kind;
   alms are a transfer; the escheat conserves a corpse's purse.
3. **Survival competes on score** (the tier map above) — the nibble is the one
   deliberate exception, and it bypasses the scorer entirely rather than distorting it.
4. **Belief-gated to the end**: the granary trip needs a *known* larder (static map),
   the bare-larder fallback is an own-state memory, and a donor needs the pauper *in
   its belief table* — no rung reads the roster.

---

*See also: [05 — economy](05-economy-news.md) (the market the ladder buys from),
[09 — reasoning layer](09-reasoning-layer.md) (the ambition layer the rations gate
guards), [02 — the epistemic split](02-epistemic-split.md) (the bounded mind that made
alms hard), [08 — testing](08-testing.md) (the probes that found every rung).*
