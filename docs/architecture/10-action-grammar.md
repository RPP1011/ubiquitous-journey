# 10 — The action grammar & the knowledge model

> **Status: design, not yet implemented.** This describes the vocabulary the planner builds plans
> from — the *actions*, the *effects* they produce, and how an agent's *knowledge* is stored. It is
> the deliberative-tier companion to [09 — the reasoning layer](09-reasoning-layer.md), which covers
> how planning runs each tick; this doc defines what the planner has to work with. Today's planner
> (`js/sim/planner.js`) implements a hand-written subset; this is the form it is moving toward.

## What the planner does

A **goal** is a belief-state the agent wants to be true (for example, *I have 50 gold*). The
planner works backwards from the goal: it finds an **action** whose result would make the goal
true, then treats that action's requirements as new sub-goals, and repeats, until every requirement
is already true in the agent's **beliefs** — its own private picture of the world. The output is an
ordered list of actions; the agent then carries them out one at a time, and re-plans if its beliefs
change underneath it.

Everything the planner reasons about is a belief, never the real world. That is what lets an agent
be wrong — act on a stash that has been moved, a price that has already shifted — and is the subject
of [02 — the epistemic split](02-epistemic-split.md). This doc defines the two things the planner
manipulates: the actions, and the beliefs (knowledge) they read and write.

## A worked plan

Pip is broke and believes a merchant, Olen, is wealthy. Pip does not know where Olen keeps his
money. Pip's goal is *have gold*. The planner produces:

```
observe Olen   →   go to the cache   →   take the cache
```

Three actions. Reading them back to front:

- **take the cache** produces *have gold*. It requires being *at* the cache and *knowing where the
  cache is*.
- **go to the cache** produces *being at the cache*. It also requires *knowing where the cache is* —
  you cannot walk to a place you cannot locate.
- **observe Olen** produces *knowing where the cache is*. It requires nothing; you simply follow him
  until you have seen enough to be confident.

So the plan is built entirely from requirements chaining into earlier actions. The interesting link
is that **knowledge is a requirement like any other** — "know where the cache is" sits in the chain
next to "be at the cache," and an action (`observe`) exists to satisfy it.

If a rumour had already told Pip where the cache is, the first action drops out and the plan is just
`go → take`. The knowledge was supplied for free, so the plan is cheaper. That is the same machinery
turning a tip into a shortcut.

## Effects — the units a plan is made of

An **effect** is a change to believed state. The planner reasons only in effects; it is the small,
fixed vocabulary every action is described in:

| effect | meaning |
| --- | --- |
| `Have(resource)` | I possess a good or gold |
| `At(place)` | I am at a place |
| `NeedMet(need)` | a need of mine is satisfied (fed, rested, healed) |
| `Know(topic)` | I hold a piece of knowledge (see [The knowledge model](#the-knowledge-model)) |
| `Believes(subject, topic)` | I believe that *another agent* believes something |
| `Dead / Freed / Intact(entity)` | another entity's physical state |

Each takes a parameter — `Have(gold)`, `Know(where Olen's cache is)`, `Dead(the bandit)` — so one
effect covers many concrete situations.

## Actions — how effects are produced

An **action** is described by four things:

- the one **effect** it produces,
- its **requirements** (effects that must hold first — the planner turns each into a sub-goal),
- a **cost** (computed from the agent's beliefs — distance, risk, price),
- a **verb** — the world-interaction it performs when the agent arrives (the swing, the hand-off,
  the unbinding of a captive).

The planner usually has **several actions for the same effect**, and chooses between them by cost.
To get gold, an agent might `sell` goods it holds, `loot` a corpse, or `take` from a stash it has
located; whichever is cheapest given its beliefs wins. This is why two agents with the same actions
behave differently: the choice falls out of each one's beliefs and circumstances, not from anything
authored per agent.

Many actions share a shape — *go to a source, take a resource, leave a social trace* — and differ
only in details. Rather than write each as its own action, they are generated from a table whose
rows fill in the differences:

```
acquire a resource — rows:
  source     made or moved   social trace
  node       made            honest labour        (gather a raw good from a field/mine)
  workshop   made            craft                (produce a good from a recipe)
  market     moved           a paid trade         (buy)
  corpse     moved           none                 (loot)
  cache      moved           theft, if witnessed  (take from a stash)
  a person   moved           robbery / tax / alms (by force / authority / charity)
```

"Made vs moved" matters: gathering and crafting *create* a good from the environment, while buying,
looting, and stealing *move* gold or goods that already exist. The simulation's money supply is
closed (no minting), so a row that mints and a row that transfers cannot be merged — they are
genuinely different and stay separate rows. Adding a new way to acquire a resource is adding a row,
not writing a new action.

The other effects have their own small tables in the same style:

- **Knowledge** is acquired three ways: `observe` (watch first-hand), `ask` (be told), `study` (be
  taught). They differ in cost, in how trustworthy the result is, and in side-effects (asking around
  can tip off your target). The *topic* — what you are learning — is a parameter, so the same
  `observe` learns a cache location, a recipe, or the strength of a camp.
- **Changing another's belief** (`Inform`) is done by `disguise`, `demonstrate`, `rumour`,
  `command`, or `teach` — see [the boundary below](#which-states-an-action-can-change).
- **Physical state** (`Affect`) is changed by `strike` (→ dead), `free` (→ freed), `wreck` (→ not
  intact).
- **Needs** (`Tend`) are met by `eat`, `rest`, `heal`, `socialise`.

## Which states an action can change

An action changes exactly one of these:

- **your own** location, possessions, condition, or knowledge, or
- **another entity's** physical state — you can kill it, free it, or damage it (combat already
  resolves this kind of change), or
- **your model of another agent's mind** — what you believe they believe.

It cannot change another agent's location, possessions, or decisions: other agents move, hold, and
decide for themselves. And it cannot reach into another agent's mind and set a belief there. The
closest you can do is act in a way the other agent *perceives* — show a disguise, plant a rumour,
issue a command — after which that agent updates *its own* beliefs through ordinary perception and
gossip. You may be wrong about whether it worked.

This is the same boundary as everywhere else in the simulation ([the epistemic split](02-epistemic-split.md)):
an agent reads and writes its own world-model; it touches other minds only through perception and
gossip. Influence and deception live entirely inside the acting agent's own model — the agent holds
a belief about what the target now believes, acts to shift it, and finds out later whether the bet
paid off. Coordination works the same way: a leader estimates from its own beliefs how likely others
are to obey, issues a command, and the others each decide for themselves. None of this needs a
co-planner or a way to write a foreign mind; it is the ordinary act-then-perceive loop.

## The knowledge model

`Know(topic)` appears in plans as routinely as `Have` or `At`, so knowledge needs a representation
as solid as inventory or position. This section defines it.

### A topic is a proposition

A **topic** is a specific thing an agent can know. The ones the situation catalogue
([09 — the situation library](09-reasoning-layer.md#the-situation-library-the-design-bar-for-the-catalogue))
needs:

| topic | what it is | about |
| --- | --- | --- |
| `Loc(subject, role)` | where a subject keeps something (a stash, a home, a workshop) | a person |
| `Whereabouts(subject)` | where a subject is now | a person |
| `Strength(place)` | how strong a force is at a place (≈ how many) | a place |
| `State(place, attribute)` | a place is depleted / infected / closed / sheltered | a place |
| `Price(good, place)` | what a good costs at a place | a market |
| `Recipe(good)` | how to make a good | the wider world |
| `Secret(subject)` | a fact a subject would pay to keep hidden | a person |
| `Owns(subject, place)` | a subject owns a place | a person and a place |
| `StandingToMe(subject)` | how a subject regards me | a person |
| `Believes(subject, topic)` | a subject believes some topic | a person |

Most topics are *about a specific person or place*. An agent already keeps a record about each
person and place it knows — its **belief table** — so these topics live there, as fields on the
relevant record. `Recipe` is the exception: a recipe is a piece of craft knowledge that belongs to
no one in particular, so it lives in the agent's own state.

### Every piece of knowledge carries the same four things

Whatever the topic, a known fact carries:

- a **value** (the position, the number, the recipe),
- a **confidence**, 0 to 1,
- a **provenance** — how it was learned (seen first-hand, heard, taught) and how many retellings deep,
- a **last-updated time**, so it can fade.

These four are what make knowledge behave like knowledge rather than a fact sheet: confidence and
fading let a fact go **stale** (Pip raids a cache that was moved); provenance lets a fact **spread**
through gossip while getting vaguer; and all of it lets a fact be **wrong**. The belief table already
records these four for everything in it. The one piece that does not is the recipe set, which is
currently just "you know it or you don't"; giving recipes the same four turns them into graded
knowledge — a recipe can be half-learned from a poor teacher, picked up as an unreliable rumour, or
forgotten when the last person who knew it dies. That last case is how a craft can drop out of the
economy, which is a behaviour the simulation wants.

So knowledge keeps its natural homes — facts about others on the belief table, recipes in own state —
and the four fields are what is shared across all of them. `Know(topic)` is a small accessor that
reads the right home for a given topic.

### Reading, writing, spreading, fading

- **Reading** (`Know(topic)`): look up the topic's home and report it known if it is present and
  confident enough. A vague rumour does not satisfy a requirement a heist depends on; a confident,
  first-hand sighting does.
- **Writing** (`observe` / `ask` / `study`): each adds evidence toward a topic and, once there is
  enough, records it with a confidence and provenance set by the channel — first-hand observation is
  trusted and slow, being told is cheap and vaguer, being taught is trusted and costs tuition.
- **Spreading**: gossip already carries facts between nearby agents, lowering confidence and noting
  the extra retelling. Topics spread the same way, which is why a tip can hand you a cache location
  you never saw.
- **Fading**: the existing decay lowers confidence over time. A fact nobody refreshes drifts back
  toward unknown.

### Some lifecycles

- **A recipe through the generations.** A master knows a recipe confidently and crafts with it. She
  teaches an apprentice, who comes away a little less sure. Across generations, lines that are never
  taught fade. When the last confident holder dies, the recipe is effectively gone, the good
  disappears from the market, its price climbs, and the newspaper notices.
- **A price going stale.** A trader hears a good is dear in the next town and hauls a cartload over —
  but everyone heard the same rumour, the price has already converged, and the trip barely breaks
  even. The belief was true when learned and stale when used.
- **A secret as leverage.** Watching a target long enough turns up something shameful — a `Secret`
  with a confidence. If the watching was thin and the conclusion wrong, the target calls the bluff.
- **Believing what others believe.** Seeing a town treat me with suspicion, I come to believe they
  believe me guilty. That is a `Believes` topic, a field with the same four parts as any other, and a
  reactive rule can act on it (flee, or petition the peace-keeper).

## Where each action's real code lives

An action is small — an effect, requirements, a cost, a verb. The actual work happens in the
**executor** the verb runs when the agent arrives, and executors vary a lot: a strike runs the
combat state-machine, taking a cache runs a conserved gold transfer, freeing a captive flips a held
flag, observing accrues evidence into the right knowledge field. Freeing a captive looks like a
special case but is not: like taking a cache, it is a trivial final act (cut the bonds) gated by a
hard requirement (be there, unopposed), and the requirement decomposes into ordinary scouting and
movement. The variety lives in the executors; the actions above them stay uniform.

## At runtime there is no big shared structure

It is natural to picture all this behaviour as a giant decision tree every agent walks. It is the
opposite. What exists at runtime is:

- a flat set of actions (the rows above),
- a set of small rules that turn an agent's needs and beliefs into goals,
- one generic planner (a few hundred lines) that knows nothing about any specific situation,
- a flat set of reactive rules ([the interaction schemas](09-reasoning-layer.md)).

The plan for a heist or a rescue is *built when needed*, for one agent, from that agent's beliefs,
and thrown away — a short search, a handful of steps. The situations this doc keeps mentioning are
not entries in the code; they are paths the planner happens to find through the same flat set of
actions under different beliefs. The maintained code grows with the *vocabulary* (the actions and
topics), and the behaviours are what emerge from it. All agents share that vocabulary the way
speakers share a language and still say different sentences; the differences come from the beliefs,
which are per-agent.

Planning is not free, but it is occasional (on a new goal or a forced re-plan), bounded (a small
depth and step limit), and thinned for distant or idle agents, so the cost per agent per tick stays
flat as the population grows — the budget [09 / Phase 3](09-reasoning-layer.md) measures.

## What this covers

Working through the situation catalogue, nearly every situation is expressible with these actions and
topics plus, at most, a new row or a new topic — data, not new machinery. The exceptions are narrow:
anything genuinely *scheduled* (a debt due every season, rationing, a recurring patrol) has no clock
in a plan and needs handling outside it; and sub-combat tactics like a feint belong to the fighter,
below the planner. Tracing the harder situations through the real planner also shows that a "plan" is
often richer than a straight line: economic plans emerge only when the cheap local options run out;
social plans (bait, threaten, court, command) act to shift the odds and then wait, expiring if the
other party never bites; and operations like a rescue are *refuse, scout, wait for the moment, then
move* rather than a single sweep. In every case the plan can only form once the relevant belief has
been gathered — which is what makes the behaviour believable rather than omniscient.

## Building it

The planner's search does not change. The actions become rows generated from the tables above, the
way interaction schemas and abilities are already data rather than code. Knowledge gets the small
accessor and the four shared fields, and recipes move from a plain set to the same shape.

A sensible order, each step leaving the tests green and any new behaviour switched off by default so
the long-running soak is unchanged:

1. **Knowledge first.** Build `Know(topic)` and the `observe` / `ask` / `study` actions over the
   knowledge model. Generalise the current single-purpose `shadow` (which only learns a cache) into
   `observe` over any topic, and fold the current `approach` into ordinary movement toward a place
   you have located. This is what the covert and teaching behaviours both need, and it lets a teacher
   reuse the same machinery a spy uses.
2. **Resources.** Turn `buy` / `gather` / `produce` / `loot` / `take` into rows of the acquire table.
3. **The rest**, as breadth requires — each a row or a field: the remaining acquire rows, the
   `Believes` effect, wrecking and freeing, and the place-state, strength, secret, and price topics.

The Phase-5 shortlist
([09](09-reasoning-layer.md#probe-backed-gap-analysis-the-phase-5-priority-order)) is, in these
terms, almost all rows, fields, and topics rather than code.
