// "Just drop a model": the whole check + fix, before anything is saved. Takes whatever was dropped (a file, a folder,
// a .zip), finds the model, opens it (VRM / GLB / .gltf + files / PMX right here; FBX / OBJ / .blend … through the
// helper's Blender), reads everything the report needs (analyze.ts), applies the automatic fixes (each one can be
// switched off) and returns: the file to save (single-file .glb / .vrm), the profile settings to save with it
// (rig.boneMap, faceMap, a turn), the plain-words report and the "what we did" list — or a refusal with one fix-it
// sentence for files that truly can't work. Never blocks on a soft problem. Pure (the helper conversion and image
// decoding are passed in). UI: src/ui/dropImport.ts. Tests: tools/model_import_unit.ts.
import { applyRootFix, isGlb, parseGlb, parseGltfText, sanitizeNodeName, writeGlb, type GltfDoc, type Json, type RootFix } from './gltf.ts';
import { analyzeGltf, convertSpecGloss, uprightFix, uprightPoint, type GltfFacts } from './analyze.ts';
import { compareRest, restShape, type RestCompare } from './restCheck.ts';
import { boneMapForProfile } from './bones.ts';
import { pmxToGltf } from './pmx.ts';
import { readFbxFacts, type FbxFacts } from './fbx.ts';
import { KIND_LABEL, LIMITS, NEEDS_BLENDER, makeLookup, readDrop, type DroppedFile, type FileSet, type ModelKind } from './files.ts';
import { buildReport, plainSay, type ReportLine, type FixLine } from './report.ts';

export type { DroppedFile } from './files.ts';
export type { ReportLine, FixLine, PlainNote } from './report.ts';
export { plainNotes, supportReport } from './report.ts';

export interface PrepareEnv {
  /** The helper is reachable (always, on this PC). */
  helper: boolean;
  /** Blender is installed on the helper's PC (null = unknown). */
  blender: boolean | null;
  /** Convert a Blender-format model (FBX, OBJ, .blend …) with its side files to GLB bytes (the helper). */
  convert?: (main: DroppedFile, side: DroppedFile[]) => Promise<{ glb: Uint8Array; missing?: string[] }>;
  /** Decode a texture the glTF can't hold (BMP / TGA / DDS / GIF / WebP) to PNG bytes (the browser can). */
  convertImage?: (bytes: Uint8Array, name: string) => Promise<Uint8Array | null>;
  /** Progress words for the UI. */
  status?: (s: string) => void;
}

/** Fixes the performer can switch off (all on by default). */
export interface FixToggles { upright?: boolean; units?: boolean; facing?: boolean; bones?: boolean; face?: boolean; materials?: boolean }

export type PrepareStatus = 'ok' | 'refuse' | 'route2d' | 'needs-helper' | 'needs-blender';

export interface Prepared {
  status: PrepareStatus;
  /** refuse / needs-*: the headline and the one fix-it sentence. */
  title?: string;
  fix?: string;
  /** Every model found in the drop (best first) and the one used. */
  models: { path: string; model: ModelKind }[];
  chosen: string | null;
  kind: ModelKind | null;
  /** 2D files (Live2D / PNG / PSD) for the 2D importer. */
  twoD: FileSet['twoD'];
  /** The file to save: 'model.vrm' or 'model.glb'. */
  file: { name: string; bytes: Uint8Array } | null;
  facts: GltfFacts | null;
  fbx: FbxFacts | null;
  /** Profile settings that go with the file. */
  seed: { name: string; rig?: { boneMap: Record<string, string> }; faceMap?: Record<string, string>; transform?: { yaw: number } };
  report: ReportLine[];
  fixes: FixLine[];
  /** No usable skeleton (or no arms): offer the helper's autorig. */
  needsRig: boolean;
  /** The rest-shape check of the fixed file against the source (restCheck.ts); null = nothing was changed. */
  integrity: RestCompare | null;
  /** No face shapes and no jaw: the drawn mouth / eyes take over. */
  needsFace: boolean;
  /** The author's own notes (PMX comment / VRM licence), shown as-is (shortened). */
  notes: string | null;
}

const blank = (models: Prepared['models'] = [], twoD: FileSet['twoD'] = null): Prepared => ({
  status: 'ok', models, chosen: null, kind: null, twoD, file: null, facts: null, fbx: null, seed: { name: 'My model' }, report: [], fixes: [], needsRig: false, needsFace: false, notes: null, integrity: null,
});
const refuse = (title: string, fix: string, base: Partial<Prepared> = {}): Prepared => ({ ...blank(), ...base, status: 'refuse', title, fix });

export function cleanName(file: string): string {
  const s = (file.split('/').pop() ?? file).replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s ? s.replace(/^./, (c) => c.toUpperCase()) : 'My model';
}

export async function prepareImport(input: readonly DroppedFile[], env: PrepareEnv, opts: { toggles?: FixToggles; choice?: string } = {}): Promise<Prepared> {
  const T: Required<FixToggles> = { upright: true, units: true, facing: true, bones: true, face: true, materials: true, ...(opts.toggles ?? {}) };
  if (!input.length) return refuse('Nothing to import', 'Drop a model file (.vrm, .glb, .fbx, .pmx, .obj …), its folder, or a .zip.');
  if (input.every((f) => f.bytes.byteLength === 0)) return refuse('The file is empty (0 bytes)', 'The download or copy didn’t finish. Download the model again.');
  let set: FileSet;
  try { set = readDrop(input); } catch (e) { return refuse('This couldn’t be opened', (e as Error).message); }
  if (!set.models.length) {
    if (set.twoD) return { ...blank([], set.twoD), status: 'route2d', title: set.twoD.what === 'live2d' ? 'This is a 2D model from another app' : set.twoD.what === 'psd' ? 'This is a layered picture (PSD)' : set.twoD.what === 'inochi2d' ? 'This is a 2D model from another app' : 'This is a picture (a 2D avatar?)', fix: '' };
    if (set.refusals.length) return refuse(set.refusals[0].title, set.refusals[0].fix);
    return refuse(set.fromZip ? 'There’s no 3D model in this .zip' : 'There’s no 3D model here', `Found ${set.files.length} file${set.files.length === 1 ? '' : 's'} (${[...new Set(set.files.map((f) => (/\.([a-z0-9]+)$/i.exec(f.path)?.[1] ?? 'no type').toLowerCase()))].slice(0, 6).join(', ')}), but no .vrm, .glb, .fbx, .pmx or .obj. Check the download has the model itself.`);
  }
  const pick = set.models.find((m) => m.path === opts.choice) ?? set.models[0];
  const main = set.files.find((f) => f.path === pick.path)!;
  const lookup = makeLookup(set.files, pick.path);
  const base: Partial<Prepared> = { models: set.models, chosen: pick.path, kind: pick.model, twoD: set.twoD };
  if (main.bytes.byteLength > LIMITS.model) return refuse('This model is over 500 MB', 'Make a lighter version (fewer triangles, 2K textures), then try again.', base);

  let doc: GltfDoc | null = null, fbx: FbxFacts | null = null, notes: string | null = null, nameHint: string | null = null;
  let convertedFrom: ModelKind | null = null;
  const fileFixes: FixLine[] = [];
  let missingImages: string[] = [];
  let keepOriginal = false;
  try {
    switch (pick.model) {
      case 'vrm': case 'glb': {
        doc = parseGlb(main.bytes);
        keepOriginal = true;
        break;
      }
      case 'gltf': {
        env.status?.('Reading the .gltf and its files…');
        const r = parseGltfText(main.bytes, lookup);
        doc = r.doc;
        missingImages = [];
        break;
      }
      case 'pmx': {
        env.status?.('Converting the MMD model…');
        const r = await pmxToGltf(main.bytes, { lookup, baseDir: pick.path.includes('/') ? pick.path.slice(0, pick.path.lastIndexOf('/')) : '', convertImage: env.convertImage });
        doc = r.doc;
        convertedFrom = 'pmx';
        nameHint = r.meta.name || null;
        notes = r.meta.comment ? r.meta.comment.slice(0, 600) : null;
        missingImages = r.textures.filter((t) => !t.found || t.converted === false).map((t) => t.path);
        const conv = r.textures.filter((t) => t.converted).length;
        fileFixes.push({ id: 'pmx', label: 'Converted the MMD model', detail: `MMD units → metres, left-handed → right-handed, ${r.vertexMorphs} face morph${r.vertexMorphs === 1 ? '' : 's'} kept${r.skippedMorphs ? ` (${r.skippedMorphs} bone / material morphs skipped)` : ''}${conv ? `, ${conv} texture${conv === 1 ? '' : 's'} turned into PNG` : ''}.`, on: true, toggle: null });
        break;
      }
      case 'pmd': return refuse('This is an old MMD model (.pmd)', 'Open it in PMX Editor and save it as .pmx (File → Save As), then drop the .pmx.', base);
      case '3ds': case 'x': return refuse(`${KIND_LABEL[pick.model]} files aren’t supported`, 'Open it in Blender (or the program it came from), export it as .fbx or .glb, then drop that.', base);
      default: {
        if (pick.model === 'fbx') { try { fbx = readFbxFacts(main.bytes); } catch (e) { return refuse('This .fbx can’t be read', (e as Error).message, base); } }
        if (fbx && !fbx.meshes.length && fbx.animations) return refuse('This .fbx holds only an animation, no model', 'Drop the character’s own .fbx (with its mesh), not a dance or motion file. VTube Pro moves your model from your camera.', { ...base, fbx });
        if (!env.helper) return { ...blank(set.models, set.twoD), ...base, fbx, status: 'needs-helper', title: `${KIND_LABEL[pick.model]} files are converted by VTube Pro`, fix: 'Open VTube Pro (a free app on your computer) and drop the file again. Or export the model as .glb or .vrm, which open right here.' };
        if (env.blender === false) return { ...blank(set.models, set.twoD), ...base, fbx, status: 'needs-blender', title: `${KIND_LABEL[pick.model]} files are converted by Blender`, fix: 'Blender (free) isn’t installed on this PC yet. Install it with one click (Tools), then drop the file again. Or export the model as .glb or .vrm.' };
        if (!env.convert) return refuse('Converting needs VTube Pro', 'Open VTube Pro and try again.', base);
        env.status?.('Blender is converting your model in VTube Pro (big models take a minute)…');
        const side = set.files.filter((f) => f !== main && (/\.(png|jpe?g|tga|bmp|dds|tif|tiff|gif|webp|exr|hdr|psd|mtl|bin)$/i.test(f.path)));
        const r = await env.convert(main, side);
        if (!isGlb(r.glb)) return refuse('The conversion didn’t make a model', 'Blender couldn’t convert this file. Open it in Blender yourself and export it as .glb.', { ...base, fbx });
        doc = parseGlb(r.glb);
        convertedFrom = pick.model;
        missingImages = r.missing ?? [];
        fileFixes.push({ id: 'convert', label: `Converted the ${KIND_LABEL[pick.model]} with Blender`, detail: `Saved as a single .glb${side.length ? ` with ${side.length} file${side.length === 1 ? '' : 's'} from the ${set.fromZip ? 'zip' : 'folder'}` : ''}.`, on: true, toggle: null });
      }
    }
  } catch (e) {
    return refuse('This model file can’t be opened', (e as Error).message, { ...base, fbx });
  }
  if (!doc) return refuse('This model file can’t be opened', 'Export it again as .glb or .vrm.', base);

  // ---- read it
  env.status?.('Checking skeleton, face shapes, size and textures…');
  let facts = analyzeGltf(doc, { missingImages });
  // images a .gltf points at that weren't dropped
  if (pick.model === 'gltf') {
    const miss: string[] = [];
    for (const im of Array.isArray(doc.json.images) ? doc.json.images : []) if (typeof im?.uri === 'string' && !/^data:/.test(im.uri) && !lookup(decodeURIComponentSafe(im.uri))) miss.push(decodeURIComponentSafe(im.uri));
    facts = { ...facts, missingImages: miss };
  }
  if (facts.blockers.length) return refuse('This model can’t be opened in VTube Pro', facts.blockers[0], { ...base, facts, fbx });
  const isVrm = facts.container !== 'glb';

  // ---- fixes
  const fixes: FixLine[] = [...fileFixes];
  let json: Json = doc.json;
  const root: RootFix = {};
  const upFix = !isVrm && facts.up !== '+Y' ? uprightFix(facts.up) : {};
  if (!isVrm && facts.up !== '+Y') {
    const why = facts.upFrom === 'bones' ? 'its head is along ' + facts.up : 'it is much longer along ' + facts.up;
    fixes.push({ id: 'upright', label: 'Stood it upright', detail: `It was saved ${facts.up === '+Z' ? 'Z-up (lying down, as in Blender / 3ds Max)' : `with ${facts.up} up`} (${why}).`, on: T.upright, toggle: 'upright' });
    if (T.upright) Object.assign(root, upFix);
  }
  const H = facts.height;
  const unitScale = isVrm || !(H > 0) ? 1 : H > 300 ? 0.001 : H > 30 ? 0.01 : H < 0.02 ? 100 : 1;
  if (unitScale !== 1) {
    const unit = unitScale === 0.001 ? 'millimetres' : unitScale === 0.01 ? 'centimetres' : '1/100 scale';
    fixes.push({ id: 'units', label: 'Fixed the size', detail: `It was saved in ${unit} (${fmtNum(H)} units tall): now ${fmtM(H * unitScale)} tall.`, on: T.units, toggle: 'units' });
    if (T.units) root.scale = unitScale;
  }
  if (root.rotX || root.rotZ || (root.scale && root.scale !== 1)) json = applyRootFix(json, root);
  // a mesh named like a bone ("Head", "Hips") makes three.js rename the BONE ("Head_1"), and the skeleton stops
  // matching: give such meshes their own name
  if (!isVrm) {
    const joints = new Set<number>((Array.isArray(json.skins) ? json.skins : []).flatMap((s: Json) => (Array.isArray(s?.joints) ? s.joints : [])));
    const boneNames = new Set<string>([...joints].map((i) => sanitizeNodeName(String(json.nodes?.[i]?.name ?? ''))));
    const clash = (Array.isArray(json.nodes) ? json.nodes : []).map((n: Json, i: number) => (!joints.has(i) && n?.name && boneNames.has(sanitizeNodeName(String(n.name))) ? i : -1)).filter((i: number) => i >= 0);
    if (clash.length) {
      if (json === doc.json) json = JSON.parse(JSON.stringify(json));
      for (const i of clash) json.nodes[i].name = `${json.nodes[i].name}_mesh`;
    }
  }
  if (T.materials && !isVrm) {
    const cp: Json = json === doc.json ? JSON.parse(JSON.stringify(json)) : json;
    const n = convertSpecGloss(cp);
    if (n) { json = cp; fixes.push({ id: 'materials', label: 'Fixed old-style materials', detail: `${n} “specular-glossiness” material${n === 1 ? '' : 's'} turned into the modern kind, so ${n === 1 ? 'it shows' : 'they show'} the right colours.`, on: true, toggle: 'materials' }); }
  } else if (facts.materialIssues.some((m) => m.fix === 'specgloss')) fixes.push({ id: 'materials', label: 'Fix old-style materials', detail: 'Switched off: “specular-glossiness” materials may show grey.', on: false, toggle: 'materials' });
  const seed: Prepared['seed'] = { name: cleanName(nameHint ?? vrmTitle(doc.json) ?? pick.path) };
  if (facts.facesCamera === false && !isVrm) {
    fixes.push({ id: 'facing', label: 'Turned it to face the camera', detail: 'It was saved facing away. VTube Pro turns it around (your file stays as it is).', on: T.facing, toggle: 'facing' });
    if (T.facing) seed.transform = { yaw: 180 };
  }
  const bm = facts.boneMap;
  if (!isVrm && bm && bm.humanoid) {
    const map = boneMapForProfile(facts.bones, bm, sanitizeNodeName);
    const n = Object.keys(map).length;
    fixes.push({ id: 'bones', label: 'Matched the skeleton', detail: `${n} bones matched to head, body, arms, legs${bm.fingers ? ' and fingers' : ''} (${bm.scheme === 'generic' ? 'common names' : schemeWord(bm.scheme)}). Saved with the model.`, on: T.bones, toggle: 'bones' });
    if (T.bones) seed.rig = { boneMap: map };
  }
  const fm = facts.face.faceMap;
  if (!isVrm && Object.keys(fm).length) {
    const list = Object.entries(fm);
    fixes.push({ id: 'face', label: 'Matched the face shapes', detail: `${list.length} face shape${list.length === 1 ? '' : 's'} with unusual names matched (${list.slice(0, 4).map(([k, v]) => `${k} → ${v}`).join(', ')}${list.length > 4 ? ' …' : ''}).`, on: T.face, toggle: 'face' });
    if (T.face) seed.faceMap = { ...fm };
  }
  if (lookup.relinked.length) fixes.push({ id: 'textures', label: 'Found the textures', detail: `${lookup.relinked.length} texture${lookup.relinked.length === 1 ? '' : 's'} the model pointed at under another name or folder were found in the ${set.fromZip ? 'zip' : 'drop'} (${lookup.relinked.slice(0, 3).map((r) => r.used.split('/').pop()).join(', ')}${lookup.relinked.length > 3 ? ' …' : ''}).`, on: true, toggle: null });

  // ---- the file to save
  env.status?.('Packing the model into one file…');
  let file: Prepared['file'];
  if (keepOriginal && json === doc.json) file = { name: isVrm ? 'model.vrm' : 'model.glb', bytes: main.bytes };
  else {
    const w = writeGlb({ json, buffers: doc.buffers }, pick.model === 'gltf' ? lookup : null);
    if (pick.model === 'gltf' && w.packed.length) fixes.push({ id: 'pack', label: 'Packed it into one file', detail: `The .gltf and its ${w.packed.length + (doc.buffers.length ? 1 : 0)} side file${w.packed.length ? 's' : ''} were packed into a single .glb.`, on: true, toggle: null });
    file = { name: isVrm ? 'model.vrm' : 'model.glb', bytes: w.glb };
  }
  // ---- the fixed file must be the source shape, moved by the root fix and nothing else (vertices, joints, inverse
  //      bind matrices all agree): checked on the skinned rest shape. If not, the shape fixes are dropped.
  let integrity: Prepared['integrity'] = null;
  if (!isVrm && file.bytes !== main.bytes) {
    try {
      const before = restShape(doc), after = restShape(parseGlb(file.bytes));
      const sc = root.scale ?? 1, upOn = !!(root.rotX || root.rotZ);
      integrity = compareRest(before, after, (p) => { const q = upOn ? uprightPoint(p, facts.up) : p; return [q[0] * sc, q[1] * sc, q[2] * sc]; });
      if (!integrity.ok && (upOn || sc !== 1)) {
        const plain = { ...doc.json };
        const w2 = writeGlb({ json: JSON.parse(JSON.stringify(plain)), buffers: doc.buffers }, pick.model === 'gltf' ? lookup : null);
        file = { name: 'model.glb', bytes: w2.glb };
        for (const x of fixes) if (x.id === 'upright' || x.id === 'units') { x.on = false; x.detail += ' (not applied: it would have pulled the model apart)'; }
      }
    } catch (e) { integrity = { ok: false, maxErr: 0, meanErr: 0, contacts: 0, broken: 0, why: `the check could not run (${(e as Error).message})` }; }
  }

  const heightM = facts.height > 0 ? facts.height * (T.units ? unitScale : 1) : null;
  for (const x of fixes) x.say = plainSay(x, facts, heightM);
  const needsRig = !bm || !bm.humanoid || !bm.arms;
  const needsFace = facts.face.scheme === 'none' && !(bm && bm.map.jaw !== undefined);
  const report = buildReport({ facts, fbx, kind: pick.model, convertedFrom, path: pick.path, fromZip: set.fromZip, models: set.models.length, scale: T.units ? unitScale : 1, upright: T.upright, lookupRelinked: lookup.relinked.length, notes });
  if (!notes) notes = vrmLicence(doc.json);
  return { ...blank(set.models, set.twoD), ...base, status: 'ok', file, facts, fbx, seed, report, fixes, needsRig, needsFace, notes, integrity };
}

function decodeURIComponentSafe(u: string) { try { return decodeURIComponent(u); } catch { return u; } }
const fmtNum = (n: number) => (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(n >= 10 ? 1 : 2));
export const fmtM = (m: number) => (m >= 1 ? `${m.toFixed(2)} m` : `${Math.round(m * 100)} cm`);
const schemeWord = (s: string) => ({ vrm: 'VRM / Unity names', mixamo: 'Mixamo names', vroid: 'VRoid names', rigify: 'Blender Rigify names', mmd: 'MMD Japanese names', unreal: 'Unreal mannequin names', biped: '3ds Max Biped names', cc: 'Character Creator names', daz: 'Daz names' } as Record<string, string>)[s] ?? s;

function vrmTitle(json: Json): string | null {
  const t = json.extensions?.VRMC_vrm?.meta?.name ?? json.extensions?.VRM?.meta?.title;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}
function vrmLicence(json: Json): string | null {
  const m1 = json.extensions?.VRMC_vrm?.meta, m0 = json.extensions?.VRM?.meta;
  if (m1) {
    const parts = [m1.authors?.length ? `By ${m1.authors.join(', ')}` : '', m1.licenseUrl ? `Licence: ${m1.licenseUrl}` : '', m1.avatarPermission ? `Who may use it: ${m1.avatarPermission}` : '', m1.commercialUsage ? `Commercial use: ${m1.commercialUsage}` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  if (m0) {
    const parts = [m0.author ? `By ${m0.author}` : '', m0.licenseName ? `Licence: ${m0.licenseName}` : '', m0.allowedUserName ? `Who may use it: ${m0.allowedUserName}` : '', m0.commercialUssageName ? `Commercial use: ${m0.commercialUssageName}` : ''].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  return null;
}
