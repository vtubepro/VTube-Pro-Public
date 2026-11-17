// Rigged 2D avatars in the 2D-avatar importer (shared/flatImport.ts registry; imported once by shared/flatKinds.ts):
//   live2d   a zip / folder of a Live2D model (*.model3.json + .moc3 + textures …) → CONVERTED on import into one
//            VTube Pro rig (model.vtp2). The Live2D files are not kept. Zero effort: drop it, it shows up, the face
//            follows the camera (standard parameters bound automatically).
//   rig2d    a VTube Pro rig (.vtp2) → stored as is (checked).
// Every problem is one plain sentence with what to do.
import { registerFlatImporter, uploadDir, type FlatImportPlan, type FlatUploadFile } from '../flatImport.ts';
import { RIG2D, RIG2D_LIMITS, validateRig2D } from './format.ts';
import { isVtp2, readVtp2, writeVtp2, zipStore } from './container.ts';
import { convertLive2D } from './live2d/convert.ts';
import { Moc3Error } from './live2d/moc3.ts';
import { checkImage } from './live2d/image.ts';
import { makeResolver } from './live2d/resolve.ts';
import { convertInochi } from './inochi/convert.ts';
import { isInp } from './inochi/inp.ts';

const lower = (p: string) => p.toLowerCase();
const depth = (p: string) => p.split('/').length;
export const RIG2D_MAIN = `model${RIG2D.ext}`;

/** The one notice every Live2D import shows. */
export const LIVE2D_RIGHTS_NOTE = 'Only use models you own or have the artist’s permission to use.';

/** The model to use when an upload holds several (or old copies): one whose .moc3 and textures are actually there
 *  first, then the one nearest the top, then not a backup / old copy, then by name. */
export function pickModel3(paths: string[], readJson?: (path: string) => unknown): string | null {
  const all = paths.filter((p) => lower(p).endsWith('.model3.json'));
  if (all.length <= 1) return all[0] ?? null;
  const R = makeResolver(paths);
  const score = (m3: string) => {
    const j = readJson?.(m3) as { FileReferences?: { Moc?: unknown; Textures?: unknown } } | null | undefined;
    const fr = j && typeof j === 'object' && j.FileReferences && typeof j.FileReferences === 'object' ? j.FileReferences : {};
    const dir = uploadDir(m3);
    const moc = typeof fr.Moc === 'string' ? R.find(dir + fr.Moc, dir) : null;
    const tex = Array.isArray(fr.Textures) ? fr.Textures.filter((t) => typeof t === 'string' && R.find(dir + t, dir)).length / Math.max(1, fr.Textures.length) : 0;
    return (moc && /\.moc3$/i.test(moc) ? 2 : 0) + tex;
  };
  const old = (p: string) => (/(^|[/_ .-])(old|backup|bak|copy|test|unused|archive|wip)([/_ .-]|\d|$)/i.test(p) ? 1 : 0);
  const s = new Map(all.map((p) => [p, score(p)]));
  return all.sort((a, b) => s.get(b)! - s.get(a)! || depth(a) - depth(b) || old(a) - old(b) || a.localeCompare(b))[0];
}

export function planLive2D(files: FlatUploadFile[], readJson?: (path: string) => unknown): FlatImportPlan | { error: string } {
  const paths = files.map((f) => f.path);
  const m3 = pickModel3(paths, readJson);
  if (!m3) {
    if (paths.some((p) => /\.moc3$/i.test(p))) return { error: 'The .model3.json file of this model is missing. Zip the whole model folder (the .model3.json, the .moc3 and the texture folder) and drop it again.' };
    if (paths.some((p) => /\.model\.json$/i.test(p) || /\.moc$/i.test(p))) return { error: 'This is an old Cubism 2 model (.moc), which VTube Pro can’t read. Open it in Cubism Editor 3 or newer, export it for runtime (.moc3), and drop that folder.' };
    return { error: 'This zip has no .model3.json model in it. Zip the whole model folder (the one with the .model3.json file) and drop it again.' };
  }
  const warnings = [LIVE2D_RIGHTS_NOTE];
  if (paths.filter((p) => lower(p).endsWith('.model3.json')).length > 1) warnings.push(`There were several models in the zip; we used ${m3.split('/').pop()}.`);
  return { kind: 'live2d', root: uploadDir(m3), main: m3, keep: [], opts: {}, warnings };
}

/** Plain-language reason for a failed conversion (+ the fix). */
export function conversionProblem(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/textures can be at most|more than 256 textures|is over \d+ MB/i.test(m)) return `${m.replace(/\.$/, '')}. Export the model again with smaller textures (${RIG2D_LIMITS.textureSide} pixels or less), then drop the zip here.`;
  if (/not a picture|damaged or cut off/i.test(m)) return `${m.replace(/\.$/, '')}. Export the model again from Cubism Editor, then drop the zip here.`;
  if (/missing/i.test(m)) return `A file of this model is missing (${m.replace(/\.$/, '')}). Zip the whole model folder and drop it again.`;
  if (e instanceof Moc3Error && /version/i.test(m)) return 'This model was saved by a Cubism version VTube Pro can’t read yet. Export it again for Cubism 5 or older and drop it again.';
  if (e instanceof Moc3Error) return 'This model file looks damaged, so it couldn’t be converted. Download or export it again, then drop the zip here.';
  return `This model couldn’t be converted (${m}). Download or export it again, then drop the zip here.`;
}

/** Convert an upload's Live2D model into .vtp2 bytes: files found leniently (case, NFD names, backslashes, moved
 *  folders: shared/rig2d/live2d/resolve.ts), then the SERIALIZED container is read back with the runtime's own reader
 *  (readVtp2: sizes, manifest bytes, schema, cross references, textures): a model that imports always loads.
 *  Throws an Error with one plain sentence. `notes` = what to tell the user (at most two). */
export async function convertLive2DUpload(files: ReadonlyMap<string, Uint8Array>, model3: string, now = new Date().toISOString()): Promise<{ bytes: Uint8Array; warnings: string[]; notes: string[] }> {
  const R = makeResolver(files.keys());
  const dir = uploadDir(model3);
  let res;
  try { res = convertLive2D({ model3, read: (p) => { const q = R.find(p, dir); return q ? files.get(q) ?? null : null; }, list: () => R.paths, now }); }
  catch (e) {
    // a file the model names that is missing, but several files elsewhere could be it: let the user pick, never guess
    const msg = e instanceof Error ? e.message : '';
    const amb = /missing/i.test(msg) ? [...R.ambiguous].find(([w]) => msg.includes(w.replace(/\\/g, '/').split('/').pop()!)) : undefined;
    if (amb) {
      const [want, cands] = amb;
      throw new Error(`Several files could be this model's ${want.split('/').pop()} (${cands.slice(0, 3).join(', ')}). Keep only the right one in the zip and drop it again.`);
    }
    throw new Error(conversionProblem(e));
  }
  const v = validateRig2D(res.pkg.doc, res.pkg.buffers.map((b) => b.byteLength));
  if (!v.ok) {
    console.log(`[rig2d import] converted rig failed validation: ${v.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    throw new Error('This model uses something VTube Pro can’t convert yet, so it wasn’t added. Please send the model to support so we can fix it.');
  }
  const bytes = writeVtp2(res.pkg);
  if (bytes.byteLength > RIG2D_LIMITS.totalBytes) throw new Error('This model is too big (over 1 GB converted). Export it with smaller textures, then drop it again.');
  const back = await readVtp2(bytes);
  if (!back.ok) {
    console.log(`[rig2d import] the converted rig doesn't read back: ${back.error}`);
    throw new Error('This model uses something VTube Pro can’t convert yet, so it wasn’t added. Please send the model to support so we can fix it.');
  }
  const notes = res.warnings.filter((w) => /VTube Studio's parameter mapping/.test(w)).map(() => 'Your VTube Studio settings came along: the same face tracking mapping and hotkeys.');
  return { bytes, warnings: res.warnings, notes };
}

registerFlatImporter({
  kind: 'live2d',
  detect: (paths) => paths.some((p) => lower(p).endsWith('.model3.json')) || (paths.some((p) => /\.(moc3|moc)$/i.test(p) || /\.model\.json$/i.test(p)) && !paths.some((p) => /\.(inp|inx)$/i.test(p))),
  plan: (files, readJson) => planLive2D(files, readJson),
  async convert(files, plan) {
    const res = await convertLive2DUpload(files, plan.main);
    // technical notes go to the helper's log, not to the user (zero-effort rule)
    for (const w of res.warnings) console.log(`[rig2d import] ${w}`);
    return { kind: 'rig2d', main: RIG2D_MAIN, files: [[RIG2D_MAIN, res.bytes]], warnings: res.notes };
  },
});

// Inochi2D puppets (.inp / Inochi Creator .inx) → converted the same way
registerFlatImporter({
  kind: 'inochi2d',
  detect: (paths) => paths.some((p) => /\.(inp|inx)$/i.test(p)),
  plan(files: FlatUploadFile[]) {
    const f = files.filter((x) => /\.(inp|inx)$/i.test(x.path)).sort((a, b) => Number(lower(b.path).endsWith('.inp')) - Number(lower(a.path).endsWith('.inp')) || depth(a.path) - depth(b.path))[0];
    if (f.head && f.head.length >= 8 && !isInp(f.head)) return { error: `${f.path.split('/').pop()} is not an Inochi2D puppet. Export it again from Inochi Creator (File → Export → .inp) and drop it here.` };
    return { kind: 'inochi2d', root: uploadDir(f.path), main: f.path, keep: [], opts: {}, warnings: ['Only use puppets you own or have the artist’s permission to use.'] };
  },
  convert(files, plan) {
    const b = files.get(plan.main);
    if (!b) throw new Error('The puppet file is missing from the upload.');
    let res;
    try { res = convertInochi(b, plan.main.split('/').pop()!.replace(/\.(inp|inx)$/i, '')); }
    catch (e) { throw new Error(`This Inochi2D puppet couldn’t be converted (${(e as Error).message.replace(/\.$/, '')}). Export it again from Inochi Creator as .inp and drop it here.`); }
    for (const w of res.warnings) console.log(`[rig2d import] ${w}`);
    return { kind: 'rig2d', main: RIG2D_MAIN, files: [[RIG2D_MAIN, writeVtp2(res.pkg)]], warnings: res.warnings.filter((w) => /Details|BC7|physics/i.test(w)).slice(0, 2) };
  },
});

/** Every picture a .vtp2's manifest names (textures + lighting maps) must be a whole, honest picture: the same check a
 *  Live2D import's textures get (shared/rig2d/live2d/image.ts checkImage: size from the header, IDAT unpacked in small
 *  steps to exactly the size it promises), before it is stored and before the texture tiers decode it. */
export function checkRigPictures(entries: { name: string; data: Uint8Array }[]) {
  const man = entries.find((e) => e.name === RIG2D.manifest);
  if (!man) return;
  let doc: { textures?: { file?: unknown; normal?: unknown; emission?: unknown; rim?: unknown }[] };
  try { doc = JSON.parse(new TextDecoder().decode(man.data)); } catch { throw new Error(`This ${RIG2D.ext} file is damaged. Export it again from VTube Pro and drop it here.`); }
  const names = new Set<string>();
  for (const t of Array.isArray(doc?.textures) ? doc.textures : []) for (const f of [t?.file, t?.normal, t?.emission, t?.rim]) if (typeof f === 'string') names.add(f);
  for (const name of names) {
    const e = entries.find((x) => x.name === name);
    if (!e) continue;   // (a missing file: the reader's own message)
    const c = checkImage(e.data);
    if (!('error' in c)) continue;
    const base = name.split('/').pop()!.slice(0, 80);
    if (c.error === 'too-big') throw new Error(`The picture ${base} is ${c.w}×${c.h} pixels; pictures can be at most ${RIG2D_LIMITS.textureSide} pixels on a side. Export the model again with smaller textures and drop it here.`);
    throw new Error(`The picture ${base} in this ${RIG2D.ext} file is damaged. Export it again from VTube Pro and drop it here.`);
  }
}

// a .vtp2 is itself a zip, so the upload arrives unpacked (mimetype + rig.json + buffers + textures): pack it again
registerFlatImporter({
  kind: 'rig2d',
  detect: (paths) => paths.some((p) => p.split('/').pop() === RIG2D.manifest) && paths.some((p) => p.split('/').pop() === 'mimetype'),
  plan(files: FlatUploadFile[]) {
    const man = files.find((f) => f.path.split('/').pop() === RIG2D.manifest)!;
    const root = uploadDir(man.path);
    return { kind: 'rig2d', root, main: man.path, keep: [], opts: {}, warnings: [] };
  },
  convert(files, plan) {
    const root = uploadDir(plan.main);
    const entries = [...files].filter(([p]) => p.startsWith(root)).map(([p, b]) => ({ name: p.slice(root.length), data: b }));
    entries.sort((a, b) => (a.name === 'mimetype' ? -1 : b.name === 'mimetype' ? 1 : a.name === RIG2D.manifest ? -1 : b.name === RIG2D.manifest ? 1 : 0));
    checkRigPictures(entries);
    const z = zipStore(entries);
    if (!isVtp2(z)) throw new Error(`This ${RIG2D.ext} file is damaged. Export it again from VTube Pro and drop it here.`);
    return { kind: 'rig2d', main: RIG2D_MAIN, files: [[RIG2D_MAIN, z]] };
  },
});
