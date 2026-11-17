// Pro2D → 3D "3D toolkit" (lane to3d): the helper's OWN Python for the Live2D→3D pipeline, never the system Python and
// never Blender's. One consent, then headless:
//   1. uv (Astral) from its GitHub release, sha256-pinned per OS / arch (below), unpacked into <kit>/uv;
//   2. a uv-managed CPython 3.12 into <kit>/python, a venv in <kit>/venv;
//   3. numpy, scipy, opencv-python-headless, Pillow from PyPI with --require-hashes --only-binary :all:
//      (blender/to3d/requirements.txt: every wheel's sha256), then an import check;
//   4. the uv download cache is deleted. About 350 MB on disk.
// No base bodies are downloaded: the pipeline starts from the bundled Mirelle / Kairo avatars (bases.ts). Source installs
// may point VTP_TO3D_PYTHON at a Python that already has the four packages (developers; never written by the app).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from '../paths.ts';
import { KIT_DIR } from './store.ts';

export const UV_VERSION = '0.12.23';
/** sha256 + size of each uv release archive (GitHub release 0.12.23, 2026-10-03; checked against the .sha256 sidecars) */
export const UV_PINS: Record<string, { file: string; sha256: string; bytes: number }> = {
  'win32-x64': { file: 'uv-x86_64-pc-windows-msvc.zip', sha256: '75d05de6762778c31ee183398de7dd15093fad0ed90b1f236d8205ea5ec00c90', bytes: 18_043_715 },
  'win32-arm64': { file: 'uv-aarch64-pc-windows-msvc.zip', sha256: '13294e232ececbe709c06b74e6ced06f2a225ea5591476685362f22be56a50d5', bytes: 19_113_421 },
  'darwin-x64': { file: 'uv-x86_64-apple-darwin.tar.gz', sha256: '960da44cb4b73685206ddd250b19e0a117fa41095710c1038f081f5cb613efb4', bytes: 21_263_712 },
  'darwin-arm64': { file: 'uv-aarch64-apple-darwin.tar.gz', sha256: '50487ae565ccd96e499056b4674d438f4c53170202617b4c759defe0c6a1b544', bytes: 17_044_217 },
  'linux-x64': { file: 'uv-x86_64-unknown-linux-gnu.tar.gz', sha256: '9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6', bytes: 19_906_150 },
  'linux-arm64': { file: 'uv-aarch64-unknown-linux-gnu.tar.gz', sha256: '6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f', bytes: 18_965_616 },
};
export const uvUrl = (file: string) => `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${file}`;
export const PYTHON = '3.12';
export const KIT_SIZE_MB = 350;
export const REQUIREMENTS = path.join(ROOT, 'blender', 'to3d', 'requirements.txt');
const KIT_STAMP = 'kit.json';

export interface KitDeps {
  platform: NodeJS.Platform; arch: string; env: NodeJS.ProcessEnv; dir: string;
  fetch: typeof fetch;
  run: (cmd: string, args: string[], o?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<{ code: number; out: string }>;
  /** tests: other pins */
  pins?: typeof UV_PINS;
}

/** idle: the lowest CPU class (IDLE on Windows), the one the pipeline's Blender runs use */
export function realRun(cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; idle?: boolean } = {}) {
  return new Promise<{ code: number; out: string }>((res) => {
    let out = '';
    const p = spawn(cmd, args, { env: o.env ?? process.env, windowsHide: true });
    try { if (p.pid) os.setPriority(p.pid, o.idle ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* fine */ }
    const keep = (b: Buffer) => { out = (out + b.toString('utf8')).slice(-20000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const t = o.timeoutMs ? setTimeout(() => p.kill(), o.timeoutMs) : null;
    p.on('error', (e) => { if (t) clearTimeout(t); res({ code: -1, out: String(e) }); });
    p.on('close', (c) => { if (t) clearTimeout(t); res({ code: c ?? -1, out }); });
  });
}
export const realKitDeps = (): KitDeps => ({ platform: process.platform, arch: process.arch, env: process.env, dir: KIT_DIR, fetch: globalThis.fetch.bind(globalThis), run: realRun });

const win = (d: Pick<KitDeps, 'platform'>) => d.platform === 'win32';
export const kitPaths = (d: Pick<KitDeps, 'dir' | 'platform'>) => ({
  dir: d.dir, uvDir: path.join(d.dir, 'uv'), uv: path.join(d.dir, 'uv', win(d) ? 'uv.exe' : 'uv'), uvx: path.join(d.dir, 'uv', win(d) ? 'uvx.exe' : 'uvx'),
  python: path.join(d.dir, 'venv', win(d) ? 'Scripts' : 'bin', win(d) ? 'python.exe' : 'python'),
  venv: path.join(d.dir, 'venv'), pyHome: path.join(d.dir, 'python'), cache: path.join(d.dir, 'uv-cache'), downloads: path.join(d.dir, 'downloads'),
  stamp: path.join(d.dir, KIT_STAMP), userBases: path.join(d.dir, 'user-bases'),
});

export interface KitStatus { ready: boolean; python: string | null; uvx: string | null; dev: boolean; installing: boolean; error: string | null; step: string | null; pct: number }
let state: { installing: boolean; error: string | null; step: string | null; pct: number } = { installing: false, error: null, step: null, pct: 0 };
/** "Get uv" alone (the Blender MCP row): about 20 MB into <kit>/uv, the same files the toolkit uses later. */
let uvState: { installing: boolean; error: string | null } = { installing: false, error: null };
export const uvInstallState = () => ({ ...uvState });

/** Smaller than this is not a real uv / uvx (a 0-byte file from an interrupted unpack, a stub): treated as absent. */
export const MIN_EXE_BYTES = 4096;
/** A regular file big enough to be a real program (symlinks followed). */
export function usableExe(f: string): boolean { try { const st = fs.statSync(f); return st.isFile() && st.size >= MIN_EXE_BYTES; } catch { return false; } }

/** The stamp the last finished install wrote (null = none, or unreadable: an interrupted install). */
function readStamp(f: string): { python?: string; uv?: string } | null {
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return j && typeof j === 'object' ? j : null; } catch { return null; }
}
/** A stamp from a toolkit built for another Python can't run the pipeline's pinned packages: it needs a fresh install. */
const stampOk = (st: { python?: string } | null) => !!st && st.python === PYTHON;

/** The Python the pipeline runs with (null = the toolkit isn't there). */
export function kitPython(d: Pick<KitDeps, 'dir' | 'platform' | 'env'> = realKitDeps()): { python: string; dev: boolean } | null {
  const dev = d.env.VTP_TO3D_PYTHON;
  if (dev) return { python: dev, dev: true };
  const P = kitPaths(d);
  return fs.existsSync(P.python) && stampOk(readStamp(P.stamp)) ? { python: P.python, dev: false } : null;
}

/** What is in the toolkit folder, for "Where we looked" (an interrupted install leaves some of it). */
export function kitDetail(d: Pick<KitDeps, 'dir' | 'platform' | 'env'> = realKitDeps()) {
  const P = kitPaths(d);
  const st = readStamp(P.stamp);
  const stamp: 'ok' | 'old' | 'damaged' | 'none' = fs.existsSync(P.stamp) ? (stampOk(st) ? 'ok' : st ? 'old' : 'damaged') : 'none';
  return { dir: P.dir, uv: usableExe(P.uv), uvx: usableExe(P.uvx), python: fs.existsSync(P.python), pythonPath: P.python, stamp };
}

/** The helper's own uvx (absolute: apps started from a menu don't see PATH), or a dev override. */
export function kitUvx(d: Pick<KitDeps, 'dir' | 'platform' | 'env'> = realKitDeps()): string | null {
  if (d.env.VTP_TO3D_UVX) return d.env.VTP_TO3D_UVX;
  const P = kitPaths(d);
  return usableExe(P.uvx) ? P.uvx : null;
}

export function kitStatus(d: Pick<KitDeps, 'dir' | 'platform' | 'env'> = realKitDeps()): KitStatus {
  const py = kitPython(d);
  return { ready: !!py, python: py?.python ?? null, uvx: kitUvx(d), dev: !!py?.dev, ...state };
}

/** What the consent sheet lists for the toolkit (host, size). */
export function kitPlan(d: Pick<KitDeps, 'platform' | 'arch'> = realKitDeps()) {
  const pin = UV_PINS[`${d.platform}-${d.arch}`];
  return [
    { what: `uv ${UV_VERSION} (installs Python and the packages)`, from: 'github.com/astral-sh/uv', mb: pin ? Math.round(pin.bytes / 1e6) : 20 },
    { what: `Python ${PYTHON}`, from: 'github.com/astral-sh/python-build-standalone (through uv)', mb: 40 },
    { what: 'numpy, scipy, OpenCV (headless), Pillow', from: 'pypi.org (every file checked against its pinned sha256)', mb: 290 },
  ];
}

async function sha256File(f: string) {
  const h = crypto.createHash('sha256');
  await new Promise<void>((res, rej) => fs.createReadStream(f).on('data', (x) => h.update(x)).on('end', () => res()).on('error', rej));
  return h.digest('hex');
}

async function download(d: KitDeps, url: string, dst: string, sha: string) {
  if (fs.existsSync(dst) && (await sha256File(dst)) === sha) return;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await d.fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`the download didn't start (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  if (got !== sha) throw new Error('a download was damaged or changed (its checksum is wrong); try again');
  fs.writeFileSync(dst, buf);
}

/** The toolkit's own uv + uvx (both: an interrupted unpack that left only uv.exe is unpacked again). One at a time:
 *  "Get uv" and "Get the 3D toolkit" pressed together share the same download. */
let uvRun: Promise<void> | null = null;
export function ensureUv(d: KitDeps, step: (s: string, p: number) => void = () => {}): Promise<void> {
  const P = kitPaths(d);
  if (usableExe(P.uv) && usableExe(P.uvx)) return Promise.resolve();
  uvRun ??= (async () => {
    const pin = (d.pins ?? UV_PINS)[`${d.platform}-${d.arch}`];
    if (!pin) throw new Error(`this computer (${d.platform} ${d.arch}) isn't supported yet`);
    fs.mkdirSync(P.dir, { recursive: true });
    step('Downloading uv', 0.05);
    const arc = path.join(P.downloads, pin.file);
    await download(d, uvUrl(pin.file), arc, pin.sha256);
    fs.mkdirSync(P.uvDir, { recursive: true });
    step('Unpacking uv', 0.12);
    // bsdtar (Windows 10+: System32\tar.exe by full path, a stale PATH can't hide it; macOS) and GNU tar both unpack
    // .zip / .tar.gz; the archive's top folder is dropped
    const root = d.env.SystemRoot || d.env.SYSTEMROOT;
    const sysTar = root ? path.join(root, 'System32', 'tar.exe') : '';
    const tar = d.platform === 'win32' && sysTar && fs.existsSync(sysTar) ? sysTar : 'tar';
    const r = await d.run(tar, ['-xf', arc, '-C', P.uvDir, ...(pin.file.endsWith('.zip') ? [] : ['--strip-components=1'])]);
    if (r.code !== 0 || !usableExe(P.uv) || !usableExe(P.uvx)) throw new Error('uv could not be unpacked');
    fs.rmSync(arc, { force: true });
  })().finally(() => { uvRun = null; });
  return uvRun;
}

/** "Get uv" (the Blender MCP row): only uv, about 20 MB. Only after the user's consent. Never throws: the error is kept. */
export async function installUv(d: KitDeps = realKitDeps()): Promise<{ ok: boolean; error: string | null }> {
  uvState = { installing: true, error: null };
  try { await ensureUv(d); uvState = { installing: false, error: null }; }
  catch (e) { uvState = { installing: false, error: plainInstallError(e, 'uv', d.dir) }; }
  return { ok: !uvState.error, error: uvState.error };
}

/** One plain sentence for a failed download / install, ending with the exact next step. */
export function plainInstallError(e: unknown, what: 'uv' | 'the 3D toolkit', dir: string): string {
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string } } | null;
  const code = err?.code ?? err?.cause?.code ?? '';
  const msg = String(err?.message ?? e ?? '');
  const all = `${code} ${msg} ${err?.cause?.message ?? ''}`;
  const again = 'then press Try again.';
  if (code === 'ENOSPC' || /no space|disk.*full/i.test(all)) return `Your disk is full. Free up about ${what === 'uv' ? 50 : KIT_SIZE_MB + 100} MB, ${again}`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || /access is denied|operation not permitted|permission denied/i.test(all)) return `Your computer blocked VTube Pro from writing to ${dir} (often an antivirus). Allow VTube Pro there, ${again}`;
  if (/^fetch failed$/i.test(msg) || /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|getaddrinfo|network|certificate/i.test(all)) return `We couldn't reach the download site. Check your internet connection (or let VTube Pro through your firewall), ${again}`;
  const st = /didn't start \((\d+)\)/.exec(msg);
  if (st) return `The download site said no (error ${st[1]}). Wait a minute, ${again}`;
  if (/checksum/i.test(msg)) return 'The download arrived damaged (its checksum was wrong), so we didn\'t use it. Press Try again.';
  if (/could not be unpacked/i.test(msg)) return 'uv downloaded but couldn\'t be unpacked. Press Try again, or get uv yourself from its maker and press Check again.';
  if (/isn't supported yet/.test(msg)) return `${msg[0].toUpperCase()}${msg.slice(1)}. Get uv yourself from its maker, then press Check again.`;
  const m = msg.replace(/[.\s]+$/, '') || 'Something went wrong';
  return `${m[0].toUpperCase()}${m.slice(1)}. Press Try again; if it keeps failing, open "Where we looked" below and send it to support.`;
}

/** Install the toolkit. Only after the user's consent (routes check the token). Idempotent. */
export async function installKit(d: KitDeps = realKitDeps(), say: (step: string, pct: number) => void = () => {}): Promise<KitStatus> {
  if (state.installing) return kitStatus(d);
  const P = kitPaths(d);
  const step = (s: string, p: number) => { state = { ...state, step: s, pct: p }; say(s, p); };
  state = { installing: true, error: null, step: 'Starting', pct: 0 };
  try {
    fs.mkdirSync(P.dir, { recursive: true });
    await ensureUv(d, step);
    const env = { ...d.env, UV_PYTHON_INSTALL_DIR: P.pyHome, UV_CACHE_DIR: P.cache, UV_NO_CONFIG: '1', UV_PYTHON_PREFERENCE: 'only-managed' };
    step(`Installing Python ${PYTHON}`, 0.2);
    let r = await d.run(P.uv, ['venv', '--python', PYTHON, '--allow-existing', P.venv], { env, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error('Python could not be installed: ' + tail(r.out));
    step('Installing numpy, scipy, OpenCV, Pillow', 0.45);
    r = await d.run(P.uv, ['pip', 'install', '--python', P.python, '--require-hashes', '--only-binary', ':all:', '-r', REQUIREMENTS], { env, timeoutMs: 30 * 60_000 });
    if (r.code !== 0) throw new Error('the packages could not be installed: ' + tail(r.out));
    step('Checking', 0.9);
    r = await d.run(P.python, ['-c', 'import numpy, scipy, cv2, PIL; print("TO3D_KIT_OK", numpy.__version__, scipy.__version__, cv2.__version__, PIL.__version__)'], { env });
    if (r.code !== 0 || !r.out.includes('TO3D_KIT_OK')) throw new Error('the packages installed but do not load: ' + tail(r.out));
    fs.writeFileSync(P.stamp, JSON.stringify({ at: Date.now(), uv: UV_VERSION, python: PYTHON, check: r.out.trim().split('\n').pop() }));
    fs.rmSync(P.cache, { recursive: true, force: true });
    state = { installing: false, error: null, step: 'Ready', pct: 1 };
  } catch (e) {
    state = { installing: false, error: plainInstallError(e, 'the 3D toolkit', d.dir), step: null, pct: 0 };
  }
  return kitStatus(d);
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300);

/** Tests: reset the in-memory install state. */
export function resetKitState() { state = { installing: false, error: null, step: null, pct: 0 }; uvState = { installing: false, error: null }; }
