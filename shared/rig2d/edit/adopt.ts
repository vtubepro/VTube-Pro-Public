// "Adopt" an imported rig into the 2D avatar maker: a .vtp2 that has no maker project inside (a converted Live2D /
// Inochi2D model, or a rig made elsewhere) → an editor document (doc.ts) + one picture per part, so the maker can open,
// change and save it like a rig it made itself. The inverse of vtp2.ts buildRig: building the adopted document gives
// back the same rig (tools/rig2d_adopt_unit.ts evaluates both at many poses and compares every vertex).
//
// How each thing comes over:
//   * geometry: model units → canvas px (canvas.unit / origin); a warp's rest lattice becomes the rectangle around its
//     rest pose, a rotation's rest angle and scale become its children's `frame`, so every part's rest points are where
//     it is drawn at rest;
//   * keyform grids → one `exact` form per object (same axes and keys: outside them the object switches off, as
//     before), values relative to the rest pose (point offsets, opacity, colours, draw-order offsets);
//   * blend shapes → `shape` forms (1 or 2 axes, with their weight limits);
//   * pictures: each art mesh's region of its texture page is cut out into its own picture (`uvFree` parts);
//   * render order: the order at rest, with per-keyform changes of a part's own place kept as draw-order offsets;
//   * what the maker has no editor for (physics strands, glue, pendulums, material bindings, part switches, hit areas,
//     roles, vendor data) is kept in doc.imported and written back unchanged.
// What can't come over exactly is said once in `notes` (plain sentences). Pure (no DOM).
import { RigEval } from '../evaluate.ts';
import { f32, viewArray } from '../container.ts';
import { FOLLOW_EXTRA_KEY, rig2dDynamics, type Rig2DDoc } from '../format.ts';
import { bracket, uniqueId, type EdAttachment, type EdBone, type EdCostume, type EdDeformer, type EdDoc, type EdDynamic, type EdForm, type EdImported, type EdMesh, type EdParticles,
  type EdPart, type EdSlot, type EdStateLayer, type EdTexture, type EdTextureInfo, type EdValue, EDIT_VERSION } from './doc.ts';

export interface AdoptPage { w: number; h: number; rgba: Uint8ClampedArray | Uint8Array }
export interface AdoptResult { doc: EdDoc; textures: EdTexture[]; notes: string[] }

type V2 = [number, number];
type Axes = { param: string; keys: number[] }[];
const EPS = 1e-3;
const near0 = (v: number) => Math.abs(v) < 1e-7;
const linToSrgb = (c: number) => { const v = Math.max(0, Math.min(1, c)); return Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Adopt `src` (validated rig + its buffers; `pages[i]` = texture i decoded, null when it could not be read). */
export function adoptRig(src: Rig2DDoc, buffers: readonly Uint8Array[], pages: readonly (AdoptPage | null)[]): AdoptResult {
  const notes: string[] = [];
  const P = src.params, pid = (i: number) => P[i]?.id ?? '';
  const S = src.canvas.unit || 1, TX = src.canvas.originX ?? 0, TY = src.canvas.originY ?? 0;
  const axesOf = (g: number): Axes => (src.grids[g]?.axes ?? []).map((a) => ({ param: pid(a.param), keys: a.keys.slice() }));
  const kfN = (g: number) => (src.grids[g]?.axes ?? []).reduce((n, a) => n * a.keys.length, 1);
  /** keyform weights of grid g at the default pose: [index, weight][] */
  const restWeights = (g: number): [number, number][] => {
    const axes = src.grids[g]?.axes ?? [];
    let list: [number, number][] = [[0, 1]];
    let stride = 1;
    for (const a of axes) {
      const [lo, t] = bracket(a.keys, P[a.param]?.default ?? 0);
      const hi = Math.min(lo + 1, a.keys.length - 1);
      const next: [number, number][] = [];
      for (const [i, w] of list) { next.push([i + lo * stride, w * (1 - t)]); if (t > 0 && hi !== lo) next.push([i + hi * stride, w * t]); }
      list = next; stride *= a.keys.length;
    }
    return list.filter(([, w]) => w > 0);
  };
  const restOf = (g: number, arr: ArrayLike<number>, stride: number): number[] => {
    const out = new Array(stride).fill(0);
    for (const [k, w] of restWeights(g)) for (let i = 0; i < stride; i++) out[i] += (arr[k * stride + i] ?? 0) * w;
    return out;
  };

  // ---------------------------------------------------------------- deformers (parents first): editor spaces
  const D = src.deformers;
  const ed: EdDeformer[] = D.map((f) => ({ id: f.id, name: f.name, kind: f.kind, parent: f.parent >= 0 && D[f.parent] ? D[f.parent].id : null, forms: [] }));
  /** rest scale factor s0 of each rotation (its frame relative to the rotation above) */
  const rotS0 = new Float64Array(D.length).fill(1);
  const order: number[] = [];
  { const seen = new Uint8Array(D.length); const visit = (i: number, d: number) => { if (seen[i] || d > D.length) return; if (D[i].parent >= 0) visit(D[i].parent, d + 1); if (!seen[i]) { seen[i] = 1; order.push(i); } }; D.forEach((_, i) => visit(i, 0)); }
  const frameAboveIdx = (j: number): { angle: number; scale: number } => {
    for (let d = 0; j >= 0 && d <= D.length; d++, j = D[j].parent) if (D[j].kind === 'rotation') return ed[j].frame ?? { angle: 0, scale: 1 };
    return { angle: 0, scale: S };
  };
  /** a point in deformer j's coordinates (−1 = model space) → canvas px */
  const fromLocal = (j: number, x: number, y: number): V2 => {
    if (j < 0 || !D[j]) return [x * S + TX, y * S + TY];
    const e = ed[j];
    if (e.kind === 'warp') { const [rx, ry, rw, rh] = e.rect!; return [rx + x * rw, ry + y * rh]; }
    const [dx, dy] = fromDelta(j, x, y);
    return [e.origin![0] + dx, e.origin![1] + dy];
  };
  const fromDelta = (j: number, dx: number, dy: number): V2 => {
    if (j < 0 || !D[j]) return [dx * S, dy * S];
    const e = ed[j];
    if (e.kind === 'warp') return [dx * e.rect![2], dy * e.rect![3]];
    const a = ((e.frame?.angle ?? 0) * Math.PI) / 180, k = e.frame?.scale || 1;
    const x = dx * (e.reflect?.[0] ? -1 : 1), y = dy * (e.reflect?.[1] ? -1 : 1);
    return [k * (Math.cos(a) * x - Math.sin(a) * y), k * (Math.sin(a) * x + Math.cos(a) * y)];
  };
  /** per keyform: its multiply / screen colours into an editor value (only when not neutral) */
  const colorAt = (c: Rig2DDoc['meshes'][number]['color']) => {
    const mul = c?.multiply ? f32(buffers, c.multiply) : null, scr = c?.screen ? f32(buffers, c.screen) : null;
    return (k: number, v: EdValue) => {
      if (mul && k * 3 + 2 < mul.length) { const m: [number, number, number] = [mul[k * 3], mul[k * 3 + 1], mul[k * 3 + 2]]; if (m.some((x) => x !== 1)) v.mul = m; }
      if (scr && k * 3 + 2 < scr.length) { const s: [number, number, number] = [scr[k * 3], scr[k * 3 + 1], scr[k * 3 + 2]]; if (s.some((x) => x !== 0)) v.scr = s; }
    };
  };
  /** an exact form over grid g (null values where nothing differs from the rest pose); none when nothing at all */
  const exactForm = (g: number, value: (k: number) => EdValue): EdForm | null => {
    const n = kfN(g), values: (EdValue | null)[] = [];
    let any = false;
    for (let k = 0; k < n; k++) {
      const v = value(k);
      const empty = (!v.d || v.d.every(near0)) && (v.o === undefined || Math.abs(v.o - 1) < 1e-7) && !v.mul && !v.scr && near0(v.a ?? 0) && near0(v.ox ?? 0) && near0(v.oy ?? 0) && near0(v.s ?? 0) && near0(v.z ?? 0);
      if (empty) values.push(null); else { any = true; if (v.d && v.d.every(near0)) delete v.d; if (v.o !== undefined && Math.abs(v.o - 1) < 1e-7) delete v.o; values.push(v); }
    }
    const axes = axesOf(g);
    return any || axes.length ? { axes, values, exact: true } : null;
  };
  let mirrorMixed = 0;
  for (const i of order) {
    const f = D[i], e = ed[i], g = f.grid, col = colorAt(f.color);
    if (f.kind === 'warp' && f.warp) {
      const w = f.warp, np = (w.rows + 1) * (w.cols + 1), pts = f32(buffers, w.points);
      const rest = restOf(g, pts, np * 2);
      const px: number[] = [];
      for (let k = 0; k < np; k++) px.push(...fromLocal(f.parent, rest[k * 2], rest[k * 2 + 1]));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < np; k++) { x0 = Math.min(x0, px[k * 2]); x1 = Math.max(x1, px[k * 2]); y0 = Math.min(y0, px[k * 2 + 1]); y1 = Math.max(y1, px[k * 2 + 1]); }
      if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
      e.rect = [x0, y0, Math.max(1e-3, x1 - x0), Math.max(1e-3, y1 - y0)];
      e.cols = w.cols; e.rows = w.rows;
      if (!w.quad) e.quad = false;
      const [rx, ry, rw, rh] = e.rect;
      const form = exactForm(g, (k) => {
        const d: number[] = [];
        for (let j = 0, q = 0; j <= w.rows; j++) for (let c = 0; c <= w.cols; c++, q++) {
          const [x, y] = fromLocal(f.parent, pts[(k * np + q) * 2], pts[(k * np + q) * 2 + 1]);
          d.push(x - (rx + (rw * c) / w.cols), y - (ry + (rh * j) / w.rows));
        }
        const v: EdValue = { d, o: f.opacity[k] ?? 1 };
        col(k, v);
        return v;
      });
      if (form) e.forms.push(form);
    } else if (f.rotation) {
      const r = f.rotation;
      const a0 = r.baseAngle + restOf(g, r.angle, 1)[0], s0raw = restOf(g, r.scale, 1)[0];
      const s0 = Math.abs(s0raw) > 1e-6 ? s0raw : 1;
      rotS0[i] = s0;
      const up = frameAboveIdx(f.parent);
      const [ox0, oy0] = [restOf(g, r.originX, 1)[0], restOf(g, r.originY, 1)[0]];
      e.origin = fromLocal(f.parent, ox0, oy0);
      e.frame = { angle: up.angle + a0, scale: up.scale * s0 };
      const rx = r.reflectX[0] ?? false, ry = r.reflectY[0] ?? false;
      if (rx || ry) e.reflect = [rx, ry];
      if (r.reflectX.some((x) => x !== rx) || r.reflectY.some((x) => x !== ry)) mirrorMixed++;
      const form = exactForm(g, (k) => {
        const [x, y] = fromLocal(f.parent, r.originX[k], r.originY[k]);
        const v: EdValue = { a: r.baseAngle + r.angle[k] - a0, ox: x - e.origin![0], oy: y - e.origin![1], s: r.scale[k] / s0 - 1, o: f.opacity[k] ?? 1 };
        col(k, v);
        return v;
      });
      if (form) e.forms.push(form);
    }
  }
  if (mirrorMixed) notes.push(`${plural(mirrorMixed, 'turning group flips', 'turning groups flip')} its mirroring while moving; it now keeps the mirroring it has at rest.`);

  // ---------------------------------------------------------------- parts, static visibility, keyed switch-offs
  const parts = src.parts;
  const edParts: EdPart[] = parts.map((p) => ({ id: p.id, name: p.name, parent: p.parent >= 0 && parts[p.parent] ? parts[p.parent].id : null }));
  const chain = (i: number) => { const out: number[] = []; for (let d = 0; i >= 0 && d <= parts.length && parts[i]; d++, i = parts[i].parent) out.push(i); return out; };
  const partOn = (i: number) => chain(i).every((k) => parts[k].enabled);
  const partOpacity = (i: number) => chain(i).reduce((o, k) => o * Math.min(1, Math.max(0, parts[k].opacity ?? 1)), 1);
  const restrictive = (g: number) => (src.grids[g]?.axes ?? []).filter((a) => { const p = P[a.param]; return !!p && (a.keys.length === 1 || a.keys[0] > p.min + EPS || a.keys[a.keys.length - 1] < p.max - EPS); })
    .map((a) => ({ param: pid(a.param), keys: a.keys.slice() }));
  let unfolded = 0;
  /** an object switched off outside a part's keys: the same axis on its own exact form */
  const foldAxes = (forms: EdForm[], axes: Axes) => {
    for (const ax of axes) {
      let f = forms.find((x) => x.exact);
      if (!f) { f = { axes: [], values: [null], exact: true }; forms.unshift(f); }
      if (f.axes.some((a) => a.param === ax.param) || f.axes.length >= 8) { unfolded++; continue; }
      const n = f.values.length;
      f.values = Array.from({ length: n * ax.keys.length }, (_, k) => f!.values[k % n]);
      f.axes = [...f.axes, { param: ax.param, keys: ax.keys.slice() }];
    }
  };
  // deformers: owning part's keyed switch-off; switched off for good → their parts hidden below
  const defOff = new Uint8Array(D.length);
  for (const i of order) {
    const f = D[i];
    if (!f.enabled || (f.part >= 0 && !partOn(f.part)) || (f.parent >= 0 && defOff[f.parent])) defOff[i] = 1;
    if (f.part >= 0) foldAxes(ed[i].forms, chain(f.part).flatMap((k) => restrictive(parts[k].grid)));
  }

  // ---------------------------------------------------------------- render order at rest (+ per-keyform moves)
  const ev = new RigEval(src, buffers);
  ev.update();
  const M = src.meshes, nm = M.length;
  const meshDo = Array.from(ev.out.drawOrder);
  const partDo = parts.map((p) => (p.drawOrder.length ? restOf(p.grid, p.drawOrder, 1)[0] : 500));
  const rank = new Float64Array(nm).fill(NaN);
  const zOffsets: ((k: number) => number)[] = new Array(nm).fill(null).map(() => () => 0);
  const groups = src.drawGroups;
  if (!groups?.length) {
    // (no groups: the runtime sorts by the draw-order values themselves, ties by index, so the values carry over as
    // they are and every change between keys stays exact)
    M.forEach((m, i) => {
      rank[i] = meshDo[i];
      const dOrd = m.drawOrder;
      if (dOrd.every((x) => x === dOrd[0])) return;
      zOffsets[i] = (k) => (dOrd[k] ?? meshDo[i]) - meshDo[i];
    });
  } else {
    // Groups (the runtime walks them: each group's items sorted by their rounded draw-order value, ties by their place
    // in the group, a part item reserving room for its own group). One flat z per mesh reproduces that walk: a group
    // whose meshes never move lays its items out one after another in their resting order; a group with a mesh that
    // moves gives every whole draw-order value a slot (much wider than all its items together), so a moving mesh's z
    // is a straight line in its value: the items that come before it in the group sit in the upper half of their slot
    // and those after it in the lower half, so it passes each where the runtime's rounding does (value ± ½): exact at
    // the keys, and between keys within a small fraction of a draw-order step.
    const home = new Map<number, { g: number; j: number }>();
    groups.forEach((g, gi) => g.items.forEach((it, j) => { if (it.kind === 'mesh' && !home.has(it.index)) home.set(it.index, { g: gi, j }); }));
    const clampV = (g: typeof groups[number], v: number) => Math.min(Math.max(v, g.min), g.max);
    const restV = (g: typeof groups[number], it: typeof groups[number]['items'][number]) => clampV(g, it.kind === 'part' ? partDo[it.index] : meshDo[it.index]);
    const moves = (gi: number, it: typeof groups[number]['items'][number]) => it.kind === 'mesh' && home.get(it.index)?.g === gi
      && M[it.index].drawOrder.some((x) => Math.round(x) !== Math.round(M[it.index].drawOrder[0]));
    const LIMIT = 4e6;   // (z goes through 32-bit floats in the runtime: keep whole steps exact)
    const width = new Float64Array(groups.length).fill(-1), slot = new Float64Array(groups.length), vlo = new Float64Array(groups.length);
    const widthOf = (gi: number, depth = 0): number => {
      if (width[gi] >= 0) return width[gi];
      if (depth > groups.length) return (width[gi] = 0);
      const g = groups[gi];
      const w = g.items.map((it) => (it.kind === 'mesh' ? 1 : it.group >= 0 && it.group !== gi ? widthOf(it.group, depth + 1) : 0));
      const sum = w.reduce((x, y) => x + y, 0);
      width[gi] = sum;
      if (g.items.some((it) => moves(gi, it))) {
        let lo = Infinity, hi = -Infinity;
        g.items.forEach((it) => {
          const vs = [restV(g, it), ...(moves(gi, it) ? M[it.index].drawOrder.map((x) => clampV(g, x)) : [])];
          for (const v of vs) { lo = Math.min(lo, Math.floor(v)); hi = Math.max(hi, Math.ceil(v)); }
        });
        const R = hi - lo + 1, K = Math.min(4096, Math.floor(LIMIT / (R * (sum + 1))));
        if (Number.isFinite(R) && K >= 4) { slot[gi] = K * (sum + 1); vlo[gi] = lo; width[gi] = R * slot[gi]; }
      }
      return width[gi];
    };
    const place = (gi: number, lo: number, depth = 0) => {
      if (depth > groups.length) return;
      const g = groups[gi], S = slot[gi];
      const w = g.items.map((it) => (it.kind === 'mesh' ? 1 : it.group >= 0 && it.group !== gi ? widthOf(it.group) : 0));
      const put = (j: number, z: number) => {
        const it = g.items[j];
        if (it.kind === 'mesh') { if (Number.isNaN(rank[it.index])) rank[it.index] = z; }
        else if (it.group >= 0 && it.group !== gi) place(it.group, z, depth + 1);
      };
      if (S > 0) {
        // value slots: item j sits at (value − lowest) · S + its half (by the moving meshes before / after it) + the
        // room of the items before it in the group; a slot is S = K · (all items' room + 1) wide
        const pre: number[] = [];
        const sum = w.reduce((acc, x, j) => { pre[j] = acc; return acc + x; }, 0);
        const movers = g.items.map((it, j) => (moves(gi, it) ? j : -1)).filter((j) => j >= 0);
        const H = S / 2 - (sum + 1);
        g.items.forEach((it, j) => {
          const v = restV(g, it);
          const half = moves(gi, it) ? 0 : (2 * movers.filter((q) => q < j).length / movers.length - 1) * H;
          put(j, lo + ((moves(gi, it) ? v : Math.round(v)) - vlo[gi]) * S + half + pre[j] + H);
          if (moves(gi, it)) {
            const mi = it.index, dOrd = M[mi].drawOrder;
                  zOffsets[mi] = (k) => (clampV(g, dOrd[k] ?? v) - v) * S;
          }
        });
      } else {
        // one after another, in the resting order (a moving mesh here: see the fallback below)
        const order = g.items.map((it, j) => [Math.round(restV(g, it)), j] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let at = lo;
        for (const [, j] of order) { put(j, at); at += w[j]; }
      }
    };
    const child = new Set<number>();
    groups.forEach((g, gi) => g.items.forEach((it) => { if (it.kind === 'part' && it.group >= 0 && it.group !== gi) child.add(it.group); }));
    let at = 0;
    groups.forEach((_, gi) => { if (!child.has(gi)) { widthOf(gi); place(gi, at); at += widthOf(gi) + 1; } });
    // fallback (a group too big for slots): a moving mesh jumps, at each key, between the neighbours it has there
    const rangeOf = (gi: number, j: number, depth = 0): [number, number] | null => {
      const it = groups[gi].items[j];
      if (it.kind === 'mesh') return Number.isNaN(rank[it.index]) ? null : [rank[it.index], rank[it.index]];
      if (it.group < 0 || depth > groups.length) return null;
      let lo = Infinity, hi = -Infinity;
      groups[it.group].items.forEach((_, k) => { const q = rangeOf(it.group, k, depth + 1); if (q) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[1]); } });
      return Number.isFinite(lo) ? [lo, hi] : null;
    };
    M.forEach((m, i) => {
      const h = home.get(i);
      if (!h || slot[h.g] > 0 || Number.isNaN(rank[i]) || !moves(h.g, groups[h.g].items[h.j])) return;
      const g = groups[h.g], dOrd = m.drawOrder;
      zOffsets[i] = (k) => {
        const items = g.items.map((it, j) => [Math.round(j === h.j ? clampV(g, dOrd[k]) : restV(g, it)), j] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const q0 = items.findIndex(([, j]) => j === h.j);
        let below: number | null = null, above: number | null = null;
        for (let q = q0 - 1; q >= 0 && below === null; q--) { const rr = items[q][1] === h.j ? null : rangeOf(h.g, items[q][1]); if (rr) below = rr[1]; }
        for (let q = q0 + 1; q < items.length && above === null; q++) { const rr = rangeOf(h.g, items[q][1]); if (rr) above = rr[0]; }
        if ((below === null || below < rank[i]) && (above === null || above > rank[i])) return 0;
        const z = below !== null && above !== null ? (below + above) / 2 : below !== null ? below + 0.5 : above! - 0.5;
        return z - rank[i];
      };
    });
  }
  if (parts.some((p) => p.drawOrder.some((x) => x !== p.drawOrder[0])) || (src.blendShapes ?? []).some((b) => b.target.kind === 'part'))
    notes.push('Some groups of parts change which is in front as the model moves; each group now keeps its resting place (parts that move in front of their neighbours still do).');

  // ---------------------------------------------------------------- meshes + their pictures
  const textures: EdTexture[] = [], texInfo: EdTextureInfo[] = [];
  let missingPic = 0, oddBlend = 0;
  const edMeshes: EdMesh[] = M.map((m, i) => {
    const n = m.vertexCount, g = m.grid, pos = f32(buffers, m.positions), uv = f32(buffers, m.uvs);
    const rest = restOf(g, pos, n * 2);
    const restPx: number[] = [];
    for (let k = 0; k < n; k++) restPx.push(...fromLocal(m.deformer, rest[k * 2], rest[k * 2 + 1]));
    const col = colorAt(m.color), zOff = zOffsets[i];
    const forms: EdForm[] = [];
    const form = exactForm(g, (k) => {
      const d: number[] = [];
      for (let q = 0; q < n; q++) { const [x, y] = fromLocal(m.deformer, pos[(k * n + q) * 2], pos[(k * n + q) * 2 + 1]); d.push(x - restPx[q * 2], y - restPx[q * 2 + 1]); }
      const v: EdValue = { d, o: m.opacity[k] ?? 1 };
      col(k, v);
      const z = zOff(k);
      if (!near0(z)) v.z = z;
      return v;
    });
    if (form) forms.push(form);
    if (m.part >= 0) foldAxes(forms, chain(m.part).flatMap((k) => restrictive(parts[k].grid)));
    // the picture: this mesh's region of its texture page
    const page = pages[m.texture];
    let tex: EdTexture, newUv: number[];
    if (page && page.w > 0 && page.h > 0) {
      let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
      for (let k = 0; k < n; k++) { const u = uv[k * 2] * page.w, v = uv[k * 2 + 1] * page.h; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const x0 = Math.max(0, Math.min(page.w - 1, Math.floor(u0) - 2)), y0 = Math.max(0, Math.min(page.h - 1, Math.floor(v0) - 2));
      const x1 = Math.max(x0 + 1, Math.min(page.w, Math.ceil(u1) + 2)), y1 = Math.max(y0 + 1, Math.min(page.h, Math.ceil(v1) + 2));
      const w = x1 - x0, h = y1 - y0, rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) rgba.set(page.rgba.subarray(((y0 + y) * page.w + x0) * 4, ((y0 + y) * page.w + x1) * 4), y * w * 4);
      tex = { w, h, rgba };
      newUv = [];
      for (let k = 0; k < n; k++) newUv.push((uv[k * 2] * page.w - x0) / w, (uv[k * 2 + 1] * page.h - y0) / h);
      keepCovered(rgba, w, h, newUv, viewArray(buffers, m.indices));
    } else { missingPic++; tex = { w: 1, h: 1, rgba: new Uint8ClampedArray(4) }; newUv = new Array(n * 2).fill(0.5); }
    let bx0 = Infinity, by0 = Infinity;
    for (let k = 0; k < n; k++) { bx0 = Math.min(bx0, restPx[k * 2]); by0 = Math.min(by0, restPx[k * 2 + 1]); }
    textures.push(tex);
    texInfo.push({ name: m.name, x: Number.isFinite(bx0) ? bx0 : 0, y: Number.isFinite(by0) ? by0 : 0, w: tex.w, h: tex.h });
    // shown at all: its own flags, its parts and deformers switched on, placed in the render order
    const on = m.enabled && m.visible && !Number.isNaN(rank[i]) && (m.part < 0 || partOn(m.part)) && (m.deformer < 0 || !defOff[m.deformer]);
    const blend = m.blend === 'normal' || m.blend === 'add' || m.blend === 'multiply' || m.blend === 'screen' ? m.blend : (oddBlend++, 'normal' as const);
    const tri = Array.from(viewArray(buffers, m.indices));
    const em: EdMesh = {
      id: m.id, name: m.name, group: m.part >= 0 ? chain(m.part).reverse().map((k) => parts[k].name).join('/') : '', role: 'unknown', side: null, tex: i,
      mesh: { pos: restPx, uv: newUv, tri }, deformer: m.deformer >= 0 && D[m.deformer] ? D[m.deformer].id : null,
      z: Number.isNaN(rank[i]) ? -1 : rank[i], opacity: m.part >= 0 ? partOpacity(m.part) : 1, blend, masks: m.masks.filter((k) => M[k]).map((k) => M[k].id), ...(m.maskInvert ? { maskInvert: true } : {}),
      visible: on, depth: 0, forms, part: m.part >= 0 && parts[m.part] ? parts[m.part].id : null, uvFree: true, ...(m.doubleSided ? {} : { culled: true }),
      ...(m.outline ? { outline: { width: m.outline.width, color: m.outline.color.map(linToSrgb) as [number, number, number], ...(m.outline.opacity !== undefined ? { opacity: m.outline.opacity } : {}), ...(m.outline.lightResponsive ? { light: true } : {}) } } : {}),
    };
    return em;
  });
  if (unfolded) notes.push(`${plural(unfolded, 'part that a slider switches off is', 'parts that sliders switch off are')} now always shown.`);
  if (missingPic) notes.push(`${plural(missingPic, 'part has', 'parts have')} no picture (the model's texture could not be read): ${missingPic === 1 ? 'it is' : 'they are'} left blank.`);
  if (oddBlend) notes.push(`${plural(oddBlend, 'part uses a blend mode', 'parts use blend modes')} the maker doesn't have; ${oddBlend === 1 ? 'it is' : 'they are'} drawn normally.`);
  // 2.5D parallax: each part's total depth (its own + its groups'), in px like the model's (the runtime divides by the unit)
  const partDepth = (i: number) => chain(i).reduce((d, k) => d + (parts[k].depth ?? 0), 0);
  const depthOf: Record<string, number> = {};
  if (src.depth) M.forEach((m) => { const d = (m.depth ?? 0) + (m.part >= 0 ? partDepth(m.part) : 0); if (d) depthOf[m.id] = d; });

  // ---------------------------------------------------------------- blend shapes
  let shapeLost = 0;
  for (const b of src.blendShapes ?? []) {
    const t = b.target, axes: Axes = [{ param: pid(b.param), keys: b.keys.slice() }, ...(b.param2 !== undefined && b.keys2 ? [{ param: pid(b.param2), keys: b.keys2.slice() }] : [])];
    const nk = b.keys.length * (b.keys2?.length ?? 1);
    const constraints = (b.constraints ?? []).map((c) => ({ param: pid(c.param), keys: c.keys.slice(), weights: c.weights.slice() }));
    const shape = (values: (EdValue | null)[]): EdForm => ({ axes, values, shape: true, ...(constraints.length ? { constraints } : {}) });
    if ((t.kind === 'mesh' || t.kind === 'warp') && b.offsets) {
      const off = f32(buffers, b.offsets);
      const np = t.kind === 'mesh' ? M[t.index].vertexCount : (D[t.index].warp!.rows + 1) * (D[t.index].warp!.cols + 1);
      const space = t.kind === 'mesh' ? M[t.index].deformer : D[t.index].parent;
      const values = Array.from({ length: nk }, (_, k) => {
        const d: number[] = [];
        let any = false;
        for (let q = 0; q < np; q++) { const [x, y] = fromDelta(space, off[(k * np + q) * 2], off[(k * np + q) * 2 + 1]); d.push(x, y); if (!near0(x) || !near0(y)) any = true; }
        return any ? { d } : null;
      });
      if (values.some((v) => v)) (t.kind === 'mesh' ? edMeshes[t.index] : ed[t.index]).forms.push(shape(values));
    } else if (t.kind === 'rotation' && D[t.index]?.kind === 'rotation') {
      const vals = b.values ?? {}, s0 = rotS0[t.index];
      const values = Array.from({ length: nk }, (_, k) => {
        const [ox, oy] = fromDelta(D[t.index].parent, vals.originX?.[k] ?? 0, vals.originY?.[k] ?? 0);
        const v: EdValue = { a: vals.angle?.[k] ?? 0, ox, oy, s: (vals.scale?.[k] ?? 0) / s0 };
        return near0(v.a!) && near0(ox) && near0(oy) && near0(v.s!) ? null : v;
      });
      if (values.some((v) => v)) ed[t.index].forms.push(shape(values));
    } else shapeLost++;
  }
  if (shapeLost) notes.push(`${plural(shapeLost, 'slider tweak', 'slider tweaks')} of layering or of how parts stick together ${shapeLost === 1 ? 'was' : 'were'} left out.`);

  // ---------------------------------------------------------------- bones + skins
  const bones = src.bones ?? [];
  const edBones: EdBone[] = [];
  let boneScale = 0;
  {
    const done: (EdBone | null)[] = bones.map(() => null);
    const make = (i: number, depth: number): EdBone | null => {
      if (done[i] || depth > bones.length) return done[i];
      const b = bones[i];
      const par = b.parent >= 0 && bones[b.parent] ? make(b.parent, depth + 1) : null;
      let x: number, y: number, angle: number;
      const unit = par || !(b.deformer !== undefined && b.deformer >= 0) ? S : 1;
      if (par) {
        const a = (par.angle * Math.PI) / 180, lx = b.x * S, ly = b.y * S;
        x = par.x + Math.cos(a) * lx - Math.sin(a) * ly; y = par.y + Math.sin(a) * lx + Math.cos(a) * ly; angle = par.angle + b.angle;
      } else { [x, y] = fromLocal(b.deformer !== undefined && b.deformer >= 0 ? b.deformer : -1, b.x, b.y); angle = b.angle; }
      const kf = b.keyforms, n = kfN(b.grid);
      if (kf.scaleX.some((v, k) => Math.abs(v - (kf.scaleY[k] ?? v)) > 1e-6)) boneScale++;
      const values = Array.from({ length: n }, (_, k) => { const v: EdValue = { a: kf.angle[k] ?? 0, ox: (kf.x[k] ?? 0) * unit, oy: (kf.y[k] ?? 0) * unit, s: (kf.scaleX[k] ?? 1) - 1 }; return near0(v.a!) && near0(v.ox!) && near0(v.oy!) && near0(v.s!) ? null : v; });
      const eb: EdBone = { id: b.id, name: b.name, parent: par ? par.id : null, deformer: !par && b.deformer !== undefined && b.deformer >= 0 && D[b.deformer] ? D[b.deformer].id : null, x, y, angle, length: b.length * S,
        forms: values.some((v) => v) || axesOf(b.grid).length ? [{ axes: axesOf(b.grid), values, exact: true }] : [] };
      done[i] = eb;
      return eb;
    };
    bones.forEach((_, i) => { const b = make(i, 0); if (b) edBones.push(b); });
    M.forEach((m, i) => {
      if (!m.skin || !bones.length) return;
      const J = viewArray(buffers, m.skin.joints), W = f32(buffers, m.skin.weights), n = m.vertexCount, skin: Record<string, number[]> = {};
      for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) {
        const w = W[v * 4 + k], j = J[v * 4 + k];
        if (!w || !bones[j]) continue;
        (skin[bones[j].id] ??= new Array(n).fill(0))[v] += w;
      }
      if (Object.keys(skin).length) edMeshes[i].skin = skin;
    });
  }
  if (boneScale) notes.push(`${plural(boneScale, 'bone stretches', 'bones stretch')} differently along and across; ${boneScale === 1 ? 'it now stretches' : 'they now stretch'} evenly.`);

  // ---------------------------------------------------------------- props, effects, outfits, views, moods
  const sprite = (texture: number, rect: [number, number, number, number], name: string): number => {
    const page = pages[texture];
    let tex: EdTexture;
    if (page) {
      const x0 = Math.max(0, Math.floor(rect[0] * page.w)), y0 = Math.max(0, Math.floor(rect[1] * page.h));
      const w = Math.max(1, Math.min(page.w - x0, Math.round(rect[2] * page.w))), h = Math.max(1, Math.min(page.h - y0, Math.round(rect[3] * page.h))), rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) rgba.set(page.rgba.subarray(((y0 + y) * page.w + x0) * 4, ((y0 + y) * page.w + x0 + w) * 4), y * w * 4);
      tex = { w, h, rgba };
    } else tex = { w: 1, h: 1, rgba: new Uint8ClampedArray(4) };
    textures.push(tex);
    texInfo.push({ name, x: 0, y: 0, w: tex.w, h: tex.h, kind: 'sprite' });
    return textures.length - 1;
  };
  const slotOf = (sl: NonNullable<Rig2DDoc['attachments']>[number]['slot']): EdSlot => {
    if (sl.mesh !== undefined) return { mesh: sl.mesh, vertex: sl.vertex ?? 0, ...(sl.vertex2 !== undefined ? { vertex2: sl.vertex2 } : {}) };
    if (sl.bone !== undefined) return { bone: sl.bone, ...(sl.x !== undefined ? { x: sl.x * S } : {}), ...(sl.y !== undefined ? { y: sl.y * S } : {}) };
    const di = D.findIndex((f) => f.id === sl.deformer);
    const [x, y] = fromLocal(di, sl.x ?? 0, sl.y ?? 0);
    return { deformer: sl.deformer, x, y };
  };
  const attachments: EdAttachment[] = (src.attachments ?? []).map((a) => ({ id: a.id, name: a.name, slot: slotOf(a.slot), tex: sprite(a.texture, a.rect, a.name), pivot: [a.pivot[0], a.pivot[1]], size: [a.size[0] * S, a.size[1] * S],
    ...(a.angle ? { angle: a.angle } : {}), ...(a.rotate === false ? { rotate: false } : {}), ...(a.blend ? { blend: a.blend } : {}), ...(a.draw ? { draw: { ...a.draw } } : {}), on: a.on }));
  const particles: EdParticles[] = (src.particles ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id, slot: slotOf(p.slot), tex: sprite(p.texture, p.rect, p.name ?? p.id), rate: p.rate, life: p.life,
    speed: [p.speed[0] * S, p.speed[1] * S], ...(p.angle !== undefined ? { angle: p.angle } : {}), spread: p.spread, gravity: [p.gravity[0] * S, p.gravity[1] * S], size: [p.size[0] * S, p.size[1] * S],
    ...(p.spin ? { spin: p.spin } : {}), ...(p.fade !== undefined ? { fade: p.fade } : {}), ...(p.max ? { max: p.max } : {}), ...(p.blend ? { blend: p.blend } : {}), ...(p.draw ? { draw: { ...p.draw } } : {}), trigger: { ...p.trigger }, on: true }));
  const dynamics: EdDynamic[] = [], pendulums: NonNullable<Rig2DDoc['dynamics']> = [];
  for (const y of rig2dDynamics(src)) {
    if (y.kind === 'pendulum') { pendulums.push({ ...y }); continue; }
    // (follow: every field is relative to its mesh except gravity, which is canvas px / s² like a chain's: the editor's canvas has no unit)
    dynamics.push({ id: y.id, kind: y.kind, ...(y.input ? { input: y.input } : {}), ...(y.output ? { output: y.output } : {}), ...(y.bones ? { bones: y.bones.slice() } : {}),
      ...(y.kind === 'follow' ? { meshes: (y.meshes ?? []).slice(), ...(y.anchor ? { anchor: y.anchor } : {}), ...Object.fromEntries((['reach', 'spread', 'stretch', 'squash'] as const).filter((k) => y[k] !== undefined).map((k) => [k, y[k]])) } : {}),
      ...Object.fromEntries((['stiffness', 'damping', 'gain', 'strength', 'period', 'gravity', 'limit', 'boneLimit'] as const).filter((k) => y[k] !== undefined).map((k) => [k, k === 'gravity' ? y[k]! * S : y[k]])),
      ...(y.amount ? { amount: y.amount } : {}) });
  }
  const costumes: EdCostume[] = (src.layers ?? []).map((l) => ({ id: l.id, name: l.name, parts: l.parts.slice(), ...(l.attachments ? { attachments: l.attachments.slice() } : {}), ...(l.group ? { group: l.group } : {}), on: l.on }));
  let blendTrees = 0;
  const states: EdStateLayer[] = (src.states?.layers ?? []).map((L) => ({ id: L.id, ...(L.name ? { name: L.name } : {}), initial: L.initial,
    states: L.states.map((st) => { if (st.blend) blendTrees++; return { id: st.id, ...(st.expression ? { expression: st.expression } : st.blend ? { expression: st.blend.points[st.blend.points.length - 1].expression } : {}), ...(st.motion ? { motion: st.motion } : {}) }; }),
    transitions: L.transitions.map((t) => ({ from: t.from, to: t.to, ...(t.fade !== undefined ? { fade: t.fade } : {}), on: { ...t.on } })) }));
  if (blendTrees) notes.push(`${plural(blendTrees, 'mood that mixes expressions', 'moods that mix expressions')} by your voice now ${blendTrees === 1 ? 'shows' : 'show'} one expression.`);
  if (src.textures.some((t) => t.sheet)) notes.push('Animated pictures now show their first frame.');
  if (src.textures.some((t) => t.normal || t.rim || t.emission) || src.lighting) notes.push('The lighting pictures (relief, rim light, glow) were left out: turn on lighting in the Lighting tab to make new ones.');
  if ((src.expressions ?? []).some((e) => e.parts?.length)) notes.push('Expressions that showed or hid whole parts now only move sliders.');
  if (src.motions?.length) notes.push(`The ${plural(src.motions.length, 'motion clip stays', 'motion clips stay')} with your avatar when you save it to your library (a downloaded .vtp2 file leaves ${src.motions.length === 1 ? 'it' : 'them'} out).`);
  if (src.physics?.length || pendulums.length) notes.push('Hair and clothes swing exactly as before. Swing you add in the Physics tab comes on top; the model\'s own swing settings can\'t be changed there yet.');

  // ---------------------------------------------------------------- what the maker keeps as it is
  const imported: EdImported = {
    from: src.meta.source?.kind === 'live2d' || src.meta.source?.kind === 'inochi2d' ? src.meta.source.kind : 'native',
    ...(src.meta.source?.file ? { file: src.meta.source.file } : {}),
    notes,
    roles: { eyeBlink: src.roles.eyeBlink.slice(), lipSync: src.roles.lipSync.slice(), ...(src.roles.bind ? { bind: structuredClone(src.roles.bind) } : {}) },
    ...(src.physics?.length ? { physics: structuredClone(src.physics) } : {}),
    ...(src.physicsWorld ? { physicsWorld: structuredClone(src.physicsWorld) } : {}),
    ...(src.glue?.length ? { glue: src.glue.map((g) => ({ id: g.id, ...(g.name ? { name: g.name } : {}), a: M[g.a].id, b: M[g.b].id, na: M[g.a].vertexCount, nb: M[g.b].vertexCount, axes: axesOf(g.grid), intensity: g.intensity.slice(),
      pairs: Array.from(viewArray(buffers, g.pairs)), weights: Array.from(f32(buffers, g.weights)) })) } : {}),
    ...(pendulums.length ? { dynamics: pendulums } : {}),
    ...(src.materialBindings?.length ? { materialBindings: src.materialBindings.filter((c) => D[c.deformer]).map((c) => ({ deformer: D[c.deformer].id, opacity: c.opacity, multiply: [...c.multiply] as [number, number, number], screen: [...c.screen] as [number, number, number],
      bindings: c.bindings.map((b) => ({ channel: b.channel, param: pid(b.param), keys: b.keys.slice(), ...(b.param2 !== undefined ? { param2: pid(b.param2), keys2: (b.keys2 ?? []).slice() } : {}), values: b.values.slice() })) })) } : {}),
    ...(src.switches?.length ? { switches: structuredClone(src.switches) } : {}),
    ...(src.hitAreas?.length ? { hitAreas: structuredClone(src.hitAreas) } : {}),
    ...(src.depth && Object.keys(depthOf).length ? { depth: { ...(src.depth.yaw ? { yaw: src.depth.yaw } : {}), ...(src.depth.pitch ? { pitch: src.depth.pitch } : {}), strength: src.depth.strength, meshes: depthOf } } : {}),
    // (extra.follow became editor dynamics above: left out here so the writer does not bring a deleted follow back)
    ...(src.extra && Object.keys(src.extra).filter((k) => k !== FOLLOW_EXTRA_KEY).length ? { extra: structuredClone(Object.fromEntries(Object.entries(src.extra).filter(([k]) => k !== FOLLOW_EXTRA_KEY))) as Record<string, unknown> } : {}),
    ...(src.meta.licenseUrl ? { licenseUrl: src.meta.licenseUrl } : {}),
    ...(src.meta.rights ? { rights: structuredClone(src.meta.rights) } : {}),
  };

  const doc: EdDoc = {
    version: EDIT_VERSION, name: src.meta.name || 'Imported avatar',
    canvas: { w: Math.max(1, Math.round(src.canvas.width)), h: Math.max(1, Math.round(src.canvas.height)) },
    textures: texInfo,
    params: P.map((p) => ({ id: p.id, name: p.name || p.id, min: p.min, max: p.max, def: p.default, ...(p.group ? { group: p.group } : {}), ...(p.repeat ? { repeat: true } : {}),
      ...(p.decimals !== undefined ? { decimals: p.decimals } : {}), ...(p.kind === 'blend' ? { kind: 'blend' as const } : {}) })),
    meshes: edMeshes, deformers: ed, physics: [],
    expressions: (src.expressions ?? []).map((e) => ({ id: e.id, name: e.name, ...(e.key ? { key: e.key } : {}), fadeIn: e.fadeIn, fadeOut: e.fadeOut, params: e.params.map((x) => ({ ...x })) })),
    meta: { ...(src.meta.authors ? { authors: src.meta.authors.slice() } : {}), ...(src.meta.license ? { license: src.meta.license } : {}), ...(src.meta.notes ? { notes: src.meta.notes } : {}) },
    extras: {
      ...(edParts.length ? { parts: edParts } : {}), ...(edBones.length ? { bones: edBones } : {}), ...(attachments.length ? { attachments } : {}), ...(particles.length ? { particles } : {}),
      ...(dynamics.length ? { dynamics } : {}), ...(costumes.length ? { costumes } : {}), ...(states.length ? { states } : {}),
      ...(src.views ? { views: { by: src.views.by, sets: src.views.sets.map((v) => ({ id: v.id, at: v.at, parts: v.parts.slice() })), ...(src.views.blendBand !== undefined ? { blendBand: src.views.blendBand } : {}), ...(src.views.hysteresis !== undefined ? { hysteresis: src.views.hysteresis } : {}) } } : {}),
    },
    report: { understood: [], notes: notes.slice() },
    imported,
  };
  // ids the maker needs unique across its own lists (the format already checks meshes / deformers / params)
  const taken = new Set<string>();
  for (const t of doc.textures) { t.name = uniqueId(t.name || 'part', (x) => taken.has(x)); taken.add(t.name); }
  return { doc, textures, notes };
}

/** Clear the pixels of a cut-out picture that none of its mesh's triangles shows (more than `pad` px away): the
 *  neighbours a shared texture page has next to it stay out of this part's own picture (what is drawn is unchanged:
 *  the pad keeps every pixel smooth sampling at an edge reads). */
function keepCovered(rgba: Uint8ClampedArray, w: number, h: number, uv: readonly number[], tri: ArrayLike<number>, pad = 2) {
  const keep = new Uint8Array(w * h);
  const segD2 = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
  };
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const ax = uv[a * 2] * w, ay = uv[a * 2 + 1] * h, bx = uv[b * 2] * w, by = uv[b * 2 + 1] * h, cx = uv[c * 2] * w, cy = uv[c * 2 + 1] * h;
    if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) - pad)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) - pad)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) + pad));
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (keep[y * w + x]) continue;
      const px = x + 0.5, py = y + 0.5;
      let inside = false;
      if (Math.abs(d) > 1e-12) {
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / d, w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / d;
        inside = w0 >= 0 && w1 >= 0 && 1 - w0 - w1 >= 0;
      }
      if (inside || Math.min(segD2(px, py, ax, ay, bx, by), segD2(px, py, bx, by, cx, cy), segD2(px, py, cx, cy, ax, ay)) <= pad * pad) keep[y * w + x] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) if (!keep[i]) { rgba[i * 4] = 0; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 0; rgba[i * 4 + 3] = 0; }
}

/** Is this editor document an adopted import (the auto-rig and its questions stay away from it)? */
export const isImported = (d: EdDoc | null | undefined) => !!d?.imported;
