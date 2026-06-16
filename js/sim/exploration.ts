// EXPLORATION / DISCOVERY (making the world worth roaming). A light world-pass that turns the static
// LANDMARKS into things worth REACHING: the first time a living soul comes within `DISCOVER_R` of a
// landmark it DISCOVERS it — a vivid lasting memory (feeds biography), an EXPLORE deed scaled by how far
// out the place is (the explorer/hunter identity; the frontier is worth more than the well), and — for
// whoever reaches it FIRST of all — a chronicle beat, a renown-worthy life-deed, and a one-time CACHE of
// GOODS (never gold, so the closed money loop is untouched; goods mint like foraging).
//
// EPISTEMIC NOTE: this is an EXECUTION-side observer pass (like `onCombatEvents` folding combat into
// memory) — it reads ground-truth positions to grant rewards, it never drives a cognition decision. The
// COGNITION side (which landmark to head for) lives in `agent/steer.ts` (`fillSightsee`), reading only
// the agent's OWN `_seen` set + the static landmark list — so the split holds.

import { LANDMARKS, nearestLandmark, ARENA_RADIUS } from '../arena.js';
import { bus, makeEvent } from '../rpg/events.js';
import type { ActionEvent, ActionEventSpec, FullCtx } from '../../types/sim.js';

type Sim = any; // the js Simulation spine (loose, like the other subsystems)
type Ag = any; // a roster agent + its transient `_seen`/`life` scratch — justified loose type

const mkEvent = makeEvent as (spec: ActionEventSpec) => ActionEvent;

// Come within this many metres of a landmark to "discover" it (a little above market/work range so a
// passing traveller takes it in, but you must genuinely arrive — not merely glimpse it from afar).
const DISCOVER_R = 22;

export class Exploration {
  sim: Sim;
  firstSeen: Map<string, unknown>; // landmark name -> the id of the FIRST soul ever to reach it
  townKnown: Set<string>; // landmarks at a town centre — "home", never an EXPLORATION (no credit)
  stats: { discoveries: number; firsts: number };

  constructor(sim: Sim) {
    this.sim = sim;
    this.firstSeen = new Map();
    // A landmark sitting in the town centre (Marketwell) is HOME, not a discovery — you don't "explore"
    // the square you live on. Computed here (not in `primeKnown`) so it holds even when a test stage
    // builds a Simulation WITHOUT calling spawn(): reaching such a landmark grants no credit. Genuine,
    // distant landmarks are the explorable world.
    this.townKnown = new Set(LANDMARKS.filter((L) => Math.hypot(L.x, L.z) < 24).map((L) => L.name));
    this.stats = { discoveries: 0, firsts: 0 };
  }

  // Mark the home-town landmarks as already first-found, so the town you spawned in is never a heroic
  // "first reached". (Run from Simulation.spawn() once the world exists.)
  primeKnown(): void {
    for (const name of this.townKnown) this.firstSeen.set(name, '_town');
  }

  tick(ctx: FullCtx): void {
    const now = (ctx && (ctx as { time?: number }).time) || 0;
    const agents = (ctx && (ctx as { agents?: Ag[] }).agents) || [];
    for (const a of agents) {
      // explorers are LIVING, autonomous, non-monster souls (townsfolk, adventurers, the curious).
      if (!a.alive || a.faction === 'monster' || a.controlled) continue;
      const L = nearestLandmark(a.pos.x, a.pos.z, DISCOVER_R);
      if (!L) continue;
      if (!a._seen) a._seen = new Set<string>();
      if (a._seen.has(L.name)) continue;
      a._seen.add(L.name); // now known to this soul (so we don't re-check it every tick)
      if (this.townKnown.has(L.name)) continue; // home-town landmark — known, not "explored": no credit
      this._discover(a, L, now);
    }
  }

  _discover(a: Ag, L: { name: string; x: number; z: number; find?: { good: string; qty: number }; lore?: string }, now: number): void {
    this.stats.discoveries++;
    const remoteness = Math.min(1, Math.hypot(L.x, L.z) / ARENA_RADIUS); // 0 at home … 1 at the frontier
    if (a.life) a.life.discoveries = (a.life.discoveries || 0) + 1;

    // a lasting, vivid memory of the place — the farther out, the more it marks the life (biography reads it).
    if (a.memory && a.memory.record) {
      a.memory.record({ t: now, kind: 'beheld', place: L.name, valence: 1, salience: 0.45 + 0.45 * remoteness });
    }
    // an EXPLORE deed (the explorer identity / hunter class): magnitude grows with distance from home, so
    // pushing into the deep frontier earns real progression, not just strolling to the nearest cairn.
    bus.emit(mkEvent({ actorId: a.id, verb: 'explore', tags: ['EXPLORE'], magnitude: 1 + Math.round(3 * remoteness), t: a._rpgNow || now }));

    // FIRST EVER to reach it: a chronicle beat, a renown-worthy life-deed, and the cache (if any).
    if (!this.firstSeen.has(L.name)) {
      this.firstSeen.set(L.name, a.id);
      this.stats.firsts++;
      if (a.life) a.life.firsts = (a.life.firsts || 0) + 1;
      const lore = L.lore ? ` — ${L.lore}` : '';
      if (this.sim.chronicle && this.sim.chronicle.note) {
        this.sim.chronicle.note('discovery', a.id, `${a.name} was first to reach ${L.name}${lore}.`);
      }
      // a one-time CACHE of GOODS (conserved-safe: goods are not gold). The bold who reach the deep,
      // dangerous ruins claim the richest finds (potions/ore/wood) — the frontier pays the explorer.
      if (L.find && a.inventory) {
        a.inventory[L.find.good] = (a.inventory[L.find.good] || 0) + L.find.qty;
        if (a.memory && a.memory.record) {
          a.memory.record({ t: now, kind: 'relic', place: L.name, valence: 1, salience: 0.75 });
        }
      }
    }
  }
}
