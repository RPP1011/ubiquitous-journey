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
