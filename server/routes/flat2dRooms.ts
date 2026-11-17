// 2D environments from pictures (shared/flat2dRoom.ts, docs/FLAT_AVATARS.md): POST /api/rooms/import-flat2d
// ?name=<room name>&spots=<1..8>, body = a .zip of layer pictures (named in order: 1_sky.png, 2_hills.png, …, ground.png)
// or one picture → a new room folder in the user's rooms (scene.json + room.gltf + the pictures) → { id, name, layers }.
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { flat2dRoomFiles, planFlat2dLayers } from '../../shared/flat2dRoom.ts';
import { safeRel } from '../../shared/flatAvatar.ts';
import { sniffImage } from '../../shared/flatImport.ts';
import { HttpError } from '../library.ts';
import { readFlatUpload } from '../flatImport.ts';
import { USER_SCENES_DIR } from '../paths.ts';

export const flat2dRoomRoutes = Router();
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32) || 'room';

flat2dRoomRoutes.post('/api/rooms/import-flat2d', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Empty upload body');
  const name = String(req.query.name ?? '').trim().slice(0, 80) || '2D room';
  const spots = Math.max(1, Math.min(8, Math.round(Number(req.query.spots) || 4)));
  const files = readFlatUpload(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), String(req.query.filename ?? 'background.png'));
  // keep pictures only, flattened to safe base names
  const pics = new Map<string, Uint8Array>();
  for (const [p, b] of files) {
    if (/(^|\/)(__MACOSX|\.)/.test(p) || !sniffImage(b.subarray(0, 16))) continue;
    const bn = safeRel((p.split('/').pop() ?? p).replace(/[^A-Za-z0-9_. -]/g, '_'));
    if (bn && !pics.has(bn)) pics.set(bn, b);
  }
  const plan = planFlat2dLayers([...pics.keys()]);
  if ('error' in plan) throw new HttpError(422, plan.error);
  const id = `${slug(name)}_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
  const dir = path.join(USER_SCENES_DIR, id);
  if (fs.existsSync(dir)) throw new HttpError(409, 'Please try again.');
  const { gltf, sceneJson } = flat2dRoomFiles(name, plan, { spots });
  await fsp.mkdir(dir, { recursive: true });
  for (const [bn, b] of pics) await fsp.writeFile(path.join(dir, bn), b);
  await fsp.writeFile(path.join(dir, 'room.gltf'), JSON.stringify(gltf));
  await fsp.writeFile(path.join(dir, 'scene.json'), JSON.stringify({ ...sceneJson, id, importedAt: new Date().toISOString() }, null, 2));
  res.json({ id, name, layers: plan.layers.length, ground: !!plan.ground?.file });
});
