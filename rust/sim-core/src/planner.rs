//! The GOAP backward-chaining planner (the Rust port of `js/sim/planner.ts`, ported to its SPIRIT —
//! doc 22 §9, NO TS parity). A goal is a believed-state predicate (`Atom`); the planner finds a
//! `Primitive` whose EFFECT unifies with the open atom, pushes that primitive's unmet PRECONDITIONS
//! as fresh sub-atoms, recurses (depth-bounded), and keeps the min-cost feasible ordered step list.
//!
//! EPISTEMIC SPLIT (the hard invariant, preserved): every precondition / cost reads ONLY the agent's
//! OWN believed state — its inventory/gold, its belief table (believed positions of subjects), its
//! price beliefs, the static world POIs. It NEVER reads another agent's live columns. So a plan can be
//! wrong and fail at execution (a quarry moved); `decide` simply re-plans next tick. Pure, no panics,
//! depth + branching bounded (the freeze lesson).
//!
//! INTEGRATION: the planner is re-run each cognition tick and only its FIRST step is taken, which
//! `compile` maps onto the existing executor goals (Work/Market/Fight/…). Re-planning every tick (the
//! search is tiny + only runs for agents that actually hold a grudge/windfall) sidesteps plan-cache
//! staleness entirely — robustly deterministic, no persistent Plan column needed.

use crate::components::{
    EpisodeKind, Experience, Goal, InteractVerb, Memory, Plan, PlanStep, N_COMMODITIES,
    NONE_ID, PLAN_CAP,
};
use crate::experience::felt_surcharge;
use crate::world::N_WORK_SITES;

/// Backward-chaining recursion depth cap (mirrors `PLAN.maxDepth`).
const MAX_DEPTH: u32 = 5;
/// "Arrived" radius (matches locomotion's `ARRIVE`).
const ARRIVE: f32 = 1.0;
/// Melee reach (matches combat's `REACH`).
const REACH: f32 = 2.3;
/// Believed-distance → cost (mirrors `PLAN.travelPerMetre`).
const TRAVEL_PER_M: f32 = 0.08;
/// Flat cost of a non-travel act (mirrors `PLAN.actBase`).
const ACT_BASE: f32 = 1.0;

/// A "place" a believed position resolves from: a static POI or a believed subject (its last sighting).
#[derive(Clone, Copy)]
pub enum Place {
    Market,
    Node(u8),    // a resource/work site, keyed by the commodity gathered/produced there
    Subject(u32),
}

/// A believed-state predicate the solver chases (the public Atom subset the Wave-4 goals need).
#[derive(Clone, Copy)]
pub enum Atom {
    At(Place),
    Have(u8, u16), // commodity, count
    GoldGe(i64),
    Dead(u32),    // a subject believed dead (no belief / a `_slain` Slew memory)
    InReach(u32), // at a subject's believed position (melee reach)
    Took(u32),    // coin taken from a subject by force (satisfied by a `Robbed` memory marker)
    Gave(u32),    // a good handed to a subject (satisfied by a `Gave` memory marker — alms/repay)
    Looted(u32),  // a fallen subject's purse stripped (satisfied by a `Looted` memory marker)
    Freed(u32),   // a captive subject's bonds cut (satisfied by a `Freed` memory marker)
}

/// The acquire/move verbs the primitives bind to (compiled onto executor goals by `compile`).
#[derive(Clone, Copy)]
enum Verb {
    Goto,
    Gather,
    Produce,
    Buy,
    Sell,
    Approach,
    Attack,
    Rob,  // take coin from a believed mark by force (→ Goal::Interact{Rob})
    Give, // hand a good to a benefactor (→ Goal::Interact{Give})
    // DORMANT by design (like the dormant `wreck`/`hold` vocabulary): the Pay verb + its executor exist
    // end-to-end, but no `primitives_raw` arm emits a Pay step — repay/alms discharge in GOODS via `Give`
    // (`Atom::Gave`), not coin. Kept as ready vocabulary for a future coin-repayment atom; never reached
    // through the planner today.
    Pay,
    Loot, // strip a fallen target (→ Goal::Interact{Loot})
    Free, // cut a captive's bonds (→ Goal::Interact{Free})
}

/// One bound plan step (the concrete params an effect-match chose).
#[derive(Clone, Copy)]
struct Step {
    verb: Verb,
    place: Place,
    subject: u32,
    good: u8,
}

/// A solved sub-result: ordered steps (preconditions FIRST) + accumulated believed cost.
struct Solved {
    steps: Vec<Step>,
    cost: f32,
}

/// One bound primitive: the step it contributes, its unmet preconditions, and its believed cost.
struct Prim {
    step: Step,
    preconds: Vec<Atom>,
    cost: f32,
}

/// The believed-state view the planner reasons over — OWN state + the static world. Borrowed (the
/// belief/memory tables are large); everything here is the agent's own row or read-only world data.
pub struct Pv<'a> {
    pub pos: [f32; 2],
    pub gold: i64,
    pub inventory: [i32; N_COMMODITIES],
    pub price_belief: [u16; N_COMMODITIES],
    pub profession: u8,
    pub facts: &'a crate::components::FactStore,
    pub memory: &'a Memory,
    pub market: [f32; 2],
    pub work_sites: &'a [[f32; 2]; N_WORK_SITES],
    /// Nearest BERRY BUSH to the agent — where a Food forage routes (food is available everywhere via the
    /// distributed bushes, not just the town's single farm site). Precomputed when the view is built.
    pub forage: [f32; 2],
    pub base_price: &'a [i64; N_COMMODITIES],
    /// Outcome-conditioned caution (doc 11): the agent's own per-strategy surcharge store (Copy, by
    /// value) + its risk tolerance + now — read by `primitives_for` to price each strategy's `cost`.
    pub experience: Experience,
    pub risk_tolerance: f32,
    pub now: u32,
}

// ── good ⇄ work-site mapping (mirrors the PROFESSIONS output→site table) ──
// Commodity ids: Food0 Wood1 Ore2 Tool3 Herb4 Potion5. Profession ids (work_sites idx = prof-1):
// Farmer1 Miner2 Woodcutter3 Blacksmith4 Hunter5 Trader6.
#[inline]
fn good_site_index(good: u8) -> Option<usize> {
    match good {
        0 => Some(0), // Food   ← Farmer(1)
        1 => Some(2), // Wood   ← Woodcutter(3)
        2 => Some(1), // Ore    ← Miner(2)
        3 => Some(3), // Tool   ← Blacksmith(4)
        4 => Some(4), // Herb   ← Hunter(5)
        5 => Some(5), // Potion ← Trader(6)
        _ => None,
    }
}
/// Raw goods an agent can GATHER at a node without a profession (Food/Wood/Ore/Herb). Tool/Potion are
/// crafted (need the producing profession).
#[inline]
fn is_raw(good: u8) -> bool {
    matches!(good, 0 | 1 | 2 | 4)
}
/// The commodity a profession OUTPUTS (the produce row's effect), if any.
#[inline]
fn profession_output(prof: u8) -> Option<u8> {
    match prof {
        1 => Some(0), // Farmer → Food
        2 => Some(2), // Miner → Ore
        3 => Some(1), // Woodcutter → Wood
        4 => Some(3), // Blacksmith → Tool
        5 => Some(4), // Hunter → Herb
        6 => Some(5), // Trader → Potion
        _ => None,
    }
}

/// Believed position of a place (None ⇒ unknown/unreachable). Static POIs are always known; a subject
/// resolves to its last-believed sighting (own belief table only — never the live roster).
#[inline]
fn believed_pos(pv: &Pv, place: Place) -> Option<[f32; 2]> {
    match place {
        Place::Market => Some(pv.market),
        Place::Node(g) => good_site_index(g).map(|i| pv.work_sites[i]),
        Place::Subject(s) => pv.facts.view(s).map(|b| [b.last_x, b.last_z]),
    }
}

/// Believed travel cost to a place (∞ when unknown — the branch that needs it then fails).
#[inline]
fn travel_cost(pv: &Pv, place: Place) -> f32 {
    match believed_pos(pv, place) {
        Some(t) => {
            let dx = t[0] - pv.pos[0];
            let dz = t[1] - pv.pos[1];
            (dx * dx + dz * dz).sqrt() * TRAVEL_PER_M
        }
        None => f32::INFINITY,
    }
}

/// Effective believed price of a good — the per-agent price belief if held, else the base price.
#[inline]
fn eff_price(pv: &Pv, good: u8) -> i64 {
    let pb = pv.price_belief[good as usize];
    if pb > 0 {
        pb as i64
    } else {
        pv.base_price[good as usize]
    }
}

/// The best good to SELL toward a gold target: a surplus we hold, highest believed price (lowest good
/// id breaks ties — deterministic). None ⇒ nothing sellable.
fn best_sellable(pv: &Pv) -> Option<(u8, i64)> {
    let mut best: Option<(u8, i64)> = None;
    for g in 0..N_COMMODITIES {
        if pv.inventory[g] <= 0 {
            continue;
        }
        let price = eff_price(pv, g as u8);
        match best {
            Some((_, bp)) if price <= bp => {}
            _ => best = Some((g as u8, price)),
        }
    }
    best
}

/// Is the believed-state atom already satisfied? (own state only.)
fn atom_holds(atom: &Atom, pv: &Pv) -> bool {
    match *atom {
        Atom::At(place) => match believed_pos(pv, place) {
            Some(t) => {
                let dx = t[0] - pv.pos[0];
                let dz = t[1] - pv.pos[1];
                (dx * dx + dz * dz).sqrt() <= ARRIVE + 0.01
            }
            None => false,
        },
        Atom::Have(g, n) => pv.inventory[g as usize] >= n as i32,
        Atom::GoldGe(amt) => pv.gold >= amt,
        // "believed dead": I struck the killing blow (a Slew memory) OR I hold no belief about it at
        // all (lost all track — never confused with a faded sighting, which keeps a belief entry).
        Atom::Dead(s) => pv.memory.has(EpisodeKind::Slew, s) || !pv.facts.believes(s),
        Atom::InReach(s) => match believed_pos(pv, Place::Subject(s)) {
            Some(t) => {
                let dx = t[0] - pv.pos[0];
                let dz = t[1] - pv.pos[1];
                (dx * dx + dz * dz).sqrt() <= REACH
            }
            None => false,
        },
        // coin taken: true once a `Robbed` marker for this mark is in memory (the act phase + merge
        // stamp it — like `Slew` for avenge). A priori unmet, so a fresh steal plans goto→approach→rob.
        Atom::Took(s) => pv.memory.has(EpisodeKind::Robbed, s),
        // good given: true once a `Gave` marker for this recipient is in memory (alms/repay).
        Atom::Gave(s) => pv.memory.has(EpisodeKind::Gave, s),
        // corpse stripped: true once a `Looted` marker for this fallen subject is in memory.
        Atom::Looted(s) => pv.memory.has(EpisodeKind::Looted, s),
        // bonds cut: true once a `Freed` marker for this captive is in memory.
        Atom::Freed(s) => pv.memory.has(EpisodeKind::Freed, s),
    }
}

/// The bound primitives whose EFFECT unifies with `atom` (the backward-chaining candidates). Each
/// carries its step, its unmet preconditions, and its believed cost. Infeasible binds (an unreachable
/// goto) are dropped here so the failing branch simply has no candidate.
fn primitives_for(atom: &Atom, pv: &Pv) -> Vec<Prim> {
    let mut prims = primitives_raw(atom, pv);
    // OUTCOME-CONDITIONED CAUTION (doc 11): price each candidate strategy's learned surcharge into its
    // cost (beside travel/act cost) — a strategy that keeps failing feels dearer, a proven one cheaper.
    // 0 for the verbs that never get an outcome written, so ordinary plans are unaffected.
    for p in prims.iter_mut() {
        p.cost += felt_surcharge(&pv.experience, verb_u8(p.step.verb), pv.risk_tolerance, pv.now);
    }
    prims
}

/// The raw effect-unifying primitives (before the caution surcharge is priced in).
fn primitives_raw(atom: &Atom, pv: &Pv) -> Vec<Prim> {
    match *atom {
        // goto(place): effect At(place); no precondition (movement is primitive). Drop if unreachable.
        Atom::At(place) => {
            let cost = travel_cost(pv, place);
            if cost.is_finite() {
                vec![Prim {
                    step: Step { verb: Verb::Goto, place, subject: 0, good: 0 },
                    preconds: Vec::new(),
                    cost,
                }]
            } else {
                Vec::new()
            }
        }
        // have(good): gather a raw good at its node, OR produce it (own profession), OR buy it.
        Atom::Have(good, n) => {
            let mut v = Vec::new();
            if is_raw(good) {
                v.push(Prim {
                    step: Step { verb: Verb::Gather, place: Place::Node(good), subject: 0, good },
                    preconds: vec![Atom::At(Place::Node(good))],
                    cost: ACT_BASE * n as f32,
                });
            }
            if profession_output(pv.profession) == Some(good) {
                v.push(Prim {
                    step: Step { verb: Verb::Produce, place: Place::Node(good), subject: 0, good },
                    preconds: vec![Atom::At(Place::Node(good))],
                    cost: ACT_BASE * 2.0 * n as f32,
                });
            }
            let price = eff_price(pv, good);
            v.push(Prim {
                step: Step { verb: Verb::Buy, place: Place::Market, subject: 0, good },
                preconds: vec![Atom::At(Place::Market), Atom::GoldGe(price * n as i64)],
                cost: (price * n as i64) as f32,
            });
            v
        }
        // gold_ge(amt): sell a surplus good at the believed market.
        Atom::GoldGe(_amt) => match best_sellable(pv) {
            Some((good, _price)) => vec![Prim {
                step: Step { verb: Verb::Sell, place: Place::Market, subject: 0, good },
                preconds: vec![Atom::At(Place::Market), Atom::Have(good, 1)],
                cost: ACT_BASE,
            }],
            None => Vec::new(),
        },
        // dead(subj): attack it; precondition is being in melee reach.
        Atom::Dead(s) => vec![Prim {
            step: Step { verb: Verb::Attack, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::InReach(s)],
            cost: ACT_BASE * 3.0,
        }],
        // in_reach(subj): approach it; precondition is being AT its believed position.
        Atom::InReach(s) => vec![Prim {
            step: Step { verb: Verb::Approach, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::At(Place::Subject(s))],
            cost: 0.0,
        }],
        // took(subj): rob it by force; precondition is being in reach (the heist's reach-and-take).
        Atom::Took(s) => vec![Prim {
            step: Step { verb: Verb::Rob, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::InReach(s)],
            cost: ACT_BASE * 2.0,
        }],
        // gave(subj): hand it a good; precondition is being in reach (alms/repay reach-and-give).
        Atom::Gave(s) => vec![Prim {
            step: Step { verb: Verb::Give, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::InReach(s)],
            cost: ACT_BASE,
        }],
        // looted(subj): strip its corpse; precondition is being in reach (the reach-and-take, like rob).
        Atom::Looted(s) => vec![Prim {
            step: Step { verb: Verb::Loot, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::InReach(s)],
            cost: ACT_BASE,
        }],
        // freed(subj): cut its bonds; precondition is being in reach (the reach-and-free, like give).
        Atom::Freed(s) => vec![Prim {
            step: Step { verb: Verb::Free, place: Place::Subject(s), subject: s, good: 0 },
            preconds: vec![Atom::InReach(s)],
            cost: ACT_BASE,
        }],
    }
}

/// Backward-chain `atom` to a min-cost ordered step list (preconditions first). Bounded depth + finite
/// branching ⇒ always terminates. Returns `Some(empty)` when the atom already holds.
fn solve(atom: &Atom, pv: &Pv, depth: u32) -> Option<Solved> {
    if atom_holds(atom, pv) {
        return Some(Solved { steps: Vec::new(), cost: 0.0 });
    }
    if depth >= MAX_DEPTH {
        return None;
    }
    let mut best: Option<Solved> = None;
    for prim in primitives_for(atom, pv) {
        let mut steps = Vec::new();
        let mut cost = prim.cost;
        let mut ok = true;
        for pre in &prim.preconds {
            match solve(pre, pv, depth + 1) {
                Some(s) => {
                    steps.extend(s.steps);
                    cost += s.cost;
                }
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        steps.push(prim.step);
        let cand = Solved { steps, cost };
        best = Some(match best {
            None => cand,
            Some(b) => {
                if cand.cost < b.cost {
                    cand
                } else {
                    b
                }
            }
        });
    }
    best
}

/// Build a moving Fight goal toward a subject's believed position (or stand if its belief is gone).
#[inline]
fn fight_goal(pv: &Pv, s: u32) -> Goal {
    let to = believed_pos(pv, Place::Subject(s)).unwrap_or(pv.pos);
    Goal::Fight { target: s, to }
}

/// Compile a plan step onto the executor goal that carries it out this tick (the planner's vocabulary
/// → the existing Work/Market/Fight/… executors). Locomotion + the on-arrival verb systems do the rest.
fn compile(step: Step, pv: &Pv) -> Goal {
    match step.verb {
        Verb::Goto => match step.place {
            Place::Market => Goal::Market { site: pv.market },
            Place::Node(g) => Goal::Work { site: pv.work_sites[good_site_index(g).unwrap_or(0)] },
            Place::Subject(s) => fight_goal(pv, s),
        },
        // GATHER is capital-free foraging open to any agent (→ Goal::Gather carries the good); PRODUCE
        // is the agent's own-profession output (→ Goal::Work, minted by the production pass).
        Verb::Gather => {
            // Food forages at the nearest BERRY BUSH (distributed availability); other raw goods at the
            // town's resource node for that good.
            let site = if step.good == 0 {
                pv.forage
            } else {
                pv.work_sites[good_site_index(step.good).unwrap_or(0)]
            };
            Goal::Gather { site, good: step.good }
        }
        Verb::Produce => {
            Goal::Work { site: pv.work_sites[good_site_index(step.good).unwrap_or(0)] }
        }
        Verb::Buy | Verb::Sell => Goal::Market { site: pv.market },
        Verb::Approach | Verb::Attack => fight_goal(pv, step.subject),
        Verb::Rob | Verb::Give | Verb::Pay | Verb::Loot | Verb::Free => {
            let to = believed_pos(pv, Place::Subject(step.subject)).unwrap_or(pv.pos);
            action_goal(verb_u8(step.verb), step.subject, to)
        }
    }
}

/// Plan toward `goal_atom` and return the compiled executor goal for its FIRST step. `None` when the
/// goal already holds (nothing to do — the caller falls through) or no feasible plan exists.
pub fn plan(goal_atom: Atom, pv: &Pv) -> Option<Goal> {
    let solved = solve(&goal_atom, pv, 0)?;
    let step = *solved.steps.first()?;
    Some(compile(step, pv))
}

// ── serializable cached-plan API (the persistent goal-stack's plan cache) ────────────────────────────
// `plan()` above re-solves + takes the first step each call. The goal-stack instead caches the FULL
// ordered plan and advances a cursor as each step's effect lands (so a feature's caution trail can
// attach to a persistent step). These convert the internal `Step` to the inline `PlanStep` and back.

const VERB_GOTO: u8 = 0;
const VERB_GATHER: u8 = 1;
const VERB_PRODUCE: u8 = 2;
const VERB_BUY: u8 = 3;
const VERB_SELL: u8 = 4;
const VERB_APPROACH: u8 = 5;
const VERB_ATTACK: u8 = 6;
/// The watched theft strategy id (doc 11 caution): the rob verb's experience slot. Public so the
/// outcome writers (`decide` burn-on-failure, `drain_intents` windfall-on-success) key the same slot.
pub const VERB_ROB: u8 = 7;
const VERB_GIVE: u8 = 8;
const VERB_PAY: u8 = 9;
const VERB_LOOT: u8 = 10;
const VERB_FREE: u8 = 11;

#[inline]
fn verb_u8(v: Verb) -> u8 {
    match v {
        Verb::Goto => VERB_GOTO,
        Verb::Gather => VERB_GATHER,
        Verb::Produce => VERB_PRODUCE,
        Verb::Buy => VERB_BUY,
        Verb::Sell => VERB_SELL,
        Verb::Approach => VERB_APPROACH,
        Verb::Attack => VERB_ATTACK,
        Verb::Rob => VERB_ROB,
        Verb::Give => VERB_GIVE,
        Verb::Pay => VERB_PAY,
        Verb::Loot => VERB_LOOT,
        Verb::Free => VERB_FREE,
    }
}

#[inline]
fn step_to_planstep(s: Step) -> PlanStep {
    match s.place {
        Place::Market => {
            PlanStep { verb: verb_u8(s.verb), place_kind: 0, good: s.good, _pad: 0, subject: NONE_ID, n: 1, _pad2: 0 }
        }
        Place::Node(g) => PlanStep {
            verb: verb_u8(s.verb),
            place_kind: 1,
            good: if s.good != 0 { s.good } else { g },
            _pad: 0,
            subject: NONE_ID,
            n: 1,
            _pad2: 0,
        },
        Place::Subject(sub) => PlanStep {
            verb: verb_u8(s.verb),
            place_kind: 2,
            good: 0,
            _pad: 0,
            subject: if s.subject != 0 { s.subject } else { sub },
            n: 1,
            _pad2: 0,
        },
    }
}

#[inline]
fn planstep_place(ps: &PlanStep) -> Place {
    match ps.place_kind {
        0 => Place::Market,
        1 => Place::Node(ps.good),
        _ => Place::Subject(ps.subject),
    }
}

/// Solve `goal_atom` to the FULL ordered serializable plan (preconds first), capped at `PLAN_CAP`.
/// `None` when the goal already holds (empty plan) or is infeasible.
pub fn solve_plan(goal_atom: Atom, pv: &Pv) -> Option<Vec<PlanStep>> {
    let solved = solve(&goal_atom, pv, 0)?;
    if solved.steps.is_empty() {
        return None; // already holds — the caller's predicate prunes the goal
    }
    Some(solved.steps.into_iter().take(PLAN_CAP).map(step_to_planstep).collect())
}

/// Has a cached step's EFFECT landed (so the cursor can advance)? Per-verb, belief-grounded — the
/// inline analogue of the registry's EFFECT_HOLDS. `Sell` is terminal (the goal's own gold predicate
/// ends it), so it never self-advances.
pub fn step_effect_holds(ps: &PlanStep, pv: &Pv) -> bool {
    match ps.verb {
        VERB_GOTO => atom_holds(&Atom::At(planstep_place(ps)), pv),
        VERB_APPROACH => atom_holds(&Atom::InReach(ps.subject), pv),
        VERB_ATTACK => atom_holds(&Atom::Dead(ps.subject), pv),
        VERB_GATHER | VERB_PRODUCE | VERB_BUY => {
            pv.inventory[ps.good as usize] >= ps.n.max(1) as i32
        }
        // a forceful rob / a gift / a corpse-strip lands when its memory marker is present.
        VERB_ROB => atom_holds(&Atom::Took(ps.subject), pv),
        VERB_GIVE => atom_holds(&Atom::Gave(ps.subject), pv),
        VERB_LOOT => atom_holds(&Atom::Looted(ps.subject), pv),
        VERB_FREE => atom_holds(&Atom::Freed(ps.subject), pv),
        // SELL and the other terminal acts (give/pay/loot) do NOT self-advance — they are the last
        // step and the goal's own predicate (gold target / received / robbed) ends the plan. A
        // `_ => true` here would skip the terminal act before the `act` phase ever fired it.
        _ => false,
    }
}

/// Compile a cached step onto the executor goal that carries it out this tick (same mapping as the
/// internal `compile`, but from the serializable `PlanStep`).
pub fn compile_planstep(ps: &PlanStep, pv: &Pv) -> Goal {
    match ps.verb {
        VERB_GOTO => match planstep_place(ps) {
            Place::Market => Goal::Market { site: pv.market },
            Place::Node(g) => Goal::Work { site: pv.work_sites[good_site_index(g).unwrap_or(0)] },
            Place::Subject(s) => fight_goal(pv, s),
        },
        VERB_GATHER => {
            let site = if ps.good == 0 {
                pv.forage // Food → nearest berry bush
            } else {
                pv.work_sites[good_site_index(ps.good).unwrap_or(0)]
            };
            Goal::Gather { site, good: ps.good }
        }
        VERB_PRODUCE => Goal::Work { site: pv.work_sites[good_site_index(ps.good).unwrap_or(0)] },
        VERB_BUY | VERB_SELL => Goal::Market { site: pv.market },
        VERB_APPROACH | VERB_ATTACK => fight_goal(pv, ps.subject),
        _ => Goal::Idle,
    }
}

/// The executor goal for a subject-directed plan: the plan's TERMINAL verb (attack vs rob/give/pay/
/// loot) decides whether the agent fights or interacts on arrival, while it walks toward `to`.
#[inline]
fn action_goal(terminal_verb: u8, subj: u32, to: [f32; 2]) -> Goal {
    match terminal_verb {
        VERB_ROB => Goal::Interact { verb: InteractVerb::Rob as u8, target: subj, to },
        VERB_GIVE => Goal::Interact { verb: InteractVerb::Give as u8, target: subj, to },
        VERB_PAY => Goal::Interact { verb: InteractVerb::Pay as u8, target: subj, to },
        VERB_LOOT => Goal::Interact { verb: InteractVerb::Loot as u8, target: subj, to },
        VERB_FREE => Goal::Interact { verb: InteractVerb::Free as u8, target: subj, to },
        // VERB_ATTACK (and any approach/goto fallback): the combat path.
        _ => Goal::Fight { target: subj, to },
    }
}

/// Compile the cached plan's CURRENT step to an executor goal, terminal-aware: a SUBJECT-directed leg
/// (place_kind 2 — goto/approach/act on the mark) emits the plan's terminal ACTION goal (Fight or
/// Interact{verb}) so the agent both walks to the subject AND does the right thing on arrival; a
/// resource leg (market/node) compiles step-by-step (Work/Market). `None` when the plan is consumed.
pub fn compile_current(plan: &Plan, pv: &Pv) -> Option<Goal> {
    let step = plan.current()?;
    if step.place_kind == 2 {
        let subj = step.subject;
        let to = believed_pos(pv, Place::Subject(subj)).unwrap_or(pv.pos);
        let terminal = plan.steps[(plan.len as usize).saturating_sub(1)].verb;
        Some(action_goal(terminal, subj, to))
    } else {
        Some(compile_planstep(&step, pv))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::components::{BeliefTable, FactStore, Memory, PersonBelief};
    use crate::world::{World, N_WORK_SITES};

    /// Build a Pv borrowing agent `i`'s own state from a world (the same wiring `decide` uses).
    fn pv_of<'a>(
        w: &'a World,
        i: usize,
        facts: &'a FactStore,
        memory: &'a Memory,
        work_sites: &'a [[f32; 2]; N_WORK_SITES],
        base_price: &'a [i64; N_COMMODITIES],
    ) -> Pv<'a> {
        Pv {
            pos: w.pos[i],
            gold: w.econ[i].gold,
            inventory: w.econ[i].inventory,
            price_belief: w.econ[i].price_belief,
            profession: w.profession[i],
            facts,
            memory,
            market: w.markets[0],
            work_sites,
            forage: w.forage_pos.first().copied().unwrap_or(w.pos[i]),
            base_price,
            experience: w.experience[i],
            risk_tolerance: w.personality[i].risk_tolerance,
            now: w.tick,
        }
    }

    #[test]
    fn avenge_plans_a_moving_fight() {
        let w = World::spawn(0xA0, 4);
        // I believe my foe (id 7) is 50m away — Dead(7) should plan goto→approach→attack, whose first
        // compiled step is a moving Fight toward the believed position.
        let mut beliefs = BeliefTable::default();
        beliefs.subjects[0] = 7;
        beliefs.bodies[0] = PersonBelief {
            subject: 7,
            last_x: w.pos[0][0] + 50.0,
            last_z: w.pos[0][1],
            confidence: 60000,
            ..Default::default()
        };
        beliefs.len = 1;
        let mut facts = FactStore::default();
        facts.mirror_core_from(&beliefs);
        let memory = Memory::default();
        let ws = w.work_sites[0];
        let bp = w.base_price;
        let pv = pv_of(&w, 0, &facts, &memory, &ws, &bp);
        match plan(Atom::Dead(7), &pv) {
            Some(Goal::Fight { target, to }) => {
                assert_eq!(target, 7, "should hunt the believed foe");
                assert!((to[0] - (w.pos[0][0] + 50.0)).abs() < 1e-3, "approach the believed pos");
            }
            other => panic!("expected a moving Fight, got {other:?}"),
        }
    }

    #[test]
    fn avenge_settled_when_slain() {
        let w = World::spawn(0xA1, 4);
        let mut beliefs = BeliefTable::default();
        beliefs.subjects[0] = 7;
        beliefs.bodies[0] = PersonBelief { subject: 7, confidence: 60000, ..Default::default() };
        beliefs.len = 1;
        let mut facts = FactStore::default();
        facts.mirror_core_from(&beliefs);
        // a Slew memory about 7 ⇒ Dead(7) already holds ⇒ no plan (the grudge is settled).
        let mut memory = Memory::default();
        memory.record(crate::components::Episode {
            kind: EpisodeKind::Slew as u8,
            with: 7,
            salience: 60000,
            ..Default::default()
        });
        let ws = w.work_sites[0];
        let bp = w.base_price;
        let pv = pv_of(&w, 0, &facts, &memory, &ws, &bp);
        assert!(plan(Atom::Dead(7), &pv).is_none(), "a slain foe yields no avenge plan");
    }

    #[test]
    fn seek_fortune_routes_to_market_via_sell() {
        let mut w = World::spawn(0xA2, 4);
        // hold a surplus good + be poor + far from market ⇒ GoldGe should plan [goto(market), sell],
        // whose first compiled step is a Market trip.
        w.econ[0].inventory = [9, 0, 0, 0, 0, 0]; // surplus Food
        w.econ[0].gold = 0;
        w.pos[0] = [w.markets[0][0] + 80.0, w.markets[0][1] + 80.0];
        let facts = FactStore::default();
        let memory = Memory::default();
        let ws = w.work_sites[0];
        let bp = w.base_price;
        let pv = pv_of(&w, 0, &facts, &memory, &ws, &bp);
        match plan(Atom::GoldGe(5000), &pv) {
            Some(Goal::Market { .. }) => {}
            other => panic!("seek-fortune should route to market, got {other:?}"),
        }
    }

    #[test]
    fn already_rich_no_fortune_plan() {
        let mut w = World::spawn(0xA3, 4);
        w.econ[0].gold = 999_999;
        let facts = FactStore::default();
        let memory = Memory::default();
        let ws = w.work_sites[0];
        let bp = w.base_price;
        let pv = pv_of(&w, 0, &facts, &memory, &ws, &bp);
        assert!(plan(Atom::GoldGe(5000), &pv).is_none(), "an already-rich agent needs no plan");
    }
}
