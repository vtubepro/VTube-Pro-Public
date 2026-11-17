// OBS output page side of the fast window feed (server/screenFeed.ts): H.264 access units over ws /ws/screen →
// WebCodecs VideoDecoder (hardware when available, optimizeForLatency) → a THREE.VideoFrameTexture on the react screen.
// No jitter buffer, no RTP pacing: a frame is drawn as soon as it is decoded (measured ≈ 31 ms window → texture).
// Only connects while wanted (a room with a react screen in React mode, in-scene capture, no studio share).
import * as THREE from 'three';
import type { CaptureStatus, FeedConfig, FeedRxStats, FeedStatusMsg } from '../../shared/capture.ts';

/** How long a helper 'error' (or no connection at all) must last before the page calls the feed failed (a restart of
 *  ffmpeg, a window re-found, a helper restart are shorter): until then Auto keeps the screen in the room. */
export const FEED_ERROR_HOLD_MS = 4000;
export const FEED_DOWN_HOLD_MS = 10_000;
/** A decoder that failed (or got stuck) asks the helper for the picture again — the frames since its last key frame —
 *  instead of waiting for the next key frame; at most this often, and at most RESYNC_MAX times without a picture. */
export const RESYNC_MIN_MS = 500;
export const RESYNC_MAX = 6;
/** Frames went into the decoder this long ago and nothing came out: it is stuck (no error, no picture) — handled like a
 *  decoder error (a fresh decoder, in software if this one never showed a frame). */
export const DECODE_STALL_MS = 2000;
/** Frames keep coming but none can be used (this page fell behind and skips to the next key frame) for this long: ask
 *  the helper for the picture again (resync) instead of waiting — key frames are up to 10 s apart on a slow window
 *  (server/screenFeed.ts KEY_MAX_S); a busy one has its next key frame sooner (every 2 s) and needs no resync. */
export const KEY_WAIT_MS = 2500;
/** After a config (a joining page, a resync, a stalled socket that caught up) the helper sends the whole key-frame
 *  group at once: that many frames may queue in the decoder for this long without counting as "fell behind". */
export const BURST_MS = 1500;
export const BURST_QUEUE = 250;

/** Pure: is the fast window feed still worth waiting for ('wait': keep the React screen in the room — standby, the last
 *  frame, the picture) or a definite no ('failed': Auto may fall back to an EXACT OBS passthrough, else NO SIGNAL)? */
export function feedVerdict(s: { localError: boolean; connected: boolean; downForMs: number; state: CaptureStatus['state'] | null; errorForMs: number }): 'wait' | 'failed' {
  if (s.localError) return 'failed';                                   // this browser can't decode the feed
  if (!s.connected) return s.downForMs > FEED_DOWN_HOLD_MS ? 'failed' : 'wait';
  if (s.state === 'unavailable') return 'failed';                      // no ffmpeg / not Windows / feed switched off
  if (s.state === 'error') return s.errorForMs > FEED_ERROR_HOLD_MS ? 'failed' : 'wait';
  return 'wait';                                                       // connecting, idle (just joined), starting, running
}

/** Pure: the verdict with memory. Once 'failed', it stays failed until the helper says the feed is RUNNING again — not
 *  just 'starting': an ffmpeg that keeps crashing goes error (≈ 5 s, past FEED_ERROR_HOLD_MS) → starting → error … and
 *  without this the React screen flipped between the standby card and the OBS passthrough capture every ≈ 6 s. */
export function feedLatch(wasFailed: boolean, now: 'wait' | 'failed', s: { connected: boolean; state: CaptureStatus['state'] | null }): boolean {
  if (now === 'failed') return true;
  return wasFailed && !(s.connected && s.state === 'running');
}

/** Pure: should this OBS page fetch the fast window feed now? React mode, a React screen to draw it on (the big screen /
 *  the side screen, or a stage layout's capture rect), no window shared from the studio (that one wins), and the screen
 *  drawn in the room: Auto / In-scene, or OBS passthrough on a screen an OBS box can't line up with (angled without the
 *  corner-pin, out of the shot) — drawn in the room too, so it shows the window there instead of NO SIGNAL. */
export function feedWanted(s: { react: boolean; surface: boolean; shared: boolean; screenMode: string; passOk: boolean; fx?: boolean; obsAuto?: boolean }): boolean {
  const native = s.screenMode === 'passthrough' || nativePassFor({ screenMode: s.screenMode, fx: !!s.fx, obsAuto: !!s.obsAuto });
  return s.react && s.surface && !s.shared && (!native || !s.passOk);
}

/** Pure: does Auto use OBS's own capture under an EXACT hole (when passOk) instead of the in-room feed? Only with OBS
 *  automation placing the capture (else the hole would show whatever the performer left under it) and no screen
 *  extras (glass sheen / scanlines are drawn on the in-room screen; a hole can't show them). Why (2026-10): the in-room
 *  feed is a screen capture → CPU (BGRA readback, scale, x264 without a new-enough NVIDIA driver) → WebSocket → this
 *  browser source → a texture, and next to a GPU-heavy game it starved to a stutter on stream while the game ran
 *  smooth; OBS composites its own capture natively. */
export function nativePassFor(s: { screenMode: string; fx: boolean; obsAuto: boolean }): boolean {
  return s.screenMode === 'auto' && !s.fx && s.obsAuto;
}

export class ScreenFeedReceiver {
  static get supported() { return typeof window !== 'undefined' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window; }
  /** New texture / aspect (null = no feed: fall back to the studio share, NO SIGNAL or the passthrough hole). */
  onTexture: (tex: THREE.Texture | null, aspect: number | null) => void = () => {};
  private ws: WebSocket | null = null;
  private wanted = false;
  private dec: VideoDecoder | null = null;
  private codec = '';
  private configured = false;
  private needKey = true;
  private hw = false;
  private tex: THREE.VideoFrameTexture | null = null;
  private frame: VideoFrame | null = null;
  private aspect = 0;
  private sent = new Map<number, [number, number]>();          // chunk timestamp → [performance.now() at decode(), server time]
  private ts = 0;
  private n = 0; private decMs = 0; private ageMs = 0; private statAt = performance.now();
  private error = '';
  private clearTimer = 0;
  private retry = 0;
  private statTimer = 0;

  /** Connect while true; disconnect (the server stops capturing a minute later) when false. */
  setWanted(on: boolean) {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) { this.downSince = performance.now(); this.failed = false; this.connect(); }
    else { this.close(); this.drop(0); this.server = null; }
  }
  get isWanted() { return this.wanted; }

  // ---- what the helper says about the feed (ws text {type:'status'}) + how long it has been down / erroring
  private server: { state: CaptureStatus['state']; message: string } | null = null;
  private errorSince = 0;
  private downSince = 0;
  /** The helper's last word on the feed (null = not connected yet). */
  get serverStatus() { return this.server; }
  /** 'wait' = keep the React screen in the room (connecting / starting / running / a short error); 'failed' = a definite
   *  no (see feedVerdict), held until the feed runs again (feedLatch). Only meaningful while wanted: each new wish
   *  (entering React) starts from 'wait'. */
  verdict(now = performance.now()): 'wait' | 'failed' {
    const open = this.ws?.readyState === WebSocket.OPEN;
    const state = this.server?.state ?? null;
    const v = feedVerdict({ localError: !!this.error, connected: open, downForMs: open ? 0 : now - this.downSince, state, errorForMs: state === 'error' ? now - this.errorSince : 0 });
    this.failed = feedLatch(this.failed, v, { connected: open, state });
    return this.failed ? 'failed' : 'wait';
  }
  private failed = false;

  private connect() {
    if (!this.wanted || this.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/screen`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => { opened = true; this.badRun = 0; this.replayUntil = 0; };
    ws.onmessage = (e) => { if (typeof e.data === 'string') this.onText(e.data); else this.onChunk(e.data as ArrayBuffer); };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null; this.resetDecoder(); this.drop(3000);
      this.server = null;
      // the feed went down NOW only if this connection was up: a reconnect attempt that never opened (every 2 s while the
      // helper can't be reached) must not restart the clock, or "unreachable for 10 s → failed" could never be reached
      if (opened) this.downSince = performance.now();
      if (this.wanted) this.retry = window.setTimeout(() => this.connect(), 2000);
    };
    clearInterval(this.statTimer);
    this.statTimer = window.setInterval(() => this.report(), 1000);
  }

  private close() {
    clearTimeout(this.retry); clearInterval(this.statTimer);
    const ws = this.ws; this.ws = null;
    try { ws?.close(); } catch { /* */ }
    this.resetDecoder();
  }

  private onText(s: string) {
    let m: FeedConfig | FeedStatusMsg | { type: 'stop' };
    try { m = JSON.parse(s); } catch { return; }
    if (m.type === 'config') { this.replayUntil = 0; this.burstAt = performance.now(); if (m.codec !== this.codec) { this.codec = m.codec; this.resetDecoder(); } }
    else if (m.type === 'stop') { this.resetDecoder(); this.drop(3000); }                 // keep the last picture briefly
    else if (m.type === 'status' && typeof m.state === 'string') {
      if (m.state === 'error' && this.server?.state !== 'error') this.errorSince = performance.now();
      this.server = { state: m.state, message: typeof m.message === 'string' ? m.message.slice(0, 300) : '' };
    }
  }

  private resetDecoder() {
    try { if (this.dec && this.dec.state !== 'closed') this.dec.close(); } catch { /* */ }
    this.dec = null; this.configured = false; this.needKey = true; this.sent.clear(); this.pending = null; this.inSince = 0; this.keyWaitSince = 0;
    this.gen++;                                                         // (a configure() still awaiting is now stale)
  }

  private async configure() {
    if (this.configured || !this.codec) return false;
    this.configured = true;
    const gen = this.gen;
    const base: VideoDecoderConfig = { codec: this.codec, optimizeForLatency: true };
    let cfg: VideoDecoderConfig | null = null;
    try {
      // hardware first — unless a decoder here already failed without showing a frame: then software (an embedded
      // browser such as OBS's can offer a hardware H.264 decoder that errors on every frame or never outputs one)
      const order: VideoDecoderConfig[] = this.soft ? [{ ...base, hardwareAcceleration: 'prefer-software' }, base] : [{ ...base, hardwareAcceleration: 'prefer-hardware' }, base];
      for (const c of order) if ((await VideoDecoder.isConfigSupported(c)).supported) { cfg = c; break; }
    } catch { /* */ }
    // (reset meanwhile — a new codec, a stop, a failure: that path sets up its own decoder; making one here too leaked a
    // decoder per race, and hardware decoders are a limited resource)
    if (gen !== this.gen) return false;
    // can't decode: stay connected and say so (the server stops counting this page, the Scene tab explains it)
    if (!cfg) { this.error = `this browser can’t decode ${this.codec}`; this.report(); this.drop(0); return false; }
    this.hw = cfg.hardwareAcceleration === 'prefer-hardware';
    this.dec = new VideoDecoder({
      output: (f) => this.show(f),
      // (reported to the helper: a decoder that keeps failing shows up in the Scene tab's feed status, not just a
      // console line nobody sees on an OBS page)
      error: (e) => { console.warn('screen feed decoder', e); this.decoderFailed(String((e as Error)?.message ?? e) || 'decoder error'); },
    });
    this.dec.configure(cfg);
    this.configuredAt = performance.now();
    return true;
  }

  private onChunk(buf: ArrayBuffer) {
    this.rxN++;
    if (this.error) return;
    // (a resync was asked: the helper replays config + key frame + the rest, in order — a frame that raced ahead of it
    // would be decoded out of order; the replay's config lifts this, or 1 s does: an older version never replays)
    if (this.replayUntil && performance.now() < this.replayUntil) return;
    const key = (new Uint8Array(buf, 0, 1)[0] & 1) === 1;
    const t = new DataView(buf).getFloat64(1, true);
    if (this.pending) { this.pending.push([buf, key, t]); return; }
    // (frames that can't be used until a key frame comes: since when — report() asks for a resync after KEY_WAIT_MS)
    if (key) this.keyWaitSince = 0;
    else if ((!this.configured || this.needKey) && this.codec && !this.keyWaitSince) this.keyWaitSince = performance.now();
    if (!this.configured) {
      if (!key || !this.codec) return;
      const p: [ArrayBuffer, boolean, number][] = [[buf, key, t]];      // frames arriving while the decoder is set up
      this.pending = p;
      void this.configure().then((ok) => { if (!ok || this.pending !== p) return; this.pending = null; for (const x of p) this.decode(...x); });
      return;
    }
    this.decode(buf, key, t);
  }

  private decode(buf: ArrayBuffer, key: boolean, t: number) {
    const d = this.dec;
    if (!d || d.state !== 'configured') return;
    if (this.needKey && !key) return;
    // fell behind (hidden page, GPU busy): skip to the next key frame instead of queueing up latency
    // (a replayed burst — everything since the last key frame, after a config: joining, resync — is allowed through)
    if (!key && d.decodeQueueSize > (performance.now() - Math.max(this.configuredAt, this.burstAt) < BURST_MS ? BURST_QUEUE : 6)) { this.needKey = true; this.keyWaitSince ||= performance.now(); return; }
    this.needKey = false;
    this.ts += 16_667;
    this.sent.set(this.ts, [performance.now(), t]);
    if (this.sent.size > 240) this.sent.delete(this.sent.keys().next().value!);
    if (!this.inSince) this.inSince = performance.now();
    try { d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data: new Uint8Array(buf, 9) })); }
    catch (e) { console.warn('screen feed decode', e); this.decoderFailed(String((e as Error)?.message ?? e) || 'decode failed'); }
  }

  /** The decoder failed (its error callback, a decode() that threw, or stuck: watchdog in report()). Start over at once
   *  from the helper's last key frame (resync) instead of waiting for the next one — with a window that rarely changes
   *  that used to be MINUTES of no picture (the old frame-count GOP), every time; and a decoder that never showed a
   *  frame here is not tried again: software from now on. */
  private decoderFailed(why: string) {
    this.decErr = why.slice(0, 160); this.decErrors++;
    if (this.lastOut < this.configuredAt) this.soft = true;
    this.resetDecoder();
    this.badRun++;
    this.askResync();
  }
  private askResync() {
    const now = performance.now();
    if (this.badRun > RESYNC_MAX || now - this.resyncAt < RESYNC_MIN_MS || this.ws?.readyState !== WebSocket.OPEN) return;
    this.resyncAt = now;
    this.replayUntil = now + 1000;
    try { this.ws.send(JSON.stringify({ type: 'resync' })); } catch { /* */ }
  }
  /** Decode in software from now on (a decoder here failed before it showed anything). */
  private soft = false;
  private gen = 0;
  private inSince = 0;
  private lastOut = 0;
  private badRun = 0;
  /** (-Infinity, not 0: performance.now() counts from the page's load — a decoder failing in its first RESYNC_MIN_MS
   *  never asked, and waited for the next key frame: 2 s on a busy window, up to KEY_MAX_S on a slow one) */
  private resyncAt = -Infinity;
  private replayUntil = 0;
  /** When the helper last sent a config (a replayed burst follows). */
  private burstAt = 0;
  /** Since when frames arrive that can't be used until a key frame comes (0 = none). */
  private keyWaitSince = 0;

  private show(f: VideoFrame) {
    this.decErr = '';                                                   // decoding works (again)
    this.lastOut = performance.now(); this.inSince = 0; this.badRun = 0;
    const s = this.sent.get(f.timestamp);
    if (s) { this.sent.delete(f.timestamp); this.decMs += performance.now() - s[0]; this.ageMs += Date.now() - s[1]; this.n++; }
    clearTimeout(this.clearTimer);
    if (!this.tex) {
      this.tex = new THREE.VideoFrameTexture();
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.generateMipmaps = false;
      this.tex.minFilter = THREE.LinearFilter;
      this.tex.anisotropy = 8;                                          // readable at an angle (clamped to the GPU max)
    }
    const old = this.frame;
    this.frame = f;
    this.tex.setFrame(f);                                               // uploaded once, when a visible screen draws it
    old?.close();
    const a = f.displayHeight > 0 ? +(f.displayWidth / f.displayHeight).toFixed(4) : 0;
    if (a !== this.aspect || !this.announced) { this.aspect = a; this.announced = true; this.onTexture(this.tex, a || null); }
  }
  private announced = false;
  private configuredAt = 0;
  private pending: [ArrayBuffer, boolean, number][] | null = null;

  /** No feed: after `ms` (keeps the last picture over a restart) tell the scene to fall back. */
  private drop(ms: number) {
    clearTimeout(this.clearTimer);
    const go = () => {
      if (!this.announced) return;
      this.announced = false; this.aspect = 0;
      this.onTexture(null, null);
      this.frame?.close(); this.frame = null;
      this.tex?.dispose(); this.tex = null;
    };
    if (ms > 0) this.clearTimer = window.setTimeout(go, ms); else go();
  }

  private rxN = 0;
  private decErr = '';
  private decErrors = 0;
  private report() {
    const now = performance.now(), dt = Math.max(0.001, (now - this.statAt) / 1000);
    // stuck: frames went in DECODE_STALL_MS ago and no picture came out (no error either)
    if (this.dec && this.inSince && now - this.inSince > DECODE_STALL_MS) this.decoderFailed('the decoder is stuck (frames in, no picture out)');
    // frames arrive, none usable (waiting for a key frame): the picture again from the last key frame, now
    else if (this.keyWaitSince && now - this.keyWaitSince > KEY_WAIT_MS) { this.keyWaitSince = now; this.askResync(); }
    const st: FeedRxStats = { type: 'stats', fps: Math.round(this.n / dt), decodeMs: this.n ? +(this.decMs / this.n).toFixed(2) : 0, ageMs: this.n ? +(this.ageMs / this.n).toFixed(1) : 0, hw: this.hw, error: this.error || undefined,
      rx: Math.round(this.rxN / dt), ...(this.decErr ? { decErr: this.decErr, decErrors: this.decErrors } : {}) };
    this.n = 0; this.decMs = 0; this.ageMs = 0; this.rxN = 0; this.statAt = now;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(st));
  }

  dispose() { this.wanted = false; this.close(); this.drop(0); }
}
