// Geometric mouth measurement + facial-hair detection.
//
// MediaPipe's mouth blendshapes are inferred from the whole lower face; beards, moustaches and
// stubble hide the jaw/chin/cheek cues they rely on, so smiles, frowns and jaw opens under-read.
// The LIP landmarks themselves still track well. Here we measure the lips directly in a head-aligned
// frame built only from beard-free landmarks (eye corners + nose), so the numbers are pose- and
// distance-invariant, then express them as ARKit-like channels to fuse with the blendshapes.

import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { cameraPixelsOk } from '../core/readbackProbe.ts';
import { GLASSES_IDS, glassesStat } from './glasses.ts';

// landmark ids (person's anatomical sides)
const L = {
  eyeOuterR: 33, eyeOuterL: 263, noseBase: 2, eyesMid: 168,
  cornerR: 61, cornerL: 291, upperInner: 13, lowerInner: 14, upperOuter: 0, lowerOuter: 17,
  upperOuterR: 40, upperOuterL: 270, lowerOuterR: 91, lowerOuterL: 321,
  faceEdgeR: 234, faceEdgeL: 454, cheekR: 205, cheekL: 425,
};

export interface MouthFeatures {
  /** Lip corner heights relative to the lip centre line (+ = up). */
  liftL: number; liftR: number;
  /** Lip corner distance from the nose line (+ = outward). */
  halfL: number; halfR: number;
  width: number;
  gap: number; // inner lip opening
  upper: number; // upper outer lip height (relative to nose base)
  lower: number; // lower outer lip height
  thickU: number; thickL: number; // visible lip thickness
  protrude: number; // lip centre depth relative to corners (+ = toward camera)
  shift: number; // mouth centre x (+ = person's left)
  cheekW: number; // face width at cheek level (cheek puff)
}

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V) => scale(a, 1 / (len(a) || 1));
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Measure the mouth. `aspect` = video width/height (landmark x/z are in width units, y in height units). */
export function measureMouth(lm: NormalizedLandmark[], aspect: number): MouthFeatures {
  // pixel-proportional 3D points (x, up, toward-camera)
  const P = (i: number): V => [lm[i].x * aspect, -lm[i].y, -lm[i].z * aspect];
  const eR = P(L.eyeOuterR), eL = P(L.eyeOuterL);
  const s = len(sub(eL, eR)) || 1;
  const X = norm(sub(eL, eR)); // toward the person's left (image right)
  const origin = P(L.noseBase);
  const eyeMid: V = scale([eR[0] + eL[0], eR[1] + eL[1], eR[2] + eL[2]], 0.5);
  let Y = sub(eyeMid, origin);
  Y = norm(sub(Y, scale(X, dot(Y, X))));
  const Z = cross(X, Y);
  const q = (i: number): V => { const d = sub(P(i), origin); return [dot(d, X) / s, dot(d, Y) / s, dot(d, Z) / s]; };

  const cL = q(L.cornerL), cR = q(L.cornerR);
  const ui = q(L.upperInner), li = q(L.lowerInner), uo = q(L.upperOuter), lo = q(L.lowerOuter);
  // Corner height reference: mostly the UPPER lip. The jaw carries the lower lip down when talking,
  // so measuring against the lip centre would read every open vowel as a smile (verified on clips).
  const refY = ui[1] * 0.75 + li[1] * 0.25;
  const centreX = (cL[0] + cR[0]) / 2;
  const fL = q(L.faceEdgeL), fR = q(L.faceEdgeR);
  return {
    liftL: cL[1] - refY,
    liftR: cR[1] - refY,
    halfL: cL[0],
    halfR: -cR[0],
    width: cL[0] - cR[0],
    gap: Math.max(0, ui[1] - li[1]),
    upper: uo[1],
    lower: lo[1],
    thickU: uo[1] - ui[1],
    thickL: li[1] - lo[1],
    protrude: (uo[2] + lo[2]) / 2 - (cL[2] + cR[2]) / 2,
    shift: centreX,
    cheekW: fL[0] - fR[0],
  };
}

// inner lip contour, from the person's right corner (78) to the left corner (308)
const UPPER_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308];
const LOWER_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
export const LIP_T = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75];

/**
 * Sample the inner lip contour (upper & lower) at LIP_T along the corner-to-corner chord, heights in
 * units of `halfW0` (neutral inner half-width) — pose-invariant (same head-aligned frame as measureMouth).
 * Index order = person's right → left.
 */
export function lipContour(lm: NormalizedLandmark[], aspect: number, halfW0: number): { u: number[]; l: number[]; halfW: number } {
  const P = (i: number): V => [lm[i].x * aspect, -lm[i].y, -lm[i].z * aspect];
  const eR = P(33), eL = P(263);
  const s = len(sub(eL, eR)) || 1;
  const X = norm(sub(eL, eR));
  const origin = P(2);
  const eyeMid: V = scale([eR[0] + eL[0], eR[1] + eL[1], eR[2] + eL[2]], 0.5);
  let Y = sub(eyeMid, origin);
  Y = norm(sub(Y, scale(X, dot(Y, X))));
  const q = (i: number): [number, number] => { const d = sub(P(i), origin); return [dot(d, X) / s, dot(d, Y) / s]; };
  const cR = q(78), cL = q(308);
  const mid: [number, number] = [(cR[0] + cL[0]) / 2, (cR[1] + cL[1]) / 2];
  const ax = cL[0] - cR[0], ay = cL[1] - cR[1];
  const chord = Math.hypot(ax, ay) || 1e-6;
  const ux = ax / chord, uy = ay / chord;
  const halfW = chord / 2;
  const hw0 = halfW0 > 1e-4 ? halfW0 : halfW;
  const sample = (ids: number[]) => {
    const pts = ids.map((i) => {
      const [x, y] = q(i);
      const dx = x - mid[0], dy = y - mid[1];
      return { t: (dx * ux + dy * uy) / halfW, h: (-dx * uy + dy * ux) / hw0 };
    }).sort((a, b) => a.t - b.t);
    return LIP_T.map((t) => {
      let j = 1;
      while (j < pts.length - 1 && pts[j].t < t) j++;
      const a = pts[j - 1], b = pts[j];
      const k = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
      return a.h + (b.h - a.h) * k;
    });
  };
  return { u: sample(UPPER_INNER), l: sample(LOWER_INNER), halfW };
}

export const FEATURE_KEYS: (keyof MouthFeatures)[] = ['liftL', 'liftR', 'halfL', 'halfR', 'width', 'gap', 'upper', 'lower', 'thickU', 'thickL', 'protrude', 'shift', 'cheekW'];

/**
 * Typical change (interocular units) from neutral to a full expression. The live peak tracker and
 * the expression wizard adapt these to the person; these are only starting points.
 */
export const GEO_RANGE = {
  // tuned on a bearded performer's labelled clip (tools/analyze_clip.py, tools/eval_geo.ts)
  lift: 0.03, frown: 0.035, half: 0.045, stretch: 0.07, narrow: 0.08, thick: 0.05, puff: 0.045,
  gap: 0.3, upper: 0.06, lower: 0.2, press: 0.04, shift: 0.07,
};

/** Convert features (relative to the calibrated neutral) into ARKit-like mouth channels, 0..1. */
export function geoChannels(f: MouthFeatures, n: MouthFeatures | null): Record<string, number> {
  const c = (x: number) => (x < 0 ? 0 : x > 1.5 ? 1.5 : x);
  const c1 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const d = (k: keyof MouthFeatures) => f[k] - (n ? n[k] : DEFAULT_NEUTRAL[k]);
  const R = GEO_RANGE;
  const liftL = d('liftL'), liftR = d('liftR');
  const open = c(d('gap') / R.gap);
  const thickN = c1((d('thickU') + d('thickL')) / R.thick);
  const narrowN = c(-d('width') / R.narrow);
  const shift = d('shift') / R.shift;
  const shiftN = c1(Math.abs(shift));
  const side = (lift: number, half: number) => {
    // an open jaw nudges the corner landmarks up a little under a beard — discount it
    const smile = c(c(lift / R.lift - open * 1.5) * 0.55 + (lift > -0.01 ? c(half / R.half - open * 0.5) * 0.45 : 0));
    const frown = c(-lift / R.frown) * (1 - c1(open * 2.2));
    const stretch = c(half / R.stretch) * (1 - c1(lift / R.lift));
    return { smile, frown, stretch };
  };
  const L = side(liftL, d('halfL')), Rr = side(liftR, d('halfR'));
  // pucker narrows AND thickens the lips; a cheek puff narrows them without thickening
  const pucker = c(narrowN * (0.3 + 0.7 * thickN) * (1 - c1(open * 1.4)) * (1 - shiftN * 0.8));
  const puff = c(c(-d('width') / R.puff) * (1 - thickN) * (1 - c1(open * 3)) * (1 - shiftN));
  const funnel = c(narrowN * 0.8 * c1(open * 3));
  const press = c(-(d('thickU') + d('thickL')) / R.press) * (1 - c1(open * 2));
  return {
    _gOpen: open,
    _gSmileL: L.smile, _gSmileR: Rr.smile,
    _gFrownL: L.frown * (1 - c1(L.smile)), _gFrownR: Rr.frown * (1 - c1(Rr.smile)),
    _gStretchL: L.stretch, _gStretchR: Rr.stretch,
    _gPucker: pucker * (1 - c1(puff)), _gFunnel: funnel, _gPress: press,
    _gLeft: c(shift), _gRight: c(-shift),
    _gUpperUp: c(d('upper') / R.upper - open * 0.2), _gLowerDown: c(-d('lower') / R.lower - open * 0.8),
    _gPuff: puff,
  };
}

/**
 * Speech lip shapes for the viseme engine (raw, 0..1, relative to the person's pose-predicted neutral).
 * Scored on the recorded clip against weak MIC labels (tools/eval_face.ts):
 *   _lipTuck   lower lip up under the upper teeth (F/V): lips together + upper vermilion thins as the
 *              lower lip pushes behind it + upper lip lifts. AUC 0.84 for F/V frames vs other speech.
 *   _lipRound  rounding / protrusion (U, O, W, SH): corners narrow + lips evert (thicken). AUC 0.70 U/O vs A/I/E.
 *   _lipSeal   lips touching (M/B/P needs this): inner gap back at (or below) the resting gap.
 *   _lipPress  pressed / rolled-in lips while sealed (vermilion thinner than rest).
 *   _teethGeo  upper teeth likely visible (opening + upper lip lift / spread), a geometric fallback for
 *              the image-based _teethShow. AUC 0.85 I/E vs U/O.
 * `bs`/`bsRest`: raw MediaPipe blendshapes and their resting values.
 */
export function lipShapeChannels(f: MouthFeatures, n: MouthFeatures | null, bs: Record<string, number>, bsRest: Record<string, number>): Record<string, number> {
  const c = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const ss = (a: number, b: number, x: number) => { const t = c((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const N = n ?? DEFAULT_NEUTRAL;
  const d = (k: keyof MouthFeatures) => f[k] - N[k];
  const gap = Math.max(0, d('gap'));
  const smile = c(Math.max(d('liftL'), d('liftR')) / 0.03);
  const near = 1 - ss(0.05, 0.14, gap);
  const seal = 1 - ss(0.008, 0.035, gap);
  const uUp = c(((bs.mouthUpperUpLeft ?? 0) + (bs.mouthUpperUpRight ?? 0) - (bsRest.mouthUpperUpLeft ?? 0) - (bsRest.mouthUpperUpRight ?? 0)) / 2);
  // brows shooting up (surprise) stretch the upper lip thin too — not a tuck
  const browUp = c(((bs.browInnerUp ?? 0) - (bsRest.browInnerUp ?? 0)) / 0.35);
  const tuck = near * (1 - smile) * (1 - browUp * 0.8) * c(0.6 * c(-d('thickU') / 0.018) + 0.4 * c(uUp / 0.25));
  const narrow = c(-d('width') / 0.07), thick = c((d('thickU') + d('thickL')) / 0.035);
  const round = (1 - smile) * c(narrow * 0.55 + thick * 0.45) * Math.min(1, narrow / 0.1);
  const press = seal * (1 - smile) * c(-(d('thickU') + d('thickL')) / 0.03); // smiles thin the lips by stretching, not pressing
  const teeth = c(ss(0.02, 0.1, gap) * c(0.35 + uUp * 2 + c(d('width') / 0.08) * 0.6 + smile * 0.5));
  return { _lipTuck: tuck, _lipRound: round, _lipSeal: seal, _lipPress: press, _teethGeo: teeth };
}

/** Which ARKit channel each geometric channel backs up. */
export const GEO_TO_ARKIT: Record<string, string[]> = {
  _gOpen: ['jawOpen'],
  _gSmileL: ['mouthSmileLeft'], _gSmileR: ['mouthSmileRight'],
  _gFrownL: ['mouthFrownLeft'], _gFrownR: ['mouthFrownRight'],
  _gStretchL: ['mouthStretchLeft'], _gStretchR: ['mouthStretchRight'],
  _gPucker: ['mouthPucker'], _gFunnel: ['mouthFunnel'],
  _gPress: ['mouthPressLeft', 'mouthPressRight'],
  _gLeft: ['mouthLeft'], _gRight: ['mouthRight'],
  _gUpperUp: ['mouthUpperUpLeft', 'mouthUpperUpRight'], _gLowerDown: ['mouthLowerDownLeft', 'mouthLowerDownRight'],
  _gPuff: ['cheekPuff'],
};

/** Neutral used before calibration (average adult face, interocular units). */
const DEFAULT_NEUTRAL: MouthFeatures = {
  liftL: -0.01, liftR: -0.01, halfL: 0.24, halfR: 0.24, width: 0.48, gap: 0.01, upper: -0.18, lower: -0.42,
  thickU: 0.07, thickL: 0.08, protrude: 0.03, shift: 0, cheekW: 1.35,
};

// ---------------- facial hair ----------------

const SKIN = [50, 280, 205, 425, 151, 9, 108, 337];
const CHIN = [152, 175, 199, 200, 18, 208, 428, 32, 262];
const MOUSTACHE = [164, 167, 393, 165, 391];

/** Every landmark the facial-hair patches and the glasses profiles (glasses.ts) sample (the face-region crop covers these). */
const HAIR_IDS = [...SKIN, ...CHIN, ...MOUSTACHE, ...GLASSES_IDS];
/** Width of the frame the patches are measured on (5×5 px patches of a 320 px wide frame). */
const HAIR_W = 320;
/** Reads a small ImageBitmap back to RGBA (`w` x `h`) on its own thread (the GPU round trip of a readback never blocks
 *  the studio). Replies {d} = the pixels; on any failure (no OffscreenCanvas 2D in workers: Safari before 16.4) it
 *  replies {b} = the bitmap handed back untouched (or {} when it was used up), and the studio reads on the main thread
 *  from then on. (Exported for tools/studio_loop_unit.ts.) */
export const HAIR_WORKER = 'let c=null,g=null;onmessage=(e)=>{const{b,w,h}=e.data;try{if(typeof OffscreenCanvas!=="function")throw 0;' +
  'if(!c||c.width<w||c.height<h){c=new OffscreenCanvas(Math.max(w,c?c.width:1),Math.max(h,c?c.height:1));g=c.getContext("2d",{willReadFrequently:true});}' +
  'if(!g)throw 0;g.clearRect(0,0,w,h);g.drawImage(b,0,0,w,h);b.close();const d=g.getImageData(0,0,w,h).data;postMessage({d},[d.buffer]);}' +
  'catch(err){try{if(b&&b.width)postMessage({b},[b]);else postMessage({})}catch(x){postMessage({})}}};';

/** The face-region box (in pixels of a `w` × `h` frame) that holds every facial-hair patch, or null. */
export function hairBox(lm: { x: number; y: number }[], w: number, h: number): { x0: number; y0: number; cw: number; ch: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of HAIR_IDS) {
    const p = lm[i];
    if (!p) return null;
    const cx = Math.round(p.x * w), cy = Math.round(p.y * h);
    if (cx < x0) x0 = cx;
    if (cx > x1) x1 = cx;
    if (cy < y0) y0 = cy;
    if (cy > y1) y1 = cy;
  }
  // ± the 2 px patch radius, clipped to the frame
  x0 = Math.max(0, x0 - 2); y0 = Math.max(0, y0 - 2); x1 = Math.min(w, x1 + 3); y1 = Math.min(h, y1 + 3);
  return x1 > x0 && y1 > y0 ? { x0, y0, cw: x1 - x0, ch: y1 - y0 } : null;
}

/**
 * Estimate facial-hair coverage 0..1 by comparing luminance of chin / upper-lip patches against
 * cheek + forehead skin in the actual camera image. Runs ~1×/s on the scale of a 320 px wide frame, but only the face
 * region is fetched: the GPU crops + scales it (createImageBitmap, ≤ 320 px) and a tiny worker reads those few pixels
 * back (before: a full-frame draw + 320 px getImageData on the main thread, ~4.6 ms at 720p). Asynchronous: the scores
 * update when the pixels arrive (a frame or two later). Fallbacks, so the detector keeps working in any browser: no
 * OffscreenCanvas 2D in workers -> the bitmap is read on a small main-thread canvas; no (working) createImageBitmap ->
 * the face region is drawn straight from the video onto that canvas (the old main-thread cost, on the crop only).
 */
export class FacialHairDetector {
  score = 0;
  moustache = 0;
  /** Raw glasses score of the last readback (glasses.ts glassesStat; null = couldn't judge) and how many readbacks there
   *  were — the face solver feeds new ones into its GlassesState. */
  glassesRaw: number | null = null;
  glassesN = 0;
  private cv: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private samples = 0;
  private busy = false;
  /** undefined = not started yet, null = no worker here (main-thread fallback) */
  private worker: Worker | null | undefined;
  private pending: { res: (d: Uint8ClampedArray | null) => void; w: number; h: number } | null = null;
  /** createImageBitmap is missing or failed here: draw the crop from the video on the main thread instead. */
  private direct = false;

  update(video: HTMLVideoElement, lm: NormalizedLandmark[]): Promise<void> | void {
    // (not when the browser changes canvas reads: src/core/readbackProbe.ts; no beard compensation beats a wrong one)
    if (!video.videoWidth || this.busy || !cameraPixelsOk()) return;
    const VW = video.videoWidth, VH = video.videoHeight;
    const w = HAIR_W, h = Math.round((HAIR_W * VH) / VW);
    const box = hairBox(lm, w, h);
    if (!box) return;
    const { x0, y0, cw, ch } = box;
    // the same pixels a 320 px wide frame would have there: source rect in video pixels, scaled by the same factor
    const kx = VW / w, ky = VH / h;
    const src: [number, number, number, number] = [x0 * kx, y0 * ky, cw * kx, ch * ky];
    let bmp: Promise<ImageBitmap> | null = null;
    if (!this.direct && typeof createImageBitmap === 'function') {
      try { bmp = createImageBitmap(video, ...src, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'low' }); } catch { this.direct = true; }
    } else this.direct = true;
    if (!bmp) {
      const img = this.readHere(video, cw, ch, src);
      if (img) this.measure(img, lm, x0, y0, cw, w, h);
      return;
    }
    this.busy = true;
    // (a late reply from a timed-out request has another size: never measured)
    return bmp.then((b) => this.pixels(b, cw, ch), () => { this.direct = true; return null; })
      .then((img) => { if (img && img.length === cw * ch * 4) this.measure(img, lm, x0, y0, cw, w, h); }, () => {})
      .finally(() => { this.busy = false; });
  }

  /** RGBA (`w` x `h`) of a bitmap (closed here): read back on the worker, or on a reused small main-thread canvas when no
   *  worker can (a worker that fails once hands the bitmap back and is dropped for good). */
  private pixels(b: ImageBitmap, w: number, h: number): Promise<Uint8ClampedArray | null> {
    if (this.worker === undefined) {
      try {
        this.workerUrl = URL.createObjectURL(new Blob([HAIR_WORKER], { type: 'text/javascript' }));
        const wk = new Worker(this.workerUrl);
        wk.onmessage = (e: MessageEvent<{ d?: Uint8ClampedArray; b?: ImageBitmap }>) => {
          const p = this.pending; this.pending = null;
          const m = e.data ?? {};
          if (m.d) { p?.res(m.d); return; }
          this.dropWorker();
          if (m.b) { if (p) void this.pixels(m.b, p.w, p.h).then(p.res); else m.b.close(); } else p?.res(null);
        };
        wk.onerror = () => { this.dropWorker(); const p = this.pending; this.pending = null; p?.res(null); };
        this.worker = wk;
      } catch { this.worker = null; this.revokeUrl(); }
    }
    const wk = this.worker;
    if (wk) {
      return new Promise((res) => {
        const p = { res, w, h };
        this.pending = p;
        try { wk.postMessage({ b, w, h }, [b]); } catch { this.pending = null; b.close(); res(null); return; }
        // never stall the detector on a lost reply
        setTimeout(() => { if (this.pending === p) { this.pending = null; res(null); } }, 2000);
      });
    }
    try { return Promise.resolve(this.readHere(b, w, h)); } finally { b.close(); }
  }

  private dropWorker() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.revokeUrl();
  }
  /** The worker's blob URL lives as long as its worker; ended with it (it was never revoked). */
  private workerUrl = '';
  private revokeUrl() { if (this.workerUrl) { try { URL.revokeObjectURL(this.workerUrl); } catch { /* gone */ } this.workerUrl = ''; } }

  /** Main-thread readback: `src` (or its `rect`) drawn at `w` x `h` on one small canvas, grown only when a bigger face needs
   *  it (never re-sized per call). */
  private readHere(src: CanvasImageSource, w: number, h: number, rect?: [number, number, number, number]): Uint8ClampedArray | null {
    try {
      if (!this.cv) { this.cv = document.createElement('canvas'); this.cv.width = this.cv.height = 1; this.ctx = this.cv.getContext('2d', { willReadFrequently: true }); }
      const ctx = this.ctx;
      if (!ctx) return null;
      if (this.cv.width < w || this.cv.height < h) { this.cv.width = Math.max(this.cv.width, w); this.cv.height = Math.max(this.cv.height, h); }
      if (rect) ctx.drawImage(src, rect[0], rect[1], rect[2], rect[3], 0, 0, w, h);
      else ctx.drawImage(src, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } catch { return null; }
  }

  /** The patches on the face-region pixels `img` (`cw` wide, its top-left at x0, y0 of the `w` × `h` frame). */
  private measure(img: Uint8ClampedArray, lm: NormalizedLandmark[], x0: number, y0: number, cw: number, w: number, h: number) {
    const patch = (ids: number[]) => {
      let sum = 0, n = 0;
      for (const i of ids) {
        const cx = Math.round(lm[i].x * w), cy = Math.round(lm[i].y * h);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const o = ((y - y0) * cw + (x - x0)) * 4;
          sum += 0.2126 * img[o] + 0.7152 * img[o + 1] + 0.0722 * img[o + 2];
          n++;
        }
      }
      return n ? sum / n : 0;
    };
    // glasses: thin bars across the nose bridge and under the eyes, on the same pixels (no extra readback)
    try { this.glassesRaw = glassesStat(img, lm, x0, y0, cw, Math.floor(img.length / 4 / cw), w, h)?.score ?? null; } catch { this.glassesRaw = null; }
    this.glassesN++;
    const skin = patch(SKIN), chin = patch(CHIN), mst = patch(MOUSTACHE);
    if (skin < 8) return; // too dark to judge
    const s = Math.min(1, Math.max(0, (1 - chin / skin - 0.12) / 0.4));
    const m = Math.min(1, Math.max(0, (1 - mst / skin - 0.12) / 0.4));
    // slow average — lighting flicker shouldn't flip compensation on and off
    const k = this.samples < 5 ? 0.5 : 0.1;
    this.score += (s - this.score) * k;
    this.moustache += (m - this.moustache) * k;
    this.samples++;
  }
}
