// CHRONICLE — the world's live drama feed (drama-plan §5). Subscribes to the
// shared RPG event bus (mirror of xpstats/econstats) and distils the deed
// FIREHOSE down to the handful of NOTABLE beats that read like a war chronicle:
// kills/deaths, vendettas declared, a prodigy rising (class-ups / milestone
// levels), big windfalls, plus raids (Director) and births/mentorship (Lineage)
// sampled from their counters since neither emits on the bus.
//
// Every beat is timestamped (sim-seconds) and phrased with agent NAMES. Stored
// in a BOUNDED ring buffer (CHRONICLE.cap) so memory never grows. Pure capture:
// it reads agent/sim state READ-ONLY and never influences behaviour, so it is
// safe on the fixed tick. Every entry point is guarded and NEVER throws.
//
// The UI reads it via chronicle.recent(n). Phrasing mirrors test/history.mjs's
// war-chronicle voice (names + a terse, past-tense beat).

import { bus } from '../rpg/events.js';
import { CHRONICLE, MONSTER, factionHostile } from './simconfig.js';
import { noteBeat } from './signals.js';
import { characterByname } from './biography.js';
import type { ActionEvent } from '../../types/sim.js';

// `sim` is the owning Simulation (a separate, wave-2 cluster still in .js); typed opaquely
// on purpose — this module reads its drama/agent state read-only and is fully guarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;

// one chronicle beat in the rolling ring (a FILE-LOCAL shape — the UI reads these via
// recent()/legends(); distinct from the shared news Beat, which the gazette uses).
interface ChronicleBeat {
  id: number;
  t: number;
  kind: string;
  text: string;
  arcId: string | null;
  arcTitle: string | null;
}

// an optional arc binding threaded onto a beat (set-up → escalation → climax grouping).
interface ArcRef { id?: string | null; title?: string | null; }

// event KINDS the UI colour-codes by. Keep these stable (the panel keys off them).
export const BEAT = {
  DEATH: 'death',         // a townsperson/monster slain (NPC<->NPC or by/of the player)
  KILL: 'kill',           // framed from the slayer's side when notable (renown)
  VENDETTA: 'vendetta',   // a witness swears revenge on a killer
  PRODIGY: 'prodigy',     // a class gained or a milestone level crossed (rising)
  FORTUNE: 'fortune',     // a big windfall (sale / looted purse / payment)
  RAID: 'raid',           // a Director raid wave arrives
  BIRTH: 'birth',         // a Lineage birth
  MENTOR: 'mentor',       // a Lineage apprenticeship/mentorship bond
  FAITH: 'faith',         // a god rises/dwindles or a prophet is anointed (Small Gods)
  WATCH: 'watch',         // the Night Watch — founded, a new captain, a watchman falls
  PATRICIAN: 'patrician', // the Patrician brokered a peace (Vetinari)
  LEGEND: 'legend',       // a hero is hailed or a foe becomes a dread nemesis (epithets)
  UNION: 'union',         // a marriage — a wedding / a cross-House alliance (romance)
  MIGRATION: 'migration', // a townsperson uproots for a sparser town (the emigration valve)
  BUILD: 'build',         // a building raised — a home founded, a tavern, the town grows
  // emergent-arc beats (docs/architecture/12) — the registry files these on open/round/close.
  RUIN: 'ruin',           // an agent's fortunes collapse (fall-from-grace; the status sensor)
  SHUNNED: 'shunned',     // the town turns cold toward an agent (the slander beat)
  RETIRE: 'retire',       // a burned veteran gives up the venture (burnedVeteran arc)
  RISE: 'rise',           // an agent climbs (rags-to-riches accrual / a wealth recognition)
  MUSTER: 'muster',       // a warband forms and marches (recruiter assault arc)
  RESCUE: 'rescue',       // a captive is freed (affect rescue arc)
};

export class Chronicle {
  sim: Sim;
  _ring: ChronicleBeat[];
  _legends: ChronicleBeat[];
  _seq: number;
  _dedupe: Map<string, number>;
  _lastPoll: number;
  _raidsSeen: number;
  _birthsSeen: number;
  _apprSeen: number;
  _off: (() => void) | null;

  constructor(sim: Sim) {
    this.sim = sim;
    this._ring = [];          // bounded ring of beats (most-recent appended last)
    this._legends = [];       // the SAGA: only the momentous beats, kept far longer than
                              // the rolling feed so the world accumulates a remembered history
    this._seq = 0;            // monotonic id so the UI can detect new entries cheaply
    this._dedupe = new Map(); // `${kind}:${subjectId}` -> last sim-time logged
    // counter baselines for the poll-based sources (Director/Lineage tallies).
    this._lastPoll = -Infinity;
    this._raidsSeen = this._dirRaids();
    this._birthsSeen = this._linBirths();
    this._apprSeen = this._linApprentices();
    // subscribe to the shared bus exactly like xpstats/econstats do. Keep the
    // unsubscribe handle so Simulation.dispose() can detach us (no listener stack).
    this._off = bus.on((ev) => this._onEvent(ev));
  }

  dispose(): void { if (this._off) { this._off(); this._off = null; } }

  // ---- public read API (UI) ------------------------------------------------
  // newest-first shallow copy so callers can't mutate the ring.
  recent(n: number = CHRONICLE.cap): ChronicleBeat[] {
    const k = Math.max(0, Math.min(n | 0 || CHRONICLE.cap, this._ring.length));
    const out = this._ring.slice(this._ring.length - k);
    out.reverse();
    return out;
  }

  count(): number { return this._ring.length; }

  // public: record a custom beat (e.g. a seeded narrative premise). Guarded +
  // de-duplicated exactly like the internal captures. `arc` (optional `{id,title}`)
  // ties this beat to a multi-beat STORY so the feed can group its chapters — see
  // the Director's arcs (the betrayal and the duel that answers it read as one tale).
  note(kind: string, subjectId: unknown, text: string, arc?: ArcRef): void { this._push(kind || 'note', subjectId, text, arc); }

  // ---- capture -------------------------------------------------------------
  _nameOf(id: unknown): string {
    if (id == null) return 'someone';
    try {
      const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(id);
      return (a && a.name) || 'someone';
    } catch { return 'someone'; }
  }

  _now(): number { try { return (this.sim && this.sim.time) || 0; } catch { return 0; } }

  // a name dressed with the agent's STANDING character byname for the SAGA voice — "Garrik,
  // the Tight-Fisted". Observer-layer narration coined from personality (characterByname is
  // guarded + reads nothing live to decide). Falls back to the bare name. Guarded.
  _legendName(id: unknown): string {
    const name = this._nameOf(id);
    try {
      const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(id);
      const byname = a ? characterByname(a) : null;
      if (byname && name !== 'someone') return `${name}, ${byname}`;
    } catch { /* fall through to bare name */ }
    return name;
  }

  // push a beat onto the ring, de-duplicated per (kind, subject) within a short
  // window so a flurry of identical events collapses to one entry. Guarded.
  _push(kind: string, subjectId: unknown, text: string, arc?: ArcRef): void {
    try {
      if (!text) return;
      const t = this._now();
      const key = kind + ':' + subjectId;
      const last = this._dedupe.get(key);
      if (last != null && (t - last) < (CHRONICLE.dedupeSecs || 0)) return;
      this._dedupe.set(key, t);
      // §13 F.quietIndex — stamp this subject's last-beat time (the forgotten-man clock resets when an
      // agent appears in the feed). Town-level on the sim; guarded inside; observer-only.
      noteBeat(this.sim, subjectId, t);
      // arc binding: a beat that belongs to a tracked story carries its id + title so
      // the UI can thread the chapters together (set-up → escalation → climax).
      const arcId = (arc && arc.id) || null;
      const arcTitle = (arc && arc.title) || null;
      const beat = { id: ++this._seq, t, kind, text, arcId, arcTitle };
      this._ring.push(beat);
      const cap = CHRONICLE.cap || 80;
      while (this._ring.length > cap) this._ring.shift();
      // archive the momentous beats into the SAGA (a separate, longer ledger that
      // the rolling feed's churn never evicts — the town's lasting history).
      if (this._legendary(kind, text)) {
        this._legends.push({ ...beat });
        const lcap = CHRONICLE.legendCap || 120;
        while (this._legends.length > lcap) this._legends.shift();
      }
    } catch { /* never throw on the tick */ }
  }

  // which beats are SAGA-worthy: heroes & nemeses (legend), a god's rise/fall, a
  // student surpassing a master, a vendetta fulfilled, the Watch founded, and a
  // prodigy reaching a high tier. The everyday feed keeps everything; this is what
  // the town REMEMBERS a year on.
  _legendary(kind: string, text: string): boolean {
    if (kind === BEAT.LEGEND) return true;                          // heroes hailed / nemeses risen & felled
    if (kind === BEAT.FAITH && /great god|small god/.test(text)) return true;
    if (kind === BEAT.MENTOR && /surpassed|outstripped/.test(text)) return true;
    if (kind === BEAT.VENDETTA && /avenged .* by slaying/.test(text)) return true;
    if (kind === BEAT.WATCH && /founded the/.test(text)) return true;
    if (kind === BEAT.PRODIGY && /reached level (20|25|30)\b/.test(text)) return true;
    if (kind === BEAT.UNION && /uniting Houses/.test(text)) return true;   // a marriage alliance endures
    if (kind === BEAT.BUILD && /tavern/.test(text)) return true;           // the town raising its first hearth is a milestone
    return false;
  }

  // public: the saga, newest-first (the UI's "Legends" view).
  legends(n: number = 60): ChronicleBeat[] {
    const k = Math.max(0, Math.min(n | 0 || 60, this._legends.length));
    return this._legends.slice(this._legends.length - k).reverse();
  }

  // route a bus ActionEvent to a beat — only the story-worthy ones. Guarded so a
  // malformed event can never break the loop (one bad subscriber must not freeze).
  _onEvent(ev: ActionEvent): void {
    try {
      if (!ev || !ev.verb) return;
      switch (ev.verb) {
        case 'kill': this._onKill(ev); break;
        case 'class_gained': this._onClassGained(ev); break;
        case 'level': this._onLevel(ev); break;
        case 'sell': case 'buy': this._onWindfall(ev); break;
        default: break;   // the firehose (strike/block/buy/goto/produce/...) is filtered out
      }
    } catch { /* never throw */ }
  }

  _isMonster(id: unknown): boolean {
    try {
      const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(id);
      return !!a && a.faction === MONSTER.faction;
    } catch { return false; }
  }

  // a lethal blow. Frame it from the fallen's side (a death) — and, when the
  // slain was no monster, note the slayer (a darker beat). Vendettas are derived
  // from the witnesses below (a liked friend murdered -> someone will avenge).
  _onKill(ev: ActionEvent): void {
    const slayer = this._nameOf(ev.actorId);
    const slain = this._nameOf(ev.targetId);
    if (this._isMonster(ev.targetId)) {
      // slaying a monster is a renown beat (heroic), keyed off the slayer
      this._push(BEAT.KILL, ev.actorId, `${slayer} cut down ${slain}.`);
    } else if (this._townsfolkSlaysHostile(ev.actorId, ev.targetId)) {
      // A TOWNSPERSON SLEW A TOWN-HOSTILE (a raider/rival in the town's defence) — a HEROIC beat keyed
      // off the DEFENDER, so ordinary townsfolk who hold the line are NAMED + remembered, not just
      // churned as a transient death of the raider (life-trace finding: rank-and-file defenders were invisible).
      this._push(BEAT.KILL, ev.actorId, `${slayer} cut down ${slain}, defending the town.`);
    } else {
      // a townsperson fell — the gravest beat, keyed off the fallen
      this._push(BEAT.DEATH, ev.targetId, `${slain} was slain by ${slayer}.`);
      this._noteVendetta(ev.actorId, ev.targetId);
    }
  }

  // is `actorId` a townsperson and `targetId` a faction the town is hostile to (raider/rival/bandit)?
  _townsfolkSlaysHostile(actorId: unknown, targetId: unknown): boolean {
    try {
      const A = this.sim && this.sim.agentsById && this.sim.agentsById.get(actorId);
      const T = this.sim && this.sim.agentsById && this.sim.agentsById.get(targetId);
      return !!(A && T && A.faction === 'townsfolk' && T.faction !== 'townsfolk' && factionHostile('townsfolk', T.faction));
    } catch { return false; }
  }

  // a witness who thought well of the fallen turns against the killer — read
  // belief state READ-ONLY to phrase a vendetta (the witness "swears revenge").
  // We surface at most ONE per kill (the most-aggrieved) so it stays a beat, not spam.
  _noteVendetta(killerId: unknown, fallenId: unknown): void {
    try {
      const sim = this.sim;
      const agents = (sim && sim.agents) || [];
      let best = null, bestLiked = 0.3;   // only avengers who genuinely liked the fallen
      for (const w of agents) {
        if (!w || !w.alive || w.controlled) continue;
        if (w.id === killerId || w.id === fallenId) continue;
        const b = w.beliefs && w.beliefs.get(killerId);
        if (!b || !b.hostile) continue;           // they latched the killer hostile (a real vendetta)
        const lb = w.beliefs.get(fallenId);
        const liked = Math.max(0, (lb && lb.standing) || 0);
        if (liked > bestLiked) { bestLiked = liked; best = w; }
      }
      if (best) {
        this._push(BEAT.VENDETTA, best.id,
          `${best.name} swore vengeance on ${this._nameOf(killerId)} for ${this._nameOf(fallenId)}.`);
      }
    } catch { /* never throw */ }
  }

  // a brand-new class emerged for an agent — a calling found (the prodigy rising).
  _onClassGained(ev: ActionEvent): void {
    try {
      const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(ev.actorId);
      if (!a || a.controlled) return;
      const cls = a.progression && a.progression.primaryClass();
      const cname = (cls && cls.name) || 'a new calling';
      this._push(BEAT.PRODIGY, ev.actorId, `${this._legendName(ev.actorId)} rose as ${cname}.`);
    } catch { /* never throw */ }
  }

  // a level-up — only chronicle when it CROSSES a milestone level (the prodigy
  // ascending), not every routine tick of XP.
  _onLevel(ev: ActionEvent): void {
    try {
      const lvl = Math.round(ev.magnitude || 0);
      const marks = CHRONICLE.levelMarks || [];
      if (!marks.includes(lvl)) return;
      const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(ev.actorId);
      if (!a || a.controlled) return;
      const cls = a.progression && a.progression.primaryClass();
      const cname = (cls && cls.name) || 'their craft';
      this._push(BEAT.PRODIGY, ev.actorId, `${this._legendName(ev.actorId)} reached level ${lvl} as ${cname}.`);
    } catch { /* never throw */ }
  }

  // an exceptionally shrewd deal — a coup at the market. buy/sell carry a profit/
  // bargain RATIO in magnitude (1 + margin over the agent's price belief), so a
  // big margin is a fortune made (drove a hard bargain), not a routine trade.
  _onWindfall(ev: ActionEvent): void {
    try {
      const margin = (ev.magnitude || 0) - 1;
      if (margin < (CHRONICLE.windfallMargin ?? Infinity)) return;
      const who = this._nameOf(ev.actorId);
      const pct = Math.round(margin * 100);
      const how = ev.verb === 'buy' ? `snapped up a bargain (${pct}% under)` : `made a killing (${pct}% over)`;
      this._push(BEAT.FORTUNE, ev.actorId, `${who} ${how} at the market.`);
    } catch { /* never throw */ }
  }

  // ---- poll-based sources (Director / Lineage expose COUNTERS, not bus events) --
  _dirRaids(): number { try { return (this.sim.director && this.sim.director.stats && this.sim.director.stats.raids) || 0; } catch { return 0; } }
  _linBirths(): number { try { return (this.sim.lineage && this.sim.lineage.births) || 0; } catch { return 0; } }
  _linApprentices(): number { try { return (this.sim.lineage && this.sim.lineage.apprenticeships) || 0; } catch { return 0; } }

  // Called from Simulation's fixed tick. Samples the Director/Lineage tallies and
  // logs a beat for each new raid/birth/mentorship since last poll. Degrades
  // gracefully if either subsystem is absent (the seam moved / not wired). Guarded.
  tick(): void {
    try {
      const t = this._now();
      if (t - this._lastPoll < (CHRONICLE.pollSecs || 0)) return;
      this._lastPoll = t;

      const raids = this._dirRaids();
      if (raids > this._raidsSeen) {
        const n = raids - this._raidsSeen;
        this._raidsSeen = raids;
        const spawned = (() => { try { return this.sim.director.stats.spawned; } catch { return 0; } })();
        this._push(BEAT.RAID, -1,
          n > 1 ? `${n} raids fell upon the town.` : `Raiders fell upon the town${spawned ? '' : ''}.`);
      }

      const births = this._linBirths();
      if (births > this._birthsSeen) {
        const n = births - this._birthsSeen;
        this._birthsSeen = births;
        this._push(BEAT.BIRTH, -2, n > 1 ? `${n} children were born to the town.` : `A child was born to the town.`);
      }

      // routine apprenticeships are TOO frequent to chronicle (they'd drown the feed) —
      // the story-worthy mentorship beat is the director's rival-apprentices contest.
      // We just keep the counter current so a future notable hook could read it.
      this._apprSeen = this._linApprentices();
    } catch { /* never throw on the tick */ }
  }
}
