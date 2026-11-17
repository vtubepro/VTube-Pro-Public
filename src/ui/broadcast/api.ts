// VTube Pro Live, Go Live tab: the client for the server's /api/broadcast/* routes (docs/BROADCAST_PROTOCOL.md section 7).
// Typed by shared/broadcastTypes.ts. It does two things only: send the request and parse the answer into ApiResult (an
// answer that is not an ApiResult becomes a calm 'internal' failure, never a red error). It never logs a request or an
// answer, and a stream key only ever leaves here as the body of POST /keys/:id.
import {
  BROADCAST_API_BASE,
  type ApiError, type ApiOk, type BackendChoice, type BackendChoiceResponse, type BroadcastErrorCode, type BroadcastStatus,
  type DestinationInput, type DestinationsResponse, type DestinationUpsertResponse,
  type DryRunRequest, type DryRunResponse, type FixRequest, type FixResponse, type IntentRequest, type IntentResponse,
  type KeySaveResponse, type PreflightGetResponse, type PreflightResponse, type RecordRequest, type RecordResponse,
  type ReplayResponse, type StartRequest, type StartResponse, type StopRequest, type StopResponse,
} from '../../../shared/broadcastTypes.ts';

/** What this client adds to the server's codes: there is nothing to ask (VTube Pro is not answering). */
export type ClientFailCode = BroadcastErrorCode | 'no-helper';
export interface ClientFail { ok: false; code: ClientFailCode; error: string }
export type CallResult<T> = ApiOk<T> | ClientFail;

/** The Stream Deck key press the studio should be asking about (server/deck.ts): epoch ms on VTube Pro's clock. */
export interface DeckAskView { pressedAt: number; expiresAt: number }

export interface BroadcastApi {
  /** Is a Stream Deck Go Live key waiting for a click right now? Null = no (it never errors). */
  deckPending(): Promise<DeckAskView | null>;
  status(): Promise<CallResult<BroadcastStatus>>;
  getPreflight(): Promise<CallResult<PreflightGetResponse>>;
  runPreflight(acceptAmber?: boolean): Promise<CallResult<PreflightResponse>>;
  fix(req: FixRequest): Promise<CallResult<FixResponse>>;
  intent(req: IntentRequest): Promise<CallResult<IntentResponse>>;
  start(req: StartRequest): Promise<CallResult<StartResponse>>;
  dryRun(req: DryRunRequest): Promise<CallResult<DryRunResponse>>;
  stop(req?: StopRequest): Promise<CallResult<StopResponse>>;
  destinations(): Promise<CallResult<DestinationsResponse>>;
  saveDestination(d: DestinationInput): Promise<CallResult<DestinationUpsertResponse>>;
  removeDestination(id: string): Promise<CallResult<Record<string, never>>>;
  saveKey(id: string, key: string): Promise<CallResult<KeySaveResponse>>;
  clearKey(id: string): Promise<CallResult<KeySaveResponse>>;
  record(req: RecordRequest): Promise<CallResult<RecordResponse>>;
  replay(): Promise<CallResult<ReplayResponse>>;
  setBackend(choice: BackendChoice): Promise<CallResult<BackendChoiceResponse>>;
}

export interface BroadcastApiOptions {
  fetch?: typeof fetch;
  base?: string;
}

const fail = (code: ClientFailCode, error: string): ClientFail => ({ ok: false, code, error });
const BAD_ANSWER = 'VTube Pro gave an answer this page did not understand. Restart VTube Pro and try again.';

export function createBroadcastApi(o: BroadcastApiOptions = {}): BroadcastApi {
  const base = o.base ?? BROADCAST_API_BASE;
  const doFetch: typeof fetch = o.fetch ?? ((...a) => fetch(...a));

  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, click = false): Promise<CallResult<T>> {
    let res: Response;
    try {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (click && method !== 'GET') headers['x-vtp-user-action'] = '1';
      res = await doFetch(`${base}${path}`, { method, cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      return fail('no-helper', 'VTube Pro can’t be reached right now.');
    }
    let j: unknown;
    try { j = await res.json(); } catch { return fail('internal', BAD_ANSWER); }   // (an HTML page answered)
    if (!j || typeof j !== 'object' || typeof (j as { ok?: unknown }).ok !== 'boolean') return fail('internal', BAD_ANSWER);
    const r = j as ApiOk<T> | ApiError;
    if (r.ok) return r as ApiOk<T>;
    return fail((r.code ?? 'internal') as ClientFailCode, typeof r.error === 'string' ? r.error : '');
  }

  const enc = encodeURIComponent;
  return {
    // (one read when the tab opens, never a timer)
    deckPending: async () => {
      try {
        const res = await doFetch('/api/deck/golive', { cache: 'no-store' });
        if (!res.ok) return null;
        const p = ((await res.json()) as { pending?: { pressedAt?: unknown; expiresAt?: unknown } | null })?.pending;
        return p && Number.isFinite(p.pressedAt) && Number.isFinite(p.expiresAt) ? { pressedAt: p.pressedAt as number, expiresAt: p.expiresAt as number } : null;
      } catch { return null; }
    },
    status: () => call('GET', '/status'),
    getPreflight: () => call('GET', '/preflight'),
    runPreflight: (acceptAmber) => call('POST', '/preflight', acceptAmber ? { acceptAmber: true } : {}, true),
    fix: (req) => call('POST', '/fix', req, true),
    intent: (req) => call('POST', '/intent', req, true),
    start: (req) => call('POST', '/start', req, true),
    dryRun: (req) => call('POST', '/dry-run', req, true),
    stop: (req) => call('POST', '/stop', req ?? { reason: 'end-show' }, true),
    destinations: () => call('GET', '/destinations'),
    // a key never rides on a destination write (BROADCAST_PROTOCOL.md section 7): it is dropped here even if a caller passes one
    saveDestination: (d) => { const { key: _drop, ...rest } = d; void _drop; return call('POST', '/destinations', { destination: rest }, true); },
    removeDestination: (id) => call('DELETE', `/destinations/${enc(id)}`, undefined, true),
    saveKey: (id, key) => call('POST', `/keys/${enc(id)}`, { key }, true),
    clearKey: (id) => call('DELETE', `/keys/${enc(id)}`, undefined, true),
    record: (req) => call('POST', '/record', req, true),
    replay: () => call('POST', '/replay', {}, true),
    setBackend: (choice) => call('POST', '/backend', { choice }, true),
  };
}
