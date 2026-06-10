// NARRATIVE SEEDING — plant initial conditions that GROW into recognizable tropes.
//
// The philosophy: we don't script stories. We seed the starting RELATIONSHIPS and
// state, then the systems we already have (apprenticeship/lineage, the class/XP
// brain, memory-grudges, intrigue, groups, the director) play them out, and the
// Chronicle makes them legible. seedNarratives(sim) runs once, from Simulation.
// spawn(), after the town/camps exist. Everything is config-driven (SEEDS) and
// guarded — a bad seed must never throw on world build.
//
// TROPE: rival apprentices. A seasoned MASTER of a trade and TWO young apprentices
// who resent each other. The existing apprenticeship pass (lineage.js) copies the
// master's craft-tags onto both (fast-tracking the [Blacksmith] class), while the
// seeded RIVALRY (mutual negative belief-standing) keeps them competing — and the
// chronicle narrates them rising, until one surpasses the other.

import * as THREE from 'three';
import { Agent } from './agent.js';
import { SEEDS } from './simconfig.js';
import { terrainHeight } from '../arena.js';
import { ABILITY_CATALOG } from '../rpg/abilities/catalog.js';
import { BEAT } from './chronicle.js';
import { arcKey } from './arcs.js';
import { setHouseFeud } from './houses.js';
import { rng } from './rng.js';

// `sim` (the owning Simulation — wave-2, still .js), `cfg` (the SEEDS.rivalApprentices
// config block) and the seeded Agents are typed opaquely on purpose; this runs once at
// world build and is fully guarded, so behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = any;

const rand = (a: number, b: number): number => a + rng() * (b - a);
const groundY = (x: number, z: number): number => { try { return typeof document === 'undefined' ? 0 : terrainHeight(x, z); } catch { return 0; } };

// entry point — run all enabled seeds. Guarded per-seed so one bad seed can't
// abort the others (or the world build).
export function seedNarratives(sim: Sim): void {
  if (!SEEDS || !SEEDS.enabled) return;
  try {
    const ra = SEEDS.rivalApprentices;
    if (ra && ra.enabled) {
      for (let i = 0; i < (ra.trios || 1); i++) seedRivalApprentices(sim, ra, i);
    }
  } catch { /* never throw during world build */ }
}

// build one trade family: a veteran master + two rival apprentices, clustered so
// the apprenticeship pass (proximity-gated) immediately recognises the master.
function seedRivalApprentices(sim: Sim, cfg: Cfg, idx: number): void {
  try {
    // a quiet spot near the town core (inside the watchtower ring, so the smithy is
    // defended). Spread successive trios apart a little.
    const base = new THREE.Vector3(8 + idx * 6, 0, 8 + idx * 6);

    // a homebody master keeps to the smithy near the defended core (so it survives
    // to teach rather than wandering off to a frontier work site and dying young).
    const master = makeTownsperson(sim, base.x, base.z, { ambition: 0.6, social_drive: 0.6, risk_tolerance: 0.25 });
    master.seedRole = 'master';
    master.seedTrade = cfg.classKey;
    if (cfg.masterName) master.name = cfg.masterName;

    // make the master a SEASONED tradesman: a craft-dominant profile (so it reads
    // as a master and teaches the right tags), the class granted at a master's
    // level, and ARMED with a real, pre-validated trade ability (granted directly
    // so the "every classed agent is armed" invariant holds even before the lazy
    // ability catalog has finished loading in a fresh sim).
    seedProfile(master, cfg.masterTags);
    grantSeededClass(master, cfg.classKey, cfg.className, cfg.masterLevel);
    armFromCatalog(master, cfg.armAbility);

    // two apprentices flanking the master (well within LINEAGE.masterRange) — young
    // (level 0, so the apprenticeship pass picks them up), driven (high ambition →
    // they work the trade and earn XP), and already leaning toward the craft.
    const names = cfg.apprenticeNames || [];
    const a = makeTownsperson(sim, base.x - 3, base.z + 2, { ambition: cfg.apprenticeAmbition, risk_tolerance: 0.4 });
    const b = makeTownsperson(sim, base.x + 3, base.z + 2, { ambition: cfg.apprenticeAmbition, risk_tolerance: 0.4 });
    if (names[0]) a.name = names[0];
    if (names[1]) b.name = names[1];
    for (const ap of [a, b]) { ap.seedRole = 'apprentice'; ap.masterId = master.id; ap.seedTrade = cfg.classKey; seedProfile(ap, cfg.apprenticeTags); }
    a.rivalId = b.id; b.rivalId = a.id;

    // the RIVALRY, two ways so it doesn't simply mellow into friendship:
    //  - mutual negative belief-standing (the relations view + decide read it), and
    //  - a durable 'rival' bond MEMORY on each (the autobiography keeps it even after
    //    the belief decays — the spec fades grudges 5× slower, so the rivalry stays
    //    part of who they are and reads in the biography/chronicle).
    sour(a, b, cfg.rivalry);
    sour(b, a, cfg.rivalry);
    bond(a, b.id, 'rival'); bond(b, a.id, 'rival');

    // record the mentorship bonds up front (the apprenticeship pass reinforces them)
    bond(a, master.id, 'apprentice'); bond(b, master.id, 'apprentice');
    bond(master, a.id, 'mentor'); bond(master, b.id, 'mentor');

    // a chronicle beat so the seeded premise is legible from the first minute.
    if (sim.chronicle && sim.chronicle.note) {
      sim.chronicle.note(BEAT.MENTOR, master.id,
        `${master.name} took on rival apprentices ${a.name} and ${b.name}.`);
    }
  } catch { /* a failed seed must not abort world build */ }
}

// --- helpers ----------------------------------------------------------------

// spawn a townsperson the same way Simulation does (so combat/groups/inspector all
// just work), at (x,z), with personality overrides merged onto a sane baseline.
function makeTownsperson(sim: Sim, x: number, z: number, pers: Record<string, number> = {}): Ag {
  const fighter = sim.makeFighter('knight', {});
  const px = x, pz = z, py = groundY(px, pz);
  fighter.root.position.set(px, py, pz);
  sim.scene.add(fighter.root);
  const personality = {
    risk_tolerance: 0.35, social_drive: 0.6, ambition: 0.6, altruism: 0.5, curiosity: 0.5,
    ...pers,
  };
  const a = new Agent(fighter, {
    id: sim._nextId++, name: sim._takeName(), profession: null,
    personality, faction: 'townsfolk', townsperson: true,
  });
  sim.agents.push(a);
  sim.agentsById.set(a.id, a);
  return a;
}

// stamp a behaviour profile so the class matcher reads the intended identity and
// XP routes to the trade class. Additive onto whatever the agent started with.
function seedProfile(agent: Ag, tags: Record<string, number> | null | undefined): void {
  const bp = agent.progression && agent.progression.behavior_profile;
  if (!bp || !tags) return;
  for (const tag in tags) bp[tag] = (bp[tag] || 0) + tags[tag];
}

// grant a specific TEMPLATE class at a seeded level (a veteran). Reuses the
// progression internals (same module ecosystem) and recomputes the cached total.
function grantSeededClass(agent: Ag, key: string, name: string | null, level: number): void {
  const prog = agent.progression;
  if (!prog) return;
  prog._grantClass(key, name || key, 0);
  const cls = prog.classes.get(key);
  if (!cls) return;
  cls.level = Math.max(1, level | 0);
  prog.totalLevel = prog._sumLevels();
}

// arm an agent with a named, pre-validated catalog ability (mirrored onto both the
// progression ledger and the Agent, like Progression._grantAbility would). This is
// what keeps a seeded veteran from violating the "classed ⇒ armed" invariant before
// the lazily-loaded ability catalog has resolved in a fresh sim.
function armFromCatalog(agent: Ag, abilityId: string | null | undefined): void {
  try {
    const spec = abilityId && (ABILITY_CATALOG as Record<string, { id?: string } | undefined>)[abilityId];
    if (!spec || !spec.id) return;
    if (agent.progression) { agent.progression.abilities.set(spec.id, spec); agent.progression.cooldowns.set(spec.id, 0); }
    agent.grantAbility(spec);
  } catch { /* arming is best-effort */ }
}

// push observer A's belief-standing toward B down (a grievance / rivalry seed).
function sour(A: Ag, B: Ag, amount: number): void {
  try {
    const b = A.beliefs && A.beliefs._ensure ? A.beliefs._ensure(B.id) : null;
    if (!b) return;
    b.standing = Math.max(-1, Math.min(1, (b.standing || 0) + amount));
    if (b.confidence < 0.5) b.confidence = 0.5;        // a felt rivalry, not a fleeting impression
    b.lastFaction = B.faction;
  } catch { /* */ }
}

// record a relationship bond memory (kin/mentor/apprentice/mate) — the same episode
// kind lineage uses, so the biography/chronicle read it uniformly.
function bond(a: Ag, withId: unknown, rel: string): void {
  try { if (a && a.memory) a.memory.record({ t: 0, kind: 'bond', withId, rel, valence: rel === 'mentor' || rel === 'apprentice' ? 0.6 : 1, salience: 0.6 }); } catch { /* */ }
}

// ============================================================================
// THE PER-AGENT AUTHORING / TARGETING API (docs/architecture/12 §4 — the SET-UP axis)
// ============================================================================
// Pure functions that stamp a CHOSEN protagonist + plant the targeted constellation, then open the
// matching emergent arc (sim.sagas) AND push a PRE-TARGETED Director arc (chosen principals, not the
// _shuffle roulette) so the existing stepper plays it to a saga unchanged. Callable at world build OR
// from a scenario/test — which is what makes the trope suite DETERMINISTIC. All guarded; never throw.
// Convention (load-bearing — standing is per-perceiver): warm(x→y) raises the standing HELD BY x
// ABOUT y. "a trusts b" is warm(a→b).

// move an agent's gold to an exact target, CONSERVED (closed money loop): the delta is debited from /
// credited to a counterpart (the richest other live agent), never minted. No-op if none can balance it.
function setGoldConserved(sim: Sim, a: Ag, target: number): void {
  try {
    const cur = a.gold || 0, delta = target - cur;
    if (Math.abs(delta) < 1e-9) return;
    let other: Ag = null, bestGold = -Infinity;
    for (const o of sim.agents) { if (o === a || !o.alive) continue; if ((o.gold || 0) > bestGold) { bestGold = o.gold || 0; other = o; } }
    if (!other) return;
    if (delta > 0 && (other.gold || 0) < delta) return;     // no one can fund the raise — leave it
    other.gold = (other.gold || 0) - delta;
    a.gold = cur + delta;
  } catch { /* never throw */ }
}

// PIN — stamp chosen fields onto an EXISTING agent (the protagonist). gold is a CONSERVED set.
export function pin(sim: Sim, agentId: unknown, opts: Record<string, unknown> = {}): Ag {
  try {
    const a = sim.agentsById.get(agentId); if (!a) return null;
    if (opts.personality) Object.assign(a.personality || (a.personality = {}), opts.personality);
    if (opts.role) a.seedRole = opts.role;
    if (opts.house) a.house = opts.house;
    if (typeof opts.gold === 'number') setGoldConserved(sim, a, opts.gold as number);
    if (opts.ambition && typeof a.assignAmbition === 'function') { try { a.assignAmbition(sim.time, null, opts.ambition); } catch { /* best-effort */ } }
    return a;
  } catch { return null; }
}

// FORCE BETRAYAL — a trusts b, then b wrongs a. Warms a→b, plants a fresh wrong (a's `assaulted`
// memory + soured belief), opens the vendetta arc, and pushes a PRE-TARGETED Director 'reckoning'.
export function forceBetrayal(sim: Sim, aId: unknown, bId: unknown): boolean {
  try {
    const a = sim.agentsById.get(aId), b = sim.agentsById.get(bId);
    if (!a || !b) return false;
    sour(a, b, 0.6);                                   // a TRUSTED b (warm a→b; sour adds the signed amount)
    sour(a, b, -1.2);                                  // …then the wrong lands — a's opinion of b craters
    if (a.memory) a.memory.record({ t: sim.time, kind: 'assaulted', withId: bId, valence: -1, salience: 0.95 });
    if (sim.sagas) sim.sagas.openArc({ kind: 'vendetta', key: arcKey('vendetta', aId as string, bId as string), principals: [aId, bId] });
    (sim.director._arcs || (sim.director._arcs = [])).push({ kind: 'reckoning', wronged: aId, betrayer: bId, rel: 'one who trusted them', stage: 1, nextAt: sim.time + 30 });
    return true;
  } catch { return false; }
}

// FALSE WITNESS — brand an innocent. Plants suspicion of the victim into nearby townsfolk (carrying
// the accuser as PROVENANCE if given, for a future "false accuser exposed" arc), and pushes a
// PRE-TARGETED Director 'accused' arc with the chosen victim (not _shuffle).
export function falseWitness(sim: Sim, victimId: unknown, accuserId?: unknown): boolean {
  try {
    const victim = sim.agentsById.get(victimId); if (!victim) return false;
    let planted = 0;
    for (const w of sim.agents) {
      if (w === victim || !w.alive || w.controlled || w.faction !== 'townsfolk' || !w.beliefs) continue;
      if (w.pos.distanceTo(victim.pos) > 30) continue;
      try {
        const wb = w.beliefs.plant ? w.beliefs.plant(victimId, { suspicion: 0.6, confidence: 0.6 }) : null;
        if (wb && accuserId != null) wb.source = 'accuser:' + accuserId;   // provenance — who started the slander
        planted++;
      } catch { /* per-witness guard */ }
    }
    (sim.director._arcs || (sim.director._arcs = [])).push({ kind: 'accused', b: victimId, accuser: accuserId ?? null, stage: 1, nextAt: sim.time + 30 });
    return planted > 0;
  } catch { return false; }
}

// STAR-CROSS — aim Star-Crossed at a chosen pair: set mutual _courtingId, warm the pair, ensure a
// feud between their houses (seed one if absent), open the romance arc + push a PRE-TARGETED Director
// 'romance' arc. The §8 romance deriver (when built) then ENACTS the courtship the arc narrates.
export function starCross(sim: Sim, aId: unknown, bId: unknown): boolean {
  try {
    const a = sim.agentsById.get(aId), b = sim.agentsById.get(bId);
    if (!a || !b) return false;
    a._courtingId = b.id; b._courtingId = a.id;
    sour(a, b, 0.6); sour(b, a, 0.6);                 // they are drawn to each other (warm both ways)
    if (a.house && b.house && a.house !== b.house) { try { setHouseFeud(sim, a.house, b.house); } catch { /* best-effort */ } }
    if (sim.sagas) sim.sagas.openArc({ kind: 'romance', key: arcKey('romance', aId as string, bId as string), principals: [aId, bId] });
    (sim.director._arcs || (sim.director._arcs = [])).push({ kind: 'romance', a: aId, b: bId, hA: a.house, hB: b.house, stage: 1, nextAt: sim.time + 30 });
    return true;
  } catch { return false; }
}

// CAPTURE TARGET — stage a rescue: set the captive's bridge state (_held/_captorId) so a rescuer's
// perception bridges b.captive, and open the rescue arc (keyed on the victim). The §7 rescue resolves it.
export function captureTarget(sim: Sim, captiveId: unknown, captorId: unknown): boolean {
  try {
    const captive = sim.agentsById.get(captiveId); if (!captive) return false;
    captive._held = true; captive._captorId = captorId;
    if (sim.sagas) sim.sagas.openArc({ kind: 'rescue', key: 'rescue:' + captiveId, principals: [captorId, captiveId] });
    return true;
  } catch { return false; }
}
