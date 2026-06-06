# The Reporter / Gazette — design

A "Reporter" agent that roams the (now multi-town) world, picks a newsworthy
townsperson, walks to them, "interviews" them, and publishes a **Gazette** of
short articles about their adventures — with the prose optionally written by an
LLM, falling back to a template when no model is available.

This doc is a staged implementation plan. **Nothing here is implemented yet.**

---

## 0. The one invariant that shapes everything

The sim core runs **headless under Bun** (`bun test/headless.mjs`) and the fixed
cognition tick **must never throw, stall, or depend on anything async/external**
(CLAUDE.md "freeze lesson"). An LLM call is async + external + non-deterministic,
so it **cannot touch the tick**.

Therefore the Reporter is split cleanly in two, mirroring how `Chronicle`
(deterministic capture) and `ChroniclePanel` (read-only UI) are already split:

| Layer | Where it runs | Determinism | Headless-safe? |
|---|---|---|---|
| **Reporter agent** — roam, select subject, walk, interview, queue a *story brief* | fixed sim tick (`js/sim/reporter.js`) | fully deterministic (uses `Math.random` like every other subsystem; no I/O) | **yes** — tested headless |
| **Gazette store** — holds published `Article` objects, dedupe, ring buffer | sim object, fed by the agent layer | deterministic data structure | **yes** |
| **Press / LLM enrichment** — turns a queued brief into prose | async side-channel (`js/ai/press.js`), driven by the **render loop / UI**, never awaited on the tick | non-deterministic, best-effort | **N/A on tick** — only runs in browser, degrades to template |
| **Gazette panel** — UI feed, toggle key | render frame (`js/ui/gazette.js`) | read-only | browser only |

The deterministic half produces a **`StoryBrief`** — a plain data bundle of
ground-truthy facts about a subject (biography + salient memories + chronicle
beats + relationships). The async half consumes the brief and produces an
**`Article`** (`{ headline, body, ... }`). If the LLM is off/unreachable, a
pure-template renderer turns the *same brief* into a serviceable article. So:
headless tests exercise everything up to and including the template article;
only the LLM swap is browser-and-opt-in.

---

## 1. LLM access — research findings & recommendation

### What exists today (it's already solved)

There **is** a working, production-quality LLM seam in the repo:

- `js/ai/llm.js` — a dependency-free client for an **OpenAI-compatible local
  server** (default `http://localhost:8001/v1/chat/completions`, model
  `LiquidAI/LFM2.5-350M`). Key properties (`js/ai/llm.js:1-21`, `:138-184`):
  - **Default OFF.** Feature flag in `localStorage` (`hearsay.llm`), toggled via
    the console handle `window.llmConfig({ enabled: true })` (`:56-66`, `:187-189`).
  - **`generateLine(persona)` resolves to a string OR `null`, NEVER throws.**
    Any failure (off, server down, CORS, timeout via `AbortController`, bad JSON,
    junk) -> `null`, and the caller keeps its template (`:138-184`). A fresh
    checkout with no server behaves exactly as before.
  - In-flight dedupe + tiny LRU cache (`:68-82`, `:143-146`).
  - `sanitize()` hard-caps and de-junks output (`:125-134`).
- `js/ui/dialogueView.js:14, :90-103` — the existing **consumer pattern**: show
  the template line instantly, fire-and-forget the LLM call, and *swap the text
  in place* if a good line arrives before the turn goes stale (a `_sayToken`
  guards against late arrivals).
- `js/dialogue/dialogue.js:70-120` — `llmPersona()` builds the **plain context
  object** the model speaks from, drawn from the agent's beliefs/state only.
- `docs/llm-npcs.md` — full operator guide: `vllm serve ... --port 8001
  --allowed-origins '["*"]'`, CORS notes, the port-8000-vs-8001 rationale.

So the memory note "class-ability-spec / LLM-gen formulas" was aspirational for
*content generation*, but **NPC-dialogue LLM is real and wired.** The Reporter
should reuse this exact machinery rather than invent a new one.

### The three access options (and the call)

1. **Local OpenAI-compatible server (vLLM/Ollama/llama.cpp) via browser `fetch`** —
   *what the repo already does.*
   - **Pros:** zero new infra, no key in the browser, works offline, CORS already
     documented, matches the no-build/static constraint perfectly, the user runs
     it alongside `python3 -m http.server`. Ollama (`http://localhost:11434/v1/...`)
     is an even lower-friction alternative for the user and is OpenAI-compatible.
   - **Cons:** the user must start a second process; quality bounded by a small
     local model (fine for flavour prose).
2. **Hosted API (OpenAI/Anthropic) with a key in the browser.**
   - **Pros:** better prose.
   - **Cons:** an API key in client-side `localStorage`/JS is exfiltratable; only
     acceptable for a strictly-local single-user dev toy, and even then it's a
     footgun. The existing client already supports an optional `apiKey` Bearer
     header (`js/ai/llm.js:153`), so a user *can* point it at a hosted endpoint at
     their own risk — but we don't recommend it or document it as the path.
3. **Offline / batch pre-generation** (generate articles ahead of time to a JSON
   the page loads).
   - **Pros:** no runtime dependency at all.
   - **Cons:** kills the "live newspaper about *this* run" premise; the sim is
     emergent and per-session, so pre-baking can't know what happened. Reject as
     the primary path.

**Recommendation: Option 1.** Reuse `js/ai/llm.js`'s transport, default-OFF flag,
timeout/abort/sanitize discipline, and graceful-degradation contract verbatim.
Add a sibling `js/ai/press.js` that exposes one new call, `generateArticle(brief)
-> { headline, body } | null` (NEVER throws), built on the same `fetch` + config
(`getConfig()` from `llm.js`, possibly with a `press`-specific `maxTokens`). The
**non-LLM template is the source of truth**; the LLM only *upgrades* it. This
keeps headless tests and offline play identical to today.

> Implementation note: factor the transport in `llm.js` (the `fetch` +
> abort/sanitize core) into a small internal `_chat(messages, opts)` so both
> `generateLine` and the new `generateArticle` share it without duplication, OR
> simply have `press.js` import `getConfig`/`isEnabled` and do its own `fetch`
> (the file is only ~50 lines). Either is fine; prefer the shared core.

---

## 2. Data sources — what an "interview" pulls

All read-only, all already on the agent/sim. An interview = **the Reporter, when
co-located with a subject, reads the subject's state into a `StoryBrief`.** No new
ground-truth is needed; the richness already exists:

- **Biography** — `agentBiography(subject, sim)` (`js/sim/biography.js:12`)
  returns short lines: calling (class . House . level), role (warlord/nemesis/
  watch/captain/spy), faith, family (spouse via `mateId`, kin count via `kinIds`),
  deeds (`life.foeKills`/`monsterKills`/`escapes`), bonds (rival via `rivalId`,
  reconciliations/mentorships from memory). This is the spine of the article.
- **Episodic memory** — `subject.memory` (`js/sim/memory.js`):
  - `memory.salient(n)` (`:84`) -> the formative few episodes, strongest first.
  - episode shape `{ t, kind, withId?, place?, valence, salience }` (`:13`).
  - `memoryPhrase(ep, nameOf)` (`:92-108`) renders an episode as a past-tense
    phrase ("bested X", "killed X", "survived X's onslaught", "struck it rich at
    the market", "found a relic in a ruin", "made peace over X"). The Reporter
    feeds these phrases to the model (or to the template) — they are exactly the
    "what happened to you" interview answers.
- **Beliefs** — `subject.beliefs` (`js/sim/beliefs.js`): the subject's opinion of
  third parties (their loudest rumour, who they fear/hate). Optional colour; use
  the same "what's the latest thing you've heard?" angle dialogue uses
  (`dialogue.js:_topRumour`). **Epistemic split holds:** the article reports what
  the subject *believes/remembers*, which is exactly journalistically correct —
  a newspaper prints testimony, not omniscient truth.
- **Relationships** — `mateId`, `kinIds[]`, `rivalId` on the agent (used by
  `biography.js:38-53`); resolve to names via `sim.agentsById`.
- **Identity/standing** — `given`/`name`/`house` (`js/sim/houses.js:12-14`),
  `epithet` (`js/sim/combatEvents.js:24`), `progression.primaryClass()` +
  `totalLevel`, role flags (`watch`, `spy`, `warlord`, `nemesis`), `faction`,
  `townAnchor` (which town they call home — `simulation.js:202`).
- **Chronicle beats they appeared in.** The Chronicle's public beats are
  `{ id, t, kind, text }` (`chronicle.js:92`) — **note the load-bearing gap: the
  public beat does NOT expose `subjectId`** (it's only used internally for dedupe,
  `chronicle.js:43,88`). Two options to attribute beats to a subject:
  1. **Cheap/now:** name-match — scan `sim.chronicle.recent(n)` + `legends(n)` for
     beats whose `text` contains the subject's `name`/`given`. Works because every
     beat is phrased with agent names (`chronicle.js` design comment, `:8`).
  2. **Clean/later:** add `subjectId` to the public beat object in `_push`
     (`chronicle.js:92`) and an optional `bySubject(id)` reader. Low-risk additive
     change, but it edits Chronicle — defer to a follow-up; **do not** do it as
     part of the first cut (this design touches only new files; see SS 7).
  Recommend (1) for v1.

### What makes a subject WORTH interviewing (newsworthiness score)

Deterministic scalar over read-only state, computed in `reporter.js`. Higher =
more newsworthy. Suggested terms (all guarded, all tunable in config):

- `+` strongest salient memory's `salience` (a fresh, vivid episode) — the single
  biggest signal; `memory.salient(1)[0].salience`.
- `+` recency: episodes whose `t` is within the last N sim-seconds (just *did*
  something) outweigh old glories.
- `+` has an `epithet` / is `nemesis`/`warlord`/`watch` captain (already storied).
- `+` count of chronicle beats mentioning them in the recent window.
- `+` a live `rivalId` (a vendetta is a story), survived a caravan/expedition
  (`life.escapes` rose), a recent windfall/relic, a recent class-up.
- `-` recently interviewed (cooldown — see SS 3) so the Gazette doesn't repeat one
  darling.
- exclude: the player (`controlled`), monsters (`faction === MONSTER.faction`),
  the Reporter itself, the dead.

The Reporter picks the **highest-scoring living townsperson** (optionally biased
toward its current town, see SS 3) above a `minNewsworthy` threshold; if none
clears the bar, it just keeps roaming (no forced filler).

---

## 3. The Reporter as a sim AGENT

Fits the existing **role-flag** pattern (Watch/Expeditions/Director already do
this): a normal `Agent` re-flagged and steered by a thin subsystem. Modeled on
`js/sim/watch.js` and `js/sim/expeditions.js`.

### Spawning

- Singleton (or small N, config `REPORTER.count`, default 1). Spawned in
  `Simulation.buildWorld` after townsfolk, OR promoted from an existing
  townsperson (cleaner: a dedicated spawn so it has no trade obligations).
- Flag `agent.reporter = true`; set `profession: null`-style economy guards the
  way monsters/player are guarded (CLAUDE.md "freeze lesson" — anything on the
  agent path must tolerate a professionless agent; the Reporter has no trade).
- It is **non-combatant** (`combatant = false`), so the Watch/expedition pools and
  hostility checks naturally skip it; it's a press observer, not a fighter.
- `inParty`/`watch`/`spy` etc. all false. Give it a recognizable name/role so the
  inspector and dialogue read nicely ("Town Crier" / "the Gazetteer").

### The state machine (deterministic, on the fixed tick)

A `Reporter` subsystem (`js/sim/reporter.js`) with a self-throttled `tick(ctx,
dt)` exactly like `Watch.tick`/`Expeditions.tick` (gated on `sim._spawned`,
wrapped in try/catch, "never throw on the tick"). The reporter-agent's *movement*
reuses the existing goal/`act` machinery — same trick Expeditions uses: it sets a
goal the existing `decide.js`/`act.js` already know how to walk
(`expeditions.js:8-9` comment). Add a lightweight `reporter` goal branch (go-to a
target position), or simpler: drive `agent.moveTarget` directly each reporter tick
(check how `act.js` consumes a move target before choosing).

Phases (stored on the agent or in the subsystem, per-reporter):

1. **ROAM / SELECT.** Periodically (cooldown `selectEvery`), score all candidate
   subjects (SS 2). Pick the best above threshold -> set it as `target`, enter
   TRAVEL. Subject selection is **world-wide but town-biased**: prefer subjects in
   the reporter's current town; if the best story is in *another* town, the
   reporter will travel there (this is the inter-town news mechanism, see below).
2. **TRAVEL.** Walk toward the subject's position (re-acquire if the subject
   moves; abandon with a timeout if the subject dies or wanders too far — guard).
3. **INTERVIEW.** When within `interviewRange` of the subject for `dwellSecs`
   (co-located, like dialogue requires proximity), **snapshot a `StoryBrief`**
   from the subject's read-only state (SS 2). This is the only "interview"
   mechanic — deterministic, headless-testable: it's a structured read, not a
   conversation. Optionally publish a chronicle beat ("The Gazetteer interviewed
   {name}.") via `sim.chronicle.note('press', subjectId, ...)` for flavour
   (`chronicle.js:69`). Mark the subject `lastInterviewedT` (drives the
   newsworthiness cooldown).
4. **FILE.** Push the `StoryBrief` into `sim.gazette.queue` (a bounded queue of
   pending briefs) and return to ROAM. **The article isn't written here** — only
   the brief is filed. The async Press layer (SS 4) drains the queue.

### Carrying news between towns (the inter-town narrative the user wants)

- The reporter literally **walks between town cores** (`sim.towns[i].center`,
  `simulation.js:165`) to reach out-of-town subjects, so its travel *is* the
  courier mechanic.
- When it files a brief, tag it with `originTown` (the subject's `townAnchor`) and
  `filedInTown` (where the reporter currently is). The Gazette can then show
  "datelined" articles — news from Town A read in Town B — giving the player a
  sense that stories propagate. (Pure metadata; no new sim coupling.)
- Optional richer hook (later): when the reporter *arrives* in a new town, it can
  drop the previous town's top story as a planted rumour/chronicle beat there,
  literally spreading news. Keep this out of v1; it touches beliefs.

### Determinism & headless testing

Everything in SS 3 phases 1-4 is `Math.random`/state only — **no I/O, no await.** A
headless scenario (add to `test/scenarios.mjs`, run by `test/headless.mjs`) can
assert: a reporter exists; over K ticks it interviews >=1 subject; each interview
files a well-formed `StoryBrief`; the **template** article renderer turns every
brief into a non-empty `{headline, body}`; the Gazette ring stays bounded; gold is
conserved (the reporter has no economy and must not perturb it). The soak's
existing invariants (no freeze, townMin>0) must stay green with the reporter
present.

---

## 4. Publishing surface — the Gazette

### Data: `js/sim/gazette.js`

A small sim-owned store, constructed in `Simulation` and `dispose()`d like the
others (`simulation.js:126,145`). Holds:

- `queue` — pending `StoryBrief`s filed by reporters (bounded; oldest dropped).
- `articles` — a **bounded ring** of published `Article` objects (`GAZETTE.cap`),
  newest-last, with a monotonic `id` (mirror `Chronicle._seq`/`recent()` exactly,
  `chronicle.js:39-65`), so the panel can cheaply detect new entries via a
  signature like the ChroniclePanel does (`ui/chronicle.js:90`).
- Dedupe per subject within a window (don't re-publish the same soul back to back).

`Article` shape:

```js
{ id, t,                       // sim-seconds when published
  headline, body,             // the prose (template OR llm)
  subjectId, subjectName,
  originTown, dateline,       // "TOWN A" — for inter-town flavour
  source: 'template' | 'llm', // provenance, shown as a small chip
  brief }                     // the StoryBrief it was rendered from (for re-render)
```

Public API: `gazette.publish(article)`, `gazette.recent(n)`, `gazette.count()`,
`gazette.takeBrief()` (pop one pending brief for the press to render).

### The deterministic template renderer (the floor)

`js/sim/gazette.js` also exports `templateArticle(brief, sim) -> { headline, body
}` — pure, headless-safe, NEVER throws. It composes the biography lines +
top-salient `memoryPhrase`s + a relationship clause into a couple of sentences and
a stock headline pattern (e.g. `"{Name}, {class} of {Town}, {lead deed}"`). This
is what headless tests assert on and what offline play shows. (Reuse
`biography.js` and `memoryPhrase` verbatim — don't re-derive prose.)

### The async Press layer

`js/ai/press.js` (browser-only consumer, never on the tick):

- A small pump driven from the **render loop** (or a `setInterval` started by the
  Gazette panel when first shown): each call, `brief = sim.gazette.takeBrief()`;
  if none, return.
- Render the **template** article immediately and `gazette.publish()` it (so the
  Gazette is never empty waiting on the model). Then **fire-and-forget**
  `generateArticle(brief)`; if it resolves to a good `{headline, body}` before
  going stale, **swap that article in place** (by `id`) and flip its `source` to
  `'llm'` — exactly the dialogueView swap pattern (`dialogueView.js:90-103`).
- Concurrency: render one brief at a time (a queue), reuse `llm.js`'s in-flight
  dedupe discipline; honor the `timeoutMs`/abort budget so a hung server never
  stacks up.

### UI: `js/ui/gazette.js`

A panel cloned from `js/ui/chronicle.js` (self-injecting CSS + root node,
signature-cached redraw, read-only). Toggle key: **`J`** (Journal/Gazette) — wired
in `playerControls.js` next to the others (`playerControls.js:141-152`), and
constructed in `js/ui/hud.js` next to `ChroniclePanel` (`hud.js:40`) with a render
call in the HUD frame (`hud.js:145`). Shows newest-first articles: headline (bold),
dateline + time + a small `template`/`llm` source chip, body. `_esc()` everything
(`ui/chronicle.js:116`). Clicking an article could expand/collapse the body
(optional). No mutation of sim state.

---

## 5. The LLM prompt design

Reporter **persona/voice:** a wry small-town gazetteer — vivid but grounded, never
inventing facts beyond the brief, short (a headline + 2-4 sentences). The brief is
the *only* source of truth handed to the model; the system prompt forbids
fabrication, so the epistemic-split correctness (we feed beliefs/memories, the
model doesn't reach into omniscient state — it can't, it only sees the brief) is
preserved by construction, just like `llm.js`'s `buildMessages` (`llm.js:87-114`).

### Structured context fed to the model (from the `StoryBrief`)

```
subject:    name, epithet, class, level, House, town (dateline), faction/role
deeds:      biography lines (agentBiography)
witnessed:  top-N salient memory phrases (memoryPhrase) — the "interview answers"
relations:  spouse?, rival?, mentor/apprentice?, kin count
hearsay:    the subject's loudest belief/rumour about a third party (optional)
beats:      chronicle beats they appeared in (name-matched), most recent first
```

### Output contract

JSON-ish but tolerant: ask for `HEADLINE: ...` on the first line and the article
body after, then parse defensively (split on first line; if it doesn't parse,
return `null` -> template stands). Reuse `sanitize`-style cleanup. `maxTokens`
~160 (longer than a dialogue line, still short). NEVER throws.

### Example filled-in prompt

**system:**
```
You are the gazetteer of a medieval market-town, writing a short newspaper
item. Write ONLY from the facts provided — never invent names, deaths, or
events not given. Voice: vivid, wry, grounded, past tense. Output a HEADLINE
line, then a 2-4 sentence article. No markup, no lists.
```
**user:**
```
SUBJECT: Bram Ashford, called "the Survivor" — a level 9 Reaver of House
Ashford, of Eastmarket.
DEEDS: Reaver of House Ashford, level 9; has felled 4 foes and cheated death
3 times; rival to Corwin Vale.
WHAT THEY LIVED THROUGH (their own account):
 - survived Corwin Vale's onslaught
 - bested a bandit at the crossroads
 - struck it rich at the market
 - saw Mira Ashford fall
RELATIONS: wed to Lysa Ashford; rival to Corwin Vale; 3 of kin.
HEARSAY THEY CARRY: Corwin Vale is bad business — best avoided.
RECENT TOWN BEATS: Bram Ashford cheated death again at the gates. Corwin Vale
swore vengeance on Bram Ashford.
Write the item.
```

### Plausible example article (LLM)

> **HEADLINE:** The Survivor Walks Again as Eastmarket Holds Its Breath
>
> Bram Ashford — the man they now call the Survivor — was seen at the
> Eastmarket gate, bloodied but unbowed, having cheated death a third time.
> By his own account it was Corwin Vale's blade he slipped, the same Vale who
> has since sworn vengeance over the fallen Mira. Wed to Lysa of his House and
> counting four foes felled, Bram had little to say of the feud — only that
> Vale, in his words, is "bad business, best avoided."

### Plausible example article (template fallback, same brief)

> **HEADLINE:** Bram Ashford, Reaver of Eastmarket, Cheats Death Again
>
> Bram Ashford, a level 9 Reaver of House Ashford, survived Corwin Vale's
> onslaught and bested a bandit at the crossroads. He is wed to Lysa Ashford
> and counts a rivalry with Corwin Vale. The Survivor has cheated death three
> times.

Both are real articles; the template one is plainer but always available.

---

## 6. Staged implementation plan (developer checklist)

**Stage A — deterministic core (headless-green first):**
1. `js/sim/gazette.js`: `Gazette` store (queue + articles ring + dedupe +
   `publish/recent/count/takeBrief`) and `templateArticle(brief, sim)`.
2. Define the `StoryBrief` builder (a pure function, e.g.
   `buildBrief(subject, sim)`) — composes biography + salient memory phrases +
   name-matched chronicle beats + relationships + dateline. Put it in
   `gazette.js` or a `js/sim/storyBrief.js`.
3. `js/sim/reporter.js`: `Reporter` subsystem (spawn/flag the agent, newsworthiness
   scoring, the ROAM->TRAVEL->INTERVIEW->FILE state machine, movement via the
   existing goal/act path). Gate on `_spawned`, try/catch, tunables in config.
4. Wire into `Simulation`: construct + `dispose()` + `tick()` in the fixed-tick
   pass order, alongside Chronicle (`simulation.js:126,145,412`). Add
   `REPORTER`/`GAZETTE` blocks to `js/sim/simconfig.js`.
5. Add a headless scenario in `test/scenarios.mjs`; confirm `bun test/headless.mjs`
   stays green (no freeze, gold conserved, briefs filed, template articles render,
   ring bounded).

**Stage B — async LLM enrichment (browser, opt-in):**
6. `js/ai/press.js`: `generateArticle(brief)` on the shared `llm.js` transport
   (default-OFF, timeout/abort/sanitize, returns `{headline,body}|null`, never
   throws). Add the press pump that drains `gazette.queue`, publishes the template
   first, then swaps in the LLM article by `id`.
7. Extend `docs/llm-npcs.md` (or a short `docs/llm-gazette.md`) with the
   article-prompt + the same `vllm`/Ollama operator notes (mostly already covered).

**Stage C — UI:**
8. `js/ui/gazette.js`: the panel (clone `ui/chronicle.js`), toggle **`J`**.
9. Wire in `js/ui/hud.js` (construct + render) and `js/playerControls.js` (key).
10. Start the press pump from the panel (or the frame loop) so it only runs in the
    browser, never headless.

---

## 7. Constraints honored / files touched

- **No npm, no build, no bundler, no CDN.** Reuses vendored ES modules + the
  existing `fetch`-only LLM seam. Confirmed against CLAUDE.md + the no-node memory.
- **Tick safety:** all deterministic work is guarded + throw-free; the LLM is never
  awaited on the tick.
- **Graceful degradation:** template renderer is the floor; LLM only upgrades.
  Headless + offline play unaffected.
- **New files only** for the build itself: `js/sim/gazette.js`,
  `js/sim/reporter.js` (+ optional `storyBrief.js`), `js/ai/press.js`,
  `js/ui/gazette.js`, plus a scenario. **Edits** needed to *integrate* (not part of
  this doc's no-touch rule, but flagged for the implementer): `simulation.js`
  (construct/dispose/tick), `simconfig.js` (config blocks), `hud.js` +
  `playerControls.js` (panel + key). The optional Chronicle `subjectId` exposure
  (SS 2) is deferred.

---

## 8. Open questions / risks

- **Chronicle attribution.** Public beats drop `subjectId` (`chronicle.js:92`), so
  v1 name-matches beat text to the subject — brittle if two agents share a `given`
  name (House surnames mostly disambiguate; `houses.js:12-14`). The clean fix is
  to add `subjectId` to the beat + a `bySubject()` reader; weigh that small
  Chronicle edit for v2.
- **Reporter mortality / wilderness.** Travelling between towns crosses
  monster-haunted wilds. As a non-combatant it could die. Decide: make it
  effectively unkillable (skip it in hostility/targeting like the player-guard
  paths), respawn it, or let it die and re-promote a new gazetteer (a nice "the
  Crier fell on the road" chronicle beat). Recommend: low monster aggro / respawn
  for v1 to keep the feed flowing.
- **Newsworthiness tuning.** Risk of repeatedly featuring the same handful of
  high-level legends. The interview cooldown + a mild novelty bonus (subjects not
  yet covered) mitigate; expose all weights in `REPORTER` config.
- **LLM latency vs. feed freshness.** Solved by publishing the template first and
  swapping — but if many briefs queue while the model is slow, cap concurrency and
  let the template versions stand (acceptable; they're real articles).
- **Prose factuality.** Small local models may still embellish. The
  "only-from-facts" system prompt + a sanity check (reject articles that introduce
  a name not in the brief, optional) reduce it; worst case the user disables LLM
  and reads templates.
- **Multi-reporter / multi-town scaling.** One reporter can't cover many towns
  promptly. `REPORTER.count` >= towns (one gazetteer per town, occasionally
  travelling) is the natural scale-up; keep it a config knob.
