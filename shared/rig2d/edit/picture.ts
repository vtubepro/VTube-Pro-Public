// PICTURE TO LIFE: ONE flat picture (a person, an animal, a mascot) plus up to three taps (eye, other eye, mouth) → a layered
// ArtSet that the ordinary auto-rig (autorig.ts) rigs: blinking, a talking mouth, head turn / nod / tilt, breathing. Nothing
// here is a second rig: we only SYNTHESISE the layers an artist would have drawn, from the picture itself, so that
//   * the rest pose composites back to the input (seam-free: every split keeps identical colours, alphas union to the
//     original alpha, lifted parts are unmixed against what is left under them),
//   * eyes and mouth are their own layers named so classify.ts finds them (Eye L / Eye R = "whole eye", Eye closed L / R =
//     a drawn lid line, Mouth = one mouth layer: autorig paints the inside of the mouth when it opens),
//   * the hole each part leaves is INPAINTED from the skin around it (push-pull), so a closed eye shows skin + a lid line,
//   * the head (hair included) is an ellipse-shaped "Face" layer feathered into a "Body" layer that holds the rest.
// Steps: cut-out (keep real alpha, else flood the plain background from the border, 1-2 px soft edge) → head ellipse from
// the taps (eye distance d: centre 0.6 d above the eye line, radii 1.6 d × 1.9 d, tuned on the shipped sample) → lift each
// feature (colour distance from the inpainted skin = how much of it belongs to the feature) → split head / body.
// Pure, deterministic (no randomness, no DOM): the same input gives byte-identical layers.
import { trimLayer, type ArtLayer, type ArtSet } from './layers.ts';
import { autoRigArt, applyAutoRig, headTurn, type AutoRigOpts } from './autorig.ts';
import { HEAD_ROLES } from './classify.ts';
import type { EdDeformer, EdDoc, EdForm, EdMesh, EdTexture, EdValue } from './doc.ts';

export interface PicturePixels { w: number; h: number; rgba: Uint8ClampedArray }
/** Where the user tapped (picture pixels). `eyeL` = the eye on the LEFT of the picture, `eyeR` = the one on the right (the
 *  character's own sides are the other way round; the auto-rig works them out from the picture). */
export interface PictureTaps { eyeL?: [number, number]; eyeR?: [number, number]; mouth?: [number, number]; head?: { cx: number; cy: number; rx: number; ry: number } }
export interface PictureOpts {
  /** Background colour tolerance for the cut-out (RGB distance, default 34). */
  tolerance?: number;
  /** Scale of the generated head ellipse (default 1; the "Head size" slider). */
  headScale?: number;
  /** Scale of the eye / mouth cut-outs around the taps (default 1). */
  eyeScale?: number; mouthScale?: number;
}
export interface PictureBuild {
  art: ArtSet;
  /** 'kept' = the picture's own transparency, 'removed' = a plain background was cut out, 'opaque' = left as it is. */
  cutout: 'kept' | 'removed' | 'opaque';
  eyes: number; mouth: boolean; head: { cx: number; cy: number; rx: number; ry: number } | null;
  /** The mouth as drawn: 'open' (an inside shows: the art is the OPEN state, a closed line is made for silence), 'closed'
   *  (a line: the art is the closed state, an inside is painted when it opens), null = no mouth. */
  mouthStyle: 'open' | 'closed' | null;
  /** The made closed-mouth line's centre (canvas px, one y per column from x0): the open art squashes onto it. */
  mouthCurve: { x0: number; ys: number[] } | null;
  /** The head is the whole character (a mascot): its centre. The tilt then turns the whole thing as one piece about it. */
  wholeHead: { cx: number; cy: number } | null;
  /** An upper-lip stroke drawn DETACHED above the opening (the art's own "Mouth upper"): it becomes the one line that travels,
   *  from its own shape (closed: ys from sx0) to the opening's top edge (ym from mx0). null = none. */
  mouthMorph: { sx0: number; ys: number[]; mx0: number; ym: number[] } | null;
  /** The eye distance everything is sized from (px). */
  d: number;
}

type Ell = { cx: number; cy: number; rx: number; ry: number };
const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ------------------------------------------------------------------ 1. cut-out
/** Box blur of a w×h picture with `ch` interleaved channels (radius r, edges clamped). */
function boxBlur(src: Float32Array, w: number, h: number, ch: number, r: number): Float32Array {
  const out = new Float32Array(src.length), tmp = new Float32Array(src.length), k = 2 * r + 1;
  for (let c = 0; c < ch; c++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += src[(y * w + Math.min(w - 1, Math.max(0, x))) * ch + c];
      for (let x = 0; x < w; x++) { tmp[(y * w + x) * ch + c] = s / k; s += src[(y * w + Math.min(w - 1, x + r + 1)) * ch + c] - src[(y * w + Math.max(0, x - r)) * ch + c]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[(Math.min(h - 1, Math.max(0, y)) * w + x) * ch + c];
      for (let y = 0; y < h; y++) { out[(y * w + x) * ch + c] = s / k; s += tmp[(Math.min(h - 1, y + r + 1) * w + x) * ch + c] - tmp[(Math.max(0, y - r) * w + x) * ch + c]; }
    }
  }
  return out;
}

const BUSY = 'Your picture has a busy background, so we kept it. A PNG with a transparent background works best.';
const SAMECOL = "Your picture's background is the same colour as parts of the character, so we kept it. A PNG with a transparent background works best.";

/** Keep real transparency; else cut out a plain background (flat, noisy or a smooth gradient) by flooding it from the border:
 *  a cell joins when it is almost the colour of its neighbour (so a gradient is followed), flat, not near a tapped feature, and, when
 *  the background has grain (noise), as grainy as the border is (a flat white jacket against grainy white is told apart by it).
 *  Enclosed background islands (between hair and jacket) go too when they match the background beside them. Edges are 1-2 px soft
 *  with the background colour pulled out. When it cannot be sure (a busy photo behind, a cut that runs through near-identical
 *  colours, almost everything or nothing removed) it keeps the picture opaque and says why in plain words.
 *  A big picture is analysed on a grid of f × f cells (colour mean + flatness; ~900 cells across at most) and refined at full
 *  size only along the cut, so the cost stays small; a small one is analysed pixel by pixel (f = 1). */
export function cutout(pic: PicturePixels, protect: { x: number; y: number; r: number }[] = []): { rgba: Uint8ClampedArray; mode: 'kept' | 'removed' | 'opaque'; warn?: string } {
  const { w, h } = pic, n = w * h, src = pic.rgba;
  let semi = 0;
  for (let i = 3; i < n * 4; i += 4) if (src[i] < 200) semi++;
  if (semi > n * 0.01) return { rgba: new Uint8ClampedArray(src), mode: 'kept' };
  const out = new Uint8ClampedArray(src);
  for (let i = 3; i < n * 4; i += 4) out[i] = 255;
  const keep = (warn: string) => ({ rgba: out, mode: 'opaque' as const, warn });
  // ---- the grid: colour of each cell (its mean) and how flat it is (its widest channel range)
  const f = Math.max(1, Math.ceil(Math.max(w, h) / 900)), gw = Math.ceil(w / f), gh = Math.ceil(h / f), gn = gw * gh;
  const g = new Float32Array(gn * 3), rng = new Uint8Array(gn);
  if (f === 1) for (let i = 0; i < n; i++) { g[i * 3] = src[i * 4]; g[i * 3 + 1] = src[i * 4 + 1]; g[i * 3 + 2] = src[i * 4 + 2]; }
  else {
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      let r = 0, gg = 0, b = 0, k = 0, r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
      const ye = Math.min(h, gy * f + f), xe = Math.min(w, gx * f + f);
      for (let y = gy * f; y < ye; y++) for (let x = gx * f, i = (y * w + x) * 4; x < xe; x++, i += 4) {
        const pr = src[i], pg = src[i + 1], pb = src[i + 2];
        r += pr; gg += pg; b += pb; k++;
        if (pr < r0) r0 = pr; if (pr > r1) r1 = pr; if (pg < g0) g0 = pg; if (pg > g1) g1 = pg; if (pb < b0) b0 = pb; if (pb > b1) b1 = pb;
      }
      const c = gy * gw + gx;
      g[c * 3] = r / k; g[c * 3 + 1] = gg / k; g[c * 3 + 2] = b / k; rng[c] = Math.max(r1 - r0, g1 - g0, b1 - b0);
    }
  }
  const sm = f === 1 ? boxBlur(g, gw, gh, 3, 1) : g, sm5 = boxBlur(g, gw, gh, 3, f === 1 ? 2 : 1);
  const bidx: number[] = [];
  for (let x = 0; x < gw; x++) bidx.push(x, (gh - 1) * gw + x);
  for (let y = 1; y < gh - 1; y++) bidx.push(y * gw, y * gw + gw - 1);
  const med = (a: number[]) => { const v = a.slice().sort((p, q) => p - q); return v[v.length >> 1]; };
  const m0 = [0, 1, 2].map((c) => med(bidx.map((i) => sm[i * 3 + c])));
  const dist = (a: Float32Array, i: number, b: Float32Array, j: number) => { const x = a[i * 3] - b[j * 3], y = a[i * 3 + 1] - b[j * 3 + 1], z = a[i * 3 + 2] - b[j * 3 + 2]; return Math.sqrt(x * x + y * y + z * z); };
  const dm0 = (i: number) => { const x = sm[i * 3] - m0[0], y = sm[i * 3 + 1] - m0[1], z = sm[i * 3 + 2] - m0[2]; return Math.sqrt(x * x + y * y + z * z); };
  // a busy background: the border's smoothed colour jumps about from one cell to the next (a photo, not a wall)
  const ring: number[] = [];
  for (let x = 0; x < gw; x++) ring.push(x);
  for (let y = 1; y < gh - 1; y++) ring.push(y * gw + gw - 1);
  for (let x = gw - 1; x >= 0; x--) ring.push((gh - 1) * gw + x);
  for (let y = gh - 2; y >= 1; y--) ring.push(y * gw);
  const steps: number[] = [];
  for (let k = 1; k < ring.length; k++) steps.push(dist(sm5, ring[k], sm5, ring[k - 1]));
  if (med(steps) > 2.5 * f) return keep(BUSY);
  // the background beside the character covers almost the whole picture: nothing to cut out (before any tap protects part of it)
  {
    let same = 0;
    for (let i = 0; i < gn; i++) if (dm0(i) <= 24) same++;
    if (same > 0.85 * gn) return keep('This picture is almost all one colour, so we could not tell the character from the background and kept all of it.');
  }
  // ---- grain: how noisy the border is, and (per cell) how much of it is as noisy as that
  const near0 = bidx.filter((i) => dm0(i) <= 30);
  let grain = 0, grainy = false;
  const gOk = new Uint8Array(gn).fill(1);
  if (f === 1) {
    const e1 = new Float32Array(n);
    for (let i = 0; i < n; i++) e1[i] = (Math.abs(g[i * 3] - sm[i * 3]) + Math.abs(g[i * 3 + 1] - sm[i * 3 + 1]) + Math.abs(g[i * 3 + 2] - sm[i * 3 + 2])) / 3;
    grain = near0.length ? med(near0.map((i) => e1[i])) : 0; grainy = grain >= 1;
    if (grainy) {
      const ind = new Float32Array(n);
      for (let i = 0; i < n; i++) ind[i] = e1[i] >= 0.3 * grain ? 1 : 0;
      const gk = boxBlur(ind, w, h, 1, 2);
      for (let i = 0; i < n; i++) gOk[i] = gk[i] >= 0.65 ? 1 : 0;
    }
  } else {
    // (full size: a pixel's grain = how far its brightness is from the average of its four neighbours)
    const lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) lum[i] = src[i * 4 + 1];   // (green: the channel the eye reads brightness from)
    const lapAt = (x: number, y: number) => { const i = y * w + x, l = lum[i], a = x > 0 ? lum[i - 1] : l, b = x < w - 1 ? lum[i + 1] : l, c = y > 0 ? lum[i - w] : l, d = y < h - 1 ? lum[i + w] : l; return Math.abs(4 * l - a - b - c - d); };
    const laps: number[] = [];
    for (const c of near0) { const gx = c % gw, gy = (c / gw) | 0; for (let y = gy * f; y < Math.min(h, gy * f + f); y += 1) for (let x = gx * f; x < Math.min(w, gx * f + f); x += 1) if (y > 0 && x > 0 && y < h - 1 && x < w - 1) laps.push(lapAt(x, y)); }
    const grainL = laps.length ? med(laps) : 0;
    grain = grainL / 4; grainy = grainL >= 4;
    if (grainy) {
      const dens = new Float32Array(gn), th = 0.3 * grainL;
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
        let k = 0, t = 0;
        for (let y = gy * f; y < Math.min(h, gy * f + f); y++) for (let x = gx * f; x < Math.min(w, gx * f + f); x++) { t++; if (lapAt(x, y) >= th) k++; }
        dens[gy * gw + gx] = k / t;
      }
      const dk = boxBlur(dens, gw, gh, 1, 1);
      for (let i = 0; i < gn; i++) gOk[i] = dk[i] >= 0.65 ? 1 : 0;
    }
  }
  const STEP = 8, SEED = Math.max(8, 6 * grain + 8), RAW = 14 + 4 * grain;
  // ---- the background's own colour field: a plane (colour = a + b·x + c·y) fitted to the border cells that look like background.
  // The flood follows a smooth gradient step by step, but a pale hair tip or sleeve that fades off the picture's edge is a smooth
  // gradient too: without an anchor the flood walks into the character. A cell may only join when it is within CAPM of that plane.
  const CAPM = SEED + 4;
  const plane = (() => {
    const fit = (use: number[]) => {
      // least squares per channel over [1, x, y] (x, y in 0..1 across the grid)
      const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      for (const i of use) {
        const v = [1, (i % gw) / gw, ((i / gw) | 0) / gh];
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A[r * 3 + c] += v[r] * v[c];
        for (let ch = 0; ch < 3; ch++) for (let r = 0; r < 3; r++) B[ch][r] += v[r] * sm[i * 3 + ch];
      }
      const det = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      const D = det(A);
      if (use.length < 12 || Math.abs(D) < 1e-9) return null;
      return [0, 1, 2].map((ch) => [0, 1, 2].map((col) => { const M = A.slice(); for (let r = 0; r < 3; r++) M[r * 3 + col] = B[ch][r]; return det(M) / D; }));
    };
    // (start from the border cells near its median colour, then keep adding the border cells that lie within 12 of the fit so far: a
    // gradient widens the set step by step, the character where it touches the edge never joins)
    let use = bidx.filter((i) => dm0(i) <= 30), P = fit(use);
    for (let it = 0; it < 8 && P; it++) {
      const at = (i: number, ch: number) => P![ch][0] + P![ch][1] * ((i % gw) / gw) + P![ch][2] * (((i / gw) | 0) / gh);
      const next = bidx.filter((i) => Math.hypot(sm[i * 3] - at(i, 0), sm[i * 3 + 1] - at(i, 1), sm[i * 3 + 2] - at(i, 2)) <= 12);
      if (next.length < 12 || next.length === use.length) break;
      use = next; P = fit(use);
    }
    // (the anchor is only trusted for a wall of one colour: a real gradient is followed by the chain alone, as before, since a character
    // touching the border can tilt the fit)
    const flatWall = !!P && P.every((r) => Math.abs(r[1]) + Math.abs(r[2]) <= 8);
    return { at: (i: number, ch: number) => (P ? P[ch][0] + P[ch][1] * ((i % gw) / gw) + P[ch][2] * (((i / gw) | 0) / gh) : m0[ch]), flatWall };
  })();
  const offPlane = (i: number) => plane.flatWall && Math.hypot(sm[i * 3] - plane.at(i, 0), sm[i * 3 + 1] - plane.at(i, 1), sm[i * 3 + 2] - plane.at(i, 2)) > CAPM;
  const FLAT = f === 1 ? 0 : Math.max(10, 2 * med(near0.map((i) => rng[i])) + 6);
  const prot = new Uint8Array(gn);
  for (const p of protect) for (let y = Math.max(0, Math.floor((p.y - p.r) / f)); y <= Math.min(gh - 1, Math.ceil((p.y + p.r) / f)); y++) for (let x = Math.max(0, Math.floor((p.x - p.r) / f)); x <= Math.min(gw - 1, Math.ceil((p.x + p.r) / f)); x++) if (Math.hypot((x + 0.5) * f - p.x, (y + 0.5) * f - p.y) <= p.r + f) prot[y * gw + x] = 1;
  const bg = new Uint8Array(gn), q = new Int32Array(gn);
  let qh = 0, qt = 0;
  for (const i of bidx) if (!bg[i] && !prot[i] && gOk[i] && dm0(i) <= SEED && (f === 1 || rng[i] <= FLAT)) { bg[i] = 1; q[qt++] = i; }
  const join = (j: number, i: number) => !bg[j] && !prot[j] && gOk[j] === 1 && dist(sm, j, sm, i) <= STEP && !offPlane(j) && (f === 1 ? dist(g, j, sm, i) <= RAW : rng[j] <= FLAT);
  while (qh < qt) {
    const i = q[qh++], x = i % gw, y = (i / gw) | 0;
    if (x > 0 && join(i - 1, i)) { bg[i - 1] = 1; q[qt++] = i - 1; }
    if (x < gw - 1 && join(i + 1, i)) { bg[i + 1] = 1; q[qt++] = i + 1; }
    if (y > 0 && join(i - gw, i)) { bg[i - gw] = 1; q[qt++] = i - gw; }
    if (y < gh - 1 && join(i + gw, i)) { bg[i + gw] = 1; q[qt++] = i + gw; }
  }
  // ---- islands: background-coloured (and, with grain, grainy) areas fully enclosed by the character: they match the background in their own row
  // Run twice. The WIDE pass (what the checks below judge the cut by: how much is background, how the cut's edge looks) uses the loose match;
  // the cells actually REMOVED (`bgCut`) only the strict one: a pale jacket's shading matches a pale wall "in its own row" at the loose
  // tolerance, and removing it left holes in the character, so an island goes only when it is the background's own colour.
  const flood = bg.slice();
  const growIslands = (target: Uint8Array, tolFlat: number, tolGrain: number) => {
    const reach = Math.ceil(160 / f);
    const nearL = new Int32Array(gn).fill(-1), nearR = new Int32Array(gn).fill(-1);
    for (let y = 0; y < gh; y++) {
      let last = -100000;
      for (let x = 0; x < gw; x++) { if (target[y * gw + x]) last = x; if (x - last < reach) nearL[y * gw + x] = y * gw + last; }
      last = 100000;
      for (let x = gw - 1; x >= 0; x--) { if (target[y * gw + x]) last = x; if (last - x < reach) nearR[y * gw + x] = y * gw + last; }
    }
    const lab = new Int32Array(gn).fill(-1), cache = new Int8Array(gn);
    const ok2 = (i: number) => {
      if (cache[i]) return cache[i] === 1;
      let r = false;
      if (!target[i] && !prot[i] && gOk[i] === 1 && (f === 1 || rng[i] <= FLAT)) {
        const x = i % gw, l = nearL[i], rr = nearR[i], b = l < 0 ? rr : rr < 0 ? l : x - (l % gw) <= (rr % gw) - x ? l : rr;
        r = b >= 0 && dist(sm, i, sm, b) <= (grainy ? tolGrain : tolFlat);
      }
      cache[i] = r ? 1 : 2;
      return r;
    };
    if (qt > 0) {
      const cap = grainy ? 0.08 * gn : 0.02 * gn, minArea = Math.max(2, Math.round(12 / (f * f)));
      let nIsl = 0;
      const st: number[] = [];
      for (let i = 0; i < gn; i++) {
        if (target[i] || lab[i] >= 0 || !ok2(i)) continue;
        const comp = [i];
        st.length = 0; st.push(i);
        lab[i] = nIsl;
        let touches = false;
        while (st.length) {
          const k = st.pop()!, x = k % gw, y = (k / gw) | 0;
          if (x === 0 || y === 0 || x === gw - 1 || y === gh - 1) touches = true;
          if (x > 0 && lab[k - 1] < 0 && !target[k - 1] && ok2(k - 1)) { lab[k - 1] = nIsl; st.push(k - 1); comp.push(k - 1); }
          if (x < gw - 1 && lab[k + 1] < 0 && !target[k + 1] && ok2(k + 1)) { lab[k + 1] = nIsl; st.push(k + 1); comp.push(k + 1); }
          if (y > 0 && lab[k - gw] < 0 && !target[k - gw] && ok2(k - gw)) { lab[k - gw] = nIsl; st.push(k - gw); comp.push(k - gw); }
          if (y < gh - 1 && lab[k + gw] < 0 && !target[k + gw] && ok2(k + gw)) { lab[k + gw] = nIsl; st.push(k + gw); comp.push(k + gw); }
        }
        nIsl++;
        if (!touches && comp.length >= minArea && comp.length <= cap) for (const c of comp) target[c] = 1;
      }
    }
  };
  growIslands(bg, grainy ? 24 : 9, 24);
  const bgCut = flood;
  growIslands(bgCut, 3, 12);
  let nbg = 0;
  for (let i = 0; i < gn; i++) if (bg[i]) nbg++;
  const ratio = nbg / gn;
  if (ratio > 0.85) return keep('This picture is almost all one colour, so we could not tell the character from the background and kept all of it.');
  if (ratio < 0.01) return keep('We could not find a plain background to cut out, so we kept the whole picture. A PNG with a transparent background works best.');
  // a textured background (a photo: its colour keeps changing from cell to cell) cannot be cut cleanly: keep it
  {
    let gr = 0, k = 0;
    for (let i = 0; i < gn; i++) { if (!bg[i]) continue; const x = i % gw; if (x < gw - 1 && bg[i + 1]) { gr += dist(sm5, i, sm5, i + 1); k++; } if (i + gw < gn && bg[i + gw]) { gr += dist(sm5, i, sm5, i + gw); k++; } }
    if (k > 0 && gr / k > 1.2 * f) return keep(BUSY);
  }
  // confidence: where the cut runs, the two sides must differ (a cut through near-identical colours may have eaten the character)
  if (!grainy) {
    let edge = 0, low = 0;
    const adj = f === 1 ? 3 : 2;
    for (let i = 0; i < gn; i++) {
      if (!bg[i]) continue;
      const x = i % gw, y = (i / gw) | 0;
      for (let d = 0; d < 4; d++) {
        const dx = d === 0 ? -1 : d === 1 ? 1 : 0, dy = d === 2 ? -1 : d === 3 ? 1 : 0, jx = x + dx, jy = y + dy;
        if (jx < 0 || jy < 0 || jx >= gw || jy >= gh || bg[jy * gw + jx]) continue;
        edge++;
        // (across the soft edge: the background a step back against the character a few steps on)
        const kx = Math.min(gw - 1, Math.max(0, x + adj * dx)), ky = Math.min(gh - 1, Math.max(0, y + adj * dy)), ax = Math.min(gw - 1, Math.max(0, x - dx)), ay = Math.min(gh - 1, Math.max(0, y - dy));
        if (dist(sm, ay * gw + ax, sm, ky * gw + kx) < 10) low++;
      }
    }
    if (edge > 0 && low / edge > (f === 1 ? 0.2 : 0.045)) return keep(SAMECOL);   // (cells are coarser: fewer of the cut's edge cells look alike)
  }
  // ---- back to full size: the cells that are background are; along the cut the pixels are decided one by one
  let bgp: Uint8Array;
  if (f === 1) bgp = bgCut;
  else {
    bgp = new Uint8Array(n);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      if (!bgCut[gy * gw + gx]) continue;
      for (let y = gy * f; y < Math.min(h, gy * f + f); y++) bgp.fill(1, y * w + gx * f, y * w + Math.min(w, gx * f + f));
    }
    const cand: number[] = [], ref = new Float32Array(gn * 3);
    for (let c = 0; c < gn; c++) {
      if (bgCut[c] || prot[c]) continue;
      const cx = c % gw, cy = (c / gw) | 0;
      let k = 0, r = 0, gg = 0, b = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const xx = cx + ox, yy = cy + oy; if ((ox || oy) && xx >= 0 && yy >= 0 && xx < gw && yy < gh && bgCut[yy * gw + xx]) { k++; r += sm[(yy * gw + xx) * 3]; gg += sm[(yy * gw + xx) * 3 + 1]; b += sm[(yy * gw + xx) * 3 + 2]; } }
      if (k) { cand.push(c); ref[c * 3] = r / k; ref[c * 3 + 1] = gg / k; ref[c * 3 + 2] = b / k; }
    }
    const T2 = RAW * RAW;
    for (let pass = 0; pass < 4; pass++) {
      const fw = pass % 2 === 0;
      for (let ci = 0; ci < cand.length; ci++) {
        const c = cand[fw ? ci : cand.length - 1 - ci], cx = c % gw, cy = (c / gw) | 0, y0 = cy * f, y1 = Math.min(h, y0 + f), x0 = cx * f, x1 = Math.min(w, x0 + f);
        const rr = ref[c * 3], rg = ref[c * 3 + 1], rb = ref[c * 3 + 2];
        for (let yy = 0; yy < y1 - y0; yy++) {
          const y = fw ? y0 + yy : y1 - 1 - yy;
          for (let xx = 0; xx < x1 - x0; xx++) {
            const x = fw ? x0 + xx : x1 - 1 - xx, i = y * w + x;
            if (bgp[i]) continue;
            const dr = src[i * 4] - rr, dg = src[i * 4 + 1] - rg, db = src[i * 4 + 2] - rb;
            if (dr * dr + dg * dg + db * db > T2) continue;
            if ((x > 0 && bgp[i - 1] === 1) || (x < w - 1 && bgp[i + 1] === 1) || (y > 0 && bgp[i - w] === 1) || (y < h - 1 && bgp[i + w] === 1)) bgp[i] = 1;
          }
        }
      }
    }
  }
  // ---- soft edge: distance (4-neighbour steps, up to 2) from the background, the background's colour pulled out of the edge
  const D = new Uint8Array(n).fill(3), qq = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (!bgp[i]) continue;
    D[i] = 0;
    const x = i % w;
    if ((x > 0 && !bgp[i - 1]) || (x < w - 1 && !bgp[i + 1]) || (i >= w && !bgp[i - w]) || (i + w < n && !bgp[i + w])) qq[tail++] = i;
  }
  while (head < tail) {
    const i = qq[head++], x = i % w, nd = D[i] + 1;
    if (nd > 2) continue;
    if (x > 0 && D[i - 1] > nd) { D[i - 1] = nd; qq[tail++] = i - 1; }
    if (x < w - 1 && D[i + 1] > nd) { D[i + 1] = nd; qq[tail++] = i + 1; }
    if (i >= w && D[i - w] > nd) { D[i - w] = nd; qq[tail++] = i - w; }
    if (i + w < n && D[i + w] > nd) { D[i + w] = nd; qq[tail++] = i + w; }
  }
  // (qq holds the edge pixels by growing distance: the farthest are fixed first)
  for (let t = tail - 1; t >= 0; t--) {
    const i = qq[t], dd = D[i];
    if (dd < 1) continue;
    const x = i % w, y = (i / w) | 0;
    let r = 0, gg = 0, b = 0, k = 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const xx = x + ox, yy = y + oy;
      if ((ox || oy) && xx >= 0 && yy >= 0 && xx < w && yy < h) { const j = yy * w + xx; if (D[j] > dd) { r += out[j * 4]; gg += out[j * 4 + 1]; b += out[j * 4 + 2]; k++; } }
    }
    if (k) { out[i * 4] = r / k; out[i * 4 + 1] = gg / k; out[i * 4 + 2] = b / k; }
  }
  const A = [0, 150, 225, 255];
  for (let i = 0; i < n; i++) if (D[i] < 3) out[i * 4 + 3] = A[D[i]];
  return { rgba: out, mode: 'removed' };
}

// ------------------------------------------------------------------ inpainting (push-pull)
/** Fill every pixel of a w×h window from the seeds (colour v, weight wt 0..1): multi-scale average down, smooth fill back up. */
function fillSkin(w: number, h: number, v: Float32Array, wt: Float32Array, fallback: number[]): Float32Array {
  type Lv = { w: number; h: number; v: Float32Array; wt: Float32Array };
  const lv: Lv[] = [{ w, h, v: v.slice(), wt: wt.slice() }];
  while (lv[lv.length - 1].w > 1 || lv[lv.length - 1].h > 1) {
    const a = lv[lv.length - 1], cw = (a.w + 1) >> 1, ch = (a.h + 1) >> 1;
    const cv = new Float32Array(cw * ch * 3), cwt = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      let ws = 0, c0 = 0, c1 = 0, c2 = 0, cnt = 0;
      for (let oy = 0; oy < 2; oy++) for (let ox = 0; ox < 2; ox++) {
        const xx = x * 2 + ox, yy = y * 2 + oy;
        if (xx >= a.w || yy >= a.h) continue;
        const i = yy * a.w + xx, k = a.wt[i];
        cnt++; ws += k; c0 += k * a.v[i * 3]; c1 += k * a.v[i * 3 + 1]; c2 += k * a.v[i * 3 + 2];
      }
      const o = y * cw + x;
      if (ws > 0) { cv[o * 3] = c0 / ws; cv[o * 3 + 1] = c1 / ws; cv[o * 3 + 2] = c2 / ws; cwt[o] = ws / cnt; }
    }
    lv.push({ w: cw, h: ch, v: cv, wt: cwt });
  }
  const top = lv[lv.length - 1];
  if (top.wt[0] <= 0) { top.v[0] = fallback[0]; top.v[1] = fallback[1]; top.v[2] = fallback[2]; }
  top.wt[0] = 1;
  for (let k = lv.length - 2; k >= 0; k--) {
    const a = lv[k], c = lv[k + 1];
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
      const i = y * a.w + x, w0 = a.wt[i];
      if (w0 >= 1) continue;
      const fx = Math.max(0, Math.min(c.w - 1, (x + 0.5) / 2 - 0.5)), fy = Math.max(0, Math.min(c.h - 1, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const s = (c.v[(y0 * c.w + x0) * 3 + ch] * (1 - tx) + c.v[(y0 * c.w + x1) * 3 + ch] * tx) * (1 - ty) + (c.v[(y1 * c.w + x0) * 3 + ch] * (1 - tx) + c.v[(y1 * c.w + x1) * 3 + ch] * tx) * ty;
        a.v[i * 3 + ch] = w0 * a.v[i * 3 + ch] + (1 - w0) * s;
      }
      a.wt[i] = 1;
    }
  }
  return lv[0].v;
}

interface Lifted { x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray; /** the part itself (without a soft halo / margin), per pixel of the window */ core?: Uint8Array }
const LIFT_LO = 12, LIFT_HI = 40;

/** Lift a feature (an eye, the mouth) out of `img` around the ellipse `e`: what differs from the skin around it (inpainted)
 *  goes to the returned layer (alpha = how much of it, colours UNMIXED so the layer over the new base reproduces the picture
 *  exactly); `img` keeps the inpainted skin there. Only the part connected to the middle of the ellipse is taken (a brow or a
 *  hair strand crossing it stays where it is). null = nothing there (plain skin). */
function liftOnce(img: Uint8ClampedArray, W: number, H: number, e0: Ell, o: { scale?: number; solid?: number; halo?: number; check?: { kind: 'eye' | 'mouth'; size: number; contain?: boolean } } = {}): Lifted | null {
  // `scale`: how much wider than the tap's ellipse to look for the part (a mouth is found by its own outline, whatever its
  // size); `solid` > 0: the WHOLE connected part plus that many px of margin is lifted (the base keeps no trace of it)
  const sc = o.scale ?? 1, e: Ell = { cx: e0.cx, cy: e0.cy, rx: e0.rx * sc, ry: e0.ry * sc };
  const x0 = Math.max(0, Math.floor(e.cx - e.rx * 1.6)), x1 = Math.min(W, Math.ceil(e.cx + e.rx * 1.6) + 1);
  const y0 = Math.max(0, Math.floor(e.cy - e.ry * 1.6)), y1 = Math.min(H, Math.ceil(e.cy + e.ry * 1.6) + 1);
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const n = w * h, rho = new Float32Array(n), px = (i: number) => (((y0 + ((i / w) | 0)) * W) + x0 + (i % w)) * 4;
  for (let i = 0; i < n; i++) rho[i] = Math.hypot((x0 + (i % w) + 0.5 - e.cx) / e.rx, (y0 + ((i / w) | 0) + 0.5 - e.cy) / e.ry);
  // seeds: opaque pixels in the ring around the ellipse that look like the ring's typical colour (hair, lashes, lines excluded)
  let ring: number[] = [];
  for (let i = 0; i < n; i++) if (rho[i] >= 1.05 && rho[i] < 1.6 && img[px(i) + 3] >= 230) ring.push(i);
  if (!ring.length) for (let i = 0; i < n; i++) if (rho[i] >= 1 && img[px(i) + 3] >= 230) ring.push(i);
  if (!ring.length) return null;
  const mid = (c: number) => { const v = ring.map((i) => img[px(i) + c]).sort((a, b) => a - b); return v[v.length >> 1]; };
  // (a face is mostly skin: when the ring has skin-coloured pixels, those are the seeds, so a fringe of pale hair or a
  // white lash line around the eye never tints the skin put back under it)
  const skin = ring.filter((i) => { const p = px(i), r = img[p], g = img[p + 1], b = img[p + 2]; return r > 150 && r >= g && g >= b - 10 && r - b > 10 && r - b < 110; });
  if (skin.length >= 24 && skin.length >= ring.length * 0.12) ring = skin;
  const med = [mid(0), mid(1), mid(2)];
  const dist = (i: number, c: ArrayLike<number>) => Math.hypot(img[px(i)] - c[0], img[px(i) + 1] - c[1], img[px(i) + 2] - c[2]);
  const keep = ring.filter((i) => dist(i, med) <= 42);
  if (keep.length >= 6) ring = keep;
  const vals = new Float32Array(n * 3), wts = new Float32Array(n);
  for (const i of ring) { const p = px(i); vals[i * 3] = img[p]; vals[i * 3 + 1] = img[p + 1]; vals[i * 3 + 2] = img[p + 2]; wts[i] = 1; }
  let S = fillSkin(w, h, vals, wts, med);
  // how much of each pixel is the feature (colour distance from the skin under it), fading out toward the ellipse's edge
  const lam0 = new Float32Array(n), dst = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (rho[i] >= 1) continue;
    const p = px(i), d = Math.hypot(img[p] - S[i * 3], img[p + 1] - S[i * 3 + 1], img[p + 2] - S[i * 3 + 2]);
    dst[i] = d; lam0[i] = ss(LIFT_LO, LIFT_HI, d) * (1 - ss(0.78, 1, rho[i])) * (img[p + 3] / 255);
  }
  // the part connected to the middle
  const comp = new Uint8Array(n), st: number[] = [];
  for (const lim of [0.55 / sc, 0.8 / sc]) {
    for (let i = 0; i < n; i++) if (rho[i] <= lim && lam0[i] >= 0.5) { comp[i] = 1; st.push(i); }
    if (st.length) break;
  }
  if (!st.length) return null;
  while (st.length) {
    const i = st.pop()!, x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !comp[j] && lam0[j] > 0.12) { comp[j] = 1; st.push(j); }
  }
  // is it what the user said it is? an eye / mouth-like blob right at the tap, of a plausible size, with real contrast (dark line, iris, red inside)
  if (o.check) {
    let bx0 = w, bx1 = -1, by0 = h, by1 = -1, maxD = 0, nearTap = false, area = 0, maxRho = 0;
    for (let i = 0; i < n; i++) if (comp[i]) {
      const x = i % w, y = (i / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (dst[i] > maxD) maxD = dst[i];
      area++;
      if (rho[i] > maxRho) maxRho = rho[i];
      if (Math.hypot((x0 + x + 0.5 - e0.cx) / e0.rx, (y0 + y + 0.5 - e0.cy) / e0.ry) <= 0.4) nearTap = true;
    }
    const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, S0 = o.check.size, eye = o.check.kind === 'eye';
    const okSize = eye ? bw >= 0.12 * S0 && bw <= 1.05 * S0 && bh >= 0.04 * S0 && bh <= 0.8 * S0 && area >= 0.4 * bw * bh && bw <= 4.5 * bh && bh <= 1.5 * bw : bw >= 0.3 * S0 && bw <= 3 * S0 && bh <= 0.8 * S0;
    if (!(nearTap && okSize && maxD >= (eye ? 60 : 45))) return null;
    if (eye) {
      // (a hair clump has dark strands, never a dark mass: erode the dark part of the blob)
      const dk = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (comp[i]) { const p = px(i); if (0.3 * img[p] + 0.59 * img[p + 1] + 0.11 * img[p + 2] < 0.6 * (0.3 * S[i * 3] + 0.59 * S[i * 3 + 1] + 0.11 * S[i * 3 + 2])) dk[i] = 1; }
      let mass = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (dk[i] && dk[i - 1] && dk[i + 1] && dk[i - w] && dk[i + w] && dk[i - w - 1] && dk[i - w + 1] && dk[i + w - 1] && dk[i + w + 1]) mass++; }
      if (mass < 6) return null;
    }
    if (o.check.contain && maxRho >= 0.85) return null;
  }
  const use = new Uint8Array(n), lamU = new Float32Array(n);
  if (o.solid) {
    // all of it, then a margin that fades out (so the skin put back blends into the real skin around)
    let front: number[] = [];
    for (let i = 0; i < n; i++) if (comp[i]) { use[i] = 1; lamU[i] = img[px(i) + 3] / 255; front.push(i); }
    for (let k = 1; k <= o.solid; k++) {
      const next: number[] = [];
      for (const i of front) {
        const x = i % w, y = (i / w) | 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox, yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || use[yy * w + xx]) continue;
          use[yy * w + xx] = 1; lamU[yy * w + xx] = (1 - (k - 1) / o.solid) * (img[px(yy * w + xx) + 3] / 255); next.push(yy * w + xx);
        }
      }
      front = next;
    }
    // a seamless fill: the skin put back is grown inward from the skin RIGHT AROUND the part (a few px wide band, skin-coloured
    // pixels only), so it carries the real gradient there and meets the picture with no step, instead of averaging a far ring
    {
      const R = 10, depth = new Int16Array(n).fill(-1);
      let fr: number[] = [];
      for (let i = 0; i < n; i++) if (use[i]) { depth[i] = 0; fr.push(i); }
      const band: number[] = [];
      for (let k = 1; k <= R && fr.length; k++) {
        const next: number[] = [];
        for (const i of fr) {
          const x = i % w, y = (i / w) | 0;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && depth[j] < 0) { depth[j] = k; next.push(j); band.push(j); }
        }
        fr = next;
      }
      let seeds = band.filter((i) => { const p = px(i), r = img[p], g = img[p + 1], b = img[p + 2]; return img[p + 3] >= 230 && r > 150 && r >= g && g >= b - 10 && r - b > 10 && r - b < 110; });
      if (seeds.length < 12) seeds = band.filter((i) => img[px(i) + 3] >= 230);
      if (seeds.length >= 12) {
        const m2 = [0, 1, 2].map((c) => { const v = seeds.map((i) => img[px(i) + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
        const kept = seeds.filter((i) => dist(i, m2) <= 30);
        if (kept.length >= 12) seeds = kept;
        const v2 = new Float32Array(n * 3), w2 = new Float32Array(n);
        for (const i of seeds) { const p = px(i); v2[i * 3] = img[p]; v2[i * 3 + 1] = img[p + 1]; v2[i * 3 + 2] = img[p + 2]; w2[i] = 1 / (1 + 0.4 * (depth[i] - 1)); }
        S = fillSkin(w, h, v2, w2, m2);
        for (let i = 0; i < n; i++) if (rho[i] < 1) { const p = px(i); dst[i] = Math.hypot(img[p] - S[i * 3], img[p + 1] - S[i * 3 + 1], img[p + 2] - S[i * 3 + 2]); }
      }
    }
    // a soft halo (the faint glow of a lip, a shadow under it): weaker differences within `halo` px of the part join it
    if (o.halo) {
      const depth = new Int16Array(n).fill(-1);
      let fr: number[] = [];
      for (let i = 0; i < n; i++) if (comp[i]) { depth[i] = 0; fr.push(i); }
      for (let k = 1; k <= o.halo && fr.length; k++) {
        const next: number[] = [];
        for (const i of fr) {
          const x = i % w, y = (i / w) | 0;
          for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
            if (j < 0 || depth[j] >= 0 || rho[j] >= 1 || ss(3, 12, dst[j]) < 0.05) continue;
            depth[j] = k; next.push(j);
            if (!use[j]) { use[j] = 1; lamU[j] = ss(3, 12, dst[j]) * (1 - (k - 1) / o.halo!) * (img[px(j) + 3] / 255); }
          }
        }
        fr = next;
      }
    }
  } else for (let i = 0; i < n; i++) if (comp[i]) {
    const x = i % w, y = (i / w) | 0;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const xx = x + ox, yy = y + oy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { use[yy * w + xx] = 1; lamU[yy * w + xx] = lam0[yy * w + xx]; } }
  }
  // base ← skin where lifted; layer ← what is needed over the new base to give the original back
  const lay = new Uint8ClampedArray(n * 4);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = px(i), P = [img[p], img[p + 1], img[p + 2]], lam = use[i] ? lamU[i] : 0;
    lay[i * 4] = P[0]; lay[i * 4 + 1] = P[1]; lay[i * 4 + 2] = P[2];
    if (lam <= 0) continue;
    const B = [0, 1, 2].map((c) => clamp8(P[c] + (S[i * 3 + c] - P[c]) * lam));
    let a = 0;
    for (let c = 0; c < 3; c++) {
      const dl = P[c] - B[c], lim = dl > 0 ? 255 - B[c] : B[c];
      a = Math.max(a, dl === 0 ? 0 : lim > 0 ? Math.abs(dl) / lim : 1);
    }
    const A = Math.min(255, Math.ceil(a * 255 - 1e-9));
    if (A <= 0) continue;
    for (let c = 0; c < 3; c++) { lay[i * 4 + c] = clamp8(B[c] + ((P[c] - B[c]) * 255) / A); img[p + c] = B[c]; }
    lay[i * 4 + 3] = A; total += A;
  }
  return total < 255 * 12 ? null : { x: x0, y: y0, w, h, rgba: lay, core: comp };
}

/** Lift an eye / the mouth at a tap. The mouth is looked for at a few widths, the widest that still gives a mouth-sized part
 *  (a mouth with nothing known about the face is not allowed to run into the eyes). null = nothing eye / mouth-like there. */
function liftFeature(img: Uint8ClampedArray, W: number, H: number, e0: Ell, o: { kind: 'eye' | 'mouth'; size: number; solid?: number; halo?: number }): Lifted | null {
  const scales = o.kind === 'mouth' ? [0.55, 0.8, 1.1, 1.6] : [1, 0.7];
  for (let k = 0; k < scales.length; k++) {
    const L = liftOnce(img, W, H, e0, { scale: scales[k], solid: o.solid, halo: o.halo, check: { kind: o.kind, size: o.size, contain: o.kind === 'mouth' && k < scales.length - 1 } });
    if (L) return L;
  }
  return null;
}

/** The closed eye: a thin dark-warm lid line along the curve autorig closes the eye onto (62 % down the eye, bowed a little). */
function lidLine(eye: Lifted, d: number): Lifted | null {
  const { w, h, rgba } = eye;
  let top = h, bot = -1, left = w, right = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rgba[(y * w + x) * 4 + 3] > 40) { if (y < top) top = y; if (y > bot) bot = y; if (x < left) left = x; if (x > right) right = x; }
  if (bot < 0 || right - left < 4) return null;
  const eh = bot - top + 1, ew = right - left + 1, cx = (left + right + 1) / 2;
  // ink: the darkest tenth of the eye's own pixels, pulled toward a warm brown (never pure black)
  const dark: number[][] = [];
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= 128) dark.push([0.3 * rgba[i * 4] + 0.59 * rgba[i * 4 + 1] + 0.11 * rgba[i * 4 + 2], rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  dark.sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(dark.length / 10)), ink = [0, 0, 0];
  for (let i = 0; i < k && dark.length; i++) for (let c = 0; c < 3; c++) ink[c] += (dark[i]?.[c + 1] ?? 70) / k;
  const warm = [84, 50, 54], col = [0, 1, 2].map((c) => clamp8(ink[c] * 0.45 + warm[c] * 0.55));
  const th0 = Math.min(eh * 0.2, Math.max(2, d * 0.032));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = col[0]; out[i * 4 + 1] = col[1]; out[i * 4 + 2] = col[2]; }
  for (let x = left; x <= right; x++) {
    const t = (x + 0.5 - cx) / (ew / 2);
    if (Math.abs(t) >= 1) continue;
    const yc = top + eh * 0.62 + eh * 0.07 * (1 - t * t) + 0.5, th = th0 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 4)));
    for (let y = Math.max(0, Math.floor(yc - th - 1)); y <= Math.min(h - 1, Math.ceil(yc + th + 1)); y++) {
      const a = Math.max(0, Math.min(1, th / 2 - Math.abs(y + 0.5 - yc) + 0.5));
      if (a > 0) out[(y * w + x) * 4 + 3] = Math.max(out[(y * w + x) * 4 + 3], Math.round(a * 255));
    }
  }
  return { x: eye.x, y: eye.y, w, h, rgba: out };
}

/** The darkest tenth of a lifted part's own pixels, pulled toward a warm brown (never pure black): the ink of a drawn line. */
function inkOf(L: Lifted): number[] {
  const dark: number[][] = [];
  for (let i = 0; i < L.w * L.h; i++) if (L.rgba[i * 4 + 3] >= 128) dark.push([0.3 * L.rgba[i * 4] + 0.59 * L.rgba[i * 4 + 1] + 0.11 * L.rgba[i * 4 + 2], L.rgba[i * 4], L.rgba[i * 4 + 1], L.rgba[i * 4 + 2]]);
  dark.sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.floor(dark.length / 10)), ink = [0, 0, 0];
  for (let i = 0; i < k && dark.length; i++) for (let c = 0; c < 3; c++) ink[c] += (dark[i]?.[c + 1] ?? 70) / k;
  return [0, 1, 2].map((c) => clamp8(ink[c] * 0.45 + [84, 50, 54][c] * 0.55));
}

/** The lifted mouth: is it OPEN (an inside, a mouth with height) or a CLOSED line? For an open one, also the closed-mouth line:
 *  flat dark-warm, along the art's top edge (where the lips meet when it shuts), thinning toward the corners. */
function mouthLine(art: Lifted, d: number, wantLine = true): { open: boolean; line: Lifted | null; x0: number; ys: number[] } {
  const { w, h, rgba } = art, on = (i: number) => (art.core ? art.core[i] === 1 : rgba[i * 4 + 3] > 40);
  const top = new Int32Array(w).fill(-1), bot = new Int32Array(w).fill(-1), cnt = new Int32Array(w);
  let left = w, right = -1;
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (on(y * w + x)) { if (top[x] < 0) top[x] = y; bot[x] = y; cnt[x]++; if (x < left) left = x; if (x > right) right = x; }
  if (right - left < 6) return { open: false, line: null, x0: 0, ys: [] };
  const ew = right - left + 1, mid: number[] = [];
  for (let x = left + Math.floor(ew * 0.25); x <= right - Math.floor(ew * 0.25); x++) mid.push(cnt[x]);
  mid.sort((a, b) => a - b);
  const open = mid[mid.length >> 1] > 0.15 * ew;
  if (!open) return { open: false, line: null, x0: 0, ys: [] };
  // the stroke's thickness at the top edge (dark run from the top, in the middle columns)
  const ink = inkOf(art), inkL = 0.3 * ink[0] + 0.59 * ink[1] + 0.11 * ink[2];
  let th = 0, tn = 0;
  for (let x = left + Math.floor(ew * 0.4); x <= left + Math.floor(ew * 0.6); x++) {
    if (top[x] < 0) continue;
    let run = 0;
    for (let y = top[x]; y < h; y++) { const i = (y * w + x) * 4; if (on(i / 4) && 0.3 * rgba[i] + 0.59 * rgba[i + 1] + 0.11 * rgba[i + 2] < inkL + 60) run++; else break; }
    th += run; tn++;
  }
  th = Math.max(2.5, Math.min(Math.max(2.5, d * 0.05), tn ? th / tn : d * 0.025));
  // the curve: the top edge + half the stroke, smoothed
  const raw: number[] = [];
  let last = -1;
  for (let x = left; x <= right; x++) { if (top[x] >= 0) last = top[x]; raw.push(last); }
  for (let i = 0; i < raw.length && raw[i] < 0; i++) raw[i] = raw.find((v) => v >= 0) ?? 0;
  const win = Math.max(2, Math.round(ew * 0.06)), ys: number[] = [];
  for (let i = 0; i < raw.length; i++) { let a = 0, k = 0; for (let j = Math.max(0, i - win); j <= Math.min(raw.length - 1, i + win); j++) { a += raw[j]; k++; } ys.push(a / k + th / 2); }
  if (!wantLine) return { open: true, line: null, x0: art.x + left, ys: ys.map((v) => v + art.y) };
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { out[i * 4] = ink[0]; out[i * 4 + 1] = ink[1]; out[i * 4 + 2] = ink[2]; }
  for (let i = 0; i < ys.length; i++) {
    const t = ((i + 0.5) / ys.length) * 2 - 1, thick = th * (0.25 + 0.75 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 4)))), x = left + i, yc = ys[i] + 0.5;
    for (let y = Math.max(0, Math.floor(yc - thick - 1)); y <= Math.min(h - 1, Math.ceil(yc + thick + 1)); y++) {
      const a = Math.max(0, Math.min(1, thick / 2 - Math.abs(y + 0.5 - yc) + 0.5));
      if (a > 0) out[(y * w + x) * 4 + 3] = Math.max(out[(y * w + x) * 4 + 3], Math.round(a * 255));
    }
  }
  return { open: true, line: { x: art.x, y: art.y, w, h, rgba: out }, x0: art.x + left, ys: ys.map((v) => v + art.y) };
}

/** A drawn open mouth often has its upper lip as a separate thin dark stroke floating ABOVE the opening (wider than it). Find it:
 *  a dark component of the lifted mouth with a gap of skin between it and the opening, above it, thin and about as wide.
 *  Returns the stroke and the rest (the opening), cut apart, and the stroke's centre line per column. */
function detachStroke(L: Lifted): { stroke: Lifted; rest: Lifted; sx0: number; ys: number[] } | null {
  const { w, h, rgba, core } = L;
  if (!core) return null;
  const n = w * h, id = new Int32Array(n).fill(-1), comps: { area: number; x0: number; x1: number; y0: number; y1: number; sy: number; lum: number }[] = [];
  const strong = (i: number) => core[i] === 1 && rgba[i * 4 + 3] >= 90;
  for (let i = 0; i < n; i++) {
    if (id[i] >= 0 || !strong(i)) continue;
    const c = { area: 0, x0: w, x1: -1, y0: h, y1: -1, sy: 0, lum: 0 }, st = [i];
    id[i] = comps.length;
    while (st.length) {
      const k = st.pop()!, x = k % w, y = (k / w) | 0;
      c.area++; c.sy += y; c.lum += 0.3 * rgba[k * 4] + 0.59 * rgba[k * 4 + 1] + 0.11 * rgba[k * 4 + 2];
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) if (j >= 0 && id[j] < 0 && strong(j)) { id[j] = comps.length; st.push(j); }
    }
    comps.push(c);
  }
  if (comps.length < 2) return null;
  let mi = 0;
  comps.forEach((c, i) => { if (c.area > comps[mi].area) mi = i; });
  const M = comps[mi], mw = M.x1 - M.x0 + 1, mh = M.y1 - M.y0 + 1;
  // the stroke may be broken into pieces by its soft edge: every dark piece above the opening, taken together
  const group: number[] = [];
  comps.forEach((c, i) => { if (i !== mi && c.lum / c.area < 140 && c.sy / c.area < M.y0 + 0.1 * mh) group.push(i); });
  if (!group.length) return null;
  let gx0 = w, gx1 = -1, gy0 = h, gy1 = -1, garea = 0;
  for (const i of group) { const c = comps[i]; gx0 = Math.min(gx0, c.x0); gx1 = Math.max(gx1, c.x1); gy0 = Math.min(gy0, c.y0); gy1 = Math.max(gy1, c.y1); garea += c.area; }
  const gw = gx1 - gx0 + 1, ghh = gy1 - gy0 + 1, ov = Math.min(gx1, M.x1) - Math.max(gx0, M.x0) + 1;
  if (garea < 12 || gw < 0.5 * mw || ghh > 0.4 * gw || ov < 0.5 * Math.min(gw, mw)) return null;
  const inGroup = new Set(group), near = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (id[i] >= 0 && inGroup.has(id[i])) { const x = i % w, y = (i / w) | 0; for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) { const xx = x + ox, yy = y + oy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1; } }
  // (and every faint pixel of the lifted part in the stroke's own rows: its soft parts belong to it, not to the opening)
  for (let y = Math.max(0, gy0 - 3); y <= Math.min(h - 1, gy1 + 1); y++) for (let x = Math.max(0, gx0 - 3); x <= Math.min(w - 1, gx1 + 3); x++) if (core[y * w + x] === 1 || rgba[(y * w + x) * 4 + 3] > 16) near[y * w + x] = 1;
  const sr = new Uint8ClampedArray(rgba), rr = new Uint8ClampedArray(rgba), sc = new Uint8Array(n), rc = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (near[i]) { rr[i * 4 + 3] = 0; sc[i] = core[i]; } else { sr[i * 4 + 3] = 0; rc[i] = core[i]; } }
  const ys: number[] = [];
  for (let x = gx0; x <= gx1; x++) {
    let a = 0, k = 0;
    for (let y = gy0; y <= gy1; y++) if (id[y * w + x] >= 0 && inGroup.has(id[y * w + x])) { a += y; k++; }
    ys.push(L.y + (k ? a / k : ys.length ? ys[ys.length - 1] - L.y - 0.5 : (gy0 + gy1) / 2) + 0.5);
  }
  return { stroke: { x: L.x, y: L.y, w, h, rgba: sr, core: sc }, rest: { x: L.x, y: L.y, w, h, rgba: rr, core: rc }, sx0: L.x + gx0, ys };
}

// ------------------------------------------------------------------ geometry from the taps
function geometry(W: number, H: number, alpha: (i: number) => number, taps: PictureTaps, o: PictureOpts) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha(y * W + x) > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const eyes = ([taps.eyeL, taps.eyeR].filter(Boolean) as [number, number][]).sort((a, b) => a[0] - b[0]);
  let d = 0, mx = 0, ey = 0, known = false;
  if (eyes.length === 2 && Math.hypot(eyes[1][0] - eyes[0][0], eyes[1][1] - eyes[0][1]) >= 6) {
    d = Math.hypot(eyes[1][0] - eyes[0][0], eyes[1][1] - eyes[0][1]); mx = (eyes[0][0] + eyes[1][0]) / 2; ey = (eyes[0][1] + eyes[1][1]) / 2; known = true;
  } else if (eyes.length) {
    const e = eyes[0], m = taps.mouth;
    d = m ? Math.max(8, Math.hypot(m[0] - e[0], m[1] - e[1]) * 1.58) : Math.max(8, bw * 0.25);
    mx = m ? m[0] : e[0] + (e[0] < W / 2 ? 1 : -1) * d / 2; ey = e[1]; known = true;
  }
  let head: Ell | null = null;
  const hs = o.headScale ?? 1;
  if (taps.head) head = { ...taps.head };
  else if (known) head = { cx: mx, cy: ey - 0.6 * d, rx: 1.6 * d * hs, ry: 1.9 * d * hs };
  else if (taps.mouth) {
    // a mascot: the head is the top ~40 % of the cut-out
    let a = W, b = -1;
    for (let y = y0; y < y0 + bh * 0.4; y++) for (let x = 0; x < W; x++) if (alpha(y * W + x) > 128) { if (x < a) a = x; if (x > b) b = x; }
    if (b < 0) { a = x0; b = x1; }
    head = { cx: (a + b) / 2, cy: y0 + 0.22 * bh, rx: ((b - a) / 2 + 1) * 1.02 * hs, ry: 0.26 * bh * hs };
  }
  if (head && taps.head && hs !== 1) head = { ...head, rx: head.rx * hs, ry: head.ry * hs };
  // a head ellipse that would be most of the character (a mascot: the whole body is its head) is fitted to the blob's upper part
  let fitted = false;
  if (head && !taps.head && 2 * head.ry > 0.8 * bh) {
    fitted = true; const ry = Math.min(head.ry, 0.38 * bh * hs); head = { cx: head.cx, cy: y0 + 0.02 * bh + ry, rx: Math.min(head.rx, 0.47 * bw * hs), ry }; }
  if (!known) d = head ? head.rx / 1.6 : Math.max(8, bw * 0.2);
  return { d, mx, ey, head, eyes, bbox: { x0, y0, x1, y1 }, fitted };
}


const mkLayer = (name: string, l: Lifted, visible = true): ArtLayer => ({ name, path: [], x: l.x, y: l.y, w: l.w, h: l.h, rgba: l.rgba, opacity: 1, visible, blend: 'normal', clipped: false });

// ------------------------------------------------------------------ the picture → layers
const EYE_MSG = "We couldn't find an eye where you tapped. Tap the middle of the eye, or skip it.";
const MOUTH_MSG = "We couldn't find a mouth where you tapped. Tap the middle of the mouth, or skip it.";

/** The layered picture for `pic` and the taps: ONE Body layer (the whole picture, with the eyes and the mouth lifted out and
 *  the skin put back under them: no pixel is in two layers except the lifted parts over that skin), Eye closed R / L (hidden:
 *  shown by the blink), Eye R / L, and the mouth: "Mouth" (a drawn closed line) or, for a drawn OPEN mouth, "Mouth inside"
 *  (the art) + "Mouth upper" (the made closed line, or the drawn upper-lip stroke when it floats above the opening). A tap that
 *  is not on an eye / mouth (off the picture, not a number, on hair or cheek) makes no layer and says so in `warnings`. */
export function pictureBuild(pic: PicturePixels, taps0: PictureTaps = {}, o: PictureOpts = {}): PictureBuild {
  const { w: W, h: H } = pic;
  if (pic.rgba.length !== W * H * 4) throw new Error('picture size does not match its pixels');
  const warnings: string[] = [];
  const clean = (p?: [number, number]): [number, number] | undefined => (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] >= 0 && p[1] >= 0 && p[0] < W && p[1] < H ? [p[0], p[1]] : undefined);
  const hd = taps0.head && [taps0.head.cx, taps0.head.cy, taps0.head.rx, taps0.head.ry].every((v) => Number.isFinite(v)) && taps0.head.rx > 1 && taps0.head.ry > 1 ? taps0.head : undefined;
  const taps: PictureTaps = { eyeL: clean(taps0.eyeL), eyeR: clean(taps0.eyeR), mouth: clean(taps0.mouth), head: hd };
  for (const k of ['eyeL', 'eyeR'] as const) if (taps0[k] !== undefined && !taps[k]) warnings.push(EYE_MSG);
  if (taps0.mouth !== undefined && !taps.mouth) warnings.push(MOUTH_MSG);
  // the cut-out must not run into the face the user pointed at
  const two = taps.eyeL && taps.eyeR ? Math.hypot(taps.eyeL[0] - taps.eyeR[0], taps.eyeL[1] - taps.eyeR[1]) : 0;
  const dTap = two >= 6 ? two : Math.max(8, 0.1 * Math.min(W, H));
  const protect = [...[taps.eyeL, taps.eyeR].filter(Boolean).map((p) => ({ x: p![0], y: p![1], r: 0.9 * dTap })), ...(taps.mouth ? [{ x: taps.mouth[0], y: taps.mouth[1], r: dTap }] : [])];
  if (two >= 6) protect.push({ x: (taps.eyeL![0] + taps.eyeR![0]) / 2, y: (taps.eyeL![1] + taps.eyeR![1]) / 2 + 0.3 * dTap, r: 1.3 * dTap });
  const cut = cutout(pic, protect);
  const img = cut.rgba;
  if (cut.warn) warnings.push(cut.warn);
  const alphaOf = (i: number) => img[i * 4 + 3];
  let geo = geometry(W, H, alphaOf, taps, o);
  const es = o.eyeScale ?? 1, ms = o.mouthScale ?? 1;
  const eyeLayers: ArtLayer[] = [], closedLayers: ArtLayer[] = [], mouthLayers: ArtLayer[] = [];
  let mouthStyle: PictureBuild['mouthStyle'] = null, mouthCurve: PictureBuild['mouthCurve'] = null, mouthMorph: PictureBuild['mouthMorph'] = null;
  const askedEyes = geo.eyes.length;
  const backup = askedEyes > 1 ? new Uint8ClampedArray(img) : null, sizes: number[] = [], ys: number[] = [];
  for (const p of geo.eyes) {
    const name = p[0] < geo.mx ? 'R' : 'L', d = geo.d;
    const L = liftFeature(img, W, H, { cx: p[0], cy: p[1], rx: Math.max(4, 0.42 * d * es), ry: Math.max(3, 0.32 * d * es) }, { kind: 'eye', size: d });
    if (!L) { warnings.push(EYE_MSG); continue; }
    eyeLayers.push(mkLayer(`Eye ${name}`, L));
    let area = 0;
    for (let i = 0; i < L.w * L.h; i++) if (L.core?.[i]) area++;
    let sy = 0;
    for (let i = 0; i < L.w * L.h; i++) if (L.core?.[i]) sy += (i / L.w) | 0;
    sizes.push(area); ys.push(L.y + sy / Math.max(1, area));
    const lid = lidLine(L, d);
    if (lid) closedLayers.push(mkLayer(`Eye closed ${name}`, lid, false));
  }
  // two eyes look alike (about the same size, level): when they do not, the taps were not on eyes
  // (two taps but only one eye found: the one that was found is doubtful too, a hair clump is easily taken for an eye)
  if (backup && eyeLayers.length === 1) { img.set(backup); eyeLayers.length = 0; closedLayers.length = 0; warnings.push(EYE_MSG); }
  if (eyeLayers.length === 2 && backup && (Math.max(...sizes) > 2.2 * Math.max(1, Math.min(...sizes)) || Math.abs(ys[0] - ys[1]) > 0.3 * geo.d)) {
    img.set(backup); eyeLayers.length = 0; closedLayers.length = 0; warnings.push(EYE_MSG);
  }
  // (no eye was found at the taps: the head and the sizes come from the blob, as if no eye had been tapped)
  if (askedEyes && !eyeLayers.length) geo = geometry(W, H, alphaOf, { mouth: taps.mouth, head: taps.head }, o);
  const d = geo.d, head = geo.head;
  // (the eyes can place the mouth only when every eye tapped was found: one of two missing makes the other doubtful)
  const mouthOk = !taps.mouth || !eyeLayers.length || (askedEyes === 2 && eyeLayers.length < 2) || (Math.abs(taps.mouth[0] - geo.mx) <= 0.45 * geo.d && taps.mouth[1] - geo.ey >= 0.2 * geo.d && taps.mouth[1] - geo.ey <= 1.25 * geo.d);
  if (taps.mouth && !mouthOk) warnings.push(MOUTH_MSG);
  if (taps.mouth && mouthOk) {
    const bw = geo.bbox.x1 - geo.bbox.x0 + 1, mouthW = eyeLayers.length ? 0.45 * d : 0.16 * bw, dEq = mouthW / 0.45;
    const L = liftFeature(img, W, H, { cx: taps.mouth[0], cy: taps.mouth[1], rx: Math.max(5, 0.5 * dEq * ms), ry: Math.max(3, 0.22 * dEq * ms) }, { kind: 'mouth', size: mouthW, solid: 3, halo: Math.max(6, Math.round(0.1 * dEq)) });
    if (!L) warnings.push(MOUTH_MSG);
    else {
      const sp = detachStroke(L), spl = sp ? mouthLine(sp.rest, dEq, false) : null;
      if (sp && spl?.open) {
        // the upper lip drawn floating above the opening is the one line that travels (closed: its own shape; open: the opening's top edge)
        mouthLayers.push(mkLayer('Mouth inside', sp.rest), mkLayer('Mouth upper', sp.stroke));
        mouthStyle = 'open'; mouthCurve = { x0: spl.x0, ys: spl.ys }; mouthMorph = { sx0: sp.sx0, ys: sp.ys, mx0: spl.x0, ym: spl.ys };
      } else {
        const ml = mouthLine(L, dEq);
        if (ml.open && ml.line) { mouthLayers.push(mkLayer('Mouth inside', L), mkLayer('Mouth upper', ml.line, false)); mouthStyle = 'open'; mouthCurve = { x0: ml.x0, ys: ml.ys }; }
        else { mouthLayers.push(mkLayer('Mouth', L)); mouthStyle = 'closed'; }
      }
    }
  }
  const layers: ArtLayer[] = [];
  const body = trimLayer({ name: 'Body', path: [], x: 0, y: 0, w: W, h: H, rgba: img, opacity: 1, visible: true, blend: 'normal', clipped: false }, 2);
  if (body) layers.push(body);
  layers.push(...closedLayers, ...eyeLayers, ...mouthLayers);
  return { art: { width: W, height: H, layers, warnings: [...new Set(warnings)] }, cutout: cut.mode, eyes: eyeLayers.length, mouth: !!mouthStyle, head: head ? { ...head } : null, d, mouthStyle, mouthCurve, mouthMorph, wholeHead: geo.fitted ? { cx: (geo.bbox.x0 + geo.bbox.x1 + 1) / 2, cy: (geo.bbox.y0 + geo.bbox.y1 + 1) / 2 } : null };
}

/** pictureBuild's layered picture only. */
export function pictureToArt(pic: PicturePixels, taps: PictureTaps = {}, o: PictureOpts = {}): ArtSet { return pictureBuild(pic, taps, o).art; }

/** One plain sentence about what was done ("We cut out the background and gave it blinking eyes and a talking mouth."). */
export function pictureSays(b: Pick<PictureBuild, 'cutout' | 'eyes' | 'mouth'>): string {
  const gives = [b.eyes === 2 ? 'blinking eyes' : b.eyes === 1 ? 'a blinking eye' : '', b.mouth ? 'a talking mouth' : ''].filter(Boolean);
  const verbs = [b.cutout === 'removed' ? 'cut out the background' : '', gives.length ? `gave it ${gives.join(' and ')}` : 'made it breathe and sway'].filter(Boolean);
  return `We ${verbs.join(' and ')}.`;
}

// ------------------------------------------------------------------ the rig on top of autorig
/** A drawn OPEN mouth is the open state (ParamMouthOpenY 1); silence is the made closed line. In between the art squashes
 *  onto the line (each column toward the top edge) while it fades in and the line fades out. */
function finishMouth(doc: EdDoc, b: PictureBuild) {
  const inner = doc.meshes.find((m) => m.name === 'Mouth inside'), line = doc.meshes.find((m) => m.name === 'Mouth upper'), cv = b.mouthCurve, mm = b.mouthMorph;
  if (b.mouthStyle === 'closed') {
    // a drawn closed mouth (a line) IS the closed state: it never moves with the opening, and the inside painted for it is
    // hidden at 0 (no squeezed sliver at rest) and appears as the mouth opens
    const art = doc.meshes.find((m) => m.name === 'Mouth'), gen = doc.meshes.find((m) => m.generated && m.role === 'mouthInner');
    const openY = (f: EdForm) => f.axes.length === 1 && f.axes[0].param === 'ParamMouthOpenY';
    if (art) art.forms = art.forms.filter((f) => !openY(f));
    if (gen) {
      const v0 = gen.forms.find((f) => f.auto && openY(f))?.values[0] ?? {};
      gen.forms = gen.forms.filter((f) => !openY(f));
      gen.forms.push({ axes: [{ param: 'ParamMouthOpenY', keys: [0, 0.1, 1] }], values: [{ ...v0, o: 0 }, { ...v0, o: 1 }, null] });
    }
    return;
  }
  if (b.mouthStyle !== 'open' || !inner || !line || !cv || !cv.ys.length) return;
  inner.visible = true; line.visible = true;
  const at = (x: number) => cv.ys[Math.max(0, Math.min(cv.ys.length - 1, Math.round(x - cv.x0)))];
  const squash = (s: number): EdValue => { const dd: number[] = []; for (let i = 0; i < inner.mesh.pos.length; i += 2) dd.push(0, (at(inner.mesh.pos[i]) - inner.mesh.pos[i + 1]) * (1 - s)); return { d: dd }; };
  for (const m of [inner, line]) m.forms = m.forms.filter((f) => !(f.axes.length === 1 && f.axes[0].param === 'ParamMouthOpenY'));
  if (mm && mm.ys.length > 1 && mm.ym.length > 1) {
    // the drawn upper-lip stroke travels: from its own shape (silence) onto the opening's top edge by 0.3; the opening fades in
    // only once the line has arrived, so one mouth shape shows at every value
    const keys = [0, 0.15, 0.3, 0.6, 1], F = [0, 0.7, 1, 1, 1], S = [0.04, 0.3, 0.5, 0.8, 1], O = [0, 0, 1, 1, 1];
    const sy = (x: number) => mm.ys[Math.max(0, Math.min(mm.ys.length - 1, Math.round(x - mm.sx0)))];
    const full: number[] = [];
    for (let i = 0; i < line.mesh.pos.length; i += 2) {
      const x = line.mesh.pos[i], y = line.mesh.pos[i + 1], t = Math.max(0, Math.min(1, (x - mm.sx0) / Math.max(1, mm.ys.length - 1))), xt = mm.mx0 + t * (mm.ym.length - 1);
      full.push(xt - x, y - sy(x) + mm.ym[Math.round(t * (mm.ym.length - 1))] - y);
    }
    const axes = [{ param: 'ParamMouthOpenY', keys }];
    line.forms.push({ axes, values: keys.map((_, i) => (i === 0 ? null : { d: full.map((v) => v * F[i]) })) });
    inner.forms.push({ axes, values: keys.map((_, i) => (i === 4 ? null : { ...squash(S[i]), o: O[i] })) });
    return;
  }
  const keys = [0, 0.2, 0.5, 1], S = [0.04, 0.4, 0.75, 1], axes = [{ param: 'ParamMouthOpenY', keys }];
  inner.forms.push({ axes, values: keys.map((_, i) => (i === 3 ? null : { ...squash(S[i]), o: i === 0 ? 0 : 1 })) });
  line.forms.push({ axes, values: [{ o: 1 }, { o: 0.5 }, { o: 0 }, { o: 0 }] });
}

/** ONE continuous mesh for the whole picture: the head's turn / nod / tilt are keyforms of the Body mesh with a weight per
 *  vertex (1 inside the head ellipse, a smooth falloff over the neck, chin and shoulders, 0 below), each vertex moving
 *  w x (autorig's own headTurn, then the head's tilt, minus rest), so turning stretches hair and neck and reveals no copy. The
 *  eyes and mouth ride a head deformer with the same pivot and turn about the same head frame, at full weight. */
function weldHead(doc: EdDoc, textures: EdTexture[], b: PictureBuild) {
  const E = b.head, body = doc.meshes.find((m) => m.name === 'Body'), bodyD = doc.deformers.find((f) => f.id === 'Body'), headD = doc.deformers.find((f) => f.id === 'Head');
  if (!E || !body || !bodyD || !headD) return;
  const HC: [number, number] = [E.cx, E.cy], HR: [number, number] = [E.rx * 0.82, E.ry * 0.9], pivot: [number, number] = b.wholeHead ? [b.wholeHead.cx, b.wholeHead.cy] : [E.cx, E.cy + E.ry * 0.8];
  const turn = doc.extras?.turn ?? 0.6, xs = [-30, 0, 30];
  const tilt: EdDeformer = { id: 'PictureHead', name: 'Head tilt', kind: 'rotation', parent: bodyD.id, origin: pivot, forms: headD.forms.map((f) => { const { auto: _a, ...rest } = structuredClone(f); void _a; return rest; }) };
  doc.deformers.push(tilt);
  const turnForm = (m: EdMesh): EdForm => {
    const n = m.mesh.pos.length / 2, vals: (EdValue | null)[] = [];
    for (const ay of xs) for (const ax of xs) {
      if (!ax && !ay) { vals.push(null); continue; }
      const th = ax * turn * Math.PI / 180, ph = ay * turn * 0.8 * Math.PI / 180, dd: number[] = [];
      let any = false;
      for (let i = 0; i < n; i++) {
        const x = m.mesh.pos[i * 2], y = m.mesh.pos[i * 2 + 1], [nx, ny] = headTurn(x, y, HC, HR, m.depth, th, ph, m.role !== 'hairBack' && m.role !== 'ear', true);
        dd.push(nx - x, ny - y); if (Math.abs(nx - x) > 1e-4 || Math.abs(ny - y) > 1e-4) any = true;
      }
      vals.push(any ? { d: dd } : null);
    }
    return { axes: [{ param: 'ParamAngleX', keys: xs }, { param: 'ParamAngleY', keys: xs }], values: vals };
  };
  // the eyes, the mouth (everything that rides the head): the same turn on the same frame, the tilt about the same pivot
  for (const m of doc.meshes) {
    if (m === body || !HEAD_ROLES.has(m.role)) continue;
    m.deformer = tilt.id;
    m.forms = m.forms.filter((f) => !(f.axes.length === 2 && f.axes[0].param === 'ParamAngleX' && f.axes[1].param === 'ParamAngleY'));
    m.forms.push(turnForm(m));
  }
  // the picture itself: head turn x nod x tilt in one grid, weighted per vertex
  const zForm = tilt.forms.find((f) => f.axes.length === 1 && f.axes[0].param === 'ParamAngleZ');
  const angle = (az: number) => { const i = zForm?.axes[0].keys.indexOf(az) ?? -1; return i >= 0 ? (zForm!.values[i]?.a ?? 0) : 0; };
  const n = body.mesh.pos.length / 2, wt = new Float32Array(n), wtEdge = new Float32Array(n);
  // (the outline of a ball never moves as it turns: the head's weight fades to nothing at the character's own outline, so a round
  //  mascot keeps its silhouette and hair keeps its edge while what is inside turns)
  const bt = doc.textures[body.tex], bx = textures[body.tex];
  const edge = new Float32Array(bt.w * bt.h).fill(1e4);
  for (let i = 0; i < bt.w * bt.h; i++) if (bx.rgba[i * 4 + 3] < 128) edge[i] = 0;
  for (let y = 0; y < bt.h; y++) for (let x = 0; x < bt.w; x++) { const i = y * bt.w + x; let v = edge[i]; if (x > 0) v = Math.min(v, edge[i - 1] + 1); if (y > 0) { v = Math.min(v, edge[i - bt.w] + 1); if (x > 0) v = Math.min(v, edge[i - bt.w - 1] + 1.4); if (x < bt.w - 1) v = Math.min(v, edge[i - bt.w + 1] + 1.4); } edge[i] = v; }
  for (let y = bt.h - 1; y >= 0; y--) for (let x = bt.w - 1; x >= 0; x--) { const i = y * bt.w + x; let v = edge[i]; if (x < bt.w - 1) v = Math.min(v, edge[i + 1] + 1); if (y < bt.h - 1) { v = Math.min(v, edge[i + bt.w] + 1); if (x < bt.w - 1) v = Math.min(v, edge[i + bt.w + 1] + 1.4); if (x > 0) v = Math.min(v, edge[i + bt.w - 1] + 1.4); } edge[i] = v; }
  const R = Math.max(6, 0.12 * E.rx);
  const edgeAt = (x: number, y: number) => { const tx = Math.round(x - bt.x), ty = Math.round(y - bt.y); return tx < 0 || ty < 0 || tx >= bt.w || ty >= bt.h ? 0 : edge[ty * bt.w + tx]; };
  for (let i = 0; i < n; i++) {
    // 1 inside the head ellipse, then a smooth falloff: short below (neck, chin, shoulders: nothing moves at the bottom), longer
    // beside the head, so a strand of hair that crosses the boundary bends gently instead of kinking
    const ux = (body.mesh.pos[i * 2] - E.cx) / E.rx, uy = (body.mesh.pos[i * 2 + 1] - E.cy) / E.ry, rho = Math.hypot(ux, uy), c = rho > 0 ? ux / rho : 0;
    wt[i] = 1 - ss(1, 1.45 + 0.5 * c * c, rho);
    wtEdge[i] = wt[i] * ss(0, R, edgeAt(body.mesh.pos[i * 2], body.mesh.pos[i * 2 + 1]));   // (for the turn and the nod; a tilt rotates the outline too)
  }
  const vals: (EdValue | null)[] = [];
  for (const az of xs) for (const ay of xs) for (const ax of xs) {
    if (!ax && !ay && !az) { vals.push(null); continue; }
    const th = ax * turn * Math.PI / 180, ph = ay * turn * 0.8 * Math.PI / 180, a = angle(az) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), dd: number[] = [];
    let any = false;
    for (let i = 0; i < n; i++) {
      const x = body.mesh.pos[i * 2], y = body.mesh.pos[i * 2 + 1], w = wt[i];
      if (w <= 0 && !b.wholeHead) { dd.push(0, 0); continue; }
      const [tx, ty] = headTurn(x, y, HC, HR, 0, th, ph, true, true);
      const we = wtEdge[i], qx = x + we * (tx - x), qy = y + we * (ty - y), rx = pivot[0] + (qx - pivot[0]) * ca - (qy - pivot[1]) * sa, ry = pivot[1] + (qx - pivot[0]) * sa + (qy - pivot[1]) * ca, wz = b.wholeHead ? 1 : w;
      const ex = qx + wz * (rx - qx) - x, ey = qy + wz * (ry - qy) - y;
      dd.push(ex, ey); if (Math.abs(ex) > 1e-4 || Math.abs(ey) > 1e-4) any = true;
    }
    vals.push(any ? { d: dd } : null);
  }
  body.forms.push({ axes: [{ param: 'ParamAngleX', keys: xs }, { param: 'ParamAngleY', keys: xs }, { param: 'ParamAngleZ', keys: xs }], values: vals });
}

/** FOLLOW HOOK: follow-through (shared/rig2d/follow.ts) on the one body mesh. With a head, the top of the picture is held (the
 *  head must never lag its eyes and mouth, which are separate meshes): anchor 'top', `reach` = the head's share of the picture's
 *  height, so the hold covers the head and falls off over the same distance again, and what hangs below it (hair, jacket) is
 *  free to lag. No head: the bottom is held. */
export function addPictureFollow(doc: EdDoc, b?: Pick<PictureBuild, 'head'>): void {
  const body = doc.meshes.filter((m) => m.role === 'body');
  if (!body.length) return;
  let anchor: 'top' | 'bottom' = 'bottom', reach = 0.25;
  if (b?.head) {
    let y0 = Infinity, y1 = -Infinity;
    for (const m of body) for (let i = 1; i < m.mesh.pos.length; i += 2) { y0 = Math.min(y0, m.mesh.pos[i]); y1 = Math.max(y1, m.mesh.pos[i]); }
    anchor = 'top'; reach = Math.max(0.3, Math.min(0.9, (b.head.cy + b.head.ry - y0) / Math.max(1, y1 - y0)));
  }
  const X = (doc.extras ??= {});
  X.dynamics = [...(X.dynamics ?? []).filter((y) => y.id !== 'picture_follow_body'), { id: 'picture_follow_body', kind: 'follow', meshes: body.map((m) => m.id), anchor, reach }];
}

/** The whole picture → rig: pictureBuild → autoRigArt → the mouth, the one-mesh head, the follow hook. */
export function rigPicture(pic: PicturePixels, taps: PictureTaps = {}, o: PictureOpts & AutoRigOpts = {}) {
  const b = pictureBuild(pic, taps, o);
  const r = autoRigArt(b.art, { name: o.name, density: o.density ?? 1, turn: o.turn, bones: o.bones });
  const { doc, textures } = r;
  // (a body that fills the whole picture reads as a "background" to the auto-rig: it is the body)
  const bodyM = doc.meshes.find((m) => m.name === 'Body');
  if (bodyM && bodyM.role === 'ignore') { bodyM.role = 'body'; bodyM.visible = true; applyAutoRig(doc, textures, { turn: o.turn, bones: o.bones }); }
  finishMouth(doc, b);
  weldHead(doc, textures, b);
  addPictureFollow(doc, b);
  doc.meta.notes = 'Made from one picture.';
  return { ...r, art: b.art, build: b, says: pictureSays(b) };
}
