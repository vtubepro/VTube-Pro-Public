// HUD element "alerts" (shared/hud.ts HUD_TYPES.alerts): support events (tips, Super Chats, subs, raids …) as one big
// outlined line + their message, one at a time, `duration` seconds each. Which events alert follows the chat settings
// (Chat & events → minimum alert, subs on / off: shared/chat.ts chatAlerts). Text only as text nodes.
import { chatAlerts, type ChatEvent } from '../../../../shared/chat.ts';
import { HUD_FONTS, prop, readableColor, registerHudElement, textShadow, type HudEnv, type HudFrame, type HudPlaced, type HudView } from '../hudCore.ts';

const CSS = `
.hud-alert { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; overflow:visible; }
.hud-alert .card { opacity:0; transform:scale(.86) translateY(.3em); transition:opacity .3s ease, transform .35s cubic-bezier(.2,1.4,.4,1); }
.hud-alert .card.on { opacity:1; transform:none; }
.hud-alert .who { font-weight:900; letter-spacing:.01em; }
.hud-alert .amt { font-weight:900; margin-left:.3em; }
.hud-alert .msg { font-size:.5em; font-weight:650; margin-top:.25em; font-family:"Segoe UI", Inter, system-ui, sans-serif; overflow-wrap:anywhere; }
`;
let cssDone = false;

class AlertsView implements HudView {
  readonly el = document.createElement('div');
  private card = document.createElement('div');
  private queue: ChatEvent[] = [];
  private cur: { e: ChatEvent; at: number } | null = null;
  private off: () => void;
  private dur = 7;
  private gap = 0;

  constructor(env: HudEnv) {
    if (!cssDone) { const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); cssDone = true; }
    this.el.className = 'hud-alert';
    this.card.className = 'card';
    this.el.append(this.card);
    this.off = env.feed.on((fresh, snap) => {
      if (snap) return;
      const st = env.chat();
      for (const e of fresh) if (chatAlerts(e, st)) { this.queue.push(e); if (this.queue.length > 12) this.queue.shift(); }
    });
  }

  update(e: HudPlaced, f: HudFrame) {
    const p = e.props, k = f.frameH / 1080;
    this.dur = prop.num(p.duration, 7);
    const s = this.el.style;
    s.fontSize = `${(26 * prop.num(p.size, 1.6) * k).toFixed(2)}px`;
    s.fontFamily = HUD_FONTS[prop.str(p.font, 'heavy')] ?? HUD_FONTS.heavy;
    s.color = prop.str(p.color, '#ffffff');
    s.textShadow = textShadow(prop.num(p.outline, 4), prop.num(p.shadow, 0.7), k);
    const now = f.now;
    if (this.cur && now - this.cur.at > this.dur * 1000) { this.cur = null; this.card.classList.remove('on'); this.gap = now + 450; }
    if (!this.cur && this.queue.length && now >= this.gap) {
      const ev = this.queue.shift()!;
      this.cur = { e: ev, at: now };
      this.fill(ev, p);
      // (next frame: the transition runs from the hidden state)
      requestAnimationFrame(() => this.card.classList.add('on'));
    }
  }

  private fill(ev: ChatEvent, p: HudPlaced['props']) {
    this.card.replaceChildren();
    const top = document.createElement('div');
    const who = document.createElement('span'); who.className = 'who'; who.textContent = ev.user;
    const amt = document.createElement('span'); amt.className = 'amt';
    amt.textContent = [ev.display, ev.label].filter(Boolean).join(' · ') || ev.text;
    const accent = prop.str(p.accent, '');
    amt.style.color = accent || readableColor(ev.tier, '#ffd166');
    top.append(who, amt);
    this.card.append(top);
    if (prop.bool(p.message, true) && ev.text && ev.text !== amt.textContent) {
      const m = document.createElement('div'); m.className = 'msg'; m.textContent = ev.text.slice(0, 200);
      this.card.append(m);
    }
  }

  dispose() { this.off(); }
}

registerHudElement({ type: 'alerts', mount: (env) => new AlertsView(env) });
