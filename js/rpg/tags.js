// Behavior TAG vocabulary + a tiny FNV-1a hash. Every deed an agent performs
// emits an ActionEvent carrying a few of these tags; Progression accumulates
// them (weighted by magnitude) into a behavior_profile that the class matcher
// tests against CLASS_TEMPLATES. Tags are the atoms of identity in this sim —
// keep the vocabulary canonical and stable (the hash is used for cheap
// novelty/combo keys, so renaming a tag changes its identity on purpose).

// FNV-1a, 32-bit. Deterministic, dependency-free, good spread for short keys.
// Returns an unsigned 32-bit int.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Hash an unordered set of tags into a single stable key (for novel-combo
// detection): sort so {A,B} and {B,A} collide, join, then FNV.
export function comboKey(tags) {
  return fnv1a([...tags].sort().join('|'));
}

// The canonical ~30-tag vocabulary, grouped by domain. Exposed both as a flat
// frozen set (TAGS) and grouped (TAG_GROUPS) for UI/debug.
export const TAG_GROUPS = {
  combat:   ['MELEE', 'DEFENSE', 'KILL', 'RISK', 'BERSERK', 'DUEL'],
  craft:    ['SMITHING', 'CRAFTING', 'TOOLMAKING'],
  gather:   ['FARMING', 'MINING', 'WOODCUT', 'FORAGE'],
  trade:    ['TRADE', 'PROFIT', 'HAGGLE', 'BARTER'],
  social:   ['PERSUADE', 'GOSSIP', 'DECEIVE', 'LEAD', 'CHARM'],
  survival: ['ENDURANCE', 'EXPLORE', 'HEAL', 'WANDER', 'HUNGER', 'FLEE', 'STEALTH'],
};

// Flat lookup. TAGS.MELEE === 'MELEE', etc. Frozen so a typo throws in strict
// callers rather than silently inventing a tag.
export const TAGS = Object.freeze(
  Object.values(TAG_GROUPS).flat().reduce((o, t) => { o[t] = t; return o; }, {}),
);

// All tag names as a plain array (stable order = group order).
export const TAG_LIST = Object.values(TAG_GROUPS).flat();

// Is t a known tag? Cheap guard for event producers / validators.
export function isTag(t) { return Object.prototype.hasOwnProperty.call(TAGS, t); }

// Filter an arbitrary tag list down to the known vocabulary (drops typos).
export function sanitizeTags(tags) {
  return (tags || []).filter(isTag);
}
