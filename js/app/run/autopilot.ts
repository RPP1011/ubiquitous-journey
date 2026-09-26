// AUTOPILOT: plays the game for recordings and soak tests. It makes the choices a player would —
// which quest, who to bring, how to fight (a DISPOSITION: merciful / ruthless / pragmatic) — and
// phrases its battle actions as WRITE-INS, so a recording shows the write-in box doing the work.

import { planTurn, runTurn } from '../tactics/ai.js';
import { readWriteIn } from '../tactics/writein.js';
import type { Action, Battle, Unit } from '../tactics/battle.js';
import type { CompanionKey } from './companions.js';
import type { Disposition, RunController, RunReport } from './run.js';

/** The arc a series of recorded runs follows: a merciful first outing, a ruthless second, a pragmatic third. */
export function plan(runIndex: number, rc: RunController): { disposition: Disposition; party: CompanionKey[] } {
  const avail = rc.available();
  const want: CompanionKey[][] = [['borin', 'pip', 'maud'], ['pip', 'wren', 'maud'], ['pip', 'borin', 'wren']];
  const disp: Disposition[] = ['merciful', 'ruthless', 'pragmatic'];
  const i = runIndex % 3;
  const party = want[i].filter((k) => avail.includes(k));
  for (const k of avail) if (party.length < 3 && !party.includes(k)) party.push(k);
  return { disposition: disp[i], party };
}

/** Natural-language phrasing of a planned action (what the autopilot "types"). */
export function phrase(b: Battle, u: Unit, a: Action): string | null {
  const N = (id: unknown) => { const t = b.get(id as Unit['id']); return t ? t.agent.name.split(' ')[0] : 'them'; };
  const P = (id: string) => b.map.props.get(id)?.nouns[0] ?? u.carrying?.nouns[0] ?? 'it';
  switch (a.kind) {
    case 'attack': return `strike ${N(a.target)}`;
    case 'ability': return `${u.agent.abilities.get(a.abilityId)?.name.replace(/[[\]]/g, '').toLowerCase() ?? 'attack'} ${N(a.target)}`;
    case 'shove': {
      const t = b.get(a.target as Unit['id']);
      if (!t) return `shove the ${P(String(a.target))}`;
      const d = b.dirFrom(u, t), tile = b.map.tile(t.x + d[0], t.z + d[1]);
      return tile && (tile.burning || b.map.propAt(tile.x, tile.z)?.fireSource) ? `shove ${N(a.target)} into the fire` : `shove ${N(a.target)}`;
    }
    case 'kick': { const f = b.nearestFoe(u); return `kick the ${P(a.prop)}${f ? ` into ${f.agent.name.split(' ')[0]}` : ''}`; }
    case 'throw': { const t = b.unitAt(a.at.x, a.at.z); return `throw the ${P(a.prop)} at ${t ? t.agent.name.split(' ')[0] : 'them'}`; }
    case 'ignite': { const p = b.map.propAt(a.at.x, a.at.z); return p ? `set the ${p.nouns[0]} on fire` : null; }
    case 'free': return `cut ${N(a.target)} free`;
    case 'subdue': return `subdue ${N(a.target)}, take them alive`;
    case 'grab': return `steal ${N(a.target)}'s purse`;
    case 'pickup': return `grab the ${P(a.prop)}`;
    case 'aid': return a.target === u.id ? 'bandage myself' : `help ${N(a.target)} up`;
    case 'social': return a.verb === 'parley' ? 'lay down your arms, it is over' : a.verb === 'intimidate' ? `threaten ${N(a.target)}` : a.verb === 'rally' ? 'rally, to arms!' : null;
    default: return null;
  }
}

/**
 * The player's (or a commanded companion's) turn, via the write-in box when the phrasing reads
 * back to the same action; otherwise directly. Returns the text typed (if any).
 */
export function playerTurn(b: Battle, u: Unit, typed?: (text: string) => void): string | null {
  const pl = planTurn(b, u);
  const text = phrase(b, u, pl.action);
  if (text) {
    const r = readWriteIn(b, u, text)[0];
    if (r && sameAct(r.action, pl.action)) {
      typed?.(text);
      if (r.to) b.moveTo(u, r.to);
      else if (pl.to) b.moveTo(u, pl.to);
      if (b.current() === u && !u.acted && u.out === null) b.act(u, r.action, text);
      if (b.current() === u) b.endTurn(u);
      return text;
    }
  }
  runTurn(b, u);
  return null;
}

function sameAct(a: Action, c: Action): boolean {
  if (a.kind !== c.kind) return false;
  const A = a as Record<string, unknown>, C = c as Record<string, unknown>;
  for (const k of ['target', 'prop', 'abilityId', 'verb']) if (A[k] !== undefined && C[k] !== undefined && A[k] !== C[k]) return false;
  return true;
}

/** Headless: play a whole run end to end. */
export function playRunHeadless(rc: RunController, runIndex: number, log: (s: string) => void = () => {}): RunReport | null {
  const q = rc.nextQuest();
  if (!q) return null;
  const { disposition, party } = plan(runIndex, rc);
  rc.startRun(q.id, party, disposition);
  log(`== ${q.title} (${disposition}) with ${party.join(', ')}`);
  while (!rc.runOver) {
    const b = rc.beginStage();
    b.start();
    let guard = 0;
    while (!b.outcome && guard++ < 600) {
      const u = b.current(); if (!u) break;
      if (b.playerControls(u)) playerTurn(b, u); else runTurn(b, u);
    }
    const r = rc.endStage();
    log(`  ${r.stage.name}: ${r.outcome}${r.objectiveMet ? ' ✓' : ' ✗'} (${b.round} rounds) ${r.growth.join(' | ')}`);
  }
  return rc.finishRun();
}
