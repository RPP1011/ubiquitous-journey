//! FAN-OUT UNIT: decide. Ports `js/sim/agent/decide.ts` + `js/sim/motivation.js` (goal derivation +
//! the persistent goal stack) + the GOAP layer (`js/sim/planner.ts`) — to behavioral parity (only
//! determinism diverges, doc 22 §9).
//!
//! THE FAITHFUL SKELETON (Wave-4): intentions are NOT recomputed transiently — they live on a
//! PERSISTENT `GoalStack` (the analogue of `agent.goals`), are pushed by `derive_goals` (`deriveGoals`)
//! with their own priority/expiry/flags, deduped by identity, and drained by `prune_goals`
//! (`pruneGoals`) when satisfied / expired / unreachable. The top intention is served by a CACHED
//! `Plan` (the analogue of `_currentPlanStep`): the backward-chainer fills it once, a cursor advances
//! as each step's effect lands, and it is rebuilt only when the served goal changes or the plan is
//! exhausted/infeasible. So the stack-dependent features to come (oaths, caution, closure XP, arc
//! resolution) have a persistent goal + plan object to attach to.
//!
//! Per-agent priority order (every read is OWN state — the epistemic split):
//!   1. SURVIVAL reflex — the largest need deficit past its seek bar (Eat/Rest/Comfort).
//!   2. AVENGE — the top intention if it is an aggressive grudge with an actionable plan ⇒ a moving
//!      Fight that hunts the culprit (overrides flee — a grudge-holder stands and hunts).
//!   3. THREAT — a believed-hostile near where I believe it is, no grudge to settle ⇒ Flee.
//!   4. OTHER INTENTIONS — the top non-aggressive intention with an actionable plan (e.g. seek-fortune
//!      → sell surplus at the believed market).
//!   5. LIVELIHOOD — a working townsperson works its craft, with the occasional market trip.
//!   6. WANDER — a random point near town.
//!
//! Determinism: read/write only row `i`; the stack/plan are own columns; the planner is a pure
//! per-agent search; randomness only via `rng[i]`. No cross-agent reads / HashMap / float-reduce.

use rayon::prelude::*;

use crate::components::{
    EpisodeKind, Faction, Goal, GoalStack, Intention, IntentionKind, Plan, Profession, BELIEF_CAP,
};
use crate::exec::registry::{run_derivers, DeriveCtx};
use crate::planner::{compile_planstep, solve_plan, step_effect_holds, Atom, Pv};
use crate::world::World;

/// Need thresholds — a need is only a candidate once it dips below its seek bar.
const HUNGER_SEEK: f32 = 0.4;
const ENERGY_SEEK: f32 = 0.35;
const COMFORT_SEEK: f32 = 0.45;

/// Per-tick chance a profession-holder takes a market trip instead of working (rng-gated).
const MARKET_CHANCE: f32 = 0.08;

/// A believed-hostile within this distance of where I believe it is sends me fleeing.
const FLEE_RANGE: f32 = 40.0;
const FLEE_RANGE2: f32 = FLEE_RANGE * FLEE_RANGE;

/// Town radius wander points are drawn within (matches worldgen's cluster radius).
const TOWN_RADIUS: f32 = 180.0;

pub fn decide(world: &mut World) {
    let market = world.market;
    let town_center = world.town_center;
    let now = world.tick;
    let base_price = world.base_price;

    let World {
        ref needs,
        ref beliefs,
        ref memory,
        ref econ,
        ref personality,
        ref faction,
        ref profession,
        ref pos,
        ref home,
        ref work_sites,
        ref map,
        ref alive,
        ref mut goal,
        ref mut goals,
        ref mut plan,
        ref mut rng,
        ..
    } = *world;

    goal.par_iter_mut()
        .zip(goals.par_iter_mut())
        .zip(plan.par_iter_mut())
        .zip(rng.par_iter_mut())
        .enumerate()
        .for_each(|(i, (((g, gstack), pl), my_rng))| {
            // The dead make no decisions and carry no intentions.
            if !alive[i] {
                *g = Goal::Idle;
                gstack.len = 0;
                pl.clear();
                return;
            }

            let need = &needs[i];
            let townsfolk = faction[i] == Faction::Townsfolk as u8;

            // 1. SURVIVAL FIRST: the LARGEST deficit below its seek bar claims the body (a reflex that
            //    outranks the standing intentions — a starving avenger eats first).
            let hunger_def = if need.hunger < HUNGER_SEEK { HUNGER_SEEK - need.hunger } else { 0.0 };
            let energy_def = if need.energy < ENERGY_SEEK { ENERGY_SEEK - need.energy } else { 0.0 };
            let comfort_def = if need.comfort < COMFORT_SEEK { COMFORT_SEEK - need.comfort } else { 0.0 };
            if hunger_def > 0.0 || energy_def > 0.0 || comfort_def > 0.0 {
                if hunger_def >= energy_def && hunger_def >= comfort_def {
                    *g = Goal::Eat;
                } else if energy_def >= comfort_def {
                    *g = Goal::Rest;
                } else {
                    // seek the nearest believed hearth (a COMFORT-affording place), else fall back to
                    // my own home anchor — the first MentalMap consumer.
                    let to = map
                        .nearest(crate::mentalmap::AFF_COMFORT, pos[i], 220.0)
                        .map(|p| [p.x, p.z])
                        .unwrap_or(home[i]);
                    *g = Goal::Comfort { to };
                }
                return;
            }

            // The believed-state view the GOAP planner reasons over (OWN state + the static world).
            let pv = Pv {
                pos: pos[i],
                gold: econ[i].gold,
                inventory: econ[i].inventory,
                price_belief: econ[i].price_belief,
                profession: profession[i],
                beliefs: &beliefs[i],
                memory: &memory[i],
                market,
                work_sites,
                base_price: &base_price,
            };

            // 2/3/4. THE GOAL STACK: derive standing intentions from memory, prune resolved/stale ones,
            //        then serve the top via the cached plan. Townsfolk carry grudge-goals; monsters/
            //        raiders fight by reflex (combat's nearest-hostile) without a goal-plan.
            if townsfolk {
                let dctx = DeriveCtx {
                    faction: faction[i],
                    profession: profession[i],
                    gold: econ[i].gold,
                    inventory: econ[i].inventory,
                    pos: pos[i],
                    beliefs: &beliefs[i],
                    memory: &memory[i],
                    now,
                };
                run_derivers(gstack, &dctx);
                prune_goals(gstack, &pv, now);

                // 2. AVENGE: the top AGGRESSIVE intention (a locatable grudge) hunts — overriding flee.
                if let Some(idx) = top_of_kind(gstack, IntentionKind::Avenge) {
                    if let Some(goal_set) = serve(gstack, idx, pl, &pv) {
                        *g = goal_set;
                        return;
                    }
                }
            }

            // 3. THREAT: flee the NEAREST believed-hostile near where I believe it is (no grudge).
            let bt = &beliefs[i];
            let (mx, mz) = (pos[i][0], pos[i][1]);
            let mut flee_from: Option<u32> = None;
            let mut best_d2 = FLEE_RANGE2;
            for b in 0..(bt.len as usize).min(BELIEF_CAP) {
                let cell = &bt.bodies[b];
                if cell.flags & 0x01 == 0 {
                    continue; // not believed hostile
                }
                let dx = mx - cell.last_x;
                let dz = mz - cell.last_z;
                let d2 = dx * dx + dz * dz;
                if d2 < best_d2 || (d2 == best_d2 && flee_from.map_or(true, |s| cell.subject < s)) {
                    best_d2 = d2;
                    flee_from = Some(cell.subject);
                }
            }
            if let Some(from) = flee_from {
                *g = Goal::Flee { from };
                return;
            }

            // 4. OTHER INTENTIONS: the top remaining (non-aggressive) intention with an actionable plan.
            if townsfolk {
                if let Some(idx) = gstack.top_idx() {
                    if let Some(goal_set) = serve(gstack, idx, pl, &pv) {
                        *g = goal_set;
                        return;
                    }
                }
            }

            // 5. LIVELIHOOD: a working townsperson works its craft, with an occasional market trip.
            let prof = profession[i];
            if prof != Profession::None as u8 && townsfolk {
                // AMBITION bias (the first echo of `ambitionFavor`): an ambitious soul trades more
                // often (chases wealth), a content one keeps to its craft. Own-state trait.
                let market_chance = MARKET_CHANCE * (0.5 + personality[i].ambition);
                if my_rng.next_f32() < market_chance {
                    *g = Goal::Market { site: market };
                } else {
                    let site_idx = (prof as usize - 1).min(work_sites.len() - 1);
                    *g = Goal::Work { site: work_sites[site_idx] };
                }
                return;
            }

            // 6. WANDER: a random point near the town centre (own rng stream; uniform over the disc).
            let r = TOWN_RADIUS * my_rng.next_f32().sqrt();
            let a = my_rng.next_f32() * std::f32::consts::TAU;
            let to = [town_center[0] + r * a.cos(), town_center[1] + r * a.sin()];
            *g = Goal::Wander { to };
        });
}

/// Serve the intention at `idx`: ensure the cached plan targets it (replan on change/exhaustion),
/// advance its cursor past landed steps, and compile the current step to an executor goal. Returns
/// `Some(goal)` when there is an actionable step; `None` for a plan-less disposition OR an infeasible
/// plan (which it flags `F_UNREACHABLE` so `prune_goals` drops it next tick).
fn serve(gstack: &mut GoalStack, idx: usize, pl: &mut Plan, pv: &Pv) -> Option<Goal> {
    let top = gstack.items[idx]; // Copy
    let atom = match intention_atom(&top) {
        Some(a) => a,
        None => return None, // plan-less disposition (grieve/wary/…): bias only, caller falls through.
    };
    // (re)build the cached plan if it no longer serves this exact goal.
    if !pl.serves(top.kind, top.subject) {
        match solve_plan(atom, pv) {
            Some(steps) => {
                let n = steps.len().min(crate::components::PLAN_CAP);
                pl.len = n as u8;
                pl.cur = 0;
                pl.goal_kind = top.kind;
                pl.goal_subject = top.subject;
                for (k, s) in steps.into_iter().take(n).enumerate() {
                    pl.steps[k] = s;
                }
            }
            None => {
                // already-holds is handled by prune; a None here means infeasible → unreachable.
                pl.clear();
                gstack.items[idx].flags |= Intention::F_UNREACHABLE;
                return None;
            }
        }
    }
    // advance the cursor past any leading steps whose effect has landed.
    while let Some(step) = pl.current() {
        if step_effect_holds(&step, pv) {
            pl.cur += 1;
        } else {
            break;
        }
    }
    match pl.current() {
        Some(step) => Some(compile_planstep(&step, pv)),
        None => {
            // plan consumed but the predicate hasn't fired (e.g. a quarry slipped away) → unreachable.
            gstack.items[idx].flags |= Intention::F_UNREACHABLE;
            None
        }
    }
}

/// `pruneGoals`: drop intentions whose predicate is satisfied, whose TTL expired, or which the planner
/// flagged unreachable. Iterate high→low index so swap-removal never skips an entry.
fn prune_goals(gstack: &mut GoalStack, pv: &Pv, now: u32) {
    let mut k = gstack.len as usize;
    while k > 0 {
        k -= 1;
        let it = gstack.items[k];
        let expired = it.expire != 0 && now >= it.expire;
        let unreachable = it.flags & Intention::F_UNREACHABLE != 0;
        let satisfied = intention_satisfied(&it, pv);
        if expired || unreachable || satisfied {
            gstack.remove(k);
        }
    }
}

/// The believed-state atom a plannable intention chases (None ⇒ a plan-less disposition).
#[inline]
fn intention_atom(it: &Intention) -> Option<Atom> {
    match it.kind {
        x if x == IntentionKind::Avenge as u8 => Some(Atom::Dead(it.subject)),
        x if x == IntentionKind::SeekFortune as u8 => Some(Atom::GoldGe(it.amt)),
        _ => None,
    }
}

/// Is an intention's predicate satisfied (so it should pop)? Belief/own-state only.
fn intention_satisfied(it: &Intention, pv: &Pv) -> bool {
    match it.kind {
        // believed-dead: I struck it down (Slew memory) OR I hold no belief about it any more.
        x if x == IntentionKind::Avenge as u8 => {
            pv.memory.has(EpisodeKind::Slew, it.subject) || pv.beliefs.find(it.subject).is_none()
        }
        x if x == IntentionKind::SeekFortune as u8 => pv.gold >= it.amt,
        // plan-less dispositions pop on expiry only (handled in prune_goals).
        _ => false,
    }
}

/// The highest-priority intention of a given kind (the avenge-first arbitration), or None.
fn top_of_kind(gstack: &GoalStack, kind: IntentionKind) -> Option<usize> {
    let mut best: Option<usize> = None;
    for k in 0..gstack.len as usize {
        if gstack.items[k].kind != kind as u8 {
            continue;
        }
        best = Some(match best {
            None => k,
            Some(b) => {
                if gstack.items[k].priority > gstack.items[b].priority
                    || (gstack.items[k].priority == gstack.items[b].priority
                        && gstack.items[k].subject < gstack.items[b].subject)
                {
                    k
                } else {
                    b
                }
            }
        });
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Episode, GoalKind, Memory, Needs, PersonBelief};
    use crate::world::World;

    #[test]
    fn hungry_agent_picks_eat() {
        let mut w = World::spawn(0xBEEF, 64);
        w.needs[0].hunger = 0.0;
        w.needs[0].energy = 1.0;
        w.needs[0].comfort = 1.0;
        w.beliefs[0].clear();
        decide(&mut w);
        assert_eq!(w.goal[0].kind(), GoalKind::Eat, "a starving agent must choose Eat");
    }

    #[test]
    fn satisfied_townsperson_works_or_trades() {
        let mut w = World::spawn(0xBEEF, 64);
        let mut found = false;
        for i in 0..w.n {
            if w.profession[i] != Profession::None as u8 && w.faction[i] == Faction::Townsfolk as u8 {
                w.needs[i] = Needs::default();
                w.beliefs[i].clear();
                w.memory[i] = Memory::default();
                w.goals[i] = GoalStack::default();
                found = true;
            }
        }
        assert!(found, "spawn should produce working townsfolk");
        decide(&mut w);
        for i in 0..w.n {
            if w.profession[i] != Profession::None as u8 && w.faction[i] == Faction::Townsfolk as u8 {
                let k = w.goal[i].kind();
                assert!(
                    k == GoalKind::Work || k == GoalKind::Market,
                    "agent {i}: a satisfied working townsperson should Work/Market, got {k:?}"
                );
            }
        }
    }

    #[test]
    fn believed_hostile_triggers_flee() {
        let mut w = World::spawn(0xBEEF, 64);
        w.needs[0] = Needs::default();
        w.memory[0] = Memory::default();
        w.goals[0] = GoalStack::default();
        let px = w.pos[0][0];
        let pz = w.pos[0][1];
        let bt = &mut w.beliefs[0];
        bt.clear();
        bt.subjects[0] = 7;
        bt.bodies[0].subject = 7;
        bt.bodies[0].last_x = px + 2.0;
        bt.bodies[0].last_z = pz + 2.0;
        bt.bodies[0].flags = 0x01;
        bt.len = 1;
        decide(&mut w);
        match w.goal[0] {
            Goal::Flee { from } => assert_eq!(from, 7, "should flee the planted hostile"),
            other => panic!("expected Flee, got {other:?}"),
        }
    }

    /// A grudge (assaulted memory) about a believed-locatable foe ⇒ a persistent Avenge intention on
    /// the stack that HUNTS rather than flees.
    #[test]
    fn grudge_pushes_avenge_and_hunts() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i] = Needs::default();
        let (px, pz) = (w.pos[i][0], w.pos[i][1]);
        let bt = &mut w.beliefs[i];
        bt.clear();
        bt.subjects[0] = 7;
        bt.bodies[0] = PersonBelief {
            subject: 7,
            last_x: px + 5.0,
            last_z: pz,
            confidence: 60000,
            flags: 0x01,
            ..Default::default()
        };
        bt.len = 1;
        w.memory[i] = Memory::default();
        w.memory[i].record(Episode {
            kind: EpisodeKind::Assaulted as u8,
            with: 7,
            t: w.tick,
            salience: 50000,
            ..Default::default()
        });
        w.goals[i] = GoalStack::default();
        decide(&mut w);
        // the intention persisted on the stack…
        assert!(
            (0..w.goals[i].len as usize)
                .any(|k| w.goals[i].items[k].kind == IntentionKind::Avenge as u8
                    && w.goals[i].items[k].subject == 7),
            "an Avenge intention should sit on the persistent stack"
        );
        // …and it produced a hunting Fight, overriding the flee reflex.
        match w.goal[i] {
            Goal::Fight { target, .. } => assert_eq!(target, 7, "should hunt the foe that struck me"),
            other => panic!("a grudge should hunt (Fight), got {other:?}"),
        }
    }

    /// The intention pops once the foe is believed slain (a Slew memory satisfies the predicate).
    #[test]
    fn avenge_pops_when_foe_slain() {
        let mut w = World::spawn(0xBEEF, 8);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i] = Needs::default();
        w.beliefs[i].clear();
        w.memory[i] = Memory::default();
        w.memory[i].record(Episode {
            kind: EpisodeKind::Assaulted as u8,
            with: 7,
            t: w.tick,
            salience: 50000,
            ..Default::default()
        });
        w.goals[i] = GoalStack::default();
        decide(&mut w); // derives the avenge intention
        // now record that I slew the foe → next decide must prune it.
        w.memory[i].record(Episode {
            kind: EpisodeKind::Slew as u8,
            with: 7,
            t: w.tick,
            salience: 60000,
            ..Default::default()
        });
        decide(&mut w);
        assert!(
            !(0..w.goals[i].len as usize)
                .any(|k| w.goals[i].items[k].kind == IntentionKind::Avenge as u8),
            "a settled grudge must be pruned from the stack"
        );
    }
}
