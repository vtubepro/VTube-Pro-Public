// Wardrobe endpoints: list / import / delete costumes, (re)render costume thumbnails.
import express, { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findBlender } from '../blender.ts';
import { addCostume, checkCostume, isGlb, renderCostumeThumbnail, trashCostume } from '../costumes.ts';
import { HttpError, requireProfile } from '../library.ts';
import { CACHE_DIR, DATA_DIR } from '../paths.ts';
import { stamp } from './util.ts';

export const costumeRoutes = Router();

costumeRoutes.get('/api/avatars/:id/costumes', (req, res) => {
  const p = requireProfile(req.params.id);
  res.json({ costume: p.costume, costumes: p.costumes });
});

/** Raw GLB body. Responds { profile, costume, warnings }; the thumbnail renders in the background. */
costumeRoutes.post('/api/avatars/:id/costumes/import', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
  const id = req.params.id;
  requireProfile(id);
  const filename = String(req.query.filename ?? '').trim();
  if (filename && path.extname(filename).toLowerCase() !== '.glb') throw new HttpError(400, 'Costumes must be .glb files (built with blender/costume_kit.py)');
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Empty upload body');
  if (!isGlb(body)) throw new HttpError(400, 'Not a binary glTF (.glb) file');
  const name = String(req.query.name ?? '').trim() || path.basename(filename || 'Costume', '.glb');
  const tmp = path.join(CACHE_DIR, 'tmp', `costume-${stamp()}.glb`);
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  await fsp.writeFile(tmp, body);
  try {
    const warnings = checkCostume(requireProfile(id), tmp);
    const { profile, costume } = await addCostume(id, tmp, { name, source: 'import', move: true });
    res.json({ profile, costume, warnings });
    if (!costume.thumbnail) renderCostumeThumbnail(id, costume.id).catch(() => {});
  } finally {
    fsp.rm(tmp, { force: true }).catch(() => {});
  }
});

costumeRoutes.delete('/api/avatars/:id/costumes/:costumeId', async (req, res) => {
  const { profile, movedTo } = await trashCostume(req.params.id, req.params.costumeId);
  res.json({ profile, movedTo: path.relative(DATA_DIR, movedTo) });
});

/** (Re)render a costume's wardrobe thumbnail with Blender (background). */
costumeRoutes.post('/api/avatars/:id/costumes/:costumeId/thumbnail', (req, res) => {
  const p = requireProfile(req.params.id);
  if (!p.costumes.some((c) => c.id === req.params.costumeId)) throw new HttpError(404, `No costume '${req.params.costumeId}'`);
  if (!findBlender()) throw new HttpError(503, 'Blender not found. Install Blender or set its path in Setup.');
  renderCostumeThumbnail(p.id, req.params.costumeId).catch(() => {});
  res.json({ started: true });
});
