// PLAYTEST → SUPPORT QUEUE. Not a gate: a design tool.
//
//   bun test/playtest.mjs auto [seeds=2]
//        plays the three-quest sequence headless; at your first turns in every stage battle the
//        template playtester tries its strategies (atomised into write-ins) and records what the
//        rules couldn't do. Folds into playtest/support-queue.json and regenerates SUPPORT_QUEUE.md.
//
//   bun test/playtest.mjs situation <quest> <stageIndex> [seed]
//        prints the battle situation at your first turn (units, props, heights, action kinds) —
//        what a model playtester reads to invent strategies.
//
//   bun test/playtest.mjs probe <quest> <stageIndex> <atoms.json> [seed] [--no-fold]
//        reads a list of { strategy, capability, text, expect[] } (or a plan file { plan, atoms })
//        against that situation, prints each verdict, and folds them into the queue unless --no-fold
//        (parallel playtesters use --no-fold; one fold-atoms pass writes the queue).
//
//   bun test/playtest.mjs situations
//        writes playtest/situations/<quest>-<stage>.json for every stage (seed 7).
//
//   bun test/playtest.mjs fold-atoms
//        probes every file in playtest/atoms (named <anything>-<quest>-<stage>.json), folds all
//        results into the queue once, and scores each PLAN: how many of its steps the game can do.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSeed } from '../js/sim/rng.js';
import { stubScene, makeFighter } from './harness.mjs';
import { createSession } from '../js/app/session.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { RunController, memoryStore } from '../js/app/run/run.js';
import { plan, playerTurn } from '../js/app/run/autopilot.js';
import { runTurn } from '../js/app/tactics/ai.js';
import { probe, situation, templateAtoms } from '../js/app/tactics/playtest.js';
import { SupportQueue } from '../js/app/tactics/supportQueue.js';
import { QUEST_ORDER, QUESTS } from '../js/app/run/quests.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'playtest');
const QFILE = path.join(DIR, 'support-queue.json');
const MD = path.join(DIR, 'SUPPORT_QUEUE.md');
const loadQ = () => new SupportQueue(fs.existsSync(QFILE) ? JSON.parse(fs.readFileSync(QFILE, 'utf8')) : null);
const saveQ = (q) => { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(QFILE, JSON.stringify(q.data, null, 1)); fs.writeFileSync(MD, q.toMarkdown()); };

/** Build a stage battle and advance NPC turns until the player's first turn. */
function stageAtPlayerTurn(questId, stageIdx, seed) {
  setSeed(seed);
  const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 1, player: { fighter: new HeadlessFighter('knight', { isPlayer: true }) } });
  const rc = new RunController(s, memoryStore());
  rc.setupHub();
  const { party, disposition } = plan(0, rc);
  rc.startRun(questId, party, disposition);
  rc.stageIdx = stageIdx;
  const b = rc.beginStage(); b.start();
  let g = 0; while (!b.outcome && b.current() && !b.playerControls(b.current()) && g++ < 50) runTurn(b, b.current());
  return { s, rc, b, u: b.current(), stage: QUESTS[questId].stages[stageIdx] };
}

const [mode, ...args] = process.argv.slice(2);

if (mode === 'situation') {
  const [q, si, seed = '7'] = args;
  const { s, b, u, stage } = stageAtPlayerTurn(q, +si, +seed);
  console.log(JSON.stringify(situation(b, u, stage.name, stage.objectiveText), null, 1));
  s.dispose();
} else if (mode === 'probe') {
  const [q, si, file, seed = '7'] = args.filter((a) => !a.startsWith('--'));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const atoms = Array.isArray(raw) ? raw : Array.isArray(raw.plans) ? raw.plans.flatMap((p) => p.atoms || []) : raw.atoms;
  const { s, b, u, stage } = stageAtPlayerTurn(q, +si, +seed);
  const res = probe(b, u, atoms);
  for (const r of res) console.log(`${r.status.padEnd(11)} ${r.atom.capability.padEnd(22)} “${r.atom.text}” ${r.got ? `→ ${r.got}` : r.reason ? `— ${r.reason}` : ''}`);
  if (!args.includes('--no-fold')) { const qq = loadQ(); qq.fold(res, stage.name); saveQ(qq); }
  s.dispose();
} else if (mode === 'situations') {
  const out = path.join(DIR, 'situations'); fs.mkdirSync(out, { recursive: true });
  for (const qid of QUEST_ORDER) for (let si = 0; si < QUESTS[qid].stages.length; si++) {
    const { s, b, u, stage } = stageAtPlayerTurn(qid, si, 7);
    const sit = situation(b, u, stage.name, stage.objectiveText);
    fs.writeFileSync(path.join(out, `${qid}-${si}.json`), JSON.stringify({ quest: qid, stage: si, intro: stage.intro, ...sit }, null, 1));
    s.dispose();
  }
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
} else if (mode === 'fold-atoms') {
  const dir = path.join(DIR, 'atoms');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const all = []; const plans = [];
  for (const f of files) {
    const m = /(blackthorn|reliquary|wolves)-(\d)\.json$/.exec(f); if (!m) continue;
    let raw; try { raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { console.log(`skip ${f}: bad JSON`); continue; }
    const list = Array.isArray(raw) ? [{ atoms: raw }] : Array.isArray(raw.plans) ? raw.plans : [raw];
    const { s, b, u, stage } = stageAtPlayerTurn(m[1], +m[2], 7);
    for (const pl of list) {
      const atoms = (pl.atoms || []).filter((a) => a && typeof a.text === 'string' && Array.isArray(a.expect));
      const res = probe(b, u, atoms.map((a) => ({ strategy: a.strategy || pl.goal || 'plan', capability: a.capability || 'unlabelled', text: a.text, expect: a.expect })));
      for (const r of res) all.push({ r, stage: stage.name });
      const judged = res.filter((r) => r.status !== 'unreachable');
      plans.push({ file: f, persona: raw.persona || pl.persona || '', goal: pl.goal || '', steps: res.length, ok: judged.filter((r) => r.status === 'supported').length, judged: judged.length,
        broken: res.filter((r) => r.status === 'unsupported' || r.status === 'misread').map((r) => `${r.status === 'misread' ? 'MISREAD' : 'MISSING'} ${r.atom.capability}: “${r.atom.text}”${r.got ? ` → ${r.got}` : ''}`) });
    }
    s.dispose();
  }
  const q = loadQ(); q.fold(all.map((x) => x.r), 'plans'); saveQ(q);
  const tally = { supported: 0, misread: 0, unsupported: 0, unreachable: 0 };
  for (const { r } of all) tally[r.status]++;
  const whole = plans.filter((pl) => pl.judged && pl.ok === pl.judged).length;
  console.log(`${plans.length} plans, ${all.length} steps: ${JSON.stringify(tally)}. Plans fully executable: ${whole}/${plans.length}`);
  fs.writeFileSync(path.join(DIR, 'PLANS.md'), ['# Playtest plans — can the game execute them?', '',
    '> Generated by `bun test/playtest.mjs fold-atoms`. Each plan is a high-level approach to one stage, atomised into write-ins.',
    '> A plan is only as good as its weakest step: MISSING = no reading; MISREAD = the parser did something else.', '',
    ...plans.map((pl) => `- **${pl.file}** ${pl.persona ? `(${pl.persona}) ` : ''}— ${pl.goal || 'plan'} — ${pl.ok}/${pl.judged} steps executable${pl.broken.length ? '\n' + pl.broken.map((x) => `  - ${x}`).join('\n') : ''}`)].join('\n'));
  console.log('wrote playtest/PLANS.md and the queue');
} else {
  const seeds = +(args[0] || 2);
  const all = [];
  for (let seed = 1; seed <= seeds; seed++) {
    for (let qi = 0; qi < QUEST_ORDER.length; qi++) {
      const quest = QUESTS[QUEST_ORDER[qi]];
      for (let si = 0; si < quest.stages.length; si++) {
        const { s, b, u, stage } = stageAtPlayerTurn(quest.id, si, seed * 131 + qi * 17 + si);
        // probe at the first two player turns (the field changes as the fight develops)
        let probes = 0, guard = 0;
        while (!b.outcome && guard++ < 400) {
          const cur = b.current(); if (!cur) break;
          if (cur.role === 'player' && probes < 2) { for (const r of probe(b, cur, templateAtoms(b, cur))) all.push({ r, stage: stage.name }); probes++; }
          if (b.playerControls(cur)) playerTurn(b, cur); else runTurn(b, cur);
          if (probes >= 2) break;
        }
        s.dispose();
      }
    }
  }
  const q = loadQ();
  const byStage = new Map();
  for (const { r, stage } of all) (byStage.get(stage) ?? byStage.set(stage, []).get(stage)).push(r);
  // one fold for the whole session, so an item's status reflects every context it was tried in
  q.fold(all.map((x) => x.r), 'playtest');
  for (const it of Object.values(q.data.items)) for (const ex of it.examples) if (ex.stage === 'playtest') ex.stage = all.find((x) => x.r.atom.text === ex.text)?.stage ?? ex.stage;
  saveQ(q);
  const tally = { supported: 0, misread: 0, unsupported: 0, unreachable: 0 };
  for (const { r } of all) tally[r.status]++;
  console.log(`probed ${all.length} atoms across ${byStage.size} stages:`, JSON.stringify(tally));
  console.log('top of the queue:');
  for (const [i, it] of q.ranked().slice(0, 15).entries()) console.log(`  ${String(i + 1).padStart(2)}. ${it.capability.padEnd(20)} ${it.kind.padEnd(11)} demand ${String(it.demand).padStart(3)}  e.g. “${it.examples[0]?.text}” → ${it.examples[0]?.outcome}`);
  console.log(`wrote ${path.relative(process.cwd(), MD)}`);
}
