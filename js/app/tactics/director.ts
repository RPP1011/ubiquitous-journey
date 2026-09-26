// Opens a tactical battle when the player's side comes to blows, and places everyone on the
// grid. Fights that don't involve the player are left to the engine's real-time resolution.

import type { Agent } from '../../../types/sim.js';
import type { Session } from '../session.js';
import { BattleMap, type PerceptLike, type WorldLike } from './map.js';
import { Battle, type Role } from './battle.js';

export const ENGAGE_RADIUS = 7;   // metres: closing to this range opens a battle
export const MAP_TILES = 16;

const planar = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

export class BattleDirector {
  readonly session: Session;
  battle: Battle | null = null;

  constructor(session: Session) { this.session = session; }

  private ours(): Agent[] {
    const p = this.session.player;
    const party = ((this.session.sim as { party?: { members?: Agent[] } }).party?.members) || [];
    return [p, ...party].filter((a): a is Agent => !!a && a.alive);
  }

  /** Call each frame while no battle runs. Returns a battle if one opened. */
  watch(): Battle | null {
    if (this.battle && !this.battle.outcome) return this.battle;
    const p = this.session.player;
    if (!p || !p.alive) return null;
    if (p.goal && p.goal.kind === 'fight' && p.goal.targetId != null) {
      const t = this.session.sim.agentsById.get(p.goal.targetId) as Agent | undefined;
      if (t && t.alive && !t._held && planar(t.pos, p.pos) <= ENGAGE_RADIUS) return this.open(p, t);
    }
    const ours = this.ours();
    for (const a of this.session.sim.agents as Agent[]) {
      if (!a.alive || a.controlled || a._held || a._encounter != null) continue;
      const g = a.goal;
      if (!g || g.kind !== 'fight' || g.targetId == null) continue;
      const victim = ours.find((o) => o.id === g.targetId);
      if (victim && planar(a.pos, victim.pos) <= ENGAGE_RADIUS) return this.open(a, victim);
    }
    return null;
  }

  /** Build the map around the two principals and seat everyone. */
  open(initiator: Agent, target: Agent, opts: { forewarned?: ReadonlySet<number | string> } = {}): Battle {
    const sim = this.session.sim as unknown as { world?: WorldLike; percepts?: ReadonlyArray<PerceptLike>; party?: { members?: Agent[] } };
    const mid = { x: (initiator.pos.x + target.pos.x) / 2, z: (initiator.pos.z + target.pos.z) / 2 };
    const map = new BattleMap(mid, MAP_TILES, { world: (this.session.world as unknown as WorldLike) ?? sim.world, percepts: sim.percepts ?? [] });
    const b = new Battle(this.session, map);
    const ours = (a: Agent) => a.controlled || !!a.inParty;
    const seat = (a: Agent, role: Role) => {
      if (b.units.some((u) => u.agent === a)) return;
      let t = map.tileAtWorld(a.pos.x, a.pos.z);
      if (!t || !map.standable(t.x, t.z) || b.unitAt(t.x, t.z)) t = t ? map.freeNear(t.x, t.z, 3) : map.freeNear(map.n / 2, map.n / 2, 4);
      if (t) b.add(a, role, t);
    };
    if (this.session.player) seat(this.session.player, 'player');
    const initOurs = ours(initiator);
    seat(initiator, initOurs ? (initiator.controlled ? 'player' : 'companion') : 'foe');
    seat(target, initOurs ? 'foe' : (target.controlled ? 'player' : ours(target) ? 'companion' : 'ally'));
    for (const m of sim.party?.members ?? []) if (m.alive && !m._held && map.tileAtWorld(m.pos.x, m.pos.z)) seat(m, 'companion');
    b.recruitNearby(null, 1);                      // those already in the fray commit at once
    b.surpriseFromBeliefs(opts.forewarned);
    this.battle = b;
    return b;
  }

  clear(): void { if (this.battle && this.battle.outcome) this.battle = null; }
}
