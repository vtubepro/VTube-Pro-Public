// Rigged 2D models: a Live2D model folder (*.model3.json + .moc3 + textures …), an Inochi2D puppet (.inp / .inx) or a
// VTube Pro rig (.vtp2). Each one goes through the studio's own converter / reader (shared/rig2d/importers.ts,
// container.ts: what imports here loads on stream), then the automatic face-tracking mapping (shared/rig2d/drive.ts)
// is run on its parameters: the check says, input by input, what the camera and the voice will move, and how the
// mapping found it. The agent bar: every tracked input on a Cubism standard id (any app finds those), EyeBlink and
// LipSync groups filled in, eyes resting open.
import { planLive2D, convertLive2DUpload, LIVE2D_RIGHTS_NOTE } from '../rig2d/importers.ts';
import { readVtp2, isVtp2, writeVtp2, type InflateRaw } from '../rig2d/container.ts';
import { convertInochi } from '../rig2d/inochi/convert.ts';
import { isInp } from '../rig2d/inochi/inp.ts';
import { live2dAutoMap, L2D_STANDARD, L2D_EXTENDED_MOUTH, type Live2DMapHow, type Rig2DParamInfo, type Rig2DStdSource, type Rig2DBinding } from '../rig2d/drive.ts';
import { RIG2D_LIMITS, type Rig2DDoc } from '../rig2d/format.ts';
import { Animator } from '../rig2d/animate.ts';
import type { FlatUploadFile } from '../flatImport.ts';
import { DOC, finish, type CheckFile, type CheckItem, type CheckResult } from './types.ts';

/** Cubism Editor version per .moc3 header version (byte 4). */
export const MOC3_VERSIONS: Record<number, string> = { 1: '3.0', 2: '3.3', 3: '4.0', 4: '4.2', 5: '5.0', 6: '5.3' };

/** What each tracked input needs, in Cubism's standard parameter ids and ranges (the Cubism Editor template), how much
 *  a missing one matters, and what the performer sees without it. */
export const LIVE2D_INPUTS: { src: Rig2DStdSource; id: string; min: number; max: number; def: number; need: 'error' | 'warn' | 'info'; without: string }[] = [
  { src: 'headYaw', id: 'ParamAngleX', min: -30, max: 30, def: 0, need: 'error', without: 'the head will not turn left / right' },
  { src: 'headPitch', id: 'ParamAngleY', min: -30, max: 30, def: 0, need: 'error', without: 'the head will not nod' },
  { src: 'headRoll', id: 'ParamAngleZ', min: -30, max: 30, def: 0, need: 'warn', without: 'the head will not tilt' },
  { src: 'bodyYaw', id: 'ParamBodyAngleX', min: -10, max: 10, def: 0, need: 'warn', without: 'the body stays still when the head turns' },
  { src: 'bodyPitch', id: 'ParamBodyAngleY', min: -10, max: 10, def: 0, need: 'info', without: 'the body does not lean forward / back' },
  { src: 'bodyRoll', id: 'ParamBodyAngleZ', min: -10, max: 10, def: 0, need: 'info', without: 'the body does not lean sideways' },
  { src: 'eyeOpenL', id: 'ParamEyeLOpen', min: 0, max: 1, def: 1, need: 'error', without: 'the left eye will not blink' },
  { src: 'eyeOpenR', id: 'ParamEyeROpen', min: 0, max: 1, def: 1, need: 'error', without: 'the right eye will not blink' },
  { src: 'eyeSmileL', id: 'ParamEyeLSmile', min: 0, max: 1, def: 0, need: 'info', without: 'no smiling-eye shape' },
  { src: 'eyeSmileR', id: 'ParamEyeRSmile', min: 0, max: 1, def: 0, need: 'info', without: 'no smiling-eye shape' },
  { src: 'gazeX', id: 'ParamEyeBallX', min: -1, max: 1, def: 0, need: 'warn', without: 'the eyes will not look left / right' },
  { src: 'gazeY', id: 'ParamEyeBallY', min: -1, max: 1, def: 0, need: 'warn', without: 'the eyes will not look up / down' },
  { src: 'browLY', id: 'ParamBrowLY', min: -1, max: 1, def: 0, need: 'warn', without: 'the left brow will not raise' },
  { src: 'browRY', id: 'ParamBrowRY', min: -1, max: 1, def: 0, need: 'warn', without: 'the right brow will not raise' },
  { src: 'browLForm', id: 'ParamBrowLForm', min: -1, max: 1, def: 0, need: 'info', without: 'no angry / worried brow shape' },
  { src: 'browRForm', id: 'ParamBrowRForm', min: -1, max: 1, def: 0, need: 'info', without: 'no angry / worried brow shape' },
  { src: 'mouthOpen', id: 'ParamMouthOpenY', min: 0, max: 1, def: 0, need: 'error', without: 'the mouth will not move when they talk' },
  { src: 'mouthForm', id: 'ParamMouthForm', min: -1, max: 1, def: 0, need: 'warn', without: 'the mouth will not smile / frown' },
  { src: 'cheek', id: 'ParamCheek', min: 0, max: 1, def: 0, need: 'info', without: 'no blush' },
  { src: 'breath', id: 'ParamBreath', min: 0, max: 1, def: 0, need: 'warn', without: 'no idle breathing, so the model looks frozen between moves' },
];

const HOW_LABEL: Record<Live2DMapHow, string> = { standard: 'standard id', alias: 'a common rigger name', name: 'its display name', 'blink group': 'the EyeBlink group', 'lip sync group': 'the LipSync group', 'vtube studio': 'the model’s VTube Studio settings' };
const enc = new TextDecoder();
const base = (p: string) => p.split('/').pop() ?? p;
const paramInfo = (d: Rig2DDoc): Rig2DParamInfo[] => d.params.map((p) => ({ id: p.id, name: p.name, dims: 1, min: [p.min, p.min], max: [p.max, p.max], def: [p.default, p.default] }));

// ---------------------------------------------------------------- Live2D
export async function checkLive2d(files: CheckFile[], name: string, inflateRaw?: InflateRaw): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const map = new Map(files.map((f) => [f.path, f.bytes]));
  const readJson = (p: string) => { const b = map.get(p); if (!b) return null; try { return JSON.parse(enc.decode(b)); } catch { return null; } };
  const up: FlatUploadFile[] = files.map((f) => ({ path: f.path, size: f.bytes.byteLength, head: f.bytes.subarray(0, 16) }));
  const plan = planLive2D(up, readJson);
  if ('error' in plan) {
    items.push({ id: 'file', level: 'error', what: plan.error, fix: 'Export the model for runtime from Cubism Editor 4 or 5 (File → Export For Runtime → moc3 + textures), then check the whole exported folder.', doc: DOC.live2d });
    return finish('live2d', name, items, {}, 'Live2D model');
  }
  const m3 = readJson(plan.main) as { FileReferences?: Record<string, unknown>; Groups?: { Name?: string; Ids?: unknown[] }[] } | null;
  if (!m3 || typeof m3 !== 'object') {
    items.push({ id: 'file', level: 'error', what: `${base(plan.main)} is not valid JSON.`, fix: 'Export the model again from Cubism Editor; do not edit the .model3.json by hand unless you keep it valid JSON.', doc: DOC.live2d });
    return finish('live2d', name, items, {}, 'Live2D model');
  }
  for (const w of plan.warnings) if (w !== LIVE2D_RIGHTS_NOTE) items.push({ id: 'file', level: 'warn', what: w, fix: 'Keep exactly one model (one .model3.json) in the folder you hand over.', doc: DOC.live2d });
  const fr = m3.FileReferences ?? {};
  const facts: Record<string, unknown> = { model3: plan.main };
  // the .moc3 version (byte 4 of the header)
  const mocPath = typeof fr.Moc === 'string' ? files.find((f) => f.path.toLowerCase().endsWith(String(fr.Moc).toLowerCase().split('/').pop()!)) : undefined;
  if (mocPath) {
    const v = mocPath.bytes[4];
    facts.mocVersion = v; facts.cubism = MOC3_VERSIONS[v] ?? 'unknown';
    if (v === 6) items.push({ id: 'moc', level: 'info', what: 'Saved by Cubism 5.3: VTube Pro reads it; some other apps (older VTube Studio builds) may not yet.', fix: 'If the performer also uses other apps, export "for Cubism 5.0" or older.', doc: DOC.live2d });
  }
  // convert exactly like the import does
  let doc: Rig2DDoc;
  let convWarnings: string[] = [];
  try {
    const res = await convertLive2DUpload(map, plan.main);
    convWarnings = res.warnings;
    const back = await readVtp2(res.bytes, inflateRaw);
    if (!back.ok) throw new Error(back.error);
    doc = back.pkg.doc;
  } catch (e) {
    items.push({ id: 'convert', level: 'error', what: (e as Error).message, doc: DOC.live2d });
    return finish('live2d', name, items, facts, 'Live2D model');
  }
  items.push({ id: 'convert', level: 'ok', what: `VTube Pro converts it (${doc.params.length} parameters, ${doc.meshes.length} art meshes, ${doc.textures.length} texture${doc.textures.length === 1 ? '' : 's'}).` });
  if (convWarnings.some((w) => /VTube Studio's parameter mapping/.test(w))) items.push({ id: 'vts', level: 'ok', what: 'Brings its VTube Studio settings (.vtube.json): the same tracking mapping and hotkeys are used.' });
  const lost = convWarnings.filter((w) => /missing|not found|not valid JSON|broken|skipped|too big/i.test(w));
  if (lost.length) items.push({ id: 'convert.files', level: 'warn', what: `${lost.length} problem${lost.length === 1 ? '' : 's'} with the files the .model3.json names: ${lost.slice(0, 3).join(' ')}${lost.length > 3 ? ' …' : ''}`,
    fix: 'Hand over the whole exported folder (motions, expressions, physics, textures) with the paths the .model3.json uses, or remove the entries for files you left out.', doc: DOC.live2d });
  // groups
  const groups = (m3.Groups ?? []).filter((g) => g && typeof g === 'object');
  const grp = (n: string) => groups.find((g) => g.Name === n)?.Ids?.filter((x) => typeof x === 'string') as string[] | undefined;
  const blink = grp('EyeBlink'), lips = grp('LipSync');
  if (!blink?.length) items.push({ id: 'groups.blink', level: 'warn', what: 'No EyeBlink group in the .model3.json.', fix: 'In Cubism Editor: Model Settings (the "settings" of the model3) → Eye Blink → tick ParamEyeLOpen and ParamEyeROpen, then export again. Other apps blink the model from it.', doc: DOC.live2d });
  if (!lips?.length) items.push({ id: 'groups.lipsync', level: 'warn', what: 'No LipSync group in the .model3.json.', fix: 'In Cubism Editor: Model Settings → Lip Sync → tick ParamMouthOpenY, then export again.', doc: DOC.live2d });
  // the tracking map
  judgeMapping(doc, paramInfo(doc), items, facts);
  // textures
  judgeTextures(doc, items, facts);
  // nice to have
  if (!fr.Physics) items.push({ id: 'physics', level: 'info', what: 'No physics (.physics3.json): hair and clothes will not sway.', fix: 'Add physics in Cubism Editor (Physics settings) for hair / accessories driven by ParamAngleX/Z and ParamBodyAngleX, then export.', doc: DOC.live2d });
  if (!fr.DisplayInfo) items.push({ id: 'cdi', level: 'info', what: 'No display-name file (.cdi3.json).', fix: 'Export with "Export cdi3.json" ticked: parameter names then show in VTube Pro’s mapping panel.', doc: DOC.live2d });
  facts.expressions = doc.expressions?.length ?? 0;
  facts.motions = doc.motions?.length ?? 0;
  facts.physics = doc.physics?.length ?? 0;
  items.push({ id: 'rights', level: 'info', what: LIVE2D_RIGHTS_NOTE });
  return finish('live2d', name, items, facts, 'Live2D model');
}

/** Which tracked input drives which parameter (and how the mapping found it): one line per input group. */
function judgeMapping(doc: Rig2DDoc, params: Rig2DParamInfo[], items: CheckItem[], facts: Record<string, unknown>) {
  const { bindings, how } = live2dAutoMap(params, doc.roles.lipSync, { eyeBlink: doc.roles.eyeBlink, vts: (doc.extra as { vtsBindings?: unknown } | undefined)?.vtsBindings });
  const bySrc = new Map<string, Rig2DBinding>();
  for (const b of bindings) if (!bySrc.has(b.src)) bySrc.set(b.src, b);
  const byId = new Map(doc.params.map((p) => [p.id, p]));
  const table: Record<string, string> = {};
  const nonStandard: string[] = [];
  for (const inp of LIVE2D_INPUTS) {
    const b = bySrc.get(inp.src);
    if (!b) {
      // a standard parameter that exists but is not 1D-mappable never happens for Live2D; this is a missing input
      items.push({ id: `map.${inp.src}`, level: inp.need, what: `Nothing for ${inp.src}: ${inp.without}.`,
        fix: `Add parameter ${inp.id} (min ${inp.min}, max ${inp.max}, default ${inp.def}) and key the art to it.`, doc: DOC.live2d });
      continue;
    }
    const h = how.get(b.param) ?? 'standard';
    table[inp.src] = `${b.param} (${h})`;
    if (h !== 'standard' && h !== 'vtube studio') nonStandard.push(`${b.param} → ${inp.id}`);
    // eyes must rest open
    if (inp.src === 'eyeOpenL' || inp.src === 'eyeOpenR') {
      const p = byId.get(b.param);
      if (p && h === 'standard' && p.max > p.min && (p.default - p.min) / (p.max - p.min) < 0.5) items.push({ id: `map.${inp.src}.rest`, level: 'warn', what: `${p.id} rests at ${p.default} (closed): the eyes start shut until tracking opens them.`, fix: `Set ${p.id}'s default to ${p.max} (open).`, doc: DOC.live2d });
    }
  }
  if (nonStandard.length) items.push({ id: 'map.names', level: 'warn', what: `${nonStandard.length} tracked input${nonStandard.length === 1 ? ' was' : 's were'} found by name, not by a standard id (${nonStandard.slice(0, 6).join(', ')}${nonStandard.length > 6 ? ' …' : ''}). VTube Pro maps them; other apps may not.`, fix: 'Rename those parameters to the Cubism standard ids shown (Cubism Editor: double-click the parameter → ID).', doc: DOC.live2d });
  const found = LIVE2D_INPUTS.filter((i) => bySrc.has(i.src)).length;
  items.push({ id: 'map', level: 'ok', what: `Face tracking drives ${found} of ${LIVE2D_INPUTS.length} inputs.` });
  const ext = Object.entries(L2D_EXTENDED_MOUTH).filter(([, ids]) => ids!.some((id) => byId.has(id))).map(([s]) => s);
  if (ext.length) items.push({ id: 'map.mouth', level: 'info', what: `Has extended mouth parameters (${ext.join(', ')}); the performer binds them in the 2D panel’s parameter mapping (they are not bound automatically).` });
  facts.tracking = table;
  facts.standardIds = Object.values(L2D_STANDARD).flat().filter((id) => byId.has(id!)).length;
}

function judgeTextures(doc: Rig2DDoc, items: CheckItem[], facts: Record<string, unknown>) {
  const t = doc.textures.map((x) => [x.width, x.height] as const);
  facts.textures = t.map(([w, h]) => `${w}×${h}`);
  const big = t.filter(([w, h]) => Math.max(w, h) > 4096).length;
  if (big) items.push({ id: 'textures', level: 'warn', what: `${big} texture${big === 1 ? ' is' : 's are'} over 4096 px: heavy on video memory next to a 3D room.`, fix: 'Export with a 4096 (or 2048) texture atlas; 2048 is plenty for a streaming-size model.', doc: DOC.live2d });
  const npot = t.filter(([w, h]) => (w & (w - 1)) || (h & (h - 1))).length;
  if (npot) items.push({ id: 'textures.pot', level: 'info', what: `${npot} texture${npot === 1 ? ' is' : 's are'} not a power-of-two size.`, fix: 'Use 1024 / 2048 / 4096 square atlases (Cubism Editor’s texture atlas editor).', doc: DOC.live2d });
  if (!big) items.push({ id: 'textures', level: 'ok', what: `Textures: ${t.length ? facts.textures : 'none'} (limit ${RIG2D_LIMITS.textureSide} px).` });
}

// ---------------------------------------------------------------- Inochi2D
export async function checkInochi(file: CheckFile): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const name = base(file.path);
  if (!isInp(file.bytes)) {
    items.push({ id: 'file', level: 'error', what: `${name} is not an Inochi2D puppet.`, fix: 'Export it from Inochi Creator: File → Export → Inochi2D Puppet (.inp).', doc: DOC.live2d });
    return finish('inochi2d', name, items, {}, 'Inochi2D puppet');
  }
  let doc: Rig2DDoc;
  try {
    const res = convertInochi(file.bytes, name.replace(/\.(inp|inx)$/i, ''));
    writeVtp2(res.pkg);
    doc = res.pkg.doc;
    for (const w of res.warnings) if (/physics|BC7|not supported|skipped/i.test(w)) items.push({ id: 'convert', level: 'info', what: w });
  } catch (e) {
    items.push({ id: 'convert', level: 'error', what: `It could not be converted (${(e as Error).message.replace(/\.$/, '')}).`, fix: 'Export it again from Inochi Creator as .inp.', doc: DOC.live2d });
    return finish('inochi2d', name, items, {}, 'Inochi2D puppet');
  }
  items.push({ id: 'convert', level: 'ok', what: `VTube Pro converts it (${doc.params.length} parameters, ${doc.textures.length} texture${doc.textures.length === 1 ? '' : 's'}).` });
  const bound = new Set<string>(Animator.autoBindings(doc).map((b) => b.src));
  const need: [Rig2DStdSource, string, 'error' | 'warn'][] = [['headYaw', '"Head:: Yaw-Pitch" (2D: X yaw, Y pitch)', 'error'], ['eyeOpenL', '"Eye:: Left:: Blink"', 'error'], ['eyeOpenR', '"Eye:: Right:: Blink"', 'error'], ['mouthOpen', '"Mouth:: Open"', 'error'], ['headRoll', '"Head:: Roll"', 'warn'], ['gazeX', '"Eyes:: Yaw-Pitch" (2D)', 'warn'], ['mouthForm', '"Mouth:: Smile"', 'warn'], ['breath', '"Breath"', 'warn']];
  for (const [s, nm, lvl] of need) if (!bound.has(s)) items.push({ id: `map.${s}`, level: lvl, what: `Nothing drives ${s}.`, fix: `Name a parameter ${nm}; VTube Pro maps Inochi2D parameters by name.`, doc: DOC.live2d });
  items.push({ id: 'map', level: 'ok', what: `Face tracking drives ${bound.size} inputs.` });
  judgeTextures(doc, items, {});
  return finish('inochi2d', name, items, { params: doc.params.length, bound: [...bound] }, 'Inochi2D puppet');
}

// ---------------------------------------------------------------- VTube Pro rig (.vtp2)
export async function checkVtp2(file: CheckFile, inflateRaw?: InflateRaw): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const name = base(file.path);
  if (!isVtp2(file.bytes)) {
    items.push({ id: 'file', level: 'error', what: `${name} is not a VTube Pro rig (.vtp2).`, fix: 'Save it from VTube Pro’s 2D avatar editor, or write it as docs/RIG2D_FORMAT.md describes.', doc: 'docs/RIG2D_FORMAT.md' });
    return finish('vtp2', name, items, {}, 'VTube Pro 2D rig');
  }
  const r = await readVtp2(file.bytes, inflateRaw);
  if (!r.ok) {
    items.push({ id: 'file', level: 'error', what: `It does not load: ${r.error}`, fix: (r.issues ?? []).slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ') || 'Check it against docs/RIG2D_FORMAT.md.', doc: 'docs/RIG2D_FORMAT.md' });
    return finish('vtp2', name, items, {}, 'VTube Pro 2D rig');
  }
  const doc = r.pkg.doc;
  items.push({ id: 'file', level: 'ok', what: `It loads (${doc.params.length} parameters, ${doc.meshes.length} meshes).` });
  for (const w of r.warnings) items.push({ id: 'file', level: 'info', what: w });
  const bound = new Set<string>(Animator.autoBindings(doc).map((b) => b.src));
  for (const inp of LIVE2D_INPUTS) if (!bound.has(inp.src) && inp.need !== 'info') items.push({ id: `map.${inp.src}`, level: inp.need, what: `Nothing for ${inp.src}: ${inp.without}.`, fix: `Add a parameter ${inp.id} and bind it (roles.bind.${inp.src}) or keep the standard id so it binds itself.`, doc: 'docs/RIG2D_FORMAT.md' });
  if (!doc.roles.eyeBlink.length) items.push({ id: 'groups.blink', level: 'warn', what: 'roles.eyeBlink is empty: no automatic blinks when the face is not tracked.', fix: 'List the eye-open parameters in roles.eyeBlink.', doc: 'docs/RIG2D_FORMAT.md' });
  if (!doc.roles.lipSync.length) items.push({ id: 'groups.lipsync', level: 'warn', what: 'roles.lipSync is empty: the mouth only moves with camera tracking, not with the voice alone.', fix: 'List the mouth-open parameter in roles.lipSync.', doc: 'docs/RIG2D_FORMAT.md' });
  judgeTextures(doc, items, {});
  return finish('vtp2', name, items, { params: doc.params.length, bound: [...bound] }, 'VTube Pro 2D rig');
}
