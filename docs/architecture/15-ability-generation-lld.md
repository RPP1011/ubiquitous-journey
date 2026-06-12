# 15 — Narrative progression: the earning economy (LLD, **design — to build**)

> Status: **DESIGN, v3** — this doc was split (user call, 2026-06-12): **15 = PROGRESSION**
> (when/why an agent EARNS a reward, and what earning costs — the economy), **16 =
> [reward generation](16-reward-generation-lld.md)** (what the earned thing IS — the
> minting). The handshake between them is the **GrantContext + budget**: progression
> decides THAT a grant fires and HOW MUCH it is worth (significance, risk-priced);
> generation decides WHAT gets minted. The split is load-bearing: progression can later
> pay out NON-ability rewards (epithets, titles, boons, relationships) through other
> generators against the same earning economy. The OATH ECONOMICS section below is
> **as-built** (commit 42515b6); the rest is design.

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

## 4. Known about: prowess as belief

A new belief field `believedProwess` (0..1) on person-beliefs, folded from WITNESSED
casts/kills (perception/combat bridge — never truth-read), gossiped like standing
(garbling applies: prowess GROWS in the telling — "never misses" was two lucky bolts).
Consumers (each asserted): warband `composeForce`/`warbandStrength` estimates, duel
acceptance, caution's strategy surcharge vs a feared foe, flee thresholds. This makes
an ability something that PRECEDES its wielder — reputation with teeth, and a false
reputation is a story (the braggart whose [Peerless Strike] is hearsay).

## 5. Oath economics (**as-built**, 42515b6 — the first landed piece)

An oath is a COMFORT LOAN with a courage coupon (`OATHS` config; all own-state):

- **Take**: `swearComfortCost` lands immediately; the live-oath counter arms.
- **Hold & honour** (the reward is for KEEPING the word, continuously — not a lump at
  resolution): fear damps faster (`liveFearDamp` — the courage of the committed) and
  boredom builds slower (`livePurposeMul` — a sworn life has purpose), while the
  unresolved vow GNAWS (`gnawComfortMul` on the comfort drain).
- **Kept**: the gnaw lifts, fear breaks, the existing closure XP/triumph pays — and
  (doc 16) `while_oaths_kept` ability conditions stay live.
- **Broken**: PERMANENT — each forsworn vow lowers the comfort ceiling for life
  (`forswornCapStep`, floored: the forsworn sleep poorly, not impossibly), files a
  formative memory ("forsook their vow against X") and marks the biography ("twice
  forsworn"). The SOCIAL leak (others learning) is the betrayal-as-choice feature,
  deliberately separate.

This is the template for pricing other commitments (faith, pacts, house duties):
cost to take, continuous payment while honoured, permanent scar when broken.

## 8a. The munchkin audit (adversarial pass — these are BINDING rules, M1-M10)

We attacked the design as a min-maxer (player or emergent NPC dynamics — the famine
lessons prove the sim "discovers" reward loops statistically). Exploits found, nerfs
specced. Each M-rule gets a regression test in its build phase.

- **M0 — the pricing principle (preferred over caps).** Where a grant rewards a FEAT,
  gate qualification on **risk genuinely borne**, not on counters: feat significance is
  discounted by the safety margin held at ENCOUNTER START (own-state snapshot — the
  caution system's `_snap` pattern), and the reward per qualifying feat stays FLAT.
  Preparation doesn't weaken an earned feat — it makes feats harder to QUALIFY, which
  is the self-balancing economics: the only way to qualify is to genuinely walk in
  exposed, and genuine exposure is priced by the sim itself (you can actually die).
  Caps/graces remain only where the exploited action is zero-risk by construction.

- **M0b — potential is not margin; improvisation is a feat dimension.** (The ambushed-
  alchemist test: unarmed, outclassed, but carrying the makings of a weapon — flees,
  brews mid-flight, wins.) Two rulings: (a) the encounter-start margin snapshot counts
  READINESS (weapons, healing stock), never POTENTIAL (raw materials, recipes known) —
  carrying ingredients neither discounts a feat nor farms one; (b) at resolution, the
  INSTRUMENT of victory is diffed against the start snapshot — an instrument that did
  not exist at encounter start (crafted mid-flight, looted mid-melee, granted seconds
  before) flags the feat `improvised`: a SMALL flat significance multiplier (~×1.25 —
  M0's flat-reward principle must not erode into a cleverness slider), and the flag +
  the encounter's deed-tags ride the GrantContext so the MINTING (doc 16) themes the
  reward as what actually happened — the alchemist's grant is a craft-combat hybrid
  ("[Brewed at a Dead Run]"), not a generic warrior skill. Resourcefulness pays mostly
  in IDENTITY, modestly in size. Munchkin-safe by M0's own logic: the only way to farm
  `improvised` is to genuinely enter fights without your tools — real risk, real feat.
  (Prerequisites: field-crafting is BUILT — the toolset rule: production requires a
  TOOLSET, a site is merely the permanent non-consumable one; a carried tool crafts
  afield, slower + wearing (`ECON.fieldCraftMul`/`fieldCraftWear`, planner waives the
  at(site) leg). The explosive-potion item itself remains future.)
- **M1 — refund stacking.** As drafted, conditions refunded additively: `vs_sworn_foe`
  60% + `while_faithful` 35% + `near_home` 25% = 120% — free power on an ability the
  munchkin engineers one corner-case scenario for. NERF: refunds MULTIPLY as retained
  cost (0.4 × 0.65 × 0.75 ≈ 0.20), hard cap 70% total, **max 2 conditions per spec**.
- **M2 — oath-ditch farming.** Abandoning an oath WAS free (let it expire, 120s), and the
  "faithless get sly" row paid out at 3 abandons — so the optimal play was swear-and-hide
  ×3 for a free scry. NERFS: (a) the faithless grant keys on the CHARACTER, not the count —
  kept-ratio < 0.2 over ≥5 resolved oaths across ≥20 sim-min, **once per life**; (b) §5's
  oath economics (NOW BUILT) makes every abandonment genuinely costly — a permanent
  comfort-ceiling scar per forsworn vow — so farming the faithless grant means buying it
  with lifetime peace of mind. The social leak (others learning) remains the
  betrayal-as-choice feature.
- **M3 — engineered keeps (M0 applied).** Farm grants by provoking weak foes into
  assaulting you, then killing them. NERFS: (a) the keep is RISK-PRICED, not capped:
  significance discounts by the relative threat actually faced (own believed strength +
  band vs the culprit's — the `warbandStrength`/prowess estimates) — a goblin grudge
  prices to ~0, a keep against an outclassing foe pays in full, repeatably; (b) the M8
  same-moment grace; (c) bind `vs_sworn_foe` to the SUBJECT-ID, never the culprit's
  faction (§5b's "culprit's faction" rider is rescinded — faction-wide bonuses are
  munchkin gold).
- **M4 — oathbind usury, and an architecture violation.** As drafted ("arms a repay-
  obligation on BOTH ledgers") a speaker farms strangers at the market for 5g pacts —
  and worse, it WRITES A FOREIGN MIND, violating the Inform pattern (the recruiter
  precedent: no side writes the other's mind). REDESIGN: oathbind is an OFFER the
  target perceives (`_offers`-style mailbox); the target's OWN evaluation (standing,
  surplus, personality) accepts or declines; only acceptance arms both ledgers. The
  munchkin patch and the epistemic patch are the same patch.
- **M5 — survived-farming (M0 applied; the lifetime cap is RESCINDED).** Tank a weak
  monster to 10% hp, potion up, repeat — the exploit is the SAFETY MARGIN, not the
  repetition. Feat significance:
  `S = nearDeathDepth × (1 − mitigationMargin)`, where
  `mitigationMargin = clamp01(potionStockAtEncounterStart × healPerPotion / maxHealth)`
  (snapshot on combat entry, the `_snap` pattern — START stock, so draining potions
  mid-fight cannot manufacture exposure). Grant qualifies at `S ≥ threshold`; reward
  per qualifying feat is FLAT and repeatable — the thrice-ambushed pauper genuinely
  accrues a "nine lives" arc; the potion-cycler's runs price to ~0. The inverse play
  ("go in naked to qualify") is self-balancing: carrying no healing means the death
  risk is REAL — that is the feat. Rides the `perilsSurvived` fold; the M8 same-moment
  grace still applies.
- **M6 — murder-by-rumour economics.** `denounce` → town turns hostile → target dies →
  loot the purse. This is legitimate CONTENT (the false-witness arc, emergent!) but
  needs counterplay: a denounce cast is itself PERCEIVABLE (witnesses remember who
  spoke); the accused arc's exoneration path ('told') then curdles standing/snubs back
  onto the denouncer, and rumour provenance (`rumorBorn`, hops) survives for the
  Patrician/watch to read. Long cooldown + notoriety cost on cast. The munchkin can
  still do it — once, at real risk, which is a story. That is the design goal.
- **M7 — prowess bragging.** `believedProwess` grows in the telling; a braggart casts
  flashy abilities in crowds to inflate reputation. KEEP IT (the braggart is content)
  but add the deflation asymmetry: a WITNESSED defeat/flee crushes believedProwess
  (down-weight ×3 vs up), so a faked reputation carries real risk of a public nosedive
  (and the mockery beat writes itself). Casts with no landed effect fold NOTHING.
- **M8 — multi-fold stacking.** One dramatic moment fires several folds (witnessed_death
  + oath + arc close) → several grants. NERF: global per-agent grant grace (one event
  grant per N sim-min across all seams) + salience priority (the most specific seam
  wins, tier-1-style ordering).
- **M9 — NPC fizzle-spam.** With `requires` conditions live, the NPC cast path must
  preflight them (cheap own-state reads) BEFORE burning a cooldown, or the no-op cast
  rate regresses — the metric the integration batch just zeroed stays a gate.
- **M10 — boost inflation.** Teaching `produce_boost` techniques to everyone inflates
  production. Partially self-balancing (recipe decay unpracticed; tool wear scales with
  throughput — the closed-loop coupling), plus: GEN_COST caps boost magnitude, and a
  technique's grade gates its multiplier (a half-learned rendering is a weak one).
- **Codified, was luck:** grant seams key ONLY on truth-anchored folds downstream of the
  combat bridge's `!A || !T` prop guard — never on raw goal-pops or planted beliefs
  (a believed-person Scarecrow must never mint a grant; pinned by test).

## 9. Phases (progression side; generation phases live in doc 16)

| phase | content | acceptance |
| --- | --- | --- |
| **PR1** | `NARRATIVE_GRANTS` table + GrantContext assembly on the memory/oath/arc/faith folds; M0 risk-pricing (encounter-start snapshots); M8 grace | a 30-min lifetrace digest shows event-born grants with true provenance; the M-rule regression tests |
| **PR2** | `believedProwess` fold + gossip + consumers (warband/duel/caution/flee) with M7 deflation | prowess measurably shifts a fixture duel/recruit decision |
| **PR3** | the betrayal social leak (forsworn becomes knowable) — joins the betrayal-as-choice feature | gossip carries it; standing consequences witnessed |

## 10. Risks

- The earning economy concentrates in the seam table + M-rules — tune rows, never code.
- Every cost/reward is own-state (epistemic-clean); folds are truth-anchored (the
  `!A || !T` prop-guard rule).
- Grant pacing: M8's global grace is the backstop against drama-burst inflation.
