// HUD layer of the stage layouts (docs/LAYOUTS.md): the plan's HUD elements (shared/hud.ts — chat as plain text,
// alerts, a goal bar …) as crisp DOM over the OBS page's canvas, like the stage's name tags and docked panels
// (src/scene/stage/stageDom.ts). Each element TYPE is one small module in ./hudElements/ that calls registerHudElement
// (./hudCore.ts; loaded below with a Vite glob: a new type is a new file + its entry in shared/hud.ts HUD_TYPES).
//
// Elements are placed by their rect (fractions of the frame), fade in / out when a layout changes, and get the room's
// palette + the chat feed. Nothing here is drawn when the plan has no HUD (every other layout): zero cost.
import type { Rect } from '../../../shared/stage.ts';
import { hudElementDef, type HudEnv, type HudFrame, type HudPlaced, type HudView } from './hudCore.ts';
import { ChatTextView, type ChatTextProps } from './chatText.ts';
export * from './hudCore.ts';

// ---------------------------------------------------------------- the layer
const CSS = `
#vtp-hud { position:fixed; inset:0; pointer-events:none; z-index:41; overflow:hidden; }
#vtp-hud > .hud-el { position:absolute; box-sizing:border-box; transition:opacity .35s; }
`;

interface Live { id: string; type: string; view: HudView; shown: number; want: boolean; last: HudPlaced }

export class HudLayer {
  readonly root: HTMLDivElement;
  private live = new Map<string, Live>();

  constructor(private env: HudEnv) {
    if (!document.getElementById('vtp-hud-css')) { const s = document.createElement('style'); s.id = 'vtp-hud-css'; s.textContent = CSS; document.head.append(s); }
    this.root = document.createElement('div');
    this.root.id = 'vtp-hud';
    this.root.setAttribute('aria-hidden', 'true');
    document.body.append(this.root);
  }

  /** The plan's elements this frame (null / [] = none: everything fades out). `alpha` = the layout's own fade (0..1). */
  update(list: HudPlaced[] | null | undefined, f: HudFrame, alpha = 1) {
    const want = new Set<string>();
    for (const e of list ?? []) {
      const def = hudElementDef(e.type);
      if (!def) continue;
      const k = `${e.id}:${e.type}`;
      want.add(k);
      let l = this.live.get(k);
      if (!l) {
        let view: HudView;
        try { view = def.mount(this.env); } catch (err) { console.warn('[hud] mount', e.type, err); continue; }
        view.el.classList.add('hud-el');
        view.el.style.opacity = '0';
        this.root.append(view.el);
        l = { id: e.id, type: e.type, view, shown: 0, want: true, last: e };
        this.live.set(k, l);
      }
      l.want = true; l.last = e;
    }
    for (const [k, l] of this.live) {
      if (!want.has(k)) l.want = false;
      l.shown = l.want ? Math.min(1, l.shown + f.dt / 0.35) : Math.max(0, l.shown - f.dt / 0.3);
      if (!l.want && l.shown <= 0) { l.view.el.remove(); try { l.view.dispose(); } catch { /* element */ } this.live.delete(k); continue; }
      place(l.view.el, l.last.rect);
      l.view.el.style.opacity = (l.shown * alpha * l.last.opacity).toFixed(3);
      try { l.view.update(l.last, f); } catch (err) { console.warn('[hud] update', l.type, err); }
    }
  }

  // ---- the chat box as plain text (style 'text'): one view, placed in the chat box's rect by the compositor
  private chat: ChatTextView | null = null;
  private chatShown = 0;
  /** `r` = the chat box's rect this frame (null = hidden: fades out); `alpha` = its opacity (chat box + far-move fade). */
  chatDock(r: Rect | null, props: ChatTextProps, f: HudFrame, textSize: number, alpha: number) {
    const want = r ? 1 : 0;
    this.chatShown = want > this.chatShown ? Math.min(1, this.chatShown + f.dt / 0.35) : want < this.chatShown ? Math.max(0, this.chatShown - f.dt / 0.3) : this.chatShown;
    if (!this.chat && r) {
      this.chat = new ChatTextView(this.env.feed);
      this.chat.el.classList.add('hud-el', 'hud-chatdock');
      this.root.append(this.chat.el);
    }
    const c = this.chat;
    if (!c) return;
    if (r) place(c.el, r);
    if (this.chatShown <= 0 && !r) { c.el.remove(); c.dispose(); this.chat = null; return; }
    c.el.style.opacity = (this.chatShown * alpha).toFixed(3);
    c.update(props, f, textSize);
  }
  /** The text chat box (tests / the compositor's info). */
  chatInfo() { return this.chat ? { shown: +this.chatShown.toFixed(2), lines: this.chat.el.childElementCount } : null; }

  /** Debug / tests: what is drawn. */
  info() { return [...this.live.values()].map((l) => ({ id: l.id, type: l.type, shown: +l.shown.toFixed(2), rect: l.last.rect })); }

  hideAll() {
    for (const l of this.live.values()) { l.view.el.remove(); try { l.view.dispose(); } catch { /* element */ } }
    this.live.clear();
    if (this.chat) { this.chat.el.remove(); this.chat.dispose(); this.chat = null; this.chatShown = 0; }
  }
  dispose() { this.hideAll(); this.root.remove(); }
}

function place(el: HTMLElement, r: Rect) {
  el.style.left = `${(r.x * 100).toFixed(3)}%`; el.style.top = `${(r.y * 100).toFixed(3)}%`;
  el.style.width = `${(r.w * 100).toFixed(3)}%`; el.style.height = `${(r.h * 100).toFixed(3)}%`;
}

// every element type (Vite: static imports of each file in ./hudElements, studio + OBS pages alike)
(import.meta as unknown as { glob: (p: string, o: { eager: true }) => Record<string, unknown> }).glob('./hudElements/*.ts', { eager: true });
