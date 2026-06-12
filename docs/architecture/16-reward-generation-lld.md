# 16 — Reward generation: the minting (LLD, **design — to build**)

> Status: **DESIGN.** Split from doc 15 (which owns PROGRESSION — when/why a reward is
> earned and what earning costs). This doc owns WHAT gets minted when progression says
> "pay out": the spec grammar, the drama-layer ops, names/provenance, teachability.
> Input contract: the **GrantContext + budget** from [15](15-ability-generation-lld.md)
> — `{ seam, ev, agent, budget }`. Output contract: a validated `AbilitySpec` (ir.ts)
> with `origin` provenance. Rule R1 (an op ships only with its consumer — the slow
> lesson) is THIS doc's law; rule M0 (risk-priced qualification) is doc 15's.

## 3. Effects that make story (the drama-layer ingredient pool)

Admitted under R1 (an op ships only with its consumer — the slow lesson stands):

- `plant_belief` charm/rumour (consumers live: standing/suspicion/gossip; rumours then
  GROW in the telling via hearsay garbling — a cast is a story seed, not a stat).
- `mark` — own-belief suspicion/track of a target (consumers: avoid/pursuit/caution).
- `rally` — lower allies' `mood.fear` in area (consumer: fear reads in decide/flee;
  the faith miracle already writes this channel).
- `bless`/`curse` — standing/fear/shield deltas **conditioned on faith state**
  (consumer: FAITH; a curse on a believer whose god is strong may fizzle — god-checks).
- `denounce` — a public plant_belief against a TARGET (area = crowd; consumer:
  witnessDeed/notoriety/the accused arc — the Director's falseWitness becomes castable).
- `oathbind` — arm an obligation on a consenting target via the LEDGER (consumer:
  obligations.ts — a sworn bargain with a real lapse/default fold).
- Anti-pool unchanged (weather/summons/teleport — no consumers, no story here).

**Story-state `when` conditions** (all OWN-state/belief reads — epistemically clean):
`while_faithful(god)`, `while_oaths_kept`, `vs_sworn_foe` (subjectId of a live avenge
goal), `near_home` (homeBelief pos), `near_shrine(own god)`, `while_unhoused`,
`while_poor/wealthy`. A condition is the character's commitment made mechanical —
and its FAILURE is content: the chronicle notes the first time a cast fizzles because
the wielder broke faith.

## 5. Teachable skills: the recipe machinery, reused

A generated spec may be flagged `teachable`. Teaching rides `recipeKnow.ts` semantics
EXACTLY (graded knowledge, practice, forgetting, conserved tuition): an apprentice
half-knows `[The Frost Family Rendering]` until practiced; a House technique dies with
its last practitioner (the chronicle can mourn it); learning.js's observe/ask/study
verbs apply. This is the dynasty/mentorship arcs' missing payload — a thing of value
that passes down lineages and can be LOST.

## 5b. Worked examples (the DSL, concretely)

All in the real IR (`ir.ts spec()/effect()`); **NEW IR surface is marked** — `header.requires`
(story-state cast conditions, own-state/belief reads only), `spec.origin` (provenance),
`spec.teachable`, and ops `rally`/`denounce`/`oathbind`/`produce_boost`/`mark` (each admitted
with its named consumer, R1). Everything else is today's validated shape and LIMITS.

```js
// 1. BORN FROM STORY — survived a near-death (memory:survived fold). The self-cast
//    path (integration batch) fires it at low hp; the biography cites the night.
spec({
  id: 'evt_survived_842',
  name: '[The Day I Did Not Die]',
  tier: 1,
  origin: { seam: 'memory:survived', withId: 342, t: 1241,                     // NEW
            text: 'earned the day Raider 342 left them bleeding at the north gate' },
  header: { target: 'self', range: 0, cooldown: 90,
            area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('heal',   { amount: 40, when: 'caster_hp_below', tags: ['RESTORE', 'GRIT'] }),
    effect('shield', { amount: 20, dur: 6, tags: ['GRIT'] }),
  ],
  grantsTags: ['SURVIVE', 'RESOLVE'],
})

// 2. COMMITMENT MADE MECHANICAL — granted when an avenge oath is KEPT; the rider only
//    wakes against a subject of a LIVE avenge goal (own goal-stack read — no truth).
//    Melee: rides the swing, block-aware. Dormant in ordinary brawls; the ability IS
//    the grudge. The grant files: "Tomas will not forget — he carries [Sworn Over
//    Cael's Body] now."
spec({
  id: 'evt_oathkept_109',
  name: "[Sworn Over Cael's Body]",
  tier: 2,
  origin: { seam: 'oath:avenge:kept', withId: 109, text: 'a vow kept in blood; the edge remembers' },
  header: { target: 'enemy', range: 2.6, cooldown: 18,
            area: { kind: 'self' }, delivery: { kind: 'instant' },
            requires: [{ kind: 'vs_sworn_foe' }] },                            // NEW
  effects: [
    effect('damage', { amount: 55, tags: ['MELEE', 'VENGEANCE'] }),
    effect('stun',   { dur: 1.5, when: 'on_hit', tags: ['DREAD'] }),
  ],
  grantsTags: ['ATTACK', 'OATH'],
})

// 3. A GOD'S BOON — granted to flock members when their shrine is raised. The first
//    heal-OTHER NPCs can cast (support path). `while_faithful` is the commitment:
//    apostasy makes the next cast FIZZLE, and the chronicle notes "Om's Mercy left
//    her hands." `rally` lowers the target's mood.fear (consumer: the flee/decide
//    fear reads — the channel the faith miracle already writes).
spec({
  id: 'evt_shrine_om',
  name: "[Om's Mercy]",
  tier: 1,
  origin: { seam: 'faith:shrine_raised', text: 'given at the raising of the shrine of Om' },
  header: { target: 'ally', range: 6, cooldown: 30,
            area: { kind: 'self' }, delivery: { kind: 'instant' },
            requires: [{ kind: 'while_faithful', god: 'Om' }] },               // NEW
  effects: [
    effect('heal',  { amount: 30, tags: ['RESTORE', 'HOLY'] }),
    effect('rally', { amount: 0.4, tags: ['HOLY'] }),                          // NEW op
  ],
  grantsTags: ['FAITH', 'MEND'],
})

// 4. MAKES STORY WHEN USED — the castable false-witness, event-born from a `betrayed`
//    episode. `denounce` plants a belief about the TARGET in every perceived bystander
//    (+suspicion toward the target); each bystander then gossips it onward and the
//    hearsay GARBLING grows it — one cast can curdle into a town-wide false hostility
//    (the accused arc's seed, emergent instead of Director-injected). `in_crowd`
//    requires >=2 perceived bystanders (own perception).
spec({
  id: 'evt_betrayed_233',
  name: '[The Quiet Word]',
  tier: 2,
  origin: { seam: 'memory:betrayed', withId: 233, text: "learned what a friend's smile is worth" },
  header: { target: 'any', range: 6, cooldown: 45,
            area: { kind: 'circle', r: 6 }, delivery: { kind: 'instant' },
            requires: [{ kind: 'in_crowd' }] },                                // NEW
  effects: [
    effect('denounce', { amount: 0.5, tags: ['SLANDER'] }),                    // NEW op
  ],
  grantsTags: ['SOCIAL', 'CUNNING'],
})

// 5. A DEAL WITH TEETH — oathbind arms a repay-obligation on BOTH parties' ledgers
//    via obligations.ts (amount = gold, dur = expiry). The ledger already owns
//    discharge/lapse/DEFAULT folds — a broken pact feeds creditLoad ("known to
//    default"), so the speaker's ability mints real social consequence, not a buff.
spec({
  id: 'gen_speaker_t2_pact',
  name: '[Handshake Like Iron]',
  tier: 2,
  header: { target: 'any', range: 2.5, cooldown: 60,
            area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('oathbind', { amount: 5, dur: 300, tags: ['PACT'] }),               // NEW op
  ],
  grantsTags: ['SOCIAL', 'LEAD', 'PACT'],
})

// 6. TEACHABLE AND MORTAL — a House technique. `teachable` rides recipeKnow grading
//    exactly (half-learned, firmed by practice, forgotten unpracticed, conserved
//    tuition). It can pass down the Frost line or die with its last practitioner —
//    and the chronicle can mourn it. `produce_boost` is the master_craft hook
//    (a skillMul window on produce()), generalised into an ingredient.
spec({
  id: 'house_frost_rendering',
  name: '[The Frost Rendering]',
  tier: 2,
  teachable: true,                                                             // NEW
  origin: { seam: 'house:technique', house: 'Frost', text: 'the Frost family secret, three generations old' },
  header: { target: 'self', range: 0, cooldown: 40,
            area: { kind: 'self' }, delivery: { kind: 'instant' } },
  effects: [
    effect('produce_boost', { amount: 1.6, dur: 10, tags: ['CRAFT', 'SECRET'] }), // NEW op
  ],
  grantsTags: ['CRAFT', 'MASTERY'],
})
```

And a `NARRATIVE_GRANTS` row (the data table the seams read — rows, never branches):

```js
registerNarrativeGrant({
  seam: 'oath:kept', oathKind: 'avenge',
  graceSec: 600,                                  // at most one event-grant per agent per 10 sim-min
  theme: { archetype: 'combat', requires: [{ kind: 'vs_sworn_foe' }] },   // fed to the §6 machinery
  name:       (ev, nameOf) => `[Sworn Over ${nameOf(ev.victimId)}'s Body]`,
  provenance: (ev, nameOf) => `a vow kept in blood for ${nameOf(ev.victimId)}`,
  beat:       (a, sp) => `${a.name} will not forget — they carry ${sp.name} now.`,
});
```

The contrast that motivates all of it: the grind path still mints `[Greater Timber
Cleave]` (signature-named, shared world-wide, perfectly fine) — but the ceiling is an
ability whose NAME is a memory, whose CONDITION is a commitment, and whose USE starts
rumours. The codex stops being a stat sheet and becomes a second biography.

## 6. The generation pipeline (how §5b's "handmade-looking" specs get MADE)

The §5b examples are TARGETS, not authored content. They are produced by a five-stage
pipeline whose only authored parts are **vocabulary tables** — the trope-catalog move:
~50 rows of patterns generate effectively-unique personal abilities because the
BINDINGS are real story facts. What is authored vs generated:

| authored (data rows, once) | generated (per grant, seeded) |
| --- | --- |
| `SEAM_THEMES` (~9 rows: seam → archetype weights, condition candidates, emotional register) | which archetype/form/ops this grant gets |
| ingredient pools + `GEN_COST` (~20 rows) | the clause assembly + every number |
| `NAME_LEXICON` (~6 patterns per seam/register) | the name, with event bindings filled in |
| provenance templates (1-2 per seam) | the origin string, re-renderable from ids |

**Stage 0 — the GrantContext** (assembled free at the fold site — the fold already holds it):
```js
{ seam: 'oath:kept',
  ev:    { kind: 'avenge', culpritId: 508, victimId: 109, t: 1659, townId: 2 },
  agent: { tags: dominantProfileTags(a), faith: a.faith, house: a.house,
           personality: a.personality, tier: tierFor(a) } }
```

**Stage 0b — encounter deed-tags** (doc 15 M0b): when the GrantContext carries an
`improvised` feat, the deed-tags from WITHIN the encounter window (e.g. FLEE → CRAFTING
→ KILL-with-crafted-instrument, diffed off the M0 start snapshot) JOIN the theme vote —
the minting reflects what actually HAPPENED, not just who the agent was. The ambushed
alchemist's grant comes out a craft-combat hybrid (`[Brewed at a Dead Run]`, provenance
"mixed while the raider's footsteps closed", optionally a `while_carrying_ingredients`
condition), never a generic warrior skill. Resourcefulness pays mostly in identity.

**Stage 1 — THEME** (`SEAM_THEMES[seam]`, a data row): archetype weights (oath:kept →
combat .7 / cunning .3, tilted by personality — a timid survivor's grant leans
defensive, a bold one's leans reckless), the CONDITION candidates this seam offers
(`vs_sworn_foe` here; `while_faithful{god:ev.god}` on the faith seam; `near_home` on
the home seam), and the REGISTER (vengeance/grief/grit/guile) that selects the name
lexicon.

**Stage 2 — CLAUSES** (the budget grammar): seeded stream from
`fnv1a(agentId|seam|ev.t)` picks FORM × PRIMARY × RIDER from pools filtered by the
theme. **The load-bearing rule: a `requires` condition REFUNDS budget** — `vs_sworn_foe`
refunds ~60%, `while_faithful` ~35%, `in_crowd` ~25% (rows in `GEN_COST`). This is the
narrative economics that makes generated output read like the handmade targets:
the system is PAID to bind an ability to the wielder's story, so event-mints naturally
come out "strong but committed" instead of flat stat-ops. (Class-milestone mints have
no event to bind to ⇒ no refund ⇒ the grind path stays the modest floor, by the math
rather than by fiat.)

**Stage 3 — NAME** (`NAME_LEXICON[seam][register]`, pattern rows with event slots):
oath:kept/vengeance carries patterns like `Sworn Over {victim}'s Body`,
`{victim}'s Due`, `What I Owed {victim}`, `The Debt Paid at {place}`; memory:survived
carries `The Day I Did Not Die`, `{culprit}'s Mistake`, `Blood on the {place} Road`.
Seeded pick; slots filled from the ev ids (re-rendered live by `nameOf`, so a renamed
epithet propagates). Unfillable slot ⇒ fall back to the signature-derived mechanical
name (R2 floor). Authored: ~patterns. Generated: the cross product with real names,
places, and gods — which is why two agents almost never carry the same personal name.

**Stage 4 — PROVENANCE + FILING**: origin template filled the same way, stored
structured (`{seam, withId, t, text}`); chronicle beat from the grant row; a
`milestone`-grade memory on the agent (the grant is itself an episode — feedable to
salient()/biography with zero extra machinery).

**Stage 5 (optional, the LLM side-channel)**: the IR was designed for "emitted by an
LLM, gated by validate()" and the Gazette already does LLM-with-template-fallback
(`js/ai/llm.js`). The mechanical spec is ALWAYS the deterministic stages 1-2; the LLM
may only re-flavour stage 3-4 strings from the GrantContext, browser-side, validated,
template fallback. Flavour is the one place hallucination is harmless.

**Worked trace** — the §5b example produced, not authored. Input: Tomas (bold .8,
tags MELEE/KILL) keeps avenge oath on culprit 508 sworn for victim 109 ("Cael"), t=1659.
- S1: oath:kept → combat (bold tilts .7→.85); condition candidate `vs_sworn_foe`;
  register `vengeance`.
- S2: seed fnv1a('184|oath:kept|1659') → FORM melee-instant (MELEE tag bias);
  PRIMARY damage; budget B(2)=40.5, `vs_sworn_foe` refunds 60% → 64.8 → damage 55
  (+1.0/pt) + rider stun 1.5s on_hit (the rest); cooldown floor 18.
- S3: vengeance lexicon, seeded pick #1 → `Sworn Over {victim}'s Body` → victim 109
  = Cael → `[Sworn Over Cael's Body]`.
- S4: origin `{seam:'oath:avenge:kept', withId:109, t:1659, text:"a vow kept in blood
  for Cael"}`; beat "Tomas will not forget — he carries [Sworn Over Cael's Body] now."
Byte-identical to the handmade target, from a 1-row theme, a 4-pattern lexicon, and
the event itself. Determinism: same agent/seam/event ⇒ same spec, replay-stable.

Mechanical-signature dedup is shared with the grant-suppression fn; `ir.validate` +
LIMITS remain the trust boundary for every mint, whatever the stage-5 flavour did.

## 7. Phases (generation side)

| phase | content | acceptance |
| --- | --- | --- |
| **G1** | grammar core behind `generateAbility` (existing ops only) + story-state `requires` + `spec.origin`; signature naming; dedup shared with the grant-suppression fn | determinism (same identity ⇒ byte-equal), validate() on every mint, names-per-signature = 1; every spec answers "where did you learn that?" |
| **G2** | drama ops (`rally`/`mark`/`bless`/`curse`/`denounce`/`oathbind`-as-OFFER) each with its named consumer; M9 requires-preflight on the NPC cast path | per-op consumer asserts; no-op cast rate stays 0 |
| **G3** | teachable skills via recipeKnow; House techniques; loss surfaced; optional LLM flavour stage (template fallback, validate-gated) | a technique taught, practiced, forgotten, and mourned in a fixture |

**Eval**: promote the ability probe → `test/abilityprobe.mjs`: distinct signatures,
names-per-signature (= 1), casts by op, no-op rate (= 0), % of held abilities with
non-class provenance.

## 8. Risks

- Balance concentrates in `GEN_COST` (config) — including the M1 rule: condition
  refunds MULTIPLY, cap 70%, max 2 conditions per spec.
- Generation runs at grant time only; deterministic (seed recorded on the spec).
- The LLM stage may touch ONLY flavour strings (names/provenance), never mechanics.
