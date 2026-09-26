// CONSUMABLES: what people carry into a fight and spend once — you, your companions, the foes.
// Kits persist across stages and runs (run.ts), foes' kits are loot, and the town sells more.
// Effects resolve in Battle.useItem from the same primitives as everything else (heal, smoke,
// oil that goes up when fire touches it, caltrops that stop you dead, bolas, wolfsbane).

export type ItemId = 'bandage' | 'draught' | 'oilflask' | 'smokepot' | 'caltrops' | 'flash' | 'bola' | 'wolfsbane';
export type Kit = Partial<Record<ItemId, number>>;

export interface ItemDef {
  id: ItemId;
  name: string;
  icon: string;
  /** Silver in town. */
  price: number;
  /** Who or what it's used on: yourself or a friend beside you, a foe, or a spot on the ground. */
  aim: 'mend' | 'foe' | 'ground';
  range: number;
  describe: string;
  /** How players name it. */
  nouns: string[];
}

export const ITEMS: Record<ItemId, ItemDef> = {
  bandage:   { id: 'bandage', name: 'a bandage', icon: '🩹', price: 4, aim: 'mend', range: 1, describe: 'binds a wound (+20), or gets a downed friend back on their feet', nouns: ['bandage', 'bandages', 'dressing', 'bind the wound', 'bind his wound', 'bind her wound'] },
  draught:   { id: 'draught', name: 'a healing draught', icon: '🧪', price: 10, aim: 'mend', range: 1, describe: 'a long swallow: +40, and it puts out the burning', nouns: ['draught', 'healing draught', 'tonic', 'elixir', 'drink'] },
  oilflask:  { id: 'oilflask', name: 'a flask of lamp oil', icon: '🫙', price: 6, aim: 'ground', range: 4, describe: 'splashes oil over a 3×3 patch — it goes up the moment fire touches it', nouns: ['oil flask', 'flask of oil', 'lamp oil', 'flask'] },
  smokepot:  { id: 'smokepot', name: 'a smoke pot', icon: '💨', price: 6, aim: 'ground', range: 4, describe: 'a 3×3 cloud for three rounds: no one sees through it, archers can\'t find you', nouns: ['smoke pot', 'smoke bomb', 'smoke', 'smoke screen'] },
  caltrops:  { id: 'caltrops', name: 'a bag of caltrops', icon: '📍', price: 5, aim: 'ground', range: 2, describe: 'scatters spikes: whoever steps there is hurt and stopped dead', nouns: ['caltrops', 'spikes', 'tacks', 'iron spikes'] },
  flash:     { id: 'flash', name: 'a pouch of flash powder', icon: '✨', price: 7, aim: 'ground', range: 4, describe: 'a blinding burst over 3×3: exposed, and some are stunned', nouns: ['flash powder', 'flash', 'powder', 'blinding powder'] },
  bola:      { id: 'bola', name: 'a bola', icon: '🪢', price: 5, aim: 'foe', range: 4, describe: 'tangles the legs: badly slowed for a while', nouns: ['bola', 'bolas', 'weighted rope'] },
  wolfsbane: { id: 'wolfsbane', name: 'a sprig of wolfsbane', icon: '🌿', price: 8, aim: 'ground', range: 3, describe: 'burning wolfsbane: beasts near it break and run (their leader only flinches)', nouns: ['wolfsbane', 'bane', 'wolf bane'] },
};

export const ITEM_ORDER = Object.keys(ITEMS) as ItemId[];

/** What each kind of fighter carries by default. */
export const KITS: Record<string, Kit> = {
  player: { bandage: 2, oilflask: 1, smokepot: 1 },
  borin: { draught: 1 }, wren: { bola: 2 }, pip: { smokepot: 1, caltrops: 1 }, maud: { bandage: 3, draught: 1 },
  brute: { oilflask: 1 }, archer: { bola: 1 }, leader: { draught: 1, flash: 1 }, skirmisher: { caltrops: 1 }, guardian: { bandage: 1 },
};

export const kitCount = (k: Kit | undefined): number => Object.values(k ?? {}).reduce((a, n) => a + (n ?? 0), 0);
export function addKit(into: Kit, from: Kit): void { for (const id of ITEM_ORDER) if (from[id]) into[id] = (into[id] ?? 0) + from[id]!; }
export const kitWords = (k: Kit): string => ITEM_ORDER.filter((id) => (k[id] ?? 0) > 0).map((id) => `${k[id]}× ${ITEMS[id].name.replace(/^an? /, '')}`).join(', ');
