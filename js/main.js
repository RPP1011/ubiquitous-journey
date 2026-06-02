// Bootstrap: a peaceful market-town sandbox. Agents have professions, produce
// commodities, eat, and trade at the market using price beliefs that update
// from trades and spread by gossip. Look at anyone and press F to read their
// economic mind. The human just wanders and watches.

import * as THREE from 'three';
import { buildArena } from './arena.js';
import { preloadCharacters } from './assets.js';
import { Fighter } from './fighter.js';
import { Input } from './input.js';
import { OrbitCamera } from './camera.js';
import { Player } from './player.js';
import { resolveCombat } from './combat.js';
import { TUNE } from './constants.js';
import { World } from './sim/world.js';
import { Simulation } from './sim/simulation.js';
import { PROFESSIONS, COMMODITIES, BASE_PRICE } from './sim/simconfig.js';
import { Inspector } from './ui/inspector.js';
import { MindBrowser } from './ui/mindbrowser.js';

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

// ---- renderer / scene ------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
buildArena(scene);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 4, 8);

const orbitCam = new OrbitCamera(camera);
const input = new Input(renderer.domElement);
const inspector = new Inspector(document.getElementById('inspector'), camera);
const mind = new MindBrowser(document.getElementById('mindList'), document.getElementById('mindDetail'), inspector);

// ---- DOM -------------------------------------------------------------------
const overlay = document.getElementById('overlay');
const hint = document.getElementById('hint');
const legendEl = document.getElementById('factions');
const hpFill = document.getElementById('hpFill');   // player health (combat is live now)

// red hurt flash when the player takes a hit
const hurt = document.createElement('div');
Object.assign(hurt.style, {
  position: 'fixed', inset: '0', opacity: '0', pointerEvents: 'none', transition: 'opacity .35s',
  zIndex: '5', background: 'radial-gradient(ellipse at center, rgba(180,0,0,0) 45%, rgba(180,0,0,.55) 100%)',
});
document.body.appendChild(hurt);
function flashHurt() { hurt.style.opacity = '1'; setTimeout(() => (hurt.style.opacity = '0'), 60); }

(function professionLegend() {
  const rows = Object.values(PROFESSIONS).map((p) =>
    `<div class="f"><span class="dot" style="background:${hex(p.color)}"></span>${p.label}</div>`).join('');
  legendEl.innerHTML = rows + `<div id="ticker"></div>`;
})();
const tickerEl = document.getElementById('ticker');

// collapsible tabs: click a header, or press its number key
function toggleTab(n) {
  const t = document.querySelector(`#tabs .tab[data-tab="${n}"]`);
  if (t) t.classList.toggle('collapsed');
}
document.querySelectorAll('#tabs .tab-head').forEach((h, i) =>
  h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed')));

// ---- game state ------------------------------------------------------------
const game = { state: 'start', world: null, sim: null, player: null, playerFighter: null };

function buildWorld() {
  if (game.sim) for (const a of game.sim.agents) a.fighter.dispose();
  if (game.world) game.world.dispose();

  game.world = new World(scene);
  game.sim = new Simulation(scene, game.world);
  game.sim.spawn();

  const pf = new Fighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  scene.add(pf.root);
  game.playerFighter = pf;
  game.player = new Player(pf, orbitCam, input);
  game.sim.addPlayer(pf);

  inspector.setAgents(game.sim.agents);
  mind.setAgents(game.sim.agents);
  orbitCam.yaw = 0; orbitCam.pitch = 0.25;
}

// ---- overlay ---------------------------------------------------------------
function setOverlay(html) { overlay.innerHTML = html; }
function showOverlay() { overlay.classList.remove('hidden'); }
function hideOverlay() { overlay.classList.add('hidden'); }

function restart() {
  buildWorld();
  hideOverlay();
  game.state = 'playing';
  renderer.domElement.requestPointerLock();
}

overlay.addEventListener('click', () => { hideOverlay(); renderer.domElement.requestPointerLock(); });
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') restart();
  if (e.code === 'Digit1') toggleTab(1);
  if (e.code === 'Digit2') toggleTab(2);
  if (e.code === 'Digit3') toggleTab(3);
  if (e.code === 'Digit4') toggleTab(4);
});

input.onLockChange = (locked) => {
  if (locked) {
    hideOverlay(); hint.classList.add('hidden');
    if (game.state === 'start' || game.state === 'paused') game.state = 'playing';
  } else if (game.state === 'playing') {
    game.state = 'paused';
    setOverlay(`<h1>PAUSED</h1><p><span class="key">Click</span> to resume.</p>`);
    showOverlay();
  }
};

// ---- market price ticker ---------------------------------------------------
function updateTicker() {
  if (!game.sim) return;
  tickerEl.innerHTML = COMMODITIES.map((c) => {
    const p = game.sim.avgPrice(c), base = BASE_PRICE[c];
    const col = p > base * 1.08 ? '#e0894e' : p < base * 0.92 ? '#7fd18a' : '#cbd5e1';
    return `<span style="color:${col}">${c} ${p.toFixed(1)}g</span>`;
  }).join(' · ');
}

// ---- main loop -------------------------------------------------------------
const clock = new THREE.Clock();

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);

  const look = input.consumeLook();
  orbitCam.applyLook(look.dx, look.dy);

  if (game.state === 'playing') {
    game.player.update(dt);
    game.sim.update(dt);
  }

  const fighters = game.sim ? game.sim.fighters : [];
  for (const f of fighters) f.update(dt);
  scene.updateMatrixWorld(true);

  if (game.state === 'playing') {
    const events = resolveCombat(fighters, game.sim.isHostile.bind(game.sim));
    if (events.length) {
      game.sim.onCombatEvents(events);
      for (const ev of events) if (ev.target === game.playerFighter && ev.type !== 'blocked') flashHurt();
    }
    if (hpFill) hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
  }

  inspector.update();
  mind.update();
  updateTicker();
  if (game.playerFighter) orbitCam.update(game.playerFighter.root.position, dt);
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---- boot ------------------------------------------------------------------
const INTRO = `<h1>MARKET TOWN</h1>
  <p>Farmers, woodcutters, miners and a smith produce goods, eat, and trade at
  the market using <i>price beliefs</i> that shift with supply, demand and gossip.</p>
  <p>Watch prices move in the ticker; look at anyone and press <span class="key">F</span> to read their economic mind.</p>
  <p style="margin-top:16px;"><span class="key">Click</span> to enter.</p>`;

setOverlay(`<h1>MARKET TOWN</h1><p>Loading…</p>`);
preloadCharacters().then(() => {
  buildWorld();
  game.state = 'start';
  setOverlay(INTRO);
  renderer.setAnimationLoop(frame);
}).catch((err) => {
  setOverlay(`<h1 class="lose">Load error</h1><p>${err.message}</p><p>Serve over http (python3 -m http.server).</p>`);
  console.error(err);
});
