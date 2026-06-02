# Hearsay — a Theory-of-Mind combat sandbox (Three.js / WebGL)

Started as a Mount & Blade-style directional melee prototype; now the arena is
populated by **Dwarf-Fortress-style agents who act on what they *believe*, not
what is true.** They perceive each other, gossip (with fading confidence and
provenance), hold grudges, fight when they *believe* someone is an enemy, and a
few are **spies** who disguise themselves and plant false rumours. You play one
fighter; everyone else forms beliefs about you, too.

This ports the Theory-of-Mind design from the `extensive-sim-game` spec
(`docs/spec/belief-primitive.md`, `engine.md`, etc.) into compact browser JS.

## Run it

No build step, no Node — serve over HTTP (ES modules + glTF need `http://`):

```bash
cd mbclone
python3 -m http.server 8000
```

Open <http://localhost:8000>, click to enter, then:

| Action | Input |
| --- | --- |
| Move / run | `WASD` / hold `Shift` |
| Look | mouse |
| Attack | hold **LMB**, flick to aim a direction, release |
| Block | hold **RMB**, flick to match the incoming direction |
| **Read a mind** | look at an agent, press **F** to pin/unpin the inspector |
| Reset world | `R` · free cursor `Esc` |

## How the Theory of Mind works (mapping to the spec)

- **Per-`(observer → subject)` belief table** (`js/sim/beliefs.js`) — every agent
  holds a bounded `BeliefStore` of `BeliefState`s about other agents
  (`lastFaction`, `lastPos`, `lastTick`, `confidence`, `hostile`, `suspicion`,
  `source`). This is the spec's `belief(observer, subject)` N² pair-map.
- **Perception writes high-confidence beliefs, gated by reality** — `Agent.perceive`
  refreshes beliefs for agents in vision range (stealth shrinks it) at
  confidence 1.0, `Source = witnessed`.
- **Gossip with provenance + confidence decay** — `Agent.gossip` adopts a
  friendly neighbour's more-certain beliefs, capped (`SIM.gossipCap = 0.8`),
  faded per hop, tagged `talked`; `BeliefStore.decay` ages all beliefs.
- **The two-phase epistemic split** — *decisions* (`Agent.decide`, utility argmax
  over needs + personality) read **beliefs only**; *execution* (`combat.js`,
  movement) reads ground truth. That's why deception works.
- **Deception verbs** — `disguise` (others perceive a fake faction), `stealth`
  (harder to see), and `plant`/rumour (write a false `hostile` belief into
  others). Attacking **breaks a disguise** for the victim and witnesses
  (`Simulation.onCombatEvents`).
- **DF-style autonomy** — needs (hunger/energy/social/safety), personality
  (risk/social/ambition/altruism/curiosity), relationships, and a utility
  selector with hysteresis pick each agent's goal: eat / rest / socialize /
  flee / attack / investigate / wander (+ spy: disguise / rumour).

## What to watch for

1. **Factions converge and fight** — Azure vs Crimson are hostile by default;
   they wander/forage, meet near the centre well/bushes, *recognise* an enemy,
   and engage. Belief-gated combat means allies' swings pass through each other.
2. **Gossip spreads grudges** — hit one Crimson and its allies learn (via talk,
   at reduced confidence) that *you* are hostile, then come for you.
3. **Spies** — pin one with **F**: it disguises as the enemy (its **ring turns
   the fake colour** and the label reads *disguised* — that's *your* meta view;
   other agents are genuinely fooled and won't attack it), infiltrates, and
   plants rumours that turn enemies on each other.
4. **The inspector is the payoff** — it shows an agent's needs, current goal,
   personality, and **belief table**: who it thinks everyone is, how sure it is,
   how it learned that, and who it fears.

## Files

```
js/
  fighter.js, combat.js, player.js, input.js, camera.js, arena.js, assets.js, constants.js
  sim/
    simconfig.js   factions, sources, archetypes, names, tuning
    beliefs.js     BeliefState + BeliefStore (the ToM table)
    world.js       food / rest / social POIs
    agent.js       perceive → gossip → decide → act + deception
    simulation.js  roster spawn, fixed-rate cognition, combat→belief feedback
  ui/
    inspector.js   look-to-read-mind panel
assets/  KayKit Knight/Barbarian/Rogue GLBs (CC0) + LICENSE.txt
vendor/  three.module.js (r160) + addons
```

## Tuning

Behaviour lives in `js/sim/simconfig.js` (`SIM`, `WEIGHT`, `FACTIONS`,
`ARCHETYPE`, `ROSTER` in `simulation.js`). Combat feel is in `TUNE`
(`js/constants.js`); flip `MODEL_YAW_OFFSET` if a model faces backwards.

## Assets

[KayKit – Adventurers](https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0)
by Kay Lousberg, **CC0 1.0**. Knight/Barbarian share one rig + 76 embedded
animation clips. See `assets/LICENSE.txt`.

## Not yet (possible next steps)

`scry`/`reveal` as player abilities, overhear (vs only talk), rumour hop-decay
chains, factions forming/splitting, memory ring with event provenance, emotions,
mounted combat, audio.
