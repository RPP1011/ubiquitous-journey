// The believed-CAPABILITY layer for ToM party coordination (docs/architecture/19 §10). What an ally
// CAN do — its combo ROLE — is a BELIEF, accrued from witnessing its casts (truth→own-belief, the
// sanctioned bridge, exactly like the believedThreat perception bridge). The role is derived from a
// spec's EFFECT OPS (not its flavour grantsTags), so the witness must recover the spec: the cast event
// carries `abilityId`, looked up in ABILITY_CATALOG (the audit's load-bearing correction).
//
// The bus fans only to the ACTOR (deedRouter), so the witness accrual is its OWN vision-gated scan over
// sim.agents — installed beside installDeedRouter and disposed with it. Accrual is restricted to the
// caster's own BAND (the only place capability is consumed: §8b predictive setup), keeping it cheap.

import { bus } from '../rpg/events.js';
import { ABILITY_CATALOG } from '../rpg/abilities/catalog.js';
import { SIM, COORD, KNOW } from './simconfig.js';
import type { Agent, AbilitySpec, ActionEvent, EntityId } from '../../types/sim.js';

export type ComboRole = 'control' | 'burst' | 'support' | 'none';

// derive the combo ROLE from a spec's EFFECT OPS (NOT its grantsTags — those are coarse flavour).
// control: any CC / setup op (stun/slow/knockback/expose). burst: a real single-target damage punch.
// support: heal/shield. Control wins ties (it's the rarer, more coordination-relevant capability).
export function comboRoleOf(spec: AbilitySpec | null | undefined): ComboRole {
  if (!spec || !spec.effects) return 'none';
  let dmg = 0, control = false, support = false;
  for (const e of spec.effects) {
    if (e.op === 'damage') dmg += Math.max(0, e.amount || 0);
    else if (e.op === 'stun' || e.op === 'slow' || e.op === 'knockback' || e.op === 'expose') control = true;
    else if (e.op === 'heal' || e.op === 'shield') support = true;
  }
  if (control) return 'control';
  if (dmg >= (COORD.burstMin || 30)) return 'burst';
  if (support) return 'support';
  return 'none';
}

type RoleBag = { control: number; burst: number; support: number; t: number };
const decayConf = (v: number, dt: number): number => v * Math.pow(0.5, dt / (COORD.roleHalfLife || 240));

// decay a bag's confidences to `now` (lazy-at-read, the experience.ts model — no per-tick pass).
function decayedBag(bag: RoleBag, now: number): RoleBag {
  const dt = Math.max(0, now - bag.t);
  if (dt > 0) { bag.control = decayConf(bag.control, dt); bag.burst = decayConf(bag.burst, dt); bag.support = decayConf(bag.support, dt); bag.t = now; }
  return bag;
}

// accrue (decayed, capped) confidence that `subjectId` can perform `role`, onto witness `w`. No-op for
// the null role. Own-state write on the witness; provenance is first-hand (a seen cast).
export function accrueAllyRole(w: Agent, subjectId: EntityId, role: ComboRole, now: number, gain: number): void {
  if (role === 'none' || !w) return;
  if (!w._allyRole) w._allyRole = new Map();
  let bag = w._allyRole.get(subjectId);
  if (!bag) { bag = { control: 0, burst: 0, support: 0, t: now }; w._allyRole.set(subjectId, bag); }
  decayedBag(bag, now);
  bag[role] = Math.min(1, bag[role] + gain);
}

// BANDED PRIOR (§10): on join, seed a weak prior about a band-mate's role — below roleMinConf, so a
// single first-hand sighting still dominates it. (Trained/marched together: you roughly know its tricks.)
export function seedBandPrior(a: Agent, subjectId: EntityId, role: ComboRole, now: number): void {
  accrueAllyRole(a, subjectId, role, now, COORD.bandPriorConf || 0.25);
}

// an agent's OWN combo role, derived from its held abilities (highest-priority role among its specs).
const ROLE_RANK: Record<ComboRole, number> = { control: 3, burst: 2, support: 1, none: 0 };
export function agentComboRole(a: Agent): ComboRole {
  if (!a || !a.abilities) return 'none';
  let best: ComboRole = 'none';
  for (const spec of a.abilities.values()) { const r = comboRoleOf(spec); if (ROLE_RANK[r] > ROLE_RANK[best]) best = r; }
  return best;
}

// On a band JOIN, seed weak BOTH-WAY priors between the joiner and its new band-mates (the §10 prior:
// comrades roughly know each other's tricks). Execution-side (a controlled truth→belief seed at join,
// like a perception bridge) — weak (bandPriorConf < roleMinConf), so a real sighting still dominates.
export function seedBandPriors(joiner: Agent, mates: Agent[], now: number): void {
  const jr = agentComboRole(joiner);
  for (const m of mates) {
    if (!m) continue;
    seedBandPrior(joiner, m.id, agentComboRole(m), now);
    seedBandPrior(m, joiner.id, jr, now);
  }
}

// the believed combo ROLE of an ally: the max-confidence role above roleMinConf (decayed to now), else
// 'none'. Reads ONLY my own accrued belief — an ally I've never seen cast (nor priored) reads 'none',
// so I simply don't build combos around it (bounded rationality, intentional — doc 18's principle).
export function believedRole(a: Agent, subjectId: EntityId, now: number): ComboRole {
  const bag = a._allyRole && a._allyRole.get(subjectId);
  if (!bag) return 'none';
  decayedBag(bag, now);
  const min = COORD.roleMinConf || 0.35;
  let role: ComboRole = 'none', bestv = min;
  if (bag.control > bestv) { bestv = bag.control; role = 'control'; }
  if (bag.burst > bestv) { bestv = bag.burst; role = 'burst'; }
  if (bag.support > bestv) { bestv = bag.support; role = 'support'; }
  return role;
}

// are `w` and `caster` in the SAME band? (caster's band-mate, or one leads the other.)
function sameBand(w: Agent, caster: Agent): boolean {
  const wl = w.bandLeaderId, cl = caster.bandLeaderId;
  if (wl == null) return false;
  return wl === cl || wl === caster.id || cl === w.id;
}

// Install the witness subscriber: every CAST event accrues a capability belief in each BAND-MATE within
// vision of the caster (its OWN scan — the bus only fans to the actor; the audit's finding). Returns the
// unsubscribe handle (stored as sim._coordOff, called in dispose). Guarded — never throws on a bus emit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installCoordWitness(sim: any): () => void {
  return bus.on((ev: ActionEvent) => {
    try {
      if (ev.verb !== 'cast' || ev.abilityId == null) return;
      const role = comboRoleOf(ABILITY_CATALOG[ev.abilityId as keyof typeof ABILITY_CATALOG]);
      if (role === 'none') return;
      const caster = sim.agentsById.get(ev.actorId);
      if (!caster) return;
      const now = ev.t || sim.time, vr = SIM.visionRange, gain = (KNOW && KNOW.observeGain) || 0.18;
      for (const w of sim.agents) {
        if (w === caster || !w.alive || !sameBand(w, caster)) continue;   // band-mates only (where capability is used)
        if (w.pos.distanceTo(caster.pos) > vr) continue;                   // vision-gated witness
        accrueAllyRole(w, caster.id, role, now, gain);
      }
    } catch { /* never throw on a bus emit */ }
  });
}
