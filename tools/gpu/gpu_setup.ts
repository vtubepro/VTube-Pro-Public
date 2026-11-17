// One-click GPU tracking setup (docs/GPU_TRACKING.md) — the ONE implementation used by the app's "Set up GPU
// tracking" button (server/gpuSidecars.ts imports it) and by the command line / setup.ps1 -Gpu:
//
//   npx tsx tools/gpu/gpu_setup.ts [--parts runtime,a2f,rtmw,maxine] [--dir <folder>] [--dry-run] [--json] [--yes]
//   npx tsx tools/gpu/gpu_setup.ts --uninstall [--dir <folder>]          (removes the folder; Maxine stays: its own uninstaller)
//
// Needs nothing but Node (the app's own). Steps (idempotent: each one checks first and skips what is already right):
//   check    NVIDIA GPU + driver (nvidia-smi): RTX 50-series, driver >= 580 (CUDA 13), free disk space
//   uv       Astral's uv (official GitHub release, sha256 checked) unless one is on PATH — it fetches Python 3.12
//   runtime  <dir>\venv: Python 3.12 + onnxruntime-gpu 1.30 (CUDA 13 + cuDNN 9 as pip wheels) + numpy, websockets,
//            opencv-python-headless, psutil; then an import + CUDA provider check
//   a2f      NVIDIA Audio2Face-3D v2.3.1 Claire from huggingface.co/nvidia (NVIDIA Open Model License), sha256 per file
//            (skipped when tools/vendor/audio2face3d_claire is complete)
//   rtmw     RTMW-x ONNX from download.openmmlab.com, sha256 checked, on the user's click (code Apache-2.0; the weights were
//            trained on InterHand2.6M / Human-Art, research-licensed datasets: shared/gpuLicence.ts RTMW_NOTE)
//   maxine   NVIDIA AR SDK 0.8.7 for RTX 50 from NVIDIA's own URL (sha256 checked; never bundled — NVIDIA Maxine EULA),
//            then NVIDIA's installer is STARTED for the user (Windows asks for admin permission; the user clicks
//            through NVIDIA's licence) and the result is verified
// Default folder: <repo>\.gpu (not %LOCALAPPDATA%: packaged apps see a private copy of AppData, so a venv made from
// one could be invisible to a server started from START.bat). Override: --dir or VTP_GPU_DIR.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGpu } from '../../shared/gpuClass.ts';
import { RTMW_NEEDS_RTX50 } from '../../shared/gpuLicence.ts';

// The VTube Pro folder: the nearest folder upwards whose package.json is "vtube-pro". Not a fixed '../..': inside the
// bundled helper (dist-helper/index.mjs, one level deep) that would point OUTSIDE the install folder (release-crossos).
function findRepo(start: string): string {
  for (let d = start, i = 0; i < 5; i++) {
    try { if (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'vtube-pro') return d; } catch { /* keep looking */ }
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  return path.resolve(start, '..', '..');
}
export const REPO = findRepo(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = process.env.VTP_GPU_DIR || path.join(REPO, '.gpu');
export type Part = 'runtime' | 'a2f' | 'rtmw' | 'maxine';
export const ALL_PARTS: Part[] = ['runtime', 'a2f', 'rtmw', 'maxine'];
export interface Progress { step: string; state: 'run' | 'ok' | 'skip' | 'warn' | 'error' | 'info'; msg: string; pct?: number }
export interface SetupOpts { dir?: string; parts?: Part[]; dryRun?: boolean; onProgress?: (p: Progress) => void; signal?: AbortSignal }

/** What this PC's graphics card allows (pure: tools/gpu_licence_unit.ts). Only an NVIDIA RTX 50-series card gets everything: RTMW and
 *  Maxine need one (the only cards they were built and measured on; no owner switch, no environment variable). Any other PC skips
 *  those with a plain notice and keeps the rest: GPU lip sync on an RTX 20 / 30 / 40 card (untested there, shared/gpuClass.ts), and
 *  MediaPipe's own tracking everywhere. No NVIDIA card at all: GPU tracking cannot run, said plainly. */
export function planParts(parts: Part[], g: Pick<GpuCheck, 'nvidia' | 'rtx50' | 'name' | 'vramMB'>): { parts: Part[]; messages: { state: Progress['state']; msg: string }[]; error: boolean } {
  const messages: { state: Progress['state']; msg: string }[] = [];
  const wantsRtmw = parts.includes('rtmw');
  const notice = wantsRtmw ? ` ${RTMW_NEEDS_RTX50}` : '';
  if (!g.nvidia) {
    messages.push({ state: 'error', msg: `No NVIDIA GPU found (nvidia-smi). GPU tracking requires an NVIDIA RTX 50-series GPU.${notice}` });
    return { parts, messages, error: true };
  }
  if (g.rtx50) return { parts, messages, error: false };
  const c = classifyGpu(g.name, g.vramMB);
  const lip = parts.filter((p) => p === 'runtime' || p === 'a2f');
  if (c.a2f !== 'untested' || !lip.includes('a2f')) {
    messages.push({ state: 'error', msg: `GPU tracking requires an NVIDIA RTX 50-series GPU (tested on RTX 5090); GPU lip sync also runs on an RTX 20 / 30 / 40 card (not tested there). This PC has: ${g.name}.${notice}` });
    return { parts, messages, error: true };
  }
  if (lip.length < parts.length) messages.push({ state: 'warn', msg: `Only GPU lip sync is set up on ${g.name}: the body / face camera features need an RTX 50-series card.${notice}` });
  messages.push({ state: 'warn', msg: c.note });
  return { parts: lip, messages, error: false };
}

const UV_VER = '0.12.19';
const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VER}/uv-x86_64-pc-windows-msvc.zip`;
const PKGS = ['onnxruntime-gpu[cuda,cudnn]==1.30.0', 'numpy', 'websockets', 'opencv-python-headless', 'psutil'];
const HF = 'https://huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire/resolve/a46eafb067adfdd7cc8f5c7941586b309004561c/';
export const A2F_FILES: Record<string, string> = {
  'network.onnx': '6bb7a3a3c22491960e71a14742891e0d7205d7c80414aebe326cad82fd6867c3',
  'model_data.npz': '4c2205365533790add8219170b9505960e31d2fca82708f2e3db31c5ccf092a4',
  'bs_skin.npz': 'cc94a937af9438f007b811b3f686015d7e96fc0ce964974905e130724ff1c4db',
  'bs_tongue.npz': '82032cb3a4f08d1f6e543ce80e8d9587aca8394b8cc009384ef21db19a90450e',
  'implicit_emo_db.npz': '562ee9fac5eded20753eb40230519a7304156c177f52d9aa44580d5cf57c0447',
  'a2f_ms_config.json': '380f87208cd683bc0fa8d03387b9b8b0c30706c07e5e878fbfc18f21e9858336',
  'bs_skin_config.json': '8580023e66336320e3802efe5c9be8a72fd5aa6162561d27225a056565345e4c',
  'bs_tongue_config.json': '9ef4d5ee664cb0975624de11b689b374c69d74b99126297ac4bdd58b9470a750',
  'model.json': '1a03fc1c3b1978e9c73c197c4fe5af90da63f1c7d65cb85750035f60608fe1fd',
  'model_config.json': '8d0da080d3960177f920b5aa1734da86715d9ed2c307e6245c12525f2066b800',
  'network_info.json': '41b49f603139c2b52f395793480cc830685634cc94955bbad80121787a36fc21',
  'trt_info.json': 'b288b5bba1e9eb0a1c49db0d3e182203d303c3ff26b8a6a284a3879b01758d0a',
  'README.md': '17385721f7940e3e4d4d2e266a54ace3aff5dadea8518334135d05a716cb3518',
};
const RTMW_URL = 'https://download.openmmlab.com/mmpose/v1/projects/rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.zip';
const RTMW_SHA = 'a87e1af41a0a067776dba7d46e1c21c8f6e9f18e247e0e606718dd1f31e96ffd';
export const MAXINE_URL = 'https://international.download.nvidia.com/Windows/broadcast/sdk/AR/nvidia_ar_sdk_installer_v0.8.7_blackwell.exe';
/** sha256 of NVIDIA's download (2026-09-27; also = the copy the user downloaded) */
const MAXINE_SHA = 'db73b7259efb57736651d26a643e7982132b734b63d9376cdbdd1ee3df7a847c';
const MAXINE_BYTES = 1347983656;
export const MAXINE_DIR = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVIDIA AR SDK');
/** disk space each part needs (MB, measured on the dev PC; downloads are deleted after unpacking except Maxine's) */
export const SIZES_MB: Record<Part, number> = { runtime: 2100, a2f: 310, rtmw: 450, maxine: 1350 + 2200 };
export const MINUTES: Record<Part, string> = { runtime: '2–6', a2f: '1–3', rtmw: '1–2', maxine: '3–8 (+ NVIDIA\u2019s installer)' };

export const paths = (dir = DEFAULT_DIR) => ({
  dir, venv: path.join(dir, 'venv'), python: path.join(dir, 'venv', 'Scripts', 'python.exe'), uvDir: path.join(dir, 'uv'),
  a2f: path.join(dir, 'models', 'audio2face3d_claire'), rtmw: path.join(dir, 'models', 'rtmw', 'end2end.onnx'), downloads: path.join(dir, 'downloads'),
});

const sh = (cmd: string, args: string[], opt: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  new Promise<{ code: number; out: string }>((res) => {
    const p = spawn(cmd, args, { cwd: opt.cwd, env: opt.env ?? process.env, windowsHide: true });
    let out = '';
    const keep = (b: Buffer) => { out += b.toString('utf8').replace(/\0/g, ''); if (out.length > 20000) out = out.slice(-20000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const to = opt.timeout ? setTimeout(() => p.kill(), opt.timeout) : null;
    p.on('error', (e) => { if (to) clearTimeout(to); res({ code: -1, out: String(e) }); });
    p.on('close', (code) => { if (to) clearTimeout(to); res({ code: code ?? -1, out }); });
  });

export async function sha256(file: string) {
  const h = crypto.createHash('sha256');
  await new Promise<void>((res, rej) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej));
  return h.digest('hex');
}

async function download(url: string, dst: string, sha: string | null, p: (pct: number, mb: number) => void, signal?: AbortSignal) {
  if (fs.existsSync(dst) && sha && (await sha256(dst)) === sha) return 'cached';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await fetch(url, { redirect: 'follow', signal });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = dst + '.part', out = fs.createWriteStream(tmp), h = crypto.createHash('sha256');
  let got = 0, last = 0;
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    h.update(chunk); got += chunk.length;
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    if (Date.now() - last > 400) { last = Date.now(); p(total ? got / total : 0, got / 1e6); }
  }
  await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  const got256 = h.digest('hex');
  if (sha && got256 !== sha) { fs.rmSync(tmp, { force: true }); throw new Error(`checksum mismatch for ${path.basename(dst)} — the download was damaged or changed; try again`); }
  fs.renameSync(tmp, dst);
  return 'downloaded';
}

export interface GpuCheck { name: string; driver: string; vramMB: number; rtx50: boolean; driverOk: boolean; freeMB: number; nvidia: boolean }
export function checkGpu(dir = DEFAULT_DIR): Promise<GpuCheck> {
  return new Promise((res) => {
    execFile('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (err, out) => {
      const [name = '', driver = '', mem = '0'] = err ? [] : String(out).trim().split('\n')[0].split(',').map((s) => s.trim());
      let freeMB = 0;
      try { let d = dir; while (!fs.existsSync(d)) d = path.dirname(d); const s = fs.statfsSync(d); freeMB = Math.round((s.bavail * s.bsize) / 1e6); } catch { /* unknown */ }
      res({ name, driver, vramMB: Number(mem) || 0, nvidia: !!name, rtx50: classifyGpu(name, Number(mem) || 0).rtx50, driverOk: Number(driver.split('.')[0]) >= 580, freeMB });
    });
  });
}

async function findUv(P: ReturnType<typeof paths>) {
  const local = path.join(P.uvDir, 'uv.exe');
  if (fs.existsSync(local)) return local;
  const r = await sh('uv', ['--version']);
  return r.code === 0 ? 'uv' : null;
}

/** What is installed (no changes). */
export async function inspect(dir = DEFAULT_DIR) {
  const P = paths(dir);
  const vendor = path.join(REPO, 'tools', 'vendor', 'audio2face3d_claire');
  const a2fAt = [vendor, P.a2f].find((d) => Object.keys(A2F_FILES).filter((f) => f !== 'README.md').every((f) => fs.existsSync(path.join(d, f)))) ?? null;
  return { dir, runtime: fs.existsSync(P.python), a2f: a2fAt, rtmw: fs.existsSync(P.rtmw) ? P.rtmw : null, maxine: fs.existsSync(path.join(MAXINE_DIR, 'nvARPose.dll')) ? MAXINE_DIR : null };
}

export async function runSetup(o: SetupOpts = {}) {
  const P = paths(o.dir ?? DEFAULT_DIR), dry = !!o.dryRun;
  let parts = o.parts ?? ALL_PARTS;
  const say = (step: string, state: Progress['state'], msg: string, pct?: number) => o.onProgress?.({ step, state, msg, pct });
  const have = await inspect(P.dir);
  // ---- check
  const g = await checkGpu(P.dir);
  const plan = planParts(parts, g);
  for (const m of plan.messages) say('check', m.state, m.msg);
  if (plan.error) return false;
  parts = plan.parts;
  if (!g.driverOk) { say('check', 'error', `NVIDIA driver ${g.driver} is too old: 580 or newer is needed (CUDA 13). Update it in the NVIDIA App, then try again.`); return false; }
  const need = parts.reduce((s, p) => s + ((p === 'runtime' && have.runtime) || (p === 'a2f' && have.a2f) || (p === 'rtmw' && have.rtmw) || (p === 'maxine' && have.maxine) ? 0 : SIZES_MB[p]), 0);
  say('check', 'ok', `${g.name} · driver ${g.driver} · ${Math.round(g.vramMB / 1024)} GB VRAM · ${Math.round(g.freeMB / 1024)} GB free here, about ${(need / 1024).toFixed(1)} GB needed`);
  if (g.freeMB && g.freeMB < need + 500) { say('check', 'error', `Not enough disk space: about ${(need / 1024).toFixed(1)} GB needed, ${(g.freeMB / 1024).toFixed(1)} GB free on the drive of ${P.dir}.`); return false; }
  if (!dry) fs.mkdirSync(P.dir, { recursive: true });
  let ok = true;
  // ---- runtime
  if (parts.includes('runtime')) {
    if (have.runtime) say('runtime', 'skip', 'Python GPU runtime already there');
    else if (dry) say('runtime', 'info', `would: get uv ${UV_VER} if missing, create ${P.venv} (Python 3.12), install ${PKGS.join(', ')} (~2.1 GB)`);
    else {
      let uv = await findUv(P);
      if (!uv) {
        say('runtime', 'run', 'Downloading the Python installer tool (uv, 18 MB)…');
        const sha = (await (await fetch(UV_URL + '.sha256')).text()).trim().split(/\s+/)[0];
        const zip = path.join(P.downloads, 'uv.zip');
        await download(UV_URL, zip, sha, (x) => say('runtime', 'run', 'Downloading uv…', x * 0.1), o.signal);
        fs.mkdirSync(P.uvDir, { recursive: true });
        const r = await sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${P.uvDir}'`]);
        if (r.code !== 0) throw new Error('could not unpack uv: ' + r.out.slice(-300));
        uv = path.join(P.uvDir, 'uv.exe'); fs.rmSync(zip, { force: true });
      }
      const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(P.dir, 'python'), UV_CACHE_DIR: path.join(P.dir, 'uv-cache') };
      say('runtime', 'run', 'Creating the Python 3.12 environment…', 0.15);
      let r = await sh(uv, ['venv', '--python', '3.12', P.venv], { env });
      if (r.code !== 0) throw new Error('venv failed: ' + r.out.slice(-400));
      say('runtime', 'run', 'Installing onnxruntime-gpu + CUDA / cuDNN libraries (about 2 GB, a few minutes)…', 0.3);
      r = await sh(uv, ['pip', 'install', '--python', P.python, ...PKGS], { env });
      if (r.code !== 0) throw new Error('package install failed: ' + r.out.slice(-600));
      fs.rmSync(path.join(P.dir, 'uv-cache'), { recursive: true, force: true });
    }
    if (!dry) {
      const r = await sh(P.python, ['-c', 'import onnxruntime as o; o.preload_dlls(); p=o.get_available_providers(); print(o.__version__, "CUDA" if "CUDAExecutionProvider" in p else "NO-CUDA")']);
      if (r.code === 0 && r.out.includes(' CUDA')) say('runtime', 'ok', `GPU runtime works (onnxruntime ${r.out.trim().split(/\s+/).slice(-2)[0]})`);
      else { ok = false; say('runtime', 'error', `The GPU runtime does not load CUDA: ${r.out.slice(-300)}`); }
    }
  }
  // ---- models
  if (parts.includes('a2f')) {
    if (have.a2f) say('a2f', 'skip', `Audio2Face-3D model already there (${have.a2f})`);
    else if (dry) say('a2f', 'info', `would download ${Object.keys(A2F_FILES).length} files (~307 MB) from huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire into ${P.a2f}`);
    else {
      const files = Object.entries(A2F_FILES);
      for (let i = 0; i < files.length; i++) {
        const [f, sha] = files[i];
        await download(HF + f, path.join(P.a2f, f), sha, (x, mb) => say('a2f', 'run', `Downloading Audio2Face-3D (${f}, ${mb.toFixed(0)} MB)…`, (i + x) / files.length), o.signal);
      }
      say('a2f', 'ok', 'Audio2Face-3D model ready (NVIDIA Open Model License)');
    }
  }
  if (parts.includes('rtmw')) {
    if (have.rtmw) say('rtmw', 'skip', 'RTMW model already there');
    else if (dry) say('rtmw', 'info', `would download ${RTMW_URL} (213 MB) and unpack end2end.onnx into ${path.dirname(P.rtmw)}`);
    else {
      const zip = path.join(P.downloads, 'rtmw.zip');
      await download(RTMW_URL, zip, RTMW_SHA, (x, mb) => say('rtmw', 'run', `Downloading RTMW (${mb.toFixed(0)} / 213 MB)…`, x), o.signal);
      const tmp = path.join(P.downloads, 'rtmw_unzip');
      const r = await sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${tmp}'`]);
      if (r.code !== 0) throw new Error('could not unpack RTMW: ' + r.out.slice(-300));
      const found = (function walk(d: string): string | null { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) { const x = walk(q); if (x) return x; } else if (e.name === 'end2end.onnx') return q; } return null; })(tmp);
      if (!found) throw new Error('RTMW zip has no end2end.onnx');
      fs.mkdirSync(path.dirname(P.rtmw), { recursive: true });
      for (const f of ['end2end.onnx', 'pipeline.json', 'deploy.json', 'detail.json']) { const s = path.join(path.dirname(found), f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(path.dirname(P.rtmw), f)); }
      fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true });
      say('rtmw', 'ok', 'RTMW model ready (OpenMMLab; trained on research-licensed datasets, see THIRD_PARTY_NOTICES.md)');
    }
  }
  // ---- Maxine (NVIDIA's own installer, started for the user)
  if (parts.includes('maxine')) {
    if (have.maxine) say('maxine', 'skip', `NVIDIA AR SDK already installed (${MAXINE_DIR})`);
    else if (dry) say('maxine', 'info', `would download NVIDIA's installer (1.35 GB) from ${MAXINE_URL}, check it, and start it (Windows asks for admin permission; you accept NVIDIA's licence)`);
    else {
      const exe = path.join(P.downloads, path.basename(MAXINE_URL));
      await download(MAXINE_URL, exe, MAXINE_SHA, (x, mb) => say('maxine', 'run', `Downloading NVIDIA AR SDK (${mb.toFixed(0)} / ${(MAXINE_BYTES / 1e6).toFixed(0)} MB)…`, x * 0.8), o.signal);
      say('maxine', 'run', 'NVIDIA\u2019s installer is starting: click "Yes" when Windows asks for permission, then follow NVIDIA\u2019s steps (their licence). Waiting for it to finish…', 0.85);
      const r = await sh('powershell', ['-NoProfile', '-Command', `$p = Start-Process -FilePath '${exe}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`]);
      if (fs.existsSync(path.join(MAXINE_DIR, 'nvARPose.dll'))) say('maxine', 'ok', 'NVIDIA AR SDK installed');
      else { ok = false; say('maxine', 'error', r.code !== 0 && /canceled|cancelled|1223/i.test(r.out) ? 'The installer was cancelled (no admin permission). Try again when ready.' : `NVIDIA AR SDK not found after the installer (exit ${r.code}). Run ${exe} yourself, then press Check again.`); }
    }
  }
  say('done', ok ? 'ok' : 'warn', ok ? (dry ? 'Dry run finished — nothing was changed.' : 'GPU tracking is set up. Turn the features on below.') : 'Finished with problems — see the steps above.');
  return ok;
}

export function uninstall(dir = DEFAULT_DIR, onProgress?: (p: Progress) => void) {
  const P = paths(dir);
  if (fs.existsSync(P.dir)) fs.rmSync(P.dir, { recursive: true, force: true });
  onProgress?.({ step: 'uninstall', state: 'ok', msg: `Removed ${P.dir} (Python runtime, models, downloads). NVIDIA AR SDK: uninstall it from Windows Settings → Apps if you want it gone.` });
}

// ---- command line
// The file-name test matters: bundled into dist-helper/index.mjs, import.meta.url IS argv[1], and without it every
// helper start ran the full GPU setup (uv + Python + onnxruntime-gpu + models downloads). release-crossos, 2026-10-01.
if (process.argv[1] && /gpu_setup\.[cm]?[tj]s$/.test(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const json = a.includes('--json');
  const log = (p: Progress) => console.log(json ? JSON.stringify(p) : `[${p.state}] ${p.step}: ${p.msg}${p.pct !== undefined ? ` (${Math.round(p.pct * 100)} %)` : ''}`);
  const dir = arg('--dir') ?? DEFAULT_DIR;
  if (a.includes('--uninstall')) { uninstall(dir, log); process.exit(0); }
  if (a.includes('--status')) { void Promise.all([inspect(dir), checkGpu(dir)]).then(([i, g]) => { console.log(JSON.stringify({ ...i, gpu: g }, null, 1)); process.exit(0); }); }
  else {
  const parts = (arg('--parts')?.split(',') as Part[] | undefined) ?? ALL_PARTS;
  runSetup({ dir, parts, dryRun: a.includes('--dry-run'), onProgress: log })
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { log({ step: 'error', state: 'error', msg: String((e as Error).message ?? e) }); process.exit(1); });
  }
}
