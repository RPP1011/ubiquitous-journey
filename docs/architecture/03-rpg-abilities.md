# 03 — The RPG event spine: deeds → classes → abilities

> How a swing of a sword becomes XP becomes an emergent class becomes a granted
> ability you can cast. One shared synchronous bus carries every meaningful deed;
> progression accretes those deeds into identity. Abilities are data-only IR — no
> `eval`, ever.

## The shared event bus (`js/rpg/events.js`)

Every meaningful deed — strike, kill, buy, sell, forge, produce, gather, cast — is
published as an **ActionEvent** on one shared synchronous bus:

```js
{ actorId, verb, tags: [string], magnitude, targetId?, t }
```

- `makeEvent(spec)` normalises and `sanitizeTags` the tag list to the known vocabulary.
- `bus` is a single shared `EventBus` singleton; `emit(spec)` builds + emits.
- `EventBus.emit` iterates a **snapshot** of its listener array, so a listener can
  unsubscribe mid-dispatch and re-entrant emits (an `onEvent` that emits again) are
  safe. Errors are caught per-listener — one bad subscriber can't break the sim.

## Routing deeds to progression (`js/sim/deedRouter.js`)

`Simulation`'s constructor installs **one** router: `installDeedRouter(sim)` subscribes
to the bus and delivers each event to `sim.agentsById.get(ev.actorId).progression
.onEvent(ev, t)`. It returns an unsubscribe handle stored as `sim._busOff`.

`recordDeed(sim, agent, ev)` mirrors salient deeds into autobiographical memory (kill,
sell, buy, QUEST_DONE, class_gained, recruited) and routes narrative XP for windfalls.

### ⚠️ Subscriptions stack — `dispose()` is mandatory

The bus is a process-wide singleton. Every `new Simulation` adds a router to it. If a
world is rebuilt (reset, test reset) without calling `Simulation.dispose()` (which
runs `this._busOff()`), the **old** router stays subscribed and a single deed routes
to *two* progressions — XP multiplies, classes mis-grant. `buildWorld` calls
`dispose()` on teardown; tests call it between sub-sims. **Never skip it.**

## Progression: deeds accrete into identity (`js/rpg/progression.js`)

One `Progression` per agent. It turns the deed firehose into emergent classes, levels,
and abilities.

State:
- `behavior_profile` — `tag → accumulated weight` (magnitude-scaled, clamped to
  `RPG.profileMax`). This is the agent's behavioural fingerprint.
- `classes` — `Map<key, {key, name, level, xp}>`.
- `abilities` — `Map<abilityId, AbilitySpec>`; `cooldowns` — `Map<abilityId, usableAt>`.
- `_milestonesFired` — `Set<"classKey@level">` so an ability grant fires at most once.
- `totalLevel` — cached, capped at `RPG.totalLevelCap`.

Core methods:
- **`onEvent(ev, now)`** — per deed: accumulate tags into the profile, compute a
  *significance* multiplier (novelty / risk / anti-grind), then route XP to the top-K
  best-matching held classes (`RPG.routeTopK`).
- **`tick(now)`** — ~6 Hz from the sim loop: decay the profile
  (`RPG.profileDecayPerSec`), and on a throttle (`RPG.matchIntervalSec`) run the heavy
  class matcher.
- **`_awardXp(cls, amount, now)`** — add XP, level up along the `xpForLevel` curve,
  fire `_checkMilestones` on each level, emit a `level` event (with **empty tags**, so
  the router's `onEvent` does no XP work — an intentional no-op signal).
- **`_runMatcher(now)`** — gated by `maxClasses` / `consolidateLevel` /
  `behaviorSumGate`, calls `matchClasses(profile, held)` and grants newly-qualifying
  templates; falls back to a **procedural** class if the profile is strong but matches
  no template.
- **`_checkMilestones` / `_milestoneSpec`** — at tier crossings (`RPG.tierLevels =
  [1,5,10,20]`) resolve an ability spec: first a hand-authored `CLASS_MILESTONES`
  override, else a procedurally `generateAbility`'d spec, re-validated through `ir.js`.
- **`addNarrativeXP(salience, now, mult)`** — grind-immune story XP (near-death
  survival, windfalls), routed to the single best-matching class so a storied life
  visibly levels.

### Why the catalog import is lazy and fault-tolerant

Progression imports `abilities/catalog.js` + `abilities/generate.js` **lazily and
defensively**. If they're absent or broken, progression degrades to "no abilities" and
keeps accreting classes/levels. **Do not make Progression hard-depend on the catalog.**

## Classes (`js/rpg/classes.js`, `js/rpg/tags.js`, `js/rpg/xp.js`)

- **`CLASS_TEMPLATES`** — 12 hand-authored classes (warrior, brawler, duelist, farmer,
  woodcutter, miner, blacksmith, merchant, speaker, trickster, hunter, survivor). Each
  is `{key, name, requirements: [[tag, threshold]…], score_tags: [[tag, weight]…]}`.
  **Identity is what you make** (the merchant-monoculture fix): raw `GOODS` rows carry
  ONLY their craft tag (ENDURANCE was on every row and became most agents' top tag,
  blurring every producer into survivor/merchant mush), and `[Merchant]` requires
  `TRADE 10` — every soul trades, so the low bar had made it the universal class
  (measured: 103/140 primary); only a dedicated trader earns the name now.
- `meetsRequirements` / `classMatchScore` (a sigmoid over the weighted dot of profile
  vs `score_tags`) / `matchClasses(profile, held)` → newly-qualifying grants, best
  first.
- `proceduralKey` / `proceduralName` mint a stable `proc:COMBO` class + `[Adjective
  Base]` name from the top-2 profile tags when no template fits — this is why classes
  are *emergent*, not a fixed list.
- `tags.js` — the frozen tag vocabulary, `comboKey(tags)` (FNV-1a hash of sorted tags)
  for significance bookkeeping, and `sanitizeTags`.
- `xp.js` — `xpForLevel(level, totalLevel)` (gentle curve so narrative XP converts to
  levels and routine grind plateaus), `significance(ev, prog, now)` (novel-combo,
  KILL, RISK multipliers minus a recency-decayed anti-grind term, clamped to
  `RPG.sigCap`), and `xpFromEvent(score, sigMult)`.

All RPG curves/caps live in **`js/rpg/rpgconfig.js` (`RPG`)** — tune there.

## Abilities are data-only IR (`js/rpg/abilities/`)

No ability ever reaches arbitrary code. An ability is a pure-data `AbilitySpec`
dispatched through a fixed `EFFECTS` map.

- **`ir.js`** — the spec shape, `spec()`/`effect()` builders, `validate(s)` (the
  **trust boundary**: whitelists `EFFECT_OPS`, `AREA_KINDS`, `DELIVERY_KINDS`,
  `TARGET_KINDS`, `TRIGGERS`, and hard numeric `LIMITS`), and `isMelee(s)`.
  ```
  { id, name, classKey?, tier,
    header: { target, range, cooldown, castTime, area, delivery },
    effects: [ { op, amount, dur, chance, when, tags } ],
    grantsTags: [string] }
  ```
- **`catalog.js`** — hand-authored `ABILITY_CATALOG` specs + `CLASS_MILESTONES`
  (`classKey → {level: abilityId}`, e.g. `warrior: {1: power_strike, 4: lunge, 8:
  second_wind}`).
- **`generate.js`** — `generateAbility(classInfo, tierIndex)` deterministically mints a
  validated spec (seeded by `fnv1a(classKey|tier|salt)`), classifying a combat /
  defensive / utility archetype from dominant tags and clamping every number to
  `LIMITS`. This is how procedural classes still get abilities.
- **`interpreter.js`** — `castSpec(spec, caster, ctx)`: validate → gate on cooldown →
  resolve targets by area/range/target-kind → dispatch effects → set cooldown → emit a
  `cast` event. Cooldowns live on `agent._abilityCd` (authority) and mirror onto
  `progression.cooldowns` (UI).
- **`effects.js`** — the `EFFECTS` op map: `damage`, `heal`, `stun`, `slow`,
  `knockback`, `dash`, `shield`, plus the theory-of-mind ops `plant_belief` (write a
  false belief into a target) and `scry` (copy a target's beliefs into the caster).

### Melee specs don't cast — they arm the swing

This is the key seam between abilities and combat. `isMelee(spec)` is true for
enemy-targeted, instant-delivery, short-range (≤3.0) specs. For those, `castSpec` does
**not** fire an effect; it arms `caster.fighter.pendingSpec`. Then `combat.js`
(`resolveCombat`) applies the spec's `damage` op via `EFFECTS.damage` **when the blade
actually lands** — so the ability is block-/shield-aware and respects hit timing.
`pendingSpec` clears after one swing (landed or not — no side effect if it whiffs).
Non-melee specs fire immediately from the interpreter.

## Combat itself (`js/combat.js`, `js/fighter.js`, `js/headlessFighter.js`)

- `resolveCombat(fighters, isHostile, ctx)` samples each attacking fighter's weapon
  points against target torsos within the active swing window, gated by `isHostile`
  (ground truth — see [02](02-epistemic-split.md)). On contact: apply `pendingSpec`
  damage if armed, else flat `TUNE.damage`; derive `hit`/`blocked`/`dead`; return the
  event list (which `Simulation.onCombatEvents` then folds back).
- `Fighter` is the swing/block/stagger state machine (`idle → ready → attack → recover`,
  plus `block` and `stagger`) wrapping a KayKit model + `AnimationMixer` + health bar.
  `takeHit(damage, dir)` returns `blocked` (matching block direction) / `hit` / `dead`.
- `HeadlessFighter` is the logic-only twin: identical interface and TUNE-driven hit
  timing, weapon points at chest height to match `torsoCenter()`, no model/canvas. It's
  the [headless-test](08-testing.md) seam.

## Player ability keys

Keys `1-4` are edge-triggered in the frame loop (`playerControls.js`, `CAST_CODES =
['Digit1'..'Digit4']`) and map to slots of `game.sim.player.abilityList()` — the
stable array order of the player's granted abilities. Grants flow `progression
._grantAbility(spec)` → `agent.grantAbility(spec)` (mirrors onto the cast path + UI) →
the [Ability Index UI](07-ui.md) can browse it.

## End-to-end lifecycle (one trace)

```
deed (e.g. strike lands)
  → emit ActionEvent on bus
  → deedRouter → actor.progression.onEvent(ev, t)
  → accumulate tags + significance → route XP to top-K classes
  → _awardXp → level up → _checkMilestones at tier crossing
  → _milestoneSpec (catalog override or generateAbility) → _grantAbility
  → agent.grantAbility → appears in abilityList() → bound to keys 1-4
  → player presses key → castSpec
      → isMelee?  arm fighter.pendingSpec → combat applies on blade-land
      → else      resolve targets → EFFECTS dispatch → emit 'cast'
  → combat outcome → onCombatEvents → folds into beliefs/rep/memory → (new deeds)
```

## Gotchas

- **`dispose()` or XP doubles.** See above — the bus is a singleton.
- **`validate()` is the only gate.** Generated/LLM/authored specs all pass through
  `ir.validate` before they can cast. Keep all new effect ops on the whitelist.
- **Empty-tag self-events are intentional no-ops.** `level`/`class_gained`/
  `ability_gained` events carry `tags: []` so the router doesn't re-award XP for them.
- **The freeze lesson applies here too.** Professionless agents (monsters, player) have
  no inventory/economy; ability and combat code must guard those accesses (see
  [01](01-sim-spine.md)).
