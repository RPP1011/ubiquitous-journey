// SET-PIECES: the signature things in a place that anyone — you, your companions, the foes — can
// use once to change the fight (cut the log-pile loose, ring the chapel bell, open the sluice).
// Pure data + geometry: a piece is a list of EFFECTS over AREAS, resolved by Battle.usePiece()
// from the same primitives the rest of the rules use (wound, ignite, walls, props, morale).
// The AI weighs a piece by its forecast like any other option; the parser reads it by its nouns.

import type { PropKind } from './map.js';

type Spot = { x: number; z: number };
type Dir = [number, number];

/** Where an effect lands. Lines run from the piece's anchor (its first tile). */
export type Area =
  | { tiles: Array<[number, number]> }
  | { line: 'away' | Dir; len: number; width?: 1 | 3; from?: [number, number]; stopAtFirst?: boolean }
  | { around: number };

export type PieceEffect =
  | { do: 'hit'; area: Area; dmg: number; prone?: boolean; expose?: boolean; shake?: boolean }
  | { do: 'ignite'; area: Area }
  | { do: 'flood'; area: Area }
  | { do: 'breach'; area: Area }
  | { do: 'drop'; area: Area; prop: PropKind }
  | { do: 'smoke'; area: Area; turns: number }
  | { do: 'shake'; r: number };

export interface PieceDef {
  id: string;
  /** Visual kind (ui/stageSet builds and animates it). */
  kind: string;
  name: string;
  /** What the panel and forecast call using it ("Cut the lashings"). */
  label: string;
  nouns: string[];
  verbs: string[];
  at: Array<[number, number]>;
  /** A solid piece fills its tiles (walls) until used. */
  solid?: boolean;
  /** How close you must stand (tiles from any of its tiles). Default 1. */
  reach?: number;
  check?: { stat: 'might' | 'finesse' | 'presence'; dc: number };
  needsFire?: boolean;
  effects: PieceEffect[];
  /** What the log says when it goes. */
  says: string;
  /** The forecast in plain words. */
  describe: string;
}

export interface PieceState extends PieceDef { used: boolean }

const dist = (a: Spot, b: Spot) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z);

/** Direction from a to b along the dominant axis. */
function dirFrom(a: Spot, b: Spot): Dir {
  const dx = b.x - a.x, dz = b.z - a.z;
  return Math.abs(dx) >= Math.abs(dz) ? [Math.sign(dx) || 1, 0] : [0, Math.sign(dz) || 1];
}

/**
 * The tiles an area covers when `user` (standing at `from`) sets the piece off. `inBounds` and
 * `blocked` let a line stop at the map edge or at a wall/unit.
 */
export function areaTiles(p: PieceDef, a: Area, from: Spot, inBounds: (s: Spot) => boolean, unitAt?: (s: Spot) => boolean): Spot[] {
  const anchor = { x: p.at[0][0], z: p.at[0][1] };
  if ('tiles' in a) return a.tiles.map(([x, z]) => ({ x, z })).filter(inBounds);
  if ('around' in a) {
    const out: Spot[] = [];
    for (let dx = -a.around; dx <= a.around; dx++) for (let dz = -a.around; dz <= a.around; dz++) {
      const s = { x: anchor.x + dx, z: anchor.z + dz };
      if (Math.abs(dx) + Math.abs(dz) <= a.around && inBounds(s)) out.push(s);
    }
    return out;
  }
  const d: Dir = a.line === 'away' ? dirFrom(from, anchor) : a.line;
  const o = a.from ? { x: a.from[0], z: a.from[1] } : anchor;
  const side: Dir = [d[1], d[0]];
  const out: Spot[] = [];
  for (let i = 1; i <= a.len; i++) {
    let stop = false;
    for (const w of a.width === 3 ? [-1, 0, 1] : [0]) {
      const s = { x: o.x + d[0] * i + side[0] * w, z: o.z + d[1] * i + side[1] * w };
      if (!inBounds(s)) continue;
      out.push(s);
      if (a.stopAtFirst && unitAt?.(s)) stop = true;
    }
    if (stop) break;
  }
  return out;
}

/** Can a unit standing at `from` reach the piece? */
export function inReach(p: PieceDef, from: Spot): boolean {
  const r = p.reach ?? 1;
  return p.at.some(([x, z]) => dist(from, { x, z }) <= r);
}

/** Every tile the piece touches (for the forecast and the preview). */
export function pieceFootprint(p: PieceDef, from: Spot, inBounds: (s: Spot) => boolean, unitAt?: (s: Spot) => boolean): Spot[] {
  const seen = new Set<string>(), out: Spot[] = [];
  for (const e of p.effects) {
    if (e.do === 'shake') continue;
    for (const s of areaTiles(p, e.area, from, inBounds, unitAt)) { const k = `${s.x},${s.z}`; if (!seen.has(k)) { seen.add(k); out.push(s); } }
  }
  return out;
}
