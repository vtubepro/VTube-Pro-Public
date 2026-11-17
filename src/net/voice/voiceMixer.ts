// The host's mix-minus (party voice, shared/partyVoice.ts): ONE AudioContext, one source node per voice (the host's
// talk-back / backstage mic + every guest voice that arrives) and one MediaStreamAudioDestinationNode per listener,
// fed by exactly the sources mixPlan() gives that listener (never their own). The destination's track is what goes
// back to that guest (its vox link sender, or a link guest's TV 'up' link sender).
//
// Why mix here instead of forwarding tracks: a browser can't forward RTP untouched — every forwarded track is decoded
// and RE-ENCODED per receiver anyway. Forwarding = N × (N−1) Opus encodes + each guest receives N−1 streams;
// mixing = N encodes (one per listener) + one stream per guest. For 6 guests that's 6 encodes instead of 30, and each
// guest downloads ≈ 32 kbit/s instead of ≈ 190. CPU: WebAudio summing of ≤ 7 mono inputs into ≤ 7 outputs is a few
// hundred multiply-adds per sample block (< 1 % of a core); the Opus encodes (≈ 0.3–0.5 % of a core each) dominate.
// Latency: guest → host → guest adds the host's jitter buffer (~20–60 ms) + one WebAudio render quantum (~3–10 ms,
// latencyHint 'interactive') + one encode (~20 ms frame) over a direct guest → guest path — ≈ 50–90 ms extra, like
// any SFU-less conference bridge. The host itself hears guests with no extra delay (the mix is only for returns).
//
// Nothing here is ever connected to ctx.destination: the mixer never makes a sound on the host's PC.
// Chromium only feeds a REMOTE WebRTC track into WebAudio while the track also plays in a media element, so every
// remote input gets a muted, detached <audio> sink (silent by construction).

const LIMIT = { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.12 };

interface Input { track: MediaStreamTrack; node: MediaStreamAudioSourceNode; sink: HTMLAudioElement | null }
interface Output { sum: GainNode; lim: DynamicsCompressorNode; dest: MediaStreamAudioDestinationNode; srcs: Set<string>; an: AnalyserNode; buf: Float32Array<ArrayBuffer> }

export class VoiceMixer {
  private ctx: AudioContext | null = null;
  private inputs = new Map<string, Input>();
  private outputs = new Map<string, Output>();
  private wake = () => { if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {}); };
  // (a context created with no fresh click can start suspended: retry whenever the page is allowed to start audio —
  // any earlier click / key in this page (sticky activation) — so guests never sit on a silent mix)
  private retryT = 0;
  private retry() {
    clearInterval(this.retryT);
    this.retryT = window.setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'suspended') { if (!this.ctx || this.ctx.state === 'closed') clearInterval(this.retryT); return; }
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (!ua || ua.hasBeenActive) void this.ctx.resume().catch(() => {});
    }, 1500);
  }
  /** For diagnostics / tests. */
  error = '';

  private context(): AudioContext {
    if (!this.ctx) {
      // 48 kHz = Opus's own rate (no resampling on the way in or out: the owner's output device runs at 96 kHz), and
      // no output device at all where the browser allows it (Chromium ≥ 110 'none' sink: a silent clock) — the mixer only
      // ever feeds MediaStreamDestinations.
      const o = { latencyHint: 'interactive', sampleRate: 48_000 } as AudioContextOptions;
      try { this.ctx = new AudioContext({ ...o, sinkId: { type: 'none' } } as AudioContextOptions); }
      catch { try { this.ctx = new AudioContext(o); } catch { this.ctx = new AudioContext({ latencyHint: 'interactive' }); } }
      // (a studio with no click since it loaded may start the context suspended = silent mixes: wake it on the next one)
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, this.wake, { capture: true, passive: true });
      this.wake();
      this.retry();
    }
    return this.ctx;
  }
  get state(): AudioContextState | 'none' { return this.ctx?.state ?? 'none'; }

  /** The voices that exist right now (source id → track; `remote` = arrived over WebRTC). Removed ones disconnect. */
  setInputs(want: Map<string, { track: MediaStreamTrack; remote: boolean }>) {
    for (const [id, i] of this.inputs) {
      const w = want.get(id);
      if (w && w.track === i.track && w.track.readyState === 'live') continue;
      this.dropInput(id);
    }
    for (const [id, w] of want) {
      if (this.inputs.has(id) || w.track.readyState !== 'live') continue;
      try {
        const ctx = this.context();
        const stream = new MediaStream([w.track]);
        let sink: HTMLAudioElement | null = null;
        if (w.remote) { sink = new Audio(); sink.muted = true; sink.volume = 0; sink.srcObject = stream; void sink.play().catch(() => {}); }
        const node = ctx.createMediaStreamSource(stream);
        this.inputs.set(id, { track: w.track, node, sink });
      } catch (e) { this.error = (e as Error).message; }
    }
    // re-wire outputs whose sources changed identity
    for (const o of this.outputs.values()) { const s = [...o.srcs]; o.srcs.clear(); this.wire(o, s); }
  }
  private dropInput(id: string) {
    const i = this.inputs.get(id);
    if (!i) return;
    this.inputs.delete(id);
    try { i.node.disconnect(); } catch { /* */ }
    if (i.sink) { i.sink.pause(); i.sink.srcObject = null; }
    for (const o of this.outputs.values()) o.srcs.delete(id);
  }

  /** The mixed track for `listener` (created on first use): exactly `srcs` (missing inputs are skipped until they exist). */
  output(listener: string, srcs: string[]): MediaStreamTrack | null {
    let o = this.outputs.get(listener);
    try {
      if (!o) {
        const ctx = this.context();
        const sum = ctx.createGain(), lim = ctx.createDynamicsCompressor(), dest = ctx.createMediaStreamDestination();
        lim.threshold.value = LIMIT.threshold; lim.knee.value = LIMIT.knee; lim.ratio.value = LIMIT.ratio; lim.attack.value = LIMIT.attack; lim.release.value = LIMIT.release;
        sum.connect(lim).connect(dest);
        // (diagnostics: what this listener is being sent — an analyser, NOT the speakers)
        const an = ctx.createAnalyser(); an.fftSize = 512; lim.connect(an);
        o = { sum, lim, dest, srcs: new Set(), an, buf: new Float32Array(512) };
        this.outputs.set(listener, o);
      }
      this.wire(o, srcs);
      return o.dest.stream.getAudioTracks()[0] ?? null;
    } catch (e) { this.error = (e as Error).message; return null; }
  }
  private wire(o: Output, srcs: string[]) {
    const want = new Set(srcs.filter((s) => this.inputs.has(s)));
    for (const s of o.srcs) if (!want.has(s)) { try { this.inputs.get(s)?.node.disconnect(o.sum); } catch { /* */ } o.srcs.delete(s); }
    for (const s of want) if (!o.srcs.has(s)) { this.inputs.get(s)!.node.connect(o.sum); o.srcs.add(s); }
  }
  /** Listeners that no longer need a mix. */
  keep(listeners: Set<string>) {
    for (const [id, o] of this.outputs) {
      if (listeners.has(id)) continue;
      for (const s of o.srcs) { try { this.inputs.get(s)?.node.disconnect(o.sum); } catch { /* */ } }
      try { o.sum.disconnect(); o.lim.disconnect(); } catch { /* */ }
      o.dest.stream.getTracks().forEach((t) => t.stop());
      this.outputs.delete(id);
    }
    // no mixes left: close the context (frees the audio thread)
    if (!this.outputs.size && this.ctx) this.close();
  }
  /** Peak level 0..1 of each listener's outgoing mix right now (diagnostics: proves the mix isn't silence). */
  levels(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, o] of this.outputs) { o.an.getFloatTimeDomainData(o.buf); let pk = 0; for (const x of o.buf) pk = Math.max(pk, Math.abs(x)); out[k] = Math.min(1, pk); }
    return out;
  }
  /** Try to start a suspended mixer now (works from a click in this page). */
  resume() { this.wake(); }
  /** What each listener's mix contains (tests / diagnostics). */
  routes(): Record<string, string[]> { return Object.fromEntries([...this.outputs].map(([k, o]) => [k, [...o.srcs].sort()])); }
  close() {
    for (const id of [...this.inputs.keys()]) this.dropInput(id);
    for (const o of this.outputs.values()) o.dest.stream.getTracks().forEach((t) => t.stop());
    this.outputs.clear();
    for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, this.wake, { capture: true });
    clearInterval(this.retryT);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
