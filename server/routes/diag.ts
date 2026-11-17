// Diagnostics drop-box: the studio uploads live camera frames, stage renders and tracking state so an AI
// supervisor (via MCP or by reading cache/diag/ on disk) can inspect what's happening. Loopback-only.
import express, { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HttpError, isBuiltin, libraryUrl, requireProfile, userDir } from '../library.ts';
import { CACHE_DIR } from '../paths.ts';
import { requireLocal, sendAbsolute } from './util.ts';

export const DIAG_DIR = path.join(CACHE_DIR, 'diag');
const HISTORY_DIR = path.join(DIAG_DIR, 'history');
const HISTORY_KEEP = 50;
/** History copies: every state.json (tools/live_ok.py reads the newest), every 5th picture, nothing else (motion.bin,
 *  snacks-cap.json, ...: the current file is enough). The studio uploads every 3 s while tracking. */
const IMAGE_HISTORY_EVERY = 5;
const isImage = (name: string) => /\.(png|jpe?g|webp)$/.test(name);
/** An explicit full-resolution stage.png (the 'diag' command / MCP request_diagnostics) is deleted on the first
 *  automatic stage.jpg after it is this old, so nobody reading the folder takes an old picture for the current one. */
const STALE_PNG_MS = 30_000;

export const diagRoutes = Router();

/** Lower-case and restrict to [a-z0-9._-]; must not start with a dot. */
export function diagName(raw: string): string {
  const name = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (!name || name.startsWith('.') || name.length > 100) throw new HttpError(400, 'Invalid diagnostic file name');
  // nothing a browser would run: an uploaded x.html / x.svg served back from 127.0.0.1:5191 would be a page with this
  // PC's own origin (past every web-studio limit). Diagnostics are pictures, clips, JSON and binary dumps.
  if (ACTIVE_EXT.test(name)) throw new HttpError(400, 'That kind of file is not a diagnostic');
  return name;
}
const ACTIVE_EXT = /\.(s?html?|xht(ml)?|mht(ml)?|svgz?|xml|xslt?|xsd|rng|m?js|css|pdf|swf)$/;
/** Served with their own type (shown inline): pictures, clips, text. Anything else is a download. */
const INLINE_EXT = /\.(png|jpe?g|webp|gif|webm|mp4|json|jsonl|txt|log|csv)$/;

// History names, oldest first, kept in memory: one readdir when the first copy is written, never one per upload.
let ring: Promise<string[]> | null = null;
const imageCount = new Map<string, number>();
function historyRing(): Promise<string[]> {
  // names start with a sortable timestamp, so lexical order == chronological order
  return (ring ??= fsp.readdir(HISTORY_DIR).then((f) => f.sort(), () => [] as string[]));
}
async function addHistory(name: string, body: Buffer) {
  const r = await historyRing();
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`;
  await fsp.writeFile(path.join(HISTORY_DIR, file), body);
  r.push(file);
  const old = r.splice(0, Math.max(0, r.length - HISTORY_KEEP));
  await Promise.all(old.map((f) => fsp.rm(path.join(HISTORY_DIR, f), { force: true })));
}
/** Keep a history copy of this upload? state.json always, pictures every 5th per name, anything else never. */
export function wantsHistory(name: string): boolean {
  if (name === 'state.json') return true;
  if (!isImage(name)) return false;
  const n = (imageCount.get(name) ?? 0) + 1;
  imageCount.set(name, n);
  return (n - 1) % IMAGE_HISTORY_EVERY === 0;
}
/** stage.png on disk: written by this server at (ms), or unknown (an older studio / an earlier run left one). */
let pngAt: number | null = null;
async function dropStalePng(now: number) {
  if (pngAt !== null && now - pngAt < STALE_PNG_MS) return;
  pngAt = now; // (checked; the next look is after STALE_PNG_MS)
  await fsp.rm(path.join(DIAG_DIR, 'stage.png'), { force: true }).catch(() => {});
}

const rawBody = express.raw({ type: () => true, limit: '300mb' });

diagRoutes.post('/api/diag/:name', rawBody, async (req, res) => {
  requireLocal(req);
  const name = diagName(req.params.name);
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Empty body');
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
  await fsp.writeFile(path.join(DIAG_DIR, name), body);
  // test clips are big and deliberate — keep them (timestamped) under clips/, not in rolling history
  if (name.startsWith('clip')) {
    const clips = path.join(DIAG_DIR, 'clips');
    await fsp.mkdir(clips, { recursive: true });
    await fsp.writeFile(path.join(clips, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`), body);
    res.json({ ok: true, name, bytes: body.length, url: `/api/diag/${name}` });
    return;
  }
  if (name === 'stage.png') pngAt = Date.now();
  else if (name === 'stage.jpg') await dropStalePng(Date.now());
  if (wantsHistory(name)) await addHistory(name, body);
  res.json({ ok: true, name, bytes: body.length, url: `/api/diag/${name}` });
});

diagRoutes.get('/api/diag', async (req, res) => {
  requireLocal(req);
  const list = async (dir: string) => {
    const ents = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])).filter((d) => d.isFile());
    const rows = await Promise.all(ents.map(async (d) => {
      const st = await fsp.stat(path.join(dir, d.name)).catch(() => null); // (a file can vanish while listing: pruned)
      return st ? { name: d.name, bytes: st.size, mtime: st.mtime.toISOString() } : null;
    }));
    return rows.filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.mtime.localeCompare(a.mtime));
  };
  res.json({ dir: DIAG_DIR, files: await list(DIAG_DIR), history: await list(HISTORY_DIR) });
});

diagRoutes.get('/api/diag/:name', (req, res) => {
  requireLocal(req);
  const full = path.join(DIAG_DIR, diagName(req.params.name));
  if (!fs.existsSync(full)) throw new HttpError(404, `No diagnostic file '${req.params.name}'`);
  const name = path.basename(full);
  const inline = INLINE_EXT.test(name);
  sendAbsolute(res, full, { headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
    ...(inline ? {} : { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` }),
  } }, DIAG_DIR);
});

// POST /api/avatars/:id/snapshot — raw PNG of the live avatar (user avatars: library/<id>/snapshot.png;
// builtins are read-only so theirs goes to cache/diag/snapshot-<id>.png).
diagRoutes.post('/api/avatars/:id/snapshot', rawBody, async (req, res) => {
  const id = req.params.id;
  requireProfile(id);
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body) || !body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw new HttpError(400, 'Body must be a PNG image');
  if (isBuiltin(id)) {
    const name = diagName(`snapshot-${id}.png`);
    await fsp.mkdir(DIAG_DIR, { recursive: true });
    await fsp.writeFile(path.join(DIAG_DIR, name), body);
    return res.json({ url: `/api/diag/${name}` });
  }
  await fsp.writeFile(path.join(userDir(id), 'snapshot.png'), body);
  res.json({ url: libraryUrl(id, 'snapshot.png') });
});
