// Throw & Bonk, helper side (beta.16, docs/b16/THROW.md, docs/b16/LANES.md "throw"). Three jobs, all local to this PC:
//
//   GET    /api/throwables                 the starter props + the host's own pictures (no picture data)
//   GET    /api/throwables/starter/:file   a starter prop (assets/library/throwables/*.svg, drawn for this app, CC0)
//   POST   /api/throwables/upload?name=    the host's OWN picture (PNG / GIF / WebP, ≤ 1 MB, ≤ 2048 px), kept in <data>/throwables
//   GET    /api/throwables/file/:id        … served back to the host's own pages
//   DELETE /api/throwables/file/:id
//
// Custody: these files are the host's own choice, on the host's PC. Nothing arrives from chat or from a party guest, so nobody
// else's picture is ever written here (thrown emotes are the platforms' own pictures, loaded by pages through /api/chat/img and
// never stored by this lane). Files are checked by their first bytes, never their name, and served as data (nosniff, sandboxed
// when opened as a page: routes/util.ts userFileHeaders).
import express, { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../paths.ts';
import { HttpError } from '../library.ts';
import type { B16ServerCtx } from '../b16/mount.ts';
import { requireLocal, sendAbsolute, userFileHeaders } from './util.ts';
import { THROW_LIMITS, THROW_PROPS, THROW_PROP_BY_ID, cleanName, sanitizeUserThrowables, sniffThrowImage, type UserThrowable } from '../../shared/throwables.ts';

export const throwableRoutes = Router();

const STARTER_DIR = path.join(ROOT, 'assets', 'library', 'throwables');
const MAX_SIDE = 2048;
const EXT: Record<UserThrowable['type'], string> = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
/** Where the host's pictures live (VTP_DATA_HOME moves it, like every other folder the helper writes). */
const dir = () => path.join(DATA_DIR, 'throwables');
const indexFile = () => path.join(dir(), 'index.json');
const fileOf = (u: UserThrowable) => path.join(dir(), `${u.id}.${EXT[u.type]}`);

function readIndex(): UserThrowable[] {
  try { return sanitizeUserThrowables(JSON.parse(fs.readFileSync(indexFile(), 'utf8'))); } catch { return []; }
}
function writeIndex(list: UserThrowable[]) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(indexFile() + '.tmp', JSON.stringify(list));
  fs.renameSync(indexFile() + '.tmp', indexFile());
}

/** Width and height from the file's own header (PNG IHDR, GIF screen descriptor, WebP VP8 / VP8L / VP8X), or null when it cannot be read. */
export function imageSize(b: Uint8Array, type: UserThrowable['type']): { w: number; h: number } | null {
  if (type === 'image/png') return b.length >= 24 ? { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 } : null;
  if (type === 'image/gif') return b.length >= 10 ? { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) } : null;
  if (b.length < 30) return null;
  const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (tag === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (tag === 'VP8L') { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) }; }
  if (tag === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
  return null;
}

const view = () => ({
  props: THROW_PROPS.map((p) => ({ id: p.id, label: p.label, ...(p.hand ? { hand: p.hand } : {}) })),
  mine: readIndex().map((u) => ({ id: u.id, name: u.name })),
  max: THROW_LIMITS.maxUserImages,
});

throwableRoutes.get('/api/throwables', (_req, res) => { res.json(view()); });

throwableRoutes.get('/api/throwables/starter/:file', (req, res) => {
  const f = String(req.params.file);
  const p = THROW_PROPS.find((x) => x.file === f);
  if (!p || !THROW_PROP_BY_ID.has(p.id)) throw new HttpError(404, 'No such prop');
  const full = path.join(STARTER_DIR, p.file);
  if (!fs.existsSync(full)) throw new HttpError(404, 'That prop is not installed');
  sendAbsolute(res, full, { headers: { 'Content-Type': 'image/svg+xml', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'public, max-age=3600' } }, STARTER_DIR);
});

throwableRoutes.post('/api/throwables/upload', express.raw({ type: () => true, limit: THROW_LIMITS.maxImageBytes + 1024 }), (req, res) => {
  requireLocal(req);
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'The file was empty');
  if (buf.length > THROW_LIMITS.maxImageBytes) throw new HttpError(413, 'That picture is bigger than 1 MB: use a smaller one');
  const type = sniffThrowImage(buf);
  if (!type) throw new HttpError(415, 'That file is not a picture I can throw (use PNG, GIF or WebP)');
  const size = imageSize(buf, type);
  if (!size || size.w < 1 || size.h < 1) throw new HttpError(415, 'I could not read that picture');
  if (size.w > MAX_SIDE || size.h > MAX_SIDE) throw new HttpError(413, `That picture is ${size.w} x ${size.h}: use one up to ${MAX_SIDE} x ${MAX_SIDE}`);
  const list = readIndex();
  const id = 'u-' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  if (!list.some((u) => u.id === id)) {
    if (list.length >= THROW_LIMITS.maxUserImages) throw new HttpError(409, `You have ${THROW_LIMITS.maxUserImages} pictures: remove one first`);
    const u: UserThrowable = { id, name: cleanName(req.query.name), type, bytes: buf.length };
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileOf(u), buf);
    writeIndex([...list, u]);
  }
  res.json({ ...view(), added: id });
});

throwableRoutes.get('/api/throwables/file/:id', (req, res) => {
  const u = readIndex().find((x) => x.id === String(req.params.id));
  if (!u || !fs.existsSync(fileOf(u))) throw new HttpError(404, 'No such picture');
  sendAbsolute(res, fileOf(u), { headers: { 'Content-Type': u.type, 'Cache-Control': 'private, max-age=3600', ...userFileHeaders(req.headers['sec-fetch-dest']) } }, dir());
});

throwableRoutes.delete('/api/throwables/file/:id', (req, res) => {
  requireLocal(req);
  const id = String(req.params.id);
  const list = readIndex(), u = list.find((x) => x.id === id);
  if (!u) throw new HttpError(404, 'No such picture');
  try { fs.rmSync(fileOf(u), { force: true }); } catch { /* gone already */ }
  writeIndex(list.filter((x) => x.id !== id));
  res.json(view());
});

/** The helper's mount point (server/b16/mount.ts). Routes only: no timers, no listeners. */
export function mount(ctx: B16ServerCtx): void {
  ctx.app.use(throwableRoutes);
}
