// Inference-motive registry loader (docs/architecture/17 §7). Importing this file self-registers every
// motive family as an import side-effect (verbs-are-data), so the inference layer (motivation/infer.ts)
// finds the candidate motives per primitive via motivesFor(). One file per family; disjoint.
import './acquire.js';   // the `take` primitive: theft / robbery / justice
import './speech.js';    // the `say` primitive: warn / slander / vouch (docs/architecture/17 §8.1)
import './combat.js';    // the `strike` primitive: defense / aggression / avenge (docs/architecture/17 §8.2)
