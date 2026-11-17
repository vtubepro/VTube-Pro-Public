// Microphone lip-sync: fast loudness envelope + MFCC vowel matching (uLipSync-style, per-voice
// profiles) + fricative detectors (F/V vs S/SH). The mic has ~20 ms latency vs the camera's ~60–90 ms,
// so it provides the TIMING of syllables and the shapes a camera can't see (teeth on lip for "F").
// Fused with camera lip capture in the app so the mouth is both fast and shaped like yours.

import { MFCC_COUNT, type VisemeProfile, type Vowel } from './mfcc.ts';
import { SpeechAnalyzer, silentMouth, type AudioMouth } from './audioFeatures.ts';
import DEFAULT_PROFILE from './visemeProfile.default.json';
import { trainLearnedProfile, type LearnedVisemeProfile, type Viseme } from './visemes.ts';
import { VoiceBus, VoiceFrontEnd, loadVoiceSettings, saveVoiceSettings, type VoiceSettings } from '../audio/voice/voiceFrontEnd.ts';
import { fricativeOf, mergeFricative, type Fricative } from '../audio/voice/fricMerge.ts';
import { NeuralMerge, autoMix, loadNeural, saveNeural, type NeuralSettings } from './neuralMerge.ts';
import { VISEMES } from './visemes.ts';
import { readback, silenceThreshold } from '../core/readbackProbe.ts';
import { A2fMerge, a2fFutureFor, type A2fSettings } from './a2fMerge.ts';
import { A2fControl } from './a2fControl.ts';
import type { GpuStatusLike, LipEngineChoice } from './lipEngine.ts';
import type { TrackingFrame } from '../../shared/types.ts';

export type { AudioMouth };

const PROFILE_KEY = 'vtp.visemeProfile';
/** Per-user consonant profile (learned from the guided setup's held "fff", "sss", "lll" … steps). */
const CONSONANT_KEY = 'vtp.consonantProfile';
/** Personal neural-viseme output layer (neuralPersonal.ts), learned in the guided setup. */
const NV_PERSONAL_KEY = 'vtp.nvPersonal';
/** the fast model's own personal layer (a personal layer only fits the model it was learned on) */
const NV_PERSONAL_FAST_KEY = 'vtp.nvPersonal.fast';
const personalKey = (m: 'full' | 'fast') => (m === 'fast' ? NV_PERSONAL_FAST_KEY : NV_PERSONAL_KEY);

export class AudioLipSync {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private src: AudioNode | null = null;
  private sink: GainNode | null = null;
  stream: MediaStream | null = null;
  /** Voice front-end (noise filter + voice gate); null = raw analysis (filter off, or it failed to load). */
  fx: VoiceFrontEnd | null = null;
  /** Why the front-end isn't running although it's switched on ('' = fine). */
  fxError = '';
  voiceSettings: VoiceSettings = loadVoiceSettings();
  /** Every analysis frame, for other consumers (multiplayer bridge ...): voice.onFrame(f => ...). See docs/VOICE.md. */
  readonly voice = new VoiceBus();
  /** Latest sustained-fricative reading (class FF / TH / SS / CH, confidence, voiced = V / Z / ZH). */
  fricative: Fricative = fricativeOf(null);
  private deviceId: string | undefined;
  private seq = 0;
  private freq = new Float32Array(0);
  private time = new Float32Array(0);
  private recording: { vowel: Vowel; frames: number[][] } | null = null;
  profile: VisemeProfile = loadProfile();
  gain = 1;
  active = false;
  deviceLabel = '';
  /** The mic lip sync listens to (its own pick: an audio interface over the Windows default). '' = not started. */
  get device(): string { return this.deviceId ?? ''; }
  last: AudioMouth = silentMouth();
  private an = new SpeechAnalyzer(this.profile);
  /** Held-sound samples from the guided setup, by viseme class. */
  private visemeRec: { cls: Viseme; xs: number[][] } | null = null;
  private visemeSamples: { cls: Viseme; x: number[] }[] = [];
  consonantProfile: LearnedVisemeProfile | null = loadConsonantProfile();
  /** Neural visemes (off by default; experimental): settings + the merge into the engine's visemes. docs/VOICE.md */
  neuralSettings: NeuralSettings = loadNeural();
  readonly neural = new NeuralMerge();
  /** which neural model runs: 'fast' (no / short lookahead) or 'full' (lookahead >= 80 ms); the app sets it per tick */
  nvModel: 'full' | 'fast' = 'fast';
  private nvPersonal: { ow: string; ob: string } | null = loadNvPersonal(NV_PERSONAL_FAST_KEY);
  constructor() { this.an.visemes.learned = this.consonantProfile; }
  /** Raw detector inputs (diagnostics / tuning). */
  dbg = { fric: 0, sibil: 0, snr: 0, cepValid: false, hiSnr: 0, nasal: 0, dip: 0, closure: 0 };

  /** Start listening. Without an explicit device, prefer an audio interface (Focusrite/Scarlett). */
  async start(deviceId?: string) {
    this.stop();
    const my = ++this.seq;
    if (!deviceId) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }); // unlocks device labels
      s.getTracks().forEach((t) => t.stop());
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      deviceId = (mics.find((m) => /focusrite|scarlett|clarett/i.test(m.label)) ?? mics[0])?.deviceId;
      this.deviceLabel = mics.find((m) => m.deviceId === deviceId)?.label ?? '';
    }
    this.deviceId = deviceId;
    const vs = this.voiceSettings, fx = vs.filter !== 'off';
    const stream = await navigator.mediaDevices.getUserMedia({
      // Filter on: raw signal into RNNoise (browser NS smears consonants and kills the F/S hiss we detect; our own
      // normaliser replaces AGC, which would also pump background voices up between words). Filter off: as before.
      audio: fx
        ? { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: vs.browserEC, noiseSuppression: vs.browserNS, autoGainControl: vs.browserAGC, channelCount: { ideal: 1 } }
        : { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    if (my !== this.seq) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    this.ctx = makeContext(fx);
    await this.build(this.ctx.createMediaStreamSource(this.stream), my);
  }

  /** src -> [voice front-end] -> analyser (-> silent sink, keeps the graph pulled). Falls back to raw on any failure. */
  private async build(src: AudioNode, my: number) {
    const ctx = this.ctx!;
    this.src = src;
    // the analyser is only published (this.analyser) once it is wired: sampling an unconnected analyser reads
    // digital silence, which drags the analysis' adaptive noise floor down and makes the next sounds look loud
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0;
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    an.connect(this.sink).connect(ctx.destination);
    this.freq = new Float32Array(an.frequencyBinCount);
    this.time = new Float32Array(an.fftSize);
    this.fxError = '';
    if (this.voiceSettings.filter !== 'off') {
      try {
        const fe = await VoiceFrontEnd.create(ctx, this.voiceSettings, { on: this.neuralSettings.on, personal: this.nvPersonal, model: this.nvModel });
        this.neural.mix = this.effectiveMix();
        this.neural.lagTol = this.nvModel === 'fast' ? 0.07 : 0;
        this.neural.clear();
        fe.onNv = (frames) => {
          for (const f of frames) {
            const v = {} as Record<(typeof VISEMES)[number], number>;
            VISEMES.forEach((k, i) => { v[k] = f.v[i]; });
            this.neural.push({ t: (f.t - performance.timeOrigin) / 1000, v });
          }
        };
        if (my !== this.seq || this.ctx !== ctx) { fe.dispose(); return; }
        this.fx = fe;
        fe.onA2f = (frames) => {
          this.a2fFrames += frames.length;
          this.a2fMerge.setNames(fe.a2f.names);
          for (const f of frames) this.a2fMerge.push({ t: (f.t - performance.timeOrigin) / 1000, w: f.w });
        };
        this.a2fMerge.clear();
        if (this.a2fSettings.on && !this.a2fBlocked) { this.a2f.ask(true); fe.setA2f({ on: true, url: this.a2fSettings.url, futureMs: this.a2fFuture }); }
        src.connect(fe.node).connect(an);
      } catch (e) {
        this.fxError = (e as Error).message || String(e);
        console.warn('voice filter unavailable, using the raw mic:', e);
      }
    }
    if (my !== this.seq || this.ctx !== ctx) return;
    if (!this.fx) src.connect(an);
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    this.analyser = an;
    this.active = true;
  }

  /** Change the noise filter / gate settings. Browser-processing changes reopen the mic; the rest applies live. */
  async setVoiceSettings(patch: Partial<VoiceSettings>) {
    const prev = this.voiceSettings;
    const next = { ...prev, ...patch };
    this.voiceSettings = next;
    saveVoiceSettings(next);
    if (!this.active || !this.ctx || !this.src) return;
    const onOff = (prev.filter === 'off') !== (next.filter === 'off');
    if (this.stream && (onOff || next.browserNS !== prev.browserNS || next.browserEC !== prev.browserEC || next.browserAGC !== prev.browserAGC)) {
      await this.start(this.deviceId);
      return;
    }
    if (onOff) { // element source (test clip): re-route in place
      const my = ++this.seq;
      try { this.src.disconnect(); } catch { /* ignore */ }
      this.fx?.dispose(); this.fx = null;
      try { this.analyser?.disconnect(); } catch { /* ignore */ }
      this.analyser = null;
      await this.build(this.src, my);
      return;
    }
    this.fx?.apply(next);
  }

  /** Neural visemes on / off, blend (0..1). Needs the noise filter (its worker) running. */
  setNeural(patch: Partial<NeuralSettings>) {
    this.neuralSettings = { ...this.neuralSettings, ...patch };
    saveNeural(this.neuralSettings);
    this.neural.mix = this.effectiveMix();
    if (!this.neuralSettings.on) this.neural.clear();
    this.fx?.setNeural(this.neuralSettings.on);
  }
  private effectiveMix() { return this.neuralSettings.mix < 0 ? autoMix(!!this.nvPersonal) : this.neuralSettings.mix; }
  /** Pick the neural model for the current lip-sync lookahead (cheap when unchanged): its personal layer comes along. */
  setNeuralModel(m: 'full' | 'fast') {
    if (m === this.nvModel) return;
    this.nvModel = m;
    this.nvPersonal = loadNvPersonal(personalKey(m));
    this.neural.clear();
    this.neural.lagTol = m === 'fast' ? 0.07 : 0;
    this.neural.mix = this.effectiveMix();
    if (this.neuralSettings.on) this.fx?.setNeural(true, this.nvPersonal, m);
  }
  // ---- GPU lip sync (Audio2Face-3D sidecar; src/tracking/a2fMerge.ts, docs/GPU_TRACKING.md)
  /** The GPU lip-sync decisions (settings, the owner's answer, start requests): src/tracking/a2fControl.ts */
  readonly a2f = new A2fControl();
  get a2fSettings(): A2fSettings { return this.a2f.settings; }
  /** why the helper refused the last start (live / card / nobody asked), '' = none: shown in the status line */
  get a2fRefusal() { return this.a2f.refusal; }
  readonly a2fMerge = new A2fMerge();
  private a2fFuture = 60;
  /** observer sandboxes never connect (one studio per sidecar: a second one would take it from the live studio) */
  a2fBlocked = false;
  private a2fFrames = 0;
  private a2fFpsT = 0;
  private a2fEnsureT = 0;
  /** frames per second arriving from the sidecar (updated every ~2 s) */
  a2fFps = 0;
  /** Per tick while on: measure the frame rate; if no frames for a while, ask the server to (re)start the sidecar
   *  (idempotent — a sidecar killed by a server restart / crash comes back without the user touching anything). */
  private a2fWatch() {
    const now = performance.now();
    if (now - this.a2fFpsT > 2000) { this.a2fFps = this.a2fFpsT ? (this.a2fFrames * 1000) / (now - this.a2fFpsT) : 0; this.a2fFrames = 0; this.a2fFpsT = now; }
    // accepted before (kept on the helper): switch on once the mic is on, so the sidecar isn't started for nothing
    if (this.a2f.tick(this.active, this.a2fBlocked)) this.afterA2fChange();
    if (!this.a2fSettings.on || this.a2fBlocked || !this.fx || !this.active) return;
    const ok = this.fx.a2f.ready && this.a2fFps > 5;
    if (!ok && now - this.a2fEnsureT > 8000) { this.a2fEnsureT = now; this.a2f.ask(true, 'studio watchdog'); this.fx.setA2f({ on: true, url: this.a2fSettings.url, futureMs: this.a2fFuture }); }
  }
  private afterA2fChange() {
    if (!this.a2fSettings.on) this.a2fMerge.clear();
    if (this.a2fBlocked) return;
    this.fx?.setA2f({ on: this.a2fSettings.on, url: this.a2fSettings.url, futureMs: this.a2fFuture });
  }
  /** The owner's one-time answer to "Your NVIDIA card can run better lip sync. Turn it on?" (src/ui/a2fPrompt.ts). */
  acceptA2f() { this.a2f.accept(this.a2fBlocked); this.afterA2fChange(); }
  declineA2f() { this.a2f.decline(); }
  /** Last engine decision (status line / diagnostics). */
  get a2fChoice() { return this.a2f.choice; }
  /** Let the studio choose the engine from what the helper says this PC has (src/tracking/lipEngine.ts): an RTX 50-series card with
   *  the Audio2Face files installed gets ONE question, never a GPU job by itself; anything else keeps the browser engine. */
  a2fAutoPick(status: GpuStatusLike | null): LipEngineChoice {
    const c = this.a2f.pick(status);
    if (c.action === 'disable') this.afterA2fChange();
    return c;
  }
  /** on / off, mix, url. The server starts / stops the sidecar itself (POST /api/gpu/a2f); this only connects. `auto` = the studio's
   *  own doing (a user's on / off is their answer, kept on the helper too: turning it off keeps it off, see optOut). */
  setA2f(patch: Partial<A2fSettings>, auto = false) {
    this.a2f.set(patch, auto, this.a2fBlocked);
    this.afterA2fChange();
  }
  /** The app calls this per tick with the lip-sync lookahead: frames wait for as much future audio as it allows. */
  setA2fLookahead(ms: number) {
    this.a2fWatch();
    const f = a2fFutureFor(ms);
    if (f === this.a2fFuture) return;
    this.a2fFuture = f;
    // no lookahead: the newest frame is up to ~futureMs + 25 ms old — accept it (shape trails, like the fast model)
    this.a2fMerge.lagTol = ms >= 60 ? 0.04 : (f + 40) / 1000;
    if (this.a2fSettings.on && !this.a2fBlocked) this.fx?.setA2f({ on: true, futureMs: f });
  }
  get a2fStatus() {
    const s = this.fx?.a2f;
    return { on: this.a2fSettings.on, mix: this.a2fSettings.mix, ready: !!s?.ready, error: this.a2fRefusal || (this.fx ? (s?.error ?? '') : (this.a2fSettings.on ? 'needs the noise filter (Standard / Strong)' : '')),
      provider: s?.provider ?? '', futureMs: s?.futureMs ?? 0, msPerSec: s?.msPerSec ?? 0, netMs: s?.netMs ?? 0, used: this.a2fMerge.dbg.used, lagMs: this.a2fMerge.dbg.lagMs,
      fps: Math.round(this.a2fFps), weight: +this.a2fMerge.dbg.k.toFixed(2) };
  }
  /** Put the A2F mouth for the instant `tVoice` (s, performance clock) on the fused frame (no-op when off). */
  applyA2f(frame: TrackingFrame, tVoice: number, dt: number): TrackingFrame {
    return this.a2fSettings.on && this.fx ? this.a2fMerge.apply(frame, tVoice, dt, this.a2fSettings.mix, this.a2fSettings.gain ?? 1) : frame;
  }
  /** Status for the UI: on, ready (model loaded + frames flowing), error, delay (ms), cost, personal. */
  get neuralStatus() {
    const s = this.fx?.nv;
    return { on: this.neuralSettings.on, mix: this.neuralSettings.mix, mixUsed: this.effectiveMix(), ready: !!s?.ready, error: this.fx ? (s?.error ?? '') : (this.neuralSettings.on ? 'needs the noise filter (Standard / Strong)' : ''),
      delayMs: s?.delayMs ?? 0, msPerSec: s?.msPerSec ?? 0, personal: !!this.nvPersonal, lagMs: this.neural.dbg.lagMs, used: this.neural.dbg.used, model: this.nvModel };
  }
  /** Blend the neural visemes for the instant `tVoice` (s, performance clock) into `a` (no-op when off / not arrived). */
  applyNeural(a: AudioMouth, tVoice: number): AudioMouth {
    return this.neuralSettings.on && this.fx ? this.neural.apply(a, tVoice) : a;
  }
  /** Guided setup: record the neural model's view of one step (held phone or read sentence); null = step done. */
  neuralRecord(step: { kind: 'held'; phone: string } | { kind: 'script'; text: string } | null) {
    if (this.neuralSettings.on) this.fx?.nvRecord(step);
  }
  /** Guided setup finished: fit + store the personal output layer (worker). Resolves with frames used (0 = skipped). */
  async finishNeuralPersonal(): Promise<number> {
    if (!this.neuralSettings.on || !this.fx) return 0;
    const r = await this.fx.nvAdapt();
    if (!r.personal) { console.warn('personal neural visemes:', r.error); return 0; }
    this.nvPersonal = r.personal;
    this.neural.mix = this.effectiveMix();
    try { localStorage.setItem(personalKey(this.nvModel), JSON.stringify(r.personal)); } catch { /* ignore */ }
    return r.n ?? 0;
  }

  /** Stay quiet for `seconds`: learns the room's noise floor (and forgets the learned speaker level). */
  async calibrateNoise(seconds = 3) {
    if (!this.fx) throw new Error(this.active ? (this.fxError ? `Noise filter unavailable: ${this.fxError}` : 'Noise filter is off') : 'Turn on the microphone first');
    return this.fx.calibrate(seconds);
  }

  /** Listen to a playing <video>/<audio> (test clips, recorded sessions) instead of the mic. */
  async startElement(el: HTMLMediaElement) {
    this.stop();
    const my = ++this.seq;
    this.ctx = makeContext(this.voiceSettings.filter !== 'off');
    el.muted = false;
    this.deviceLabel = 'video file';
    await this.build(this.ctx.createMediaElementSource(el), my); // analysed silently (sink gain 0)
  }

  stop() {
    this.seq++;
    this.fx?.dispose();
    this.fx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null; this.analyser = null; this.stream = null; this.src = null; this.sink = null; this.active = false;
  }

  /** Record ~1.6 s of one vowel from the live mic into the personal profile. */
  async calibrateVowel(v: Vowel, seconds = 1.6) {
    this.recording = { vowel: v, frames: [] };
    this.fx?.bypass(true);
    try { await new Promise((r) => setTimeout(r, seconds * 1000)); } finally { this.fx?.bypass(false); }
    const rec = this.recording;
    this.recording = null;
    if (!rec || rec.frames.length < 8) throw new Error('Not enough voice picked up — speak louder or raise mic sensitivity');
    const mean = Array.from({ length: MFCC_COUNT }, (_, i) => rec.frames.reduce((s, f) => s + f[i], 0) / rec.frames.length);
    this.profile = { ...this.profile, means: { ...this.profile.means, [v]: mean }, source: 'live calibration' };
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(this.profile)); } catch { /* ignore */ }
    return rec.frames.length;
  }

  /**
   * Record ~1.6 s of one HELD consonant ("fff", "sss", "lll", "mmm" …) into the personal viseme profile.
   * Only frames that actually carry the sound count (hiss for fricatives, voicing for L/R/W/M).
   */
  async calibrateViseme(cls: Viseme, seconds = 1.6) {
    this.visemeRec = { cls, xs: [] };
    this.fx?.bypass(true); // a held "fff" / "sss" alone isn't always voice to a VAD: let it through while training
    try { await new Promise((r) => setTimeout(r, seconds * 1000)); } finally { this.fx?.bypass(false); }
    const rec = this.visemeRec;
    this.visemeRec = null;
    if (!rec || rec.xs.length < 8) throw new Error('Not enough sound picked up — hold it a bit louder');
    // keep the steady middle (drop onset/offset)
    const n = rec.xs.length, a = Math.floor(n * 0.15), b = Math.ceil(n * 0.9);
    this.visemeSamples = this.visemeSamples.filter((s) => s.cls !== cls).concat(rec.xs.slice(a, b).map((x) => ({ cls, x })));
    return n;
  }

  /** Train + store the personal consonant profile from what calibrateViseme() captured. */
  finishVisemeCalibration() {
    if (!this.visemeSamples.length) return 0;
    const p = trainLearnedProfile(this.visemeSamples, 'live calibration ' + new Date().toISOString(), this.an.visemes.sMed);
    this.consonantProfile = p;
    this.an.visemes.learned = p;
    try { localStorage.setItem(CONSONANT_KEY, JSON.stringify(p)); } catch { /* ignore */ }
    return p.classes.length;
  }

  resetProfile() {
    this.profile = DEFAULT_PROFILE as VisemeProfile;
    this.consonantProfile = null;
    this.an.visemes.learned = null;
    this.visemeSamples = [];
    this.nvPersonal = null;
    this.neural.mix = this.effectiveMix();
    try { localStorage.removeItem(NV_PERSONAL_KEY); localStorage.removeItem(NV_PERSONAL_FAST_KEY); } catch { /* ignore */ }
    if (this.neuralSettings.on) this.fx?.setNeural(true, null);
    try { localStorage.removeItem(PROFILE_KEY); localStorage.removeItem(CONSONANT_KEY); } catch { /* ignore */ }
  }

  sample(dt: number): AudioMouth {
    if (!this.analyser || !this.ctx) return (this.last = silentMouth());
    this.analyser.getFloatTimeDomainData(this.time);
    // a just-wired analyser hands out all-zero buffers for its first frames: stepping the analysis on digital
    // silence drags its adaptive noise floor to −100 dB, and the room tone then reads as loud speech for seconds
    // (a browser that adds noise to audio reads, src/core/readbackProbe.ts: "real sound" must rise above that noise)
    const eps = silenceThreshold(readback.audio);
    let any = false;
    for (let i = 0; i < this.time.length; i += 8) if (Math.abs(this.time[i]) > eps) { any = true; break; }
    if (!any) return (this.last = silentMouth());
    this.analyser.getFloatFrequencyData(this.freq);
    this.an.profile = this.profile;
    this.an.gain = this.gain;
    const m = this.an.step(this.time, this.freq, this.ctx.sampleRate, dt);
    // held fricatives (fffff / vvvvv / sssss / shhhh) from the front-end's raw-signal detector
    this.fricative = fricativeOf(this.fx?.stat);
    if (this.fx && !this.recording && !this.visemeRec) mergeFricative(m, this.fricative);
    if (this.recording && this.an.dbg.cepValid) this.recording.frames.push(Array.from(this.an.cep));
    if (this.visemeRec) {
      const d = this.an.visemes.dbg;
      if (m.level > 0.04 || d.hiss > 0.5) this.visemeRec.xs.push([...this.an.visemes.lastVector]);
    }
    this.dbg = this.an.dbg;
    this.last = m;
    this.emitFrame(m);
    return m;
  }

  private emitFrame(m: AudioMouth) {
    const st = this.fx?.stat;
    const vad = st ? (st.p >= 0 ? st.p : Math.max(0, st.vad)) : m.voiced ? 1 : 0;
    this.voice.emit({
      t: performance.now(), vad, gate: st ? st.gate > 0 : m.level > 0.05, level: m.level,
      visemes: { ...(m.visemes ?? {}) }, filtered: !!this.fx, fricative: this.fricative,
      mouth: { open: m.open, wide: m.wide, pucker: m.pucker, funnel: m.funnel, fv: m.fv, sib: m.sib, closure: m.closure },
    });
  }
}


/** 48 kHz when the voice filter runs (RNNoise's native rate; the browser resamples the mic). */
function makeContext(fx: boolean): AudioContext {
  if (fx) { try { return new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); } catch { /* device can't: fall back */ } }
  return new AudioContext({ latencyHint: 'interactive' });
}

function loadNvPersonal(key = NV_PERSONAL_KEY): { ow: string; ob: string } | null {
  try { const s = localStorage.getItem(key); const p = s ? JSON.parse(s) : null; return p && typeof p.ow === 'string' && typeof p.ob === 'string' ? p : null; } catch { return null; }
}

function loadConsonantProfile(): LearnedVisemeProfile | null {
  try {
    const s = localStorage.getItem(CONSONANT_KEY);
    const p = s ? (JSON.parse(s) as LearnedVisemeProfile) : null;
    return p && p.v === 1 && Array.isArray(p.classes) ? p : null;
  } catch { return null; }
}

function loadProfile(): VisemeProfile {
  try {
    const s = localStorage.getItem(PROFILE_KEY);
    if (s) return JSON.parse(s) as VisemeProfile;
  } catch { /* ignore */ }
  return DEFAULT_PROFILE as VisemeProfile;
}
