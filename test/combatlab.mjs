// COMBAT LAB — not a gate. Runs many seeded headless encounters across scenarios × rule
// variants × player playstyles and prints a table, so combat tuning is measured, not guessed.
//
//   bun test/combatlab.mjs [seedsPerCell=25]
//
// Metrics per cell: win%, player-death%, mean rounds, how fights end (kills vs routs vs
// talk), allies who joined of their own accord, companions lost.

import * as THREE from 'three';
import { setSeed } from '../js/sim/rng.js';
import { stubScene, makeFighter } from './harness.mjs';
import { createSession } from '../js/app/session.js';
import { CombatDirector } from '../js/app/combat/encounter.js';
import { COMBAT } from '../js/app/combat/rules.js';
import { Agent } from '../js/sim/agent.js';
import { HeadlessFighter } from '../js/headlessFighter.js';

const N = +(process.argv[2] || 25);
const SPOT = new THREE.Vector3(300, 0, 300);
const P = (risk) => ({ risk_tolerance: risk, social_drive: 0.4, ambition: 0.5, altruism: 0.6, curiosity: 0.4 });

function build(scn) {
  const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 1,
    player: { fighter: new HeadlessFighter('knight', { isPlayer: true }), spawn: { x: SPOT.x, z: SPOT.z } } });
  const put = (name, dx, dz, faction, risk, combatant = true) => {
    const a = new Agent(makeFighter('knight', {}), { id: s.sim._nextId++, name, profession: null,
      personality: P(risk), faction, combatant, controlled: false });
    a.fighter.root.position.set(SPOT.x + dx, 0, SPOT.z + dz);
    s.sim.agents.push(a); s.sim.agentsById.set(a.id, a);
    return a;
  };
  const hate = (a, b) => { a.beliefs.observe(b.id, b.faction, b.pos, 0, true); a.beliefs.get(b.id).hostile = true; };
  const like = (a, b, v) => { a.beliefs.observe(b.id, b.faction, b.pos, 0, false); a.beliefs.get(b.id).standing = v; };
  const you = s.player;
  const ours = [you];
  for (let i = 0; i < scn.companions; i++) {
    const c = put(`Companion${i}`, -1.5, i * 1.5, 'townsfolk', 0.7);
    c.inParty = true; s.sim.party.members.push(c); like(c, you, 0.6); ours.push(c);
  }
  const foes = [];
  for (let i = 0; i < scn.foes; i++) foes.push(put(`Bandit${i}`, 4 + i * 0.7, i * 1.6 - 1.5, 'bandit', 0.3 + 0.15 * i));
  for (const f of foes) for (const o of ours) hate(f, o);
  for (let i = 0; i < scn.watch; i++) {
    const w = put(`Watch${i}`, -2 + i * 3, -8, 'townsfolk', 0.85);
    for (const f of foes) hate(w, f);
    like(w, you, 0.3);
  }
  return { s, foes };
}

const pilots = {
  brute: (e, c) => {
    const t = e.opponents(c).sort((a, b) => a.agent.fighter.health - b.agent.fighter.health)[0];
    return t ? { verb: 'strike', targetId: t.agent.id } : { verb: 'defend' };
  },
  tactician: (e, c) => e.chooseFor(c),
};

const variants = {
  base: {},
  gritty: { damageBase: COMBAT.damageBase * 0.7 },
  brittle: { moraleDC: 14, moraleBreakHp: 0.5 },
  hero: { playerEdge: 2 },
  heroGritty: { playerEdge: 2, damageBase: COMBAT.damageBase * 0.7 },
};

const scenarios = {
  duel: { companions: 0, foes: 1, watch: 0 },
  ambush: { companions: 0, foes: 3, watch: 0 },
  party: { companions: 2, foes: 3, watch: 0 },
  townWatch: { companions: 0, foes: 2, watch: 2 },
};

const base = { ...COMBAT };
const rows = [];
const t0 = performance.now();
for (const [vn, patch] of Object.entries(variants)) {
  Object.assign(COMBAT, base, patch);
  for (const [sn, scn] of Object.entries(scenarios)) {
    for (const [pn, pilot] of Object.entries(pilots)) {
      const m = { downs: 0, win: 0, died: 0, rounds: 0, kills: 0, routs: 0, talk: 0, allies: 0, compLost: 0 };
      for (let seed = 1; seed <= N; seed++) {
        setSeed(seed * 7919);
        const { s } = build(scn);
        const dir = new CombatDirector(s);
        const e = dir.begin(s.player, s.sim.agentsById.get([...s.sim.agentsById.keys()].find((id) => s.sim.agentsById.get(id).name === 'Bandit0')));
        while (e.phase !== 'over') {
          for (const c of e.pendingDeclarers()) e.declare(c, pilot(e, c));
          dir.advance();
        }
        if (e.outcome === 'victory' || e.outcome === 'truce') m.win++;
        if (!s.player.alive) m.died++;
        m.rounds += e.round;
        m.downs += e.log.filter((l) => l.text.startsWith('You cling on') || l.text.startsWith('You are stable')).length > 0 ? 1 : 0;
        const them = e.members.filter((c) => c.side === 'them');
        m.kills += them.filter((c) => c.out === 'dead' || c.out === 'captured').length;
        m.routs += them.filter((c) => c.out === 'fled').length;
        m.talk += them.filter((c) => c.out === 'yielded').length;
        m.allies += e.members.filter((c) => c.role === 'ally').length;
        m.compLost += e.members.filter((c) => c.role === 'companion' && c.out !== null && c.out !== 'yielded').length;
        s.dispose();
      }
      const pct = (x) => `${Math.round((100 * x) / N)}%`;
      const avg = (x) => (x / N).toFixed(1);
      rows.push({ variant: vn, scenario: sn, pilot: pn, win: pct(m.win), 'went down': pct(m.downs), died: pct(m.died), rounds: avg(m.rounds),
        'foes killed': avg(m.kills), 'foes routed': avg(m.routs), 'talked down': avg(m.talk), allies: avg(m.allies), 'companions lost': avg(m.compLost) });
    }
  }
}
Object.assign(COMBAT, base);
console.table(rows);
console.log(`${rows.length * N} encounters in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
