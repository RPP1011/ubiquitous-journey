# Plan: story quests as emergent collisions (wants + affordances)

Status: **direction locked** (decisions below); buildable design. Nothing built yet.
First affordance to build: **capture → the rescue family**.

## Thesis

We want the recognizable quests of fantasy media — slay the beast, rescue the captive,
retrieve the relic, cure the blight, escort the vulnerable — but the sim's whole identity is
that **NPCs act on their own beliefs and goals, not on a script**. So we do *not* model a
quest as a chain of beats we push agents through. A `Quest` object that drives an NPC through
`MUSTER → TRAVEL → CONFRONT → RETURN` makes the NPC a puppet and quietly betrays the premise.

Instead:

> A story quest is the **emergent trace** of agents pursuing their own goals against each
> other in a world that has the right affordances. The "quest" is just the **contract a stuck
> agent posts when its own goal is one it can't achieve alone** — exactly what the QuestBoard
> already does (it "synthesises offers from agents that are genuinely stuck"), and exactly how
> the vendetta already works (the griever pursues the killer *themselves*; it surfaces as a
> quest only when they're outmatched).

So the unit of design is **not** a quest template. It is two much smaller things:

- **A want** — a goal an agent can derive (`motivation.js` `deriveGoals`) and pursue with the
  existing GOAP planner (`planner.js`).
- **An affordance** — a world mechanic that makes the want both *pursuable* and *obstructable*
  (the obstacle must be another agent's agenda, never a scripted gate).

Add those two; the chain writes itself; nobody is railroaded.

## The agency test (governs every affordance we add)

A beat is *agentic* if all four hold. If a subsystem flips an agent's phase regardless of what
the agent would choose, it is a **puppet-step** and is rejected. (Today's `expeditions.js`
`_advance()` is the anti-pattern: it flips `out → hunt → return` *for* the captain. Do not
scale that up.)

1. **Chosen.** The agent enters the beat from its own beliefs, bonds, personality, ambition.
2. **Abandonable.** It can fail, deviate, or abandon and re-plan when the world changes.
3. **Contested by an agenda.** The obstacle is another agent acting for its own reasons.
4. **Open outcome.** The result is not predetermined — the dragon can win.

## The beat grammar (for recognition + narration, NOT as a script)

Read the reference quests side by side and they are chains over a small alphabet. We use this
vocabulary to *recognize and narrate* what emerged (Chronicle/Gazette) and to reason about
coverage — never as a sequence imposed on an agent.

| Beat | What an agent is doing |
|---|---|
| MUSTER | gathering a party/allies for the undertaking |
| TRAVEL | journeying to a place; surviving the road |
| SEEK | finding a clue, a person, a hidden way (investigation) |
| RETRIEVE / DELIVER | getting an object, or carrying it somewhere |
| RESCUE / ESCORT | freeing a captive, or protecting someone to safety |
| CONFRONT | fighting the guardian / named foe |
| TWIST | the giver lied, the reward is cursed, the "monster" was wronged |
| RETURN | bringing it home, claiming the reward, the reckoning |

(TWIST is better thought of as a *property* that decorates other beats than as a beat of its
own — revisit when we have a quest that needs it.)

## Reference quests as wants + affordances

| Reference (media) | Whose **want** | Missing **affordance** |
|---|---|---|
| Slay the beast *(Beowulf)* | a renown-hungry captain; a frightened villager's bounty | *(none — already agentic-capable today)* |
| Rescue the captive *(countless)* | an agent bonded to the captive, believing they're held at X | **capture** — a non-lethal "held" state + a captor reason to take, not kill |
| Retrieve the relic *(the Grail)* | someone who *covets a specific relic* (a god demands it, a smith needs it) | a reason to want a **named** relic, not just "a relic" |
| Cure the blight *(the village plague)* | the kin of the afflicted | a **spreading affliction** + a cure-ingredient in a dangerous place |
| Escort the vulnerable *(the heir)* | a frightened agent who must *get somewhere*; protectors who care | agents with **travel destinations** + a "protect them there" goal |

Each affordance unlocks a whole *family* of stories. Build one at a time; each must pass the
agency test before the next.

---

## Worked example (build first): capture → the rescue family

One affordance + one want. Everything else is existing systems colliding. Unlocks rescue,
ransom, hostage, and prison-break.

### The affordance: capture (a non-lethal "held" state)

- **Where it's born.** The `'dead'` event in `js/combat.js` (derived at the
  `!target.alive` check), routed through `js/sim/combatEvents.js` `onCombatEvents`. When a
  lethal blow lands *and* the attacker has a capture disposition *and* the target is
  capturable, the blow becomes a **subdue**: the target stays alive (health floored) and is
  flagged `{ captive: true, captorId, heldAt }`. A branch in `onCombatEvents` — no new combat
  code.
- **The held state.** The captive is pinned at the captor's camp using the existing pin trick
  (the one `_underground` / `homeAnchor`+leash already use), and its `decide` routes to a
  `captive` no-op the same way `inParty` routes to `_decideParty`. **No AI fork.**
- **The captor's agenda (why take, not kill).** Ransom or leverage. This is load-bearing, not
  flavour: it gives raiders/warlords a non-lethal motive, which is also the anti-massacre
  valve (they stop grinding the town to zero) and *leaves survivors worth rescuing*.

### The want: rescue (a goal on the agent's own stack)

- A capture witnessed by a bonded ally writes a `witnessed_capture` memory. `deriveGoals`
  turns it into `goalRescue(captiveId, captorId, heldAt)` — a direct copy of the
  `avenge`/`grieve` pattern in `js/sim/motivation.js`.
- Goal atoms: `at(heldAt)` + captor `dead`-or-driven-off; predicate = "captive is free." The
  planner already plans `goto` + `attack`; the **only new atom is `freed`** (reaching the
  captive while the captor is down flips `captive=false` and restores the agent).

### The chain emerges — never scripted

A bonded NPC, on its own bravery and belief, forms `rescue`. Outmatched, it recruits help (the
band path) or **posts the contract** (the synth-when-stuck path). The captor defends because
*it* wants the ransom. The captive can self-free if the captor falls. Read back, the trace is
`MUSTER → TRAVEL → CONFRONT → RETURN` — but no subsystem flipped anyone's phase.

| Agency test | Capture/rescue |
|---|---|
| Chosen | rescuer acts on bond + belief; captor chooses to take | ✅ |
| Abandonable | rescuer can die, give up, go recruit; planner re-plans | ✅ |
| Contested by an agenda | captor defends its hostage for its own ransom | ✅ |
| Open outcome | rescue, ransom paid, or captive sold/killed if no one comes | ✅ |

The last row is the **stakes**: an unrescued, unransomed captive is eventually sold or
executed (the captor's own disposition + a timer) — a real, world-changing cost that makes the
rescue matter, and a payoff/consequence that *emerged* rather than being authored.

### Build surface (small)

1. capture branch in `onCombatEvents` (the `'dead'` seam) + a `CAPTURE` config block in
   `simconfig.js` (tuning lives in config, not logic)
2. `captive` held-state pin + the `captive` decide no-op
3. `witnessed_capture` memory kind → `goalRescue` in `deriveGoals`; the `freed` planner atom
4. captor ransom/timeout disposition (the other agenda + the stakes)
5. *(reuses, unchanged)* QuestBoard synth-when-stuck, the band/party path, Chronicle/Gazette

### The captive's own experience (don't forget the third party)

The captive is an agent too. The ordeal should write to its memory (a high-salience `captive`
episode) so that, freed, it can carry its own goals out of it — gratitude toward a rescuer
(`succoured` → `repay`), a grudge toward the captor (`assaulted` → `avenge`). That keeps the
captive agentic rather than a parcel, and seeds the *next* story for free.

## Invariants honoured

- **Freeze lesson.** Every new path guarded; `import` everything referenced; never throw on
  the fixed tick. Captives/captors may be `profession:null` — guard economy access.
- **Epistemic split.** The rescue want is seeded from a *belief* ("I saw them taken to X");
  combat and freeing resolve on ground truth.
- **Closed money loop.** Ransom is a transfer from a payer's own purse — no minting.
- **No AI fork.** `captive` and `rescue` reuse the `decide`-routing + band/planner paths that
  `inParty`, `avenge`, and `delve` already use.
- **Teardown.** Captures release on `dispose()`/world rebuild (restore flags, like
  `_expRestore`/`_bandRestore`).

## Roadmap (one affordance at a time; each passes the agency test first)

1. **capture → rescue** *(this doc)* — also fixes a known low-spot: raiders that take instead
   of annihilate keep the town populated.
2. **coveted relic** — give an agent a *reason* to want a named relic (faith demand / a smith's
   need); reuses dungeons + the existing `delve` goal.
3. **blight** — a spreading affliction + a cure-ingredient at a place; the kin's want is to
   save the afflicted.
4. **escort** — agents with travel destinations + a "protect them there" goal; the caravan
   escort plumbing is a head start.

## Testing

- New `test/suites/capture.mjs` wired into `test/headless.mjs`: a captor subdues a victim;
  assert held state + pin, a bonded ally derives `rescue`, a forced freeing flips the captive
  back, and **gold is conserved** through a ransom. Run `bun test/headless.mjs` for no-regression.
- Expect movement on **NPC-behaviour depth** (`bun test/depth.mjs`) — captures and rescues are
  exactly the cross-system, agent-driven interaction the metric rewards.
</content>
</invoke>
