// .vtp2 rig evaluation: parameter values → every mesh's vertices, opacity, colours and the render order. Pure (no DOM),
// allocation-light per frame after construction; unit-tested in node (tools/rig2d_unit.ts), drawn by
// src/avatar/flat/rig2d/renderer.ts.
//
// The keyform model (docs/RIG2D_FORMAT.md §4): every part / deformer / mesh / glue uses a keyform GRID over one or more
// parameters; its values at the current parameters are the multilinear blend of the 2^axes surrounding keyforms. An
// object whose parameter lies outside its keyed range is switched off (how riggers swap arm variants). Deformers form a
// tree: a mesh's keyform positions live in its parent deformer's space, mapped through each deformer up to model space
// (warp lattices with extrapolation outside [0, 1]², rotations with origin / angle / scale / mirror).
import { f32, viewArray } from './container.ts';
import type { Rig2DDoc } from './format.ts';
import { createInochiMaterialAdapter } from './inochi/materialAdapter.ts';

const EPS = 1e-3;

interface GridRt { params: Int32Array; keys: Float32Array[]; sizes: Int32Array; count: number; lo: Int32Array; t: Float64Array; outside: boolean; corners: number; idx: Int32Array; w: Float64Array }

export interface EvalOut {
  /** model-space vertices (x, y DOWN) per mesh */
  positions: Float32Array[];
  opacity: Float32Array;
  /** rgb multiply / screen per mesh */
  multiply: Float32Array;
  screen: Float32Array;
  drawOrder: Float32Array;
  enabled: Uint8Array;
  /** meshes back to front (enabled, opacity > 0) */
  order: Int32Array;
  orderCount: number;
  /** optional per-vertex alpha (0..1) per mesh, multiplied into its opacity (particles); null = none */
  alpha: (Float32Array | null)[];
}

export class RigEval {
  readonly values: Float64Array;
  /** part opacity set from outside (pose switches, layers, views, expressions); 1 = as authored */
  readonly partOpacity: Float32Array;
  readonly out: EvalOut;
  private grids: GridRt[];
  private walk: Int32Array; // encoded: deformer d → d, mesh m → -(m + 1)
  private warpPts: (Float32Array | null)[] = [];
  private warpCur: (Float64Array | null)[] = [];
  private rot: { base: number; angle: Float32Array; ox: Float32Array; oy: Float32Array; scale: Float32Array; rx: Uint8Array; ry: Uint8Array }[] = [];
  private rotCur: Float64Array; // ox, oy, scale, angle, rx, ry per deformer
  private dScale: Float64Array;
  private dOp: Float64Array;
  private dMul: Float64Array;
  private dScr: Float64Array;
  private dEn: Uint8Array;
  private pEn: Uint8Array;
  private pOp: Float64Array;
  private pDo: Float64Array;
  private meshPos: Float32Array[];
  private meshCur: Float64Array[];
  private meshCol: ({ mul?: Float32Array; scr?: Float32Array })[];
  private defCol: ({ mul?: Float32Array; scr?: Float32Array })[];
  private glue: { a: number; b: number; grid: number; it: Float32Array; pairs: Int32Array; w: Float32Array }[];
  private bs: { kind: 'mesh' | 'warp' | 'rotation' | 'part' | 'glue'; target: number; param: number; keys: Float32Array; off: Float32Array | null; n: number;
    vals: Record<string, Float32Array>; cons: { param: number; keys: Float32Array; w: Float32Array }[]; w: number; lo: number; t: number;
    p2: number; keys2: Float32Array | null; lo2: number; t2: number; /** per key (grid point): all offsets 0 (skipped) */ zero: Uint8Array }[];
  /** additive blend-shape values for this frame: rotation (angle, ox, oy, scale) per deformer, part (opacity, drawOrder), glue intensity */
  private addRot: Float64Array;
  private addPart: Float64Array;
  private addGlue: Float64Array;
  private tmp2 = new Float64Array(2);
  // ---- bones (§8.2)
  /** bone count, then per bone: parent, deformer (−1 = none), topological order */
  readonly boneCount: number;
  private boneOrder: Int32Array;
  private boneKf: { angle: Float32Array; x: Float32Array; y: Float32Array; sx: Float32Array; sy: Float32Array }[];
  /** model-space affine per bone [a, b, c, d, tx, ty]: posed now, rest now, and skin = posed · rest⁻¹ */
  readonly boneWorld: Float64Array;
  readonly boneRest: Float64Array;
  private boneSkin: Float64Array;
  /** extra bone angles (degrees) added this frame by chain physics (shared/rig2d/dynamics.ts); reset by the caller */
  readonly boneAngleAdd: Float64Array;
  private skin: ({ j: Uint16Array; w: Float32Array } | null)[];
  private seq: Int32Array;
  private cursor: Int32Array;
  private inochiMaterials: ReturnType<typeof createInochiMaterialAdapter>;

  constructor(readonly doc: Rig2DDoc, readonly buffers: readonly Uint8Array[]) {
    const d = doc;
    this.inochiMaterials = createInochiMaterialAdapter(doc);
    this.values = Float64Array.from(d.params.map((p) => p.default));
    this.partOpacity = new Float32Array(d.parts.length).fill(1);
    this.grids = d.grids.map((g) => {
      const n = g.axes.length;
      let count = 1;
      const sizes = new Int32Array(n);
      g.axes.forEach((a, i) => { sizes[i] = a.keys.length; count *= a.keys.length; });
      return { params: Int32Array.from(g.axes.map((a) => a.param)), keys: g.axes.map((a) => Float32Array.from(a.keys)), sizes, count,
        lo: new Int32Array(n), t: new Float64Array(n), outside: false, corners: 1 << n, idx: new Int32Array(1 << n), w: new Float64Array(1 << n) };
    });
    const nd = d.deformers.length;
    this.rotCur = new Float64Array(nd * 6);
    this.dScale = new Float64Array(nd); this.dOp = new Float64Array(nd); this.dEn = new Uint8Array(nd);
    this.dMul = new Float64Array(nd * 3); this.dScr = new Float64Array(nd * 3);
    d.deformers.forEach((f) => {
      if (f.kind === 'warp' && f.warp) {
        this.warpPts.push(f32(buffers, f.warp.points));
        this.warpCur.push(new Float64Array((f.warp.rows + 1) * (f.warp.cols + 1) * 2));
      } else { this.warpPts.push(null); this.warpCur.push(null); }
      const r = f.rotation;
      this.rot.push(r ? { base: r.baseAngle, angle: Float32Array.from(r.angle), ox: Float32Array.from(r.originX), oy: Float32Array.from(r.originY), scale: Float32Array.from(r.scale),
        rx: Uint8Array.from(r.reflectX.map(Number)), ry: Uint8Array.from(r.reflectY.map(Number)) } : { base: 0, angle: new Float32Array(1), ox: new Float32Array(1), oy: new Float32Array(1), scale: Float32Array.of(1), rx: new Uint8Array(1), ry: new Uint8Array(1) });
    });
    this.defCol = d.deformers.map((f) => ({ ...(f.color?.multiply ? { mul: f32(buffers, f.color.multiply) } : {}), ...(f.color?.screen ? { scr: f32(buffers, f.color.screen) } : {}) }));
    this.pEn = new Uint8Array(d.parts.length); this.pOp = new Float64Array(d.parts.length); this.pDo = new Float64Array(d.parts.length);
    this.meshPos = d.meshes.map((m) => f32(buffers, m.positions));
    this.meshCur = d.meshes.map((m) => new Float64Array(m.vertexCount * 2));
    this.meshCol = d.meshes.map((m) => ({ ...(m.color?.multiply ? { mul: f32(buffers, m.color.multiply) } : {}), ...(m.color?.screen ? { scr: f32(buffers, m.color.screen) } : {}) }));
    const nm = d.meshes.length;
    this.out = { positions: d.meshes.map((m) => new Float32Array(m.vertexCount * 2)), opacity: new Float32Array(nm), multiply: new Float32Array(nm * 3), screen: new Float32Array(nm * 3),
      drawOrder: new Float32Array(nm), enabled: new Uint8Array(nm), order: new Int32Array(nm), orderCount: 0, alpha: d.meshes.map(() => null) };
    this.glue = (d.glue ?? []).map((g) => ({ a: g.a, b: g.b, grid: g.grid, it: Float32Array.from(g.intensity), pairs: Int32Array.from(viewArray(buffers, g.pairs)), w: f32(buffers, g.weights) }));
    this.bs = (d.blendShapes ?? []).map((b) => {
      const t = b.target;
      const n = t.kind === 'mesh' ? d.meshes[t.index].vertexCount : t.kind === 'warp' ? (d.deformers[t.index].warp!.rows + 1) * (d.deformers[t.index].warp!.cols + 1) : 0;
      const vals: Record<string, Float32Array> = {};
      for (const [k, v] of Object.entries(b.values ?? {})) if (v) vals[k] = Float32Array.from(v);
      const off = b.offsets ? f32(buffers, b.offsets) : null, nk = b.keys.length * (b.keys2?.length ?? 1), stride = n * 2;
      // which keys carry no offsets at all (the rest pose of most blend shapes): skipped while the parameter rests there
      const zero = new Uint8Array(nk);
      if (off && off.length >= nk * stride) for (let j = 0; j < nk; j++) { let z = 1; for (let k = j * stride, e = k + stride; k < e; k++) if (off[k] !== 0) { z = 0; break; } zero[j] = z; }
      return { kind: t.kind, target: t.index, param: b.param, keys: Float32Array.from(b.keys), off, n, vals, zero,
        cons: (b.constraints ?? []).map((c) => ({ param: c.param, keys: Float32Array.from(c.keys), w: Float32Array.from(c.weights) })), w: 0, lo: 0, t: 0,
        p2: b.param2 ?? -1, keys2: b.keys2 ? Float32Array.from(b.keys2) : null, lo2: 0, t2: 0 };
    });
    this.addRot = new Float64Array(nd * 4); this.addPart = new Float64Array(d.parts.length * 2); this.addGlue = new Float64Array((d.glue ?? []).length);
    // parent-first walk over deformers and meshes
    const kids = new Map<number, number[]>();
    const push = (p: number, code: number) => { const l = kids.get(p); if (l) l.push(code); else kids.set(p, [code]); };
    d.deformers.forEach((f, i) => push(f.parent, i));
    d.meshes.forEach((m, i) => push(m.deformer, -(i + 1)));
    const walk: number[] = [];
    const stack = [...(kids.get(-1) ?? [])].reverse();
    const seen = new Uint8Array(nd);
    while (stack.length) {
      const c = stack.pop()!;
      walk.push(c);
      if (c >= 0 && !seen[c]) { seen[c] = 1; const k = kids.get(c); if (k) for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]); }
    }
    this.walk = Int32Array.from(walk);
    this.seq = new Int32Array(Math.max(1, nm, ...(d.drawGroups ?? []).map((g) => g.total)));
    const bones = d.bones ?? [];
    this.boneCount = bones.length;
    this.boneKf = bones.map((b) => ({ angle: Float32Array.from(b.keyforms.angle), x: Float32Array.from(b.keyforms.x), y: Float32Array.from(b.keyforms.y), sx: Float32Array.from(b.keyforms.scaleX), sy: Float32Array.from(b.keyforms.scaleY) }));
    const ord: number[] = [], mark = new Uint8Array(bones.length);
    const visit = (i: number, depth: number) => { if (mark[i] || depth > bones.length) return; const pa = bones[i].parent; if (pa >= 0 && pa < bones.length) visit(pa, depth + 1); if (!mark[i]) { mark[i] = 1; ord.push(i); } };
    for (let i = 0; i < bones.length; i++) visit(i, 0);
    this.boneOrder = Int32Array.from(ord);
    this.boneWorld = new Float64Array(bones.length * 6); this.boneRest = new Float64Array(bones.length * 6); this.boneSkin = new Float64Array(bones.length * 6);
    this.boneAngleAdd = new Float64Array(bones.length);
    this.skin = d.meshes.map((m) => (m.skin && bones.length ? { j: Uint16Array.from(viewArray(buffers, m.skin.joints)), w: f32(buffers, m.skin.weights) } : null));
    this.cursor = new Int32Array(Math.max(1, d.drawGroups?.length ?? 1));
  }

  paramIndex(id: string): number { return this.doc.params.findIndex((p) => p.id === id); }

  // ---------------------------------------------------------------- keyform blending
  /** Prepare a grid at the current parameters: corner indices + weights, and whether a parameter is outside the keys. */
  private prepGrid(g: GridRt) {
    const n = g.params.length;
    let base = 0, size = 1;
    g.outside = false;
    for (let i = 0; i < n; i++) {
      const keys = g.keys[i], v = this.values[g.params[i]], kn = keys.length;
      if (kn === 1) { if (Math.abs(v - keys[0]) >= EPS) g.outside = true; g.lo[i] = 0; g.t[i] = 0; }
      else {
        if (v < keys[0] - EPS || v >= keys[kn - 1] + EPS) g.outside = true;
        let lo = 0, t = 0;
        if (v <= keys[0]) { lo = 0; t = 0; }
        else if (v >= keys[kn - 1]) { lo = kn - 2; t = 1; }
        else { let u = 1; while (u < kn - 1 && keys[u] <= v) u++; lo = u - 1; t = (v - keys[lo]) / (keys[u] - keys[lo]); }
        g.lo[i] = lo; g.t[i] = t;
      }
      base += g.lo[i] * size; size *= kn;
    }
    for (let c = 0; c < g.corners; c++) {
      let w = 1, idx = base, s = 1;
      for (let i = 0; i < n; i++) {
        if ((c >> i) & 1) { idx += s; w *= g.t[i]; } else w *= 1 - g.t[i];
        s *= g.sizes[i];
      }
      g.idx[c] = Math.min(idx, g.count - 1); g.w[c] = w;
    }
  }
  private blend1(g: GridRt, a: ArrayLike<number>): number {
    let v = 0;
    for (let c = 0; c < g.corners; c++) if (g.w[c]) v += a[g.idx[c]] * g.w[c];
    return v;
  }
  /** Blend keyform blocks of `stride` floats from `src` into `dst`. */
  private blendN(g: GridRt, src: Float32Array, stride: number, dst: Float64Array) {
    dst.fill(0, 0, stride);
    for (let c = 0; c < g.corners; c++) {
      const w = g.w[c];
      if (!w) continue;
      const o = g.idx[c] * stride;
      for (let k = 0; k < stride; k++) dst[k] += src[o + k] * w;
    }
  }

  // ---------------------------------------------------------------- evaluate
  /** how many times update() ran (solvers that read bone / deformer transforms wait for the first one) */
  evalCount = 0;
  update(): EvalOut {
    this.evalCount++;
    const d = this.doc, P = this.values, out = this.out;
    for (let i = 0; i < P.length; i++) { const p = d.params[i]; if (P[i] < p.min) P[i] = p.min; else if (P[i] > p.max) P[i] = p.max; }
    for (const g of this.grids) this.prepGrid(g);
    this.addRot.fill(0); this.addPart.fill(0); this.addGlue.fill(0);
    for (const b of this.bs) {
      let w = 1;
      for (const c of b.cons) {
        const [lo, t] = seg(c.keys, P[c.param]);
        const hi = Math.min(lo + 1, c.w.length - 1);
        w = Math.min(w, (1 - t) * c.w[lo] + t * c.w[hi]);
      }
      const [lo, t] = seg(b.keys, P[b.param]);
      b.w = w; b.lo = lo; b.t = t;
      if (b.keys2) { const [lo2, t2] = seg(b.keys2, P[b.p2]); b.lo2 = lo2; b.t2 = t2; }
      if (!w || b.kind === 'mesh' || b.kind === 'warp') continue;
      const at = (a: Float32Array | undefined) => (a ? bsAt(b, a, 1, 0) * w : 0);
      if (b.kind === 'rotation') { const o = b.target * 4; this.addRot[o] += at(b.vals.angle); this.addRot[o + 1] += at(b.vals.originX); this.addRot[o + 2] += at(b.vals.originY); this.addRot[o + 3] += at(b.vals.scale); }
      else if (b.kind === 'part') { this.addPart[b.target * 2] += at(b.vals.opacity); this.addPart[b.target * 2 + 1] += at(b.vals.drawOrder); }
      else this.addGlue[b.target] += at(b.vals.intensity);
    }
    // parts
    for (let i = 0; i < d.parts.length; i++) {
      const p = d.parts[i], g = this.grids[p.grid], pp = p.parent;
      this.pEn[i] = p.enabled && !g.outside && (pp < 0 || this.pEn[pp]) ? 1 : 0;
      this.pOp[i] = this.partOpacity[i] * Math.min(1, Math.max(0, (p.opacity ?? 1) + this.addPart[i * 2])) * (pp >= 0 ? this.pOp[pp] : 1);
      this.pDo[i] = (p.drawOrder.length ? this.blend1(g, p.drawOrder) : 500) + this.addPart[i * 2 + 1];
    }
    // deformer keyforms
    for (let i = 0; i < d.deformers.length; i++) {
      const f = d.deformers[i], g = this.grids[f.grid];
      this.dOp[i] = this.blend1(g, f.opacity);
      if (f.kind === 'warp') this.blendN(g, this.warpPts[i]!, this.warpCur[i]!.length, this.warpCur[i]!);
      else {
        const r = this.rot[i], o = i * 6;
        this.rotCur[o] = this.blend1(g, r.ox); this.rotCur[o + 1] = this.blend1(g, r.oy); this.rotCur[o + 2] = this.blend1(g, r.scale);
        this.rotCur[o + 3] = this.blend1(g, r.angle);
        this.rotCur[o] += this.addRot[i * 4 + 1]; this.rotCur[o + 1] += this.addRot[i * 4 + 2]; this.rotCur[o + 2] += this.addRot[i * 4 + 3]; this.rotCur[o + 3] += this.addRot[i * 4];
        this.rotCur[o + 4] = r.rx[g.idx[0]] ?? 0; this.rotCur[o + 5] = r.ry[g.idx[0]] ?? 0;
      }
      const c = this.defCol[i];
      for (let k = 0; k < 3; k++) {
        this.dMul[i * 3 + k] = c.mul ? this.blendAt(g, c.mul, k) : 1;
        this.dScr[i * 3 + k] = c.scr ? this.blendAt(g, c.scr, k) : 0;
      }
    }
    this.inochiMaterials?.apply(P, this.dOp, this.dMul, this.dScr);
    // mesh keyforms
    for (let i = 0; i < d.meshes.length; i++) {
      const m = d.meshes[i], g = this.grids[m.grid];
      this.blendN(g, this.meshPos[i], m.vertexCount * 2, this.meshCur[i]);
      out.opacity[i] = this.blend1(g, m.opacity);
      out.drawOrder[i] = this.blend1(g, m.drawOrder);
      const c = this.meshCol[i];
      for (let k = 0; k < 3; k++) { out.multiply[i * 3 + k] = c.mul ? this.blendAt(g, c.mul, k) : 1; out.screen[i * 3 + k] = c.scr ? this.blendAt(g, c.scr, k) : 0; }
    }
    // blend shapes on points (additive). The arithmetic is EXACTLY the reference order (bsAt): per coordinate
    // row(j) = a[lo, j]·(1 − t) + a[hi, j]·t, then row(lo2)·(1 − t2) + row(hi2)·t2, then · w, then added: inlined (no
    // closure per coordinate) but bit-identical. A blend shape whose surrounding keys are all zero (the rest pose of
    // most: vowels, expressions at rest) adds exactly 0 and is skipped.
    for (const b of this.bs) {
      if (!b.w || !b.off || (b.kind !== 'mesh' && b.kind !== 'warp')) continue;
      const n2 = b.n * 2, w = b.w, off = b.off;
      const dst = b.kind === 'mesh' ? this.meshCur[b.target] : this.warpCur[b.target];
      if (!dst) continue;
      const n1 = b.keys.length, lo = b.lo, hi = Math.min(lo + 1, n1 - 1), t = b.t, u = 1 - t;
      if (!b.keys2) {
        if (b.zero[lo] && b.zero[hi]) continue;
        const o0 = lo * n2, o1 = hi * n2;
        for (let k = 0; k < n2; k++) dst[k] += (off[o0 + k] * u + off[o1 + k] * t) * w;
      } else {
        const lo2 = b.lo2, hi2 = Math.min(lo2 + 1, b.keys2.length - 1), t2 = b.t2, u2 = 1 - t2;
        const k00 = lo + n1 * lo2, k10 = hi + n1 * lo2, k01 = lo + n1 * hi2, k11 = hi + n1 * hi2;
        if (b.zero[k00] && b.zero[k10] && b.zero[k01] && b.zero[k11]) continue;
        const o00 = k00 * n2, o10 = k10 * n2, o01 = k01 * n2, o11 = k11 * n2;
        for (let k = 0; k < n2; k++) dst[k] += ((off[o00 + k] * u + off[o10 + k] * t) * u2 + (off[o01 + k] * u + off[o11 + k] * t) * t2) * w;
      }
    }
    // deformer chain + meshes, parent first
    for (let wi = 0; wi < this.walk.length; wi++) {
      const code = this.walk[wi];
      if (code >= 0) {
        const i = code, f = d.deformers[i], pd = f.parent, g = this.grids[f.grid];
        this.dEn[i] = f.enabled && !g.outside && (f.part < 0 || this.pEn[f.part]) && (pd < 0 || this.dEn[pd]) ? 1 : 0;
        if (f.kind === 'warp') {
          if (pd >= 0) { this.through(pd, this.warpCur[i]!, this.warpCur[i]!.length / 2); this.dScale[i] = this.dScale[pd]; }
          else this.dScale[i] = 1;
        } else {
          const o = i * 6;
          this.dScale[i] = this.rotCur[o + 2];
          if (pd >= 0) {
            const base = d.deformers[pd].kind === 'warp' ? 0.1 : 10;
            this.rotCur[o + 3] += this.angleDiff(pd, this.rotCur[o], this.rotCur[o + 1], base);
            this.tmp2[0] = this.rotCur[o]; this.tmp2[1] = this.rotCur[o + 1];
            this.through(pd, this.tmp2, 1);
            this.rotCur[o] = this.tmp2[0]; this.rotCur[o + 1] = this.tmp2[1];
            this.dScale[i] *= this.dScale[pd];
          }
        }
        this.dOp[i] *= pd >= 0 ? this.dOp[pd] : 1;
        if (pd >= 0) for (let k = 0; k < 3; k++) { this.dMul[i * 3 + k] *= this.dMul[pd * 3 + k]; const a = this.dScr[i * 3 + k], b = this.dScr[pd * 3 + k]; this.dScr[i * 3 + k] = a + b - a * b; }
      } else {
        const i = -code - 1, m = d.meshes[i], pd = m.deformer;
        if (pd >= 0) {
          this.through(pd, this.meshCur[i], m.vertexCount);
          out.opacity[i] *= this.dOp[pd];
          for (let k = 0; k < 3; k++) { out.multiply[i * 3 + k] *= this.dMul[pd * 3 + k]; const a = out.screen[i * 3 + k], b = this.dScr[pd * 3 + k]; out.screen[i * 3 + k] = a + b - a * b; }
        }
      }
    }
    // enabled + part opacity
    for (let i = 0; i < d.meshes.length; i++) {
      const m = d.meshes[i], pp = m.part, pd = m.deformer;
      out.enabled[i] = m.enabled && m.visible && !this.grids[m.grid].outside && (pp < 0 || this.pEn[pp]) && (pd < 0 || this.dEn[pd]) ? 1 : 0;
      if (pp >= 0) out.opacity[i] *= this.pOp[pp];
    }
    // glue
    for (let gi = 0; gi < this.glue.length; gi++) {
      const g = this.glue[gi];
      const it = this.blend1(this.grids[g.grid], g.it) + this.addGlue[gi];
      if (!it) continue;
      const A = this.meshCur[g.a], B = this.meshCur[g.b];
      for (let k = 0; k + 1 < g.pairs.length; k += 2) {
        const ia = g.pairs[k] * 2, ib = g.pairs[k + 1] * 2;
        if (ia + 1 >= A.length || ib + 1 >= B.length) continue;
        const dx = B[ib] - A[ia], dy = B[ib + 1] - A[ia + 1];
        const wa = g.w[k] * it, wb = g.w[k + 1] * it;
        A[ia] += dx * wa; A[ia + 1] += dy * wa; B[ib] -= dx * wb; B[ib + 1] -= dy * wb;
      }
    }
    if (this.boneCount) { this.updateBones(); this.applySkin(); }
    for (let i = 0; i < d.meshes.length; i++) { const s = this.meshCur[i], o = out.positions[i]; for (let k = 0; k < s.length; k++) o[k] = s[k]; }
    this.renderOrder();
    return out;
  }

  // ---------------------------------------------------------------- bones + skinning (§8.2)
  private boneLocal = new Float64Array(6);
  private bonePt = new Float64Array(2);
  /** Bone transforms now (posed) and their rest chain (offsets 0, scale 1, no physics) — both evaluated this frame. */
  private updateBones() {
    const bones = this.doc.bones!, W = this.boneWorld, R = this.boneRest, L = this.boneLocal;
    for (let oi = 0; oi < this.boneOrder.length; oi++) {
      const i = this.boneOrder[oi], b = bones[i], g = this.grids[b.grid], kf = this.boneKf[i];
      const dx = this.blend1(g, kf.x), dy = this.blend1(g, kf.y), da = this.blend1(g, kf.angle) + this.boneAngleAdd[i];
      const sx = kf.sx.length ? this.blend1(g, kf.sx) : 1, sy = kf.sy.length ? this.blend1(g, kf.sy) : 1;
      const o = i * 6;
      for (const rest of [false, true]) {
        const out = rest ? R : W;
        const ex = rest ? 0 : dx, ey = rest ? 0 : dy, ea = rest ? 0 : da, esx = rest ? 1 : sx, esy = rest ? 1 : sy;
        const def = b.deformer ?? -1;
        if (b.parent < 0 && def >= 0 && def < this.doc.deformers.length) {
          // follow the deformer: origin mapped through its chain, angle turned by the chain's local turn there
          this.bonePt[0] = b.x + ex; this.bonePt[1] = b.y + ey;
          const lx = this.bonePt[0], ly = this.bonePt[1];
          this.through(def, this.bonePt, 1);
          const turn = this.angleDiff(def, lx, ly, this.doc.deformers[def].kind === 'warp' ? 0.1 : 10);
          setTRS(out, o, this.bonePt[0], this.bonePt[1], b.angle + ea + turn, esx, esy);
        } else {
          setTRS(L, 0, b.x + ex, b.y + ey, b.angle + ea, esx, esy);
          if (b.parent >= 0) affMul(out, o, out, b.parent * 6, L, 0); else out.set(L, o);
        }
      }
      affMulInv(this.boneSkin, o, W, o, R, o);
    }
  }
  private applySkin() {
    const M = this.boneSkin, nb = this.boneCount;
    for (let mi = 0; mi < this.skin.length; mi++) {
      const sk = this.skin[mi];
      if (!sk) continue;
      const p = this.meshCur[mi], n = p.length / 2;
      for (let v = 0; v < n; v++) {
        const x = p[v * 2], y = p[v * 2 + 1];
        let nx = 0, ny = 0, ws = 0;
        for (let k = 0; k < 4; k++) {
          const w = sk.w[v * 4 + k], j = sk.j[v * 4 + k];
          if (!w || j >= nb) continue;
          const o = j * 6;
          nx += w * (M[o] * x + M[o + 2] * y + M[o + 4]); ny += w * (M[o + 1] * x + M[o + 3] * y + M[o + 5]); ws += w;
        }
        if (ws > 1e-6) { p[v * 2] = nx / ws; p[v * 2 + 1] = ny / ws; }
      }
    }
  }
  /** A model-space point (x, y) in bone i's frame → model space (posed). */
  bonePoint(i: number, x: number, y: number, out: Float64Array) { const W = this.boneWorld, o = i * 6; out[0] = W[o] * x + W[o + 2] * y + W[o + 4]; out[1] = W[o + 1] * x + W[o + 3] * y + W[o + 5]; }
  /** Map a point from deformer d's coordinates to model space (after update()). */
  deformerPointInto(d: number, x: number, y: number, out: Float64Array) { out[0] = x; out[1] = y; this.through(d, out, 1); }
  /** The local turn (degrees) of deformer d at a point of its coordinates. */
  deformerTurn(d: number, x: number, y: number) { return this.angleDiff(d, x, y, this.doc.deformers[d].kind === 'warp' ? 0.1 : 10); }

  private blendAt(g: GridRt, a: Float32Array, k: number): number {
    let v = 0;
    for (let c = 0; c < g.corners; c++) if (g.w[c]) v += a[g.idx[c] * 3 + k] * g.w[c];
    return v;
  }

  /** Read a point in an evaluated deformer's world frame (used by node-anchored physics). Call after update(). */
  deformerPoint(index: number, x: number, y: number): [number, number] {
    if (!Number.isInteger(index) || index < 0 || index >= this.doc.deformers.length) throw new Error('Invalid physics anchor.');
    this.tmp2[0] = x; this.tmp2[1] = y; this.through(index, this.tmp2, 1);
    return [this.tmp2[0], this.tmp2[1]];
  }

  /** Map `n` points (x, y pairs in `pts`, in place) from deformer d's space to its parent's space. */
  private through(di: number, pts: Float64Array, n: number) {
    const f = this.doc.deformers[di];
    if (f.kind === 'warp') { const w = f.warp!; warpPoints(this.warpCur[di]!, w.quad, w.rows, w.cols, pts, n); return; }
    const o = di * 6;
    const ox = this.rotCur[o], oy = this.rotCur[o + 1], sc = this.dScale[di];
    const a = (this.rot[di].base + this.rotCur[o + 3]) * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const fx = this.rotCur[o + 4] ? -1 : 1, fy = this.rotCur[o + 5] ? -1 : 1;
    for (let k = 0; k < n; k++) {
      const x = pts[k * 2] * fx, y = pts[k * 2 + 1] * fy;
      pts[k * 2] = sc * (c * x - s * y) + ox;
      pts[k * 2 + 1] = sc * (s * x + c * y) + oy;
    }
  }
  private probe = new Float64Array(2);
  private probe0 = new Float64Array(2);
  /** How much a parent deformer turns things at `origin` (degrees): a small "up" step mapped through it. */
  private angleDiff(pd: number, ox: number, oy: number, base: number): number {
    const dx = 0, dy = -base;
    this.probe0[0] = ox; this.probe0[1] = oy; this.through(pd, this.probe0, 1);
    for (let i = 0; i < 10; i++) {
      const s = Math.pow(0.1, i);
      this.probe[0] = ox + dx * s; this.probe[1] = oy + dy * s; this.through(pd, this.probe, 1);
      const rx = this.probe[0] - this.probe0[0], ry = this.probe[1] - this.probe0[1];
      if (Number.isFinite(rx) && Number.isFinite(ry) && (rx || ry)) return Math.atan2(dx * ry - dy * rx, dx * rx + dy * ry) * 180 / Math.PI;
    }
    return 0;
  }

  private renderOrder() {
    const d = this.doc, out = this.out, nm = d.meshes.length;
    let n = 0;
    const groups = d.drawGroups;
    if (!groups || !groups.length) {
      const idx: number[] = [];
      for (let i = 0; i < nm; i++) if (out.enabled[i] && out.opacity[i] > 0) idx.push(i);
      idx.sort((a, b) => out.drawOrder[a] - out.drawOrder[b] || a - b);
      for (const i of idx) out.order[n++] = i;
      out.orderCount = n;
      return;
    }
    const seq = this.seq;
    seq.fill(-1);
    this.cursor.fill(0);
    const items: [number, number][] = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (!g.items.length) continue;
      items.length = 0;
      for (let j = 0; j < g.items.length; j++) {
        const it = g.items[j];
        let o: number;
        if (it.kind === 'part') o = this.pEn[it.index] ? Math.round(this.pDo[it.index]) : g.min;
        else o = out.enabled[it.index] ? Math.round(out.drawOrder[it.index]) : g.min;
        items.push([Math.min(Math.max(o, g.min), g.max), j]);
      }
      items.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let pos = this.cursor[gi];
      for (const [, j] of items) {
        const it = g.items[j];
        if (it.kind === 'part') { if (it.group >= 0) { this.cursor[it.group] = pos; pos += groups[it.group].total; } }
        else { if (pos < seq.length) seq[pos] = it.index; pos++; }
      }
    }
    for (let k = 0; k < seq.length; k++) { const a = seq[k]; if (a >= 0 && out.enabled[a] && out.opacity[a] > 0) out.order[n++] = a; }
    out.orderCount = n;
  }

  /** Bounding box of every enabled mesh at the last update (model units). */
  bounds(): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < this.out.orderCount; k++) {
      const p = this.out.positions[this.out.order[k]];
      for (let j = 0; j < p.length; j += 2) { const x = p[j], y = p[j + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, this.doc.canvas.width, this.doc.canvas.height];
  }
}

function setTRS(o: Float64Array, at: number, tx: number, ty: number, deg: number, sx: number, sy: number) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  o[at] = c * sx; o[at + 1] = s * sx; o[at + 2] = -s * sy; o[at + 3] = c * sy; o[at + 4] = tx; o[at + 5] = ty;
}
/** out = P · L (affine, [a, b, c, d, tx, ty]); out may alias P. */
function affMul(out: Float64Array, oo: number, P: Float64Array, po: number, L: Float64Array, lo: number) {
  const a = P[po] * L[lo] + P[po + 2] * L[lo + 1], b = P[po + 1] * L[lo] + P[po + 3] * L[lo + 1];
  const c = P[po] * L[lo + 2] + P[po + 2] * L[lo + 3], d = P[po + 1] * L[lo + 2] + P[po + 3] * L[lo + 3];
  const tx = P[po] * L[lo + 4] + P[po + 2] * L[lo + 5] + P[po + 4], ty = P[po + 1] * L[lo + 4] + P[po + 3] * L[lo + 5] + P[po + 5];
  out[oo] = a; out[oo + 1] = b; out[oo + 2] = c; out[oo + 3] = d; out[oo + 4] = tx; out[oo + 5] = ty;
}
const INV = new Float64Array(6);
/** out = A · B⁻¹ */
function affMulInv(out: Float64Array, oo: number, A: Float64Array, ao: number, B: Float64Array, bo: number) {
  const a = B[bo], b = B[bo + 1], c = B[bo + 2], d = B[bo + 3], tx = B[bo + 4], ty = B[bo + 5];
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) { out[oo] = 1; out[oo + 1] = 0; out[oo + 2] = 0; out[oo + 3] = 1; out[oo + 4] = 0; out[oo + 5] = 0; return; }
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det, itx = -(ia * tx + ic * ty), ity = -(ib * tx + id * ty);
  INV[0] = ia; INV[1] = ib; INV[2] = ic; INV[3] = id; INV[4] = itx; INV[5] = ity;
  affMul(out, oo, A, ao, INV, 0);
}

/** A blend shape's (bi)linearly interpolated value: element `k` of blocks of `stride` floats per key. */
function bsAt(b: { keys: Float32Array; keys2: Float32Array | null; lo: number; t: number; lo2: number; t2: number }, a: Float32Array, stride: number, k: number): number {
  const n1 = b.keys.length, hi = Math.min(b.lo + 1, n1 - 1);
  const row = (j: number) => a[(b.lo + n1 * j) * stride + k] * (1 - b.t) + a[(hi + n1 * j) * stride + k] * b.t;
  if (!b.keys2) return row(0);
  const hi2 = Math.min(b.lo2 + 1, b.keys2.length - 1);
  return row(b.lo2) * (1 - b.t2) + row(hi2) * b.t2;
}

/** [lower key index, fraction] of v among sorted keys (clamped). */
export function seg(keys: ArrayLike<number>, v: number): [number, number] {
  const n = keys.length;
  if (n <= 1 || v <= keys[0]) return [0, 0];
  if (v >= keys[n - 1]) return [n - 2, 1];
  let u = 1;
  while (u < n - 1 && keys[u] <= v) u++;
  return [u - 1, (v - keys[u - 1]) / (keys[u] - keys[u - 1])];
}

// ---------------------------------------------------------------- warp lattice mapping
function tri(tx: number, ty: number, bl: number, br: number, tl: number, tr: number): number {
  // two triangles split along the bl→tr diagonal
  if (tx + ty > 1) return tr + (tl - tr) * (1 - tx) + (br - tr) * (1 - ty);
  return bl + (br - bl) * tx + (tl - bl) * ty;
}
function bil(tx: number, ty: number, bl: number, br: number, tl: number, tr: number): number {
  return bl * (1 - tx) * (1 - ty) + br * tx * (1 - ty) + tl * (1 - tx) * ty + tr * tx * ty;
}

/** Map points (in place) from a warp lattice's normalised space ([0, 1]² spans the lattice; outside extrapolates along
 *  the lattice's average axes) to the lattice's space. `grid` = (rows + 1) × (cols + 1) points, row-major. */
export function warpPoints(grid: Float64Array, quad: boolean, rows: number, cols: number, pts: Float64Array, n: number) {
  const cp = cols + 1;
  const f = quad ? bil : tri;
  const G = (i: number, k: number) => grid[i * 2 + k];
  // extrapolation frame from the 4 corners
  const c00 = 0, c10 = cols, c01 = rows * cp, c11 = cols + rows * cp;
  const ex: number[] = [0, 0], ey: number[] = [0, 0], or: number[] = [0, 0];
  for (let k = 0; k < 2; k++) {
    const cen = (G(c00, k) + G(c10, k) + G(c01, k) + G(c11, k)) / 4;
    const d1 = G(c11, k) - G(c00, k), d2 = G(c10, k) - G(c01, k);
    ex[k] = (d1 + d2) / 2; ey[k] = (d1 - d2) / 2; or[k] = cen - d1 * 0.5;
  }
  const O = (a: number, b: number, k: number) => or[k] + ex[k] * a + ey[k] * b;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    const gx = x * cols, gy = y * rows;
    if (x >= 0 && x < 1 && y >= 0 && y < 1) {
      const ix = Math.min(Math.max(Math.floor(gx), 0), cols - 1), iy = Math.min(Math.max(Math.floor(gy), 0), rows - 1);
      const gi = ix + iy * cp, tx = gx - ix, ty = gy - iy;
      for (let k = 0; k < 2; k++) pts[i * 2 + k] = f(tx, ty, G(gi, k), G(gi + 1, k), G(gi + cp, k), G(gi + cp + 1, k));
      continue;
    }
    if (!(x >= -2 && x <= 3 && y >= -2 && y <= 3)) { for (let k = 0; k < 2; k++) pts[i * 2 + k] = or[k] + x * ex[k] + y * ey[k]; continue; }
    const xi = x >= 1 ? 2 : x >= 0 ? 1 : 0, yi = y >= 1 ? 2 : y >= 0 ? 1 : 0;
    const cs = xi + yi * 3;
    const rs = (v: number, a: number, b: number) => (v - a) / (b - a);
    for (let k = 0; k < 2; k++) {
      let r: number;
      if (cs === 7 || cs === 1) {
        const ax = gx >= 0 ? Math.min(Math.floor(gx), cols - 1) : 0;
        const f0 = ax / cols, f1 = (ax + 1) / cols;
        r = cs === 7 ? tri(gx - ax, rs(y, 1, 3), G(ax + rows * cp, k), G(ax + 1 + rows * cp, k), O(f0, 3, k), O(f1, 3, k))
          : tri(gx - ax, rs(y, -2, 0), O(f0, -2, k), O(f1, -2, k), G(ax, k), G(ax + 1, k));
      } else if (cs === 3 || cs === 5) {
        const ay = gy >= 0 ? Math.min(Math.floor(gy), rows - 1) : 0;
        const f0 = ay / rows, f1 = (ay + 1) / rows;
        r = cs === 3 ? tri(rs(x, -2, 0), gy - ay, O(-2, f0, k), G(ay * cp, k), O(-2, f1, k), G((ay + 1) * cp, k))
          : tri(rs(x, 1, 3), gy - ay, G(cols + ay * cp, k), O(3, f0, k), G(cols + (ay + 1) * cp, k), O(3, f1, k));
      } else if (cs === 6) r = tri(rs(x, -2, 0), rs(y, 1, 3), O(-2, 1, k), G(rows * cp, k), O(-2, 3, k), O(0, 3, k));
      else if (cs === 8) r = tri(rs(x, 1, 3), rs(y, 1, 3), G(cols + rows * cp, k), O(3, 1, k), O(1, 3, k), O(3, 3, k));
      else if (cs === 0) r = tri(rs(x, -2, 0), rs(y, -2, 0), O(-2, -2, k), O(0, -2, k), O(-2, 0, k), G(0, k));
      else r = tri(rs(x, 1, 3), rs(y, -2, 0), O(1, -2, k), O(3, -2, k), G(cols, k), O(3, 0, k));
      pts[i * 2 + k] = r;
    }
  }
}
