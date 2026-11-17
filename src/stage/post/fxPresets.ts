// Screen FX presets (beta.16 "soundfx" lane, docs/b16/SOUNDFX.md): glitch, VHS, pixelate, shake, glow pop and black & white,
// full-frame, for N seconds, started by the deck / a rule / a key / the Soundboard panel (bus command `screen-fx`).
//
//   * IDLE COST IS ZERO. Nothing runs, allocates or draws until a preset starts; the Pipeline asks FxPass.wanted() (one
//     property read) each frame, and when nothing runs it renders exactly as before. The render target is made on the first
//     use and handed back 2 s after the last preset ended.
//   * ONE PASS. With a preset running, the Pipeline sends its finished picture (after SMAA / FXAA) into this pass's target
//     instead of the canvas, and this pass draws it to the canvas with every running preset applied (shader below).
//   * ALPHA. The Pipeline's output is straight (un-premultiplied) sRGB + coverage, the contract of the transparent OBS
//     page. The pass converts to premultiplied for anything that mixes pixels (slip, colour split, glow) and writes straight
//     again, so silhouettes never gain dark fringes and the OBS hole (alpha 0) stays clear: the glow only lights pixels that
//     are already there and never raises alpha.
//   * FLASH SAFETY (shared/flashGovernor.ts). The only preset that changes brightness over the whole frame, the glow pop, goes
//     through the page's FlashGovernor, and with the limit on a second pop within 340 ms is refused; the noise of glitch /
//     VHS is re-drawn at most every 340 ms (3 a second), and its brightness steps stay far below the 10 % that counts.
//   * LOW GRAPHICS LEVELS have no Pipeline (it exists from High up). Then the preset runs as a CSS animation on the stage
//     canvas (compositor-side, no per-frame script): all but pixelate, which needs the shader.
import * as THREE from 'three';
import { pageGovernor } from '../../../shared/flashGovernor.ts';
import {
  BLOOM_LIFT, FX_COUNT, FX_PRESET_IDS, FX_SAFE_STEP_MS, FxGovern, FxTimeline, fxNoiseTime,
  type FxPresetId,
} from '../../../shared/soundboard.ts';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `
  uniform sampler2D tSrc;
  uniform float uAmt[6];     // glitch, vhs, pixelate, shake, bloom, bw (shared/soundboard.ts FX_PRESET_IDS)
  uniform float uSeed;       // noise time: held in steps while the flash limit is on
  uniform float uT;          // smooth time, for motion
  uniform float uLift;
  uniform vec2 uRes;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
  // straight RGBA in, premultiplied out; outside the picture = nothing
  vec4 tapP(vec2 uv) {
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    vec4 c = texture2D(tSrc, uv);
    return vec4(c.rgb * c.a, c.a);
  }
  void main() {
    float g = uAmt[0], v = uAmt[1], px = uAmt[2], sh = uAmt[3], bl = uAmt[4], bw = uAmt[5];
    vec2 uv = vUv;
    if (sh > 0.0) {
      float k = floor(uT * 30.0);
      uv += vec2(sin(uT * 93.0 + 1.3), cos(uT * 77.0)) * 0.010 * sh + vec2(hash(vec2(k, 1.0)) - 0.5, hash(vec2(k, 2.0)) - 0.5) * 0.006 * sh;
    }
    if (px > 0.0) {
      float cell = mix(1.0, 36.0, px * px * (3.0 - 2.0 * px));
      vec2 c = vec2(cell) / uRes;
      uv = (floor(uv / c) + 0.5) * c;
    }
    float rowBlock = floor(uv.y * 28.0);
    float slip = 0.0, split = 0.0;
    if (g > 0.0) {
      float on = step(1.0 - 0.38 * g, hash(vec2(rowBlock, uSeed * 7.0 + 1.0)));
      slip += (hash(vec2(rowBlock, uSeed * 3.0 + 9.0)) - 0.5) * 0.16 * g * on;
      split += (0.006 + 0.012 * on) * g;
    }
    if (v > 0.0) {
      slip += sin(uv.y * 55.0 + uT * 4.0) * 0.0016 * v;
      float band = fract(uSeed * 0.37);
      slip += step(abs(uv.y - band), 0.03) * (hash(vec2(rowBlock, uSeed)) - 0.5) * 0.05 * v;
      split += 0.0035 * v;
    }
    vec2 b = vec2(uv.x + slip, uv.y);
    vec4 c = tapP(b);
    if (split > 0.0) {
      vec4 cr = tapP(b + vec2(split, 0.0)), cb = tapP(b - vec2(split, 0.0));
      c = vec4(cr.r, c.g, cb.b, max(c.a, max(cr.a, cb.a)));
    }
    if (bl > 0.0) {
      vec2 t1 = vec2(4.0) / uRes, t2 = vec2(11.0) / uRes;
      vec4 acc = vec4(0.0);
      acc += tapP(b + vec2(t1.x, 0.0)) + tapP(b - vec2(t1.x, 0.0)) + tapP(b + vec2(0.0, t1.y)) + tapP(b - vec2(0.0, t1.y));
      acc += tapP(b + t2) + tapP(b - t2) + tapP(b + vec2(t2.x, -t2.y)) + tapP(b + vec2(-t2.x, t2.y));
      // light only what is already visible (alpha is never raised: the OBS hole and the transparent page stay clear)
      c.rgb += (acc.rgb / 8.0) * 0.7 * bl * c.a;
      c.rgb *= 1.0 + uLift * bl;
    }
    float a = c.a;
    vec3 col = a > 1e-4 ? min(c.rgb / a, 1.0) : vec3(0.0);
    if (v > 0.0) {
      col = mix(vec3(luma(col)), col, 1.0 - 0.25 * v);
      col *= mix(vec3(1.0), vec3(1.0, 0.98, 0.93), v) * (1.0 - 0.06 * v * (0.5 + 0.5 * sin(vUv.y * uRes.y * 1.5)));
      col += (hash(vUv * uRes + uSeed) - 0.5) * 0.05 * v;
    }
    if (bw > 0.0) col = mix(col, vec3(luma(col)), bw);
    gl_FragColor = a > 1e-4 ? vec4(clamp(col, 0.0, 1.0), a) : vec4(0.0);
  }`;

// ---------------------------------------------------------------- the controller (one per page)

export type FxStartResult = 'started' | 'limited';
type Listener = (running: boolean) => void;

/** CSS animation fallback for pages without the post pipeline (graphics below High). Runs on the compositor: no per-frame script. */
class FxCss {
  private anims = new Map<string, Animation>();
  private target(): HTMLElement | null { return typeof document === 'undefined' ? null : document.getElementById('stage'); }
  private go(el: HTMLElement, key: string, kf: Keyframe[], ms: number, easing = 'linear') {
    this.anims.get(key)?.cancel();
    const a = el.animate(kf, { duration: ms, easing });
    this.anims.set(key, a);
    a.onfinish = a.oncancel = () => { if (this.anims.get(key) === a) this.anims.delete(key); };
  }
  /** false = this preset has no CSS version (pixelate) or there is no canvas. */
  run(p: FxPresetId, secs: number, safe: boolean): boolean {
    const el = this.target();
    if (!el || typeof el.animate !== 'function' || p === 'pixelate') return false;
    const ms = Math.max(200, secs * 1000);
    // jumps of the whole frame: 12 a second, or (flash limit on) at most 3 a second
    const steps = Math.max(2, Math.min(90, Math.round(secs * (safe ? 1000 / FX_SAFE_STEP_MS : 12))));
    const r = (n: number) => (Math.random() - 0.5) * n;
    const jumps = (x: number, y: number): Keyframe[] => Array.from({ length: steps + 1 }, (_, i) => ({ translate: i === steps ? '0 0' : `${r(x).toFixed(1)}px ${r(y).toFixed(1)}px`, offset: i / steps, easing: 'steps(1, end)' }));
    const hold = (f: string): Keyframe[] => [{ filter: 'none', offset: 0 }, { filter: f, offset: 0.12 }, { filter: f, offset: 0.88 }, { filter: 'none', offset: 1 }];
    if (p === 'bw') this.go(el, p, hold('grayscale(1)'), ms, 'ease-in-out');
    else if (p === 'vhs') this.go(el, p, hold('saturate(0.75) contrast(1.08) sepia(0.2) blur(0.5px)'), ms, 'ease-in-out');
    else if (p === 'bloom') this.go(el, p, [{ filter: 'none', offset: 0 }, { filter: `brightness(${1 + BLOOM_LIFT * 0.8}) saturate(1.25)`, offset: Math.min(0.4, 0.1 / secs) }, { filter: 'none', offset: 1 }], ms, 'ease-out');
    else if (p === 'shake') this.go(el, p, jumps(18, 14), ms);
    else { // glitch: sideways slips and colour flips
      this.go(el, p, jumps(40, 6), ms);
      const hues = ['hue-rotate(40deg) saturate(1.4)', 'none', 'hue-rotate(-30deg) saturate(1.4)', 'none'];
      this.go(el, p + ':hue', Array.from({ length: steps + 1 }, (_, i) => ({ filter: i === steps ? 'none' : hues[i % hues.length], offset: i / steps, easing: 'steps(1, end)' })), ms);
    }
    return true;
  }
  stop() { for (const a of [...this.anims.values()]) a.cancel(); this.anims.clear(); }
}

export class ScreenFxController {
  readonly timeline = new FxTimeline(true);
  private govern = new FxGovern();
  /** Strengths for this frame (read by FxPass). */
  readonly amt = new Float32Array(FX_COUNT);
  seed = 0;
  motion = 0;
  /** performance.now() of the last frame a Pipeline drew a preset (0 = never): tells the CSS fallback to step in. */
  appliedAt = 0;
  /** How many frames the shader pass drew (tests / the panel's "did it work" check). */
  appliedFrames = 0;
  private listeners = new Set<Listener>();
  private css = new FxCss();
  private endT = 0;
  private fallbackT = 0;
  /** How each preset was last shown on this page, for the panel's message ('none' = this page has no way to show it). */
  private via = new Map<FxPresetId, 'shader' | 'css' | 'none'>();
  private scratch = new Float32Array(FX_COUNT);
  viaOf(p: FxPresetId): 'shader' | 'css' | 'none' | null { return this.via.get(p) ?? null; }

  get active(): boolean { return this.timeline.active; }
  /** Called when something starts / the last preset ends. Returns the unsubscribe. */
  onChange(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(running: boolean) { for (const f of [...this.listeners]) { try { f(running); } catch { /* listener */ } } }

  start(p: FxPresetId, secs: number, now = performance.now()): FxStartResult {
    this.timeline.safe = pageGovernor().safe;
    if (!this.timeline.start(p, secs, now)) return 'limited';
    this.via.delete(p);
    this.emit(true);
    // is a pipeline going to draw it? If no frame of one arrives soon, run the CSS version instead
    clearTimeout(this.fallbackT);
    this.fallbackT = window.setTimeout(() => {
      const t = performance.now();
      const piped = this.appliedAt > 0 && t - this.appliedAt < 600;
      for (const id of FX_PRESET_IDS) {
        const left = this.timeline.remainingSecs(id, t);
        if (left <= 0.05 || this.via.has(id)) continue;
        this.via.set(id, piped ? 'shader' : this.css.run(id, left, this.timeline.safe) ? 'css' : 'none');
      }
    }, 260);
    this.schedule(now);
    return 'started';
  }
  stop(p?: FxPresetId) {
    this.timeline.stop(p);
    if (!p) this.css.stop();
    this.schedule(performance.now());
  }
  /** One timer for "the last preset ended" (a page without a pipeline never samples the timeline by itself). */
  private schedule(now: number) {
    clearTimeout(this.endT);
    this.timeline.sample(now, this.scratch);                       // (forgets what ended: a page without a pipeline never samples otherwise)
    const left = this.timeline.lastEndSecs(now);
    if (left <= 0) { this.emit(false); return; }
    this.endT = window.setTimeout(() => this.schedule(performance.now()), Math.ceil(left * 1000) + 40);
  }
  /** The Pipeline's per-frame call while FxPass.wanted(): fills `amt` / `seed` / `motion`. false = nothing left to draw. */
  frame(now: number): boolean {
    this.timeline.safe = pageGovernor().safe;
    const any = this.timeline.sample(now, this.amt);
    if (!any) return false;
    this.govern.apply(this.amt, pageGovernor(performance.timeOrigin + now));
    this.seed = fxNoiseTime(now / 1000, this.timeline.safe) % 1000;
    this.motion = (now / 1000) % 1000;
    this.appliedAt = now; this.appliedFrames++;
    return true;
  }
}
export const screenFx = new ScreenFxController();

/** The tab that asked for "Test" can report this: did a preset really get drawn here? */
export const fxDrawnHere = (p: FxPresetId): boolean => screenFx.viaOf(p) === 'shader' || screenFx.viaOf(p) === 'css';

// ---------------------------------------------------------------- the pass (one per Pipeline)

/** FX pass of one Pipeline (src/stage/post/Pipeline.ts holds the single hook: wanted() / begin() / finish()). */
export class FxPass {
  private mat: THREE.ShaderMaterial | null = null;
  private quad: THREE.Mesh | null = null;
  private scene: THREE.Scene | null = null;
  private cam: THREE.OrthographicCamera | null = null;
  private rt: THREE.WebGLRenderTarget | null = null;
  private idleSince = 0;
  /** Is any preset running on this page? One property read: this is all an idle frame pays. */
  static wanted(): boolean { return screenFx.timeline.active; }

  private ensure() {
    if (this.mat) return;
    this.mat = new THREE.ShaderMaterial({
      name: 'vtp:screenFxPresets', vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { tSrc: { value: null }, uAmt: { value: screenFx.amt }, uSeed: { value: 0 }, uT: { value: 0 }, uLift: { value: BLOOM_LIFT }, uRes: { value: new THREE.Vector2(1, 1) } },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }
  /** Compile the shader at build time so the first preset never stalls the show. */
  warm(renderer: THREE.WebGLRenderer) {
    this.ensure();
    try { renderer.compile(this.scene!, this.cam!); } catch { /* optional */ }
  }
  /** The target the Pipeline's last pass draws into while a preset runs. */
  begin(w: number, h: number): THREE.WebGLRenderTarget {
    this.ensure();
    if (!this.rt) this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.idleSince = 0;
    return this.rt;
  }
  /** Draw the target to `out` (the canvas) with the running presets (a plain copy when the last one just ended). */
  finish(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget | null): void {
    if (!this.mat || !this.rt || !this.scene || !this.cam) return;
    screenFx.frame(performance.now());
    const u = this.mat.uniforms;
    u.tSrc.value = this.rt.texture; u.uSeed.value = screenFx.seed; u.uT.value = screenFx.motion;
    (u.uRes.value as THREE.Vector2).set(this.rt.width, this.rt.height);
    renderer.setRenderTarget(out);
    renderer.render(this.scene, this.cam);
  }
  /** Per idle frame: hand the target back 2 s after the last preset ended. */
  idle(now: number) {
    if (!this.rt) return;
    if (!this.idleSince) this.idleSince = now;
    else if (now - this.idleSince > 2000) { this.rt.dispose(); this.rt = null; }
  }
  get hasTarget(): boolean { return !!this.rt; }
  setSize(w: number, h: number) { this.rt?.setSize(w, h); }
  /** Bytes held by the target (estimate). */
  memoryBytes(): number { return this.rt ? this.rt.width * this.rt.height * 4 : 0; }
  dispose() { this.rt?.dispose(); this.rt = null; this.mat?.dispose(); this.quad?.geometry.dispose(); this.mat = null; this.quad = null; this.scene = null; this.cam = null; }
}

