// Glyph + colour tables for the Dwarf-Fortress-style ASCII view (docs: standalone observer page,
// `df.html`). A "cell" is one character + a colour; the renderer (`view.ts`) layers biome background <
// POIs < percepts < agents and the look-cursor on top. Kept ASCII-leaning so it renders in any
// monospace font; a few common box/heart glyphs are used for landmarks.

export interface Cell {
  ch: string;
  color: string;
}

// ── factions (the living things) ──────────────────────────────────────────────────────────────
// Glyph by faction; the player and party are special-cased brighter in the renderer.
const FACTION_GLYPH: Record<string, Cell> = {
  townsfolk: { ch: 't', color: '#cdd6c4' },
  monster: { ch: 'M', color: '#e0524a' },
  raider: { ch: 'r', color: '#e0863a' },
  watch: { ch: 'W', color: '#6fc6d8' },
  player: { ch: '@', color: '#f4d35e' },
};
export function factionCell(faction: string): Cell {
  return FACTION_GLYPH[faction] || { ch: '?', color: '#9aa' };
}
export const PARTY_COLOR = '#8fe07a'; // a companion in the player's party (overrides faction colour)
export const PLAYER_CELL: Cell = FACTION_GLYPH.player;
export const HOSTILE_RING = '#e0524a'; // the cursor-target tint when looking at a believed-hostile

// ── POIs (the static world) ───────────────────────────────────────────────────────────────────
const POI_GLYPH: Record<string, Cell> = {
  market: { ch: '$', color: '#e8c879' },
  forge: { ch: 'F', color: '#d98a4a' },
  field: { ch: '"', color: '#b8c46a' },
  forest: { ch: '♣', color: '#4f8f50' }, // ♣
  mine: { ch: '▲', color: '#9a7d5a' }, // ▲
  meadow: { ch: ',', color: '#86b060' },
  rest: { ch: '≈', color: '#9a8f7a' }, // ≈ a campfire / rest site
  hut: { ch: '⌂', color: '#c0a070' }, // ⌂
  well: { ch: 'o', color: '#7fb0c0' },
};
export function poiCell(kind: string): Cell | null {
  return POI_GLYPH[kind] || null;
}

// ── biome background (dim texture) ────────────────────────────────────────────────────────────
const BIOME_GLYPH: Record<string, Cell> = {
  village: { ch: '·', color: '#3a3c33' }, // ·
  plains: { ch: '·', color: '#2c3a24' },
  forest: { ch: '♣', color: '#27401f' },
  hills: { ch: '^', color: '#43392a' },
  wilds: { ch: '%', color: '#3a2626' },
};
export function biomeCell(biome: string): Cell {
  return BIOME_GLYPH[biome] || { ch: ' ', color: '#222' };
}

// ── TEXTURED biome background ──────────────────────────────────────────────────────────────────
// Drawing every biome cell as one identical glyph makes solid blocks; instead each cell picks a glyph
// VARIANT + a small brightness jitter from a position hash, so a forest reads as scattered trees with
// gaps and plains as open ground — organic texture, not tiling. Deterministic per (x,z).
const BIOME_TEX: Record<string, { glyphs: string[]; color: string }> = {
  village: { glyphs: ['·', '·', ',', "'"], color: '#3a3c33' },
  plains: { glyphs: ['·', '·', ' ', ',', "'", ' '], color: '#2c3a24' },
  forest: { glyphs: ['♣', '♠', 'T', '♣', '·', ','], color: '#274a1d' },
  hills: { glyphs: ['^', '^', 'n', '·', '^'], color: '#46392a' },
  wilds: { glyphs: ['%', '#', '*', '·', '%'], color: '#3c2626' },
};
function bhash(x: number, z: number): number {
  let h = (Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(z) | 0, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
function jitter(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
export function biomeCellAt(biome: string, x: number, z: number): Cell {
  const t = BIOME_TEX[biome];
  if (!t) return { ch: ' ', color: '#222' };
  const ch = t.glyphs[Math.floor(bhash(x, z) * t.glyphs.length)] || '·';
  const f = 0.82 + bhash(x + 1.7, z + 9.3) * 0.36; // brightness 0.82 .. 1.18
  return { ch, color: jitter(t.color, f) };
}

// a prop (percept) — a mind-less thing dressed as something (scarecrow, building)
export const PERCEPT_CELL: Cell = { ch: '¤', color: '#8a7f6a' }; // ¤

// a named LANDMARK — a place worth exploring to. Bright so an explorer's destinations stand out.
export const LANDMARK_CELL: Cell = { ch: '⚑', color: '#d8b24a' }; // ⚑ a waypoint flag

export const EMPTY: Cell = { ch: ' ', color: '#222' };
