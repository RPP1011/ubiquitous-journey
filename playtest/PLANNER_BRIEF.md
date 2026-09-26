# Planner brief (for model playtesters)

You are playtesting a turn-based tactical RPG (think XCOM / Fire Emblem / Final Fantasy Tactics) where
the player types **free-text orders** ("write-ins") that a parser turns into game actions. Your job is to
think like a creative, reasonable player: come up with high-level plans to win an encounter, then break
each plan down into the individual orders the player would type, one per turn-action.

**Do not look at or read the game's source code.** Plan from the situation file only, the way a player
would from the screen. Do not edit anything except the one output file you are told to write.

## Input
`playtest/situations/<quest>-<stage>.json` — the battle at the player's first turn:
- `objective`, `intro` (story), `units` (name, side us/them/neutral, role, tactic, hp, grid `at` [x,z],
  status), `props` (named objects with positions and what they afford: cover, burnable, climbable…),
  heights, and `actionKinds` (the action vocabulary; the last ten are NOT in the rules yet).
- The grid is 16×16 tiles. "You" is the player; companions (Borin, Wren, Pip, Maud) are on your side.
  You can address a companion by name ("Borin, guard Maud") in high-stakes moments.

## How this game works (read before planning)
- **You control only yourself.** Companions (Borin the shield-bearer, Wren the archer, Pip the
  rogue, Maud the healer) decide for themselves. You coordinate by **talking**, which is free,
  once a turn:
  - ask someone: "Borin, block Fitch", "Pip and Wren, on the archer", "everyone, focus Garrick"
  - announce your own plan: "I'll shove Garrick into the fire — follow up!"

  They may or may not go along with it (trust, character, whether it's sensible).
- **The ground matters.** The situation's `map` shows it row by row (z = 0 first):
  - `#` wall: blocks movement and sight, full cover
  - `"` brush: hides you from far archers and overwatch; it burns
  - `~` water: slow, puts out fire
  - `%` mud: slow
  - `=` stone and `*` snow: don't burn
- **Set-pieces.** `pieces` are the place's one-shot features (a log-pile, a bell, a sluice…).
  Anyone in reach can set one off: "cut the log-pile loose", "ring the bell".
- **Ordinary moves combine.** A foe knocked prone, exposed or stunned by one person takes extra
  damage from the next (follow-through). An ally on the far side of a foe makes it easier to hit
  (pincer). Trip and disarm are basic moves.

## Output
Write **one** JSON file `playtest/atoms/<prefix>-<persona>-<quest>-<stage>.json` (the prefix you are told, default `haiku`):

```json
{
  "persona": "<persona>",
  "plans": [
    {
      "goal": "one line: the high-level approach",
      "steps": ["step 1 in plain words", "step 2", "step 3"],
      "atoms": [
        { "strategy": "<the goal, short>", "capability": "<kebab-case skill>", "text": "<exact order a player would type>", "expect": ["<action kind>", "..."] }
      ]
    }
  ]
}
```

Rules:
- **2 or 3 distinct plans** per stage, true to your persona. Each plan has 3–6 atoms.
- `text` is ONE order, as a real player would type it, using the real names of the units and props in
  the situation file. Vary the phrasing (terse, chatty, conditional like "if Col charges Maud, shove
  him into the fire"). No numbered coordinates.
- `expect` lists which `actionKinds` would correctly carry out that order (usually 1–2). If the order
  needs something not in the rules (carrying, hiding, digging, climbing, traps…), use those kinds from
  the end of the list anyway — that's how we learn what to add.
- `capability`: reuse one of these keys when it fits, otherwise invent a short kebab-case one:
  fell-tree barricade dig take-cover climb-tree high-ground block-path tripwire trip disarm
  throw-weapon ready-strike demand-surrender bribe turncoat false-surrender intimidate guard-ally
  drag-ally give-item swap-places hide disguise push-cover flank tip-furniture free-captive
  carry-person escort self-heal shove-hazard throw-rock throw-fire scare-with-fire distract-animals
  howl-down climb-prop douse use-rope heal-ally stop-messenger grab interrogate break-barricade
  suppress lure-foe ignite-prop focus-fire trap roll-barrel brace
- The file must be valid JSON (no comments, no trailing commas).

## Check
After writing each file, run (from the repo root):

```
npx -y bun test/playtest.mjs probe <quest> <stage> playtest/atoms/haiku-<persona>-<quest>-<stage>.json 7 --no-fold
```

**Always pass `--no-fold`** (other playtesters run at the same time; the queue is written once, later).
Each line prints a verdict: `supported` / `misread` (the parser did something else) / `unsupported` /
`unreachable` (fine here, just not possible from this position). Do NOT change your orders to make
them pass — the point is to find what players want. Only fix a file if the command fails to parse it.

## Report
Reply with, per stage: each plan's goal and its verdict counts, plus up to 5 notable `misread` lines
copied verbatim (the order and what it was misread as). Keep it under 300 words.
