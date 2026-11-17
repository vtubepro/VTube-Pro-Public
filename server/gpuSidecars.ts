// GPU tracking sidecars (docs/GPU_TRACKING.md): small local Python processes the studio talks to over localhost
// websockets. The server starts / supervises / stops them (the studio page connects directly):
//   a2f     NVIDIA Audio2Face-3D lip sync   tools/gpu/a2f_sidecar.py                   ws://127.0.0.1:5197/a2f
//   rtmw    RTMW whole-body pose (133 kpts) tools/gpu/vision_sidecar.py --feature rtmw   ws://127.0.0.1:5198/rtmw
//   maxine  NVIDIA Maxine AR face expr.     tools/gpu/vision_sidecar.py --feature maxine ws://127.0.0.1:5199/maxine
//           (needs NVIDIA's AR SDK runtime installed by the user — not redistributed)
// Supervision: a sidecar that is WANTED (turned on) and exits is restarted (1 s, 2 s, 4 s … 30 s back-off); every exit
// is kept with its time, code and reason (GET /api/gpu/status → <name>.exits) so the UI / diagnostics can say why.
// Only processes this server started are ever stopped (by the child handle), and they die with the server.
//   GET  /api/gpu/status          { a2f, rtmw, maxine, python, gpu, have, setup, choice, live }
//   POST /api/gpu/:name  {on, why, user}  start / stop one sidecar (why: who asked, kept in the log; user: a click / the owner's own
//                                 "Turn on"). The Audio2Face sidecar is refused on a card that can't run it, while OBS is streaming /
//                                 recording, and when nobody asked: not a user click and no saved "accepted" (a2fStartDecision). With OBS not
//                                 linked / not answering (live null) even an accepted start waits for the owner's click: only a live reading taken
//                                 at that moment saying "idle" authorises an automatic start, nothing is cached (answer: needsClick)
//   POST /api/gpu/a2f/choice {choice: accepted|declined}   the owner's answer, kept in config/gpu.json (local studio only)
//   POST /api/gpu/setup  {parts, dryRun} · POST /api/gpu/setup/cancel · POST /api/gpu/uninstall   (tools/gpu/gpu_setup.ts)
import { Router } from 'express';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './paths.ts';
import { runOffLoop, spawnStreaming, type StreamingChild } from './spawnOffLoop.ts';
import { classifyGpu, type A2fSupport } from '../shared/gpuClass.ts';
import { readA2fChoice, writeA2fChoice } from './gpuChoice.ts';
import { requireLocalPage } from './partyVault.ts';
import { ALL_PARTS, DEFAULT_DIR, MAXINE_DIR, runSetup, uninstall, type Part, type Progress } from '../tools/gpu/gpu_setup.ts';

interface Def { script: string; port: number; args?: string[] }
const DEFS: Record<string, Def> = {
  a2f: { script: 'tools/gpu/a2f_sidecar.py', port: 5197 },
  rtmw: { script: 'tools/gpu/vision_sidecar.py', port: 5198, args: ['--feature', 'rtmw'] },
  maxine: { script: 'tools/gpu/vision_sidecar.py', port: 5199, args: ['--feature', 'maxine'] },
};
interface Exit { at: string; code: number | null; reason: string }
interface State { proc: StreamingChild | null; log: string[]; error: string; startedAt: number; exit: number | null; wanted: boolean; restarts: number; timer: ReturnType<typeof setTimeout> | null; exits: Exit[]; stopping: boolean }
const st: Record<string, State> = {};
for (const k of Object.keys(DEFS)) st[k] = { proc: null, log: [], error: '', startedAt: 0, exit: null, wanted: false, restarts: 0, timer: null, exits: [], stopping: false };

const la = () => process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
/** GPU folders in priority order: VTP_GPU_DIR / <repo>\.gpu (what the in-app setup makes) / %LOCALAPPDATA%\VTubePro\gpu (older) */
const gpuDirs = () => [DEFAULT_DIR, path.join(la(), 'VTubePro', 'gpu')];
const firstExisting = (ps: string[]) => ps.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
export function gpuPython(): string {
  if (process.env.VTP_GPU_PYTHON) return process.env.VTP_GPU_PYTHON;
  return firstExisting(gpuDirs().map((d) => path.join(d, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))) ?? 'python';
}
const a2fModelDir = () => firstExisting([path.join(ROOT, 'tools', 'vendor', 'audio2face3d_claire'), ...gpuDirs().map((d) => path.join(d, 'models', 'audio2face3d_claire'))].map((d) => path.join(d, 'network.onnx')));
const rtmwModel = () => process.env.VTP_RTMW_MODEL ?? firstExisting(gpuDirs().map((d) => path.join(d, 'models', 'rtmw', 'end2end.onnx')));

const portOpen = (port: number) => new Promise<boolean>((res) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (v: boolean) => { s.destroy(); res(v); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(400, () => done(false));
});

function note(s: State, code: number | null, reason: string) {
  s.exits.push({ at: new Date().toISOString(), code, reason });
  if (s.exits.length > 12) s.exits.shift();
}

/** Test seams: the live signal and the card (the server wires the real ones). */
export const gpuHooks: { live: () => Promise<boolean | null>; gpu: () => Promise<{ a2f: A2fSupport }> } = {
  /** true = OBS is streaming / recording; false = OBS says it is idle; null = can't tell (no OBS link). Same signal as the updater's "never mid-stream". */
  live: async () => {
    try {
      const [{ obs }, { outputPages }] = await Promise.all([import('./obs.ts'), import('./bus.ts')]);
      return outputPages().count > 0 || obs.cfg.enabled ? await obs.outputActive() : null;
    } catch { return null; }
  },
  gpu: () => detectGpu(),
};

/** The live signal, read FRESH at the moment of every decision. Nothing is cached: an "idle" reading from a minute ago says nothing about now
 *  (the stream may have started since, with OBS unreachable at this moment), so only a reading taken right now that says idle can start a GPU job. */
const liveNow = (): Promise<boolean | null> => gpuHooks.live();

/** May the Audio2Face sidecar be started now? Pure (tools/gpu_a2f_gate_unit.ts). `needsClick`: only the owner's own click may start it
 *  (the studio shows "GPU lip sync is ready - Start"): an accepted owner whose live state is unknown and was never seen idle. */
export function a2fStartDecision(o: { a2f: A2fSupport; live: boolean | null; user: boolean; accepted: boolean }): { ok: true } | { ok: false; status: number; error: string; needsClick?: true } {
  if (o.a2f === 'none') return { ok: false, status: 409, error: "This graphics card can't run GPU lip sync (the browser lip sync is used)." };
  if (o.live === true) return { ok: false, status: 409, error: 'You are live right now: GPU lip sync starts after the stream (it never starts a GPU job mid-stream).' };
  if (o.user) return { ok: true };
  if (!o.accepted) return { ok: false, status: 403, error: 'GPU lip sync starts only when you turn it on (Tracking -> GPU lip sync).' };
  // accepted: only a reading taken now that explicitly says idle starts it; unknown (OBS not linked / not answering) never does, whatever was seen before
  if (o.live === false) return { ok: true };
  return { ok: false, status: 403, needsClick: true, error: "GPU lip sync is ready. VTube Pro can't tell whether you are live, so it starts when you press Start." };
}

async function start(name: string, why = ''): Promise<void> {
  const d = DEFS[name], s = st[name];
  s.wanted = true;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.proc && s.exit === null) return;
  // someone (the user, a previous server) already runs it on that port: use it, don't start a second one
  if (await portOpen(d.port)) { s.error = ''; return; }
  const script = path.join(ROOT, d.script);
  if (!fs.existsSync(script)) { s.error = `${d.script} missing`; return; }
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' };
  const am = a2fModelDir(); if (am) env.VTP_A2F_MODEL_DIR = path.dirname(am);
  const rm = rtmwModel(); if (rm) env.VTP_RTMW_MODEL = rm;
  s.log = []; s.error = ''; s.exit = null; s.startedAt = Date.now(); s.stopping = false;
  s.log.push(`[server] start ${new Date().toISOString()}${why ? ` (${why})` : ''}${s.restarts ? `, restart #${s.restarts}` : ''}`);
  // onnxruntime writes some warnings as UTF-16: drop the NULs, keep readable lines only
  const keep = (b: Buffer) => { for (const l of b.toString('utf8').replace(/\0/g, '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) if (l.trim().length > 2) { s.log.push(l.slice(0, 400)); if (s.log.length > 40) s.log.shift(); } };
  // Started on a worker thread (server/spawnOffLoop.ts): on Windows the start itself holds the event loop for 60-250 ms,
  // and this loop relays the tracking frames to OBS. Normal priority, as before; stop() kills by pid from this thread.
  const p: StreamingChild = spawnStreaming(gpuPython(), ['-u', script, '--port', String(d.port), '--parent-pid', String(process.pid), ...(d.args ?? [])], {
    cwd: ROOT, env, onStdout: keep, onStderr: keep,
    onError: (msg) => { s.error = `could not start Python (${gpuPython()}): ${msg}. Use "Set up GPU tracking".`; s.exit = -1; },
    onExit: (code, signal) => {
      s.exit = code ?? -1; if (s.proc === p) s.proc = null;
      const reason = s.stopping ? 'stopped (turned off)' : code === 3 ? 'NVIDIA AR SDK not installed' : code === 0 ? 'exited (server gone / clean exit)'
        : (s.log.filter((l) => /error|Error|No module|not found|Traceback|failed/.test(l)).slice(-2).join(' · ') || `crashed (code ${code ?? signal})`);
      note(s, code, reason);
      if (!s.stopping) s.error = reason;
      // supervisor: still wanted → restart with back-off (not for a missing SDK / model: that needs the setup)
      if (s.wanted && !s.stopping && code !== 3) {
        const wait = Math.min(30000, 1000 * 2 ** Math.min(5, s.restarts));
        s.restarts++;
        s.timer = setTimeout(() => { s.timer = null; if (s.wanted) void start(name, 'auto-restart'); }, wait);
      }
    },
  });
  s.proc = p;
  // a clean run for a minute resets the back-off
  setTimeout(() => { if (s.proc === p && s.exit === null) s.restarts = 0; }, 60000);
}

function stop(name: string, why = '') {
  const s = st[name];
  s.wanted = false;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.proc && s.exit === null) { s.stopping = true; s.log.push(`[server] stop ${new Date().toISOString()}${why ? ` (${why})` : ''}`); try { s.proc.kill(); } catch { /* gone */ } }
  s.proc = null;
}

async function status(name: string) {
  const d = DEFS[name], s = st[name];
  const up = await portOpen(d.port);
  return { running: up, ours: !!(s.proc && s.exit === null), wanted: s.wanted, restarts: s.restarts, port: d.port, url: `ws://127.0.0.1:${d.port}/${name}`, error: up ? '' : s.error,
    starting: !up && ((!!s.proc && s.exit === null && Date.now() - s.startedAt < 60000) || !!s.timer), log: s.log.slice(-8), exits: s.exits.slice(-5) };
}

/** The GPU (nvidia-smi), cached: RTX 50-series (Blackwell) is the only generation these features were built and measured for;
 *  `a2f` says whether Audio2Face lip sync is measured / untested (RTX 20-40) / not offered on this card (shared/gpuClass.ts). */
type GpuInfo = { name: string; vramMB: number; driver: string; rtx50: boolean; nvidia: boolean; series: number | null; a2f: A2fSupport; note: string };
let gpuInfo: GpuInfo | null = null;
/** A failed / timed-out nvidia-smi is NOT kept for the helper's life (a busy driver at start would hide an RTX 50 card until a restart, and A2F starts would
 *  get 409): the "no answer" is remembered for GPU_RETRY_MS only, then asked again. One query at a time. */
const GPU_RETRY_MS = 30000;
let gpuFail: { at: number; info: GpuInfo } | null = null;
let gpuPending: Promise<GpuInfo> | null = null;
/** Test seams (tools/gpu_a2f_gate_unit.ts): the process runner and the clock. The probe runs off the event loop (server/spawnOffLoop.ts). */
type ProbeRun = { stdout: Buffer | string; error?: string; code: number | null; timedOut: boolean };
export const gpuProbe = { run: runOffLoop as (exe: string, args: string[], o: { timeoutMs: number }) => Promise<ProbeRun>, now: () => Date.now(), reset() { gpuInfo = null; gpuFail = null; gpuPending = null; } };
export function detectGpu(): Promise<GpuInfo> {
  if (gpuInfo) return Promise.resolve(gpuInfo);
  if (gpuFail && gpuProbe.now() - gpuFail.at < GPU_RETRY_MS) return Promise.resolve(gpuFail.info);
  if (gpuPending) return gpuPending;
  gpuPending = new Promise<GpuInfo>((res) => {
    const failed: ProbeRun = { stdout: '', error: 'failed', code: null, timedOut: false };
    void gpuProbe.run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeoutMs: 4000 }).catch(() => failed).then((r) => {
      const err = !!r.error || r.timedOut || r.code !== 0, out = r.stdout;
      const [name = '', mem = '0', driver = ''] = err ? [] : String(out).trim().split('\n')[0].split(',').map((x) => x.trim());
      const c = classifyGpu(name, Number(mem) || 0);
      const info: GpuInfo = { name, vramMB: Number(mem) || 0, driver, nvidia: !!name, rtx50: c.rtx50, series: c.series, a2f: c.a2f, note: c.note };
      if (err || !name) gpuFail = { at: gpuProbe.now(), info }; else { gpuInfo = info; gpuFail = null; }
      gpuPending = null;
      res(info);
    });
  });
  return gpuPending;
}
/** What is installed (file checks only): also read by the capability report (server/capability.ts). */
export function prereqs() {
  return { a2fModel: !!a2fModelDir(), rtmwModel: !!rtmwModel(), maxineSdk: fs.existsSync(path.join(process.env.VTP_MAXINE_DIR ?? MAXINE_DIR, 'nvARPose.dll')), venv: gpuPython() !== 'python', dir: DEFAULT_DIR };
}

// ---- in-app setup (one job at a time)
const setup = { running: false, steps: [] as Progress[], ok: null as boolean | null, abort: null as AbortController | null, startedAt: 0 };
function setupPush(p: Progress) {
  const i = setup.steps.findIndex((x) => x.step === p.step);
  if (i >= 0 && p.step !== 'done') setup.steps[i] = p; else setup.steps.push(p);
}

export const gpuRoutes = Router();
gpuRoutes.get('/api/gpu/status', async (_req, res) => {
  const out: Record<string, unknown> = { python: gpuPython(), gpu: await detectGpu(), have: prereqs(), setup: { running: setup.running, ok: setup.ok, steps: setup.steps },
    choice: readA2fChoice() ?? null, live: await liveNow() };
  for (const k of Object.keys(DEFS)) out[k] = await status(k);
  res.json(out);
});
gpuRoutes.post('/api/gpu/setup', (req, res) => {
  if (setup.running) { res.json({ running: true }); return; }
  const parts = (Array.isArray(req.body?.parts) ? req.body.parts : ALL_PARTS).filter((p: string) => (ALL_PARTS as string[]).includes(p)) as Part[];
  Object.assign(setup, { running: true, steps: [], ok: null, abort: new AbortController(), startedAt: Date.now() });
  runSetup({ parts, dryRun: !!req.body?.dryRun, onProgress: setupPush, signal: setup.abort!.signal })
    .then((ok) => { setup.ok = ok; })
    .catch((e) => { setup.ok = false; setupPush({ step: 'error', state: 'error', msg: `${(e as Error).message ?? e} — press "Set up GPU tracking" to retry (finished parts are kept).` }); })
    .finally(() => { setup.running = false; setup.abort = null; });
  res.json({ running: true });
});
gpuRoutes.post('/api/gpu/setup/cancel', (_req, res) => { setup.abort?.abort(); res.json({ ok: true }); });
gpuRoutes.post('/api/gpu/uninstall', (_req, res) => {
  if (setup.running) { res.status(409).json({ error: 'setup is running' }); return; }
  for (const k of Object.keys(DEFS)) stop(k, 'uninstall');
  setup.steps = [];
  setTimeout(() => { try { uninstall(DEFAULT_DIR, setupPush); } catch (e) { setupPush({ step: 'uninstall', state: 'error', msg: String(e) }); } }, 1500);
  res.json({ ok: true, dir: DEFAULT_DIR });
});
gpuRoutes.post('/api/gpu/a2f/choice', (req, res) => {
  requireLocalPage(req);
  const c = req.body?.choice;
  if (c !== 'accepted' && c !== 'declined') { res.status(400).json({ error: 'choice must be "accepted" or "declined"' }); return; }
  writeA2fChoice(c);
  if (c === 'declined') stop('a2f', 'declined');
  res.json({ choice: c });
});
gpuRoutes.post('/api/gpu/:name', async (req, res) => {
  const name = String(req.params.name);
  if (!DEFS[name]) { res.status(404).json({ error: 'unknown sidecar' }); return; }
  const why = String(req.body?.why ?? '').slice(0, 80);
  if (name === 'a2f' && req.body?.on) {
    const live = await liveNow();
    const d = a2fStartDecision({ a2f: (await gpuHooks.gpu()).a2f, live, user: req.body?.user === true, accepted: readA2fChoice() === 'accepted' });
    if (!d.ok) { res.status(d.status).json({ ...(await status(name)), error: d.error, refused: true, ...(d.needsClick ? { needsClick: true } : {}) }); return; }
  }
  if (req.body?.on) await start(name, why); else stop(name, why);
  res.json(await status(name));
});

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) process.once(sig, () => { for (const k of Object.keys(DEFS)) stop(k, 'server exit'); if (sig !== 'exit') process.exit(0); });
