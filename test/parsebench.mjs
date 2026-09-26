// PARSE BENCHMARK — regex interpreter vs the model interpreter, on the playtesters' phrasings.
//
//   bun test/parsebench.mjs [--llm http://localhost:8001/v1/chat/completions] [--model LiquidAI/LFM2.5-350M] [--seed 7]
//
// Corpus: every atom in playtest/atoms/*.json (model-playtester phrasings, per stage) plus the
// template playtester's atoms for the same stages. Each is judged on the TOP reading against the
// atom's expected action kinds (tactics/playtest.judge): supported / misread / unsupported /
// situational. The model path also reports what it called "unsupported" (its own gap names) and
// latency. Without a reachable endpoint it benchmarks the regex interpreter alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSeed } from '../js/sim/rng.js';
import { stubScene, makeFighter } from './harness.mjs';
import { createSession } from '../js/app/session.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { RunController, memoryStore } from '../js/app/run/run.js';
import { plan } from '../js/app/run/autopilot.js';
import { runTurn } from '../js/app/tactics/ai.js';
import { judge, templateAtoms } from '../js/app/tactics/playtest.js';
import { explainUnmet } from '../js/app/tactics/unmet.js';
import { readWriteIn, addressee, resolveIntents, splitConditional, readTrigger, readyReadings, norm } from '../js/app/tactics/writein.js';
import { interpretLLM } from '../js/app/tactics/llmParse.js';
import { QUESTS } from '../js/app/run/quests.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ENDPOINT = arg('--llm', 'http://localhost:8001/v1/chat/completions');
const MODEL = arg('--model', 'LiquidAI/LFM2.5-350M');
const SEED = +arg('--seed', '7');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATOMS = path.join(HERE, '..', 'playtest', 'atoms');

function stage(questId, si) {
  setSeed(SEED);
  const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 1, player: { fighter: new HeadlessFighter('knight', { isPlayer: true }) } });
  const rc = new RunController(s, memoryStore());
  rc.setupHub();
  const { party, disposition } = plan(0, rc);
  rc.startRun(questId, party, disposition);
  rc.stageIdx = si;
  const b = rc.beginStage(); b.start();
  let g = 0; while (!b.outcome && b.current() && !b.playerControls(b.current()) && g++ < 50) runTurn(b, b.current());
  return { s, b, u: b.current() };
}

async function llmReadings(b, u, text) {
  const cfg = { endpoint: ENDPOINT, model: MODEL, timeoutMs: 8000 };
  const cond = splitConditional(text);
  if (cond) {
    const trig = readTrigger(b, u, norm(cond.when));
    const r = trig ? await interpretLLM(b, u, cond.then, cfg) : null;
    return r ? { rs: readyReadings(b, u, trig, cond.then, r.intents, true), unsupported: r.unsupported } : null;
  }
  const r = await interpretLLM(b, u, text, cfg);
  return r ? { rs: resolveIntents(b, u, r.intents, true), unsupported: r.unsupported } : null;
}

// is the endpoint up?
let llmUp = false;
try { const r = await fetch(ENDPOINT.replace(/\/chat\/completions$/, '/models'), { signal: AbortSignal.timeout(2500) }); llmUp = r.ok; } catch { /* down */ }
console.log(llmUp ? `model endpoint: ${ENDPOINT} (${MODEL})` : `model endpoint unreachable (${ENDPOINT}) — benchmarking the regex interpreter only`);

const files = fs.existsSync(ATOMS) ? fs.readdirSync(ATOMS).filter((f) => f.endsWith('.json')) : [];
const tally = { regex: {}, llm: {} };
const bump = (t, k) => { t[k] = (t[k] || 0) + 1; };
const diffs = [], gaps = [], times = [];
for (const [qi, quest] of Object.values(QUESTS).entries()) {
  for (let si = 0; si < quest.stages.length; si++) {
    const { s, b, u } = stage(quest.id, si);
    if (!u) { s.dispose(); continue; }
    // every atom file for this stage: `<quest>-<stage>.json` and persona plans `<who>-<quest>-<stage>.json`
    const fileAtoms = files.filter((x) => x === `${quest.id}-${si}.json` || x.endsWith(`-${quest.id}-${si}.json`)).flatMap((f) => {
      let raw; try { raw = JSON.parse(fs.readFileSync(path.join(ATOMS, f), 'utf8')); } catch { return []; }
      const plans = Array.isArray(raw) ? [{ atoms: raw }] : Array.isArray(raw.plans) ? raw.plans : [raw];
      return plans.flatMap((p) => (p.atoms || []).filter((a) => a && typeof a.text === 'string' && Array.isArray(a.expect)).map((a) => ({ capability: 'unlabelled', ...a })));
    });
    const atoms = [...fileAtoms, ...templateAtoms(b, u)];
    for (const atom of atoms) {
      const who = addressee(b, u, atom.text).who ?? u;
      const rj = judge(atom, readWriteIn(b, who, atom.text), () => explainUnmet(b, who, atom.text), b, who);
      bump(tally.regex, rj.status);
      if (!llmUp) continue;
      const t0 = performance.now();
      const lr = await llmReadings(b, who, addressee(b, u, atom.text).text);
      times.push(performance.now() - t0);
      let lj;
      if (!lr) lj = { status: 'error', got: 'no answer' };
      else if (lr.unsupported) { lj = { status: 'unsupported', got: `unsupported: ${lr.unsupported}` }; gaps.push(`${atom.capability}: “${atom.text}” → ${lr.unsupported}`); }
      else lj = judge(atom, lr.rs, () => 'model reading not legal here', b, who);
      bump(tally.llm, lj.status);
      if (lj.status !== rj.status) diffs.push(`${quest.id}-${si} ${atom.capability.padEnd(18)} regex:${rj.status.padEnd(11)} model:${lj.status.padEnd(11)} “${atom.text}” ${lj.got ? `→ ${lj.got}` : ''}`);
    }
    s.dispose();
  }
}
const rate = (t) => { const n = Object.values(t).reduce((a, x) => a + x, 0); const judged = n - (t.unreachable || 0); return n ? `${n} atoms · supported ${t.supported || 0} (${Math.round(100 * (t.supported || 0) / Math.max(1, judged))}% of judged) · misread ${t.misread || 0} · unsupported ${t.unsupported || 0} · situational ${t.unreachable || 0}${t.error ? ` · errors ${t.error}` : ''}` : '—'; };
console.log(`regex: ${rate(tally.regex)}`);
if (llmUp) {
  console.log(`model: ${rate(tally.llm)}`);
  times.sort((a, c) => a - c);
  console.log(`model latency: median ${Math.round(times[times.length >> 1])} ms, p90 ${Math.round(times[Math.floor(times.length * 0.9)])} ms`);
  console.log(`\nwhere they disagree (${diffs.length}):`);
  for (const d of diffs.slice(0, 40)) console.log('  ' + d);
  console.log(`\ngaps the model named (${gaps.length}):`);
  for (const g of gaps.slice(0, 25)) console.log('  ' + g);
}
