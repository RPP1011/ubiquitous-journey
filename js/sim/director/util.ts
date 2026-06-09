// Shared module-level helpers for the Director's behaviour modules. Extracted
// verbatim from director.js so every split module draws from one source.
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
