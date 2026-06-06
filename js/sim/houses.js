// HOUSES — lineage surnames + the name-composition for them. A founding townsperson
// heads their own house; children carry the surname down the bloodline (see lineage).
// Kept in its own module so both Simulation (founders) and Lineage (births) can use
// the EXACT same name-composition without a circular import.

import { HOUSES } from './simconfig.js';

// fold a surname into an agent's display name ("Aldric" + "Vael" -> "Aldric Vael").
// Idempotent on `given`, so an epithet appended later still reads ("Aldric Vael the Bold").
export function assignHouse(agent, house) {
  if (!HOUSES || !HOUSES.enabled || !house || !agent) return;
  agent.given = agent.given || agent.name;
  agent.house = house;
  agent.name = `${agent.given} ${house}`;
}

// the house a founder (index i) heads — cycles the surname pool for larger rosters.
export function founderHouse(i) {
  const s = HOUSES && HOUSES.surnames;
  return (s && s.length) ? s[i % s.length] : null;
}

// ---- HOUSE FEUDS (multi-generational sagas) --------------------------------
// A durable feud between two HOUSES (not just two people) — children born into a
// feuding house inherit the grudge, so the strife outlives its founders until a
// cross-house marriage heals it. Stored as a Set of canonical "A|B" keys on the sim.
export function houseFeudKey(h1, h2) { return h1 < h2 ? `${h1}|${h2}` : `${h2}|${h1}`; }
export function areHousesFeuding(sim, h1, h2) {
  return !!(h1 && h2 && h1 !== h2 && sim && sim.houseFeuds && sim.houseFeuds.has(houseFeudKey(h1, h2)));
}
export function setHouseFeud(sim, h1, h2) {
  if (!sim || !h1 || !h2 || h1 === h2) return false;
  (sim.houseFeuds || (sim.houseFeuds = new Set())).add(houseFeudKey(h1, h2));
  return true;
}
export function endHouseFeud(sim, h1, h2) {
  if (sim && sim.houseFeuds && h1 && h2) return sim.houseFeuds.delete(houseFeudKey(h1, h2));
  return false;
}
// one house that `house` is at feud with (or null) — for inheriting the grudge.
export function feudingHouseOf(sim, house) {
  if (!sim || !sim.houseFeuds || !house) return null;
  for (const k of sim.houseFeuds) { const i = k.indexOf('|'); const a = k.slice(0, i), b = k.slice(i + 1); if (a === house) return b; if (b === house) return a; }
  return null;
}
