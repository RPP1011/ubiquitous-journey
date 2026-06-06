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

const rand = (a, b) => a + Math.random() * (b - a);
const groundY = (x, z) => { try { return typeof document === 'undefined' ? 0 : terrainHeight(x, z); } catch { return 0; } };

// entry point — run all enabled seeds. Guarded per-seed so one bad seed can't
// abort the others (or the world build).
export function seedNarratives(sim) {
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
function seedRivalApprentices(sim, cfg, idx) {
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
function makeTownsperson(sim, x, z, pers = {}) {
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
function seedProfile(agent, tags) {
  const bp = agent.progression && agent.progression.behavior_profile;
  if (!bp || !tags) return;
  for (const tag in tags) bp[tag] = (bp[tag] || 0) + tags[tag];
}

// grant a specific TEMPLATE class at a seeded level (a veteran). Reuses the
// progression internals (same module ecosystem) and recomputes the cached total.
function grantSeededClass(agent, key, name, level) {
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
function armFromCatalog(agent, abilityId) {
  try {
    const spec = abilityId && ABILITY_CATALOG[abilityId];
    if (!spec || !spec.id) return;
    if (agent.progression) { agent.progression.abilities.set(spec.id, spec); agent.progression.cooldowns.set(spec.id, 0); }
    agent.grantAbility(spec);
  } catch { /* arming is best-effort */ }
}

// push observer A's belief-standing toward B down (a grievance / rivalry seed).
function sour(A, B, amount) {
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
function bond(a, withId, rel) {
  try { if (a && a.memory) a.memory.record({ t: 0, kind: 'bond', withId, rel, valence: rel === 'mentor' || rel === 'apprentice' ? 0.6 : 1, salience: 0.6 }); } catch { /* */ }
}
