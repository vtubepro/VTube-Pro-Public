// "Edit rig" in VTube Pro (rules: shared/rig2d/rigEdit.ts): a 2D avatar from the 2D avatar maker, edited and saved back
// over the same library avatar, with one backup of the file it replaced.
//   GET  /api/avatars/:id/rig        { kind: 'maker' | 'converted' | 'other', backup: boolean, adopt: true, locked?, why? }
//                                    (adopt: an edited imported model may be saved over it)
//   PUT  /api/avatars/:id/rig        body = the edited .vtp2 → { profile, backup: true }
//   POST /api/avatars/:id/rig/undo   the backup and the current file swap places → { profile, backup: true }
// Data safety:
//   * the body streams to a dot-named temp file inside the avatar's .backup/ folder (never listed, never served, never
//     in a party bundle); nothing big is buffered twice, and inflating / picture checks run on zlib's thread pool, not
//     on the thread that relays tracking frames;
//   * save and undo run as a small journal (shared/rig2d/rigJournal.ts): stage .next / .prev, commit, rename into
//     place, bump, clear; at every crash point the rig before AND the rig after exist as whole files, and the next save
//     / undo finishes a committed operation (a retried undo is never undone twice); temp leftovers (.tmp-*) go;
//   * the profile change is ONLY flat.opts.rigRev + 1 on the profile as it is at that moment (no copy made before the
//     awaits), and profile saves never lower rigRev (server/library.ts keepRigRev), so a racing save can neither wipe
//     newer settings nor swallow the bump that makes the OBS page reload.
import { Router, type Request } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { IMPORT_LIMITS } from '../shared/rig2d/limits.ts';
import { RIG_BACKUP_DIR, RIG_BUSY, carryRigFields, checkRigSave, rigBackupRel, rigEditStatus, rigMainOf, rigSavedProfile, storedRigKind, type RigStatus } from '../shared/rig2d/rigEdit.ts';
import { publishRig, recoverRig, rigPaths, saveNeeded, saveRotates, type RigFs, type RigPaths, type RigRev } from '../shared/rig2d/rigJournal.ts';
import { rigRevOf } from '../shared/rig2d/rigRev.ts';
import { checkImage } from '../shared/rig2d/live2d/image.ts';
import { RIG2D } from '../shared/rig2d/format.ts';
import type { InflateRaw } from '../shared/rig2d/container.ts';
import type { AvatarProfile } from '../shared/types.ts';
import { HttpError, assertId, avatarDirForWrite, requireProfile, resolveAvatarFile, saveProfileAsync } from './library.ts';

const inflateRawP = promisify(zlib.inflateRaw) as (b: Uint8Array, o: zlib.ZlibOptions) => Promise<Buffer>;
/** Zip entries inflate on zlib's thread pool (the event loop keeps relaying tracking frames meanwhile). */
const inflate: InflateRaw = async (d, size) => { const r = await inflateRawP(d, { maxOutputLength: Math.max(1, size) }); return new Uint8Array(r.buffer, r.byteOffset, r.byteLength); };
const busy = new Set<string>();
const stamp = () => `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------- pictures (the import's check, off the event loop)
const crc = (zlib as unknown as { crc32?: (d: Uint8Array, v?: number) => number }).crc32;
const SIDE = IMPORT_LIMITS.textureSide;
/** shared/rig2d/live2d/image.ts checkPng with the IDAT inflated asynchronously: size from the header (before inflating),
 *  every chunk's CRC, exactly the bytes the header promises, row filters 0..4. */
export async function pngOk(b: Uint8Array): Promise<'ok' | 'damaged' | 'unchecked' | { w: number; h: number }> {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 8 || [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].some((v, i) => b[i] !== v)) return 'damaged';
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0, end = false;
  const idat: Uint8Array[] = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p, false), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (len > 0x7fffffff || p + 12 + len > b.length) return 'damaged';
    if (crc && (crc(b.subarray(p + 4, p + 8 + len)) >>> 0) !== dv.getUint32(p + 8 + len, false)) return 'damaged';
    if (!w && type !== 'IHDR') return 'damaged';
    if (type === 'IHDR') {
      if (len !== 13) return 'damaged';
      w = dv.getUint32(p + 8, false); h = dv.getUint32(p + 12, false); depth = b[p + 16]; ctype = b[p + 17]; interlace = b[p + 20];
      if (!w || !h) return 'damaged';
      if (w > SIDE || h > SIDE) return { w, h };
    } else if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') { end = true; break; }
    p += 12 + len;
  }
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!end || !idat.length || !ch || ![1, 2, 4, 8, 16].includes(depth) || interlace > 1) return 'damaged';
  const bpp = ch * depth;
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let want = 0;
  for (const [x0, y0, dx, dy] of passes) { const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy); if (pw > 0 && ph > 0) want += ph * (1 + Math.ceil(pw * bpp / 8)); }
  const stride = 1 + Math.ceil(w * bpp / 8);
  const r = await inflateCount(idat, want, (c, at) => {
    // row filter bytes (0..4) at the start of every row (plain images), as the import's check
    if (!interlace) for (let q = Math.ceil(at / stride) * stride; q < at + c.length; q += stride) if (c[q - at] > 4) return false;
    return true;
  });
  return r === 'mem' ? 'unchecked' : r === want ? 'ok' : 'damaged';
}
/** Inflate `parts` (one zlib stream) on zlib's thread pool, a chunk at a time, looking at each chunk and keeping none
 *  of them (the memory stays a few chunks whatever the picture's size). The byte count, 'bad' (more than `max` bytes,
 *  a chunk `look` refused, a broken stream) or 'mem' (this computer could not get the memory to check it). */
function inflateCount(parts: Uint8Array[], max: number, look: (chunk: Buffer, at: number) => boolean): Promise<number | 'bad' | 'mem'> {
  return new Promise((resolve) => {
    let n = 0, done = false;
    let inf: zlib.Inflate;
    const finish = (r: number | 'bad' | 'mem') => { if (done) return; done = true; try { inf.destroy(); } catch { /* gone */ } resolve(r); };
    const mem = (e: unknown) => e instanceof RangeError || /memory|ENOMEM|ERR_MEMORY|allocation/i.test(`${(e as { code?: string })?.code ?? ''} ${(e as Error)?.message ?? ''}`);
    try { inf = zlib.createInflate({ chunkSize: 256 << 10 }); } catch (e) { resolve(mem(e) ? 'mem' : 'bad'); return; }
    inf.on('data', (c: Buffer) => { if (done) return; if (n + c.length > max || !look(c, n)) { finish('bad'); return; } n += c.length; });
    inf.on('end', () => finish(n));
    inf.on('error', (e) => finish(mem(e) ? 'mem' : 'bad'));
    // (one part at a time, waiting for the stream to take it: never more than a part queued)
    void (async () => {
      try {
        for (const part of parts) { if (done) return; if (!inf.write(part)) await new Promise((r) => inf.once('drain', r)); }
        if (!done) inf.end();
      } catch (e) { finish(mem(e) ? 'mem' : 'bad'); }
    })();
  });
}

/** Every picture the manifest names must be whole and not too big (shared/rig2d/importers.ts checkRigPictures' rule and
 *  sentences); throws the sentence. */
async function checkPictures(entries: { name: string; data: Uint8Array }[]) {
  const man = entries.find((e) => e.name === RIG2D.manifest);
  if (!man) return;
  const doc = JSON.parse(new TextDecoder().decode(man.data)) as { textures?: { file?: unknown; normal?: unknown; emission?: unknown; rim?: unknown }[] };
  const names = new Set<string>();
  for (const t of doc.textures ?? []) for (const f of [t?.file, t?.normal, t?.emission, t?.rim]) if (typeof f === 'string') names.add(f);
  for (const name of names) {
    const e = entries.find((x) => x.name === name);
    if (!e) continue;
    const isPng = e.data.length >= 8 && e.data[0] === 0x89 && e.data[1] === 0x50;
    const c = isPng ? await pngOk(e.data) : (() => { const r = checkImage(e.data); return 'error' in r ? (r.error === 'too-big' ? { w: r.w, h: r.h } : 'damaged') : 'ok'; })();
    const base = name.split('/').pop()!.slice(0, 80);
    if (c === 'ok') continue;
    if (c === 'unchecked') throw new Error(`The picture ${base} is too large for this computer to check right now. Close some programs and press Save again.`);
    if (c === 'damaged') throw new Error(`The picture ${base} in this ${RIG2D.ext} file is damaged. Save it again in the 2D avatar maker.`);
    throw new Error(`The picture ${base} is ${c.w}×${c.h} pixels; pictures can be at most ${SIDE} pixels on a side.`);
  }
}

// ---------------------------------------------------------------- files (the journal engine: shared/rig2d/rigJournal.ts)
/** Tests only: called before every file change / profile bump the rig routes make (throw to simulate a crash there). */
let fault: ((step: string) => void) | null = null;
export function setRigFault(f: ((step: string) => void) | null) { fault = f; }

/** Rename `from` over `to` (a reader holding `to` open on Windows: a few retries). */
async function renameOver(from: string, to: string) {
  for (let i = 0; ; i++) {
    try { await fsp.rename(from, to); return; }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}
const LOCKED = ['EPERM', 'EBUSY', 'EACCES'];
const MISSING = ['ENOENT', 'ENOTDIR'];
/** Read a file: null ONLY when it does not exist; a lock (another program has it open) is retried like a rename; any
 *  other failure throws (the journal engine must never take an unreadable file for a missing one). */
async function readStrict(file: string): Promise<Uint8Array | null> {
  for (let i = 0; ; i++) {
    try { return new Uint8Array(await fsp.readFile(file)); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (MISSING.includes(code)) return null;
      if (i >= 8 || !LOCKED.includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}
/** Does a file exist: false ONLY when it does not; a lock is retried; anything else throws. */
async function existsStrict(file: string): Promise<boolean> {
  for (let i = 0; ; i++) {
    try { await fsp.stat(file); return true; }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (MISSING.includes(code)) return false;
      if (i >= 8 || !LOCKED.includes(code)) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}
/** What the performer reads when a file of the rig can't be read or written right now (nothing is lost: the next try
 *  finishes or redoes it). */
const BUSY_FILE = 'Your avatar’s rig file couldn’t be read or written just now (another program may have it open). Your avatar is safe: try again in a moment.';
const plainly = (e: unknown): never => { if (e instanceof HttpError) throw e; console.warn('[rig edit]', (e as Error)?.message); throw new HttpError(503, BUSY_FILE); };

/** Remove a file (a reader holding it open on Windows: a few retries). */
async function removeFile(file: string) {
  for (let i = 0; ; i++) {
    try { await fsp.rm(file, { force: true }); return; }
    catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 60 * (i + 1)));
    }
  }
}

/** The avatar's folder as the journal engine sees it: whole-file writes (temp in .backup/ + rename), renames, and the
 *  main file read from wherever it is (a built-in avatar's own folder until its first save). */
async function rigFiles(id: string, main: string): Promise<{ fs: RigFs; P: RigPaths; dir: string; bdir: string }> {
  const dir = await avatarDirForWrite(id);
  const abs = (rel: string) => { const f = path.join(dir, ...rel.split('/')); if (!f.startsWith(dir + path.sep)) throw new HttpError(400, 'Bad rig file name.'); return f; };
  abs(main);
  const bdir = path.join(dir, RIG_BACKUP_DIR);
  await fsp.mkdir(bdir, { recursive: true });
  const P = rigPaths(main, rigBackupRel(main));
  const at = (rel: string) => (rel === main ? resolveAvatarFile(id, main) ?? abs(rel) : abs(rel));
  const rfs: RigFs = {
    read: async (rel) => { fault?.(`read ${rel}`); return readStrict(at(rel)); },
    write: async (rel, data) => {
      fault?.(`write ${rel}`);
      const tmp = path.join(bdir, `.tmp-${stamp()}`);
      try { await fsp.writeFile(tmp, data); await renameOver(tmp, abs(rel)); } finally { await fsp.rm(tmp, { force: true }).catch(() => undefined); }
    },
    move: async (from, to) => { fault?.(`move ${from} ${to}`); await renameOver(abs(from), abs(to)); },
    remove: async (rel) => { fault?.(`remove ${rel}`); await removeFile(abs(rel)); },
    exists: async (rel) => { fault?.(`exists ${rel}`); return existsStrict(at(rel)); },
    // temp files of writes a crash cut off (and an upload that never finished)
    clean: async () => { for (const f of await fsp.readdir(bdir).catch(() => [] as string[])) if (f.startsWith('.tmp-')) await fsp.rm(path.join(bdir, f), { force: true }).catch(() => undefined); },
  };
  return { fs: rfs, P, dir, bdir };
}

/** Stream a request body to `file` (at most `limit` bytes). */
async function receive(req: Request, file: string, limit: number): Promise<void> {
  const out = fs.createWriteStream(file);
  const closed = new Promise<void>((r) => out.once('close', () => r()));
  try {
    await new Promise<void>((resolve, reject) => {
      let n = 0, done = false;
      const stop = (e: Error) => { if (done) return; done = true; req.unpipe(out); out.destroy(); req.destroy(); reject(e); };
      req.on('data', (c: Buffer) => { n += c.length; if (n > limit) stop(new HttpError(413, 'This 2D avatar is too big to save.')); });
      req.on('error', (e) => stop(e));
      req.on('close', () => { if (!req.complete) stop(new HttpError(400, 'The save was cut off before it arrived. Press Save again.')); });
      out.on('error', (e) => stop(e));
      out.on('finish', () => { if (!done) { done = true; resolve(); } });
      req.pipe(out);
    });
  } finally { if (!out.closed) out.destroy(); await closed; }
}

function mainOf(p: AvatarProfile): string {
  const m = rigMainOf(p);
  if ('error' in m) throw new HttpError(400, m.error);
  return m.main;
}
/** The profile's rigRev, and the bump: rigRev + 1 on the profile as it is now (read and saved with no await between:
 *  a newer save is never overwritten). */
const revOf = (id: string): RigRev => ({
  rev: () => rigRevOf(requireProfile(id)),
  bump: async () => { fault?.('bump'); await saveProfileAsync(id, rigSavedProfile(requireProfile(id))); },
});

/** What "Edit rig" can do for this avatar now (shared/rig2d/rigEdit.ts rigEditStatus). */
export async function rigStatus(id: string): Promise<RigStatus> {
  assertId(id);
  const main = mainOf(requireProfile(id));
  const cur = resolveAvatarFile(id, main);
  if (!cur) throw new HttpError(404, 'The rig file of this avatar is missing.');
  const k = await storedRigKind(new Uint8Array(await fsp.readFile(cur)), inflate);
  return rigEditStatus(k, !!resolveAvatarFile(id, rigBackupRel(main)));
}

/** Save an edited rig over the avatar's own (the old one becomes the backup). `body` = the bytes, or a request to stream. */
export async function saveRig(id: string, body: Uint8Array | Request): Promise<{ profile: AvatarProfile; backup: true }> {
  assertId(id);
  if (busy.has(id)) throw new HttpError(409, RIG_BUSY);
  busy.add(id);
  let upload = '';
  try {
    const main = mainOf(requireProfile(id));
    const F = await rigFiles(id, main), rv = revOf(id);
    const rec = await recoverRig(F.fs, F.P, rv).catch(plainly);
    upload = path.join(F.bdir, `.tmp-up-${stamp()}`);
    if (body instanceof Uint8Array) await fsp.writeFile(upload, body); else await receive(body, upload, IMPORT_LIMITS.uploadBytes);
    const bytes = new Uint8Array(await fsp.readFile(upload));
    const cur = await F.fs.read(main).catch(plainly);
    const c = await checkRigSave(bytes, cur, { inflate, pictures: checkPictures });
    if (!c.ok) throw new HttpError(c.status, c.error);
    // what the maker can't keep (motion clips, extra meta, fades …) comes over from the stored rig
    const out = cur ? await carryRigFields(cur, bytes, inflate) : bytes;
    if (!(await saveNeeded(F.fs, F.P, rec, out).catch(plainly))) return { profile: requireProfile(id), backup: true };
    const rotate = await saveRotates(F.fs, F.P, rec, out).catch(plainly);
    const up = upload;
    await publishRig(F.fs, F.P, rv, 'save', out === bytes ? async (nextRel) => { fault?.(`move upload ${nextRel}`); await renameOver(up, path.join(F.dir, ...nextRel.split('/'))); } : out, rotate).catch(plainly);
    upload = '';
    return { profile: requireProfile(id), backup: true };
  } finally {
    if (upload) await fsp.rm(upload, { force: true }).catch(() => undefined);
    busy.delete(id);
  }
}

/** "Undo my last edit": the backup and the current rig swap places (so pressing it again redoes the edit). */
export async function undoRig(id: string): Promise<{ profile: AvatarProfile; backup: true }> {
  assertId(id);
  if (busy.has(id)) throw new HttpError(409, 'This avatar is being saved right now. Wait a moment, then try again.');
  busy.add(id);
  try {
    const main = mainOf(requireProfile(id));
    const F = await rigFiles(id, main), rv = revOf(id);
    // (an undo a crash cut off, finished now: that WAS this undo; never a second swap)
    const rec = await recoverRig(F.fs, F.P, rv).catch(plainly);
    if (rec?.op === 'undo') return { profile: requireProfile(id), backup: true };
    const before = await F.fs.read(F.P.bak).catch(plainly);
    if (!before) throw new HttpError(404, 'There is no earlier version of this rig to go back to.');
    const now = await F.fs.read(main).catch(plainly);
    // (the backup may be the imported model the first save replaced: putting it back only needs a valid rig)
    const c = await checkRigSave(before, now, { inflate, restore: true });
    if (!c.ok) throw new HttpError(c.status, c.error);
    await publishRig(F.fs, F.P, rv, 'undo', before, true).catch(plainly);
    return { profile: requireProfile(id), backup: true };
  } finally { busy.delete(id); }
}

export const rigEditRoutes = Router();
rigEditRoutes.get('/api/avatars/:id/rig', async (req, res) => { res.json(await rigStatus(req.params.id)); });
// (the body is streamed to the avatar's .backup folder, never buffered by a body parser)
rigEditRoutes.put('/api/avatars/:id/rig', async (req, res) => { res.json(await saveRig(req.params.id, req)); });
rigEditRoutes.post('/api/avatars/:id/rig/undo', async (req, res) => { res.json(await undoRig(req.params.id)); });
