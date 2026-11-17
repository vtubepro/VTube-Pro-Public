// "Just drop a model": what was dropped (one file, a folder, a .zip), which file is the model, what kind of model it
// is (by its bytes, not just its name), and a lookup that finds the textures a model points at even when the paths in
// the file don't match the folder (case, backslashes, absolute paths from the artist's PC, .tga swapped for .png).
// Pure; zips are read with fflate (shipped inside three.js). Tests: tools/model_import_unit.ts.
import { unzipSync, zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { isGlb, sniffImageMime, type FileLookup } from './gltf.ts';
import { isPmd, isPmx } from './pmx.ts';
import { isFbxBinary, isFbxText } from './fbx.ts';
import { sniffPngTuber } from './pngtuber/detect.ts';

export interface DroppedFile { path: string; bytes: Uint8Array }

/** What a 2D drop is. */
export type TwoDKind = 'live2d' | 'image' | 'psd' | 'inochi2d' | 'pngtuber' | 'vts';
export type ModelKind = 'vrm' | 'glb' | 'gltf' | 'pmx' | 'pmd' | 'fbx' | 'obj' | 'blend' | 'dae' | 'stl' | 'ply' | 'usd' | 'abc' | '3ds' | 'x';
export type Sniff =
  | { kind: 'model'; model: ModelKind }
  | { kind: 'zip' }
  // 'pngtuber' = a PNGTuber Plus / Remix / veadotube save, 'vts' = a VTube Studio model file (shared/modelImport/pngtuber, beta.16)
  | { kind: '2d'; what: TwoDKind }
  | { kind: 'refuse'; title: string; fix: string }
  | { kind: 'texture' | 'side' };

/** Upload limits (match the helper: 500 MB for files it converts; 300 MB for a model opened in the browser). */
export const LIMITS = { total: 700 << 20, files: 4000, model: 500 << 20, browserModel: 300 << 20 };

const ext = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();
const headText = (b: Uint8Array, n = 512) => { let s = ''; for (let i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i]); return s; };

/** What one file is. Bytes win over the name (a renamed .vrm is still a VRM; a "model.glb" that is really a zip is a zip). */
export function sniffFile(path: string, b: Uint8Array): Sniff {
  const e = ext(path), head = headText(b, 64);
  const name = path.split('/').pop() ?? path;
  if (isGlb(b)) return { kind: 'model', model: e === 'vrm' ? 'vrm' : 'glb' };
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)) {
    return { kind: 'zip' };
  }
  if (isPmx(b)) return { kind: 'model', model: 'pmx' };
  if (isPmd(b)) return { kind: 'model', model: 'pmd' };
  if (isFbxBinary(b)) return { kind: 'model', model: 'fbx' };
  if (head.startsWith('BLENDER')) return { kind: 'model', model: 'blend' };
  if (head.startsWith('MOC3')) return { kind: '2d', what: 'live2d' };
  if (head.startsWith('8BPS')) return { kind: '2d', what: 'psd' };
  if (head.startsWith('UnityFS') || head.startsWith('UnityWeb') || e === 'vrca' || e === 'unity3d' || e === 'assetbundle') return { kind: 'refuse', title: 'This is a game / VRChat avatar bundle', fix: 'Bundles like this can’t be opened, and avatars taken from games or VRChat usually aren’t yours to use. Ask the artist for the .vrm, .fbx or .pmx, or export your own model from Unity with UniVRM.' };
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return e === 'unitypackage' ? unityRefuse() : { kind: 'refuse', title: 'This is a compressed archive (.gz / .tgz)', fix: 'Unpack it first (7-Zip or your file manager), then drop the folder or the model file.' };
  if (head.startsWith('Rar!') || (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf)) return { kind: 'refuse', title: `This is a ${head.startsWith('Rar!') ? 'RAR' : '7-Zip'} archive`, fix: 'Unpack it first (right-click → Extract All, or 7-Zip), then drop the folder, or put it in a .zip.' };
  if (sniffImageMime(b)) {
    if (/\.(png|jpe?g|gif|webp|apng)$/i.test(name) && !/(_n|_normal|_nrm|_rough|_metal|_ao|_spec|_mask|toon\d*|sph|spa)\.[a-z]+$/i.test(name)) return { kind: '2d', what: 'image' };
    return { kind: 'texture' };
  }
  if (/\.(tga|dds|bmp|spa|sph|tif|tiff|exr|hdr|ktx2?)$/i.test(name)) return { kind: 'texture' };
  if (/\.model3\.json$/i.test(name) || /\.(physics3|pose3|exp3|motion3|cdi3|userdata3)\.json$/i.test(name)) return { kind: '2d', what: 'live2d' };
  if (e === 'inx' || e === 'inp') return { kind: '2d', what: 'inochi2d' };
  { const pt = sniffPngTuber(path, b); if (pt) return { kind: '2d', what: pt === 'vts' ? 'vts' : 'pngtuber' }; }
  if (e === 'gltf' || (head.trimStart().startsWith('{') && /"asset"\s*:/.test(headText(b, 4096)))) return { kind: 'model', model: 'gltf' };
  if (e === 'fbx' && isFbxText(headText(b, 4096))) return { kind: 'model', model: 'fbx' };
  if (e === 'obj') return { kind: 'model', model: 'obj' };
  if (e === 'dae') return { kind: 'model', model: 'dae' };
  if (e === 'stl') return { kind: 'model', model: 'stl' };
  if (e === 'ply') return { kind: 'model', model: 'ply' };
  if (['usd', 'usda', 'usdc', 'usdz'].includes(e)) return { kind: 'model', model: 'usd' };
  if (e === 'abc') return { kind: 'model', model: 'abc' };
  if (e === 'blend') return { kind: 'model', model: 'blend' };
  if (e === '3ds') return { kind: 'model', model: '3ds' };
  if (e === 'x') return { kind: 'model', model: 'x' };
  if (e === 'vroid') return { kind: 'refuse', title: 'This is a VRoid Studio project, not a model file', fix: 'In VRoid Studio press the export button (top right) → “Export as VRM”, then drop the .vrm here.' };
  if (e === 'vmd' || e === 'vpd') return { kind: 'refuse', title: 'This is an MMD dance / pose file, not a model', fix: 'Drop the .pmx model (usually in the same download) instead. VTube Pro moves your model from your camera.' };
  if (['ma', 'mb'].includes(e)) return { kind: 'refuse', title: 'This is a Maya scene', fix: 'In Maya: File → Export All → FBX, then drop the .fbx here.' };
  if (e === 'max') return { kind: 'refuse', title: 'This is a 3ds Max scene', fix: 'In 3ds Max: File → Export → FBX, then drop the .fbx here.' };
  if (e === 'c4d') return { kind: 'refuse', title: 'This is a Cinema 4D scene', fix: 'In Cinema 4D: File → Export → FBX, then drop the .fbx here.' };
  if (e === 'skp') return { kind: 'refuse', title: 'This is a SketchUp model', fix: 'In SketchUp: File → Export → 3D Model → .fbx (or .dae), then drop it here.' };
  if (['zpr', 'ztl'].includes(e)) return { kind: 'refuse', title: 'This is a ZBrush file', fix: 'In ZBrush export the model as .fbx or .obj (lower the subdivision first), then drop it here.' };
  if (['mtl', 'bin', 'txt', 'md', 'json', 'url', 'html', 'pdf', 'ini', 'csv', 'log'].includes(e)) return { kind: 'side' };
  return { kind: 'refuse', title: `${e ? `A .${e} file` : 'This file'} isn’t a 3D model VTube Pro can read`, fix: 'Use .vrm (VRoid), .glb, .fbx, .pmx (MMD), .obj or .blend, or a .zip of the model with its textures.' };
}
function unityRefuse(): Sniff {
  return { kind: 'refuse', title: 'This is a Unity package', fix: 'Open it in Unity, then export the avatar with UniVRM (VRM0 → Export UniVRM) and drop the .vrm. Or ask the artist for the .fbx / .vrm.' };
}
/** The friendly name of a model kind. */
export const KIND_LABEL: Record<ModelKind, string> = {
  vrm: 'VRM', glb: 'GLB (glTF binary)', gltf: 'glTF (.gltf + files)', pmx: 'MMD model (.pmx)', pmd: 'old MMD model (.pmd)', fbx: 'FBX', obj: 'OBJ',
  blend: 'Blender file', dae: 'COLLADA (.dae)', stl: 'STL', ply: 'PLY', usd: 'USD', abc: 'Alembic', '3ds': '3DS', x: 'DirectX .x',
};
/** Opened right here (in the browser) vs converted by Blender in the helper. */
export const NEEDS_BLENDER: ReadonlySet<ModelKind> = new Set(['fbx', 'obj', 'blend', 'dae', 'stl', 'ply', 'usd', 'abc']);
/** Best first when a folder / zip holds several. */
const PRIORITY: ModelKind[] = ['vrm', 'pmx', 'glb', 'gltf', 'fbx', 'blend', 'obj', 'usd', 'dae', 'ply', 'stl', 'abc', 'pmd', '3ds', 'x'];

/** Unzips (names decoded as UTF-8, else Shift-JIS: MMD zips), skipping junk (__MACOSX, .DS_Store, Thumbs.db). */
export function unzip(b: Uint8Array): DroppedFile[] {
  if (b.length >= 8 && (b[6] & 1)) throw new Error('This .zip is password-protected. Unzip it yourself (it asks for the password), then drop the folder.');
  let entries: Record<string, Uint8Array>;
  let total = 0, count = 0;
  try {
    entries = unzipSync(b, {
      filter: (f) => {
        if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)|(^|\/)\._/i.test(f.name) || f.name.endsWith('/')) return false;
        total += f.originalSize; count++;
        if (total > LIMITS.total || count > LIMITS.files) throw new Error('This .zip is too big to open here (over 700 MB or 4,000 files). Unzip it and drop just the model folder.');
        return true;
      },
    });
  } catch (e) {
    const m = (e as Error).message;
    if (/too big/.test(m)) throw e;
    throw new Error(/compression/i.test(m) ? 'This .zip uses a packing method VTube Pro can’t read. Unzip it and drop the folder instead.' : 'This .zip is damaged or cut off. Download it again, or unzip it and drop the folder.');
  }
  return Object.entries(entries).map(([name, bytes]) => ({ path: fixName(name), bytes }));
}

/** Zip names without the UTF-8 flag arrive as Latin-1 characters: decode their bytes as UTF-8, else Shift-JIS. */
function fixName(n: string): string {
  if (![...n].every((c) => c.charCodeAt(0) < 256) || /^[\x20-\x7e]*$/.test(n)) return n;
  const raw = Uint8Array.from(n, (c) => c.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis').decode(raw); } catch { return n; }
}

/** A zip of the files (stored, no compression: textures are compressed already) — what the helper receives. */
export function zipFiles(files: readonly DroppedFile[]): Uint8Array {
  const tree: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const f of files) tree[f.path] = [f.bytes, { level: 0 }];
  return zipSync(tree as never);
}
export { strToU8 };

const normPath = (p: string) => {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return out.join('/');
};
const stem = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '').toLowerCase();

/** A file lookup over the dropped files, relative to the model's folder. Tries: the exact relative path, the same
 *  ignoring case, the file name anywhere in the drop (when unique, or nearest the model), and the same name with
 *  another image extension (.tga asked, .png there). Records what it relinked. */
export function makeLookup(files: readonly DroppedFile[], modelPath: string): FileLookup & { relinked: { asked: string; used: string }[] } {
  const dir = modelPath.includes('/') ? modelPath.slice(0, modelPath.lastIndexOf('/') + 1) : '';
  const byPath = new Map<string, DroppedFile>(), byLower = new Map<string, DroppedFile>(), byName = new Map<string, DroppedFile[]>(), byStem = new Map<string, DroppedFile[]>();
  for (const f of files) {
    const p = normPath(f.path);
    byPath.set(p, f); byLower.set(p.toLowerCase(), f);
    const nm = (p.split('/').pop() ?? p).toLowerCase();
    (byName.get(nm) ?? byName.set(nm, []).get(nm)!).push(f);
    if (sniffImageMime(f.bytes) || /\.(tga|dds|bmp)$/i.test(p)) (byStem.get(stem(p)) ?? byStem.set(stem(p), []).get(stem(p))!).push(f);
  }
  const relinked: { asked: string; used: string }[] = [];
  const nearest = (list: DroppedFile[]) => list.slice().sort((a, b) => score(a.path) - score(b.path))[0];
  const score = (p: string) => (p.toLowerCase().startsWith(dir.toLowerCase()) ? 0 : 100) + p.split('/').length;
  const fn = ((uri: string) => {
    if (!uri || /^data:/.test(uri)) return null;
    const clean = uri.replace(/\\/g, '/').replace(/^file:\/+/i, '').replace(/^[a-z]:\//i, '/');
    const isAbs = clean.startsWith('/');
    const rel = normPath(isAbs ? clean : dir + clean);
    const hit = byPath.get(rel) ?? byLower.get(rel.toLowerCase());
    if (hit && !isAbs) { if (normPath(hit.path) !== rel && !relinked.some((r) => r.asked === uri)) relinked.push({ asked: uri, used: hit.path }); return { path: hit.path, bytes: hit.bytes }; }
    const nm = (clean.split('/').pop() ?? '').toLowerCase();
    const named = byName.get(nm);
    let f = hit ?? (named?.length ? nearest(named) : undefined);
    if (!f && /\.(tga|dds|bmp|png|jpe?g|webp|gif|tif|tiff)$/i.test(nm)) {
      const alt = (byStem.get(stem(nm)) ?? []).filter((x) => sniffImageMime(x.bytes) === 'image/png' || sniffImageMime(x.bytes) === 'image/jpeg');
      f = alt.length ? nearest(alt) : (byStem.get(stem(nm)) ?? [])[0];
    }
    if (!f) return null;
    if (normPath(f.path) !== rel && !relinked.some((r) => r.asked === uri)) relinked.push({ asked: uri, used: f.path });
    return { path: f.path, bytes: f.bytes };
  }) as FileLookup & { relinked: { asked: string; used: string }[] };
  fn.relinked = relinked;
  return fn;
}

export interface FileSet {
  files: DroppedFile[];
  /** Model files found, best first. */
  models: { path: string; model: ModelKind }[];
  twoD: { what: TwoDKind; path: string } | null;
  refusals: { path: string; title: string; fix: string }[];
  fromZip: string | null;
}

/** Which 2D file wins when a drop has several: a Live2D model, then a PNGTuber save, then the rest (the first), a VTube Studio file last. */
const twoRank = (w: TwoDKind) => (w === 'live2d' ? 4 : w === 'pngtuber' ? 3 : w === 'vts' ? 1 : 2);

/** Expands zips (one level, plus zips inside a dropped folder) and sorts out what's a model. */
export function readDrop(input: readonly DroppedFile[]): FileSet {
  const files: DroppedFile[] = [];
  let fromZip: string | null = null;
  const refusals: FileSet['refusals'] = [];
  for (const f of input) {
    const s = sniffFile(f.path, f.bytes);
    if (s.kind === 'zip') {
      const inner = unzip(f.bytes);
      fromZip ??= f.path;
      const base = f.path.replace(/\.[^.]+$/, '').split('/').pop() ?? 'zip';
      for (const x of inner) {
        // a zip inside the zip (a shop / rigger download: the model's zip next to the terms and the art): open it too
        // (one more level; a .vtp2 is a zip of its own and stays packed)
        if (!/\.vtp2$/i.test(x.path) && sniffFile(x.path, x.bytes).kind === 'zip') {
          try { for (const y of unzip(x.bytes)) files.push({ path: `${base}/${x.path.replace(/\.[^./]+$/, '')}/${y.path}`, bytes: y.bytes }); continue; } catch { /* a damaged inner zip: refused below */ }
        }
        files.push({ path: `${base}/${x.path}`, bytes: x.bytes });
      }
    } else files.push(f);
  }
  const models: FileSet['models'] = [];
  let twoD: FileSet['twoD'] = null;
  for (const f of files) {
    const s = sniffFile(f.path, f.bytes);
    if (s.kind === 'model') models.push({ path: f.path, model: s.model });
    else if (s.kind === '2d') { if (!twoD || twoRank(s.what) > twoRank(twoD.what)) twoD = { what: s.what, path: f.path }; }
    else if (s.kind === 'refuse') refusals.push({ path: f.path, title: s.title, fix: s.fix });
    else if (s.kind === 'zip' && /\.vtp2$/i.test(f.path)) { if (!twoD) twoD = { what: 'live2d', path: f.path }; } // a zipped Pro2D model → the 2D importer
    else if (s.kind === 'zip') refusals.push({ path: f.path, title: 'A zip inside the zip', fix: 'Unzip the inner .zip too, then drop the folder.' });
  }
  const size = new Map(files.map((f) => [f.path, f.bytes.byteLength]));
  models.sort((a, b) => PRIORITY.indexOf(a.model) - PRIORITY.indexOf(b.model) || a.path.split('/').length - b.path.split('/').length || (size.get(b.path) ?? 0) - (size.get(a.path) ?? 0));
  return { files, models, twoD, refusals, fromZip };
}
