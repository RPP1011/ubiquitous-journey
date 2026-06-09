# 10 — The action grammar & the knowledge model

> **Status: design, not yet implemented.** This describes the vocabulary the planner builds plans
> from — the *actions*, the *effects* they produce, how *quantities and time* enter a plan, and how
> an agent's *knowledge* is stored. It is meant to be read on its own. It is the deliberative-tier
> companion to [09 — the reasoning layer](09-reasoning-layer.md), which covers how planning runs each
> tick; links to other docs here are background, not required reading. Today's planner
> (`js/sim/planner.js`) implements a hand-written subset of what follows.

## What the planner does

A **goal** is a state the agent wants to be true (for example, *hold at least 50 gold*). The planner
works backwards from the goal: it finds an **action** whose result would help make the goal true,
treats that action's requirements as new sub-goals, and repeats, until every requirement is already
true in the agent's **beliefs** — its own private picture of the world. The output is an ordered list
of actions; the agent carries them out one at a time, and re-plans if its beliefs change underneath
it.

Everything the planner reasons about is a belief, never the world directly. An agent reads and writes
only its own picture of things, and reaches other agents only by acting where they can perceive it —
cognition runs on beliefs; only perception and the physical resolver touch the truth. (This is the
simulation's central rule; [02](02-epistemic-split.md) covers it in full.) It is what lets an agent
be **wrong** — walk to a cache that has been moved, haul goods to a town whose prices have already
shifted.

## A worked plan

Pip is broke and believes a merchant, Olen, is wealthy. Pip does not know where Olen keeps his money.
Pip's goal is *hold at least 50 gold*. The planner produces:

```
observe Olen   →   go to the cache   →   take the cache
```

Reading the actions back to front:

- **take the cache** adds gold toward the goal. It requires being *at* the cache and *knowing where
  the cache is*.
- **go to the cache** produces *being at the cache*. It also requires *knowing where the cache is* —
  you cannot walk to a place you cannot locate.
- **observe Olen** produces *knowing where the cache is*. It requires nothing; you follow him until
  you have seen enough to be confident.

Two things to notice. First, **knowledge is a requirement like any other** — "know where the cache
is" sits in the chain next to "be at the cache," with an action (`observe`) to satisfy it. If a
rumour had already told Pip the location, the first action drops out and the plan is `go → take`; the
knowledge was supplied for free.

Second, the goal is a **threshold**, *at least 50 gold*, not a flag. If Pip believes the cache holds
50 or more, one `take` satisfies it. If he believes it holds only 20, one `take` is not enough and the
planner keeps going — a second cache, or a `take` and a `sell` — adding actions until the believed
total crosses 50. A plan can compose several acquisitions toward one numeric target.

## Effects — the units a plan is made of

An **effect** is a change to believed state. The planner reasons only in effects; they are the small,
fixed vocabulary every action is described in:

| effect | meaning |
| --- | --- |
| `Have(resource, amount)` | I hold at least *amount* of a good or gold |
| `At(place)` | I am at a place |
| `NeedMet(need, level)` | a need of mine is satisfied to at least *level* |
| `Know(topic)` | I hold a piece of knowledge (see [The knowledge model](#the-knowledge-model)) |
| `Believes(subject, topic)` | I believe that *another agent* believes something |
| `Dead / Freed / Intact(entity)` | another entity's physical state |

**Quantities and thresholds.** Where the thing is a quantity — gold, a stockpile, how fed I am — the
effect carries an *amount*, and a goal is satisfied when the believed amount reaches the threshold
(*at least*), not on an exact match. Needs are graded the same way: hunger is a level, not a flag, so
meeting a need means bringing it above a threshold, and eating twice is a normal plan when one meal is
not enough. An action contributes a **believed yield** toward the amount — a sale brings in roughly
its believed price, taking a cache roughly its believed size — and the planner adds actions until the
yields sum past the target, choosing the cheapest combination that does.

Some quantities live on both sides of a plan. `Strength(place)` (how strong a force is somewhere) and
`Price(good, place)` are facts a plan *reads* — is the camp too strong to attack? is this good cheap
here? — and also targets a plan can *build toward*: gather a force that outnumbers the camp; raise
gold to at least the believed price of the thing I want. They are amounts, so they can be a
precondition or a goal threshold.

## Actions — how effects are produced

An **action** is described by four things:

- the **effect** it contributes to,
- its **requirements** (effects that must hold first — each becomes a sub-goal),
- a **cost**,
- a **verb** — the world-interaction it performs on arrival (the swing, the hand-off, cutting a
  captive's bonds).

The planner usually has **several actions for the same effect** and chooses between them by cost. To
get gold, an agent might `sell` goods it holds, `loot` a corpse, or `take` from a cache it has
located; whichever is cheapest given its beliefs wins. This is why two agents with the same actions
behave differently — the choice falls out of each one's beliefs, not from anything authored per agent.

**Cost includes confidence.** An action's cost is computed from the agent's beliefs, *and from how
sure they are*. An action that leans on a shaky belief — a half-glimpsed cache, a third-hand rumour of
a price — costs more, because acting on it is likely to waste the trip. So an agent tends to gather
more evidence first (observe again, ask around) before a high-stakes act, and moves on thin knowledge
only when speed matters or the stakes are low. This is the one place the knowledge model's confidence
feeds back into what an agent decides to do, and it is what makes the behaviour look cautious rather
than omniscient — agents scout before they commit.

**Actions come from tables, not hand-writing.** Many actions share a shape — *go to a source, take a
resource, leave a social trace* — and differ only in details. Rather than write each separately, they
are generated from a table whose rows fill in the differences. Acquiring a resource:

```
source     made or moved   social trace
node       made            honest labour          (gather a raw good from a field or mine)
workshop   made            craft                  (produce a good from a recipe)
market     moved           a paid trade           (buy)
corpse     moved           none                   (loot)
cache      moved           theft, if witnessed    (take from a stash)
a person   moved           robbery / tax / alms   (take by force / authority / charity)
```

**Made versus moved is a conservation rule, not a label.** The two *made* rows — `gather` and
`produce` — bring new goods into being, drawing from the environment and a recipe. Every *moved* row
relocates gold or goods that already exist, from a corpse, a counterparty, or a mark, and creates
none: the believed yield comes from the source's believed holdings, and when the action runs its
executor debits the source as it credits the agent, so the total in the world is unchanged. The money
supply is closed — nothing mints gold — and any future *moved* row a row-author adds inherits this
rule. A made row and a moved row therefore cannot be merged into one.

The other effects have their own small tables in the same style:

- **Knowledge** is acquired three ways — `observe` (watch first-hand), `ask` (be told), `study` (be
  taught) — differing in cost, in how trustworthy the result is, and in side-effects (asking around
  can tip off the subject). The *topic* is a parameter, so the same `observe` learns a cache location,
  a recipe, or a camp's strength.
- **Changing another's belief** (`Inform`) is done by `disguise`, `demonstrate`, `rumour`, `command`,
  or `teach` — see [the boundary below](#which-states-an-action-can-change).
- **Physical state** (`Affect`) is changed by `strike` (→ dead), `free` (→ freed), `wreck` (→ not
  intact).
- **Needs** (`Tend`) are met by `eat`, `rest`, `heal`, `socialise`.

## Which states an action can change

An action changes exactly one of these:

- **your own** location, possessions, condition, or knowledge;
- **another entity's** physical state — you can kill it, free it, or damage it (combat already
  resolves this kind of change);
- **your model of another agent's mind** — what you believe they believe.

Taking, looting, and robbing might look like exceptions — they plainly cost someone else their gold.
But from the planner's side the effect is on your *own* possessions; the source's loss is reconciled
by the executor (it debits the corpse or the mark as it credits you), the same way combat resolves
another fighter's health. Cognition plans changes to its own state and to the physical world; it never
reaches into another agent's inventory or mind to set a value there.

That last clause is the boundary. You cannot change another agent's location, possessions, or
decisions — they move, hold, and decide for themselves — and you cannot write a belief into another
agent's mind. The most you can do is act where the other can *perceive* it — show a disguise, plant a
rumour, issue a command — after which that agent updates *its own* beliefs through ordinary perception
and gossip, and you may be wrong about whether it worked. Influence and deception therefore live
entirely inside the acting agent's own model: it holds a belief about what the target now believes,
acts to shift it, and finds out later whether the bet paid off. Coordination is the same shape — a
leader estimates from its own beliefs how likely others are to obey, issues a command, and the others
each decide for themselves. None of this needs a shared plan or a way to write a foreign mind.

## Waiting and deadlines

Some plans must wait for the world to change rather than act on it. A small party cannot storm a camp
of thirty — but if it holds in concealment until it sees the raiders leave, the camp is briefly weak.
That waiting is an explicit step, not an accident of re-planning: a **hold-until** step keeps the agent
somewhere safe or hidden, re-checks a condition each tick, advances when the condition becomes
believed-true, and abandons if a **deadline** passes first. The "refuse, scout, wait, move" shape of a
rescue is exactly *go to a vantage → observe the camp → hold-until its believed strength drops →
move*.

The same step covers the social plays that act-then-wait: show weakness then hold until the foe
closes; make an offer then hold until it is taken — each abandoned if nobody bites. Goals carry an
optional deadline for this — a time by which the waited-for condition must hold, after which the goal
is dropped. The simulation already records when each belief was last updated and fades it over time
(see [The knowledge model](#the-knowledge-model)), so "has the window opened?" and "has this gone
stale?" are ordinary belief reads.

What stays outside a plan is **recurrence**. A plan is a one-shot ordered list with, at most, a
deadline. A thing that *repeats* — a debt due every season, a nightly patrol, "they always raid at
dusk" — is not placed in the plan; it is re-derived from memory each time it comes due. A single wait
or deadline is first-class; a schedule is not.

## The knowledge model

`Know(topic)` appears in plans as routinely as `Have` or `At`, so knowledge needs a representation as
solid as inventory or position.

### A topic is a proposition

A **topic** is a specific thing an agent can know:

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

Most topics are *about a specific person or place*. An agent already keeps a record about each person
and place it knows — its **belief table** — so these topics live there, as fields on the relevant
record. `Recipe` is the exception: a recipe belongs to no one in particular, so it lives in the agent's
own state.

`Believes(subject, topic)` nests **one level only** — *I believe you believe X*. Deeper nesting (*I
believe you believe I believe …*) is not represented; the deception and command behaviours only ever
need the one level, and capping it keeps the set of mental models an agent reasons over finite.

### Every piece of knowledge carries the same four things

Whatever the topic, a known fact carries:

- a **value** (the position, the number, the recipe),
- a **confidence**, 0 to 1,
- a **provenance** — how it was learned (seen first-hand, heard, taught) and how many retellings deep,
- a **last-updated time**, so it can fade.

These four are what make knowledge behave like knowledge rather than a fact sheet. Confidence and
fading let a fact go **stale** — Pip raids a cache that was moved; provenance lets a fact **spread**
through gossip while getting vaguer; and all of it lets a fact be **wrong**. They are also what the
[cost-includes-confidence](#actions--how-effects-are-produced) rule reads: a low-confidence fact makes
the actions that depend on it expensive, so agents scout before they bet.

The belief table already records these four for everything in it. The one piece that does not is the
recipe set, which today is just "you know it or you don't"; giving recipes the same four turns them
into graded knowledge — a recipe can be half-learned from a poor teacher, picked up as an unreliable
rumour, or forgotten when the last confident holder dies, which is how a craft drops out of the
economy. So knowledge keeps its natural homes — facts about others on the belief table, recipes in own
state — and the four fields are what is shared across all of them. `Know(topic)` is a small accessor
that reads the right home for a given topic.

### Reading, writing, spreading, fading

- **Reading** (`Know(topic)`): look up the topic's home and report it known if it is present *and*
  confident enough. A vague rumour does not satisfy a requirement a heist depends on; a confident,
  first-hand sighting does.
- **Writing** (`observe` / `ask` / `study`): each adds evidence toward a topic and, once there is
  enough, records it with a confidence and provenance set by the channel — first-hand observation is
  trusted and slow, being told is cheap and vaguer, being taught is trusted and costs tuition.
- **Spreading**: gossip already carries facts between nearby agents, lowering confidence and noting
  the extra retelling; topics spread the same way, which is why a tip can hand you a cache location you
  never saw.
- **Fading**: the existing decay lowers confidence over time; a fact nobody refreshes drifts back
  toward unknown.

### Some lifecycles

- **A recipe through the generations.** A master knows a recipe confidently and crafts with it; she
  teaches an apprentice, who comes away a little less sure; across generations, untaught lines fade.
  When the last confident holder dies, the recipe is effectively gone, the good leaves the market, its
  price climbs, and the newspaper notices.
- **A price going stale.** A trader hears a good is dear in the next town and hauls a cartload over —
  but everyone heard the same rumour, the price has already converged, and the trip barely breaks even.
  True when learned, stale when used.
- **A secret as leverage.** Watching a target long enough turns up something shameful — a `Secret`
  with a confidence. If the watching was thin and the conclusion wrong, the target calls the bluff.
- **Believing what others believe.** Seeing a town treat me with suspicion, I come to believe they
  believe me guilty — a `Believes` topic, a field with the same four parts as any other — and a
  reactive rule can act on it (flee, or petition the peace-keeper).

## Where each action's real code lives

An action is small — an effect, requirements, a cost, a verb. The actual work happens in the
**executor** the verb runs on arrival, and executors vary a lot: a strike runs the combat
state-machine; taking a cache runs the conserved gold transfer above; freeing a captive flips a held
flag; observing accrues evidence into a knowledge field. Freeing a captive looks like a special case
but is not — like taking a cache, it is a trivial final act (cut the bonds) gated by a hard
requirement (be there, unopposed), and the requirement decomposes into ordinary scouting and movement.
The variety lives in the executors; the actions above them stay uniform.

## At runtime there is no big shared structure

It is natural to picture all this as a giant decision tree every agent walks. It is the opposite. What
exists at runtime is:

- a flat set of actions (the rows above),
- a set of small rules that turn an agent's needs and beliefs into goals,
- one generic planner (a few hundred lines) that knows nothing about any specific situation,
- a flat set of reactive rules (the interaction schemas; [09](09-reasoning-layer.md)).

The plan for a heist or a rescue is *built when needed*, for one agent, from that agent's beliefs, and
thrown away — a short, bounded search. The situations this doc keeps naming are not entries in the
code; they are paths the planner happens to find through the same flat set of actions under different
beliefs. The maintained code grows with the *vocabulary* — the actions and topics — and the behaviours
are what emerge from it. All agents share that vocabulary the way speakers share a language and still
say different sentences; the differences come from the beliefs, which are per-agent.

Planning is not free, but it is occasional (on a new goal or a forced re-plan), bounded (a small depth
and step limit), and thinned for distant or idle agents, so the cost per agent per tick stays flat as
the population grows.

## Three plans in full

The opening heist is deliberately simple. These three are closer to what the planner actually produces,
and each leans on a different part of the design.

**The smuggler — quantities, confidence, and a stale price.** Mara wants to hold at least 80 gold. She
believes wheat is cheap at home and dear in Thorngate — but she heard the Thorngate price third-hand,
so her confidence in it is low. The planner weighs the options by cost. Selling her current stock at
home brings in roughly 30, short of 80. Buying wheat cheap, hauling it to Thorngate, and selling dear
could clear the gap — but the Thorngate price is a low-confidence belief, so that branch's cost is
inflated to reflect the chance the trip is wasted. A single cartload's believed yield is about 50, so
even if she takes the haul, the planner adds a second acquisition — another load, or a sale at home —
until the believed total crosses 80. She sets out. On arrival the real Thorngate price has already
converged, because everyone heard the same rumour and the good is no longer scarce; her price belief
was stale; the sale yields less than believed; the goal is still short; and she re-plans from where she
stands. The wasted trip is a believable consequence of acting on a shared, fading belief, not a bug.

**The urchin — knowledge as a requirement, confidence in the cost.** Pip wants 50 gold and believes
Olen is rich, but he has only a faint, half-glimpsed idea where the cache is. Taking from a cache
requires *knowing* where it is, and Pip's belief is present but below the confidence that action needs
— and even if it scraped by, the low confidence would inflate the cost, since a raid on a guessed spot
likely wastes the night. So the cheapest plan that reaches the threshold is to make the knowledge solid
first: `observe` Olen (slow, first-hand, trustworthy) or `ask` a fence (fast and cheap, but it tips
Olen off). Pip, despised and with no one to ask, observes. Once the location is confident, `go → take`
runs. If Olen has moved the cache in the meantime, Pip arrives to an empty hole — his belief was stale
— and re-cases. The same machinery, pointed at a `Recipe` instead of a `Loc`, is an apprentice who
`study`s a master, or a spy who `observe`s a rival workshop.

**The rescue — strength, hold-until, and a control that loses.** Four want to free captives held at a
camp of thirty. Freeing a captive requires being at the captive and *unopposed*, and unopposed means
the camp's believed strength is low enough for four to manage. The party's belief starts near thirty,
so that requirement is nowhere close, and any plan that simply walks in is refused outright — the route
cost is enormous with thirty believed hostiles around it. The party does not charge. A scout instead
`observe`s the camp from cover, building a `Strength` belief, and the plan places a **hold-until** step:
wait, hidden, until believed strength drops, or abandon at a deadline. When the scout sees the raiders
leave, the belief falls to about five, the hold releases, and `go → free` runs; the freed captives
follow the party out, pursued by the returning bandits using the same who-went-where inference that
drives every chase. A party *without* the scout never forms the strength belief: it has nothing telling
it to refuse — and is wiped if it tries — or it never sees the window open and never goes. The win is
the knowledge, not the swords. And if the scout is away when the raiders leave, the window is simply
never noticed.

## What this covers

Working through the situation catalogue, nearly every situation is expressible with these actions and
topics plus, at most, a new row or a new topic — data, not new machinery. The narrow exceptions are
*recurrence* (anything on a repeating schedule, which is re-derived from memory rather than planned —
see [Waiting and deadlines](#waiting-and-deadlines)) and *sub-combat tactics* like a feint, which
belong to the fighter, below the planner. Single waits and deadlines, by contrast, are first-class.

Tracing the harder situations through the real planner also shows that a "plan" is often richer than a
straight line: economic plans emerge only when the cheap local options run out; social plans (bait,
threaten, court, command) act to shift the odds and then hold, expiring if the other party never bites;
and operations like a rescue are *refuse, scout, hold for the moment, then move*. In every case the
plan can only form once the relevant belief has been gathered — which is what makes the behaviour
believable rather than omniscient.

## Building it

The planner's search gains one capability and otherwise stays as it is: composing several actions
toward a **numeric threshold** (summing believed yields past a target, for gold, stockpiles, and
graded needs), since that underpins the very first example. The actions then become rows generated
from the tables above, the way the interaction schemas and abilities are already data rather than code.

A sensible order — each step leaving the tests green, and any new behaviour switched off by default so
the long-running soak is unchanged:

1. **Quantities.** Make the planner compose actions toward a threshold, and let needs be graded. This
   is foundational and load-bearing for everything that accumulates.
2. **Knowledge.** Build `Know(topic)` and the `observe` / `ask` / `study` actions over the knowledge
   model, and fold confidence into cost. Generalise the current single-purpose `shadow` (which only
   learns a cache) into `observe` over any topic, and fold the current `approach` into ordinary
   movement toward a place you have located. This is what the covert and teaching behaviours both need,
   and it lets a teacher reuse the machinery a spy uses.
3. **Resources.** Turn `buy` / `gather` / `produce` / `loot` / `take` into rows of the acquire table,
   carrying the conservation rule.
4. **Waiting.** Add the hold-until step and goal deadlines.
5. **The rest**, as breadth requires — each a row, a field, or a topic: the remaining acquire rows, the
   `Believes` effect, wrecking and freeing, and the place-state, strength, secret, and price topics.
