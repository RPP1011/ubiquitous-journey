// Shared constants & tuning for the directional combat prototype.

export type Dir = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

export const DIR: Record<Dir, Dir> = { UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT' };

// Which embedded KayKit clip plays for each attack direction.
// (Verified present in Knight.glb / Barbarian.glb — same shared rig.)
export const ATTACK_CLIP: Record<Dir, string> = {
  UP:    '1H_Melee_Attack_Chop',            // overhead
  DOWN:  '1H_Melee_Attack_Stab',            // thrust
  LEFT:  '1H_Melee_Attack_Slice_Horizontal',
  RIGHT: '1H_Melee_Attack_Slice_Horizontal',
};

// KayKit only ships right-to-left slices, so the left-to-right swing is the
// same clip played in reverse — a genuine mirrored swing without bone-swapping.
export const ATTACK_REVERSE: Record<Dir, boolean> = {
  UP: false, DOWN: false, LEFT: false, RIGHT: true,
};

// Non-attack clips.
export const CLIP = {
  idle:  'Idle',
  walk:  'Walking_C',
  run:   'Running_A',
  block: 'Blocking',
  hit:   'Hit_A',
  death: 'Death_A',
};

// Combat tuning (world units = meters; models normalised to ~1.8 m tall).
export const TUNE = {
  targetHeight: 1.8,        // normalise every character to this height

  // attack timing as a fraction of the swing clip's duration
  activeStart: 0.28,        // hit window opens
  activeEnd:   0.62,        // hit window closes
  windupHold:  0.12,        // clip time (fraction) held while "readying"
  recover:     0.28,        // seconds locked after a swing
  staggerTime: 0.55,        // seconds stunned when hit
  blockFade:   0.12,

  reach:      2.3,          // weapon reach (tip-to-torso) in meters
  hitRadius:  0.95,         // torso hit radius
  damage:     24,

  moveSpeed:  3.6,
  runSpeed:   6.2,
  enemySpeed: 2.7,
  turnSpeed:  10,           // how fast a fighter yaws toward its facing target

  maxHealth:  100,
};

// Yaw added to a fighter's facing so the model fronts its movement/aim.
// KayKit characters face +Z at rotation 0, so we add PI to front their
// movement/aim. Flip back to 0 if a future model faces the other way.
export const MODEL_YAW_OFFSET = Math.PI;

export const ENEMY = {
  engageRange:       2.1,   // distance at which an enemy will attack
  approachUntil:     1.8,   // stop closing in at this range
  attackCooldownMin: 1.3,
  attackCooldownMax: 2.8,
  blockChance:       0.45,  // chance to raise guard when the player winds up
  reactionTime:      0.22,  // delay before reacting to player's wind-up
};

// Character model config. All share one rig + the 76 KayKit clips.
export const CHARACTERS = {
  knight:    { url: 'assets/Knight.glb',    weapon: '1H_Sword' },
  barbarian: { url: 'assets/Barbarian.glb', weapon: '1H_Axe'   },
};

// Node-name fragments to hide so each fighter holds only its single 1H weapon.
export const HIDE_WEAPON_FRAGMENTS = [
  '2H_', 'Offhand', 'Shield', 'Crossbow', 'Bow', 'Quiver',
  'Spellbook', 'Staff', 'Wand', 'Knife', 'Dagger',
];
