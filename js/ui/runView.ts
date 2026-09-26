// RunUI: the screens of the run loop around the tactical battles — the hub (people to talk to,
// your company at the inn, work on offer), the briefing and party pick, the road between
// stages, the aftermath of each fight, the homecoming (who told whom what), and the companion
// journal. In AUTOPLAY it scripts itself (talks to people, takes the work, fights, comes home)
// for recordings; otherwise every step is a button.

import { TUNE } from '../constants.js';
import { COMPANIONS, bark, type CompanionKey } from '../app/run/companions.js';
import { HUB_NPCS } from '../app/run/hub.js';
import { plan } from '../app/run/autopilot.js';
import type { RunController, RunReport, StageResult } from '../app/run/run.js';
import type { Battle } from '../app/tactics/battle.js';
import { ITEMS, ITEM_ORDER, type ItemId } from '../app/tactics/items.js';

const CSS = `
#run { position: fixed; inset: 0; z-index: 40; pointer-events: none; font-family: "Segoe UI", system-ui, sans-serif; color: #e6ecf2; }
#run .panel { pointer-events: auto; position: absolute; background: rgba(9,12,17,.93); border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 12px 50px rgba(0,0,0,.6); }
#run .people { left: 14px; top: 14px; width: 300px; max-height: calc(100% - 28px); overflow-y: auto; padding: 12px; }
#run h2 { margin: 0 0 6px; font-size: 18px; letter-spacing: .4px; } #run h3 { margin: 10px 0 4px; font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #8d99a6; }
#run .store { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 2px 4px; } #run .store button { padding: 1px 8px; font-size: 11px; }
#run .who { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
#run .who:hover, #run .who.sel { background: rgba(232,200,121,.12); border-color: rgba(232,200,121,.4); }
#run .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
#run .warm { background: #6fcf7f; } #run .cool { background: #d8b35a; } #run .cold { background: #e0685a; } #run .neutral { background: #8d99a6; }
#run .who small { color: #8d99a6; display: block; font-size: 11px; }
#run .talk { left: 50%; bottom: 18px; transform: translateX(-50%); width: min(760px, 92vw); padding: 14px 18px; }
#run .line { font-size: 15px; line-height: 1.55; margin: 4px 0; } #run .line b { color: #e8c879; }
#run .line.warm { color: #cdf0d2; background: none; } #run .line.cool { color: #f0dfb4; background: none; } #run .line.cold { color: #f3b7ae; background: none; } #run .line.neutral { background: none; }
#run button { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18); color: #e6ecf2; border-radius: 6px; padding: 6px 11px; font: inherit; font-size: 13px; cursor: pointer; margin: 6px 6px 0 0; }
#run button:hover { background: rgba(232,200,121,.22); border-color: rgba(232,200,121,.6); }
#run .card { left: 50%; top: 50%; transform: translate(-50%,-50%); width: min(720px, 92vw); max-height: 86vh; overflow-y: auto; padding: 22px 26px; }
#run .card h1 { margin: 0 0 4px; font-size: 26px; } #run .card .sub { color: #8d99a6; font-size: 13px; margin-bottom: 12px; }
#run .card p { font-size: 15px; line-height: 1.6; margin: 8px 0; }
#run .quote { font-style: italic; color: #d9e2ea; margin: 4px 0 4px 10px; font-size: 14px; } #run .quote b { font-style: normal; color: #e8c879; }
#run .ok { color: #8fe39a; } #run .bad { color: #f09a8d; }
#run .deed { font-size: 14px; margin: 3px 0; padding-left: 12px; border-left: 2px solid rgba(232,200,121,.5); }
#run .tale { font-size: 13px; color: #c7d0d9; margin: 2px 0; }
#run .jr { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
#run .comp { background: rgba(255,255,255,.04); border-radius: 9px; padding: 10px 12px; }
#run .comp h4 { margin: 0; font-size: 15px; } #run .comp .t { color: #8d99a6; font-size: 11px; }
#run .tr { display: grid; grid-template-columns: 88px 1fr 70px; align-items: center; gap: 6px; font-size: 11px; margin: 3px 0; }
#run .tb { height: 6px; background: rgba(255,255,255,.1); border-radius: 3px; position: relative; overflow: hidden; }
#run .tb i { position: absolute; top: 0; bottom: 0; left: 0; background: #7fb6ff; } #run .tb s { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; opacity: .7; }
#run .up { color: #8fe39a; } #run .dn { color: #f09a8d; }
#run .mem { font-size: 12px; color: #c7d0d9; margin: 3px 0; font-style: italic; }
#run .party { display: flex; gap: 10px; flex-wrap: wrap; } #run .pick { padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.18); cursor: pointer; width: 150px; }
#run .pick.on { border-color: #e8c879; background: rgba(232,200,121,.12); } #run .pick.gone { opacity: .35; pointer-events: none; }
#run .banner { left: 50%; top: 14px; transform: translateX(-50%); padding: 8px 18px; font-size: 14px; text-align: center; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export interface RunUIOpts {
  rc: RunController;
  auto: boolean;
  openBattle(b: Battle): void;
  closeBattle(): void;
  focus(pos: { x: number; z: number } | null): void;
  onDone?(): void;
}

type Step = { run: () => void; wait: number };

export class RunUI {
  private root: HTMLDivElement;
  private o: RunUIOpts;
  private talking: string | null = null;
  private storeErr = '';
  private heardView = false;
  private picked = new Set<CompanionKey>();
  private report: RunReport | null = null;
  private steps: Step[] = [];
  private stepT = 0;
  private waitingBattle = false;
  private battleOverT = 0;
  private lastStage: StageResult | null = null;
  private stageTraits: Partial<Record<CompanionKey, Record<string, number>>> = {};
  private moments: string[] = [];
  private tally = { fell: [] as string[], fled: [] as string[], yielded: [] as string[], down: [] as string[], lost: [] as string[] };
  private rounds = 0;
  runIndex: number;
  /** Who you're talking to (hub npc key or companion key), for the camera and nameplates. */
  get speaking(): string | null { return this.talking; }

  constructor(o: RunUIOpts) {
    this.o = o;
    this.runIndex = o.rc.save.runs;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.root = document.createElement('div'); this.root.id = 'run'; document.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => e.stopPropagation());
  }

  dispose(): void { this.root.remove(); this.steps = []; }

  // ---- screens ----------------------------------------------------------------------------------

  title(): void {
    const rc = this.o.rc;
    this.root.innerHTML = `<div class="panel card"><h1>Hearsay</h1><div class="sub">A town that talks about you. Companions who remember.</div>
      <p>${rc.save.runs ? `Runs so far: <b>${rc.save.runs}</b>. Quests done: ${rc.save.questsDone.length ? rc.save.questsDone.join(', ') : 'none'}.` : 'You arrive in Market Town with a sword and a purse of forty silver.'}</p>
      <button data-a="hub">Walk into town</button></div>`;
    this.bind();
  }

  hub(): void {
    const rc = this.o.rc;
    const next = rc.nextQuest();
    const people = HUB_NPCS.map((n) => {
      const s = rc.save.hub.standing[n.key] ?? 0;
      const mood = s > 0.35 ? 'warm' : s < -0.35 ? 'cold' : s < -0.05 ? 'cool' : 'neutral';
      return `<div class="who ${this.talking === n.key ? 'sel' : ''}" data-talk="${n.key}"><span class="dot ${mood}"></span><div>${esc(n.name)}<small>${esc(n.role)}${next && next.giver === n.key ? ' · <b style="color:#e8c879">has work</b>' : ''}</small></div></div>`;
    }).join('');
    const comp = (Object.keys(COMPANIONS) as CompanionKey[]).map((k) => {
      const p = rc.save.profiles[k];
      const state = p.departed ? 'left the company' : !p.alive ? 'fallen' : `bravery ${p.traits.bravery.toFixed(2)} · loyalty ${p.traits.loyalty.toFixed(2)}`;
      return `<div class="who" data-comp="${k}"><span class="dot ${p.departed || !p.alive ? 'cold' : 'warm'}"></span><div>${esc(COMPANIONS[k].name)}<small>${esc(state)}</small></div></div>`;
    }).join('');
    let talk = '';
    if (this.talking && this.talking in COMPANIONS) {
      const k = this.talking as CompanionKey, p = rc.save.profiles[k];
      talk = `<div class="panel talk"><div class="line"><b>${esc(COMPANIONS[k].name)}:</b> ${esc(bark(p, 'setout'))}</div>
        ${p.memories.slice(-3).map((m) => `<div class="mem">“${esc(m.text)}”</div>`).join('')}<button data-a="journal">Company journal</button></div>`;
    } else if (this.talking) {
      const lines = rc.talk(this.talking);
      const heard = (rc.save.hub.heard[this.talking] ?? []).slice(-6).map((h) => {
        const d = rc.save.deeds.find((x) => x.id === h.deed);
        const from = h.from === 'saw it' ? 'saw it themself' : h.from === 'marta' ? 'heard it at the inn' : `${rc.name(h.from)} told them`;
        return d ? `<div class="tale">• ${esc(h.hops >= 2 ? d.lurid : d.label)} <span style="color:#8d99a6">(${esc(from)}, ${h.hops} hop${h.hops === 1 ? '' : 's'})</span></div>` : '';
      }).join('');
      const giver = next && next.giver === this.talking;
      talk = `<div class="panel talk">${lines.map((l) => `<div class="line ${l.mood}"><b>${esc(l.speaker)}:</b> ${esc(l.text)}</div>`).join('')}
        ${this.heardView ? `<h3>What ${esc(rc.name(this.talking))} has heard about you</h3>${heard || '<div class="tale">Nothing yet.</div>'}` : ''}
        <button data-a="heard">${this.heardView ? 'Hide' : 'What have you heard about me?'}</button>${giver ? `<button data-a="accept">Take the job: ${esc(next!.title)}</button>` : ''}</div>`;
    }
    this.root.innerHTML = `<div class="panel people"><h2>Market Town</h2><div style="font-size:12px;color:#8d99a6">Run ${rc.save.runs + 1}${next ? ` · work: ${esc(next.title)}` : ' · no work left'}</div>
      <h3>People</h3>${people}<h3>Your company (at the inn)</h3>${comp}<button data-a="journal">Company journal</button>
      <h3>Stores — ${Math.round(rc.save.gold ?? 0)} silver</h3>${ITEM_ORDER.map((id) => { const d = ITEMS[id], n = rc.kitOf('player')[id] ?? 0;
        return `<div class="store" title="${esc(d.describe)}"><span>${d.icon} ${esc(d.name)}${n ? ` <b>×${n}</b>` : ''}</span><button data-buy="${id}" ${(rc.save.gold ?? 0) < d.price ? 'disabled' : ''}>${d.price}s</button></div>`; }).join('')}
      ${this.storeErr ? `<div style="color:#e89090;font-size:11px">${esc(this.storeErr)}</div>` : ''}</div>${talk}`;
    this.bind();
  }

  talkTo(key: string): void {
    this.talking = key; this.heardView = false;
    const a = this.o.rc.hubAgents.get(key) ?? this.o.rc.companionAgents.get(key as CompanionKey);
    const pl = this.o.rc.session.player;
    if (a && pl) this.o.focus(a.pos);
    this.hub();
  }

  briefing(): void {
    const rc = this.o.rc, q = rc.nextQuest()!;
    const avail = rc.available();
    const cards = (Object.keys(COMPANIONS) as CompanionKey[]).map((k) => {
      const def = COMPANIONS[k], p = rc.save.profiles[k];
      const gone = !avail.includes(k);
      return `<div class="pick ${this.picked.has(k) ? 'on' : ''} ${gone ? 'gone' : ''}" data-pick="${k}"><b>${esc(def.name)}</b><div style="font-size:11px;color:#8d99a6">${esc(def.title)} · ${def.tactic}</div>
        <div style="font-size:11px;margin-top:4px">${gone ? (p.departed ? 'has left you' : 'fallen') : esc(def.blurb)}</div></div>`;
    }).join('');
    this.root.innerHTML = `<div class="panel card"><h1>${esc(q.title)}</h1><div class="sub">from ${esc(rc.name(q.giver))} · ${q.stages.length} stages: ${q.stages.map((s) => esc(s.name)).join(' → ')}</div>
      <p>${esc(q.pitch)}</p><h3>Choose up to three companions</h3><div class="party">${cards}</div>
      <button data-a="setout" ${this.picked.size ? '' : 'disabled'}>Set out</button><button data-a="hub">Not yet</button></div>`;
    this.bind();
  }

  travel(): void {
    const rc = this.o.rc, st = rc.stage!;
    const barks = rc.stageIdx === 0 ? rc.setoutBarks() : [];
    this.root.innerHTML = `<div class="panel card"><div class="sub">${esc(rc.quest!.title)} · stage ${rc.stageIdx + 1} of ${rc.quest!.stages.length}</div><h1>${esc(st.name[0].toUpperCase() + st.name.slice(1))}</h1>
      <p>${esc(st.intro)}</p><p><b>Objective:</b> ${esc(st.objectiveText)}</p>${barks.map((b) => `<div class="quote"><b>${esc(b.who)}:</b> “${esc(b.text)}”</div>`).join('')}
      <button data-a="fight">To arms</button></div>`;
    this.bind();
  }

  fight(): void {
    const rc = this.o.rc;
    this.root.innerHTML = `<div class="panel banner">${esc(rc.quest!.title)} — ${esc(rc.stage!.name)} · <b>${esc(rc.stage!.objectiveText)}</b></div>`;
    this.stageTraits = Object.fromEntries(rc.party.map((k) => [k, { ...rc.save.profiles[k].traits }]));
    const b = rc.beginStage();
    b.start();
    for (const x of rc.preBattleBarks()) b.note('social', `${x.who}: “${x.text}”`);
    this.waitingBattle = true; this.battleOverT = 0;
    this.o.openBattle(b);
  }

  /** The battle view reports the fight is over (player pressed Continue, or autoplay). */
  battleDone(): void {
    if (!this.waitingBattle) return;
    this.waitingBattle = false;
    const b = this.o.rc.battle;
    if (b) {
      // the fight's story: the moments worth retelling, and who ended up where
      const rank = (t: string, k: string) => (k === 'env' ? 5 : /springs|free|traitor|surrender|yield|begs|nerve|down!|goes down|hauls|haul|fire|ledge|critical|taken captive|falls/.test(t) ? 4 : k === 'social' ? 3 : 0);
      const lines = b.log.filter((l) => l.kind !== 'end' && !/^Battle!/.test(l.text)).map((l, i) => ({ l, i, r: rank(l.text, l.kind) })).filter((x) => x.r >= 3);
      const pick = [...lines].sort((x, y) => y.r - x.r || x.i - y.i).slice(0, 7).sort((x, y) => x.i - y.i);
      this.moments = pick.map((x) => `R${x.l.round} · ${x.l.text}`);
      const nm = (u: { agent: { name: string; controlled?: boolean } }) => (u.agent.controlled ? 'you' : u.agent.name);
      this.tally = {
        fell: b.units.filter((u) => u.side === 'them' && (u.out === 'dead' || !u.agent.alive)).map(nm),
        fled: b.units.filter((u) => u.out === 'fled' && !u.tags.has('captive')).map(nm),
        yielded: b.units.filter((u) => u.out === 'yielded').map(nm),
        down: b.units.filter((u) => u.side === 'us' && b.events.some((e) => e.kind === 'down' && e.target === u.id)).map(nm),
        lost: b.units.filter((u) => u.side === 'us' && !u.agent.alive).map(nm),
      };
      this.rounds = b.round;
    }
    this.o.closeBattle();
    this.lastStage = this.o.rc.endStage();
    this.aftermath();
  }

  aftermath(): void {
    const r = this.lastStage!, rc = this.o.rc;
    const won = r.outcome === 'victory' || r.outcome === 'truce';
    const q = rc.quest;
    const track = q ? q.stages.map((s, i) => {
      const res = rc.results[i];
      const mark = res ? (res.objectiveMet ? '<b class="ok">✓</b>' : '<b class="bad">✗</b>') : '<span style="color:#8d99a6">○</span>';
      return `<span style="margin-right:14px">${mark} ${esc(s.name)}</span>`;
    }).join('') : '';
    const T = this.tally;
    const tallyLine = [T.fell.length ? `Fell: ${T.fell.join(', ')}` : '', T.yielded.length ? `Surrendered: ${T.yielded.join(', ')}` : '', T.fled.length ? `Fled: ${T.fled.join(', ')}` : '',
      T.down.length ? `Went down: ${T.down.join(', ')}` : '', T.lost.length ? `<b class="bad">Lost: ${T.lost.join(', ')}</b>` : ''].filter(Boolean).join(' · ');
    const comps = rc.party.map((k) => {
      const p = rc.save.profiles[k], before = this.stageTraits[k] ?? p.traits;
      const say = r.barks.find((b) => b.who === COMPANIONS[k].name);
      const bars = (['bravery', 'compassion', 'loyalty'] as const).map((t) => {
        const v = p.traits[t], d = v - (before as Record<string, number>)[t];
        return `<div class="tr"><span>${t}</span><div class="tb"><i style="width:${v * 100}%"></i><s style="left:${(before as Record<string, number>)[t] * 100}%"></s></div><span class="${d > 0.005 ? 'up' : d < -0.005 ? 'dn' : ''}">${Math.abs(d) > 0.005 ? (d > 0 ? '▲ ' : '▼ ') + Math.abs(d).toFixed(2) : '—'}</span></div>`;
      }).join('');
      const why = p.memories.filter((m) => m.stage === r.stage.name).slice(-1)[0];
      return `<div class="comp"><h4>${esc(COMPANIONS[k].name)}</h4>${say ? `<div class="quote">“${esc(say.text)}”</div>` : ''}${bars}${why ? `<div class="mem">${esc(why.text)}</div>` : ''}</div>`;
    }).join('');
    this.root.innerHTML = `<div class="panel card" style="width:min(940px,95vw)"><div class="sub">${esc(q?.title ?? '')} · ${track}</div>
      <h1>${esc(r.stage.name[0].toUpperCase() + r.stage.name.slice(1))}: ${won ? '<span class="ok">won</span>' : `<span class="bad">${r.outcome === 'defeat' ? 'beaten' : r.outcome}</span>`} <span style="font-size:14px;color:#8d99a6">in ${this.rounds} rounds</span></h1>
      <p>${esc(r.stage.objectiveText)} <b class="${r.objectiveMet ? 'ok' : 'bad'}">${r.objectiveMet ? '✓ done' : '✗ not done'}</b></p>
      ${tallyLine ? `<p style="font-size:13px">${tallyLine}</p>` : ''}
      ${this.moments.length ? `<h3>How it went</h3>${this.moments.map((m) => `<div class="tale">${esc(m)}</div>`).join('')}` : ''}
      ${r.deeds.length ? `<h3>What people will say</h3>${r.deeds.map((d) => `<div class="deed">${esc(d.about === 'player' ? 'You ' + d.label : d.label)}</div>`).join('')}` : ''}
      <h3>Your company</h3><div class="jr">${comps}</div>
      <button data-a="${rc.runOver ? 'home' : 'next'}">${rc.runOver ? 'Head home' : 'Onward'}</button></div>`;
    this.bind();
  }

  home(): void {
    const rc = this.o.rc;
    this.report = rc.finishRun();
    rc.setupHub();
    const r = this.report;
    this.root.innerHTML = `<div class="panel card"><div class="sub">Home again · run ${rc.save.runs}</div><h1>${esc(r.quest.title)}: <span class="${r.success ? 'ok' : 'bad'}">${r.success ? 'done' : 'failed'}</span></h1>
      <h3>The tales go round</h3>${r.tales.slice(0, 10).map((t) => `<div class="tale">${esc(t)}</div>`).join('') || '<div class="tale">Nobody talks.</div>'}
      ${r.departures.map((d) => `<p class="bad">${esc(d)}</p>`).join('')}
      <button data-a="journal">Company journal</button><button data-a="hub">Into town</button></div>`;
    this.bind();
  }

  journal(): void {
    const rc = this.o.rc, r = this.report;
    const cards = (Object.keys(COMPANIONS) as CompanionKey[]).map((k) => {
      const def = COMPANIONS[k], p = rc.save.profiles[k];
      const before = r?.traitsBefore[k];
      const bars = (['bravery', 'compassion', 'loyalty', 'ruthlessness'] as const).map((t) => {
        const v = p.traits[t], b0 = before ? before[t] : v, d = v - b0;
        return `<div class="tr"><span>${t}</span><div class="tb"><i style="width:${v * 100}%"></i>${before ? `<s style="left:${b0 * 100}%"></s>` : ''}</div><span class="${d > 0.005 ? 'up' : d < -0.005 ? 'dn' : ''}">${v.toFixed(2)}${Math.abs(d) > 0.005 ? ` (${d > 0 ? '+' : ''}${d.toFixed(2)})` : ''}</span></div>`;
      }).join('');
      // who they've grown close to — or come to resent — across the runs
      const bonds = Object.entries(rc.save.bonds ?? {}).filter(([pk, b]) => pk.split('|').includes(k) && (b.lvl > 0 || b.kind === 'rival'))
        .map(([pk, b]) => { const o = pk.split('|').find((m) => m !== k)!; const name = o === 'player' ? 'you' : COMPANIONS[o as CompanionKey]?.short ?? o;
          return b.kind === 'rival' ? `<span class="bad">⚔ ${esc(name)}</span>` : `${esc(name)} <span style="color:#e8807a">${'♥'.repeat(b.lvl)}</span>`; });
      return `<div class="comp"><h4>${esc(def.name)} ${p.departed ? '<span class="bad">— left</span>' : !p.alive ? '<span class="bad">— fallen</span>' : ''}</h4>
        <div class="t">${p.stats.runs} runs · ${p.stats.battles} battles · ${p.stats.kills} kills · downed ${p.stats.downs}× · fled ${p.stats.fled}× · saved others ${p.stats.saves}×</div>
        ${bonds.length ? `<div class="t">Bonds: ${bonds.join(' · ')}</div>` : ''}
        ${bars}${p.memories.slice(-3).map((m) => `<div class="mem">“${esc(m.text)}”</div>`).join('')}</div>`;
    }).join('');
    this.root.innerHTML = `<div class="panel card" style="width:min(900px,94vw)"><h1>The company</h1><div class="sub">Traits change with what happens to them — and with what they watch you do. The white tick is where they started this run.</div>
      <div class="jr">${cards}</div><button data-a="hub">Into town</button></div>`;
    this.bind();
  }

  // ---- wiring -----------------------------------------------------------------------------------

  private bind(): void {
    this.root.querySelectorAll<HTMLElement>('[data-a]').forEach((el) => el.onclick = () => this.act(el.dataset.a!));
    this.root.querySelectorAll<HTMLElement>('[data-talk]').forEach((el) => el.onclick = () => this.talkTo(el.dataset.talk!));
    this.root.querySelectorAll<HTMLElement>('[data-buy]').forEach((el) => el.onclick = () => { this.storeErr = this.o.rc.buy(el.dataset.buy as ItemId) ?? ''; this.hub(); });
    this.root.querySelectorAll<HTMLElement>('[data-comp]').forEach((el) => el.onclick = () => this.talkTo(el.dataset.comp!));
    this.root.querySelectorAll<HTMLElement>('[data-pick]').forEach((el) => el.onclick = () => {
      const k = el.dataset.pick as CompanionKey;
      if (this.picked.has(k)) this.picked.delete(k); else if (this.picked.size < 3) this.picked.add(k);
      this.briefing();
    });
  }

  act(a: string): void {
    const rc = this.o.rc;
    switch (a) {
      case 'hub': this.talking = null; this.o.focus(null); rc.markSeen(); this.hub(); break;
      case 'heard': this.heardView = !this.heardView; this.hub(); break;
      case 'accept': this.picked = new Set(plan(this.runIndex, rc).party); this.briefing(); break;
      case 'setout': {
        const q = rc.nextQuest()!;
        rc.startRun(q.id, [...this.picked], this.o.auto ? plan(this.runIndex, rc).disposition : 'pragmatic');
        this.travel(); break;
      }
      case 'fight': this.fight(); break;
      case 'next': this.travel(); break;
      case 'home': this.home(); break;
      case 'journal': this.journal(); break;
    }
  }

  // ---- autoplay ---------------------------------------------------------------------------------

  /** Script a whole run: visit people, take the work, fight every stage, come home, hear the town. */
  autoplay(quick = false): void {
    const rc = this.o.rc;
    const S = (run: () => void, wait: number) => this.steps.push({ run, wait: quick ? Math.min(wait, 0.8) : wait });
    const talkers = quick ? [] : rc.save.runs === 0 ? ['marta', 'reeve'] : ['marta', 'anselm', 'tom', 'nan', 'hilde'];
    S(() => this.act('hub'), 2.5);
    if (rc.save.runs > 0) S(() => this.act('journal'), 7);
    if (rc.save.runs > 0) S(() => this.act('hub'), 1.5);
    for (const k of talkers) S(() => this.talkTo(k), 5.5);
    if (rc.save.runs > 0) S(() => { this.heardView = true; this.hub(); }, 5);
    const q = rc.nextQuest();
    if (!q) { S(() => this.o.onDone?.(), 1); return; }
    S(() => this.talkTo(q.giver), 6);
    S(() => this.act('accept'), 4.5);
    S(() => this.act('setout'), 5);
    for (let i = 0; i < q.stages.length; i++) {
      S(() => { if (rc.quest && !rc.runOver) this.act('fight'); }, 0);        // waits for the battle to end
      S(() => {}, 6.5);                                                     // aftermath on screen
      S(() => { if (rc.quest && !rc.runOver) this.act('next'); }, 4.5);
      if (i < q.stages.length - 1) continue;
    }
    S(() => { if (rc.quest) this.act('home'); }, 8);
    S(() => this.act('journal'), 9);
    S(() => this.act('hub'), 2);
    for (const k of ['marta', 'reeve', 'anselm', 'tom', 'nan'].filter((k) => k !== q.giver).slice(0, 3).concat([q.giver])) S(() => this.talkTo(k), 6);
    S(() => { this.heardView = true; this.hub(); }, 6);
    S(() => this.o.onDone?.(), 1);
  }

  tick(dt: number, battle: Battle | null, fxBusy = false): void {
    if (this.waitingBattle) {
      if (battle && battle.outcome && !fxBusy) { this.battleOverT += dt; if (this.o.auto && this.battleOverT > 3) this.battleDone(); }
      return;
    }
    if (!this.steps.length) return;
    this.stepT -= dt;
    if (this.stepT > 0) return;
    const s = this.steps.shift()!;
    // skip stage steps that no longer apply (the run ended early)
    s.run();
    this.stepT = s.wait;
  }
}

export const HP = TUNE.maxHealth;
