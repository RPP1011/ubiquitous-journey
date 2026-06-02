// Configuration for the small market economy. Agents have professions (not
// factions); everyone needs food; specialists trade at a market using per-agent
// PRICE BELIEFS that update from trades and spread by gossip — the economic
// belief surface from the spec's economy.md.

// --- commodities ------------------------------------------------------------
export const COMMODITIES = ['food', 'wood', 'ore', 'tool', 'herb', 'potion'];
export const BASE_PRICE = { food: 4, wood: 3, ore: 5, tool: 14, herb: 3, potion: 12 };

// --- professions ------------------------------------------------------------
// raw producers make a good at their site; the smith converts wood+ore -> tool.
// Tools wear out as everyone works, creating recurring demand that closes the
// money loop (food←all, raw←smith, tools←all).
export const PROFESSIONS = {
  farmer:     { label: 'Farmer',     color: 0xe0c04a, model: 'knight',    site: 'field',  output: 'food' },
  woodcutter: { label: 'Woodcutter', color: 0x5f8f3a, model: 'knight',    site: 'forest', output: 'wood' },
  miner:      { label: 'Miner',      color: 0x9aa0a8, model: 'barbarian', site: 'mine',   output: 'ore'  },
  smith:      { label: 'Smith',      color: 0xcf6a2c, model: 'barbarian', site: 'forge',  output: 'tool', inputs: { wood: 1, ore: 1 } },
  forager:    { label: 'Forager',    color: 0x8fbf6a, model: 'knight',    site: 'meadow', output: 'herb' },
  apothecary: { label: 'Apothecary', color: 0x7fb0c0, model: 'knight',    site: 'hut',    output: 'potion', inputs: { herb: 1 } },
};

// who spawns
export const ROSTER = [
  { profession: 'farmer',     n: 6 },
  { profession: 'woodcutter', n: 5 },
  { profession: 'miner',      n: 5 },
  { profession: 'smith',      n: 3 },
  { profession: 'forager',    n: 3 },
  { profession: 'apothecary', n: 1 },
];

// --- economy tuning ---------------------------------------------------------
export const ECON = {
  startGold: 40,
  startStock: 2,              // units of own output to start with
  keep: { food: 3, wood: 1, ore: 1, tool: 1, herb: 1, potion: 1 }, // reserve kept for personal use
  maxStack: 24,

  produceRate: 0.32,          // units/sec for raw producers
  toolBoost: 1.7,             // production multiplier while holding a tool
  toolWearPerGain: 0.10,      // tools worn PER UNIT produced (closes the money loop)
  smithSecsPerTool: 4.5,      // smith time to forge one tool (needs inputs)

  eatRate: 0.5,               // hunger restored per sec while eating (1:1 food)

  // price-belief learning (decentralised tatonnement -> competitive prices)
  priceLearn: 0.25,           // participant belief moves toward the clearing price
  priceGossip: 0.04,          // per-sec drift toward a chatting neighbour
  tatonnementUp: 1.004,       // unfilled buyers raise their bid belief each tick
  tatonnementDown: 0.996,     // unfilled sellers lower their ask belief each tick
  priceBounds: [1, 40],

  tradesPerCommodityPerTick: 6,
};

// utility weights per action
export const WEIGHT = {
  eat:       1.40,
  market:    1.00,
  work:      0.80,
  rest:      0.85,
  socialize: 0.70,
  wander:    0.15,
  fight:     1.60,
  flee:      1.80,
};

// Baseline hostility between true factions (before reputation/standing).
// Monsters are hostile to everyone non-monster; townsfolk/outsider are at peace
// until reputation (Phase 3) makes the player an enemy.
export function factionHostile(a, b) {
  if (a === b) return false;
  return a === 'monster' || b === 'monster';
}

// Monster threat that lurks in the wilds and attacks the village/player.
export const MONSTER = { count: 6, model: 'barbarian', faction: 'monster', name: 'Bandit', threat: 1.1 };

// --- general sim tuning (shared with movement/perception) -------------------
export const SIM = {
  tickHz: 6,
  talkRange: 4.5,            // gossip range (prices AND beliefs)
  moveSpeed: 3.4,
  runSpeed: 5.6,
  arriveDist: 0.7,

  hungerDrain: 1 / 95,
  energyDrain: 1 / 140,
  socialDrain: 1 / 90,
  restRate: 0.40,
  socializeRate: 0.50,

  // --- Theory-of-Mind (belief layer) ---
  visionRange: 14,          // how far an agent perceives others
  beliefsPerAgent: 12,      // bounded ToM table size
  gossipFalloff: 0.85,      // confidence multiplier when a belief is passed along
  gossipCap: 0.8,           // ceiling on second-hand confidence
  confidenceDecay: 1 / 240, // belief certainty fades per second
  suspicionDecay: 1 / 120,
  actOnBeliefMin: 0.35,     // min confidence to act on a believed-hostility
};

// Information provenance: how an agent learned something sets its confidence.
export const SOURCE = {
  WITNESSED: { tag: 'witnessed', conf: 1.0 },
  TALKED:    { tag: 'talked',    conf: 0.8 },
  OVERHEARD: { tag: 'overheard', conf: 0.6 },
  RUMOR:     { tag: 'rumor',     conf: 0.4 },
};

// Factions (RPG layer). Townsfolk are the village; the player is an outsider.
export const FACTIONS = {
  townsfolk: { label: 'Townsfolk', color: 0x6fb7ff },
  outsider:  { label: 'Outsider',  color: 0xeaeaea },
  wilds:     { label: 'Wilds',     color: 0x5f9f4f },
  monster:   { label: 'Monsters',  color: 0x8a3b3b },
};

export const NAMES = [
  'Bjorn', 'Astrid', 'Cedric', 'Mira', 'Tomas', 'Greta', 'Ulric', 'Sela',
  'Dain', 'Romy', 'Hollis', 'Yara', 'Pavel', 'Edda', 'Nils', 'Wren',
  'Garrik', 'Osric', 'Pell', 'Vesna', 'Corin', 'Halla', 'Sten', 'Lda',
];

export const PLAYER_COLOR = 0xeaeaea;
