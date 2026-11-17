// The clean overlay card for the question being answered (setting ask.overlay: 'on', or 'auto' = only in rooms without
// audience seats, so a question still shows): a lower-third card on the OBS page, above the room, under the page's own
// cards. Text goes in as text nodes only.
import type { NameStyle, QuestionView } from '../../../shared/audience.ts';
import { BADGE_COLOR } from '../../chat/nameStyle.ts';
import { readable } from './nameTags.ts';

const CSS = `
.vaud-ov{position:fixed;left:3.2vw;bottom:5.5vh;max-width:min(46vw,760px);z-index:4;pointer-events:none;font-family:"Segoe UI","Noto Sans",system-ui,sans-serif;
  transform:translateY(16px);opacity:0;transition:opacity .45s ease,transform .45s cubic-bezier(.2,.9,.3,1.2)}
.vaud-ov.on{opacity:1;transform:none}
.vaud-ov .card{background:rgba(12,14,26,.92);border:3px solid var(--acc,#ffd34d);border-radius:18px;box-shadow:0 0 22px color-mix(in srgb,var(--acc,#ffd34d) 55%,transparent),0 8px 30px #0008;overflow:hidden}
.vaud-ov .hd{display:flex;justify-content:space-between;gap:16px;background:var(--acc,#ffd34d);color:var(--ink,#0b0f14);font-weight:900;letter-spacing:.06em;font-size:clamp(12px,1.25vh,22px);padding:.45em 1em}
.vaud-ov .q{color:#f4f6ff;font-weight:700;font-size:clamp(16px,2.6vh,40px);line-height:1.22;padding:.55em .8em .2em;overflow-wrap:anywhere}
.vaud-ov .who{color:#9aa4c4;font-weight:800;font-size:clamp(12px,1.8vh,28px);padding:.1em 1.1em .7em}
.vaud-ov .who b{font-weight:800}
`;

export class AudienceOverlay {
  private el: HTMLDivElement | null = null;
  private sig = '';

  update(q: QuestionView | null, style: NameStyle | null) {
    if (!q) { if (this.el) this.el.classList.remove('on'); this.sig = ''; return; }
    const sig = `${q.id}|${q.status}|${q.text}|${q.paid?.display ?? ''}|${style?.color ?? ''}`;
    if (sig === this.sig && this.el) { this.el.classList.add('on'); return; }
    this.sig = sig;
    if (!this.el) {
      if (!document.getElementById('vaud-ov-css')) { const s = document.createElement('style'); s.id = 'vaud-ov-css'; s.textContent = CSS; document.head.append(s); }
      this.el = document.createElement('div'); this.el.className = 'vaud-ov'; document.body.append(this.el);
    }
    const acc = q.paid?.tier ?? '#ffd34d';
    this.el.style.setProperty('--acc', acc);
    const c = acc.replace('#', ''); const lum = (0.2126 * parseInt(c.slice(0, 2), 16) + 0.7152 * parseInt(c.slice(2, 4), 16) + 0.0722 * parseInt(c.slice(4, 6), 16)) / 255;
    this.el.style.setProperty('--ink', lum > 0.6 ? '#0b0f14' : '#ffffff');
    const card = document.createElement('div'); card.className = 'card';
    const hd = document.createElement('div'); hd.className = 'hd';
    hd.append(Object.assign(document.createElement('span'), { textContent: q.status === 'answered' ? 'ANSWERED' : 'NOW ANSWERING' }));
    if (q.paid) hd.append(Object.assign(document.createElement('span'), { textContent: q.paid.display }));
    const qt = document.createElement('div'); qt.className = 'q'; qt.textContent = q.text;
    const who = document.createElement('div'); who.className = 'who';
    who.append('— ');
    if (style && style.badge !== 'none') who.append(Object.assign(document.createElement('span'), { textContent: '★', style: `color:${BADGE_COLOR[style.badge]}` }), ' ');
    const b = document.createElement('b'); b.textContent = q.name; b.style.color = readable(style?.color || q.color || '#e8ecf6');
    if (style?.glow) b.style.textShadow = `0 0 .4em ${style.glow}`;
    who.append(b);
    card.append(hd, qt, who);
    this.el.replaceChildren(card);
    requestAnimationFrame(() => this.el?.classList.add('on'));
  }
  dispose() { this.el?.remove(); this.el = null; }
}
