// The Go Live service (VTube Pro Live, Phase 1, workstream W2): the ONLY code that can start a stream or a recording.
//
// The rule it enforces (AGENTS.md, docs/BROADCAST_PROTOCOL.md section 1, plan graft G1): a stream starts only on a
// deliberate person's click in the studio (or a Stream Deck key confirmed on screen) carrying a fresh, single-use intent
// token that is bound to the exact plan the confirm card showed. The sequence is
//   issueIntent (card opens) -> start (the person presses Start) -> SetStreamServiceSettings x1 + StartStream x1.
// Everything else is refused with zero start calls: a missing, expired, replayed or mismatched token, a web page that is
// not this PC's studio or a paired owner, a tool with no gesture (curl, MCP, autopilot, relay ...), the other broadcaster
// already live, a stream that is already on.
//
// Two policies run on every decision and the first refusal wins: the built-in one below (the hard floor: this file alone
// guarantees "no valid click, no start") and the injected one (W1's shared/broadcastPolicy.ts when it is merged).
//
// Secrets: the stream key is read from the destinations module (the vault) at the moment of the start, handed to the
// backend in RAM and dropped. It is in no state object, journal, response, notice or log line.
import crypto from 'node:crypto';
import {
  DECK_CONFIRM_MS, INTENT_ALLOWED_SOURCES, INTENT_REFUSED_SOURCES, INTENT_TTL_MS, RECONNECT_BACKOFF_S, RESUME_MAX_PER_HOUR, RESUME_WINDOW_MS,
  type ApiError, type ApiResult, type BackendStatus, type BroadcastBackend, type BroadcastErrorCode, type BroadcastPolicyApi, type DestinationsApi,
  type DestLiveState, type DryRunRequest, type DryRunResponse, type GoLivePhase, type GoLivePlan, type GoLiveServiceApi, type GoLiveState, type IntentCheckInput,
  type IntentGrant, type IntentRequest, type IntentResponse, type IntentSource, type IntentVerdict, type OutputStatus, type RecordStatus, type ReplayResponse,
  type ReplayStatus, type ServiceSettings, type StartRequest, type StartResponse, type StopRequest, type StopResponse,
} from '../../shared/broadcastTypes.ts';
import { canRestoreService, type BackendHolder, type ServiceRestorer } from './backend.ts';
import type { EngineSupervisor } from './engineSupervisor.ts';
import { cleanPlan, type Journal } from './journal.ts';
import { BackendError } from './obsBackend.ts';

/** The functions that can reach BroadcastBackend.startOutput / startRecord. W7's guard test (tools/golive_guard_unit.ts)
 *  reads this list: every entry needs a consumed intent token (or the resume rule) and nothing else may be added without
 *  a test. tools/broadcast_api_e2e.ts also greps server/ to prove no other file calls them. */
export const BROADCAST_START_ENTRY_POINTS: readonly string[] = ['GoLiveService.start', 'GoLiveService.dryRun', 'GoLiveService.startRecording', 'GoLiveService.recover'];

/** An intent token lives this long after the card opened, once. */
export const GRANT_KEEP_MS = 5 * 60_000;
export const DRY_RUN_DEFAULT_S = 10;
export const DRY_RUN_MAX_S = 30;
const GRANTS_MAX = 32;
const OFFER_KEEP_MS = 10 * 60_000;

const KNOWN_SOURCES: readonly IntentSource[] = [...INTENT_ALLOWED_SOURCES, 'crash-resume', ...INTENT_REFUSED_SOURCES];
const asSource = (s: unknown): IntentSource => (KNOWN_SOURCES.includes(s as IntentSource) ? (s as IntentSource) : 'unknown');

// ---------------------------------------------------------------- the built-in policy (the hard floor)

const no = (code: BroadcastErrorCode, say: string, status: 403 | 409 = 403): IntentVerdict => ({ ok: false, code, say, status });

/** The Go Live rule as a pure function. Same contract as W1's BroadcastPolicyApi; kept here so that "no valid click, no
 *  start" does not depend on any other module being present or right. */
export const builtinPolicy: BroadcastPolicyApi = {
  mayStart: (source) => INTENT_ALLOWED_SOURCES.includes(source),
  canonicalPlan: (p) => JSON.stringify({ destIds: [...p.destIds].sort(), title: p.title, category: p.category, dryRun: p.dryRun === true, record: p.record === true }),
  checkIntent(i: IntentCheckInput): IntentVerdict {
    if (i.origin === 'foreign-web') return no('foreign-origin', 'This page is not allowed to start your stream. Open VTube Pro on your computer.');
    if (i.source === 'crash-resume') {
      const r = i.resume;
      if (!r || !r.journalStartedByPerson) return no('source-not-allowed', 'Only a click can start your stream.');
      if (i.now - r.lastAliveAt > RESUME_WINDOW_MS) return no('not-confirmed', 'It has been too long since you were live. Press Go Live to start again.');
      if (r.resumesInLastHour >= RESUME_MAX_PER_HOUR) return no('not-confirmed', 'Your stream already restarted a few times this hour. Press Go Live to start again.');
      if (i.otherBroadcasterLive === true) return no('other-live', 'Your other broadcaster is already live. Stop it first.', 409);
      if (i.alreadyLive) return no('already-live', 'You are already live.', 409);
      return { ok: true, source: i.source };
    }
    if (!builtinPolicy.mayStart(i.source)) return no('source-not-allowed', 'Only a click on Go Live in the VTube Pro studio can start your stream.');
    if (i.origin !== 'local-page') return no('source-not-allowed', 'Only a click on Go Live in the VTube Pro studio can start your stream.');
    if (!i.gesture || i.gesture.trusted !== true) return no('source-not-allowed', 'Only a click on Go Live in the VTube Pro studio can start your stream.');
    if (i.source === 'deck-confirmed') {
      const d = i.gesture.at - (i.deckPressedAt ?? Number.NEGATIVE_INFINITY);
      if (!(d >= 0 && d <= DECK_CONFIRM_MS)) return no('not-confirmed', 'Confirm on screen within 10 seconds of pressing the Stream Deck key.');
    }
    // redeeming (the second use): the token
    if (i.presentedToken !== null || i.grant !== null) {
      if (!i.presentedToken) return no('no-token', 'Press Go Live and then Start to begin.');
      if (!i.grant || i.grant.token !== i.presentedToken) return no('no-token', 'That confirmation is not valid. Press Go Live again.');
      if (i.grant.used) return no('token-replayed', 'That confirmation was already used. Press Go Live again.');
      if (i.now > i.grant.expiresAt) return no('token-expired', 'That confirmation ran out. Press Go Live again.');
      if (i.grant.planHash !== i.presentedPlanHash) return no('token-mismatch', 'What you confirmed changed. Press Go Live again.');
    }
    if (i.otherBroadcasterLive === true) return no('other-live', 'Your other broadcaster is already live. Stop it first.', 409);
    if (i.alreadyLive) return no('already-live', 'You are already live.', 409);
    return { ok: true, source: i.source };
  },
};

// ---------------------------------------------------------------- the service

export interface GoLiveService extends GoLiveServiceApi {
  /** Record start: same intent token as Go Live, plan { destIds: [], record: true }. */
  startRecording(req: { token: string; plan: GoLivePlan }, origin: IntentCheckInput['origin']): Promise<ApiResult<{ record: RecordStatus }>>;
  /** Stopping a recording never needs a token. */
  stopRecording(): Promise<ApiResult<{ record: RecordStatus }>>;
  saveReplay(): Promise<ApiResult<ReplayResponse>>;
  /** Poll the backend once and bring the state up to date (the router calls it once a second while a show is on). */
  tick(): Promise<void>;
  /** A loopback test receiver is set up, so the 10 second private test can run (the studio hides the button otherwise). */
  dryRunAvailable(): boolean;
  /** After a restart: adopt a show that is still on the air, or offer / (when allowed) do the crash resume. */
  recover(): Promise<'none' | 'adopted' | 'resumed' | 'offered'>;
  /** The latest backend status the service saw (null = never or unreachable). */
  lastBackendStatus(): BackendStatus | null;
  /** The person dismissed the "You were live" card. */
  dismissResumeOffer(): void;
  isActive(): boolean;
  dispose(): void;
}

export interface GoLiveDeps {
  backends: BackendHolder;
  destinations: DestinationsApi;
  /** W1's policy when merged; the built-in one always runs as well. */
  policy?: BroadcastPolicyApi;
  journal: Journal;
  engine: EngineSupervisor;
  /** The local test receiver for the 10 s private test (a loopback RTMP address and a throw-away key), or null. */
  dryRunSink?: () => { url: string; key: string } | null;
  /** Crash resume may restart a stream by itself (G1's one exception). OFF by default in Phase 1. */
  autoResume?: boolean;
  now?: () => number;
  token?: () => string;
  /** One plain sentence for the studio (bus notice). */
  notify?: (say: string, tone: 'ok' | 'warn' | 'bad' | 'quiet') => void;
  sleep?: (ms: number) => Promise<void>;
}

interface Grant {
  token: string; issuedAt: number; expiresAt: number; used: boolean; planHash: string; source: IntentSource;
  plan: GoLivePlan; gesture?: { trusted: boolean; at: number }; deckPressedAt?: number;
}

const fail = (code: BroadcastErrorCode, error: string): ApiError => ({ ok: false, code, error });
const refusal = (v: Extract<IntentVerdict, { ok: false }>): ApiError => fail(v.code, v.say);
const SNAPSHOT_FAILED_SAY = 'I could not save your OBS stream settings first, so I changed nothing. Try again in a moment.';
const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/i;

/** A sink address is only ever this PC (a dry run can never reach a real service). */
export function loopbackSink(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === 'rtmp:' || u.protocol === 'srt:') && LOOPBACK_HOST.test(u.hostname); } catch { return false; }
}

function backendFail(e: unknown): ApiError {
  if (e instanceof BackendError) return fail(e.code, e.say);
  return fail('internal', 'Something went wrong while talking to your broadcast program.');
}

export function createGoLiveService(d: GoLiveDeps): GoLiveService {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const mkToken = d.token ?? (() => crypto.randomBytes(24).toString('base64url'));
  const notify = d.notify ?? (() => {});
  const policy = d.policy ?? builtinPolicy;
  const grants = new Map<string, Grant>();
  const listeners = new Set<(s: GoLiveState) => void>();

  let phase: GoLivePhase = 'idle';
  let plan: GoLivePlan | null = null;
  let startedAt: number | null = null;
  let dests: DestLiveState[] = [];
  let record: RecordStatus = { active: false, paused: false, startedAt: null, durationMs: 0, bytes: 0, file: null };
  let replay: ReplayStatus = { available: null, saving: false, lastSavedAt: null, seconds: 0 };
  let dryRun = false;
  let otherLive: boolean | null = null;
  let offer: { endedAt: number; destIds: string[] } | null = null;
  let error: string | null = null;
  let transitioning = false;
  let recordByShow = false;
  let lastStatus: BackendStatus | null = null;
  let dryTimer: NodeJS.Timeout | null = null;
  let dryRunId = 0;                 // which private test the timer belongs to (an old timer must never stop a later test or a real show)
  let serviceSnapped = false;       // the backend holds the person's own stream service (RAM only) until the show ends
  let lastSig = '';
  let unreachable = 0;
  let reconnectTicks = 0;
  let lastRecordFile: string | null = null;

  const isLive = () => phase === 'live' || phase === 'starting' || phase === 'reconnecting' || phase === 'stopping';
  const clearDryTimer = () => { if (dryTimer) { clearTimeout(dryTimer); dryTimer = null; } };
  /** Put the person's own OBS stream service back once their show (or private test) is over. Only called when OBS is not sending. */
  async function restoreServiceNow(backend: BroadcastBackend | null) {
    if (!serviceSnapped) return;
    serviceSnapped = false;
    if (backend && canRestoreService(backend)) await backend.restoreService().catch(() => false);
  }
  /** Save the person's own OBS stream service (RAM only) before it is replaced. False when OBS could not hand it over: the caller must not change anything. */
  async function snapshotOwnService(backend: ServiceRestorer): Promise<boolean> {
    serviceSnapped = false;
    try { await backend.snapshotService(); } catch { return false; }
    serviceSnapped = true;
    return true;
  }
  const hashPlan = (p: GoLivePlan) => crypto.createHash('sha256').update(policy.canonicalPlan(p)).digest('hex');

  function snapshot(): GoLiveState {
    const t = now();
    if (phase === 'confirming' && ![...grants.values()].some((g) => !g.used && g.expiresAt > t)) phase = 'idle';   // the card was closed or timed out
    if (offer && t - offer.endedAt > OFFER_KEEP_MS && !isLive()) offer = null;
    return {
      phase, backend: d.backends.choice(), startedAt, liveForS: startedAt && (phase === 'live' || phase === 'reconnecting') ? Math.max(0, Math.floor((t - startedAt) / 1000)) : null,
      plan: plan ? { ...plan, destIds: [...plan.destIds] } : null, destinations: dests.map((x) => ({ ...x })), record: { ...record }, replay: { ...replay }, dryRun,
      otherBroadcasterLive: otherLive, resumeOffer: offer ? { endedAt: offer.endedAt, destIds: [...offer.destIds] } : null, error,
    };
  }
  function changed() {
    const s = snapshot();
    const sig = JSON.stringify({ ...s, liveForS: null });
    if (sig === lastSig) return;
    lastSig = sig;
    for (const l of [...listeners]) { try { l(s); } catch { /* a listener must not break the service */ } }
  }
  function setPhase(p: GoLivePhase, say: string | null = null) { phase = p; error = p === 'error' ? say : null; changed(); }
  function prune(t: number) {
    for (const [k, g] of grants) if (t - g.issuedAt > GRANT_KEEP_MS) grants.delete(k);
    while (grants.size > GRANTS_MAX) { const first = grants.keys().next().value; if (first === undefined) break; grants.delete(first); }
  }
  async function refreshOther() {
    try { otherLive = d.backends.choice() === 'obs' ? (await d.engine.detect()).outputActive : null; } catch { otherLive = null; }
  }

  /** Both policies; the first refusal wins. */
  function judge(i: IntentCheckInput): IntentVerdict {
    const a = builtinPolicy.checkIntent(i);
    if (!a.ok) return a;
    if (policy === builtinPolicy) return a;
    let b: IntentVerdict;
    try { b = policy.checkIntent(i); } catch { return no('internal', 'Something went wrong checking your click. Press Go Live again.'); }
    return b;
  }

  /** A recording on its own (no destination, not a private test) may start while the show is on: "Record saves a copy"
   *  (docs/GO_LIVE.md). Then "already live" does not apply, and the OBS output that is running is our own show, not
   *  another broadcaster. startRecording itself still refuses when OBS is already recording. */
  const recordOnly = (p: GoLivePlan) => p.record === true && p.destIds.length === 0 && p.dryRun !== true;
  const liveFor = (p: GoLivePlan) => (recordOnly(p) ? { alreadyLive: false, otherBroadcasterLive: isLive() ? null : otherLive } : { alreadyLive: isLive(), otherBroadcasterLive: otherLive });

  // ---------------------------------------------------------------- intent

  function issueIntent(req: IntentRequest, origin: IntentCheckInput['origin']): ApiResult<IntentResponse> {
    const t = now();
    prune(t);
    const source = asSource(req?.source);
    const p = cleanPlan(req?.plan);
    const g = req?.gesture && typeof req.gesture === 'object' ? { trusted: req.gesture.trusted === true, at: Number.isFinite(req.gesture.at) ? req.gesture.at : 0 } : undefined;
    const deckPressedAt = typeof req?.deckPressedAt === 'number' && Number.isFinite(req.deckPressedAt) ? req.deckPressedAt : undefined;
    const v = judge({ now: t, origin, source, gesture: g, deckPressedAt, grant: null, presentedToken: null, presentedPlanHash: hashPlan(p), ...liveFor(p) });
    if (!v.ok) return refusal(v);
    const token = mkToken();
    const planHash = hashPlan(p);
    grants.set(token, { token, issuedAt: t, expiresAt: t + INTENT_TTL_MS, used: false, planHash, source, plan: p, gesture: g, deckPressedAt });
    const grant: IntentGrant = { token, expiresAt: t + INTENT_TTL_MS, planHash };
    if (phase === 'idle' || phase === 'error') setPhase('confirming');
    return { ok: true, ...grant };
  }

  /** Check a presented token against a plan and (when it passes) burn it, all before the first await: a second request
   *  with the same token, or a double click, sees `used` and is refused with zero start calls. */
  function redeem(token: unknown, presented: GoLivePlan, origin: IntentCheckInput['origin'], extra: (g: Grant) => ApiError | null): ApiError | { grant: Grant } {
    const t = now();
    prune(t);
    const tok = typeof token === 'string' && token.length <= 200 ? token : '';
    const g = tok ? grants.get(tok) ?? null : null;
    const v = judge({
      now: t, origin, source: g?.source ?? 'unknown', gesture: g?.gesture, deckPressedAt: g?.deckPressedAt,
      grant: g ? { token: g.token, issuedAt: g.issuedAt, expiresAt: g.expiresAt, used: g.used, planHash: g.planHash, source: g.source } : null,
      presentedToken: tok || null, presentedPlanHash: hashPlan(presented), ...liveFor(presented),
    });
    if (!v.ok) return refusal(v);
    if (!g) return fail('no-token', 'Press Go Live and then Start to begin.');         // (unreachable if the policies agree; belt and braces)
    const bad = extra(g);
    if (bad) return bad;
    g.used = true;
    return { grant: g };
  }

  // ---------------------------------------------------------------- start

  async function start(req: StartRequest, origin: IntentCheckInput['origin']): Promise<ApiResult<StartResponse>> {
    const presented = cleanPlan(req?.plan);
    if (presented.dryRun) return fail('bad-request', 'That is a private test. Use the test button.');
    const backend = d.backends.active();
    const r = redeem(req?.token, presented, origin, (g) => {
      if (!backend) return fail(d.backends.choice() === 'engine' ? 'bad-request' : 'preflight-blocked', d.backends.choice() === 'engine' ? 'The VTube Pro Live Engine is coming soon.' : 'Pick what you stream with first (My OBS).');
      if (g.plan.destIds.length === 0) return fail('no-destination', 'Pick where you want to stream.');
      if (g.plan.destIds.length > 1 && !backend.capabilities().multiOutput) return fail('bad-request', 'Your OBS can send to one place at a time. Pick one.');
      return null;
    });
    if ('ok' in r) return r;
    const g = r.grant;
    // from here on the person's click is spent; phase is set before the first await so nothing else can start meanwhile
    transitioning = true; plan = g.plan; startedAt = null; dryRun = false; dests = []; offer = null; recordByShow = false;
    setPhase('starting');
    const t0 = now();
    let journaled = false;
    const undo = async (e: ApiError): Promise<ApiError> => {
      transitioning = false; plan = null; startedAt = null; dests = [];
      if (journaled) d.journal.end(true, now());
      await restoreServiceNow(backend);
      setPhase('error', e.error);
      return e;
    };
    try {
      await refreshOther();
      if (otherLive === true) return await undo(fail('other-live', 'Your other broadcaster is already live. Stop it first.'));
      const st = await backend!.status();
      lastStatus = st;
      if (!st.reachable) return await undo(fail('backend-unreachable', 'I can’t reach OBS. Make sure OBS is open, then try again.'));
      if (st.streaming) return await undo(fail('already-live', 'You are already live in OBS.'));
      const destId = g.plan.destIds[0];
      const view = d.destinations.get(destId);
      if (!view) return await undo(fail('no-destination', 'That place to stream is not set up any more. Add it again.'));
      if (!view.enabled) return await undo(fail('no-destination', `${view.label || 'That destination'} is switched off. Turn it on first.`));
      const sv = await d.destinations.serviceFor(destId);
      if (!sv.ok) return await undo(fail(sv.code, sv.say));
      const svc: ServiceSettings = sv.svc;
      // title and category go to the platform first (Twitch); a failure is a notice, never a blocker
      try {
        const meta = await Promise.race([d.destinations.pushMetadata(destId), sleep(4000).then(() => ({ ok: false, say: 'Setting the title took too long, so I skipped it.' }))]);
        if (!meta.ok && meta.say) notify(meta.say, 'warn');
      } catch { notify('I could not set your title and category. Your stream still starts.', 'warn'); }
      d.journal.begin(g.source, g.plan, backend!.kind, now()); journaled = true;
      // the person's own OBS stream service is remembered (RAM only) before it is replaced, and put back when the show ends
      // no saved copy, no change: if OBS cannot hand over the current service the start stops here and OBS is left exactly as it was
      if (canRestoreService(backend!) && !(await snapshotOwnService(backend!))) return await undo(fail('backend-unreachable', SNAPSHOT_FAILED_SAY));
      await backend!.setServiceInRam(svc);
      await backend!.startOutput('stream');
      if (g.plan.record) {
        try { record = { ...(await backend!.startRecord()) }; recordByShow = true; } catch (e) { notify(backendFail(e).error, 'warn'); }
      }
      startedAt = t0;
      transitioning = false;
      dests = g.plan.destIds.map((id) => ({ destId: id, state: 'starting', since: null, retryInS: null, say: null }));
      await applyStatus(await backend!.status().catch(() => null));
      if (phase === 'starting') changed();
      return { ok: true, state: snapshot() };
    } catch (e) {
      return await undo(backendFail(e));
    }
  }

  // ---------------------------------------------------------------- private test (dry run)

  async function dryRunStart(req: DryRunRequest, origin: IntentCheckInput['origin']): Promise<ApiResult<DryRunResponse>> {
    const backend = d.backends.active();
    const sink = d.dryRunSink?.() ?? null;
    // the body of /dry-run carries only the token: the plan it is checked against is the one the token was issued for
    const issued = typeof req?.token === 'string' ? grants.get(req.token) : undefined;
    const r = redeem(req?.token, issued ? issued.plan : { destIds: [], title: '', category: '', dryRun: true }, origin, (g) => {
      if (g.plan.dryRun !== true) return fail('token-mismatch', 'That confirmation was not for a private test. Press the test button again.');
      if (!backend) return fail('preflight-blocked', 'Pick what you stream with first (My OBS).');
      if (!sink || !loopbackSink(sink.url)) return fail('no-destination', 'The private test needs its test receiver, which is not running on this computer.');
      return null;
    });
    if ('ok' in r) return r;
    const g = r.grant;
    const seconds = Math.min(DRY_RUN_MAX_S, Math.max(3, Math.round(Number(req?.seconds) || DRY_RUN_DEFAULT_S)));
    transitioning = true; plan = g.plan; dryRun = true; startedAt = null; dests = []; offer = null; recordByShow = false;
    const runId = ++dryRunId;
    clearDryTimer();
    setPhase('starting');
    const undo = async (e: ApiError): Promise<ApiError> => {
      transitioning = false; plan = null; dryRun = false;
      await restoreServiceNow(backend);
      setPhase('error', e.error);
      return e;
    };
    try {
      await refreshOther();
      if (otherLive === true) return await undo(fail('other-live', 'Your other broadcaster is already live. Stop it first.'));
      const st = await backend!.status();
      lastStatus = st;
      if (!st.reachable) return await undo(fail('backend-unreachable', 'I can’t reach OBS. Make sure OBS is open, then try again.'));
      if (st.streaming) return await undo(fail('already-live', 'You are already live in OBS.'));
      if (canRestoreService(backend!) && !(await snapshotOwnService(backend!))) return await undo(fail('backend-unreachable', SNAPSHOT_FAILED_SAY));
      await backend!.setServiceInRam({ destId: 'dry-run', protocol: 'rtmp', url: sink!.url, key: sink!.key });
      await backend!.startOutput('stream');
      startedAt = now(); transitioning = false;
      dests = [{ destId: 'dry-run', state: 'starting', since: null, retryInS: null, say: null }];
      await applyStatus(await backend!.status().catch(() => null));
      clearDryTimer();
      dryTimer = setTimeout(() => { dryTimer = null; if (dryRun && dryRunId === runId) void stop({ reason: 'dry-run-done' }); }, seconds * 1000);
      dryTimer.unref?.();
      return { ok: true, state: snapshot(), sinkUrl: sink!.url };
    } catch (e) {
      return await undo(backendFail(e));
    }
  }

  // ---------------------------------------------------------------- stop

  async function stop(req: StopRequest = {}): Promise<ApiResult<StopResponse>> {
    const t0 = now();
    const backend = d.backends.active();
    if (!backend) return fail('not-live', 'You are not live.');
    // "the private test is done" only ever ends a private test, never a real show that is on by then
    if (req.reason === 'dry-run-done' && !dryRun) return fail('not-live', 'The private test is not running.');
    clearDryTimer();
    let st: BackendStatus | null = null;
    try { st = await backend.status(); } catch { st = null; }
    if (st && !st.reachable) return fail('backend-unreachable', 'I can’t reach OBS to stop the stream. Stop it in OBS.');
    const streaming = st?.streaming === true;
    if (!streaming && phase === 'idle' && !(recordByShow && st?.recording)) return fail('not-live', 'You are not live.');
    transitioning = true;
    setPhase('stopping');
    try {
      if (streaming) {
        try { await backend.stopOutput('stream'); }
        catch (e) {
          const again = await backend.status().catch(() => null);
          if (again?.streaming) { transitioning = false; setPhase('error', backendFail(e).error); return backendFail(e); }
        }
      }
      if (recordByShow) {
        try { const rs = await backend.stopRecord(); lastRecordFile = rs.file; record = { ...rs }; } catch { /* it may have been stopped in OBS already */ }
        recordByShow = false;
      }
      // End Show finishes within 2 s: the output usually reports off within a few polls
      let off = false;
      for (let i = 0; i < 15 && !off; i++) { const s = await backend.status().catch(() => null); lastStatus = s ?? lastStatus; off = !s || !s.streaming; if (!off) await sleep(100); }
      if (off) await restoreServiceNow(backend);        // (while OBS still reports the output the stopping branch of applyStatus does it)
      d.journal.end(true, now());
      transitioning = false;
      plan = null; startedAt = null; dests = []; dryRun = false; offer = null;
      setPhase(off ? 'idle' : 'stopping');
      return { ok: true, state: snapshot(), tookMs: now() - t0 };
    } catch (e) {
      transitioning = false;
      return fail(e instanceof BackendError ? e.code : 'internal', e instanceof BackendError ? e.say : 'Something went wrong while stopping.');
    }
  }

  // ---------------------------------------------------------------- recording and replay

  async function startRecording(req: { token: string; plan: GoLivePlan }, origin: IntentCheckInput['origin']): Promise<ApiResult<{ record: RecordStatus }>> {
    const presented = cleanPlan(req?.plan);
    const backend = d.backends.active();
    const r = redeem(req?.token, presented, origin, (g) => {
      if (!backend) return fail('preflight-blocked', 'Pick what you stream with first (My OBS).');
      if (g.plan.record !== true || g.plan.destIds.length !== 0 || g.plan.dryRun) return fail('bad-request', 'That confirmation was not for a recording.');
      return null;
    });
    if ('ok' in r) return r;
    try {
      const st = await backend!.status();
      if (!st.reachable) return fail('backend-unreachable', 'I can’t reach OBS. Make sure OBS is open, then try again.');
      if (st.recording) return fail('already-live', 'OBS is already recording.');
      record = { ...(await backend!.startRecord()) };
      lastRecordFile = null;
      changed();
      return { ok: true, record: { ...record } };
    } catch (e) { return backendFail(e); }
  }
  async function stopRecording(): Promise<ApiResult<{ record: RecordStatus }>> {
    const backend = d.backends.active();
    if (!backend) return fail('not-live', 'You are not recording.');
    try {
      const st = await backend.status();
      if (!st.reachable) return fail('backend-unreachable', 'I can’t reach OBS. Make sure OBS is open, then try again.');
      if (!st.recording) return fail('not-live', 'You are not recording.');
      const rs = await backend.stopRecord();
      lastRecordFile = rs.file; record = { ...rs }; recordByShow = false;
      changed();
      return { ok: true, record: { ...record } };
    } catch (e) { return backendFail(e); }
  }
  async function saveReplay(): Promise<ApiResult<ReplayResponse>> {
    const backend = d.backends.active();
    if (!backend) return fail('preflight-blocked', 'Pick what you stream with first (My OBS).');
    try {
      replay = { ...replay, saving: true };
      const result = await backend.saveReplay();
      replay = { available: result.ok ? true : replay.available, saving: false, lastSavedAt: result.ok ? now() : replay.lastSavedAt, seconds: replay.seconds };
      changed();
      return { ok: true, result, replay: { ...replay } };
    } catch (e) { replay = { ...replay, saving: false }; return backendFail(e); }
  }

  // ---------------------------------------------------------------- following the backend

  async function applyStatus(st: BackendStatus | null) {
    const t = now();
    if (st) lastStatus = st;
    if (!st || !st.reachable) { unreachable++; return; }
    unreachable = 0;
    replay = { ...replay, available: st.replayBufferActive };
    const rec = st.outputs.find((o) => o.id === 'record');
    const recNow = st.recording;
    if (recNow !== record.active || (recNow && rec?.since)) {
      record = { active: recNow, paused: false, startedAt: recNow ? rec?.since ?? record.startedAt ?? t : null, durationMs: recNow && rec?.since ? t - rec.since : 0, bytes: record.bytes, file: recNow ? null : lastRecordFile };
    }
    if (transitioning) return;
    const out: OutputStatus | undefined = st.outputs.find((o) => o.id === 'stream');
    const reconnecting = out?.state === 'reconnecting';
    if (st.streaming) {
      reconnectTicks = reconnecting ? reconnectTicks + 1 : 0;
      const next: GoLivePhase = reconnecting ? 'reconnecting' : 'live';
      if (phase === 'idle' || phase === 'error' || phase === 'confirming' || phase === 'checking' || phase === 'ready') {
        // an output the person started in OBS itself: show it and offer End Show; not a show of ours, so no journal
        startedAt = out?.since ?? t; plan = plan ?? null; dests = [];
      }
      phase = phase === 'stopping' ? 'stopping' : next; error = null;
      const ids = plan?.destIds ?? [];
      const retry = reconnecting ? RECONNECT_BACKOFF_S[Math.min(Math.max(reconnectTicks, 1), RECONNECT_BACKOFF_S.length) - 1] : null;
      dests = ids.map((id) => ({ destId: id, state: out?.state ?? 'live', since: out?.since ?? null, retryInS: retry, say: reconnecting ? 'The connection dropped. Trying again.' : null }));
      if (!plan?.dryRun) d.journal.beat(t);
      changed();
    } else if (phase === 'live' || phase === 'reconnecting' || phase === 'starting') {
      if (phase === 'starting' && startedAt !== null && t - startedAt < 4000) { changed(); return; }   // OBS may take a moment to report the output
      // the output ended and we did not stop it: the person ended it in OBS, or OBS gave up reconnecting
      if (!dryRun) { offer = { endedAt: t, destIds: plan?.destIds ?? [] }; d.journal.end(false, t); }
      else d.journal.end(true, t);
      clearDryTimer();
      await restoreServiceNow(d.backends.active());
      plan = null; startedAt = null; dests = []; dryRun = false; recordByShow = false;
      phase = 'idle'; error = null;
      if (offer) notify('Your stream ended. Press Go Live to start again.', 'warn');
      changed();
    } else if (phase === 'stopping') {
      await restoreServiceNow(d.backends.active());
      plan = null; startedAt = null; dests = []; phase = 'idle'; changed();
    } else { changed(); }
  }

  async function tick() {
    const backend = d.backends.active();
    if (!backend) return;
    await refreshOther();
    let st: BackendStatus | null = null;
    try { st = await backend.status(); } catch { st = null; }
    await applyStatus(st);
  }

  // ---------------------------------------------------------------- recovery (after the Helper restarted)

  async function recover(): Promise<'none' | 'adopted' | 'resumed' | 'offered'> {
    const j = d.journal.read();
    const t = now();
    if (j.startedAt <= 0 || j.endedCleanly) return 'none';
    const backend = d.backends.active();
    const offerNow = () => { offer = { endedAt: j.lastAliveAt || t, destIds: j.plan.destIds }; changed(); return 'offered' as const; };
    if (!backend || backend.kind !== j.backend) return offerNow();
    let st: BackendStatus | null = null;
    try { st = await backend.status(); } catch { st = null; }
    if (st?.reachable && st.streaming) {                     // the show never stopped: take it back, no start call
      plan = j.plan; startedAt = j.startedAt; dryRun = false; offer = null; phase = 'live'; changed();
      d.journal.beat(t);
      return 'adopted';
    }
    const byPerson = j.source === 'click' || j.source === 'deck-confirmed';
    await refreshOther();
    const v = judge({
      now: t, origin: 'local-page', source: 'crash-resume', grant: null, presentedToken: null, presentedPlanHash: hashPlan(j.plan),
      otherBroadcasterLive: otherLive, alreadyLive: false,
      resume: { lastAliveAt: j.lastAliveAt, resumesInLastHour: d.journal.resumesInLastHour(t), journalStartedByPerson: byPerson },
    });
    if (!d.autoResume || !v.ok || !st?.reachable || j.plan.dryRun || j.plan.destIds.length !== 1) return offerNow();
    // the one exception to "a click starts it": inside the window, for a show the person started, at most 3 an hour, and they are told
    transitioning = true; plan = j.plan; dryRun = false; offer = null; setPhase('starting');
    try {
      const sv = await d.destinations.serviceFor(j.plan.destIds[0]);
      if (!sv.ok) throw new BackendError(sv.code, sv.say);
      d.journal.noteResume(t);
      // (no snapshot here: after a restart OBS already holds this show's service, and the person's own one was only ever kept in the
      //  RAM of the Helper that is gone. A snapshot now would "restore" the show's own settings at the end.)
      await backend.setServiceInRam(sv.svc);
      await backend.startOutput('stream');
      startedAt = j.startedAt; transitioning = false;
      notify('Your stream dropped while VTube Pro restarted, so I started it again for you.', 'warn');
      await applyStatus(await backend.status().catch(() => null));
      return 'resumed';
    } catch (e) {
      transitioning = false; plan = null; startedAt = null; setPhase('idle');
      void e;
      return offerNow();
    }
  }

  return {
    state: snapshot,
    issueIntent,
    start,
    dryRun: dryRunStart,
    stop,
    startRecording,
    stopRecording,
    saveReplay,
    tick,
    recover,
    lastBackendStatus: () => lastStatus,
    dryRunAvailable: () => { try { const s = d.dryRunSink?.() ?? null; return !!s && loopbackSink(s.url); } catch { return false; } },
    dismissResumeOffer() { offer = null; changed(); },
    isActive: () => isLive(),
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { clearDryTimer(); listeners.clear(); },
  };
}
