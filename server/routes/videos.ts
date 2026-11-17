// Screen video library (docs/SCENES.md → "Screen video"): the host's own video files for the room's screen.
//
//   GET  /api/videos                 → { dir, files: [{ name, size, mtime }] }   (mp4 / webm / m4v / mov / ogv in videos/)
//   GET  /api/videos/file/:name      → the file (HTTP Range: OBS pages seek to the host's position)
//   POST /api/videos/upload?name=x   → raw body saved as videos/<name> (localhost only; an existing name gets " (2)")
//   POST /api/videos/open            → opens the folder in Explorer / Finder (localhost only)
//   POST /api/scene/video {action?: 'play'|'stop'|'toggle'|'next'|'restart', slot?, audio?: bool|'toggle', volume?, on?}
//                                    → a bus command to the host studio (Stream Deck), like /api/scene/lighting
// The folder is personal (git-ignored, never shipped). Party guests' pages play a 'lib:' video only when THEIR videos/
// folder has a file of the same name; http(s) sources play everywhere (they need CORS for WebGL).
import { Router } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VIDEO_FILE, isVideoSlot } from '../../shared/screenVideo.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { ROOT, VIDEOS_DATA_DIR } from '../paths.ts';
import { requireLocal, sendAbsolute, sendFrom } from './util.ts';

/** One screen video at most this big (a 4K hour is ~6 GB). */
const VIDEO_MAX_BYTES = 8 * 1024 ** 3;
/** Uploads at once, and the free space an upload must leave on the drive (a page can't fill the disk with many). */
export const VIDEO_UPLOADS_MAX = 2;
export const VIDEO_DISK_RESERVE = 2 * 1024 ** 3;
/** Uploads in progress: what each declared and how much it has written (another upload's room counts what is still to
 *  come from these). Taken before the first await, so parallel requests can't all pass the limit. */
const uploads = new Set<{ declared: number; seen: number }>();
/** While an upload streams, the drive's free space is looked at again every this many bytes (all uploads' writes show). */
let CHECK_EVERY = 64 * 1024 ** 2;
// (NaN when the drive can't say: the upload is then refused, never let through unchecked)
let freeBytes = async (dir: string): Promise<number> => {
  try { const st = await fs.promises.statfs(dir); return Number(st.bavail) * Number(st.bsize); } catch { return NaN; }
};
const stillToCome = (except: object) => { let n = 0; for (const u of uploads) if (u !== except && Number.isFinite(u.declared)) n += Math.max(0, u.declared - u.seen); return n; };
export function configureVideoDisk(o: { free: (dir: string) => Promise<number>; checkEvery?: number }) { freeBytes = o.free; if (o.checkEvery) CHECK_EVERY = o.checkEvery; }
export const VIDEOS_DIR = VIDEOS_DATA_DIR; // writable: the per-user data folder in a release (server/paths.ts)
export const videoRoutes = Router();

videoRoutes.get('/api/videos', (_req, res) => {
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const files = fs.readdirSync(VIDEOS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && VIDEO_FILE.test(e.name))
    .map((e) => { const st = fs.statSync(path.join(VIDEOS_DIR, e.name)); return { name: e.name, size: st.size, mtime: st.mtimeMs }; })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ dir: VIDEOS_DIR, files });
});

videoRoutes.get('/api/videos/file/:name', (req, res) => {
  const name = String(req.params.name ?? '');
  if (!VIDEO_FILE.test(name)) throw new HttpError(400, 'Not a video file name');
  sendFrom(res, VIDEOS_DIR, name);                                    // (express sendFile answers Range requests)
});

videoRoutes.post('/api/videos/upload', async (req, res) => {
  requireLocal(req);
  const raw = path.basename(String(req.query.name ?? '')).replace(/[^\w .()-]/g, '_').slice(-120);
  if (!VIDEO_FILE.test(raw)) throw new HttpError(400, 'name must end in .mp4 / .webm / .m4v / .mov / .ogv');
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const freeName = () => { let n = raw; for (let k = 2; fs.existsSync(path.join(VIDEOS_DIR, n)); k++) n = raw.replace(/(\.\w+)$/, ` (${k})$1`); return n; };
  let name = freeName();
  // (its own .part file: two uploads of the same name at once never share one)
  const tmp = path.join(VIDEOS_DIR, `.${name}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.part`);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > VIDEO_MAX_BYTES) throw new HttpError(413, 'That video is bigger than 8 GB');
  if (uploads.size >= VIDEO_UPLOADS_MAX) throw new HttpError(429, `${VIDEO_UPLOADS_MAX} videos are already uploading: wait for one to finish`);
  const me = { declared: Number.isFinite(declared) ? declared : NaN, seen: 0 };
  uploads.add(me);                                        // (before any await: a parallel request sees this slot taken)
  const tooBig = () => new HttpError(507, 'Not enough free disk space for that video');
  // the drive keeps VIDEO_DISK_RESERVE free, counting what the other uploads still have to write: checked before the
  // upload and again every CHECK_EVERY bytes while it streams (no Content-Length / a chunked body). A drive whose free
  // space can't be read (or a check that fails) counts as full: the reserve fails closed.
  const room = async () => {
    const free = await freeBytes(VIDEOS_DIR).catch(() => NaN);
    return Number.isFinite(free) ? free - VIDEO_DISK_RESERVE - stillToCome(me) : -1;
  };
  try {
    let left = await room();
    if (Number.isFinite(declared) && declared > left) throw tooBig();
    let since = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _e, cb) {
        me.seen += chunk.length; since += chunk.length; left -= chunk.length;
        if (me.seen > VIDEO_MAX_BYTES) { cb(new HttpError(413, 'That video is bigger than 8 GB')); return; }
        if (left < 0) { cb(tooBig()); return; }
        if (since < CHECK_EVERY) { cb(null, chunk); return; }
        since = 0;
        // (what this upload has written so far is already off the free space: only the chunk in hand is still to come)
        room().then((r) => { left = r - chunk.length; cb(left < 0 ? tooBig() : null, chunk); }, () => cb(tooBig()));
      },
    });
    try {
      await pipeline(req, cap, fs.createWriteStream(tmp));
      // the final name is picked and taken in one synchronous step (no other upload in this server runs between them);
      // a file another program dropped in that very moment only moves this one to the next free name
      for (let i = 0; ; i++) {
        name = freeName();
        try { fs.renameSync(tmp, path.join(VIDEOS_DIR, name)); break; }
        catch (e) { if (i >= 3 || !['EEXIST', 'EPERM', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
      }
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  } finally { uploads.delete(me); }
  res.json({ ok: true, name, src: `lib:${name}` });
});

videoRoutes.post('/api/videos/open', (req, res) => {
  requireLocal(req);
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [VIDEOS_DIR], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  res.json({ ok: true, dir: VIDEOS_DIR });
});

videoRoutes.post('/api/scene/video', (req, res) => {
  requireLocal(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  if (typeof b.action === 'string' && /^(play|stop|toggle|next|restart)$/.test(b.action)) args.action = b.action;
  if (isVideoSlot(b.slot)) args.slot = b.slot;
  if (typeof b.audio === 'boolean' || b.audio === 'toggle') args.audio = b.audio;
  if (typeof b.volume === 'number' && Number.isFinite(b.volume)) args.volume = b.volume;
  if (typeof b.on === 'boolean') args.on = b.on;
  if (!Object.keys(args).length) throw new HttpError(400, 'Body: { action: "play" | "stop" | "toggle" | "next" | "restart", slot?: "preshow" | "ambience" | "brb" | "outro", audio?: true | false | "toggle", volume?: 0..1, on?: bool }');
  broadcast({ type: 'command', command: 'scene', args: { video: args } });
  res.json({ ok: true, ...args });
});

// ---- live sources (shared/screenVideo.ts isLiveSrc) ------------------------------------------------------------------
//   GET  /api/videos/hls.js          → node_modules/hls.js/dist/hls.min.js (404 when the package isn't installed)
//   GET  /api/videos/proxy?url=…     → a live stream fetched by this server (CORS-blocked streams can't be a WebGL
//                                      texture otherwise). Same-origin pages only (Sec-Fetch-Site), public http(s) hosts
//                                      only (no loopback / LAN / link-local: not an SSRF hop), media / playlist types
//                                      only; HLS playlists are rewritten so segments + variants stay proxied.
//   POST /api/videos/resolve {url}   → what a pasted link is: a stream VTube Pro can play, or a channel page (Twitch /
//                                      YouTube / Kick) it can't — those need the OBS route (no scraping of their players).
//   POST /api/obs/vcam {start?: true} → OBS virtual camera status; `start: true` starts it (opt-in, Scene tab button).
import { Readable } from 'node:stream';
import { isChannelUrl, isHlsUrl } from '../../shared/screenVideo.ts';
import { ObsClient, obs } from '../obs.ts';
import { BlockedAddressError, blockedHost, proxyFetch, rewritePlaylist } from '../liveProxy.ts';

videoRoutes.get('/api/videos/hls.js', (_req, res) => {
  const f = path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
  if (!fs.existsSync(f)) { res.status(404).type('text/plain').send('hls.js is not installed (npm i hls.js)'); return; }
  res.type('application/javascript'); sendAbsolute(res, f);
});

const MEDIA_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream|mp4|dash\+xml)|binary\/octet-stream)/i;

videoRoutes.get('/api/videos/proxy', async (req, res) => {
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Same-origin pages only');
  let u: URL;
  try { u = new URL(String(req.query.url ?? '')); } catch { throw new HttpError(400, 'url must be an http(s) link'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'url must be an http(s) link');
  if (blockedHost(u.hostname)) throw new HttpError(403, 'The proxy only fetches public internet hosts');
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());
  const headers: Record<string, string> = { 'user-agent': 'VTubePro/1.0' };
  if (req.headers.range) headers.range = String(req.headers.range);
  // Names are resolved and every address checked at connect time, on each redirect hop too (a public DNS name that
  // points at 127.0.0.1 / the LAN is refused; the socket connects only to the checked address, so no DNS rebinding).
  const { res: r, url: fin } = await proxyFetch(u, { headers, signal: ctl.signal }).catch((e: Error) => {
    if (e instanceof BlockedAddressError) throw new HttpError(403, 'The proxy only fetches public internet hosts');
    throw new HttpError(502, `Can't reach the stream: ${e.message}`);
  });
  const type = r.headers.get('content-type') ?? '';
  const isPl = isHlsUrl(fin.pathname) || /mpegurl/i.test(type);
  if (!r.ok && r.status !== 206) { res.status(r.status).end(); return; }
  if (!isPl && type && !MEDIA_TYPE.test(type) && !/\.(ts|m4s|mp4|m4a|aac|webm|m4v|key)$/i.test(fin.pathname)) throw new HttpError(415, `Not a video stream (${type})`);
  res.setHeader('cache-control', 'no-store');
  if (isPl) {
    const body = await r.text();
    res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(body, fin.toString(), (x) => `/api/videos/proxy?url=${encodeURIComponent(x)}`));
    return;
  }
  res.status(r.status);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) res.setHeader(k, v); }
  // a segment that came by its name (.ts / .mp4 ...) with some other type is relayed as plain bytes, never as a page
  // of this PC's own origin
  if (!MEDIA_TYPE.test(type)) res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('x-content-type-options', 'nosniff');
  if (!r.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream), res).catch(() => {});
});

videoRoutes.post('/api/videos/resolve', (req, res) => {
  requireLocal(req);
  const url = String((req.body ?? {}).url ?? '').trim().replace(/^live:/, '');
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'Paste an http(s) link');
  if (isChannelUrl(url)) {
    res.json({ ok: false, kind: 'channel', why: 'Twitch / YouTube / Kick channel pages don’t hand out a stream link VTube Pro may use (their players need their own sign-in tokens and terms). '
      + 'Use the OBS route instead: put the stream in an OBS scene (Browser source or your usual BRB scene), then add “OBS Virtual Camera” or the window feed as the source.' });
    return;
  }
  res.json({ ok: true, kind: isHlsUrl(url) ? 'hls' : 'direct', src: `live:${url}` });
});

videoRoutes.post('/api/obs/vcam', async (req, res) => {
  requireLocal(req);
  const cfg = obs.cfg;
  if (!cfg.enabled) { res.json({ ok: false, error: 'OBS automation is off (Scene tab → OBS automation).' }); return; }
  const c = new ObsClient();
  try {
    await c.connect(cfg.url, cfg.password, 4000);
    let st = await c.request<{ outputActive: boolean }>('GetVirtualCamStatus');
    if ((req.body ?? {}).start === true && !st.outputActive) { await c.request('StartVirtualCam'); st = { outputActive: true }; }
    res.json({ ok: true, active: !!st.outputActive });
  } catch (e) { res.json({ ok: false, error: (e as Error).message }); }
  finally { c.close(); }
});
