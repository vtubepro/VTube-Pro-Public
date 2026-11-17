// "Add my room" on the helper (the user's own PC): check a room file, convert FBX / .blend / OBJ (and Draco /
// KTX2 GLBs) with Blender, add places to sit or stand ("Place seats for me"), and install the room into the user's
// own room folder so it shows up in the studio at once ("Your room is ready in VTube Pro"). The same check runs in the
// browser (shared/roomCheck.ts); nothing here ever talks to a website.
// The room-file work itself (the check, the automatic places, packing a .gltf) never runs on this server's event loop,
// which also relays every tracking frame to OBS: it runs in the room-check process (server/roomCheckJob.ts).
//
//   GET  /api/rooms/checklist                       → the machine-readable room checklist (shared/roomCheck.ts)
//   GET  /api/rooms/check/:id                       → check an installed room (+ the suggested fix); for AIs (MCP check_room)
//   POST /api/rooms/check?filename=                 → check an uploaded room file (body = the file)
//   POST /api/rooms/convert?filename=               → any room file → a GLB the browser can open (Blender: room_convert.py)
//   POST /api/rooms/import?filename=&name=&autoSeats=1
//                                                   → convert if needed, add seats if asked (and needed), install as
//                                                     assets/scenes/<slug>_<6 random>/ (scene.glb + scene.json) → {id, name, report}
//   POST /api/rooms/:id/thumbnail                   → thumb.png for a room this route installed (PNG body)
// Docs: docs/ENVIRONMENTS_SIMPLE.md "Add my room", docs/ARTIST_ENVIRONMENTS.md §15.
import { mergeRoomEdits } from '../../shared/roomEdits.ts';
import { isRoomId } from '../../shared/roomId.ts';
import { readEdits } from '../roomEditStore.ts';
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOM_CHECKLIST, type RoomReport } from '../../shared/roomCheck.ts';
import { isGlb } from '../../shared/roomGlb.ts';
import { ROOM_FOLDER, baseRoomId } from '../../shared/roomId.ts';
import { runBlender } from '../blender.ts';
import { HttpError } from '../library.ts';
import { CACHE_DIR, ROOT, USER_SCENES_DIR } from '../paths.ts';
import { runRoomJob, type RoomCheckResult } from '../roomCheckJob.ts';
import { installedRoomDir } from '../roomList.ts';   // (not ./scenes.ts: that one starts the OBS watcher)
import { stamp } from './util.ts';

const SCENES_DIR = USER_SCENES_DIR; // user rooms: the per-user data folder in a release (server/paths.ts)
export const ROOM_DIRECT = ['.glb', '.gltf'];
export const ROOM_CONVERT = ['.fbx', '.blend', '.obj'];   // (.dae: Blender 5 dropped COLLADA import)
const MAX_BYTES = 300 * 1024 * 1024;

export const roomImportRoutes = Router();
const raw = express.raw({ type: () => true, limit: '300mb' });

function upload(req: express.Request): { name: string; ext: string; body: Buffer } {
  const name = String(req.query.filename ?? '').trim().slice(0, 160);
  const ext = path.extname(name).toLowerCase();
  if (!name || !ext) throw new HttpError(400, 'Pass ?filename=<the file name> so we know what kind of file it is.');
  if (![...ROOM_DIRECT, ...ROOM_CONVERT].includes(ext)) throw new HttpError(400, `We can't use ${ext} files for rooms. Use .glb (or .gltf, .fbx, .blend, .obj).`);
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'The file was empty.');
  if (body.length > MAX_BYTES) throw new HttpError(413, 'That room is over 300 MB. Make it lighter (fewer details, smaller textures) and try again.');
  return { name, ext, body };
}

/** A temp file for a GLB the room-check process writes (removed by the caller). */
async function stageFile(tag: string): Promise<string> {
  const dir = path.join(CACHE_DIR, 'tmp');
  await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, `room-${tag}-${stamp()}.glb`);
}

/** A .gltf with everything embedded packed into one binary GLB (server/roomCheckJob.ts packGltf: 422 + plain words for a
 *  .gltf we can't use), in the room-check process: a big .gltf is a big JSON.parse + base64 decode. */
async function packGltf(body: Buffer): Promise<Buffer> {
  const out = await stageFile('pack');
  try {
    await runRoomJob(ROOT, { mode: 'pack', out }, body);
    return await fsp.readFile(out);
  } finally { await fsp.rm(out, { force: true }).catch(() => {}); }
}

/** A GLB the room check can read: as is, packed (an embedded .gltf), or converted by Blender (other formats, Draco / KTX2 compression). */
async function toGlb(name: string, ext: string, body: Buffer): Promise<{ glb: Buffer; converted: boolean }> {
  if (ROOM_DIRECT.includes(ext) && body[0] === 0x7b) body = await packGltf(body);   // then Draco / KTX2 inside it is seen below too
  const needsBlender = ROOM_CONVERT.includes(ext) || (isGlb(body) && /KHR_draco_mesh_compression|KHR_texture_basisu/.test(body.subarray(0, Math.min(body.length, 2_000_000)).toString('latin1')));
  if (!needsBlender) return { glb: body, converted: false };
  const stage = path.join(CACHE_DIR, 'tmp', `room-${stamp()}`);
  await fsp.mkdir(stage, { recursive: true });
  try {
    const input = path.join(stage, `upload${ext === '.gltf' ? '.glb' : ext}`);
    await fsp.writeFile(input, body);
    const output = path.join(stage, 'scene.glb');
    const r = await runBlender('room_convert.py', { input, output }, { timeoutMs: 600_000, lowPriority: true });
    if (!r.ok) {
      if (/Blender not found/i.test(r.error ?? '')) throw new HttpError(422, 'This file needs Blender to open, and Blender isn\'t installed yet. Install it from VTube Pro\'s Tools list, then try again.');
      console.warn(`[rooms] Blender could not convert ${name}: ${(r.error ?? '').slice(0, 300)}`);   // details stay in VTube Pro's own log
      throw new HttpError(422, `Blender couldn't open ${name}. Export it again from your 3D app (as .glb if you can) and try again.`);
    }
    return { glb: await fsp.readFile(output), converted: true };
  } finally { fsp.rm(stage, { recursive: true, force: true }).catch(() => {}); }
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'room';
const newRoomId = (name: string) => `${slug(name)}_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;

function readSceneJson(dir: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8')) as Record<string, unknown>; } catch { return null; }
}
async function readSceneJsonAsync(dir: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fsp.readFile(path.join(dir, 'scene.json'), 'utf8')) as Record<string, unknown>; } catch { return null; }
}

// GET /api/rooms/check/:id answers by room file + size + time + scene.json: an AI that checks every room of list_rooms, or
// the same room again, gets the answer at once while nothing changed (a few kB each; the oldest are dropped).
const CHECKED_MAX = 32;
const checked = new Map<string, RoomCheckResult>();
function rememberCheck(key: string, r: RoomCheckResult) {
  checked.delete(key); checked.set(key, r);
  while (checked.size > CHECKED_MAX) checked.delete(checked.keys().next().value!);
}

roomImportRoutes.get('/api/rooms/checklist', (_req, res) => { res.json({ format: 'vtube-pro.room-checklist/1', items: ROOM_CHECKLIST }); });

roomImportRoutes.get('/api/rooms/check/:id', async (req, res) => {
  const asked = String(req.params.id);
  const id = baseRoomId(asked);   // an area id from list_rooms (<room>~<area>) checks its room
  if (!ROOM_FOLDER.test(id)) throw new HttpError(400, 'Bad room id (use an id from list_rooms).');
  // any installed room: the user's or a shipped one (not in the user's folder in a release)
  const dir = installedRoomDir(id) ?? path.join(SCENES_DIR, id);
  const own = await readSceneJsonAsync(dir);
  if (!own) throw new HttpError(404, `No room "${id}" (use list_rooms for the ids).`);
  // the room as the user sees it: their own Room editor layer merged over scene.json (docs/ROOM_EDITOR.md)
  const sj = mergeRoomEdits(own, isRoomId(asked) ? await readEdits(asked) : null) as Record<string, unknown>;
  const model = typeof sj.model === 'string' && /^[\w./-]{1,120}$/.test(sj.model) && !sj.model.includes('..') ? sj.model : 'scene.glb';
  const file = path.join(dir, model);
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, `Room "${id}" has no ${model} yet.`);
  // a shipped or linked room is up to ~40 MB: 1-2 s of pure CPU, so it runs in the room-check process (the bus keeps going)
  const key = `${file}|${st.size}|${st.mtimeMs}|${crypto.createHash('sha1').update(JSON.stringify(sj)).digest('hex')}`;
  let report = checked.get(key);
  if (!report) { report = await runRoomJob<RoomCheckResult>(ROOT, { mode: 'check', glbPath: file, sceneJson: sj }); rememberCheck(key, report); }
  res.json({ roomId: id, ...report });
});

roomImportRoutes.post('/api/rooms/check', raw, async (req, res) => {
  const { name, ext, body } = upload(req);
  const { glb, converted } = await toGlb(name, ext, body);
  const report = await runRoomJob<RoomCheckResult>(ROOT, { mode: 'check' }, glb);
  res.json({ file: name, converted, ...report });
});

roomImportRoutes.post('/api/rooms/convert', raw, async (req, res) => {
  const { name, ext, body } = upload(req);
  const { glb, converted } = await toGlb(name, ext, body);
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('X-VTP-Converted', converted ? '1' : '0');
  res.send(glb);
});

roomImportRoutes.post('/api/rooms/import', raw, async (req, res) => {
  const { name: file, ext, body } = upload(req);
  const display = String(req.query.name ?? '').trim().slice(0, 80) || path.basename(file, ext).replace(/[_-]+/g, ' ');
  const { glb } = await toGlb(file, ext, body);
  // the check + (autoSeats) the places and cameras for a room with fewer than 2, in the room-check process; a fixed GLB
  // comes back as a temp file
  const fixedFile = await stageFile('import');
  let id: string, report: RoomReport;
  try {
    const r = await runRoomJob<{ fixed: boolean; sceneJson: Record<string, unknown>; report: RoomReport }>(ROOT, { mode: 'import', name: display, autoSeats: req.query.autoSeats === '1', out: fixedFile }, glb);
    if (r.report.seats < 1) throw new HttpError(422, 'We couldn\'t find any places for you to sit or stand in this room, so we didn\'t add it. Use "Let me place them" in the studio to put one in.');
    id = newRoomId(display);
    const dir = path.join(SCENES_DIR, id);
    if (fs.existsSync(dir)) throw new HttpError(409, 'Please try again.');
    // file by file into a NEW folder (never a rename: the live server watches assets/)
    await fsp.mkdir(dir, { recursive: true });
    if (r.fixed) await fsp.copyFile(fixedFile, path.join(dir, 'scene.glb'));
    else await fsp.writeFile(path.join(dir, 'scene.glb'), glb);
    await fsp.writeFile(path.join(dir, 'scene.json'), JSON.stringify({ ...r.sceneJson, name: display, importedAt: new Date().toISOString() }, null, 2));
    report = r.report;
  } finally { await fsp.rm(fixedFile, { force: true }).catch(() => {}); }
  res.json({ id, name: display, report });
});

roomImportRoutes.post('/api/rooms/:id/thumbnail', express.raw({ type: () => true, limit: '10mb' }), async (req, res) => {
  const id = String(req.params.id);
  if (!ROOM_FOLDER.test(id)) throw new HttpError(400, 'Bad room id');
  const dir = path.join(SCENES_DIR, id);
  const sj = readSceneJson(dir);
  if (!sj || sj.importedWith !== 'vtubepro-room-wizard/1') throw new HttpError(403, 'Only rooms added with "Add my room" get a new picture here.');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || body.length > 8_000_000) throw new HttpError(400, 'Body must be a PNG image');
  await fsp.writeFile(path.join(dir, 'thumb.png'), body);
  await fsp.writeFile(path.join(dir, 'scene.json'), JSON.stringify({ ...sj, thumbnail: 'thumb.png' }, null, 2));
  res.json({ ok: true, thumb: `/api/scenes/${id}/file/thumb.png` });
});
