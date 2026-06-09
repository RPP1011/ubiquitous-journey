// DialogueSession: a conversation with one NPC, generated entirely from that
// NPC's LIVE state — its loudest rumour about a third party, what it wants to
// trade (needs/inventory), any standing market offer, plus the social verbs
// [Persuade] / [Intimidate] / [Leave]. Pure logic, no DOM: the view layer reads
// options() and calls choose(id). Choices mutate the NPC's beliefs (standing,
// planted rumours) so a conversation actually changes the social sim.

import { COMMODITIES, FACTIONS, SOURCE } from '../sim/simconfig.js';
import { provenanceLabel } from '../sim/beliefs.js';
import type { Agent, BeliefState, EntityId } from '../../types/sim.js';

// simulation.js is a later cluster — typed as the minimal read surface used here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any; /* Simulation — ported in a later cluster */

/** A resolved dialogue line + its tonal colour. */
export type Tone = 'good' | 'bad' | 'neutral';
export interface DialogueResult { text: string; tone: Tone; }

/** A standing offer pinned on an NPC by the quest board / market. */
interface OpenOffer {
  label?: string;
  acceptText?: string;
  onAccept?: (player: Agent | null, npc: Agent, sim: Sim | null) => void;
  [k: string]: unknown;
}

/** One offered conversation option. */
export interface DialogueOption {
  id: string;
  label: string;
  kind: string;
  _want?: { commodity: string; qty: number };
}

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

// pull a 0..1 skill level off the player's progression (if the RPG layer is
// wired in) — e.g. the highest level among "social" tagged classes. Falls back
// to a flat baseline so dialogue works before progression exists.
function playerSkill(player: Agent | null, _kind: string): number {
  const prog = player && player.progression;
  if (!prog || !prog.topClasses) return 0.25;
  let best = 0;
  for (const c of prog.topClasses(5)) {
    // normalise a class level (cap-100 system) to 0..1 as a rough skill proxy
    const lvl = (c.level || 0) / 100;
    best = Math.max(best, lvl);
  }
  // a kind-specific nudge if a class name hints at the verb (Orator/Brute, etc.)
  return clamp(best, 0, 1);
}

export class DialogueSession {
  npc: Agent;
  player: Agent | null;
  sim: Sim | null;
  over: boolean;
  lastResult: DialogueResult | null;
  _revealed: boolean;
  _opts: DialogueOption[];

  constructor(npc: Agent, player: Agent | null, sim: Sim | null) {
    this.npc = npc;
    this.player = player;
    this.sim = sim;
    this.over = false;
    this.lastResult = null;          // {text, tone:'good'|'bad'|'neutral'} of last choice
    this._revealed = false;          // has the NPC spilled its rumour yet?
    this._opts = [];                 // cached option list for the current turn
  }

  // --- the NPC's current opinion of the player (drives greeting + check DC) ---
  // Reads the NPC's belief about the player: standing (-1..1) and hostility.
  _beliefOfPlayer(): BeliefState | null {
    const pid = this.player ? this.player.id : null;
    if (pid == null || !this.npc.beliefs) return null;
    return this.npc.beliefs.get(pid);
  }

  standing(): number {
    const b = this._beliefOfPlayer();
    return b ? b.standing : 0;
  }

  // greeting text tinted by how the NPC feels about the player
  greeting(): string {
    const s = this.standing();
    const name = this.npc.name;
    if (this.npc.mood && this.npc.mood.fear > 0.3) return `${name} eyes you warily.`;
    if (s > 0.35) return `${name} greets you warmly. "Good to see a friendly face."`;
    if (s < -0.35) return `${name} scowls. "What do you want?"`;
    if (s < -0.1) return `${name} regards you coolly.`;
    return `${name} nods. "Yes?"`;
  }

  // --- LLM persona surface (OPTIONAL; see js/ai/llm.js) -----------------------
  // Build a plain, dependency-free description of THIS NPC for the language model
  // to speak as — drawn from the NPC's beliefs + state, never omniscient world
  // truth (the epistemic split). Returns a plain object the llm client consumes.
  // Pure read; mutates nothing. Used only when the LLM feature flag is ON; when
  // OFF this is never called and the templated greeting() above is authoritative.
  llmPersona(situation: string | null): Record<string, unknown> {
    const npc = this.npc;
    const s = this.standing();
    const P = npc.personality || {};

    // disposition toward the player, as a phrase (from the NPC's belief)
    const b = this._beliefOfPlayer();
    let aboutPlayer: string;
    if (npc.mood && npc.mood.fear > 0.3) aboutPlayer = 'wary and a little afraid of them';
    else if (b && b.hostile) aboutPlayer = 'you consider them an enemy';
    else if (s > 0.35) aboutPlayer = 'you like and trust them';
    else if (s < -0.35) aboutPlayer = 'you dislike and distrust them';
    else if (s < -0.1) aboutPlayer = 'you regard them coolly, unsure';
    else aboutPlayer = 'a stranger you have no strong feelings about';
    if (b && b.suspicion > 0.4) aboutPlayer += ', and something about them seems off';

    // top rumour about a third party, in the NPC's own (possibly wrong) words
    const rum = this._topRumour();
    let rumour: string | null = null;
    if (rum) {
      const subj = this._subjectName(rum.subjectId);
      let claim: string;
      if (rum.hostile) claim = `${subj} is bad business, best avoided`;
      else if (rum.standing < -0.1) claim = `${subj} is not much to be trusted`;
      else if (rum.standing > 0.1) claim = `${subj} is solid, good people`;
      else claim = `${subj} keeps to themselves`;
      // hedge by provenance: a thing seen first-hand is stated plainly; a thing only
      // HEARD is repeated as the garbled hearsay it is ("word has it, thirdhand, …").
      rumour = (rum.hops || 0) >= 1 ? `word has it — ${provenanceLabel(rum)} — that ${claim}` : claim;
    }

    // strongest unmet need, as a phrase
    const n = npc.needs || ({} as Record<string, number>);
    let needs: string | null = null;
    if (n.hunger != null && n.hunger < 0.4) needs = 'you are hungry';
    else if (n.energy != null && n.energy < 0.4) needs = 'you are tired';
    else if (n.social != null && n.social < 0.4) needs = 'you crave a bit of company';

    // mood phrase
    const m = npc.mood || ({} as Record<string, number>);
    let mood = 'even-tempered';
    if (m.anger > 0.4) mood = 'irritated';
    else if (m.fear > 0.3) mood = 'uneasy';
    else if (s > 0.35) mood = 'friendly';

    // personality traits, named from the dominant axes
    const traits: string[] = [];
    if (P.ambition > 0.6) traits.push('ambitious'); else if (P.ambition < 0.3) traits.push('content');
    if (P.risk_tolerance > 0.6) traits.push('bold'); else if (P.risk_tolerance < 0.3) traits.push('cautious');
    if (P.social_drive > 0.6) traits.push('chatty'); else if (P.social_drive < 0.3) traits.push('reserved');
    if (P.curiosity > 0.6) traits.push('curious');

    // current trade want
    const want = this._wants();

    return {
      name: npc.name,
      profession: npc.profession || null,
      faction: npc.faction || null,
      traits: traits.length ? traits.join(', ') : null,
      mood,
      needs,
      gold: Math.round(npc.gold || 0),
      want: want ? `${want.qty > 1 ? want.qty + ' ' : 'some '}${want.commodity}` : null,
      aboutPlayer,
      rumour,
      prompt: situation || null,
    };
  }

  // --- the NPC's loudest rumour about SOMEONE ELSE (theory-of-mind surface) ---
  // Most-confident belief about a third party (not the player), to gossip about.
  _topRumour(): BeliefState | null {
    if (!this.npc.beliefs) return null;
    const pid: EntityId = this.player ? this.player.id : -1;
    let best: BeliefState | null = null;
    for (const b of this.npc.beliefs.all()) {
      if (b.subjectId === pid || b.subjectId === this.npc.id) continue;
      if (b.confidence < 0.3) continue;
      if (!best || b.confidence > best.confidence) best = b;
    }
    return best;
  }

  _subjectName(id: EntityId): string {
    const a = this.sim && this.sim.agentsById && this.sim.agentsById.get(id);
    return a ? a.name : `#${id}`;
  }

  // what does this NPC WANT? read its trade desires (wantQty) for an "I need…"
  _wants(): { commodity: string; qty: number } | null {
    const npc = this.npc;
    if (!npc.wantQty) return null;
    for (const c of COMMODITIES) {
      const q = npc.wantQty(c);
      if (q > 0) return { commodity: c, qty: q };
    }
    return null;
  }

  // --- option generation: rebuilt each turn from live state ------------------
  options(): DialogueOption[] {
    if (this.over) return [];
    const opts: DialogueOption[] = [];

    // 1) gossip: ask the NPC what it's heard (reveals its top rumour)
    const rum = this._topRumour();
    if (rum && !this._revealed) {
      opts.push({ id: 'ask_rumour', label: 'Heard anything lately?', kind: 'gossip' });
    }

    // 2) trade hook: surface what the NPC needs (informational; the market
    //    actually clears trades — this just tells the player what to bring)
    const want = this._wants();
    if (want) {
      opts.push({
        id: 'ask_need',
        label: `What do you need?`,
        kind: 'trade',
        _want: want,
      });
    }

    // 3) a standing offer, if the NPC carries one (set by quests / market)
    const openOffer = this.npc.openOffer as OpenOffer | undefined;
    if (openOffer) {
      opts.push({ id: 'take_offer', label: openOffer.label || 'About that offer…', kind: 'offer' });
    }

    // 4) party: recruit a willing NPC, or dismiss an existing companion
    const party = this.sim && this.sim.party;
    if (party) {
      if (party.has(this.npc)) {
        opts.push({ id: 'dismiss', label: '[Part ways]', kind: 'dismiss' });
      } else if (party.canRecruit(this.npc)) {
        opts.push({ id: 'recruit', label: '[Join my party]', kind: 'recruit' });
      }
    }

    // 5) social verbs — skill checks against the NPC's disposition
    opts.push({ id: 'persuade',  label: '[Persuade]',  kind: 'persuade' });
    opts.push({ id: 'intimidate', label: '[Intimidate]', kind: 'intimidate' });

    // 6) always leave
    opts.push({ id: 'leave', label: 'Leave', kind: 'leave' });

    this._opts = opts;
    return opts;
  }

  // --- resolve a choice ------------------------------------------------------
  choose(id: string): DialogueResult | null {
    if (this.over) return this.lastResult;
    const opt: DialogueOption = this._opts.find((o) => o.id === id) || { id, label: '', kind: id };
    switch (opt.kind) {
      case 'gossip':     return this._doRumour();
      case 'trade':      return this._doNeed(opt._want);
      case 'offer':      return this._doOffer();
      case 'recruit':    return this._doRecruit();
      case 'dismiss':    return this._doDismiss();
      case 'persuade':   return this._doCheck('persuade');
      case 'intimidate': return this._doCheck('intimidate');
      case 'leave':
      default:
        this.over = true;
        return (this.lastResult = { text: `${this.npc.name} turns back to their work.`, tone: 'neutral' });
    }
  }

  _doRecruit(): DialogueResult {
    const ok = this.sim && this.sim.party && this.sim.party.recruit(this.npc);
    this.over = true;
    return (this.lastResult = ok
      ? { text: `${this.npc.name} grins and falls in beside you. "Lead on, then."`, tone: 'good' }
      : { text: `${this.npc.name} shakes their head. "Not the life for me."`, tone: 'bad' });
  }

  _doDismiss(): DialogueResult {
    if (this.sim && this.sim.party) this.sim.party.dismiss(this.npc);
    this.over = true;
    return (this.lastResult = { text: `${this.npc.name} nods. "Fair enough. Watch yourself out there."`, tone: 'neutral' });
  }

  _doRumour(): DialogueResult {
    const rum = this._topRumour();
    this._revealed = true;
    if (!rum) return (this.lastResult = { text: `"Nothing worth repeating."`, tone: 'neutral' });
    const subj = this._subjectName(rum.subjectId);
    const fac = rum.lastFaction ? FACTIONS[rum.lastFaction as keyof typeof FACTIONS] : undefined;
    let text: string;
    if (rum.hostile) {
      text = `"${subj}? Bad business — I'd steer clear of them."`;
    } else if (rum.standing < -0.1) {
      text = `"${subj}? Can't say I trust them, frankly."`;
    } else if (rum.standing > 0.1) {
      text = `"${subj}'s good people. ${fac ? fac.label + ', ' : ''}solid sort."`;
    } else {
      text = `"${subj}? Seen them about. Keep to themselves."`;
    }
    // the player now LEARNS the NPC's belief: plant it into the player's own
    // belief store as a RUMOR (second-hand confidence) if the player has one.
    if (this.player && this.player.beliefs && rum.subjectId !== this.player.id) {
      this.player.beliefs.plant(rum.subjectId, {
        faction: rum.lastFaction,
        pos: rum.lastPos,
        tick: this.sim ? this.sim.time : 0,
        hostile: rum.hostile,
        suspicion: rum.suspicion,
        confidence: SOURCE.RUMOR.conf,
      });
    }
    return (this.lastResult = { text, tone: 'neutral' });
  }

  _doNeed(want?: { commodity: string; qty: number }): DialogueResult {
    if (!want) return (this.lastResult = { text: `"I've got what I need, thanks."`, tone: 'neutral' });
    const a = /^[aeiou]/i.test(want.commodity) ? 'an' : 'a';
    const text = want.qty > 1
      ? `"Could use ${want.qty} ${want.commodity}, if you're selling."`
      : `"I'm short ${a} ${want.commodity} — bring one to the market and I'll buy."`;
    return (this.lastResult = { text, tone: 'neutral' });
  }

  _doOffer(): DialogueResult {
    const o = this.npc.openOffer as OpenOffer | undefined;
    if (!o) return (this.lastResult = { text: `"No, nothing like that."`, tone: 'neutral' });
    // hand the offer to whoever wired openOffer (quest board, etc.)
    if (typeof o.onAccept === 'function') o.onAccept(this.player, this.npc, this.sim);
    this.over = true;
    return (this.lastResult = { text: o.acceptText || `"Deal. Don't let me down."`, tone: 'good' });
  }

  // skill check: roll player skill vs an NPC difficulty derived from how it
  // feels about the player (standing) and how dangerous it is (threat). Success
  // warms (persuade) or — via fear — sours-but-complies (intimidate) the NPC's
  // standing toward the player. Both write back into the NPC's belief store.
  _doCheck(kind: 'persuade' | 'intimidate'): DialogueResult {
    const b = this._beliefOfPlayer();
    const standing = b ? b.standing : 0;
    const skill = playerSkill(this.player, kind);

    // difficulty: persuading a hostile NPC is hard; intimidating a fearless
    // (high-threat) NPC is hard. Both centre ~0.5 and clamp to [0.1, 0.9].
    let dc: number;
    if (kind === 'persuade') dc = clamp(0.5 - standing * 0.4, 0.1, 0.9);
    else                     dc = clamp(0.45 + (this.npc.threat || 0.3) * 0.3 - standing * 0.1, 0.1, 0.9);

    const roll = clamp(skill * 0.6 + rand(0, 0.55), 0, 1.2);
    const success = roll >= dc;

    const player = this.player;
    const pid: EntityId | null = player ? player.id : null;
    if (player && pid != null && this.npc.beliefs) {
      const belief = this.npc.beliefs.get(pid) || this.npc.beliefs.plant(pid, {
        faction: player.faction, pos: player.pos, tick: this.sim ? this.sim.time : 0,
      });
      if (kind === 'persuade') {
        belief.standing = clamp(belief.standing + (success ? 0.22 : -0.12), -1, 1);
      } else {
        // intimidation: success cows them (fear up, standing dips a touch);
        // failure emboldens/angers them (standing drops, suspicion up)
        if (success) {
          if (this.npc.mood) this.npc.mood.fear = Math.min(1, (this.npc.mood.fear || 0) + 0.4);
          belief.standing = clamp(belief.standing - 0.05, -1, 1);
        } else {
          if (this.npc.mood) this.npc.mood.anger = Math.min(1, (this.npc.mood.anger || 0) + 0.3);
          belief.standing = clamp(belief.standing - 0.2, -1, 1);
          belief.suspicion = Math.min(1, (belief.suspicion || 0) + 0.25);
        }
      }
    }

    let text: string;
    if (kind === 'persuade') {
      text = success ? `${this.npc.name} softens. "…Alright. You make a fair point."`
                     : `${this.npc.name} shakes their head. "Save your breath."`;
    } else {
      text = success ? `${this.npc.name} pales and backs down. "A-alright! No trouble."`
                     : `${this.npc.name} bristles. "You don't scare me."`;
    }
    return (this.lastResult = { text, tone: success ? 'good' : 'bad' });
  }
}
