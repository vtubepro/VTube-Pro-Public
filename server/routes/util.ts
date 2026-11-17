// Small helpers shared by the route modules.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { HttpError } from '../library.ts';
import { streamPcOf } from '../streamPcMark.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Reject requests that don't originate from this machine (arbitrary-code endpoints). */
export function requireLocal(req: Request) {
  const addr = req.socket.remoteAddress ?? '';
  if (!LOOPBACK.has(addr)) throw new HttpError(403, 'This endpoint only accepts requests from localhost');
}

/** requireLocal, or a paired stream PC (server/streamPc.ts: only routes on its allow-list ever reach here from it). */
export function requireLocalOrStreamPc(req: Request) { if (!streamPcOf(req)) requireLocal(req); }

/** Express 5 `*name` wildcards arrive as string[]; join into a relative path. */
export function wildcardPath(v: unknown): string {
  return Array.isArray(v) ? v.join('/') : String(v ?? '');
}

type SendOpts = { headers?: Record<string, string> };

/** res.sendFile for a path the caller already checked. Express's `send` ignores (404s) any path with a dot-named part
 *  anywhere in it unless a `root` is given, and Linux installs live under ~/.local/share and ~/.config (feedback#2: every
 *  avatar 404ed there). So the file goes out relative to `base` (default: its own folder): only the parts below `base`
 *  are checked for dot-names, as before. Use this instead of res.sendFile everywhere in server/. */
export function sendAbsolute(res: Response, full: string, opts: SendOpts = {}, base = path.dirname(full)) {
  const root = path.resolve(base);
  const rel = path.relative(root, path.resolve(full));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(400, 'Bad path');
  res.sendFile(rel, { ...opts, root });
}

/** A file someone put in a folder (an avatar, a room or prop pack, an AI's job output) is data, never a page that runs
 *  on the helper's own origin. The browser may not sniff it into another type, and when it is opened as a page (a tab,
 *  a frame, an embed, or a client that doesn't say how: Sec-Fetch-Dest) it opens sandboxed: no script and an opaque
 *  origin, whatever its name or type (.html, .shtml, .svg, .xsl, or a page renamed .png). Loads by the studio (an <img>,
 *  a texture or model fetch, audio, CSS) get nosniff only, so an SVG still paints as an image. */
const SUBRESOURCE = new Set(['image', 'audio', 'video', 'track', 'font', 'style', 'script', 'empty', 'worker', 'sharedworker', 'serviceworker', 'manifest', 'audioworklet', 'paintworklet']);
export const USER_FILE_SANDBOX = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'";
export function userFileHeaders(dest: string | string[] | undefined): Record<string, string> {
  const d = String(dest ?? '').toLowerCase();
  return SUBRESOURCE.has(d) ? { 'X-Content-Type-Options': 'nosniff' } : { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': USER_FILE_SANDBOX };
}

/** Send `rel` from inside `base`, refusing traversal. A user file (userFileHeaders) unless `shipped`: files that ship
 *  with the app and are meant to run as pages (tools/ttrpg/vtt). */
export function sendFrom(res: Response, base: string, rel: string, { shipped = false }: { shipped?: boolean } = {}) {
  const full = path.resolve(base, rel);
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new HttpError(400, 'Bad path');
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Not found');
  sendAbsolute(res, full, { headers: { 'Cache-Control': 'no-cache', ...(shipped ? {} : userFileHeaders(res.req?.headers['sec-fetch-dest'])) } }, base);
}

/** All files below dir, as forward-slash relative paths. */
export function listFilesRecursive(dir: string, prefix = ''): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(listFilesRecursive(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

export const stamp = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
