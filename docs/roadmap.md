# Roadmap — where the story-sim goes next

Status: **planning doc**, for iteration. Captures the landscape so we sequence
deliberately instead of reactively.

## Where we are (shipped / in-flight)

A genuinely deep *agent* simulation:
- **Control** — point-and-click of a single agent (DF-adventurer/Qud lineage); no avatar combat.
- **Cognition** — beliefs/ToM (perceive→gossip→decide on beliefs, not truth), **episodic memory** (3-tier ring buffers), **ambitions** (dispositions), **memory-derived goals + a GOAP planner** (goals from lived experience, plans emerge from believed state).
- **Society** — typed **social groups** (warband/hearth/guild/circle) from emergent affinity.
- **Identity** — **emergent classes** + XP, now **emergent occupation** (professions dropped; agents choose work to build goal-useful classes) [workflow landing].
- **Observability** — Class Codex + XP telemetry; **economics tracking view** [workflow landing]; inspector shows goals/plan/ambition/memory/behavior.
- **Verification** — `bun test/headless.mjs`: 139+ checks (unit + full-stack scenarios + soak).

The **agents** are rich. The two things that are thin: **what the *player* is for**, and **how the emergent stories are *felt*.**

---

## Themes (epics)

### A. Classes as a real system  — *near-term, small/medium*
- **A1 Multi-classing** — capability exists (`maxClasses 5`, `routeTopK 2`); the old professions suppressed it. Verify emergent occupation now produces 2+ classes; tune the matcher gates if not. (small)
- **A2 Mechanical weight** — a per-agent **class bonus** (from held classes × levels) applied at existing seams: warrior→melee dmg/HP, merchant→price favor, producer→gather/craft speed, survivor→regen, hunter→vs-monster dmg. Makes classes *matter* and sharpens goal-directed class-building. (medium)
- **A3 Procedural-class abilities** — milestone abilities are keyed to template class keys; procedural classes get none. Decide: synthesize abilities for procedural classes, or leave abilities template-only? (design Q)

### B. The player's purpose  — *the keystone gap*
Today the player drives one agent with **no objective, arc, or stakes** — they're just another townsperson you click around. This shapes everything downstream (UI, progression, what combat/economy are *for*). Candidate fantasies:
- **(b1) One adventurer's rise** — your agent has its own ambitions/classes; you steer it to grow (wealth/renown/mastery), Stoneshard-like. Personal story, clear progression.
- **(b2) Town shepherd / guide** — you influence the whole town's fate (nudge, found groups, broker peace), more director-like.
- **(b3) Sandbox observer+** — minimal objective; the joy is watching + light steering.
**This is the decision that unblocks the most.**

### C. Threat & drama (a "storyteller")  — *depends on B*
- A RimWorld-style **director** that injects paced events (raids, windfalls, plagues, feuds) so the world has rising/falling tension rather than flat simulation.
- Combat depth: it's auto-attack now; A2 (class weight) + abilities make it meaningful. How central is combat to the fantasy? (open)

### D. Narrative legibility — *high leverage, the "so what"*
The sim *generates* stories; the player must **see** them.
- **D1 Chronicle / event feed** — a running log of notable emergent beats (a vendetta resolved, a fortune made, `[Verdant Tiller]` attained, a betrayal, a death mourned). Turns invisible emergence into felt narrative. Cheap to build on the event bus + memory.
- **D2 Relationship/biography views** — graph of who-likes/hates-whom; an agent's life timeline (memory already backs this).

### E. Economy depth — *post-emergent-economy*
Scarcity/supply-shock events, wealth dynamics, specialization/trade-routes, regional prices. The new econ tracking view is the instrument to balance against.

### F. World & content
More POIs/biomes, factions beyond townsfolk/monster, deeper dungeons, named landmarks/history.

### G. Tech & health
Grow headless coverage; perf at higher agent counts (label-cache is the hot path); **save/load** so a living world persists.

---

## Dependencies & proposed sequencing

```
A1 ──▶ A2 ──▶ A3            (classes real; independent, do first — small wins)
B (decide purpose) ──▶ C (drama/combat) ──▶ depth
D (chronicle) ── independent, high-leverage, do in parallel
E ── after economy lands;  F/G ── ongoing
```

1. **Now (post-economy-land):** A1 + A2 — small, concrete, builds on what just shipped.
2. **Decide B** — the keystone. Until we pick the player's purpose, C and much of the UI are unanchored.
3. **D1 chronicle** in parallel — makes the existing emergence *legible*, low risk, high payoff.
4. Then C / E / F / G per B.

---

## Decisions needed (the forks that actually branch the work)

1. **Player purpose (B)** — b1 rise / b2 shepherd / b3 sandbox. *Keystone.*
2. **Class mechanical weight (A2)** — flavorful nudge, or build-defining (changes balance/combat)?
3. **Combat centrality (C)** — core loop, or occasional threat?
4. **First focus** — classes-real (A), player-purpose (B), or narrative-chronicle (D)?
