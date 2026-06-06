// Commander: point-and-click control of a single agent — the "adventurer" — in
// the lineage of DF adventurer mode / Stoneshard / Caves of Qud. There is no
// WASD avatar anymore: you pick destinations and targets with the mouse and the
// controlled Agent executes them by reusing the SAME movement/combat steps the
// NPC AI uses (Agent.actControlled -> _goTo / _combatStep). The world keeps
// simulating around you; everyone else runs their own beliefs and ambitions.
//
// Controls:
//   Left-click  ground    -> walk there
//   Left-click  enemy     -> attack it · friendly -> approach (then E to talk)
//   Right-click anyone    -> attack (force) · ground -> run there
//   Wheel                 -> zoom the follow camera
//
// The Commander never decides for NPCs; it only drives the body you control.
// Combat still resolves through resolveCombat, and the town forms beliefs about
// what you do (Simulation.onCombatEvents) — so striking a peaceful villager has
// real social consequences. Hits land only on the agent you ordered an attack
// on (see `targetFighter`, consumed by main.js's hostility gate).

import * as THREE from 'three';
import { pickAgent } from './util/pick.js';

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

export class Commander {
  constructor(canvas, camera, orbitCam) {
    this.canvas = canvas;
    this.camera = camera;
    this.cam = orbitCam;
    this.agent = null;          // the controlled Agent
    this.sim = null;
    this.enabled = false;       // gated on game.state === 'playing'
    this.mouseNDC = { x: 0, y: 0 };
    this.targetFighter = null;  // current attack target's Fighter (lets our blows land)
    this.marker = this._buildMarker();
    this._bind();
  }

  attach(agent, sim) {
    this.agent = agent;
    this.sim = sim;
    if (agent) agent.goal = { kind: 'idle' };
  }

  // a ground decal that pings where you ordered a move, then fades
  _buildMarker() {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.35, 0.5, 20),
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthTest: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 999;
    return m;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('mousemove', (e) => this._trackMouse(e));
    c.addEventListener('mousedown', (e) => {
      if (!this.enabled || !this.agent || !this.agent.alive) return;
      this._trackMouse(e);
      if (e.button === 0) this._primary();
      else if (e.button === 2) this._forceAttack();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => { this.cam.zoom(e.deltaY > 0 ? 1 : -1); e.preventDefault(); },
      { passive: false });
  }

  _trackMouse(e) {
    this.mouseNDC.x = (e.clientX / innerWidth) * 2 - 1;
    this.mouseNDC.y = -(e.clientY / innerHeight) * 2 + 1;
  }

  // left-click: ALWAYS move to the point under the cursor — even when it's on a
  // unit — so you can position anywhere without ever starting a fight by accident.
  // Attacking is the deliberate right-click. (Talk to a neighbour with E.)
  _primary() {
    this._moveToGround(false);
  }

  // right-click: attack whoever is under the cursor; bare ground -> run there
  _forceAttack() {
    const npc = pickAgent(this.camera, this.mouseNDC, this.sim.agents);
    if (npc) { this.agent.goal = { kind: 'fight', targetId: npc.id }; return; }
    this._moveToGround(true);
  }

  _moveToGround(run) {
    if (!this._ground(_hit)) return;
    this.agent.goal = { kind: 'goto', target: _hit.clone(), run };
    this.marker.position.set(_hit.x, _hit.y + 0.05, _hit.z);
    this.marker.material.opacity = 0.9;
  }

  // raycast the cursor onto the horizontal plane through the agent's current Y —
  // works in the overworld AND down in the dungeon (which sits at y ≈ -400).
  _ground(out) {
    _ray.setFromCamera(_ndc.set(this.mouseNDC.x, this.mouseNDC.y), this.camera);
    _plane.setFromNormalAndCoplanarPoint(_up, this.agent.pos);
    return !!_ray.ray.intersectPlane(_plane, out);
  }

  update(dt, ctx) {
    const a = this.agent;
    if (!a) { this.targetFighter = null; return; }
    if (this.enabled && a.alive) a.actControlled(dt, ctx);
    // expose the live attack target so resolveCombat can let the player's swing
    // connect (peaceful NPCs are otherwise friendly-fire pass-through)
    this.targetFighter = (a.goal && a.goal.kind === 'fight' && this.sim)
      ? (this.sim.agentsById.get(a.goal.targetId)?.fighter || null)
      : null;
    if (this.marker.material.opacity > 0)
      this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 1.5);
  }
}
