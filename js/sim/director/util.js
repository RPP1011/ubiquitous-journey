// Shared module-level helpers for the Director's behaviour modules. Extracted
// verbatim from director.js so every split module draws from one source.
export const rand = (a, b) => a + Math.random() * (b - a);
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
