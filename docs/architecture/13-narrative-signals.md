# 12a — Narrative signal catalog: values worth tracking for story probes

> **Status: design addendum to [`12-narrative-tooling-lld.md`](12-narrative-tooling-lld.md).**
> Doc 12 built the spine (the arc registry) and two sensors. This catalog answers the next
> question: *what should the observer layer be measuring* so that probes have something to read?
> Each entry is a small, bounded, event-folded value with a named write site and the probe/trope
> it unlocks. The families:
>
> **A** trajectory & reversal · **B** relational structure · **C** belief–truth divergence
> (dramatic irony — the omniscient layer's exclusive) · **D** town climate · **E** biography
> accumulators · **F** probe metadata
>
> Scope tags: **[T]** truth-side, observer layer only (display/detection; never read by cognition)
> · **[B]** belief-side (per-perceiver, may drive behaviour through the normal cognition path).
> The §10 rule from doc 12 applies to every row: a [T] value may fire beats and open/close arcs;
> only a [B] value (or an own-state read) may author a memory an agent acts on.

---

## 1. Design rules every signal obeys

1. **Fold on events, never scan.** Every write site below is an *existing* event seam
   (`PLAN_OUTCOME`, `witnessDeed`/`onCombatEvents`, `marketClear`, obligation settle/default,
   `deriveGoals`/`pruneGoals`, arc open/append/close, perception bridges, `_surpass`,
   `joinWarband`). The only scan-shaped work is the already-budgeted observer pass (§5 of doc 12)
   and `sagas.sweep`.
2. **Two-timescale EWMAs, not running maxima.** Trend values keep a fast and a slow exponential
   average; *rise* = fast ≫ slow, *fall* = fast ≪ slow, *reversal* = the sign of (fast − slow)
   flipping past a magnitude gate. This replaces doc 12 §5's `_statusHigh` running max, which
   cannot tell catastrophe from spending down a windfall (review finding 3). Anchors: fast
   half-life ≈ the Gazette cadence (120 sim-s), slow ≈ 4–6× that — orderings, not measurements;
   the harness takes the numbers.
3. **Hysteresis on every crossing flag.** Any boolean fired by a threshold (`_ruined`,
   `_slandered`, `_retired`, every new one below) clears when the value recovers past a
   `recoverFrac` band, so fall–recover–fall-again arcs can fire more than once per lifetime.
4. **Crossings carry reasons.** A probe that fires on "goal popped" or "value dropped" must
   record *why* (satisfied/expired; robbed/spent) — the classification-site discipline that has
   now bitten docs 11 and 12 once each.
5. **Pair state is sparse.** Pairwise values exist only for pairs that have actually interacted
   (folded on their events), capped with LRU-by-last-event. Never a full N² matrix.
6. **Every value names its probe.** A signal with no trope in its last column doesn't ship.

---

## 2. Family A — trajectory & reversal (per-agent, [T] unless noted)

| signal | shape | write site | probes / tropes |
| --- | --- | --- | --- |
| `goldFast` / `goldSlow` | two EWMAs of gold | fold on conserved transfers (resolver `take`/`pay`/`deliverTo`) — not per tick | rise/fall/reversal detection; replaces `_statusHigh.gold` |
| `standingFast/Slow` | EWMAs of roster mean standing toward the agent | the observer pass (already computes the mean for §5) | Fall-from-Grace's social half; Ruinous-Rumor's slope |
| `fortuneReversals` | count + timestamps of (fast−slow) sign flips past a gate | derived at the observer pass when the flip is noticed | "the agent whose life keeps turning" — protagonist pressure (F.28); rags↔ruin chaining |
| `lossReason` ring | last K downward gold steps tagged `robbed/spent/fined/gifted` | the same transfer fold (the resolver knows which verb moved it) | rule 4 for RUIN: ruin requires involuntary tags dominating the fall |
| `streak[key]` | consecutive same-status outcomes per watched strategy | fold on `PLAN_OUTCOME` (doc 11) | "third failed heist in a row" — desperation beat before the burn cap is even near |
| `timeInBand` | sim-time spent in poverty / wealth / outlaw bands | band edges checked at the same folds | endurance stories ("the long winter"); rags arcs need *duration*, not just crossings |
| `displacement` | EWMA of distance from home/claimed bed | fold on arrival events (`goto` completes) | exile detection (high displacement + low standing); the wanderer; homecoming beats |

## 3. Family B — relational structure (pairwise, sparse)

| signal | shape | write site | probes / tropes |
| --- | --- | --- | --- |
| `grievance(a,b)` **[T]** | signed blow ledger: rounds, last-blow-by, mean inter-blow interval | the combat/witness fold that already appends vendetta rounds (12 §3.5) | escalation slope (intervals shrinking = feud accelerating → Gazette urgency); **one-sidedness** (all blows one direction = persecution, not feud — a different trope) |
| `debt(a,b)` net | sum over the obligations ledger | obligation add/settle/default sites | large unpaid debt + cooling standing = betrayal setup; default cascades (D.21) |
| `regardGap(a,b)` **[B]×2** | standing(a→b) − standing(b→a), computed lazily for interacting pairs | folded when either side's standing updates | unrequited regard — romance fuel and betrayal fuel are the same number with different signs |
| `dependence(a)` | share of a's positive-standing mass concentrated on one other agent | folded on standing updates, top-1 tracked | "everything rides on one person" — grief/devastation setup when that one dies (the probe pre-casts the mourner) |
| `triangle hints` **[T]** | shared third parties across open arcs' principals + `_courtingId` + avenge targets | computed at arc open/append only (tiny sets) | rivalry detection: two suitors, two avengers, master-and-two-students — staged collision probes |
| `snubsFelt(a)` **[B own-state]** | counter of *perceived* cold treatment: refused trades, failed asks, overheard gossip-about-self | the market refusal site, ask failures, gossip delivery when subject==listener | **the legitimate input for `slandered`** (review finding 1): the beat stays omniscient, the memory write fires off this perceivable-evidence counter instead of the true roster mean |

## 4. Family C — belief–truth divergence: dramatic irony, quantified ([T] by construction)

The omniscient layer's unique privilege: it can read a belief *and* the truth it's about, and the
gap between them **is** dramatic irony. No agent can compute these; no cognition path may read
them; they exist to let the narrator notice the stories the town itself cannot see. All are
computed only over *active* objects (current plan targets, open arcs, fresh deeds) — bounded by
construction.

| signal | the gap measured | write site | probes / tropes |
| --- | --- | --- | --- |
| `doomedVenture(a)` | a's active plan's believed target state vs truth (cache relocated, mark dead, captive already freed, foe disbanded) | checked when a plan *commits* (one comparison at plan-pop, not per tick) | "marching on a ghost" — the narrator can foreshadow the wasted raid the moment it departs; pairs with 11's `waste`/`shortfall` for the payoff beat |
| `misallocatedSuspicion(deed)` | suspicion mass pointing at X for a deed truly done by Y | folded when `witnessDeed`/gossip writes suspicion (the deed record knows its true actor) | **the emergent Innocent-Accused** — doc 12 §4 can author `falseWitness`; this detects it arising naturally, which is the better story |
| `secretExposure(a, deed)` | count of agents holding a `Believes` record of a's secret vs a's own belief about who knows | folded on gossip spread of `Secret` topics | "everyone knows but him"; blackmail-pressure index for the blackmail feature when it lands |
| `presumedDead(a)` | k agents believe a dead/gone while a lives | folded on death-rumour gossip + whereabouts staleness | return-of-the-presumed-dead; the inheritance dispute that shouldn't have started |
| `esteemTruthGap(a)` | town's mean standing/`believedWealth` toward a vs a's true deed ledger (E.22) and true gold | observer pass, over agents with fresh deeds only | the **celebrated villain** and the **unsung hero** — both directions are tropes; also the outlaw arc's `celebrated` close condition read honestly |
| `loversCrossed(a,b)` | each of a courting pair believes something false about the other (dead, faithless, departed) | folded when a belief about the partner diverges from truth at gossip/perception write | the Romeo-misinformation beat — the narrator knows the tragedy is avoidable, which is what makes it one |

## 5. Family D — town climate (world pass, one pass, cheap aggregates)

| signal | shape | write site | probes / tropes |
| --- | --- | --- | --- |
| `wealthGini` + velocity | concentration of gold + its trend | the observer pass over the roster (it already walks it) | unrest setting; "one house holds half the town" → the baron/miser era |
| `suspicionClimate` | total suspicion mass + concentration (top-1 share) | folded on suspicion writes | diffuse fear (everyone suspects everyone) vs a *named* villain era — different Gazette voices |
| `scarcity[good]` | price deviation from long-run mean per good | `marketClear` | famine/glut arcs; with 11's herding, the boom-bust strategy cycle becomes *narratable* |
| `peaceClock` | sim-time since last townsfolk death by violence | the combat death fold | "the first killing since midwinter" — a beat the chronicle can only write if something counts the quiet |
| `cohesion` | mean in-town standing vs toward outsiders; cross-cluster negative-edge share over arc principals | observer pass, principals-only (bounded) | factionalisation: when the town splits into two camps, the civil-strife arc opens itself |
| `creditLoad` | active obligations count + default-rate EWMA | obligation add/settle/default | a credit crisis arc; the moneylender protagonist |

## 6. Family E — biography accumulators (per-agent, [T], fold-on-event)

| signal | shape | write site | probes / tropes |
| --- | --- | --- | --- |
| `deedLedger(a)` | counts + first/last timestamps by tag (thefts, kills, rescues, gifts, frees) | the deed/witness fold (truth side of `witnessDeed`) | feeds `esteemTruthGap`; epithet generation ("thrice a rescuer"); the Gazette obituary writes itself |
| `oaths(a)` | narrative-weight goals (avenge/repay/court/rescue) with **pop reason** recorded | `deriveGoals` push + `pruneGoals` pop (rule 4) — and a hunt that pops via mere belief decay (`believedDead` with no `_slain` stamp: the quarry was *forgotten*, not slain) resolves `'abandoned'`, never `'kept'` | kept-vs-abandoned ratio: "a man of his word" / "the faithless" — character as a measured quantity |
| `perilsSurvived(a)` | count of `peril` outcomes + combat flees below a health fraction | `PLAN_OUTCOME` peril + the flee fold | "nine lives"; feeds burnedVeteran open and the veteran's Gazette colour |
| `firsts(a)` | timestamps of first kill / theft / love / threshold-crossing | the respective folds, genuinely one-shot (no hysteresis needed here) | biography beats; the corruption arc measured from `firstTheft` onward |
| `outOfCharacterActs(a)` | count of acts taken only because widen/desperation crossed the agent's own disposition gate | the gate-crossing site (lands with the conscience-cost feature; the counter is specced now) | the *fall* arc's fuel gauge — and the atonement arc's debt, before moral regret even ships |

## 7. Family F — probe metadata (support, [T])

| signal | shape | write site | probes / tropes |
| --- | --- | --- | --- |
| `witnessSet(event)` | who saw each dramatic event (short-retention ring) | already implicit in `witnessDeed`; retained briefly | casting: the confidant, the lone witness, the unreliable narrator |
| `rumourDepth(topic)` | provenance-chain length of a spreading rumour | the gossip fold (provenance exists) | distortion index — "by the third telling, the theft was a murder"; Ruinous-Rumor's mechanism made visible |
| `arcLoad(a)` | open arcs sharing a as principal | computed at arc open (the registry knows) | protagonist pressure: the Director can pile on (compound drama) or deliberately spotlight the quiet (next row) |
| `quietIndex(a)` | sim-time since a last appeared in any beat | chronicle write fold | the forgotten man; fresh-protagonist casting so the spotlight rotates |

---

## 8. Priority cut — what to build first, and why

Ordered by (probe value × cheapness), respecting doc 12's roadmap:

1. **`snubsFelt`** (B) — it is the *fix* for review finding 1, not just a signal: `slandered`'s
   memory write moves onto it immediately. Smallest item in the catalog.
2. **`goldFast/Slow` + `lossReason`** (A) — replaces `_statusHigh` and fixes finding 3 before the
   status sensor ships wrong. The transfer fold is one site (the resolver).
3. **`oaths` with pop reasons** (E) — rule 4 made mandatory; it is also the vendetta-close fix
   (finding 2) wearing a general hat: once pops carry reasons, every arc-close hook reads them.
4. **`doomedVenture` + `misallocatedSuspicion`** (C) — the two cheapest irony probes (one
   comparison at plan-commit; one fold at suspicion-write), and the two best new tropes: the
   foreshadowed wasted raid and the emergent innocent-accused.
5. **`grievance` slope/one-sidedness** (B) — upgrades the vendetta arc from "rounds exist" to
   "the feud is *accelerating*," which is what the Gazette's urgency should key on.
6. **`peaceClock` + `scarcity`** (D) — two trivially cheap town-pulse values that give the
   chronicle its connective tissue ("amid the grain shortage, the first killing since…").
7. **`esteemTruthGap` + `deedLedger`** (C+E together) — lands with doc 12 step 4
   (`believedWealth`), since the gap needs both sides.
8. Everything else opportunistically, each behind its named fold.

## 9. The anti-catalog — what NOT to track

- **Full pairwise matrices** of anything (rule 5). Sparse, event-folded, LRU'd.
- **Per-tick scans** for any value above; if a signal can't name an existing fold site, it waits
  for one.
- **A global "drama score."** Composite scalars hide their reasons; probes read named signals so
  the Gazette can say *why*.
- **Any [T] value wired into cognition** without first passing through a belief or own-state
  channel — the §10 whitelist test from the doc-12 review is the enforcement; this catalog's
  scope tags are its input.
- **Mood/emotion scalars duplicating standing.** Standing, suspicion, notoriety, believedWealth,
  and the experience store already carry the affect this sim runs on; a parallel "happiness"
  float would be a second source of truth with no write discipline.

## 10. Tests (sketch)

One suite gate per family exemplar, house pattern (toggle preconditions, restore in `finally`):

```
S1 transfer fold      — a robbery vs an equal-size purchase: same goldFast drop, DIFFERENT
                        lossReason mix; RUIN fires only on the robbery (finding-3 regression)
S2 hysteresis         — ruin → recover past recoverFrac → fall again ⇒ fires twice (rule 3)
S3 pop reasons        — an expired avenge ≠ a satisfied avenge in oaths AND in the vendetta
                        close outcome (finding-2 regression)
S4 snubsFelt feeds    — true mean standing collapses with ZERO perceivable snubs ⇒ beat fires,
                        slandered memory does NOT; three refused trades ⇒ memory fires (finding-1)
S5 irony bounds       — doomedVenture computed exactly once per plan commit; no irony value is
                        readable from any cognition pass (FOREIGN_DEREF extension / whitelist)
S6 sparsity           — grievance map capped; non-interacting pairs absent; LRU eviction observed
```
