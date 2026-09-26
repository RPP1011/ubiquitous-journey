// STAGE SETS: each quest stage is played on its own authored ground, away from the open world, so
// every place is recognisable (the burnt mill by its stream, the chapel by its broken walls) and the
// ground itself is tactical: walls block and give full cover, water slows and douses, grass burns,
// stone and snow don't. This file is the LOGIC half (headless-safe data); ui/stageSet.ts dresses it.
//
// Layout: 16 rows (z = 0 is the far/north edge, where the foes usually are) of 16 chars (x):
//   .  grass      ,  dirt / road / trampled      =  stone / flagstone      ~  water (slow, douses)
//   %  mud (slow)  _  ash                         *  snow                    #  wall (stone underfoot)
//   "  brush / tall grass / wheat / gorse: hides you from archers and watchers, and burns
// Heights (optional): 16 rows of digits, in LEVELs (0.5 m); a stage's `rise` is added on top.

import type { Ground } from '../tactics/map.js';

export interface SetLayout {
  ground: readonly string[];
  h?: readonly string[];
  /** Tiles at or above this height turn to bare stone (a rocky tor). */
  rockyAbove?: number;
  /** Fought at night or in deep gloom: sight is short except near a flame. */
  dark?: boolean;
}

const rows = (n: number, r: string) => Array.from({ length: n }, () => r);

export const SETS: Record<string, SetLayout> = {
  // a forest road between wooded banks; the overturned cart sits across it
  old_road: {
    ground: [
      ...rows(2, '.......,,.......'),
      '.....%.,,.......', '.....%.,,.......',
      '.......,,.......',
      '.......,,..%....', '.......,,..%....',
      '.......,,.......',
      ...rows(5, '.""....,,.......'),
      ...rows(3, '.......,,.......'),
    ],
    h: rows(16, '2221000000001222'),
  },
  // the burnt mill: charred shell to the north (door on the yard), the mill-stream down the east
  mill: {
    ground: [
      '....########..~~', '....#______#..~~', '....###__###..~~',
      '.......,,.....~~', '.......,,.....~~', '...._..,,.....~~', '.......,,.....~~',
      '....__.,,.....~~', '.......,,.....~~', '.......,,.._..~~', '.......,,.....~~',
      ...rows(5, '......,,......~~'),
    ],
  },
  // a palisaded camp on a rise; you come at it through the gate
  camp: {
    ground: [...rows(11, '#,,,,,,,,,,,,,,#'), '#######,,#######', ...rows(4, '.......,,.......')],
    rockyAbove: 4, dark: true,
  },
  // two roads cross at the well; a waystone at the corner; open fields all round
  crossroads: {
    ground: [
      ...rows(6, '"""""".,,.......'),
      '......#,,.......',
      ',,,,,,,,,,,,,,,,', ',,,,,,,,,,,,,,,,',
      ...rows(7, '.......,,.......'),
    ],
  },
  // the cliff and the mine mouth to the north, rails running out of it across the stone
  mine: {
    ground: ['#######,,#######', '#######,,#######', ...rows(10, '=======,,======='), ...rows(4, '.......,,.......')],
  },
  // a roofless chapel: flagstones inside broken walls, a door to the south, the altar to the north
  ruin: {
    ground: [
      '..############..',
      '..#==========#..', '..#==========#..', '..#==========#..',
      '..===========#..', '..===========#..',
      '..#===========..', '..#===========..',
      '..#==========#..', '..#==========#..',
      '..####====####..',
      ...rows(5, '................'),
    ],
  },
  // a dry-stone sheepfold: you are inside the pen; its gate faces the dark
  sheepfold: {
    ground: [
      ...rows(3, '................'),
      '......""""".....', '......""""".....',
      '................',
      '...####,,####...',
      '...#,,,,,,,,#...', '...#,,,,,,,,#...', '...#,,,,,,,,#...', '...#,,,,,,,,#...',
      '....,,,,,,,,....',
      '...#,,,,,,,,#...', '...#,,,,,,,,#...',
      '...##########...',
      '................',
    ],
  },
  // deep wood: mud underfoot and a black pool
  hollow: {
    ground: [
      ...rows(4, '................'),
      '..........%%....', '""""%%......""""', '"""""%......""""',
      '""""........""""', '""""........""""',
      ...rows(4, '................'),
      '............~~..', '............~~..', '................',
    ],
  },
  // snow under a cliff; the den's mouth in the rock; a tor where she waits
  den: {
    ground: ['#######===######', '#######===######', ...rows(14, '****************')],
    rockyAbove: 4, dark: true,
  },
};

const G: Record<string, Ground> = { '"': 'brush', '.': 'grass', ',': 'dirt', '=': 'stone', '~': 'water', '%': 'mud', '_': 'ash', '*': 'snow', '#': 'stone' };

/** The tile at (x, z) in a set: its ground, whether it's a wall, and its base height. */
export function setTile(s: SetLayout, x: number, z: number): { ground: Ground; wall: boolean; h: number } {
  const ch = s.ground[z]?.[x] ?? '.';
  return { ground: G[ch] ?? 'grass', wall: ch === '#', h: s.h ? +(s.h[z]?.[x] ?? '0') || 0 : 0 };
}

/** Where a stage is built: its own patch of ground far off the map (no world bleeds in). */
export function stageCenter(index: number): { x: number; z: number } {
  return { x: 4000 + (index % 3) * 400, z: 4000 + Math.floor(index / 3) * 400 };
}
