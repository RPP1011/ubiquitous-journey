# 10 — The action grammar & the knowledge model

> **Status: vocabulary implemented, day-one OFF.** This describes the vocabulary the planner builds
> plans from — the *actions*, the *effects* they produce, how *quantities and time* enter a plan, and
> how an agent's *knowledge* is stored. It is self-contained: everything needed to understand the
> design is here. The "Building it" roadmap below is now implemented in `js/sim/planner.js` (+ the
> obligation ledger in `js/sim/obligations.js`), each phase behind a config flag that ships **false**
> so the planner stays byte-identical and the soak is unchanged until a breadth step turns it on:
>
> | phase | what landed | flag (`js/sim/simconfig.js`) |
> | --- | --- | --- |
> | 1 — Quantities | greedy threshold composition + widen/satisfice/cooldown + graded needs | `QUANTITY` |
> | 2 — Knowledge | `Know(topic)` + observe/ask/study + confidence-into-cost | `KNOW` |
> | 3 — Resources | the `ACQUIRE` table (made/moved conservation) + the `rob` row | `ROB` |
> | 4 — Waiting | the hold-until step (+ deadlines, reactive preemption) | `HOLD` |
> | 5 — The rest | `recruit`/believed-force/`Believes` (one level) + Strength/Secret topics; `wreck`/`free`; the obligation ledger | `RECRUIT`, `AFFECT`, `LEDGER` |
>
> The *live wiring* is now implemented too — the executors for the new verbs, the goal-derivers,
> and the conserved resolver primitives — as five disjoint feature modules in `js/sim/features/`
> (urchin/learning/recruiter/affect/ledger), each gated by its flag and covered by a frame-loop
> test suite. Flags still ship OFF (byte-identical soak), but a populated town with them ON is
> stable and produces emergent thievery. See the LLD §19–20 for the as-built status, the remaining
> gaps (graded recipes, wealth-cue estimation, captivity/sabotage triggers, NPC war-parties), and
> the narrative-depth evaluation. Each phase is covered by gated tests in `test/suites/planner.mjs`,
> `obligations.mjs`, and the per-feature `urchin/learning/recruit/affect/ledger.mjs`.
>
> **Implementing it?** This doc is the *design* (the why). The step-by-step *implementation* spec —
> the module map, data structures, and pseudocode for the planner, the registries, the resolver, the
> ledger, and each feature module — is the LLD companion:
> **[`10-action-grammar-lld.md`](10-action-grammar-lld.md)**, which also tracks the current
> implementation status and the remaining gaps.

## What the planner does

A **goal** is a state the agent wants to be true (for example, *hold at least 50 gold*). The planner
works backwards from the goal: it finds an **action** whose result would help make the goal true,
treats that action's requirements as new sub-goals, and repeats, until every requirement is already
true in the agent's **beliefs** — its own private picture of the world. The output is an ordered list
of actions; the agent carries them out one at a time, and re-plans if its beliefs change underneath
it.

Everything the planner reasons about is a belief, never the world directly. An agent reads and writes
only its own picture of things, and reaches other agents only by acting where they can perceive it —
cognition runs on beliefs; only perception and the physical resolver touch the truth. This is the
simulation's central rule, and it is what lets an agent be **wrong** — walk to a cache that has been
moved, haul goods to a town whose prices have already shifted.

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

**Reaching a threshold is greedy, and can fail.** The planner does not weigh every combination of
sources — a dozen known sources make that space large, and the depth limit on the plan tree does not
bound it. It is greedy: add the acquisition with the best believed yield for its cost, then the next,
until the believed total crosses the target. That is cheap (bounded by the handful of sources an agent
actually knows of) and good enough; it is not guaranteed optimal, and that is an accepted trade.

Often the target *cannot* be reached — an agent wants 80 gold but believes it can lay hands on only 50
across everything it knows. This is the common case, not an edge: agents want more than they can reach
all the time, so the failure path is the hot path, and what the planner does on it sets the personality
of every poor agent in the town. It does three things, in order. It first widens the search to options
it would otherwise pass over — riskier acts, lower-confidence leads (a half-heard cache, a dangerous
mark) — because once the safe sources fall short, the only plans that reach the target are expensive
ones; how far it widens is set by how hard the underlying drive is pushing, so a desperate agent acts
on rumour and a comfortable one does not. If even that falls short, it commits the best plan it *can*
reach (earn the 50), partly relieving the drive. And it puts the goal on a brief cooldown, so the same
unreachable target is not re-attempted every tick — which is what would otherwise livelock. The drive
persists (it lives in motivation, not the goal); its pressure rebuilds, or a new lead arrives, and the
agent tries again. The felt result is a poor soul who does what it can, bides its time, and takes a
risk when the want gets bad enough — not one frozen on an impossible sum, nor one that stops wanting.

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
located; whichever is cheapest given its beliefs wins. This is one of the two reasons two agents with
the same actions behave differently — the choice falls out of each one's beliefs, not from anything
authored per agent. The other reason is that the *cost itself* is weighted by who the agent is, not
only by what it believes; that is [personality](#personality--nature-alongside-nurture), below.

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
somewhere safe or hidden, re-checks a condition each tick, and advances when the condition becomes
believed-true. It abandons on either of two failures, and they are different: the **deadline** passes
(the window never opened — wait elsewhere, or give up the goal), or the spot stops being safe (the agent
is discovered — flee *now*). The second is the reactive layer's doing — a believed threat appearing
mid-hold fires the same flee any agent would — and it **preempts** the held step. So the reactive rules
and the planner are not as separate as "checked alongside" suggests: a reaction can interrupt an
in-progress plan step, dropping or suspending the plan, after which the agent re-plans from wherever it
ends up. The hold is where that interaction is routine, so it is specified here rather than assumed away.
The "refuse, scout, wait, move" shape of a rescue is exactly *go to a vantage → observe the camp →
hold-until its believed strength drops → move*.

The same step covers the social plays that act-then-wait: show weakness then hold until the foe
closes; make an offer then hold until it is taken — each abandoned if nobody bites. Goals carry an
optional deadline for this — a time by which the waited-for condition must hold, after which the goal
is dropped. Beliefs already carry when they were last seen and fade as they age, so "has the window
opened?" and "has this gone stale?" are ordinary belief reads.

What stays outside a plan is **recurrence**. A plan is a one-shot ordered list with, at most, a
deadline. A thing that *repeats* — a debt due every season, a nightly patrol, "they always raid at
dusk" — is not placed in the plan; it is re-derived from memory each time it comes due. A single wait
or deadline is first-class; a schedule is not.

## What an agent can sense

Every belief an agent holds entered through one of a few narrow channels, and those channels are the
whole of its contact with the world. There are four.

**Sight.** An agent sees what is within range of it — other agents, and the fixed things of the world
(houses, market stalls, a camp). It is the richest channel and the one the truth-into-belief bridge runs
on: from it an agent reads where something is, what it *appears* to be (its faction, which a disguise can
fake), and what it is *doing* — moving, striking, blocking, trading. It does not read what a thing *is*
beneath the appearance, nor anything off its surface: not another's gold, not their intent, not what they
know. And sight is range-limited, so most of the world is, at any moment, simply unseen — there is no
overhead view of the town, only what each agent makes out from where it stands. (That same range limit
is what keeps the whole thing affordable: an agent that cannot see the roster cannot reason over it.)

**Hearsay.** Agents near one another pass on what they believe — gossip. A belief received this way
arrives weaker than a thing seen first-hand and carries its provenance (how many mouths it came through),
so a rumour is held more loosely than a sighting and hedged accordingly. Hearsay is how a fact travels
past the range of any one pair of eyes: the urchin can be *told* where a cache is, the town can *hear*
that a master has died. It is also how false belief spreads — a planted rumour is hearsay with a lie in
it.

**The news.** The town has a published channel — the gazette — that agents read: prices, bounties, the
notable deaths and deeds. It is institutional hearsay, town-wide and slower, with its own credibility and
its own staleness (a printed price is already a little old). An agent weighs it like any belief, by how
much it trusts the source and how fresh it is.

**Being acted upon.** An agent directly experiences what is done to it — struck, blocked, given to,
traded with — and that writes belief without inference: who hit me, who helped me, who I dealt with. It
is the one channel that cannot be faked at a distance, and so the ground of an agent's most certain
beliefs about others.

Everything else an agent seems to "know" is *inferred* from these four. It never senses a mark's wealth,
a camp's true numbers, where a quarry is heading, or what a rival knows; it senses the cues — a fat trade
seen, a guarded house, a rumour, a glimpsed crowd — and estimates the rest (see
[acting under uncertainty](#acting-under-uncertainty)). The senses are deliberately poor, and that
poverty is the point: an agent that could see everything would have nothing to be wrong about.

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

Retelling-depth earns its place as its own field rather than folding into confidence: it independently
drives how a fact is *retold and credited* — the newspaper hedges a third-hand rumour, a speaker cites a
source — separately from how much a plan trusts it. If it only ever fed confidence decay it would be an
input, not a field; it is kept because that retelling behaviour reads it directly.

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
- **Fading, and what pushes back**: confidence falls with time and with each retelling, so a fact nobody
  renews drifts back toward unknown — but first-hand re-observation pushes it back up. The equilibrium is
  the believable one: what agents keep seeing stays sharp, what stops being seen fades, and the town
  forgets exactly the things no one is watching any more — not everything. (Decay alone, with nothing
  pushing up, would make a town monotonically forget all it did not witness this instant — a specific and
  wrong world; the upward pressure is what stops that.)

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
- **A raid on an empty camp.** Physical state is believed like everything else, not specially kept
  accurate. A party commits to freeing captives it believes are held at a camp; by the time it arrives
  they have been moved, or killed, or the camp has emptied. The plan was sound at plan time and wrong at
  execution — the physical twin of raiding a moved cache, with lives committed instead of a night wasted
  — and it resolves the same way: the agents perceive the truth on arrival and re-plan or retreat.
  `strike` and `free` plan against a believed `Dead` / `Freed` / held state exactly as `take` plans
  against a believed cache, with the same exposure to being wrong; the document is no more careful about
  physical state than about gold, because the engine isn't either.

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
- a flat set of reactive rules — a condition that, when an agent comes to believe it, fires an
  immediate response (flee a believed threat, hide from a hunter), checked each tick alongside the
  planner and separate from it.

The plan for a heist or a rescue is *built when needed*, for one agent, from that agent's beliefs, and
thrown away — a short, bounded search. The situations this doc keeps naming are not entries in the
code; they are paths the planner happens to find through the same flat set of actions under different
beliefs. The maintained code grows with the *vocabulary* — the actions and topics — and the behaviours
are what emerge from it. All agents share that vocabulary the way speakers share a language and still
say different sentences; the differences come from each agent's **beliefs** (what it has seen — nurture)
and its **personality** (what it was born like — nature; see [Personality](#personality--nature-alongside-nurture)),
both per-agent.

## Personality — nature alongside nurture

Everything so far makes agents differ by *circumstance*: same vocabulary, same planner, different
beliefs, so different plans. But circumstance alone is all nurture and no nature — a town of identical
souls who would each behave the same in the same spot. The missing axis is **personality**: a small,
fixed vector of innate traits each agent is born with — how far it tolerates risk, how hard it chases
status, how much it values company, curiosity, and the welfare of others — set at birth, partly
inherited from its line, and roughly constant across a life. Personality adds no actions and no effects.
It **weights the machinery already here**, at three points, so two agents with identical beliefs in
identical circumstances still choose differently.

**What you want.** The rules that turn needs and drives into goals are weighted by personality, so the
*agenda* differs. The ambitious form wealth and renown goals sooner and hold them harder; the sociable
reach for belonging and company; the curious go out of their way to observe and explore; the kind form
goals to help. Two equally poor agents want different things — one to get rich, one to be liked —
because their drives are weighted differently. This is the largest lever: personality shapes what an
agent is even trying to do.

**What you'll pay and risk.** The planner chooses by cost, and personality re-weights cost. Risk
tolerance discounts or inflates the danger-and-uncertainty penalties: a bold agent finds the heist on a
half-seen cache, or the assault at marginal odds, *cheap* and takes it; a cautious one finds the same
plan dear, scouts more, and refuses thin margins. The same trait sets how far the
[failure path](#effects--the-units-a-plan-is-made-of) widens toward desperate options — the reckless act
on rumour, the timid never do. Altruism discounts the cost of giving and helping — a generous soul finds
repaying a favour or sharing food cheap, a grasping one finds it dear — so the same gift is an easy plan
for one agent and an unaffordable one for the next.

**What you'll even consider.** Some goals are gated by disposition, not just ability. A scrupulous
agent's goal-rules never produce theft or coercion even when broke and perfectly able to pull them off —
it begs, works, or goes without; a larcenous one reaches for them readily. So Pip robs the merchant
partly because he is broke (nurture) and partly because he is the sort who would (nature); a different
poor soul in the same straits works a field or asks for alms. This gate is what stops "everyone turns
thief when money is tight" — poverty is the circumstance, character is the choice.

So three axes, clean: the **grammar** is the shared language every agent speaks; **beliefs** are the
world each one happens to have seen (nurture); **personality** is the innate weighting each was born with
(nature). Identical beliefs in identical circumstances still diverge, because the same plan costs them
differently and the same need pushes them differently — and because personality is partly **inherited**,
families carry tendencies: a line of cautious traders, a line of bold raiders, nature with a heritable
grain. Personality is a weight vector read at the points the agent already decides; it is never its own
subsystem and never its own actions.

## Acting under uncertainty

The planner reasons in believed quantities — a believed yield, a believed price, a believed strength —
and the examples have so far let those be roughly knowable. Many are not. The urchin's whole plan turns
on how much gold is in the cache, and that is a number it will **never** observe until the moment it
cracks it: surveillance can confirm *where* the cache is, but not *how much* is inside. So how does it
decide the heist is worth doing?

It doesn't know; it **estimates**. A believed quantity is not a measured fact, it is an *expected value
with a confidence*, and where it cannot be observed directly it is inferred from what can — the mark's
apparent wealth, the size and guard of his house, his trade, the gossip that he is rich. Those proxies
give the urchin an expected haul, wide and held at low confidence, and the planner acts on that
expectation exactly as it acts on a price it has only heard. The decision to commit is expected gain
against cost and risk: a believed-fat cache, discounted by how unsure the estimate is and by the danger
of the act.

**How the estimate is actually formed** is not a probability calculation; it is the same evidence-accrual
that builds every other belief, anchored on a prior. The mark's *category* — a merchant, a master of his
trade, of a known house — gives a baseline: roughly what someone like that is worth, a typical figure of
the same kind as a base price, held at low confidence when it is all the urchin has. Then each wealth-cue
the urchin *perceives* nudges that baseline and firms it up — a fat transaction seen at the market, a
large and well-guarded house, the gossip that he is rich — each shifting the expected amount toward what
it implies and raising confidence, a thing seen first-hand counting for more than a thing merely heard.
This is the identical machinery that consolidates a stash's *location* from repeated sightings or a
camp's *strength* from a scout's glimpses: the amount is just another believed quantity accrued onto the
urchin's belief about the mark, carrying the usual value, confidence, provenance, and decay. Every input
is itself a belief — the urchin acts on what it *thinks* it saw of the mark's trade, never on his real
ledger — so it all stays in belief-space and the split holds. It is a heuristic, a prior nudged by
weighted cues rather than a posterior, and that is exactly what makes it fallibly believable: the
estimate is wrong precisely when the cues mislead — a merchant who dresses and trades richly but banks
every coin reads as a fat mark and yields an empty cache, while a quiet miser reads as poor and is passed
over. The urchin's mistake is *rational on what it could see*, which is the only fairness it is owed.

Two levers already in the design carry it. **Confidence enters the cost**, so a hazy estimate makes the
heist *expensive* — likely a wasted, dangerous night — which pushes a careful agent to case the mark
longer (sharpening the proxy: more of his trade seen, a better read on his means) before committing, and
lets a hurried one gamble on a guess. **Risk tolerance** sets the appetite for the spread: a bold urchin
robs on "merchants are rich, it's probably worth it"; a cautious one moves only on a mark it has built
real confidence is loaded, and otherwise leaves it. The same ambiguous prize is a tempting bet for one
agent and not worth it for another — character and uncertainty interacting.

And because the estimate was never certain, it can simply be **wrong**: the urchin cracks the cache
expecting fifty and finds eight — the merchant banks most of it, or had a bad season. The plan was
rational on what was known; the gamble didn't pay. This is the believable-failure shape of the stale
cache and the stale price, but its root is worth distinguishing: staleness is a fact that *was* true and
went off; this is a quantity that was *never* observed and was only ever a hopeful guess. Some acts are
gambles by nature, and the design lets agents take them — and regret them — rather than pretend they
have information they could not have. The same holds wherever a plan leans on what it cannot measure: a
camp's strength is a scout's glimpse and can be undercounted; a recruit's loyalty is a read on a choice
not yet made; a foreign price is a number heard, not seen. In each, the agent acts on an expectation —
inferred from proxies, carrying its own uncertainty, weighted by character — and is sometimes wrong,
which is the point.

## Cost and scale

The whole flat-vocabulary, no-shared-structure architecture rests on planning staying affordable as the
town grows, so here are numbers rather than an assurance. A single plan is a hard-bounded backward
search — a depth limit, a frontier limit, an eight-step plan limit — and measures about **3 µs** today
(~300,000 plans per second on one core); the greedy threshold-composition above adds a small pass over
the handful of sources an agent knows, which should keep it in the low tens of µs. A full frame for ~66
agents — perception, gossip, reasoning, deciding, the market, acting, combat, all of it — is about
**0.45 ms** (~37× real-time).

Planning runs only when an agent takes a new goal, or a belief a current plan depends on changes; most
ticks, most agents are carrying out a plan, not making one. The hard case is not the average — it is the
**burst**, and the design's own dynamics manufacture it: forty traders who heard the same price rumour
discover it stale the same tick and all re-plan together. This survives for one reason — a plan is cheap
*and* bounded — so even the pathological tick where *every* agent re-plans at once costs population ×
per-plan: at a target near **250 agents** and ~12 µs per plan, about **3 ms**, inside a 16 ms frame. The
burst is affordable because the per-plan cost is capped, not because re-plans are rare.

Beyond that — a far larger population, or a worse pathology — there is a **per-tick planning budget**: a
cap on plans computed per tick, with agents that want to plan entering a priority queue (urgency and
nearness first). When a burst exceeds the budget the excess spills into the next few ticks; the give is
latency — a low-priority agent reacts a tick or two late, invisible off-screen — and the gain is that
the per-tick cost is clamped no matter how many spike at once. At the target population the budget is
rarely reached; it is a ceiling, not the normal path.

So "thinned" means *this budget and its priority*, not agents going dark — and it changes how *often* a
low-priority agent deliberates, never whether the world stays correct. The conserved quantities, gold
and goods, are maintained every tick by the market and physics passes, which are not thinned; an
off-screen economy therefore stays conserved and consistent while its agents merely deliberate less
often. The reasoning-cost-per-agent-per-tick is measured by the test harness and gated to stay flat as
the population grows — the number, not this paragraph, is what holds the claim up.

## Four plans in full

The opening heist is deliberately simple. These four are closer to what the planner actually produces,
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
— and re-cases. Note what Pip *cannot* learn by casing: how much is actually in the cache. He never sees
inside until he cracks it, so the haul is an estimate from Olen's apparent wealth — and the whole heist
is a bet on that estimate, decided as [acting under uncertainty](#acting-under-uncertainty) describes.
The same machinery, pointed at a `Recipe` instead of a `Loc`, is an apprentice who `study`s a master, or
a spy who `observe`s a rival workshop.

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

**The recruiter — building a force, the hardest path.** The rescue began with a party of four already
formed; this is where that party comes from, and it is the case most likely to need new machinery, so it
is the one worth walking. A would-be leader wants to assault a camp it believes has strength thirty;
alone it has strength near one. The assault requires a believed force that outmatches the camp, so the
leader builds toward that number the same way it would build toward 80 gold — by accumulation. The
acquisition here is `recruit`: approach a candidate and offer to lead them. But a command does not bind
another agent — they decide for themselves — so `recruit`'s effect is not "+1 to my force," it is a
belief: *I believe this candidate will follow*, held at a confidence reflecting how likely they are to
(a loyal friend, high; a wary stranger, low). The leader's believed force is its own strength plus each
candidate's strength weighted by that compliance confidence, and the planner adds recruits — greedily,
cheapest reliable force first — until the believed sum outmatches the camp; then the assault, with the
scout-and-wait of the rescue, is gated on that sum.

The follower is a real agent, not a number in the leader's head, and the design has to say what makes
following rational for *them*. `recruit` does **not** write a goal into the candidate — that would be the
foreign-mind write the rest of the design forbids. It is an `Inform`: the leader makes an *offer* the
candidate perceives — a share of the venture's spoils, a role, an appeal to standing — which changes the
candidate's *beliefs* (there is an offer, with a believed payoff), nothing more. What happens next is the
candidate's **own** motivation: it weighs that believed payoff against the believed risk, tilted by its
standing toward the leader, and — if the balance favours it — forms its *own* goal to join, whose first
step is to rally at the muster. A loyal friend with a good share forms that goal readily; a wary stranger
does not. (This is the reputation-gated party-join the sim already has, with a risk-and-reward weighing
on top.)

So both sides are modelled, symmetrically. The leader's "compliance confidence" is its *prediction* of
that independent decision, read off the cues it can see — the candidate's standing, its apparent
situation, the size of the offer — calibrated against a real choice, not a dice-roll, which is exactly
why it can be wrong. The failure now has a mechanism at both ends: the three no-shows did not roll low,
they **re-planned** — their own scout-gossip put the camp's strength higher, or a better opportunity won,
or a fear preempted, and the join-goal lost to something else in *their* heads. The leader, unable to see
those internals, over-counted. That is why a careful leader prefers four certain followers to eight
doubtful ones, and why one who can raise the believed payoff (more spoils, a safer plan) recruits more
reliably: it is shifting a real decision, not nudging a random number.

`recruit` is a new row, "believed force" is a derived reading rather than a stored topic, and the
follower side is an ordinary goal-generator (the candidate wants the share, or values the bond) — no new
subsystem, and no foreign-mind write. Because this is the path most likely to have cracked the
architecture, walking *both* ends of it cleanly is the strongest single piece of evidence the rest holds.

## What this covers, and what it doesn't

The honest claim is narrower than "everything is a row." The situations actually traced here — trade and
arbitrage, theft, blackmail, courtship and reconciliation, scouting, recruiting, rescue — are expressible
with these actions and topics plus, at most, a new row or a new topic; behaviours that plainly compose
from them (a market corner is repeated buys, sabotage is `wreck`, a famine flight is `Move` off a
believed-depleted place) are rows too. That is the claim, bounded by what has been walked, not asserted
over everything imaginable. Three things need more than a row, and naming them is better than pretending.

**Commitments need one small store.** "I'll pay you when you deliver," "I'll testify if you do" — a
thing promised now and discharged later, when an event the agent perceives comes to pass. That is not an
acquire row; it is a standing intention — a remembered `(trigger, deferred action, counterparty, expiry)`
that perception can satisfy and time can lapse. So the vocabulary needs one piece of genuinely new
machinery: a small per-agent **obligation ledger**, a handful of outstanding intentions checked against
perception each tick. It is modest — structurally a little belief table with decay — but it is a store
and a per-tick check, not a row, and the doc says so rather than smuggling it in.

A ledger entry and a [hold-until step](#waiting-and-deadlines) look alike — both are "when a believed
condition becomes true, do a thing, with an expiry" — so it is worth saying why they are not one
mechanism. The line is **lifetime**: a hold-until wait lives and dies inside a single plan (drop that
plan on the next re-plan and the wait is gone with it), while a ledger entry **outlives** every plan the
agent makes between promising and keeping. That is exactly why a commitment cannot just be a hold-until
step — the plan it lived in would be discarded at the next re-plan, taking the promise with it — and why
the persistent thing has to sit outside any plan, in the ledger.

That same ledger absorbs two things the rest of the design pushed out of the one-shot plan.
**Recurrence** — a debt due each season, a nightly patrol — was exiled from the plan, but *something* has
to notice when the next instance comes due; that something is an entry in this ledger (a trigger that is
a time or a believed condition), so recurrence is rehomed rather than hand-waved, and its cost is the
ledger check: a few entries per agent, most agents empty. **Reciprocity**, by contrast, does *not* need
the ledger — but for a subtler reason than "it's just a field," and the earlier gloss ("motivation reads
it when we next deal") undersold it. "I owe her one" is a scalar on my belief about her, a relational
field like standing; but motivation reads it as a *drive*, not only opportunistically. A large enough
debt **generates a repay goal of its own** (the planner already has `repay(X)`), which sends the agent
across town to seek her out and square up — so reciprocity is active, it can move an agent to make good,
not merely discharge if a deal happens to recur. It is still a row, because the persistent part is the
scalar and the goal is re-derived from it like any other. The line to the ledger is therefore not
passive-versus-active but *what it waits on*: reciprocity is a standing magnitude the agent acts on of
its own accord, with no armed trigger; a commitment is a response **armed for a specific perceived
event** ("you deliver → I pay"), and arming and persisting that trigger is what the ledger is for.

**Contested resources are accepted, and scoped.** Two agents plan to take the same cache; both believe
the full yield; the first to arrive gets it and the second finds it empty — the stale-belief failure
again, believable once. But if scarce contested prizes were *common*, every contested plan would be a
guaranteed wasted trip for all but one taker, and those wasted trips feed straight into the re-plan
burst. The design's answer is that most acquisition is **non-rival** — gather from a regenerating node,
buy from a market with depth — so contention is rare and reserved for genuinely singular prizes (one
stash, one relic), where the race *is* the drama. A future feature that made scarce contested resources
common would owe a cost back to the [scale budget](#cost-and-scale); today they are rare by construction.

**One level of belief-about-belief, no deeper.** An agent models what another believes, but not what
another believes a *third* believes. Blackmail is worth checking against this, since it sounds recursive:
it works only if the mark believes I hold their secret. But from each side the reasoning is one level — I
act to make the mark believe I have leverage (`Believes(mark, I-hold-it)`), and the mark decides to pay
from its own one-level read (`Believes(me, knows-it)`); neither side needs "I believe you believe I
believe." So blackmail stays in, at depth one. What the cap genuinely forbids is the con that turns on a
third level, and those are out by design.

Beyond these, the only thing outside a plan is *sub-combat tactics* — a feint lives in the fighter, below
the planner. And tracing the harder situations shows a "plan" is often richer than a straight line:
economic plans emerge only when the cheap local options run out; social plans act to shift the odds and
then hold, expiring if the other never bites; operations are *refuse, scout, hold, move*. In every case
the plan forms only once the belief has been gathered — which is what makes the behaviour believable
rather than omniscient.

## Building it

The planner gains two real capabilities; the rest is turning code into data. The capabilities are
**numeric-threshold composition** (greedily summing believed yields past a target, with the failure
semantics above — widen, satisfice, cooldown — since the unsatisfiable goal is the common case) and the
small **obligation ledger** (the one new store, for commitments and rehomed recurrence). The actions then
become rows generated from the tables above — defined as data rather than written as code.

A sensible order — each step leaving the tests green, and any new behaviour switched off by default so
the long-running soak is unchanged:

1. **Quantities.** Make the planner compose actions toward a threshold, with the greedy search and the
   widen/satisfice/cooldown failure path; let needs be graded. Foundational — everything that accumulates
   rests on it, and it sets the personality of every poor agent, so it ships first.
2. **Knowledge.** Build `Know(topic)` and the `observe` / `ask` / `study` actions over the knowledge
   model, and fold confidence into cost. Generalise the current single-purpose `shadow` (which only
   learns a cache) into `observe` over any topic, and fold the current `approach` into ordinary
   movement toward a place you have located. This is what the covert and teaching behaviours both need,
   and it lets a teacher reuse the machinery a spy uses.
3. **Resources.** Turn `buy` / `gather` / `produce` / `loot` / `take` into rows of the acquire table,
   carrying the conservation rule.
4. **Waiting.** Add the hold-until step (both abort paths, and its preemption by the reactive layer) and
   goal deadlines.
5. **The rest**, as breadth requires — each a row, a field, or a topic: the remaining acquire rows, the
   `Believes` effect (one level), `recruit`, wrecking and freeing, and the place-state, strength, secret,
   and price topics; plus the obligation ledger when commitments are wanted.

A few of these have a cost to confirm under load before they are trusted — the planning budget at the
correlated-staleness peak, the obligation-ledger check across a debt-bearing town — and the throughput
harness is where those numbers get taken, not asserted.
