# 15 — Narrative ability generation (LLD, **design — to build**)

> Status: **DESIGN, v2.** v1 of this doc specified a budgeted clause grammar — more
> mechanical variety per tier. The critique that killed it as a spine: *mechanical*
> variety is not *narrative* interest. A perfectly balanced, deduplicated `[Greater
> Timber Cleave]` is still a stat-op; no one will ever tell a story about it. v2 keeps
> the grammar as assembly MACHINERY (§6) and rebuilds the design around what this sim
> is actually for: beliefs, oaths, grudges, gods, houses, and the chronicle.
> The integration fixes (slow consumed, charm sign, NPC self/social casts,
> haggle/master_craft hooks, dup suppression) land separately and are assumed.

## 1. What "narratively interesting" means HERE

An ability earns its place by passing at least two of these, in this engine's terms:

1. **Born from story** — granted by a formative EVENT, not only a level grind. The
   sim already folds the events: memory episodes (`assaulted`, `witnessed_death`,
   `betrayed`, `home_lost`, `shunned`, `triumph`, `survived`), oath resolutions
   (kept/abandoned), arc closes (`vendetta:fulfilled`, `warband:victorious`,
   `rescue:freed`, `ragsToRiches:celebrated`), faith state, perils survived.
2. **Makes story when used** — the effect lands on the DRAMA layer (beliefs, standing,
   suspicion, fear, oaths, arcs), and a consequential cast files a chronicle beat.
3. **Known about** — other agents hold BELIEFS about it ("they say Garrik never
   misses"); prowess-reputation feeds real decisions (duel/recruit/caution/flee).
4. **Teachable / inheritable** — a skill can travel master→apprentice, die with its
   last holder, or run in a House — the graded-recipe machinery already does exactly
   this for crafts (`recipeKnow.ts`: half-learned, forgotten, conserved tuition).
5. **Conditioned on commitments** — it works only while the wielder's story-state
   holds (faithful to the god, oaths kept, near the home hearth, against the sworn
   foe). Losing it is a beat: "the [Om's Mercy] left her hands."

The v1 acceptance metric ("≥12 distinct signatures") measured the wrong thing. The v2
metric: **every generated ability can answer "where did you learn that?"** — and the
answer is a real episode, a real teacher, or a real god, surfaced in the biography.

## 2. Grant seams: abilities born from events

Keep class milestones (the grind path). ADD event-born grants on the folds that already
exist — a `NARRATIVE_GRANTS` data table (rows, not branches — the registry convention):

| seam (already folded) | trigger row (example) | granted theme | provenance string |
| --- | --- | --- | --- |
| memory fold (deedRouter) | `survived` ep at <15% hp | defensive (second-wind-like) | "earned the day {culprit} nearly killed them" |
| oath resolution (motivation) | avenge oath KEPT | combat rider vs the culprit's faction | "sworn over {victim}'s body" |
| oath resolution | 3rd oath ABANDONED | cunning (scry/mark) — the faithless get sly | "learned what promises are worth" |
| arc close (sagas) | `vendetta:fulfilled` | mark/pursuit theme | "the feud with {foe} taught it" |
| arc close | `warband:victorious` (leader) | rally | "first raised at the march on {foe}" |
| arc close | `rescue:freed` (rescuer) | heal/ward-other | "carried {captive} out alive" |
| statusSensor | `ruined` (fall from grace) | trade/cunning | "poverty is a thorough teacher" |
| faith | flock member at shrine raise | bless (faith-conditioned) | "given at the shrine of {god}" |
| home | `home_lost` then rebuilt | hearth-ward (home-conditioned) | "no fire takes the second house" |

Rules: one event-grant per agent per N sim-minutes (no spam); the grant FILES a
chronicle beat + a `milestone`-grade memory; the provenance string is stored ON the
spec instance (`spec.origin`) and read by biography/codex/obituary. The event grant
reuses `generateAbility` machinery (§6) with the event supplying the theme + epithet —
so determinism holds (seeded by agentId|eventKind|t, recorded on grant).

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

## 4. Known about: prowess as belief

A new belief field `believedProwess` (0..1) on person-beliefs, folded from WITNESSED
casts/kills (perception/combat bridge — never truth-read), gossiped like standing
(garbling applies: prowess GROWS in the telling — "never misses" was two lucky bolts).
Consumers (each asserted): warband `composeForce`/`warbandStrength` estimates, duel
acceptance, caution's strategy surcharge vs a feared foe, flee thresholds. This makes
an ability something that PRECEDES its wielder — reputation with teeth, and a false
reputation is a story (the braggart whose [Peerless Strike] is hearsay).

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

## 6. Assembly machinery (v1, demoted to the engine room)

The budgeted clause grammar survives as HOW specs are built: FORM × PRIMARY × RIDER ×
CONDITION drawn by seeded stream from tag/event-voted pools; budget `B(t)=30·1.35^(t−1)`
with a `GEN_COST` table in `rpgconfig.ts`; mechanical-signature dedup shared with the
grant-suppression fn; `ir.validate` at the trust boundary; determinism (no Math.random/
Date). Names: class-milestone mints keep signature-derived names (`[Greater Timber
Cleave]`, shared world-wide — R2); EVENT mints get event names from the provenance row
(`[Vow of the Burned Hall]`) — uniqueness is the point there, so signature-sharing is
deliberately waived for them (provenance is the dedup).

## 7. Phases (each gate-green, committed separately)

| phase | content | acceptance |
| --- | --- | --- |
| **P1** | grammar core + story-state conditions on EXISTING ops; `spec.origin` provenance; biography/codex read it | every generated spec answers "where did you learn that?"; determinism + validate tests |
| **P2** | `NARRATIVE_GRANTS` table on the memory/oath/arc/faith folds + chronicle beats; rate-limited | a 30-min seed-7 lifetrace digest shows ≥3 distinct event-born abilities with true provenance; grant beats in the chronicle |
| **P3** | drama ops (`bless`/`curse`/`denounce`/`oathbind`) + `believedProwess` fold/gossip + consumers | per-op consumer asserts; prowess measurably shifts a duel/recruit decision in a fixture; no-op cast rate stays 0 |
| **P4** | teachable skills via recipeKnow; House techniques; loss surfaced | a technique taught, practiced, forgotten, and mourned in a fixture run |

**Eval**: promote the ability probe → `test/abilityprobe.mjs`, extended to print: % of
held abilities with non-class provenance, grant-beat count, prowess-belief coverage,
casts by op, no-op rate (0). The lifetrace digest is the real acceptance: an agent's
life story should NAME its abilities and where they came from.

## 8. Risks

- **Spam/balance**: event grants rate-limited + budgeted like milestone mints; GEN_COST
  is the one balance table (tuning in config — CLAUDE.md).
- **Epistemic cleanliness**: every condition/consumer reads OWN state or beliefs;
  prowess folds on WITNESSED events through the existing perception/gossip bridges;
  god-checks read FAITH truth only inside the faith system (execution), never in decide.
- **Conflict with the running fix batch**: P-phases start after it lands; the signature
  fn and haggle/master_craft hooks it adds are dependencies, not collisions.
