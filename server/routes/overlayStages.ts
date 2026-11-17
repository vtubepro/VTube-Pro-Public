// 2.5D overlays around 2D avatars (shared/overlayStage.ts, docs/OVERLAYS_2D.md):
//   GET    /api/overlays                 → [{ id, name, layers, canvas, builtin, thumb }]  (this PC's + the shipped ones)
//   GET    /api/overlays/:id             → overlay.json (sanitised)
//   GET    /api/overlays/:id/file/*rel   → a layer file
//   GET    /api/overlays/:id/thumb       → its preview picture (thumb.png / thumb.jpg), 404 when it has none
//   POST   /api/overlays/import?name=    → body = a .zip with overlay.json + the layer files (+ thumb.png): the studio
//                                          plans it in the browser (src/avatar/flat/overlayImport.ts) → { id, name, layers }
//   DELETE /api/overlays/:id             → a user overlay goes to overlays/.trash (shipped ones can't be deleted)
// Every path is re-checked; only files the config names are kept, and each must really be a picture / video.
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  OVERLAY_FILE, OVERLAY_ID, OVERLAY_LIMITS, overlayFiles, overlayMediaType, sanitizeOverlay, slugId, type OverlayConfig,
} from '../../shared/overlayStage.ts';
import { sniffImage } from '../../shared/flatImport.ts';
import { listZip } from '../../shared/flatUnzip.ts';
import { HttpError } from '../library.ts';
import { DATA_DIR, ROOT } from '../paths.ts';
import { sendFrom, wildcardPath } from './util.ts';

export const USER_OVERLAYS_DIR = process.env.VTP_OVERLAYS_DIR || path.join(DATA_DIR, 'overlays');
export const SHIPPED_OVERLAYS_DIR = path.join(ROOT, 'assets', 'overlays');

export const overlayStageRoutes = Router();

function overlayDir(id: string): { dir: string; builtin: boolean } | null {
  if (!OVERLAY_ID.test(id)) return null;
  for (const [base, builtin] of [[USER_OVERLAYS_DIR, false], [SHIPPED_OVERLAYS_DIR, true]] as const) {
    const dir = path.join(base, id);
    if (fs.existsSync(path.join(dir, OVERLAY_FILE))) return { dir, builtin };
  }
  return null;
}
async function readConfig(dir: string): Promise<OverlayConfig | null> {
  try { return sanitizeOverlay(JSON.parse(await fsp.readFile(path.join(dir, OVERLAY_FILE), 'utf8'))); } catch { return null; }
}
const thumbOf = (dir: string) => ['thumb.png', 'thumb.jpg', 'thumb.webp'].find((t) => fs.existsSync(path.join(dir, t))) ?? null;

overlayStageRoutes.get('/api/overlays', async (_req, res) => {
  const out: { id: string; name: string; layers: number; canvas: [number, number]; builtin: boolean; thumb: boolean; credits?: string }[] = [];
  for (const [base, builtin] of [[USER_OVERLAYS_DIR, false], [SHIPPED_OVERLAYS_DIR, true]] as const) {
    let names: string[] = [];
    try { names = await fsp.readdir(base); } catch { continue; }
    for (const id of names) {
      if (!OVERLAY_ID.test(id) || out.some((o) => o.id === id)) continue;
      const c = await readConfig(path.join(base, id));
      if (c) out.push({ id, name: c.name, layers: c.layers.length, canvas: c.canvas, builtin, thumb: !!thumbOf(path.join(base, id)), ...(c.credits ? { credits: c.credits } : {}) });
    }
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.json(out);
});

overlayStageRoutes.get('/api/overlays/:id', async (req, res) => {
  const o = overlayDir(String(req.params.id));
  if (!o) throw new HttpError(404, 'That overlay is not on this PC.');
  const c = await readConfig(o.dir);
  if (!c) throw new HttpError(422, 'That overlay’s overlay.json is damaged.');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(c);
});

overlayStageRoutes.get('/api/overlays/:id/thumb', (req, res) => {
  const o = overlayDir(String(req.params.id));
  const t = o && thumbOf(o.dir);
  if (!o || !t) throw new HttpError(404, 'No preview picture');
  sendFrom(res, o.dir, t);
});

overlayStageRoutes.get('/api/overlays/:id/file/*rel', (req, res) => {
  const o = overlayDir(String(req.params.id));
  if (!o) throw new HttpError(404, 'That overlay is not on this PC.');
  const rel = wildcardPath((req.params as Record<string, unknown>).rel);
  if (!overlayMediaType(rel) || rel.split('/').some((p) => !p || p.startsWith('.'))) throw new HttpError(400, 'Bad path');
  sendFrom(res, o.dir, rel);
});

overlayStageRoutes.delete('/api/overlays/:id', async (req, res) => {
  const id = String(req.params.id);
  const o = overlayDir(id);
  if (!o) throw new HttpError(404, 'That overlay is not on this PC.');
  if (o.builtin) throw new HttpError(403, 'Overlays that come with VTube Pro can’t be deleted.');
  const trash = path.join(USER_OVERLAYS_DIR, '.trash');
  await fsp.mkdir(trash, { recursive: true });
  await fsp.rename(o.dir, path.join(trash, `${id}-${Date.now().toString(36)}`));
  res.json({ ok: true });
});

/** A stored or deflated zip (the studio sends stored) → path → bytes, sizes checked from the directory first. */
export function readOverlayZip(b: Uint8Array): Map<string, Uint8Array> {
  let entries;
  try { entries = listZip(b, 400); } catch { throw new HttpError(400, 'The overlay upload is damaged. Try again.'); }
  let total = 0;
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (e.size > OVERLAY_LIMITS.file) throw new HttpError(413, `${e.name} is ${Math.ceil(e.size / 1048576)} MB; one layer file can be at most ${OVERLAY_LIMITS.file >> 20} MB.`);
    total += e.size;
    if (total > OVERLAY_LIMITS.total) throw new HttpError(413, `This overlay is over ${OVERLAY_LIMITS.total >> 20} MB.`);
    const lo = e.local;
    if (lo + 30 > b.length || dv.getUint32(lo, true) !== 0x04034b50) throw new HttpError(400, 'The overlay upload is damaged.');
    const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    if (start + e.csize > b.length) throw new HttpError(400, 'The overlay upload is cut off.');
    const raw = b.subarray(start, start + e.csize);
    let data: Uint8Array;
    if (e.method === 0) data = raw.slice();
    else if (e.method === 8) { data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: e.size + 1 })); if (data.length !== e.size) throw new HttpError(400, 'The overlay upload is damaged.'); }
    else throw new HttpError(422, `${e.name}: unsupported zip compression.`);
    out.set(e.name.replace(/\\/g, '/'), data);
  }
  return out;
}

/** Is this really a picture / video of the type its name says? */
export function mediaOk(rel: string, b: Uint8Array): boolean {
  const t = overlayMediaType(rel);
  if (!t || b.length < 12) return false;
  if (t.startsWith('image/')) return !!sniffImage(b.subarray(0, 16));
  if (t === 'video/webm') return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  // mp4 / mov: an ISO box, usually 'ftyp' at byte 4 (some .mov start with 'moov' / 'wide' / 'mdat')
  const box = String.fromCharCode(b[4], b[5], b[6], b[7]);
  return ['ftyp', 'moov', 'wide', 'mdat', 'free', 'skip'].includes(box);
}

overlayStageRoutes.post('/api/overlays/import', express.raw({ type: () => true, limit: `${(OVERLAY_LIMITS.total >> 20) + 20}mb` }), async (req, res) => {
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Empty upload');
  const files = readOverlayZip(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  // overlay.json at the top, or in the one folder the zip has
  const cfgPath = [...files.keys()].filter((p) => p === OVERLAY_FILE || p.endsWith(`/${OVERLAY_FILE}`)).sort((a, b) => a.length - b.length)[0];
  if (!cfgPath) throw new HttpError(422, `The upload has no ${OVERLAY_FILE}.`);
  const root = cfgPath.slice(0, cfgPath.length - OVERLAY_FILE.length);
  let cfg: OverlayConfig | null;
  try { cfg = sanitizeOverlay(JSON.parse(new TextDecoder().decode(files.get(cfgPath)!))); } catch { cfg = null; }
  if (!cfg) throw new HttpError(422, `${OVERLAY_FILE} is not a VTube Pro overlay.`);
  const name = String(req.query.name ?? '').trim().slice(0, 80);
  if (name) cfg.name = name;
  // keep only layers whose file came with it and is what it says
  const keep = new Map<string, Uint8Array>();
  const bad: string[] = [];
  for (const rel of overlayFiles(cfg)) {
    const b = files.get(root + rel);
    if (b && mediaOk(rel, b)) keep.set(rel, b); else bad.push(rel);
  }
  cfg.layers = cfg.layers.filter((l) => !l.file || keep.has(l.file));
  const clean = sanitizeOverlay(cfg);
  if (!clean) throw new HttpError(422, 'None of the overlay’s layer files could be read.');
  const id = `${slugId(clean.name)}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(USER_OVERLAYS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, b] of keep) {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir) + path.sep)) continue;
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, b);
  }
  for (const t of ['thumb.png', 'thumb.jpg', 'thumb.webp']) {
    const b = files.get(root + t);
    if (b && sniffImage(b.subarray(0, 16)) && b.length < 8 << 20) { await fsp.writeFile(path.join(dir, t), b); break; }
  }
  await fsp.writeFile(path.join(dir, OVERLAY_FILE), JSON.stringify({ ...clean, importedAt: new Date().toISOString() }, null, 2));
  res.json({ id, name: clean.name, layers: clean.layers.length, ...(bad.length ? { missing: bad.slice(0, 10) } : {}) });
});
