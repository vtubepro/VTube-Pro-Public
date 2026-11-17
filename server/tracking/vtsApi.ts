// VTube Studio Public API compatible WebSocket server, so existing VTS plugins can talk to VTube Pro.
//
// Spec: https://github.com/DenchiSoft/VTubeStudio (README.md — request/response formats),
//       Files/ErrorID.cs (error numbers), Events/README.md (EventSubscriptionRequest, ModelLoadedEvent).
// Default ws://127.0.0.1:8001 (any path). Every message:
//   { apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID?: string(≤64 ASCII), messageType, data? }
// Responses echo requestID and add timestamp; failures are messageType "APIError" { errorID, message }.
//
// Authentication is NEVER automatic: AuthenticationTokenRequest parks the plugin in a pending list that
// the user approves or denies in the Track tab (REST /api/external/vts/…); the plugin gets its token only
// after approval (APIError 50 on deny or after 60 s). Tokens are random 256-bit values; only their SHA-256
// is stored.
//
// What maps where in VTube Pro:
//   AvailableModels / CurrentModel / ModelLoad   → the avatar library; loading broadcasts {type:'load'}
//   Hotkeys                                      → remote commands: expression presets, gesture reactions,
//                                                  costume changes, camera focus, screenshot ({type:'command'})
//   Expressions                                  → the expression presets (command 'expression')
//   InjectParameterData                          → ExternalTracking source 'vts-api' on the bus (head, eyes, mouth, brows ...)
//
// Pack 2 (beta.16, server/tracking/vtsItems.ts, docs/b16/VTS_API.md): the requests about the model and items go to the studio as
// bus commands and the answers come back through onBusMessage():
//   MoveModel / CurrentModel (modelPosition) / ArtMeshList / ColorTint / ItemList / ItemLoad / ItemUnload / ItemMove / ItemPin /
//   ItemAnimationControl / PermissionRequest, and the ModelMoved / Item / ModelClicked / HotkeyTriggered events.
import crypto from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { BusMessage, ExternalTracking, TrackingFrame } from '../../shared/types.ts';
import { itemBusMessage } from '../../shared/avatarItems.ts';
import { VTS_BRIDGE_TYPES, VTS_ERR, VtsApiError, VtsBridge, type VtsItemFile } from './vtsItems.ts';
import {
  RateCounter, arkitName, clamp, clamp01, eyeDeg, headDeg, num, nowSec, throttled,
  type SourceRuntime, type SourceStatus,
} from './common.ts';

export interface VtsApiConfig { enabled: boolean; port: number; bind: string }
export const VTS_API_DEFAULTS: VtsApiConfig = { enabled: false, port: 8001, bind: '127.0.0.1' };

export interface VtsTokenRecord {
  id: string;
  /** sha256(token) hex */
  hash: string;
  pluginName: string;
  pluginDeveloper: string;
  createdAt: string;
  lastUsed: string | null;
}

export interface VtsPending {
  id: string;
  pluginName: string;
  pluginDeveloper: string;
  /** data: URL of the plugin icon (PNG/JPEG, validated) */
  icon?: string;
  requestedAt: number;
  expiresAt: number;
}

/** Bus commands that tell the studio whether any plugin listens to ModelClickedEvent (src/avatar/modelClick.ts skips its raycast while none does).
 *  The studio asks (`model-click-ask`) when it opens or the bus reconnects; the helper also says it on every change. Keep in sync with modelClick.ts. */
export const MODEL_CLICK_SUBSCRIBED_COMMAND = 'model-click-subscribed';
export const MODEL_CLICK_ASK_COMMAND = 'model-click-ask';

export interface VtsAvatarInfo { id: string; name: string; thumbnail?: string; costumes: { id: string; name: string }[] }

/** What the API server needs from the rest of VTube Pro (injected so tests can fake it). */
export interface VtsApiHost {
  publish(d: ExternalTracking): void;
  broadcast(msg: BusMessage): void;
  getTokens(): VtsTokenRecord[];
  setTokens(t: VtsTokenRecord[]): void;
  listAvatars(): VtsAvatarInfo[];
  /** One avatar by id (O(1); the current model is looked up on almost every plugin request). Without it: listAvatars(). */
  getAvatar?(id: string): VtsAvatarInfo | null;
  currentAvatarId(): string | null;
  setCurrentAvatar(id: string): void;
  latestFrame(): TrackingFrame | null;
  frameRate(): number;
  /** Called whenever the pending-approval list changes (UI can poll too). */
  onPendingChange?(): void;
  /** Hear the messages the studio pages send on the bus (replies to model-state / art-list / item list, item-event, model-clicked, the
   *  commands a deck or key runs). Returns the unsubscribe. The manager forwards ExternalManager.tap() messages to it; without it the
   *  model / item requests still answer, just from what the helper itself knows. */
  busEvents?(fn: (msg: unknown) => void): () => void;
  /** Item files a plugin may load by name (default: the starter stickers in assets/library/stickers). */
  itemFiles?(): VtsItemFile[];
  /** How long to wait for a studio answer, ms (default 700; tests shorten it). */
  busTimeoutMs?: number;
}

// VTube Studio version reported to plugins (some plugins gate features on it). VTube Pro implements the
// 1.0 API surface listed above.
const VTS_VERSION = '1.28.0';
const API_NAME = 'VTubeStudioPublicAPI';
const TOKEN_TIMEOUT_MS = 60_000;
const INJECT_STALE_MS = 1000;
const MAX_MSGS_PER_SEC = 300;
/** A plugin picture rides in one message (2 MB of picture = 2.8 MB of base64). Before a plugin is approved only icon-sized messages are read. */
const MAX_MSG_BYTES = 3 * 1024 * 1024;
const MAX_UNAUTH_MSG_BYTES = 420 * 1024;

// ErrorID.cs
const E = {
  InternalServerError: 0, JSONInvalid: 2, APINameInvalid: 3, APIVersionInvalid: 4, RequestIDInvalid: 5,
  RequestTypeMissingOrEmpty: 6, RequestTypeUnknown: 7, RequestRequiresAuthetication: 8,
  TokenRequestDenied: 50, TokenRequestCurrentlyOngoing: 51, TokenRequestPluginNameInvalid: 52,
  TokenRequestDeveloperNameInvalid: 53, TokenRequestPluginIconInvalid: 54,
  AuthenticationTokenMissing: 100, AuthenticationPluginNameMissing: 101, AuthenticationPluginDeveloperMissing: 102,
  ModelIDMissing: 150, ModelIDInvalid: 151, ModelIDNotFound: 152,
  HotkeyExecutionFailedBecauseNoModelLoaded: 201, HotkeyIDNotFoundInModel: 202,
  CustomParamNameInvalid: 350, CustomParamValuesInvalid: 351, CustomParamAlreadyCreatedByOtherPlugin: 352,
  CustomParamExplanationTooLong: 353, CustomParamDefaultParamNameNotAllowed: 354, CustomParamLimitPerPluginExceeded: 355,
  CustomParamLimitTotalExceeded: 356,
  CustomParamDeletionNameInvalid: 400, CustomParamDeletionNotFound: 401, CustomParamDeletionCreatedByOtherPlugin: 402,
  CustomParamDeletionCannotDeleteDefaultParam: 403,
  InjectDataNoDataProvided: 450, InjectDataValueInvalid: 451, InjectDataWeightInvalid: 452, InjectDataParamNameNotFound: 453,
  InjectDataParamControlledByOtherPlugin: 454, InjectDataModeUnknown: 455,
  ParameterValueRequestParameterNotFound: 500,
  ExpressionStateRequestInvalidFilename: 600, ExpressionStateRequestFileNotFound: 601,
  ExpressionActivationRequestInvalidFilename: 650, ExpressionActivationRequestFileNotFound: 651,
  ExpressionActivationRequestNoModelLoaded: 652,
  EventSubscriptionRequestEventTypeUnknown: 950,
  ...VTS_ERR,
} as const;

const ApiError = VtsApiError;

// ---------------------------------------------------------------- parameters

interface ParamDef { name: string; min: number; max: number; defaultValue: number; explanation?: string; addedBy: string; owner?: string }

/** VTube Studio's default tracking input parameters (the subset VTube Pro maps). */
export const VTS_DEFAULT_PARAMS: ParamDef[] = [
  ['FacePositionX', -15, 15, 0], ['FacePositionY', -15, 15, 0], ['FacePositionZ', -10, 10, 0],
  ['FaceAngleX', -30, 30, 0], ['FaceAngleY', -30, 30, 0], ['FaceAngleZ', -30, 30, 0],
  ['MouthSmile', 0, 1, 0.5], ['MouthOpen', 0, 1, 0], ['Brows', 0, 1, 0.5], ['TongueOut', 0, 1, 0],
  ['EyeOpenLeft', 0, 1, 1], ['EyeOpenRight', 0, 1, 1],
  ['EyeLeftX', -1, 1, 0], ['EyeLeftY', -1, 1, 0], ['EyeRightX', -1, 1, 0], ['EyeRightY', -1, 1, 0],
  ['CheekPuff', 0, 1, 0], ['FaceAngry', 0, 1, 0], ['BrowLeftY', 0, 1, 0.5], ['BrowRightY', 0, 1, 0.5], ['MouthX', -1, 1, 0],
].map(([name, min, max, d]) => ({ name: name as string, min: min as number, max: max as number, defaultValue: d as number, addedBy: 'VTube Studio' }));
const DEFAULT_BY_NAME = new Map(VTS_DEFAULT_PARAMS.map((p) => [p.name, p]));

/**
 * VTS parameter values → ExternalTracking. Conventions (VTube Studio behaves like a mirror, Live2D
 * ParamAngleX > 0 turns toward the viewer's right):
 *   FaceAngleX > 0 performer turns right · FaceAngleY > 0 looks up · FaceAngleZ > 0 tilts right
 *   FacePositionX/Y ≈ cm (x > 0 performer's left, y up), FacePositionZ > 0 farther from the camera
 *   EyeLeftX/EyeRightX > 0 eyes look to the performer's right, …Y > 0 up (±1 ≈ ±25°/±20°)
 *   MouthSmile / Brows / BrowLeftY / BrowRightY rest at 0.5 (0 = frown / low brows, 1 = smile / raised)
 * Only channels a plugin actually provided are emitted, so a receiver can tell them apart.
 */
export function vtsParamsToExternal(v: Map<string, number>, found: boolean): ExternalTracking {
  const d: ExternalTracking = { source: 'vts-api', t: nowSec(), found };
  const has = (k: string) => v.has(k);
  const g = (k: string, def = 0) => v.get(k) ?? def;
  if (has('FaceAngleX') || has('FaceAngleY') || has('FaceAngleZ')) d.head = headDeg(-g('FaceAngleY'), -g('FaceAngleX'), -g('FaceAngleZ'));
  if (has('FacePositionX') || has('FacePositionY') || has('FacePositionZ'))
    d.headPos = [clamp(g('FacePositionX') * 0.01, -2, 2), clamp(g('FacePositionY') * 0.01, -2, 2), clamp(-g('FacePositionZ') * 0.02, -2, 2)];
  const bs: Record<string, number> = {};
  const put = (k: string, x: number) => { bs[k] = clamp01(x); };
  if (has('MouthOpen')) put('jawOpen', g('MouthOpen'));
  if (has('MouthSmile')) {
    const s = g('MouthSmile');
    put('mouthSmileLeft', (s - 0.5) * 2); put('mouthSmileRight', (s - 0.5) * 2);
    put('mouthFrownLeft', (0.5 - s) * 2); put('mouthFrownRight', (0.5 - s) * 2);
  }
  if (has('Brows')) {
    const b = g('Brows');
    put('browInnerUp', (b - 0.5) * 2); put('browOuterUpLeft', (b - 0.5) * 2); put('browOuterUpRight', (b - 0.5) * 2);
    put('browDownLeft', (0.5 - b) * 2); put('browDownRight', (0.5 - b) * 2);
  }
  for (const [p, side] of [['BrowLeftY', 'Left'], ['BrowRightY', 'Right']] as const) {
    if (!has(p)) continue;
    const b = g(p);
    put(`browOuterUp${side}`, (b - 0.5) * 2); put(`browDown${side}`, (0.5 - b) * 2);
  }
  if (has('TongueOut')) put('tongueOut', g('TongueOut'));
  if (has('CheekPuff')) put('cheekPuff', g('CheekPuff'));
  if (has('FaceAngry')) { const a = g('FaceAngry'); put('browDownLeft', Math.max(bs.browDownLeft ?? 0, a)); put('browDownRight', Math.max(bs.browDownRight ?? 0, a)); put('noseSneerLeft', a * 0.5); put('noseSneerRight', a * 0.5); }
  if (has('EyeOpenLeft')) put('eyeBlinkLeft', 1 - g('EyeOpenLeft', 1));
  if (has('EyeOpenRight')) put('eyeBlinkRight', 1 - g('EyeOpenRight', 1));
  if (has('MouthX')) { const m = g('MouthX'); put('mouthLeft', m); put('mouthRight', -m); }
  if (has('EyeLeftX') || has('EyeLeftY')) d.eyeLeft = eyeDeg(-g('EyeLeftY') * 20, -g('EyeLeftX') * 25);
  if (has('EyeRightX') || has('EyeRightY')) d.eyeRight = eyeDeg(-g('EyeRightY') * 20, -g('EyeRightX') * 25);
  // ARKit-named parameters (Perfect-Sync style custom params such as "EyeBlinkLeft" / "JawOpen")
  for (const [k, x] of v) { if (DEFAULT_BY_NAME.has(k)) continue; const a = arkitName(k); if (a) put(a, x); }
  if (Object.keys(bs).length) d.blendshapes = bs;
  return d;
}

/** Current VTS default parameter values from the studio's latest TrackingFrame (avatar space). */
export function frameToVtsParams(f: TrackingFrame | null): Map<string, number> {
  const out = new Map<string, number>();
  if (!f) return out;
  const R = 180 / Math.PI;
  const fc = f.face ?? {};
  const g = (k: string) => clamp01(num(fc[k]));
  const [yaw, pitch, roll] = f.head ?? [0, 0, 0];
  const [px, py, pz] = f.headPos ?? [0, 0, 0];
  out.set('FaceAngleX', clamp(-num(yaw) * R, -30, 30));
  out.set('FaceAngleY', clamp(-num(pitch) * R, -30, 30));
  out.set('FaceAngleZ', clamp(num(roll) * R, -30, 30));
  out.set('FacePositionX', clamp(num(px) * 100, -15, 15));
  out.set('FacePositionY', clamp(num(py) * 100, -15, 15));
  out.set('FacePositionZ', clamp(-num(pz) * 50, -10, 10));
  out.set('MouthOpen', clamp01(num(f.mouth?.open)));
  out.set('MouthSmile', clamp01(0.5 + (num(f.mouth?.smile) - num(f.mouth?.frown)) / 2));
  const up = (g('browInnerUp') + g('browOuterUpLeft') + g('browOuterUpRight')) / 3, down = (g('browDownLeft') + g('browDownRight')) / 2;
  out.set('Brows', clamp01(0.5 + (up - down) / 2));
  out.set('BrowLeftY', clamp01(0.5 + (g('browOuterUpLeft') - g('browDownLeft')) / 2));
  out.set('BrowRightY', clamp01(0.5 + (g('browOuterUpRight') - g('browDownRight')) / 2));
  out.set('TongueOut', g('tongueOut'));
  out.set('CheekPuff', g('cheekPuff'));
  out.set('FaceAngry', down);
  out.set('EyeOpenLeft', 1 - g('eyeBlinkLeft'));
  out.set('EyeOpenRight', 1 - g('eyeBlinkRight'));
  const [gx, gy] = f.gaze ?? [0, 0];
  for (const s of ['Left', 'Right']) { out.set(`Eye${s}X`, clamp(-num(gx), -1, 1)); out.set(`Eye${s}Y`, clamp(-num(gy), -1, 1)); }
  out.set('MouthX', clamp(g('mouthLeft') - g('mouthRight'), -1, 1));
  return out;
}

// ---------------------------------------------------------------- hotkeys / expressions

/** Expression preset names — keep in sync with TEST_EXPRESSIONS in src/app.ts (command 'expression'). */
export const EXPRESSION_PRESETS = ['Smile', 'Big grin', 'Surprised', 'Angry', 'Sad', 'Ooh', 'Oh!', 'Blink', 'Wink', 'Puff',
  'Tongue', 'Smirk', 'Shout', 'EE', 'M/B/P', 'Jaw side', 'Talk'];
/** Gesture kinds — src/tracking/gestures.ts GestureKind (command 'gesture'). */
export const GESTURE_KINDS = ['thumbs_up', 'thumbs_down', 'peace', 'love', 'fist', 'point', 'wave', 'palm'];

interface Hotkey { id: string; name: string; type: string; description: string; file: string; run(): void }

const exprFile = (name: string) => `${name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'expr'}.exp3.json`;

// ---------------------------------------------------------------- server

interface Session {
  ws: WebSocket;
  authed: boolean;
  tokenId: string | null;
  pluginName: string;
  pluginDeveloper: string;
  events: Map<string, unknown>;
  pendingId: string | null;
  msgWindow: number[];
  key: string;
  /** API permissions this connection asked for (PermissionRequest). */
  perms: Set<string>;
}

/** A WebSocket upgrade may carry no Origin (a native plugin) or a loopback one (a page on this PC); a website's Origin is refused. */
export function vtsOriginOk(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase());
  } catch { return false; }
}

export class VtsApiServer implements SourceRuntime {
  private http: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private sessions = new Set<Session>();
  private pending = new Map<string, VtsPending & { resolve: (ok: boolean) => void; session: Session }>();
  private custom = new Map<string, ParamDef>();
  private injected = new Map<string, { value: number; at: number; owner: string }>();
  private faceFound = true;
  private rate = new RateCounter();
  private lastError: string | null = null;
  private started = Date.now();
  private activeExpr: { name: string; until: number } | null = null;
  private testTimer: ReturnType<typeof setInterval> | null = null;
  private testCounter = 0;
  private lastModel: string | null = null;
  private modelLoadedAt = Date.now();
  private publish: ReturnType<typeof throttled>;
  private bridge: VtsBridge;
  private unsubBus: (() => void) | null = null;
  /** Hotkeys a plugin just ran: the same command coming back over the bus is not a second, manual trigger. */
  private apiRan = new Map<string, number>();
  /** The last "is anybody subscribed to ModelClickedEvent" this server told the studio. */
  private clickSubs = false;

  constructor(private cfg: VtsApiConfig, private host: VtsApiHost) {
    this.publish = throttled((d) => host.publish(d), 60);
    this.bridge = new VtsBridge({
      send: (m) => host.broadcast(m),
      emit: (name, data, o) => this.emitEvent(name, data, o?.filter, o?.only),
      subscribers: (name) => [...this.sessions].filter((x) => x.authed && x.events.has(name)).length,
      currentAvatar: () => { const a = this.currentAvatar(); return a ? { id: a.id, name: a.name } : null; },
      itemFiles: host.itemFiles ? () => host.itemFiles!() : undefined,
      timeoutMs: host.busTimeoutMs,
    });
  }

  /** A message from the studio / any bus page (see VtsApiHost.busEvents). Cheap for anything that is not ours. */
  onBusMessage(msg: unknown) {
    if (this.bridge.onBusMessage(msg)) return;
    const m = msg as { type?: unknown; command?: unknown; args?: unknown } | null;
    if (m && m.type === 'command' && m.command === MODEL_CLICK_ASK_COMMAND) { this.announceClickSubscribers(true); return; }
    if (!m || m.type !== 'command' || typeof m.command !== 'string' || ![...this.sessions].some((x) => x.authed && x.events.has('HotkeyTriggeredEvent'))) return;
    const id = busHotkeyId(m.command, m.args);
    const h = id ? this.hotkeys().find((x) => x.id === id) : undefined;
    if (h && (this.apiRan.get(h.id) ?? 0) < Date.now()) this.emitHotkey(h, false);
  }

  /** Tell the studio whether a plugin listens to ModelClickedEvent (on a change, or always when `force`). */
  private announceClickSubscribers(force = false) {
    const on = [...this.sessions].some((x) => x.authed && x.events.has('ModelClickedEvent'));
    if (!force && on === this.clickSubs) return;
    this.clickSubs = on;
    try { this.host.broadcast({ type: 'command', command: MODEL_CLICK_SUBSCRIBED_COMMAND, args: { on } } as BusMessage); } catch { /* the bus is best effort */ }
  }

  // ---------- lifecycle
  async start() {
    if (this.http) return;
    const server = http.createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain' });
      res.end('VTube Pro — VTube Studio API compatible WebSocket endpoint. Connect with ws://');
    });
    // plugins are native programs and send no Origin; a browser always does, so a web page (any website the streamer has open) cannot talk to this port
    const wss = new WebSocketServer({ server, maxPayload: MAX_MSG_BYTES, perMessageDeflate: false, verifyClient: (i: { origin?: string }) => vtsOriginOk(i.origin) });
    wss.on('connection', (ws) => this.onConnection(ws));
    this.unsubBus = this.host.busEvents?.((m) => this.onBusMessage(m)) ?? null;
    wss.on('error', (e) => { this.lastError = e.message; });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.cfg.port, this.cfg.bind, () => { server.off('error', reject); resolve(); });
    }).catch((e: Error) => { this.lastError = `Can't listen on ${this.cfg.bind}:${this.cfg.port} — ${e.message}`; wss.close(); server.close(); throw e; });
    server.on('error', (e) => { this.lastError = e.message; });
    this.http = server;
    this.wss = wss;
    this.lastError = null;
    this.started = Date.now();
    this.testTimer = setInterval(() => this.tick(), 1000);
  }

  async stop() {
    if (this.testTimer) clearInterval(this.testTimer);
    this.testTimer = null;
    this.publish.cancel();
    this.unsubBus?.(); this.unsubBus = null;
    this.bridge.stop();
    for (const p of this.pending.values()) p.resolve(false);
    this.pending.clear();
    for (const s of this.sessions) { try { s.ws.close(1001, 'VTube Pro API disabled'); } catch { /* */ } }
    this.sessions.clear();
    this.announceClickSubscribers();
    const wss = this.wss, srv = this.http;
    this.wss = null; this.http = null;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
    if (srv) await new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });
  }

  status(): SourceStatus {
    const fresh = this.rate.lastSeen !== null && Date.now() - this.rate.lastSeen < 1000;
    return {
      kind: 'vts-api', enabled: this.cfg.enabled, running: !!this.http, bind: this.cfg.bind, port: this.cfg.port,
      packetsPerSec: this.rate.perSec(), packetsTotal: this.rate.total, lastSeen: this.rate.lastSeen,
      faceFound: fresh && this.faceFound, lastError: this.lastError,
      info: {
        clients: [...this.sessions].map((s) => ({ plugin: s.pluginName || '(unauthenticated)', developer: s.pluginDeveloper, authenticated: s.authed })),
        pending: this.pending.size,
        customParameters: [...this.custom.keys()],
      },
    };
  }

  // ---------- approval (REST)
  listPending(): VtsPending[] {
    return [...this.pending.values()].map(({ id, pluginName, pluginDeveloper, icon, requestedAt, expiresAt }) => ({ id, pluginName, pluginDeveloper, icon, requestedAt, expiresAt }));
  }

  decide(id: string, allow: boolean): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    p.resolve(allow);
    return true;
  }

  /** Revoking a token also drops any live session that authenticated with it. */
  revoked(tokenId: string) {
    for (const s of this.sessions) if (s.tokenId === tokenId) { s.authed = false; try { s.ws.close(4001, 'Token revoked'); } catch { /* */ } }
  }

  /** Called by the manager when the studio's avatar changes (bus heartbeat) → ModelLoadedEvent. */
  modelChanged(id: string | null) {
    if (id === this.lastModel) return;
    this.lastModel = id;
    this.modelLoadedAt = Date.now();
    const a = id ? this.avatarById(id) ?? undefined : undefined;
    this.emitEvent('ModelLoadedEvent', { modelLoaded: !!a, modelName: a?.name ?? '', modelID: a?.id ?? '' }, (cfg) => {
      const ids = (cfg as { modelID?: unknown } | undefined)?.modelID;
      return !Array.isArray(ids) || ids.length === 0 || ids.includes(a?.id);
    });
  }

  // ---------- connection handling
  private onConnection(ws: WebSocket) {
    const s: Session = { ws, authed: false, tokenId: null, pluginName: '', pluginDeveloper: '', events: new Map(), pendingId: null, msgWindow: [], key: crypto.randomUUID(), perms: new Set() };
    this.sessions.add(s);
    ws.on('message', (data, isBinary) => { void this.onMessage(s, data, isBinary); });
    ws.on('close', () => {
      this.sessions.delete(s);
      if (s.pendingId) { this.pending.get(s.pendingId)?.resolve(false); }
      for (const [k, v] of this.injected) if (v.owner === s.key) this.injected.delete(k);
      this.bridge.sessionClosed(s);
      this.bridge.subscriptionsChanged();
      this.announceClickSubscribers();
    });
    ws.on('error', () => { try { ws.terminate(); } catch { /* */ } });
  }

  private send(s: Session, messageType: string, data: unknown, requestID?: string) {
    if (s.ws.readyState !== WebSocket.OPEN) return;
    s.ws.send(JSON.stringify({ apiName: API_NAME, apiVersion: '1.0', timestamp: Date.now(), requestID: requestID ?? crypto.randomUUID(), messageType, data }));
  }

  private sendError(s: Session, id: number, message: string, requestID?: string) {
    this.send(s, 'APIError', { errorID: id, message }, requestID);
  }

  private async onMessage(s: Session, raw: RawData, isBinary: boolean) {
    const now = Date.now();
    s.msgWindow.push(now);
    while (s.msgWindow.length && now - s.msgWindow[0] > 1000) s.msgWindow.shift();
    if (s.msgWindow.length > MAX_MSGS_PER_SEC) return; // flood: drop silently
    if (!s.authed && rawLength(raw) > MAX_UNAUTH_MSG_BYTES) { this.sendError(s, E.JSONInvalid, 'Message too large before authentication'); return; }
    let msg: Record<string, unknown>;
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : Array.isArray(raw) ? Buffer.concat(raw).toString('utf8') : Buffer.from(raw as ArrayBuffer).toString('utf8');
      void isBinary;
      const j = JSON.parse(text);
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
      msg = j as Record<string, unknown>;
    } catch { this.sendError(s, E.JSONInvalid, 'JSON invalid'); return; }
    const rid = msg.requestID;
    let requestID: string | undefined;
    if (rid !== undefined && rid !== null) {
      if (typeof rid !== 'string' || rid.length > 64 || !/^[\x20-\x7e]*$/.test(rid)) { this.sendError(s, E.RequestIDInvalid, 'requestID must be 1-64 printable ASCII characters'); return; }
      requestID = rid || undefined;
    }
    if (msg.apiName !== API_NAME) { this.sendError(s, E.APINameInvalid, `apiName must be "${API_NAME}"`, requestID); return; }
    if (msg.apiVersion !== '1.0') { this.sendError(s, E.APIVersionInvalid, 'apiVersion must be "1.0"', requestID); return; }
    const type = msg.messageType;
    if (typeof type !== 'string' || !type) { this.sendError(s, E.RequestTypeMissingOrEmpty, 'messageType missing', requestID); return; }
    const data = (msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : {}) as Record<string, unknown>;
    try {
      const out = await this.handle(s, type, data);
      if (out) this.send(s, out[0], out[1], requestID);
    } catch (e) {
      if (e instanceof ApiError) this.sendError(s, e.id, e.message, requestID);
      else { console.error('[vts-api]', e); this.sendError(s, E.InternalServerError, 'Internal error', requestID); }
    }
  }

  private requireAuth(s: Session) {
    if (!s.authed) throw new ApiError(E.RequestRequiresAuthetication, 'This request requires authentication (AuthenticationRequest)');
  }

  private avatarById(id: string): VtsAvatarInfo | null {
    return this.host.getAvatar ? this.host.getAvatar(id) : this.host.listAvatars().find((a) => a.id === id) ?? null;
  }

  private currentAvatar(): VtsAvatarInfo | null {
    const id = this.host.currentAvatarId();
    return id ? this.avatarById(id) : null;
  }

  private modelHeader() {
    const a = this.currentAvatar();
    return { modelLoaded: !!a, modelName: a?.name ?? '', modelID: a?.id ?? '' };
  }

  private async handle(s: Session, type: string, d: Record<string, unknown>): Promise<[string, unknown] | null> {
    switch (type) {
      case 'APIStateRequest':
        return ['APIStateResponse', { active: true, vTubeStudioVersion: VTS_VERSION, currentSessionAuthenticated: s.authed }];

      case 'AuthenticationTokenRequest':
        return ['AuthenticationTokenResponse', { authenticationToken: await this.requestToken(s, d) }];

      case 'AuthenticationRequest': {
        const token = d.authenticationToken, name = d.pluginName, dev = d.pluginDeveloper;
        if (typeof token !== 'string' || !token) throw new ApiError(E.AuthenticationTokenMissing, 'authenticationToken missing');
        if (typeof name !== 'string' || !name) throw new ApiError(E.AuthenticationPluginNameMissing, 'pluginName missing');
        if (typeof dev !== 'string' || !dev) throw new ApiError(E.AuthenticationPluginDeveloperMissing, 'pluginDeveloper missing');
        const hash = sha256(token);
        const tokens = this.host.getTokens();
        const rec = tokens.find((t) => safeEq(t.hash, hash) && t.pluginName === name && t.pluginDeveloper === dev);
        if (!rec) { s.authed = false; return ['AuthenticationResponse', { authenticated: false, reason: 'Token invalid or revoked. Request a new token.' }]; }
        s.authed = true; s.tokenId = rec.id; s.pluginName = name; s.pluginDeveloper = dev;
        rec.lastUsed = new Date().toISOString();
        this.host.setTokens(tokens);
        return ['AuthenticationResponse', { authenticated: true, reason: 'Token valid. The plugin is authenticated for the duration of this session.' }];
      }

      case 'StatisticsRequest':
        this.requireAuth(s);
        return ['StatisticsResponse', {
          uptime: Date.now() - this.started, framerate: Math.round(this.host.frameRate()), vTubeStudioVersion: VTS_VERSION,
          allowedPlugins: this.host.getTokens().length, connectedPlugins: [...this.sessions].filter((x) => x.authed).length,
          startedWithSteam: false, windowWidth: 1920, windowHeight: 1080, windowIsFullscreen: false,
        }];

      case 'VTSFolderInfoRequest':
        this.requireAuth(s);
        return ['VTSFolderInfoResponse', { models: 'library', backgrounds: '', items: '', config: 'config', logs: '', backup: '' }];

      case 'CurrentModelRequest': {
        this.requireAuth(s);
        const a = this.currentAvatar();
        return ['CurrentModelResponse', {
          ...this.modelHeader(), vtsModelName: a ? `${a.id}.vtube.json` : '', vtsModelIconName: a?.thumbnail ?? '', live2DModelName: '',
          modelLoadTime: 0, timeSinceModelLoaded: a ? Date.now() - this.modelLoadedAt : 0,
          numberOfLive2DParameters: 0, numberOfLive2DArtmeshes: 0, hasPhysicsFile: false, numberOfTextures: 0, textureResolution: 0,
          modelPosition: a ? await this.bridge.modelPosition() : { positionX: 0, positionY: 0, rotation: 0, size: 0 },
        }];
      }

      case 'AvailableModelsRequest': {
        this.requireAuth(s);
        const cur = this.host.currentAvatarId();
        const list = this.host.listAvatars().map((a) => ({ modelLoaded: a.id === cur, modelName: a.name, modelID: a.id, vtsModelName: `${a.id}.vtube.json`, vtsModelIconName: a.thumbnail ?? '' }));
        return ['AvailableModelsResponse', { numberOfModels: list.length, availableModels: list }];
      }

      case 'ModelLoadRequest': {
        this.requireAuth(s);
        const id = d.modelID;
        if (id === undefined || id === null || id === '') throw new ApiError(E.ModelIDMissing, 'modelID missing');
        if (typeof id !== 'string' || id.length > 128) throw new ApiError(E.ModelIDInvalid, 'modelID invalid');
        if (!this.avatarById(id)) throw new ApiError(E.ModelIDNotFound, `No model with ID '${id}'`);
        this.host.broadcast({ type: 'load', avatarId: id });
        this.host.setCurrentAvatar(id);
        setImmediate(() => this.modelChanged(id)); // event after the response, like VTube Studio
        return ['ModelLoadResponse', { modelID: id }];
      }

      case 'HotkeysInCurrentModelRequest': {
        this.requireAuth(s);
        this.bridge.warmScenes();
        const hk = this.hotkeys();
        return ['HotkeysInCurrentModelResponse', {
          ...this.modelHeader(),
          availableHotkeys: hk.map((h) => ({ name: h.name, type: h.type, description: h.description, file: h.file, hotkeyID: h.id, keyCombination: [], onScreenButtonID: -1 })),
        }];
      }

      case 'HotkeyTriggerRequest': {
        this.requireAuth(s);
        const id = typeof d.hotkeyID === 'string' ? d.hotkeyID : '';
        if (!this.currentAvatar()) throw new ApiError(E.HotkeyExecutionFailedBecauseNoModelLoaded, 'No model loaded');
        const h = this.hotkeys().find((x) => x.id === id) ?? this.hotkeys().find((x) => x.name.toLowerCase() === id.toLowerCase());
        if (!h) throw new ApiError(E.HotkeyIDNotFoundInModel, `No hotkey '${id}' in the current model`);
        this.apiRan.set(h.id, Date.now() + 700);
        h.run();
        this.emitHotkey(h, true);
        return ['HotkeyTriggerResponse', { hotkeyID: h.id }];
      }

      case 'ExpressionStateRequest': {
        this.requireAuth(s);
        const file = d.expressionFile;
        if (file !== undefined && file !== '' && (typeof file !== 'string' || !file.endsWith('.exp3.json'))) throw new ApiError(E.ExpressionStateRequestInvalidFilename, 'expressionFile must end in .exp3.json');
        let list = EXPRESSION_PRESETS.map((n) => this.exprInfo(n, d.details === true));
        if (typeof file === 'string' && file) {
          list = list.filter((e) => e.file === file);
          if (!list.length) throw new ApiError(E.ExpressionStateRequestFileNotFound, `No expression '${file}'`);
        }
        return ['ExpressionStateResponse', { ...this.modelHeader(), expressions: list }];
      }

      case 'ExpressionActivationRequest': {
        this.requireAuth(s);
        const file = d.expressionFile;
        if (typeof file !== 'string' || !file.endsWith('.exp3.json')) throw new ApiError(E.ExpressionActivationRequestInvalidFilename, 'expressionFile must end in .exp3.json');
        const name = EXPRESSION_PRESETS.find((n) => exprFile(n) === file);
        if (!name) throw new ApiError(E.ExpressionActivationRequestFileNotFound, `No expression '${file}'`);
        if (!this.currentAvatar()) throw new ApiError(E.ExpressionActivationRequestNoModelLoaded, 'No model loaded');
        this.setExpression(name, d.active !== false);
        return ['ExpressionActivationResponse', {}];
      }

      case 'InputParameterListRequest': {
        this.requireAuth(s);
        const vals = this.currentValues();
        const fmt = (p: ParamDef) => ({ name: p.name, addedBy: p.addedBy, value: vals.get(p.name) ?? p.defaultValue, min: p.min, max: p.max, defaultValue: p.defaultValue });
        return ['InputParameterListResponse', { ...this.modelHeader(), customParameters: [...this.custom.values()].map(fmt), defaultParameters: VTS_DEFAULT_PARAMS.map(fmt) }];
      }

      case 'ParameterValueRequest': {
        this.requireAuth(s);
        const name = typeof d.name === 'string' ? d.name : '';
        const p = DEFAULT_BY_NAME.get(name) ?? this.custom.get(name);
        if (!p) throw new ApiError(E.ParameterValueRequestParameterNotFound, `No parameter '${name}'`);
        const v = this.currentValues().get(p.name) ?? p.defaultValue;
        return ['ParameterValueResponse', { name: p.name, addedBy: p.addedBy, value: v, min: p.min, max: p.max, defaultValue: p.defaultValue }];
      }

      case 'ParameterCreationRequest': {
        this.requireAuth(s);
        const name = d.parameterName;
        if (typeof name !== 'string' || !/^[A-Za-z0-9]{4,32}$/.test(name)) throw new ApiError(E.CustomParamNameInvalid, 'parameterName must be 4-32 letters/digits');
        if (DEFAULT_BY_NAME.has(name)) throw new ApiError(E.CustomParamDefaultParamNameNotAllowed, `'${name}' is a default parameter`);
        const expl = typeof d.explanation === 'string' ? d.explanation : '';
        if (expl.length > 256) throw new ApiError(E.CustomParamExplanationTooLong, 'explanation too long (max 256)');
        const min = num(d.min, NaN), max = num(d.max, NaN), def = num(d.defaultValue ?? d.parameterValue, NaN);
        if (![min, max, def].every(Number.isFinite) || min >= max || Math.abs(min) > 1e6 || Math.abs(max) > 1e6 || def < min || def > max)
          throw new ApiError(E.CustomParamValuesInvalid, 'min < max and min ≤ defaultValue ≤ max required (|value| ≤ 1000000)');
        const existing = this.custom.get(name);
        if (existing && existing.owner !== s.pluginName) throw new ApiError(E.CustomParamAlreadyCreatedByOtherPlugin, `'${name}' was created by ${existing.addedBy}`);
        if (!existing) {
          if ([...this.custom.values()].filter((p) => p.owner === s.pluginName).length >= 100) throw new ApiError(E.CustomParamLimitPerPluginExceeded, 'Max 100 custom parameters per plugin');
          if (this.custom.size >= 300) throw new ApiError(E.CustomParamLimitTotalExceeded, 'Max 300 custom parameters');
        }
        this.custom.set(name, { name, min, max, defaultValue: def, explanation: expl, addedBy: s.pluginName, owner: s.pluginName });
        return ['ParameterCreationResponse', { parameterName: name }];
      }

      case 'ParameterDeletionRequest': {
        this.requireAuth(s);
        const name = d.parameterName;
        if (typeof name !== 'string' || !name) throw new ApiError(E.CustomParamDeletionNameInvalid, 'parameterName invalid');
        if (DEFAULT_BY_NAME.has(name)) throw new ApiError(E.CustomParamDeletionCannotDeleteDefaultParam, 'Default parameters cannot be deleted');
        const p = this.custom.get(name);
        if (!p) throw new ApiError(E.CustomParamDeletionNotFound, `No custom parameter '${name}'`);
        if (p.owner !== s.pluginName) throw new ApiError(E.CustomParamDeletionCreatedByOtherPlugin, `'${name}' belongs to ${p.addedBy}`);
        this.custom.delete(name);
        this.injected.delete(name);
        return ['ParameterDeletionResponse', { parameterName: name }];
      }

      case 'InjectParameterDataRequest':
        this.requireAuth(s);
        this.inject(s, d);
        return ['InjectParameterDataResponse', {}];

      case 'FaceFoundRequest':
        this.requireAuth(s);
        return ['FaceFoundResponse', { found: !!this.host.latestFrame()?.tracked }];

      case 'EventSubscriptionRequest': {
        this.requireAuth(s);
        const name = d.eventName;
        const sub = d.subscribe === true;
        if (!sub && (name === undefined || name === '')) s.events.clear();
        else {
          if (typeof name !== 'string' || !KNOWN_EVENTS.has(name)) throw new ApiError(E.EventSubscriptionRequestEventTypeUnknown, `Unknown event '${String(name)}'`);
          if (sub) s.events.set(name, d.config ?? {}); else s.events.delete(name);
        }
        setImmediate(() => { void this.bridge.onSubscribed(s, typeof name === 'string' ? name : ''); this.announceClickSubscribers(); }); // after the response, like VTube Studio
        return ['EventSubscriptionResponse', { subscribedEventCount: s.events.size, subscribedEvents: [...s.events.keys()] }];
      }

      default:
        if (VTS_BRIDGE_TYPES.has(type)) { this.requireAuth(s); return await this.bridge.handle(s, type, d); }
        throw new ApiError(E.RequestTypeUnknown, `'${type.slice(0, 64)}' is not supported by VTube Pro`);
    }
  }

  // ---------- auth token flow
  private async requestToken(s: Session, d: Record<string, unknown>): Promise<string> {
    const name = d.pluginName, dev = d.pluginDeveloper, icon = d.pluginIcon;
    if (typeof name !== 'string' || name.length < 3 || name.length > 32) throw new ApiError(E.TokenRequestPluginNameInvalid, 'pluginName must be 3-32 characters');
    if (typeof dev !== 'string' || dev.length < 3 || dev.length > 32) throw new ApiError(E.TokenRequestDeveloperNameInvalid, 'pluginDeveloper must be 3-32 characters');
    let iconUrl: string | undefined;
    if (icon !== undefined && icon !== null && icon !== '') {
      iconUrl = validIcon(icon) ?? undefined;
      if (!iconUrl) throw new ApiError(E.TokenRequestPluginIconInvalid, 'pluginIcon must be a base64 PNG or JPG (128×128, ≤ 256 KB)');
    }
    if (s.pendingId && this.pending.has(s.pendingId)) throw new ApiError(E.TokenRequestCurrentlyOngoing, 'A token request is already waiting for the user');
    const id = crypto.randomUUID();
    const now = Date.now();
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => done(false), TOKEN_TIMEOUT_MS);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        s.pendingId = null;
        this.host.onPendingChange?.();
        resolve(ok);
      };
      this.pending.set(id, { id, pluginName: name, pluginDeveloper: dev, icon: iconUrl, requestedAt: now, expiresAt: now + TOKEN_TIMEOUT_MS, resolve: done, session: s });
      s.pendingId = id;
      this.host.onPendingChange?.();
    });
    if (!allowed) throw new ApiError(E.TokenRequestDenied, Date.now() - now >= TOKEN_TIMEOUT_MS - 50 ? 'Token request timed out (the user did not answer within 60 s)' : 'User denied API access for your plugin');
    const token = crypto.randomBytes(32).toString('hex');
    const tokens = this.host.getTokens();
    tokens.push({ id: crypto.randomUUID(), hash: sha256(token), pluginName: name, pluginDeveloper: dev, createdAt: new Date().toISOString(), lastUsed: null });
    this.host.setTokens(tokens);
    return token;
  }

  // ---------- parameters
  private currentValues(): Map<string, number> {
    const vals = frameToVtsParams(this.host.latestFrame());
    for (const p of this.custom.values()) if (!vals.has(p.name)) vals.set(p.name, p.defaultValue);
    const now = Date.now();
    for (const [k, v] of this.injected) if (now - v.at < INJECT_STALE_MS) vals.set(k, v.value);
    return vals;
  }

  private inject(s: Session, d: Record<string, unknown>) {
    const mode = d.mode === undefined || d.mode === null || d.mode === '' ? 'set' : d.mode;
    if (mode !== 'set' && mode !== 'add') throw new ApiError(E.InjectDataModeUnknown, "mode must be 'set' or 'add'");
    const list = d.parameterValues;
    if (!Array.isArray(list) || list.length === 0) throw new ApiError(E.InjectDataNoDataProvided, 'parameterValues must be a non-empty array');
    if (list.length > 300) throw new ApiError(E.InjectDataValueInvalid, 'Too many parameter values (max 300)');
    const now = Date.now();
    const base = mode === 'add' ? this.currentValues() : null;
    const staged: [string, number][] = [];
    for (const e of list) {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const def = DEFAULT_BY_NAME.get(id) ?? this.custom.get(id);
      if (!def && !arkitName(id)) throw new ApiError(E.InjectDataParamNameNotFound, `No parameter '${id.slice(0, 64)}'`);
      const v = typeof o.value === 'number' ? o.value : NaN;
      if (!Number.isFinite(v) || Math.abs(v) > 1e6) throw new ApiError(E.InjectDataValueInvalid, `Invalid value for '${id}'`);
      let w = 1;
      if (o.weight !== undefined && o.weight !== null) {
        w = typeof o.weight === 'number' ? o.weight : NaN;
        if (!Number.isFinite(w) || w < 0 || w > 1) throw new ApiError(E.InjectDataWeightInvalid, `Weight for '${id}' must be 0..1`);
      }
      const other = this.injected.get(id);
      if (other && other.owner !== s.key && now - other.at < INJECT_STALE_MS) throw new ApiError(E.InjectDataParamControlledByOtherPlugin, `'${id}' is currently controlled by another plugin`);
      const b = base?.get(id) ?? def?.defaultValue ?? 0;
      let x = mode === 'add' ? b + v : v;
      x = b * (1 - w) + x * w;
      if (def) x = clamp(x, def.min, def.max);
      staged.push([id, x]);
    }
    for (const [id, x] of staged) this.injected.set(id, { value: x, at: now, owner: s.key });
    if (typeof d.faceFound === 'boolean') this.faceFound = d.faceFound;
    this.rate.hit(now);
    const fresh = new Map<string, number>();
    for (const [k, v] of this.injected) if (now - v.at < INJECT_STALE_MS) fresh.set(k, v.value);
    this.publish(vtsParamsToExternal(fresh, this.faceFound));
  }

  // ---------- hotkeys & expressions
  private hotkeys(): Hotkey[] {
    const cmd = (command: string, args?: unknown) => () => this.host.broadcast({ type: 'command', command, args });
    const out: Hotkey[] = [];
    for (const n of EXPRESSION_PRESETS) out.push({ id: `expr:${n}`, name: n, type: 'ToggleExpression', description: `Expression preset "${n}"`, file: exprFile(n), run: () => this.setExpression(n, this.activeExpr?.name !== n || this.activeExpr.until < Date.now()) });
    out.push({ id: 'expr:clear', name: 'Clear expression', type: 'RemoveAllExpressions', description: 'Back to live tracking', file: '', run: () => this.setExpression(null, false) });
    for (const k of GESTURE_KINDS) out.push({ id: `gesture:${k}`, name: `Gesture: ${k.replace('_', ' ')}`, type: 'TriggerAnimation', description: `Gesture reaction "${k}" (emoji burst + face)`, file: '', run: cmd('gesture', { kind: k, side: 'right' }) });
    const a = this.currentAvatar();
    for (const c of a?.costumes ?? []) out.push({ id: `costume:${c.id}`, name: `Costume: ${c.name}`, type: 'ToggleItemScene', description: `Wear "${c.name}"`, file: '', run: cmd('costume', { id: c.id }) });
    if (a?.costumes.length) out.push({ id: 'costume:none', name: 'Costume: none', type: 'ToggleItemScene', description: 'Take the costume off', file: '', run: cmd('costume', { id: null }) });
    for (const n of this.bridge.sceneNames()) out.push({ id: `itemscene:${n}`, name: `Item scene: ${n}`, type: 'ToggleItemScene', description: `Show or hide the item scene "${n}"`, file: '', run: () => this.host.broadcast(itemBusMessage({ op: 'scene-toggle', name: n, on: 'toggle' })) });
    for (const f of ['full', 'bust', 'head']) out.push({ id: `focus:${f}`, name: `Camera: ${f}`, type: 'MoveModel', description: `Frame the ${f}`, file: '', run: cmd('focus', { focus: f }) });
    out.push({ id: 'screenshot', name: 'Screenshot', type: 'TakeScreenshot', description: 'Save a snapshot of the avatar', file: '', run: cmd('screenshot') });
    return out;
  }

  private setExpression(name: string | null, active: boolean) {
    if (active && name) {
      this.activeExpr = { name, until: Date.now() + 600_000 };
      this.host.broadcast({ type: 'command', command: 'expression', args: { name, seconds: 600 } });
    } else if (!name || this.activeExpr?.name === name) {
      this.activeExpr = null;
      // a near-zero override of the empty 'Neutral' preset replaces (ends) the running one
      this.host.broadcast({ type: 'command', command: 'expression', args: { name: 'Neutral', seconds: 0.05 } });
    }
  }

  private exprInfo(name: string, details: boolean) {
    void details; // presets have no Live2D parameters to list
    const active = !!this.activeExpr && this.activeExpr.name === name && this.activeExpr.until > Date.now();
    return {
      name, file: exprFile(name), active, deactivateWhenKeyIsLetGo: false, autoDeactivateAfterSeconds: false,
      secondsRemaining: 0, usedInHotkeys: [{ name, id: `expr:${name}` }], parameters: [] as { name: string; value: number }[],
    };
  }

  // ---------- events
  private emitEvent(name: string, data: unknown, filter?: (cfg: unknown) => boolean, only?: { key: string }) {
    for (const s of this.sessions) {
      if (!s.authed || !s.events.has(name) || (only && s.key !== only.key)) continue;
      if (filter && !filter(s.events.get(name))) continue;
      this.send(s, name, data);
    }
  }

  /** HotkeyTriggeredEvent, with each plugin's own filters (onlyForAction, ignoreHotkeysTriggeredByAPI). */
  private emitHotkey(h: Hotkey, byApi: boolean) {
    const m = this.modelHeader();
    this.emitEvent('HotkeyTriggeredEvent', { hotkeyID: h.id, hotkeyName: h.name, hotkeyAction: h.type, hotkeyFile: h.file, hotkeyTriggeredByAPI: byApi, modelID: m.modelID, modelName: m.modelName, isLive2DItem: false }, (cfg) => {
      const c = (cfg && typeof cfg === 'object' ? cfg : {}) as { onlyForAction?: unknown; ignoreHotkeysTriggeredByAPI?: unknown };
      return (typeof c.onlyForAction !== 'string' || c.onlyForAction === '' || c.onlyForAction === h.type) && !(byApi && c.ignoreHotkeysTriggeredByAPI === true);
    });
  }

  private tick() {
    this.testCounter++;
    for (const s of this.sessions) {
      if (!s.authed || !s.events.has('TestEvent')) continue;
      const cfg = s.events.get('TestEvent') as { testMessageForEvent?: unknown } | undefined;
      const text = typeof cfg?.testMessageForEvent === 'string' ? cfg.testMessageForEvent.slice(0, 32) : 'Hello from VTube Pro';
      this.send(s, 'TestEvent', { yourTestMessage: text, counter: this.testCounter });
    }
    if (this.activeExpr && this.activeExpr.until < Date.now()) this.activeExpr = null;
  }
}

const KNOWN_EVENTS = new Set(['TestEvent', 'ModelLoadedEvent', 'TrackingStatusChangedEvent', 'BackgroundChangedEvent', 'ModelConfigChangedEvent',
  'ModelMovedEvent', 'ModelOutlineEvent', 'HotkeyTriggeredEvent', 'ModelAnimationEvent', 'ItemEvent', 'ModelClickedEvent', 'PostProcessingEvent',
  'Live2DCubismEditorConnectedEvent']);

/** The hotkey a studio command stands for (a deck key, a rule or a keyboard shortcut ran it): same ids as hotkeys(). */
export function busHotkeyId(command: string, args: unknown): string | null {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  switch (command) {
    case 'expression': return typeof a.name !== 'string' ? null : a.name === 'Neutral' && typeof a.seconds === 'number' && a.seconds < 0.2 ? 'expr:clear' : `expr:${a.name}`;
    case 'gesture': return typeof a.kind === 'string' ? `gesture:${a.kind}` : null;
    case 'costume': return `costume:${typeof a.id === 'string' ? a.id : 'none'}`;
    case 'focus': return typeof a.focus === 'string' ? `focus:${a.focus}` : null;
    case 'screenshot': return 'screenshot';
  }
  return null;
}

function rawLength(raw: RawData): number {
  return Buffer.isBuffer(raw) ? raw.length : Array.isArray(raw) ? raw.reduce((n, b) => n + b.length, 0) : (raw as ArrayBuffer).byteLength;
}

function sha256(s: string) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Validate a base64 PNG/JPEG icon; returns a data: URL or null. */
function validIcon(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 350_000) return null;
  const b64 = v.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 8 || buf.length > 256 * 1024) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return `data:image/png;base64,${buf.toString('base64')}`;
  if (buf[0] === 0xff && buf[1] === 0xd8) return `data:image/jpeg;base64,${buf.toString('base64')}`;
  return null;
}

