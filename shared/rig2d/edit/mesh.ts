// Auto-mesh: a triangle mesh that hugs a layer's visible pixels, with a density control, plus Delaunay triangulation
// for meshes edited by hand. Vertices follow the outline (boundary points every ~spacing px, pushed just outside the
// soft edge) and fill the inside on a staggered grid; triangles outside the shape are dropped, and any opaque pixel
// left uncovered gets a vertex and the mesh is rebuilt (so a mesh never cuts off art). Pure (no DOM).

export interface Mesh {
  /** Vertex positions, canvas px (x, y pairs). */
  pos: number[];
  /** Texture coordinates 0..1 (u, v pairs; v down, the layer picture's top = 0). */
  uv: number[];
  /** Triangles: vertex index triples. */
  tri: number[];
}

export interface MeshOpts {
  /** Target distance between vertices, px. Smaller = denser. */
  spacing?: number;
  /** Alpha (0..255) that counts as "art". */
  alpha?: number;
  /** How far outside the art the mesh reaches, px (covers soft edges). */
  margin?: number;
  /** Extra vertices (canvas px) that must be in the mesh (e.g. where a deformation needs detail). */
  extra?: number[];
}

/** A density setting (0 = coarse … 1 = fine) → vertex spacing for a layer of this size. */
export function spacingFor(w: number, h: number, density = 0.5): number {
  const size = Math.sqrt(w * h);
  const cells = 4 + density * 22; // cells across the layer
  return Math.max(6, Math.min(120, size / cells));
}

/** Mesh one layer. `rgba` is the layer picture (lw x lh), placed at (ox, oy) on the canvas. */
export function autoMesh(rgba: Uint8ClampedArray, lw: number, lh: number, ox: number, oy: number, o: MeshOpts = {}): Mesh {
  const sp = Math.max(3, o.spacing ?? spacingFor(lw, lh));
  const thr = o.alpha ?? 8;
  const margin = o.margin ?? Math.min(4, Math.max(1.5, sp * 0.15));
  // tiny layers: a box
  if (lw <= sp * 1.5 && lh <= sp * 1.5) return boxMesh(lw, lh, ox, oy);
  // coverage mask (on a grid of `c` px) dilated by the margin
  const c = Math.max(1, Math.min(4, Math.floor(sp / 6)));
  const gw = Math.ceil(lw / c), gh = Math.ceil(lh / c);
  const solid = new Uint8Array(gw * gh);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) if (rgba[(y * lw + x) * 4 + 3] > thr) solid[((y / c) | 0) * gw + ((x / c) | 0)] = 1;
  const dil = Math.max(1, Math.ceil(margin / c));
  const mask = dilate(solid, gw, gh, dil);
  const inMask = (x: number, y: number) => { const gx = Math.floor(x / c), gy = Math.floor(y / c); return gx >= 0 && gy >= 0 && gx < gw && gy < gh && mask[gy * gw + gx] === 1; };
  // boundary cells of the dilated mask → boundary points (greedy thinning to ~spacing * 0.7)
  const bpts: number[] = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    if (!mask[gy * gw + gx]) continue;
    const edge = gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1 || !mask[gy * gw + gx - 1] || !mask[gy * gw + gx + 1] || !mask[(gy - 1) * gw + gx] || !mask[(gy + 1) * gw + gx];
    if (edge) bpts.push(Math.min(lw, (gx + 0.5) * c), Math.min(lh, (gy + 0.5) * c));
  }
  const pts: number[] = [];
  const hash = new SpatialHash(sp);
  const tryAdd = (x: number, y: number, minD: number) => { if (hash.near(x, y, minD)) return false; hash.add(x, y); pts.push(x, y); return true; };
  // order boundary points along the outline-ish (by angle around the centre) so thinning is even
  const bOrder = orderBoundary(bpts);
  for (const i of bOrder) tryAdd(bpts[i * 2], bpts[i * 2 + 1], sp * 0.7);
  // interior: staggered grid
  for (let y = sp * 0.5, row = 0; y < lh; y += sp * 0.866, row++) {
    for (let x = (row % 2 ? sp * 0.5 : 0) + sp * 0.25; x < lw; x += sp) if (inMask(x, y)) tryAdd(x, y, sp * 0.55);
  }
  if (o.extra) for (let i = 0; i + 1 < o.extra.length; i += 2) { const x = o.extra[i] - ox, y = o.extra[i + 1] - oy; if (x >= 0 && y >= 0 && x <= lw && y <= lh) tryAdd(x, y, 1); }
  if (pts.length < 6) return boxMesh(lw, lh, ox, oy);
  // triangulate, drop triangles outside the shape, then cover any missed art and retry (twice at most)
  let tri: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    tri = keepInside(delaunay(pts), pts, inMask, sp);
    const miss = uncovered(rgba, lw, lh, thr, pts, tri, Math.max(2, sp / 3));
    if (!miss.length || pass === 2) {
      if (miss.length) { // last resort: a box for whatever is still uncovered
        const b = boxMesh(lw, lh, ox, oy);
        return b;
      }
      break;
    }
    for (let i = 0; i < miss.length; i += 2) tryAdd(miss[i], miss[i + 1], 0.5);
  }
  // drop unused vertices
  const used = new Int32Array(pts.length / 2).fill(-1);
  const pos: number[] = [], uv: number[] = [];
  for (const v of tri) if (used[v] < 0) { used[v] = pos.length / 2; pos.push(pts[v * 2] + ox, pts[v * 2 + 1] + oy); uv.push(pts[v * 2] / lw, pts[v * 2 + 1] / lh); }
  return { pos, uv, tri: tri.map((v) => used[v]) };
}

/** Two triangles over the whole layer, subdivided into a cols x rows grid. */
export function boxMesh(lw: number, lh: number, ox: number, oy: number, cols = 1, rows = 1): Mesh {
  const pos: number[] = [], uv: number[] = [], tri: number[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) { pos.push(ox + (lw * i) / cols, oy + (lh * j) / rows); uv.push(i / cols, j / rows); }
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) { const a = j * (cols + 1) + i, b = a + 1, d = a + cols + 1, e = d + 1; tri.push(a, b, e, a, e, d); }
  return { pos, uv, tri };
}

function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -1e9;
    for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
    last = 1e9;
    for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    let last = -1e9;
    for (let y = 0; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    last = 1e9;
    for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

function orderBoundary(b: number[]): number[] {
  const n = b.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += b[i * 2]; cy += b[i * 2 + 1]; }
  cx /= n || 1; cy /= n || 1;
  return Array.from({ length: n }, (_, i) => i).sort((i, j) => Math.atan2(b[i * 2 + 1] - cy, b[i * 2] - cx) - Math.atan2(b[j * 2 + 1] - cy, b[j * 2] - cx));
}

class SpatialHash {
  m = new Map<number, number[]>();
  constructor(public s: number) {}
  key(ix: number, iy: number) { return ix * 73856093 ^ iy * 19349663; }
  add(x: number, y: number) { const k = this.key(Math.floor(x / this.s), Math.floor(y / this.s)); let a = this.m.get(k); if (!a) this.m.set(k, a = []); a.push(x, y); }
  near(x: number, y: number, d: number) {
    const ix = Math.floor(x / this.s), iy = Math.floor(y / this.s), r = Math.ceil(d / this.s), d2 = d * d;
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      const l = this.m.get(this.key(ix + a, iy + b)); if (!l) continue;
      for (let i = 0; i < l.length; i += 2) { const dx = l[i] - x, dy = l[i + 1] - y; if (dx * dx + dy * dy < d2) return true; }
    }
    return false;
  }
}

/** Bowyer–Watson Delaunay triangulation of points (x, y pairs) → index triples (counter-clockwise in y-down = CW on
 *  screen; winding is irrelevant to the renderer). */
export function delaunay(p: number[]): number[] {
  const n = p.length / 2;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, p[i * 2]); maxX = Math.max(maxX, p[i * 2]); minY = Math.min(minY, p[i * 2 + 1]); maxY = Math.max(maxY, p[i * 2 + 1]); }
  const d = Math.max(maxX - minX, maxY - minY) * 20 + 1, mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  const P = p.slice();
  P.push(mx - d, my - d, mx + d, my - d, mx, my + d);
  const s0 = n, s1 = n + 1, s2 = n + 2;
  // triangles: [a, b, c, ccx, ccy, r2]
  let tris: number[][] = [circ(P, s0, s1, s2)];
  // insert points in a spatially coherent order (sorted by x) for speed
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => P[a * 2] - P[b * 2] || P[a * 2 + 1] - P[b * 2 + 1]);
  for (const i of order) {
    const x = P[i * 2], y = P[i * 2 + 1];
    const bad: number[][] = [], keep: number[][] = [];
    for (const t of tris) { const dx = x - t[3], dy = y - t[4]; if (dx * dx + dy * dy <= t[5] * (1 + 1e-9)) bad.push(t); else keep.push(t); }
    // boundary of the hole: edges of bad triangles that are not shared
    const edges = new Map<string, [number, number, number]>();
    for (const t of bad) for (const [a, b] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const e = edges.get(k);
      if (e) e[2]++; else edges.set(k, [a, b, 1]);
    }
    tris = keep;
    for (const [a, b, cnt] of edges.values()) if (cnt === 1) { const t = circ(P, a, b, i); if (t[5] < Infinity) tris.push(t); }
  }
  const out: number[] = [];
  for (const t of tris) if (t[0] < n && t[1] < n && t[2] < n) out.push(t[0], t[1], t[2]);
  return out;
}

function circ(P: number[], a: number, b: number, c: number): number[] {
  const ax = P[a * 2], ay = P[a * 2 + 1], bx = P[b * 2], by = P[b * 2 + 1], cx = P[c * 2], cy = P[c * 2 + 1];
  const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(D) < 1e-12) return [a, b, c, 0, 0, Infinity];
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / D, uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / D;
  return [a, b, c, ux, uy, (ax - ux) ** 2 + (ay - uy) ** 2];
}

function keepInside(tri: number[], p: number[], inMask: (x: number, y: number) => boolean, sp: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tri.length; i += 3) {
    const a = tri[i], b = tri[i + 1], c = tri[i + 2];
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1], cx = p[c * 2], cy = p[c * 2 + 1];
    const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
    if (area < 1e-6) continue;
    // centroid + edge midpoints (+ quarter points on long edges) must be on the shape
    const probes: [number, number][] = [[(ax + bx + cx) / 3, (ay + by + cy) / 3], [(ax + bx) / 2, (ay + by) / 2], [(bx + cx) / 2, (by + cy) / 2], [(cx + ax) / 2, (cy + ay) / 2]];
    const longest = Math.max(Math.hypot(bx - ax, by - ay), Math.hypot(cx - bx, cy - by), Math.hypot(ax - cx, ay - cy));
    if (longest > sp * 1.6) for (const [ux, uy, vx, vy] of [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]) for (const t of [0.25, 0.75]) probes.push([ux + (vx - ux) * t, uy + (vy - uy) * t]);
    let ok = 0;
    for (const [x, y] of probes) if (inMask(x, y)) ok++;
    if (inMask(probes[0][0], probes[0][1]) && ok >= probes.length - 1) out.push(a, b, c);
  }
  return out;
}

/** Opaque pixels (sampled every `step` px) not inside any triangle → their positions (x, y pairs). */
function uncovered(rgba: Uint8ClampedArray, lw: number, lh: number, thr: number, p: number[], tri: number[], step: number): number[] {
  const cov = new Uint8Array(lw * lh);
  for (let i = 0; i < tri.length; i += 3) rasterTri(cov, lw, lh, p[tri[i] * 2], p[tri[i] * 2 + 1], p[tri[i + 1] * 2], p[tri[i + 1] * 2 + 1], p[tri[i + 2] * 2], p[tri[i + 2] * 2 + 1]);
  const out: number[] = [];
  const s = Math.max(1, Math.floor(step));
  for (let y = 0; y < lh; y += s) for (let x = 0; x < lw; x += s) {
    if (rgba[(y * lw + x) * 4 + 3] > Math.max(thr, 32) && !cov[y * lw + x]) out.push(x + 0.5, y + 0.5);
  }
  return out;
}

/** Mark pixels whose centre is inside the triangle (with a small tolerance). */
export function rasterTri(cov: Uint8Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < 1e-9) return;
  const eps = -0.02 * Math.abs(area);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * Math.sign(area);
    const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * Math.sign(area);
    const w2 = ((ax - px) * (by - py) - (bx - px) * (ay - py)) * Math.sign(area);
    if (w0 >= eps && w1 >= eps && w2 >= eps) cov[y * w + x] = 1;
  }
}

/** Re-triangulate a mesh after vertices were added / moved / removed by hand (keeps pos + uv, rebuilds tri), dropping
 *  triangles whose centre falls on transparent texture (when a coverage test is given). */
export function retriangulate(m: Mesh, keep?: (u: number, v: number) => boolean): Mesh {
  let tri = delaunay(m.pos);
  if (keep) {
    const t2: number[] = [];
    for (let i = 0; i < tri.length; i += 3) {
      const a = tri[i], b = tri[i + 1], c = tri[i + 2];
      const u = (m.uv[a * 2] + m.uv[b * 2] + m.uv[c * 2]) / 3, v = (m.uv[a * 2 + 1] + m.uv[b * 2 + 1] + m.uv[c * 2 + 1]) / 3;
      if (keep(u, v)) t2.push(a, b, c);
    }
    tri = t2;
  }
  return { pos: m.pos.slice(), uv: m.uv.slice(), tri };
}

/** Fraction of opaque pixels (alpha > 127) covered by the mesh: 1 = nothing cut off. */
export function meshCoverage(m: Mesh, rgba: Uint8ClampedArray, lw: number, lh: number, ox: number, oy: number): number {
  const cov = new Uint8Array(lw * lh);
  for (let i = 0; i < m.tri.length; i += 3) {
    const [a, b, c] = [m.tri[i], m.tri[i + 1], m.tri[i + 2]];
    rasterTri(cov, lw, lh, m.pos[a * 2] - ox, m.pos[a * 2 + 1] - oy, m.pos[b * 2] - ox, m.pos[b * 2 + 1] - oy, m.pos[c * 2] - ox, m.pos[c * 2 + 1] - oy);
  }
  let n = 0, k = 0;
  for (let i = 0; i < lw * lh; i++) if (rgba[i * 4 + 3] > 127) { n++; if (cov[i]) k++; }
  return n ? k / n : 1;
}
