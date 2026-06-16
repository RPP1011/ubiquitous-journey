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
    BeliefTable, Commodity, EpisodeKind, Experience, Faction, Goal, GoalStack, Intention,
    IntentionKind, PersonBelief, Plan, Profession, BELIEF_CAP,
};
use crate::exec::registry::{run_derivers, DeriveCtx};
use crate::planner::{compile_current, solve_plan, step_effect_holds, Atom, Pv, VERB_ROB};
use crate::world::World;

/// Need thresholds — a need is only a candidate once it dips below its seek bar.
const HUNGER_SEEK: f32 = 0.4;
const ENERGY_SEEK: f32 = 0.35;
const COMFORT_SEEK: f32 = 0.45;
/// Soft-need seek bars (company + novelty) — a LOW severe-depletion fallback. Normal market/work/wander
/// activity restores these passively (needs.rs), so a dedicated Socialize/Sightsee trip fires only for
/// an agent whose routine left it genuinely starved of company/novelty — rare, so the work economy is
/// never robbed of foraging time (the marginal-economy survival lesson).
const SOCIAL_SEEK: f32 = 0.08;
const NOVELTY_SEEK: f32 = 0.06;
/// SCOUT (the observe/whereabouts knowledge channel): a CURIOUS idle soul goes to firm its vaguest
/// but VALUABLE belief first-hand. Curiosity gate + a confidence WINDOW (a real hunch, not yet trusted)
/// + a worth cue (a believed-rich mark or a believed friend). Idle-tier ⇒ never robs foraging time.
const SCOUT_CURIOUS: f32 = 0.55;
const SCOUT_CONF_LO: u16 = 8_000; // firm enough to be a hunch (not perceptual noise)
const SCOUT_CONF_HI: u16 = 45_000; // below the act-on-it firm bar (still worth resolving)
const SCOUT_WEALTH: u16 = 20_000; // a believed-rich subject worth a closer look

/// Per-tick chance a profession-holder takes a market trip instead of working (rng-gated).
const MARKET_CHANCE: f32 = 0.08;

/// A believed-hostile within this distance of where I believe it is sends me fleeing.
const FLEE_RANGE: f32 = 40.0;
const FLEE_RANGE2: f32 = FLEE_RANGE * FLEE_RANGE;

/// Town radius wander points are drawn within (matches worldgen's cluster radius).
const TOWN_RADIUS: f32 = 180.0;
/// Per-tick chance a WANDERLUST townsperson roams instead of working (the see-the-world drive).
const WANDERLUST_PULL: f32 = 0.18;
/// How near a believed monster/raider a RENOWN-seeker will charge it for glory (instead of fleeing).
const GLORY_RANGE: f32 = 45.0;
/// Anger past this (0..1) makes a provoked agent turn and fight a believed-hostile rather than flee.
const ANGER_FIGHT: f32 = 0.5;

pub fn decide(world: &mut World) {
    let market = world.market;
    let town_center = world.town_center;
    let now = world.tick;
    let base_price = world.base_price;

    let World {
        ref needs,
        ref mood,
        ref beliefs,
        ref memory,
        ref econ,
        ref personality,
        ref ambition,
        ref recipe,
        ref faction,
        ref profession,
        ref pos,
        ref home,
        ref home_belief_id,
        ref work_sites,
        ref map,
        ref alive,
        ref band_leader,
        ref captive_of,
        ref mut goal,
        ref mut goals,
        ref mut plan,
        ref mut experience,
        ref mut rng,
        ref mut signals,
        ..
    } = *world;

    // WARBAND RALLY snapshot (read-only): each agent's CURRENT foe if it holds a Fight goal — built
    // serially from last tick's goals (a 1-tick lag) so the parallel loop below can read a band leader's
    // foe without borrowing the live `goal` column it is mutating. A follower rallies to its leader's
    // foe (if it perceives it too). Cheap (one i32/agent); shared read across threads ⇒ deterministic.
    let leader_foe: Vec<Option<u32>> = goal
        .iter()
        .map(|g| match g {
            Goal::Fight { target, .. } => Some(*target),
            _ => None,
        })
        .collect();

    goal.par_iter_mut()
        .zip(goals.par_iter_mut())
        .zip(plan.par_iter_mut())
        .zip(experience.par_iter_mut())
        .zip(rng.par_iter_mut())
        .zip(signals.par_iter_mut())
        .enumerate()
        .for_each(|(i, (((((g, gstack), pl), my_exp), my_rng), my_sig))| {
            // The dead make no decisions and carry no intentions.
            if !alive[i] {
                *g = Goal::Idle;
                gstack.len = 0;
                pl.clear();
                return;
            }
            // A CAPTIVE is held — it makes no decisions until freed (its captor falls, then decide
            // resumes normally). Inert, not dead (still alive, still perceivable).
            if captive_of[i] != crate::world::CAPTIVE_NONE {
                *g = Goal::Idle;
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
                    // HUNGER dominant: eat in place IF carrying food (the reactive reflex). With an
                    // EMPTY larder there is nothing to eat — fall through to the goal stack, where the
                    // SUBSISTENCE deriver's Sate intention routes the planner to forage/buy a meal
                    // (the starvation-gap fix). Only short-circuit when eating can actually help.
                    if econ[i].inventory[Commodity::Food as usize] > 0 {
                        *g = Goal::Eat;
                        return;
                    }
                    // else: no food, no return — subsistence (below) drives acquisition.
                } else if energy_def >= comfort_def {
                    *g = Goal::Rest;
                    return;
                } else {
                    // HOMECOMING (epistemic): if I have DISCOVERED a home building and still BELIEVE in
                    // it, go to where I believe it stands — not its ground truth (a razed/forgotten home
                    // can't pull me; the split). Else the nearest believed hearth, else my home anchor.
                    let believed_home = if home_belief_id[i] != u32::MAX {
                        beliefs[i]
                            .find(home_belief_id[i])
                            .map(|ix| [beliefs[i].bodies[ix].last_x, beliefs[i].bodies[ix].last_z])
                    } else {
                        None
                    };
                    let to = believed_home
                        .or_else(|| {
                            map.nearest(crate::mentalmap::AFF_COMFORT, pos[i], 220.0)
                                .map(|p| [p.x, p.z])
                        })
                        .unwrap_or(home[i]);
                    *g = Goal::Comfort { to };
                    return;
                }
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
                experience: *my_exp,
                risk_tolerance: personality[i].risk_tolerance,
                now,
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
                    personality: personality[i],
                    hunger: need.hunger,
                    experience: *my_exp,
                    recipe_own: crate::world::prof_good(profession[i])
                        .map(|g| recipe[i][g])
                        .unwrap_or(1.0),
                    beliefs: &beliefs[i],
                    memory: &memory[i],
                    now,
                };
                run_derivers(gstack, &dctx);
                // CAUTION burn-on-failure (doc 11): an intention the planner flagged UNREACHABLE last
                // tick is a WASTED watched venture — burn its strategy before prune drops it, so the
                // surcharge accrues (a thief whose marks keep slipping learns robbing isn't worth it).
                burn_failed_ventures(gstack, my_exp, my_sig, &beliefs[i], now);
                prune_goals(gstack, &pv, now);

                // 2. STAND AND FIGHT: the top AGGRESSIVE intention (a locatable grudge to avenge, or a
                //    threat to a friend to repel) hunts — overriding the flee reflex.
                if let Some(idx) = top_aggressive(gstack) {
                    if let Some(goal_set) = serve(gstack, idx, pl, &pv) {
                        *g = goal_set;
                        return;
                    }
                }
            }

            // 2c. WARBAND RALLY: a band follower converges on its LEADER's foe — but only one it ALSO
            //     perceives (a shared, commonly-seen threat). The band stands together, overriding the
            //     personal flee reflex; belief-gated, so a follower won't blindly charge a foe it can't
            //     see. Active only while the leader is fighting ⇒ no peacetime economic cost. This is
            //     the warband muster: a mustered leader marches on the believed foe, the band converges.
            if townsfolk {
                let lid = band_leader[i];
                if lid != crate::components::NO_BAND {
                    if let Some(Some(foe)) = leader_foe.get(lid as usize).copied() {
                        if foe != i as u32 {
                            if let Some(bi) = beliefs[i].find(foe) {
                                let b = &beliefs[i].bodies[bi];
                                *g = Goal::Fight { target: foe, to: infer_pursuit(b, map, now) };
                                return;
                            }
                        }
                    }
                }
            }

            // 2b. SEEK GLORY: a RENOWN-seeker hunts a believed monster/raider for glory — it stands and
            //     fights an attacker-faction foe instead of fleeing (the renown ambition's teeth).
            if townsfolk && ambition[i] == crate::components::AMB_RENOWN {
                let bt = &beliefs[i];
                let mut foe: Option<(u32, [f32; 2])> = None;
                let mut best = (GLORY_RANGE * GLORY_RANGE, u32::MAX);
                for b in 0..(bt.len as usize).min(BELIEF_CAP) {
                    let cell = &bt.bodies[b];
                    let attacker = cell.faction == Faction::Monster as u8 || cell.faction == Faction::Raider as u8;
                    if cell.flags & 0x01 == 0 || !attacker {
                        continue;
                    }
                    let dx = pos[i][0] - cell.last_x;
                    let dz = pos[i][1] - cell.last_z;
                    let d2 = dx * dx + dz * dz;
                    if d2 < best.0 || (d2 == best.0 && cell.subject < best.1) {
                        best = (d2, cell.subject);
                        foe = Some((cell.subject, infer_pursuit(cell, map, now)));
                    }
                }
                if let Some((target, to)) = foe {
                    *g = Goal::Fight { target, to };
                    return;
                }
            }

            // 3. THREAT: flee the NEAREST believed-hostile near where I believe it is (no grudge).
            let bt = &beliefs[i];
            let (mx, mz) = (pos[i][0], pos[i][1]);
            let mut flee_from: Option<(u32, [f32; 2])> = None;
            let mut best_d2 = FLEE_RANGE2;
            for b in 0..(bt.len as usize).min(BELIEF_CAP) {
                let cell = &bt.bodies[b];
                if cell.flags & 0x01 == 0 {
                    continue; // not believed hostile
                }
                let dx = mx - cell.last_x;
                let dz = mz - cell.last_z;
                let d2 = dx * dx + dz * dz;
                if d2 < best_d2
                    || (d2 == best_d2 && flee_from.map_or(true, |(s, _)| cell.subject < s))
                {
                    best_d2 = d2;
                    flee_from = Some((cell.subject, [cell.last_x, cell.last_z]));
                }
            }
            if let Some((from, fpos)) = flee_from {
                // PROVOKED: a sufficiently ANGRY agent turns and fights its tormentor rather than
                // fleeing (the mood-coloured decision; anger decays, so it's a transient stand).
                if mood[i].anger >= ANGER_FIGHT {
                    *g = Goal::Fight { target: from, to: fpos };
                } else {
                    *g = Goal::Flee { from };
                }
                return;
            }

            // 4. OTHER INTENTIONS: the top remaining (non-aggressive) intention with an actionable plan.
            if townsfolk {
                if let Some(idx) = gstack.top_idx() {
                    if let Some(goal_set) = serve(gstack, idx, pl, &pv) {
                        *g = goal_set;
                        return;
                    }
                    // a plan-less GRIEVE disposition gives the mourner a visible beat: withdraw to the
                    // nearest hearth to mourn (the disposition biases behaviour, doesn't plan).
                    if gstack.items[idx].kind == IntentionKind::Grieve as u8 {
                        let to = map
                            .nearest(crate::mentalmap::AFF_COMFORT, pos[i], 220.0)
                            .map(|p| [p.x, p.z])
                            .unwrap_or(home[i]);
                        *g = Goal::Comfort { to };
                        return;
                    }
                    // a plan-less KNOW disposition (the apprentice's goalLearn): bias toward PRACTISING
                    // the craft — go to the work site, where learn-by-doing + study/ask firm the recipe.
                    if gstack.items[idx].kind == IntentionKind::Know as u8 {
                        let prof = profession[i];
                        if prof != Profession::None as u8 {
                            let site_idx = (prof as usize - 1).min(work_sites.len() - 1);
                            *g = Goal::Work { site: work_sites[site_idx] };
                            return;
                        }
                    }
                }
            }

            // 5. LIVELIHOOD: a working townsperson works its craft — biased by its AMBITION (the data
            //    echo of `ambitionFavor`): a WANDERLUST soul roams instead, a WEALTH soul trades more,
            //    a MASTERY soul keeps to its craft. Own-state trait.
            let prof = profession[i];
            if prof != Profession::None as u8 && townsfolk {
                let amb = ambition[i];
                if amb == crate::components::AMB_WANDERLUST && my_rng.next_f32() < WANDERLUST_PULL {
                    let r = TOWN_RADIUS * my_rng.next_f32().sqrt();
                    let a = my_rng.next_f32() * std::f32::consts::TAU;
                    *g = Goal::Wander { to: [town_center[0] + r * a.cos(), town_center[1] + r * a.sin()] };
                    return;
                }
                let mut market_chance = MARKET_CHANCE * (0.5 + personality[i].ambition);
                if amb == crate::components::AMB_WEALTH {
                    market_chance *= 1.8;
                } else if amb == crate::components::AMB_MASTERY {
                    market_chance *= 0.4;
                }
                if my_rng.next_f32() < market_chance {
                    *g = Goal::Market { site: market };
                } else {
                    let site_idx = (prof as usize - 1).min(work_sites.len() - 1);
                    *g = Goal::Work { site: work_sites[site_idx] };
                }
                return;
            }

            // 6. IDLE TIME: nothing pressing to do. A townsperson with a run-down SOFT need spends the
            //    idle time tending it — company at a crowd (Socialize) or fresh ground (Sightsee), the
            //    explicit fills. This sits at the LOWEST priority (only reached when not working/fleeing/
            //    intending), so it NEVER robs the work economy of foraging time (the marginal-economy
            //    survival lesson). Most townsfolk satisfy these passively while at market/work (needs.rs)
            //    and never reach here; this enriches the genuinely idle.
            if townsfolk {
                // SCOUT first: a curious soul resolves an uncertain-but-valuable hunch (observe to firm
                // it — perceive raises the belief's confidence on arrival). The proactive knowledge model.
                if personality[i].curiosity >= SCOUT_CURIOUS {
                    let bt = &beliefs[i];
                    let mut best: Option<([f32; 2], u16, u32)> = None; // (pos, conf, subject) — vaguest
                    for b in 0..(bt.len as usize).min(BELIEF_CAP) {
                        let cell = &bt.bodies[b];
                        if cell.confidence < SCOUT_CONF_LO || cell.confidence >= SCOUT_CONF_HI {
                            continue; // not in the worth-resolving uncertainty window
                        }
                        if !(cell.wealth >= SCOUT_WEALTH || cell.standing > 0) {
                            continue; // not a valuable subject (rich mark / friend)
                        }
                        let better = match best {
                            None => true,
                            Some((_, bc, bs)) => cell.confidence < bc || (cell.confidence == bc && cell.subject < bs),
                        };
                        if better {
                            best = Some(([cell.last_x, cell.last_z], cell.confidence, cell.subject));
                        }
                    }
                    if let Some((to, _, _)) = best {
                        *g = Goal::Observe { to };
                        return;
                    }
                }
                let social_def = if need.social < SOCIAL_SEEK { SOCIAL_SEEK - need.social } else { 0.0 };
                let novelty_def = if need.novelty < NOVELTY_SEEK { NOVELTY_SEEK - need.novelty } else { 0.0 };
                if social_def > 0.0 && social_def >= novelty_def {
                    let to = map
                        .nearest(crate::mentalmap::AFF_CROWD, pos[i], 300.0)
                        .map(|p| [p.x, p.z])
                        .unwrap_or(town_center);
                    *g = Goal::Socialize { to };
                    return;
                } else if novelty_def > 0.0 {
                    let to = map
                        .nearest(crate::mentalmap::AFF_RESOURCE, pos[i], 300.0)
                        .map(|p| [p.x, p.z])
                        .unwrap_or(town_center);
                    *g = Goal::Sightsee { to };
                    return;
                }
            }

            // …otherwise amble: a random point near the town centre (own rng stream; uniform over disc).
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
    match compile_current(pl, pv) {
        Some(g) => Some(g),
        None => {
            // plan consumed but the predicate hasn't fired (e.g. a quarry slipped away) → unreachable.
            gstack.items[idx].flags |= Intention::F_UNREACHABLE;
            None
        }
    }
}

/// CAUTION burn-on-failure (doc 11): a watched venture the planner flagged UNREACHABLE (the quarry
/// slipped out of belief — a wasted pursuit) burns its strategy's surcharge before it is pruned. The
/// rob bet's plan-time confidence (how well-tracked the mark was) attenuates the burn (a confident bet
/// that fails is bad luck, not folly). Own-write to the agent's experience row ⇒ deterministic.
fn burn_failed_ventures(
    gstack: &GoalStack,
    exp: &mut Experience,
    sig: &mut crate::components::Signals,
    bt: &BeliefTable,
    now: u32,
) {
    for k in 0..gstack.len as usize {
        let it = gstack.items[k];
        if it.flags & Intention::F_UNREACHABLE != 0 && it.kind == IntentionKind::Steal as u8 {
            let conf = bt
                .find(it.subject)
                .map(|ix| bt.bodies[ix].confidence as f32 / 65535.0)
                .unwrap_or(0.0);
            crate::experience::record_waste(&mut exp.e[VERB_ROB as usize], conf, now);
            // signalsFold (doc 13): the wasted heist folds a Fail onto the Heist streak — the same
            // PLAN_OUTCOME the windfall folds Ok onto (world.rs). Own-row write (disjoint via zip).
            crate::signals::fold_streak(
                sig,
                crate::components::StreakKey::Heist,
                crate::components::OutcomeStatus::Fail,
            );
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
        x if x == IntentionKind::Avenge as u8 || x == IntentionKind::Defend as u8 => {
            Some(Atom::Dead(it.subject))
        }
        x if x == IntentionKind::SeekFortune as u8 => Some(Atom::GoldGe(it.amt)),
        // sate: obtain a single unit of Food (the planner routes forage vs buy by cost); needs.rs
        // then eats it. One unit is enough to break the starvation stall.
        x if x == IntentionKind::Sate as u8 => Some(Atom::Have(Commodity::Food as u8, 1)),
        x if x == IntentionKind::Steal as u8 => Some(Atom::Took(it.subject)),
        x if x == IntentionKind::Donate as u8 || x == IntentionKind::Repay as u8 => {
            Some(Atom::Gave(it.subject))
        }
        x if x == IntentionKind::Loot as u8 => Some(Atom::Looted(it.subject)),
        x if x == IntentionKind::Rescue as u8 => Some(Atom::Freed(it.subject)),
        _ => None,
    }
}

/// Is this an AGGRESSIVE intention (one that braves danger, overriding the flee reflex)? Avenge/Defend
/// stand and fight; Rescue braves the captor to free a friend (served before flee for the same reason).
#[inline]
fn is_aggressive(kind: u8) -> bool {
    kind == IntentionKind::Avenge as u8
        || kind == IntentionKind::Defend as u8
        || kind == IntentionKind::Rescue as u8
}

/// Is an intention's predicate satisfied (so it should pop)? Belief/own-state only.
fn intention_satisfied(it: &Intention, pv: &Pv) -> bool {
    match it.kind {
        // believed-dead: I struck it down (Slew memory) OR I hold no belief about it any more.
        x if x == IntentionKind::Avenge as u8 || x == IntentionKind::Defend as u8 => {
            pv.memory.has(EpisodeKind::Slew, it.subject) || pv.beliefs.find(it.subject).is_none()
        }
        x if x == IntentionKind::SeekFortune as u8 => pv.gold >= it.amt,
        // sated: a meal is in the larder (needs.rs will eat it) — the foraging worked.
        x if x == IntentionKind::Sate as u8 => pv.inventory[Commodity::Food as usize] >= 1,
        // robbed the mark (the marker) or already met the heist's gold target.
        x if x == IntentionKind::Steal as u8 => {
            pv.memory.has(EpisodeKind::Robbed, it.subject) || pv.gold >= it.amt
        }
        x if x == IntentionKind::Donate as u8 || x == IntentionKind::Repay as u8 => {
            pv.memory.has(EpisodeKind::Gave, it.subject)
        }
        x if x == IntentionKind::Loot as u8 => pv.memory.has(EpisodeKind::Looted, it.subject),
        // freed the captive (the marker), or I no longer believe them held (someone else freed them).
        x if x == IntentionKind::Rescue as u8 => {
            pv.memory.has(EpisodeKind::Freed, it.subject)
                || pv.beliefs.find(it.subject).map_or(true, |ix| pv.beliefs.bodies[ix].flags & 0x02 == 0)
        }
        // plan-less dispositions pop on expiry only (handled in prune_goals).
        _ => false,
    }
}

/// The highest-priority AGGRESSIVE intention (avenge/defend) — the stand-and-fight arbitration, or None.
fn top_aggressive(gstack: &GoalStack) -> Option<usize> {
    let mut best: Option<usize> = None;
    for k in 0..gstack.len as usize {
        if !is_aggressive(gstack.items[k].kind) {
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

/// `inferDestination` (the ToM pursuit, `beliefs.ts`): the believed pursuit waypoint for a foe. While the
/// foe is freshly seen, that's simply where I believe it is. But once it has slipped out of sight (its
/// belief gone STALE), a hunter REASONS about where a fleeing quarry is MAKING FOR — the nearest way out
/// or hiding place from its last-known spot — and pursues THERE rather than freezing on a cold trail.
/// Belief-only + static mental-map (the epistemic split holds): no peeking at the quarry's true position.
#[inline]
fn infer_pursuit(b: &PersonBelief, map: &crate::mentalmap::MentalMap, now: u32) -> [f32; 2] {
    const STALE_TICKS: u32 = 30; // unseen this long ⇒ reason about its FLIGHT, not its last sighting
    let last = [b.last_x, b.last_z];
    if now.saturating_sub(b.last_tick) > STALE_TICKS {
        if let Some(p) = map.nearest(
            crate::mentalmap::AFF_EXIT | crate::mentalmap::AFF_CONCEAL,
            last,
            250.0,
        ) {
            return [p.x, p.z]; // it's bolting for the gate / a hiding place — cut it off there
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{Episode, GoalKind, Memory, Needs, PersonBelief};
    use crate::world::World;

    #[test]
    fn hungry_agent_with_food_picks_eat() {
        let mut w = World::spawn(0xBEEF, 64);
        w.needs[0].hunger = 0.0;
        w.needs[0].energy = 1.0;
        w.needs[0].comfort = 1.0;
        w.econ[0].inventory[Commodity::Food as usize] = 3; // carrying a meal ⇒ the reactive eat reflex
        w.beliefs[0].clear();
        decide(&mut w);
        assert_eq!(w.goal[0].kind(), GoalKind::Eat, "a hungry agent with food must choose Eat");
    }

    /// END-TO-END RESCUE (the dormant Free verb made live): a brave townsperson who believes a captive
    /// friend nearby braves the captor to cut their bonds — and the captive is freed.
    #[test]
    fn brave_soul_rescues_a_captive_friend() {
        let mut w = World::spawn(0x9E5C, 8);
        let (rescuer, captive, captor) = (0usize, 1usize, 2usize);
        // isolate: everyone else inert so only the rescue plays out.
        for i in 3..w.n {
            w.alive[i] = false;
        }
        w.faction[rescuer] = Faction::Townsfolk as u8;
        w.personality[rescuer].aggression = 0.95; // brave enough to dare it
        w.needs[rescuer] = Needs::default();
        w.econ[rescuer].inventory[Commodity::Food as usize] = 3;
        w.pos[rescuer] = [0.0, 0.0];
        w.memory[rescuer] = crate::components::Memory::default();
        w.goals[rescuer] = GoalStack::default();
        // the captive, held by a (distant, living) captor so only the rescuer can free it.
        w.faction[captive] = Faction::Townsfolk as u8;
        w.alive[captive] = true;
        w.pos[captive] = [4.0, 0.0];
        w.captive_of[captive] = captor as i32;
        w.alive[captor] = true;
        w.pos[captor] = [300.0, 0.0]; // far away — won't be freed by captor-death, won't interfere
        // the rescuer BELIEVES its friend is held captive right there.
        let bt = &mut w.beliefs[rescuer];
        bt.clear();
        bt.subjects[0] = captive as u32;
        bt.bodies[0] = PersonBelief {
            subject: captive as u32,
            last_x: 4.0,
            last_z: 0.0,
            confidence: 60000,
            standing: 8000, // a dear friend
            flags: 0x02,    // believed captive
            ..Default::default()
        };
        bt.len = 1;

        for _ in 0..12 {
            w.tick();
        }
        assert_eq!(
            w.captive_of[captive],
            crate::world::CAPTIVE_NONE,
            "the brave rescuer should have freed the captive friend"
        );
        assert!(
            w.memory[rescuer].has(EpisodeKind::Freed, captive as u32),
            "the rescuer remembers cutting the bonds (the settling marker)"
        );
    }

    /// WARBAND RALLY: a band follower whose leader is fighting a foe the follower ALSO perceives
    /// converges on that foe (the band stands together, overriding personal flee).
    #[test]
    fn band_follower_rallies_to_its_leaders_foe() {
        let mut w = World::spawn(0xBA9D, 16);
        let (leader, follower, foe) = (0usize, 1usize, 7u32);
        w.faction[follower] = Faction::Townsfolk as u8;
        w.needs[follower] = Needs::default();
        w.memory[follower] = crate::components::Memory::default();
        w.goals[follower] = GoalStack::default();
        w.econ[follower].inventory[Commodity::Food as usize] = 3;
        w.band_leader[follower] = leader as i32; // follows the leader
        // the leader is currently fighting the foe (the snapshot reads this last-tick goal).
        w.goal[leader] = Goal::Fight { target: foe, to: [40.0, 0.0] };
        // the follower ALSO perceives the foe (a shared, commonly-seen threat).
        let bt = &mut w.beliefs[follower];
        bt.clear();
        bt.subjects[0] = foe;
        bt.bodies[0] = PersonBelief { subject: foe, last_x: 38.0, last_z: 1.0, confidence: 60000, flags: 0x01, ..Default::default() };
        bt.len = 1;
        decide(&mut w);
        match w.goal[follower] {
            Goal::Fight { target, .. } => assert_eq!(target, foe, "the follower rallies to the leader's foe"),
            other => panic!("a band follower should rally to its leader's foe (Fight), got {other:?}"),
        }
    }

    /// A follower does NOT rally to a foe it cannot perceive (belief-gated — no blind cross-map charge).
    #[test]
    fn band_follower_ignores_an_unseen_foe() {
        let mut w = World::spawn(0xBA9E, 16);
        let (leader, follower) = (0usize, 1usize);
        w.faction[follower] = Faction::Townsfolk as u8;
        w.needs[follower] = Needs::default();
        w.memory[follower] = crate::components::Memory::default();
        w.goals[follower] = GoalStack::default();
        w.econ[follower].inventory[Commodity::Food as usize] = 3;
        w.band_leader[follower] = leader as i32;
        w.goal[leader] = Goal::Fight { target: 7, to: [40.0, 0.0] };
        w.beliefs[follower].clear(); // the follower perceives NOTHING — no shared threat
        decide(&mut w);
        assert_ne!(
            w.goal[follower].kind(),
            GoalKind::Fight,
            "a follower must not charge a foe it cannot see"
        );
    }

    /// SOFT NEEDS: an IDLE townsperson (no craft to ply, nothing pressing) whose social need has run
    /// down spends the idle time seeking company — the socialize fill. (Working townsfolk satisfy
    /// social passively at market/work and never reach this idle step — the marginal-economy design.)
    #[test]
    fn idle_lonely_townsperson_seeks_company() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.profession[i] = Profession::None as u8; // idle: no craft ⇒ reaches the idle-time step
        w.needs[i] = Needs::default();
        w.needs[i].social = 0.0; // starved for company
        w.beliefs[i].clear();
        w.memory[i] = crate::components::Memory::default();
        w.goals[i] = GoalStack::default();
        w.econ[i].inventory[Commodity::Food as usize] = 3; // not hungry (no forage override)
        decide(&mut w);
        assert_eq!(
            w.goal[i].kind(),
            GoalKind::Socialize,
            "an idle lonely townsperson should seek company"
        );
    }

    /// KNOW (the apprentice's goalLearn on the goal stack): a crafter who has NOT mastered its own
    /// craft's recipe poses a Know intention and is biased toward PRACTISING (Work) to firm it.
    #[test]
    fn an_unmastered_crafter_poses_a_know_goal_and_practises() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8 && w.profession[i] == 4) // a blacksmith
            .or_else(|| {
                // ensure at least one blacksmith
                let j = (0..w.n).find(|&j| w.faction[j] == Faction::Townsfolk as u8).unwrap();
                w.profession[j] = 4;
                Some(j)
            })
            .unwrap();
        w.needs[i] = Needs::default();
        w.econ[i].inventory[Commodity::Food as usize] = 3;
        w.beliefs[i].clear();
        w.memory[i] = crate::components::Memory::default();
        w.goals[i] = GoalStack::default();
        w.recipe[i][3] = 0.3; // rusty at the Tool craft → wants to master it
        decide(&mut w);
        assert!(
            (0..w.goals[i].len as usize).any(|k| w.goals[i].items[k].kind == IntentionKind::Know as u8),
            "an unmastered crafter poses a Know(recipe) intention on the stack"
        );
        assert_eq!(w.goal[i].kind(), GoalKind::Work, "and is biased toward practising its craft");
    }

    /// inferDestination (ToM pursuit): a FRESH belief pursues the quarry where it was last seen; once that
    /// belief goes STALE (the quarry slipped from sight), the hunter instead makes for the nearest exit /
    /// hiding place — reasoning about where a fleeing foe is bound, not freezing on a cold trail.
    #[test]
    fn a_hunter_infers_a_fled_quarrys_destination() {
        let map = crate::mentalmap::MentalMap::build([0.0, 0.0], &[[20.0, 0.0]], [0.0, 0.0], 200.0);
        let exit = map
            .nearest(crate::mentalmap::AFF_EXIT | crate::mentalmap::AFF_CONCEAL, [200.0, 0.0], 1000.0)
            .expect("the arena has an exit/conceal place");
        // a belief about a foe last seen out near that exit.
        let mut b = PersonBelief { subject: 7, last_x: 180.0, last_z: 0.0, last_tick: 1000, ..Default::default() };

        // FRESH (just seen): pursue the last-seen spot exactly.
        let fresh = infer_pursuit(&b, &map, 1000);
        assert_eq!(fresh, [b.last_x, b.last_z], "a freshly-seen quarry is pursued where it was seen");

        // STALE (unseen for a while): infer it bolted for the nearest way out / hiding place.
        b.last_tick = 1000;
        let stale = infer_pursuit(&b, &map, 1100); // 100 ticks later, well past STALE_TICKS
        assert_eq!(stale, [exit.x, exit.z], "a vanished quarry is pursued toward its inferred destination");
        assert_ne!(stale, [b.last_x, b.last_z], "the pursuit moved off the cold last-seen spot");
    }

    /// SCOUT (knowledge model): a curious IDLE townsperson with an uncertain-but-valuable hunch goes to
    /// observe it first-hand (firm the belief) rather than aimlessly wander.
    #[test]
    fn curious_idle_soul_scouts_a_vague_valuable_hunch() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.profession[i] = Profession::None as u8; // idle ⇒ reaches the scout tier
        w.personality[i].curiosity = 0.9; // a curious soul
        w.needs[i] = Needs::default(); // content (no survival/social/novelty pull)
        w.econ[i].inventory[Commodity::Food as usize] = 3;
        w.memory[i] = crate::components::Memory::default();
        w.goals[i] = GoalStack::default();
        // a vague (mid-confidence) belief about a believed-RICH subject — worth resolving.
        let bt = &mut w.beliefs[i];
        bt.clear();
        bt.subjects[0] = 42;
        bt.bodies[0] = PersonBelief {
            subject: 42,
            last_x: 30.0,
            last_z: 10.0,
            confidence: 20_000, // in the scout window (8k..45k)
            wealth: 40_000,     // a juicy mark
            ..Default::default()
        };
        bt.len = 1;
        decide(&mut w);
        assert_eq!(w.goal[i].kind(), GoalKind::Observe, "a curious idle soul should scout its hunch");
    }

    /// SUBSISTENCE: a hungry townsperson with an EMPTY larder no longer stalls on the inert Eat reflex
    /// — it poses a meal to the planner and forages/buys (Work or Market), the starvation-gap fix.
    #[test]
    fn foodless_hungry_townsperson_forages() {
        let mut w = World::spawn(0xBEEF, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i].hunger = 0.0; // starving
        w.needs[i].energy = 1.0;
        w.needs[i].comfort = 1.0;
        w.econ[i].inventory = [0; crate::components::N_COMMODITIES]; // empty larder
        w.beliefs[i].clear();
        w.memory[i] = crate::components::Memory::default();
        w.goals[i] = GoalStack::default();
        decide(&mut w);
        let k = w.goal[i].kind();
        assert!(
            k == GoalKind::Work || k == GoalKind::Market,
            "a foodless hungry soul should forage/buy (Work/Market), got {k:?} — not stall on Eat"
        );
        assert!(
            (0..w.goals[i].len as usize).any(|j| w.goals[i].items[j].kind == IntentionKind::Sate as u8),
            "a Sate intention should sit on the stack"
        );
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
                w.ambition[i] = crate::components::AMB_MASTERY; // pin non-wanderlust so it works/trades
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

    /// END-TO-END: a poor + bold + uncaring townsperson with a believed-rich neighbour in reach robs
    /// it — derive(steal) → plan(Took) → Goal::Interact{Rob} → act → Hand → conserved gold moves.
    #[test]
    fn poor_bold_thief_robs_a_rich_mark() {
        let mut w = World::spawn(0x5732A1, 8);
        // a townsperson thief next to a rich townsperson mark.
        let (thief, mark) = (0usize, 1usize);
        w.faction[thief] = Faction::Townsfolk as u8;
        w.faction[mark] = Faction::Townsfolk as u8;
        w.needs[thief] = Needs::default();
        w.econ[thief].gold = 0;
        w.personality[thief].risk_tolerance = 0.95;
        w.personality[thief].altruism = 0.05;
        w.pos[thief] = [0.0, 0.0];
        w.pos[mark] = [1.5, 0.0];
        w.econ[mark].gold = 50_000;
        w.wealth[mark] = 60_000; // the perceivable wealth cue (perceive copies this into the belief)
        // the thief BELIEVES the mark is rich + right here.
        w.beliefs[thief].clear();
        w.beliefs[thief].subjects[0] = mark as u32;
        w.beliefs[thief].bodies[0] = PersonBelief {
            subject: mark as u32,
            last_x: 1.5,
            last_z: 0.0,
            confidence: 60000,
            wealth: 60000,
            ..Default::default()
        };
        w.beliefs[thief].len = 1;
        w.goals[thief] = GoalStack::default();
        w.memory[thief] = Memory::default();

        let total = w.total_gold();
        let mark_before = w.econ[mark].gold;
        // run a handful of ticks: derive → plan → walk(already close) → rob → settle.
        for _ in 0..6 {
            w.tick();
        }
        assert!(w.econ[mark].gold < mark_before, "the rich mark should have been robbed");
        assert!(w.econ[thief].gold > 0, "the thief should have taken coin");
        assert_eq!(w.total_gold(), total, "gold conserved (moved by force, not minted)");
    }

    /// CAUTION (doc 11): a poor+bold+uncaring thief who would normally arm a heist DOESN'T once its rob
    /// strategy is burned past the bar — the burned hand. (The un-burned path is proven by
    /// `poor_bold_thief_robs_a_rich_mark`; this is the same setup minus the rob success, plus burns.)
    #[test]
    fn a_burned_thief_stops_arming_heists() {
        let mut w = World::spawn(0x5732A1, 8);
        let (thief, mark) = (0usize, 1usize);
        w.faction[thief] = Faction::Townsfolk as u8;
        w.faction[mark] = Faction::Townsfolk as u8;
        w.needs[thief] = Needs::default();
        w.econ[thief].gold = 0;
        w.personality[thief].risk_tolerance = 0.95;
        w.personality[thief].altruism = 0.05;
        w.pos[thief] = [0.0, 0.0];
        w.pos[mark] = [1.5, 0.0];
        w.beliefs[thief].clear();
        w.beliefs[thief].subjects[0] = mark as u32;
        w.beliefs[thief].bodies[0] = PersonBelief {
            subject: mark as u32,
            last_x: 1.5,
            last_z: 0.0,
            confidence: 60000,
            wealth: 60000,
            ..Default::default()
        };
        w.beliefs[thief].len = 1;
        w.goals[thief] = GoalStack::default();
        w.memory[thief] = Memory::default();
        // BURN the rob strategy hard (several wasted heists' worth) so the felt surcharge clears the bar.
        for _ in 0..6 {
            crate::experience::record_waste(
                &mut w.experience[thief].e[crate::planner::VERB_ROB as usize],
                0.0,
                w.tick,
            );
        }
        decide(&mut w);
        assert!(
            !(0..w.goals[thief].len as usize)
                .any(|k| w.goals[thief].items[k].kind == IntentionKind::Steal as u8),
            "a thief whose rob strategy is burned past the bar should NOT arm a fresh heist"
        );
    }

    /// A brave townsperson who believes a hostile is menacing a believed friend stands and fights it
    /// (overriding the flee reflex) — the pro-social `hostileNearFriend` behavior.
    #[test]
    fn brave_soul_defends_a_threatened_friend() {
        let mut w = World::spawn(0xDEFE4D, 64);
        let i = (0..w.n)
            .find(|&i| w.faction[i] == Faction::Townsfolk as u8)
            .expect("a townsperson exists");
        w.needs[i] = Needs::default();
        w.personality[i].aggression = 0.9;
        w.memory[i] = Memory::default();
        w.goals[i] = GoalStack::default();
        let bt = &mut w.beliefs[i];
        bt.clear();
        // a believed FRIEND at (20,0)…
        bt.subjects[0] = 5;
        bt.bodies[0] = PersonBelief { subject: 5, last_x: 20.0, last_z: 0.0, confidence: 60000, standing: 8000, ..Default::default() };
        // …and a believed HOSTILE right beside it.
        bt.subjects[1] = 9;
        bt.bodies[1] = PersonBelief { subject: 9, last_x: 22.0, last_z: 0.0, confidence: 60000, flags: 0x01, ..Default::default() };
        bt.len = 2;
        decide(&mut w);
        match w.goal[i] {
            Goal::Fight { target, .. } => assert_eq!(target, 9, "should fight the foe menacing the friend"),
            other => panic!("a brave soul should defend (Fight), got {other:?}"),
        }
    }

    /// END-TO-END: a wealthy generous townsperson with a food surplus gives to a believed-poor
    /// neighbour — and the recipient comes away with a `Succoured` memory (the repay seed).
    #[test]
    fn generous_soul_gives_alms_to_a_poor_neighbour() {
        use crate::components::Commodity;
        let mut w = World::spawn(0xA1335, 8);
        let (donor, poor) = (0usize, 1usize);
        w.faction[donor] = Faction::Townsfolk as u8;
        w.faction[poor] = Faction::Townsfolk as u8;
        w.needs[donor] = Needs::default();
        w.econ[donor].gold = 50_000;
        w.econ[donor].inventory[Commodity::Food as usize] = 5;
        w.personality[donor].altruism = 0.95;
        w.pos[donor] = [0.0, 0.0];
        w.pos[poor] = [1.5, 0.0];
        w.wealth[poor] = 0; // the perceivable "poor" cue
        w.econ[poor].inventory[Commodity::Food as usize] = 0;
        w.beliefs[donor].clear();
        w.beliefs[donor].subjects[0] = poor as u32;
        w.beliefs[donor].bodies[0] = PersonBelief {
            subject: poor as u32,
            last_x: 1.5,
            last_z: 0.0,
            confidence: 60000,
            wealth: 0,
            ..Default::default()
        };
        w.beliefs[donor].len = 1;
        w.goals[donor] = GoalStack::default();
        w.memory[donor] = Memory::default();
        w.memory[poor] = Memory::default();

        let total_food: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();
        for _ in 0..6 {
            w.tick();
        }
        assert!(
            w.econ[poor].inventory[Commodity::Food as usize] > 0,
            "the poor neighbour should have received food"
        );
        assert!(
            w.memory[poor].has(EpisodeKind::Succoured, donor as u32),
            "the recipient should remember being succoured (the repay seed)"
        );
        let total_after: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();
        assert_eq!(total_after, total_food, "food conserved (moved, not minted)");
    }

    /// A grateful soul who was succoured repays its benefactor in kind (closes the reciprocity loop).
    #[test]
    fn grateful_soul_repays_its_benefactor() {
        use crate::components::Commodity;
        let mut w = World::spawn(0x9EA7, 8);
        let (debtor, benefactor) = (0usize, 1usize);
        w.faction[debtor] = Faction::Townsfolk as u8;
        w.faction[benefactor] = Faction::Townsfolk as u8;
        w.needs[debtor] = Needs::default();
        w.econ[debtor].inventory[Commodity::Food as usize] = 4;
        w.pos[debtor] = [0.0, 0.0];
        w.pos[benefactor] = [1.5, 0.0];
        w.beliefs[debtor].clear();
        w.beliefs[debtor].subjects[0] = benefactor as u32;
        w.beliefs[debtor].bodies[0] = PersonBelief {
            subject: benefactor as u32,
            last_x: 1.5,
            last_z: 0.0,
            confidence: 60000,
            ..Default::default()
        };
        w.beliefs[debtor].len = 1;
        w.goals[debtor] = GoalStack::default();
        // I remember being succoured by the benefactor while desperate.
        w.memory[debtor] = Memory::default();
        w.memory[debtor].record(Episode {
            kind: EpisodeKind::Succoured as u8,
            with: benefactor as u32,
            t: w.tick,
            salience: 45000,
            ..Default::default()
        });
        let total_food: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();
        for _ in 0..6 {
            w.tick();
        }
        // the debt is discharged (the debtor gave to its benefactor) and food is conserved. (The
        // benefactor, now succoured in turn, may give back — an emergent reciprocity cascade — so we
        // assert the robust signal, not a net food level.)
        assert!(
            w.memory[debtor].has(EpisodeKind::Gave, benefactor as u32),
            "the debt should be discharged (a Gave marker on the debtor)"
        );
        let total_after: i32 = w.econ.iter().map(|e| e.inventory[Commodity::Food as usize]).sum();
        assert_eq!(total_after, total_food, "food conserved across the reciprocity");
    }

    /// END-TO-END: a victor who slew a believed-monied foe strips the corpse — the loot vertical closes
    /// the economy-on-death loop (the fallen's purse returns to circulation rather than stranding).
    #[test]
    fn a_victor_loots_a_slain_monied_foe() {
        let mut w = World::spawn(0x100D, 8);
        let (victor, corpse) = (0usize, 1usize);
        w.faction[victor] = Faction::Townsfolk as u8;
        w.needs[victor] = Needs::default();
        w.pos[victor] = [0.0, 0.0];
        w.pos[corpse] = [1.5, 0.0];
        w.alive[corpse] = false; // already fallen
        w.econ[corpse].gold = 7_000; // a purse worth taking
        w.beliefs[victor].clear();
        w.beliefs[victor].subjects[0] = corpse as u32;
        w.beliefs[victor].bodies[0] = PersonBelief {
            subject: corpse as u32,
            last_x: 1.5,
            last_z: 0.0,
            confidence: 60000,
            wealth: 60000, // believed to carry coin
            ..Default::default()
        };
        w.beliefs[victor].len = 1;
        w.goals[victor] = GoalStack::default();
        w.memory[victor] = Memory::default();
        w.memory[victor].record(Episode {
            kind: EpisodeKind::Slew as u8,
            with: corpse as u32,
            t: w.tick,
            salience: 60000,
            ..Default::default()
        });
        let total = w.total_gold();
        for _ in 0..6 {
            w.tick();
        }
        assert!(w.econ[victor].gold > 0, "the victor recovered the purse");
        assert_eq!(w.econ[corpse].gold, 0, "the corpse was stripped bare");
        assert!(
            w.memory[victor].has(EpisodeKind::Looted, corpse as u32),
            "the victor remembers stripping the corpse (the settling marker)"
        );
        assert_eq!(w.total_gold(), total, "gold conserved (moved off the corpse, not minted)");
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
