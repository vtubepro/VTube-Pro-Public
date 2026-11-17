// 2D avatar import (POST /api/avatars/import-flat): a .zip (a set of pictures, or another kind's model folder) or a
// single picture → checked with shared/flatImport.ts (paths, sizes, picture sniffing, roles from file names, the kind's
// own checks) → a new avatar folder in the library with profile.flat set. Zip bombs are refused before inflating
// (sizes from the zip's directory), every path is re-checked against the folder, nothing outside it is written.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FLAT_LIMITS } from '../shared/flatImport.ts';
import { FlatUploadError, planFlat as planFlatShared, readFlatUpload as readFlatUploadShared } from '../shared/flatUpload.ts';
import './flatUnzip.ts'; // Node's zlib for the shared unzip
import '../shared/flatKinds.ts';
import { safeRel } from '../shared/flatAvatar.ts';
import type { AvatarProfile } from '../shared/types.ts';
import { HttpError, assertId, builtinDir, createAvatar, saveProfileAsync, userDir } from './library.ts';
import { CACHE_DIR } from './paths.ts';

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The upload as path → bytes (shared/flatUpload.ts; errors as HTTP errors). */
export function readFlatUpload(body: Uint8Array, filename: string): Map<string, Uint8Array> {
  try { return readFlatUploadShared(body, filename); } catch (e) { if (e instanceof FlatUploadError) throw new HttpError(e.status, e.message); throw e; }
}

/** Check + plan an upload (no writes; shared/flatUpload.ts). */
export async function planFlat(files: Map<string, Uint8Array>, roles: Record<string, string> = {}) {
  try { return await planFlatShared(files, roles); } catch (e) { if (e instanceof FlatUploadError) throw new HttpError(e.status, e.message); throw e; }
}

/** Import: a new avatar folder with the kept files + profile.flat. */
export async function importFlat(body: Uint8Array, o: { filename: string; name: string; roles?: Record<string, string> }): Promise<{ profile: AvatarProfile; warnings: string[]; roles: Record<string, string> }> {
  const { plan, layout, norm } = await planFlat(readFlatUpload(body, o.filename), o.roles ?? {});
  if (layout.modelFile.includes('/')) throw new HttpError(422, 'The main model file must sit at the top of its folder.');
  const stage = path.join(CACHE_DIR, 'tmp', `flat-${stamp()}`);
  await fsp.mkdir(stage, { recursive: true });
  try {
    const mainFrom = layout.map.find(([, to]) => to === layout.modelFile)?.[0];
    const main = mainFrom ? norm.get(mainFrom) : undefined;
    if (!main) throw new HttpError(422, 'The main file is missing from the upload.');
    const staged = path.join(stage, 'main.bin');
    await fsp.writeFile(staged, main);
    const profile = await createAvatar({ name: o.name, source: 'import', modelFrom: staged, modelFile: layout.modelFile, move: true });
    const dir = userDir(profile.id);
    for (const [from, to] of layout.map) {
      if (to === layout.modelFile) continue;
      const rel = safeRel(to, 300);
      const b = norm.get(from);
      if (!rel || !b || rel === 'profile.json') continue;
      const full = path.join(dir, ...rel.split('/'));
      if (!full.startsWith(dir + path.sep)) continue;
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, b);
    }
    const extra: Partial<AvatarProfile> = { flat: layout.config };
    // pictures: the idle picture is the library thumbnail; other kinds get one from the studio's first load
    if (layout.config.kind === 'png') extra.thumbnail = layout.config.png!.idle;
    const saved = await saveProfileAsync(profile.id, extra);
    // what each picture became (the studio says it in one sentence)
    const roles: Record<string, string> = {};
    if (plan.kind === 'png' && 'idle' in plan) for (const k of ['idle', 'talk', 'blink', 'talkBlink'] as const) if (plan[k]) roles[k] = plan[k]!;
    return { profile: saved, warnings: plan.warnings, roles };
  } finally {
    fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

/** Every file in an avatar's folder (relative, forward slashes; dot names skipped): what a party bundle carries for
 *  2D avatar kinds whose files only their own loader knows. */
export async function avatarFileList(id: string): Promise<string[]> {
  assertId(id);
  const base = [userDir(id), builtinDir(id)].find((d) => fs.existsSync(path.join(d, 'profile.json')));
  if (!base) throw new HttpError(404, `No avatar '${id}'`);
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || out.length >= FLAT_LIMITS.files) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      // (gpu/ = the texture tier cache, server/gpuTiers.ts: rebuildable, and a party guest gets its own pick of it)
      if (e.isDirectory()) { if (rel.split('/').length < 6 && !(rel === '' && e.name === 'gpu')) await walk(path.join(d, e.name), r); }
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(base, '');
  return out.sort();
}
