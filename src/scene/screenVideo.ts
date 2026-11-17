// Screen video player (docs/SCENES.md → "Screen video"): ONE <video> per page, decoded once and drawn on the room's
// screen as one VideoTexture that is re-uploaded only when the decoder produced a new frame (frame count, like the
// in-scene capture — requestVideoFrameCallback doesn't fire in hidden OBS sources). Position follows the host's clock
// (state.video.now.at): seek when > 0.6 s off, else a gentle playback-rate nudge. Page-lifetime singleton, so a room
// change keeps the video playing. Always muted here: its sound plays in the studio (src/audio/mixer/showSounds.ts).
import * as THREE from 'three';
import { isLiveSrc, videoUrl, type SceneVideoState } from '../../shared/screenVideo.ts';
import { openLive, type LiveHandle } from './liveSource.ts';
import { liveLag } from '../../shared/showSound.ts';
import { relayLiveClock } from '../audio/showSoundRelay.ts';

/** The video on the room's screen is always muted here: its sound plays in the STUDIO, in step with the same clock
 *  (src/audio/mixer/showSounds.ts; owner: every sound only in the studio — output pages are silent). */
const AUDIO_OK = false;

export type VideoPlayerStatus = 'idle' | 'loading' | 'playing' | 'waiting' | 'error';

class ScreenVideoPlayer {
  private video: HTMLVideoElement | null = null;
  private tex: THREE.VideoTexture | null = null;
  private black: THREE.DataTexture | null = null;
  private url = '';
  private frame = -1;
  private lastSync = 0;
  private hasFrame = false;
  status: VideoPlayerStatus = 'idle';
  error = '';
  /** The screen video should be on a screen right now (set by the runtime each frame). */
  active = false;

  /** What the screen shows: the video (once it has a frame), else black. */
  get texture(): THREE.Texture {
    const ft = this.live?.texture();
    if (ft) return ft;
    if (this.tex && this.hasFrame) return this.tex;
    if (!this.black) { this.black = new THREE.DataTexture(new Uint8Array([6, 7, 10, 255]), 1, 1); this.black.needsUpdate = true; }
    return this.black;
  }
  get aspect(): number {
    if (this.live?.texture()) return +this.live.aspect().toFixed(4);
    const v = this.video;
    return v && v.videoWidth > 0 && this.hasFrame ? +(v.videoWidth / v.videoHeight).toFixed(4) : 0;
  }
  get element() { return this.video; }

  /** Once per frame. show = a screen is (going) down for the video on this page. */
  sync(st: SceneVideoState | undefined, show: boolean, anisotropy: number) {
    this.active = show;
    const now = st?.now;
    if (!show || !st || !now || now.paused || now.end) { this.idle(); return; }
    if (isLiveSrc(now.src)) { this.syncLive(st, now.src, anisotropy); return; }
    const url = videoUrl(now.src);
    if (url !== this.url || this.live) this.load(url, anisotropy);
    const v = this.video!;
    // audio (muted by default; autoplay with sound can be refused outside OBS → muted retry below)
    const wantMuted = !(st.audio && AUDIO_OK);
    if (v.muted !== wantMuted) v.muted = wantMuted;
    if (Math.abs(v.volume - st.volume) > 0.005) v.volume = st.volume;
    this.pump();
    const t = performance.now();
    if (t - this.lastSync < 250 || v.readyState < 1) return;
    this.lastSync = t;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : now.dur ?? 0;
    let pos = (Date.now() - now.at) / 1000;
    const single = (st.slots[now.slot]?.list.length ?? 1) <= 1 && (st.slots[now.slot]?.loop ?? true);
    v.loop = single;
    if (pos < 0) { if (!v.paused) v.pause(); if (v.currentTime > 0.05 && !v.seeking) v.currentTime = 0; this.status = 'waiting'; return; }
    if (dur > 0) pos = single ? pos % dur : Math.min(pos, Math.max(0, dur - 0.05));
    let drift = v.currentTime - pos;
    if (single && dur > 0) { if (drift > dur / 2) drift -= dur; else if (drift < -dur / 2) drift += dur; }   // across the loop seam
    if (!v.seeking) {
      if (Math.abs(drift) > 0.6) { v.currentTime = pos; v.playbackRate = 1; }
      else v.playbackRate = Math.abs(drift) > 0.06 ? 1 - Math.max(-0.06, Math.min(0.06, drift * 0.5)) : 1;
    }
    if (v.paused && !(dur > 0 && !single && pos >= dur - 0.06)) {
      v.play().then(() => { this.status = 'playing'; }).catch((e: Error) => {
        if (e?.name === 'NotAllowedError' && !v.muted) { v.muted = true; void v.play().catch(() => {}); }   // (no autoplay with sound here)
      });
    }
  }

  /** A live source (stream URL / camera / window feed): no clock to follow — play the live edge, keep it playing. */
  private live: LiveHandle | null = null;
  private clockAt = 0;
  private syncLive(st: SceneVideoState, src: string, anisotropy: number) {
    if (this.url !== src || !this.live) {
      this.load('', anisotropy);
      this.url = src;
      this.live = openLive(this.video!, src);
    }
    const v = this.video!;
    const wantMuted = !(st.audio && AUDIO_OK);
    if (v.muted !== wantMuted) v.muted = wantMuted;
    if (Math.abs(v.volume - st.volume) > 0.005) v.volume = st.volume;
    v.loop = false;
    if (v.playbackRate !== 1) v.playbackRate = 1;
    this.status = this.live.status === 'live' ? 'playing' : this.live.status.startsWith('reconnecting') || this.live.status === 'connecting' ? 'loading' : this.live.status.startsWith('waiting') ? 'waiting' : 'error';
    this.error = this.status === 'error' ? this.live.status : '';
    this.pump();
    const t = performance.now();
    // (the studio plays this stream's sound: tell it how far behind the live edge this picture is, twice a second)
    if (t - this.clockAt >= 500) { this.clockAt = t; const lag = liveLag(v); if (lag !== null && !v.paused) relayLiveClock(src, lag); }
    if (t - this.lastSync < 1000) return;
    this.lastSync = t;
    if (v.paused && (v.srcObject || v.currentSrc)) void v.play().catch((e: Error) => { if (e?.name === 'NotAllowedError' && !v.muted) { v.muted = true; void v.play().catch(() => {}); } });
  }

  /** New decoded frame → re-upload (only then). */
  private pump() {
    const v = this.video, tx = this.tex;
    if (!v || !tx || v.readyState < 2) return;
    const n = v.getVideoPlaybackQuality?.().totalVideoFrames ?? -1;
    const k = n > 0 ? n : v.currentTime;
    if (k !== this.frame) { this.frame = k; tx.needsUpdate = true; this.hasFrame = true; }
  }

  private load(url: string, anisotropy: number) {
    this.drop();
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.addEventListener('error', () => { this.status = 'error'; this.error = v.error?.message || `can't play ${url}`; });
    v.addEventListener('loadeddata', () => { if (this.status !== 'playing') this.status = 'waiting'; });
    v.addEventListener('seeked', () => { this.frame = -1; });   // a seek while paused: new picture, same decode count
    if (url) v.src = url;
    this.video = v; this.url = url; this.status = 'loading'; this.error = ''; this.hasFrame = false; this.frame = -1; this.lastSync = 0;
    const t = new THREE.VideoTexture(v);
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    this.tex = t;
  }

  /** Not wanted on a screen: pause (no decoding); keep the element so resuming is instant. */
  private idle() {
    if (this.live) { this.drop(); this.status = 'idle'; return; }        // live: disconnect (camera / stream / feed off)
    if (this.video && !this.video.paused) this.video.pause();
    if (this.status === 'playing' || this.status === 'waiting') this.status = 'idle';
  }

  private drop() {
    this.live?.stop(); this.live = null;
    if (this.video) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); }
    this.tex?.dispose();
    this.video = null; this.tex = null; this.url = ''; this.hasFrame = false;
  }

  /** Debug / tests (vtpOut.screenVideo). */
  info() {
    const v = this.video;
    return { live: this.live?.status ?? null, active: this.active, status: this.status, error: this.error, url: this.url, t: v ? +v.currentTime.toFixed(2) : null, dur: v ? v.duration : null,
      rate: v?.playbackRate ?? null, muted: v?.muted ?? null, volume: v?.volume ?? null, paused: v?.paused ?? null, frames: v?.getVideoPlaybackQuality?.().totalVideoFrames ?? null, audioOk: AUDIO_OK };
  }
}

export const screenVideo = new ScreenVideoPlayer();
