// Pro2D (.vtp2) → the "bundle" the Live2D→3D pipeline reads (blender/live2d/vtp2.py), and on-demand pose evaluation.
// The pipeline was written against Live2D's .moc3; a Pro2D avatar keeps only its .vtp2 (docs/RIG2D_FORMAT.md §7: the
// original files are never kept), so this tool evaluates the rig with the SAME evaluator the runtime draws with
// (shared/rig2d/evaluate.ts RigEval: deformers, glue, blend shapes, bones + skinning) and writes plain arrays.
// Nothing here reimplements the evaluator in Python. Lane to3d (docs/PRO2D_TO_3D.md).
//
//   node --import tsx tools/pro2d_bundle.ts export <in.vtp2> <outDir>     (release: node dist-helper/pro2d_bundle.mjs …)
//   node --import tsx tools/pro2d_bundle.ts eval <outDir>                 (stdin: JSON [{key?, params?, std?, expression?, layers?}])
//
// Bundle layout (<outDir>):
//   bundle.json   meta, canvas (as the pipeline's moc canvas: ppu / ox / oy / w / h), params, parts, deformers, meshes
//                 (name, part, deformer chain, texture, blend 0 normal / 1 add / 2 multiply, masks, the parameters that
//                 move it), roles + the standard-id aliases (ParamAngleX → the rig's head-turn parameter through its
//                 binding), physics / dynamics / expressions / layers / bones summaries, textures
//   geom.bin      per mesh uvs (f32 × 2 × V, v from the TOP like Live2D) and triangles (i32 × 3 × T); offsets in bundle.json
//   textures/     the rig's textures as stored (png / webp)
//   poses/<key>.bin + poses.json   per pose: every mesh's model-space vertices (f32), and opacity / enabled / order
// The default pose list covers every pose the pipeline asks for (rest, mouth open, blink, head turns −30…+30, each
// expression, each costume layer); any other pose is evaluated on demand by `eval` (vtp2.py calls it, cached).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readVtp2, viewArray } from '../shared/rig2d/container.ts';
import { RigEval } from '../shared/rig2d/evaluate.ts';
import { Animator, SwitchFader } from '../shared/rig2d/animate.ts';
import { applyBindings, L2D_STANDARD, RIG2D_SOURCES, type Rig2DBinding, type Rig2DParamInfo, type Rig2DStdSource } from '../shared/rig2d/drive.ts';
import type { Rig2DDoc } from '../shared/rig2d/format.ts';
import type { TrackingFrame } from '../shared/types.ts';

export const BUNDLE_VERSION = 1;

/** A pose request: raw parameter values (rig ids), standard sources (Cubism units: degrees ±30, eyes 0..1 …), an
 *  expression at full weight, the costume layers switched on (missing = each layer's own default). */
export interface PoseReq { key?: string; params?: Record<string, number>; std?: Partial<Record<Rig2DStdSource, number>>; expression?: string; layers?: string[];
  /** the pipeline's own form: Cubism standard ids (ParamAngleX …) or rig ids; split like vtp2.py does (normalizeReq) */
  pipe?: Record<string, number> }

/** Standard Cubism id → standard source (ParamAngleX → headYaw …), from shared/rig2d/drive.ts. */
export const STD_ID_TO_SOURCE: Record<string, Rig2DStdSource> = Object.fromEntries(
  Object.entries(L2D_STANDARD).flatMap(([src, ids]) => (ids ?? []).map((id) => [id, src as Rig2DStdSource])));

const NEUTRAL: Record<Rig2DStdSource, number> = Object.fromEntries(RIG2D_SOURCES.map((s) => [s, s === 'eyeOpenL' || s === 'eyeOpenR' ? 1 : 0])) as Record<Rig2DStdSource, number>;
const NEUTRAL_FRAME = { t: 0, tracked: true, face: {}, head: [0, 0, 0], gaze: [0, 0], mouth: { open: 0, smile: 0, frown: 0, pucker: 0, funnel: 0 } } as unknown as TrackingFrame;

export interface Ctx { doc: Rig2DDoc; buffers: Uint8Array[]; files: Map<string, Uint8Array>; ev: RigEval; bindings: Rig2DBinding[]; info: Map<string, Rig2DParamInfo>; pIdx: Map<string, number>; partIdx: Map<string, number> }

export async function openRig(file: string): Promise<Ctx> {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const r = await readVtp2(bytes, (d) => new Uint8Array(zlib.inflateRawSync(d)));
  if (!r.ok) throw new Error(r.error);
  const { doc, buffers, files } = r.pkg;
  const ev = new RigEval(doc, buffers);
  const info = new Map<string, Rig2DParamInfo>(doc.params.map((p) => [p.id, { id: p.id, name: p.name, dims: 1, min: [p.min, p.min], max: [p.max, p.max], def: [p.default, p.default] }]));
  return { doc, buffers, files, ev, bindings: Animator.autoBindings(doc), info, pIdx: new Map(doc.params.map((p, i) => [p.id, i])), partIdx: new Map(doc.parts.map((p, i) => [p.id, i])) };
}

/** Which standard Cubism ids this rig can answer (directly, or through a tracking binding of that source). */
export function stdAliases(c: Ctx): Record<string, { source: Rig2DStdSource; params: string[] }> {
  const out: Record<string, { source: Rig2DStdSource; params: string[] }> = {};
  for (const [src, ids] of Object.entries(L2D_STANDARD) as [Rig2DStdSource, string[]][]) {
    const id = ids[0];                          // the Cubism 3 id is what the pipeline asks for
    if (c.pIdx.has(id)) continue;               // the rig has the real id: the pipeline uses it directly
    const older = ids.find((x) => c.pIdx.has(x)); // a Cubism 2 id (PARAM_ANGLE_X): the same parameter under the new name
    if (older) { out[id] = { source: src, params: [older] }; continue; }
    const params = c.bindings.filter((b) => !b.off && b.src === src).map((b) => b.param).filter((p) => c.pIdx.has(p));
    if (params.length) out[id] = { source: src, params };
  }
  return out;
}

/** The pipeline's form → rig params + standard sources, exactly as blender/live2d/vtp2.py splits it (same cache keys). */
export function normalizeReq(c: Ctx, r: PoseReq, aliases = stdAliases(c)): PoseReq {
  const params: Record<string, number> = { ...(r.params ?? {}) }, std: Partial<Record<Rig2DStdSource, number>> = { ...(r.std ?? {}) };
  for (const [k, v] of Object.entries(r.pipe ?? {})) {
    if (c.pIdx.has(k)) params[k] = v;
    else if (aliases[k]) std[aliases[k].source] = v;
  }
  return { key: r.key, params, std, ...(r.expression ? { expression: r.expression } : {}), ...(r.layers ? { layers: r.layers } : {}) };
}

/** Evaluate one static pose (no motion, physics, dynamics or auto blink): the rig at rest, then the request on top. */
export function evalPose(c: Ctx, req: PoseReq) {
  const { doc, ev } = c, P = ev.values, po = ev.partOpacity;
  for (let i = 0; i < P.length; i++) P[i] = doc.params[i].default;
  po.fill(1);
  // standard sources through the rig's own tracking bindings (ParamAngleX → an Inochi2D "Head Yaw" with its range …);
  // only the sources the request names, so a rig's resting values stay as authored
  const named = Object.keys(req.std ?? {});
  if (named.length) {
    const std = { ...NEUTRAL, ...req.std } as Record<string, number>;
    applyBindings(c.bindings.filter((b) => named.includes(b.src)), std, NEUTRAL_FRAME, (id) => c.info.get(id) ?? null, (id, _axis, v) => { const i = c.pIdx.get(id); if (i !== undefined) P[i] = v; });
  }
  for (const [id, v] of Object.entries(req.params ?? {})) { const i = c.pIdx.get(id); if (i !== undefined && Number.isFinite(v)) P[i] = v; }
  if (req.expression) {
    const e = (doc.expressions ?? []).find((x) => x.id === req.expression || x.name === req.expression);
    if (!e) throw new Error(`no expression ${req.expression}`);
    for (const q of e.params) {
      const i = c.pIdx.get(q.param);
      if (i === undefined) continue;
      P[i] = q.blend === 'overwrite' ? q.value : q.blend === 'add' ? P[i] + q.value : P[i] * q.value;
    }
    for (const q of e.parts ?? []) { const i = c.partIdx.get(q.part); if (i !== undefined) po[i] = q.opacity; }
  }
  new SwitchFader(doc).update(100, P, po);                 // part switches settled (arm variants …)
  const on = new Set(req.layers ?? (doc.layers ?? []).filter((l) => l.on).map((l) => l.id));
  const groupOn = new Set((doc.layers ?? []).filter((l) => on.has(l.id) && l.group).map((l) => l.group!));
  for (const l of doc.layers ?? []) {
    const shown = on.has(l.id) && !(l.group && groupOn.has(l.group) && req.layers === undefined && !l.on);
    if (!shown) for (const p of l.parts) { const i = c.partIdx.get(p); if (i !== undefined) po[i] = 0; }
  }
  if (doc.views?.sets.length) {                            // multi-angle views: the set nearest the value shows
    const v = doc.views.by.startsWith('role:') ? (req.std?.[doc.views.by.slice(5) as Rig2DStdSource] ?? 0) : P[c.pIdx.get(doc.views.by) ?? -1] ?? 0;
    let best = doc.views.sets[0];
    for (const s of doc.views.sets) if (Math.abs(s.at - v) < Math.abs(best.at - v)) best = s;
    const keep = new Set(best.parts);
    for (const s of doc.views.sets) if (s !== best) for (const p of s.parts) if (!keep.has(p)) { const i = c.partIdx.get(p); if (i !== undefined) po[i] = 0; }
  }
  const out = ev.update();
  return {
    positions: out.positions.map((p) => Float32Array.from(p)),
    opacity: Array.from(out.opacity, (x) => +x.toFixed(4)),
    enabled: Array.from(out.enabled),
    order: Array.from(out.order.subarray(0, out.orderCount)),
    params: Object.fromEntries(doc.params.map((p, i) => [p.id, +P[i].toFixed(4)])),
  };
}

/** The poses the pipeline asks for (blender/live2d: analyze, references, eyefit, hair2d turns, turnaround.turn_profile). */
export function defaultPoses(c: Ctx): PoseReq[] {
  // written exactly as the pipeline asks (analyze base / mouth probe, references, hair2d + turn profile turns)
  const L: PoseReq[] = [
    { key: 'rest', pipe: { ParamMouthOpenY: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 } },
    { key: 'mouth_open', pipe: { ParamMouthOpenY: 1, ParamEyeLOpen: 1, ParamEyeROpen: 1 } },
    { key: 'blink', pipe: { ParamMouthOpenY: 0, ParamEyeLOpen: 0, ParamEyeROpen: 0 } },
    { key: 'head', pipe: { ParamAngleX: 0, ParamBodyAngleX: 0, ParamMouthOpenY: 0 } },
  ];
  for (const a of [-30, 30]) L.push({ key: `hair_turn${a}`, pipe: { ParamAngleX: a, ParamMouthOpenY: 0 } });
  for (const a of [-30, -20, -10, 0, 10, 20, 30]) L.push({ key: `turn${a}`, pipe: { ParamAngleX: a, ParamBodyAngleX: 0 } });
  for (const a of [-30, 30]) L.push({ key: `ref_turn${a}`, pipe: { ParamAngleX: a, ParamBodyAngleX: a / 3, ParamMouthOpenY: 0 } });
  for (const e of c.doc.expressions ?? []) L.push({ key: `expr_${safeKey(e.id)}`, expression: e.id, pipe: { ParamMouthOpenY: 0 } });
  for (const l of c.doc.layers ?? []) L.push({ key: `layer_${safeKey(l.id)}`, layers: [l.id], pipe: { ParamMouthOpenY: 0 } });
  return L;
}

export const safeKey = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'x';

// ---------------------------------------------------------------- structure: what moves each mesh
function meshParamSets(c: Ctx) {
  const d = c.doc;
  const gridParams = (g: number) => (d.grids[g]?.axes ?? []).map((a) => d.params[a.param]?.id).filter(Boolean) as string[];
  const bsOn = (kind: string, index: number) => (d.blendShapes ?? []).filter((b) => b.target.kind === kind && b.target.index === index)
    .flatMap((b) => [d.params[b.param]?.id, b.param2 !== undefined ? d.params[b.param2]?.id : undefined]).filter(Boolean) as string[];
  const defParams = (k: number) => [...gridParams(d.deformers[k].grid), ...bsOn(d.deformers[k].kind, k)];
  const boneParams = (bi: number): string[] => { const out: string[] = []; for (let b = bi; b >= 0 && b < (d.bones ?? []).length; b = d.bones![b].parent) out.push(...gridParams(d.bones![b].grid)); return out; };
  return d.meshes.map((m, mi) => {
    const chain: number[] = [];
    for (let k = m.deformer; k >= 0 && chain.length < 64; k = d.deformers[k].parent) chain.push(k);
    const own = new Set([...gridParams(m.grid), ...bsOn('mesh', mi), ...chain.slice(0, 2).flatMap(defParams)]);
    const all = new Set([...own, ...chain.flatMap(defParams)]);
    for (let p = m.part; p >= 0 && p < d.parts.length; p = d.parts[p].parent) for (const id of gridParams(d.parts[p].grid)) all.add(id);
    if (m.skin) {
      const j = viewArray(c.buffers, m.skin.joints);
      const used = new Set<number>(); for (let i = 0; i < j.length; i++) used.add(j[i]);
      for (const b of used) for (const id of boneParams(b)) all.add(id);
    }
    return { own: [...own], all: [...all], chain: chain.map((k) => d.deformers[k].id) };
  });
}

const BLEND: Record<string, number> = { normal: 0, add: 1, multiply: 2, screen: 1 };

/** Everything the pipeline (and the AI's bundle sections) needs, plus the default poses. */
export async function exportBundle(file: string, outDir: string, log: (s: string) => void = () => {}) {
  const c = await openRig(file);
  const d = c.doc;
  fs.mkdirSync(path.join(outDir, 'textures'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'poses'), { recursive: true });
  // the rig itself next to the bundle: `eval` evaluates any further pose from it
  if (path.resolve(file) !== path.resolve(outDir, 'model.vtp2')) fs.copyFileSync(file, path.join(outDir, 'model.vtp2'));
  const textures = d.textures.map((t, i) => {
    const data = c.files.get(t.file);
    if (!data) throw new Error(`texture ${t.file} missing`);
    const name = `tex${i}${path.extname(t.file).toLowerCase() || '.png'}`;
    fs.writeFileSync(path.join(outDir, 'textures', name), data);
    return { file: `textures/${name}`, width: t.width, height: t.height, sheet: t.sheet ?? null };
  });
  // geometry: uvs + triangles, one binary file
  const chunks: Buffer[] = [];
  let off = 0;
  const put = (a: Float32Array | Int32Array) => { const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength); chunks.push(Buffer.from(b)); const o = off; off += b.length; return o; };
  const sets = meshParamSets(c);
  const aliases = stdAliases(c);
  const aliasOf = new Map<string, string[]>();   // rig param → standard ids it answers for
  for (const [sid, a] of Object.entries(aliases)) for (const p of a.params) aliasOf.set(p, [...(aliasOf.get(p) ?? []), sid]);
  const withStd = (ids: string[]) => [...new Set(ids.flatMap((id) => [id, ...(aliasOf.get(id) ?? [])]))];
  const meshes = d.meshes.map((m, i) => {
    const uv = Float32Array.from(viewArray(c.buffers, m.uvs) as Float32Array);
    const idx = Int32Array.from(viewArray(c.buffers, m.indices));
    return {
      id: m.id, name: m.name, part: m.part, deformer: m.deformer, texture: m.texture, vertexCount: m.vertexCount,
      blend: BLEND[m.blend] ?? 0, blendName: m.blend, masks: m.masks, maskInvert: !!m.maskInvert, visible: m.visible, enabled: m.enabled,
      uvOffset: put(uv), triOffset: put(idx), triCount: idx.length / 3,
      ownParams: withStd(sets[i].own), allParams: withStd(sets[i].all), deformerChain: sets[i].chain,
    };
  });
  fs.writeFileSync(path.join(outDir, 'geom.bin'), Buffer.concat(chunks));
  const poses = defaultPoses(c);
  const poseIndex = writePoses(c, outDir, poses);
  const pxu = d.canvas.unit ?? 1;
  const bundle = {
    format: 'vtp.pro2d-bundle', version: BUNDLE_VERSION,
    name: d.meta.name, meta: { source: d.meta.source ?? null, rights: d.meta.rights ?? null, license: d.meta.license ?? null, authors: d.meta.authors ?? [] },
    canvas: { ppu: pxu, ox: d.canvas.originX ?? 0, oy: d.canvas.originY ?? 0, w: d.canvas.width, h: d.canvas.height },
    params: d.params.map((p) => ({ id: p.id, name: p.name, min: p.min, max: p.max, default: p.default, kind: p.kind ?? null, group: p.group ?? null })),
    parts: d.parts.map((p) => ({ id: p.id, name: p.name, parent: p.parent, visible: p.visible, enabled: p.enabled })),
    deformers: d.deformers.map((f) => ({ id: f.id, name: f.name, kind: f.kind, parent: f.parent, part: f.part })),
    meshes, textures,
    roles: { eyeBlink: d.roles.eyeBlink, lipSync: d.roles.lipSync, bind: d.roles.bind ?? null },
    bindings: c.bindings.filter((b) => !b.off).map((b) => ({ src: b.src, param: b.param })),
    stdAliases: aliases,
    physics: (d.physics ?? []).map((p) => ({ id: p.id, inputs: p.inputs.map((q) => q.param ?? null), outputs: p.outputs.map((q) => q.param ?? null), particles: p.particles.length,
      mobility: p.particles.length ? +(p.particles.reduce((s, q) => s + (q.mobility ?? 0), 0) / p.particles.length).toFixed(3) : null })),
    dynamics: (d.dynamics ?? []).map((x) => ({ id: x.id, kind: x.kind, input: x.input ?? null, output: x.output ?? null, bones: x.bones ?? [], stiffness: x.stiffness ?? null, damping: x.damping ?? null })),
    expressions: (d.expressions ?? []).map((e) => ({ id: e.id, name: e.name, key: e.key ?? null, params: e.params, parts: e.parts ?? [] })),
    layers: (d.layers ?? []).map((l) => ({ id: l.id, name: l.name, group: l.group ?? null, on: l.on, parts: l.parts })),
    bones: (d.bones ?? []).map((b) => ({ id: b.id, name: b.name, parent: b.parent })),
    views: d.views ? { by: d.views.by, sets: d.views.sets.map((s) => ({ id: s.id, at: s.at })) } : null,
    poses: poseIndex,
  };
  fs.writeFileSync(path.join(outDir, 'bundle.json'), JSON.stringify(bundle));
  log(`bundle: ${meshes.length} meshes, ${d.params.length} parameters, ${poses.length} poses, aliases ${Object.keys(aliases).join(', ') || 'none'}`);
  return bundle;
}

/** Evaluate poses into <outDir>/poses (positions .bin + an index entry each); returns the index entries. */
export function writePoses(c: Ctx, outDir: string, reqs: PoseReq[]) {
  fs.mkdirSync(path.join(outDir, 'poses'), { recursive: true });
  const index: Record<string, unknown>[] = [];
  const aliases = stdAliases(c);
  for (const r0 of reqs) {
    const r = normalizeReq(c, r0, aliases);
    const key = safeKey(r.key ?? poseKey(r));
    const p = evalPose(c, r);
    const counts = p.positions.map((x) => x.length);
    const flat = new Float32Array(counts.reduce((s, n) => s + n, 0));
    let o = 0; for (const x of p.positions) { flat.set(x, o); o += x.length; }
    fs.writeFileSync(path.join(outDir, 'poses', `${key}.bin`), Buffer.from(flat.buffer));
    index.push({ key, req: { params: r.params ?? {}, std: r.std ?? {}, expression: r.expression ?? null, layers: r.layers ?? null }, file: `poses/${key}.bin`, opacity: p.opacity, enabled: p.enabled, order: p.order, values: p.params });
  }
  return index;
}

/** Stable key for an ad-hoc pose (the Python side caches by it). */
export function poseKey(r: PoseReq): string {
  const j = JSON.stringify({ p: Object.entries(r.params ?? {}).sort(), s: Object.entries(r.std ?? {}).sort(), e: r.expression ?? null, l: r.layers ?? null });
  let h = 2166136261; for (let i = 0; i < j.length; i++) { h ^= j.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `q${(h >>> 0).toString(36)}`;
}

async function main(argv: string[]) {
  const [cmd, a, b] = argv;
  if (cmd === 'export' && a && b) {
    await exportBundle(path.resolve(a), path.resolve(b), (s) => process.stderr.write(s + '\n'));
    process.stdout.write('PRO2D_BUNDLE_OK\n');
    return 0;
  }
  if (cmd === 'eval' && a) {
    const dir = path.resolve(a);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'bundle.json'), 'utf8')) as { source?: string };
    const src = path.join(dir, 'model.vtp2');
    if (!fs.existsSync(src)) throw new Error(`no model.vtp2 in ${dir}`);
    void meta;
    const reqs = JSON.parse(fs.readFileSync(0, 'utf8')) as PoseReq[];
    if (!Array.isArray(reqs) || reqs.length > 200) throw new Error('eval: give a JSON array of up to 200 poses on stdin');
    const c = await openRig(src);
    process.stdout.write(JSON.stringify(writePoses(c, dir, reqs)) + '\n');
    return 0;
  }
  process.stderr.write('usage: pro2d_bundle export <in.vtp2> <outDir> | eval <outDir> (poses JSON on stdin)\n');
  return 2;
}

if (/pro2d_bundle\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`PRO2D_BUNDLE_FAIL ${(e as Error).message}\n`); process.exit(1); });
}
