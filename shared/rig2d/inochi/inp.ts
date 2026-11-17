// Inochi2D puppets (.inp / .inx): our own reader + evaluator, written from the public INP specification
// (https://docs.inochi2d.com/en/latest/spec/inp/index.html) and the BSD-2-Clause reference implementations
// (Inochi2D, inox2d: Copyright (c) 2020-2023 Inochi2D Project; notice in THIRD_PARTY_NOTICES.md). No code was copied;
// the JSON key names and the evaluation rules (parameter → binding interpolation, transform offsets, z-sort, masks)
// follow those sources so puppets made in Inochi Creator behave the same.
//
// Container (all integers BIG-endian):  "TRNSRTS\0" | u32 jsonLength | json | "TEX_SECT" | u32 count |
//   count × (u32 length | u8 encoding (0 PNG, 1 TGA, 2 BC7) | bytes) | optional "EXT_SECT" | u32 count |
//   count × (u32 nameLength | name | u32 length | bytes)
// Pure (no DOM): parsing + evaluation are unit-tested in node (tools/rig2d_unit.ts); src/avatar/flat/rig2d/inochiSource.ts
// decodes the textures and draws.

export const INP_MAGIC = 'TRNSRTS\0';
export const TEX_MAGIC = 'TEX_SECT';
export const EXT_MAGIC = 'EXT_SECT';
export const INP_LIMITS = { json: 64 << 20, textures: 256, texture: 128 << 20, nodes: 20000, verts: 2_000_000, params: 2048, ext: 64 };

export type InochiBlend = 'Normal' | 'Multiply' | 'ColorDodge' | 'LinearDodge' | 'Screen' | 'ClipToLower' | 'SliceFromLower';
const BLENDS: readonly InochiBlend[] = ['Normal', 'Multiply', 'ColorDodge', 'LinearDodge', 'Screen', 'ClipToLower', 'SliceFromLower'];

export interface InochiMesh { verts: Float32Array; uvs: Float32Array; indices: Uint32Array; origin: [number, number] }
export interface InochiNode {
  uuid: number;
  name: string;
  type: string;
  enabled: boolean;
  zsort: number;
  trans: [number, number, number];
  rot: [number, number, number];
  scale: [number, number];
  lockToRoot: boolean;
  children: InochiNode[];
  // drawables (Part, Mask, Composite)
  mesh?: InochiMesh;
  textures?: number[];
  blend?: InochiBlend;
  tint?: [number, number, number];
  screenTint?: [number, number, number];
  opacity?: number;
  masks?: { source: number; mode: 'Mask' | 'DodgeMask' }[];
  maskThreshold?: number;
  // SimplePhysics
  physics?: { param: number; model: 'Pendulum' | 'SpringPendulum'; map: 'AngleLength' | 'LengthAngle' | 'XY' | 'YX'; gravity: number; length: number;
    frequency: number; angleDamping: number; lengthDamping: number; outputScale: [number, number]; localOnly: boolean };
}
export type BindingProp = 'deform' | 'zSort' | 'opacity' | 'transform.t.x' | 'transform.t.y' | 'transform.t.z' | 'transform.r.x' | 'transform.r.y' | 'transform.r.z'
  | 'transform.s.x' | 'transform.s.y' | 'tint.r' | 'tint.g' | 'tint.b' | 'screenTint.r' | 'screenTint.g' | 'screenTint.b';
const PROPS: readonly BindingProp[] = ['deform', 'zSort', 'opacity', 'transform.t.x', 'transform.t.y', 'transform.t.z', 'transform.r.x', 'transform.r.y', 'transform.r.z',
  'transform.s.x', 'transform.s.y', 'tint.r', 'tint.g', 'tint.b', 'screenTint.r', 'screenTint.g', 'screenTint.b'];
export interface InochiBinding {
  node: number;
  prop: BindingProp;
  mode: 'Linear' | 'Nearest' | 'Cubic';
  /** nx × ny points; scalar props: one number per point; deform: 2 × vertexCount numbers per point. Index (x * ny + y). */
  nx: number;
  ny: number;
  stride: number;
  values: Float32Array;
  isSet: Uint8Array;
}
export interface InochiParam { uuid: number; name: string; isVec2: boolean; min: [number, number]; max: [number, number]; defaults: [number, number]; axis: [number[], number[]]; bindings: InochiBinding[] }
export interface InochiMeta { name: string; version: string; rigger: string; artist: string; copyright: string; licenseURL: string; contact: string; reference: string;
  thumbnailId: number; preservePixels: boolean; rights?: Record<string, unknown> }
export interface InochiPuppet { meta: InochiMeta; root: InochiNode; params: InochiParam[]; physics: { pixelsPerMeter: number; gravity: number } }
export interface InochiTexture { encoding: 'png' | 'tga' | 'bc7' | 'unknown'; data: Uint8Array }
export interface InochiFile { puppet: InochiPuppet; textures: InochiTexture[]; ext: Record<string, Uint8Array>; warnings: string[] }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const vec = (v: unknown, n: number, d: number): number[] => { const a = arr(v); return Array.from({ length: n }, (_, i) => num(a[i], d)); };
const magicAt = (b: Uint8Array, o: number, m: string) => o + m.length <= b.length && [...m].every((c, i) => b[o + i] === c.charCodeAt(0));

/** Is this an Inochi2D puppet file? */
export const isInp = (b: Uint8Array | undefined) => !!b && magicAt(b, 0, INP_MAGIC);

export class InpError extends Error {}

/** Read the container + JSON. Throws InpError with a plain message on a broken / hostile file. */
export function parseInp(buf: ArrayBuffer | Uint8Array): InochiFile {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (!magicAt(b, 0, INP_MAGIC)) throw new InpError('Not an Inochi2D puppet (the file does not start with TRNSRTS).');
  let o = 8;
  const u32 = () => { if (o + 4 > b.length) throw new InpError('The puppet file is cut short.'); const v = dv.getUint32(o, false); o += 4; return v; };
  const jlen = u32();
  if (jlen > INP_LIMITS.json || o + jlen > b.length) throw new InpError('The puppet data is cut short or too big.');
  let json: unknown;
  try { json = JSON.parse(new TextDecoder('utf-8').decode(b.subarray(o, o + jlen))); } catch { throw new InpError('The puppet data is not valid JSON.'); }
  o += jlen;
  const textures: InochiTexture[] = [];
  const ext: Record<string, Uint8Array> = {};
  if (magicAt(b, o, TEX_MAGIC)) {
    o += 8;
    const n = u32();
    if (n > INP_LIMITS.textures) throw new InpError(`Too many textures (${n}).`);
    for (let i = 0; i < n; i++) {
      const len = u32();
      if (o + 1 + len > b.length || len > INP_LIMITS.texture) throw new InpError('A texture is cut short.');
      const enc = b[o]; o += 1;
      textures.push({ encoding: enc === 0 ? 'png' : enc === 1 ? 'tga' : enc === 2 ? 'bc7' : 'unknown', data: b.subarray(o, o + len) });
      o += len;
    }
  }
  if (magicAt(b, o, EXT_MAGIC)) {
    o += 8;
    const n = Math.min(u32(), INP_LIMITS.ext);
    for (let i = 0; i < n; i++) {
      const nl = u32();
      if (nl > 256 || o + nl > b.length) break;
      const name = new TextDecoder().decode(b.subarray(o, o + nl)); o += nl;
      const pl = u32();
      if (o + pl > b.length) break;
      ext[name] = b.subarray(o, o + pl); o += pl;
    }
  }
  const warnings: string[] = [];
  const puppet = parsePuppetJson(json, warnings);
  return { puppet, textures, ext, warnings };
}

let nodeCount = 0, vertCount = 0;
function parseNode(v: unknown, warnings: string[], depth: number): InochiNode | null {
  if (depth > 64) throw new InpError('The puppet\'s node tree is too deep.');
  const o = obj(v);
  if (++nodeCount > INP_LIMITS.nodes) throw new InpError('The puppet has too many nodes.');
  const t = obj(o.transform);
  const n: InochiNode = {
    uuid: num(o.uuid, 0) >>> 0, name: str(o.name), type: str(o.type, 40) || 'Node', enabled: o.enabled !== false, zsort: num(o.zsort, 0),
    trans: vec(t.trans, 3, 0) as [number, number, number], rot: vec(t.rot, 3, 0) as [number, number, number], scale: vec(t.scale, 2, 1) as [number, number],
    lockToRoot: o.lockToRoot === true, children: [],
  };
  if (n.type === 'Part' || n.type === 'Mask' || n.type === 'Composite') {
    if (n.type !== 'Composite') {
      const m = obj(o.mesh);
      const verts = arr(m.verts).map((x) => num(x, 0)), uvs = arr(m.uvs).map((x) => num(x, 0)), idx = arr(m.indices).map((x) => num(x, -1));
      if (verts.length % 2 || uvs.length !== verts.length || idx.length % 3 || idx.some((i) => i < 0 || i >= verts.length / 2 || !Number.isInteger(i))) {
        warnings.push(`Part "${n.name}" has a broken mesh: skipped.`);
      } else if (verts.length) {
        vertCount += verts.length / 2;
        if (vertCount > INP_LIMITS.verts) throw new InpError('The puppet has too many vertices.');
        n.mesh = { verts: Float32Array.from(verts), uvs: Float32Array.from(uvs), indices: Uint32Array.from(idx), origin: vec(m.origin, 2, 0) as [number, number] };
      }
      n.textures = arr(o.textures).map((x) => num(x, -1)).slice(0, 3);
    }
    n.blend = BLENDS.includes(o.blend_mode as InochiBlend) ? o.blend_mode as InochiBlend : 'Normal';
    n.tint = vec(o.tint, 3, 1) as [number, number, number];
    n.screenTint = vec(o.screenTint, 3, 0) as [number, number, number];
    n.opacity = Math.min(1, Math.max(0, num(o.opacity, 1)));
    n.masks = arr(o.masks).map((x) => { const q = obj(x); return { source: num(q.source, 0) >>> 0, mode: q.mode === 'DodgeMask' ? 'DodgeMask' as const : 'Mask' as const }; }).slice(0, 64);
    n.maskThreshold = Math.min(1, Math.max(0, num(o.mask_threshold, 0.5)));
  } else if (n.type === 'SimplePhysics') {
    // INP 0.8 serializes these on the node itself, not in a "props" object.
    // Retain the earlier reader's nested spelling as a compatibility fallback.
    const p = { ...obj(o.props), ...o };
    n.physics = {
      param: num(o.param, 0) >>> 0, model: o.model_type === 'spring_pendulum' || o.model_type === 'SpringPendulum' ? 'SpringPendulum' : 'Pendulum',
      map: o.map_mode === 'length_angle' || o.map_mode === 'LengthAngle' ? 'LengthAngle' : o.map_mode === 'xy' || o.map_mode === 'XY' ? 'XY' : o.map_mode === 'yx' || o.map_mode === 'YX' ? 'YX' : 'AngleLength',
      gravity: Math.max(0, num(p.gravity, 1)), length: Math.max(1e-3, num(p.length, 100)), frequency: Math.max(0.01, num(p.frequency, 1)),
      angleDamping: Math.max(0, num(p.angle_damping, 0.5)), lengthDamping: Math.max(0, num(p.length_damping, 0.5)),
      outputScale: vec(p.output_scale, 2, 1) as [number, number], localOnly: o.local_only === true,
    };
  } else if (n.type !== 'Node') {
    warnings.push(`Node type "${n.type}" (${n.name}) is not supported yet: drawn as a plain group.`);
  }
  for (const c of arr(o.children)) { const k = parseNode(c, warnings, depth + 1); if (k) n.children.push(k); }
  return n;
}

function parseBinding(v: unknown, nx: number, ny: number, warnings: string[]): InochiBinding | null {
  const o = obj(v);
  const prop = str(o.param_name, 40) as BindingProp;
  if (!PROPS.includes(prop)) { if (o.param_name) warnings.push(`Binding "${str(o.param_name, 40)}" is not supported yet: ignored.`); return null; }
  const vals = arr(o.values), set = arr(o.isSet);
  const mode = o.interpolate_mode === 'Nearest' ? 'Nearest' : o.interpolate_mode === 'Cubic' ? 'Cubic' : 'Linear';
  let stride = 1;
  if (prop === 'deform') {
    const first = arr(arr(vals[0])[0]);
    stride = first.length * 2;
  }
  const values = new Float32Array(nx * ny * stride);
  const isSet = new Uint8Array(nx * ny);
  for (let x = 0; x < nx; x++) {
    const col = arr(vals[x]), scol = arr(set[x]);
    for (let y = 0; y < ny; y++) {
      const at = (x * ny + y);
      isSet[at] = scol[y] === true ? 1 : 0;
      if (prop === 'deform') {
        const pts = arr(col[y]);
        if (pts.length * 2 !== stride) { if (pts.length) warnings.push('A deform binding has the wrong vertex count: ignored.'); return pts.length ? null : null; }
        for (let k = 0; k < pts.length; k++) { const p = arr(pts[k]); values[at * stride + k * 2] = num(p[0]); values[at * stride + k * 2 + 1] = num(p[1]); }
      } else values[at] = num(col[y], prop.startsWith('transform.s') || prop === 'opacity' || prop.startsWith('tint') ? 1 : 0);
    }
  }
  const b: InochiBinding = { node: num(o.node, 0) >>> 0, prop, mode, nx, ny, stride, values, isSet };
  reInterpolate(b);
  return b;
}

/** Points the rigger never set get values interpolated from the set ones along each axis (as Inochi Creator does), so
 *  an unset corner never snaps the mesh to zero. */
export function reInterpolate(b: InochiBinding) {
  const { nx, ny, stride, values, isSet } = b;
  if (isSet.every((s) => s)) return;
  if (!isSet.some((s) => s)) return; // nothing set: keep the stored values
  const fill = new Uint8Array(isSet);
  const copy = (from: number, to: number, w: number, from2: number) => {
    for (let k = 0; k < stride; k++) values[to * stride + k] = values[from * stride + k] * (1 - w) + values[from2 * stride + k] * w;
  };
  // along x in every row, then along y in every column, repeated until nothing changes
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const i = x * ny + y;
      if (fill[i]) continue;
      let a = -1, c = -1;
      for (let k = x - 1; k >= 0; k--) if (fill[k * ny + y]) { a = k; break; }
      for (let k = x + 1; k < nx; k++) if (fill[k * ny + y]) { c = k; break; }
      if (a >= 0 && c >= 0) copy(a * ny + y, i, (x - a) / (c - a), c * ny + y);
      else if (a >= 0 || c >= 0) { const s = (a >= 0 ? a : c) * ny + y; copy(s, i, 0, s); }
      else continue;
      fill[i] = 2; changed = true;
    }
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
      const i = x * ny + y;
      if (fill[i]) continue;
      let a = -1, c = -1;
      for (let k = y - 1; k >= 0; k--) if (fill[x * ny + k]) { a = k; break; }
      for (let k = y + 1; k < ny; k++) if (fill[x * ny + k]) { c = k; break; }
      if (a >= 0 && c >= 0) copy(x * ny + a, i, (y - a) / (c - a), x * ny + c);
      else if (a >= 0 || c >= 0) { const s = x * ny + (a >= 0 ? a : c); copy(s, i, 0, s); }
      else continue;
      fill[i] = 2; changed = true;
    }
    if (!changed) break;
  }
}

export function parsePuppetJson(json: unknown, warnings: string[] = []): InochiPuppet {
  nodeCount = 0; vertCount = 0;
  const j = obj(json), m = obj(j.meta), ph = obj(j.physics);
  const root = parseNode(j.nodes, warnings, 0);
  if (!root) throw new InpError('The puppet has no nodes.');
  const params: InochiParam[] = [];
  for (const p of arr(j.param).slice(0, INP_LIMITS.params)) {
    const o = obj(p), ap = arr(o.axis_points);
    const axis: [number[], number[]] = [arr(ap[0]).map((x) => num(x, 0)), arr(ap[1]).map((x) => num(x, 0))];
    if (!axis[0].length) axis[0] = [0, 1];
    if (!axis[1].length) axis[1] = [0];
    const nx = axis[0].length, ny = axis[1].length;
    const bindings: InochiBinding[] = [];
    for (const b of arr(o.bindings).slice(0, 4096)) { const k = parseBinding(b, nx, ny, warnings); if (k) bindings.push(k); }
    params.push({ uuid: num(o.uuid, 0) >>> 0, name: str(o.name, 120), isVec2: o.is_vec2 === true, min: vec(o.min, 2, 0) as [number, number], max: vec(o.max, 2, 1) as [number, number],
      defaults: vec(o.defaults, 2, 0) as [number, number], axis, bindings });
  }
  const meta: InochiMeta = {
    name: str(m.name), version: str(m.version, 40), rigger: str(m.rigger), artist: str(m.artist), copyright: str(m.copyright, 400), licenseURL: str(m.licenseURL, 400),
    contact: str(m.contact), reference: str(m.reference, 400), thumbnailId: num(m.thumbnailId, -1), preservePixels: m.preservePixels === true,
    ...(m.rights && typeof m.rights === 'object' ? { rights: m.rights as Record<string, unknown> } : {}),
  };
  return { meta, root, params, physics: { pixelsPerMeter: Math.max(1, num(ph.pixelsPerMeter, 1000)), gravity: num(ph.gravity, 9.8) } };
}

// ================================================================ evaluation
/** 2D affine [a, b, c, d, tx, ty]: x' = a x + c y + tx, y' = b x + d y + ty. */
export type Affine = Float64Array;
function trsAffine(out: Affine, t: [number, number, number], r: [number, number, number], s: [number, number]) {
  // R = Rx(r0) * Ry(r1) * Rz(r2) (XYZ euler as in the reference), orthographic: keep the 2×2 x/y block
  const [cx, cy, cz] = [Math.cos(r[0]), Math.cos(r[1]), Math.cos(r[2])], [sx, sy, sz] = [Math.sin(r[0]), Math.sin(r[1]), Math.sin(r[2])];
  // glam's from_euler(XYZ, a, b, c) = Rx(a) * Ry(b) * Rz(c)
  const m00 = cy * cz, m01 = -cy * sz;
  const m10 = sx * sy * cz + cx * sz, m11 = -sx * sy * sz + cx * cz;
  out[0] = m00 * s[0]; out[1] = m10 * s[0]; out[2] = m01 * s[1]; out[3] = m11 * s[1]; out[4] = t[0]; out[5] = t[1];
}
function mul(out: Affine, p: Affine, l: Affine) {
  const a = p[0] * l[0] + p[2] * l[1], b = p[1] * l[0] + p[3] * l[1];
  const c = p[0] * l[2] + p[2] * l[3], d = p[1] * l[2] + p[3] * l[3];
  const tx = p[0] * l[4] + p[2] * l[5] + p[4], ty = p[1] * l[4] + p[3] * l[5] + p[5];
  out[0] = a; out[1] = b; out[2] = c; out[3] = d; out[4] = tx; out[5] = ty;
}

export interface RigNode {
  node: InochiNode;
  parent: number;
  /** offsets written by bindings each frame */
  offT: [number, number, number]; offR: [number, number, number]; offS: [number, number]; offZ: number; offOpacity: number;
  offTint: [number, number, number]; offScreen: [number, number, number];
  world: Affine;
  zAbs: number;
  /** deform offsets (2 per vertex) and the final world-space vertices */
  deform?: Float32Array;
  out?: Float32Array;
  /** composite this node belongs to (-1 = none) */
  composite: number;
}

export interface DrawItem { node: number; composite: number }

/** A puppet ready to pose: set parameter values, call update(), read nodes[i].out / order. */
export class InochiRig {
  readonly nodes: RigNode[] = [];
  readonly byUuid = new Map<number, number>();
  readonly values: Float32Array; // 2 per param
  readonly paramByUuid = new Map<number, number>();
  /** drawable nodes in draw order (back to front) after update() */
  order: number[] = [];
  private phys: { node: number; angle: number; vel: number; len: number; lvel: number; lastX: number; lastY: number; vx: number; vy: number; init: boolean }[] = [];
  constructor(readonly puppet: InochiPuppet) {
    const walk = (n: InochiNode, parent: number, comp: number) => {
      const i = this.nodes.length;
      this.nodes.push({ node: n, parent, offT: [0, 0, 0], offR: [0, 0, 0], offS: [1, 1], offZ: 0, offOpacity: 1, offTint: [1, 1, 1], offScreen: [0, 0, 0],
        world: new Float64Array([1, 0, 0, 1, 0, 0]), zAbs: 0, composite: comp,
        ...(n.mesh ? { deform: new Float32Array(n.mesh.verts.length), out: new Float32Array(n.mesh.verts.length) } : {}) });
      if (!this.byUuid.has(n.uuid)) this.byUuid.set(n.uuid, i);
      if (n.physics) this.phys.push({ node: i, angle: 0, vel: 0, len: 0, lvel: 0, lastX: 0, lastY: 0, vx: 0, vy: 0, init: false });
      for (const c of n.children) walk(c, i, n.type === 'Composite' ? i : comp);
    };
    walk(puppet.root, -1, -1);
    this.values = new Float32Array(puppet.params.length * 2);
    puppet.params.forEach((p, i) => { this.values[i * 2] = p.defaults[0]; this.values[i * 2 + 1] = p.defaults[1]; this.paramByUuid.set(p.uuid, i); });
  }
  paramIndex(name: string): number { return this.puppet.params.findIndex((p) => p.name === name); }
  setParam(i: number, axis: 0 | 1, v: number) {
    const p = this.puppet.params[i];
    if (!p) return;
    const lo = Math.min(p.min[axis], p.max[axis]), hi = Math.max(p.min[axis], p.max[axis]);
    this.values[i * 2 + axis] = v < lo ? lo : v > hi ? hi : v;
  }
  resetParams() { this.puppet.params.forEach((p, i) => { this.values[i * 2] = p.defaults[0]; this.values[i * 2 + 1] = p.defaults[1]; }); }

  /** Pose the puppet from the current parameter values (dt drives the simple physics). */
  update(dt = 0) {
    for (const r of this.nodes) {
      r.offT[0] = r.offT[1] = r.offT[2] = 0; r.offR[0] = r.offR[1] = r.offR[2] = 0; r.offS[0] = r.offS[1] = 1; r.offZ = 0; r.offOpacity = 1;
      r.offTint[0] = r.offTint[1] = r.offTint[2] = 1; r.offScreen[0] = r.offScreen[1] = r.offScreen[2] = 0;
      if (r.deform) r.deform.fill(0);
    }
    this.applyParams();
    this.transforms();
    if (this.phys.length && dt > 0) { this.stepPhysics(dt); for (const r of this.nodes) { r.offT[0] = r.offT[1] = r.offT[2] = 0; r.offR[0] = r.offR[1] = r.offR[2] = 0; r.offS[0] = r.offS[1] = 1; r.offZ = 0; r.offOpacity = 1; r.offTint.fill(1); r.offScreen.fill(0); if (r.deform) r.deform.fill(0); } this.applyParams(); this.transforms(); }
    this.vertices();
    this.sort();
  }

  private applyParams() {
    const ps = this.puppet.params;
    for (let pi = 0; pi < ps.length; pi++) {
      const p = ps[pi];
      if (!p.bindings.length) continue;
      const [x0, x1, tx] = bracket(p.axis[0], norm01(this.values[pi * 2], p.min[0], p.max[0]));
      const [y0, y1, ty] = p.isVec2 ? bracket(p.axis[1], norm01(this.values[pi * 2 + 1], p.min[1], p.max[1])) : [0, 0, 0];
      for (const b of p.bindings) {
        const ni = this.byUuid.get(b.node);
        if (ni === undefined) continue;
        const r = this.nodes[ni];
        const ny = b.ny;
        const yy0 = Math.min(y0, ny - 1), yy1 = Math.min(y1, ny - 1);
        let wx = tx, wy = ty;
        if (b.mode === 'Nearest') { wx = wx < 0.5 ? 0 : 1; wy = wy < 0.5 ? 0 : 1; }
        const i00 = x0 * ny + yy0, i10 = x1 * ny + yy0, i01 = x0 * ny + yy1, i11 = x1 * ny + yy1;
        const w00 = (1 - wx) * (1 - wy), w10 = wx * (1 - wy), w01 = (1 - wx) * wy, w11 = wx * wy;
        if (b.prop === 'deform') {
          const d = r.deform;
          if (!d || d.length !== b.stride) continue;
          const s = b.stride, v = b.values;
          for (let k = 0; k < s; k++) d[k] += v[i00 * s + k] * w00 + v[i10 * s + k] * w10 + v[i01 * s + k] * w01 + v[i11 * s + k] * w11;
          continue;
        }
        const v = b.values[i00] * w00 + b.values[i10] * w10 + b.values[i01] * w01 + b.values[i11] * w11;
        switch (b.prop) {
          case 'transform.t.x': r.offT[0] += v; break;
          case 'transform.t.y': r.offT[1] += v; break;
          case 'transform.t.z': r.offT[2] += v; break;
          case 'transform.r.x': r.offR[0] += v; break;
          case 'transform.r.y': r.offR[1] += v; break;
          case 'transform.r.z': r.offR[2] += v; break;
          case 'transform.s.x': r.offS[0] *= v; break;
          case 'transform.s.y': r.offS[1] *= v; break;
          case 'zSort': r.offZ += v; break;
          case 'opacity': r.offOpacity *= v; break;
          case 'tint.r': r.offTint[0] *= v; break;
          case 'tint.g': r.offTint[1] *= v; break;
          case 'tint.b': r.offTint[2] *= v; break;
          case 'screenTint.r': r.offScreen[0] += v; break;
          case 'screenTint.g': r.offScreen[1] += v; break;
          case 'screenTint.b': r.offScreen[2] += v; break;
        }
      }
    }
  }

  private transforms() {
    const local = new Float64Array(6);
    const t: [number, number, number] = [0, 0, 0], ro: [number, number, number] = [0, 0, 0], s: [number, number] = [1, 1];
    for (let i = 0; i < this.nodes.length; i++) {
      const r = this.nodes[i], n = r.node;
      t[0] = n.trans[0] + r.offT[0]; t[1] = n.trans[1] + r.offT[1]; t[2] = n.trans[2] + r.offT[2];
      ro[0] = n.rot[0] + r.offR[0]; ro[1] = n.rot[1] + r.offR[1]; ro[2] = n.rot[2] + r.offR[2];
      s[0] = n.scale[0] * r.offS[0]; s[1] = n.scale[1] * r.offS[1];
      trsAffine(local, t, ro, s);
      if (r.parent < 0 || n.lockToRoot) {
        if (r.parent >= 0 && n.lockToRoot) mul(r.world, this.nodes[0].world, local);
        else r.world.set(local);
      } else mul(r.world, this.nodes[r.parent].world, local);
      r.zAbs = (r.parent >= 0 ? this.nodes[r.parent].zAbs : 0) + n.zsort + r.offZ;
    }
  }

  private vertices() {
    for (const r of this.nodes) {
      const m = r.node.mesh;
      if (!m || !r.out || !r.deform) continue;
      const w = r.world, v = m.verts, d = r.deform, o = r.out, ox = m.origin[0], oy = m.origin[1];
      for (let k = 0; k < v.length; k += 2) {
        const x = v[k] - ox + d[k], y = v[k + 1] - oy + d[k + 1];
        o[k] = w[0] * x + w[2] * y + w[4];
        o[k + 1] = w[1] * x + w[3] * y + w[5];
      }
    }
  }

  /** Drawables back to front: higher z-sort is further back (drawn first); a composite's parts stay together at the
   *  composite's place, sorted among themselves. Disabled nodes (and their children) are skipped. */
  private sort() {
    const enabled = new Uint8Array(this.nodes.length);
    for (let i = 0; i < this.nodes.length; i++) { const r = this.nodes[i]; enabled[i] = r.node.enabled && (r.parent < 0 || enabled[r.parent]) ? 1 : 0; }
    const top: number[] = [];
    const inComp = new Map<number, number[]>();
    for (let i = 0; i < this.nodes.length; i++) {
      const r = this.nodes[i], ty = r.node.type;
      if (!enabled[i]) continue;
      const drawable = ty === 'Part' && !!r.node.mesh;
      if (ty === 'Composite' && r.composite < 0) { top.push(i); continue; }
      if (!drawable) continue;
      if (r.composite >= 0) { const top2 = this.outerComposite(i); (inComp.get(top2) ?? inComp.set(top2, []).get(top2)!).push(i); }
      else top.push(i);
    }
    const byZ = (a: number, b: number) => this.nodes[b].zAbs - this.nodes[a].zAbs || a - b;
    top.sort(byZ);
    const out: number[] = [];
    for (const i of top) {
      if (this.nodes[i].node.type === 'Composite') { const kids = inComp.get(i) ?? []; kids.sort(byZ); out.push(...kids); }
      else out.push(i);
    }
    this.order = out;
  }
  private outerComposite(i: number): number { let c = this.nodes[i].composite; while (c >= 0 && this.nodes[c].composite >= 0) c = this.nodes[c].composite; return c; }

  /** Opacity / tint / screen tint of a drawable after bindings and its composites. */
  look(i: number): { opacity: number; tint: [number, number, number]; screen: [number, number, number] } {
    const r = this.nodes[i], n = r.node;
    let op = (n.opacity ?? 1) * r.offOpacity;
    const tint: [number, number, number] = [(n.tint?.[0] ?? 1) * r.offTint[0], (n.tint?.[1] ?? 1) * r.offTint[1], (n.tint?.[2] ?? 1) * r.offTint[2]];
    const screen: [number, number, number] = [(n.screenTint?.[0] ?? 0) + r.offScreen[0], (n.screenTint?.[1] ?? 0) + r.offScreen[1], (n.screenTint?.[2] ?? 0) + r.offScreen[2]];
    for (let c = r.composite; c >= 0; c = this.nodes[c].composite) {
      const cr = this.nodes[c], cn = cr.node;
      op *= (cn.opacity ?? 1) * cr.offOpacity;
      for (let k = 0; k < 3; k++) { tint[k] *= (cn.tint?.[k] ?? 1) * cr.offTint[k]; screen[k] = Math.max(screen[k], (cn.screenTint?.[k] ?? 0) + cr.offScreen[k]); }
    }
    return { opacity: Math.min(1, Math.max(0, op)), tint, screen };
  }

  /** Simple pendulums for SimplePhysics nodes: the anchor's world motion swings a damped pendulum; its angle / length
   *  go to the node's parameter (AngleLength / LengthAngle / XY / YX). An approximation of Inochi2D's physics. */
  private stepPhysics(dt: number) {
    const h = Math.min(dt, 0.05);
    const ppm = this.puppet.physics.pixelsPerMeter, g0 = this.puppet.physics.gravity;
    for (const s of this.phys) {
      const r = this.nodes[s.node], ph = r.node.physics!;
      const pi = this.paramByUuid.get(ph.param);
      if (pi === undefined) continue;
      const x = r.world[4] / ppm, y = r.world[5] / ppm;
      if (!s.init) { s.lastX = x; s.lastY = y; s.init = true; }
      const vx = (x - s.lastX) / h, vy = (y - s.lastY) / h;
      const ax = (vx - s.vx) / h, ay = (vy - s.vy) / h;
      s.lastX = x; s.lastY = y; s.vx = vx; s.vy = vy;
      const L = ph.length / ppm, g = g0 * ph.gravity;
      // y is down on screen: gravity pulls +y; the bob hangs at angle 0 straight down
      // bob at (L sin a, L cos a) below the anchor; the anchor's acceleration (ax, ay) swings it
      const acc = (-(g - ay) * Math.sin(s.angle) - ax * Math.cos(s.angle)) / L - ph.angleDamping * 2 * Math.PI * ph.frequency * s.vel;
      s.vel += acc * h;
      s.angle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, s.angle + s.vel * h));
      if (!Number.isFinite(s.angle)) { s.angle = 0; s.vel = 0; }
      const p = this.puppet.params[pi];
      const ang = s.angle / (Math.PI / 2), len = 0;
      const sx = ph.outputScale[0], sy = ph.outputScale[1];
      const [vx2, vy2] = ph.map === 'AngleLength' ? [ang * sx, len * sy] : ph.map === 'LengthAngle' ? [len * sx, ang * sy]
        : ph.map === 'XY' ? [Math.sin(s.angle) * sx, (1 - Math.cos(s.angle)) * sy] : [(1 - Math.cos(s.angle)) * sx, Math.sin(s.angle) * sy];
      // physics values are relative to the parameter's centre
      const cx = (p.min[0] + p.max[0]) / 2, cy = (p.min[1] + p.max[1]) / 2;
      this.setParam(pi, 0, cx + vx2 * (p.max[0] - p.min[0]) / 2);
      if (p.isVec2) this.setParam(pi, 1, cy + vy2 * (p.max[1] - p.min[1]) / 2);
    }
  }

  /** Bounding box of every drawable at the current pose (puppet units). */
  bounds(): [number, number, number, number] {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of this.order) {
      const o = this.nodes[i].out!;
      for (let k = 0; k < o.length; k += 2) { if (o[k] < x0) x0 = o[k]; if (o[k] > x1) x1 = o[k]; if (o[k + 1] < y0) y0 = o[k + 1]; if (o[k + 1] > y1) y1 = o[k + 1]; }
    }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : [-1, -1, 1, 1];
  }
}

function norm01(v: number, lo: number, hi: number) { if (hi === lo) return 0; const t = (v - lo) / (hi - lo); return t < 0 ? 0 : t > 1 ? 1 : t; }
/** [index below, index above, weight] of `t` among sorted axis points. */
export function bracket(ax: number[], t: number): [number, number, number] {
  const n = ax.length;
  if (n <= 1) return [0, 0, 0];
  if (t <= ax[0]) return [0, 1, 0];
  if (t >= ax[n - 1]) return [n - 2, n - 1, 1];
  let i = 0;
  while (i < n - 2 && ax[i + 1] < t) i++;
  const d = ax[i + 1] - ax[i];
  return [i, i + 1, d > 0 ? (t - ax[i]) / d : 0];
}

/** Puppet usage rights (meta.rights) in plain words for the import dialog. */
export function rightsSummary(meta: InochiMeta): string[] {
  const r = meta.rights;
  const out: string[] = [];
  if (meta.artist) out.push(`Art: ${meta.artist}`);
  if (meta.rigger) out.push(`Rig: ${meta.rigger}`);
  if (meta.copyright) out.push(meta.copyright);
  if (r) {
    if (r.allowed_users === 'OnlyAuthor') out.push('Only its author may use this puppet.');
    if (r.allowed_users === 'OnlyLicensee') out.push('Only people the author licensed may use this puppet.');
    if (r.allow_commercial === false) out.push('No commercial use.');
    if (r.require_attribution === true) out.push('Credit the author when you use it.');
  }
  if (meta.licenseURL) out.push(`Licence: ${meta.licenseURL}`);
  return out;
}

// ================================================================ writing (tests + the sample puppet generator)
/** Build an .inp file from a puppet JSON object + textures (used by tests and tools/inochi_sample.ts). */
export function writeInp(json: unknown, textures: { encoding: 0 | 1 | 2; data: Uint8Array }[], ext: Record<string, Uint8Array> = {}): Uint8Array {
  const enc = new TextEncoder();
  const j = enc.encode(JSON.stringify(json));
  const parts: Uint8Array[] = [];
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, false); return b; };
  parts.push(enc.encode(INP_MAGIC), u32(j.length), j, enc.encode(TEX_MAGIC), u32(textures.length));
  for (const t of textures) parts.push(u32(t.data.length), Uint8Array.of(t.encoding), t.data);
  const names = Object.keys(ext);
  if (names.length) {
    parts.push(enc.encode(EXT_MAGIC), u32(names.length));
    for (const n of names) { const nb = enc.encode(n); parts.push(u32(nb.length), nb, u32(ext[n].length), ext[n]); }
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Decode an uncompressed or RLE TGA (24 / 32 bit truecolour, 8 bit grey) into RGBA. Null when unsupported. */
export function decodeTga(b: Uint8Array): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  if (b.length < 18) return null;
  const idLen = b[0], cmapType = b[1], type = b[2];
  const w = b[12] | (b[13] << 8), h = b[14] | (b[15] << 8), bpp = b[16], desc = b[17];
  if (cmapType !== 0 || ![2, 3, 10, 11].includes(type) || !w || !h || w > 16384 || h > 16384) return null;
  const px = bpp / 8;
  if (!((type === 2 || type === 10) && (px === 3 || px === 4)) && !((type === 3 || type === 11) && px === 1)) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  let o = 18 + idLen;
  const n = w * h;
  const put = (i: number, at: number) => {
    if (px === 1) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = b[at]; out[i * 4 + 3] = 255; }
    else { out[i * 4] = b[at + 2]; out[i * 4 + 1] = b[at + 1]; out[i * 4 + 2] = b[at]; out[i * 4 + 3] = px === 4 ? b[at + 3] : 255; }
  };
  const rle = type === 10 || type === 11;
  let i = 0;
  while (i < n) {
    if (!rle) { if (o + px > b.length) return null; put(i++, o); o += px; continue; }
    if (o >= b.length) return null;
    const hdr = b[o++], cnt = (hdr & 0x7f) + 1;
    if (hdr & 0x80) { if (o + px > b.length) return null; for (let k = 0; k < cnt && i < n; k++) put(i++, o); o += px; }
    else for (let k = 0; k < cnt && i < n; k++) { if (o + px > b.length) return null; put(i++, o); o += px; }
  }
  // TGA rows are bottom-up unless bit 5 of the descriptor is set
  if (!(desc & 0x20)) {
    const row = w * 4, tmp = new Uint8ClampedArray(row);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * row, c = (h - 1 - y) * row;
      tmp.set(out.subarray(a, a + row)); out.copyWithin(a, c, c + row); out.set(tmp, c);
    }
  }
  return { width: w, height: h, rgba: out };
}
