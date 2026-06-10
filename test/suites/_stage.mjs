// Shared deterministic stage for the action-grammar EXECUTION feature suites (docs/architecture/10
// + 10-lld §18). A thin sibling of scenarios.mjs' Stage: a real Simulation of HeadlessFighters
// driven through the exact frame loop, with belief seeding + a pinned-actor loop so a scripted
// heist / rob / recruit resolves deterministically. Importing the feature index here REGISTERS
// every feature's verbs/derivers (verbs-are-data) so the suites exercise the live path.
import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { resolveCombat } from '../../js/combat.js';
import { COMMODITIES } from '../../js/sim/simconfig.js';
import '../../js/sim/features/index.js';   // self-register the feature verbs/derivers

const stubScene = { add() {}, remove() {} };

export class FeatureStage {
  constructor(helpers) {
    const mk = (helpers && helpers.makeFighter) || ((m, o) => { throw new Error('need makeFighter'); });
    this.mk = mk;
    this.world = new World(stubScene);
    this.sim = new Simulation(stubScene, this.world, { makeFighter: mk });
    this._nid = 1;
    this.dt = 1 / 60;
  }
  // personality bag (override per agent) — risk_tolerance/greed/ambition/altruism/etc.
  add(name, x, z, cfg = {}) {
    const personality = Object.assign(
      { risk_tolerance: 0.5, sociability: 0.4, ambition: 0.5, altruism: 0.5, curiosity: 0.4, greed: 0.3 },
      cfg.personality || {});
    const a = new Agent(this.mk('knight', {}),
      { id: this._nid++, name, profession: cfg.profession ?? null, personality,
        faction: cfg.faction || 'townsfolk', combatant: !!cfg.combatant, controlled: !!cfg.controlled });
    a.fighter.root.position.set(x, 0, z);
    this.sim.agents.push(a); this.sim.agentsById.set(a.id, a);
    return a;
  }
  strip(a) { for (const c of COMMODITIES) a.inventory[c] = 0; a.gold = 0; return a; }
  believe(observer, subject, hostile = false) {
    observer.beliefs.observe(subject.id, subject.faction, subject.pos, this.sim.time, hostile);
  }
  inject(agent, memory) { agent.memory.record(memory); agent.memory._consolidate(); return memory; }
  ctx() { return this.sim._ctx(); }
  frame() {
    const sim = this.sim;
    sim.update(this.dt);
    for (const f of sim.fighters) f.update(this.dt);
    const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
    if (ev.length) sim.onCombatEvents(ev);
  }
  // run up to maxFrames, optionally pinning some agents in place + refreshing an observer's belief
  // each frame (so a scripted scene doesn't drift as the mark's AI wanders). Stops when pred() true.
  run(pred, { maxFrames = 2500, pin = [], refresh = [] } = {}) {
    for (let f = 0; f < maxFrames; f++) {
      for (const [a, x, z] of pin) a.fighter.root.position.set(x, 0, z);
      for (const [obs, subj] of refresh) this.believe(obs, subj);
      if (pred && pred()) return f;
      this.frame();
    }
    return maxFrames;
  }
  totalGold() { return this.sim.agents.reduce((s, a) => s + (a.gold || 0), 0); }
  dispose() { this.sim.dispose(); }
}
