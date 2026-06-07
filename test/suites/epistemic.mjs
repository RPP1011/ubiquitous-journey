// EPISTEMIC SCAN — the static build-time gate for THE INVARIANT: an agent never
// reads the true/ground-truth world from its COGNITION/EXECUTION code. It perceives,
// forms BELIEFS, and all decision + execution run off those beliefs + its own state.
// Reality is touched in exactly two sanctioned, ALLOWLISTED places: perception (truth
// → belief) and the combat resolver (a blade landing geometrically). Everything else —
// decide / act / movement / occupation / trade / motivation / planner / the agent.js
// decision helpers — must touch ONLY the agent's own state (a.*), its own BeliefStore
// (a.beliefs), and shared STATIC geography (world POIs / landmarks).
//
// This suite is a STATIC SOURCE SCAN (no sim run): it reads each cognition/execution
// source file as text, strips comments + strings (so explanatory prose mentioning the
// banned handles doesn't false-positive), and fails on forbidden truth-access. It is the
// BELT; the restricted cognition ctx (no agents/agentsById/player handle reaches
// decide()/act()) is the SUSPENDERS — and this suite asserts that too (the structural
// check on simulation.js's cognition-ctx literal).
//
// Wired into headless.mjs FIRST so the gate fails fast. Folds into the shared ok tally.
//
//   epistemicScan(ok)            — run the scan + structural assertions.
// REPORT-ONLY MODE: set REPORT_ONLY true to LOG matches without failing the gate (used
// while migrating; flipped to false once cognition is clean).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');           // repo root (test/suites -> ../../)

// REPORT-ONLY while the cognition layer is still being migrated off ground truth.
// Flipped to false in the final step so a forbidden read FAILS the build.
const REPORT_ONLY = false;

// Cognition / execution files that MUST be clean (no ground-truth roster reads).
const SCANNED = [
  'js/sim/agent/decide.js',
  'js/sim/agent/act.js',
  'js/sim/agent/steer.js',    // Phase 2b — the steering substrate (potential-field locomotion + fills)
  'js/sim/agent/movement.js',
  'js/sim/agent/occupation.js',
  'js/sim/agent/trade.js',
  'js/sim/motivation.js',
  'js/sim/planner.js',
  'js/sim/agent.js',          // the decision helpers (with EPISTEMIC-OK carve-outs)
  'js/sim/mentalmap.js',      // the shared STATIC places registry (static-geography only)
  // Phase 2a — the InteractionSchema reasoning layer: pure IR + the belief/own-state/map
  // evaluators + the bounded interpreter. Cognition: reads ONLY agent.*, the agent's own
  // BeliefStore, episodic memory, and the static mental map — never the roster.
  'js/sim/schemas/ir.js',
  'js/sim/schemas/vocab.js',
  'js/sim/schemas/interpreter.js',
  'js/sim/schemas/catalogue.js',
];

// ALLOWLISTED bridge/resolver/orchestration files — the two sanctioned reality-touch
// points (perception, combat) + the orchestration that wires them. NOT scanned.
//   js/sim/agent/perception.js, js/combat.js, js/sim/combatEvents.js, js/sim/simulation.js

// Forbidden HANDLE patterns: a roster scan / lookup / live player handle in cognition.
// (ctx.playerId — a primitive id — is ALLOWED; the regex requires `player` NOT followed
// by `Id`.) Banning these handles transitively bans foreign true-derefs (they are only
// reachable THROUGH the roster).
const FORBIDDEN_HANDLES = [
  { re: /\bctx\.agents\b/, why: 'roster scan (ctx.agents)' },
  { re: /\bctx\.agentsById\b/, why: 'roster lookup (ctx.agentsById)' },
  { re: /\bctx\.player\b(?!Id)/, why: 'live player handle (ctx.player) — use ctx.playerId scalar' },
  { re: /\bsim\.agents(?:ById)?\b/, why: 'roster via sim handle (sim.agents/agentsById)' },
  // DEBT #2 RETIRED (Phase 2a): `ctx.buildSites` is a DYNAMIC build-state handle. Cognition
  // must reach build/comfort state via BELIEFS (homeBelief) or the STATIC map (shelter/rest
  // Places); EXECUTION (buildStep) reaches it via the resolver facade (ctx.resolver.buildSite).
  // Banning the handle outright makes the retirement structural — buildStep names it nowhere.
  { re: /\bctx\.buildSites\b/, why: 'dynamic build state on cognition ctx — use beliefs/map (comfort) or the execution resolver (build)' },
];

// SECONDARY belt: a foreign TRUE-STATE deref off a local conventionally named for a
// resolved other-entity. We can't prove foreignness in a text scan, so we flag the
// TRUE-ONLY fields (.alive/.faction/.inventory/.gold/.notoriety/.priceBeliefs/.needs)
// off the identifiers the codebase uses for "another agent". NOTE: `.pos` is deliberately
// NOT in this set — a belief REFERENCE (_nearestHostile's { id, pos:lastPos, ... }) and
// a resolver SNAPSHOT both legitimately carry a `.pos`, and a FOREIGN agent's true `.pos`
// is only reachable through the roster handles (banned outright above), so banning the
// handles transitively bans the foreign-pos read without false-positiving belief refs.
// An explicit `// EPISTEMIC-OK:` marker on a line still skips this belt (self-documenting).
const FOREIGN_DEREF = /\b(?:o|foe|target|leader|cp|to|victor|charge|culprit|subj|ben|realTarget|_real|enemy|threat)\.(?:alive|faction|inventory|gold|notoriety|priceBeliefs|needs)\b/;

// --- comment / string stripper (state machine; guarded — never throws) ---------------
// Replaces // line comments, /* */ blocks, and '...' / "..." / `...` strings with spaces
// (preserving newlines + length so line numbers + columns are unchanged), so prose that
// mentions a banned handle can't false-positive. Conservative: on any anomaly it leaves
// text as-is for that span (the scan still runs).
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';   // code | line | block | sq | dq | bt
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i++; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i++; continue; }
      if (c === '`') { state = 'bt'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += c === '\t' ? '\t' : ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : (c === '\t' ? '\t' : ' '); i++; continue;
    }
    // string states: handle escapes; preserve newlines/length
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += ' '; i++; continue; }
    out += c === '\n' ? '\n' : (c === '\t' ? '\t' : ' '); i++; continue;
  }
  return out;
}

export function epistemicScan(ok) {
  let violations = 0;
  let scanError = false;

  for (const rel of SCANNED) {
    let raw;
    try {
      raw = readFileSync(join(ROOT, rel), 'utf8');
    } catch (e) {
      ok(false, `epistemic: could not read ${rel} (${e && e.message})`);
      scanError = true;
      continue;
    }
    const stripped = stripCommentsAndStrings(raw);
    const lines = stripped.split('\n');
    const rawLines = raw.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const rawLine = rawLines[li] || '';
      // an explicit, self-documenting carve-out skips the foreign-deref belt on THIS line.
      const allowed = /\/\/\s*EPISTEMIC-OK:/.test(rawLine);
      for (const h of FORBIDDEN_HANDLES) {
        if (h.re.test(line)) {
          violations++;
          console.log(`  [epistemic] ${rel}:${li + 1}: ${h.why} :: ${rawLine.trim()}`);
        }
      }
      if (!allowed && FOREIGN_DEREF.test(line)) {
        violations++;
        console.log(`  [epistemic] ${rel}:${li + 1}: foreign true-deref (use belief.lastPos / resolver) :: ${rawLine.trim()}`);
      }
    }
  }

  // STRUCTURAL (suspenders): the cognition ctx literal must NOT hand cognition the live
  // roster / player object. We read simulation.js and assert the `_cognitionCtx()` builder's
  // returned object literal contains no `agents:` / `agentsById:` key and no `player:` key
  // (the scalar `playerId:` IS allowed — the regex requires `player` NOT followed by `Id`).
  let structOk = false;
  try {
    const simSrc = readFileSync(join(ROOT, 'js/sim/simulation.js'), 'utf8');
    // capture from `_cognitionCtx() {` up to the `return { ... }` object literal's close.
    const m = simSrc.match(/_cognitionCtx\s*\(\s*\)\s*\{[\s\S]*?return\s*\{([\s\S]*?)\};/);
    if (m) {
      const body = m[1];   // the returned-object fields only
      const hasRoster = /\bagents(?:ById)?\s*:/.test(body);
      const hasPlayerObj = /\bplayer\b(?!Id)\s*:/.test(body);
      // DEBT #2 RETIRED (Phase 2a): assert `buildSites:` is ABSENT from the cognition ctx
      // literal (the dynamic build-state handle was removed; build goes via the resolver).
      const hasBuildSites = /\bbuildSites\s*:/.test(body);
      structOk = !hasRoster && !hasPlayerObj && !hasBuildSites;
      if (!structOk) console.log('  [epistemic] simulation.js _cognitionCtx still hands cognition a roster/player/buildSites handle');
    } else {
      console.log('  [epistemic] simulation.js has no _cognitionCtx() return literal — cognition ctx not split');
    }
  } catch (e) {
    ok(false, `epistemic: could not read simulation.js (${e && e.message})`);
    scanError = true;
  }

  if (REPORT_ONLY) {
    ok(true, `epistemic: scan ran (REPORT-ONLY) — ${violations} forbidden-access match(es) logged, struct ${structOk ? 'ok' : 'PENDING'}`);
    return;
  }
  ok(!scanError, 'epistemic: all cognition source files were readable');
  ok(violations === 0, `epistemic: cognition/execution source is free of ground-truth access (${violations} violation(s))`);
  ok(structOk, 'epistemic: cognition ctx hands NO live roster/player handle (structural)');
}
