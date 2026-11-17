// Your own BRB screen (live-tabs, docs/BRB_SCREENS.md): ONE picture or short looping video behind the Be Right Back
// card, kept on this computer (<data>/brb/background.<ext>, never uploaded anywhere). The studio's Privacy tab sends it
// here; every OBS page / preview / the Live monitor loads it from GET /api/brb/background (SceneState.brb.bg says which
// kind and its revision, so pages reload it when it changes). Videos always play MUTED on the pages.
import express, { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { HttpError } from '../library.ts';
import { sniffBrbMedia, BRB_BG_MAX } from '../../shared/brb.ts';
import { sendAbsolute } from './util.ts';

export const brbRoutes = Router();
const DIR = path.join(DATA_DIR, 'brb');
const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const current = (): { file: string; ext: string } | null => {
  for (const ext of Object.keys(TYPES)) { const f = path.join(DIR, `background.${ext}`); if (fs.existsSync(f)) return { file: f, ext }; }
  return null;
};

brbRoutes.post('/api/brb/background', express.raw({ type: () => true, limit: BRB_BG_MAX }), async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send a picture or a short video');
  const m = sniffBrbMedia(body.subarray(0, 64));
  if (!m) throw new HttpError(415, 'Use a PNG, JPG, WebP or GIF picture, or an MP4 / WebM video');
  await fsp.mkdir(DIR, { recursive: true });
  for (const ext of Object.keys(TYPES)) await fsp.rm(path.join(DIR, `background.${ext}`), { force: true });
  await fsp.writeFile(path.join(DIR, `background.${m.ext}`), body);
  res.json({ ok: true, kind: m.kind, ext: m.ext, bytes: body.length, rev: Date.now() });
});
brbRoutes.get('/api/brb/background', (_req, res) => {
  const c = current();
  if (!c) throw new HttpError(404, 'No BRB background yet');
  res.setHeader('Content-Type', TYPES[c.ext]);
  sendAbsolute(res, c.file, { headers: { 'Cache-Control': 'no-cache' } });
});
brbRoutes.delete('/api/brb/background', async (_req, res) => {
  for (const ext of Object.keys(TYPES)) await fsp.rm(path.join(DIR, `background.${ext}`), { force: true });
  res.json({ ok: true });
});
