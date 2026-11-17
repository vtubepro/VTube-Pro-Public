// Voice front-end (main-thread side): builds  mic → [voice-worklet: HPF 80 Hz → RNNoise → Silero-gated level
// normaliser] → analyser  inside the lip-sync AudioContext, owns the Silero worker, persists settings + the learned
// speaker level, and exposes a small API for other consumers (multiplayer bridge, remote smoothing …).
// See docs/VOICE.md. All processing is local; nothing leaves the PC.
//
// Failure is always soft: if the worklet, RNNoise or Silero can't load, create() throws / the gate falls back to
// RNNoise's own VAD, and AudioLipSync keeps using the raw mic exactly as before.

import type { Fricative } from './fricMerge.ts';

export type NoiseFilter = 'off' | 'standard' | 'strong';

export interface VoiceSettings {
  /** Off = the previous raw analysis; Standard = RNNoise + voice gate; Strong = stricter gate, no dry mix. */
  filter: NoiseFilter;
  /** 0 = only clear, close speech moves the mouth … 1 = anything voice-like does. */
  sensitivity: number;
  /** Ignore voices well below your own level at the mic (TV, stream audio on speakers, people in the room). */
  ignoreBg: boolean;
  /** Browser (WebRTC) processing on the mic track — off by default: RNNoise + our normaliser replace it. */
  browserNS: boolean;
  browserEC: boolean;
  browserAGC: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = { filter: 'standard', sensitivity: 0.5, ignoreBg: true, browserNS: false, browserEC: false, browserAGC: false };

/** Live numbers from the audio thread (≈ 50 Hz). Levels in dBFS. */
export interface VoiceStat {
  /** audio-clock time (s) */
  t: number;
  raw: number; dn: number; out: number;
  /** RNNoise voice probability of the newest 10 ms frame (−1 = RNNoise not running) */
  vad: number;
  /** Silero voice probability of the newest 32 ms window (−1 = Silero not running) */
  p: number;
  /** 1 = the voice gate is open (the analysis hears you), 0 = closed (mouth held by the camera only) */
  gate: number;
  /** 1 = opened on RNNoise's word, Silero hasn't confirmed yet */
  prov: number;
  /** 1 = a voice is being ignored as background (below your level) */
  bg: number;
  /** learned speaker level / noise floors / applied normalisation gain (dB) */
  ref: number; floor: number; rawFloor: number; gain: number;
  /** raw-signal fricative detector: confidence, class split (F, TH, S, SH) and voicing (V/Z/ZH) */
  fric: number; fF: number; fTH: number; fS: number; fSH: number; fV: number;
}

/** One lip-sync frame for external consumers — emitted every analysis tick (render rate). */
export interface VoiceFrame {
  /** performance.now() (ms) */
  t: number;
  /** voice probability 0..1 (Silero; RNNoise's VAD while Silero is loading; 1/0 from the level when filter is off) */
  vad: number;
  /** true while the voice gate is open */
  gate: boolean;
  /** 0..1 speech energy envelope (what opens the mouth) */
  level: number;
  /** 17 viseme weights (sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, L, W, aa, E, I, O, U; sum 1) */
  visemes: Record<string, number>;
  /** mouth-shape hints from the voice alone */
  mouth: { open: number; wide: number; pucker: number; funnel: number; fv: number; sib: number; closure: number };
  /** true when the new front-end is active (false = raw legacy analysis) */
  filtered: boolean;
  /** Sustained / in-word fricative from the raw-signal detector: class FF (F/V) · TH · SS (S/Z) · CH (SH/ZH),
   *  confidence 0..1, voiced (V / Z / ZH). cls null = none. */
  fricative: Fricative;
}

const SET_KEY = 'vtp.voiceFx';
const STATE_KEY = 'vtp.voiceFx.state';
const BASE = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}vendor/voice/`; // follows the vite base (web build: /studio/)

export function loadVoiceSettings(): VoiceSettings {
  try {
    const v = JSON.parse(localStorage.getItem(SET_KEY) || 'null') as Partial<VoiceSettings> | null;
    const s = { ...DEFAULT_VOICE, ...(v && typeof v === 'object' ? v : {}) };
    if (!['off', 'standard', 'strong'].includes(s.filter)) s.filter = DEFAULT_VOICE.filter;
    s.sensitivity = Math.min(1, Math.max(0, Number(s.sensitivity) || 0));
    return s;
  } catch { return { ...DEFAULT_VOICE }; }
}
export function saveVoiceSettings(s: VoiceSettings) { try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch { /* storage off */ } }

/** localStorage flag the Captions card sets, and the event it fires so a running front end follows at once. */
export const CAPTIONS_KEY = 'vtp.captions';
export const CAPTIONS_EVENT = 'vtp-captions';
export const captionsWanted = () => { try { return localStorage.getItem(CAPTIONS_KEY) === '1'; } catch { return false; } };
/** Not an observer / scene-test page. */
export function captionsAllowed(): boolean {
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('observer') || q.has('sceneTest') || q.has('web')) return false;
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  } catch { return false; }
}
export const captionsUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/captions-in`;

type Persist = { ref?: number; rawFloor?: number };
function loadState(): Persist { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') as Persist; } catch { return {}; } }
function saveState(p: Persist) { try { localStorage.setItem(STATE_KEY, JSON.stringify(p)); } catch { /* storage off */ } }

let rnnoiseBytes: Promise<ArrayBuffer> | null = null;
const workletAdded = new WeakSet<BaseAudioContext>();

export class VoiceFrontEnd {
  readonly node: AudioWorkletNode;
  stat: VoiceStat | null = null;
  /** Why Silero isn't running ('' while loading / fine). */
  vadError = '';
  vadReady = false;
  vadMs = 0;
  error = '';
  private worker: Worker | null = null;
  private calWait: ((r: Record<string, number>) => void) | null = null;
  // ---- neural visemes (optional; see src/tracking/neuralVisemes.ts)
  /** neural viseme frames: t = epoch ms of the instant described, v = 17 posteriors in VISEMES order */
  onNv: ((frames: { t: number; v: Float32Array }[]) => void) | null = null;
  nv = { on: false, ready: false, error: '', delayMs: 0, msPerSec: 0, personal: false, model: '' as '' | 'full' | 'fast' };
  private nvWait: ((r: { personal: { ow: string; ob: string } | null; n?: number; loss?: number; error?: string }) => void) | null = null;
  private saveT = 0;
  // ---- GPU lip sync (Audio2Face-3D sidecar, a2fLink.ts in the worker)
  /** ARKit frames: t = epoch ms of the instant described, w = 52 weights in the sidecar's `names` order */
  onA2f: ((frames: { t: number; w: Float32Array }[]) => void) | null = null;
  a2f = { on: false, ready: false, error: '', provider: '', futureMs: 0, msPerSec: 0, names: [] as string[], netMs: 0 };
  private a2fCfg: { on: boolean; url?: string; futureMs?: number; fps?: number } | null = null;

  // ---- live captions (captionLink.ts in the worker → the helper's /ws/captions-in; docs/LIVE_CAPTIONS.md)
  cap = { on: false, ok: false, error: '' };
  private capCfg: { on: boolean; url?: string } | null = null;
  private capOff: (() => void) | null = null;

  private nvInit: { on: boolean; personal?: { ow: string; ob: string } | null; model?: 'full' | 'fast' } | null = null;
  private constructor(node: AudioWorkletNode) { this.node = node; }

  /** Build the processor inside `ctx` (must run at 48 kHz). Throws if the worklet / RNNoise can't load. */
  static async create(ctx: AudioContext, s: VoiceSettings, nv?: { on: boolean; personal?: { ow: string; ob: string } | null; model?: 'full' | 'fast' }): Promise<VoiceFrontEnd> {
    if (Math.abs(ctx.sampleRate - 48000) > 1) throw new Error(`voice filter needs 48 kHz (context runs ${ctx.sampleRate} Hz)`);
    rnnoiseBytes ??= fetch(`${BASE}rnnoise.wasm`).then((r) => { if (!r.ok) throw new Error(`rnnoise.wasm ${r.status}`); return r.arrayBuffer(); });
    let bytes: ArrayBuffer;
    try { bytes = await rnnoiseBytes; } catch (e) { rnnoiseBytes = null; throw e; }
    if (!workletAdded.has(ctx)) { await ctx.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url).href); workletAdded.add(ctx); }
    const st = loadState();
    const node = new AudioWorkletNode(ctx, 'vtp-voice', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { rnnoise: bytes.slice(0), cfg: { ...cfgOf(s), initRef: st.ref, initRawFloor: st.rawFloor } },
    });
    const fe = new VoiceFrontEnd(node);
    fe.nvInit = nv ?? null;
    fe.watchCaptions();
    node.port.onmessage = (e) => fe.onMsg(e.data);
    fe.startVad();
    return fe;
  }

  private startVad() {
    try {
      const w = new Worker(new URL('./vadWorker.ts', import.meta.url), { type: 'module', name: 'vtp-voice-vad' });
      this.worker = w;
      const ch = new MessageChannel();
      w.onmessage = (e) => {
        const m = e.data as { type: string; error?: string; ms?: number; [k: string]: unknown };
        if (m.type === 'ready') { this.vadReady = true; this.vadError = ''; }
        else if (m.type === 'error') { this.vadError = m.error ?? 'failed'; }
        else if (m.type === 'ms') this.vadMs = m.ms ?? 0;
        else if (m.type === 'nv') this.onNv?.(m.frames as { t: number; v: Float32Array }[]);
        else if (m.type === 'nvReady') { this.nv.ready = true; this.nv.error = ''; this.nv.delayMs = Number(m.delayMs) || 0; this.nv.personal = !!m.personal; this.nv.model = m.model === 'fast' ? 'fast' : 'full'; }
        else if (m.type === 'nvError') { this.nv.ready = false; this.nv.error = String(m.error ?? 'failed'); this.node.port.postMessage({ type: 'cfg', cfg: { nv: false } }); }
        else if (m.type === 'nvMs') this.nv.msPerSec = Number(m.msPerSec) || 0;
        else if (m.type === 'nvPersonal') { this.nvWait?.(m as never); this.nvWait = null; }
        else if (m.type === 'a2f') { this.a2f.netMs = Number(m.ms) || 0; this.onA2f?.(m.frames as { t: number; w: Float32Array }[]); }
        else if (m.type === 'a2fReady') { this.a2f.ready = true; this.a2f.error = ''; this.a2f.provider = String(m.provider ?? ''); this.a2f.futureMs = Number(m.futureMs) || 0; this.a2f.names = (m.names as string[]) ?? []; }
        else if (m.type === 'a2fError') { this.a2f.ready = !!m.ok; this.a2f.error = String(m.error ?? ''); }
        else if (m.type === 'a2fStat') this.a2f.msPerSec = Number(m.msPerSec) || 0;
        else if (m.type === 'capStatus') { this.cap.ok = !!m.ok; this.cap.error = String(m.error ?? ''); }
      };
      w.onerror = (e) => { this.vadError = e.message || 'worker failed'; };
      w.postMessage({ type: 'init', base: new URL(BASE, location.href).href, port: ch.port2, streams: 1, nv: this.nvInit }, [ch.port2]);
      if (this.nvInit?.on) { this.nv.on = true; this.node.port.postMessage({ type: 'cfg', cfg: { nv: true } }); }
      this.node.port.postMessage({ type: 'vadPort', port: ch.port1 }, [ch.port1]);
      if (this.a2fCfg) this.setA2f(this.a2fCfg);
      if (this.capCfg) this.setCaptions(this.capCfg);
    } catch (e) { this.vadError = (e as Error).message; }
  }

  private onMsg(d: { type: string; s?: VoiceStat; t?: number; err?: string; r?: Record<string, number> }) {
    if (d.type === 'stat' && d.s) {
      this.stat = { ...d.s, t: d.t ?? 0 };
      if (d.err) this.error = d.err;
      // persist the learned speaker level + room floor every ~10 s (warm start next session)
      const now = performance.now();
      if (now - this.saveT > 10000 && d.s.ref > -99) { this.saveT = now; saveState({ ref: d.s.ref, rawFloor: d.s.rawFloor }); }
    } else if (d.type === 'calibrated' && d.r) { this.calWait?.(d.r); this.calWait = null; }
  }

  /** Neural visemes on/off (and/or a new personal output layer). Loads the model on first use. */
  setNeural(on: boolean, personal?: { ow: string; ob: string } | null, model?: 'full' | 'fast') {
    this.nv.on = on;
    if (!on || (model && model !== this.nv.model)) this.nv.ready = false;
    this.node.port.postMessage({ type: 'cfg', cfg: { nv: on } });
    const msg: Record<string, unknown> = { type: 'nv', on };
    if (personal !== undefined) msg.personal = personal;
    if (model) msg.model = model;
    this.worker?.postMessage(msg);
  }
  /** GPU lip sync on / off (+ sidecar url, how much future audio each frame may wait for, frame rate). */
  setA2f(c: { on: boolean; url?: string; futureMs?: number; fps?: number }) {
    this.a2fCfg = { ...(this.a2fCfg ?? {}), ...c };
    this.a2f.on = c.on;
    if (!c.on) { this.a2f.ready = false; this.a2f.error = ''; }
    this.node.port.postMessage({ type: 'cfg', cfg: { a2f: c.on } });
    this.worker?.postMessage({ type: 'a2f', ...this.a2fCfg });
  }
  /** Live captions on / off (+ the helper's socket address). Streams this front end's 16 kHz signal and gate flag, nothing else. */
  setCaptions(c: { on: boolean; url?: string }) {
    this.capCfg = { ...(this.capCfg ?? {}), ...c };
    this.cap.on = c.on;
    if (!c.on) { this.cap.ok = false; this.cap.error = ''; }
    this.node.port.postMessage({ type: 'cfg', cfg: { cap: c.on } });
    this.worker?.postMessage({ type: 'cap', ...this.capCfg });
  }
  /** The studio's Captions switch (src/ui/captionsPanel.ts) is a localStorage flag + an event: no code in src/tracking has
   *  to know. Only the real studio streams (never an observer / scene-test page: captions run on this PC). */
  private watchCaptions() {
    const apply = () => this.setCaptions({ on: captionsWanted(), url: captionsUrl() });
    if (!captionsAllowed()) return;
    apply();
    window.addEventListener(CAPTIONS_EVENT, apply);
    this.capOff = () => window.removeEventListener(CAPTIONS_EVENT, apply);
  }

  /** Personal adaptation: start recording a guided step (held phone, or a read sentence), or stop (null). */
  nvRecord(step: { kind: 'held'; phone: string } | { kind: 'script'; text: string } | null) { this.worker?.postMessage({ type: 'nvRec', step }); }
  /** Fit the personal output layer from the recorded steps (worker); resolves with it (null + error on failure). */
  nvAdapt(): Promise<{ personal: { ow: string; ob: string } | null; n?: number; loss?: number; error?: string }> {
    return new Promise((res) => {
      if (!this.worker) { res({ personal: null, error: 'voice worker not running' }); return; }
      const to = setTimeout(() => { this.nvWait = null; res({ personal: null, error: 'timed out' }); }, 20000);
      this.nvWait = (r) => { clearTimeout(to); res(r); };
      this.worker.postMessage({ type: 'nvAdapt' });
    });
  }

  apply(s: VoiceSettings) { this.node.port.postMessage({ type: 'cfg', cfg: cfgOf(s) }); }
  /** Let everything through the gate (guided voice training: held "fff" / "sss" must reach the analysis). */
  bypass(on: boolean) { this.node.port.postMessage({ type: 'cfg', cfg: { bypassGate: on } }); }

  /** Learn the room: stay quiet for `seconds`. Also forgets the learned speaker level (relearnt from your next words). */
  calibrate(seconds = 3): Promise<Record<string, number>> {
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.calWait = null; rej(new Error('calibration timed out')); }, seconds * 1000 + 3000);
      this.calWait = (r) => { clearTimeout(to); saveState({ rawFloor: r.rawFloor }); res(r); };
      this.node.port.postMessage({ type: 'state', ref: NaN, resetRef: true });
      this.node.port.postMessage({ type: 'calibrate', seconds });
    });
  }

  dispose() {
    try { this.node.port.postMessage({ type: 'cfg', cfg: { bypassGate: false } }); } catch { /* closed */ }
    this.node.port.onmessage = null;
    try { this.node.disconnect(); } catch { /* not connected */ }
    this.capOff?.(); this.capOff = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

function cfgOf(s: VoiceSettings) { return { mode: s.filter === 'off' ? 'standard' : s.filter, sensitivity: s.sensitivity, ignoreBg: s.ignoreBg }; }

// ---------------------------------------------------------------- public frame bus
/** Subscribe to every lip-sync frame the voice produces (multiplayer bridge, remote smoothing, overlays …). */
export class VoiceBus {
  private subs = new Set<(f: VoiceFrame) => void>();
  latest: VoiceFrame | null = null;
  onFrame(cb: (f: VoiceFrame) => void): () => void { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  emit(f: VoiceFrame) {
    this.latest = f;
    for (const cb of this.subs) { try { cb(f); } catch (e) { console.warn('voice.onFrame listener failed', e); } }
  }
}
