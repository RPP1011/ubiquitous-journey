// Bootstrap: a peaceful market-town sandbox. Agents have professions, produce
// commodities, eat, and trade at the market using price beliefs that update
// from trades and spread by gossip. Look at anyone and press F to read their
// economic mind. The human just wanders and watches.
//
// main.js is the thin entry: it builds the renderer/scene (boot.js), the HUD
// (ui/hud.js) and player input (playerControls.js), owns the game-state machine
// + world build/teardown, and runs the frame loop (with its crash-surface).

import * as THREE from 'three';
import { preloadCharacters } from './assets.js';
import { Fighter } from './fighter.js';
import { TUNE } from './constants.js';
import { createSession } from './app/session.js';
import { BattleDirector } from './app/tactics/director.js';
import { BattleRender } from './ui/battleRender.js';
import { StageSet, hasSet } from './ui/stageSet.js';
import { BattleFX } from './ui/battleFX.js';
import { TacticsView } from './ui/tacticsView.js';
import { RunController, localStore } from './app/run/run.js';
import { RunUI } from './ui/runView.js';
import { QUESTS, QUEST_ORDER } from './app/run/quests.js';
import { plan } from './app/run/autopilot.js';
import { hubStage, battleStage } from './ui/stagecraft.js';
import { CameraRig } from './ui/cameraRig.js';
import { terrainHeight } from './arena.js';
import { ABILITY_CATALOG } from './rpg/abilities/catalog.js';
import { DungeonManager } from './world/dungeonManager.js';
import { boot } from './boot.js';
import { Hud } from './ui/hud.js';
import { PlayerControls } from './playerControls.js';

// ---- renderer / scene / camera / input -------------------------------------
const { renderer, scene, camera, orbitCam, input, commander } = boot();

let dungeonMgr = null;             // built per-world in buildWorld()
let session = null;                // the app-layer Session (js/app/session.ts) for the current run
let tactics = null;                // BattleDirector: opens a tactical grid battle when the player's side comes to blows
let battleRender = null;           // the grid/props/fire drawn for the current battle
let stageSet = null; // the dressed place a run stage is fought in (ui/stageSet.ts)
let battleFX = null;               // the choreographer: plays each action as animation + effects
const tacView = new TacticsView();
tacView.camera = camera;
// RUN MODE (the game): hub → quests → tactical stages → home. `?sandbox` keeps the old free-roam
// town; `?autoplay` plays runs by itself (for recordings); `?fresh` wipes the save first.
const PARAMS = new URLSearchParams(location.search);
const RUN_MODE = !PARAMS.has('sandbox');
const AUTO = PARAMS.has('autoplay');
if (PARAMS.has('fresh')) { try { localStorage.removeItem('hearsay.save.v1'); } catch { /* private mode */ } }
let rc = null;                     // RunController (run mode)
let runUI = null;                  // the run screens
let camFocus = null;               // a point the camera should favour (the person you're talking to)
const HUB_CENTER = new THREE.Vector3(0, 0, -1.5);
// run mode's camera is its own rig — it frames scenes, it doesn't chase whoever is acting
const rig = new CameraRig(camera, renderer.domElement);
// hub: click a person in the square to talk to them
const _pickRay = new THREE.Raycaster();
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!RUN_MODE || game.state !== 'run' || !rc || !runUI || e.button !== 0) return;
  const people = [...rc.hubAgents.entries(), ...rc.companionAgents.entries()].filter(([, a]) => a.proxy && a.alive);
  _pickRay.setFromCamera(new THREE.Vector2(commander.mouseNDC.x, commander.mouseNDC.y), camera);
  const hits = _pickRay.intersectObjects(people.map(([, a]) => a.proxy), false);
  if (!hits.length) return;
  const hit = people.find(([, a]) => a.proxy === hits[0].object);
  if (hit && ['reeve', 'marta', 'anselm', 'hilde', 'tom', 'nan', 'borin', 'wren', 'pip', 'maud'].includes(hit[0])) runUI.talkTo(hit[0]);
});

// ---- HUD (panels + readouts) -----------------------------------------------
const hud = new Hud({
  camera,
  getSim: () => game.sim,
  getDungeonMgr: () => dungeonMgr,
});

// ---- game state ------------------------------------------------------------
const game = { state: 'start', world: null, sim: null, player: null, playerFighter: null };
// devtools handle (read-only inspection; the UI never reads it)
window.__hearsay = { game, view: tacView, get session() { return session; }, get tactics() { return tactics; }, get rc() { return rc; } };

// ---- player input ----------------------------------------------------------
const controls = new PlayerControls({
  game, input, camera, commander, hud,
  getDungeonMgr: () => dungeonMgr,
  togglePause: () => togglePause(),
  restart: () => restart(),
});
controls.installKeys();

function buildWorld() {
  if (dungeonMgr) { dungeonMgr.dispose(); dungeonMgr = null; }
  if (session) { session.dispose(); session = null; }

  // SEEDED DETERMINISM (opt-in): `?seed=<n>` in the URL arms the shared PRNG so the run
  // reproduces (same seed → same routed stochastic stream). No param ⇒ seed undefined ⇒
  // the PRNG stays unseeded (rng() === Math.random()), the default non-deterministic world.
  const _seedParam = new URLSearchParams(location.search).get('seed');
  const _seed = _seedParam == null ? undefined : (Number(_seedParam) | 0);
  // Starter loadout so keys 1-4 have something to cast. Mix a melee spec (arms
  // the next swing), a projectile, a self spec and an AoE so every cast path is
  // exercised. Guarded: missing catalog ids are skipped.
  const abilities = ['power_strike', 'frost_bolt', 'second_wind', 'whirlwind']
    .map((id) => ABILITY_CATALOG[id]).filter(Boolean);
  const pf = new Fighter('knight', { isPlayer: true });
  // run mode keeps a smaller town around the hub cast (the town sim is scenery, not the game)
  session = createSession({ scene, seed: _seed, townsfolkPerTown: RUN_MODE ? 1 : undefined, player: { fighter: pf, spawn: { x: 0, z: 8 }, abilities } });
  game.world = session.world;
  game.sim = session.sim;
  game.playerFighter = pf;
  // the player's swing lands only on the body they were ordered to attack, so peaceful
  // villagers aren't friendly-fire pass-through once you choose a victim.
  session.playerStrikeGate = (tgt) => commander.targetFighter === tgt;
  session.onRunEnd((summary) => { if (RUN_MODE) return; endBattleView(); showRunOver(summary); });
  endBattleView();
  tactics = new BattleDirector(session);
  if (RUN_MODE) {
    if (runUI) runUI.dispose();
    rc = new RunController(session, localStore());
    rc.setupHub();
    runUI = new RunUI({
      rc, auto: AUTO,
      openBattle: (b) => openBattle(b),
      closeBattle: () => { endBattleView(); game.state = 'run'; },
      focus: (p) => { camFocus = p ? new THREE.Vector3(p.x, 0, p.z) : null; },
      onDone: () => { window.__runDone = true; console.log('[run] done'); },
    });
    // ?stage=<id> jumps straight into one stage (a preview of its set; no run is saved from it)
    const jump = PARAMS.get('stage');
    for (const [qi, qid] of QUEST_ORDER.entries()) {
      const si = jump ? QUESTS[qid].stages.findIndex((st) => st.id === jump) : -1;
      if (si < 0) continue;
      const p = plan(qi, rc);
      rc.startRun(qid, p.party, p.disposition); rc.stageIdx = si;
      setTimeout(() => runUI.fight(), 0);
    }
  }

  // dungeons: scatter cave-mouth portals in the wilds and expose the manager to
  // the quest board so it can mint "delve" radiant quests against real dungeons.
  dungeonMgr = new DungeonManager(scene, game.sim);
  dungeonMgr.placeEntrances();
  game.sim.dungeons = dungeonMgr;

  commander.attach(session.player, game.sim);   // you drive this one body, point-and-click

  hud.setWorld(game.sim, controls.useItem);
  // overhead follow camera (Stoneshard/Qud-ish angle), no mouse-look
  orbitCam.yaw = 0; orbitCam.pitch = 0.88; orbitCam.distance = 11; orbitCam.height = 1.1;
}

// ---- DOM (overlay / hint) --------------------------------------------------
const overlay = document.getElementById('overlay');
const hint = document.getElementById('hint');

function setOverlay(html) { overlay.innerHTML = html; }
function showOverlay() { overlay.classList.remove('hidden'); }
function hideOverlay() { overlay.classList.add('hidden'); }

const _esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// The run is over (the player's body died). Nothing carries over; R begins a new run.
function showRunOver(summary) {
  game.state = 'over';
  const mins = Math.floor(summary.t / 60), secs = Math.floor(summary.t % 60);
  const beats = summary.beats.slice(-8).map((b) => `<li>${_esc(b.text)}</li>`).join('');
  setOverlay(`<h1 class="lose">YOU HAVE FALLEN</h1>
    <p>Your story ended after ${mins}m ${secs}s.</p>
    ${beats ? `<p>The town will remember:</p><ul style="text-align:left;font-size:13px">${beats}</ul>` : ''}
    <p><span class="key">R</span> to begin a new life.</p>`);
  showOverlay();
}

function restart() {
  buildWorld();
  hideOverlay();
  game.state = 'playing';
}

// pause/resume (replaces the old pointer-lock-driven pause)
function togglePause() {
  if (game.state === 'playing') {
    game.state = 'paused';
    setOverlay(`<h1>PAUSED</h1><p><span class="key">Esc</span> or <span class="key">click</span> to resume.</p>`);
    showOverlay();
  } else if (game.state === 'paused' || game.state === 'start') {
    hideOverlay(); hint.classList.add('hidden');
    game.state = 'playing';
  }
}

// ---- tactical battles (js/app/tactics) ------------------------------------
function endBattleView() {
  tacView.close();
  if (battleFX) { battleFX.dispose(); battleFX = null; tacView.fx = null; }
  if (battleRender) { battleRender.dispose(); battleRender = null; }
  if (stageSet) { stageSet.dispose(); stageSet = null; }
}
function openBattle(b) {
  game.state = 'battle';
  if (session.player) session.player.goal = { kind: 'idle' };
  if (!b.order.length) b.start();
  battleRender = new BattleRender(scene, b);
  if (RUN_MODE && rc && rc.stage && hasSet(rc.stage.id) && !b.map.onTerrain) { stageSet = new StageSet(scene, b, rc.stage.id); battleRender.bare = true; }
  battleFX = new BattleFX(scene, b);
  battleFX.onCaption = (text, kind, quote) => tacView.showCaption(text, kind, quote);
  tacView.fx = battleFX;
  tacView.auto = AUTO;
  tacView.open(b, battleRender);
}
tacView.onEnd = () => {
  if (RUN_MODE && runUI) { runUI.battleDone(); return; }
  endBattleView();
  tactics.clear();
  if (session.player) session.player.goal = { kind: 'idle' };   // don't chase a foe who fled or yielded
  session.checkRunEnd();
  if (game.state === 'battle') game.state = 'playing';
};
renderer.domElement.addEventListener('mousedown', (e) => {
  if (game.state !== 'battle' || !battleRender || e.button !== 0) return;
  const t = battleRender.pick(camera, commander.mouseNDC);
  if (t) tacView.clickTile(t);
});
renderer.domElement.addEventListener('mousemove', () => {
  if (game.state !== 'battle' || !battleRender) return;
  tacView.hoverTile(battleRender.pick(camera, commander.mouseNDC));
});

overlay.addEventListener('click', () => { if (game.state !== 'dialogue') togglePause(); });

// ---- main loop -------------------------------------------------------------
const clock = new THREE.Clock();
let _frames = 0, _crashed = false;

function frame() {
  if (_crashed) return;
  _frames++;
  const dt = Math.min(clock.getDelta(), 0.05);
  let stage = 'start';
  const stageFn = (name) => { stage = name; };
  try {
    commander.enabled = (game.state === 'playing');

    if (game.state === 'playing' || game.state === 'dialogue') {
      const playing = game.state === 'playing';
      if (playing) {
        stage = 'commander';     commander.update(dt, game.sim._ctx());
        // keep the player inside dungeon walls (overrides the arena clamp while below)
        stage = 'dungeon.collide'; if (dungeonMgr && dungeonMgr.active) dungeonMgr.collidePlayer(game.playerFighter.root.position);
      }
      // The canonical frame lives in the Session. In dialogue the player is frozen but the
      // social sim keeps running behind the modal, and no blows resolve.
      const events = session.step(dt, {
        combat: playing,
        stage: stageFn,
        afterSimUpdate: () => {
          if (!playing) return;
          if (dungeonMgr) dungeonMgr.update(dt);
          // settle the PLAYER onto the terrain surface too (the commander moves it in
          // x/z without re-grounding, so it would float on the hills). Overworld only —
          // while below, the dungeon owns the player's deep y, so we leave it alone.
          if (game.playerFighter && !(dungeonMgr && dungeonMgr.active)) {
            const p = game.playerFighter.root.position;
            try { p.y = terrainHeight(p.x, p.z); } catch { /* never throw on the frame */ }
          }
        },
        beforeCombat: () => scene.updateMatrixWorld(true),
      });
      if (playing) {
        for (const ev of events) if (ev.target === game.playerFighter && ev.type !== 'blocked') hud.flashHurt();
        stage = 'castInput';     controls.pollCastKeys();
        stage = 'gather';        controls.pollGather(dt);
        if (hud.hpFill) hud.hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
        // the player's side came to blows: switch to a tactical battle
        stage = 'tactics.watch';
        const b = game.state === 'playing' && tactics ? tactics.watch() : null;
        if (b) openBattle(b);
      }
    } else if (game.state === 'run') {
      // run mode, between battles: the curated hub (cast + company only), no real-time blows
      session.step(dt, { combat: false, stage: stageFn, beforeCombat: () => scene.updateMatrixWorld(true) });
      stage = 'run.curate'; if (rc) { rc.curate(); hubStage(rc, runUI ? runUI.speaking : null); }
      stage = 'run.tick'; if (runUI) runUI.tick(dt, null);
    } else if (game.state === 'battle') {
      // the world holds its breath: only the battle advances (the town is not simulated mid-fight)
      stage = 'battle.tick'; tacView.tick(dt); if (stageSet) stageSet.sync(dt);
      if (runUI && rc) runUI.tick(dt, rc.battle, !!battleFX && battleFX.busy);
      if (rc && rc.battle) battleStage(rc.battle, battleFX);
      if (game.sim) { stage = 'fighter.update'; for (const f of game.sim.fighters) f.update(dt); }
      scene.updateMatrixWorld(true);
      if (!RUN_MODE && session.player && !session.player.alive) session.checkRunEnd();
      if (hud.hpFill) hud.hpFill.style.width = `${Math.max(0, (game.playerFighter.health / TUNE.maxHealth) * 100)}%`;
    } else {
      // paused / start / over: the sim is frozen, bodies keep animating (as before), no blows
      if (game.sim) { stage = 'fighter.update'; for (const f of game.sim.fighters) f.update(dt); }
      scene.updateMatrixWorld(true);
    }

    hud.render(game, commander.mouseNDC, stageFn);
    stage = 'camera';
    if (RUN_MODE) {
      if (game.state === 'battle' && rc && rc.battle) {
        // frame the fight as a whole: everyone still in it
        const pts = rc.battle.units.filter((u) => u.out === null || u.out === 'downed').map((u) => u.agent.pos.clone());
        rig.frameBox(pts);
      } else if (camFocus) rig.frameOn(camFocus);
      else rig.frameWide(HUB_CENTER);
      rig.update(dt, input);
    } else if (game.state === 'battle' && battleRender) {
      orbitCam.update(game.playerFighter.root.position, dt);
    } else if (game.playerFighter) {
      orbitCam.update(game.playerFighter.root.position, dt);
    }
    stage = 'render';     renderer.render(scene, camera);

    const n = game.sim ? game.sim.agents.length : 0;
    hud.setDebug(`state=${game.state}  t=${game.sim ? game.sim.time.toFixed(1) : '-'}  frame=${_frames}  agents=${n}`);
  } catch (err) {
    _crashed = true;
    console.error('FRAME CRASH at stage:', stage, err);
    hud.setCrash(`CRASH @ ${stage}\n${err && err.message}\n${(err && err.stack || '').split('\n').slice(1, 4).join('\n')}`);
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
  <p>You guide a single adventurer through a living town of farmers, miners and a
  smith who produce, trade and gossip on their own <i>beliefs</i>.</p>
  <p><b>Left-click</b> to move anywhere · <b>right-click</b> to attack a target.
  Hover anyone to read their mind; <span class="key">E</span> to talk.</p>
  <p style="margin-top:16px;"><span class="key">Click</span> to begin.</p>`;

setOverlay(`<h1>MARKET TOWN</h1><p>Loading…</p>`);
preloadCharacters().then(() => {
  buildWorld();
  if (RUN_MODE) {
    hideOverlay(); hint.classList.add('hidden');
    document.body.classList.add('runmode');
    if (!PARAMS.has('debug') && hud._dbg) hud._dbg.style.display = 'none';
    if (hud._pstats) hud._pstats.style.display = 'none';
    const st = document.createElement('style');
    st.textContent = '.runmode #hud, .runmode #tabs, .runmode #econView, .runmode #inspector, .runmode #mindHint, .runmode #mindList, .runmode #mindDetail, .runmode #playerHud, .runmode #hint { display: none !important; }';
    document.head.appendChild(st);
    game.state = 'run';
    if (AUTO) runUI.autoplay(PARAMS.has('quick')); else runUI.title();
  } else {
    game.state = 'start';
    setOverlay(INTRO);
  }
  renderer.setAnimationLoop(frame);
}).catch((err) => {
  setOverlay(`<h1 class="lose">Load error</h1><p>${err.message}</p><p>Serve over http (python3 -m http.server).</p>`);
  console.error(err);
});
