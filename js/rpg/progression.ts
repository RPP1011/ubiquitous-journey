// Progression: the per-agent class/level/XP brain. One instance per Agent.
//
//   onEvent(ev, now)  — fold a deed into the behavior_profile and route its XP
//                       to the agent's best-matching classes (leveling them).
//   tick(now)         — periodically decay the profile and run the class
//                       matcher (granting new classes / consolidating).
//
// Classes are a Map<key,{key,name,level,xp}>. Abilities/cooldowns are held here
// too and granted at tier milestones via the abilities catalog — but the whole
// catalog is OPTIONAL: it's loaded lazily and Progression degrades to "no
// abilities" if the module is missing or broken (the two subsystems are built
// in parallel, so we must not hard-depend on it).

import { RPG } from './rpgconfig.js';
import {
  matchClasses, proceduralName, proceduralKey, behaviorSum, CLASS_BY_KEY, eventAffinity,
} from './classes.js';
import { significance, classMatchScore, xpFromEvent, xpForLevel } from './xp.js';
import { bus, makeEvent } from './events.js';
import { recordDeed, recordClassXp } from './xpstats.js';
import type {
  Agent, ActionEvent, BehaviorProfile, Tag, AbilitySpec, CatalogModule,
  ClassInstance, ClassTemplate, Significance,
} from '../../types/sim.js';

// generate.js generates an ability spec themed by a class + tier index.
type GenModule = { generateAbility: (cls: GenClassDesc, tier: number) => AbilitySpec | null };
type GenClassDesc = { classKey: string; name: string; tags: Tag[] };
// ir.validate is the spec trust-boundary whitelist (defensive re-check).
type ValidateFn = (spec: unknown) => boolean;

// --- optional abilities catalog (lazy, fault-tolerant) ----------------------
// We try to import the catalog once; if it isn't there yet (or throws), we just
// run without granting abilities. _catalog stays null and milestone hooks no-op.
// The procedural GENERATOR (generate.js) is loaded the same way: when a class
// crosses a tier and the catalog names NO ability for it (every procedural class,
// and template classes past their authored milestones), we MINT one from the
// class's dominant tags. Both imports degrade to "no abilities" if absent.
let _catalog: CatalogModule | null = null;   // { ABILITY_CATALOG, CLASS_MILESTONES } or null
let _gen: GenModule | null = null;           // { generateAbility } or null
let _validate: ValidateFn | null = null;     // ir.validate (defensive re-check before grant)
let _catalogTried = false;
function ensureCatalog() {
  if (_catalogTried) return;
  _catalogTried = true;
  import('./abilities/catalog.js')
    .then((m) => {
      if (m && m.ABILITY_CATALOG) {
        _catalog = { ABILITY_CATALOG: m.ABILITY_CATALOG, CLASS_MILESTONES: m.CLASS_MILESTONES || {} };
      }
    })
    .catch(() => { /* abilities subsystem absent — degrade gracefully */ });
  import('./abilities/generate.js')
    .then((m) => { if (m && m.generateAbility) _gen = { generateAbility: m.generateAbility }; })
    .catch(() => { /* generator absent — template classes only */ });
  import('./abilities/ir.js')
    .then((m) => { if (m && m.validate) _validate = m.validate; })
    .catch(() => { /* ir absent — generator already self-validates */ });
}

// MECHANICAL SIGNATURE of a spec — what the ability DOES, independent of id/name/
// class flavour: each effect's op + rounded magnitude/duration + trigger, plus the
// target / delivery kind / area kind. Two specs with equal signatures are the same
// move under different names. Pure; exported for the direct suite test.
export function abilitySignature(spec: AbilitySpec): string {
  const h = spec.header;
  const fx = (spec.effects || [])
    .map((e) => `${e.op}:${Math.round((e.amount || 0) * 10) / 10}:${Math.round((e.dur || 0) * 10) / 10}:${e.when || ''}`)
    .join('|');
  return `${h.target}/${h.delivery.kind}/${h.area.kind}/${fx}`;
}

// The milestone tiers a class can cross, lowest first. Sorted defensively so we
// fire 1 -> 5 -> 10 -> 20 in order regardless of config order; the tier INDEX
// (1-based position) is what we hand the generator so power scales sanely (the
// generator scales off a small tier index, not the raw level).
const TIER_LEVELS = [...RPG.tierLevels].sort((a, b) => a - b);

export class Progression {
  agent: Agent;
  behavior_profile: BehaviorProfile;
  classes: Map<string, ClassInstance>;
  abilities: Map<string, AbilitySpec>;
  cooldowns: Map<string, number>;
  _milestonesFired: Set<string>;
  _comboSeen: Set<number>;
  _deedLast: Map<string, number>;
  _lastMatch: number;
  _lastTick: number;
  totalLevel: number;
  narrativeBeats: number;
  narrativeXp: number;

  constructor(agent: Agent) {
    this.agent = agent;

    // weighted behavior tallies: tag -> accumulated weight (decays slowly)
    this.behavior_profile = Object.create(null);

    // granted classes: key -> { key, name, level, xp }
    this.classes = new Map();

    // granted abilities: abilityId -> spec (the IR object from the catalog)
    this.abilities = new Map();
    // ability cooldowns: abilityId -> sim-time the ability is usable again
    this.cooldowns = new Map();
    // which (classKey,level) milestones we've already fired, so we grant once
    this._milestonesFired = new Set();

    // significance bookkeeping (read by xp.significance, written by us)
    this._comboSeen = new Set();   // comboKey -> seen (novelty)
    this._deedLast = new Map();    // verb:comboKey -> last sim time (grind)

    this._lastMatch = 0;           // last class-match time
    this._lastTick = 0;
    this.totalLevel = 0;           // cached sum of class levels (<= cap)
    this.narrativeBeats = 0;       // lifetime count of narrative-beat xp awards
    this.narrativeXp = 0;          // lifetime narrative xp earned (story telemetry)

    ensureCatalog();
  }

  // ---------------------------------------------------------------------------
  // EVENT INTAKE: accumulate behavior + award XP. Called by the bus router in
  // simulation.js for events whose actorId is this agent.
  onEvent(ev: ActionEvent, now: number): void {
    if (!ev || !ev.tags) return;

    // 1) accumulate weighted behavior (magnitude-scaled), clamped per tag
    const w = ev.magnitude || 1;
    for (const tag of ev.tags) {
      const cur = this.behavior_profile[tag] || 0;
      this.behavior_profile[tag] = Math.min(RPG.profileMax, cur + w);
    }

    // 2) compute the significance multiplier (novelty/risk/grind)
    const sig: Significance = significance(ev, this, now);

    // 3) route XP to the best-matching held classes (up to routeTopK). If the
    //    agent has no classes yet, XP is simply deferred until matching grants
    //    one — the behavior profile already recorded the deed.
    let totalGain = 0;
    if (this.classes.size) {
      const scored: Array<{ cls: ClassInstance; score: number }> = [];
      for (const cls of this.classes.values()) {
        const tmpl = CLASS_BY_KEY.get(cls.key);
        // procedural classes have no template; score them off behavior sum so
        // they still level, just diffusely.
        // EVENT-TAG AFFINITY (the all-XP-to-one-class fix): the profile match alone is
        // event-blind — the sigmoid saturates and every deed's XP flowed to the same
        // best-overall class (merchant, measured 103-118/140 primary). Weighting by the
        // DEED's own tags routes a FARMING unit to [Farmer] and a sale to [Merchant]:
        // levels now mirror what the agent actually did. A deed no held class claims
        // (affinity 0 everywhere) defers its XP — same as the no-classes-yet case.
        const score = tmpl ? classMatchScore(this.behavior_profile, tmpl) * eventAffinity(ev.tags, tmpl) : 0.3;
        if (score > 0) scored.push({ cls, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const k = Math.min(RPG.routeTopK, scored.length);
      for (let i = 0; i < k; i++) {
        const { cls, score } = scored[i];
        const gain = xpFromEvent(score, sig.mult);
        if (gain > 0) { this._awardXp(cls, gain, now); totalGain += gain; recordClassXp(cls.key, gain); }
      }
    }
    // XP-allocation telemetry: attribute this deed's XP to its verb (tagged deeds
    // only — skips self-emitted level/class_gained bookkeeping events).
    if (ev.tags.length) recordDeed(ev.verb, totalGain);

    // 4) commit significance bookkeeping (we read these above; write now)
    if (sig.comboKey != null) this._comboSeen.add(sig.comboKey);
    if (sig.deedKey != null) this._deedLast.set(sig.deedKey, now);
  }

  // add XP to a class, resolving level-ups against the canonical curve. Each
  // level-up re-checks ability milestones and emits a LEVEL ActionEvent.
  _awardXp(cls: ClassInstance, amount: number, now: number): void {
    cls.xp += amount;
    let leveled = false;
    // loop in case a big award crosses several levels at once
    while (this.totalLevel < RPG.totalLevelCap) {
      const need = xpForLevel(cls.level, this.totalLevel);
      if (cls.xp < need) break;
      cls.xp -= need;
      cls.level += 1;
      this.totalLevel = this._sumLevels();
      leveled = true;
      this._checkMilestones(cls, now);
    }
    if (this.totalLevel >= RPG.totalLevelCap) cls.xp = 0;  // capped: stop banking
    if (leveled) {
      bus.emit(makeEvent({
        actorId: this.agent.id, verb: 'level', tags: [],
        magnitude: cls.level, targetId: undefined, t: now,
      }));
    }
  }

  _sumLevels(): number {
    let s = 0;
    for (const c of this.classes.values()) s += c.level;
    return Math.min(RPG.totalLevelCap, s);
  }

  // public: award flat XP (e.g. a quest/event reward) to the agent's primary
  // class. If the agent has no class yet, mint a generic [Adventurer] so the
  // reward isn't lost.
  addXP(amount: number, now?: number): void {
    if (!(amount > 0)) return;
    const t = typeof now === 'number' ? now : this._lastTick;   // callers may pass a meta object
    let cls = this.primaryClass();
    if (!cls) { this._grantClass('adventurer', '[Adventurer]', t); cls = this.classes.get('adventurer') || null; }
    if (cls) this._awardXp(cls, amount, t);
  }

  // public: award NARRATIVE-BEAT xp — the GRIND-IMMUNE channel (PHASE 1). The
  // dramatic deeds episodic memory records (a monster slain, a goal-stack
  // closure, a windfall, a witnessed death, a brush with death) drive how much
  // narrative a soul has LIVED, and that — not repetitive labour — is what makes
  // a character storied. The award is `narrativeXpScalar * salience` (salience
  // 0..1, the memory model's "how notable" signal) and bypasses significance/
  // grind decay entirely. Routes to the agent's best-matching classes exactly
  // like a deed (so a fighter's kills feed Warrior, a delver's relics feed their
  // delve class) rather than dumping flat on the primary. Guarded; never throws.
  //   salience  — 0..1 notability (reuse the same value the memory episode used)
  //   now       — sim time
  //   mult      — optional per-beat multiplier (e.g. goal-kind bonus)
  addNarrativeXP(salience: number, now?: number, mult = 1): void {
    const s = Math.max(0, Math.min(1, salience || 0));
    if (s <= 0) return;
    const t = typeof now === 'number' ? now : this._lastTick;
    const pool = RPG.narrativeXpScalar * s * (mult > 0 ? mult : 1);
    if (!(pool > 0)) return;
    // lifetime narrative telemetry (how much STORY this soul has lived) — read by
    // the inspector/bench to classify storied vs quiet lives. Pure bookkeeping.
    this.narrativeBeats = (this.narrativeBeats || 0) + 1;
    this.narrativeXp = (this.narrativeXp || 0) + pool;

    // no class yet -> mint a generic [Adventurer] so the first beat isn't lost
    // (the behaviour profile may not have crossed the grant gate yet, but a
    // person who has already lived a beat deserves to start a story).
    if (!this.classes.size) {
      this._grantClass('adventurer', '[Adventurer]', t);
    }

    // CONCENTRATE the whole beat into the agent's single best-matching class —
    // a storied deed SHARPENS your dominant identity rather than diffusing across
    // five level-1 classes. Concentrating also makes the level number visibly
    // CLIMB (the spread signal: storied lives outlevel quiet ones) instead of
    // smearing the budget thin. Falls back to the primary (top by level) if the
    // profile scores nothing. The whole `pool` is granted once — no minting.
    let best: ClassInstance | null = null;
    let bestScore = -1;
    for (const cls of this.classes.values()) {
      const tmpl = CLASS_BY_KEY.get(cls.key);
      const score = tmpl ? classMatchScore(this.behavior_profile, tmpl) : 0.3;
      if (score > bestScore) { bestScore = score; best = cls; }
    }
    if (!best) best = this.primaryClass();
    if (!best) return;
    this._awardXp(best, pool, t);
    recordClassXp(best.key, pool);
    recordDeed('narrative', pool);
  }

  // ---------------------------------------------------------------------------
  // PERIODIC: profile decay + class matching. Called every 6Hz tick from the
  // sim loop; the heavy matcher only runs on matchIntervalSec.
  tick(now: number): void {
    const dt = this._lastTick ? now - this._lastTick : 0;
    this._lastTick = now;

    // slow forgetting so stale identities fade (keeps the profile responsive)
    if (dt > 0 && RPG.profileDecayPerSec > 0) {
      const keep = Math.max(0, 1 - RPG.profileDecayPerSec * dt);
      for (const tag in this.behavior_profile) {
        const v = (this.behavior_profile[tag as Tag] || 0) * keep;
        if (v < 0.01) delete this.behavior_profile[tag as Tag];
        else this.behavior_profile[tag as Tag] = v;
      }
    }

    if (now - this._lastMatch < RPG.matchIntervalSec) return;
    this._lastMatch = now;
    this._runMatcher(now);
  }

  // grant newly-qualifying classes (respecting the cap + consolidation rules).
  _runMatcher(now: number): void {
    if (this.classes.size >= RPG.maxClasses) return;
    // total level 80+ consolidates onto the highest class: stop minting new ones
    if (this.totalLevel >= RPG.consolidateLevel) return;
    if (behaviorSum(this.behavior_profile) <= RPG.behaviorSumGate) return;

    const held = new Set(this.classes.keys());
    const grants = matchClasses(this.behavior_profile, held);

    if (grants.length) {
      for (const g of grants) {
        if (this.classes.size >= RPG.maxClasses) break;
        this._grantClass(g.key, g.name, now);
      }
      return;
    }

    // procedural fallback: strong behavior but nothing templated matched
    const pKey = proceduralKey(this.behavior_profile);
    if (!this.classes.has(pKey)) {
      this._grantClass(pKey, proceduralName(this.behavior_profile), now);
    }
  }

  _grantClass(key: string, name: string, now: number): void {
    if (this.classes.has(key)) return;
    const cls: ClassInstance = { key, name, level: 1, xp: 0 };
    this.classes.set(key, cls);
    this.totalLevel = this._sumLevels();
    this._checkMilestones(cls, now);   // tier-1 ability at grant
    bus.emit(makeEvent({
      actorId: this.agent.id, verb: 'class_gained', tags: [],
      magnitude: 1, targetId: undefined, t: now,
    }));
  }

  // ---------------------------------------------------------------------------
  // ABILITY MILESTONES. At each tier level a class crosses we grant ONE ability,
  // fired exactly once per (class,level). Resolution order:
  //   1) the catalog names an ability for this class@level  -> grant that spec.
  //   2) otherwise (every procedural class, + template classes past their
  //      authored milestones) -> GENERATE a spec themed by the class's dominant
  //      tags at the crossed tier index.
  // Everything stays guarded/fault-tolerant: a missing catalog/generator/ir, a
  // null spec, or a spec that fails validate() simply skips the grant — the
  // fixed-tick loop must NEVER throw here (the freeze lesson).
  _checkMilestones(cls: ClassInstance, now: number): void {
    // both ability subsystems load lazily/async; until at least one is present we
    // can't resolve any spec — leave the milestone UNFIRED so it retries on the
    // next level-up once the modules have loaded (don't burn it on a cold import).
    if (!_catalog && !_gen) return;
    for (let i = 0; i < TIER_LEVELS.length; i++) {
      const lvl = TIER_LEVELS[i];
      if (cls.level < lvl) break;          // tiers are sorted; nothing higher reached yet
      const fireKey = cls.key + '@' + lvl;
      if (this._milestonesFired.has(fireKey)) continue;
      const spec = this._milestoneSpec(cls, lvl, i + 1);
      if (!spec || !spec.id) continue;     // no spec available -> leave unfired, retry later
      this._milestonesFired.add(fireKey);
      this._grantAbility(spec, lvl, now);
    }
  }

  // Resolve the spec for a class@level: catalog override first, else generated.
  // `tierIndex` is the 1-based position in TIER_LEVELS (what the generator scales
  // off). Returns a validated spec or null.
  _milestoneSpec(cls: ClassInstance, lvl: number, tierIndex: number): AbilitySpec | null {
    // 1) hand-authored catalog override (template classes only).
    if (_catalog) {
      const map = _catalog.CLASS_MILESTONES[cls.key];
      const id = map && map[lvl];
      if (id) {
        const spec = _catalog.ABILITY_CATALOG[id];
        if (spec) return spec;             // authored specs are pre-validated in the catalog
      }
    }
    // 2) procedurally generate one themed by the class's dominant tags.
    if (!_gen) return null;
    let spec: AbilitySpec | null = null;
    try {
      spec = _gen.generateAbility(
        { classKey: cls.key, name: cls.name, tags: this._classTags(cls) },
        tierIndex,
      );
    } catch { spec = null; }               // generator must never break the tick
    // defensive re-check at the trust boundary (the generator already validates,
    // but we re-validate if ir is available so a stale/broken module can't slip
    // an invalid spec onto the cast path).
    if (spec && _validate && !_validate(spec)) return null;
    return spec;
  }

  // The tags that theme a class's generated ability: a TEMPLATE class uses its
  // authored score_tags (its canonical identity); a PROCEDURAL class uses the
  // agent's dominant behavior-profile tags (what it actually DID). Empty is fine
  // — the generator defaults to a combat archetype.
  _classTags(cls: ClassInstance): Tag[] {
    const tmpl = CLASS_BY_KEY.get(cls.key);
    if (tmpl && tmpl.score_tags && tmpl.score_tags.length) {
      return tmpl.score_tags.map((st) => st[0]);
    }
    return this._dominantTags(4);
  }

  // Top-N behavior-profile tags by accumulated weight (descending).
  _dominantTags(n: number): Tag[] {
    const bp = this.behavior_profile;
    return (Object.keys(bp) as Tag[])
      .sort((a, b) => (bp[b] || 0) - (bp[a] || 0))
      .slice(0, n);
  }

  // Mirror a spec onto Progression + the Agent and announce the grant.
  // DUPLICATE-GRANT SUPPRESSION: multi-class agents kept receiving byte-identical
  // generated specs under different ids from different classes (the generator mints
  // from a few fixed archetype templates) and could rotate 2-3 identical slows on
  // independent cooldowns. A grant whose MECHANICAL signature matches a held
  // ability is skipped; if the newcomer is the higher tier of the same mechanics it
  // replaces the held one instead. Guarded — the grant path never throws.
  _grantAbility(spec: AbilitySpec, lvl: number, now: number): void {
    try {
      const sig = abilitySignature(spec);
      for (const held of this.abilities.values()) {
        if (held.id === spec.id || abilitySignature(held) !== sig) continue;
        if ((held.tier || 0) >= (spec.tier || 0)) return;     // keep the held one — skip the twin
        // the newcomer out-tiers the same mechanics: drop the held duplicate, grant the new.
        this.abilities.delete(held.id);
        this.cooldowns.delete(held.id);
        if (this.agent.abilities) this.agent.abilities.delete(held.id);
        break;
      }
    } catch { /* never throw on the grant path (the freeze lesson) */ }
    this.abilities.set(spec.id, spec);
    this.cooldowns.set(spec.id, 0);
    this.agent.grantAbility?.(spec);       // mirror onto the Agent (UI + cast path)
    bus.emit(makeEvent({
      actorId: this.agent.id, verb: 'ability_gained', tags: [],
      magnitude: lvl, targetId: undefined, t: now,
    }));
  }

  // ---------------------------------------------------------------------------
  // QUERIES
  // top-N classes by level (ties broken by xp), for the inspector / UI.
  topClasses(n = 3): ClassInstance[] {
    return [...this.classes.values()]
      .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
      .slice(0, n);
  }

  // the single highest class (the "consolidation" target), or null.
  primaryClass(): ClassInstance | null {
    return this.topClasses(1)[0] || null;
  }

  // is an ability off cooldown at time `now`? (used by the interpreter, which
  // also owns setting cooldowns — kept here for symmetry/UI.)
  isReady(abilityId: string, now: number): boolean {
    return (this.cooldowns.get(abilityId) || 0) <= now;
  }
}
