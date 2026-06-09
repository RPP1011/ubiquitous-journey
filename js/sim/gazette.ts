// THE GAZETTE — the town newspaper. A sim-owned store of published Articles plus
// the two PURE, headless-safe builders the deterministic Reporter uses:
//   - buildBrief(subject, sim) -> a StoryBrief: a plain bundle of ground-truthy
//     facts about a soul (biography + their own salient memories + the chronicle
//     beats they appeared in + relationships + a dateline town).
//   - templateArticle(brief, sim) -> { headline, body }: a serviceable article
//     from a brief with NO model — the floor the optional LLM (js/ai/press.js)
//     only upgrades. Never throws.
//
// The split honours the freeze lesson: everything here is deterministic data, no
// I/O, no await. The async LLM enrichment lives entirely in the browser press
// pump, which swaps an article's prose in place by id. Epistemic split intact: a
// brief carries what the subject BELIEVES/REMEMBERS — a newspaper prints testimony.

import { GAZETTE, MONSTER, BASE_PRICE } from './simconfig.js';
import { agentBiography, agentDrive } from './biography.js';
import { memoryPhrase } from './memory.js';
import { provenanceLabel } from './beliefs.js';
import type { StoryBrief, Article, EntityId } from '../../types/sim.js';

// The (still-.js) Simulation, and Agent-shaped subjects, are reached into loosely
// here: this layer reads a wide, untyped tail of drama/news/society flags off both
// (e.g. nemesis/warlord/epithet/mateId), so a precise type would be all-optional noise.
type Sim = any;       // js Simulation — justified loose type (untyped news/drama tail)
type Subject = any;   // js Agent — justified loose type (untyped news/drama tail)

const nameOf = (sim: Sim, id: EntityId): string | null => {
  try { const o = sim && sim.agentsById && sim.agentsById.get(id); return o ? (o.given || o.name) : null; } catch { return null; }
};

// the town an agent calls home, as a dateline label.
function townName(sim: Sim, a: Subject): string {
  try {
    if (a && a.townId != null && sim.towns && sim.towns[a.townId]) return sim.towns[a.townId].name || `Town ${a.townId}`;
  } catch { /* */ }
  return 'the town';
}

// Compose a StoryBrief from a subject's read-only state. Pure + guarded.
export function buildBrief(subject: Subject, sim: Sim): StoryBrief {
  const brief: StoryBrief = {
    kind: 'person',
    subjectId: subject.id,
    subjectName: subject.name,
    given: subject.given || subject.name,
    epithet: subject.epithet || null,
    dateline: townName(sim, subject),
    originTown: subject.townId != null ? subject.townId : null,
    bio: [],
    memories: [],
    relations: {},
    beats: [],
    drive: null,        // the "why" — vendetta / grief / debt / ambition (the angle)
    role: null,         // a standing beyond their trade (warlord / nemesis / Watch)
    faith: null,        // the god they keep, if any
    calling: null,      // class name
    level: 0,
    risen: null,        // freshly attained class (a class-rise to lead with)
    ambition: null,     // the long arc they pull toward
    mood: null,         // dominant transient mood, when it's strong enough to colour the piece
    hearsay: null,      // a charged rumour the subject themselves repeats (with its provenance)
    t: sim.time,
  };
  try { brief.bio = agentBiography(subject, sim) || []; } catch { /* */ }
  try { brief.drive = agentDrive(subject, sim); } catch { /* */ }
  try { brief.hearsay = subjectHearsay(subject, sim); } catch { /* */ }

  // calling + standing + faith + recent class-rise + mood — the texture a richer
  // article (template or LLM) frames the deeds with. All read-only + guarded.
  try {
    const prog = subject.progression;
    const cls = prog && prog.primaryClass && prog.primaryClass();
    if (cls) brief.calling = cls.name;
    brief.level = prog ? (prog.totalLevel || 0) : 0;
  } catch { /* */ }
  try {
    if (subject.warlord) brief.role = 'a warlord at the gates';
    else if (subject.nemesis) brief.role = 'a dread of the wilds';
    else if (subject.watch && sim.watch && sim.watch.captain === subject) brief.role = 'Captain of the Watch';
    else if (subject.watch) brief.role = 'a watchman of the town';
    if (subject.faith) brief.faith = subject.faith;
    if (subject.ambition && subject.ambition.label) brief.ambition = subject.ambition.label;
  } catch { /* */ }
  try {
    const eps = subject.memory && subject.memory.salient ? subject.memory.salient(6) : [];
    const m = eps.find((e: any) => e && e.kind === 'milestone' && (sim.time - (e.t || 0)) < 90);
    if (m) brief.risen = m.label || brief.calling || null;
  } catch { /* */ }
  try {
    const mo = subject.mood || {}, nd = subject.needs || {};
    if (mo.anger > 0.5) brief.mood = 'wrathful';
    else if (mo.fear > 0.5) brief.mood = 'shaken and wary';
    else if (nd.hunger != null && nd.hunger < 0.25) brief.mood = 'hungry and hard-pressed';
  } catch { /* */ }

  // the subject's OWN salient episodes, rendered as past-tense "interview answers"
  try {
    const eps = subject.memory && subject.memory.salient ? subject.memory.salient((GAZETTE.briefMemories || 4) * 3) : [];
    const phrases = [...new Set(eps.map((e: any) => memoryPhrase(e, (id) => nameOf(sim, id) || '')).filter(Boolean))] as string[];
    // COLLAPSE the raider/monster grind: "bested Raider 347, bested Raider 339, …"
    // reads like a roster dump — summarise it as one count and keep the DISTINCT,
    // human stories (a windfall, a reconciliation, a named foe) up front.
    const grind = /(?:bested|killed|survived).*(?:Raider|\b)?\b(Raider \d+|of the wilds)/i;
    const isGrind = (p: string) => /Raider \d+/.test(p) || /of the wilds/.test(p);
    let grindN = 0; const kept: string[] = [];
    for (const p of phrases) { if (isGrind(p)) grindN++; else kept.push(p); }
    if (grindN >= 2) kept.push(`felled ${grindN} raiders of the wilds of late`);
    else if (grindN === 1) kept.push('bested a raider on the frontier');
    // tidy for prose: drop class brackets ([Smith] -> Smith) and fold a run of
    // "joined with X" bonds into a single clause so the line doesn't stutter.
    const bonds: string[] = [], folded: string[] = [];
    for (const p of kept.map((s) => s.replace(/[[\]]/g, ''))) {
      const m = /^joined with (.+)$/.exec(p);
      if (m) bonds.push(m[1]); else folded.push(p);
    }
    if (bonds.length) folded.unshift(`fell in with ${joinAnd(bonds.length > 3 ? bonds.slice(0, 3).concat('others') : bonds)}`);
    brief.memories = folded.slice(0, GAZETTE.briefMemories || 4);
  } catch { /* */ }

  // relationships (resolved to names)
  try {
    const relations = (brief.relations ||= {}) as Record<string, unknown>;
    if (subject.mateId != null) relations.spouse = nameOf(sim, subject.mateId);
    if (subject.rivalId != null) relations.rival = nameOf(sim, subject.rivalId);
    const kin = Array.isArray(subject.kinIds) ? subject.kinIds.filter((id: EntityId) => sim.agentsById.get(id)).length : 0;
    if (kin) relations.kin = kin;
  } catch { /* */ }

  // chronicle beats that name this subject (v1: name-match, beats are name-phrased).
  try {
    const want = (subject.given || subject.name || '').trim();
    if (want && sim.chronicle) {
      const beats = (brief.beats ||= []) as unknown[];
      const pool: any[] = ([] as any[]).concat(
        sim.chronicle.recent ? sim.chronicle.recent(40) : [],
        sim.chronicle.legends ? sim.chronicle.legends(20) : []);
      const seen = new Set<unknown>();
      for (let i = pool.length - 1; i >= 0 && beats.length < (GAZETTE.briefBeats || 3); i--) {
        const b = pool[i];
        if (!b || !b.text || seen.has(b.id) || b.text.indexOf(want) < 0) continue;
        seen.add(b.id); beats.push(b.text.replace(/[[\]]/g, ''));
      }
    }
  } catch { /* */ }

  return brief;
}

// Is this soul worth an obituary? Named foes/heroes (epithet/nemesis/warlord) always
// are; otherwise only townsfolk of some standing (a rank, a family, the Watch) — not
// the faceless mobs that die by the dozen in a raid. Pure + guarded.
export function obituaryWorthy(a: Subject): boolean {
  try {
    if (!a || a.controlled) return false;
    if (a.epithet || a.nemesis || a.warlord) return true;
    if (a.faction !== 'townsfolk') return false;
    const lvl = (a.progression && a.progression.totalLevel) || 0;
    const kin = Array.isArray(a.kinIds) ? a.kinIds.length : 0;
    return lvl >= 5 || kin >= 1 || !!a.watch || a.mateId != null;
  } catch { return false; }
}

// Compose the brief for an "In Memoriam" piece from a soul at the moment of death:
// their life (the usual brief), HOW they fell, and — the on-theme sting — how the
// TOWN regarded them (the average standing among all who knew them), including
// whether RUMOUR helped bring them down (a name blackened by hearsay). The paper
// eulogises the person the town BELIEVED in, which may not be who they were. Pure.
export function buildObituary(subject: Subject, sim: Sim, slayer: Subject): StoryBrief {
  const brief = buildBrief(subject, sim);
  brief.kind = 'obituary';
  brief.hearsay = null;                                  // an obituary is about THEM, not their gossip
  let cause = 'has died';
  try {
    if (slayer && slayer !== subject) {
      if (slayer.controlled) cause = "fell to the traveller's blade";
      else if (slayer.faction === MONSTER.faction || slayer.nemesis) cause = `was cut down by ${slayer.name}`;
      else cause = `was slain by ${slayer.name}`;
    }
  } catch { /* */ }
  brief.cause = cause;
  try {
    let sum = 0, n = 0, rumorFoes = 0;
    for (const a of sim.agents) {
      if (a === subject || !a.beliefs) continue;
      const b = a.beliefs.get(subject.id);
      if (!b) continue;
      sum += b.standing; n++;
      if (b.hostile && b.rumorBorn) rumorFoes++;
    }
    brief.regard = n ? sum / n : 0;
    brief.hounded = rumorFoes >= 2;                      // the town turned on them largely on talk
  } catch { /* */ }
  const life = subject.life || {};
  brief.villain = !!(subject.epithet && (subject.nemesis || (life.townKills || 0) >= 1));
  brief.hero = !!(subject.epithet && !subject.nemesis && (life.foeKills || 0) >= 3);
  return brief;
}

// The juiciest rumour the SUBJECT themselves repeats about a third party, hedged by
// how garbled it is — this is the telephone game made visible in print: the paper
// reports a soul's testimony ("X will tell you, thirdhand, that Y is a scoundrel"),
// which the reader can weigh against the truth (the inspector). Prefers charged +
// well-travelled hearsay (the kind most likely to be wrong). Pure + guarded.
interface Hearsay { text: string; garbled: boolean; who: string; claim: string; }

function subjectHearsay(subject: Subject, sim: Sim): Hearsay | null {
  try {
    if (!subject.beliefs || !subject.beliefs.all) return null;
    let best = null, bestScore = 0;
    for (const b of subject.beliefs.all()) {
      if (!b || b.subjectId === subject.id) continue;
      const charge = (b.hostile ? 1 : 0) + Math.max(0, -b.standing) * 1.2 + (b.suspicion || 0) * 0.6 + Math.max(0, b.standing) * 0.5;
      if (charge < 0.4) continue;
      const score = charge + Math.min(1, (b.hops || 0) * 0.25);   // well-travelled rumours are juicier
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (!best) return null;
    const who = nameOf(sim, best.subjectId);
    if (!who || /\d/.test(who)) return null;   // skip generic mob names ("Bandit 6") — print real folk
    let claim: string;
    if (best.hostile) claim = best.rumorBorn ? `${who} is an enemy — though ${who} has done nothing to earn it` : `${who} is an enemy, best given a wide berth`;
    else if (best.standing <= -0.6) claim = `${who} is a scoundrel through and through`;
    else if (best.standing <= -0.3) claim = `${who} is not to be trusted`;
    else if ((best.suspicion || 0) >= 0.4) claim = `${who} is hiding something`;
    else return null;                          // the telephone game prints the DAMAGING tales
    return { text: `will tell you — ${provenanceLabel(best)} — that ${claim}`, garbled: (best.hops || 0) >= 2, who, claim };
  } catch { return null; }
}

/** The rendered prose a template/LLM article body carries. */
interface ArticleProse { headline: string; body: string; }

// The kind-specific brief views the article renderers read (market/threat/saga/…):
// each kind carries a different loose set of fields beyond StoryBrief's declared
// ones, so a single precise type would be a large all-optional union — kept loose.
type BriefView = any;   // a kind-specific StoryBrief view (justified loose type)

// Render a brief into a plain article with no model. Pure, never throws. The paper
// SELLS intel, so each kind leads with what's USEFUL to a reader.
export function templateArticle(brief: StoryBrief, _sim?: Sim): ArticleProse {
  try {
    switch (brief && brief.kind) {
      case 'market':      return marketArticle(brief);
      case 'threat':      return threatArticle(brief);
      case 'opportunity': return opportunityArticle(brief);
      case 'event':       return eventArticle(brief);
      case 'saga':        return sagaArticle(brief);
      case 'obituary':    return obituaryArticle(brief);
      default:            return personArticle(brief);
    }
  } catch {
    return { headline: 'A Tale from the Town', body: (brief && brief.subjectName) ? `${brief.subjectName} has a story still being written.` : 'A story still being written.' };
  }
}

// MARKET — the most sellable intel: where buyers go wanting, where goods pile up.
function marketArticle(b: BriefView): ArticleProse {
  const gap = Math.abs((b.demand || 0) - (b.supply || 0));
  if (b.wanted) {
    return {
      headline: cap(`${b.good} runs short in ${b.town} — buyers go wanting`),
      body: `Demand for ${b.good} in ${b.town} outstrips its sellers by some ${gap}, and the price has climbed near ${b.med} coin against the usual ${b.base}. A hauler who carries ${b.good} in now stands to sell it dear.`,
    };
  }
  return {
    headline: cap(`${b.good} piles up in ${b.town} — sellers outnumber buyers`),
    body: `${cap(b.good)} is glutting ${b.town}, its sellers outnumbering buyers by some ${gap}, the price slack near ${b.med} coin against the usual ${b.base}. Anyone holding ${b.good} here would do better carrying it where it's wanted.`,
  };
}

// THREAT — survival intel: who's on the roads, where the Watch should look.
function threatArticle(b: BriefView): ArticleProse {
  const what = b.warlord ? 'a warlord mustering the camps for war' : 'a dread of the wilds';
  return {
    headline: cap(`Beware the roads near ${b.town}: ${b.foe} abroad`),
    body: `${b.foe}, ${what}, has been marked near ${b.town}. Travellers and caravans are warned to go armed or not at all; the Watch is roused, and a bounty would not go amiss for any hand willing to put ${b.foe} down.`,
  };
}

// OPPORTUNITY — actionable: who's hiring, what bounty is posted, where the coin is.
function opportunityArticle(b: BriefView): ArticleProse {
  return {
    headline: cap(b.title || 'A notice from the townsfolk'),
    body: `${b.desc || 'Help is wanted in the town.'} Any willing hand should enquire in person — coin and goodwill await those who answer.`,
  };
}

// EVENT — front-page saga news: the chronicle beat itself is the headline (a
// finished, specific line), with an atmospheric framing as the body. Expedition
// returns ride the chronicle as 'legend' beats, so we sniff them out and give
// them the colour of the road. Frame choice varies by beat time so a run of one
// kind doesn't read with the same tag-line each time.
function eventArticle(b: BriefView): ArticleProse {
  const txt = b.line || '';
  if (/compan(y|ies)|expedition|the deep|the wilds|climb(s|ed) back/i.test(txt)) {
    const frame = /triumph|relic|slain/i.test(txt)
      ? 'The whole town turned out at the gate to greet them, and the taverns did brisk trade that night.'
      : /lost|did not (come|return)|swallowed|none climbed/i.test(txt)
        ? 'The town keeps an empty place at the hearth for those who walked out and did not walk back.'
        : 'Such is the lot of those who go out past the safe roads — glory or the grave, and seldom much between.';
    return { headline: cap(txt || 'From the Wilds'), body: frame };
  }
  const frames: Record<string, string[]> = {
    legend:    ['The tale is on every tongue, from the market to the gate.', 'They will be telling this one by the fire for a long winter yet.'],
    union:     ['A glad day — and, for some Houses, a long-awaited peace.', 'The wine ran freely, and old grudges went politely unspoken for a night.'],
    vendetta:  ['Folk take their sides, and the Watch takes quiet note of both.', 'Blood has been sworn; now the town waits to see whether it is answered.'],
    prodigy:   ['A new power in the town now — for good or for ill.', 'Mark the name, reader; you will hear it spoken again.'],
    raid:      ['Doors were barred and blades drawn before the dust had settled.', 'The Watch earned its bread this day, and the gate-timbers their scars.'],
    faith:     ['The faithful gather louder now, and the doubters keep their counsel.', "Whether the god is listening, none can say — but the town prays as if it might be."],
    watch:     ['The town sleeps the sounder for it.', 'A thankless post, and a needed one — the roads remember who keeps them.'],
    patrician: ['A peace brokered is a peace still, however cold the handshake.', 'Some call it cowardice and some call it wisdom; the dead, at least, stay fewer.'],
  };
  const pool = frames[b.beatKind] || ['Word of it travels the roads between the towns.'];
  const frame = pool[((((b.t || 0) | 0) % pool.length) + pool.length) % pool.length];
  return { headline: cap(txt || 'A Notable Day'), body: frame };
}

// SAGA — a completed arc, threaded into one retrospective. The whole point of the
// feature: the reader sees how it BEGAN, turned, and ended as a single tale.
function sagaArticle(b: BriefView): ArticleProse {
  const s = b.saga || {};
  if (s.sagaKind === 'reckoning') {
    return {
      headline: cap(`A Reckoning: ${s.l} and ${s.a}`),
      body: `It began in betrayal — ${s.l} turned on ${s.a}, ${s.rel}. ${cap(s.a)} swore the wrong would be answered, and so the bad blood between them came at last to a duel, settled with steel. Such is the price of a trust broken.`,
    };
  }
  if (s.sagaKind === 'tyrantFall') {
    if (s.outcome === 'fall') return {
      headline: cap(`The Tyrant Humbled: ${s.tyrant} Brought to Account`),
      body: `${cap(s.tyrant)} grew grasping, gouging the town for ${s.trade}, until the muttering hardened into open resentment. At the last it was ${s.champ} who had enough — rising, blade in hand, to bring the tyrant to account. Let every grasping hand take note.`,
    };
    return {
      headline: cap(`A Tyrant Relents: ${s.tyrant} Makes Amends`),
      body: `${cap(s.tyrant)} grew grasping, gouging the town for ${s.trade}, and the town's anger hardened against them. But faced with that fury, ${s.tyrant} relented — lowering their prices and making amends. A rare thing: a hard heart softened before it had to be broken.`,
    };
  }
  if (s.sagaKind === 'spyWeb') {
    return {
      headline: cap(`A Traitor Unmasked: ${s.spy} Was Not What They Seemed`),
      body: `For a time ${s.spy} passed as one of our own, and only whispers marked them out. The whispers were true: ${s.spy} is exposed as a bandit spy, a traitor planted in the town's very midst — and now hunted. Trust your neighbour, but watch the newcomer.`,
    };
  }
  if (s.sagaKind === 'avenger') {
    if (s.outcome === 'avenged') return {
      headline: cap(`Blood for Blood: ${s.avenger} Runs Down the Traveller`),
      body: `${cap(s.avenger)} never forgot whose hand cut down ${s.victim}. They hunted the traveller without rest, and at the last ran them to ground — the traveller lies dead, and the blood-debt for ${s.victim} is paid in full. So ends one who thought murder carried no cost.`,
    };
    if (s.outcome === 'slain') return {
      headline: cap(`A Vendetta Ends: ${s.avenger} Falls Hunting the Traveller`),
      body: `When the traveller cut down ${s.victim}, ${s.avenger} swore to hunt them to the ends of the realm and make them pay in blood. The chase ended as such chases often do — with ${s.avenger} dead in the dust, the vengeance unpaid. The traveller walks on; let the town remember at whose hand ${s.victim} fell.`,
    };
    return {
      headline: cap(`The Traveller Outruns a Reckoning: ${s.avenger}'s Vendetta Fades`),
      body: `${cap(s.avenger)} swore to avenge ${s.victim} upon the traveller, and hunted them long and hard. But the traveller proved the swifter, and at last the thirst faded unslaked. ${cap(s.avenger)} returns to the town a hollower soul — and the traveller's debt of blood goes uncollected.`,
    };
  }
  if (s.sagaKind === 'grateful') {
    if (s.outcome === 'fellDefending') return {
      headline: cap(`A Debt Paid in Blood: ${s.guardian} Falls for the Traveller`),
      body: `Saved once from ${s.savedFrom} by the traveller's blade, ${s.guardian} swore to watch their back — and made good on it to the very end, falling in the traveller's defence. There are worse ways to be remembered than as one who repaid a kindness with their life.`,
    };
    if (s.outcome === 'repaid') return {
      headline: cap(`A Kindness Returned: ${s.guardian} Stands With the Traveller`),
      body: `Plucked from the jaws of ${s.savedFrom} by the traveller, ${s.guardian} repaid the debt in kind — standing at the traveller's side against their enemies before parting, the account squared. A kindness, it seems, can come back around.`,
    };
    return {
      headline: cap(`A Loyal Shadow: ${s.guardian} Repays the Traveller's Mercy`),
      body: `After the traveller saved them from ${s.savedFrom}, ${s.guardian} shadowed and guarded them a while in gratitude, then took their leave with a token of thanks. The traveller's mercy is not soon forgotten in the town.`,
    };
  }
  if (s.sagaKind === 'romance') {
    if (s.outcome === 'union') return {
      headline: cap(`Love Ends a Feud: ${s.a} and ${s.b} Wed Across the Divide`),
      body: `Houses ${s.hA} and ${s.hB} had hated one another past all memory of why — until ${s.a} and ${s.b} dared to love across that line. Their wedding has done what no parley could: the old feud is laid to rest, and two warring houses are kin at last. They say love is no match for an old grudge. They are wrong.`,
    };
    return {
      headline: cap(`A Love Lost to an Old Feud: ${s.a} and ${s.b} Part`),
      body: `For a brief season ${s.a} of House ${s.hA} and ${s.b} of House ${s.hB} defied the hatred between their families. It was not enough. Bowed by their kin and the weight of the old feud, the two have parted — and the realm is the poorer for one more love the grudge has cost.`,
    };
  }
  if (s.sagaKind === 'protege') {
    if (s.outcome === 'fallen') return {
      headline: cap(`A Promise Unkept: ${s.protege}, the Traveller's Young Follower, Falls`),
      body: `${cap(s.protege)} was a green youth dazzled by the traveller's deeds, who took to following in their shadow to learn the trade of heroes. They will learn no more: ${s.protege} has fallen before their time. The traveller's legend draws the young — and the road of heroes is not a safe one.`,
    };
    return {
      headline: cap(`A Hero Made in a Hero's Shadow: ${s.protege} Comes Into Their Own`),
      body: `Not long ago ${s.protege} was a green youth trailing the famous traveller, hungry to learn. No longer: ${s.protege} has become a warrior of note in their own right, hailed across the realm. So a hero's fame seeds the next — and the town is the braver for it.`,
    };
  }
  if (s.sagaKind === 'accused') {
    if (s.outcome === 'tragedy') return {
      headline: cap(`Hounded to the Grave Over a Lie: ${s.accused} Was Innocent`),
      body: `The whispers said ${s.accused} had blood or theft on their hands. The whispers lied — but not before they cost ${s.accused} their life, cut down with their name still blackened. Only after did the truth come out, too late for the grave. Guard your tongue, reader: a rumour can kill as surely as a blade.`,
    };
    return {
      headline: cap(`Cleared at Last: The Slander Against ${s.accused} Laid Bare`),
      body: `For a season the town was sure of it — ${s.accused} was a thief, a betrayer, a wrong'un. The town was wrong. The rumour has been exposed for the baseless slander it always was, and ${s.accused}'s name is cleared. But ask them whether the wound has healed, and watch their face.`,
    };
  }
  if (s.sagaKind === 'legend') {
    if (s.kind === 'hero') return {
      headline: 'A Hero of the Realm: The Traveller’s Name on Every Tongue',
      body: `Time and again the traveller has put themselves between the town and the things that would prey on it, and the realm has taken notice. They are hailed now as a hero — the sort folk name their children for. Long may the blade stay sharp and the heart stay true.`,
    };
    return {
      headline: 'A Villain of the Realm: The Town Bars Its Doors',
      body: `Blood follows the traveller, and not the blood of monsters. Too many of our own have fallen to that hand, witnessed by too many eyes — and the realm has rendered its verdict: a villain, a butcher, a name spoken with a shudder. The fearful bar their doors at dusk, and the bold sharpen their own steel.`,
    };
  }
  return { headline: 'A Tale of the Town', body: 'The full account is told in the chronicle.' };
}

// PERSON — a soul worth knowing, framed by their ANGLE (the drive behind the
// deeds), not just a flat list of them. Deterministic variety: a stable hash of
// the subject picks among phrasings, so the feed reads written-by-hand rather than
// stamped — yet the same soul always reads the same way (headless-stable). The
// optional LLM (press.js) upgrades this; this is the floor, and it should sing.
function personArticle(brief: BriefView): ArticleProse {
  const name = brief.subjectName || 'A townsperson';
  const given = brief.given || name;
  const town = brief.dateline || 'the town';
  const seed = ((brief.subjectId || 0) * 2654435761) >>> 0;          // stable per-soul hash
  const pick = (arr: string[]): string => arr[seed % arr.length];

  const callingNoun = strip(brief.calling) || ((brief.bio && strip(brief.bio[0])) || 'soul of the town');
  const lead = (brief.memories && brief.memories[0]) || null;
  const drive = brief.drive || null;

  // --- the ANGLE: a themed headline, ordered by what's most arresting about them.
  let headline: string;
  if (brief.risen) {
    headline = pick([
      `Come Into Their Own: ${name} Rises as ${article(brief.risen)}`,
      `${name} Hailed ${article(brief.risen)} in ${town}`,
      `A New ${strip(brief.risen)} in ${town}: ${name} Earns the Name`,
    ]);
  } else if (brief.epithet) {
    headline = pick([
      `The One They Call ${brief.epithet}`,
      `Of ${name}, and How the Name Was Earned`,
      `${name}: ${town} Speaks the Name with Care`,
    ]);
  } else if (drive && /aveng|vengeance|grudge/.test(drive)) {
    headline = pick([`A Score to Settle: ${name} of ${town}`, `${name} Nurses a Grudge`, `Blood Will Have Blood: ${name}`]);
  } else if (drive && /grie/.test(drive)) {
    headline = pick([`In Mourning: ${name} of ${town}`, `${name} Bears a Fresh Grief`, `A Hard Season for ${name}`]);
  } else if (drive && /fortune|debt|wealth|coin/.test(drive)) {
    headline = pick([`Chasing the Coin: ${name}`, `Hard Coin, Hard Won: ${name} of ${town}`, `${name} and the Long Road to a Fortune`]);
  } else if (lead) {
    headline = pick([`${name}, ${article(callingNoun)} of ${town}, ${lead}`, `${cap(lead)} — the Tale of ${name}`, `${name} of ${town}: ${cap(lead)}`]);
  } else {
    headline = pick([`${name}, ${article(callingNoun)} of ${town}`, `Word from ${town}: ${name}`, `A Quiet Life in ${town}: ${name}`]);
  }
  headline = cap(headline);

  // --- body: identity → the drive woven with a deed → ties → a closing colour.
  const S: string[] = [];
  const idClauses: string[] = [`${name} is ${article(callingNoun)} of ${town}`];
  if (brief.role) idClauses.push(brief.role);
  if (brief.faith) idClauses.push(`and keeps the faith of ${brief.faith}`);
  S.push(cap(idClauses.join(', ') + '.'));

  const mem3 = (brief.memories || []).slice(0, 3);
  if (drive && mem3.length) {
    S.push(cap(pick([
      `${given}, ${drive}, of late ${joinAnd(mem3)}.`,
      `These days ${given} is ${drive} — and ${joinAnd(mem3)} besides.`,
      `${cap(drive)}, ${given} ${joinAnd(mem3)}.`,
    ])));
  } else if (mem3.length) {
    S.push(cap(`${given} ${joinAnd(mem3)}.`));
  } else if (drive) {
    S.push(cap(`By all accounts ${given} is ${drive}.`));
  }

  const rel = brief.relations || {};
  const rc: string[] = [];
  if (rel.spouse) rc.push(`wed to ${rel.spouse}`);
  if (rel.rival) rc.push(`locked in a rivalry with ${rel.rival}`);
  if (rel.kin) rc.push(`with ${rel.kin} of kin at their back`);
  if (rc.length) S.push(cap(`${given} is ${rc.join(', ')}.`));

  if (brief.hearsay) S.push(cap(`${given} ${brief.hearsay.text}.`));
  if (brief.mood) S.push(cap(`Those who crossed ${given}'s path of late found them ${brief.mood}.`));
  if (brief.beats && brief.beats[0]) S.push(brief.beats[0]);

  if (S.length < 2) S.push(`${name} keeps to the quiet trade of ${town}.`);
  return { headline, body: S.join(' ') };
}

// OBITUARY — a life retrospective at death. Leads with who they were and how they
// fell, recalls a deed or two and who they leave, and closes on the TOWN'S regard —
// warm for the loved, cold for the reviled, and pointed when a name was blackened by
// rumour (the epistemic sting: the paper buries the person the town BELIEVED in).
function obituaryArticle(b: BriefView): ArticleProse {
  const name = b.subjectName || 'A soul of the town';
  const given = b.given || name;
  const town = b.dateline || 'the town';
  const calling = strip(b.calling) || 'soul of the town';
  let headline: string;
  if (b.villain) headline = `${name} Is Dead`;
  else if (b.hero) headline = `In Memoriam: ${name}, a Hero Fallen`;
  else if ((b.regard || 0) <= -0.2) headline = `${name} Is Dead — and Few Will Mourn`;
  else headline = `In Memoriam: ${name} of ${town}`;

  const S: string[] = [];
  S.push(cap(`${name}, ${article(calling)} of ${town}, ${b.cause || 'has died'}.`));
  const mem2 = (b.memories || []).slice(0, 2);
  if (mem2.length) S.push(cap(`In life they ${joinAnd(mem2)}.`));
  const rel = b.relations || {};
  const rc: string[] = [];
  if (rel.spouse) rc.push(`a spouse, ${rel.spouse}`);
  if (rel.kin) rc.push(`${rel.kin} of kin`);
  if (rc.length) S.push(cap(`They leave ${joinAnd(rc)} behind.`));
  // the closing note — the town's verdict
  if (b.hounded) S.push('In their last days whispers turned the town against them; whether the talk was ever true, the grave does not say.');
  else if (b.villain) S.push('The town will not grieve — and doors long barred may open again at dusk.');
  else if (b.hero) S.push('They will be named by the fire for many a winter, and the realm is the poorer for the loss.');
  else if ((b.regard || 0) > 0.25) S.push('They were well thought of, and will be missed at the market and the hearth.');
  else if ((b.regard || 0) <= -0.25) S.push('Few had a kind word for them living, and fewer will mark the loss.');
  else S.push('A quiet life, now ended; the town goes on, as towns do.');
  return { headline: cap(headline), body: S.join(' ') };
}

function cap(s: string): string { return s && s.length ? s[0].toUpperCase() + s.slice(1) : s; }
function strip(s: string | null | undefined): string { return (s || '').replace(/^\[+|\]+$/g, '').trim(); }              // class names print bracketed
function article(noun: string | null | undefined): string { const s = strip(noun || ''); return (/^[aeiou]/i.test(s) ? 'an ' : 'a ') + s; }
function joinAnd(a: string[]): string {
  if (!a || !a.length) return '';
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
}

const nearestTown = (sim: Sim, pos: any): any => {
  try {
    let best = null, bd = Infinity;
    for (const t of (sim.towns || [])) { const d = t.center.distanceToSquared(pos); if (d < bd) { bd = d; best = t; } }
    return best;
  } catch { return null; }
};
const nearestTownName = (sim: Sim, pos: any): string => { const t = nearestTown(sim, pos); return t ? (t.name || `Town ${t.id}`) : 'the town'; };

/** One desk dispatch: a candidate wire story with a usefulness value + dedupe sig. */
export interface Dispatch { value: number; sig: string; brief: StoryBrief; }

// THE DESKS — mine live sim state for USEFUL, sellable intel. Pure + guarded; each
// item is { value (usefulness to a reader), sig (for dedupe), brief }. The Reporter
// publishes the freshest high-value items (see reporter._wireDesk).
export function gatherDispatches(sim: Sim): Dispatch[] {
  const out: Dispatch[] = [];
  try {
    // MARKET: per town × STAPLE commodity, the REAL supply/demand imbalance — total
    // unmet buyer demand (wantQty) vs sellable supply (sellQty). This is TRUE intel:
    // "wanted in Eastmarket" means there really ARE buyers there, so a hauler acting
    // on it actually sells (a high price BELIEF alone didn't track real demand). Made
    // goods (tool/potion) are excluded — priced by too few to be trustworthy news.
    const margin = GAZETTE.marketMargin || 4;
    const basePrice = BASE_PRICE as Record<string, number>;
    const STAPLES = ['food', 'wood', 'ore', 'herb'];
    for (const town of (sim.towns || [])) {
      for (const good of STAPLES) {
        let demand = 0, supply = 0, believers = 0; const vals: number[] = [];
        for (const a of sim.agents) {
          if (!a.alive || !a.autonomous || a.faction !== 'townsfolk' || a.townId !== town.id) continue;
          believers++;
          if (a.gold >= 1) demand += a.wantQty(good);
          supply += a.sellQty(good);
          if (a.priceBeliefs && a.priceBeliefs[good] != null) vals.push(a.priceBeliefs[good]);
        }
        if (believers < 6) continue;
        const net = demand - supply;
        if (Math.abs(net) < margin) continue;       // market roughly in balance — no story
        vals.sort((x, y) => x - y);
        const med = vals.length ? +vals[vals.length >> 1].toFixed(1) : (basePrice[good] || 1);
        const wanted = net > 0;
        out.push({ value: 1.0 + Math.min(2, Math.abs(net) / 8), sig: `mkt:${town.id}:${good}:${wanted ? 'up' : 'dn'}`,
          brief: { kind: 'market', good, town: town.name, dateline: town.name, originTown: town.id, med, base: basePrice[good] || 1, wanted, demand, supply, t: sim.time } });
      }
    }
    // THREAT: named, persistent foes (a nemesis / warlord) abroad near a town.
    for (const a of sim.agents) {
      if (!a.alive || (!a.nemesis && !a.warlord)) continue;
      const t = nearestTown(sim, a.pos);
      const town = t ? (t.name || `Town ${t.id}`) : 'the town';
      out.push({ value: a.warlord ? 3.2 : 2.8, sig: `threat:${a.id}`,
        brief: { kind: 'threat', foe: a.name, town, dateline: town, townId: t ? t.id : null, foeId: a.id, warlord: !!a.warlord, t: sim.time } });
    }
    // OPPORTUNITY: live quest notices — bounties, pleas, deliveries (advertise them).
    const offers = (sim.quests && sim.quests.offers) || [];
    for (const q of offers) {
      const giver = sim.agentsById.get(q.giverId);
      const town = giver ? nearestTownName(sim, giver.pos) : 'the town';
      const value = q.type === 'avenge' ? 1.7 : q.type === 'hunt' ? 1.4 : q.type === 'recover' ? 1.2 : 1.0;
      out.push({ value, sig: `opp:${q.id}`,
        brief: { kind: 'opportunity', questId: q.id, title: q.title, desc: q.desc, qtype: q.type, town, dateline: town, t: sim.time } });
    }
    // EVENTS — the SAGA's front-page news: the biggest recent chronicle beats (wars
    // won, heroes & nemeses, weddings + feud-healings, prodigies rising, vendettas).
    // Each beat is reported ONCE (dedup by beat id via the reporter's cooldown map);
    // the beat text is already a finished line, so it IS the headline. This is what
    // makes the Gazette report the unfolding story, not just prices + profiles.
    const NEWS: Record<string, number> = { legend: 3.0, raid: 2.4, union: 2.2, patrician: 2.0, vendetta: 2.0, faith: 1.8, prodigy: 1.6, watch: 1.6 };
    const beats: any[] = ([] as any[]).concat(
      sim.chronicle && sim.chronicle.legends ? sim.chronicle.legends(12) : [],
      sim.chronicle && sim.chronicle.recent ? sim.chronicle.recent(20) : []);
    const seenBeat = new Set<unknown>();
    for (const b of beats) {
      if (!b || !b.text || seenBeat.has(b.id)) continue;
      const v = NEWS[b.kind]; if (v == null) continue;
      seenBeat.add(b.id);
      out.push({ value: v, sig: `evt:${b.id}`, brief: { kind: 'event', line: b.text, beatKind: b.kind, dateline: 'the realm', t: b.t } });
    }
    // SAGAS — the gem of the front page: a COMPLETED multi-beat arc threaded into a
    // single retrospective FEATURE, so the reader gets the whole shaped story (betrayal
    // → vengeance → duel; a tyrant humbled; a traitor unmasked) instead of three
    // scattered beats. Highest value — these are the tales worth the price of the paper.
    const sagas = (sim.director && sim.director._sagas) || [];
    for (const s of sagas) {
      if (!s || !s.sig) continue;
      if (sim.time - (s.t || 0) > 120) continue;     // only FRESH sagas — so each ages out
      out.push({ value: 3.6, sig: s.sig, brief: { kind: 'saga', saga: s, dateline: 'the realm', t: s.t } });   // of the desk before its file-cooldown lapses (filed once, never re-run)
    }
  } catch { /* never throw */ }
  return out;
}

export class Gazette {
  sim: Sim;
  articles: Article[];
  _seq: number;
  _pending: number[];

  constructor(sim: Sim) {
    this.sim = sim;
    this.articles = [];      // bounded ring of published Articles, newest LAST
    this._seq = 0;           // monotonic id (UI new-entry detection)
    this._pending = [];      // article ids awaiting optional LLM enrichment
  }

  // Deterministic FILE: render the template immediately and publish it (so the feed
  // is never empty and headless/offline both populate), and queue it for the
  // browser press pump to upgrade in place. Returns the published article.
  file(brief: StoryBrief): Article {
    const id = ++this._seq;
    // Object.assign's literal result lacks Article's [k:string] index signature; the
    // shape is Article-compatible (brief + headline/body + the carried fields), so
    // widen it through unknown.
    const art = Object.assign({
      id, t: this.sim.time,
      subjectId: brief.subjectId, subjectName: brief.subjectName,
      originTown: brief.originTown, dateline: brief.dateline,
      source: 'template', brief,
    }, templateArticle(brief, this.sim)) as unknown as Article;
    this.articles.push(art);
    const cap = (GAZETTE.cap || 60);
    if (this.articles.length > cap) this.articles.shift();
    // PERSON profiles and OBITUARIES get the optional LLM prose upgrade; market/
    // threat/opportunity notices are short factual intel — the template IS the voice.
    const k = brief.kind || 'person';
    if (k === 'person' || k === 'obituary') this._pending.push(id);
    return art;
  }

  getById(id: number): Article | null { return this.articles.find((a) => a.id === id) || null; }

  // browser press pump: pull the next article needing enrichment (id), if any.
  takePendingId(): number | null { return this._pending.length ? (this._pending.shift() as number) : null; }

  // swap LLM prose into an already-published article (by id), keeping its slot.
  applyArticle(id: number, prose: { headline?: string; body?: string } | null | undefined): boolean {
    const a = this.getById(id);
    if (!a || !prose || !prose.headline || !prose.body) return false;
    a.headline = prose.headline; a.body = prose.body; a.source = 'llm';
    return true;
  }

  recent(n = (GAZETTE.cap || 60)): Article[] { return this.articles.slice(-n).reverse(); }   // newest-first
  count(): number { return this.articles.length; }
  dispose(): void { this.articles = []; this._pending = []; }
}

export { MONSTER };
