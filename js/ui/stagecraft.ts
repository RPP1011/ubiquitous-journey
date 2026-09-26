// STAGECRAFT: what the camera and nameplates show in run mode. Visual only — sets the
// presentation overrides decor.ts reads (_plate / _hideLabel / _ringColor); never touches the sim.
//
//   hub     only the cast and your company are labelled: clean nameplates tinted by how that
//           person feels about you (green warm · amber cool · red cold)
//   battle  every combatant gets its name + an HP bar; rings show sides (green yours, red foes,
//           gold the one acting, blue a captive, grey the fallen)

import type { Agent } from '../../types/sim.js';
import type { RunController } from '../app/run/run.js';
import { HUB_NPCS } from '../app/run/hub.js';
import { COMPANIONS, type CompanionKey } from '../app/run/companions.js';
import type { Battle, Unit } from '../app/tactics/battle.js';
import type { BattleFX } from './battleFX.js';
import { dressAsWolf, wolfLook } from './beastModel.js';

const MOOD = (s: number) => (s > 0.35 ? '#8fe39a' : s < -0.35 ? '#f09a8d' : s < -0.05 ? '#f0c674' : '#eef3f8');
const RING = { us: 0x4fc76a, them: 0xd6503f, cur: 0xf2c94c, captive: 0x5aa7e8, down: 0x6b7280, hub: 0x9aa6b2 };

function set(a: Agent, plate: Agent['_plate'], ring: number | null, hide = false): void {
  a._plate = plate; a._ringColor = ring; a._hideLabel = hide;
  // our nameplates carry HP themselves; the fighter's own floating bar is redundant here
  const hb = (a.fighter as { healthBar?: { visible: boolean } }).healthBar; if (hb) hb.visible = false;
  try { (a as unknown as { _updateLabel(): void })._updateLabel(); } catch { /* headless */ }
}

export function hubStage(rc: RunController, talking: string | null): void {
  const player = rc.session.player;
  for (const a of rc.session.sim.agents as Agent[]) set(a, null, null, true);
  for (const def of HUB_NPCS) {
    const a = rc.hubAgents.get(def.key); if (!a) continue;
    const s = rc.save.hub.standing[def.key] ?? 0;
    set(a, { name: def.name, sub: def.role, color: MOOD(s) }, talking === def.key ? RING.cur : RING.hub);
  }
  for (const [k, a] of rc.hubAgents) if (!HUB_NPCS.some((d) => d.key === k)) set(a, { name: a.name, sub: k === 'col' ? 'came home' : 'home safe', color: '#c7d0d9' }, RING.hub);
  for (const k of rc.available()) {
    const a = rc.companionAgents.get(k as CompanionKey); if (!a) continue;
    set(a, { name: COMPANIONS[k as CompanionKey].name, sub: 'your company', color: '#e8c879' }, talking === k ? RING.cur : RING.us);
  }
  if (player) set(player, { name: 'You', sub: `${Math.round(player.gold || 0)} silver`, color: '#e8c879' }, RING.us);
}

function icons(u: Unit): string {
  return [u.burning > 0 ? '🔥' : '', u.defending ? '🛡' : '', u.blocking ? '⛔' : '', u.overwatch ? '👁' : '', u.readied ? '⏳' : '', u.exposed ? '✖' : '',
    u.morale === 'shaken' ? '😰' : u.morale === 'broken' ? '😱' : '', u.tauntedBy ? '💢' : '', u.turnedOn ? '⚔' : '', u.carrying ? '✋' : ''].join('');
}

export function battleStage(b: Battle, fx: BattleFX | null = null): void {
  const cur = b.current();
  for (const u of b.units) {
    const a = u.agent;
    // beasts get a beast's body (the rigs are all people)
    if (a.faction === 'monster' && (a.fighter as { model?: unknown }).model) { try { dressAsWolf(a.fighter as never, wolfLook(a.name, u.tags.has('chief'))); } catch { /* visual only */ } }
    const shown = fx ? fx.view(u) : null;
    const gone = shown ? shown.gone : (u.out === 'dead' || u.out === 'fled' || u.out === 'yielded' || u.out === 'captured' || !a.alive);
    const root = (a.fighter as unknown as { root?: { visible: boolean } }).root;
    // fog of war: a foe no one on your side can see isn't drawn
    const unseen = u.side !== 'us' && u.out === null && !b.visibleTo('us', u);
    if (root) root.visible = !unseen && !(shown && shown.gone);
    if (gone || unseen) { set(a, null, null, true); continue; }
    const down = shown ? shown.down : u.out === 'downed';
    const ring = u === cur ? RING.cur : down ? RING.down : u.tags.has('captive') ? RING.captive : u.side === 'us' ? RING.us : RING.them;
    const ic = icons(u) + (u.side === 'us' && u.out === null && !b.visibleTo('them', u) ? '🌫' : '');
    const name = (a.controlled ? 'You' : a.name) + (ic ? ` ${ic}` : '');
    const hp = shown ? shown.hp : Math.max(0, a.fighter.health);
    set(a, { name, hp: u.bound ? undefined : hp / 100, sub: u.bound ? 'bound' : undefined, color: u.side === 'us' ? '#cdf0d2' : '#f3c2ba' }, ring);
  }
}

/** Clear overrides (e.g. leaving run mode). */
export function clearStage(agents: Agent[]): void { for (const a of agents) set(a, null, null, false); }
