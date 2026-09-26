// Tactical grid battles (js/app/tactics): movement over heights, the environment chains
// (shove into fire, oil bursts, spilled braziers, spreading hay fires, blinding flour),
// readied actions + surprise, and whole AI-vs-AI battles that must terminate conserved.

import { createSession } from '../../js/app/session.js';
import { BattleMap } from '../../js/app/tactics/map.js';
import { Battle } from '../../js/app/tactics/battle.js';
import { runTurn, planTurn, predictAllies } from '../../js/app/tactics/ai.js';
import { willingness } from '../../js/app/tactics/comms.js';
import { readWriteIn } from '../../js/app/tactics/writein.js';
import { affordances, pathRisks } from '../../js/app/tactics/affordances.js';
import { Agent } from '../../js/sim/agent.js';
import { HeadlessFighter } from '../../js/headlessFighter.js';

const P = (risk = 0.5) => ({ risk_tolerance: risk, social_drive: 0.4, ambition: 0.5, altruism: 0.5, curiosity: 0.4 });
const CENTER = { x: 300, z: 300 };

/** A flat, empty 12×12 field with a player and helpers to drop people and props on it. */
function arena(stubScene, makeFighter) {
  const s = createSession({ scene: stubScene, makeFighter, townsfolkPerTown: 1,
    player: { fighter: new HeadlessFighter('knight', { isPlayer: true }), spawn: CENTER } });
  const map = new BattleMap(CENTER, 12, { bare: true });
  for (const t of map.tiles) { t.h = 0; t.ground = 'dirt'; }
  const b = new Battle(s, map);
  const mk = (name, faction = 'bandit', risk = 0.5) => {
    const a = new Agent(makeFighter('knight', {}), { id: s.sim._nextId++, name, profession: null, personality: P(risk), faction, combatant: true, controlled: false });
    s.sim.agents.push(a); s.sim.agentsById.set(a.id, a);
    return a;
  };
  const see = (a, bb, hostile = true) => { a.beliefs.observe(bb.id, bb.faction, bb.pos, 0, hostile); if (hostile) a.beliefs.get(bb.id).hostile = true; };
  return { s, map, b, mk, see };
}

/** Force a deterministic turn order (highest first). */
function order(b, ...units) { units.forEach((u, i) => (u.init = 100 - i)); }

export function tacticsTest(ok, { stubScene, makeFighter }) {
  // --- 1. movement: ledges, walls, foes block -----------------------------------------------
  {
    const { s, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 2, z: 2 });
    for (let x = 0; x < 12; x++) map.tile(x, 4).h = 6;          // a 3m cliff across the field
    map.tile(3, 2).wall = true;
    const g = b.add(mk('Garrick'), 'foe', { x: 2, z: 3 });
    order(b, you, g); b.start();
    const r = b.reachable(you);
    ok(!r.has('2,4') && !r.has('3,4'), 'tactics: a unit cannot climb a 3m cliff in one step');
    ok(!r.has('3,2'), 'tactics: walls are impassable');
    ok(!r.has('2,3'), 'tactics: a foe\'s tile cannot be entered');
    s.dispose();
  }

  // --- 2. shove a bandit into the campfire ------------------------------------------------------
  {
    const { s, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 4, z: 5 });
    const g = b.add(mk('Garrick'), 'foe', { x: 5, z: 5 });
    map.addProp('campfire', 6, 5);
    you.sheet.might = 30;                                        // make the shove certain
    order(b, you, g); b.start();
    const odds = b.odds(you, { kind: 'shove', target: g.id });
    ok(odds.notes.includes('into the fire!'), `tactics: the preview warns the shove lands in the fire (${odds.notes.join(', ')})`);
    b.act(you, { kind: 'shove', target: g.id });
    ok(g.x === 6 && g.burning > 0, `tactics: shoved into the campfire, the bandit catches fire (x=${g.x}, burning=${g.burning})`);
    s.dispose();
  }

  // --- 3. hay fire spreads, oil bursts, a kicked brazier spills -------------------------------
  {
    const { s, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 1, z: 1 });
    const g = b.add(mk('Garrick'), 'foe', { x: 9, z: 8 });
    const m = b.add(mk('Mira'), 'foe', { x: 8, z: 9 });
    for (let x = 2; x <= 7; x++) map.addProp('hay', x, 5);
    map.addProp('oil', 9, 9);
    order(b, you, g, m); b.start();
    b.ignite(2, 5, you);
    let rounds = 0;
    while (rounds < 8 && !map.tile(7, 5).burning && ![...map.props.values()].every((p) => p.kind !== 'hay' || p.x < 7)) {
      for (const t of map.tiles) { /* just let the environment tick */ }
      b['environment'](); rounds++;
    }
    const burnt = [2, 3, 4, 5, 6, 7].filter((x) => map.tile(x, 5).burning || map.tile(x, 5).ground === 'ash' || !map.propAt(x, 5)).length;
    ok(burnt >= 4, `tactics: fire runs along the hay line (${burnt}/6 tiles caught within ${rounds} rounds)`);
    const hp0 = g.agent.fighter.health + m.agent.fighter.health;
    b.ignite(9, 9, you);
    ok(!map.propAt(9, 9) && g.burning > 0 && m.burning > 0, 'tactics: a lit oil barrel bursts and sets the adjacent bandits alight');
    ok(g.agent.fighter.health + m.agent.fighter.health < hp0, 'tactics: the burst wounds them');
    s.dispose();
    // kick a brazier toward a foe
    const k = arena(stubScene, makeFighter);
    const y2 = k.b.add(k.s.player, 'player', { x: 3, z: 5 });
    const f2 = k.b.add(k.mk('Tomas'), 'foe', { x: 6, z: 5 });
    k.map.addProp('brazier', 4, 5);
    order(k.b, y2, f2); k.b.start();
    const br = k.map.propAt(4, 5);
    k.b.act(y2, { kind: 'kick', prop: br.id });
    ok(k.map.tile(4, 5).burning && k.map.tile(5, 5).burning && k.map.tile(6, 5).burning && f2.burning > 0, 'tactics: a kicked brazier spills a line of coals that catches the foe');
    k.s.dispose();
  }

  // --- 4. flour blinds: a cloud blocks sight -------------------------------------------------
  {
    const { s, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 2, z: 5 });
    const g = b.add(mk('Garrick'), 'foe', { x: 7, z: 5 });
    map.addProp('flour', 3, 5);
    order(b, you, g); b.start();
    ok(map.sees(2, 5, 7, 5), 'tactics: clear sight before the cloud');
    you.sheet.finesse = 30;
    b.act(you, { kind: 'throw', prop: map.propAt(3, 5).id, at: { x: 7, z: 5 } });
    ok(map.tile(7, 5).smoke > 0 && !map.sees(2, 5, 9, 5), 'tactics: a burst flour sack leaves a cloud that blocks line of sight');
    s.dispose();
  }

  // --- 5. readied action interrupts an attack on a ward; overwatch fires on approach ----------
  {
    const { s, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 4, z: 4 });
    const borinA = mk('Borin', 'townsfolk'); borinA.inParty = true;
    const borin = b.add(borinA, 'companion', { x: 6, z: 4 });
    const g = b.add(mk('Garrick'), 'foe', { x: 5, z: 6 });
    you.sheet.might = 30;
    order(b, you, borin, g); b.start();
    // "if anyone goes for Borin, I shove them" — the response target is left open (-1)
    b.act(you, { kind: 'ready', trigger: { on: 'attacks', ward: borin.id }, response: { kind: 'shove', target: -1 } });
    b.endTurn(you);
    b.act(borin, { kind: 'defend' }); b.endTurn(borin);
    b.moveTo(g, { x: 5, z: 4 });                 // step between you and Borin
    const gx = g.x;
    b.act(g, { kind: 'attack', target: borin.id });
    ok(b.log.some((l) => l.text.includes('springs into action') || l.text.includes('spring into action')), 'tactics: the readied response fires when the ward is attacked');
    const iReact = b.log.findIndex((l) => /spring/.test(l.text));
    const iBlow = b.log.findIndex((l, i) => i > iReact && /Garrick (swings|hits)/.test(l.text));
    const iShove = b.log.findIndex((l, i) => i > iReact && /(shove Garrick|holds firm)/.test(l.text));
    ok(iShove > iReact && (iBlow === -1 || iShove < iBlow), `tactics: …and the shove resolves before Garrick's blow (react@${iReact} shove@${iShove} blow@${iBlow}, moved=${g.x !== gx})`);
    s.dispose();
  }

  // --- 6. surprise: those who never saw it coming lose round one ------------------------------
  {
    const { s, b, mk, see } = arena(stubScene, makeFighter);
    const you = b.add(s.player, 'player', { x: 2, z: 2 });
    const g = b.add(mk('Garrick'), 'foe', { x: 8, z: 8 });
    const lookout = b.add(mk('Lookout'), 'foe', { x: 9, z: 8 });
    see(lookout.agent, s.player);
    b.surpriseFromBeliefs();
    ok(g.surprised && !lookout.surprised, 'tactics: the bandit with no belief about you is surprised; the lookout who saw you is not');
    order(b, g, lookout, you); b.start();
    ok(b.current() === lookout, 'tactics: the surprised bandit\'s first turn is skipped');
    s.dispose();
  }

  // --- 8. write-ins resolve to grid actions (with the GM's positioning) -----------------------
  {
    const { s: ss, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 3, z: 5 });
    const borinA = mk('Borin', 'townsfolk'); borinA.inParty = true;
    const borin = b.add(borinA, 'companion', { x: 3, z: 7 });
    const g = b.add(mk('Garrick'), 'foe', { x: 7, z: 5 });
    const m = b.add(mk('Mira'), 'foe', { x: 6, z: 3 });
    map.addProp('brazier', 5, 5); map.addProp('campfire', 6, 2); map.addProp('flour', 3, 4); map.addProp('cart', 2, 5);
    order(b, you, borin, g, m); b.start();
    you.agent.fighter.health = 60;
    const top = (t) => readWriteIn(b, you, t)[0];
    const cases = [
      ['kick the brazier into Garrick', (r) => r.action.kind === 'kick' && r.to && r.to.x === 4 && r.to.z === 5],
      ['shove Mira into the fire', (r) => r.action.kind === 'shove' && r.action.target === m.id && r.to && r.to.x === 6 && r.to.z === 4],
      ['throw the flour at Mira', (r) => r.action.kind === 'throw' && r.action.at.x === m.x],
      ['climb onto the cart', (r) => r.to && r.to.x === 2 && r.to.z === 5],
      ['if anyone attacks Borin, I shove them', (r) => r.action.kind === 'ready' && r.action.trigger.on === 'attacks' && r.action.response.kind === 'shove'],
      ['when Garrick moves, hit him', (r) => r.action.kind === 'ready' && r.action.trigger.on === 'moves'],
      ['yell at Mira that Garrick is a traitor', (r) => r.action.kind === 'social' && r.action.claim === 'turncoat' && r.action.target === m.id && r.action.subject === g.id],
      ['bandage myself', (r) => r.action.kind === 'aid' && r.action.target === you.id],
      // playtester phrasings: readiness words give way to the real verb; blocking; implicit triggers
      ['stay ready and bandage myself', (r) => r.action.kind === 'aid'],
      ['keep Garrick away from Borin', (r) => r.action.kind === 'block' && r.label.includes('Borin')],
      ['hit the first bandit that comes close', (r) => r.action.kind === 'ready' && r.action.trigger.on === 'reach' && r.action.response.kind === 'attack'],
      ['hit Garrick to push him back', (r) => r.action.kind === 'attack'],
    ];
    let pass = 0;
    for (const [t, pred] of cases) { const r = top(t); if (r && pred(r)) pass++; else console.log(`   write-in miss: "${t}" → ${JSON.stringify(r && { to: r.to, action: r.action })}`); }
    ok(pass === cases.length, `tactics: grid write-ins resolve with sensible positioning ${pass}/${cases.length}`);
    ok(readWriteIn(b, you, 'summon a dragon').length === 0, 'tactics: a write-in naming nothing on the field yields no reading');
    // an order addressed to a companion is theirs: read from Borin, "me" is the one giving it
    const said = readWriteIn(b, you, 'Borin, guard me')[0];
    ok(said && said.call && said.call.kind === 'ask' && said.call.to[0] === borin.id && said.call.want.kinds.includes('guard') && said.call.want.ally === you.id,
      `tactics: "Borin, guard me" is a call to Borin, not your own deed (${said && said.label})`);
    const bg = readWriteIn(b, borin, 'Borin, guard me')[0];
    ok(bg && bg.action.kind === 'guard' && bg.action.target === you.id, `tactics: "Borin, guard me" read on Borin's turn guards you (${bg && bg.label})`);
    const tm = readWriteIn(b, borin, 'tell Borin to cover you')[0];
    ok(tm && tm.action.kind === 'guard' && tm.action.target === you.id, `tactics: "tell Borin to cover you" — "you" is the teller (${tm && tm.label})`);
    ss.dispose();
  }

  // --- 11. affordances: what you can do this turn from anywhere you can reach, with a forecast ---
  {
    const { s: ss, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 2, z: 5 });
    const g = b.add(mk('Garrick'), 'foe', { x: 7, z: 5 });
    const br = map.addProp('brazier', 5, 5);
    map.addProp('flour', 2, 3);
    order(b, you, g); b.start();
    const affs = affordances(b, you);
    const kick = affs.find((a) => a.action.kind === 'kick' && a.action.prop === br.id);
    ok(kick && kick.steps > 0 && kick.to && kick.to.x === 4 && kick.to.z === 5, `affordances: the brazier is offered from the tile that lines it up (${kick && JSON.stringify(kick.to)})`);
    ok(kick && kick.catches.includes(g) && /coals/.test(kick.effect), `affordances: the forecast says the coals reach Garrick (${kick && kick.effect})`);
    ok(affs[0] === kick, `affordances: an option that hurts a foe ranks first (${affs[0] && affs[0].label})`);
    ok(affs.some((a) => a.action.kind === 'pickup'), 'affordances: the flour sack two steps away is on the list');
    ok(affs.filter((a) => a.group === 'Stance').every((a) => a.steps === 0), 'affordances: stances are offered from here only');
    g.overwatch = true; g.x = 4; g.z = 6;
    const risks = pathRisks(b, you, [{ x: 3, z: 5 }, { x: 4, z: 5 }]);
    ok(risks.some((r) => /overwatch/.test(r)), `affordances: the walk warns of a foe's overwatch (${risks.join('; ')})`);
    ss.dispose();
  }

  // --- 12. set-pieces: usable once by anyone in reach; effects resolve from the shared primitives --
  {
    const { s: ss, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 5, z: 6 });
    const g = b.add(mk('Garrick'), 'foe', { x: 5, z: 2 });
    const m = b.add(mk('Mira'), 'foe', { x: 9, z: 9 });
    b.addPiece({ id: 'pillar', kind: 'pillar', name: 'the leaning pillar', label: 'Topple the pillar', nouns: ['pillar'], verbs: ['topple', 'push'],
      at: [[5, 5]], solid: true, effects: [{ do: 'hit', area: { line: 'away', len: 3 }, dmg: 16, prone: true }, { do: 'drop', area: { line: 'away', len: 2 }, prop: 'rubble' }],
      says: 'it falls!', describe: 'falls 3 tiles away from you' });
    b.addPiece({ id: 'bell', kind: 'bell', name: 'the bell', label: 'Ring the bell', nouns: ['bell'], verbs: ['ring'], at: [[4, 6]], effects: [{ do: 'shake', r: 7 }], says: 'boom!', describe: 'rattles foes' });
    order(b, you, g, m); b.start();
    ok(b.map.tile(5, 5).wall, 'pieces: a solid piece fills its tile until used');
    const r = readWriteIn(b, you, 'topple the pillar onto Garrick')[0];
    ok(r && r.action.kind === 'use' && r.action.piece === 'pillar', `pieces: "topple the pillar" reads as the set-piece (${r && r.label})`);
    const aff = affordances(b, you).find((a) => a.action.kind === 'use' && a.action.piece === 'pillar');
    ok(aff && aff.catches.includes(g), `pieces: the forecast shows it falling on Garrick (${aff && aff.effect})`);
    const hp0 = g.agent.fighter.health;
    b.act(you, { kind: 'use', piece: 'pillar' });
    ok(g.agent.fighter.health < hp0 && g.prone && !b.map.tile(5, 5).wall && [...b.map.props.values()].some((p) => p.kind === 'rubble'), 'pieces: the pillar falls away from you, crushes Garrick, and leaves rubble');
    ok(!b.options(you).some((a) => a.kind === 'use' && a.piece === 'pillar'), 'pieces: a used piece is gone');
    ss.dispose();
  }

  // --- 13. brush: cover against missiles, hidden from far archers and from overwatch -------------
  {
    const { s: ss, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 3, z: 3 });
    const g = b.add(mk('Garrick'), 'foe', { x: 3, z: 9 });
    for (const [x, z] of [[3, 3], [4, 3], [3, 4]]) map.tile(x, z).ground = 'brush';
    order(b, you, g); b.start();
    ok(b.hidden(you), 'brush: in the brush with no foe beside you, you are hidden');
    ok(b.hitDC(g, you, g, true).notes.includes('in the brush'), 'brush: missiles at someone in the brush are harder');
    const r = readWriteIn(b, you, 'hide in the brush')[0];
    ok(r && r.label.startsWith('Hide') && r.action.kind === 'defend', `brush: "hide in the brush" is understood (${r && r.label})`);
    ok(b.flammable(3, 3), 'brush: it burns');
    ss.dispose();
  }

  // --- 14. talk: calls are weighed, not obeyed; plans let friends predict you (comms.ts, ai.ts) ---
  {
    const { s: ss, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 4, z: 8 });
    const pipA = mk('Pip', 'townsfolk'); pipA.inParty = true;
    const pip = b.add(pipA, 'companion', { x: 6, z: 8 }, { traits: { bravery: 0.6, compassion: 0.5, loyalty: 0.9, ruthlessness: 0.3 }, tactic: 'rogue' });
    const maudA = mk('Maud', 'townsfolk'); maudA.inParty = true;
    const maud = b.add(maudA, 'companion', { x: 5, z: 10 }, { traits: { bravery: 0.5, compassion: 0.95, loyalty: 0.2, ruthlessness: 0.05 }, tactic: 'healer' });
    const g = b.add(mk('Garrick'), 'foe', { x: 8, z: 4 });
    const m = b.add(mk('Mira'), 'foe', { x: 9, z: 9 });
    order(b, you, pip, maud, g, m); b.start();
    // asking: Pip is loyal and it's a fair ask — the likelihood says so, and Pip's own plan now answers it
    const ask = readWriteIn(b, you, 'Pip, go for Garrick')[0];
    ok(ask && ask.call && ask.call.want.target === g.id && ask.p >= 0.5, `talk: "Pip, go for Garrick" reads as an ask with a good chance (${ask && ask.label} ${ask && Math.round(ask.p * 100)}%)`);
    const before = planTurn(b, pip, { predict: true });
    b.speak(you, ask.call);
    const after = planTurn(b, pip, { predict: true });
    ok(after.action.target === g.id || (after.to && Math.abs(after.to.x - g.x) + Math.abs(after.to.z - g.z) < Math.abs(pip.x - g.x) + Math.abs(pip.z - g.z)),
      `talk: Pip weighs the ask and goes for Garrick (${before.why} → ${after.why})`);
    ok(b.speak(you, ask.call) !== null, 'talk: one call a turn');
    // a clash with who they are: Maud won't cut down someone who has given up
    m.morale = 'broken';
    const w = willingness(b, maud, you, { kinds: ['attack'], target: m.id });
    ok(w.w < 0.2 && /given up/.test(w.why), `talk: Maud refuses to strike the broken (${w.w.toFixed(2)}: ${w.why})`);
    // overheard: a foe near enough hears the plan against it
    ok(b.calls[0].heardBy.includes(pip.id), 'talk: the ask was heard by Pip');
    // announcing: "I'll shove Mira" — a friend acting before you can predict you exactly
    b.calls.length = 0; you.spoke = false;
    const plan = readWriteIn(b, you, "I'll shove Mira")[0];
    ok(plan && plan.call && plan.call.kind === 'plan' && plan.call.want.target === m.id, `talk: "I'll shove Mira" announces your plan (${plan && plan.label})`);
    b.order = [pip, you, maud, g, m]; b.turn = 0;
    b.speak(you, plan.call);
    ok((predictAllies(b, pip).get(m.id) ?? 0) === 1, 'talk: Pip, acting first, now knows exactly what you will do');
    ss.dispose();
  }

  // --- 10. block: a unit holding the ground pins foes who step next to it (zone of control) -----
  {
    const { s: ss, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 5, z: 5 });
    const g = b.add(mk('Garrick'), 'foe', { x: 7, z: 5 });
    order(b, you, g); b.start();
    const before = b.reachable(g, 4).has('4,4');
    ok(!b.act(you, { kind: 'block' }) && you.blocking, 'tactics: block is a legal stance');
    const after = b.reachable(g, 4);
    ok(before && !after.has('4,4') && after.has('5,4'), `tactics: a blocker stops foes at its side — they can step next to it, not past (${before}/${after.has('4,4')}/${after.has('5,4')})`);
    b.endTurn(you);
    ok(b.current() === g, 'tactics: turn passes to the foe');
    ss.dispose();
  }

  // --- 9. fell a tree: it takes blows, falls away from the axe (or onto someone), leaves a log as cover
  {
    const { s: ss, map, b, mk } = arena(stubScene, makeFighter);
    const you = b.add(ss.player, 'player', { x: 4, z: 5 });
    const g = b.add(mk('Garrick'), 'foe', { x: 7, z: 5 });
    const tree = map.addProp('tree', 5, 5);
    order(b, you, g); b.start();
    const r = readWriteIn(b, you, 'cut down the tree and use it as cover')[0];
    ok(r && r.action.kind === 'hew' && r.action.prop === tree.id, `tactics: 'cut down the tree' reads as hew (${r && r.action.kind})`);
    you.sheet.might = 30;                                    // one mighty blow
    b.act(you, { kind: 'hew', prop: tree.id, toward: { x: 6, z: 5 } });
    const log = [...map.props.values()].find((q) => q.kind === 'log');
    ok(!map.props.has(tree.id) && !!log && log.x === 6 && log.cover === 1, `tactics: the tree falls toward the foe and leaves a log for half cover (${log && `${log.x},${log.z}`})`);
    ok(g.prone && g.agent.fighter.health < 100, 'tactics: the falling trunk crushes the foe in its line');
    ok(b.map.coverAgainst(5, 5, 8, 5) === 1, 'tactics: standing behind the trunk now gives half cover');
    ss.dispose();
  }

  // --- 7. whole battles, AI on every side: terminate, conserve gold, release every body -------
  {
    let ended = 0, conserved = 0, released = 0, nan = 0, envUsed = 0;
    const N = 6;
    for (let k = 0; k < N; k++) {
      const { s, map, b, mk, see } = arena(stubScene, makeFighter);
      map.addProp('campfire', 6, 6); map.addProp('hay', 5, 3); map.addProp('hay', 6, 3); map.addProp('crate', 4, 7);
      map.addProp('barrel', 7, 4); map.addProp('brazier', 3, 5); map.addProp('bucket', 2, 2);
      const you = b.add(s.player, 'player', { x: 2, z: 5 });
      const comp = mk('Borin', 'townsfolk'); comp.inParty = true;
      b.add(comp, 'companion', { x: 2, z: 6 });
      const foes = [b.add(mk('Garrick'), 'foe', { x: 9, z: 5 }), b.add(mk('Mira', 'bandit', 0.3), 'foe', { x: 9, z: 7 }), b.add(mk('Tomas', 'bandit', 0.8), 'foe', { x: 8, z: 3 })];
      for (const f of foes) { see(f.agent, s.player); see(f.agent, comp); }
      const gold0 = s.sim.agents.reduce((t, a) => t + (a.gold || 0), 0);
      b.start();
      let guard = 0;
      while (!b.outcome && guard++ < 400) {
        const u = b.current(); if (!u) break;
        runTurn(b, u);                            // autopilot everyone, player included
      }
      if (b.outcome) ended++;
      if (Math.abs(s.sim.agents.reduce((t, a) => t + (a.gold || 0), 0) - gold0) < 1e-6) conserved++;
      if (b.units.every((u) => u.agent._encounter == null)) released++;
      if (b.units.some((u) => !Number.isFinite(u.agent.fighter.health))) nan++;
      if (b.log.some((l) => l.kind === 'env')) envUsed++;
      s.dispose();
    }
    ok(ended === N, `tactics: every AI battle reaches an outcome (${ended}/${N})`);
    ok(conserved === N, `tactics: gold conserved in every battle (${conserved}/${N})`);
    ok(released === N && nan === 0, `tactics: bodies released, no NaN health (${released}/${N}, nan=${nan})`);
    ok(envUsed >= 1, `tactics: the AI uses the environment in some battles (${envUsed}/${N})`);
  }
}
