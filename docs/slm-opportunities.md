# Small Language Model Opportunities in *Hearsay / Market Town* — a standalone brief

> **Purpose & status.** A self-contained, forward-looking map of where a *small* language model (SLM)
> can add value in this project. Written to stand alone: a reader with no access to the source can
> follow it. Code locations are collected in the appendix, not the body. Nothing here is as-built
> except §2 (the existing SLM layer); the rest is opportunity.

---

## 1. What this project is (context)

**The game.** A browser-based 3D (Three.js) sandbox that grew from a melee-combat prototype into a
**Theory-of-Mind agent simulation** set in a medieval market-town (often several linked towns, ~65
NPCs). Its core conceit: **NPCs act on what they *believe*, not on what is true.** They perceive their
surroundings, **gossip** (rumours spread agent-to-agent with *fading confidence* and *provenance* — a
literal telephone game), **trade** on their own price beliefs, hold grudges, level up emergent RPG
classes from what they do, and some are **spies** who disguise themselves and plant *false* rumours.
The player is one fighter in this world; every NPC also forms beliefs about the player.

**The world model has two halves.** (1) **Beliefs** — each agent holds a small, bounded table of
beliefs about other agents: an opinion, a suspicion level, whether it thinks the other is hostile, a
last-known location, a believed reputation, and crucially the *provenance* of each belief (seen
first-hand vs heard third-hand) and a *confidence* that decays over time. (2) **Episodic memory** —
salient life-events an agent remembers (it was assaulted, it received a kindness, it witnessed a
death). The cardinal rule, the **epistemic split**: *decisions read beliefs only; execution reads
truth.* An agent can therefore be genuinely fooled (by a disguise or a planted rumour) while the
physics of the world still resolve correctly. This is what makes the deception layer work, and it is
the invariant any new feature — SLM included — must not break.

**Architecture constraints (these shape every opportunity below).**
- **Local-first, dependency-free.** No cloud service is required to run the game; there are no runtime
  package dependencies; all libraries and assets are vendored; it is served as a static page and runs
  entirely in the browser (plus a headless test harness for CI). Any SLM use should respect this ethos
  — work offline, with no mandatory external API.
- **Fixed-tick simulation + the "freeze lesson."** The simulation advances cognition at a fixed rate
  every frame. Anything that runs on that tick **must never block or throw** — a single slow or
  failing call freezes the entire sim. Therefore **nothing slow or fallible (an SLM call) may run
  synchronously on the tick.**
- **Deterministic and testable.** A headless suite drives the whole simulation and asserts invariants
  (no freeze over long runs, a closed/conserved economy, beliefs form, etc.). That must stay
  reproducible, which means the SLM is **off during tests** and is never part of the pass/fail gate.

---

## 2. The existing SLM layer (already shipped — the pattern to generalize)

The project already runs a genuine small model: **LiquidAI LFM2.5-350M** (a 350-million-parameter
model) served **locally** via **vLLM** behind an OpenAI-compatible HTTP endpoint. It is used in two
places:

- **NPC dialogue.** A "persona" bundle assembled from **one** NPC's beliefs and state is turned into a
  single short spoken line when the player talks to them.
- **The town newspaper ("the Gazette").** A deterministic "story-brief" about one townsperson —
  assembled headlessly from their deeds, drives, relationships, and a rumour they personally repeat —
  is enriched into a short, characterful article (or obituary).

Both obey the same **hard rules**, and those rules *are* the design template for everything below:

1. **Never on the simulation tick.** Calls happen only on browser-/user-paced paths (the dialogue
   modal, the newspaper panel), never inside the fixed-rate loop.
2. **Never load-bearing.** The call resolves to *text or null*, and **never throws**. On any failure
   (model off, server down, timeout, bad output) it returns null and the deterministic **template
   text is the floor** — a fresh checkout with no model running behaves *exactly* the same. The SLM
   only ever *upgrades* an output that already exists and is already correct.
3. **Off by default**, behind a single switch.
4. **Epistemic split by construction.** The model is only ever handed the bundle for **one** agent
   (their beliefs) or a single story-brief — never the omniscient world state — and the system prompt
   forbids inventing facts. Provenance is passed in, so the prose can *hedge* a third-hand rumour
   ("they say…") rather than asserting it. A tiny cache + in-flight de-duplication keep it cheap.

---

## 3. The governing principle

> **The simulation is a deterministic, belief-grounded state machine. The SLM is a non-load-bearing
> *surface* that renders that state into language — its output is displayed, never read back into the
> simulation's logic.**

This is what makes an SLM safe here: the game's *mechanics* (decisions, economy, combat, beliefs) stay
fully deterministic and testable; the SLM only ever touches **presentation** and (carefully) **cosmetic
content**. Two corollaries shape every opportunity:

- **The sim is an SLM-input goldmine.** It continuously emits *structured, bounded, belief-scoped*
  records (see the glossary in §4). Each is an ideal short, schema-shaped prompt.
- **Small = bounded tasks.** A 350M model is good at *short, single-turn, tightly-prompted* transforms
  ("render this struct as one line"; "classify this into one of N labels"). It is **not** a planner or
  a world-consistency engine — that work belongs to the simulation's own systems. The SLM renders
  their results; it never replaces them.

---

## 4. What an SLM can consume here (plain-language glossary)

So the opportunities make sense without the code:

- **Belief** — one agent's record *about another*: opinion (a −1…+1 standing), suspicion, whether it
  believes the other hostile, a last-known position, a believed reputation/fame, and the *provenance*
  (seen first-hand vs heard, with a retelling-depth) and a decaying *confidence*.
- **Episodic memory** — the salient things an agent remembers happening to it, each with a built-in
  short phrasing.
- **Deed event stream** — every meaningful action in the world (strike, kill, buy, sell, craft, theft,
  rescue, recruit…) is published as a small structured event.
- **Chronicle** — a world-history log that distills the deed firehose into notable "beats."
- **Story-brief** — a deterministic bundle the newspaper builds about one soul: their deeds, drives,
  relationships, faith, mood, and a rumour they repeat. (Already the Gazette's SLM input.)
- **Persona** — the one-agent belief bundle handed to the dialogue model.
- **(Planned) arc/saga registry** — a forthcoming record of *complete emergent story-arcs* — a
  vendetta, a rise from rags, a rescue — each as `{kind, principals, beats, outcome}`. Once it exists
  it is a near-perfect SLM prompt (see §5-D).

---

## 5. Opportunity map

Grouped by kind. **Render** tasks (A, F, G) are low-risk (cosmetic, display-only). **Interpret** tasks
(C, E) parse language into a *structured* result and need a constrained-output grammar plus a
deterministic fallback. **Content** tasks (B) generate text that must stay *display-only metadata* so
it can never leak back into the simulation's logic.

### A. Prose surfacing — render structured state into language (low risk, high polish)
| opportunity | feeds on | notes |
| --- | --- | --- |
| **NPC dialogue** *(shipped)* | a one-agent belief bundle | already live; could be broadened with arc context (§D) |
| **Newspaper / obituary** *(shipped)* | a story-brief | already live |
| **Chronicle beat → prose** | a notable world-history beat | turn a terse beat into a one-line dispatch in the live feed |
| **Biography summary** | an agent's salient memories + deeds | a "life so far" paragraph in the inspector, on demand |
| **Epithet / title minting** | a deed profile + class tags | propose a flavourful nickname instead of drawing from a fixed pool (cosmetic) |
| **Quest flavour text** | a generated bounty/delivery/delve contract | dress the contract; the mechanics are unchanged |
| **Place / landmark description** | a point-of-interest + its affordances | brief "look" text when the player inspects a place |
| **Dying words / last line** | the victim's beliefs + their killer | a final spoken line at the moment of death (pre-generated, cosmetic) |
| **Class / ability flavour** | an emergent class + its dominant tags | blurbs for *procedurally* generated classes that have no authored copy |
| **Letters & notes as items** | a quest/relationship record | a readable note handed to the player (a love letter, a debt, a threat) |
| **Town founding-myth / lore** | a town seed + its dominant family names | one-time worldgen flavour: a town's origin story |
| **Gravestone epitaph** | the obituary brief, short form | the terse stone-cut twin of the newspaper obituary |

### B. Rumour & belief *content* — the telephone game, in words (medium risk, the on-theme one)
Today, gossip garbles **confidence and provenance numerically**; the rumour *text* is templated. The
SLM can voice the qualitative twin:
- **Rumour-text garble** — distort the *wording* of a rumour as it passes mouth to mouth, escalating
  in step with retelling-depth (seen → heard → secondhand → "a tale much retold"), so it *sounds* more
  garbled the further it has travelled.
- **A spy's false testimony** — the deception layer plants a hostile belief; the SLM writes the
  *content* of the slander (the words of the lie), attributed and hedged.
- **Escalating insults / grudge phrasing** — a feud's spoken barbs sharpen as opinion falls.
- **A peace-keeper's reconciliation** — the *words* of a brokered truce.

**Hard constraint for all of B:** the generated text is **display-only metadata** on the belief/event;
the simulation keeps reading the structured fields, never the text. It never feeds back into decisions
— which is also what keeps the deception layer honest.

### C. Structured interpretation — SLM as parser/classifier (medium risk, needs a grammar)
Freeform language → a *structured* result the game acts on, always with a deterministic fallback. Use a
JSON-schema / grammar-constrained decode + stop tokens so a parse failure is a clean fall-through.
| opportunity | direction | guardrail |
| --- | --- | --- |
| **Freeform player dialogue → intent** | player types a line → `{intent: ask\|persuade\|threaten\|trade\|recruit, topic}` | unmapped → the existing menu choices; the *effect* is always a deterministic game action |
| **Persuasion / intimidation check** | *what the player actually says* → a quality score | feeds the existing standing/reputation math as the "roll"; weak input → default roll |
| **Arc labelling (detection aid)** | a window of deeds/beliefs → a trope label + confidence | advisory only; the planned arc registry is the trigger, the SLM is a *secondary* tagger |
| **Memory-salience hinting** | a memory chain → which episode is "formative" | advisory flavour; the numeric salience model stays authoritative |
| **Relationship tone tag** | belief deltas → a one-word mood tag for UI | cosmetic |
| **Input moderation** | freeform player text → safe/unsafe | a gate in front of any freeform-input feature |

### D. Arc narration — the payoff of the planned detection tooling (high value, depends on the arc registry)
Once an emergent story-arc closes as a clean record `{kind, principals, beats, rounds, outcome}`, that
struct is a *perfect* SLM prompt:
- **Completed-arc story** — render a finished vendetta / rags-to-riches / rescue / dynasty as prose for
  the chronicle or newspaper.
- **"Chronicle of the Age"** — an end-of-session epic stitched from the closed arcs.
- **Per-family dynastic saga** — the rise, feuds, and marriages of a house across generations.
- **The player's ballad** — the player's notoriety sung as a tale.
- **A newspaper serial** — one arc followed across successive issues as it develops.

Detection makes arcs **legible as structs**; the SLM makes them **readable as prose**. This is the
marquee reason to build the detection tooling: *very high value, small effort once the registry exists.*

### E. Player-as-author — natural language *into* the world model (highest theme-fit, medium risk)
The literal premise of *Hearsay* made interactive: the player doesn't just read beliefs, they *inject*
them. Each is an "interpret" task that parses the player's language into a **belief-scoped,
player-sourced** record the existing systems carry — never ground truth, always low-confidence and
attributable.
- **Plant a rumour** — the player tells an NPC a claim; the SLM parses it into `{subject, predicate,
  valence}` and writes it as a *low-confidence, player-sourced* belief that then **spreads through the
  existing gossip machinery** and can curdle into real hostility. The player becomes a rumour source.
- **Negotiate a price in words** — freeform haggling → a structured offer the market clears against the
  counterparty's price belief (the closed money loop is untouched).
- **Talk someone into joining / standing down** — freeform appeal → the existing recruit / truce
  action, gated on standing.
- **Give testimony** — the player reports what they "saw" an NPC do; it enters as a (witnessed or
  hearsay) belief with the player's provenance.

Every one keeps the epistemic split: the player's words become **a belief held by one agent**, with
confidence and provenance, that the deterministic systems then propagate and act on — the SLM only does
the *parse*. *High value; do it after the render surfaces have proven the off/fallback path.*

### F. Institutional & faith voice — give the world's powers a register (low risk, render)
- **Small-gods scripture & prophecy** — the world has belief-powered minor gods whose strength scales
  with their congregation; the SLM voices their commandments and a prophet's sermons, intensifying as
  the flock grows.
- **The town watch's proclamations** — wanted notices, curfews, bounty postings.
- **Faction manifestos / camp boasts** — a bandit camp's threats, a rival clan's creed.
- **Caravan & trade dispatches** — a trader's report of dear prices in another town (flavour atop the
  real price signal).

### G. Ambient & combat colour — texture, fully cosmetic (low risk, pre-generated)
- **Tavern / market crowd chatter** seeded from local beliefs.
- **Battle cries, taunts, surrender pleas** (pre-generated, never on the tick).
- **Companion banter** — recruited party members commenting on events.
- **Dungeon inscriptions & flavour** in the procedural mazes.

### H. Meta / evaluation / editorial — the SLM that *reads* the sim (medium value)
- **SLM-as-judge for narrative quality** — continuously score a run's emergent stories for coherence /
  drama (a cheap, automated version of a multi-agent narrative evaluation).
- **Editorial selection** — given many candidate story-briefs, pick and rank the few most newsworthy
  for an issue (judgment, not generation).
- **Pacing narration** — render the world's tension state into a one-line "mood of the age."

### I. Dev-time authoring assistance (off the runtime path entirely — zero runtime risk)
An SLM (or a larger model) used *offline* to draft content the deterministic systems then consume
verbatim: new story-trope definitions, seed constellations, faction/camp definitions, name and epithet
pools, the **floor** dialogue/newspaper templates themselves, bulk place descriptions, test scenarios,
and a **trope linter** (given a run's arc records, flag incoherent or never-resolving arcs).

---

## 6. Where an SLM is the WRONG tool (anti-patterns)

- **Anything on the tick.** Cognition, the market, combat, perception — fixed-rate; never await a model.
- **Anything load-bearing or economic.** Decisions, prices, conservation, hostility *are* the game;
  they must stay deterministic, conserved, and testable. An SLM output must never set them.
- **Anything that must be reproducible in tests.** The headless gate runs with the SLM off by design.
- **Multi-step reasoning or world consistency a 350M can't hold.** Don't ask the small model to plan a
  heist or track who-owes-whom across a session — dedicated systems already do that. The SLM renders
  their results.
- **Ground-truth omniscience.** Never hand the model the full world state or another agent's true
  state — only the perceiving agent's beliefs. Breaking this breaks the deception layer.

---

## 7. Practical considerations

- **Model tiering, local-first.** Keep a **local small model as the default** for short lines (it
  preserves the dependency-free, offline ethos). Allow an *optional* larger/remote model for richer
  long-form prose (the newspaper, arc narration), behind the same single switch. A future
  **browser-only** path (running the model in-page on the GPU, no server at all) would fit the
  "everything local, nothing required" architecture and is worth tracking.
- **Structured output / grammars** for every "interpret" task (§C, §E) — constrained decoding to a
  JSON schema or grammar + stop tokens — so a parse failure is a clean fall-through, not a crash.
- **Caching & de-duplication** generalize to every call site: the same persona / brief / arc struct
  should hit a cache, which matters for both latency and (if remote) cost.
- **Prompt = the belief bundle, nothing more.** Reuse the existing pattern: a plain struct filled from
  *one* agent's state, a system prompt that forbids inventing facts and passes provenance so the prose
  hedges. This is what keeps the epistemic split intact.
- **The template is the contract.** Every SLM feature must have a deterministic template that is the
  floor; the SLM only ever *upgrades* an output that is already present and already correct.

---

## 8. Suggested build sequence

1. **A small shared client** every surface reuses (the existing dialogue/newspaper split already proves
   the shape — most of §A/F/G is the same render call with a different struct). *(small)*
2. **Render surfaces** — chronicle-beat prose, biography summaries, then the cosmetic institutional /
   ambient voices (§A, F, G): best polish-per-effort, pure render, no new risk; they harden the shared
   off/fallback path before anything interpretive depends on it. *(small)*
3. **Arc narration** (§D), as soon as the arc/saga registry exists — the marquee payoff: detection +
   SLM together turn emergent state into *told stories*. *(small, gated on the registry)*
4. **Rumour-text garble** (§B) — the on-theme content feature; needs the display-only-metadata
   discipline wired so generated text can never leak into the simulation's logic. *(medium)*
5. **Player-as-author: plant-a-rumour** (§E) — the standout interactive feature, truest to the game's
   premise; behind a grammar + menu fallback, the player's parsed claim enters as a low-confidence,
   player-sourced belief that spreads through the existing gossip machinery. *(medium)*
6. **Freeform player dialogue → intent** and the rest of §C/§E — the broadest UX leap and the biggest
   risk; last, once the render surfaces and the first interpret feature have proven the fallback path.
   *(medium)*

**The throughline:** this sim's distinctive asset is a *deterministic, belief-grounded world model* that
already emits rich structured state. An SLM's job here is never to *be* the world — it is to **render
the world's own structured truth into language**, as an optional surface the game is provably correct
without. Every opportunity above is an instance of that one move.

---

## Appendix — where this lives in the source (for readers with the repo)

The body above is deliberately code-free. For implementers, the concrete anchors:
- Existing SLM layer: `js/ai/llm.ts` (dialogue client, the `Persona` bundle, cache/sanitize/fallback),
  `js/ai/press.ts` (Gazette/obituary enrichment from a `StoryBrief`); setup in `docs/llm-npcs.md`.
- The records an SLM consumes: beliefs `js/sim/beliefs.ts` (`BeliefState`: standing/suspicion/hostile/
  assoc/notoriety/source/hops/confidence); episodic memory `js/sim/memory.ts` + `js/sim/biography.ts`
  (`memoryPhrase`); the deed bus `js/rpg/events.ts` (`ActionEvent`); the chronicle `js/sim/chronicle.ts`
  (BEAT kinds); the story-brief `js/sim/gazette.ts` (`StoryBrief`).
- The planned arc/saga registry: `docs/architecture/12-narrative-tooling-lld.md` (in design).
- The disciplines: `CLAUDE.md` (the "freeze lesson", the epistemic split, the local-first/vendored
  build); `docs/architecture/02-epistemic-split.md`.
