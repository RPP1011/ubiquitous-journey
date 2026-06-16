// The PURE rendering core for the DF-style observer (no DOM — so it is unit-testable headlessly,
// `test/df.mjs`). Maps the live `Simulation` world into a grid of glyph `Cell`s and renders the
// look / chronicle / gazette panels as plain text lines. `main.ts` wires these to the page + input.
//
// Everything here READS the sim like the existing UI panels do (a loose "minimal read", so the heavy
// domain types don't leak in) — it never mutates the world, the observer invariant.

import { biomeAt, regionAt, REGIONS, nearestLandmark, LANDMARKS, ARENA_RADIUS } from '../arena.js';
import { memoryPhrase } from '../sim/memory.js';
import { FACTIONS, PROFESSIONS } from '../sim/simconfig.js';
import {
  type Cell,
  EMPTY,
  biomeCellAt,
  poiCell,
  LANDMARK_CELL,
  factionCell,
  PARTY_COLOR,
  PLAYER_CELL,
  PERCEPT_CELL,
} from './glyphs.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The window onto the world: a centre (world metres), a zoom (metres per cell), and a grid size. */
export interface Viewport {
  cx: number;
  cz: number;
  mpp: number; // metres per cell (zoom; larger = more world, coarser)
  cols: number;
  rows: number;
}

/** World metres at the centre of grid cell (col,row). */
export function cellToWorld(vp: Viewport, col: number, row: number): { x: number; z: number } {
  const x = vp.cx + (col - (vp.cols - 1) / 2) * vp.mpp;
  const z = vp.cz + (row - (vp.rows - 1) / 2) * vp.mpp;
  return { x, z };
}

/** The grid cell a world point falls in (may be off-grid). */
export function worldToCell(vp: Viewport, x: number, z: number): { col: number; row: number } {
  const col = Math.round((x - vp.cx) / vp.mpp + (vp.cols - 1) / 2);
  const row = Math.round((z - vp.cz) / vp.mpp + (vp.rows - 1) / 2);
  return { col, row };
}

const inGrid = (vp: Viewport, col: number, row: number): boolean =>
  col >= 0 && col < vp.cols && row >= 0 && row < vp.rows;

/**
 * Render the world into a `rows × cols` grid of `Cell`. Layering (low → high priority):
 *   biome background  <  POIs  <  percepts (props)  <  agents  <  the player.
 * The look-cursor is drawn by `main.ts` (it tints a cell), not here.
 */
export function renderMap(sim: any, vp: Viewport): Cell[][] {
  const grid: Cell[][] = [];
  for (let r = 0; r < vp.rows; r++) {
    const line: Cell[] = [];
    for (let c = 0; c < vp.cols; c++) {
      const { x, z } = cellToWorld(vp, c, r);
      // outside the round arena: blank void.
      if (Math.hypot(x, z) > ARENA_RADIUS + vp.mpp) {
        line.push(EMPTY);
      } else {
        line.push(biomeCellAt(safe(() => biomeAt(x, z), 'plains'), x, z));
      }
    }
    grid.push(line);
  }

  // POIs (markets/forges/fields/…)
  const pois: any[] = (sim.world && sim.world.pois) || [];
  for (const p of pois) {
    const cell = poiCell(p.kind);
    if (!cell) continue;
    const { col, row } = worldToCell(vp, p.pos.x, p.pos.z);
    if (inGrid(vp, col, row)) grid[row][col] = cell;
  }

  // named LANDMARKS — the places worth exploring (drawn above POIs so they stand out as destinations).
  for (const L of LANDMARKS) {
    const { col, row } = worldToCell(vp, L.x, L.z);
    if (inGrid(vp, col, row)) grid[row][col] = LANDMARK_CELL;
  }

  // percepts (mind-less props)
  const percepts: any[] = sim.percepts || [];
  for (const pc of percepts) {
    const pos = pc.pos || (pc.fighter && pc.fighter.root && pc.fighter.root.position);
    if (!pos) continue;
    const { col, row } = worldToCell(vp, pos.x, pos.z);
    if (inGrid(vp, col, row)) grid[row][col] = PERCEPT_CELL;
  }

  // agents (the living) — drawn last so they sit on top; the player brightest of all.
  const partyIds = partySet(sim);
  const playerId = sim.player ? sim.player.id : null;
  for (const a of sim.agents || []) {
    if (!a.alive || !a.pos) continue;
    const { col, row } = worldToCell(vp, a.pos.x, a.pos.z);
    if (!inGrid(vp, col, row)) continue;
    if (a.id === playerId) {
      grid[row][col] = PLAYER_CELL;
    } else {
      const base = factionCell(a.faction);
      grid[row][col] = partyIds.has(a.id) ? { ch: base.ch, color: PARTY_COLOR } : base;
    }
  }
  return grid;
}

/** The nearest LIVING agent to a world point, within `radius` metres (the look-cursor pick). */
export function agentAt(sim: any, x: number, z: number, radius: number): any | null {
  let best: any = null;
  let bestD = radius * radius;
  for (const a of sim.agents || []) {
    if (!a.alive || !a.pos) continue;
    const dx = a.pos.x - x;
    const dz = a.pos.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD || (d === bestD && best && a.id < best.id)) {
      bestD = d;
      best = a;
    }
  }
  return best;
}

/** The nearest POI to a world point within `radius` (for the tile-info panel when no agent is there). */
function poiAt(sim: any, x: number, z: number, radius: number): any | null {
  let best: any = null;
  let bestD = radius * radius;
  for (const p of (sim.world && sim.world.pois) || []) {
    const dx = p.pos.x - x;
    const dz = p.pos.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// ── label helpers ───────────────────────────────────────────────────────────────────────────
function factionLabel(f: string): string {
  const e = FACTIONS[f as keyof typeof FACTIONS];
  return e ? e.label : f;
}
function professionLabel(p: string | null | undefined): string | null {
  if (!p) return null;
  const e = PROFESSIONS[p as keyof typeof PROFESSIONS];
  return e ? e.label : p;
}
function nameOf(sim: any, id: any): string {
  const a = sim.agentsById && sim.agentsById.get(id);
  return a ? a.name : '#' + id;
}

/**
 * The LOOK panel for an agent — its readable MIND (the epistemic split made visible): who it is,
 * what it is doing, who it likes/fears, what it believes, what it remembers. Mirrors the 3D
 * inspector's content as plain text lines.
 */
export function mindLines(sim: any, a: any): string[] {
  const out: string[] = [];
  const lvl = (a.progression && a.progression.totalLevel) || 0;
  const prof = professionLabel(a.profession);
  const hpMax = 100;
  const hp = Math.max(0, Math.round(((a.fighter && a.fighter.health) || 0)));
  out.push(`@title ${a.name}`);
  out.push(
    `${factionLabel(a.faction)}${prof ? ' · ' + prof : ''} · lvl ${lvl} · hp ${hp}/${hpMax}`,
  );

  // what it's doing now (the live goal) + the standing intention on top of its goal stack.
  const goalKind = a.goal && a.goal.kind ? a.goal.kind : '—';
  out.push(`doing: ${goalKind}`);
  if (Array.isArray(a.goals) && a.goals.length) {
    const top = a.goals[a.goals.length - 1];
    const tk = top && (top.kind || top.type);
    if (tk) out.push(`wants: ${tk}`);
  }

  // explorer identity: how much of the world this soul has beheld (the discovery system).
  const disc = a.life && a.life.discoveries;
  if (disc) {
    const firsts = (a.life && a.life.firsts) || 0;
    out.push(`explored ${disc} place${disc === 1 ? '' : 's'}${firsts ? ` (${firsts} first-found)` : ''}`);
  }

  // group / party allegiance.
  if (a.groupType && a.leader) {
    const L = sim.agentsById && sim.agentsById.get(a.leader);
    out.push(`with ${a.groupType}${L ? ' (' + L.name + ')' : ''}`);
  }

  // relationships: strongest allies / rivals by believed standing.
  const rel = a.beliefs && a.beliefs.all ? [...a.beliefs.all()].filter((b: any) => Math.abs(b.standing) > 0.12) : [];
  const allies = rel.filter((b: any) => b.standing > 0).sort((x: any, y: any) => y.standing - x.standing).slice(0, 3);
  const rivals = rel.filter((b: any) => b.standing < 0).sort((x: any, y: any) => x.standing - y.standing).slice(0, 3);
  if (allies.length || rivals.length) {
    out.push('@sec Bonds');
    for (const b of allies) out.push(`  likes ${nameOf(sim, b.subjectId)} (+${b.standing.toFixed(2)})`);
    for (const b of rivals) out.push(`  wary of ${nameOf(sim, b.subjectId)} (${b.standing.toFixed(2)})`);
  }

  // beliefs that DRIVE behaviour: who it thinks is hostile (the deception/grudge layer).
  const hostiles = rel.length
    ? [...a.beliefs.all()].filter((b: any) => b.hostile).slice(0, 4)
    : (a.beliefs && a.beliefs.all ? [...a.beliefs.all()].filter((b: any) => b.hostile).slice(0, 4) : []);
  if (hostiles.length) {
    out.push('@sec Believes hostile');
    for (const b of hostiles) {
      out.push(`  ${nameOf(sim, b.subjectId)} (conf ${b.confidence.toFixed(2)})`);
    }
  }

  // life so far: the most formative salient memories, in plain words.
  if (a.memory && a.memory.salient) {
    const eps = a.memory.salient(4);
    if (eps.length) {
      out.push('@sec Life so far');
      for (const e of eps) out.push(`  ${memoryPhrase(e, (id: any) => nameOf(sim, id))}`);
    }
  }

  // emergent classes (the RPG progression).
  if (a.progression && a.progression.topClasses) {
    const top = a.progression.topClasses(3);
    if (top.length) {
      out.push('@sec Classes');
      for (const c of top) out.push(`  ${c.name} — Lv ${c.level}`);
    }
  }
  return out;
}

/** The look panel when there's no agent under the cursor — the TILE itself (biome/region/POI/landmark). */
export function tileLines(sim: any, x: number, z: number, pickR: number): string[] {
  const out: string[] = [];
  // a LANDMARK right under the cursor gets the headline — its name, lore, and any cache (the explorer's draw).
  const here = LANDMARKS.find((L: any) => Math.hypot(L.x - x, L.z - z) <= Math.max(pickR, 18)) as any;
  if (here) {
    out.push(`@title ⚑ ${here.name}`);
    if (here.lore) out.push(here.lore);
    if (here.find) out.push(`@sec a cache: ${here.find.qty} ${here.find.good} (claimed by the first to arrive)`);
    else out.push(`a ${here.kind} — a place to behold`);
    out.push(`(${Math.round(x)}, ${Math.round(z)})`);
    return out;
  }
  out.push('@title The land');
  const biome = safe(() => biomeAt(x, z), 'plains');
  const region = safe(() => regionAt(x, z), '');
  const rl = region && REGIONS[region as keyof typeof REGIONS];
  out.push(`${rl ? rl.label : 'wilderness'} · ${biome}`);
  const p = poiAt(sim, x, z, pickR);
  if (p) out.push(`here: ${p.kind}`);
  const lm = safe(() => nearestLandmark(x, z, 200), null as any);
  if (lm) out.push(`toward ${lm.name}`);
  out.push(`(${Math.round(x)}, ${Math.round(z)})`);
  return out;
}

/** Recent CHRONICLE beats (the world-history feed) — `chronicle.recent(n)` is already newest-first. */
export function chronicleLines(sim: any, n: number): string[] {
  const chron = sim.chronicle;
  const beats: any[] = chron && chron.recent ? chron.recent(n) : [];
  if (!beats.length) return ["The world's story is still being written…"];
  return beats.map((b: any) => '· ' + (b.text || describeBeat(sim, b)));
}

function describeBeat(sim: any, b: any): string {
  const who = b.subjectId != null ? nameOf(sim, b.subjectId) : '';
  return `${b.kind || 'event'}${who ? ' — ' + who : ''}`;
}

/** The town GAZETTE — its latest articles (`gazette.recent(n)`, newest-first), as headline + body. */
export function gazetteLines(sim: any, n: number): string[] {
  const gaz = sim.gazette;
  const arts: any[] = gaz && gaz.recent ? gaz.recent(n) : [];
  if (!arts.length) return ['No news yet — the gazetteer is out looking for a story.'];
  const out: string[] = [];
  for (const a of arts) {
    out.push('▪ ' + (a.headline || a.kind || 'Report'));
    if (a.body) out.push('  ' + String(a.body).slice(0, 140));
  }
  return out;
}

/** Set of agent-ids currently in the player's party (companions). */
function partySet(sim: any): Set<any> {
  const s = new Set<any>();
  const members = sim.party && (sim.party.members || sim.party.companions);
  if (Array.isArray(members)) for (const m of members) s.add(m.id != null ? m.id : m);
  return s;
}

/** Run `fn`, falling back to `dflt` on any throw (the sim's arena helpers can throw at the edges). */
function safe<T>(fn: () => T, dflt: T): T {
  try {
    return fn();
  } catch {
    return dflt;
  }
}
