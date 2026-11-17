// The 2D import with no helper: the helper's own read + plan (shared/flatUpload.ts: the shared unzip with zip-in-zip,
// name encodings, junk / art-source skipping, the file finder and every converter) turned into the files of a new
// avatar folder, the same layout server/flatImport.ts importFlat writes. Pure (the browser's import worker runs it). Errors: FlatUploadError (one plain sentence).
import type { FlatAvatarConfig } from '../flatAvatar.ts';
import { safeRel } from '../flatAvatar.ts';
import { FlatUploadError, planFlat, readFlatPicked, readFlatUpload } from '../flatUpload.ts';

export interface WebFlatResult {
  /** avatar-folder path → bytes (the main file first) */
  files: [string, Uint8Array][];
  config: FlatAvatarConfig;
  modelFile: string;
  /** the library thumbnail (pictures: the idle picture; rigged kinds get one from the studio's first load) */
  thumbnail: string | null;
  warnings: string[];
  /** what each picture became (the studio says it in one sentence) */
  roles: Record<string, string>;
}

/** One upload (a zip, a .vtp2, a puppet, one picture: the same body the helper's POST /api/avatars/import-flat gets). */
export async function planWebFlat(body: Uint8Array, filename: string, roles: Record<string, string> = {}): Promise<WebFlatResult> {
  return planFiles(readFlatUpload(body, filename), roles);
}

/** Picked files (one zip / .vtp2 / picture, or many loose files) → the files of a new 2D avatar, reading the files
 *  from their Blobs: a zip entry by entry from its slices (never the whole upload in memory). `total` = the unpacked
 *  budget (the studio gives phones a smaller one). */
export async function planWebFlatPicked(picked: readonly { name: string; blob: Blob }[], roles: Record<string, string> = {}, total?: number): Promise<WebFlatResult> {
  return planFiles(await readFlatPicked(picked, total), roles);
}

async function planFiles(upload: Map<string, Uint8Array>, roles: Record<string, string>): Promise<WebFlatResult> {
  const { plan, layout, norm } = await planFlat(upload, roles);
  if (layout.modelFile.includes('/')) throw new FlatUploadError(422, 'The main model file must sit at the top of its folder.');
  const files: [string, Uint8Array][] = [];
  for (const [from, to] of layout.map) {
    const rel = safeRel(to, 300), b = norm.get(from);
    if (!rel || !b || rel === 'profile.json') continue;
    if (rel === layout.modelFile) files.unshift([rel, b]); else files.push([rel, b]);
  }
  if (!files.length || files[0][0] !== layout.modelFile) throw new FlatUploadError(422, 'The main file is missing from the upload.');
  const r: Record<string, string> = {};
  if (plan.kind === 'png' && 'idle' in plan) for (const k of ['idle', 'talk', 'blink', 'talkBlink'] as const) if (plan[k]) r[k] = plan[k]!;
  return { files, config: layout.config, modelFile: layout.modelFile, thumbnail: layout.config.kind === 'png' ? layout.config.png!.idle : null, warnings: plan.warnings, roles: r };
}
