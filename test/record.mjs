// Record a replay log of a headless sim run, for offline playback in the DF observer (`df.html?replay=`).
// Usage: bun test/record.mjs [seed] [seconds] [sampleHz] [outPath]
//   bun test/record.mjs 0xC00D19 180 3 replay.json
// The log is a compact per-frame record (positions/flags/goal/level/hp + new chronicle/gazette events);
// the N² belief layer is NOT logged (see js/df/replay.ts). Prints the resulting size + data rate.

import { writeFileSync } from 'node:fs';
import { Simulation } from '../js/sim/simulation.js';
import { World } from '../js/sim/world.js';
import { HeadlessFighter } from '../js/headlessFighter.js';
import { Recorder } from '../js/df/replay.js';

const arg = (i, d) => (process.argv[i] !== undefined ? process.argv[i] : d);
const seed = Number(arg(2, '0xdf01'));
const seconds = Number(arg(3, '120'));
const sampleHz = Number(arg(4, '2'));
const out = String(arg(5, 'replay.json'));

const stub = { add() {}, remove() {} };
const sim = new Simulation(stub, new World(stub), {
  makeFighter: (m, o) => new HeadlessFighter(m, o),
  seed,
});
sim.spawn();

const rec = new Recorder(sim, { seed, sampleHz });
const DT = 1 / 30;
const steps = Math.round(seconds / DT);
for (let i = 0; i < steps; i++) {
  sim.update(DT);
  rec.maybeCapture(sim);
}

const json = rec.toJSON();
writeFileSync(out, json);

const bytes = Buffer.byteLength(json);
const frames = rec.doc.frames.length;
console.log(`recorded ${frames} frames over ${seconds}s (seed 0x${seed.toString(16)}, ${rec.doc.ids.length} souls)`);
console.log(`wrote ${out}: ${(bytes / 1024).toFixed(0)} KB  (${(bytes / frames).toFixed(0)} B/frame, ~${((bytes / seconds) / 1024).toFixed(1)} KB/s of sim time)`);
console.log(`open: df.html?replay=${out}`);
