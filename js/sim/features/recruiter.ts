// FEATURE: the recruiter (docs/architecture/10 execution — the capstone, both ends). Registers the
// `recruit` verb (approach a candidate, make an OFFER it perceives), a muster-goal deriver (a
// would-be leader facing a believed-strong camp forms a goalMuster), and the FOLLOWER side: the
// candidate, perceiving an offer, weighs it by its own motivation and forms its OWN join goal (the
// reputation-gated party-join the sim already has, with a risk/reward weighing on top). All from
// THIS file as DATA rows. Gated by RECRUIT.enabled; off → nothing live, soak byte-stable.
//
// TODO(worktree recruiter): implement here, using:
//   import { registerExecutor, registerDeriver, registerEffectHolds } from '../exec/registry.js';
//   import { goalMuster, recordBelieves } from '../planner.js';
//   import { Party } from '../party.js';   // the existing follower/party machinery
//   - recruit(candidate): approach; on reach, make the offer the candidate perceives + recordBelieves
//   - deriver (leader): a leader believing a camp too strong to face alone pushes goalMuster(strength)
//   - deriver/hook (follower): a candidate that perceives a good-enough offer forms its own join goal
//   - effect-holds: recruit → the offer landed (believed-force credit)
//   NO foreign-mind write: recruit makes an OFFER (Inform); the follower decides for itself.
export {};
