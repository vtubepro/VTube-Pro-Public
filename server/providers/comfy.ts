// Local ComfyUI provider ("Create my character" with ComfyUI). By default it runs VTube Pro's own Character 3D workflow
// (shared/comfyWorkflows/catalog.ts 'character-3d'): a picture in, a 3D model (.glb) out. The graph is built in code, so
// there is no workflow file to ship or to lose; what ComfyUI needs are the Hunyuan3D model files, which "Set it up for me"
// on the helper's ComfyUI page puts in its folders after the user's own Yes (and a licence notice). Without them the job
// fails with one plain sentence and a fixUrl that opens that page.
//
// Advanced: settings.comfyWorkflow = "<name>" runs config/comfy_workflows/<name>.json instead (an API-format workflow
// with "{{PROMPT}}" / "{{IMAGE}}" placeholder strings). It is looked for in the data folder, then in the install folder.
// The old example file (hunyuan3d_image_to_glb.json, unchanged) is a starting point that never ran as shipped: it counts
// as "not customised" and the built-in workflow is used instead.
// ComfyUI is found like the Workflows page finds it: the Settings address is THE ComfyUI (on this computer or another: never
// swapped for a different install, and a slow answer is waited for); only a closed Settings address on this computer moves on to
// 8000 (ComfyUI Desktop), then 8188.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMFY_WORKFLOWS_DIR, ROOT } from '../paths.ts';
import { loadSettings } from '../settings.ts';
import { lookupComfy, realInstallDeps, type InstallDeps } from '../comfyInstall.ts';
import { characterBuild, readyTier, setupGB, setupTier, setupUrl } from '../comfyCharacter.ts';
import type { ProviderRun } from './util.ts';
import { buildPrompt, extForMime, finishAvatar, parseDataUrl, poll } from './util.ts';

/** An error with a helper page that fixes it (jobs.ts copies `fixUrl` onto the failed job; the studio shows a button). */
export class FixableError extends Error {
  constructor(message: string, public fixUrl?: string) { super(message); this.name = 'FixableError'; }
}

/** SHA-256 of the example workflow this repo shipped before the built-in one (a migrated copy of it is not "customised"). */
export const STOCK_EXAMPLE_SHA256 = '257ba1ed33b6db5d0d657c86ac44264146e739f12ab369d7fde59f5ed441c839';
const DEFAULT_CUSTOM = 'hunyuan3d_image_to_glb';

/** Deep-replace placeholder strings; keys starting with "_" (e.g. "_README") are dropped. */
function substitute(node: unknown, vars: Record<string, string>): unknown {
  if (typeof node === 'string') return Object.entries(vars).reduce((s, [k, v]) => s.split(k).join(v), node);
  if (Array.isArray(node)) return node.map((n) => substitute(n, vars));
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, substitute(v, vars)]),
    );
  }
  return node;
}

interface ComfyFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

/** Find the first output entry that looks like a .glb file anywhere in the history outputs. */
function findGlb(outputs: unknown): ComfyFile | null {
  if (!outputs || typeof outputs !== 'object') return null;
  if (Array.isArray(outputs)) {
    for (const o of outputs) {
      const f = findGlb(o);
      if (f) return f;
    }
    return null;
  }
  const o = outputs as Record<string, unknown>;
  if (typeof o.filename === 'string' && /\.glb$/i.test(o.filename)) return o as unknown as ComfyFile;
  for (const v of Object.values(o)) {
    const f = findGlb(v);
    if (f) return f;
  }
  return null;
}

/** The user's own workflow file, if there is one to run: the data folder first, then the install folder (a source install
 *  and the old layout keep it there). `stock` = byte-identical to the old example, which is not a customised file. */
export function customWorkflow(name: string): { file: string; stock: boolean } | null {
  if (!/^[\w .()-]+$/.test(name) || name.includes('..')) return null;
  for (const dir of [COMFY_WORKFLOWS_DIR, path.join(ROOT, 'config', 'comfy_workflows')]) {
    const file = path.join(dir, `${name}.json`);
    try {
      const sum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      return { file, stock: sum === STOCK_EXAMPLE_SHA256 };
    } catch { /* not here */ }
  }
  return null;
}

/** Which workflow a job will run for this Settings value: the user's own file (`own`), or VTube Pro's built-in Character 3D
 *  (`own` null). `missing` = Settings names a file that is not there (the job says so). GET /api/status uses the same answer,
 *  so the Create button follows what will really run. */
export function pickWorkflow(setting: string | null | undefined): { asked: string; missing: boolean; own: { file: string; stock: boolean } | null } {
  const asked = setting?.trim() ?? '';
  const custom = customWorkflow(asked || DEFAULT_CUSTOM);
  return { asked, missing: !!asked && !custom, own: custom && !custom.stock ? custom : null };
}

async function readJson(res: Response, what: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = body?.message ?? body?.error?.message ?? body?.error ?? body?.detail ?? text.slice(0, 300);
    throw Object.assign(new Error(`${what} failed (HTTP ${res.status}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`), { body, text });
  }
  return body;
}

export interface ComfyProviderDeps {
  /** ComfyUI's network (and the Settings address). Default: real fetch + the saved Settings. */
  deps?: InstallDeps;
  /** Turns the downloaded .glb into a library avatar (tests stop before it). */
  finish?: typeof finishAvatar;
}

export function makeRunComfy(o: ComfyProviderDeps = {}): ProviderRun {
  return async (_job, req, ctx) => {
    const s = loadSettings();
    const deps = o.deps ?? realInstallDeps(() => loadSettings().comfyUrl);
    const finish = o.finish ?? finishAvatar;
    const configured = (deps.comfyUrl() || 'http://127.0.0.1:8188').replace(/\/+$/, '');

    // 1. which workflow: the user's own file, or VTube Pro's Character 3D
    const { asked, missing, own } = pickWorkflow(s.comfyWorkflow);
    if (missing) throw new Error(`ComfyUI workflow not found: config/comfy_workflows/${asked}.json. Put your file in ${COMFY_WORKFLOWS_DIR}, or clear "comfyWorkflow" in Settings to use VTube Pro's own Character 3D.`);

    // 2. find ComfyUI: the Settings address is THE ComfyUI (a job may wait for a busy one); only a closed one on this computer moves on to 8000, then 8188
    const look = await lookupComfy(deps, { waitMs: 15_000 });
    if (look.kind === 'slow') throw new Error(`ComfyUI at ${look.url} is open but is not answering. It may be busy loading a model: wait a minute, then try again.`);
    const found = look.kind === 'local' ? look.target : null;
    let base = found?.url ?? (look.kind === 'blind' ? look.url : configured);
    if (look.kind === 'none') {
      try { await deps.fetch(`${configured}/system_stats`, { signal: AbortSignal.timeout(3000) }); }
      catch { throw new Error(`ComfyUI is not reachable at ${configured}. Start ComfyUI or fix the URL in Settings.`); }
      base = configured;
    }

    // 3. the picture goes up to ComfyUI
    const vars: Record<string, string> = { '{{PROMPT}}': buildPrompt(req, 2000) };
    if (!own && !req.images?.length) throw new FixableError('Add a picture of your character. ComfyUI turns a picture into 3D: it can\'t build a character from words alone.');
    // built-in workflow: the biggest size whose model files are in ComfyUI's folders. A ComfyUI we cannot look into (another
    // computer on the home network) is trusted: it will say so itself if a model is missing.
    const tier = own ? null : found ? readyTier(found) : setupTier(null);
    if (!own && !tier) {
      const want = setupTier(found);
      throw new FixableError(`ComfyUI doesn't have the 3D model yet. Press "Set it up for me" to add it (one time, about ${setupGB(want)} GB).`, setupUrl(found));
    }
    let uploaded = '';
    if (req.images?.length) {
      const img = parseDataUrl(req.images[0]);
      const form = new FormData();
      form.append('image', new Blob([new Uint8Array(img.buffer)], { type: img.mime }), `vtp_${ctx.job.id}${extForMime(img.mime)}`);
      form.append('overwrite', 'true');
      const up = await readJson(await deps.fetch(`${base}/upload/image`, { method: 'POST', body: form }), 'ComfyUI image upload');
      uploaded = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
      vars['{{IMAGE}}'] = uploaded;
      ctx.log(`Uploaded reference image as ${uploaded}`);
    }

    // 4. the graph
    let graph: unknown;
    let label: string;
    if (own) {
      const raw = JSON.parse(fs.readFileSync(own.file, 'utf8'));
      if (JSON.stringify(raw).includes('{{IMAGE}}') && !uploaded) throw new Error(`Workflow '${path.basename(own.file, '.json')}' needs a reference image`);
      graph = substitute(raw, vars);
      label = `your workflow ${path.basename(own.file, '.json')}`;
    } else {
      const built = characterBuild(tier!);
      const api = structuredClone(built.api);
      const pic = built.manifest.inputs.find((i) => i.kind === 'image')!;
      api[pic.node].inputs.image = uploaded;
      graph = api;
      label = `VTube Pro Character 3D (${built.manifest.vram.label} size)`;
    }

    // 5. queue it
    const clientId = crypto.randomUUID();
    let queued: any;
    try {
      queued = await readJson(await deps.fetch(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId }) }), 'ComfyUI /prompt');
    } catch (e) {
      // a missing model is a "set it up" problem, not a mystery: say so in plain words
      if (!own && /value_not_in_list|not in \[|ckpt_name/.test(String((e as { text?: string }).text ?? (e as Error).message))) throw new FixableError(`ComfyUI doesn't have the 3D model yet. Press "Set it up for me" to add it (one time, about ${setupGB(tier!)} GB).`, setupUrl(found));
      throw e;
    }
    if (queued.node_errors && Object.keys(queued.node_errors).length) {
      const text = JSON.stringify(queued.node_errors);
      if (!own && /value_not_in_list|not in \[|ckpt_name/.test(text)) throw new FixableError(`ComfyUI doesn't have the 3D model yet. Press "Set it up for me" to add it (one time, about ${setupGB(tier!)} GB).`, setupUrl(found));
      throw new Error(`ComfyUI rejected the workflow: ${text.slice(0, 500)}`);
    }
    const promptId: string = queued.prompt_id;
    ctx.log(`Queued ComfyUI prompt ${promptId} (${label})`);

    let ticks = 0;
    const entry = await poll<any>(
      async () => {
        const hist = await readJson(await deps.fetch(`${base}/history/${promptId}`), 'ComfyUI /history');
        const e = hist?.[promptId];
        ctx.progress(Math.min(0.85, 0.05 + ++ticks * 0.01)); // Comfy's history has no progress; creep forward
        if (!e) return undefined;
        if (e.status?.status_str === 'error') {
          const msg = (e.status.messages ?? []).find((m: any[]) => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI execution error: ${msg?.exception_message ?? 'see ComfyUI console'}`);
        }
        return e.status?.completed || e.outputs ? e : undefined;
      },
      { what: 'ComfyUI workflow' },
    );
    const glb = findGlb(entry.outputs);
    if (!glb) throw new Error('ComfyUI finished but produced no .glb output (does the workflow end in a Save GLB node?)');
    const q = new URLSearchParams({ filename: glb.filename, subfolder: glb.subfolder ?? '', type: glb.type ?? 'output' });
    const dest = path.join(ctx.dir, 'comfy.glb');
    ctx.log(`Downloading ${glb.filename}`);
    const res = await deps.fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status}) from ${base}/view`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    ctx.progress(0.9);
    return finish(ctx, dest, { req, source: 'comfy' });
  };
}

export const runComfy: ProviderRun = makeRunComfy();
