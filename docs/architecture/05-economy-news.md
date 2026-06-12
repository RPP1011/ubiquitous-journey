# 05 — Economy, reputation & journalism

> A closed-loop economy where gold is never minted, prices are *beliefs* that converge
> through trade and gossip, and **information itself is a resource** agents act on: a
> roaming reporter files a newspaper, and NPCs read it to take bounties and arbitrage
> prices between towns.

## The closed money loop (the cardinal economic invariant)

There is **no minting**. Gold only ever *transfers*:
- a trade moves gold between buyer and seller at the clearing price,
- looting a corpse transfers its *actual* purse (not a minted reward),
- a quest reward is paid from the giver's purse,
- a dowry is debited from a parent and credited to a child.

Raiders, reporters, and gazetteers spawn with `gold = 0` so respawns can't leak value.
Tool wear ties tool demand to throughput. **Preserve conservation whenever you touch
trade or loot.** The soak test asserts it: starting gold == ending gold + (goods × base
prices). Config: `ECON`, `COMMODITIES`, `BASE_PRICE`, `GOODS`, `PROFESSIONS` in
`simconfig.js`.

## Market: a decentralised double auction (`js/sim/market.js`)

`runMarket(sim)` runs each fixed tick. It's a town-wide **standing-order double
auction**: every agent posts asks (surplus) and bids (wants, capped by gold) from
wherever it stands; cheapest ask matches highest bid at the **midpoint** price, capped
at `ECON.tradesPerCommodityPerTick`.

- **Logistics matter.** Trade only clears between agents physically *at* a market
  (within `ECON.marketRange` of a market POI). A remote producer must **haul** goods in
  to sell — a real journey whose distance, terrain, and danger are felt. This is the
  hook arbitrage exploits.
- **Price learning.** After a clear, each party soft-updates its price belief toward
  the realised price (`learnPrice(c, price, ECON.priceLearn)`); unfilled orders drift
  toward each other. The result is decentralised tâtonnement — prices *converge* without
  any central authority, and beliefs can diverge between towns (the arbitrage gap).
- **Economic slight** (social friction) — a galling deal sours standing: in a shortage
  the buyer resents the "gouger", in a glut the seller resents the "lowballer", scaled
  by severity and greed. Only between NPCs (the player's standing is reputation's job).
- **RPG favour** — the player's standing skews their clearing price: a beloved player
  buys cheaper / sells dearer.

Decisions read **price beliefs**, which the market updates — so the epistemic split
extends to economics: an agent trades on what it *believes* prices are.

## Emergent occupation (`js/sim/agent/occupation.js`)

No agent has a birthright trade. Each work stint, `chooseOccupation` scores every
producible good by *believed* price × proximity to its site × ambition affinity (with
hysteresis to avoid thrashing, and an opportunity gate so crafted goods need their
inputs). The chosen `_trade` then steers which class the agent builds — the economy and
the [RPG progression](03-rpg-abilities.md) drive each other.

## Reputation: the player's standing ledger (`js/sim/reputation.js`)

Standing is **not** global. NPC↔NPC opinion lives in each `BeliefState.standing` (see
[02](02-epistemic-split.md)). On top, `Reputation` is a player-only ledger with two
layers:
- **Personal** — the NPC's belief toward the player (gossips + decays like any belief).
- **Faction rollup** — a coarse per-faction opinion of the player, inherited by
  freshly-seen NPCs of that faction.

Deeds are **witnessed, not omniscient** — `applyDeed` only moves the standing of
observers within vision range (+ a small faction nudge). The `REP.deeds` table:
`HELPED +0.20`, `QUEST_DONE +0.35`, `KILLED_MONSTER +0.18`, `ATTACKED_NPC −0.40`,
`KILLED_NPC −0.70`, `THEFT −0.30` (personal; faction nudges are smaller). `standing`,
`factionStanding`, `isHostileTo` (< −0.6), and `describe` ("hostile"…"devoted") are the
read API. Standing decays toward the faction bias over time. This ledger also feeds
`Simulation.isHostile` and the market's RPG-favour price skew.

## Telemetry: econstats & xpstats (`js/sim/econstats.js`, `js/rpg/xpstats.js`)

Both are bus subscribers that tally per-world activity for tests and the UI.
`econstats` records every trade so the soak can verify the closed-loop invariant;
`xpstats` mirrors the same pattern for progression. Per-world — reset on world rebuild.

## Multi-town world (`TOWNS` in `simconfig.js`)

The world is **four dense towns** (Phase A: Eastmarket, Crowmoor, Highford, Saltwick —
see [06](06-world-dungeons.md) for the layout, profiles, and the road graph linking
them), each with a core, a radius, its own home band, defenses, watch, and population
cap, linked by wilderness, roads, and inter-town caravans; `ARENA_RADIUS` (600) bounds
the whole map (x/z clamp; y is cosmetic). Each agent has a `townAnchor` and clamps to
its home town's radius. Towns **specialise** for comparative advantage (e.g.
Eastmarket ore/wood-rich herb-poor; Crowmoor the inverse) — but only on non-essential
goods; every town keeps enough fields to self-feed, because **hunger is now lethal**
(the [survival ladder](14-survival-economy.md) — which also adds the granary tithe, a
tax *in kind* on provisioning food clears at the market, exempting a pauper's only
meal). This price divergence between towns is exactly what makes news and arbitrage
worth acting on.

## Journalism: information as a resource

The news layer turns *information itself* into something agents trade and act on.
Design notes: [`docs/reporter-agent-design.md`](../reporter-agent-design.md).

### Reporter (`js/sim/reporter.js`, `REPORTER`)
A roaming **gazetteer** — a normal Agent re-flagged (`reporter=true`, non-combatant,
`gold=0`). It finds the most newsworthy soul, **walks** to them (its inter-town travel
*is* the news-courier mechanic), lingers for an "interview" (a co-located read of
state), and files a `StoryBrief`. A separate **wire desk** publishes the highest-value
*useful* dispatch (price shock, road danger, posted bounty) off cooldown. Movement
reuses the goal/act path (`reporter` goal). Deterministic and headless-safe (no I/O).

### Gazette (`js/sim/gazette.js`, `GAZETTE`)
The sim-owned newspaper store + two pure, headless-safe builders the reporter uses:
`buildBrief(subject, sim)` (a bundle of ground-truthy facts: biography, salient
memories, chronicle beats, relationships, dateline) and `templateArticle(brief, sim)`
(a serviceable article — the *floor* under optional LLM prose). Article kinds: **person**
(an emergent adventure), **market** (price dispatch), **threat** (a menaced town → puts
the town on ALERT so the Watch musters early), **opportunity** (a posted bounty). Bounded
ring (~60), `recent(n)` for the UI. Toggle the panel with `J`.

### Optional LLM prose (`js/ai/press.js`, `js/ai/llm.js`)
An **optional**, off-by-default browser-side pump that asks a small local LLM (vLLM) to
rewrite an article's prose, swapping it in place by id. It is *not* part of the fixed
tick and not deterministic on replay — the template article is always the floor, so the
sim runs identically with the LLM off or absent. No new browser/npm dependency (plain
`fetch`). Setup: [`docs/llm-npcs.md`](../llm-npcs.md), `README.md`.

### NPCs read the news — the labour & trade markets

This closes the loop: the Gazette isn't decoration, it *drives behaviour*.
- **Bounties** (`js/sim/bounties.js`, `BOUNTY`) — a brave, free townsperson near a
  market reads a combat **opportunity** article (hunt / vendetta / avenge) and sets out
  to claim it (flips a `bounty` flag + goal, reusing combat/goal paths). First to finish
  wins — they **race the player**; the giver pays from their own purse.
- **Arbitrage** (`js/sim/arbitrage.js`, `ARBITRAGE`) — a trader near a market reads that
  a good is **dear** in another town and, if holding surplus, hauls it there to sell at
  the better clearing price (flips an `arbitrage` flag + goal). Profit is *emergent*
  from the localized market, not minted — and crossing the wilds is genuinely risky
  (the hauler can be ambushed).

## Quests (`js/quest/quest.js`, `QUEST`)

Two layers, both grounded in the real running sim:
- **Emergent offers** are minted only when an agent is *genuinely stuck*: `fetch` (a
  townsperson can't feed itself), `hunt` (a monster believed near the village),
  `recover` (someone was robbed in combat — driven by a `ROBBED` deed on the bus),
  `avenge` (a griever begs help against a named foe — personal, assist-only).
- **Radiant** offers (`_synthRadiant`) keep the board topped up to `QUEST.radiantFloor`
  with repeatable, player-level-scaled bounty/deliver/delve contracts.

Completion is detected from **ground truth** in `tick()` (inventory, deeds, proximity;
delve quests check `player.relics`). Most quests are delegable, so NPC bounty-hunters
race the player; personal `avenge` quests are assist-only. Surfaced by the
[Quest Log UI](07-ui.md) (`Q`).

## Gotchas

- **Conservation is load-bearing and tested.** Any new gold source must be a transfer.
  A minting bug surfaces as a soak failure, not a visible glitch.
- **Trade is local.** Don't add teleporting trades; the haul *is* the mechanic that
  makes arbitrage, caravans, and road danger meaningful.
- **Price beliefs ≠ truth.** Agents act on believed prices; gossip and town isolation
  let beliefs diverge — that divergence is the content, not a bug.
- **Player standing lives in two places** — the per-NPC `BeliefState.standing` and the
  `Reputation` rollup. Update through `Reputation.applyDeed`, not by poking beliefs.
