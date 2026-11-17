// Install the optional ML rigging pack (SkinTokens) ON THE PERSON'S DEMAND, the way tools/gpu/gpu_setup.ts installs the GPU
// tracking runtime: idempotent steps, every download pinned to a commit / revision and checked against a sha256 before a byte
// of it is used, progress lines for the studio. Nothing here runs unless the person pressed the install button and accepted the
// notice (shared/rigMl.ts RIG_ML_NOTICE). It never runs in tests against the real catalogue: the unit test hands it a tiny
// fake catalogue served from localhost (tools/rigml_unit.ts).
//
//   npx tsx tools/gpu/rigml_setup.ts --model skintokens --accept [--dir <folder>] [--dry-run] [--json]
//   npx tsx tools/gpu/rigml_setup.ts --model skintokens --uninstall [--dir <folder>]
//
// Steps: gate (notice accepted) -> check (NVIDIA GPU, enough graphics memory, disk) -> code (zip, sha256,
// then unpacked by tools/gpu/safe_unzip.ts, which checks every entry first) -> weights (each file sha256) -> python (uv + its own venv, torch from
// pytorch.org, the project's requirements.txt minus its web-demo packages) -> pack.json.
// UNVERIFIED on this PC (no model downloads here): the python step follows the project's own README; see docs/AUTORIG_3D.md.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIG_ML, RIG_ML_NOTICE_VERSION, safePackPath, vramVerdict, type RigMlModel, type RigMlSpec } from '../../shared/rigMl.ts';
import { DEFAULT_DIR, checkGpu, type GpuCheck, type Progress } from './gpu_setup.ts';
import { unzipSafe } from './safe_unzip.ts';

export const RIGML_HOSTS = ['huggingface.co', 'codeload.github.com'];
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128';
const TORCH_PKGS = ['torch==2.7.0', 'torchvision==0.22.0'];
/** web-demo / training-only packages of the project's requirements.txt that the worker never needs (the less that is installed, the less that can go wrong) */
const SKIP_REQ = /^(gradio|bottle|tornado|wandb)\b/i;

export const rigMlDir = (dir = DEFAULT_DIR, model: RigMlModel) => path.join(dir, 'rigml', model);
export const rigMlPaths = (dir = DEFAULT_DIR, model: RigMlModel) => {
  const root = rigMlDir(dir, model);
  return { root, code: path.join(root, 'code'), venv: path.join(root, 'venv'), python: path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), downloads: path.join(root, 'downloads'), manifest: path.join(root, 'pack.json') };
};

export interface RigMlDeps {
  fetch: typeof fetch;
  checkGpu: (dir: string) => Promise<GpuCheck>;
  run: (cmd: string, args: string[], opt?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }) => Promise<{ code: number; out: string }>;
}
export interface RigMlSetupOpts {
  model: RigMlModel;
  dir?: string;
  /** The person accepted the notice (RIG_ML_NOTICE). Without it nothing is fetched. */
  accept?: boolean;
  dryRun?: boolean;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
  /** Tests: a different (tiny, local) catalogue entry, and fake network / process helpers. */
  spec?: RigMlSpec;
  deps?: Partial<RigMlDeps>;
  /** Tests: skip the python environment step. */
  skipPython?: boolean;
  /** Tests: accept http://127.0.0.1 URLs. */
  allowLocalhost?: boolean;
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await new Promise<void>((res, rej) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej));
  return h.digest('hex');
}

const sh: RigMlDeps['run'] = (cmd, args, opt = {}) => new Promise((res) => {
  const p = spawn(cmd, args, { cwd: opt.cwd, env: opt.env ?? process.env, windowsHide: true });
  let out = '';
  const keep = (b: Buffer) => { out += b.toString('utf8').replace(/\0/g, ''); if (out.length > 20000) out = out.slice(-20000); };
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  const to = opt.timeout ? setTimeout(() => p.kill(), opt.timeout) : null;
  p.on('error', (e) => { if (to) clearTimeout(to); res({ code: -1, out: String(e) }); });
  p.on('close', (code) => { if (to) clearTimeout(to); res({ code: code ?? -1, out }); });
});

/** Why a URL may not be fetched (null = fine): https only, and only the hosts the catalogue is pinned to. */
export function urlProblem(url: string, localhost = false): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'not a web address'; }
  if (localhost && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return null;
  if (u.protocol !== 'https:') return 'not https';
  if (!RIGML_HOSTS.includes(u.hostname)) return `host ${u.hostname} is not one the pack is pinned to`;
  return null;
}

/** Download to `<dst>.part`, check size + sha256, then rename. A finished file that already matches is kept (idempotent). */
export async function fetchChecked(f: { url: string; sha256: string; bytes: number }, dst: string, fetchFn: typeof fetch, onPct: (pct: number, mb: number) => void, signal?: AbortSignal, localhost = false): Promise<'cached' | 'downloaded'> {
  const bad = urlProblem(f.url, localhost);
  if (bad) throw new Error(`refused to fetch ${f.url}: ${bad}`);
  if (fs.existsSync(dst) && fs.statSync(dst).size === f.bytes && (await sha256File(dst)) === f.sha256) return 'cached';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await fetchFn(f.url, { redirect: 'follow', signal });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) ${path.basename(dst)}`);
  const tmp = `${dst}.part`, out = fs.createWriteStream(tmp), h = crypto.createHash('sha256');
  let got = 0, last = 0;
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (got > f.bytes + 1024) throw new Error(`${path.basename(dst)} is bigger than expected: the download was refused`);   // (a swapped file cannot fill the disk)
      h.update(chunk);
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 400) { last = Date.now(); onPct(got / f.bytes, got / 1e6); }
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    if (got !== f.bytes) throw new Error(`${path.basename(dst)} has ${got} bytes, expected ${f.bytes}: the download was damaged; try again`);
    if (h.digest('hex') !== f.sha256) throw new Error(`checksum mismatch for ${path.basename(dst)}: the download was damaged or changed; nothing was installed from it`);
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  fs.renameSync(tmp, dst);
  return 'downloaded';
}

export interface RigMlInstalled { model: RigMlModel; commit: string; installedAt: string; noticeVersion: number; files: { path: string; sha256: string }[] }

/** What is installed (no changes). Checks sizes, not hashes (those were checked when each file arrived). */
export function inspectRigMl(model: RigMlModel, dir = DEFAULT_DIR, spec: RigMlSpec = RIG_ML[model]): { installed: boolean; manifest: RigMlInstalled | null; missing: string[] } {
  const P = rigMlPaths(dir, model);
  let manifest: RigMlInstalled | null = null;
  try { manifest = JSON.parse(fs.readFileSync(P.manifest, 'utf8')) as RigMlInstalled; } catch { /* not installed */ }
  const missing = spec.files.filter((f) => { try { return fs.statSync(path.join(P.code, f.path)).size !== f.bytes; } catch { return true; } }).map((f) => f.path);
  if (!fs.existsSync(path.join(P.code, spec.code.entry))) missing.push(spec.code.entry);
  return { installed: !!manifest && manifest.commit === spec.code.commit && !missing.length, manifest, missing };
}

/** The `uv` tool the way tools/gpu/gpu_setup.ts finds it: the copy "Set up GPU tracking" installs (<dir>/uv/uv.exe), else one on PATH. null = none. */
export async function findUv(dir: string, run: RigMlDeps['run']): Promise<string | null> {
  for (const n of ['uv.exe', 'uv']) { const local = path.join(dir, 'uv', n); if (fs.existsSync(local)) return local; }
  return (await run('uv', ['--version'])).code === 0 ? 'uv' : null;
}
const NO_UV = 'uv (the Python installer tool) is not on this PC: run "Set up GPU tracking" once, which installs it, then try again. Nothing was downloaded.';

export async function runRigMlSetup(o: RigMlSetupOpts): Promise<boolean> {
  const spec = o.spec ?? RIG_ML[o.model];
  const dir = o.dir ?? DEFAULT_DIR, P = rigMlPaths(dir, o.model), dry = !!o.dryRun;
  const deps: RigMlDeps = { fetch: o.deps?.fetch ?? fetch, checkGpu: o.deps?.checkGpu ?? checkGpu, run: o.deps?.run ?? sh };
  const say = (step: string, state: Progress['state'], msg: string, pct?: number) => o.onProgress?.({ step, state, msg, pct });
  // ---- gate
  if (!o.accept) { say('gate', 'error', 'Read the notice first and accept it: nothing is downloaded until you do.'); return false; }
  for (const f of [{ path: spec.code.entry }, ...spec.files]) if (!safePackPath(f.path)) { say('gate', 'error', `The pack lists an unsafe path (${f.path}).`); return false; }
  // ---- check
  const g = await deps.checkGpu(dir);
  const v = vramVerdict(o.model, g.vramMB);
  // under the staged floor (or no NVIDIA card): nothing to install, the no-AI Blender skeleton rigs models on this PC instead
  if (!v.usable) { say('check', 'error', `${v.why} Nothing was downloaded.`); return false; }
  // between the floor and the authors' figure: installs, and rigging runs the low-memory staged mode by itself (slower)
  if (!v.ok) say('check', 'warn', v.why);
  const have = inspectRigMl(o.model, dir, spec);
  const need = have.installed ? 0 : Math.round(spec.diskGB * 1024);
  say('check', 'ok', `${g.name} · ${v.have} GB graphics memory · ${Math.round(g.freeMB / 1024)} GB free here, about ${(need / 1024).toFixed(1)} GB needed`);
  if (g.freeMB && g.freeMB < need + 500) { say('check', 'error', `Not enough disk space: about ${(need / 1024).toFixed(1)} GB needed, ${(g.freeMB / 1024).toFixed(1)} GB free.`); return false; }
  if (have.installed) { say('done', 'ok', `${spec.label} is already installed.`); return true; }
  // the Python installer tool is needed at the END of the install: look for it now, before gigabytes are downloaded
  let uv: string | null = null;
  if (!o.skipPython) {
    uv = await findUv(dir, deps.run);
    if (!uv) { say('python', dry ? 'warn' : 'error', NO_UV); if (!dry) return false; }
  }
  if (dry) {
    say('code', 'info', `would download ${spec.code.repo} at ${spec.code.commit.slice(0, 10)} (${(spec.code.bytes / 1e6).toFixed(0)} MB, sha256 checked)`);
    for (const f of spec.files) say('weights', 'info', `would download ${f.path} (${(f.bytes / 1e6).toFixed(1)} MB, sha256 ${f.sha256.slice(0, 12)}…)`);
    say('python', 'info', `would create ${P.venv} with Python 3.11, ${TORCH_PKGS.join(', ')} from ${TORCH_INDEX}, and the project's requirements`);
    say('done', 'ok', 'Dry run finished: nothing was changed.');
    return true;
  }
  fs.mkdirSync(P.root, { recursive: true });
  const note = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    // ---- code
    const zip = path.join(P.downloads, 'code.zip');
    say('code', 'run', 'Downloading the project code…', 0);
    await fetchChecked(spec.code, zip, deps.fetch, (pct, mb) => say('code', 'run', `Downloading the project code (${mb.toFixed(0)} MB)…`, pct * 0.08), o.signal, o.allowLocalhost);
    const stage = path.join(P.downloads, 'unpack');
    fs.rmSync(stage, { recursive: true, force: true });
    unzipSafe(zip, stage);          // refuses ../ paths, links, bombs and a wrong checksum before anything lands outside the folder
    const top = fs.readdirSync(stage).filter((n) => fs.statSync(path.join(stage, n)).isDirectory());
    if (top.length !== 1) throw new Error('the code archive has an unexpected layout');
    fs.rmSync(P.code, { recursive: true, force: true });
    fs.renameSync(path.join(stage, top[0]), P.code);
    fs.rmSync(zip, { force: true });
    say('code', 'ok', `Project code ${spec.code.commit.slice(0, 10)} ready (${spec.code.license})`);
    // ---- weights
    for (let i = 0; i < spec.files.length; i++) {
      const f = spec.files[i];
      await fetchChecked(f, path.join(P.code, f.path), deps.fetch, (pct, mb) => say('weights', 'run', `Downloading ${path.basename(f.path)} (${mb.toFixed(0)} MB)…`, 0.08 + 0.6 * ((i + pct) / spec.files.length)), o.signal, o.allowLocalhost);
    }
    say('weights', 'ok', `${spec.files.length} files downloaded and checked`);
    // ---- python
    if (!o.skipPython) await pythonEnv(P, deps, uv!, say, o.signal);
    // ---- manifest
    const manifest: RigMlInstalled = { model: o.model, commit: spec.code.commit, installedAt: new Date().toISOString(), noticeVersion: RIG_ML_NOTICE_VERSION, files: spec.files.map((f) => ({ path: f.path, sha256: f.sha256 })) };
    fs.writeFileSync(P.manifest, JSON.stringify(manifest, null, 1));
    fs.rmSync(P.downloads, { recursive: true, force: true });
    say('done', 'ok', `${spec.label} is ready.`);
    return true;
  } catch (e) {
    say('error', 'error', `${note(e)} Finished files are kept; press install again to continue.`);
    return false;
  }
}

async function pythonEnv(P: ReturnType<typeof rigMlPaths>, deps: RigMlDeps, uv: string, say: (s: string, st: Progress['state'], m: string, p?: number) => void, signal?: AbortSignal) {
  void signal;
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(P.root, 'python'), UV_CACHE_DIR: path.join(P.root, 'uv-cache') };
  say('python', 'run', 'Creating the Python 3.11 environment…', 0.7);
  let r = await deps.run(uv, ['venv', '--python', '3.11', P.venv], { env });
  if (r.code !== 0) throw new Error(`venv failed: ${r.out.slice(-300)}`);
  say('python', 'run', 'Installing PyTorch (about 3 GB, a few minutes)…', 0.75);
  r = await deps.run(uv, ['pip', 'install', '--python', P.python, ...TORCH_PKGS, '--index-url', TORCH_INDEX], { env, timeout: 40 * 60_000 });
  if (r.code !== 0) throw new Error(`PyTorch install failed: ${r.out.slice(-300)}`);
  const reqFile = path.join(P.code, 'requirements.txt');
  const lines = fs.readFileSync(reqFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !SKIP_REQ.test(s));
  const filtered = path.join(P.root, 'requirements.filtered.txt');
  fs.writeFileSync(filtered, lines.join('\n') + '\n');
  say('python', 'run', 'Installing the project’s packages…', 0.85);
  r = await deps.run(uv, ['pip', 'install', '--python', P.python, '-r', filtered], { env, timeout: 40 * 60_000 });
  if (r.code !== 0) throw new Error(`package install failed: ${r.out.slice(-400)}`);
  // flash-attn is a speed-up that needs a compiler on Windows: try it, never fail the install over it
  const fa = await deps.run(uv, ['pip', 'install', '--python', P.python, 'flash-attn', '--no-build-isolation'], { env, timeout: 30 * 60_000 });
  say('python', fa.code === 0 ? 'ok' : 'warn', fa.code === 0 ? 'Python environment ready (with flash-attn)' : 'Python environment ready (flash-attn could not be built; it runs a little slower without)', 0.95);
  fs.rmSync(path.join(P.root, 'uv-cache'), { recursive: true, force: true });
}

export function uninstallRigMl(model: RigMlModel, dir = DEFAULT_DIR, onProgress?: (p: Progress) => void): boolean {
  const P = rigMlPaths(dir, model);
  const base = path.resolve(dir, 'rigml');
  const root = path.resolve(P.root);
  // only ever remove our own pack folder: inside <dir>/rigml, named after the model, and carrying our manifest or marker
  if (path.dirname(root) !== base || path.basename(root) !== model) { onProgress?.({ step: 'uninstall', state: 'error', msg: 'Refused: not a pack folder.' }); return false; }
  if (!fs.existsSync(root)) { onProgress?.({ step: 'uninstall', state: 'skip', msg: 'Nothing to remove.' }); return true; }
  fs.rmSync(root, { recursive: true, force: true });
  onProgress?.({ step: 'uninstall', state: 'ok', msg: `Removed ${root}.` });
  return true;
}

// ---- command line
if (process.argv[1] && /rigml_setup\.[cm]?[tj]s$/.test(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const model = (arg('--model') ?? 'skintokens') as RigMlModel;
  const json = a.includes('--json');
  const log = (p: Progress) => console.log(json ? JSON.stringify(p) : `[${p.state}] ${p.step}: ${p.msg}${p.pct !== undefined ? ` (${Math.round(p.pct * 100)} %)` : ''}`);
  const dir = arg('--dir') ?? DEFAULT_DIR;
  if (!(model in RIG_ML)) { console.error(`unknown model ${model}`); process.exit(1); }
  if (a.includes('--uninstall')) process.exit(uninstallRigMl(model, dir, log) ? 0 : 1);
  runRigMlSetup({ model, dir, accept: a.includes('--accept'), dryRun: a.includes('--dry-run'), onProgress: log })
    .then((ok) => process.exit(ok ? 0 : 1))
    .catch((e) => { log({ step: 'error', state: 'error', msg: String((e as Error).message ?? e) }); process.exit(1); });
}
