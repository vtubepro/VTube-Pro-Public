// Emote rain, the OBS page's drawing (docs/b16/EMOTE_RAIN.md). One transparent canvas over the picture, every emote is
// pre-drawn once into a small picture and then only blitted (no text layout, no allocation per frame). Chat lines for the
// lane are drawn once into a picture each. A second canvas BEHIND the 3D picture is made only when the chat lane asked
// for "behind" (it shows with the see-through OBS background; in a room the room would cover it, so the driver sends it
// to the front canvas there).
//
// Idle = nothing: the canvases are created when the first picture is drawn and removed again when the sky is empty.
// Images come through this PC's helper (/api/chat/img) so the canvas is never tainted; none is stored anywhere.
import type { FlyLane, RainKey, RainWorld, LaneLine } from '../../../shared/emoteRain.ts';
import type { RainPainter } from './driver.ts';

/** Just under the room's own overlays (stage 40 / hud 41), above the flat layer (3) and the AFK / audience cards (4, 5). */
const Z_FRONT = '6';
const SPRITE_PX = 96;
const LOAD_TIMEOUT_MS = 6000;
/** Chat line pictures are drawn for a 1080-high frame; the canvas scales them. */
const REF_H = 1080;
const MAX_BACKING_W = 1920;

const emoteSrc = (u: string) => (u.startsWith('/') && !u.startsWith('//') ? u : `/api/chat/img?u=${encodeURIComponent(u)}`);

interface Sprite { c: HTMLCanvasElement; /** width / height of the picture */ ratio: number }
interface LineSprite { c: HTMLCanvasElement }

function readable(color: string | undefined): string {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return '#ffd166';
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum >= 0.5) return color;
  const mix = (v: number) => Math.round(v + (255 - v) * 0.55).toString(16).padStart(2, '0');
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

export function createCanvasPainter(): RainPainter {
  let nextSprite = 1, nextLine = 1;
  const sprites = new Map<number, Sprite>();
  const lines = new Map<number, LineSprite>();
  const imgs = new Map<string, Promise<HTMLImageElement | null>>();
  let front: HTMLCanvasElement | null = null;
  let back: HTMLCanvasElement | null = null;
  let dead = false;

  const mkCanvas = (z: string) => {
    const c = document.createElement('canvas');
    c.className = 'vtp-emote-rain';
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${z};display:block`;
    document.body.append(c);
    return c;
  };
  /** Backing size follows the page (capped at 1920 wide). Returns the height in px = one frame unit. */
  const fit = (c: HTMLCanvasElement) => {
    const W = Math.max(2, window.innerWidth), H = Math.max(2, window.innerHeight);
    const w = Math.min(W, MAX_BACKING_W), h = Math.max(2, Math.round(w * (H / W)));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return h;
  };

  /** Load a picture once (shared by the rain and the lane); null = failed. */
  const image = (url: string): Promise<HTMLImageElement | null> => {
    let p = imgs.get(url);
    if (p) return p;
    p = new Promise((res) => {
      const im = new Image();
      im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
      const t = window.setTimeout(() => { im.onload = im.onerror = null; res(null); }, LOAD_TIMEOUT_MS);
      im.onload = () => { clearTimeout(t); res(im.naturalWidth > 0 ? im : null); };
      im.onerror = () => { clearTimeout(t); res(null); };
      im.src = emoteSrc(url);
    });
    imgs.set(url, p);
    if (imgs.size > 120) { const first = imgs.keys().next().value; if (first !== undefined) imgs.delete(first); }
    return p;
  };

  const spriteFromImage = (im: HTMLImageElement): Sprite => {
    const ratio = Math.max(0.25, Math.min(4, im.naturalWidth / Math.max(1, im.naturalHeight)));
    const c = document.createElement('canvas');
    c.width = ratio >= 1 ? SPRITE_PX : Math.round(SPRITE_PX * ratio);
    c.height = ratio >= 1 ? Math.round(SPRITE_PX / ratio) : SPRITE_PX;
    c.getContext('2d')?.drawImage(im, 0, 0, c.width, c.height);
    return { c, ratio };
  };
  const spriteFromGlyph = (g: string): Sprite => {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE_PX;
    const x = c.getContext('2d');
    if (x) {
      x.font = `${Math.round(SPRITE_PX * 0.78)}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(g, SPRITE_PX / 2, SPRITE_PX * 0.55);
    }
    return { c, ratio: 1 };
  };

  const painter: RainPainter = {
    load(key: RainKey, done) {
      if (dead) { done(-1); return; }
      if (key.startsWith('g:')) { const id = nextSprite++; sprites.set(id, spriteFromGlyph(key.slice(2))); done(id); return; }
      if (!key.startsWith('u:')) { done(-1); return; }
      void image(key.slice(2)).then((im) => {
        if (dead || !im) { done(-1); return; }
        const id = nextSprite++;
        sprites.set(id, spriteFromImage(im));
        done(id);
      });
    },
    free(id) { sprites.delete(id); },

    loadLine(line: LaneLine, done) {
      if (dead) { done(-1, 0, 0); return; }
      const urls = line.parts.filter((p): p is { t: 'emote'; n: string; u: string } => p.t === 'emote').map((p) => p.u);
      void Promise.all(urls.map((u) => image(u))).then((loaded) => {
        if (dead) { done(-1, 0, 0); return; }
        const byUrl = new Map<string, HTMLImageElement | null>(urls.map((u, i) => [u, loaded[i]]));
        const c = drawLine(line, byUrl);
        if (!c) { done(-1, 0, 0); return; }
        const id = nextLine++;
        lines.set(id, { c });
        done(id, c.width / REF_H, c.height / REF_H);
      });
    },
    freeLine(handle) { lines.delete(handle); },

    draw(world: RainWorld, lane: FlyLane, behind: boolean) {
      if (dead) return;
      const hasRain = world.active > 0, hasLane = lane.active > 0;
      if (!hasRain && !hasLane) { this.idle(); return; }
      // front canvas: the rain, and the lane unless it goes behind
      const wantFront = hasRain || (hasLane && !behind), wantBack = hasLane && behind;
      if (wantFront) { front ??= mkCanvas(Z_FRONT); } else if (front) { front.remove(); front = null; }
      if (wantBack) { back ??= mkCanvas('-1'); } else if (back) { back.remove(); back = null; }
      if (front) {
        const k = fit(front), g = front.getContext('2d');
        if (g) {
          g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, front.width, front.height);
          drawRain(g, world, k);
          if (!behind) drawLane(g, lane, k);
        }
      }
      if (back) {
        const k = fit(back), g = back.getContext('2d');
        if (g) { g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, back.width, back.height); drawLane(g, lane, k); }
      }
    },
    idle() {
      if (front) { front.remove(); front = null; }
      if (back) { back.remove(); back = null; }
    },
    dispose() { dead = true; this.idle(); sprites.clear(); lines.clear(); imgs.clear(); },
  };

  /** Falling and resting emotes: one blit each, in frame units (1 = the picture's height). */
  function drawRain(g: CanvasRenderingContext2D, w: RainWorld, k: number) {
    for (let i = 0; i < w.cap; i++) {
      if (!w.state[i]) continue;
      const s = sprites.get(w.sprite[i]);
      if (!s) continue;
      const r = w.r[i] * w.scaleOf(i);
      const ww = s.ratio >= 1 ? 2 * r : 2 * r * s.ratio, hh = s.ratio >= 1 ? (2 * r) / s.ratio : 2 * r;
      const cs = Math.cos(w.rot[i]) * k, sn = Math.sin(w.rot[i]) * k;
      g.setTransform(cs, sn, -sn, cs, w.x[i] * k, w.y[i] * k);
      g.globalAlpha = w.alphaOf(i);
      g.drawImage(s.c, -ww / 2, -hh / 2, ww, hh);
    }
    g.globalAlpha = 1;
  }
  function drawLane(g: CanvasRenderingContext2D, l: FlyLane, k: number) {
    g.setTransform(k, 0, 0, k, 0, 0);
    g.globalAlpha = 1;
    for (let i = 0; i < l.cap; i++) {
      if (!l.alive[i]) continue;
      const s = lines.get(l.handle[i]);
      if (s) g.drawImage(s.c, l.x[i], l.y[i], l.w[i], l.h[i]);
    }
  }

  /** One chat line as a picture: a soft dark pill, the name in its colour, the text outlined, emotes inline. Text only ever
   *  goes in through fillText (never as HTML). */
  function drawLine(line: LaneLine, byUrl: Map<string, HTMLImageElement | null>): HTMLCanvasElement | null {
    const FS = 34, H = Math.round(FS * 1.55), PAD = 16;
    const font = `600 ${FS}px "Segoe UI","Noto Sans",system-ui,sans-serif`, bold = `800 ${FS}px "Segoe UI","Noto Sans",system-ui,sans-serif`;
    const m = document.createElement('canvas').getContext('2d');
    if (!m) return null;
    const EM = Math.round(FS * 1.2);
    m.font = bold;
    const nameText = `${line.user}: `;
    const nameW = m.measureText(nameText).width;
    m.font = font;
    let w = PAD + nameW;
    const draw: ({ t: 'text'; v: string; x: number } | { t: 'emote'; im: HTMLImageElement | null; n: string; x: number; w: number })[] = [];
    for (const p of line.parts) {
      if (p.t === 'text') { const tw = m.measureText(p.v).width; draw.push({ t: 'text', v: p.v, x: w }); w += tw; }
      else {
        const im = byUrl.get(p.u) ?? null;
        const ew = im ? EM * Math.min(2, Math.max(0.5, im.naturalWidth / Math.max(1, im.naturalHeight))) : m.measureText(p.n).width;
        draw.push({ t: 'emote', im, n: p.n, x: w, w: ew }); w += ew + 3;
      }
    }
    w = Math.ceil(w + PAD);
    if (w > 1700) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = H;
    const g = c.getContext('2d');
    if (!g) return null;
    g.fillStyle = 'rgba(14,12,22,0.5)';
    g.beginPath();
    if (typeof g.roundRect === 'function') g.roundRect(0, 4, w, H - 8, (H - 8) / 2); else g.rect(0, 4, w, H - 8);
    g.fill();
    g.textBaseline = 'middle'; g.lineJoin = 'round'; g.lineWidth = 5; g.strokeStyle = 'rgba(0,0,0,0.85)';
    const cy = H / 2 + 1;
    g.font = bold; g.fillStyle = readable(line.color);
    g.strokeText(nameText, PAD, cy); g.fillText(nameText, PAD, cy);
    g.font = font; g.fillStyle = '#ffffff';
    for (const d of draw) {
      if (d.t === 'text') { g.strokeText(d.v, d.x, cy); g.fillText(d.v, d.x, cy); }
      else if (d.im) g.drawImage(d.im, d.x, cy - EM / 2, d.w, EM);
      else { g.strokeText(d.n, d.x, cy); g.fillText(d.n, d.x, cy); }
    }
    return c;
  }

  return painter;
}
