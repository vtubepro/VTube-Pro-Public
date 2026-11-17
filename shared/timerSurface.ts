// Where on a room mesh the countdown goes (beta.14, in-room timer displays): measures a mesh's UVs against its world shape so
// the digits land upright, un-mirrored and undistorted whatever way the artist unwrapped it. Pure maths on plain numbers (the
// page passes the geometry's attributes through the tiny Attr view): tools/timer_display_unit.ts tests it.
//
// A "surface" is one mesh. From its triangles we measure (world space, area weighted):
//   - flatness (is it one plane?), the facing normal, the world size of its UV rectangle,
//   - the UV rectangle it really uses (a halo quad may use only 0..0.5 of an atlas: the picture is mapped onto THAT rect),
//   - how much of that rect the triangles cover (a geodesic of scattered islands covers little: no readable digits there).
// From that: which of a node's sub-meshes is the screen (pickSurface), and the UV matrix that turns the canvas upright
// (uvMatrix: mirror / quarter turns so the digits' up is the world's up).
export type V3 = [number, number, number];
export interface Attr { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }

export interface SurfaceStats {
  tris: number;
  /** world area (m²) */
  area: number;
  /** 1 = every triangle in one plane */
  flat: number;
  /** the mean front-facing normal (world, unit) */
  normal: V3;
  /** the UV rectangle the triangles use: u0, v0, u1, v1 */
  uv: [number, number, number, number];
  /** UV area / UV rectangle area (1 = the rectangle is filled) */
  coverage: number;
  /** world metres per UV unit along u / v (area weighted means) */
  dpdu: V3;
  dpdv: V3;
  /** world size of the UV rectangle along u / along v (m) */
  width: number;
  height: number;
  /** |cos| of the angle between dpdu and dpdv (0 = square pixels, 1 = collapsed) */
  shear: number;
  /** a flat, filled, un-sheared surface: digits drawn on it read as digits */
  ok: boolean;
  why: string;
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * Measure a mesh. `matrix` = its world matrix (column-major 16, THREE.Matrix4.elements; identity when omitted);
 * `flip` = the world matrix mirrors (negative determinant: the renderer flips the triangle winding to match, so does this).
 * `uv` is the first UV set (x = u, y = v as glTF stores them: v = 0 at the TOP of the picture). Null = unusable
 * (no UVs / no triangles / more than `maxTris`).
 */
export function surfaceStats(pos: Attr, uv: { count: number; getX(i: number): number; getY(i: number): number } | null, index: { count: number; getX(i: number): number } | null, matrix?: ArrayLike<number>, flip = false, maxTris = 60000): SurfaceStats | null {
  if (!uv || uv.count < 3 || pos.count < 3 || uv.count < pos.count) return null;
  const n = index ? Math.floor(index.count / 3) : Math.floor(pos.count / 3);
  if (n < 1 || n > maxTris) return null;
  const e = matrix;
  const P = (i: number): V3 => {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    return e ? [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]] : [x, y, z];
  };
  let area = 0, uvArea = 0, used = 0;
  const nSum: V3 = [0, 0, 0], du: V3 = [0, 0, 0], dv: V3 = [0, 0, 0];
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (let t = 0; t < n; t++) {
    const a = index ? index.getX(t * 3) : t * 3, b = index ? index.getX(t * 3 + 1) : t * 3 + 1, c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const pa = P(a), pb = P(b), pc = P(c);
    const e1 = sub(pb, pa), e2 = sub(pc, pa);
    let nn = cross(e1, e2);
    if (flip) nn = scale(nn, -1);
    const aw = 0.5 * len(nn);
    if (!(aw > 1e-12)) continue;
    const ua = uv.getX(a), va = uv.getY(a), ub = uv.getX(b), vb = uv.getY(b), uc = uv.getX(c), vc = uv.getY(c);
    u0 = Math.min(u0, ua, ub, uc); u1 = Math.max(u1, ua, ub, uc); v0 = Math.min(v0, va, vb, vc); v1 = Math.max(v1, va, vb, vc);
    area += aw; used++;
    nSum[0] += nn[0] * 0.5; nSum[1] += nn[1] * 0.5; nSum[2] += nn[2] * 0.5;   // (area-weighted normal sum)
    const d1u = ub - ua, d1v = vb - va, d2u = uc - ua, d2v = vc - va;
    const det = d1u * d2v - d1v * d2u;
    if (Math.abs(det) < 1e-12) continue;
    uvArea += 0.5 * Math.abs(det);
    const pu = scale(sub(scale(e1, d2v), scale(e2, d1v)), 1 / det), pv = scale(sub(scale(e2, d1u), scale(e1, d2u)), 1 / det);
    for (let k = 0; k < 3; k++) { du[k] += pu[k] * aw; dv[k] += pv[k] * aw; }
  }
  if (!used || !(area > 0) || !(u1 > u0) || !(v1 > v0)) return null;
  const normal = unit(nSum);
  const flat = Math.min(1, len(nSum) / area);
  const dpdu = scale(du, 1 / area), dpdv = scale(dv, 1 / area);
  const lu = len(dpdu), lv = len(dpdv);
  const width = lu * (u1 - u0), height = lv * (v1 - v0);
  const coverage = uvArea / ((u1 - u0) * (v1 - v0));
  const shear = lu > 1e-12 && lv > 1e-12 ? Math.abs(dot(dpdu, dpdv)) / (lu * lv) : 1;
  let why = '';
  if (flat < 0.97) why = 'not flat (its UVs are laid out for a curved or faceted surface)';
  else if (coverage < 0.5) why = 'its UVs are scattered islands (the picture would be cut into pieces)';
  else if (shear > 0.35) why = 'its UVs are sheared';
  else if (!(width > 1e-4 && height > 1e-4)) why = 'its UVs collapse';
  return { tris: used, area, flat, normal, uv: [u0, v0, u1, v1], coverage, dpdu, dpdv, width, height, shear, ok: !why, why };
}

/** The best screen among a node's meshes: a flat, filled one (the biggest; a screen-ish material name breaks ties). -1 = none. */
export function pickSurface(c: readonly { stats: SurfaceStats | null; material?: string }[], want = ''): number {
  const w = want.toLowerCase();
  let best = -1, bestScore = -Infinity;
  c.forEach((x, i) => {
    const s = x.stats;
    if (!s) return;
    const named = w && (x.material ?? '').toLowerCase().includes(w);
    let score = (s.ok ? 1000 : 0) + s.flat * 100 + Math.min(1, s.coverage) * 50 + Math.log10(Math.max(1e-6, s.area)) * 5;
    if (/screen|display|glass|lcd|emit|panel/i.test(x.material ?? '')) score += 30;
    if (named) score += 5000;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

/** The 8 ways a picture can sit on a square: flips and quarter turns, as 2×2 [[m00, m01], [m10, m11]] (det ±1). */
const SIGNED: readonly [number, number, number, number][] = [
  [1, 0, 0, 1], [-1, 0, 0, 1], [1, 0, 0, -1], [-1, 0, 0, -1],
  [0, 1, 1, 0], [0, -1, 1, 0], [0, 1, -1, 0], [0, -1, -1, 0],
];

export interface Orientation {
  /** canvas (s, t) − ½ = M · (picture (p, q) − ½): the picture's mirror / quarter turn that makes the digits upright */
  m: [number, number, number, number];
  mirrored: boolean;
  /** 0..3 quarter turns (odd = the canvas's width runs along the surface's v) */
  turns: number;
  /** canvas width / height in world metres, so the picture is not stretched */
  aspect: number;
  /** the canvas's right and up in the world (unit) and its size along them (m): where the picture sits */
  right: V3;
  up: V3;
  sizeM: [number, number];
}

/**
 * How to lay the canvas on the surface so that its up is the world's up (its right the viewer's right).
 * Horizontal surfaces (a floor or ceiling panel) read upright for someone standing at +Z looking toward -Z.
 */
export function orientation(st: SurfaceStats, up: V3 = [0, 1, 0]): Orientation {
  const n = st.normal;
  let ut = sub(up, scale(n, dot(up, n)));
  if (len(ut) < 0.3) ut = sub([0, 0, -1], scale(n, dot([0, 0, -1], n)));
  ut = unit(ut);
  const rt = unit(cross(ut, n)), dt = scale(ut, -1);
  const r = unit(st.dpdu), d = unit(st.dpdv);
  const a = [dot(r, rt), dot(d, rt), dot(r, dt), dot(d, dt)];
  let best = 0, bestScore = -Infinity;
  SIGNED.forEach((c, i) => { const s = c[0] * a[0] + c[1] * a[1] + c[2] * a[2] + c[3] * a[3]; if (s > bestScore) { bestScore = s; best = i; } });
  const m = SIGNED[best];
  const widthAlongU = m[0] !== 0;
  const turns = widthAlongU ? (m[0] > 0 ? 0 : 2) : (m[1] > 0 ? 3 : 1);
  const sizeM: [number, number] = widthAlongU ? [st.width, st.height] : [st.height, st.width];
  return { m: [m[0], m[1], m[2], m[3]], mirrored: m[0] * m[3] - m[1] * m[2] < 0, turns, aspect: sizeM[0] / sizeM[1], right: rt, up: ut, sizeM };
}

/** The texture matrix (u' = a·u + b·v + c, v' = d·u + e·v + f; THREE.Matrix3 row-major with the last row 0 0 1) that maps the
 *  surface's UV rectangle onto the whole canvas in orientation `o`. */
export function uvMatrix(st: SurfaceStats, o: Orientation): [number, number, number, number, number, number] {
  const [u0, v0, u1, v1] = st.uv;
  const du = u1 - u0, dv = v1 - v0;
  const [m00, m01, m10, m11] = o.m;
  // p = (u - u0) / du, q = (v - v0) / dv; s = m00 (p - ½) + m01 (q - ½) + ½; t = m10 (p - ½) + m11 (q - ½) + ½
  const a = m00 / du, b = m01 / dv, c = -m00 * u0 / du - m01 * v0 / dv - 0.5 * m00 - 0.5 * m01 + 0.5;
  const d = m10 / du, e = m11 / dv, f = -m10 * u0 / du - m11 * v0 / dv - 0.5 * m10 - 0.5 * m11 + 0.5;
  return [a, b, c, d, e, f];
}

/** Canvas pixel size for a surface of `aspect` (width / height) with `long` pixels on the long side. */
export function canvasSize(aspect: number, long = 1024): { w: number; h: number } {
  const a = Math.min(5, Math.max(0.2, Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
  return a >= 1 ? { w: long, h: Math.max(64, Math.round(long / a)) } : { w: Math.max(64, Math.round(long * a)), h: long };
}

/**
 * How far world points reach along an orientation's right and up axes, measured from `centre`: [right min, right max, up min, up max] in
 * metres (null = no points). Used to compare the glass panel with what is around it on the same node (a glowing dome behind a halo quad):
 * the panel must sit inside it, not hang over its rim. `points` = x y z triples.
 */
export function extentAlong(points: ArrayLike<number>, o: Pick<Orientation, 'right' | 'up'>, centre: V3): [number, number, number, number] | null {
  let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const p: V3 = [points[i] - centre[0], points[i + 1] - centre[1], points[i + 2] - centre[2]];
    const r = dot(p, o.right), u = dot(p, o.up);
    if (r < r0) r0 = r; if (r > r1) r1 = r; if (u < u0) u0 = u; if (u > u1) u1 = u;
  }
  return r1 >= r0 && u1 >= u0 ? [r0, r1, u0, u1] : null;
}

/**
 * How far (m) a panel of `panel` = [width, height], centred on the surface centre, reaches past `around` (extentAlong's box): the worst of its
 * four sides. <= 0 = the panel sits inside; > 0 = it hangs over by that much. Null when there is nothing around it to compare with.
 */
export function overhang(panel: readonly [number, number], around: readonly [number, number, number, number] | null): number | null {
  if (!around) return null;
  const hw = panel[0] / 2, hh = panel[1] / 2;
  return Math.max(hw + around[0], hw - around[1], hh + around[2], hh - around[3]);
}
