// Live screen-video sources (shared/screenVideo.ts isLiveSrc): a live stream URL (HLS / direct), a camera on this PC by
// label (the OBS Virtual Camera), or the fast window feed. Attached to the screen video player's <video> element (or,
// for the window feed, a texture of its own). Always muted unless the player unmutes it; never asks for a microphone.
// Reconnects by itself: HLS network errors re-load, media errors recover, anything else re-opens after a back-off.
import * as THREE from 'three';
import { isHlsUrl, videoUrl } from '../../shared/screenVideo.ts';
import { ScreenFeedReceiver } from './screenFeed.ts';

export interface LiveHandle {
  stop(): void;
  /** Window feed only: its own texture (null until the first frame). */
  texture(): THREE.Texture | null;
  aspect(): number;
  status: string;
}

type HlsLike = { loadSource(u: string): void; attachMedia(v: HTMLMediaElement): void; startLoad(): void; recoverMediaError(): void; destroy(): void; on(ev: string, fn: (e: string, d: { fatal?: boolean; type?: string; details?: string }) => void): void };
type HlsCtor = { new (cfg?: Record<string, unknown>): HlsLike; isSupported(): boolean; Events: { ERROR: string; MANIFEST_PARSED: string } };

let hlsLoading: Promise<HlsCtor | null> | null = null;
/** hls.js (npm package `hls.js`) as a classic script served by the local server (GET /api/videos/hls.js), so the page
 *  still builds and runs when it isn't installed (then only browsers with native HLS play .m3u8). */
export function loadHls(): Promise<HlsCtor | null> {
  const w = window as unknown as { Hls?: HlsCtor };
  if (w.Hls) return Promise.resolve(w.Hls);
  return (hlsLoading ??= new Promise((res) => {
    const s = document.createElement('script');
    s.src = '/api/videos/hls.js';
    s.onload = () => res(w.Hls ?? null);
    s.onerror = () => { hlsLoading = null; res(null); };
    document.head.append(s);
  }));
}

/** The proxied URL of a CORS-blocked stream (the local server fetches it; HLS playlists are rewritten to stay proxied). */
export const proxied = (u: string) => `/api/videos/proxy?url=${encodeURIComponent(u)}`;

/** Pick a camera by (part of) its label: exact → starts with → contains (case-insensitive). */
export function pickCamera(devs: { kind: string; label: string; deviceId: string }[], label: string) {
  const cams = devs.filter((d) => d.kind === 'videoinput' && d.label);
  const l = label.toLowerCase();
  return cams.find((d) => d.label.toLowerCase() === l) ?? cams.find((d) => d.label.toLowerCase().startsWith(l)) ?? cams.find((d) => d.label.toLowerCase().includes(l)) ?? null;
}

export function openLive(v: HTMLVideoElement, src: string, media: Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia'> | undefined = navigator.mediaDevices): LiveHandle {
  let stopped = false, retry = 0, backoff = 2000, hls: HlsLike | null = null, stream: MediaStream | null = null, feed: ScreenFeedReceiver | null = null;
  let feedTex: THREE.Texture | null = null, feedAspect = 0, viaProxy = false;
  const h: LiveHandle = {
    status: 'connecting',
    stop() {
      stopped = true; window.clearTimeout(retry);
      hls?.destroy(); hls = null;
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      feed?.setWanted(false); feed = null;
      v.srcObject = null; v.removeAttribute('src'); v.load();
    },
    texture: () => feedTex,
    aspect: () => feedAspect,
  };
  const again = (why: string) => {
    if (stopped) return;
    h.status = `reconnecting (${why})`;
    hls?.destroy(); hls = null;
    window.clearTimeout(retry);
    retry = window.setTimeout(start, backoff);
    backoff = Math.min(30000, backoff * 1.6);
  };
  v.addEventListener('playing', () => { backoff = 2000; h.status = 'live'; });
  v.addEventListener('error', () => {
    // first failure of a direct URL: maybe CORS (the WebGL texture needs it) → try through the local proxy
    if (src.startsWith('live:') && !viaProxy && !hls) { viaProxy = true; again('trying the local proxy'); return; }
    again(v.error?.message || 'error');
  });
  let stallT = 0;
  v.addEventListener('waiting', () => { window.clearTimeout(stallT); stallT = window.setTimeout(() => { if (v.readyState < 3) again('stalled'); }, 12000); });

  async function start() {
    if (stopped) return;
    if (src === 'feed:window') {
      feed = new ScreenFeedReceiver();
      feed.onTexture = (t, a) => { feedTex = t; feedAspect = a ?? 0; h.status = t ? 'live' : 'waiting for the window feed'; };
      feed.setWanted(true);
      return;
    }
    if (src.startsWith('cam:')) {
      if (!media) { h.status = 'no camera access on this page'; return; }
      const devs = await media.enumerateDevices().catch(() => []);
      const d = pickCamera(devs, src.slice(4));
      if (!d) {
        h.status = devs.some((x) => x.kind === 'videoinput' && !x.label) ? 'camera names hidden (this page has no camera permission)'
          : `no camera called “${src.slice(4)}” on this PC (party guests can’t see the host’s cameras)`;
        again(h.status); return;
      }
      try {
        stream = await media.getUserMedia({ video: { deviceId: { exact: d.deviceId } }, audio: false });
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
        stream.getVideoTracks()[0]?.addEventListener('ended', () => again('camera stopped'));
        v.srcObject = stream;
        void v.play().catch(() => {});
      } catch (e) { again((e as Error).name || 'camera busy'); }
      return;
    }
    const url = videoUrl(src);
    const u = viaProxy ? proxied(url) : url;
    // HLS: hls.js first (Chromium's native HLS claims "maybe" but fails on plain MPEG-TS here), native only without it
    const Hls = isHlsUrl(url) ? await loadHls() : null;
    if (stopped) return;
    if (isHlsUrl(url) && !(Hls && Hls.isSupported()) && !v.canPlayType('application/vnd.apple.mpegurl')) { h.status = 'HLS needs hls.js (npm i hls.js) on this PC'; return; }
    if (isHlsUrl(url) && Hls && Hls.isSupported()) {
      hls = new Hls({ liveDurationInfinity: true, lowLatencyMode: false, backBufferLength: 10 });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d?.fatal) return;
        if (d.type === 'networkError') {
          // a CORS-blocked stream fails on the manifest: switch to the proxy once, else keep retrying the load
          if (!viaProxy && /manifest/i.test(d.details ?? '')) { viaProxy = true; again('trying the local proxy'); }
          else window.setTimeout(() => hls?.startLoad(), backoff);
        } else if (d.type === 'mediaError') hls?.recoverMediaError();
        else again(d.details ?? 'hls error');
      });
      hls.loadSource(u);
      hls.attachMedia(v);
      void v.play().catch(() => {});
      return;
    }
    v.src = u;
    void v.play().catch(() => {});
  }
  void start();
  return h;
}
