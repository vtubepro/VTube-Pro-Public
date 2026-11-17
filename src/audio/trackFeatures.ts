// Studio side of the Track library's audio matching: the music input's band onsets (50 a second, a few hundred bytes a
// second) go to the helper, which finds which analysed track is playing and where (shared/audioAlign.ts) when no DJ
// gear reports a playhead (rekordbox performance mode + a DDJ, Traktor / Serato / Mixxx / djay).
// It taps the music input the lights already use (src/audio/beat/beatInput.ts BeatInput.tap): no new capture, nothing is
// played (the worklet has no output), nothing is recorded or stored. Studio tab only, only while DJ sync + "Find the
// track by listening" are on.
import { BeatInput, epochNow } from './beat/beatInput.ts';
import { FluxStream } from '../../shared/trackDsp.ts';
import { LM, PeakStream, type Peak } from '../../shared/landmarks.ts';

const WORKLET = `class VtpTrackTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; this.t0 = -1; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const len = ch[0].length;
    if (this.t0 < 0) this.t0 = currentFrame;
    for (let i = 0; i < len; i++) { let s = 0; for (let c = 0; c < ch.length; c++) s += ch[c][i]; this.buf[this.n++] = s / ch.length;
      if (this.n === this.buf.length) { this.port.postMessage({ f: this.t0, x: this.buf }, [this.buf.buffer]); this.buf = new Float32Array(2048); this.n = 0; this.t0 = currentFrame + i + 1; } }
    return true;
  }
}
registerProcessor('vtp-track-tap', VtpTrackTap);`;

export class TrackFeatures {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private flux: FluxStream | null = null;
  private peaks: PeakStream | null = null;
  private pq: Peak[] = [];
  private sid = '';
  private map: { f: number; at: number } | null = null;
  private ws: WebSocket | null = null;
  private q: { t: number; v: [number, number, number, number] }[] = [];
  private timer = 0;
  private want = false;
  private firstFrame = -1;
  /** Frames sent (the panel shows "listening"). */
  sent = 0;

  constructor() { BeatInput.tap = (ctx, node) => { void this.attach(ctx, node); }; }
  /** On / off (DJ sync on + matching on + analysed tracks in the library). */
  set(on: boolean) {
    if (on === this.want) return;
    this.want = on;
    if (!on) { this.detach(); this.ws?.close(); this.ws = null; clearInterval(this.timer); this.timer = 0; }
    else if (BeatInput.current) void this.attach(BeatInput.current.ctx, BeatInput.current.node);
  }
  private async attach(ctx: AudioContext | null, node: AudioNode | null) {
    this.detach();
    if (!this.want || !ctx || !node) return;
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const tap = new AudioWorkletNode(ctx, 'vtp-track-tap', { numberOfInputs: 1, numberOfOutputs: 0 });   // (no output: silent by construction)
      node.connect(tap);
      this.ctx = ctx; this.node = tap; this.flux = new FluxStream(ctx.sampleRate); this.firstFrame = -1;
      // the landmark peaks run on the same 22 050 Hz samples (the helper finds the track among the analysed ones)
      const ps = new PeakStream(); this.peaks = ps; this.pq = []; this.sid = Math.random().toString(36).slice(2, 10);
      this.flux.onResampled = (x) => { this.pq.push(...ps.push(x)); if (this.pq.length > 400) this.pq.splice(0, this.pq.length - 400); };
      tap.port.onmessage = (e) => this.onAudio(e.data as { f: number; x: Float32Array });
      if (!this.timer) this.timer = window.setInterval(() => this.flush(), 200);
    } catch { /* no worklet (an old browser): the realtime show runs as before */ }
  }
  private detach() {
    try { this.node?.disconnect(); if (this.node) this.node.port.onmessage = null; } catch { /* gone */ }
    this.node = null; this.ctx = null; this.flux = null; this.peaks = null; this.q = []; this.pq = [];
  }
  private onAudio(d: { f: number; x: Float32Array }) {
    const ctx = this.ctx, fs = this.flux;
    if (!ctx || !fs) return;
    if (this.firstFrame < 0) this.firstFrame = d.f;
    const frames = fs.push(d.x);
    // input-frame index → this page's clock: the newest rendered frame is "now"
    const nowFrame = ctx.currentTime * ctx.sampleRate, now = epochNow();
    for (const f of frames) this.q.push({ t: now - (nowFrame - (this.firstFrame + f.t)) / ctx.sampleRate * 1000, v: f.v });
    // the newest landmark frame's start time on this page's clock (peak frames are exact counts: only this maps them)
    if (this.peaks && this.peaks.frames > 0) { const pf = this.peaks.frames - 1; this.map = { f: pf, at: now - (nowFrame - (this.firstFrame + pf * LM.hop * ctx.sampleRate / LM.sr)) / ctx.sampleRate * 1000 }; }
    if (this.q.length > 500) this.q.splice(0, this.q.length - 500);
  }
  private flush() {
    if (!this.q.length) return;
    if (!this.ws || this.ws.readyState > 1) {
      try { this.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/music`); } catch { this.q = []; return; }
    }
    if (this.ws.readyState !== WebSocket.OPEN) { if (this.q.length > 250) this.q.splice(0, this.q.length - 250); return; }
    const q = this.q.splice(0, 200);
    const pk = this.pq.splice(0, 300);
    this.ws.send(JSON.stringify({ type: 'feat', at: q[q.length - 1].t, sent: epochNow(), f: q.map((x) => x.v[0]), l: q.map((x) => x.v[1]), mi: q.map((x) => x.v[2]), hi: q.map((x) => x.v[3]),
      ...(this.map ? { sid: this.sid, pf: this.map.f, pat: this.map.at, pk: pk.flatMap((p) => [p.f, Math.round(p.m * 100)]) } : {}) }));
    this.sent += q.length;
  }
}
