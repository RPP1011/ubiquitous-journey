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
  matchClasses, proceduralName, proceduralKey, behaviorSum, CLASS_BY_KEY,
} from './classes.js';
import { significance, classMatchScore, xpFromEvent, xpForLevel } from './xp.js';
import { bus, makeEvent } from './events.js';

// --- optional abilities catalog (lazy, fault-tolerant) ----------------------
// We try to import the catalog once; if it isn't there yet (or throws), we just
// run without granting abilities. _catalog stays null and milestone hooks no-op.
let _catalog = null;          // { ABILITY_CATALOG, CLASS_MILESTONES } or null
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
}

export class Progression {
  constructor(agent) {
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

    ensureCatalog();
  }

  // ---------------------------------------------------------------------------
  // EVENT INTAKE: accumulate behavior + award XP. Called by the bus router in
  // simulation.js for events whose actorId is this agent.
  onEvent(ev, now) {
    if (!ev || !ev.tags) return;

    // 1) accumulate weighted behavior (magnitude-scaled), clamped per tag
    const w = ev.magnitude || 1;
    for (const tag of ev.tags) {
      const cur = this.behavior_profile[tag] || 0;
      this.behavior_profile[tag] = Math.min(RPG.profileMax, cur + w);
    }

    // 2) compute the significance multiplier (novelty/risk/grind)
    const sig = significance(ev, this, now);

    // 3) route XP to the best-matching held classes (up to routeTopK). If the
    //    agent has no classes yet, XP is simply deferred until matching grants
    //    one — the behavior profile already recorded the deed.
    if (this.classes.size) {
      const scored = [];
      for (const cls of this.classes.values()) {
        const tmpl = CLASS_BY_KEY.get(cls.key);
        // procedural classes have no template; score them off behavior sum so
        // they still level, just diffusely.
        const score = tmpl ? classMatchScore(this.behavior_profile, tmpl) : 0.3;
        if (score > 0) scored.push({ cls, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const k = Math.min(RPG.routeTopK, scored.length);
      for (let i = 0; i < k; i++) {
        const { cls, score } = scored[i];
        const gain = xpFromEvent(score, sig.mult);
        if (gain > 0) this._awardXp(cls, gain, now);
      }
    }

    // 4) commit significance bookkeeping (we read these above; write now)
    if (sig.comboKey != null) this._comboSeen.add(sig.comboKey);
    if (sig.deedKey != null) this._deedLast.set(sig.deedKey, now);
  }

  // add XP to a class, resolving level-ups against the canonical curve. Each
  // level-up re-checks ability milestones and emits a LEVEL ActionEvent.
  _awardXp(cls, amount, now) {
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
        magnitude: cls.level, t: now,
      }));
    }
  }

  _sumLevels() {
    let s = 0;
    for (const c of this.classes.values()) s += c.level;
    return Math.min(RPG.totalLevelCap, s);
  }

  // ---------------------------------------------------------------------------
  // PERIODIC: profile decay + class matching. Called every 6Hz tick from the
  // sim loop; the heavy matcher only runs on matchIntervalSec.
  tick(now) {
    const dt = this._lastTick ? now - this._lastTick : 0;
    this._lastTick = now;

    // slow forgetting so stale identities fade (keeps the profile responsive)
    if (dt > 0 && RPG.profileDecayPerSec > 0) {
      const keep = Math.max(0, 1 - RPG.profileDecayPerSec * dt);
      for (const tag in this.behavior_profile) {
        const v = this.behavior_profile[tag] * keep;
        if (v < 0.01) delete this.behavior_profile[tag];
        else this.behavior_profile[tag] = v;
      }
    }

    if (now - this._lastMatch < RPG.matchIntervalSec) return;
    this._lastMatch = now;
    this._runMatcher(now);
  }

  // grant newly-qualifying classes (respecting the cap + consolidation rules).
  _runMatcher(now) {
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

  _grantClass(key, name, now) {
    if (this.classes.has(key)) return;
    const cls = { key, name, level: 1, xp: 0 };
    this.classes.set(key, cls);
    this.totalLevel = this._sumLevels();
    this._checkMilestones(cls, now);   // tier-1 ability at grant
    bus.emit(makeEvent({
      actorId: this.agent.id, verb: 'class_gained', tags: [],
      magnitude: 1, t: now,
    }));
  }

  // ---------------------------------------------------------------------------
  // ABILITY MILESTONES (optional). At each tier level a class crosses, grant the
  // ability the catalog assigns it. Safe no-op when the catalog is absent.
  _checkMilestones(cls, now) {
    if (!_catalog) return;
    const map = _catalog.CLASS_MILESTONES[cls.key];
    if (!map) return;
    for (const lvlStr in map) {
      const lvl = +lvlStr;
      if (cls.level < lvl) continue;
      const fireKey = cls.key + '@' + lvl;
      if (this._milestonesFired.has(fireKey)) continue;
      const abilityId = map[lvlStr];
      const spec = _catalog.ABILITY_CATALOG[abilityId];
      this._milestonesFired.add(fireKey);
      if (!spec) continue;
      this.abilities.set(abilityId, spec);
      this.cooldowns.set(abilityId, 0);
      bus.emit(makeEvent({
        actorId: this.agent.id, verb: 'ability_gained', tags: [],
        magnitude: lvl, t: now,
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // QUERIES
  // top-N classes by level (ties broken by xp), for the inspector / UI.
  topClasses(n = 3) {
    return [...this.classes.values()]
      .sort((a, b) => (b.level - a.level) || (b.xp - a.xp))
      .slice(0, n);
  }

  // the single highest class (the "consolidation" target), or null.
  primaryClass() {
    return this.topClasses(1)[0] || null;
  }

  // is an ability off cooldown at time `now`? (used by the interpreter, which
  // also owns setting cooldowns — kept here for symmetry/UI.)
  isReady(abilityId, now) {
    return (this.cooldowns.get(abilityId) || 0) <= now;
  }
}
