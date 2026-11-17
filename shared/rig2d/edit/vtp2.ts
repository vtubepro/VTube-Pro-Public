// Editor document ⇄ the runtime format (shared/rig2d/format.ts, docs/RIG2D_FORMAT.md).
//   buildRig(doc, textures)  → a validated Rig2DDoc + buffers + atlas pages (RGBA): what the editor preview evaluates
//                               with the runtime's own evaluator (shared/rig2d/evaluate.ts), so editor and runtime agree;
//   packRig(built, encodePng) → the archive bytes, with the editor project inside (editor/project.json) so the file
//                               opens again in the editor with roles, auto flags and hand-made keyforms intact;
//   openRig(bytes)            → the editor project back (or a clear error); a rig made elsewhere is adopted (adopt.ts),
//                               its pages decoded within a memory budget (editDecodeScale).
// Conversions: canvas-px geometry → each object's parent-deformer space (rotation: px from the pivot; warp: the
// lattice's 0..1 space); a target's multi-parameter forms and opacity forms → its keyform GRID (keys always span the
// parameter's whole range, so nothing switches off); every other single-parameter form → an additive BLEND SHAPE.
// Pure (no DOM): PNG coding is injected.
import { RIG2D, rig2dForStorage, validateRig2D, type Rig2DDoc, type Rig2DIssue } from '../format.ts';
import { BufferBuilder, writeVtp2, zipEntries, zipRead, isVtp2, readVtp2, type InflateRaw } from '../container.ts';
import { adoptRig, type AdoptPage } from './adopt.ts';
import { sampleForm, gridSize, type EdDoc, type EdForm, type EdMesh, type EdDeformer, type EdTexture, type EdValue, type EdSlot, type EdDrawAt } from './doc.ts';
import { buildMaps, type LightMaps } from './maps.ts';
import { STD_BIND, VOWEL_BIND } from './autorig.ts';
import { RIG_NO_CHANGES, rigNoChanges } from '../rigEdit.ts';
import { rig2dDecodeBudget, rig2dDecodeScale } from '../limits.ts';

export const PROJECT_ENTRY = 'editor/project.json';
/** Gutter around every atlas cell (px), filled by EDGE EXTRUSION (the cell's border pixels copied outward, alpha
 *  included), so mip-mapping and small on-stream sizes never pull in a neighbouring cell. */
export const ATLAS_GUTTER = 4;
const PAD = ATLAS_GUTTER;

export interface AtlasPage { w: number; h: number; rgba: Uint8ClampedArray }
export interface BuiltRig {
  doc: Rig2DDoc;
  buffers: Uint8Array[];
  pages: AtlasPage[];
  issues: Rig2DIssue[];
  /** Where each editor texture sits in the atlas. */
  places: Placed[];
}

// ---------------------------------------------------------------- atlas
interface Placed { page: number; x: number; y: number }
/** Shelf-pack the textures into pages (≤ 4096 px, or the biggest texture's size up to 8192). */
export function packAtlas(tex: { w: number; h: number }[]): { places: Placed[]; sizes: { w: number; h: number }[] } {
  const big = Math.max(64, ...tex.map((t) => Math.max(t.w, t.h) + PAD * 2));
  const area = tex.reduce((sum, t) => sum + (t.w + PAD * 2) * (t.h + PAD * 2), 0);
  const side = Math.min(8192, Math.max(big, Math.min(4096, nextPow2(Math.sqrt(area) * 1.15))));
  const order = tex.map((t, i) => i).sort((a, b) => tex[b].h - tex[a].h || tex[b].w - tex[a].w);
  const places: Placed[] = new Array(tex.length);
  const sizes: { w: number; h: number }[] = [];
  let page = -1, sx = 0, sy = 0, shelfH = 0;
  const newPage = () => { page++; sizes.push({ w: 0, h: 0 }); sx = 0; sy = 0; shelfH = 0; };
  newPage();
  for (const i of order) {
    const w = tex[i].w + PAD * 2, h = tex[i].h + PAD * 2;
    if (sx + w > side) { sy += shelfH; sx = 0; shelfH = 0; }
    if (sy + h > side) newPage();
    places[i] = { page, x: sx + PAD, y: sy + PAD };
    sx += w; shelfH = Math.max(shelfH, h);
    const s = sizes[page]; s.w = Math.max(s.w, sx); s.h = Math.max(s.h, sy + shelfH);
  }
  for (const s of sizes) { s.w = Math.max(4, Math.ceil(s.w / 4) * 4); s.h = Math.max(4, Math.ceil(s.h / 4) * 4); }
  return { places, sizes };
}
const nextPow2 = (v: number) => Math.pow(2, Math.ceil(Math.log2(Math.max(1, v))));

export function atlasPages(textures: EdTexture[], places: Placed[], sizes: { w: number; h: number }[]): AtlasPage[] {
  const pages = sizes.map((s) => ({ w: s.w, h: s.h, rgba: new Uint8ClampedArray(s.w * s.h * 4) }));
  textures.forEach((t, i) => {
    const p = places[i], pg = pages[p.page];
    for (let y = 0; y < t.h; y++) pg.rgba.set(t.rgba.subarray(y * t.w * 4, (y + 1) * t.w * 4), ((p.y + y) * pg.w + p.x) * 4);
    // edge extrusion: the gutter repeats the nearest border pixel (colour and alpha)
    for (let y = -PAD; y < t.h + PAD; y++) for (let x = -PAD; x < t.w + PAD; x++) {
      if (x >= 0 && x < t.w && y >= 0 && y < t.h) continue;
      const gx = p.x + x, gy = p.y + y;
      if (gx < 0 || gy < 0 || gx >= pg.w || gy >= pg.h) continue;
      const cx = Math.min(t.w - 1, Math.max(0, x)), cy = Math.min(t.h - 1, Math.max(0, y));
      const si = (cy * t.w + cx) * 4, di = (gy * pg.w + gx) * 4;
      pg.rgba[di] = t.rgba[si]; pg.rgba[di + 1] = t.rgba[si + 1]; pg.rgba[di + 2] = t.rgba[si + 2]; pg.rgba[di + 3] = t.rgba[si + 3];
    }
  });
  return pages;
}

// ---------------------------------------------------------------- spaces
// (a rotation's children: canvas px = origin + scale · R(angle) · mirror(local) with its rest `frame`; none = upright, 1)
type Space = { kind: 'root' } | { kind: 'rot'; ox: number; oy: number; c: number; s: number; k: number; fx: number; fy: number } | { kind: 'warp'; x: number; y: number; w: number; h: number };
export function spaceOf(f: EdDeformer | undefined): Space {
  if (!f) return { kind: 'root' };
  if (f.kind === 'rotation') {
    const a = ((f.frame?.angle ?? 0) * Math.PI) / 180, k = f.frame?.scale || 1;
    return { kind: 'rot', ox: f.origin?.[0] ?? 0, oy: f.origin?.[1] ?? 0, c: Math.cos(a), s: Math.sin(a), k, fx: f.reflect?.[0] ? -1 : 1, fy: f.reflect?.[1] ? -1 : 1 };
  }
  const [x, y, w, h] = f.rect ?? [0, 0, 1, 1];
  return { kind: 'warp', x, y, w: w || 1, h: h || 1 };
}
/** canvas-px delta → a rotation's local delta (inverse of its frame) */
const unrot = (s: Extract<Space, { kind: 'rot' }>, dx: number, dy: number): [number, number] => [((s.c * dx + s.s * dy) / s.k) * s.fx, ((-s.s * dx + s.c * dy) / s.k) * s.fy];
export const toPt = (s: Space, x: number, y: number): [number, number] => (s.kind === 'root' ? [x, y] : s.kind === 'rot' ? unrot(s, x - s.ox, y - s.oy) : [(x - s.x) / s.w, (y - s.y) / s.h]);
export const toDelta = (s: Space, dx: number, dy: number): [number, number] => (s.kind === 'warp' ? [dx / s.w, dy / s.h] : s.kind === 'rot' ? unrot(s, dx, dy) : [dx, dy]);
/** The rest frame of the nearest rotation at or above deformer `f` (through warps): identity when none. */
function frameAbove(f: EdDeformer | undefined, byId: Map<string, EdDeformer>): { angle: number; scale: number } {
  for (let d = 0; f && d < 64; d++, f = f.parent ? byId.get(f.parent) : undefined) if (f.kind === 'rotation') return { angle: f.frame?.angle ?? 0, scale: f.frame?.scale || 1 };
  return { angle: 0, scale: 1 };
}

// ---------------------------------------------------------------- grids
interface GridPlan { axes: { param: string; keys: number[] }[]; inGrid: EdForm[]; shapes: EdForm[] }
function planGrid(forms: EdForm[], opacityInGrid: boolean, range: (p: string) => [number, number], allInGrid = false): GridPlan {
  const inGrid: EdForm[] = [], shapes: EdForm[] = [];
  // (an imported form's keys stay exactly as they were: outside them the object is switched off, as in that model)
  const exact = new Set<string>();
  for (const f of forms) {
    if (!f.axes.length && !f.exact) continue;
    const hasO = f.values.some((v) => v && (v.o !== undefined || v.mul || v.scr || v.z !== undefined));
    if (f.shape && !allInGrid && f.axes.length <= 2) { shapes.push(f); continue; }
    if (allInGrid || f.exact || f.axes.length > 1 || (hasO && opacityInGrid)) inGrid.push(f); else shapes.push(f);
    if (f.exact) for (const a of f.axes) exact.add(a.param);
  }
  const keyMap = new Map<string, Set<number>>();
  for (const f of inGrid) for (const a of f.axes) { let s = keyMap.get(a.param); if (!s) keyMap.set(a.param, s = new Set()); for (const k of a.keys) s.add(round6(k)); }
  const axes = [...keyMap].map(([param, ks]) => {
    if (exact.has(param)) return { param, keys: [...ks].sort((a, b) => a - b) };
    const [lo, hi] = range(param);
    ks.add(round6(lo)); ks.add(round6(hi));
    return { param, keys: [...ks].filter((k) => k >= lo - 1e-9 && k <= hi + 1e-9).sort((a, b) => a - b) };
  });
  return { axes, inGrid, shapes };
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const srgbToLinear = (c: number) => { const v = Math.max(0, Math.min(255, c)) / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
/** Parents before children (by `parent` id); cycles broken. */
function sortParents<T extends { id: string; parent: string | null }>(list: T[]): T[] {
  const byId = new Map(list.map((x) => [x.id, x])), out: T[] = [], seen = new Set<string>();
  const visit = (x: T, d: number) => { if (seen.has(x.id) || d > 64) return; const p = x.parent ? byId.get(x.parent) : undefined; if (p) visit(p, d + 1); seen.add(x.id); out.push(x); };
  for (const x of list) visit(x, 0);
  return out;
}

/** Every grid point's parameter values (axis 0 fastest). */
function gridPoints(axes: { param: string; keys: number[] }[]): Map<string, number>[] {
  const n = axes.reduce((s, a) => s * a.keys.length, 1), out: Map<string, number>[] = [];
  for (let k = 0; k < n; k++) {
    let r = k;
    const m = new Map<string, number>();
    for (const a of axes) { m.set(a.param, a.keys[r % a.keys.length]); r = Math.floor(r / a.keys.length); }
    out.push(m);
  }
  return out;
}

/** The sum of forms at one grid point: offsets (+), opacity (×), rotation extras (+). */
function sumAt(forms: EdForm[], at: Map<string, number>, defaults: (p: string) => number, n: number) {
  const d = new Float64Array(n * 2);
  let o = 1, a = 0, ox = 0, oy = 0, s = 0, z = 0, col = false;
  const mul = [1, 1, 1], scr = [0, 0, 0];
  for (const f of forms) {
    const v = sampleForm(f, (p) => at.get(p) ?? defaults(p), n);
    if (!v) continue;
    if (v.d) for (let k = 0; k < n * 2 && k < v.d.length; k++) d[k] += v.d[k];
    if (v.o !== undefined) o *= v.o;
    a += v.a ?? 0; ox += v.ox ?? 0; oy += v.oy ?? 0; s += v.s ?? 0; z += v.z ?? 0;
    if (v.mul) { col = true; for (let k = 0; k < 3; k++) mul[k] *= v.mul[k]; }
    if (v.scr) { col = true; for (let k = 0; k < 3; k++) scr[k] = scr[k] + v.scr[k] - scr[k] * v.scr[k]; }
  }
  return { d, o, a, ox, oy, s, z, col, mul, scr };
}

// ---------------------------------------------------------------- build
export function buildRig(doc: EdDoc, textures: EdTexture[], atlas?: { places: Placed[]; pages: AtlasPage[] }, maps?: LightMaps | null): BuiltRig {
  const paramIdx = new Map(doc.params.map((p, i) => [p.id, i]));
  const range = (id: string): [number, number] => { const p = doc.params.find((q) => q.id === id); return p ? [p.min, p.max] : [0, 0]; };
  const defaults = (id: string) => doc.params.find((q) => q.id === id)?.def ?? 0;
  const bb = new BufferBuilder(0);
  const grids: Rig2DDoc['grids'] = [];
  const gridKey = new Map<string, number>();
  const gridOf = (axes: { param: string; keys: number[] }[]) => {
    const g = { axes: axes.filter((a) => paramIdx.has(a.param)).map((a) => ({ param: paramIdx.get(a.param)!, keys: a.keys })) };
    const k = JSON.stringify(g);
    let i = gridKey.get(k);
    if (i === undefined) { i = grids.length; grids.push(g); gridKey.set(k, i); }
    return i;
  };
  const defIdx = new Map(doc.deformers.map((f, i) => [f.id, i]));
  const defById = new Map(doc.deformers.map((f) => [f.id, f]));
  const meshIdx = new Map(doc.meshes.map((m, i) => [m.id, i]));
  const blendShapes: NonNullable<Rig2DDoc['blendShapes']> = [];

  // atlas
  let places: Placed[], pages: AtlasPage[];
  if (atlas) ({ places, pages } = atlas);
  else { const pk = packAtlas(textures); places = pk.places; pages = atlasPages(textures, pk.places, pk.sizes); }

  // deformers
  const deformers: Rig2DDoc['deformers'] = doc.deformers.map((f, fi) => {
    const parent = f.parent ? defById.get(f.parent) : undefined;
    const ps = spaceOf(parent);
    const plan = planGrid(f.forms, f.kind === 'warp', range);
    const pts = gridPoints(plan.axes);
    const grid = gridOf(plan.axes);
    const base = { id: f.id, name: f.name, kind: f.kind, parent: f.parent && defIdx.has(f.parent) ? defIdx.get(f.parent)! : -1, part: -1, grid, enabled: true, visible: true };
    // colours per keyform (imported rigs), only when some keyform has them
    const colors: { mul: number[]; scr: number[] } = { mul: [], scr: [] };
    let anyCol = false;
    const colorOf = (v: ReturnType<typeof sumAt>) => { if (v.col) anyCol = true; colors.mul.push(...v.mul); colors.scr.push(...v.scr); };
    const colorField = () => (anyCol ? { color: { multiply: bb.f32(colors.mul), screen: bb.f32(colors.scr) } } : {});
    if (f.kind === 'rotation') {
      const o = f.origin ?? [0, 0];
      // keyforms relative to the nearest rotation above (its children's frame): angle and scale of this rest frame
      const own = { angle: f.frame?.angle ?? 0, scale: f.frame?.scale || 1 }, up = frameAbove(parent, defById);
      const dA = own.angle - up.angle, kS = own.scale / up.scale;
      const rx = !!f.reflect?.[0], ry = !!f.reflect?.[1];
      const r = { baseAngle: 0, angle: [] as number[], originX: [] as number[], originY: [] as number[], scale: [] as number[], reflectX: [] as boolean[], reflectY: [] as boolean[] };
      const opacity: number[] = [];
      for (const at of pts) {
        const v = sumAt(plan.inGrid, at, defaults, 0);
        const [x, y] = toPt(ps, o[0] + v.ox, o[1] + v.oy);
        r.angle.push(dA + v.a); r.originX.push(x); r.originY.push(y); r.scale.push(kS * (1 + v.s)); r.reflectX.push(rx); r.reflectY.push(ry); opacity.push(v.o);
        colorOf(v);
      }
      for (const s of plan.shapes) {
        const ax = s.axes[0], ax2 = s.axes[1];
        if (!paramIdx.has(ax.param) || (ax2 && !paramIdx.has(ax2.param))) continue;
        const nk = ax.keys.length * (ax2?.keys.length ?? 1);
        const vals = Array.from({ length: nk }, (_, k) => s.values[k]);
        const g = (fn: (v: EdValue) => number) => vals.map((v) => (v ? fn(v) : 0));
        const oxy = vals.map((v) => toDelta(ps, v?.ox ?? 0, v?.oy ?? 0));
        blendShapes.push({ target: { kind: 'rotation', index: fi }, ...shapeAxes(s), values: { angle: g((v) => v.a ?? 0), originX: oxy.map((q) => q[0]), originY: oxy.map((q) => q[1]), scale: g((v) => kS * (v.s ?? 0)) } });
      }
      return { ...base, opacity, rotation: r, ...colorField() };
    }
    const cols = f.cols ?? 1, rows = f.rows ?? 1, np = (cols + 1) * (rows + 1);
    const [rx, ry, rw, rh] = f.rect ?? [0, 0, 1, 1];
    const rest: number[] = [];
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) rest.push(rx + (rw * i) / cols, ry + (rh * j) / rows);
    const all: number[] = [], opacity: number[] = [];
    for (const at of pts) {
      const v = sumAt(plan.inGrid, at, defaults, np);
      for (let k = 0; k < np; k++) { const [x, y] = toPt(ps, rest[k * 2] + v.d[k * 2], rest[k * 2 + 1] + v.d[k * 2 + 1]); all.push(x, y); }
      opacity.push(v.o);
      colorOf(v);
    }
    for (const s of plan.shapes) shapeOffsets(s, np, ps, { kind: 'warp', index: fi });
    return { ...base, opacity, warp: { rows, cols, quad: f.quad !== false, points: bb.f32(all) }, ...colorField() };
  });

  /** A blend shape's parameter(s), keys and (imported) weight limits. */
  function shapeAxes(s: EdForm) {
    const ax = s.axes[0], ax2 = s.axes[1];
    const cons = (s.constraints ?? []).filter((c) => paramIdx.has(c.param) && c.keys.length === c.weights.length && c.keys.length > 0)
      .map((c) => ({ param: paramIdx.get(c.param)!, keys: c.keys.slice(), weights: c.weights.slice() }));
    return { param: paramIdx.get(ax.param)!, keys: ax.keys.slice(), ...(ax2 ? { param2: paramIdx.get(ax2.param)!, keys2: ax2.keys.slice() } : {}), ...(cons.length ? { constraints: cons } : {}) };
  }
  function shapeOffsets(s: EdForm, np: number, ps: Space, target: { kind: 'mesh' | 'warp'; index: number }) {
    const ax = s.axes[0], ax2 = s.axes[1];
    if (!paramIdx.has(ax.param) || (ax2 && !paramIdx.has(ax2.param))) return;
    const nk = ax.keys.length * (ax2?.keys.length ?? 1);
    const off: number[] = [];
    let any = false;
    for (let k = 0; k < nk; k++) {
      const v = s.values[k];
      for (let i = 0; i < np; i++) {
        const dx = v?.d?.[i * 2] ?? 0, dy = v?.d?.[i * 2 + 1] ?? 0;
        if (dx || dy) any = true;
        const [a, b] = toDelta(ps, dx, dy);
        off.push(a, b);
      }
    }
    if (any) blendShapes.push({ target, ...shapeAxes(s), offsets: bb.f32(off) });
  }

  // parts (the art's folders), parents first
  const X = doc.extras ?? {};
  const edParts = sortParents(X.parts ?? []);
  const partIdx = new Map(edParts.map((p, i) => [p.id, i]));
  const parts: Rig2DDoc['parts'] = edParts.map((p) => ({ id: p.id, name: p.name, parent: p.parent && partIdx.has(p.parent) ? partIdx.get(p.parent)! : -1, grid: gridOf([]), drawOrder: [500], visible: true, enabled: true }));

  // bones, parents first; editor rest space (canvas px) -> root: its deformer's coordinates, child: the parent's frame
  const edBones = sortParents(X.bones ?? []);
  const boneIdx = new Map(edBones.map((b, i) => [b.id, i]));
  const bones: NonNullable<Rig2DDoc['bones']> = edBones.map((b) => {
    const parent = b.parent ? edBones.find((x) => x.id === b.parent) : undefined;
    let x: number, y: number, angle: number;
    if (parent) {
      const a = (-parent.angle * Math.PI) / 180, dx = b.x - parent.x, dy = b.y - parent.y;
      x = Math.cos(a) * dx - Math.sin(a) * dy; y = Math.sin(a) * dx + Math.cos(a) * dy; angle = b.angle - parent.angle;
    } else {
      [x, y] = toPt(spaceOf(b.deformer ? defById.get(b.deformer) : undefined), b.x, b.y); angle = b.angle;
    }
    const plan = planGrid(b.forms, true, range, true); // bones have no blend shapes: every form goes in the grid
    const kf = { angle: [] as number[], x: [] as number[], y: [] as number[], scaleX: [] as number[], scaleY: [] as number[] };
    for (const at of gridPoints(plan.axes)) { const v = sumAt(b.forms, at, defaults, 0); kf.angle.push(v.a); kf.x.push(v.ox); kf.y.push(v.oy); kf.scaleX.push(1 + v.s); kf.scaleY.push(1 + v.s); }
    return { id: b.id, name: b.name, parent: parent ? boneIdx.get(parent.id)! : -1, ...(!parent && b.deformer && defIdx.has(b.deformer) ? { deformer: defIdx.get(b.deformer)! } : {}),
      x, y, angle, length: b.length, grid: gridOf(plan.axes), keyforms: kf };
  });
  const skinOf = (m: EdMesh, n: number): { skin?: NonNullable<Rig2DDoc['meshes'][number]['skin']> } => {
    if (!m.skin || !bones.length) return {};
    const ids = Object.keys(m.skin).filter((id) => boneIdx.has(id));
    if (!ids.length) return {};
    const J = new Uint16Array(n * 4), W = new Float32Array(n * 4);
    let any = false;
    for (let i = 0; i < n; i++) {
      const ws = ids.map((id) => [boneIdx.get(id)!, m.skin![id][i] ?? 0] as const).filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = ws.reduce((t, [, w]) => t + w, 0);
      ws.forEach(([j, w], k) => { J[i * 4 + k] = j; W[i * 4 + k] = sum > 0 ? w / sum : 0; });
      if (sum > 0) any = true;
    }
    return any ? { skin: { joints: bb.add(J, 'u16'), weights: bb.add(W, 'f32') } } : {};
  };

  // meshes
  const meshes: Rig2DDoc['meshes'] = doc.meshes.map((m, mi) => {
    const def = m.deformer ? defById.get(m.deformer) : undefined;
    const ps = spaceOf(def);
    const n = m.mesh.pos.length / 2;
    const plan = planGrid(m.forms, true, range);
    const pts = gridPoints(plan.axes);
    const all: number[] = [], opacity: number[] = [], drawOrder: number[] = [], mul: number[] = [], scr: number[] = [];
    let anyCol = false;
    for (const at of pts) {
      const v = sumAt(plan.inGrid, at, defaults, n);
      for (let k = 0; k < n; k++) { const [x, y] = toPt(ps, m.mesh.pos[k * 2] + v.d[k * 2], m.mesh.pos[k * 2 + 1] + v.d[k * 2 + 1]); all.push(x, y); }
      opacity.push(Math.max(0, Math.min(1, m.opacity * v.o)));
      drawOrder.push(m.z + v.z);
      if (v.col) anyCol = true;
      mul.push(...v.mul); scr.push(...v.scr);
    }
    for (const s of plan.shapes) shapeOffsets(s, n, ps, { kind: 'mesh', index: mi });
    // uvs into the atlas page
    const pl = places[m.tex], pg = pages[pl.page], t = doc.textures[m.tex];
    const uvs: number[] = [];
    for (let k = 0; k < n; k++) uvs.push((pl.x + m.mesh.uv[k * 2] * t.w) / pg.w, (pl.y + m.mesh.uv[k * 2 + 1] * t.h) / pg.h);
    const idx = n > 65535 ? Uint32Array.from(m.mesh.tri) : Uint16Array.from(m.mesh.tri);
    return {
      id: m.id, name: m.name, part: m.part && partIdx.has(m.part) ? partIdx.get(m.part)! : -1, deformer: m.deformer && defIdx.has(m.deformer) ? defIdx.get(m.deformer)! : -1, texture: pl.page, grid: gridOf(plan.axes),
      vertexCount: n, uvs: bb.f32(uvs), indices: bb.add(idx, n > 65535 ? 'u32' : 'u16'), positions: bb.f32(all), opacity, drawOrder,
      blend: m.blend, doubleSided: !m.culled, masks: m.masks.filter((id) => meshIdx.has(id) && id !== m.id).map((id) => meshIdx.get(id)!), ...(m.maskInvert ? { maskInvert: true } : {}),
      visible: m.visible, enabled: true,
      ...(m.outline && m.outline.width > 0 ? { outline: { width: m.outline.width, color: m.outline.color.map(srgbToLinear) as [number, number, number], ...(m.outline.opacity !== undefined && m.outline.opacity < 1 ? { opacity: m.outline.opacity } : {}), ...(m.outline.light ? { lightResponsive: true } : {}) } } : {}),
      ...(skinOf(m, n)),
      ...(anyCol ? { color: { multiply: bb.f32(mul), screen: bb.f32(scr) } } : {}),
      ...(doc.imported?.depth?.meshes[m.id] ? { depth: doc.imported.depth.meshes[m.id] } : {}),
    };
  });

  const bind: Record<string, string> = {};
  for (const [role, pid] of Object.entries(STD_BIND)) if (paramIdx.has(pid)) bind[role] = pid;
  const I = doc.imported;
  // an imported model keeps its own roles (its own blink / lip-sync groups and tracking bindings, or none: the runtime's
  // automatic mapping, as before)
  const roles: Rig2DDoc['roles'] = I?.roles ? {
    eyeBlink: I.roles.eyeBlink.filter((p) => paramIdx.has(p)), lipSync: I.roles.lipSync.filter((p) => paramIdx.has(p)),
    ...(I.roles.bind ? (() => { const b = Object.fromEntries(Object.entries(I.roles.bind).filter(([, v]) => v && paramIdx.has(typeof v === 'string' ? v : v.param))); return Object.keys(b).length ? { bind: b as Rig2DDoc['roles']['bind'] } : {}; })() : {}),
  } : {
    eyeBlink: ['ParamEyeLOpen', 'ParamEyeROpen'].filter((p) => paramIdx.has(p)),
    lipSync: paramIdx.has('ParamMouthOpenY') ? ['ParamMouthOpenY'] : [],
    ...(Object.keys(bind).length ? { bind: bind as Rig2DDoc['roles']['bind'] } : {}),
  };
  // imported glue (both meshes still with the same points)
  const glue: NonNullable<Rig2DDoc['glue']> = [];
  for (const g of I?.glue ?? []) {
    const a = meshIdx.get(g.a), b = meshIdx.get(g.b);
    if (a === undefined || b === undefined || doc.meshes[a].mesh.pos.length !== g.na * 2 || doc.meshes[b].mesh.pos.length !== g.nb * 2 || !g.axes.every((x) => paramIdx.has(x.param))) continue;
    if (g.intensity.length !== g.axes.reduce((t, x) => t * x.keys.length, 1)) continue;
    glue.push({ id: g.id, ...(g.name ? { name: g.name } : {}), a, b, grid: gridOf(g.axes), intensity: g.intensity.slice(), pairs: bb.add(Int32Array.from(g.pairs), 'i32'), weights: bb.f32(g.weights) });
  }
  const buf = bb.bytes();
  const out: Rig2DDoc = {
    magic: RIG2D.magic, version: RIG2D.version,
    meta: { name: doc.name.slice(0, 256), ...(doc.meta.authors ? { authors: doc.meta.authors } : {}), ...(doc.meta.license ? { license: doc.meta.license } : {}), ...(doc.meta.notes ? { notes: doc.meta.notes } : {}),
      ...(I?.licenseUrl ? { licenseUrl: I.licenseUrl } : {}), ...(I?.rights ? { rights: I.rights } : {}),
      // (an imported model keeps the name of the file it came from: wasLive2D, the Live2D sample-model notes)
      source: { kind: 'native', converter: 'VTube Pro rig editor', ...(I?.file ? { file: I.file.slice(0, 256) } : {}) } },
    canvas: { width: doc.canvas.w, height: doc.canvas.h },
    buffers: [{ file: 'buffers/0.bin', byteLength: buf.length }],
    textures: pages.map((p, i) => ({ file: `textures/${i}.png`, width: p.w, height: p.h, filter: 'linear' as const })),
    params: doc.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, default: p.def, ...(p.group ? { group: p.group } : {}),
      ...(p.repeat ? { repeat: true } : {}), ...(p.kind === 'blend' ? { kind: 'blend' as const } : {}), ...(p.decimals !== undefined ? { decimals: p.decimals } : {}) })),
    grids, parts: [], deformers, meshes,
    ...(blendShapes.length ? { blendShapes } : {}),
    ...(glue.length ? { glue } : {}),
    roles,
    physics: doc.physics.filter((p) => paramIdx.has(p.output)).map((p): NonNullable<Rig2DDoc['physics']>[number] => ({
      id: p.id, name: p.name,
      inputs: p.inputs.filter((i) => paramIdx.has(i.param)).map((i) => ({ param: i.param, weight: Math.abs(i.weight) * 100, type: i.type, reflect: i.weight < 0 })),
      outputs: [{ param: p.output, particle: 1, scale: 1.2 * p.gain, weight: 100, type: 'angle' as const, reflect: false }],
      particles: [{ x: 0, y: 0, mobility: 1, delay: 1, acceleration: 1, radius: 0 }, { x: 0, y: 10, mobility: 0.95 - 0.2 * p.damping, delay: 0.9 - 0.3 * p.damping, acceleration: 1 + p.length / 1000, radius: 10 }],
      normalize: { position: [-10, 0, 10] as [number, number, number], angle: [-10, 0, 10] as [number, number, number] },
    })).filter((p) => p.inputs.length).concat((I?.physics ?? []).map((p) => ({ ...p, inputs: p.inputs.filter((x) => paramIdx.has(x.param)), outputs: p.outputs.filter((x) => paramIdx.has(x.param) && x.particle < p.particles.length) }))
      .filter((p) => p.inputs.length && p.outputs.length && p.particles.length >= 2)),
    physicsWorld: I?.physicsWorld ?? { gravity: [0, -1], wind: [0, 0], fps: 60 },
    expressions: doc.expressions.map((e) => ({ id: e.id, name: e.name, fadeIn: e.fadeIn ?? 0.25, fadeOut: e.fadeOut ?? 0.25, params: e.params.filter((x) => paramIdx.has(x.param)), ...(e.key ? { key: e.key } : {}) })),
  };
  if (!out.physics?.length) delete out.physics;
  // the mouth shapes (A I U E O): bound through `extra.vowelBind`, a field every older build already accepts and ignores
  // (roles.bind is a closed list: a new role name there would make an older build refuse the whole file)
  const vowelBind = Object.fromEntries(Object.entries(VOWEL_BIND).filter(([, pid]) => paramIdx.has(pid)));
  if (!I && Object.keys(vowelBind).length === Object.keys(VOWEL_BIND).length) out.extra = { ...(out.extra ?? {}), vowelBind };
  // ---- beyond Live2D
  if (parts.length) out.parts = parts;
  if (bones.length) out.bones = bones;
  const slotOf = (sl: EdSlot) => {
    if (sl.mesh && meshIdx.has(sl.mesh)) return { mesh: sl.mesh, vertex: sl.vertex ?? 0, ...(sl.vertex2 !== undefined ? { vertex2: sl.vertex2 } : {}) };
    if (sl.bone && boneIdx.has(sl.bone)) return { bone: sl.bone, ...(sl.x !== undefined ? { x: sl.x } : {}), ...(sl.y !== undefined ? { y: sl.y } : {}) };
    const f = sl.deformer ? defById.get(sl.deformer) : undefined;
    if (f) { const [x, y] = toPt(spaceOf(f), sl.x ?? 0, sl.y ?? 0); return { deformer: f.id, x, y }; }
    return null;
  };
  const rectOf = (tex: number): [number, number, number, number] => { const pl = places[tex], pg = pages[pl.page], t = doc.textures[tex]; return [pl.x / pg.w, pl.y / pg.h, t.w / pg.w, t.h / pg.h]; };
  const drawOf = (d?: EdDrawAt) => (d?.above && meshIdx.has(d.above) ? { draw: { above: d.above } } : d?.at ? { draw: { at: d.at } } : {});
  const atts = (X.attachments ?? []).filter((a) => places[a.tex]).map((a) => ({ a, slot: slotOf(a.slot) })).filter((x) => x.slot);
  if (atts.length) out.attachments = atts.map(({ a, slot }) => ({ id: a.id, name: a.name, slot: slot!, texture: places[a.tex].page, rect: rectOf(a.tex), pivot: a.pivot, size: a.size,
    ...(a.angle ? { angle: a.angle } : {}), on: a.on, ...drawOf(a.draw), ...(a.blend && a.blend !== 'normal' ? { blend: a.blend } : {}), ...(a.rotate === false ? { rotate: false } : {}) }));
  const ptc = (X.particles ?? []).filter((p) => p.on !== false && places[p.tex]).map((p) => ({ p, slot: slotOf(p.slot) })).filter((x) => x.slot);
  if (ptc.length) out.particles = ptc.map(({ p, slot }) => ({ id: p.id, name: p.name, slot: slot!, texture: places[p.tex].page, rect: rectOf(p.tex), rate: p.rate, life: p.life, speed: p.speed,
    ...(p.angle !== undefined ? { angle: p.angle } : {}), spread: p.spread, gravity: p.gravity, size: p.size, ...(p.spin ? { spin: p.spin } : {}), ...(p.fade !== undefined ? { fade: p.fade } : {}),
    ...(p.max ? { max: p.max } : {}), ...(p.blend && p.blend !== 'normal' ? { blend: p.blend } : {}), ...drawOf(p.draw), trigger: p.trigger }));
  // (an imported model's pendulums: their anchor deformer and outputs still there; a follow-through: the meshes that still exist)
  const pend = (I?.dynamics ?? []).filter((y) => y.kind === 'pendulum' && !!y.deformer && defIdx.has(y.deformer) && !!y.output && paramIdx.has(y.output) && (!y.output2 || paramIdx.has(y.output2)));
  const dyn = (X.dynamics ?? []).filter((y) => (y.kind === 'chain' ? (y.bones ?? []).every((b) => boneIdx.has(b)) && (y.bones?.length ?? 0) > 0 : y.kind === 'follow' ? (y.meshes ?? []).some((m) => meshIdx.has(m)) : !!y.output && paramIdx.has(y.output)));
  if (dyn.length || pend.length) out.dynamics = [...dyn.map((y) => { const { auto: _a, amount, ...rest } = y; void _a; return { ...rest, ...(y.kind === 'follow' ? { meshes: (y.meshes ?? []).filter((m) => meshIdx.has(m)) } : {}), ...(amount && paramIdx.has(amount) ? { amount } : {}) }; }), ...pend.map((y) => ({ ...y }))];
  if (I) {
    const mb = (I.materialBindings ?? []).filter((c) => defIdx.has(c.deformer)).map((c) => ({ deformer: defIdx.get(c.deformer)!, opacity: c.opacity, multiply: c.multiply, screen: c.screen,
      bindings: c.bindings.filter((b) => paramIdx.has(b.param) && (b.param2 === undefined || paramIdx.has(b.param2))).map((b) => ({ channel: b.channel, param: paramIdx.get(b.param)!, keys: b.keys.slice(),
        ...(b.param2 !== undefined ? { param2: paramIdx.get(b.param2)!, keys2: (b.keys2 ?? []).slice() } : {}), values: b.values.slice() })) }));
    if (mb.length) out.materialBindings = mb;
    const partIds = new Set(parts.map((p) => p.id));
    const sw = (I.switches ?? []).map((g) => ({ fade: g.fade, members: g.members.filter((m) => partIds.has(m.part)).map((m) => ({ part: m.part, links: m.links.filter((l) => partIds.has(l)) })) })).filter((g) => g.members.length);
    if (sw.length) out.switches = sw;
    const hit = (I.hitAreas ?? []).filter((h) => meshIdx.has(h.mesh));
    if (hit.length) out.hitAreas = hit;
    if (I.extra && Object.keys(I.extra).length) out.extra = { ...I.extra };
    if (I.depth && out.meshes.some((m) => m.depth)) out.depth = { ...(I.depth.yaw && paramIdx.has(I.depth.yaw) ? { yaw: I.depth.yaw } : {}), ...(I.depth.pitch && paramIdx.has(I.depth.pitch) ? { pitch: I.depth.pitch } : {}), strength: I.depth.strength };
  }
  const attIds = new Set((out.attachments ?? []).map((a) => a.id));
  const cos = (X.costumes ?? []).map((c) => ({ id: c.id, name: c.name, parts: c.parts.filter((p) => partIdx.has(p)), ...(c.attachments?.length ? { attachments: c.attachments.filter((a) => attIds.has(a)) } : {}), ...(c.group ? { group: c.group } : {}), on: c.on }))
    // (an imported model's empty outfit in a group is its "none of these" choice: kept)
    .filter((c) => c.parts.length || c.attachments?.length || (!!I && !!c.group));
  if (cos.length) out.layers = cos;
  if (X.views && X.views.sets.length >= 2) out.views = { by: X.views.by, sets: X.views.sets.map((v) => ({ id: v.id, at: v.at, parts: v.parts.filter((p) => partIdx.has(p)) })),
    ...(X.views.blendBand !== undefined ? { blendBand: X.views.blendBand } : {}), ...(X.views.hysteresis !== undefined ? { hysteresis: X.views.hysteresis } : {}) };
  const expIds = new Set(doc.expressions.map((e) => e.id));
  const st = (X.states ?? []).map((L) => ({ ...L, states: L.states.map((x) => ({ id: x.id, ...(x.expression && expIds.has(x.expression) ? { expression: x.expression } : {}) })) }));
  if (st.length) out.states = { layers: st };
  if (X.lighting?.maps && maps) {
    out.textures = out.textures.map((t, i) => ({ ...t, normal: `textures/${i}_normal.png`, rim: `textures/${i}_rim.png`, ...(maps.emission ? { emission: `textures/${i}_emission.png` } : {}) }));
    out.lighting = { tint: X.lighting.tint, strength: X.lighting.strength, rim: { width: X.lighting.rim.width, strength: X.lighting.rim.strength } };
  }
  // (follow-throughs go to extra.follow, where an older build ignores them: format.ts FOLLOW_EXTRA_KEY)
  const stored = rig2dForStorage(out);
  const v = validateRig2D(stored, [buf.length]);
  return { doc: stored, buffers: [buf], pages, issues: v.ok ? [] : v.issues, places };
}

// ---------------------------------------------------------------- the editor project inside the archive
interface ProjectFile { editor: 'vtp-rig-editor'; version: 1; doc: EdDoc; textures: { page: number; x: number; y: number }[] }

/** Archive bytes: the runtime rig + atlas PNGs + the editor project. `encodePng` turns RGBA into PNG bytes. */
export async function packRig(doc: EdDoc, textures: EdTexture[], encodePng: (w: number, h: number, rgba: Uint8ClampedArray) => Uint8Array | Promise<Uint8Array>, thumb?: Uint8Array): Promise<{ bytes: Uint8Array; issues: Rig2DIssue[] }> {
  const pk = packAtlas(textures);
  const pages = atlasPages(textures, pk.places, pk.sizes);
  const maps = doc.extras?.lighting?.maps ? buildMaps(doc, textures, pk.places, pk.sizes) : null;
  const built = buildRig(doc, textures, { places: pk.places, pages }, maps);
  if (built.issues.length) return { bytes: new Uint8Array(0), issues: built.issues };
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < pages.length; i++) {
    files.set(`textures/${i}.png`, await encodePng(pages[i].w, pages[i].h, pages[i].rgba));
    if (maps) {
      files.set(`textures/${i}_normal.png`, await encodePng(maps.normal[i].w, maps.normal[i].h, maps.normal[i].rgba));
      files.set(`textures/${i}_rim.png`, await encodePng(maps.rim[i].w, maps.rim[i].h, maps.rim[i].rgba));
      if (maps.emission) files.set(`textures/${i}_emission.png`, await encodePng(maps.emission[i].w, maps.emission[i].h, maps.emission[i].rgba));
    }
  }
  if (thumb) files.set('thumb.png', thumb);
  const proj: ProjectFile = { editor: 'vtp-rig-editor', version: 1, doc: compactDoc(doc), textures: pk.places.map((p) => ({ page: p.page, x: p.x, y: p.y })) };
  files.set(PROJECT_ENTRY, new TextEncoder().encode(JSON.stringify(proj)));
  return { bytes: writeVtp2({ doc: built.doc, buffers: built.buffers, files }), issues: [] };
}

/** Numbers rounded (1/1000 px) so the project stays small. */
function compactDoc(d: EdDoc): EdDoc {
  // (an imported model keeps 6 significant digits below 1: its keys, scales and colours are not canvas px)
  const fine = !!d.imported;
  return JSON.parse(JSON.stringify(d, (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? (fine && Math.abs(v) < 1 ? Number(v.toPrecision(6)) : Math.round(v * 1000) / 1000) : v)));
}

/** A PNG decoder: `scale` < 1 = decode straight to that fraction of the picture's size (both sides, rounded). */
export type DecodePng = (png: Uint8Array, scale?: number) => Promise<{ w: number; h: number; rgba: Uint8ClampedArray }>;
/** The most decoded picture memory an imported model may take while it opens in the maker (all its pages together). */
export const EDIT_DECODE_BUDGET = 256 << 20;
/** The one scale (≤ 1) at which an imported model's texture pages are decoded for editing: within this device's decode
 *  budget (shared/rig2d/limits.ts, as the live avatar) and at most EDIT_DECODE_BUDGET. The maker runs in the studio's
 *  tab, the one that tracks the face for OBS: a 16K model must never take gigabytes there (a 16384² page opens at 50 %). */
export function editDecodeScale(pages: readonly { width: number; height: number }[]): number {
  return rig2dDecodeScale(pages, Math.min(rig2dDecodeBudget(), EDIT_DECODE_BUDGET));
}

/** Open an archive written by packRig: the editor project + its textures (cut back out of the atlas pages). */
/** An imported model (no editor project inside) comes back adopted (adopt.ts): `adopted` is set and `notes` says, in
 *  plain sentences, what could not come over exactly; `unread` = texture pages its parts use that could not be decoded
 *  (those parts are blank: never to be saved over the avatar). */
export async function openRig(bytes: Uint8Array, decodePng: DecodePng, inflateRaw?: InflateRaw): Promise<{ ok: true; doc: EdDoc; textures: EdTexture[]; adopted?: boolean; notes?: string[]; unread?: number } | { ok: false; error: string }> {
  try {
    if (!isVtp2(bytes)) return { ok: false, error: `Not a ${RIG2D.name} file (${RIG2D.ext}).` };
    const entries = zipEntries(bytes);
    const pe = entries.find((e) => e.name === PROJECT_ENTRY);
    if (!pe) return await openImported(bytes, decodePng, inflateRaw);
    const proj = JSON.parse(new TextDecoder().decode(await zipRead(bytes, pe, inflateRaw, 256 << 20))) as ProjectFile;
    if (proj?.editor !== 'vtp-rig-editor' || !proj.doc || !Array.isArray(proj.textures)) return { ok: false, error: 'The editor project inside the file is damaged.' };
    const doc = proj.doc;
    if (!Array.isArray(doc.meshes) || !Array.isArray(doc.textures) || doc.textures.length !== proj.textures.length) return { ok: false, error: 'The editor project inside the file is damaged.' };
    const pages = new Map<number, { w: number; h: number; rgba: Uint8ClampedArray }>();
    const textures: EdTexture[] = [];
    for (let i = 0; i < doc.textures.length; i++) {
      const t = doc.textures[i], pl = proj.textures[i];
      let pg = pages.get(pl.page);
      if (!pg) {
        const e = entries.find((x) => x.name === `textures/${pl.page}.png`);
        if (!e) return { ok: false, error: `Texture page ${pl.page} is missing.` };
        pg = await decodePng(await zipRead(bytes, e, inflateRaw, 64 << 20));
        pages.set(pl.page, pg);
      }
      if (pl.x < 0 || pl.y < 0 || pl.x + t.w > pg.w || pl.y + t.h > pg.h) return { ok: false, error: 'A texture lies outside its page.' };
      const rgba = new Uint8ClampedArray(t.w * t.h * 4);
      for (let y = 0; y < t.h; y++) rgba.set(pg.rgba.subarray(((pl.y + y) * pg.w + pl.x) * 4, ((pl.y + y) * pg.w + pl.x + t.w) * 4), y * t.w * 4);
      textures.push({ w: t.w, h: t.h, rgba });
    }
    return { ok: true, doc, textures };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A rig made elsewhere (an imported model): read it, decode its texture pages and adopt it as an editor document. */
async function openImported(bytes: Uint8Array, decodePng: DecodePng, inflateRaw?: InflateRaw): Promise<{ ok: true; doc: EdDoc; textures: EdTexture[]; adopted: true; notes: string[]; unread?: number } | { ok: false; error: string }> {
  const r = await readVtp2(bytes, inflateRaw);
  if (!r.ok) return { ok: false, error: r.error };
  const { doc: src, buffers, files } = r.pkg;
  // (its author doesn't allow changes: never opened for editing, like "Make a 3D version")
  if (rigNoChanges(src.meta)) return { ok: false, error: RIG_NO_CHANGES };
  // every page at one scale, within the budget (UVs are relative to their page and positions are model px, so a page
  // scaled evenly cuts out the same parts, a little softer)
  const k = editDecodeScale(src.textures);
  const used = new Set([...src.meshes.map((m) => m.texture), ...(src.attachments ?? []).map((x) => x.texture), ...(src.particles ?? []).map((x) => x.texture)]);
  const pages: (AdoptPage | null)[] = [];
  let unread = 0;
  for (const [i, t] of src.textures.entries()) {
    const png = files.get(t.file);
    let pg: AdoptPage | null = null;
    if (png) { try { pg = await decodePng(png, k); } catch { pg = null; } }
    const good = !!pg && pg.w > 0 && pg.h > 0 && pg.rgba.length >= pg.w * pg.h * 4;
    pages.push(good ? pg : null);
    if (!good && used.has(i)) unread++;
  }
  const a = adoptRig(src, buffers, pages);
  // (the same list as doc.imported.notes: the Check tab shows it too)
  if (k < 1) a.notes.push(`This model's pictures are very large, so they opened at ${Math.round(k * 100)} % of their size to keep your studio running smoothly. Saving keeps them at that size.`);
  return { ok: true, doc: a.doc, textures: a.textures, adopted: true, notes: a.notes, ...(unread ? { unread } : {}) };
}

/** Keyform count of each target's grid (for the UI's "too heavy" hint). */
export const formSize = (f: EdForm) => gridSize(f);
export type { EdMesh };
