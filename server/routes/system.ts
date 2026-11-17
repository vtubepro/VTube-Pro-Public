// GET/PUT /api/settings (ComfyUI address, workflow, Blender path), GET /api/status
import { Router } from 'express';
import type { ComfyCharacterStatus, ServerStatus } from '../../shared/types.ts';
import { blenderInfo } from '../blender.ts';
import { readyTier, setupUrl } from '../comfyCharacter.ts';
import { lookupComfy, realInstallDeps, savedComfy, type InstallDeps } from '../comfyInstall.ts';
import { pickWorkflow } from '../providers/comfy.ts';
import { loadSettings, publicSettings, updateSettings } from '../settings.ts';
import { HttpError } from '../library.ts';
import { broadcast, busClientCount } from '../bus.ts';

export const systemRoutes = Router();

systemRoutes.get('/api/settings', (_req, res) => {
  res.json(publicSettings());
});

systemRoutes.put('/api/settings', (req, res) => {
  if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'Expected a JSON object');
  res.json(updateSettings(req.body));
});

async function probeComfy(url: string, f: typeof fetch = fetch) {
  try {
    await f(`${url.replace(/\/+$/, '')}/system_stats`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}
// Every open studio view asks GET /api/status (Create every 4 s, the shell, the simple view): one probe (a loopback
// connect, or ComfyUI gathering its GPU stats) answers the callers of the next 3 s, and callers that come while it runs
// share it. A changed ComfyUI address (or workflow name) is probed at once.
// ComfyUI is found like the Workflows page and the comfy provider find it: the Settings address is THE ComfyUI (on this
// computer or another; a slow answer is not "closed", and it is never swapped for another install); only a closed Settings
// address on this computer moves on to 8000 (ComfyUI Desktop), then 8188. `character` says whether a character can be made:
// the built-in Character 3D needs its Hunyuan3D model files (a stat per file; see comfyCharacter.ts), but the user's OWN workflow file (Settings "comfyWorkflow") runs without
// them, so then it is ready with `own: true`. It follows what the provider will really run (providers/comfy.ts pickWorkflow).
const COMFY_REUSE_MS = 3000;
export interface ComfyView { url: string; reachable: boolean; character?: ComfyCharacterStatus }
/** What /api/status says about ComfyUI (no caching; tools/comfy_provider_unit.ts calls it with a pretend ComfyUI). `workflow` =
 *  Settings "comfyWorkflow" (default: the saved one). */
export async function comfyStatusFor(url: string, deps: InstallDeps = realInstallDeps(() => url), workflow: string | null | undefined = loadSettings().comfyWorkflow): Promise<ComfyView> {
  const own = !!pickWorkflow(workflow).own;
  const look = await lookupComfy(deps);
  if (look.kind === 'local') {
    const target = look.target;
    const tier = own ? null : readyTier(target);
    return { url: target.url, reachable: true, character: { ready: own || !!tier, tier, setupUrl: setupUrl(target), ...(own ? { own: true } : {}) } };
  }
  // the Settings ComfyUI is open but too busy to answer: that is the answer (not "closed", and not another install)
  if (look.kind === 'slow') return { url: look.url, reachable: false };
  // an old ComfyUI without /internal/folder_paths, or one on another computer, still counts as running; we cannot look
  // into its folders, so another computer's ComfyUI is trusted (the job says so if a model is missing)
  if (look.kind === 'blind') return { url: look.url, reachable: true, character: { ready: own || !look.local, tier: null, setupUrl: setupUrl(null), ...(own ? { own: true } : {}) } };
  const reachable = await probeComfy(url, deps.fetch);
  return reachable ? { url, reachable, character: { ready: own || !(savedComfy(url)?.local ?? false), tier: null, setupUrl: setupUrl(null), ...(own ? { own: true } : {}) } } : { url, reachable };
}
let comfyLast: { key: string; at: number; v: ComfyView } | null = null;
let comfyProbe: { key: string; p: Promise<ComfyView> } | null = null;
function comfyView(url: string, workflow: string | undefined): Promise<ComfyView> {
  const key = JSON.stringify([url, workflow?.trim() ?? '']);
  if (comfyLast?.key === key && Date.now() - comfyLast.at < COMFY_REUSE_MS) return Promise.resolve(comfyLast.v);
  if (comfyProbe?.key === key) return comfyProbe.p;
  const p = comfyStatusFor(url, undefined, workflow).then((v) => { comfyLast = { key, at: Date.now(), v }; return v; });
  comfyProbe = { key, p };
  void p.finally(() => { if (comfyProbe?.p === p) comfyProbe = null; });
  return p;
}

systemRoutes.get('/api/status', async (_req, res) => {
  const s = loadSettings();
  const [blender, comfy] = await Promise.all([blenderInfo(), comfyView(s.comfyUrl, s.comfyWorkflow)]);
  const status: ServerStatus = {
    blender: blender ? { available: true, path: blender.path, version: blender.version } : { available: false },
    comfy,
  };
  res.json(status);
});

// POST /api/command {command, args?} → broadcast {type:'command'} on the bus (used by the MCP server / remote control).
systemRoutes.post('/api/command', (req, res) => {
  const { command, args } = (req.body ?? {}) as { command?: unknown; args?: unknown };
  if (typeof command !== 'string' || !command) throw new HttpError(400, 'Body must include { command: string, args? }');
  broadcast({ type: 'command', command, args });
  res.json({ ok: true, clients: busClientCount() });
});
