// BattleFX: the CHOREOGRAPHER. Plays a Battle's presentation cues (tactics/battle.ts `cues`) as
// timed beats, so what the rules resolve instantly is SHOWN in order: the walk, the swing, the
// dodge or the stagger, the number, the fall; the shove and the slide into the fire; the thrown
// flour sack's arc and its cloud; the coins leaving a purse; the words someone shouts and how the
// listener takes them.
//
// Bodies use the KayKit clips (chops, kicks, punches, Throw, PickUp, Use_Item, Lie_Down/StandUp,
// Dodge, Death). Everything else is procedural three.js: soft-sprite particles, projectiles,
// speech bubbles, floating numbers and icons, tethers and shockwave rings.
//
// Read-only over the battle. It only moves BODIES (visual transforms the battle already settled)
// and tells the UI what HP to show and whether a beat is still playing.

import * as THREE from 'three';
import { TUNE } from '../constants.js';
import type { Battle, Cue, Spot, Unit } from '../app/tactics/battle.js';

// ---------------------------------------------------------------------------------------------
// the vendored three.module.js is plain JS: transform members are invisible to tsc
interface O3 {
  position: THREE.Vector3; rotation: { x: number; y: number; z: number }; scale: { set(x: number, y: number, z: number): void; x: number };
  visible: boolean; renderOrder: number; quaternion: THREE.Quaternion; lookAt(v: THREE.Vector3): void;
}
const o3 = (m: unknown) => m as O3;
type Scene = { add(o: unknown): void; remove(o: unknown): void };
type FighterFX = {
  root: O3; alive: boolean; health: number; height: number; fxLock: boolean;
  playClip(name: string, o?: { speed?: number; hold?: boolean; fade?: number }): number;
  endPose(): void; holdLoop(name: string): void; setMoving(s: number): void; setFacing(y: number): void;
};

// ---------------------------------------------------------------------------------------------
// textures (built once, lazily; browser only)
let _soft: THREE.Texture | null = null;
function softTex(): THREE.Texture {
  if (_soft) return _soft;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  _soft = new THREE.CanvasTexture(c);
  return _soft;
}

function textSprite(text: string, opts: { color?: string; size?: number; bubble?: boolean; weight?: string } = {}): THREE.Sprite {
  const size = opts.size ?? 44;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  g.font = `${opts.weight ?? 'bold'} ${size}px "Segoe UI", system-ui, sans-serif`;
  const lines = opts.bubble ? wrap(g, text, 520) : [text];
  const w = Math.min(600, Math.max(...lines.map((l) => g.measureText(l).width)) + (opts.bubble ? 44 : 16));
  const h = lines.length * size * 1.25 + (opts.bubble ? 40 : 12);
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  g.font = `${opts.weight ?? 'bold'} ${size}px "Segoe UI", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (opts.bubble) {
    g.fillStyle = 'rgba(250,247,238,0.96)';
    const r = 18, bw = c.width - 4, bh = c.height - 22;
    g.beginPath(); g.moveTo(2 + r, 2); g.lineTo(2 + bw - r, 2); g.quadraticCurveTo(2 + bw, 2, 2 + bw, 2 + r); g.lineTo(2 + bw, 2 + bh - r);
    g.quadraticCurveTo(2 + bw, 2 + bh, 2 + bw - r, 2 + bh); g.lineTo(c.width / 2 + 14, 2 + bh); g.lineTo(c.width / 2, c.height - 2); g.lineTo(c.width / 2 - 8, 2 + bh);
    g.lineTo(2 + r, 2 + bh); g.quadraticCurveTo(2, 2 + bh, 2, 2 + bh - r); g.lineTo(2, 2 + r); g.quadraticCurveTo(2, 2, 2 + r, 2); g.fill();
    g.fillStyle = '#1b1f26';
    lines.forEach((l, i) => g.fillText(l, c.width / 2, 2 + (bh / lines.length) * (i + 0.5)));
  } else {
    g.lineWidth = Math.max(4, size / 7); g.strokeStyle = 'rgba(0,0,0,0.85)'; g.strokeText(text, c.width / 2, c.height / 2);
    g.fillStyle = opts.color ?? '#fff'; g.fillText(text, c.width / 2, c.height / 2);
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const k = 0.0105 * (opts.bubble ? 0.85 : 1);
  o3(s).scale.set(c.width * k, c.height * k, 1);
  o3(s).renderOrder = 1200;
  return s;
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = []; let line = '';
  for (const w of text.split(/\s+/)) { const t = line ? `${line} ${w}` : w; if (g.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line);
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------------------------

interface Particle { s: THREE.Sprite; v: THREE.Vector3; life: number; max: number; g: number; grow: number; size: number; fade: boolean; }
interface Floater { s: THREE.Sprite; life: number; max: number; rise: number; anchor?: () => THREE.Vector3; off: number; }
interface Beat { dur: number; t: number; tick?: (t: number, k: number) => void; done?: () => void; }

export interface UnitView { hp: number; gone: boolean; down: boolean; }

export class BattleFX {
  private scene: Scene;
  private b: Battle;
  private ci = 0;
  private beat: Beat | null = null;
  private parts: Particle[] = [];
  private floats: Floater[] = [];
  private meshes: Array<{ o: THREE.Object3D; life: number; max: number; tick?: (k: number) => void }> = [];
  private views = new Map<Unit['id'], UnitView>();
  private moving = new Set<Unit['id']>();
  private clipIdx = 0;
  onCaption: ((text: string, kind: string, quote: string | null) => void) | null = null;
  /** A set-piece goes off (the stage set animates its model). */
  onPiece: ((id: string, dir: [number, number]) => void) | null = null;
  private quote: string | null = null;
  private lastCaptionAt = -1;

  constructor(scene: Scene, b: Battle) {
    this.scene = scene; this.b = b;
    for (const u of b.units) {
      const f = this.f(u); if (f) f.fxLock = true;
      this.views.set(u.id, { hp: Math.max(0, u.agent.fighter.health), gone: false, down: u.out === 'downed' });
    }
    this.ci = b.cues.length;       // cues from before we opened (set-up) are already on screen
  }

  /** Is a beat playing, or are cues waiting? (NPC turns and "Continue" wait on this.) */
  get busy(): boolean { return !!this.beat || this.ci < this.b.cues.length || this.floats.some((f) => f.max > 1.5 && f.life < 0.9); }

  view(u: Unit): UnitView { return this.views.get(u.id) ?? { hp: u.agent.fighter.health, gone: false, down: false }; }

  /** The words the player typed for the action about to play (shown with its caption). */
  setQuote(q: string | null): void { this.quote = q; }

  dispose(): void {
    for (const u of this.b.units) { const f = this.f(u); if (f) { f.fxLock = false; f.setMoving(0); } }
    for (const p of this.parts) this.scene.remove(p.s);
    for (const f of this.floats) this.scene.remove(f.s);
    for (const m of this.meshes) this.scene.remove(m.o);
    this.parts = []; this.floats = []; this.meshes = [];
  }

  // ---- the frame ---------------------------------------------------------------------------------

  update(dt: number): void {
    // new cues arrived: pull each moved body back to where its first beat starts (no spoilers)
    if (!this.beat && this.ci < this.b.cues.length) this.rewind(this.ci);
    let guard = 0;
    while (guard++ < 40) {
      if (this.beat) {
        this.beat.t += dt; dt = 0;
        const k = Math.min(1, this.beat.t / this.beat.dur);
        this.beat.tick?.(this.beat.t, k);
        if (k < 1) break;
        this.beat.done?.();
        this.beat = null;
      }
      if (this.ci >= this.b.cues.length) break;
      const i = this.ci++;
      this.caption(i);
      this.beat = this.start(this.b.cues[i], this.b.cues[i + 1]);
      if (!this.beat) continue;
    }
    this.stepParticles(dt || 1 / 60);
  }

  private rewind(from: number): void {
    const seen = new Set<Unit['id']>();
    for (let i = from; i < this.b.cues.length; i++) {
      const c = this.b.cues[i];
      if ((c.k === 'step' && !seen.has(c.u)) || (c.k === 'slide' && !seen.has(c.t))) {
        const id = c.k === 'step' ? c.u : c.t;
        seen.add(id);
        const f = this.fx(id); if (f) f.root.position.copy(this.at(c.from));
      }
    }
  }

  private caption(i: number): void {
    const c = this.b.cues[i];
    const end = this.b.cues[i + 1]?.logAt ?? this.b.log.length;
    if (c.logAt <= this.lastCaptionAt) return;
    const lines = this.b.log.slice(c.logAt, end);
    if (!lines.length) return;
    const rank = (k: string) => ({ end: 6, env: 5, social: 4, join: 4, hit: 3, info: 3, move: 2, miss: 2 } as Record<string, number>)[k] ?? 0;
    const best = lines.reduce((x, y) => (rank(y.kind) > rank(x.kind) ? y : x));
    this.lastCaptionAt = c.logAt;
    this.onCaption?.(best.text, best.kind, this.quote);
    this.quote = null;
  }

  // ---- beats ---------------------------------------------------------------------------------------

  private start(c: Cue, next: Cue | undefined): Beat | null {
    switch (c.k) {
      case 'step': {
        const f = this.fx(c.u); if (!f) return null;
        const a = this.at(c.from), z = this.at(c.to);
        f.setFacing(Math.atan2(-(z.x - a.x), -(z.z - a.z)));
        f.setMoving(TUNE.moveSpeed); this.moving.add(c.u);
        const cont = next && next.k === 'step' && next.u === c.u;
        return { dur: 0.21, t: 0, tick: (_t, k) => f.root.position.lerpVectors(a, z, k), done: () => { if (!cont) { f.setMoving(0); this.moving.delete(c.u); } } };
      }
      case 'strike': {
        const f = this.fx(c.u), t = this.fx(c.t); if (!f || !t) return null;
        this.face(f, t.root.position);
        const clip = c.style === 'shove' ? 'Unarmed_Melee_Attack_Punch_A' : c.style === 'pommel' ? 'Unarmed_Melee_Attack_Punch_B'
          : c.style === 'power' ? '2H_Melee_Attack_Chop' : c.style === 'opportunity' ? '1H_Melee_Attack_Stab'
          : ['1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Slice_Horizontal'][this.clipIdx++ % 3];
        f.playClip(clip, { speed: 1.35 });
        const home = f.root.position.clone();
        const dir = t.root.position.clone().sub(home).setY(0).normalize();
        let hit = false;
        return {
          dur: c.style === 'power' ? 0.8 : 0.62, t: 0,
          tick: (tt) => {
            const lunge = Math.sin(Math.min(1, tt / 0.45) * Math.PI) * (c.style === 'shove' ? 0.55 : 0.35);
            f.root.position.copy(home).addScaledVector(dir, lunge);
            if (!hit && tt > 0.28) {
              hit = true;
              const chest = this.chest(t);
              if (c.res === 'miss') { t.playClip(['Dodge_Backward', 'Dodge_Left', 'Dodge_Right'][this.clipIdx % 3], { speed: 1.4 }); this.float(chest, c.style === 'shove' ? 'HOLDS' : 'MISS', '#c7d0d9', 34); }
              else {
                this.burst(chest, c.style === 'power' ? 0xffd27a : 0xfff1c9, c.style === 'power' ? 18 : 9, 2.6);
                if (c.style === 'power') this.ring(t.root.position, 0xffd27a, 2.2);
                if (c.crit) this.float(chest.clone().add(new THREE.Vector3(0, 0.5, 0)), 'CRITICAL!', '#ffd24a', 40);
                if (c.back) this.float(chest.clone().add(new THREE.Vector3(0, 0.9, 0)), 'from behind', '#f0c674', 26);
              }
            }
          },
          done: () => f.root.position.copy(home),
        };
      }
      case 'shot': {
        const f = this.fx(c.u), t = this.fx(c.t); if (!f || !t) return null;
        this.face(f, t.root.position);
        f.playClip(c.kind === 'arrow' ? '1H_Ranged_Shoot' : 'Spellcast_Shoot', { speed: 1.2 });
        const from = this.chest(f).add(new THREE.Vector3(0, 0.2, 0)), to = this.chest(t);
        if (c.res === 'miss') to.add(new THREE.Vector3(0.9, 0.6, 0.4));
        const proj = c.kind === 'arrow'
          ? new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.8, 5), new THREE.MeshBasicMaterial({ color: 0x6b4a2a }))
          : new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), new THREE.MeshBasicMaterial({ color: c.kind === 'frost' ? 0x9be7ff : 0xd9a8ff }));
        o3(proj).visible = false;
        this.scene.add(proj);
        const col = c.kind === 'frost' ? 0x9be7ff : c.kind === 'magic' ? 0xd9a8ff : 0xc9b08a;
        return {
          dur: 0.85, t: 0,
          tick: (tt) => {
            const k = (tt - 0.28) / 0.34;
            if (k < 0 || k > 1) { o3(proj).visible = false; return; }
            o3(proj).visible = true;
            const p = from.clone().lerp(to, k); p.y += Math.sin(k * Math.PI) * (c.kind === 'arrow' ? 0.5 : 0.15);
            if (c.kind === 'arrow') { o3(proj).lookAt(p.clone().add(to.clone().sub(from))); o3(proj).rotation.x += Math.PI / 2; }
            o3(proj).position.copy(p);
            if (c.kind !== 'arrow' && Math.random() < 0.7) this.particle(p, new THREE.Vector3(), col, 0.35, 0.35, 0);
          },
          done: () => {
            this.scene.remove(proj);
            if (c.res === 'hit') this.burst(to, col, 14, 3); else this.float(this.chest(t), 'MISS', '#c7d0d9', 34);
          },
        };
      }
      case 'intercept': {
        const f = this.fx(c.u); if (!f) return null;
        f.playClip('Block', { speed: 1.3 });
        this.float(this.head(f), '🛡', '#9ad0ff', 52);
        return { dur: 0.35, t: 0 };
      }
      case 'dmg': {
        const t = this.fx(c.t); const u = this.b.get(c.t); if (!t || !u) return null;
        const v = this.views.get(c.t)!;
        v.hp = c.hp;
        const col = c.how === 'fire' ? '#ffae4a' : c.res === 'blocked' ? '#9ad0ff' : '#ff6a5a';
        this.float(this.head(t), c.res === 'blocked' ? 'BLOCKED' : `-${Math.round(c.amt)}`, col, 46);
        if (c.how === 'fire') this.burst(this.chest(t), 0xff8a2a, 12, 2);
        if (c.how === 'collision' || c.how === 'crushed' || c.how === 'fall') this.dust(t.root.position, 10);
        if (c.res === 'dead') { v.gone = true; t.fxLock = false; t.playClip(this.clipIdx++ % 2 ? 'Death_B' : 'Death_A', { hold: true }); t.fxLock = true; }
        else if (c.res === 'down') { v.down = true; t.playClip('Lie_Down', { hold: true }); this.float(this.head(t).add(new THREE.Vector3(0, 0.5, 0)), 'DOWN', '#f0c674', 36); }
        else if (c.res === 'hit') t.playClip(c.how === 'blow' ? 'Hit_A' : 'Hit_B', { speed: 1.3 });
        else t.playClip('Block_Hit');
        return { dur: c.res === 'dead' ? 0.75 : 0.42, t: 0 };
      }
      case 'slide': {
        const f = this.fx(c.t); if (!f) return null;
        const a = this.at(c.from), z = this.at(c.to);
        if (!this.moving.has(c.t)) { f.playClip('Hit_B', { speed: 1.2 }); this.moving.add(c.t); }
        const cont = next && next.k === 'slide' && next.t === c.t;
        return { dur: 0.2, t: 0, tick: (_t, k) => { f.root.position.lerpVectors(a, z, k); if (Math.random() < 0.5) this.dust(f.root.position, 1); }, done: () => { if (!cont) this.moving.delete(c.t); } };
      }
      case 'bump': {
        const f = this.fx(c.t); if (!f) return null;
        const home = f.root.position.clone(), to = this.at(c.at);
        this.dust(home.clone().lerp(to, 0.5), 12);
        return { dur: 0.25, t: 0, tick: (_t, k) => f.root.position.copy(home).lerp(to, Math.sin(k * Math.PI) * 0.25), done: () => { f.root.position.copy(home); f.playClip('Lie_Down', { hold: true }); } };
      }
      case 'fall': {
        const f = this.fx(c.t); if (!f) return null;
        const y1 = f.root.position.y, y0 = y1 + 1.6;
        f.playClip('Jump_Idle');
        return { dur: 0.35, t: 0, tick: (_t, k) => { f.root.position.y = y0 + (y1 - y0) * k * k; }, done: () => { this.dust(f.root.position, 14); f.playClip('Lie_Down', { hold: true }); } };
      }
      case 'anim': {
        const f = this.fx(c.u); if (!f) return null;
        const d = f.playClip(c.clip, { speed: 1.3 });
        if (c.clip === 'Unarmed_Melee_Attack_Kick') this.dust(f.root.position, 4);
        return { dur: Math.min(0.75, d * 0.8 || 0.4), t: 0 };
      }
      case 'spill': {
        const from = this.at(c.from).add(new THREE.Vector3(0, 0.9, 0));
        for (const s of c.tiles) {
          const to = this.at(s);
          for (let i = 0; i < 6; i++) {
            const v = to.clone().sub(from).multiplyScalar(1.6).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 4 + Math.random() * 2, (Math.random() - 0.5) * 0.8));
            this.particle(from.clone(), v, 0xff7a1a, 0.26, 0.7, 9.5, true);
          }
        }
        return { dur: 0.6, t: 0 };
      }
      case 'throw': {
        const f = this.fx(c.u); if (!f) return null;
        const target = this.at(c.to);
        this.face(f, target);
        f.playClip('Throw', { speed: 1.3 });
        const from = this.head(f), to = target.clone().add(new THREE.Vector3(0, c.effect === 'miss' ? 0 : 0.9, 0));
        if (c.effect === 'miss') to.add(new THREE.Vector3(1.4, 0, 0.6));
        const col = ({ bucket: 0x5aa7d8, flour: 0xefe8d6, torch: 0xff8a2a, rocks: 0x8a8a86 } as Record<string, number>)[c.prop] ?? 0x8a6238;
        const proj = new THREE.Mesh(c.prop === 'rocks' ? new THREE.DodecahedronGeometry(0.2) : new THREE.BoxGeometry(0.35, 0.3, 0.3), new THREE.MeshLambertMaterial({ color: col }) as unknown as THREE.MeshBasicMaterial);
        o3(proj).visible = false; this.scene.add(proj);
        return {
          dur: 0.95, t: 0,
          tick: (tt) => {
            const k = (tt - 0.3) / 0.45;
            if (k < 0 || k > 1) { o3(proj).visible = false; return; }
            o3(proj).visible = true;
            const p = from.clone().lerp(to, k); p.y += Math.sin(k * Math.PI) * 1.8;
            o3(proj).position.copy(p); o3(proj).rotation.x = tt * 12; o3(proj).rotation.z = tt * 9;
            if (c.prop === 'torch') this.particle(p, new THREE.Vector3(0, 0.5, 0), 0xff8a2a, 0.3, 0.3, 0, true);
          },
          done: () => {
            this.scene.remove(proj);
            if (c.effect === 'splash') this.splash(to);
            else if (c.effect === 'cloud') this.cloud(to);
            else if (c.effect === 'fire') this.burst(to, 0xff8a2a, 26, 3.2, true);
            else this.dust(to, 10);
          },
        };
      }
      case 'fire': {
        const p = this.at(c.at);
        this.burst(p.add(new THREE.Vector3(0, 0.3, 0)), 0xff8a2a, c.oil ? 40 : 10, c.oil ? 5 : 2.2, true);
        if (c.oil) this.ring(this.at(c.at), 0xff8a2a, 3.5);
        return { dur: c.oil ? 0.5 : 0.07, t: 0 };
      }
      case 'douse': { this.splash(this.at(c.at).add(new THREE.Vector3(0, 0.4, 0))); return { dur: 0.35, t: 0 }; }
      case 'heal': {
        const t = this.fx(c.t); if (!t) return null;
        const v = this.views.get(c.t); if (v) v.hp = c.hp;
        for (let i = 0; i < 16; i++) this.particle(t.root.position.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.9, Math.random() * 0.8, (Math.random() - 0.5) * 0.9)), new THREE.Vector3(0, 1.4 + Math.random(), 0), 0x8fe39a, 0.2, 1.0, 0, true);
        this.float(this.head(t), `+${Math.round(c.amt)}`, '#8fe39a', 44);
        return { dur: 0.5, t: 0 };
      }
      case 'getup': {
        const t = this.fx(c.t); if (!t) return null;
        const v = this.views.get(c.t); if (v) v.down = false;
        t.playClip('Lie_StandUp', { speed: 1.4 });
        return { dur: 0.7, t: 0, done: () => t.endPose() };
      }
      case 'free': {
        const f = this.fx(c.u), t = this.fx(c.t); if (!f || !t) return null;
        f.playClip('Interact');
        return { dur: 0.9, t: 0, tick: (tt) => { if (tt > 0.35 && tt < 0.4) { this.burst(this.chest(t), 0xfff6d0, 12, 2); t.playClip('Cheer'); this.float(this.head(t), 'FREE!', '#8fe39a', 40); } } };
      }
      case 'tether': {
        const f = this.fx(c.u), t = this.fx(c.t); if (!f || !t) return null;
        f.playClip('Block', { speed: 1.2 });
        const a = this.chest(f), z = this.chest(t);
        const line = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, a.distanceTo(z), 6), new THREE.MeshBasicMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.8 }));
        o3(line).position.copy(a.clone().lerp(z, 0.5)); o3(line).lookAt(z); o3(line).rotation.x += Math.PI / 2;
        this.addMesh(line, 1.6, (k) => { ((line.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k)); });
        this.float(this.head(t), '🛡', '#9ad0ff', 50);
        return { dur: 0.5, t: 0 };
      }
      case 'stance': {
        const f = this.fx(c.u); if (!f) return null;
        if (c.what === 'guard') { f.holdLoop('Blocking'); this.ring(f.root.position, 0x7fc4ff, 1.3); }
        if (c.what === 'aim') { f.holdLoop('1H_Ranged_Aiming'); this.float(this.head(f), '👁', '#e8c879', 52); }
        if (c.what === 'ready') { f.holdLoop('2H_Melee_Idle'); this.float(this.head(f), '⏳ ready', '#e8c879', 36); }
        return { dur: 0.45, t: 0 };
      }
      case 'say': {
        const f = this.fx(c.u); if (!f) return null;
        const t = c.t != null ? this.fx(c.t) : null;
        if (t) this.face(f, t.root.position);
        f.playClip(c.react === 'kneel' ? 'Sit_Floor_Down' : c.react === 'rally' ? 'Cheer' : c.react === 'recoil' ? 'Block_Attack' : 'Interact', { hold: c.react === 'kneel' });
        const bubble = textSprite(c.text, { bubble: true, size: 30, weight: '600' });
        this.floats.push({ s: bubble, life: 0, max: 2.1, rise: 0, anchor: () => this.head(f), off: 0.9 });
        this.scene.add(bubble);
        let reacted = false;
        return {
          dur: 1.5, t: 0,
          tick: (tt) => {
            if (reacted || tt < 0.8) return;
            reacted = true;
            if (c.react === 'rally') this.ring(f.root.position, 0xffd27a, 4);
            if (!t) return;
            if (c.react === 'recoil') { t.playClip('Dodge_Backward'); this.float(this.head(t), '!', '#f0c674', 60); }
            else if (c.react === 'turn') { const back = t.root.position.clone().multiplyScalar(2).sub(f.root.position); this.face(t, back); this.float(this.head(t), '?', '#9ad0ff', 60); }
            else if (c.react === 'anger') { t.playClip('Cheer', { speed: 1.4 }); this.float(this.head(t), '💢', '#ff6a5a', 54); }
            else if (c.react === 'shrug') this.float(this.head(t), '…', '#c7d0d9', 60);
          },
        };
      }
      case 'coins': {
        const f = this.fx(c.u), t = this.fx(c.t); if (!f || !t) return null;
        const a = this.chest(t), z = this.chest(f);
        for (let i = 0; i < Math.min(12, 3 + Math.round(c.amt / 3)); i++) {
          const v = z.clone().sub(a).multiplyScalar(1.4).add(new THREE.Vector3((Math.random() - 0.5), 3.2 + Math.random(), (Math.random() - 0.5)));
          this.particle(a.clone(), v, 0xffd24a, 0.16, 0.75, 8, false);
        }
        this.float(this.head(f), `+${c.amt}g`, '#ffd24a', 40);
        return { dur: 0.7, t: 0 };
      }
      case 'yield': {
        const t = this.fx(c.t); if (!t) return null;
        const v = this.views.get(c.t); if (v) v.gone = true;
        t.playClip('Sit_Floor_Down', { hold: true });
        this.float(this.head(t), '🏳 yields', '#eef3f8', 38);
        return { dur: 0.8, t: 0 };
      }
      case 'escape': {
        const f = this.fx(c.u); if (!f) return null;
        const a = f.root.position.clone(), z = this.at(c.to);
        f.setFacing(Math.atan2(-(z.x - a.x), -(z.z - a.z))); f.setMoving(TUNE.moveSpeed * 2);
        const v = this.views.get(c.u); if (v) v.gone = true;
        return { dur: 0.8, t: 0, tick: (_t, k) => f.root.position.lerpVectors(a, z, k), done: () => { f.setMoving(0); f.root.visible = false; } };
      }
      case 'hew': {
        const fi = this.fx(c.u); if (!fi) return null;
        const at = this.at(c.at).add(new THREE.Vector3(0, 0.9, 0));
        this.face(fi, at);
        fi.playClip(this.clipIdx++ % 2 ? '1H_Melee_Attack_Chop' : '2H_Melee_Attack_Chop', { speed: 1.3 });
        let chipped = false;
        return { dur: 0.6, t: 0, tick: (tt) => {
          if (chipped || tt < 0.3) return; chipped = true;
          for (let i = 0; i < 12; i++) this.particle(at.clone(), new THREE.Vector3(Math.random() - 0.5, Math.random() * 1.2 + 0.4, Math.random() - 0.5).multiplyScalar(3), 0xc9a36a, 0.14, 0.6, 9);
          if (c.left > 0) this.float(at.clone().add(new THREE.Vector3(0, 1.4, 0)), `${Math.round((c.left / c.max) * 100)}%`, '#e8c879', 34);
        } };
      }
      case 'topple': {
        if (c.kind !== 'tree') { this.dust(this.at(c.at), 16); return { dur: 0.3, t: 0 }; }
        // a stand-in trunk swings down along the fall direction, then the log prop takes over
        const base = this.at(c.at);
        const g = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 2.2, 7), new THREE.MeshLambertMaterial({ color: 0x5a3e28 }) as unknown as THREE.MeshBasicMaterial);
        o3(trunk).position.set(0, 1.1, 0); (g as unknown as { add(o: unknown): void }).add(trunk);
        const crown = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 8), new THREE.MeshLambertMaterial({ color: 0x2f5e2f }) as unknown as THREE.MeshBasicMaterial);
        o3(crown).position.set(0, 2.8, 0); (g as unknown as { add(o: unknown): void }).add(crown);
        o3(g).position.copy(base);
        this.scene.add(g);
        const [dx, dz] = c.dir;
        return { dur: 0.9, t: 0,
          tick: (_t, k) => { const ang = (Math.PI / 2) * k * k; o3(g).rotation.x = dz * ang; o3(g).rotation.z = -dx * ang; },
          done: () => { this.scene.remove(g); this.dust(this.at({ x: c.at.x + dx, z: c.at.z + dz }), 22); this.dust(this.at({ x: c.at.x + 2 * dx, z: c.at.z + 2 * dz }), 14); this.ring(this.at({ x: c.at.x + dx, z: c.at.z + dz }), 0xb8a98c, 2.5); } };
      }
      case 'piece': {
        this.onPiece?.(c.id, c.dir);
        const p = this.at(c.at);
        let n = 0;
        return { dur: 1.1, t: 0, tick: (tt) => { if (n < 3 && tt > n * 0.3) { this.dust(p.clone().add(new THREE.Vector3(c.dir[0] * n * 2, 0, c.dir[1] * n * 2)), 18); n++; } } };
      }
      case 'icon': {
        const f = this.fx(c.u); if (!f) return null;
        this.float(this.head(f), c.icon === '!!' ? '!!' : c.icon, c.icon === '?' ? '#9ad0ff' : '#f0c674', 64);
        if (c.icon === '!!') f.playClip('Dodge_Backward');
        return { dur: 0.45, t: 0 };
      }
    }
    return null;
  }

  // ---- effects -----------------------------------------------------------------------------------

  private particle(p: THREE.Vector3, v: THREE.Vector3, color: number, size: number, life: number, g: number, add = false): void {
    if (this.parts.length > 700) return;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex(), color, transparent: true, depthWrite: false, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending }));
    o3(s).position.copy(p); o3(s).scale.set(size, size, 1); o3(s).renderOrder = 900;
    this.scene.add(s);
    this.parts.push({ s, v, life: 0, max: life, g, grow: 0, size, fade: true });
  }

  private burst(p: THREE.Vector3, color: number, n: number, speed: number, fire = false): void {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * (fire ? 1.4 : 0.8), Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      if (fire) v.y = Math.abs(v.y) + 1;
      this.particle(p.clone(), v, color, fire ? 0.45 : 0.22, fire ? 0.7 : 0.4, fire ? -1.5 : 4, true);
    }
  }

  private dust(p: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(2.2);
      const part = { p: p.clone().add(new THREE.Vector3(0, 0.15, 0)), v };
      this.particle(part.p, part.v, 0xb8a98c, 0.5, 0.8, 0.5);
      this.parts[this.parts.length - 1].grow = 0.9;
    }
  }

  private splash(p: THREE.Vector3): void {
    for (let i = 0; i < 26; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, 1 + Math.random() * 1.5, Math.random() - 0.5).multiplyScalar(3);
      this.particle(p.clone(), v, 0x6cc4ff, 0.2, 0.7, 9);
    }
    for (let i = 0; i < 6; i++) { this.particle(p.clone(), new THREE.Vector3((Math.random() - 0.5), 1.2, (Math.random() - 0.5)), 0xe6eef5, 0.6, 1.1, -0.5); this.parts[this.parts.length - 1].grow = 1.2; }
  }

  private cloud(p: THREE.Vector3): void {
    for (let i = 0; i < 40; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).multiplyScalar(3.4);
      this.particle(p.clone(), v, 0xf4f0e6, 0.9, 2.4, -0.2);
      this.parts[this.parts.length - 1].grow = 1.8;
    }
  }

  private ring(p: THREE.Vector3, color: number, r: number): void {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    o3(m).rotation.x = -Math.PI / 2; o3(m).position.copy(p).add(new THREE.Vector3(0, 0.12, 0));
    this.addMesh(m, 0.7, (k) => { o3(m).scale.set(0.3 + k * r, 0.3 + k * r, 1); (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k); });
  }

  private addMesh(o: THREE.Object3D, max: number, tick?: (k: number) => void): void { this.scene.add(o); this.meshes.push({ o, life: 0, max, tick }); }

  private float(p: THREE.Vector3, text: string, color: string, size: number): void {
    const s = textSprite(text, { color, size });
    o3(s).position.copy(p);
    this.scene.add(s);
    this.floats.push({ s, life: 0, max: 1.3, rise: 0.9, off: 0 });
  }

  private stepParticles(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]; p.life += dt;
      const s = o3(p.s);
      p.v.y -= p.g * dt; s.position.addScaledVector(p.v, dt);
      if (p.grow) { const k = p.size * (1 + p.grow * (p.life / p.max) * 2); s.scale.set(k, k, 1); }
      (p.s.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - p.life / p.max);
      if (p.life >= p.max) { this.scene.remove(p.s); this.parts.splice(i, 1); }
    }
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]; f.life += dt;
      const s = o3(f.s);
      if (f.anchor) s.position.copy(f.anchor()).add(new THREE.Vector3(0, f.off, 0));
      else s.position.y += f.rise * dt;
      const k = f.life / f.max;
      (f.s.material as THREE.SpriteMaterial).opacity = k < 0.8 ? 1 : Math.max(0, (1 - k) / 0.2);
      if (f.life >= f.max) { this.scene.remove(f.s); this.floats.splice(i, 1); }
    }
    for (let i = this.meshes.length - 1; i >= 0; i--) {
      const m = this.meshes[i]; m.life += dt;
      m.tick?.(Math.min(1, m.life / m.max));
      if (m.life >= m.max) { this.scene.remove(m.o); this.meshes.splice(i, 1); }
    }
  }

  // ---- geometry helpers ----------------------------------------------------------------------------

  private f(u: Unit): FighterFX | null { return (u.agent.fighter as unknown as FighterFX) ?? null; }
  private fx(id: Unit['id']): FighterFX | null { const u = this.b.get(id); return u ? this.f(u) : null; }
  private at(s: Spot): THREE.Vector3 {
    const t = this.b.map.tile(Math.max(0, Math.min(this.b.map.n - 1, s.x)), Math.max(0, Math.min(this.b.map.n - 1, s.z)));
    if (!t) return new THREE.Vector3();
    const off = (v: number, n: number) => (v < 0 ? v * 2 : v >= n ? (v - n + 1) * 2 : 0);   // off-map (an escape) keeps going
    return new THREE.Vector3(t.wx + off(s.x, this.b.map.n), this.b.map.surfaceY(t.x, t.z), t.wz + off(s.z, this.b.map.n));
  }
  private chest(f: FighterFX): THREE.Vector3 { return f.root.position.clone().add(new THREE.Vector3(0, (f.height || 1.8) * 0.6, 0)); }
  private head(f: FighterFX): THREE.Vector3 { return f.root.position.clone().add(new THREE.Vector3(0, (f.height || 1.8) + 0.9, 0)); }
  private face(f: FighterFX, p: THREE.Vector3): void { f.setFacing(Math.atan2(-(p.x - f.root.position.x), -(p.z - f.root.position.z))); }
}
