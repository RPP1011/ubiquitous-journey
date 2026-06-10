# 11 (LLD) — Outcome-conditioned caution: implementation spec (v2)

> **Status: low-level design, IMPLEMENTED & ALWAYS-LIVE on the mainline (gating is by branch, not an
> in-code flag — the former `CAUTION.enabled` switch is removed; the `CAUTION` block keeps only its
> tuning fields). v2** folds the self-review of v1; the substantive changes:
> the watched set **shrinks to the three theft-shaped rows** (`attack`/`hold` out — §8 says why),
> outcome classification gains a **neutral band** and an **acted-but-unlanded** path (so the empty
> cache classifies as the shortfall it is), **waste moves to the goal layer** (re-planning is the
> engine's normal operation and is never punished), the §5 attribution input's **dependency on the
> unbuilt wealth-cue estimate is declared** with an honest v1 proxy, the **composer caveat** in §7
> corrects v1's false claim that composers inherit the surcharge, and the tuning constants are
> **anchored to existing timescales** with the house harness sentence attached.
>
> Companion to the regret discussion in the design notes: this builds the *burned-hand* half of
> regret only — agents learn about **strategies** from their own outcomes, the way they already
> learn about the **world** from perception. It deliberately excludes decision-theoretic regret
> (counterfactuals are unobservable under the epistemic split) and moral regret / conscience (a
> sibling feature: it forces the disposition gate from filter to cost and owns the atonement arc
> via the ledger). Read [`10-action-grammar.md`](10-action-grammar.md) and its LLD first; this doc
> assumes their vocabulary.
>
> The two hard invariants of [10-LLD] apply unchanged, plus two of this feature's own:
> - **The epistemic split** holds at both ends: outcomes are written from the agent's **own
>   experienced** deltas (its gold, its inventory, what was done to it — the "being acted upon"
>   channel pointed at one's own acts), never from ground truth it could not perceive. Reads are
>   own-state only, inside `cost`.
> - **Nature stays fixed.** This feature never mutates `personality`. Experience is **nurture**:
>   a decaying, bounded, belief-shaped record. An agent's innate risk appetite is where it was
>   born; what decays back is always toward that.
> - **Freeze lesson:** lazy decay (no per-tick pass), bounded map, every handler independently
>   guarded.
>
> **The one-line summary:** a per-agent, per-strategy signed surcharge — written when a watched
> act's realized yield falls short of its believed yield, when a trip toward it dies on the road,
> or when it nearly kills you; eroded by time and by genuine success — added to that strategy's
> `cost` the same way `confidenceSurcharge` already is.

> **As-built note (the code wins — §0).** The shipped feature follows this spec with these concrete
> bindings: the store is `js/sim/experience.ts` (`ActExperience {s,t,n}`, `recordBurn` /
> `recordWindfall` / `feltSurcharge` / `classifyYield` / `relevantConfidence` / `expKey` / lazy
> `decayed`); the registry is `PLAN_OUTCOME` in `js/sim/exec/registry.ts`
> (`registerPlanOutcome`/`runPlanOutcome`, the same shape as `EFFECT_HOLDS`); the emit sites are
> `cautionPre`/`cautionPost` in `js/sim/agent/act.ts` (snapshot + `_acted` + classify) and
> `cautionWaste` in `pruneGoals` (`js/sim/motivation.ts`); the read hook is one line in
> `solveAtom` (`js/sim/planner.ts`); the feature file is `js/sim/features/caution.ts` (a single
> `PLAN_OUTCOME` handler — no verbs/executors/derivers/effect-holds). The one deliberate divergence:
> **peril** fires from an own-state signal (`mood.fear ≥ CAUTION.perilFear` while a watched step is in
> progress) rather than a dedicated reactive-preemption callback — the cheapest faithful trigger that
> stays own-state and testable; the §8 boundary (no combat verb watched) makes it safe. Tests:
> `test/suites/caution.mjs` (`C1`–`C12` + an end-to-end emit-chain integration).

---

## 1. What gap this fills (and what it must not do)

Today an agent updates its **beliefs about the world** after a failure (the cache belief stales,
confidence drops) but never its **pricing of the strategy**: with identical beliefs the planner
re-prices `burgle` identically forever. The thief who cracked three empty caches plans the fourth
heist at the same cost as the first. This feature gives outcomes a second reader.

What it must **not** do:

- **Double-count with `confidenceSurcharge`.** Confidence prices *belief uncertainty before the
  act*; experience prices *how the act went*. The coupling is the **attribution rule** (§5): a
  failure on a *high*-confidence belief was bad luck and writes little against the strategy; a
  failure on a *knowing gamble* writes a lot. Without that rule, an unlucky agent pays twice and
  reads as neurotic rather than tragic.
- **Collapse the town into timidity.** Three brakes: the surcharge is **capped** (it can never make
  a row infeasible — desperation/widen can still overcome it), it **decays** toward 0, and genuine
  success writes the **opposing** entry (the same renewed-or-fades equilibrium the knowledge model
  uses). v2 adds the structural fourth brake: a burn is written **only from a classified outcome of
  the watched act itself**, never from the engine's routine operation — re-planning, upgrading to a
  better plan, and ordinary combat contact cost nothing (§4, §8).
- **Add cognition cost.** Reads are one bounded map lookup + one exponent; writes happen only at
  step/goal resolutions, not per tick.
- **Punish a verb for being used.** The v1 draft burned `attack` on every fight (being hit during
  your own attack is combat, not peril) and burned strategies whenever a plan was replaced. Both
  are burns-per-use, which no brake survives. The rule that prevents the class of bug: **walk every
  watched verb through its real execution path before admitting it to the set** — the same
  both-ends discipline 10 applies to `recruit`. §8 records the walks that failed.

---

## 2. Module map

| file | layer | responsibility |
| --- | --- | --- |
| `js/sim/experience.ts` | both | **pure helpers**, the `obligations.ts` pattern: the `ActExperience` store math — `recordBurn` / `recordWindfall` / `feltSurcharge` / `classifyYield` / `relevantConfidence` / `expKey` / lazy decay. No tick wiring of its own. |
| `js/sim/exec/registry.ts` | seam | **one new registry**: `PLAN_OUTCOME` — handlers fired when a watched act resolves (`shortfall` / `neutral` / `windfall` / `peril` / `waste`). Same shape as `EFFECT_HOLDS`: `registerPlanOutcome(fn)`, `runPlanOutcome(a, ctx, evt)`, each handler independently guarded. |
| `js/sim/agent/act.ts` | execution | the **step-level emit sites** (`cautionPre`/`cautionPost`): snapshot + `_acted` arrival flag on watched steps; classify + emit on step landing, on drop of an *acted* step, and on the peril signal. Always-live (invoked every tick from `execPlanStep`). |
| `js/sim/motivation.ts` (`pruneGoals`) | cognition | the **waste emit site** (`cautionWaste`): a goal that expires or is flagged unreachable after real travel toward a watched step that never came within reach (§4.4). Gated. |
| `js/sim/planner.ts` | cognition | the **one central read hook** in `solveAtom`: `stepCost += feltSurcharge(agent, prim, bind, now)`, beside the existing `confidenceSurcharge`; plus the plan-time `bind._conf` snapshot (§5). Always-live; 0 when no experience. **Composers are NOT covered** — see the §7 caveat. |
| `js/sim/features/caution.ts` | both | the feature file: registers the single `PLAN_OUTCOME` handler that calls into `experience.ts`. **No verbs, no executors, no derivers, no effect-holds** — the smallest feature yet; caution is pure cost-shaping. |
| `types/agent.ts` | types | `_actExperience?: Map<string, ActExperience>` + the `_cautionStep`/`_cautionGoal` transition pointers on `Agent`. |
| `types/goals.ts` | types | `_snap`/`_acted`/`_emitted` on `PlanStep`, `_conf` on `PlanBind`, `_cautionTrail` on `Goal`. |
| `test/suites/caution.mjs` | test | the gated C* tests (§10). |

### Where it runs in the tick

```
act(dt) ── execPlanStep ── watched step starts:  snapshot                           [cautionPre]
                        ── each frame:           _acted ||= within arriveDist        [cautionPost]
                        ── reached & acted:      classify yield (3 bands) → runPlanOutcome
                        ── frightened mid-act:   peril → runPlanOutcome
                        ── watched step dropped: if _acted: classify → runPlanOutcome [cautionPre]
                        ──                       else: NOTHING (re-planning is free)
reason ── pruneGoals ── goal expired/unreachable after travel toward a never-reached watched step:
                        waste → runPlanOutcome                                       [cautionWaste]
reason ── plan() ── solveAtom ── stepCost += confidenceSurcharge + feltSurcharge     [cognition read]
```

No new per-tick pass. Decay is computed lazily at read/write time from `lastUpdated`.

---

## 3. Core data structures

```ts
// One strategy's learned record — deliberately the belief-table shape (value / time / weight).
interface ActExperience {
  s: number;   // SIGNED surcharge: > 0 burned (dearer), < 0 emboldened (cheaper). Clamped (§6).
  t: number;   // last-updated sim-time (lazy decay anchor)
  n: number;   // sample count (diagnostics + diminishing windfall, §6)
}

// agent._actExperience : Map<expKey, ActExperience>   // bounded at CAUTION.maxKeys (oldest-t drop)

// v1 key = the primitive NAME. The row is the strategy. One signature, everywhere:
expKey(primName: string, bind?: PlanBind): string => primName
// Follow-up (NOT v1): qualified keys for route-shaped strategies, e.g. `sell:${bind.place}`
// so a trader can sour on Thorngate specifically. Same store, finer key; see the §7 caveat —
// reaching composer-priced steps needs more than the keyer.

// The event a resolution emits to PLAN_OUTCOME handlers:
interface OutcomeEvt {
  status: 'shortfall' | 'neutral' | 'windfall' | 'peril' | 'waste';
  step: PlanStep;            // the WATCHED step this resolution is about (carries bind + _conf)
  expected?: number;          // believed yield at plan time (from the applyEffect semantics)
  realized?: number;          // experienced delta over the step (from the snapshot)
  goal?: Goal;                // present on 'waste' (the goal-layer emit)
}
```

### The watched-verb set

```
CAUTION.watched = ['burgle', 'rob', 'loot']
```

Three admission criteria, each doing real work:

1. **The yield is a bet** — believed haul vs. realized haul can genuinely diverge.
   (`gather`/`produce`/`buy` are near-deterministic; learning on them is noise.)
2. **A substitute row exists** — the burn's behavioral meaning is *redirection* in the existing
   cost comparison (burgle loses to gather), not goal suppression. §8 covers the rows that fail
   this test (`hold`) and why suppression is a different feature.
3. **The execution walk is clean** — the verb's normal operation produces no spurious outcome.
   §8 covers the row that fails this one (`attack`).

`sell` stays out until the qualified-key + composer follow-up (the Mara arc — souring on a
*route*, not on selling; §7 caveat). `recruit` stays out until the NPC-war-party follow-up gives
it an observable outcome.

### Config (`js/sim/simconfig.ts`)

```
CAUTION = {                // always-live (no on/off flag) — tuning fields only
  watched: ['burgle', 'rob', 'loot'],

  // ── timescale: anchored to the goal layer's own retry clock ──
  halfLife: 72,           // = 6 * PLAN.partialCooldown(12). ORDERING that matters: cooldown ≪
                          //   halfLife, so a goal is retried several times within one strategy
                          //   memory; and halfLife is a large fraction of the ~150 sim-s eval
                          //   window, so retirement arcs are OBSERVABLE in it.

  // ── magnitudes: anchored to the planner's own cost scale ──
  cap: 8,                 // |s| clamp. actBase=1, routeRisk=6 — a fully burned strategy reads
                          //   like one extra believed hostile on the route: strongly dissuasive,
                          //   NEVER infeasible. cap < ∞ is the no-timidity-lock guarantee (C8).
  shortfallRatio: 0.5,    // realized <  ratio·expected            ⇒ 'shortfall'
                          // ratio·expected ≤ realized < expected  ⇒ 'neutral'  (NO write)
                          // realized ≥ expected                   ⇒ 'windfall'
  burn:    { shortfall: 2.0, waste: 1.5, peril: 4.0 },
  windfall: -0.75,        // |windfall| ≪ burns (loss-averse on purpose); diminishing (§6)
  capDiscount: 2,         // = cap/4: emboldening is real but shallow
  luckDiscount: 0.7,      // attribution (§5): burn *= (1 − plantimeConf · luckDiscount)
  rtRelief: 0.6,          // felt = s · (1 − risk_tolerance · rtRelief), POSITIVE side only
  perilFear: 0.5,         // mood.fear at/above which a watched act in progress is peril (own-state)
  maxKeys: 12,            // sized for the qualified-key follow-up; v1 can occupy at most 3
}
```

Every number above is a starting point with a stated *ordering*, not a measured value — the
harness is where these numbers get taken, not this paragraph. The orderings the harness must
preserve while tuning: `partialCooldown ≪ halfLife`; `|windfall| < burn.shortfall < burn.peril`;
`cap` of the same order as `routeRisk`.

---

## 4. Emit sites & outcome classification (always-live throughout)

### 4.1 Snapshot + the `_acted` flag (`act.ts` `cautionPre`/`cautionPost`)

When `execPlanStep` begins a step whose `step.prim ∈ CAUTION.watched`:

```
step._snap  = { gold: a.gold, t0: now }     // own gold = the realized-delta anchor
step._acted = false; step._emitted = false
goal._cautionTrail = { step, acted:false, resolved:false }
```

Each frame the step is current (post-exec):

```
tp = cautionTargetPos(a, ctx, step)         // stash place / mark / corpse
if tp and dist(a.pos, tp) <= arriveDist: step._acted = true
```

`_acted` means *the agent reached the payoff site* — the generic, no-executor-edit proxy for "the
verb actually ran" (every watched executor is arrival-gated, so reach ⇒ the act was attempted).
This flag is what separates "the bet was placed and lost" from "the trip never finished".

### 4.2 Yield classification — three bands, one function (`experience.classifyYield`)

```
classifyYield(expected, realized):           // expected = burgle/rob → bind.amt; loot → 1
  if expected <= 0:                                return 'neutral'
  if realized <  CAUTION.shortfallRatio*expected: return 'shortfall'
  if realized <  expected:                         return 'neutral'
  return                                           'windfall'
// realized = own gold now − step._snap.gold (OWN state only)
```

> **The neutral band is load-bearing.** Without it, a haul of 60 % of expectation writes an
> *emboldening* entry, and across many ordinary mildly-disappointing nights the loss-aversion
> asymmetry inverts in aggregate. Mediocrity teaches nothing; only genuine surprise — in either
> direction — writes.

### 4.3 Step-level emit sites (`act.ts`)

```
// (a) reached & acted (the executor ran this tick; the take landed):
emit classifyYield(expected, realized)    // covers the thin cache (8 of 50 ⇒ shortfall) AND the
                                          //   empty cache (0 of 50 ⇒ shortfall) — same class, by degree.

// (b) the plan is dropped (re-plan, upgrade, preemption) while a watched step was current:
if step._acted: emit classifyYield(...)   // an interrupted heist that had already reached → resolve.
else: emit NOTHING                        // re-planning is the engine's normal operation — dropping
                                          //   a heist mid-walk for a better opportunity costs nothing.

// (c) the agent is frightened mid-watched-step (mood.fear ≥ perilFear):
emit { status:'peril', step }             // the mark fought back; the night nearly cost you.
```

> The peril trigger is safe **only because no combat verb is in the watched set** — being hit during
> your own `attack` is combat's normal case, not peril, and watching `attack` under this rule burns
> fighters into cowardice within a handful of engagements (the v1 bug). If combat caution is ever
> wanted, it enters through a real win/loss signal from the fighter, not through this trigger —
> see §8.

### 4.4 The goal-level emit site — `waste` (`pruneGoals` → `cautionWaste`)

`waste` means *the venture died on the road*: the agent spent real travel toward a watched act it
never got to attempt. That is a property of the **goal's** life, not of any one plan, so it is
emitted where goals end by **expiry / unreachable** — never on a predicate-satisfied pop
(satisfied-by-other-means costs nothing), never on a plan swap (re-planning is free):

```
cautionWaste(a, ctx, goal):                 // called in pruneGoals' expiry + unreachable branches
  tr = goal._cautionTrail
  if tr and tr.step and !tr.acted and !tr.resolved:
    tr.resolved = true
    runPlanOutcome(a, ctx, { status:'waste', step: tr.step, goal })
```

A goal satisfied by other means, a goal whose plan was upgraded, a goal abandoned before any
travel — none of these is a waste. Only *set out (reached the watched step), never arrived, gave up*
is.

---

## 5. Attribution — the luck rule (the coupling to `confidenceSurcharge`)

At **plan time**, `solveAtom` snapshots the confidence of the belief the watched step leans on:

```
if prim.name in CAUTION.watched:
  bind._conf = relevantConfidence(agent, prim.name, bind)
```

At **burn time** (`shortfall` / `peril` / `waste`):

```
luck   = step.bind._conf ?? 0              // how knowable was this, when chosen?
factor = 1 − luck · CAUTION.luckDiscount   // confident-and-wrong ⇒ mostly luck ⇒ small burn
burn   = CAUTION.burn[status] · factor
```

A heist undertaken on a half-glimpsed cache that comes up empty writes `~2.0` against `burgle`;
the same empty cache after a week of confident casing writes `~0.6`. The strategy learns most from
the failures the agent *chose to risk* — the signal was in the belief record all along; experience
is its second reader.

### What `relevantConfidence` reads, per verb — and the declared dependency

| verb | the belief the act leans on | v1 source |
| --- | --- | --- |
| `burgle` | how much is in the cache | **unbuilt** — the §15 wealth-cue estimate (10-LLD §19.2, now built but not carrying its own haul-confidence yet). **v1 proxy: the stash `assoc.conf`** (the location belief) — honest but partial: it prices "did I really know where it was," not "did I really know it was fat". |
| `rob` | the mark's holdings | same dependency; **v1 proxy: `beliefs.get(markId).confidence`** (how well-tracked the mark is). |
| `loot` | the corpse is there & unlooted | `beliefs.get(corpseId).confidence` — exists today. |

> **Declared dependency:** the attribution rule is fully meaningful for the two flagship verbs
> only once the wealth-cue haul carries its **own** confidence. Until then the proxies above make
> attribution *directionally* right (a thief acting on a half-glimpsed stash still burns harder than
> a careful caser) while underweighting the "knew where, guessed how much" gamble. Ship with the
> proxy; swap the read when the haul-confidence lands — one line, same rule. **That confidence is
> `wealthConf`** on `BeliefState`, built by [12-LLD §6] (the believed-wealth field); [12]'s build
> roadmap step 4 performs this swap (`relevantConfidence(burgle/rob)` → `bind._conf = wealthConf(mark)`)
> and records it as a cross-doc synergy. The two docs are coupled here: §6 there supplies the input §5
> here declared missing.

---

## 6. The store math (`experience.ts`, pure)

```
decayed(e, now) = e.s * 0.5 ** ((now − e.t) / CAUTION.halfLife)

// Single write path. `delta` may be a number or a function of the CURRENT entry (post-decay),
// which is how the diminishing windfall reads `n` without scope acrobatics.
write(a, key, delta, now):
  e = a._actExperience.get(key) ?? { s: 0, t: now, n: 0 }
  base = decayed(e, now)
  d = (typeof delta == 'function') ? delta(e) : delta
  e.s = clamp(base + d, −CAUTION.capDiscount, +CAUTION.cap)
  e.t = now; e.n++
  a._actExperience.set(key, e); enforceMaxKeys(a)     // drop oldest-t over maxKeys

recordBurn(a, key, status, conf, now):
  write(a, key, CAUTION.burn[status] * (1 − conf * CAUTION.luckDiscount), now)

recordWindfall(a, key, now):
  write(a, key, (e) => CAUTION.windfall / (1 + e.n * 0.25), now)   // 10th success teaches < 1st

// THE COGNITION READ — beside confidenceSurcharge in solveAtom. Own-state only. 0 when unknown.
feltSurcharge(a, primName, bind, now):
  e = a._actExperience?.get(expKey(primName, bind)); if !e: return 0
  s = decayed(e, now)
  if s > 0: s *= (1 − (a.personality?.risk_tolerance ?? 0.5) * CAUTION.rtRelief)   // the bold shrug
  return s            // may be NEGATIVE (emboldened) — a strategy that keeps paying gets cheap
```

> **The asymmetries are the design.** Burns outweigh windfalls (loss aversion — one bad night
> outweighs one good one); emboldening clamps shallower than burning (`capDiscount = cap/4`: a hot
> streak makes you keen, not invincible); `rtRelief` applies to the *positive* side only (a bold
> agent shrugs off burns but still enjoys streaks); and the neutral band (§4.2) means only genuine
> surprise writes at all. Together with decay these are the anti-collapse brakes of §1, and the
> negative side is a free bonus: agents drift toward repeating what has actually paid *them* —
> experience-reinforced specialization, the nurture echo of profession.

---

## 7. Planner integration — one line, one snapshot, one honest caveat

In `solveAtom`, beside the existing cost assembly:

```
stepCost = prim.cost(agent, ctx, bind)                       // existing (incl. confidenceSurcharge)
stepCost += feltSurcharge(agent, prim.name, bind, ctx.time)  // always-live; 0 when no experience
if prim.name in CAUTION.watched:
  bind._conf = relevantConfidence(agent, prim.name, bind)    // the §5 plan-time snapshot
```

Nothing else in the planner changes. The widen path is untouched — a desperate agent's widened
search can still select a burned row because the cap keeps it finite, which is the
poverty-pressure interaction working as intended (the burned thief steals again only when the want
gets bad enough, which is a *story*, not a bug).

> **The composer caveat (a v1 claim, corrected).** The threshold composers do **not** price steps
> through `prim.cost` — `composeGold` and `composeForce` hand-assemble costs (`cost += actBase`,
> `cost += d·travelPerMetre + actBase`), so `feltSurcharge` never reaches composer-priced steps.
> Harmless in v1 only because every composer-priced verb (`sell`, `recruit`) is unwatched. The
> Mara route-souring follow-up therefore needs **two** edits, not one: the qualified key (§3) *and*
> a `feltSurcharge(a, 'sell', {place}, now)` term inside `composeGold`'s per-source costing. Plan
> the follow-up at that size.

---

## 8. Rows kept out, and the rule they teach

Two rows from the v1 draft fail the §3 admission criteria in instructive ways. Recording the walks
so they aren't re-tried casually:

**`attack` fails the clean-execution-walk test.** Its candidate peril signal — assaulted while the
step is active — fires on combat's *normal case*: the opponent fights back. Every engagement,
including won ones, would burn the row at `burn.peril`, the largest constant in the config: a
burn-per-use that no cap/decay brake survives, converging every fighter on cowardice. Combat
caution is a real feature, but its outcome signal must come from the fighter's own resolution
(won / fled / health fraction lost), not from this trigger — and once it exists, `attack` can be
admitted with `expectedYield` semantics of its own. Until then, out. **That win/loss signal is built
by [12-LLD §7]** — the directed-assault executor's `marched`/`routed` resolution is exactly this
per-engagement outcome, and [12] step 5 emits it **through this doc's own `PLAN_OUTCOME` registry**
(`marched` ≈ a `windfall`/landed step, `routed` ≈ `peril`, health-fraction in the `evt`). So admitting
`attack` here is just registering a second `PLAN_OUTCOME` handler on an emission that already fires —
no new carrier to build. (The shipped peril trigger,
`mood.fear` while a *watched* step is active, is safe precisely because `attack` is not watched —
so no snapshot exists for a combat step and the regression test `C11` asserts no `attack` burn.)

**`hold` fails the substitute-row test.** A burn redirects behavior only where the cost comparison
has somewhere else to go (burgle → gather). `hold` is the *only* way to wait: burning it cannot
redirect, it can only inflate every plan shaped like the rescue until the goal class satisfices
away. That is **goal suppression** — trauma-shaped, possibly wanted someday ("the party that was
discovered once won't try again for a season") — but it is a categorically different behavioral
effect from strategy-switching, with different brakes needed (per-goal-class cooldowns, not
per-row costs). If wanted, it should be designed as its own small mechanism with eyes open, not
smuggled in as a watched verb.

The general rule both walks teach, now §1's fourth brake: **a watched verb must be walked through
its real execution path end-to-end before admission**, the same discipline 10 applies to `recruit`
— because every classification bug is invisible in the store math and obvious in the walk.

---

## 9. The feature file (`features/caution.ts`)

```ts
import { registerPlanOutcome } from '../exec/registry.js';
import { recordBurn, recordWindfall, expKey } from '../experience.js';

// Always-live: the handler writes the surcharge whenever a watched act resolves.
registerPlanOutcome((a, ctx, evt) => {
  if (!a || !evt || !evt.step) return;
  const key = expKey(evt.step.prim, evt.step.bind);
  const now = ctx ? ctx.time : 0;
  switch (evt.status) {
    case 'windfall': recordWindfall(a, key, now); break;
    case 'neutral':  break;                                  // mediocrity teaches nothing
    default:         recordBurn(a, key, evt.status, evt.step.bind._conf ?? 0, now);
  }
});
```

That is the whole feature: one handler. No verbs, no derivers, no effect-holds — the registries'
cleanest proof that a behaviour-shaping feature can be a single registered row.

---

## 10. Tests (`test/suites/caution.mjs`, gated, restore-in-`finally`)

```
C1  thin cache burns            — classifyYield(50,8)='shortfall'; recordBurn ⇒ s>0
C2  EMPTY cache burns the same  — classifyYield(50,0)='shortfall' (NOT silent, NOT waste)
C3  the burn redirects          — a burned burgle is priced dearer than a fresh substitute (loot=0)
C4  decay restores the appetite — feltSurcharge after 3·halfLife < ¼ of fresh
C5  neutral band is silent      — classifyYield(50,35)='neutral'
C6  windfall embolds, shallowly — windfall ⇒ s<0; |s| ≤ capDiscount even after 20 successes
C7  attribution                 — same shortfall at conf 0.9 burns less than at conf 0.2
C8  desperation override        — a fully-burned strategy is finite (≤ cap): no timidity lock
C12 bounds                      — s clamps to cap; map ≤ maxKeys (oldest-t evicted)
C-int the emit chain            — a real heist (frame loop) on a near-empty mark burns the thief's
                                  strategy (act.ts emit site → handler → store, end-to-end)
C11 §8 regression               — a combat verb (attack) is NEVER burned (not in the watched set)
```

---

## 11. Evaluation — what should show up in the soak

Extend the §20 narrative-depth table with the consequence-side counters this feature creates:

| metric | expectation with `CAUTION` on |
| --- | --- |
| repeat-offense interval | a burned thief's next theft comes later than a fresh thief's (retirement-and-relapse arcs, visible inside one eval window by the halfLife anchoring) |
| strategy abandonment | per-agent `s('burgle')` crossing a threshold after failures, decaying back |
| herding | failure burns cluster in time across agents who acted on the same rumour — shared abandonment of a trade, then re-entry as decay releases it (boom/bust in *strategies*, the twin of the price-rumour burst) |
| specialization | negative `s` accumulating on each agent's habitually successful rows |
| no-collapse gate | town-wide theft/trade attempt counts stay nonzero at equilibrium (the §1 brakes, measured) |
| silence check | count of `neutral` resolutions ≫ count of writes (most nights are ordinary; the store only records surprise) |

---

## 12. Known limits (v2, on purpose)

1. **Verb-granularity blame** conflates all marks into one scalar per row. Right first cut; the
   qualified-key extension is where per-route and per-mark wariness live — and per the §7 caveat
   it is a keyer change *plus* composer hooks, not a keyer change alone.
2. **Last-step credit assignment** — the payoff step absorbs all blame; a plan that failed because
   scouting was skipped still burns the heist row. Acceptable: the attribution rule (§5) already
   burns hardest exactly when the scouting was thin.
3. **Delta contamination over long steps.** `experiencedDelta` attributes the whole own-state
   change across the step to the step — an agent robbed, tolled, or fed mid-step pollutes the
   read. Rare, bounded by the clamp, and self-correcting under decay; revisit only if the soak
   shows phantom burns.
4. **The §5 dependency.** Attribution for `burgle`/`rob` runs on proxy confidences until the
   wealth-cue haul carries its own confidence; directionally right, knowingly underweighted.
5. **No social spread.** Experience is private; agents do not gossip "burglary doesn't pay." If
   wanted later it is a topic kind riding the existing hearsay channel — but private hard lessons
   plus public rumours of *facts* may be the more believable split, so the default is private.
6. **Combat caution and goal suppression are siblings, not scope** — §8 records the door each
   enters through (a fighter win/loss signal; a per-goal-class cooldown mechanism).
7. **Moral regret is out of scope** — conscience cost, gate-softening, atonement obligations are a
   sibling feature with its own LLD; this store is reusable there (a conscience burn is a burn
   with a different writer), which is another reason `experience.ts` is pure helpers.
