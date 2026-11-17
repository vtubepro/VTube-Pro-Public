// Studio-side music input for the beat-reactive lights. The OBS page can't capture audio, so the analysis runs
// HERE and only compact beat packets travel (shared/lightShow.ts BeatPacket):
//
//   audio input (a device — loopback / Stereo Mix / VB-Cable / Focusrite loopback —, tab / screen audio, or the
//   built-in test beat)  →  its OWN AudioContext + MediaStream (never the lip-sync mic pipeline)
//   →  AudioWorklet 'beat-feed' (beat-worklet.js, verbatim an earlier overlay feed: band RMS + superflux per 10.7 ms hop)
//   →  beatWorker.ts (BeatEngine v8 off the main thread)  →  packets  →  this PC's OBS pages (bus {type:'beat'}),
//      party guests (host only; they relay to their own OBS pages) and the Scene-tab preview.
//
// ?observer=1 studios never send (the bus is muted there and the party link is skipped) — only their own preview.
import { listMics, type CameraOption } from '../../tracking/camera.ts';
import type { BeatPacket } from '../../../shared/lightShow.ts';

export type BeatSourceKind = 'off' | 'device' | 'display' | 'test';
export interface BeatSource { kind: BeatSourceKind; deviceId?: string; label?: string }
export interface BeatMeter {
  on: boolean; bpm: number; locked: boolean; conf: number; grid: string; section: string;
  bands: number[]; kick: number; snare: number; hat: number; energy: number; beat: number;
  /** what the input sounds like: silence / music / talk (voice, no music: the lights stay calm) / mixed */
  mode?: 'silence' | 'music' | 'talk' | 'mixed'; music?: number; talk?: number; kp?: number; phraseBeat?: number;
  /** the music input is very quiet (beats found, sections / downbeats get unreliable): ask to turn it up */
  quiet?: boolean;
}

export interface BeatSink { send(b: BeatPacket): void }

const SRC_KEY = 'vtp.beat.source';
export const epochNow = () => performance.timeOrigin + performance.now();

export class BeatInput {
  source: BeatSource = { kind: 'off' };
  status = '';
  meter: BeatMeter | null = null;
  /** Newest kick (epoch ms) — the Scene tab's flash. */
  kickAt = 0;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private srcNode: AudioNode | null = null;
  private worker: Worker | null = null;
  private streamId = '';
  private listeners = new Set<() => void>();
  private seq = 0;
  private voiceProbe: (() => number) | null = null;
  private voiceTimer = 0;

  constructor(private sinks: BeatSink[]) {}
  /** Track library audio matching (src/audio/trackFeatures.ts) taps the same input: told when it starts / stops. */
  static tap: ((ctx: AudioContext | null, node: AudioNode | null) => void) | null = null;
  static current: { ctx: AudioContext; node: AudioNode } | null = null;

  /** The studio's lip-sync mic voice activity (0..1, or -1 when the mic is off): tells the analysis when the host is
   *  talking, so a loopback that also carries the voice doesn't fire the lights. Polled every 50 ms while active. */
  setVoiceProbe(fn: (() => number) | null) { this.voiceProbe = fn; }

  on(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  // (a copy: a listener may re-render the Scene tab, which subscribes again)
  private emit() { for (const l of [...this.listeners]) try { l(); } catch { /* ui gone */ } }

  /** Remembered choice (devices only — tab/screen capture always needs a fresh pick). */
  saved(): BeatSource | null {
    try { const s = JSON.parse(localStorage.getItem(SRC_KEY) || 'null') as BeatSource | null; return s && s.kind === 'device' ? s : null; } catch { return null; }
  }

  /** Audio inputs (same list the lip-sync mic picker shows; opening one here is a separate stream). */
  devices(): Promise<CameraOption[]> { return listMics().catch(() => []); }

  async start(src: BeatSource) {
    const my = ++this.seq;
    this.stop(false);
    this.source = src;
    if (src.kind === 'off') { localStorage.removeItem(SRC_KEY); this.status = ''; this.emit(); return; }
    this.status = 'starting…';
    this.emit();
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule(new URL('./beat-worklet.js', import.meta.url).href);
      if (my !== this.seq) { void ctx.close(); return; }
      let srcNode: AudioNode;
      if (src.kind === 'test') {
        const buf = testBeat(ctx.sampleRate, 128);
        const b = ctx.createBufferSource();
        b.buffer = buf; b.loop = true; b.start();
        srcNode = b;
      } else {
        const stream = src.kind === 'display' ? await displayAudio() : await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: src.deviceId ? { exact: src.deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } },
          video: false,
        });
        if (my !== this.seq) { stream.getTracks().forEach((t) => t.stop()); void ctx.close(); return; }
        this.stream = stream;
        stream.getAudioTracks()[0]?.addEventListener('ended', () => { if (this.stream === stream) void this.start({ kind: 'off' }); });
        srcNode = ctx.createMediaStreamSource(stream);
      }
      const node = new AudioWorkletNode(ctx, 'beat-feed', { numberOfInputs: 1, numberOfOutputs: 0 });
      srcNode.connect(node);
      this.srcNode = srcNode;
      BeatInput.current = { ctx, node: srcNode }; try { BeatInput.tap?.(ctx, srcNode); } catch { /* a tap's bug */ }
      this.node = node;
      this.streamId = Math.random().toString(36).slice(2, 10);
      const worker = new Worker(new URL('./beatWorker.ts', import.meta.url), { type: 'module', name: 'vtp-beat' });
      this.worker = worker;
      node.port.onmessage = (e) => {
        const d = e.data as { t0: number; hopSec: number; nBands: number; hops: number[] };
        worker.postMessage({ type: 'hops', t0: d.t0 * 1000, hopMs: d.hopSec * 1000, nBands: d.nBands, hops: d.hops, streamId: this.streamId, now: epochNow() });
      };
      worker.onmessage = (e) => {
        const m = e.data as { type: string; b?: BeatPacket } & BeatMeter;
        if (m.type === 'packet' && m.b) {
          if (m.b.ev & 1) this.kickAt = epochNow() - (m.b.ka ?? 0);
          for (const s of this.sinks) try { s.send(m.b); } catch { /* sink gone */ }
        } else if (m.type === 'meter') this.meter = m;
      };
      clearInterval(this.voiceTimer);
      this.voiceTimer = window.setInterval(() => { if (this.voiceProbe && this.worker) { let v = -1; try { v = this.voiceProbe(); } catch { /* app gone */ } this.worker.postMessage({ type: 'voice', v }); } }, 50);
      if (src.kind === 'device') localStorage.setItem(SRC_KEY, JSON.stringify(src));
      this.status = src.kind === 'test' ? 'test beat (128 BPM, not sent to the speakers)' : `listening: ${src.label ?? (src.kind === 'display' ? 'tab / screen audio' : 'device')}`;
    } catch (e) {
      this.stop(false);
      this.source = { kind: 'off' };
      this.status = `could not open the input: ${(e as Error).message || (e as Error).name}`;
    }
    this.emit();
  }

  private stop(emit = true) {
    try { this.node?.port && (this.node.port.onmessage = null); this.srcNode?.disconnect(); this.node?.disconnect(); } catch { /* gone */ }
    try { (this.srcNode as AudioBufferSourceNode | null)?.stop?.(); } catch { /* not a buffer */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    clearInterval(this.voiceTimer);
    this.worker?.terminate();
    if (BeatInput.current?.node === this.srcNode) { BeatInput.current = null; try { BeatInput.tap?.(null, null); } catch { /* a tap's bug */ } }
    this.ctx = null; this.stream = null; this.node = null; this.srcNode = null; this.worker = null; this.meter = null;
    if (emit) this.emit();
  }

  get active() { return this.source.kind !== 'off' && !!this.worker; }
}

/** Tab / screen audio (Chrome: tick "Share tab audio" / "Share system audio"). The video track is dropped. */
async function displayAudio(): Promise<MediaStream> {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: { width: 16, height: 16, frameRate: 1 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints });
  const a = s.getAudioTracks();
  s.getVideoTracks().forEach((t) => t.stop());
  if (!a.length) throw new Error('no audio was shared — tick "Share tab audio" / "Share system audio" in the picker');
  return new MediaStream(a);
}

/** Two bars of a synthesized four-on-the-floor loop (kick, clap on 2 & 4, off-beat hats, off-beat bass). */
export function testBeat(sr: number, bpm: number): AudioBuffer {
  const beats = 8, period = 60 / bpm, len = Math.round(sr * period * beats);
  const buf = new AudioBuffer({ length: len, numberOfChannels: 1, sampleRate: sr });
  const d = buf.getChannelData(0);
  let seed = 7, prev = 0;
  for (let i = 0; i < len; i++) {
    const t = i / sr, index = Math.floor(t / period), age = t - index * period;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1, hp = (noise - prev) * 0.5; prev = noise;
    const kick = 0.7 * Math.exp(-age * 28) * Math.sin(2 * Math.PI * (48 * age + 3 * (1 - Math.exp(-age * 35))));
    const clap = index % 2 ? (noise * 0.22 + Math.sin(2 * Math.PI * 190 * age) * 0.18) * Math.exp(-age * 35) : 0;
    const hat = hp * 0.1 * Math.exp(-(t % (period / 2)) * 150);
    const ba = (t + period * 0.5) % period;
    const bass = 0.15 * Math.sin(2 * Math.PI * 85 * t) * (1 - Math.exp(-ba * 80)) * Math.exp(-ba * 8);
    d[i] = kick + clap + hat + bass;
  }
  return buf;
}

let instance: BeatInput | null = null;
/** the studio page's beat input if something already made it (the Lights panel), else null - never creates one */
export const currentBeatInput = (): BeatInput | null => instance;
/** One per studio page (survives Scene-tab re-renders). */
export function beatInput(make: () => BeatSink[]): BeatInput {
  return (instance ??= new BeatInput(make()));
}
