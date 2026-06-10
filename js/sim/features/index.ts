// FEATURE INDEX (docs/architecture/10 + 10-lld §13 execution): importing this module loads every
// action-grammar feature. Each feature module REGISTERS its executor / deriver / effect-holds rows
// as an import SIDE-EFFECT (verbs-are-data), so simply importing this index once (from
// simulation.ts) wires them all at startup. Each feature is ALWAYS-LIVE on the mainline (gating is by
// branch, no per-feature flag). Disjoint by construction: a feature is ONE file here + ONE test
// suite, touching no shared code.
import './urchin.js';
import './learning.js';
import './recruiter.js';
import './affect.js';
import './ledger.js';
import './caution.js';

export {};
