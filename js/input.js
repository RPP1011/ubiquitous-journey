// Input: pointer-lock mouse look, keyboard movement, and the Mount&Blade-style
// "flick the mouse to choose a swing direction while a combat button is held".

import { DIR } from './constants.js';

const PICK_THRESHOLD = 7;     // px of accumulated movement before a direction sticks

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.locked = false;

    this.lmb = false;          // attack button held
    this.rmb = false;          // block button held

    this.lookDX = 0;           // unconsumed camera look delta
    this.lookDY = 0;

    this._accX = 0;            // accumulated mouse delta since combat button pressed
    this._accY = 0;
    this.dir = DIR.UP;         // current chosen combat direction

    this.onLockChange = null;  // optional callback(boolean)

    this._bind();
  }

  get anyCombat() { return this.lmb || this.rmb; }

  _bind() {
    const c = this.canvas;

    // NOTE: pointer-lock is intentionally NOT requested here anymore. The game is
    // point-and-click (see commander.js) and needs a visible cursor; clicks are
    // handled by the Commander. These lock-aware handlers stay only so the old
    // mouse-look/M&B path is inert rather than removed wholesale.
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === c;
      // This is a point-and-click game now: we never want the pointer locked. If
      // anything ever engages it, release it immediately so the cursor stays free.
      if (this.locked) { document.exitPointerLock(); return; }
      this.lmb = this.rmb = false; this.keys.clear();
      if (this.onLockChange) this.onLockChange(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      if (this.anyCombat) {
        this._accX += dx; this._accY += dy;
        this._recomputeDir();
      } else {
        this.lookDX += dx; this.lookDY += dy;
      }
    });

    c.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.lmb = true; this._resetPick(); }
      else if (e.button === 2) { this.rmb = true; this._resetPick(); }
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      else if (e.button === 2) this.rmb = false;
    });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }

  _resetPick() { this._accX = 0; this._accY = 0; }

  _recomputeDir() {
    if (Math.abs(this._accX) < PICK_THRESHOLD && Math.abs(this._accY) < PICK_THRESHOLD) return;
    // Swing follows the drag direction: the blade comes from the side you pull
    // toward, so the chosen direction is the negated mouse-delta axis.
    if (Math.abs(this._accX) > Math.abs(this._accY)) {
      this.dir = this._accX > 0 ? DIR.LEFT : DIR.RIGHT;
    } else {
      this.dir = this._accY > 0 ? DIR.UP : DIR.DOWN;
    }
  }

  consumeLook() {
    const d = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0; this.lookDY = 0;
    return d;
  }

  has(code) { return this.keys.has(code); }

  // movement axis in camera space: x = strafe (A/D), z = forward (W/S)
  moveAxis() {
    let x = 0, z = 0;
    if (this.has('KeyW')) z -= 1;
    if (this.has('KeyS')) z += 1;
    if (this.has('KeyA')) x -= 1;
    if (this.has('KeyD')) x += 1;
    return { x, z };
  }

  get running() { return this.has('ShiftLeft') || this.has('ShiftRight'); }
}
