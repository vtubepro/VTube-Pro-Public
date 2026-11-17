// Which avatars come with VTube Pro is decided by what this release ships (release_manifest.json), never by a profile's
// "source" or by a folder sitting in the program folder: an avatar an AI app, a creator script or a copied shipped
// profile left there ("source": "builtin", or a folder in <install>/assets/builtin) is the user's own, and the user can
// delete it. A release moves such folders out of the program folder (an update replaces it whole) into the library at
// start, once, and never overwrites anything. A source checkout (no release_manifest.json) is never touched: every
// assets/builtin folder there is the owner's own shipped content.
//
// Moving never loses the only complete copy: a folder is renamed whole (all or nothing); when it can't be (another disk,
// or a file in it is open) it is copied next to its target and renamed into place only when the copy is complete, and the
// original is removed only after every file is checked to be there. Removing the original is best effort.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ownCostumes } from '../shared/ownAvatar.ts';

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

/** The avatar profile the server would show for a builtin + its library override (server/library.ts getProfile rules). */
export function mergeProfiles(base: any, over: any): any {
  if (!over) return { ...base };
  if (!base) return { ...over };
  const raw = { ...over };
  if (Array.isArray(base.costumes) && base.costumes.length) {
    const have = new Set((over.costumes ?? []).map((c: any) => c.id));
    raw.costumes = [...(over.costumes ?? []), ...base.costumes.filter((c: any) => !have.has(c.id))];
  }
  if (over.speechMotion === undefined && base.speechMotion !== undefined) raw.speechMotion = base.speechMotion;
  if (over.buddy === undefined && base.buddy !== undefined) raw.buddy = base.buddy;   // chat-buddy hand tuning (shared/buddyTune.ts)
  if (!raw.modelFile && base.modelFile) raw.modelFile = base.modelFile;
  if (!raw.thumbnail && base.thumbnail) raw.thumbnail = base.thumbnail;
  return raw;
}

/** Avatar ids this release ships (files under assets/builtin/<id>/ + sampleAvatars, lower-case); null = not a release
 *  (a source checkout, or an unreadable manifest): then every assets/builtin folder counts as shipped, as before. */
export function shippedAvatarIds(root: string): Set<string> | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, 'release_manifest.json'), 'utf8')) as { files?: { path?: string }[]; sampleAvatars?: unknown[] };
    const ids = new Set<string>();
    for (const f of m.files ?? []) { const r = /^assets\/builtin\/([^/]+)\//.exec(String(f.path ?? '')); if (r) ids.add(r[1].toLowerCase()); }
    for (const s of m.sampleAvatars ?? []) { const id = typeof s === 'string' ? s : (s as { id?: unknown } | null)?.id; if (typeof id === 'string') ids.add(id.toLowerCase()); }
    return ids;
  } catch { return null; }
}

/** The source a user's own avatar is listed and saved with: never 'builtin' (only the shipped ones are). */
export function ownSource<T extends string | undefined>(s: T): Exclude<T, 'builtin' | undefined> | 'import' {
  return (s === 'builtin' || !s ? 'import' : s) as Exclude<T, 'builtin' | undefined> | 'import';
}

const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isThere = (p: string) => fsp.stat(p).then(() => true, () => false);
/** The profile a moved avatar is stored with: the user's own, its costumes too. */
const ownProfile = (prof: any, id: string) => ({ ...prof, id, source: ownSource(prof.source), ...(Array.isArray(prof.costumes) ? { costumes: ownCostumes(prof.costumes) } : {}) });

/** Write a JSON file so that a failed write leaves the old file as it was (temp file + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const part = `${file}.part`;
  try { await fsp.writeFile(part, JSON.stringify(value, null, 2)); await fsp.rename(part, file); }
  catch (e) { await fsp.rm(part, { force: true }).catch(() => {}); throw e; }
}
/** Every file under `dir`: path relative to it (with /) -> size in bytes. */
async function treeSizes(dir: string, rel = '', out = new Map<string, number>()): Promise<Map<string, number>> {
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await treeSizes(dir, r, out);
    else if (e.isFile()) out.set(r, (await fsp.stat(path.join(dir, r))).size);
  }
  return out;
}
/** Throws unless every file of <from> is in <to>, and the ones copied just now (`copied`; every file when it is null) have
 *  the size of the original. profile.json is only checked to be there: the moved avatar's own copy is rewritten. */
async function assertComplete(from: string, to: string, copied: ReadonlySet<string> | null): Promise<void> {
  for (const [rel, size] of await treeSizes(from)) {
    const got = await fsp.stat(path.join(to, rel)).then((s) => s.size, () => -1);
    if (got < 0) throw new Error(`the copy is missing ${rel}`);
    if (rel !== 'profile.json' && (copied === null || copied.has(rel)) && got !== size) throw new Error(`the copy of ${rel} is incomplete`);
  }
}
/** Copy the files of <from> that <to> does not have (a file already there is never overwritten), each one into a .part
 *  file first, so a copy that stops half way never leaves a short file under its real name. */
async function copyMissing(from: string, to: string, copied: Set<string>, rel = ''): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { await copyMissing(a, b, copied, r); continue; }
    if (!e.isFile() || await isThere(b)) continue;
    const part = `${b}.part`;
    try { await fsp.copyFile(a, part); await fsp.rename(part, b); copied.add(r); }
    catch (err) { await fsp.rm(part, { force: true }).catch(() => {}); throw err; }
  }
}
/** Remove a folder; true when it is gone. A file that is open (Windows) or a read-only mount leaves it: not an error. */
async function removeTree(dir: string): Promise<boolean> {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }).catch(() => {});
  return !(await isThere(dir));
}

/** Move one avatar folder <from> (the program folder) to <to> (library/<id>) as the user's own. A library/<id> that is
 *  already there (an edit saved while the avatar counted as builtin) keeps its edits: the program copy only adds what is
 *  missing. Throws, with the program copy untouched, when
 *  the avatar can't be put in the library whole.
 *  `leftover`: it is in the library, complete, but the program-folder copy could not be removed (a file in it is open). */
export async function adoptUserAvatarAsync(from: string, to: string, id: string): Promise<{ leftover: boolean }> {
  const base = readJson(path.join(from, 'profile.json'));
  if (!base) throw new Error('it has no readable profile.json');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  if (!(await isThere(to))) {
    const renamed = await fsp.rename(from, to).then(() => true, () => false);   // the whole folder at once: it is all there or still where it was
    if (renamed) {
      await writeJsonAtomic(path.join(to, 'profile.json'), ownProfile(base, id)).catch(() => {});   // (the list calls it the user's own anyway)
      return { leftover: false };
    }
    // another disk, or a file in it is open: copy it
    const tmp = path.join(path.dirname(to), `.adopt-${id}`);          // (a dot folder: never listed)
    await fsp.rm(tmp, { recursive: true, force: true });
    try {
      await fsp.cp(from, tmp, { recursive: true, errorOnExist: true });
      await writeJsonAtomic(path.join(tmp, 'profile.json'), ownProfile(base, id));
      await assertComplete(from, tmp, null);
      await fsp.rename(tmp, to);                                      // in place only when complete
    } catch (e) { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); throw e; }
    return { leftover: !(await removeTree(from)) };
  }
  // an override is already there: its edits win; the program copy adds what is missing, then the merged profile is
  // written, and only then does the program copy go (a failed write leaves the program copy as it was)
  const copied = new Set<string>();
  await copyMissing(from, to, copied);
  await writeJsonAtomic(path.join(to, 'profile.json'), ownProfile(mergeProfiles(base, readJson(path.join(to, 'profile.json'))), id));
  await assertComplete(from, to, copied);
  return { leftover: !(await removeTree(from)) };
}

/** `library/.adopt-<name>` is a copy of a program-folder avatar made on its way into the library: <name> is the folder's own
 *  name, or <id>-2, <id>-3 ... when the update scripts kept a clash under another name. True when that avatar is still in
 *  <builtinDir>: then the dot folder is only a copy and may go. */
async function originalIsThere(builtinDir: string, name: string): Promise<boolean> {
  for (const id of new Set([name, name.replace(/-\d+$/, '')])) {
    if (id && ID_RE.test(id) && !id.includes('..') && await isThere(path.join(builtinDir, id, 'profile.json'))) return true;
  }
  return false;
}

/** Move the user's avatars out of <builtinDir> (the program folder) into <libraryDir>. Returns the ids moved. Never
 *  throws; a folder that can't move stays (the server still lists and deletes it as the user's: server/library.ts). */
export async function moveUserAvatars(root: string, builtinDir: string, libraryDir: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const shipped = shippedAvatarIds(root);
  if (!shipped || path.resolve(builtinDir) === path.resolve(libraryDir)) return [];
  let dirs: fs.Dirent[] = [];
  try { dirs = await fsp.readdir(builtinDir, { withFileTypes: true }); } catch { return []; }
  // a copy that was cut short (the server was stopped in the middle) is only ever a dot folder in the library: never used, and
  // cleared here, but only when the avatar it was made from is still in the program folder (it is then just a copy, made again
  // below). A dot folder with no original anywhere may be the only copy (a setup that stopped half way): it is left alone.
  try {
    for (const e of await fsp.readdir(libraryDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('.adopt-') && await originalIsThere(builtinDir, e.name.slice('.adopt-'.length))) await fsp.rm(path.join(libraryDir, e.name), { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* no library yet */ }
  const moved: string[] = [];
  for (const d of dirs) {
    const low = d.name.toLowerCase();
    if (!d.isDirectory() || d.name.startsWith('.') || !ID_RE.test(d.name) || d.name.includes('..') || shipped.has(low)) continue;
    const from = path.join(builtinDir, d.name);
    if (!(await isThere(path.join(from, 'profile.json')))) continue;
    try {
      const r = await adoptUserAvatarAsync(from, path.join(libraryDir, d.name), d.name);
      moved.push(d.name);
      if (r.leftover) log(`[avatars] ${d.name} is in your avatars folder now, but VTube Pro could not remove the old copy in its program folder (another program is using it)`);
    } catch (e) { log(`[avatars] could not move ${d.name} to your avatars folder: ${(e as Error).message}`); }
  }
  if (moved.length) log(`[avatars] moved ${moved.length} of your avatar(s) out of the program folder into ${libraryDir}: ${moved.join(', ')}`);
  return moved;
}
