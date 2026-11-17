// The Trail v2 — the journey HUD (DOM over the canvas, next to hud.ts): compass + the next stop, clock (sun / moon),
// the driver's dash (speed, surface, "BOGGED: push!" meter), the fork signpost as you approach it, camp goals with
// world-anchored task markers (progress rings, the rhythm band pulse), meme banners, the emote wheel (hold G).
// Spectator (OBS) mode shows the stream-friendly bits bigger and skips the controls.
import * as THREE from 'three';
import type { CampTask, GameState, JourneyState } from '../../../../shared/trail/types.ts';
import type { TrailCmd, TrailEvent } from '../../../../shared/trail/wire.ts';

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const EMOTES: { id: string; icon: string; label: string }[] = [
  { id: 'wave', icon: '👋', label: 'Wave' }, { id: 'dance', icon: '💃', label: 'Dance' }, { id: 'point', icon: '👉', label: 'Point' }, { id: 'facepalm', icon: '🤦', label: 'Facepalm' },
  { id: 'cheer', icon: '🙌', label: 'Cheer' }, { id: 'laugh', icon: '😂', label: 'Laugh' }, { id: 'sit', icon: '🪑', label: 'Sit' }, { id: 'soundbite', icon: '📣', label: 'Soundbite' },
];
const TASK_ICON: Record<string, string> = { fire: '🔥', food: '🍲', tent: '⛺', draft: '🐸', wheel: '🔧', watch: '🏮' };
const SURFACE: Record<string, string> = { road: 'road', grass: 'off-road', mud: 'MUD', water: 'fording', void: 'the edge' };

export class JourneyHud {
  readonly root: HTMLElement;
  private compass = h('div', 'tj-compass');
  private compassStrip = h('div', 'tj-strip');
  private goal = h('div', 'tj-goal');
  private clock = h('div', 'tj-clock');
  private dash = h('div', 'tj-dash');
  private fork = h('div', 'tj-fork');
  private camp = h('div', 'tj-camp');
  private markers = h('div', 'tj-markers');
  private meme = h('div', 'tj-meme');
  private wheel = h('div', 'tj-wheel');
  private bubbles = h('div', 'tj-bubbles');
  private jbox = h('div', 'tj-j');
  private cargo = h('div', 'tj-cargo');
  private taskEls = new Map<string, HTMLElement>();
  private memeUntil = 0;
  private wheelOpen = false;
  private wheelSel = -1;
  private wheelMouse = { x: 0, y: 0 };
  private sig = '';
  private v = new THREE.Vector3();
  private bubbleList: { who: string; el: HTMLElement; until: number }[] = [];

  constructor(parent: HTMLElement, private o: { cmd(c: TrailCmd): void; myId(): string; spectator: boolean }) {
    injectCss();
    this.compass.append(this.compassStrip, h('i', 'tj-needle'));
    this.jbox.append(this.compass, this.goal, this.clock, this.dash, this.fork, this.camp);
    this.root = h('div', `tj-hud${o.spectator ? ' tj-spect' : ''}`, this.markers, this.bubbles, this.jbox, this.cargo, this.meme, this.wheel);
    parent.append(this.root);
    // compass strip: N E S W ticks, repeated so it can scroll
    const marks = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
    for (let r = 0; r < 3; r++) for (const m of marks) this.compassStrip.append(h('span', m.length > 1 || m === '·' ? '' : 'big', m));
    this.wheel.append(...EMOTES.map((e, i) => { const b = h('div', 'tj-wopt', h('b', '', e.icon), h('small', '', e.label)); const a = (i / EMOTES.length) * Math.PI * 2 - Math.PI / 2; b.style.left = `${50 + Math.cos(a) * 38}%`; b.style.top = `${50 + Math.sin(a) * 38}%`; return b; }), h('div', 'tj-whint', 'release to emote'));
    window.addEventListener('mousemove', (e) => { if (this.wheelOpen) { this.wheelMouse.x += e.movementX; this.wheelMouse.y += e.movementY; this.pickWheel(); } });
  }
  /** Hold G: open; release: send the picked emote. */
  emoteWheel(on: boolean) {
    if (this.o.spectator) return;
    if (on && !this.wheelOpen) { this.wheelOpen = true; this.wheelSel = -1; this.wheelMouse = { x: 0, y: 0 }; this.wheel.classList.add('on'); this.pickWheel(); }
    else if (!on && this.wheelOpen) { this.wheelOpen = false; this.wheel.classList.remove('on'); if (this.wheelSel >= 0) this.o.cmd({ c: 'emote', id: EMOTES[this.wheelSel].id }); }
  }
  get wheelActive() { return this.wheelOpen; }
  private pickWheel() {
    const { x, y } = this.wheelMouse;
    this.wheelSel = Math.hypot(x, y) < 25 ? -1 : Math.round(((Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * EMOTES.length) % EMOTES.length;
    [...this.wheel.querySelectorAll('.tj-wopt')].forEach((el, i) => el.classList.toggle('sel', i === this.wheelSel));
  }

  event(e: TrailEvent, nameOf: (id: string) => string) {
    if (e.e === 'meme') {
      this.meme.className = `tj-meme on ${e.tier}`;
      this.meme.replaceChildren(h('small', '', e.tier === 'legendary' ? 'LEGENDARY MEME' : e.tier === 'rare' ? 'RARE MEME' : 'meme'), h('b', '', e.text));
      this.memeUntil = performance.now() + (e.tier === 'common' ? 3500 : 6000);
    } else if (e.e === 'emote') {
      const em = EMOTES.find((x) => x.id === e.id);
      const el = h('div', 'tj-bubble', h('b', '', em?.icon ?? '❗'), h('small', '', `${nameOf(e.who)}`));
      this.bubbles.append(el);
      this.bubbleList.push({ who: e.who, el, until: performance.now() + 2600 });
    }
  }

  /** Per frame: `project` maps a LOCAL world point to CSS pixels (null = behind the camera). */
  /** `camYaw` = the camera's compass bearing (rad). */
  update(st: GameState | null, now: number, camYaw: number, project: (p: THREE.Vector3) => { x: number; y: number } | null, headOf: (id: string) => THREE.Vector3 | null, hostT: number) {
    const J: JourneyState | undefined = st?.journey;
    const on = !!J && (st!.phase === 'travel' || st!.stop?.kind === 'camp' || (st!.phase === 'stop' && st!.stop?.kind === 'event'));
    this.jbox.classList.toggle('on', on);
    // the wagon's load (near the wagon / carrying something): slots, weight, what's aboard
    const cg = st?.cargo;
    if (cg && this.cargoShown) {
      const sig = JSON.stringify(cg);
      if (this.cargo.dataset.sig !== sig) {
        this.cargo.dataset.sig = sig;
        const full = cg.used >= cg.cap;
        this.cargo.replaceChildren(h('b', '', `🧺 Wagon ${cg.used}/${cg.cap}${full ? ' — FULL' : ''}`), h('div', 'tr-bar', h('i', '', '')), h('small', '', `${cg.kg} kg aboard · drop things at the wagon to load · hold E at the back: load everything nearby${cg.ramp ? ' · ramp down' : ''}`),
          h('div', 'tj-citems', ...Object.entries(cg.items).map(([k, n]) => h('span', '', `${k} ×${n}`))));
        const bar = this.cargo.querySelector('i') as HTMLElement; bar.style.width = `${Math.round(cg.used / Math.max(1, cg.cap) * 100)}%`; bar.style.background = full ? '#e0523d' : '';
      }
      this.cargo.classList.add('on');
    } else this.cargo.classList.remove('on');
    if (!on || !J || !st) { this.clearMarkers(); if (!this.o.spectator) this.updateBubbles(now, project, headOf); return; }
    const me = this.o.myId();
    const driving = J.driver === me;
    // compass: the camera's bearing (0 = +Z = north, 90 = +X = east); the ◆ = the way to the next stop / camp spot
    const deg = ((camYaw * 180 / Math.PI) % 360 + 360) % 360;
    this.compassStrip.style.transform = `translateX(${150 - (544 + (deg / 22.5) * 34 + 17)}px)`;
    const goalDeg = J.goal !== undefined ? ((J.goal * 180 / Math.PI) % 360 + 360) % 360 : null;
    const rel = goalDeg === null ? null : ((goalDeg - deg + 540) % 360) - 180;
    this.compass.style.setProperty('--goal', rel === null ? '-999px' : `${Math.max(-140, Math.min(140, rel * 34 / 22.5))}px`);
    const goalTxt = J.campDist !== undefined ? `⛺ Camp spot · ${J.campDist} m` : J.next ? `${J.next} · ${J.nextDist >= 1000 ? (J.nextDist / 1000).toFixed(1) + ' km' : J.nextDist + ' m'}` : '';
    if (this.goal.textContent !== goalTxt) this.goal.textContent = goalTxt;
    // clock
    const night = J.tod > 0.8 || J.tod < 0.2;
    const hh = Math.floor(((J.tod * 24) + 24) % 24), mm = Math.floor((J.tod * 24 * 60) % 60);
    const ct = `${night ? '🌙' : J.tod > 0.72 ? '🌇' : J.tod < 0.3 ? '🌅' : '☀️'} ${String(hh).padStart(2, '0')}:${String(Math.floor(mm / 15) * 15).padStart(2, '0')} · day ${st.run?.day ?? 0}`;
    if (this.clock.textContent !== ct) this.clock.textContent = ct;
    // driver's dash / pushing
    const dashSig = `${driving}|${J.speed}|${J.surface}|${J.bogged}|${Math.round(J.push * 20)}|${J.driver}`;
    if (dashSig !== this.sig) {
      this.sig = dashSig;
      const kids: Node[] = [];
      if (driving) kids.push(h('div', 'tj-speed', h('b', '', String(Math.round(Math.abs(J.speed) * 2.24))), h('small', '', 'mph')), h('div', 'tj-surf' + (J.surface === 'mud' || J.surface === 'water' ? ' warn' : ''), SURFACE[J.surface] ?? J.surface), h('div', 'tj-keys', 'W/S drive · A/D steer · Shift whip · Space brake · E get off'));
      else if (st.phase === 'travel') kids.push(h('div', 'tj-drv', J.driver ? `🧑‍🌾 ${st.players.find((p) => p.id === J.driver)?.name ?? 'someone'} is driving` : '🐾 the animals know the way — E at the front bench to drive'));
      if (J.bogged) kids.push(h('div', 'tj-bog', h('b', '', 'BOGGED!'), h('small', '', 'everyone push from behind (walk into the back)'), h('div', 'tr-bar', h('i', '', '')) as HTMLElement));
      this.dash.replaceChildren(...kids);
      const bar = this.dash.querySelector('.tj-bog .tr-bar i') as HTMLElement | null;
      if (bar) bar.style.width = `${Math.round(J.push * 100)}%`;
      this.dash.classList.toggle('driving', driving);
    }
    // the fork signpost
    const f = J.fork;
    if (f && f.dist < 110 && st.phase === 'travel') {
      const left = f.alt > 0 ? f.labels[1] : f.labels[0], right = f.alt > 0 ? f.labels[0] : f.labels[1];
      const fs = `${left}|${right}|${Math.round(f.dist / 10)}`;
      if (this.fork.dataset.sig !== fs) { this.fork.dataset.sig = fs; this.fork.replaceChildren(h('small', '', `FORK IN THE ROAD · ${f.dist} m`), h('div', 'tj-forks', h('span', 'l', `⬅ ${left}`), h('span', 'r', `${right} ➡`)), h('small', 'tj-fhint', driving ? 'steer into the branch you want' : 'the driver picks — shout at them')); }
      this.fork.classList.add('on');
    } else this.fork.classList.remove('on');
    // camp goals + world markers
    const C = J.camp;
    if (C) {
      const rows = C.tasks.map((t) => h('div', 'tj-task' + (t.progress >= 0.99 ? ' done' : ''), h('span', '', `${TASK_ICON[t.icon] ?? '•'} ${t.label}`), h('div', 'tr-bar', h('i', '', '')), t.who.length ? h('small', '', t.who.map((id) => st.players.find((p) => p.id === id)?.name ?? '').filter(Boolean).join(', ')) : null));
      rows.forEach((r, i) => { (r.querySelector('i') as HTMLElement).style.width = `${Math.round(C.tasks[i].progress * 100)}%`; });
      this.camp.replaceChildren(h('b', '', C.night ? '🌙 Night — guard the camp' : '⛺ Camp'), ...rows);
      this.camp.classList.add('on');
      this.placeMarkers(C.tasks, project, hostT, !this.o.spectator);
    } else { this.camp.classList.remove('on'); this.clearMarkers(); }
    // meme banner
    if (now > this.memeUntil) this.meme.classList.remove('on');
    this.updateBubbles(now, project, headOf);
  }
  /** Show the wagon's load panel (the view decides: near the wagon or carrying cargo). */
  cargoShown = false;
  private updateBubbles(now: number, project: (p: THREE.Vector3) => { x: number; y: number } | null, headOf: (id: string) => THREE.Vector3 | null) {
    // emote bubbles over heads
    this.bubbleList = this.bubbleList.filter((b) => { if (now > b.until) { b.el.remove(); return false; } return true; });
    for (const b of this.bubbleList) {
      const p = headOf(b.who);
      const s = p ? project(p) : null;
      b.el.style.display = s ? '' : 'none';
      if (s) b.el.style.transform = `translate(${s.x}px, ${s.y - 30 - (1 - (b.until - now) / 2600) * 30}px)`;
    }
  }
  private placeMarkers(tasks: CampTask[], project: (p: THREE.Vector3) => { x: number; y: number } | null, hostT: number, showBand: boolean) {
    const seen = new Set<string>();
    for (const t of tasks) {
      seen.add(t.id);
      let el = this.taskEls.get(t.id);
      if (!el) { el = h('div', 'tj-mark', h('i', 'ring'), h('b', '', TASK_ICON[t.icon] ?? '•'), h('small', '', t.label)); this.taskEls.set(t.id, el); this.markers.append(el); }
      const s = project(this.v.set(t.p[0], t.p[1] + 1.6, t.p[2]));
      el.style.display = s ? '' : 'none';
      if (!s) continue;
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
      el.style.setProperty('--p', `${Math.round(t.progress * 100)}%`);
      // the rhythm band (hold E while it glows): computed from the host clock like the sim does
      const band = t.ph !== undefined && Math.sin((hostT / 1.6 + t.ph) * Math.PI * 2) > 0.22;
      el.classList.toggle('band', showBand && t.ph !== undefined && band && !t.id.startsWith('fire') && t.id !== 'watch');
      el.classList.toggle('done', t.progress >= 0.99);
    }
    for (const [id, el] of this.taskEls) if (!seen.has(id)) { el.remove(); this.taskEls.delete(id); }
  }
  private clearMarkers() { for (const el of this.taskEls.values()) el.remove(); this.taskEls.clear(); }
  dispose() { this.root.remove(); }
}

let css = false;
function injectCss() {
  if (css) return; css = true;
  const s = document.createElement('style');
  s.textContent = `
.tj-hud{position:absolute;inset:0;pointer-events:none;font-family:Bahnschrift,"Segoe UI",system-ui,sans-serif;color:#fff;user-select:none;--tr-accent:#e8a33d;--tr-good:#8fd16a;--tr-danger:#e0523d}
.tj-hud .tr-bar{height:7px;background:rgba(255,255,255,.1);border-radius:4px;overflow:hidden}.tj-hud .tr-bar i{display:block;height:100%;background:var(--tr-accent);transition:width .2s}
.tj-j{display:none}.tj-j.on{display:block}
.tj-cargo{position:absolute;left:14px;bottom:70px;width:300px;background:rgba(8,10,12,.66);border-radius:14px;padding:8px 12px;display:none;flex-direction:column;gap:4px;border-left:3px solid #e8a33d}.tj-cargo.on{display:flex}
.tj-cargo b{font-size:14px}.tj-cargo small{font-size:11px;opacity:.7}.tj-citems{display:flex;flex-wrap:wrap;gap:4px}.tj-citems span{font-size:11px;background:rgba(255,255,255,.1);border-radius:6px;padding:1px 6px}
.tj-compass{position:absolute;left:50%;top:62px;width:300px;height:30px;transform:translateX(-50%);overflow:hidden;background:rgba(8,10,12,.55);border-radius:10px;--goal:-999px;-webkit-mask-image:linear-gradient(90deg,transparent,#000 18%,#000 82%,transparent)}
.tj-strip{position:absolute;left:0;top:0;height:30px;display:flex;white-space:nowrap}
.tj-strip span{display:inline-block;width:34px;text-align:center;line-height:30px;font-size:12px;opacity:.7}.tj-strip span.big{font-weight:900;opacity:1;font-size:14px}
.tj-needle{position:absolute;left:50%;top:0;width:2px;height:30px;background:rgba(255,255,255,.5)}
.tj-compass::after{content:'◆';position:absolute;top:5px;left:calc(50% + var(--goal) - 7px);color:#ffd23f;font-size:14px;text-shadow:0 0 6px #000}
.tj-goal{position:absolute;left:50%;top:96px;transform:translateX(-50%);font-size:13px;font-weight:700;background:rgba(8,10,12,.5);padding:3px 10px;border-radius:8px;white-space:nowrap}
.tj-clock{position:absolute;right:14px;bottom:14px;font-size:14px;font-weight:700;background:rgba(8,10,12,.55);padding:5px 10px;border-radius:10px}
.tj-dash{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px}
.tj-speed{display:flex;align-items:baseline;gap:4px;background:rgba(8,10,12,.62);padding:4px 16px;border-radius:14px}.tj-speed b{font-size:34px;font-variant-numeric:tabular-nums}.tj-speed small{opacity:.7}
.tj-surf{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;opacity:.8}.tj-surf.warn{color:#ffb050;opacity:1}
.tj-keys{font-size:11px;opacity:.55}.tj-drv{font-size:13px;background:rgba(8,10,12,.5);padding:4px 10px;border-radius:10px;opacity:.85}
.tj-bog{background:rgba(120,60,20,.85);border:2px solid #ffb050;padding:8px 16px;border-radius:14px;text-align:center;min-width:280px;animation:tjp .6s infinite alternate}.tj-bog b{font-size:20px;display:block}.tj-bog small{opacity:.85}
@keyframes tjp{to{transform:scale(1.04)}}
.tj-fork{position:absolute;left:50%;top:128px;transform:translateX(-50%) translateY(-10px);opacity:0;transition:all .3s;background:rgba(40,28,14,.88);border:2px solid #c89a5a;border-radius:14px;padding:8px 16px;text-align:center;min-width:420px}
.tj-fork.on{opacity:1;transform:translateX(-50%)}
.tj-fork small{font-size:11px;letter-spacing:.1em;opacity:.8}.tj-forks{display:flex;justify-content:space-between;gap:18px;margin:4px 0;font-weight:800;font-size:16px}.tj-forks .l{color:#b8ff9a}.tj-forks .r{color:#ffcf8a}.tj-fhint{display:block}
.tj-camp{position:absolute;right:14px;top:290px;width:250px;background:rgba(8,10,12,.62);border-radius:14px;padding:8px 12px;display:none;flex-direction:column;gap:5px}.tj-camp.on{display:flex}
.tj-camp>b{font-size:15px}.tj-task{font-size:12px}.tj-task .tr-bar{height:5px;margin-top:3px}.tj-task small{opacity:.6;font-size:10px}.tj-task.done{opacity:.55}
.tj-markers,.tj-bubbles{position:absolute;inset:0;overflow:hidden}
.tj-mark{position:absolute;left:-26px;top:-26px;width:52px;height:52px;display:grid;place-items:center;--p:0%}
.tj-mark .ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(#ffd23f var(--p),rgba(255,255,255,.18) 0);-webkit-mask:radial-gradient(circle,transparent 58%,#000 60%);mask:radial-gradient(circle,transparent 58%,#000 60%)}
.tj-mark b{font-size:22px;filter:drop-shadow(0 1px 2px #000)}.tj-mark small{position:absolute;top:54px;white-space:nowrap;font-size:11px;font-weight:700;text-shadow:0 1px 3px #000}
.tj-mark.band .ring{box-shadow:0 0 0 4px rgba(143,209,106,.9),0 0 18px #8fd16a}.tj-mark.band b{transform:scale(1.2)}.tj-mark.done .ring{background:#8fd16a}
.tj-meme{position:absolute;left:50%;top:150px;transform:translateX(-50%) scale(.8);opacity:0;transition:all .25s cubic-bezier(.2,1.6,.4,1);text-align:center;padding:8px 18px;border-radius:14px;background:rgba(8,10,12,.75);max-width:70%}
.tj-meme.on{opacity:1;transform:translateX(-50%) scale(1)}
.tj-meme small{display:block;font-size:10px;letter-spacing:.2em;opacity:.7}.tj-meme b{font-size:18px}
.tj-meme.rare{background:linear-gradient(90deg,#5a2ad8,#b04ad8);font-size:1.1em}.tj-meme.legendary{background:linear-gradient(90deg,#d88a1a,#ffd23f,#d88a1a);color:#1a1000;animation:tjp .4s infinite alternate}.tj-meme.legendary b{font-size:24px}
.tj-wheel{position:absolute;left:50%;top:50%;width:320px;height:320px;transform:translate(-50%,-50%) scale(.6);opacity:0;transition:all .15s;border-radius:50%;background:radial-gradient(circle,rgba(8,10,12,.2) 25%,rgba(8,10,12,.72) 26%)}
.tj-wheel.on{opacity:1;transform:translate(-50%,-50%) scale(1)}
.tj-wopt{position:absolute;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;padding:6px;border-radius:12px;transition:transform .1s}.tj-wopt b{font-size:30px}.tj-wopt small{font-size:11px}.tj-wopt.sel{background:rgba(255,210,63,.35);transform:translate(-50%,-50%) scale(1.2)}
.tj-whint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:11px;opacity:.6}
.tj-bubble{position:absolute;left:-30px;top:-30px;width:60px;text-align:center;animation:trin .2s}.tj-bubble b{font-size:32px;display:block;filter:drop-shadow(0 2px 3px #000)}.tj-bubble small{font-size:10px;text-shadow:0 1px 2px #000}
.tr-hud.v2drive .tr-card{top:24%;transform:translate(-50%,-50%) scale(.8)}.tr-hud.v2drive .tr-vote{bottom:118px;width:min(640px,86vw)}.tr-hud.v2drive .tr-stop{top:132px}
.tj-spect .tj-dash .tj-keys,.tj-spect .tj-fhint{display:none}.tj-spect .tj-meme b{font-size:26px}.tj-spect .tj-fork{top:110px;transform:translateX(-50%) scale(1.15)}
`;
  document.head.append(s);
}
