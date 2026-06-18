//! The ACT phase — the on-arrival executor for `Goal::Interact` (the Rust analogue of the
//! `js/sim/agent/act.ts` executor registry's give/pay/rob/loot verbs). Ports the SPIRIT to the
//! parallel/intent model: locomotion has already walked the agent toward the interaction goal's `to`
//! (the subject's believed position); here, when in REACH, the agent emits a CONSERVED `Intent::Hand`
//! (and a `Deed` for progression/witnesses) that the deterministic merge applies. No agent writes
//! another's columns — every cross-agent effect is an intent, so M=1 ≡ M=N holds.
//!
//! Wave-A wires the conserved-handover verbs (give/pay/rob/loot); free/wreck are dormant until the
//! captivity/building state lands. The planner produces `Goal::Interact` once its give/pay/rob/loot
//! primitives are added (Wave C); until then this phase is exercised only by its unit tests.

use rayon::prelude::*;

use crate::components::{Goal, InteractVerb};
use crate::intent::Intent;
use crate::tags::{motive, outcome, Tag};
use crate::world::World;

/// Melee/handover reach (believed-pos to target), matching combat's `REACH`.
const REACH: f32 = 2.3;
const REACH2: f32 = REACH * REACH;

/// Coin taken in a forceful robbery (mirrors `ROB.amount`, minor units).
const ROB_AMOUNT: i64 = 2_000;
/// Coin handed over in a repay-in-coin (mirrors a pay step).
const PAY_AMOUNT: i64 = 1_000;
/// Units of the gift good handed over (mirrors `PLAN.giftN`); good 0 = Food.
const GIFT_QTY: i32 = 1;
const GIFT_GOOD: u8 = 0;

/// Deed verb tags (opaque ids consumed by progression/witness folds; distinct from the strike tag 0).
const VERB_GIVE: u8 = 10;
const VERB_PAY: u8 = 11;
const VERB_ROB: u8 = 12;
const VERB_LOOT: u8 = 13;
const VERB_FREE: u8 = 14;

pub fn act(world: &mut World) {
    let n = world.n;
    let World { ref pos, ref goal, ref alive, ref econ, ref captive_of, .. } = *world;

    // Parallel: each agent inspects ONLY its own goal/pos; cross-agent effects are emitted as intents.
    let out: Vec<Intent> = (0..n)
        .into_par_iter()
        .flat_map_iter(|i| {
            let mut emit: Vec<Intent> = Vec::new();
            if !alive[i] {
                return emit.into_iter();
            }
            if let Goal::Interact { verb, target, to } = goal[i] {
                let t = target as usize;
                if t >= n || t == i {
                    return emit.into_iter();
                }
                // in reach of where I believe the subject is?
                let dx = pos[i][0] - to[0];
                let dz = pos[i][1] - to[1];
                if dx * dx + dz * dz > REACH2 {
                    return emit.into_iter(); // locomotion closes the gap on a later tick.
                }
                let me = i as u32;
                match verb {
                    v if v == InteractVerb::Give as u8 => {
                        // hand a good to the target (only if I hold one — Hand clamps anyway).
                        if econ[i].inventory[GIFT_GOOD as usize] >= GIFT_QTY {
                            emit.push(Intent::Hand { from: me, to: target, gold: 0, good: GIFT_GOOD, qty: GIFT_QTY });
                            emit.push(Intent::deed(me, target, GIFT_QTY as u16, Tag::Give.bit(), motive::MERCY, outcome::SUCCESS | outcome::GAINED));
                        }
                    }
                    v if v == InteractVerb::Pay as u8 => {
                        if econ[i].gold >= PAY_AMOUNT {
                            emit.push(Intent::Hand { from: me, to: target, gold: PAY_AMOUNT, good: 0, qty: 0 });
                            emit.push(Intent::deed(me, target, 1, Tag::Give.bit() | Tag::Repay.bit(), motive::DUTY, outcome::SUCCESS));
                        }
                    }
                    v if v == InteractVerb::Rob as u8 => {
                        // take coin from the target by force (Hand clamps to the victim's purse).
                        emit.push(Intent::Hand { from: target, to: me, gold: ROB_AMOUNT, good: 0, qty: 0 });
                        emit.push(Intent::deed(me, target, 1, Tag::Rob.bit() | Tag::Steal.bit() | Tag::Stealth.bit() | Tag::Risk.bit(), motive::GREED, outcome::ROBBED | outcome::GAINED | outcome::SUCCESS));
                        // doc 25: the victim now BELIEVES the robber owes it what was taken — a quantitative
                        // open-fact debt the struct could never carry (drives the collect_debt vendetta).
                        emit.push(Intent::Owe { creditor: target, debtor: me, amount: ROB_AMOUNT });
                    }
                    v if v == InteractVerb::Loot as u8 => {
                        // strip a fallen target's whole purse.
                        if !alive[t] {
                            let purse = econ[t].gold;
                            if purse > 0 {
                                emit.push(Intent::Hand { from: target, to: me, gold: purse, good: 0, qty: 0 });
                                emit.push(Intent::deed(me, target, 1, Tag::Loot.bit() | Tag::Stealth.bit(), motive::GREED, outcome::GAINED | outcome::SUCCESS));
                            }
                        }
                    }
                    v if v == InteractVerb::Free as u8 => {
                        // cut a captive's bonds (only if the target is actually held — truth read).
                        if captive_of[t] != crate::world::CAPTIVE_NONE {
                            emit.push(Intent::deed(me, target, 1, Tag::Free.bit() | Tag::Rescue.bit(), motive::MERCY | motive::LOYALTY, outcome::FREED | outcome::SUCCESS));
                        }
                    }
                    _ => {} // wreck: dormant until building state lands.
                }
            }
            emit.into_iter()
        })
        .collect();

    world.intents.items.extend(out);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::Commodity;

    #[test]
    fn give_hands_a_good_when_in_reach() {
        let mut w = World::spawn(0xAC1, 4);
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [1.0, 0.0];
        w.econ[0].inventory[Commodity::Food as usize] = 2;
        w.econ[1].inventory[Commodity::Food as usize] = 0;
        w.goal[0] = Goal::Interact { verb: InteractVerb::Give as u8, target: 1, to: [1.0, 0.0] };
        let total = w.total_gold();
        act(&mut w);
        w.drain_intents();
        assert_eq!(w.econ[0].inventory[Commodity::Food as usize], 1, "giver lost a unit");
        assert_eq!(w.econ[1].inventory[Commodity::Food as usize], 1, "receiver gained a unit");
        assert_eq!(w.total_gold(), total, "gold untouched");
    }

    #[test]
    fn rob_takes_coin_when_in_reach_and_conserves() {
        let mut w = World::spawn(0xAC2, 4);
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [1.0, 0.0];
        w.econ[1].gold = 5_000;
        let total = w.total_gold();
        w.goal[0] = Goal::Interact { verb: InteractVerb::Rob as u8, target: 1, to: [1.0, 0.0] };
        act(&mut w);
        w.drain_intents();
        assert!(w.econ[0].gold > 0, "robber gained coin");
        assert!(w.econ[1].gold < 5_000, "victim lost coin");
        assert_eq!(w.total_gold(), total, "gold conserved (moved, not minted)");
    }

    #[test]
    fn out_of_reach_no_effect() {
        let mut w = World::spawn(0xAC3, 4);
        w.pos[0] = [0.0, 0.0];
        w.pos[1] = [50.0, 0.0];
        w.econ[1].gold = 5_000;
        w.goal[0] = Goal::Interact { verb: InteractVerb::Rob as u8, target: 1, to: [50.0, 0.0] };
        act(&mut w);
        assert!(w.intents.items.is_empty(), "no intent emitted out of reach");
    }
}
