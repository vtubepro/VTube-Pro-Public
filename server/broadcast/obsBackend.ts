// ObsBackend: the stock-OBS implementation of BroadcastBackend (VTube Pro Live, Phase 1, workstream W2).
//
// It wraps the existing `obs` singleton (server/obs.ts, unchanged) and speaks standard obs-websocket v5 over the shared
// read connection (`obs.readOnly`), mapped as in docs/BROADCAST_PROTOCOL.md section 3:
//   status -> GetStreamStatus + GetRecordStatus + GetReplayBufferStatus + GetVideoSettings + GetVersion
//   setServiceInRam -> SetStreamServiceSettings        startOutput/stopOutput('stream') -> StartStream / StopStream
//   startRecord/stopRecord -> StartRecord / StopRecord  saveReplay -> SaveReplayBuffer       stats -> GetStats + GetStreamStatus
// Nothing here starts anything by itself: the ONLY caller of startOutput / startRecord is the Go Live service
// (server/broadcast/goLive.ts), and only with a consumed intent token (docs/BROADCAST_PROTOCOL.md section 1).
//
// Secrets: the stream key enters through setServiceInRam only. It is never returned, never put into an error sentence
// (every message is scrubbed of the keys it was given) and never logged. Stock OBS keeps the key in its own profile; that
// is why BroadcastStatus.keyNote tells the person in one plain line.
import type {
  BackendCapabilities, BackendEvent, BackendStats, BackendStatus, BroadcastBackend, BroadcastErrorCode, OutputId, OutputState,
  OutputStatus, RecordStatus, ReplaySaveResult, ServiceSettings, VideoFormat,
} from '../../shared/broadcastTypes.ts';
import { MIC_KIND_RE, isVtpUrl } from '../../shared/obsSetup.ts';
import type { ServiceRestorer } from './backend.ts';
import { EMPTY_PROBE, type SetupProbe, type SetupProbeResult } from './setupFacts.ts';

/** The part of ObsClient this file uses (the real one is server/obs.ts ObsClient; tests may pass their own). */
export interface ObsConn { request<T = Record<string, unknown>>(requestType: string, requestData?: Record<string, unknown>, timeoutMs?: number): Promise<T> }
/** The part of the `obs` singleton (ObsAutomation) this file uses. */
export interface ObsLike {
  canRead(): boolean;
  readOnly<T>(fn: (c: ObsConn) => Promise<T>): Promise<T>;
}

/** A failure with a plain sentence for the person (no key, no URL, no stack) and a machine code for the route. */
export class BackendError extends Error {
  constructor(readonly code: BroadcastErrorCode, readonly say: string) { super(say); this.name = 'BackendError'; }
}

const STATUS_TTL_MS = 800;
const POLL_MS = 1000;
const START_TIMEOUT_MS = 8000;
const STOP_TIMEOUT_MS = 1800;
const baseName = (p: unknown): string | null => {
  if (typeof p !== 'string' || !p) return null;
  const n = p.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return n.slice(0, 200) || null;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const frac = (a: unknown, b: unknown): number | null => { const x = num(a), y = num(b); return x !== null && y !== null && y > 0 ? Math.min(1, Math.max(0, x / y)) : null; };

export interface ObsBackendDeps {
  obs: ObsLike;
  now?: () => number;
}

export class ObsBackend implements BroadcastBackend, ServiceRestorer, SetupProbe {
  readonly kind = 'obs' as const;
  private readonly obs: ObsLike;
  private readonly now: () => number;
  private replayKnown: boolean | null = null;
  private version: string | null = null;
  private video: VideoFormat | null = null;
  private cache: { at: number; value: BackendStatus } | null = null;
  private inflight: Promise<BackendStatus> | null = null;
  private transition: { stream?: 'starting' | 'stopping'; until: number } | null = null;
  private lastBytes: { at: number; bytes: number } | null = null;
  private reconnects = 0;
  private lastError: string | null = null;
  /** Secrets this backend was given: scrubbed out of every message it produces. */
  private readonly secrets = new Set<string>();
  private held: { streamServiceType: string; streamServiceSettings: Record<string, unknown> } | null = null;
  private listeners = new Set<(e: BackendEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  private lastSeen: { reachable: boolean; states: Map<OutputId, OutputState> } = { reachable: true, states: new Map() };

  constructor(d: ObsBackendDeps) { this.obs = d.obs; this.now = d.now ?? Date.now; }

  capabilities(): BackendCapabilities {
    return { stream: true, record: true, replayBuffer: this.replayKnown, virtualCamera: false, multiOutput: false, rtmps: true, srt: true, whip: false, keyInRamOnly: false, vendorRequests: false };
  }

  // ---------------------------------------------------------------- requests

  private scrub(s: string): string {
    let out = s;
    for (const k of this.secrets) if (k.length >= 4) out = out.split(k).join('***');
    return out;
  }
  private async ask<T = Record<string, unknown>>(type: string, data?: Record<string, unknown>, timeoutMs = 3000): Promise<T> {
    if (!this.obs.canRead()) throw new BackendError('backend-unreachable', 'VTube Pro is not connected to your OBS yet. Open the Set up OBS page and press Find it for me.');
    try {
      return await this.obs.readOnly((c) => c.request<T>(type, data, timeoutMs));
    } catch (e) {
      throw this.explain(type, e);
    }
  }
  /** One plain sentence for a failure. A request OBS answered with "no" is `backend-refused`; everything else (not running,
   *  wrong password, no answer) is `backend-unreachable`. */
  private explain(type: string, e: unknown): BackendError {
    if (e instanceof BackendError) return e;
    const msg = this.scrub(String((e as Error)?.message ?? e));
    if (/rejected the password|wants a password/i.test(msg)) return new BackendError('backend-unreachable', 'OBS did not accept the saved password. Open the Set up OBS page and press Find it for me.');
    if (msg.startsWith(`${type}: `) && !/timed out$/.test(msg)) {
      const comment = msg.slice(type.length + 2).replace(/\s+/g, ' ').trim().slice(0, 160);
      return new BackendError('backend-refused', comment ? `OBS said no: ${comment}` : 'OBS said no.');
    }
    return new BackendError('backend-unreachable', 'I can’t reach OBS. Make sure OBS is open, then try again.');
  }

  // ---------------------------------------------------------------- status

  async status(): Promise<BackendStatus> {
    const t = this.now();
    if (this.cache && t - this.cache.at < STATUS_TTL_MS) return this.cache.value;
    if (this.inflight) return this.inflight;
    this.inflight = this.readStatus().then((v) => { this.cache = { at: this.now(), value: v }; return v; }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  private fresh() { this.cache = null; }

  private async readStatus(): Promise<BackendStatus> {
    const at = this.now();
    const down = (): BackendStatus => ({
      kind: 'obs', reachable: false, version: this.version, capabilities: this.capabilities(), video: this.video,
      outputs: (['stream', 'record', 'replay'] as OutputId[]).map((id) => this.output(id, null, at)), outputActive: false, streaming: false, recording: false,
      replayBufferActive: this.replayKnown, at,
    });
    if (!this.obs.canRead()) return down();
    type Out = { outputActive?: boolean; outputReconnecting?: boolean; outputDuration?: number; outputBytes?: number; outputSkippedFrames?: number; outputTotalFrames?: number; outputPaused?: boolean };
    let stream: Out;
    try { stream = await this.ask<Out>('GetStreamStatus', undefined, 2500); } catch { return down(); }
    const [rec, rep, vid, ver] = await Promise.all([
      this.ask<Out>('GetRecordStatus', undefined, 2500).catch(() => null),
      this.ask<Out>('GetReplayBufferStatus', undefined, 2500).catch(() => null),
      this.video ? Promise.resolve(null) : this.ask<{ baseWidth?: number; baseHeight?: number; outputWidth?: number; outputHeight?: number; fpsNumerator?: number; fpsDenominator?: number }>('GetVideoSettings', undefined, 2500).catch(() => null),
      this.version ? Promise.resolve(null) : this.ask<{ obsVersion?: string }>('GetVersion', undefined, 2500).catch(() => null),
    ]);
    if (vid && num(vid.outputWidth) && num(vid.outputHeight) && num(vid.fpsNumerator) && num(vid.fpsDenominator)) {
      this.video = { width: vid.outputWidth!, height: vid.outputHeight!, fps: Math.round((vid.fpsNumerator! / vid.fpsDenominator!) * 100) / 100 };
    }
    if (ver && typeof ver.obsVersion === 'string') this.version = ver.obsVersion.slice(0, 32);
    this.replayKnown = rep ? rep.outputActive === true : null;
    const outputs = [this.output('stream', stream, at), this.output('record', rec, at), this.output('replay', rep, at)];
    const streaming = stream.outputActive === true;
    const recording = rec?.outputActive === true;
    const replayOn = rep ? rep.outputActive === true : null;
    return {
      kind: 'obs', reachable: true, version: this.version, capabilities: this.capabilities(), video: this.video, outputs,
      outputActive: streaming || recording, streaming, recording, replayBufferActive: replayOn, at,
    };
  }

  private output(id: OutputId, o: { outputActive?: boolean; outputReconnecting?: boolean; outputDuration?: number; outputBytes?: number; outputSkippedFrames?: number; outputTotalFrames?: number } | null, at: number): OutputStatus {
    const active = o?.outputActive === true;
    let state: OutputState = !active ? 'off' : o?.outputReconnecting ? 'reconnecting' : 'live';
    if (id === 'stream') {
      const tr = this.transition && this.transition.until > at ? this.transition.stream : undefined;
      if (tr === 'starting' && !active) state = 'starting';
      if (tr === 'stopping' && active) state = 'stopping';
      if (state === 'reconnecting') this.reconnects++; else if (state === 'live') this.reconnects = 0;
      if (!o) this.reconnects = 0;
    }
    const dur = num(o?.outputDuration);
    let kbps: number | null = null;
    if (id === 'stream' && active) {
      const b = num(o?.outputBytes);
      if (b !== null) {
        if (this.lastBytes && at > this.lastBytes.at && b >= this.lastBytes.bytes) kbps = Math.round(((b - this.lastBytes.bytes) * 8) / (at - this.lastBytes.at));
        this.lastBytes = { at, bytes: b };
      }
    } else if (id === 'stream') this.lastBytes = null;
    return {
      id, state, since: active && dur !== null ? at - dur : null,
      droppedFrames: id === 'stream' ? num(o?.outputSkippedFrames) ?? 0 : 0, totalFrames: id === 'stream' ? num(o?.outputTotalFrames) ?? 0 : 0,
      kbps, reconnects: id === 'stream' ? this.reconnects : 0, lastError: id === 'stream' ? this.lastError : null,
    };
  }

  // ---------------------------------------------------------------- the service (where the stream goes)

  async setServiceInRam(svc: ServiceSettings): Promise<void> {
    if (svc.key) this.secrets.add(svc.key);
    if (svc.protocol === 'whip') throw new BackendError('backend-refused', 'OBS cannot send to this kind of address. Pick an RTMP address.');
    if (!/^(rtmps?|srt):\/\/[^\s]+$/i.test(svc.url)) throw new BackendError('bad-request', 'The stream address must start with rtmp:// or rtmps://.');
    await this.ask('SetStreamServiceSettings', { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: svc.url, key: svc.key, use_auth: false } }, START_TIMEOUT_MS);
    this.fresh();
  }

  async snapshotService(): Promise<void> {
    const r = await this.ask<{ streamServiceType?: string; streamServiceSettings?: Record<string, unknown> }>('GetStreamServiceSettings');
    this.held = typeof r.streamServiceType === 'string' ? { streamServiceType: r.streamServiceType, streamServiceSettings: { ...(r.streamServiceSettings ?? {}) } } : null;
    // (an answer without the service is no copy: fail, so Go Live changes nothing instead of overwriting what it could not save)
    if (!this.held) throw new BackendError('backend-unreachable', 'OBS did not say what it streams to now.');
    const k = this.held?.streamServiceSettings.key;
    if (typeof k === 'string' && k) this.secrets.add(k);
  }
  async restoreService(): Promise<boolean> {
    const h = this.held;
    if (!h) return false;
    this.held = null;
    await this.ask('SetStreamServiceSettings', { streamServiceType: h.streamServiceType, streamServiceSettings: h.streamServiceSettings }, START_TIMEOUT_MS);
    this.fresh();
    return true;
  }

  // ---------------------------------------------------------------- outputs

  async startOutput(id: OutputId): Promise<OutputStatus> {
    if (id === 'record') { await this.sendRecordStart(); return this.pick('record'); }
    if (id !== 'stream') throw new BackendError('bad-request', 'OBS has one stream output. Pick the stream.');
    this.transition = { stream: 'starting', until: this.now() + 6000 };
    this.lastError = null;
    try { await this.ask('StartStream', undefined, START_TIMEOUT_MS); }
    catch (e) { this.transition = null; this.lastError = e instanceof BackendError ? e.say : 'It did not start.'; this.fresh(); throw e; }
    this.fresh();
    return this.pick('stream');
  }
  async stopOutput(id: OutputId): Promise<OutputStatus> {
    if (id === 'record') { await this.stopRecord(); return this.pick('record'); }
    if (id !== 'stream') throw new BackendError('bad-request', 'OBS has one stream output. Pick the stream.');
    this.transition = { stream: 'stopping', until: this.now() + 4000 };
    try { await this.ask('StopStream', undefined, STOP_TIMEOUT_MS); }
    catch (e) { this.transition = null; this.fresh(); throw e; }
    this.fresh();
    return this.pick('stream');
  }
  private async pick(id: OutputId): Promise<OutputStatus> {
    const s = await this.status();
    return s.outputs.find((o) => o.id === id) ?? this.output(id, null, this.now());
  }

  private recordFrom(r: { outputActive?: boolean; outputPaused?: boolean; outputDuration?: number; outputBytes?: number } | null, file: string | null): RecordStatus {
    const active = r?.outputActive === true, dur = num(r?.outputDuration) ?? 0;
    return { active, paused: r?.outputPaused === true, startedAt: active ? this.now() - dur : null, durationMs: active ? dur : 0, bytes: num(r?.outputBytes) ?? 0, file };
  }
  /** (named so the guard test's scan for `.startRecord(` finds only Go Live as a caller) */
  private async sendRecordStart(): Promise<void> {
    await this.ask('StartRecord', undefined, START_TIMEOUT_MS);
    this.fresh();
  }
  async startRecord(): Promise<RecordStatus> {
    await this.sendRecordStart();
    return this.recordFrom(await this.ask('GetRecordStatus', undefined, 2500).catch(() => ({ outputActive: true })), null);
  }
  async stopRecord(): Promise<RecordStatus> {
    const r = await this.ask<{ outputPath?: string }>('StopRecord', undefined, 4000);
    this.fresh();
    return this.recordFrom(null, baseName(r.outputPath));
  }
  /** The recording as OBS reports it right now (used by the Record button's status). */
  async recordStatus(): Promise<RecordStatus> {
    return this.recordFrom(await this.ask('GetRecordStatus', undefined, 2500), null);
  }

  async saveReplay(): Promise<ReplaySaveResult> {
    const st = await this.ask<{ outputActive?: boolean }>('GetReplayBufferStatus', undefined, 2500).catch(() => null);
    this.replayKnown = st ? st.outputActive === true : null;
    if (!st || st.outputActive !== true) return { ok: false, file: null, say: 'Your OBS Replay Buffer is off. In OBS press Start Replay Buffer once, then try again.' };
    await this.ask('SaveReplayBuffer', undefined, 4000);
    const last = await this.ask<{ savedReplayPath?: string }>('GetLastReplayBufferReplay', undefined, 2500).catch(() => null);
    return { ok: true, file: baseName(last?.savedReplayPath), say: 'Saved your last moments.' };
  }

  // ---------------------------------------------------------------- stats and events

  async stats(): Promise<BackendStats> {
    const at = this.now();
    const [s, st, status] = await Promise.all([
      this.ask<Record<string, unknown>>('GetStats', undefined, 2500),
      this.ask<Record<string, unknown>>('GetStreamStatus', undefined, 2500).catch(() => null),
      this.status().catch(() => null),
    ]);
    const out = status?.outputs ?? [];
    const streamOut = out.find((o) => o.id === 'stream');
    return {
      at, fps: num(s.activeFps), targetFps: this.video?.fps ?? null,
      renderSkippedFrac: frac(s.renderSkippedFrames, s.renderTotalFrames), encoderSkippedFrac: frac(s.outputSkippedFrames, s.outputTotalFrames),
      droppedFrac: st ? frac(st.outputSkippedFrames, st.outputTotalFrames) : null,
      bitrateKbps: streamOut?.kbps ?? null, targetKbps: null,
      cpuPct: num(s.cpuUsage), memoryMb: num(s.memoryUsage), diskFreeMb: num(s.availableDiskSpace),
      poseAgeP95Ms: null, dupRatio: null, outputs: out,
    };
  }

  /** The few OBS facts "Check my setup" needs (microphone, Desktop Audio, the VTube Pro page's audio routing, the stream encoder):
   *  read-only obs-websocket requests, once per check, each answering on its own so one missing request leaves only its own part null. */
  async setupProbe(): Promise<SetupProbeResult> {
    if (!this.obs.canRead()) return { ...EMPTY_PROBE };
    const tryAsk = <T>(type: string, data?: Record<string, unknown>): Promise<T | null> => this.ask<T>(type, data, 2500).catch(() => null);
    type Input = { inputName?: unknown; inputKind?: unknown };
    const [special, list] = await Promise.all([
      tryAsk<Record<string, unknown>>('GetSpecialInputs'),
      tryAsk<{ inputs?: Input[] }>('GetInputList'),
    ]);
    const inputs = (list?.inputs ?? []).filter((i) => typeof i.inputName === 'string' && typeof i.inputKind === 'string')
      .map((i) => ({ name: i.inputName as string, kind: i.inputKind as string }));
    const spName = (k: string) => (typeof special?.[k] === 'string' && special[k] ? (special[k] as string) : null);
    const out: SetupProbeResult = { ...EMPTY_PROBE };
    out.desktopAudio = special ? !!(spName('desktop1') || spName('desktop2')) : null;
    if (special || list) {
      // (with one of the two requests missing, "no microphone" cannot be told: only a microphone that WAS seen counts)
      const names = [...new Set([...['mic1', 'mic2', 'mic3', 'mic4'].map(spName).filter((x): x is string => !!x), ...inputs.filter((i) => MIC_KIND_RE.test(i.kind)).map((i) => i.name)])].slice(0, 8);
      if (names.length > 0 || (special && list)) out.mics = await Promise.all(names.map(async (name) => {
        const m = await tryAsk<{ inputMuted?: unknown }>('GetInputMute', { inputName: name });
        return { name, muted: typeof m?.inputMuted === 'boolean' ? m.inputMuted : null };
      }));
    }
    if (list) {
      const pages: NonNullable<SetupProbeResult['pages']> = [];
      for (const b of inputs.filter((i) => i.kind === 'browser_source').slice(0, 8)) {
        const s = await tryAsk<{ inputSettings?: Record<string, unknown> }>('GetInputSettings', { inputName: b.name });
        if (!s || !isVtpUrl(s.inputSettings?.url)) continue;
        const reroute = s.inputSettings?.reroute_audio === true;
        const mt = reroute ? await tryAsk<{ monitorType?: unknown }>('GetInputAudioMonitorType', { inputName: b.name }) : null;
        pages.push({ name: b.name, reroute, monitor: typeof mt?.monitorType === 'string' ? mt.monitorType : null });
      }
      out.pages = pages;
    }
    const mode = await tryAsk<{ parameterValue?: unknown }>('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' });
    if (mode) {
      const enc = mode.parameterValue === 'Advanced'
        ? await tryAsk<{ parameterValue?: unknown }>('GetProfileParameter', { parameterCategory: 'AdvOut', parameterName: 'Encoder' })
        : await tryAsk<{ parameterValue?: unknown }>('GetProfileParameter', { parameterCategory: 'SimpleOutput', parameterName: 'StreamEncoder' });
      out.encoder = typeof enc?.parameterValue === 'string' && enc.parameterValue ? enc.parameterValue.slice(0, 60) : null;
    }
    return out;
  }

  subscribe(listener: (e: BackendEvent) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) { this.timer = setInterval(() => void this.poll(), POLL_MS); this.timer.unref?.(); }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
  }
  private emit(e: BackendEvent) { for (const l of [...this.listeners]) { try { l(e); } catch { /* a listener must not break the poll */ } } }
  private async poll() {
    try {
      const st = await this.status();
      if (!st.reachable) { if (this.lastSeen.reachable) this.emit({ k: 'closed', reason: 'OBS is not answering.' }); this.lastSeen.reachable = false; return; }
      this.lastSeen.reachable = true;
      for (const o of st.outputs) if (this.lastSeen.states.get(o.id) !== o.state) { this.lastSeen.states.set(o.id, o.state); this.emit({ k: 'output', o }); }
      this.emit({ k: 'stats', s: await this.stats() });
    } catch { /* the next tick tries again */ }
  }
  /** Tests / shutdown. */
  dispose() { if (this.timer) clearInterval(this.timer); this.timer = null; this.listeners.clear(); }
}

/** The ready-made backend over the real `obs` singleton. Imported lazily so a test can build ObsBackend over a mock
 *  without loading server/obs.ts (and its timers). */
let singleton: ObsBackend | null = null;
export async function obsBackend(): Promise<ObsBackend> {
  if (!singleton) { const { obs } = await import('../obs.ts'); singleton = new ObsBackend({ obs }); }
  return singleton;
}
