// Obituaries ("In Memoriam") — when a notable soul dies, the Gazette files a life
// retrospective framed by how the TOWN remembers them (which, after the rumour
// layer, may diverge from the truth). Unit-checks the pure builders: worthiness
// gating, cause-of-death, hero/villain framing, and the "hounded by rumour" flag.

import { World } from '../../js/sim/world.js';
import { Simulation } from '../../js/sim/simulation.js';
import { Agent } from '../../js/sim/agent.js';
import { buildObituary, obituaryWorthy, templateArticle } from '../../js/sim/gazette.js';

const P = () => ({ aggression: .5, greed: .5, sociability: .5, curiosity: .5, bravery: .5, industry: .5, ambition: .5 });

export function obituaryTest(ok, { makeFighter, stubScene }) {
  const world = new World(stubScene);
  const sim = new Simulation(stubScene, world, { makeFighter });
  let nid = 1;
  const add = (name, faction = 'townsfolk') => {
    const a = new Agent(makeFighter('knight', {}), { id: nid++, name, profession: null, personality: P(), faction });
    a.fighter.root.position.set(0, 0, 0);
    sim.agents.push(a); sim.agentsById.set(a.id, a); return a;
  };
  const regardOf = (subject, observer, standing, hostile = false, rumorBorn = false) => {
    const b = observer.beliefs.observe(subject.id, 'townsfolk', subject.pos, 0, hostile);
    b.standing = standing; if (hostile) b.hostile = true; if (rumorBorn) b.rumorBorn = true;
  };

  // a fallen hero, cut down by a named nemesis
  const hero = add('Garrik Vael'); hero.epithet = 'the Bold'; hero.name = 'Garrik the Bold';
  hero.life.foeKills = 4; hero.house = 'Vael';
  const slayer = add('the Bloody-Handed', 'bandit'); slayer.nemesis = true;
  const fan = add('Elsa'); regardOf(hero, fan, 0.6);

  // worthiness gating
  ok(obituaryWorthy(hero) === true, 'obituary: an epithet’d hero is worth an obituary');
  ok(obituaryWorthy(add('Bandit 6', 'monster')) === false, 'obituary: a faceless mob gets none');

  // build + render (buildObituary reads the deceased's intact state, as at death)
  const brief = buildObituary(hero, sim, slayer);
  ok(brief.kind === 'obituary', 'obituary: brief is kind=obituary');
  ok(/Bloody-Handed/.test(brief.cause), `obituary: cause names the slayer (${brief.cause})`);
  ok(brief.hero === true, 'obituary: a foe-felling epithet reads as a hero');
  const art = templateArticle(brief, sim);
  ok(/Garrik the Bold/.test(art.headline) && /Memoriam|Hero/i.test(art.headline),
    `obituary: headline memorialises by name ("${art.headline}")`);
  ok(/cut down|slain|fell/.test(art.body), 'obituary: body recounts how they fell');

  // the epistemic sting — a name blackened by rumour is flagged "hounded"
  regardOf(hero, add('Doran'), -0.9, true, true);
  regardOf(hero, add('Pell'), -0.9, true, true);
  ok(buildObituary(hero, sim, slayer).hounded === true,
    'obituary: a name blackened by rumour is flagged hounded (the epistemic sting)');

  // a reviled villain gets the cold farewell, not a eulogy
  const villain = add('Mord'); villain.epithet = 'the Cruel'; villain.name = 'the Cruel';
  villain.nemesis = true; villain.life.townKills = 3;
  const vb = buildObituary(villain, sim, slayer);
  ok(vb.villain === true, 'obituary: a townsfolk-slayer reads as a villain');
  ok(/Is Dead/.test(templateArticle(vb, sim).headline), 'obituary: the reviled get a cold headline, not "In Memoriam"');

  sim.dispose && sim.dispose();
}
