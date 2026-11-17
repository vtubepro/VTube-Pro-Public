// OBS page side of TV feeds: the streams this PC's studio sends over the loopback link (src/net/tv/tvLocal.ts) →
// a <video> + a THREE.Texture per feed that is re-uploaded ONLY when a new video frame arrives
// (requestVideoFrameCallback; a poll on the render tick covers hidden pages), plus each feed's health
// (connecting → live → stalled → lost) and voice level. RAM only: nothing here is recorded or stored.
import * as THREE from 'three';
import { TV_LOST_MS, TV_STALL_MS, type TvFeedState } from '../../../shared/tv.ts';
import { TvLocalReceiver } from '../../net/tv/tvLocal.ts';
import type { BusMessage } from '../../../shared/types.ts';

export class PageFeed {
  readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  stream: MediaStream | null = null;
  aspect = 4 / 3;
  /** Frame size in px (a packed Spout2 frame: both halves). */
  readonly size = { w: 0, h: 0 };
  /** Frames presented in the last second (health: the People tile / Multiplayer panel). */
  fps = 0;
  private fpsN = 0; private fpsAt = 0;
  lastFrameAt = 0;
  frames = 0;
  everLive = false;
  private rvfc = 0;
  private droppedAt = 0;

  constructor(readonly id: string) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    this.video = v;
    // VideoTexture: three.js re-uploads it only when the video presents a new frame (its own requestVideoFrameCallback)
    // and never allocates immutable storage for it (a plain Texture on a <video> uploads black on ANGLE / D3D11)
    const t = new THREE.VideoTexture(v);
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
    this.texture = t;
  }

  attach(stream: MediaStream | null) {
    if (stream === this.stream) return;
    this.stream = stream;
    // a new stream restarts the element's presented-frame counter: without this reset poll() (hidden pages) never saw
    // a new frame after a feed was replaced (a reconnect) and the TV stayed on NO SIGNAL
    this.presented = 0;
    this.video.srcObject = stream;
    if (stream) { void this.video.play().catch(() => {}); this.watch(); } else this.droppedAt = performance.now();
  }

  private watch() {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (id: number) => void };
    if (!v.requestVideoFrameCallback) return;
    if (this.rvfc) v.cancelVideoFrameCallback?.(this.rvfc);
    const cb = () => { this.gotFrame(); this.rvfc = v.requestVideoFrameCallback!(cb); };
    this.rvfc = v.requestVideoFrameCallback(cb);
  }
  private gotFrame() {
    const v = this.video;
    if (v.videoWidth < 2 || v.videoHeight < 2) return;
    this.presented = Math.max(this.presented, v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0);
    this.aspect = v.videoWidth / v.videoHeight;
    this.size.w = v.videoWidth; this.size.h = v.videoHeight;
    const now = performance.now();
    this.fpsN++;
    if (now - this.fpsAt >= 1000) { this.fps = this.fpsAt ? Math.round((this.fpsN * 1000) / (now - this.fpsAt)) : 0; this.fpsN = 0; this.fpsAt = now; }
    this.lastFrameAt = now;
    this.frames++;
    this.everLive = true;
  }
  /** Render tick: covers pages whose rVFC is paused (hidden). A live stream's currentTime runs on without frames, so
   *  new frames are counted with getVideoPlaybackQuality() (frames actually presented). */
  poll() {
    const v = this.video;
    if (v.readyState < 2 || performance.now() - this.lastFrameAt < 90) return;
    const n = v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    if (n > this.presented) { this.presented = n; this.gotFrame(); this.texture.needsUpdate = true; }
  }
  private presented = 0;

  get state(): TvFeedState {
    const now = performance.now();
    if (!this.stream) return this.everLive ? (now - this.droppedAt > 400 ? 'lost' : 'stalled') : 'none';
    if (!this.lastFrameAt) return 'connecting';
    const age = now - this.lastFrameAt;
    return age < TV_STALL_MS ? 'live' : age < TV_LOST_MS ? 'stalled' : 'lost';
  }
  /** The first frame arrived (the texture has an image to upload). */
  get ready(): boolean { return this.frames > 0; }

  dispose() {
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void };
    if (this.rvfc) v.cancelVideoFrameCallback?.(this.rvfc);
    this.video.srcObject = null;
    this.texture.dispose();
  }
}

/** Every TV feed this page can show (id = party member id). */
export class PageFeeds {
  private rx: TvLocalReceiver | null = null;
  readonly feeds = new Map<string, PageFeed>();
  readonly listeners = new Set<() => void>();

  /** Start receiving from this PC's studio (OBS pages + the Scene preview; test pages may inject streams instead). */
  start(send: (m: Extract<BusMessage, { type: 'tvfeed' }>) => void, listen: (h: (m: BusMessage) => void) => () => void) {
    if (this.rx) return;
    this.rx = new TvLocalReceiver(send, listen);
    this.rx.onChange = () => this.sync();
    window.addEventListener('pagehide', () => this.rx?.dispose());
  }
  private sync() {
    const rx = this.rx;
    if (!rx) return;
    for (const [id, s] of rx.streams) this.feed(id).attach(s.stream);
    for (const [id, f] of this.feeds) if (!rx.streams.has(id)) f.attach(null);
    for (const l of this.listeners) l();
  }
  /** Guest voices are never played on an OBS page (owner: guests only through the studio). Kept for diagnostics: always {}. */
  voices(): Record<string, number> { return {}; }
  /** Test pages: show a local stream as member `id`'s feed (fake camera / canvas). */
  inject(id: string, stream: MediaStream | null) { this.feed(id).attach(stream); for (const l of this.listeners) l(); }

  feed(id: string): PageFeed {
    let f = this.feeds.get(id);
    if (!f) { f = new PageFeed(id); this.feeds.set(id, f); }
    return f;
  }
  get(id: string): PageFeed | null { return this.feeds.get(id) ?? null; }
  level(id: string): number { return this.rx?.level(id) ?? this.testLevels.get(id) ?? 0; }
  /** Test pages: a voice level for a fake feed. */
  readonly testLevels = new Map<string, number>();
  /** Render tick. */
  poll() { for (const f of this.feeds.values()) if (f.stream) f.poll(); }
  forget(id: string) { const f = this.feeds.get(id); if (f) { f.dispose(); this.feeds.delete(id); } }
}

export const pageFeeds = new PageFeeds();
