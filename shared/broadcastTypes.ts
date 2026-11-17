// VTube Pro Live: the broadcast contract (Phase 1, Stage 1.0 contract freeze).
//
// THIS FILE IS FROZEN. Workstreams W1..W7 (docs/broadcast/OWNERSHIP.md) code against it and may NOT edit it. A change
// goes to the integrator (Stage 1.0.1), who re-publishes this file and docs/BROADCAST_PROTOCOL.md together and bumps
// BROADCAST_CONTRACT_REV. Types and constants only: no logic, no imports from server/ or src/ (shared/ is imported by
// both). The plan: Release/broadcaster/design/PLAN.md (sections 3 and 4.3, Phase 1).
//
// The wire between the Helper and a media engine is JSON + 48 kHz PCM + JPEG previews + page URLs, nothing else
// (GPL wall, plan section 2). BroadcastBackend knows nothing about OBS internals (graft G14): stock OBS today
// (ObsBackend), the VTube Pro Live Engine later (EngineBackend).
//
// Safety rules this contract encodes (AGENTS.md rule, docs/GO_LIVE.md):
//  * A stream starts ONLY from a deliberate person's click (or a Stream Deck key confirmed on screen) carrying a fresh,
//    single-use intent token. Every other source is refused (INTENT_REFUSED_SOURCES).
//  * Stream keys never appear in any GET answer, log line, diagnostics bundle, bus message or support
//    bundle (SECRET_FIELDS). They live in the DPAPI vault (server/support/vault.ts) and are pushed to the backend only
//    at Go Live.

/** Bump when this file changes (integrator only). W2's status route reports it so a stale builder is easy to spot. */
export const BROADCAST_CONTRACT_REV = 1;
/** The vendor name of the engine's obs-websocket requests and events (docs/BROADCAST_PROTOCOL.md section 3). */
export const BROADCAST_VENDOR = 'vtube-pro-live';
/** The published engine protocol version. `vtp.hello` answers with it. */
export const BROADCAST_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- secrets

/** Field names that must never reach a GET answer, a log, a diagnostics file, the bus or a support bundle. Tests of
 *  W2, W3 and W7 grep captured output for the VALUES of test secrets; this list is also used by redaction helpers. */
export const SECRET_FIELDS: readonly string[] = [
  'key', 'streamKey', 'stream_key', 'accessToken', 'access_token', 'refreshToken', 'refresh_token', 'clientSecret',
  'client_secret', 'password', 'authorization', 'token', 'deviceCode', 'device_code',
];

/** Where the secrets live: ONE vault scope (server/support/vault.ts Vault.get/set(scope, field)). W3 owns the wrapper
 *  (server/broadcast/keys.ts); nobody else touches these fields. */
export const BROADCAST_VAULT_SCOPE = 'broadcast';
export const vaultField = {
  /** A destination's stream key. */
  destKey: (destId: string) => `key:${destId}`,
  /** The engine's per-launch websocket password (Phase 2 re-adoption). */
  enginePassword: 'engine:password',
} as const;

// ---------------------------------------------------------------- errors and the route envelope

/** Machine codes of a refused or failed request. The `error` sentence next to it is always plain words for the person. */
export type BroadcastErrorCode =
  | 'no-token' | 'token-expired' | 'token-replayed' | 'token-mismatch' | 'source-not-allowed' | 'not-confirmed'
  | 'foreign-origin'   // a web page that is not this PC's studio
  | 'local-only'       // stream keys: only the studio's own page on this PC
  | 'other-live'       // the other broadcaster (OBS vs the engine) already has an output running
  | 'already-live' | 'not-live'
  | 'preflight-blocked' | 'no-destination' | 'no-key' | 'backend-unreachable' | 'backend-refused'
  | 'bad-request' | 'not-found' | 'busy' | 'internal';

export interface ApiError { ok: false; code: BroadcastErrorCode; error: string }
/** Every /api/broadcast/* answer is `T & { ok: true }` or ApiError. HTTP status: 200 ok, 400 bad-request, 403 for every
 *  intent/origin/local-only refusal, 404 not-found, 409 other-live/already-live/not-live/busy, 502 backend-*. */
export type ApiOk<T> = T & { ok: true };
export type ApiResult<T> = ApiOk<T> | ApiError;

// ---------------------------------------------------------------- backend (the seam)

/** Which engine carries the show. 'none' = the person has not chosen yet ("Which one do you stream with?"). */
export type BackendKind = 'obs' | 'engine';
export type BackendChoice = BackendKind | 'none';

/** What a backend can do. UI hides what is false. */
export interface BackendCapabilities {
  stream: boolean;
  record: boolean;
  replayBuffer: boolean | null;   // null = cannot tell yet
  virtualCamera: boolean;
  multiOutput: boolean;           // several destinations at once (engine only, Phase 4)
  rtmps: boolean; srt: boolean; whip: boolean;
  /** Keys can be held in RAM only (engine). Stock OBS stores the key in its own profile (UI says so, one plain line). */
  keyInRamOnly: boolean;
  /** `look.apply`, `place.capture` etc. (engine). */
  vendorRequests: boolean;
}

/** Output ids. 'stream' = the one RTMP(S) output stock OBS has; `dest:<destId>` = one destination of the engine. */
export type OutputId = 'stream' | 'record' | 'replay' | 'vcam' | `dest:${string}`;
export type OutputState = 'off' | 'starting' | 'live' | 'reconnecting' | 'stopping' | 'failed';

export interface OutputStatus {
  id: OutputId;
  state: OutputState;
  /** epoch ms of the last time it went live */
  since: number | null;
  droppedFrames: number;
  totalFrames: number;
  kbps: number | null;
  /** Reconnect tries since it last was live (drives the 2, 4, 8, 15, 30 s backoff display). */
  reconnects: number;
  /** Plain sentence of the last failure, no key, no URL. */
  lastError: string | null;
}

/** The video the backend runs right now. */
export interface VideoFormat { width: number; height: number; fps: number }

export interface BackendStatus {
  kind: BackendKind;
  /** Can we talk to it at all (websocket open and authenticated). */
  reachable: boolean;
  version: string | null;
  capabilities: BackendCapabilities;
  video: VideoFormat | null;
  outputs: OutputStatus[];
  /** Any output running (stream, record or replay buffer ignored): used by the updater gate and Go Live's other-live check. */
  outputActive: boolean;
  /** At least one OBS-style stream output is on the air (reconnecting counts as on the air). */
  streaming: boolean;
  recording: boolean;
  replayBufferActive: boolean | null;
  /** epoch ms this snapshot was taken */
  at: number;
}

/** 1 Hz numbers from the backend (obs-websocket GetStats + GetStreamStatus, or the engine's `stats` event). Fractions
 *  are 0..1. Null = the backend cannot tell (stock OBS has no pose age, no duplicate ratio). */
export interface BackendStats {
  at: number;
  fps: number | null;
  targetFps: number | null;
  renderSkippedFrac: number | null;
  encoderSkippedFrac: number | null;
  droppedFrac: number | null;     // network drop fraction of the stream output
  bitrateKbps: number | null;
  targetKbps: number | null;
  cpuPct: number | null;
  memoryMb: number | null;
  diskFreeMb: number | null;
  /** Engine only (Phase 2): from the avatar page stamps. */
  poseAgeP95Ms: number | null;
  dupRatio: number | null;
  outputs: OutputStatus[];
}

export type BackendEvent =
  | { k: 'stats'; s: BackendStats }
  | { k: 'output'; o: OutputStatus }
  | { k: 'health'; h: HealthId }                        // an edge the engine itself detected (Phase 2)
  | { k: 'notice'; say: string }                        // one plain sentence
  | { k: 'captureBlank'; source: string; blank: boolean }
  | { k: 'closed'; reason: string };                    // the connection to the backend ended

/** What the Helper needs from a backend. server/broadcast/backend.ts (W2) re-exports this name. Implementations:
 *  ObsBackend (W2, wraps the existing `obs` singleton, server/obs.ts unchanged), EngineBackend (Phase 2, not Phase 1).
 *  No method here starts anything by itself: the ONLY caller of startOutput and startRecord is the Go Live service, and only with a
 *  consumed intent token (BROADCAST_PROTOCOL.md section 1). */
export interface BroadcastBackend {
  readonly kind: BackendKind;
  capabilities(): BackendCapabilities;
  status(): Promise<BackendStatus>;
  /** Put the destination into the backend's stream service, in RAM where the backend allows (obs: SetStreamServiceSettings;
   *  the key is passed here and never returned by any method). Resolves when the backend accepted it. */
  setServiceInRam(svc: ServiceSettings): Promise<void>;
  startOutput(id: OutputId): Promise<OutputStatus>;
  stopOutput(id: OutputId): Promise<OutputStatus>;
  startRecord(): Promise<RecordStatus>;
  stopRecord(): Promise<RecordStatus>;
  saveReplay(): Promise<ReplaySaveResult>;
  stats(): Promise<BackendStats>;
  /** Events until the returned function is called. Cheap when nobody subscribes (the engine's 30 Hz meters are a
   *  separate subscribe, BROADCAST_PROTOCOL.md section 3). */
  subscribe(listener: (e: BackendEvent) => void): () => void;
}

/** One stream service handed to a backend at Go Live. Holds the SECRET `key`: never log, never serialize into a response. */
export interface ServiceSettings {
  destId: string;
  protocol: DestProtocol;
  /** Ingest server address, e.g. rtmp://live.twitch.tv/app. Not secret. */
  url: string;
  key: string;
}

// ---------------------------------------------------------------- destinations

export type DestPlatform = 'twitch' | 'youtube' | 'kick' | 'tiktok' | 'custom';
export type DestProtocol = 'rtmp' | 'rtmps' | 'srt' | 'whip';
/** none = no key yet; saved = pasted and kept in the vault. */
export type DestKeyState = 'none' | 'saved';

/** What every GET returns about a destination. NEVER has a key or token. */
export interface DestinationView {
  id: string;
  platform: DestPlatform;
  /** The person's own label, e.g. "My Twitch". */
  label: string;
  protocol: DestProtocol;
  /** Ingest server address (not secret). Empty for platforms where we know it (twitch/youtube/kick/tiktok defaults). */
  url: string;
  keyState: DestKeyState;
  enabled: boolean;
  /** Stream title and category kept with the destination (no platform API is called with them in this build). */
  title: string;
  category: string;
  /** Plain sentence when the destination needs the person (e.g. "Paste your Twitch stream key"). */
  needs: string | null;
}

/** A write to /api/broadcast/destinations. `key` is the only place a secret enters, and only from the local page. */
export interface DestinationInput {
  id?: string;
  platform: DestPlatform;
  label?: string;
  protocol?: DestProtocol;
  url?: string;
  title?: string;
  category?: string;
  enabled?: boolean;
  /** Pasted stream key. Local page only (403 local-only otherwise). Stored in the vault, never echoed. */
  key?: string;
}

// ---------------------------------------------------------------- intent (the Go Live rule, graft G1)

/** Where a start request comes from. Only 'click' and 'deck-confirmed' (and 'crash-resume' inside its window) may start. */
export type IntentSource =
  | 'click'               // the person pressed Go Live in the studio
  | 'deck-confirmed'      // a Stream Deck key, confirmed by a click on the studio's toast within DECK_CONFIRM_MS
  | 'crash-resume'        // auto-resume of a session the person started, inside the window, at most N an hour
  | 'deck-unconfirmed' | 'mcp' | 'autopilot' | 'schedule' | 'relay' | 'update' | 'cli' | 'macro' | 'unknown';

export const INTENT_ALLOWED_SOURCES: readonly IntentSource[] = ['click', 'deck-confirmed'];
/** Always refused as a start source, no matter what else is true. A test enumerates this list against every MCP tool,
 *  autopilot, deck, relay and CLI path (W7). `crash-resume` is allowed only through the resume rule (below). */
export const INTENT_REFUSED_SOURCES: readonly IntentSource[] =
  ['deck-unconfirmed', 'mcp', 'autopilot', 'schedule', 'relay', 'update', 'cli', 'macro', 'unknown'];

/** A token lives this long, once. */
export const INTENT_TTL_MS = 30_000;
/** A Stream Deck key press waits this long for the on-screen confirm click; no click = zero starts. */
export const DECK_CONFIRM_MS = 10_000;
/** Auto-resume after a crash: only within this window after the last frame of a session the person started... */
export const RESUME_WINDOW_MS = 90_000;
/** ...and at most this many times per rolling hour. After that the person gets the "You were live; go live again?" card. */
export const RESUME_MAX_PER_HOUR = 3;

/** POST /api/broadcast/intent: asked when the confirm card OPENS. Binds the token to what the card showed. */
export interface IntentRequest {
  source: IntentSource;
  /** The destinations and title the confirm card displayed; the token is only good for exactly this plan. */
  plan: GoLivePlan;
  /** From the page: `event.isTrusted` of the click that opened the card. A request without a trusted gesture is
   *  'unknown' to the policy (curl, scripts and MCP cannot set a trusted gesture). */
  gesture?: { trusted: boolean; at: number };
  /** deck-confirmed only: epoch ms of the deck key press (must be within DECK_CONFIRM_MS before the confirm click). */
  deckPressedAt?: number;
}
export interface IntentGrant { token: string; expiresAt: number; planHash: string }

/** What the person confirmed. Hashed (planHash) into the token. */
export interface GoLivePlan {
  destIds: string[];
  title: string;
  category: string;
  /** Local-sink dry run (10 s private test): the token for a dry run can never start a real destination. */
  dryRun?: boolean;
  record?: boolean;
}

/** W1's verdict (shared/broadcastPolicy.ts). `status` is the HTTP status W2 returns. */
export type IntentVerdict =
  | { ok: true; source: IntentSource }
  | { ok: false; code: BroadcastErrorCode; say: string; status: 403 | 409 };

// ---------------------------------------------------------------- Go Live state

export type GoLivePhase =
  | 'idle'          // nothing running
  | 'checking'      // preflight running
  | 'ready'         // preflight passed (or amber accepted), waiting for the click
  | 'confirming'    // confirm card open, intent token issued
  | 'starting'      // service pushed, StartStream sent
  | 'live'
  | 'reconnecting'  // on the air but a destination is retrying
  | 'stopping'
  | 'error';

export interface DestLiveState {
  destId: string;
  state: OutputState;
  since: number | null;
  /** Next retry in seconds (from RECONNECT_BACKOFF_S) while reconnecting. */
  retryInS: number | null;
  say: string | null;
}

/** The journal on disk (`live.json`, server/broadcast/journal.ts): only what is needed to decide a resume and to show
 *  the "You were live" card. NEVER a key. */
export interface LiveJournal {
  v: 1;
  /** epoch ms the person's click started this show; 0 = no show running */
  startedAt: number;
  source: IntentSource;
  plan: GoLivePlan;
  backend: BackendKind;
  /** Last time the Helper saw the stream alive (heartbeat), for the resume window. */
  lastAliveAt: number;
  /** Resume tries (epoch ms) in the last hour. */
  resumes: number[];
  endedCleanly: boolean;
}

export interface GoLiveState {
  phase: GoLivePhase;
  backend: BackendChoice;
  startedAt: number | null;
  /** Seconds on air (derived, for the timer); null when not live. */
  liveForS: number | null;
  plan: GoLivePlan | null;
  destinations: DestLiveState[];
  record: RecordStatus;
  replay: ReplayStatus;
  /** True while the dry run is the thing running (the program goes to the local sink only). */
  dryRun: boolean;
  /** The OTHER broadcaster has an output on right now: Go Live is refused. null = unknown. */
  otherBroadcasterLive: boolean | null;
  /** Set after a crash/reboot when a session was live: "You were live; go live again?" */
  resumeOffer: { endedAt: number; destIds: string[] } | null;
  /** Plain sentence for the person when phase is 'error'. */
  error: string | null;
}

// ---------------------------------------------------------------- health (plain words)

export type HealthId =
  | 'idle'                 // not live: no health to judge
  | 'smooth'
  | 'network-struggling'
  | 'graphics-busy'
  | 'source-black'
  | 'reconnecting'
  | 'avatar-paused';
export type HealthTone = 'ok' | 'warn' | 'bad' | 'quiet';

export interface HealthText { title: string; say: string; tone: HealthTone; fixId: FixId | null }
/** The ONLY wording the UI shows for health (W1 returns ids, the UI reads these; no raw numbers anywhere). */
export const HEALTH_TEXT: Record<HealthId, HealthText> = {
  'idle': { title: 'Not live', say: 'You are not live right now.', tone: 'quiet', fixId: null },
  'smooth': { title: 'Smooth', say: 'Your stream looks good.', tone: 'ok', fixId: null },
  'network-struggling': { title: 'Your internet is struggling',
    say: 'Your internet is having trouble keeping up. Viewers may see stutters. Lower quality can help.', tone: 'warn', fixId: 'lower-quality' },
  'graphics-busy': { title: 'Your graphics card is busy',
    say: 'Your graphics card is working very hard, so frames are being skipped. Making your avatar a little lighter can help.', tone: 'warn', fixId: 'lighter-avatar' },
  'source-black': { title: 'Your game went black',
    say: 'The picture from your game turned black. Pick your whole screen instead, or restart the capture.', tone: 'bad', fixId: 'rescue-capture' },
  'reconnecting': { title: 'Reconnecting',
    say: 'The connection to your stream dropped. VTube Pro is trying to get it back.', tone: 'warn', fixId: null },
  'avatar-paused': { title: 'Avatar paused',
    say: 'Your avatar stopped updating for a moment. The stream keeps going. Check that the VTube Pro studio is open.', tone: 'warn', fixId: 'wake-avatar' },
};

/** Waits before a destination retries after a drop, seconds (then it stays at the last value). */
export const RECONNECT_BACKOFF_S: readonly number[] = [2, 4, 8, 15, 30];

/** Everything W1's health state machine reads, once a second. Null = unknown (never counted as bad). */
export interface HealthInputs {
  at: number;
  streaming: boolean;
  outputReconnecting: boolean;
  fps: number | null;
  targetFps: number | null;
  droppedFrac: number | null;
  encoderSkippedFrac: number | null;
  renderSkippedFrac: number | null;
  bitrateKbps: number | null;
  targetKbps: number | null;
  /** 0..100 from server/gpuWatch.ts. */
  gpuBusyPct: number | null;
  /** The blank check of server/obsGaming.ts. */
  captureBlank: boolean | null;
  /** Page stamps (StampStats). msSinceLastStamp null = no output page was ever seen this session. */
  msSinceLastStamp: number | null;
  poseAgeP95Ms: number | null;
  dupRatio: number | null;
  frozenMs: number | null;
}

/** What /status carries and the bus broadcasts. */
export interface HealthView {
  id: HealthId;
  /** epoch ms the state was entered (hysteresis applied) */
  since: number;
  /** From HEALTH_TEXT, duplicated so a thin page needs no lookup. */
  title: string;
  say: string;
  tone: HealthTone;
  fixId: FixId | null;
}

// ---------------------------------------------------------------- preflight ("Check my setup")

export type PreflightId =
  | 'backend'            // OBS (or the engine) is reachable
  | 'other-broadcaster'  // the other one is not already live
  | 'destination'        // at least one destination is on
  | 'key'                // every on destination has a key / linked account
  | 'avatar-page'        // VTube Pro's picture is in the show
  | 'avatar-gl'          // that page can draw (WebGL)
  | 'tracking'          // face tracking is running
  | 'mic'                // a microphone is in the show
  | 'game'               // game capture is not black (only when a game is set up)
  | 'canvas'             // picture size/fps sensible for the chosen destination
  | 'encoder'            // a hardware encoder works (else slow mode)
  | 'upload'             // the internet upload covers the bitrate
  | 'disk'               // room to record
  | 'double-audio';      // show sounds are not heard twice

export type PreflightStatus = 'ok' | 'warn' | 'bad' | 'unknown';

/** One-click fixes. Each id maps to exactly one handler (W2 server side, called by POST /api/broadcast/fix). */
export type FixId =
  | 'start-backend' | 'open-obs-help' | 'add-avatar-page' | 'add-destination' | 'paste-key'
  | 'turn-on-tracking' | 'add-mic' | 'rescue-capture' | 'lower-quality' | 'lighter-avatar' | 'wake-avatar'
  | 'use-hardware-encoder' | 'free-disk' | 'mute-desktop-audio' | 'wait-other-broadcaster';

/** Button labels, plain words. */
export const FIX_LABEL: Record<FixId, string> = {
  'start-backend': 'Start it for me', 'open-obs-help': 'Show me how', 'add-avatar-page': 'Add VTube Pro to the show',
  'add-destination': 'Add where I stream', 'paste-key': 'Paste my stream key',
  'turn-on-tracking': 'Turn on my camera', 'add-mic': 'Pick my microphone', 'rescue-capture': 'Fix the black picture',
  'lower-quality': 'Lower the quality a little', 'lighter-avatar': 'Make my avatar lighter', 'wake-avatar': 'Wake my avatar',
  'use-hardware-encoder': 'Use my graphics card to encode', 'free-disk': 'Show me what is using space',
  'mute-desktop-audio': 'Stop the double sound', 'wait-other-broadcaster': 'I will stop the other one',
};

export interface PreflightRow {
  id: PreflightId;
  status: PreflightStatus;
  /** Short heading, plain words. */
  title: string;
  /** One sentence for the person, no jargon. */
  say: string;
  fixId: FixId | null;
  fixLabel: string | null;
}

/** ready = all ok; check = amber rows the person may accept; blocked = at least one red row. */
export type PreflightVerdict = 'ready' | 'check' | 'blocked';
export interface PreflightReport {
  at: number;
  rows: PreflightRow[];
  verdict: PreflightVerdict;
  /** Go Live button enabled (ready, or check and the person accepted amber). */
  canGoLive: boolean;
}

export type GpuTier = 'top' | 'good' | 'entry' | 'none';
export type EncoderKind = 'nvenc' | 'amf' | 'qsv' | 'x264';

/** The facts W2 gathers and W1 turns into rows. Null = unknown. No secrets. */
export interface PreflightFacts {
  at: number;
  backend: { kind: BackendChoice; reachable: boolean | null; version: string | null; authOk: boolean | null };
  otherBroadcasterLive: boolean | null;
  destinations: DestinationView[];
  avatarPages: { count: number; inBackend: number; noGl: number } | null;
  tracking: { running: boolean | null; fps: number | null } | null;
  mic: { present: boolean | null } | null;
  game: { set: boolean; captured: boolean | null; blank: boolean | null; exe: string | null } | null;
  canvas: VideoFormat | null;
  gpu: { tier: GpuTier; name: string | null; busyPct: number | null; vramFreeMb: number | null } | null;
  encoders: EncoderKind[] | null;
  /** From the upload probe; null = never measured. ageS = how old the measurement is. */
  upload: { mbps: number | null; ageS: number | null } | null;
  diskFreeGb: number | null;
  recordRequested: boolean;
  showSoundsHeardTwice: boolean | null;
}

// ---------------------------------------------------------------- ladder and governor

export interface LadderInput {
  gpuTier: GpuTier;
  encoders: EncoderKind[];
  /** Measured upload in megabits per second; null = never measured (use the tier default). */
  uploadMbps: number | null;
  /** The platform's ceiling in kbps (Twitch non-partner 6000), null = none. */
  platformMaxKbps: number | null;
  /** The game is running (the ladder leaves more headroom). */
  gaming: boolean;
}
export interface LadderPick {
  encoder: EncoderKind;
  width: number; height: number; fps: number;
  videoKbps: number; audioKbps: number;
  keyintS: 2;
  /** x264 only: shown to the person as "slow mode". */
  slowMode: boolean;
  /** Plain label, e.g. "1080p 60 fps". */
  label: string;
}

/** Governor rungs in the order they are shed under load (graft G10). Never the game. */
export type GovernorRungId = 'preview-off' | 'vertical-off' | 'secondary-off' | 'avatar-fps' | 'avatar-scale' | 'canvas' | 'main-bitrate';
export const GOVERNOR_ORDER: readonly GovernorRungId[] =
  ['preview-off', 'vertical-off', 'secondary-off', 'avatar-fps', 'avatar-scale', 'canvas', 'main-bitrate'];
/** The `governor.set` payload (BROADCAST_PROTOCOL.md section 3). */
export interface GovernorSettings {
  pageFps: number;
  renderScale: number;
  verticalOn: boolean;
  recordBitrate: number;
  previewOn: boolean;
  canvasScale: number;
}

// ---------------------------------------------------------------- stamps (avatar page telemetry, graft G4)

/** What the avatar page (src/output.ts via src/outputStamps.ts) sends about one rendered frame, 20 Hz or more.
 *  All times are the page's performance.now() in ms (QPC based on Windows), so ages never mix clocks. */
export interface Stamp {
  /** Per-page frame counter. */
  seq: number;
  /** performance.now() of the tracking pose this frame drew. */
  poseQpc: number;
  /** performance.now() when the frame's render ended. Pose age = renderQpc - poseQpc. (Added to the plan's list: age
   *  needs both ends on one clock.) */
  renderQpc: number;
  /** ms the render took */
  renderMs: number;
  mouthOpen: number;
  /** Cumulative count of frames drawn from the same pose as the one before ("same pose" frames). */
  dup: number;
  /** The react screen's four corners in page px, when a screen is shown. */
  quad?: [number, number][];
}

export interface StampStats {
  at: number;
  /** Stamps per second over the last window. */
  hz: number;
  poseAgeP50Ms: number | null;
  poseAgeP95Ms: number | null;
  /** Fraction of frames in the window that reused the previous pose. */
  dupRatio: number | null;
  /** The longest run with no new pose / no stamp in the window, ms. */
  frozenMs: number;
  /** Count of frozen intervals longer than FROZEN_INTERVAL_MS in the session. */
  frozenIntervals: number;
  msSinceLastStamp: number | null;
  pages: number;
}
export const FROZEN_INTERVAL_MS = 500;
export const STAMP_MIN_HZ = 20;

// ---------------------------------------------------------------- record and replay

export interface RecordStatus {
  active: boolean;
  paused: boolean;
  startedAt: number | null;
  durationMs: number;
  bytes: number;
  /** Folder name only, never a full path outside the person's recordings folder. */
  file: string | null;
}
/** Starting a recording needs the same fresh intent token as Go Live (plan: { destIds: [], record: true }); stopping never does. */
export type RecordRequest = { action: 'start'; token: string; plan: GoLivePlan } | { action: 'stop' };

export interface ReplayStatus {
  /** The backend has a replay buffer running. null = cannot tell. */
  available: boolean | null;
  saving: boolean;
  lastSavedAt: number | null;
  /** Seconds the buffer holds (0 when unknown). */
  seconds: number;
}
export interface ReplaySaveResult { ok: boolean; file: string | null; say: string }

// ---------------------------------------------------------------- show spec v1 (graft G5)

export type ShowTemplate = 'just-chatting' | 'gaming' | 'react' | 'interview' | 'brb';

/** Topology is what stays the same across rooms; ROOM DATA is what changes per room. A room switch changes only
 *  `room`, never creates or removes sources (spec diff emits no create/remove ops for a room-only change). */
export type SpecSourceKind =
  | 'avatar-page' | 'game-capture' | 'window-capture' | 'display-capture' | 'camera' | 'mic' | 'desktop-audio'
  | 'media' | 'browser' | 'image' | 'text' | 'color';

export interface SpecFilter { id: string; kind: string; settings: Record<string, unknown>; enabled: boolean }
export interface SpecSource {
  /** Stable id inside the spec (not the backend's name). */
  id: string;
  kind: SpecSourceKind;
  /** Name shown in the backend, prefixed "VTube Pro ". */
  name: string;
  settings: Record<string, unknown>;
  filters: SpecFilter[];
}
export interface SpecTransform { x: number; y: number; w: number; h: number; rotation: number; crop?: { l: number; t: number; r: number; b: number } }
export interface SpecItem { sourceId: string; transform: SpecTransform; visible: boolean }
/** Items are listed bottom to top. */
export interface SpecScene { id: string; name: string; items: SpecItem[] }
export interface SpecAudio { sourceId: string; volumeDb: number; muted: boolean; /** audio tracks 1..6 (G8) */ tracks: number[]; syncOffsetMs: number }

/** Per-room data pushed to shared sources (cameras, the react screen quad, fit). */
export interface RoomData {
  roomId: string;
  cameras: { id: string; fov: number; pos: [number, number, number]; look: [number, number, number] }[];
  /** Four corners of the react screen in canvas px, or null. */
  quad: [number, number][] | null;
  fit: 'fit' | 'fill' | null;
}

export interface ShowSpec {
  v: 1;
  id: string;
  name: string;
  template: ShowTemplate;
  canvas: VideoFormat;
  topology: { sources: SpecSource[]; scenes: SpecScene[]; audio: SpecAudio[]; programScene: string };
  room: RoomData | null;
}

/** One obs-websocket v5 request, in the order it must run. */
export interface SpecOp { requestType: string; requestData: Record<string, unknown>; why: string }
export interface ShowSpecDiff {
  /** Ordered. Empty when the backend already matches the spec (applying a diff twice gives zero ops). */
  ops: SpecOp[];
  /** Only `room` changed. */
  roomOnly: boolean;
  /** Backend names present but not in the spec (never deleted by a diff unless the name starts with "VTube Pro "). */
  foreign: string[];
}
/** What a backend reports to the differ: names and settings of what exists. */
export interface BackendShape {
  scenes: { name: string; items: { source: string; enabled: boolean; transform: Record<string, unknown> }[] }[];
  inputs: { name: string; kind: string; settings: Record<string, unknown>; filters: { name: string; kind: string; enabled: boolean; settings: Record<string, unknown> }[] }[];
  program: string | null;
  video: VideoFormat | null;
}

// ---------------------------------------------------------------- bus messages (helper <-> pages)

/** Output-page kind of the engine's own page (shared/obsPages.ts OutputKind gains 'engine' in W5). */
export const ENGINE_PAGE_KIND = 'engine';

export interface BroadcastNotice { id: string; at: number; tone: HealthTone; say: string }

/** One bus member, `type: 'broadcast'`. Added to BusMessage in shared/types.ts by W5 (one line; OWNERSHIP.md).
 *  stamps: output page -> helper (>= 20 Hz, batches of 1..4, never relayed to other pages).
 *  state / health / notice / stampstats: helper -> this PC's studio pages (on change, health at most 1 Hz). Never a key. */
export type BroadcastBusMessage =
  | { type: 'broadcast'; k: 'stamps'; from: string; s: Stamp[] }
  | { type: 'broadcast'; k: 'state'; s: BroadcastStatus }
  | { type: 'broadcast'; k: 'health'; h: HealthView }
  | { type: 'broadcast'; k: 'notice'; n: BroadcastNotice }
  | { type: 'broadcast'; k: 'stampstats'; s: StampStats };

// ---------------------------------------------------------------- routes: /api/broadcast/*

/** The one status object (GET /status, the bus 'state' message). */
export interface BroadcastStatus {
  contractRev: typeof BROADCAST_CONTRACT_REV;
  /** Which one the person streams with. */
  choice: BackendChoice;
  backend: BackendStatus | null;
  goLive: GoLiveState;
  health: HealthView;
  stamps: StampStats | null;
  destinations: DestinationView[];
  /** One plain line the UI shows next to Go Live when the backend is stock OBS. */
  keyNote: string | null;
  /** The engine option says "coming soon" until Phase 2. */
  engineAvailable: boolean;
  /** The 10 second private test has a receiver on this computer (a dev/test setup). false or absent = the button is not offered. */
  dryRunAvailable?: boolean;
}

export const BROADCAST_API_BASE = '/api/broadcast';
/** Who may call a route. read = loopback pages; write = loopback pages; local = the studio's own page on this PC only
 *  (403 local-only for anything else, incl. a tool without an Origin). Every route also sits behind server/localGuard.ts,
 *  and every write handler also calls the intent policy. */
export type RouteAccess = 'read' | 'write' | 'local';
export interface BroadcastRoute { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; access: RouteAccess }
export const BROADCAST_ROUTES: readonly BroadcastRoute[] = [
  { method: 'GET', path: '/status', access: 'read' },
  { method: 'GET', path: '/preflight', access: 'read' },
  { method: 'POST', path: '/preflight', access: 'write' },
  { method: 'POST', path: '/fix', access: 'write' },
  { method: 'POST', path: '/intent', access: 'write' },
  { method: 'POST', path: '/start', access: 'write' },
  { method: 'POST', path: '/dry-run', access: 'write' },
  { method: 'POST', path: '/stop', access: 'write' },
  { method: 'GET', path: '/destinations', access: 'read' },
  { method: 'POST', path: '/destinations', access: 'write' },
  { method: 'DELETE', path: '/destinations/:id', access: 'write' },
  { method: 'POST', path: '/keys/:id', access: 'local' },
  { method: 'DELETE', path: '/keys/:id', access: 'local' },
  { method: 'POST', path: '/record', access: 'write' },
  { method: 'POST', path: '/replay', access: 'write' },
  { method: 'POST', path: '/backend', access: 'write' },
];

// Request / response bodies, one pair per route. Every response is ApiResult<...>.
export type StatusResponse = BroadcastStatus;
export interface PreflightGetResponse { report: PreflightReport | null }
export interface PreflightRequest { /** the person accepted the amber rows */ acceptAmber?: boolean }
export type PreflightResponse = { report: PreflightReport };
export interface FixRequest { fixId: FixId; destId?: string }
export interface FixResponse { done: boolean; say: string; /** the UI should open this destination editor / key box next */ next: 'none' | 'destination-editor' | 'key-paste' }
export type IntentResponse = IntentGrant;
export interface StartRequest { token: string; plan: GoLivePlan }
export interface StartResponse { state: GoLiveState }
export interface DryRunRequest { token: string; seconds?: number }
export interface DryRunResponse { state: GoLiveState; /** local sink picture + meters can be read from the preview */ sinkUrl: string }
export interface StopRequest { reason?: 'end-show' | 'dry-run-done' }
export interface StopResponse { state: GoLiveState; tookMs: number }
export interface DestinationsResponse { destinations: DestinationView[] }
export interface DestinationUpsertRequest { destination: DestinationInput }
export interface DestinationUpsertResponse { destination: DestinationView }
export interface KeySaveRequest { key: string }
export interface KeySaveResponse { destination: DestinationView }
export interface RecordResponse { record: RecordStatus }
export interface ReplayResponse { result: ReplaySaveResult; replay: ReplayStatus }
export interface BackendChoiceRequest { choice: BackendChoice }
export interface BackendChoiceResponse { choice: BackendChoice }

// ---------------------------------------------------------------- module surfaces (what workstreams import from each other)
// Each interface is implemented by exactly one workstream (the file named in the comment) and consumed by the others,
// so W1..W7 can code in parallel. Implementations export a factory `create<Name>(deps?)` AND a ready-made singleton
// where it says so; a consumer takes the interface through its constructor/factory argument so tests can inject fakes.
// Pure modules (W1) have no state and no I/O: the shown functions are named exports.

/** W1 shared/broadcastPolicy.ts: the Go Live rule (G1). Pure. */
export interface IntentCheckInput {
  now: number;
  /** Who is asking, as decided by the connection, never by the body: this PC's page, any other web page, no Origin (tool). */
  origin: 'local-page' | 'foreign-web' | 'tool';
  source: IntentSource;
  gesture?: { trusted: boolean; at: number };
  deckPressedAt?: number;
  /** The grant being redeemed (null = none presented). */
  grant: { token: string; issuedAt: number; expiresAt: number; used: boolean; planHash: string; source: IntentSource } | null;
  presentedToken: string | null;
  /** planHash of the plan sent with /start (must equal grant.planHash). */
  presentedPlanHash: string;
  otherBroadcasterLive: boolean | null;
  alreadyLive: boolean;
  /** Only for source 'crash-resume'. */
  resume?: { lastAliveAt: number; resumesInLastHour: number; journalStartedByPerson: boolean };
}
export interface BroadcastPolicyApi {
  /** Used twice: once to issue (grant === null, checks source/origin/gesture/other-live) and once to redeem. */
  checkIntent(i: IntentCheckInput): IntentVerdict;
  /** Stable JSON of a plan (sorted ids), so W2 can hash it. */
  canonicalPlan(p: GoLivePlan): string;
  /** Is this source ever allowed to start (false for every INTENT_REFUSED_SOURCES entry)? */
  mayStart(source: IntentSource): boolean;
}

/** W1 shared/broadcastHealth.ts: the health state machine with hysteresis. Pure. */
export interface HealthMachine { id: HealthId; since: number; candidate: HealthId | null; candidateSince: number | null; lastNoticeAt: number | null }
export interface BroadcastHealthApi {
  initialHealth(now: number): HealthMachine;
  /** One step per second (or per event). Returns the next machine; a change of `id` is an edge to announce. */
  stepHealth(prev: HealthMachine, inputs: HealthInputs): HealthMachine;
  healthView(m: HealthMachine): HealthView;
  /** Seconds to wait before reconnect try `attempt` (1-based): 2, 4, 8, 15, 30, 30, ... (RECONNECT_BACKOFF_S). */
  reconnectDelayS(attempt: number): number;
}

/** W1 shared/broadcastPreflight.ts and shared/broadcastLadder.ts. Pure. */
export interface BroadcastPreflightApi {
  evaluatePreflight(facts: PreflightFacts, opts?: { acceptAmber?: boolean }): PreflightReport;
}
export interface BroadcastLadderApi {
  pickLadder(i: LadderInput): LadderPick;
  /** The governor: given the rung currently shed (null = none) and a load verdict, the next settings. */
  governorStep(state: { shed: GovernorRungId[] }, load: 'ok' | 'high' | 'low-for-60s', base: GovernorSettings): { shed: GovernorRungId[]; settings: GovernorSettings };
}

/** W1 shared/showSpec.ts. Pure. */
export interface ShowSpecApi {
  validateShowSpec(raw: unknown): { ok: true; spec: ShowSpec } | { ok: false; say: string };
  diffShowSpec(spec: ShowSpec, shape: BackendShape): ShowSpecDiff;
}

/** W3 server/broadcast/keys.ts: thin wrapper over server/support/vault.ts (vault.ts unchanged). The only code that reads secrets. */
export interface KeyStoreApi {
  /** Which destinations have a key. Never the key. */
  has(destId: string): boolean;
  set(destId: string, key: string): Promise<void>;
  clear(destId: string): Promise<void>;
  /** Used by Go Live only, right before setServiceInRam. */
  read(destId: string): string;
}

/** W3 server/broadcast/destinations.ts. Persists DestinationView fields (no secrets) in config/broadcast.json. */
export interface DestinationsApi {
  list(): DestinationView[];
  get(id: string): DestinationView | null;
  upsert(input: DestinationInput): Promise<DestinationView>;
  remove(id: string): Promise<boolean>;
  /** The service to hand to a backend (secret inside, never serialize). Null with a plain reason when it cannot start. */
  serviceFor(id: string): Promise<{ ok: true; svc: ServiceSettings } | { ok: false; code: BroadcastErrorCode; say: string }>;
  /** Title/category at Go Live: no platform API is called in this build, so this is a no-op. Failure is a notice, never a blocker. */
  pushMetadata(id: string): Promise<{ ok: boolean; say: string }>;
}

/** W2 server/broadcast/goLive.ts. The ONLY code path that can call BroadcastBackend.startOutput. */
export interface GoLiveServiceApi {
  state(): GoLiveState;
  issueIntent(req: IntentRequest, origin: IntentCheckInput['origin']): ApiResult<IntentResponse>;
  start(req: StartRequest, origin: IntentCheckInput['origin']): Promise<ApiResult<StartResponse>>;
  dryRun(req: DryRunRequest, origin: IntentCheckInput['origin']): Promise<ApiResult<DryRunResponse>>;
  stop(req: StopRequest): Promise<ApiResult<StopResponse>>;
  onChange(listener: (s: GoLiveState) => void): () => void;
}

/** W5 server/broadcast/stamps.ts: bus ingest + aggregation. */
export interface StampAggregatorApi {
  ingest(from: string, stamps: Stamp[], now?: number): void;
  stats(now?: number): StampStats;
  /** Forget a page that left the bus. */
  drop(from: string): void;
}
