//! The CORE memory→goal derivers (`deriveGoals`'s built-in rows, ported from `js/sim/motivation.js`).
//! Each scans the agent's OWN salient memory and pushes a standing intention; `GoalStack::push` dedups
//! + refreshes, so re-running every tick is idempotent. Feature derivers live in their own files and
//! append to `registry::DERIVERS`.

use crate::components::{EpisodeKind, GoalStack, Intention, IntentionKind, NONE_ID};
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
