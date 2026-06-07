# Reasoning traces — making "why did it do that?" answerable

> **Status: designed.** This specifies the trace subsystem. It is **designed now** but
> **implemented after Phase 2b lands** (the steering collapse), so the trace records the
> *final* executor, not a half-migrated one. See [09 — the reasoning layer](architecture/09-reasoning-layer.md).

## Why this exists

The reasoning layer decides *invisibly*. Schemas ([Phase 2a](architecture/09-reasoning-layer.md))
fire or are suppressed inside the interpreter; the executor ([Phase 2b](architecture/09-reasoning-layer.md))
arbitrates behaviours; the planner replans on belief changes — and none of it leaves a record
you can read. Today the only way to tell *"the schema never fired"* from *"it fired and lost
arbitration"* is to add a `console.log` and re-run. That is the gap traces close.

A trace is a **diagnostic side-channel**: a small, bounded, per-agent log of *why this mind did
what it did this tick*. Three consumers justify it:

1. **Debugging (the inspector).** The "look-to-read-mind" tool (`F`, `ui/inspector.js`) already
   shows an agent's **beliefs** — the *what-I-think*. Traces add the *why-I-acted*: "fled the
   brawl because I witnessed Rook strike nearby and I'm no combatant."
2. **Verification (the build lens).** 2b is a behaviour-*preserving* refactor and Phase 3 adds
   LOD — both are exactly the kind of change where you need to *watch* a behaviour win or lose
   arbitration to trust it. The trace is that lens; it is the tool I'd most want pointed at the
   executor while it is being rewritten.
3. **Test instrument.** A trace lets a headless test assert **why**, not just **what** — e.g.
   the flee-interrupt scenario should emit a `decide: flee won over plan` entry, not merely end
   with the agent safe. This turns opaque behavioural assertions into legible ones.

Traces sit *below* the existing narrative layers and are higher-frequency than them:

| Layer | Cadence | Persistence | Audience |
| --- | --- | --- | --- |
| `chronicle.js` (beats) | sparse, notable | persistent world history | player-facing |
| `biography.js` (drives) | per-agent summary | persistent | player-facing |
| **trace (this doc)** | **every cognition tick** | **bounded ring, ephemeral** | **debug / test / dev** |

A genuinely notable trace entry can be *promoted* to a chronicle beat, but the trace itself is a
debug ring, not history.

---

## The one non-negotiable rule

> **A trace is WRITTEN BY the cognition tick, from the agent's own view, and is NEVER READ BACK
> by any decision.** It is read only by the UI (truth-side, read-only — like the inspector that
> already reads minds) and by tests.

This single rule is what keeps the trace safe:

- **No feedback loop.** If `decide`/`act`/a schema could read `a.trace`, an agent's past
  reasoning would feed its next reasoning — a hidden state channel outside the belief model.
  Forbidden. The trace is strictly write-only from cognition.
- **No epistemic leak.** A trace records the agent's *own* reasoning — its own beliefs, its own
  utility scores, its own goal stack — all own-state, so writing it is not a split violation.
  The danger would be the trace becoming an *input*; the write-only rule forecloses it.
- **Enforcement.** The [epistemic scan](architecture/02-epistemic-split.md) gains one line: in
  the SCANNED cognition files (`decide.js`, `act.js`, the schema interpreter, `motivation.js`,
  `planner.js`), a *read* of `.trace` (anything other than the sanctioned `a.trace.note(...)`
  write) is a violation. Belt-and-suspenders, exactly as the roster ban is.

---

## Data model — a structured entry, formatted lazily

The label-cache lesson (`Agent._updateLabel`: canvas/GPU upload is the per-frame cost; don't
defeat the cache) applies directly. So a trace entry is a **cheap structured record**, and the
human-readable string is produced **only when the UI actually reads it** — never on the tick.

```js
// One reasoning event. Tiny, allocation-light, no strings built on the tick.
TraceEntry = {
  t,            // sim time (the tick stamp)
  stage,        // STAGE.* — which reasoning layer emitted it
  code,         // REASON.* — a stable enum, the localisable/testable key
  verdict,      // VERDICT.* | null — fired/suppressed/won/lost/blocked/replanned/revised
  subjectId,    // the belief subject this was about (a foe, a place percept) | null
  a, b,         // up to two small numeric/string operands (a score, a conf, a place id)
}
```

`stage` is the pipeline position:

```
STAGE = { PERCEIVE, INFER, SCHEMA, GOAL, PLAN, DECIDE, ACT }
```

`code` is a small **stable enum** (not a free string) so tests can match on it and a formatter
can localise it — mirroring `beliefs.js`'s `provenanceLabel(b)`/`provenanceTag(b)` pattern. A
starter set, grouped by stage:

```
REASON = {
  // INFER
  DEST_INFERRED,        // inferDestination picked a place (subjectId=quarry, a=placeId)
  ANIMACY_REVISED,      // schema #6: hostile→false from zero observed animacy
  // SCHEMA
  SCHEMA_FIRED,         // a=schemaId   (verdict=fired)
  SCHEMA_SUPPRESSED,    // a=schemaId, b=failing-predicate
  // GOAL
  GOAL_DERIVED,         // a=goalKind, subjectId=source memory's subject
  GOAL_POPPED,          // a goal's predicate became satisfied
  // PLAN
  PLAN_FOUND,           // a=stepCount
  PLAN_FAILED,          // a=blocking precondition atom
  PLAN_REPLANNED,       // a belief change invalidated a pre/eff
  // DECIDE / ACT  (the most valuable entries)
  BEHAVIOUR_WON,        // a=behaviour/steer-fill, b=utility; subjectId=target
  BEHAVIOUR_RUNNERUP,   // a=behaviour, b=utility — the loser, the gold for "why not X?"
  INTERRUPTED,          // flee/threat overrode the active plan (a=overriding behaviour)
  RESUMED,              // the stacked goal resumed after the interrupt cleared
}
```

A formatter renders an entry to text **on read**:

```js
// ui-side, called only by the inspector when it draws the panel (cached by signature).
traceLabel(e) // → "fled the brawl — witnessed Rook strike nearby, I'm no combatant"
```

---

## The ring buffer

```js
// per-agent, bounded, append-only. a.trace on every Agent.
class Trace {
  note(stage, code, { verdict=null, subjectId=null, a=null, b=null } = {}) { … }  // O(1), overwrites oldest
  recent(n)  // newest-first view, for the UI/tests
}
```

- **Bounded** — `TRACE.depth` (~24) entries per agent; appending past the cap overwrites the
  oldest. O(1) append, O(`agents × depth`) memory (~2.4k tiny objects at 100 agents — nothing).
- **Headless-safe** — a plain ring of plain objects; no DOM, no Three. Tests read it directly.
- **All agents, always traced** — because entries are structured and cheap; the *string* cost is
  deferred to read time, so tracing the whole town costs no per-frame work. (This is the whole
  reason for structured-not-string: it is what makes "trace everyone" affordable.)
- **`TRACE.enabled`** (config, default **on**) — a global off switch for a pure-perf soak. With
  it off, `note()` is a single guarded early-return (byte-stable, zero allocation), so the soak
  baseline is unchanged either way.

---

## The write seam (where each stage emits) — and why it survives Phase 2b

Each reasoning stage gets **one** `a.trace.note(...)` call at its decision point. The placement
that matters most is the **arbitration point**, and it is deliberately defined so the 2b
collapse does not move it:

- **`perception.js` / inference** — `DEST_INFERRED` when `inferDestination` commits a place;
  `ANIMACY_REVISED` when schema #6 flips a belief.
- **schema `interpreter.js`** — `SCHEMA_FIRED` / `SCHEMA_SUPPRESSED` per evaluation, recording
  the predicate that decided it (the single highest-value debug entry for the schema layer).
- **`motivation.js`** — `GOAL_DERIVED` / `GOAL_POPPED` as the goal stack changes.
- **`planner.js`** — `PLAN_FOUND` / `PLAN_FAILED` / `PLAN_REPLANNED`, naming the precondition
  atom or the belief that changed.
- **`decide.js` (the arbitration point)** — `BEHAVIOUR_WON` + `BEHAVIOUR_RUNNERUP` + their
  utility scores; `INTERRUPTED` / `RESUMED` around a flee override.

  **Why this survives 2b:** today the winner is a `goal.kind`; after 2b it is a *steer-fill /
  named behaviour*. The trace records *"the behaviour that won arbitration, by name, with its
  utility, and the runner-up"* — an abstraction over *whichever* representation the executor
  uses. It is written at `decide`'s argmax, which the collapse keeps; only the *value* of `a`
  (a `goal.kind` string → a steer-fill name) changes, and that is exactly the unit the depth
  metric is also migrating to. One concept, two consumers, both stable across 2b.

Every write is guarded (the freeze lesson): `note()` never throws, and a `null` subject/operand
is fine (a trace may reference a despawned percept).

---

## UI — the inspector "Thoughts" panel

`ui/inspector.js` gains a read-only **Reasoning / Thoughts** section under the existing belief
readout: `a.trace.recent(n)` rendered newest-first through `traceLabel`, **cached by a signature
string** (the trace's newest `t`) so the canvas is rebuilt only when a new entry lands — the
label-cache discipline. Shown for the **inspected agent only** (not all on screen). The
mindbrowser (`ui/mindbrowser.js`) can surface the same for any agent. All read-only, all
truth-side — the UI is allowed to read minds; cognition is not allowed to read traces.

An optional **global recent-reasoning feed** (a small shared ring, like the chronicle's) can tap
the same `note()` for a dev "what is the town thinking right now" panel — purely additive.

---

## Test instrument

A `test/suites/trace.mjs` asserts that known scenarios emit the expected reasoning, turning
behavioural tests legible:

- the flee-interrupt scenario (C4/G4) emits `INTERRUPTED(flee)` then `RESUMED` — proving the
  *mechanism*, not just the safe outcome;
- schema #6 (the scarecrow) emits `ANIMACY_REVISED` + `SCHEMA_FIRED(no-threat-no-response)`;
- the homecoming emits `PLAN_REPLANNED` on ruin-discovery;
- the pursuit-intercept emits `DEST_INFERRED` + `BEHAVIOUR_WON(pursue)`.

These match on the `code` enum (stable), never the rendered string (cosmetic).

---

## Cost & sequencing

- **Cost:** O(1) structured append; O(`agents × depth`) memory; **zero per-frame string work**.
  `depthMetrics.js` and Phase 3's reasoning-cost metric are natural downstream consumers (a
  trace *is* a per-tick firing record).
- **Sequencing:** design lands now; **implementation lands after Phase 2b**, so it instruments
  the final steer executor — and then serves as the verification lens for the economy merge,
  Phase 3 (LOD), and the Phase 4 schemas.

## Open decisions

1. **`TRACE.enabled` default** — on (always-available diagnostics) vs off (opt-in, zero doubt
   about soak cost). Recommendation: **on**; `note()` is near-free and tests want it.
2. **Depth** — 24 entries balances "enough to see a decision chain" against memory. Tunable.
3. **Promotion to chronicle** — should a `BEHAVIOUR_WON` for a dramatic behaviour auto-file a
   chronicle beat, or stay debug-only? Recommendation: **debug-only**; let the existing
   deed→chronicle path own narrative, keep traces purely diagnostic.
4. **Reason-code coverage** — start with the enum above; grow it as the Phase 4/5 schemas land
   (each new interaction adds its own `code`s), measured by the trace suite.
