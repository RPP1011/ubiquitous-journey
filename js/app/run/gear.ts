// Run-layer abilities that aren't class milestones: bows for archers. Data-only specs through
// the same ir.spec()/validate() trust boundary as the catalog.

import { spec, effect, validate } from '../../rpg/abilities/ir.js';
import { ABILITY_CATALOG } from '../../rpg/abilities/catalog.js';
import type { AbilitySpec } from '../../../types/sim.js';

const shortbow = spec({
  id: 'shortbow', name: 'Shortbow', classKey: 'hunter', tier: 1,
  header: { target: 'enemy', range: 14, cooldown: 0, area: { kind: 'self' }, delivery: { kind: 'projectile', speed: 22 } },
  effects: [effect('damage', { amount: 20, tags: ['PIERCE'] })],
  grantsTags: ['RANGED'],
});

const EXTRA: Record<string, AbilitySpec> = { shortbow };
for (const [id, s] of Object.entries(EXTRA)) if (!validate(s)) throw new Error(`invalid run ability ${id}`);

export function abilityById(id: string): AbilitySpec | undefined {
  return EXTRA[id] ?? (ABILITY_CATALOG as Record<string, AbilitySpec>)[id];
}
