# 17 (LLD) — Motivation as a first-class layer: the `(primitive × motivation)` factoring & its Theory-of-Mind

> **Status: BUILT (phases P1–P8 landed; some breadth deliberately deferred — see below).** This is the
> *implementation* spec for refactoring the action layer so that **a verb is no longer an atom — it is a
> `(primitive, motivation)` pair.** It is the successor to [`10-action-grammar-lld.md`](10-action-grammar-lld.md):
> the action grammar built the verb→executor registry; this doc *splits the verb itself* into the public
> physical act (the **primitive**) and the private short-term impetus behind it (the **motivation**), and
> makes the motivation a thing other agents must **infer** rather than be told. Read 10 first — it owns
> the registry mechanics this builds on.
>
> **As-built map** (`js/sim/motivation/{registry,arbitrate,infer}.ts`, `js/sim/motives/{acquire,speech}.ts`,
> `types/motivation.ts`; tests in `test/suites/motivation.mjs`):
> - **P1** — the decide() scorer is re-hosted as a row table (`arbitrate`), shadow-proven ≡ the former
>   `scoreAndSelect` (a permanent equivalence oracle, 0 divergence over the soak).
> - **P2** — `a.motive = {key, primitive, bind}` commits the un-fused pair.
> - **P3** — the deed envelope + inbox (`resolver.publishDeed` → `perceivedDeeds` → `drainDeeds`).
> - **P4** — real `inferMotive` (prior×likelihood) writing sparse `believedMotive`/`motiveConf`; the
>   `take` motives (theft/robbery/justice). *Additive*: the standing fold (`witnessDeed`) stays
>   authoritative for magnitude, so this layers the inferred motive without disturbing behavioural gates.
> - **P5** — the `say` primitive + speech motives (warn/slander/vouch) + `resolver.say`.
> - **P6** — deception (`presentTag`/`_deceives` + the cover-tag likelihood bias).
> - **P7** — recursive ToM (`chooseDeceptiveTag`, the guile branch).
> - **P8** — deliberation (`a._puzzles` + `deliberate` + `characterCoherence`).
>
> **Deliberately deferred** (documented, with rationale; the doc's *value* — the (primitive, motivation)
> model + ToM inference + deception + deliberation — is built, these are breadth/cleanup):
> - `act.ts` execution dispatch is **not** rewired through `execMotive`/`runExecutor` (cosmetic; the
>   existing STEER_FILLS + executor-registry path already executes correctly — freeze risk, no payoff).
> - The hardcoded `witnessDeed` standing fold is **not** retired onto inference (P4 is additive instead,
>   which keeps every behavioural gate green; the inferred motive is the *new* signal).
> - `intrigue.ts` `plant()` is **not** retired onto the `say` path (it works and is well-tested).
> - Cue *producers* (the `witnessed_aggression` episode, `strike`-primitive defend/avenge inference) are
>   a natural next extension — the `take` and `say` primitives carry the inference today.
>
> Three hard invariants override everything below:
> - **The epistemic split** ([02](02-epistemic-split.md)): *motivation selection* (the arbitration,
>   the `score`/`bind` of every motivation) reads **beliefs + own-state only**; *primitive execution*
>   (the executor, the resolver) reads ground truth; *motivation inference* (the ToM read, §7) reads
>   the **observer's own beliefs** about the actor, never the actor's true mental state.
> - **Verbs are data** ([10 §7](10-action-grammar-lld.md)): primitives and motivations are both
>   registry rows. Adding a behaviour = registering a motivation row, never a `switch` arm.
> - **The freeze lesson**: every function on the tick path is guarded, never throws, and is
>   bounded (the inference loop is `O(motives-for-this-primitive)`, a single-digit constant).
>
> The single biggest *behavioural* change is to **how a witnessed deed acquires its social meaning.**
> Today that meaning is the actor's *true* `kind`, applied through a **hardcoded per-`kind` reaction**
> in `resolver.witnessDeed` (`simulation.ts:1017`): the executor passes the real verb, and every
> perceiver runs the same fixed standing/suspicion fold (with one hand-coded exception — the "Robin
> Hood" branch where a poor witness *admires* a robbery). It is already per-perceiver and witness-gated,
> but the witness is *told* the meaning, never *infers* it. Under this design the actor emits only the
> **observable primitive**, and each witness **infers** the motivation from its own beliefs — so
> witnesses can be, and routinely are, **wrong**. That fallibility is the whole point: it generalizes
> the one hand-coded misattribution (theft-read-as-justice) into the rule for *every* act, and so makes
> deception a property of every primitive rather than a spy-only special case.

---

## 1. Thesis: the verb is a `(primitive, motivation)` pair

The action audit found ~21 "verbs". They are not 21 primitives — they are a **flattened
cross-product**. Each verb name pre-multiplies one physical act with one short-term reason for doing
it. Factor them apart and ~21 verbs collapse to ~10 primitives over an open-ended motivation axis:

| primitive (public, observable) | the verbs that were really *this primitive + a motivation* |
| --- | --- |
| `take` (from a source) | gather (labour), produce (craft), buy (trade), loot (salvage), burgle (theft), rob (robbery) |
| `transfer` (good / coin) | give (gift / repay), pay (wage / tuition / repay / bribe) |
| `strike` | fight (defense), avenge (vengeance), bounty (contract), seek-renown (glory), predation |
| `locomote` | flee (fear), follow (loyalty), socialize (belonging), court (love), migrate (hope), comfort (weariness), wander (restlessness) |
| `say` (assert a belief into an audience) | warn (loyalty), slander (rivalry), boast (pride), vouch (friendship), accuse (grievance), lie (deceit) |
| `learn` (from a source) | observe (curiosity), ask (gossip), study (apprenticeship) |
| `release` / `damage` / `inform` / `solicit` | free (compassion), wreck (spite), recruit (muster), beg (destitution) |

Two primitives are **new**, not refactored out of a legacy verb: `say` (the speech-acts, §8.1) and
**`deliberate`** (§7.6) — an *internal* act whose "world" is the agent's own mind, by which it reasons
through something it earlier observed. The factoring isn't only compression; it makes room for
primitives the flat verb list had no slot for.

The codebase **already half-did this** — and seeing exactly *which* half is what scopes the work. The
**actor side** is already factored: the goods-acquisition table in `planner.ts` is `take` parameterized
by `{source, socialTrace}`, and `socialTrace` (`'theft'` / `'honest_labour'` / `'robbery'`) *is* the
motivation field, already extracted. What is **not** done is the **witness side**: that `socialTrace` is
a planner-side label that picks an executor — it is *never* read by any witness. Instead the witness
reaction is the hardcoded per-`kind` fold in `witnessDeed` (above), with the bespoke Robin-Hood
exception standing in for "a sympathetic witness reads the theft differently." So this doc inherits the
extracted *actor-side* motivation and supplies the genuinely-missing *witness-side* half — **inference**
— retiring the hardcoded fold (and its one special case) into the general read. That is new
construction on the perception side, not a relabeling; the phase plan (§10) owns it.

### The three layers

```
GOAL          longer-term objective; progress accumulates toward it          (the goal stack, a.goals)
  ▲  served-by (many-to-one)
MOTIVATION    short-term impetus behind ONE physical act; transient;         (NEW: the motivation entity)
  │           private; the thing a witness must INFER
  ▼  drives (many-to-one)
PRIMITIVE     the public, observable motor act; generic; conserved           (the executor registry)
```

Both arrows are many-to-one, which is the crux:

- **Many motivations → one goal.** A `repay` goal is advanced by `transfer`-driven-by-gratitude
  *or* `take`-driven-by-desperation (rob someone to get the coin) *or* `say`-driven-by-vouching
  (talk the debt down). Same progress, different impetus.
- **Many motivations → one primitive.** A single `strike` is driven by *defense*, *vengeance*,
  *glory*, *a bounty contract*, or *predation* — one motor act, five reasons, **five different
  things a witness might conclude about you.**

`decide()` today commits a singular `a.goal = {kind: 'eat'|'flee'|'beg'|…}` each tick. That object
is **not a goal** — it is a **motivation** in this model (the short-term impetus selected this tick),
mislabeled and fused to its primitive in one `kind` string. The plural `a.goals` stack holds the
real goals. This refactor un-fuses them.

---

## 2. Where the epistemic split cuts

The `(primitive, motivation)` seam **is** the epistemic split, sharpened:

| half | layer | who reads it | truth status |
| --- | --- | --- | --- |
| **primitive** | execution | everyone in sight | **ground truth** — the strike landed, the coin moved |
| **motivation** | cognition (actor) / belief (observer) | the actor knows it; observers **guess** it | **private** — never directly observable |

A witness sees the *primitive* (ground truth, via perception) and must **infer** the *motivation*
(belief). Deception is then statable in one line:

> **Deceiving = emitting a primitive whose inferred motivation, in the witness's priors, differs
> from your true one.** A spy's `say` reads as `warn` (loyalty) but is `lie` (deceit). A murderer's
> `strike` reads as `defense` but was `vengeance`.

This subsumes `intrigue.ts`: disguise/false-rumour stop being a bespoke subsystem and become *the
general case of motivation misattribution*, available to every agent and every primitive.

---

## 3. Module map

| file | layer | responsibility |
| --- | --- | --- |
| `js/sim/motivation/registry.ts` | seam | the **`MOTIVATIONS`** registry (`registerMotive`/`motivesFor(primitive)`), mirroring `exec/registry.ts`. The data substrate. |
| `js/sim/motivation/arbitrate.ts` | cognition | `arbitrate(a, ctx)` — scores every *eligible* motivation, applies ambition/group tilt, commits the winner to `a.motive`. **Replaces the candidate scorer inside `decide.ts`.** Belief + own-state only. |
| `js/sim/motivation/infer.ts` | belief | `inferMotive(observer, deed, ctx)` and `onWitnessPrimitive(...)` — the **Theory-of-Mind** read (§7). Observer-belief only. |
| `js/sim/motives/*.ts` | data | **one file per motivation family**, each registering its rows as an import side-effect (`combat.ts` → defend/avenge/glory/predation; `speech.ts` → warn/slander/boast/vouch/accuse; `subsist.ts` → hunger/labour/trade/theft/destitution; `social.ts` → belonging/loyalty/love; …). Disjoint by construction. |
| `js/sim/exec/registry.ts` | seam | **unchanged** — the primitive (executor) registry. A motivation's `primitive` field is a key into this. |
| `js/sim/agent/act.ts` | execution | `execMotive(a, ctx)` — dispatch `a.motive.primitive` through the executor registry with `a.motive.bind`, then **emit the deed envelope** (§6) for witnesses to infer over. |
| `types/motivation.ts` | types | `Motivation`, `Deed`, `MotivePosterior`, and the `Agent` fields `motive`, and the belief field `believedMotive`/`motiveConf`. |
| `test/suites/motivation.mjs` | test | arbitration determinism, inference correctness, the deception/misattribution gates, conservation under the new emit path. |

### Where it runs in the tick

```
perceive → beliefs.decay → gossipBeliefs → reason → deriveGoals → decide → _runMarket → progression.tick
   │                                                                 │
   └── perceive() also drains a.perceivedDeeds, running              └── arbitrate(a, ctx) → a.motive
       onWitnessPrimitive(...) per deed  [motivation/infer.ts]            [motivation/arbitrate.ts]

act(dt)  [every frame] ── execMotive → runExecutor(a.motive.primitive, a.motive.bind) → emit Deed → witnesses' inbox
```

Witness **inference** runs in the `perceive` pass (draining the deed inbox), one home — *not* in
`decide`; `arbitrate` (in `decide`) only reads the beliefs inference already wrote. So a deed witnessed
this tick informs next tick's decision, never races it.

The actor's **selection** is cognition (arbitrate, belief-only). The actor's **act** is execution
(executor + resolver, ground truth). The witness's **inference** is belief (runs in its own
`perceive` pass, over its own priors). Three agents, three layers, one seam.

---

## 4. Data structures

```ts
// types/motivation.ts

/** The public, observable signature a motivation presents when its primitive is witnessed. */
interface Signature {
  tag: string;                       // surface social-trace it APPEARS as ('robbery','counsel','salvage'…)
  // Observer-side likelihood: P(this observed primitive + these context cues | this motive).
  // Reads ONLY the observed deed + the observer's cue-beliefs. 0..1. Bounded, guarded.
  likelihood(obs: Deed, cues: Cues): number;   // Cues = deed.sceneCues ∪ observer cues (§4a)
}

/** One short-term impetus. Selects a primitive (actor half) AND defines how it reads (observer half). */
interface Motivation {
  key: string;                       // 'avenge','defend','slander','warn','labour','theft',…  (unique)
  primitive: string;                 // executor key it drives: 'strike','say','take','transfer',…
  // serves/goalRef are NOT read by arbitration — they are the "what goal does this impetus advance"
  // annotation, read by the inspector/Chronicle (the §1 three-layer link) and by recursive ToM (§7.5,
  // "what goal would explain this motive?"). Optional; absent on pure reflexes (flee/eat).
  serves: 'goal' | 'need' | 'ambition' | 'reflex';

  // ── ACTOR HALF (cognition: beliefs + own-state ONLY) ────────────────────────
  eligible(a: Agent, ctx: CognitionCtx): boolean;     // gate (character × circumstance)
  score(a: Agent, ctx: CognitionCtx): number;         // impetus strength this tick (>0 to compete)
  bind(a: Agent, ctx: CognitionCtx): Bind;            // params for the primitive (target/audience/source…)
  goalRef?(a: Agent): EntityId | string | null;       // the goal/need it serves (for the inspector & ToM)

  // ── OBSERVER HALF (belief: the witness's own priors ONLY) ───────────────────
  // P(this motive | the observer's belief about the actor) — the character/grudge/need read.
  // ON THE ROW, not a switch in infer.ts (invariant #2): the registry stays the single source,
  // and the epistemic scan checks every prior() uniformly. Reads the observer's OWN beliefs only.
  prior(observer: Agent, actorId: EntityId, deed: Deed, ctx: FullCtx): number;
  reads: Signature;                                   // how the deed appears + its likelihood
  consequence(observer: Agent, actorId: EntityId, conf: number, ctx: FullCtx): void;  // per-witness fold
  basePrior?: number;                                 // stranger fallback when no confident belief exists
}

/** The OBSERVABLE envelope a primitive emits — ground truth, but only what perception can carry. */
interface Deed {
  actorId: EntityId;
  primitive: string;                 // 'strike' | 'say' | 'take' | …  (the PUBLIC act)
  targetId?: EntityId;               // struck / paid / slandered-about (if any)
  surfaceTag?: string;               // the signature.tag the actor PRESENTED (may be a lie — see §7.4)
  sceneCues: SceneCues;              // co-incident, co-perceived scene facts, FROZEN at emit (§4a)
  magnitude: number;                 // 0..1 how WEIGHTY the act is (a killing ≫ a haggle) — the puzzle/salience gate (§7.2a)
  t: number;
}

/** The posterior an observer forms over the candidate motives for a witnessed primitive. */
interface MotivePosterior {
  best: string;                      // argmax motive key
  conf: number;                      // posterior mass on `best` (LOW when the act is ambiguous)
  dist: Record<string, number>;      // normalized; surfaced to recursive-ToM (§7.5) & the inspector
}
```

The cues a `likelihood` reads are **not** one bag — they split by who can perceive them, which is the
whole subject of §4a. `SceneCues` ride the deed (objective, co-perceived); the contestable cues are
observer-relative and assembled per-witness at inference. Neither is ever the actor's mind.

---

## 4a. The cue catalogue — the observability vocabulary

`likelihood` is only as honest as the cues it reads. The catalogue is the **shared, named vocabulary
of observable context** every motive's `likelihood` (and, on the character side, every `prior`) draws
from — the analogue of the signal catalogue ([13](13-narrative-signals.md)) for the perception layer.
Authoring a motive's `likelihood` means *composing existing cues*, not inventing fields, so motives
stay comparable and the epistemic scan has a fixed surface to check.

### The organizing principle (the split, applied to cues)

> **If two honest witnesses to the same deed could legitimately disagree about a cue, it is an
> *observer* cue, not a *scene* cue.**

That one test partitions the vocabulary and forbids telepathy by construction:

| scope | what it is | when/where read | decays? |
| --- | --- | --- | --- |
| **scene** (`SceneCues`) | a fact **co-incident** with the deed instant that anyone in perception range necessarily co-perceives — *location kind, target type, who was armed/outnumbered right now, coin-vs-good, audience present* | assembled **once** by the actor's `execMotive` emit (ground truth), **frozen** onto `deed.sceneCues` | no — it's a snapshot; the *deed* ages out, not the cue |
| **observer** (`ObserverCues`) | anything needing the witness to have perceived a **prior event** or to hold a **belief/relationship** — *did I see the provocation, do I believe the actor poor / a rival of the subject / wronged by the target, my standing toward them* | assembled **per-witness** at inference, from the **observer's own** beliefs/memory | yes — they fade with the underlying belief/memory, so legibility erodes with time & distance |

A prior event has **no** scene cue — only a per-witness observer cue — because whether you know it
happened depends on whether *you* were there. This is precisely what makes witness S (saw the
provocation) and witness T (didn't) diverge in §8.2: `iSawProvocation` is an **observer** cue, so the
two never shared it. Had it been a scene cue on the deed, both would read "defense" — telepathically.

### Observer cues are QUERIES, not stored fields (the load-bearing decision)

The naïve reading of this catalogue — "each observer cue is a belief field perception keeps current"
— is **wrong**, and avoiding it is the difference between a buildable design and a denormalized cache
nobody can keep in sync. An observer cue is a **query, evaluated at inference time, over state the
agent already maintains** (its episodic memory + its existing belief cells). There is no `iBelieveRivalry`
*field*; there is a function that scans memory for remembered hostility between two parties. This:

- **adds almost no storage.** No per-cue fields, and critically no `(observer × actor × subject)` N³
  table — the relational cues (`iBelieveRivalry`, `iBelieveActorWronged`) are *derived* from the
  observer's own bounded memory, not stored.
- **reads one source of truth.** The cue and the rest of cognition see the same memory/beliefs; nothing
  can drift out of sync because nothing is duplicated.
- **is cheap.** Memory is tiny (STM 8 / MTM 16 / LTM 10 ≈ 34 episodes); a per-cue scan is O(34), run
  only for the witnesses who actually infer a deed.

```ts
// types/motivation.ts
type CueScope = 'scene' | 'observer';
interface CueSpec {
  key: string;                       // 'atMarket','iSawProvocation','iBelieveRivalry',…
  scope: CueScope;
  kind: 'bool' | 'scalar';           // scalar ∈ [0,1]
  // scene → read ground truth at emit (frozen on the deed).
  // observer → QUERY the witness's OWN memory/belief at inference (no stored cue field).
  read: (who: Agent, deed: Deed, ctx: FullCtx) => number;   // bool → 0|1
}
type SceneCues = Record<string, number>;            // frozen on the deed
type Cues      = Record<string, number>;            // deed.sceneCues ∪ the observer-cue query results

function registerCue(spec: CueSpec): void;
function assembleScene(actor, mv, ctx): SceneCues;  // emit-side: every scope:'scene' cue, off ground truth
function assembleCues(observer, deed, ctx): Cues;   // infer-side: deed.sceneCues ∪ each observer cue's QUERY

// e.g. the provocation cue is a memory scan, NOT a field read:
iSawProvocation.read = (o, deed) => o.memory.recall(
  e => e.kind === 'witnessed_aggression' && e.byId === deed.targetId && e.withId === deed.actorId,
  MOTIVE.provocationWindow) ? 1 : 0;                // "did I see the target aggress this actor, recently?"
iBelieveRivalry.read = (o, deed) => rivalryFromMemory(o, deed.actorId, deed.targetId);  // scan, ∈[0,1]
```

**A cue lives on exactly one side of the prior/likelihood divide** (no double-counting): `prior` reads
the *character/relationship* queries (who I think you are); `likelihood` reads the *scene* cues + the
*this-act event* query (`iSawProvocation`). Same catalogue, disjoint roles.

### What this needs that doesn't exist yet — one episode kind, one belief field

The review's "the inference has nothing to read" finding is real but small once cues are queries. The
honest prerequisite list is exactly two additions, both in-grain:

1. **A `witnessed_aggression` episode kind** — today bystanders to a *non-lethal* strike write only a
   suspicion/animacy belief, not a recallable event (`combatEvents.ts:366-389`), so there's nothing to
   query for `iSawProvocation`. The fix is **one sibling line in the loop that already files
   `witnessed_death`** (`combatEvents.ts:379`, which already records `{withId: victim, byId: aggressor,
   salience}`): file the same shape for a non-lethal strike. That single producer feeds `iSawProvocation`
   **and** the relational scans (`iBelieveRivalry`/`iBelieveActorWronged` read accumulated aggression
   episodes). Mirrors an existing shape; bounded by the existing rings; one change, not twelve.
2. **One new belief field, `believedKindness`** — a *slow character estimate* (not a remembered event),
   so it genuinely is a field. But it is N² on the **existing** belief cell, exactly like the
   already-present `believedWealth`/`wealthConf` (`beliefs.ts:70-71`), and written the same way (a cue
   fold on witnessed deeds). In-budget, in-grain.

Everything else on the observer side is a **query over what already exists**: `iBelieveActorPoor` reads
the existing `believedWealth`; `myStandingToActor` reads the existing `standing`; `iBelieveTargetHostileToAll`
reads the existing `hostile`/faction belief; the rivalry/wronged/friendship relational cues are memory
scans over `witnessed_aggression`/`witnessed_death`/`succoured` episodes the agent already keeps (plus
the one new kind). **No producer layer, no N³ table, no cue cache.**

### The starter vocabulary (seeded by `strike` / `take` / `say`)

`source` is the point of the table: almost every observer cue is a query over **state that exists today**.

| cue | scope | discriminates | source — exists today? |
| --- | --- | --- | --- |
| `atMarket` / `atWorkplace` | scene | trade/labour **vs** theft on a `take` | the deed's POI (ground truth at emit) |
| `coinPaid` | scene | buy **vs** rob/burgle | a counter-transfer at the take |
| `tookFromCorpse` / `tookFromContainer` / `tookFromOwner` | scene | salvage / burgle / robbery | the take's source kind |
| `targetArmedNow` / `actorOutnumberedNow` | scene | defense/predation **vs** murder | the combat scene at the instant |
| `audiencePresent` / `subjectAbsent` | scene | broadcast slander **vs** counsel / to-face | the `say` scene |
| `goodGiven` / `coinGiven` | scene | gift/charity **vs** payment | which ledger moved |
| `iSawProvocation` | observer | **defense vs avenge** on a `strike` | **query** memory → needs the new `witnessed_aggression` episode |
| `iBelieveRivalry` / `iBelieveActorWronged` | observer | slander / avenge prior | **query** memory (aggression/death episodes) — uses the new episode; no new field |
| `iBelieveFriendship` | observer | vouch/warn prior | **query** memory (`succoured`/bond episodes) — exists |
| `iBelieveActorPoor` | observer | theft/desperation prior | **query** `believedWealth` — **exists** (`beliefs.ts:70`) |
| `myStandingToActor` | observer | counsel **vs** spite | **query** `standing` — **exists** |
| `iBelieveTargetHostileToAll` | observer | predation/legitimate-kill | **query** `hostile`/faction belief — **exists** |
| `iBelieveActorUncaring` | observer | theft/spite prior | reads `believedKindness` — **the one new field** |

Every scene-cue `read` is execution-layer (ground truth at emit); every observer-cue `read` is a
memory/belief **query** the epistemic scan checks. The list is open — a new primitive seeds its
discriminating cues in its own `motives/*.ts` file, exactly like a new motive seeds its prior.

---

## 5. Arbitration — selecting the motive (replaces the candidate scorer)

`arbitrate` is the un-fused `decide()` candidate loop. Each motivation contributes **one** candidate
(its `score`), tagged with the primitive it drives and the goal/need it serves. The winner is
committed to `a.motive` — a single object that already knows what physical act to run.

```ts
// js/sim/motivation/arbitrate.ts   (cognition — beliefs + own-state ONLY)
function arbitrate(a, ctx) {
  if (!a.alive || a.controlled || a._held) { a.motive = null; return; }

  const cands = [];
  for (const m of MOTIVATIONS) {                       // bounded: the full motive set, a small constant
    try {
      if (!m.eligible(a, ctx)) continue;               // character × circumstance gate
      const s = m.score(a, ctx);                       // impetus strength (belief-only)
      if (s > 0) cands.push({ m, score: s });
    } catch { /* never throw on the tick */ }
  }

  // longer-term tilt: ambition favours matching motive FAMILIES (renown→glory, wealth→labour/trade…),
  // group cohesion tilts loyalty/belonging. Same multipliers as today, now keyed by motive, not 'kind'.
  for (const c of cands) c.score *= tilt(a, c.m, ctx);

  // hysteresis: the incumbent motive keeps a stickiness bonus (kills the flee↔work limit-cycle today).
  const prev = a.motive ? a.motive.key : null;
  let best = null, bestEff = -Infinity;
  for (const c of cands) {
    const eff = c.m.key === prev ? c.score * STICK : c.score;
    if (eff > bestEff) { bestEff = eff; best = c; }
  }

  a.motive = best ? bindMotive(a, best.m, ctx) : FALLBACK(a);   // {key, primitive, bind, serves, goalRef}
  trace(a, 'MOTIVE_WON', a.motive.key, bestEff);
}
```

Two notes that preserve current behaviour:

- The **goal stack** is untouched. A live plan step contributes a motive exactly like any other
  candidate — there is a `plan` motivation whose `score` returns `WEIGHT.plan` and whose `bind`
  returns the current plan step's `(primitive, bind)`. So "the goal stack competes as one candidate"
  stays true; it is just no longer special-cased — it is a row.
- Two parts of today's `decide()` **are deliberately NOT rows** (the review's byte-stability finding —
  pretending they were rows would break behaviour):
  - **The ~9 role early-returns** (reporter/spy/bounty/avenger/duel/arbitrage/expedition/caravan/party,
    `decide.ts:94-232`) are not "dominating-score rows." They `return` *before the candidate array is
    built*, and crucially before the side-effects below them run (`updateAmbition`, `deriveGoals`,
    `pruneGoals`, `chooseOccupation`) — a spy never runs the economic scheduler. Re-expressing them as
    rows would change *which side-effects fire and in what order*. They stay as a **pre-arbitration
    guard phase**: `roleMotive(a, ctx)` runs first and, if a role is active, returns `a.motive` directly
    and skips arbitration — the same short-circuit, now one named function instead of nine inline returns.
  - **The group-cohesion pass** (`decide.ts:541-549`) *mutates other candidates' fields* (rewrites the
    `socialize` candidate's `toPos`/`withId`, multiplies `work`). That is a cross-candidate post-process,
    not a per-row `score()`. It stays as a **post-scoring pass** over `cands` before the argmax.
  So the real shape is **pre-phase (roles) → score rows → post-phase (cohesion) → hysteresis argmax**,
  not "everything is a uniform row." The doc claims only the *candidate scorer* collapses to rows; the
  guards around it are named phases, documented as such.

---

## 6. Execution — primitive dispatch + the deed emit

```ts
// js/sim/agent/act.ts   (execution — ground truth)
function execMotive(a, ctx, dt) {
  const mv = a.motive;
  if (!mv) return;
  const arrived = runExecutor(mv.primitive, a, { prim: mv.primitive, bind: mv.bind }, dt, ctx);
  if (!arrived) return;                                  // still travelling (steer field), no deed yet

  // THE DEED: the PUBLIC envelope. Note what we DON'T put in it — the true motive key.
  // Witnesses receive the primitive + cues + the surface tag the actor chose to present; they
  // INFER the motive themselves (§7) — replacing witnessDeed's hardcoded per-`kind` fold.
  const deed = {
    actorId: a.id, primitive: mv.primitive, targetId: mv.bind.target ?? mv.bind.to ?? null,
    surfaceTag: presentTag(a, mv, ctx),                 // honest default = mv.reads.tag; a deceiver overrides
    sceneCues: assembleScene(a, mv, ctx),               // every scope:'scene' cue, off ground truth, FROZEN (§4a)
    t: ctx.time,
  };
  ctx.resolver.publishDeed(deed);                        // drops into the inbox of every agent in perception range
  emitActionEvent(a, mv, ctx);                           // the existing RPG bus event (progression/quests) — unchanged
}
```

`publishDeed` is the conserved-world side: it enqueues the deed into `perceivedDeeds` on every agent
whose perception covers the deed site (vision-gated, ground truth — the execution layer is allowed
to scan the roster; the **inference** that follows is not). The actor's true `mv.key` is **never**
written into any other agent's state. The only social-meaning channel is inference.

---

## 7. Theory of Mind — inferring the motivation (the centerpiece)

A witness perceives a `Deed` (a public primitive + cues) and must answer *"why did they do that?"*
It does so with a bounded prior×likelihood read over **its own beliefs** about the actor. The result
is a posterior over motives; the argmax (with its confidence) is written into the witness's belief
about the actor, and the attributed motive's `consequence` folds in — so the **same strike yields
sympathy from the witness who saw the provocation and a grudge from the one who didn't.**

### 7.1 The observable & the candidate set

```ts
// js/sim/motivation/infer.ts   (belief — the OBSERVER's own priors ONLY)
function inferMotive(observer, deed, ctx) {
  // only motives that drive THIS primitive are candidates — strike→{defend,avenge,glory,bounty,predation}
  const cands = motivesFor(deed.primitive);            // bounded: small constant per primitive
  const cues = assembleCues(observer, deed, ctx);      // deed.sceneCues ∪ MY observer cues (§4a) — few belief reads
  const post = {};
  let Z = 0;
  for (const m of cands) {
    const prior = clamp01(m.prior(observer, deed.actorId, deed, ctx));  // ON THE ROW (§7.2) — character/relationship cues
    const like  = clamp01(m.reads.likelihood(deed, cues));              // scene + this-act event cues fit this motive
    const p = prior * like;
    post[m.key] = p; Z += p;
  }
  if (Z <= 0) return { best: 'unknown', conf: 0, dist: {} };     // truly illegible act
  for (const k in post) post[k] /= Z;                            // normalize → posterior
  let best = null, bestP = -1;
  for (const k in post) if (post[k] > bestP) { bestP = post[k]; best = k; }
  return { best, conf: bestP, dist: post };
}
```

### 7.2 The prior — what the witness already believes about the actor

The prior is the witness's **character/grudge/need model** of the actor — the motive it expects
*before* seeing how the act fit. This is where Theory-of-Mind actually lives: I attribute the motive
that fits *who I think you are and what I think you wanted*. **It is the single most load-bearing,
most fragile surface in the design** — the analogue of "confidence enters cost" in
[10](10-action-grammar-lld.md) — and it is named as such here so it is never tuned casually.

**It lives on the motivation row, not in a `switch` (invariant #2).** Each motive supplies its own
`prior(observer, actorId, deed, ctx)`; `infer.ts` never names a motive. The registry stays the single
source, features stay disjoint (a new motive ships its prior in its own file), and the epistemic scan
checks every `prior()` for roster reads uniformly. Three example rows (each reads only the observer's
own `BeliefStore` cell — `b = observer.beliefs.get(actorId)`):

```ts
// motives/combat.ts
avenge.prior  = (o, id, d) => { const b = o.beliefs.get(id);
  return b && b.confidence >= SIM.actOnBeliefMin
    ? P.strangerBase + P.grudgeGain * grudgeBelief(o, id, d.targetId)   // I expect vengeance from one I believe was wronged
    : avenge.basePrior; };
defend.prior  = (o, id, d) => { const b = o.beliefs.get(id);
  return b ? 0.3 + 0.7 * hostileBetweenBelief(o, id, d.targetId) : defend.basePrior; };
// motives/speech.ts
slander.prior = (o, id, d) => P.strangerBase + P.rivalryGain * rivalryBelief(o, id, d.targetId);
```

`grudgeBelief`/`hostileBetweenBelief`/`rivalryBelief` are **queries over the observer's own episodic
memory** (§4a) — *not* stored fields — scanning the aggression/death episodes the agent already keeps;
the `P.*` weights are the `MOTIVE.prior` config block (§12). No roster scan, no read of the actor's
mind, no denormalized cue cache — **the split holds**, and two witnesses with different memories reach
different posteriors from the identical deed.

**Calibration (the part P4 cannot wave away).** Because the posterior is `prior × likelihood`
normalized over candidates, shifting one weight re-weights *every* interpretation of that primitive at
once — you cannot tune a motive in isolation. The doc commits to a **two-stage** procedure that makes
the surface tractable instead of a coupled optimisation:

1. **Likelihoods first, priors flat.** Set every `prior` to its `basePrior` (uniform) and tune only
   the `reads.likelihood` curves until an *honest, cue-rich* act (open defense with a visible
   provocation; labour at a field) reads correctly with posterior ≥ `MOTIVE.legibleAt` across random
   witnesses. This is one curve per motive, independently checkable — the `motivation.mjs`
   `legibility` gate (§11) asserts it.
2. **Priors second, as tie-breakers on ambiguous acts only.** Layer the `P.*` weights in. They must
   *not* be able to flip a cue-legible act; they only resolve the genuinely ambiguous (cue-poor) acts —
   which §7.3 shows are the common case. The `prior-bounded` gate asserts **argmax preservation**: with
   any prior maxed out, the true motive of a stage-1-legible act **remains the argmax** — not merely
   "stays above `legibleAt`." (The subtle failure the weaker bar misses: a strong prior boosts the
   *runner-up* past the true motive while the true motive is still above the absolute threshold — the
   argmax flips without the leader dropping. The gate tests the ordering, not the level.)

**Honest caveat on separability.** Stages 1 and 2 are *mostly* separable — stage 1 owns "is an honest
act readable," stage 2 owns "who gets the benefit of the doubt" — but they are **not provably
independent**: because the posterior normalizes over all candidates, a prior that lifts motive M raises
M's posterior on every deed M competes for, legible ones included. The staging is a *de-risking
discipline* (tune the cheap, checkable thing first), **not** a proof that the surface decomposes. Budget
for a final joint-tuning pass over the legibility corpus; if the `prior-bounded` gate fails after
stage 2, priors and likelihoods need co-tuning and that is expected, not a surprise.

### 7.2a The low-confidence path — the system's *resting* behaviour, not an edge

In a town where most witnesses are strangers to most actors, the modal `inferMotive` output is
**low-confidence** (a cue-poor act, a flat prior → a near-uniform posterior, `conf` small) — *not*
`Z<=0` (truly illegible, rare). So the low-conf path **is** the resting behaviour and gets first-class
treatment, decided here rather than left open:

- **A write threshold gates attribution.** `onWitnessPrimitive` writes `believedMotive` only when
  `conf ≥ MOTIVE.attributeAt` (a salience bar above `ambiguityFloor`). Below it, the witness writes
  **nothing to the motive belief** — it saw *an act*, not *a reason* — leaving any prior
  `believedMotive` **intact and decaying** (you don't overwrite your settled read of someone over one
  ambiguous glimpse). This is the "saw something, can't say why" resting state, and it is the common
  one.
- **But a *salient* unresolved deed leaves a puzzle — in its OWN dedicated store, not the memory rings.**
  If the read is sub-`attributeAt` yet the *deed* was notable (`deed.magnitude ≥ MOTIVE.puzzleAt` — a
  killing, a large theft), the witness files a lightweight **`unresolved` observation** (the frozen
  `deed` + the inconclusive posterior) — *not* a motive belief. **This is a genuinely new structure**,
  and it must NOT ride the existing episodic rings: STM/MTM/LTM have no per-kind subcap, and salient
  ambiguous deeds are the *common* case (this very section's thesis), so puzzles flooding the shared
  rings would **evict** the `assaulted`/`witnessed_death`/`succoured`/`relic` episodes the avenge/repay/
  grieve derivers depend on (`motivation.ts:312-365`). So `unresolved` is a **separate, bounded ring**
  (`a._puzzles`, cap `DELIBERATE.puzzleRing` ≈ 6, its own decay), holding only what `deliberate` (§7.6)
  consumes. Ordinary low-stakes ambiguity still files nothing. The unease nudge below still fires.
- **The N² belief-field question (separate, also decided).** Distinct from the puzzle store above:
  `believedMotive`/`motiveConf` are persisted *belief* fields, and they are **sparse** because
  sub-threshold reads write nothing — they exist only on cells where a *salient* attribution landed.
  They ride the **existing** belief cell, store only the **last** salient attribution (overwritten, not
  history), and most cells never carry one. (So: one bounded new puzzle store + two sparse fields on the
  existing cell — both fixed in `types/motivation.ts` now; neither is a dense N² or N³ table.)
- **Consequence still scales below the write bar but above `ambiguityFloor`** only as a *transient*
  mood nudge (a flicker of unease at a half-read act), never a persisted belief change — so an
  ambiguous act can unsettle a witness in the moment without permanently libelling the actor.

### 7.3 Writing the inferred motive + its consequence

```ts
function onWitnessPrimitive(observer, deed, ctx) {
  if (deed.actorId === observer.id) return;            // I know my own motive; no inference on the self
  const { best, conf } = inferMotive(observer, deed, ctx);
  const m = best !== 'unknown' ? MOTIVES[best] : null;
  if (m && conf >= MOTIVE.attributeAt) {               // SALIENT read → persist the attribution (§7.2a)
    const b = observer.beliefs.ensure(deed.actorId);
    b.believedMotive = best;                           // what I think you were doing
    b.motiveConf = conf;                               // how sure I am
    m.consequence(observer, deed.actorId, conf, ctx);  // CONF-SCALED, persisted (standing/suspicion/hostile)
  } else if (m && conf >= MOTIVE.ambiguityFloor) {
    m.unease?.(observer, deed.actorId, conf, ctx);     // sub-threshold: a transient MOOD nudge, no belief write (§7.2a)
  }                                                    // truly illegible / below the floor → nothing changes
}
```

`consequence` is the generalized `witnessDeed`: a `theft` attribution drops `standing` and raises
`suspicion`; `defend` raises `standing` (a protector); `avenge` may latch `hostile` if I liked the
victim, or *raise* standing if I hated them. It is **scaled by `conf`** — a half-legible read earns a
half-consequence — and only fires above the write bar, so an agent that keeps its motive ambiguous
keeps its blame ambiguous (and unpersisted).

**Gossip carries the inferred motive (decided, not deferred).** A gossiped account propagates the
**teller's `believedMotive`** — not the bare primitive — with a confidence penalty per hop (the usual
fade) *and* a one-step *re-inference option* at the hearer: a hearer who holds a strong contradicting
prior may discount the teller's attribution rather than adopt it. So **misattributions spread and
compound into the town's accepted account** — a slander that read as a warning becomes received truth
— while a sharp hearer can still resist it. This is the reputation-cascade the design wants; the bare-
primitive alternative (every hearer re-infers from scratch) is explicitly rejected as both costlier
and less dramatic. (See the resolved open question below.)

### 7.4 Deception — making the primitive misread

Deception needs **no new mechanism**. It is the actor steering the witness's posterior away from its
true motive, by the only three handles it has — all already in the engine:

1. **Pick a primitive with an innocuous default reading.** Advance a `ruin-my-rival` goal with `say`
   presented as `vouch`/`warn` rather than open `slander` — same belief-write, gentler surface tag.
   `presentTag(a, mv, ctx)` returns a *chosen* `surfaceTag` (the lie about why), not `mv.reads.tag`.
2. **Manipulate the witness's prior.** A **disguise** corrupts `b.lastFaction`/`believedKindness`,
   so each motive's `prior()` reads off a poisoned belief and expects the wrong motive — `intrigue.ts`'s
   disguise becomes a prior-poisoning input, nothing more.
3. **Choose the scene & the audience.** Scene cues are assembled from ground truth at emit — a
   deceiver **cannot fake one** (a market `take` genuinely has `atMarket`). What it controls is *where
   and before whom* it acts: pick a context whose **true** scene cues support the cover (snatch a purse
   at a crowded stall so `atMarket` muddies `theft` toward `trade`), and pick an audience that lacks
   the damning **observer** cue (strike where the witnesses you care about never formed `iSawProvocation`).
   You can't forge a cue; you can only stand where the honest cues mislead. (Framing is the costly,
   emergent inverse — *provoke* the target into a real first blow so a true `iSawProvocation` forms.)

```ts
function presentTag(actor, mv, ctx) {
  if (!actor._deceives) return mv.reads.tag;           // honest agents present their true surface
  const cover = mv.coverTag;                            // the motive's plausible innocuous alias, if any
  return cover ?? mv.reads.tag;                         // a deceiver presents the cover; witnesses still INFER
}
```

The deceiver does not get to *set* the witness's belief — it only gets to **bias the inference**. A
sharp witness (one holding a contradicting high-confidence belief, e.g. it *saw* there was no
provocation) infers the true motive anyway and the lie *backfires* (caught-in-a-lie → a standing hit
+ the caution surcharge, [11](11-outcome-conditioned-caution-lld.md)). That asymmetry — you bias, you
don't dictate — is what keeps deception risky and emergent rather than a free win.

### 7.5 Recursive ToM — the actor models the witness (one level)

A guileful actor, choosing among `(primitive, motivation)` pairings that all advance its goal,
includes a term for **how the act will be read**. It runs the *same* `inferMotive` against a model of
a typical witness and prefers the pairing whose predicted posterior misattributes its damaging
motive. One level only (`I think that you will think`) — matching the recruiter's existing one-level
`Believes` prediction; deeper recursion is explicitly out of scope (bounded by design).

```ts
// js/sim/motivation/arbitrate.ts — the guile branch of bindMotive, gated on a trait/spy state
function chooseDeceptivePresentation(actor, goal, ctx) {
  let best = null, bestUtil = -Infinity;
  for (const { prim, mot } of pairingsThatAdvance(goal, actor, ctx)) {   // bounded enumeration
    let util = mot.score(actor, ctx);                                    // the honest impetus utility
    if (actor._deceives) {
      const witness = modelTypicalWitness(actor, ctx);                   // a SYNTHETIC observer from MY beliefs:
                                                                         //   priors = how I think others see me + the target
      const predicted = inferMotive(witness, simulateDeed(actor, prim, mot, ctx), ctx);
      const exposed = predicted.dist[mot.trueDamagingKey] ?? 0;          // P(they read my real, costly motive)
      util += DECEIVE.bonus * (1 - exposed) - DECEIVE.riskCost * exposed; // reward a clean misread, price exposure
    }
    if (util > bestUtil) { bestUtil = util; best = { prim, mot }; }
  }
  return best;
}
```

`modelTypicalWitness` is built **from the actor's own beliefs** — "how do I believe others regard me
and my target?" — so even the recursion never leaves the actor's epistemic scope. The spy's whole
behaviour (plant a `lie` that will be read as a `warn`) falls out of this branch as the *general*
case; `intrigue.ts` shrinks to: set `_deceives`, supply the disguise that poisons the prior.

> **Note.** Passive inference (§7.1) is *reflexive* — it runs once per witnessed deed, cheaply, and
> usually lands at low confidence (§7.2a). The actor's recursive model above predicts that reflexive
> read. Neither is the *deliberate* reasoning of §7.6, which an agent must choose to spend.

**Cost (bounded, with the number — this is a planner-inside-a-planner and is treated as one).** The
guile branch is the only nested loop the refactor adds, so it carries [10](10-action-grammar-lld.md)'s
per-plan rigour:

- **It runs against ONE synthetic witness, not per real witness** — `O(K)` not `O(K·W)`. `inferMotive`
  there is the same bounded `motivesFor(primitive)` loop (≤ ~6 candidates).
- **`K` (pairings enumerated) is capped at `DECEIVE.maxPairings` (default 4)** — the few
  `(primitive, motive)` cover-options for the goal at hand, not a free search. Total guile work per
  decision ≈ `4 × 6` likelihood evals ≈ **24 cheap reads**, comparable to one ordinary `arbitrate`.
- **It fires rarely.** Gated on `a._deceives` (spies + the few guileful, a single-digit % of the
  roster) **and** only on a tick where a deceptive pairing is actually a candidate — not every tick,
  not for honest agents. At the correlated-burst peak (a Director intrigue beat) `_deceives` is still
  bounded by the spy count, which the intrigue layer already caps.
- The `motivation.mjs` `guile-cost` gate asserts the branch is **skipped entirely** for
  `!a._deceives` (zero added cost on the honest mainline) and flat per-firing as `K` holds.

### 7.6 Deliberation — inference as a chosen action

Everything in §7.1–7.5 is *reflexive* cognition: a witness reads a deed once, cheaply, as it happens,
and usually shrugs (low conf). **`deliberate` is the deliberate counterpart** — a first-class action an
agent *chooses to spend* to reason through a `deed` it already observed but never resolved. It is the
introspective twin of the whole design: where every other primitive acts on the world, `deliberate`
acts on the agent's **own mind**, and its "world-interaction" mutates only own beliefs/memory (no
resolver, no conservation concern). It is what turns Theory-of-Mind from a reflex into something an
agent can be seen to *do*.

**Why it's a real action, not a passive recompute.** Re-running `inferMotive` with the *same* evidence
would change nothing. Deliberation pays its cost by bringing **more evidence** to bear than the
in-the-moment reflex could:

1. **Evidence accrued since.** Memories, gossip, and beliefs the witness gained *after* the deed —
   the rivalry you only later learned of, the provocation a neighbour described, three more thefts by
   the same hand. The frozen `deed.sceneCues` are re-scored against a now-richer observer-cue set.
2. **A consistency check against character.** Does the leading motive cohere with what I now believe
   about this person? A `warn` (counsel) from someone I've since come to believe is the subject's
   bitter rival is *incoherent* — deliberation re-weights toward `slander`. **This is the mechanism by
   which a witness becomes "sharp" and catches a lie** (the §7.4 backfire): the contradiction the
   reflex glossed, deliberation actively hunts.
3. **One level of "why".** It may ask what *goal* would explain the leading motive (the §7.5 inference
   pointed inward), promoting a motive that fits a coherent intention over one that doesn't.

```ts
// motives/deliberate.ts  — the primitive's executor is INTERNAL (own beliefs/memory only)
registerExecutor('deliberate', (a, step, _dt, ctx) => {
  const obs = step.bind.unresolved;                    // an entry from a._puzzles, picked by the motive's bind (§7.2a)
  if (!obs) return;
  const before = obs.posterior;
  const after = inferMotive(a, obs.deed, ctx);         // SAME read, but a.beliefs/memory are richer now
  const coherent = characterCoherence(a, obs.deed.actorId, after.best, ctx);  // does the lead motive fit who I now think they are?
  const resolved = reweightByCoherence(after, coherent);                       // incoherent lead → demote it (catch the lie)
  if (resolved.conf >= MOTIVE.attributeAt) {           // deliberation crossed the write bar the reflex couldn't
    const b = a.beliefs.ensure(obs.deed.actorId);
    b.believedMotive = resolved.best; b.motiveConf = resolved.conf;
    MOTIVES[resolved.best]?.consequence(a, obs.deed.actorId, resolved.conf, ctx);  // NOW it bites (grudge / trust / suspicion)
    a._puzzles.resolve(obs);                            // settled — drop from the dedicated puzzle ring (§7.2a)
  } else {
    obs.deliberated = (obs.deliberated || 0) + 1;      // still murky; bounded re-tries (DELIBERATE.maxPasses) then let it fade
  }
  emitActionEvent(a, step, ctx);                        // a 'reasoned' deed on the bus (progression: an insight beat)
});
```

**The motivation that drives it** is a `puzzle`/`suspect` row (in `motives/deliberate.ts`), `eligible`
when the agent holds an `unresolved` observation (§7.2a) *or* a stored attribution that now **conflicts**
with its belief about the actor's character; `score`d by `MOTIVE.puzzleWeight × magnitude × (curiosity
or suspicion)` — so the **curious and the paranoid deliberate; the incurious let it lie.** It competes
in `arbitrate` like any motive (it loses to hunger and danger — you don't stop to brood mid-flight),
and committing it sends the body nowhere (an internal act; `steer` is a no-op, it resolves in place).

**This is the deception risk-dial, made of character.** A planted lie survives the *reflex* but may not
survive *deliberation* — so a deceiver's exposure scales with how much its victims brood, which scales
with their curiosity/suspicion. A spy gets away with it in an incurious town and is unmasked in a
watchful one, with no special-case code: just whether anyone chose to spend the `deliberate` action on
the deed that didn't add up. Attention is a scarce resource (bounded by `DELIBERATE.attentionPerTick`),
so an agent brooding on one puzzle can't chew every ambiguous glimpse — it spends its scrutiny on what
nags most (highest `magnitude × suspicion`), which is exactly where drama wants it spent.

---

## 8. Worked examples

### 8.1 `say`: warn vs slander (same primitive, opposite reads)

```
GOAL (actor B):  diminish rival R in the town's eyes.
PAIRING:         primitive 'say', motive 'slander'  (coverTag: 'counsel')
EMIT:            Deed{ actor:B, primitive:'say', target:R, surfaceTag:'counsel',
                      cues:{ aboutR:true, BknownRivalOfR:?, atMarket:true } }

WITNESS W1 (does NOT believe B and R are rivals):
   prior(warn)=0.6  prior(slander)=0.25         (B reads as a neutral informant)
   likelihood(warn|cues)=0.7  likelihood(slander|cues)=0.5
   → posterior: warn 0.66, slander 0.34  → believedMotive='warn', conf .66
   → consequence: R's standing in W1 drops a little (W1 half-believes the bad news)  ← the slander LANDS

WITNESS W2 (DOES believe B and R are bitter rivals — rivalryBelief high):
   prior(slander)=0.7  prior(warn)=0.3
   → posterior: slander 0.68  → believedMotive='slander', conf .68
   → consequence: B's OWN standing drops in W2 (caught running a smear); R untouched   ← the slander BACKFIRES
```

One deed, two towns-worth of truth — and B's success depends on how many witnesses already know it's
a feud. No special-casing; it falls straight out of the prior.

### 8.2 `strike`: defend vs avenge (the provocation cue)

```
GOAL (actor A):  kill X (an old grudge — A holds an `assaulted` memory of X).
PAIRING:         primitive 'strike', motive 'avenge'

WITNESS S (SAW X swing first this morning — holds a fresh cue 'X hostile to A'):
   likelihood(defend|cues:sawProvocation)=0.8   prior(defend)=0.6
   → believedMotive='defend'  → A's standing UP (a man defending himself)

WITNESS T (did NOT see the provocation; remembers A nursing a grudge):
   prior(avenge)=0.2+0.8*grudgeBelief=high      likelihood(avenge)=0.7
   → believedMotive='avenge'  → if T liked X: A latched hostile; if T feared X: A's standing UP
```

If A is *guileful* (§7.5), it strikes **in front of S, out of sight of T** — choosing the witness
set that misreads the kill as defense. That is premeditation-with-an-alibi, emergent from one branch.

### 8.3 `deliberate`: the lie that doesn't survive a second look

```
SETUP:  spy B planted a 'lie' over `say`, presented as 'warn' (coverTag). Witness W read it
        reflexively (§7.1) as 'warn', conf .58 — below attributeAt, but the topic was grave
        (magnitude high) → W filed an `unresolved` puzzle (§7.2a). No belief written yet.

LATER:  W gossips, and learns B and the slandered party are old rivals → iBelieveRivalry(B,·) rises.
        W is curious (high curiosity) → the `puzzle` motive out-scores idle wander → W commits
        'deliberate' on the filed observation.

DELIBERATE (§7.6):  re-infer the SAME frozen deed against W's now-richer cues:
   reflex had: warn .58 / slander .42      (no rivalry cue then)
   now:        prior(slander) lifted by the new rivalry belief; characterCoherence('warn') LOW
               (a rival's 'counsel' is incoherent) → reweight demotes warn
   → resolved: slander .71  ≥ attributeAt
   → believedMotive='slander' WRITTEN; consequence bites: B's standing drops in W (caught);
     the puzzle is resolved (stops nagging).  ← the lie BACKFIRES, but only because W bothered to think
```

An incurious W never spends the action, never connects the rivalry, and B's cover holds. Same town,
same deed, same evidence — the difference is a *character* who chose to reason. That is the
deception risk-dial of §7.6, shown end-to-end.

---

## 9. What changes vs today

| today | under this design |
| --- | --- |
| `a.goal` (singular) is the committed momentary "goal" | renamed to `a.motive`; it *is* the motivation; `a.goals` (stack) keeps the real goals |
| `decide()` candidate scorer fuses impetus+primitive in a `kind` string | `arbitrate()` scores motivation **rows**; each names its `primitive` + `bind` |
| role overrides are early-`return`s | high-score motivation rows + carved-out pre/post phases (§5); not all uniform rows |
| a witnessed deed's meaning is the actor's **true `kind`**, applied by the **hardcoded fold** in `witnessDeed` (+ the Robin-Hood special case) | acts emit a **primitive + cues**; each witness **infers** the motive over its own memory/beliefs (fallible); the hardcoded fold + its special case retire |
| deception is a spy-only subsystem (`intrigue.ts`, incl. `plant()` writing a belief directly) | deception is the general case of motive misattribution on every primitive (bias the inference, never dictate) |
| ToM reasons over the actor's **goal** | ToM reasons over the actor's **motive**, inferred from the witnessed primitive |
| ToM is purely **reflexive** (witnessing writes belief automatically) | reflexive inference **plus** `deliberate` — an agent can *choose to spend* an action reasoning through a stored observation (§7.6) |
| deception is caught (or not) by fiat | a lie is caught only if a witness **deliberates** on it with contradicting evidence — exposure is a property of who's watching |
| `b.hostile`/`b.standing`/`b.suspicion` set by hardcoded per-deed reactions | set by the **attributed motive's** `consequence`, conf-scaled |

The economy/conservation guarantees are **unchanged** — primitives are the same conserved resolver
ops; only the *social-meaning* channel changed, from a hardcoded per-`kind` fold to per-witness inference.

---

## 10. Migration phases (each its own commit, gates green)

1. **P1 — registry + types, re-host the scorer (behaviour-equivalent, not byte-identical).** Add
   `motivation/registry.ts`, `types/motivation.ts`. Move the *candidate scorer* to motivation rows
   returning today's exact scores, and keep the **role guard pre-phase** and **cohesion post-phase** as
   named functions (§5) — they are a faithful re-implementation of a 520-line function, not a wrap, so
   the gate is **behaviour-equivalence, not byte-identity**: the `kind` *distribution* over a long soak
   stays within a tight tolerance ε of pre-refactor (the `kind-distribution` gate), and the limit-cycle
   tests still pass. Byte-identity is *not* a goal here — the hysteresis re-keys from `kind` to
   `motive.key` (a different equivalence class once P2 un-fuses), so the exact per-tick stream legitimately
   shifts; only the aggregate behaviour must match.
2. **P2 — un-fuse primitive from motive.** `a.motive` carries `{key, primitive, bind}`; `act.ts`
   routes through `execMotive`/`runExecutor`. Still no inference — the executor keeps calling
   `witnessDeed` with the true `kind` exactly as today. Behaviour-preserving; the executor path is just
   reached via the motive.
3. **P3 — the deed envelope + inbox.** `publishDeed`/`perceivedDeeds`/`onWitnessPrimitive`, but the
   inference is a **stub** that returns the true `kind` (so the consequence matches today's `witnessDeed`
   fold exactly). Wires the path with zero behaviour change.
4. **P4 — producers FIRST, then real inference (§4a, §7.1–7.3).** Inference is inert without inputs, so
   **lead with the two producers**: the `witnessed_aggression` episode (one sibling line at
   `combatEvents.ts:379`) and the `believedKindness` fold (mirroring `believedWealth`). *Then* replace
   the stub with `inferMotive`, the observer-cue **queries** (no new fields), the salient-only
   `believedMotive`/`motiveConf`, and the per-row `prior`/`likelihood`. **Calibrate in the two stages of
   §7.2** — likelihoods first with priors flat (the `legibility` gate), then priors as ambiguity-only
   tie-breakers (the `prior-bounded` gate). Do NOT collapse this into "tune the priors." Run the
   per-witness-divergence test only *after* the producers populate memory — with empty cues every
   witness reaches the same posterior and it cannot pass.
5. **P5 — speech-acts (the payoff, brought forward).** Land `say` as a primitive + the `speech.ts`
   motive family (warn/slander/boast/vouch/accuse). This is the first *new* breadth the refactor was for,
   and it depends only on P4 (inference) — **not** on deception or deliberation — so it ships *before*
   them, proving the inference layer on real new motives while the risky introspection work is still
   ahead. (Was P6; promoted because gating the entire point of the doc behind the hardest phases was
   backwards.)

The remaining phases are each a *single* feature on the scale of one `features/*.ts` file — split out so
no commit bundles several, and so the green checkpoints fall between them, not after a mega-commit:

6. **P6 — deception presentation (§7.4).** `presentTag`/`coverTag` + the disguise→prior poison. Retire
   `intrigue.ts`'s `plant()` (a direct false-belief *write*) onto the bias-the-inference path — note this
   is a **behaviour change to the existing spy arc**, not a free simplification, and carries its own test.
7. **P7 — recursive ToM (§7.5).** The guile branch (`a._deceives`-gated, `K≤4`). Independently testable
   against P6's presentation.
8. **P8 — deliberation (§7.6), its own subsystem.** The dedicated `_puzzles` store (§7.2a), the
   `unresolved` filing, the `deliberate` internal primitive, the `puzzle`/`suspect` motive,
   `characterCoherence`/`reweightByCoherence`. This is an *introspection* feature stapled onto a
   perception refactor; it is the most separable thing in the doc and a strong candidate to spin into its
   own LLD (18) if P5–P7 land first. It is what makes a planted lie *catchable*, so it pairs with P6/P7
   thematically — but it must not share their commit.

---

## 11. Tests (`test/suites/motivation.mjs`)

- **Arbitration determinism:** seeded, `arbitrate` picks the same motive given the same beliefs;
  hysteresis kills the flee↔work limit-cycle (carried from today's decide test).
- **Behaviour-equivalence (P1/P2):** the `kind`-*distribution* over a long soak stays within tolerance ε
  of pre-refactor (NOT byte-identity — the hysteresis re-keys from `kind` to `motive.key`, §10 P1), and
  the flee↔work limit-cycle stays killed. Role-guard and cohesion phases produce the same commits as the
  inline returns they replace.
- **Inference correctness:** a labour `take` with honest cues reads `labour` ≥ threshold across
  random witnesses; a burgle with theft cues reads `theft`.
- **Per-witness divergence:** one `strike` deed; a witness with the provocation cue infers `defend`,
  one without + a grudge belief infers `avenge` — assert the two beliefs diverge.
- **Deception lands & backfires:** a slander-as-counsel lowers the target's standing in a naive
  witness AND lowers the *actor's* standing in a rivalry-aware witness; a caught lie arms the caution
  surcharge.
- **Deliberation catches the lie (§7.6):** a planted lie reads benign on the reflex (sub-`attributeAt`,
  files a puzzle); after the witness gains a contradicting belief and spends `deliberate`, the
  attribution flips and persists. A *low-curiosity* witness never spends it and the cover holds — assert
  both outcomes from the same deed. Attention is bounded: assert an agent can't `deliberate` past
  `DELIBERATE.attentionPerTick`.
- **Legibility (calibration stage 1):** with priors flat, an honest cue-rich act reads its true
  motive with posterior ≥ `MOTIVE.legibleAt` across random witnesses.
- **Prior-bounded (calibration stage 2):** with any prior maxed, the true motive of a stage-1-legible
  act **remains the argmax** (ordering preserved, §7.2) — catches the runner-up-boost flip the absolute
  bar misses.
- **Resting low-conf path (§7.2a):** a cue-poor act from a stranger writes **no** `believedMotive`
  (sub-`attributeAt`); assert the belief cell stays clean and any prior attribution is untouched.
- **Split scan:** the epistemic scan ([08](08-testing.md)) extended — `inferMotive`, every row's
  `prior`/`score`/`bind`/`likelihood` touch only beliefs + own-state; `publishDeed`/executors may
  touch ground truth.
- **Cost gates (§"Cost and scale"):** `guile-cost` — the recursive branch is skipped for
  `!a._deceives` and flat per-firing as `K` holds; `inference-cost` — per-witness inference is flat
  as witnesses-per-deed grows (LOD bound holds).
- **Conservation:** gold/goods conserved under the new emit path (the resolver ops are unchanged).

---

## 12. Config (`MOTIVE` block, `simconfig.ts`)

Tuning only — no on/off flags (gating is by branch, per the conventions):

```ts
MOTIVE: {
  stick: 1.18,                 // incumbent-motive hysteresis (today's prevKind bonus)
  legibleAt: 0.7,              // stage-1: posterior conf at which an honest cue-rich act is "clearly read"
  attributeAt: 0.45,           // §7.2a write bar: persist believedMotive only at/above this conf
  ambiguityFloor: 0.15,        // below attributeAt but above this → transient mood unease, no belief write
  deceive: { bonus: 0.6, riskCost: 1.2, maxPairings: 4 },  // recursive-ToM reward/penalty + the K cap (§7.5)
  prior: { strangerBase: 0.2, grudgeGain: 0.8, poorGain: 0.5, rivalryGain: 0.6 },  // per-row prior() weights
  gossipMotiveFade: 0.15,      // confidence penalty per hop when a teller's believedMotive propagates (§7.3)
  maxWitnessInferPerDeed: 999, // LOD cap on first-hand inferences per deed — set HIGH (non-binding) until
                               //   gossip-of-motive (§7.3) can backfill the capped crowd; tighten only then (§13)
  puzzleAt: 0.6,               // §7.2a: deed-magnitude salience bar to file an `unresolved` puzzle worth brooding on
  puzzleWeight: 0.5,           // §7.6: base score of the `puzzle`/`suspect` motive (× magnitude × curiosity|suspicion)
}

// §7.6 — the deliberate primitive's own budget
DELIBERATE: {
  attentionPerTick: 1,         // how many `deliberate` acts an agent may spend per cognition tick (scarce scrutiny)
  maxPasses: 3,                // bounded re-tries on a still-murky puzzle before it's let go to fade
  coherencePenalty: 0.5,       // how hard an incoherent lead motive (rival's "counsel") is demoted on a second look
  puzzleRing: 6,               // §7.2a: capacity of the DEDICATED a._puzzles store (separate from the episodic rings)
  puzzleDecay: 0.02,           // per-tick fade of an un-brooded puzzle (it stops nagging on its own)
}
```

**Two new agent fields the design assumes** (named here so they aren't silent): `a._deceives` — a
boolean trait gating the guile/cover paths (§7.4/7.5), set by `intrigue.ts`/the Director for spies and
the few guileful, default `false` (the honest mainline); and `a._puzzles` — the dedicated bounded puzzle
ring (§7.2a). Both are own-state, guarded, and absent on monsters (the freeze lesson).

---

## 13. Cost and scale

This refactor inherits [10](10-action-grammar-lld.md)'s architecture, so it inherits its bar: every
new per-tick pass has a stated throughput claim and a gate. Three passes are new.

- **Arbitration** replaces the `decide()` candidate loop one-for-one — same number of candidates
  (now rows, not inline `push`es), same `O(motives)` per due agent, LOD-amortized exactly as today.
  **No net cost change** vs the function it replaces; the byte-stability soak (P1) is also the perf
  baseline.
- **Witness inference** is the one genuinely new recurring cost: per *perceived deed*, each witness
  runs `inferMotive` = `motivesFor(primitive)` (≤ ~6) × two clamped reads ≈ **~12 cheap belief reads
  per witness per deed**. The exposure is *deeds × witnesses-per-deed*, which spikes in a dense market.
  It is bounded two ways: (1) deeds are emitted only on primitive *completion* (arrival), not per
  frame — the rate is the act rate, not the frame rate; (2) `maxWitnessInferPerDeed` LOD-caps witnesses
  per deed. **Be honest about what (2) does:** dropping a witness's inference doesn't just defer compute
  — it drops that witness's *consequence* (it forms no motive belief from the deed). That is acceptable
  ONLY if the dropped witnesses can still acquire the attribution another way, which means (2) is
  **gated behind the gossip-of-motive channel (§7.3) actually existing** — the nearest witnesses infer
  first-hand; the rest pick up the *teller's* `believedMotive` later, at lower fidelity, with the
  per-hop fade. Until that channel lands, `maxWitnessInferPerDeed` is set high enough not to bind
  (every real witness infers); it tightens only once gossip-of-motive can backfill. This is a
  deliberate fidelity reduction for the far crowd, **not** a silent drop — and it must not "go dark"
  (the doc-10 LOD rule): a capped witness gets the gossiped attribution, never *nothing*. The
  `lod-convergence` gate asserts the dropped-witness set's beliefs converge via gossip rather than
  vanish. The `inference-cost` gate asserts flat per-witness cost as crowding grows.
- **Recursive ToM** is bounded in §7.5 (skipped for honest agents; `K≤4` synthetic-witness inferences
  when it does fire). The `guile-cost` gate asserts zero added cost on the `!_deceives` mainline.
- **Deliberation** (§7.6) is a *chosen* action, not a pass — it costs one `inferMotive` (the bounded
  loop) plus a coherence read, and an agent may spend at most `DELIBERATE.attentionPerTick` per tick.
  So its cost is self-capping by construction: scrutiny is scarce, the puzzle ring is small, and an
  agent brooding on one deed isn't re-scoring the roster. No new unbounded loop.

Cue assembly is split to keep this cheap: `assembleScene` runs **once** at emit (frozen onto the deed,
shared by all witnesses); `assembleCues` per witness evaluates the handful of `scope:'observer'` cues
as **queries** — a belief-cell read (O(1)) or a memory scan (O(34), the bounded ring). Neither scans
the roster, neither maintains a cue cache. Per-witness input is O(observer cues × memory) ≈ a small
constant. The memory-scan factor is the one new recurring cost vs the earlier "single belief read"
framing — still bounded and roster-free, and the price of *not* keeping a denormalized N³ cue table.

---

### Resolved decisions (promoted from open questions)

- **Belief-field cost → decided (§7.2a, §4a).** The inference adds **no producer/cue layer**: observer
  cues are *queries* over memory + existing belief cells, so there is no N³ relational cache. The only
  new persisted state is two N² fields on the **existing** cell — `believedMotive`/`motiveConf` (sparse:
  written only above `attributeAt`, last-salient-only) and `believedKindness` (a slow trait, like the
  already-present `believedWealth`). The only new *producer* is one episode kind (`witnessed_aggression`,
  a sibling line to `witnessed_death`). The `types/motivation.ts` shape is fixed now.
- **Gossip of motive → decided (§7.3).** A gossiped account carries the **teller's `believedMotive`**
  with `gossipMotiveFade` per hop and an optional hearer re-inference. Misreads compound into the
  town's account; a sharp hearer can resist. The bare-primitive alternative is rejected.

### Genuinely still open

- **Observer-cue decay rates.** The cue catalogue (§4a) fixes the *vocabulary*; what stays open is how
  fast each `scope:'observer'` cue fades — `iSawProvocation` should decay on the memory clock (you
  forget what you saw), but `iBelieveRivalry` rides a slow relationship belief. These are per-cue decay
  constants, tunable once P4 inference is live and the legibility gate gives a baseline. Until then,
  default observer cues to their underlying belief's existing decay.
- **Manufactured cues (framing).** Provoking a target into a real first blow to mint a true
  `iSawProvocation` is emergent and desirable, but needs a *goal* an agent can form ("bait X"); that's
  a motivation/deriver, deferred to a later phase — the cue machinery already supports it, nothing to invent.
