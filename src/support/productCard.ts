// The product showcase on stream (beta.13): the streamer's featured product (or a carousel), and "Sam just bought
// this!" when a product sells. ONE canvas renderer, used three ways (like the poll card, src/poll/pollCard.ts):
//   in-world: drawn on the room's neon support board while it is in the shot (src/chat/chatCanvas.ts asks productWorld)
//   docked:   a card in the first free corner that touches no face, cam, capture, docked chat or poll card
//   layout:   the HUD element "productCard" in OBS layouts (src/scene/stage/hudElements/productCard.ts)
// Data: the helper's {type:'supportShow', v: ShowcaseView} (server/support/store.ts); images only through this PC's
// helper (/api/support/img/…) or inline data, never a shop's CDN directly. Canvas text only (no HTML from a shop).
import { moneyText, sanitizeShowcase, showcaseProduct, type ShowcaseView, type StoreProduct } from '../../shared/supportConfig.ts';
import { pickPollDock, type PRect } from '../../shared/poll.ts';
import { qrModel } from '../ui/inviteQr.ts';
import { pollStore } from '../poll/pollCard.ts';

const FONT = '"Segoe UI", Inter, system-ui, sans-serif';
const FLASH_MS = 10_500;
const ACCENT = '#ff7a4d';

class ShowStore {
  view: ShowcaseView | null = null;
  /** Which in-world prop shows the card right now (set by the overlay each frame). */
  world: 'board' | null = null;
  /** A layout's productCard element drew this frame (the docked card then stays away). */
  hudAt = 0;
  rev = 0;
  set(raw: unknown) { const v = sanitizeShowcase(raw); if (!v) return; this.view = v; this.rev++; }
  /** What to show now: a fresh purchase first, else the showcase product while it is on. */
  current(now = Date.now()): { product: StoreProduct | null; flash: ShowcaseView['flash'] } | null {
    const v = this.view;
    if (!v) return null;
    const f = v.flash && now - v.flash.at < FLASH_MS ? v.flash : null;
    if (f) return { product: f.product, flash: f };
    if (!v.on) return null;
    const p = showcaseProduct(v, now);
    return p ? { product: p, flash: null } : null;
  }
}
export const showStore = new ShowStore();

// ---------------------------------------------------------------- images (same-origin only)
const imgs = new Map<string, HTMLImageElement>();
let imgRev = 0;
function img(src: string): HTMLImageElement | null {
  if (!src || !(/^\/api\/support\/img\//.test(src) || /^data:image\//.test(src))) return null;
  let im = imgs.get(src);
  if (!im) {
    im = new Image();
    im.decoding = 'async';
    im.onload = () => { imgRev++; };
    im.src = src;
    imgs.set(src, im);
    if (imgs.size > 60) { const first = imgs.keys().next().value; if (first) imgs.delete(first); }
  }
  return im.complete && im.naturalWidth > 0 ? im : null;
}
export const productImgRev = () => imgRev;

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, lines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean), out: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (g.measureText(t).width <= maxW || !cur) { cur = t; continue; }
    out.push(cur); cur = w;
    if (out.length === lines) { cur = ''; break; }
  }
  if (cur && out.length < lines) out.push(cur);
  const last = out.length - 1;
  if (last >= 0 && (out.join(' ').length < text.length || g.measureText(out[last]).width > maxW)) {
    let t = out[last];
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    if (out.join(' ').length < text.length) out[last] = t + '…';
  }
  return out;
}
function cover(g: CanvasRenderingContext2D, im: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const s = Math.max(w / im.naturalWidth, h / im.naturalHeight);
  const sw = w / s, sh = h / s;
  g.drawImage(im, (im.naturalWidth - sw) / 2, (im.naturalHeight - sh) / 2, sw, sh, x, y, w, h);
}
const qrCache = new Map<string, boolean[][]>();
function drawQr(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number) {
  let m = qrCache.get(text);
  if (!m) { try { m = qrModel(text, false).dark; } catch { return; } qrCache.set(text, m); if (qrCache.size > 30) qrCache.delete(qrCache.keys().next().value!); }
  const n = m.length, q = 2, cell = size / (n + q * 2);
  g.fillStyle = '#fff'; rr(g, x, y, size, size, size * 0.06); g.fill();
  g.fillStyle = '#06080a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) g.fillRect(Math.floor(x + (c + q) * cell), Math.floor(y + (r + q) * cell), Math.ceil(cell), Math.ceil(cell));
}

/** Draw the card filling W×H. `world`: the board's own frame is around it (no outer card chrome, bigger text). */
export function drawProductCard(g: CanvasRenderingContext2D, W: number, H: number, now: number, what: { product: StoreProduct | null; flash: ShowcaseView['flash'] }, o: { qr: boolean; shopUrl: string; world?: boolean }) {
  const p = what.product, f = what.flash;
  const wide = W / H > 1.25;
  const u = Math.min(W, H * (wide ? 1.6 : 0.75)) / 360;
  const pad = 16 * u;
  g.save();
  // card
  if (!o.world) {
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(22,24,32,0.94)'); grad.addColorStop(1, 'rgba(10,11,16,0.94)');
    rr(g, 1, 1, W - 2, H - 2, 22 * u); g.fillStyle = grad; g.fill();
    g.lineWidth = 2.5 * u; g.strokeStyle = f ? ACCENT : 'rgba(255,255,255,0.16)'; g.stroke();
  } else { g.fillStyle = '#0b0d14'; g.fillRect(0, 0, W, H); }
  const name = p?.name ?? f?.itemName ?? '';
  const src = p?.image || f?.image || '';
  const im = img(src);
  // the banner for a purchase
  let top = pad;
  if (f) {
    const bh = 40 * u;
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    const bg = g.createLinearGradient(pad, 0, W - pad, 0);
    bg.addColorStop(0, ACCENT); bg.addColorStop(1, '#ffb347');
    rr(g, pad, top, W - pad * 2, bh, 12 * u); g.fillStyle = bg; g.fill();
    g.globalAlpha = 0.25 * pulse; g.fillStyle = '#fff'; g.fill(); g.globalAlpha = 1;
    g.fillStyle = '#1a0f08'; g.font = `800 ${Math.round(19 * u)}px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'center';
    const line = `${f.who} just bought this!`;
    let fs = 19 * u;
    while (g.measureText(line).width > W - pad * 3 && fs > 11 * u) { fs -= 1; g.font = `800 ${Math.round(fs)}px ${FONT}`; }
    g.fillText(line, W / 2, top + bh / 2 + 1);
    top += bh + 12 * u;
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  if (wide) {
    // image left, text right
    const isz = Math.min(H - top - pad, W * 0.42);
    const ix = pad, iy = top;
    rr(g, ix, iy, isz, isz, 16 * u); g.save(); g.clip();
    if (im) cover(g, im, ix, iy, isz, isz); else { g.fillStyle = '#1d2130'; g.fillRect(ix, iy, isz, isz); g.fillStyle = 'rgba(255,255,255,.35)'; g.font = `700 ${Math.round(isz * 0.32)}px ${FONT}`; g.textAlign = 'center'; g.fillText('🛍', ix + isz / 2, iy + isz * 0.62); g.textAlign = 'left'; }
    g.restore();
    const tx = ix + isz + pad, tw = W - tx - pad;
    let y = top + 30 * u;
    g.fillStyle = '#fff'; g.font = `800 ${Math.round(28 * u)}px ${FONT}`;
    for (const l of wrap(g, name, tw, 2)) { g.fillText(l, tx, y); y += 33 * u; }
    if (p) { y += 6 * u; g.fillStyle = ACCENT; g.font = `800 ${Math.round(30 * u)}px ${FONT}`; g.fillText(moneyText(p.priceMinor, p.currency), tx, y); y += 12 * u; }
    if (p?.left !== undefined && p.left > 0) { g.font = `700 ${Math.round(16 * u)}px ${FONT}`; const t = `Only ${p.left} left!`; const w = g.measureText(t).width + 18 * u; y += 10 * u; rr(g, tx, y, w, 28 * u, 14 * u); g.fillStyle = 'rgba(255,90,90,.18)'; g.fill(); g.fillStyle = '#ff8a8a'; g.fillText(t, tx + 9 * u, y + 19.5 * u); y += 34 * u; }
    const link = p?.url || o.shopUrl;
    if (o.qr && link) {
      const qs = Math.min(110 * u, H - y - pad, tw * 0.45);
      if (qs > 60 * u) { drawQr(g, link, W - pad - qs, H - pad - qs, qs); g.fillStyle = 'rgba(255,255,255,.75)'; g.font = `600 ${Math.round(14 * u)}px ${FONT}`; g.textAlign = 'right'; g.fillText('Scan to shop', W - pad - qs - 10 * u, H - pad - 6 * u); g.textAlign = 'left'; }
    } else if (link) { g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `600 ${Math.round(15 * u)}px ${FONT}`; g.fillText(host(link), tx, H - pad); }
  } else {
    // image on top, text below
    const qrOn = o.qr && !!(p?.url || o.shopUrl);
    const isz = Math.min(W - pad * 2, H - top - pad - (qrOn ? 150 : 110) * u);
    const ix = (W - isz) / 2, iy = top;
    rr(g, ix, iy, isz, isz, 16 * u); g.save(); g.clip();
    if (im) cover(g, im, ix, iy, isz, isz); else { g.fillStyle = '#1d2130'; g.fillRect(ix, iy, isz, isz); g.fillStyle = 'rgba(255,255,255,.35)'; g.font = `700 ${Math.round(isz * 0.32)}px ${FONT}`; g.textAlign = 'center'; g.fillText('🛍', ix + isz / 2, iy + isz * 0.62); g.textAlign = 'left'; }
    g.restore();
    if (p?.left !== undefined && p.left > 0) { g.font = `800 ${Math.round(14 * u)}px ${FONT}`; const t = `Only ${p.left} left!`; const w = g.measureText(t).width + 16 * u; rr(g, ix + 8 * u, iy + 8 * u, w, 26 * u, 13 * u); g.fillStyle = 'rgba(200,30,40,.92)'; g.fill(); g.fillStyle = '#fff'; g.fillText(t, ix + 16 * u, iy + 26 * u); }
    let y = iy + isz + 30 * u;
    const textW = W - pad * 2 - (qrOn ? 96 * u : 0);
    g.fillStyle = '#fff'; g.font = `800 ${Math.round(22 * u)}px ${FONT}`;
    for (const l of wrap(g, name, textW, 2)) { g.fillText(l, pad, y); y += 26 * u; }
    if (p) { g.fillStyle = ACCENT; g.font = `800 ${Math.round(24 * u)}px ${FONT}`; g.fillText(moneyText(p.priceMinor, p.currency), pad, y + 4 * u); }
    const link = p?.url || o.shopUrl;
    if (qrOn && link) { const qs = 84 * u; drawQr(g, link, W - pad - qs, H - pad - qs, qs); g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `600 ${Math.round(13 * u)}px ${FONT}`; g.fillText('Scan to shop', pad, H - pad - 22 * u); g.fillStyle = 'rgba(255,255,255,.5)'; g.fillText(host(link), pad, H - pad - 4 * u); }
    else if (link) { g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `600 ${Math.round(14 * u)}px ${FONT}`; g.fillText(host(link), pad, H - pad); }
  }
  g.restore();
}
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };

/** The board's canvas asks this each redraw (src/chat/chatCanvas.ts): true = the card was drawn on it. */
export function productWorld(g: CanvasRenderingContext2D, W: number, H: number, now: number): boolean {
  if (showStore.world !== 'board') return false;
  const cur = showStore.current(now);
  if (!cur) return false;
  // the board is also the supporters' board: the showcase takes it 12 s of every 30 (a purchase takes it at once)
  if (!cur.flash && Math.floor(now / 1000) % 30 >= 12) return false;
  drawProductCard(g, W, H, now, cur, { qr: !!showStore.view?.qr, shopUrl: showStore.view?.shopUrl ?? '', world: true });
  return true;
}

export interface ProductPlacement { pollWorld: 'monitor' | 'board' | null; pollAvoid(): PRect[] }

/** The docked card (a fixed canvas over the OBS page), placed like the poll card. */
export class ProductOverlay {
  readonly canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  private alpha = 0;
  private rect: PRect | null = null;
  private lastDraw = 0;
  private key = '';
  /** Debug / tests: where the card is. */
  where: 'hidden' | 'world' | 'docked' | 'layout' = 'hidden';

  constructor() {
    const c = this.canvas;
    c.id = 'vtp-product';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:29;opacity:0;transform-origin:top left;';
    document.body.append(c);
  }

  update(dt: number, place: ProductPlacement | null, now = Date.now()) {
    // the poll card's place (a docked poll wins: we never overlap it; a poll in the world has the board)
    const pc = document.getElementById('vtp-poll') as HTMLCanvasElement | null;
    const pollOn = !!pc && Number(pc.style.opacity || 0) > 0.05;
    const vw0 = window.innerWidth || 1920, vh0 = window.innerHeight || 1080;
    const pollRect: PRect | null = pollOn && pc ? { x: pc.offsetLeft / vw0, y: pc.offsetTop / vh0, w: pc.offsetWidth / vw0, h: pc.offsetHeight / vh0 } : null;
    const pollWorld = pollStore.world === 'board' && pollStore.active(now);
    const cur = showStore.current(now);
    const v = showStore.view;
    const layout = now - showStore.hudAt < 500;
    // in the room: the support board when it is up in this shot and the poll isn't using it
    const boardFree = place?.pollWorld === 'board' && !pollRect && !pollWorld;
    showStore.world = cur && !layout && v?.where !== 'docked' && boardFree ? 'board' : null;
    const docked = !!cur && !layout && !showStore.world && v?.where !== 'world';
    this.where = !cur ? 'hidden' : layout ? 'layout' : showStore.world ? 'world' : docked ? 'docked' : 'hidden';
    const vw = window.innerWidth || 1920, vh = window.innerHeight || 1080;
    if (docked) {
      const w = 0.2, h = (w * vw * 1.42) / vh;
      const avoid = [...(place?.pollAvoid() ?? []), ...(pollRect ? [pollRect] : [])];
      this.rect = pickPollDock(avoid, w, h, this.rect);
    }
    const want = docked && this.rect ? 1 : 0;
    this.alpha += (want - this.alpha) * (1 - Math.exp(-dt * 8));
    if (this.alpha < 0.01 && !want) { if (this.canvas.style.opacity !== '0') this.canvas.style.opacity = '0'; return; }
    const r = this.rect;
    if (!r || !cur) { this.canvas.style.opacity = '0'; this.alpha = 0; return; }
    const W = Math.round(r.w * vw), H = Math.round(r.h * vh);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`; this.key = '';
    }
    this.canvas.style.left = `${Math.round(r.x * vw)}px`; this.canvas.style.top = `${Math.round(r.y * vh)}px`;
    this.canvas.style.opacity = this.alpha.toFixed(3);
    this.canvas.style.transform = `scale(${(0.94 + 0.06 * this.alpha).toFixed(3)})`;
    // redraw only when something changed (≤ 20 fps while a purchase banner pulses)
    const key = `${showStore.rev}|${imgRev}|${cur.product?.id ?? ''}|${cur.flash?.id ?? ''}|${this.canvas.width}`;
    if (key === this.key && !cur.flash) return;
    if (cur.flash && now - this.lastDraw < 50) return;
    this.key = key; this.lastDraw = now;
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    drawProductCard(g, this.canvas.width, this.canvas.height, now, cur, { qr: !!v?.qr, shopUrl: v?.shopUrl ?? '' });
  }
}

/** Wire the showcase to an OBS page's bus (+ the state for a page that loads later). */
export function connectShowcase(bus: { on(fn: (m: { type: string; v?: unknown }) => void): unknown }, load: boolean) {
  bus.on((m) => { if (m.type === 'supportShow') showStore.set(m.v); });
  if (load) void fetch('/api/support/showcase').then((r) => (r.ok ? r.json() : null)).then((v) => { if (v && !showStore.view) showStore.set(v); }).catch(() => { /* an older version: no showcase */ });
}

/** ?showcaseDemo=featured|flash on TEST pages only: a local fake showcase (no helper, no network) for screenshots. */
export function showcaseDemo(kind: string) {
  const art = (c1: string, c2: string, label: string) => {
    const c = document.createElement('canvas'); c.width = c.height = 200;
    const g = c.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 200, 200); gr.addColorStop(0, c1); gr.addColorStop(1, c2);
    g.fillStyle = gr; g.fillRect(0, 0, 200, 200);
    g.fillStyle = 'rgba(255,255,255,.92)'; g.font = `800 34px ${FONT}`; g.textAlign = 'center'; g.fillText(label, 100, 112);
    return c.toDataURL('image/png');
  };
  const products: StoreProduct[] = [
    { id: 'demo-hoodie', slug: 'night-owl-hoodie', name: 'Night Owl Hoodie', image: art('#2b1d52', '#ff7a4d', 'HOODIE'), priceMinor: 4500, currency: 'USD', available: true, listed: true, url: 'https://shop.example.com/products/night-owl-hoodie', left: 3 },
    { id: 'demo-mug', slug: 'late-night-mug', name: 'Late Night Mug', image: art('#0f3d3e', '#7bd88f', 'MUG'), priceMinor: 1800, currency: 'USD', available: true, listed: true, url: 'https://shop.example.com/products/late-night-mug' },
  ];
  const v = { on: kind !== 'flash', mode: 'featured', where: 'auto', every: 12, qr: true, shopUrl: 'https://shop.example.com', products, featured: 'demo-hoodie' };
  showStore.set({ ...v, flash: null });
  if (kind === 'flash') {
    const tick = () => showStore.set({ ...v, flash: { id: `demo:${Date.now()}`, product: products[0], itemName: products[0].name, image: products[0].image, who: 'Sam', at: Date.now(), test: true } });
    tick(); setInterval(tick, 9000);
  }
}
