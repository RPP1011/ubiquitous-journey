# 12 (LLD) — Narrative tooling: emergent-arc detection & per-agent authoring

> **Status: low-level design.** Companion to [`10-action-grammar-lld.md`](10-action-grammar-lld.md)
> and [`11-outcome-conditioned-caution-lld.md`](11-outcome-conditioned-caution-lld.md). Read those
> first — this doc reuses their vocabulary (the action grammar, the conserved resolver, the
> experience/obligation pure-helper store pattern, the three registries).
>
> The three hard invariants of [10-LLD] apply unchanged, and this feature restates them in §10:
> - **The epistemic split** ([02](02-epistemic-split.md)) governs **NPC cognition** — what an agent
>   reads to make a *decision*. It does **not** constrain the narrator. **Detection probes** (the arc
>   registry, the status-delta sensor) belong to the **omniscient observer layer**, exactly like the
>   Director — *the Director is not an NPC; it reads ground truth across the whole roster.* Probes
>   need not live inside any agent: they observe the true world and feed the chronicle/Gazette
>   (display), never an agent's decision. The split bites only on reads that **drive behaviour** — so
>   the one new field that feeds NPC *esteem*, `believedWealth`, IS belief-scoped (written by a
>   visible-cue bridge, read in cognition) precisely because it changes what agents do; the sensors
>   that merely *record* a story do not.
> - **Verbs are data** ([10-LLD §7](10-action-grammar-lld.md#7-verbs-are-data--the-three-registries)):
>   the one new executor (`assault`) and the one new deriver (`romance`) register as registry rows
>   from their own feature files; no shared `switch` is edited.
> - **The freeze lesson:** the arc registry is a bounded store with lazy-decayed expiry, every
>   open/append/close call independently guarded, never throwing on the tick; every new sensor is a
>   guarded write-only emit.
>
> **The one-line summary:** a generic **arc/saga registry** (the spine — any emergent loop opens an
> arc, appends beats, and closes it with an outcome, surfaced to chronicle/Gazette and assertable in
> tests), plus six smaller tools that either **set up** a targeted condition (the authoring layer,
> the romance deriver, the assault executor, the outlaw-warming hook) or **detect/read** the story
> (the status-delta sensor, the believed-wealth recognition channel) — and surface their beats
> *through the registry*.
>
> **Gating discipline (current direction).** Per the in-flight refactor removing the day-one-OFF
> flags, this feature is **gated by branch, not by `enabled:false`**. Nothing here ships behind a new
> dormant flag; each step merges live when its suite is green. (The roadmap §13 is the merge order.)

---

## 1. What gap this fills — the two axes

A 15-agent narrative evaluation found the sim **strong at STAGING drama, weak in two places**:

- **(A) DETECTION of EMERGENT arcs.** The sim has rich *point-event* sensors — chronicle `BEAT`s
  (`chronicle.ts:BEAT`), the RPG `ActionEvent` bus (`rpg/events.ts`), belief deltas — but nothing
  rolls them up into a *"this trope completed"* record. The **only** clean completed-arc marker is
  the Director's `_recordSaga`/`sagaKind` (`director/arcs.ts:_recordSaga`, surfaced by
  `gazette.ts:sagaArticle` and read off `sim.director._sagas`), which fires **only for
  director-AUTHORED arcs** (`reckoning`/`tyrantFall`/`spyWeb`/`romance`/`accused` + the role sagas
  `avenger`/`grateful`/`protege`/`legend`). An emergent vendetta the *agents themselves* run
  (assaulted → `avenge` memory → goal → kill, `motivation.ts:deriveGoals`) leaves chronicle beats
  but **no saga** — the story happened and nothing recorded that it *completed*.
- **(B) AUTHORING SPECIFICITY.** You can guarantee a trope-shaped event *occurs* but cannot aim it
  at a chosen protagonist/pair. Targeting is `_shuffle` roulette (`director/arcs.ts:_stepTyrantFall`,
  `_stepAccused` both pick victims via `d._shuffle(...).slice(...)`); `seeding.ts` authors **only**
  the rival-apprentices trio (`seedRivalApprentices`). There is no API to pin "make *this* agent the
  protagonist of a betrayal aimed at *that* one."

Keep these two **axes** explicit throughout this doc — they are different kinds of tool and a
reader should always know which they're looking at:

| axis | what it does | tools in this doc |
| --- | --- | --- |
| **SET UP** | establish a condition / aim a trope at a chosen agent | §4 authoring layer · §7 assault executor · §8 romance deriver · §9 outlaw-warming |
| **DETECT / READ** | observe & record that a story happened | §3 arc registry (the spine) · §5 status-delta sensor · §6 believed-wealth channel |

The **arc registry (§3) is the keystone of the DETECT axis** and the highest-leverage tool — every
other DETECT tool surfaces its beats *through* it, and several SET-UP tools open arcs through it too.
It is designed first and in the most depth.

---

## 2. Module map

| file | layer | responsibility |
| --- | --- | --- |
| `js/sim/arcs.ts` **(NEW)** | both | **the spine.** Pure-helper store math (the `obligations.ts`/`experience.ts` pattern): the `Arc` record + `openArc` / `appendBeat` / `closeArc` / `findArc` / `arcKey` / lazy-expiry sweep. No tick wiring of its own; constructed once as `sim.sagas` (the shared completed-arc ledger, generalising `director._sagas`). |
| `js/sim/simulation.ts` | execution | constructs `this.sagas = new SagaStore(this)` beside `this.chronicle`; exposes `ctx.openArc/appendBeat/closeArc` on the cognition+full ctx so any pass/feature can reach the registry; the `assault` and recognition executors live on `ctx.resolver`. |
| `js/sim/chronicle.ts` | detect | new `BEAT.*` kinds (`RUIN`/`RETIRE`/`RISE`/`MUSTER`/`RESCUE`); `note(kind, subj, text, arc)` already threads an arc ref — arcs file their beats through it. The registry calls `chronicle.note` on open/close so the feed groups an emergent arc's chapters. |
| `js/sim/gazette.ts` | detect | `gatherDispatches` reads `sim.sagas.recentClosed()` **in addition to** `sim.director._sagas` (one extra source loop, beside the existing `const sagas = (sim.director && sim.director._sagas)`); `sagaArticle` gains rows for the new emergent `sagaKind`s. |
| `js/sim/motivation.ts` *(or a new observer pass)* | detect | the **status-delta sensor** (`statusSensor`, a guarded **omniscient observer pass** — sibling of the chronicle/Director tick, NOT agent cognition; reads ground truth incl. the true roster mean-standing) emits `BEAT.RUIN`/`BEAT.SHUNNED`/`BEAT.RETIRE` off truth (narrator) but writes its `ruined`/`slandered`/`thwarted` memory episodes only off **own-state/perceivable-evidence** reads (§5 review 1: a fast involuntary gold fall, `snubsFelt`, the experience store — never the raw roster mean). The avenge/repay/rescue derivers gain **`openArc`/`appendBeat`/`closeArc` hooks** at their derive/closure sites. |
| `js/sim/memory.ts` | detect | three new episode kinds (`ruined`/`thwarted`/`slandered`) + their `memoryPhrase` rows. |
| `js/sim/beliefs.ts` | detect | the **`believedWealth`** field on `BeliefState` (value+conf, evidence-accrual) + `recordWealthCue` (the write path); read by the recognition channel. |
| `js/sim/agent/perception.ts` | detect | the truth-in/belief-out **wealth-cue bridge**: a *visible* trade / carried tool nudges `believedWealth` (like the `notoriety`/`captive` bridges already there). |
| `js/sim/agent/decide.ts` | detect | the **wealth→standing/notoriety recognition** read (a believed-rich, non-suspect local earns a small esteem nudge — belief only). |
| `js/sim/seeding.ts` | set up | the **per-agent authoring API** (`pin`, `forceBetrayal`, `falseWitness`, `starCross`, `captureTarget`) — pure functions that stamp personality/gold/role/ambition + plant the targeted relationship/belief constellation, then push an open arc + seed the relevant Director arc with **chosen principals** (not `_shuffle`). |
| `js/sim/director/tropes.ts`, `director/arcs.ts` | set up | the targeted trope variants accept an explicit `{a,b}` instead of rolling principals; `_recordSaga` is re-pointed to (or mirrored into) the shared `sim.sagas`. |
| `js/sim/features/romance.ts` **(NEW)** | both | the **romance goal-deriver** + a `STEER_FILLS['court']` fill keyed on `_courtingId`, so Star-Crossed is *enacted* (the lovers seek each other) not only narrated. |
| `js/sim/features/recruiter.ts` | both | the **`assault` executor** + a `goalAssault` follow-through closing `goalMuster` (march the mustered band on the believed-strong foe); reads `believedWealth`/notoriety for "infamy draws a following". |
| `js/sim/features/affect.ts` | both | the rescue deriver gains a **clear-the-guards subgoal** (the captor in reach is `attack`ed before `free`) so the rescue resolves; opens/closes a `rescue` arc. |
| `js/sim/combatEvents.ts` | detect | `witnessDeed`/the LEGEND block **generalised from player-only to any actor** so an NPC outlaw accrues town-read `notoriety` (belief), feeding the outlaw-warming hook. |
| `types/agent.ts`, `types/beliefs.ts`, `types/sim.ts` | types | `Arc`/`SagaStore` shapes, `believedWealth` on `BeliefState`, the new memory-episode kinds, `_courtingId` reaching the agent's cognition fields. |
| `test/suites/arcs.mjs` **(NEW)** + additions to `memoryGoals`/`recruit`/`affect`/`urchin` | test | the arc-lifecycle gate + the per-tool sensors. |

### Where each piece runs in the tick

The cognition passes (per agent, `SIM.tickHz`) and world passes (`simulation.ts:update`) are:

```
perceive → beliefs.decay → gossip → reason → deriveGoals → decide → market → progression → memory
   │(wealth-cue bridge)              │(arc open hooks on    │(wealth recognition read)
   │                                 │ avenge/rescue/muster) │
WORLD passes (after the per-agent loop):
   … groups.tick … director.tick (arcs advance; targeted tropes) … lineage.tick (_surpass)
   … chronicle.tick … sagas.sweep()  ← NEW: expire stale-open arcs, age out closed ones
act(dt) [every frame]: execPlanStep → assault/free/court executors; status-delta crossing checked
                                       at goal-closure / pruneGoals (own-state)
```

The registry has **no heavy per-tick pass** — `sagas.sweep()` is a bounded lazy-expiry sweep
(drops arcs whose `expiry` passed unclosed, ages out the closed ring), self-throttled like
`chronicle.tick`. Arc lifecycle calls (`openArc`/`appendBeat`/`closeArc`) happen at the **emergent
loop's own existing event sites**, not on a scan.

---

## 3. The arc/saga registry — THE SPINE

### 3.1 What it generalises

`director/arcs.ts:_recordSaga` is the existing completed-arc record, but it has three limits this
registry removes:

1. **It only files at the END** — `_recordSaga({sagaKind, key, …})` pushes one flat record onto
   `d._sagas` when a director arc climaxes. There is no *open → escalate → close* lifecycle an
   emergent loop can hook into across many ticks; the director arcs track their own ad-hoc `stage`
   on the arc object (`arc.stage`, `arc.nextAt`).
2. **It lives on the Director** (`d._sagas`), so an emergent loop with no Director involvement (an
   agent's own assaulted→avenge→kill) has nowhere to file.
3. **No beat trail** — a saga is a flat retrospective; it cannot say "round 2 of this vendetta."

The registry is the **generic version of `_recordSaga`'s record**, with a lifecycle and a beat
trail, owned by the Simulation (not the Director), that **any** emergent loop opens/appends/closes —
and into which the Director's `_recordSaga` is folded (one shared completed-arc ledger the Gazette
already half-reads).

### 3.2 The data structure (`js/sim/arcs.ts`, pure helpers)

```ts
// One open-or-closed emergent arc. The belief-table shape (id / time / bounded trail), mirroring
// experience.ts/obligations.ts: a pure record + pure helpers, no behaviour of its own.
interface Arc {
  arcId: number;            // monotonic, assigned at open (stable identity for chronicle/Gazette threading)
  kind: string;             // 'vendetta'|'ragsToRiches'|'warband'|'rescue'|'burnedVeteran'|'dynasty'|'outlaw'|<director kinds>
  key: string;              // the DEDUP identity (§3.4) — so two loops don't double-open one vendetta
  principals: EntityId[];   // the agents the arc is ABOUT (1–4); read for naming + dissolve-on-death
  beats: ArcBeat[];         // bounded trail (cap ARCS.maxBeats); each {t, tag, text}
  rounds: number;           // escalation count (vendetta rounds, rags accrual steps, muster waves)
  openedAt: number;         // sim-time opened
  closedAt: number | null;  // null while open
  outcome: string | null;   // null while open; on close: 'fulfilled'|'thwarted'|'ruined'|'reconciled'|'died'|…
  expiry: number;           // open-arc TTL — swept closed('lapsed') if never resolved (freeze backstop)
  meta?: Record<string, unknown>;  // arc-kind extras the Gazette reads (trade, house pair, haul, …)
}
interface ArcBeat { t: number; tag: string; text: string; }

// agent-agnostic store, constructed once as sim.sagas.
class SagaStore {
  _open: Map<string, Arc>;   // key -> open arc (dedup + fast find); bounded ARCS.maxOpen (oldest-opened dropped)
  _closed: Arc[];            // ring of completed arcs (cap ARCS.maxClosed) — what the Gazette/UI read
  _seq: number;
}
```

> **Why `principals[]` not a fixed `(a,b)`:** the named loops range from 1 principal (rags-to-riches,
> burned-veteran retire) to 2 (vendetta, rescue, dynasty surpass) to many (warband muster). A small
> bounded array covers all; naming/dissolve iterate it.

### 3.3 The lifecycle — open → append → close

Three pure helpers + a sweep, all guarded, mirroring `obligations.ts`:

```
openArc(store, { kind, key, principals, text, expiry, meta }) -> Arc:
  if store._open.has(key): return store._open.get(key)          // IDEMPOTENT — re-open is a no-op (dedup)
  prior = lastClosed(store, key)                                // re-ignition: most recent CLOSED arc on this key
  arc = { arcId: ++store._seq, kind, key, principals, beats: [], rounds: 0,
          openedAt: now, closedAt: null, outcome: null, expiry: now + (expiry ?? ARCS.openTtl),
          meta: { ...meta, parentArcId: prior ? prior.arcId : undefined } }   // "the feud rekindles" — see §3.4
  store._open.set(key, arc); enforceMaxOpen(store, arc)        // bounded — evicts an INCUMBENT via close, never the
  if text: appendBeat(arc, 'open', text)                        //   just-opened arc itself (review 2: a new story
  return arc                                                    //   always gets a seat; the weakest incumbent yields)

appendBeat(arc, tag, text) -> void:                            // an ESCALATION chapter
  if !arc || arc.closedAt != null: return
  arc.beats.push({ t: now, tag, text }); arc.rounds += (tag === 'round' ? 1 : 0)
  if tag === 'round': arc.expiry = now + ARCS.openTtl           // each fresh blow RE-ARMS the TTL (review 2: a
                                                               //   slow feud must outlive an open-and-shut one)
  if tag === 'round' && now - (arc._lastNote ?? -Infinity) >= ARCS.roundNoteGap:
    arc._lastNote = now                                          // mark eligible; the store's wired chronicle hook
                                                               //   (see "surfacing", below) files a THROTTLED note
  while arc.beats.length > ARCS.maxBeats: arc.beats.shift()     // bounded trail

enforceMaxOpen(store, justOpened?) -> void:                     // review 4: evict via CLOSE, never an oldest-opened drop
  while store._open.size > ARCS.maxOpen:
    victim = argmin over store._open EXCLUDING justOpened of (arc.rounds, arc.expiry)  // fewest-rounds, then
                                                               //   nearest-expiry; never the longest-running arc
                                                               //   (the generational vendetta), never the newborn
    closeArc(store, victim.key, 'crowded_out')                 // UNCONDITIONAL close — always shrinks _open (finding 1)

closeArc(store, key, outcome, text?) -> Arc | null:           // the CLIMAX/RESOLUTION chapter
  arc = store._open.get(key); if !arc: return null
  arc.closedAt = now; arc.outcome = outcome
  if text: arc.beats.push({ t: now, tag: 'close', text })
  store._open.delete(key)
  arc.sig = `arc:${arc.kind}:${arc.key}:${floor(now)}`          // the Gazette dedup sig (matches _recordSaga's)
  store._closed.push(arc); while store._closed.length > ARCS.maxClosed: store._closed.shift()
  return arc

findArc(store, key) -> Arc | null     // for a loop to test "already open?" / append a round
sweep(store, now) -> void:            // self-throttled world pass (sim.sagas.sweep)
  for [key, arc] of store._open: if now >= arc.expiry: closeArc(store, key, 'lapsed')   // dissolve gracefully
```

Every call site wraps in the store's own try/catch (never throws on the tick). The surface is
deliberately the **same shape** the codebase already trusts (`addObligation`/`settleObligations`,
`recordBurn`/`feltSurcharge`): a small pure module a feature wires in.

**Chronicle/Gazette surfacing.** `openArc` and `closeArc` call `sim.chronicle.note(beatKind,
principal, text, { id: arc.arcId, title: ARC_TITLE[arc.kind] })` — `chronicle.note` already accepts
that arc ref and threads chapters in the feed (`chronicle.ts:_push`, the `arcId`/`arcTitle` fields).
**Round beats also file — throttled** (`appendBeat`, one note per `ARCS.roundNoteGap` sim-s per arc):
without the middle chapters the feed shows an open and a close with a silent gap where the escalation
was (errata). The throttle keeps a fast feud from spamming the chronicle while still showing it climb.
`gazette.ts:gatherDispatches` reads `sim.sagas.recentClosed()` (fresh closed arcs, same `t<120` /
`sig` cooldown as the director-saga loop at `gatherDispatches`'s `const sagas` block), and
`sagaArticle` gains a row per emergent `kind`. The
Director's `_recordSaga` is re-pointed to `closeArc(sim.sagas, …)` (or mirrored), so **one ledger**
holds both authored and emergent completed arcs and the Gazette reads one source.

### 3.4 Keying — the load-bearing dedup

The keying is what stops two emergent loops double-opening the same arc (e.g. both witnesses of a
murder opening a vendetta about the same killer). The rule: **`key` is the canonical identity of the
story, order-normalised, NOT the actor who happened to trigger it.**

| arc kind | `key` | why |
| --- | --- | --- |
| `vendetta` | `vendetta:${min(avenger,target)}:${max(avenger,target)}` | one feud per *ordered pair*; either party's avenge derive opens the same arc; a second witness re-opens idempotently. Append a `round` beat per fresh blow between them. |
| `rescue` | `rescue:${captiveId}` | keyed on the **victim**, not the rescuer — many would-be rescuers, one rescue arc; whoever frees closes it. |
| `ragsToRiches` | `rags:${agentId}` | one accrual arc per climber; rounds = wealth-threshold crossings. |
| `warband` | `warband:${leaderId}` | one muster per leader. |
| `burnedVeteran` | `burned:${agentId}` | one retire/relapse arc per veteran. |
| `dynasty` | `dynasty:${houseId}` | one depth arc per house (`_surpass`/lineage feeds rounds). |
| `outlaw` | `outlaw:${agentId}` | one infamy arc per rising outlaw. |

`arcKey(kind, ...ids)` sorts the id list for symmetric kinds (vendetta) and leaves asymmetric ones
(rescue keyed on victim) as authored. Because `openArc` is idempotent on `key`, the **first** loop to
witness the condition opens; everyone after either no-ops or appends a beat/round.

**Re-ignition is a NEW arc with a back-link, not a reopen.** Once an arc closes, its `key` leaves
`_open`, so a later condition on the same pair opens a *fresh* arc (new `arcId`, `rounds` reset to 0 —
correct: this is a new chapter of the story, not a continuation of the old count). `openArc` stamps
`meta.parentArcId` = the most recent closed arc on that key (`lastClosed`), so the Gazette can say
"the feud between them rekindles" and a future query can walk the chain. One field now, no migration
later (erratum). The back-link is **display-only** metadata — never read by cognition.

### 3.5 How each named emergent loop hooks in (cite file:symbol)

These are the loops the eval named; each gets **3 lines** (open at the derive site, append at the
escalation, close at the closure) — no new behaviour, just the registry calls beside existing code.

| loop | OPEN (site) | APPEND round (site) | CLOSE (site, outcome) | converts |
| --- | --- | --- | --- | --- |
| **Vendetta** | `motivation.ts:deriveGoals` — when an `assaulted` (or `witnessed_death`) episode pushes `goalAvenge(withId)`, `openArc({kind:'vendetta', key:arcKey('vendetta',a.id,withId), principals:[a.id,withId]})`. | each retaliatory blow between the pair: `combatEvents.ts:onCombatEvents` (the `dead`/`attacked` fold) appends a `round` (which **re-arms `expiry`**, §3.3) when actor+target are an open vendetta pair. | the avenge-goal pop **carries its reason** (§3.5a): a *satisfied* pop (the kill landed) → `closeArc(key,'fulfilled')`; an *expired* pop does **not** close — it leaves the arc for `sweep` → `lapsed`. | partial→**full** (emergent vendettas now produce a closed saga, not just beats) |
| **Rags-to-Riches** | the wealth ambition (`motivation.ts:AMBITIONS.wealth`) crossing its first threshold, OR the urchin/trade gold climbing past `RAGS.openGold`: open in `updateAmbition`. | each `RAGS.stepGold` crossing appends a `round` ("doubled their purse"). | the believed-wealth **recognition** (§6) crossing a **deference-mass** bar (count of perceivers warmed past a bar, or summed `believedWealth` mass — NOT net mean standing, §6) → `closeArc('celebrated')`; or `ruined` (§5) → `closeArc('ruined')`. | partial→**full** (the closing "town esteems them for being rich" beat needs §6) |
| **Warband muster** | `recruiter.ts` muster deriver pushing `goalMuster` → `openArc({kind:'warband', key:'warband:'+a.id, principals:[a.id]})`. | each `joinWarband` success (`groups.ts:joinWarband`) appends a `round` ("N now ride with them"); the march itself files a round (it is the story's beginning, NOT its outcome). | the battle's resolution: the leader's assault-goal pop on a **genuine kill** (`_slain`-stamped, `pruneGoals`) → `closeArc('victorious')`; the leader falling (combat bridge) → `closeArc('routed')`; a quarry that slips away (belief faded) leaves the arc to `sweep` → `lapsed`. | **full** |
| **Rescue** | `affect.ts` rescue deriver pushing `goalFree(captiveId)` → `openArc({kind:'rescue', key:'rescue:'+captiveId, principals:[a.id, captiveId]})`. | the clear-the-guards subgoal (§7) striking the captor appends a `round`. | the freed captive's perception dropping `b.captive` (the `goalFree` predicate, `affect.ts`) → `closeArc('freed')`; captive dies → `closeArc('died')`. | partial→**full** (rescue currently wanders; §7's guard-clear makes it resolve) |
| **Burned-Veteran retire/relapse** | the experience store (`experience.ts`) — when `feltSurcharge('burgle'|'rob')` first crosses `BURNED.retireSurcharge` (a thief who's been burned enough to stop), `openArc({kind:'burnedVeteran', key:'burned:'+a.id, principals:[a.id]})`; the status-delta sensor (§5) is the natural trigger. | a relapse (a fresh theft after the burn) appends a `round`. | the surcharge decaying back below threshold → `closeArc('reformed')`; a relapse-and-thrive → `closeArc('relapsed')`. | partial→**full** (needs §5 to observe the retire crossing) |
| **Dynasty depth** | `lineage.ts:_surpass` first surpass within a house → `openArc({kind:'dynasty', key:'dynasty:'+houseId, principals:[student,master]})`. | each further surpass / mentorship in the line appends a `round`. | the house reaching `DYNASTY.depth` generations → `closeArc('established')`. | partial (a structural depth metric exists in `depthMetrics.ts`); arc makes it legible |
| **Outlaw rise** | the generalised NPC `notoriety` (§9) crossing `OUTLAW.dreadAt` → `openArc({kind:'outlaw', key:'outlaw:'+a.id, principals:[a.id]})`. | each new robbery the town witnesses appends a `round`; a recruited follower (warming hook, §9) appends "a following gathers". | caught/killed by the Watch → `closeArc('brought_down')`; survives to `OUTLAW.legendAt` → `closeArc('celebrated')`. | partial→**full** (needs §9: NPC notoriety + RECRUIT reading it) |

### 3.5a Close hooks read the POP REASON — the §11 waste bug in a new costume

`pruneGoals` pops a goal for two opposite reasons — **satisfied** (the goal's predicate came true)
and **expired** (it timed out / went unreachable) — and the as-built pop site already distinguishes
them (it is the same classification `cautionWaste` keys on in [11-LLD §4.4]). **Every arc-close hook
must read that reason**, or a grudge that quietly cools closes its saga as `'fulfilled'` and the
Gazette reports a vengeance that never happened (review 2). The rule, stated once for all closers:

- **satisfied → the success outcome** (`fulfilled`/`freed`/`victorious`/`celebrated`) — and for the
  hunt goals (avenge/assault) *satisfied* means a **genuine `_slain`-stamped kill**: `believedDead`
  is also true when the belief merely decayed away, and a quarry forgotten is an oath `'abandoned'`
  and an arc left to lapse, never a success (forgetting is not vengeance).
- **expired → do NOT close on the pop.** Leave the arc open; `sweep` closes it `'lapsed'` once
  `expiry` passes. (Combined with the `appendBeat`→`expiry` re-arm, a feud with fresh blows stays
  open; only a feud that has actually gone quiet for `openTtl` lapses.)

**The mutual-feud guard lives in the VENDETTA HOOK, not in `closeArc`.** Both parties of a symmetric
vendetta hold their own `goalAvenge` on the **same** key, so a satisfied pop on one side must not yank
the arc out from under the other's live pursuit. The guard belongs at the **satisfied-pop close hook**
(the vendetta wiring in `motivation.ts`), *not* inside the store: when A's avenge is satisfied, the
hook scans the principals for any still-alive avenge goal on the key; if one survives it **appends a
`round`** ("one score is settled; the other still burns") and does **not** call `closeArc`; only the
last principal's satisfied pop calls `closeArc(key,'fulfilled')`.

> **`closeArc` stays UNCONDITIONAL — this is load-bearing (review 1).** Putting the counterpart scan
> inside `closeArc` would (a) drift the store from pure ledger to cognition-reading behaviour-haver,
> and (b) **livelock the eviction/sweep fixes**: `enforceMaxOpen`'s `while size > maxOpen` loop and
> `sweep`'s lapse both call `closeArc` to *guarantee* `_open` shrinks; a `closeArc` that can decline
> (append a round instead) never shrinks the map, so the loop re-picks forever and the freeze backstop
> is defeated. So `closeArc` always closes. The general lesson — **fixes live at call sites;
> primitives stay unconditional** — is the revision-cycle twin of the pop-reason discipline above and
> is restated in §10. (The pop-reason rule got this right — the hook reads the reason, `pruneGoals`
> stays generic; an earlier draft of *this* guard got it wrong by absorbing the caller's logic into
> the store.)

### 3.6 Becoming assertable in tests

`test/suites/arcs.mjs` drives the registry directly and through the frame loop:

```
A1 open is idempotent      — openArc twice on one key → one arc, same arcId
A2 append/close lifecycle  — appendBeat grows rounds; closeArc sets outcome+closedAt, moves to _closed
A3 keying dedup            — two witnesses' avenge derives → ONE vendetta arc (symmetric key)
A4 lapsed sweep            — an open arc past expiry → swept closed('lapsed'); bounded _open/_closed
A5 emergent vendetta (E2E) — a frame-loop assault→avenge→kill produces a CLOSED 'vendetta' saga in sim.sagas
A6 gazette reads it        — sim.sagas.recentClosed() flows into _collectBriefs (a saga brief is emitted)
A7 director fold           — director _recordSaga lands in the SAME sim.sagas ledger
A8 eviction excludes self  — at maxOpen, openArc of a NEW arc evicts an INCUMBENT (fewest-rounds), never the
                             just-opened arc; the returned arc is OPEN (closedAt==null), the long vendetta survives (review 2)
A9 close is unconditional  — eviction AND sweep-lapse of a vendetta WITH a live counterpart goal still CLOSE
                             it (the store never declines); _open always shrinks — no livelock (review 1)
A10 mutual-feud at the hook — the satisfied-pop HOOK (not closeArc) appends 'one score settled' while a
                             counterpart avenge lives; only the last principal's pop closes 'fulfilled'.
                             An EXPIRED pop never closes 'fulfilled' (sweep lapses it). A fresh round re-arms expiry.
```

This is the deliverable the eval most wanted: an emergent arc is now an **assertable completed-arc
record**, not a guess from scattered beats.

---

## 4. Per-agent authoring / targeting layer (SET UP)

The gap: targeting is roulette. `seeding.ts` authors only the rival-apprentices trio; the Director's
targeted-ish tropes pick principals via `_shuffle` (`director/arcs.ts:_stepTyrantFall` /
`_stepAccused`). There is no way to pin a chosen protagonist and aim a trope at a chosen pair.

**The addition: an authoring API in `seeding.ts`** (pure functions, run at world build *or* callable
later from a scenario/test), each stamping the agent and planting the constellation, then opening the
matching arc + seeding the Director arc with **explicit principals**:

```
pin(sim, agentId, { personality?, gold?, role?, ambition?, house? }):
  // stamp the chosen fields onto an EXISTING agent (the protagonist), guarded.
  // personality writes the innate vector; gold a CONSERVED set (debit/credit a sink so the
  // closed-money-loop invariant holds — never a bare `a.gold = n`); ambition via assignAmbition.

forceBetrayal(sim, aId, bId):     // a trusts b, then b wrongs a
  warm(a→b) then plant a fresh wrong; openArc('vendetta', [a,b]); push a Director 'reckoning'
  arc with arc.wronged=a, arc.betrayer=b (the EXISTING _stepReckoning, given principals not rolled).
  // CONVENTION (load-bearing — standing is per-perceiver): warm(x→y) raises the standing HELD BY x
  // ABOUT y. "a trusts b" is therefore warm(a→b). Every site in this doc uses holder→subject; a
  // flipped arrow is exactly the kind of direction bug that passes typecheck and fails silently.

falseWitness(sim, victimId, accuserId?):   // brand an innocent
  plant suspicion on the victim into nearby townsfolk (reusing _plant); push a Director 'accused'
  arc with arc.b=victimId (chosen, not _shuffle); openArc('vendetta'|'slander', [victim]).
  // if accuserId is given, the planted suspicion CARRIES it as provenance (the _plant src field),
  // not discarded — so a future "false accuser exposed" arc can trace the slander to its author.

starCross(sim, aId, bId):          // aim Star-Crossed at a chosen pair
  set a._courtingId=b, b._courtingId=a; warm the pair; ensure a feud between their houses
  (seed one if absent); push a Director 'romance' arc with arc.a/arc.b chosen; openArc('romance').

captureTarget(sim, captiveId, captorId):   // stage a rescue
  set captive._held=true, _captorId=captor (the CAPTIVE bridge state) so a rescuer's perception
  bridges b.captive; openArc('rescue', [captor, captive]). The §7 rescue resolves it.
```

**Targeting the Director's tropes without rewriting them.** The targeted variants are thin: each
existing stepper (`_stepReckoning`, `_stepAccused`, `_stepRomance`) **already reads principals off
the arc object** (`arc.wronged`/`arc.betrayer`, `arc.b`, `arc.a`/`arc.b`). The only roulette is in
the **instigators** (`tropes.ts`) that *create* those arcs. So the authoring API skips the
instigator and **pushes a pre-targeted arc** directly onto `d._arcs` — the stepper then plays it to a
saga unchanged. The one edit to `tropes.ts`/`arcs.ts` is to let `_stepTyrantFall`/`_stepAccused`
prefer `arc.champion`/`arc.b` if present over the `_shuffle` pick (a `?? _shuffle(...)` fallback).

This unblocks **scripting a protagonist/pair** and makes the suite **deterministically testable**
(a test pins the pair, runs the loop, asserts the closed arc) — without a parallel authoring system.

---

## 5. Status-delta / failure sensor (DETECT)

The gap: the sim has no *downward*-crossing sensor. Ambition tracks upward progress
(`motivation.ts:AMBITIONS.*.progress`); nothing fires when an agent's fortunes **fall**. So
Fall-from-Grace, Burned-Veteran, and the tragic Ruinous-Rumor ending are invisible — the victim has
no first-person arc.

**The addition: `statusSensor(a, ctx)`** — a guarded **observer-layer probe** (a world-tick pass in
the omniscient layer, a sibling of the chronicle/Director pass — NOT agent cognition, so it reads
**ground truth** freely). It fires on a **downward crossing** — but read off **trend EWMAs, not a
running max** (review 3), and with **hysteresis** so a fall–recover–fall can fire more than once:

```
statusSensor(a, ctx):                                // OMNISCIENT probe; reads truth; guarded; never throws
  // TREND, not a running max (review 3). goldFast/goldSlow are the two EWMAs from catalog [13] §2,
  // folded on the resolver's CONSERVED transfers — NOT recomputed here. A relaxing baseline (the slow
  // average drifts down as you spend) means RUIN reads as a FAST FALL, never the spend-down of a
  // windfall: a looter who buys a home (gold-out) no longer files as fallen.
  meanStanding = mean over the roster of how each OTHER agent's belief regards a   // true average — omniscient, fine
  // TWO hysteresis helpers, deliberately NOT one (cosmetic review): a clear is relative to a moving
  // baseline in RUIN, to a fixed threshold in SHUNNED/SLANDERED/RETIRE. Distinct names + distinct
  // constants so the two are tuned independently and not mis-coupled.
  recovToBaseline(slow) = STATUS.recoverFracGold * slow         // ruin: recovered back up toward the (relaxed) baseline
  recovToThresh(t)      = STATUS.recoverFracThresh * t          // shun/slander/retire: pulled back across the fixed bar

  // ── RUIN: a FAST fall AND an INVOLUNTARY cause (spending your own purse is not ruin) ──
  fellHard    = a.goldFast <= a.goldSlow * STATUS.ruinFrac
  involuntary = lossReasonShare(a, ['robbed','fined'], STATUS.lossWindow) >= STATUS.involuntaryFrac  // [13] §2 ring
  if fellHard and involuntary and !a._ruined:
    a._ruined = true
    memory.record({kind:'ruined', salience:0.7, valence:-1})   // read class: OWN GOLD → memory is own-state (whitelist)
    chronicle.note(BEAT.RUIN, a.id, `${a.name} has fallen on hard times.`, arcRef)
    closeArc(sim.sagas, 'rags:'+a.id, 'ruined')
  else if a._ruined and a.goldFast >= recovToBaseline(a.goldSlow):
    a._ruined = false                                          // recovered past the band → the next fall can fire again

  // ── SHUNNED: the BEAT fires off truth; the MEMORY needs perceivable evidence (review 1) ──
  if meanStanding <= STATUS.shunStanding and !a._shunnedBeat:  // BEAT/arc = narrator's privilege; true mean OK
    a._shunnedBeat = true
    chronicle.note(BEAT.SHUNNED, a.id, `${a.name} finds the town has turned cold.`, arcRef)
  else if a._shunnedBeat and meanStanding >= recovToThresh(STATUS.shunStanding):
    a._shunnedBeat = false
  // the `slandered` MEMORY is a cognition input the victim ACTS on — so it is NOT written off the true
  // mean. It is gated on perceivable evidence the victim itself accumulated: snubsFelt (catalog [13] §3 —
  // refused trades, witnessed snubs, gossip about oneself) + the §6 shun-surcharge once it exists.
  if snubsFelt(a) >= STATUS.snubThreshold and !a._slandered:   // OWN-STATE counter — no foreign deref
    a._slandered = true; memory.record({kind:'slandered', salience:0.7, valence:-1})
  else if a._slandered and snubsFelt(a) <= recovToThresh(STATUS.snubThreshold):
    a._slandered = false

  // ── RETIRE/RELAPSE: own experience store (own-state, fine) ──
  if feltSurcharge(a,'burgle',…) >= STATUS.retireSurcharge and !a._retired:
    a._retired = true; memory.record({kind:'thwarted', …}); chronicle.note(BEAT.RETIRE, …)
    openArc(sim.sagas, {kind:'burnedVeteran', key:'burned:'+a.id, principals:[a.id]})
  else if a._retired and feltSurcharge(a,'burgle',…) <= recovToThresh(STATUS.retireSurcharge):
    a._retired = false                                         // surcharge decayed → may relapse, then re-retire
```

> **Two outputs, two epistemic statuses (review 1).** The probe is omniscient and may read the true
> roster mean freely — but only *some* of what it emits is omniscient-safe. A **beat** and an **arc
> close** are display/record: the narrator's privilege, truth is fine (the Director reads the roster
> this way already). A **memory episode** is different in kind — it is a cognition input the victim
> then *acts on*. For `ruined` (own gold) and `thwarted` (own experience store) the underlying read is
> **own-state**, something the agent could legitimately know, so the memory is harmless. For
> `slandered` the underlying read would be the true mean of every *other* agent's private beliefs —
> something no perceivable evidence chain could deliver — written as a first-person "I am shunned" that
> drives a despair/flight arc. That is a **foreign dereference with a memory record as its courier**,
> the one place the observer-layer reframing actually breaks. The Director precedent does **not** cover
> it: the Director stages *perceivable* events or plants beliefs via the gossip channel, and cognition
> runs on perception; this would skip perception entirely.
>
> **The fix keeps the good half of the reframing.** The omniscient probe still fires the SHUNNED beat
> and closes the arc off the true mean (the narrator legitimately knows the town has cooled). The
> `slandered` MEMORY is gated on **perceivable evidence the victim actually accumulated** — `snubsFelt`
> (catalog [13] §3) plus the §6 shun-surcharge once it lands. So the town turns cold in the chronicle
> the instant the true mean crosses, while the victim only *believes itself shunned* once it has felt
> enough cold shoulders to know — the honest split, and the same one [13] §1 rule 4 demands.
>
> **The missing guard — a whitelist test.** `epistemic.mjs`'s `FOREIGN_DEREF` scan deliberately
> exempts the observer pass, so without an explicit gate the observer layer is a standing hole through
> which any future sensor could feed truth to cognition with a one-line `memory.record`. Add a
> whitelist assertion: **which episode kinds a probe may author, and from which read class** —
> own-state (own gold/inventory/experience) and perceivable-evidence counters (`snubsFelt`) are
> allowed; a roster aggregate (mean standing) is **not**. `ruined`/`thwarted` pass on own-state;
> `slandered` passes *only* because it now reads `snubsFelt`. (Catalog [13] §10 S4 / §11 below is this
> gate; it is the enforcement the reframing needs to not become a loophole.)

**New memory episode kinds** (`memory.ts:memoryPhrase`): `ruined` ("lost everything"), `thwarted`
("gave up the venture"), `slandered` ("found themselves shunned"). These feed `deriveGoals` like any
episode — a `ruined` episode can derive a `seek_fortune` or (disposition-gated) a `larceny` goal,
giving the victim a first-person *recovery* arc, not just a chronicle line.

**Unlocks:** Fall-from-Grace (RUIN), Burned-Veteran (RETIRE/relapse arc), the tragic Ruinous-Rumor
ending (`slandered` → the victim's own despair/flight beat).

---

## 6. Believed-wealth field + wealth→standing recognition channel (DETECT)

The gap: `BeliefState` (`beliefs.ts`) tracks `standing`/`suspicion`/`notoriety`/`hostile` but **not
another agent's prosperity**. So the town cannot esteem someone *for being rich* — which blocks
Rags-to-Riches' closing beat and the "celebrated outlaw." Note `estimateHaul` (`planner.ts:370`)
*already infers* believed wealth from belief cues (`b.confidence`, `b.assoc`, `b.notoriety`) — but
it's an ephemeral planner read for theft, not a **persisted social belief**.

**The addition (keep it BELIEF, never ground truth):**

```ts
// on BeliefState (beliefs.ts) — value + confidence, evidence-accrual like every other belief field
believedWealth: number;     // believed prosperity of the subject, 0..1 (0 = unknown/poor)
wealthConf: number;         // how sure (firmed by first-hand cues, faded by decay)

// the write path on BeliefState (mirrors recordAssocSighting): a perceived cue nudges the estimate.
recordWealthCue(implies, weight):
  this.believedWealth = clamp01(this.believedWealth + (implies - this.believedWealth) * weight)
  this.wealthConf = firmUp(this.wealthConf, weight)
```

**The cue bridge (`agent/perception.ts`)** — the same truth-in/belief-out pattern as `notoriety`
(line 106) and `captive` (line 113): when an observer SEES a subject do a *visible* prosperity cue,
nudge the belief. Cues that are genuinely observable: a **fat trade** (the market-clear the observer
witnesses — a big purchase), a **carried tool/fine gear**, a built **home** (`B:` percept the
subject owns). Never read `subject.gold` directly — only the visible proxy. `decay()` (beliefs.ts)
fades `wealthConf` so an unrefreshed wealth read goes stale, like confidence.

**The recognition channel (`agent/decide.ts`)** — a small esteem nudge (belief only): an agent that
*believes* a non-suspect local is prosperous warms its `standing` slightly toward them (people defer
to wealth), and an outlaw who is *believed-rich-and-notorious* reads as a celebrated figure
(feeding §9). This is the closing beat Rags-to-Riches needed: the climber's wealth becomes
**socially recognised**, which §3's `ragsToRiches` arc reads to `closeArc('celebrated')`.

> **Deference is personality-gated, like every other social channel (review 6).** As first drafted
> this was the *one* standing-affecting channel in the sim with no disposition gate — an unconditional
> warm-toward-the-rich. That is a decision, not a default, and it should be made on purpose: deference
> deserves its **envious mirror**. The nudge is gated on disposition — the deferential/ambitious warm
> toward believed wealth (they court patronage), while the **envious/proud** agent *cools* slightly
> (resentment of the parvenu), the same per-perceiver, belief-only shape as the §9 outlaw warming and
> its souring. If a future tuning wants pure deference it sets the envy weight to 0 explicitly — but
> the gate exists so the choice is visible, not accidental.
>
> **Consequence for the rags `celebrated` close (review one-liner b).** Because the channel now both
> warms and cools, **net mean standing is the wrong close key** — a town that splits deferential/envious
> can hold the climber's net standing below any threshold *even as half the town courts them*, making
> celebration structurally unreachable. So §3.5's `ragsToRiches` → `closeArc('celebrated')` keys on
> **deference mass** — the count of perceivers warmed past a recognition bar (equivalently, summed
> `believedWealth`·warmth mass) — not the net average. Half a town's open admiration *is* the
> celebration; the other half's envy is the *story*, not a veto on it.

> **Wrong exactly when the cues mislead** — a flashy spender who is actually broke reads rich; a
> miser reads poor. That is the same fairness `estimateHaul` is owed and the same epistemic honesty
> the whole sim runs on. `estimateHaul` can now *read* `believedWealth` as its prior instead of
> re-deriving from `b.confidence` (one-line refinement; the two converge).

> **Cross-doc synergy — `wealthConf` is the input [11-LLD §5] declared missing (synergy 1).** The
> caution attribution rule prices a watched theft's burn by *how knowable the haul was* and explicitly
> ships on a **proxy** confidence (`assoc.conf` for `burgle`, the mark's `beliefs.confidence` for
> `rob`) "until the wealth-cue haul carries its own confidence" ([11-LLD §5], §12 limit 4). That
> confidence is **`wealthConf`** here. Once this step lands, [11]'s `relevantConfidence` for
> `burgle`/`rob` swaps its proxy for `bind._conf = wealthConf(mark)` — one line, same rule, and
> caution's attribution becomes fully meaningful for its two flagship verbs. This is a roadmap
> dependency, recorded in §13.

**Unlocks:** Rags-to-Riches closing beat; the "celebrated outlaw"; a richer `estimateHaul` prior;
completes [11]'s attribution rule (`wealthConf` → `bind._conf`).

---

## 7. Directed-assault / engagement executor (SET UP / resolve)

The gap: `goalMuster` (`planner.ts:1371`) has `predicate(){return false}` — it is satisfied only by
"the live party reaching strength," but **nothing then marches the band on the foe**. And the rescue
deriver (`affect.ts`) forms `goalFree` but there's no step to **clear the guards** between the
rescuer and the captive. So "a band forms / a rescuer wanders" never becomes the **confrontation**
that resolves the trope.

**The addition (two registry rows, verbs-are-data):**

1. **`goalAssault` + the `assault` executor (`recruiter.ts`).** Once `goalMuster` reports believed
   strength (the leader's mustered band, read via the existing party machinery), the muster deriver
   pushes a follow-on `goalAssault(foeId)`. The `assault` executor marches the band: it sets the
   leader's `goal` to engage the believed-strong foe and relies on the **existing party-combat
   path** — `decideParty`/`enemyNearLeader` (`decide.ts:438`) already makes followers fight whatever
   the leader engages, so the executor just steers the leader to the believed foe's `lastPos` and
   commits combat (`goTo` + the combat seam). Closes the `warband` arc on resolution
   (`victorious`/`routed`). No AI fork — it reuses `decideParty`.

   > **The `victorious`/`routed` outcome IS [11-LLD §8]'s combat win/loss signal (synergy 2).** That
   > resolution — did the band win the engagement or break — is precisely the *fighter's own
   > win/fled/health-fraction-lost* signal [11] §8 named as **`attack`'s admission ticket to the
   > watched set** ("its outcome signal must come from the fighter's own resolution … once it exists,
   > `attack` can be admitted"). **The carrier already exists: [11]'s `PLAN_OUTCOME` registry.** The
   > assault's resolution IS an outcome event — `victorious` ≈ a landed/`windfall` step, `routed` ≈
   > `peril`, with the health-fraction in the `evt` — so the executor emits it through `runPlanOutcome`
   > like any watched step, never a private boolean. The `warband` arc-close hook subscribes today; when
   > `attack` is later admitted to caution, caution's existing `PLAN_OUTCOME` handler subscribes to the
   > **same emission** and the admission ticket costs nothing new. Naming the carrier now is what makes
   > "second customer" real rather than aspirational. Recorded as a dependency in §13.

2. **The clear-the-guards subgoal (`affect.ts`).** The rescue plan becomes `goto → (attack captor
   while in reach) → free`. The captor is `b._captorId` — but cognition can't read that; instead the
   rescuer's **belief** carries a hostile near the believed-captive (perception already writes a
   hostile belief about the captor it sees beside the captive). So the rescue deriver, when a
   believed-hostile sits within reach of the believed-captive, prepends a `goalAvenge`-shaped
   `attack` subgoal (reusing the existing avenge/fight path) before the `free` step. The `free`
   executor then lands once the guard is down. Closes the `rescue` arc (`freed`).

   > **The borrowed attack inherits the aggression gate — decide that on purpose (review 6).** Reusing
   > the avenge/fight path means the guard-clear sits behind the same disposition/aggression gate that
   > path already has, so a **timid or scrupulous** rescuer derives `goalFree`, reaches the camp, and
   > **cannot strike** — it hovers and the arc lapses. That may be *exactly* the story wanted (only the
   > bold cut their way in; the gentle wait for the guard to wander) — but then it is a deliberate
   > "rescues are bold-only" design, stated, not an accident of which executor we borrowed. The chosen
   > rule: **keep the gate, make it intentional** — the rescue *justification* relaxes the gate the way
   > the conscience-cost design treats desperation (a strong enough `succoured`/bond pulls a normally
   > timid agent past its threshold), so a devoted-but-meek rescuer can still act when the bond is
   > strong, while a cold bystander stays out. If a later tuning wants pure bold-only, it sets that
   > relax weight to 0 — again, visibly.

Both stay inside the epistemic split (targets are **believed** positions/hostiles, never roster
reads) and the conserved economy (combat resolves via the existing ground-truth seam; no minting).

**Unlocks:** Warband (the muster now *marches*); Rescue (the rescuer now *clears the way and frees*).

---

## 8. Romance goal-deriver + STEER fill keyed on `_courtingId` (SET UP / enact)

The gap: Star-Crossed is **narrated but never enacted**. `_courtingId` is set by the romance trope
(`tropes.ts:_tropeStarCrossed`, line 409) and read only by the narrator (`arcs.ts:_stepRomance`,
line 203) — it **never reaches `decide`/`act`/`steer`**, so the lovers don't actually seek each
other; the arc resolves on a personality coin-flip (`_stepRomance` nerve check) with no lived
courtship in between.

**The addition (`js/sim/features/romance.ts`, a new feature file — registry rows only):**

```
deriver (cognition, own-state):  an agent with a._courtingId set, who BELIEVES its love is nearby
  (a confident belief about _courtingId), pushes goalCourt(_courtingId) — priority below survival,
  above idle wander. Disposition: the bolder court more readily (the same nerve _stepRomance reads).
STEER_FILLS['court'] (steer.ts table):  a fill that attracts the agent toward the believed position
  of _courtingId (b.lastPos) at a social stand-off — built from the agent's OWN belief, like every
  other STEER fill. So the lovers visibly converge and linger (a courtship the player can watch),
  and proximity feeds the warm-standing the arc reads.
```

The arc resolution (`_stepRomance`) is unchanged — but now there is a **lived courtship** between
obstacle and resolution: the pair seek each other, which is what makes the union/heartbreak *earned*.
`romance.ts` also opens/closes a `romance` arc in `sim.sagas` (folding the Director's romance saga
into the shared ledger).

**Unlocks:** Star-Crossed is *enacted* (converts narrated→lived).

---

## 9. Pro-outlaw warming hook + generalised LEGEND notoriety (SET UP / DETECT)

The gap: two missing links. (1) `witnessDeed` (`simulation.ts:870`) only **sours** observers — there
is no "infamy draws a following." (2) `notoriety`/`fame` is **player-only**: the perception bridge
gates on `o.controlled` (`perception.ts:106`) and the LEGEND combat block gates on `A.controlled`
(`combatEvents.ts:427`, `434`). So an *NPC* outlaw never accrues a town-read fame, and RECRUIT can't
read it.

**The addition:**

1. **Generalise NPC `notoriety` (DETECT).** Drop the `o.controlled`/`A.controlled` gates: the
   perception bridge records ANY visible agent's `notoriety` into the observer's belief (it already
   reads `o.notoriety`), and the LEGEND combat block credits `A.notoriety` for any actor's
   witnessed townsfolk-murder (not just the player's). This is **still witness-gated belief** — a
   secret robbery breeds none. An NPC outlaw thus accrues a **town-read infamy** the same way the
   player does. `notoriety` decay already exists (`director/roles.ts:_fadeLegend` — generalise it
   to fade NPC notoriety on the slow roll too).

2. **Pro-outlaw warming (SET UP).** `witnessDeed` gains an **emergent admiration channel** beside
   its souring. The gate has **four conjuncts**, not two — the first draft (larcenous/bold + poor)
   warms a witness whose own friend was just robbed and warms a robbery of the destitute, neither of
   which is folk-heroism (review 5). A witness warms on a robbery iff it is:
   - **larcenous/bold** (low altruism, high risk_tolerance — the same gate the urchin deriver uses), and
   - **poor** (the outlaw is a folk hero to the *desperate*), and
   - **not allied to the victim** — `standing(witness→victim)` is not warm (nobody's folk hero robbed
     *me and mine*), and
   - **robbing the rich** — `believedWealth(victim)` is high (§6). This is the Robin Hood shape: the
     desperate cheer the despoiling of the wealthy, not of a fellow pauper. **This conjunct is why §9
     leans on §6** — without `believedWealth` the channel can't tell "robs the rich" from "robs anyone,"
     which is the difference between an admired bandit and a feared one (the explicit step-6-needs-step-4
     dependency, §13).

   It *warms* slightly, per-perceiver, witness-gated, belief-only — the positive mirror of the existing
   souring, exactly like the freed-captive gratitude in `affect.ts`. This is where "infamy draws a
   following" comes from.

3. **RECRUIT/WARBAND read the notoriety (SET UP).** The recruiter's muster/offer
   (`recruiter.ts`) reads the candidate's belief about the leader's `notoriety` (now NPC-populated):
   a notorious outlaw makes a *more compelling* offer to a warming candidate (higher believed
   payoff), so infamy literally **draws followers**. Feeds §3's `outlaw` arc (each follower appends a
   round).

**Unlocks:** Outlaw Hero ("infamy draws a following" + an NPC accruing town-read fame); links the
outlaw arc to the warband machinery.

---

## 10. Invariants restated for this feature

- **Epistemic split = a COGNITION boundary, not an observer boundary.** Detection probes (the arc
  registry, the status-delta sensor) are part of the **omniscient observer layer**, like the Director,
  and read **ground truth** freely — the status sensor reads true gold/level and the true roster mean
  standing (§5); the arc registry stores agent ids + text and never drives a decision (the
  chronicle/Gazette consume it). The split bites only on reads that **drive an agent's behaviour**:
  `believedWealth` is belief-scoped (written by the visible-cue bridge in the perception pass §6, read
  in cognition) because it tilts esteem; the assault/rescue targets are **believed** positions/hostiles
  (§7). `test/suites/epistemic.mjs`'s `FOREIGN_DEREF` scan covers the *cognition* passes (decide/act/
  plan/derive); a probe in the observer pass legitimately reads truth and is outside that scan — so no
  new `subject.gold` read appears in a cognition pass (the cue bridge reads a visible cue on the
  sanctioned perception/truth-in side).
- **The observer pass may DISPLAY off truth but may AUTHOR memory only off own-state (review 1).** A
  probe's beats/arc-closes are narrator output and read the roster freely; a probe's `memory.record` is
  a cognition input and may read **only** own-state (own gold/inventory/experience) or a
  perceivable-evidence counter (`snubsFelt`) — never a roster aggregate. This is the gap the
  `FOREIGN_DEREF` exemption for the observer pass would otherwise leave open: an **episode-kind
  whitelist test** (§11) is the enforcement. `ruined`/`thwarted` are own-state; `slandered` reads
  `snubsFelt`, not the mean (§5). Without this, the observer layer becomes a standing courier for
  foreign truth into cognition. **`lossReason`'s involuntary/voluntary tag is own-state and therefore
  whitelist-legal:** the owner knows whether *it* initiated a transfer — gold gone that I did not spend
  is knowably "taken" — whereas the *actor's identity* behind the loss is not own-state, and the
  `ruined` memory correctly **names no actor** (it records "I was robbed/ruined," never "by whom"). The
  whitelist classifies by **read class, not by feeling**: an involuntary-loss share passes; a
  who-did-it attribution would not.
- **Closed money loop.** The authoring layer's `pin(gold)` is a **conserved** set (debit/credit a
  sink, never `a.gold = n`); no sensor or arc mints gold; the assault resolves combat via the
  existing conserved seam.
- **Verbs are data.** `assault` and `court` register as registry rows from their feature files
  (`recruiter.ts`/`romance.ts`); no shared `switch` is edited. The arc registry is a store, not a
  verb.
- **Freeze lesson.** `arcs.ts` is bounded (`maxOpen`/`maxClosed`/`maxBeats`), lazily swept, every
  call guarded; the status sensor (an observer pass) and the cue bridge (perception) are guarded and
  never throw; new derivers are independently guarded by `runDerivers`.
- **Guarded, self-throttled passes.** `sagas.sweep()` self-throttles like `chronicle.tick`.
- **Fixes live at call sites; primitives stay unconditional.** A behaviour the caller needs (the
  mutual-feud guard, the pop-reason discriminator) belongs at the hook that motivates it, never
  absorbed into the shared primitive. `closeArc`/`pruneGoals` stay generic and unconditional — so the
  store can never decline to close (which would livelock `enforceMaxOpen`/`sweep`, review 1) and the
  generic pop path stays reusable. This is the revision-cycle twin of the classification-site
  discipline ([13] rule 4) one level up: the same lesson that says "the close hook reads the reason"
  also says "the store does not read the reason."

---

## 11. Testing

| suite | gates |
| --- | --- |
| `test/suites/arcs.mjs` **(NEW)** | A1–A10 (§3.6): open idempotent, append/close lifecycle, keying dedup, lapsed sweep, the E2E emergent vendetta saga, Gazette consumption, the director `_recordSaga` fold; **A8** eviction excludes the just-opened arc and evicts a fewest-rounds incumbent (review 2); **A9** `closeArc` is unconditional — eviction/sweep of a vendetta with a live counterpart still closes, no livelock (review 1); **A10** the mutual-feud guard lives in the satisfied-pop hook (appends "one score settled"; only the last pop closes `fulfilled`; expired never closes; a fresh `round` re-arms `expiry`) (review 2). |
| `memoryGoals.mjs` (+) | the status-delta sensor (observer probe): a `ruined` agent (a **fast** gold fall **with** an involuntary `lossReason` share) records a `ruined` episode + `BEAT.RUIN` + closes any rags arc — while an equal-size *voluntary* spend-down does **not** fire (review 3). Hysteresis: ruin → recover past `recoverFrac` → fall again fires **twice** (review 3 / [13] S2). The **SHUNNED beat** fires off the true roster mean; the **`slandered` MEMORY** does **not** — it requires `snubsFelt` (review 1 / [13] S4): true mean collapses with zero perceivable snubs ⇒ beat fires, memory silent; three refused trades ⇒ memory fires. |
| `epistemic.mjs` (+) | **the probe-authored-memory whitelist** (review 1): assert which episode kinds a probe may author and from which read class — own-state + `snubsFelt` allowed, roster aggregates rejected; a regression that wires a probe `memory.record` off the true mean fails this gate. |
| `affect.mjs` (+) | the rescue clear-the-guards subgoal: a captor in reach is struck before `free`; the `rescue` arc opens on derive and closes `freed`. |
| `recruit.mjs` (+) | the `assault` follow-through: a mustered NPC band marches the believed foe and the `warband` arc closes; an NPC's notoriety populates and tilts an offer. |
| `urchin.mjs` (+) | `believedWealth` cue bridge nudges the belief from a visible trade; the recognition channel warms standing toward a believed-rich local; `estimateHaul` reads it. |
| `seeding`/scenario | the authoring API: `forceBetrayal`/`starCross`/`captureTarget` pin a chosen pair and the targeted Director arc plays to a closed saga (deterministic). |

Each suite toggles only its own preconditions and restores in `finally` (the house pattern). No new
day-one flags to toggle (branch-gated); the gates assert the live behaviour directly.

---

## 12. What shows up in the soak / what each tool unlocks

Extend the §20 narrative-depth table (10-LLD) with the detection-side counters this feature creates:

| tool | new observable in the soak |
| --- | --- |
| **Arc registry (§3)** | `sim.sagas.recentClosed()` — a stream of completed emergent arcs (vendettas fulfilled, rescues, musters, rags-to-riches), each with a beat trail and outcome; the Gazette now files emergent features, not only director-authored ones. The keystone metric: **count of closed emergent arcs > 0** (today it is structurally 0). |
| Authoring (§4) | deterministic scenario tests; a player/designer can aim a betrayal/rescue/romance at a chosen agent. |
| Status sensor (§5) | `BEAT.RUIN`/`BEAT.RETIRE` beats; `ruined`/`thwarted`/`slandered` episodes; fall-from-grace and burned-veteran arcs become visible. |
| Believed-wealth (§6) | the town visibly *esteems the rich*; rags-to-riches closes on recognition; outlaws can be *celebrated*. |
| Assault (§7) | warbands that **march and clash**; rescues that **free the captive** (today: muster-but-no-fight, wander-but-no-rescue). |
| Romance (§8) | lovers that **seek each other** (a watchable courtship), not a coin-flip. |
| Outlaw warming (§9) | an NPC outlaw accruing **town-read infamy** and **drawing followers** — a celebrated-bandit arc. |

The honest bound: the new depth is the **completed-arc layer** over the existing emergent loops plus
two enacted tropes (romance, outlaw). Dynasty depth (§3.5) leans on a metric that exists
(`depthMetrics.ts`) but whose full arc is shallow until lineage feeds it more rounds — a follow-up.

---

## 13. Build roadmap (dependency-ordered, sized)

Build the **registry first**; every sensor/executor below surfaces beats *through* it. Each step
leaves `bunx tsc --noEmit && bunx tsc` clean and `bun test/headless.mjs` green, and merges live.

| # | step | size | converts partial→full |
| --- | --- | --- | --- |
| **1** | **Arc/saga registry** (`arcs.ts` store + `sim.sagas` + chronicle/Gazette surfacing + fold `_recordSaga`). Tests A1–A7. The spine — nothing else lands without it. | **large** | — (enables all) |
| **2** | **Vendetta hooks** — open/append/close at the `deriveGoals` avenge derive, the combat retaliation fold, the avenge-goal pop (carrying its **pop reason** — §3.5a). The cheapest proof the registry detects an emergent arc end-to-end. | small | Vendetta → **full** |
| **3** | **Status-delta sensor** (§5) + the three memory kinds. Depends on **[13] `goldFast/Slow` + `lossReason`** (the trend EWMAs + involuntary ring the RUIN test reads) and **`snubsFelt`** (the `slandered` memory's only legal input). Sequence the [13] priority-cut items 1–2 alongside this step. | medium | Fall-from-Grace, Burned-Veteran → **full** |
| **4** | **Believed-wealth field + recognition channel** (§6). Closes Rags-to-Riches; refines `estimateHaul`. **Synergy 1:** on landing, swap [11-LLD §5] `relevantConfidence(burgle/rob)` from its `assoc.conf` proxy to `wealthConf` — completes caution's attribution rule (one line, [11] §12 limit 4). | medium | Rags-to-Riches → **full**; completes [11] attribution |
| **5** | **Directed-assault + rescue guard-clear** (§7). Resolves the muster/rescue confrontations. **Synergy 2:** spec the `victorious`/`routed` resolution as a **reusable per-engagement win/loss signal** — it is [11-LLD §8]'s admission ticket for watching `attack` (a second customer); don't bury it in the executor. | medium | Warband, Rescue → **full**; supplies [11]'s combat outcome signal |
| **6** | **Generalised NPC notoriety + outlaw warming + RECRUIT reads it** (§9). The outlaw arc. **Depends on step 4** (`believedWealth`): the "robs the rich" warming conjunct (§9.2 / review 5) needs it — this dependency was previously unstated. | medium | Outlaw Hero → **full** |
| **7** | **Per-agent authoring API** (§4). Unblocks deterministic scenarios + designed protagonists. | medium | (testability + scripting) |
| **8** | **Romance deriver + court STEER fill** (§8). Enacts Star-Crossed. | small | Star-Crossed → **lived** |

Steps 2–8 depend only on step 1; among themselves **4 precedes 6** (outlaw warming reads
`believedWealth`) and the rags-arc close, **5 precedes** the warband/rescue close, 6 precedes the
outlaw close. 7 and 8 are independent and can land any time after 1.

**Cross-doc coupling (recorded so the build order's value is legible).** This feature and [11]
each supply an input the other declared missing — they are more coupled than either doc admits, in a
good way: (1) §6's `wealthConf` is [11-§5]'s declared-missing haul confidence (step 4 closes [11]'s
attribution); (2) §7's combat win/loss is [11-§8]'s `attack`-admission ticket (step 5 builds it for
two customers); (3) §9's "robs the rich" warming needs §6's `believedWealth` (step 6 leans on step 4).
**Gating regime.** Like [11] (now always-live on the mainline — its `enabled` flag removed by the
day-one-OFF refactor), this feature is **branch-gated, not flag-gated**; the two docs' gating notes
are consistent (no `enabled:false` is reintroduced here, and [11]'s former byte-identity soak path is
gone with the flag).
