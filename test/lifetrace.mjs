// LIFE TRACE — the consolidated standalone life-trace EVAL TOOL. Drive the WHOLE sim headless for
// N sim-seconds and follow ONE chosen agent, then ASSEMBLE its emergent life from the existing
// observer substrate (biography, reasoning trace, signals, arcs, memory, chronicle, obituary) into
// either a raw goal-transition dump (default) or a readable LIFE DIGEST (--digest). Read-only over
// the sim: every read is guarded, nothing here drives a decision (the trace's write-only rule holds).
//
// This is a bun script, NOT part of headless.mjs — it is an eval/inspection harness, not a gate.
//
//   bun test/lifetrace.mjs [--seed <n>] [--duration <simSeconds>] [--agent <name|id|most-eventful>] [--digest]
//
// Flags (all optional; bare positional simSeconds still accepted for back-compat):
//   --seed <n>            drive the seedable rng (js/sim/rng.js) for a reproducible run.
//   --duration <secs>     sim-seconds to run (default 1800 = 30 min sim-time).
//   --agent <sel>         who to follow: an agent NAME, a numeric/string ID, or `most-eventful`
//                         (the agent that was a principal in the most arcs / named in the most
//                         chronicle beats / racked up the most deeds — a lightweight per-agent
//                         eventfulness tally kept across the WHOLE run). Default: a mid-town trader.
//   --digest              assemble the per-agent narrative into a readable LIFE STORY (identity →
//                         drive → reasoning highlights → arcs → memory → deeds/oaths → relationships
//                         → chronicle beats → closure) instead of the raw goal-transition timeline.
//
import { stubScene, makeFighter } from './harness.mjs';
import { World } from '../js/sim/world.js';
import { Simulation } from '../js/sim/simulation.js';
import { resolveCombat } from '../js/combat.js';
import { setSeed } from '../js/sim/rng.js';
import { memoryPhrase } from '../js/sim/memory.js';
import { traceLabel, STAGE } from '../js/sim/trace.js';
import { agentBiography, agentDrive } from '../js/sim/biography.js';
import { buildObituary, obituaryWorthy } from '../js/sim/gazette.js';
import {
  deedLedger, oaths, perilsSurvived, goldTrend, standingTrend, fortuneReversals,
  arcLoad, regardGap, dependence, esteemTruthGap, snubsFelt, quietIndex,
} from '../js/sim/signals.js';
import { runHealthChecks, runCohort } from './health.mjs';

// ---- CLI parsing: --flag <value> pairs, plus a bare positional simSeconds (back-compat) ----------
function parseArgs(argv) {
  const out = { seed: undefined, duration: 1800, agent: undefined, digest: false, health: false, cohort: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--digest') out.digest = true;
    else if (t === '--health-checks') out.health = true;
    else if (t === '--cohort') out.cohort = Math.max(1, Number(argv[++i]) | 0 || 8);
    else if (t === '--seed') out.seed = Number(argv[++i]);
    else if (t === '--duration') out.duration = Number(argv[++i]);
    else if (t === '--agent') out.agent = argv[++i];
    else if (t === '--help' || t === '-h') out.help = true;
    else rest.push(t);
  }
  if (rest.length && Number.isFinite(Number(rest[0]))) out.duration = Number(rest[0]);   // back-compat positional
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log('usage: bun test/lifetrace.mjs [--seed <n>] [--duration <simSeconds>] [--agent <name|id|most-eventful>] [--digest] [--health-checks] [--cohort <N>]');
  process.exit(0);
}
const SIM_SECONDS = Number.isFinite(ARGS.duration) ? ARGS.duration : 1800;
const dt = 1 / 60;

// ---- build the world (seed BEFORE World construction so world-gen placement draws are seeded) ----
if (ARGS.seed !== undefined && Number.isFinite(ARGS.seed)) setSeed(ARGS.seed);
const world = new World(stubScene);
const sim = new Simulation(stubScene, world, { makeFighter, seed: ARGS.seed });
sim.spawn();
const pf = makeFighter('knight', { isPlayer: true });
pf.root.position.set(0, 0, 8);
sim.addPlayer(pf);
// let Progression's lazy ability imports settle (same as the soak / seedrepro warm-up).
await Promise.all([
  import('../js/rpg/abilities/catalog.js').catch(() => {}),
  import('../js/rpg/abilities/generate.js').catch(() => {}),
  import('../js/rpg/abilities/ir.js').catch(() => {}),
]);
for (let k = 0; k < 5; k++) await Promise.resolve();

const nameOf = (id) => { const x = sim.agentsById.get(id); return (x && x.name) || `#${id}`; };
const goldTotal = () => sim.agents.reduce((s, a) => s + (a.gold || 0) + (a.stash || 0), 0);
const gold0 = goldTotal();

// ---- eventfulness tally: a per-agent score so `--agent most-eventful` can pick the lived-in soul.
// Folded across the WHOLE run (the _closed ring is small + churns): +arcs as a principal, +chronicle
// beats naming them, +deeds. A lightweight Map<id, {arcs, beats, deeds}> — no roster scan on the tick.
const eventfulness = new Map();   // id -> { arcs, beats, deeds }
const bumpEvent = (id, key, n = 1) => {
  if (id == null) return;
  const e = eventfulness.get(id) || { arcs: 0, beats: 0, deeds: 0 };
  e[key] += n; eventfulness.set(id, e);
};

// TOWN-WIDE narrative production (the keystone "are stories being produced" metric) + per-agent arcs.
const arcsSeen = new Set();
const arcTally = {};
const beatsSeen = new Set();    // chronicle beat ids already credited to the eventfulness tally

const t0 = Date.now();
let frame = 0;
while (sim.time < SIM_SECONDS) {
  sim.update(dt);
  for (const f of sim.fighters) f.update(dt);
  const ev = resolveCombat(sim.fighters, sim.isHostile.bind(sim), sim._ctx());
  if (ev.length) sim.onCombatEvents(ev);
  frame++;

  // sweep the closed-arc ring for arcs not yet tallied (before they age out of the cap ring).
  for (const arc of sim.sagas._closed) {
    if (arcsSeen.has(arc.arcId)) continue;
    arcsSeen.add(arc.arcId);
    arcTally[`${arc.kind}:${arc.outcome}`] = (arcTally[`${arc.kind}:${arc.outcome}`] || 0) + 1;
    if (Array.isArray(arc.principals)) for (const pid of arc.principals) bumpEvent(pid, 'arcs');
  }
  // sweep fresh chronicle beats for naming + deed credit (id-deduped, bounded by the chronicle ring).
  if (frame % 600 === 0) {
    for (const b of sim.chronicle.recent(200) || []) {
      if (beatsSeen.has(b.id) || !b.text) continue;
      beatsSeen.add(b.id);
      for (const a of sim.agents) { if (a.name && b.text.indexOf(a.name) !== -1) bumpEvent(a.id, 'beats'); }
    }
  }
  // progress ping
  if (frame % 18000 === 0) console.log(`  …${sim.time.toFixed(0)}s (wall ${(Date.now() - t0) / 1000 | 0}s, agents=${sim.agents.length})`);
}
const wall = ((Date.now() - t0) / 1000).toFixed(1);

// fold final deed counts into eventfulness (deeds accrue on the agent's _deeds ledger as truth).
for (const a of sim.agents) {
  const d = deedLedger(a); let n = 0; for (const k in d) n += d[k].n;
  if (n) bumpEvent(a.id, 'deeds', n);
}
const eventScore = (id) => { const e = eventfulness.get(id); return e ? e.arcs * 3 + e.beats * 2 + e.deeds : 0; };

// ---- pick the protagonist by --agent (name | id | most-eventful), else a mid-town trader ----------
function pickHero() {
  const sel = ARGS.agent;
  if (sel === 'most-eventful') {
    let best = null, bestScore = -1;
    for (const a of sim.agents) {
      if (a.controlled) continue;
      const s = eventScore(a.id);
      if (s > bestScore) { bestScore = s; best = a; }
    }
    return best;
  }
  if (sel != null) {
    // try exact id, then case-insensitive name (given or display).
    const byId = sim.agentsById.get(sel) || sim.agentsById.get(Number(sel));
    if (byId) return byId;
    const lc = String(sel).toLowerCase();
    const byName = sim.agents.find((a) => (a.name && a.name.toLowerCase() === lc) || (a.given && a.given.toLowerCase() === lc));
    if (byName) return byName;
    const byPartial = sim.agents.find((a) => a.name && a.name.toLowerCase().indexOf(lc) !== -1);
    if (byPartial) return byPartial;
    console.log(`  (no agent matched "${sel}" — falling back to a mid-town trader)`);
  }
  // default: an autonomous townsperson with a trade, near the town core (in the thick of things).
  const withTrade = sim.agents.filter((a) => !a.controlled && a.faction === 'townsfolk' && a.profession);
  const anyTown = sim.agents.filter((a) => !a.controlled && a.faction === 'townsfolk');
  const pool = withTrade.length ? withTrade : anyTown;
  return pool[Math.floor(pool.length / 2)] || sim.agents.find((a) => !a.controlled);
}

const hero = pickHero();
const heroId = hero && hero.id;
const name0 = (hero && hero.name) || `#${heroId}`;

// the hero's arcs (open + closed snapshot at end-of-run), and a death record if it fell.
const heroClosed = sim.sagas._closed.filter((arc) => arc.principals && arc.principals.indexOf(heroId) !== -1);
const heroOpen = [...sim.sagas._open.values()].filter((arc) => arc.principals && arc.principals.indexOf(heroId) !== -1);

console.log(`\n=== TRACED: ${name0} (#${heroId}, ${hero && hero.faction})  ·  seed=${ARGS.seed ?? 'unseeded'}  ·  ${SIM_SECONDS}s in ${wall}s wall ===`);
console.log(`gold conserved: ${gold0.toFixed(0)} -> ${goldTotal().toFixed(0)}   ·   eventScore=${eventScore(heroId)} (arcs/beats/deeds=${JSON.stringify(eventfulness.get(heroId) || {})})\n`);

const a = hero;
const alive = !!(a && a.alive);

// ============================================================================
// --health-checks / --cohort : the BUILD STEP 3 diagnostic MODES (roster-wide, not per-hero). When
// either is set the per-agent biography is skipped — these are the auto-flag / distribution layers
// the tool surfaces for regression gating. Both are observer-layer / truth-side (display only).
// ============================================================================
if (ARGS.health || ARGS.cohort) {
  if (ARGS.health) emitHealthChecks();
  if (ARGS.cohort) emitCohort(ARGS.cohort);
}
// ============================================================================
// --digest : assemble the existing substrate into a readable LIFE STORY.
// ============================================================================
else if (ARGS.digest) {
  emitDigest();
} else {
  emitRawBiography();
}

sim.dispose();

// ---------------------------------------------------------------------------
// ANOMALY HEALTH-CHECKS — print PASS/FLAG per check; each FLAG prints the offending number + threshold.
function emitHealthChecks() {
  console.log(`=============== ANOMALY HEALTH-CHECKS (whole run) ===============`);
  console.log(`  (each check is a RATIO with an absolute-N FLOOR — scale-free, fires only once the world is big enough to mean it)\n`);
  const checks = runHealthChecks(sim);
  let flags = 0;
  for (const c of checks) {
    const tag = c.flagged ? 'FLAG' : (c.floorMet ? 'PASS' : 'pass*');     // pass* = floor not yet met (can't fire)
    if (c.flagged) flags++;
    console.log(`  [${tag}] ${c.name.padEnd(18)} ratio=${c.ratio}  vs ${c.threshold}  ${c.floorMet ? '' : '(floor not met)'}`);
    console.log(`         detail: ${JSON.stringify(c.detail)}`);
    if (c.flagged) console.log(`         WHY: ${c.why}`);
  }
  console.log(`\n  ${flags ? `${flags} CHECK(S) FLAGGED` : 'all checks PASS'} (pass* = absolute-N floor not yet met this run).\n`);
}

// COHORT MODE — print the four roster-wide distribution metrics over the living cohort.
function emitCohort(n) {
  const living = sim.agents.filter((x) => x && x.alive && !x.controlled).length;
  console.log(`=============== COHORT METRICS (N=${n} requested · ${living} living traced) ===============`);
  const metrics = runCohort(sim);
  for (const m of metrics) {
    if (m.shape === 'scalar') {
      console.log(`  ${m.name.padEnd(20)} = ${m.value}   (${JSON.stringify({ ...m, name: undefined, shape: undefined, value: undefined })})`);
    } else {
      console.log(`  ${m.name.padEnd(20)} : ${JSON.stringify({ ...m, name: undefined, shape: undefined })}`);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
function emitDigest() {
  const L = [];
  const push = (s) => L.push(s);
  const subjName = (id) => (id == null ? null : nameOf(id));

  // 1) IDENTITY & VOICE (biography + drive)
  push(`╔══ THE LIFE OF ${name0.toUpperCase()} ══`);
  const bio = agentBiography(a, sim);
  const drive = agentDrive(a, sim);
  push(`  ${name0} was ${bio.length ? bio.join('; ') : 'an unremarkable soul of the town'}.`);
  if (drive) push(`  In their final days they were ${drive}.`);

  // 2) REASONING HIGHLIGHTS (the trace ring — how this mind actually decided)
  const tr = (a.trace && a.trace.recent(12)) || [];
  if (tr.length) {
    push(`\n  ── How they reasoned (latest first) ──`);
    for (const e of tr) {
      const lbl = traceLabel(e);
      if (!lbl) continue;
      push(`    [${(e.t || 0).toFixed(0)}s ${e.stage || STAGE.DECIDE}] ${lbl}`);
    }
  }

  // 3) ARCS — the stories they were IN
  if (heroClosed.length || heroOpen.length) {
    push(`\n  ── The tales they were part of ──`);
    for (const arc of heroClosed)
      push(`    · ${arc.kind} [${arc.outcome}] — ${arc.rounds} round(s), with ${arc.principals.map(subjName).filter(Boolean).join(', ')}`);
    for (const arc of heroOpen)
      push(`    · ${arc.kind} (still unfolding) — ${arc.rounds} round(s), with ${arc.principals.map(subjName).filter(Boolean).join(', ')}`);
  }

  // 4) MEMORY — the defining episodes (the autobiography)
  const eps = a.memory ? [...a.memory.salient(8)] : [];
  if (eps.length) {
    push(`\n  ── What they would never forget ──`);
    for (const e of eps) push(`    [${(e.t || 0).toFixed(0)}s] ${memoryPhrase(e, nameOf)}`);
  }

  // 5) DEEDS & OATHS — the life tally + whether they kept their word
  const deeds = deedLedger(a); const dk = Object.keys(deeds);
  if (dk.length) push(`\n  Deeds: ${dk.map((t) => `${t}×${deeds[t].n}`).join(', ')}.`);
  const o = oaths(a); const ok = Object.keys(o);
  if (ok.length) {
    const words = ok.map((k) => `${k} (${o[k].kept}/${o[k].sworn} kept)`).join(', ');
    push(`  Oaths: ${words}.  Perils survived: ${perilsSurvived(a)}.`);
  }

  // 6) RELATIONSHIPS — the asymmetries that make drama
  const dep = dependence(a);
  const rels = [];
  if (a.rivalId != null) rels.push(`a sworn rival in ${subjName(a.rivalId)}`);
  if (a.mateId != null) rels.push(`wed to ${subjName(a.mateId)}`);
  if (dep.onId != null && dep.share > 0.4) {
    const other = sim.agentsById.get(dep.onId);
    const gap = other ? regardGap(a, other) : 0;
    const colour = gap > 0.2 ? ' (a regard not fully returned)' : gap < -0.2 ? ' (who holds them dearer than they know)' : '';
    rels.push(`their whole heart set on ${subjName(dep.onId)}${colour}`);
  }
  if (rels.length) push(`\n  Bonds: ${rels.join('; ')}.`);

  // 7) DRAMATIC IRONY (observer-only — what the town BELIEVED vs the truth)
  const g = esteemTruthGap(sim, a);
  if (Math.abs(g.standingGap) > 0.25) {
    if (g.standingGap > 0 && g.darkDeeds > 0) push(`  Irony: the town esteemed them despite ${g.darkDeeds} dark deed(s) — a celebrated villain.`);
    else if (g.standingGap < 0 && g.goodDeeds > 0) push(`  Irony: ${g.goodDeeds} good deed(s) went unsung — an unappreciated soul.`);
  }
  const snubs = snubsFelt(a, sim.time);
  if (snubs > 1) push(`  They felt the town's cold shoulder (snubs≈${snubs.toFixed(1)}).`);
  push(`  Last named in the chronicle ${quietIndex(sim, a, sim.time).toFixed(0)}s ago.`);

  // 8) CHRONICLE BEATS that named them (the public record)
  const beats = (sim.chronicle.recent(400) || []).filter((b) => b.text && b.text.includes(name0));
  if (beats.length) {
    push(`\n  ── What the town will remember ──`);
    for (const b of beats.reverse()) push(`    [${(b.t || 0).toFixed(0)}s] ${b.text.replace(/[[\]]/g, '')}`);
  }

  // 9) CLOSURE — the obituary, if they fell (or how they stand if they live)
  push(`\n  ── Closure ──`);
  if (!alive) {
    let slayer = null;
    try { slayer = a.lastAttackerId != null ? sim.agentsById.get(a.lastAttackerId) : null; } catch { /* */ }
    const worthy = obituaryWorthy(a);
    const ob = buildObituary(a, sim, slayer);
    push(`    ${name0} ${ob.cause || 'has died'}.`);
    push(`    The town's regard at the end: ${(ob.regard || 0).toFixed(2)}${ob.hounded ? ' — hounded to the grave by rumour' : ''}.`);
    if (ob.villain) push(`    History will name them a villain.`);
    else if (ob.hero) push(`    History will name them a hero.`);
    else if (!worthy) push(`    They passed largely unremarked.`);
  } else {
    const gt = goldTrend(a), strend = standingTrend(a), rev = fortuneReversals(a);
    push(`    ${name0} yet lives — gold ${Math.round(a.gold || 0)} (trend ${gt.fast.toFixed(0)}/${gt.slow.toFixed(0)}), standing ${strend.fast.toFixed(2)}/${strend.slow.toFixed(2)}, ${rev.count} fortune-reversal(s).`);
    push(`    arcLoad now: ${arcLoad(sim, a)} open tale(s) ride on them.`);
  }
  push(`╚${'═'.repeat(40)}`);

  console.log(L.join('\n'));
  emitTownWide();
}

// ---------------------------------------------------------------------------
function emitRawBiography() {
  console.log(`status: ${a ? (alive ? 'ALIVE' : 'DIED') : 'GONE'}`);
  if (a) {
    const cls = a.progression && a.progression.primaryClass && a.progression.primaryClass();
    const classes = a.progression && a.progression.classes ? [...a.progression.classes.values()].map((c) => `${c.name} L${c.level}`) : [];
    console.log(`\n— IDENTITY —`);
    console.log(`  trade: ${a._trade || '—'}   classes: ${classes.join(', ') || '—'}   totalLevel: ${a.progression ? a.progression.totalLevel : 0}`);
    console.log(`  ambition: ${a.ambition ? a.ambition.label : '—'}   gold: ${Math.round(a.gold || 0)}   kills: ${a.life ? a.life.kills : 0}   house: ${a.house || '—'}`);
    const tr = goldTrend(a);
    console.log(`  goldFast/Slow: ${tr.fast.toFixed(0)}/${tr.slow.toFixed(0)}   perilsSurvived: ${perilsSurvived(a)}`);

    console.log(`\n— DEEDS (deedLedger) —`);
    const deeds = deedLedger(a); const dk = Object.keys(deeds);
    console.log(dk.length ? dk.map((t) => `  ${t}: ${deeds[t].n}  (first ${deeds[t].first.toFixed(0)}s, last ${deeds[t].last.toFixed(0)}s)`).join('\n') : '  (none recorded)');
    console.log(`\n— OATHS (kept vs abandoned) —`);
    const o = oaths(a); const ok2 = Object.keys(o);
    console.log(ok2.length ? ok2.map((k) => `  ${k}: sworn ${o[k].sworn}, kept ${o[k].kept}, abandoned ${o[k].abandoned}`).join('\n') : '  (swore no narrative oaths)');

    console.log(`\n— ARCS (sim.sagas — the stories they were IN) —`);
    if (!heroClosed.length && !heroOpen.length) console.log('  (was not a principal in any tracked arc)');
    for (const arc of heroClosed) console.log(`  CLOSED ${arc.kind} [${arc.outcome}] rounds=${arc.rounds} principals=[${arc.principals.map(nameOf).join(', ')}]`);
    for (const arc of heroOpen) console.log(`  OPEN   ${arc.kind} rounds=${arc.rounds} principals=[${arc.principals.map(nameOf).join(', ')}]`);
    console.log(`  arcLoad now: ${arcLoad(sim, a)}`);

    console.log(`\n— RELATIONSHIPS (its strongest opinions) —`);
    const rels = Array.from(a.beliefs && a.beliefs.all ? a.beliefs.all() : [])
      .filter((b) => b && Math.abs(b.standing || 0) > 0.15)
      .sort((x, y) => Math.abs(y.standing) - Math.abs(x.standing)).slice(0, 8);
    console.log(rels.length ? rels.map((b) => `  ${b.standing > 0 ? '(+)' : '(-)'} ${nameOf(b.subjectId)}: standing ${b.standing.toFixed(2)}${b.hostile ? ' HOSTILE' : ''}`).join('\n') : '  (no strong opinions formed)');

    console.log(`\n— MEMORY (most salient) —`);
    const eps = a.memory ? a.memory.salient(10) : [];
    console.log(eps.length ? eps.map((e) => `  [${(e.t || 0).toFixed(0)}s] ${memoryPhrase(e, nameOf)} (sal ${(e.salience || 0).toFixed(2)})`).join('\n') : '  (remembers nothing formative)');

    console.log(`\n— REASONING TRACE (recent) —`);
    const trc = (a.trace && a.trace.recent(12)) || [];
    console.log(trc.length ? trc.map((e) => `  [${(e.t || 0).toFixed(0)}s ${e.stage || '?'}] ${traceLabel(e)}`).join('\n') : '  (no trace entries — TRACE.enabled off?)');
  }

  console.log(`\n— CHRONICLE BEATS naming ${name0} —`);
  const beats = (sim.chronicle.recent(400) || []).filter((b) => b.text && b.text.includes(name0));
  console.log(beats.length ? beats.reverse().map((b) => `  [${(b.t || 0).toFixed(0)}s] ${b.text}`).join('\n') : '  (the chronicle never named them)');

  emitTownWide();
}

// ---------------------------------------------------------------------------
function emitTownWide() {
  console.log(`\n=============== TOWN-WIDE NARRATIVE PRODUCTION (whole run) ===============`);
  const byFaction = {};
  for (const ag of sim.agents) { if (ag.alive) byFaction[ag.faction] = (byFaction[ag.faction] || 0) + 1; }
  console.log(`  final pop ${sim.agents.length} by faction: ${Object.entries(byFaction).map(([f, n]) => `${f}:${n}`).join('  ')}`);
  console.log(`  total completed arcs: ${arcsSeen.size}`);
  const entries = Object.entries(arcTally).sort((x, y) => y[1] - x[1]);
  console.log(entries.length ? entries.map(([k, n]) => `  ${k}: ${n}`).join('\n') : '  (NO arcs closed all run — the keystone metric is 0)');
  // oaths town-wide health check
  let oathSworn = 0, oathKept = 0, agentsWithOaths = 0;
  for (const ag of sim.agents) {
    const o = ag._oaths; if (!o) continue;
    let any = false;
    for (const k in o) { oathSworn += o[k].sworn; oathKept += o[k].kept; any = true; }
    if (any) agentsWithOaths++;
  }
  console.log(`  oaths town-wide: ${oathSworn} sworn / ${oathKept} kept across ${agentsWithOaths} agents`);
  // most-eventful leaderboard (handy when picking a protagonist)
  const board = [...eventfulness.entries()].map(([id, e]) => [id, e.arcs * 3 + e.beats * 2 + e.deeds, e])
    .filter(([id]) => { const ag = sim.agentsById.get(id); return ag && !ag.controlled; })
    .sort((x, y) => y[1] - x[1]).slice(0, 5);
  console.log(`  most-eventful souls: ${board.map(([id, s]) => `${nameOf(id)}(${s})`).join('  ') || '—'}`);
  console.log('');
}
