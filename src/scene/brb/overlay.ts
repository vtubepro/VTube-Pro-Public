// The BRB overlay (shared/brb.ts): a black layer + the BRB card canvas over a page. OBS pages / the Scene-tab preview
// (src/output.ts, full frame) and the Live program monitor (src/ui/live/liveControl.ts) each own one. BRB on → fade to
// black, then the card fades in on the black and loops; BRB off → the card goes, the black fades back to the scene.
// A page that (re)loads while BRB is on shows it at once (no fade). Costs nothing while BRB is off (no loop, hidden).
import { BRB_CARD_S, BRB_FADE_S, DEFAULT_BRB, brbBgUrl, brbFade, sanitizeBrbState, type SceneBrbState } from '../../../shared/brb.ts';
import { brbMediaOf, drawBrbCard } from './card.ts';

/** Your own BRB background (an <img> / a MUTED looping <video>, never in the page), one per URL. */
const media = new Map<string, HTMLImageElement | HTMLVideoElement>();
export function brbMediaEl(b: SceneBrbState): HTMLImageElement | HTMLVideoElement | null {
  if (!b.bg) return null;
  const url = brbBgUrl(b.bg);
  let m = media.get(url);
  if (!m) {
    for (const [u, old] of media) { if (old instanceof HTMLVideoElement) { old.pause(); old.removeAttribute('src'); old.load(); } media.delete(u); }
    if (b.bg.kind === 'video') {
      const v = document.createElement('video');
      v.muted = true; v.defaultMuted = true; v.volume = 0; v.loop = true; v.playsInline = true; v.preload = 'auto';
      v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
      v.src = url;
      m = v;
    } else { const i = new Image(); i.decoding = 'async'; i.src = url; m = i; }
    media.set(url, m);
  }
  return m;
}

export interface BrbInput { lights?: { state?: unknown }; brb?: unknown }

export class BrbOverlay {
  readonly el: HTMLDivElement;
  private black: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private on = false;
  private first = true;
  private at = 0;          // performance.now() of the last switch
  private look: SceneBrbState = { ...DEFAULT_BRB };
  private raf = 0;
  /** Test hook: a fixed clock (ms) instead of performance.now(). */
  now: () => number = () => performance.now();

  constructor(host: HTMLElement, opts: { fixed?: boolean; z?: number; maxW?: number } = {}) {
    const pos = opts.fixed ? 'fixed' : 'absolute';
    this.el = document.createElement('div');
    this.el.className = 'vtp-brb';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = `position:${pos};inset:0;pointer-events:none;z-index:${opts.z ?? 9000};display:none;border-radius:inherit;overflow:hidden`;
    this.black = document.createElement('div');
    this.black.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0';
    this.cv = document.createElement('canvas');
    this.cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0';
    this.maxW = opts.maxW ?? 1920;
    this.el.append(this.black, this.cv);
    host.append(this.el);
  }
  private maxW: number;

  /** The scene state (or the deck live state's lighting + brb look) changed. */
  setState(s: BrbInput | null | undefined) {
    const on = s?.lights?.state === 'brb';
    const look = sanitizeBrbState(s?.brb);
    const lookChanged = JSON.stringify(look) !== JSON.stringify(this.look);
    this.look = look;
    if (on !== this.on) {
      // (switched mid-fade: start the new fade from where the old one is, so nothing jumps)
      const now = this.now();
      const cur = brbFade(this.on, (now - this.at) / 1000);
      this.on = on;
      const cardOut = BRB_CARD_S * 0.6 * 1000;
      this.at = this.first ? now - 60_000
        : on ? now - cur.black * BRB_FADE_S * 1000
        : cur.black >= 1 ? now - (1 - cur.card) * cardOut     // the card goes first, from wherever it is
        : now - cardOut - (1 - cur.black) * BRB_FADE_S * 1000;
      this.start();
    } else if (lookChanged && on) this.start();
    this.first = false;
  }
  /** Current opacities (tests / debug). */
  get fade() { return brbFade(this.on, (this.now() - this.at) / 1000); }
  get isOn() { return this.on; }
  /** The black layer is fully up on screen (BRB on, the fade done AND applied to the DOM): the page behind it cannot be
   *  seen, so the page may skip drawing its 3D scene. False from the very call that turns BRB off, so the fade-out
   *  reveals a live frame. */
  get opaque() { return this.on && this.shownBlack >= 1 && this.fade.black >= 1; }
  /** The black opacity last written to the DOM (opaque must never run ahead of what is really on screen). */
  private shownBlack = 0;

  private start() { if (!this.raf) this.raf = requestAnimationFrame(this.frame); }
  private last = 0;
  private frame = (ms: number) => {
    this.raf = 0;
    const f = this.fade;
    this.el.style.display = f.black > 0.001 || f.card > 0.001 ? '' : 'none';
    this.black.style.opacity = String(f.black);
    this.shownBlack = f.black;
    this.cv.style.opacity = String(f.card);
    if (f.card > 0.001 && ms - this.last > 30) { this.last = ms; this.draw((this.now() - this.at) / 1000); }
    const fading = this.on ? f.card < 1 : f.black > 0;
    if (!this.on && f.card <= 0.001) { const m = brbMediaEl(this.look); if (m && m instanceof HTMLVideoElement && !m.paused) m.pause(); }
    if (this.on || fading) this.raf = requestAnimationFrame(this.frame);
  };
  private draw(t: number) {
    const r = this.el.getBoundingClientRect();
    const k = Math.min(1, this.maxW / Math.max(1, r.width));
    const W = Math.max(64, Math.round(r.width * k)), H = Math.max(36, Math.round(r.height * k));
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const ctx = this.cv.getContext('2d');
    const m = brbMediaEl(this.look);
    if (m && m instanceof HTMLVideoElement && m.paused) { m.muted = true; void m.play().catch(() => {}); }
    if (ctx) drawBrbCard(ctx, W, H, this.look, t, brbMediaOf(m));
  }
  destroy() { cancelAnimationFrame(this.raf); this.el.remove(); }
}
