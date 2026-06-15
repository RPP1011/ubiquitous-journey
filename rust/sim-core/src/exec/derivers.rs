//! The CORE memory→goal derivers (`deriveGoals`'s built-in rows, ported from `js/sim/motivation.js`).
//! Each scans the agent's OWN salient memory and pushes a standing intention; `GoalStack::push` dedups
//! + refreshes, so re-running every tick is idempotent. Feature derivers live in their own files and
//! append to `registry::DERIVERS`.

use crate::components::{EpisodeKind, Faction, GoalStack, Intention, IntentionKind, NONE_ID};
use crate::exec::registry::DeriveCtx;

/// How long a grudge stays live (ticks) before it cools out (mirrors `MOTIVE.avengeExpiry`).
const AVENGE_EXPIRY: u32 = 1200;
/// How long a heard-of windfall stays actionable (ticks).
const FORTUNE_EXPIRY: u32 = 1800;
/// How long a mourning disposition lingers.
const GRIEVE_EXPIRY: u32 = 900;
/// The gold a seek-fortune intention drives toward (minor units, ~140 gold).
pub const FORTUNE_TARGET: i64 = 14_000;

/// Intention priorities (quantized 0..1 ×1000), mirroring the TS `g.priority` values.
const PRI_AVENGE: u16 = 900;
const PRI_SEEK_FORTUNE: u16 = 600;
const PRI_GRIEVE: u16 = 550;
const PRI_STEAL: u16 = 650;

// ── the urchin steal gate (the heist is rare + emergent: CIRCUMSTANCE × CHARACTER) ──
/// Below this purse (minor units) an agent is poor enough to consider crime.
const STEAL_POOR: i64 = 3_000;
/// A bold soul (risk_tolerance above) and an uncaring one (altruism below) — the character gate.
const STEAL_BOLD: f32 = 0.62;
const STEAL_UNCARING: f32 = 0.4;
/// Only a believed-rich enough mark is worth it, within this range of where I believe it is.
const STEAL_MARK_WEALTH: u16 = 30_000;
const STEAL_MARK_RANGE: f32 = 60.0;
/// The heist's gold target (rob lifts ~2000; reaching this pops the intention).
const STEAL_HEIST: i64 = 1_500;
/// How long a heist intention stays live before the urge cools.
const STEAL_EXPIRY: u32 = 600;

const PRI_REPAY: u16 = 700;
/// Repay only when holding more than this many Food units to spare for the benefactor.
const REPAY_FOOD_KEEP: i32 = 1;
/// How long a debt of gratitude stays live before it fades.
const REPAY_EXPIRY: u32 = 600;

const PRI_DONATE: u16 = 520;
/// The alms gate: a WEALTHY (gold above) + GENEROUS (altruism above) soul with a FOOD surplus.
const DONATE_RICH: i64 = 8_000;
const DONATE_GENEROUS: f32 = 0.65;
const DONATE_FOOD_KEEP: i32 = 1; // give only when holding more than this many Food units
/// A believed-poor neighbour (wealth cue below) within range is a worthy recipient.
const DONATE_POOR_CUE: u16 = 8_000;
const DONATE_RANGE: f32 = 22.0;
const DONATE_EXPIRY: u32 = 300;

const PRI_DEFEND: u16 = 850;
/// Only a brave-enough soul defends a friend (aggression above).
const DEFEND_BRAVE: f32 = 0.5;
/// A belief reads as a FRIEND above this standing (i16 quantization of +1..−1).
const DEFEND_FRIEND_STANDING: i16 = 4_000;
/// A hostile this close to a believed friend is threatening it.
const DEFEND_NEAR: f32 = 16.0;
/// How long a defend intention stays live before re-evaluating.
const DEFEND_EXPIRY: u32 = 90;

/// AVENGE — an `assaulted` memory whose culprit I have NOT slain ⇒ a standing grudge (the flagship
/// vendetta). Locatability is checked at plan time (an un-locatable culprit yields no plan ⇒ pruned).
pub fn avenge(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    let m = ctx.memory;
    for k in 0..m.len as usize {
        let ep = m.items[k];
        if ep.kind == EpisodeKind::Assaulted as u8
            && ep.with != NONE_ID
            && !m.has(EpisodeKind::Slew, ep.with)
        {
            gstack.push(Intention {
                kind: IntentionKind::Avenge as u8,
                flags: 0,
                priority: PRI_AVENGE,
                subject: ep.with,
                place: 0,
                _pad: [0; 3],
                amt: 0,
                born: ep.t,
                expire: ep.t + AVENGE_EXPIRY,
            });
        }
    }
}

/// SEEK-FORTUNE — a `windfall` memory ⇒ raise gold to a target (sell surplus at the believed market).
pub fn seek_fortune(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    let m = ctx.memory;
    for k in 0..m.len as usize {
        let ep = m.items[k];
        if ep.kind == EpisodeKind::Windfall as u8 {
            gstack.push(Intention {
                kind: IntentionKind::SeekFortune as u8,
                flags: 0,
                priority: PRI_SEEK_FORTUNE,
                subject: NONE_ID,
                place: ep.place,
                _pad: [0; 3],
                amt: FORTUNE_TARGET,
                born: ep.t,
                expire: ep.t + FORTUNE_EXPIRY,
            });
        }
    }
}

/// STEAL — the urchin heist (`js/sim/features/urchin.ts`'s steal deriver), gated on CIRCUMSTANCE ×
/// CHARACTER so crime is rare + emergent: a POOR agent who is BOLD and UNCARING, with a believed-rich
/// mark nearby, resolves to rob it. Belief-only (the mark + its wealth are believed) ⇒ wrong exactly
/// when the cues mislead.
pub fn steal(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    if ctx.faction != Faction::Townsfolk as u8 || ctx.gold >= STEAL_POOR {
        return; // only a poor townsperson turns to crime
    }
    if ctx.personality.risk_tolerance < STEAL_BOLD || ctx.personality.altruism > STEAL_UNCARING {
        return; // character gate: bold AND uncaring
    }
    // pick the believed-richest mark within range (deterministic: wealth, then lowest id).
    let bt = ctx.beliefs;
    let r2 = STEAL_MARK_RANGE * STEAL_MARK_RANGE;
    let mut best: Option<(u16, u32)> = None;
    for k in 0..bt.len as usize {
        let b = &bt.bodies[k];
        if b.wealth < STEAL_MARK_WEALTH {
            continue;
        }
        let dx = ctx.pos[0] - b.last_x;
        let dz = ctx.pos[1] - b.last_z;
        if dx * dx + dz * dz > r2 {
            continue;
        }
        let cand = (b.wealth, b.subject);
        match best {
            Some((bw, bid)) if cand.0 < bw || (cand.0 == bw && cand.1 >= bid) => {}
            _ => best = Some(cand),
        }
    }
    if let Some((_, mark)) = best {
        // already settled this mark? (a Robbed marker) — don't re-arm.
        if ctx.memory.has(EpisodeKind::Robbed, mark) {
            return;
        }
        gstack.push(Intention {
            kind: IntentionKind::Steal as u8,
            flags: 0,
            priority: PRI_STEAL,
            subject: mark,
            place: 0,
            _pad: [0; 3],
            amt: ctx.gold + STEAL_HEIST,
            born: ctx.now,
            expire: ctx.now + STEAL_EXPIRY,
        });
    }
}

/// REPAY — the obligation ledger's discharge (`js/sim/features/ledger.ts`): a `Succoured` memory (I
/// was helped while desperate) ⇒ repay the benefactor in kind once I can spare it. Closes the
/// alms→succoured→repay reciprocity loop. Belief-gated: I must still be able to locate the benefactor.
pub fn repay(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    if ctx.faction != Faction::Townsfolk as u8 || ctx.inventory[0] <= REPAY_FOOD_KEEP {
        return; // nothing to give back yet
    }
    for k in 0..ctx.memory.len as usize {
        let ep = ctx.memory.items[k];
        if ep.kind != EpisodeKind::Succoured as u8 || ep.with == NONE_ID {
            continue;
        }
        let benefactor = ep.with;
        if ctx.memory.has(EpisodeKind::Gave, benefactor) || ctx.beliefs.find(benefactor).is_none() {
            continue; // already repaid, or I've lost track of them
        }
        gstack.push(Intention {
            kind: IntentionKind::Repay as u8,
            flags: 0,
            priority: PRI_REPAY,
            subject: benefactor,
            place: 0,
            _pad: [0; 3],
            amt: 0,
            born: ep.t,
            expire: ep.t + REPAY_EXPIRY,
        });
        break; // discharge one debt at a time
    }
}

/// DONATE — alms (`js/sim/features/alms.ts`): a WEALTHY + GENEROUS soul with a food surplus gives to
/// the believed-poorest neighbour in reach. Belief-only (the recipient's poverty is a perceived cue).
/// Records `Succoured` on the recipient → the seed of a later repay (the reciprocity chain).
pub fn donate(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    if ctx.faction != Faction::Townsfolk as u8
        || ctx.gold < DONATE_RICH
        || ctx.personality.altruism < DONATE_GENEROUS
        || ctx.inventory[0] <= DONATE_FOOD_KEEP
    {
        return; // not a wealthy generous soul with food to spare
    }
    let bt = ctx.beliefs;
    let r2 = DONATE_RANGE * DONATE_RANGE;
    // the believed-POOREST neighbour in range (deterministic: lowest wealth, then lowest id), not
    // already given to.
    let mut best: Option<(u16, u32)> = None;
    for k in 0..bt.len as usize {
        let b = &bt.bodies[k];
        if b.wealth >= DONATE_POOR_CUE {
            continue;
        }
        let dx = ctx.pos[0] - b.last_x;
        let dz = ctx.pos[1] - b.last_z;
        if dx * dx + dz * dz > r2 {
            continue;
        }
        if ctx.memory.has(EpisodeKind::Gave, b.subject) {
            continue;
        }
        match best {
            Some((bw, bid)) if b.wealth > bw || (b.wealth == bw && b.subject >= bid) => {}
            _ => best = Some((b.wealth, b.subject)),
        }
    }
    if let Some((_, poor)) = best {
        gstack.push(Intention {
            kind: IntentionKind::Donate as u8,
            flags: 0,
            priority: PRI_DONATE,
            subject: poor,
            place: 0,
            _pad: [0; 3],
            amt: 0,
            born: ctx.now,
            expire: ctx.now + DONATE_EXPIRY,
        });
    }
}

/// DEFEND — the `hostileNearFriend` behavior (`js/sim/schemas/catalogue.ts` raise-the-alarm, the
/// aggressive read): a BRAVE townsperson who believes a hostile is menacing a believed FRIEND resolves
/// to put the threat down (a Fight, overriding the flee reflex). Belief×belief only — the friend and
/// the threat are both believed. The pro-social counterweight to feud/steal aggression.
pub fn defend(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    if ctx.faction != Faction::Townsfolk as u8 || ctx.personality.aggression < DEFEND_BRAVE {
        return;
    }
    let bt = ctx.beliefs;
    let near2 = DEFEND_NEAR * DEFEND_NEAR;
    // the nearest believed-hostile that sits near a believed-friend (deterministic: lowest id).
    let mut target: Option<u32> = None;
    for h in 0..bt.len as usize {
        let hb = &bt.bodies[h];
        if hb.flags & 0x01 == 0 {
            continue; // not believed hostile
        }
        let mut menacing = false;
        for f in 0..bt.len as usize {
            if f == h {
                continue;
            }
            let fb = &bt.bodies[f];
            if fb.standing <= DEFEND_FRIEND_STANDING {
                continue; // not a believed friend
            }
            let dx = hb.last_x - fb.last_x;
            let dz = hb.last_z - fb.last_z;
            if dx * dx + dz * dz <= near2 {
                menacing = true;
                break;
            }
        }
        if menacing {
            target = Some(match target {
                Some(t) => t.min(hb.subject),
                None => hb.subject,
            });
        }
    }
    if let Some(foe) = target {
        gstack.push(Intention {
            kind: IntentionKind::Defend as u8,
            flags: 0,
            priority: PRI_DEFEND,
            subject: foe,
            place: 0,
            _pad: [0; 3],
            amt: 0,
            born: ctx.now,
            expire: ctx.now + DEFEND_EXPIRY,
        });
    }
}

/// GRIEVE — a `witnessed_death` memory ⇒ a plan-less mourning disposition (biases, decays — no plan).
pub fn grieve(gstack: &mut GoalStack, ctx: &DeriveCtx) {
    let m = ctx.memory;
    for k in 0..m.len as usize {
        let ep = m.items[k];
        if ep.kind == EpisodeKind::WitnessedDeath as u8 && ep.with != NONE_ID {
            gstack.push(Intention {
                kind: IntentionKind::Grieve as u8,
                flags: 0,
                priority: PRI_GRIEVE,
                subject: ep.with,
                place: 0,
                _pad: [0; 3],
                amt: 0,
                born: ep.t,
                expire: ep.t + GRIEVE_EXPIRY,
            });
        }
    }
}
