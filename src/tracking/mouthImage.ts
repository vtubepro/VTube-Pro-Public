// Mouth-interior image analysis: the tongue (MediaPipe has no tongue), teeth and the dark cavity.
//
// Runs in the face worker on the same zoomed face crop the landmark model saw: the mouth region is
// resampled to a 64×64 patch (a tiny GPU→CPU readback) and classified pixel by pixel against the
// performer's OWN lip colour, sampled every frame from the lower-lip vermilion:
//   inside the inner-lip opening   dark → cavity · bright + unsaturated → teeth · lip-coloured → tongue
//   below the lower lip            lip-coloured where skin / beard should be → tongue OUT
// Everything is relative (chromaticity vs the live lip reference, luminance vs the lip's), so it holds
// under any lighting / skin tone / white balance; a slow per-person baseline removes what a closed,
// resting mouth already shows (e.g. a full lower lip that dips below the landmark contour).
// Pure functions — the same code runs offline on decoded video frames (tools/eval_tongue.ts).

export const PATCH = 64;

// inner lip contour, right corner → left corner (upper), then left → right (lower): a closed polygon
const INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
// outer lower lip contour, right corner → left corner
const OUTER_LOWER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291];
const INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308];
// whole outer lip contour (right corner → lower lip → left corner → upper lip): with INNER it bounds the lips themselves
const OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];

export interface MouthImage {
  /** Lip-coloured pixels below the lower lip (tongue out past the lips), 0..1 after the baseline. */
  _tongueOut: number;
  /** Tongue visible inside the opening with its mass in the upper half (tip raised: L, TH, N). */
  _tongueUp: number;
  /** Fraction of the opening that is teeth. */
  _teethShow: number;
  /** Fraction of the opening that is dark cavity. */
  _cavity: number;
  /** Raw measures (diagnostics / baselines). */
  raw: MouthRaw;
}

type Pt = { x: number; y: number };
/** Raw per-frame patch measures. `ringHi` / `ctxHi` feed the mouth-visibility detector (mouthVisibility.ts). */
export interface MouthRaw {
  below: number; tongueIn: number; teeth: number; dark: number; open: number; lipLum: number;
  /** mean red chroma (r − g) / (r + g + b) of the lips themselves (between the outer and inner lip contours) */
  ringRG?: number;
  /** upper quartile of the lips' red chroma: the reddest part of the lip ring (stretched / pale corners, moustache hair
   *  or a stray teeth pixel at the edge pull the mean down; an occluder over the lips pulls this down too) */
  ringHi?: number;
  /** mean luminance of the lips (0..255) */
  ringLum?: number;
  /** lip pixels measured (reliability: a tiny / turned-away mouth gives few) */
  ringN?: number;
  /** mean red chroma of the patch AROUND the lips (chin, skin / stubble / beard; not the lips, not the opening):
   *  diagnostics only */
  ctxRG?: number;
  /** upper quartile of the red chroma AROUND the lips: the context the lips stand out from, by the SAME statistic as
   *  `ringHi`. (Comparing different statistics is biased: the upper quartile of the lips against the MEAN of the context
   *  read ~0.67 of any occluder's colour-noise spread as "redder than its surroundings", so a real black foam mic, which
   *  has colour noise and texture, looked like visible lips.) */
  ctxHi?: number;
  /** the dark-pixel floor on the chroma's r + g + b this patch used (chromaFloor): diagnostics */
  chromaFloor?: number;
}

/**
 * Red chroma (r − g) / (r + g + b) of one pixel, with the sum floored: in very dark pixels (a black mic, a shadow) r − g is
 * mostly sensor noise, and dividing it by a tiny sum would blow that noise up into "colour". The floor follows the face's
 * OWN brightness: CHROMA_FLOOR_FRAC of the brightest tenth of the patch around the lips (the lit skin), at most
 * CHROMA_FLOOR. So a black mic much darker than the skin is still floored, but a face that is dark all over (deep skin in
 * a dim room, monitor light, a bright wall behind an under-exposed face) keeps its lips' colour. (A FIXED floor of 90
 * flattened such lips, which are darker than the skin around them, far more than the skin: visible lips read as covered.)
 */
export const CHROMA_FLOOR = 90;
export const CHROMA_FLOOR_FRAC = 0.4;
/** The chroma floor of a patch whose surroundings' brightest tenth starts at brightness `bright` (r + g + b + 1). */
export const chromaFloor = (bright: number) => Math.min(CHROMA_FLOOR, CHROMA_FLOOR_FRAC * bright);
// per-pixel scratch of the two passes (r − g and r + g + b + 1 of the lip ring / the context pixels)
const ringD = new Int16Array(PATCH * PATCH), ringS = new Uint16Array(PATCH * PATCH);
const ctxD = new Int16Array(PATCH * PATCH), ctxS = new Uint16Array(PATCH * PATCH);
const sumHist = new Uint16Array(192); // context brightness r + g + b + 1 (1 … 766) in bins of 4
/** Chroma histogram: −0.2 … 0.44 in 256 bins of 0.0025. */
const HB = 256, H0 = -0.2, HW = 0.0025;
const hbin = (c: number) => Math.max(0, Math.min(HB - 1, Math.floor((c - H0) / HW)));
/** q-quantile of a histogram of n samples, interpolated inside the bin (no 0.01 steps in the contrast). */
function histQ(hist: Uint16Array, n: number, q: number) {
  const target = n * q;
  let acc = 0, k = 0;
  while (k < HB - 1 && acc + hist[k] < target) acc += hist[k++];
  return H0 + (k + (hist[k] ? Math.min(1, Math.max(0, (target - acc) / hist[k])) : 0.5)) * HW;
}

/** Patch rectangle (image pixels) around the mouth + the area below it where a tongue would stick out. */
export function mouthRect(lm: Pt[], W: number, H: number): { x: number; y: number; w: number; h: number } {
  const cR = lm[61], cL = lm[291];
  const mw = Math.hypot((cL.x - cR.x) * W, (cL.y - cR.y) * H);
  const cx = ((cR.x + cL.x) / 2) * W;
  const top = Math.min(lm[0].y, lm[37].y, lm[267].y) * H - mw * 0.1;
  const s = mw * 1.35; // square: mouth + ~0.8 mouth widths below the lower lip
  const x = Math.max(0, Math.min(W - 1, cx - s / 2)), y = Math.max(0, Math.min(H - 1, top));
  return { x, y, w: Math.max(1, Math.min(W - x, s)), h: Math.max(1, Math.min(H - y, s)) };
}

function inPoly(px: number, py: number, P: Pt[]) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y + 1e-9) + a.x) inside = !inside;
  }
  return inside;
}
/** Sorted x positions where a horizontal line at y crosses the closed polygon P (even-odd spans). */
function crossings(P: Pt[], y: number, out: number[]) {
  out.length = 0;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > y) !== (b.y > y)) out.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
  }
  out.sort((p, q) => p - q);
}
/** y of a polyline (sorted by x) at x, or NaN outside its span. */
function lineY(P: Pt[], x: number) {
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    if (x >= lo && x <= hi) return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1e-9);
  }
  return NaN;
}

/**
 * Classify a PATCH×PATCH RGBA patch. `toPatch` maps a landmark (normalized image coords) to patch pixels.
 * Returns null when the mouth is too small in the image to judge.
 */
export interface MouthPatchStats { raw: MouthRaw; tongueTopShare: number }

export function analyzeMouth(rgba: Uint8ClampedArray | Uint8Array, lm: Pt[], toPatch: (p: Pt) => Pt): MouthPatchStats | null {
  const inner = INNER.map((i) => toPatch(lm[i]));
  const oLow = OUTER_LOWER.map((i) => toPatch(lm[i]));
  const iLow = INNER_LOWER.map((i) => toPatch(lm[i]));
  const mw = Math.abs(oLow[oLow.length - 1].x - oLow[0].x);
  if (mw < 12) return null;
  const S = PATCH;
  const pix = (x: number, y: number) => { const o = (y * S + x) * 4; return [rgba[o], rgba[o + 1], rgba[o + 2]]; };
  // the lips themselves (outer contour minus the opening) vs the patch around them: lips are redder than whatever
  // surrounds them (skin, stubble, beard) under any ordinary light; a mic, a cup, a hand or a pop filter over them is
  // not (mouthVisibility.ts). Both regions are summed up by the SAME statistic (the upper quartile of the per-pixel
  // chroma, with the same floor for dark pixels), so an occluder covering both reads ~0 whatever its colour noise or
  // texture. Scanline spans per row (no per-pixel polygon tests): ~1.5 k pixel reads in two passes, ~0.1 ms.
  const outer = OUTER.map((i) => toPatch(lm[i]));
  let ringRG = 0, ringLum = 0, ringN = 0, ctxRG = 0, ctxN = 0, ringHi = 0, ctxHi = 0, floor = CHROMA_FLOOR;
  const hist = new Uint16Array(HB), chist = new Uint16Array(HB);
  {
    // pass 1: r − g and brightness of every lip pixel, and of every 2nd pixel of every 2nd row OUTSIDE the lips (the
    // context; an open mouth's red tongue / inner lips must not count as context)
    const oc: number[] = [], ic: number[] = [];
    const inside = (xs: number[], x: number) => { let n = 0; while (n < xs.length && xs[n] < x) n++; return (n & 1) === 1; };
    sumHist.fill(0);
    for (let y = 0; y < S; y++) {
      crossings(outer, y + 0.5, oc);
      const row = y * S * 4;
      if (oc.length) {
        crossings(inner, y + 0.5, ic);
        for (let x = Math.max(0, Math.floor(oc[0])); x <= Math.min(S - 1, Math.ceil(oc[oc.length - 1])); x++) {
          if (!inside(oc, x + 0.5) || inside(ic, x + 0.5)) continue;
          const o = row + x * 4, r = rgba[o], g = rgba[o + 1], s = r + g + rgba[o + 2] + 1;
          ringD[ringN] = r - g; ringS[ringN] = s; ringLum += s / 3; ringN++;
        }
      }
      if (y & 1) continue;
      for (let x = 0; x < S; x += 2) {
        if (oc.length && inside(oc, x + 0.5)) continue;
        const o = row + x * 4, r = rgba[o], g = rgba[o + 1], s = r + g + rgba[o + 2] + 1;
        ctxD[ctxN] = r - g; ctxS[ctxN] = s; ctxN++; sumHist[s >> 2]++;
      }
    }
    // the dark-pixel floor from the brightest tenth of the context (the lit skin). A mic over nearly all of the patch
    // lowers it for its own pixels in the ring and the context alike, which the like-with-like contrast cancels.
    if (ctxN) {
      let acc = 0, k = sumHist.length - 1;
      while (k > 0 && acc + sumHist[k] < ctxN * 0.1) acc += sumHist[k--];
      floor = chromaFloor(k * 4 + 2);
    }
    // pass 2: chroma with that floor, the same way on both sides
    for (let i = 0; i < ringN; i++) { const c = ringD[i] / Math.max(ringS[i], floor); ringRG += c; hist[hbin(c)]++; }
    for (let i = 0; i < ctxN; i++) { const c = ctxD[i] / Math.max(ctxS[i], floor); ctxRG += c; chist[hbin(c)]++; }
    if (ringN) { ringRG /= ringN; ringLum /= ringN; ringHi = histQ(hist, ringN, 0.75); }
    if (ctxN) { ctxRG /= ctxN; ctxHi = histQ(chist, ctxN, 0.75); }
  }
  // lip reference: lower vermilion (between inner and outer lower contours), middle 60 % of the width
  let lr = 0, lg = 0, ll = 0, ln = 0;
  const x0 = Math.ceil(Math.min(oLow[0].x, oLow[oLow.length - 1].x) + mw * 0.2), x1 = Math.floor(Math.max(oLow[0].x, oLow[oLow.length - 1].x) - mw * 0.2);
  const oSorted = [...oLow].sort((a, b) => a.x - b.x), iSorted = [...iLow].sort((a, b) => a.x - b.x);
  for (let x = Math.max(0, x0); x <= Math.min(S - 1, x1); x++) {
    const yi = lineY(iSorted, x + 0.5), yo = lineY(oSorted, x + 0.5);
    if (!(yo > yi + 1)) continue;
    for (let y = Math.max(0, Math.round(yi + (yo - yi) * 0.3)); y <= Math.min(S - 1, Math.round(yi + (yo - yi) * 0.8)); y++) {
      const [r, g, b] = pix(x, y); const sum = r + g + b + 1;
      lr += r / sum; lg += g / sum; ll += sum / 3; ln++;
    }
  }
  if (ln < 4) return null;
  lr /= ln; lg /= ln; ll /= ln;
  // Tongue and lips share a red chroma (r−g ≈ 0.11–0.14 of the pixel sum on the test clip), skin sits at
  // ≈0.05, teeth / sclera-like whites at ≈0. The lip reference only raises the bar when the lips are
  // redder than that (lipstick, warm light); it can't lower it (a tongue over the lip would drag it down).
  const lipRG = lr - lg;
  const redBar = Math.max(0.075, Math.min(0.11, lipRG * 0.6));
  const lipLike = (r: number, g: number, b: number) => {
    const sum = r + g + b + 1, lum = sum / 3;
    return lum > 28 && (r - g) / sum > redBar;
  };
  // inside the opening
  let open = 0, dark = 0, teeth = 0, tongue = 0, tongueTop = 0;
  let yTop = Infinity, yBot = -Infinity;
  for (const p of inner) { yTop = Math.min(yTop, p.y); yBot = Math.max(yBot, p.y); }
  const yMid = (yTop + yBot) / 2;
  for (let y = Math.max(0, Math.floor(yTop)); y <= Math.min(S - 1, Math.ceil(yBot)); y++) {
    for (let x = 0; x < S; x++) {
      if (!inPoly(x + 0.5, y + 0.5, inner)) continue;
      open++;
      const [r, g, b] = pix(x, y);
      const sum = r + g + b + 1, lum = sum / 3;
      const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / (Math.max(r, g, b) + 1);
      if (lum < Math.min(ll * 0.5, 45)) dark++;
      else if (sat < 0.22 && (r - g) / sum < 0.045 && lum > ll * 1.1) teeth++;
      else if (lipLike(r, g, b)) { tongue++; if (y + 0.5 < yMid) tongueTop++; }
    }
  }
  // below the lower lip: a band ~0.55 mouth widths deep, middle 70 % of the mouth width
  let below = 0, belowN = 0;
  const bx0 = Math.ceil(oSorted[0].x + mw * 0.15), bx1 = Math.floor(oSorted[oSorted.length - 1].x - mw * 0.15);
  for (let x = Math.max(0, bx0); x <= Math.min(S - 1, bx1); x++) {
    const yo = lineY(oSorted, x + 0.5);
    if (!isFinite(yo)) continue;
    for (let y = Math.max(0, Math.ceil(yo + 1)); y <= Math.min(S - 1, Math.floor(yo + mw * 0.55)); y++) {
      belowN++;
      const [r, g, b] = pix(x, y);
      if (lipLike(r, g, b)) below++;
    }
  }
  const openFrac = open / Math.max(1, mw * mw * 0.5);
  return {
    raw: { below: belowN ? below / belowN : 0, tongueIn: open ? tongue / open : 0, teeth: open ? teeth / open : 0, dark: open ? dark / open : 0, open: openFrac, lipLum: ll,
      ringRG, ringHi, ringLum, ringN, ctxRG, ...(ctxN ? { ctxHi } : {}), chromaFloor: floor },
    // tongue tip raised: share of the tongue pixels in the upper half of the opening
    tongueTopShare: tongue ? tongueTop / tongue : 0,
  };
}

/** Stateful wrapper: per-person baseline for "lip-coloured below the lip" + smooth 0..1 channels. */
export class MouthImageModel {
  private base = 0.05;
  private seen = 0;
  last: MouthImage | null = null;
  /** `closedCalm`: the mouth is closed and relaxed (landmarks) — used to learn the baseline. */
  /** Instantaneous (unheld) tongue-fill evidence of the last frame. */
  fill = 0;
  private hold = 0;
  step(a: MouthPatchStats | null, closedCalm: boolean, dt = 1 / 60): MouthImage | null {
    if (!a) return this.last;
    const r = a.raw;
    if (closedCalm) {
      // baseline follows drops quickly, rises slowly (a tongue out never becomes "normal")
      const k = this.seen < 30 ? 0.2 : r.below < this.base ? 0.05 : 0.004;
      this.base += (r.below - this.base) * k;
      this.seen++;
    }
    const c = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const openW = c((r.open - 0.03) / 0.1); // opening big enough for its contents to mean something
    const topShare = a.tongueTopShare;
    // tongue out: MediaPipe wraps the lower-lip contour around a protruding tongue, so a WIDE "opening"
    // shows almost no dark cavity (an open mouth always does: aa 50 %, ee 27 %, talking 25 %; tongue out
    // 1–3 % on the test clip) and few teeth — it is filled by the tongue. ("Tongue-red below the lower
    // lip" was tried as a second cue: it fired on wide-open vowels and added nothing — raw.below keeps it
    // for diagnostics.) Sticking the tongue out is a HELD gesture: it must persist ~0.15 s to count, so
    // speech flickers (a lit mouth interior for a frame or two) don't flash a tongue.
    const filled = c((r.open - 0.22) / 0.18) * c(1 - (r.dark - 0.03) / 0.07) * c(1 - (r.teeth - 0.12) / 0.15);
    this.fill = filled;
    const k = 1 - Math.exp(-dt / (filled > this.hold ? 0.15 : 0.05));
    this.hold += (filled - this.hold) * k;
    this.last = {
      _tongueOut: c((this.hold - 0.15) / 0.6),
      _tongueUp: c(r.tongueIn / 0.35) * c((topShare - 0.4) / 0.4) * openW,
      _teethShow: c(r.teeth / 0.3) * openW,
      _cavity: c(r.dark / 0.6) * openW,
      raw: r,
    };
    return this.last;
  }
}
