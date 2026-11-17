// The stage layout's crisp 2D parts, as DOM over the 3D canvas (the OBS browser source captures them like the canvas):
// performer name tags, the docked chat / support panels (the in-world props' own canvases, src/chat/chatCanvas.ts), a
// wide "support strip" for short bands, and the line-up test label. Positions are fractions of the frame; the panels'
// canvases are sized to their on-screen pixels (crisp at 1080p / 1440p) and only redrawn when the feed changes.
import { DEFAULT_CHAT_STATE, chatAlerts, type ChatEvent, type SceneChatState } from '../../../shared/chat.ts';
import { samePalette, type Rect, type StagePalette } from '../../../shared/stage.ts';
import { ChatCanvas } from '../../chat/chatCanvas.ts';
import type { ChatFeed } from '../../chat/feed.ts';
import { SupportStrip } from './supportStrip.ts';

const CSS = `
#vtp-stage { position:fixed; inset:0; pointer-events:none; z-index:40; overflow:hidden; font-family:"Segoe UI",Inter,system-ui,sans-serif; }
#vtp-stage .vs-tag { position:absolute; display:flex; align-items:center; gap:.45em; max-width:94%; box-sizing:border-box; white-space:nowrap;
  padding:.28em .75em .3em .6em; border-radius:999px; color:var(--ink); background:linear-gradient(180deg,var(--glass2),var(--glass));
  border:1px solid var(--acc-a); box-shadow:0 2px 10px #0009, 0 0 0 1px #0006 inset; font-weight:800; letter-spacing:.01em; transform-origin:0 100%; transition:opacity .25s; }
#vtp-stage .vs-tag.hero { border-color:var(--hero); }
#vtp-stage .vs-tag .nm { overflow:hidden; text-overflow:ellipsis; text-shadow:0 1px 2px #000c; }
#vtp-stage .vs-tag .cr { color:var(--hero); filter:drop-shadow(0 0 4px var(--hero)); }
#vtp-stage .vs-tag .bars { display:inline-flex; gap:2px; align-items:flex-end; height:.8em; }
#vtp-stage .vs-tag .bars i { width:3px; border-radius:2px; background:var(--acc2); height:30%; transition:height .08s; }
#vtp-stage .vs-tag .sub { font-weight:600; opacity:.7; font-size:.8em; }
#vtp-stage .vs-dock { position:absolute; box-sizing:border-box; border-radius:14px; overflow:hidden; background:var(--glass);
  box-shadow:0 0 0 2px var(--acc-a), 0 10px 28px #000a; transition:opacity .35s, box-shadow .3s; }
#vtp-stage .vs-dock canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
#vtp-stage .vs-dock.alert { box-shadow:0 0 0 3px var(--hero), 0 0 38px var(--hero); }
#vtp-stage .vs-test { position:absolute; transform:translate(-50%,-50%); padding:.6em 1em; border-radius:10px; background:#101418e6; color:#fff;
  border:2px solid #ff40cc; font-weight:700; text-align:center; line-height:1.35; box-shadow:0 6px 24px #000a; }
#vtp-stage .vs-test b { color:#39ff9c; }
`;

interface TagEl { el: HTMLDivElement; nm: HTMLSpanElement; sub: HTMLSpanElement; bars: HTMLElement[]; key: string }

export interface TagSpec { key: string; name: string; rect: Rect; where: 'below' | 'inside'; hero: boolean; speak: number; alpha: number; sub?: string }

export class StageDom {
  readonly root: HTMLDivElement;
  private tags = new Map<string, TagEl>();
  private chatBox: HTMLDivElement; private supBox: HTMLDivElement;
  private chat = new ChatCanvas('monitor', 360, 640);
  private board = new ChatCanvas('board', 640, 360);
  private strip = new SupportStrip();
  private test: HTMLDivElement;
  private palSnap: StagePalette | null = null;
  private alerts: ChatEvent[] = [];
  private alertAt = 0;
  private supWide = false;
  private off: () => void;
  /** Docked chat text size × (SceneStageState.chatText). */
  chatText = 1;
  /** Docked chat box opacity (SceneStageState.chatBox.opacity, shared/chatBox.ts). */
  chatOpacity = 1;
  /** Which docks are showing (0..1 each). */
  shown = { chat: 0, support: 0 };
  /** The layout look's docked-panel opacity (shared/layoutLook.ts `panels`). */
  dockOpacity = 1;
  /** The compositor's fade of each dock while it jumps to a far-away place (0..1). */
  fade = { chat: 1, support: 1 };

  constructor(private feed: ChatFeed, private state: () => SceneChatState | undefined) {
    if (!document.getElementById('vtp-stage-css')) { const s = document.createElement('style'); s.id = 'vtp-stage-css'; s.textContent = CSS; document.head.append(s); }
    this.root = document.createElement('div');
    this.root.id = 'vtp-stage';
    this.root.setAttribute('aria-hidden', 'true');
    document.body.append(this.root);
    this.chatBox = this.dock(); this.chatBox.append(this.chat.canvas);
    this.supBox = this.dock(); this.supBox.append(this.board.canvas, this.strip.canvas);
    this.test = document.createElement('div'); this.test.className = 'vs-test'; this.test.style.display = 'none';
    this.test.innerHTML = 'VTube Pro <b>line-up test</b><br>Your game / window / display capture should fill the box exactly:<br>its edges on the pink line, no gaps, nothing past it.';
    this.root.append(this.test);
    // support alerts → the docked support panel (a card + a glow), one at a time
    this.off = feed.on((fresh, snap) => {
      if (snap) return;
      const st = this.state() ?? DEFAULT_CHAT_STATE;
      for (const e of fresh) if (chatAlerts(e, st)) { this.alerts.push(e); if (this.alerts.length > 12) this.alerts.shift(); }
    });
  }

  private dock() { const d = document.createElement('div'); d.className = 'vs-dock'; d.style.opacity = '0'; d.style.display = 'none'; this.root.append(d); return d; }

  setLive(live: Record<string, boolean>) { this.chat.live = live; this.board.live = live; }

  setPalette(p: StagePalette) {
    if (samePalette(this.palSnap, p)) return;
    this.palSnap = { ...p };   // (a copy: stagePalette hands out a fresh object per call for a scene's own colours)
    const s = this.root.style;
    s.setProperty('--ink', p.ink); s.setProperty('--glass', `${p.glass}ee`); s.setProperty('--glass2', `${p.glass}cc`);
    s.setProperty('--acc', p.accent); s.setProperty('--acc-a', `${p.accent}88`); s.setProperty('--acc2', p.accent2); s.setProperty('--hero', p.hero);
    this.strip.palette = p;
  }

  private place(el: HTMLElement, r: Rect) {
    el.style.left = `${(r.x * 100).toFixed(3)}%`; el.style.top = `${(r.y * 100).toFixed(3)}%`;
    el.style.width = `${(r.w * 100).toFixed(3)}%`; el.style.height = `${(r.h * 100).toFixed(3)}%`;
  }

  /** Name tags (inside the tile's bottom-left, or just under it). */
  tagsFor(list: TagSpec[], frameH: number) {
    const keep = new Set(list.map((t) => t.key));
    for (const [k, t] of this.tags) if (!keep.has(k)) { t.el.remove(); this.tags.delete(k); }
    const fs = Math.max(11, Math.round(frameH * 0.0185));
    for (const t of list) {
      let e = this.tags.get(t.key);
      if (!e) {
        const el = document.createElement('div'); el.className = 'vs-tag';
        const cr = document.createElement('span'); cr.className = 'cr'; cr.textContent = '♛';
        const nm = document.createElement('span'); nm.className = 'nm';
        const sub = document.createElement('span'); sub.className = 'sub';
        const bw = document.createElement('span'); bw.className = 'bars';
        const bars = [0, 1, 2].map(() => { const i = document.createElement('i'); bw.append(i); return i; });
        el.append(cr, nm, sub, bw);
        this.root.append(el);
        e = { el, nm, sub, bars, key: t.key };
        this.tags.set(t.key, e);
      }
      e.el.classList.toggle('hero', t.hero);
      (e.el.firstChild as HTMLElement).style.display = t.hero ? '' : 'none';
      if (e.nm.textContent !== t.name) e.nm.textContent = t.name;
      const sub = t.sub ?? '';
      if (e.sub.textContent !== sub) e.sub.textContent = sub;
      e.el.style.fontSize = `${fs}px`;
      const inset = Math.round(fs * 0.55);
      e.el.style.left = `calc(${(t.rect.x * 100).toFixed(3)}% + ${inset}px)`;
      e.el.style.maxWidth = `calc(${(t.rect.w * 100).toFixed(3)}% - ${inset * 2}px)`;
      e.el.style.top = t.where === 'inside' ? `calc(${((t.rect.y + t.rect.h) * 100).toFixed(3)}% - ${Math.round(fs * 2.2 + inset * 0.6)}px)` : `calc(${((t.rect.y + t.rect.h) * 100).toFixed(3)}% + 6px)`;
      e.el.style.opacity = String(Math.max(0, Math.min(1, t.alpha)));
      const sp = Math.max(0, Math.min(1, t.speak));
      e.bars.forEach((b, i) => { b.style.height = `${Math.round(25 + 75 * sp * [0.7, 1, 0.55][i] * (0.75 + 0.25 * Math.sin(performance.now() / (90 + i * 37))))}%`; });
      (e.bars[0].parentElement as HTMLElement).style.opacity = sp > 0.08 ? '1' : '0.25';
    }
  }

  /** Docked panels (null = hidden, fades out). `px` = device px of the frame (canvas sizing). */
  docks(chat: Rect | null, support: Rect | null, frameW: number, frameH: number, dt: number) {
    const st = this.state() ?? DEFAULT_CHAT_STATE;
    const now = Date.now();
    const step = (box: HTMLDivElement, r: Rect | null, cur: number, alpha = 1, fade = 1) => {
      const want = r ? 1 : 0;
      const v = want > cur ? Math.min(1, cur + dt / 0.35) : want < cur ? Math.max(0, cur - dt / 0.3) : cur;
      if (r) this.place(box, r);
      box.style.display = v > 0 ? '' : 'none';
      box.style.opacity = (v * alpha * this.dockOpacity * fade).toFixed(3);
      return v;
    };
    this.shown.chat = step(this.chatBox, chat, this.shown.chat, Math.max(0.3, Math.min(1, this.chatOpacity)), this.fade.chat);
    this.shown.support = step(this.supBox, support, this.shown.support, 1, this.fade.support);
    const dpr = window.devicePixelRatio || 1;
    // ≈ 18.5 px at 1080p × the Scene tab's "Chat text size", whatever the dock's size (the in-world monitor is separate)
    const textPx = Math.round(frameH * dpr * 0.0172 * Math.min(1.6, Math.max(0.6, this.chatText)));
    if (chat && this.shown.chat > 0) {
      const W = Math.max(64, Math.round(chat.w * frameW * dpr)), H = Math.max(64, Math.round(chat.h * frameH * dpr));
      this.chat.resize(W, H);
      this.chat.textRefW = (textPx * 600) / 29 / Math.max(0.5, st.font || 1);
      this.chat.update(this.feed, { ...st, panel: 'off' }, now);
    }
    // alerts, one at a time (7.5 s each)
    if (this.alerts.length && now - this.alertAt > 7500) {
      const e = this.alerts.shift()!;
      this.alertAt = now;
      this.board.alert = { e, at: now }; this.strip.alert = { e, at: now };
    }
    this.supBox.classList.toggle('alert', !!this.board.alert && now - this.board.alert.at < 8000);
    if (support && this.shown.support > 0) {
      const W = Math.max(64, Math.round(support.w * frameW * dpr)), H = Math.max(48, Math.round(support.h * frameH * dpr));
      // (one renderer for every dock shape: wide = a ticker strip, squarer = a card; names shrink, then wrap)
      if (!this.supWide) { this.supWide = true; this.board.canvas.style.display = 'none'; this.strip.canvas.style.display = ''; }
      this.strip.draw(this.feed, st, W, H, now, (frameH * dpr) / 1080);
    }
  }

  /** Line-up test label over the capture rect (null = off). */
  testLabel(r: Rect | null, frameH: number) {
    this.test.style.display = r ? '' : 'none';
    if (!r) return;
    this.test.style.left = `${((r.x + r.w / 2) * 100).toFixed(3)}%`; this.test.style.top = `${((r.y + r.h / 2) * 100).toFixed(3)}%`;
    this.test.style.fontSize = `${Math.max(12, Math.round(frameH * 0.02))}px`;
  }

  hideAll() {
    for (const t of this.tags.values()) t.el.remove();
    this.tags.clear();
    this.chatBox.style.display = 'none'; this.supBox.style.display = 'none'; this.shown = { chat: 0, support: 0 };
    this.test.style.display = 'none';
  }

  dispose() { this.off(); this.root.remove(); this.chat.dispose(); this.board.dispose(); }
}
