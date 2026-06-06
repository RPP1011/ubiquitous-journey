// Sim-wide XP allocation telemetry: which ACTION VERBS earn how much XP (and how
// often they fire), and which CLASSES receive it. Populated by Progression on
// every award; reset per world. Read by the Class Codex UI. Pure aggregation —
// it never influences behaviour, so it's safe on the fixed tick.

const _verb = new Map();   // verb -> { xp, n }  (n = tagged deeds of this verb)
const _class = new Map();  // classKey -> xp
let _total = 0;            // total XP routed this world

// one tagged deed: count it under its verb and add whatever XP it routed (0 if
// the actor has no class yet — so you can see high-frequency, low-yield actions).
export function recordDeed(verb, gain) {
  const g = gain > 0 ? gain : 0;
  _total += g;
  const v = _verb.get(verb) || { xp: 0, n: 0 };
  v.xp += g; v.n += 1;
  _verb.set(verb, v);
}

export function recordClassXp(classKey, gain) {
  if (gain > 0) _class.set(classKey, (_class.get(classKey) || 0) + gain);
}

export function resetXpStats() { _verb.clear(); _class.clear(); _total = 0; }

export function xpByVerb() {
  return [..._verb.entries()].map(([verb, d]) => ({ verb, xp: d.xp, n: d.n })).sort((a, b) => b.xp - a.xp);
}
export function xpByClass() {
  return [..._class.entries()].map(([key, xp]) => ({ key, xp })).sort((a, b) => b.xp - a.xp);
}
export function xpTotal() { return _total; }
