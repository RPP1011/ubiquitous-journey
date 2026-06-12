# 15 — Interesting ability generation (LLD, **design — to build**)

> Status: **DESIGN**. The integration fixes this plan assumes (slow consumed by locomotion,
> `plant_belief` charm sign, NPC self-casts, haggle/master_craft hooks, duplicate-grant
> suppression) are being landed separately; this doc specifies the **generator redesign**
> that follows them. As-built today: `js/rpg/abilities/generate.ts` (3 fixed archetype
> templates), audited 2026-06-12.

## 1. The findings this answers

A live audit (15 sim-min, seed 7; `test/scratch-abilityprobe.mjs`) measured:

- 141/149 living NPCs hold abilities; 707 casts by 190 casters — the **plumbing works**
  (grants, cooldowns, determinism, melee-rides-the-swing, resolver bridge).
- But the generator mints from **three fixed templates** with coin-flip variety: every
  utility-class t1 that rolls "control" is the byte-same slow under a different
  seed-picked name (5 nouns × 6 adjectives per archetype). `[Lesser Gambit]`,
  `[Lesser Sleight]`, `[Lesser Whisper]` are routinely one op wearing three names —
  and a multi-class agent rotates 2–3 identical specs on independent cooldowns.
- Tier scaling (1.18^t) under-delivers its adjectives ("Grand" ≈ 1.9× "Lesser").
- The largest NPC cast block (340/707) was a **no-op** (`slow` had no consumer) — the
  defining failure mode this design legislates against.

## 2. Design rules

1. **R1 — an op ships only with its consumer.** No effect may be added to the generator's
   ingredient pool unless something in the sim demonstrably *reads* its output (the slow
   lesson). The ingredient table names its consumer, the test asserts it.
2. **R2 — names mirror mechanics.** Two specs with the same mechanical signature get the
   same name everywhere; a name difference implies a mechanics difference. (Names derive
   from the signature, so this is structural, not policed.)
3. **R3 — budgeted composition.** A tier grants a power BUDGET; ingredients *spend* it.
   Same tier ⇒ same budget ⇒ balance; different spends ⇒ genuinely different abilities.
4. **R4 — tags are data rows.** A `TAG → ingredients` table (the verbs-are-data
   convention): adding flavour for a new tag = adding a row, never editing builder code.
5. **R5 — tiers add CLAUSES, not just numbers.** t1 is a plain op; t2 adds a rider; t3
   upgrades the area/delivery; t4+ adds a condition or second rider. Progression reads as
   *new behaviour*, not +18%.
6. **R6 — determinism stands.** Seeded stream from `fnv1a(classKey|tier|salt)` as today;
   no `Math.random`, no `Date`. Same identity ⇒ byte-identical spec (headless suite stays
   reproducible).

## 3. The grammar (replaces the 3 templates)

A generated spec is assembled, not selected:

```
spec = FORM (target × delivery × area)
     × PRIMARY op (+ amount, from budget)
     × RIDER op (t2+: a second effect, `when`-conditioned)
     × SPICE (t4+: a third clause or a form upgrade)
```

drawn by the seeded stream from **ingredient pools voted in by the class's tags**:

| archetype (split from today's 3) | tag voters | primary pool | rider pool |
| --- | --- | --- | --- |
| combat   | MELEE/KILL/RISK/BERSERK/DUEL | damage | knockback, slow*, stun, dash-in |
| defensive| DEFENSE/HEAL/FLEE | shield, heal(self), heal(ally) | haste*, fear-calm (rally) |
| craft    | SMITHING/CRAFTING/TOOLMAKING/FARMING/MINING/WOODCUT/FORAGE | produce-boost (master_craft hook) | tool-wear ease, gather haste* |
| trade    | TRADE/PROFIT/HAGGLE/BARTER | price-edge (haggle hook) | scry |
| social   | PERSUADE/CHARM/GOSSIP/LEAD | plant_belief(charm −) | scry, rally |
| cunning  | DECEIVE/STEALTH | plant_belief(rumour +), mark | slow*, scry |

`*` = consumers exist only after the integration fixes (slowFactor read by locomotion;
`haste` is the same field with factor > 1 — **one mechanism, two ingredients**).

**New ops admitted under R1** (each names its consumer):
- `haste` — `slowFactor > 1` on the (now-consumed) movement-speed read.
- `rally` — reduce `mood.fear` on allies in area (consumer: the fear reads in decide/flee;
  the FAITH miracle already writes this field, so the channel is proven).
- `mark` — raise the caster's *own* belief suspicion/track of the target (consumer: the
  suspicion/avoid/pursuit paths; epistemically clean — writes the caster's mind only).
- `produce-boost` / `price-edge` — the master_craft/haggle own-state hooks from the
  integration batch, generalised into ingredients any craft/trade class can mint.

**Explicit anti-pool** (no consumer ⇒ not admitted): weather, light, summons, teleport.

## 4. Budget math

`B(t) = 30 · 1.35^(t−1)` (steeper than today's 1.18 — tiers should feel earned), clamped
by `ir.LIMITS` at spend time. Ingredient costs come from a `GEN_COST` table (config-side,
`rpgconfig.ts`): e.g. damage 1.0/pt, heal 1.1/pt, shield 0.9/pt, rider ops flat-cost by
duration, area upgrades (self→cone→circle) multiply primary cost ×1.4/×1.8, projectile
delivery ×1.2. The stream spends the budget greedily through the clause order (R5);
leftover budget buys cooldown reduction (floor in LIMITS). Balance lives in ONE table.

## 5. Names from signatures (R2)

`signature = hash(target, delivery.kind, area.kind, [op, round(amount), round(dur), when]…)`
(the same canonical signature the duplicate-grant suppression uses — one function, shared).

Name = `[TierAdj + Epithet + OpNoun]` where:
- TierAdj: today's ladder (Lesser → Peerless);
- OpNoun: from the PRIMARY op + form (damage+cone = "Cleave", damage+projectile = "Bolt",
  shield = "Ward", produce-boost = "Craft", price-edge = "Bargain", plant_belief− =
  "Charm", plant_belief+ = "Whisper", mark = "Eye", rally = "Banner"…);
- Epithet: from the strongest VOTING tag ("Timber", "Harvest", "Forge", "Ledger",
  "Silver", "Shadow"…) — identity shows in the name.

Identical signature ⇒ identical name (the noun/epithet derive from signature + tag vote,
both deterministic) — so the world's three identical cleaves are all `[Greater Timber
Cleave]`, and the codex/biography can say "knows [Greater Timber Cleave]" as a SHARED,
diegetic skill. Distinct mechanics can no longer hide behind distinct names.

## 6. Phased build (each phase gate-green, committed separately)

| phase | content | gate |
| --- | --- | --- |
| **P1** | grammar core behind the same `generateAbility(cls, tier)` API: archetype split, ingredient pools (existing ops only), budget table, signature-derived names; reuse the dedup signature fn | determinism test (same identity ⇒ byte-equal), `ir.validate` on every mint, **distinctness metric**: across the live class set, unique signatures ≥ 12 and names-per-signature = 1 (abilityprobe extension) |
| **P2** | new ops `haste`/`rally`/`mark` + the craft/trade ingredient hooks (produce-boost, price-edge generalised) — each with its consumer named + asserted | per-op consumer tests (speed actually rises; fear actually falls; suspicion actually moves); no-op cast rate = 0 in the probe |
| **P3** | shared-skill surfacing: classCodex/biography list known skills by name; (stretch) a skill as a `Know(topic)` so learning.js can teach/gossip it | UI read-only; epistemic scan clean |

**Eval tool**: promote `test/scratch-abilityprobe.mjs` → `test/abilityprobe.mjs` and extend
it to print: distinct signatures, names-per-signature (must be 1), casts by op, and the
no-op cast rate (must be 0). That probe is the acceptance test for "interesting": more
distinct *behaviours* in the wild, not more names.

## 7. Risks / non-goals

- **Balance** concentrates in `GEN_COST` — tune there, never in builder logic (CLAUDE.md).
- Generation runs only at grant time (a few per agent-life) — perf is a non-issue.
- No persistence concerns (nothing saves specs).
- Non-goal: player-facing ability *acquisition* changes; milestones/tiers stay as built.
