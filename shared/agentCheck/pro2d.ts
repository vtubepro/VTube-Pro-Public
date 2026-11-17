// Pro2D from art: a layered PSD / PSB, or one PNG per part. Runs the 2D avatar maker itself (the same reader, the same
// layer classifier, the same auto-rig as Avatars → Create a 2D avatar: shared/rig2d/edit/*) and reports what it
// understood and which motions it could build, so an agent knows BEFORE handing the art over whether blinking, the
// talking mouth, gaze, brows and hair physics will work.
import { parsePsd, isPsd, PsdError } from '../rig2d/edit/psd.ts';
import { fitArt, layersFromPictures, type ArtSet } from '../rig2d/edit/layers.ts';
import { autoRigArt, paramInUse } from '../rig2d/edit/autorig.ts';
import { ROLE_LABEL, type Classified, type Role } from '../rig2d/edit/classify.ts';
import { OUTFIT, ACCESSORY_NAME } from '../rig2d/edit/extras.ts';
import { decodePng } from '../rig2d/gpu/png.ts';
import { DOC, finish, type CheckFile, type CheckItem, type CheckResult } from './types.ts';

/** The canvas the maker works best with: it scales anything longer than 4096 px down to 4096 (layers.ts fitArt). */
export const PSD_CANVAS = { min: 2048, max: 4096 };

export async function checkPro2dPsd(file: CheckFile): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const name = file.path;
  if (!isPsd(file.bytes)) {
    items.push({ id: 'psd.file', level: 'error', what: `${name} is not a Photoshop file.`, fix: 'Save the layered art as .psd (Photoshop, Clip Studio, Krita, GIMP: File → Export As → .psd). Keep every part on its own layer.', doc: DOC.pro2dPsd });
    return finish('pro2d-psd', name, items, {}, 'Pro2D art (PSD)');
  }
  // header facts the reader would refuse or convert
  const dv = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
  const header = { version: dv.getUint16(4), channels: dv.getUint16(12), height: dv.getUint32(14), width: dv.getUint32(18), depth: dv.getUint16(22), mode: dv.getUint16(24) };
  const MODES: Record<number, string> = { 0: 'Bitmap', 1: 'Grayscale', 2: 'Indexed', 3: 'RGB', 4: 'CMYK', 7: 'Multichannel', 8: 'Duotone', 9: 'Lab' };
  if (header.mode === 4) items.push({ id: 'psd.color', level: 'warn', what: 'CMYK colour: converted approximately, colours shift.', fix: 'Convert to RGB 8-bit (Image → Mode → RGB Color) before saving.', doc: DOC.pro2dPsd });
  if (header.depth !== 8 && header.mode === 3) items.push({ id: 'psd.depth', level: 'info', what: `${header.depth}-bit channels (read fine, but 8-bit files are 2-4× smaller).`, fix: 'Image → Mode → 8 Bits/Channel.' });
  let art: ArtSet;
  try {
    const f = await parsePsd(file.bytes);
    if (!f.layers.length) {
      items.push({ id: 'psd.layers', level: 'error', what: 'This PSD has no usable layers (it is flattened, or every layer is empty / a text or adjustment layer).', fix: 'Save it with its layers: one part of the character per layer (face, eye white L, iris L, upper lash L … mouth, front hair, back hair, body).', doc: DOC.pro2dPsd });
      return finish('pro2d-psd', name, items, { canvas: [header.width, header.height], mode: MODES[header.mode] ?? header.mode }, 'Pro2D art (PSD)');
    }
    art = fitArt({ width: f.width, height: f.height, layers: f.layers, warnings: f.warnings });
  } catch (e) {
    items.push({ id: 'psd.file', level: 'error', what: e instanceof PsdError ? `The maker can’t read this PSD: ${e.message}.` : `The maker can’t read this PSD (${(e as Error).message}).`, fix: 'Save it again as RGB 8-bit .psd with "Maximize compatibility" on (Photoshop) / the default PSD export (Krita, GIMP, Clip Studio).', doc: DOC.pro2dPsd });
    return finish('pro2d-psd', name, items, { canvas: [header.width, header.height], mode: MODES[header.mode] ?? header.mode }, 'Pro2D art (PSD)');
  }
  return judgeArt(art, name, 'pro2d-psd', 'Pro2D art (PSD)', items, { width: header.width, height: header.height });
}

/** One PNG per part (the maker's other input): names like "03_eye_l.png" (the number = paint order, bottom first). */
export async function checkPro2dPictures(files: CheckFile[], name: string): Promise<CheckResult> {
  const items: CheckItem[] = [];
  const pics: { path: string; w: number; h: number; rgba: Uint8ClampedArray }[] = [];
  for (const f of files.filter((x) => /\.png$/i.test(x.path))) {
    try { const d = decodePng(f.bytes); pics.push({ path: f.path, w: d.w, h: d.h, rgba: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) }); }
    catch (e) { items.push({ id: 'pictures.read', level: 'warn', what: `${f.path} can’t be read (${(e as Error).message}).`, fix: 'Export it again as an RGBA PNG.' }); }
  }
  if (pics.length < 2) {
    items.push({ id: 'pictures.count', level: 'error', what: pics.length ? 'Only one picture: a 2D avatar needs its parts on separate layers.' : 'No readable PNG pictures.', fix: 'Give one transparent PNG per part, all the same canvas size (or a layered PSD).', doc: DOC.pro2dPsd });
    return finish('pro2d-pictures', name, items, {}, 'Pro2D art (PNG layers)');
  }
  const art = fitArt(layersFromPictures(pics));
  return judgeArt(art, name, 'pro2d-pictures', 'Pro2D art (PNG layers)', items, { width: art.width, height: art.height });
}

const SIDES_NEEDED: Role[] = ['eyeWhite', 'iris', 'lashUpper', 'brow'];

function judgeArt(art: ArtSet, name: string, kind: 'pro2d-psd' | 'pro2d-pictures', what: string, items: CheckItem[], canvas: { width: number; height: number }): CheckResult {
  const long = Math.max(canvas.width, canvas.height);
  if (long > PSD_CANVAS.max) items.push({ id: 'psd.canvas', level: 'info', what: `Canvas ${canvas.width}×${canvas.height}: the maker scales it down to ${PSD_CANVAS.max} px on the long side.`, fix: `Work at ${PSD_CANVAS.min}-${PSD_CANVAS.max} px on the long side (fine lines survive better when you draw at the size that is used).` });
  else if (long < PSD_CANVAS.min) items.push({ id: 'psd.canvas', level: 'warn', what: `Canvas ${canvas.width}×${canvas.height}: small; the avatar looks soft on a 1080p stream.`, fix: `Draw at ${PSD_CANVAS.min}-${PSD_CANVAS.max} px on the long side.`, doc: DOC.pro2dPsd });
  for (const w of art.warnings) items.push({ id: 'psd.skipped', level: 'warn', what: w, fix: 'Rasterize / merge text, adjustment and effect layers (stroke, shadow, glow) into normal pixel layers; fill layers too.', doc: DOC.pro2dPsd });
  let rig: ReturnType<typeof autoRigArt>;
  try { rig = autoRigArt(art, { name }); }
  catch (e) {
    items.push({ id: 'rig', level: 'error', what: `The auto-rig failed: ${(e as Error).message}.`, fix: 'Send the file to VTube Pro support; meanwhile check the layer list for empty or full-canvas opaque layers.' });
    return finish(kind, name, items, {}, what);
  }
  const { doc, cls } = rig;
  const by = (r: Role) => cls.layers.filter((c) => c.role === r);
  const sides = (r: Role) => new Set(by(r).map((c) => c.side));
  const has = (r: Role) => by(r).length > 0;
  const facts: Record<string, unknown> = {
    canvas: [canvas.width, canvas.height], layers: art.layers.length,
    roles: Object.fromEntries(Object.entries(groupBy(cls.layers)).map(([k, v]) => [k, v.map((c) => `${c.name}${c.side ? ` (${c.side})` : ''}`)])),
    built: {
      headTurn: paramInUse(doc, 'ParamAngleX'), blink: paramInUse(doc, 'ParamEyeLOpen') && paramInUse(doc, 'ParamEyeROpen'), gaze: paramInUse(doc, 'ParamEyeBallX'),
      brows: paramInUse(doc, 'ParamBrowLY') || paramInUse(doc, 'ParamBrowRY'), mouthOpen: paramInUse(doc, 'ParamMouthOpenY'), mouthForm: paramInUse(doc, 'ParamMouthForm'),
      blush: paramInUse(doc, 'ParamCheek'), hairSwing: (doc.extras?.dynamics?.length ?? 0) + (doc.physics?.length ?? 0) > 0,
      outfits: doc.extras?.costumes?.length ?? 0, views: doc.extras?.views?.sets.length ?? 0, expressions: doc.expressions.length,
    },
    notes: cls.notes,
  };
  const built = facts.built as Record<string, boolean | number>;
  // the face
  if (!has('face')) items.push({ id: 'psd.face', level: 'warn', what: 'No layer was recognised as the face (skin): the head turn pivots on a guess.', fix: 'Name the bare face skin layer "face" (no eyes, mouth or hair painted on it; paint the skin under where the hair goes).', doc: DOC.pro2dPsd });
  // eyes
  const eyeWhole = has('eyeWhole');
  for (const r of SIDES_NEEDED) {
    const s = sides(r);
    if (r !== 'brow' && eyeWhole && !has(r)) continue;
    if (!(s.has('L') && s.has('R'))) items.push({ id: `psd.${r}`, level: r === 'brow' ? 'info' : 'warn', what: `${ROLE_LABEL[r]}: ${s.size ? `only the ${[...s].join('')} side` : 'none'} found.`, fix: `Give each eye its own layers: "eye white L", "iris L", "upper lash L" (and the same with R). The side comes from where the part is on the canvas, so draw both.${r === 'brow' ? ' Brows: "brow L", "brow R".' : ''}`, doc: DOC.pro2dPsd });
  }
  if (eyeWhole && !has('eyeWhite')) items.push({ id: 'psd.eyeWhole', level: 'warn', what: 'Each eye is one merged layer: it can blink, but the iris can’t look around.', fix: 'Split every eye into eye white, iris (+ highlight) and upper lash layers; paint the eye white whole under the lashes.', doc: DOC.pro2dPsd });
  if (!built.blink) items.push({ id: 'psd.blink', level: 'error', what: 'Blinking could not be built.', fix: 'Separate eye white, iris and upper lash per eye (or add a hidden "eye closed L" / "eye closed R" layer).', doc: DOC.pro2dPsd });
  // mouth
  const mouthParts = ['mouth', 'mouthUpper', 'mouthLower', 'mouthInner'] as Role[];
  if (!mouthParts.some(has)) items.push({ id: 'psd.mouth', level: 'error', what: 'No mouth layer: lip sync is off.', fix: 'Add the mouth: "upper lip", "lower lip", "inside of mouth" (dark red cavity painted whole), optional "teeth" and "tongue". One "mouth" layer works but opens less naturally.', doc: DOC.pro2dPsd });
  else if (!has('mouthInner')) items.push({ id: 'psd.mouthInner', level: 'info', what: 'No "inside of mouth" layer: the maker paints a generic dark cavity.', fix: 'Paint the mouth interior on its own layer ("inside of mouth"), whole, under the lips; teeth as a flat drawn band on a "teeth" layer.' });
  else if (!(has('mouthUpper') && has('mouthLower')) && has('mouth')) items.push({ id: 'psd.lips', level: 'info', what: 'The mouth is one layer: it opens by stretching.', fix: 'Split it into "upper lip" and "lower lip" for a cleaner open / close.' });
  if (!built.mouthOpen) items.push({ id: 'psd.lipsync', level: 'error', what: 'The talking mouth could not be built.', fix: 'See the mouth layers above.', doc: DOC.pro2dPsd });
  // hair
  if (!has('hairFront') && !has('hairBack') && !has('hairSide')) items.push({ id: 'psd.hair', level: 'info', what: 'No hair layers recognised: no hair swing.', fix: 'Split the hair: "front hair" (over the face), "side hair L/R", "back hair" (behind the head, painted whole behind the face).' });
  else if (!has('hairBack')) items.push({ id: 'psd.hairBack', level: 'info', what: 'No back hair layer: the head turn shows the gap behind the face.', fix: 'Add "back hair": the hair mass behind the head, painted fully behind the face outline.' });
  // unknowns + left out
  const unknown = cls.layers.filter((c) => c.role === 'unknown');
  if (unknown.length) items.push({ id: 'psd.unknown', level: unknown.length > 3 ? 'warn' : 'info', what: `${unknown.length} layer${unknown.length === 1 ? ' was' : 's were'} not understood and will ride the ${unknown.length === 1 ? 'head or body' : 'head or body'} as is: ${unknown.slice(0, 8).map((c) => `"${c.name}"`).join(', ')}${unknown.length > 8 ? ' …' : ''}.`, fix: 'Rename them with the part words the maker reads (spec "pro2d.psd.layerWords"): e.g. "eye white L", "iris R", "upper lash L", "brow R", "upper lip", "inside of mouth", "front hair", "side hair L", "back hair", "neck", "body", "arm L", "hat".', doc: DOC.pro2dPsd });
  const ignored = cls.layers.filter((c) => c.role === 'ignore');
  if (ignored.length) items.push({ id: 'psd.ignored', level: 'info', what: `${ignored.length} layer${ignored.length === 1 ? ' is' : 's are'} left out of the avatar (background, guide or hidden): ${ignored.slice(0, 6).map((c) => `"${c.name}"`).join(', ')}${ignored.length > 6 ? ' …' : ''}.`, fix: 'Expected? Hidden layers are kept only when their name or folder says they are another state (closed, blink, smile, talk, outfit …).' });
  for (const n of cls.notes) if (!items.some((i) => i.what === n)) items.push({ id: 'psd.note', level: 'info', what: n });
  // clipping / blend modes the runtime draws as normal
  const clipped = art.layers.filter((l) => l.clipped).length;
  if (clipped) items.push({ id: 'psd.clipping', level: 'info', what: `${clipped} clipped layer${clipped === 1 ? '' : 's'} (shading clipped to a base).`, fix: 'Fine: they are kept. If a shadow should move with its part, keep it clipped to that part and in the same folder.' });
  const odd = art.layers.filter((l) => l.blend === 'overlay').length;
  if (odd) items.push({ id: 'psd.blend', level: 'info', what: `${odd} overlay-mode layer${odd === 1 ? '' : 's'}: Pro2D draws overlay as normal.`, fix: 'Merge overlay / soft-light shading into the base colour, or use multiply / screen / add, which Pro2D draws.' });
  // outfits / toggles / views
  const folders = new Set(art.layers.flatMap((l) => l.path));
  const outfit = [...folders].filter((f) => OUTFIT.test(f));
  const toggles = [...folders].filter((f) => ACCESSORY_NAME.test(f));
  if (outfit.length || toggles.length) items.push({ id: 'psd.switches', level: 'ok', what: `Switches: ${outfit.length ? `outfit folders ${outfit.slice(0, 4).map((x) => `"${x}"`).join(', ')}` : ''}${outfit.length && toggles.length ? '; ' : ''}${toggles.length ? `on/off ${toggles.slice(0, 4).map((x) => `"${x}"`).join(', ')}` : ''} (${built.outfits} outfit layer${built.outfits === 1 ? '' : 's'} built).` });
  // the result
  const motions = [['head turn', built.headTurn], ['blink', built.blink], ['gaze', built.gaze], ['brows', built.brows], ['talking mouth', built.mouthOpen], ['smile / frown', built.mouthForm], ['blush', built.blush], ['hair swing', built.hairSwing]] as const;
  items.push({ id: 'rig.built', level: 'ok', what: `The maker builds: ${motions.filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing'}${motions.some(([, v]) => !v) ? `. Not built: ${motions.filter(([, v]) => !v).map(([k]) => k).join(', ')}` : ''}.` });
  return finish(kind, name, items, facts, what);
}

function groupBy(list: readonly Classified[]): Record<string, Classified[]> {
  const o: Record<string, Classified[]> = {};
  for (const c of list) (o[c.role] ??= []).push(c);
  return o;
}
