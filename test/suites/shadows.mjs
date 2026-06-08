// STALE-SHADOW GATE (TS port) — assert no `<name>.ts` coexists with `<name>.js` in the
// SAME directory anywhere under js/**. Such a pair is a green-gate-against-dead-code trap:
// Bun resolves an explicit `'./x.js'` specifier to the literal `x.js` (running the STALE
// code in tests) while tsc/browser pick `x.ts` — the gate would pass code that never ships.
// `git mv x.js x.ts` removes the old file; this guard makes a forgotten leftover a RED gate.
//
//   shadowGuard(ok)   — cheap readdir walk, no sim run.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');     // repo root (test/suites -> ../../)

function walk(dir, offenders) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  const byBase = new Map();   // base name (no ext) -> Set of extensions seen here
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { walk(full, offenders); continue; }
    const m = /^(.*)\.(ts|js)$/.exec(e.name);
    if (!m) continue;
    const base = m[1];
    if (!byBase.has(base)) byBase.set(base, new Set());
    byBase.get(base).add(m[2]);
  }
  for (const [base, exts] of byBase) {
    if (exts.has('ts') && exts.has('js')) offenders.push(join(dir, base) + '.{ts,js}');
  }
}

export function shadowGuard(ok) {
  const offenders = [];
  walk(join(ROOT, 'js'), offenders);
  if (offenders.length) {
    for (const o of offenders) console.log(`  [shadow] stale .js shadows a .ts: ${o}`);
  }
  ok(offenders.length === 0, `shadows: no .ts/.js coexistence under js/** (${offenders.length} offender(s))`);
}
