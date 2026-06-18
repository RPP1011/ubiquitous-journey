//! beliefbench — prototype + benchmark for the "belief as a series of ints" (fact-store) model
//! against the as-built denormalized `PersonBelief`/`BeliefTable` struct.
//!
//! The question this answers: in the Rust port, is a `(subject, attr)` fact lookup cheap enough to
//! justify the more powerful (open-ontology, per-fact confidence/provenance) representation — and
//! cheap enough to consider dropping the flat hot columns the every-tick reads currently hit?
//!
//! It builds the SAME belief data three ways, then times the access patterns the real sim runs:
//!   1. STRUCT   — the as-built `BeliefTable` (find(subject) linear scan → struct field access).
//!   2. FACTFLAT — facts {subject,attr,value,conf,t,src,hops} in a per-agent Vec, sorted by
//!                 (subject,attr); topic read = scan the subject's contiguous attr run.
//!   3. FACTHASH — same facts + a per-agent HashMap<(subject<<8|attr) → idx> for O(1) targeted reads.
//!
//! Run: `cargo run --release --bin beliefbench`
//!
//! This is a PROTOTYPE harness, not wired into the sim. It exists to make the speed/memory tradeoff
//! concrete before committing to a migration of beliefs.rs + components.rs.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::hint::black_box;
use std::mem::size_of;
use std::time::Instant;

// ── FxHash: the rustc-hash integer hasher (no dependency). The std default HashMap uses SipHash,
// which is DoS-resistant but far too slow for tiny u64 keys — never used in a hot path. This is the
// fair comparison for an integer-keyed index.
#[derive(Default)]
struct FxHasher {
    hash: u64,
}
const FX_SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;
impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.hash = (self.hash.rotate_left(5) ^ b as u64).wrapping_mul(FX_SEED);
        }
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.hash = (self.hash.rotate_left(5) ^ i).wrapping_mul(FX_SEED);
    }
    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }
}
type FxBuild = BuildHasherDefault<FxHasher>;

use sim_core::components::{BeliefTable, PersonBelief, BELIEF_CAP};
use sim_core::rng::DeterministicRng;

// ───────────────────────────── the fact-store prototype ─────────────────────────────

// Attribute ids. The attr id IMPLIES the value kind via the table below — so a `Fact` needs no
// per-fact type tag; `value: u32` is read as bool / symbol / fixed-point / entity by attr.
const A_FACTION: u8 = 0; // Symbol  (Faction enum)
const A_HOSTILE: u8 = 1; // Bool
const A_LASTX: u8 = 2; // Quant   (f32 bits)
const A_LASTZ: u8 = 3; // Quant   (f32 bits)
const A_THREAT: u8 = 4; // Quant   (u16)
const A_STANDING: u8 = 5; // Quant   (i16)
// optional / sparse attrs (the long tail the struct pays for whether set or not):
const A_WEALTH: u8 = 6;
const A_NOTORIETY: u8 = 7;
const A_LEVEL: u8 = 8;
const A_HOPS: u8 = 9;
const A_ASSOC: u8 = 10;
const A_LASTTICK: u8 = 11;
const N_ATTR: usize = 12;

const CORE_ATTRS: usize = 6; // 0..6 always present (faction,hostile,x,z,threat,standing)

/// One interned proposition: (subject, attr) → value, with epistemic metadata. All ints. 20 bytes.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Fact {
    subject: u32,
    value: u32, // interpreted by `attr` (see attr table) — symbol id / bool / f32 bits / quant
    t: u32,     // observed_at tick (recency; lazy-decay input)
    conf: u16,  // base confidence, fixed-point 0..65535
    attr: u8,
    src: u8, // provenance source (WITNESSED/TALKED/RUMOR/INFERRED/LEDGER)
    hops: u8,
    _pad: u8,
}

#[inline]
fn key(subject: u32, attr: u8) -> u64 {
    ((subject as u64) << 8) | attr as u64
}

/// FACTFLAT — per-agent fact list, kept sorted by (subject, attr). Topic read scans the subject's
/// contiguous run; targeted read binary-/linear-searches the run.
struct FactFlat {
    facts: Vec<Fact>,
}
impl FactFlat {
    /// First index of the run for `subject` (facts are grouped & sorted by subject), or None.
    #[inline]
    fn topic_start(&self, subject: u32) -> Option<usize> {
        // linear scan — same shape as BeliefTable::find (small, cache-hot)
        self.facts.iter().position(|f| f.subject == subject)
    }
    #[inline]
    fn get(&self, subject: u32, attr: u8) -> Option<u32> {
        if let Some(s) = self.topic_start(subject) {
            for f in &self.facts[s..] {
                if f.subject != subject {
                    break;
                }
                if f.attr == attr {
                    return Some(f.value);
                }
            }
        }
        None
    }
}

/// FACTHASH — FACTFLAT + a packed-key index for O(1) targeted (subject,attr) reads. Carries BOTH a
/// SipHash (std default) and an FxHash index so the bench can show the hasher's effect.
struct FactHash {
    facts: Vec<Fact>,
    index: HashMap<u64, u32>,           // std default (SipHash)
    index_fx: HashMap<u64, u32, FxBuild>, // FxHash (the fair integer-key choice)
}
impl FactHash {
    #[inline]
    fn get(&self, subject: u32, attr: u8) -> Option<u32> {
        self.index.get(&key(subject, attr)).map(|&i| self.facts[i as usize].value)
    }
    #[inline]
    fn get_fx(&self, subject: u32, attr: u8) -> Option<u32> {
        self.index_fx.get(&key(subject, attr)).map(|&i| self.facts[i as usize].value)
    }
}

// ───────────────────────────── data generation (identical content, 3 layouts) ─────────────────────────────

struct Gen {
    structs: Vec<BeliefTable>,
    flat: Vec<FactFlat>,
    hash: Vec<FactHash>,
    subjects: Vec<Vec<u32>>, // the subject ids each agent holds (for targeted-lookup workloads)
    total_facts: usize,
}

fn generate(n_agents: usize, seed: u64) -> Gen {
    let mut structs = Vec::with_capacity(n_agents);
    let mut flat = Vec::with_capacity(n_agents);
    let mut hash = Vec::with_capacity(n_agents);
    let mut subjects_all = Vec::with_capacity(n_agents);
    let mut total_facts = 0usize;

    for a in 0..n_agents {
        let mut rng = DeterministicRng::seed(seed, a as u64);
        // realistic spread of how many topics an agent actually tracks (cap = BELIEF_CAP).
        let n_topics = 4 + (rng.next_u64() as usize % (BELIEF_CAP - 3)); // 4..=BELIEF_CAP
        let mut bt = BeliefTable::default();
        let mut facts: Vec<Fact> = Vec::new();
        let mut subs: Vec<u32> = Vec::with_capacity(n_topics);

        for ti in 0..n_topics {
            // subject id drawn from a plausible roster range, kept unique-ish per agent.
            let subject = (rng.next_u64() % (n_agents as u64 * 2)) as u32;
            subs.push(subject);

            let faction = (rng.next_u64() % 5) as u8;
            let hostile = (rng.next_f32() < 0.2) as u32;
            let lx = rng.next_signed() * 200.0;
            let lz = rng.next_signed() * 200.0;
            let threat = (rng.next_u64() % 1000) as u16;
            let standing = (rng.next_signed() * 30000.0) as i16;
            let conf = (rng.next_f32() * 65535.0) as u16;
            let now = (rng.next_u64() % 100000) as u32;
            let hops = (rng.next_u64() % 3) as u8;

            // STRUCT layout
            bt.subjects[ti] = subject;
            bt.bodies[ti] = PersonBelief {
                subject,
                last_x: lx,
                last_z: lz,
                confidence: conf,
                faction,
                level: (rng.next_u64() % 30) as u8,
                notoriety: (rng.next_u64() % 1000) as u16,
                threat,
                wealth: (rng.next_u64() % 1000) as u16,
                last_tick: now,
                standing,
                flags: hostile as u8,
                hops,
                assoc: (rng.next_u64() % 200) as u16,
            };

            // FACT layout — core attrs always emitted; optional attrs emitted ~50% (sparsity the
            // struct can't exploit). The attr id implies the value kind, so no per-fact type tag.
            let mut emit = |attr: u8, value: u32, facts: &mut Vec<Fact>| {
                facts.push(Fact { subject, value, t: now, conf, attr, src: 0, hops, _pad: 0 });
            };
            emit(A_FACTION, faction as u32, &mut facts);
            emit(A_HOSTILE, hostile, &mut facts);
            emit(A_LASTX, lx.to_bits(), &mut facts);
            emit(A_LASTZ, lz.to_bits(), &mut facts);
            emit(A_THREAT, threat as u32, &mut facts);
            emit(A_STANDING, (standing as i32) as u32, &mut facts);
            for opt in CORE_ATTRS as u8..N_ATTR as u8 {
                if rng.next_f32() < 0.5 {
                    emit(opt, (rng.next_u64() & 0xFFFF) as u32, &mut facts);
                }
            }
        }
        bt.len = n_topics as u8;

        // sort facts by (subject, attr) so topic runs are contiguous (FACTFLAT/FACTHASH invariant)
        facts.sort_unstable_by_key(|f| (f.subject, f.attr));
        total_facts += facts.len();

        // build the hash indexes (std SipHash + FxHash)
        let mut index = HashMap::with_capacity(facts.len());
        let mut index_fx: HashMap<u64, u32, FxBuild> =
            HashMap::with_capacity_and_hasher(facts.len(), FxBuild::default());
        for (i, f) in facts.iter().enumerate() {
            index.insert(key(f.subject, f.attr), i as u32);
            index_fx.insert(key(f.subject, f.attr), i as u32);
        }

        structs.push(bt);
        flat.push(FactFlat { facts: facts.clone() });
        hash.push(FactHash { facts, index, index_fx });
        subjects_all.push(subs);
    }

    Gen { structs, flat, hash, subjects: subjects_all, total_facts }
}

// ───────────────────────────── timing helper ─────────────────────────────

fn bench<F: FnMut() -> u64>(label: &str, iters: u32, ops: u64, mut f: F) -> f64 {
    // warm up
    for _ in 0..3 {
        black_box(f());
    }
    let t0 = Instant::now();
    let mut acc = 0u64;
    for _ in 0..iters {
        acc = acc.wrapping_add(f());
    }
    let el = t0.elapsed().as_secs_f64();
    black_box(acc);
    let total_ops = ops * iters as u64;
    let ns_per_op = el / total_ops as f64 * 1e9;
    println!("    {:<10} {:>8.2} ms total   {:>7.2} ns/op", label, el * 1e3, ns_per_op);
    ns_per_op
}

fn main() {
    let n_agents: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5000);
    let seed = 2024u64;

    println!("beliefbench — fact-store vs as-built BeliefTable");
    println!("  agents = {}, seed = {}\n", n_agents, seed);

    let g = generate(n_agents, seed);
    let topic_ops: u64 = g.structs.iter().map(|b| b.len as u64).sum();

    // ── memory footprint ──
    let struct_bytes = n_agents * size_of::<BeliefTable>();
    let fact_payload = g.total_facts * size_of::<Fact>();
    // hash adds an index entry per fact (~ key u64 + idx u32 + map slop ≈ 1.4x of 12B buckets)
    let hash_overhead = (g.total_facts as f64 * 28.0) as usize;
    println!("memory");
    println!(
        "    STRUCT     {:>9.2} MB   ({} B/agent, fixed — pays for all {} slots)",
        struct_bytes as f64 / 1e6,
        size_of::<BeliefTable>(),
        BELIEF_CAP
    );
    println!(
        "    FACT       {:>9.2} MB   ({} B/fact × {} facts; {:.1} facts/agent)",
        fact_payload as f64 / 1e6,
        size_of::<Fact>(),
        g.total_facts,
        g.total_facts as f64 / n_agents as f64
    );
    println!(
        "    FACTHASH   {:>9.2} MB   (payload + ~{:.2} MB index)\n",
        (fact_payload + hash_overhead) as f64 / 1e6,
        hash_overhead as f64 / 1e6
    );

    // ───── W1: the every-tick hot scan ─────
    // For each agent, for each believed subject, read hostile + faction + last_x/z + threat.
    // This is the steer/decide read surface. Struct iterates bodies[]; fact store filters one pass.
    println!("W1  hot scan — read {{hostile,faction,pos,threat}} for every believed subject");
    bench("STRUCT", 300, topic_ops, || {
        let mut s = 0u64;
        for bt in &g.structs {
            for b in 0..bt.len as usize {
                let c = &bt.bodies[b];
                s = s
                    .wrapping_add((c.flags & 1) as u64)
                    .wrapping_add(c.faction as u64)
                    .wrapping_add(c.last_x.to_bits() as u64)
                    .wrapping_add(c.last_z.to_bits() as u64)
                    .wrapping_add(c.threat as u64);
            }
        }
        s
    });
    bench("FACTFLAT", 300, topic_ops, || {
        let mut s = 0u64;
        for fa in &g.flat {
            // single linear pass, accumulate the wanted attrs (scan-friendly fact layout)
            for f in &fa.facts {
                if f.attr <= A_STANDING && f.attr != A_STANDING {
                    s = s.wrapping_add(f.value as u64);
                }
            }
        }
        s
    });

    // ───── W2: targeted predicate ─────
    // "Does agent A believe subject S hostile?" — 8 random believed subjects per agent.
    println!("\nW2  targeted — `believe(S, hostile)?` (8 random subjects/agent)");
    let probes_per = 8u64;
    bench("STRUCT", 300, n_agents as u64 * probes_per, || {
        let mut s = 0u64;
        for (i, bt) in g.structs.iter().enumerate() {
            let subs = &g.subjects[i];
            for k in 0..probes_per as usize {
                let sub = subs[(k * 7 + 3) % subs.len()];
                if let Some(ix) = bt.find(sub) {
                    s = s.wrapping_add((bt.bodies[ix].flags & 1) as u64);
                }
            }
        }
        s
    });
    bench("FACTFLAT", 300, n_agents as u64 * probes_per, || {
        let mut s = 0u64;
        for (i, fa) in g.flat.iter().enumerate() {
            let subs = &g.subjects[i];
            for k in 0..probes_per as usize {
                let sub = subs[(k * 7 + 3) % subs.len()];
                if let Some(v) = fa.get(sub, A_HOSTILE) {
                    s = s.wrapping_add(v as u64);
                }
            }
        }
        s
    });
    bench("HASH(sip)", 300, n_agents as u64 * probes_per, || {
        let mut s = 0u64;
        for (i, fh) in g.hash.iter().enumerate() {
            let subs = &g.subjects[i];
            for k in 0..probes_per as usize {
                let sub = subs[(k * 7 + 3) % subs.len()];
                if let Some(v) = fh.get(sub, A_HOSTILE) {
                    s = s.wrapping_add(v as u64);
                }
            }
        }
        s
    });
    bench("HASH(fx)", 300, n_agents as u64 * probes_per, || {
        let mut s = 0u64;
        for (i, fh) in g.hash.iter().enumerate() {
            let subs = &g.subjects[i];
            for k in 0..probes_per as usize {
                let sub = subs[(k * 7 + 3) % subs.len()];
                if let Some(v) = fh.get_fx(sub, A_HOSTILE) {
                    s = s.wrapping_add(v as u64);
                }
            }
        }
        s
    });

    // ───── W3: decay ─────
    // Struct decays confidence on every belief cell every tick. Fact store can decay eagerly (more
    // cells) OR lazily (store base_conf+t, compute at read — a no-op here). We show eager cost; lazy
    // would be ~0.
    println!("\nW3  decay — scale confidence (eager). Fact store has more cells but can go LAZY (≈0).");
    bench("STRUCT", 300, topic_ops, || {
        let mut s = 0u64;
        for bt in &g.structs {
            for b in 0..bt.len as usize {
                let c = bt.bodies[b].confidence;
                s = s.wrapping_add((c as u64 * 999) >> 10);
            }
        }
        s
    });
    bench("FACT(eager)", 300, g.total_facts as u64, || {
        let mut s = 0u64;
        for fa in &g.flat {
            for f in &fa.facts {
                s = s.wrapping_add((f.conf as u64 * 999) >> 10);
            }
        }
        s
    });

    // ───── W4: gossip merge ─────
    // Copy a believed subject's record from agent A into agent B with hops+1. Struct: copy one
    // PersonBelief. Fact: copy the subject's contiguous fact run.
    println!("\nW4  gossip — copy one subject's belief A→B, hops+1");
    let mut merges = Vec::with_capacity(n_agents);
    {
        let mut rng = DeterministicRng::seed(seed, 777);
        for i in 0..n_agents {
            let j = (rng.next_u64() as usize) % n_agents;
            let subs = &g.subjects[i];
            let sub = subs[(rng.next_u64() as usize) % subs.len()];
            merges.push((i, j, sub));
        }
    }
    let mut structs2 = g.structs.clone();
    bench("STRUCT", 200, n_agents as u64, || {
        let mut s = 0u64;
        for &(i, _j, sub) in &merges {
            if let Some(ix) = structs2[i].find(sub) {
                let mut nb = structs2[i].bodies[ix];
                nb.hops = nb.hops.saturating_add(1);
                // write into B's slot 0 (prototype — real path dedups)
                structs2[i].bodies[0] = nb;
                s = s.wrapping_add(nb.subject as u64);
            }
        }
        s
    });
    let mut flat2: Vec<Vec<Fact>> = g.flat.iter().map(|f| f.facts.clone()).collect();
    bench("FACTFLAT", 200, n_agents as u64, || {
        let mut s = 0u64;
        let mut scratch: Vec<Fact> = Vec::with_capacity(N_ATTR);
        for &(i, _j, sub) in &merges {
            scratch.clear();
            for f in &flat2[i] {
                if f.subject == sub {
                    let mut nf = *f;
                    nf.hops = nf.hops.saturating_add(1);
                    scratch.push(nf);
                    s = s.wrapping_add(nf.value as u64);
                }
            }
            // (prototype) write-back would merge `scratch` into B; we just touch it
            black_box(&scratch);
        }
        s
    });

    println!("\ndone.");
}
