// Supporter name effects for the CHAT BOX (the small, isolated hook the chat renderers call: src/scene/stage/chatText.ts
// for the text chat box, src/chat/chatCanvas.ts for the panel / tablet canvases). The chat audience
// (src/scene/audience/audienceScene.ts) feeds it the helper's tiers + effect settings from each {type:'audience'} view;
// with no view (another PC, the audience off) every function here is a no-op and names look as before.
// The same badge glyphs are drawn on the 3D name tags (src/scene/audience/nameTags.ts).
import { chatKey, personKey, resolveNameStyle, type AudienceView, type NameBadge, type NameStyle } from '../../shared/audience.ts';
import type { ChatEvent } from '../../shared/chat.ts';

let tiers: AudienceView['tiers'] = {};
let look: AudienceView['look'] | null = null;
let rev = 0;

/** The audience engine hands over the latest view (tiers + effect settings). */
export function setNameStyles(v: Pick<AudienceView, 'tiers' | 'look' | 'members'> | null) {
  if (!v) { tiers = {}; look = null; rev++; return; }
  const t: AudienceView['tiers'] = { ...v.tiers };
  for (const m of v.members) if (m.t) t[m.k] = m.t;
  tiers = t; look = v.look; rev++;
}
/** Bumps when the styles change (canvases that cache a drawing redraw). */
export const nameStylesRev = () => rev;

/** The name style of a chat line's sender, or null (no effect: draw the name as usual). */
export function nameStyleFor(e: Pick<ChatEvent, 'platform' | 'user' | 'color' | 'uid'>): NameStyle | null {
  if (!look) return null;
  // by the platform user id when the line has one, else the name; hand-picked names as `platform:name` / `*:name`
  const lower = e.user.trim().toLowerCase();
  const t = (e.uid ? tiers[personKey(e.platform, e.user, e.uid)] : undefined) ?? tiers[chatKey(e.platform, e.user)] ?? tiers[`*:${lower}`];
  if (!t) return null;
  const s = resolveNameStyle(t, e.color, look);
  return s.tier ? s : null;
}

/** Text chat box (DOM): colour + glow on the name element, a badge glyph before it. */
export function styleNameEl(nm: HTMLElement, e: Pick<ChatEvent, 'platform' | 'user' | 'color' | 'uid'>) {
  const s = nameStyleFor(e);
  if (!s) return;
  if (s.color) nm.style.color = s.color;
  if (s.glow) nm.style.textShadow = `0 0 .35em ${s.glow}, 0 0 .12em ${s.glow}, ${nm.style.textShadow || '0 0 0 transparent'}`;
  const g = BADGE_TEXT[s.badge];
  if (g) nm.prepend(Object.assign(document.createElement('span'), { textContent: g, style: `color:${BADGE_COLOR[s.badge]};margin-right:.18em;font-weight:900` }) as HTMLSpanElement);
}

/** Canvas chat (panel / tablet): call before filling the name; returns the x after a drawn badge. The caller fills the
 *  name with `style.color` (when set) — the glow is applied to `g` here and must be reset with `endName(g)`. */
export function beginName(g: CanvasRenderingContext2D, s: NameStyle, x: number, midY: number, fs: number): number {
  let nx = x;
  if (s.badge !== 'none') { drawBadge(g, s.badge, x, midY - fs * 0.45, fs * 0.9); nx += fs * 1.05; }
  if (s.glow) { g.shadowColor = s.glow; g.shadowBlur = fs * 0.55; }
  return nx;
}
export function endName(g: CanvasRenderingContext2D) { g.shadowBlur = 0; g.shadowColor = 'transparent'; }

const BADGE_TEXT: Record<NameBadge, string> = { none: '', crown: '♛', diamond: '◆', gem: '♦', heart: '♥', star: '★', bolt: '⚡', shield: '⛨' };
export const BADGE_COLOR: Record<NameBadge, string> = { none: '#fff', crown: '#ffd34d', diamond: '#8fe9ff', gem: '#d48bff', heart: '#ff5f8f', star: '#ffe066', bolt: '#35e3ff', shield: '#7dff9a' };

/** Vector badge glyphs (no fonts, no images): a `size`-px square with its top-left at (x, y). */
export function drawBadge(g: CanvasRenderingContext2D, b: NameBadge, x: number, y: number, size: number) {
  if (b === 'none') return;
  const s = size, c = BADGE_COLOR[b];
  g.save();
  g.translate(x, y);
  g.lineJoin = 'round';
  g.beginPath();
  switch (b) {
    case 'crown':
      g.moveTo(s * 0.08, s * 0.82); g.lineTo(s * 0.08, s * 0.3); g.lineTo(s * 0.3, s * 0.52); g.lineTo(s * 0.5, s * 0.14); g.lineTo(s * 0.7, s * 0.52); g.lineTo(s * 0.92, s * 0.3); g.lineTo(s * 0.92, s * 0.82); g.closePath(); break;
    case 'diamond':
      g.moveTo(s * 0.5, s * 0.06); g.lineTo(s * 0.94, s * 0.5); g.lineTo(s * 0.5, s * 0.94); g.lineTo(s * 0.06, s * 0.5); g.closePath(); break;
    case 'gem':
      g.moveTo(s * 0.22, s * 0.18); g.lineTo(s * 0.78, s * 0.18); g.lineTo(s * 0.96, s * 0.4); g.lineTo(s * 0.5, s * 0.92); g.lineTo(s * 0.04, s * 0.4); g.closePath(); break;
    case 'heart':
      g.moveTo(s * 0.5, s * 0.9);
      g.bezierCurveTo(s * 0.1, s * 0.62, s * 0.0, s * 0.36, s * 0.16, s * 0.2); g.bezierCurveTo(s * 0.3, s * 0.06, s * 0.46, s * 0.12, s * 0.5, s * 0.28);
      g.bezierCurveTo(s * 0.54, s * 0.12, s * 0.7, s * 0.06, s * 0.84, s * 0.2); g.bezierCurveTo(s * 1.0, s * 0.36, s * 0.9, s * 0.62, s * 0.5, s * 0.9); break;
    case 'star':
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? s * 0.21 : s * 0.48; const px = s * 0.5 + Math.cos(a) * r, py = s * 0.54 + Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
      g.closePath(); break;
    case 'bolt':
      g.moveTo(s * 0.58, s * 0.04); g.lineTo(s * 0.18, s * 0.56); g.lineTo(s * 0.46, s * 0.56); g.lineTo(s * 0.36, s * 0.96); g.lineTo(s * 0.82, s * 0.4); g.lineTo(s * 0.54, s * 0.4); g.closePath(); break;
    case 'shield':
      g.moveTo(s * 0.5, s * 0.05); g.lineTo(s * 0.9, s * 0.2); g.quadraticCurveTo(s * 0.88, s * 0.72, s * 0.5, s * 0.96); g.quadraticCurveTo(s * 0.12, s * 0.72, s * 0.1, s * 0.2); g.closePath(); break;
  }
  g.lineWidth = Math.max(1.5, s * 0.12); g.strokeStyle = 'rgba(0,0,0,0.85)'; g.stroke();
  g.fillStyle = c; g.fill();
  // a highlight so it reads as a little object, not a flat blob
  g.globalAlpha = 0.35; g.fillStyle = '#ffffff';
  g.beginPath(); g.ellipse(s * 0.4, s * 0.36, s * 0.12, s * 0.07, -0.6, 0, Math.PI * 2); g.fill();
  g.restore();
}
