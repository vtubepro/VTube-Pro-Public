// Live2D model → VTube Pro .vtp2 rig, on import. Reads the model's own files (model3.json, .moc3 through our clean-room
// reader, textures, physics3 / motion3 / exp3 / pose3 / cdi3 JSON) and writes our format; the original files are not
// kept. Nothing of Live2D's software is used. The user must have the right to use the model (the import dialog says
// so in one line; artists' licences still apply).
//
// The conversion is structurally 1:1 (tools/rig2d_import_gate.ts checks every count and value against the source):
// parameters, keyform grids, parts, warp / rotation deformers, art meshes (uvs, triangles, keyform positions, opacity,
// draw order, blend mode, culling, masks incl. inverted), multiply / screen colours, glue, blend shapes (mesh, warp,
// rotation, part, glue targets), draw-order groups, physics settings, motions (linear / Bézier / stepped / inverse
// stepped segments + fades), expressions (add / multiply / overwrite), part switches, eye-blink / lip-sync groups,
// hit areas, display names.
//
// Real users' files (tools/live2d_chaos_unit.ts): forgiving JSON (BOM, comments, trailing commas, numbers as strings),
// absolute / backslash paths, PNG / JPEG / WebP textures, a model3.json that lists no textures (Cubism's
// "<model>.<size>/texture_NN.png" folder is used), and VTube Studio's sidecar (*.vtube.json): its parameter mapping
// (stored as extra.vtsBindings, used by the runtime's auto-mapper), its expression / animation hotkeys and its idle
// animation; *.exp3.json / *.motion3.json files next to the model that the model3.json doesn't list (VTube Studio loads
// those too) are converted as well. Everything is capped to the format's limits, so a converted rig always validates.
import { BufferBuilder, type Rig2DPackage } from '../container.ts';
import { RIG2D, RIG2D_LIMITS, type Rig2DDoc } from '../format.ts';
import { Moc3Error, ids, need, num, readMoc3, span, type Moc3 } from './moc3.ts';
import { looseNum, parseLooseJson } from './json.ts';
import { checkImage } from './image.ts';
import { IMPORT_LIMITS } from '../limits.ts';
import { vtsKeyCombo, vtsTrackedParams } from '../vtsImport.ts';
import { reservedKey } from '../../studioKeys.ts';
import { expressionKeys, keyLabel } from '../userParams.ts';

export interface ConvertInput {
  /** The .model3.json path (relative; other files are resolved against its folder). */
  model3: string;
  /** Read a file by path (relative to the same root as model3); null when missing. */
  read(path: string): Uint8Array | null;
  /** ISO time for meta.source.at (tests pass a fixed one). */
  now?: string;
  /** Every file of the upload (paths as read() takes them): finds side files the model3.json doesn't list (VTube
   *  Studio's *.vtube.json, extra *.exp3.json / *.motion3.json, a texture folder). Optional. */
  list?(): readonly string[];
}
export interface ConvertResult { pkg: Rig2DPackage; warnings: string[]; stats: Record<string, number> }

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 256) => (typeof v === 'string' ? v.slice(0, max) : '');
const fnum = looseNum;
/** UTF-8 length of a string without encoding it */
export function utf8Bytes(s: string): number { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3; } return n; }
/** Names that must never become object keys downstream. */
const safeName = (s: string) => (/^(__proto__|constructor|prototype)$/.test(s) ? `_${s}` : s);

/** Join a reference onto a folder; null when unsafe or leaving the root. */
export function joinRel(dir: string, ref: string): string | null {
  if (!ref || ref.length > 300 || /^[a-z]+:/i.test(ref) || ref.startsWith('/') || /[\x00-\x1f]/.test(ref)) return null;
  const parts = (dir ? `${dir}/${ref.replace(/\\/g, '/')}` : ref.replace(/\\/g, '/')).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { if (!out.length) return null; out.pop(); continue; }
    out.push(p);
  }
  return out.length ? out.join('/') : null;
}

function json(input: ConvertInput, path: string | null, warnings: string[], what: string): unknown {
  if (!path) return null;
  const b = input.read(path);
  if (!b) { warnings.push(`${what} (${path}) is missing: skipped.`); return null; }
  if (b.byteLength > IMPORT_LIMITS.sideJsonBytes) { warnings.push(`${what} (${path}) is too big: skipped.`); return null; }
  const j = parseLooseJson(b);
  if (j === null) warnings.push(`${what} (${path}) is not valid JSON: skipped.`);
  return j;
}

// ---------------------------------------------------------------- VTube Studio sidecar (*.vtube.json)
/** VTube Studio's tracking inputs → our standard sources: the input's range in VTube Studio and the same range in our
 *  units. `natural`: VTube Studio's own scale differs from ours (eye / mouth openness, voice), so only the target
 *  parameter and the direction are taken from the user's mapping. */
export const VTS_INPUT: Record<string, { src: string; vts: [number, number]; ours: [number, number]; natural?: boolean }> = {
  FaceAngleX: { src: 'headYaw', vts: [-30, 30], ours: [-30, 30] }, FaceAngleY: { src: 'headPitch', vts: [-30, 30], ours: [-30, 30] }, FaceAngleZ: { src: 'headRoll', vts: [-30, 30], ours: [-30, 30] },
  EyeOpenLeft: { src: 'eyeOpenL', vts: [0, 1], ours: [0, 1], natural: true }, EyeOpenRight: { src: 'eyeOpenR', vts: [0, 1], ours: [0, 1], natural: true },
  EyeLeftX: { src: 'gazeX', vts: [-1, 1], ours: [1, -1] }, EyeRightX: { src: 'gazeX', vts: [-1, 1], ours: [1, -1] },
  EyeLeftY: { src: 'gazeY', vts: [-1, 1], ours: [-1, 1] }, EyeRightY: { src: 'gazeY', vts: [-1, 1], ours: [-1, 1] },
  Brows: { src: 'browLY', vts: [0, 1], ours: [-1, 1] }, BrowLeftY: { src: 'browLY', vts: [0, 1], ours: [-1, 1] }, BrowRightY: { src: 'browRY', vts: [0, 1], ours: [-1, 1] },
  MouthSmile: { src: 'mouthForm', vts: [0, 1], ours: [-1, 1] }, MouthOpen: { src: 'mouthOpen', vts: [0, 1], ours: [0, 1], natural: true },
  VoiceVolume: { src: 'voice', vts: [0, 1], ours: [0, 1], natural: true }, VoiceVolumePlusMouthOpen: { src: 'mouthOpen', vts: [0, 1], ours: [0, 1], natural: true },
  CheekPuff: { src: 'cheek', vts: [0, 1], ours: [0, 1] },
};
/** A VTube Studio hotkey's keys → a KeyboardEvent.code (single keys only; null = a combo / modifier / unknown key). */
export function vtsKey(t: Record<string, unknown>): string | null {
  const k1 = typeof t.Trigger1 === 'string' ? t.Trigger1.trim() : '', more = [t.Trigger2, t.Trigger3].some((x) => typeof x === 'string' && x.trim());
  if (!k1 || more) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(?:N|Num|Alpha|Digit)([0-9])$/.exec(k1))) return `Digit${m[1]}`;
  if ((m = /^(?:Numpad|Keypad)([0-9])$/.exec(k1))) return `Numpad${m[1]}`;
  if (/^[A-Z]$/.test(k1)) return `Key${k1}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k1)) return k1;
  return null;
}

/** PNG width / height from its IHDR. */
export function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return [dv.getUint32(16, false), dv.getUint32(20, false)];
}

export function convertLive2D(input: ConvertInput): ConvertResult {
  const warnings: string[] = [];
  const dir = input.model3.includes('/') ? input.model3.slice(0, input.model3.lastIndexOf('/')) : '';
  const m3raw = input.read(input.model3);
  if (!m3raw) throw new Moc3Error('The .model3.json is missing.');
  const m3j = parseLooseJson(m3raw);
  if (m3j === null || typeof m3j !== 'object' || Array.isArray(m3j)) throw new Moc3Error('The .model3.json is not valid JSON.');
  const m3 = m3j as Record<string, unknown>;
  const fr = obj(m3.FileReferences);
  // a path from the artist's PC ("C:\Users\…\texture_00.png", "/Users/…") → its file name, found next to the model
  const ref = (v: unknown) => {
    const s = str(v, 300).trim();
    if (!s) return null;
    const j = joinRel(dir, s);
    if (j) return j;
    const nm = s.replace(/\\/g, '/').split('/').pop() ?? '';
    return nm && nm !== '..' ? joinRel(dir, nm) : null;
  };
  // a named side file that isn't there under that name (renamed, or its name mangled by a zip tool): the ONLY file of
  // that kind in the model's own folder (never when the folder holds several models)
  const pre0 = dir ? `${dir}/` : '';
  const own = input.list ? input.list().filter((p) => p.startsWith(pre0)) : [];
  const soleModel = own.filter((p) => /\.model3\.json$/i.test(p)).length === 1;
  const orOnly = (p: string | null, kind: RegExp, named: boolean): string | null => {
    if (p && input.read(p)) return p;
    if (!named || !soleModel) return p;
    const c = own.filter((x) => kind.test(x));
    if (c.length !== 1) return p;
    warnings.push(`${p ?? 'A file'} not found: used ${c[0]}.`);
    return c[0];
  };
  const mocPath = orOnly(ref(fr.Moc), /\.moc3$/i, true);
  if (!mocPath) throw new Moc3Error('The .model3.json names no .moc3.');
  const mocBytes = input.read(mocPath);
  if (!mocBytes) throw new Moc3Error(`${mocPath} is missing.`);
  const moc = readMoc3(mocBytes);
  const C = moc.counts, S = moc.s;
  const B = new BufferBuilder(0);

  // ---------------------------------------------------------------- display names (cdi3)
  const cdi = obj(json(input, orOnly(ref(fr.DisplayInfo), /\.cdi3\.json$/i, !!fr.DisplayInfo), warnings, 'Display names'));
  const pName = new Map<string, string>(), partName = new Map<string, string>(), pGroup = new Map<string, string>();
  for (const p of arr(cdi.Parameters)) { const o = obj(p); if (str(o.Id)) { pName.set(str(o.Id), str(o.Name)); if (str(o.GroupId)) pGroup.set(str(o.Id), str(o.GroupId)); } }
  for (const p of arr(cdi.Parts)) { const o = obj(p); if (str(o.Id)) partName.set(str(o.Id), str(o.Name)); }

  // ---------------------------------------------------------------- parameters
  const paramIds = ids(moc, 'params');
  need(paramIds.length === C.params, 'parameter ids');
  const pMin = num(moc, 'params', 'min'), pMax = num(moc, 'params', 'max'), pDef = num(moc, 'params', 'default'), pRep = num(moc, 'params', 'repeat'), pDec = num(moc, 'params', 'decimals');
  const pType = moc.version >= 4 ? num(moc, 'params', 'ptype') : new Uint32Array(C.params);
  const seenIds = new Set<string>();
  const params: Rig2DDoc['params'] = paramIds.map((id, i) => {
    let pid = id || `Param${i}`;
    if (seenIds.has(pid)) { pid = `${pid}_${i}`; warnings.push(`Duplicate parameter id ${id}: renamed ${pid}.`); }
    seenIds.add(pid);
    const lo = Math.min(pMin[i], pMax[i]), hi = Math.max(pMin[i], pMax[i]);
    return { id: pid, name: (pName.get(id) || id).slice(0, 256), min: lo, max: hi, default: Math.min(hi, Math.max(lo, pDef[i])),
      ...(pRep[i] ? { repeat: true } : {}), ...(pType[i] === 1 ? { kind: 'blend' as const } : {}), ...(pGroup.has(id) ? { group: pGroup.get(id)!.slice(0, 128) } : {}),
      ...(pDec[i] <= 8 ? { decimals: pDec[i] } : {}) };
  });
  // parameter binding → parameter
  const pbParam = new Int32Array(C.pBind).fill(-1);
  const pbBegin = num(moc, 'params', 'pbBegin'), pbCount = num(moc, 'params', 'pbCount');
  for (let p = 0; p < C.params; p++) { need(span(pbBegin[p], pbCount[p], C.pBind), 'parameter bindings'); for (let k = pbBegin[p]; k < pbBegin[p] + pbCount[p]; k++) pbParam[k] = p; }
  const keysBegin = num(moc, 'pBind', 'keysBegin'), keysCount = num(moc, 'pBind', 'keysCount'), keyVals = num(moc, 'keys', 'values');

  // ---------------------------------------------------------------- keyform grids (one per keyform binding)
  const grids: Rig2DDoc['grids'] = [];
  const gridSize: number[] = [];
  const pbiBegin = num(moc, 'kfBind', 'pbiBegin'), pbiCount = num(moc, 'kfBind', 'pbiCount'), pbSrc = num(moc, 'pbIdx', 'src');
  for (let kb = 0; kb < C.kfBind; kb++) {
    need(span(pbiBegin[kb], pbiCount[kb], C.pbIdx), 'keyform binding');
    need(pbiCount[kb] <= 8, 'too many parameters on one keyform binding');
    const axes: Rig2DDoc['grids'][number]['axes'] = [];
    let n = 1;
    for (let a = pbiBegin[kb]; a < pbiBegin[kb] + pbiCount[kb]; a++) {
      const pb = pbSrc[a];
      need(pb >= 0 && pb < C.pBind && pbParam[pb] >= 0, 'binding parameter');
      need(span(keysBegin[pb], keysCount[pb], C.keys) && keysCount[pb] >= 1 && keysCount[pb] <= 256, 'binding keys');
      const keys = Array.from(keyVals.subarray(keysBegin[pb], keysBegin[pb] + keysCount[pb]) as Float32Array);
      for (let k = 1; k < keys.length; k++) need(keys[k] > keys[k - 1], 'binding keys not increasing');
      axes.push({ param: pbParam[pb], keys });
      n *= keys.length;
    }
    grids.push({ axes });
    gridSize.push(n);
  }
  const staticGrid = grids.length; grids.push({ axes: [] }); gridSize.push(1);
  const gridOf = (kb: number, kfCount: number, what: string) => {
    if (kb < 0 || kb >= C.kfBind) { need(kfCount === 1, `${what}: keyforms without a binding`); return staticGrid; }
    need(gridSize[kb] === kfCount, `${what}: keyform count ${kfCount} vs grid ${gridSize[kb]}`);
    return kb;
  };

  // ---------------------------------------------------------------- colours (v4 per object, v5 per keyform)
  const mulR = num(moc, 'mulCol', 'r'), mulG = num(moc, 'mulCol', 'g'), mulB = num(moc, 'mulCol', 'b');
  const scrR = num(moc, 'scrCol', 'r'), scrG = num(moc, 'scrCol', 'g'), scrB = num(moc, 'scrCol', 'b');
  const colorKeys = (kfSec: 'warpKF' | 'rotKF' | 'artKF', objSec: 'warps' | 'rots' | 'arts', o: number, kfBegin: number, kfCount: number) => {
    if (moc.version < 4 || !C.mulCol) return undefined;
    const mul: number[] = [], scr: number[] = [];
    let any = false;
    for (let k = 0; k < kfCount; k++) {
      let mi: number, si: number;
      if (moc.version >= 5) { mi = num(moc, kfSec, 'mulBegin')[kfBegin + k]; si = num(moc, kfSec, 'scrBegin')[kfBegin + k]; }
      else { const cb = num(moc, objSec, 'colBegin')[o]; mi = si = cb >= 0 ? cb + k : -1; }
      const m = mi >= 0 && mi < C.mulCol ? [mulR[mi], mulG[mi], mulB[mi]] : [1, 1, 1];
      const s = si >= 0 && si < C.scrCol ? [scrR[si], scrG[si], scrB[si]] : [0, 0, 0];
      if (m.some((x) => x !== 1) || s.some((x) => x !== 0)) any = true;
      mul.push(...m); scr.push(...s);
    }
    return any ? { multiply: B.f32(mul), screen: B.f32(scr) } : undefined;
  };

  // ---------------------------------------------------------------- parts
  const partIds = ids(moc, 'parts');
  const parts: Rig2DDoc['parts'] = [];
  {
    const kbSrc = num(moc, 'parts', 'kbSrc'), kfB = num(moc, 'parts', 'kfBegin'), kfC = num(moc, 'parts', 'kfCount'), vis = num(moc, 'parts', 'visible'), en = num(moc, 'parts', 'enabled'), par = num(moc, 'parts', 'parentPart');
    const dOrd = num(moc, 'partKF', 'drawOrders');
    for (let i = 0; i < C.parts; i++) {
      need(span(kfB[i], kfC[i], C.partKF) && kfC[i] >= 1, `part ${i} keyforms`);
      need(par[i] >= -1 && par[i] < C.parts && par[i] !== i, `part ${i} parent`);
      parts.push({ id: partIds[i] || `Part${i}`, name: (partName.get(partIds[i]) || partIds[i] || `Part${i}`).slice(0, 256), parent: par[i], grid: gridOf(kbSrc[i], kfC[i], `part ${i}`),
        drawOrder: Array.from(dOrd.subarray(kfB[i], kfB[i] + kfC[i]) as Float32Array), visible: !!vis[i], enabled: !!en[i] });
    }
  }

  // ---------------------------------------------------------------- deformers
  const defIds = ids(moc, 'deformers');
  const deformers: Rig2DDoc['deformers'] = [];
  const warpToDef = new Int32Array(C.warps).fill(-1), rotToDef = new Int32Array(C.rots).fill(-1);
  const kfPos = num(moc, 'kfPos', 'xys') as Float32Array;
  {
    const kbSrc = num(moc, 'deformers', 'kbSrc'), vis = num(moc, 'deformers', 'visible'), en = num(moc, 'deformers', 'enabled'), pp = num(moc, 'deformers', 'parentPart'),
      pd = num(moc, 'deformers', 'parentDeformer'), ty = num(moc, 'deformers', 'types'), sp = num(moc, 'deformers', 'specific');
    const wKb = num(moc, 'warps', 'kbSrc'), wB = num(moc, 'warps', 'kfBegin'), wC = num(moc, 'warps', 'kfCount'), wV = num(moc, 'warps', 'vertexCounts'), wR = num(moc, 'warps', 'rows'), wCo = num(moc, 'warps', 'cols');
    const wQ = moc.version >= 2 ? num(moc, 'warps', 'isQuad') : new Uint32Array(C.warps);
    const wOp = num(moc, 'warpKF', 'opacities'), wPos = num(moc, 'warpKF', 'posBegin');
    const rKb = num(moc, 'rots', 'kbSrc'), rB = num(moc, 'rots', 'kfBegin'), rC = num(moc, 'rots', 'kfCount'), rBase = num(moc, 'rots', 'baseAngles');
    const rOp = num(moc, 'rotKF', 'opacities'), rAng = num(moc, 'rotKF', 'angles'), rOx = num(moc, 'rotKF', 'ox'), rOy = num(moc, 'rotKF', 'oy'), rSc = num(moc, 'rotKF', 'scales'),
      rRx = num(moc, 'rotKF', 'reflectX'), rRy = num(moc, 'rotKF', 'reflectY');
    for (let i = 0; i < C.deformers; i++) {
      need(pd[i] >= -1 && pd[i] < C.deformers && pd[i] !== i, `deformer ${i} parent`);
      need(pp[i] >= -1 && pp[i] < C.parts, `deformer ${i} part`);
      const base = { id: defIds[i] || `Deformer${i}`, name: (defIds[i] || `Deformer${i}`).slice(0, 256), parent: pd[i], part: pp[i], enabled: !!en[i], visible: !!vis[i] };
      void kbSrc;
      if (ty[i] === 0) {
        const w = sp[i];
        need(w >= 0 && w < C.warps && warpToDef[w] < 0, `deformer ${i} warp index`);
        warpToDef[w] = i;
        need(span(wB[w], wC[w], C.warpKF) && wC[w] >= 1, `warp ${w} keyforms`);
        need(wR[w] >= 1 && wCo[w] >= 1 && wR[w] <= 256 && wCo[w] <= 256 && wV[w] === (wR[w] + 1) * (wCo[w] + 1), `warp ${w} lattice`);
        const pts = new Float32Array(wC[w] * wV[w] * 2);
        for (let k = 0; k < wC[w]; k++) {
          const pb = wPos[wB[w] + k];
          need(span(pb, wV[w] * 2, C.kfPos), `warp ${w} positions`);
          pts.set(kfPos.subarray(pb, pb + wV[w] * 2), k * wV[w] * 2);
        }
        const color = colorKeys('warpKF', 'warps', w, wB[w], wC[w]);
        deformers.push({ ...base, kind: 'warp', grid: gridOf(wKb[w], wC[w], `warp ${w}`), opacity: Array.from(wOp.subarray(wB[w], wB[w] + wC[w]) as Float32Array),
          warp: { rows: wR[w], cols: wCo[w], quad: !!wQ[w], points: B.add(pts, 'f32') }, ...(color ? { color } : {}) });
      } else if (ty[i] === 1) {
        const r = sp[i];
        need(r >= 0 && r < C.rots && rotToDef[r] < 0, `deformer ${i} rotation index`);
        rotToDef[r] = i;
        need(span(rB[r], rC[r], C.rotKF) && rC[r] >= 1, `rotation ${r} keyforms`);
        const sl = <A extends ArrayLike<number>>(a: A) => Array.from({ length: rC[r] }, (_, k) => a[rB[r] + k]);
        const color = colorKeys('rotKF', 'rots', r, rB[r], rC[r]);
        deformers.push({ ...base, kind: 'rotation', grid: gridOf(rKb[r], rC[r], `rotation ${r}`), opacity: sl(rOp),
          rotation: { baseAngle: rBase[r], angle: sl(rAng), originX: sl(rOx), originY: sl(rOy), scale: sl(rSc), reflectX: sl(rRx).map(Boolean), reflectY: sl(rRy).map(Boolean) },
          ...(color ? { color } : {}) });
      } else throw new Moc3Error(`Unknown deformer type ${ty[i]}.`);
    }
  }

  // ---------------------------------------------------------------- art meshes
  const artIds = ids(moc, 'arts');
  const meshes: Rig2DDoc['meshes'] = [];
  let textureFiles = arr(fr.Textures).map(ref);
  const texNeeded = C.arts ? (num(moc, 'arts', 'textureNo') as Uint32Array).reduce((a, t) => Math.max(a, Math.min(t, 1 << 20)), 0) + 1 : 0;
  if (texNeeded > 256) throw new Moc3Error('The .moc3 is damaged: texture index.');
  if (textureFiles.length < texNeeded && input.list) {
    // no Textures list (hand-edited model3.json): Cubism's export folder "<name>.<size>/texture_NN.png" next to the model
    const pre = dir ? `${dir}/` : '';
    const found = input.list().filter((p) => p.startsWith(pre) && /^[^/]*\/texture_\d+\.(png|jpe?g|webp)$/i.test(p.slice(pre.length)));
    const folders = [...new Set(found.map((p) => p.slice(0, p.lastIndexOf('/'))))].sort((a, b) => (Number(/\.(\d+)$/.exec(b)?.[1] ?? 0) - Number(/\.(\d+)$/.exec(a)?.[1] ?? 0)));
    const pick = folders.map((d) => found.filter((p) => p.startsWith(`${d}/`)).sort((a, b) => Number(/(\d+)\.[^.]+$/.exec(a)![1]) - Number(/(\d+)\.[^.]+$/.exec(b)![1]))).find((l) => l.length >= texNeeded);
    if (pick) {
      textureFiles = pick;
      warnings.push(`The .model3.json lists ${arr(fr.Textures).length} of ${texNeeded} textures: used ${pick.length} from ${pick[0].slice(0, pick[0].lastIndexOf('/'))}.`);
    }
  }
  if (textureFiles.length < texNeeded) throw new Moc3Error(textureFiles.length ? `Texture ${texNeeded - 1} (texture_${String(texNeeded - 1).padStart(2, '0')}.png) is missing.` : 'The texture pictures (texture_00.png …) are missing.');
  {
    const kbSrc = num(moc, 'arts', 'kbSrc'), kfB = num(moc, 'arts', 'kfBegin'), kfC = num(moc, 'arts', 'kfCount'), vis = num(moc, 'arts', 'visible'), en = num(moc, 'arts', 'enabled'),
      pp = num(moc, 'arts', 'parentPart'), pd = num(moc, 'arts', 'parentDeformer'), tex = num(moc, 'arts', 'textureNo'), flags = num(moc, 'arts', 'flags'), vc = num(moc, 'arts', 'vertexCounts'),
      uvB = num(moc, 'arts', 'uvBegin'), ixB = num(moc, 'arts', 'posIdxBegin'), ixC = num(moc, 'arts', 'posIdxCount'), mB = num(moc, 'arts', 'maskBegin'), mC = num(moc, 'arts', 'maskCount');
    const aOp = num(moc, 'artKF', 'opacities'), aDo = num(moc, 'artKF', 'drawOrders'), aPos = num(moc, 'artKF', 'posBegin');
    const uvs = num(moc, 'uvs', 'xys') as Float32Array, idx = num(moc, 'posIdx', 'indices') as Int16Array, maskArt = num(moc, 'masks', 'art');
    for (let i = 0; i < C.arts; i++) {
      const n = vc[i];
      need(n >= 1 && n <= 65535, `art mesh ${i} vertex count`);
      need(pd[i] >= -1 && pd[i] < C.deformers, `art mesh ${i} deformer`);
      need(pp[i] >= -1 && pp[i] < C.parts, `art mesh ${i} part`);
      need(span(kfB[i], kfC[i], C.artKF) && kfC[i] >= 1, `art mesh ${i} keyforms`);
      need(span(uvB[i], n * 2, C.uvs), `art mesh ${i} uvs`);
      need(span(ixB[i], ixC[i], C.posIdx) && ixC[i] % 3 === 0, `art mesh ${i} triangles`);
      need(tex[i] < Math.max(1, textureFiles.length), `art mesh ${i} texture ${tex[i]}`);
      const tri = new Uint16Array(ixC[i]);
      for (let k = 0; k < ixC[i]; k++) { const v = idx[ixB[i] + k] & 0xffff; need(v < n, `art mesh ${i} triangle index`); tri[k] = v; }
      const pos = new Float32Array(kfC[i] * n * 2);
      for (let k = 0; k < kfC[i]; k++) { const pb = aPos[kfB[i] + k]; need(span(pb, n * 2, C.kfPos), `art mesh ${i} positions`); pos.set(kfPos.subarray(pb, pb + n * 2), k * n * 2); }
      const masks: number[] = [];
      if (mC[i]) {
        need(span(mB[i], mC[i], C.masks) && mC[i] <= 64, `art mesh ${i} masks`);
        for (let k = mB[i]; k < mB[i] + mC[i]; k++) { const a = maskArt[k]; if (a >= 0 && a < C.arts && a !== i && !masks.includes(a)) masks.push(a); }
      }
      const fl = flags[i];
      const color = colorKeys('artKF', 'arts', i, kfB[i], kfC[i]);
      meshes.push({ id: artIds[i] || `ArtMesh${i}`, name: (artIds[i] || `ArtMesh${i}`).slice(0, 256), part: pp[i], deformer: pd[i], texture: tex[i], grid: gridOf(kbSrc[i], kfC[i], `art mesh ${i}`),
        vertexCount: n, uvs: B.add(uvs.slice(uvB[i], uvB[i] + n * 2), 'f32'), indices: B.add(tri, 'u16'), positions: B.add(pos, 'f32'),
        opacity: Array.from(aOp.subarray(kfB[i], kfB[i] + kfC[i]) as Float32Array), drawOrder: Array.from(aDo.subarray(kfB[i], kfB[i] + kfC[i]) as Float32Array),
        blend: (fl & 3) === 1 ? 'add' : (fl & 3) === 2 ? 'multiply' : 'normal', doubleSided: !!(fl & 4), masks, ...(fl & 8 ? { maskInvert: true } : {}),
        visible: !!vis[i], enabled: !!en[i], ...(color ? { color } : {}) });
      if ((fl & 3) === 3) warnings.push(`Art mesh ${artIds[i]} has an unknown blend mode: drawn normally.`);
    }
  }

  // ---------------------------------------------------------------- render order groups
  let drawGroups: Rig2DDoc['drawGroups'];
  if (C.dog) {
    const oB = num(moc, 'dog', 'objBegin'), oC = num(moc, 'dog', 'objCount'), oT = num(moc, 'dog', 'objTotal'), mx = num(moc, 'dog', 'maxOrder'), mn = num(moc, 'dog', 'minOrder');
    const ty = num(moc, 'dogObj', 'types'), ix = num(moc, 'dogObj', 'indices'), self = num(moc, 'dogObj', 'self');
    drawGroups = [];
    for (let g = 0; g < C.dog; g++) {
      need(span(oB[g], oC[g], C.dogObj) && oT[g] >= 0 && oT[g] <= C.arts + C.parts + C.dogObj, `draw order group ${g}`);
      const items: NonNullable<Rig2DDoc['drawGroups']>[number]['items'] = [];
      for (let j = oB[g]; j < oB[g] + oC[g]; j++) {
        const part = ty[j] === 1;
        need(ix[j] >= 0 && ix[j] < (part ? C.parts : C.arts), `draw order item ${j}`);
        need(self[j] >= -1 && self[j] < C.dog, `draw order item ${j} group`);
        items.push({ kind: part ? 'part' : 'mesh', index: ix[j], group: part ? self[j] : -1 });
      }
      drawGroups.push({ min: mn[g], max: mx[g], total: oT[g], items });
    }
  }

  // ---------------------------------------------------------------- glue
  const glueIds = ids(moc, 'glue');
  const glue: NonNullable<Rig2DDoc['glue']> = [];
  {
    const kbSrc = num(moc, 'glue', 'kbSrc'), kfB = num(moc, 'glue', 'kfBegin'), kfC = num(moc, 'glue', 'kfCount'), A = num(moc, 'glue', 'artA'), Bm = num(moc, 'glue', 'artB'),
      iB = num(moc, 'glue', 'infoBegin'), iC = num(moc, 'glue', 'infoCount');
    const gw = num(moc, 'glueInfo', 'weights') as Float32Array, gi = num(moc, 'glueInfo', 'posIdx') as Int16Array, it = num(moc, 'glueKF', 'intensities');
    for (let g = 0; g < C.glue; g++) {
      need(span(kfB[g], kfC[g], C.glueKF) && kfC[g] >= 1, `glue ${g} keyforms`);
      need(A[g] >= 0 && A[g] < C.arts && Bm[g] >= 0 && Bm[g] < C.arts, `glue ${g} meshes`);
      need(span(iB[g], iC[g], C.glueInfo) && iC[g] % 2 === 0, `glue ${g} pairs`);
      const pairs = new Int32Array(iC[g]);
      for (let k = 0; k < iC[g]; k++) { const v = gi[iB[g] + k] & 0xffff; need(v < meshes[k % 2 ? Bm[g] : A[g]].vertexCount, `glue ${g} vertex`); pairs[k] = v; }
      glue.push({ id: glueIds[g] || `Glue${g}`, a: A[g], b: Bm[g], grid: gridOf(kbSrc[g], kfC[g], `glue ${g}`), intensity: Array.from(it.subarray(kfB[g], kfB[g] + kfC[g]) as Float32Array),
        pairs: B.add(pairs, 'i32'), weights: B.add(gw.slice(iB[g], iB[g] + iC[g]), 'f32') });
    }
  }

  // ---------------------------------------------------------------- blend shapes (v4+)
  const blendShapes: NonNullable<Rig2DDoc['blendShapes']> = [];
  if (moc.version >= 4 && C.bsKBind) {
    const bsPbParam = new Int32Array(C.bsPBind).fill(-1);
    const bB = num(moc, 'params', 'bsPbBegin'), bC = num(moc, 'params', 'bsPbCount');
    for (let p = 0; p < C.params; p++) if (pType[p] === 1) { need(span(bB[p], bC[p], C.bsPBind), 'blend shape bindings'); for (let k = bB[p]; k < bB[p] + bC[p]; k++) bsPbParam[k] = p; }
    const kB = num(moc, 'bsPBind', 'keysBegin'), kC = num(moc, 'bsPBind', 'keysCount');
    const pbS = num(moc, 'bsKBind', 'pbSrc'), kfB = num(moc, 'bsKBind', 'kfBegin'), kfC = num(moc, 'bsKBind', 'kfCount'), cB = num(moc, 'bsKBind', 'conBegin'), cC = num(moc, 'bsKBind', 'conCount');
    const conIdx = num(moc, 'bsConIdx', 'src'), conP = num(moc, 'bsCon', 'param'), conVB = num(moc, 'bsCon', 'valBegin'), conVC = num(moc, 'bsCon', 'valCount');
    const conK = num(moc, 'bsConVal', 'keys'), conW = num(moc, 'bsConVal', 'weights');
    const one = (sec: 'bsArt' | 'bsWarp' | 'bsRot' | 'bsPart' | 'bsGlue') => {
      const tg = num(moc, sec, 'target'), kb = num(moc, sec, 'kbBegin'), kc = num(moc, sec, 'kbCount');
      for (let j = 0; j < C[sec]; j++) {
        need(span(kb[j], kc[j], C.bsKBind), `${sec} ${j}`);
        for (let a = kb[j]; a < kb[j] + kc[j]; a++) {
          const pb = pbS[a];
          need(pb >= 0 && pb < C.bsPBind && bsPbParam[pb] >= 0 && span(kB[pb], kC[pb], C.keys) && kC[pb] >= 1, `${sec} ${j} binding`);
          const keys = Array.from(keyVals.subarray(kB[pb], kB[pb] + kC[pb]) as Float32Array);
          need(kfC[a] === keys.length, `${sec} ${j} keyform count`);
          const constraints: { param: number; keys: number[]; weights: number[] }[] = [];
          need(span(cB[a], cC[a], C.bsConIdx), `${sec} ${j} constraints`);
          for (let c = cB[a]; c < cB[a] + cC[a]; c++) {
            const ci = conIdx[c];
            need(ci >= 0 && ci < C.bsCon && conP[ci] >= 0 && conP[ci] < C.params && span(conVB[ci], conVC[ci], C.bsConVal), `${sec} ${j} constraint`);
            constraints.push({ param: conP[ci], keys: Array.from(conK.subarray(conVB[ci], conVB[ci] + conVC[ci]) as Float32Array), weights: Array.from(conW.subarray(conVB[ci], conVB[ci] + conVC[ci]) as Float32Array) });
          }
          const t = tg[j], base = { param: bsPbParam[pb], keys, ...(constraints.length ? { constraints } : {}) };
          const kf = (k: number) => kfB[a] + k;
          if (sec === 'bsArt' || sec === 'bsWarp') {
            const isArt = sec === 'bsArt';
            need(t >= 0 && t < (isArt ? C.arts : C.warps), `${sec} ${j} target`);
            const n = isArt ? meshes[t].vertexCount : num(moc, 'warps', 'vertexCounts')[t];
            const posB = num(moc, isArt ? 'artKF' : 'warpKF', 'posBegin');
            need(span(kfB[a], kfC[a], isArt ? C.artKF : C.warpKF), `${sec} ${j} keyforms`);
            const off = new Float32Array(keys.length * n * 2);
            for (let k = 0; k < keys.length; k++) { const pb2 = posB[kf(k)]; need(span(pb2, n * 2, C.kfPos), `${sec} ${j} offsets`); off.set(kfPos.subarray(pb2, pb2 + n * 2), k * n * 2); }
            blendShapes.push({ target: { kind: isArt ? 'mesh' : 'warp', index: isArt ? t : warpToDef[t] }, ...base, offsets: B.add(off, 'f32') });
          } else if (sec === 'bsRot') {
            need(t >= 0 && t < C.rots && span(kfB[a], kfC[a], C.rotKF), `${sec} ${j}`);
            const g = (f: string) => Array.from({ length: keys.length }, (_, k) => num(moc, 'rotKF', f)[kf(k)]);
            const op = g('opacities');
            if (op.some((x) => x !== 0)) warnings.push('A rotation blend shape changes opacity: not converted.');
            blendShapes.push({ target: { kind: 'rotation', index: rotToDef[t] }, ...base, values: { angle: g('angles'), originX: g('ox'), originY: g('oy'), scale: g('scales') } });
          } else if (sec === 'bsPart') {
            need(t >= 0 && t < C.parts && span(kfB[a], kfC[a], C.partKF), `${sec} ${j}`);
            blendShapes.push({ target: { kind: 'part', index: t }, ...base, values: { drawOrder: Array.from({ length: keys.length }, (_, k) => num(moc, 'partKF', 'drawOrders')[kf(k)]) } });
          } else {
            need(t >= 0 && t < C.glue && span(kfB[a], kfC[a], C.glueKF), `${sec} ${j}`);
            blendShapes.push({ target: { kind: 'glue', index: t }, ...base, values: { intensity: Array.from({ length: keys.length }, (_, k) => num(moc, 'glueKF', 'intensities')[kf(k)]) } });
          }
        }
      }
    };
    one('bsArt'); one('bsWarp');
    if (moc.version >= 5) { one('bsRot'); one('bsPart'); one('bsGlue'); }
  }

  // ---------------------------------------------------------------- textures
  const files = new Map<string, Uint8Array>();
  const textures: Rig2DDoc['textures'] = [];
  if (textureFiles.length > IMPORT_LIMITS.textures) throw new Moc3Error(`The model has more than ${IMPORT_LIMITS.textures} textures.`);
  textureFiles.forEach((f, i) => {
    const b = f ? input.read(f) : null;
    if (!b) throw new Moc3Error(`Texture ${f ?? i} is missing.`);
    // the whole picture is checked (bounded memory): a cut-off or garbage texture fails here, not later on stream
    const sz = checkImage(b);
    if ('error' in sz && sz.error === 'too-big') throw new Moc3Error(`Texture ${f} is ${sz.w}×${sz.h} pixels; textures can be at most ${RIG2D_LIMITS.textureSide} pixels on a side.`);
    if ('error' in sz) throw new Moc3Error(sz.error === 'damaged' ? `Texture ${f} is damaged or cut off, so it can't be shown.` : `Texture ${f} is not a picture (PNG, JPEG or WebP) — it's probably damaged.`);
    if (sz.w < 1 || sz.h < 1 || sz.w > RIG2D_LIMITS.textureSide || sz.h > RIG2D_LIMITS.textureSide) throw new Moc3Error(`Texture ${f} is ${sz.w}×${sz.h} pixels; textures can be at most ${RIG2D_LIMITS.textureSide} pixels on a side.`);
    if (b.byteLength > RIG2D_LIMITS.textureBytes) throw new Moc3Error(`Texture ${f} is over ${RIG2D_LIMITS.textureBytes >> 20} MB.`);
    const name = `textures/${i}.${sz.fmt}`;
    files.set(name, b);
    textures.push({ file: name, width: sz.w, height: sz.h, filter: 'linear' });
  });

  // ---------------------------------------------------------------- behaviour files
  const groups = arr(m3.Groups).map(obj);
  const grp = (n: string) => groups.filter((g) => g.Target === 'Parameter' && g.Name === n).flatMap((g) => arr(g.Ids).map((x) => str(x))).filter((x) => seenIds.has(x));
  const roles: Rig2DDoc['roles'] = { eyeBlink: [...new Set(grp('EyeBlink'))], lipSync: [...new Set(grp('LipSync'))] };
  const hasParam = (id: string) => seenIds.has(id);
  const hasPart = new Set(parts.map((p) => p.id));

  // physics3
  let physics: Rig2DDoc['physics'], physicsWorld: Rig2DDoc['physicsWorld'];
  const ph = obj(json(input, orOnly(ref(fr.Physics), /\.physics3\.json$/i, !!fr.Physics), warnings, 'Physics'));
  if (Object.keys(ph).length) {
    const meta = obj(ph.Meta), ef = obj(meta.EffectiveForces), gv = obj(ef.Gravity), wd = obj(ef.Wind);
    physicsWorld = { gravity: [fnum(gv.X, 0), fnum(gv.Y, -1)], wind: [fnum(wd.X), fnum(wd.Y)], fps: Math.min(120, Math.max(10, fnum(meta.Fps, 60))) };
    const ty = (v: unknown) => { const s = str(v, 16).toLowerCase(); return s === 'y' ? 'y' as const : s === 'angle' ? 'angle' as const : 'x' as const; };
    physics = [];
    arr(ph.PhysicsSettings).forEach((st, si) => {
      const o = obj(st), nm = obj(o.Normalization), np = obj(nm.Position), na = obj(nm.Angle);
      const inputs = arr(o.Input).map(obj).map((x) => ({ param: str(obj(x.Source).Id, 128), weight: fnum(x.Weight), type: ty(x.Type), reflect: x.Reflect === true })).filter((x) => hasParam(x.param));
      if (physics!.length >= RIG2D_LIMITS.physics) return;
      const particles = arr(o.Vertices).slice(0, RIG2D_LIMITS.particlesPerStrand).map(obj).map((v) => { const p = obj(v.Position); return { x: fnum(p.X), y: fnum(p.Y), mobility: fnum(v.Mobility, 1), delay: fnum(v.Delay, 1), acceleration: fnum(v.Acceleration, 1), radius: fnum(v.Radius) }; });
      const outputs = arr(o.Output).map(obj).map((x) => ({ param: str(obj(x.Destination).Id, 128), particle: Math.max(0, Math.floor(fnum(x.VertexIndex, 1))), scale: fnum(x.Scale, 1), weight: fnum(x.Weight, 100), type: ty(x.Type), reflect: x.Reflect === true }))
        .filter((x) => hasParam(x.param) && x.particle < particles.length);
      if (!inputs.length || !outputs.length || particles.length < 2) { warnings.push(`Physics setting ${si + 1} has no usable inputs / outputs: skipped.`); return; }
      physics!.push({ id: str(o.Id, 128) || `PhysicsSetting${si + 1}`, inputs, outputs, particles,
        normalize: { position: [fnum(np.Minimum, -10), fnum(np.Default, 0), fnum(np.Maximum, 10)], angle: [fnum(na.Minimum, -10), fnum(na.Default, 0), fnum(na.Maximum, 10)] } });
    });
    const names = new Map(arr(meta.PhysicsDictionary).map(obj).map((d) => [str(d.Id, 128), str(d.Name)]));
    for (const p of physics) if (names.get(p.id)) p.name = names.get(p.id)!.slice(0, 256);
  }

  // files next to the model the model3.json may not list (VTube Studio loads every *.exp3.json / *.motion3.json there)
  const pre = dir ? `${dir}/` : '';
  const nearby0 = input.list ? input.list().filter((p) => p.startsWith(pre) && p.length < 400) : [];
  // (only when this model has its folder to itself: a shared runtime folder's other files belong to the other models)
  const nearby = nearby0.filter((p) => /\.model3\.json$/i.test(p)).length === 1 ? nearby0 : [];
  const lc = (p: string | null) => (p ?? '').normalize('NFC').toLowerCase();
  const baseLc = (p: string) => lc(p.split('/').pop() ?? p);
  // VTube Studio's sidecar: its hotkeys, idle animation and parameter mapping
  // (no file list: the one next to the model3.json with its name, the way VTube Studio saves it)
  const vtsSibling = input.model3.replace(/\.model3\.json$/i, '.vtube.json');
  const vtsPath = nearby.filter((p) => /\.vtube\.json$/i.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0]
    ?? (!input.list && vtsSibling !== input.model3 && input.read(vtsSibling) ? vtsSibling : null);
  const vts = obj(vtsPath ? json(input, vtsPath, warnings, 'VTube Studio settings') : null);
  const hotkeys = arr(vts.Hotkeys).map(obj);
  const takenKeys = new Set<string>();
  // (VTube Studio key names: N1 / Alpha1 = the number row, Numpad1 = the keypad, letters, F-keys and combinations like
  // LeftControl + N1: shared/rig2d/vtsImport.ts; a key the studio or the browser keeps — H hides the menus, Shift+4 is
  // BRB, F5 reloads …: imported without it, and an expression's is said once below)
  const moved: { name: string; from: string; why: string }[] = [];
  const keyFor = (action: RegExp, file: string, name?: string): string | undefined => {
    for (const h of hotkeys) {
      if (!action.test(str(h.Action, 64)) || baseLc(str(h.File, 300).replace(/\\/g, '/')) !== baseLc(file)) continue;
      const k = vtsKeyCombo(h.Triggers), why = k ? reservedKey(k) : '';
      if (why) { if (name !== undefined) moved.push({ name, from: k, why }); continue; }
      if (k && k.length <= 24 && !takenKeys.has(k)) { takenKeys.add(k); return k; }
    }
    return undefined;
  };
  const hotkeyName = (file: string) => { for (const h of hotkeys) if (baseLc(str(h.File, 300).replace(/\\/g, '/')) === baseLc(file) && str(h.Name, 128).trim()) return str(h.Name, 128).trim(); return ''; };

  // expressions: the model3.json's list, then the other *.exp3.json files next to it
  const expressions: NonNullable<Rig2DDoc['expressions']> = [];
  const expSrc: { path: string | null; file: string; name: string; found?: boolean }[] = arr(fr.Expressions).map(obj).map((e) => ({ path: ref(e.File), file: str(e.File, 300), name: str(e.Name, 128) }));
  const listed = new Set(expSrc.map((e) => lc(e.path)));
  for (const p of nearby.filter((x) => /\.exp3\.json$/i.test(x)).sort()) if (!listed.has(lc(p))) { listed.add(lc(p)); expSrc.push({ path: p, file: p.slice(pre.length), name: '', found: true }); }
  // (and the ones only VTube Studio's expression hotkeys name: it loads those too)
  for (const h of hotkeys) {
    if (h.Action !== 'ToggleExpression' || !str(h.File) || expSrc.length >= 1024) continue;
    const p = ref(h.File);
    if (p && !listed.has(lc(p))) { listed.add(lc(p)); expSrc.push({ path: p, file: str(h.File, 300), name: str(h.Name, 128) }); }
  }
  for (const e of expSrc) {
    if (expressions.length >= RIG2D_LIMITS.expressions) { warnings.push(`More than ${RIG2D_LIMITS.expressions} expressions: the rest were skipped.`); break; }
    const j = obj(json(input, e.path, warnings, 'Expression'));
    if (!Object.keys(j).length) continue;
    const stem = e.file.replace(/\\/g, '/').split('/').pop()!.replace(/\.exp3\.json$/i, '');
    const name = (e.name || hotkeyName(e.file) || stem || `Expression ${expressions.length + 1}`).slice(0, 128);
    const blendOf = (b: unknown) => { const s = str(b, 16).toLowerCase(); return s === 'multiply' ? 'multiply' as const : s === 'overwrite' ? 'overwrite' as const : 'add' as const; };
    const params = arr(j.Parameters).map(obj).map((p) => ({ param: str(p.Id, 128), value: fnum(p.Value), blend: blendOf(p.Blend) })).filter((p) => hasParam(p.param)).slice(0, 4096);
    const base = safeName(name.replace(/[^\w.-]+/g, '_').slice(0, 64)) || `exp${expressions.length + 1}`;
    let id = base;
    for (let n = 2; expressions.some((x) => x.id === id); n++) id = `${base}_${n}`;
    if (e.found && !params.length) continue; // a stray file for another model
    const key = keyFor(/expression/i, e.file, name);
    expressions.push({ id, name, fadeIn: Math.max(0, fnum(j.FadeInTime, 1)), fadeOut: Math.max(0, fnum(j.FadeOutTime, 1)), params, ...(key ? { key } : {}) });
  }

  // keys the studio keeps: say once, in plain words, where each of those expressions is now
  if (moved.length) {
    const now = new Map(expressionKeys({ expressions }).map((e) => [e.name, e.key]));
    warnings.push(`Some VTube Studio keys are used by the studio, so these expressions got other keys: ${moved.slice(0, 6).map((m) => `“${m.name}” ${keyLabel(m.from)} (${m.why}) → ${now.get(m.name) ? keyLabel(now.get(m.name)) : 'no key: click its key in the 2D panel’s Expressions list to pick one'}`).join(', ')}${moved.length > 6 ? ' …' : ''}.`);
  }

  // motions: the model3.json's groups, VTube Studio's idle animation, then the other *.motion3.json files next to it
  const motions: NonNullable<Rig2DDoc['motions']> = [];
  let segStats = [0, 0, 0, 0];
  const motSrc: { group: string; path: string | null; file: string; fadeIn?: number; fadeOut?: number; loop?: boolean; found?: boolean }[] = [];
  for (const [group, list] of Object.entries(obj(fr.Motions))) for (const mo of arr(list).map(obj)) {
    motSrc.push({ group: safeName(group.slice(0, 64)), path: ref(mo.File), file: str(mo.File, 300), ...(typeof mo.FadeInTime === 'number' ? { fadeIn: mo.FadeInTime } : {}), ...(typeof mo.FadeOutTime === 'number' ? { fadeOut: mo.FadeOutTime } : {}) });
  }
  const vtsIdle = str(obj(vts.FileReferences).IdleAnimation, 300);
  if (vtsIdle && !motSrc.some((m) => /^idle$/i.test(m.group))) motSrc.push({ group: 'Idle', path: ref(vtsIdle), file: vtsIdle, loop: true });
  const mListed = new Set(motSrc.map((m) => lc(m.path)));
  for (const p of nearby.filter((x) => /\.motion3\.json$/i.test(x)).sort()) if (!mListed.has(lc(p))) motSrc.push({ group: 'Other', path: p, file: p.slice(pre.length), found: true });
  const groupCount = new Map<string, number>();
  for (const mo of motSrc) {
    if (motions.length >= RIG2D_LIMITS.motions) { warnings.push(`More than ${RIG2D_LIMITS.motions} motions: the rest were skipped.`); break; }
    const j = obj(json(input, mo.path, warnings, 'Motion'));
    if (!Object.keys(j).length) continue;
    const group = mo.group, mi = groupCount.get(group) ?? 0;
    const meta = obj(j.Meta);
    const curves: Rig2DDoc['motions'] extends (infer M)[] | undefined ? M extends { curves: infer K } ? K : never : never = [];
    for (const c of arr(j.Curves).map(obj)) {
      if (curves.length >= RIG2D_LIMITS.curves) { warnings.push(`Motion ${mo.file} has more than ${RIG2D_LIMITS.curves} curves: the rest were skipped.`); break; }
      const tg = str(c.Target, 32).toLowerCase(), cid = str(c.Id, 128);
      const target = tg === 'parameter' ? 'param' : tg === 'partopacity' ? 'part' : tg === 'model' ? (cid === 'EyeBlink' ? 'blink' : cid === 'LipSync' ? 'lipSync' : cid === 'Opacity' ? 'opacity' : null) : null;
      if (!target || !cid) continue;
      if (target === 'param' && !hasParam(cid)) continue;
      if (target === 'part' && !hasPart.has(cid)) continue;
      const s = arr(c.Segments).map((x) => fnum(x, NaN));
      if (s.length < 2 || s.some((x) => !Number.isFinite(x))) { warnings.push(`A curve of motion ${mo.file} is broken: skipped.`); continue; }
      const times = [s[0]], values = [s[1]], segments: number[] = [], controls: number[] = [];
      let i = 2, okc = true;
      while (i < s.length) {
        const k = s[i];
        if (k === 1) { if (i + 6 >= s.length) { okc = false; break; } controls.push(s[i + 1], s[i + 2], s[i + 3], s[i + 4]); times.push(s[i + 5]); values.push(s[i + 6]); i += 7; }
        else if (k === 0 || k === 2 || k === 3) { if (i + 2 >= s.length) { okc = false; break; } times.push(s[i + 1]); values.push(s[i + 2]); i += 3; }
        else { okc = false; break; }
        segments.push(k); segStats[k]++;
      }
      if (!okc) { warnings.push(`A curve of motion ${mo.file} is broken: skipped.`); continue; }
      for (let q = 1; q < times.length; q++) if (times[q] < times[q - 1]) times[q] = times[q - 1];
      // long curves (baked / captured motions) go to a binary buffer, so the manifest stays small
      const long = times.length > 64;
      curves.push({ target, id: cid, ...(fnum(c.FadeInTime, -1) >= 0 ? { fadeIn: fnum(c.FadeInTime) } : {}), ...(fnum(c.FadeOutTime, -1) >= 0 ? { fadeOut: fnum(c.FadeOutTime) } : {}),
        times: long ? B.f32(times) : times, values: long ? B.f32(values) : values, segments: long ? B.add(Uint8Array.from(segments), 'u8') : segments,
        ...(controls.length ? { controls: long ? B.f32(controls) : controls } : {}) });
    }
    const file = mo.file.replace(/\\/g, '/').split('/').pop()!.replace(/\.motion3\.json$/i, '');
    const base = `${group}_${mi}`.replace(/[^\w.-]+/g, '_').slice(0, 100);
    let id = base;
    for (let n = 2; motions.some((x) => x.id === id); n++) id = `${base}_${n}`;
    groupCount.set(group, mi + 1);
    const fadeIn = mo.fadeIn ?? fnum(meta.FadeInTime, 1), fadeOut = mo.fadeOut ?? fnum(meta.FadeOutTime, 1);
    if (mo.found && !curves.length) continue; // a stray file for another model
    const key = keyFor(/animation/i, mo.file);
    motions.push({ id, name: (hotkeyName(mo.file) || file).slice(0, 256), group, duration: Math.max(0, fnum(meta.Duration)), loop: mo.loop ?? meta.Loop === true,
      fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut), ...(meta.AreBeziersRestricted === true ? { bezierByFraction: true } : {}), curves,
      ...(arr(j.UserData).length ? { events: arr(j.UserData).map(obj).map((u) => ({ t: fnum(u.Time), value: str(u.Value) })).slice(0, 256) } : {}), ...(key ? { key } : {}) });
  }

  // VTube Studio's parameter mapping (the user's own: custom parameter ids, sensitivity, inverted axes) → bindings the
  // runtime's auto-mapper prefers (shared/rig2d/drive.ts); inputs we don't track (mouse, hands …) are left to it
  const vtsBindings: { src: string; param: string; range?: [number, number, number, number]; invert?: boolean }[] = [];
  for (const s of arr(vts.ParameterSettings).map(obj)) {
    const inp = VTS_INPUT[str(s.Input, 64)], pid = str(s.OutputLive2D, 128), pi = paramIds.indexOf(pid);
    if (!inp || pi < 0 || vtsBindings.length >= 96) continue;
    const p = params[pi];
    const iLo = fnum(s.InputRangeLower, inp.vts[0]), iHi = fnum(s.InputRangeUpper, inp.vts[1]), oLo = fnum(s.OutputRangeLower, p.min), oHi = fnum(s.OutputRangeUpper, p.max);
    if (iLo === iHi || oLo === oHi) continue;
    let src = inp.src;
    // VTube Studio's "Brows" drives both brows: the right one by its id or display name
    if (src === 'browLY' && /[a-z]R[A-Z]|Right|_R(_|$)|(^|\s)R(\s|$)|右|오른/.test(`${pid} ${p.name.normalize('NFKC')}`)) src = 'browRY';
    if (inp.natural) {
      // only the direction: our 0..1 onto the parameter's own range (the eye / mouth parameter's closed → open)
      const flip = (oHi - oLo) * (iHi - iLo) < 0, closed = flip ? p.max : p.min, open = flip ? p.min : p.max;
      // eyes rest open at the parameter's default (a 0..2 eye parameter is wide-eyed at 2)
      const restOpen = src.startsWith('eyeOpen') && p.default !== closed ? p.default : open;
      vtsBindings.push({ src, param: p.id, range: [inp.ours[0], inp.ours[1], closed, restOpen] });
    } else {
      const toOurs = (x: number) => inp.ours[0] + (x - inp.vts[0]) * (inp.ours[1] - inp.ours[0]) / (inp.vts[1] - inp.vts[0]);
      const a = toOurs(iLo), b = toOurs(iHi);
      vtsBindings.push({ src, param: p.id, range: a <= b ? [a, b, oLo, oHi] : [b, a, oHi, oLo] });
    }
  }
  if (vtsBindings.length) warnings.push(`Used VTube Studio's parameter mapping (${vtsBindings.length} inputs) from ${vtsPath}.`);

  // pose3 → part switches
  const switches: NonNullable<Rig2DDoc['switches']> = [];
  const pose = obj(json(input, orOnly(ref(fr.Pose), /\.pose3\.json$/i, !!fr.Pose), warnings, 'Pose'));
  for (const g of arr(pose.Groups)) {
    const members = arr(g).map(obj).map((p) => ({ part: str(p.Id, 128), links: arr(p.Link).map((x) => str(x, 128)).filter((x) => hasPart.has(x)) })).filter((p) => hasPart.has(p.part));
    if (members.length) switches.push({ fade: Math.max(0, fnum(pose.FadeInTime, 0.5)), members });
  }
  // hit areas
  const meshIdSet = new Set(meshes.map((m) => m.id));
  const hitAreas = arr(m3.HitAreas).map(obj).map((h) => ({ id: str(h.Id, 128), name: str(h.Name) || str(h.Id), mesh: str(h.Id, 128) })).filter((h) => h.id && meshIdSet.has(h.mesh));

  const vtsTracked = vtsTrackedParams(vts).filter((id) => seenIds.has(id));
  const buf = B.bytes();
  const name = input.model3.split('/').pop()!.replace(/\.model3\.json$/i, '');
  const doc: Rig2DDoc = {
    magic: RIG2D.magic, version: RIG2D.version,
    meta: { name: name.slice(0, 256), notes: 'Converted from a Live2D model on import. The artist\'s and rigger\'s licence terms still apply.',
      source: { kind: 'live2d', file: input.model3.split('/').pop()!.slice(0, 256), version: `moc3 v${moc.version}`, converter: 'VTube Pro rig2d/live2d 1', ...(input.now ? { at: input.now } : {}) } },
    canvas: { width: moc.canvas.w, height: moc.canvas.h, unit: moc.canvas.ppu, originX: moc.canvas.ox, originY: moc.canvas.oy },
    buffers: [{ file: 'buffers/0.bin', byteLength: buf.length }],
    textures, params, grids, parts, deformers, meshes,
    ...(drawGroups ? { drawGroups } : {}),
    ...(glue.length ? { glue } : {}),
    ...(blendShapes.length ? { blendShapes } : {}),
    roles,
    ...(physics?.length ? { physics, physicsWorld } : {}),
    ...(expressions.length ? { expressions } : {}),
    ...(motions.length ? { motions } : {}),
    ...(switches.length ? { switches } : {}),
    ...(hitAreas.length ? { hitAreas } : {}),
    // (vtsTracked: the parameters VTube Studio drives from tracking: never offered as model sliders, shared/rig2d/userParams.ts)
    ...(vtsBindings.length || vtsTracked.length ? { extra: { ...(vtsBindings.length ? { vtsBindings } : {}), ...(vtsTracked.length ? { vtsTracked } : {}) } } : {}),
  };
  // the manifest must stay under the reader's limit: drop the last motions (with a note) rather than make an unreadable rig
  // (in UTF-8 bytes, as the reader measures it)
  for (let size = utf8Bytes(JSON.stringify(doc)); size > RIG2D_LIMITS.manifestBytes * 0.9 && doc.motions?.length;) {
    const m = doc.motions.pop()!;
    size -= utf8Bytes(JSON.stringify(m));
    warnings.push(`Motion ${m.name} was left out (the model's data is too big).`);
    if (!doc.motions.length) delete doc.motions;
  }
  const stats: Record<string, number> = { mocVersion: moc.version, ...Object.fromEntries(Object.entries(C).map(([k, v]) => [`moc.${k}`, v])),
    params: params.length, grids: grids.length, parts: parts.length, deformers: deformers.length, meshes: meshes.length, glue: glue.length, blendShapes: blendShapes.length,
    physics: physics?.length ?? 0, expressions: expressions.length, motions: motions.length, switches: switches.length, segLinear: segStats[0], segBezier: segStats[1], segStepped: segStats[2], segInvStepped: segStats[3],
    masked: meshes.filter((m) => m.masks.length).length, inverted: meshes.filter((m) => m.maskInvert).length, add: meshes.filter((m) => m.blend === 'add').length,
    multiply: meshes.filter((m) => m.blend === 'multiply').length, culled: meshes.filter((m) => !m.doubleSided).length, colored: meshes.filter((m) => m.color).length + deformers.filter((d) => d.color).length };
  return { pkg: { doc, buffers: [buf], files }, warnings, stats };
}

export { Moc3Error };
export type { Moc3 };
