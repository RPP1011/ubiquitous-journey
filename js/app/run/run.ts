// THE RUN: hub → quest → stage battles across the world → home → the town hears about it.
//
// RunController owns the loop and the SAVE (companion profiles, what the town has heard, who
// thinks what of you, quests done). It is headless: the browser UI and the video autopilot
// drive the same calls the tests do.
//
//   setupHub()            spawn the hub cast + your companions in town; re-seat what the town
//                         remembers into their engine beliefs
//   startRun(q, party)    set out
//   beginStage()          build this stage's battlefield in its part of the world → a Battle
//   endStage()            objective check, deeds, companion growth, patch-up
//   finishRun()           tales told, opinions shift, departures, save persisted

import * as THREE from 'three';
import { findBiomeSpot, BIOME } from '../../arena.js';
import { rng } from '../../sim/rng.js';
import { TUNE } from '../../constants.js';
import { Agent } from '../../sim/agent.js';
import type { Agent as AgentT } from '../../../types/sim.js';
import type { Session } from '../session.js';
import { BattleMap, type Tile } from '../tactics/map.js';
import { Battle, type Outcome, type Traits, type Unit } from '../tactics/battle.js';
import { abilityById } from './gear.js';
import { COMPANIONS, freshProfile, developFromBattle, bark, pairBark, checkDeparture, type CompanionKey, type CompanionProfile } from './companions.js';
import { QUESTS, QUEST_ORDER, type QuestDef, type StageDef } from './quests.js';
import { SETS, setTile, stageCenter } from './sets.js';
import { PIECES } from './setPieces.js';
import { installBonds, foldBonds, type BondRec } from './bonds.js';
import { HUB_NPCS, HUB_SPOTS, COMPANY_SPOTS, PLAYER_SPOT, freshHub, tellTales, speak, type Deed, type HubLine, type HubState } from './hub.js';

/** Turn a body to look at a point (visual). */
function faceTo(a: AgentT, x: number, z: number): void {
  try { a.fighter.root.rotation.y = Math.atan2(-(x - a.pos.x), -(z - a.pos.z)); } catch { /* stub */ }
}

export interface SaveData {
  version: 1;
  runs: number;
  profiles: Record<CompanionKey, CompanionProfile>;
  hub: HubState;
  deeds: Deed[];
  questsDone: string[];
  kinHome: string[];                        // hub-kin keys whose people came home (Col spared, Elsie saved)
  lastSeen: Partial<Record<CompanionKey, Traits>>;   // traits when the town last saw them
  gold: number;
  /** How close the people on your side have grown (bonds.ts); absent in older saves. */
  bonds: Record<string, BondRec>;
}

export interface SaveStore { load(): SaveData | null; save(d: SaveData): void; }

export function memoryStore(): SaveStore & { data: SaveData | null } {
  const s = { data: null as SaveData | null, load() { return s.data ? JSON.parse(JSON.stringify(s.data)) : null; }, save(d: SaveData) { s.data = JSON.parse(JSON.stringify(d)); } };
  return s;
}

export function localStore(key = 'hearsay.save.v1'): SaveStore {
  return {
    load() { try { const t = localStorage.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; } },
    save(d) { try { localStorage.setItem(key, JSON.stringify(d)); } catch { /* private mode */ } },
  };
}

function freshSave(): SaveData {
  return {
    version: 1, runs: 0, hub: freshHub(), deeds: [], questsDone: [], kinHome: [], lastSeen: {}, gold: 40, bonds: {},
    profiles: Object.fromEntries((Object.keys(COMPANIONS) as CompanionKey[]).map((k) => [k, freshProfile(k)])) as Record<CompanionKey, CompanionProfile>,
  };
}

export interface StageResult {
  stage: StageDef;
  outcome: Outcome;
  objectiveMet: boolean;
  deeds: Deed[];
  growth: string[];
  barks: Array<{ who: string; text: string }>;
}

export interface RunReport {
  quest: QuestDef;
  success: boolean;
  stages: StageResult[];
  tales: string[];
  departures: string[];
  traitsBefore: Partial<Record<CompanionKey, Traits>>;
  traitsAfter: Partial<Record<CompanionKey, Traits>>;
}

export type Disposition = 'merciful' | 'ruthless' | 'pragmatic';
export const DISPOSITION_TRAITS: Record<Disposition, Traits> = {
  merciful: { bravery: 0.75, compassion: 0.95, loyalty: 1, ruthlessness: 0.05 },
  ruthless: { bravery: 0.85, compassion: 0.05, loyalty: 1, ruthlessness: 0.95 },
  pragmatic: { bravery: 0.7, compassion: 0.5, loyalty: 1, ruthlessness: 0.4 },
};

const BIOMES: Record<StageDef['biome'], string> = { forest: BIOME.FOREST, plains: BIOME.PLAINS, hills: BIOME.HILLS, wilds: BIOME.WILDS };

export class RunController {
  readonly session: Session;
  readonly store: SaveStore;
  save: SaveData;
  quest: QuestDef | null = null;
  stageIdx = 0;
  party: CompanionKey[] = [];
  disposition: Disposition = 'pragmatic';
  battle: Battle | null = null;
  results: StageResult[] = [];
  companionAgents = new Map<CompanionKey, AgentT>();
  hubAgents = new Map<string, AgentT>();
  private stageAgents: AgentT[] = [];
  private companionOf = new Map<Unit['id'], CompanionKey>();
  private traitsBefore: Partial<Record<CompanionKey, Traits>> = {};
  private runDeeds: Deed[] = [];

  constructor(session: Session, store: SaveStore) {
    this.session = session;
    this.store = store;
    this.save = store.load() ?? freshSave();
    this.save.bonds ??= {};
  }

  name(k: string): string {
    if (k in COMPANIONS) return COMPANIONS[k as CompanionKey].name;
    const h = HUB_NPCS.find((n) => n.key === k);
    return h ? h.name : k;
  }

  // ---- the hub --------------------------------------------------------------------------------

  /** Spawn the hub cast and your company in town; seat what each person remembers into their beliefs. */
  setupHub(): void {
    const sim = this.session.sim;
    const world = this.session.world as unknown as { nearest(kind: string, p: THREE.Vector3): { pos: THREE.Vector3 } | null };
    const origin = new THREE.Vector3(0, 0, 0);
    const player = this.session.player;
    HUB_NPCS.forEach((def, i) => {
      let a = this.hubAgents.get(def.key);
      if (!a) {
        const spot = HUB_SPOTS[def.key];
        const p = spot ? new THREE.Vector3(spot[0], 0, spot[1]) : (world.nearest(def.poi, origin)?.pos.clone() ?? new THREE.Vector3(Math.cos(i) * 6, 0, Math.sin(i) * 6));
        a = this.spawn(def.name, 'townsfolk', def.model, p, { risk_tolerance: 0.3, social_drive: 0.6, ambition: 0.4, altruism: 0.6, curiosity: 0.5 }, false);
        a.gold = 80;
        (a as { canWork?: boolean }).canWork = false;
        a._held = true;                           // stays at their post (the hub cast doesn't wander off)
        this.hubAgents.set(def.key, a);
      }
      const spot = HUB_SPOTS[def.key];
      if (spot) { a.pos.set(spot[0], 0, spot[1]); faceTo(a, 0, 0); }
      // what they remember of you becomes an engine belief (the inspector reads it too)
      if (player) {
        a.beliefs.observe(player.id, player.faction, player.pos, sim.time, false);
        const b = a.beliefs.get(player.id);
        if (b) {
          b.standing = this.save.hub.standing[def.key] ?? 0;
          const heard = this.save.hub.heard[def.key] ?? [];
          b.knownDeeds = heard.slice(-6).map((h) => { const d = this.save.deeds.find((x) => x.id === h.deed); return { deed: h.deed, label: d ? (h.hops >= 2 ? d.lurid : d.label) : h.deed, t: h.run, hops: h.hops }; });
        }
      }
    });
    // kin who came home stand beside their family
    if (this.save.kinHome.includes('tom') && !this.hubAgents.has('col')) {
      const tom = this.hubAgents.get('tom')!;
      const col = this.spawn('Col Garrow', 'townsfolk', 'barbarian', tom.pos.clone().add(new THREE.Vector3(1.3, 0, 1.2)), { risk_tolerance: 0.4, social_drive: 0.3, ambition: 0.3, altruism: 0.4, curiosity: 0.3 }, false);
      col._held = true; faceTo(col, 0, 0); this.hubAgents.set('col', col);
    }
    if (this.save.kinHome.includes('nan') && !this.hubAgents.has('elsie')) {
      const nan = this.hubAgents.get('nan')!;
      const el = this.spawn('Elsie Miller', 'townsfolk', 'knight', nan.pos.clone().add(new THREE.Vector3(-1.4, 0, 1)), { risk_tolerance: 0.2, social_drive: 0.6, ambition: 0.3, altruism: 0.7, curiosity: 0.5 }, false);
      el._held = true; faceTo(el, 0, 0); this.hubAgents.set('elsie', el);
    }
    // your company stands with you at the south of the square
    this.available().forEach((k, i) => {
      const a = this.companion(k);
      const s = COMPANY_SPOTS[i] ?? [i * 1.5 - 3, 4];
      a.pos.set(s[0], 0, s[1]); faceTo(a, 0, -3);
      a.fighter.health = Math.max(a.fighter.health, TUNE.maxHealth);
      a._held = true;
    });
    // (the fallen and the departed are not in the square)
    for (const [k, a] of this.companionAgents) if (!this.available().includes(k)) a.pos.set(0, -200, 0);
    this.curate();
    if (player) {
      if (!player.alive) (player.fighter as { revive?: (h: number) => void }).revive?.(TUNE.maxHealth);   // carried home, patched up at the chapel
      player.pos.set(PLAYER_SPOT[0], 0, PLAYER_SPOT[1]); faceTo(player, 0, -3); player.fighter.health = TUNE.maxHealth; player.gold = this.save.gold; player._encounter = null;
    }
  }

  /**
   * The hub is curated: only you, the cast and your company. Everyone else the engine spawned
   * (the background town, camp monsters) is removed — and kept out on later frames.
   */
  curate(): void {
    const keep = new Set<AgentT>([...this.hubAgents.values(), ...this.companionAgents.values(), ...this.stageAgents]);
    const player = this.session.player;
    if (player) keep.add(player);
    const sim = this.session.sim as unknown as { scene: { remove(o: unknown): void }; agents: AgentT[]; agentsById: Map<unknown, AgentT> };
    for (const a of [...sim.agents]) {
      if (keep.has(a)) continue;
      try { sim.scene.remove(a.fighter.root); (a.fighter as { dispose?: () => void }).dispose?.(); } catch { /* headless */ }
      sim.agents.splice(sim.agents.indexOf(a), 1);
      sim.agentsById.delete(a.id);
    }
  }

  /** Companions who will still travel with you. */
  available(): CompanionKey[] {
    return (Object.keys(COMPANIONS) as CompanionKey[]).filter((k) => this.save.profiles[k].alive && !this.save.profiles[k].departed);
  }

  nextQuest(): QuestDef | null {
    const id = QUEST_ORDER.find((q) => !this.save.questsDone.includes(q));
    return id ? QUESTS[id] : null;
  }

  /** What a hub NPC says to you right now. */
  talk(npc: string): HubLine[] {
    const next = this.nextQuest();
    return speak(this.save.hub, npc, {
      deeds: this.save.deeds, runs: this.save.runs, nameOf: (k) => this.name(k),
      companionNews: this.companionNews(npc),
      questOffer: (n) => (next && next.giver === n ? `${next.pitch}` : null),
    });
  }

  /** What the town has noticed about your companions since it last saw them. */
  companionNews(npc: string): Array<{ key: CompanionKey; text: string }> {
    const out: Array<{ key: CompanionKey; text: string }> = [];
    const heard = new Set((this.save.hub.heard[npc] ?? []).map((h) => h.deed));
    for (const k of Object.keys(COMPANIONS) as CompanionKey[]) {
      const p = this.save.profiles[k], first = COMPANIONS[k].short;
      if (p.departed) { out.push({ key: k, text: `I heard ${COMPANIONS[k].name} walked out on you. Said something about the things you'd done.` }); continue; }
      if (!p.alive) { out.push({ key: k, text: `I'm sorry about ${first}.` }); continue; }
      const was = this.save.lastSeen[k];
      if (!was) continue;
      const aboutThem = this.save.deeds.filter((d) => d.about === k && heard.has(d.id)).pop();
      if (p.traits.bravery - was.bravery > 0.08) out.push({ key: k, text: `${first}'s walking taller these days.${aboutThem ? ` I heard ${aboutThem.label}.` : ''}` });
      else if (was.bravery - p.traits.bravery > 0.06) out.push({ key: k, text: `${first} looks like they've seen a ghost.${aboutThem ? ` Is it true ${aboutThem.label}?` : ''}` });
      else if (was.loyalty - p.traits.loyalty > 0.1) out.push({ key: k, text: `${first} sat alone at the Brewer's last night. Wouldn't say why.` });
    }
    return out;
  }

  // ---- setting out ----------------------------------------------------------------------------

  startRun(questId: string, party: CompanionKey[], disposition: Disposition = 'pragmatic'): void {
    this.quest = QUESTS[questId];
    this.stageIdx = 0;
    this.party = party.filter((k) => this.available().includes(k)).slice(0, 3);
    this.disposition = disposition;
    this.results = [];
    this.runDeeds = [];
    this.traitsBefore = Object.fromEntries(this.party.map((k) => [k, { ...this.save.profiles[k].traits }]));
    for (const k of this.party) this.save.profiles[k].stats.runs++;
  }

  get stage(): StageDef | null { return this.quest ? this.quest.stages[this.stageIdx] ?? null : null; }

  setoutBarks(): Array<{ who: string; text: string }> {
    return this.party.map((k) => ({ who: COMPANIONS[k].name, text: bark(this.save.profiles[k], 'setout') }));
  }

  /** Build the stage's battlefield in its part of the world and seat everyone. */
  beginStage(): Battle {
    const st = this.stage!;
    const sim = this.session.sim;
    const set = SETS[st.id];
    let map: BattleMap;
    if (set) {
      // an authored stage set, built on its own ground off the map (see sets.ts)
      const qi = QUEST_ORDER.indexOf(this.quest!.id);
      const c = stageCenter(Math.max(0, qi) * 3 + this.stageIdx);
      map = new BattleMap(c, 16, { bare: true });
      map.onTerrain = false; map.baseY = 0;
      for (const t of map.tiles) { const s = setTile(set, t.x, t.z); t.ground = s.ground; t.wall = s.wall; t.h = s.h; }
    } else {
      const spot = findBiomeSpot(BIOMES[st.biome], st.radius[0], st.radius[1], 60) ?? new THREE.Vector3(st.radius[0], 0, 0);
      map = new BattleMap(spot, 16, { bare: true });
      // soften the raw terrain into readable steps
      const floor = Math.min(...map.tiles.map((t) => t.h));
      map.baseY = floor * 0.5;
      for (const t of map.tiles) t.h = Math.min(3, Math.round((t.h - floor) * 0.35));
      for (const t of map.tiles) t.ground = 'grass';
    }
    // raise any authored high ground
    if (st.rise) for (const t of map.tiles) { const d = Math.hypot(t.x - st.rise.at[0], t.z - st.rise.at[1]); if (d <= st.rise.r) t.h += Math.round(st.rise.h * (1 - d / (st.rise.r + 1))) + 1; }
    const rocky = set?.rockyAbove ?? (st.biome === 'hills' ? 3 : 99);
    for (const t of map.tiles) if (t.h >= rocky && !t.wall) t.ground = 'stone';
    const reserved = new Set<string>([...st.partyAt, ...st.foes.map((f) => f.at), ...(st.captive ? [st.captive.at] : []), ...(set ? (PIECES[st.id] ?? []).flatMap((p) => p.at) : [])].map(([x, z]) => `${x},${z}`));
    for (const [k, x, z] of st.props) if (!map.propAt(x, z)) map.addProp(k, x, z);
    if (st.trees) for (const t of map.tiles) if (!reserved.has(`${t.x},${t.z}`) && !map.propAt(t.x, t.z) && !t.wall && t.ground === 'grass' && rng() < st.trees) map.addProp('tree', t.x, t.z);
    const b = new Battle(this.session, map);
    if (set) for (const p of PIECES[st.id] ?? []) b.addPiece(p);
    const seat = (at: [number, number]): Tile => { const t = map.tile(at[0], at[1]); return t && map.standable(t.x, t.z) && !b.unitAt(t.x, t.z) ? t : map.freeNear(at[0], at[1], 3)!; };

    // your side
    const player = this.session.player!;
    player._held = false;
    const pu = b.add(player, 'player', seat(st.partyAt[0]), { traits: DISPOSITION_TRAITS[this.disposition], tactic: 'guardian' });
    pu.traits = { ...DISPOSITION_TRAITS[this.disposition] };
    if (this.disposition === 'ruthless') {
      // the ruthless come with a torch in hand
      const torch = map.addProp('torch', 0, 0); map.removeProp(torch); pu.carrying = torch;
    }
    this.companionOf.clear();
    this.party.forEach((k, i) => {
      const a = this.companion(k);
      a._held = false;
      const def = COMPANIONS[k];
      const u = b.add(a, 'companion', seat(st.partyAt[i + 1] ?? st.partyAt[0]), { traits: this.save.profiles[k].traits, tactic: def.tactic });
      u.sheet.presence = Math.max(u.sheet.presence, Math.round(def.social * 4));
      if (def.tactic === 'archer') u.sheet.finesse += 1;
      if (def.tactic === 'guardian') u.sheet.might += 1;
      this.companionOf.set(u.id, k);
    });
    // the foes
    this.stageAgents = [];
    for (const f of st.foes) {
      const a = this.spawn(f.name, f.faction, f.model ?? (f.tactic === 'archer' ? 'hooded' : f.tactic === 'skirmisher' ? 'rogue' : 'barbarian'), new THREE.Vector3(), { risk_tolerance: f.risk ?? 0.5, social_drive: 0.3, ambition: 0.5, altruism: 0.2, curiosity: 0.3 }, true);
      a.gold = f.gold ?? 0;
      if (f.epithet) a.epithet = f.epithet;
      for (const id of f.abilities ?? []) { const s = abilityById(id); if (s) a.grantAbility(s); }
      const u = b.add(a, 'foe', seat(f.at), { tactic: f.tactic, tags: f.tags ?? [] });
      for (const [k, v] of Object.entries(f.bonus ?? {})) u.sheet[k as 'might'] += v as number;
      if (f.move) u.move = f.move;
      if (f.hp) a.fighter.health = f.hp;
      for (const o of [player, ...this.party.map((k) => this.companion(k))]) { a.beliefs.observe(o.id, o.faction, o.pos, sim.time, true); a.beliefs.get(o.id)!.hostile = true; }
      if (f.tags?.includes('chief')) b.goals.chief = u.id;
      this.stageAgents.push(a);
    }
    for (const o of [player, ...this.party.map((k) => this.companion(k))]) for (const a of this.stageAgents) { o.beliefs.observe(a.id, a.faction, a.pos, sim.time, true); o.beliefs.get(a.id)!.hostile = true; }
    // the captive
    if (st.captive) {
      const a = this.spawn(st.captive.name, 'townsfolk', 'knight', new THREE.Vector3(), { risk_tolerance: 0.1, social_drive: 0.5, ambition: 0.2, altruism: 0.7, curiosity: 0.4 }, false);
      const u = b.add(a, 'ally', seat(st.captive.at), { tactic: 'civilian', tags: ['captive'], bound: true });
      b.goals.rescue = u.id;
      this.stageAgents.push(a);
    }
    if (st.relicAt) b.goals.retrieve = map.addProp('relic', st.relicAt[0], st.relicAt[1]).id;
    b.goals.spareChief = this.disposition === 'merciful';
    installBonds(b, this.save.bonds, new Map<string, Unit['id']>([['player', pu.id], ...[...this.companionOf].map(([uid, k]) => [k, uid] as [string, Unit['id']])]));
    this.battle = b;
    return b;
  }

  preBattleBarks(): Array<{ who: string; text: string }> {
    return this.party.filter((k) => this.companionAgents.get(k)?.alive).map((k, i) => {
      // a close bond (2+) sometimes speaks instead: to the friend beside them, or to you
      const mates = ['player', ...this.party.filter((o) => o !== k && this.companionAgents.get(o)?.alive)];
      const best = mates.map((o) => ({ o, lvl: this.save.bonds[[k, o].sort().join('|')]?.lvl ?? 0 })).sort((a, c) => c.lvl - a.lvl)[0];
      if (best && best.lvl >= 2 && (this.save.runs + this.stageIdx + i) % 2 === 0) return { who: COMPANIONS[k].name, text: pairBark(k, best.o === 'player' ? null : COMPANIONS[best.o as CompanionKey].short) };
      return { who: COMPANIONS[k].name, text: bark(this.save.profiles[k], 'prebattle') };
    });
  }

  /** Resolve the stage: objective, deeds, growth, patch-up. */
  endStage(): StageResult {
    const b = this.battle!, st = this.stage!;
    const outcome = b.outcome ?? 'timeout';
    const won = outcome === 'victory' || outcome === 'truce';
    let objectiveMet = won;
    if (st.objective === 'rescue') {
      const cap = b.units.find((u) => u.tags.has('captive'));
      objectiveMet = !!cap && cap.agent.alive && !cap.bound && (won || b.events.some((e) => e.kind === 'rescued'));
    }
    if (st.objective === 'retrieve') {
      const carrier = b.units.find((u) => u.carrying?.kind === 'relic' && u.side === 'us' && u.agent.alive);
      objectiveMet = (!!carrier && (won || carrier.out === 'fled')) || outcome === 'truce' || (won && b.units.filter((u) => u.side === 'them').every((u) => u.out !== null));
    }
    if (st.objective === 'chief') {
      const chief = b.get(b.goals.chief);
      objectiveMet = !!chief && (chief.out === 'dead' || chief.out === 'yielded' || chief.out === 'captured' || !chief.agent.alive);
    }
    const deeds = this.deedsFrom(b, st, objectiveMet);
    this.runDeeds.push(...deeds);
    const growth = developFromBattle(b, new Map(this.party.map((k) => [k, this.save.profiles[k]])), this.companionOf, this.session.player!.id, this.save.runs + 1, st.name);
    const members = new Map<Unit['id'], string>([[this.session.player!.id, 'player'], ...this.companionOf]);
    growth.push(...foldBonds(b, this.save.bonds, members, (k) => this.name(k), won));
    // the dead stay dead; the rest are patched up for the road
    for (const [uid, k] of this.companionOf) {
      const u = b.get(uid)!;
      if (!u.agent.alive) this.save.profiles[k].alive = false;
    }
    const maud = this.party.includes('maud') && this.companionAgents.get('maud')?.alive;
    for (const u of b.units) {
      if (u.side !== 'us' || !u.agent.alive) continue;
      u.agent.fighter.health = Math.min(TUNE.maxHealth, Math.max(u.agent.fighter.health, 20) + 35 + (maud ? 15 : 0));
    }
    const barks = won ? this.party.filter((k) => this.companionAgents.get(k)?.alive).map((k) => ({ who: COMPANIONS[k].name, text: bark(this.save.profiles[k], 'victory') })) : [];
    const res: StageResult = { stage: st, outcome, objectiveMet, deeds, growth, barks };
    this.results.push(res);
    this.cleanupStage();
    this.stageIdx++;
    return res;
  }

  /** Does the run go on? (Out of stages, or the party was beaten.) */
  get runOver(): boolean {
    const last = this.results[this.results.length - 1];
    return !this.quest || this.stageIdx >= this.quest.stages.length || (!!last && (last.outcome === 'defeat' || last.outcome === 'arrested' || last.outcome === 'overpowered'));
  }

  /** Home again: the town hears about it. */
  finishRun(): RunReport {
    const q = this.quest!;
    const success = this.results.length === q.stages.length && this.results.every((r) => r.outcome !== 'defeat') && this.results[this.results.length - 1].objectiveMet;
    if (success && !this.save.questsDone.includes(q.id)) this.save.questsDone.push(q.id);
    this.save.runs++;
    this.save.deeds.push(...this.runDeeds);
    const present = this.party.filter((k) => this.save.profiles[k].alive);
    const tales = tellTales(this.save.hub, this.runDeeds, present, (k) => this.name(k));
    for (const d of this.runDeeds) if (d.kin && (d.kin.fate === 'spared' || d.kin.fate === 'saved') && !this.save.kinHome.includes(d.kin.npc)) this.save.kinHome.push(d.kin.npc);
    const departures: string[] = [];
    for (const k of this.party) { const m = checkDeparture(this.save.profiles[k]); if (m) departures.push(m); }
    const traitsAfter = Object.fromEntries(this.party.map((k) => [k, { ...this.save.profiles[k].traits }]));
    const player = this.session.player;
    if (player) this.save.gold = Math.round(player.gold || 0);
    this.store.save(this.save);
    const report: RunReport = { quest: q, success, stages: this.results, tales, departures, traitsBefore: this.traitsBefore, traitsAfter };
    this.quest = null;
    return report;
  }

  /** After the hub has had its say, it remembers how your companions looked this time. */
  markSeen(): void {
    for (const k of Object.keys(COMPANIONS) as CompanionKey[]) this.save.lastSeen[k] = { ...this.save.profiles[k].traits };
    this.store.save(this.save);
  }

  // ---- deeds ------------------------------------------------------------------------------------

  private deedsFrom(b: Battle, st: StageDef, objectiveMet: boolean): Deed[] {
    const pid = this.session.player!.id;
    const run = this.save.runs + 1;
    const out: Deed[] = [];
    const witnesses = [...this.companionOf.values()];
    const nm = (id: Unit['id'] | undefined) => { const u = id != null ? b.get(id) : undefined; return u ? u.agent.name : 'someone'; };
    const at = st.name;
    const add = (d: Omit<Deed, 'id' | 'run' | 'stage' | 'witnesses'> & { witnesses?: string[] }) =>
      out.push({ id: `r${run}:${st.id}:${out.length}`, run, stage: at, witnesses: d.witnesses ?? witnesses, ...d });
    const E = b.events;
    // fire
    const burnedBy = E.filter((e) => (e.kind === 'ignite' && e.target != null && b.get(e.target)?.side === 'them') || (e.kind === 'hazard' && e.detail === 'fire')).filter((e) => e.actor === pid);
    if (burnedBy.length) add({ label: `set ${nm(burnedBy[0].target)} alight at ${at}`, lurid: `burned men alive at ${at} and laughed while they screamed`, tags: ['fire', 'courage'], weight: 1.4, about: 'player' });
    else if (E.some((e) => e.kind === 'ignite' && e.actor === pid)) add({ label: `fought with fire at ${at}`, lurid: `put ${at} to the torch`, tags: ['fire'], weight: 0.8, about: 'player' });
    // the fleeing
    const fin = E.filter((e) => e.kind === 'finish' && e.actor === pid);
    if (fin.length) add({ label: `cut down ${nm(fin[0].target)} as they ran at ${at}`, lurid: `butchered men begging for their lives at ${at}`, tags: ['cruelty'], weight: 1.2, about: 'player' });
    // mercy
    const spared = E.filter((e) => (e.kind === 'yield' || e.kind === 'parley') && (e.actor === pid || e.detail === 'surrender'));
    if (spared.length) add({ label: `let ${nm(spared[0].target)} live at ${at}`, lurid: `let the whole band go free at ${at}`, tags: ['mercy'], weight: 1, about: 'player' });
    // theft
    if (E.some((e) => e.kind === 'grab' && e.actor === pid)) add({ label: `emptied a beaten man's purse at ${at}`, lurid: `robbed the dead at ${at}`, tags: ['theft'], weight: 0.8, about: 'player' });
    // kin (Col Garrow): his fate depends on who did what to him
    for (const u of b.units.filter((x) => [...x.tags].some((t) => t.startsWith('kin:')))) {
      const npc = [...u.tags].find((t) => t.startsWith('kin:'))!.slice(4);
      if (u.out === 'dead' || !u.agent.alive) add({ label: `killed ${u.agent.name} at ${at}`, lurid: `gutted ${u.agent.name} like a pig at ${at}`, tags: ['courage'], weight: 1, about: 'player', kin: { npc, fate: 'killed' } });
      else if (u.out === 'yielded' || u.out === 'fled') add({ label: `let ${u.agent.name} go at ${at}`, lurid: `let ${u.agent.name} go at ${at}`, tags: ['mercy'], weight: 1, about: 'player', kin: { npc, fate: 'spared' }, witnesses: [...witnesses, npc] });
    }
    // the captive
    if (st.captive) {
      const cap = b.units.find((u) => u.tags.has('captive'));
      const freer = E.find((e) => e.kind === 'free');
      if (objectiveMet && cap) add({ label: `cut ${st.captive.name} free at ${at}${freer && freer.actor !== pid ? ` (${nm(freer.actor)} got the ropes)` : ''}`, lurid: `walked through fire to carry ${st.captive.name} out of ${at}`, tags: ['mercy', 'courage'], weight: 1.6, about: 'player', kin: st.captive.hubKin ? { npc: st.captive.hubKin, fate: 'saved' } : undefined, witnesses: [...witnesses, ...(st.captive.hubKin ? [st.captive.hubKin] : [])] });
      else if (st.captive.hubKin) add({ label: `failed to save ${st.captive.name} at ${at}`, lurid: `left ${st.captive.name} to die at ${at}`, tags: ['courage'], weight: 1.2, about: 'player', kin: { npc: st.captive.hubKin, fate: 'lost' } });
    }
    // the chief / the relic
    const chief = b.get(b.goals.chief);
    if (chief && st.objective === 'chief') {
      if (chief.out === 'yielded') add({ label: `beat ${chief.agent.name} and took the surrender at ${at}`, lurid: `made ${chief.agent.name} kneel in the mud at ${at}`, tags: ['courage', 'mercy', 'order'], weight: 2, about: 'player' });
      else if (!chief.agent.alive) add({ label: `brought down ${chief.agent.name} at ${at}`, lurid: `took ${chief.agent.name}'s head at ${at}`, tags: ['courage', 'order'], weight: 2, about: 'player' });
    }
    if (st.objective === 'retrieve' && objectiveMet && b.outcome === 'truce') add({ label: `talked Silas Crowe into handing back the reliquary at ${at}`, lurid: `bought the reliquary back with a silver tongue`, tags: ['mercy', 'order'], weight: 1.4, about: 'player' });
    else if (st.objective === 'retrieve' && objectiveMet) add({ label: `brought the silver reliquary back from ${at}`, lurid: `stole the reliquary out from under Silas Crowe's nose`, tags: ['courage', 'order'], weight: 1.6, about: 'player' });
    // your company, as others saw them
    for (const [uid, k] of this.companionOf) {
      const first = COMPANIONS[k].short;
      const others = witnesses.filter((w) => w !== k);
      if (E.some((e) => (e.kind === 'escape' || e.kind === 'broken') && e.actor === uid)) add({ label: `${first} ran at ${at}`, lurid: `${first} fled screaming at ${at}`, tags: ['courage'], weight: 0.6, about: k, witnesses: others });
      else if (b.get(uid)?.agent.alive && E.filter((e) => (e.kind === 'kill' || e.kind === 'guard' || e.kind === 'revive') && e.actor === uid).length >= 2) add({ label: `${first} stood firm at ${at}`, lurid: `${first} held off five men alone at ${at}`, tags: ['courage'], weight: 0.6, about: k, witnesses: others.length ? others : witnesses });
      const dive = E.find((e) => e.kind === 'save' && e.actor === uid);
      if (dive) add({ label: `${first} took a blow meant for ${dive.target === pid ? 'you' : nm(dive.target)} at ${at}`, lurid: `${first} took a sword through the shoulder for ${dive.target === pid ? 'you' : nm(dive.target)} at ${at}`, tags: ['loyalty', 'courage'], weight: 0.9, about: k, witnesses: others.length ? others : witnesses });
      const together = E.filter((e) => e.kind === 'combo' && ((e.actor === pid && e.with === uid) || (e.actor === uid && e.with === pid))).length;
      if (together >= 2) add({ label: `fought as one with ${first} at ${at}`, lurid: `fought back to back with ${first} against twenty at ${at}`, tags: ['loyalty', 'courage'], weight: 0.6, about: 'player' });
      const saved = E.find((e) => e.kind === 'revive' && e.actor === pid && e.target === uid);
      if (saved) add({ label: `hauled ${first} out of the fight at ${at}`, lurid: `carried ${first} out on their back at ${at}`, tags: ['loyalty', 'courage'], weight: 0.8, about: 'player' });
    }
    return out;
  }

  // ---- bodies -----------------------------------------------------------------------------------

  companion(k: CompanionKey): AgentT {
    let a = this.companionAgents.get(k);
    if (a && a.alive) return a;
    const def = COMPANIONS[k];
    const t = this.save.profiles[k].traits;
    a = this.spawn(def.name, 'townsfolk', def.model, new THREE.Vector3(), { risk_tolerance: t.bravery, social_drive: def.social, ambition: 0.5, altruism: t.compassion, curiosity: 0.5 }, true);
    a.inParty = true;
    for (const id of def.abilities) { const s = abilityById(id); if (s) a.grantAbility(s); }
    const inv = a.inventory as Record<string, number> | undefined;
    if (inv) inv.potion = def.potions;
    const player = this.session.player;
    if (player) { a.beliefs.observe(player.id, player.faction, player.pos, 0, false); const b = a.beliefs.get(player.id); if (b) b.standing = t.loyalty * 2 - 1; }
    this.companionAgents.set(k, a);
    return a;
  }

  private spawn(name: string, faction: string, model: string, pos: THREE.Vector3, personality: Record<string, number>, combatant: boolean): AgentT {
    const sim = this.session.sim as unknown as { makeFighter(m: string, o?: object): { root: { position: THREE.Vector3 } }; scene: { add(o: unknown): void }; agents: AgentT[]; agentsById: Map<unknown, AgentT>; _nextId: number };
    const f = sim.makeFighter(model, {});
    f.root.position.copy(pos);
    sim.scene.add(f.root);
    const a = new Agent(f as never, { id: sim._nextId++, name, profession: null, personality, faction, combatant, controlled: false }) as unknown as AgentT;
    sim.agents.push(a); sim.agentsById.set(a.id, a);
    return a;
  }

  private cleanupStage(): void {
    const sim = this.session.sim as unknown as { scene: { remove(o: unknown): void }; agents: AgentT[]; agentsById: Map<unknown, AgentT> };
    for (const a of this.stageAgents) {
      a._encounter = null;
      try { sim.scene.remove(a.fighter.root); (a.fighter as { dispose?: () => void }).dispose?.(); } catch { /* headless */ }
      const i = sim.agents.indexOf(a); if (i >= 0) sim.agents.splice(i, 1);
      sim.agentsById.delete(a.id);
    }
    this.stageAgents = [];
    this.battle = null;
  }
}
