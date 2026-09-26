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
//   bun test/playtest.mjs probe <quest> <stageIndex> <atoms.json> [seed]
//        reads a list of { strategy, capability, text, expect[] } against that situation, prints
//        each verdict, and folds them into the queue.

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
  const [q, si, file, seed = '7'] = args;
  const atoms = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { s, b, u, stage } = stageAtPlayerTurn(q, +si, +seed);
  const res = probe(b, u, atoms);
  for (const r of res) console.log(`${r.status.padEnd(11)} ${r.atom.capability.padEnd(22)} “${r.atom.text}” ${r.got ? `→ ${r.got}` : r.reason ? `— ${r.reason}` : ''}`);
  const qq = loadQ(); qq.fold(res, stage.name); saveQ(qq);
  s.dispose();
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
