// Stored-wealth (purse vs stash) invariants — Commit 1 of the Phase-4 economy
// prerequisites. Asserts: (a) a purse↔stash move conserves total wealth; (b) death
// loots the PURSE, never the STASH; (c) day-one (WEALTH.enabled=false) the field is
// inert so the soak stays byte-stable (proved by stash==0 everywhere after a run);
// (d) even with WEALTH forced ON, monster-faction raiders keep stash 0 (no mint).
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { resolveCombat } from '../../js/combat.js';
import { WEALTH } from '../../js/sim/simconfig.js';

export async function wealthCheck(ok, { makeFighter, stubScene }) {
  // (a) CONSERVATION ACROSS A PURSE↔STASH MOVE — pure own-state transfer, no mint.
  {
    const world = new World(stubScene);
    const sim = new Simulation(stubScene, world, { makeFighter });
    sim.spawn();
    const a = sim.agents.find((x) => x.canWork && (x.gold || 0) > 10);
    ok(!!a, `wealth: found a working agent with coin to test`);
    const before = a.gold + (a.stash || 0);
    const move = 7;
    a.gold -= move; a.stash = (a.stash || 0) + move;     // deposit
    ok(Math.abs((a.gold + a.stash) - before) < 1e-6, `wealth: deposit conserves total (${before})`);
    a.stash -= move; a.gold += move;                      // withdraw
    ok(Math.abs((a.gold + a.stash) - before) < 1e-6, `wealth: withdraw conserves total`);
  }

  // (b) DEATH LOOTS PURSE, NOT STASH — kill a monster with both, confirm only purse moves.
  {
    const world = new World(stubScene);
    const sim = new Simulation(stubScene, world, { makeFighter });
    sim.spawn();
    const pf = makeFighter('knight', { isPlayer: true });
    sim.addPlayer(pf);
    const player = sim.player;
    const monster = sim.agents.find((x) => x.faction === 'monster');
    ok(!!monster, `wealth: found a monster-faction body to loot`);
    monster.gold = 12; monster.stash = 9;                 // a body carrying both
    const pPurse0 = player.gold, pStash0 = (player.stash || 0);
    const total0 = sim.agents.reduce((s, x) => s + x.gold + (x.stash || 0), 0);
    // drive the loot hook directly with a synthetic 'dead' event (player slays monster)
    sim.onCombatEvents([{ type: 'dead', attacker: player.fighter, target: monster.fighter, magnitude: 1 }]);
    ok(player.gold === pPurse0 + 12, `wealth: slayer loots the PURSE (+12)`);
    ok(monster.gold === 0, `wealth: corpse purse emptied`);
    ok(monster.stash === 9, `wealth: corpse STASH untouched by death-loot (9)`);
    ok((player.stash || 0) === pStash0, `wealth: slayer's stash unchanged by looting`);
    const total1 = sim.agents.reduce((s, x) => s + x.gold + (x.stash || 0), 0);
    ok(Math.abs(total1 - total0) < 1e-6, `wealth: total wealth conserved across the kill`);
  }

  // (c) DAY-ONE BYTE-STABLE — with WEALTH.enabled false (the shipped default), no
  // agent ever banks: stash is 0 across a full short soak ⇒ the conservation summer
  // adds +0 and the soak is identical to pre-commit. (We assert the precondition that
  // GUARANTEES byte-stability, not re-run the 12k soak here — soak.mjs owns that.)
  {
    ok(WEALTH.enabled === false, `wealth: ships DISABLED (byte-stable migration default)`);
    const world = new World(stubScene);
    const sim = new Simulation(stubScene, world, { makeFighter });
    sim.spawn();
    const pf = makeFighter('knight', { isPlayer: true });
    sim.addPlayer(pf);
    let stage = 'init';
    try {
      for (let i = 0; i < 1200; i++) {
        stage = 'sim.update'; sim.update(1 / 60);
        stage = 'fighter.update'; for (const f of sim.fighters) f.update(1 / 60);
        stage = 'resolveCombat';
        const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
        if (ev.length) { stage = 'onCombatEvents'; sim.onCombatEvents(ev); }
      }
    } catch (e) { ok(false, `wealth: soak threw at ${stage}: ${e.message}`); }
    const banked = sim.agents.reduce((s, x) => s + (x.stash || 0), 0);
    ok(banked === 0, `wealth: day-one stash stays 0 town-wide (byte-stable) — banked=${banked}`);
  }

  // (d) ENABLED-ON SANITY — with WEALTH forced ON for a fresh spawn, townsfolk DO
  // bank a fraction (stash funded, purse + stash conserved per agent), but monster-
  // faction agents (raiders/horrors) keep stash 0 (seedStash early-returns for them,
  // so the raider-gold conservation assertion is unaffected). Restored afterward.
  {
    const prev = WEALTH.enabled;
    WEALTH.enabled = true;
    try {
      const world = new World(stubScene);
      const sim = new Simulation(stubScene, world, { makeFighter });
      sim.spawn();
      const banker = sim.agents.find((x) => x.canWork && (x.stash || 0) > 0);
      ok(!!banker, `wealth: ON ⇒ at least one townsperson funds a stash`);
      const monsterStash = sim.agents
        .filter((x) => x.faction === 'monster')
        .reduce((s, x) => s + (x.stash || 0), 0);
      ok(monsterStash === 0, `wealth: ON ⇒ monster-faction agents keep stash 0 (no mint) — ${monsterStash}`);
    } finally {
      WEALTH.enabled = prev;          // ALWAYS restore so later suites see the baseline
    }
  }
}
