// Headless smoke test for the DF ASCII observer's PURE render core (`js/df/view.ts`). Boots the same
// headless sim the page does, runs it, and asserts the grid + panels render real content — so the
// observer is verified without a browser. Run: `bun test/df.mjs`.

import { Simulation } from '../js/sim/simulation.js';
import { World } from '../js/sim/world.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import {
  renderMap,
  agentAt,
  worldToCell,
  cellToWorld,
  mindLines,
  tileLines,
  chronicleLines,
  gazetteLines,
} from '../js/df/view.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};

const stub = { add() {}, remove() {} };
const sim = new Simulation(stub, new World(stub), {
  makeFighter: (model, o) => new HeadlessFighter(model, o),
  seed: 0xdf01,
});
sim.spawn();

// run the town for a while so agents move, trade, and the chronicle fills.
for (let i = 0; i < 400; i++) sim.update(1 / 30);

const alive = sim.agents.filter((a) => a.alive);
ok(alive.length > 10, `town is populated and living (${alive.length} souls)`);

// the grid renders at the requested size and carries agent glyphs (not just terrain).
const vp = { cx: 0, cz: 0, mpp: 14, cols: 80, rows: 40 };
const grid = renderMap(sim, vp);
ok(grid.length === vp.rows && grid[0].length === vp.cols, 'grid is rows×cols');
const glyphs = new Set();
for (const row of grid) for (const cell of row) glyphs.add(cell.ch);
ok([...'tMr@'].some((g) => glyphs.has(g)), 'at least one living agent is drawn on the map');
ok(glyphs.has('$') || glyphs.has('F') || glyphs.has('"'), 'a POI (market/forge/field) is drawn');

// the look-cursor over a real agent resolves it, and its MIND renders.
const a = alive[0];
const center = { cx: a.pos.x, cz: a.pos.z, mpp: 14, cols: 80, rows: 40 };
const cur = worldToCell(center, a.pos.x, a.pos.z);
const w = cellToWorld(center, cur.col, cur.row);
const picked = agentAt(sim, w.x, w.z, 14 * 1.4);
const pickD = picked ? Math.hypot(picked.pos.x - w.x, picked.pos.z - w.z) : Infinity;
ok(picked && pickD <= 14 * 1.4, 'the look-cursor picks the nearest agent under it');
const mind = mindLines(sim, a);
ok(mind.length >= 2 && mind[0].startsWith('@title '), 'the agent mind panel renders (title + body)');
ok(mind.some((l) => l.startsWith('doing:')), "the mind shows what the agent is doing");

// the tile panel renders for empty land (a spot far out in the wilds).
const tile = tileLines(sim, 400, 400, 20);
ok(tile.length >= 2 && tile[0].startsWith('@title '), 'the tile panel renders for open land');

// the side panels surface REAL content after a 400-tick run (not just the fallback message).
const chron = chronicleLines(sim, 16);
ok(chron.length >= 1, 'chronicle panel returns lines');
ok(chron.some((l) => l.startsWith('· ')), 'chronicle shows real world-history beats');
ok(Array.isArray(gazetteLines(sim, 8)) && gazetteLines(sim, 8).length >= 1, 'gazette panel returns lines');

// determinism-ish: the same world+cursor renders the same grid twice (pure render).
const g2 = renderMap(sim, vp);
const same = JSON.stringify(grid) === JSON.stringify(g2);
ok(same, 'renderMap is pure (identical back-to-back for an unchanged world)');

// ── recorded replay: record a fresh run, serialise, load, and render it back ──────────────────
const { Recorder, ReplayPlayer } = await import('../js/df/replay.js');
const rsim = new Simulation(stub, new World(stub), { makeFighter: (m, o) => new HeadlessFighter(m, o), seed: 0xdf01 });
rsim.spawn();
const rec = new Recorder(rsim, { seed: 0xdf01, sampleHz: 2 });
for (let i = 0; i < 600; i++) {
  rsim.update(1 / 30);
  rec.maybeCapture(rsim);
}
const json = rec.toJSON();
const bytes = Buffer.byteLength(json);
ok(rec.doc.frames.length > 20, `recorder captured frames (${rec.doc.frames.length})`);
const perFrame = bytes / rec.doc.frames.length;
ok(perFrame < 30000, `replay is compact (~${perFrame.toFixed(0)} B/frame for ${rec.doc.ids.length} souls)`);

// load it back through the player and render — the replay must look like a sim to the view.
const player = new ReplayPlayer(JSON.parse(json));
ok(player.length === rec.doc.frames.length, 'replay round-trips through JSON');
player.seek(player.length - 1);
const rgrid = renderMap(player.sim(), vp);
const rglyphs = new Set();
for (const row of rgrid) for (const cell of row) rglyphs.add(cell.ch);
ok([...'tMr'].some((g) => rglyphs.has(g)), 'replayed frame draws living agents on the map');
const ra = player.sim().agents.find((a) => a.alive);
const rmind = mindLines(player.sim(), ra);
ok(rmind[0].startsWith('@title ') && rmind.some((l) => l.startsWith('doing:')), 'replayed agent renders its basics (name/status/goal)');
ok(chronicleLines(player.sim(), 16).some((l) => l.startsWith('· ')), 'replay carries the world-history chronicle');

// scrubbing: stepping backward then forward returns to the same frame.
player.seek(10);
const at10 = JSON.stringify(renderMap(player.sim(), vp));
player.step(-5);
player.step(5);
ok(JSON.stringify(renderMap(player.sim(), vp)) === at10, 'replay scrubbing is stable (back then forward)');

console.log(fails === 0 ? '\nDF observer: all checks passed.' : `\nDF observer: ${fails} FAILED.`);
process.exit(fails === 0 ? 0 : 1);
