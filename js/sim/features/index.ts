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
import './ambition_goals.js';   // Phase B1: persistent-ambition standing goals (replaces aimless wander)
import './alms.js';          // charity decided by character: the altruistic feed the begging destitute
import './migrate.js';       // emigration decided by character: the poor/restless answer a land-is-cheap rumour
import './subsistence.js';   // the goalSate live trigger: hunger posed to the planner (forage/buy by cost)
import './signalsFold.js';   // docs/architecture/13: PLAN_OUTCOME-folded catalog signals (streak/perils)

export {};
