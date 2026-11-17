// Pro2D → 3D job steps on the helper (lane to3d). Every heavy step is its own process, started off the event loop
// (server/spawnOffLoop.ts: the helper's loop relays the live tracking to OBS), below-normal / IDLE priority, Blender
// only headless inside the Blender lock (VTP_BLENDER_LOCK). The runner never passes --turnaround or --live-blender.
//   prepare   .vtp2 → bundle (tools/pro2d_bundle.ts) → refs (blender/to3d/refs.py); a rig that can't be read as a
//             character falls back to the picture route (refs.py --front-only + the pipeline's image route)
//   round     the pipeline (tools/live2d_to_3d.py --vtp2 | image) full / hair / springs / profile, or a graft
//   check     app-renderer shots (server/to3d/render.ts) → compare.py → tools/review_character.py; when the browser
//             can't render: the review's Blender toon views only, marked approximate
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { changedStage, type OvStage } from '../../shared/to3d/overrides.ts';
import { bestRound, lastRound, roundOf, type Check, type Round, type To3dJob } from '../../shared/to3d/job.ts';
import { ROOT } from '../paths.ts';
import { findBlenderAsync } from '../blender.ts';
import { blenderLockPath } from '../creator/blenderLock.ts';
import { onOffLoopChild, runOffLoop } from '../spawnOffLoop.ts';
import { kitPython } from './kit.ts';
import { userBase } from './bases.ts';
import { liveNow } from './live.ts';
import { renderCandidate } from './render.ts';
import { checkPartSizes, checkDir, jobPaths, roundDir, withJob } from './store.ts';

const MIN = 60_000;
const running = new Map<string, Set<number>>();   // job id → child pids (Stop kills them, with their Blender children)

export function pro2dBundleCommand(root = ROOT, exists: (p: string) => boolean = fs.existsSync): string[] {
  const bundled = path.join(root, 'dist-helper', 'pro2d_bundle.mjs');
  return exists(bundled) ? [process.execPath, bundled] : [process.execPath, '--import', 'tsx', path.join(root, 'tools', 'pro2d_bundle.ts')];
}

function python(): string {
  const k = kitPython();
  if (!k) throw Object.assign(new Error('The 3D toolkit isn\'t installed yet: press "Get the 3D toolkit" in VTube Pro.'), { status: 409 });
  return k.python;
}

async function pipelineEnv(): Promise<Record<string, string>> {
  const blender = await findBlenderAsync();
  if (!blender) throw Object.assign(new Error('Blender isn\'t installed: press "Install Blender" in VTube Pro.'), { status: 409 });
  return { VTP_BLENDER: blender, VTP_BLENDER_LOCK: blenderLockPath(), VTP_PRO2D_EVAL: JSON.stringify(pro2dBundleCommand()), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

/** One step's process, tracked for Stop. Resolves stdout + stderr text; rejects with the last useful line. */
async function run(jobId: string, exe: string, args: string[], o: { timeoutMs: number; env?: Record<string, string>; okMarker?: RegExp }): Promise<string> {
  const off = onOffLoopChild((c) => {
    if (c.exe !== exe || c.args[0] !== args[0]) return;
    const s = running.get(jobId) ?? new Set<number>();
    if (c.phase === 'spawn') s.add(c.pid); else s.delete(c.pid);
    running.set(jobId, s);
  });
  try {
    const r = await runOffLoop(exe, args, { timeoutMs: o.timeoutMs, cwd: ROOT, env: o.env, lowPriority: true });
    const out = r.stdout.toString('utf8') + '\n' + r.stderr;
    if (r.error) throw new Error(r.error);
    if (r.timedOut) throw new Error('it took too long and was stopped');
    if (r.code !== 0 || (o.okMarker && !o.okMarker.test(out))) {
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const why = lines.reverse().find((l) => /BASE_REFUSED|TO3D_GRAFT_REFUSED|Error|error|refused|failed/.test(l) && !/^\s*File /.test(l)) ?? lines[0] ?? `exit ${r.code}`;
      throw new Error(why.replace(/^(BASE_REFUSED|TO3D_GRAFT_REFUSED|SystemExit:)\s*/, '').slice(0, 400));
    }
    return out;
  } finally { off(); }
}

/** Stop: kill the job's processes and everything they started (the pipeline's headless Blender). */
export function killJob(jobId: string) {
  for (const pid of running.get(jobId) ?? []) {
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  }
  running.delete(jobId);
}

const setStep = (j: To3dJob, name: string, text: string, progress = 0) => { j.step = { name, text, progress, at: Date.now() }; };

/** Heavy steps wait while the live studio's tracking struggles (the signal tools/live_ok.py reads): every 30 s, at most
 *  30 min, then they run anyway at idle priority. Live but healthy = they run (CPU, IDLE, the Blender lock). */
export async function politeWait(id: string, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), maxMs = 30 * MIN): Promise<void> {
  const until = Date.now() + maxMs;
  for (let said = false; Date.now() < until; said = true) {
    const l = await liveNow();
    if (!l.pause) return;
    if (!said) await withJob(id, (j) => { j.step = { name: 'waiting', text: 'Waiting a moment: your stream\'s face tracking is busy', progress: j.step?.progress ?? 0, at: Date.now() }; }).catch(() => {});
    await sleep(30_000);
  }
}
const fail = (id: string, e: unknown, where: string) => withJob(id, (j) => { j.phase = 'failed'; j.error = `${where}: ${(e as Error).message}`; j.step = null; }).catch(() => {});

// ---------------------------------------------------------------- prepare: bundle + references
export async function prepare(id: string): Promise<void> {
  const P = jobPaths(id);
  try {
    await withJob(id, (j) => { j.phase = 'bundling'; setStep(j, 'bundle', 'Getting your model ready', 0.1); });
    const cmd = pro2dBundleCommand();
    await run(id, cmd[0], [...cmd.slice(1), 'export', P.src, P.bundle], { timeoutMs: 5 * MIN, okMarker: /PRO2D_BUNDLE_OK/ });
    await withJob(id, (j) => setStep(j, 'refs', 'Drawing your 2D model from every side it has', 0.5));
    const env = await pipelineEnv();
    let route: 'vtp2' | 'image' = 'vtp2';
    try {
      await run(id, python(), [path.join(ROOT, 'blender', 'to3d', 'refs.py'), P.bundle, P.refs], { timeoutMs: 10 * MIN, env, okMarker: /TO3D_REFS_OK/ });
    } catch {
      route = 'image';   // not readable as a character (no eyes / head turn found): the picture route
      await run(id, python(), [path.join(ROOT, 'blender', 'to3d', 'refs.py'), P.bundle, P.refs, '--front-only'], { timeoutMs: 5 * MIN, env, okMarker: /TO3D_REFS_OK/ });
    }
    await withJob(id, (j) => { j.route = route; j.phase = 'bundled'; setStep(j, 'ready', 'Ready for your AI', 1); });
  } catch (e) { await fail(id, e, 'Reading the 2D model'); }
}

// ---------------------------------------------------------------- rounds
/** A graft part: a plain .glb file name inside the job's work/parts folder (no folders, no `..`). */
export const GRAFT_PART = /^[A-Za-z0-9_-]{1,60}\.glb$/;
export interface RoundRequest { lever: 'baseline' | 'rebuild' | 'graft'; from: number | null; overrides: Record<string, string | number | boolean>; mode: Round['mode']; parts?: string[]; hide?: string[]; route?: 'vtp2' | 'image' }

/** Plan a rebuild: merged overrides (the round it starts from + the new ones) and the scope that change needs. */
export function planRebuild(j: To3dJob, from: number, fresh: Record<string, string | number | boolean>): { overrides: Record<string, string | number | boolean>; mode: OvStage } {
  const base = roundOf(j, from);
  const prev = base?.overrides ?? {};
  const merged = { ...prev, ...fresh };
  return { overrides: merged, mode: changedStage(prev, merged) ?? 'profile' };
}

/** Start a round (returns its number at once; the work runs in the background). */
export async function startRound(id: string, req: RoundRequest): Promise<number> {
  const n = await withJob(id, (j) => {
    if (j.rounds.some((r) => r.status === 'running')) throw Object.assign(new Error('A round is already running: call to3d_wait.'), { status: 409 });
    const nn = (lastRound(j)?.n ?? -1) + 1;
    j.rounds.push({ n: nn, from: req.from, lever: req.lever, mode: req.mode, overrides: req.overrides, parts: req.parts ?? [], status: 'running', startedAt: Date.now() });
    j.current = nn; j.phase = 'running';
    if (req.route) j.route = req.route;
    setStep(j, 'round', req.lever === 'baseline' ? 'Making a first 3D version (2–8 min)' : `Round ${nn}: rebuilding`, 0.05);
    return nn;
  });
  void runRound(id, n, req);
  return n;
}

async function runRound(id: string, n: number, req: RoundRequest) {
  const P = jobPaths(id), out = roundDir(id, n);
  try {
    await politeWait(id);
    const j0 = (await withJob(id, (j) => structuredClone(j)));
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    if (req.mode === 'graft') {
      const from = roundDir(id, req.from!);
      await fsp.cp(from, out, { recursive: true, filter: (s) => !s.includes(`${path.sep}check`) });
      const prof = JSON.parse(await fsp.readFile(path.join(out, 'profile.json'), 'utf8')) as { modelFile: string };
      const vrm = path.join(out, prof.modelFile);
      // plain file names inside work/parts only (the route checks the same; a round can also come from a saved job)
      const parts = (req.parts ?? []).filter((p) => GRAFT_PART.test(p)).map((p) => path.join(P.parts, p));
      if (!parts.length) throw new Error('No parts to add (part names are plain .glb file names in work/parts).');
      // the size again at the point of use: the part may have been replaced while the round waited its turn
      await checkPartSizes(parts);
      await run(id, python(), [path.join(ROOT, 'blender', 'to3d', 'graft.py'), vrm, vrm, ...parts, ...(req.hide?.length ? ['--hide', ...req.hide] : [])], { timeoutMs: 10 * MIN, env: await pipelineEnv(), okMarker: /TO3D_GRAFT_OK/ });
    } else {
      const env = await pipelineEnv();
      const ovFile = path.join(out, 'to3d_overrides.json');
      await fsp.writeFile(ovFile, JSON.stringify(req.overrides));
      const route = req.route ?? j0.route;
      const flat = path.join(P.refs, 'front_flat.png');
      const input = route === 'image' ? (fs.existsSync(flat) ? flat : path.join(P.refs, 'front.png')) : P.bundle;
      const args = [path.join(ROOT, 'tools', 'live2d_to_3d.py'), input, out, ...(route === 'image' ? ['--image'] : ['--vtp2']), '--builtin-bases', '--name', j0.avatarName, '--id', 'avatar',
        '--overrides', ovFile, '--progress', path.join(out, 'to3d_progress.json'), '--mode', req.mode === 'full' ? 'full' : req.mode];
      if (req.mode !== 'full') args.push('--prev', roundDir(id, req.from!));
      const ub = j0.base.kind === 'user' && j0.base.file ? j0.base.file : null;
      if (ub) args.push('--base', ub);
      const poll = setInterval(() => {
        fs.readFile(path.join(out, 'to3d_progress.json'), 'utf8', (err, t) => {
          if (err) return;
          try { const s = JSON.parse(t) as { stage: string; n: number; of: number }; void withJob(id, (j) => setStep(j, 'round', STAGE_WORDS[s.stage] ?? s.stage, s.n / s.of)).catch(() => {}); } catch { /* half written */ }
        });
      }, 3000);
      try { await run(id, python(), args, { timeoutMs: 60 * MIN, env, okMarker: /TO3D_STEP \{"stage": "done"/ }); }
      finally { clearInterval(poll); }
    }
    await withJob(id, (j) => {
      const r = roundOf(j, n)!;
      r.status = 'ready'; r.endedAt = Date.now();
      if (r.lever === 'baseline' && !j.baselineDoneAt) j.baselineDoneAt = Date.now();
      j.phase = 'iterating'; setStep(j, 'built', `Round ${n} is built: checking it next`, 1);
    });
  } catch (e) {
    await withJob(id, (j) => {
      const r = roundOf(j, n);
      if (r) { r.status = 'failed'; r.error = (e as Error).message; r.endedAt = Date.now(); }
      j.phase = 'iterating'; j.step = null;
    }).catch(() => {});
  }
}

const STAGE_WORDS: Record<string, string> = {
  read: 'Reading the 2D model', analyze: 'Finding the eyes, hair and outfit', design: 'Choosing the base and the face shape',
  build: 'Building the 3D face and body', outfit: 'Painting the outfit', hair: 'Building the hair (the longest step)',
  springs: 'Tuning the hair physics', profile: 'Finishing', done: 'Built',
};

/** Revert: a new round that is a copy of an earlier one (the next lever starts from it). */
export async function revertTo(id: string, to: number): Promise<number> {
  const n = await withJob(id, (j) => {
    const r = roundOf(j, to);
    if (!r || r.status !== 'ready') throw Object.assign(new Error(`Round ${to} can't be gone back to.`), { status: 409 });
    const nn = (lastRound(j)?.n ?? -1) + 1;
    j.rounds.push({ ...structuredClone(r), n: nn, from: to, lever: 'revert', parts: [], startedAt: Date.now(), endedAt: Date.now(), note: undefined });
    j.current = nn; j.phase = 'iterating';
    return nn;
  });
  await fsp.cp(roundDir(id, to), roundDir(id, n), { recursive: true });
  return n;
}

// ---------------------------------------------------------------- check: render + compare + review (ONE call)
export async function startCheck(id: string, n: number): Promise<void> {
  await withJob(id, (j) => {
    const r = roundOf(j, n);
    if (!r || r.status !== 'ready') throw Object.assign(new Error(`Round ${n} isn't built.`), { status: 409 });
    if (j.phase === 'running') throw Object.assign(new Error('Something is already running: call to3d_wait.'), { status: 409 });
    j.phase = 'running'; r.check = undefined;
    setStep(j, 'check', `Round ${n}: rendering 8 angles + the expressions`, 0.1);
  });
  void runCheck(id, n);
}

async function runCheck(id: string, n: number) {
  const P = jobPaths(id), rd = roundDir(id, n), cd = checkDir(id, n);
  try {
    await politeWait(id);
    await fsp.rm(cd, { recursive: true, force: true });
    await fsp.mkdir(cd, { recursive: true });
    const prof = JSON.parse(await fsp.readFile(path.join(rd, 'profile.json'), 'utf8')) as { modelFile: string } & Record<string, unknown>;
    const vrm = path.join(rd, prof.modelFile);
    const live = await liveNow();
    const shots = path.join(cd, 'shots');
    activeModel.set(id, vrm);
    const r = await renderCandidate({ dir: shots, model: vrm, profile: { ...prof, id: `to3d_${id}_${n}` }, live: live.live });
    activeModel.delete(id);
    const env = await pipelineEnv();
    const job = await withJob(id, (j) => structuredClone(j));
    let scores: Check['scores'] = null;
    if (r.ok) {
      await withJob(id, (j) => setStep(j, 'check', `Round ${n}: comparing with your 2D model`, 0.45));
      const out = await run(id, python(), [path.join(ROOT, 'blender', 'to3d', 'compare.py'), P.refs, shots, cd, '--route', job.route], { timeoutMs: 5 * MIN, env, okMarker: /TO3D_COMPARE_OK/ });
      void out;
      try { scores = JSON.parse(await fsp.readFile(path.join(cd, 'scores.json'), 'utf8')); } catch { scores = null; }
      await sheets(shots, cd);
    }
    await withJob(id, (j) => setStep(j, 'check', `Round ${n}: the automatic review (about 2 min)`, 0.6));
    let review: Check['review'] = null, notes: string[] = [];
    try {
      await run(id, python(), [path.join(ROOT, 'tools', 'review_character.py'), vrm, path.join(cd, 'review'), '--profile', path.join(rd, 'profile.json'), '--res', '768', '--no-validate'], { timeoutMs: 30 * MIN, env });
      const rep = JSON.parse(await fsp.readFile(path.join(cd, 'review', 'report.json'), 'utf8')) as { verdict?: Check['review']; findings?: { id: string; severity: string; what: string; view?: string }[] };
      review = rep.verdict ?? null;
      notes = (rep.findings ?? []).filter((f) => f.severity !== 'low').slice(0, 12).map((f) => `${f.id} ${f.severity}: ${f.what}${f.view ? ` (${f.view})` : ''}`);
    } catch (e) { notes = [`the automatic review did not run: ${(e as Error).message}`]; }
    const files = (await fsp.readdir(cd)).filter((f) => f.endsWith('.png'));
    await withJob(id, (j) => {
      const rr = roundOf(j, n)!;
      rr.check = { at: Date.now(), approximate: !r.ok, views: r.files, sheets: files, scores, review, reviewNotes: r.ok ? notes : [`app renderer unavailable (${r.error}): Blender toon views only`, ...notes] };
      j.best = bestRound(j);
      j.phase = 'iterating'; setStep(j, 'checked', `Round ${n} checked${review ? `: review ${review}` : ''}`, 1);
    });
  } catch (e) {
    activeModel.delete(id);
    await withJob(id, (j) => { j.phase = 'iterating'; j.step = { name: 'check', text: `The check failed: ${(e as Error).message}`, progress: 0, at: Date.now() }; }).catch(() => {});
  }
}

/** The model the render page may fetch for a job (only while its check runs). */
export const activeModel = new Map<string, string>();

/** One picture of the 8 angles and one of the expression sheet (fewer images per answer: the AI's plan limit). */
async function sheets(shots: string, out: string) {
  const py = python();
  const code = `import sys, os, json
from PIL import Image, ImageDraw
d, out = sys.argv[1], sys.argv[2]
def sheet(names, labels, fn, cell=300, cols=4):
    ims = [(Image.open(os.path.join(d, n + '.png')).convert('RGBA'), l) for n, l in zip(names, labels) if os.path.exists(os.path.join(d, n + '.png'))]
    if not ims: return
    rows = (len(ims) + cols - 1) // cols
    S = Image.new('RGBA', (cols * cell, rows * (cell + 20)), (44, 46, 52, 255)); D = ImageDraw.Draw(S)
    for i, (im, l) in enumerate(ims):
        im.thumbnail((cell, cell)); x, y = (i % cols) * cell, (i // cols) * (cell + 20)
        S.alpha_composite(im, (x + (cell - im.width) // 2, y + 20 + (cell - im.height) // 2)); D.text((x + 6, y + 4), l, fill=(235, 235, 235, 255))
    S.save(os.path.join(out, fn))
a = json.loads(sys.argv[3])
sheet(a['angles'], a['angleLabels'], 'angles_sheet.png')
sheet(a['expr'], a['exprLabels'], 'expressions_sheet.png')
print('TO3D_SHEETS_OK')`;
  const { SHOTS, EXPR_LABELS } = await import('./render.ts');
  const angles = SHOTS.filter((s) => s.name.startsWith('bust_'));
  const expr = SHOTS.filter((s) => s.name.startsWith('expr_'));
  const spec = { angles: angles.map((s) => s.name), angleLabels: angles.map((s) => `${s.yaw}°`), expr: expr.map((s) => s.name), exprLabels: EXPR_LABELS };
  await runOffLoop(py, ['-c', code, shots, out, JSON.stringify(spec)], { timeoutMs: 2 * MIN, cwd: ROOT });
}
