// AI texture painting (docs/AI_ART_PIPELINE.md): POST /api/ai/texture starts tools/ai_texture/run.py as a job.
// Additive and read-only towards the library: the painted model lands in the JOB folder (cache/jobs/<id>/), never
// over the avatar; the UI offers "Apply" separately. GET /api/ai/status reports whether the paint backend answers.
//
// body: { avatarId: string, prompt?: string, refs?: string[] (files inside the avatar folder or assets/reference/<id>/),
//         views?: 'quick' | 'full', backend?: 'comfyui' | 'comfyui=http://127.0.0.1:<port>' (ComfyUI on this PC; default: settings.comfyUrl) }
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { startJob } from '../jobs.ts';
import { getProfile, HttpError, modelPath } from '../library.ts';
import { LIBRARY_DIR, ROOT } from '../paths.ts';
import { loadSettings } from '../settings.ts';

export const aiTextureRoutes = Router();

const PY = process.env.VTP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const RUN = path.join(ROOT, 'tools', 'ai_texture', 'run.py');

function backendSpec(body: { backend?: unknown }): string {
  // only ComfyUI, and from the request only on this PC: the painter never sends pictures to another service
  if (typeof body.backend === 'string' && /^comfyui(=https?:\/\/(127(\.\d{1,3}){3}|localhost|\[::1\]):\d{2,5})?$/.test(body.backend)) return body.backend;
  const url = (loadSettings().comfyUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  return `comfyui=${url}`;
}

function refPath(id: string, name: string): string | null {
  if (!/^[\w .()-]+\.(png|jpe?g|webp)$/i.test(name)) return null;
  for (const base of [path.join(ROOT, 'assets', 'reference', id), path.join(LIBRARY_DIR, id), path.join(ROOT, 'assets', 'builtin', id)]) {
    const f = path.join(base, name);
    if (f.startsWith(base + path.sep) && fs.existsSync(f)) return f;
  }
  return null;
}

aiTextureRoutes.get('/api/ai/status', async (_req, res) => {
  const spec = backendSpec({});
  const url = spec.startsWith('comfyui=') ? spec.slice(8) : spec;
  try {
    const r = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(3000) });
    res.json({ backend: spec, ok: r.ok });
  } catch (e) {
    res.json({ backend: spec, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

aiTextureRoutes.post('/api/ai/texture', (req, res) => {
  const body = (req.body ?? {}) as { avatarId?: unknown; prompt?: unknown; refs?: unknown; views?: unknown; backend?: unknown };
  if (typeof body.avatarId !== 'string') throw new HttpError(400, 'avatarId required');
  const p = getProfile(body.avatarId);
  if (!p) throw new HttpError(404, `No avatar '${body.avatarId}'`);
  const model = modelPath(p);
  const refs = (Array.isArray(body.refs) ? body.refs : []).filter((x): x is string => typeof x === 'string').slice(0, 4);
  const refFiles = refs.map((r) => refPath(p.id, r)).filter((x): x is string => !!x);
  if (!refFiles.length) throw new HttpError(400, 'at least one reference image (refs) is required');
  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 2000) : (p.prompt ?? '');
  const quick = body.views === 'quick';
  const spec = backendSpec(body);
  const job = startJob('ai-texture', async (ctx) => {
    const cfg = {
      model,
      out: path.join(ctx.dir, 'work'),
      out_model: path.join(ctx.dir, `${p.id}_ai${path.extname(model)}`),
      engine: 'qwen',
      yaw_offset: /\.vrm$/i.test(model) ? 180 : 0,
      targets: null as string[] | null, // null = every base-colour image (run.py resolves)
      describe: prompt,
      refs: Object.fromEntries(refFiles.map((f, i) => [i === 0 ? 'front' : `ref${i}`, { path: f }])),
      preset: quick ? 'quick' : 'full',
      consistency: false,
      ref_direct: false,
    };
    const cfgPath = path.join(ctx.dir, 'ai_texture.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 1));
    ctx.log(`AI texture: ${p.id} via ${spec} (${quick ? 'quick' : 'full'} view set)`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(PY, ['-u', RUN, cfgPath, '--stage', 'all'], {
        cwd: ROOT, env: { ...process.env, VTP_AI_BACKEND: spec, PYTHONIOENCODING: 'utf-8' }, windowsHide: true,
      });
      let views = 0;
      const total = quick ? 7 : 17;
      const onData = (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          ctx.log(line.slice(0, 400));
          if (/\] view \S+: painted/.test(line)) ctx.progress(Math.min(0.95, 0.1 + (0.85 * ++views) / total));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`run.py exited with ${code}`))));
    });
    const out = cfg.out_model;
    if (!fs.existsSync(out)) throw new Error('no painted model was written');
    return { avatarId: p.id, model: ctx.fileUrl(path.basename(out)) };
  }, { avatarId: p.id });
  res.json({ jobId: job.id });
});
