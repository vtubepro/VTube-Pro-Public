// Routes of the optional ML rigging pack (the logic is in server/rigMlCore.ts; the catalogue in shared/rigMl.ts).
//   GET  /api/rigml/status                       what this PC can run, what is installed, the notice to show
//   POST /api/rigml/install   {model, accept}    start the on-demand install (a job); the person must accept the first-use note
//   POST /api/rigml/uninstall {model}            remove the pack folder
//   POST /api/avatars/:id/autorig-ml/apply {confirmLive?}   save a finished rig that was held back because OBS was live (or could not be checked)
//   POST /api/avatars/:id/autorig-ml {bodyType?, taps?, model?}   rig an avatar with the model (a job), then name the bones
//                                                the way the studio expects (blender/mlrig_adopt.py) and save a retarget map.
//                                                By graphics memory (shared/rigMl.ts rigPlan): full speed, the low-memory STAGED mode
//                                                (decimated copy -> model steps in separate processes -> weights moved back; one automatic
//                                                retry with a smaller copy on out-of-memory), or the Blender templates. Never a question.
// Offered to every user, on their click. SkinTokens wants a 14 GB card, UniRig 8 GB; a smaller card (down to 6 / 4 GB) runs the low-memory staged
// mode by itself ("this will take longer on your card"), anything smaller gets the Blender templates (shared/rigMl.ts rigPlan).
import { Router } from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildRigMap, describeRigMap } from '../shared/rigMap.ts';
import { RIG_ML_MODELS, type RigMlModel } from '../shared/rigMl.ts';
import { BODY_TYPES, TEMPLATE_OF, parseAutorigRequest, profileBodyFor, sanitizeTaps, type BodyType, type RigTaps } from '../shared/rigTaps.ts';
import { runRigMlSetup, uninstallRigMl } from '../tools/gpu/rigml_setup.ts';
import { findBlender, runBlender } from './blender.ts';
import { startJob } from './jobs.ts';
import { HttpError, modelPath, requireProfile, saveProfileAsync, userDir } from './library.ts';
import { executeMlRig, prepareMlRig, rigMlStatus } from './rigMlCore.ts';
import { runRigJob } from './rigMlStaged.ts';
import { requireLocal } from './routes/util.ts';
import type { AvatarProfile } from '../shared/types.ts';

// This PC only (like /api/voice): a web page may not make the helper download multi-GB packs, delete them, or start a GPU / Blender job.

/** Test seam: is OBS streaming / recording right now (true), idle (false) or unknown (null)? Same signal as the GPU gate (server/gpuSidecars.ts). */
export const rigMlHooks: { live: () => Promise<boolean | null> } = {
  live: async () => { try { return await (await import('./gpuSidecars.ts')).gpuHooks.live(); } catch { return null; } },
};
type HeldRig = { retarget?: AvatarProfile['rig']['retarget']; body?: AvatarProfile['body'] };
/** A finished rig that was NOT saved because OBS was live, or not known to be idle (saving broadcasts 'profile', and a page showing that avatar reloads it: on stream). */
const heldRig = new Map<string, HeldRig>();
/** Where a held result is kept on disk too (the model_rigged.glb it belongs to is in the same folder), so a helper restart does not lose it. */
export const heldFile = (id: string) => path.join(userDir(id), 'rigml_held.json');
async function saveRigPatch(id: string, held: HeldRig) {
  const latest = requireProfile(id);
  await saveProfileAsync(id, { modelFile: 'model_rigged.glb', rig: { ...latest.rig, kind: 'humanoid', ...(held.retarget ? { retarget: held.retarget } : {}) }, ...(held.body ? { body: held.body } : {}) });
}
export type HeldDeps = { save: (id: string, held: HeldRig) => Promise<void>; file: (id: string) => string };
const heldDeps: HeldDeps = { save: saveRigPatch, file: heldFile };
/** Memory first, then the file a previous run of the helper left. */
async function readHeld(id: string, deps: HeldDeps): Promise<HeldRig | undefined> {
  const mem = heldRig.get(id);
  if (mem) return mem;
  try { const v = JSON.parse(await fsp.readFile(deps.file(id), 'utf8')) as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) { heldRig.set(id, v as HeldRig); return v as HeldRig; } } catch { /* nothing waiting */ }
  return undefined;
}
async function dropHeld(id: string, deps: HeldDeps) { heldRig.delete(id); await fsp.rm(deps.file(id), { force: true }).catch(() => {}); }
/** A rig job is done and its model file is in place: save the profile now (OBS known to be idle), or hold it back (OBS live, or the
 *  state UNKNOWN: unknown behaves like live, as the live captions' resume does). Returns whether it was saved. */
export async function settleRig(id: string, held: HeldRig, deps: HeldDeps = heldDeps): Promise<boolean> {
  if ((await rigMlHooks.live()) !== false) {
    heldRig.set(id, held);
    try { await fsp.mkdir(path.dirname(deps.file(id)), { recursive: true }); await fsp.writeFile(deps.file(id), JSON.stringify(held)); } catch { /* memory still holds it */ }
    return false;
  }
  await dropHeld(id, deps);
  await deps.save(id, held);
  return true;
}
/** The "Switch on the new skeleton" call: refuses (409) unless OBS is known idle or the person confirmed; 404 when nothing is waiting. */
export async function applyHeldRig(id: string, confirmLive: boolean, deps: HeldDeps = heldDeps): Promise<void> {
  const held = await readHeld(id, deps);
  if (!held) throw new HttpError(404, 'There is no finished skeleton waiting for this avatar.');
  if (!confirmLive && (await rigMlHooks.live()) !== false) throw new HttpError(409, 'You are live, or OBS cannot be checked: applying it reloads the avatar on stream. Confirm to do it anyway.');
  await deps.save(id, held);
  await dropHeld(id, deps);
}

// ---------------------------------------------------------------- routes

export const rigMlRoutes = Router();

rigMlRoutes.get('/api/rigml/status', async (_req, res) => { res.json(await rigMlStatus()); });

const modelOf = (v: unknown): RigMlModel => {
  if (typeof v === 'string' && (RIG_ML_MODELS as readonly string[]).includes(v)) return v as RigMlModel;
  throw new HttpError(400, 'Unknown model.');
};

let installing = false;
rigMlRoutes.post('/api/rigml/install', (req, res) => {
  requireLocal(req);
  const model = modelOf(req.body?.model);
  if (req.body?.accept !== true) throw new HttpError(400, 'Read the notice and accept it first.');
  if (installing) throw new HttpError(409, 'An install is already running.');
  installing = true;
  const job = startJob('rigml-install', async (ctx) => {
    try {
      const ok = await runRigMlSetup({
        model, accept: true,
        onProgress: (p) => { ctx.log(`${p.step}: ${p.msg}`); if (p.pct !== undefined) ctx.progress(p.pct); },
      });
      if (!ok) throw new Error('The install did not finish. See the log.');
      return { model };
    } finally { installing = false; }
  }, { model });
  res.json({ jobId: job.id });
});

rigMlRoutes.post('/api/rigml/uninstall', (req, res) => {
  requireLocal(req);
  const model = modelOf(req.body?.model);
  res.json({ ok: uninstallRigMl(model) });
});

rigMlRoutes.post('/api/avatars/:id/autorig-ml', (req, res) => {
  requireLocal(req);
  if (!findBlender()) throw new HttpError(503, 'Blender not found. Install Blender or set its path in Settings.');
  const p = requireProfile(req.params.id);
  const bodyType: BodyType = (BODY_TYPES as readonly string[]).includes(req.body?.bodyType) ? req.body.bodyType : 'fourLegs';
  const taps: RigTaps = sanitizeTaps(req.body?.taps);
  const model = req.body?.model === undefined ? undefined : modelOf(req.body.model);
  const input = modelPath(p);
  const job = startJob('autorig-ml', async (ctx) => {
    const raw = path.join(ctx.dir, 'ml_rigged.glb');
    const adopted = path.join(ctx.dir, 'model_rigged.glb');
    ctx.log(`Smart skeleton for ${p.id} (${p.modelFile}) as ${bodyType}…`);
    // how this card runs it: full speed, the low-memory staged mode, or the Blender templates (never a refusal, never a question)
    const prep = await prepareMlRig(model);
    if (prep.plan.mode === 'staged') ctx.log(prep.plan.message);
    const blender = async <T>(script: string, params: Record<string, unknown>, label: string): Promise<T> => {
      const r = await runBlender<T>(script, params, { timeoutMs: 10 * 60_000, lowPriority: true });
      if (!r.ok || !r.result) throw new Error(r.error ?? `${label} failed`);
      return r.result;
    };
    const tmpl: { r: { bones: string[]; notes?: string[] } | null } = { r: null };
    const done = await runRigJob(prep.plan, { input, work: (n) => path.join(ctx.dir, n), output: raw, haveGB: prep.gpu.vramMB ? Math.round((prep.gpu.vramMB / 1024) * 10) / 10 : null }, {
      log: ctx.log,
      decimate: (o) => blender<{ facesBefore: number; facesAfter: number }>('mlrig_stage.py', { mode: 'decimate', input: o.input, output: o.output, targetFaces: o.faces }, 'making the smaller copy'),
      rig: (o) => executeMlRig(ctx, { model: o.model, input: o.input, output: o.output, ...(o.staged ? { staged: o.staged } : {}) }),
      transfer: async (o) => { const t = await blender<{ vertices: number; filledFromNearestVertex: number; aligned: boolean }>('mlrig_stage.py', { mode: 'transfer', full: o.full, rigged: o.rigged, output: o.output }, 'moving the skin onto your model'); ctx.log(`Skin weights moved onto ${t.vertices} vertices${t.filledFromNearestVertex ? ` (${t.filledFromNearestVertex} filled from the nearest skinned point)` : ''}.`); },
      templates: async (o) => {
        // the no-AI Blender templates (blender/autorig.py), the same call as POST /api/avatars/:id/autorig
        const parsed = parseAutorigRequest({ bodyType, taps }, p.rig.soft);
        if (!parsed.ok) throw new Error(`${o.why} The Blender skeleton also needs more information: ${parsed.error}. Use “Skeleton for anything” and tap the body.`);
        const rq = parsed.req;
        tmpl.r = await blender<{ bones: string[]; notes?: string[] }>('autorig.py', { input: o.input, output: o.output, template: rq.template, bodyType: rq.bodyType, taps: rq.taps, ...(rq.soft ? { soft: rq.soft } : {}) }, 'the Blender skeleton');
      },
    });
    ctx.progress(0.88);
    ctx.log(done.summary);
    let bones: string[], notes: string[];
    if (done.named && tmpl.r) {
      bones = tmpl.r.bones; notes = tmpl.r.notes ?? [];
      await fsp.copyFile(done.path, adopted);
    } else {
      ctx.log('Naming the bones the way the studio expects…');
      const r = await runBlender<{ bones: string[]; renamed: Record<string, string>; notes: string[]; template: string }>(
        'mlrig_adopt.py', { input: done.path, output: adopted, bodyType, taps: { ...(taps.nose ? { nose: taps.nose } : {}), ...(taps.tailTip ? { tailTip: taps.tailTip } : {}) } }, { timeoutMs: 10 * 60_000, lowPriority: true },
      );
      if (!r.ok || !r.result) throw new Error(r.error ?? 'naming the bones failed');
      bones = r.result.bones; notes = r.result.notes;
    }
    const template = TEMPLATE_OF[bodyType];
    const dest = path.join(userDir(p.id), 'model_rigged.glb');
    await fsp.mkdir(userDir(p.id), { recursive: true });
    await fsp.copyFile(adopted, dest);
    const retarget = template === 'humanoid' ? undefined : buildRigMap(template, bodyType, bones);
    const body = profileBodyFor(template, bodyType);
    // the job ends minutes after the click: if OBS is live now, saving the profile would reload the avatar on stream. The file is in place;
    // the profile change waits for the person (POST .../autorig-ml/apply, which the studio calls after asking).
    const held = { ...(retarget ? { retarget } : {}), ...(body ? { body } : {}) };
    const applied = await settleRig(p.id, held);
    if (!applied) ctx.log('OBS is live (or cannot be checked), so the new skeleton is not switched on yet. It is ready; apply it when you are not streaming.');
    if (retarget) for (const line of describeRigMap(retarget)) ctx.log(line);
    for (const n of notes) ctx.log(n);
    ctx.log('Done. The model’s original file is kept; check the shoulders, hips and fingers before you stream with it.');
    return { avatarId: p.id, modelFile: 'model_rigged.glb', bones: bones.length, how: done.how, applied };
  }, { avatarId: p.id });
  res.json({ jobId: job.id });
});

rigMlRoutes.post('/api/avatars/:id/autorig-ml/apply', async (req, res) => {
  requireLocal(req);
  const id = String(req.params.id);
  requireProfile(id);
  await applyHeldRig(id, req.body?.confirmLive === true);
  res.json({ ok: true });
});
