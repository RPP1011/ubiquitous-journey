// QUESTS: multi-stage undertakings, each stage a tactical battle in a different part of the
// world (forest road, farmland, hills, a mine mouth, a wolf den). Stages carry authored props,
// a cast of foes with roles, and an OBJECTIVE beyond "kill everyone": free a captive, carry out
// a relic, take a chief (alive, if you want).

import type { PropKind } from '../tactics/map.js';
import type { Tactic } from '../tactics/battle.js';

export type Biome = 'forest' | 'plains' | 'hills' | 'wilds';
export type StageObjective = 'defeat' | 'rescue' | 'chief' | 'retrieve';

export interface FoeDef {
  name: string;
  faction: 'bandit' | 'monster' | 'rival';
  tactic: Tactic;
  at: [number, number];               // grid coords on the 16×16 map
  model?: 'knight' | 'barbarian' | 'rogue' | 'hooded';
  hp?: number;
  bonus?: Partial<Record<'might' | 'finesse' | 'presence' | 'nerve', number>>;
  move?: number;
  abilities?: string[];
  risk?: number;
  tags?: string[];                    // 'chief' | 'kin:<hubNpcKey>'
  epithet?: string;
  gold?: number;
}

export interface StageDef {
  id: string;
  name: string;
  biome: Biome;
  radius: [number, number];           // where in the world (distance from the town)
  intro: string;
  objective: StageObjective;
  objectiveText: string;
  foes: FoeDef[];
  props: Array<[PropKind, number, number]>;
  trees?: number;                     // density of scattered trees (forest)
  captive?: { name: string; at: [number, number]; hubKin?: string };
  relicAt?: [number, number];
  partyAt: Array<[number, number]>;
  rise?: { at: [number, number]; r: number; h: number };   // authored high ground (levels)
}

export interface QuestDef {
  id: string;
  title: string;
  giver: string;                      // hub npc key
  pitch: string;
  stages: StageDef[];
}

const PARTY_SOUTH: Array<[number, number]> = [[7, 13], [8, 13], [6, 14], [9, 14], [8, 14]];

export const QUESTS: Record<string, QuestDef> = {
  blackthorn: {
    id: 'blackthorn', title: 'The Blackthorn Raiders', giver: 'reeve',
    pitch: 'Raiders took Elsie Miller off the mill road three nights ago. Follow the Old Road, find where they hold her, and deal with their chief — Garrick the Red.',
    stages: [
      {
        id: 'old_road', name: 'the Old Road', biome: 'forest', radius: [60, 220], objective: 'defeat',
        intro: 'An overturned merchant cart blocks the forest road. Too neat. Someone is waiting in the trees.',
        objectiveText: 'Break the ambush.',
        trees: 0.12,
        props: [['cart', 7, 7], ['crate', 6, 7], ['crate', 9, 8], ['log', 4, 9], ['log', 11, 6], ['hay', 12, 9], ['torch', 8, 5], ['barrel', 5, 5]],
        foes: [
          { name: 'Col Garrow', faction: 'bandit', tactic: 'brute', at: [7, 5], risk: 0.45, gold: 14, tags: ['kin:tom'] },
          { name: 'Nell Sparrow', faction: 'bandit', tactic: 'archer', at: [11, 3], abilities: ['shortbow'], bonus: { finesse: 1 }, gold: 9 },
          { name: 'Fitch', faction: 'bandit', tactic: 'skirmisher', at: [4, 4], move: 5, risk: 0.3, gold: 6 },
        ],
        partyAt: PARTY_SOUTH,
      },
      {
        id: 'mill', name: 'the Burnt Mill', biome: 'plains', radius: [80, 260], objective: 'rescue',
        intro: 'Smoke over the old mill. Elsie is tied to a post by the hay store, and the raiders have oil barrels stacked by the door.',
        objectiveText: 'Cut Elsie free and get her out alive.',
        props: [['hay', 5, 6], ['hay', 6, 6], ['hay', 9, 6], ['hay', 10, 6], ['oil', 8, 4], ['oil', 7, 4], ['campfire', 11, 9], ['well', 3, 10], ['bucket', 4, 10], ['table', 9, 9], ['crate', 12, 4]],
        captive: { name: 'Elsie Miller', at: [7, 6], hubKin: 'nan' },
        foes: [
          { name: 'Hob Tanner', faction: 'bandit', tactic: 'brute', at: [7, 4], risk: 0.6, gold: 10 },
          { name: 'Moll', faction: 'bandit', tactic: 'archer', at: [12, 3], abilities: ['shortbow'], bonus: { finesse: 1 }, gold: 8 },
          { name: 'Dun Crake', faction: 'bandit', tactic: 'brute', at: [4, 5], risk: 0.5, gold: 11 },
          { name: 'Wick', faction: 'bandit', tactic: 'skirmisher', at: [10, 8], move: 5, gold: 5 },
        ],
        partyAt: PARTY_SOUTH,
      },
      {
        id: 'camp', name: 'Blackthorn Camp', biome: 'hills', radius: [120, 320], objective: 'chief',
        intro: 'The raiders\' camp sits on a rise between the rocks. Braziers, tents, and Garrick the Red watching from the high ground.',
        objectiveText: 'Take Garrick the Red — dead or alive.',
        rise: { at: [8, 3], r: 3, h: 3 },
        props: [['tent', 4, 3], ['tent', 12, 3], ['brazier', 6, 5], ['brazier', 10, 5], ['crate', 3, 7], ['barrel', 13, 7], ['oil', 11, 2], ['rocks', 7, 9], ['log', 9, 10]],
        foes: [
          { name: 'Garrick the Red', faction: 'bandit', tactic: 'leader', at: [8, 3], model: 'barbarian', bonus: { might: 2, nerve: 3, presence: 2 }, abilities: ['power_strike'], epithet: 'the Red', tags: ['chief'], gold: 40, risk: 0.7 },
          { name: 'Brann', faction: 'bandit', tactic: 'brute', at: [6, 6], bonus: { might: 1 }, gold: 8 },
          { name: 'Sella', faction: 'bandit', tactic: 'archer', at: [10, 2], abilities: ['shortbow'], gold: 7 },
          { name: 'Hollis', faction: 'bandit', tactic: 'brute', at: [10, 6], gold: 9 },
        ],
        partyAt: PARTY_SOUTH,
      },
    ],
  },
  reliquary: {
    id: 'reliquary', title: 'The Stolen Reliquary', giver: 'anselm',
    pitch: 'The Crowe Company — sellswords, not bandits — took the chapel\'s silver reliquary "in lieu of payment". They are heading for the old mine to fence it. Bring it home.',
    stages: [
      {
        id: 'crossroads', name: 'the Crossroads', biome: 'plains', radius: [90, 260], objective: 'defeat',
        intro: 'Two of Crowe\'s scouts and a hired thug are watering horses at the crossroads well.',
        objectiveText: 'Deal with the scouts before they warn the others.',
        props: [['well', 8, 8], ['bucket', 9, 8], ['cart', 5, 6], ['crate', 11, 5], ['table', 10, 9], ['barrel', 4, 9], ['flour', 6, 9], ['campfire', 12, 11]],
        foes: [
          { name: 'Jory Crowe', faction: 'rival', tactic: 'skirmisher', at: [7, 5], move: 5, gold: 18 },
          { name: 'Tamsin', faction: 'rival', tactic: 'archer', at: [11, 4], abilities: ['shortbow'], gold: 12 },
          { name: 'Big Aud', faction: 'rival', tactic: 'brute', at: [9, 6], bonus: { might: 2 }, hp: 120, gold: 6 },
        ],
        partyAt: PARTY_SOUTH,
      },
      {
        id: 'mine', name: 'the Mine Mouth', biome: 'hills', radius: [120, 320], objective: 'defeat',
        intro: 'Lamp oil, mine carts and torches at the mouth of the old Hollowdeep mine. Crowe\'s men have built a barricade.',
        objectiveText: 'Break the barricade.',
        rise: { at: [4, 4], r: 2, h: 3 },
        props: [['cart', 7, 6], ['cart', 9, 6], ['oil', 8, 4], ['torch', 6, 3], ['torch', 10, 3], ['rocks', 5, 8], ['rocks', 11, 8], ['crate', 12, 5], ['barrel', 3, 6]],
        foes: [
          { name: 'Edda Crowe', faction: 'rival', tactic: 'leader', at: [8, 3], bonus: { presence: 2, nerve: 2 }, gold: 20 },
          { name: 'Rook', faction: 'rival', tactic: 'archer', at: [4, 4], abilities: ['shortbow'], gold: 10 },
          { name: 'Grist', faction: 'rival', tactic: 'brute', at: [8, 5], bonus: { might: 1 }, gold: 8 },
          { name: 'Pell', faction: 'rival', tactic: 'brute', at: [11, 4], gold: 8 },
        ],
        partyAt: PARTY_SOUTH,
      },
      {
        id: 'ruin', name: 'the Chapel Ruin', biome: 'hills', radius: [150, 360], objective: 'retrieve',
        intro: 'Silas Crowe waits in a roofless old chapel with the reliquary on the altar stone. He smiles like a man who has already been paid.',
        objectiveText: 'Recover the reliquary and carry it out.',
        relicAt: [8, 3],
        props: [['brazier', 6, 4], ['brazier', 10, 4], ['table', 8, 5], ['crate', 4, 7], ['crate', 12, 7], ['log', 7, 10], ['barrel', 3, 3]],
        foes: [
          { name: 'Silas Crowe', faction: 'rival', tactic: 'leader', at: [8, 2], model: 'barbarian', bonus: { might: 2, presence: 3, nerve: 2 }, abilities: ['power_strike'], epithet: 'the Smiling', tags: ['chief'], gold: 45, risk: 0.6 },
          { name: 'Marl', faction: 'rival', tactic: 'brute', at: [6, 3], gold: 9 },
          { name: 'Ivo', faction: 'rival', tactic: 'archer', at: [11, 2], abilities: ['shortbow'], gold: 9 },
          { name: 'Dace', faction: 'rival', tactic: 'skirmisher', at: [4, 5], move: 5, gold: 7 },
        ],
        partyAt: PARTY_SOUTH,
      },
    ],
  },
  wolves: {
    id: 'wolves', title: 'The Grey Mother', giver: 'hilde',
    pitch: 'Something is driving the wolves out of Hollow Wood — a great grey she-wolf. They took my apprentice\'s leg. Go into the wood and end it.',
    stages: [
      {
        id: 'sheepfold', name: 'the Sheepfold', biome: 'plains', radius: [70, 240], objective: 'defeat',
        intro: 'Dusk at the high sheepfold. The flock is gone quiet. Eyes in the grass.',
        objectiveText: 'Drive off the pack.',
        props: [['log', 5, 8], ['log', 6, 8], ['log', 10, 8], ['log', 11, 8], ['hay', 8, 10], ['campfire', 8, 9], ['torch', 3, 11], ['bucket', 12, 11]],
        foes: [
          { name: 'Gaunt wolf', faction: 'monster', tactic: 'beast', at: [4, 3], hp: 60, move: 6 },
          { name: 'Scarred wolf', faction: 'monster', tactic: 'beast', at: [8, 2], hp: 70, move: 6, bonus: { might: 1 } },
          { name: 'Young wolf', faction: 'monster', tactic: 'beast', at: [12, 4], hp: 50, move: 6 },
        ],
        partyAt: [[7, 11], [8, 11], [9, 11], [6, 12], [10, 12]],
      },
      {
        id: 'hollow', name: 'Hollow Wood', biome: 'forest', radius: [100, 300], objective: 'defeat',
        intro: 'Deep in the wood the trees close in. The pack circles, testing you. A hunter\'s abandoned camp still smoulders.',
        objectiveText: 'Survive the pack.',
        trees: 0.2,
        props: [['campfire', 8, 8], ['torch', 7, 9], ['log', 6, 7], ['tent', 10, 9], ['barrel', 9, 10]],
        foes: [
          { name: 'Black wolf', faction: 'monster', tactic: 'beast', at: [3, 3], hp: 70, move: 6, bonus: { might: 1 } },
          { name: 'Grey wolf', faction: 'monster', tactic: 'beast', at: [12, 3], hp: 60, move: 6 },
          { name: 'Lean wolf', faction: 'monster', tactic: 'beast', at: [2, 9], hp: 55, move: 6 },
          { name: 'Old wolf', faction: 'monster', tactic: 'beast', at: [13, 10], hp: 65, move: 5 },
        ],
        partyAt: [[7, 10], [8, 10], [9, 9], [8, 11], [7, 11]],
      },
      {
        id: 'den', name: 'the Grey Mother\'s Den', biome: 'hills', radius: [150, 360], objective: 'chief',
        intro: 'Bones among the rocks below a rise. The Grey Mother is the size of a pony, and she is not afraid of you.',
        objectiveText: 'Kill the Grey Mother.',
        rise: { at: [8, 3], r: 2, h: 4 },
        props: [['rocks', 5, 5], ['rocks', 11, 5], ['log', 7, 8], ['log', 9, 8], ['torch', 8, 12], ['hay', 4, 9]],
        foes: [
          { name: 'the Grey Mother', faction: 'monster', tactic: 'beast', at: [8, 3], hp: 180, move: 6, bonus: { might: 3, nerve: 6, finesse: 1 }, tags: ['chief'], epithet: 'Grey Mother' },
          { name: 'Pale wolf', faction: 'monster', tactic: 'beast', at: [5, 3], hp: 55, move: 6 },
          { name: 'Torn-ear wolf', faction: 'monster', tactic: 'beast', at: [11, 3], hp: 55, move: 6 },
        ],
        partyAt: PARTY_SOUTH,
      },
    ],
  },
};

export const QUEST_ORDER = ['blackthorn', 'reliquary', 'wolves'];
