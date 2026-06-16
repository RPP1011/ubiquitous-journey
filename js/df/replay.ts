// Recorded-replay support for the DF observer. A replay is a COMPACT per-frame log of only what the
// ASCII view needs — quantised agent positions, faction/alive/party flags, goal/level/hp, plus the NEW
// chronicle/gazette events since the previous frame — with the static identity (names) + world (POIs)
// stored ONCE in a header. The N² belief layer is deliberately NOT logged (that's the multi-MB/s part);
// the look panel in a replay shows an agent's basics, and `view.ts`'s `mindLines` already degrades
// gracefully when the rich belief/memory fields are absent.
//
// Sizes are modest: ~5 KB/frame for ~300 agents ⇒ ~10 KB/s at 2 fps (~35 MB/hour). A `Recorder` captures
// from a live sim; a `ReplayPlayer` adapts a frame back into a sim-like object the view renders unchanged.

/* eslint-disable @typescript-eslint/no-explicit-any */

const FACTIONS_ORDER = ['townsfolk', 'monster', 'raider', 'watch'];
const F_ALIVE = 1 << 4;
const F_PARTY = 1 << 5;

export interface ReplayDoc {
  v: number;
  meta: { seed: number; sampleHz: number };
  goals: string[]; // interned goal-kind dictionary (frame `gl` indexes into this)
  ids: { id: any; name: string; faction: string; profession: string | null }[];
  pois: [string, number, number][]; // [kind, x, z]
  frames: ReplayFrame[];
}

export interface ReplayFrame {
  t: number;
  qx: number[];
  qz: number[];
  fl: number[]; // faction index (low nibble) | F_ALIVE | F_PARTY
  gl: number[]; // goal dictionary index
  lv: number[];
  hp: number[];
  beats: string[]; // NEW chronicle texts since the previous frame
  news: string[]; // NEW gazette headlines since the previous frame
}

/** Captures replay frames from a LIVE sim at a chosen sample rate. */
export class Recorder {
  doc: ReplayDoc;
  private _goalIdx = new Map<string, number>();
  private _lastBeatId = -Infinity;
  private _lastNewsId = -Infinity;
  private _interval: number;
  private _nextAt = 0;

  constructor(sim: any, opts: { seed?: number; sampleHz?: number } = {}) {
    const sampleHz = opts.sampleHz || 2;
    this._interval = 1 / sampleHz;
    this.doc = {
      v: 1,
      meta: { seed: opts.seed || 0, sampleHz },
      goals: [],
      ids: (sim.agents || []).map((a: any) => ({
        id: a.id,
        name: a.name,
        faction: a.faction,
        profession: a.profession || null,
      })),
      pois: ((sim.world && sim.world.pois) || []).map((p: any) => [p.kind, Math.round(p.pos.x), Math.round(p.pos.z)] as [string, number, number]),
      frames: [],
    };
  }

  private _goal(kind: string | undefined): number {
    if (!kind) return 0;
    let i = this._goalIdx.get(kind);
    if (i === undefined) {
      i = this.doc.goals.length;
      this.doc.goals.push(kind);
      this._goalIdx.set(kind, i);
    }
    return i;
  }

  /** Capture a frame iff the sample interval has elapsed (call every sim step with `sim.time`). */
  maybeCapture(sim: any): void {
    if ((sim.time || 0) < this._nextAt) return;
    this._nextAt = (sim.time || 0) + this._interval;
    this.capture(sim);
  }

  /** Force-capture a frame now. */
  capture(sim: any): void {
    const party = new Set<any>();
    const members = sim.party && (sim.party.members || sim.party.companions);
    if (Array.isArray(members)) for (const m of members) party.add(m.id != null ? m.id : m);

    const qx: number[] = [];
    const qz: number[] = [];
    const fl: number[] = [];
    const gl: number[] = [];
    const lv: number[] = [];
    const hp: number[] = [];
    for (const meta of this.doc.ids) {
      const a = sim.agentsById ? sim.agentsById.get(meta.id) : null;
      if (!a || !a.pos) {
        qx.push(0);
        qz.push(0);
        fl.push(0); // not alive
        gl.push(0);
        lv.push(0);
        hp.push(0);
        continue;
      }
      qx.push(Math.round(a.pos.x));
      qz.push(Math.round(a.pos.z));
      const f = Math.max(0, FACTIONS_ORDER.indexOf(a.faction)) | (a.alive ? F_ALIVE : 0) | (party.has(a.id) ? F_PARTY : 0);
      fl.push(f);
      gl.push(this._goal(a.goal && a.goal.kind));
      lv.push((a.progression && a.progression.totalLevel) | 0);
      hp.push(Math.round((a.fighter && a.fighter.health) || 0));
    }

    // only the chronicle/gazette events NEW since the last captured frame (cheap, append-only).
    const beats = this._newTexts(sim.chronicle, (b: any) => b.text, (b: any) => b.id, '_lastBeatId');
    const news = this._newTexts(sim.gazette, (a: any) => a.headline, (a: any) => a.id, '_lastNewsId');

    this.doc.frames.push({ t: Math.round((sim.time || 0) * 10) / 10, qx, qz, fl, gl, lv, hp, beats, news });
  }

  private _newTexts(src: any, textOf: (x: any) => string, idOf: (x: any) => number, lastKey: '_lastBeatId' | '_lastNewsId'): string[] {
    if (!src || !src.recent) return [];
    const items: any[] = src.recent(40); // newest-first
    const out: string[] = [];
    let maxId = (this as any)[lastKey];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const id = idOf(it);
      if (id > (this as any)[lastKey]) {
        const t = textOf(it);
        if (t) out.push(t);
        if (id > maxId) maxId = id;
      }
    }
    (this as any)[lastKey] = maxId;
    return out;
  }

  toJSON(): string {
    return JSON.stringify(this.doc);
  }
}

// ── playback ──────────────────────────────────────────────────────────────────────────────────

/** Plays a recorded `ReplayDoc`, exposing a sim-like object the view renders without modification. */
export class ReplayPlayer {
  doc: ReplayDoc;
  i = 0; // current frame index
  private _pois: any[];

  constructor(doc: ReplayDoc) {
    this.doc = doc;
    this._pois = doc.pois.map(([kind, x, z]) => ({ kind, pos: { x, z } }));
  }

  get length(): number {
    return this.doc.frames.length;
  }
  get time(): number {
    return this.doc.frames.length ? this.doc.frames[Math.min(this.i, this.length - 1)].t : 0;
  }

  seek(i: number): void {
    this.i = Math.max(0, Math.min(this.length - 1, i | 0));
  }
  step(d: number): void {
    this.seek(this.i + d);
  }

  /** Build the sim-like read surface for the CURRENT frame (the same shape `view.ts` reads). */
  sim(): any {
    const fr = this.doc.frames[Math.min(this.i, this.length - 1)];
    const ids = this.doc.ids;
    const agents: any[] = [];
    const byId = new Map<any, any>();
    const party: any[] = [];
    if (fr) {
      for (let k = 0; k < ids.length; k++) {
        const f = fr.fl[k];
        const alive = (f & F_ALIVE) !== 0;
        const a = {
          id: ids[k].id,
          name: ids[k].name,
          faction: FACTIONS_ORDER[f & 0x0f] || 'townsfolk',
          profession: ids[k].profession,
          alive,
          pos: { x: fr.qx[k], z: fr.qz[k] },
          goal: { kind: this.doc.goals[fr.gl[k]] || '—' },
          progression: { totalLevel: fr.lv[k] },
          fighter: { health: fr.hp[k] },
        };
        agents.push(a);
        byId.set(a.id, a);
        if (f & F_PARTY) party.push(a);
      }
    }
    // accumulate the chronicle/gazette up to (and including) the current frame.
    const beats = this._accum((f) => f.beats);
    const news = this._accum((f) => f.news);
    return {
      time: this.time,
      agents,
      agentsById: byId,
      world: { pois: this._pois },
      percepts: [],
      player: null,
      party: { members: party },
      chronicle: { recent: (n: number) => beats.slice(-n).reverse().map((text) => ({ text })) },
      gazette: { recent: (n: number) => news.slice(-n).reverse().map((headline) => ({ headline })) },
    };
  }

  private _accum(pick: (f: ReplayFrame) => string[]): string[] {
    const out: string[] = [];
    for (let k = 0; k <= this.i && k < this.length; k++) {
      const arr = pick(this.doc.frames[k]);
      if (arr && arr.length) out.push(...arr);
    }
    return out;
  }
}
