// Avatar library: user avatars in library/<id>/, shipped avatars in assets/builtin/<id>/.
// A builtin can be customised: its edited profile is saved as library/<id>/profile.json (an "override")
// while the model file keeps being served from the builtin folder.
//
// The listed avatars are kept in memory (the "catalog", at the end of this file): GET /api/avatars, the VTube Studio
// API and getProfile read it instead of scanning the disk. That scan ran on the same thread that relays tracking frames
// to the OBS pages and froze them for 30-250 ms per call (95 avatars: 2-15 frames at 60 Hz). Profile saves, chat
// totals, polls and the scene state are written with writeFileSoon (async, coalesced) for the same reason.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AvatarProfile } from '../shared/types.ts';
import { defaultProfile, normalizeProfile } from '../shared/defaults.ts';
import { gltfStats, type ModelStats } from '../shared/modelStats.ts';
import { defaultFlatConfig, safeRel, sanitizeFlatConfig, type FlatAvatarConfig } from '../shared/flatAvatar.ts';
import { planPictures } from '../shared/flatImport.ts';
import { sanitizeSize } from '../shared/avatarSize.ts';
import { sanitizeNeck } from '../shared/neck.ts';
import { sanitizeMech } from '../shared/mech.ts';
import { BUILTIN_DIR, CACHE_DIR, LIBRARY_DIR, ROOT, TRASH_DIR } from './paths.ts';
import { adoptUserAvatarAsync, ownSource, shippedAvatarIds } from './userAvatars.ts';
import { ownCostumes } from '../shared/ownAvatar.ts';
import { broadcast } from './bus.ts';
import { keepRigRev } from '../shared/rig2d/rigRev.ts';
import { findBlender, runBlender } from './blender.ts';
import { type CatalogWatch, watchCatalogFolder } from './roomList.ts';
import { isStoredBody } from '../shared/bodyKind.ts';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export function assertId(id: string) {
  if (!ID_RE.test(id) || id.includes('..')) throw new HttpError(400, `Invalid avatar id '${id}'`);
}

export const userDir = (id: string) => path.join(LIBRARY_DIR, id);
export const builtinDir = (id: string) => path.join(BUILTIN_DIR, id);
/** The avatar ids this release ships (release_manifest.json); null = a source checkout: every assets/builtin folder is
 *  shipped content there. 'builtin' (protected, never deleted) is decided from this, never from a profile's "source" or
 *  from a folder sitting in the program folder: an AI app, a creator script or a copied profile can leave both on the
 *  user's own avatar (server/userAvatars.ts). */
const SHIPPED = shippedAvatarIds(ROOT);
const ships = (id: string) => SHIPPED === null || SHIPPED.has(id.toLowerCase());

// ---------------------------------------------------------------- coalesced async file writes
// writeFileSoon(file, text): written on the libuv thread pool (temp file + rename), never on the thread that relays
// tracking frames; a burst (a sub train, slider drags) becomes at most one write per `gapMs`, with the latest data.
// writeFileNow(file, text): the same writer with no gap, and the caller waits for the write: its promise fails with the
// write's error (ENOSPC on a full disk ...), so profile saves and PUT /api/scene answer "failed" as before.
// Readers in this process get the pending text (pendingWriteText), so nothing here reads an older file meanwhile.
// Whatever is still pending is written synchronously when the process exits (tray Quit, update restart, Ctrl+C).
// A function is asked for the text right before the write (and by readers: pendingWriteText), so it must not change anything
// except idempotently; it may answer null = "nothing to write after all" (the file on disk is the one to keep): the waiting
// callers are then released without an error and nothing is written.
type WriteSrc = string | (() => string | null);
interface Waiter { resolve: () => void; reject: (e: Error) => void }
interface WriteSlot {
  src: WriteSrc | null; writing: string | null; busy: boolean; timer: NodeJS.Timeout | null; lastAt: number; gap: number; idle: (() => void)[];
  /** may the write make the file's folder? (false for an avatar folder: a deleted avatar is never brought back) */
  mkdir: boolean;
  /** writeFileNow callers waiting for `src` (the write that takes it settles them; a newer src takes them along) */
  waiting: Waiter[];
}
const writeSlots = new Map<string, WriteSlot>();
/** Files this process is writing / wrote in the last 2 s (the catalog's fs.watch skips its own writes). */
const ownWrites = new Map<string, number>();
const OWN_WRITE_MS = 2000;
/** sha1 of the two newest texts this process wrote to a file. The catalog checks a profile.json event against them:
 *  the time window alone also swallowed an outside edit made within 2 s of our save (then served stale, and a save of
 *  ours merged onto the stale copy, for up to 60 s). */
const ownTexts = new Map<string, string[]>();
const textHash = (t: string | Buffer) => crypto.createHash('sha1').update(t).digest('base64');
function noteOwnText(file: string, text: string) {
  const h = textHash(text), a = ownTexts.get(file) ?? [];
  if (a[a.length - 1] !== h) { a.push(h); if (a.length > 2) a.shift(); }
  ownTexts.set(file, a);
}
/** isOwnContent reads still running. Windows refuses to rename a folder while a file in it is open, so trashAvatar
 *  waits for the ones under the avatar's folder (DELETE right after a save used to fail with EPERM: 2 in 20). */
const ownReads = new Set<{ file: string; p: Promise<unknown> }>();
/** Is what is in `file` now something this process wrote? (async: never a read on the frame-relay thread) */
async function isOwnContent(file: string): Promise<boolean> {
  const mine = ownTexts.get(file);
  if (!mine) return false;
  const r = { file, p: fsp.readFile(file).catch(() => null) };
  ownReads.add(r);
  const buf = await r.p;
  ownReads.delete(r);
  return buf !== null && mine.includes(textHash(buf));
}
/** fs rename that rides out Windows' "in use" errors (a list refresh or a virus scanner reading a file inside for a
 *  moment): up to 6 more tries over ~1.3 s, then the error. */
async function renameRetry(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (i < 6 && ['EPERM', 'EACCES', 'EBUSY'].includes(code)) { await new Promise((r) => setTimeout(r, 20 * 2 ** i)); continue; }
      throw e;
    }
  }
}

function slotOf(file: string, gapMs: number): WriteSlot {
  let s = writeSlots.get(file);
  if (!s) { s = { src: null, writing: null, busy: false, timer: null, lastAt: 0, gap: gapMs, idle: [], mkdir: true, waiting: [] }; writeSlots.set(file, s); }
  return s;
}
export function writeFileSoon(file: string, data: WriteSrc, gapMs = 500, o: { mkdir?: boolean } = {}): void {
  const s = slotOf(file, gapMs);
  s.src = data; s.gap = s.waiting.length ? 0 : gapMs; s.mkdir = o.mkdir ?? true;   // (someone waits for it: no gap)
  scheduleWrite(file, s);
}
/** Write `file` now, off the event loop (temp file + rename), and wait for it. Rejects with the write's error. Writes of
 *  one file stay in order: asked for while one runs, it is made right after it with the newest data (the callers queued
 *  meanwhile share that write and its result). `mkdir: false` = never make the folder (the write then fails with ENOENT
 *  when the folder is gone). */
export function writeFileNow(file: string, data: WriteSrc, o: { mkdir?: boolean } = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = slotOf(file, 0);
    s.src = data; s.gap = 0; s.mkdir = o.mkdir ?? true;
    s.waiting.push({ resolve, reject });
    if (s.timer && !s.busy) { clearTimeout(s.timer); s.timer = null; }   // a writeFileSoon gap: not for a waiting caller
    scheduleWrite(file, s);
  });
}
function scheduleWrite(file: string, s: WriteSlot) {
  if (s.busy || s.timer) return;                                    // the running write looks again when it ends
  s.timer = setTimeout(() => { s.timer = null; void runWrite(file, s); }, Math.max(0, s.lastAt + s.gap - Date.now()));
}
async function runWrite(file: string, s: WriteSlot) {
  const src = s.src, mkdir = s.mkdir, waiters = s.waiting.splice(0);
  s.src = null;
  let err: Error | null = null;
  if (src !== null) {
    let text: string | null = null;
    try { text = typeof src === 'function' ? src() : src; } catch (e) { err = e as Error; console.warn(`[vtube-pro] could not prepare ${path.basename(file)}: ${err.message}`); }
    if (text !== null) {
      s.busy = true; s.writing = text;
      ownWrites.set(file, Infinity);
      noteOwnText(file, text);
      try { await atomicWrite(file, text, mkdir); } catch (e) { err = e as Error; console.warn(`[vtube-pro] could not save ${file}: ${err.message}`); }
      ownWrites.set(file, Date.now() + OWN_WRITE_MS);
      s.busy = false; s.writing = null; s.lastAt = Date.now();
    }
  }
  for (const w of waiters) { if (err) w.reject(err); else w.resolve(); }
  if (s.src !== null) { scheduleWrite(file, s); return; }
  for (const f of s.idle.splice(0)) f();                            // (the slot stays: it remembers when it last wrote)
}
/** Drop the writes queued for the matching files (not started yet): their callers get `why`. A write already running
 *  finishes (an avatar folder's writes never make the folder: once it is gone, that write fails). */
function cancelWrites(match: (file: string) => boolean, why: Error) {
  for (const [file, s] of [...writeSlots]) {
    if (!match(file)) continue;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.src = null;
    for (const w of s.waiting.splice(0)) w.reject(why);
    if (!s.busy) { for (const f of s.idle.splice(0)) f(); writeSlots.delete(file); }
  }
}
async function atomicWrite(file: string, text: string, mkdir = true) {
  if (mkdir) await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // (a full disk: the half-written temp file goes; the old file is untouched)
  try { await fsp.writeFile(tmp, text); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  for (let i = 0; ; i++) {
    try { await fsp.rename(tmp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      // Windows: a reader or a virus scanner can hold the file for a moment
      if (i < 4 && ['EPERM', 'EACCES', 'EBUSY'].includes(code)) { await new Promise((r) => setTimeout(r, 25 * (i + 1))); continue; }
      // last resort: in place. An interrupted in-place write leaves a short file (an avatar whose profile.json is cut off is not
      // listed), so the file it replaces is kept next to it first (profile.json.bak: reindexLibrary restores from it)
      await fsp.copyFile(file, `${file}.bak`).catch(() => {});
      await fsp.writeFile(file, text);
      await fsp.rm(tmp, { force: true }).catch(() => {});
      return;
    }
  }
}
/** The newest text queued or being written for `file` (undefined = the file on disk is current). */
export function pendingWriteText(file: string): string | undefined {
  const s = writeSlots.get(file);
  if (!s) return undefined;
  if (s.src !== null) { try { return (typeof s.src === 'function' ? s.src() : s.src) ?? s.writing ?? undefined; } catch { return undefined; } }
  return s.writing ?? undefined;
}
function flushSlots(match: (file: string) => boolean): Promise<void> {
  const mine = [...writeSlots.entries()].filter(([f, s]) => match(f) && (s.busy || s.timer || s.src !== null));
  return Promise.all(mine.map(([file, s]) => new Promise<void>((r) => {
    s.idle.push(r);
    if (s.timer) { clearTimeout(s.timer); s.timer = null; void runWrite(file, s); }
  }))).then(() => undefined);
}
/** Wait until every queued write is on disk (tests, a clean shutdown). */
export function flushWrites(): Promise<void> { return flushSlots(() => true); }
/** Process exit: write what is still pending, synchronously (no new folders: a test may have removed its temp tree). */
export function flushWritesSync() {
  for (const [file, s] of writeSlots) {
    let text: string | null = null;
    try { text = s.src !== null ? (typeof s.src === 'function' ? s.src() : s.src) : s.writing; } catch { text = s.writing; }
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    s.src = null;
    if (text === null) continue;
    try { fs.writeFileSync(file, text); } catch { /* best effort */ }
    try { fs.rmSync(`${file}.${process.pid}.tmp`, { force: true }); } catch { /* */ }
  }
  writeSlots.clear();
}
process.on('exit', flushWritesSync);
function isOwnWrite(file: string) {
  const t = ownWrites.get(file);
  if (t === undefined) return false;
  if (t >= Date.now()) return true;
  ownWrites.delete(file);
  return false;
}

// ---------------------------------------------------------------- reading profiles
function readProfileFile(file: string): Partial<AvatarProfile> | null {
  const pending = pendingWriteText(file);
  try {
    return JSON.parse(pending ?? fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
async function readProfileFileAsync(file: string): Promise<Partial<AvatarProfile> | null> {
  const pending = pendingWriteText(file);
  try {
    return JSON.parse(pending ?? await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}
const isFileAsync = (p: string) => fsp.stat(p).then((s) => s.isFile(), () => false);

/** The profile getProfile shows, from the raw files: the override (library/<id>) over the shipped base. */
function composeProfile(id: string, override: Partial<AvatarProfile> | null, base: Partial<AvatarProfile> | null, builtin: boolean, shipped = builtin): AvatarProfile | null {
  const raw = override ?? base;
  if (!raw) return null;
  // a user override keeps its own edits, but costumes shipped later with the builtin must still show up
  if (override && base?.costumes?.length) {
    const have = new Set((override.costumes ?? []).map((c) => c.id));
    const added = base.costumes.filter((c) => !have.has(c.id));
    const byId = new Map(base.costumes.map((c) => [c.id, c]));
    // shipped metadata the user never edits (outfit vs accessory) follows the builtin
    const kept = (override.costumes ?? []).map((c) => {
      const b = byId.get(c.id);
      if (!b) return c;
      const out = { ...c };
      if (out.kind === undefined && b.kind) out.kind = b.kind;
      if (out.fit === undefined && b.fit) out.fit = b.fit;
      return out;
    });
    raw.costumes = [...kept, ...added];
  }
  // settings blocks shipped later with the builtin (that the override predates) follow the builtin
  if (override && base) {
    for (const k of ['speechMotion', 'buddy'] as const) if (override[k] === undefined && base[k] !== undefined) raw[k] = base[k] as never;
  }
  const p = normalizeProfile({
    ...raw,
    id,
    modelFile: raw.modelFile ?? 'model.glb',
    ...(builtin && !raw.source ? { source: 'builtin' as const } : {}),
  });
  // only what VTube Pro ships is 'builtin': a user's avatar whose file says so
  // is listed as the user's own, and the studio offers Delete for it; so are its costumes (a creator script marks those too)
  if (!shipped) { p.source = ownSource(p.source); p.costumes = ownCostumes(p.costumes); }
  p.shipped = shipped;                                               // computed on every list / get, never stored
  return p;
}

function isBuiltinOnDisk(id: string) {
  return ships(id) && fs.existsSync(path.join(builtinDir(id), 'profile.json'));
}
/** A folder in the program folder that this release does not ship (left there by a creator script or an AI app, or one
 *  moveUserAvatars could not move at start): the user's own avatar, listed and deleted as one. */
function strayOnDisk(id: string) {
  return !ships(id) && fs.existsSync(path.join(builtinDir(id), 'profile.json'));
}

export function isBuiltin(id: string) {
  const e = cachedEntry(id);
  return e ? e.builtin : isBuiltinOnDisk(id);
}

/** getProfile from disk (what the catalog caches). */
function readProfileSync(id: string): AvatarProfile | null {
  const builtin = isBuiltinOnDisk(id);
  const override = readProfileFile(path.join(userDir(id), 'profile.json'));
  const base = readProfileFile(path.join(builtinDir(id), 'profile.json'));
  return composeProfile(id, override, base, builtin, builtin);
}

/** Profile for an id, preferring the user override over the builtin. Null if unknown. (From the catalog when it has
 *  the avatar: a copy, so callers may change it.) */
export function getProfile(id: string): AvatarProfile | null {
  assertId(id);
  const e = cachedEntry(id);
  if (e) return structuredClone(e.p);
  const p = readProfileSync(id);
  if (p && catalog.ready && !catalog.byId.has(id)) queueAvatarRefresh(id);   // made by another writer: list it soon
  return p;
}

export function requireProfile(id: string): AvatarProfile {
  const p = getProfile(id);
  if (!p) throw new HttpError(404, `No avatar '${id}'`);
  return p;
}

function listDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}
async function listDirsAsync(root: string): Promise<string[]> {
  try {
    return (await fsp.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && ID_RE.test(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** The library straight from disk (only while the catalog is not running: tests, tools). */
function scanAvatarsSync(): AvatarProfile[] {
  const builtins = listDirs(BUILTIN_DIR).filter(isBuiltinOnDisk).sort();
  const seen = new Set(builtins);
  const out: AvatarProfile[] = [];
  for (const id of builtins) {
    const p = readProfileSync(id);
    if (p) out.push(p);
  }
  const user: AvatarProfile[] = [];
  for (const id of new Set([...listDirs(LIBRARY_DIR), ...listDirs(BUILTIN_DIR).filter(strayOnDisk)])) {   // (+ the user's avatars left in the program folder)
    if (seen.has(id)) continue;
    const p = readProfileSync(id);
    if (p) user.push(p);
  }
  user.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  const all = out.concat(user);
  // polycount etc. for the library cards / MCP (counted from the glTF JSON only; never saved)
  for (const p of all) { const s = modelStatsOf(p); if (s) p.modelStats = s; }
  return all;
}

/** All avatars, builtins first (alphabetical), then user avatars newest first. (A copy: callers may change it.) */
export function listAvatars(): AvatarProfile[] {
  if (catalog.ready) return structuredClone(catalog.list) as AvatarProfile[];
  return scanAvatarsSync();
}

const statsCache = new Map<string, { key: string; stats: ModelStats | null }>();
/** Triangles / vertices / meshes of an avatar's model (.glb / .vrm / .gltf), read from the glTF JSON chunk only
 *  (a 150 MB VRM costs one small read), cached by file size + mtime. Null for other formats / unreadable files. */
export function modelStatsOf(p: AvatarProfile): ModelStats | null {
  let f: string | null = null;
  try { f = resolveAvatarFile(p.id, p.modelFile); } catch { return null; }
  return f ? fileStats(f) : null;
}

/** Stats of a model file on disk (.glb / .vrm / .gltf; JSON chunk only, cached by size + mtime). */
export function fileStats(f: string): ModelStats | null {
  const ext = path.extname(f).toLowerCase();
  if (!['.glb', '.vrm', '.gltf'].includes(ext)) return null;
  let st: fs.Stats;
  try { st = fs.statSync(f); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = statsCache.get(f);
  if (hit?.key === key) return hit.stats;
  let stats: ModelStats | null = null;
  try {
    if (ext === '.gltf') stats = gltfStats(JSON.parse(fs.readFileSync(f, 'utf8')));
    else {
      const fd = fs.openSync(f, 'r');
      try {
        const hd = Buffer.alloc(20);
        fs.readSync(fd, hd, 0, 20, 0);
        const len = hd.readUInt32LE(12);
        if (hd.readUInt32LE(0) === 0x46546c67 && hd.readUInt32LE(16) === 0x4e4f534a && len > 0 && len < 64 << 20 && 20 + len <= st.size) {
          const jb = Buffer.alloc(len);
          fs.readSync(fd, jb, 0, len, 20);
          stats = gltfStats(JSON.parse(jb.toString('utf8')));
        }
      } finally { fs.closeSync(fd); }
    }
  } catch { stats = null; }
  statsCache.set(f, { key, stats });
  return stats;
}
/** fileStats off the event loop (the catalog); the same cache. */
async function fileStatsAsync(f: string): Promise<ModelStats | null> {
  const ext = path.extname(f).toLowerCase();
  if (!['.glb', '.vrm', '.gltf'].includes(ext)) return null;
  let st: fs.Stats;
  try { st = await fsp.stat(f); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = statsCache.get(f);
  if (hit?.key === key) return hit.stats;
  let stats: ModelStats | null = null;
  try {
    if (ext === '.gltf') stats = gltfStats(JSON.parse(await fsp.readFile(f, 'utf8')));
    else {
      const fh = await fsp.open(f, 'r');
      try {
        const hd = Buffer.alloc(20);
        await fh.read(hd, 0, 20, 0);
        const len = hd.readUInt32LE(12);
        if (hd.readUInt32LE(0) === 0x46546c67 && hd.readUInt32LE(16) === 0x4e4f534a && len > 0 && len < 64 << 20 && 20 + len <= st.size) {
          const jb = Buffer.alloc(len);
          await fh.read(jb, 0, len, 20);
          stats = gltfStats(JSON.parse(jb.toString('utf8')));
        }
      } finally { await fh.close(); }
    }
  } catch { stats = null; }
  statsCache.set(f, { key, stats });
  return stats;
}

/** May a save make library/<id>/ (the avatar has no folder of its own)? Only for the first edit of a builtin (an
 *  "override"). A user avatar's folder is never made again: once it is deleted (in
 *  the trash) or removed outside, a late save must not bring back a broken "ghost" with only a profile.json. */
function mayMakeOverride(id: string): boolean {
  return isBuiltinOnDisk(id) || strayOnDisk(id);
}
/** The merged profile a save writes, and whether its write may make the folder. Throws 409 while the avatar is being
 *  deleted (saveProfileAsync waits for that instead) and 404 for an avatar that is gone. */
function prepareSave(id: string, profile: Partial<AvatarProfile>): { merged: AvatarProfile; mkdir: boolean } {
  assertId(id);
  if (trashing.has(id)) throw new HttpError(409, `'${id}' is being deleted`);
  const existing = getProfile(id);
  // (one stat: the folder decides whether the write may make it; base did a mkdir + a write here, synchronously)
  const hasDir = fs.existsSync(userDir(id));
  if (!hasDir && (!existing || !mayMakeOverride(id))) {
    if (existing) invalidateAvatars([id]);                            // listed, but its folder is gone: drop it soon
    throw new HttpError(404, `No avatar '${id}'`);
  }
  const merged = normalizeProfile({ ...(existing ?? {}), ...profile, id, modelFile: profile.modelFile ?? existing?.modelFile ?? 'model.glb' });
  keepRigRev(existing, merged);                                      // "Edit rig": flat.opts.rigRev never goes down (server/rigEdit.ts)
  delete (merged as { modelStats?: unknown }).modelStats;          // computed on list, never stored
  delete (merged as { shipped?: unknown }).shipped;                // computed on list, never stored
  if (!existing?.shipped) { merged.source = ownSource(merged.source); merged.costumes = ownCostumes(merged.costumes); }   // a PUT / an AI's update_avatar never makes the user's avatar (or its costumes) 'builtin'
  const size = sanitizeSize(merged.size);                            // real height (shared/avatarSize.ts): a clean number or nothing
  if (size) merged.size = size; else delete merged.size;
  const neck = sanitizeNeck(merged.neck);                            // neck length / head motion (shared/neck.ts): clamped or nothing
  if (neck) merged.neck = neck; else delete merged.neck;
  if (!isStoredBody(merged.body)) delete merged.body;   // body plan: only the kinds of shared/bodyKind.ts are stored
  const mech = sanitizeMech(merged.mech);                            // walking machine settings (shared/mech.ts): clamped or nothing
  if (mech) merged.mech = mech; else delete merged.mech;
  return { merged, mkdir: !hasDir };
}
/** Queue the write (off the event loop; saves made while one is written share the next write, with the newest data) and
 *  put the save in the list at once (getProfile / the catalog read it while the write is pending). A failed write puts
 *  the list back to what is on disk. */
function commitSave(id: string, merged: AvatarProfile, mkdir: boolean): Promise<void> {
  const written = writeFileNow(path.join(userDir(id), 'profile.json'), JSON.stringify(merged, null, 2), { mkdir });
  noteOwnProfile(id, merged);
  return written.catch((e: Error) => { invalidateAvatars([id]); throw e; });
}

/** Save a profile and wait until it is on disk. Rejects with the write's error (ENOSPC on a full disk ...: the studio says
 *  "Save failed", as before), 404 for an avatar that is gone. A save that comes in while the avatar is being deleted
 *  waits for that DELETE (then 404 when it went through). Routes and jobs use this one. */
export async function saveProfileAsync(id: string, profile: Partial<AvatarProfile>): Promise<AvatarProfile> {
  assertId(id);
  while (trashing.has(id)) await trashing.get(id);                   // (checked right before prepareSave: no gap)
  const { merged, mkdir } = prepareSave(id, profile);
  await commitSave(id, merged, mkdir);
  broadcast({ type: 'profile', avatarId: id });
  return merged;
}

/** Save a profile without waiting for the disk (callers that cannot wait). The write starts at once; when it fails the
 *  error is logged, the list goes back to what is on disk and pages hear a 'profile' change. Prefer saveProfileAsync,
 *  which reports the error to its caller. Throws 409 while the avatar is being deleted. */
export function saveProfile(id: string, profile: Partial<AvatarProfile>): AvatarProfile {
  const { merged, mkdir } = prepareSave(id, profile);
  void commitSave(id, merged, mkdir).catch(() => { broadcast({ type: 'profile', avatarId: id }); });
  broadcast({ type: 'profile', avatarId: id });
  return merged;
}

/** Resolve a file inside an avatar: override folder first, then the builtin folder. */
export function resolveAvatarFile(id: string, file: string): string | null {
  assertId(id);
  const rel = path.normalize(file).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  for (const base of [userDir(id), builtinDir(id)]) {
    const full = path.join(base, rel);
    if (!full.startsWith(base + path.sep)) continue;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}
async function resolveAvatarFileAsync(id: string, file: string): Promise<string | null> {
  const rel = path.normalize(file).replace(/^([/\\])+/, '');
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  for (const base of [userDir(id), builtinDir(id)]) {
    const full = path.join(base, rel);
    if (!full.startsWith(base + path.sep)) continue;
    if (await isFileAsync(full)) return full;
  }
  return null;
}

export function modelPath(p: AvatarProfile): string {
  const f = resolveAvatarFile(p.id, p.modelFile);
  if (!f) throw new HttpError(404, `Model file '${p.modelFile}' for '${p.id}' is missing`);
  return f;
}

export function libraryUrl(id: string, file: string) {
  return `/library/${encodeURIComponent(id)}/${file.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
}

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_.]+/, '')                    // "_Cheese" used to give "-cheese": an id that fails ID_RE, so the avatar was made and never listed
      .slice(0, 40)
      .replace(/[-_.]+$/, '') || 'avatar'
  );
}

export function newAvatarId(name: string) {
  return `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Avatars being moved to the trash (settled when the DELETE is done): their file events start no own-content read (it
 *  would hold profile.json open), saveProfile refuses them (409) and saveProfileAsync / avatarDirForWrite wait. */
const trashing = new Map<string, Promise<void>>();
/** Wait until no DELETE of this avatar is running. */
async function deleteSettled(id: string) {
  for (let p = trashing.get(id); p; p = trashing.get(id)) await p;
}
const isDirAsync = (p: string) => fsp.stat(p).then((s) => s.isDirectory(), () => false);
/** What the user calls an avatar, for a message they read (an older studio and the wardrobe show the helper's sentence as it
 *  is): the name in its profile, never the folder id (a slug like `my-avatar-a1b2c3`). No name, or one that is only the id:
 *  "This avatar". Single line, trimmed, at most 60 characters. */
export function avatarLabel(id: string): string {
  const raw = [path.join(userDir(id), 'profile.json'), path.join(builtinDir(id), 'profile.json')]
    .map((f) => readProfileFile(f)?.name).find((n) => typeof n === 'string' && n.trim());
  const name = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() : '';
  return name && name.toLowerCase() !== id.toLowerCase() ? name : 'This avatar';
}
/** The user's avatar still in the program folder (moveUserAvatars could not move it at start): into the library, so it goes
 *  to the same trash and Undo brings it back as a normal avatar; a costume of it is deleted the same way. Saves and a second
 *  DELETE wait while it moves (the `trashing` lock). 423 (Locked) when the folder can't be moved whole or emptied (a file in
 *  it is open): the copy in the library is then complete, and the user closes the other program and tries again. */
export async function adoptStrayAvatar(id: string): Promise<void> {
  await deleteSettled(id);
  if (!strayOnDisk(id)) return;
  let settle!: () => void;
  trashing.set(id, new Promise<void>((r) => { settle = r; }));
  try {
    const r = await adoptUserAvatarAsync(builtinDir(id), userDir(id), id);
    if (r.leftover) throw new Error('the old copy could not be removed');
  } catch (e) {
    console.log(`[avatars] could not move ${id} out of the program folder: ${(e as Error).message}`);
    throw new HttpError(423, `${avatarLabel(id)} is in VTube Pro's program folder and could not be moved. Close any other program that is using it, then try again.`);
  } finally {
    trashing.delete(id);
    settle();
    invalidateAvatars([id]);
  }
}
/** Move to library/.trash/<id>-<timestamp>. Builtins are refused.
 *  A save that comes in meanwhile can never bring the folder back (a "ghost" with only profile.json, listed after the
 *  next full refresh, that fails to load): saves queued before the DELETE are written first (into the folder that is then
 *  moved), saves during it wait (saveProfileAsync) or are refused (saveProfile), whatever is still queued for the folder
 *  once it is moved is dropped, and a profile write never makes a user avatar's folder (commitSave: mkdir only for a
 *  builtin's first override). */
export async function trashAvatar(id: string) {
  assertId(id);
  if (isBuiltin(id)) throw new HttpError(403, `'${id}' is a builtin avatar and can't be deleted`);
  const dir = userDir(id);
  await deleteSettled(id);
  await adoptStrayAvatar(id);                                        // (one still in the program folder goes to the library first)
  for (;;) {                                                          // (a second DELETE of it waits for the first)
    await deleteSettled(id);
    if (!(await isDirAsync(dir))) {
      throw new HttpError(404, `No avatar '${id}'`);
    }
    if (!trashing.has(id)) break;
  }
  let settle!: () => void;
  trashing.set(id, new Promise<void>((r) => { settle = r; }));
  let moved = false;
  try {
    await flushSlots((f) => f.startsWith(dir + path.sep));           // a profile save still queued for it lands first
    await fsp.mkdir(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    // that save's file event may have started an own-content read of profile.json: Windows will not rename the folder
    // while it is open (EPERM), so wait for it; anything else holding a file for a moment is ridden out by renameRetry
    await Promise.all([...ownReads].filter((r) => r.file.startsWith(dir + path.sep)).map((r) => r.p));
    await renameRetry(dir, dest);
    moved = true;
    cancelWrites((f) => f.startsWith(dir + path.sep), new HttpError(404, `No avatar '${id}'`));
    noteOwnRemoved(id);
    broadcast({ type: 'profile', avatarId: id });
    return dest;
  } finally {
    trashing.delete(id);
    settle();
    if (!moved) invalidateAvatars([id]);                             // still there: file events skipped meanwhile, read it again
  }
}

// ---------------------------------------------------------------- restore from the trash (the studio's Undo)
/** trashAvatar's copy name: `<id>-<ISO time, ':' and '.' as '-'>`. A costume's copy (`<id>-costume-…`, server/costumes.ts)
 *  or another avatar's (`<id>-x-<time>`) never matches. */
const TRASH_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
export function isTrashCopyOf(id: string, name: string): boolean {
  return name.startsWith(`${id}-`) && TRASH_STAMP.test(name.slice(id.length + 1));
}
/** This avatar's copies in the trash (folder names with a profile.json), newest first. */
export async function trashCopies(id: string): Promise<string[]> {
  assertId(id);
  let names: string[];
  try {
    names = (await fsp.readdir(TRASH_DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && isTrashCopyOf(id, d.name)).map((d) => d.name);
  } catch { return []; }
  const ok = await Promise.all(names.map(async (n) => ((await isFileAsync(path.join(TRASH_DIR, n, 'profile.json'))) ? n : null)));
  return ok.filter((n): n is string => !!n).sort().reverse();
}
/** POST /api/avatars/:id/restore: move a trash copy back to library/<id> (`from` = that copy's folder name, as DELETE
 *  answered it; none = the newest). Only while the id is free (no folder of its own, nothing listed under it): never
 *  over another avatar. Builtins are refused like DELETE. Runs under the same per-avatar lock as trashAvatar, so a
 *  DELETE and a restore of one avatar never overlap. */
export async function restoreAvatar(id: string, from?: string): Promise<AvatarProfile> {
  assertId(id);
  if (isBuiltin(id)) throw new HttpError(403, `'${id}' is a builtin avatar: it is never in the trash`);
  if (from !== undefined && !isTrashCopyOf(id, from)) throw new HttpError(400, `'${from}' is not a trash copy of '${id}'`);
  const dir = userDir(id);
  for (;;) { await deleteSettled(id); if (!trashing.has(id)) break; }
  let settle!: () => void;
  trashing.set(id, new Promise<void>((r) => { settle = r; }));
  let moved = false;
  try {
    const copies = await trashCopies(id);
    const pick = from ? copies.find((n) => n === from) : copies[0];
    if (!pick) throw new HttpError(404, `'${id}' is not in the trash folder any more`);
    if ((await isDirAsync(dir)) || getProfile(id)) throw new HttpError(409, `An avatar with the id '${id}' is already in the library`);
    await renameRetry(path.join(TRASH_DIR, pick), dir);
    moved = true;
  } finally {
    trashing.delete(id);
    settle();
    if (moved) invalidateAvatars([id]);                               // listed again on the next refresh (GET waits for it)
  }
  broadcast({ type: 'profile', avatarId: id });
  return requireProfile(id);
}

/** The avatar's own folder, for a write into it (a thumbnail): made only for a builtin's first
 *  override, never again for a deleted avatar (404). Waits for a DELETE of it that is running. */
export async function avatarDirForWrite(id: string): Promise<string> {
  assertId(id);
  await deleteSettled(id);
  const dir = userDir(id);
  if (await isDirAsync(dir)) return dir;
  if (!mayMakeOverride(id)) throw new HttpError(404, `No avatar '${id}'`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export interface CreateAvatarOptions {
  name: string;
  source: AvatarProfile['source'];
  prompt?: string;
  /** Existing file to move/copy in as the model. */
  modelFrom: string;
  /** Target filename inside the avatar folder (default model.<ext>). */
  modelFile?: string;
  move?: boolean;
  extra?: Partial<AvatarProfile>;
}

/** Create a new user avatar from a model file on disk. */
export async function createAvatar(o: CreateAvatarOptions): Promise<AvatarProfile> {
  const id = newAvatarId(o.name);
  const dir = userDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const modelFile = o.modelFile ?? 'model' + path.extname(o.modelFrom).toLowerCase();
  const dest = path.join(dir, modelFile);
  if (o.move) {
    try {
      await fsp.rename(o.modelFrom, dest);
    } catch {
      await fsp.copyFile(o.modelFrom, dest);
      await fsp.rm(o.modelFrom, { force: true });
    }
  } else await fsp.copyFile(o.modelFrom, dest);
  // (a profile copied into `extra` can say 'builtin': never for a new user avatar)
  const profile: AvatarProfile = { ...defaultProfile(id, o.name, modelFile, o.source), ...o.extra, id, modelFile, source: ownSource(o.extra?.source ?? o.source) };
  if (o.prompt) profile.prompt = o.prompt;
  delete (profile as { shipped?: unknown }).shipped;                 // computed on list, never stored (a whole profile in `extra` may carry it)
  const file = path.join(dir, 'profile.json');
  const text = JSON.stringify(profile, null, 2);
  ownWrites.set(file, Infinity);
  noteOwnText(file, text);
  try { await fsp.writeFile(file, text); } finally { ownWrites.set(file, Date.now() + OWN_WRITE_MS); }
  // the importer sees the polycount straight away (too detailed for parties → a warning in the studio)
  const stats = await fileStatsAsync(dest);
  noteOwnCreated(id, profile, stats);
  return stats ? { ...profile, modelStats: stats } : profile;
}

/**
 * Render a front-view thumbnail with Blender and record it on the profile (thumb.png in the avatar's folder).
 * Returns null (without throwing) when Blender is unavailable, rendering fails or the avatar was deleted meanwhile.
 * Blender renders into a scratch folder: the picture is moved in only if the avatar still exists (a DELETE during the
 * render used to leave its folder made again, with the render files in it).
 */
export async function renderThumbnail(id: string, log?: (s: string) => void): Promise<string | null> {
  if (!findBlender()) return null;
  const p = requireProfile(id);
  const tmpRoot = path.join(CACHE_DIR, 'tmp');
  await fsp.mkdir(tmpRoot, { recursive: true });
  const work = await fsp.mkdtemp(path.join(tmpRoot, `thumb-${id}-`));
  try {
    const r = await runBlender<{ images: { path: string }[] }>(
      'render_preview.py',
      { input: modelPath(p), out_dir: work, views: ['front'], size: 512, prefix: '_thumb' },
      { timeoutMs: 180_000 },
    );
    const img = r.result?.images?.[0]?.path;
    if (!r.ok || !img) {
      log?.(`Thumbnail render failed: ${r.error}`);
      return null;
    }
    let dir: string;
    try { dir = await avatarDirForWrite(id); } catch (e) {
      if (e instanceof HttpError && e.status === 404) { log?.(`Thumbnail not saved: avatar '${id}' was deleted`); return null; }
      throw e;
    }
    const dest = path.join(dir, 'thumb.png');
    await fsp.rename(img, dest).catch(async () => { await fsp.copyFile(img, dest); });
    await saveProfileAsync(id, { thumbnail: 'thumb.png' });
    return 'thumb.png';
  } finally {
    fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- re-index: nothing on disk stays hidden
// The catalog LISTS the folders of library/ it can read. A folder whose model is on disk but whose profile.json is cut off,
// empty or gone (an interrupted write, an antivirus holding the file, a hand-copied folder), or whose name is not a valid id
// (an import named "_Cheese.vrm" used to make "-cheese-ab12cd"), was dropped from the list without a word: the user's model
// "disappeared" while its files were still there. Once at start (and once more at the first safety refresh, for folders that
// were too fresh), every such folder gets what it needs to be listed:
//   * a bad profile.json is first restored from a readable profile.json.<pid>.tmp / .bak of it, else a new default profile is
//     written with the model that is there (name from the folder, createdAt from its date); the bad file is KEPT as
//     profile.json.bad-<stamp>;
//   * a folder name that is not a valid id is renamed to a free valid one (the profile's id follows).
// A picture avatar (a set of PNG / GIF / WebP / JPEG pictures, no model file) is an avatar too: its folder gets the same recovery,
// and only when no profile parses is one made from the pictures that are there (roles from the file names, as the importer reads
// them). Live2D / Inochi imports are converted into one model.vtp2 (shared/rig2d/importers.ts), so they are covered by the model rule.
// Never deletes anything, never touches dot-named folders (.trash), a builtin's override folder (no model or pictures of its own,
// only a thumbnail), an empty folder or a folder that changed in the last 30 s (another writer may be in the middle of making it).
// Idempotent. The profile.json it writes goes through the same write queue as a save (writeFileNow), and the "is it still bad?"
// look is made inside that queue right before the write: a save or import that finished after the folder was first looked at is
// never renamed away or written over.
const MODEL_RE = /\.(vrm|glb|gltf|vtp2)$/i;
/** The pictures a picture avatar is made of (shared/flatImport.ts FLAT_IMAGE_EXT). thumb.png is the library's thumbnail, never
 *  one of them (the importer renames a picture called thumb.png). */
const PICTURE_RE = /\.(png|apng|gif|webp|jpe?g)$/i;
const isPicture = (f: string) => PICTURE_RE.test(f) && f.toLowerCase() !== 'thumb.png' && !!safeRel(f);
/** What the files of a folder make: its model, else (a picture avatar) its pictures. */
function avatarFiles(files: readonly string[]): { model: string | null; pictures: string[] } {
  const model = files.find((f) => /^model\./i.test(f) && MODEL_RE.test(f)) ?? files.find((f) => MODEL_RE.test(f)) ?? null;
  return { model, pictures: files.filter(isPicture) };
}
const validFolder = (name: string) => ID_RE.test(name) && !name.includes('..');
/** "my-main-vrm-1a2b3c" -> "My main vrm" */
function niceName(id: string) {
  const t = id.replace(/-[0-9a-f]{6}$/i, '').replace(/[-_.]+/g, ' ').trim() || 'My avatar';
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 60);
}
const profileObject = (text: string): Record<string, unknown> | null => {
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : null;
  } catch { return null; }
};
async function parsedProfile(file: string): Promise<Record<string, unknown> | null> {
  try { return profileObject(await fsp.readFile(file, 'utf8')); } catch { return null; }
}
function parsedProfileSync(file: string): Record<string, unknown> | null {
  try { return profileObject(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
/** The copies of a cut-off profile.json worth trying, best first. atomicWrite writes the WHOLE new text to
 *  profile.json.<pid>.tmp before anything else, and only if the rename keeps failing copies the old file to profile.json.bak
 *  (a NEWER file than the .tmp, holding OLDER content) and writes in place. So a complete .tmp is the user's latest save and
 *  comes first (newest first); the .bak is the last resort. */
export async function recoveryCandidates(dir: string, files: readonly string[]): Promise<string[]> {
  const tmps: [string, number][] = [];
  for (const f of files) if (/^profile\.json\.\d+\.tmp$/.test(f)) tmps.push([f, (await fsp.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0]);
  tmps.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  return [...tmps.map(([f]) => f), ...files.filter((f) => f === 'profile.json.bak')];
}
/** The 2D settings of a picture avatar when only its pictures are known: the roles come from the file names, the way the importer
 *  reads them (shared/flatImport.ts planPictures: idle / talk / blink words, else name order). `main` (if given) must stay the
 *  idle picture, because it is what the profile already says. */
function picturesFlat(pictures: readonly string[], main?: string): FlatAvatarConfig {
  const plan = planPictures([...pictures]);
  if ('error' in plan || (main && plan.idle !== main)) return defaultFlatConfig('png', main ?? [...pictures].sort()[0]);
  const cfg = defaultFlatConfig('png', plan.idle);
  const png = cfg.png!;
  if (plan.talk) png.talk = plan.talk;
  if (plan.blink) png.blink = plan.blink;
  if (plan.talkBlink) png.talkBlink = plan.talkBlink;
  png.states = plan.states;
  return cfg;
}
/** A 2D avatar is told from a 3D one by profile.flat alone (AvatarRuntime loads a model that has no flat as a glTF): a profile
 *  written for a model.vtp2 folder gets the default 2D rig settings, one written for a picture avatar gets a picture set's, or
 *  the avatar would be listed and not load. */
function withFlatFor<T extends object>(p: T, pictures: readonly string[]): T {
  const { modelFile, flat } = p as { modelFile?: unknown; flat?: unknown };
  const mf = typeof modelFile === 'string' ? modelFile : '';
  if (flat && sanitizeFlatConfig(flat)) return p;                                 // (already has usable 2D settings)
  if (/\.vtp2$/i.test(mf)) return { ...p, flat: defaultFlatConfig('rig2d', mf) };
  if (PICTURE_RE.test(mf) && safeRel(mf)) return { ...p, flat: picturesFlat(pictures, mf) };
  return p;                                                                       // (a 3D avatar)
}
export interface ReindexResult { fixed: string[]; renamed: [string, string][] }
export async function reindexLibrary(o: { quietMs?: number } = {}): Promise<ReindexResult> {
  const quietMs = o.quietMs ?? 30_000;
  const out: ReindexResult = { fixed: [], renamed: [] };
  let dirs: string[];
  try { dirs = (await fsp.readdir(LIBRARY_DIR, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return out; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const name of dirs) {
    try {
      let id = name, dir = path.join(LIBRARY_DIR, id);
      const profile = await parsedProfile(path.join(dir, 'profile.json'));
      if (profile && validFolder(id)) continue;                                  // listed already (the common case)
      const files = await fsp.readdir(dir).catch(() => [] as string[]);
      const { model, pictures } = avatarFiles(files);
      const main = model ?? (pictures.length ? picturesFlat(pictures).main : null);   // (a picture avatar's main file is its idle picture)
      if (!main) continue;                                                       // an override of a builtin, an empty or half-made folder: nothing to list
      if (await isFileAsync(path.join(builtinDir(id), 'profile.json'))) continue;
      let newest = (await fsp.stat(dir)).mtimeMs;
      for (const f of files) newest = Math.max(newest, (await fsp.stat(path.join(dir, f)).catch(() => null))?.mtimeMs ?? 0);
      if (Date.now() - newest < quietMs) continue;                               // too fresh: the next pass
      if (!validFolder(id)) {
        for (let i = 0; i < 6; i++) {
          const next = newAvatarId(id);
          if (await fsp.stat(path.join(LIBRARY_DIR, next)).then(() => true, () => false)) continue;
          await fsp.rename(dir, path.join(LIBRARY_DIR, next));
          out.renamed.push([id, next]); id = next; dir = path.join(LIBRARY_DIR, id);
          break;
        }
        if (id === name) { console.warn(`[library] "${name}" holds a model but is not a valid avatar id and could not be renamed`); continue; }
        if (profile) {                                                           // (its id follows the folder; the profile as it was stays next to it)
          await fsp.copyFile(path.join(dir, 'profile.json'), path.join(dir, `profile.json.renamed-${stamp}`));
          await writeFileNow(path.join(dir, 'profile.json'), JSON.stringify({ ...profile, id }, null, 2), { mkdir: false }); out.fixed.push(id); continue;
        }
      }
      // a profile.json that is cut off / empty / gone: a readable copy of it, else a fresh default for the model that is there
      const pj = path.join(dir, 'profile.json');
      let recovered: Record<string, unknown> | null = null;
      for (const f of await recoveryCandidates(dir, files)) {
        const c = await parsedProfile(path.join(dir, f));
        if (c) { recovered = c; break; }
      }
      const text = JSON.stringify(recovered
        ? withFlatFor({ ...recovered, id, modelFile: typeof recovered.modelFile === 'string' ? recovered.modelFile : main }, pictures)
        : withFlatFor({ ...normalizeProfile({ ...defaultProfile(id, niceName(id), main, 'import'), createdAt: new Date(newest).toISOString() }), ...(model ? {} : { thumbnail: main }) }, pictures), null, 2);
      // The look at profile.json and the write happen together, inside the queue every save goes through. A profile.json that
      // parses by then (a save or an import finished since this folder was first looked at) is the user's: left alone. A save that
      // is queued or running for it is the newer word: this folder is left for the next pass. The bad file is copied aside (never
      // moved, so a failure half way still leaves it where it was) right before it is replaced.
      if (pendingWriteText(pj) !== undefined) continue;
      const bad = `${pj}.bad-${stamp}`;
      await writeFileNow(pj, () => {
        if (parsedProfileSync(pj)) return null;
        if (fs.existsSync(pj)) fs.copyFileSync(pj, bad);
        return text;
      }, { mkdir: false });
      if ((await fsp.readFile(pj, 'utf8').catch(() => null)) === text) out.fixed.push(id);
    } catch (e) { console.warn(`[library] could not re-index "${name}":`, (e as Error).message); }
  }
  if (out.fixed.length || out.renamed.length) console.log(`[library] re-indexed ${new Set([...out.fixed, ...out.renamed.map((r) => r[1])]).size} avatar folder(s)`);
  return out;
}
/** "Fix it" in the studio's Me tab (POST /api/avatars/reindex), for a helper that lists none of the user's avatars: look at library/
 *  again NOW and list what is there. The same pass as at start (it never deletes anything); a folder that has been quiet for
 *  5 s is fair game, since the user is asking and nobody else is likely to be writing. Answers how many folders it repaired
 *  and how many of the user's own avatars the helper lists now (the studio says "your 3 avatars are back", or that there
 *  are still none). */
export async function reindexForStudio(): Promise<{ fixed: number; avatars: number }> {
  const r = await reindexLibrary({ quietMs: 5_000 });
  invalidateAvatars();
  const list = (await avatarCatalog()).list;
  return { fixed: new Set([...r.fixed, ...r.renamed.map((x) => x[1])]).size, avatars: list.filter((a) => a.source !== 'builtin' && a.source !== 'builtin-test').length };
}
/** Folders of library/ that hold files but could not be listed: said once each (they used to vanish without a word). */
const unlistedSaid = new Set<string>();
async function sayUnlisted(ids: string[]) {
  for (const id of ids) {
    if (unlistedSaid.has(id)) continue;
    const files = await fsp.readdir(userDir(id)).catch(() => [] as string[]);
    const { model, pictures } = avatarFiles(files);
    if (!model && !pictures.length) continue;                                    // (an empty folder is not an avatar that went missing)
    unlistedSaid.add(id);
    console.warn(`[library] "${id}" has ${model ? 'a model' : 'pictures'} but no readable profile.json, so it is not listed`);
  }
}

// ---------------------------------------------------------------- the avatar catalog (in memory)
// Built once at startup with async fs (startAvatarCatalog, called by server/routes/avatars.ts). Kept fresh by:
//   * this module's own writes (saveProfile, createAvatar, trashAvatar): updated in place, at once;
//   * fs.watch on library/ and assets/builtin/ (250 ms debounce;
//     server/roomList.ts watchCatalogFolder): costumes, party versions ... write there without this module. A changed avatar is read from disk by getProfile
//     until a refresh that started after the change has re-read it;
//   * a full refresh every 60 s, in case a watcher missed something.
// Refreshes run in the background (async fs, 4 files at a time). GET /api/avatars (avatarCatalog) waits for the refresh
// of the file events seen before it (the studio re-lists right after an install / removal); the 60 s refresh is not
// waited for.
interface Entry { id: string; p: AvatarProfile; base: Partial<AvatarProfile> | null; builtin: boolean; shipped: boolean; stats: ModelStats | null; listed: AvatarProfile }
const catalog = {
  ready: false,
  started: false,
  first: null as Promise<void> | null,
  byId: new Map<string, Entry>(),
  rank: new Map<string, number>(),          // folder-listing order (the tie-break of the newest-first sort)
  list: [] as AvatarProfile[],              // the listed profiles in list order: shared, never changed in place
  json: null as string | null,
  body: Buffer.alloc(0),                    // json as UTF-8 (sent as is: no per-request encoding)
  etag: '',
  dirty: new Set<string>(),                 // changed on disk, not re-read yet: getProfile reads the disk for these
  queued: new Set<string>(),                // to re-read on the next refresh
  all: false,                               // re-read everything on the next refresh
  seq: 0,
  ownSeq: new Map<string, number>(),        // this module's own changes (newer than a refresh that started before them)
  evSeq: new Map<string, number>(),         // file events
  lastEvent: 0,                             // seq of the newest file event / outside invalidation
  applied: 0,                               // every change up to this seq is in the list
  running: null as Promise<void> | null,
  timer: null as NodeJS.Timeout | null,
  firstEventAt: 0,
  watchers: new Map<string, CatalogWatch>(),  // by folder
  arming: Promise.resolve(),
  refreshes: 0,
};

function cachedEntry(id: string): Entry | null {
  if (!catalog.ready || catalog.dirty.has(id)) return null;
  return catalog.byId.get(id) ?? null;
}
const listedOf = (p: AvatarProfile, stats: ModelStats | null): AvatarProfile => (stats ? { ...p, modelStats: stats } : p);

async function readEntryAsync(id: string): Promise<Entry | null> {
  try {
    const builtin = ships(id) && await isFileAsync(path.join(builtinDir(id), 'profile.json'));
    const override = await readProfileFileAsync(path.join(userDir(id), 'profile.json'));
    const base = await readProfileFileAsync(path.join(builtinDir(id), 'profile.json'));
    const shipped = builtin;
    const p = composeProfile(id, override, base, builtin, shipped);
    if (!p) return null;
    const f = await resolveAvatarFileAsync(id, p.modelFile);
    const stats = f ? await fileStatsAsync(f) : null;
    return { id, p, base, builtin, shipped, stats, listed: listedOf(p, stats) };
  } catch { return null; }
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

function relist() {
  const es = [...catalog.byId.values()];
  const rank = (id: string) => catalog.rank.get(id) ?? Number.MAX_SAFE_INTEGER;
  const b = es.filter((e) => e.builtin).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const u = es.filter((e) => !e.builtin).sort((x, y) => (y.p.createdAt ?? '').localeCompare(x.p.createdAt ?? '') || rank(x.id) - rank(y.id));
  catalog.list = [...b, ...u].map((e) => e.listed);
  catalog.json = null;
}

async function refreshOnce(all: boolean, want: Set<string>, startSeq: number) {
  const fresh = (id: string) => all || want.has(id) || !catalog.byId.has(id);
  const read = new Map<string, Entry | null>();
  const readIds = async (ids: string[]) => {
    const todo = ids.filter(fresh);
    const got = await mapLimit(todo, 4, readEntryAsync);
    todo.forEach((id, i) => read.set(id, got[i]));
  };
  const builtinDirs = await listDirsAsync(BUILTIN_DIR);
  const isB = await mapLimit(builtinDirs, 4, (id) => isFileAsync(path.join(builtinDir(id), 'profile.json')));
  const builtins = builtinDirs.filter((id, i) => isB[i] && ships(id)).sort();
  // the user's own avatars left in the program folder (not shipped): listed with the user's avatars
  const strays = builtinDirs.filter((id, i) => isB[i] && !ships(id));
  const seen = new Set(builtins);
  const users = [...new Set([...(await listDirsAsync(LIBRARY_DIR)), ...strays])].filter((id) => !seen.has(id));
  await readIds([...builtins, ...users]);
  const entryOf = (id: string) => (read.has(id) ? read.get(id)! : catalog.byId.get(id) ?? null);
  void sayUnlisted(users.filter((id) => !entryOf(id)));
  // apply in one go (nothing awaits from here on)
  const order = [...builtins, ...users];
  const next = new Map<string, Entry>();
  for (const id of order) {
    const own = (catalog.ownSeq.get(id) ?? 0) > startSeq;            // changed by this module while we were reading: keep that
    const e = own ? catalog.byId.get(id) ?? null : entryOf(id);
    if (e) next.set(id, e);
  }
  for (const [id, e] of catalog.byId) if (!next.has(id) && (catalog.ownSeq.get(id) ?? 0) > startSeq) next.set(id, e);   // created meanwhile
  catalog.byId = next;
  catalog.rank = new Map(order.map((id, i) => [id, i]));
  // an avatar changed on disk by someone else stays "read it from disk" until a pass that started after its last change
  // (theirs or ours) has re-read it: a save of ours during this pass was not part of what this pass read
  for (const id of [...catalog.dirty]) if ((catalog.evSeq.get(id) ?? 0) <= startSeq && (catalog.ownSeq.get(id) ?? 0) <= startSeq) catalog.dirty.delete(id);
  for (const [id, s] of catalog.ownSeq) if (s <= startSeq) catalog.ownSeq.delete(id);
  for (const [id, s] of catalog.evSeq) if (s <= startSeq) catalog.evSeq.delete(id);
  relist();
  catalog.ready = true;
  catalog.applied = Math.max(catalog.applied, startSeq);
  catalog.refreshes++;
}

function refreshCatalog(): Promise<void> {
  if (catalog.running) return catalog.running;
  catalog.running = (async () => {
    try {
      do {
        const all = catalog.all || !catalog.ready;
        catalog.all = false;
        const want = new Set(catalog.queued);
        catalog.queued.clear();
        const startSeq = catalog.seq;
        try { await refreshOnce(all, want, startSeq); } catch (e) { console.warn('[library] avatar list refresh failed:', (e as Error).message); catalog.ready = true; }
      } while (catalog.all || catalog.queued.size);
    } finally { catalog.running = null; }
  })();
  return catalog.running;
}

/** Debounced background refresh: a burst of file events = one refresh, at the latest 2 s after the first event. */
function scheduleRefresh(delay = 250) {
  const now = Date.now();
  if (!catalog.firstEventAt) catalog.firstEventAt = now;
  if (catalog.timer) clearTimeout(catalog.timer);
  catalog.timer = setTimeout(() => { catalog.timer = null; catalog.firstEventAt = 0; void refreshCatalog(); }, Math.min(delay, Math.max(0, catalog.firstEventAt + 2000 - now)));
  catalog.timer.unref?.();
}
function queueAvatarRefresh(id: string) { catalog.queued.add(id); scheduleRefresh(); }
/** Something changed avatars on disk without this module (no ids = maybe all of them): they are re-read soon (the next
 *  GET /api/avatars waits for that), and getProfile reads them from disk until then. */
export function invalidateAvatars(ids?: string[]) {
  if (!catalog.started) return;
  if (!ids) catalog.all = true;
  else for (const id of ids) { catalog.dirty.add(id); catalog.evSeq.set(id, catalog.seq + 1); catalog.queued.add(id); }
  catalog.lastEvent = ++catalog.seq;
  scheduleRefresh();
}
/** Bring the list up to the outside changes seen so far (GET /api/avatars): an async refresh, never a sync scan. The
 *  60 s safety refresh and this module's own writes (already in the list) are not waited for. */
async function avatarsCaughtUp() {
  await new Promise<void>((r) => setImmediate(r));       // a file event read in the same poll as this request runs first
  const want = catalog.lastEvent;
  for (let i = 0; i < 3 && catalog.applied < want; i++) {
    if (catalog.timer) { clearTimeout(catalog.timer); catalog.timer = null; catalog.firstEventAt = 0; }
    await refreshCatalog();
  }
}

/** A save / create / removal of ours before the first build is done: that build may already have read the avatar, and
 *  our own file event is then dropped as ours, so the old profile stayed listed (and was the merge base of the next save:
 *  a save 15-60 ms after a helper restart was lost for good). The avatar is re-read once the build is done (GET
 *  /api/avatars waits for that), and getProfile reads the disk (our pending text) until then. Before the catalog starts,
 *  its first build simply reads the disk. */
function ownChangeBeforeReady(id: string): boolean {
  if (catalog.ready) return false;
  invalidateAvatars([id]);
  return true;
}
function noteOwnProfile(id: string, override: AvatarProfile) {
  if (ownChangeBeforeReady(id)) return;
  catalog.ownSeq.set(id, ++catalog.seq);
  const old = catalog.byId.get(id);
  const p = old ? composeProfile(id, structuredClone(override), old.base, old.builtin, old.shipped) : null;
  if (!old || !p) { queueAvatarRefresh(id); return; }                           // not known here yet: read it in the background
  const sameModel = p.modelFile === old.p.modelFile;
  const stats = sameModel ? old.stats : null;
  // the cached entry always gets this save (a refresh running now keeps it: refreshOnce). When someone else changed the
  // avatar too (dirty), getProfile keeps reading the disk (this save's pending text included) until it is re-read
  catalog.byId.set(id, { ...old, p, stats, listed: listedOf(p, stats) });
  if (!sameModel || catalog.dirty.has(id)) queueAvatarRefresh(id);              // the new model's polycount / a fresh read
  relist();
}
function noteOwnCreated(id: string, profile: AvatarProfile, stats: ModelStats | null) {
  if (ownChangeBeforeReady(id)) return;
  const p = composeProfile(id, structuredClone(profile), null, false);
  if (!p) return;
  catalog.ownSeq.set(id, ++catalog.seq);
  catalog.byId.set(id, { id, p, base: null, builtin: false, shipped: false, stats, listed: listedOf(p, stats) });
  relist();
}
function noteOwnRemoved(id: string) {
  if (ownChangeBeforeReady(id)) return;
  catalog.ownSeq.set(id, ++catalog.seq);
  catalog.byId.delete(id);
  relist();
  queueAvatarRefresh(id);                                                        // a shipped avatar of the same id may be listed again
}

function onTreeEvent(root: string, rel: string | null) {
  if (rel === null) { invalidateAvatars(); return; }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const id = parts[0];
  if (!id || id.startsWith('.') || !ID_RE.test(id)) return;                     // .trash, files at the top
  if (trashing.has(id)) return;                                                 // trashAvatar lists it (or re-reads it if that fails)
  if (parts.length > 2) return;                                                 // costumes/, party versions ...: not listed
  if (parts.length === 2) {
    const f = parts[1].toLowerCase();
    if (f !== 'profile.json' && !/\.(glb|vrm|gltf)$/.test(f)) return;          // thumbnails, snapshots, temp files
    const full = path.join(root, id, parts[1]);
    // a profile.json this process writes: ours only if it holds what we wrote (an outside edit right after our save
    // is not swallowed by the 2 s window)
    if (f === 'profile.json' && ownTexts.has(full)) { void isOwnContent(full).then((own) => { if (!own) invalidateAvatars([id]); }); return; }
    if (isOwnWrite(full)) return;
  } else if (isOwnWrite(path.join(root, id, 'profile.json'))) return;           // the folder itself, touched by our own save
  invalidateAvatars([id]);
}
/** The folders to watch: this helper's library/ (made when missing: a first run starts the catalog before index.ts
 *  makes it) and assets/builtin/. */
function avatarRoots(): string[] {
  return [...new Set([LIBRARY_DIR, BUILTIN_DIR].map((d) => path.resolve(d)))];
}
/** Watch every avatar folder that is not watched yet. One at a time. */
function armAvatarWatchers(): Promise<void> {
  catalog.arming = catalog.arming.then(async () => {
    const roots = avatarRoots();
    for (const [r, w] of catalog.watchers) if (!roots.includes(r)) { w.close(); catalog.watchers.delete(r); }
    for (const r of roots) {
      if (catalog.watchers.has(r)) continue;
      if (r === path.resolve(LIBRARY_DIR)) await fsp.mkdir(r, { recursive: true }).catch(() => {});
      const me: { w: CatalogWatch | null } = { w: null };
      try {
        me.w = await watchCatalogFolder(r, (n) => !n.startsWith('.') && ID_RE.test(n), (rel) => onTreeEvent(r, rel), () => {
          if (me.w && catalog.watchers.get(r) === me.w) catalog.watchers.delete(r);   // the 60 s tick watches it again
          invalidateAvatars();
        });
        catalog.watchers.set(r, me.w);
      } catch { /* no such folder (yet): the 60 s tick tries again */ }
    }
  }).catch(() => { /* never breaks the chain */ });
  return catalog.arming;
}

/** Start the catalog (idempotent): file watchers, first build, the 60 s safety refresh. */
export function startAvatarCatalog(): Promise<void> {
  if (catalog.started) return catalog.first ?? Promise.resolve();
  catalog.started = true;
  let reindexAgain = true;
  const t = setInterval(() => {
    void armAvatarWatchers();                                                   // a folder that was missing / whose watcher broke
    catalog.all = true;
    // (folders that were too fresh to touch at start: once more, then the refresh below lists what that fixed)
    if (reindexAgain) { reindexAgain = false; void reindexLibrary().then((r) => { if (r.fixed.length || r.renamed.length) invalidateAvatars(); }).catch(() => {}); }
    void refreshCatalog();
  }, 60_000);
  t.unref?.();
  // (re-index first, before the watchers: its own writes are not file events to react to)
  catalog.first = reindexLibrary().catch((e) => { console.warn('[library] re-index failed:', (e as Error).message); }).then(() => armAvatarWatchers()).then(() => refreshCatalog());
  return catalog.first;
}

/** GET /api/avatars: the listed avatars, their JSON and an ETag. Never older than the outside changes seen before the
 *  call (it waits for that refresh, off the event loop). */
export async function avatarCatalog(): Promise<{ list: readonly AvatarProfile[]; json: string; body: Buffer; etag: string }> {
  if (!catalog.ready) await startAvatarCatalog();
  await avatarsCaughtUp();
  if (catalog.json === null) {
    catalog.json = JSON.stringify(catalog.list);
    catalog.body = Buffer.from(catalog.json, 'utf8');
    catalog.etag = `W/"${catalog.body.length.toString(16)}-${crypto.createHash('sha1').update(catalog.json).digest('base64').slice(0, 27)}"`;
  }
  return { list: catalog.list, json: catalog.json, body: catalog.body, etag: catalog.etag };
}
/** Does an If-None-Match header name this ETag? (a repeat poll of an unchanged list gets a 304, no body) */
export function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  if (!ifNoneMatch || !etag) return false;
  const want = etag.replace(/^W\//, '');
  return String(ifNoneMatch).split(',').some((t) => { const x = t.trim(); return x === '*' || x.replace(/^W\//, '') === want; });
}
/** The listed avatars, READ-ONLY (shared with every caller; listAvatars() returns a copy you may change). */
export function avatarList(): readonly AvatarProfile[] {
  return catalog.ready ? catalog.list : scanAvatarsSync();
}
/** One listed avatar (with modelStats), READ-ONLY, or null. O(1) once the catalog is up (the VTube Studio API asks
 *  for the current model on every plugin request). */
export function listedAvatar(id: string): Readonly<AvatarProfile> | null {
  if (!ID_RE.test(id) || id.includes('..')) return null;
  const e = cachedEntry(id);
  return e ? e.listed : getProfile(id);
}
/** (tests, benchmarks) */
export function avatarCatalogInfo() {
  return { ready: catalog.ready, refreshes: catalog.refreshes, size: catalog.byId.size, dirty: catalog.dirty.size, watchers: catalog.watchers.size, watched: [...catalog.watchers.keys()], running: !!catalog.running };
}
/** (tests) Run the queued refreshes now and wait for them. */
export async function settleAvatarCatalog() {
  await catalog.arming;
  for (let i = 0; i < 50 && (catalog.timer || catalog.running); i++) {
    if (catalog.timer) { clearTimeout(catalog.timer); catalog.timer = null; catalog.firstEventAt = 0; void refreshCatalog(); }
    await catalog.running;
  }
}
