// The capture cover layer (docs/SCENES.md → "Capture cover"): one Canvas2D card, sized to the capture area on this page,
// uploaded as ONE CanvasTexture that every capture surface samples (coverUniforms):
//   - the React screens (big SCREEN + solo side screen, src/scene/screenFx.ts): the card is drawn ON the screen mesh —
//     over the in-scene capture AND over the OBS passthrough hole (the hole turns opaque) — so perspective, camera moves
//     and performers standing in front stay right (depth-tested: models are never covered);
//   - the stage layouts' capture rect (React Full / Medium, Gaming, src/scene/stage/frameFx.ts drawCover): drawn after
//     the frame pass, never over a cam (cut-out cams: only behind the avatar).
// Phases: off → in → hold (loops until the host turns it off; nothing auto-dismisses) → out → off.
import * as THREE from 'three';
import { DEFAULT_CAPCOVER, sanitizeCaptureCover, type SceneCaptureCover } from '../../../shared/capcover.ts';
import type { CoverFrame, CoverPhase, CoverStyleDef } from './kit.ts';
import { coverStyle } from './styles.ts';
import { coverUniforms } from './uniforms.ts';

/** Largest canvas we draw (px); the card is re-drawn at 30 fps while holding, every frame while animating in / out. */
const MAX_W = 2560, MAX_H = 1440, MIN_H = 270;

export class CaptureCover {
  readonly canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private tex: THREE.CanvasTexture | null = null;
  state: SceneCaptureCover = { ...DEFAULT_CAPCOVER };
  phase: CoverPhase | 'off' = 'off';
  p = 0;
  private t = 0;
  private th = 0;
  private style: CoverStyleDef = coverStyle(DEFAULT_CAPCOVER.style);
  private seed = 1;
  private since = 1;
  private booted = false;
  /** Style / text changed: redraw on the next update even while holding at 30 fps. */
  private dirty = true;
  /** Test pages: a local override of the host's state (vtpOut.cover.set). */
  local: SceneCaptureCover | null = null;

  /** The host's state (SceneState.capcover). The page's first state with the cover on starts fully covered (an OBS
   *  refresh never shows the capture while the host is still setting up). */
  setState(s: SceneCaptureCover | undefined | null) {
    this.host = sanitizeCaptureCover(s ?? DEFAULT_CAPCOVER);
    this.apply(this.local ?? this.host);
  }
  private host: SceneCaptureCover = { ...DEFAULT_CAPCOVER };
  private apply(st: SceneCaptureCover) {
    const boot = !this.booted;
    this.booted = true;
    if (st.style !== this.state.style || st.text !== this.state.text) this.dirty = true;
    this.state = st;
    this.style = coverStyle(st.style);
    if (st.on) {
      if (this.phase === 'off') {
        this.seed = (Math.random() * 1e9) | 0;
        if (boot) { this.phase = 'hold'; this.p = 0; this.t = 0; this.th = 0; } else { this.phase = 'in'; this.p = 0; this.t = 0; this.th = 0; }
      } else if (this.phase === 'out') { this.phase = 'in'; this.p = Math.max(0, 1 - this.p); }
    } else if (this.phase === 'hold') { this.phase = 'out'; this.p = 0; }
    else if (this.phase === 'in') { this.phase = 'out'; this.p = Math.max(0, 1 - this.p); }
  }
  /** Test pages: cover locally (never the host's state). null = follow the host again. */
  setLocal(s: Partial<SceneCaptureCover> | null) {
    this.local = s ? sanitizeCaptureCover({ ...this.state, ...s }) : null;
    this.apply(this.local ?? this.host);
  }

  /** Anything drawn this frame (the surfaces sample the card). */
  get visible() { return this.phase !== 'off'; }
  /** Fully covering (hold, or the ends of in / out). */
  get opaque() { return this.phase === 'hold' || (this.phase === 'in' && this.p >= 1) || (this.phase === 'out' && this.p <= 0); }
  get styleId() { return this.style.id; }

  /** Once per rendered frame, before the draw. `wPx × hPx` = the capture area on this page (device px; 0 = unknown). */
  update(dt: number, wPx: number, hPx: number, show = true) {
    dt = Math.min(0.1, Math.max(0, dt));
    if (this.phase === 'off') { coverUniforms.uCoverOn.value = 0; return; }
    this.t += dt;
    if (this.phase === 'in') { this.p = Math.min(1, this.p + dt / Math.max(0.05, this.style.inDur)); if (this.p >= 1) { this.phase = 'hold'; this.th = 0; } }
    else if (this.phase === 'hold') this.th += dt;
    else if (this.phase === 'out') { this.p = Math.min(1, this.p + dt / Math.max(0.05, this.style.outDur)); if (this.p >= 1) { this.phase = 'off'; coverUniforms.uCoverOn.value = 0; return; } }
    if (!show && this.tex) { coverUniforms.uCoverOn.value = 1; return; }   // no capture area in this shot: phases only
    // canvas size: the capture's px size (aspect kept), in steps so a morphing rect doesn't realloc every frame
    let w = wPx > 8 ? wPx : 1280, h = hPx > 8 ? hPx : 720;
    const k = Math.min(1, MAX_W / w, MAX_H / h), kk = h * k < MIN_H ? MIN_H / h : k;
    w *= kk; h *= kk;
    const qh = Math.max(MIN_H, Math.ceil(h / 90) * 90), qw = Math.max(16, Math.round((qh * w) / h / 8) * 8);
    let resized = false;
    if (Math.abs(qw - this.canvas.width) > 8 || qh !== this.canvas.height || !this.tex) {
      this.canvas.width = qw; this.canvas.height = qh;
      this.tex?.dispose();
      const t = new THREE.CanvasTexture(this.canvas);
      t.colorSpace = THREE.SRGBColorSpace;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
      this.tex = t;
      coverUniforms.uCover.value = t;
      resized = true;
    }
    coverUniforms.uCoverOn.value = 1;
    // redraw: every frame while animating, 30 fps while holding (a looping cartoon reads fine; halves the upload cost)
    this.since += dt;
    if (!resized && !this.dirty && this.phase === 'hold' && this.since < 1 / 30 - 1e-3) return;
    this.since = 0; this.dirty = false;
    this.draw();
    this.tex!.needsUpdate = true;
  }

  private draw() {
    const { canvas, ctx } = this;
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0; ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    const u = Math.min(w / 1920, h / 1080);
    const f: CoverFrame = { ctx, w, h, u, ox: (w - 1920 * u) / 2, oy: (h - 1080 * u) / 2, phase: this.phase as CoverPhase, p: this.p, t: this.t, th: this.th, text: this.state.text, seed: this.seed };
    try { ctx.save(); this.style.draw(f); ctx.restore(); }
    catch (e) {
      ctx.restore();
      console.warn('[capcover] style', this.style.id, e);
      // never leak because a style threw: a plain opaque card
      if (this.phase === 'hold' || this.opaque) { ctx.fillStyle = '#0e1015'; ctx.fillRect(0, 0, w, h); }
    }
  }

  /** Status for tests / the preview report. */
  info() { return { phase: this.phase, p: +this.p.toFixed(3), style: this.style.id, on: this.state.on, text: this.state.text, canvas: [this.canvas.width, this.canvas.height] }; }
}

/** One per page (the OBS page / preview draws it; the style cards in the studio draw the styles themselves). */
export const capCover = new CaptureCover();

/** Mini preview for the studio's style cards (moved to ./mini.ts: the Live panel's Privacy tab draws it without three.js). */
export { drawCoverMini } from './mini.ts';
