// Evaluate an editor document at parameter values: every mesh's vertices (canvas px) and opacity, every deformer's
// placed pivot / lattice (for the editor's handles); physics runs in the runtime's animator. Same rules as the .vtp2 runtime
// (shared/rig2d/evaluate.ts): forms add up, rotation deformers turn their children rigidly about their pivot and follow
// their parent at the pivot, warps map their children through the bent lattice. Pure (no DOM).
import { corners, type EdDeformer, type EdDoc, type EdForm, type EdMesh } from './doc.ts';
import { boneMatrices, skinPoints } from './skin.ts';

export interface DefState {
  /** rotation: placed pivot, angle (deg, + = clockwise on screen), scale. */
  ox: number; oy: number; angle: number; scale: number;
  /** rotation: rest pivot (children are measured from it). */
  rx: number; ry: number;
  /** warp: placed lattice points (canvas px), row-major from the top-left. */
  lattice: Float64Array | null;
  /** warp: rest rect. */
  rect: [number, number, number, number] | null;
  cols: number; rows: number;
}

export interface PoseOut {
  /** Per mesh (doc order): placed vertices, canvas px. */
  pos: Float32Array[];
  opacity: Float32Array;
  defs: Map<string, DefState>;
}

const DEG = Math.PI / 180;

export class PoseEval {
  values = new Map<string, number>();
  private order: EdDeformer[] = [];
  private idx: number[] = [];
  private w: number[] = [];
  out: PoseOut = { pos: [], opacity: new Float32Array(0), defs: new Map() };

  constructor(public doc: EdDoc) { this.rebuild(); }

  /** Call after the document's structure changed (meshes / deformers added or removed, parents changed). */
  rebuild() {
    const d = this.doc;
    for (const p of d.params) if (!this.values.has(p.id)) this.values.set(p.id, p.def);
    for (const id of [...this.values.keys()]) if (!d.params.some((p) => p.id === id)) this.values.delete(id);
    // parents first
    const byId = new Map(d.deformers.map((f) => [f.id, f]));
    const done = new Set<string>();
    this.order = [];
    const visit = (f: EdDeformer, depth: number) => {
      if (done.has(f.id) || depth > 64) return;
      const p = f.parent ? byId.get(f.parent) : undefined;
      if (p) visit(p, depth + 1);
      done.add(f.id); this.order.push(f);
    };
    for (const f of d.deformers) visit(f, 0);
    this.out = { pos: d.meshes.map((m) => new Float32Array(m.mesh.pos.length)), opacity: new Float32Array(d.meshes.length), defs: new Map() };
  }

  get = (id: string) => this.values.get(id) ?? 0;
  set(id: string, v: number) { const p = this.doc.params.find((x) => x.id === id); if (p) this.values.set(id, Math.min(p.max, Math.max(p.min, v))); }
  resetValues() { for (const p of this.doc.params) this.values.set(p.id, p.def); }

  /** Sum of a target's forms at the current values: point offsets into `dst` (length 2n, zeroed here), returns the
   *  opacity factor and rotation extras. */
  private sumForms(forms: EdForm[], n2: number, dst: Float64Array | null, rot: { a: number; ox: number; oy: number; s: number } | null): number {
    if (dst) dst.fill(0, 0, n2);
    let op = 1;
    for (const f of forms) {
      const cn = corners(f, this.get, this.idx, this.w);
      let oSum = 0, hasO = false;
      for (let c = 0; c < cn; c++) {
        const ww = this.w[c];
        if (!ww) continue;
        const v = f.values[this.idx[c]];
        oSum += ww * (v?.o ?? 1);
        if (!v) continue;
        if (v.o !== undefined) hasO = true;
        if (dst && v.d) { const L = Math.min(n2, v.d.length); for (let k = 0; k < L; k++) dst[k] += v.d[k] * ww; }
        if (rot) { if (v.a) rot.a += v.a * ww; if (v.ox) rot.ox += v.ox * ww; if (v.oy) rot.oy += v.oy * ww; if (v.s) rot.s += v.s * ww; }
      }
      if (hasO) op *= oSum;
    }
    return op;
  }

  private tmp = new Float64Array(0);
  private buf(n: number) { if (this.tmp.length < n) this.tmp = new Float64Array(n * 2); return this.tmp; }

  /** Map points (in place, x, y pairs) from deformer `id`'s rest space (canvas px) to placed canvas px (after update()). */
  through(id: string | null, pts: Float64Array | Float32Array, n: number) {
    const s = id ? this.out.defs.get(id) : undefined;
    if (s) this.mapOne(s, pts, n);
  }

  private mapOne(s: DefState, pts: Float64Array | Float32Array, n: number) {
    if (s.lattice && s.rect) {
      const [rx, ry, rw, rh] = s.rect;
      for (let i = 0; i < n; i++) {
        const u = (pts[i * 2] - rx) / rw, v = (pts[i * 2 + 1] - ry) / rh;
        const r = latticeAt(s.lattice, s.cols, s.rows, u, v);
        pts[i * 2] = r[0]; pts[i * 2 + 1] = r[1];
      }
      return;
    }
    const a = s.angle * DEG, c = Math.cos(a) * s.scale, sn = Math.sin(a) * s.scale;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2] - s.rx, y = pts[i * 2 + 1] - s.ry;
      pts[i * 2] = s.ox + c * x - sn * y;
      pts[i * 2 + 1] = s.oy + sn * x + c * y;
    }
  }

  /** Evaluate everything at the current values. */
  update(): PoseOut {
    const d = this.doc, out = this.out;
    if (out.pos.length !== d.meshes.length) this.rebuild();
    const probe = new Float64Array(4);
    for (const f of this.order) {
      const parent = f.parent ? out.defs.get(f.parent) ?? null : null;
      let st = out.defs.get(f.id);
      if (!st) { st = { ox: 0, oy: 0, angle: 0, scale: 1, rx: 0, ry: 0, lattice: null, rect: null, cols: 0, rows: 0 }; out.defs.set(f.id, st); }
      if (f.kind === 'rotation') {
        const o = f.origin ?? [0, 0];
        const rot = { a: 0, ox: 0, oy: 0, s: 0 };
        this.sumForms(f.forms, 0, null, rot);
        st.rx = o[0]; st.ry = o[1]; st.lattice = null; st.rect = null;
        let px = o[0] + rot.ox, py = o[1] + rot.oy, ang = rot.a, sc = 1 + rot.s;
        if (parent) {
          // follow the parent at the pivot: place the pivot, add the parent's local turn there (a short "up" probe)
          probe[0] = px; probe[1] = py; probe[2] = px; probe[3] = py - 10;
          this.mapOne(parent, probe, 2);
          const ux = probe[2] - probe[0], uy = probe[3] - probe[1];
          ang += Math.atan2(ux, -uy) / DEG; // angle of the mapped "up" vector, clockwise from up
          if (!parent.lattice) sc *= parent.scale;
          px = probe[0]; py = probe[1];
        }
        st.ox = px; st.oy = py; st.angle = ang; st.scale = sc;
      } else {
        const [rx, ry, rw, rh] = f.rect ?? [0, 0, 1, 1];
        const cols = f.cols ?? 1, rows = f.rows ?? 1, np = (cols + 1) * (rows + 1);
        if (!st.lattice || st.lattice.length !== np * 2) st.lattice = new Float64Array(np * 2);
        st.rect = [rx, ry, rw, rh]; st.cols = cols; st.rows = rows;
        const L = st.lattice;
        this.sumForms(f.forms, np * 2, L, null);
        for (let j = 0, k = 0; j <= rows; j++) for (let i = 0; i <= cols; i++, k++) { L[k * 2] += rx + (rw * i) / cols; L[k * 2 + 1] += ry + (rh * j) / rows; }
        if (parent) this.mapOne(parent, L, np);
      }
    }
    const bones = d.extras?.bones;
    const mats = bones?.length ? boneMatrices(bones, this.get) : null;
    for (let mi = 0; mi < d.meshes.length; mi++) {
      const m = d.meshes[mi];
      const n = m.mesh.pos.length / 2;
      const t = this.buf(n * 2);
      const op = this.sumForms(m.forms, n * 2, t, null);
      for (let k = 0; k < n * 2; k++) t[k] += m.mesh.pos[k];
      if (mats && m.skin) skinPoints(t, n, m.skin, mats);
      const st = m.deformer ? out.defs.get(m.deformer) : undefined;
      if (st) this.mapOne(st, t, n);
      let p = out.pos[mi];
      if (!p || p.length !== n * 2) p = out.pos[mi] = new Float32Array(n * 2);
      for (let k = 0; k < n * 2; k++) p[k] = t[k];
      out.opacity[mi] = Math.max(0, Math.min(1, m.opacity * op));
    }
    return out;
  }
}

/** A point of a warp lattice at normalised (u, v): bilinear inside its cell; outside, the edge cells extend linearly. */
export function latticeAt(L: ArrayLike<number>, cols: number, rows: number, u: number, v: number): [number, number] {
  const gx = u * cols, gy = v * rows;
  const ix = Math.min(Math.max(Math.floor(gx), 0), cols - 1), iy = Math.min(Math.max(Math.floor(gy), 0), rows - 1);
  const tx = gx - ix, ty = gy - iy, cp = cols + 1;
  const a = ix + iy * cp, b = a + 1, c = a + cp, e = c + 1;
  const x = L[a * 2] * (1 - tx) * (1 - ty) + L[b * 2] * tx * (1 - ty) + L[c * 2] * (1 - tx) * ty + L[e * 2] * tx * ty;
  const y = L[a * 2 + 1] * (1 - tx) * (1 - ty) + L[b * 2 + 1] * tx * (1 - ty) + L[c * 2 + 1] * (1 - tx) * ty + L[e * 2 + 1] * tx * ty;
  return [x, y];
}

/** Which mesh vertices / deformer handles a target has, as rest-space points (canvas px): for recording edits. */
export function restPoints(d: EdDoc, t: EdMesh | EdDeformer): number[] {
  if ('mesh' in t) return t.mesh.pos.slice();
  if (t.kind === 'rotation') return [...(t.origin ?? [0, 0])];
  const [rx, ry, rw, rh] = t.rect ?? [0, 0, 1, 1], cols = t.cols ?? 1, rows = t.rows ?? 1, out: number[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) out.push(rx + (rw * i) / cols, ry + (rh * j) / rows);
  void d;
  return out;
}

/** The rest-space position of a deformer-space point is what the editor records against: this is the inverse of a
 *  rotation deformer (rigid), used when the user drags a vertex in the posed view. Warps: inverted numerically. */
export function unmapDelta(pose: PoseEval, defId: string | null, dx: number, dy: number, at?: [number, number]): [number, number] {
  if (!defId) return [dx, dy];
  const s = pose.out.defs.get(defId);
  if (!s) return [dx, dy];
  if (!s.lattice) {
    const a = -s.angle * DEG, c = Math.cos(a) / (s.scale || 1), sn = Math.sin(a) / (s.scale || 1);
    return [c * dx - sn * dy, sn * dx + c * dy];
  }
  // warp: local Jacobian by finite differences at `at` (rest px)
  if (!at || !s.rect) return [dx, dy];
  const [rx, ry, rw, rh] = s.rect, e = 1;
  const f = (x: number, y: number) => latticeAt(s.lattice!, s.cols, s.rows, (x - rx) / rw, (y - ry) / rh);
  const p0 = f(at[0], at[1]), px = f(at[0] + e, at[1]), py = f(at[0], at[1] + e);
  const a = px[0] - p0[0], b = py[0] - p0[0], c = px[1] - p0[1], dd = py[1] - p0[1];
  const det = a * dd - b * c;
  if (Math.abs(det) < 1e-9) return [dx, dy];
  return [(dd * dx - b * dy) / det, (-c * dx + a * dy) / det];
}
