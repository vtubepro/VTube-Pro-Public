// The 2D-avatar upload, read and planned (no writes): ONE implementation for the helper (server/flatImport.ts, which
// writes the library folder) and the browser-only import (src/mobile/flatImport.worker.ts, which stores into the
// browser). Moved from server/flatImport.ts by the mobile2d lane; behaviour unchanged. Errors: FlatUploadError (status +
// one plain sentence).
import { FLAT_LIMITS, flatImporterFor, flatLayout, isMoc3, planFlatUpload, sniffImage, type FlatImportPlan, type FlatUploadFile } from './flatImport.ts';
import { parseLooseJson } from './rig2d/live2d/json.ts';
import { FlatZipError, archiveProblem, readFlatZip, readFlatZipBlob, tooBigUnpacked } from './flatUnzip.ts';
import { keepForFlat } from './zipDir.ts';
import './flatKinds.ts';
import { isInp } from './rig2d/inochi/inp.ts';
import { isVtp2 } from './rig2d/container.ts';

export class FlatUploadError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }
const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || p;

/** What an unpacked zip must hold (one sentence when it's only an editor project / art / nothing), and a .vtp2 zipped
 *  again (a backup, a chat-app download): that .vtp2 to read instead (returned). */
function afterZip(files: Map<string, Uint8Array>, skipped: string[], outerIsVtp2: boolean): [string, Uint8Array] | null {
  if (!files.size && skipped.length) {
    if (skipped.some((p) => /\.(cmo3|can3|cmo)$/i.test(p))) throw new FlatUploadError(422, 'This zip holds only the editor project (.cmo3), not the exported model itself. In Cubism Editor choose File → Export For Runtime → Export as moc3 file, then zip that folder and drop it.');
    if (skipped.some((p) => /\.(psd|psb)$/i.test(p))) throw new FlatUploadError(422, 'This zip holds only layered art (.psd). To make a 2D avatar from it, drop the .psd file itself.');
    throw new FlatUploadError(422, 'Nothing in this zip is a 2D avatar (no pictures, no .model3.json model). Zip your pictures or the exported model folder (the one with the .model3.json), and drop that.');
  }
  if (outerIsVtp2) return null;
  const v = [...files].filter(([p, b]) => /\.vtp2$/i.test(p) && isVtp2(b));
  return v.length === 1 && ![...files.keys()].some((p) => /\.(model3\.json|inp|inx)$/i.test(p)) ? v[0] : null;
}

/** The upload as path → bytes (a zip's entries, or one picture), with the size limits enforced before inflating
 *  (server/flatUnzip.ts: junk / art sources skipped, names decoded, nested zips, zip bombs, password zips). */
export function readFlatUpload(body: Uint8Array, filename: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (isZip(body)) {
    const skipped: string[] = [];
    let files: Map<string, Uint8Array>;
    try { files = readFlatZip(body, { files: FLAT_LIMITS.files * 2, total: FLAT_LIMITS.total, entry: Math.max(FLAT_LIMITS.image, FLAT_LIMITS.moc) }, 0, skipped); }
    catch (e) { if (e instanceof FlatZipError) throw new FlatUploadError(e.status, e.message); throw new FlatUploadError(400, 'This .zip is damaged or cut off. Download it again, or unzip it and drop the folder.'); }
    const v = afterZip(files, skipped, isVtp2(body));
    if (v) return readFlatUpload(v[1], baseName(v[0]));
    return files;
  }
  const arch = archiveProblem(body);
  if (arch) throw new FlatUploadError(422, arch);
  // a single Inochi2D puppet (.inp / .inx): converted by its importer (shared/rig2d/importers.ts, live2d lane)
  if (isInp(body)) { if (body.length > 256 << 20) throw new FlatUploadError(413, 'The puppet is over 256 MB.'); out.set(baseName(filename || 'puppet.inp').replace(/\.[^.]*$/, '') + '.inp', body); return out; }
  if (/\.(model3\.json|moc3|exp3\.json|motion3\.json|physics3\.json|cdi3\.json|vtube\.json)$/i.test(filename) || isMoc3(body.subarray(0, 4))) throw new FlatUploadError(422, 'That is one file of a 2D model. Drop the whole model folder (or a .zip of it): the .model3.json, the .moc3 and the texture folder together.');
  if (/\.(cmo3|can3)$/i.test(filename)) throw new FlatUploadError(422, 'This is an editor project (.cmo3), not the exported model itself. In Cubism Editor choose File → Export For Runtime → Export as moc3 file, then drop that folder.');
  if (!sniffImage(body.subarray(0, 16))) throw new FlatUploadError(400, 'Upload a .zip of your pictures (or model folder), or a single PNG / GIF / WebP / JPEG.');
  if (body.length > FLAT_LIMITS.image) throw new FlatUploadError(413, `The picture is over ${FLAT_LIMITS.image >> 20} MB.`);
  out.set(baseName(filename || 'idle.png').normalize('NFC'), body);
  return out;
}

/** Check + plan an upload (no writes). */
export async function planFlat(files: Map<string, Uint8Array>, roles: Record<string, string> = {}) {
  const list: FlatUploadFile[] = [...files].map(([p, b]) => ({ path: p, size: b.byteLength, head: b.subarray(0, 16) }));
  const norm = new Map<string, Uint8Array>();
  for (const [p, b] of files) norm.set(p.replace(/\\/g, '/').replace(/^(\.\/)+/, ''), b);
  const readJson = (p: string): unknown => {
    const b = norm.get(p);
    if (!b || b.byteLength > FLAT_LIMITS.json) return null;
    return parseLooseJson(b);
  };
  const plan = planFlatUpload(list, readJson, roles);
  if ('error' in plan) throw new FlatUploadError(422, plan.error);
  // kinds that convert on import (a Live2D folder → one .vtp2 rig): store what the converter made instead
  const conv = plan.kind !== 'png' ? flatImporterFor(plan.kind)?.convert : undefined;
  if (conv) {
    let out: Awaited<ReturnType<typeof conv>>;
    try { out = await conv(norm, plan as FlatImportPlan); } catch (e) { throw new FlatUploadError(422, (e as Error).message); }
    plan.warnings.push(...(out.warnings ?? []));
    const layout = flatLayout({ ...(plan as FlatImportPlan & { files: string[] }), kind: out.kind ?? plan.kind, root: '', main: out.main, files: out.files.map(([n]) => n) });
    return { plan, layout, norm: new Map(out.files) };
  }
  return { plan, layout: flatLayout(plan), norm };
}

// ---------------------------------------------------------------- the same, from a Blob / picked Files (the browser)
/** readFlatUpload over a Blob: a zip is read entry by entry from its slices (shared/flatUnzip.ts readFlatZipBlob), so
 *  a big upload is never in memory whole; `total` = the unpacked budget (the studio gives phones a smaller one). */
export async function readFlatUploadBlob(body: Blob, filename: string, total: number = FLAT_LIMITS.total): Promise<Map<string, Uint8Array>> {
  const head = new Uint8Array(await body.slice(0, 64).arrayBuffer());
  if (!isZip(head)) {
    if (body.size > 256 << 20) throw new FlatUploadError(413, `That file is ${Math.round(body.size / 1048576)} MB, too big for a 2D avatar.`);
    return readFlatUpload(new Uint8Array(await body.arrayBuffer()), filename);
  }
  const skipped: string[] = [];
  let files: Map<string, Uint8Array>;
  try { files = await readFlatZipBlob(body, { files: FLAT_LIMITS.files * 2, total, entry: Math.max(FLAT_LIMITS.image, FLAT_LIMITS.moc) }, skipped); }
  catch (e) { if (e instanceof FlatZipError) throw new FlatUploadError(e.status, e.message); throw new FlatUploadError(400, 'This .zip is damaged or cut off. Download it again, or unzip it and drop the folder.'); }
  const v = afterZip(files, skipped, isVtp2(head));
  return v ? readFlatUpload(v[1], baseName(v[0])) : files;
}

/** Several picked files (loose files from a phone, pictures): a zip among them is read like an upload; the rest are
 *  kept by name (art sources / junk skipped unread), within the same budget. */
export async function readFlatPicked(picked: readonly { name: string; blob: Blob }[], total: number = FLAT_LIMITS.total): Promise<Map<string, Uint8Array>> {
  if (picked.length === 1) return readFlatUploadBlob(picked[0].blob, picked[0].name, total);
  const keep = picked.filter((p) => keepForFlat(p.name));
  const sum = keep.reduce((a, p) => a + p.blob.size, 0);
  if (sum > total) throw new FlatUploadError(413, tooBigUnpacked(sum, { files: FLAT_LIMITS.files, total, entry: FLAT_LIMITS.image }).message);
  if (keep.length > FLAT_LIMITS.files) throw new FlatUploadError(413, `Too many files (${keep.length}; at most ${FLAT_LIMITS.files}).`);
  const out = new Map<string, Uint8Array>();
  for (const p of keep) {
    if (/\.zip$/i.test(p.name)) { for (const [k, b] of await readFlatUploadBlob(p.blob, p.name, total)) out.set(`${p.name.replace(/\.zip$/i, '')}/${k}`, b); continue; }
    if (p.blob.size > Math.max(FLAT_LIMITS.image, FLAT_LIMITS.moc)) throw new FlatUploadError(413, `${baseName(p.name)} is over ${FLAT_LIMITS.image >> 20} MB.`);
    out.set(baseName(p.name) === p.name ? p.name.normalize('NFC') : p.name.split(/[\\/]/).join('/').normalize('NFC'), new Uint8Array(await p.blob.arrayBuffer()));
  }
  return out;
}
