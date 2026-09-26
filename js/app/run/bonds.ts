// BONDS: how close two people on your side have grown, across runs (docs/architecture/23).
// Grown from what happened in a fight (a save, a revival, a combo, fighting together), installed
// into each Battle so the rules can use them (together, dive in, steady nerve, wrath, pincer).
//
//   save.bonds['borin|pip'] = { xp, lvl, kind }     — 'player' is a valid member

import { pairKey, type Battle, type Bond, type Unit } from '../tactics/battle.js';

export interface BondRec { xp: number; lvl: number; kind: 'friend' | 'rival' }
export const BOND_XP = [0, 3, 8, 15, 25];
const lvlOf = (xp: number) => BOND_XP.filter((t) => xp >= t).length - 1;
const NAMES: Record<string, string> = { player: 'you' };

/** Seat the run's bonds into a battle: members are 'player' or companion keys. */
export function installBonds(b: Battle, bonds: Record<string, BondRec>, idOf: Map<string, Unit['id']>): void {
  b.bonds.clear();
  for (const [k, rec] of Object.entries(bonds)) {
    const [a, c] = k.split('|'); const ia = idOf.get(a), ic = idOf.get(c);
    if (ia != null && ic != null && rec.lvl > 0) b.bonds.set(pairKey(ia, ic), { lvl: rec.lvl, kind: rec.kind } as Bond);
  }
}

/**
 * Fold a finished battle into the bonds. `keyOf` maps unit ids to members ('player' / companion
 * keys); `nameOf` gives display names. Returns the growth lines for the stage report.
 */
export function foldBonds(b: Battle, bonds: Record<string, BondRec>, keyOf: Map<Unit['id'], string>, nameOf: (k: string) => string, won: boolean): string[] {
  const gain = new Map<string, number>();
  const add = (x: Unit['id'] | undefined, y: Unit['id'] | undefined, n: number) => {
    const a = x != null ? keyOf.get(x) : undefined, c = y != null ? keyOf.get(y) : undefined;
    if (!a || !c || a === c) return;
    const k = [a, c].sort().join('|'); gain.set(k, (gain.get(k) ?? 0) + n);
  };
  let combos = 0;
  const downed = new Set<Unit['id']>();
  for (const e of b.events) {
    if (e.kind === 'save') add(e.actor, e.target, 4);
    else if (e.kind === 'revive') add(e.actor, e.target, 3);
    else if (e.kind === 'combo' && combos < 3) { add(e.actor, e.with, 1); combos++; }
    else if (e.kind === 'down' && e.target != null) downed.add(e.target);
    else if (e.kind === 'broke') add(e.actor, e.target, -1);
    else if ((e.kind === 'escape' || e.kind === 'broken') && e.actor != null) for (const d of downed) add(e.actor, d, -2);
  }
  if (won) {
    const standing = b.units.filter((u) => u.side === 'us' && u.out === null && keyOf.has(u.id));
    for (let i = 0; i < standing.length; i++) for (let j = i + 1; j < standing.length; j++) add(standing[i].id, standing[j].id, 0.5);
  }
  const lines: string[] = [];
  for (const [k, n] of gain) {
    const rec = bonds[k] ?? (bonds[k] = { xp: 0, lvl: 0, kind: 'friend' });
    const before = rec.lvl;
    rec.xp = Math.max(0, rec.xp + n); rec.lvl = lvlOf(rec.xp);
    if (rec.lvl !== before) {
      const [a, c] = k.split('|').map((m) => NAMES[m] ?? nameOf(m));
      lines.push(`${a[0].toUpperCase() + a.slice(1)} & ${c}: bond ${rec.lvl > before ? '▲' : '▼'} ${rec.lvl}`);
    }
  }
  return lines;
}
