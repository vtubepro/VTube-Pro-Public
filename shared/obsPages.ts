// Which output pages are attached to the helper's bus, and which of them run inside OBS (lane obs-web).
// The output page (src/output.ts) says hello on the bus with { role:'output', page, obs, w, h }; server/bus.ts keeps the
// latest hello per socket and answers GET /api/obs/outputs from it. This is how the studio can show
// "OBS is connected ✔" although OBS's browser (CEF) is a different browser than the one the studio runs in.
//
// Kinds:  obs     = an output page inside OBS (window.obsstudio exists: OBS's Browser Source)
//         browser = an output page in a normal browser tab (counts as "VTube Pro is showing", not as OBS)
//         preview = the studio's own preview iframe (output.html?preview=1): never counted
//         test    = ?sceneTest / test rigs: never counted
//         engine  = the VTube Pro Live engine's own embedded page (output.html?engine=1): counted like a browser tab, never as OBS
//                   (broadcast contract ENGINE_PAGE_KIND, shared/broadcastTypes.ts)
// Older output pages (built before this change: no `page` field) are counted as OBS pages: that is what output.html is
// for, and a helper whose dist/ wasn't rebuilt yet should still say "OBS is connected" (a browser tab can't be told apart).

export type OutputKind = 'obs' | 'browser' | 'preview' | 'test' | 'engine';
/** `gl` false = the page has no WebGL 2 (e.g. OBS on its OpenGL renderer / browser hardware acceleration off): it shows
 *  a "can't draw here" card instead of the avatar (src/outputNoGl.ts) and the doctor says how to fix OBS. */
export interface OutputPage { kind: OutputKind; w: number | null; h: number | null; obsVersion: string | null; since: number; seen: number; gl: boolean;
  /** the guest browser source's headless SENDER page (output.html?gsSend=1): a helper-owned page, never a studio or a real OBS page */
  gs?: boolean }
export interface OutputsSummary {
  /** Output pages that put VTube Pro on stream: OBS pages + browser tabs (not previews / tests). */
  count: number;
  /** Of those, the ones inside OBS (Browser Source). */
  inObs: number;
  /** Size of the first OBS page (the Browser Source Width × Height), else of the first counted page. */
  size: { w: number; h: number } | null;
  pages: { kind: OutputKind; w: number | null; h: number | null; obsVersion: string | null; for: number; gl: boolean }[];
  /** Of the counted pages, the ones that can't draw 3D (no WebGL 2): OBS shows them as a "can't draw here" card. */
  noGl: number;
}

const KINDS = new Set<OutputKind>(['obs', 'browser', 'preview', 'test', 'engine']);
const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 16384 ? Math.round(v) : null);

/** A raw bus frame → the output page it describes, or null (not an output hello). Cheap: only short JSON frames
 *  that start like a hello are parsed (the bus relays ~60 tracking frames a second without parsing them). */
export function parseOutputHello(raw: string, now = Date.now()): OutputPage | null {
  if (raw.length > 600 || !raw.startsWith('{"type":"hello"')) return null;
  let m: Record<string, unknown>;
  try { m = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  if (m.type !== 'hello' || m.role !== 'output') return null;
  const page = typeof m.page === 'string' && KINDS.has(m.page as OutputKind) ? (m.page as OutputKind) : null;
  // an older page without `page` (dist/ not rebuilt yet): assume OBS, unless it says it isn't
  const kind: OutputKind = page ?? (m.obs === false ? 'browser' : 'obs');
  const ver = typeof m.obsVersion === 'string' && /^[\w.+-]{1,24}$/.test(m.obsVersion) ? m.obsVersion : null;
  return { kind, w: dim(m.w), h: dim(m.h), obsVersion: ver, since: now, seen: now, gl: m.gl !== false, ...(m.gs === true ? { gs: true } : {}) };
}

export function summarizeOutputs(pages: Iterable<OutputPage>, now = Date.now()): OutputsSummary {
  const list = [...pages].filter((p) => p.kind === 'obs' || p.kind === 'browser' || p.kind === 'engine');
  list.sort((a, b) => (a.kind === b.kind ? a.since - b.since : a.kind === 'obs' ? -1 : 1));
  const first = list.find((p) => p.w && p.h) ?? null;
  return {
    count: list.length,
    inObs: list.filter((p) => p.kind === 'obs').length,
    size: first ? { w: first.w!, h: first.h! } : null,
    pages: list.map((p) => ({ kind: p.kind, w: p.w, h: p.h, obsVersion: p.obsVersion, for: Math.max(0, Math.round((now - p.since) / 1000)), gl: p.gl !== false })),
    noGl: list.filter((p) => p.gl === false).length,
  };
}

/** What the output page itself says in its hello (browser side; src/output.ts). */
export function outputHelloFields(q: URLSearchParams, win: { obsstudio?: { pluginVersion?: unknown }; innerWidth: number; innerHeight: number }) {
  const preview = q.has('preview');
  const gs = q.get('gsSend') === '1';
  const test = q.has('sceneTest') || (q.get('test') === '1' && q.has('avatar')) || gs;   // gsSend: the guest browser source's headless sender is not a real OBS page, so it must not count as an output
  const obs = !!win.obsstudio;
  const engine = q.get('engine') === '1';   // the engine's embedded page (VTube Pro Live, Phase 2) says so in its URL
  const page: OutputKind = preview ? 'preview' : test ? 'test' : engine ? 'engine' : obs ? 'obs' : 'browser';
  const v = win.obsstudio?.pluginVersion;
  return { page, obs, w: Math.round(win.innerWidth), h: Math.round(win.innerHeight), ...(typeof v === 'string' ? { obsVersion: v.slice(0, 24) } : {}), ...(gs ? { gs: true } : {}) };   // (gs: server/bus.ts leaves the sender out of busClientCount)
}
