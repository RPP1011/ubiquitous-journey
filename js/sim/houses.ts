// HOUSES — lineage surnames + the name-composition for them. A founding townsperson
// heads their own house; children carry the surname down the bloodline (see lineage).
// Kept in its own module so both Simulation (founders) and Lineage (births) can use
// the EXACT same name-composition without a circular import.

import { HOUSES } from './simconfig.js';

// `sim` (the owning Simulation — wave-2, still .js) and `agent` (via its drama-name flags)
// are typed opaquely on purpose; behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

// fold a surname into an agent's display name ("Aldric" + "Vael" -> "Aldric Vael").
// Idempotent on `given`, so an epithet appended later still reads ("Aldric Vael the Bold").
export function assignHouse(agent: Ag, house: string | null): void {
  if (!HOUSES || !HOUSES.enabled || !house || !agent) return;
  agent.given = agent.given || agent.name;
  agent.house = house;
  agent.name = `${agent.given} ${house}`;
}

// the house a founder (index i) heads — cycles the surname pool for larger rosters.
export function founderHouse(i: number): string | null {
  const s = HOUSES && HOUSES.surnames;
  return (s && s.length) ? s[i % s.length] : null;
}

// ---- OATHBREAKER BRAND (betrayal-as-choice) --------------------------------
// A soul who breaks ENOUGH vows (life.forsworn ≥ HOUSES.forswornBrandAt) earns a dark
// epithet that reads in every future chronicle beat — the negative dynastic counterpart to
// "the Bold". Branded ONCE per life, and only on a not-yet-named agent (an epithet already
// won — hero or villain — is never clobbered). Pure name/chronicle effect: no gold, no
// belief, no truth. Returns the epithet awarded (or null). Called by the observer layer
// (patrician.ts) when the social leak fires, so the brand spreads with the news.
export function brandForsworn(sim: Sim, a: Ag): string | null {
  try {
    if (!HOUSES || !HOUSES.enabled || !a || a.epithet) return null;
    const at = (HOUSES as { forswornBrandAt?: number }).forswornBrandAt ?? 3;
    if (((a.life && a.life.forsworn) || 0) < at) return null;
    const pool = (HOUSES as { forswornNames?: string[] }).forswornNames;
    if (!pool || !pool.length) return null;
    const epithet = pool[(Number(a.id) || 0) % pool.length];   // deterministic, varied by id
    a.epithet = epithet;
    a.given = a.given || a.name;
    a.name = `${a.name} ${epithet}`;                           // keeps their name + earns the dark title
    try { if (sim && sim.chronicle && sim.chronicle.note) sim.chronicle.note('legend', a.id, `${a.name} is named ${epithet} — a breaker of sworn words.`); } catch { /* */ }
    return epithet;
  } catch { return null; }   // never throw on the tick
}

// ---- HOUSE FEUDS (multi-generational sagas) --------------------------------
// A durable feud between two HOUSES (not just two people) — children born into a
// feuding house inherit the grudge, so the strife outlives its founders until a
// cross-house marriage heals it. Stored as a Set of canonical "A|B" keys on the sim.
export function houseFeudKey(h1: string, h2: string): string { return h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`; }
export function areHousesFeuding(sim: Sim, h1: string | null, h2: string | null): boolean {
  return !!(h1 && h2 && h1 !== h2 && sim && sim.houseFeuds && sim.houseFeuds.has(houseFeudKey(h1, h2)));
}
export function setHouseFeud(sim: Sim, h1: string | null, h2: string | null): boolean {
  if (!sim || !h1 || !h2 || h1 === h2) return false;
  (sim.houseFeuds || (sim.houseFeuds = new Set())).add(houseFeudKey(h1, h2));
  return true;
}
export function endHouseFeud(sim: Sim, h1: string | null, h2: string | null): boolean {
  if (sim && sim.houseFeuds && h1 && h2) return sim.houseFeuds.delete(houseFeudKey(h1, h2));
  return false;
}
// one house that `house` is at feud with (or null) — for inheriting the grudge.
export function feudingHouseOf(sim: Sim, house: string | null): string | null {
  if (!sim || !sim.houseFeuds || !house) return null;
  for (const k of sim.houseFeuds) { const i = k.indexOf('|'); const a = k.slice(0, i), b = k.slice(i + 1); if (a === house) return b; if (b === house) return a; }
  return null;
}
