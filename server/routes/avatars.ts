// Avatar CRUD, import, thumbnails and /library static files.
import { IMPORT_LIMITS } from '../../shared/rig2d/limits.ts';
import express, { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AvatarProfile } from '../../shared/types.ts';
import { runBlender } from '../blender.ts';
import {
  HttpError,
  assertId,
  avatarCatalog,
  avatarDirForWrite,
  createAvatar,
  etagMatches,
  reindexForStudio,
  renderThumbnail,
  requireProfile,
  resolveAvatarFile,
  restoreAvatar,
  saveProfileAsync,
  startAvatarCatalog,
  trashAvatar,
} from '../library.ts';
import { CACHE_DIR, DATA_DIR } from '../paths.ts';
import { partyLod } from '../partyLod.ts';
import { avatarFileList, importFlat } from '../flatImport.ts';
import { gpuState, requestGpuTiers } from '../gpuTiers.ts';
import { sendAbsolute, stamp, userFileHeaders, wildcardPath } from './util.ts';

export const avatarRoutes = Router();

const KEEP_AS_IS = ['.glb', '.vrm', '.gltf'];
// (the same list, with notes, is shared/importCheck.ts IMPORT_FORMATS — the studio's import dialog)
const CONVERT = ['.fbx', '.obj', '.stl', '.ply', '.dae', '.blend', '.usd', '.usda', '.usdc', '.usdz', '.abc'];

// The list comes from memory (server/library.ts catalog), as a ready JSON string with an ETag: a repeat poll of an
// unchanged library is a 304.
void startAvatarCatalog();
avatarRoutes.get('/api/avatars', async (req, res) => {
  const c = await avatarCatalog();
  res.setHeader('ETag', c.etag);
  res.setHeader('Cache-Control', 'no-cache');
  if (etagMatches(req.headers['if-none-match'], c.etag)) { res.status(304).end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(c.body);
});

// "Fix it" for a library that lists none of the user's avatars: look at library/ again, then
// list it. {ok, fixed: folders repaired, avatars: the user's own avatars listed now}.
avatarRoutes.post('/api/avatars/reindex', async (_req, res) => {
  res.json({ ok: true, ...(await reindexForStudio()) });
});

avatarRoutes.get('/api/avatars/:id', (req, res) => {
  res.json(requireProfile(req.params.id));
});

// (answers once profile.json is on disk: a failed write, e.g. a full disk, is a 500 the studio shows as "Save failed")
avatarRoutes.put('/api/avatars/:id', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'Expected an AvatarProfile JSON body');
  requireProfile(req.params.id);
  res.json(await saveProfileAsync(req.params.id, req.body as Partial<AvatarProfile>));
});

avatarRoutes.delete('/api/avatars/:id', async (req, res) => {
  const movedTo = await trashAvatar(req.params.id);
  res.json({ ok: true, movedTo: path.relative(DATA_DIR, movedTo) });
});
// The studio's Undo / "Recently deleted" (src/ui/avatarDelete.ts): {from?: the trash copy's folder name, as DELETE
// answered it in movedTo} → {ok, profile}. 404 = not in the trash any more, 409 = the id is taken again.
avatarRoutes.post('/api/avatars/:id/restore', async (req, res) => {
  const from = req.body && typeof req.body === 'object' ? (req.body as { from?: unknown }).from : undefined;
  if (from !== undefined && typeof from !== 'string') throw new HttpError(400, 'from must be a string');
  res.json({ ok: true, profile: await restoreAvatar(req.params.id, from || undefined) });
});

/** A .gltf is only usable if everything is embedded (data: URIs); otherwise ask for .glb/.vrm. */
function assertSelfContainedGltf(file: string) {
  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new HttpError(400, 'Invalid .gltf JSON');
  }
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((b: any) => b.uri && !String(b.uri).startsWith('data:'));
  if (external) {
    throw new HttpError(400, 'This .gltf references external .bin/texture files. Only single-file models are supported — export as .glb (or .vrm) instead.');
  }
}

// Automatic party version (server/partyLod.ts): GET = status only; POST {max?, costume?, force?} = make it when needed.
avatarRoutes.get('/api/avatars/:id/party-lod', async (req, res) => {
  res.json(await partyLod(req.params.id, { max: req.query.max, costume: typeof req.query.costume === 'string' ? req.query.costume : undefined }));
});
avatarRoutes.post('/api/avatars/:id/party-lod', async (req, res) => {
  const b = (req.body && typeof req.body === 'object' ? req.body : {}) as { max?: unknown; costume?: unknown; force?: unknown };
  try {
    res.json(await partyLod(req.params.id, { max: b.max, costume: typeof b.costume === 'string' ? b.costume : undefined, build: true, force: b.force === true }));
  } catch (e) { throw new HttpError(422, `Party version failed: ${(e as Error).message}`); }
});

/** The request body, written to a temp file as it arrives (counted against `limit`), then read back once. An upload
 *  over the limit or cut off (the page closed, the network dropped) stops at once: the request is destroyed, and the
 *  temp file is removed once its stream has closed (Windows can't delete a file still open). */
export async function receiveToFile(req: express.Request, limit: number): Promise<Buffer> {
  const dir = path.join(CACHE_DIR, 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  const out = fs.createWriteStream(file);
  const closed = new Promise<void>((r) => out.once('close', () => r()));
  try {
    await new Promise<void>((resolve, reject) => {
      let n = 0, done = false;
      const stop = (e: Error) => { if (done) return; done = true; req.unpipe(out); out.destroy(); req.destroy(); reject(e); };
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > limit) stop(new HttpError(413, `That is more than the ${limit >> 20} MB a 2D avatar upload can be. Zip just the model folder (the one with the .model3.json) or your pictures, and drop that.`));
      });
      req.on('error', (e) => stop(e));
      req.on('close', () => { if (!req.complete) stop(new HttpError(400, 'The upload was cut off before it arrived. Drop the files again.')); });
      out.on('error', (e) => stop(e));
      out.on('finish', () => { if (!done) { done = true; resolve(); } });
      req.pipe(out);
    });
    return await fsp.readFile(file);
  } finally {
    if (!out.closed) out.destroy();
    await closed;
    await fsp.rm(file, { force: true }).catch(() => undefined);
  }
}
/** 2D avatar imports in flight (each may hold a 1 GB upload on disk and in memory): one at a time. */
let importsInFlight = 0;

// the texture tiers of a rigged 2D model (server/gpuTiers.ts): where they stand / make them (the studio sends its key)
avatarRoutes.get('/api/avatars/:id/gpu', (req, res) => { assertId(req.params.id); res.json(gpuState(req.params.id, typeof req.query.key === 'string' ? req.query.key : undefined)); });
avatarRoutes.post('/api/avatars/:id/gpu', (req, res) => {
  assertId(req.params.id);
  const k = (req.body as { key?: unknown } | undefined)?.key;
  res.json(requestGpuTiers(req.params.id, typeof k === 'string' && /^[0-9a-f]{16}$/.test(k) ? k : undefined));
});

avatarRoutes.post('/api/avatars/import', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const filename = String(req.query.filename ?? '').trim();
  const ext = path.extname(filename).toLowerCase();
  if (!filename || !ext) throw new HttpError(400, 'Pass ?filename=<original file name> so the format is known');
  if (![...KEEP_AS_IS, ...CONVERT].includes(ext)) {
    throw new HttpError(400, `Unsupported format ${ext}. Use .vrm/.glb (or .gltf/.fbx/.obj/.blend/.dae/.stl/.ply/.usd/.usdz/.abc)`);
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Empty upload body');
  const name = String(req.query.name ?? '').trim() || path.basename(filename, ext);

  const stage = path.join(CACHE_DIR, 'tmp', `import-${stamp()}`);
  await fsp.mkdir(stage, { recursive: true });
  try {
    const uploaded = path.join(stage, `upload${ext}`);
    await fsp.writeFile(uploaded, body);
    let modelFrom = uploaded;
    let modelFile = ext === '.vrm' ? 'model.vrm' : ext === '.gltf' ? 'model.gltf' : 'model.glb';
    if (ext === '.gltf') assertSelfContainedGltf(uploaded);
    if (CONVERT.includes(ext)) {
      const out = path.join(stage, 'model.glb');
      const r = await runBlender('convert.py', { input: uploaded, output: out }, { timeoutMs: 600_000 });
      if (!r.ok) throw new HttpError(422, `Conversion to GLB failed: ${r.error}`);
      modelFrom = out;
      modelFile = 'model.glb';
    }
    const profile = await createAvatar({
      name,
      source: 'import',
      modelFrom,
      modelFile,
      move: true,
      extra: ext === '.vrm' ? { rig: { kind: 'vrm' } } : undefined,
    });
    res.json(profile);
    // Thumbnail in the background; the client hears about it via the {type:'profile'} broadcast.
    renderThumbnail(profile.id).catch(() => {});
  } finally {
    fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
});

// 2D avatars (shared/flatAvatar.ts, docs/FLAT_AVATARS.md): a .zip of pictures (or another kind's model folder) or one
// picture → a new library avatar with profile.flat. ?filename=<original name>&name=<avatar name>. Answers
// { profile, warnings }.
// (streamed to a temp file first: a 1 GB delivery is held in memory once, never as chunks + their concatenation)
avatarRoutes.post('/api/avatars/import-flat', async (req, res) => {
  if (importsInFlight >= 1) {
    // (the body is not read: the connection closes after this answer)
    res.set('Connection', 'close');
    throw new HttpError(409, 'Another 2D avatar is being added right now. Wait until it is ready, then drop this one again.');
  }
  importsInFlight++;
  try {
    const body = await receiveToFile(req, IMPORT_LIMITS.uploadBytes);
    if (body.length === 0) throw new HttpError(400, 'The file arrived empty. Drop your pictures, the model folder or its .zip again.');
    const filename = String(req.query.filename ?? '').trim().slice(0, 200);
    const name = (String(req.query.name ?? '').trim() || filename.replace(/\.[^.]+$/, '') || '2D avatar').slice(0, 60);
    // ?roles=<JSON {path: idle|talk|blink|talkBlink}>: what the studio read from how unnamed pictures look
    let roles: Record<string, string> = {};
    try { const r = JSON.parse(String(req.query.roles ?? '{}')); if (r && typeof r === 'object' && !Array.isArray(r)) roles = Object.fromEntries(Object.entries(r as Record<string, unknown>).slice(0, 16).filter((e): e is [string, string] => typeof e[1] === 'string' && e[0].length < 300)); } catch { /* none */ }
    res.json(await importFlat(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), { filename, name, roles }));
  } finally { importsInFlight--; }
});

// The files of an avatar's folder (2D avatar party bundles: src/avatar/flat/pack.ts).
avatarRoutes.get('/api/avatars/:id/files', async (req, res) => {
  requireProfile(req.params.id);
  res.json(await avatarFileList(req.params.id));
});

avatarRoutes.post('/api/avatars/:id/thumbnail', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const id = req.params.id;
  requireProfile(id);
  const body = req.body as Buffer;
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (!Buffer.isBuffer(body) || !body.subarray(0, 4).equals(PNG)) throw new HttpError(400, 'Body must be a PNG image');
  const dir = await avatarDirForWrite(id);                  // (a deleted avatar's folder is never made again: 404)
  await fsp.writeFile(path.join(dir, 'thumb.png'), body);
  res.json(await saveProfileAsync(id, { thumbnail: 'thumb.png' }));
});

// Static model/texture/thumbnail files: user (override) folder first, then builtin folder.
avatarRoutes.get('/library/:id/*file', (req, res) => {
  const id = req.params.id;
  assertId(id);
  const rel = wildcardPath((req.params as Record<string, unknown>).file);
  const full = resolveAvatarFile(id, rel);
  if (!full) throw new HttpError(404, `No file '${rel}' for avatar '${id}'`);
  // sent relative to the avatar folder it came from: dot-named parts below it stay refused, the folders above it (Linux
  // ~/.local/share, ~/.config) do not count (feedback#2)
  const relN = path.normalize(rel).replace(/^([/\\])+/, '');
  const base = full.endsWith(path.sep + relN) ? full.slice(0, full.length - relN.length - 1) : path.dirname(full);
  sendAbsolute(res, full, { headers: { 'Cache-Control': 'no-cache', ...userFileHeaders(req.headers['sec-fetch-dest']) } }, base);
});

