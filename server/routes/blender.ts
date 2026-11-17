// Blender-backed endpoints: arbitrary bpy (localhost only), preview renders, autorig.
import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildRigMap, describeRigMap } from '../../shared/rigMap.ts';
import { parseAutorigRequest, profileBodyFor } from '../../shared/rigTaps.ts';
import { findBlender, runBlender } from '../blender.ts';
import { startJob } from '../jobs.ts';
import { HttpError, createAvatar, modelPath, renderThumbnail, requireProfile, saveProfileAsync, userDir } from '../library.ts';
import { CACHE_DIR } from '../paths.ts';
import { listFilesRecursive, requireLocal, sendFrom, stamp, wildcardPath } from './util.ts';

export const blenderRoutes = Router();

const RUNS_DIR = path.join(CACHE_DIR, 'blender');
const RENDERS_DIR = path.join(CACHE_DIR, 'renders');
const VIEWS = ['front', 'left', 'right', 'back', 'three_quarter', 'top'] as const;

function requireBlender() {
  if (!findBlender()) throw new HttpError(503, 'Blender not found. Install Blender or set its path in Settings.');
}

const fileUrls = (prefix: string, dir: string) => listFilesRecursive(dir).map((f) => `${prefix}/${f.split('/').map(encodeURIComponent).join('/')}`);

// ---------------------------------------------------------------- POST /api/blender/run

blenderRoutes.post('/api/blender/run', async (req, res) => {
  requireLocal(req);
  requireBlender();
  const { script, avatarId, saveAs, timeoutMs } = (req.body ?? {}) as {
    script?: string;
    avatarId?: string;
    saveAs?: { name?: string };
    timeoutMs?: number;
  };
  if (typeof script !== 'string' || !script.trim()) throw new HttpError(400, 'Body must include { script: "<bpy python>" }');
  const model = avatarId ? modelPath(requireProfile(avatarId)) : undefined;

  const runId = stamp();
  const dir = path.join(RUNS_DIR, runId);
  const outDir = path.join(dir, 'out');
  await fsp.mkdir(outDir, { recursive: true });
  const scriptFile = path.join(dir, 'script.py');
  await fsp.writeFile(scriptFile, script);

  const r = await runBlender('run_user.py', { script: scriptFile, model, out_dir: outDir }, { timeoutMs: Math.min(timeoutMs ?? 300_000, 1_800_000) });
  const files = fileUrls(`/api/blender/runs/${runId}`, outDir);
  let avatar = undefined;
  const glb = path.join(outDir, 'model.glb');
  if (r.ok && saveAs && fs.existsSync(glb)) {
    avatar = await createAvatar({ name: saveAs.name || 'Blender model', source: 'blender-ai', modelFrom: glb, modelFile: 'model.glb' });
    await fsp.copyFile(scriptFile, path.join(userDir(avatar.id), 'build_script.py'));
    await renderThumbnail(avatar.id);
    avatar = requireProfile(avatar.id);
  }
  res.json({ ok: r.ok, error: r.error, traceback: r.traceback, stdout: r.stdout, files, avatar });
});

blenderRoutes.get('/api/blender/runs/:runId/*file', (req, res) => {
  if (!/^[a-z0-9-]+$/i.test(req.params.runId)) throw new HttpError(400, 'Bad run id');
  sendFrom(res, path.join(RUNS_DIR, req.params.runId, 'out'), wildcardPath((req.params as Record<string, unknown>).file));
});

// ---------------------------------------------------------------- POST /api/avatars/:id/render

blenderRoutes.post('/api/avatars/:id/render', async (req, res) => {
  requireBlender();
  const p = requireProfile(req.params.id);
  const body = (req.body ?? {}) as { views?: string[]; size?: number; camera?: 'ortho' | 'persp' };
  const views = body.views?.length ? body.views : ['front'];
  const bad = views.filter((v) => !(VIEWS as readonly string[]).includes(v));
  if (bad.length) throw new HttpError(400, `Unknown view(s) ${bad.join(', ')}; valid: ${VIEWS.join(', ')}`);
  const size = Math.round(Math.min(2048, Math.max(64, Number(body.size) || 768)));
  const runId = `${p.id}-${stamp()}`;
  const dir = path.join(RENDERS_DIR, runId);
  const r = await runBlender<{ images: { view: string; path: string }[]; bbox: unknown }>(
    'render_preview.py',
    { input: modelPath(p), out_dir: dir, views, size, camera: body.camera === 'persp' ? 'persp' : 'ortho' },
    { timeoutMs: 300_000 },
  );
  if (!r.ok || !r.result) throw new HttpError(500, `Render failed: ${r.error}`);
  res.json({
    images: r.result.images.map((i) => `/api/renders/${runId}/${encodeURIComponent(path.basename(i.path))}`),
    views: r.result.images.map((i) => i.view),
    bbox: r.result.bbox,
  });
});

blenderRoutes.get('/api/renders/:runId/:file', (req, res) => {
  if (!/^[a-z0-9._-]+$/i.test(req.params.runId)) throw new HttpError(400, 'Bad render id');
  sendFrom(res, path.join(RENDERS_DIR, req.params.runId), req.params.file);
});

// ---------------------------------------------------------------- POST /api/avatars/:id/autorig

interface AutorigResult {
  output: string;
  template?: string;
  notes?: string[];
  bones: string[];
  meshes: { name: string; method: string; coverage: number; filled: number; vertices: number }[];
  coverage: number;
  arms: string[];
  legs: string[];
}

blenderRoutes.post('/api/avatars/:id/autorig', (req, res) => {
  requireBlender();
  const p = requireProfile(req.params.id);
  // { soft } alone = the original person flow; { bodyType, taps } = the guided flow (person / four legs / bird / snake / thing)
  const parsed = parseAutorigRequest(req.body, p.rig.soft);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  const rq = parsed.req;
  const soft = rq.soft;
  const input = modelPath(p);
  const job = startJob(
    'autorig',
    async (ctx) => {
      ctx.log(`Auto-rigging ${p.id} (${p.modelFile}) as ${rq.bodyType} with bone heat…`);
      const out = path.join(ctx.dir, 'model_rigged.glb');
      const r = await runBlender<AutorigResult>(
        'autorig.py',
        { input, output: out, template: rq.template, bodyType: rq.bodyType, taps: rq.taps, soft },
        {
          timeoutMs: 20 * 60_000,
          lowPriority: true, // the import starts it by itself in the background, maybe while live: tracking comes first
          onLine: (l) => {
            if (/^(skinned|armature bones|bone heat)/.test(l) || /Bone Heat/i.test(l)) ctx.log(l);
          },
        },
      );
      if (!r.ok || !r.result) throw new Error(r.error ?? 'autorig failed');
      ctx.progress(0.9);
      const dest = path.join(userDir(p.id), 'model_rigged.glb');
      await fsp.mkdir(userDir(p.id), { recursive: true });
      await fsp.copyFile(out, dest);
      const latest = requireProfile(p.id);
      // people keep the soft-rig record; animals, birds, snakes and things get a retarget map (head / neck / back from the
      // face, legs, tail and wings on their own) and the planted-body mode the quadruped layer needs
      const retarget = rq.template === 'humanoid' ? undefined : buildRigMap(rq.template, rq.bodyType, r.result.bones);
      const body = profileBodyFor(rq.template, rq.bodyType);
      await saveProfileAsync(p.id, {
        modelFile: 'model_rigged.glb',
        rig: { ...latest.rig, kind: 'humanoid', ...(soft ? { soft } : {}), ...(retarget ? { retarget } : { retarget: undefined }) },
        ...(body ? { body } : {}),
      });
      if (retarget) for (const line of describeRigMap(retarget)) ctx.log(line);
      for (const n of r.result.notes ?? []) ctx.log(n);
      const low = r.result.meshes.filter((m) => m.coverage < 0.98);
      ctx.log(
        `Rigged: ${r.result.bones.length} bones, weight coverage ${(r.result.coverage * 100).toFixed(1)}%` +
          (low.length ? ` (envelope/nearest-bone fallback on ${low.map((m) => m.name).join(', ')})` : ''),
      );
      return { avatarId: p.id, modelFile: 'model_rigged.glb', ...r.result, output: undefined };
    },
    { avatarId: p.id },
  );
  res.json({ jobId: job.id });
});
