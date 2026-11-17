// Fast window feed for the react screen (Windows). Measured 2026-09-25 on the user's PC (1080p60 window, timecode test):
//   studio getDisplayMedia → WebRTC → OBS page ........ 88 ms median / 101 ms p90 (jitter buffer ≈ 35 ms of it)
//   THIS: Windows.Graphics.Capture → x264 zerolatency → localhost WebSocket → WebCodecs ..... 31 ms / 38 ms, 60 fps,
//         ≈ 0.7 of one CPU core (below-normal priority), no extra GPU load.
// The window is the one the performer's OBS capture source already shows (read with obs-websocket, read-only), so
// nothing has to be picked in the browser and it survives studio reloads. ffmpeg (with the gfxcapture filter, FFmpeg
// 8.1+) is an OPTIONAL external program the user installs themselves (winget install ffmpeg); it runs as a separate
// process and is never bundled. Without it, in-scene capture falls back to the studio's WebRTC share.
// ffmpeg is first looked at when something needs it (GET /api/capture, or an OBS page that wants the feed), never at
// helper start; the encoder choice is explained at "ffmpeg discovery" below.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type { CaptureSettings, CaptureStatus, CaptureWindow, FeedConfig, FeedRxStats, FeedStatusMsg } from '../shared/capture.ts';
import { busRequestOk, onUpgrade } from './bus.ts';
import { obs, ObsClient } from './obs.ts';
import { CONFIG_DIR } from './paths.ts';
import { requireLocal } from './routes/util.ts';
import { parseObsWindow, resolveTarget as resolveFrom, type Problem, type Target } from './screenTarget.ts';

export { parseObsWindow };
/** ffmpeg keeps capturing this long after the last OBS page stopped wanting the feed (a Talk → React within a minute
 *  then shows the window at once instead of a cold start: ffmpeg spin-up + the first key frame) — with a GPU encoder
 *  (NVENC). With the CPU encoder (x264) it costs more to keep it warm, so it stops sooner (IDLE_STOP_CPU_MS). Measured
 *  on a 1080p60 moving test pattern (Ryzen 9 9950X3D): BGRA → YUV conversion ≈ 0.4 core + x264 ultrafast ≈ 0.15 core. */
export const IDLE_STOP_MS = 60_000;
export const IDLE_STOP_CPU_MS = 20_000;
/** How long the feed idles before ffmpeg stops (see IDLE_STOP_MS). */
export const idleStopMs = (gpuEncoder: boolean) => (gpuEncoder ? IDLE_STOP_MS : IDLE_STOP_CPU_MS);
/** Pure: the feed state the OBS pages act on. Switched off in the Scene tab = a definite no for them ('unavailable'),
 *  though the Scene tab shows it as a plain setting ('idle', no warning sign). */
export const pageFeedState = (source: CaptureSettings['source'], state: CaptureStatus['state']): CaptureStatus['state'] => (source === 'off' ? 'unavailable' : state);
/** Pure: the feed state for a problem finding what to capture. A setup problem (no OBS password, no capture source, no
 *  window chosen …: server/screenTarget.ts `setup`) is a definite no ('unavailable') — retrying never gets past it, so
 *  Auto shows its exact passthrough / NO SIGNAL at once instead of a 4 s 'connecting…' card on every React switch. A
 *  passing one (OBS closed or slow to answer) stays 'error', which the pages wait out (FEED_ERROR_HOLD_MS). */
export const problemState = (p: Problem): CaptureStatus['state'] => (p.setup ? 'unavailable' : 'error');
/** An OBS page that gets frames but shows none this long = "connected but 0 fps" (said in the status, and the pages
 *  then treat the feed as failed). */
export const NO_PICTURE_MS = 3000;
/** A setup problem older than this is looked at again when a page starts wanting the feed (accept()). */
export const PROBLEM_FRESH_MS = 2000;
/** A page asking for the picture again (resync) is served at most this often. */
export const RESYNC_SERVER_MS = 400;
/** The frames kept since the last key frame (replayed to a joining / resyncing page): at most this much. A key-frame
 *  group is ≤ fps × 2 frames and ≤ KEY_MAX_S long, at ≤ 25 Mbit/s + one 2 MB buffer (ffmpegArgs): ≤ ≈ 33 MB in the
 *  worst case (a very detailed window changing ~12× a second for 10 s), a few MB normally. */
export const GOP_MAX_BYTES = 36e6;
/** A page whose socket has this much queued can't keep up (a hidden / throttled OBS source): it is skipped until it has
 *  caught up, then sent the current picture again from the last key frame (replay) — not left waiting for the next key
 *  frame (up to KEY_MAX_S on a slow window). A replay's own burst (a whole key-frame group) is allowed on top. */
export const STALL_BYTES = 8e6;
/** …caught up again: this little queued. */
export const DRAINED_BYTES = 1e6;

const FILE = path.join(CONFIG_DIR, 'capture.json');
const DEFAULTS: CaptureSettings = { source: 'obs', window: '', ffmpeg: '', maxWidth: 1920, fps: 60 };
const WIN = process.platform === 'win32';

function sanitize(o: Partial<CaptureSettings>, b: CaptureSettings): CaptureSettings {
  const s = (v: unknown, max = 512) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : undefined);
  return {
    source: o.source === 'obs' || o.source === 'window' || o.source === 'off' ? o.source : b.source,
    window: s(o.window) ?? b.window,
    ffmpeg: s(o.ffmpeg, 400) ?? b.ffmpeg,
    maxWidth: n(o.maxWidth, 640, 3840) ?? b.maxWidth,
    fps: n(o.fps, 15, 60) ?? b.fps,
    ...(typeof o.anyGpu === 'boolean' ? { anyGpu: o.anyGpu } : b.anyGpu !== undefined ? { anyGpu: b.anyGpu } : {}),
  };
}
function load(): CaptureSettings { try { return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8')), DEFAULTS); } catch { return { ...DEFAULTS }; } }

// ---------------------------------------------------------------- ffmpeg discovery
// The encoder. NVIDIA NVENC when it passes a 1-frame test (no added delay, no CPU), else x264 on the CPU (≈ 0.7 of a
// core at 1080p60) — as before. AMD AMF and Intel Quick Sync are tested too but only used when the user opts in
// (CaptureSettings.anyGpu) or when this ffmpeg has no x264: measured 2026-10-04 with FFmpeg 8.1, h264_amf hands out each
// picture only when the NEXT one comes in (+1 frame: +17 ms at 60 fps, and a window that stops changing shows its last
// change only at its next change), even with -usage ultralowlatency / -async_depth 1 / -latency 1. It saves ≈ 0.5 of a
// core vs x264. Quick Sync could not be tested here (no Intel GPU), so it is treated the same way until it is.
// Every GPU encoder runs at the same size and bitrate (20 Mbit/s CBR, like NVENC), so the room's screen looks the same.
// Why a GPU encoder was skipped (e.g. an NVIDIA driver too old for this ffmpeg) is kept for the Scene tab:
// CaptureStatus.ffmpeg.gpuNote.
export interface GpuEncoder { codec: 'h264_nvenc' | 'h264_amf' | 'h264_qsv'; vendor: string; label: string; args: string[]; holdsFrame: boolean }
const GPU_ENCODERS: GpuEncoder[] = [
  { codec: 'h264_nvenc', vendor: 'NVIDIA', label: 'NVENC (GPU)', holdsFrame: false,
    args: ['-c:v', 'h264_nvenc', '-preset', 'p2', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-bf', '0', '-rc', 'cbr', '-b:v', '20M', '-maxrate', '20M', '-bufsize', '1M', '-aud', '1', '-bsf:v', 'dump_extra=freq=keyframe'] },
  { codec: 'h264_amf', vendor: 'AMD', label: 'AMF (GPU)', holdsFrame: true,
    args: ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-rc', 'cbr', '-b:v', '20M', '-bf', '0', '-aud', '1', '-bsf:v', 'dump_extra=freq=keyframe'] },
  { codec: 'h264_qsv', vendor: 'Intel', label: 'Quick Sync (GPU)', holdsFrame: true,
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-async_depth', '1', '-bf', '0', '-b:v', '20M', '-maxrate', '20M', '-bufsize', '1M', '-aud', '1', '-bsf:v', 'dump_extra=freq=keyframe'] },
];
/** gpus: the GPU encoders that passed their test, in the order above. resize: gfxcapture knows resize_mode
 *  (scale_aspect = a resized window is scaled into the first size, never cropped). from: the place it was found
 *  (ffmpegCandidates: 'saved path', 'PATH', 'WinGet package' …). */
export interface Ffmpeg { path: string; version: string; gfxcapture: boolean; x264: boolean; gpus: GpuEncoder[]; gpuNote: string | null; resize?: boolean;
  /** gfxcapture has width / height: it scales the captured frame on the GPU before NVENC (gpuScaleSize) */
  gpuScale?: boolean; from?: string }
/** The encoder for this ffmpeg: a GPU encoder, 'x264', or null (none usable). */
export function pickEncoder(ff: Pick<Ffmpeg, 'x264' | 'gpus'>, anyGpu: boolean): GpuEncoder | 'x264' | null {
  const instant = ff.gpus.find((g) => !g.holdsFrame);
  if (instant) return instant;
  const held = ff.gpus.find((g) => g.holdsFrame) ?? null;
  if (held && (anyGpu || !ff.x264)) return held;
  return ff.x264 ? 'x264' : held;
}
const run = (exe: string, args: string[], ms = 8000) => new Promise<{ code: number; out: string }>((res) => {
  execFile(exe, args, { timeout: ms, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => res({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` }));
});
/** One plain line for a GPU encoder that failed its test (its first error line; the NVIDIA driver case spelled out). */
export function gpuEncoderNote(vendor: string, codec: string, out: string): string {
  const api = /Required:\s*([\d.]+)\s*Found:\s*([\d.]+)/i.exec(out), drv = /driver for nvenc is\s*([\d.]+)/i.exec(out);
  if (codec === 'h264_nvenc' && (api || drv)) return `GPU encoder off: NVIDIA driver ${drv ? `${Math.floor(Number(drv[1]))}+` : 'update'} needed${api ? ` (found API ${api[2]})` : ''}`;
  const line = out.split(/\r?\n/).map((l) => l.replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim()).find((l) => l) ?? 'it did not start';
  return `GPU encoder off: ${vendor} ${codec}: ${line}`.slice(0, 200);
}
/** What the running message adds while the feed encodes on the CPU: why the GPU is not used (e.g. a driver to update),
 *  and a GPU encoder that works here but waits for the anyGpu setting. '' when a GPU encoder is used. */
export function cpuFeedNote(ff: Pick<Ffmpeg, 'gpus' | 'gpuNote'> | null, pick: GpuEncoder | 'x264' | null): string {
  if (pick !== 'x264' || !ff) return '';
  const optIn = ff.gpus.find((g) => g.holdsFrame)?.label;
  return [ff.gpuNote, optIn ? `${optIn} works here too (off by default: each picture comes one frame later; capture setting anyGpu)` : null].filter(Boolean).join(' · ');
}
/** Did a GPU encoder test fail only because that maker's graphics card / driver is not in this PC? ffmpeg builds list
 *  every encoder: on an AMD-only PC the NVENC test fails with "Cannot load nvcuda.dll" and Quick Sync with "Error
 *  creating a MFX session". Nothing to fix there, so no gpuNote for it. */
export function gpuAbsent(out: string): boolean {
  return /cannot load (nvcuda|libcuda|nvencodeapi|libnvidia-encode)|no (cuda |nvenc )?capable devices found|dll \S*amf\S* failed to open|cannot load \S*amf|error (creating|initializing) (an internal |a )?mfx session/i.test(out);
}
// Where ffmpeg is looked for, in this order (the first one with gfxcapture + an H.264 encoder wins; an older one found
// on the way is kept only to explain itself): the saved path (capture.json), VTP_FFMPEG, the helper's own PATH, WinGet's
// Links folder, Program Files\ffmpeg, Chocolatey, Scoop, C:\ffmpeg — then, only when none of those works (Windows): the
// user's and the system's PATH read fresh from the registry (`winget install ffmpeg` adds a PATH entry that a helper
// started earlier can't see in its own environment: it needed a restart), every WinGet package folder named *FFmpeg*
// (…\bin\ffmpeg.exe, newest version first: `winget upgrade ffmpeg` moves it to a new versioned folder and deletes the old
// one, so a saved path to it disappears), and last `where.exe ffmpeg`. Each place is logged once, with what was found
// there. VTP_FFMPEG_SEARCH=off skips the registry, the WinGet package scan and where.exe (tests: no real ffmpeg found).
/** What the search touches (tests: a fake folder tree and a stubbed exec — nothing real is run). */
export interface FfmpegSearchIo {
  env: NodeJS.ProcessEnv;
  win: boolean;
  exists(p: string): Promise<boolean>;
  /** a folder's entries ([] when it can't be read) */
  readdir(dir: string): Promise<{ name: string; dir: boolean }[]>;
  exec(exe: string, args: string[], ms?: number): Promise<{ code: number; out: string }>;
  log(line: string): void;
}
export const realSearchIo = (): FfmpegSearchIo => ({
  env: process.env, win: WIN,
  exists: (p) => fsp.access(p).then(() => true, () => false),
  readdir: (d) => fsp.readdir(d, { withFileTypes: true }).then((es) => es.map((e) => ({ name: e.name, dir: e.isDirectory() })), () => []),
  exec: run,
  log: (line) => console.log(`[capture] ${line}`),
});
const envOf = (env: NodeJS.ProcessEnv, k: string) => env[k] ?? Object.entries(env).find(([n]) => n.toUpperCase() === k.toUpperCase())?.[1];
/** Pure: %NAME% expanded from env (a name it doesn't know stays as it is, as in Windows). */
export function expandEnv(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/%([^%;]+)%/g, (m, k: string) => envOf(env, k) ?? m);
}
/** Pure: a PATH value's folders: quotes dropped, %NAME% expanded, empty entries skipped. */
export function pathDirs(value: string, env: NodeJS.ProcessEnv, sep = ';'): string[] {
  return value.split(sep).map((d) => expandEnv(d.trim().replace(/^"(.*)"$/, '$1').trim(), env)).filter(Boolean);
}
/** Pure: the Path value in `reg query <key> /v Path` output (null: none). */
export function regPathValue(out: string): string | null {
  const m = /^[ \t]*Path[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*?)[ \t]*$/im.exec(out);
  return m ? m[1] : null;
}
/** Pure: the .exe paths `where.exe ffmpeg` printed (a .cmd / .bat wrapper can't be started without a shell). */
export function whereExes(out: string): string[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^([a-z]:\\|\\\\).+\.exe$/i.test(l));
}
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** Every …\bin\ffmpeg.exe in a WinGet package folder whose name has "ffmpeg" in it (≤ 4 folders down, ≤ 400 folders
 *  looked into), newest version first (ffmpeg-8.1-full_build before ffmpeg-8.0.1-full_build). */
export async function wingetFfmpegs(root: string, io: Pick<FfmpegSearchIo, 'readdir'>): Promise<string[]> {
  const found: { rel: string; p: string }[] = [];
  let budget = 400;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (budget-- <= 0) return;
    const es = await io.readdir(dir);
    const exe = /^bin$/i.test(path.basename(dir)) ? es.find((e) => !e.dir && e.name.toLowerCase() === 'ffmpeg.exe') : undefined;
    if (exe) found.push({ rel, p: path.join(dir, exe.name) });
    if (depth < 4) for (const e of es) if (e.dir) await walk(path.join(dir, e.name), path.join(rel, e.name), depth + 1);
  };
  for (const pkg of await io.readdir(root)) if (pkg.dir && /ffmpeg/i.test(pkg.name)) await walk(path.join(root, pkg.name), '', 0);
  return found.sort((a, b) => natural.compare(b.rel, a.rel) || natural.compare(a.p, b.p)).map((f) => f.p);
}
export interface FfCandidate { path: string; from: string }
/** The places to look, in order, each once (lazily: the registry, the WinGet scan and where.exe only run when nothing
 *  before them worked). */
export async function* ffmpegCandidates(custom: string, io: FfmpegSearchIo, onPlace?: (from: string, wide: boolean) => void): AsyncGenerator<FfCandidate> {
  const env = io.env, exe = io.win ? 'ffmpeg.exe' : 'ffmpeg', seen = new Set<string>();
  const sys32 = path.join(envOf(env, 'SystemRoot') ?? envOf(env, 'windir') ?? 'C:\\Windows', 'System32');
  const local = envOf(env, 'LOCALAPPDATA'), pf = envOf(env, 'ProgramFiles'), choco = envOf(env, 'ChocolateyInstall'), home = envOf(env, 'USERPROFILE');
  const reg = async (key: string) => pathDirs(regPathValue((await io.exec(path.join(sys32, 'reg.exe'), ['query', key, '/v', 'Path'], 4000)).out) ?? '', env).map((d) => path.join(d, exe));
  const wide = io.win && String(envOf(env, 'VTP_FFMPEG_SEARCH') ?? '').toLowerCase() !== 'off';
  type Place = [from: string, list: () => string[] | Promise<string[]>, wide?: boolean];
  const places: Place[] = [
    ['saved path', () => (custom ? [custom] : [])],
    ['VTP_FFMPEG', () => [envOf(env, 'VTP_FFMPEG') ?? '']],
    ['PATH', () => pathDirs(envOf(env, 'PATH') ?? '', env, io.win ? ';' : ':').map((d) => path.join(d, exe))],
    ['WinGet link', () => (local ? [path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')] : [])],
    ['Program Files', () => (pf ? [path.join(pf, 'ffmpeg', 'bin', 'ffmpeg.exe')] : [])],
    ['Chocolatey', () => (choco ? [path.join(choco, 'bin', 'ffmpeg.exe')] : [])],
    ['Scoop', () => (home ? [path.join(home, 'scoop', 'shims', 'ffmpeg.exe')] : [])],
    ['C:\\ffmpeg', () => ['C:\\ffmpeg\\bin\\ffmpeg.exe']],
    ...(wide ? [
      ['user PATH (registry)', () => reg('HKCU\\Environment'), true],
      ['system PATH (registry)', () => reg('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), true],
      ['WinGet package', () => (local ? wingetFfmpegs(path.join(local, 'Microsoft', 'WinGet', 'Packages'), io) : []), true],
      ['WinGet package (all users)', () => (pf ? wingetFfmpegs(path.join(pf, 'WinGet', 'Packages'), io) : []), true],
      ['where.exe', async () => whereExes((await io.exec(path.join(sys32, 'where.exe'), ['ffmpeg'], 4000)).out), true],
    ] as Place[] : []),
  ];
  for (const [from, list, isWide] of places) {
    onPlace?.(from, !!isWide);
    for (const p of await list()) {
      const k = io.win ? path.win32.normalize(p).toLowerCase() : p;
      if (!p || seen.has(k)) continue;
      seen.add(k);
      yield { path: p, from };
    }
  }
}
/** What the last search looked at, for the Scene tab: how many places, the saved path when it is gone, ffmpegs found
 *  that can't be used (≤ 3), whether the wider search (registry, WinGet packages, where.exe) ran. */
export interface FfSearch { looked: number; savedGone: string | null; unusable: string[]; wide: boolean }
/** gfxcapture + an H.264 encoder. */
export const ffUsable = (ff: Pick<Ffmpeg, 'gfxcapture' | 'x264' | 'gpus'> | null | undefined) => !!ff && ff.gfxcapture && (ff.x264 || ff.gpus.length > 0);
const loggedLines = new Set<string>();
/** A line logged once per helper run (a search repeated every minute while ffmpeg is missing adds nothing). */
function logOnce(io: FfmpegSearchIo, line: string) { if (loggedLines.has(line) || loggedLines.size >= 500) return; loggedLines.add(line); io.log(line); }
/** Look for ffmpeg (see above) and test what it can do: gfxcapture, x264, the GPU encoders (one black test frame each,
 *  never a capture). */
export async function searchFfmpeg(custom: string, io: FfmpegSearchIo = realSearchIo()): Promise<{ ff: Ffmpeg | null; search: FfSearch }> {
  let best: Ffmpeg | null = null;
  const search: FfSearch = { looked: 0, savedGone: null, unusable: [], wide: false };
  for await (const { path: p, from } of ffmpegCandidates(custom, io, (_, wide) => { if (wide) search.wide = true; })) {
    search.looked++;
    const say = (verdict: string) => logOnce(io, `ffmpeg candidate (${from}): ${p} → ${verdict}`);
    const unusable = (why: string) => { if (search.unusable.length < 3) search.unusable.push(`${p} (${why})`); };
    if (!(await io.exists(p))) {
      if (from === 'saved path') search.savedGone = p;
      say(from === 'saved path' ? 'not there any more (a winget upgrade moves ffmpeg to a new folder): looking elsewhere' : 'not there');
      continue;
    }
    const v = await io.exec(p, ['-hide_banner', '-version']);
    if (v.code !== 0) { say(`won’t run (exit ${v.code})`); unusable(`won’t run, exit ${v.code}`); continue; }
    const f = await io.exec(p, ['-hide_banner', '-filters']);
    const e = await io.exec(p, ['-hide_banner', '-encoders']);
    const ff: Ffmpeg = { path: p, version: (v.out.split(/\r?\n/)[0] ?? '').replace(/^ffmpeg version\s*/, '').split(' ')[0], gfxcapture: /\sgfxcapture\s/.test(f.out), x264: /\slibx264\s/.test(e.out), gpus: [], gpuNote: null, from };
    if (ff.gfxcapture) {
      for (const enc of GPU_ENCODERS) {
        if (!new RegExp(`\\s${enc.codec}\\s`).test(e.out)) continue;
        // a GPU encoder needs a driver new enough for this ffmpeg build (8.1 → NVENC API 13.1 / driver 610+): one frame of
        // a black test picture (never a capture), with the feed's own encoder settings
        const t = await io.exec(p, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '1', '-vf', 'format=nv12', ...enc.args, '-f', 'null', '-'], 10000);
        if (t.code === 0) { ff.gpus.push(enc); if (!enc.holdsFrame) break; continue; }   // NVENC works: nothing else needed
        if (!gpuAbsent(t.out)) ff.gpuNote ??= gpuEncoderNote(enc.vendor, enc.codec, t.out);   // a card that is there but can't
      }
      const gh = (await io.exec(p, ['-hide_banner', '-h', 'filter=gfxcapture'])).out;
      ff.resize = /\bresize_mode\b/.test(gh);
      // (only the options are looked up here, no capture at probe time; the size they give is checked on the first real start)
      ff.gpuScale = /^\s*width\s+<int>/m.test(gh) && /^\s*height\s+<int>/m.test(gh);
    }
    const encs = [ff.x264 ? 'x264' : '', ...ff.gpus.map((g) => g.label)].filter(Boolean).join(', ');
    if (ffUsable(ff)) { say(`ffmpeg ${ff.version}: gfxcapture, ${encs} → using it`); best = ff; break; }
    const why = ff.gfxcapture ? 'gfxcapture but no H.264 encoder' : 'no gfxcapture: FFmpeg 8.1+ needed';
    say(`ffmpeg ${ff.version}: ${why}`); unusable(`ffmpeg ${ff.version}: ${why}`);
    best ??= ff;
  }
  return { ff: best, search };
}
/** How long "no ffmpeg" / an unusable one (too old, no encoder) is believed before looking again: installed or
 *  upgraded meanwhile = found without a restart. A usable one is kept while its file is there. */
export const FF_RECHECK_MS = 60_000;
let ffCache: { key: string; at: number; ff: Ffmpeg | null } | null = null;
let ffFinding: { key: string; p: Promise<Ffmpeg | null> } | null = null;
let ffSearch: FfSearch | null = null;
/** The last search's notes (null: none yet). */
export const lastFfSearch = () => ffSearch;
export async function findFfmpeg(custom: string, io: FfmpegSearchIo = realSearchIo()): Promise<Ffmpeg | null> {
  const c = ffCache;
  // a usable ffmpeg whose file is gone (a winget upgrade deleted its versioned folder; the saved path in capture.json
  // pointed there) is looked for again now — not after a failed start
  if (c && c.key === custom && (ffUsable(c.ff) ? await io.exists(c.ff!.path) : Date.now() - c.at < FF_RECHECK_MS)) return c.ff;
  if (ffFinding?.key === custom) return ffFinding.p;                   // one probe at a time (the Scene tab + a starting feed)
  const p = searchFfmpeg(custom, io).then(({ ff, search }) => { ffCache = { key: custom, at: Date.now(), ff }; ffSearch = search; return ff; })
    .finally(() => { if (ffFinding?.p === p) ffFinding = null; });
  ffFinding = { key: custom, p };
  return p;
}
/** Forget what was found and where it was looked for (the next findFfmpeg looks again). */
export function forgetFfmpeg() { ffCache = null; ffSearch = null; }
/** Pure: the Scene tab's words when no ffmpeg can be run: where it looked, a saved path that is gone, what to do. */
export function ffmpegMissingMessage(search: FfSearch | null): string {
  const looked = search ? ` (looked in ${search.looked} places${search.wide ? ' incl. your user + system PATH, WinGet packages and where.exe' : ''})` : '';
  const gone = search?.savedGone ? ` The saved ffmpeg path ${search.savedGone} is gone (winget upgrade moves ffmpeg to a new folder).` : '';
  const bad = search?.unusable.length ? ` Found but unusable: ${search.unusable.join('; ')}.` : '';
  return `ffmpeg not found${looked}.${gone}${bad} Install it once (Windows Terminal: winget install ffmpeg): VTube Pro finds it by itself within a minute, no restart needed (or press Find ffmpeg again). Until then in-scene capture uses a window shared from the studio.`;
}
/** Pure: the note when the saved ffmpeg path is gone but another ffmpeg is used ('' otherwise). */
export function savedGoneNote(search: FfSearch | null, ff: Pick<Ffmpeg, 'path' | 'from'> | null): string {
  return search?.savedGone && ff ? `the saved ffmpeg path ${search.savedGone} is gone (winget upgrade?) — using ${ff.path}${ff.from ? ` (${ff.from})` : ''}` : '';
}

// ---------------------------------------------------------------- what to capture (server/screenTarget.ts)
/** What OBS's capture source shows, through the OBS automation's shared read connection (server/obs.ts readOnly). */
export const resolveTarget = (s: CaptureSettings) => resolveFrom(s, obs);

/** Windows to pick from: OBS's own window list (same "title:class:exe" values) when a Window Capture exists, else ours. */
async function listWindows(): Promise<CaptureWindow[]> {
  const c = obs.cfg;
  if (obs.canRead()) {
    const cl = new ObsClient();
    try {
      await cl.connect(c.url, c.password, 4000);
      const inputs = (await cl.request<{ inputs: { inputName: string; inputKind: string }[] }>('GetInputList')).inputs ?? [];
      const wc = inputs.find((i) => i.inputKind === 'window_capture');
      if (wc) {
        const items = (await cl.request<{ propertyItems: { itemName: string; itemValue: unknown }[] }>('GetInputPropertiesListPropertyItems', { inputName: wc.inputName, propertyName: 'window' })).propertyItems ?? [];
        const out = items.filter((i) => typeof i.itemValue === 'string' && i.itemValue).map((i) => { const w = parseObsWindow(String(i.itemValue)); return { value: String(i.itemValue), title: w?.title ?? i.itemName, exe: w?.exe ?? '' }; });
        if (out.length) return out;
      }
    } catch { /* fall through */ } finally { cl.close(); }
  }
  if (!WIN) return [];
  // PowerShell: top-level windows with a title (main windows only)
  const ps = `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName).exe" + [char]9 + $_.MainWindowTitle }`;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 8000);
  const enc = (x: string) => x.replace(/#/g, '#22').replace(/:/g, '#3A');
  return r.out.split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length === 2 && p[1].trim())
    .map(([exe, title]) => ({ value: `${enc(title.trim())}::${enc(exe.trim())}`, title: title.trim(), exe: exe.trim() }));
}

// ---------------------------------------------------------------- H.264 access units
const isStart = (b: Buffer, i: number) => b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1;
const START3 = Buffer.from([0, 0, 1]);
/** The start of the next access unit (its AUD NAL, with the 4-byte start code's leading 0) at or after `from`, or -1.
 *  Buffer.indexOf runs natively: the same matches as a byte-by-byte JS loop, which walked every byte of every big frame. */
export function findAud(b: Buffer, from: number) {
  for (let i = b.indexOf(START3, from); i >= 0 && i + 3 < b.length; i = b.indexOf(START3, i + 3)) if ((b[i + 3] & 0x1f) === 9) return i > 0 && b[i - 1] === 0 ? i - 1 : i;
  return -1;
}
/** The NAL unit types in an access unit. */
export function nalTypes(au: Buffer) { const t = new Set<number>(); for (let i = au.indexOf(START3); i >= 0 && i + 3 < au.length; i = au.indexOf(START3, i + 3)) t.add(au[i + 3] & 0x1f); return t; }
/** ffmpeg's H.264 byte stream cut into access units (each starts at an AUD). Chunks go into one growing buffer and only
 *  the new bytes are searched: a 1 MB key frame arrives in ~16 pipe chunks, and joining + re-scanning the whole partial
 *  frame for every chunk was quadratic. `onAu` gets a view that is only valid during the call. */
export class AuSplitter {
  private store = Buffer.allocUnsafe(1 << 18);
  private len = 0;
  private from = 4;                                                   // where the next AUD search starts
  constructor(private onAu: (au: Buffer) => void) {}
  push(d: Buffer) {
    if (this.len + d.length > this.store.length) {
      const n = Buffer.allocUnsafe(Math.max(this.store.length * 2, this.len + d.length));
      this.store.copy(n, 0, 0, this.len); this.store = n;
    }
    d.copy(this.store, this.len); this.len += d.length;
    for (;;) {
      const b = this.store.subarray(0, this.len), j = findAud(b, this.from);
      if (j < 0) { this.from = Math.max(4, this.len - 3); break; }   // (a start code may be cut by the chunk edge: look 3 bytes back)
      this.onAu(b.subarray(0, j));
      this.store.copyWithin(0, j, this.len); this.len -= j; this.from = 4;
    }
  }
  /** What is held is one whole access unit (an access unit arrives in one write: idle = complete). */
  flush() { if (this.len) { const n = this.len; this.len = 0; this.from = 4; this.onAu(this.store.subarray(0, n)); } }
}
function codecOf(au: Buffer): string | null {
  for (let i = 0; i + 6 < au.length; i++) if (isStart(au, i) && (au[i + 3] & 0x1f) === 7) {
    const h = (x: number) => x.toString(16).padStart(2, '0');
    return `avc1.${h(au[i + 4])}${h(au[i + 5])}${h(au[i + 6])}`;
  }
  return null;
}

/** One OBS page this second: since when it has shown no picture while the feed sends (undefined = it shows frames, it
 *  reported nothing yet, it can't decode at all, or nothing is being sent). */
export function blindStep(prev: number | undefined, sending: boolean, r: FeedRxStats | null, now: number): number | undefined {
  return sending && r && !r.error && r.fps === 0 ? prev ?? now : undefined;
}
/** "Connected but 0 fps": at least one page shows no picture while the feed sends, and none of the pages that can decode
 *  has shown one for NO_PICTURE_MS. */
export function noPicture(pages: { stats: FeedRxStats | null; blindSince?: number }[], now: number): boolean {
  return pages.some((p) => p.blindSince !== undefined)
    && pages.every((p) => !p.stats || !!p.stats.error || (p.blindSince !== undefined && now - p.blindSince > NO_PICTURE_MS));
}

/** An OBS page's stats message (junk-tolerant). */
export function rxStats(m: Partial<FeedRxStats>): FeedRxStats {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    type: 'stats', fps: n(m.fps), decodeMs: n(m.decodeMs), ageMs: n(m.ageMs), hw: !!m.hw, error: typeof m.error === 'string' ? m.error.slice(0, 200) : undefined,
    rx: n(m.rx), ...(typeof m.decErr === 'string' && m.decErr ? { decErr: m.decErr.slice(0, 160), decErrors: Math.max(0, Math.round(n(m.decErrors))) } : {}),
  };
}

// ---------------------------------------------------------------- the ffmpeg command
// Key frames + rate control (measured: tools/react_feed_e2e.ts QUALITY=1 — Y-PSNR / SSIM of every decoded frame vs the
// test pattern, old vs new). Windows.Graphics.Capture sends a frame only when the window / monitor changes (ffmpeg's
// gfxcapture: "does NOT hold a stable FPS"), so a slow window (chat, an article, a document) is a few frames a second or
// fewer. Two things made such a window's picture soft:
//  * x264's rate control assumed a steady 60 fps (ffmpeg's libx264 feeds it as constant frame rate): every frame got
//    1/60 s of the 25 Mbit/s budget (≈ 52 KB) whatever its real duration, so a change that stays on screen for seconds
//    was coded as a ≈ 50 KB frame (a 1080p text page: ≈ 22 dB, blurred). (force-cfr=0 fixed that but made x264 hold
//    every frame until the NEXT one arrived — a slow window's change showed only at its next change — so it is NOT
//    used: zerolatency keeps CFR; the bigger buffer below still keeps key frames sharp);
//  * a forced key frame every second (KEY_EVERY_S = 1, commit 7bc5e26) turned EVERY change of a slow window into such a
//    starved key frame, so it never sharpened.
// Now: a key frame every fps × 2 frames (a busy 60 fps window: every 2 s, as before 7bc5e26) or every KEY_MAX_S
// seconds, whichever comes first (bounds what a joining / resyncing page is replayed); a 16 Mbit (2 MB) buffer so a key
// frame is never starved; recovery never waits for a key frame (the whole group since the last one is replayed:
// accept(), resync, a stalled socket that caught up). Busy windows: the same key-frame rate as before 7bc5e26, but no
// blurred "pulse" at each one (its key frame was capped at ≈ 120 KB).
/** Frames per key-frame group at a steady rate: 2 s of the capture's frame rate (fps × GOP_SECONDS_AT_RATE). */
export const GOP_SECONDS_AT_RATE = 2;
/** At most this long (s, stream time) between key frames, however slowly the window changes. */
export const KEY_MAX_S = 10;
/** x264's rate buffer (VBV): big enough for a sharp 1080p key frame (≈ 0.5–1.3 MB measured). */
export const VBV_BUFSIZE = '16M';
/** ffmpeg's force_key_frames expression: a key frame on the first frame, then every `frames` frames or `secs` seconds
 *  since the last one, whichever comes first (every key frame is forced: the encoder's own GOP is off). */
export const keyFrameExpr = (frames: number, secs: number) => `expr:if(isnan(prev_forced_n),1,gte(n-prev_forced_n,${frames})+gte(t-prev_forced_t,${secs}))`;
/** A whole monitor bigger than the feed's picture is captured at most this often (see feedFps). */
export const BIG_MONITOR_FPS = 30;
/** Pure: the frame rate the feed captures at. A whole monitor much bigger than the picture it becomes (a 4K desktop
 *  shrunk to 1080p — the owner's Display Capture) costs per frame: the full-size frame read back from the GPU (≈ 2 GB/s
 *  at 4K60) and scaled + converted on the CPU, next to OBS and a game, at below-normal priority. Measured with
 *  tools/react_feed_e2e.ts LOAD=1 (x264): 4K60 → 1080p ≈ 0.95 CPU cores, 4K30 ≈ 0.28, a 1080p60 window ≈ 0.28. So such
 *  a monitor is captured at ≤ BIG_MONITOR_FPS; a window (size unknown up front) keeps the chosen rate. */
export function feedFps(fps: number, maxWidth: number, size?: { w: number; h: number } | null): number {
  if (!size || !(size.w > 0 && size.h > 0)) return fps;
  const outW = Math.min(maxWidth, size.w), outH = (outW * size.h) / size.w;
  return size.w * size.h > 1.5 * outW * outH ? Math.min(fps, BIG_MONITOR_FPS) : fps;
}
/** The ffmpeg source for a gfxcapture selector: the capture (GPU) → system memory (BGRA). `direct`: the GPU frames stay
 *  on the GPU (D3D11) for NVENC (directCapture). */
export function captureInput(sel: string, fps: number, resize: boolean, direct = false, scaleTo?: { w: number; h: number } | null): string {
  // (resize_mode=scale_aspect: a window resized / maximised later is scaled into the frame, not cropped or padded)
  // scaleTo (direct only): gfxcapture's own width / height scale the frame on the GPU, still no copy to system memory
  return `gfxcapture=${sel}:max_framerate=${fps}:capture_cursor=1${resize ? ':resize_mode=scale_aspect' : ''}${direct && scaleTo ? `:width=${scaleTo.w}:height=${scaleTo.h}` : ''}${direct ? '' : ',hwdownload,format=bgra'}`;
}
/** Pure: the size the direct (GPU) feed is scaled to on the GPU: at most maxWidth wide (even numbers, the aspect kept —
 *  the same width the readback path's CPU scale gives), or null = leave it as it is (size unknown or already small
 *  enough). Measured 2026-10-30 (RTX 5090, ffmpeg 8.1.2): gfxcapture width/height 3840x2160 → 1920x1080 matches the CPU
 *  bilinear scale (45 dB PSNR) and runs as fast as the unscaled capture (0.94x vs 0.92x real time, NVENC 20 Mbit). */
export function gpuScaleSize(maxWidth: number, size?: { w: number; h: number } | null): { w: number; h: number } | null {
  if (!size || !(size.w > 0 && size.h > 0)) return null;
  const w = Math.max(2, Math.floor(maxWidth / 2) * 2);
  if (size.w <= w) return null;
  return { w, h: Math.max(2, Math.ceil((w * size.h) / size.w / 2) * 2) };   // (height rounded up: scale_aspect then leaves no bar)
}
/** ffmpeg exits while a page still wants the feed (the window is closed / between game launches, a crash): the retry
 *  waits this long after the n-th failed start in a row — doubling, never more than RETRY_MAX_MS, so a relaunched game
 *  is found again quickly (a window that isn't open: 3 / 6 / 12 / 15 s, another exit: 5 / 10 / 15 s). The count starts
 *  over with the first picture, a restart / settings change / OBS setup change, and a page joining (accept()). */
export const RETRY_BASE_MS = 3000, RETRY_OTHER_MS = 5000, RETRY_MAX_MS = 15_000;
export const retryDelayMs = (fails: number, notFound: boolean): number => Math.min(RETRY_MAX_MS, (notFound ? RETRY_BASE_MS : RETRY_OTHER_MS) * 2 ** Math.max(0, fails - 1));
/** Pure: capture straight into the GPU encoder, no copy back to system memory? NVENC takes gfxcapture's D3D11 frames as
 *  they are. Measured 2026-10-22 on the owner's PC (RTX 5090, driver 621, 4K monitor, ffmpeg 8.1.2): the readback +
 *  CPU scale path ran at 0.81× real time and 6.5 s CPU per 8 s; direct at 0.95× and 0.77 s CPU — next to a game the
 *  readback starved the feed to a stutter. ffmpeg 8.1.2 can't scale these frames on the GPU (scale_d3d11 / scale_cuda /
 *  scale_d3d12 all refuse gfxcapture frames), so direct sends the capture at its own size (the page scales it on the
 *  screen anyway). Off after a direct start that died before its first frame (directFailed): readback as before. */
export function directCapture(gpu: Pick<GpuEncoder, 'codec'> | null, directFailed: boolean): boolean {
  return gpu?.codec === 'h264_nvenc' && !directFailed;
}
const X264_ARGS = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-crf', '18', '-maxrate', '25M', '-bufsize', VBV_BUFSIZE,
  '-x264-params', 'aud=1:repeat-headers=1:sliced-threads=1:threads=6:rc-lookahead=0:sync-lookahead=0'];
export const FEED_ENCODERS = { gpu: GPU_ENCODERS, x264: X264_ARGS };
/** Pure: the encoder's own name for "a forced key frame is an IDR". libx264 and NVENC call it -forced-idr, AMD AMF and
 *  Intel Quick Sync -forced_idr (ffmpeg 8.1 `-h encoder=...`). ffmpeg only WARNS about an option no stream used, so the
 *  wrong spelling silently meant one IDR at the start and plain I frames after it: the pages' join / resync / replay
 *  wait for an IDR (NAL type 5) and never got one (review of beta.9). Picked from the encoder's -c:v. */
export function forcedIdrOption(encArgs: readonly string[]): string {
  const i = encArgs.indexOf('-c:v');
  const codec = i >= 0 ? encArgs[i + 1] : '';
  return codec === 'h264_amf' || codec === 'h264_qsv' ? '-forced_idr' : '-forced-idr';
}
/** Pure: ffmpeg's arguments for the feed — `input` (captureInput, or a lavfi test pattern in tools/react_feed_e2e.ts)
 *  scaled to at most maxWidth, H.264 with an access-unit delimiter on every frame and SPS/PPS on every key frame, key
 *  frames as above (keyFrameExpr), raw Annex B on stdout. */
export function ffmpegArgs(o: { input: string; fps: number; maxWidth: number; gpu: Pick<GpuEncoder, 'args'> | null; direct?: boolean }): string[] {
  const { input, fps, maxWidth: mw, gpu } = o;
  // (direct: the D3D11 frames go to NVENC as they are, at the capture's own size: directCapture)
  const graph = o.direct && gpu ? `${input}[v]` : `${input},scale='trunc(min(${mw},iw)/2)*2':'trunc(ow*ih/iw/2)*2':flags=bilinear,format=${gpu ? 'nv12' : 'yuv420p'}[v]`;
  // (the GPU encoders' rate control is not changed here: not measurable on the PC this was tuned on)
  const enc = gpu ? gpu.args : X264_ARGS;
  // every key frame forced (IDR — NAL type 5, what the pages look for — with every encoder, each under its own option
  // name: forcedIdrOption); the encoder's own frame-count GOP off (it would add key frames the expression doesn't know about)
  const keys = ['-g', '100000', '-force_key_frames', keyFrameExpr(Math.max(2, Math.round(fps * GOP_SECONDS_AT_RATE)), KEY_MAX_S), forcedIdrOption(enc), '1'];
  return ['-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info', '-filter_complex', graph, '-map', '[v]', ...enc,
    ...keys, '-fps_mode', 'passthrough', '-flush_packets', '1', '-f', 'h264', 'pipe:1'];
}

// ---------------------------------------------------------------- the feed
/** What the feed takes from outside. The app: none (the real ffmpeg discovery, OBS, the helper's /ws/screen, the saved
 *  settings). Tests / tools/react_feed_e2e.ts: a known ffmpeg (no probing, no NVENC test on the GPU), a fixed target, a
 *  test-pattern `input` instead of a screen capture, sockets handed to accept(), settings never saved. */
export interface FeedDeps {
  findFf?: (custom: string) => Promise<Ffmpeg | null>;
  resolve?: (s: CaptureSettings) => Promise<Target | Problem>;
  /** replaces captureInput() (gfxcapture + hwdownload): an ffmpeg source filter giving BGRA frames */
  input?: string;
  /** another ffmpeg command (measurements only: an older encoder setting, side by side) */
  ffArgs?: typeof ffmpegArgs;
  /** GOP_MAX_BYTES (tests: a key-frame group that outgrew the replay) */
  gopMax?: number;
  /** false = don't take the helper's /ws/screen (accept() sockets yourself) */
  attach?: boolean;
  /** start from these settings and never write config/capture.json */
  settings?: Partial<CaptureSettings>;
  /** replaces retryDelayMs (tests: a retry back-off in milliseconds instead of seconds) */
  retry?: typeof retryDelayMs;
}
/** An OBS page's socket + the feed's notes on it: skipped (stalled), its last resync, a replay burst in flight. */
type FeedSocket = WebSocket & { _skip?: boolean; _resyncAt?: number; _burst?: { bytes: number; until: number } };
export class ScreenFeedServer {
  settings: CaptureSettings;
  private wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 }); // pages send only small control messages
  private rx = new Map<WebSocket, FeedRxStats | null>();
  private proc: ChildProcess | null = null;
  private starting = false;
  private retryAt = 0;
  /** Failed starts in a row since the feed last sent a picture (retryDelayMs); reset by the first picture, restart(), a
   *  changed setupKey() and accept(). backoffKey: the setupKey() the count was made under. */
  private failCount = 0;
  private backoffKey = '';
  /** The selector the next retry tries in a not-found streak (one spawn per try: the exact window, then any window of the app). */
  private streakVariant = 0;
  /** A GPU-scaled direct start gave the wrong size / died before its first frame: direct at the capture's own size until
   *  the next restart() (gpuScaleSize). nativeSizes: the capture size a window had on an unscaled run, per selector. */
  private scaleFailed = false;
  private nativeSizes = new Map<string, { w: number; h: number }>();
  private idleSince = 0;
  private target: Target | null = null;
  private variant = 0;
  private cfg: FeedConfig | null = null;
  private gop: Buffer[] = [];
  private gopBytes = 0;
  /** this.gop holds EVERY frame since the last key frame (false: it outgrew GOP_MAX_BYTES — not replayed). */
  private gopWhole = true;
  private ff: Ffmpeg | null = null;
  private encoder = '';
  private frames = 0; private bytes = 0; private rate = { fps: 0, kbps: 0, at: Date.now() };
  private size = { w: 0, h: 0 };
  private err: string | null = null;
  private problem: Problem | null = null;
  private lastResolve = 0;
  private startedAt = 0;
  private stderrTail = '';
  /** Why the capture runs below the chosen frame rate (feedFps), '' = it does not. */
  private capped = '';
  private timer = setInterval(() => void this.tick(), 1000);

  constructor(private deps: FeedDeps = {}) {
    this.settings = deps.settings ? sanitize(deps.settings, DEFAULTS) : load();
    if (deps.attach !== false) onUpgrade('/ws/screen', (req, socket, head) => {
      if (!busRequestOk(req)) { socket.destroy(); return; } // this PC's pages
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
  }
  private findFf(custom: string) { return (this.deps.findFf ?? findFfmpeg)(custom); }
  private resolveTarget(s: CaptureSettings) { return (this.deps.resolve ?? resolveTarget)(s); }

  /** An OBS page's /ws/screen connection (the helper's upgrade handler; tests hand their own sockets). */
  accept(ws: WebSocket) {
    this.rx.set(ws, null);
    this.idleSince = 0;
    // a page starting to want the feed: a back-off from earlier failures is over, the next try comes within RETRY_BASE_MS
    if (this.failCount) { this.failCount = 0; this.retryAt = Math.min(this.retryAt, Date.now() + RETRY_BASE_MS); }
    this.replay(ws);
    this.freshen();
    // a setup problem found a while ago may be fixed by now in OBS itself (a window picked in the source's Properties,
    // the source back after a scene-collection switch …) — nothing looks while no page wants the feed. A page starting
    // to want it hears 'starting' and the problem is looked at again at once (it used to hear the stale 'no' and latch
    // "failed": the OBS passthrough, then the in-room feed a second later)
    if (this.problem?.setup && Date.now() - this.problemAt > PROBLEM_FRESH_MS) { this.problem = null; this.retryAt = 0; }
    ws.send(JSON.stringify(this.statusMsg()));                        // what the page should do meanwhile (stay in the room)
    ws.on('message', (d, bin) => {
      if (bin) return;
      try {
        const m = JSON.parse(String(d)) as FeedRxStats | { type: 'resync' };
        if (m?.type === 'stats') this.rx.set(ws, rxStats(m));
        else if (m?.type === 'resync') this.resync(ws);
      } catch { /* */ }
    });
    ws.on('close', () => { this.rx.delete(ws); this.blind.delete(ws); if (!this.rx.size) this.idleSince = Date.now(); });
    ws.on('error', () => ws.terminate());
    void this.tick();
  }

  /** The config + the frames since the last key frame (a joining page shows the current picture at once instead of
   *  waiting for the next key frame; the page takes a config as "a burst follows"). Only a WHOLE group: frames missing
   *  in the middle (past GOP_MAX_BYTES) would decode into garbage — the page then waits for the next key frame
   *  (≤ KEY_MAX_S). */
  private replay(ws: WebSocket) {
    if (!this.cfg || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(this.cfg));
    if (!this.gopWhole) return false;
    const w = ws as FeedSocket;
    for (const m of this.gop) ws.send(m);
    w._skip = false;
    w._burst = { bytes: this.gopBytes, until: Date.now() + 3000 };   // (this burst isn't a stall)
    return this.gop.length > 0;
  }
  /** A page's decoder failed or got stuck ({type:'resync'}): send it the picture again from the last key frame, now —
   *  it used to wait for the next key frame (with a still window and the old frame-count GOP: minutes of no picture). */
  private resync(ws: WebSocket) {
    const w = ws as FeedSocket;
    const now = Date.now();
    if (now - (w._resyncAt ?? 0) < RESYNC_SERVER_MS) return;            // (a page asking in a loop)
    w._resyncAt = now;
    this.replay(ws);
  }

  /** The feed state the OBS pages act on (FeedStatusMsg), sent on join and whenever it changes. The feed switched off
   *  in the Scene tab is a definite no for the pages ('unavailable': Auto may use an exact passthrough), though the
   *  Scene tab shows it as a plain setting ('idle', no warning sign). */
  private statusMsg(): FeedStatusMsg {
    const s = this.status();
    return { type: 'status', state: pageFeedState(this.settings.source, s.state), message: s.message };
  }
  private lastMsg = '';
  private pushStatus() {
    if (!this.rx.size) { this.lastMsg = ''; return; }
    const j = JSON.stringify(this.statusMsg());
    if (j === this.lastMsg) return;
    this.lastMsg = j;
    for (const ws of this.rx.keys()) if (ws.readyState === WebSocket.OPEN) try { ws.send(j); } catch { /* */ }
  }
  /** Pages getting frames but showing none ("connected but 0 fps"): since when. */
  private blind = new Map<WebSocket, number>();
  /** What a setup problem depended on (the feed's source / picked window, OBS's address, password, capture source):
   *  when one of them changes it is looked at again at once — a page joining meanwhile must not hear the old 'no'. */
  private problemKey = '';
  private problemAt = 0;
  private setupKey() { const c = obs.cfg; return JSON.stringify([this.settings.source, this.settings.window, c.captureSource, c.url, c.password, obs.canRead()]); }
  private freshen() {
    if (this.problem?.setup && this.problemKey !== this.setupKey()) { this.problem = null; this.retryAt = 0; }
    if (this.failCount && this.backoffKey !== this.setupKey()) { this.failCount = 0; this.retryAt = 0; }   // (OBS / the source changed: try now)
  }

  update(p: Partial<CaptureSettings>) {
    this.settings = sanitize(p, this.settings);
    if (!this.deps.settings) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(this.settings, null, 2));
    }
    ffCache = null;
    this.restart();
  }
  /** A straight-from-the-GPU start died before its first frame: readback until the next restart() (directCapture). */
  private directFailed = false;
  restart() {
    this.stop(); this.retryAt = 0; this.variant = 0; this.directFailed = false; this.target = null; this.problem = null; this.err = null;
    this.failCount = 0; this.streakVariant = 0; this.scaleFailed = false; this.nativeSizes.clear();
    void this.tick();
  }

  /** Pages that can decode (a page that reported a decoder error only listens for the status). */
  private get wanted() { return this.settings.source !== 'off' && [...this.rx.values()].some((r) => !r?.error); }

  private async tick() {
    const now = Date.now();
    if (now - this.rate.at >= 1000) {
      const dt = (now - this.rate.at) / 1000;
      this.rate = { fps: Math.round(this.frames / dt), kbps: Math.round((this.bytes * 8) / 1000 / dt), at: now };
      this.frames = 0; this.bytes = 0;
    }
    this.freshen();
    // pages that receive the feed but show no picture (decoder errors, a stuck decoder): since when
    const sending = !!this.proc && !!this.cfg && this.rate.fps >= 5;
    for (const [ws, r] of this.rx) {
      const b = blindStep(this.blind.get(ws), sending, r, now);
      if (b === undefined) this.blind.delete(ws); else this.blind.set(ws, b);
    }
    this.pushStatus();
    if (!this.wanted) { if (this.proc && this.idleSince && now - this.idleSince > idleStopMs(!!this.gpu())) { this.stop(); this.nativeSizes.clear(); } return; }
    if (this.proc) {
      // follow the OBS source: re-read its window every 10 s and restart when it changed
      if (this.settings.source === 'obs' && now - this.lastResolve > 10_000 && !this.starting) {
        this.lastResolve = now;
        const t = await this.resolveTarget(this.settings);
        if ('selectors' in t && this.target && t.selectors.join('|') !== this.target.selectors.join('|')) { this.target = null; this.variant = 0; this.stop(); this.retryAt = 0; }
      }
      return;
    }
    if (this.starting || now < this.retryAt) return;
    this.starting = true;
    try { await this.start(); } finally { this.starting = false; }
    this.pushStatus();                                                // (a problem found now: the pages hear it now, not in 1 s)
  }

  private async start() {
    if (!WIN) { this.err = 'The fast window feed needs Windows (Windows.Graphics.Capture).'; this.retryAt = Date.now() + 60_000; return; }
    // (this start's own ffmpeg: this.ff may change while resolveTarget is awaited below - an older search from
    // ensureProbed / probe finishing late used to null it here and crash the helper: lookFf)
    const ff = await this.lookFf();
    const choice = ff ? pickEncoder(ff, !!this.settings.anyGpu) : null;
    if (!ff?.gfxcapture || !choice) { this.retryAt = Date.now() + 30_000; return; }
    if (!this.target) {
      const t = await this.resolveTarget(this.settings);
      this.lastResolve = Date.now();
      if ('problem' in t) { this.problem = t; this.problemKey = this.setupKey(); this.problemAt = Date.now(); this.retryAt = Date.now() + 5000; return; }
      this.problem = null; this.target = t;
      this.variant = this.failCount ? Math.min(this.streakVariant, t.selectors.length - 1) : 0;
    }
    const t = this.target, sel = t.selectors[Math.min(this.variant, t.selectors.length - 1)];
    const { maxWidth } = this.settings, gpu = choice === 'x264' ? null : choice;
    const fps = feedFps(this.settings.fps, maxWidth, t.size);
    this.capped = fps < this.settings.fps ? `${fps} fps: a whole ${t.size!.w}×${t.size!.h} monitor (captured slower to spare the CPU / GPU next to OBS)` : '';
    const direct = !this.deps.input && directCapture(gpu, this.directFailed);
    // direct sends the capture at its own size, so a 4K window would be decoded + uploaded at 4K in the OBS page: gfxcapture
    // scales it to maxWidth on the GPU instead (same fps). A monitor's size is in OBS's name for it; a window's is only known
    // from ffmpeg itself, so its first run is unscaled and restarts scaled once its size is read (startScaleCheck)
    const canScale = direct && !!ff.gpuScale && !this.scaleFailed;
    const scaleTo = canScale ? gpuScaleSize(maxWidth, t.size ?? this.nativeSizes.get(sel)) : null;
    const args = (this.deps.ffArgs ?? ffmpegArgs)({ input: this.deps.input ?? captureInput(sel, fps, !!ff.resize, direct, scaleTo), fps, maxWidth, gpu, direct });
    this.encoder = gpu ? `${gpu.label}${direct ? ', straight from the GPU' : ''}${scaleTo ? `, scaled to ${scaleTo.w}×${scaleTo.h} there` : ''}` : 'x264 (CPU)';
    this.stderrTail = ''; this.err = null; this.cfg = null; this.gop = []; this.gopBytes = 0;
    // the ffmpeg running now is the one the Scene tab shows; a search still in flight is older than it (lookFf)
    this.ff = ff; this.ffApplied = this.ffSeq;
    const p = spawn(ff.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p; this.startedAt = Date.now();
    // ffmpeg gone since it was found (uninstalled / moved while the helper runs): an 'error' event with no listener
    // would take the whole helper down; one that never started gets no 'exit' either — look for ffmpeg again later
    p.on('error', (e) => {
      if (this.proc !== p || p.pid) return;
      this.proc = null; this.ff = null; forgetFfmpeg();
      this.err = `ffmpeg couldn’t be started (${(e as Error).message.slice(0, 160)}). VTube Pro looks for it again in 30 s.`;
      this.retryAt = Date.now() + 30_000;
    });
    try { if (p.pid) os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* */ }
    let first = true, sized = false;
    p.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
      const m = /Stream #0:0[^\n]*Video: h264[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(this.stderrTail);
      if (m) { this.size = { w: +m[1], h: +m[2] }; if (!sized) { sized = true; this.startScaleCheck(p, sel, scaleTo, canScale, maxWidth); } }
    });
    const split = new AuSplitter((au) => this.emit(au));
    let timer: NodeJS.Timeout | null = null;
    const flush = () => { timer = null; if (this.proc === p) split.flush(); };
    p.stdout!.on('data', (d: Buffer) => {
      if (this.proc !== p) return;                                   // (an ffmpeg we stopped / replaced on purpose)
      if (first) { first = false; this.failCount = 0; this.streakVariant = 0; }   // the first picture: the back-off is over
      split.push(d);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 2);                                  // an access unit arrives in one write: idle = complete
    });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null; this.cfg = null; this.gop = [];
      const notFound = /Failed to find capture source|Could not find/i.test(this.stderrTail);
      // same app, any window — at once only for the first miss of a streak (later tries take one selector each: streakVariant)
      if (notFound && first && !this.failCount && this.variant < t.selectors.length - 1) { this.variant++; this.retryAt = 0; return; }
      // a GPU-scaled start died before its first frame: direct at the capture's own size, as before this scaling existed
      if (scaleTo && first && !notFound) { this.scaleFailed = true; this.retryAt = 0; return; }
      // straight-from-the-GPU died before its first frame (an ffmpeg / driver without D3D11 input to NVENC, a window wider
      // than H.264 allows …): the readback path from now on (until the next Restart feed), at once
      if (direct && first && !notFound) { this.directFailed = true; this.retryAt = 0; return; }
      if (this.wanted) {
        this.err = notFound
          ? `${t.label}: the window ${t.target} isn’t open (or is minimised). VTube Pro keeps looking every few seconds.`
          : `Capture stopped (ffmpeg exit ${code}): ${(this.stderrTail.split(/\r?\n/).filter((l) => /error|fail|invalid/i.test(l)).pop() ?? '').slice(0, 200)}`;
        this.streakVariant = notFound ? (this.variant + 1) % t.selectors.length : 0;
        this.target = null; this.variant = 0;                         // re-read OBS on the next try
        this.nativeSizes.delete(sel);                                 // (the window may come back at another size)
        // back off while it keeps failing (each try = an OBS request, a spawn on the helper's main loop, a D3D11 device +
        // NVENC session on the game's GPU); reset by the first picture, restart(), a setupKey() change, accept()
        this.failCount++; this.backoffKey = this.setupKey();
        this.retryAt = Date.now() + (this.deps.retry ?? retryDelayMs)(this.failCount, notFound);
      }
      for (const ws of this.rx.keys()) try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* */ }
    });
  }

  /** The size ffmpeg reports for this run (this.size), read before its first picture. A scaled run that did not get the
   *  size asked for: unscaled from now on (until restart()). An unscaled run of a window wider than maxWidth: its size is
   *  remembered and ffmpeg restarts once, scaled on the GPU (nothing was sent yet, so the pages see no hiccup). */
  private startScaleCheck(p: ChildProcess, sel: string, scaleTo: { w: number; h: number } | null, canScale: boolean, maxWidth: number) {
    if (this.proc !== p) return;
    if (scaleTo) {
      if (this.size.w !== scaleTo.w || this.size.h !== scaleTo.h) { this.scaleFailed = true; this.replaceFfmpeg(p); }
    } else if (canScale) {
      if (this.nativeSizes.size >= 16) this.nativeSizes.clear();
      this.nativeSizes.set(sel, { ...this.size });
      if (gpuScaleSize(maxWidth, this.size)) this.replaceFfmpeg(p);
    }
  }
  /** Stop this ffmpeg on purpose and start the next one at once (target + selector kept; no 'stop' to the pages). */
  private replaceFfmpeg(p: ChildProcess) {
    if (this.proc !== p) return;
    this.proc = null; this.cfg = null; this.gop = []; this.retryAt = 0;
    try { p.kill(); } catch { /* */ }
    void this.tick();
  }

  private emit(au: Buffer) {
    const types = nalTypes(au), key = types.has(5);
    if (key) {
      const codec = codecOf(au);
      if (codec && (!this.cfg || this.cfg.codec !== codec || this.cfg.width !== this.size.w)) {
        const t = this.target, loose = !!t && this.variant > 0 && t.selectors.length > 1;
        this.cfg = { type: 'config', codec, width: this.size.w, height: this.size.h, label: t ? `${t.label} → ${loose ? `${t.target.split(']')[0]}] (title changed: another window of that app)` : t.target}` : '', encoder: this.encoder };
        const j = JSON.stringify(this.cfg);
        for (const ws of this.rx.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(j);
      }
      this.gop = []; this.gopBytes = 0; this.gopWhole = true;
    }
    if (!this.cfg) return;                                            // nothing decodable before the first key frame
    const msg = Buffer.allocUnsafe(9 + au.length);
    msg[0] = key ? 1 : 0; msg.writeDoubleLE(Date.now(), 1); au.copy(msg, 9);
    if (this.gopWhole && this.gopBytes + msg.length <= (this.deps.gopMax ?? GOP_MAX_BYTES)) { this.gop.push(msg); this.gopBytes += msg.length; } else this.gopWhole = false;
    this.frames++; this.bytes += au.length;
    const now = Date.now();
    for (const ws of this.rx.keys()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const w = ws as FeedSocket;
      if (w._skip) {
        // a stalled page caught up: the picture again from the last key frame (this frame is the group's last), at once
        if (key) { if (ws.bufferedAmount < DRAINED_BYTES) { w._skip = false; ws.send(msg); } }
        else if (ws.bufferedAmount < DRAINED_BYTES && this.gopWhole) this.replay(ws);
        continue;
      }
      const burst = w._burst && now < w._burst.until ? w._burst.bytes : 0;
      if (ws.bufferedAmount > STALL_BYTES + burst) { w._skip = true; continue; }   // a stalled page: don't queue more
      ws.send(msg);
    }
  }

  stop() {
    const p = this.proc; this.proc = null; this.cfg = null; this.gop = []; this.target = null; this.variant = 0;
    if (p) { try { p.kill(); } catch { /* */ } }
  }

  status(): CaptureStatus {
    const ff = this.ff ?? ffCache?.ff ?? null;
    const search = this.deps.findFf ? null : ffSearch;                 // (what the real search looked at)
    const pick = ff ? pickEncoder(ff, !!this.settings.anyGpu) : null;
    const recv = [...this.rx.values()].filter((x): x is FeedRxStats => !!x);
    const running = !!this.proc && !!this.cfg;
    const fps = running ? this.rate.fps : 0;
    const age = recv.length ? Math.max(...recv.map((r) => r.ageMs + r.decodeMs)) : null;
    // capture (≈ ½ frame) + encode (≈ 5 ms) + transport/decode (measured by the pages) + the OBS page's frame (≈ 1 frame)
    const latency = running && age !== null && fps > 0 ? Math.round(500 / fps + 5 + age + 1000 / 60) : null;
    let state: CaptureStatus['state'], message: string;
    const decErr = recv.find((r) => r.error)?.error;
    // "connected but 0 fps": every page that gets the feed has shown no picture for a while (why, when a page says)
    const now = Date.now();
    const blind = noPicture([...this.rx.entries()].map(([ws, r]) => ({ stats: r, blindSince: this.blind.get(ws) })), now);
    const why = recv.find((r) => r.decErr)?.decErr;
    if (!WIN) { state = 'unavailable'; message = 'The fast window feed needs Windows.'; }
    else if (this.settings.source === 'off') { state = 'idle'; message = 'Fast window feed is off — in-scene capture uses a window shared from the studio (else NO SIGNAL).'; }
    else if (this.probed && !ff) { state = 'unavailable'; message = ffmpegMissingMessage(search); }
    else if (ff && !ff.gfxcapture) { state = 'unavailable'; message = `ffmpeg ${ff.version} at ${ff.path} is too old (no gfxcapture filter; FFmpeg 8.1 or newer needed): winget upgrade ffmpeg — VTube Pro finds the new one by itself within a minute (or press Find ffmpeg again).`; }
    else if (ff && !pick) { state = 'unavailable'; message = `ffmpeg ${ff.version} at ${ff.path} has no H.264 encoder (libx264 / NVENC) — install the full build: winget install ffmpeg (found by itself within a minute, or press Find ffmpeg again).`; }
    else if (decErr) { state = 'error'; message = `The OBS page can’t decode the feed (${decErr}) — using the studio share instead.`; }
    else if (this.problem) { state = problemState(this.problem); message = this.problem.problem; }
    else if (this.err && !running) { state = 'error'; message = this.err; }
    else if (this.proc && !running && Date.now() - this.startedAt > 4000) { state = 'error'; message = `Found ${this.target?.target ?? 'the window'} but it sends no picture — is it minimised? (Windows can capture a window hidden behind others, but not a minimised one.)`; }
    else if (running && blind) { state = 'error'; message = `Sending ${this.cfg!.label} at ${fps} fps, but the OBS page shows no picture${why ? ` — its video decoder keeps failing (${why})` : recv.every((r) => !r.rx) ? ' — no frames reach it' : ''}. Press Restart feed; if it keeps happening, restart OBS (its browser decodes the feed).`; }
    else if (running) { const cpu = cpuFeedNote(ff, pick); state = 'running'; message = `Showing ${this.cfg!.label} · ${this.size.w}×${this.size.h} · ${fps} fps${latency !== null ? ` · ≈ ${latency} ms` : ''} · ${this.encoder}${cpu ? ` · ${cpu}` : ''}${this.capped ? ` · ${this.capped}` : ''}${why ? ` · the OBS page’s decoder hiccuped (${why})` : ''}`; }
    else if (this.rx.size) { state = 'starting'; message = 'Starting the window feed…'; }
    else { state = 'idle'; message = `Ready — ${this.settings.source === 'obs' ? `follows OBS “${obs.cfg.captureSource || '?'}”` : 'uses the picked window'}; starts when an OBS page shows the react screen in React mode (Auto / In-scene).`; }
    return {
      settings: this.settings, state, message,
      label: this.target?.label ?? this.problem?.obsSource ?? '', obsSource: this.target?.obsSource ?? this.problem?.obsSource ?? (this.settings.source === 'obs' ? obs.cfg.captureSource || null : null), obsKind: this.target?.obsKind ?? this.problem?.obsKind ?? null,
      target: this.target?.target ?? null,
      ffmpeg: { path: ff?.path ?? null, version: ff?.version ?? null, gfxcapture: !!ff?.gfxcapture, encoder: pick === 'x264' ? 'x264 (CPU)' : pick?.label ?? null, gpuNote: ff?.gpuNote ?? null,
        gpuOptIn: pick === 'x264' ? ff?.gpus.find((g) => g.holdsFrame)?.label ?? null : null, note: savedGoneNote(search, ff) || null },
      width: this.size.w, height: this.size.h, fps, kbps: running ? this.rate.kbps : 0, receivers: recv, latencyMs: latency, error: this.err,
    };
  }

  /** Probe ffmpeg now (for the Scene tab), without starting a capture. */
  async probe() { if (!this.deps.findFf) ffCache = null; await this.lookFf(); }
  /** The first look at ffmpeg, on demand (the first GET /api/capture or the first page that wants the feed): a helper
   *  that never shows a window feed never runs ffmpeg (it used to run 4 ffmpeg probes, one a GPU encode, at every start).
   *  None / an unusable one: looked at again (at most every FF_RECHECK_MS, findFfmpeg's cache) — an ffmpeg installed or
   *  upgraded while the Scene tab is open shows up without a restart. */
  async ensureProbed() { if (!this.probed || !ffUsable(this.ff)) await this.lookFf(); }
  private probed = false;
  /** Searches started / the newest one whose result is in this.ff (lookFf). */
  private ffSeq = 0;
  private ffApplied = 0;
  /** Look for ffmpeg (findFf) and keep the result in this.ff - unless a search that started LATER has already finished:
   *  a GET /api/capture search for the old saved path that ends after a PUT changed the path and start() found the new
   *  one must not overwrite (null) it (review of the b10 ffmpeg lane: with the per-minute re-search this crashed the
   *  helper via an unhandled rejection in tick). Returns this search's own result. */
  private async lookFf(): Promise<Ffmpeg | null> {
    const seq = ++this.ffSeq;
    const ff = await this.findFf(this.settings.ffmpeg);
    if (seq > this.ffApplied) { this.ffApplied = seq; this.ff = ff; this.probed = true; }
    return ff;
  }
  /** The GPU encoder the feed uses (null: x264 on the CPU, or no usable encoder). */
  private gpu(): GpuEncoder | null { const p = this.ff ? pickEncoder(this.ff, !!this.settings.anyGpu) : null; return p && p !== 'x264' ? p : null; }

  dispose() { clearInterval(this.timer); this.stop(); for (const ws of this.rx.keys()) try { ws.terminate(); } catch { /* */ } }
}

export const screenFeed = new ScreenFeedServer();

export const captureRoutes = Router();
captureRoutes.get('/api/capture', async (req, res) => { requireLocal(req); await screenFeed.ensureProbed(); res.json(screenFeed.status()); });
captureRoutes.put('/api/capture', (req, res) => { requireLocal(req); screenFeed.update((req.body ?? {}) as Partial<CaptureSettings>); res.json(screenFeed.status()); });
captureRoutes.post('/api/capture/restart', async (req, res) => { requireLocal(req); await screenFeed.probe(); screenFeed.restart(); res.json(screenFeed.status()); });
captureRoutes.get('/api/capture/windows', async (req, res) => { requireLocal(req); res.json({ windows: await listWindows().catch(() => []) }); });
