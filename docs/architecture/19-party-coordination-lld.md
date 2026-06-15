# 19 (LLD) — Theory-of-Mind party combat coordination: implementation spec

> **Status: IMPLEMENTED & ALWAYS-LIVE on the mainline** (gating is by branch, not an in-code flag — the
> `COORD` block holds only tuning). Built in the §14 order; `bunx tsc --noEmit` clean, `bun
> test/headless.mjs` green (the `coord` suite: F1–F2 foundation + C1–C11 behaviours). **As-built bindings
> (the code wins):** the ToM read is `bandCombatState` in `js/sim/simulation.ts` (beside
> `enemyNearLeader`, an allowlisted resolver file) returning `BandView`/`AllyCombatRef`/`FoeCombatRef`
> (`types/ctx.ts`); the cascade is `coordTarget`/`breakOff`/`foeCap`/`bandView` in
> `js/sim/agent/decide.ts` (rungs §4–§7), committed in `decideParty` after the hearth-flee/eat
> early-returns; `fillProtect` + the `protect` goal-kind in `js/sim/agent/steer.ts` with the on-arrival
> swap in `js/sim/agent/act.ts`; the combo layer is the `expose` op (`js/rpg/abilities/effects.ts` +
> `ir.ts`/`types/abilities.ts` whitelist + `interpreter.ts` HOSTILE_OPS) with `applyExpose` consuming the
> window in BOTH damage paths (`EFFECTS.damage` **and** the plain-swing fallback in `js/combat.ts`), the
> `[Expose Weakness]` setup ability (`catalog.ts`, hunter@5), §8a opening bias in
> `bestOffensiveAbility`/`combatStep`, and §8b `tryComboSetup`/`comboHold` in `act.ts`; the capability
> layer is `js/sim/coordination.ts` (`comboRoleOf`/`accrueAllyRole`/`believedRole`/`seedBandPriors` +
> `installCoordWitness`, wired as `sim._coordOff` beside `installDeedRouter`, with the join prior seeded in
> `Party.recruit`). Tuning: `COORD` in `js/sim/simconfig.ts`. The one deliberate divergence from the
> draft: §10 accrual recovers the spec via `ABILITY_CATALOG[ev.abilityId]` (not the event's flavour tags)
> and the witness subscriber does its OWN vision scan restricted to the caster's band (the audit's two
> load-bearing corrections).

> Originally specified as low-level design. Designs the work to make a party fight as a
> *coordinated band that reads its own members' state and intentions* rather than a clump of
> independent fighters who each chase the nearest foe. The thesis: **a party should be more than
> the sum of its parts** — it focuses fire, covers a beleaguered ally, presses when backed up, and
> times abilities into combos. Every coordination read stays inside the epistemic split: cognition
> reads belief-style snapshots + own beliefs; execution reads ground truth. Read
> [02 — the epistemic split](02-epistemic-split.md), [03 — RPG/abilities](03-rpg-abilities.md), and
> [18 — knowledge exploitation](18-knowledge-exploitation-lld.md) first; this doc extends their
> vocabulary (the `believedThreat` formation bridge and `survivalMod` force-ratio modulation are 18's;
> the one-level `recordBelieves`/`believesConf` prediction is 10-LLD's).

> **The one-line summary:** one new vision-gated resolver (`bandCombatState`) gives each companion a
> *perceptual snapshot* of its band's combat state — allies' positions/health/who-they-strike and the
> foes engaging the band — plus a learned **believed-capability** layer (what each ally *can* do). A
> rewritten target policy in `decideParty` turns those reads into five coordinated behaviours
> (focus-fire, anti-gang spread, protect-the-beleaguered, allied-strength resolve, ability combos),
> and a new `expose` combat status makes combos a *designed* payoff rather than only opportunistic
> crowd-control exploitation.

> **The hard invariants this feature must not break:**
> - **The epistemic split.** A companion never reads another agent's `.goal`, `.beliefs`, or live
>   object. What an ally "is doing" is *perceived* (adjacency + facing, like `enemyNearLeader` infers a
>   target) and returned as a `{id, pos, …}` snapshot; what an ally *can do* is a **belief** accrued
>   from witnessing its tagged casts (truth→own-belief, the sanctioned bridge — identical pattern to
>   the `believedThreat` perception bridge). The single execution-side scan is `bandCombatState`, which
>   lives in `simulation.ts` beside `enemyNearLeader`/`warbandStrength` — an **allowlisted file the
>   epistemic scan does not read** (that resolver/orchestration file's status is what sanctions the
>   roster scan; a `// EPISTEMIC-OK:` comment would be documentation, not the gate). The constraint that
>   *does* bind is cognition-side: the `decideParty` cascade reads only snapshot scalars + own beliefs,
>   never a ground-truth field off a `foe`/`leader`/`enemy`-named local (the `FOREIGN_DEREF` belt).
> - **The freeze lesson.** All new reads are guarded and `try/catch`-walled; the whole policy runs
>   only inside `decideParty`. **But `decideParty` fires for *every* `inParty` agent** (`decide.ts:325`
>   gates on `a.inParty` alone) — not just the player's companions: warband followers, expedition
>   members, caravan guards/porters, bodyguards/protégés, and any **monster** band flagged `inParty`
>   all run the cascade. So the rungs cannot assume a professioned, ability-holding, faction-friendly
>   actor — each rung no-ops cleanly on ability-less/professionless/monster agents, and the C13 freeze
>   test (§12) is **load-bearing**, not belt-and-suspenders.
> - **Float-parity of `survivalMod` (18's S2 net).** `survivalMod` is called identically by
>   `scoreAndSelect` and `arbitrate` and the products must stay float-identical. This feature does
>   **not** touch `survivalMod`; the allied-strength term (§7) is a *separate* addend applied only in
>   the party path.
> - **Closed money loop / data-only abilities.** The new `expose` op is data-only IR behind
>   `ir.validate()` (no `eval`); it mints no gold and transfers nothing.

---

## 1. What gap this fills (and what it must not do)

Today a companion or warband follower runs `decideParty` (`js/sim/agent/decide.ts:887`), and its
entire combat brain is **spatial proximity**. The real tail (decide.ts:900-936) has more structure
than a single commit — the cascade must coexist with it:

```ts
if (!leaderLive) { /* no-leader fallback → own ambition goal */ return; }   // 900-905
const combatant = pgt ? pgt.combatant : true;                               // 907 (warband=true, hearth=false)
let enemy = a._nearestHostile(ctx);                                          // 910 my nearest believed-hostile
if (!enemy && combatant && ctx.resolver) enemy = ctx.resolver.enemyNearLeader(a, leader); // 914-917
if (enemy && !combatant) { /* HEARTH flees (to shelter near leader) */ return; }          // 918-932
if (!enemy && food>0.05 && hunger<eatUrgent) { a.goal={kind:'eat'}; return; } // 935 starving member eats
a.goal = enemy ? { kind:'fight', targetId:enemy.id } : { kind:'follow' };    // 936 the commit
```

**The cascade (§4–§8) slots between the `enemy` resolution (917) and the commit (936) — i.e. AFTER
the no-leader, hearth-flee, and eat early-returns, which all remain.** A hearth still flees, a
safe-but-starving member still eats, before any focus-fire logic runs; the cascade only re-shapes the
combatant's target choice.

So a band **converges** on the leader's fight but does not **coordinate** within it. Three companions
facing three foes split one-each instead of dropping one fast; nobody peels to cover a leader being
focused; a member flees a duel it would win with one ally beside it; and abilities fire on a private
cadence (`act.ts:568`) with zero awareness of what an ally just set up. A frost-bolt that slows a foe
is never followed by an ally's lunge; a whirlwind's stagger opens no window anyone exploits. **The
party fights as N solipsists.**

What this feature must **not** do:

- **Read ground truth to decide.** The temptation is to let a follower read `leader.goal.targetId`.
  That breaks the split. The follower instead *sees* the leader swinging at a foe and infers intent —
  first-order ToM, vision-gated, snapshot-only.
- **Make the party a hive-mind.** Coordination is *belief-graded and personality-shaped* (a timid
  member still flees; a reckless one over-commits). Members can be wrong about what an ally will do —
  that is the ToM premise, not a bug. The capability layer carries confidence and **decays**.
- **Collapse into omniscient optimisation.** No global target assignment solver. Each member decides
  for itself from its own snapshot; coordination *emerges* from shared reads, the same way the
  band already converges via `enemyNearLeader`.
- **Break non-party agents.** The policy is scoped to `decideParty`, so solo townsfolk and the
  player's own fighter never touch it — but every `inParty` agent does, *including* monster/NPC bands
  (the cascade is faction-agnostic by design; see the freeze-lesson note above and C13).

---

## 2. Module map

| file | layer | responsibility |
| --- | --- | --- |
| `js/sim/simulation.ts` | execution / seam | the **one new resolver**: `bandCombatState(observer, leader)` — a single vision-gated roster scan returning allies' + foes' belief-style snapshots. `// EPISTEMIC-OK:`, beside `enemyNearLeader`. Cached per observer per tick. |
| `js/sim/agent/decide.ts` (`decideParty`) | cognition | the **rewritten target policy**: the five-behaviour priority cascade (§4–§8) reading the snapshot + own beliefs. The *only* decision-logic change. |
| `js/sim/agent/steer.ts` | cognition | one new steer-fill, `fillProtect` (interpose between a beleaguered ally and its attacker), registered in `STEER_FILLS` under a new `goal.kind:'protect'`. |
| `js/sim/agent/act.ts` | execution | (a) the `'protect'` **on-arrival verb branch** (swaps the goal to `'fight'` on reach — `'fight'` is dispatched before the fill table, §6.1); (b) the **combo-aware cast hook**: `bestOffensiveAbility` gains a target-state param + opening-bonus (CC'd / exposed) and a setup path; `tryComboSetup` casts a control/expose spec to open a window for a believed-burst ally. |
| `js/sim/features/coordination.ts` | both | the **capability-formation feature**: a bus subscriber that accrues `comboRole` belief from witnessed tagged casts (the truth→belief bridge), plus pure helpers `allyRole` / `believedRole` / `comboRoleOf`. No verbs/executors/derivers — like `caution.ts`, the smallest kind of feature, here a single bus handler + helpers. |
| `js/rpg/abilities/effects.ts` | execution | the **new combo-payoff op** `expose` (mirrors `slow`): sets a timed, amplitude-carrying status on the target fighter; the `damage` op reads-and-consumes it. |
| `js/rpg/abilities/ir.ts` + `types/abilities.ts` | data | add `'expose'` to the `EFFECT_OPS` whitelist **and** the `EffectOp` type union (else `EFFECTS: Record<EffectOp,…>` fails `tsc`); the op self-clamps its amp (generic `LIMITS` doesn't bound the multiplier). |
| `js/rpg/abilities/catalog.ts` | data | one setup ability that applies `expose` (a control-role spec) + its milestone. |
| `js/sim/simconfig.ts` | config | the new `COORD` block (tuning only, always-live — no on/off flag). |
| `types/beliefs.ts`, `types/agent.ts`, `types/ctx.ts` | types | `comboRole` belief substrate, `bandCombatState` on the resolver, the `protect` goal kind, `_exposeUntil`/`_exposeAmp` on the fighter status bag. |
| `test/suites/coord.mjs` | test | the C* coordination tests (§11), wired into `test/headless.mjs`. |

### Where it runs in the tick

```
perceive ─ (witness a tagged ally cast on the bus) ─► coordination.ts accrues comboRole belief   [formation]
decide ── decideParty ── bandCombatState(a, leader)  ─► snapshot (allies + foes, vision-gated)    [the ToM read]
                      ── PRIORITY CASCADE → a.goal:
                           1. protect a beleaguered ally   (§6)  → {kind:'protect'|'fight', targetId}
                           2. exploit an open window        (§8a) → {kind:'fight', targetId: cc'd/exposed foe}
                           3. focus-fire the band's target   (§4) → {kind:'fight', targetId}
                           4. spread off a saturated foe      (§5) → {kind:'fight', targetId: next foe}
                           5. fall through to nearest/leader  (today's path)
act ── combatStep ── cast cadence:
           trySelfCast → tryAllyCast → tryComboSetup (§8b) → bestOffensiveAbility (opening-biased, §8a)
```

No new per-tick pass. Capability belief decays lazily at read time (the `experience.ts` pattern).

---

## 3. The ToM read — `bandCombatState` (the single execution bridge)

One resolver, one vision-gated scan, returns only belief-style snapshots (never live objects):

```ts
// types/ctx.ts (resolver)
bandCombatState(observer: Agent, leader: Agent | null): BandView | null;

interface BandView {
  allies: AllyRef[];   // band-mates the OBSERVER can see (incl. the leader)
  foes:   FoeRef[];    // hostiles engaging the band, within vision of observer OR leader
}
interface AllyRef { id; pos; hpFrac;  strikingId: EntityId | null; }   // who this ally APPEARS to fight
interface FoeRef  { id; pos; hpFrac;  attackerCount: number; ccUntil: number; exposed: boolean; }
```

Implementation (in `simulation.ts`, beside `enemyNearLeader`, fully guarded):

```
bandCombatState(observer, leader):
  band = [observer] + every live agent o with o.bandLeaderId === observer.bandLeaderId  // own-band set
  allies = for each bandmate m ≠ observer, IF visible to observer (dist ≤ visionRange):
             { id:m.id, pos:snapshot, hpFrac:m.fighter.health/maxHealth,
               strikingId: inferStrikeTarget(m) }          // m's nearest faction-foe within m's reach + facing cone
  foes = for each live agent o hostile to observer.faction, visible to observer OR leader:
             { id:o.id, pos:snapshot, hpFrac:…,
               attackerCount: |{ b in band : inferStrikeTarget(b) === o.id }|,   // how many of US are on it
               ccUntil: max(o.fighter.staggerTimer→absolute, slowUntil),          // is it controlled right now?
               exposed: exposeActive(o.fighter, now) }                            // §9 combo window open?
  return { allies, foes }
```

`inferStrikeTarget(m)` is the **inference that keeps the split honest**: it does not read `m.goal`; it
returns the foe `m` is *visibly* engaging (nearest hostile inside `m`'s strike reach and facing cone) —
the same kind of observable inference `enemyNearLeader` already makes. A companion that cannot see an
ally simply gets no `AllyRef` for it (and falls back). The scan is cached on the observer for the tick
(`observer._bandViewT`/`_bandView`) so the cascade below reads it once.

> **Why a resolver and not a belief table.** Per-ally combat state is high-frequency and ephemeral
> (positions/health change every frame); banking it into the N² belief store would thrash the bounded
> table (invariant 12) for data that is only ever read *now, in a fight I'm in*. The resolver is the
> right tool — it is the same call shape (`{id,pos}` refs, vision-gated) the band already uses to
> converge, just carrying three more observable scalars. Capability (§10), which *is* slow-moving and
> worth remembering, is the part that lives in beliefs.

---

## 4. Focus-fire (cascade rung 3)

Among `view.foes`, prefer the one the **band is already committed to** — highest `attackerCount`, tie
broken by nearest-to-me and lowest `hpFrac` (finish the one closest to dropping). Gate by a range leash
so a member does not abandon a foe on top of it to join a fight across the field.

```
focusTarget(a, view):
  cand = view.foes filtered to dist(a.pos, f.pos) ≤ COORD.focusRange
  if none: return null
  return argmax over cand of:  f.attackerCount·COORD.focusBonus
                             + (1 − f.hpFrac)·COORD.finishWeight
                             − dist(a.pos, f.pos)·COORD.focusDistPenalty
```

*ToM content:* "my band means to kill that one — I help finish it before it deals more damage." The
emergent effect is fire collapsing onto a single foe, dropping it (and removing its DPS) faster than
spreading would.

---

## 5. Anti-gang / spread (cascade rung 4)

Focus-fire unchecked piles all four members on one foe while a second free-hits the leader. Cap the
*useful* attackers per foe and peel the surplus:

```
saturated(f) = f.attackerCount ≥ ceil(COORD.maxPerFoe · threatScale(f))   // tougher foe absorbs more
if focusTarget is saturated AND ∃ unattended foe u (attackerCount < 1) threatening the band:
    target = nearest such u    // peel to cover the free-hitter
```

`threatScale` reads the foe's believed strength (`believedForceRatio`, the doc-18 formation field) so a
boss legitimately soaks the whole band while three rats get one attacker each. *ToM content:* "enough of
us already mean to handle that one — I take the one nobody has." Focus (§4) and spread (§5) compose:
collapse fire until saturated, then fan out.

---

## 6. Protect the beleaguered (cascade rung 1 — highest priority)

If a band-mate — weighted heavily toward the **leader** — is below `protectHpFrac` and has a visible
attacker (`some foe with strikingId-style adjacency to the ally`), override the target to **that
attacker**:

```
beleaguered = view.allies filtered to hpFrac < COORD.protectHpFrac AND has a foe adjacent to it
if beleaguered (prefer the leader, else lowest hpFrac):
    threat = the foe adjacent to that ally
    if dist(a.pos, threat.pos) ≤ reach:  goal = {kind:'fight', targetId: threat.id}
    else:                                goal = {kind:'protect', allyId, targetId: threat.id}   // §6.1
```

### 6.1 The `protect` steer-fill (`fillProtect`)

A new `goal.kind:'protect'` maps to `fillProtect` in `STEER_FILLS`: an attractor at the **interpose
point** (between the ally's believed pos and the threat's pos, biased toward the threat) so the
defender body-blocks rather than running past the ally to the foe. Repulsors stay off the ally so they
do not shove each other. Because `act.ts` special-cases `'fight'` → `combatStep` *before* the
`STEER_FILLS` table dispatch, `'protect'` needs **two** edits, not one: register `fillProtect` in the
table, **and** add an on-arrival verb branch (the precedented `if (k==='protect' && arrived) …` shape,
like `beg`/`work`) that sets `a.goal = {kind:'fight', targetId}` so the next frame's `'fight'` branch
picks up the swing. *ToM content:* "an ally believes itself in peril — I put myself between it and the blade."

---

## 7. Allied-strength resolve (the fight/flee modulation)

A backed-up member should press an attack it would solo-flee. The force-ratio machinery already exists
(`believedForceRatio`/`survivalMod`, doc 18 M3) — but **`survivalMod` is float-parity-locked** between
`scoreAndSelect` and `arbitrate` (18's "S2 net"), so this feature does **not** edit it. Instead the
party path adds a *separate* believed-allied-strength term:

```
alliedStrength(a, view) = Σ over visible allies m of believedStrength(a, m.id)·m.hpFrac   // my belief of THEIR force
partyForceBonus = COORD.allyStrengthWeight · alliedStrength / (alliedStrength + believedEnemyForce)
```

applied as an additive nudge to the fight push (and a symmetric damping of flee) **only in the
`decideParty` commit**, where no parity oracle runs. `believedStrength(a, m.id)` reads MY belief of the
ally's combat strength (the same `believedThreat`-backed helper `believedForceRatio` uses) — own-belief
only, the split holds. *ToM content:* "with two stout comrades beside me I'll hold this line I'd flee
alone." Bounded and personality-graded: a timid member's innate flee bias still wins past a threshold,
so the bonus tips lopsided cases without making the band fearless.

---

## 8. Ability combos

Combos are the deepest rung and the one that needs new mechanics: **today there is no setup→payoff** —
the persistent fighter statuses (`slow`, `stagger`, `shield`) are never read by a follow-up to amplify
it. This feature builds combos in three layers, cheapest first.

### 8a. Exploit an open window (no new mechanic)

A foe that is **currently controlled** (`ccUntil > now`: an ally just stunned or slowed it) or
**exposed** (§9) is an *opening*. Two hooks:

- **Targeting:** `focusTarget` (§4) adds `+COORD.openingBonus` for foes with an open window, so the band
  pivots onto the foe an ally just set up.
- **Casting:** `bestOffensiveAbility` (`act.ts:814`) adds `+COORD.openingCastBonus` when the engaged
  target has an open window and the agent holds a ready burst spec — so the member spends its cast *now*,
  into the window, instead of on its private cadence. Note `bestOffensiveAbility(a, dist, now, targetId)`
  currently sees no target *state* — it must gain one parameter (the foe's `ccUntil`/`exposed`, or the
  resolved target fighter) threaded from its caller `tryCastAbility` (`act.ts:615`); the
  `openingCastBonus:1000` is sized to match the existing `+1000` adjacency bonus it competes with.

This alone makes the party superlinear using only shipped ops: frost-bolt slow → ally lunges into the
slowed foe; whirlwind stagger → ally power-strikes the staggered foe. *ToM content:* "it's reeling —
NOW."

### 8b. Set up for a believed-capable ally (predictive ToM — needs §10)

The richest rung: a member *creates* a window because it believes an ally will exploit it. Using the
capability belief (§10) and the snapshot:

```
tryComboSetup(a, ctx, view):
  if a holds a ready CONTROL/EXPOSE spec AND ∃ foe f engaged by the band that is NOT yet open:
     burstyAlly = view.allies.find(m => believedRole(a, m.id)==='burst'
                                        AND adjacentTo(m, f) AND ready-ish)         // first-order ToM
     if burstyAlly: record a one-level prediction (recordBelieves(a, m.id, 'will_followup', conf))
                    cast the control/expose spec on f   → opens the window THIS ally is poised to hit
```

Symmetrically, a **burst** member that believes a control ally is winding up on a foe (`believedRole ===
'control'`, adjacent, facing it) briefly *holds* its burst (a short `_comboHold` on the cast cadence)
so the damage lands *after* the control, not wasted before it. The prediction rides the existing
one-level `recordBelieves`/`believesConf` substrate (10-LLD) — "I believe my ally intends to follow up"
— and is allowed to be **wrong** (the ally may die, flee, or whiff): a stale hold times out fast and the
member just attacks. This is the literal "more than the sum of its parts": the control member spends a
turn it would otherwise damage, because it predicts a teammate converts that setup into more than the
forgone hit.

### 8c. The honest scoping

8a ships value with zero new combat-balance surface and is the safe default. 8b is the most speculative
rung — it depends on the §10 capability layer being populated and on a prediction that is often wrong;
it is built last and tuned conservatively (a short hold, a low setup threshold) so a wrong prediction
costs at most one delayed swing. §9's `expose` op is what makes 8b *worth* predicting (a designed,
legible payoff), but 8a/8b both function on raw crowd-control if `expose` is cut.

---

## 9. The combo-payoff op — `expose` (new combat mechanic, data-only IR)

Mirrors `slow` exactly (a timed, amplitude-carrying status on the fighter status bag), so it inherits
the validate/whitelist/friendly-fire plumbing:

```ts
// effects.ts AbilityStatusBag (beside slowUntil/shield)
_exposeUntil: number;    // wall-clock expiry
_exposeAmp:   number;    // damage multiplier while open (e.g. 1.5)

// EFFECTS.expose(e, caster, target, ctx):   HOSTILE_OP (never lands on allies)
st._exposeUntil = max(st._exposeUntil, ctx.time + e.duration)
st._exposeAmp   = clamp(e.amount ?? COORD.exposeAmp, 1, COORD.exposeAmpMax)   // multiplier, NOT raw magnitude
```

> **The two damage paths — the read-and-consume must cover BOTH (audit finding, load-bearing).**
> Damage does NOT flow through one chokepoint. A spell or a melee spec that carries a `damage` effect
> routes through `EFFECTS.damage` (`interpreter.ts:122`; melee via `combat.ts:68`). But an **ordinary
> swing** — the common companion/NPC case, and *every* swing by an ability-less fighter (monsters,
> unarmed player) — calls `target.takeHit(swingDmg, dir)` **directly** at `combat.ts:84`/`:88`,
> bypassing `EFFECTS.damage` entirely. So putting the amp only in `EFFECTS.damage` (the v1 plan) would
> mean a plain companion swing into an exposed foe gets **zero** amplification and never closes the
> window — gutting the payoff for the most frequent damage source. **The fix:** apply the
> read-and-consume in a small shared helper called from BOTH sites:
>
> ```ts
> applyExpose(targetFighter, dmg, now):                        // pure, in effects.ts; both callers use it
>   if !exposeActive(targetFighter, now): return dmg
>   const out = dmg * targetFighter._exposeAmp; clearExpose(targetFighter); return out
> // · EFFECTS.damage: dmg = applyExpose(tf, dmg, ctx.time) before the shield-soak/takeHit
> // · combat.ts:84/:88 fallback: swingDmg = applyExpose(target, swingDmg, ctx.time) before takeHit
> ```

`ir.ts`: add `'expose'` to the `EFFECT_OPS` whitelist (`ir.ts:34`) **and** to the `EffectOp` union in
`types/abilities.ts` (else `EFFECTS: Record<EffectOp,…>` won't typecheck and `tsc` errors). The generic
`LIMITS` (`amount ≤ 200`) does **not** enforce the 2.0 amp ceiling — the op clamps `e.amount` to
`COORD.exposeAmpMax` itself (above), since `amount` here is a multiplier, not a magnitude. `catalog.ts`:
one setup ability — a control-class spec (e.g. brawler/hunter tier-2 `expose_weakness`: `expose
amount:1.5 dur:4`, tagged `CONTROL,SETUP`) — registered in **both** the milestone map
(`CLASS_MILESTONES`) **and** the `ABILITY_CATALOG` export object (`catalog.ts:118`). The existing burst
specs (`power_strike`, `lunge`, `frost_bolt`) are the exploiters; no change to them — the shared
`applyExpose` reads the window generically. *Design note (R1, the slow lesson from 16-LLD):* the op ships
**with** its consumer in the same change (expose + the dual-path amp read + one ability that applies it +
one ability that exploits it), never as orphaned plumbing.

---

## 10. The believed-capability layer (the formation bridge for 8b)

8b needs a member to know *what an ally can do*. Today **no agent represents another's abilities at
all** (`believedLevel` exists but is never written). This is a doc-18-M2-shaped **formation gap**: bank
the decision-relevant attribute so consumption can read it. Kept deliberately small — a coarse **combo
role**, not a full ability list.

```ts
comboRoleOf(spec) → 'control' | 'burst' | 'support' | 'none'      // pure, from the spec's effect ops:
//   control: has stun/slow/knockback/expose       burst: high single-target damage
//   support: heal/shield                          none: social/economic specs
```

**Accrual (truth→belief bridge, in `coordination.ts`).** The RPG bus emits every cast as an
`ActionEvent` — but two facts the v1 draft got wrong (audit findings, both load-bearing):
- **The event carries `abilityId`, NOT the effect ops.** `event.tags` is the spec's `grantsTags`, which
  are coarse *flavour* tags (`POWER`/`RECKLESS`/`AOE`) — `comboRoleOf` derives the role from the spec's
  *effect ops* (stun/slow/knockback/expose → control; high damage → burst), which are not on the event.
  The spec is recovered via `ABILITY_CATALOG[event.abilityId]` (`emitCast` attaches `abilityId: spec.id`,
  `interpreter.ts:249`). So role derivation is a catalog lookup, not a tag read.
- **The bus fans only to the actor**, not to witnesses (`deedRouter.ts` delivers each event to
  `agentsById.get(ev.actorId)` only). `coordination.ts` must therefore do its **own** vision-gated
  witness scan over `sim.agents` (closing over `sim`, exactly like `installDeedRouter` and
  `onCombatEvents:386` already do) — witnessing is not a property of the bus.

```
coordination.ts subscribes to the bus; on a cast event e (e.verb === 'cast'):
  spec = ABILITY_CATALOG[e.abilityId]; role = comboRoleOf(spec)               // role from EFFECT OPS, via catalog
  for each agent w in sim.agents within visionRange of e.actor (band-mates matter; own scan, witness-gated):
     bump(w._allyRole, e.actorId, role, KNOW.observeGain)                     // confidence accrues; provenance = first-hand
```

Stored as `agent._allyRole: Map<allyId, { role→conf, t }>` (the recipe-knowledge *shape* — private,
graded, provenance/`t`-tagged — `js/sim/recipeKnow.ts`, note: NOT under `features/`). **Decay** is
lazy-at-read on the `experience.ts` model (no new per-tick pass — `recipeKnow`'s own decay is a tick
pass, so mirror caution's `decayed()`, not `forgetTick`). **Banded prior:** on `recruit`/`joinBand`,
seed a weak prior about existing band-mates (you have trained/marched together, so you roughly know your
comrades' tricks) — `COORD.bandPriorConf`, below the act threshold so a single sighting still dominates.

```
believedRole(a, allyId) → the max-confidence role in a._allyRole.get(allyId), or 'none' if below COORD.roleMinConf
```

The split holds: `believedRole` reads only MY accrued belief; an ally I have never seen cast (and was
not banded long enough to prior) reads `'none'` and I simply do not set up combos around it — bounded
rationality, intentional (the 18 principle), not blindness.

> **Why a separate small store, not the N² belief table.** Combo role is a handful of bits per ally and
> only meaningful for *my own band* — folding it into the bounded per-subject belief table (invariant
> 12) would evict combat-relevant hostility/standing beliefs for buff bookkeeping. `_allyRole` is the
> recipe-knowledge shape (private, graded, decaying, provenance-tagged), the right home.

---

## 11. Config (`js/sim/simconfig.ts`)

```
COORD = {                    // always-live (no on/off flag) — tuning fields only
  // ── the ToM read ──
  focusRange: 14,            // don't abandon a foe on top of me to join a fight across the field
  visionShare: true,         // foes visible to the LEADER count for the band (the enemyNearLeader rule)

  // ── focus-fire (§4) ──
  focusBonus: 2.0,           // per ally already on a foe
  finishWeight: 1.5,         // pull toward the most-wounded foe
  focusDistPenalty: 0.05,    // per metre

  // ── anti-gang (§5) ──
  maxPerFoe: 2,              // useful attackers on a baseline foe; ×threatScale for tough foes

  // ── protect (§6) ──
  protectHpFrac: 0.4,        // an ally below this with an attacker is "beleaguered"
  leaderProtectBias: 1.5,    // the leader is worth covering harder than a peer

  // ── allied-strength resolve (§7) ── applied ONLY in the decideParty commit (never survivalMod)
  allyStrengthWeight: 0.6,

  // ── combos (§8/§9) ──
  openingBonus: 2.5,         // targeting pull toward a CC'd/exposed foe
  openingCastBonus: 1000,    // cast-NOW score when the engaged target has an open window (matches act.ts adjacency scale)
  comboHoldMax: 0.6,         // s a burst member holds, expecting a control ally to open first
  exposeAmp: 1.5,            // damage multiplier inside an expose window
  exposeAmpMax: 2.0,         // validate() ceiling on an expose spec's amount

  // ── capability belief (§10) ──
  bandPriorConf: 0.25,       // weak on-join prior about band-mates' roles (below roleMinConf)
  roleMinConf: 0.35,         // below this I don't act on a believed role
}
```

Every number is a starting point with a stated ordering, taken in the harness, not here. Orderings to
preserve: `bandPriorConf < roleMinConf` (a prior alone never triggers a setup); `comboHoldMax` ≪ the
attack cadence (a wrong hold costs at most one swing); `openingCastBonus` on the scale of `act.ts`'s
existing adjacency bonus (so an open window competes with reach preference).

---

## 12. Tests (`test/suites/coord.mjs`, on the recruit.mjs `FeatureStage`) — AS BUILT

The split/freeze regressions (the draft's C12/C13) land FIRST as `F1`/`F2` (foundation before behaviour),
then the behaviour cases:

```
F1  the band snapshot        — bandCombatState returns vision-gated allies/foes, attackerCount sums,
                               strikingId inferred (proximity, not a goal read); refs are plain snapshots,
                               NOT live objects (the split — the draft's C12)
F2  freeze/guard regression  — an unbanded agent → null; an ability-less monster band never throws,
                               sees no foes among its own kind (the draft's C13)
C1  focus-fire converges     — both companions commit the SAME foe even when one is adjacent to another
C2  spread relieves          — at maxPerFoe, the surplus member peels to the unattended foe
C3  protect the leader       — a wounded leader's attacker is targeted, not the nearer foe
C4  protect interposes       — out of reach → goal.kind 'protect' + toPos (fillProtect), not a bare fight
C5  allied-strength press    — a hurt member solo-FLEES a believed-strong foe, but PRESSES it backed by two allies
C6  opening exploited        — a staggered foe (ccUntil>now) is pivoted onto over a nearer un-CC'd one
C7  expose op                — expose opens a window; the next damage ×exposeAmp and CONSUMES it (one-shot)
C8  expose is hostile-only   — an area expose never opens a window on a same-faction ally (HOSTILE_OPS guard)
C9  capability layer         — comboRoleOf reads EFFECT OPS; accrual crosses roleMinConf then DECAYS; the
                               live bus WITNESS accrues a band-mate's role from a seen cast
C10 combo setup (8b)         — a controller, believing an adjacent ally is 'burst', casts its control spec → window opens
C11 wrong-prediction safety  — a burster's hold TIMES OUT within comboHoldMax and it attacks (no deadlock)
```

Restore-in-`finally`; wired into `test/headless.mjs` as the `coord` suite (after `recruitTest`).

---

## 13. Evaluation — what should show up in the soak / a party fight

| metric | expectation with `COORD` live |
| --- | --- |
| time-to-first-kill in a band fight | **shorter** — focus-fire drops a foe before it spreads damage (vs one-each) |
| leader survival under focus | **up** — a covered leader takes fewer free hits (the protect rung) |
| over-gang ratio | foes with > `maxPerFoe`·threatScale attackers is **rare** (spread working) |
| combo lands | count of damage hits inside a CC/expose window is **nonzero and rises** with party ability density |
| superlinearity | a 3-member band's win rate vs a fixed foe pack **exceeds** 3× a soloist's (the thesis, measured) |
| no hive-mind | members still diverge under personality (a timid member still flees past the §7 threshold) — the depth probe (doc 18 M4) must still see variance |

A `lifetrace` anecdote target: a named companion frost-bolts a raider, a second lunges into the slowed
raider and drops it, the band pivots to cover a wounded leader — narrated from the snapshot reads, not
ground truth.

---

## 14. Build order

1. **Foundation:** `bandCombatState` resolver (§3) + the `coord` test scaffold (C12/C13 first — prove
   the split + freeze safety before any behaviour).
2. **The four observable behaviours:** focus-fire (§4), spread (§5), protect (§6 + `fillProtect`),
   allied-strength (§7). All read only the snapshot + existing `believedThreat`; no new combat mechanic.
   (C1–C5.)
3. **Combo exploitation (8a):** opening bonuses in targeting + casting (C6). Still no new op.
4. **The `expose` op (§9):** effects/ir/catalog, op-ships-with-consumer (C7/C8).
5. **The capability layer (§10):** `coordination.ts` accrual + `_allyRole` store + banded prior (C9).
6. **Predictive setup (8b):** `tryComboSetup` + the burst-hold, on the §10 belief + the one-level
   prediction (C10/C11). Built last, tuned conservatively.

Each step is a commit that keeps `bunx tsc --noEmit` clean and `bun test/headless.mjs` green, plus a
manual visual check (a recruited party fights a foe pack: watch fire collapse onto one foe, a companion
peel to a focused leader, a frost-then-lunge land).

---

## 15. Known limits (on purpose)

1. **No global target assignment.** Each member greedily reads its own snapshot; two members can still
   briefly double-commit before the next tick re-reads. Acceptable — coordination is emergent, not
   solved; a solver would be both expensive and hive-mind-shaped.
2. **Capability is coarse.** `comboRole` is four buckets, not an ability list with cooldowns. A member
   cannot reason "the frost-bolt is on cooldown so don't wait for it." Right first cut; per-ability
   belief is a later refinement on the same store.
3. **8b prediction is often wrong, by design.** The hold is short and self-correcting; we accept wasted
   half-swings as the cost of legible setups. If the soak shows it costs net DPS, cut `comboHoldMax` to 0
   (8b degrades to pure exploitation, 8a).
4. **Player-led vs NPC-led asymmetry.** A player-led party reads the leader via the sanctioned
   `ctx.partyLeader` handle; an NPC band reads it off belief. The cascade is identical; only the leader
   handle differs (the existing `_leader`/`bandLeaderId` split, unchanged).
5. **Foe-side coordination is out of scope.** Monsters and enemy warbands do not (yet) run the cascade.
   Nothing prevents it — `decideParty` already serves any `groupType:'warband'` — but enemy combos are a
   follow-up so the first build is tunable against a *static* foe baseline.
```
