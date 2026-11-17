// Skirt / dress detection for the seated modesty drape (src/avatar/seatDrape.ts). Pure maths on plain arrays, so it is
// unit-tested without a renderer (tools/skirt_unit.ts).
//
// The test is geometric, not by name: a skirt (or dress, robe, long tunic) is ONE surface that wraps both legs, so
// below the crotch it has cloth on the midline in front of / behind the legs, well clear of either thigh. Trousers,
// shorts and the bare body are two separate leg tubes there: their midline vertices hug the inner thighs. Names only
// nudge the threshold (a mesh called "Skirt" needs less evidence, one called "Pants" more).
//
// Space: the mesh's bind space (bindMatrix · position, the same space as inverse(boneInverse) joint positions). Y is
// not assumed to be up: the leg axis (hips → knees) defines "down", and `front` is passed in.

export type V3 = readonly [number, number, number];

export interface LegFrame {
  /** Thigh roots (upper-leg joints) and knees (lower-leg joints), bind space. */
  hipL: V3; hipR: V3; kneeL: V3; kneeR: V3;
  /** Unit vector toward the avatar's front (bind space). */
  front: V3;
}

export interface SkirtInput extends LegFrame {
  /** xyz triples, bind space. */
  positions: ArrayLike<number>;
  /** Per vertex: 1 = skinned mostly to the lower body (hips, legs, or extra bones hanging off them), 0 = other. */
  lower: ArrayLike<number>;
  /** Thigh radius (bind units), e.g. from thighRadius() on the body. */
  thighR: number;
  /** Mesh + material names (name hint only). */
  name?: string;
  /** Triangle indices (into the same vertex list): lets a low-poly skirt count by the EDGES that cross the midline,
   *  so a coarse mesh with no vertex near the middle still counts. Without it, vertices only. */
  index?: ArrayLike<number> | null;
}

export interface SkirtVerdict {
  skirt: boolean;
  /** Cloth on the midline below the crotch, clear of both thighs (front / back of the legs): vertices near the
   *  midline plus edges crossing it. */
  front: number;
  back: number;
  /** How far down the front hem reaches, as a fraction of the thigh length below the thigh roots (1 = the knee). */
  hem: number;
  /** Representative vertex indices of the front panel below the crotch (for colour / UV sampling), most typical first. */
  sample: number[];
  why: string;
}

const sub = (a: V3, b: V3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const scale = (a: V3, s: number): [number, number, number] => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): [number, number, number] => { const l = len(a) || 1; return scale(a, 1 / l); };
const cross = (a: V3, b: V3): [number, number, number] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export const SKIRT_NAME = /skirt|dress|gown|robe|kilt|frock|tutu|one[-_ ]?piece|hakama|sarong|apron|kimono|yukata|cassock|habit/i;
export const PANTS_NAME = /pants|trouser|jeans|shorts|legging|tights|slacks|jogger|sweatpant|bloomer|underwear|panty|panties|brief/i;

/** The leg frame's axes: origin = midpoint of the thigh roots, `down` along the thighs, `side` toward avatar-left,
 *  `fwd` = front made orthogonal; `w` = distance between the thigh roots, `L` = mean thigh length. */
export function legAxes(f: LegFrame) {
  const mid: [number, number, number] = scale([f.hipL[0] + f.hipR[0], f.hipL[1] + f.hipR[1], f.hipL[2] + f.hipR[2]], 0.5);
  const kmid: [number, number, number] = scale([f.kneeL[0] + f.kneeR[0], f.kneeL[1] + f.kneeR[1], f.kneeL[2] + f.kneeR[2]], 0.5);
  const down = norm(sub(kmid, mid));
  let side = sub(f.hipL, f.hipR);
  side = norm(sub(side, scale(down, dot(side, down))));
  let fwd = sub(f.front, scale(down, dot(f.front, down)));
  fwd = sub(fwd, scale(side, dot(fwd, side)));
  if (len(fwd) < 1e-6) fwd = cross(side, down);
  fwd = norm(fwd);
  const w = len(sub(f.hipL, f.hipR));
  const L = (len(sub(f.kneeL, f.hipL)) + len(sub(f.kneeR, f.hipR))) / 2;
  return { mid, down, side, fwd, w, L };
}

/** Distance from p to the segment a→b, and how far along it (0..1, unclamped). */
function segDist(p: V3, a: V3, b: V3): { d: number; t: number } {
  const ab = sub(b, a), ap = sub(p, a);
  const l2 = dot(ab, ab) || 1;
  const t = dot(ap, ab) / l2;
  const tc = Math.max(0, Math.min(1, t));
  const q: V3 = [a[0] + ab[0] * tc, a[1] + ab[1] * tc, a[2] + ab[2] * tc];
  return { d: len(sub(p, q)), t };
}

/** Thigh radius from body vertices skinned to the thighs: a high percentile of their distance to the thigh axis over
 *  the middle of the thigh. `which[i]`: 1 = left thigh, 2 = right thigh, 0 = ignore. Returns 0 when unmeasurable. */
export function thighRadius(f: LegFrame, positions: ArrayLike<number>, which: ArrayLike<number>, minSamples = 8): number {
  const ds: number[] = [];
  const n = Math.floor(positions.length / 3);
  for (let i = 0; i < n; i++) {
    const s = which[i];
    if (s !== 1 && s !== 2) continue;
    const p: V3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const r = s === 1 ? segDist(p, f.hipL, f.kneeL) : segDist(p, f.hipR, f.kneeR);
    if (r.t < 0.25 || r.t > 0.6) continue;
    ds.push(r.d);
  }
  if (ds.length < Math.max(3, minSamples)) return 0;
  ds.sort((a, b) => a - b);
  const { w, L } = legAxes(f);
  const r = ds[Math.floor(ds.length * 0.8)];
  // sanity: a thigh is thinner than the hips are wide and than a third of the thigh is long… roughly
  return r > 0 && r < Math.max(w * 1.2, L * 0.4) ? r : 0;
}

/** Is this surface a skirt / dress (one surface around both legs, below the crotch)? */
export function detectSkirt(inp: SkirtInput): SkirtVerdict {
  const { mid, down, side, fwd, w, L } = legAxes(inp);
  const none = (why: string): SkirtVerdict => ({ skirt: false, front: 0, back: 0, hem: 0, sample: [], why });
  if (!(w > 0) || !(L > 0)) return none('no legs');
  const r = inp.thighR > 0 ? inp.thighR : w * 0.45;
  const nameSkirt = !!inp.name && SKIRT_NAME.test(inp.name);
  const namePants = !!inp.name && PANTS_NAME.test(inp.name) && !nameSkirt;
  // the band below the crotch: from ~a thigh radius under the thigh roots to half-way down the thigh. A surface NAMED
  // as a skirt may start right under the crotch (a micro-mini); otherwise a trouser fly could pass as one there.
  const top = nameSkirt ? L * 0.06 : Math.max(r * 0.9, L * 0.12), bot = L * 0.55;
  const P = inp.positions, n = Math.floor(P.length / 3);
  let front = 0, back = 0, lowerN = 0, bandN = 0;
  let hem = -Infinity;
  const fronts: { i: number; d: number }[] = [];
  const hemDs: number[] = [];
  const at = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  // in the band below the crotch and clear of both thighs (not a trouser seam / the body's inner thigh)?
  // → +1 front, -1 back, 0 no
  const clear = (p: V3): number => {
    const q = sub(p, mid);
    const dn = dot(q, down);
    if (dn < top || dn > bot) return 0;
    const dl = segDist(p, inp.hipL, inp.kneeL).d, dr = segDist(p, inp.hipR, inp.kneeR).d;
    if (Math.min(dl, dr) < r * 1.2) return 0;
    // in FRONT of the thighs (or behind them): a skirt passes over the thigh fronts; the inner faces of two
    // (baggy) trouser legs meeting at the midline are level with the thigh axes, not in front of them
    const fw = dot(q, fwd);
    return fw > r * 0.8 ? 1 : fw < -r * 0.8 ? -1 : 0;
  };
  const sdOf = new Float32Array(n);
  const hasIndex = !!inp.index && inp.index.length >= 3;
  for (let i = 0; i < n; i++) {
    const p = at(i);
    const q = sub(p, mid);
    const dn = dot(q, down), sd = dot(q, side), fw = dot(q, fwd);
    sdOf[i] = sd;
    // the hem: lowest cloth on the front half, near the middle (side slits / trailing ribbons don't count)
    if (fw > 0 && Math.abs(sd) < w * 1.2 && inp.lower[i]) hemDs.push(dn);
    if (dn < top || dn > bot) continue;
    bandN++;
    if (!inp.lower[i]) continue;
    lowerN++;
    // vertices right on the midline count only for a mesh without an index: two baggy trouser legs can touch at the
    // front, so a vertex there proves nothing — an EDGE crossing the midline in front of the thighs does (below)
    if (hasIndex || Math.abs(sd) > w * 0.12) continue;
    const c = clear(p);
    if (c > 0) { front++; fronts.push({ i, d: dn }); } else if (c < 0) back++;
  }
  // triangles cut by the midline plane: sample their cut segment in the band, clear of the thighs — one surface
  // spanning both legs from the crotch toward the hem. (A trouser fly / crotch seam also crosses the midline in front,
  // but only in a sliver right under the crotch: the depth span below rules it out.)
  const I = inp.index;
  if (I && hasIndex) {
    const tri = Math.floor(I.length / 3), step = Math.max(1, Math.ceil(tri / 200000));
    const cut: V3[] = [];
    const cutIdx: number[] = [];
    for (let t = 0; t < tri; t += step) {
      cut.length = 0; cutIdx.length = 0;
      for (let e = 0; e < 3; e++) {
        const a = I[t * 3 + e], b = I[t * 3 + ((e + 1) % 3)];
        if (a >= n || b >= n || !inp.lower[a] || !inp.lower[b] || !(sdOf[a] * sdOf[b] < 0)) continue;
        const k = sdOf[a] / (sdOf[a] - sdOf[b]);
        const pa = at(a), pb = at(b);
        cut.push([pa[0] + (pb[0] - pa[0]) * k, pa[1] + (pb[1] - pa[1]) * k, pa[2] + (pb[2] - pa[2]) * k]);
        cutIdx.push(Math.abs(sdOf[a]) < Math.abs(sdOf[b]) ? a : b);
      }
      if (cut.length < 2) continue;
      for (let s = 0; s <= 4; s++) {
        const f = s / 4, p0 = cut[0], p1 = cut[1];
        const p: V3 = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f];
        const c = clear(p);
        if (c > 0) { front++; fronts.push({ i: cutIdx[f < 0.5 ? 0 : 1], d: dot(sub(p, mid), down) }); } else if (c < 0) back++;
      }
    }
  }
  if (hemDs.length) {
    hemDs.sort((a, b) => a - b);
    hem = hemDs[Math.max(0, Math.ceil(hemDs.length * 0.97) - 1)] / L;
  }
  const need = nameSkirt ? 2 : namePants ? 10 : 4;
  let d0 = Infinity, d1 = -Infinity;
  for (const f of fronts) { if (f.d < d0) d0 = f.d; if (f.d > d1) d1 = f.d; }
  const span = fronts.length ? (d1 - d0) / L : 0, needSpan = nameSkirt ? 0.02 : namePants ? 0.15 : 0.08;
  // colour samples: the upper part of the front panel (what lies on the lap; hems carry trims / lace), ordered from the
  // most typical (30 % down the panel) outward
  const sorted = fronts.sort((a, b) => a.d - b.d);
  const mid30 = Math.floor(sorted.length * 0.3);
  const sample = sorted.filter((_, k, a) => k >= a.length * 0.1 && k <= a.length * 0.55)
    .sort((a, b) => Math.abs(sorted.indexOf(a) - mid30) - Math.abs(sorted.indexOf(b) - mid30)).slice(0, 64).map((x) => x.i);
  const base = { front, back, hem: Number.isFinite(hem) ? hem : 0, sample };
  if (!bandN) return { ...base, skirt: false, why: 'nothing below the crotch' };
  if (lowerN < bandN * 0.5) return { ...base, skirt: false, why: 'not skinned to the lower body' };
  if (front < need) return { ...base, skirt: false, why: `front midline ${front} < ${need}` };
  if (span < needSpan) return { ...base, skirt: false, why: `front midline only ${span.toFixed(3)} L deep (a crotch seam?)` };
  return { ...base, skirt: true, why: `front ${front} over ${span.toFixed(2)} L, back ${back}, hem ${base.hem.toFixed(2)}${nameSkirt ? ' (name)' : ''}` };
}

export const SKIN_NAME = /skin|body|flesh|naked|nude/i;

/** Trousers / shorts / leggings / a bodysuit under (or instead of) the skirt: a surface that wraps BOTH upper thighs
 *  all the way round and closes over the crotch. Then nothing shows when the skirt opens — no drape needed (a hoodie
 *  hem over a man's jeans is not a skirt to cover). Stockings / thigh-highs wrap the thighs but leave the crotch open:
 *  they don't count. The bare body (named skin / body) never counts, nor does a surface that is mostly upper body. */
export function coversLegs(inp: SkirtInput): { covers: boolean; why: string } {
  const { mid, down, side, fwd, w, L } = legAxes(inp);
  if (!(w > 0) || !(L > 0)) return { covers: false, why: 'no legs' };
  if (inp.name && SKIN_NAME.test(inp.name) && !PANTS_NAME.test(inp.name)) return { covers: false, why: 'skin' };
  const r = inp.thighR > 0 ? inp.thighR : w * 0.45;
  const P = inp.positions, n = Math.floor(P.length / 3);
  const bins = [new Uint8Array(12), new Uint8Array(12)];
  let lower = 0, crotch = 0;
  for (let i = 0; i < n; i++) {
    if (!inp.lower[i]) continue;
    lower++;
    const p: V3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    const q = sub(p, mid);
    const dn = dot(q, down), sd = dot(q, side);
    if (Math.abs(sd) < w * 0.15 && dn > -L * 0.1 && dn < L * 0.15) crotch++;
    if (dn < L * 0.1 || dn > L * 0.35) continue;
    for (const k of [0, 1] as const) {
      const a = k === 0 ? inp.hipL : inp.hipR, b = k === 0 ? inp.kneeL : inp.kneeR;
      const sg = segDist(p, a, b);
      if (sg.d < r * 0.7 || sg.d > r * 1.9) continue;
      // angle around this thigh's axis (side / front plane)
      const c: V3 = [a[0] + (b[0] - a[0]) * sg.t, a[1] + (b[1] - a[1]) * sg.t, a[2] + (b[2] - a[2]) * sg.t];
      const e = sub(p, c);
      const ang = Math.atan2(dot(e, fwd), dot(e, side) * (k === 0 ? 1 : -1));
      bins[k][Math.min(11, Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 12))] = 1;
    }
  }
  const cov = bins.map((b) => b.reduce((x, y) => x + y, 0));
  if (lower < n * 0.5) return { covers: false, why: `mostly upper body (${lower}/${n})` };
  if (cov[0] < 10 || cov[1] < 10) return { covers: false, why: `thighs wrapped ${cov[0]}/12, ${cov[1]}/12` };
  if (crotch < 3) return { covers: false, why: 'crotch open (stockings?)' };
  return { covers: true, why: `wraps both thighs (${cov[0]}/12, ${cov[1]}/12) + crotch` };
}

/** Seated drape plan from the detected skirts: how far over the lap (fraction of the thigh) and how far past the
 *  knees (fraction of the thigh length) the cloth goes. Short skirts still get a minimum lap cover. */
export function drapePlan(hem: number): { lap: number; fall: number } {
  const h = Number.isFinite(hem) ? hem : 0;
  const lap = Math.max(0.55, Math.min(1.0, h * 1.05));
  const fall = h > 1.05 ? Math.min(1.2, (h - 1) * 0.9) : 0;
  return { lap, fall };
}

/** Skirt texture mapping near the front panel: u, v ≈ a + b·side + c·down (side / down in thigh lengths from the
 *  midpoint of the thigh roots), clamped to the island's UV box — so the drape shows the skirt's own stripes / plaid /
 *  pleat shading at the right scale instead of one texel. */
export interface UvMap { u: [number, number, number]; v: [number, number, number]; box: [number, number, number, number] }

export interface UvSample { sd: number; dn: number; u: number; v: number }

/** Fit the map from samples on one UV island around `center` (samples further than `reach` in UV are another island
 *  and are ignored). Falls back to the centre texel when there is too little to fit. */
export function fitUvMap(samples: UvSample[], center: [number, number], reach = 0.15): UvMap {
  const pts = samples.filter((s) => Math.abs(s.u - center[0]) < reach && Math.abs(s.v - center[1]) < reach);
  const flat: UvMap = { u: [center[0], 0, 0], v: [center[1], 0, 0], box: [center[0], center[1], center[0], center[1]] };
  if (pts.length < 4) return flat;
  // least squares with a little ridge (a panel with no spread along one axis keeps a zero slope there)
  const fit = (val: (s: UvSample) => number): [number, number, number] => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], y = [0, 0, 0];
    for (const s of pts) {
      const x = [1, s.sd, s.dn], t = val(s);
      for (let i = 0; i < 3; i++) { y[i] += x[i] * t; for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j]; }
    }
    const lam = 1e-4 * pts.length;
    A[1][1] += lam; A[2][2] += lam;
    const sol = solve3(A, y);
    return sol ?? [val(pts[0]), 0, 0];
  };
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const s of pts) { u0 = Math.min(u0, s.u); u1 = Math.max(u1, s.u); v0 = Math.min(v0, s.v); v1 = Math.max(v1, s.v); }
  return { u: fit((s) => s.u), v: fit((s) => s.v), box: [u0, v0, u1, v1] };
}

export function applyUvMap(m: UvMap, sd: number, dn: number): [number, number] {
  const u = m.u[0] + m.u[1] * sd + m.u[2] * dn, v = m.v[0] + m.v[1] * sd + m.v[2] * dn;
  return [Math.min(m.box[2], Math.max(m.box[0], u)), Math.min(m.box[3], Math.max(m.box[1], v))];
}

function solve3(A: number[][], y: number[]): [number, number, number] | null {
  const M = A.map((r, i) => [...r, y[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]; }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
