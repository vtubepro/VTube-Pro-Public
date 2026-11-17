// The chat box drawn as plain styled text (shared/chatBox.ts style 'text' / a layout look's chat: 'text'; options:
// shared/hud.ts CHAT_TEXT_PROPS, kept in the `hud` bag): chat over the screen with no panel art. Each line is outlined
// + shadowed so it reads on any game; lines fade out `fade` seconds after they arrived, the oldest are cut off at the
// far edge (soft mask). Chat filters (bots, !commands) and Live → Privacy → Hide chat apply. Message text only ever goes
// in as text nodes (never HTML); emotes are <img> through the helper's image proxy. Placed by the compositor in the
// chat box's rect (src/scene/stage/hud.ts HudLayer.chatDock).
import { PLATFORM_COLORS, chatVisible, type ChatEvent } from '../../../shared/chat.ts';
import type { ChatFeed } from '../../chat/feed.ts';
import { HUD_FONTS, prop, readableColor, textShadow, type HudFrame } from './hudCore.ts';
import { styleNameEl } from '../../chat/nameStyle.ts';

const CSS = `
.hud-chat { display:flex; flex-direction:column; justify-content:flex-end; overflow:hidden; line-height:1.28; }
.hud-chat.down { justify-content:flex-start; }
.hud-chat.right { text-align:right; align-items:flex-end; }
.hud-chat.left { align-items:flex-start; }
.hud-chat .ln { max-width:100%; box-sizing:border-box; overflow-wrap:anywhere; word-break:break-word; margin:.12em 0; padding:.06em .1em; border-radius:.35em;
  animation: hud-chat-in .28s ease-out backwards; transition: opacity .9s ease; }
.hud-chat .ln .nm { font-weight:800; margin-right:.35em; }
.hud-chat .ln .dot { display:inline-block; width:.5em; height:.5em; border-radius:50%; margin-right:.35em; vertical-align:.08em; box-shadow:0 0 0 .08em #000a; }
.hud-chat .ln .amt { font-weight:900; margin-right:.35em; }
.hud-chat .ln.sys { font-style:italic; opacity:.92; }
.hud-chat .ln img { height:1.25em; width:auto; vertical-align:-.28em; margin:0 .05em; }
@keyframes hud-chat-in { from { opacity:0; transform:translateY(.45em); } to { opacity:1; transform:none; } }
`;
let cssDone = false;

interface Line { id: string; el: HTMLDivElement; at: number; gone: boolean }

function emoteSrc(u: string): string | null {
  if (u.startsWith('/') && !u.startsWith('//')) return u;
  return /^https:\/\//.test(u) ? `/api/chat/img?u=${encodeURIComponent(u)}` : null;
}

export type ChatTextProps = Record<string, string | number | boolean>;

export class ChatTextView {
  readonly el = document.createElement('div');
  private lines = new Map<string, Line>();
  private seen = new Map<string, number>();
  private sig = '';
  private styleSig = '';

  constructor(private feed: ChatFeed) {
    if (!cssDone) { const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); cssDone = true; }
    this.el.className = 'hud-chat left';
  }

  /** `textSize` = the chat box's text size (SceneStageState.chatText) × the options' own size. */
  update(p: ChatTextProps, f: HudFrame, textSize = 1) {
    const k = f.frameH / 1080;
    const size = prop.num(p.size, 1) * textSize, max = Math.round(prop.num(p.max, 8)), fade = prop.num(p.fade, 30);
    const flow = prop.str(p.flow, 'up'), align = prop.str(p.align, 'left');
    // ---- container style (only when it changes)
    const ss = `${size}|${k.toFixed(3)}|${p.font}|${p.color}|${p.outline}|${p.shadow}|${flow}|${align}|${p.scrim}`;
    if (ss !== this.styleSig) {
      this.styleSig = ss;
      const s = this.el.style;
      s.fontSize = `${(26 * size * k).toFixed(2)}px`;
      s.fontFamily = HUD_FONTS[prop.str(p.font, 'sans')] ?? HUD_FONTS.sans;
      s.color = prop.str(p.color, '#ffffff');
      s.fontWeight = '650';
      s.textShadow = textShadow(prop.num(p.outline, 3), prop.num(p.shadow, 0.7), k);
      this.el.classList.toggle('down', flow === 'down');
      this.el.classList.toggle('right', align === 'right');
      this.el.classList.toggle('left', align !== 'right');
      // the cut-off edge fades softly instead of slicing a line in half
      const mask = flow === 'down' ? 'linear-gradient(to top, transparent 0, #000 1.6em)' : 'linear-gradient(to bottom, transparent 0, #000 1.6em)';
      s.setProperty('-webkit-mask-image', mask); s.setProperty('mask-image', mask);
      const scrim = prop.num(p.scrim, 0);
      for (const l of this.lines.values()) l.el.style.background = scrim > 0.01 ? `rgba(0,0,0,${scrim.toFixed(2)})` : '';
    }
    const st = f.chat;
    if (st.hidden) { if (this.lines.size) this.clearAll(); return; }
    // ---- which events: visible by the chat filters, chat / support / system lines, the newest `max`
    const support = prop.bool(p.support, true);
    const evs = this.feed.events.filter((ev) => chatVisible(ev, st) && (ev.kind === 'chat' || ev.kind === 'system' || (support && ev.kind === 'finance')));
    const pick = evs.slice(-max);
    const now = f.now;
    const sig = pick.map((ev) => ev.id).join('|');
    if (sig !== this.sig) {
      this.sig = sig;
      const keep = new Set(pick.map((ev) => ev.id));
      for (const [id, l] of this.lines) if (!keep.has(id)) { l.el.remove(); this.lines.delete(id); }
      for (const ev of pick) {
        if (this.lines.has(ev.id)) continue;
        // arrival time: now for live lines; history that was already old when the page opened keeps its age
        let at = this.seen.get(ev.id);
        if (at === undefined) { at = Math.abs(ev.ts - now) < 10_000 ? now : Math.min(now, ev.ts); this.seen.set(ev.id, at); }
        const line: Line = { id: ev.id, el: this.line(ev, p), at, gone: false };
        this.lines.set(ev.id, line);
      }
      // DOM order = event order (newest last; 'down' shows the newest first)
      const ordered = pick.map((ev) => this.lines.get(ev.id)!).filter(Boolean);
      if (flow === 'down') ordered.reverse();
      for (const l of ordered) this.el.append(l.el);
      if (this.seen.size > 400) { const ids = new Set(evs.map((x) => x.id)); for (const id of this.seen.keys()) if (!ids.has(id)) this.seen.delete(id); }
    }
    // ---- fade out after `fade` seconds (0 = never)
    if (fade > 0) for (const l of this.lines.values()) {
      const old = now - l.at > fade * 1000;
      if (old !== l.gone) { l.gone = old; l.el.style.opacity = old ? '0' : ''; }
    }
  }

  private line(ev: ChatEvent, p: ChatTextProps): HTMLDivElement {
    const d = document.createElement('div');
    d.className = `ln${ev.kind === 'system' ? ' sys' : ''}`;
    const scrim = prop.num(p.scrim, 0);
    if (scrim > 0.01) d.style.background = `rgba(0,0,0,${scrim.toFixed(2)})`;
    if (prop.bool(p.platform, false)) {
      const dot = document.createElement('span'); dot.className = 'dot';
      dot.style.background = PLATFORM_COLORS[ev.platform] ?? '#888';
      d.append(dot);
    }
    const nm = document.createElement('span'); nm.className = 'nm';
    nm.textContent = ev.user;
    nm.style.color = prop.bool(p.names, true) ? readableColor(ev.color, readableColor(PLATFORM_COLORS[ev.platform])) : 'inherit';
    if (prop.bool(p.names, true)) styleNameEl(nm, ev);   // supporter name effect (src/chat/nameStyle.ts)
    d.append(nm);
    if (ev.kind === 'finance') {
      const amt = document.createElement('span'); amt.className = 'amt';
      amt.textContent = `♥ ${ev.display ?? ev.label ?? ''}`.trim();
      amt.style.color = readableColor(ev.tier, '#ffd166');
      d.append(amt);
    }
    if (ev.parts?.length) {
      for (const part of ev.parts) {
        if (part.t === 'text') d.append(document.createTextNode(part.v));
        else {
          const src = emoteSrc(part.u);
          if (!src) { d.append(document.createTextNode(part.n)); continue; }
          const im = document.createElement('img'); im.alt = part.n; im.src = src; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
          d.append(im);
        }
      }
    } else d.append(document.createTextNode(ev.text));
    return d;
  }

  private clearAll() { for (const l of this.lines.values()) l.el.remove(); this.lines.clear(); this.sig = ''; }
  dispose() { this.clearAll(); }
}

