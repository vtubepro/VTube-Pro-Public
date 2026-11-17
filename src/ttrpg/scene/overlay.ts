// 2D broadcast overlay on the OBS page while a TTRPG session runs: live captions of whoever is speaking in-game (the
// GM / an NPC, revealed word by word), a roll card after each throw settles (who, what, the dice, total, vs DC,
// crits), the initiative strip, and the newest handout. Sized in vh so it is crisp at 720p–1440p; pointer-free.
import type { SceneTtrpgState, TtrpgRoll } from '../../../shared/ttrpg/state.ts';

const CSS = `
.tt-ov{position:fixed;inset:0;pointer-events:none;font-family:"Segoe UI",system-ui,sans-serif;z-index:20;--acc:#8fd3ff;color:#fff}
.tt-cap{position:absolute;left:50%;bottom:5.5vh;transform:translate(-50%,10px);max-width:72vw;min-width:22vw;padding:1.3vh 2.2vh 1.5vh;border-radius:1.6vh;
  background:linear-gradient(180deg,rgba(14,16,24,.86),rgba(8,9,14,.9));box-shadow:0 .8vh 3vh rgba(0,0,0,.45),inset 0 0 0 .2vh rgba(255,255,255,.08);opacity:0;transition:opacity .35s,transform .35s}
.tt-cap.on{opacity:1;transform:translate(-50%,0)}
.tt-cap .who{position:absolute;top:-1.9vh;left:2vh;padding:.35vh 1.2vh;border-radius:1vh;font-weight:800;font-size:1.7vh;letter-spacing:.06em;text-transform:uppercase;background:var(--acc);color:#07131a;box-shadow:0 .4vh 1.2vh rgba(0,0,0,.35)}
.tt-cap .txt{font-size:2.55vh;line-height:1.38;font-weight:600;text-shadow:0 .15vh .3vh rgba(0,0,0,.6)}
.tt-cap .txt .dim{opacity:.28}
.tt-cap.x{filter:saturate(0) brightness(.7)}
.tt-roll{position:absolute;left:3vh;bottom:18vh;min-width:24vh;padding:1.4vh 1.8vh;border-radius:1.6vh;background:rgba(10,12,18,.88);box-shadow:0 .8vh 3vh rgba(0,0,0,.45);
  border-left:.7vh solid var(--acc);opacity:0;transform:translateX(-3vh);transition:opacity .3s,transform .3s}
.tt-roll.on{opacity:1;transform:none}
.tt-roll .n{font-size:1.6vh;font-weight:700;opacity:.8;text-transform:uppercase;letter-spacing:.05em}
.tt-roll .l{font-size:2.1vh;font-weight:700;margin:.2vh 0 .6vh}
.tt-roll .row{display:flex;align-items:center;gap:1.2vh}
.tt-roll .tot{font-size:6vh;font-weight:900;line-height:1;min-width:6vh;text-align:center}
.tt-roll .dice{display:flex;flex-wrap:wrap;gap:.6vh;max-width:26vh}
.tt-roll .d{min-width:3.4vh;height:3.4vh;border-radius:.8vh;background:rgba(255,255,255,.12);display:grid;place-items:center;font-weight:800;font-size:1.8vh}
.tt-roll .d.drop{opacity:.35;text-decoration:line-through}
.tt-roll .res{margin-top:.8vh;font-weight:900;font-size:1.9vh;letter-spacing:.08em}
.tt-roll .ok{color:#5be38f}.tt-roll .no{color:#ff6b6b}
.tt-roll.hi{border-left-color:#ffd257;box-shadow:0 0 4vh rgba(255,210,87,.45)} .tt-roll.hi .tot{color:#ffd257}
.tt-roll.lo{border-left-color:#e0453a} .tt-roll.lo .tot{color:#ff7a70}
.tt-init{position:absolute;right:2.5vh;top:2.5vh;padding:1vh 1.2vh;border-radius:1.4vh;background:rgba(10,12,18,.82);min-width:18vh;opacity:0;transition:opacity .3s}
.tt-init.on{opacity:1}
.tt-init .h{font-size:1.5vh;font-weight:800;letter-spacing:.1em;opacity:.75;margin:0 .4vh .6vh;text-transform:uppercase}
.tt-init .e{display:flex;justify-content:space-between;gap:1.5vh;padding:.45vh .8vh;border-radius:.8vh;font-size:1.8vh;font-weight:600}
.tt-init .e.cur{background:var(--acc);color:#07131a;font-weight:800}
.tt-init .e .i{opacity:.7;font-variant-numeric:tabular-nums}
.tt-init .e.monster:not(.cur) .nm{color:#ff9a8f}
.tt-hand{position:absolute;right:4vh;top:50%;transform:translate(3vh,-50%);width:40vh;padding:2.4vh 2.6vh;border-radius:1vh;opacity:0;transition:opacity .4s,transform .4s;
  color:#3a2812;background:#efe0bb;box-shadow:0 1.2vh 4vh rgba(0,0,0,.5);font-family:Georgia,"Palatino Linotype",serif}
.tt-hand.on{opacity:1;transform:translate(0,-50%)}
.tt-hand h4{margin:0 0 1vh;font-size:2.6vh}
.tt-hand p{margin:0;font-size:1.95vh;line-height:1.45;white-space:pre-wrap}
.tt-hand.note{background:#fff7a8;font-family:"Segoe Print","Comic Sans MS",cursive}
.tt-hand.dossier{background:#e8e2d0;font-family:"Courier New",monospace}
.tt-hand.wanted{background:#e3c98f;text-align:center}
.tt-hand.wanted h4{font-size:4vh;letter-spacing:.1em}
.tt-hand.screen{background:#07131a;color:#9df0ff;font-family:Consolas,monospace;box-shadow:0 0 3vh rgba(80,220,255,.35)}
.tt-hand img{width:100%;border-radius:.6vh;margin-bottom:1vh}
`;

export class TableOverlay {
  readonly el: HTMLDivElement;
  private cap: HTMLDivElement; private capWho: HTMLDivElement; private capTxt: HTMLDivElement;
  private roll: HTMLDivElement; private init: HTMLDivElement; private hand: HTMLDivElement;
  private rollId = ''; private rollAt = 0;
  private initKey = ''; private handKey = ''; private handAt = 0;
  private capKey = '';

  constructor() {
    if (!document.getElementById('tt-ov-css')) { const s = document.createElement('style'); s.id = 'tt-ov-css'; s.textContent = CSS; document.head.append(s); }
    const div = (cls: string, parent?: HTMLElement) => { const d = document.createElement('div'); d.className = cls; parent?.append(d); return d; };
    this.el = div('tt-ov');
    this.cap = div('tt-cap', this.el); this.capWho = div('who', this.cap); this.capTxt = div('txt', this.cap);
    this.roll = div('tt-roll', this.el); this.init = div('tt-init', this.el); this.hand = div('tt-hand', this.el);
    document.body.append(this.el);
  }

  setAccent(color: string) { this.el.style.setProperty('--acc', color); }

  /** Captions: the line being spoken, with the not-yet-spoken words dimmed. */
  caption(on: boolean, who: string, text: string, spoken: number, x: boolean) {
    this.cap.classList.toggle('on', on && !!text);
    this.cap.classList.toggle('x', x);
    if (!on || !text) return;
    const key = `${who}|${text}|${spoken}`;
    if (key === this.capKey) return;
    this.capKey = key;
    this.capWho.textContent = who;
    const a = text.slice(0, spoken), b = text.slice(spoken);
    this.capTxt.textContent = '';
    this.capTxt.append(a);
    if (b) { const s = document.createElement('span'); s.className = 'dim'; s.textContent = b; this.capTxt.append(s); }
  }

  /** The roll card: shown once the dice have settled, for ~5.5 s. */
  rollCard(show: boolean, r: TtrpgRoll | null, now: number) {
    if (show && r && r.id !== this.rollId) {
      this.rollId = r.id; this.rollAt = now;
      this.roll.className = `tt-roll ${r.crit ?? ''}`;
      this.roll.textContent = '';
      const add = (cls: string, text: string, parent: HTMLElement = this.roll) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; parent.append(d); return d; };
      add('n', r.name || r.who);
      add('l', `${r.label || 'Roll'} · ${r.expr}`);
      const row = add('row', '');
      add('tot', r.secret ? '?' : String(r.total), row);
      const dice = add('dice', '', row);
      if (!r.secret) for (const d of r.dice.slice(0, 16)) add(`d${d.k === false ? ' drop' : ''}`, String(d.v), dice);
      if (r.secret) add('res', 'rolled behind the GM screen');
      else if (r.crit === 'hi') add('res ok', 'NATURAL 20!');
      else if (r.crit === 'lo') add('res no', 'NATURAL 1');
      else if (typeof r.dc === 'number') add(`res ${r.total >= r.dc ? 'ok' : 'no'}`, `${r.total >= r.dc ? 'SUCCESS' : 'FAIL'} vs ${r.dc}`);
    }
    this.roll.classList.toggle('on', show && !!r && now - this.rollAt < 5500);
  }

  initiative(st: SceneTtrpgState) {
    const it = st.init;
    const on = st.overlay.init && it.on && it.order.length > 0;
    this.init.classList.toggle('on', on);
    if (!on) return;
    const key = JSON.stringify([it.round, it.turn, it.order]);
    if (key === this.initKey) return;
    this.initKey = key;
    this.init.textContent = '';
    const h = document.createElement('div'); h.className = 'h'; h.textContent = `Round ${it.round}`; this.init.append(h);
    it.order.slice(0, 12).forEach((e, i) => {
      const row = document.createElement('div'); row.className = `e ${e.kind}${i === it.turn ? ' cur' : ''}`;
      const n = document.createElement('span'); n.className = 'nm'; n.textContent = e.name;
      const v = document.createElement('span'); v.className = 'i'; v.textContent = String(e.init);
      row.append(n, v); this.init.append(row);
    });
  }

  handout(st: SceneTtrpgState, now: number, img: (id: string) => string | null) {
    const h = st.handout;
    const key = h ? `${h.id}|${h.at}` : '';
    if (key !== this.handKey) {
      this.handKey = key; this.handAt = now;
      this.hand.textContent = '';
      if (h) {
        this.hand.className = `tt-hand ${h.style ?? 'parchment'}`;
        const url = h.img ? img(h.img) : null;
        if (url) { const i = document.createElement('img'); i.src = url; this.hand.append(i); }
        const t = document.createElement('h4'); t.textContent = h.title; this.hand.append(t);
        if (h.text) { const p = document.createElement('p'); p.textContent = h.text; this.hand.append(p); }
      }
    }
    this.hand.classList.toggle('on', !!h && now - this.handAt < 12000);
  }

  hideAll() { for (const e of [this.cap, this.roll, this.init, this.hand]) e.classList.remove('on'); }
  dispose() { this.el.remove(); }
}
