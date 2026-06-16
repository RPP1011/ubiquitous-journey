//! The town GAZETTE (port of `js/sim/gazette.ts` — the brief/edition core; the LLM-enrichment path in
//! `ai/press`+`ai/llm` is browser-only and OUT of headless scope, doc 22 §10). A periodic OBSERVER
//! publication: each edition snapshots the recent chronicle into BRIEFS (the news) + a market PRICE
//! board (the median believed price of each good). It is the doc-05 "information as a resource" layer —
//! the `newsread` feature then folds the published prices into agents' own price beliefs, so a market
//! shock ripples out through the news rather than only through direct perception.
//!
//! Single-town by design here (the 1-town core). The `arbitrage`/`caravan` consumers that exploit
//! price GAPS BETWEEN towns are the genuinely multi-town piece, deferred with that substrate.
//!
//! DETERMINISM: published serially in the society phase (a fixed id-order scan + integer median), and
//! read by `newsread` as a frozen read-only snapshot ⇒ M-invariant. No float-reduce on the price path.

use crate::components::{Beat, N_COMMODITIES};

/// Max briefs carried in an edition (bounded — the freeze rule; oldest chronicle beats drop off).
pub const BRIEF_CAP: usize = 16;

/// The town newspaper. `prices[g]` is the published median believed price of good `g` (major units).
#[derive(Clone)]
pub struct Gazette {
    pub edition: u32,
    pub n_briefs: u8,
    pub briefs: [Beat; BRIEF_CAP],
    pub prices: [u16; N_COMMODITIES],
}

impl Default for Gazette {
    fn default() -> Self {
        Gazette {
            edition: 0,
            n_briefs: 0,
            briefs: [Beat::default(); BRIEF_CAP],
            prices: [0; N_COMMODITIES],
        }
    }
}

impl Gazette {
    /// Publish a fresh edition: the latest `BRIEF_CAP` chronicle beats become this edition's briefs, and
    /// `prices` is set to the supplied per-good price board. Pure (no world mutation); deterministic.
    pub fn publish(&mut self, chronicle: &[Beat], prices: [u16; N_COMMODITIES]) {
        self.edition = self.edition.wrapping_add(1);
        let take = chronicle.len().min(BRIEF_CAP);
        let start = chronicle.len() - take;
        for (i, b) in chronicle[start..].iter().enumerate() {
            self.briefs[i] = *b;
        }
        self.n_briefs = take as u8;
        self.prices = prices;
    }

    /// The published briefs actually present this edition.
    #[inline]
    pub fn briefs(&self) -> &[Beat] {
        &self.briefs[..self.n_briefs as usize]
    }

    /// PROSE rendering (the template-article path, ported as a deterministic in-core generator — the LLM
    /// enrichment stays browser-only). Turn one numeric `Beat` into a readable headline using procedural
    /// NAMES for the subject. Pure + deterministic (a string from hashed state; not itself hashed). The
    /// render layer prints these; nothing in the sim reads them, so they never affect a decision.
    pub fn headline(&self, b: &Beat) -> String {
        let who = crate::names::full_name(b.subject, 0);
        match b.kind {
            1 => format!("Death in the town: {who} has fallen."),
            2 => format!("A new calling: {who} rises to a higher station."),
            4 => format!("Obituary: the town remembers {who}, a notable soul."),
            5 => format!("Market wire: trade volume stands at {} this cycle.", b.magnitude),
            30 => format!("Unmasked! {who} is revealed a spy in our midst."),
            _ => format!("Word from the square concerning {who}."),
        }
    }

    /// The full edition as prose: a dateline + a headline per brief. The town newspaper, rendered.
    pub fn article(&self) -> String {
        let mut out = format!("THE TOWN GAZETTE — Edition {}\n", self.edition);
        for b in self.briefs() {
            out.push_str(&self.headline(b));
            out.push('\n');
        }
        out
    }
}

/// The MEDIAN of a small price slice (the gazette's price board — robust to a few outliers, unlike a
/// mean, and integer/order-independent ⇒ deterministic). Returns 0 for an empty slice.
pub fn median_u16(vals: &mut [u16]) -> u16 {
    if vals.is_empty() {
        return 0;
    }
    vals.sort_unstable();
    vals[vals.len() / 2]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prose_renders_briefs_with_names() {
        let mut g = Gazette::default();
        let beats = [
            Beat { t: 1, kind: 1, subject: 7, magnitude: 0 },    // a death
            Beat { t: 2, kind: 4, subject: 12, magnitude: 305 }, // an obituary
        ];
        g.publish(&beats, [10; N_COMMODITIES]);
        let article = g.article();
        assert!(article.contains("THE TOWN GAZETTE"), "the edition has a masthead");
        assert!(article.contains("has fallen"), "a death beat renders to a death headline");
        assert!(article.contains("Obituary"), "an obituary beat renders to an obituary headline");
        // deterministic: the same edition renders the same prose every time.
        assert_eq!(g.article(), g.article());
        // a named subject appears (procedural naming feeds the prose).
        assert!(article.contains(&crate::names::full_name(7, 0)), "the fallen soul is named");
    }

    #[test]
    fn publish_snapshots_recent_briefs_and_prices() {
        let mut chron: Vec<Beat> = Vec::new();
        for t in 0..30u32 {
            chron.push(Beat { t, kind: (t % 4) as u8, subject: t, magnitude: t as i32 });
        }
        let mut gz = Gazette::default();
        let prices = [10, 20, 30, 40, 50, 60];
        gz.publish(&chron, prices);
        assert_eq!(gz.edition, 1, "publishing bumps the edition");
        assert_eq!(gz.briefs().len(), BRIEF_CAP, "an edition carries up to BRIEF_CAP briefs");
        // the briefs are the LATEST beats (the most recent ticks).
        assert_eq!(gz.briefs().last().unwrap().t, 29, "the newest beat is in the edition");
        assert_eq!(gz.briefs()[0].t, 30 - BRIEF_CAP as u32, "the oldest carried brief is the right one");
        assert_eq!(gz.prices, prices, "the price board is published");
    }

    #[test]
    fn median_is_robust() {
        assert_eq!(median_u16(&mut [5, 1, 3]), 3);
        assert_eq!(median_u16(&mut [100, 2, 3, 4]), 4); // an outlier doesn't drag the median
        assert_eq!(median_u16(&mut []), 0);
    }
}
