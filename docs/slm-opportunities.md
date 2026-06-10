# Opportunities for a Small Language Model in Hearsay / Market Town

> **High-level design note (forward-looking, not as-built).** This maps where a *small* language
> model (SLM) can add value in this project, the principle that governs all of it, and where an SLM
> is the wrong tool. It builds on what already ships — the local-SLM dialogue + Gazette layer — and
> on the structured, belief-grounded state the sim already produces. See `docs/llm-npcs.md` for the
> running setup; `js/ai/llm.ts` and `js/ai/press.ts` for the two existing call sites.

## 0. What already exists (the pattern to generalize)

The sim already runs a real SLM: **`LiquidAI/LFM2.5-350M`** over a local **vLLM** OpenAI-compatible
endpoint, in two places:

- **`js/ai/llm.ts` — NPC dialogue.** A `Persona` bundle built from **one** NPC's beliefs/state is
  turned into a single short spoken line. User-paced (the modal dialogue path), tiny LRU cache +
  in-flight dedupe, `sanitize()` on the output.
- **`js/ai/press.ts` — Gazette articles + obituaries.** A deterministic `StoryBrief` (built headless
  by the Reporter, `js/sim/gazette.ts`) is enriched into a short characterful item, swapped in over
  the already-published template article.

Both obey the same **hard rules** (mirroring CLAUDE.md's freeze lesson), and those rules *are* the
design principle for everything below:

1. **Never on the simulation tick.** Browser-/user-paced or background only.
2. **Never load-bearing.** `generateLine`/`generateArticle` resolve to a string/object **or null**,
   never throw; any failure → null → the deterministic **template is the floor**. A fresh checkout
   with no server behaves *exactly* as before.
3. **Off by default**, gated by one `hearsay.llm` localStorage flag.
4. **Epistemic split by construction.** The model only ever sees the bundle it's handed (one agent's
   beliefs, or a `StoryBrief`) — never the roster or ground truth — and the system prompt forbids
   inventing facts. Provenance (`hops`/`source`) is passed so the prose can *hedge* a thirdhand rumour.

## 1. The governing principle

> **The sim is a deterministic, belief-grounded state machine. The SLM is a non-load-bearing surface
> that renders that state into language — its output is displayed, never read back into sim logic.**

This is what makes an SLM safe here: the game's *mechanics* (decisions, economy, combat, beliefs)
stay fully deterministic and testable; the SLM only ever touches the **presentation** and (carefully)
**cosmetic content**. The headless test suite runs with the SLM off, so it is never in the gate.

Two corollaries shape every opportunity:
- **The sim is an SLM input goldmine.** It continuously produces *structured, bounded, belief-scoped*
  records — beliefs (`BeliefState`: standing/suspicion/hostile/assoc/notoriety/source/hops), episodic
  memories (`memoryPhrase`, `biography.ts`), the RPG deed bus (`js/rpg/events.ts`), chronicle beats
  (`js/sim/chronicle.ts`), the `StoryBrief`, and — once built — the **arc/saga registry**
  (`docs/architecture/12-narrative-tooling-lld.md`). Each is an ideal short, schema-shaped prompt.
- **Small = bounded tasks.** A 350M model is good at *short, single-turn, tightly-prompted*
  transforms (render this struct → one line; classify this into one of N labels). It is *not* a
  planner or a world-consistency engine. Match the task to the model.

## 2. Opportunity map

Grouped by kind. Each notes the sim data that feeds it, the discipline it must keep, and a rough
value/effort. **Render** tasks (A, F, G) are low-risk (cosmetic, display-only). **Interpret** tasks
(C, E) need a structured-output grammar + a deterministic fallback. **Content** tasks (B) need the
display-only-metadata discipline so generated text can't leak into sim logic.

### A. Prose surfacing — render structured state into language (low risk, high polish)
| opportunity | feeds on | notes | value / effort |
| --- | --- | --- | --- |
| **NPC dialogue** *(shipped)* | the `Persona` (one agent's beliefs) | already live; broaden the persona with arc context (§D) | — |
| **Gazette / obituary** *(shipped)* | `StoryBrief` | already live | — |
| **Chronicle beat → prose** | a `chronicle.ts` BEAT `{kind, ids, t}` | turn the terse beat into a one-line dispatch in the live feed | high / small |
| **Biography summary** | `biography.ts` + salient memories | a paragraph "life so far" in the inspector, on demand | high / small |
| **Epithet / title minting** | a deed profile + class tags (`EPITHETS`) | propose a flavorful epithet instead of pool-draw; **cosmetic only** | med / small |
| **Quest flavor text** | the emergent/radiant quest struct (`js/quest/quest.ts`) | dress a bounty/deliver/delve contract; mechanics unchanged | med / small |
| **Place / biome description** | `MentalMap` `Place` + affordances | brief "look" text for POIs the player inspects | low / small |
| **Dying words / last line** | the victim's beliefs + killer + a witnessed-death event | a final spoken line at the moment of death (pre-generated, cosmetic) | med / small |
| **Class-codex / ability flavor** | an emergent class + its dominant tags (`js/rpg/classes.ts`) | flavorful blurbs for procedural classes that have no authored copy | low / small |
| **Letters & notes as items** | a quest/relationship struct | a readable note/letter handed to the player (a love letter, a debt, a threat) | med / small |
| **Town founding-myth / dateline lore** | town seed + `HOUSES` surnames | one-time worldgen flavor: a town's origin story, its dominant houses | low / small |
| **Gravestone epitaph** | the obituary `StoryBrief`, short form | the terse stone-cut twin of the Gazette obituary | low / small |

### B. Rumour & belief *content* — the telephone game, in words (medium risk, the on-theme one)
Today gossip garbles **confidence and provenance numerically** (`beliefs.ts` `_garble`/`mergeFrom`);
the rumour **text** is templated. The SLM can voice the qualitative twin:
- **Rumour-text garble** — distort the *wording* of a rumour as it passes mouth to mouth, escalating
  in step with `hops` (seen → heard → secondhand → "a tale much retold"), so the prose *sounds* more
  garbled the further it has travelled.
- **The spy's false testimony** — `INTRIGUE`/`falseWitness` plants a hostile belief; the SLM writes
  the *content* of the slander the spy spreads (the words of the lie), attributed and hedged.
- **Escalating insult/grudge phrasing** — a feud's spoken barbs sharpen as `standing` falls.
- **The Patrician's reconciliation** — the *words* of the truce a peace-keeper brokers (`patrician.ts`).

**Hard constraint for all of B:** generated text is **display-only metadata on the belief/event**; the
sim's logic keeps reading the structured fields, never the text. It never feeds back into decisions —
which is also what keeps the deception layer honest.

### C. Structured interpretation — SLM as parser/classifier (medium risk, needs a grammar)
Freeform language → a *structured* result the game acts on, always with a deterministic fallback (a
JSON-schema / GBNF grammar + stop tokens, so a parse failure is a clean fall-through, not a crash).
| opportunity | direction | guardrail |
| --- | --- | --- |
| **Freeform player dialogue → intent** | player types a line → `{intent: ask\|persuade\|threaten\|trade\|recruit, topic}` | unmapped → the existing menu choices; the *effect* is a deterministic game action |
| **Persuasion/intimidation check** | *what the player actually says* → a quality score | feeds the existing reputation/standing math as the "roll", bounded; weak input → default roll |
| **Arc labelling (detection aid)** | a window of deeds/beliefs → a trope label + confidence | advisory only; the arc/saga registry (§D) is the trigger, the SLM is a *secondary* tagger |
| **Memory salience hinting** | a memory chain → which episode is the "formative" one | advisory flavor for biography; the numeric salience model stays authoritative |
| **Relationship tone tag** | belief deltas → a one-word mood tag for UI | cosmetic |
| **Input moderation** | freeform player text → safe/unsafe | a gate in front of any freeform-input feature |

### D. Arc narration — the payoff of the detection work (high value, depends on doc 12)
Gated on the arc/saga registry. Once an emergent arc closes as a clean record `{kind, principals[],
beats[], rounds, outcome}`, that struct is a *perfect* SLM prompt:
- **Completed-arc story** — render a finished vendetta / rags-to-riches / rescue / dynasty into prose
  for the chronicle or Gazette.
- **"Chronicle of the Age"** — an end-of-session epic stitched from the closed arcs.
- **Per-house dynastic saga** — the rise/feuds/marriages of House X across generations (`houses.ts` +
  `lineage.ts`).
- **The player's ballad** — `LEGEND` notoriety (once generalized to read deeds) sung as a tale.
- **A Gazette serial** — one arc followed across successive issues as it develops.

Detection makes arcs **legible as structs**; the SLM makes them **readable as prose**. *Very high value
/ small effort once §12 lands — it is the marquee reason to build the detection tooling.*

### E. Player-as-author — natural-language *into* the world model (highest theme-fit, medium risk)
This is the literal premise of *Hearsay* made interactive: the player doesn't just read beliefs, they
*inject* them. Each is an "interpret" task that parses player language into a structured, **belief-
scoped, player-sourced** record the existing systems carry — never ground truth, always low-confidence
and attributable.
- **Plant a rumour** — the player tells an NPC a claim; the SLM parses it into `{subjectId, predicate,
  valence}` and writes it as a low-confidence, player-sourced belief (`beliefs.ts` `plant()`) that then
  **spreads through the existing gossip machinery** and can curdle into real hostility. The player
  becomes a rumour source in their own right.
- **Negotiate a price in words** — freeform haggling → a structured offer the market clears against the
  counterparty's price belief (bounded; the closed money loop is untouched).
- **Talk someone into joining / standing down** — freeform appeal → the existing recruit/party or
  patrician-truce action, gated on standing.
- **Give testimony** — the player reports what they "saw" of an NPC's deed; it enters as a witnessed (or
  hearsay) belief with the player's provenance.

Every one keeps the epistemic split: the player's words become **a belief held by one agent**, with
confidence and provenance, that the deterministic systems then propagate and act on — the SLM only does
the *parse*. *High value / medium effort; do it after the render surfaces prove the fallback path.*

### F. Institutional & faith voice — give the world's powers a register (low risk, render)
The drama/society subsystems are rich sources of authored-feeling copy with zero logic risk:
- **Small-gods scripture & prophecy** — `FAITH` gods whose power scales with believers; the SLM voices
  their commandments and a prophet's sermons, intensifying as the congregation grows.
- **The Night Watch's proclamations** — `WATCH`/`BOUNTY`/`ALERT` postings, wanted notices, curfews.
- **Faction manifestos / camp boasts** — a bandit camp's threats, a rival clan's creed (`CAMPS`).
- **Caravan & arbitrage dispatches** — a trader's report of dear prices in another town (`arbitrage.ts`)
  — flavor on top of the real price signal.

### G. Ambient & combat colour — texture, fully cosmetic (low risk, pre-generated)
- **Tavern / market crowd chatter** — ambient one-liners seeded from local beliefs.
- **Battle cries, taunts, surrender pleas** — short combat barbs (pre-generated, never on the tick).
- **Companion banter** — recruited party members commenting on events (`party.ts`).
- **Dungeon-room inscriptions & flavor** — text on walls/relics in the procedural mazes.

### H. Meta / evaluation / editorial — the SLM that reads the sim (medium value, dev + runtime)
- **SLM-as-judge for narrative quality** — continuously score a run's emergent stories for coherence /
  drama (an automated, cheap version of the multi-agent trope evaluation we run by hand).
- **Gazette editorial selection** — given many candidate `StoryBrief`s, pick + rank the few most
  newsworthy for an issue (editorial judgment, not generation).
- **Pacing narration** — render the Director's `points`/tension state into a one-line "mood of the age".

### I. Dev-time authoring assistance (off the runtime path entirely)
An SLM (or a larger model) used *offline*, as tooling, to draft content the deterministic systems then
consume verbatim — zero runtime risk:
- New Director trope rows, seed constellations, `CAMPS`/faction definitions.
- Name / surname / epithet pools per culture or house.
- The **floor** dialogue & Gazette templates themselves (the deterministic fallbacks).
- Bulk biome/place descriptions; test scenarios and narrative assertions.
- A **trope linter**: given the arc-registry output of a run, flag incoherent or never-resolving arcs.

## 3. Where an SLM is the WRONG tool (the anti-patterns)

- **Anything on the tick.** Cognition, the market, combat, perception — all fixed-rate and must never
  await a model. (The freeze lesson is absolute here.)
- **Anything load-bearing or economic.** Decisions, prices, conservation, hostility — these are the
  game; they must stay deterministic, conserved, and testable. An SLM output must never set them.
- **Anything that must be reproducible in tests.** The headless gate runs SLM-off by design.
- **Multi-step reasoning or world consistency a 350M can't hold.** Don't ask the small model to plan
  a heist or track who-owes-whom across a session — that's what the GOAP planner, the obligation
  ledger, and the belief table are *for*. The SLM renders their results; it doesn't replace them.
- **Ground-truth omniscience.** Never hand the model the roster or another agent's true state — only
  the perceiving agent's beliefs. Breaking this breaks the deception layer.

## 4. Practical considerations

- **Model tiering, local-first.** Keep the **local SLM (LFM2.5-350M) as the default** for short lines
  — it preserves the project's dependency-free, offline, no-cloud-API ethos. Allow an *optional*
  larger/remote model (a 1–3B local model, or a hosted small model like a Haiku-class API) for the
  richer Gazette/arc-narration prose, behind the same `llmConfig` switch. A future browser-only path
  (WebGPU via WebLLM / transformers.js) would make the SLM available with **no server at all** — worth
  tracking, since it fits the vendored, import-mapped, "everything local" architecture.
- **Structured output / grammars** for every §C "interpret" task — JSON-schema or GBNF + stop tokens —
  so a parse failure is a clean fall-through to the deterministic path, not a crash.
- **Caching & dedupe** (already in `llm.ts`) generalize to every call site: the same persona/brief/arc
  struct should hit a cache, which matters for both latency and (if remote) cost.
- **Prompt = the belief bundle, nothing more.** Reuse the `Persona`/`StoryBrief` pattern: a plain
  struct the SLM layer fills from one agent's state, with a system prompt that forbids inventing
  facts and passes provenance so the prose hedges. This is what keeps the epistemic split intact.
- **The template is the contract.** Every SLM feature must have a deterministic template that is the
  floor — the SLM only ever *upgrades* an output that already exists and is already correct.

## 5. Suggested sequence

1. **Generalize the existing transport** (`llm.ts`) into a small shared client every surface reuses
   (chronicle, biography, faith, institutions) — the dialogue/press split already proves the shape,
   and §A/F/G are all the same render call with a different struct. *(small)*
2. **Render surfaces** — chronicle-beat prose, biography summaries, then the cosmetic institutional/
   ambient voices (§A, F, G): highest polish-per-effort, pure render, no new risk, and they harden the
   shared off/fallback path before anything interpretive depends on it. *(small)*
3. **Arc narration**, as soon as the arc/saga registry (`docs/architecture/12`) exists — the marquee
   payoff: the detection work and the SLM together turn emergent state into *told stories* (§D). *(small, gated on §12)*
4. **Rumour-text garble** (§B) — the on-theme content feature; needs the display-only-metadata
   discipline wired so generated text can never leak into sim logic. *(medium)*
5. **Player-as-author: plant-a-rumour** (§E) — the standout interactive feature and the truest to the
   game's premise; behind a grammar + menu fallback, the player's parsed claim enters as a low-confidence,
   player-sourced belief that spreads through the existing gossip machinery. *(medium)*
6. **Freeform player dialogue → intent** and the rest of §C/§E — the broadest UX leap and the biggest
   risk; last, once the render surfaces and the first interpret feature have proven the fallback path. *(medium)*

**The throughline:** this sim's competitive advantage is a *deterministic, belief-grounded world model*
that already emits rich structured state. An SLM's job here is never to *be* the world — it is to
**render the world's own structured truth into language**, as an optional surface that the game is
provably correct without. Every opportunity above is an instance of that one move.
