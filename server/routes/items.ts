// Stickers & items on the avatar, helper side (beta.16 items lane, docs/b16/ITEMS.md).
//
// What lives here, and only this:
//   * the ten starter stickers that ship with the app (assets/library/stickers/, read-only, CC0)
//   * the HOST's own item library: a picture or model the host chose to keep (<data>/items/mine/), saved only when they press
//     "Keep in my library" for something they dropped in. A picture that merely came with a drop or a plugin is never written here.
//   * the saved item scenes (<data>/items/scenes.json): names + library item ids + spots, no picture bytes.
// Other people's avatars, costumes and items never come through this file (docs/MULTIPLAYER_DISCORD.md): a party guest's
// items are RAM-only on the page that shows them.
import express, { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { DATA_DIR, ROOT } from '../paths.ts';
import { HttpError } from '../library.ts';
import {
  ITEM_EXT, ITEM_LIMITS, ITEM_TYPE_OF_EXT, itemFileName, itemKindOf, sanitizeItemScenes, sanitizeStickerIndex, sniffItemMime,
  type ItemKind, type ItemScene, type StickerIndex,
} from '../../shared/avatarItems.ts';
import { requireLocal, sendFrom, wildcardPath } from './util.ts';

export const itemRoutes = Router();

const STARTER_DIR = path.join(ROOT, 'assets', 'library', 'stickers');
const itemsDir = () => path.join(DATA_DIR, 'items');
const mineDir = () => path.join(itemsDir(), 'mine');
const scenesFile = () => path.join(itemsDir(), 'scenes.json');
/** The host's own library: this many files and this many bytes at most (a folder that cannot grow without limit). */
const MINE_MAX_FILES = 200;
const MINE_MAX_BYTES = 120 * 1024 * 1024;
const FILE = /^[a-z0-9][a-z0-9_-]{0,40}\.(png|gif|webp|jpg|glb)$/;

export interface MineFile { lib: string; name: string; kind: ItemKind; bytes: number }

function starter(): StickerIndex {
  try { return sanitizeStickerIndex(JSON.parse(fs.readFileSync(path.join(STARTER_DIR, 'index.json'), 'utf8'))); }
  catch { return { licence: '', stickers: [] }; }
}
async function mine(): Promise<MineFile[]> {
  let names: string[] = [];
  try { names = await fsp.readdir(mineDir()); } catch { return []; }
  const out: MineFile[] = [];
  for (const f of names.filter((n) => FILE.test(n)).sort()) {
    try {
      const st = await fsp.stat(path.join(mineDir(), f));
      if (!st.isFile()) continue;
      out.push({ lib: `mine/${f}`, name: f.replace(/\.[a-z0-9]+$/, '').replace(/-/g, ' '), kind: f.endsWith('.glb') ? 'model' : 'image', bytes: st.size });
    } catch { /* gone while listing */ }
  }
  return out;
}

async function writeAtomic(file: string, data: string | Buffer) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

// the starter stickers + the host's own files
itemRoutes.get('/api/items/library', async (_req, res) => {
  res.json({ starter: starter(), mine: await mine() });
});

// one file by its library id: `stickers/<file>` (shipped) or `mine/<file>` (the host's own)
itemRoutes.get('/api/items/file/*lib', (req, res) => {
  const lib = wildcardPath((req.params as Record<string, unknown>).lib);
  const m = /^(stickers|mine)\/([a-z0-9][a-z0-9_-]{0,40}\.(?:png|gif|webp|jpg|glb))$/.exec(lib);
  if (!m) throw new HttpError(400, 'Bad item name');
  const base = m[1] === 'stickers' ? STARTER_DIR : mineDir();
  const ext = m[2].split('.').pop() ?? '';
  res.setHeader('Content-Type', ITEM_TYPE_OF_EXT[ext] ?? 'application/octet-stream');
  sendFrom(res, base, m[2]);
});

// "Keep in my library": the host's own picture, saved on their click
itemRoutes.post('/api/items/mine', express.raw({ type: () => true, limit: ITEM_LIMITS.maxBytes }), async (req, res) => {
  requireLocal(req);
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send a picture or a small 3D model');
  const mime = sniffItemMime(new Uint8Array(body.subarray(0, 4200)));
  if (!mime) throw new HttpError(415, 'Use a PNG, GIF, WebP or JPEG picture, or a .glb 3D model');
  const have = await mine();
  if (have.length >= MINE_MAX_FILES) throw new HttpError(409, `Your item library is full (${MINE_MAX_FILES} files). Delete some first`);
  if (have.reduce((a, f) => a + f.bytes, 0) + body.length > MINE_MAX_BYTES) throw new HttpError(409, 'Your item library is full. Delete some files first');
  const wanted = itemFileName(String(req.query.name ?? 'item'), ITEM_EXT[mime]);
  let file = wanted;
  const taken = new Set(have.map((f) => f.lib.slice(5)));
  for (let i = 2; taken.has(file) && i < 500; i++) file = wanted.replace(/(\.[a-z0-9]+)$/, `-${i}$1`);
  if (taken.has(file)) throw new HttpError(409, 'Pick another name');
  await writeAtomic(path.join(mineDir(), file), body);
  res.json({ lib: `mine/${file}`, name: file.replace(/\.[a-z0-9]+$/, '').replace(/-/g, ' '), kind: itemKindOf(mime), bytes: body.length });
});

itemRoutes.delete('/api/items/mine/:file', async (req, res) => {
  requireLocal(req);
  const f = String(req.params.file);
  if (!FILE.test(f)) throw new HttpError(400, 'Bad file name');
  await fsp.rm(path.join(mineDir(), f), { force: true });
  res.json({ ok: true });
});

// saved item scenes
itemRoutes.get('/api/items/scenes', async (_req, res) => {
  let scenes: ItemScene[] = [];
  try { scenes = sanitizeItemScenes(JSON.parse(await fsp.readFile(scenesFile(), 'utf8'))); } catch { /* none yet */ }
  res.json({ scenes });
});
itemRoutes.put('/api/items/scenes', async (req, res) => {
  requireLocal(req);
  const scenes = sanitizeItemScenes((req.body as { scenes?: unknown } | undefined)?.scenes);
  await writeAtomic(scenesFile(), JSON.stringify(scenes));
  res.json({ scenes });
});

/** server/b16/mount.ts calls this once at start. */
export function mount(ctx: { app: Express }): void {
  ctx.app.use(itemRoutes);
}
