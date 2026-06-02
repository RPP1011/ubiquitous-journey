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
import { PROFESSIONS, COMMODITIES, BASE_PRICE, SIM } from './sim/simconfig.js';
import { Inspector } from './ui/inspector.js';
import { MindBrowser } from './ui/mindbrowser.js';
import { castSpec } from './rpg/abilities/interpreter.js';
import { ABILITY_CATALOG } from './rpg/abilities/catalog.js';
import { pickAgent } from './util/pick.js';
import { DialogueView } from './ui/dialogueView.js';
import { DialogueSession } from './dialogue/dialogue.js';
import { QuestLog } from './ui/questLog.js';

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
const inspector = new Inspector(document.getElementById('inspector'), camera, null);
const mind = new MindBrowser(document.getElementById('mindList'), document.getElementById('mindDetail'), inspector);
const questLog = new QuestLog();   // self-mounts #questLog; board/player set in buildWorld()

// ---- dialogue modal (self-injects its own DOM + CSS) -----------------------
const dialogueView = new DialogueView();
dialogueView.onClose = () => {
  // returning from a conversation: resume play and re-capture the pointer
  if (game.state === 'dialogue') {
    game.state = 'playing';
    renderer.domElement.requestPointerLock();
  }
};

// Open a conversation with whoever is under the reticle, if within talkRange.
// Must never throw when nothing (or a monster/dead agent) is targeted.
function tryOpenDialogue() {
  if (game.state !== 'playing' || !game.sim || !game.sim.player) return;
  const npc = pickAgent(camera, null, game.sim.agents);
  if (!npc || !npc.alive) return;
  const me = game.sim.player;
  if (npc === me) return;
  if (me.pos.distanceTo(npc.pos) > SIM.talkRange) return;
  const session = new DialogueSession(npc, me, game.sim);
  game.state = 'dialogue';
  document.exitPointerLock();   // free the cursor so the modal buttons are clickable
  dialogueView.open(session);
}

// ---- ability cast keys (1-4 -> player's known-ability slots) ----------------
// Edge-triggered: cast once per key press, not every frame it's held. Safe when
// the player knows fewer than 4 abilities (slot missing -> no-op).
const CAST_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];
const _castHeld = new Set();
function pollCastKeys() {
  if (!game.sim || !game.sim.player) return;
  const slots = game.sim.player.abilityList();
  for (let i = 0; i < CAST_CODES.length; i++) {
    const code = CAST_CODES[i];
    const down = input.has(code);
    if (down && !_castHeld.has(code)) {
      _castHeld.add(code);
      const spec = slots[i];
      if (spec) { try { castSpec(spec, game.sim.player, game.sim._ctx()); } catch (e) { console.warn('cast failed', spec.id, e); } }
    } else if (!down) {
      _castHeld.delete(code);
    }
  }
}

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

// ---- debug readout + crash surface (temporary, to diagnose the freeze) -----
const dbg = document.createElement('div');
Object.assign(dbg.style, {
  position: 'fixed', left: '8px', bottom: '8px', zIndex: '9', font: '11px monospace',
  color: '#9fe', background: 'rgba(0,0,0,.6)', padding: '4px 8px', borderRadius: '4px',
  whiteSpace: 'pre', pointerEvents: 'none', maxWidth: '90vw',
});
document.body.appendChild(dbg);
let _frames = 0, _crashed = false;

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
  if (game.sim) { game.sim.dispose?.(); for (const a of game.sim.agents) a.fighter.dispose(); }
  if (game.world) game.world.dispose();

  game.world = new World(scene);
  game.sim = new Simulation(scene, game.world);
  game.sim.spawn();

  const pf = new Fighter('knight', { isPlayer: true });
  pf.root.position.set(0, 0, 8);
  scene.add(pf.root);
  game.playerFighter = pf;
  game.player = new Player(pf, orbitCam, input);
  const playerAgent = game.sim.addPlayer(pf);
  // Starter loadout so keys 1-4 have something to cast. Mix a melee spec (arms
  // the next swing), a projectile, a self spec and an AoE so every cast path is
  // exercised. Guarded: missing catalog ids are skipped.
  for (const id of ['power_strike', 'frost_bolt', 'second_wind', 'whirlwind']) {
    if (ABILITY_CATALOG[id]) playerAgent.grantAbility(ABILITY_CATALOG[id]);
  }

  inspector.setAgents(game.sim.agents);
  inspector.sim = game.sim;   // wire reputation 'thinks of you' panel
  mind.setAgents(game.sim.agents);
  questLog.setBoard(game.sim.quests);
  questLog.setPlayer(game.sim.player);   // the Agent (board ticks against sim.player)
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
  if (e.code === 'KeyE' && game.state === 'playing') { e.preventDefault(); tryOpenDialogue(); }
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyQ') questLog.toggle();
  // Digit1-4 drive ability casts while playing (handled in pollCastKeys); they
  // toggle the collapsible UI tabs only when NOT in active play.
  if (game.state !== 'playing') {
    if (e.code === 'Digit1') toggleTab(1);
    if (e.code === 'Digit2') toggleTab(2);
    if (e.code === 'Digit3') toggleTab(3);
    if (e.code === 'Digit4') toggleTab(4);
  }
});

input.onLockChange = (locked) => {
  if (game.state === 'dialogue') return;   // dialogue manages its own lock/unlock
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
  if (_crashed) return;
  _frames++;
  const dt = Math.min(clock.getDelta(), 0.05);
  let stage = 'start';
  try {
    const look = input.consumeLook();
    orbitCam.applyLook(look.dx, look.dy);

    if (game.state === 'playing') {
      stage = 'player.update'; game.player.update(dt);
      stage = 'sim.update';    game.sim.update(dt);
      stage = 'castInput';     pollCastKeys();
    } else if (game.state === 'dialogue') {
      // freeze the player but keep the social sim alive behind the modal
      stage = 'sim.update';    game.sim.update(dt);
    }

    const fighters = game.sim ? game.sim.fighters : [];
    stage = 'fighter.update'; for (const f of fighters) f.update(dt);
    scene.updateMatrixWorld(true);

    if (game.state === 'playing') {
      stage = 'resolveCombat';
      const events = resolveCombat(fighters, game.sim.isHostile.bind(game.sim), game.sim._ctx());
      if (events.length) {
        stage = 'onCombatEvents'; game.sim.onCombatEvents(events);
        for (const ev of events) if (ev.target === game.playerFighter && ev.type !== 'blocked') flashHurt();
      }
      if (hpFill) hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
    }

    stage = 'inspector';  inspector.update();
    stage = 'mind';       mind.update();
    stage = 'questLog';   questLog.render();
    stage = 'ticker';     updateTicker();
    if (game.playerFighter) { stage = 'camera'; orbitCam.update(game.playerFighter.root.position, dt); }
    stage = 'render';     renderer.render(scene, camera);

    const n = game.sim ? game.sim.agents.length : 0;
    dbg.textContent = `state=${game.state}  t=${game.sim ? game.sim.time.toFixed(1) : '-'}  frame=${_frames}  agents=${n}`;
  } catch (err) {
    _crashed = true;
    console.error('FRAME CRASH at stage:', stage, err);
    dbg.style.color = '#f88';
    dbg.textContent = `CRASH @ ${stage}\n${err && err.message}\n${(err && err.stack || '').split('\n').slice(1, 4).join('\n')}`;
    setOverlay(`<h1 class="lose">Runtime error</h1><p>stage: <b>${stage}</b></p><p>${err && err.message}</p><p style="font-size:11px;opacity:.7">${(err && err.stack || '').split('\n').slice(1, 5).join('<br>')}</p>`);
    showOverlay();
  }
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
