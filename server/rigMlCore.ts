// The optional ML rigging pack, the part that needs no web server and no library (so tools/rigml_unit.ts can test it): the worker
// process runner, the status, the gates a job passes before it starts. server/rigMl.ts has the routes on top of it.
// (shared/rigMl.ts has the catalogue, tools/gpu/rigml_setup.ts installs it, tools/gpu/rigml_worker.py runs the model.)
// The pack is offered to every user (install on their click, after the first-use note). A card under a model's figure runs the
// low-memory STAGED mode on its own; a card under the staged floor (or none) gets the Blender templates (shared/rigMl.ts rigPlan).
// A running job only ever starts the worker with a mesh path; it never installs anything.
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { NOTE_TEXT, RIG_ML, RIG_ML_MODELS, RIG_ML_NOTICE, RIG_ML_NOTICE_VERSION, rigPlan, suggestModel, vramVerdict, type RigMlModel, type RigMlSpec, type RigPlan } from '../shared/rigMl.ts';
import { DEFAULT_DIR, checkGpu } from '../tools/gpu/gpu_setup.ts';
import { inspectRigMl, rigMlPaths } from '../tools/gpu/rigml_setup.ts';
import { ROOT } from './paths.ts';

// ---------------------------------------------------------------- the worker process

export interface WorkerEvent { event: string; pct?: number; msg?: string; output?: string; seconds?: number; model?: string }

/** One line of the worker's stdout -> an event (anything that is not our JSON is ignored). */
export function parseWorkerLine(line: string): WorkerEvent | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (typeof o.event !== 'string') return null;
    return {
      event: o.event.slice(0, 20),
      ...(typeof o.pct === 'number' && Number.isFinite(o.pct) ? { pct: Math.min(1, Math.max(0, o.pct)) } : {}),
      ...(typeof o.msg === 'string' ? { msg: o.msg.slice(0, 400) } : {}),
      ...(typeof o.output === 'string' ? { output: o.output } : {}),
      ...(typeof o.seconds === 'number' ? { seconds: o.seconds } : {}),
      ...(typeof o.model === 'string' ? { model: o.model.slice(0, 20) } : {}),
    };
  } catch { return null; }
}

export class WorkerError extends Error {
  constructor(message: string, readonly code: number | null) { super(message); }
}

export interface RunWorkerOpts {
  python: string;
  script: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  onEvent: (e: WorkerEvent) => void;
  signal?: AbortSignal;
  /** Tests: another spawn. */
  spawnFn?: typeof spawn;
}

/** Run the worker to the end. Resolves with the path of the rigged file; rejects with a WorkerError whose message is plain words. */
export function runWorker(o: RunWorkerOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    const p: ChildProcess = (o.spawnFn ?? spawn)(o.python, ['-u', o.script, ...o.args], { cwd: o.cwd, env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', ...o.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', lastErr = '', buf = '', done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); fn(); };
    const kill = () => { try { p.kill(); } catch { /* gone */ } };
    const timer = setTimeout(() => { kill(); finish(() => reject(new WorkerError('The model took too long and was stopped.', null))); }, o.timeoutMs);
    const onAbort = () => { kill(); finish(() => reject(new WorkerError('Cancelled.', null))); };
    o.signal?.addEventListener('abort', onAbort);
    const onLine = (line: string) => {
      const e = parseWorkerLine(line);
      if (!e) { if (line.trim()) lastErr = line.trim().slice(0, 300); return; }
      if (e.event === 'done' && e.output) output = e.output;
      if (e.event === 'error' && e.msg) lastErr = e.msg;
      o.onEvent(e);
    };
    p.stdout?.on('data', (b: Buffer) => { buf += b.toString('utf8'); const lines = buf.split(/\r?\n/); buf = lines.pop() ?? ''; lines.forEach(onLine); });
    p.stderr?.on('data', (b: Buffer) => { const t = b.toString('utf8').trim().split(/\r?\n/).pop(); if (t) lastErr = t.slice(0, 300); });
    p.on('error', (e) => finish(() => reject(new WorkerError(`Could not start the model (${e.message}).`, null))));
    p.on('close', (code) => {
      if (buf.trim()) onLine(buf);
      finish(() => {
        if (code === 0 && output) resolve(output);
        else if (code === 3) reject(new WorkerError(lastErr || 'The ML pack is not installed.', code));
        else if (code === 4) reject(new WorkerError(lastErr || 'The model ran out of graphics memory. “Skeleton for anything” (Blender) works on any card.', code));
        else reject(new WorkerError(lastErr || `The model stopped (code ${code}).`, code));
      });
    });
  });
}

// ---------------------------------------------------------------- state

export interface GpuProbe { name: string; vramMB: number }
export type GpuProbeFn = () => Promise<GpuProbe>;
export const probeGpu: GpuProbeFn = async () => { const g = await checkGpu(DEFAULT_DIR); return { name: g.name, vramMB: g.vramMB }; };

export type Catalog = Readonly<Record<RigMlModel, RigMlSpec>>;

export async function rigMlStatus(probe: GpuProbeFn = probeGpu, dir = DEFAULT_DIR, catalog: Catalog = RIG_ML) {
  const gpu = await probe();
  const models = RIG_ML_MODELS.map((id) => {
    const s = catalog[id], v = vramVerdict(id, gpu.vramMB), have = inspectRigMl(id, dir, s);
    return {
      id, label: s.label, summary: s.summary, minVramGB: s.minVramGB, stagedFloorGB: v.floor,
      // normal = full speed; staged = works by itself in the low-memory mode (slower); templates = the no-AI Blender skeleton is used
      tier: v.tier, fits: v.ok, usable: v.usable, minutes: v.minutes, why: v.why, installed: have.installed,
      notes: s.notes.map((n) => NOTE_TEXT[n] ?? n), downloadGB: Math.round((s.files.reduce((a, f) => a + f.bytes, 0) + s.code.bytes) / 1e8) / 10,
    };
  });
  return {
    gpu: { name: gpu.name, vramGB: Math.round((gpu.vramMB / 1024) * 10) / 10 },
    notice: { version: RIG_ML_NOTICE_VERSION, lines: RIG_ML_NOTICE },
    models,
    recommended: suggestModel(gpu.vramMB),
    plan: rigPlan(gpu.vramMB),
  };
}

/** Throws a plain-words error unless the model's pack is installed with the current notice accepted. */
export function ensureInstalled(model: RigMlModel, dir = DEFAULT_DIR, catalog: Catalog = RIG_ML): void {
  const have = inspectRigMl(model, dir, catalog[model]);
  if (!have.installed) throw new Error('The smart skeleton add-on is not installed yet. Install it first.');
  if ((have.manifest?.noticeVersion ?? 0) < RIG_ML_NOTICE_VERSION) throw new Error('The notice changed since you installed the add-on: install it again to accept it.');
}

/** How a rig job will run on this card, before it starts: the tier table (shared/rigMl.ts rigPlan) plus which installed model to use.
 *  Never refuses for graphics memory: a small card gets the staged mode, a card under its floor (or none) gets the Blender templates. */
export async function prepareMlRig(model: RigMlModel | undefined, probe: GpuProbeFn = probeGpu, dir = DEFAULT_DIR, catalog: Catalog = RIG_ML): Promise<{ model: RigMlModel | null; gpu: GpuProbe; plan: RigPlan }> {
  const gpu = await probe();
  const asked = model && (catalog as Record<string, unknown>)[model] ? model : undefined;
  let plan = rigPlan(gpu.vramMB, asked ? { prefer: asked } : {});
  if (plan.mode === 'templates' || !plan.model) return { model: null, gpu, plan };
  if (!asked) {
    // no model chosen: the suggested one if it is installed, else the other usable one that is
    const order = [plan.model, ...RIG_ML_MODELS.filter((m) => m !== plan.model)];
    const pick = order.find((m) => vramVerdict(m, gpu.vramMB).usable && inspectRigMl(m, dir, catalog[m]).installed);
    if (pick && pick !== plan.model) plan = rigPlan(gpu.vramMB, { prefer: pick });
  }
  ensureInstalled(plan.model as RigMlModel, dir, catalog);
  return { model: plan.model, gpu, plan };
}

/** The low-memory knobs of one staged attempt (shared/rigMl.ts STAGED_TIERS / RETRY_KNOBS). */
export interface StagedKnobs { faces: number; beams: number; skinChunk: number }

export interface MlRigRun {
  model: RigMlModel; input: string; output: string; dir?: string; timeoutMs?: number; mock?: boolean; probe?: GpuProbeFn; catalog?: Catalog;
  python?: string; script?: string; extraArgs?: string[]; signal?: AbortSignal;
  /** The low-memory staged mode: `input` is a decimated copy and the worker is told to use the small-memory knobs. */
  staged?: StagedKnobs;
}

/** The worker's command line for a run (pure: tools/rigml_unit.ts checks it). */
export function workerArgs(o: Pick<MlRigRun, 'model' | 'input' | 'output' | 'mock' | 'staged' | 'extraArgs'>, codeDir: string): string[] {
  return [
    '--model', o.model, '--input', o.input, '--output', o.output, '--code-dir', codeDir,
    ...(o.staged ? ['--staged', '--faces', String(o.staged.faces), '--beams', String(o.staged.beams), '--skin-chunk', String(o.staged.skinChunk)] : []),
    ...(o.mock ? ['--mock'] : []), ...(o.extraArgs ?? []),
  ];
}

/** Check the pack is there, then run the worker on `input`. Returns the rigged file the model wrote (before the bones are named). */
export async function executeMlRig(ctx: { log: (l: string) => void; progress: (p: number) => void }, o: MlRigRun): Promise<string> {
  const dir = o.dir ?? DEFAULT_DIR;
  if (!o.mock) ensureInstalled(o.model, dir, o.catalog);
  const P = rigMlPaths(dir, o.model);
  const script = o.script ?? path.join(ROOT, 'tools', 'gpu', 'rigml_worker.py');
  const python = o.python ?? (o.mock ? 'python' : P.python);      // (a mock run needs no pack: the PC's own python is enough)
  ctx.log(`Smart skeleton: ${RIG_ML[o.model].label}${o.staged ? ' (low-memory staged mode)' : ''}`);
  return runWorker({
    python, script, cwd: o.mock ? undefined : P.code, timeoutMs: o.timeoutMs ?? 20 * 60_000, signal: o.signal,
    args: workerArgs(o, P.code),
    onEvent: (e) => {
      if (e.event === 'progress' && e.pct !== undefined) ctx.progress(e.pct * 0.85);
      if ((e.event === 'progress' || e.event === 'log') && e.msg) ctx.log(e.msg);
    },
  });
}
