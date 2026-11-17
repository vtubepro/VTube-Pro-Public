// Glasses: detect them from the camera, and keep eyes believable through them.
//
// 1. Detection (glassesStat, GlassesState). Frames, bridges and rims are thin lines across places where a bare face has
//    smooth skin: the nose bridge just below the brows, and the cheek just under each lower lid. A thin-bar detector
//    (a pixel row darker or brighter than the rows ~2 px above and below it) along short vertical profiles there,
//    against the same detector on the forehead (skin texture, wrinkles, hair), gives a raw score; a slow average with
//    hysteresis (on ≥ 0.55 for ~1 s, off ≤ 0.35 for ~2 s) decides. It runs on the face-region pixels the facial-hair
//    detector already reads ~1×/s (mouthGeometry.ts FacialHairDetector): no extra camera readback.
// 2. Eye reliability (EyeTrust). Lenses bring reflections (a bright patch the lid landmarks snap to), minus lenses shrink
//    the eye, rims cross the lids: per eye, how much its two blink cues (MediaPipe's eyeBlink and the lid-landmark eye
//    aspect ratio) disagree and how much its iris jumps between frames → a 0..1 trust. The face solver leans on the cue
//    that agrees, links the eyes when one is untrustworthy, eases gaze toward the head's own direction and, when
//    neither eye can be trusted for a while, blinks naturally on its own (a stuck-shut or never-blinking avatar reads
//    worse than a plausible blink).
// Pure (no DOM): tools/eval_glasses.ts replays both on the recorded clip with synthetic glasses drawn in.

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Landmarks the glasses profiles read (they must be inside the face-region crop). */
export const GLASSES_IDS = [9, 151, 168, 6, 197, 145, 374, 50, 280, 33, 263, 133, 362, 159, 386, 10];

type Lm = { x: number; y: number }[];

/**
 * Raw glasses score 0..1 from luminance pixels. `img` = RGBA of the face-region crop (`cw` wide, its top-left at x0, y0
 * of a `w` × `h` frame), `lm` = normalised landmarks. null = can't judge (too dark / off the crop).
 */
export function glassesStat(img: ArrayLike<number>, lm: Lm, x0: number, y0: number, cw: number, ch: number, w: number, h: number): { score: number; bridge: number; rims: number; base: number } | null {
  const Y = (x: number, y: number) => {
    const xi = Math.round(x) - x0, yi = Math.round(y) - y0;
    if (xi < 0 || yi < 0 || xi >= cw || yi >= ch) return NaN;
    const o = (yi * cw + xi) * 4;
    return 0.2126 * img[o] + 0.7152 * img[o + 1] + 0.0722 * img[o + 2];
  };
  const P = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h });
  // thin-bar contrast along a vertical profile from a to b (band ±1 px wide), max over the profile
  const bar = (a: { x: number; y: number }, b: { x: number; y: number }, d = 2) => {
    const n = Math.max(3, Math.round(Math.abs(b.y - a.y)));
    let best = 0, ok = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      let c = 0, m = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const v = Y(x + dx, y), up = Y(x + dx, y - d), dn = Y(x + dx, y + d);
        if (!Number.isFinite(v) || !Number.isFinite(up) || !Number.isFinite(dn)) continue;
        c += Math.abs(v - (up + dn) / 2); m++;
      }
      if (m) { ok++; best = Math.max(best, c / m); }
    }
    return ok >= 3 ? best : NaN;
  };
  const eyeSpan = Math.hypot(P(263).x - P(33).x, P(263).y - P(33).y);
  if (!(eyeSpan > 8)) return null; // the face is too small in the picture to judge
  // skin level: the cheeks and the forehead
  let skin = 0, ns = 0;
  for (const i of [50, 280, 151]) { const p = P(i), v = Y(p.x, p.y); if (Number.isFinite(v)) { skin += v; ns++; } }
  if (!ns || skin / ns < 25) return null;
  skin /= ns;
  // nose bridge: from just above the brow line (between 9 and 168) down to 6 — the frame's bridge crosses here
  const p9 = P(9), p168 = P(168), p6 = P(6);
  const bridge = bar({ x: (p9.x + p168.x) / 2, y: (p9.y + p168.y) / 2 }, p6);
  // lower rims: from a little under each lower lid (clear of the lower lashes) down ~0.4 eye spans (the cheek under the eye)
  const rim = (lid: number) => { const p = P(lid); return bar({ x: p.x, y: p.y + eyeSpan * 0.12 }, { x: p.x, y: p.y + eyeSpan * 0.4 }); };
  const rL = rim(374), rR = rim(145);
  // reference: the same detector on the forehead (skin texture, wrinkles, stray hair)
  const p151 = P(151), p10 = P(10);
  const base = bar({ x: p151.x, y: (p151.y + p10.y) / 2 }, { x: p151.x, y: p151.y + (p9.y - p151.y) * 0.7 });
  const rims = [rL, rR].filter(Number.isFinite);
  if (!Number.isFinite(bridge) && !rims.length) return null;
  const ref = (Number.isFinite(base) ? base : 0) + skin * 0.03;
  const rimV = rims.length ? rims.reduce((a, b) => a + b, 0) / rims.length : 0;
  const br = Number.isFinite(bridge) ? bridge : rimV;
  // a frame shows as a bar at the bridge AND under the eyes: both must stand out from the skin texture (one alone — a
  // lash line, a crease — stays under the 0.55 "on" bar)
  const sb = clamp01((br / ref - 1.2) / 1.6), sr = clamp01((rimV / ref - 1.2) / 1.6);
  return { score: clamp01(0.2 * sb + 0.2 * sr + 0.7 * Math.min(sb, sr)), bridge: br / ref, rims: rimV / ref, base: ref };
}

/** Glasses on / off with a slow average and hysteresis (raw scores arrive ~1×/s). */
export class GlassesState {
  score = 0;
  on = false;
  private n = 0;
  private hi = 0;
  private lo = 0;
  /** feed one raw score; dt = seconds since the last one */
  update(raw: number, dt = 1): boolean {
    const k = this.n < 4 ? 0.5 : 1 - Math.exp(-dt / 2);
    this.score += (raw - this.score) * k;
    this.n++;
    if (!this.on) { this.hi = this.score >= 0.55 ? this.hi + dt : 0; if (this.hi >= 1 || (this.n <= 3 && this.score >= 0.7)) { this.on = true; this.lo = 0; } }
    else { this.lo = this.score <= 0.35 ? this.lo + dt : 0; if (this.lo >= 2) { this.on = false; this.hi = 0; } }
    return this.on;
  }
  reset() { this.score = 0; this.on = false; this.n = 0; this.hi = 0; this.lo = 0; }
}

/**
 * Per-eye trust 0..1 from the two blink cues' disagreement and iris jumpiness (both smoothed over ~0.5 s). `bs` / `ear`
 * = the eye's normalised closure from the blendshape / the eye aspect ratio (0 open … 1 shut), `iris` = iris position
 * (eye-width units). A real blink moves both cues together; a reflection or a rim moves one.
 */
export class EyeTrust {
  dis = [0, 0];
  jump = [0, 0];
  trust = [1, 1];
  private prevIris: ([number, number] | null)[] = [null, null];
  /** `fast`: (glasses on) a disagreement drops the trust at once (a glare lasts a few frames) and recovers over ~0.5 s;
   *  otherwise both ways over ~0.5 s. */
  step(side: 0 | 1, bs: number, ear: number, iris: [number, number] | null, dt: number, fast = false): number {
    const k = 1 - Math.exp(-dt / 0.5);
    const d = Math.abs(bs - ear);
    this.dis[side] += (d - this.dis[side]) * (fast && d > this.dis[side] ? 1 - Math.exp(-dt / 0.02) : k);
    let j = 0;
    const pi = this.prevIris[side];
    if (iris && pi) j = Math.hypot(iris[0] - pi[0], iris[1] - pi[1]) / Math.max(dt * 60, 0.5); // per 60 Hz frame
    this.prevIris[side] = iris;
    this.jump[side] += (j - this.jump[side]) * k;
    // (a calm open eye: dis ~0.05-0.1, jump ~0.01-0.02 of the eye width per frame)
    return this.trust[side] = clamp01(1 - (this.dis[side] - 0.18) / 0.3) * clamp01(1 - (this.jump[side] - 0.05) / 0.08);
  }
}

/** Natural blinks for eyes the camera can't read: every 2.5-6 s (deterministic sequence), 70 ms close, 150 ms open. */
export class AutoBlink {
  private t = 0;
  private next = 3;
  private seed = 12345;
  private rnd() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  step(dt: number): number {
    this.t += dt;
    const s = this.t - this.next;
    if (s > 0.3) { this.t = 0; this.next = 2.5 + 3.5 * this.rnd(); return 0; }
    if (s < 0) return 0;
    return s < 0.07 ? s / 0.07 : s < 0.1 ? 1 : Math.max(0, 1 - (s - 0.1) / 0.15);
  }
}
