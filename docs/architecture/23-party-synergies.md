# 23 — Party synergies: talk, theory of mind, and bonds

Companions are never commanded; the player controls only their own unit. Party play comes from
three things:

1. **Passive rules** that let ordinary actions combine.
2. **Talk**, the player's way to coordinate indirectly.
3. **Theory of mind** in the AI: each unit predicts its allies, as deeply as their teamwork allows.

There are **no special combo actions**. A "combo" is simply a good sequence of ordinary actions.

## Rules that make ordinary actions combine (`tactics/battle.ts`)
- **Follow-through.** Every action is bracketed by a snapshot of the foes' prone, exposed and
  stunned states. Any that flip on are credited to the actor (`Unit.setBy`). When a *different* ally
  hits that foe, damage ×(1.2 + 0.05·bond). This emits `ev('combo', …, with = setter)`, and the odds
  show `following through (Borin)`. The whole damage multiplier is capped at ×2.2.
- **Pincer.** A melee attack with an ally on the tile directly opposite the target gets DC −2
  (−3 at bond ≥ 2). DC is floored at 5.
- **Dive in.** A lethal blow on one of us: an adjacent friend who hasn't reacted, and who is bonded
  (≥ 2), compassionate (≥ 0.75) or a guardian, rolls finesse + bond vs 12 to take it instead (×0.8).
- **Steady nerve.** Adjacent bonded friends add their bond level to morale grit (max +3).
- **Wrath.** When a bonded friend (≥ 3) goes down, their friends can't break until their next turn is over.

## Talk (`tactics/comms.ts`)
Calling out is free, once per turn. Everyone in earshot hears it (≤ 5 tiles, or ≤ 10 with line of
sight), and that includes foes.
- **Ask.** "Borin, hold the gate", "Pip and Wren, on the archer", "everyone on Garrick", "tell Maud
  to heal you". Each listener weighs the ask in its own utility:
  - A matching (tile, action) gets +0.9 × **willingness**.
  - When nothing matching is in reach this turn, closing in on the target counts partly.
  - Willingness = trust (0.25 + 0.5·loyalty + 0.1·bond; for foes, the speaker's rank), cut when the ask
    clashes with who the listener is: the merciful won't strike the broken, the ruthless won't take
    people alive, the timid won't body-block.
  - Nobody obeys unconditionally. A bad ask loses to a better idea, and a named listener says why
    ("Maud won't — won't strike someone who has given up", "Pip has a better idea: …").
- **Plan.** "I'll shove Garrick", "leave Garrick to me". Allies who act later can now predict you
  exactly.
- **Before you speak,** the reading shows each listener's likelihood ("Pip: likely", "may close in —
  out of reach this turn").
- **Overheard.** A foe who hears a plan against them braces (block/defend +0.35).
- **AI talk too:**
  - Companions call out a foe they've just laid open ("Garrick's down — on them!").
  - Leaders bark focus orders every other round ("Take Maud!").
  - The autopilot announces its setups.

## Theory of mind (`tactics/ai.ts: predictAllies`)
For each ally acting after `u` this round:
- **They announced a plan:** their target is known (weight 1).
- **Otherwise, depth depends on teamwork** = bond + 2·loyalty.
  - At ≥ 2, `u` simulates the ally's turn (`planTurn(…, { predict: true })`: no jitter, no nested
    prediction) and reads off their target.
  - Below that, a shallow guess: the foe nearest them.
- **The player's mind can't be read,** only what they say.

Predictions feed two bonuses:
- **Focus:** +0.35·p·w for attacking a foe your friends will hit.
- **Setup:** +0.55·p·w for an action that lays that foe open. This covers:
  - a shove into an obstacle or ledge
  - an expose, stun or knockback ability
  - a look-behind bluff
  - a thrown flour sack
  - a set-piece that knocks people flat

Attack scoring also values follow-through directly, and position value rewards pincer tiles.

## Bonds (`run/bonds.ts`)
- **Storage:** `SaveData.bonds`, keyed by sorted pair (`'pip|player'`). Levels at xp `[0, 3, 8, 15, 25]`.
- **Growth.** `foldBonds` runs after each stage:
  - save +4, revive +3, combo +1 (at most 3 a battle);
  - both standing after a win +0.5;
  - running while the partner was down −2.
- **Where it shows.** Level changes appear in the stage's growth lines. Bonds install into
  `Battle.bonds` when the party is seated.

## Next
- Rivals (friction flips a bond's kind).
- Pair barks and hub gossip about bonds.
- Foes' teamwork, from how long they've ridden together.
- Trust that moves when the player announces one thing and does another.
