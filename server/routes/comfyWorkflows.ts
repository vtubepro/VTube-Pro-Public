// ComfyUI workflows: the shareable pack + "Set it up for me" (docs/COMFYUI.md).
//   GET  /comfyui                               the helper page (pick a workflow, consent, progress, done)
//   GET  /comfy-workflows/<path>                the pack files (same bytes as public/comfy-workflows/, built in memory)
//   GET  /api/comfy-workflows                   index: workflows, tiers, sizes, and whether ComfyUI is running here
//   GET  /api/comfy-workflows/:id/:tier         one manifest (models, URLs, SHA-256, licences, custom nodes, inputs, outputs)
//   POST /api/comfy-workflows/plan {workflow, tier, request?}
//                                               what we WOULD do (every download + size + folder). A page on this computer
//                                               also gets a single-use consent token (2 minutes, bound to this exact plan).
//   POST /api/comfy-workflows/install {workflow, tier, token, iUnderstand:true}
//                                               LOCAL ONLY + the helper's own page only (Origin check). Starts the job.
//   POST /api/comfy-workflows/add {workflow, tier}
//                                               LOCAL ONLY + the helper's own page only. Puts just the workflow file (and its
//                                               starter pictures) into ComfyUI's Workflows list: no downloads. The "Add it to
//                                               ComfyUI for me" button, for people who download the file instead.
//   GET  /api/comfy-workflows/jobs/:id · POST /api/comfy-workflows/jobs/:id/cancel
//   POST /api/comfy-workflows/requests {workflow, tier, open?}
//                                               LOCAL ONLY. An AI (MCP install_comfy_workflow) asks; we open /comfyui?request=<id>
//                                               on this computer where the USER sees the list and presses Yes. Nothing downloads here.
//   GET  /api/comfy-workflows/requests/:id      the request + its job, for the AI to follow
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { allKeys, buildIndex, buildWorkflow, TIER_IDS, TIERS, workflowDef, type TierId } from '../../shared/comfyWorkflows/catalog.ts';
import { NODE_SCHEMA, packBinaryFiles, packTextFiles } from '../../shared/comfyWorkflows/files.ts';
import { addWorkflowToComfy, InstallConsent, InstallJobs, lookupComfy, makePlan, realInstallDeps, suggestedTier, whyNoSetup, workflowsFolder, SetupError, type ComfyTarget, type InstallDeps } from '../comfyInstall.ts';
import { COMFY_WORKFLOWS_PAGE } from '../comfyWorkflowsPage.ts';


const PORT = () => Number(process.env.VTP_PORT ?? 5191);
/** The helper's own pages (and the dev studio on 5190). Only these may press "Yes". */
export function isHelperPage(origin: string | undefined, port = PORT()): boolean {
  if (!origin) return false;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5190', 'http://localhost:5190'].includes(origin);
}
/** Same, for a request. Browsers send Origin on a same-origin POST, but a few browsers and privacy extensions leave it off:
 *  then the browser's own `Sec-Fetch-Site: same-origin` together with a Referer on the helper's own origin counts. An Origin
 *  that is there and wrong is always refused (another site, a rebound host name). */
export function isHelperRequest(h: { origin?: string; secFetchSite?: string; referer?: string }, port = PORT()): boolean {
  if (h.origin !== undefined) return isHelperPage(h.origin, port);
  if (h.secFetchSite !== 'same-origin' || !h.referer) return false;
  try { return isHelperPage(new URL(h.referer).origin, port); } catch { return false; }
}
const isLocalOrigin = (o: string | undefined) => !o || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o);

let settingsComfy: string | undefined;
async function refreshSettings() { try { const m = await import('../settings.ts'); settingsComfy = m.loadSettings().comfyUrl; } catch { /* keep */ } }

interface PendingRequest { id: string; workflow: string; tier: TierId; at: number; jobId?: string }

export function createComfyWorkflowRoutes(o: { deps?: () => InstallDeps; openUrl?: (url: string) => Promise<void> } = {}) {
  const r = Router();
  const deps = o.deps ?? (() => realInstallDeps(() => settingsComfy));
  const consent = new InstallConsent(() => deps().now());
  const jobs = new InstallJobs(deps);
  const requests = new Map<string, PendingRequest>();
  let files: Record<string, string> | null = null;
  let bins: Record<string, Buffer> | null = null;
  let index: unknown = null;
  /** The ComfyUI on THIS computer we can put files in, or the plain reason there is none (`why` null = simply not open): the one the
   *  person uses may be on another computer, or too busy to answer, and then nothing is planned, downloaded or added anywhere. */
  const locate = async (dep: InstallDeps): Promise<{ target: ComfyTarget | null; why: string | null }> => {
    const l = await lookupComfy(dep);
    return l.kind === 'local' ? { target: l.target, why: null } : { target: null, why: whyNoSetup(l) };
  };
  const originOf = (req: Request) => (typeof req.headers.origin === 'string' ? req.headers.origin : undefined);
  const headerOf = (req: Request, name: string) => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : undefined);
  /** The click came from the helper's own page on this computer (never another site). */
  const fromPage = (req: Request) => isHelperRequest({ origin: originOf(req), secFetchSite: headerOf(req, 'sec-fetch-site'), referer: headerOf(req, 'referer') });
  const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');
  const tierOf = (t: unknown): TierId | null => (TIER_IDS as string[]).includes(String(t)) ? (t as TierId) : null;
  const sweep = () => { const t = deps().now(); for (const [k, q] of requests) if (t - q.at > 30 * 60_000) requests.delete(k); };

  r.get('/comfyui', (_req, res) => {
    noStore(res);
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191");
    res.type('html').send(COMFY_WORKFLOWS_PAGE);
  });

  r.get(/^\/comfy-workflows\/(.+)$/, (req, res, next) => {
    const rel = decodeURIComponent((req.params as unknown as string[])[0]);
    files ??= packTextFiles();
    bins ??= packBinaryFiles();
    if (files[rel] !== undefined) {
      res.type(rel.endsWith('.md') ? 'text/markdown' : 'application/json');
      if (/\.workflow\.json$/.test(rel) && req.query.download === '1') {
        const [id, t] = rel.split('/');
        const d = workflowDef(id); const tier = tierOf(t.split('.')[0]);
        if (d && tier) res.setHeader('Content-Disposition', `attachment; filename="${`VTube Pro - ${d.short} (${TIERS[tier].label}).json`.replace(/[^\w .()-]/g, '-')}"`);
      }
      res.send(files[rel]);
      return;
    }
    if (bins[rel]) { res.type('png').send(bins[rel]); return; }
    next();
  });

  r.get('/api/comfy-workflows', async (_req, res) => {
    noStore(res);
    index ??= buildIndex(NODE_SCHEMA);
    await refreshSettings();
    const { target: t, why } = await locate(deps());
    // vramGB / suggestedTier: the page starts on the size that fits this graphics card; workflowsFolder: where "Download the file" goes
    res.json({ ...(index as object), comfy: t ? { running: true, url: t.url, version: t.version, vramGB: t.vramGB ?? null, suggestedTier: suggestedTier(t) ?? null, workflowsFolder: workflowsFolder(t) } : { running: false, ...(why ? { why } : {}) }, job: jobs.running() });
  });

  r.get('/api/comfy-workflows/jobs/:id', (req, res) => {
    noStore(res);
    const j = jobs.get(req.params.id);
    if (!j) { res.status(404).json({ error: 'No such setup.' }); return; }
    res.json(j);
  });
  r.post('/api/comfy-workflows/jobs/:id/cancel', (req, res) => { res.json({ ok: jobs.cancel(req.params.id) }); });

  r.get('/api/comfy-workflows/requests/:id', (req, res) => {
    noStore(res);
    sweep();
    const q = requests.get(req.params.id);
    if (!q) { res.status(404).json({ error: 'That request has expired. Ask again.' }); return; }
    res.json({ ...q, job: q.jobId ? jobs.get(q.jobId) : null });
  });

  r.get('/api/comfy-workflows/:id/:tier', (req, res) => {
    const d = workflowDef(req.params.id); const t = tierOf(req.params.tier);
    if (!d || !t || !d.tiers[t]) { res.status(404).json({ error: 'No such workflow.' }); return; }
    res.json(buildWorkflow(d, t, NODE_SCHEMA).manifest);
  });

  r.post('/api/comfy-workflows/plan', async (req, res) => {
    noStore(res);
    const d = workflowDef(String(req.body?.workflow ?? '')); const t = tierOf(req.body?.tier);
    if (!d || !t || !d.tiers[t]) { res.status(404).json({ error: 'No such workflow.' }); return; }
    await refreshSettings();
    const dep = deps();
    const { target, why } = await locate(dep);
    if (!target) { res.status(409).json({ error: why ?? 'ComfyUI isn\'t open. Open ComfyUI, then press Check again.', comfy: false }); return; }
    const plan = await makePlan(dep, target, d.id, t);
    const page = fromPage(req);
    res.json({ plan, ...(page && !plan.blockers.length ? { consent: consent.issue(plan) } : {}), ...(!page ? { localUrl: `http://127.0.0.1:${PORT()}/comfyui?workflow=${d.id}&tier=${t}` } : {}) });
  });

  r.post('/api/comfy-workflows/install', async (req, res) => {
    noStore(res);
    if (!fromPage(req)) { res.status(403).json({ error: 'Press Yes on VTube Pro’s page on this computer.', code: 'local-only' }); return; }
    if (req.body?.iUnderstand !== true) { res.status(400).json({ error: 'Press Yes to agree first.' }); return; }
    const d = workflowDef(String(req.body?.workflow ?? '')); const t = tierOf(req.body?.tier);
    if (!d || !t || !d.tiers[t]) { res.status(404).json({ error: 'No such workflow.' }); return; }
    const dep = deps();
    const { target, why } = await locate(dep);
    if (!target) { res.status(409).json({ error: why ?? 'ComfyUI closed. Open it again, then press Check again.', code: 'comfy-closed' }); return; }
    const plan = await makePlan(dep, target, d.id, t);
    if (!consent.take(req.body?.token, plan)) { res.status(403).json({ error: 'That OK has expired or the list changed. Look at the list again, then press Yes.', consent: true }); return; }
    try {
      const job = jobs.start(plan);
      const q = typeof req.body?.request === 'string' ? requests.get(req.body.request) : undefined;
      if (q && q.workflow === d.id && q.tier === t) q.jobId = job.id; // only the recipe the AI asked for (never another one)
      res.json({ ok: true, job });
    } catch (e) { res.status((e as { status?: number }).status ?? 500).json({ error: (e as Error).message }); }
  });

  r.post('/api/comfy-workflows/add', async (req, res) => {
    noStore(res);
    if (!fromPage(req)) { res.status(403).json({ error: 'Press the button on VTube Pro’s page on this computer.', code: 'local-only' }); return; }
    const d = workflowDef(String(req.body?.workflow ?? '')); const t = tierOf(req.body?.tier);
    if (!d || !t || !d.tiers[t]) { res.status(404).json({ error: 'No such workflow.' }); return; }
    await refreshSettings();
    const dep = deps();
    const { target, why } = await locate(dep);
    if (!target) { res.status(409).json({ error: why ?? 'ComfyUI isn\'t open. Open ComfyUI, then press Check again.', code: 'comfy-closed', comfy: false }); return; }
    // Never replaces a workflow of that name unasked: the user may have saved their own changes over it (Ctrl+S in ComfyUI).
    // The page then offers "Replace it with the original", which sends replace:true.
    const replace = req.body?.replace === true;
    try {
      const name = await addWorkflowToComfy(dep, target.url, d, t, undefined, undefined, { overwrite: replace });
      res.json({ ok: true, replaced: replace, name: name.replace(/\.json$/, ''), folder: workflowsFolder(target) });
    } catch (e) {
      const code = e instanceof SetupError ? e.code : 'other';
      res.status(code === 'exists' ? 409 : 502).json({ error: (e as Error).message, code });
    }
  });

  r.post('/api/comfy-workflows/requests', async (req, res) => {
    noStore(res);
    if (!isLocalOrigin(originOf(req))) { res.status(403).json({ error: 'local only', code: 'local-only' }); return; }
    const d = workflowDef(String(req.body?.workflow ?? '')); const t = tierOf(req.body?.tier);
    if (!d) { res.status(404).json({ error: `No workflow "${req.body?.workflow}". Workflows: ${allKeys().map((k) => k.def.id).filter((x, i, a) => a.indexOf(x) === i).join(', ')}` }); return; }
    if (!t || !d.tiers[t]) { res.status(400).json({ error: 'Pick a size: small (8 GB), medium (16 GB) or large (24 GB).' }); return; }
    sweep();
    if (requests.size > 20) requests.clear();
    const q: PendingRequest = { id: crypto.randomBytes(9).toString('base64url'), workflow: d.id, tier: t, at: deps().now() };
    requests.set(q.id, q);
    const pageUrl = `http://127.0.0.1:${PORT()}/comfyui?request=${q.id}`;
    let opened = false;
    if (req.body?.open === true && o.openUrl) { try { await o.openUrl(pageUrl); opened = true; } catch { /* the AI shows the link */ } }
    await refreshSettings();
    const dep = deps();
    const { target, why } = await locate(dep);
    const plan = target ? await makePlan(dep, target, d.id, t) : null;
    res.json({ request: q, pageUrl, opened, comfy: !!target, plan, ...(why ? { why } : {}) });
  });

  return r;
}
