// Inochi2D puppet (.inp / .inx, BSD-2-Clause format) → VTube Pro .vtp2 rig, on import. Reader: ./inp.ts.
// Mapping (docs/RIG2D_FORMAT.md):
//   node tree        → a chain of rotation deformers (origin = translation, angle = rotation z, scale, mirror)
//   Part / Mask      → meshes under their node's deformer (vertices − mesh origin); Mask nodes are mask-only
//   parameters       → parameters (a 2D parameter becomes "<name> X" + "<name> Y")
//   deform bindings  → mesh blend shapes (additive offsets, 1D or 2D grids — Inochi2D adds bindings up the same way)
//   transform t/r/s  → rotation blend shapes (origin / angle / scale deltas)
//   opacity / tint / screenTint → material keyforms (operator adapter for nonlinear composition)
//   z-sort           → draw-order keyforms, including ancestor offsets (higher z-sort = further back)
//   SimplePhysics    → explicitly marked format-v1 extra adapter; reference pendulum / spring-pendulum equations
//   masks            → mesh masks (Mask = clip, DodgeMask = inverted)
//   blend modes      → normal / multiply / add (LinearDodge) / screen; others drawn normal
//   tracking         → roles.bind from parameter names (head yaw / pitch / roll, eyes, mouth …), ranges mapped
// BC7 blocks decode to PNG; texture tag 2 accepts a standard DDS DX10 size wrapper (see provenance §5).
// Remaining approximations: composite rendering, non-linear binding interpolation, non-uniform scale on nodes,
// x / y rotations, mixed Mask + DodgeMask on one part.
import { BufferBuilder, crc32, type Rig2DPackage } from '../container.ts';
import { RIG2D, RIG2D_LIMITS, type Rig2DDoc } from '../format.ts';
import { SOURCE_RANGE, guessInochiSources } from '../drive.ts';
import { InochiRig, decodeTga, parseInp, rightsSummary, type InochiNode } from './inp.ts';
import { decodeBc7Texture } from './bc7.ts';
import { convertScalarBindings } from './bindings.ts';
import { convertPhysics } from './physicsAdapter.ts';

export interface InochiConvertResult { pkg: Rig2DPackage; warnings: string[] }

// ---------------------------------------------------------------- a dependency-free PNG writer (stored deflate blocks)
function adler32(b: Uint8Array) { let a = 1, c = 0; for (let i = 0; i < b.length; i++) { a = (a + b[i]) % 65521; c = (c + a) % 65521; } return ((c << 16) | a) >>> 0; }
/** RGBA → PNG without compression (zlib "stored" blocks): no zlib needed, works in node and browsers. */
export function pngStored(w: number, h: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const blocks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let o = 0; o < raw.length || o === 0; o += 65535) {
    const n = Math.min(65535, raw.length - o), last = o + n >= raw.length ? 1 : 0;
    const hdr = Uint8Array.of(last, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff);
    blocks.push(hdr, raw.subarray(o, o + n));
    if (last) break;
  }
  const ad = adler32(raw);
  blocks.push(Uint8Array.of(ad >>> 24, (ad >>> 16) & 0xff, (ad >>> 8) & 0xff, ad & 0xff));
  const z = concat(blocks);
  const chunk = (type: string, data: Uint8Array) => {
    const td = concat([new TextEncoder().encode(type), data]);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
    const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(td));
    return concat([len, td, crc]);
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  return concat([Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}
function concat(parts: Uint8Array[]) { const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
const pngDims = (b: Uint8Array): [number, number] | null => (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 ? [new DataView(b.buffer, b.byteOffset).getUint32(16), new DataView(b.buffer, b.byteOffset).getUint32(20)] : null);

const DEG = 180 / Math.PI;

export function convertInochi(bytes: Uint8Array, name = 'Inochi2D puppet'): InochiConvertResult {
  const file = parseInp(bytes);
  const pup = file.puppet;
  const warnings: string[] = [...file.warnings];
  const warnOnce = new Set<string>();
  const warn = (s: string) => { if (!warnOnce.has(s)) { warnOnce.add(s); warnings.push(s); } };
  const B = new BufferBuilder(0);

  // ---------------- textures
  const files = new Map<string, Uint8Array>();
  const textures: Rig2DDoc['textures'] = [];
  const texMap: number[] = [];
  file.textures.forEach((t, i) => {
    let png: Uint8Array | null = null, dims: [number, number] | null = null;
    if (t.encoding === 'png') { png = t.data.slice(); dims = pngDims(png); }
    else if (t.encoding === 'tga') { const d = decodeTga(t.data); if (d) { png = pngStored(d.width, d.height, d.rgba); dims = [d.width, d.height]; } }
    else if (t.encoding === 'bc7') {
      try { const d = decodeBc7Texture(t.data); png = pngStored(d.width, d.height, d.rgba); dims = [d.width, d.height]; }
      catch (e) { throw new Error(`Texture ${i + 1}: ${(e as Error).message}`); }
    }
    if (!png || !dims) { texMap.push(-1); warn(`Texture ${i + 1} can’t be read.`); return; }
    if (png.length > RIG2D_LIMITS.textureBytes) throw new Error(`Texture ${i + 1} is too large after decoding. Export the puppet with smaller PNG textures.`);
    texMap.push(textures.length);
    const f = `textures/${textures.length}.png`;
    files.set(f, png);
    textures.push({ file: f, width: dims[0], height: dims[1], filter: pup.meta.preservePixels ? 'nearest' : 'linear' });
  });
  if (!textures.length) throw new Error('This Inochi2D puppet has no textures VTube Pro can read.');

  // ---------------- parameters (2D ones split into X and Y)
  const params: Rig2DDoc['params'] = [];
  const pIndex: [number, number][] = []; // per Inochi param: [x param, y param or -1]
  const ids = new Set<string>();
  const uniq = (s: string) => { let id = (s || 'Param').slice(0, 120); let k = 2; while (ids.has(id)) id = `${s.slice(0, 116)} ${k++}`; ids.add(id); return id; };
  for (const p of pup.params) {
    const mk = (axis: 0 | 1, suffix: string) => {
      const lo = Math.min(p.min[axis], p.max[axis]), hi = Math.max(p.min[axis], p.max[axis]);
      params.push({ id: uniq(p.name + suffix), name: (p.name + suffix).slice(0, 256), min: lo, max: hi === lo ? lo + 1 : hi, default: Math.min(Math.max(p.defaults[axis], lo), hi === lo ? lo + 1 : hi) });
      return params.length - 1;
    };
    pIndex.push(p.isVec2 ? [mk(0, ' X'), mk(1, ' Y')] : [mk(0, ''), -1]);
  }

  // ---------------- nodes → rotation deformers + meshes
  const rig = new InochiRig(pup);
  rig.update();
  const grids: Rig2DDoc['grids'] = [{ axes: [] }];
  const deformers: Rig2DDoc['deformers'] = [];
  const meshes: Rig2DDoc['meshes'] = [];
  const nodeDef = new Int32Array(rig.nodes.length).fill(-1);
  const nodeMesh = new Int32Array(rig.nodes.length).fill(-1);
  rig.nodes.forEach((r, i) => {
    const n: InochiNode = r.node;
    if (n.rot[0] || n.rot[1]) warn('Some parts are turned in 3D (x / y rotation): drawn flat.');
    if (Math.abs(Math.abs(n.scale[0]) - Math.abs(n.scale[1])) > 1e-4) warn('Some parts are stretched unevenly: drawn with even scaling.');
    const parent = r.parent >= 0 ? nodeDef[r.parent] : -1;
    if (n.lockToRoot && r.parent >= 0) warn('Some parts are locked to the root: they follow their parent here.');
    deformers.push({ id: `node_${n.uuid}`, name: n.name.slice(0, 256) || `Node ${i}`, kind: 'rotation', parent, part: -1, grid: 0, enabled: n.enabled, visible: true, opacity: [1],
      rotation: { baseAngle: 0, angle: [n.rot[2] * DEG], originX: [n.trans[0]], originY: [n.trans[1]], scale: [Math.abs(n.scale[0]) || 1], reflectX: [n.scale[0] < 0], reflectY: [n.scale[1] < 0] } });
    nodeDef[i] = deformers.length - 1;
    const m = n.mesh;
    if (!m || (n.type !== 'Part' && n.type !== 'Mask')) return;
    const tex = texMap[n.textures?.[0] ?? -1] ?? -1;
    if (tex < 0) { warn('Some parts have no readable texture: skipped.'); return; }
    const v = m.verts, nv = v.length / 2;
    if (nv > 65535) { warn('A part has too many points: skipped.'); return; }
    const pos = new Float32Array(v.length);
    for (let k = 0; k < v.length; k += 2) { pos[k] = v[k] - m.origin[0]; pos[k + 1] = v[k + 1] - m.origin[1]; }
    const blend = n.blend === 'Multiply' ? 'multiply' as const : n.blend === 'LinearDodge' ? 'add' as const : n.blend === 'Screen' ? 'screen' as const : 'normal' as const;
    if (n.blend && !['Normal', 'Multiply', 'LinearDodge', 'Screen'].includes(n.blend)) warn(`Blend mode ${n.blend} is drawn as normal.`);
    if ((n.tint && n.tint.some((x) => x !== 1)) || (n.screenTint && n.screenTint.some((x) => x !== 0))) {
      // static tints are kept as multiply / screen colours
    }
    const idx = n.mesh!.indices;
    meshes.push({ id: `part_${n.uuid}`, name: n.name.slice(0, 256) || `Part ${i}`, part: -1, deformer: nodeDef[i], texture: tex, grid: 0, vertexCount: nv,
      uvs: B.add(Float32Array.from(m.uvs), 'f32'), indices: nv <= 65535 ? B.add(Uint16Array.from(idx), 'u16') : B.add(Uint32Array.from(idx), 'u32'), positions: B.add(pos, 'f32'),
      opacity: [n.opacity ?? 1], drawOrder: [-r.zAbs], blend, doubleSided: true, masks: [], visible: n.type === 'Part', enabled: n.enabled,
      ...((n.tint && n.tint.some((x) => x !== 1)) || (n.screenTint && n.screenTint.some((x) => x !== 0)) ? { color: { multiply: B.f32(n.tint ?? [1, 1, 1]), screen: B.f32(n.screenTint ?? [0, 0, 0]) } } : {}) });
    nodeMesh[i] = meshes.length - 1;
  });
  // masks
  rig.nodes.forEach((r, i) => {
    const mi = nodeMesh[i], ms = r.node.masks ?? [];
    if (mi < 0 || !ms.length) return;
    const src = ms.map((m) => ({ mesh: nodeMesh[rig.byUuid.get(m.source) ?? -1] ?? -1, dodge: m.mode === 'DodgeMask' })).filter((m) => m.mesh >= 0 && m.mesh !== mi);
    if (!src.length) return;
    const dodge = src.filter((m) => m.dodge), clip = src.filter((m) => !m.dodge);
    if (dodge.length && clip.length) warn('Some parts mix clip and dodge masks: only the clip masks are used.');
    const use = clip.length ? clip : dodge;
    meshes[mi].masks = [...new Set(use.map((m) => m.mesh))].slice(0, 64);
    if (!clip.length) meshes[mi].maskInvert = true;
  });

  // ---------------- bindings → blend shapes
  const blendShapes: NonNullable<Rig2DDoc['blendShapes']> = [];
  const rotAdd = new Map<string, { def: number; p: number; keys: number[]; p2?: number; keys2?: number[]; vals: Record<'angle' | 'originX' | 'originY' | 'scale', number[]> }>();
  pup.params.forEach((p, pi) => {
    const [px, py] = pIndex[pi];
    const keysX = p.axis[0].map((a) => p.min[0] + a * (p.max[0] - p.min[0]));
    const keysY = p.isVec2 ? p.axis[1].map((a) => p.min[1] + a * (p.max[1] - p.min[1])) : null;
    const inc = (k: number[]) => k.every((x, i) => i === 0 || x > k[i - 1]);
    if (!inc(keysX) || (keysY && !inc(keysY))) { warn(`Parameter ${p.name} has repeated points: skipped.`); return; }
    const nx = keysX.length, ny = keysY?.length ?? 1;
    const reorder = (vals: ArrayLike<number>, stride: number) => {
      // inochi stores [x][y] (index x * ny + y); ours is i + nx * j
      const out = new Float32Array(nx * ny * stride);
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let k = 0; k < stride; k++) out[(x + nx * y) * stride + k] = vals[(x * ny + y) * stride + k];
      return out;
    };
    for (const b of p.bindings) {
      const ni = rig.byUuid.get(b.node);
      if (ni === undefined) continue;
      const two = keysY && ny > 1 ? { param2: py, keys2: keysY } : {};
      if (b.prop === 'deform') {
        const mi = nodeMesh[ni];
        if (mi < 0 || b.stride !== meshes[mi].vertexCount * 2) continue;
        if (b.mode !== 'Linear') warn('Some bindings use non-linear interpolation: blended linearly.');
        blendShapes.push({ target: { kind: 'mesh', index: mi }, param: px, keys: keysX, ...two, offsets: B.add(reorder(b.values, b.stride), 'f32') });
      } else if (b.prop.startsWith('transform.')) {
        const what = b.prop === 'transform.t.x' ? 'originX' : b.prop === 'transform.t.y' ? 'originY' : b.prop === 'transform.r.z' ? 'angle' : b.prop === 'transform.s.x' ? 'scale' : null;
        if (!what) { if (b.prop !== 'transform.s.y' && b.prop !== 'transform.t.z') warn('Some 3D-turn bindings aren’t converted.'); continue; }
        const key = `${ni}:${pi}`;
        let e = rotAdd.get(key);
        if (!e) { e = { def: nodeDef[ni], p: px, keys: keysX, ...(keysY && ny > 1 ? { p2: py, keys2: keysY } : {}), vals: { angle: [], originX: [], originY: [], scale: [] } }; rotAdd.set(key, e); }
        const raw = reorder(b.values, 1);
        const n0 = rig.nodes[ni].node;
        e.vals[what] = Array.from(raw, (v) => (what === 'angle' ? v * DEG : what === 'scale' ? (Math.abs(n0.scale[0]) || 1) * (v - 1) : v));
      } // opacity / tint / screenTint / zSort become ordinary keyforms below.
    }
  });
  for (const e of rotAdd.values()) {
    const n = e.keys.length * (e.keys2?.length ?? 1);
    const fill = (a: number[]) => (a.length === n ? a : new Array(n).fill(0));
    blendShapes.push({ target: { kind: 'rotation', index: e.def }, param: e.p, keys: e.keys, ...(e.p2 !== undefined ? { param2: e.p2, keys2: e.keys2 } : {}),
      values: { angle: fill(e.vals.angle), originX: fill(e.vals.originX), originY: fill(e.vals.originY), scale: fill(e.vals.scale) } });
  }
  const materials = convertScalarBindings(rig, pIndex, params, grids, deformers, meshes, nodeMesh, B, warn);
  const physics = convertPhysics(rig, nodeDef, pIndex, params, deformers, warn);

  // ---------------- canvas = the default pose's bounds (+ margin for movement)
  const [x0, y0, x1, y1] = rig.bounds();
  const mw = (x1 - x0) * 0.1, mh = (y1 - y0) * 0.1;
  const canvas = { width: Math.ceil(x1 - x0 + 2 * mw), height: Math.ceil(y1 - y0 + 2 * mh), unit: 1, originX: -(x0 - mw), originY: -(y0 - mh) };

  // ---------------- tracking: bind by parameter names (ranges mapped onto each parameter)
  // a 2D parameter is recognised by its own name ("Head:: Yaw-Pitch" → yaw on X, pitch on Y), then mapped per axis
  const bind: NonNullable<Rig2DDoc['roles']['bind']> = {};
  pup.params.forEach((p, pi) => {
    const g = guessInochiSources(p.name, p.isVec2 ? 2 : 1);
    ([0, 1] as const).forEach((axis) => {
      const s = g[axis], qi = pIndex[pi][axis];
      if (!s || qi < 0 || s in bind) return;
      const q = params[qi], [lo, hi] = SOURCE_RANGE[s];
      let outLo = q.min, outHi = q.max;
      if ((s === 'eyeOpenL' || s === 'eyeOpenR') && /blink|clos/i.test(p.name)) [outLo, outHi] = [outHi, outLo];
      (bind as Record<string, unknown>)[s] = { param: q.id, range: [lo, hi, outLo, outHi] };
    });
  });
  if (!Object.keys(bind).length) warn('No head / eye / mouth parameters were recognised by name: set them under “Details: what moves what”.');

  const buf = B.bytes();
  const rights = rightsSummary(pup.meta);
  const doc: Rig2DDoc = {
    magic: RIG2D.magic, version: RIG2D.version,
    meta: { name: (pup.meta.name || name).slice(0, 256), ...(pup.meta.artist || pup.meta.rigger ? { authors: [pup.meta.artist, pup.meta.rigger].filter(Boolean).map((s) => s.slice(0, 256)) } : {}),
      ...(pup.meta.licenseURL ? { licenseUrl: pup.meta.licenseURL.slice(0, 512) } : {}), ...(rights.length ? { notes: rights.join(' · ').slice(0, 4096) } : {}),
      source: { kind: 'inochi2d', version: pup.meta.version.slice(0, 64), converter: 'VTube Pro rig2d/inochi2d 2' } },
    canvas, buffers: [{ file: 'buffers/0.bin', byteLength: buf.length }], textures, params, grids, parts: [], deformers, meshes,
    ...(blendShapes.length ? { blendShapes } : {}),
    roles: { eyeBlink: [], lipSync: [], ...(Object.keys(bind).length ? { bind } : {}) },
    ...(physics.length ? { dynamics: physics } : {}),
    ...(materials ? { materialBindings: materials.carriers } : {}),
  };
  return { pkg: { doc, buffers: [buf], files }, warnings };
}
