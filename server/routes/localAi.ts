// Local AI recommender (helper side). Page + API:
//   GET  /local-ai                    the "Local AI" helper page (server/localAiPage.ts): ask -> scan -> recommend -> install steps
//   GET  /api/local-ai/catalog        the dated catalogue (models, runners, ComfyUI setups, nodes, workflows, sources)
//   POST /api/local-ai/scan           {consent:true} -> read-only hardware scan (server/hwScan.ts) + recommendation.
//                                     Without consent:true -> 400. The result lives in memory only (never on disk).
//   POST /api/local-ai/recommend      {facts:{os,vramGB,ramGB,gpuVendor,gpuName?,appleSilicon?}} -> recommendation (no scan)
//   GET  /api/local-ai/last           the last scan of this helper run (or {scanned:false})
//   POST /api/local-ai/forget         drop the scan (and stop sharing it)
//   POST /api/local-ai/share          {on} let AI assistants connected to the helper see a SHORT summary (off by default)
//   GET  /api/local-ai/shared         that summary for the MCP tools ({shared:false} unless the user switched it on)
//   GET  /api/local-ai/detect         is Ollama / LM Studio / ComfyUI running here, which models are pulled
// Everything is read-only towards the PC. Nothing here downloads or installs anything: the page only shows official
// links and steps.
import { Router } from 'express';
import { CATALOG_CHECKED, CATALOG_VERSION, COMFY_NODES, COMFY_SETUPS, IMAGE_MODELS, LLM_MODELS, RUNNERS, SOURCES } from '../../shared/localAi/catalog.ts';
import { budgetOf, hwFromFacts, primaryGpu, recommend, type HwInfo } from '../../shared/localAi/recommend.ts';
import { WORKFLOWS } from '../../shared/localAi/workflows.ts';
import { scanHardware, type ScanEnv } from '../hwScan.ts';
import { LOCAL_AI_PAGE } from '../localAiPage.ts';

export const localAiRoutes = Router();
const noStore = (res: { setHeader: (k: string, v: string) => void }) => res.setHeader('Cache-Control', 'no-store');
const FRAME_ANCESTORS = "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191";

// ---- in-memory state (this helper run only)
let last: { hw: HwInfo; at: number } | null = null;
let share = false;
let inflight: Promise<HwInfo> | null = null;
let scanEnv: (() => ScanEnv) | null = null;
/** Tests / the preview harness swap the probe I/O for recorded outputs. */
export function setScanEnv(f: (() => ScanEnv) | null) { scanEnv = f; }
export function resetLocalAi() { last = null; share = false; inflight = null; }

/** The short, non-identifying summary an AI may see when the user allows it. */
export function sharedFacts(hw: HwInfo) {
  const g = primaryGpu(hw.gpus);
  return {
    os: hw.os,
    gpuVendor: g?.vendor ?? null,
    gpuName: g?.name ?? null,
    vramGB: g?.vramGB ?? null,
    appleSilicon: !!g?.unified,
    ramGB: Math.round(hw.ramGB),
    tier: budgetOf(hw).tier,
  };
}

localAiRoutes.get('/local-ai', (_req, res) => {
  noStore(res);
  res.setHeader('Content-Security-Policy', FRAME_ANCESTORS);
  res.type('html').send(LOCAL_AI_PAGE);
});

localAiRoutes.get('/api/local-ai/catalog', (_req, res) => {
  res.json({ version: CATALOG_VERSION, checked: CATALOG_CHECKED, runners: RUNNERS, llm: LLM_MODELS, image: IMAGE_MODELS, setups: COMFY_SETUPS, nodes: COMFY_NODES, workflows: WORKFLOWS, sources: SOURCES });
});

localAiRoutes.post('/api/local-ai/scan', async (req, res) => {
  noStore(res);
  if (req.body?.consent !== true) {
    res.status(400).json({ error: 'The scan needs your OK first: click "Yes, scan my computer".', consent: false });
    return;
  }
  try {
    inflight ??= scanHardware(scanEnv?.() ?? undefined).finally(() => { inflight = null; });
    const hw = await inflight;
    last = { hw, at: Date.now() };
    res.json({ scanned: true, at: last.at, hw, rec: recommend(hw), share });
  } catch (e) {
    res.status(500).json({ error: `The scan did not finish (${e instanceof Error ? e.message : String(e)}). Try again, or type your details in instead.` });
  }
});

localAiRoutes.post('/api/local-ai/recommend', (req, res) => {
  noStore(res);
  const f = req.body?.facts ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2048 ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : undefined);
  const hw = hwFromFacts({ os: str(f.os), vramGB: num(f.vramGB), ramGB: num(f.ramGB), gpuVendor: str(f.gpuVendor), gpuName: str(f.gpuName), appleSilicon: f.appleSilicon === true });
  res.json({ scanned: false, hw, rec: recommend(hw) });
});

localAiRoutes.get('/api/local-ai/last', (_req, res) => {
  noStore(res);
  if (!last) { res.json({ scanned: false, share: false }); return; }
  res.json({ scanned: true, at: last.at, hw: last.hw, rec: recommend(last.hw), share });
});

localAiRoutes.post('/api/local-ai/forget', (_req, res) => { last = null; share = false; res.json({ ok: true }); });

localAiRoutes.post('/api/local-ai/share', (req, res) => {
  if (req.body?.on === true && !last) { res.status(409).json({ error: 'Scan first, then you can share the summary.' }); return; }
  share = req.body?.on === true;
  res.json({ share });
});

localAiRoutes.get('/api/local-ai/shared', (_req, res) => {
  noStore(res);
  res.json(share && last ? { shared: true, at: last.at, facts: sharedFacts(last.hw) } : { shared: false });
});

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
localAiRoutes.get('/api/local-ai/detect', async (_req, res) => {
  noStore(res);
  const [ol, lm, cfPortable, cfDesktop] = await Promise.all([
    getJson('http://127.0.0.1:11434/api/tags'),
    getJson('http://127.0.0.1:1234/v1/models'),
    getJson('http://127.0.0.1:8188/system_stats'),
    getJson('http://127.0.0.1:8000/system_stats'),
  ]);
  // port 8000 is common for other dev servers: only a ComfyUI-shaped /system_stats counts
  const isComfy = (j: any) => !!j && typeof j === 'object' && (!!j.system || Array.isArray(j.devices));
  const cfPortableOk = isComfy(cfPortable), cfDesktopOk = isComfy(cfDesktop);
  res.json({
    ollama: { running: !!ol, models: ((ol?.models ?? []) as { name?: string }[]).map((m) => String(m.name ?? '')).filter(Boolean).slice(0, 100) },
    lmstudio: { running: !!lm, models: ((lm?.data ?? []) as { id?: string }[]).map((m) => String(m.id ?? '')).filter(Boolean).slice(0, 100) },
    comfy: { running: cfPortableOk || cfDesktopOk, url: cfPortableOk ? 'http://127.0.0.1:8188' : cfDesktopOk ? 'http://127.0.0.1:8000' : null },
  });
});
