// Entry point for the Dwarf-Fortress-style OBSERVER view (`df.html`). Boots a HEADLESS `Simulation`
// (the logic-only fighter + a stub scene — no Three.js renderer, no assets), runs it live, and renders
// the world as a colour ASCII glyph grid with a free-look cursor and side panels (look / chronicle /
// gazette). Pure spectator: it never drives an agent (the observer invariant).

import { Simulation } from '../sim/simulation.js';
import { World } from '../sim/world.js';
import { HeadlessFighter } from '../headlessFighter.js';
import { ARENA_RADIUS } from '../arena.js';
import {
  type Viewport,
  renderMap,
  cellToWorld,
  worldToCell,
  agentAt,
  mindLines,
  tileLines,
  chronicleLines,
  gazetteLines,
} from './view.js';
import type { Cell } from './glyphs.js';
import { ReplayPlayer } from './replay.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Two modes: LIVE (boot a headless sim and run it) or REPLAY (`?replay=URL` — play a recorded log
// back, no simulation). Both render through the SAME `view.ts`, so the only difference is the source.
const params = new URLSearchParams(location.search);
const replayUrl = params.get('replay');
const urlSeed = params.get('seed');

let sim: any = null; // the live sim (LIVE mode)
let replay: ReplayPlayer | null = null; // the recorded source (REPLAY mode)

function bootLive(): void {
  const stubScene = { add() {}, remove() {} };
  const seed = urlSeed ? Number(urlSeed) : 0xdf01;
  sim = new Simulation(
    stubScene as any,
    new World(stubScene as any) as any,
    { makeFighter: ((model: string, o: any) => new HeadlessFighter(model as any, o)) as any, seed },
  );
  sim.spawn();
}

/** The current sim-like read surface the renderer consumes (a live sim, or the replay's current frame). */
function source(): any {
  return replay ? replay.sim() : sim;
}

// ── view + cursor state ─────────────────────────────────────────────────────────────────────
const vp: Viewport = { cx: 0, cz: 0, mpp: 14, cols: 80, rows: 40 };
let curCol = Math.floor(vp.cols / 2);
let curRow = Math.floor(vp.rows / 2);
let paused = false;
let speed = 1; // sim-time multiplier
let side: 'chronicle' | 'gazette' = 'chronicle';
let followId: any = null; // an agent the cursor/viewport locks onto

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const mapEl = $('map');
const lookEl = $('look');
const sideEl = $('side');
const statusEl = $('status');

// ── grid sizing: fit the glyph grid to the map pane using a fixed char metric ──────────────────
const CHAR_W = 8.2; // px per glyph (matches the CSS font-size/letter-spacing below)
const LINE_H = 15; // px per row
function fitGrid(): void {
  const rect = mapEl.getBoundingClientRect();
  vp.cols = Math.max(20, Math.floor(rect.width / CHAR_W));
  vp.rows = Math.max(12, Math.floor(rect.height / LINE_H));
  curCol = Math.min(curCol, vp.cols - 1);
  curRow = Math.min(curRow, vp.rows - 1);
}
window.addEventListener('resize', fitGrid);

// ── render the grid → HTML (runs of same colour collapse into one <span> for speed) ───────────
function gridToHtml(grid: Cell[][]): string {
  let html = '';
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    let run = '';
    let runColor = '';
    let runInvert = false;
    const flush = () => {
      if (!run) return;
      const style = runInvert
        ? `background:${runColor};color:#0b0d10`
        : `color:${runColor}`;
      html += `<span style="${style}">${esc(run)}</span>`;
      run = '';
    };
    for (let c = 0; c < row.length; c++) {
      const invert = r === curRow && c === curCol; // the look-cursor cell
      const cell = row[c];
      if (cell.color !== runColor || invert || runInvert) {
        flush();
        runColor = cell.color;
        runInvert = invert;
      }
      run += cell.ch;
    }
    flush();
    html += '\n';
  }
  return html;
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

// ── render the LOOK panel: the agent under the cursor (its mind), else the tile ────────────────
function renderLook(): void {
  const s = source();
  const { x, z } = cellToWorld(vp, curCol, curRow);
  const a = agentAt(s, x, z, vp.mpp * 1.4);
  const lines = a ? mindLines(s, a) : tileLines(s, x, z, vp.mpp * 1.4);
  if (a && replay) lines.push('@sec —', '  (replay: minds show basics; run live for full inspection)');
  lookEl.innerHTML = panelHtml(lines);
}

// turn @title / @sec marked lines into headers; everything else is a plain row.
function panelHtml(lines: string[]): string {
  return lines
    .map((l) => {
      if (l.startsWith('@title ')) return `<div class="ptitle">${esc(l.slice(7))}</div>`;
      if (l.startsWith('@sec ')) return `<div class="psec">${esc(l.slice(5))}</div>`;
      return `<div class="prow">${esc(l)}</div>`;
    })
    .join('');
}

function renderSide(): void {
  const s = source();
  const lines =
    side === 'chronicle' ? chronicleLines(s, 16) : gazetteLines(s, 8);
  const title = side === 'chronicle' ? 'CHRONICLE' : 'GAZETTE';
  sideEl.innerHTML = `<div class="ptitle">${title}</div>` + panelHtml(lines);
}

function renderStatus(): void {
  const s = source();
  const alive = (s.agents || []).filter((a: any) => a.alive).length;
  const t = Math.round(s.time || 0);
  const mode = replay
    ? `<span class="warn">REPLAY</span> frame ${replay.i + 1}/${replay.length}`
    : `<b>MARKET TOWN</b>`;
  statusEl.innerHTML =
    `${mode} &nbsp; t=${t} &nbsp; souls ${alive} &nbsp; ` +
    `${paused ? '<span class="warn">PAUSED</span>' : 'playing ×' + speed} &nbsp; zoom ${vp.mpp}m` +
    (followId != null ? ` &nbsp; <span class="warn">following</span>` : '');
}

// ── input ──────────────────────────────────────────────────────────────────────────────────
function moveCursor(dc: number, dr: number): void {
  followId = null;
  curCol += dc;
  curRow += dr;
  // scroll the viewport (DF-style) when the cursor pushes past an edge.
  if (curCol < 0) {
    vp.cx -= vp.mpp;
    curCol = 0;
  } else if (curCol >= vp.cols) {
    vp.cx += vp.mpp;
    curCol = vp.cols - 1;
  }
  if (curRow < 0) {
    vp.cz -= vp.mpp;
    curRow = 0;
  } else if (curRow >= vp.rows) {
    vp.cz += vp.mpp;
    curRow = vp.rows - 1;
  }
  const lim = ARENA_RADIUS + 60;
  vp.cx = Math.max(-lim, Math.min(lim, vp.cx));
  vp.cz = Math.max(-lim, Math.min(lim, vp.cz));
}

// jump the cursor to the next/prev living agent (by id order) and follow it.
function jumpAgent(dir: number): void {
  const s = source();
  const live = (s.agents || []).filter((a: any) => a.alive).sort((x: any, y: any) => (x.id < y.id ? -1 : 1));
  if (!live.length) return;
  let idx = live.findIndex((a: any) => a.id === followId);
  idx = (idx + dir + live.length) % live.length;
  if (idx < 0) idx = 0;
  followId = live[idx].id;
  centerOnFollowed();
}

function centerOnFollowed(): void {
  const s = source();
  const a = followId != null && s.agentsById && s.agentsById.get(followId);
  if (!a || !a.alive || !a.pos) {
    followId = null;
    return;
  }
  vp.cx = a.pos.x;
  vp.cz = a.pos.z;
  const cell = worldToCell(vp, a.pos.x, a.pos.z);
  curCol = cell.col;
  curRow = cell.row;
}

window.addEventListener('keydown', (e) => {
  switch (e.key) {
    case 'ArrowLeft':
    case 'h':
      moveCursor(-1, 0);
      break;
    case 'ArrowRight':
    case 'l':
      moveCursor(1, 0);
      break;
    case 'ArrowUp':
    case 'k':
      moveCursor(0, -1);
      break;
    case 'ArrowDown':
    case 'j':
      moveCursor(0, 1);
      break;
    case ' ':
      paused = !paused;
      e.preventDefault();
      break;
    case '.':
      // single step forward: a sim tick (LIVE) or a frame (REPLAY).
      if (replay) replay.step(1);
      else if (paused) sim.update(1 / 30);
      break;
    case ',':
      if (replay) replay.step(-1); // step a replay BACKWARD (live can't rewind)
      break;
    case '<':
      if (replay) replay.step(-10); // jump back ~10 frames
      break;
    case '>':
      if (replay) replay.step(10); // jump forward ~10 frames
      break;
    case '+':
    case '=':
      speed = Math.min(8, speed * 2);
      break;
    case '-':
    case '_':
      speed = Math.max(0.25, speed / 2);
      break;
    case '[':
      vp.mpp = Math.min(40, vp.mpp + 2); // zoom out
      break;
    case ']':
      vp.mpp = Math.max(4, vp.mpp - 2); // zoom in
      break;
    case 'Tab':
      side = side === 'chronicle' ? 'gazette' : 'chronicle';
      e.preventDefault();
      break;
    case 'n':
      jumpAgent(1);
      break;
    case 'p':
      jumpAgent(-1);
      break;
    case 'Home':
      vp.cx = 0;
      vp.cz = 0;
      followId = null;
      break;
    default:
      return;
  }
});

// ── the loop: advance the world (LIVE sim or REPLAY playhead) unless paused; render on a throttle ─
let lastT = performance.now();
let acc = 0;
let frameAcc = 0; // accumulates real time → replay frame advance
const RENDER_EVERY = 1 / 18; // s — the ASCII view doesn't need 60fps
function advance(dt: number): void {
  if (paused) return;
  if (replay) {
    // play the recorded frames at their sample rate × speed.
    frameAcc += dt * speed;
    const per = 1 / (replay.doc.meta.sampleHz || 2);
    while (frameAcc >= per) {
      frameAcc -= per;
      if (replay.i >= replay.length - 1) {
        paused = true; // reached the end of the recording
        break;
      }
      replay.step(1);
    }
  } else {
    sim.update(dt * speed);
  }
}
function frame(now: number): void {
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1; // clamp (tab was backgrounded) — the sim guards spiral too
  advance(dt);
  if (followId != null) centerOnFollowed();
  acc += dt;
  if (acc >= RENDER_EVERY) {
    acc = 0;
    mapEl.innerHTML = gridToHtml(renderMap(source(), vp));
    renderLook();
    renderSide();
    renderStatus();
  }
  requestAnimationFrame(frame);
}

// ── boot: load a recorded replay (REPLAY mode) or build a live sim (LIVE mode), then run the loop ─
async function boot(): Promise<void> {
  fitGrid();
  if (replayUrl) {
    statusEl.textContent = `loading replay ${replayUrl}…`;
    try {
      const doc = await (await fetch(replayUrl)).json();
      replay = new ReplayPlayer(doc);
      paused = true; // start a replay paused at frame 0 (the viewer scrubs/plays)
    } catch (e) {
      statusEl.innerHTML = `<span class="warn">failed to load replay ${replayUrl}</span> — ${String(e)}`;
      bootLive(); // fall back to a live world so the page still works
    }
  } else {
    bootLive();
  }
  requestAnimationFrame(frame);
}

boot();
