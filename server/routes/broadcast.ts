// /api/broadcast/*: the VTube Pro Live control plane (Phase 1, workstream W2). Routes, access and wire format are in
// docs/BROADCAST_PROTOCOL.md section 7 and shared/broadcastTypes.ts (BROADCAST_ROUTES). Every route already sits behind
// server/localGuard.ts (mounted before all routes in server/index.ts); on top of that:
//   * read  : this PC's pages and tools;
//   * write : this PC's pages and tools;
//   * local : the Helper's own page on this PC only (/keys/*): 403 `local-only` for any web origin (a browser page
//             of another site) and for a tool without an Origin;
//   * every start goes through the Go Live service (server/broadcast/goLive.ts): a fresh single-use intent token or nothing.
// A stream key never appears in any answer, bus message or log line: answers pass through redact() as a last lock.
//
// The other workstreams are wired by INTERFACE (shared/broadcastTypes.ts) in loadDefaults: W1's pure modules (policy, health,
// preflight), W3's destinations / keys, W5's stamp aggregator. The built-in Go Live policy (goLive.ts) still runs
// next to W1's, and the first refusal wins.
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import { broadcast as busBroadcast, outputPages } from '../bus.ts';
import { isWebOrigin } from '../localGuard.ts';
import { CACHE_DIR } from '../paths.ts';
import type { BusMessage } from '../../shared/types.ts';
import {
  BROADCAST_CONTRACT_REV, FIX_LABEL, HEALTH_TEXT, SECRET_FIELDS,
  type ApiError, type ApiResult, type BackendChoiceRequest, type BackendStats, type BroadcastBusMessage, type BroadcastErrorCode, type BroadcastHealthApi,
  type BroadcastPolicyApi, type BroadcastPreflightApi, type BroadcastStatus, type DestinationInput, type DestinationsApi, type FixId, type FixResponse,
  type GoLivePlan, type HealthId, type HealthInputs, type HealthMachine, type HealthView, type IntentCheckInput, type IntentRequest, type KeyStoreApi,
  type PreflightFacts, type PreflightReport, type RouteAccess, type StampAggregatorApi, type StampStats,
} from '../../shared/broadcastTypes.ts';
import { createBackendHolder, ENGINE_AVAILABLE, registerBackendHolder, type BackendHolder } from '../broadcast/backend.ts';
import { engineSupervisor, type EngineSupervisor } from '../broadcast/engineSupervisor.ts';
import { builtinPolicy, createGoLiveService, type GoLiveService } from '../broadcast/goLive.ts';
import { createJournal } from '../broadcast/journal.ts';
import { obsBackend } from '../broadcast/obsBackend.ts';
import { addressCarriesKey, destinations as destinationStore, parseIngestUrl } from '../broadcast/destinations.ts';
import { keyStore, keyWriteAllowed } from '../broadcast/keys.ts';
import { stampAggregator } from '../broadcast/stamps.ts';
import { canonicalPlan, checkIntent, mayStart } from '../../shared/broadcastPolicy.ts';
import { healthView, initialHealth, reconnectDelayS, stepHealth } from '../../shared/broadcastHealth.ts';
import { evaluatePreflight, hideNoDataRows } from '../../shared/broadcastPreflight.ts';
import { canProbeSetup, readDiagState, setupFactsFrom, UploadMemo, type DiagSnap } from '../broadcast/setupFacts.ts';

// the stream keys are entered on this PC only, never from a website

// ---------------------------------------------------------------- small pure helpers (exported for the e2e)

export type Origin = IntentCheckInput['origin'];

/** Did a BROWSER send this request from one of this PC's own pages? A browser stamps every fetch with Sec-Fetch-Site / -Mode / -Dest
 *  and a page cannot change them; a program that merely types "Origin: http://127.0.0.1:5191" does not carry them, so it stays a
 *  'tool' and a tool can never press Go Live. HONEST LIMIT (docs/BROADCAST_PROTOCOL.md section 1.1): this is not a lock against a
 *  program on this PC that forges these headers as well. Such a program can already read your files and drive OBS directly; Go Live
 *  stops websites, other devices, AI tools (MCP), macros, schedules, relays and scripts that do not pretend to be a browser. */
export function fromOwnPage(headers: Request['headers']): boolean {
  const h = (n: string) => String(headers[n] ?? '').toLowerCase();
  return (h('sec-fetch-site') === 'same-origin' || h('sec-fetch-site') === 'same-site') && (h('sec-fetch-mode') === 'cors' || h('sec-fetch-mode') === 'same-origin') && h('sec-fetch-dest') === 'empty';
}

/** Who is asking, from the connection (never the body). */
export function originOf(req: Pick<Request, 'headers'> & { socket?: { remoteAddress?: string } }): Origin {
  const o = req.headers.origin;
  if (typeof o === 'string' && o !== '') return isWebOrigin(o) ? 'foreign-web' : fromOwnPage(req.headers) ? 'local-page' : 'tool';
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (site === 'cross-site' || site === 'same-site') return 'foreign-web';      // a no-cors fetch from another site sends no Origin
  return 'tool';                                                                   // curl, Stream Deck, MCP, Streamer.bot ...
}

const STATUS: Partial<Record<BroadcastErrorCode, number>> = {
  'bad-request': 400, 'not-found': 404, 'internal': 500,
  'no-token': 403, 'token-expired': 403, 'token-replayed': 403, 'token-mismatch': 403, 'source-not-allowed': 403, 'not-confirmed': 403, 'foreign-origin': 403, 'local-only': 403,
  'other-live': 409, 'already-live': 409, 'not-live': 409, 'busy': 409, 'preflight-blocked': 409, 'no-destination': 409, 'no-key': 409,
  'backend-unreachable': 502, 'backend-refused': 502,
};
export const statusOf = (code: BroadcastErrorCode): number => STATUS[code] ?? 500;

const SECRET_SET = new Set(SECRET_FIELDS.map((f) => f.toLowerCase()));
/** Last lock: drop any property with a secret-looking name from an answer. `keepToken`: the intent token IS the answer of /intent. */
export function redact(v: unknown, keepToken = false, depth = 0): unknown {
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, keepToken, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const lk = k.toLowerCase();
    if (SECRET_SET.has(lk) && !(keepToken && lk === 'token')) continue;
    out[k] = redact(x, keepToken, depth + 1);
  }
  return out;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const fail = (code: BroadcastErrorCode, error: string): ApiError => ({ ok: false, code, error });
const race = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p.catch(() => fallback), new Promise<T>((r) => { const t = setTimeout(() => r(fallback), ms); t.unref?.(); })]);

const KEY_NOTE = 'OBS keeps your stream key in its own settings on this computer. VTube Pro sends it to OBS only when you press Go Live, and never shows it again. Whatever your OBS was set to stream to before is put back when the show ends.';
/** A stream key as people paste it: no spaces, a sensible length. */
export const goodKey = (k: unknown): k is string => typeof k === 'string' && k.trim().length >= 6 && k.trim().length <= 512 && !/[\s\u0000-\u001f]/.test(k.trim());
const goodUrl = (u: string) => u === '' || (u.length <= 300 && /^(rtmps?|srt):\/\/[^\s]+$/i.test(u));

const FIX_TEXT: Record<FixId, { say: string; next: FixResponse['next'] }> = {
  'start-backend': { say: 'Open OBS, then press Check my setup again. (The VTube Pro Live Engine is coming soon.)', next: 'none' },
  'open-obs-help': { say: 'In OBS open Tools, then WebSocket Server Settings and tick Enable. Then open the Set up OBS page and press Find it for me.', next: 'none' },
  'add-avatar-page': { say: 'Add a Browser Source in OBS that shows VTube Pro. The Set up OBS page does it for you.', next: 'none' },
  'add-destination': { say: 'Add where you stream: Twitch, YouTube, Kick or your own address.', next: 'destination-editor' },
  'paste-key': { say: 'Paste your stream key for this destination. It stays on this computer.', next: 'key-paste' },
  'turn-on-tracking': { say: 'Turn on your camera in the VTube Pro studio so your avatar can follow you.', next: 'none' },
  'add-mic': { say: 'Pick your microphone in OBS, in the Audio Mixer.', next: 'none' },
  'rescue-capture': { say: 'Pick your whole screen instead of the game window, or restart the capture, on the Gaming card.', next: 'none' },
  'lower-quality': { say: 'Lower the picture size or the quality a little in OBS (Settings, Output).', next: 'none' },
  'lighter-avatar': { say: 'Pick a lighter picture quality for your avatar in the VTube Pro studio.', next: 'none' },
  'wake-avatar': { say: 'Open the VTube Pro studio and keep its tab open so your avatar keeps moving.', next: 'none' },
  'use-hardware-encoder': { say: 'In OBS, Settings, Output, pick your graphics card as the encoder.', next: 'none' },
  'free-disk': { say: 'Free some space on the drive where OBS saves recordings.', next: 'none' },
  'mute-desktop-audio': { say: 'Mute Desktop Audio in OBS so show sounds are not heard twice.', next: 'none' },
  'wait-other-broadcaster': { say: 'Stop the other broadcaster, then press Check my setup again.', next: 'none' },
};

// ---------------------------------------------------------------- dependencies

export interface BroadcastRouteDeps {
  goLive: GoLiveService;
  backends: BackendHolder;
  destinations: DestinationsApi;
  keys: Pick<KeyStoreApi, 'has' | 'set' | 'clear' | 'read'>;
  engine: EngineSupervisor;
  /** W1 (optional): health state machine, preflight rows. */
  health?: BroadcastHealthApi | null;
  preflight?: BroadcastPreflightApi | null;
  /** W5 (optional): page stamps. */
  stamps?: StampAggregatorApi | null;
  /** Helper -> this PC's studio pages. Default: the bus. */
  publish?: (m: BroadcastBusMessage) => void;
  /** The output pages the bus knows (avatar page in OBS?). Default: bus outputPages(). */
  pages?: () => { count: number; inObs: number; noGl: number };
  /** Redeems the Stream Deck key press behind a 'deck-confirmed' request (server/deck.ts deckGoLive.confirm): ok only for the real,
   *  unexpired, unused press, once. Absent = a deck-confirmed request is always refused. */
  deckConfirm?: (claimedPressedAt: unknown) => { ok: true } | { ok: false; code: 'not-confirmed'; say: string };
  /** The studio's last diagnostics drop (cache/diag/state.json): where tracking and the graphics card are read from. Default: the file. */
  readDiag?: () => Promise<DiagSnap | null>;
  /** When this Helper started (ms): a diagnostics file older than that says nothing about now. Default: process start. */
  bootMs?: number;
  now?: () => number;
  /** Poll the show once a second while one is on (default true; a test can drive tick itself). */
  autoTick?: boolean;
}

export interface BroadcastHub {
  router: Router;
  deps: BroadcastRouteDeps;
  /** Everything the status route would answer. */
  status(): Promise<BroadcastStatus>;
  healthView(): HealthView;
  dispose(): void;
}

const fallbackHealth = (id: HealthId, since: number): HealthView => ({ id, since, ...HEALTH_TEXT[id] });

export function createBroadcastHub(deps: BroadcastRouteDeps): BroadcastHub {
  const now = deps.now ?? Date.now;
  const publish = deps.publish ?? ((m: BroadcastBusMessage) => busBroadcast(m as unknown as BusMessage));
  const pages = deps.pages ?? (() => { const o = outputPages(); return { count: o.count, inObs: o.inObs, noGl: o.noGl }; });
  const { goLive, backends, destinations, keys } = deps;
  const router = Router();
  let lastReport: PreflightReport | null = null;
  const upload = new UploadMemo();
  const bootMs = deps.bootMs ?? Date.now() - process.uptime() * 1000;
  let machine: HealthMachine | null = null;
  let view: HealthView = fallbackHealth('idle', now());
  let timer: NodeJS.Timeout | null = null;
  let lastTickAt = 0;
  let ticking = false;
  let noticeSeq = 0;

  // ---------- the one-second loop, only while a show is on (an idle Helper polls nothing)
  const stampStats = (): StampStats | null => { try { return deps.stamps ? deps.stamps.stats(now()) : null; } catch { return null; } };
  const setHealth = (next: HealthView) => {
    const edge = next.id !== view.id;
    view = next;
    if (!edge) return;
    publish({ type: 'broadcast', k: 'health', h: view });
    if (view.tone === 'warn' || view.tone === 'bad') publish({ type: 'broadcast', k: 'notice', n: { id: `health-${++noticeSeq}`, at: now(), tone: view.tone, say: view.say } });
  };
  async function stepHealth() {
    const gl = goLive.state();
    const t = now();
    if (!goLive.isActive() || gl.dryRun) {
      machine = null;
      setHealth(fallbackHealth('idle', t));
      return;
    }
    const backend = backends.active();
    let stats: BackendStats | null = null;
    if (backend) stats = await race(backend.stats().catch(() => null), 2000, null);
    const bs = goLive.lastBackendStatus();
    // a real show's own numbers are the only "internet speed" the Helper keeps (no outside test; see server/broadcast/setupFacts.ts)
    upload.observe(t, { streaming: bs?.streaming ?? gl.phase === 'live', bitrateKbps: stats?.bitrateKbps ?? null, droppedFrac: stats?.droppedFrac ?? null });
    const st = stampStats();
    const inputs: HealthInputs = {
      at: t, streaming: bs?.streaming ?? gl.phase === 'live', outputReconnecting: gl.phase === 'reconnecting',
      fps: stats?.fps ?? null, targetFps: stats?.targetFps ?? null, droppedFrac: stats?.droppedFrac ?? null, encoderSkippedFrac: stats?.encoderSkippedFrac ?? null,
      renderSkippedFrac: stats?.renderSkippedFrac ?? null, bitrateKbps: stats?.bitrateKbps ?? null, targetKbps: stats?.targetKbps ?? null,
      gpuBusyPct: null, captureBlank: null, msSinceLastStamp: st?.msSinceLastStamp ?? null, poseAgeP95Ms: st?.poseAgeP95Ms ?? null, dupRatio: st?.dupRatio ?? null, frozenMs: st?.frozenMs ?? null,
    };
    if (deps.health) {
      machine = deps.health.stepHealth(machine ?? deps.health.initialHealth(t), inputs);
      setHealth(deps.health.healthView(machine));
    } else {
      setHealth(fallbackHealth(gl.phase === 'reconnecting' ? 'reconnecting' : gl.phase === 'live' ? 'smooth' : 'idle', t));
    }
    if (st && st.pages > 0) publish({ type: 'broadcast', k: 'stampstats', s: st });
  }
  async function loop() {
    if (ticking) return;
    ticking = true;
    try { await goLive.tick(); await stepHealth(); lastTickAt = now(); } catch { /* the next second tries again */ } finally { ticking = false; }
    if (!goLive.isActive()) stopTimer();
  }
  function startTimer() { if (timer || deps.autoTick === false) return; timer = setInterval(() => void loop(), 1000); timer.unref?.(); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } machine = null; view = fallbackHealth('idle', now()); }
  const offChange = goLive.onChange((s) => {
    publish({ type: 'broadcast', k: 'state', s: statusOf0(s) });
    if (goLive.isActive()) startTimer();
  });
  // the status shipped on the bus is the same object GET /status answers, built from what is known right now (no backend call)
  const statusOf0 = (s = goLive.state()): BroadcastStatus => ({
    contractRev: BROADCAST_CONTRACT_REV, choice: backends.choice(), backend: goLive.lastBackendStatus(), goLive: s, health: view, stamps: stampStats(),
    destinations: safeList(), keyNote: backends.choice() === 'obs' ? KEY_NOTE : null, engineAvailable: ENGINE_AVAILABLE,
    dryRunAvailable: safeBool(() => goLive.dryRunAvailable?.() === true),
  });
  function safeBool(f: () => boolean): boolean { try { return f(); } catch { return false; } }
  /** The list as the studio and the bus get it. Last lock: an address that carries a key (saved by an older build) is blanked. */
  function safeList() {
    try { return destinations.list().map((d) => (d.url && addressCarriesKey(d.url) ? { ...d, url: '' } : d)); } catch { return []; }
  }

  /** Bring the show up to date from the backend at most once a second (the studio's status poll, while its tab is visible). */
  async function freshen() {
    if (!backends.active() || now() - lastTickAt < 1000) return;
    lastTickAt = now();
    try { await goLive.tick(); } catch { /* unreachable is part of the status */ }
    if (goLive.isActive()) startTimer();
  }
  async function status(): Promise<BroadcastStatus> {
    await freshen();
    const backend = backends.active();
    let bs = goLive.lastBackendStatus();
    if (backend) { const s = await race(backend.status(), 2500, null); if (s) bs = s; }
    return { ...statusOf0(), backend: backend ? bs : null };
  }

  // ---------- access

  const originFor = (req: Request): Origin => originOf(req);
  const loopback = (req: Request) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '');
  function deny(access: RouteAccess, origin: Origin, req: Request): ApiError | null {
    if (origin === 'foreign-web') return fail(access === 'local' ? 'local-only' : 'foreign-origin', access === 'local'
      ? 'Your stream key and account links are only entered in VTube Pro on your computer, never on a website.'
      : 'This page is not allowed to control your stream. Open VTube Pro on your computer.');
    // keys, account links and a changed stream address: the Helper's own page only (a browser on this PC), never a website and never a
    // program without an Origin (curl, a Stream Deck/Companion HTTP action, a script, an AI tool). docs/BROADCAST_PROTOCOL.md section 7.
    if (access === 'local' && !keyWriteAllowed(origin).ok) return fail('local-only', origin === 'tool'
      ? 'Your stream key and account links are only entered in VTube Pro’s page on your computer, not by another program.'
      : 'Your stream key and account links are only entered in VTube Pro on your computer, never on a website.');
    if (!loopback(req)) return fail('foreign-origin', 'VTube Pro only answers on this computer.');
    return null;
  }
  type Sendable = ApiError | ({ ok: true } & Record<string, unknown>);
  const send = (res: Response, r: Sendable | ApiResult<object>, keepToken = false) => { res.status(r.ok ? 200 : statusOf(r.code)).json(redact(r, keepToken)); };

  type Handler = (req: Request, res: Response, origin: Origin) => Promise<void> | void;
  const route = (method: 'get' | 'post' | 'delete', p: string, access: RouteAccess, fn: Handler) => {
    router[method](`/api/broadcast${p}`, async (req: Request, res: Response) => {
      try {
        const origin = originFor(req);
        const no = deny(access, origin, req);
        res.setHeader('Cache-Control', 'no-store');
        if (no) { send(res, no); return; }
        await fn(req, res, origin);
      } catch (e) {
        console.warn(`[broadcast] ${req.method} ${req.path} failed (${(e as Error)?.name ?? 'error'})`);   // (name only: never a message that could carry a secret)
        if (!res.headersSent) send(res, fail('internal', 'Something went wrong. Try again in a moment.'));
      }
    });
  };

  // ---------- status, preflight, fixes

  route('get', '/status', 'read', async (_req, res) => { res.json(redact({ ok: true, ...(await status()) })); });
  route('get', '/preflight', 'read', (_req, res) => { send(res, { ok: true, report: lastReport }); });

  async function gatherFacts(accept: boolean): Promise<PreflightFacts> {
    const t = now();
    const choice = backends.choice(), backend = backends.active();
    const st = backend ? await race(backend.status(), 2500, null) : null;
    const stats = backend && st?.reachable ? await race(backend.stats(), 2500, null) : null;
    await race(goLive.tick(), 2500, undefined);
    const p = pages();
    void accept;
    // the facts the Helper already has (state.json from the studio, a few read-only OBS requests): no new polling, nothing outside
    const dests = safeList();
    const [diag, probe] = await Promise.all([
      race((deps.readDiag ?? readDiagState)(), 1500, null),
      backend && st?.reachable && canProbeSetup(backend) ? race(backend.setupProbe(), 6000, null) : Promise.resolve(null),
    ]);
    const sf = setupFactsFrom({
      now: t, bootMs, diag, probe, upload, canvas: st?.video ?? null,
      places: choice === 'engine' ? Math.max(1, dests.filter((d) => d.enabled).length) : 1,
    });
    return {
      at: t, backend: { kind: choice, reachable: backend ? st?.reachable ?? false : null, version: st?.version ?? null, authOk: backend && st ? st.reachable : null },
      otherBroadcasterLive: goLive.state().otherBroadcasterLive, destinations: dests, avatarPages: { count: p.count, inBackend: p.inObs, noGl: p.noGl },
      tracking: sf.tracking, mic: sf.mic, game: null, canvas: st?.video ?? null, gpu: sf.gpu, encoders: sf.encoders, upload: sf.upload,
      diskFreeGb: stats?.diskFreeMb != null ? Math.round(stats.diskFreeMb / 102.4) / 10 : diskFreeGb(),
      recordRequested: false, showSoundsHeardTwice: sf.showSoundsHeardTwice,
    };
  }
  route('post', '/preflight', 'write', async (req, res) => {
    if (!deps.preflight) { send(res, fail('internal', 'Check my setup is not ready in this build yet.')); return; }
    const facts = await gatherFacts(obj(req.body).acceptAmber === true);
    // rows the Helper has no facts for are left out instead of saying "I can't tell" (the verdict is the full one)
    lastReport = hideNoDataRows(deps.preflight.evaluatePreflight(facts, { acceptAmber: obj(req.body).acceptAmber === true }));
    send(res, { ok: true, report: lastReport });
  });
  route('post', '/fix', 'write', (req, res) => {
    const id = str(obj(req.body).fixId, 40) as FixId;
    const f = FIX_TEXT[id];
    if (!f || !(id in FIX_LABEL)) { send(res, fail('bad-request', 'I do not know that fix.')); return; }
    send(res, { ok: true, done: false, say: f.say, next: f.next });
  });

  // ---------- Go Live

  route('post', '/intent', 'write', (req, res, origin) => {
    const b = obj(req.body);
    const g = obj(b.gesture);
    const source = str(b.source, 24) as IntentRequest['source'];
    // A Stream Deck key is proven by THIS process, never by the page: the press was remembered when the key ran (server/deck.ts), and
    // the claimed time must be exactly that press, unexpired and unused (single use). Only a page of ours can ask (a tool never
    // reaches the policy with a click anyway), and the number the client sent is used for nothing else.
    let deckPressedAt: number | undefined;
    if (source === 'deck-confirmed') {
      const c = origin === 'local-page' && deps.deckConfirm ? deps.deckConfirm(b.deckPressedAt) : null;
      if (!c || !c.ok) {
        send(res, fail('not-confirmed', c && !c.ok ? c.say : 'Press Go Live on the Stream Deck, then confirm it on screen within 10 seconds.'));
        return;
      }
      deckPressedAt = b.deckPressedAt as number;
    }
    const r: IntentRequest = {
      source, plan: planOf(b.plan),
      ...(b.gesture && typeof b.gesture === 'object' ? { gesture: { trusted: g.trusted === true, at: Number(g.at) || 0 } } : {}),
      ...(deckPressedAt !== undefined ? { deckPressedAt } : {}),
    };
    send(res, goLive.issueIntent(r, origin), true);
  });
  route('post', '/start', 'write', async (req, res, origin) => {
    const b = obj(req.body);
    send(res, await goLive.start({ token: str(b.token, 200), plan: planOf(b.plan) }, origin));
  });
  route('post', '/dry-run', 'write', async (req, res, origin) => {
    const b = obj(req.body);
    send(res, await goLive.dryRun({ token: str(b.token, 200), ...(typeof b.seconds === 'number' ? { seconds: b.seconds } : {}) }, origin));
  });
  route('post', '/stop', 'write', async (req, res) => {
    const reason = obj(req.body).reason === 'dry-run-done' ? 'dry-run-done' : 'end-show';
    send(res, await goLive.stop({ reason }));
  });
  route('post', '/record', 'write', async (req, res, origin) => {
    const b = obj(req.body);
    if (b.action === 'stop') { send(res, await goLive.stopRecording()); return; }
    if (b.action !== 'start') { send(res, fail('bad-request', 'Start or stop?')); return; }
    send(res, await goLive.startRecording({ token: str(b.token, 200), plan: planOf(b.plan) }, origin));
  });
  route('post', '/replay', 'write', async (_req, res) => { send(res, await goLive.saveReplay()); });
  route('post', '/backend', 'write', (req, res) => {
    // switching away while a show is on the air would leave End Show without the backend that carries it
    if (goLive.isActive()) { send(res, fail('busy', 'You are live. End the show before you change what you stream with.')); return; }
    const c = str(obj(req.body).choice, 12) as BackendChoiceRequest['choice'];
    const r = backends.setChoice(c);
    send(res, r.ok ? { ok: true, choice: r.choice } : fail('bad-request', r.say));
  });

  // ---------- destinations (no keys here: they enter only through /keys/:id)

  route('get', '/destinations', 'read', (_req, res) => { send(res, { ok: true, destinations: safeList() }); });
  route('post', '/destinations', 'write', async (req, res, origin) => {
    const b = obj(req.body), d = obj(b.destination);
    if ('key' in d || 'key' in b || 'streamKey' in d) { send(res, fail('bad-request', 'Stream keys are pasted in the key box, not here.')); return; }
    const platform = str(d.platform, 12);
    if (!['twitch', 'youtube', 'kick', 'tiktok', 'custom'].includes(platform)) { send(res, fail('bad-request', 'Pick Twitch, YouTube, Kick, TikTok or your own address.')); return; }
    const url = str(d.url, 400).trim();
    if (!goodUrl(url)) { send(res, fail('bad-request', 'The stream address must start with rtmp:// or rtmps://.')); return; }
    if (url !== '') {
      // the address is stored and shown in plain text, so a key pasted after the server (or an SRT stream id) is refused here, in plain words
      // (checked in the route as well as in the store, so it holds whichever store is plugged in). The answer never repeats the address.
      const p = parseIngestUrl(url);
      if ('error' in p) { send(res, fail('bad-request', p.error)); return; }
    }
    const id = str(d.id, 64) || undefined;
    if (origin !== 'local-page') {
      // a website or another program must not point a key at another address (the key would be sent there at Go Live). That holds for a NEW
      // destination too: and a delete + re-create must not sidestep the check.
      // So a typed address is set only on the Helper's own page; elsewhere a destination keeps its address or uses the platform's own ingest ('').
      const was = id ? destinations.get(id) : null;
      if (url !== '' && url !== (was?.url ?? '')) {
        send(res, fail('local-only', origin === 'tool' ? 'A stream address is typed in VTube Pro’s page on your computer, not sent by another program.' : 'A custom stream address is typed in VTube Pro on your computer, never on a website.'));
        return;
      }
    }
    const input: DestinationInput = {
      ...(id ? { id } : {}), platform: platform as DestinationInput['platform'], label: str(d.label, 60), url, title: str(d.title, 140), category: str(d.category, 80),
      ...(typeof d.enabled === 'boolean' ? { enabled: d.enabled } : {}), ...(typeof d.protocol === 'string' ? { protocol: str(d.protocol, 6) as DestinationInput['protocol'] } : {}),
    };
    try {
      send(res, { ok: true, destination: await destinations.upsert(input) });
    } catch (e) {
      // the store refuses with a sentence meant for the person (a bad address, too many places ...): say it, as a 400, not a 500
      if ((e as Error)?.name === 'DestinationError') { send(res, fail(((e as { code?: BroadcastErrorCode }).code ?? 'bad-request'), (e as Error).message)); return; }
      throw e;
    }
  });
  route('delete', '/destinations/:id', 'write', async (req, res) => {
    const id = str(req.params.id, 64);
    if (!destinations.get(id)) { send(res, fail('not-found', 'I do not have that destination.')); return; }
    await destinations.remove(id);
    await keys.clear(id).catch(() => undefined);
    send(res, { ok: true });
  });

  // ---------- keys and accounts: this PC's own page only

  route('post', '/keys/:id', 'local', async (req, res) => {
    const id = str(req.params.id, 64), key = obj(req.body).key;
    if (!destinations.get(id)) { send(res, fail('not-found', 'I do not have that destination.')); return; }
    if (!goodKey(key)) { send(res, fail('bad-request', 'That does not look like a stream key. Copy it again from your streaming site.')); return; }
    await keys.set(id, key.trim());
    send(res, { ok: true, destination: destinations.get(id)! });
  });
  route('delete', '/keys/:id', 'local', async (req, res) => {
    const id = str(req.params.id, 64);
    if (!destinations.get(id)) { send(res, fail('not-found', 'I do not have that destination.')); return; }
    await keys.clear(id);
    send(res, { ok: true, destination: destinations.get(id)! });
  });

  const dispose = () => { offChange(); stopTimer(); goLive.dispose(); };
  return { router, deps, status, healthView: () => view, dispose };
}

function planOf(v: unknown): GoLivePlan {
  const o = obj(v);
  const ids = Array.isArray(o.destIds) ? o.destIds.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64).slice(0, 8) : [];
  return { destIds: ids, title: str(o.title, 140), category: str(o.category, 80), ...(o.dryRun === true ? { dryRun: true } : {}), ...(o.record === true ? { record: true } : {}) };
}

function diskFreeGb(): number | null {
  try {
    const s = fs.statfsSync(CACHE_DIR);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1e8) / 10;
  } catch { return null; }
}

// ---------------------------------------------------------------- the default wiring (what server/index.ts mounts)

/** The local test receiver for the 10 s private test (tools/broadcast_sink.ts): set VTP_BROADCAST_SINK=rtmp://127.0.0.1:<port>/live[/key]. */
function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } | null {
  const raw = env.VTP_BROADCAST_SINK;
  if (!raw) return null;
  const m = /^(rtmp:\/\/(?:127(?:\.\d{1,3}){3}|localhost)(?::\d+)?\/[\w.-]+)(?:\/([\w.-]+))?$/i.exec(raw.trim());
  return m ? { url: m[1], key: m[2] ?? 'vtp-private-test' } : null;
}

/** The Phase 1 modules are all in the tree now, so they are imported for real: a renamed export is a compile error here, not a
 *  silent fallback to "not part of this build yet". */
export async function loadDefaults(): Promise<BroadcastRouteDeps> {
  const pol: BroadcastPolicyApi = { checkIntent, canonicalPlan, mayStart };
  const stamps: StampAggregatorApi = stampAggregator;

  const { obs } = await import('../obs.ts');
  const { deckGoLive: deckGate } = await import('../deck.ts');
  const backends = createBackendHolder({ obs: await obsBackend(), obsConfigured: () => obs.canRead() });
  registerBackendHolder(backends);
  const destinations: DestinationsApi = destinationStore;
  const goLive = createGoLiveService({
    backends, destinations, policy: pol, journal: createJournal(), engine: engineSupervisor,
    dryRunSink: () => sinkFromEnv(), autoResume: process.env.VTP_BROADCAST_AUTORESUME === '1',
    notify: (say, tone) => { try { busBroadcast({ type: 'broadcast', k: 'notice', n: { id: `n-${Date.now()}`, at: Date.now(), tone, say } } as unknown as BusMessage); } catch { /* no bus yet */ } },
  });
  return {
    goLive, backends, destinations, keys: keyStore,
    engine: engineSupervisor, health: { initialHealth, stepHealth, healthView, reconnectDelayS }, preflight: { evaluatePreflight }, stamps,
    // the Stream Deck key press the helper itself remembered (server/deck.ts); imported here so that importing this file stays free of side effects
    deckConfirm: (claimed) => deckGate.confirm(claimed),
  };
}

let shared: Promise<BroadcastHub> | null = null;
function sharedHub(): Promise<BroadcastHub> {
  shared ??= loadDefaults().then((d) => {
    const hub = createBroadcastHub(d);
    // after a restart: take a show that is still on the air back (never starts anything unless crash resume is switched on)
    setTimeout(() => { void d.goLive.recover().catch(() => undefined); }, 1500).unref?.();
    return hub;
  });
  return shared;
}

/** Mounted by server/index.ts. The hub is built on the first /api/broadcast request (the studio opening its Go Live tab); importing
 *  this file starts nothing, so tests and tools can import it freely. */
export const broadcastRoutes = Router();
broadcastRoutes.use((req, res, next) => {
  if (!req.path.startsWith('/api/broadcast/')) { next(); return; }
  sharedHub().then((h) => h.router(req, res, next), (e) => {
    console.warn(`[broadcast] could not start (${(e as Error)?.name ?? 'error'})`);
    res.status(500).json({ ok: false, code: 'internal', error: 'The broadcast part of VTube Pro could not start.' });
  });
});
