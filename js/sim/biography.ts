// BIOGRAPHY — compose any agent's emergent STORY into a few readable lines, so the
// player (a witness) can pick out a single soul among the named heroes, villains,
// Rincewinds, and Houses and read who they became. Pure + read-only: it just reads
// the state the drama systems have written (house, epithet, kin, faith, deeds, the
// memory of bonds), so it's headless-verifiable and never mutates a thing.

// `sim` (the owning Simulation — wave-2, still .js) and `a` (an Agent, read via its
// long-tail drama/life fields) are typed opaquely on purpose; this module is pure +
// read-only and fully guarded, so behaviour is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sim = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ag = any;

const NAMES_OF = (sim: Sim, id: unknown): string | null => {
  try { const o = sim && sim.agentsById && sim.agentsById.get(id); return o ? (o.given || o.name) : null; } catch { return null; }
};

// returns an array of short lines (newest-first identity → deeds → bonds).
export function agentBiography(a: Ag, sim: Sim): string[] {
  const lines: string[] = [];
  if (!a) return lines;
  try {
    // --- calling: class · House · level (the name itself already carries any epithet)
    const prog = a.progression;
    const cls = prog && prog.primaryClass && prog.primaryClass();
    const lvl = prog ? (prog.totalLevel || 0) : 0;
    const calling: string[] = [];
    if (cls) calling.push(cls.name);
    if (a.house) calling.push(`of House ${a.house}`);
    if (lvl) calling.push(`level ${lvl}`);
    if (calling.length) lines.push(calling.join(' '));

    // --- standing in the world (a role beyond their trade)
    const role: string[] = [];
    if (a.warlord) role.push('a warlord at the gates');
    else if (a.nemesis) role.push('a dread of the wilds');
    else if (a.watch && sim && sim.watch && sim.watch.captain === a) role.push('Captain of the Watch');
    else if (a.watch) role.push('a watchman of the town');
    if (a.spy && a.disguiseFaction) role.push('(unbeknownst to all, a spy)');
    // the FORSWORN mark (oath economics): broken vows are part of who one became.
    const forsworn = (a.life && a.life.forsworn) || 0;
    if (forsworn === 1) role.push('once forsworn');
    else if (forsworn > 1) role.push(`${forsworn === 2 ? 'twice' : forsworn === 3 ? 'thrice' : forsworn + ' times'} forsworn`);
    if (role.length) lines.push(role.join(', '));
    if (a.faith) lines.push(`keeps the faith of ${a.faith}`);

    // EVENT-BORN SKILLS — the abilities that answer "where did you learn that?" (doc 15):
    // a spec carrying `origin` is a story artifact; the codex line is a biography line.
    try {
      const carried: string[] = [];
      const ab = (a as { abilities?: Map<string, { name?: string; origin?: { text?: string } | null }> }).abilities;
      if (ab && ab.forEach) ab.forEach((sp) => {
        if (sp && sp.origin && carried.length < 2) carried.push(`${sp.name} (${sp.origin.text || 'earned in the living'})`);
      });
      if (carried.length) lines.push(`carries ${carried.join('; ')}`);
    } catch { /* best-effort flavour */ }

    // --- family: spouse + kin
    const fam: string[] = [];
    if (a.mateId != null) { const m = NAMES_OF(sim, a.mateId); if (m) fam.push(`wed to ${m}`); }
    const kin = Array.isArray(a.kinIds) ? a.kinIds.filter((id: any) => sim && sim.agentsById && sim.agentsById.get(id)).length : 0;
    if (kin) fam.push(`${kin} of kin`);
    if (fam.length) lines.push(fam.join(', '));

    // --- deeds: the tally that earned (or didn't) a name
    const life = a.life || {};
    const deeds: string[] = [];
    if (life.foeKills) deeds.push(`felled ${life.foeKills} foe${life.foeKills > 1 ? 's' : ''}`);
    else if (life.monsterKills) deeds.push(`slew ${life.monsterKills} of the wilds`);
    if (life.escapes) deeds.push(`cheated death ${life.escapes} time${life.escapes > 1 ? 's' : ''}`);
    if (deeds.length) lines.push('has ' + deeds.join(' and '));

    // --- bonds (live + remembered): a rival, an old peace, a master
    const bonds: string[] = [];
    if (a.rivalId != null) { const r = NAMES_OF(sim, a.rivalId); if (r) bonds.push(`rival to ${r}`); }
    const seen = new Set<string>();
    const mem = a.memory;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eps: any[] = mem ? ([] as any[]).concat(mem.ltm ? mem.ltm.items() : [], mem.mtm ? mem.mtm.items() : []) : [];
    for (const e of eps) {
      if (!e || e.kind !== 'bond' || !e.rel || seen.has(e.rel + ':' + e.withId)) continue;
      if (e.rel === 'rival') continue;   // a live rivalry is already shown above
      const who = NAMES_OF(sim, e.withId);
      if (!who) continue;
      seen.add(e.rel + ':' + e.withId);
      if (e.rel === 'reconciled') bonds.push(`reconciled with ${who}`);
      else if (e.rel === 'mentor') bonds.push(`apprenticed under ${who}`);
      else if (e.rel === 'apprentice') bonds.push(`master to ${who}`);
      if (bonds.length >= 3) break;
    }
    if (bonds.length) lines.push(bonds.join(', '));
  } catch { /* a biography must never throw */ }
  return lines;
}

// The agent's current "why" — the throughline a storyteller leads with. Reads the
// narrative goal stack first (the truest, freshest motive: a vendetta, a grief, a
// debt), then falls back to the slow ambition. Returns a short past/present-tense
// clause or null. Pure + guarded (never throws — feeds the headless brief builder).
const DRIVE: Record<string, (n: string | null) => string> = {
  avenge:       (n: string | null) => (n ? `bent on avenging a wrong upon ${n}` : 'nursing a thirst for vengeance'),
  grieve:       (n: string | null) => (n ? `grieving the loss of ${n}` : 'weighed down by a fresh grief'),
  seek_fortune: ()  => 'scraping together a fortune to their name',
  repay:        (n: string | null) => (n ? `honour-bound to repay a debt to ${n}` : 'set on repaying an old kindness'),
  delve:        ()  => 'drawn to the deep ruins and the relics buried there',
};
export function agentDrive(a: Ag, sim: Sim): string | null {
  try {
    const goals = Array.isArray(a.goals) ? a.goals : [];
    for (let i = goals.length - 1; i >= 0; i--) {          // top of stack = most pressing
      const g = goals[i];
      const f = g && DRIVE[g.kind];
      if (f) return f(g.subjectId != null ? NAMES_OF(sim, g.subjectId) : null);
    }
    if (a.ambition && a.ambition.label) return `driven to ${a.ambition.label}`;
  } catch { /* never throw */ }
  return null;
}
